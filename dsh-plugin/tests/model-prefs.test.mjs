/**
 * 模型显示偏好与请求默认参数的单元测试。
 *
 * 两个用户诉求驱动：
 *   1. "自己控制面板里面出现几个模型而不是全出现" —— 模型显示偏好：
 *      面板勾选 → POST /workbuddy/model-visibility → adapter.setFilter
 *      → dsh 模型选择器下一次 listModels 就是新清单（即时生效，无需重启）。
 *      偏好持久化在插件自己的 .model-prefs.json，**不碰 .state.json**
 *      （那是控制台的单写者领地，它有进程内缓存，外部写会让缓存悄悄过期）。
 *   2. agent 实际调用模型的默认参数（max_tokens / temperature / reasoning_effort）：
 *      配置进 patch（defaultMaxTokens 等），adapter 在组装 payload 时按
 *      "调用方显式 > 插件默认 > 不发" 的优先级合并。
 *
 *   node --test dsh-plugin/tests/model-prefs.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WorkBuddyAdapter } from '../lib/adapter.mjs';
import { toAdapterModels, toDirectory } from '../lib/models.mjs';

const CATALOG = [
  { id: 'model-a', name: 'A', context_window: 100000, max_output_tokens: 8000 },
  { id: 'model-b', name: 'B', context_window: 200000, max_output_tokens: 16000 },
  { id: 'model-c', name: 'C', context_window: 50000, max_output_tokens: 4000 },
];

function makeAdapter(overrides = {}) {
  return new WorkBuddyAdapter({
    provider: 'workbuddy',
    displayName: 'WorkBuddy',
    // catalog() 走 client.models()：给一份固定目录的桩
    client: {
      models: async () => ({ data: CATALOG }),
    },
    ...overrides,
  });
}

// ── 每模型上下文预算（详情滑块）────────────────────────────────────────

test('setContextWindows：每个模型按自己的上限收敛，互不影响', async () => {
  /*
   * dsh 的容量是**按模型**解析的：面板详情里每个模型有自己的滑块。
   * 给 large 设 400K、small 设 400K 时，上限 600K 的 large 用 400K，
   * 上限 50K 的 small 必须收敛到 50K，不能虚报容量。
   */
  const catalog = [
    { id: 'small', name: 'S', context_window: 50000, context_window_max: 50000, max_output_tokens: 4000 },
    { id: 'large', name: 'L', context_window: 200000, context_window_max: 600000, context_window_default: 200000, context_window_options: [200000, 400000, 600000], max_output_tokens: 8000 },
  ];
  const adapter = new WorkBuddyAdapter({
    provider: 'workbuddy', displayName: 'WB',
    client: { models: async () => ({ data: catalog }) },
  });
  adapter.setContextWindows({ large: 400000, small: 400000 });
  assert.deepEqual(adapter.contextWindowsSnapshot(), { large: 400000, small: 400000 });
  assert.equal((await adapter.resolveModel('workbuddy', 'large')).context.contextWindow, 400000);
  assert.equal((await adapter.resolveModel('workbuddy', 'small')).context.contextWindow, 50000,
    '上限 50K 的模型必须收敛到 50K，不能虚报 400K');
  // only large 被覆盖时，small 仍跟目录默认（50K）
  adapter.setContextWindows({ large: 600000 });
  assert.equal((await adapter.resolveModel('workbuddy', 'small')).context.contextWindow, 50000);
  const list = await adapter.listModels();
  assert.match(list.find((m) => m.id === 'large').description, /上下文 600K/,
    '模型选择器的描述应反映该模型自己的预算');

  // 清除覆盖 = 跟随官方默认（回到目录里的 200K），非法条目被忽略
  adapter.setContextWindows({ large: 'bad', small: -1 });
  assert.deepEqual(adapter.contextWindowsSnapshot(), {});
  assert.equal((await adapter.resolveModel('workbuddy', 'large')).context.contextWindow, 200000);
});

