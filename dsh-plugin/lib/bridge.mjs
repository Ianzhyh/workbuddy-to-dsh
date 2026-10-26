/**
 * 桥的生命周期与 HTTP 客户端 —— 插件宿主端的底座。
 *
 * 设计约束（与项目 README 的「保留独立桥进程」一致）：
 *   1. 桥仍是**独立进程**，插件只负责「复用已在跑的 / 没跑就拉起 / 需要时停掉」。
 *   2. 因此控制台、`bridge\start-bridge.cmd`、其它 OpenAI 客户端都不受影响：
 *      它们看到的是同一个 127.0.0.1:8790。
 *   3. 桥的 stdout/stderr 重定向到 `bridge/bridge.log`，与控制台的日志面板同源。
 *
 * 本模块不 import 任何 dsh API，可被单元测试独立驱动。
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, openSync, closeSync, readSync, readFileSync, renameSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** 默认的桥脚本相对项目根的位置。 */
export const BRIDGE_SCRIPT_REL = join('bridge', 'workbuddy-bridge.mjs');

/**
 * 桥源码的内容指纹（与桥 `/health.build` 同一算法）。
 *
 * 升级只换磁盘脚本，不会杀已经在跑的后台桥进程。没有这道比对，用户升级后
 * 会继续被**旧代码**服务：目录/思考档位/换号跟随全是旧的，而版本号看起来
 * 已经是最新（issue #5 的六档位、issue #6 的换号失效都是这个形态）。
 */
export function bridgeBuildHash(path) {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 16);
  } catch {
    return '';
  }
}

/**
 * 桥日志滚动上限（与控制台同一口径，见 dashboard/server.mjs）。
 *
 * 文档承诺「每次启动桥时检查，超过 2MB 滚动为 bridge.log.1」；但插件拉起桥的
 * 路径原先只 append、从不滚动 —— dsh 用户长期跑下来日志会无限增长。
 *
 * 导出是为了能用临时文件直接测，不必真的起一个桥进程。
 */
export const BRIDGE_LOG_MAX_BYTES = 2 * 1024 * 1024;

export function rotateLogIfNeeded(file, maxBytes = BRIDGE_LOG_MAX_BYTES) {
  try {
    if (existsSync(file) && statSync(file).size > maxBytes) {
      renameSync(file, `${file}.1`);
    }
  } catch {
    /* 滚动失败（文件被占用等）不影响启动 */
  }
}
/** 默认的桥日志相对项目根的位置（与控制台共用）。 */
export const BRIDGE_LOG_REL = join('bridge', 'bridge.log');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 拼鉴权头。桥侧 LOCAL_TOKEN 为空时不发头（等价于关闭本地令牌）。 */
export function authHeaders(token) {
  return token ? { authorization: `Bearer ${token}` } : {};
}

/**
 * 一个桥进程的 HTTP 客户端。
 *
 * 所有方法都显式接收 `signal`，并保证超时——控制台曾经的坑是「/health 等上游
 * 导致 4 秒探测超时被误判为桥未运行」，这里的默认超时同样取短值。
 */
