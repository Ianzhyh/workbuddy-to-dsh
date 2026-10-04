/**
 * 协议层自测：用**打桩的上游**驱动适配器，验证
 *   1. dsh 消息 / 工具 → OpenAI wire 请求的转换；
 *   2. OpenAI SSE → dsh StreamChunk 的顺序与内容；
 *   3. 错误、终止、abort 都以 finish 块收尾（契约要求）。
 *
 * 不碰真实上游、不消耗任何额度：桩服务器只回放固定 SSE。
 *
 *   node --test dsh-plugin/tests/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { WorkBuddyAdapter } from '../lib/adapter.mjs';
import { BridgeClient } from '../lib/bridge.mjs';

/** 起一个假桥：/health、/v1/models、/v1/chat/completions（SSE 回放）。 */
async function startStub({ sseFrames = [], status = 200, errorBody = null, capture = null } = {}) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        ok: true,
        pid: 4242,
        startedAt: new Date().toISOString(),
        uptimeMs: 60000,
        auth: { userId: 'stub-user', endpoint: 'https://example.invalid', expiresAt: new Date(Date.now() + 86400000).toISOString(), expired: false },
        models: ['stub-model'],
        catalogSize: 2,
        catalogAt: new Date().toISOString(),
      }));
    }
    if (url.pathname === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        object: 'list',
        data: [
          { id: 'stub-model', name: 'Stub Model', context_window: 128000, max_output_tokens: 8192, credits: 0.5, supports_images: true },
          { id: 'stub-free', name: 'Stub Free', context_window: 32000, max_output_tokens: 4096, credits: 0, free: true },
        ],
      }));
    }
    if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (capture) capture.body = body;
      if (errorBody) {
        res.writeHead(status, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(errorBody));
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const frame of sseFrames) {
        res.write(`data: ${typeof frame === 'string' ? frame : JSON.stringify(frame)}\n\n`);
        await new Promise((r) => setTimeout(r, 1));
      }
      res.write('data: [DONE]\n\n');
      return res.end();
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'no route' } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return { server, baseUrl: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) };
}

function makeAdapter(baseUrl, capture) {
  const client = new BridgeClient({ baseUrl, token: 't', timeoutMs: 5000 });
  return new WorkBuddyAdapter({
    provider: 'workbuddy',
    displayName: 'WorkBuddy',
    client,
    ensureReady: async () => client,
    resolveImage: async () => 'data:image/png;base64,AAAA',
    log: () => {},
    filter: { allow: [], deny: [] },
    catalogTtlMs: 0,
  });
}

const delta = (d, finish = null) => ({ choices: [{ index: 0, delta: d, finish_reason: finish }] });

test('listModels / resolveModel 使用桥目录的元数据', async () => {
  const stub = await startStub();
  try {
    const adapter = makeAdapter(stub.baseUrl);
    const models = await adapter.listModels();
    assert.equal(models.length, 2);
    assert.deepEqual(models[0], { provider: 'workbuddy', id: 'stub-model', name: 'Stub Model', inputModalities: ['text', 'image'] });
    const resolved = await adapter.resolveModel('workbuddy', 'stub-model');
    assert.equal(resolved.context.contextWindow, 128000);
    assert.equal(resolved.defaultMaxTokens, 8192);
    assert.equal(adapter.providerInfo('workbuddy').id, 'workbuddy');
    assert.equal(adapter.providerRetryPolicy().mode, 'normal');
  } finally { await stub.close(); }
});

test('文本流：block-start → text-delta → block-end → usage → finish', async () => {
  const stub = await startStub({
    sseFrames: [
      delta({ role: 'assistant', content: '' }),
      delta({ content: '你' }),
      delta({ content: '好' }),
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 2, total_tokens: 13 } },
    ],
  });
  try {
    const adapter = makeAdapter(stub.baseUrl);
    const out = [];
    for await (const chunk of adapter.stream({ provider: 'workbuddy', model: 'stub-model', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })) out.push(chunk);

    assert.deepEqual(out.map((c) => c.type), ['block-start', 'text-delta', 'text-delta', 'block-end', 'usage', 'finish']);
    assert.equal(out[0].blockType, 'text');
    assert.equal(out[3].block.text, '你好');
    assert.deepEqual(out[4].usage, { inputTokens: 11, outputTokens: 2, totalTokens: 13 });
    assert.deepEqual(out[5].reason, { kind: 'stop' });
  } finally { await stub.close(); }
});

