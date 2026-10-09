/**
 * 统一配置 —— 全项目唯一的配置真源。
 *
 * 优先级：进程环境变量 > `.env` 文件 > 内置默认值。
 * 桥进程（bridge/workbuddy-bridge.mjs）不直接引用本模块，而是由控制台在
 * spawn 时注入同样的环境变量，从而保持桥的单文件自包含特性；两边使用的
 * 变量名以本文件为准。
 */
import { existsSync, readFileSync, readdirSync, writeFileSync, chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findWorkBuddyExe } from './lib/find-workbuddy.mjs';
import { findDshRuntime } from './lib/find-dsh.mjs';

/** 项目根目录。 */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)));

// ── .env 加载（零依赖，不覆盖已存在的环境变量） ──────────────────────────

function loadDotEnv(file) {
  if (!existsSync(file)) return;
  for (const rawLine of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    // 容忍 shell 风格的 `export KEY=VALUE`：`.env` 与 shell 脚本写法相近，
    // 用户从 README / 别处粘一行过来是常事。若不剥离 `export`，键名会变成
    // "export KEY" —— 配置**静默失效**，且没有任何提示（最难排查的那类问题）。
    const body = line.replace(/^export\s+/u, '');
    const eq = body.indexOf('=');
    if (eq <= 0) continue;
    const key = body.slice(0, eq).trim();
    let value = body.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv(join(ROOT, '.env'));

const env = process.env;

// ── 环境变量取值 ────────────────────────────────────────────────────────

/**
 * 读一个数值型环境变量，非法值回退默认。
 *
 * 为什么不能直接用 `Number(env.X || 默认)`：用户手滑写 `WORKBUDDY_PORT=879O`
 * （字母 O）、`8790ms`、多个空格时，`Number()` 得到 `NaN` 并被原样塞进配置。
 * 后果是一串**看不出根因**的症状：`listen` 报 errno、派生 URL 变成
 * `http://127.0.0.1:NaN`、`setTimeout(NaN)` 立即触发。用户看到的是"桥起不来"，
 * 而不是"我 .env 写错了"。
 *
 * 这里统一收口：非有限数 → 默认值；`min`/`max` 越界 → 默认值；小数 → 截断为整数。
 * 越界也回退（而不是截断到边界）是刻意的 —— 端口写 99999 多半是写错了，
 * 静默改成 65535 会让用户以为配置生效了。
 *
 * @param {string} name 环境变量名
 * @param {number} fallback 默认值
 * @param {{ min?: number, max?: number, integer?: boolean }} [range]
 */
function numEnv(name, fallback, range = {}) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  const min = range.min ?? -Infinity;
  const max = range.max ?? Infinity;
  if (value < min || value > max) return fallback;
  return range.integer ? Math.trunc(value) : value;
}

/** 端口专用：1..65535 的整数。 */
function portEnv(name, fallback) {
  return numEnv(name, fallback, { min: 1, max: 65535, integer: true });
}

// ── 路径解析 ────────────────────────────────────────────────────────────

/**
 * WorkBuddy 桌面客户端可执行文件。
 *
 * 探测 = 显式覆盖 → 默认安装位置 → 磁盘浅扫描（见 lib/find-workbuddy.mjs）。
 * 客户端重装到新目录后无需任何配置：静态列表落空时由扫描兜底。
 * 全部落空返回 ''（而不是返回一个不存在的路径）—— 这样它注入给桥时是空值，
 * 桥会用自己的同款探测重新定位，而不是盲目信任一个失效路径。
 */
export function resolveWorkBuddyExe() {
  return findWorkBuddyExe();
}

/**
 * dsh 运行时目录。
 *
 * 多级探测（env 覆盖 → 常见安装位置 → 运行中进程 → 磁盘浅扫描），
 * 实现见 lib/find-dsh.mjs —— 与 WorkBuddy 客户端探测同族：写死路径在
 * DSH 换目录安装后必然失配，而 dsh 集成（模型注册 / profile bundles /
 * 凭据引用）全都依赖这个目录。
 *
 * 注意优先取 **DSH Desktop** 的那一套 bundled 运行时：本机可能并存一份
 * 独立的旧安装，二者版本不同（例如 0.2.0-rc.2 与 0.1.0-rc.6），据此得出的
 * 结论（llm-pi-ai 可用版本、.credentials.yaml 格式要求）也不同。
 * 探测不到时返回 ''（而不是一个不存在的路径），各消费点对空值有防御。
 */
export function resolveDshRuntime() {
  return findDshRuntime();
}

/** DSH Desktop 的版本号，读自 bundled 运行时的 runtime.json。 */
export function dshDesktopVersion(runtime = resolveDshRuntime()) {
  const manifest = join(runtime, 'primary-runtime', 'runtime.json');
  if (existsSync(manifest)) {
    try {
      return JSON.parse(readFileSync(manifest, 'utf8')).desktopVersion || '';
    } catch {
      /* 清单损坏则退回未知 */
    }
  }
  // 独立安装：runtime/node_modules/@deepseek-ai/dsh
  const pkg = join(runtime, 'node_modules', '@deepseek-ai', 'dsh', 'package.json');
  if (existsSync(pkg)) {
    try {
      return JSON.parse(readFileSync(pkg, 'utf8')).version || '';
    } catch {
      /* 同上 */
    }
  }
  return '';
}

/** 桌面登录文件所在目录。 */
export function authDir() {
  if (env.WORKBUDDY_AUTH_DIR) return env.WORKBUDDY_AUTH_DIR;
  const home = homedir();
  return process.platform === 'win32'
    ? join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'CodeBuddyExtension', 'Data', 'Public', 'auth')
    : process.platform === 'darwin'
      ? join(home, 'Library', 'Application Support', 'CodeBuddyExtension', 'Data', 'Public', 'auth')
      : join(home, '.local', 'share', 'CodeBuddyExtension', 'Data', 'Public', 'auth');
}

