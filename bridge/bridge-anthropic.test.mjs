/**
 * `/v1/messages`（Anthropic 协议，Claude Code 走的这条）的**合约测试**。
 *
 *   node --test bridge/bridge-anthropic.test.mjs
 *
 * 与 `bridge-responses.test.mjs` 同一套路：真起桥 + 打桩上游
 * （`CODEBUDDY_ENDPOINT` 指向本机假服务），既能端到端验字节形状，
 * 又不消耗真实额度、不依赖模型当天心情。
 *
 * ## 这一轮补上的三条契约（都是实测暴露出来的真实缺陷）
 *
 * 1. **并行工具调用不得交错损坏**。Anthropic 要求每个内容块
 *    `content_block_start → delta… → content_block_stop` 严格配对，
 *    块关闭之后的 delta 会被客户端丢弃。原先的实现用一个「当前打开的块」
 *    表示状态，于是**后一个工具的 name 一到就把前一个工具块关掉** ——
 *    OpenAI 的并行调用允许多个调用交错下发（先把所有 name/id 发完、
 *    再逐个发 arguments），此时前一个工具的参数落在自己的 stop 之后，
 *    input 变成空对象。
 * 2. **流中途断了不能伪装成干净的回合**。原先无条件发
 *    `message_delta(stop_reason: end_turn)` + `message_stop` → Claude Code
 *    认为回合正常结束，用户看到"说话说一半突然停下"，不报错也不重试。
 *    现在改发 `event: error` 且不发 `message_stop`。
 * 3. `count_tokens` 里的图片必须按图片计价。同一张 260KB 截图，
 *    放在 `tool_result.content` 里曾算成 66,584 tokens、放在顶层 `image`
 *    块里只算 4 —— 两个都错，且直接影响客户端的上下文占用与自动压缩。
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
const TOKEN = 'anthropic-test-token';

// ── 打桩上游 ──────────────────────────────────────────────────────────────
let scenario = { kind: 'text' };
let lastUpstreamBody = null;

const sse = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
/** 一帧文本增量。 */
const dText = (t) => ({ id: 'c1', model: 'm', choices: [{ index: 0, delta: { content: t }, finish_reason: '' }] });
/** 一帧工具调用增量。`fn` 形如 `{name}` 或 `{arguments}`。 */
const dTool = (index, fn, id) => ({
  id: 'c1', model: 'm',
  choices: [{ index: 0, delta: { tool_calls: [{ index, ...(id ? { id } : {}), function: fn }] }, finish_reason: '' }],
});
const dStop = (reason) => ({
  id: 'c1', model: 'm',
  choices: [{ index: 0, delta: {}, finish_reason: reason }],
  usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
});

