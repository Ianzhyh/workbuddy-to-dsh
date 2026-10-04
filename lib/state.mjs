/**
 * 运行时状态 —— 跨控制台重启保留的用户选择。
 *
 * 与 `.env` 的分工：`.env` 是**用户手写**的配置（端口、路径），本文件是
 * **程序写入**的运行时偏好（例如当前选中的账号）。两者分开，避免程序去改
 * 用户手写的配置。
 *
 * 存放在项目根的 `.state.json`，已被 .gitignore 忽略。
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import config from '../config.mjs';

const STATE_PATH = join(config.paths.root, '.state.json');

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
    writeFileSync(STATE_PATH, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  } catch {
    /* 只读介质上静默降级：状态不可持久化，但本次运行仍然生效 */
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
