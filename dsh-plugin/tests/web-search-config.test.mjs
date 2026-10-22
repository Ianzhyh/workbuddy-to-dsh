import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  configureWorkBuddyWebSearch,
  deriveWebSearchReadiness,
  deriveWebSearchStatus,
  restoreWorkBuddyWebSearch,
  snapshotWorkBuddyWebSearch,
  verifyWorkBuddyWebSearch,
  SEARCH_KEY_REF,
} from '../lib/web-search-config.mjs';

/**
 * 按 dsh SettingsProvider 的真实约束造一个假实现：
 * 未注册的 namespace 调 update 必须抛错（rc.6 的 `web` 就是这种）。
 */
function makeSettings({ registered = new Set(['web-search-deepseek']), sections = {} } = {}) {
  const calls = [];
  return {
    calls,
    get(ns) {
      return registered.has(ns) ? (sections[ns] ?? {}) : undefined;
    },
    async update(ns, patch) {
      if (!registered.has(ns)) throw new Error(`settings namespace "${ns}" is not registered`);
      calls.push({ ns, patch });
      sections[ns] = { ...(sections[ns] || {}), ...patch };
    },
  };
}

test('一键配置：写独立凭据引用 + 桥 baseURL，不碰 DEEPSEEK_API_KEY', async () => {
  const credentialsCalls = [];
  const settings = makeSettings();
  const result = await configureWorkBuddyWebSearch({
    settings,
    credentials: {
      async set(ref, value) { credentialsCalls.push({ ref, value }); },
    },
    baseURL: 'http://127.0.0.1:8790/v1',
    token: 'local-bridge-token',
  });

  assert.equal(result.baseURL, 'http://127.0.0.1:8790/v1');
  assert.equal(result.apiKeyRef, SEARCH_KEY_REF);
  assert.deepEqual(credentialsCalls, [{ ref: SEARCH_KEY_REF, value: 'local-bridge-token' }]);
  assert.deepEqual(settings.calls, [{
    ns: 'web-search-deepseek',
    patch: { baseURL: 'http://127.0.0.1:8790/v1', apiKeyEnv: SEARCH_KEY_REF },
  }]);
  const serialized = JSON.stringify(settings.calls);
  assert.equal(serialized.includes('DEEPSEEK_API_KEY'), false, '不能覆盖用户已有的 DeepSeek key');
  assert.equal(serialized.includes('local-bridge-token'), false, '令牌不能写进 settings/patch');
});

test('一键配置：dsh 没有 web 分节时跳过 provider 选择，不能因此失败', async () => {
  const settings = makeSettings(); // 只注册了 web-search-deepseek
  const result = await configureWorkBuddyWebSearch({
    settings,
    credentials: { async set() {} },
    baseURL: 'http://127.0.0.1:8790/v1',
    token: 't',
  });
  assert.equal(result.providerSelected, false);
  assert.deepEqual(settings.calls.map((c) => c.ns), ['web-search-deepseek']);
});

test('一键配置：dsh 注册了 web 分节时选中 deepseek-official', async () => {
  const settings = makeSettings({ registered: new Set(['web', 'web-search-deepseek']) });
  const result = await configureWorkBuddyWebSearch({
    settings,
    credentials: { async set() {} },
    baseURL: 'http://127.0.0.1:8790/v1',
    token: 't',
  });
  assert.equal(result.providerSelected, true);
  assert.deepEqual(settings.calls[0], { ns: 'web', patch: { searchProvider: 'deepseek-official' } });
  assert.deepEqual(settings.calls[1].ns, 'web-search-deepseek');
});

test('一键配置：分节里有字面 apiKey 时置空，回落到独立凭据引用', async () => {
  const settings = makeSettings({ sections: { 'web-search-deepseek': { apiKey: 'old-literal' } } });
  const result = await configureWorkBuddyWebSearch({
    settings,
    credentials: { async set() {} },
    baseURL: 'http://127.0.0.1:8790/v1',
    token: 't',
  });
  assert.equal(result.clearedLiteralKey, true);
  assert.equal(settings.calls.at(-1).patch.apiKey, '');
});