const upstream = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    if (!req.url.startsWith('/v2/chat/completions')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 0, data: { models: [] } }));
      return;
    }
    try { lastUpstreamBody = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { lastUpstreamBody = null; }

    if (scenario.kind === 'error401') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ msg: 'upstream says no', code: 40101 }));
      return;
    }

    if (scenario.kind === '11128thenText') {
      scenario.calls = (scenario.calls || 0) + 1;
      if (scenario.calls === 1) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 11128, msg: 'Illegal API invocation from an unapproved channel' }));
        return;
      }
      // 第二次走下面的正常文本分支
    }

    if (scenario.kind === 'midBreak') {
      // 先给半句正文，然后**粗暴掐断**（模拟上游/网络中断）
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(sse(dText('说到一半')));
      setTimeout(() => res.socket?.destroy(), 100);
      return;
    }

    if (scenario.kind === 'halfClose') {
      // **干净半关**：上游正常 end()，但没有 finish_reason / usage / [DONE]
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(sse(dText('说到一半')));
      res.end();
      return;
    }

    if (scenario.kind === 'interleavedTools') {
      /*
       * OpenAI **并行工具调用的常见形状**：先把所有调用的 name/id 发完，
       * 再逐个发 arguments。第二个工具的 name 到达时，第一个工具的参数
       * 还没开始 —— 这正是旧实现会提前 close 掉第一个块的场景。
       */
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(sse(dTool(0, { name: 'Read' }, 'call_a')));
      res.write(sse(dTool(1, { name: 'Grep' }, 'call_b')));
      res.write(sse(dTool(0, { arguments: '{"file_path":"/a.ts"}' })));
      res.write(sse(dTool(1, { arguments: '{"pattern":"foo"}' })));
      res.write(sse(dStop('tool_calls')));
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    if (scenario.kind === 'twoBareTools') {
      /*
       * **两个工具都只给了 name、没有任何 arguments**（模型决定不传参数）。
       *
       * 这条钉的是一个很容易复发的状态 bug：如果用**单个变量**记"待发 start 的
       * 工具块"，第二个块一创建就把第一个覆盖掉 —— 于是第一个块永远没发
       * `content_block_start`，收尾却仍给它补一个 `content_block_stop`：
       * 实测 starts=[1] / stops=[0,1]，客户端那边第一个工具调用**根本不存在**。
       * 所以补发必须遍历全部未 start 的块，不能只补"最后一个"。
       */
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(sse(dTool(0, { name: 'Alpha' }, 'call_a')));
      res.write(sse(dTool(1, { name: 'Beta' }, 'call_b')));
      res.write(sse(dStop('tool_calls')));
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    if (scenario.kind === 'textThenTool') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(sse(dText('Checking.')));
      res.write(sse(dTool(0, { name: 'Read' }, 'call_a')));
      res.write(sse(dTool(0, { arguments: '{"p":1}' })));
      res.write(sse(dStop('tool_calls')));
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    if (scenario.kind === 'stopWithToolBlocks') {
      /*
       * 上游以 `stop` 收尾，但工具块**已经发出去了**。
       * Anthropic 的协议不变量是「有 tool_use 块 ⇒ stop_reason 必须是 tool_use」；
       * 报 end_turn 会让客户端把工具块当成装饰、直接结束回合（工具调用被静默丢掉）。
       */
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(sse(dTool(0, { name: 'Read' }, 'call_a')));
      res.write(sse(dTool(0, { arguments: '{"p":1}' })));
      res.write(sse(dStop('stop')));
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    // 默认：正常一句话
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(sse(dText('hi')));
    res.write(sse(dStop('stop')));
    res.write('data: [DONE]\n\n');
    res.end();
  });
});

// ── 起桥 ──────────────────────────────────────────────────────────────────
await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
const UPSTREAM_PORT = upstream.address().port;

const dir = mkdtempSync(join(tmpdir(), 'wb-anthropic-'));
const authFile = join(dir, 'fake.info');
/*
 * 账本必须隔离：这个文件会真的 spawn 桥、真的发请求，不指到临时文件就会往
 * 仓库的 `bridge/usage.jsonl`（**使用者的真实账本**）里写测试记录，而账本满了
 * 会**截断保留最近一半** —— 等于把用户自己的用量历史挤掉。
 * `bridge-startup.test.mjs` 有一条守卫用例专门盯这件事。
 */
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

