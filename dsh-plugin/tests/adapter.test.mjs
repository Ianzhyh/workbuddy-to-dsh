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

import { WorkBuddyAdapter, mapUsage, errorHint, CODE } from '../lib/adapter.mjs';
import { BridgeClient } from '../lib/bridge.mjs';

/** 起一个假桥：/health、/v1/models、/v1/chat/completions（SSE 回放）。 */
async function startStub({ sseFrames = [], status = 200, errorBody = null, capture = null, catalog = null, hang = false } = {}) {
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
      // `catalog` 可覆盖（默认给两个固定桩）：用例要按形状区分"带推理标记"的模型
      return res.end(JSON.stringify({ object: 'list', data: catalog || [
          { id: 'stub-model', name: 'Stub Model', context_window: 128000, max_output_tokens: 8192, credits: 0.11, supports_images: true },
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
      if (hang) {
        // 「卡住」：连接不断、也不再有数据。1 秒后自己收掉，避免 stub.close 挂住。
        setTimeout(() => { try { res.destroy(); } catch { /* 忽略 */ } }, 1000);
        return;
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
    // description 是选择器里唯一能看出的容量/价格/能力信息（dsh 只展示 name 与 description）
    assert.deepEqual(models[0], {
      provider: 'workbuddy',
      id: 'stub-model',
      name: 'Stub Model · ×0.11',
      description: '上下文 128k · 输出 8192 · 图片',
      inputModalities: ['text', 'image'],
    });
    assert.equal(models[1].name, 'Stub Free · 免费');
    assert.equal(models[1].description, '上下文 32k · 输出 4096');
    const resolved = await adapter.resolveModel('workbuddy', 'stub-model');
    assert.equal(resolved.context.contextWindow, 128000);
    assert.equal(resolved.name, 'Stub Model · ×0.11');
    assert.equal(resolved.description, '上下文 128k · 输出 8192 · 图片');
    assert.equal(resolved.defaultMaxTokens, 8192);
    assert.equal(adapter.providerInfo('workbuddy').id, 'workbuddy');
    assert.equal(adapter.providerRetryPolicy().mode, 'normal');
  } finally { await stub.close(); }
});

test('resolveModel：目录失败时退回最小元数据，不阻断已选模型调用', async () => {
  // 端口 1 必然连接失败：模拟桥刚重启 / 目录接口短暂 401。
  const adapter = makeAdapter('http://127.0.0.1:1');
  const resolved = await adapter.resolveModel('workbuddy', 'stub-model');
  assert.deepEqual(resolved, { provider: 'workbuddy', id: 'stub-model', name: 'stub-model' });
});

test('resolveModel：按桥给的 reasoning_efforts 逐模型声明档位（用户"每个模型只有三档"的那条链）', async () => {
  /*
   * 2026-10-12：档位原先在 adapter 里**写死**成低/中/高三档。上游对支持推理的
   * 模型其实收 minimal/low/medium/high（多数还收 xhigh，实测见 bridge 的
   * REASONING_EFFORTS_BY_MODEL），于是 dsh 里"每个模型都只有三档"。
   * 现在档位由桥按模型给出，本用例钉住三种来源与 dsh 的校验约束。
   */
  const stub = await startStub({
    catalog: [
      // 桥给了实测档位表 → 照单全给
      { id: 'r6', name: 'R6', context_window: 1000000, max_output_tokens: 128000, supports_images: true, supports_reasoning: true, reasoning_efforts: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] },
      // 老桥：没有 reasoning_efforts 字段，但目录说支持推理 → 兜底三档
      { id: 'r3', name: 'R3', context_window: 32000, max_output_tokens: 4096, supports_reasoning: true },
      // 目录没说支持推理 → 一个档位都不给
      { id: 'plain', name: 'Plain', context_window: 32000, max_output_tokens: 4096, supports_images: false },
      // 档位里没有 medium → defaultEffort 必须落到列表内的值（dsh 会校验）
      { id: 'odd', name: 'Odd', context_window: 32000, max_output_tokens: 4096, supports_reasoning: true, reasoning_efforts: ['low', 'high'] },
      // 桥实测"一个档都不收"（显式空数组，如网关暂时不接的 claude-*）→ 不声明推理
      { id: 'dead', name: 'Dead', context_window: 32000, max_output_tokens: 4096, supports_reasoning: true, reasoning_efforts: [] },
    ],
  });
  try {
    const adapter = makeAdapter(stub.baseUrl);

    const r6 = await adapter.resolveModel('workbuddy', 'r6');
    assert.deepEqual(r6.reasoning.efforts.map((e) => e.id), ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'], '照单全给');
    assert.equal(r6.reasoning.defaultEffort, 'medium');
    assert.ok(r6.reasoning.efforts.some((e) => e.id === 'xhigh' && e.name === 'Extra High'), '扩展档要有可读的名字');

    const r3 = await adapter.resolveModel('workbuddy', 'r3');
    assert.deepEqual(r3.reasoning.efforts.map((e) => e.id), ['low', 'medium', 'high'], '老桥没有档位表 → 兜底三档');
    assert.equal(r3.reasoning.defaultEffort, 'medium');

    const plain = await adapter.resolveModel('workbuddy', 'plain');
    assert.equal(plain.reasoning, undefined, '没标推理的模型不给 reasoning 字段');

    const odd = await adapter.resolveModel('workbuddy', 'odd');
    assert.deepEqual(odd.reasoning.efforts.map((e) => e.id), ['low', 'high']);
    assert.equal(odd.reasoning.defaultEffort, 'high', 'defaultEffort 必须在 efforts 里（dsh 会校验）');

    const dead = await adapter.resolveModel('workbuddy', 'dead');
    assert.equal(dead.reasoning, undefined, '显式空数组 = 桥实测无档可用 → 不声明推理');
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

test('文本流：命中缓存的 usage 如实映射进 dsh 用量桶（端到端）', async () => {
  const stub = await startStub({
    sseFrames: [
      delta({ role: 'assistant', content: '' }),
      delta({ content: 'OK' }),
      {
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 1456,
          completion_tokens: 1,
          total_tokens: 1457,
          prompt_tokens_details: { cached_tokens: 1280 },
          prompt_cache_hit_tokens: 1280,
          prompt_cache_miss_tokens: 176,
          cached_tokens: 0,
        },
      },
    ],
  });
  try {
    const adapter = makeAdapter(stub.baseUrl);
    const out = [];
    for await (const chunk of adapter.stream({ provider: 'workbuddy', model: 'stub-model', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })) out.push(chunk);
    const usage = out.find((c) => c.type === 'usage')?.usage;
    assert.deepEqual(usage, { inputTokens: 176, outputTokens: 1, totalTokens: 1457, cacheReadTokens: 1280 });
  } finally { await stub.close(); }
});

test('usage 映射：inputTokens 是「未命中缓存」的输入（回归：命中率上限被压到 50%）', () => {
  // 本机上游**实测**的真实 payload：prompt_tokens 含缓存，命中 + 未命中 = prompt_tokens
  const warm = mapUsage({
    prompt_tokens: 1456,
    completion_tokens: 1,
    total_tokens: 1457,
    prompt_tokens_details: { cached_tokens: 1280 },
    prompt_cache_hit_tokens: 1280,
    prompt_cache_miss_tokens: 176,
    cached_tokens: 0, // 上游同时下发的恒 0 占位，不许挡住真实值
    cache_read_input_tokens: 0,
    prompt_cache_write_tokens: 0,
  });
  assert.equal(warm.inputTokens, 176, '未命中缓存的那部分才是 inputTokens');
  assert.equal(warm.cacheReadTokens, 1280);
  assert.equal(warm.outputTokens, 1);
  assert.equal(warm.totalTokens, 1457);
  // dsh 的会话命中率 = cacheRead / (uncachedInput + cacheRead + cacheWrite)
  const hitRate = warm.cacheReadTokens / (warm.inputTokens + warm.cacheReadTokens);
  assert.ok(Math.abs(hitRate - 0.879) < 0.001, `真实命中率应约 87.9%，实际 ${(hitRate * 100).toFixed(1)}%`);

  // 冷启动：全未命中
  const cold = mapUsage({ prompt_tokens: 1456, completion_tokens: 1, total_tokens: 1457, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 1456 });
  assert.equal(cold.inputTokens, 1456);
  assert.equal(cold.cacheReadTokens, undefined, '零缓存字段必须省略，不编造 0');

  // 全命中：命中率上限必须能到 100%（旧实现这里恰好只有 50%）
  const full = mapUsage({ prompt_tokens: 1000, completion_tokens: 5, total_tokens: 1005, prompt_cache_hit_tokens: 1000, prompt_cache_miss_tokens: 0 });
  assert.equal(full.inputTokens, 0);
  assert.equal(full.cacheReadTokens / (full.inputTokens + full.cacheReadTokens), 1);
});

test('usage 映射：字段别名、缓存写、脏数据防御', () => {
  // 只有 Anthropic 风格别名时也要认
  assert.equal(mapUsage({ prompt_tokens: 100, completion_tokens: 1, cache_read_input_tokens: 60 }).inputTokens, 40);
  // 缓存写单列：三个桶互斥，input 要把写的那部分一并减掉
  assert.equal(mapUsage({ prompt_tokens: 100, completion_tokens: 1, prompt_cache_write_tokens: 30 }).inputTokens, 70);
  // miss 与另外两个桶不自洽（上游漏报 hit）→ 不信 miss，按减法倒推
  assert.equal(mapUsage({ prompt_tokens: 100, completion_tokens: 1, prompt_cache_hit_tokens: 50, prompt_cache_miss_tokens: 10 }).inputTokens, 50);
  // 脏数据：负数忽略、超量兜底到 0（input 永不为负）
  assert.equal(mapUsage({ prompt_tokens: 10, completion_tokens: 1, prompt_cache_hit_tokens: -5 }).inputTokens, 10);
  assert.equal(mapUsage({ prompt_tokens: 10, completion_tokens: 1, prompt_cache_hit_tokens: 999 }).inputTokens, 0);
  assert.equal(mapUsage(null), null);
});

/*
 * 桶之和必须等于 `totalTokens`（契约 §6 的硬要求）。
 *
 * 契约写明：数字不可信 / 总数冲突时，`dsh-token-meter` 会把**整次测量丢掉**
 * （"returns no result when … counts are unsafe, or exact totals conflict"），
 * 并且特别点名「零点声明比不给更糟 —— 那是一个声称本次请求没花钱的 provider 锚点」。
 *
 * 原实现在上游**只给 `total_tokens`、不给 `prompt_tokens`** 时把 prompt 当 0，
 * 产出自相矛盾的 `{inputTokens:0, outputTokens:0, totalTokens:1050}`
 * （桶和 0 ≠ 1050）—— 同时踩中"冲突"与"零点声明"两条。
 * 触发场景真实存在：网关精简 usage、或中间层剥掉 prompt 字段。
 */
test('usage 映射：缺 prompt_tokens 时桶之和必须仍等于 totalTokens（否则 dsh 丢弃整次测量）', () => {
  const cases = [
    ['只有 total_tokens', { total_tokens: 1050 }],
    ['缺 prompt、有 completion', { completion_tokens: 50, total_tokens: 1050 }],
    ['缺 prompt、有缓存', { completion_tokens: 50, total_tokens: 1050, prompt_cache_hit_tokens: 400 }],
  ];
  for (const [label, raw] of cases) {
    const u = mapUsage(raw);
    const sum = (u.inputTokens || 0) + (u.outputTokens || 0) + (u.cacheReadTokens || 0) + (u.cacheWriteTokens || 0);
    assert.equal(u.totalTokens, sum,
      `${label}：桶和必须等于 totalTokens（input ${u.inputTokens} + output ${u.outputTokens}`
      + ` + cacheRead ${u.cacheReadTokens || 0} + cacheWrite ${u.cacheWriteTokens || 0} = ${sum}，totalTokens ${u.totalTokens}）`);
    assert.ok(u.inputTokens >= 0, `${label}：inputTokens 不得为负`);
  }

  // 反证：不能因此把"真·零用量"编造成正数
  const realZero = mapUsage({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
  assert.equal(realZero.inputTokens, 0, '上游明确说 prompt_tokens=0 时不许倒推');
  assert.equal(realZero.totalTokens, 0);

  // 有 prompt 时仍以 prompt 为准（不得被倒推覆盖）
  const withPrompt = mapUsage({ prompt_tokens: 1000, completion_tokens: 50, total_tokens: 1050 });
  assert.equal(withPrompt.inputTokens, 1000, '有 prompt_tokens 时必须照原样用');
  assert.equal(withPrompt.totalTokens, 1050);
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

/**
 * 助手历史里的图片必须保住，而且**整条助手消息**不能被当成"空轮"丢掉。
 *
 * ## 为什么钉这条（2026-10-13 用户报「读不了图」，这是同一族的第二个洞）
 *
 * 第一版只修了 user 侧。但助手消息也可能带 image 块（模型自己截图/产图后，
 * 用户下一轮追问 —— 历史要重发）。当时有两处会把它弄丢：
 *
 *   1. `toWireMessage` 的 assistant 分支只处理 `text` 与 `tool-call`，
 *      `image` 块被**静默丢掉**；
 *   2. 更隐蔽：`sanitizeWire` 判"这条助手轮有没有内容"时只认
 *      `typeof content === 'string'`。而带图的助手消息 content 是**数组**，
 *      于是被判成"空助手轮"→ **整条消息（连文字一起）被删掉**。
 *      实测表现：助手轮从历史里直接消失，模型"忘了自己刚说过什么"。
 *
 * 判据放在这里而不是 plugin.test：这两处都在 adapter 层，桩上游能直接看到
 * 最终 wire 形态，是这条链路上最贴近事实的观测点。
 */
test('wire 请求：助手消息里的图片必须保留，且不得被当成空轮丢弃', async () => {
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
        { role: 'user', content: [{ type: 'text', text: '看看这张图' }, { type: 'image', attachment: { attachmentId: 'a1', mediaType: 'image/png' } }] },
        // 助手轮：文字 + 图（截图场景）。文字非空，所以最坏情况下也该留下文字
        { role: 'assistant', content: [{ type: 'text', text: '这是截图：' }, { type: 'image', attachment: { attachmentId: 'a2', mediaType: 'image/png' } }] },
        { role: 'user', content: [{ type: 'text', text: '刚才截图里有什么？' }] },
      ],
    })) { /* drain */ }

    const body = capture.body;
    // 三条消息一条都不能少（曾经助手轮会被整条丢掉 → 这里会变成 2 条）
    assert.equal(body.messages.length, 3, '带图的助手轮不得被 sanitizeWire 当成空轮丢掉');

    const asst = body.messages[1];
    assert.equal(asst.role, 'assistant');
    assert.ok(Array.isArray(asst.content), '带图的助手消息 content 应为多段数组');

    const textPart = asst.content.find((p) => p.type === 'text');
    const imgPart = asst.content.find((p) => p.type === 'image_url');
    assert.ok(textPart, '助手轮的文字必须保留');
    assert.equal(textPart.text, '这是截图：');
    assert.ok(imgPart, '助手轮里的图片必须保留（丢图会让模型"忘了看过什么"）');
    assert.match(imgPart.image_url.url, /^data:image\/png;base64,/, '图必须是 data URL');
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

test('流内 error 帧：断流不能被伪装成正常结束（桥补发的 upstream_error）', async () => {
  /*
   * 桥在「上游流中途断了」时会补一帧 `data: {"error":{…}}` 再 `[DONE]`
   * （bridge 的 chat 流式路径，注释里明确写着"客户端（含本项目自己的适配器）认它"）。
   * 适配器原先只认 `choices`，这一帧被静默忽略：既然已经吐过内容，
   * `mapFinishReason(undefined, …)` 就返回 `stop` ——
   * 用户看到半截回答、dsh 认为这一轮成功、不会重试，账本也只有桥那边记了失败。
   */
  const stub = await startStub({
    sseFrames: [
      delta({ role: 'assistant', content: '' }),
      delta({ content: '半截' }),
      { error: { message: 'workbuddy-bridge: upstream stream interrupted before completion: boom', type: 'upstream_error' } },
    ],
  });
  try {
    const adapter = makeAdapter(stub.baseUrl);
    const out = [];
    for await (const chunk of adapter.stream({ provider: 'workbuddy', model: 'stub-model', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })) out.push(chunk);
    const finish = out.at(-1);
    assert.equal(finish.type, 'finish');
    assert.equal(finish.reason.kind, 'error');
    assert.match(finish.reason.failure.message, /boom/);
    // 已吐出的内容仍要收尾（block-end），不能因为报错把半截内容丢掉
    assert.ok(out.some((c) => c.type === 'block-end' && c.block.text === '半截'));
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
    /*
     * ⚠️ 这条断言原先写成 `['aborted','stop'].includes(kind) || kind === 'error'` ——
     * 等于**什么都能通过**，所以「abort 根本没传下去」这个真 bug 一直躲在这里：
     * 取消之后桥仍把上游整段流读完（实测又跑了 9.5 秒、多收 4447 字），
     * 而 finish 落在 `max-tokens`/`stop` 上被这条宽松断言放行。
     * 现在收紧：**取消就必须报 aborted**。
     */
    assert.equal(finish.reason.kind, 'aborted',
      `取消后必须以 aborted 收尾，实际是 ${finish.reason.kind}`
      + `（落在 stop/max-tokens 上说明取消被当成了正常结束）`);
    assert.equal(finish.reason.failure.code, 'ABORTED');
  } finally { await stub.close(); }
});

/**
 * 取消必须**真的**中断上游，而不只是「不再产出块」。
 *
 * 这是上一条的加强版：上面只看 finish 的类型，而一个"读完全部再报 aborted"
 * 的实现同样能通过它。这里直接量**服务器侧**的行为 ——
 * abort 之后上游还被写出去多少帧、连接是否被关。
 *
 * 背景（实测）：`BridgeClient` 原先在 `fetch()` 一 resolve 就
 * `removeEventListener('abort', …)`，而 fetch 拿到响应头**不等于**流读完了 ——
 * 调用方的取消从此再也传不进那个响应体。对真实桥实测：abort 后生成器又跑了
 * 9477ms、期间仍收到 4447 字，最后以 `max-tokens` 收尾。
 *
 * 现在 `BridgeClient` 把清理挂到「响应体结束」上，适配器也在 finally 里
 * `reader.cancel()`，两条路径都堵住。
 */
test('取消必须真的切断上游：abort 后服务器不再写帧、连接被关闭', async () => {
  const FRAME_MS = 40;
  const TOTAL = 100;
  let framesWritten = 0;
  let finished = false;
  let closedAt = null;

  const server = createServer((req, res) => {
    if (req.url.startsWith('/v1/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ object: 'list', data: [{ id: 'stub-model', name: 'Stub' }] }));
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    let i = 0;
    const timer = setInterval(() => {
      if (i >= TOTAL) {
        clearInterval(timer);
        res.write('data: [DONE]\n\n');
        res.end();
        finished = true;
        return;
      }
      i += 1;
      framesWritten = i;
      res.write(`data: ${JSON.stringify(delta({ content: 'x' }))}\n\n`);
    }, FRAME_MS);
    res.on('close', () => { if (closedAt === null) closedAt = Date.now(); clearInterval(timer); });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const adapter = makeAdapter(baseUrl);
    const controller = new AbortController();
    const started = Date.now();
    let abortedAtMs = null;
    let framesAtAbort = 0;
    let aborted = false;
    let finish = null;

    const pump = (async () => {
      for await (const chunk of adapter.stream({ provider: 'workbuddy', model: 'stub-model', messages: [], signal: controller.signal })) {
        if (chunk.type === 'finish') finish = chunk.reason;
        if (!aborted && Date.now() - started > 300) {
          aborted = true;
          abortedAtMs = Date.now() - started;
          // 记下"取消那一刻上游已经写出多少帧"——之后不能再有增长
          framesAtAbort = framesWritten;
          controller.abort();
        }
      }
    })();

    const outcome = await Promise.race([
      pump.then(() => 'ended'),
      new Promise((r) => setTimeout(() => r('__PENDING__'), 5000)),
    ]);
    const endMs = Date.now() - started;
    await new Promise((r) => setTimeout(r, 400)); // 留出传播时间

    assert.equal(outcome, 'ended',
      `abort 之后生成器 5 秒仍未结束 —— 取消没有传进响应体`);
    assert.equal(finish?.kind, 'aborted', `finish 应为 aborted，实际 ${finish?.kind}`);
    assert.ok(endMs - abortedAtMs < 1500,
      `abort 后又跑了 ${endMs - abortedAtMs}ms —— 取消应当立刻生效，不该读完剩余的上游数据`);
    /*
     * 关键断言：上游侧必须**停止被消费**。
     *
     * 允许 1–2 帧的余量 —— 取消那一刻可能已有一帧在网络上（已写出但还没被读到），
     * 那不属于"取消没生效"。真正要钉死的是**不再持续增长**（旧实现在这之后
     * 又写了 93 帧、并把整条 100 帧的流跑完）。
     */
    assert.ok(framesWritten - framesAtAbort <= 2,
      `abort 之后上游又被写了 ${framesWritten - framesAtAbort} 帧 —— 上游连接没被真正切断（白烧额度）`);
    assert.equal(finished, false, '上游把整条流跑完了 —— 取消没有生效');
    assert.ok(closedAt !== null, 'abort 之后上游连接始终没被关闭');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

/**
 * 消费方**提前退出**（对生成器 break → dsh 调 `return()`）时，
 * 上游连接必须被立刻收掉 —— 契约 §4.6 明确要求适配器在自己的 finally 里
 * "abort the underlying fetch so the socket does not leak"。
 *
 * 这条路径与"调用方 signal 取消"是两件不同的事：signal 管「上层要取消」，
 * 这里管「消费者不要了」。两条都堵住才算不泄漏。
 */
test('消费方提前 break：上游连接必须被立刻收掉（不留幽灵连接）', async () => {
  const TOTAL = 100;
  let framesWritten = 0;
  let finished = false;
  let closedAt = null;

  const server = createServer((req, res) => {
    if (req.url.startsWith('/v1/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ object: 'list', data: [{ id: 'stub-model', name: 'Stub' }] }));
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    let i = 0;
    const timer = setInterval(() => {
      if (i >= TOTAL) {
        clearInterval(timer);
        res.write('data: [DONE]\n\n');
        res.end();
        finished = true;
        return;
      }
      i += 1;
      framesWritten = i;
      res.write(`data: ${JSON.stringify(delta({ content: 'x' }))}\n\n`);
    }, 30);
    res.on('close', () => { if (closedAt === null) closedAt = Date.now(); clearInterval(timer); });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const adapter = makeAdapter(baseUrl);
    let got = 0;
    for await (const chunk of adapter.stream({ provider: 'workbuddy', model: 'stub-model', messages: [] })) {
      if (chunk.type === 'text-delta') got += 1;
      if (got >= 2) break; // 消费者不想要了
    }
    const framesAtBreak = framesWritten;
    /*
     * 给取消传播留时间，但不要用固定的 600ms —— 门禁并行跑桥测试时机器负载高，
     * 600ms 偶尔不够，会把“取消其实生效了”误判成连接泄漏。最多等 3s，期间
     * 一旦 close 就继续断言；帧数在这段时间若继续增长仍会失败。
     */
    for (let i = 0; i < 60 && closedAt === null; i += 1) {
      await new Promise((r) => setTimeout(r, 50));
    }

    assert.equal(finished, false,
      '消费方 break 之后上游仍把整条流跑完了 —— 连接泄漏，白烧额度与并发');
    assert.equal(framesWritten, framesAtBreak,
      `break 之后上游又被写了 ${framesWritten - framesAtBreak} 帧 —— 没被切断`);
    assert.ok(closedAt !== null, 'break 之后上游连接始终没被关闭');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('空闲看门狗：上游卡住不吐字时按 TIMEOUT 收尾（默认关闭，显式开）', async () => {
  /*
   * 上游"连接还在、就是不吐字"时旧实现会永远等下去：dsh 一直转圈、
   * 用户只能手动取消，桥那边的并发槽位也被占着。
   * 看门狗只看「距上一块数据多久」，不看总时长 —— 长回答不会被误杀。
   * 默认 0（关），与「不加默认上游超时」的红线一致。
   */
  const stub = await startStub({ sseFrames: [delta({ content: '半' })], hang: true });
  try {
    const adapter = makeAdapter(stub.baseUrl);
    adapter.streamIdleTimeoutMs = 120;
    const started = Date.now();
    const out = [];
    for await (const chunk of adapter.stream({ provider: 'workbuddy', model: 'stub-model', messages: [] })) out.push(chunk);
    const finish = out.at(-1);
    assert.equal(finish.type, 'finish');
    assert.equal(finish.reason.kind, 'error');
    assert.equal(finish.reason.failure.code, 'TIMEOUT', '卡住必须归为 TIMEOUT（可重试），不能挂死');
    assert.ok(Date.now() - started < 2000, '配置 120ms 后应当立刻收尾');
    // 不配置 = 关闭（默认行为不变）
    assert.equal(makeAdapter(stub.baseUrl).streamIdleTimeoutMs, 0);
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

/*
 * 响应体不合形状时也必须走 finish 块，**不能向外抛**。
 *
 * 适配器的硬契约是「任何失败都以 finish 块收尾」（见文件头与
 * `docs/dsh-llm-adapter-contract.md` §5.3）。取消/清理那轮改动里，
 * 取 reader 的语句被放到了 try **外面** —— 于是一个没有 `getReader()` 的
 * 响应体会让 `TypeError: res.body.getReader is not a function` 直接冒泡，
 * 契约当场破裂（由 `model-prefs.test.mjs` 的 payload 打桩抓到）。
 * 这条用例把「取 reader 必须在 try 内」钉死。
 */
test('响应体没有 getReader()：也必须以 error finish 收尾，不得向外抛', async () => {
  const adapter = new WorkBuddyAdapter({
    provider: 'workbuddy',
    displayName: 'WorkBuddy',
    client: { chat: async () => ({ ok: true, status: 200, body: null }) },
    ensureReady: async () => adapter.client,
    log: () => {},
  });
  const out = [];
  await assert.doesNotReject(async () => {
    for await (const chunk of adapter.stream({ provider: 'workbuddy', model: 'model-a', messages: [] })) out.push(chunk);
  }, '响应体不合形状时向外抛异常 —— 契约要求失败也走 finish 块');
  assert.equal(out.length, 1, `应当只有一个终止块，实际 ${out.length} 个：${JSON.stringify(out.map((c) => c.type))}`);
  assert.equal(out[0].type, 'finish');
  assert.equal(out[0].reason.kind, 'error');
});

/**
 * 回归：适配器必须实现 `imageRequestPricing` / `imageRequestTarget`。
 *
 * 用户侧症状（2026-10-17 实测，dsh Desktop 0.2.1-rc.2）：
 *
 *   command.execute failed: gateway/internal:
 *   this.adapters.get(...)?.adapter.imageRequestPricing is not a function
 *
 * 触发点是**压缩上下文（compact）**：它要重建历史并给历史里的图片计价。
 * 平时的纯文本对话不走这条路径，所以只有 compact 才炸。
 *
 * 根因不是 dsh 的 bug，而是"普通对象适配器"不继承 `LlmAdapter` 基础类：
 * 基础类里这两个方法都有默认实现（`imageRequestPricing` 返回 undefined、
 * `imageRequestTarget` 原样透传），而 dsh 的注册表只对**适配器**判空：
 *
 *   return this.adapters.get(provider)?.adapter.imageRequestPricing(provider, model);
 *   //                                  ^ 到此为止，对"方法"没有可选链
 *
 * 所以适配器注册上了、方法却没有 → TypeError。0.2.1-rc.2 的三处调用点都还没加判空。
 *
 * 注意：`docs/dsh-llm-adapter-contract.md` §6 说"纯文本端点省略它即可"，与运行时不符。
 * 这条用例按**运行时的实际要求**钉死方法必须存在。
 */
test('compact 回归：imageRequestPricing / imageRequestTarget 必须存在且可被 dsh 的调用式调用', () => {
  const adapter = new WorkBuddyAdapter({
    provider: 'workbuddy',
    displayName: 'WorkBuddy',
    client: { models: async () => ({ data: [] }) },
  });

  // 完全照 dsh 注册表的调用式调用：只对 adapter 判空，对方法不判。
  const registry = new Map([['workbuddy', { adapter }]]);
  const callLikeDsh = (name, ...args) => {
    const entry = registry.get('workbuddy');
    assert.ok(entry, '适配器必须已注册');
    // 这里刻意不写 ?.[] —— 复刻 dsh 的写法，缺方法就让它抛
    return entry.adapter[name](...args);
  };

  assert.equal(
    typeof adapter.imageRequestPricing,
    'function',
    'imageRequestPricing 缺失 → compact 时报 "... is not a function"',
  );
  assert.equal(
    callLikeDsh('imageRequestPricing', 'workbuddy', 'deepseek-v4.1-flash'),
    undefined,
    '不声明图片计价时应当返回 undefined（token meter 退回中性估算）',
  );

  assert.equal(
    typeof adapter.imageRequestTarget,
    'function',
    'imageRequestTarget 缺失 → 带图请求同样会 "... is not a function"',
  );
  const target = callLikeDsh('imageRequestTarget', 'workbuddy', 'glm-5.3', { width: 640, height: 480, bytes: 1234 });
  assert.deepEqual(
    target,
    { width: 640, height: 480, maxBytes: 1234 },
    '应当原样透传图片尺寸（不预缩放），与 LlmAdapter 基础类的默认实现一致',
  );

  // 契约要求这两个方法同步、无 I/O
  assert.ok(!(adapter.imageRequestPricing('workbuddy', 'x') instanceof Promise), 'imageRequestPricing 必须同步');
  assert.ok(!(adapter.imageRequestTarget('workbuddy', 'x', {}) instanceof Promise), 'imageRequestTarget 必须同步');
});


/* ───────────────────────── 目录缓存与图片热路径 ───────────────────────── */

function makeClientAdapter(models) {
  const client = { models };
  return new WorkBuddyAdapter({
    provider: 'workbuddy',
    displayName: 'WorkBuddy',
    client,
    ensureReady: async () => client,
    resolveImage: async () => null,
    log: () => {},
    filter: { allow: [], deny: [] },
    catalogTtlMs: 60_000,
  });
}

test('目录过期：先返回旧目录，后台刷新，不让模型调用等目录', async () => {
  let calls = 0;
  let releaseRefresh;
  const refreshHeld = new Promise((resolve) => { releaseRefresh = resolve; });
  const adapter = makeClientAdapter(async () => {
    calls += 1;
    if (calls === 1) return { data: [{ id: 'old', name: 'Old' }] };
    await refreshHeld;
    return { data: [{ id: 'new', name: 'New' }] };
  });

  const first = await adapter.listModels();
  assert.deepEqual(first.map((m) => m.id), ['old']);

  // 模拟 TTL 过期（比 sleep 更稳定）
  adapter.catalogCache.at = Date.now() - adapter.catalogTtlMs - 1;
  const startedAt = Date.now();
  const second = await adapter.listModels();
  assert.deepEqual(second.map((m) => m.id), ['old'], '过期时必须先给旧目录');
  assert.ok(Date.now() - startedAt < 100, `旧目录必须立即返回（实际 ${Date.now() - startedAt}ms）`);
  assert.equal(calls, 2, '后台刷新应当已经发起');

  const inflight = adapter.catalogInflight?.promise;
  releaseRefresh();
  if (inflight) await inflight;
  assert.deepEqual(adapter.catalogCache.models.map((m) => m.id), ['new'], '后台刷新完成后缓存换新');
});

test('warmup：启动预热在后台拉目录，不阻塞', async () => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const adapter = makeClientAdapter(async () => {
    await held;
    return { data: [{ id: 'warm', name: 'Warm' }] };
  });

  const task = adapter.warmup();
  assert.equal(adapter.catalogCache.models.length, 0, 'warmup 不能同步阻塞');
  release();
  await task;
  assert.equal(adapter.catalogCache.models[0].id, 'warm');
});

test('图片：同一附件跨轮次只读一次、并发只读一次，多图并行且顺序不变', async () => {
  const capture = {};
  const stub = await startStub({
    sseFrames: [delta({ content: 'ok' }), { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }],
    capture,
  });
  try {
    const client = new BridgeClient({ baseUrl: stub.baseUrl, token: 't', timeoutMs: 5000 });
    const reads = new Map();
    let active = 0;
    let maxActive = 0;
    const adapter = new WorkBuddyAdapter({
      provider: 'workbuddy',
      displayName: 'WorkBuddy',
      client,
      ensureReady: async () => client,
      resolveImage: async (ref) => {
        reads.set(ref.attachmentId, (reads.get(ref.attachmentId) || 0) + 1);
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 20));
        active -= 1;
        return `data:image/png;base64,${ref.attachmentId}`;
      },
      log: () => {},
      catalogTtlMs: 0,
    });
    const messages = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'first' },
          { type: 'image', attachment: { attachmentId: 'a1', mediaType: 'image/png', bytes: 10, width: 1, height: 1 } },
          { type: 'image', attachment: { attachmentId: 'a2', mediaType: 'image/png', bytes: 10, width: 1, height: 1 } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'image', attachment: { attachmentId: 'a3', mediaType: 'image/png', bytes: 10, width: 1, height: 1 } },
          { type: 'image', attachment: { attachmentId: 'a1', mediaType: 'image/png', bytes: 10, width: 1, height: 1 } },
        ],
      },
    ];
    const drain = async () => {
      for await (const _ of adapter.stream({ provider: 'workbuddy', model: 'stub-model', messages })) { /* drain */ }
    };

    await drain();
    assert.deepEqual([...reads.keys()].sort(), ['a1', 'a2', 'a3']);
    assert.deepEqual([...reads.values()], [1, 1, 1], '同一附件（含同一请求内重复）只允许读一次');
    assert.equal(maxActive, 3, '不同图片必须并行解析（串行实现这里会是 1）');

    const urls = capture.body.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .filter((p) => p.type === 'image_url')
      .map((p) => p.image_url.url);
    assert.deepEqual(urls, [
      'data:image/png;base64,a1',
      'data:image/png;base64,a2',
      'data:image/png;base64,a3',
      'data:image/png;base64,a1',
    ], '图片顺序必须与内容块顺序一致');

    // 第二轮重发同一份历史：全部命中缓存，不再读盘
    await drain();
    assert.deepEqual([...reads.values()], [1, 1, 1], '跨轮次必须命中缓存');
  } finally { await stub.close(); }
});

test('错误提示：11128 是来源/模板拦截，不能暗示用户去换思考档位', () => {
  const hint = errorHint(CODE.INVALID,
    'workbuddy-bridge: upstream 400: Illegal API invocation from an unapproved channel');
  assert.match(hint, /11128/);
  assert.doesNotMatch(hint, /思考强度|输出上限/, '11128 不是参数问题，通用文案会误导');
  // 真正的参数拒绝仍然给参数提示
  assert.match(errorHint(CODE.INVALID, 'model_param_invalid'), /思考强度|输出上限/);
  // 其他分类不受影响
  assert.match(errorHint(CODE.AUTH, ''), /重新登录/);
});
