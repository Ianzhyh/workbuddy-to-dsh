/**
 * dsh-plugin-workbuddy —— 宿主端。
 *
 * 分工（插件 + 控制台的结合方式）：
 *   插件  = 引擎：原生模型路由、桥与控制台的生命周期、工具、命令、入口
 *   控制台 = 界面：逐条请求、趋势图、账号切换、CSV、签到、诊断（它本来就更全）
 *
 * 具体做这些事：
 *
 *   1. 桥的生命周期归插件管：启动时复用已在跑的桥，没跑就按配置拉起
 *      （桥仍是**独立进程**，控制台与其它 OpenAI 客户端照旧可用）；
 *   2. 控制台也一起管：复用/拉起 `dashboard/server.mjs`，让它常驻，
 *      这样 dsh 里一个链接就能进完整的控制台；
 *   3. 用 `ctx.llm.registerAdapter(['workbuddy'], adapter)` 注册一条原生路由：
 *      模型直接出现在 dsh 的模型选择器里，**不再需要**改 settings.yaml，
 *      也不再依赖 llm-pi-ai 那一行；
 *   4. 注册 5 个模型可见的工具（状态 / 模型 / 用量 / 签到 / 启停桥）；
 *   5. 注册 `/workbuddy` 斜杠命令，人可以直接在输入框里操作；
 *   6. 挂一组 `/workbuddy/*` 同源 HTTP 路由，给 dsh 里的入口页当数据面；
 *   7. 首次启动时把旧的 `llm-pi-ai.providers.workbuddy` 手写路由清理掉
 *      （先备份），否则两条路由会撞名。
 *
 * 这个文件刻意**不 import 任何 `@deepseek-ai/*` 包**：profile 的 node_modules
 * 里解析不到它们，而 llm 服务的注册路径也不要求适配器继承 LlmAdapter
 * （只调用 providerInfo / providerRetryPolicy，没有 instanceof 检查）。
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BridgeClient, BridgeSupervisor, BRIDGE_SCRIPT_REL } from './bridge.mjs';
import { ConsoleSupervisor } from './console.mjs';
import { WorkBuddyAdapter } from './adapter.mjs';
import { toDirectory, pickDefaultModel } from './models.mjs';
import { createTools } from './tools.mjs';
import { createRouteTable, mountRoutes } from './routes.mjs';
import { cleanLegacyRoutes, detectLegacyRoutes } from './legacy.mjs';

export const name = 'workbuddy';
/** 硬依赖 llm：没有它就没有「原生路由」这件事，插件保持不激活比半激活好。 */
export const inject = ['llm'];

const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 默认值集中在一处，README 与面板都读它。 */
export const DEFAULTS = {
  projectRoot: '',
  bridgeHost: '127.0.0.1',
  bridgePort: 8790,
  localToken: 'wb-local-bridge',
  nodePath: '',
  /** 登录文件：留空 = 交给桥自己探测（多账号时应显式指定）。 */
  authFile: '',
  /** 每日自动签到：undefined = 用桥的默认值（开）。 */
  autoCheckin: undefined,
  autoStart: true,
  autoStartTimeoutMs: 30_000,
  /** 控制台（数据界面）也由插件复用/拉起：dsh 里给个入口就够了，不重复造仪表盘。 */
  consoleAutoStart: true,
  consoleHost: '127.0.0.1',
  consolePort: 8792,
  provider: 'workbuddy',
  fallbackProvider: 'workbuddy-native',
  displayName: 'WorkBuddy',
  catalogTtlMs: 60_000,
  modelAllow: [],
  modelDeny: [],
  migrateLegacy: true,
  tools: true,
  commands: true,
  routes: true,
  panel: true,
  log: true,
};

function asBool(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  const text = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', ''].includes(text)) return true;
  if (['0', 'false', 'no', 'off'].includes(text)) return false;
  return fallback;
}

function asStringArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map((v) => String(v)).filter(Boolean);
  return String(value).split(',').map((v) => v.trim()).filter(Boolean);
}

