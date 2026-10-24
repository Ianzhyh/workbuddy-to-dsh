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

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BridgeClient, BridgeSupervisor, BRIDGE_SCRIPT_REL } from './bridge.mjs';
import { ConsoleSupervisor } from './console.mjs';
import { WorkBuddyAdapter } from './adapter.mjs';
import { toDirectory, pickDefaultModel } from './models.mjs';
import { createTools } from './tools.mjs';
import { createRouteTable, mountRoutes } from './routes.mjs';
import {
  configureWorkBuddyWebSearch,
  deriveWebSearchReadiness,
  deriveWebSearchStatus,
  restoreWorkBuddyWebSearch,
  snapshotWorkBuddyWebSearch,
  verifyWorkBuddyWebSearch,
} from './web-search-config.mjs';
import { cleanLegacyRoutes, detectLegacyRoutes } from './legacy.mjs';
import { PLUGIN_PACKAGE_NAMES } from './packageNames.mjs';

export const name = 'workbuddy';
/** 硬依赖 llm：没有它就没有「原生路由」这件事，插件保持不激活比半激活好。 */
export const inject = ['llm'];

const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 面板偏好的**稳定位置**：`<DSH_HOME>/workbuddy-model-prefs.json`。
 *
 * 旧版本写在插件目录旁（安装形态下是 profile 的 node_modules 内）。重装
 * 插件或清 pnpm 缓存会把那个文件一起抹掉，用户会静默回到官方默认（实测
 * 场景：面板里把 deepseek 调到 1M，重装后又变回 300K）。因此默认写
 * DSH_HOME；插件目录里的旧文件在读取时自动迁移过来。
 */
const MODEL_PREFS_PATH = join(
  process.env.DSH_HOME || join(homedir(), '.dsh'),
  'workbuddy-model-prefs.json',
);
/**
 * 旧位置（只读 + 迁移，不再作为首选写入位置）。
 *
 * 兼容已安装用户的旧文件：读取时若它比稳定位置新，就复制一份到 DSH_HOME；
 * 写入时仅在稳定位置不可写时才回退到这里（至少不让用户这次保存丢失）。
 */
const LEGACY_MODEL_PREFS_PATH = join(PLUGIN_DIR, '.model-prefs.json');
const modelPrefsPaths = () => [MODEL_PREFS_PATH, LEGACY_MODEL_PREFS_PATH];

/** 解析一份偏好文件；格式不对返回 null（由调用方继续尝试回退位置）。 */
function parseModelPrefs(raw) {
  const j = JSON.parse(raw);
  if (!j || typeof j !== 'object') return null;
  const paramsByModel = j.paramsByModel && typeof j.paramsByModel === 'object' && !Array.isArray(j.paramsByModel)
    ? j.paramsByModel
    : {};
  const hasDisplay = Array.isArray(j.visible) || j.hideAll === true || typeof j.includeUnofficial === 'boolean';
  // 每模型上下文预算（缺条目 = 跟随官方默认）
  const contextWindowByModel = {};
  if (j.contextWindowByModel && typeof j.contextWindowByModel === 'object' && !Array.isArray(j.contextWindowByModel)) {
    for (const [id, raw] of Object.entries(j.contextWindowByModel)) {
      const n = Number(raw);
      if (id && Number.isSafeInteger(n) && n > 0) contextWindowByModel[id] = n;
    }
  }
  // 只有"每个模型的默认参数"、没有显示偏好时也要能读回来
  if (!hasDisplay && !Object.keys(contextWindowByModel).length && !Object.keys(paramsByModel).length) return null;
  const visible = Array.isArray(j.visible) ? j.visible.map(String).filter(Boolean) : null;
  return {
    // visible=null 且 hideAll=false = 显示跟随配置（"恢复全部"就是写这个状态）
    visible,
    // 兼容旧文件：老面板的"全不选"写的也是空数组，且当时提示语承诺"全隐藏"
    hideAll: j.hideAll === true || (Array.isArray(j.visible) && visible.length === 0 && j.hideAll !== false),
    // 是否把"官方目录外"的模型也放进 dsh 选择器（默认 false）
    includeUnofficial: j.includeUnofficial === true,
    // 每模型上下文预算（缺条目 = 跟随官方默认/桥目录）
    contextWindowByModel,
    paramsByModel,
    /** 写入时刻：稳定位置与旧插件目录都有一份时取更新的那份。 */
    at: Number(j.at) || 0,
  };
}

/**
 * 从一组候选路径读取偏好（按 `at` 取最新），并在需要时把旧位置迁移到
 * 首个路径（稳定位置）。导出给测试用；生产调用 `readModelPrefs()`。
 *
 * **`visible: []` 与"没有偏好"必须分开**：前者是用户点了"全不选"，意思是
 * 一个都不显示；后者是"没设置过"，意思是全显示。旧实现把两者混为一谈，
 * 于是"全不选 → 保存"后 dsh 里反而全部还在。
 */
export function readModelPrefsFrom(paths) {
  let best = null;
  let bestFile = '';
  for (const file of paths) {
    if (!existsSync(file)) continue;
    try {
      const parsed = parseModelPrefs(readFileSync(file, 'utf8'));
      if (!parsed) continue;
      // 两处都有一份时（旧插件目录 + 新 DSH_HOME），按写入时刻取更新的一份。
      if (!best || (parsed.at || 0) > (best.at || 0)) {
        best = parsed;
        bestFile = file;
      }
    } catch { /* 损坏：尝试下一个位置 */ }
  }
  if (best && bestFile !== paths[0]) {
    /*
     * 旧位置（插件目录）的偏好更新：复制到稳定位置。重装/清缓存后旧文件
     * 会消失，但稳定位置的副本还在，用户不会静默回到默认值。
     * 迁移失败不阻断读取：本次仍用旧文件，下次再试。
     */
    try {
      writeModelPrefsTo([paths[0]], best);
    } catch (error) {
      console.warn(`[workbuddy] 模型偏好迁移到 ${paths[0]} 失败：${error?.message || error}`);
    }
  }
  return best;
}

/**
 * 写入一组候选路径（首个成功即返回）。
 * 导出给测试用；生产调用 `writeModelPrefs()`。
 * `prefs === null` = 清除偏好（删除所有候选文件）。
 */
export function writeModelPrefsTo(paths, prefs) {
  if (prefs === null) {
    for (const file of paths) {
      try { if (existsSync(file)) unlinkSync(file); } catch { /* 尽力清理 */ }
    }
    return;
  }
  const paramsByModel = prefs?.paramsByModel && typeof prefs.paramsByModel === 'object' ? prefs.paramsByModel : {};
  const visible = Array.isArray(prefs?.visible) ? prefs.visible.map(String).filter(Boolean) : null;
  const hideAll = prefs?.hideAll === true;
  const includeUnofficial = prefs?.includeUnofficial === true;
  const contextWindowByModel = {};
  const rawContext = prefs?.contextWindowByModel;
  if (rawContext && typeof rawContext === 'object' && !Array.isArray(rawContext)) {
    for (const [id, raw] of Object.entries(rawContext)) {
      const n = Number(raw);
      if (id && Number.isSafeInteger(n) && n > 0) contextWindowByModel[id] = n;
    }
  }
  // 显示"未设置"且没有每模型参数/上下文预算 → 没有可存的东西，删文件更干净
  if (visible === null && !hideAll && !includeUnofficial
    && !Object.keys(contextWindowByModel).length && !Object.keys(paramsByModel).length) {
    for (const file of paths) {
      try { if (existsSync(file)) unlinkSync(file); } catch { /* 尽力清理 */ }
    }
    return;
  }
  const body = `${JSON.stringify({ visible, hideAll, includeUnofficial, contextWindowByModel, paramsByModel, at: Date.now() }, null, 2)}\n`;
  let firstError = null;
  for (const file of paths) {
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, body, 'utf8');
      return;
    } catch (error) {
      if (!firstError) firstError = error;
    }
  }
  throw new Error(`模型显示设置无法落盘：${firstError?.message || '未知原因'}`);
}