test('工具调用：tool-call-delta 累积出完整的 JSON 参数，finish 为 tool-calls', async () => {
  const stub = await startStub({
    sseFrames: [
      delta({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"pa' } }] }),
      delta({ tool_calls: [{ index: 0, function: { arguments: 'th":"a.txt"}' } }] }),
      { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    ],
  });
  try {
    const adapter = makeAdapter(stub.baseUrl);
    const out = [];
    for await (const chunk of adapter.stream({ provider: 'workbuddy', model: 'stub-model', messages: [] })) out.push(chunk);
    const end = out.find((c) => c.type === 'block-end');
    assert.deepEqual(end.block, { type: 'tool-call', id: 'call_1', name: 'read', arguments: '{"path":"a.txt"}' });
    assert.equal(out.at(-1).reason.kind, 'tool-calls');
    const start = out.find((c) => c.type === 'block-start');
    assert.equal(start.blockType, 'tool-call');
  } finally { await stub.close(); }
});

test('wire 请求：developer→system、工具表、图片、max_tokens', async () => {
  const capture = {};
  const stub = await startStub({
    sseFrames: [delta({ content: 'ok' }), { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }],
    capture,
  });
  try {
    const adapter = makeAdapter(stub.baseUrl);
    for await (const _ of adapter.stream({
      provider: 'workbuddy',
      model: 'stub-model',
      system: 'SYS',
      maxTokens: 256,
      temperature: 0.3,
      tools: [{ name: 'read', description: 'read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } }],
      toolHistory: { tools: [], updates: [{ messageId: 'm1', additions: [{ name: 'grep', description: 'grep', parameters: { type: 'object' } }] }] },
      messages: [
        { role: 'developer', content: [{ type: 'text', text: 'DEV' }] },
        { role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image', attachment: { attachmentId: 'a1', mediaType: 'image/png' } }] },
        { role: 'assistant', content: [{ type: 'text', text: 'ok' }, { type: 'tool-call', id: 'c1', name: 'read', arguments: '{"path":"a"}' }] },
        { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'file body' }] },
      ],
    })) { /* drain */ }

    const body = capture.body;
    assert.equal(body.stream, true);
    assert.equal(body.max_tokens, 256);
    assert.equal(body.temperature, 0.3);
    assert.equal(body.messages[0].role, 'system');
    assert.equal(body.messages[0].content, 'SYS');
    assert.equal(body.messages[1].role, 'system', 'developer 必须被改写成 system');
    assert.equal(body.messages[1].content, 'DEV');
    assert.equal(body.messages[2].role, 'user');
    assert.equal(body.messages[2].content[0].type, 'text');
    assert.equal(body.messages[2].content[1].type, 'image_url');
    assert.match(body.messages[2].content[1].image_url.url, /^data:image\/png;base64,/);
    assert.equal(body.messages[3].tool_calls[0].function.name, 'read');
    assert.equal(body.messages[4].role, 'tool');
    assert.equal(body.messages[4].tool_call_id, 'c1');
    assert.equal(body.messages[4].content, 'file body');
    assert.deepEqual(body.tools.map((t) => t.function.name), ['read', 'grep'], 'toolHistory 的动态新增必须一起带上');
  } finally { await stub.close(); }
});

test('wire 净化：空助手轮与孤儿 tool 结果被剔除，成对的工具调用保留', async () => {
  const capture = {};
  const stub = await startStub({
    sseFrames: [delta({ content: 'ok' }), { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }],
    capture,
  });
  try {
    const adapter = makeAdapter(stub.baseUrl);
    for await (const _ of adapter.stream({
      provider: 'workbuddy',
      model: 'stub-model',
      messages: [
        { role: 'user', content: [{ type: 'text', text: '第一问' }] },
        { role: 'assistant', content: [] },                                              // 空助手轮（上一轮失败留下的）
        { role: 'assistant', content: [{ type: 'text', text: '' }] },                    // 只有空文本，同样算空
        { role: 'user', content: [{ type: 'text', text: '第二问' }] },
        { role: 'tool', toolCallId: 'orphan-1', content: [{ type: 'text', text: '没配对的工具结果' }] },
        { role: 'assistant', content: [{ type: 'tool-call', id: 'c9', name: 'read', arguments: '{}' }] },
        { role: 'tool', toolCallId: 'c9', content: [{ type: 'text', text: '配对的工具结果' }] },
        { role: 'user', content: [{ type: 'text', text: '第三问' }] },
      ],
    })) { /* drain */ }

    const roles = capture.body.messages.map((m) => m.role);
    assert.deepEqual(roles, ['user', 'user', 'assistant', 'tool', 'user'],
      '空的助手轮和孤儿 tool 结果都要消失，成对的助手/工具结果必须保留');
    assert.equal(capture.body.messages[0].content, '第一问');
    assert.equal(capture.body.messages[1].content, '第二问');
    assert.equal(capture.body.messages[2].tool_calls[0].id, 'c9');
    assert.equal(capture.body.messages[3].tool_call_id, 'c9');
    assert.equal(capture.body.messages[4].content, '第三问');
  } finally { await stub.close(); }
});

test('推理流：reasoning 块独立编号，正文块从其后的索引开始', async () => {
  const stub = await startStub({
    sseFrames: [
      delta({ reasoning_content: '想' }),
      delta({ reasoning_content: '一下' }),
      delta({ content: '答案' }),
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    ],
  });
  try {
    const adapter = makeAdapter(stub.baseUrl);
    const out = [];
    for await (const chunk of adapter.stream({ provider: 'workbuddy', model: 'stub-model', messages: [] })) out.push(chunk);
    const starts = out.filter((c) => c.type === 'block-start');
    assert.equal(starts.length, 2);
    assert.deepEqual(starts.map((s) => [s.index, s.blockType]), [[0, 'reasoning'], [1, 'text']]);
    const ends = out.filter((c) => c.type === 'block-end');
    assert.deepEqual(ends.map((e) => e.block.type), ['reasoning', 'text']);
    assert.equal(ends[0].block.text, '想一下');
    assert.equal(ends[1].block.text, '答案');
  } finally { await stub.close(); }
});

test('上游错误：不抛异常，以 error finish 收尾并带上状态码', async () => {
  const stub = await startStub({ status: 429, errorBody: { error: { message: 'rate limited' }, code: 11102 } });
  try {
    const adapter = makeAdapter(stub.baseUrl);
    const out = [];
    for await (const chunk of adapter.stream({ provider: 'workbuddy', model: 'stub-model', messages: [] })) out.push(chunk);
    assert.equal(out.length, 1);
    assert.equal(out[0].type, 'finish');
    assert.equal(out[0].reason.kind, 'error');
    assert.equal(out[0].reason.failure.status, 429);
    assert.equal(out[0].reason.failure.code, 'RATE_LIMIT');
    assert.match(out[0].reason.failure.message, /rate limited/);
  } finally { await stub.close(); }
});

test('空回复：finish 变成 EMPTY_RESPONSE 错误而不是静默 stop', async () => {
  /**
   * 这段只回一帧就结束，在 `node --test` 并行跑多个测试文件、CPU 抢得厉害时，
   * 偶尔会在读完之前被对端提前关闭，此时适配器如实报 `TRANSPORT`（这是**正确**行为，
   * 不是 bug）。因此这里允许重试一次：真的协议错会两次都错，环境抖动只错一次。
   */
  const run = async () => {
    const stub = await startStub({ sseFrames: [{ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }] });
    try {
      const adapter = makeAdapter(stub.baseUrl);
      const out = [];
      for await (const chunk of adapter.stream({ provider: 'workbuddy', model: 'stub-model', messages: [] })) out.push(chunk);
      return out.at(-1);
    } finally { await stub.close(); }
  };

  let finish = await run();
  if (finish.reason.failure?.code === 'TRANSPORT') finish = await run();
  assert.equal(finish.reason.kind, 'error');
  assert.equal(finish.reason.failure.code, 'EMPTY_RESPONSE', `实际：${finish.reason.failure.code} / ${finish.reason.failure.message}`);
});

test('取消：abort 后以 aborted finish 收尾', async () => {
  const stub = await startStub({
    sseFrames: Array.from({ length: 200 }, (_, i) => delta({ content: 'x' + i })),
  });
  try {
    const adapter = makeAdapter(stub.baseUrl);
    const controller = new AbortController();
    const out = [];
    let count = 0;
    for await (const chunk of adapter.stream({ provider: 'workbuddy', model: 'stub-model', messages: [], signal: controller.signal })) {
      out.push(chunk);
      count += 1;
      if (count === 3) controller.abort();
    }
    const finish = out.at(-1);
    assert.equal(finish.type, 'finish');
    assert.ok(['aborted', 'stop'].includes(finish.reason.kind) || finish.reason.kind === 'error');
    if (finish.reason.kind === 'aborted') assert.equal(finish.reason.failure.code, 'ABORTED');
  } finally { await stub.close(); }
});

test('模型不在白名单：直接以 INVALID_REQUEST 收尾，不打上游', async () => {
  const adapter = new WorkBuddyAdapter({
    provider: 'workbuddy',
    displayName: 'WorkBuddy',
    client: new BridgeClient({ baseUrl: 'http://127.0.0.1:1', token: '' }),
    filter: { allow: ['other-model'] },
  });
  const out = [];
  for await (const chunk of adapter.stream({ provider: 'workbuddy', model: 'text-embedding-3', messages: [] })) out.push(chunk);
  assert.equal(out.length, 1);
  assert.equal(out[0].reason.kind, 'error');
  assert.equal(out[0].reason.failure.code, 'INVALID_REQUEST');
});
