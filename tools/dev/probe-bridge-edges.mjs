/**
 * 边界输入探查：把畸形 / 极端请求丢给桥，看它是**如实报 4xx** 还是**炸成 500**。
 *
 *   node tools/dev/probe-bridge-edges.mjs
 *
 * 为什么值得单独跑：桥的对外承诺是「客户端填错就告诉它错在哪」。
 * 一个未捕获的 TypeError 会变成 500 + 一段栈，客户端只能显示「未知错误」，
 * 用户完全无从下手。所以这里断言的是**状态码**，不是内容。
 *
 * 用假上游（可控响应）而不是真上游：不消耗额度，且能把「上游的错」与
 * 「桥自己的错」分开 —— 真上游返回 400 时，桥转成 400 是**正确**的，
 * 不能算桥的 bug。
 */
import { createServer } from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const UPSTREAM_PORT = 18893;
const BRIDGE_PORT = 18894;
const TOKEN = 'edge-test-token';

/** 假上游：正常回一个最小合法的 OpenAI 响应，不制造错误。 */
const upstream = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    if (req.url.startsWith('/v2/plugin/auth/token/refresh')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 0, data: { accessToken: 'a2', refreshToken: 'r2', expiresIn: 3600, refreshExpiresIn: 3600 } }));
      return;
    }
    if (req.url.startsWith('/v3/config')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 0, data: { models: [] } }));
      return;
    }
    let wantStream = false;
    try { wantStream = JSON.parse(Buffer.concat(chunks).toString('utf8')).stream === true; } catch { /* 忽略 */ }
    if (wantStream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"id":"c1","model":"glm-5.3","choices":[{"delta":{"content":"hi"},"index":0}]}\n\n');
      res.write('data: {"id":"c1","model":"glm-5.3","choices":[{"delta":{},"finish_reason":"stop","index":0}],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: 'c1', model: 'glm-5.3', choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } }));
  });
});
await new Promise((r) => upstream.listen(UPSTREAM_PORT, '127.0.0.1', r));

const dir = mkdtempSync(join(tmpdir(), 'wb-edge-'));
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
    WORKBUDDY_AUTO_CHECKIN: '0',
    WORKBUDDY_LOG: '0',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
const stderrChunks = [];
bridge.stderr.on('data', (d) => stderrChunks.push(String(d)));
bridge.stdout.on('data', () => {});

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

/**
 * 用原始 TCP socket 发一个请求。
 *
 * fetch/undici 会对请求头做 ByteString 校验，非 ASCII 直接抛错 —— 于是
 * 「客户端发来非 ASCII 头」这条路径用 fetch **测不出来**。真实客户端
 * （Go / Python / curl）不受这个限制，所以必须用裸 socket 才能覆盖。
 */
async function rawPost(path, body, extraHeaders = {}) {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  const lines = [
    `POST ${path} HTTP/1.1`,
    `Host: 127.0.0.1:${BRIDGE_PORT}`,
    `Authorization: Bearer ${TOKEN}`,
    'Content-Type: application/json',
    `Content-Length: ${payload.length}`,
    'Connection: close',
    ...Object.entries(extraHeaders).map(([k, v]) => `${k}: ${v}`),
    '', '',
  ].join('\r\n');
  return new Promise((resolve) => {
    const sock = net.connect(BRIDGE_PORT, '127.0.0.1');
    let buf = '';
    const done = (v) => { try { sock.destroy(); } catch { /* 忽略 */ } resolve(v); };
    sock.setTimeout(8000, () => done({ status: 0, text: 'timeout' }));
    sock.on('connect', () => { sock.write(Buffer.concat([Buffer.from(lines, 'latin1'), payload])); });
    sock.on('data', (c) => { buf += c.toString('latin1'); });
    sock.on('end', () => {
      const m = buf.match(/^HTTP\/1\.1 (\d+)/);
      const status = m ? Number(m[1]) : 0;
      const i = buf.indexOf('\r\n\r\n');
      done({ status, text: buf.slice(i + 4).replace(/\s+/g, ' ').slice(0, 120) });
    });
    sock.on('error', (e) => done({ status: 0, text: String(e.message).slice(0, 120) }));
  });
}

