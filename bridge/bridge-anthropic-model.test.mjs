/**
 * Claude Code 适配的**模型名语义**与**能力透传**（issue #18）。
 *
 *   node --test bridge/bridge-anthropic-model.test.mjs
 *
 * 为什么单独一个文件：这些用例要**目录里有真实 id**（`deepseek-v4.1-flash` 等），
 * 才能验证「剥后缀 → 精确命中 → 别名映射 → 未知 id 报错」这条判定链；
 * 而 `bridge-anthropic.test.mjs` 的桩故意返回空目录（它验的是块协议）。
 *
 * 覆盖：
 *   1. `[1m]` 后缀（Claude Code 的 1M 标记）必须被剥掉，**不能**落进「小快正则」
 *      被静默换成别的模型（issue #18 的核心 bug）；
 *   2. 客户端原生别名（claude-*）继续映射到默认模型（兼容，不回归）；
 *   3. 目录里没有的名字 → 明确 404，**不打上游**；
 *   4. `thinking` → 上游 `reasoning_effort`（原先整个字段被丢弃）；
 *   5. `tool_result.is_error` 要透传（工具失败被当成功 = 模型基于错误结果继续推理）；
 *   6. MCP / 服务端工具块不再静默消失。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pickBridgePort } from '../tools/dev/bridge-ports.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BRIDGE = join(HERE, '..', 'bridge', 'workbuddy-bridge.mjs');
const TOKEN = 'test-token-anthropic-model';

const CATALOG = [
  {
    id: 'deepseek-v4.1-flash',
    maxInputTokens: 1000000,
    maxOutputTokens: 128000,
    // 官方默认档 300K、真实上限 1M —— 两者的差正是"客户端要 1M 却被按 300K 规划"的来源
    contextWindow: { defaultLength: 300000, supportedLengths: [300000, 600000, 1000000] },
  },
  { id: 'glm-5.3', maxInputTokens: 1000000, maxOutputTokens: 48000 },
  { id: 'glm-5.3-flash', maxInputTokens: 1000000, maxOutputTokens: 4096 },
];

let lastUpstreamBody = null;
let chatHits = 0;
/** 目录桩：可变，用来模拟「上游没给目录」（冷目录）。 */
let catalogModels = CATALOG;
/** 模拟「上游没回 usage」：非流式响应必须用本地估算兜底，不能报 0。 */
let omitUsage = false;

const upstream = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    if (!req.url.startsWith('/v2/chat/completions')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 0, data: { models: catalogModels } }));
      return;
    }
    chatHits += 1;
    try { lastUpstreamBody = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { lastUpstreamBody = null; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":""}]}\n\n');
    if (!omitUsage) {
      res.write('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":11,"completion_tokens":7,"total_tokens":18}}\n\n');
    } else {
      res.write('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n');
    }
    res.end('data: [DONE]\n\n');
  });
});
await new Promise((r) => upstream.listen(0, '127.0.0.1', r));

const dir = mkdtempSync(join(tmpdir(), 'wb-anthropic-model-'));
const authFile = join(dir, 'fake.info');
const usageFile = join(dir, 'usage.jsonl');
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