const bridgePort = 19100 + (process.pid % 300);
const child = spawn(process.execPath, [BRIDGE], {
  env: {
    ...process.env,
    WORKBUDDY_PORT: String(bridgePort),
    WORKBUDDY_LOCAL_TOKEN: TOKEN,
    WORKBUDDY_AUTH_FILE: authFile,
    WORKBUDDY_CREDENTIAL_DIR: join(dir, 'credentials'),
    CODEBUDDY_ENDPOINT: `http://127.0.0.1:${UPSTREAM_PORT}`,
    WORKBUDDY_USAGE_FILE: usageFile,
    WORKBUDDY_AUTO_CHECKIN: '0',
    WORKBUDDY_LOG: '0',
    WORKBUDDY_SKIP_MODEL_PREFLIGHT: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
let bridgeLog = '';
child.stdout.on('data', (d) => { bridgeLog += d; });
child.stderr.on('data', (d) => { bridgeLog += d; });

const BASE = `http://127.0.0.1:${bridgePort}`;

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

const post = (body, path = '/v1/messages') => fetch(`${BASE}${path}`, {
  method: 'POST',
  headers: { 'x-api-key': TOKEN, 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
  body: JSON.stringify(body),
});

/** `POST /v1/messages/count_tokens`（纯本地估算，不打上游）。 */
const countTokens = (body) => post(body, '/v1/messages/count_tokens');

/** 解析 Anthropic 的 SSE（`event:` + `data:` 成对）。 */
function parseSse(text) {
  const events = [];
  let cur = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('event: ')) cur = line.slice(7).trim();
    else if (line.startsWith('data: ') && cur) { events.push({ event: cur, data: JSON.parse(line.slice(6)) }); cur = null; }
  }
  return events;
}

/** 块协议不变量：没有 delta 落在同 index 的 stop 之后；start/stop 一一配对且升序。 */
function assertBlockProtocol(events) {
  const closed = new Set();
  for (const e of events) {
    if (e.event === 'content_block_delta') {
      assert.ok(!closed.has(e.data.index),
        `index ${e.data.index} 在 content_block_stop 之后又收到了 delta —— 客户端会丢弃它（内容损坏）`);
    }
    if (e.event === 'content_block_stop') closed.add(e.data.index);
  }
  const starts = events.filter((e) => e.event === 'content_block_start').map((e) => e.data.index);
  const stops = events.filter((e) => e.event === 'content_block_stop').map((e) => e.data.index);
  assert.equal(starts.length, stops.length,
    `start/stop 数量不等：starts=${JSON.stringify(starts)} stops=${JSON.stringify(stops)}`);
  for (const i of starts) assert.ok(stops.includes(i), `index ${i} 有 start 没有 stop`);
  assert.deepEqual(stops, [...stops].sort((a, b) => a - b), `stop 必须按 index 升序：${JSON.stringify(stops)}`);
  assert.equal(new Set(starts).size, starts.length, `块索引不得重复：${JSON.stringify(starts)}`);
}

/** 按 index 重建**工具块**的 name 与 arguments（只认 tool_use 块）。 */
function rebuildToolBlocks(events) {
  const byIndex = new Map();
  for (const e of events) {
    if (e.event === 'content_block_start' && e.data.content_block?.type === 'tool_use') {
      byIndex.set(e.data.index, { name: e.data.content_block.name, args: '' });
    } else if (e.event === 'content_block_delta' && e.data.delta?.type === 'input_json_delta') {
      const b = byIndex.get(e.data.index);
      if (b) b.args += e.data.delta.partial_json;
    }
  }
  return [...byIndex.values()];
}

// ── 用例 ──────────────────────────────────────────────────────────────────

test('并行工具调用交错下发：块不得被提前关闭（delta 不能落在自己的 stop 之后）', async () => {
  await waitReady();
  scenario = { kind: 'interleavedTools' };
  const res = await post({ model: 'm', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'go' }] });
  assert.equal(res.status, 200);
  const events = parseSse(await res.text());

  assertBlockProtocol(events);

  // 两个工具各自的参数必须完整、且归到正确的块上
  const blocks = rebuildToolBlocks(events);
  assert.equal(blocks.length, 2, `应有两个工具块，实际 ${blocks.length}`);
  const read = blocks.find((b) => b.name === 'Read');
  const grep = blocks.find((b) => b.name === 'Grep');
  assert.ok(read, `没有 Read 块，实际：${JSON.stringify(blocks.map((b) => b.name))}`);
  assert.ok(grep, `没有 Grep 块，实际：${JSON.stringify(blocks.map((b) => b.name))}`);
  assert.deepEqual(JSON.parse(read.args), { file_path: '/a.ts' },
    'Read 的参数必须完整 —— 旧实现会把它关在 stop 之后，客户端拿到空 input');
  assert.deepEqual(JSON.parse(grep.args), { pattern: 'foo' }, 'Grep 的参数必须完整');

  // 有工具块时 stop_reason 必须是 tool_use
  const md = events.find((e) => e.event === 'message_delta');
  assert.equal(md.data.delta.stop_reason, 'tool_use');
  assert.equal(events[events.length - 1].event, 'message_stop', '正常流必须以 message_stop 收尾');
});

test('两个工具都无 arguments：两个块都必须发 start（不得被静默吞掉一个）', async () => {
  await waitReady();
  scenario = { kind: 'twoBareTools' };
  const res = await post({ model: 'm', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'go' }] });
  const events = parseSse(await res.text());
  assertBlockProtocol(events); // 含「每个 stop 必须有配对的 start」

  const names = events
    .filter((e) => e.event === 'content_block_start' && e.data.content_block.type === 'tool_use')
    .map((e) => e.data.content_block.name);
  assert.deepEqual(names, ['Alpha', 'Beta'],
    `两个工具调用都必须发出去。实际发出 ${JSON.stringify(names)} —— `
    + '少一个说明「待发 start 的工具块」用了单个变量、被后一个覆盖了');
});

