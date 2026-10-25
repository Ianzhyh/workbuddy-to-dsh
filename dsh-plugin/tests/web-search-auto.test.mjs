import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decideWebSearchAutoSetup,
  hasExplicitSearchOverride,
  isBridgeSearchEndpoint,
  looksLikeManagedSearchConfig,
  markWorkBuddyWebSearchOptOut,
  readWebSearchUserLayers,
  resetWorkBuddyWebSearchOverrides,
  SEARCH_KEY_REF,
} from '../lib/web-search-config.mjs';

const BRIDGE_URL = 'http://127.0.0.1:8790/v1';

test('自动接入判据：桥地址按路径识别，端口变化仍算自己的', () => {
  assert.equal(isBridgeSearchEndpoint(BRIDGE_URL, BRIDGE_URL), true);
  assert.equal(isBridgeSearchEndpoint(`${BRIDGE_URL}///`, BRIDGE_URL), true);
  assert.equal(isBridgeSearchEndpoint('http://127.0.0.1:9999/v1', BRIDGE_URL), true,
    '桥换端口后仍应认成自家配置，才能自愈');
  assert.equal(isBridgeSearchEndpoint('http://localhost:8790/v1', BRIDGE_URL), true);
  assert.equal(isBridgeSearchEndpoint('https://api.deepseek.com/v1', BRIDGE_URL), false);
  assert.equal(isBridgeSearchEndpoint('http://10.0.0.2:8790/v1', BRIDGE_URL), false);
  assert.equal(isBridgeSearchEndpoint('', BRIDGE_URL), false);
});

test('自动接入判据：只把「桥地址 + 插件凭据引用 + 默认 provider」认成自家配置', () => {
  const managed = { baseURL: BRIDGE_URL, apiKeyEnv: SEARCH_KEY_REF };
  assert.equal(looksLikeManagedSearchConfig({ section: managed, expectedBaseURL: BRIDGE_URL }), true);
  assert.equal(looksLikeManagedSearchConfig({
    section: managed,
    webSection: { searchProvider: 'deepseek-official' },
    expectedBaseURL: BRIDGE_URL,
  }), true);
  assert.equal(looksLikeManagedSearchConfig({
    section: { ...managed, apiKey: 'literal' },
    expectedBaseURL: BRIDGE_URL,
  }), false, '有字面 key 不是插件写的');
  assert.equal(looksLikeManagedSearchConfig({
    section: { baseURL: BRIDGE_URL, apiKeyEnv: 'DEEPSEEK_API_KEY' },
    expectedBaseURL: BRIDGE_URL,
  }), false, '凭据引用不是插件专用引用');
  assert.equal(looksLikeManagedSearchConfig({
    section: managed,
    webSection: { searchProvider: 'deepseek-search-api' },
    expectedBaseURL: BRIDGE_URL,
  }), false, '用户换过 provider');
});

test('自动接入判据：用户显式选择后端时绝不覆盖', () => {
  assert.equal(hasExplicitSearchOverride({ section: {}, webSection: {}, expectedBaseURL: BRIDGE_URL }), false,
    '空 user 层 = 没选过');
  assert.equal(hasExplicitSearchOverride({
    section: { baseURL: 'https://api.deepseek.com/v1' },
    expectedBaseURL: BRIDGE_URL,
  }), true);
  assert.equal(hasExplicitSearchOverride({
    section: { apiKeyEnv: 'MY_CUSTOM_KEY' },
    expectedBaseURL: BRIDGE_URL,
  }), true);
  assert.equal(hasExplicitSearchOverride({
    section: { apiKey: 'sk-literal' },
    expectedBaseURL: BRIDGE_URL,
  }), true);
  assert.equal(hasExplicitSearchOverride({
    section: {},
    webSection: { searchProvider: 'deepseek-search-api' },
    expectedBaseURL: BRIDGE_URL,
  }), true);
  assert.equal(hasExplicitSearchOverride({
    section: {},
    webSection: { searchProvider: 'deepseek-official' },
    expectedBaseURL: BRIDGE_URL,
  }), true, '显式选官方 = 用户决定走 DeepSeek');
  assert.equal(hasExplicitSearchOverride({
    section: { baseURL: BRIDGE_URL, apiKeyEnv: SEARCH_KEY_REF },
    webSection: { searchProvider: 'deepseek-official' },
    expectedBaseURL: BRIDGE_URL,
  }), false, '插件自己的配置不是用户选择');
  assert.equal(hasExplicitSearchOverride({
    section: { maxUses: 9 },
    expectedBaseURL: BRIDGE_URL,
  }), false, 'maxUses 这类调参不算换后端');
});

