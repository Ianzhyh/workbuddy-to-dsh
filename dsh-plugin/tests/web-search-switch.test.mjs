/**
 * issue #33：网页搜索的**通道切换**与「不误报警」。
 *
 * ## 这条 issue 说的是三件不同的事（别混成一件）
 *
 *   1. **能力**：面板要能手动在 WorkBuddy 与 DeepSeek 官方之间切换；
 *   2. **尊重选择**：切到别的通道之后，插件不能自己切回 WorkBuddy，
 *      也不能把「用户的选择」显示成需要处理的问题；
 *   3. **不谎报**：配置读取失败 / 凭据错误 / 真实搜索失败仍要如实提示；
 *      但不能反过来把「非 WorkBuddy」一律当成「DeepSeek 且烧钱包」。
 *
 * ## 为什么用「判定函数 + 真实 settings 桩」两层测
 *
 * 纯字符串断言测不出"会不会自动改回"这类行为（行为散在状态机里）。
 * 所以这里：
 *   · 通道判定（`deriveSearchChannel`）逐个形态直测；
 *   · 切换动作（`switchWorkBuddyWebSearchToDeepSeek`）用真 settings 桩跑，
 *     断言**写了什么、没写什么**（第三方端点不能被静默删）；
 *   · 「切走后不自动接回」走真实 `apply()`，看自动接入是否真的停手。
 *
 *   node --test dsh-plugin/tests/web-search-switch.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { apply } from '../lib/index.js';
import { bridgeBuildHash } from '../lib/bridge.mjs';
import {
  deriveSearchChannel,
  SEARCH_CHANNEL_BRIDGE,
  SEARCH_CHANNEL_DEEPSEEK,
  SEARCH_CHANNEL_EXTERNAL,
  SEARCH_CHANNEL_UNKNOWN,
  SEARCH_KEY_REF,
  switchWorkBuddyWebSearchToDeepSeek,
} from '../lib/web-search-config.mjs';

/* 与 plugin.test 同一套隔离：不读使用者真实的 state/data 目录。 */
if (!process.env.WORKBUDDY_STATE_FILE) {
  process.env.WORKBUDDY_STATE_FILE = join(tmpdir(), `wb-switch-test-state-${process.pid}.json`);
}
process.env.WORKBUDDY_DATA_DIR ||= mkdtempSync(join(tmpdir(), 'wb-switch-test-data-'));

const BRIDGE_URL = 'http://127.0.0.1:8790/v1';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 按 dsh SettingsProvider 的真实形状造桩：只有 describe/update/replace。 */
function makeSettings(sections) {
  const state = JSON.parse(JSON.stringify(sections));
  const calls = [];
  const listeners = [];
  return {
    state,
    calls,
    onChange: (fn) => listeners.push(fn),
    describe: () => Object.entries(state).map(([ns, value]) => ({
      ns, value: { ...value }, user: { ...value },
    })),
    async update(ns, patch) {
      if (!Object.hasOwn(state, ns)) throw new Error(`settings namespace "${ns}" is not registered`);
      calls.push({ ns, patch });
      state[ns] = { ...state[ns], ...patch };
      for (const fn of listeners) fn(ns);
    },
    async replace(ns, section) {
      if (!Object.hasOwn(state, ns)) throw new Error(`settings namespace "${ns}" is not registered`);
      calls.push({ ns, replace: section });
      state[ns] = { ...section };
      for (const fn of listeners) fn(ns);
    },
  };
}

function makeCredentials(initial = {}) {
  const store = new Map(Object.entries(initial));
  const calls = [];
  return {
    store,
    calls,
    async set(ref, value) { calls.push({ ref, value }); store.set(ref, value); },
    async unset(ref) { calls.push({ ref, unset: true }); store.delete(ref); },
    async describe(ref) { return { configured: store.has(ref) }; },
    async resolve(ref) { return store.has(ref) ? { value: store.get(ref) } : undefined; },
  };
}