test('文本块与工具块混排：文本先关、工具后关，块协议仍成立', async () => {
  await waitReady();
  scenario = { kind: 'textThenTool' };
  const res = await post({ model: 'm', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'go' }] });
  const events = parseSse(await res.text());
  assertBlockProtocol(events);
  const types = events.filter((e) => e.event === 'content_block_start').map((e) => e.data.content_block.type);
  assert.deepEqual(types, ['text', 'tool_use'], `块类型顺序应为 text → tool_use，实际 ${JSON.stringify(types)}`);
  const blocks = rebuildToolBlocks(events);
  assert.deepEqual(JSON.parse(blocks[0].args), { p: 1 });
});

test('上游以 stop 收尾但已发出工具块：stop_reason 仍须是 tool_use（否则工具被静默丢掉）', async () => {
  await waitReady();
  scenario = { kind: 'stopWithToolBlocks' };
  const res = await post({ model: 'm', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'go' }] });
  const events = parseSse(await res.text());
  const hasToolBlock = events.some((e) => e.event === 'content_block_start' && e.data.content_block.type === 'tool_use');
  assert.ok(hasToolBlock, '这个场景应当发出工具块');
  const md = events.find((e) => e.event === 'message_delta');
  assert.equal(md.data.delta.stop_reason, 'tool_use',
    'Anthropic 的硬约束：有 tool_use 内容块 ⇒ stop_reason 必须是 tool_use'
    + '（报 end_turn 会让客户端把工具块当成装饰、直接结束回合）');
});

test('流中途断开：必须发 event: error 且不发 message_stop（不能伪装成干净回合）', async () => {
  await waitReady();
  scenario = { kind: 'midBreak' };
  const res = await post({ model: 'm', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'do the thing' }] });
  assert.equal(res.status, 200, '已经答应过是事件流，只能 200 + SSE');
  const events = parseSse(await res.text());
  const kinds = events.map((e) => e.event);

  assert.ok(!kinds.includes('message_stop'),
    `上游流中途断了，绝不能发 message_stop（会伪装成正常回合结束，客户端不报错也不重试）。实际事件：${kinds.join(', ')}`);
  const err = events.find((e) => e.event === 'error');
  assert.ok(err, `缺 event: error。实际事件：${kinds.join(', ')}`);
  assert.equal(err.data.type, 'error');
  assert.ok(err.data.error, 'error 事件必须带 error 对象');
  assert.match(err.data.error.message, /interrupted/i, '错误信息要说清是"上游流中途断了"');

  // 半截内容仍要发出去（便于排查），但块必须已收尾
  assert.match(JSON.stringify(events.filter((e) => e.event === 'content_block_delta')), /说到一半/);
  assertBlockProtocol(events);
});

test('干净半关：同样必须发 event: error 且不发 message_stop（不能只认"被掐断"）', async () => {
  /*
   * 与上一条不同：上游是**正常 end()**，只是没给 finish_reason / [DONE]。
   * 旧实现只把 `catch` 里的异常当失败，这条会一路走到 end_turn + message_stop。
   */
  await waitReady();
  scenario = { kind: 'halfClose' };
  const res = await post({ model: 'm', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'do the thing' }] });
  assert.equal(res.status, 200);
  const events = parseSse(await res.text());
  const kinds = events.map((e) => e.event);
  assert.ok(!kinds.includes('message_stop'), `干净半关绝不能发 message_stop。实际：${kinds.join(', ')}`);
  const err = events.find((e) => e.event === 'error');
  assert.ok(err, `缺 event: error。实际：${kinds.join(', ')}`);
  assert.match(String(err.data?.error?.message), /before completion|interrupted/i);
  assertBlockProtocol(events);
});

test('正常流不受影响：message_start → … → message_delta → message_stop，且无 error 事件', async () => {
  await waitReady();
  scenario = { kind: 'text' };
  const res = await post({ model: 'm', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'hi' }] });
  const events = parseSse(await res.text());
  const kinds = events.map((e) => e.event);
  assert.equal(kinds[0], 'message_start');
  assert.equal(kinds[kinds.length - 1], 'message_stop');
  assert.equal(kinds[kinds.length - 2], 'message_delta');
  assert.ok(!kinds.includes('error'), `正常流不该有 error 事件：${kinds.join(', ')}`);
  assertBlockProtocol(events);
  assert.equal(events.find((e) => e.event === 'message_delta').data.delta.stop_reason, 'end_turn');
});

