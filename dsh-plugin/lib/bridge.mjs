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
import { existsSync, mkdirSync, openSync, closeSync, readSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** 默认的桥脚本相对项目根的位置。 */
export const BRIDGE_SCRIPT_REL = join('bridge', 'workbuddy-bridge.mjs');
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
    const timer = budget > 0 ? setTimeout(() => ac.abort(new Error('timeout')), budget) : null;
    const onAbort = () => ac.abort(signal?.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const res = await fetch(`${this.baseUrl}${pathname}`, {
        method,
        headers: {
          ...authHeaders(this.token),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ac.signal,
      });
      return res;
    } finally {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
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
      throw error;
    }
    return parsed;
  }

  /** `GET /health`。桥未运行时抛错（调用方用 {@link probe} 判活在）。 */
  health(signal) {
    return this.#json('/health', { signal, timeoutMs: 4000 });
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
   * 探测桥状态。**不抛错**——把失败翻译成状态。
   * @returns {Promise<{state: 'running'|'stopped'|'unauthorized'|'foreign'|'error', health?: object, error?: string}>}
   */
  async probe(signal) {
    try {
      const health = await this.client.health(signal);
      if (!health || health.ok !== true || typeof health.pid !== 'number') {
        return { state: 'foreign', error: '端口上有一个 HTTP 服务，但它不是 workbuddy-bridge' };
      }
      return { state: 'running', health };
    } catch (error) {
      if (error?.status === 401) {
        return {
          state: 'unauthorized',
          error: '端口上已有桥，但本地令牌与本插件配置不一致（改 WORKBUDDY_LOCAL_TOKEN 或重启桥）',
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
        return {
          state: 'degraded',
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
    if (status.state === 'running' && !restart) {
      return { ok: true, started: false, reused: true, state: 'running', health: status.health };
    }
    if (status.state === 'unauthorized' || status.state === 'foreign') {
      // 端口被别人占着：不抢，如实报错（抢端口比报错危险得多）
      return { ok: false, started: false, reused: false, state: status.state, error: status.error };
    }
    if (status.state === 'degraded' && !restart) {
      // 桥在跑，但登录凭据读不出来：**复用**它并把原因带上去，
      // 绝不因为"健康检查不绿"就再拉一个（会撞端口，而且用户重新登录后同一个进程就能恢复）
      return { ok: false, started: false, reused: true, state: 'degraded', error: status.error, health: status.health };
    }
    if (status.state === 'running' && restart) {
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
    if (status.state !== 'running') return { ok: false, error: status.error || status.state };
    const pid = status.health.pid;
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