/** 读取面板偏好（稳定位置优先，旧位置自动迁移）。 */
export function readModelPrefs() {
  return readModelPrefsFrom(modelPrefsPaths());
}

/** 写偏好（稳定位置优先，失败才回退旧位置；两处都失败会抛错）。 */
export function writeModelPrefs(prefs) {
  return writeModelPrefsTo(modelPrefsPaths(), prefs);
}

/**
 * 读控制台写下的账号钉住状态（`.state.json`）。
 *
 * 插件与插件自带控制台共用同一个项目根；面板「切换账号」写的是这里。
 * 插件拉起桥时必须带上同一份 `authFile` + 桌面 UID，否则会出现：
 * 控制台按 A 账号启动、dsh 重启后插件按默认文件启动 —— 两边各服务一个账号。
 *
 * 只读两个字段，**不写**这份文件（它的唯一写者是控制台）。
 */
function readBridgeAccountState(projectRoot) {
  const file = process.env.WORKBUDDY_STATE_FILE || (projectRoot ? join(projectRoot, '.state.json') : '');
  if (!file) return { authFile: '', desktopUid: '' };
  try {
    const state = JSON.parse(readFileSync(file, 'utf8'));
    return {
      authFile: typeof state?.authFile === 'string' ? state.authFile : '',
      desktopUid: typeof state?.authFileDesktopUid === 'string' ? state.authFileDesktopUid : '',
    };
  } catch {
    return { authFile: '', desktopUid: '' };
  }
}

/**
 * 本地回环令牌的持久化位置。
 *
 * 为什么需要它：插件启动桥时会**显式注入** `WORKBUDDY_LOCAL_TOKEN`，所以
 * 令牌值从哪来决定了安全强度。历史默认值是硬编码的 `wb-local-bridge` ——
 * 一个公开口令，本机任何程序（包括网页里的脚本，只要绕开 Origin 检查）
 * 都能用它白嫖账号配额。改成随机生成后又带来新问题：**每次重启都换值**，
 * 用户已经填进客户端的密钥就全失效了。两难只能靠落盘解决：
 * 首次随机生成 → 存这里 → 后续复用同一个值。
 *
 * 权限：**只有当前用户可读**。POSIX 上靠 `mode: 0o600`，Windows 上 `mode` 无效，
 * 由 `hardenBridgeTokenFile()` 用 icacls 收紧 —— 别只看那一行 `mode` 就以为安全了。
 * 文件里是本地回环口令，泄漏不等于泄漏上游
 * 凭据，但也没有理由让同机其它用户读到。
 */
const BRIDGE_TOKEN_PATH = join(PLUGIN_DIR, '.bridge-token');

/** 读取已持久化的令牌；没有 / 读不通都返回 ''。 */
function readBridgeToken() {
  try {
    const text = readFileSync(BRIDGE_TOKEN_PATH, 'utf8').trim();
    // 同样的正则在仓库根的 `config.mjs:218` 还有一份 —— 改动时两处一起改，
    // 否则会出现「桥认、插件不认」的怪现象。
    return /^[A-Za-z0-9._-]{16,}$/.test(text) ? text : '';
  } catch { return ''; }
}

/**
 * 取本地回环令牌：env/config 显式给了就用给的，否则读盘，再否则**生成并落盘**。
 *
 * 用 `randomBytes` 而不是 `Math.random()`：后者不是密码学随机，令牌可预测
 * 就失去了「防同机误用」的意义。24 字节 base64url ≈ 192 位熵。
 */
function resolveLocalToken(rawToken) {
  const explicit = typeof rawToken === 'string' ? rawToken.trim() : '';
  if (explicit) {
    /*
     * 令牌是配置显式给的 → 根本没落到磁盘上，也就没有「文件同机可读」这回事。
     * 必须**显式复位**这个状态：不复位的话它会是上一次调用的残留值，
     * 面板上就会报一个与当前配置不符的结论。
     */
    bridgeTokenHardenResult = { ok: true, code: 'skipped', reason: '令牌由配置显式给定，未落盘，无需加固' };
    return explicit;
  }
  const stored = readBridgeToken();
  if (stored) {
    bridgeTokenHardenResult = hardenBridgeTokenFile(); // 旧版本创建的文件权限是继承来的，这里补一次
    return stored;
  }
  const token = randomBytes(24).toString('base64url');
  try {
    writeFileSync(BRIDGE_TOKEN_PATH, `${token}\n`, { mode: 0o600 });
    bridgeTokenHardenResult = hardenBridgeTokenFile();
  } catch { /* 只读介质：本次运行用这个值，下次会换新的（用户需重填密钥） */ }
  return token;
}

/**
 * 把令牌文件收成「只有当前用户能读」。
 *
 * **`writeFileSync({ mode: 0o600 })` 在 Windows 上不起作用**：那个 `mode` 只在
 * POSIX 上有意义，Windows 走 NTFS ACL，`mode` 基本被忽略。实测新建出来的文件
 * 继承目录权限，结果是 `Authenticated Users:(M)` + `Users:(RX)` ——
 * **同机任何用户都能读到令牌**。上面那句「权限：0600（仅本人可读）」在 Windows
 * 上是不成立的，这个函数才是让它成立的地方。
 *
 * 与 `config.mjs` 里那份是同一套做法（插件包不引用仓库根的 config，
 * 所以各自持有一份小实现，改动时两处要一起看）。
 * 尽力而为：拿不到就保持默认，绝不因此让插件启动失败 —— **但失败必须报出来**，
 * 见返回值。原先写成 `try { spawnSync(...) } catch {}`，等于没看结果：
 * `spawnSync` 失败**不抛异常**，它把失败放进 `r.error` / `r.status`。
 * 于是「icacls 没跑成」与「跑成了」在调用方看来一模一样，文件权限其实没收紧
 * 也没有任何地方会提到 —— 这类「静默失效」是本项目最该避免的。
 *
 * @returns {{ ok: boolean, code: 'ok'|'no-user'|'spawn-failed'|'icacls-failed'|'exception', reason?: string }}
 */