test('一键配置：服务缺失/空令牌/非法 URL 必须明确失败', async () => {
  await assert.rejects(
    configureWorkBuddyWebSearch({ settings: null, credentials: { set() {} }, baseURL: 'http://127.0.0.1:8790/v1', token: 't' }),
    /settings service/i,
  );
  await assert.rejects(
    configureWorkBuddyWebSearch({ settings: { update() {} }, credentials: null, baseURL: 'http://127.0.0.1:8790/v1', token: 't' }),
    /credentials service/i,
  );
  await assert.rejects(
    configureWorkBuddyWebSearch({ settings: { update() {} }, credentials: { set() {} }, baseURL: 'http://127.0.0.1:8790/v1', token: '' }),
    /token is empty/i,
  );
  await assert.rejects(
    configureWorkBuddyWebSearch({ settings: { update() {} }, credentials: { set() {} }, baseURL: 'not-a-url', token: 't' }),
    /invalid bridge base URL/i,
  );
});

test('状态判断：只有接口地址、凭据、provider 三者都对才算已接入', () => {
  const expected = 'http://127.0.0.1:8790/v1';
  const ready = deriveWebSearchStatus({
    section: { baseURL: 'http://127.0.0.1:8790/v1///', apiKeyEnv: SEARCH_KEY_REF },
    webSection: { searchProvider: 'deepseek-official' },
    expectedBaseURL: expected,
    keyConfigured: true,
  });
  assert.equal(ready.configured, true);
  assert.equal(ready.reason, '');

  const noEndpoint = deriveWebSearchStatus({
    section: { apiKeyEnv: 'DEEPSEEK_API_KEY' },
    webSection: undefined,
    expectedBaseURL: expected,
    keyConfigured: true,
  });
  assert.equal(noEndpoint.configured, false);
  assert.equal(noEndpoint.reason, 'endpoint');

  const noKey = deriveWebSearchStatus({
    section: { baseURL: expected, apiKeyEnv: SEARCH_KEY_REF },
    expectedBaseURL: expected,
    keyConfigured: false,
  });
  assert.equal(noKey.configured, false);
  assert.equal(noKey.reason, 'key');

  const wrongProvider = deriveWebSearchStatus({
    section: { baseURL: expected, apiKeyEnv: SEARCH_KEY_REF },
    webSection: { searchProvider: 'deepseek-search-api' },
    expectedBaseURL: expected,
    keyConfigured: true,
  });
  assert.equal(wrongProvider.configured, false);
  assert.equal(wrongProvider.reason, 'provider');

  // rc.6 没有 web 分节：沿用 bundle patch 的 deepseek-official，不能误判
  const noWebSection = deriveWebSearchStatus({
    section: { baseURL: expected, apiKeyEnv: SEARCH_KEY_REF },
    webSection: undefined,
    expectedBaseURL: expected,
    keyConfigured: true,
  });
  assert.equal(noWebSection.configured, true);
  assert.equal(noWebSection.providerSelected, true);
});