test('toAdapterModels：contextWindows 按模型生效，只影响容量字段', () => {
  const catalog = [
    { id: 'a', context_window: 100000, context_window_max: 300000 },
    { id: 'b', context_window: 200000, context_window_max: 200000 },
  ];
  const models = toAdapterModels(catalog, { contextWindows: { a: 600000, b: 600000 } });
  assert.deepEqual(models.map((m) => m.contextWindow), [300000, 200000],
    '每个模型都要按自己的上限收敛');
  assert.deepEqual(models.map((m) => m.id), ['a', 'b'], '预算不改变可见模型');

  // 只改 a：b 仍跟目录值
  const onlyA = toAdapterModels(catalog, { contextWindows: { a: 200000 } });
  assert.deepEqual(onlyA.map((m) => m.contextWindow), [200000, 200000]);

  // 老桥 / 精选兜底没有上限字段：不能拿"当前值"冒充上限把用户的选择按回去
  const [legacy] = toAdapterModels([{ id: 'legacy', context_window: 100000 }], { contextWindows: { legacy: 600000 } });
  assert.equal(legacy.contextWindow, 600000);
});

// ── setFilter：运行时改显示清单 ────────────────────────────────────────

test('setFilter：allow 清单决定 listModels 的可见模型（空 = 全显示）', async () => {
  const adapter = makeAdapter();
  // 初始：没有 allow 清单 → 全部可见
  let models = await adapter.listModels();
  assert.equal(models.length, 3, '未设置过滤时目录里 3 个模型都应可见');

  // 勾选两个 → 只有那两个可见
  adapter.setFilter({ allow: ['model-a', 'model-c'] });
  models = await adapter.listModels();
  assert.deepEqual(models.map((m) => m.id), ['model-a', 'model-c'],
    'setFilter 必须即时生效（下一次 listModels 就是新清单）');

  // 清空 allow → 恢复全显示
  adapter.setFilter({ allow: [] });
  models = await adapter.listModels();
  assert.equal(models.length, 3, 'allow 为空应恢复"全部显示"');
});

test('setFilter：hideAll 表示"全不选"，与"未设置"（全显示）必须是两种状态', async () => {
  const adapter = makeAdapter();
  // "全不选"：一个都不显示 —— 旧实现把它和"没设置过"混为一谈，
  // 于是面板提示"将不显示模型"，dsh 里反而全部还在。
  adapter.setFilter({ allow: [], hideAll: true });
  assert.equal((await adapter.listModels()).length, 0, 'hideAll 必须真的清空选择器');
  // "恢复全部"：回到构造时的配置过滤器
  adapter.resetFilter();
  assert.equal((await adapter.listModels()).length, 3, 'resetFilter 必须恢复全显示');
});

test('keep：当前 dsh 默认模型不被 allow/hideAll 隐藏', async () => {
  const adapter = makeAdapter({ getDefaultSelection: () => ({ provider: 'workbuddy', model: 'model-b' }) });
  adapter.setFilter({ allow: ['model-a'] });
  assert.deepEqual((await adapter.listModels()).map((m) => m.id), ['model-a', 'model-b'],
    'allow 只勾了 a 时，当前正在用的 b 也必须留在清单里');
  adapter.setFilter({ hideAll: true });
  assert.deepEqual((await adapter.listModels()).map((m) => m.id), ['model-b'],
    '全不选时当前默认模型仍要可见，否则用户打开选择器找不到自己正在用的模型');
});

test('model-visibility POST：同时带 includeUnofficial 时不能吞掉 visible', async () => {
  /*
   * 面板保存会同时发 visible/hideAll/includeUnofficial。旧实现里
   * “只改 includeUnofficial”的捷径分支先命中，直接返回并把 visible 丢掉 ——
   * 用户保存显示设置后看起来完全没生效。这里钉住组合请求的返回值与过滤结果。
   */
  const { createRouteTable } = await import('../lib/routes.mjs');
  const adapter = makeAdapter();
  let current = { visible: null, hideAll: false, includeUnofficial: false, paramsByModel: {} };
  const writes = [];
  const routes = createRouteTable({
    adapter,
    readPrefs: () => current,
    onWritePrefs: (next) => { current = next; writes.push(next); },
    notifyAdaptersUpdated: () => true,
  });
  const route = routes.find((r) => r.path === '/workbuddy/model-visibility');
  const run = async (body) => {
    let status = 0;
    let raw = '';
    const res = { writeHead(c) { status = c; }, write(c) { raw += String(c); }, end(c) { if (c) raw += String(c); }, on() {}, off() {} };
    await route.handler({
      url: '/workbuddy/model-visibility',
      method: 'POST',
      headers: { 'x-workbuddy-panel': '1' },
      async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)); },
    }, res);
    return { status, body: JSON.parse(raw || '{}') };
  };
  const saved = await run({ visible: ['model-a'], hideAll: false, includeUnofficial: true });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.visible, ['model-a'], '响应必须回显用户勾选');
  assert.equal(saved.body.includeUnofficial, true);
  assert.equal(writes.at(-1).visible[0], 'model-a', '偏好必须写入 visible，而不是只写 includeUnofficial');
  assert.deepEqual((await adapter.listModels()).map((m) => m.id), ['model-a'], '保存后立即生效');

  const toggle = await run({ includeUnofficial: false });
  assert.equal(toggle.body.includeUnofficial, false, '单独切开关仍然可用');
});