function hardenBridgeTokenFile() {
  try {
    if (process.platform !== 'win32') {
      chmodSync(BRIDGE_TOKEN_PATH, 0o600);
      return { ok: true, code: 'ok' };
    }
    const user = process.env.USERNAME || process.env.USER;
    if (!user) {
      return { ok: false, code: 'no-user', reason: 'USERNAME / USER 都为空，无法指定 ACL 主体' };
    }
    /*
     * 用 spawnSync 而不是 execSync：后者经 cmd.exe 且默认给 stdin 开管道，
     * 在 Windows 上必抛 EBUSY。
     *
     * `stdio[0]` 必须是 `'ignore'` —— **这条才是关键**。默认三个 `'pipe'` 时
     * stdin 也走管道，实测在本机每次调用都返回 `{ error: EBUSY }`：
     *   默认 stdio（stdin 管道）  → 22/22 失败
     *   `stdio[0]: 'ignore'`      → 0/22 失败
     * 也就是说「连打同一个可执行文件会 EBUSY」是误判，真正的触发条件是这个管道。
     */
    const r = spawnSync('icacls', [BRIDGE_TOKEN_PATH, '/inheritance:r', '/grant:r', `${user}:F`],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    if (r.error) {
      return { ok: false, code: 'spawn-failed', reason: `icacls 起不来：${r.error.code || r.error.message}` };
    }
    if (r.status !== 0) {
      const first = String(r.stderr || '').trim().split('\n')[0];
      return {
        ok: false,
        code: 'icacls-failed',
        reason: `icacls 退出码 ${r.status}${first ? `：${first}` : ''}`,
      };
    }
    return { ok: true, code: 'ok' };
  } catch (e) {
    return { ok: false, code: 'exception', reason: e?.message || String(e) };
  }
}

/**
 * 最近一次令牌文件加固的结果。`resolveConfig()` 每次都会调 `resolveLocalToken()`，
 * 所以这个值随配置一起更新；`resolveConfig()` 把它作为 `localTokenHarden` 返回，
 * 让面板/诊断能说清「令牌文件到底有没有收紧」。
 */
let bridgeTokenHardenResult = { ok: false, code: 'exception', reason: '尚未执行（令牌由配置显式给定时会跳过）' };

/** 默认值集中在一处，README 与面板都读它。 */
export const DEFAULTS = {
  projectRoot: '',
  bridgeHost: '127.0.0.1',
  bridgePort: 8790,
  /**
   * 留空 = 首次运行生成随机令牌并持久化到 `.bridge-token`。
   *
   * **不要**在这里写死一个具体值：DEFAULTS 会被文档、面板、生成配置片段
   * 多处引用，写死等于把一个公开口令散播到所有地方 —— 这正是要修的问题。
   */
  localToken: '',
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
  /** 设备码登录默认区域（cn / global）；桥侧也可用 WORKBUDDY_LOGIN_REGION 覆盖。 */
  loginRegion: 'cn',
  /**
   * 凭据来源：'' = 不锁定（桥默认 auto，UI 可切换）/ auto（软默认）/
   * desktop / plugin / api-key（后三者锁定）。
   * 只有显式配置时才注入 WORKBUDDY_CREDENTIAL_SOURCE —— 把默认 auto 注入过去
   * 没有意义，还会让"登录成功后切到插件"看起来像被环境变量挡住。
   */
  credentialSource: '',
  /** 凭据存储：'' = 平台默认（Windows dpapi，其余 memory）；可显式写 dpapi / memory。 */
  credentialStore: '',
  /** 凭据目录：'' = 桥按用户目录推导；显式写则必须可写。 */
  credentialDir: '',
  /** 桥「已确认活着」结论的缓存时长（ensureReady 短路用）。对话失败会立即作废。 */
  bridgeAliveTtlMs: 5_000,
  modelAllow: [],
  modelDeny: [],
  /**
   * 给 agent 实际调用模型时的默认参数（对话测试面板另有独立的即时控制）。
   * undefined = 不下发该字段，交给上游默认 —— 刻意不猜：不同模型对
   * reasoning_effort 的接受度不同，硬发可能 400。
   */
  defaultMaxTokens: undefined,
  defaultTemperature: undefined,
  defaultReasoningEffort: undefined,
  /**
   * 空闲看门狗（毫秒，0 = 关）：只抓"上游多久没吐数据"，不看总时长，
   * 所以不会误杀长回答。默认 5 分钟 —— 与首字节超时互补，覆盖“流到一半停了”
   * 这种永久 loading；显式配 0 可关闭。
   */
  streamIdleTimeoutMs: 300_000,
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
    localToken: resolveLocalToken(cfg.localToken),
    /*
     * 令牌文件权限加固的结果（`{ok, code, reason}`）。加固是「尽力而为、不阻断
     * 启动」，但**失败必须能被看见** —— 否则「文件其实同机可读」这件事在整条
     * 链路上没有任何地方会提到。放在 resolveConfig 的返回值里，面板/诊断可读。
     */
    localTokenHarden: bridgeTokenHardenResult,
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
    loginRegion: ['cn', 'global'].includes(String(cfg.loginRegion)) ? String(cfg.loginRegion) : DEFAULTS.loginRegion,
    credentialSource: ['auto', 'desktop', 'plugin', 'api-key'].includes(String(cfg.credentialSource))
      ? String(cfg.credentialSource) : DEFAULTS.credentialSource, // '' = 不锁定
    credentialStore: ['dpapi', 'memory'].includes(String(cfg.credentialStore)) ? String(cfg.credentialStore) : '',
    credentialDir: String(cfg.credentialDir || ''),
    bridgeAliveTtlMs: Number(cfg.bridgeAliveTtlMs) || DEFAULTS.bridgeAliveTtlMs,
    modelAllow: asStringArray(cfg.modelAllow),
    modelDeny: asStringArray(cfg.modelDeny),
    defaultMaxTokens: cfg.defaultMaxTokens === undefined || cfg.defaultMaxTokens === null || cfg.defaultMaxTokens === ''
      ? undefined
      : (Number(cfg.defaultMaxTokens) > 0 ? Number(cfg.defaultMaxTokens) : undefined),
    defaultTemperature: cfg.defaultTemperature === undefined || cfg.defaultTemperature === null || cfg.defaultTemperature === ''
      ? undefined
      : (Number.isFinite(Number(cfg.defaultTemperature)) ? Number(cfg.defaultTemperature) : undefined),
    // 六档都允许设默认：旧实现只认 low/medium/high，选 minimal/xhigh/max 的
    // 用户配了也等于没配（dsh 选择器明明有这些档）。档位是否被具体模型接受，
    // 交给桥的实测表与适配器的"不猜"原则，不在这里提前砍掉。
    defaultReasoningEffort: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(String(cfg.defaultReasoningEffort))
      ? String(cfg.defaultReasoningEffort)
      : undefined,
    streamIdleTimeoutMs: Number(cfg.streamIdleTimeoutMs) > 0 ? Number(cfg.streamIdleTimeoutMs) : 0,
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

/**
 * 从 `.env` / 进程环境透传给**插件拉起的桥**的非机密变量。
 *
 * 插件是独立进程：它读了 `.env` 不代表桥读得到。这里只列模型调用可靠性相关
 * 的开关；凭据、令牌、API key 一律不在此列，避免把秘密复制进子进程环境。
 */
export const BRIDGE_ENV_PASSTHROUGH = Object.freeze([
  // 插件登录身份
  'WORKBUDDY_PLUGIN_IDENTITY',
  'WORKBUDDY_PLUGIN_APP_VERSION_CN',
  'WORKBUDDY_PLUGIN_APP_VERSION_GLOBAL',
  'WORKBUDDY_CREDENTIAL_FAILOVER',
  'WORKBUDDY_LOGIN_UA',
  'WORKBUDDY_LOGIN_BASE',
  'WORKBUDDY_LOGIN_ORIGIN',
  // 桌面端出站身份（上游版本漂移时的逃生门）
  'WORKBUDDY_APP_VERSION',
  'WORKBUDDY_IDE_VERSION',
  'WORKBUDDY_IDE_NAME',
  // 11128 / 预校验 / 诊断
  'WORKBUDDY_11128_FALLBACK',
  'WORKBUDDY_SKIP_MODEL_PREFLIGHT',
  'WORKBUDDY_CONTEXT_WINDOW',
  'WORKBUDDY_SHAPE',
  // 超时、连接池、重试
  'WORKBUDDY_TIMEOUT_MS',
  'WORKBUDDY_FIRST_BYTE_TIMEOUT_MS',
  'WORKBUDDY_QUEUE_TIMEOUT_MS',
  'WORKBUDDY_MAX_SOCKETS',
  'WORKBUDDY_5XX_RETRY',
  'WORKBUDDY_5XX_RETRY_DELAY_MS',
  'WORKBUDDY_TRANSIENT_400_RETRY',
  'WORKBUDDY_TRANSIENT_400_DELAYS',
  'WORKBUDDY_TRANSPORT_RETRY_MS',
  'WORKBUDDY_429_WAITS',
  'WORKBUDDY_KEEPALIVE_MS',
  'WORKBUDDY_LOG',
  'WORKBUDDY_MAX_BODY_BYTES',
  'WORKBUDDY_ACTIVE_ALERT_MS',
  'WORKBUDDY_RATE_LIMIT_RPM',
  'WORKBUDDY_RATE_LIMIT_MIN_INTERVAL_MS',
  'WORKBUDDY_RATE_LIMIT_MODE',
  // 另外两条协议默认模型（其它客户端用）
  'WORKBUDDY_ANTHROPIC_MODEL',
  'WORKBUDDY_ANTHROPIC_FAST_MODEL',
  'WORKBUDDY_RESPONSES_MODEL',
  'WORKBUDDY_RESPONSES_FAST_MODEL',
  // 原生网页搜索（/v1/web_search 与 /v1/messages 的 web_search_20250305）
  'WORKBUDDY_SEARCH_BASE',
  'WORKBUDDY_SEARCH_VERSION',
  'WORKBUDDY_SEARCH_TIMEOUT_MS',
  'WORKBUDDY_SEARCH_MAX_RESULTS',
]);

export function collectBridgeExtraEnv(projectEnv = {}, env = process.env) {
  const out = {};
  for (const key of BRIDGE_ENV_PASSTHROUGH) {
    const value = projectEnv[key] ?? env[key];
    if (value !== undefined && value !== '') out[key] = String(value);
  }
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
export function clientGraphSummary(clientModules, packageName = PLUGIN_PACKAGE_NAMES) {
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
  // 包名不是一个固定值：单文件夹分发是 dsh-plugin-workbuddy，github 直装是
  // workbuddy-to-dsh。只认其中一个会让另一种形态的诊断永远显示「未组装」。
  const wanted = (Array.isArray(packageName) ? packageName : [packageName]).filter(Boolean);
  let composed = wanted.some((name) => ids.has(name));
  if (!composed) {
    try {
      const text = JSON.stringify(graph);
      composed = wanted.some((name) => text.includes(name));
    } catch { /* 循环引用等，忽略 */ }
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
  reconcile('credentialSource', 'WORKBUDDY_CREDENTIAL_SOURCE');
  reconcile('credentialStore', 'WORKBUDDY_CREDENTIAL_STORE');
  reconcile('credentialDir', 'WORKBUDDY_CREDENTIAL_DIR');
  reconcile('loginRegion', 'WORKBUDDY_LOGIN_REGION');
  // 控制台端口跟项目自己的 config.mjs 同源（读同一个 DASHBOARD_PORT）
  reconcile('consolePort', 'DASHBOARD_PORT', (raw, fallback) => Number(raw) || fallback);
  if (!explicit.has('autoCheckin') && (projectEnv.WORKBUDDY_AUTO_CHECKIN ?? process.env.WORKBUDDY_AUTO_CHECKIN) !== undefined) {
    config.autoCheckin = asBool(projectEnv.WORKBUDDY_AUTO_CHECKIN ?? process.env.WORKBUDDY_AUTO_CHECKIN, true);
  }

  // 桥的上游身份/超时/11128/预校验等逃生门：`.env` 里写了必须真的到桥。
  const bridgeExtraEnv = collectBridgeExtraEnv(projectEnv, process.env);

  /*
   * 与控制台共用账号选择：
   *   - 面板切换过账号 → `.state.json` 里是钉住的快照，同时带「钉住那一刻桌面端是谁」；
   *   - 没切换过 → 用 .env/配置里的 authFile（通常为空 = 桥自己探测默认登录文件）。
   * 插件原先只传 config.authFile，导致 dsh 拉起的桥完全不认面板的选择（issue #6）。
   */
  const initialAccountState = readBridgeAccountState(projectRoot);
  const followDesktop = Boolean(initialAccountState.authFile);
  const supervisor = new BridgeSupervisor({
    projectRoot: projectRoot || process.cwd(),
    host: config.bridgeHost,
    port: config.bridgePort,
    token: config.localToken,
    authFile: initialAccountState.authFile || config.authFile || '',
    followAuthFile: followDesktop ? 'auto' : '',
    followUid: followDesktop ? initialAccountState.desktopUid : '',
    autoCheckin: config.autoCheckin,
    autoStart: config.autoStart,
    nodePath: config.nodePath || undefined,
    timeoutMs: 8000,
    // 插件 config / .env / 进程环境三处的凭据来源设置都注入桥，启动方之间不漂移。
    env: {
      ...bridgeExtraEnv,
      ...(config.credentialSource ? { WORKBUDDY_CREDENTIAL_SOURCE: config.credentialSource } : {}),
      ...(config.credentialStore ? { WORKBUDDY_CREDENTIAL_STORE: config.credentialStore } : {}),
      ...(config.credentialDir ? { WORKBUDDY_CREDENTIAL_DIR: config.credentialDir } : {}),
      ...(config.loginRegion ? { WORKBUDDY_LOGIN_REGION: config.loginRegion } : {}),
    },
    onLog: (line) => log(line),
  });
  const client = new BridgeClient({
    baseUrl: supervisor.baseUrl,
    token: config.localToken,
    timeoutMs: 8000,
  });

  /**
   * 把面板最新的账号选择同步给 supervisor。
   *
   * 面板切账号只重启了桥，插件进程里 `supervisor.authFile` 还是旧的；桥下次
   * 挂掉时插件会用旧账号把它拉起来。每次 ensure/快照前重读一次 `.state.json`
   * （小文件、毫秒级），保证「插件拉起的桥」和「控制台拉起的桥」选同一个账号。
   */
  const syncBridgeAccountConfig = () => {
    const saved = readBridgeAccountState(projectRoot);
    const fromState = Boolean(saved.authFile);
    const nextAuthFile = fromState ? saved.authFile : (config.authFile || '');
    const nextFollow = fromState ? 'auto' : '';
    const nextUid = fromState ? saved.desktopUid : '';
    const changed = supervisor.authFile !== nextAuthFile
      || supervisor.followAuthFile !== nextFollow
      || supervisor.followUid !== nextUid;
    if (changed) {
      supervisor.authFile = nextAuthFile;
      supervisor.followAuthFile = nextFollow;
      supervisor.followUid = nextUid;
      log(`账号配置已同步：authFile=${nextAuthFile || '(默认)'}`
        + `${nextFollow ? `, followDesktop=${nextUid || '(未记录)'}` : ''}`);
    }
    return changed;
  };

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
    /** 斜杠命令发起、尚未完成的设备码登录（面板有自己的轮询，不共用）。 */
    pendingLogin: null,
    readyPromise: null,
    lastEnsure: null,
    lastConsoleEnsure: null,
    quotaCache: { at: 0, value: null, error: '', account: null },
    checkinCache: { at: 0, value: null, error: '', account: null },
    checkinInflight: null,
    bridgeAccount: null,
    /** 桥进程身份：PID 或构建变了 = 模型目录/档位可能已经换代，必须让 dsh 重拉。 */
    bridgePid: 0,
    bridgeBuild: '',
    /** 桥最近一次确认「活着」的时刻；ensureReady 的短 TTL 缓存用。 */
    bridgeAliveAt: 0,
    /** 最近一次网页搜索自检，只存元数据（不存 query/令牌）。 */
    webSearchVerify: { at: 0, verified: null, sourceCount: null, error: '', baseURL: '' },
    /**
     * 一键接入前的 dsh 搜索配置快照。含上一份桥令牌，只留在内存里；
     * 对外只暴露 summary（baseURL/apiKeyRef/provider），绝不回传 credential。
     */
    webSearchPrevious: null,
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

  /**
   * 图片附件 → data URL（多模态消息用）。
   *
   * ## 为什么必须**原样**传 ref（2026-10-13 修：图读不了）
   *
   * 原先这一行是：
   *   `attachments.readImage({ attachmentId: ref.attachmentId, mediaType: ref.mediaType })`
   * —— 把 dsh 给的完整 `ImageAttachmentRef` 拆成两个字段再传。
   * 但 dsh 的 `readImage(ref)` 会用它做**元数据核对**（`@deepseek-ai/dsh-attachment-local`）：
   *
   *   const metadata = await probeImage(data);
   *   if (metadata.mediaType !== ref.mediaType
   *    || data.byteLength !== ref.bytes      // ← 拆完后 ref.bytes 是 undefined
   *    || metadata.width  !== ref.width      // ← undefined
   *    || metadata.height !== ref.height)    // ← undefined
   *     throw new AttachmentError('...', 'ATTACHMENT_CORRUPT');
   *
   * 于是**每一次**读图都抛 ATTACHMENT_CORRUPT，被这个函数的调用方
   * `.catch(() => null)` 吞掉 → adapter 把图换成文字占位
   * `[图片：无法读取该附件]` → **模型完全看不到图，且全程不报错**。
   *
   * `ImageAttachmentRef` 的真实形状（从 dsh 的类型声明里核出来的，不是猜的）：
   *   { attachmentId, mediaType, bytes, width, height, name?, originalDimensions? }
   * 注意 `bytes/width/height` 是**必填**，缺了核对必失败。
   *
   * 所以修法是**把 ref 原样传下去**（它本来就是那个接口要的形状），
   * 不要自己重建一个"看起来够用"的对象。
   *
   * ## 顺带修掉两处让问题更难查的地方
   *
   *   1. `stored.mediaType` 不存在 —— 返回值是 `{ ref, data }`，媒体类型在
   *      `stored.ref.mediaType`。取不到就回退 `ref.mediaType`，行为不变；
   *   2. 失败**不再静默**：原先一律 `return null`，用户只能看到"图没传上去"，
   *      日志里一个字都没有。现在读失败会把原因打出来（只打错误信息，
   *      不含图片内容），下次这类问题一眼可见。
   */
  const resolveImage = async (ref) => {
    if (!ref?.attachmentId) return null;
    const attachments = ctx.get('attachments');
    if (!attachments) {
      log('图片附件：dsh 没有挂载 attachments 服务，无法读取图片', String(ref.attachmentId).slice(0, 24));
      return null;
    }
    let stored;
    try {
      // ⚠️ 原样传 ref —— 见上面注释，dsh 要用 bytes/width/height 做元数据核对
      stored = await attachments.readImage(ref);
    } catch (error) {
      log('图片附件读取失败', `${error?.code || ''} ${error?.message || error}`.trim());
      return null;
    }
    const bytes = stored?.data ?? stored?.bytes ?? stored?.buffer;
    if (!bytes) {
      log('图片附件：readImage 返回里没有数据', String(ref.attachmentId).slice(0, 24));
      return null;
    }
    const mediaType = stored?.ref?.mediaType || ref.mediaType || 'image/png';
    const base64 = Buffer.from(bytes).toString('base64');
    return `data:${mediaType};base64,${base64}`;
  };

  const adapter = new WorkBuddyAdapter({
    provider: config.provider,
    displayName: config.displayName,
    client,
    resolveImage,
    log: (message, detail) => log(message, detail),
    // 对话出现 TRANSPORT 失败 = 桥可能刚挂：立刻作废「活着」缓存，
    // 下一次对话重新探测/拉起，而不是在 5 秒 TTL 内对着死桥空转。
    onTransportFailure: () => { state.bridgeAliveAt = 0; },
    filter: { allow: config.modelAllow, deny: config.modelDeny },
    // dsh 保存的默认模型选择（含 reasoningEffort）：用来兼容升级前存下的旧档位，
    // 并在选择器里保留"官方目录外但正在使用"的模型。
    getDefaultSelection: () => {
      try { return ctx.get('agentDefaultModel')?.currentSelection?.() || null; }
      catch { return null; }
    },
    defaults: {
      maxTokens: config.defaultMaxTokens,
      temperature: config.defaultTemperature,
      reasoningEffort: config.defaultReasoningEffort,
    },
    catalogTtlMs: config.catalogTtlMs,
    streamIdleTimeoutMs: config.streamIdleTimeoutMs,
    ensureReady: async () => {
      // 每次取用前保证桥在跑：桥挂了自动拉起来，用户不必管。
      // 桥刚被确认活着的一小段时间内直接复用结论 —— 省掉每次对话前那次
      // 串行的 /health 探测（本机回环也要 2-3ms，且在请求关键路径上）。
      // 对话失败时 reset() 会立刻作废缓存（见 stream 的 TRANSPORT 路径）。
      if (!config.autoStart) return client;
      if (state.readyPromise) return state.readyPromise;
      // 桥挂了要重新拉起时，先读一次面板最新选择（切过账号后不能用旧快照）
      syncBridgeAccountConfig();
      const now = Date.now();
      if (now - (state.bridgeAliveAt || 0) < config.bridgeAliveTtlMs) return client;
      const probe = await supervisor.probe();
      if (probe.state === 'running') {
        state.bridgeAliveAt = now;
        return client;
      }
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

  // ── 0. 应用面板勾选的模型显示偏好 ─────────────────────────────────────
  // 用户在模型面板勾选"在 dsh 中显示"的清单持久化在 .model-prefs.json；
  // 启动时读回并应用到 adapter（与配置文件的 modelAllow 叠加：勾选清单优先 ——
  // 它是用户在界面上表达的最新意图）。
  const savedPrefs = readModelPrefs();
  if (savedPrefs) {
    if (savedPrefs.visible !== null || savedPrefs.hideAll || savedPrefs.includeUnofficial) {
      adapter.setFilter({
        // visible=null（只有 includeUnofficial 偏好）时必须保留 config.modelAllow，
        // 不能传空数组把它覆盖成“白名单为空”。
        allow: savedPrefs.visible === null ? undefined : savedPrefs.visible,
        hideAll: savedPrefs.hideAll,
        includeUnofficial: savedPrefs.includeUnofficial,
      });
    }
    if (savedPrefs.paramsByModel && Object.keys(savedPrefs.paramsByModel).length) {
      adapter.setModelParams(savedPrefs.paramsByModel);
    }
    if (savedPrefs.contextWindowByModel && Object.keys(savedPrefs.contextWindowByModel).length) {
      adapter.setContextWindows(savedPrefs.contextWindowByModel);
    }
    state.modelVisibility = {
      source: 'prefs',
      allow: savedPrefs.visible,
      hideAll: savedPrefs.hideAll,
      includeUnofficial: savedPrefs.includeUnofficial === true,
      contextWindowByModel: savedPrefs.contextWindowByModel || {},
      paramsByModel: savedPrefs.paramsByModel || {},
    };
    log(savedPrefs.hideAll
      ? '已应用模型显示偏好：全部隐藏（面板里点过「全不选」）'
      : (savedPrefs.visible === null
        ? `已应用模型偏好：显示跟随配置（含官方目录外：${savedPrefs.includeUnofficial ? '是' : '否'}）`
        : `已应用模型显示偏好：${savedPrefs.visible.length} 个模型`));
  }

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

  /**
   * 通知 dsh 的 UI「模型拓扑变了」，让模型选择器重拉 listModels()。
   *
   * 为什么需要它：模型选择器不在每次打开时重查目录 —— 它订阅
   * `llm/adapters-updated` 事件（settings/document-updated、凭据变更、连接重置
   * 也会触发）。保存模型显示偏好只改了 adapter 内部的 filter，不产生任何事件，
   * UI 就一直显示旧清单 —— 用户保存完看到"模型数量没变"，就是这个原因。
   *
   * 实现取巧但安全：emitAdaptersUpdated() 本是 registerAdapter 的内部通知，
   * 这里把它当作"拓扑可能变了"的公开通知来用。防御式调用 —— 它不是文档化
   * 的公开 API，旧版 dsh 可能没有；没有就静默跳过，面板上会提示"重启一次 dsh
   * 后生效"作为兜底（见 onWritePrefs 的返回）。
   */
  const notifyAdaptersUpdated = () => {
    try {
      if (typeof llm?.emitAdaptersUpdated === 'function') {
        llm.emitAdaptersUpdated();
        return true;
      }
    } catch (error) {
      log('广播 llm/adapters-updated 失败（不影响偏好已保存）', error);
    }
    return false;
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
  /**
   * 桥进程换代（重启/升级/崩溃后重拉）时作废适配器目录并通知 dsh。
   *
   * 账号没变、只是桥重启的情况下，`reconcileAccount` 不会触发；但目录/思考
   * 档位是桥代码算的 —— 不重拉的话，dsh 选择器最多要等一个目录 TTL 才更新
   * （issue #5 的「升级后仍显示六档位」在桥被控制台重启时同样会复现）。
   */
  function reconcileBridgeProcess(probe) {
    if (probe.state !== 'running') return false;
    const pid = Number(probe.health?.pid) || 0;
    const build = String(probe.health?.build || '');
    const changed = (state.bridgePid && pid && pid !== state.bridgePid)
      || (state.bridgeBuild && build && build !== state.bridgeBuild);
    if (pid) state.bridgePid = pid;
    if (build) state.bridgeBuild = build;
    if (changed) {
      log(`桥进程已换代（pid ${state.bridgePid}，build ${state.bridgeBuild || '?'}）：重拉模型目录`);
      adapter.invalidate();
      notifyAdaptersUpdated();
    }
    return changed;
  }

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
      // 模型目录也属于"账号视角"的数据（不同账号可见模型可能不同）。
      // 只作废并通知选择器；让 listModels 在 UI 需要时再取，避免在探测路径里
      // 额外打一次上游（控制台切号后桥可能还在重启）。
      adapter.invalidate();
      notifyAdaptersUpdated();
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

  /**
   * 面板用来判断“网页搜索是否已接上本地桥”。
   *
   * 只读 settings/credentials，不发搜索请求（status 每 8 秒轮询，不能顺带
   * 消耗搜索额度）。真正的一键配置会再跑一次 verifyWorkBuddyWebSearch。
   */
  async function webSearchStatus({ bridgeState = 'stopped' } = {}) {
    const expectedBaseURL = `${supervisor.baseUrl}/v1`;
    const settings = ctx.get('settings');
    const credentials = ctx.get('credentials');
    const revert = state.webSearchPrevious?.ok
      ? {
        available: true,
        at: new Date(state.webSearchPrevious.at).toISOString(),
        previous: state.webSearchPrevious.summary,
      }
      : { available: false };
    const unavailable = {
      available: false,
      configured: false,
      pointsToBridge: false,
      providerSelected: false,
      provider: '',
      baseURL: '',
      apiKeyRef: '',
      expectedBaseURL,
      reason: 'unavailable',
      revert,
    };
    if (!settings || typeof settings.get !== 'function') {
      return {
        ...unavailable,
        ...deriveWebSearchReadiness({
          status: unavailable,
          bridgeState,
          verification: state.webSearchVerify,
          expectedBaseURL,
        }),
      };
    }

    let section;
    let webSection;
    try {
      section = settings.get('web-search-deepseek');
      webSection = settings.get('web');
    } catch (error) {
      const base = { ...unavailable, available: true, reason: 'error', error: String(error?.message || error) };
      return {
        ...base,
        ...deriveWebSearchReadiness({
          status: base,
          bridgeState,
          verification: state.webSearchVerify,
          expectedBaseURL,
        }),
      };
    }
    if (section === undefined) {
      const base = { ...unavailable, available: true, reason: 'namespace-missing' };
      return {
        ...base,
        ...deriveWebSearchReadiness({
          status: base,
          bridgeState,
          verification: state.webSearchVerify,
          expectedBaseURL,
        }),
      };
    }

    const apiKeyRef = typeof section?.apiKeyEnv === 'string' ? section.apiKeyEnv : '';
    const literalKey = typeof section?.apiKey === 'string' && section.apiKey.length > 0;
    let keyConfigured = literalKey;
    if (!keyConfigured && apiKeyRef && credentials && typeof credentials.describe === 'function') {
      try {
        keyConfigured = (await credentials.describe(apiKeyRef))?.configured === true;
      } catch { /* 凭据服务读不到就按未配置处理，让面板提醒用户 */ }
    }

    /*
     * 只比对**实际引用**：不再回退 DEEPSEEK_API_KEY。否则用户只配了 DeepSeek
     * key 时，面板会把“搜索指向桥”误判成已接入，实际搜索 401。
     * resolve 只用于比较，不写日志、不回传客户端。
     */
    let tokenMatches = null;
    if (config.localToken) {
      if (literalKey) {
        tokenMatches = section.apiKey === config.localToken;
      } else if (apiKeyRef && credentials && typeof credentials.resolve === 'function') {
        try {
          const resolved = await credentials.resolve(apiKeyRef);
          if (resolved && typeof resolved.value === 'string') {
            tokenMatches = resolved.value === config.localToken;
          }
        } catch { tokenMatches = null; }
      }
    }

    const status = deriveWebSearchStatus({
      section,
      webSection,
      expectedBaseURL,
      keyConfigured,
    });
    return {
      available: true,
      expectedBaseURL,
      keyConfigured,
      revert,
      ...status,
      ...deriveWebSearchReadiness({
        status,
        bridgeState,
        tokenMatches,
        verification: state.webSearchVerify,
        expectedBaseURL,
      }),
    };
  }

  async function snapshot({ signal, quota = false } = {}) {
    // 面板切号只改 .state.json；插件每次取快照前同步，保证下面的探测/重启
    // 用的是当前账号，而不是加载插件时的旧值。
    syncBridgeAccountConfig();
    const probe = await supervisor.probe(signal);
    const consoleProbe = await consoleSupervisor.probe({ signal, cached: true });
    // 桥换代（重启/升级）→ 目录与档位属于新代码，先作废旧缓存
    reconcileBridgeProcess(probe);
    // 再对账号：身份变了就作废全部跨账号缓存（含模型目录）
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
        /*
         * 桥现在会带回「这份余额属于哪个账号」。与探测到的桥账号不一致
         * 说明取数期间又换号了 —— 宁可这一轮显示「—」，也不要把上一个
         * 账号的余额挂在新账号下。
         */
        const quotaAccount = quotaValue && typeof quotaValue.account === 'string' ? quotaValue.account : '';
        if (quotaAccount && reconciliation.account && quotaAccount !== reconciliation.account) {
          quotaValue = null;
          quotaError = '积分属于另一个账号，正在重新读取';
          state.quotaCache = { at: 0, value: null, error: quotaError, account: null };
        } else if (state.bridgeAccount === reconciliation.account) {
          // 身份没再变才入缓存（避免"取的是新账号、标记却是旧账号"的错位）
          state.quotaCache = {
            at: Date.now(),
            value: quotaValue,
            error: '',
            account: quotaAccount || reconciliation.account,
          };
          quotaError = '';
        }
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
    /**
     * 最近失败请求：概览页的待办提醒只需要"有几条失败"，不必把 20 条明细
     * 搬给客户端（那会每 15 秒重复搬一遍，且与 status 的 8 秒轮询重叠）。
     * 从本地账本现算，成本极低；桥没跑时给空数组（不阻塞、不报错）。
     */
    let recentFailed = [];
    if (probe.state === 'running') {
      try {
        const recent = await client.requests({ limit: 20, signal });
        recentFailed = (recent?.requests || []).filter((r) => !r.ok && r.probe !== true)
          .map((r) => ({ t: r.t, model: r.model, status: r.status, code: r.code, error: r.error }));
      } catch { /* 账本读不到就当"没有失败"，不要因此让整页报错 */ }
    }
    const catalog = adapter.catalogCache.models;
    return {
      bridge: {
        state: probe.state,
        health: probe.health || null,
        error: probe.error || '',
        /** 端口上的桥是不是当前插件里的脚本（旧进程会没有 build） */
        build: probe.bridgeBuild || probe.health?.build || '',
        expectedBuild: probe.expectedBuild || '',
        staleBuild: probe.staleBuild === true,
      },
      /** 控制台：数据界面在它那儿，插件只报状态与地址。 */
      console: {
        state: consoleProbe.state,
        url: consoleSupervisor.url,
        error: consoleProbe.error || '',
        /** 端口上的页面是不是当前插件里的控制台代码（旧进程没有 meta） */
        build: consoleProbe.build || '',
        expectedBuild: consoleProbe.expectedBuild || '',
        staleBuild: consoleProbe.staleBuild === true,
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
      directory: toDirectory(catalog, { contextWindows: adapter.contextWindowsSnapshot() }),
      catalogAt: adapter.catalogCache.at ? new Date(adapter.catalogCache.at).toISOString() : null,
      catalogError: adapter.catalogError || '',
      legacy: { found: state.legacy.found, files: state.legacy.files, cleaned: state.legacy.cleaned },
      /** 网页搜索是否已指向本地桥（面板据此高亮提醒并给一键接入按钮） */
      webSearch: await webSearchStatus({ bridgeState: probe.state }),
      quota: quotaValue,
      quotaError,
      /** 上次成功读到积分的时刻（ISO）；面板用它显示"更新于" */
      quotaAt: state.quotaCache.at ? new Date(state.quotaCache.at).toISOString() : null,
      /** 这份积分属于哪个账号（health.auth.userId）；与 bridgeAccount 不一致说明缓存还没换新 */
      quotaAccount: state.quotaCache.account,
      /** 桥当前登录的账号（本快照探测到的）——重启 dsh 后可在面板核对它与 quotaAccount 一致 */
      bridgeAccount: state.bridgeAccount,
      /**
       * 桌面登录文件里当前的账号（桥 /health 顺带读出）。
       * 与 bridgeAccount 不同 = 桌面已换号、但桥还在用插件账号另一条凭据
       * （或反过来），面板要把这件事说清楚，不能让人以为两者是同一个钱包。
       */
      desktopAccount: probe.health?.credential?.desktopUserId || '',
      checkin: state.checkinCache.value,
      checkinError: state.checkinCache.error || '',
      checkinAccount: state.checkinCache.account,
      /** 最近 20 条里的失败（概览页待办提醒用；避免客户端为"数几条"再拉一次明细） */
      recentFailed,
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
          description: 'WorkBuddy 中转：状态 / 登录 / 模型 / 用量 / 签到 / 启停桥 / 网页搜索 / 打开控制台 / 清理旧路由',
          input: { hint: 'status | login | logout [uid前缀] | models | usage | checkin | console | websearch | start | stop | restart | cleanup' },
          async handler({ rawInput, signal }) {
            const parts = String(rawInput || '').trim().split(/\s+/).filter(Boolean);
            const arg = parts[0] || 'status';
            const sub = parts[1] || '';
            try {
              if (arg === 'console' || arg === 'ui') {
                const result = await consoleSupervisor.ensure({ signal });
                return result.ok
                  ? { kind: 'success', text: `控制台已就绪：${consoleSupervisor.url}${result.reused ? '（复用已在运行的实例）' : '（本次新拉起）'}\n逐条请求、趋势图、CSV 导出、账号切换、签到与诊断都在那里。` }
                  : { kind: 'error', text: `控制台启动失败：${result.error}` };
              }
              if (arg === 'start' || arg === 'restart') {
                syncBridgeAccountConfig();
                const result = await supervisor.ensure({ restart: arg === 'restart', signal });
                adapter.invalidate();
                if (result.ok) adapter.warmup().then(() => notifyAdaptersUpdated(), () => notifyAdaptersUpdated());
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
              if (arg === 'websearch' || arg === 'web-search') {
                const result = await enableWebSearch();
                const base = `网页搜索已指向本地桥：${result.baseURL}（凭据 ${result.apiKeyRef}，不覆盖 DEEPSEEK_API_KEY）`;
                if (result.verified === true) {
                  return { kind: 'success', text: `${base}\n自检通过：dsh 的 web 服务已从桥拿到 ${result.sourceCount} 条结果。` };
                }
                if (result.verified === false) {
                  return { kind: 'error', text: `${base}\n配置已保存，但自检失败：${result.verifyError}\n可直接重跑 /workbuddy websearch，或看桥日志里的 web_search (anthropic)。` };
                }
                return { kind: 'success', text: `${base}\n当前 dsh 没有可用的 web 服务，未能自检；请随手搜一次确认。` };
              }
              if (arg === 'login') {
                /*
                 * 两步式：第一次发起并给出 URL，第二次（浏览器授权后再跑）检查结果。
                 * 面板里有自动轮询；斜杠命令不长期占用会话，所以做成幂等的"再跑一次"。
                 */
                const pending = state.pendingLogin;
                if (pending && Date.now() - pending.at < 10 * 60 * 1000) {
                  let result;
                  try { result = await client.deviceLoginPoll(pending.state, signal); }
                  catch (error) { return { kind: 'error', text: `检查登录状态失败：${error?.message || error}` }; }
                  if (result?.status === 'ready') {
                    state.pendingLogin = null;
                    adapter.invalidate();
                    adapter.warmup().then(() => notifyAdaptersUpdated(), () => notifyAdaptersUpdated());
                    invalidateUpstreamCaches();
                    return { kind: 'success', text: `登录成功：${result.account?.uid || ''}。已切换为插件账号。` };
                  }
                  return {
                    kind: 'success',
                    text: `尚未完成授权。请在浏览器打开：\n${pending.url}\n完成后再次运行 /workbuddy login 检查结果。`,
                  };
                }
                try {
                  const started = await client.deviceLoginStart({ region: config.loginRegion || 'cn', open: true }, signal);
                  state.pendingLogin = { state: started.state, url: started.url, at: Date.now() };
                  return {
                    kind: 'success',
                    text: `已尝试打开浏览器授权页（10 分钟内有效）。若没有自动打开，请手动访问：\n${started.url}\n完成后再次运行 /workbuddy login 检查结果。`,
                  };
                } catch (error) {
                  return { kind: 'error', text: `发起登录失败：${error?.message || error}` };
                }
              }
              if (arg === 'logout') {
                try {
                  const list = await client.authCredentials(signal);
                  const creds = Array.isArray(list?.credentials) ? list.credentials : [];
                  if (!creds.length) return { kind: 'success', text: '没有插件账号可退出。' };
                  const target = sub
                    ? creds.find((c) => String(c.uid).startsWith(sub))
                    : (creds.length === 1 ? creds[0] : null);
                  if (!target) {
                    const lines = creds.map((c) => `- ${String(c.uid).slice(0, 8)}…`
                      + `${c.nickname ? `（${c.nickname}）` : ''}${c.active ? ' [使用中]' : ''}`);
                    return {
                      kind: 'success',
                      text: `有 ${creds.length} 个插件账号，请指定 uid 前缀：\n${lines.join('\n')}`,
                    };
                  }
                  await client.authLogout(target.uid, signal);
                  adapter.invalidate();
                  adapter.warmup().then(() => notifyAdaptersUpdated(), () => notifyAdaptersUpdated());
                  invalidateUpstreamCaches();
                  return { kind: 'success', text: '已清除该插件账号的凭据（不影响上游账号）。' };
                } catch (error) {
                  return { kind: 'error', text: `退出失败：${error?.message || error}` };
                }
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
                `凭据：${snap.bridge.health?.credential?.source || '—'}${snap.bridge.health?.credential?.storeMode === 'memory' ? '（仅内存）' : ''}`,
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

  /**
   * 上游会发生"余额/状态改变"的操作（领取签到等）成功后调用：
   * 立即作废插件侧的积分/签到缓存，让下一次快照重新打上游。
   * 没有它，面板在领取后最长 120 秒还显示旧余额（与换号 bug 同源的缓存一致性缺口）。
   */
  function invalidateUpstreamCaches() {
    state.quotaCache = { ...state.quotaCache, at: 0, value: null };
    state.checkinCache = { ...state.checkinCache, at: 0, value: null };
  }

  /** 最近一次自检的写入口；只持久化在内存里，面板轮询时读取。 */
  async function runWebSearchVerify() {
    const verification = await verifyWorkBuddyWebSearch({ web: ctx.get('web') });
    state.webSearchVerify = {
      at: Date.now(),
      verified: verification.verified,
      sourceCount: verification.sourceCount ?? null,
      error: verification.verifyError || '',
      baseURL: `${supervisor.baseUrl}/v1`,
    };
    return verification;
  }

  let webSearchEnableInflight = null;

  /**
   * 一键把 dsh 的网页搜索切到 WorkBuddy：
   *   - 先确保桥在跑（拿当前 host/port/令牌）；
   *   - 把令牌写进 dsh credentials 的**独立引用**，不覆盖 DEEPSEEK_API_KEY；
   *   - 把 web-search-deepseek 的 baseURL 指到本地桥 /v1。
   *
   * 多个窗口同时点按钮时复用同一个在途任务：重复写配置没有意义，还会重复
   * 触发真实搜索自检、消耗搜索额度。
   */
  function enableWebSearch() {
    if (webSearchEnableInflight) return webSearchEnableInflight;
    webSearchEnableInflight = (async () => {
      syncBridgeAccountConfig();
      const ready = await supervisor.ensure({ readyTimeoutMs: config.autoStartTimeoutMs });
      if (!ready.ok) throw new Error(ready.error || ready.state || 'bridge is not ready');
      /*
       * 只保留**第一次接入前**的快照：用户点“重新接入”时不能把原始配置覆盖掉。
       * 快照含旧凭据值，仅存内存，不写日志、不进 HTTP 响应。
       */
      if (!state.webSearchPrevious) {
        const previous = await snapshotWorkBuddyWebSearch({
          settings: ctx.get('settings'),
          credentials: ctx.get('credentials'),
        });
        state.webSearchPrevious = previous.ok ? previous : null;
        log(previous.ok
          ? 'web search previous configuration captured for restore'
          : 'web search previous configuration is not restorable on this host');
      }
      // 配置即将变化：旧的自检结果不再代表当前链路。
      state.webSearchVerify = { at: 0, verified: null, sourceCount: null, error: '', baseURL: '' };
      const result = await configureWorkBuddyWebSearch({
        settings: ctx.get('settings'),
        credentials: ctx.get('credentials'),
        baseURL: `${supervisor.baseUrl}/v1`,
        token: config.localToken,
      });
      // 用 dsh 自己的 web 服务跑一次，令牌/桥/热更任何一环不对都会在这里暴露。
      const verification = await runWebSearchVerify();
      log('web search configured -> bridge', result.baseURL,
        verification.verified === true ? `verified sources=${verification.sourceCount}`
          : verification.verified === false ? `verify failed: ${verification.verifyError}`
            : 'verification skipped (no web service)');
      return { ...result, ...verification };
    })().finally(() => { webSearchEnableInflight = null; });
    return webSearchEnableInflight;
  }

  /** 把 dsh 的搜索配置恢复到第一次一键接入前的快照。 */
  async function revertWebSearch() {
    const previous = state.webSearchPrevious;
    if (!previous?.ok) throw new Error('没有可恢复的接入前配置');
    const result = await restoreWorkBuddyWebSearch({
      settings: ctx.get('settings'),
      credentials: ctx.get('credentials'),
      snapshot: previous,
    });
    state.webSearchPrevious = null;
    state.webSearchVerify = { at: 0, verified: null, sourceCount: null, error: '', baseURL: '' };
    log('web search configuration restored', result.summary?.baseURL || '(unset)');
    return result;
  }

  // ── 6. HTTP 数据面（入口页用） ─────────────────────────────────────────
  if (config.routes) {
    useService('webServer', (webServer) => {
      const routes = createRouteTable({
        snapshot,
        supervisor,
        consoleSupervisor,
        client,
        adapter,
        paths: dshPaths,
        provider: config.provider,
        log,
        onUpstreamMutation: invalidateUpstreamCaches,
        readPrefs: readModelPrefs,
        onWritePrefs: writeModelPrefs,
        notifyAdaptersUpdated,
        enableWebSearch,
        verifyWebSearch: runWebSearchVerify,
        revertWebSearch,
      });
      const disposeRoutes = mountRoutes(webServer, routes, log);
      ctx.effect(() => disposeRoutes, 'workbuddy.panel-routes');
    });
  }

  // ── 7. 后台把桥与控制台拉起来（不阻塞插件加载） ────────────────────────
  /**
   * 后台身份监听：每 2 秒问桥“现在是谁”，账号一变就立刻作废目录/积分并
   * 通知 dsh 选择器。不能只靠面板打开时的 8 秒轮询 —— 用户切号后马上发
   * 消息也必须落到新账号上（模型目录/档位也是账号相关的）。
   */
  let identityPolling = false;
  async function pollBridgeIdentity() {
    if (identityPolling) return;
    identityPolling = true;
    try {
      const identity = await client.accountIdentity(AbortSignal.timeout(4000));
      if (!identity?.ok) return;
      const probe = {
        state: 'running',
        health: {
          ok: true,
          pid: identity.pid,
          build: identity.build,
          auth: identity.auth,
          credential: {
            source: identity.auth?.source || '',
            desktopUserId: identity.desktopUserId || '',
          },
        },
      };
      reconcileBridgeProcess(probe);
      reconcileAccount(probe);
    } catch { /* 桥没跑 / 还没登录：下一轮再试 */ }
    finally { identityPolling = false; }
  }

  if (config.autoStart) {
    void (async () => {
      try {
        syncBridgeAccountConfig();
        const result = await supervisor.ensure({ readyTimeoutMs: config.autoStartTimeoutMs });
        state.lastEnsure = { at: Date.now(), ...result };
        if (result.ok) {
          adapter.invalidate();
          /*
           * 预热目录：首次模型调用/打开模型选择器时不必再等一次桥往返。
           * 冷启动时桥可能要去上游抓目录（最多十几秒），把它放在后台，
           * 用户发第一条消息时目录通常已经就位。
           */
          adapter.warmup().catch(() => {});
          log(`桥已就绪：${supervisor.baseUrl}/v1（pid ${result.health?.pid}${result.reused ? '，复用已有实例' : '，本次新拉起'}）`);
        } else {
          log(`桥未能就绪：${result.error}`);
        }
      } catch (error) {
        log('自动启动桥失败', error);
      }
      /*
       * 无论这一次桥是否就绪都开始监听：登录/换号可能稍后发生。
       * 2 秒是本机 /v1/identity 的成本（只 stat + 解码 token，不抓目录）。
       */
      const timer = setInterval(pollBridgeIdentity, 2000);
      timer.unref?.();
      if (typeof ctx.effect === 'function') {
        ctx.effect(() => () => clearInterval(timer), 'workbuddy.identity-watch');
      }
      pollBridgeIdentity();
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
