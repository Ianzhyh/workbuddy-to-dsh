/**
 * 浏览器跨源（CORS）行为的**合约测试**。
 *
 *   node --test bridge/bridge-cors.test.mjs
 *
 * ## 为什么必须真起桥 + 真打 HTTP
 *
 * 这条链路的正确性全在**响应头**上：浏览器不是看状态码决定放不放行，而是看
 * `Access-Control-Allow-Origin`。头少一个、值差一点，请求照样发出去、响应照样
 * 被丢弃 —— 本地用什么工具测都测不出来（curl 完全不管 CORS）。只有真起一个桥、
 * 按浏览器的形状发请求、再看头，才能证明这条路通了。
 *
 * ## 背景（修之前的状态，实测）
 *
 * `originAllowed()` 的注释承诺「本机网页版客户端照常可用」，但预检按规范
 * **不带 Authorization**，于是必被令牌闸门（401）或 404 兜底拦下，
 * 且全端点没有任何 `Access-Control-Allow-*`。等于这条承诺从未兑现。
 *
 * 修法必须**收窄而非放宽**：`docs/CLIENT-CONNECT-AUDIT.md` 明确依赖过
 * "跨站页面读不到响应"这条性质，所以只回显回环 Origin、永不 `*`、
 * 不带 `Allow-Credentials`。本文件把这三条也一并锁死，
 * 防止后来者图省事改成 `*`。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(HERE);
const BRIDGE = join(REPO, 'bridge', 'workbuddy-bridge.mjs');
const TOKEN = 'cors-test-token';

// ── 打桩上游（本文件不验翻译，只需要它别出错）───────────────────────────
const upstream = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: 0, data: { models: [] } }));
  });
});
await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
const UPSTREAM_PORT = upstream.address().port;

// ── 桥 ────────────────────────────────────────────────────────────────────
const dir = mkdtempSync(join(tmpdir(), 'wb-cors-test-'));
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const authFile = join(dir, 'fake-auth.info');
writeFileSync(authFile, JSON.stringify({
  auth: {
    accessToken: `${b64({ alg: 'none' })}.${b64({ sub: 'cors-test-user', exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`,
    refreshToken: 'fake-refresh',
    expiresAt: Date.now() + 3600_000,
    domain: 'copilot.tencent.com',
  },
}));

const bridgePort = 20000 + Math.floor(Math.random() * 20000);
const child = spawn(process.execPath, [BRIDGE], {
  cwd: dir,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    WORKBUDDY_HOST: '127.0.0.1',
    WORKBUDDY_PORT: String(bridgePort),
    WORKBUDDY_LOCAL_TOKEN: TOKEN,
    WORKBUDDY_AUTH_FILE: authFile,
    CODEBUDDY_ENDPOINT: `http://127.0.0.1:${UPSTREAM_PORT}`,
    CODEBUDDY_API_KEY: 'stub-key',
    WORKBUDDY_AUTO_CHECKIN: '0',
    WORKBUDDY_LOG: '0',
    /*
     * ⚠️ 账本必须**显式**指到临时目录，`cwd: dir` 是不够的。
     *
     * `usageFile()` 解析的是 `WORKBUDDY_USAGE_FILE`，否则退回
     * **桥脚本所在目录**（`dirname(fileURLToPath(import.meta.url))`）——
     * 那是仓库里的 `bridge/usage.jsonl`，**使用者的真实账本**，与 cwd 无关。
     * 少了这一行，每跑一次本文件就会往真实账本里写几十条 `client:"local"` 的
     * 测试记录（实测：一次 32 用例的运行写进 36 行），而且账本到 2000 行会
     * 截断保留最近一半 —— 等于**把用户自己的用量历史挤掉**。
     * `bridge.test.mjs` / `bridge-startup.test.mjs` 早就设了这一项，
     * 这里与 `bridge-responses.test.mjs` 是漏的。
     */
    WORKBUDDY_USAGE_FILE: join(dir, 'usage.jsonl'),
  },
});
let bridgeLog = '';
child.stdout.on('data', (d) => { bridgeLog += d; });
child.stderr.on('data', (d) => { bridgeLog += d; });

const BASE = `http://127.0.0.1:${bridgePort}`;
const auth = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };

/** 等桥起来（校验 pid 是自己这个进程，避免本机真桥占端口时假绿）。 */
async function waitReady() {
  for (let i = 0; i < 100; i += 1) {
    try {
      const r = await fetch(`${BASE}/health`, { headers: auth });
      if (r.status === 200 && (await r.json())?.pid === child.pid) return true;
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`桥没起来。日志：\n${bridgeLog}`);
}

/** 发一次预检（按浏览器的真实形状：**不带** Authorization）。 */
const preflight = (path, origin) => fetch(`${BASE}${path}`, {
  method: 'OPTIONS',
  headers: {
    Origin: origin,
    'Access-Control-Request-Method': 'POST',
    'Access-Control-Request-Headers': 'authorization,content-type',
  },
});

await waitReady();
const ready = true;
assert.ok(ready);

// ── 1. 预检必须成功，且**不需要令牌** ────────────────────────────────────
test('预检：回环 Origin + 不带令牌 → 2xx 且回显该 Origin', async () => {
  const r = await preflight('/v1/chat/completions', 'http://localhost:3000');
  /*
   * 关键：这里**没有** Authorization。旧实现在这里回 401（死在令牌闸门），
   * 而浏览器永远不会给预检带凭证 —— 所以"预检必须免鉴权"是硬要求，
   * 不是宽松。
   */
  assert.ok(r.status >= 200 && r.status < 300, `预检应放行，实际 ${r.status}`);
  assert.equal(r.headers.get('access-control-allow-origin'), 'http://localhost:3000',
    '必须**回显**请求的 Origin（回显别的值或 * 都不对）');
});

test('预检：127.0.0.1 与 ::1 也算回环', async () => {
  for (const o of ['http://127.0.0.1:5173', 'http://[::1]:8080']) {
    const r = await preflight('/v1/models', o);
    assert.ok(r.status >= 200 && r.status < 300, `${o} 应放行，实际 ${r.status}`);
    assert.equal(r.headers.get('access-control-allow-origin'), o);
  }
});

test('预检：声明了方法与常用头（否则浏览器照样拒发真实请求）', async () => {
  const r = await preflight('/v1/chat/completions', 'http://localhost:3000');
  const methods = (r.headers.get('access-control-allow-methods') || '').toUpperCase();
  assert.match(methods, /POST/, '要声明 POST —— 不声明浏览器就不发真实请求');
  const headers = (r.headers.get('access-control-allow-headers') || '').toLowerCase();
  for (const h of ['authorization', 'content-type', 'x-api-key']) {
    assert.ok(headers.includes(h), `要声明放行 ${h}（客户端可能用任一种令牌写法）`);
  }
  assert.ok(Number(r.headers.get('access-control-max-age') || 0) > 0, '给个缓存时长，省掉逐次预检');
});

// ── 2. 安全边界：非回环一律不给 CORS 头 ──────────────────────────────────
test('非回环 Origin：预检**不给** CORS 头（跨站页面必须仍读不到响应）', async () => {
  for (const o of ['https://evil.example', 'http://192.168.1.50:3000', 'null']) {
    const r = await preflight('/v1/chat/completions', o);
    assert.equal(r.headers.get('access-control-allow-origin'), null,
      `${o} 绝不能被放行 —— 那等于拆掉 CLIENT-CONNECT-AUDIT 依赖的那条性质`);
  }
});

test('非回环 Origin：真实请求仍被 403 拦下（不是只缺头）', async () => {
  const r = await fetch(`${BASE}/v1/models`, {
    headers: { ...auth, Origin: 'https://evil.example' },
  });
  assert.equal(r.status, 403, 'DNS rebinding 形状的请求要真的被拒');
  assert.equal(r.headers.get('access-control-allow-origin'), null);
});

// ── 3. 真实响应也要带 CORS 头，否则浏览器读不到 ──────────────────────────
test('真实请求（回环 Origin）：成功响应带 CORS 头', async () => {
  const r = await fetch(`${BASE}/v1/models`, {
    headers: { ...auth, Origin: 'http://localhost:3000' },
  });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('access-control-allow-origin'), 'http://localhost:3000',
    '不带这个头，浏览器会把 200 的响应体丢掉，用户看到的是网络错误');
});

test('真实请求（回环 Origin）：**错误**响应也要带 CORS 头', async () => {
  /*
   * 这条最容易被漏掉：浏览器读不到 401 的响应体，用户就看不到那条自诊断
   * 文案，只会看到一句"CORS 错误" —— 排查方向直接跑偏。
   */
  const r = await fetch(`${BASE}/v1/models`, {
    headers: { Origin: 'http://localhost:3000' }, // 故意不带令牌
  });
  assert.equal(r.status, 401);
  assert.equal(r.headers.get('access-control-allow-origin'), 'http://localhost:3000',
    '401 的响应体（含排查指引）必须能被浏览器读到');
});

// ── 4. 不许越界：绝不能出现 * 或 Allow-Credentials ──────────────────────
test('任何响应都不得出现 `*` 或 `Allow-Credentials`', async () => {
  const reqs = [
    preflight('/v1/chat/completions', 'http://localhost:3000'),
    preflight('/v1/chat/completions', 'https://evil.example'),
    fetch(`${BASE}/v1/models`, { headers: { ...auth, Origin: 'http://localhost:3000' } }),
    fetch(`${BASE}/v1/models`, { headers: { Origin: 'http://localhost:3000' } }),
  ];
  for (const r of await Promise.all(reqs)) {
    assert.notEqual(r.headers.get('access-control-allow-origin'), '*',
      '`*` 会让**任意**网页读到响应，等于把原性质拆了');
    assert.equal(r.headers.get('access-control-allow-credentials'), null,
      '本桥靠 Bearer/x-api-key 鉴权、不靠 Cookie，带 Allow-Credentials 纯属扩大攻击面');
  }
});

// ── 5. 无 Origin（CLI / Electron 主进程）行为不变 ────────────────────────
test('不带 Origin：照常工作，且不产生任何 CORS 头', async () => {
  const r = await fetch(`${BASE}/v1/models`, { headers: auth });
  assert.equal(r.status, 200, 'CLI / 桌面客户端本来就不发 Origin，不能被这次改动影响');
  assert.equal(r.headers.get('access-control-allow-origin'), null, '无 Origin 无需回显');
});

// ── 收尾 ──────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test.after(async () => {
  child.kill();
  upstream.close();
  // Windows 上刚 kill 的进程文件句柄未释放会让 rmSync 报 EPERM（详见 responses 测试）
  await new Promise((r) => {
    if (child.exitCode !== null || child.signalCode) { r(); return; }
    child.once('exit', r);
    setTimeout(r, 2000);
  });
  for (let i = 0; i < 5; i += 1) {
    try { rmSync(dir, { recursive: true, force: true }); return; } catch { await sleep(200); }
  }
  try { rmSync(dir, { recursive: true, force: true }); } catch (e) {
    console.warn(`[收尾] 临时目录没能删掉（不影响用例结论）：${dir} —— ${e.code || e.message}`);
  }
});
