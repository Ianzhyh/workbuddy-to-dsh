/**
 * 宿主侧 `/workbuddy/default-model`：读 / 写 dsh 的默认模型。
 *
 * 为什么值得单独钉：右栏的「模型」页靠它显示"当前默认"，靠它把用户选的那条写成
 * dsh 的默认（新会话就用它）。写错了两条都静默失效 —— 页面照样显示一个名字，
 * 而新会话用的是别的模型；或者思考档位丢了，下一次请求按上游默认跑。
 *
 * 同时钉住「服务不存在」的情形：读返回 null（页面显示"未设置"，而不是编一个），
 * 写返回可读错误（页面能把原因说出来），而不是 500 或静默成功。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createRouteTable } from '../lib/routes.mjs';

/** 造一张只够用的路由表，返回 `/workbuddy/default-model` 的 handler。 */
function harness({ current = null, catalog = [], saveImpl, writePrefs } = {}) {
  const routes = createRouteTable({
    snapshot: async () => ({}),
    supervisor: { logPath: 'bridge.log', readLog: () => ({ lines: [] }) },
    consoleSupervisor: { url: 'http://127.0.0.1:1', probe: async () => ({ state: 'stopped' }) },
    client: {},
    adapter: {
      catalog: async () => catalog,
      invalidate: () => {},
      filterSnapshot: () => ({ allow: [], deny: [], hideAll: false }),
    },
    paths: {},
    provider: 'workbuddy',
    log: () => {},
    readPrefs: () => null,
    onWritePrefs: writePrefs || (() => {}),
    readDefaultModel: () => current,
    saveDefaultModel: saveImpl || (async () => {}),
  });
  const route = routes.find((r) => r.path === '/workbuddy/default-model');
  assert.ok(route, '路由表里没有 /workbuddy/default-model');
  return route.handler;
}

/** 极简 req/res：只提供 handler 用到的那些成员。 */
function call(handler, { method = 'GET', body, headers = {} } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const req = {
    method,
    headers,
    url: '/workbuddy/default-model',
    [Symbol.asyncIterator]: async function* iterate() { for (const c of chunks) yield c; },
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

const GUARD = { 'x-workbuddy-panel': '1' };

test('读：返回 provider / model / 档位，以及"是否还在目录里"', async () => {
  const handler = harness({
    current: { provider: 'workbuddy', model: 'glm-5.3', reasoningEffort: 'high' },
    catalog: [{ id: 'glm-5.3', name: 'GLM-5.3' }, { id: 'other', name: 'Other' }],
  });
  const { status, body } = await call(handler);
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.provider, 'workbuddy');
  assert.equal(body.model, 'glm-5.3');
  assert.equal(body.reasoningEffort, 'high');
  assert.equal(body.routable, true, '在目录里应判 routable');
});

test('读：默认模型不在目录里时必须如实说 routable=false（不要假装可选）', async () => {
  const handler = harness({
    current: { provider: 'workbuddy', model: 'gone-model', reasoningEffort: 'max' },
    catalog: [{ id: 'glm-5.3', name: 'GLM-5.3' }],
  });
  const { body } = await call(handler);
  assert.equal(body.ok, true);
  assert.equal(body.model, 'gone-model');
  assert.equal(body.routable, false);
});

test('读：没有默认模型服务时 model 为空、routable=null（不是 false）', async () => {
  const handler = harness({ current: null, catalog: [{ id: 'glm-5.3' }] });
  const { body } = await call(handler);
  assert.equal(body.ok, true);
  assert.equal(body.model, '');
  assert.equal(body.routable, null, 'routable=null 表示"无法判断"，页面据此显示提示而不是红字');
});

test('读：目录本身读失败不影响默认模型的读取', async () => {
  const handler = harness({
    current: { provider: 'workbuddy', model: 'glm-5.3' },
    catalog: [],
  });
  const { status, body } = await call(handler);
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.model, 'glm-5.3');
});

test('写：没有面板头就拒绝（这条会改配置，必须挡跨站简单请求）', async () => {
  const handler = harness();
  const { status, body } = await call(handler, { method: 'POST', body: { model: 'glm-5.3' } });
  assert.equal(status, 403);
  assert.equal(body.ok, false);
});

test('写：model 为空直接 400，不要写进一条空模型', async () => {
  const handler = harness();
  const { status, body } = await call(handler, { method: 'POST', headers: GUARD, body: {} });
  assert.equal(status, 400);
  assert.equal(body.ok, false);
});

test('写：带上 provider 与档位，并把结果回报给调用方', async () => {
  const saved = [];
  const handler = harness({
    current: { provider: 'workbuddy', model: 'old', reasoningEffort: 'medium' },
    saveImpl: async (next) => { saved.push(next); },
  });
  const { status, body } = await call(handler, {
    method: 'POST',
    headers: GUARD,
    body: { model: 'glm-5.3', reasoningEffort: 'high' },
  });
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.saved, true);
  assert.equal(saved.length, 1);
  assert.deepEqual({ ...saved[0] }, { provider: 'workbuddy', model: 'glm-5.3', reasoningEffort: 'high' });
});

test('写：请求里没给档位时沿用现有档位（不要把它清空）', async () => {
  const saved = [];
  const handler = harness({
    current: { provider: 'workbuddy', model: 'old', reasoningEffort: 'max' },
    saveImpl: async (next) => { saved.push(next); },
  });
  const { body } = await call(handler, { method: 'POST', headers: GUARD, body: { model: 'glm-5.3' } });
  assert.equal(body.ok, true);
  assert.equal(saved[0].reasoningEffort, 'max', '档位应沿用当前值');
});

test('写：服务不存在时如实报错，不假装成功', async () => {
  const handler = harness({
    saveImpl: async () => { throw new Error('这一版 dsh 没有默认模型服务'); },
  });
  const { status, body } = await call(handler, { method: 'POST', headers: GUARD, body: { model: 'glm-5.3' } });
  assert.equal(status, 200);
  assert.equal(body.ok, false);
  assert.match(body.error, /没有默认模型服务/);
});
