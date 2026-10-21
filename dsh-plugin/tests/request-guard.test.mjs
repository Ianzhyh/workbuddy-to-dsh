/**
 * 前端请求层守卫：超时、轮询在途去重、登录 poll 的晚到响应。
 *
 * 回归背景：`getJson`/`postJson` 没有超时，宿主半死时 fetch 永不返回，
 * useJson 的重试和按钮的 finally 都等不到；轮询也没有在途锁，桥慢时请求会
 * 叠着飞、晚到的响应还可能盖掉新状态。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN = join(HERE, '..');
const REPO = join(PLUGIN, '..');
const CLIENT = readFileSync(join(PLUGIN, 'lib', 'client.js'), 'utf8');
const DASHBOARD = readFileSync(join(REPO, 'dashboard', 'public', 'index.html'), 'utf8');

function loadClient(fetchImpl) {
  let registration;
  const sandbox = {
    window: { __ModuleLoader__: { load: (h) => { registration = h; } } },
    fetch: fetchImpl,
    AbortSignal,
    setTimeout,
    clearTimeout,
    console,
  };
  vm.runInNewContext(CLIENT, sandbox, { filename: 'client.js' });
  const React = {
    createElement: () => null,
    useState: (v) => [v, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
    useRef: (v) => ({ current: v }),
    useMemo: (fn) => fn(),
    Fragment: {},
  };
  return registration.factory(() => React);
}

test('请求超时：getJson 抛错、postJson 返回可读的失败响应', async () => {
  const timeoutError = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  const mod = loadClient(async () => { throw timeoutError; });
  await assert.rejects(() => mod.getJson('/workbuddy/status'), /aborted|timeout/i,
    'getJson 必须把超时抛给 useJson，才能触发失败重试');
  const res = await mod.postJson('/workbuddy/quota', {});
  assert.equal(res.status, 0, 'postJson 网络/超时失败统一成 status 0');
  assert.match(res.data.error, /请求超时/);
});

test('轮询与登录 poll 都有在途去重 / 晚到响应守卫', () => {
  assert.match(CLIENT, /const inFlight = useRef\(false\)/, 'useJson 缺少在途标记');
  assert.match(CLIENT, /if \(inFlight\.current\) return;/, 'useJson 在途时没有跳过重复请求');
  assert.match(CLIENT, /const pollInFlight = useRef\(false\)/, '登录 poll 缺少在途标记');
  assert.match(CLIENT, /pendingRef\.current\?\.state !== state/, '登录 poll 没有丢弃晚到响应');
  assert.match(DASHBOARD, /const API_TIMEOUT_MS = 20000/, '控制台 api() 缺少超时');
  assert.match(DASHBOARD, /pluginLoginState\.polling/, '控制台登录 poll 缺少在途标记');
});

test('超时文案明确、默认 20 秒，不把 TimeoutError 原样甩给用户', () => {
  assert.match(CLIENT, /const REQUEST_TIMEOUT_MS = 20_000/);
  assert.ok(CLIENT.includes('请求超时（${Math.round(REQUEST_TIMEOUT_MS / 1000)} 秒）'));
  assert.ok(DASHBOARD.includes('请求超时（${Math.round(API_TIMEOUT_MS / 1000)} 秒）'));
});
