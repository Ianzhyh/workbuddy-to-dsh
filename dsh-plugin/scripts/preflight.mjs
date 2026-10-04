/**
 * 环境自检：在一台**新机器**上装好后先跑这个。
 *
 *   node dsh-plugin/scripts/preflight.mjs
 *   node dsh-plugin/scripts/preflight.mjs --json     # 机器可读
 *
 * 它只读不写（除了可选地探测端口），逐项告诉你「行不行 / 为什么 / 怎么修」：
 *   1. Node 版本
 *   2. 插件要用的脚本在哪（仓库检出 / 自带 vendor）
 *   3. WorkBuddy 桌面端与登录文件（没有登录文件的话桥起不来）
 *   4. 端口 8790 / 8792 是否可用（占用者是自己的进程还是别的软件）
 *   5. 桥是否在跑、能列出多少模型、积分多少
 *   6. 插件装进了哪些 dsh profile
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 直接复用插件自己的解析逻辑，保证"自检结论"和"插件实际行为"一致
import { detectProjectRoot, readProjectEnv } from '../lib/index.js';
import { CONSOLE_TITLE } from '../lib/console.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = dirname(HERE);
const JSON_OUT = process.argv.includes('--json');
const DEFAULT_TOKEN = 'wb-local-bridge';

const results = [];
const record = (level, title, detail, fix) => results.push({ level, title, detail, fix });

/** 1. Node */
const nodeMajor = Number(process.versions.node.split('.')[0]);
record(nodeMajor >= 18 ? 'ok' : 'bad', `Node.js ${process.versions.node}`,
  nodeMajor >= 18 ? '满足 >= 18' : '版本过低，dsh 插件要求 Node 18 以上',
  nodeMajor >= 18 ? null : '安装 Node 18+（建议 20/22 LTS）后重开终端');

/** 2. 脚本位置：仓库检出优先，其次插件自带 vendor（与插件同一个函数） */
const BRIDGE_REL = join('bridge', 'workbuddy-bridge.mjs');
const CONSOLE_REL = join('dashboard', 'server.mjs');
const candidatePaths = [
  { path: dirname(PLUGIN_DIR), label: '仓库检出目录（插件就在仓库里）' },
  { path: join(PLUGIN_DIR, 'vendor'), label: '插件自带 vendor/（分发副本）' },
];
const projectRoot = detectProjectRoot();
if (!projectRoot) {
  record('bad', '桥脚本位置', `既没在仓库旁边找到，也没有 vendor/（找过：${candidatePaths.map((c) => c.path).join(' / ')}）`,
    '在仓库里运行 `npm run vendor` 生成自带副本，或把插件装在仓库的 dsh-plugin/ 子目录下；也可以用插件配置 projectRoot 指定路径');
} else {
  const which = candidatePaths.find((c) => c.path === projectRoot);
  record('ok', '运行目录（projectRoot）', `${which ? which.label : '探测结果'}：${projectRoot}`, null);
  for (const [rel, name] of [[BRIDGE_REL, '桥'], [CONSOLE_REL, '控制台']]) {
    const ok = existsSync(join(projectRoot, rel));
    record(ok ? 'ok' : 'bad', `${name}脚本`, join(projectRoot, rel),
      ok ? null : '重新跑 `npm run vendor`，或检查仓库是否完整');
  }
  const envFile = join(projectRoot, '.env');
  record(existsSync(envFile) ? 'ok' : 'warn', '.env 配置',
    existsSync(envFile) ? envFile : '没有 .env（会用内置默认：桥 8790 / 控制台 8792）',
    existsSync(envFile) ? null : '需要改端口或登录文件时：复制 .env.example 为 .env 再改');
}

/** 解析 .env：与插件同一套（process.env 优先，其次 projectRoot/.env） */
const env = projectRoot ? readProjectEnv(projectRoot) : {};
const pick = (key, fallback) => process.env[key] || env[key] || fallback;

