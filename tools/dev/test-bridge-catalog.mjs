/**
 * Task 3 验收（R2.3 后端）：手动强制刷新目录。
 *
 *   node tools/dev/test-bridge-catalog.mjs
 *
 * 做法：起一个本地 stub 上游（只服务两个目录端点）+ 一个临时端口的桥实例。
 * 断言：强制刷新真的重取上游；并发刷新只打一次上游；上游失败时保留旧缓存
 * 并带上 staleMs；恢复后 staleMs 消失；不带 refresh 的行为不变。
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BRIDGE_PORT = 8901;
const STUB_PORT = 8902;
const TOKEN = 'wb-catalog-token';
const BASE = `http://127.0.0.1:${BRIDGE_PORT}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const fail = (m) => { console.error('✗ ' + m); failures += 1; };
const pass = (m) => console.log('✓ ' + m);

const dir = mkdtempSync(join(tmpdir(), 'wb-catalog-test-'));

// 伪造一份**明文**登录文件（openAuthField 对字符串原样返回，不需要 AtRest 信封）。
// 目录抓取走 readStoredAuth()，没有它就直接抛错、根本不发上游请求。
const AUTH_FILE = join(dir, 'auth.json');
{
  const payload = Buffer.from(JSON.stringify({
    sub: 'u-test',
    exp: Math.floor(Date.now() / 1000) + 86400,
  })).toString('base64url');
  writeFileSync(AUTH_FILE, JSON.stringify({
    auth: {
      accessToken: `header.${payload}.sig`,
      refreshToken: 'refresh-test',
      domain: 'www.codebuddy.cn',
      expiresAt: Date.now() + 86400000,
    },
  }), 'utf8');
}

// ── stub 上游：两个目录端点 ─────────────────────────────────────────────
let failMode = false;
let hits = 0; // 只统计 models 端点的命中次数（一次「刷新轮」= 1）
const stub = createServer((req, res) => {
  const p = (req.url || '').split('?')[0];
  if (p === '/v2/enterprises/personal/models') {
    hits += 1;
    if (failMode) { res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end('upstream boom'); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      data: {
        models: [
          { id: 'cat-a', name: 'Catalog A', maxInputTokens: 128000, maxOutputTokens: 8192, credits: 'x0.11', supportsImages: true, supportsToolCall: true, vendor: 'VendorA', tags: ['craft'] },
        ],
      },
    }));
    return;
  }
  if (p === '/v3/config') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      data: { models: [{ id: 'cat-b', name: 'Catalog B', maxInputTokens: 64000, maxOutputTokens: 4096, supportsToolCall: true }] },
    }));
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

function startBridge() {
  bridge = spawn(process.execPath, [join(root, 'bridge', 'workbuddy-bridge.mjs')], {
    cwd: root,
    env: {
      ...process.env,
      WORKBUDDY_HOST: '127.0.0.1',
      WORKBUDDY_PORT: String(BRIDGE_PORT),
      WORKBUDDY_LOCAL_TOKEN: TOKEN,
      WORKBUDDY_USAGE_FILE: join(dir, 'usage.jsonl'),
      WORKBUDDY_AUTH_FILE: AUTH_FILE,
      WORKBUDDY_LOG: '0',
      CODEBUDDY_ENDPOINT: `http://127.0.0.1:${STUB_PORT}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

async function waitReady() {
  for (let i = 0; i < 40; i += 1) {
    try {
      const r = await fetch(`${BASE}/v1/usage?days=1`, { headers: { Authorization: `Bearer ${TOKEN}` } });
      if (r.ok) return true;
    } catch { /* 还没起来 */ }
    await sleep(250);
  }
  return false;
}

const models = (qs = '') => fetch(`${BASE}/v1/models?all=1${qs}`, { headers: { Authorization: `Bearer ${TOKEN}` } })
  .then(async (r) => ({ status: r.status, body: await r.json() }));

// ── 开跑 ────────────────────────────────────────────────────────────────
await new Promise((ok) => stub.listen(STUB_PORT, '127.0.0.1', ok));
startBridge();
if (!await waitReady()) { fail('桥实例未能在 10 秒内就绪'); cleanup(); process.exit(1); }
console.log(`桥实例就绪：${BASE}\n`);