export class BridgeClient {
  /**
   * @param {{ baseUrl: string, token?: string, timeoutMs?: number }} options
   */
  constructor({ baseUrl, token = '', timeoutMs = 8000 }) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.token = token;
    this.timeoutMs = timeoutMs;
  }

  get url() {
    return this.baseUrl;
  }

  async #fetch(pathname, { method = 'GET', body, signal, timeoutMs } = {}) {
    const ac = new AbortController();
    // 显式传 0 表示「不设超时」（chat 的流式响应不能有整体超时），
    // 注意不能用 `??`：0 是合法值，会被 ?? 保留下来变成「立刻超时」。
    const budget = timeoutMs ?? this.timeoutMs;
    /*
     * ⚠️ 超时与调用方取消**必须活到响应体读完为止**，不能在拿到响应头时就摘掉。
     *
     * `fetch()` 一旦 resolve，AbortSignal 依然控制着**响应体流**的读取 —— 取消
     * 一个正在流式返回的请求，靠的正是这个 signal。原先 `finally` 在 fetch 解决
     * 的瞬间就 `removeEventListener` 并清掉定时器，于是：
     *
     *   - 调用方 abort（dsh 里点「停止」/ 上层取消）**再也传不进那个流**；
     *   - 本机继续把上游整段回答读完，只为了把结果丢掉 —— 白烧额度与并发。
     *
     * 实测（假上游 100 帧 × 60ms，400ms 处 abort）：
     *   现状        → read 循环 5 秒仍未结束，abort 后上游又写了 93 帧，且跑完了整条流
     *   保留监听    → read 2ms 结束，上游残余 0 帧，socket 5ms 内关闭
     *
     * 真实链路实测（真实桥 + 真实上游，1.5s 处 abort）：abort 后生成器**又跑了
     * 9477ms**、期间仍收到 4447 字，最后以 `max-tokens` 收尾（把「用户取消」
     * 报成了「输出超限」）。
     *
     * 所以清理动作挂到**响应体结束**（正常读完 / 被取消 / 出错）上，而不是挂在
     * 「拿到响应头」上。用一个把 `pull`/`cancel` 都接住的 `ReadableStream` 包一层，
     * 三种出口都能清理，且背压语义不变。
     */
    const cleanup = [];
    const runCleanup = () => { while (cleanup.length) { try { cleanup.pop()(); } catch { /* 忽略 */ } } };
    const onAbort = () => ac.abort(signal?.reason);
    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
      cleanup.push(() => signal.removeEventListener('abort', onAbort));
      // 进来时就已经取消：让 fetch 走正常的 abort 失败路径，不静默改成别的语义
      if (signal.aborted) ac.abort(signal.reason);
    }
    if (budget > 0) {
      const timer = setTimeout(() => ac.abort(new Error('timeout')), budget);
      cleanup.push(() => clearTimeout(timer));
    }

    let res;
    try {
      res = await fetch(`${this.baseUrl}${pathname}`, {
        method,
        headers: {
          ...authHeaders(this.token),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ac.signal,
      });
    } catch (error) {
      runCleanup(); // 连响应头都没拿到：立刻释放监听与定时器
      throw error;
    }

    // 204/205/304 按规范必须无体，`new Response(stream)` 会直接抛；无体响应没有
    // 「读完」这个时机，当场清理即可。
    if (!res.body || res.status === 204 || res.status === 205 || res.status === 304) {
      runCleanup();
      return res;
    }

    /*
     * 重新包一个 Response，让 `.body` / `.text()` / `.json()` 全部走被追踪的流。
     * 只改 `res.body` 不行：`.text()` 读的是 Response 内部的原始流，包装会失效。
     *
     * 三种出口都要清理，缺一个就会漏掉监听或定时器：
     *   ① 读完（done）—— 正常路径；
     *   ② 读出错 —— 上游被掐断 / 调用方 abort / 超时；
     *   ③ cancel —— 消费方主动放弃（例如 adapter 提前退出循环后 reader.cancel()）。
     * 只用 `pipeThrough(new TransformStream({flush,cancel}))` 会漏掉 ②：
     * 源流 error 时 flush 不触发，abort 监听与超时定时器就留在那里了。
     */
    const reader = res.body.getReader();
    try {
      const tracked = new ReadableStream({
        async pull(controller) {
          try {
            const { done, value } = await reader.read();
            if (done) { runCleanup(); controller.close(); return; }
            controller.enqueue(value);
          } catch (error) {
            runCleanup();
            controller.error(error);
          }
        },
        cancel(reason) {
          runCleanup();
          return reader.cancel(reason).catch(() => {});
        },
      });
      return new Response(tracked, {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
      });
    } catch (error) {
      // 构造 Response 失败（响应状态不合规范等）：源流与监听一并收掉，别泄漏
      runCleanup();
      await reader.cancel(error).catch(() => {});
      throw error;
    }
  }

  async #json(pathname, options) {
    const res = await this.#fetch(pathname, options);
    const text = await res.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = undefined; }
    if (!res.ok) {
      const message = parsed?.error?.message || parsed?.msg || parsed?.message || text || `HTTP ${res.status}`;
      const error = new Error(String(message).slice(0, 400));
      error.status = res.status;
      error.payload = parsed;
      // 429 的 Retry-After 在头里，不解析出来工具只能干说“稍后”。
      const retryAfter = Number(res.headers.get('retry-after'));
      if (Number.isFinite(retryAfter) && retryAfter > 0) error.retryAfter = retryAfter;
      throw error;
    }
    return parsed;
  }

  /** `GET /health`。桥未运行时抛错（调用方用 {@link probe} 判活在）。 */
  health(signal) {
    return this.#json('/health', { signal, timeoutMs: 4000 });
  }

  /** `GET /v1/identity`：极轻的「现在是谁」，用于账号切换即时刷新（不抓目录）。 */
  accountIdentity(signal) {
    return this.#json('/v1/identity', { signal, timeoutMs: 4000 });
  }

  /** `GET /`：仅用于确认端口上跑的确实是 workbuddy-bridge。 */
  identity(signal) {
    return this.#json('/', { signal, timeoutMs: 4000 });
  }

  /**
   * `GET /v1/models`。
   * @param {{ all?: boolean, refresh?: boolean, signal?: AbortSignal }} [options]
   */
  models({ all = true, refresh = false, signal } = {}) {
    const qs = new URLSearchParams();
    if (all) qs.set('all', '1');
    if (refresh) qs.set('refresh', '1');
    const suffix = qs.toString() ? `?${qs}` : '';
    return this.#json(`/v1/models${suffix}`, { signal, timeoutMs: refresh ? 60000 : 15000 });
  }

  usage({ days = 7, hours = false, signal } = {}) {
    return this.#json(`/v1/usage?days=${days}${hours ? '&hours=1' : ''}`, { signal });
  }

  clearUsage(signal) {
    return this.#json('/v1/usage', { method: 'DELETE', signal });
  }

  requests({ limit = 50, signal } = {}) {
    return this.#json(`/v1/requests?limit=${limit}`, { signal });
  }

  quota(signal) {
    return this.#json('/v1/quota', { signal, timeoutMs: 20000 });
  }

  checkin({ claim = false, signal } = {}) {
    return this.#json('/v1/checkin', { method: claim ? 'POST' : 'GET', signal, timeoutMs: 20000 });
  }

  /**
   * `POST /v1/web_search`：WorkBuddy 原生网页搜索（不走 DeepSeek）。
   *
   * @param {{ query: string, maxResults?: number, allowedDomains?: string[], freshness?: string, signal?: AbortSignal }} options
   */
  webSearch({ query, maxResults = 5, allowedDomains, freshness, signal } = {}) {
    const body = { query, max_results: maxResults };
    if (Array.isArray(allowedDomains) && allowedDomains.length) body.allowed_domains = allowedDomains;
    if (freshness) body.freshness = freshness;
    return this.#json('/v1/web_search', {
      method: 'POST',
      body,
      signal,
      // 搜索上游本身是模型侧检索，20s 内没回基本就是网关卡住；给足但不无限等。
      timeoutMs: 45_000,
    });
  }

  /**
   * `POST /v1/videos`：提交 Miora 视频任务（异步，成功即计费）。
   *
   * 超时只覆盖“提交并拿到任务 id”这一段；生成本身不在这里等。
   */
  videoSubmit({ prompt, mode, firstFrame, lastFrame, references, duration, resolution, aspectRatio, signal } = {}) {
    const body = {};
    if (typeof prompt === 'string' && prompt.trim()) body.prompt = prompt.trim();
    if (mode) body.mode = mode;
    if (firstFrame) body.first_frame = firstFrame;
    if (lastFrame) body.last_frame = lastFrame;
    if (Array.isArray(references) && references.length) body.references = references;
    if (duration !== undefined) body.duration = duration;
    if (resolution) body.resolution = resolution;
    if (aspectRatio) body.aspect_ratio = aspectRatio;
    return this.#json('/v1/videos', {
      method: 'POST',
      body,
      signal,
      // 桥侧提交超时 390s（与官方客户端一致）；工具侧略长，避免客户端先放弃。
      timeoutMs: 400_000,
    });
  }

  /** `GET /v1/videos/{id}`：查询任务状态；completed 时带 `output.url(s)`。
   *
   * `waitMs > 0` 让桥代客户端轮询（桥侧上限 60 秒），工具不必自己 sleep。
   */
  videoStatus(id, { waitMs = 0, signal } = {}) {
    return this.#mediaStatus('/v1/videos', id, { waitMs, signal });
  }

  /**
   * `POST /v1/images`（文生图）或 `/v1/images/edits`（图生图，带 images 时）。
   * 与视频一样是异步任务：成功返回任务 id，之后用 imageStatus 查询。
   */
  imageSubmit({ prompt, images, size, quality, mode, signal } = {}) {
    const body = {};
    if (typeof prompt === 'string' && prompt.trim()) body.prompt = prompt.trim();
    if (mode) body.mode = mode;
    if (Array.isArray(images) && images.length) body.images = images;
    if (size) body.size = size;
    if (quality) body.quality = quality;
    const path = mode === 'edit' ? '/v1/images/edits' : '/v1/images';
    return this.#json(path, {
      method: 'POST',
      body,
      signal,
      // 与视频一致：桥侧提交超时 390s，客户端略长。
      timeoutMs: 400_000,
    });
  }

  /** `GET /v1/images/{id}`：查询图片任务；completed 时带 `output.url(s)`。 */
  imageStatus(id, { waitMs = 0, signal } = {}) {
    return this.#mediaStatus('/v1/images', id, { waitMs, signal });
  }

  /** 视频 / 图片共用的查询：`wait` 秒数夹在 0–60，客户端超时必须比桥晚放弃。 */
  #mediaStatus(basePath, id, { waitMs = 0, signal } = {}) {
    const waitSeconds = Math.min(Math.max(Math.ceil(waitMs / 1000), 0), 60);
    const suffix = waitSeconds > 0 ? `?wait=${waitSeconds}` : '';
    return this.#json(`${basePath}/${encodeURIComponent(id)}${suffix}`, {
      signal,
      timeoutMs: waitSeconds > 0 ? 95_000 : 45_000,
    });
  }

  // ── 插件登录（第二条凭据来源）─────────────────────────────────────────
  /** 凭据来源状态（桌面端/插件、存储模式、生效来源）—— 不含任何令牌。 */
  authSource(signal) {
    return this.#json('/v1/auth/source', { signal, timeoutMs: 8000 });
  }

  /** 插件凭据清单 —— 不含任何令牌。 */
  authCredentials(signal) {
    return this.#json('/v1/auth/credentials', { signal, timeoutMs: 8000 });
  }

  deviceLoginStart({ region = 'cn', open = false } = {}, signal) {
    return this.#json('/v1/auth/device', { method: 'POST', body: { region, open: open === true }, signal, timeoutMs: 30000 });
  }

  deviceLoginPoll(state, signal) {
    return this.#json(`/v1/auth/device?state=${encodeURIComponent(state)}`, { signal, timeoutMs: 30000 });
  }

  deviceLoginCancel(state, signal) {
    return this.#json(`/v1/auth/device?state=${encodeURIComponent(state)}`, { method: 'DELETE', signal, timeoutMs: 8000 });
  }

  authSetActive(uid, signal) {
    return this.#json('/v1/auth/active', { method: 'POST', body: { uid }, signal, timeoutMs: 8000 });
  }

  authLogout(uid, signal) {
    return this.#json(`/v1/auth/credentials?uid=${encodeURIComponent(uid)}`, { method: 'DELETE', signal, timeoutMs: 15000 });
  }

  setAuthSource(source, signal) {
    return this.#json('/v1/auth/source', { method: 'POST', body: { source }, signal, timeoutMs: 8000 });
  }

  /** `POST /v1/chat/completions`，返回原始 Response（SSE 或 JSON）。 */
  chat(payload, { signal } = {}) {
    return this.#fetch('/v1/chat/completions', { method: 'POST', body: payload, signal, timeoutMs: 0 });
  }
}