// ── 1. 通道判定：四态必须分得开 ─────────────────────────────────────
test('通道判定：桥 / 官方 / 自定义端点 / 未知，四种形态互不混淆', () => {
  const base = { expectedBaseURL: BRIDGE_URL };

  const onBridge = deriveSearchChannel({
    ...base,
    section: { baseURL: BRIDGE_URL, apiKeyEnv: SEARCH_KEY_REF },
    webSection: {},
  });
  assert.equal(onBridge.channel, SEARCH_CHANNEL_BRIDGE);

  // 端口漂移仍是自己的桥（自愈场景），必须认成 bridge 而不是"自定义端点"
  assert.equal(deriveSearchChannel({
    ...base,
    section: { baseURL: 'http://127.0.0.1:9999/v1', apiKeyEnv: SEARCH_KEY_REF },
    webSection: {},
  }).channel, SEARCH_CHANNEL_BRIDGE, '桥换端口后仍算桥通道，否则会误导用户重配');

  // 空配置 = dsh 的默认形态（官方搜索），不是故障
  const official = deriveSearchChannel({ ...base, section: {}, webSection: {} });
  assert.equal(official.channel, SEARCH_CHANNEL_DEEPSEEK);
  assert.equal(official.deliberate, true, '默认形态也是一种"合理状态"，不是待办');

  // 显式选官方 provider
  assert.equal(deriveSearchChannel({
    ...base,
    section: {},
    webSection: { searchProvider: 'deepseek-official' },
  }).channel, SEARCH_CHANNEL_DEEPSEEK);

  // 第三方端点：这是用户的选择，必须标成 deliberate
  const thirdParty = deriveSearchChannel({
    ...base,
    section: { baseURL: 'https://api.deepseek.com/anthropic/v1', apiKeyEnv: 'MY_KEY' },
    webSection: {},
  });
  assert.equal(thirdParty.channel, SEARCH_CHANNEL_EXTERNAL);
  assert.equal(thirdParty.deliberate, true);
  assert.equal(thirdParty.endpoint, 'https://api.deepseek.com/anthropic/v1');

  // 换了 provider、端点交给 provider 自己
  assert.equal(deriveSearchChannel({
    ...base,
    section: {},
    webSection: { searchProvider: 'deepseek-search-api' },
  }).channel, SEARCH_CHANNEL_EXTERNAL);

  // 读不到配置 / 宿主没加载 provider = 真的不知道
  for (const deps of [{ available: false }, { configError: true }]) {
    const unknown = deriveSearchChannel({ ...base, section: {}, webSection: {}, ...deps });
    assert.equal(unknown.channel, SEARCH_CHANNEL_UNKNOWN);
    assert.equal(unknown.deliberate, false, '读不到配置时不能假装这是用户的选择');
  }
});

// ── 2. 切到 DeepSeek：写什么、不写什么 ──────────────────────────────
test('切到 DeepSeek 官方：摘掉桥地址与插件凭据，保留用户的其它字段', async () => {
  const settings = makeSettings({
    'web-search-deepseek': {
      baseURL: BRIDGE_URL,
      apiKeyEnv: SEARCH_KEY_REF,
      maxUses: 7,
    },
    web: {},
  });
  const credentials = makeCredentials({ [SEARCH_KEY_REF]: 'bridge-token' });

  const result = await switchWorkBuddyWebSearchToDeepSeek({
    settings,
    credentials,
    expectedBaseURL: BRIDGE_URL,
  });

  assert.equal(result.switched, true);
  assert.equal(result.previousEndpoint, BRIDGE_URL);
  assert.deepEqual(settings.state['web-search-deepseek'], { maxUses: 7 },
    'maxUses 这类调参不能一起删');
  assert.equal(settings.state.web.searchProvider, 'deepseek-official');
  assert.equal(credentials.store.has(SEARCH_KEY_REF), false,
    '插件专用凭据要跟着清掉，否则留一份无主令牌');
  // 落盘内容里不能出现任何令牌
  assert.equal(JSON.stringify(settings.calls).includes('bridge-token'), false);
});

test('切到 DeepSeek 官方：第三方端点必须先确认，绝不静默删', async () => {
  const external = {
    baseURL: 'https://search.example.com/v1',
    apiKeyEnv: 'MY_OWN_KEY',
  };
  const settings = makeSettings({ 'web-search-deepseek': { ...external }, web: {} });
  const credentials = makeCredentials({ MY_OWN_KEY: 'user-secret' });

  const first = await switchWorkBuddyWebSearchToDeepSeek({
    settings,
    credentials,
    expectedBaseURL: BRIDGE_URL,
  });
  assert.equal(first.switched, false, '第三方端点未确认时不能动');
  assert.equal(first.needsConfirm, true);
  assert.equal(first.endpoint, external.baseURL, '要把"会被删掉的那个地址"告诉调用方');
  assert.deepEqual(settings.state['web-search-deepseek'], external, '什么都没改');
  assert.deepEqual(settings.state.web, {}, 'provider 也不能偷偷改');
  assert.equal(settings.calls.length, 0);
  assert.equal(credentials.calls.length, 0, '未确认时不能碰凭据');

  // 用户确认后才真正切
  const second = await switchWorkBuddyWebSearchToDeepSeek({
    settings,
    credentials,
    expectedBaseURL: BRIDGE_URL,
    confirmExternal: true,
  });
  assert.equal(second.switched, true);
  assert.equal(settings.state['web-search-deepseek'].baseURL, undefined);
  assert.equal(settings.state['web-search-deepseek'].apiKeyEnv, 'MY_OWN_KEY',
    '用户自己的 apiKeyEnv 不是我们的东西，不能删');
  assert.equal(credentials.store.get('MY_OWN_KEY'), 'user-secret', '凭据不能被动');
});