/**
 * 实际使用的登录文件。
 *
 * 该目录下可能同时存在多个账号快照（例如国际版的 `workbuddy-desktop-ai.info`），
 * 按目录顺序取第一个会选错账号，所以必须显式指定。
 */
export function resolveAuthFile() {
  if (env.WORKBUDDY_AUTH_FILE) return env.WORKBUDDY_AUTH_FILE;
  const dir = authDir();
  const preferred = join(dir, 'workbuddy-desktop.info');
  if (existsSync(preferred)) return preferred;
  try {
    // 兜底必须**排序后取第一个**，与桥的 resolveAuthPath() 同一判据：
    // readdir 的顺序不受任何保证（随平台与文件系统而异），不排序就可能出现
    // "控制台认的是 A 账号、桥实际读的是 B 账号"这种两边不一致。
    const hit = readdirSync(dir).filter((f) => f.endsWith('.info')).sort()[0];
    if (hit) return join(dir, hit);
  } catch {
    /* 目录不存在 */
  }
  return preferred;
}

// ── 配置对象 ────────────────────────────────────────────────────────────

/**
 * 本地回环令牌的持久化位置。
 *
 * **与 DSH 插件共用同一个文件**（`dsh-plugin/lib/index.js` 的 BRIDGE_TOKEN_PATH
 * 指向同一路径）：控制台与插件都可能拉起桥，两边若各生成各的令牌，就会出现
 * 「插件起的桥用令牌 A、控制台拿令牌 B 去调 → 401」这种两边都自认正常的故障。
 * 单一真源，两边都读它。
 *
 * 路径必须同时适配两种形态：
 *   - 仓库检出：`ROOT` = 仓库根 → `<root>/dsh-plugin/.bridge-token`
 *   - vendor 分发：本文件被拷到 `dsh-plugin/vendor/config.mjs`，`ROOT` 变成
 *     vendor 目录。此时若仍拼 `ROOT/dsh-plugin/...` 会落到
 *     `vendor/dsh-plugin/...`，**与插件的令牌文件不是同一个** —— 两边各生成
 *     各的，必然 401。
 * 判据：本文件所在目录若有 `vendor/` 子目录，说明我们在分发形态里，往上一层
 * 取插件目录；否则就是仓库检出的布局。
 */