const bridgePort = pickBridgePort();
const child = spawn(process.execPath, [BRIDGE], {
  env: {
    ...process.env,
    WORKBUDDY_PORT: String(bridgePort),
    WORKBUDDY_LOCAL_TOKEN: TOKEN,
    WORKBUDDY_AUTH_FILE: authFile,
    WORKBUDDY_CREDENTIAL_DIR: join(dir, 'credentials'),
    CODEBUDDY_ENDPOINT: `http://127.0.0.1:${upstream.address().port}`,
    WORKBUDDY_USAGE_FILE: usageFile,
    WORKBUDDY_AUTO_CHECKIN: '0',
    WORKBUDDY_LOG: '0',
    // 默认模型与客户端别名各给一个固定值，便于断言
    WORKBUDDY_ANTHROPIC_MODEL: 'glm-5.3',
    WORKBUDDY_ANTHROPIC_FAST_MODEL: 'glm-5.3-flash',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
let bridgeLog = '';
child.stdout.on('data', (d) => { bridgeLog += d; });
child.stderr.on('data', (d) => { bridgeLog += d; });

const BASE = `http://127.0.0.1:${bridgePort}`;
const post = (body, path = '/v1/messages') => fetch(`${BASE}${path}`, {
  method: 'POST',
  headers: { 'x-api-key': TOKEN, 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
  body: JSON.stringify(body),
});

async function waitReady() {
  for (let i = 0; i < 80; i += 1) {
    try {
      const r = await fetch(`${BASE}/health`, { headers: { authorization: `Bearer ${TOKEN}` }, signal: AbortSignal.timeout(1000) });
      if (r.ok) return;
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`桥没能在 20 秒内就绪。日志：\n${bridgeLog.slice(-1500)}`);
}

test.after(() => {
  try { child.kill(); } catch { /* 已退出 */ }
  try { upstream.close(); } catch { /* 已关 */ }
  rmSync(dir, { recursive: true, force: true });
});

await waitReady();

test('模型名带 [1m] 后缀：剥掉后缀后精确命中目录，绝不被换成小快模型', async () => {
  chatHits = 0;
  lastUpstreamBody = null;
  const res = await post({
    model: 'deepseek-v4.1-flash[1m]',
    max_tokens: 64,
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert.equal(res.status, 200, `请求失败：${await res.text()}`);
  assert.equal(chatHits, 1);
  assert.equal(lastUpstreamBody?.model, 'deepseek-v4.1-flash',
    '用户指定的模型必须原样出站（issue #18：原先会落进 flash 正则被换成 glm-5.3-flash）');
});

test('客户端原生别名（claude-*）继续映射到默认模型（兼容，不回归）', async () => {
  chatHits = 0;
  lastUpstreamBody = null;
  const res = await post({
    model: 'claude-sonnet-4-5',
    max_tokens: 64,
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert.equal(res.status, 200);
  assert.equal(chatHits, 1);
  assert.equal(lastUpstreamBody?.model, 'glm-5.3', 'claude-* 别名应映射到配置的默认模型');
});

test('目录里没有的名字：明确报 404，且不打上游', async () => {
  chatHits = 0;
  lastUpstreamBody = null;
  const res = await post({
    model: 'totally-unknown-model',
    max_tokens: 64,
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert.equal(res.status, 404, '未知模型必须明确报错，不能静默换成别的模型');
  const body = await res.json();
  assert.equal(body?.error?.type, 'not_found_error');
  assert.match(String(body?.error?.message), /not in the current catalog/);
  assert.equal(chatHits, 0, '被拒的请求不应打上游');
});

test('thinking（Claude Code 的扩展思考开关）→ 上游 reasoning_effort', async () => {
  chatHits = 0;
  lastUpstreamBody = null;
  const res = await post({
    model: 'glm-5.3-flash',
    max_tokens: 64,
    thinking: { type: 'enabled', budget_tokens: 8000 },
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert.equal(res.status, 200);
  assert.equal(lastUpstreamBody?.reasoning_effort, 'medium',
    '8000 token 预算应映射到 medium 档（上游只认 reasoning_effort，thinking 会 400）');
});

test('tool_result 带 is_error：必须让模型看到"这次失败了"', async () => {
  chatHits = 0;
  lastUpstreamBody = null;
  const res = await post({
    model: 'deepseek-v4.1-flash',
    max_tokens: 64,
    messages: [{
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'a.txt' } }],
    }, {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'toolu_1',
        is_error: true,
        content: [{ type: 'text', text: 'ENOENT: no such file' }],
      }],
    }],
  });
  assert.equal(res.status, 200);
  const toolMsg = (lastUpstreamBody?.messages || []).find((m) => m.role === 'tool');
  assert.ok(toolMsg, '工具结果必须转成 tool 消息');
  const content = typeof toolMsg.content === 'string' ? toolMsg.content : JSON.stringify(toolMsg.content);
  assert.match(content, /tool_error/, '失败标记必须透传给模型，否则它以为工具成功了');
  assert.match(content, /ENOENT/, '原始错误内容要保留');
});

test('MCP 工具块不再静默消失', async () => {
  chatHits = 0;
  lastUpstreamBody = null;
  const res = await post({
    model: 'deepseek-v4.1-flash',
    max_tokens: 64,
    messages: [{
      role: 'assistant',
      content: [{ type: 'mcp_tool_use', id: 'toolu_mcp', name: 'read_file', input: { path: 'a.txt' } }],
    }, {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_mcp', content: [{ type: 'text', text: 'ok' }] }],
    }],
  });
  assert.equal(res.status, 200);
  const assistant = (lastUpstreamBody?.messages || []).find((m) => m.role === 'assistant');
  assert.ok(assistant, '助手轮必须保留');
  const names = (assistant.tool_calls || []).map((c) => c.function?.name);
  assert.ok(names.includes('read_file'), `MCP 工具调用不能丢：${JSON.stringify(lastUpstreamBody?.messages)}`);
});

test('服务端工具结果（web_search_tool_result）不再静默消失', async () => {
  chatHits = 0;
  lastUpstreamBody = null;
  const res = await post({
    model: 'deepseek-v4.1-flash',
    max_tokens: 64,
    messages: [{
      role: 'user',
      content: [{ type: 'web_search_tool_result', content: [{ type: 'web_search_result', title: 't', url: 'https://x.invalid' }] }],
    }],
  });
  assert.equal(res.status, 200);
  const text = JSON.stringify(lastUpstreamBody?.messages || []);
  assert.match(text, /web_search_tool_result/, '服务端工具结果要降级成文本，不能凭空消失');
});

test('max_tokens 超过模型上限：按该模型能力收敛（上游会直接 400）', async () => {
  chatHits = 0;
  lastUpstreamBody = null;
  const res = await post({
    model: 'deepseek-v4.1-flash',
    max_tokens: 999999,
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert.equal(res.status, 200);
  assert.equal(lastUpstreamBody?.max_tokens, 128000, '应收敛到模型的输出上限');
});

test('/v1/models：默认报官方默认档；带 context-1m beta 头时报模型真实上限', async () => {
  const models = async (headers = {}) => {
    const res = await fetch(`${BASE}/v1/models?all=1`, { headers: { 'x-api-key': TOKEN, ...headers } });
    assert.equal(res.status, 200);
    const body = await res.json();
    return body.data.find((m) => m.id === 'deepseek-v4.1-flash');
  };
  const plain = await models();
  assert.equal(plain.context_window, 300000, '默认口径不变（官方默认档 300K）');
  const beta = await models({ 'anthropic-beta': 'interleaved-thinking-2025-05-14, CONTEXT-1M-2025-08-07' });
  assert.equal(beta.context_window, 1000000, '客户端显式要 1M 时按模型真实上限声明');
  const unrelated = await models({ 'anthropic-beta': 'some-unknown-beta-2026' });
  assert.equal(unrelated.context_window, 300000, '无关的 beta 头不能顺带放大窗口');
});

test('usage 补 cache 字段：Claude Code 的上下文占用条会读它们', async () => {  const res = await post({
    model: 'deepseek-v4.1-flash',
    max_tokens: 64,
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body?.usage?.cache_read_input_tokens, 0, '缺字段时部分客户端会当成 undefined');
  assert.equal(body?.usage?.cache_creation_input_tokens, 0);
});

test('非法模型 id（超长 / 含非 ASCII）：400 而不是 500', async () => {
  const tooLong = await post({
    model: 'x'.repeat(500),
    max_tokens: 64,
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert.equal(tooLong.status, 400, '超长 id 必须被入口挡住（否则 http.request 抛异常 → 500）');
  const nonAscii = await post({
    model: '模型-中文名',
    max_tokens: 64,
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert.equal(nonAscii.status, 400, '非可见 ASCII 会让请求头抛异常，必须挡住');
});

test('目录冷（上游没给目录）：未知模型名原样转发，不静默换模型也不报错', async () => {
  // 模拟"上游没回目录"：目录桩清空 + 强制刷新一次缓存
  catalogModels = [];
  await fetch(`${BASE}/v1/models?refresh=1`, { headers: { authorization: `Bearer ${TOKEN}` } });
  await new Promise((r) => setTimeout(r, 400));
  try {
    chatHits = 0;
    lastUpstreamBody = null;
    const res = await post({
      model: 'some-unknown-model',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(res.status, 200, '目录冷时不该报 404（判不了就交给上游）');
    assert.equal(lastUpstreamBody?.model, 'some-unknown-model',
      '目录冷时也不能静默换成别的模型 —— 原样转发给上游裁决');
  } finally {
    catalogModels = CATALOG;
    await fetch(`${BASE}/v1/models?refresh=1`, { headers: { authorization: `Bearer ${TOKEN}` } });
  }
});

// ── 1.20.0：别名矩阵 / 真实 MCP 结果块 / thinking 边界 / 入参类型 ─────────

test('裸 haiku 与 haiku-4-5 也是别名 → 映射到 fast 模型', async () => {
  for (const name of ['haiku', 'haiku-4-5']) {
    chatHits = 0;
    lastUpstreamBody = null;
    const res = await post({
      model: name,
      max_tokens: 64,
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(res.status, 200, `${name} 应当被识别为客户端别名`);
    assert.equal(lastUpstreamBody?.model, 'glm-5.3-flash',
      `${name} 是 Claude Code 的小快模型别名，必须走 fast 模型（原先既不命中别名也不走 fast）`);
  }
});

test('真实 MCP 结果块（mcp_tool_result）：转成 tool 消息，长内容不截断、is_error 透传', async () => {
  chatHits = 0;
  lastUpstreamBody = null;
  const long = 'MCP-OUTPUT-' + 'x'.repeat(2000);
  const res = await post({
    model: 'deepseek-v4.1-flash',
    max_tokens: 64,
    messages: [{
      role: 'assistant',
      content: [{ type: 'mcp_tool_use', id: 'toolu_mcp_2', name: 'read_file', input: { path: 'a.txt' } }],
    }, {
      role: 'user',
      content: [{
        type: 'mcp_tool_result',
        tool_use_id: 'toolu_mcp_2',
        is_error: true,
        content: [{ type: 'text', text: long }],
      }],
    }],
  });
  assert.equal(res.status, 200);
  const toolMsg = (lastUpstreamBody?.messages || []).find((m) => m.role === 'tool');
  assert.ok(toolMsg, 'mcp_tool_result 必须转成 tool 消息（原先落进"不认识的内容块"被截断成 500 字文本）');
  assert.equal(toolMsg.tool_call_id, 'toolu_mcp_2');
  const content = typeof toolMsg.content === 'string' ? toolMsg.content : JSON.stringify(toolMsg.content);
  assert.match(content, /tool_error/, 'is_error 必须透传');
  assert.match(content, /MCP-OUTPUT-/, '内容要保留');
  assert.ok(content.length > 2000, `工具结果不能被截断（实际 ${content.length} 字符）`);
});

test('thinking 的预算边界：缺失 / 0 / 负数 → 不下发 reasoning_effort', async () => {
  for (const thinking of [
    { type: 'enabled' },
    { type: 'enabled', budget_tokens: 0 },
    { type: 'enabled', budget_tokens: -5 },
  ]) {
    chatHits = 0;
    lastUpstreamBody = null;
    const res = await post({
      model: 'glm-5.3-flash',
      max_tokens: 64,
      thinking,
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(res.status, 200, JSON.stringify(thinking));
    assert.equal(lastUpstreamBody?.reasoning_effort, undefined,
      `${JSON.stringify(thinking)} 不该猜一个档位（原先 budget<=0 会被当成 medium）`);
  }
});

test('Anthropic / Responses：非字符串 model 明确 400（不能静默用默认模型）', async () => {
  for (const model of [[], 123, { id: 'x' }]) {
    const res = await post({ model, max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(res.status, 400, `Anthropic 收到 ${JSON.stringify(model)} 应当 400`);
  }
  for (const model of [[], 123, { id: 'x' }]) {
    const res = await fetch(`${BASE}/v1/responses`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model, input: 'hi' }),
    });
    assert.equal(res.status, 400, `Responses 收到 ${JSON.stringify(model)} 应当 400`);
  }
});

test('count_tokens：未知模型 404（验证接入不再假阳性），别名照常 200', async () => {
  const count = (body) => post(body, '/v1/messages/count_tokens');
  const unknown = await count({ model: 'totally-unknown-model', messages: [] });
  assert.equal(unknown.status, 404, '目录已知时未知模型必须 404，否则"验证接入"永远显示通过');
  const alias = await count({ model: 'haiku', messages: [] });
  assert.equal(alias.status, 200, '别名要能解析到真实模型，不能误判未知');
  const bad = await count({ model: [], messages: [] });
  assert.equal(bad.status, 400, '非字符串 model 与 /v1/messages 同判据');
});

test('非流式响应：上游缺 usage 时用本地估算兜底（不能报 0）', async () => {
  omitUsage = true;
  try {
    const res = await post({
      model: 'deepseek-v4.1-flash',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'hello world, please answer' }],
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body?.usage?.input_tokens > 0, '输入 token 不能是 0（Claude Code 会据此算上下文占用）');
    assert.ok(body?.usage?.output_tokens > 0, '输出 token 也不能是 0');
  } finally { omitUsage = false; }
});
