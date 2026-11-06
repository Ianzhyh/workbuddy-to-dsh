/**
 * 桥的输入校验与错误归因回归（2026-11-06 审计修复）。
 *
 * 起一个真桥 + 假上游，钉住四条**曾经静默失效**的行为：
 *
 *   1. 管理端点超限必须回 **413**，不能被 `catch { body = null }` 伪装成
 *      「uid is required」/「body must be a JSON object」这类参数错误；
 *   2. `/v1/auth/device` 超限**绝不能**带着默认 region 真的发起设备码登录
 *      （那有副作用、花配额，用户还不知道这次登录从哪来）；
 *   3. 超限之后**同一条 keep-alive 连接**的下一条请求必须仍能拿到响应
 *      （`readBody` 只 pause，只有 `rejectTooLarge` 会 resume —— 漏了就挂死）；
 *   4. Responses 的 `input_tokens` 必须按 Responses 形状估算，不能恒为 1
 *      （恒为 1 会让 Codex 认为这一轮没吃上下文，永不触发自动压缩）。
 *
 * 为什么这些必须是**集成**用例而不是纯函数单测：四条里有三条的缺陷都在
 * 「谁调用谁、异常走哪条分支」上，纯函数测不到。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pickBridgePort } from '../tools/dev/bridge-ports.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(HERE);
const BRIDGE = join(REPO, 'bridge', 'workbuddy-bridge.mjs');
const TOKEN = 'input-guard-test-token';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 上限设 64KB：超限用例用 200KB 触发，正常用例（~8KB）不受影响。 */
const BODY_LIMIT = 64 * 1024;
const BIG = 'x'.repeat(200 * 1024);

let deviceHits = 0;

const stub = createServer((req, res) => {
  if (req.url?.startsWith('/v2/plugin/auth/state')) deviceHits += 1;
  if (req.url?.startsWith('/v3/config')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      data: { models: [{ id: 'glm-5.3', maxInputTokens: 300000, maxOutputTokens: 48000, credits: 0.79 }] },
    }));
    return;
  }
  // 聊天：按 stream 字段分流；**故意不回 usage**，逼桥走估算分支
  if (req.url?.startsWith('/v2/chat')) {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw); } catch { /* 忽略 */ }
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const frame = (delta, finish = null) => `data: ${JSON.stringify({
          id: 'chatcmpl-guard', object: 'chat.completion.chunk', model: body.model || 'glm-5.3',
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`;
        res.write(frame({ role: 'assistant', content: 'ok' }));
        res.write(frame({}, 'stop'));
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chatcmpl-guard', object: 'chat.completion', model: body.model || 'glm-5.3',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      }));
    });
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end('{}');
});
await new Promise((r) => stub.listen(0, '127.0.0.1', r));
const STUB = `http://127.0.0.1:${stub.address().port}`;

const dir = mkdtempSync(join(tmpdir(), 'wb-input-guard-'));
const authFile = join(dir, 'auth.info');
writeFileSync(authFile, JSON.stringify({
  auth: {
    accessToken: 'fake-guard-token',
    refreshToken: 'fake-guard-refresh',
    domain: 'example.invalid',
    expiresAt: Date.now() + 3_600_000,
  },
}));

/**
 * 端口**必须**走 `pickBridgePort()`（20000–29999）。
 *
 * 不能随手 `listen(0)` 再拿返回值：那个端口落在系统的动态端口段里
 * （本机 `netsh int ipv4 show dynamicport tcp` = 1024–15000），
 * 而并行的其它用例、以及出站连接会同时从这一段里取端口 —— 实测过
 * `EADDRINUSE` 让整条用例随机红，且失败点看起来与代码无关。
 * 这条约束由 `bridge-startup.test.mjs` 的一条用例守着，新用例必须遵守。
 */
const port = pickBridgePort();

const child = spawn(process.execPath, [BRIDGE], {
  cwd: dir,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    WORKBUDDY_HOST: '127.0.0.1',
    WORKBUDDY_PORT: String(port),
    WORKBUDDY_LOCAL_TOKEN: TOKEN,
    WORKBUDDY_AUTH_FILE: authFile,
    WORKBUDDY_CREDENTIAL_DIR: join(dir, 'cred'),
    WORKBUDDY_USAGE_FILE: join(dir, 'usage.jsonl'),
    WORKBUDDY_DATA_DIR: dir,
    CODEBUDDY_ENDPOINT: STUB,
    WORKBUDDY_AUTO_CHECKIN: '0',
    WORKBUDDY_LOG: '0',
    WORKBUDDY_MAX_BODY_BYTES: String(BODY_LIMIT),
    WORKBUDDY_5XX_RETRY: '0',
  },
  windowsHide: true,
});
let logs = '';
child.stdout.on('data', (d) => { logs += d; });
child.stderr.on('data', (d) => { logs += d; });

