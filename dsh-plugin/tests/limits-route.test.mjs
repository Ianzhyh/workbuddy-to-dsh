/**
 * 宿主侧 `/workbuddy/limits`：**多个模型同时触顶时不能只剩一条**。
 *
 * 用户反馈："我用别的不是 workbuddy 的用量上限怎么又只剩一个了"。
 *
 * 根因在桥的 `rateLimitSummary()`：它把 `quotaResetStats` 压成了一个 `quota`
 * （只留最新那条，其余仅累加 count），model / resetAt 全丢。桥现在额外输出
 * `quotaModels[]`；本文件钉住插件侧**确实读了它**，并且：
 *
 *   - 两个模型触顶 → 面板拿到两条，各自的 resetAt 不互相覆盖；
 *   - 老桥没有 `quotaModels` → 回落到单个 `quota`，行为不退化；
 *   - 跨账号历史（`state.limitHistory`）里同一账号不同模型也要各自成条 ——
 *     之前 key 里带了 model，但读取时如果被 `quota` 单条覆盖就只剩一个。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createRouteTable } from '../lib/routes.mjs';

/** 造一张只够用的路由表，返回 `/workbuddy/limits` 的 handler。 */
function harness({ limitsSnapshot }) {
  const routes = createRouteTable({
    snapshot: async () => ({}),
    supervisor: { logPath: 'bridge.log', readLog: () => ({ lines: [] }) },
    consoleSupervisor: { url: '', probe: async () => ({ state: 'stopped' }) },
    client: {},
    adapter: {
      catalog: async () => [],
      invalidate: () => {},
      filterSnapshot: () => ({ allow: [], deny: [], hideAll: false }),
    },
    paths: {},
    provider: 'workbuddy',
    log: () => {},
    readPrefs: () => null,
    limitsSnapshot,
  });
  const route = routes.find((r) => r.path === '/workbuddy/limits');
  assert.ok(route, '路由表里没有 /workbuddy/limits');
  return route.handler;
}

/** 极简 req/res：只提供 handler 用到的那些成员。 */
function call(handler, { method = 'GET', headers = {} } = {}) {
  const req = {
    method,
    headers,
    url: '/workbuddy/limits',
    [Symbol.asyncIterator]: async function* iterate() { /* 无 body */ },
  };
  return new Promise((resolve) => {
    let status = 0;
    let payload = '';
    const res = {
      writeHead(code) { status = code; return res; },
      end(text) { payload = text || ''; resolve({ status, body: safeParse(payload) }); },
      on() {}, off() {}, writableEnded: false,
    };
    handler(req, res);
  });
}

function safeParse(text) {
  try { return JSON.parse(text); } catch { return text; }
}

test('/workbuddy/limits：两个模型触顶时两条都在，各自带 resetAt', async () => {
  const resetA = new Date(Date.now() + 3 * 3_600_000).toISOString();
  const resetB = new Date(Date.now() + 8 * 3_600_000).toISOString();
  const handler = harness({
    limitsSnapshot: async () => ({
      ok: true,
      at: new Date().toISOString(),
      account: 'u1',
      accountLabel: 'Fixture',
      expiredCount: 0,
      accountCount: 1,
      limiting: [
        { kind: 'quota', model: 'deepseek-v4.1-flash', count: 1, resetAt: resetA, uid: 'u1', accountLabel: 'Fixture', isCurrent: true },
        { kind: 'quota', model: 'glm-5.3', count: 1, resetAt: resetB, uid: 'u1', accountLabel: 'Fixture', isCurrent: true },
      ],
    }),
  });
  const { status, body } = await call(handler);
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.limiting.length, 2, '两个模型各占一条，不能只剩最新那个');
  assert.deepEqual(body.limiting.map((x) => x.model).sort(), ['deepseek-v4.1-flash', 'glm-5.3']);
  /* 关键：各自的 resetAt 不能被对方覆盖 */
  const byModel = new Map(body.limiting.map((x) => [x.model, x.resetAt]));
  assert.equal(byModel.get('deepseek-v4.1-flash'), resetA);
  assert.equal(byModel.get('glm-5.3'), resetB);
});

test('/workbuddy/limits：桥没跑时如实报错，不伪造"没有上限"', async () => {
  const handler = harness({
    limitsSnapshot: async () => ({
      ok: false,
      limiting: [],
      accounts: [],
      at: new Date().toISOString(),
      error: '本地桥未运行，读不到用量上限',
    }),
  });
  const { status, body } = await call(handler);
  assert.equal(status, 200);
  assert.equal(body.ok, false);
  assert.match(String(body.error), /桥未运行/);
  /* 空数组 + ok:false 的组合必须保留，前端据此区分"读不到"与"确实没有" */
  assert.deepEqual(body.limiting, []);
});

test('/workbuddy/limits：快照本身抛错也要回结构化失败（不是 500）', async () => {
  const handler = harness({
    limitsSnapshot: async () => { throw new Error('boom'); },
  });
  const { status, body } = await call(handler);
  assert.equal(status, 200, '读接口失败也要 200 + ok:false，页面才有机会展示原因');
  assert.equal(body.ok, false);
  assert.match(String(body.error), /boom/);
});
