#!/usr/bin/env node
/**
 * 命令行自检 —— 无图形界面时的等价诊断。
 *
 *   node tools/doctor.mjs           人类可读
 *   node tools/doctor.mjs --json    机器可读
 *
 * 与控制台页面的「环境诊断」共用 lib/diagnostics.mjs，结论必然一致。
 */
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import config from '../config.mjs';
import {
  diagnose, bridgeHealth, bridgeRequests, fileBuildHash,
} from '../lib/diagnostics.mjs';

const asBundle = process.argv.includes('--bundle');
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

if (asBundle) {
  /*
   * 可分享的诊断包：只含版本、路径、运行状态与失败归因，不含令牌、密钥、
   * 请求/响应正文。路径里的家目录替换成 ~，账号只留前 8 位。
   */
  const redactPath = (value) => {
    const text = String(value || '');
    const home = process.env.USERPROFILE || process.env.HOME || '';
    return home && text.startsWith(home) ? `~${text.slice(home.length)}` : text;
  };
  const maskId = (value) => {
    const text = String(value || '');
    return text ? `${text.slice(0, 8)}${text.length > 8 ? '…' : ''}` : '';
  };
  const versionOf = (file) => {
    try { return JSON.parse(readFileSync(file, 'utf8')).version || ''; } catch { return ''; }
  };
  const health = await bridgeHealth(3000).catch((e) => ({ running: false, error: String(e?.message || e) }));
  const requests = await bridgeRequests(20).catch(() => ({ requests: [] }));
  const body = health?.body || {};
  const bundle = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    environment: {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      dshDesktop: config.dsh.desktopVersion || null,
    },
    versions: {
      root: versionOf(join(config.paths.root, 'package.json')),
      plugin: versionOf(join(config.paths.root, 'dsh-plugin', 'package.json')),
      bridgeBuild: body.build || '',
    },
    paths: {
      root: redactPath(config.paths.root),
      data: redactPath(config.paths.data),
      authFile: basename(config.workbuddy.authFile || ''),
      vendorBridge: existsSync(join(config.paths.root, 'dsh-plugin', 'vendor', 'bridge', 'workbuddy-bridge.mjs')),
    },
    vendor: {
      bridgeHash: fileBuildHash(join(config.paths.root, 'dsh-plugin', 'vendor', 'bridge', 'workbuddy-bridge.mjs')),
      dashboardHash: fileBuildHash(join(config.paths.root, 'dsh-plugin', 'vendor', 'dashboard', 'public', 'index.html')),
    },
    config: {
      bridgeHost: config.bridge.host,
      bridgePort: config.bridge.port,
      dashboardPort: config.dashboard.port,
      credentialSource: config.workbuddy.credentialSource || 'auto',
      loginRegion: config.workbuddy.loginRegion || '',
      anthropicModel: config.bridge.anthropicModel || '',
      responsesModel: config.bridge.responsesModel || '',
      contextWindow: config.bridge.contextWindow || null,
      rateLimitRpm: config.bridge.rateLimitRpm,
    },
    bridge: health?.running ? {
      ok: health.ok === true,
      error: health.error || '',
      pid: body.pid ?? null,
      uptimeMs: body.uptimeMs ?? null,
      catalogSize: body.catalogSize ?? null,
      catalogAt: body.catalogAt || null,
      auth: body.auth ? {
        source: body.auth.source || '',
        region: body.auth.region || '',
        userId: maskId(body.auth.userId),
        expiresAt: body.auth.expiresAt || '',
      } : null,
    } : {
      ok: false,
      error: health?.error || 'bridge not running',
    },
    diagnostics: result.items.map((item) => ({
      id: item.id, label: item.label, status: item.status, hint: redactPath(item.hint || ''),
    })),
    recentFailures: (requests?.requests || [])
      .filter((r) => r && r.ok === false && r.probe !== true)
      .slice(0, 10)
      .map((r) => ({
        t: r.t,
        model: r.model || '',
        status: r.status || 0,
        code: r.code ?? null,
        failureKind: r.failureKind || '',
        retryable: r.retryable === true,
      })),
  };
  console.log(JSON.stringify(bundle, null, 2));
  // 不在这里 process.exit：桥健康/请求探测用的是 fetch，Windows 上
  // Node 24 在还有 async handle 收尾时硬退出会触发 libuv 断言
  // （Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)）。
  // 设 exitCode 后走自然退出；下面的普通输出分支用 !asBundle 挡住。
  process.exitCode = 0;
}

if (!asBundle) {
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
console.log(`${paint('dsh 运行时', C.dim)}  ${config.dsh.runtime || '（未自动定位，可用 DSH_RUNTIME 指定）'}`
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
}