const base = `http://127.0.0.1:${port}`;
const auth = { authorization: `Bearer ${TOKEN}` };
for (let i = 0; i < 100; i += 1) {
  try {
    const r = await fetch(`${base}/health`, { headers: auth, signal: AbortSignal.timeout(1000) });
    if (r.ok) break;
  } catch { /* 还没起来 */ }
  if (i === 99) throw new Error(`桥未就绪：\n${logs.slice(-1200)}`);
  await sleep(200);
}

test('管理端点超限回 413，不伪装成参数错误', async () => {
  for (const path of ['/v1/models/default', '/v1/auth/source', '/v1/auth/active']) {
    const r = await fetch(base + path, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: BIG,
      signal: AbortSignal.timeout(15_000),
    });
    const body = await r.text();
    assert.equal(r.status, 413, `${path} 应回 413，实际 ${r.status}：${body.slice(0, 160)}`);
    assert.match(body, /too large/i, `${path} 的 413 应说明"太大"，实际：${body.slice(0, 160)}`);
  }
});

test('/v1/auth/device 超限：413 且绝不发起设备码登录', async () => {
  const before = deviceHits;
  const r = await fetch(`${base}/v1/auth/device`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: BIG,
    signal: AbortSignal.timeout(15_000),
  });
  const body = await r.text();
  assert.equal(r.status, 413, `应回 413，实际 ${r.status}：${body.slice(0, 160)}`);
  assert.equal(deviceHits, before, '超限请求绝不能带着默认 region 去上游申请设备码（有副作用）');
});

test('超限后同一条 keep-alive 连接的下一条请求仍能拿到响应', async () => {
  /*
   * 直接走 socket，因为 fetch 会自己管理连接池、无法保证复用同一条连接。
   * 先发一个超限 POST（读满 413 头），再在同一条 socket 上发一条 GET。
   */
  const result = await new Promise((resolve) => {
    const sock = connect(port, '127.0.0.1', () => {
      sock.write(`POST /v1/auth/active HTTP/1.1\r\nHost: 127.0.0.1\r\n`
        + `Authorization: Bearer ${TOKEN}\r\nContent-Type: application/json\r\n`
        + `Content-Length: ${BIG.length}\r\n\r\n${BIG}`);
    });
    let buf = '';
    let sentSecond = false;
    sock.on('data', (d) => {
      buf += d;
      if (!sentSecond && buf.includes('\r\n\r\n')) {
        sentSecond = true;
        setTimeout(() => {
          sock.write(`GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\n`
            + `Authorization: Bearer ${TOKEN}\r\nConnection: close\r\n\r\n`);
        }, 150);
      }
    });
    sock.on('close', () => resolve(buf));
    sock.on('error', (e) => resolve(`ERR ${e.code || e.message}`));
    setTimeout(() => { try { sock.destroy(); } catch { /* 忽略 */ } resolve(buf); }, 10_000);
  });
  const statuses = [...String(result).matchAll(/HTTP\/1\.1 (\d{3})/g)].map((m) => m[1]);
  assert.ok(statuses.length >= 2, `同一条连接上应看到两条响应，实际：${JSON.stringify(statuses)}｜${String(result).slice(0, 200)}`);
  assert.equal(statuses[0], '413', `第一条应是 413，实际 ${statuses[0]}`);
  assert.equal(statuses[1], '200', `超限后下一条必须还能正常服务（resume 生效），实际 ${statuses[1]}`);
});

test('Responses 的 input_tokens 按 Responses 形状估算，不恒为 1', async () => {
  const longText = '这是一段用于估算的中文正文。'.repeat(200);
  const r = await fetch(`${base}/v1/responses`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'glm-5.3',
      instructions: longText,
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: longText }] }],
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await r.text();
  let payload = null;
  try { payload = JSON.parse(text); } catch { /* 非 JSON：交给断言报出来 */ }
  assert.equal(r.status, 200, `Responses 应成功，实际 ${r.status}：${text.slice(0, 200)}`);
  const tokens = payload?.usage?.input_tokens;
  assert.equal(typeof tokens, 'number', `usage.input_tokens 应是数字，实际 ${JSON.stringify(payload?.usage)}`);
  /*
   * 这段输入约 4400 个中文字符（≈4400 tokens）+ 结构开销。判据只要"量级正确"：
   * 修复前恒为 1，修复后必然远大于 100。写成区间而不是精确值 —— 估算器
   * 的实现细节可以调整，但"报 1"这个缺陷必须被钉住。
   */
  assert.ok(tokens > 100, `input_tokens 不能恒为 1（会让 Codex 永不自动压缩），实际 ${tokens}`);
});

test.after(async () => {
  try { child.kill(); } catch { /* 忽略 */ }
  if (child.exitCode === null) {
    await new Promise((resolve) => {
      child.once('exit', resolve);
      setTimeout(resolve, 1500);
    });
  }
  try { stub.close(); } catch { /* 忽略 */ }
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
});
