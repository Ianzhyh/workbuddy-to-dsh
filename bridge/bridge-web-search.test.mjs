/**
 * WorkBuddy 原生网页搜索桥接的合约测试。
 *
 * 真起桥 + 打桩 WorkBuddy 搜索端点；验两件事：
 *   1. `/v1/web_search` 的鉴权、请求形状、结果归一化、限流错误；
 *   2. `/v1/messages` 的 `web_search_20250305` 分支返回 dsh provider 能解析的
 *      Anthropic 结构化块（web_search_tool_result + text citations）。
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
const TOKEN = 'web-search-test-token';

const seen = [];
let refreshCalls = 0;
let refreshSearchCalls = 0;
let flakyCalls = 0;
const stub = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    if (req.url?.startsWith('/v2/plugin/auth/token/refresh')) {
      refreshCalls += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        code: 0,
        data: { accessToken: 'fresh-search-token', refreshToken: 'rotated-search', expiresIn: 3600 },
      }));
      return;
    }
    if (req.url?.startsWith('/agenttool/v1/search')) {
      let body = null;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* 忽略 */ }
      seen.push({ headers: req.headers, body });
      const query = String(body?.query || '');
      if (query.includes('needs-refresh')) {
        refreshSearchCalls += 1;
        if (refreshSearchCalls === 1) {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ code: 401, msg: 'token expired' }));
          return;
        }
      }
      if (query.includes('flaky')) {
        flakyCalls += 1;
        if (flakyCalls === 1) {
          res.writeHead(502, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ code: 502, msg: 'temporary gateway failure' }));
          return;
        }
      }
      if (query.includes('http-429')) {
        res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '7' });
        res.end(JSON.stringify({ code: 15001, msg: 'too many searches' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      if (query.includes('rate-limit')) {
        res.end(JSON.stringify({ code: 15001, msg: 'too many searches' }));
        return;
      }
      if (query.includes('empty')) {
        res.end(JSON.stringify({ provider: 'stub-search', results: [], total_results: 0, response_time_ms: 5 }));
        return;
      }
      if (query.includes('malformed')) {
        // 头部已在上面统一写成 json；这里只要 body 不是 JSON 即可复现网关错误页。
        res.end('<html><body>gateway error page</body></html>');
        return;
      }
      if (query.includes('bad-url')) {
        res.end(JSON.stringify({
          provider: 'stub-search',
          results: [
            { title: 'Bad', url: 'javascript:alert(1)', snippet: 'bad' },
            { title: 'Good', url: 'https://good.example/g', snippet: 'good' },
          ],
          total_results: 2,
          response_time_ms: 5,
        }));
        return;
      }
      const results = [
        { title: 'Alpha', url: 'https://alpha.example/a', snippet: 'alpha snippet' },
        { title: 'Beta', url: 'https://beta.example/b', snippet: 'beta snippet' },
      ];
      if (query.includes('wrapped')) {
        res.end(JSON.stringify({
          code: 0,
          data: { provider: 'stub-search', results, total_results: 2, response_time_ms: 12 },
        }));
        return;
      }
      res.end(JSON.stringify({
        provider: 'stub-search',
        results,
        total_results: 2,
        response_time_ms: 12,
      }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{}');
  });
});
await new Promise((r) => stub.listen(0, '127.0.0.1', r));
const STUB = `http://127.0.0.1:${stub.address().port}`;

const dir = mkdtempSync(join(tmpdir(), 'wb-web-search-'));
const authFile = join(dir, 'auth.info');
writeFileSync(authFile, JSON.stringify({
  auth: {
    accessToken: 'fake-access-token',
    refreshToken: 'fake-refresh-token',
    domain: 'example.invalid',
    expiresAt: Date.now() + 3_600_000,
  },
}));

const port = 21000 + Math.floor(Math.random() * 20000);
const child = spawn(process.execPath, [BRIDGE], {
  cwd: dir,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    WORKBUDDY_HOST: '127.0.0.1',
    WORKBUDDY_PORT: String(port),
    WORKBUDDY_LOCAL_TOKEN: TOKEN,
    WORKBUDDY_AUTH_FILE: authFile,
    WORKBUDDY_CREDENTIAL_DIR: join(dir, 'credentials'),
    WORKBUDDY_USAGE_FILE: join(dir, 'usage.jsonl'),
    CODEBUDDY_ENDPOINT: STUB,
    WORKBUDDY_SEARCH_BASE: STUB,
    WORKBUDDY_5XX_RETRY_DELAY_MS: '0',
    WORKBUDDY_SKIP_MODEL_PREFLIGHT: '1',
    WORKBUDDY_AUTO_CHECKIN: '0',
    WORKBUDDY_LOG: '0',
  },
  windowsHide: true,
});
let logs = '';
child.stdout.on('data', (d) => { logs += d; });
child.stderr.on('data', (d) => { logs += d; });

