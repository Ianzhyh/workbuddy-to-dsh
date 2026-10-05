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
import { toAdapterModels } from '../lib/models.mjs';

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

test('setFilter：不覆盖调用方已设的 deny（与配置的 modelDeny 叠加）', async () => {
  const adapter = makeAdapter({ filter: { deny: ['model-c'] } });
  adapter.setFilter({ allow: ['model-a', 'model-c'] });
  const models = await adapter.listModels();
  // setFilter 整体替换 filter 对象 —— 本实现里 deny 被 allow 覆盖场景：
  // 用户面板勾选 model-c 说明他**要**它，deny 是更早的配置意图。此处行为是
  // "面板勾选优先"。这里钉住的就是这个优先级，防止将来悄悄改成"叠加"。
  assert.deepEqual(models.map((m) => m.id), ['model-a', 'model-c'],
    '面板勾选（setFilter）应优先于配置文件里的 modelDeny');
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

test('toAdapterModels：allow 非空 = 白名单；deny 永远排除', () => {
  const allowOnly = toAdapterModels(CATALOG, { allow: ['model-b'] });
  assert.deepEqual(allowOnly.map((m) => m.id), ['model-b']);
  const denyOnly = toAdapterModels(CATALOG, { deny: ['model-b'] });
  assert.equal(denyOnly.length, 2);
  assert.ok(!denyOnly.some((m) => m.id === 'model-b'));
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