/*
 * 图片计价：同一张图放在两个位置必须得到**同一个量级**的估算。
 *
 * 旧实现没有图片分支 —— 同一张 260KB 截图：
 *   放在 `tool_result.content`（数组）里 → 走 JSON.stringify → 按字符计价 → 66,584
 *   放在顶层 `{type:'image'}` 块里        → 无 text/content/input → 4
 * 两个数字都直接喂给 Claude Code 的上下文占用条与自动压缩阈值。
 */
test('count_tokens：同一张图放两个位置，估算必须同量级且不按 base64 字符数计价', async () => {
  await waitReady();
  scenario = { kind: 'text' };
  const bigBase64 = 'A'.repeat(260 * 1024); // ~260KB，真实截图量级
  const img = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: bigBase64 } };

  const inToolResult = await (await countTokens({
    model: 'm',
    messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [img] }] }],
  })).json();

  const atTopLevel = await (await countTokens({
    model: 'm',
    messages: [{ role: 'user', content: [img] }],
  })).json();

  assert.ok(Number.isFinite(inToolResult.input_tokens) && inToolResult.input_tokens > 0);
  assert.ok(Number.isFinite(atTopLevel.input_tokens) && atTopLevel.input_tokens > 0);

  // 不得把 base64 当文本计价（266,240 字符 / 4 ≈ 66,560）
  assert.ok(inToolResult.input_tokens < 5000,
    `tool_result 里的图片被按字符数计价了（${inToolResult.input_tokens} tokens）——`
    + '真实约 1,000–1,600；高估会把客户端的上下文占用与自动压缩阈值整个带偏');
  // 也不得完全不计
  assert.ok(atTopLevel.input_tokens > 100,
    `顶层 image 块几乎没被计价（${atTopLevel.input_tokens} tokens）——会让客户端低估到上下文溢出`);

  // 两个位置必须同量级（比值 < 2），否则说明两处口径不一致
  const ratio = Math.max(inToolResult.input_tokens, atTopLevel.input_tokens)
    / Math.min(inToolResult.input_tokens, atTopLevel.input_tokens);
  assert.ok(ratio < 2,
    `同一张图两个位置差 ${ratio.toFixed(1)} 倍（tool_result=${inToolResult.input_tokens}, `
    + `顶层=${atTopLevel.input_tokens}）——两处口径必须一致`);
});

test('count_tokens：纯文本请求不受影响（图片修复不得改变文本口径）', async () => {
  await waitReady();
  scenario = { kind: 'text' };
  const j = await (await countTokens({
    model: 'm',
    messages: [{ role: 'user', content: 'hello world' }],
  })).json();
  assert.equal(j.input_tokens, 7,
    '"hello world"（11 字符 ASCII → ceil(11/4)=3）加 1 条消息开销 4 应为 7'
    + `，实际 ${j.input_tokens} —— 图片分支不得改变纯文本口径`);
});

test('11128：Anthropic 路径也要渐进兜底，成功时回 fallback 头', async () => {
  await waitReady();
  scenario = { kind: '11128thenText' };
  const { status, headers } = await post({
    model: 'm',
    stream: false,
    max_tokens: 8,
    system: `First paragraph identity.

Second paragraph instructions.`,
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert.equal(status, 200, '第一次 11128 后应降级 system 并成功');
  assert.equal(scenario.calls, 2, '应只多打一次上游');
  assert.equal(headers.get('x-workbuddy-11128-fallback'), 'drop-first-system-paragraph');
  assert.ok(lastUpstreamBody.messages.some((m) => m.role === 'system' && m.content.includes('Second paragraph instructions')),
    '第二条请求应保留首段之后的 system instructions');
});

test('上游 401：Anthropic 路径回 502 + authentication_error，并提示重登 WorkBuddy', async () => {
  await waitReady();
  scenario = { kind: 'error401' };
  const res = await post({
    model: 'm',
    stream: false,
    max_tokens: 8,
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert.equal(res.status, 502, '上游登录过期不能原样回 401，否则客户端会怀疑本地令牌');
  const j = await res.json();
  assert.equal(j.error.type, 'authentication_error');
  assert.match(j.error.message, /upstream login expired/i);
  assert.match(j.error.message, /upstream says no/, '上游原始 msg 仍应保留用于排查');
});

// ── 收尾 ──────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test.after(async () => {
  child.kill();
  upstream.close();
  // Windows：桥刚被 kill，句柄还没释放，rmSync 会 EPERM —— 带重试，仍失败只警告
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