/** 合并 patch 里给的 config 与默认值。 */
export function resolveConfig(raw = {}) {
  const cfg = { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) };
  return {
    ...cfg,
    projectRoot: String(cfg.projectRoot || ''),
    bridgeHost: String(cfg.bridgeHost || DEFAULTS.bridgeHost),
    bridgePort: Number(cfg.bridgePort) || DEFAULTS.bridgePort,
    localToken: String(cfg.localToken ?? DEFAULTS.localToken),
    nodePath: String(cfg.nodePath || ''),
    authFile: String(cfg.authFile || ''),
    autoCheckin: cfg.autoCheckin === undefined || cfg.autoCheckin === null
      ? undefined
      : asBool(cfg.autoCheckin, undefined),
    autoStart: asBool(cfg.autoStart, DEFAULTS.autoStart),
    autoStartTimeoutMs: Number(cfg.autoStartTimeoutMs) || DEFAULTS.autoStartTimeoutMs,
    consoleAutoStart: asBool(cfg.consoleAutoStart, DEFAULTS.consoleAutoStart),
    consoleHost: String(cfg.consoleHost || DEFAULTS.consoleHost),
    consolePort: Number(cfg.consolePort) || DEFAULTS.consolePort,
    provider: String(cfg.provider || DEFAULTS.provider),
    fallbackProvider: String(cfg.fallbackProvider || DEFAULTS.fallbackProvider),
    displayName: String(cfg.displayName || DEFAULTS.displayName),
    catalogTtlMs: Number(cfg.catalogTtlMs) || DEFAULTS.catalogTtlMs,
    modelAllow: asStringArray(cfg.modelAllow),
    modelDeny: asStringArray(cfg.modelDeny),
    migrateLegacy: asBool(cfg.migrateLegacy, DEFAULTS.migrateLegacy),
    tools: asBool(cfg.tools, DEFAULTS.tools),
    commands: asBool(cfg.commands, DEFAULTS.commands),
    routes: asBool(cfg.routes, DEFAULTS.routes),
    panel: asBool(cfg.panel, DEFAULTS.panel),
    log: asBool(cfg.log, DEFAULTS.log),
  };
}

/**
 * 定位 workbuddy-to-dsh 检出目录：桥脚本在里面。
 *
 * 顺序：显式配置 → 环境变量 → 插件目录的上一级（插件就在仓库里）→
 * **插件自带的 vendor/**（分发给别人时用它，见 scripts/vendor.mjs）→
 * node_modules 上溯三级（安装在 profile 里时）→ 常见位置。
 *
 * 仓库优先于 vendor 是有意的：本机开发时改 bridge/dashboard 立刻生效，
 * 不会被一份快照盖住。vendor 只在「仓库不在旁边」时兜底。
 */
export function projectRootCandidates(configured = '') {
  const candidates = [];
  if (configured) candidates.push({ path: configured, kind: 'configured' });
  if (process.env.WORKBUDDY_ROOT) candidates.push({ path: process.env.WORKBUDDY_ROOT, kind: 'env' });
  candidates.push({ path: dirname(PLUGIN_DIR), kind: 'repo' });                    // <root>/dsh-plugin → <root>
  candidates.push({ path: join(PLUGIN_DIR, 'vendor'), kind: 'vendor' });           // 自带副本（分发用）
  candidates.push({ path: resolve(PLUGIN_DIR, '..', '..', '..'), kind: 'node_modules' });
  candidates.push({ path: resolve(process.cwd(), '..'), kind: 'cwd' });
  candidates.push({ path: join(homedir(), 'workbuddy-to-dsh'), kind: 'home' });
  candidates.push({ path: 'E:\\workbuddy-to-dsh', kind: 'fallback' });
  return candidates;
}

export function detectProjectRoot(configured = '') {
  for (const candidate of projectRootCandidates(configured)) {
    if (!candidate.path) continue;
    try {
      if (existsSync(join(candidate.path, BRIDGE_SCRIPT_REL))) return resolve(candidate.path);
    } catch { /* 忽略不可访问的候选 */ }
  }
  return configured ? resolve(configured) : '';
}

/**
 * 读项目根的 `.env`（与 config.mjs 同一套极简语法：KEY=VALUE、# 注释、可选引号）。
 *
 * 为什么插件要自己读：桥进程只认环境变量，而用户可能把端口 / 登录文件写在了
 * `.env` 里（config.mjs 的「统一配置真源」）。插件是另一个进程，必须补上这一层，
 * 否则会出现「控制台起在 8888、插件却去连 8790」这种对不上的情况。
 */
export function readProjectEnv(projectRoot) {
  const out = {};
  if (!projectRoot) return out;
  const file = join(projectRoot, '.env');
  if (!existsSync(file)) return out;
  try {
    for (const rawLine of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      out[key] = value;
    }
  } catch { /* .env 不可读就当作没有 */ }
  return out;
}

