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

const STATE_PATH = join(config.paths.root, '.state.json');
/** 同目录临时文件：必须与目标同分区，rename 才是原子的。 */
const TMP_PATH = `${STATE_PATH}.tmp`;

let cache = null;

function load() {
  if (cache) return cache;
  try {
    cache = existsSync(STATE_PATH) ? JSON.parse(readFileSync(STATE_PATH, 'utf8')) : {};
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
    writeFileSync(TMP_PATH, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    renameSync(TMP_PATH, STATE_PATH);
  } catch {
    /* 只读介质上静默降级：状态不可持久化，但本次运行仍然生效 */
    try { if (existsSync(TMP_PATH)) rmSync(TMP_PATH); } catch { /* 清理失败不影响主流程 */ }
  }
  return { ...next };
}

export function clearState() {
  cache = {};
  try {
    if (existsSync(STATE_PATH)) rmSync(STATE_PATH);
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

export const statePath = STATE_PATH;
