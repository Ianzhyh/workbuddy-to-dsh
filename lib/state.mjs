/**
 * 运行时状态 —— 跨控制台重启保留的用户选择。
 *
 * 与 `.env` 的分工：`.env` 是**用户手写**的配置（端口、路径），本文件是
 * **程序写入**的运行时偏好（例如当前选中的账号）。两者分开，避免程序去改
 * 用户手写的配置。
 *
 * 存放在项目根的 `.state.json`，已被 .gitignore 忽略。
 */
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
export const statePath = () => process.env.WORKBUDDY_STATE_FILE || join(config.paths.root, '.state.json');
/** 同目录临时文件：必须与目标同分区，rename 才是原子的。 */
const tmpPath = () => `${statePath()}.tmp`;

let cache = null;

function load() {
  if (cache) return cache;
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
    writeFileSync(tmpPath(), `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    renameSync(tmpPath(), statePath());
  } catch {
    /* 只读介质上静默降级：状态不可持久化，但本次运行仍然生效 */
    try { if (existsSync(tmpPath())) rmSync(tmpPath()); } catch { /* 清理失败不影响主流程 */ }
  }
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