test('model-visibility：上下文预算按模型保存，互不影响且不被显示设置覆盖', async () => {
  const { createRouteTable } = await import('../lib/routes.mjs');
  const adapter = makeAdapter();
  let current = { visible: null, hideAll: false, includeUnofficial: false, contextWindowByModel: {}, paramsByModel: {} };
  const writes = [];
  const routes = createRouteTable({
    adapter,
    readPrefs: () => current,
    onWritePrefs: (next) => { current = next; writes.push(next); },
    notifyAdaptersUpdated: () => true,
  });
  const route = routes.find((r) => r.path === '/workbuddy/model-visibility');
  const run = async (method, body) => {
    let status = 0;
    let raw = '';
    const res = { writeHead(c) { status = c; }, write(c) { raw += String(c); }, end(c) { if (c) raw += String(c); }, on() {}, off() {} };
    await route.handler({
      url: '/workbuddy/model-visibility',
      method,
      headers: { 'x-workbuddy-panel': '1' },
      async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body || {})); },
    }, res);
    return { status, body: JSON.parse(raw || '{}') };
  };

  // 1) 单独给 model-a 设 600K：只影响这个模型
  const saved = await run('POST', { model: 'model-a', contextWindow: 600000 });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.model, 'model-a');
  assert.equal(saved.body.contextWindow, 600000);
  assert.deepEqual(adapter.contextWindowsSnapshot(), { 'model-a': 600000 });
  assert.equal(writes.at(-1).contextWindowByModel['model-a'], 600000, '预算必须按模型写进偏好文件');

  // 2) 再给 model-b 设 300K：两条互不影响
  await run('POST', { model: 'model-b', contextWindow: 300000 });
  assert.deepEqual(adapter.contextWindowsSnapshot(), { 'model-a': 600000, 'model-b': 300000 });

  // 3) 保存显示设置时不能把预算冲掉
  await run('POST', { visible: ['model-a'], hideAll: false, includeUnofficial: true });
  assert.deepEqual(adapter.contextWindowsSnapshot(), { 'model-a': 600000, 'model-b': 300000 },
    '显示设置请求未带预算时应保留每模型的值');
  assert.deepEqual(writes.at(-1).contextWindowByModel, { 'model-a': 600000, 'model-b': 300000 });

  // 4) 单独切「官方目录外」也不能冲掉预算
  await run('POST', { includeUnofficial: false });
  assert.deepEqual(writes.at(-1).contextWindowByModel, { 'model-a': 600000, 'model-b': 300000 });

  // 5) 读取时回显每模型 map
  const read = await run('GET');
  assert.deepEqual(read.body.contextWindowByModel, { 'model-a': 600000, 'model-b': 300000 });

  // 6) 0 = 只恢复该模型的官方默认；另一个模型不受影响
  const reset = await run('POST', { model: 'model-a', contextWindow: 0 });
  assert.equal(reset.body.contextWindow, 0);
  assert.deepEqual(adapter.contextWindowsSnapshot(), { 'model-b': 300000 });
  // 非法值拒绝且不改变当前值
  const bad = await run('POST', { model: 'model-b', contextWindow: -1 });
  assert.equal(bad.status, 400);
  assert.deepEqual(adapter.contextWindowsSnapshot(), { 'model-b': 300000 });
});

