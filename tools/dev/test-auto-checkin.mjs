/**
 * 回归：桥**不发模型请求也能自己签到**。
 *
 *   node tools/dev/test-auto-checkin.mjs
 *
 * ## 为什么必须有这条
 *
 * 签到原先只挂在 `/v1/chat/completions` 开头 —— 「有人调模型」才顺带签一次。
 * 但**桥才是常驻后台的那个进程**，用户完全可能一整天不调模型。
 * 实测就撞上了：桥从 13:03 一直跑着，一整天零模型请求，于是**一次签到都没发生**，
 * 用户晚上打开控制台才发现还得手动签。
 *
 * 所以断言的是**「一个 chat 请求都不发，签到也必须发生」** —— 这正是原实现缺的。
 *
 * 用假上游，不消耗真实额度。
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const UPSTREAM_PORT = 18895;
const BRIDGE_PORT = 18896;
const TOKEN = 'checkin-test-token';
const KICK_MS = 1500;   // 缩短启动延迟，测试不必真等 20 秒

let chatRequests = 0;   // 关键：必须保持 0
let checkinPosts = 0;

const upstream = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const send = (code, obj) => {
      const b = JSON.stringify(obj);
      res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) });
      res.end(b);
    };
    // 目录
    if (req.url.startsWith('/v3/config')) return send(200, { code: 0, data: { models: [] } });
    if (req.url.startsWith('/v2/plugin/auth/token/refresh')) {
      return send(200, { code: 0, data: { accessToken: 'a2', refreshToken: 'r2', expiresIn: 3600, refreshExpiresIn: 3600 } });
    }
    // 签到：先查状态，再领取
    // 注意路径是 `daily-checkin`（连字符）与 `checkin-activity-status` ——
    // 判据只能是 `includes('checkin')`，写成 `includes('/checkin')` 永远匹配不上，
    // 会静默落到下面的 billing 分支（表现为「签到成功但 credit 恒为 0」）。
    if (req.url.includes('checkin')) {
      if (req.method === 'GET') {
        return send(200, { code: 0, data: { activityEnabled: true, todayCheckedIn: false, dailyCredit: 100 } });
      }
      checkinPosts += 1;
      return send(200, { code: 0, data: { credit: 100, already: false } });
    }
    if (req.url.startsWith('/v2/chat/completions')) { chatRequests += 1; return send(200, { code: 0, data: {} }); }
    if (req.url.startsWith('/v2/billing')) return send(200, { code: 0, data: { capacityRemain: 0, packages: [] } });
    send(404, { code: 404 });
  });
});
await new Promise((r) => upstream.listen(UPSTREAM_PORT, '127.0.0.1', r));

const dir = mkdtempSync(join(tmpdir(), 'wb-checkin-'));
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

const bridge = spawn(process.execPath, ['bridge/workbuddy-bridge.mjs'], {
  env: {
    ...process.env,
    WORKBUDDY_PORT: String(BRIDGE_PORT),
    WORKBUDDY_LOCAL_TOKEN: TOKEN,
    WORKBUDDY_AUTH_FILE: authFile,
    CODEBUDDY_ENDPOINT: `http://127.0.0.1:${UPSTREAM_PORT}`,
    /*
     * **必须显式指定计费网关**：`billingBase()` 对非 codebuddy/workbuddy 域名会
     * 硬编码回 `https://www.codebuddy.cn` —— 不设这个的话，签到请求会打到**真实上游**
     * （第一版就是这样，表现为「签到 POST 次数 0 + HTTP 500」，因为假上游根本没收到）。
     */
    WORKBUDDY_BILLING_BASE: `http://127.0.0.1:${UPSTREAM_PORT}`,
    WORKBUDDY_CHECKIN_KICK_MS: String(KICK_MS),
    WORKBUDDY_LOG: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
const logLines = [];
bridge.stdout.on('data', (d) => logLines.push(String(d)));
bridge.stderr.on('data', (d) => logLines.push(String(d)));

const cleanup = () => {
  try { bridge.kill(); } catch { /* 已退 */ }
  try { upstream.close(); } catch { /* 已关 */ }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
};
process.on('exit', cleanup);

let ready = false;
for (let i = 0; i < 60; i += 1) {
  await new Promise((r) => setTimeout(r, 250));
  try {
    const r = await fetch(`http://127.0.0.1:${BRIDGE_PORT}/health`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    if (r.ok) { ready = true; break; }
  } catch { /* 还没起来 */ }
}
if (!ready) { console.error('桥没起来'); cleanup(); process.exit(1); }
console.log(`桥已就绪（端口 ${BRIDGE_PORT}），启动签到延迟 ${KICK_MS}ms\n`);

// 等定时器触发并完成一次签到
const deadline = Date.now() + 12000;
while (Date.now() < deadline && checkinPosts === 0) await new Promise((r) => setTimeout(r, 200));
await new Promise((r) => setTimeout(r, 400));   // 让日志刷完

let failures = 0;
const pass = (m) => console.log('✓ ' + m);
const fail = (m) => { console.error('✗ ' + m); failures += 1; };

console.log(`  chat 请求数   : ${chatRequests}`);
console.log(`  签到 POST 次数: ${checkinPosts}`);
console.log(`  桥的日志：${logLines.join('').split('\n').filter((l) => /auto checkin/.test(l)).join(' | ') || '（无签到记录）'}`);
console.log('');

if (chatRequests === 0) pass('全程没有发过任何 chat 请求（这正是原实现缺的场景）');
else fail(`测试自己发了 ${chatRequests} 个 chat 请求，场景不纯`);

if (checkinPosts >= 1) pass(`桥在不发模型请求的情况下自己完成了签到（${checkinPosts} 次 POST）`);
else fail('桥没有自动签到 —— 定时器没生效，用户仍要手动签');

const hasLog = /auto checkin (ok|already)/.test(logLines.join(''));
if (hasLog) pass('日志里有 auto checkin 成功记录');
else fail('日志里没有签到记录，无法确认结果');

// 幂等：再等一轮不应重复 POST（当天签成功过就不再打上游）
const before = checkinPosts;
await new Promise((r) => setTimeout(r, 2500));
if (checkinPosts === before) pass(`当天签成功后不再重复请求上游（仍是 ${checkinPosts} 次）`);
else fail(`重复签到了：${before} → ${checkinPosts} 次`);

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
cleanup();
process.exit(failures === 0 ? 0 : 1);