const base = `http://127.0.0.1:${port}`;
const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
for (let i = 0; i < 80; i += 1) {
  try {
    const r = await fetch(base + '/', { headers: { authorization: `Bearer ${TOKEN}` }, signal: AbortSignal.timeout(1000) });
    if (r.ok) break;
  } catch { /* 还没起来 */ }
  if (i === 79) throw new Error(`桥未就绪：\n${logs.slice(-1200)}`);
  await new Promise((r) => setTimeout(r, 200));
}

const post = (path, body) => fetch(base + path, {
  method: 'POST', headers: auth, body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
});

test('workbuddy search：/v1/web_search 直连并归一化结果', async () => {
  seen.length = 0;
  const res = await post('/v1/web_search', { query: 'hello world', max_results: 2 });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.object, 'web_search');
  assert.equal(body.results.length, 2);
  assert.deepEqual(body.results[0], {
    title: 'Alpha', url: 'https://alpha.example/a', snippet: 'alpha snippet',
  });
  assert.equal(body.provider, 'stub-search');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].body.query, 'hello world');
  assert.equal(seen[0].body.type, 'text2text');
  assert.equal(seen[0].body.max_results, 2);
  assert.match(String(seen[0].headers.authorization), /^Bearer fake-access-token$/);
  assert.equal(seen[0].headers['x-ide-type'], 'WorkBuddy');
  assert.equal(seen[0].headers['x-ide-name'], 'WorkBuddy');
  assert.equal(seen[0].headers['x-agent-intent'], 'craft');
  assert.equal(seen[0].headers['x-user-id'], undefined);

  const ledger = await (await fetch(base + '/v1/requests?limit=5', {
    headers: { authorization: `Bearer ${TOKEN}` },
  })).json();
  assert.equal(ledger.requests[0].model, 'web-search', '搜索也必须进账本/最近请求');
  assert.equal(ledger.requests[0].ok, true);
});

test('workbuddy search：/v1/messages 的 web_search_20250305 返回 dsh 可解析的块', async () => {
  seen.length = 0;
  const res = await post('/v1/messages', {
    model: 'deepseek-v4-flash',
    max_tokens: 4096,
    messages: [{
      role: 'user',
      content: [{ type: 'text', text: 'Perform a web search for the query: hello world' }],
    }],
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 2 }],
    thinking: { type: 'disabled' },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.type, 'message');
  assert.equal(body.content[0].type, 'web_search_tool_result');
  assert.ok(Array.isArray(body.content[0].content));
  assert.equal(body.content[0].content.length, 2);
  assert.equal(body.content[0].content[0].url, 'https://alpha.example/a');
  const text = body.content.find((b) => b.type === 'text');
  assert.ok(text, '必须带 text citations（dsh provider 从 cited_text 取 snippet）');
  assert.equal(text.citations[0].cited_text, 'alpha snippet');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].body.query, 'hello world');
  assert.equal(seen[0].body.max_results, 8,
    'max_uses 是工具执行次数，不是结果条数；原生分支应按 SEARCH_DEFAULT_MAX_RESULTS 请求');
});

test('workbuddy search：401 后刷新凭据并重试一次', async () => {
  seen.length = 0;
  refreshCalls = 0;
  refreshSearchCalls = 0;
  const res = await post('/v1/web_search', { query: 'needs-refresh query' });
  assert.equal(res.status, 200);
  assert.equal(seen.length, 2, '401 后应刷新并重试一次');
  assert.equal(refreshCalls, 1);
  assert.match(String(seen[0].headers.authorization), /^Bearer fake-access-token$/);
  assert.match(String(seen[1].headers.authorization), /^Bearer fresh-search-token$/);
});