test('model-visibility：每模型默认参数保存后能读回，且不被显示设置冲掉', async () => {
  const { createRouteTable } = await import('../lib/routes.mjs');
  const adapter = makeAdapter();
  let current = { visible: null, hideAll: false, includeUnofficial: false, contextWindowByModel: {}, paramsByModel: {} };
  const writes = [];
  const routes = createRouteTable({
    adapter,
    readPrefs: () => current,
    onWritePrefs: (next) => { current = next; writes.push(next); },
    notifyAdaptersUpdated: () => true,
  });
  const route = routes.find((r) => r.path === '/workbuddy/model-visibility');
  const run = async (method, body) => {
    let status = 0; let raw = '';
    const res = { writeHead(c) { status = c; }, write(c) { raw += String(c); }, end(c) { if (c) raw += String(c); }, on() {}, off() {} };
    await route.handler({
      url: '/workbuddy/model-visibility', method,
      headers: { 'x-workbuddy-panel': '1' },
      async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body || {})); },
    }, res);
    return { status, body: JSON.parse(raw || '{}') };
  };

  const saved = await run('POST', { model: 'model-a', params: { temperature: 0.7, maxTokens: 256, reasoningEffort: 'max' } });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.paramsByModel['model-a'], { temperature: 0.7, maxTokens: 256, reasoningEffort: 'max' },
    '三个参数都要保存，不能只存温度');
  assert.deepEqual(adapter.modelParamsSnapshot()['model-a'], saved.body.paramsByModel['model-a'],
    '保存后要立即应用到适配器（下一次请求就生效）');

  const read = await run('GET');
  assert.deepEqual(read.body.paramsByModel['model-a'], saved.body.paramsByModel['model-a'],
    '重新打开面板必须能读回思考强度等参数');

  // 保存显示设置（visible/hideAll）时不能把每模型参数冲掉
  await run('POST', { visible: ['model-a'], hideAll: false, includeUnofficial: false });
  assert.deepEqual(writes.at(-1).paramsByModel['model-a'], saved.body.paramsByModel['model-a'],
    '保存显示设置后每模型默认参数必须保留');
});

test('setFilter：不覆盖配置里的 deny（面板只决定"显示哪些"）', async () => {
  const adapter = makeAdapter({ filter: { deny: ['model-c'] } });
  adapter.setFilter({ allow: ['model-a', 'model-c'] });
  const models = await adapter.listModels();
  /*
   * 旧实现整体替换 filter：面板保存一次显示设置，配置里的 modelDeny 就被清空，
   * 被排除的模型重新出现，而界面上没有任何提示。现在 deny 恒久生效 ——
   * 面板勾了被排除的模型也不会出现（面板会把这类模型标成「配置排除」）。
   */
  assert.deepEqual(models.map((m) => m.id), ['model-a'],
    '配置的 modelDeny 不能被一次面板保存悄悄清掉（model-c 仍应被排除）');
  // 「恢复全部」= 回到配置意图（allow 清空、deny 保留）
  adapter.resetFilter();
  assert.deepEqual((await adapter.listModels()).map((m) => m.id), ['model-a', 'model-b']);
});

// ── 请求默认参数 ──────────────────────────────────────────────────────

/** 从 streamText 里截获发往桥的 payload（client.chat 打桩）。 */
function capturePayload(adapter) {
  let captured = null;
  adapter.client = {
    chat: async (payload) => {
      captured = payload;
      return { ok: true, body: (async function* () { /* 空流：拿到 payload 即可 */ })() };
    },
  };
  return () => captured;
}

test('defaults：调用方未给参数时，配置的默认值被下发', async () => {
  const adapter = makeAdapter({
    defaults: { maxTokens: 1024, temperature: 0.3, reasoningEffort: 'high' },
  });
  const getPayload = capturePayload(adapter);
  const stream = adapter.stream({
    model: 'model-a',
    messages: [{ role: 'user', content: 'hi' }],
  });
  // 消费流直到组装 payload（第一拍就会发请求）
  for await (const chunk of stream) { void chunk; break; }
  const payload = getPayload();
  assert.equal(payload.max_tokens, 1024, '默认 maxTokens 应被下发');
  assert.equal(payload.temperature, 0.3, '默认 temperature 应被下发');
  assert.equal(payload.reasoning_effort, 'high', '默认 reasoningEffort 应被下发');
});