const base = `http://127.0.0.1:${BRIDGE_PORT}`;
const post = async (path, body, raw = false) => {
  try {
    const r = await fetch(base + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: raw ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    return { status: r.status, text: (await r.text()).slice(0, 120) };
  } catch (e) {
    return { status: 0, text: String(e.name + ': ' + e.message).slice(0, 120) };
  }
};

const CASES = [
  ['空 body', () => post('/v1/chat/completions', '', true)],
  ['非法 JSON', () => post('/v1/chat/completions', '{ not json', true)],
  ['缺 model', () => post('/v1/chat/completions', { messages: [{ role: 'user', content: 'hi' }] })],
  ['model 是数字', () => post('/v1/chat/completions', { model: 123, messages: [{ role: 'user', content: 'hi' }] })],
  ['messages 不是数组', () => post('/v1/chat/completions', { model: 'glm-5.3', messages: 'hi' })],
  ['messages 含 null 项', () => post('/v1/chat/completions', { model: 'glm-5.3', messages: [null] })],
  ['messages 项缺 role', () => post('/v1/chat/completions', { model: 'glm-5.3', messages: [{ content: 'hi' }] })],
  ['content 是对象', () => post('/v1/chat/completions', { model: 'glm-5.3', messages: [{ role: 'user', content: { a: 1 } }] })],
  ['stream 是字符串 "true"', () => post('/v1/chat/completions', { model: 'glm-5.3', messages: [{ role: 'user', content: 'hi' }], stream: 'true' })],
  ['tools 是对象', () => post('/v1/chat/completions', { model: 'glm-5.3', messages: [{ role: 'user', content: 'hi' }], tools: { a: 1 } })],
  ['tool_choice 是数字', () => post('/v1/chat/completions', { model: 'glm-5.3', messages: [{ role: 'user', content: 'hi' }], tool_choice: 42 })],
  ['tool_choice 是数组', () => post('/v1/chat/completions', { model: 'glm-5.3', messages: [{ role: 'user', content: 'hi' }], tool_choice: [] })],
  ['未知 model', () => post('/v1/chat/completions', { model: '不存在的模型', messages: [{ role: 'user', content: 'hi' }] })],
  ['Anthropic 缺 messages', () => post('/v1/messages', { model: 'claude-sonnet-4', max_tokens: 10 })],
  ['Anthropic model 含中文', () => post('/v1/messages', { model: '模型-中文名', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] })],
  ['Anthropic model 含 CRLF', () => post('/v1/messages', { model: 'claude\r\nX-Injected: 1', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] })],
  ['Anthropic messages 非数组', () => post('/v1/messages', { model: 'claude-sonnet-4', max_tokens: 10, messages: 'x' })],
  ['Anthropic content 是数字', () => post('/v1/messages', { model: 'claude-sonnet-4', max_tokens: 10, messages: [{ role: 'user', content: 5 }] })],
  ['GET 打 chat 端点', async () => {
    const r = await fetch(`${base}/v1/chat/completions`, { headers: { Authorization: `Bearer ${TOKEN}` }, signal: AbortSignal.timeout(8000) });
    return { status: r.status, text: (await r.text()).slice(0, 80) };
  }],
  ['未知路径', async () => {
    const r = await fetch(`${base}/v1/nope`, { headers: { Authorization: `Bearer ${TOKEN}` }, signal: AbortSignal.timeout(8000) });
    return { status: r.status, text: (await r.text()).slice(0, 80) };
  }],
  ['无令牌', async () => {
    const r = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'glm-5.3', messages: [{ role: 'user', content: 'hi' }] }),
      signal: AbortSignal.timeout(8000),
    });
    return { status: r.status, text: (await r.text()).slice(0, 80) };
  }],

  // ── 客户端可控输入流进 HTTP 头 ────────────────────────────────────────
  // 桥把 body.model 放进 `X-Model-ID`、把请求头 x-conversation-id 原样放进
  // `X-Conversation-ID`。两者都来自客户端，含非 ASCII 或 CR/LF 时 Node 的
  // http.request 会抛 ERR_INVALID_CHAR。
  ['model 含中文', () => post('/v1/chat/completions', { model: '模型-中文名', messages: [{ role: 'user', content: 'hi' }] })],
  ['model 含 CRLF（注入尝试）', () => post('/v1/chat/completions', { model: 'glm-5.3\r\nX-Injected: 1', messages: [{ role: 'user', content: 'hi' }] })],
  // x-conversation-id 是非 ASCII 时，**fetch 自己就会拒绝**（undici 的 ByteString
  // 检查），所以只能用原始 socket 发 —— 而真实世界里任何非 Node 客户端都能这么发。
  ['x-conversation-id 含非 ASCII（原始 socket）', () => rawPost(
    '/v1/chat/completions',
    { model: 'glm-5.3', messages: [{ role: 'user', content: 'hi' }] },
    { 'x-conversation-id': Buffer.from('会话-1', 'utf8').toString('latin1') },
  )],
];

console.log('边界输入探查（假上游只回正常响应，所以非 2xx 都是桥自己判的）\n');
console.log('  用例'.padEnd(30) + '状态  判定');
console.log('  ' + '─'.repeat(66));
let bad = 0;
for (const [name, run] of CASES) {
  const r = await run();
  // 500 一律算问题：那意味着未捕获异常
  const is500 = r.status >= 500 && r.status !== 502 && r.status !== 503;
  if (is500) bad += 1;
  const mark = is500 ? '❌ 未捕获异常' : (r.status >= 400 && r.status < 500 ? '✅ 如实报错' : (r.status === 0 ? '❌ 无响应' : `✅ HTTP ${r.status}`));
  console.log(`  ${name.padEnd(28)} ${String(r.status).padStart(3)}   ${mark}`);
  if (is500 || r.status === 0) console.log(`      → ${r.text}`);
}
console.log('  ' + '─'.repeat(66));

const err = stderrChunks.join('');
const uncaught = /Uncaught|UnhandledPromiseRejection|TypeError|ReferenceError/.test(err);
if (uncaught) {
  bad += 1;
  console.log('\n❌ 桥的 stderr 里有未捕获异常：');
  console.log('   ' + err.split('\n').slice(0, 8).join('\n   '));
}
console.log(bad === 0 ? '\n全部用例都如实报错，没有未捕获异常。' : `\n${bad} 处需要修。`);
cleanup();
process.exit(bad === 0 ? 0 : 1);