/** 3. WorkBuddy 桌面端 + 登录文件 */
const authDirs = [
  process.env.WORKBUDDY_AUTH_DIR,
  join(process.env.LOCALAPPDATA || '', 'CodeBuddyExtension', 'Data', 'Public', 'auth'),
  join(homedir(), 'AppData', 'Local', 'CodeBuddyExtension', 'Data', 'Public', 'auth'),
].filter(Boolean);
const authDir = authDirs.find((d) => existsSync(d));
if (!authDir) {
  record('bad', 'WorkBuddy 登录文件', `找不到登录目录（找过：${authDirs.join(' / ')}）`,
    '先安装并登录 WorkBuddy 桌面端；绿色版/自定义安装位置的话，在 .env 里设 WORKBUDDY_AUTH_DIR');
} else {
  const infos = readdirSync(authDir).filter((f) => f.endsWith('.info'));
  record(infos.length ? 'ok' : 'bad', 'WorkBuddy 登录文件',
    `${authDir}（${infos.length} 个：${infos.join('、') || '空'}）`,
    infos.length ? null : '在 WorkBuddy 桌面端登录一次账号');
  const active = process.env.WORKBUDDY_AUTH_FILE || (existsSync(join(authDir, 'workbuddy-desktop.info')) ? join(authDir, 'workbuddy-desktop.info') : '');
  if (active) {
    const raw = readFileSync(active, 'utf8').trim();
    const encrypted = raw.startsWith('{') || raw.startsWith('v10') || !raw.includes('"');
    record('ok', '当前使用的登录文件', `${active}（${encrypted ? 'AtRest 信封/加密' : '明文 JSON'}）`, null);
  } else {
    record('warn', '当前使用的登录文件', '没找到默认的 workbuddy-desktop.info',
      '在 .env 里用 WORKBUDDY_AUTH_FILE 指定具体文件（多账号时用得上）');
  }
}

/** 4. 端口与"那是不是我们自己的进程"
 *  桥：/health 带 Bearer 才回 200（顺便验证 token 对不对）
 *  控制台：没有 /health 路由，靠首页标题识别 —— 与插件判定方式一模一样
 */
const bridgePort = Number(pick('WORKBUDDY_PORT', 8790));
const consolePort = Number(pick('DASHBOARD_PORT', 8792));
const token = pick('WORKBUDDY_LOCAL_TOKEN', DEFAULT_TOKEN);

const probeBridge = async (port) => {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(2500),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok && body && (body.ok !== undefined || body.pid !== undefined)) {
      return { state: 'ours', note: body.pid ? `pid ${body.pid}` : '' };
    }
    // 桥活着但**登录凭据读不出来**时 /health 回 503（body 里带 authFile 与原因）。
    // 这与"端口上是别的服务"完全不同，必须分开报 —— 否则用户会去找不存在的端口冲突。
    if (body && body.ok === false
      && (body.authFile !== undefined || /login|sign in|credential|凭据|登录/i.test(String(body.error || '')))) {
      return { state: 'degraded', note: String(body.error || '登录凭据读不出来'), authFile: body.authFile };
    }
    if (res.status === 401) return { state: 'other', note: 'HTTP 401（有服务在，但鉴权不过：可能 token 不对或不是本项目的桥）' };
    return { state: 'other', note: `HTTP ${res.status}` };
  } catch {
    return { state: 'free', note: '' };
  }
};
const probeConsole = async (port) => {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2500) });
    const html = await res.text().catch(() => '');
    if (html.includes(CONSOLE_TITLE)) return { state: 'ours', note: '首页标题匹配' };
    return { state: 'other', note: `HTTP ${res.status}（响应里没有控制台标题）` };
  } catch {
    return { state: 'free', note: '' };
  }
};
const bridgePortState = await probeBridge(bridgePort);
const consolePortState = await probeConsole(consolePort);
record(bridgePortState.state === 'other' ? 'warn' : bridgePortState.state === 'degraded' ? 'warn' : 'ok', `端口 ${bridgePort}（桥）`,
  bridgePortState.state === 'ours' ? `本项目的桥在跑（${bridgePortState.note || '已响应'}）`
    : bridgePortState.state === 'degraded' ? `本项目的桥在跑，但读不出登录凭据：${bridgePortState.note}${bridgePortState.authFile ? `（${bridgePortState.authFile}）` : ''}`
      : bridgePortState.state === 'other' ? `被别的服务占用：${bridgePortState.note}`
        : '空闲（插件会在加载时拉起桥）',
  bridgePortState.state === 'degraded' ? '打开 WorkBuddy 桌面端重新登录一次；多账号时在 .env 里用 WORKBUDDY_AUTH_FILE 指定具体文件'
    : bridgePortState.state === 'other' ? '在 .env 里换一个 WORKBUDDY_PORT' : null);
