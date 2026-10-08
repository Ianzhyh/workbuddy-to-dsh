/**
 * 统一配置 —— 全项目唯一的配置真源。
 *
 * 优先级：进程环境变量 > `.env` 文件 > 内置默认值。
 * 桥进程（bridge/workbuddy-bridge.mjs）不直接引用本模块，而是由控制台在
 * spawn 时注入同样的环境变量，从而保持桥的单文件自包含特性；两边使用的
 * 变量名以本文件为准。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
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
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
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

export const config = {
  bridge: {
    host: env.WORKBUDDY_HOST || '127.0.0.1',
    port: Number(env.WORKBUDDY_PORT || 8790),
    /** 本地回环令牌，仅用于防止同机其它程序误用；并非上游凭据。 */
    token: env.WORKBUDDY_LOCAL_TOKEN || 'wb-local-bridge',
    upstreamTimeoutMs: Number(env.WORKBUDDY_TIMEOUT_MS || 0),
    /**
     * 积分余额的缓存时长（毫秒）。
     *
     * 积分要打上游计费网关，控制台每 20 秒轮询一次总览 —— 不加缓存等于每 20 秒
     * 打一次计费端点，既没必要也容易触发限流。默认 60 秒。
     *
     * 调小可以让页面更快反映余额变化（签到后等），代价是更频繁的上游查询；
     * 自动化测试也用它来构造「缓存已过期但仍有旧值」这条分支，不必真等 60 秒。
     */
    quotaTtlMs: Number(env.WORKBUDDY_QUOTA_TTL_MS || 60 * 1000),
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
  },
  dashboard: {
    host: '127.0.0.1',
    port: Number(env.DASHBOARD_PORT || 8792),
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