test('切到 DeepSeek 官方：用户自己起的本地搜索服务不能被误认成我们的桥', async () => {
  // 同样是 127.0.0.1:PORT/v1，但凭据引用不是插件专用的 = 别人的配置
  const settings = makeSettings({
    'web-search-deepseek': { baseURL: 'http://127.0.0.1:7777/v1', apiKeyEnv: 'MY_LOCAL_KEY' },
    web: {},
  });
  const result = await switchWorkBuddyWebSearchToDeepSeek({
    settings,
    credentials: makeCredentials(),
    expectedBaseURL: BRIDGE_URL,
  });
  assert.equal(result.needsConfirm, true,
    '只按"像不像本机 /v1"判断会删掉用户自己的本地服务');
});

test('切到 DeepSeek 官方：宿主没有 web 分节时也要留下"用户选择"的痕迹', async () => {
  const settings = makeSettings({
    'web-search-deepseek': { baseURL: BRIDGE_URL, apiKeyEnv: SEARCH_KEY_REF },
  });
  const result = await switchWorkBuddyWebSearchToDeepSeek({
    settings,
    credentials: makeCredentials(),
    expectedBaseURL: BRIDGE_URL,
  });
  assert.equal(result.switched, true);
  // rc.6 没有 web 分节：只能靠 apiKeyEnv 进 user 层来表达"别自动接回来"
  assert.equal(settings.state['web-search-deepseek'].apiKeyEnv, 'DEEPSEEK_API_KEY');
  assert.equal(settings.state['web-search-deepseek'].baseURL, undefined);
});

// ── 3. 切走之后，自动接入不能自己接回去 ─────────────────────────────
async function startFakeBridge(dir) {
  mkdirSync(join(dir, 'bridge'), { recursive: true });
  const script = join(dir, 'bridge', 'workbuddy-bridge.mjs');
  writeFileSync(script, '// fake bridge placeholder for build hash\n');
  const build = bridgeBuildHash(script);
  const server = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        pid: process.pid,
        uptimeMs: 1000,
        build,
        catalogSize: 0,
        auth: { userId: 'u-switch', expiresAt: new Date(Date.now() + 3600_000).toISOString() },
        credential: { desktop: { available: true } },
      }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: server.address().port, close: () => new Promise((r) => server.close(r)) };
}

function fakeCtx(services, logs = []) {
  return {
    logger: {
      info: (...args) => logs.push(args.map(String).join(' ')),
      warn: () => {},
      error: (...args) => logs.push(args.map(String).join(' ')),
    },
    llm: {
      registerAdapter() {
        const handle = () => {};
        handle.replace = () => {};
        return handle;
      },
    },
    get: (name) => services[name],
    effect: (fn) => fn(),
    provide: () => () => {},
  };
}

async function waitFor(predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(40);
  }
  return false;
}