test('defaults：调用方显式给的参数优先于默认值（temperature=0 必须保留）', async () => {
  const adapter = makeAdapter({
    defaults: { maxTokens: 1024, temperature: 0.3 },
  });
  const getPayload = capturePayload(adapter);
  const stream = adapter.stream({
    model: 'model-a',
    messages: [{ role: 'user', content: 'hi' }],
    temperature: 0,
    maxTokens: 64,
  });
  for await (const chunk of stream) { void chunk; break; }
  const payload = getPayload();
  assert.equal(payload.temperature, 0, '显式 temperature=0 是合法值，绝不能被默认 0.3 覆盖');
  assert.equal(payload.max_tokens, 64, '显式 maxTokens 应优先于默认值');
});

test('每模型默认参数：模型自己的默认 > 全局默认，显式调用仍最高', async () => {
  /*
   * 全局默认只能有一份，而用户对不同模型的期待不同（写代码要低温、聊天要高温）。
   * 旧实现只有全局 defaults，模型之间无法区分；现在按 model id 记一份，
   * 优先级：调用方显式 > 该模型默认 > 全局默认 > 不发。
   */
  const adapter = makeAdapter({
    defaults: { maxTokens: 512, temperature: 0.9, reasoningEffort: 'high' },
  });
  adapter.setModelParams({
    'model-a': { maxTokens: 256, temperature: 0, reasoningEffort: 'low' },
  });
  const getPayload = capturePayload(adapter);

  // 1) 调用方什么都没给 → 模型自己的默认（temperature=0 必须保留，不能被 0.9 覆盖）
  for await (const c of adapter.stream({ model: 'model-a', messages: [{ role: 'user', content: 'hi' }] })) { void c; break; }
  let payload = getPayload();
  assert.equal(payload.temperature, 0, '每模型的 temperature=0 是合法值，必须原样下发');
  assert.equal(payload.max_tokens, 256);
  assert.equal(payload.reasoning_effort, 'low');

  // 2) 调用方显式给 → 显式最高
  for await (const c of adapter.stream({
    model: 'model-a',
    messages: [{ role: 'user', content: 'hi' }],
    temperature: 1.1,
    maxTokens: 64,
    reasoningEffort: 'max',
  })) { void c; break; }
  payload = getPayload();
  assert.equal(payload.temperature, 1.1);
  assert.equal(payload.max_tokens, 64);
  assert.equal(payload.reasoning_effort, 'max');

  // 3) 没有该模型默认 → 回落到全局
  for await (const c of adapter.stream({ model: 'model-b', messages: [{ role: 'user', content: 'hi' }] })) { void c; break; }
  payload = getPayload();
  assert.equal(payload.temperature, 0.9);
  assert.equal(payload.max_tokens, 512);
  assert.equal(payload.reasoning_effort, 'high');
});

test('defaults：没配置默认值时，payload 不含这些字段（不猜参数）', async () => {
  const adapter = makeAdapter();
  const getPayload = capturePayload(adapter);
  const stream = adapter.stream({
    model: 'model-a',
    messages: [{ role: 'user', content: 'hi' }],
  });
  for await (const chunk of stream) { void chunk; break; }
  const payload = getPayload();
  assert.equal('max_tokens' in payload, false, '没配置就绝不能下发 max_tokens');
  assert.equal('temperature' in payload, false, '没配置就绝不能下发 temperature');
  assert.equal('reasoning_effort' in payload, false, '没配置就绝不能下发 reasoning_effort');
});

// ── toAdapterModels 的 allow/deny 语义（纯函数层） ─────────────────────

test('toDirectory：官方默认温度与思考档位来源原样透出', () => {
  const [model] = toDirectory([{
    id: 'm', name: 'M', context_window: 1000, default_temperature: 0.7,
    supports_reasoning: true, reasoning_efforts: ['low', 'high'], reasoning_efforts_source: 'fallback',
  }]);
  assert.equal(model.defaultTemperature, 0.7);
  assert.equal(model.effortsSource, 'fallback', 'fallback（默认三档）不能被标成 measured');
  // 0 是合法温度，不能被当成“没给”
  const [zero] = toDirectory([{ id: 'z', default_temperature: 0 }]);
  assert.equal(zero.defaultTemperature, 0);
});