function bridgeTokenPath() {
  const here = dirname(fileURLToPath(import.meta.url));
  const installed = basename(here) === 'vendor' && existsSync(join(here, '..', 'lib', 'index.js'));
  return installed
    ? join(here, '..', '.bridge-token')
    : join(ROOT, 'dsh-plugin', '.bridge-token');
}
const BRIDGE_TOKEN_PATH = bridgeTokenPath();

/**
 * 解析本地回环令牌：显式配置 > 已落盘 > 生成并落盘。
 *
 * 为什么不沿用历史上的硬编码默认值 `wb-local-bridge`：那是**公开口令**，
 * 本机任何程序（乃至能绕开 Origin 检查的网页脚本）都能拿它调用桥、白嫖
 * 账号配额。随机值能真正实现「仅本机授权客户端可用」这一设计意图。
 *
 * 为什么要落盘而不是每次随机：客户端（Claude Code / dsh 等）把令牌写在自己
 * 的配置里，每次重启就换值等于每次都要用户重填。落盘是唯一兼顾安全与可用的
 * 做法。文件权限 0600。
 *
 * 用 randomBytes 而非 Math.random()：后者不是密码学随机，令牌可预测就失去了
 * 防护意义。24 字节 base64url ≈ 192 位熵。
 */
function resolveLocalToken() {
  if (env.WORKBUDDY_LOCAL_TOKEN) return env.WORKBUDDY_LOCAL_TOKEN;
  try {
    const stored = readFileSync(BRIDGE_TOKEN_PATH, 'utf8').trim();
    if (/^[A-Za-z0-9._-]{16,}$/.test(stored)) {
      hardenTokenFile(); // 旧版本创建的文件权限是继承来的，这里补一次
      return stored;
    }
  } catch { /* 首次运行：文件还不存在 */ }
  const token = randomBytes(24).toString('base64url');
  try {
    writeFileSync(BRIDGE_TOKEN_PATH, `${token}\n`, { mode: 0o600 });
    hardenTokenFile();
  } catch { /* 只读介质：本次运行有效，下次会换新（用户需重填客户端密钥） */ }
  return token;
}

/**
 * 把令牌文件收成「只有当前用户能读」。
 *
 * **为什么 `writeFileSync({ mode: 0o600 })` 不够**：那个 `mode` 只在 POSIX 上有意义。
 * Windows 走 NTFS ACL，`mode` 基本被忽略 —— 实测新建出来的文件继承目录权限，
 * 结果是 `Authenticated Users:(M)`（任何已认证用户可改）+ `Users:(RX)`（任何用户可读），
 * 也就是**同机任何用户都能读到令牌**。而令牌改成随机的**理由**恰恰是
 * 「本机任何程序都能拿公开默认值调用桥」—— 权限不收，那个理由就被抵消了一半。
 *
 * 尽力而为：拿不到就保持默认，绝不因此让启动失败。
 *
 * **同样的实现还有一份**在 `dsh-plugin/lib/index.js` 的 `hardenBridgeTokenFile()` ——
 * 插件包不引用仓库根的 config，所以只能各持一份。改动时**两处一起看**。
 */
