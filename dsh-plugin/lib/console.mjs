/**
 * 控制台的进程管理。
 *
 * 分工（这就是「插件 + 控制台」的结合方式）：
 *   插件  = 引擎：原生模型路由、桥的生命周期、工具、命令、入口
 *   控制台 = 界面：逐条请求、趋势图、账号切换、CSV 导出、签到、诊断 —— 它本来就更全
 *
 * 所以插件不再自己造一个仪表盘，而是把控制台一起管起来：已在跑就复用，
 * 没跑就拉起（与控制台自己的 `启动.cmd` 完全等价，都读同一个 `config.mjs`/`.env`），
 * 然后在 dsh 里给一个「打开控制台」的入口。
 *
 * 识别方式：控制台首页的 `<title>` 是 `WorkBuddy 中转控制台` —— 用它判断 8792
 * 上跑的到底是不是我们的控制台，而不是随便一个占着端口的 HTTP 服务。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, closeSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * 用来确认端口上**是我们自己的控制台**的标记。
 *
 * 原先用的是首页 `<title>`（`'WorkBuddy 中转控制台'`）—— 项目改定位成
 * 「WorkBuddy 本地 API 桥」后标题跟着改了，于是**插件再也认不出自己的控制台**：
 * 探活返回 `foreign`，进而拒绝复用、报「换个 DASHBOARD_PORT」。
 *
 * **品牌名会变，结构标记不会** —— 改用导航栏的 id。
 *
 * ⚠️ 它必须落在**首页首个数据块**内：下面的 `probe` 只读第一个 chunk 就断开
 * （首页 146KB，全读没必要）。`id="navTabs"` 在第 45 行，远早于正文，满足前提。
 */