/**
 * 桥进程管理器。
 *
 * 状态机很朴素，因为桥本身就是「无状态 + 幂等」的：
 *   probe() → 活 / 不活 / 令牌不匹配 / 端口被别的服务占用
 *   ensure() → 活就复用，不活就拉起并等就绪
 *   stop()   → 只停自己认识的那个 pid（/health 报出来的）
 */
export class BridgeSupervisor {
  /**
   * @param {object} options
   * @param {string} options.projectRoot 项目根目录（桥脚本与日志都相对它解析）
   * @param {string} [options.scriptPath] 桥脚本绝对路径
   * @param {string} [options.logPath] 桥日志绝对路径
   * @param {string} options.host
   * @param {number} options.port
   * @param {string} options.token
   * @param {boolean} options.autoStart 探测不活时是否自动拉起
   * @param {string} [options.nodePath] 启动桥用的 node（默认 process.execPath）
   * @param {Record<string,string|undefined>} [options.env] 追加/覆盖的环境变量
   * @param {(line: string) => void} [options.onLog]
   */
  constructor(options) {
    this.projectRoot = options.projectRoot;
    this.scriptPath = options.scriptPath || join(options.projectRoot, BRIDGE_SCRIPT_REL);
    this.logPath = options.logPath || join(options.projectRoot, BRIDGE_LOG_REL);
    this.host = options.host;
    this.port = options.port;
    this.token = options.token;
    /** 登录文件：来自 .env / 配置；多账号时必须显式指定，否则桥会自己探测。 */
    this.authFile = options.authFile || '';
    /**
     * 自动跟随桌面换号：`followAuthFile` 通常是 `'auto'`（由桥解析默认登录文件），
     * `followUid` 是钉住那一刻该文件里的账号。与控制台拉起桥时注入了同一组
     * 变量，两套启动路径的行为才不会漂移（issue #6）。
     */
    this.followAuthFile = options.followAuthFile || '';
    this.followUid = options.followUid || '';
    /** 自动签到开关（undefined = 用桥自己的默认值）。 */
    this.autoCheckin = options.autoCheckin;
    this.autoStart = options.autoStart;
    this.nodePath = options.nodePath || process.execPath;
    this.env = options.env || {};
    this.onLog = options.onLog || (() => {});

    this.client = new BridgeClient({
      baseUrl: `http://${this.host}:${this.port}`,
      token: this.token,
      timeoutMs: options.timeoutMs || 8000,
    });
    /** 本进程亲手拉起的桥 pid；用于「停止」与「重启」的归属判断。 */
    this.spawnedPid = null;
    this.lastStartError = null;
    this.lastStartAt = null;
    /** 正在进行的 ensure()，避免并发重复拉起。 */
    this.pendingEnsure = null;
  }