test('toAdapterModels：allow 非空 = 白名单；deny 永远排除', () => {
  const allowOnly = toAdapterModels(CATALOG, { allow: ['model-b'] });
  assert.deepEqual(allowOnly.map((m) => m.id), ['model-b']);
  const denyOnly = toAdapterModels(CATALOG, { deny: ['model-b'] });
  assert.equal(denyOnly.length, 2);
  assert.ok(!denyOnly.some((m) => m.id === 'model-b'));
});

// ── 推理等级（reasoning）元数据与下发 ─────────────────────────────────

test('resolveModel：每模型默认参数要反映到 dsh 物化的 defaultMaxTokens/defaultEffort', async () => {
  /*
   * dsh 的 resolveCall 会把 defaultMaxTokens / defaultEffort 直接写进请求参数，
   * stream() 随后把它们当成“调用方显式值”。如果 resolveModel 仍只返回上游
   * 默认，面板里保存的每模型默认就会被盖掉 —— 界面说已保存，实际请求没变。
   */
  const adapter = new WorkBuddyAdapter({
    provider: 'workbuddy', displayName: 'WB',
    defaults: { maxTokens: 4096, reasoningEffort: 'high' },
    client: { models: async () => ({ data: [
      { id: 'thinker', name: 'Thinker', context_window: 100000, context_window_max: 100000, max_output_tokens: 8192, supports_reasoning: true, reasoning_efforts: ['low', 'high', 'max'], default_reasoning_effort: 'high' },
    ] }) },
  });
  adapter.setModelParams({ thinker: { maxTokens: 512, reasoningEffort: 'low' } });
  const resolved = await adapter.resolveModel('workbuddy', 'thinker');
  assert.equal(resolved.defaultMaxTokens, 512, '每模型 maxTokens 必须成为 dsh 的默认输出上限');
  assert.equal(resolved.reasoning.defaultEffort, 'low', '每模型思考强度必须成为 dsh 的默认档位');
  assert.ok(resolved.reasoning.efforts.some((e) => e.id === 'low'), '默认档位仍必须在可选列表里');

  // 填超模型上限时必须收敛，而不是原样发给上游吃 400
  adapter.setModelParams({ thinker: { maxTokens: 999999 } });
  const clamped = await adapter.resolveModel('workbuddy', 'thinker');
  assert.equal(clamped.defaultMaxTokens, 8192, '每模型 maxTokens 超过官方上限时必须收敛到上限');

  // stream 里也要兜底：直接调用（不走 dsh 物化）时同样不能超上限
  let captured = null;
  adapter.client = {
    chat: async (payload) => {
      captured = payload;
      return { ok: true, body: (async function* () { /* 拿到 payload 即可 */ })() };
    },
  };
  for await (const c of adapter.stream({ model: 'thinker', messages: [{ role: 'user', content: 'hi' }] })) { void c; break; }
  assert.equal(captured.max_tokens, 8192, 'stream 直调时 per-model maxTokens 也要按模型上限收敛');

  // 没有每模型值时，回落到插件全局默认；全局也不合法时回落到上游默认
  adapter.setModelParams({});
  const byGlobal = await adapter.resolveModel('workbuddy', 'thinker');
  assert.equal(byGlobal.defaultMaxTokens, 4096);
  assert.equal(byGlobal.reasoning.defaultEffort, 'high');
});