export function hardenTokenFile(path = BRIDGE_TOKEN_PATH) {
  try {
    if (process.platform !== 'win32') {
      chmodSync(path, 0o600);
      return;
    }
    const user = env.USERNAME || env.USER;
    if (!user) return;
    // 去掉继承、只留给当前用户。用 spawnSync 而不是 execSync：
    // 后者经 cmd.exe 且默认给 stdin 开管道，在 Windows 上必抛 EBUSY。
    spawnSync('icacls', [path, '/inheritance:r', '/grant:r', `${user}:F`],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  } catch { /* 尽力而为 */ }
}

export const config = {
  bridge: {
    host: env.WORKBUDDY_HOST || '127.0.0.1',
    port: portEnv('WORKBUDDY_PORT', 8790),
    /**
     * 本地回环令牌，仅用于防止同机其它程序误用；并非上游凭据。
     *
     * 默认值是**首次运行随机生成并落盘**的（见 resolveLocalToken），不再是
     * 从前的固定串 `wb-local-bridge` —— 那个值是公开的，等于没有防护。
     */
    token: resolveLocalToken(),
    upstreamTimeoutMs: numEnv('WORKBUDDY_TIMEOUT_MS', 0, { min: 0 }),
    /**
     * 积分余额的缓存时长（毫秒）。
     *
     * 积分要打上游计费网关，控制台每 20 秒轮询一次总览 —— 不加缓存等于每 20 秒
     * 打一次计费端点，既没必要也容易触发限流。默认 60 秒。
     *
     * 调小可以让页面更快反映余额变化（签到后等），代价是更频繁的上游查询；
     * 自动化测试也用它来构造「缓存已过期但仍有旧值」这条分支，不必真等 60 秒。
     */
    quotaTtlMs: numEnv('WORKBUDDY_QUOTA_TTL_MS', 60 * 1000, { min: 0 }),
    /**
     * Anthropic 兼容层（`POST /v1/messages`，供 Claude Code 使用）的模型映射。
     *
     * Claude Code 发的是 `claude-sonnet-4-…` 这类名字，上游根本没有这些 id，
     * 必须映射到一个真实存在的模型。这里给两个默认值：
     *   - `anthropicModel`：主模型，取 `glm-5.3`（实测工具调用最稳的一个）
     *   - `anthropicFastModel`：Claude Code 拿它跑标题生成、文件摘要这类后台活，
     *     用小模型就够，用大的纯属浪费额度
     *
     * 想精确指定，把 `ANTHROPIC_MODEL` 设成任意上游真实模型 id 即可——
     * 桥会先拿请求里的名字去上游目录精确匹配，命中就原样使用。
     */
    anthropicModel: env.WORKBUDDY_ANTHROPIC_MODEL || 'glm-5.3',
    anthropicFastModel: env.WORKBUDDY_ANTHROPIC_FAST_MODEL || 'glm-5.3-flash',
    /**
     * 本地限流（保护账号配额）。**默认全关**（0），关着时行为与没有本机制
     * 完全一致。RPM=每分钟上限、MIN_INTERVAL=两条最小间隔、MODE=queue|reject。
     */
    rateLimitRpm: numEnv('WORKBUDDY_RATE_LIMIT_RPM', 0, { min: 0 }),
    rateLimitMinIntervalMs: numEnv('WORKBUDDY_RATE_LIMIT_MIN_INTERVAL_MS', 0, { min: 0 }),
    rateLimitMode: env.WORKBUDDY_RATE_LIMIT_MODE === 'reject' ? 'reject' : 'queue',
    /**
     * 客户端凭据分层（opt-in）：逗号分隔的多把 key，每把一个独立调用方
     * （独立限流桶 + 账本 client 归因）；删除某把即可单独吊销（重启生效）。
     * **内存中只保留哈希**；默认空 = 功能关，只有 WORKBUDDY_LOCAL_TOKEN。
     */
    clientKeys: env.WORKBUDDY_CLIENT_KEYS || '',
    /**
     * 进行中请求超过该毫秒数即判「疑似卡死」（控制台标黄提醒）。
     * 只影响显示高亮，**不干预请求** —— 桥没有任何默认超时。
     */
    activeAlertMs: numEnv('WORKBUDDY_ACTIVE_ALERT_MS', 300_000, { min: 1000 }),
    /**
     * 出站客户端身份（UA / X-IDE-* / X-Product-Version 的取值）。
     *
     * 上游按这些指纹校验调用来源；官方客户端升级后旧指纹可能被拒（「上游
     * 版本漂移」）。默认值与当前实测可用的官方版本一致，需要时在 .env
     * 覆盖这三个即可，改完重启桥生效。
     */
    appVersion: env.WORKBUDDY_APP_VERSION || '4.9.29177644',
    ideVersion: env.WORKBUDDY_IDE_VERSION || '1.119.0',
    ideName: env.WORKBUDDY_IDE_NAME || 'VSCode',
  },
  dashboard: {
    host: '127.0.0.1',
    port: portEnv('DASHBOARD_PORT', 8792),
    /**
     * 控制台启动时自动拉起桥。默认开启，这是"双击即用"的关键——
     * 用户不需要知道桥和面板是两个东西，更不需要手动分开启动。
     */
    autoStartBridge: env.DASHBOARD_AUTO_START_BRIDGE !== '0',
    /**
     * 监听成功后自动打开浏览器。由 启动.cmd 置 1；
     * 地址取 dashboard.url（即 .env 里 DASHBOARD_PORT 生效后的真实地址），
     * 因此改端口后不会再打开一个空页面。
     */
    openBrowser: env.DASHBOARD_OPEN_BROWSER === '1',
  },
  workbuddy: {
    exe: resolveWorkBuddyExe(),
    authFile: resolveAuthFile(),
  },
  dsh: {
    home: env.DSH_HOME || join(homedir(), '.dsh'),
    runtime: resolveDshRuntime(),
    desktopVersion: dshDesktopVersion(),
  },
  paths: {
    root: ROOT,
    bridgeScript: join(ROOT, 'bridge', 'workbuddy-bridge.mjs'),
    bridgeLog: join(ROOT, 'bridge', 'bridge.log'),
    dashboardPublic: join(ROOT, 'dashboard', 'public'),
  },
};

config.bridge.url = `http://${config.bridge.host}:${config.bridge.port}`;
config.bridge.chatUrl = `${config.bridge.url}/v1/chat/completions`;
config.bridge.modelsUrl = `${config.bridge.url}/v1/models`;
config.bridge.healthUrl = `${config.bridge.url}/health`;
config.dashboard.url = `http://${config.dashboard.host}:${config.dashboard.port}`;

config.dsh.settingsPath = join(config.dsh.home, 'settings.yaml');
config.dsh.credentialsPath = join(config.dsh.home, '.credentials.yaml');
config.dsh.profileDir = join(config.dsh.home, 'profiles', 'desktop');

/**
 * 生成给桥进程用的环境变量（保持与桥读取的变量名一致）。
 *
 * @param {{ authFile?: string, autoCheckin?: boolean }} [overrides] 运行时覆盖：
 *   `authFile` 用于多账号切换；`autoCheckin` 来自 `.state.json` 的 `checkin.auto`
 *   ——桥侧的开关**要重启桥才生效**，所以这里只能启动时注入一次。
 */
export function bridgeEnv(overrides = {}) {
  return {
    ...process.env,
    WORKBUDDY_HOST: config.bridge.host,
    WORKBUDDY_PORT: String(config.bridge.port),
    WORKBUDDY_LOCAL_TOKEN: config.bridge.token,
    WORKBUDDY_ANTHROPIC_MODEL: config.bridge.anthropicModel,
    WORKBUDDY_ANTHROPIC_FAST_MODEL: config.bridge.anthropicFastModel,
    WORKBUDDY_APP_VERSION: config.bridge.appVersion,
    WORKBUDDY_IDE_VERSION: config.bridge.ideVersion,
    WORKBUDDY_IDE_NAME: config.bridge.ideName,
    WORKBUDDY_RATE_LIMIT_RPM: String(config.bridge.rateLimitRpm),
    WORKBUDDY_RATE_LIMIT_MIN_INTERVAL_MS: String(config.bridge.rateLimitMinIntervalMs),
    WORKBUDDY_RATE_LIMIT_MODE: config.bridge.rateLimitMode,
    WORKBUDDY_ACTIVE_ALERT_MS: String(config.bridge.activeAlertMs),
    WORKBUDDY_CLIENT_KEYS: config.bridge.clientKeys,
    WORKBUDDY_AUTH_FILE: overrides.authFile || config.workbuddy.authFile,
    // 探测不到时不注入空值 —— 桥会用自己的同款探测重新定位，而不是把
    // 一个空串当成"显式指定的路径"。
    ...(config.workbuddy.exe ? { WORKBUDDY_APP_EXECUTABLE: config.workbuddy.exe } : {}),
    WORKBUDDY_LOG: env.WORKBUDDY_LOG || '1',
    // 默认开；只有显式 false 才关
    WORKBUDDY_AUTO_CHECKIN: overrides.autoCheckin === false ? '0' : '1',
  };
}

export default config;
