/**
 * 运行时状态 —— 跨控制台重启保留的用户选择。
 *
 * 与 `.env` 的分工：`.env` 是**用户手写**的配置（端口、路径），本文件是
 * **程序写入**的运行时偏好（例如当前选中的账号）。两者分开，避免程序去改
 * 用户手写的配置。
 *
 * 存放在项目根的 `.state.json`，已被 .gitignore 忽略。
 */
import {
  existsSync, readFileSync, renameSync, rmSync, writeFileSync, mkdirSync, copyFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import config from '../config.mjs';

/**
 * 状态文件路径。
 *
 * 默认是仓库根的 `.state.json`（**运行时真实状态**），可用 `WORKBUDDY_STATE_FILE`
 * 覆盖 —— **测试必须用它**。
 *
 * 为什么不能只靠「备份 + 恢复」：控制台 / 插件在跑的时候会**周期性写这个文件**，
 * 于是「删掉再断言它不存在」的用例会被 live 进程重新创建出来而偶发失败。
 * （实测：单独跑 `npm run test:lib` 全过，放进 `release:check` 链里偶发红，
 * 而且失败时 `clearState()` 重试也删不掉 —— 因为不是锁，是有人在写。）
 *
 * 做成**函数**而不是常量：测试要在 `import` 之后才能设环境变量（ESM 的 import
 * 会被提升，没法在导入前设），所以这里必须**每次调用时**再读一次。
 */
function runtimeDataDir() {
  const explicit = process.env.WORKBUDDY_DATA_DIR;
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim();
  return join(homedir(), '.workbuddy-bridge');
}

export const statePath = () => process.env.WORKBUDDY_STATE_FILE
  || join(runtimeDataDir(), 'state.json');
/** 同目录临时文件：必须与目标同分区，rename 才是原子的。 */
const tmpPath = () => `${statePath()}.tmp`;

let cache = null;
let migrated = false;

/**
 * 旧版 `.state.json` 在安装目录里（`config.paths.root`）。升级/重装会把
 * 安装目录整个换掉，账号钉住、签到开关、体检结论一起丢。首次读到新路径
 * 不存在时，从旧路径复制一份过去；只复制不删除，保留回滚余地。
 *
 * `WORKBUDDY_STATE_FILE` 显式指定时不迁移 —— 测试和便携部署要的就是
 * “只认我给的路径”。
 */
function migrateStateIfNeeded() {
  if (migrated) return;
  migrated = true;
  if (process.env.WORKBUDDY_STATE_FILE) return;
  const target = statePath();
  if (existsSync(target)) return;
  const legacy = join(config.paths.root, '.state.json');
  if (!existsSync(legacy) || legacy === target) return;
  try {
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(legacy, target);
  } catch { /* 迁移失败就按空状态启动；不阻塞主流程 */ }
}

function load() {
  if (cache) return cache;
  migrateStateIfNeeded();
  try {
    cache = existsSync(statePath()) ? JSON.parse(readFileSync(statePath(), 'utf8')) : {};
  } catch {
    cache = {};
  }
  if (typeof cache !== 'object' || cache === null || Array.isArray(cache)) cache = {};
  return cache;
}

export function readState() {
  return { ...load() };
}

export function writeState(patch) {
  const next = { ...load(), ...patch };
  for (const [k, v] of Object.entries(next)) {
    if (v === undefined || v === null) delete next[k];
  }
  cache = next;
  try {
    /*
     * 原子写：先落临时文件、再 rename 覆盖。
     *
     * 原先直接 `writeFileSync(STATE_PATH, ...)`。进程在写入中途被杀、或磁盘写满时，
     * 会留下半截 JSON —— 下次 `load()` 的 try/catch 会**静默退回 `{}`**，
     * 用户当前选中的账号、签到开关、体检结论一起丢失，而界面上没有任何异常提示。
     * rename 在同一分区的 POSIX/NTFS 上是原子的：要么旧内容、要么新内容，
     * 不存在"读到一个写坏的中间态"。
     */
    mkdirSync(dirname(statePath()), { recursive: true });
    writeFileSync(tmpPath(), `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    renameSync(tmpPath(), statePath());
  } catch {
    /* 只读介质上静默降级：状态不可持久化，但本次运行仍然生效 */
    try { if (existsSync(tmpPath())) rmSync(tmpPath()); } catch { /* 清理失败不影响主流程 */ }
  }
  return { ...next };
}

/**
 * 严格写：写不进去就**抛错**，不静默降级。
 *
 * 切号流程必须在停桥之前确认「账号选择真的落盘」—— 用 {@link writeState}
 * 时磁盘失败没人知道，于是桥停了、状态还是旧的，重启后账号又跳回去。
 * 这里在写完后**读回磁盘**核对（只信磁盘，不信内存缓存）。
 */
export function writeStateStrict(patch) {
  const next = { ...load(), ...patch };
  for (const [k, v] of Object.entries(next)) {
    if (v === undefined || v === null) delete next[k];
  }
  mkdirSync(dirname(statePath()), { recursive: true });
  try {
    writeFileSync(tmpPath(), `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    renameSync(tmpPath(), statePath());
    JSON.parse(readFileSync(statePath(), 'utf8'));
  } catch (error) {
    try { if (existsSync(tmpPath())) rmSync(tmpPath()); } catch { /* 忽略 */ }
    throw error;
  }
  cache = next;
  return { ...next };
}

export function clearState() {
  cache = {};
  try {
    if (existsSync(statePath())) rmSync(statePath());
  } catch {
    /* 同上 */
  }
}

/**
 * 账号列表的**自定义顺序**（登录文件名数组）。没列进去的文件按默认顺序排在后面。
 *
 * 键用**文件名**而不是 uin：顺序是"哪一行排在哪"的问题，行由文件决定
 * （同一账号的两份快照是两行，要能分别排）。
 */
export function readAccountOrder() {
  const list = load().accountOrder;
  if (!Array.isArray(list)) return [];
  return list.filter((f) => typeof f === 'string' && f.trim()).map((f) => f.trim());
}

/** 保存账号顺序。传空数组 = 清掉（恢复默认排序）。返回写入后的顺序。 */
export function writeAccountOrder(files) {
  const seen = new Set();
  const list = (Array.isArray(files) ? files : [])
    .filter((f) => typeof f === 'string' && f.trim())
    .map((f) => f.trim())
    .filter((f) => (seen.has(f) ? false : (seen.add(f), true)));
  writeState({ accountOrder: list.length ? list : null });
  return readAccountOrder();
}

/**
 * 被**隐藏**（从列表里不显示）的账号文件。
 *
 * 为什么是"隐藏"而不是删文件：登录目录是 **WorkBuddy 客户端自己的**数据，
 * 里面那份 `.info` 就是客户端的登录态。我们只读它（见 SECURITY.md 的硬约束），
 * 删掉会把人家的客户端登出 —— 那是不可逆的破坏，不该由一个"整理列表"的按钮触发。
 * 隐藏只写我们自己的 `.state.json`，随时可恢复。
 */
export function readHiddenAccounts() {
  const list = load().hiddenAccounts;
  if (!Array.isArray(list)) return [];
  return list.filter((f) => typeof f === 'string' && f.trim()).map((f) => f.trim());
}

/** 隐藏 / 恢复一个账号文件。返回写入后的整表。 */
export function writeAccountHidden(file, hidden) {
  const name = typeof file === 'string' ? file.trim() : '';
  if (!name) return readHiddenAccounts();
  const set = new Set(readHiddenAccounts());
  if (hidden) set.add(name);
  else set.delete(name);
  const list = [...set];
  writeState({ hiddenAccounts: list.length ? list : null });
  return readHiddenAccounts();
}

/**
 * 实际生效的登录文件：运行时选择优先，否则回落到配置探测出的默认值。
 */
export function effectiveAuthFile() {
  const chosen = load().authFile;
  return typeof chosen === 'string' && chosen ? chosen : config.workbuddy.authFile;
}

/**
 * 账号自定义名字表：`{ [账号标识]: 名字 }`。
 *
 * ## 键为什么用「账号标识」而不是登录文件名
 *
 * 客户端换账号时会把**同名**登录文件原地覆盖（只有「登出」那条路才会把旧文件
 * 改名成快照，见 `docs/TROUBLESHOOTING.md`）。所以文件名会指向"另一个账号"，
 * 按文件名记名字必然张冠李戴 —— 用户给 A 起的名字，换号后贴在 B 身上。
 * 账号标识取 uin（读不出时退回 `claims.sub`，再退回文件名），换号不影响。
 *
 * 同一个账号可能同时有多份文件（快照），按标识记账让它们**共用一个名字** ——
 * 这正是用户想要的（"这两个文件是同一个号"）。
 */
export function readAccountAliases() {
  const map = load().accountAliases;
  if (typeof map !== 'object' || map === null || Array.isArray(map)) return {};
  const out = {};
  for (const [key, value] of Object.entries(map)) {
    if (typeof value === 'string' && value.trim()) out[key] = value.trim();
  }
  return out;
}

/**
 * 给某个账号设名字；`alias` 传空 = **删掉**这个名字（恢复显示 uin）。
 *
 * 为什么整表重写而不是往嵌套对象里塞一个键：`writeState` 是**顶层**合并语义
 * （它只剔除顶层的 null/undefined），嵌套对象的删键它管不到 —— 只传
 * `{ accountAliases: { [key]: null } }` 会在磁盘上留一个 `"key": null`，
 * 下次读出来又得再过滤一遍。整表读写只有一处真源，没有中间态。
 *
 * @returns {Record<string, string>} 写入后的整表（已落盘的那份）
 */
export function writeAccountAlias(key, alias) {
  const id = typeof key === 'string' ? key.trim() : '';
  if (!id) return readAccountAliases();
  const next = readAccountAliases();
  const name = typeof alias === 'string' ? alias.replace(/\s+/gu, ' ').trim().slice(0, 24) : '';
  if (name) next[id] = name;
  else delete next[id];
  // 空表就把整个键删掉（传 null，writeState 会剔除）—— 别在 .state.json 里留一个 {}。
  writeState({ accountAliases: Object.keys(next).length ? next : null });
  return readAccountAliases();
}

