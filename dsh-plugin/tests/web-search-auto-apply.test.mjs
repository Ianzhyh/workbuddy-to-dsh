/**
 * 自动接入的端到端装配测试（issue #7）。
 *
 * 起一个真实的本地 HTTP 假桥，配一套按 dsh SettingsProvider 语义写的假
 * settings/credentials/web，然后走真实 `apply()`：
 *   1. 桥在跑 + 用户没配过搜索 → 启动后自动写入桥地址与独立凭据引用；
 *   2. 自检通过 → state.webSearchAuto=done；
 *   3. 面板「恢复接入前配置」→ 摘掉桥地址/凭据引用，并留下退出自动接入的标记。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { apply } from '../lib/index.js';
import { bridgeBuildHash } from '../lib/bridge.mjs';
import { SEARCH_KEY_REF } from '../lib/web-search-config.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeSettings({ describeOnly = false } = {}) {
  const sections = {
    'web-search-deepseek': {},
    web: {},
  };
  const listeners = [];
  const settings = {
    sections,
    calls: [],
    ...(describeOnly ? {} : {
      get(ns) {
        return Object.hasOwn(sections, ns) ? { ...sections[ns] } : undefined;
      },
    }),
    // 真实 dsh 的 settings 服务就是这个形状：describe() 同时给 value 与 user，
    // 没有 get(ns)。测试默认保留 get 是兼容旧宿主，describeOnly 模拟当前宿主。
    describe() {
      return Object.entries(sections).map(([ns, section]) => ({
        ns,
        value: { ...section },
        user: { ...section },
      }));
    },
    async update(ns, patch) {
      if (!Object.hasOwn(sections, ns)) throw new Error(`settings namespace "${ns}" is not registered`);
      settings.calls.push({ ns, patch });
      sections[ns] = { ...sections[ns], ...patch };
      for (const fn of listeners) fn(ns);
    },
    async replace(ns, section) {
      if (!Object.hasOwn(sections, ns)) throw new Error(`settings namespace "${ns}" is not registered`);
      settings.calls.push({ ns, replace: section });
      sections[ns] = { ...section };
      for (const fn of listeners) fn(ns);
    },
  };
  return settings;
}

function makeCredentials() {
  const store = new Map();
  return {
    store,
    async set(ref, value) { store.set(ref, value); },
    async unset(ref) { store.delete(ref); },
    async describe(ref) { return { configured: store.has(ref) }; },
    async resolve(ref) { return store.has(ref) ? { value: store.get(ref) } : undefined; },
  };
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
    get(name) {
      return services[name];
    },
    effect(fn) { return fn(); },
    provide() { return () => {}; },
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

/** 起一个只回答 /health 的假桥；返回端口与关闭函数。 */
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
        auth: { userId: 'u-test', expiresAt: new Date(Date.now() + 3600_000).toISOString() },
        credential: { desktop: { available: true } },
      }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('apply()：桥在跑且用户没配过 → 自动接入；恢复后关闭自动接入（describe-only 宿主）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-auto-search-'));
  let server;
  try {
    mkdirSync(join(dir, 'bridge'), { recursive: true });
    const script = join(dir, 'bridge', 'workbuddy-bridge.mjs');
    writeFileSync(script, '// fake bridge placeholder for build hash\n');
    const build = bridgeBuildHash(script);

    server = createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          ok: true,
          pid: process.pid,
          uptimeMs: 1000,
          build,
          catalogSize: 0,
          auth: { userId: 'u-test', expiresAt: new Date(Date.now() + 3600_000).toISOString() },
          credential: { desktop: { available: true } },
        }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    const settings = makeSettings({ describeOnly: true });
    const credentials = makeCredentials();
    let webSearchCalls = 0;
    const routes = [];
    const services = {
      settings,
      credentials,
      web: {
        async search() {
          webSearchCalls += 1;
          return { sources: [{ url: 'https://example.com/search' }] };
        },
      },
      tools: { register: () => () => {} },
      commands: { register: () => () => {} },
      webServer: { register: (route) => { routes.push(route); return () => {}; } },
    };
    const logs = [];
    const ctx = fakeCtx(services, logs);

    const result = apply(ctx, {
      projectRoot: dir,
      bridgeHost: '127.0.0.1',
      bridgePort: port,
      localToken: 'auto-search-token',
      autoStart: false,
      autoWebSearch: true,
      consoleAutoStart: false,
      migrateLegacy: false,
    });

    const done = await waitFor(() => result.state.webSearchAuto.status === 'done'
      || result.state.webSearchAuto.status === 'failed');
    assert.equal(done, true, `自动接入没有结束：${JSON.stringify(result.state.webSearchAuto)}\n${logs.join('\n')}`);
    assert.equal(result.state.webSearchAuto.status, 'done', logs.join('\n'));
    assert.equal(result.state.webSearchAuto.mode, 'auto');
    assert.equal(webSearchCalls, 1, '自检必须真的走一次 dsh web 服务');

    assert.equal(settings.sections['web-search-deepseek'].baseURL, `http://127.0.0.1:${port}/v1`);
    assert.equal(settings.sections['web-search-deepseek'].apiKeyEnv, SEARCH_KEY_REF);
    assert.equal(settings.sections.web.searchProvider, 'deepseek-official');
    assert.equal(credentials.store.get(SEARCH_KEY_REF), 'auto-search-token');

    assert.equal(result.state.webSearchAuto.status, 'done');
    assert.ok(settings.describe().find((item) => item.ns === 'web-search-deepseek'));

    // 走真实面板路由恢复：需要面板头
    const revertRoute = routes.find((route) => route.path === '/workbuddy/web-search/revert');
    assert.ok(revertRoute, '没有注册恢复路由');
    let responseStatus = 0;
    let raw = '';
    const res = {
      writeHead(code) { responseStatus = code; },
      write(chunk) { raw += String(chunk); },
      end(body) { if (body) raw += String(body); },
      on() {}, off() {},
    };
    await revertRoute.handler({
      url: '/workbuddy/web-search/revert',
      method: 'POST',
      headers: { 'x-workbuddy-panel': '1' },
    }, res);
    assert.equal(responseStatus, 200, raw);
    assert.equal(JSON.parse(raw).ok, true);

    assert.deepEqual(settings.sections['web-search-deepseek'], {},
      '必须摘掉插件写的 baseURL / 独立凭据引用');
    assert.deepEqual(settings.sections.web, { searchProvider: 'deepseek-official' },
      '必须留下显式选择标记，避免下次启动又自动接入');
    assert.equal(credentials.store.has(SEARCH_KEY_REF), false, '独立凭据引用应当被清理');
    assert.equal(result.state.webSearchAuto.status, 'opted-out');
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('apply()：用户显式配置过搜索 → 自动接入不覆盖', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-auto-explicit-'));
  let bridge;
  try {
    bridge = await startFakeBridge(dir);
    const settings = makeSettings();
    settings.sections['web-search-deepseek'] = {
      baseURL: 'https://api.deepseek.com/anthropic/v1',
      apiKeyEnv: 'MY_DEEPSEEK_KEY',
    };
    const credentials = makeCredentials();
    const services = {
      settings,
      credentials,
      web: { async search() { return { sources: [{ url: 'https://example.com' }] }; } },
      tools: { register: () => () => {} },
      commands: { register: () => () => {} },
      webServer: { register: () => () => {} },
    };
    const logs = [];
    const result = apply(fakeCtx(services, logs), {
      projectRoot: dir,
      bridgeHost: '127.0.0.1',
      bridgePort: bridge.port,
      localToken: 'new-token',
      autoStart: false,
      autoWebSearch: true,
      consoleAutoStart: false,
      migrateLegacy: false,
    });

    const settled = await waitFor(() => result.state.webSearchAuto.status === 'skipped'
      || result.state.webSearchAuto.status === 'failed');
    assert.equal(settled, true, logs.join('\n'));
    assert.equal(result.state.webSearchAuto.status, 'skipped', logs.join('\n'));
    assert.equal(result.state.webSearchAuto.reason, 'explicit');
    assert.deepEqual(settings.sections['web-search-deepseek'], {
      baseURL: 'https://api.deepseek.com/anthropic/v1',
      apiKeyEnv: 'MY_DEEPSEEK_KEY',
    }, '用户显式配置必须原样保留');
    assert.deepEqual(settings.sections.web, {}, '不能写 provider 选择');
    assert.deepEqual(settings.calls, [], '跳过时不能写任何配置');
    assert.equal(credentials.store.size, 0, '跳过时不能创建桥凭据');
  } finally {
    if (bridge) await bridge.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('apply()：桥端口/令牌漂移 → 自动自愈，保留用户的其它搜索字段', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-auto-heal-'));
  let bridge;
  try {
    bridge = await startFakeBridge(dir);
    const settings = makeSettings();
    settings.sections['web-search-deepseek'] = {
      baseURL: 'http://127.0.0.1:1/v1',
      apiKeyEnv: SEARCH_KEY_REF,
      maxUses: 3,
    };
    const credentials = makeCredentials();
    credentials.store.set(SEARCH_KEY_REF, 'old-token');
    const services = {
      settings,
      credentials,
      web: { async search() { return { sources: [{ url: 'https://example.com' }] }; } },
      tools: { register: () => () => {} },
      commands: { register: () => () => {} },
      webServer: { register: () => () => {} },
    };
    const logs = [];
    const result = apply(fakeCtx(services, logs), {
      projectRoot: dir,
      bridgeHost: '127.0.0.1',
      bridgePort: bridge.port,
      localToken: 'new-token',
      autoStart: false,
      autoWebSearch: true,
      consoleAutoStart: false,
      migrateLegacy: false,
    });

    const healed = await waitFor(() => result.state.webSearchAuto.status === 'done'
      || result.state.webSearchAuto.status === 'failed');
    assert.equal(healed, true, logs.join('\n'));
    assert.equal(result.state.webSearchAuto.status, 'done', logs.join('\n'));
    assert.equal(result.state.webSearchAuto.reason, 'heal');
    assert.equal(settings.sections['web-search-deepseek'].baseURL, `http://127.0.0.1:${bridge.port}/v1`);
    assert.equal(settings.sections['web-search-deepseek'].apiKeyEnv, SEARCH_KEY_REF);
    assert.equal(settings.sections['web-search-deepseek'].maxUses, 3, '不能丢掉用户的调参');
    assert.equal(credentials.store.get(SEARCH_KEY_REF), 'new-token');
  } finally {
    if (bridge) await bridge.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