export const CONSOLE_MARKER = 'id="navTabs"';
/** 控制台脚本相对项目根的位置。 */
export const CONSOLE_SCRIPT_REL = join('dashboard', 'server.mjs');
/** 控制台日志相对项目根的位置。 */
export const CONSOLE_LOG_REL = join('dashboard', 'console.log');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class ConsoleSupervisor {
  /**
   * @param {object} options
   * @param {string} options.projectRoot
   * @param {string} [options.scriptPath]
   * @param {string} [options.logPath]
   * @param {string} [options.host]
   * @param {number} [options.port]
   * @param {boolean} [options.autoStart]
   * @param {string} [options.nodePath]
   * @param {Record<string,string|undefined>} [options.env]
   * @param {(line: string) => void} [options.onLog]
   */
  constructor(options) {
    this.projectRoot = options.projectRoot;
    this.scriptPath = options.scriptPath || join(options.projectRoot, CONSOLE_SCRIPT_REL);
    this.logPath = options.logPath || join(options.projectRoot, CONSOLE_LOG_REL);
    this.host = options.host || '127.0.0.1';
    this.port = options.port || 8792;
    this.autoStart = options.autoStart !== false;
    this.nodePath = options.nodePath || process.execPath;
    this.env = options.env || {};
    this.onLog = options.onLog || (() => {});
    /** 只有「本进程亲手拉起的」控制台才由我们停；别人起的（双击 启动.cmd）不动。 */
    this.spawnedPid = null;
    this.lastStartError = null;
    this.pendingEnsure = null;
    /** 探测结果缓存：面板每 5 秒问一次状态，没必要每次都把首页拉一遍。 */
    this.cache = { at: 0, state: null, error: '' };
    this.cacheTtlMs = options.cacheTtlMs ?? 20_000;
  }

  get url() {
    return `http://${this.host}:${this.port}`;
  }

  /**
   * 探测控制台是否在跑。**不抛错**。
   * @param {{signal?: AbortSignal, cached?: boolean}} [options]
   */
  async probe({ signal, cached = false } = {}) {
    if (cached && this.cache.state && Date.now() - this.cache.at < this.cacheTtlMs) {
      return { state: this.cache.state, error: this.cache.error, cached: true };
    }
    let result;
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(new Error('timeout')), 3000);
      const onAbort = () => ac.abort(signal?.reason);
      signal?.addEventListener('abort', onAbort, { once: true });
      let text = '';
      try {
        const res = await fetch(`${this.url}/`, { signal: ac.signal, headers: { accept: 'text/html' } });
        // 首页 146KB，只看开头即可判断是不是我们的控制台 —— 读完首块就断开
        const reader = res.body?.getReader();
        if (reader) {
          const { value } = await reader.read();
          text = new TextDecoder().decode(value || new Uint8Array());
          await reader.cancel().catch(() => {});
        } else {
          text = await res.text();
        }
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      }
      result = text.includes(CONSOLE_MARKER)
        ? { state: 'running', error: '' }
        : { state: 'foreign', error: `端口 ${this.port} 上有 HTTP 服务，但不是 WorkBuddy 控制台（换个 DASHBOARD_PORT）` };
    } catch (error) {
      result = { state: 'stopped', error: String(error?.message || error) };
    }
    this.cache = { at: Date.now(), state: result.state, error: result.error };
    return result;
  }

  async isRunning(options) {
    return (await this.probe(options)).state === 'running';
  }

  /**
   * 保证控制台可用：活着就复用，否则按配置拉起并等它就绪。
   * @param {{signal?: AbortSignal, readyTimeoutMs?: number}} [options]
   */
  async ensure({ signal, readyTimeoutMs = 20_000 } = {}) {
    if (this.pendingEnsure) return this.pendingEnsure;
    this.pendingEnsure = this.#ensure({ signal, readyTimeoutMs }).finally(() => { this.pendingEnsure = null; });
    return this.pendingEnsure;
  }

  async #ensure({ signal, readyTimeoutMs }) {
    const status = await this.probe({ signal });
    if (status.state === 'running') return { ok: true, started: false, reused: true, state: 'running', url: this.url };
    if (status.state === 'foreign') return { ok: false, started: false, reused: false, state: 'foreign', error: status.error };
    const started = await this.start();
    if (!started.ok) return { ok: false, started: false, reused: false, state: 'stopped', error: started.error };
    const deadline = Date.now() + readyTimeoutMs;
    let lastError = '';
    while (Date.now() < deadline) {
      if (signal?.aborted) return { ok: false, started: true, reused: false, state: 'starting', error: 'aborted' };
      await sleep(250);
      const probe = await this.probe({ signal });
      if (probe.state === 'running') return { ok: true, started: true, reused: false, state: 'running', url: this.url, pid: started.pid };
      if (probe.state === 'foreign') return { ok: false, started: true, reused: false, state: 'foreign', error: probe.error };
      lastError = probe.error || lastError;
    }
    return { ok: false, started: true, reused: false, state: 'starting', error: `控制台已拉起但 ${Math.round(readyTimeoutMs / 1000)} 秒内没有就绪：${lastError}` };
  }

  /** 拉起控制台进程。stdout/stderr 落到 dashboard/console.log。 */
  async start() {
    if (!existsSync(this.scriptPath)) {
      return { ok: false, pid: null, error: `找不到控制台脚本：${this.scriptPath}` };
    }
    if (await this.isRunning({ cached: false })) return { ok: true, pid: null, reused: true };

    let logFd = null;
    try {
      mkdirSync(dirname(this.logPath), { recursive: true });
      logFd = openSync(this.logPath, 'a');
    } catch { /* 日志打不开不该阻止控制台启动 */ }

    const env = {
      ...process.env,
      // 同 bridge.start()：宿主是 Electron 时确保以 node 模式运行（不依赖
      // 环境变量继承）；真 node 环境下该变量无害。
      ELECTRON_RUN_AS_NODE: '1',
      // 桥的生命周期归插件管：插件拉起的这个控制台实例**不要**再去拉一次桥，
      // 否则两个进程会同时探测→同时 spawn，后到的那个以 EADDRINUSE 收场。
      // （控制台页面上的「启动桥服务」按钮不受影响，那是明确的用户动作。）
      // 想让控制台照旧自己拉桥，就在环境里显式设 DASHBOARD_AUTO_START_BRIDGE=1。
      DASHBOARD_AUTO_START_BRIDGE: process.env.DASHBOARD_AUTO_START_BRIDGE ?? '0',
      // 关键：不要让 dsh 每次启动都弹一个浏览器窗口
      DASHBOARD_OPEN_BROWSER: '0',
      ...this.env,
    };

    try {
      const child = spawn(this.nodePath, [this.scriptPath], {
        cwd: this.projectRoot,
        env,
        detached: true,
        stdio: logFd === null ? 'ignore' : ['ignore', logFd, logFd],
        windowsHide: true,
      });
      child.unref();
      this.spawnedPid = child.pid ?? null;
      this.lastStartError = null;
      this.cache = { at: 0, state: null, error: '' };
      this.onLog(`console spawned pid=${child.pid} ${this.url}`);
      child.on('error', (error) => {
        this.lastStartError = String(error?.message || error);
        this.onLog(`console spawn error: ${this.lastStartError}`);
      });
      return { ok: true, pid: child.pid ?? null, reused: false };
    } catch (error) {
      this.lastStartError = String(error?.message || error);
      return { ok: false, pid: null, error: this.lastStartError };
    } finally {
      if (logFd !== null) { try { closeSync(logFd); } catch { /* 忽略 */ } }
    }
  }

  /**
   * 只停「本进程亲手拉起的」控制台。
   *
   * 控制台不像桥那样在 `/health` 里自报 pid，所以对别人启动的实例（双击
   * `启动.cmd`）我们**不动它** —— 停别人起的东西不是插件该做的事。
   */
  async stop() {
    const pid = this.spawnedPid;
    if (!pid) {
      const status = await this.probe({ cached: false });
      return {
        ok: false,
        stopped: false,
        error: status.state === 'running'
          ? '这个控制台不是插件启动的（可能是你双击 启动.cmd 起的），插件不会去停它'
          : '控制台没有在运行',
      };
    }
    try {
      process.kill(pid, 'SIGTERM');
    } catch (error) {
      return { ok: false, stopped: false, error: `无法结束 pid ${pid}：${error.message}` };
    }
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      await sleep(200);
      if ((await this.probe({ cached: false })).state === 'stopped') {
        this.spawnedPid = null;
        return { ok: true, stopped: true, pid };
      }
    }
    return { ok: false, stopped: false, error: `pid ${pid} 在 8 秒内没有退出` };
  }
}
