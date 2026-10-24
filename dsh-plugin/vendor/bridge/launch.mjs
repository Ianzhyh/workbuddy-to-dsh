#!/usr/bin/env node
/**
 * 以统一配置独立启动桥（不经过控制台）。
 *
 * 控制台的「启动桥服务」走的是同一套环境变量（config.bridgeEnv()），
 * 因此两种启动方式的行为一致。
 */
import { spawn } from 'node:child_process';
import config, { bridgeEnv } from '../config.mjs';
import { effectiveAuthFile, readState } from '../lib/state.mjs';

if (!config.paths.bridgeScript) {
  console.error('找不到桥脚本。');
  process.exit(1);
}

/*
 * 与控制台/插件同一套账号选择：`.state.json` 里钉住的快照优先，并告诉桥
 * 「桌面活动登录文件」用于自动跟随换号。原实现直接 bridgeEnv()，独立启动
 * 的桥完全不认面板里的账号选择，和 dsh 插件各服务一个账号。
 */
const state = readState();
const authFile = effectiveAuthFile();
const pinned = typeof state.authFile === 'string' ? state.authFile : '';
const followAuthFile = pinned && pinned !== config.workbuddy.authFile ? 'auto' : '';
const followUid = pinned && typeof state.authFileDesktopUid === 'string' ? state.authFileDesktopUid : '';

console.log(`WorkBuddy 桥  ->  ${config.bridge.url}/v1`);
console.log(`登录文件      ->  ${authFile}${followAuthFile ? '（桌面换号时自动跟随）' : ''}`);

const child = spawn(process.execPath, [config.paths.bridgeScript], {
  cwd: config.paths.root,
  env: bridgeEnv({ authFile, followAuthFile, followUid }),
  stdio: 'inherit',
});

child.on('exit', (code) => process.exit(code ?? 0));
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => child.kill(/** @type {NodeJS.Signals} */ (sig)));
}