/** dsh home / profile 目录（旧路由清理要用）。 */
function resolveDshPaths() {  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  const profile = process.env.DSH_PROFILE || 'desktop';
  const profileDir = process.env.DSH_PROFILE_DIR || join(home, 'profiles', profile);
  return {
    home,
    profileDir,
    settingsPath: join(home, 'settings.yaml'),
    patchPath: join(profileDir, 'cordis.patch.yml'),
  };
}

/**
 * 客户端半边是否已被 dsh 组装进 Web 引导图。
 *
 * 这是「面板为什么没出现」最关键的一条诊断：宿主端把每个声明了 `dsh.client`
 * 的 Loader 条目组装成一条引导行，`ctx.clientModules.graph()` 就是那张表。
 */
export function clientGraphSummary(clientModules, packageName = 'dsh-plugin-workbuddy') {
  if (!clientModules || typeof clientModules.graph !== 'function') {
    return { available: false, reason: 'clientModules 服务不可用（当前不是 Web 组合）' };
  }
  let graph;
  try {
    graph = clientModules.graph();
  } catch (error) {
    return { available: false, reason: `读取引导图失败：${error?.message || error}` };
  }
  const ids = new Set();
  const seen = new Set();
  const visit = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 5 || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) { for (const item of node) visit(item, depth + 1); return; }
    if (typeof node.id === 'string') ids.add(node.id);
    if (typeof node.packageName === 'string') ids.add(node.packageName);
    for (const value of Object.values(node)) if (value && typeof value === 'object') visit(value, depth + 1);
  };
  visit(graph, 0);
  let composed = ids.has(packageName);
  if (!composed) {
    try { composed = JSON.stringify(graph).includes(packageName); } catch { /* 循环引用等，忽略 */ }
  }
  return { available: true, composed, ids: [...ids].slice(0, 300) };
}

/**
 * cordis 插件入口。
 * @param {any} ctx
 * @param {object} rawConfig patch 里给的 config
 */