  get baseUrl() {
    return this.client.url;
  }

  /**
   * 当前磁盘上桥脚本的指纹（带 stat 缓存：桥脚本几乎不变，不能每次 probe 都读 500KB）。
   * 文件不存在或读不出时返回空串 —— 此时**不做**构建比对，避免测试/未安装环境误重启。
   */
  expectedBuild() {
    try {
      const st = statSync(this.scriptPath);
      const cache = this.buildCache || (this.buildCache = { at: 0, mtimeMs: -1, size: -1, hash: '' });
      if (cache.mtimeMs === st.mtimeMs && cache.size === st.size) return cache.hash;
      const hash = bridgeBuildHash(this.scriptPath);
      Object.assign(cache, { mtimeMs: st.mtimeMs, size: st.size, hash });
      return hash;
    } catch {
      return '';
    }
  }

  /**
   * 端口上的桥与当前脚本是否同一构建。
   *
   * 旧桥没有 `/health.build` → 视为不一致（必须重启一次才能把新逻辑装进去）。
   * 本地脚本读不出（测试桩 / 脚本丢了）→ 无法判断，不触发重启。
   */
  buildDiff(health) {
    const expected = this.expectedBuild();
    if (!expected) return { expected: '', actual: String(health?.build || ''), stale: false };
    const actual = String(health?.build || '');
    return { expected, actual, stale: actual !== expected };
  }