test('状态合并：配置对了但桥没跑/令牌变了，不能算 ready', () => {
  const expected = 'http://127.0.0.1:8790/v1';
  const status = deriveWebSearchStatus({
    section: { baseURL: expected, apiKeyEnv: SEARCH_KEY_REF },
    expectedBaseURL: expected,
    keyConfigured: true,
  });
  assert.equal(status.configured, true);

  const bridgeDown = deriveWebSearchReadiness({ status, bridgeState: 'stopped', tokenMatches: true });
  assert.equal(bridgeDown.ready, false);
  assert.equal(bridgeDown.reason, 'bridge');

  const staleToken = deriveWebSearchReadiness({ status, bridgeState: 'running', tokenMatches: false });
  assert.equal(staleToken.ready, false);
  assert.equal(staleToken.reason, 'token');

  const authIssue = deriveWebSearchReadiness({ status, bridgeState: 'degraded', tokenMatches: true });
  assert.equal(authIssue.ready, false);
  assert.equal(authIssue.reason, 'bridge-auth', '桥在跑但登录坏了，不能说成桥未运行');

  const conflict = deriveWebSearchReadiness({ status, bridgeState: 'unauthorized', tokenMatches: true });
  assert.equal(conflict.ready, false);
  assert.equal(conflict.reason, 'bridge-conflict');

  const ready = deriveWebSearchReadiness({ status, bridgeState: 'running', tokenMatches: true });
  assert.equal(ready.ready, true);
  assert.equal(ready.reason, '');
});

test('状态合并：自检失败/地址变化会保留证据但标记失效', () => {
  const expected = 'http://127.0.0.1:8790/v1';
  const status = { configured: true, reason: '' };
  const failed = deriveWebSearchReadiness({
    status,
    bridgeState: 'running',
    tokenMatches: true,
    expectedBaseURL: expected,
    verification: {
      at: Date.now(),
      verified: false,
      sourceCount: 0,
      error: 'WEB_SEARCH_UPSTREAM',
      baseURL: expected,
    },
  });
  assert.equal(failed.ready, true, '配置/桥/令牌都对，ready 仍为真；失败通过自检证据表达');
  assert.equal(failed.lastVerifyFailed, true);
  assert.equal(failed.lastVerifyError, 'WEB_SEARCH_UPSTREAM');

  const stale = deriveWebSearchReadiness({
    status,
    bridgeState: 'running',
    tokenMatches: true,
    expectedBaseURL: 'http://127.0.0.1:8791/v1',
    verification: {
      at: Date.now(),
      verified: true,
      sourceCount: 2,
      baseURL: expected,
    },
  });
  assert.equal(stale.lastVerifyStale, true);
  assert.equal(stale.lastVerifyFailed, false, '失效的旧结果不能继续当成失败');
});

test('可撤销：快照保留旧分节与旧凭据，summary 不含令牌，恢复能逐项还原', async () => {
  const oldSection = {
    baseURL: 'https://api.deepseek.com/v1',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    apiKey: 'old-literal',
  };
  const oldWeb = { searchProvider: 'custom-provider' };
  const sections = { 'web-search-deepseek': oldSection, web: oldWeb };
  const settings = {
    get(ns) { return sections[ns]; },
    async replace(ns, section) { sections[ns] = { ...section }; },
  };
  const store = new Map([[SEARCH_KEY_REF, 'old-bridge-token']]);
  const credentials = {
    async resolve(ref) { return store.has(ref) ? { value: store.get(ref) } : undefined; },
    async set(ref, value) { store.set(ref, value); },
    async unset(ref) { store.delete(ref); },
  };

  const snapshot = await snapshotWorkBuddyWebSearch({ settings, credentials });
  assert.equal(snapshot.ok, true);
  assert.deepEqual(snapshot.section, oldSection);
  assert.deepEqual(snapshot.webSection, oldWeb);
  assert.equal(snapshot.credential, 'old-bridge-token');
  assert.equal(JSON.stringify(snapshot.summary).includes('old-bridge-token'), false,
    '对外 summary 不能包含令牌');
  assert.equal(snapshot.summary.hadLiteralKey, true);

  await restoreWorkBuddyWebSearch({ settings, credentials, snapshot });
  assert.deepEqual(sections['web-search-deepseek'], oldSection);
  assert.deepEqual(sections.web, oldWeb);
  assert.equal(store.get(SEARCH_KEY_REF), 'old-bridge-token');
});