test('自动接入决策：已接入/显式配置/宿主不支持都跳过，桥没好就等', () => {
  const base = { available: true, configured: false, reason: 'endpoint', tokenMatches: true };
  assert.equal(decideWebSearchAutoSetup({
    status: { ...base, configured: true, reason: '' },
    bridgeState: 'running',
  }).reason, 'configured');
  assert.equal(decideWebSearchAutoSetup({
    status: base,
    explicitOverride: true,
    bridgeState: 'running',
  }).action, 'skip');
  assert.equal(decideWebSearchAutoSetup({
    status: { ...base, reason: 'namespace-missing' },
    bridgeState: 'running',
  }).reason, 'unavailable');
  assert.deepEqual(decideWebSearchAutoSetup({
    status: { ...base, reason: 'error' },
    bridgeState: 'running',
  }), { action: 'wait', reason: 'settings' }, '读配置失败不能当作没配过');
  assert.deepEqual(decideWebSearchAutoSetup({
    status: base,
    bridgeState: 'stopped',
  }), { action: 'wait', reason: 'bridge' });
  assert.deepEqual(decideWebSearchAutoSetup({
    status: base,
    bridgeState: 'running',
  }), { action: 'configure', reason: 'auto' });
  assert.deepEqual(decideWebSearchAutoSetup({
    status: { ...base, configured: true, tokenMatches: false },
    managed: true,
    bridgeState: 'running',
  }), { action: 'configure', reason: 'heal' });
  assert.equal(decideWebSearchAutoSetup({
    enabled: false,
    status: base,
    bridgeState: 'running',
  }).reason, 'disabled');
});

test('自动接入后重启：没有快照也能只摘掉插件写的字段', async () => {
  const sections = {
    'web-search-deepseek': {
      baseURL: BRIDGE_URL,
      apiKeyEnv: SEARCH_KEY_REF,
      maxUses: 4,
    },
    web: { searchProvider: 'deepseek-official' },
  };
  const settings = {
    describe() {
      return [
        { ns: 'web-search-deepseek', user: { ...sections['web-search-deepseek'] } },
        { ns: 'web', user: { ...sections.web } },
      ];
    },
    async replace(ns, section) {
      sections[ns] = { ...section };
    },
  };
  let unset = '';
  const credentials = { async unset(ref) { unset = ref; } };
  const result = await resetWorkBuddyWebSearchOverrides({
    settings,
    credentials,
    expectedBaseURL: BRIDGE_URL,
  });
  assert.deepEqual(result.removed.sort(), ['apiKeyEnv', 'baseURL']);
  assert.deepEqual(sections['web-search-deepseek'], { maxUses: 4 }, '用户的其它字段必须保留');
  assert.deepEqual(sections.web, { searchProvider: 'deepseek-official' });
  assert.equal(unset, SEARCH_KEY_REF);

  await assert.rejects(
    resetWorkBuddyWebSearchOverrides({
      settings: {
        describe: () => [{ ns: 'web-search-deepseek', user: { baseURL: 'https://api.deepseek.com/v1' } }],
        async replace() {},
      },
      credentials,
      expectedBaseURL: BRIDGE_URL,
    }),
    /not installed by WorkBuddy/,
  );
});

test('恢复后留下退出自动接入的标记，下次启动不会又接回去', async () => {
  const writes = [];
  const settingsWithWeb = {
    describe: () => [
      { ns: 'web-search-deepseek', user: {} },
      { ns: 'web', user: {} },
    ],
    async replace(ns, section) { writes.push({ ns, section }); },
  };
  assert.deepEqual(
    await markWorkBuddyWebSearchOptOut({ settings: settingsWithWeb }),
    { marked: true, reason: 'provider' },
  );
  assert.deepEqual(writes[0], { ns: 'web', section: { searchProvider: 'deepseek-official' } });

  const settingsNoWeb = {
    describe: () => [{ ns: 'web-search-deepseek', user: {} }],
    async replace(ns, section) { writes.push({ ns, section }); },
  };
  assert.deepEqual(
    await markWorkBuddyWebSearchOptOut({ settings: settingsNoWeb }),
    { marked: true, reason: 'key-ref' },
  );
  assert.deepEqual(writes.at(-1), {
    ns: 'web-search-deepseek',
    section: { apiKeyEnv: 'DEEPSEEK_API_KEY' },
  });

  const explicit = {
    describe: () => [
      { ns: 'web-search-deepseek', user: {} },
      { ns: 'web', user: { searchProvider: 'deepseek-search-api' } },
    ],
    async replace(ns, section) { writes.push({ ns, section }); },
  };
  assert.deepEqual(
    await markWorkBuddyWebSearchOptOut({ settings: explicit }),
    { marked: false, reason: 'already-explicit' },
  );
});

test('读 user 层：describe 缺失/异常时不假装知道用户意图', () => {
  assert.deepEqual(readWebSearchUserLayers(null), { available: false, search: null, web: null, hasWeb: false });
  assert.deepEqual(readWebSearchUserLayers({ get() {} }), { available: false, search: null, web: null, hasWeb: false });
  const layers = readWebSearchUserLayers({
    describe: () => [
      { ns: 'web-search-deepseek', user: { maxUses: 3 } },
      { ns: 'web', user: undefined },
    ],
  });
  assert.deepEqual(layers, {
    available: true,
    search: { maxUses: 3 },
    web: {},
    hasWeb: true,
  });
});