  /**
   * 探测桥状态。**不抛错**——把失败翻译成状态。
   * @returns {Promise<{state: 'running'|'stopped'|'unauthenticated'|'degraded'|'unauthorized'|'foreign', health?: object, error?: string}>}
   */
  async probe(signal) {
    try {
      const health = await this.client.health(signal);
      if (!health || health.ok !== true || typeof health.pid !== 'number') {
        return { state: 'foreign', error: '端口上有一个 HTTP 服务，但它不是 workbuddy-bridge' };
      }
      const diff = this.buildDiff(health);
      return {
        state: 'running',
        health,
        bridgeBuild: diff.actual,
        expectedBuild: diff.expected,
        staleBuild: diff.stale,
      };
    } catch (error) {
      if (error?.status === 401) {
        /*
         * 令牌不一致。最常见的原因是**升级**：插件与桥现在共用
         * `dsh-plugin/.bridge-token`，正常情况下自动一致；但如果用户曾手改
         * `.env` 里的 `WORKBUDDY_LOCAL_TOKEN`，或旧版本残留了不同的值，就会撞上。
         * 指到文件位置，让用户能自己核对 —— 只说"不一致"等于让人干瞪眼。
         */
        return {
          state: 'unauthorized',
          error: '端口上已有桥，但本地令牌与本插件配置不一致。'
            + '检查 .env 的 WORKBUDDY_LOCAL_TOKEN 是否与 dsh-plugin/.bridge-token 相同，'
            + '或删掉 .env 里那一行让它自动生成；改完重启桥。',
        };
      }
      /**
       * **桥活着但登录凭据读不出来**：`/health` 会回 503（body 里带 authFile 与原因）。
       * 这是最常见的真实故障（WorkBuddy 登录过期、登录文件被换掉），必须与
       * "端口上是别人的服务"区分开 —— 否则面板会让人去找一个不存在的端口冲突，
       * 而且 ensure() 会拒绝复用这个桥。凭 body 形状认领它。
       */
      const payload = error?.payload;
      const looksLikeOurBridge = payload && typeof payload === 'object'
        && payload.ok === false
        && (payload.authFile !== undefined || /login|sign in|credential|凭据|登录|token/i.test(String(payload.error || '')));
      if (looksLikeOurBridge) {
        /*
         * 「从来没登录过」与「登录坏了」要分开：前者是首次安装的正常状态，
         * 面板应该显示「未登录 + 去登录」，而不是吓人的红色「凭据异常」。
         * 桥的 503 body 带 credential 段，据此区分。
         */
        const cred = payload.credential;
        const noCredential = Boolean(cred)
          && cred.desktop?.available !== true
          && Number(cred.plugin?.count || 0) === 0;
        return {
          state: noCredential ? 'unauthenticated' : 'degraded',
          error: String(payload.error || error.message),
          authFile: payload.authFile,
          health: payload,
        };
      }
      if (error?.status) {
        return { state: 'foreign', error: `端口返回 HTTP ${error.status}，不是 workbuddy-bridge` };
      }
      return { state: 'stopped', error: String(error?.message || error) };
    }
  }

