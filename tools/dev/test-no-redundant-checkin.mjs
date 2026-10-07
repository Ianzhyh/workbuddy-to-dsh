/**
 * 回归：控制台**不再**定时打上游签到。
 *
 *   node tools/dev/test-no-redundant-checkin.mjs
 *
 * ## 为什么必须有这条
 *
 * 控制台原先有一条 hourly tick：先 GET 签到状态、再决定要不要 POST。
 * 但**每日签到已经由桥独占**（桥才是常驻的那一方），那条 tick 完全重复 ——
 * 而且每轮都要打一次上游 GET，**一天 24 次纯浪费**，签完之后也照打不误。
 *
 * 用户的直觉是对的：「检测到可签到不就直接签到，签完后就不需要检测了」。
 * 现在两条路径都是**直接 POST、不预检**，且各自有「当天成功就不再试」的闸门。
 *
 * ## 断言方式
 *
 * 起一个假上游 + 真桥 + 真控制台，**把桥自己的签到定时器推到很晚**，
 * 然后静置观察：假上游不该收到任何签到请求。旧代码会在控制台启动 3 秒后
 * 打一次 GET，这条断言就是冲着它去的。
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const UPSTREAM_PORT = 18897;
const BRIDGE_PORT = 18898;
const DASH_PORT = 18899;
const TOKEN = 'no-redundant-token';
const OBSERVE_MS = 12000;   // 观察窗口：旧代码会在 +3s 打一次，够抓到

const checkinCalls = [];

const upstream = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    if (/checkin/i.test(req.url)) checkinCalls.push(`${req.method} ${req.url}`);
    const send = (code, obj) => {
      const b = JSON.stringify(obj);
      res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) });
      res.end(b);
    };
    if (req.url.startsWith('/v3/config')) return send(200, { code: 0, data: { models: [] } });
    if (req.url.includes('checkin')) {
      return send(200, { code: 0, data: { active: true, today_checked_in: false, daily_credit: 100, credit: 100 } });
    }
    if (req.url.startsWith('/v2/billing')) return send(200, { code: 0, data: {} });
    send(200, { code: 0, data: {} });
  });
});
await new Promise((r) => upstream.listen(UPSTREAM_PORT, '127.0.0.1', r));

const dir = mkdtempSync(join(tmpdir(), 'wb-noredundant-'));
const authFile = join(dir, 'fake.info');
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
writeFileSync(authFile, JSON.stringify({
  account: { uin: '100000000000' },
  auth: {
    accessToken: `${b64({ alg: 'none' })}.${b64({ sub: 'u', exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`,
    refreshToken: 'r1',
    expiresAt: Date.now() + 3600_000,
    domain: 'copilot.tencent.com',
  },
}));

const baseEnv = {
  ...process.env,
  WORKBUDDY_LOCAL_TOKEN: TOKEN,
  WORKBUDDY_AUTH_FILE: authFile,
  CODEBUDDY_ENDPOINT: `http://127.0.0.1:${UPSTREAM_PORT}`,
  WORKBUDDY_BILLING_BASE: `http://127.0.0.1:${UPSTREAM_PORT}`,
  WORKBUDDY_LOG: '0',
  // 把桥自己的签到定时器推到观察窗口之外：这一轮只盯**控制台**有没有乱打
  WORKBUDDY_CHECKIN_KICK_MS: '600000',
  WORKBUDDY_CHECKIN_COOLDOWN_MS: '600000',
};

const bridge = spawn(process.execPath, ['bridge/workbuddy-bridge.mjs'], {
  env: { ...baseEnv, WORKBUDDY_PORT: String(BRIDGE_PORT) },
  stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
});
bridge.stdout.on('data', () => {}); bridge.stderr.on('data', () => {});

const dash = spawn(process.execPath, ['dashboard/server.mjs'], {
  env: {
    ...baseEnv,
    WORKBUDDY_PORT: String(BRIDGE_PORT),
    DASHBOARD_PORT: String(DASH_PORT),
    DASHBOARD_OPEN_BROWSER: '0',
    DASHBOARD_AUTO_START_BRIDGE: '0',   // 桥由本脚本自己起，避免控制台再拉一个
  },
  stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
});
const dashOut = [];
dash.stdout.on('data', (d) => dashOut.push(String(d)));
dash.stderr.on('data', (d) => dashOut.push(String(d)));

const cleanup = () => {
  for (const p of [bridge, dash]) { try { p.kill(); } catch { /* 已退 */ } }
  try { upstream.close(); } catch { /* 已关 */ }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
};
process.on('exit', cleanup);

// 等控制台就绪
let ready = false;
for (let i = 0; i < 80; i += 1) {
  await new Promise((r) => setTimeout(r, 250));
  try {
    const r = await fetch(`http://127.0.0.1:${DASH_PORT}/api/overview`, { signal: AbortSignal.timeout(3000) });
    if (r.ok) { ready = true; break; }
  } catch { /* 还没起来 */ }
}
if (!ready) {
  console.error('控制台没起来：\n' + dashOut.join('').slice(0, 600));
  cleanup(); process.exit(1);
}
console.log(`控制台已就绪（${DASH_PORT}），静置观察 ${OBSERVE_MS / 1000} 秒…`);
console.log('（旧代码会在控制台启动 3 秒后打一次上游 GET 签到状态）\n');

const baseline = checkinCalls.length;
await new Promise((r) => setTimeout(r, OBSERVE_MS));
const during = checkinCalls.slice(baseline);

let failures = 0;
console.log(`  观察窗口内假上游收到的签到请求：${during.length} 个`);
for (const c of during) console.log('    ' + c);

if (during.length === 0) {
  console.log('  ✓ 控制台没有定时打上游签到（检测环节已移除）');
} else {
  console.error(`  ✗ 控制台仍在打签到请求 —— 检测环节没删干净`);
  failures += 1;
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
cleanup();
process.exit(failures === 0 ? 0 : 1);