// 1. 冷启动：首次取目录（缓存为空 → 同步抓一次）
{
  const r = await models();
  const ids = (r.body.data || []).map((m) => m.id);
  if (ids.includes('cat-a') && ids.includes('cat-b')) {
    pass('R2.3-4 冷启动取到上游目录（cat-a + cat-b 合并）');
  } else {
    fail(`R2.3-4 冷启动目录异常：${JSON.stringify(ids)}`);
  }
  if (!('staleMs' in r.body)) pass('R2.3-5 成功响应不带 staleMs');
  else fail('R2.3-5 成功响应里出现了 staleMs');
}

// 2. refresh=1 真的重取上游
{
  const before = hits;
  const r = await models('&refresh=1');
  if (hits === before + 1) pass('R2.3-1 refresh=1 强制重取上游（命中 +1）');
  else fail(`R2.3-1 refresh=1 未触发上游抓取：命中 ${before} → ${hits}`);
  const ids = (r.body.data || []).map((m) => m.id);
  if (ids.includes('cat-a')) pass('R2.3-1 刷新后返回最新目录');
  else fail('R2.3-1 刷新后目录异常');
  if (!('staleMs' in r.body)) pass('R2.3-5 刷新成功时响应不带 staleMs');
  else fail('R2.3-5 刷新成功却带了 staleMs');
}

// 3. 并发刷新只打一次上游（catalogRefreshing 去重）
{
  const before = hits;
  await Promise.all(Array.from({ length: 5 }, () => models('&refresh=1')));
  if (hits === before + 1) pass('R2.3-2 连点 5 次只发起 1 次上游抓取（并发去重）');
  else fail(`R2.3-2 并发刷新打了 ${hits - before} 次上游（应为 1）`);
}

// 4. 上游失败：保留旧缓存 + staleMs
{
  failMode = true;
  const before = hits;
  const r = await models('&refresh=1');
  const ids = (r.body.data || []).map((m) => m.id);
  if (hits === before + 1) pass('R2.3-3 失败时仍尝试了一次上游抓取');
  else fail(`R2.3-3 失败路径未打上游：${before} → ${hits}`);

  if (ids.includes('cat-a')) pass('R2.3-3 上游失败时保留旧缓存（cat-a 仍在，表格不清空）');
  else fail('R2.3-3 上游失败后目录被清空');

  if (typeof r.body.staleMs === 'number' && r.body.staleMs >= 0) {
    pass(`R2.3-5 失败响应带 staleMs（${Math.round(r.body.staleMs / 1000)} 秒前的缓存）`);
  } else {
    fail(`R2.3-5 失败响应缺少 staleMs：${JSON.stringify(r.body.staleMs)}`);
  }
}

// 5. 恢复后 staleMs 消失
{
  failMode = false;
  const r = await models('&refresh=1');
  if (!('staleMs' in r.body)) pass('R2.3-5 上游恢复后 staleMs 消失（不残留上一次的失败标记）');
  else fail('R2.3-5 恢复后仍带 staleMs');
  const ids = (r.body.data || []).map((m) => m.id);
  if (ids.includes('cat-a')) pass('R2.3-3 恢复后目录正常');
  else fail('R2.3-3 恢复后目录异常');
}

// 6. 不带 refresh 的行为不变（不额外打上游）
{
  const before = hits;
  await models();
  if (hits === before) pass('R2.3-4 不带 refresh 时不额外抓取上游（有缓存立刻返回）');
  else fail(`R2.3-4 不带 refresh 却打了上游：${before} → ${hits}`);
}

cleanup();
console.log(failures ? `\n存在 ${failures} 项失败` : '\n全部通过');
// 用 exitCode 而不是 process.exit()：上面刚 kill 了子进程，而 process.exit()
// 会在子进程的管道/undici 连接还没收尾时强拆 libuv 句柄 —— Windows 上实测
// 稳定触发 `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` 并让进程
// 以 0xC0000409 崩溃退出（断言全过，退出码却是失败）。让事件循环自然排空即可。
process.exitCode = failures ? 1 : 0;