  /** 桥是否活着（不自动拉起）。 */
  async isRunning(signal) {
    return (await this.probe(signal)).state === 'running';
  }

  /**
   * 保证桥可用：活着就复用，否则按配置拉起并等待就绪。
   * @param {{ restart?: boolean, signal?: AbortSignal, readyTimeoutMs?: number }} [options]
   * @returns {Promise<{ok: boolean, started: boolean, reused: boolean, state: string, health?: object, error?: string}>}
   */
  async ensure({ restart = false, signal, readyTimeoutMs = 30000, authFile } = {}) {
    if (this.pendingEnsure) return this.pendingEnsure;
    this.pendingEnsure = this.#ensure({ restart, signal, readyTimeoutMs, authFile })
      .finally(() => { this.pendingEnsure = null; });
    return this.pendingEnsure;
  }

  async #ensure({ restart, signal, readyTimeoutMs, authFile }) {
    let status = await this.probe(signal);
    let restartReason = '';
    if (status.state === 'running' && !restart) {
      /*
       * 复用前先核对两件事 —— 任何一件不成立都必须重启，否则用户升级后
       * 会继续被旧进程服务：
       *   1. 构建指纹：端口上的是不是当前磁盘脚本（旧桥没有 build 字段）；
       *   2. 登录文件：端口上的桥是不是按我们想要的账号启动的。
       */
      const diff = this.buildDiff(status.health);
      if (diff.stale) {
        restartReason = `bridge build changed (${diff.actual || 'unknown'} -> ${diff.expected})`;
      }
      const desiredAuth = authFile || this.authFile;
      if (!restartReason && desiredAuth) {
        const norm = (p) => String(p || '').replace(/\\/g, '/').toLowerCase();
        const want = norm(desiredAuth);
        const seen = [norm(status.health?.authFile), norm(status.health?.authFilePinned)];
        if (!seen.includes(want)) {
          restartReason = `bridge auth file changed (${desiredAuth})`;
        }
      }
      if (!restartReason) {
        return { ok: true, started: false, reused: true, state: 'running', health: status.health };
      }
      this.onLog(restartReason + '; restarting bridge');
    }
    if (status.state === 'unauthorized' || status.state === 'foreign') {
      // 端口被别人占着：不抢，如实报错（抢端口比报错危险得多）
      return { ok: false, started: false, reused: false, state: status.state, error: status.error };
    }
    if (status.state === 'degraded' || status.state === 'unauthenticated') {
      // 桥在跑，但登录凭据读不出来 / 还没登录：**复用**它并把原因带上去，
      // 绝不因为"健康检查不绿"就再拉一个（会撞端口，而且用户重新登录后同一个进程就能恢复）。
      /*
       * 但升级后必须例外：端口上的进程如果还是旧脚本，用户重新登录后仍是旧
       * 逻辑。先看构建指纹；旧进程有 pid 才停，停不掉就如实报错。
       */
      const diff = this.buildDiff(status.health);
      if (diff.stale) {
        this.onLog(`bridge build changed while degraded (${diff.actual || 'unknown'} -> ${diff.expected}); restarting bridge`);
        const stopped = await this.stop(signal);
        if (!stopped.ok) {
          return {
            ok: false,
            started: false,
            reused: true,
            state: status.state,
            staleBuild: true,
            error: `${status.error || 'bridge is not ready'}；旧构建进程无法重启：${stopped.error}`,
          };
        }
        // 旧进程已停：继续走下面的 start()，用当前脚本重新拉起
      } else {
        return { ok: false, started: false, reused: true, state: status.state, error: status.error, health: status.health };
      }
    }
    if (status.state === 'running' && (restart || restartReason)) {
      const stopped = await this.stop(signal);
      if (!stopped.ok) return { ok: false, started: false, reused: false, state: 'running', error: stopped.error };
    }