record(consolePortState.state === 'other' ? 'warn' : 'ok', `端口 ${consolePort}（控制台）`,
  consolePortState.state === 'ours' ? `本项目的控制台在跑（${consolePortState.note}）`
    : consolePortState.state === 'free' ? '空闲（需要时插件会拉起控制台）'
      : `被别的服务占用：${consolePortState.note}`,
  consolePortState.state === 'other' ? '在 .env 里换一个 DASHBOARD_PORT' : null);

/** 5. 桥能不能用 */
if (bridgePortState.state === 'ours' || bridgePortState.state === 'degraded') {
  try {
    const headers = { authorization: `Bearer ${token}` };
    const models = await (await fetch(`http://127.0.0.1:${bridgePort}/v1/models`, { headers, signal: AbortSignal.timeout(5000) })).json();
    const count = Array.isArray(models) ? models.length : (models.data || []).length;
    record(count > 0 ? 'ok' : 'warn', '模型目录', `桥报告 ${count} 个模型`, count > 0 ? null : '桥连上了但目录为空：检查 WorkBuddy 登录是否过期');
    const quota = await (await fetch(`http://127.0.0.1:${bridgePort}/v1/quota`, { headers, signal: AbortSignal.timeout(8000) })).json();
    record('ok', '积分', typeof quota.total === 'number' ? `余额 ${quota.total}（${(quota.packages || []).length} 个套餐）` : '已读取（无 total 字段）', null);
  } catch (error) {
    record('warn', '桥接口', `调用失败：${error.message}`, '看 bridge/bridge.log 的最后几行');
  }
} else {
  record('info', '桥未运行', '这不是错误：插件加载时会自动拉起（已在跑就复用）', '也可以手动 `node bridge/workbuddy-bridge.mjs`');
}

/** 6. 装进了哪些 dsh profile */
const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh');
const profilesDir = join(dshHome, 'profiles');
if (!existsSync(profilesDir)) {
  record('warn', 'dsh profile', `${profilesDir} 不存在`, `确认 DSH_HOME（当前 ${dshHome}）；dsh 桌面版一般是 ~/.dsh`);
} else {
  const installed = [];
  for (const name of readdirSync(profilesDir)) {
    const pkgPath = join(profilesDir, name, 'package.json');
    if (!existsSync(pkgPath)) continue;
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      if (pkg.dependencies && pkg.dependencies['dsh-plugin-workbuddy']) {
        installed.push(`${name}（${pkg.dependencies['dsh-plugin-workbuddy']}）`);
      }
    } catch { /* 忽略坏 JSON */ }
  }
  record(installed.length ? 'ok' : 'warn', '插件安装情况',
    installed.length ? `已装进：${installed.join('，')}` : '没有 profile 依赖 dsh-plugin-workbuddy',
    installed.length ? null : '在 dsh 里用「设置 → 插件 → 安装」指向本目录，或 `dsh plugin --profile <名字> add <本目录>`');
}

/** 输出 */
const ICON = { ok: '✅', warn: '⚠️ ', bad: '❌', info: 'ℹ️ ' };
const bad = results.filter((r) => r.level === 'bad');
const warn = results.filter((r) => r.level === 'warn');
if (JSON_OUT) {
  console.log(JSON.stringify({ projectRoot, node: process.versions.node, results, summary: { bad: bad.length, warn: warn.length } }, null, 2));
} else {
  console.log('\nWorkBuddy 插件环境自检\n' + '─'.repeat(60));
  for (const r of results) {
    console.log(`${ICON[r.level]} ${r.title}`);
    if (r.detail) console.log(`     ${r.detail}`);
    if (r.fix) console.log(`     ↳ 修法：${r.fix}`);
  }
  console.log('─'.repeat(60));
  console.log(bad.length
    ? `❌ ${bad.length} 项必须处理${warn.length ? `，另有 ${warn.length} 项建议` : ''}`
    : `✅ 关键项全部通过${warn.length ? `（${warn.length} 项建议看一下）` : ''}`);
  if (projectRoot) console.log(`\n插件会用的目录：${projectRoot}`);
  console.log('装好后：重启一次 dsh（宿主端改动需要重启才生效），然后在 设置 → WorkBuddy 里看状态。\n');
}
process.exit(bad.length ? 1 : 0);
