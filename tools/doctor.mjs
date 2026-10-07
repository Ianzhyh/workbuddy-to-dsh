#!/usr/bin/env node
/**
 * 命令行自检 —— 无图形界面时的等价诊断。
 *
 *   node tools/doctor.mjs           人类可读
 *   node tools/doctor.mjs --json    机器可读
 *
 * 与控制台页面的「环境诊断」共用 lib/diagnostics.mjs，结论必然一致。
 */
import config from '../config.mjs';
import { diagnose } from '../lib/diagnostics.mjs';

const asJson = process.argv.includes('--json');
const useColor = !asJson && process.stdout.isTTY;

const C = {
  reset: '\u001b[0m',
  dim: '\u001b[2m',
  bold: '\u001b[1m',
  red: '\u001b[31m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  cyan: '\u001b[36m',
};

const paint = (text, color) => (useColor ? `${color}${text}${C.reset}` : text);

const MARK = {
  ok: { sym: '[✓]', color: C.green },
  warn: { sym: '[!]', color: C.yellow },
  fail: { sym: '[✗]', color: C.red },
};

const result = await diagnose();

if (asJson) {
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.summary.fail > 0 ? 1 : 0);
}

console.log(paint('WorkBuddy 中转自检', C.bold));
console.log(paint('─'.repeat(64), C.dim));
console.log(`${paint('配置根', C.dim)}      ${config.paths.root}`);
console.log(`${paint('桥', C.dim)}          ${config.bridge.url}/v1`);
console.log(`${paint('控制台', C.dim)}      ${config.dashboard.url}`);
console.log(`${paint('登录文件', C.dim)}    ${config.workbuddy.authFile}`);
console.log(`${paint('WorkBuddy', C.dim)}   ${config.workbuddy.exe || '（未自动定位，见下方诊断）'}`);
console.log(`${paint('dsh 运行时', C.dim)}  ${config.dsh.runtime}`
  + (config.dsh.desktopVersion ? `  (DSH ${config.dsh.desktopVersion})` : ''));
console.log('');

for (const item of result.items) {
  const mark = MARK[item.status];
  const label = item.label.padEnd(18, ' ');
  console.log(`${paint(mark.sym, mark.color)} ${paint(label, C.bold)} ${item.detail}`);
  if (item.hint) {
    console.log(`      ${paint('└ 建议：' + item.hint, C.yellow)}`);
  }
}

console.log('');
const { ok, warn, fail } = result.summary;
const verdict = fail > 0
  ? paint('存在必须修复的问题，模型不会出现在 dsh 的模型选择器里。', C.red)
  : warn > 0
    ? paint('可以工作，但有需要留意的项。', C.yellow)
    : paint('全部通过。', C.green);
console.log(`${paint('结果', C.bold)}  ${ok} 项通过 / ${warn} 项警告 / ${fail} 项失败 —— ${verdict}`);

process.exit(fail > 0 ? 1 : 0);