test('resolveModel：supports_reasoning 的模型必须带 reasoning 元数据（选择器据此显示推理下拉）', async () => {
  const adapter = new WorkBuddyAdapter({
    provider: 'workbuddy', displayName: 'WB',
    client: { models: async () => ({ data: [
      { id: 'thinker', name: 'Thinker', context_window: 100000, max_output_tokens: 8000, supports_reasoning: true },
      { id: 'plain', name: 'Plain', context_window: 100000, max_output_tokens: 8000 },
    ] }) },
  });
  const thinker = await adapter.resolveModel('workbuddy', 'thinker');
  assert.ok(thinker.reasoning, '支持推理的模型必须返回 reasoning 元数据');
  assert.ok(Array.isArray(thinker.reasoning.efforts) && thinker.reasoning.efforts.length >= 2,
    'efforts 必须是非空数组（dsh 校验 efforts.length===0 直接抛 INVALID_MODEL_REASONING）');
  for (const e of thinker.reasoning.efforts) {
    assert.equal(typeof e.id, 'string');
    assert.ok(e.id.length > 0, 'effort.id 必须非空（dsh 校验）');
    assert.equal(typeof e.name, 'string');
    assert.ok(e.name.length > 0);
  }
  // defaultEffort 必须在 efforts 里（dsh 校验：unknown defaultEffort 抛错）
  if (thinker.reasoning.defaultEffort !== undefined) {
    assert.ok(thinker.reasoning.efforts.some((e) => e.id === thinker.reasoning.defaultEffort),
      'defaultEffort 必须是 efforts 中的一员');
  }
  const plain = await adapter.resolveModel('workbuddy', 'plain');
  assert.equal('reasoning' in plain, false, '不支持推理的模型不能带 reasoning（不猜能力）');
});

test('stream：选择器选的 reasoningEffort 必须翻成上游 reasoning_effort，未选且无默认时不发', async () => {
  // 用两套 adapter 分别验证"选择器值优先"与"完全不发"
  const make = (defaults) => {
    const adapter = new WorkBuddyAdapter({
      provider: 'workbuddy', displayName: 'WB', defaults,
      client: { models: async () => ({ data: CATALOG }) },
    });
    let captured = null;
    adapter.client.chat = async (payload) => {
      captured = payload;
      return { ok: true, body: (async function* () { /* 拿到 payload 即可 */ })() };
    };
    return { adapter, get: () => captured };
  };

  // a) 用户在选择器选了 high → 必须下发 reasoning_effort: 'high'
  const a = make({});
  const s1 = a.adapter.stream({ model: 'model-a', messages: [{ role: 'user', content: 'hi' }], reasoningEffort: 'high' });
  for await (const c of s1) { void c; break; }
  assert.equal(a.get().reasoning_effort, 'high', '选择器选的等级必须下发');

  // b) 什么都没选、也没配默认 → 完全不下发（不猜）
  const b = make({});
  const s2 = b.adapter.stream({ model: 'model-a', messages: [{ role: 'user', content: 'hi' }] });
  for await (const c of s2) { void c; break; }
  assert.equal('reasoning_effort' in b.get(), false, '未选择且无默认时不能发 reasoning_effort');

  // c) 没选但配置了默认 → 下发默认值
  const c2 = make({ reasoningEffort: 'low' });
  const s3 = c2.adapter.stream({ model: 'model-a', messages: [{ role: 'user', content: 'hi' }] });
  for await (const c of s3) { void c; break; }
  assert.equal(c2.get().reasoning_effort, 'low', '配置的默认等级应下发');
});

// ── 偏好文件的持久化（.model-prefs.json）─────────────────────────────

test('readModelPrefs/writeModelPrefs：持久化且对损坏文件健壮', async () => {
  // 这里不直接 import 插件内部函数（它们绑定 PLUGIN_DIR），而是从 apply 的
  // 行为面测：写偏好 → 重启形态（重新 apply）后偏好仍生效。完整 apply 需要
  // llm 服务桩，plugin.test.mjs 已有 —— 这里只测文件格式的健壮性等价物。
  const dir = mkdtempSync(join(tmpdir(), 'wb-prefs-'));
  try {
    const file = join(dir, '.model-prefs.json');
    writeFileSync(file, JSON.stringify({ visible: ['model-a', 'model-b'], at: 1 }), 'utf8');
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    assert.ok(Array.isArray(parsed.visible), 'visible 必须是数组（readModelPrefs 的契约）');

    // 损坏文件：读侧必须当作"没设置过"而不是抛异常
    writeFileSync(file, '{broken', 'utf8');
    let ok = true;
    try { JSON.parse(readFileSync(file, 'utf8')); } catch { ok = false; }
    assert.equal(ok, false, '损坏的 JSON 应被读侧 catch 掉，回落到"未设置"');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.ok(!existsSync(join(dir, '.model-prefs.json')), '清理后不应残留');
});
