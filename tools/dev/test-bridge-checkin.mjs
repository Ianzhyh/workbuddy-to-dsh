/**
 * R11 桥侧自动签到 验收（Task 31）。
 *
 *   node tools/dev/test-bridge-checkin.mjs
 *
 * 做法：stub 上游（对话 + 计费两个网关都指到本地）+ 临时端口的桥实例。
 * 断言：只签一次、幂等按成功、失败冷却、当天上限、开关关闭则完全不签、不进账本。
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BRIDGE_PORT = 8779;
const STUB_PORT = 8780;
const TOKEN = 'wb-checkin-token';
const BASE = `http://127.0.0.1:${BRIDGE_PORT}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const fail = (m) => { console.error('✗ ' + m); failures += 1; };
const pass = (m) => console.log('✓ ' + m);

const dir = mkdtempSync(join(tmpdir(), 'wb-checkin-test-'));
const LEDGER = join(dir, 'usage.jsonl');
const AUTH_FILE = join(dir, 'auth.json');
{
  const payload = Buffer.from(JSON.stringify({ sub: 'u-test', exp: Math.floor(Date.now() / 1000) + 86400 })).toString('base64url');
  writeFileSync(AUTH_FILE, JSON.stringify({
    auth: { accessToken: `header.${payload}.sig`, refreshToken: 'r', domain: 'www.codebuddy.cn', expiresAt: Date.now() + 86400000 },
  }), 'utf8');
}

// ── stub 上游 ───────────────────────────────────────────────────────────
let checkinMode = 'ok'; // 'ok' | 'already' | 'error'
let checkinHits = 0;
const stub = createServer((req, res) => {
  const p = (req.url || '').split('?')[0];
  const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

  if (p === '/v2/billing/meter/daily-checkin') {
    checkinHits += 1;
    if (checkinMode === 'already') return send(200, { code: 1, msg: '今天已签到' });
    if (checkinMode === 'error') return send(200, { code: 500, msg: 'upstream boom' });
    return send(200, { code: 0, data: { credit: 18, streak_days: 6, is_streak_day: true } });
  }
  if (p === '/v2/billing/meter/checkin-activity-status') {
    return send(200, { code: 0, data: { active: true, today_checked_in: false, streak_days: 5, daily_credit: 18 } });
  }
  if (p === '/v1/chat/completions') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"id":"s","choices":[{"index":0,"delta":{"content":"ok"}}]}\n\n');
    res.write('data: {"id":"s","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1,"credit":0}}\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }
  res.writeHead(404).end();
});

let bridge = null;
const cleanup = () => {
  try { bridge?.kill(); } catch { /* 已退出 */ }
  try { stub.close(); } catch { /* 已关闭 */ }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* 已清理 */ }
};
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });

function startBridge(extraEnv = {}) {
  bridge = spawn(process.execPath, [join(root, 'bridge', 'workbuddy-bridge.mjs')], {
    cwd: root,
    env: {
      ...process.env,
      WORKBUDDY_HOST: '127.0.0.1',
      WORKBUDDY_PORT: String(BRIDGE_PORT),
      WORKBUDDY_LOCAL_TOKEN: TOKEN,
      WORKBUDDY_USAGE_FILE: LEDGER,
      WORKBUDDY_AUTH_FILE: AUTH_FILE,
      WORKBUDDY_LOG: '0',
      CODEBUDDY_API_KEY: 'test-key',
      CODEBUDDY_ENDPOINT: `http://127.0.0.1:${STUB_PORT}`,
      // 计费网关也指到 stub，否则签到会真的打到上游
      WORKBUDDY_BILLING_BASE: `http://127.0.0.1:${STUB_PORT}`,
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

async function waitReady() {
  for (let i = 0; i < 40; i += 1) {
    try {
      const r = await fetch(`${BASE}/health`, { headers: { Authorization: `Bearer ${TOKEN}` } });
      if (r.ok) return true;
    } catch { /* 还没起来 */ }
    await sleep(250);
  }
  return false;
}

const health = () => fetch(`${BASE}/health`, { headers: { Authorization: `Bearer ${TOKEN}` } }).then((r) => r.json());
const oneChat = () => fetch(`${BASE}/v1/chat/completions`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
  body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: false }),
}).then((r) => r.json());
const ledgerLines = () => { try { return readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean).length; } catch { return 0; } };

/** 端口上还有人监听吗（TCP 连得上就算有人）。 */
function portBusy() {
  return new Promise((ok) => {
    const s = createConnection({ host: '127.0.0.1', port: BRIDGE_PORT });
    const done = (v) => { try { s.destroy(); } catch { /* 忽略 */ } ok(v); };
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
    setTimeout(() => done(false), 300);
  });
}

/**
 * 停掉当前桥实例，**并等它真的退出、端口真的空出来**。
 *
 * 为什么不能只 `kill()` + `sleep(300)`：Windows 上 SIGTERM 不保证立刻生效。
 * 实测旧进程 300ms 后还在监听 → 新实例 `EADDRINUSE` 直接退出，而
 * `waitReady()` 探到的是**旧桥** —— 后面的断言全部跑在旧实例的状态上
 * （例如还带着上一段设的 1 小时签到冷却），于是报出「当天上限未生效：
 * 签了 0 次」这种**看起来像产品 bug** 的假象。踩过一次，值得等这 3 秒。
 */
async function stopBridge() {
  if (!bridge) return;
  const dead = new Promise((ok) => bridge.once('exit', ok));
  bridge.kill();
  await Promise.race([dead, sleep(3000)]);
  if (bridge.exitCode === null && bridge.signalCode === null) {
    try { bridge.kill('SIGKILL'); } catch { /* 已退出 */ }
    await Promise.race([dead, sleep(2000)]);
  }
  for (let i = 0; i < 40 && await portBusy(); i += 1) await sleep(100);
  bridge = null;
}