test('workbuddy search：15001 映射成 429，非法 query 本地 400', async () => {
  seen.length = 0;
  const limited = await post('/v1/web_search', { query: 'rate-limit test' });
  assert.equal(limited.status, 429);
  const limitedBody = await limited.json();
  assert.equal(limitedBody.error.code, 'WEB_SEARCH_RATE_LIMITED');

  const before = seen.length;
  const bad = await post('/v1/web_search', { query: 'x' });
  assert.equal(bad.status, 400);
  assert.equal(seen.length, before, '非法 query 不应打上游');
});

test.after(async () => {
  child.kill();
  await new Promise((r) => { child.once('exit', r); setTimeout(r, 2000); });
  await new Promise((r) => stub.close(r));
  rmSync(dir, { recursive: true, force: true });
});

test('workbuddy search：5xx 原样重试一次，429 透出 Retry-After', async () => {
  seen.length = 0;
  flakyCalls = 0;
  const flaky = await post('/v1/web_search', { query: 'flaky query' });
  assert.equal(flaky.status, 200, '502 后应重试并成功');
  assert.equal(seen.length, 2);

  const limited = await post('/v1/web_search', { query: 'http-429 query' });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '7', '上游 Retry-After 必须透出');
});

test('workbuddy search：流式原生搜索明确 400，最后一条 user 无文本 400', async () => {
  const streamed = await post('/v1/messages', {
    model: 'm', stream: true, messages: [{ role: 'user', content: 'query' }],
    tools: [{ type: 'web_search_20250305', name: 'web_search' }],
  });
  assert.equal(streamed.status, 400);
  const streamedBody = await streamed.json();
  assert.match(streamedBody.error.message, /non-streaming/i);

  const imageOnly = await post('/v1/messages', {
    model: 'm', stream: false,
    messages: [
      { role: 'user', content: 'old query' },
      { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }] },
    ],
    tools: [{ type: 'web_search_20250305', name: 'web_search' }],
  });
  assert.equal(imageOnly.status, 400, '不能回头搜索更早的 user 文本');
});

test('workbuddy search：非 JSON 200 不能伪装成空结果，非 http(s) URL 被丢弃', async () => {
  const malformed = await post('/v1/web_search', { query: 'malformed query' });
  assert.equal(malformed.status, 502, 'HTML/空体必须报上游错误，而不是 0 结果成功');
  const malformedBody = await malformed.json();
  assert.equal(malformedBody.error.code, 'WEB_SEARCH_UPSTREAM');

  const bad = await post('/v1/web_search', { query: 'bad-url query' });
  assert.equal(bad.status, 200);
  const body = await bad.json();
  assert.equal(body.results.length, 1);
  assert.equal(body.results[0].url, 'https://good.example/g');
});

test('workbuddy search：/v1/messages 的上游 429 也映射成 rate_limit_error', async () => {
  const res = await post('/v1/messages', {
    model: 'm',
    messages: [{
      role: 'user',
      content: [{ type: 'text', text: 'Perform a web search for the query: rate-limit test' }],
    }],
    tools: [{ type: 'web_search_20250305', name: 'web_search' }],
  });
  assert.equal(res.status, 429);
  const body = await res.json();
  assert.equal(body.error.type, 'rate_limit_error');
  assert.equal(body.error.code, 'WEB_SEARCH_RATE_LIMITED');
  assert.ok(res.headers.get('retry-after'), '限流必须带 Retry-After');
});

test('workbuddy search：超大 body 回 413，后续请求仍可用', async () => {
  const huge = await post('/v1/web_search', { query: 'x'.repeat(70 * 1024) });
  assert.equal(huge.status, 413);
  const after = await post('/v1/web_search', { query: 'after big body' });
  assert.equal(after.status, 200);
});

test('workbuddy search：max_results 非法本地 400，wrapped/empty 正常', async () => {
  const bad = await post('/v1/web_search', { query: 'hello', max_results: 'abc' });
  assert.equal(bad.status, 400);
  const zero = await post('/v1/web_search', { query: 'hello', max_results: 0 });
  assert.equal(zero.status, 400);

  const wrapped = await post('/v1/web_search', { query: 'wrapped query' });
  assert.equal(wrapped.status, 200);
  assert.equal((await wrapped.json()).results.length, 2);

  const empty = await post('/v1/web_search', { query: 'empty query' });
  assert.equal(empty.status, 200);
  assert.equal((await empty.json()).results.length, 0);
});