export function apply(ctx, rawConfig = {}) {
  const config = resolveConfig(rawConfig);
  const log = (...args) => { if (config.log) ctx.logger?.info?.('[workbuddy]', ...args); };

  const projectRoot = detectProjectRoot(config.projectRoot);
  const dshPaths = resolveDshPaths();

  // 项目根 `.env` 补默认值：优先级 = 插件 config（显式）> .env > 进程环境变量 > 内置默认。
  // 只在用户**没有显式**在 config 里写这一项时才补，避免覆盖用户意图。
  const explicit = new Set(Object.keys(rawConfig || {}));
  const projectEnv = readProjectEnv(projectRoot);
  const reconcile = (key, envName, coerce) => {
    if (explicit.has(key)) return;
    const raw = projectEnv[envName] ?? process.env[envName];
    if (raw === undefined || raw === '') return;
    config[key] = coerce ? coerce(raw, config[key]) : String(raw);
  };
  reconcile('bridgeHost', 'WORKBUDDY_HOST');
  reconcile('bridgePort', 'WORKBUDDY_PORT', (raw, fallback) => Number(raw) || fallback);
  reconcile('localToken', 'WORKBUDDY_LOCAL_TOKEN');
  reconcile('authFile', 'WORKBUDDY_AUTH_FILE');
  // 控制台端口跟项目自己的 config.mjs 同源（读同一个 DASHBOARD_PORT）
  reconcile('consolePort', 'DASHBOARD_PORT', (raw, fallback) => Number(raw) || fallback);
  if (!explicit.has('autoCheckin') && (projectEnv.WORKBUDDY_AUTO_CHECKIN ?? process.env.WORKBUDDY_AUTO_CHECKIN) !== undefined) {
    config.autoCheckin = asBool(projectEnv.WORKBUDDY_AUTO_CHECKIN ?? process.env.WORKBUDDY_AUTO_CHECKIN, true);
  }

  const supervisor = new BridgeSupervisor({
    projectRoot: projectRoot || process.cwd(),
    host: config.bridgeHost,
    port: config.bridgePort,
    token: config.localToken,
    authFile: config.authFile || '',
    autoCheckin: config.autoCheckin,
    autoStart: config.autoStart,
    nodePath: config.nodePath || undefined,
    timeoutMs: 8000,
    onLog: (line) => log(line),
  });
  const client = new BridgeClient({
    baseUrl: supervisor.baseUrl,
    token: config.localToken,
    timeoutMs: 8000,
  });
  /** 控制台（数据界面）：插件只负责让它常驻 + 给入口，界面本身仍是它自己的。 */
  const consoleSupervisor = new ConsoleSupervisor({
    projectRoot: projectRoot || process.cwd(),
    host: config.consoleHost,
    port: config.consolePort,
    autoStart: config.consoleAutoStart,
    nodePath: config.nodePath || undefined,
    onLog: (line) => log(line),
  });

  /** 运行态：注册结果、错误、迁移记录都放这里，入口页与工具读它。 */
  const state = {
    config,
    projectRoot,
    dshPaths,
    route: { registered: false, provider: config.provider, error: '', fallback: false },
    legacy: { found: false, files: [], detail: [], cleaned: null },
    readyPromise: null,
    lastEnsure: null,
    lastConsoleEnsure: null,
    quotaCache: { at: 0, value: null, error: '', account: null },
    checkinCache: { at: 0, value: null, error: '', account: null },
    checkinInflight: null,
    bridgeAccount: null,
  };

  /**
   * 等某个可选服务就绪后再注册（服务可能比本插件晚挂载）。
   * cordis 的 `ctx.inject(names, cb)` 是标准做法；它不在时退回即时 `get`，
   * 这样纯 Node 的装配测试也能跑。
   */
  const useService = (serviceName, fn) => {
    if (typeof ctx.inject === 'function') {
      ctx.inject([serviceName], (scope) => {
        const service = scope?.[serviceName] ?? scope?.get?.(serviceName);
        if (service) fn(service, scope);
      });
      return;
    }
    const service = ctx.get(serviceName);
    if (service) fn(service, ctx);
  };

  /** 图片附件 → data URL（多模态消息用；失败就退化成文字占位）。 */
  const resolveImage = async (ref) => {
    if (!ref?.attachmentId) return null;
    const attachments = ctx.get('attachments');
    if (!attachments) return null;
    const stored = await attachments.readImage({ attachmentId: ref.attachmentId, mediaType: ref.mediaType });
    const bytes = stored?.data ?? stored?.bytes ?? stored?.buffer;
    if (!bytes) return null;
    const mediaType = stored?.mediaType || ref.mediaType || 'image/png';
    const base64 = Buffer.from(bytes).toString('base64');
    return `data:${mediaType};base64,${base64}`;
  };

  const adapter = new WorkBuddyAdapter({
    provider: config.provider,
    displayName: config.displayName,
    client,
    resolveImage,
    log: (message, detail) => log(message, detail),
    filter: { allow: config.modelAllow, deny: config.modelDeny },
    catalogTtlMs: config.catalogTtlMs,
    ensureReady: async () => {
      // 每次取用前保证桥在跑：桥挂了自动拉起来，用户不必管
      if (!config.autoStart) return client;
      if (state.readyPromise) return state.readyPromise;
      const probe = await supervisor.probe();
      if (probe.state === 'running') return client;
      state.readyPromise = (async () => {
        const result = await supervisor.ensure({ readyTimeoutMs: config.autoStartTimeoutMs });
        state.lastEnsure = { at: Date.now(), ...result };
        if (!result.ok) throw new Error(result.error || '桥不可用');
        adapter.invalidate();
        return client;
      })().finally(() => { state.readyPromise = null; });
      return state.readyPromise;
    },
  });

  // ── 1. 旧路由清理（必须在注册自己的路由之前） ──────────────────────────
  try {
    const detected = detectLegacyRoutes({ settingsPath: dshPaths.settingsPath, patchPath: dshPaths.patchPath, provider: config.provider });
    state.legacy = { ...detected, cleaned: null };
    if (detected.found) {
      if (config.migrateLegacy) {
        const result = cleanLegacyRoutes({ settingsPath: dshPaths.settingsPath, patchPath: dshPaths.patchPath, provider: config.provider });
        // 清理后**重新探测**：否则面板/工具会一直拿着加载时的旧结论报警告
        const after = detectLegacyRoutes({ settingsPath: dshPaths.settingsPath, patchPath: dshPaths.patchPath, provider: config.provider });
        state.legacy = {
          found: after.found,
          files: after.files,
          detail: after.detail,
          cleaned: result,
          cleanedAt: new Date().toISOString(),
        };
        log(`已清理旧的 llm-pi-ai ${config.provider} 路由：`, JSON.stringify(result.files));
      } else {
        log(`检测到旧的 llm-pi-ai ${config.provider} 路由（migrateLegacy=false，未清理）：`, detected.files.join(', '));
      }
    }
  } catch (error) {
    log('旧路由探测失败（不影响启动）', error);
  }

  // ── 2. 注册原生 LLM 路由 ───────────────────────────────────────────────
  // `ctx.llm` 的访问**必须**走属性（服务代理会把 this.ctx 绑到调用方 fiber），
  // 提前取到局部变量再在异步重试里调用，绑定关系保持不变。
  const llm = ctx.llm;
  let adapterHandle = null;

  const registerRoute = (providerName) => {
    adapterHandle = llm.registerAdapter([providerName], adapter);
    state.route = { registered: true, provider: providerName, error: '', fallback: providerName !== config.provider };
    return adapterHandle;
  };

  try {
    registerRoute(config.provider);
    log(`已注册原生模型路由：provider=${config.provider}（${config.displayName}）`);
  } catch (error) {
    const code = error?.code || '';
    state.route = { registered: false, provider: config.provider, error: String(error?.message || error), fallback: false, code };
    log(`注册 provider "${config.provider}" 失败：`, error?.message || error);
    // 撞名的典型原因是 llm-pi-ai 还握着旧路由（热重载需要一点时间），
    // 因此退避重试；仍失败则换一个不撞名的 route，保证功能可用。
    void (async () => {
      for (let attempt = 0; attempt < 6 && !state.route.registered; attempt += 1) {
        await sleep(400);
        try {
          registerRoute(config.provider);
          adapter.invalidate();
          log(`重试成功：provider=${config.provider}`);
          return;
        } catch (retryError) {
          state.route.error = String(retryError?.message || retryError);
        }
      }
      if (state.route.registered) return;
      try {
        registerRoute(config.fallbackProvider);
        log(`provider "${config.provider}" 被占用，已改用 "${config.fallbackProvider}" 兜底（模型选择器里仍显示 ${config.displayName}）`);
      } catch (fallbackError) {
        state.route = {
          registered: false,
          provider: config.provider,
          error: `注册失败：${state.route.error}；兜底 "${config.fallbackProvider}" 也失败：${fallbackError?.message || fallbackError}`,
          fallback: false,
        };
        log(state.route.error);
      }
    })();
  }

  // ── 3. 运行态快照（入口页 / 工具共用） ─────────────────────────────────
  const CHECKIN_TTL_MS = 30 * 60 * 1000;
  const QUOTA_TTL_MS = 120 * 1000;

  /**
   * 桥当前服务的是**哪个账号**。
   *
   * 来源（按可靠度）：/health 的 userId > 令牌剩余与 health.auth 一致性。
   * 拿不到时返回 null（探测未就绪 / 旧桥），调用方此时**不要**误判成"账号变了"。
   */
  function bridgeAccountOf(probe) {
    const userId = probe?.health?.auth?.userId;
    return typeof userId === 'string' && userId ? userId : null;
  }

  /**
   * 账号身份变化时的缓存失效。
   *
   * 这是「换账号后积分还是上一个的」那个 bug 的根治点：控制台切账号只清**它自己**
   * 进程里的缓存（`invalidateQuotaCache()`），插件进程里的 quotaCache（120s）/
   * checkinCache（30min）没人清 —— 面板就会把 A 账号的积分挂在 B 账号头上。
   * 现在所有跨账号的缓存值都打上账号标记，快照时发现身份不一致立即作废并强制重取。
   */
  function reconcileAccount(probe) {
    const account = bridgeAccountOf(probe);
    // 桥还没就绪 / 旧桥没有 userId：保留现状（不能用 null 去作废有效缓存）
    if (account === null) return { changed: false, account: state.bridgeAccount };
    if (state.bridgeAccount === null) {
      // 首次观察到身份：只记录，不清缓存（缓存可能本来就是空的）
      state.bridgeAccount = account;
      return { changed: false, account };
    }
    if (state.bridgeAccount !== account) {
      log(`桥的登录账号已变化（${state.bridgeAccount} → ${account}）：作废积分/签到缓存`);
      state.quotaCache = { at: 0, value: null, error: '', account: null };
      state.checkinCache = { at: 0, value: null, error: '', account: null };
      // 模型目录也属于"账号视角"的数据（不同账号可见模型可能不同）
      adapter.invalidate();
      state.bridgeAccount = account;
      return { changed: true, account };
    }
    return { changed: false, account };
  }

  /**
   * 发起一次签到状态刷新（不 await）。在途去重：并发调用只会打一次上游。
   * 快照里始终返回缓存值，最坏情况是"少一次数据"，绝不会把状态查询拖慢。
   */
  function maybeRefreshCheckin(bridgeState) {
    if (bridgeState !== 'running') return;
    if (state.checkinInflight) return;
    // 缓存里记录的账号与当前账号不一致时必须刷新（换账号后的第一次快照就要新值）
    const stale = state.checkinCache.value && state.checkinCache.account !== state.bridgeAccount;
    if (state.checkinCache.value && !stale && Date.now() - state.checkinCache.at < CHECKIN_TTL_MS) return;
    if (!state.checkinCache.value && Date.now() - state.checkinCache.at < 5_000) return; // 刚失败过，别打爆
    const account = state.bridgeAccount;
    state.checkinInflight = (async () => {
      try {
        const value = await client.checkin({});
        // 只有身份没再变时才入缓存（极端：刷新期间又切了账号）
        if (state.bridgeAccount === account) {
          state.checkinCache = { at: Date.now(), value, error: '', account };
        }
      } catch (error) {
        if (state.bridgeAccount === account) {
          state.checkinCache = { ...state.checkinCache, at: Date.now(), error: String(error?.message || error), account };
        }
      } finally {
        state.checkinInflight = null;
      }
    })();
    // 明确吞掉 rejection：这是后台刷新，失败了只记在缓存里
    state.checkinInflight.catch(() => {});
  }

  async function snapshot({ signal, quota = false } = {}) {
    const probe = await supervisor.probe(signal);
    const consoleProbe = await consoleSupervisor.probe({ signal, cached: true });
    // 先对账号：身份变了就作废全部跨账号缓存（含模型目录）
    const reconciliation = reconcileAccount(probe);
    let quotaValue = state.quotaCache.value;
    let quotaError = state.quotaCache.error;
    const staleQuota = state.quotaCache.value && state.quotaCache.account !== state.bridgeAccount;
    const wantQuota = quota
      || !state.quotaCache.value
      || staleQuota
      || Date.now() - state.quotaCache.at > QUOTA_TTL_MS;
    if (probe.state === 'running' && wantQuota) {
      try {
        quotaValue = await client.quota(signal);
        // 身份没再变才入缓存（避免"取的是新账号、标记却是旧账号"的错位）
        if (state.bridgeAccount === reconciliation.account) {
          state.quotaCache = { at: Date.now(), value: quotaValue, error: '', account: reconciliation.account };
        }
        quotaError = '';
      } catch (error) {
        quotaError = String(error?.message || error);
        if (state.bridgeAccount === reconciliation.account) {
          state.quotaCache = { ...state.quotaCache, at: Date.now(), error: quotaError, account: reconciliation.account };
        }
      }
    }
    // 签到状态：TTL 30 分钟，而且**绝不阻塞** status。
    //
    // 这个接口会打到上游计费端点，而 /workbuddy/status 每 8 秒就要应答一次；
    // 一旦上游慢，await 它会把状态页一起拖住。所以这里只"发起"刷新（带在途
    // 去重），快照永远返回当前缓存值 —— 下一次快照自然拿到新值。
    maybeRefreshCheckin(probe.state);
    const catalog = adapter.catalogCache.models;
    return {
      bridge: { state: probe.state, health: probe.health || null, error: probe.error || '' },
      /** 控制台：数据界面在它那儿，插件只报状态与地址。 */
      console: {
        state: consoleProbe.state,
        url: consoleSupervisor.url,
        error: consoleProbe.error || '',
        /** true = 这个实例是插件拉起的（插件有权停它） */
        managed: consoleSupervisor.spawnedPid !== null,
        autoStart: config.consoleAutoStart,
      },
      config: {
        provider: state.route.provider,
        configuredProvider: config.provider,
        fallbackProvider: config.fallbackProvider,
        displayName: config.displayName,
        bridgeUrl: supervisor.baseUrl,
        consoleUrl: consoleSupervisor.url,
        projectRoot,
        autoStart: config.autoStart,
        consoleAutoStart: config.consoleAutoStart,
        migrateLegacy: config.migrateLegacy,
        logPath: supervisor.logPath,
        scriptPath: supervisor.scriptPath,
        modelAllow: config.modelAllow,
        modelDeny: config.modelDeny,
      },
      route: { ...state.route },
      directory: toDirectory(catalog),
      catalogAt: adapter.catalogCache.at ? new Date(adapter.catalogCache.at).toISOString() : null,
      catalogError: adapter.catalogError || '',
      legacy: { found: state.legacy.found, files: state.legacy.files, cleaned: state.legacy.cleaned },
      quota: quotaValue,
      quotaError,
      /** 上次成功读到积分的时刻（ISO）；面板用它显示"更新于" */
      quotaAt: state.quotaCache.at ? new Date(state.quotaCache.at).toISOString() : null,
      /** 这份积分属于哪个账号（health.auth.userId）；与 bridgeAccount 不一致说明缓存还没换新 */
      quotaAccount: state.quotaCache.account,
      /** 桥当前登录的账号（本快照探测到的）——重启 dsh 后可在面板核对它与 quotaAccount 一致 */
      bridgeAccount: state.bridgeAccount,
      checkin: state.checkinCache.value,
      checkinError: state.checkinCache.error || '',
      checkinAccount: state.checkinCache.account,
      dsh: { home: dshPaths.home, profileDir: dshPaths.profileDir, settingsPath: dshPaths.settingsPath, patchPath: dshPaths.patchPath },
      client: clientGraphSummary(ctx.get('clientModules')),
      runtime: { node: process.version, pid: process.pid, pluginDir: PLUGIN_DIR },
      sampleModel: pickDefaultModel(catalog),
    };
  }

  // ── 4. 工具 ────────────────────────────────────────────────────────────
  if (config.tools) {
    useService('tools', (tools) => {
      let count = 0;
      for (const definition of createTools({ snapshot, supervisor, consoleSupervisor, client, adapter })) {
        try {
          tools.register(definition);
          count += 1;
        } catch (error) {
          log(`注册工具 ${definition.name} 失败`, error);
        }
      }
      log(`已注册 ${count} 个工具（workbuddy_status/models/usage/checkin/bridge）`);
    });
  }

  // ── 5. 斜杠命令 ────────────────────────────────────────────────────────
  if (config.commands) {
    useService('commands', (commands) => {
      try {
        commands.register({
          name: 'workbuddy',
          description: 'WorkBuddy 中转：状态 / 模型 / 用量 / 签到 / 启停桥 / 打开控制台 / 清理旧路由',
          input: { hint: 'status | models | usage | checkin | console | start | stop | restart | cleanup' },
          async handler({ rawInput, signal }) {
            const arg = String(rawInput || '').trim().split(/\s+/)[0] || 'status';
            try {
              if (arg === 'console' || arg === 'ui') {
                const result = await consoleSupervisor.ensure({ signal });
                return result.ok
                  ? { kind: 'success', text: `控制台已就绪：${consoleSupervisor.url}${result.reused ? '（复用已在运行的实例）' : '（本次新拉起）'}\n逐条请求、趋势图、CSV 导出、账号切换、签到与诊断都在那里。` }
                  : { kind: 'error', text: `控制台启动失败：${result.error}` };
              }
              if (arg === 'start' || arg === 'restart') {
                const result = await supervisor.ensure({ restart: arg === 'restart', signal });
                adapter.invalidate();
                return result.ok
                  ? { kind: 'success', text: `桥已就绪：${supervisor.baseUrl}/v1（pid ${result.health?.pid}${result.reused ? '，复用已有实例' : ''}）` }
                  : { kind: 'error', text: `桥启动失败：${result.error}` };
              }
              if (arg === 'stop') {
                const result = await supervisor.stop(signal);
                adapter.invalidate();
                return result.ok
                  ? { kind: 'success', text: result.stopped ? '桥已停止。' : '桥本来就没在运行。' }
                  : { kind: 'error', text: `停止失败：${result.error}` };
              }
              if (arg === 'cleanup') {
                const detected = detectLegacyRoutes({ settingsPath: dshPaths.settingsPath, patchPath: dshPaths.patchPath, provider: config.provider });
                if (!detected.found) return { kind: 'success', text: '没有检测到旧的 llm-pi-ai workbuddy 路由，无需清理。' };
                const result = cleanLegacyRoutes({ settingsPath: dshPaths.settingsPath, patchPath: dshPaths.patchPath, provider: config.provider });
                const lines = result.files.map((f) => `${f.path}：${f.changed ? `已清理（备份 ${f.backup}）` : f.reason}`);
                return { kind: 'success', text: `旧路由清理完成：\n${lines.join('\n')}` };
              }
              if (arg === 'models') {
                const catalog = await adapter.catalog({ signal });
                const lines = catalog.slice(0, 40).map((m) => `- ${m.id}${m.name ? `（${m.name}）` : ''}`);
                return { kind: 'success', text: `可用模型 ${catalog.length} 个：\n${lines.join('\n')}${catalog.length > 40 ? '\n…' : ''}` };
              }
              if (arg === 'usage') {
                const usage = await client.usage({ days: 7, signal });
                const total = usage?.total || {};
                return { kind: 'success', text: `最近 7 天：${total.calls || 0} 次调用，失败 ${total.failed || 0} 次，输入 ${total.promptTokens || 0} / 输出 ${total.completionTokens || 0} tokens，积分 ${typeof total.credit === 'number' ? total.credit.toFixed(2) : 0}` };
              }
              if (arg === 'checkin') {
                const result = await client.checkin({ signal });
                const s = result?.status || {};
                return { kind: 'success', text: `签到：${s.todayCheckedIn ? '今日已签' : '今日未签'}${typeof s.streakDays === 'number' ? `，连续 ${s.streakDays} 天` : ''}` };
              }
              const snap = await snapshot({ signal, quota: true });
              const lines = [
                `桥：${snap.bridge.state}${snap.bridge.health ? `（pid ${snap.bridge.health.pid}，已运行 ${Math.round((snap.bridge.health.uptimeMs || 0) / 60000)} 分钟）` : ''}`,
                `地址：${snap.config.bridgeUrl}/v1`,
                `路由：${snap.route.registered ? `已注册 provider=${snap.route.provider}` : `未注册（${snap.route.error}）`}`,
                `模型：桥目录 ${snap.directory.length} 个`,
                `控制台：${snap.console.state === 'running' ? snap.console.url : `未运行（${snap.console.error || '未启动'}）`}`,
                snap.quota?.total !== undefined ? `积分：${snap.quota.total}` : '',
                snap.legacy.found ? `注意：仍有旧路由 ${snap.legacy.files.join('、')}（用 /workbuddy cleanup 清理）` : '',
              ].filter(Boolean);
              return { kind: 'success', text: lines.join('\n') };
            } catch (error) {
              return { kind: 'error', text: `执行失败：${error?.message || error}` };
            }
          },
        });
        log('已注册 /workbuddy 命令');
      } catch (error) {
        log('注册 /workbuddy 命令失败', error);
      }
    });
  }

  // ── 6. HTTP 数据面（入口页用） ─────────────────────────────────────────
  if (config.routes) {
    useService('webServer', (webServer) => {
      const routes = createRouteTable({ snapshot, supervisor, consoleSupervisor, client, adapter, paths: dshPaths, provider: config.provider, log });
      const disposeRoutes = mountRoutes(webServer, routes, log);
      ctx.effect(() => disposeRoutes, 'workbuddy.panel-routes');
    });
  }

  // ── 7. 后台把桥与控制台拉起来（不阻塞插件加载） ────────────────────────
  if (config.autoStart) {
    void (async () => {
      try {
        const result = await supervisor.ensure({ readyTimeoutMs: config.autoStartTimeoutMs });
        state.lastEnsure = { at: Date.now(), ...result };
        if (result.ok) {
          adapter.invalidate();
          log(`桥已就绪：${supervisor.baseUrl}/v1（pid ${result.health?.pid}${result.reused ? '，复用已有实例' : '，本次新拉起'}）`);
        } else {
          log(`桥未能就绪：${result.error}`);
        }
      } catch (error) {
        log('自动启动桥失败', error);
      }
    })();
  }
  if (config.consoleAutoStart) {
    void (async () => {
      try {
        const result = await consoleSupervisor.ensure({});
        state.lastConsoleEnsure = { at: Date.now(), ...result };
        log(result.ok
          ? `控制台已就绪：${consoleSupervisor.url}${result.reused ? '（复用已在运行的实例）' : '（本次新拉起）'}`
          : `控制台未能就绪：${result.error}`);
      } catch (error) {
        log('自动启动控制台失败', error);
      }
    })();
  }

  log(`插件已加载：projectRoot=${projectRoot || '(未找到)'} bridge=${supervisor.baseUrl} console=${consoleSupervisor.url} provider=${state.route.provider}`);
  return { supervisor, consoleSupervisor, client, adapter, state, snapshot };
}

export default { name, inject, apply, DEFAULTS, resolveConfig, detectProjectRoot };