async function restart(extraEnv = {}) {
  await stopBridge();
  startBridge(extraEnv);
  if (!await waitReady()) { fail('桥实例未能就绪'); cleanup(); process.exit(1); }
}

// ── 开跑 ────────────────────────────────────────────────────────────────
await new Promise((ok) => stub.listen(STUB_PORT, '127.0.0.1', ok));

// 1. R11.2-1 / R11.4-2 连打 3 次只签一次，且不进账本
{
  await restart();
  console.log(`桥实例就绪：${BASE}\n`);
  const before = ledgerLines();
  checkinHits = 0;
  for (let i = 0; i < 3; i += 1) await oneChat();
  await sleep(600);
  if (checkinHits === 1) pass('R11.2-1 连打 3 次对话 → 签到请求只发生 1 次');
  else fail(`R11.2-1 签到请求发生了 ${checkinHits} 次（应为 1）`);

  const h = await health();
  if (h.autoCheckinEnabled === true) pass('R11.2-4 /health 暴露 autoCheckinEnabled=true');
  else fail(`R11.2-4 autoCheckinEnabled 异常：${h.autoCheckinEnabled}`);
  if (h.autoCheckin && (h.autoCheckin.result === 'ok' || h.autoCheckin.result === 'already')) {
    pass(`R11.2-1 /health.autoCheckin.result = ${h.autoCheckin.result}（credit=${h.autoCheckin.credit}）`);
  } else {
    fail(`R11.2-1 /health.autoCheckin 异常：${JSON.stringify(h.autoCheckin)}`);
  }
  // 账本只记模型调用：签到不该新增记录
  const after = ledgerLines();
  if (after === before + 3) pass(`R11.4-2 账本只多了 3 条对话记录（${before}→${after}），签到**不进账本**`);
  else fail(`R11.4-2 账本行数异常：${before} → ${after}（期望 +3）`);
}

// 2. R11.2-2 上游「已签到」按成功处理
{
  checkinMode = 'already';
  await restart();
  checkinHits = 0;
  await oneChat();
  await sleep(600);
  const h = await health();
  if (h.autoCheckin && h.autoCheckin.result === 'already' && !h.autoCheckin.error) {
    pass('R11.2-2 上游返回「已签到」→ result=already，**不记失败**');
  } else {
    fail(`R11.2-2 幂等语义异常：${JSON.stringify(h.autoCheckin)}`);
  }
}

// 3. R11.2-3 失败 → result=error 带原因；冷却期内不再重试
{
  checkinMode = 'error';
  await restart(); // 默认冷却 1 小时
  checkinHits = 0;
  await oneChat();
  await sleep(600);
  const h1 = await health();
  if (h1.autoCheckin && h1.autoCheckin.result === 'error' && /upstream boom/.test(h1.autoCheckin.error || '')) {
    pass(`R11.2-3 上游失败 → result=error 且带原因：${h1.autoCheckin.error}`);
  } else {
    fail(`R11.2-3 失败态异常：${JSON.stringify(h1.autoCheckin)}`);
  }
  const afterFirst = checkinHits;
  await oneChat();
  await oneChat();
  await sleep(600);
  if (checkinHits === afterFirst) pass('R11.2-3 失败后 1 小时冷却期内不再重试（未对上游打无效请求）');
  else fail(`R11.2-3 冷却期没生效：又打了 ${checkinHits - afterFirst} 次`);
}

// 4. R11.2-3 当天最多 3 次（把冷却调到 0 才能在一次测试里观察到）
{
  checkinMode = 'error';
  /*
   * `WORKBUDDY_CHECKIN_COOLDOWN_MS` 同时是**定时器间隔**（见 startAutoCheckinTimer），
   * 设成 0 就等于「启动即触发」。所以计数必须在 `restart()` **之前**清零 ——
   * 否则启动那几次尝试会被记漏，断言看到的是 0 而不是 3（曾因此误判成产品 bug）。
   *
   * 断言也据此改成「自起桥起**总计**只打 3 次」：不管是定时器打的还是对话打的，
   * 当天上限都该兜住 —— 这比只数对话触发的次数更贴近这条规则的本意。
   */
  checkinHits = 0;
  await restart({ WORKBUDDY_CHECKIN_COOLDOWN_MS: '0' });
  for (let i = 0; i < 6; i += 1) await oneChat();
  await sleep(800);
  if (checkinHits === 3) pass('R11.2-3 冷却为 0 时，当天最多尝试 3 次（定时器 + 6 次对话，合计只签 3 次）');
  else fail(`R11.2-3 当天上限未生效：签了 ${checkinHits} 次（应为 3）`);
}

// 5. R11.2-4 开关关闭 → 完全不发起
{
  await restart({ WORKBUDDY_AUTO_CHECKIN: '0' });
  checkinHits = 0;
  await oneChat();
  await oneChat();
  await sleep(600);
  const h = await health();
  if (checkinHits === 0) pass('R11.2-4 WORKBUDDY_AUTO_CHECKIN=0 → 桥侧完全不发起签到请求');
  else fail(`R11.2-4 关闭后仍发起了 ${checkinHits} 次`);
  if (h.autoCheckinEnabled === false) pass('R11.2-4 /health 如实反映 autoCheckinEnabled=false');
  else fail(`R11.2-4 autoCheckinEnabled 应为 false，实际 ${h.autoCheckinEnabled}`);
}

cleanup();
console.log(failures ? `\n存在 ${failures} 项失败` : '\n全部通过');
process.exit(failures ? 1 : 0);
