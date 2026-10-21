import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  configureWorkBuddyWebSearch,
  deriveWebSearchStatus,
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