    const start = await this.start({ signal, authFile });
    if (!start.ok) return { ok: false, started: false, reused: false, state: 'stopped', error: start.error };

    const deadline = Date.now() + readyTimeoutMs;
    let lastError = start.error || '';
    while (Date.now() < deadline) {
      if (signal?.aborted) return { ok: false, started: true, reused: false, state: 'starting', error: 'aborted' };
      await sleep(250);
      status = await this.probe(signal);
      if (status.state === 'running') {
        return { ok: true, started: true, reused: false, state: 'running', health: status.health };
      }
      if (status.state === 'unauthorized' || status.state === 'foreign') {
        return { ok: false, started: true, reused: false, state: status.state, error: status.error };
      }
      /*
       * 桥已经起来了，只是还没有凭据：这是首次安装的正常状态，必须立刻返回，
       * 不能让首次启动白等 readyTimeoutMs（默认 30 秒）才弹出登录引导。
       */
      if (status.state === 'unauthenticated' || status.state === 'degraded') {
        return { ok: false, started: true, reused: false, state: status.state, error: status.error, health: status.health };
      }
      lastError = status.error || lastError;
    }
    return {
      ok: false,
      started: true,
      reused: false,
      state: 'starting',
      error: `桥已拉起但在 ${Math.round(readyTimeoutMs / 1000)} 秒内没有就绪：${lastError}`,
    };
  }

  /**
   * 拉起桥进程。日志重定向到 bridge.log（append），与控制台同源。
   * @param {{ signal?: AbortSignal, authFile?: string }} [options]
   */
  async start({ authFile } = {}) {
    if (!existsSync(this.scriptPath)) {
      return { ok: false, pid: null, error: `找不到桥脚本：${this.scriptPath}（用 projectRoot 配置指向 workbuddy-to-dsh 根目录）` };
    }
    const alive = await this.isRunning();
    if (alive) return { ok: true, pid: null, reused: true };

    let logFd = null;
    try {
      mkdirSync(dirname(this.logPath), { recursive: true });
      // 只在**本次真的要拉起新进程**时滚动：桥还活着时上面已经 return 了。
      rotateLogIfNeeded(this.logPath);
      logFd = openSync(this.logPath, 'a');
    } catch { /* 日志打不开不该阻止桥启动 */ }

    const env = {
      ...process.env,
      // 显式确保以 node 模式运行：本插件的宿主是 DSH Desktop（Electron），
      // nodePath 默认取 process.execPath —— 那是 Electron 二进制，没有这个
      // 变量会以"应用模式"启动（弹一个 DSH 窗口而不是跑桥脚本）。手动用
      // 真 node 跑插件时该变量无害（node 会忽略它）。
      ELECTRON_RUN_AS_NODE: '1',
      WORKBUDDY_HOST: this.host,
      WORKBUDDY_PORT: String(this.port),
      WORKBUDDY_LOCAL_TOKEN: this.token,
      WORKBUDDY_LOG: '1',
      ...(authFile || this.authFile ? { WORKBUDDY_AUTH_FILE: authFile || this.authFile } : {}),
      ...(this.followAuthFile ? { WORKBUDDY_AUTH_FILE_FOLLOW: this.followAuthFile } : {}),
      ...(this.followUid ? { WORKBUDDY_AUTH_FOLLOW_UID: this.followUid } : {}),
      ...(this.autoCheckin === undefined ? {} : { WORKBUDDY_AUTO_CHECKIN: this.autoCheckin ? '1' : '0' }),
      ...this.env,
    };

    try {
      const child = spawn(this.nodePath, [this.scriptPath], {
        cwd: this.projectRoot,
        env,
        // detached：桥要活过 dsh 的重启，这与项目原有的「关掉控制台桥继续驻留」一致
        detached: true,
        stdio: logFd === null ? 'ignore' : ['ignore', logFd, logFd],
        windowsHide: true,
      });
      child.unref();
      this.spawnedPid = child.pid ?? null;
      this.lastStartAt = Date.now();
      this.lastStartError = null;
      this.onLog(`bridge spawned pid=${child.pid} ${this.baseUrl}`);
      child.on('error', (error) => {
        this.lastStartError = String(error?.message || error);
        this.onLog(`bridge spawn error: ${this.lastStartError}`);
      });
      return { ok: true, pid: child.pid ?? null, reused: false };
    } catch (error) {
      this.lastStartError = String(error?.message || error);
      return { ok: false, pid: null, error: this.lastStartError };
    } finally {
      if (logFd !== null) { try { closeSync(logFd); } catch { /* 忽略 */ } }
    }
  }

  /** 停掉桥：只停 /health 报出的那个 pid（本机回环，不会误伤别的服务）。 */
  async stop(signal) {
    const status = await this.probe(signal);
    if (status.state === 'stopped') return { ok: true, stopped: false, reason: 'bridge was not running' };
    /*
     * 未登录 / 凭据异常时桥仍然是我们的进程：503 body 现在带 pid，可以正常停止。
     * 只有 foreign / unauthorized（没有可信 pid）才拒绝。
     */
    const pid = status.health?.pid;
    if (!['running', 'degraded', 'unauthenticated'].includes(status.state) || !Number.isFinite(pid)) {
      return { ok: false, error: status.error || status.state };
    }
    try {
      process.kill(pid, 'SIGTERM');
    } catch (error) {
      return { ok: false, error: `无法结束 pid ${pid}：${error.message}` };
    }
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      await sleep(200);
      if ((await this.probe(signal)).state === 'stopped') {
        if (this.spawnedPid === pid) this.spawnedPid = null;
        return { ok: true, stopped: true, pid };
      }
    }
    return { ok: false, error: `pid ${pid} 在 8 秒内没有退出` };
  }

  /**
   * 读取桥日志尾部（控制台「桥日志」面板读的是同一个文件）。
   * @param {{ lines?: number, maxBytes?: number }} [options]
   */
  readLog({ lines = 200, maxBytes = 512 * 1024 } = {}) {
    let fd = null;
    try {
      if (!existsSync(this.logPath)) return { path: this.logPath, lines: [], size: 0, mtime: null };
      const stat = statSync(this.logPath);
      // 只读尾部：bridge.log 是**无限增长**的（追加写），而设置页每 5 秒轮询一次。
      // 早先的实现先 readFileSync 整个文件再切片 —— 日志涨到几十 MB 后就是每次
      // 轮询都全量读一遍。这里用 fd 定位到 size - maxBytes 处读。
      const start = Math.max(0, stat.size - maxBytes);
      const length = stat.size - start;
      let text = '';
      if (length > 0) {
        fd = openSync(this.logPath, 'r');
        const buffer = Buffer.alloc(length);
        const read = readSync(fd, buffer, 0, length, start);
        text = buffer.subarray(0, read).toString('utf8');
        // 从中间开始时首行多半是被截断的半行，丢掉它
        if (start > 0) {
          const nl = text.indexOf('\n');
          text = nl >= 0 ? text.slice(nl + 1) : '';
        }
      }
      const all = text.split(/\r?\n/).filter((l) => l.length > 0);
      return {
        path: this.logPath,
        lines: all.slice(-lines),
        size: stat.size,
        mtime: stat.mtime.toISOString(),
      };
    } catch (error) {
      return { path: this.logPath, lines: [], size: 0, mtime: null, error: String(error?.message || error) };
    } finally {
      if (fd !== null) { try { closeSync(fd); } catch { /* 忽略 */ } }
    }
  }
}
