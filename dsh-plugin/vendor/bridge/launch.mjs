#!/usr/bin/env node
/**
 * 以统一配置独立启动桥（不经过控制台）。
 *
 * 控制台的「启动桥服务」走的是同一套环境变量（config.bridgeEnv()），
 * 因此两种启动方式的行为一致。
 */
import { spawn } from 'node:child_process';
import config, { bridgeEnv } from '../config.mjs';

if (!config.paths.bridgeScript) {
  console.error('找不到桥脚本。');
  process.exit(1);
}

console.log(`WorkBuddy 桥  ->  ${config.bridge.url}/v1`);
console.log(`登录文件      ->  ${config.workbuddy.authFile}`);

const child = spawn(process.execPath, [config.paths.bridgeScript], {
  cwd: config.paths.root,
  env: bridgeEnv(),
  stdio: 'inherit',
});

child.on('exit', (code) => process.exit(code ?? 0));
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => child.kill(sig));
}