test('apply()：用户手动切到 DeepSeek 后，自动接入不得接回桥（issue #33 第 2 条）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-switch-no-reauto-'));
  let bridge;
  try {
    bridge = await startFakeBridge(dir);
    const settings = makeSettings({
      // 用户层是空的 = 没配过 → 自动接入应当把它接到桥（保留 issue #7 的行为）。
      // 不能预置 `searchProvider: 'deepseek-official'`：那本身就是一次"显式选择"，
      // 自动接入会正确地跳过，测不到"接上再切走"这条路径。
      'web-search-deepseek': {},
      web: {},
    });
    const credentials = makeCredentials();
    const routes = [];
    const services = {
      settings,
      credentials,
      web: { async search() { return { sources: [{ url: 'https://example.com' }] }; } },
      tools: { register: () => () => {} },
      commands: { register: () => () => {} },
      webServer: { register: (route) => { routes.push(route); return () => {}; } },
    };
    const logs = [];
    const result = apply(fakeCtx(services, logs), {
      projectRoot: dir,
      bridgeHost: '127.0.0.1',
      bridgePort: bridge.port,
      localToken: 'switch-token',
      autoStart: false,
      autoWebSearch: true,
      consoleAutoStart: false,
      migrateLegacy: false,
    });

    /*
     * 先让它把桥接上（这是 issue #7 的行为，必须保留），
     * 再用面板路由手动切回 DeepSeek 官方。
     */
    const autoDone = await waitFor(() => result.state.webSearchAuto.status === 'done'
      || result.state.webSearchAuto.status === 'failed');
    assert.equal(autoDone, true, logs.join('\n'));
    assert.equal(result.state.webSearchAuto.status, 'done', logs.join('\n'));
    assert.equal(settings.state.web.searchProvider, 'deepseek-official');

    const disableRoute = routes.find((route) => route.path === '/workbuddy/web-search/disable');
    assert.ok(disableRoute, '没有注册「切到 DeepSeek 官方」路由');

    let responseStatus = 0;
    let raw = '';
    const res = {
      writeHead(code) { responseStatus = code; },
      write(chunk) { raw += String(chunk); },
      end(body) { if (body) raw += String(body); },
      on() {}, off() {}, [Symbol.asyncIterator]: async function* iter() {},
    };
    await disableRoute.handler({
      url: '/workbuddy/web-search/disable',
      method: 'POST',
      headers: { 'x-workbuddy-panel': '1' },
    }, res);
    assert.equal(responseStatus, 200, raw);
    const body = JSON.parse(raw);
    assert.equal(body.ok, true, raw);
    assert.equal(body.switched, true, raw);
    assert.equal(settings.state['web-search-deepseek'].baseURL, undefined,
      '切到官方后不该还留着桥地址');
    assert.equal(result.state.webSearchAuto.status, 'opted-out',
      '必须记下"用户切走过"，否则重启/轮询会又接回来');

    /*
     * 关键一步：再等几轮。自动接入的状态机在 `opted-out` 时必须彻底停手 ——
     * 这正是 issue #33 抱怨的"我切走了它自己又跳回去"。
     */
    const autoCallsBefore = settings.calls.length;
    await sleep(1200);
    assert.equal(settings.calls.length, autoCallsBefore,
      `opted-out 之后不能再写任何搜索配置，实际又写了：${JSON.stringify(settings.calls.slice(autoCallsBefore))}`);
    assert.equal(settings.state['web-search-deepseek'].baseURL, undefined, '不能被自动接回桥');
  } finally {
    if (bridge) await bridge.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('状态快照：非桥通道 ready 恒为真且 reason 为空（不能再报成故障）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-switch-status-'));
  let bridge;
  try {
    bridge = await startFakeBridge(dir);
    // 用户自己配了第三方端点
    const settings = makeSettings({
      'web-search-deepseek': {
        baseURL: 'https://search.example.com/v1',
        apiKeyEnv: 'MY_OWN_KEY',
      },
      web: {},
    });
    const credentials = makeCredentials({ MY_OWN_KEY: 'user-secret' });
    const services = {
      settings,
      credentials,
      web: { async search() { return { sources: [] }; } },
      tools: { register: () => () => {} },
      commands: { register: () => () => {} },
      webServer: { register: () => () => {} },
    };
    const logs = [];
    const result = apply(fakeCtx(services, logs), {
      projectRoot: dir,
      bridgeHost: '127.0.0.1',
      bridgePort: bridge.port,
      localToken: 'switch-token',
      autoStart: false,
      autoWebSearch: true,
      consoleAutoStart: false,
      migrateLegacy: false,
    });

    const snap = await result.snapshot({});
    const search = snap.webSearch;
    assert.equal(search.channel, SEARCH_CHANNEL_EXTERNAL,
      `用户自配的第三方端点应判成 external，实得 ${JSON.stringify(search)}`);
    assert.equal(search.deliberate, true);
    assert.equal(search.ready, true, '非桥通道不该被判成"没接好"');
    assert.equal(search.reason, '', '不给 reason，面板就不会去查故障分支');
    // 自动接入必须不覆盖用户配置
    const settled = await waitFor(() => ['skipped', 'done', 'failed', 'opted-out']
      .includes(result.state.webSearchAuto.status));
    assert.equal(settled, true, logs.join('\n'));
    assert.notEqual(result.state.webSearchAuto.status, 'done',
      '第三方端点绝不能被自动接回桥');
    assert.equal(settings.state['web-search-deepseek'].baseURL, 'https://search.example.com/v1');
  } finally {
    if (bridge) await bridge.close();
    rmSync(dir, { recursive: true, force: true });
  }
});