test('可撤销：原来没有桥令牌时，恢复会 unset 而不是写空值', async () => {
  const oldSection = { baseURL: 'https://api.deepseek.com/v1', apiKeyEnv: 'DEEPSEEK_API_KEY' };
  const sections = { 'web-search-deepseek': oldSection };
  const settings = {
    get(ns) { return sections[ns]; },
    async replace(ns, section) { sections[ns] = { ...section }; },
  };
  const store = new Map();
  let unsetRef = '';
  const credentials = {
    async resolve() { return undefined; },
    async set(ref, value) { store.set(ref, value); },
    async unset(ref) { unsetRef = ref; store.delete(ref); },
  };

  const snapshot = await snapshotWorkBuddyWebSearch({ settings, credentials });
  assert.equal(snapshot.ok, true);
  assert.deepEqual(snapshot.section, oldSection);
  assert.equal(snapshot.credential, null);
  await restoreWorkBuddyWebSearch({ settings, credentials, snapshot });
  assert.equal(unsetRef, SEARCH_KEY_REF);
  assert.equal(store.has(SEARCH_KEY_REF), false);
  assert.deepEqual(sections['web-search-deepseek'], oldSection);
});

test('可撤销：优先快照 user 层，不把 base/default 里的密钥固化进用户配置', async () => {
  const settings = {
    describe() {
      return [
        { ns: 'web-search-deepseek', user: { baseURL: 'https://api.deepseek.com/v1', apiKeyEnv: 'DEEPSEEK_API_KEY' } },
        { ns: 'web', user: undefined },
      ];
    },
    get() { throw new Error('有 describe 时不应依赖解析后的 get 值'); },
    async replace() {},
  };
  const credentials = {
    async resolve() { return undefined; },
    async set() {},
    async unset() {},
  };
  const snapshot = await snapshotWorkBuddyWebSearch({ settings, credentials });
  assert.equal(snapshot.ok, true);
  assert.deepEqual(snapshot.section, {
    baseURL: 'https://api.deepseek.com/v1',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
  }, '不能把 base 里的 apiKey 写进快照');
  assert.deepEqual(snapshot.webSection, {}, 'web 分节存在但无 user 覆盖时也要能恢复为空');
});

test('可撤销：分节不存在时不提供恢复（避免向未注册 namespace 写入）', async () => {
  const snapshot = await snapshotWorkBuddyWebSearch({
    settings: {
      get() { return undefined; },
      async replace() {},
    },
    credentials: {
      async resolve() { return undefined; },
      async set() {},
      async unset() {},
    },
  });
  assert.equal(snapshot.ok, false);
});

test('自检：走 dsh web 服务搜一次，成功/失败/缺失三种结果分明', async () => {
  let request;
  const ok = await verifyWorkBuddyWebSearch({
    web: {
      async search(req) { request = req; return { sources: [{ url: 'https://example.com' }] }; },
    },
  });
  assert.deepEqual(request, { query: 'WorkBuddy', maxResults: 1 });
  assert.deepEqual(ok, { verified: true, sourceCount: 1 });

  const failed = await verifyWorkBuddyWebSearch({
    web: { async search() { throw new Error('WEB_PROVIDER_CONFIGURED_UNAVAILABLE'); } },
  });
  assert.equal(failed.verified, false);
  assert.match(failed.verifyError, /CONFIGURED_UNAVAILABLE/);

  const empty = await verifyWorkBuddyWebSearch({
    web: { async search() { return { sources: [] }; } },
  });
  assert.equal(empty.verified, false, '0 来源不能算自检通过');
  assert.equal(empty.sourceCount, 0);

  assert.deepEqual(await verifyWorkBuddyWebSearch({ web: undefined }), { verified: null });
});

test('自检：超时会被 abort 并按失败返回', async () => {
  const result = await verifyWorkBuddyWebSearch({
    web: {
      search(_req, signal) {
        return new Promise((_, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      },
    },
    timeoutMs: 20,
  });
  assert.equal(result.verified, false);
  assert.match(result.verifyError, /timed out/i);
});
