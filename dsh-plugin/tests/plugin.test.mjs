/**
 * 旧路由文本手术的自测 + 插件装配冒烟测试（都不碰真实文件、不启桥）。
 *
 *   node --test dsh-plugin/tests/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { locateProviderBlock, stripProviderBlock, cleanFile, detectInFile } from '../lib/legacy.mjs';
import { resolveConfig, detectProjectRoot, apply, readProjectEnv, DEFAULTS } from '../lib/index.js';
import { BridgeSupervisor } from '../lib/bridge.mjs';

/** 真实插件目录（测试里要用它当"源"来造分发布的副本）。 */
const PLUGIN_ROOT = fileURLToPath(new URL('..', import.meta.url));

test('数据面的方法 / 权限矩阵：只读路由拒绝写方法，写路由要求面板头', async () => {
  const { createRouteTable } = await import('../lib/routes.mjs');
  const routes = createRouteTable({
    snapshot: async () => ({ bridge: { state: 'running' } }),
    supervisor: { readLog: () => ({ lines: [] }), probe: async () => ({ state: 'running' }), ensure: async () => ({ ok: true }), stop: async () => ({ ok: true }) },
    consoleSupervisor: { probe: async () => ({ state: 'running' }), ensure: async () => ({ ok: true }), stop: async () => ({ ok: true }), url: 'http://127.0.0.1:8792', spawnedPid: null },
    client: { checkin: async () => ({ status: {} }), clearUsage: async () => ({ ok: true }), usage: async () => ({}), requests: async () => ({}), quota: async () => ({}) },
    adapter: { catalogCache: { at: Date.now(), models: [] }, catalogError: '', catalog: async () => [], invalidate() {} },
    paths: { settingsPath: 'x', patchPath: 'y' },
    provider: 'workbuddy',
    log: () => {},
  });
  const byPath = (p) => routes.find((r) => r.path === p);

  /** 跑一次路由，返回 {status, body}。url 允许带查询串（真实 req.url 就带）。 */
  const run = async (url, method, headers = {}) => {
    const route = byPath(url.split('?')[0]);
    assert.ok(route, `没有找到路由 ${url}`);
    let status = 0;
    let raw = '';
    const res = {
      writeHead(code) { status = code; },
      write(chunk) { raw += String(chunk); },
      end(body) { if (body) raw += String(body); },
      on() {}, off() {},
    };
    await route.handler({ url, method, headers }, res);
    let body = null;
    try { body = JSON.parse(raw); } catch { body = raw; }
    return { status, body };
  };

  // 只读路由：GET 正常，PUT/PATCH/DELETE 一律 405
  for (const path of ['/workbuddy/status', '/workbuddy/models', '/workbuddy/requests', '/workbuddy/migrate', '/workbuddy/console', '/workbuddy/quota']) {
    const get = await run(path, 'GET');
    assert.equal(get.status, 200, `${path} GET 应当 200`);
    for (const method of ['PUT', 'PATCH', 'DELETE']) {
      const res = await run(path, method);
      assert.equal(res.status, 405, `${path} ${method} 应当是 405（只读路由不接受写方法）`);
    }
  }

  // 写路由：没有面板头一律 403；带上正确头才放行
  const writes = [
    ['/workbuddy/bridge', 'POST'],
    ['/workbuddy/console', 'POST'],
    ['/workbuddy/migrate', 'POST'],
    ['/workbuddy/quota', 'POST'],
    ['/workbuddy/usage', 'DELETE'],
    ['/workbuddy/log', 'DELETE'],
  ];
  for (const [path, method] of writes) {
    const blocked = await run(path, method);
    assert.equal(blocked.status, 403, `${method} ${path} 缺面板头应当 403`);
    assert.match(String(blocked.body?.error || ''), /x-workbuddy-panel/);
  }
  // 头不对（值不是 1）同样拒绝
  const wrongHeader = await run('/workbuddy/bridge', 'POST', { 'x-workbuddy-panel': 'true' });
  assert.equal(wrongHeader.status, 403);

  // 签到：GET 读、POST 领取要走面板头、其它方法 405
  assert.equal((await run('/workbuddy/checkin', 'GET')).status, 200);
  assert.equal((await run('/workbuddy/checkin', 'DELETE')).status, 405);
  const claimWithoutHeader = await run('/workbuddy/checkin?claim=1', 'POST');
  assert.equal(claimWithoutHeader.status, 403, '领取是写操作，缺面板头必须拒绝');
  const claimWithHeader = await run('/workbuddy/checkin?claim=1', 'POST', { 'x-workbuddy-panel': '1' });
  assert.equal(claimWithHeader.status, 200);
});

test('readLog 只读日志尾部：大文件不吃满内存、截断的半行被丢掉', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-log-'));
  try {
    const logPath = join(dir, 'bridge.log');
    // 造一个 > maxBytes 的日志：每行定长，方便断言首尾
    const line = (i) => `line-${String(i).padStart(6, '0')}-${'x'.repeat(40)}`;
    const total = 4000;
    writeFileSync(logPath, Array.from({ length: total }, (_, i) => line(i)).join('\n') + '\n');

    const supervisor = new BridgeSupervisor({ logPath, scriptPath: join(dir, 'nope.mjs'), projectRoot: dir });
    const tail = supervisor.readLog({ lines: 5, maxBytes: 2048 });
    assert.equal(tail.lines.length, 5, '行数应当被 lines 截断');
    assert.equal(tail.lines[4], line(total - 1), '最后一行必须是文件真正的最后一行');
    assert.deepEqual(tail.lines, [line(total - 5), line(total - 4), line(total - 3), line(total - 2), line(total - 1)]);
    assert.ok(!tail.lines.some((l) => l.includes('line-0000')), '不许把整个文件都读回来');
    assert.equal(tail.size, Buffer.byteLength(Array.from({ length: total }, (_, i) => line(i)).join('\n') + '\n'));

    // 单行超过 maxBytes：不该返回半行（宁可为空，也不给半个 JSON）
    const oneLong = join(dir, 'one.log');
    writeFileSync(oneLong, 'A'.repeat(5000) + '\n' + '短行\n');
    const tail2 = new BridgeSupervisor({ logPath: oneLong, scriptPath: 'x', projectRoot: dir }).readLog({ lines: 10, maxBytes: 1024 });
    assert.deepEqual(tail2.lines, ['短行'], '被截断的长行应当被丢弃，只留完整行');

    // 文件不存在：给空结果而不是抛
    const missing = new BridgeSupervisor({ logPath: join(dir, 'missing.log'), scriptPath: 'x', projectRoot: dir }).readLog({});
    assert.deepEqual(missing.lines, []);
    assert.equal(missing.size, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const SETTINGS = `# DeepSeek Harness 用户设置文档
llm-pi-ai:
  providers:
    workbuddy:
      displayName: WorkBuddy
      apiKeyEnv: WORKBUDDY_BRIDGE_KEY
      baseURL: http://127.0.0.1:8790/v1
      models:
        - id: hy3
          name: "Hy3"
    other-provider:
      displayName: Other
      baseURL: https://example.invalid/v1
`;

const PATCH = `- id: ui-theme
  name: "@deepseek-ai/dsh-client-ui-theme"
  config:
    preference: system
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      workbuddy:
        displayName: WorkBuddy
        baseURL: http://127.0.0.1:8790/v1
      keep-me:
        displayName: Keep
- id: workbuddy
  name: dsh-plugin-workbuddy
`;

test('locateProviderBlock 只框住 providers.workbuddy 这一段', () => {
  const hit = locateProviderBlock(SETTINGS, 'workbuddy');
  assert.ok(hit);
  const lines = SETTINGS.split('\n');
  assert.match(lines[hit.start], /^\s{4}workbuddy:$/);
  assert.match(lines[hit.end], /^\s{4}other-provider:$/);
});

test('stripProviderBlock 删除 workbuddy，保留其它 provider 与注释', () => {
  const { changed, text } = stripProviderBlock(SETTINGS, 'workbuddy');
  assert.equal(changed, true);
  assert.doesNotMatch(text, /workbuddy:/);
  assert.match(text, /# DeepSeek Harness 用户设置文档/);
  assert.match(text, /other-provider:/);
  assert.match(text, /displayName: Other/);
  // 另一条 route 不受影响
  assert.match(text, /llm-pi-ai:/);
});

test('stripProviderBlock 处理 patch 层（列表条目缩进）', () => {
  const { changed, text } = stripProviderBlock(PATCH, 'workbuddy');
  assert.equal(changed, true);
  assert.doesNotMatch(text, /^\s+workbuddy:$/m);
  assert.match(text, /keep-me:/);
  assert.match(text, /- id: ui-theme/);
  assert.match(text, /- id: workbuddy\n  name: dsh-plugin-workbuddy/);
});

test('providers 被清空时改写成 providers: {}（避免 YAML null）', () => {
  const only = `llm-pi-ai:\n  providers:\n    workbuddy:\n      displayName: WorkBuddy\n`;
  const { text } = stripProviderBlock(only, 'workbuddy');
  assert.match(text, /providers: \{\}/);
  assert.doesNotMatch(text, /workbuddy/);
});

test('没有旧路由时不动文件，也不报"已改"', () => {
  const clean = `llm-pi-ai:\n  providers:\n    keep:\n      displayName: Keep\n`;
  const { changed, text } = stripProviderBlock(clean, 'workbuddy');
  assert.equal(changed, false);
  assert.equal(text, clean);
});

test('cleanFile 先备份再写，备份内容与原文一致', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-legacy-'));
  try {
    const file = join(dir, 'settings.yaml');
    writeFileSync(file, SETTINGS, 'utf8');
    const result = cleanFile(file, { provider: 'workbuddy' });
    assert.equal(result.changed, true);
    assert.ok(existsSync(result.backup));
    assert.equal(readFileSync(result.backup, 'utf8'), SETTINGS);
    assert.doesNotMatch(readFileSync(file, 'utf8'), /workbuddy:/);
    // 再跑一次：已经干净，不应重复改动
    const again = cleanFile(file, { provider: 'workbuddy' });
    assert.equal(again.changed, false);
    assert.equal(again.reason, 'no-legacy-route');
    assert.equal(detectInFile(file, 'workbuddy').found, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('resolveConfig 合默认值并做类型收敛', () => {
  const cfg = resolveConfig({ bridgePort: '9999', autoStart: '0', modelAllow: 'a, b', migrateLegacy: false });
  assert.equal(cfg.bridgePort, 9999);
  assert.equal(cfg.autoStart, false);
  assert.deepEqual(cfg.modelAllow, ['a', 'b']);
  assert.equal(cfg.migrateLegacy, false);
  assert.equal(cfg.provider, DEFAULTS.provider);
  assert.equal(cfg.displayName, 'WorkBuddy');
});

test('detectProjectRoot 能从插件目录上溯找到项目根', () => {
  const root = detectProjectRoot('');
  assert.ok(root, '应该找到 workbuddy-to-dsh 检出目录');
  assert.ok(existsSync(join(root, 'bridge', 'workbuddy-bridge.mjs')));
});

/** 一个足够像 cordis 的假 ctx：记录注册了什么，验证装配而不需要真实 dsh。 */
function fakeCtx() {
  const calls = { adapters: [], tools: [], commands: [], routes: [], effects: [], provides: [] };
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    llm: {
      registerAdapter(providers, adapter) {
        calls.adapters.push({ providers, adapter });
        const handle = () => {};
        handle.replace = () => {};
        return handle;
      },
    },
    get(name) {
      if (name === 'tools') return { register: (d) => { calls.tools.push(d); return () => {}; } };
      if (name === 'commands') return { register: (d) => { calls.commands.push(d); return () => {}; } };
      if (name === 'webServer') return { register: (r) => { calls.routes.push(r); return () => {}; } };
      return undefined;
    },
    effect(fn, label) { calls.effects.push(label); const dispose = fn(); return dispose; },
    provide(name, value) { calls.provides.push({ name, value }); return () => {}; },
  };
  return { ctx, calls };
}

test('换账号后积分/签到缓存必须作废（回归：面板把 A 账号积分挂在 B 账号头上）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-account-'));
  try {
    const { ctx } = fakeCtx();
    const result = apply(ctx, { projectRoot: dir, autoStart: false, consoleAutoStart: false, migrateLegacy: false });
    const { state, snapshot } = result;

    // 桩：probe 返回的 userId 由外部变量控制 —— **模拟真实换号**：
    // 桥重启后 health 报新 userId，插件靠自己对比发现"账号变了"。
    // （不许手动改 state.bridgeAccount —— 那等于替插件作弊，把变化掩盖了。）
    let currentAccount = 'A';
    result.supervisor.probe = async () => ({
      state: 'running',
      health: { auth: { userId: currentAccount, expiresAt: new Date(Date.now() + 864e5).toISOString() } },
    });

    // 桩：quota/checkin 也打桩 —— **不能依赖真实桥**（CI 上没有桥在跑，
    // 之前本地能过只是因为 8790 上恰好有一个）。返回值随账号变化，
    // 顺带验证"换号后必须重新调上游，不能吃旧缓存"。
    let quotaCalls = 0;
    let checkinCalls = 0;
    result.client.quota = async () => { quotaCalls += 1; return { ok: true, total: currentAccount === 'A' ? 111 : 222, packages: [] }; };
    result.client.checkin = async () => { checkinCalls += 1; return { ok: true, status: { todayCheckedIn: false, streakDays: 1 }, auto: { auto: false } }; };

    // ── 第一幕：账号 A，正常取一次积分与签到
    // 预置一份模型目录：第三幕要断言"换号后目录被作废"
    result.adapter.catalogCache = { at: Date.now(), models: [{ id: 'm-from-A' }] };
    const snapA = await snapshot({});
    assert.ok(snapA.quota, '账号 A 应当有积分缓存');
    assert.equal(state.quotaCache.account, 'A', '积分缓存必须打上账号 A 的标记');
    // 签到刷新是后台异步的：等它落盘再断言
    await state.checkinInflight;
    assert.equal(state.checkinCache.account, 'A', '签到缓存必须打上账号 A 的标记');
    const quotaA = snapA.quota;

    // ── 第二幕：切到账号 B（只改桥报告的身份，让插件自己发现变化）
    currentAccount = 'B';
    // TTL 内再取快照：换号后**不许**继续用 A 的缓存值
    const snapB = await snapshot({});
    await state.checkinInflight;
    assert.equal(snapB.quota?.total, 222, `换账号后积分必须换新（B=222），实际 ${snapB.quota?.total}`);
    assert.equal(state.quotaCache.account, 'B', '新缓存必须标记为账号 B');
    assert.equal(state.checkinCache.account, 'B', '签到缓存也必须换到账号 B 名下');

    // ── 第三幕：模型目录同样属于账号视角 —— reconcile 必须把目录作废
    // （adapter.invalidate 会把 catalogCache 清空，下一次目录读取自然从桥重取）
    assert.equal(result.adapter.catalogCache.models.length, 0, '换号后模型目录必须已作废（等下一次从桥重取）');

    // ── 第四幕：bridgeAccount 为 null（旧桥/探测不完整）时**不许**误清有效缓存
    result.supervisor.probe = async () => ({ state: 'running', health: { auth: {} } });
    const beforeNull = { quota: state.quotaCache.value, checkin: state.checkinCache.value };
    await snapshot({});
    assert.equal(state.quotaCache.value, beforeNull.quota, '拿不到账号身份时不能清掉积分缓存');
    assert.equal(state.checkinCache.value, beforeNull.checkin, '拿不到账号身份时不能清掉签到缓存');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('apply() 装配：注册 llm 路由、5 个工具、命令、HTTP 路由', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-apply-'));
  try {
    const { ctx, calls } = fakeCtx();
    // 用一个空目录当 projectRoot（桥/控制台脚本都不存在）：不自动启任何进程，只验证装配
    const result = apply(ctx, { projectRoot: dir, autoStart: false, consoleAutoStart: false, migrateLegacy: false });
    assert.equal(calls.adapters.length, 1);
    assert.deepEqual(calls.adapters[0].providers, ['workbuddy']);
    assert.equal(calls.adapters[0].adapter.providerInfo('workbuddy').name, 'WorkBuddy');
    assert.equal(calls.tools.length, 5);
    assert.deepEqual(calls.tools.map((t) => t.name).sort(), [
      'workbuddy_bridge', 'workbuddy_checkin', 'workbuddy_models', 'workbuddy_status', 'workbuddy_usage',
    ]);
    for (const tool of calls.tools) {
      assert.equal(typeof tool.execute, 'function');
      assert.equal(typeof tool.output.render, 'function');
      assert.ok(tool.parameters && tool.parameters.type === 'object');
    }
    assert.equal(calls.commands.length, 1);
    assert.equal(calls.commands[0].name, 'workbuddy');
    assert.equal(calls.routes.length, 12, 'HTTP 数据面应有 12 条路由（11 条 exact + 1 条 console-api 前缀）');
    assert.deepEqual(calls.routes.map((r) => r.path).sort(), [
      '/workbuddy/bridge', '/workbuddy/checkin', '/workbuddy/console', '/workbuddy/console-api', '/workbuddy/log',
      '/workbuddy/migrate', '/workbuddy/model-visibility', '/workbuddy/models', '/workbuddy/quota', '/workbuddy/requests', '/workbuddy/status', '/workbuddy/usage',
    ]);
    const prefix = calls.routes.find((r) => r.path === '/workbuddy/console-api');
    assert.equal(prefix.kind, 'prefix', 'console-api 必须挂成前缀路由');
    assert.equal(typeof prefix.handler, 'function');
    assert.equal(result.state.route.registered, true);
    assert.ok(result.consoleSupervisor, 'apply() 必须返回控制台管理器');
    assert.equal(result.consoleSupervisor.url, 'http://127.0.0.1:8792');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('apply() 遇到 DUPLICATE_ADAPTER 时退回兜底 provider', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-fallback-'));
  try {
    const calls = { providers: [] };
    const ctx = {
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      llm: {
        registerAdapter(providers) {
          calls.providers.push(providers[0]);
          if (providers[0] === 'workbuddy') {
            const error = new Error('an adapter for provider "workbuddy" is already registered');
            error.code = 'DUPLICATE_ADAPTER';
            throw error;
          }
          const handle = () => {};
          handle.replace = () => {};
          return handle;
        },
      },
      get() { return undefined; },
      effect(fn) { return fn(); },
    };
    const result = apply(ctx, { projectRoot: dir, autoStart: false, migrateLegacy: false, tools: false, commands: false, routes: false });
    await new Promise((r) => setTimeout(r, 3200));
    assert.ok(calls.providers.includes('workbuddy-native'), '应该用兜底 provider 再注册一次');
    assert.equal(result.state.route.registered, true);
    assert.equal(result.state.route.fallback, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('模型目录归一化：徽章从 tags 里拆出来（带颜色），厂商单字母保留为"标识"', async () => {
  const { toDirectory } = await import('../lib/models.mjs');
  const dir = toDirectory([
    {
      id: 'hy3', name: 'Hy3', context_window: 192000, max_output_tokens: 64000, supports_images: true,
      credits: 0, free: true, vendor: 'j', badge: '限时免费',
      tags: ['craft', 'badge:限时免费:#FF0000'], description_zh: '混元思考模型',
    },
    { id: 'glm-5.3', name: 'GLM-5.3', vendor: 'e', tags: ['craft'] },
  ]);
  const hy3 = dir.find((m) => m.id === 'hy3');
  assert.deepEqual(hy3.tags, ['craft'], 'tags 里不该再留着 badge: 规格（那是噪音）');
  assert.deepEqual(hy3.badges, [{ label: '限时免费', color: '#FF0000' }], '徽章要结构化并保住颜色');
  assert.equal(hy3.badge, '限时免费');
  assert.equal(hy3.vendor, 'j', '上游厂商代码原样保留（界面标注为"标识"）');
  assert.deepEqual(dir.find((m) => m.id === 'glm-5.3').badges, [], '没有徽章的模型给空数组而不是 undefined');
  assert.ok(!JSON.stringify(dir).includes('badge:'), '整个目录里都不该再出现 badge: 原始规格');
});

test('桥的健康检查：503 要认领成「凭据异常」，不能误判成"端口上是别人的服务"', async () => {
  const { createServer } = await import('node:http');
  const { BridgeSupervisor } = await import('../lib/bridge.mjs');

  /** 起一个假服务：默认回我们桥那种 503（登录读不出来），可切换成"别人的服务"。 */
  const startFake = async (body, status = 503, contentType = 'application/json') => {
    const server = createServer((req, res) => {
      res.writeHead(status, { 'content-type': contentType });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return { port: server.address().port, close: () => new Promise((r) => server.close(r)) };
  };

  // ① 我们的桥 + 登录坏了：503 + {ok:false, error, authFile}
  const ours = await startFake({
    ok: false,
    error: 'login file has no accessToken; sign in to the WorkBuddy desktop app first',
    authFile: 'C:\\auth\\workbuddy-desktop.info',
  });
  try {
    const sup = new BridgeSupervisor({ host: '127.0.0.1', port: ours.port, token: 't', projectRoot: '.', logPath: 'x' });
    const probe = await sup.probe();
    assert.equal(probe.state, 'degraded', '带 authFile 的 503 必须认领成本项目的桥（凭据异常）');
    assert.match(probe.error, /login file|sign in/i, '要把桥给的原因原样带出来');
    // ensure() 必须复用而不是再拉一个（否则撞端口）
    const ensured = await sup.ensure({ readyTimeoutMs: 500 });
    assert.equal(ensured.reused, true, '凭据异常时要复用这个桥');
    assert.equal(ensured.started, false, '不许因为健康检查不绿就再拉一个');
    assert.equal(ensured.state, 'degraded');
  } finally { await ours.close(); }

  // ② 真的不是我们的服务：503 + HTML（比如某个反向代理）
  const foreign = await startFake('<html><body>503 Service Unavailable</body></html>', 503, 'text/html');
  try {
    const sup = new BridgeSupervisor({ host: '127.0.0.1', port: foreign.port, token: 't', projectRoot: '.', logPath: 'x' });
    const probe = await sup.probe();
    assert.equal(probe.state, 'foreign', 'HTML 503 不能被当成自己的桥');
  } finally { await foreign.close(); }

  // ③ 令牌不符：401 → unauthorized
  const wrongToken = await startFake({ error: { message: 'bad or missing local token' } }, 401);
  try {
    const sup = new BridgeSupervisor({ host: '127.0.0.1', port: wrongToken.port, token: 't', projectRoot: '.', logPath: 'x' });
    assert.equal((await sup.probe()).state, 'unauthorized');
  } finally { await wrongToken.close(); }
});

test('分发形态：只有插件文件夹（自带 vendor）时也能定位到运行目录', async () => {
  const { cpSync } = await import('node:fs');
  const { pathToFileURL } = await import('node:url');
  const sandbox = mkdtempSync(join(tmpdir(), 'wb-standalone-'));
  try {
    // 造一个"别人拿到的样子"：<sandbox>/dsh-plugin（含 lib + vendor），父目录里没有仓库
    const pluginDir = join(sandbox, 'dsh-plugin');
    mkdirSync(pluginDir, { recursive: true });
    cpSync(join(PLUGIN_ROOT, 'lib'), join(pluginDir, 'lib'), { recursive: true });
    cpSync(join(PLUGIN_ROOT, 'vendor'), join(pluginDir, 'vendor'), { recursive: true });
    assert.ok(existsSync(join(pluginDir, 'vendor', 'bridge', 'workbuddy-bridge.mjs')), 'vendor 里必须有桥脚本');
    assert.ok(existsSync(join(pluginDir, 'vendor', 'dashboard', 'server.mjs')), 'vendor 里必须有控制台脚本');

    // 动态 import 一个"副本插件"：它的 PLUGIN_DIR 就是临时目录，能真实检验解析顺序
    const prevRoot = process.env.WORKBUDDY_ROOT;
    delete process.env.WORKBUDDY_ROOT;
    try {
      const mod = await import(pathToFileURL(join(pluginDir, 'lib', 'index.js')).href);
      const detected = mod.detectProjectRoot();
      assert.equal(detected, join(pluginDir, 'vendor'), '没有仓库时必须回落到插件自带的 vendor/');
      // 候选顺序：仓库位置排在 vendor 前面（本机开发优先用仓库）
      const kinds = mod.projectRootCandidates('').map((c) => c.kind);
      assert.ok(kinds.indexOf('repo') < kinds.indexOf('vendor'), '仓库检出目录必须优先于 vendor');
    } finally {
      if (prevRoot !== undefined) process.env.WORKBUDDY_ROOT = prevRoot;
    }
  } finally { rmSync(sandbox, { recursive: true, force: true }); }
});

test('分发形态：仓库在旁边时优先用仓库（不会被 vendor 快照盖住）', async () => {
  const { cpSync } = await import('node:fs');
  const { pathToFileURL } = await import('node:url');
  const sandbox = mkdtempSync(join(tmpdir(), 'wb-repo-'));
  try {
    // <sandbox>/bridge/... + <sandbox>/dsh-plugin/{lib,vendor} —— 两边都有桥，
    // 必须选仓库那份（否则本机改了 bridge 却不生效）
    mkdirSync(join(sandbox, 'bridge'), { recursive: true });
    writeFileSync(join(sandbox, 'bridge', 'workbuddy-bridge.mjs'), '// repo copy\n');
    const pluginDir = join(sandbox, 'dsh-plugin');
    mkdirSync(pluginDir, { recursive: true });
    cpSync(join(PLUGIN_ROOT, 'lib'), join(pluginDir, 'lib'), { recursive: true });
    cpSync(join(PLUGIN_ROOT, 'vendor'), join(pluginDir, 'vendor'), { recursive: true });

    const prevRoot = process.env.WORKBUDDY_ROOT;
    delete process.env.WORKBUDDY_ROOT;
    try {
      const mod = await import(pathToFileURL(join(pluginDir, 'lib', 'index.js')).href);
      assert.equal(mod.detectProjectRoot(), sandbox, '仓库检出目录优先于 vendor 快照');
    } finally {
      if (prevRoot !== undefined) process.env.WORKBUDDY_ROOT = prevRoot;
    }
  } finally { rmSync(sandbox, { recursive: true, force: true }); }
});

test('面板 /workbuddy/models 返回归一化目录（不是上游原始字段名）', async () => {
  const { createRouteTable } = await import('../lib/routes.mjs');
  const route = createRouteTable({
    snapshot: async () => ({}),
    supervisor: { readLog: () => ({ lines: [] }) },
    client: {},
    adapter: {
      catalogCache: { at: Date.now(), models: [] },
      catalogError: '',
      async catalog() {
        return [
          { id: 'm1', name: 'M One', context_window: 128000, max_output_tokens: 8192, credits: 0.5, supports_images: true, free: false },
        ];
      },
    },
    paths: { settingsPath: 'x', patchPath: 'y' },
    provider: 'workbuddy',
    log: () => {},
  }).find((r) => r.path === '/workbuddy/models');

  let payload;
  const res = {
    writeHead() {},
    end(body) { payload = JSON.parse(body); },
  };
  await route.handler({ url: '/workbuddy/models', method: 'GET' }, res);
  assert.equal(payload.ok, true);
  assert.equal(payload.models.length, 1);
  const [model] = payload.models;
  assert.equal(model.contextWindow, 128000, '必须是 contextWindow，而不是上游的 context_window');
  assert.equal(model.maxTokens, 8192);
  assert.equal(model.images, true);
  assert.equal(model.credits, 0.5);
});

test('面板写操作要求 x-workbuddy-panel 头（挡住跨站简单请求）', async () => {
  const { createRouteTable } = await import('../lib/routes.mjs');
  const calls = [];
  const route = createRouteTable({
    snapshot: async () => ({}),
    supervisor: {
      readLog: () => ({ lines: [] }),
      probe: async () => ({ state: 'stopped' }),
      ensure: async () => { calls.push('ensure'); return { ok: true, health: { pid: 1 } }; },
      stop: async () => ({ ok: true, stopped: true }),
    },
    client: {},
    adapter: { catalogCache: { at: 0, models: [] }, catalogError: '', invalidate() {} },
    paths: { settingsPath: 'x', patchPath: 'y' },
    provider: 'workbuddy',
    log: () => {},
  }).find((r) => r.path === '/workbuddy/bridge');

  const send = () => {
    let status = 0;
    let payload;
    const res = { writeHead(code) { status = code; }, end(body) { payload = body ? JSON.parse(body) : undefined; } };
    return { res, get: () => ({ status, payload }) };
  };

  const denied = send();
  await route.handler({ method: 'POST', headers: {}, url: '/workbuddy/bridge', async *[Symbol.asyncIterator]() {} }, denied.res);
  assert.equal(denied.get().status, 403);
  assert.equal(calls.length, 0, '没有头的请求不能触发任何桥操作');

  const allowed = send();
  const body = JSON.stringify({ action: 'start' });
  await route.handler({
    method: 'POST',
    headers: { 'x-workbuddy-panel': '1' },
    url: '/workbuddy/bridge',
    async *[Symbol.asyncIterator]() { yield Buffer.from(body); },
  }, allowed.res);
  assert.equal(allowed.get().status, 200);
  assert.equal(allowed.get().payload.ok, true);
  assert.deepEqual(calls, ['ensure']);
});

test('readProjectEnv 解析 .env，且只在 config 未显式指定时生效', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-env-'));
  try {
    mkdirSync(join(dir, 'bridge'), { recursive: true });
    writeFileSync(join(dir, 'bridge', 'workbuddy-bridge.mjs'), '// stub\n', 'utf8');
    writeFileSync(join(dir, '.env'), [
      '# 注释',
      'WORKBUDDY_PORT=8899',
      'WORKBUDDY_LOCAL_TOKEN="tok-from-env"',
      'WORKBUDDY_AUTH_FILE=\'C:\\tmp\\custom.info\'',
      '',
    ].join('\n'), 'utf8');

    const parsed = readProjectEnv(dir);
    assert.equal(parsed.WORKBUDDY_PORT, '8899');
    assert.equal(parsed.WORKBUDDY_LOCAL_TOKEN, 'tok-from-env');
    assert.equal(parsed.WORKBUDDY_AUTH_FILE, 'C:\\tmp\\custom.info');

    const { ctx } = fakeCtx();
    // 不显式给端口 → 跟随 .env
    const fromEnv = apply(ctx, { projectRoot: dir, autoStart: false, tools: false, commands: false, routes: false, migrateLegacy: false });
    assert.equal(fromEnv.state.config.bridgePort, 8899, '.env 里的端口必须被采纳');
    assert.equal(fromEnv.state.config.localToken, 'tok-from-env');
    assert.equal(fromEnv.supervisor.authFile, 'C:\\tmp\\custom.info');

    // 显式给了端口 → 以配置为准，不被 .env 覆盖
    const { ctx: ctx2 } = fakeCtx();
    const explicit = apply(ctx2, { projectRoot: dir, bridgePort: 9911, autoStart: false, tools: false, commands: false, routes: false, migrateLegacy: false });
    assert.equal(explicit.state.config.bridgePort, 9911, '显式配置优先于 .env');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('ConsoleSupervisor：靠首页标题识别控制台，认不出就报 foreign', async () => {
  const { ConsoleSupervisor, CONSOLE_TITLE } = await import('../lib/console.mjs');
  const { createServer } = await import('node:http');

  // 1) 真控制台（首页标题匹配）
  const real = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html><head><title>${CONSOLE_TITLE}</title></head><body>ok</body></html>`);
  });
  await new Promise((r) => real.listen(0, '127.0.0.1', r));
  const realPort = real.address().port;
  try {
    const sup = new ConsoleSupervisor({ projectRoot: 'x', port: realPort, cacheTtlMs: 0 });
    const probe = await sup.probe({ cached: false });
    assert.equal(probe.state, 'running');
    assert.equal(sup.url, `http://127.0.0.1:${realPort}`);
    const ensured = await sup.ensure({});
    assert.equal(ensured.ok, true);
    assert.equal(ensured.reused, true, '已在运行的控制台必须复用，不重复拉起');
    // 别人起的控制台（双击 启动.cmd）：插件不去停它
    const stopped = await sup.stop();
    assert.equal(stopped.ok, false);
    assert.match(stopped.error, /不是插件启动的/);
  } finally { await new Promise((r) => real.close(r)); }

  // 2) 端口被别的 HTTP 服务占着 → foreign，且不会去「拉起」
  const foreign = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<title>别的服务</title>'); });
  await new Promise((r) => foreign.listen(0, '127.0.0.1', r));
  const foreignPort = foreign.address().port;
  try {
    const sup = new ConsoleSupervisor({ projectRoot: 'x', port: foreignPort, cacheTtlMs: 0 });
    assert.equal((await sup.probe({ cached: false })).state, 'foreign');
    const ensured = await sup.ensure({});
    assert.equal(ensured.ok, false);
    assert.equal(ensured.reused, false);
  } finally { await new Promise((r) => foreign.close(r)); }

  // 3) 没人监听 → stopped
  const sup = new ConsoleSupervisor({ projectRoot: 'x', port: 1, cacheTtlMs: 0 });
  assert.equal((await sup.probe({ cached: false })).state, 'stopped');
});

test('快照与控制台路由：状态里带 console，写操作同样要面板头', async () => {
  const { createRouteTable } = await import('../lib/routes.mjs');
  const consoleSupervisor = {
    url: 'http://127.0.0.1:8792',
    spawnedPid: null,
    async probe() { return { state: 'running', error: '' }; },
    async ensure() { return { ok: true, reused: true, url: this.url }; },
    async stop() { return { ok: false, error: '不是插件启动的' }; },
  };
  const routes = createRouteTable({
    snapshot: async () => ({ console: { state: 'running', url: consoleSupervisor.url } }),
    supervisor: { readLog: () => ({ lines: [] }), probe: async () => ({ state: 'running' }) },
    consoleSupervisor,
    client: {},
    adapter: { catalogCache: { at: 0, models: [] }, catalogError: '' },
    paths: { settingsPath: 'x', patchPath: 'y' },
    provider: 'workbuddy',
    log: () => {},
  });

  let statusPayload;
  await routes.find((r) => r.path === '/workbuddy/status').handler(
    { url: '/workbuddy/status', method: 'GET' },
    { writeHead() {}, end(b) { statusPayload = JSON.parse(b); } },
  );
  assert.equal(statusPayload.console.url, 'http://127.0.0.1:8792');
  assert.equal(statusPayload.console.state, 'running');

  const consoleRoute = routes.find((r) => r.path === '/workbuddy/console');
  assert.ok(consoleRoute, '必须挂上 /workbuddy/console');

  let getPayload;
  await consoleRoute.handler({ url: '/workbuddy/console', method: 'GET' }, { writeHead() {}, end(b) { getPayload = JSON.parse(b); } });
  assert.equal(getPayload.url, consoleSupervisor.url);
  assert.equal(getPayload.state, 'running');

  let denied = 0;
  await consoleRoute.handler({ method: 'POST', headers: {}, url: '/workbuddy/console', async *[Symbol.asyncIterator]() {} }, { writeHead(c) { denied = c; }, end() {} });
  assert.equal(denied, 403);

  let okStatus = 0;
  let okPayload;
  const body = JSON.stringify({ action: 'start' });
  await consoleRoute.handler({
    method: 'POST',
    headers: { 'x-workbuddy-panel': '1' },
    url: '/workbuddy/console',
    async *[Symbol.asyncIterator]() { yield Buffer.from(body); },
  }, { writeHead(c) { okStatus = c; }, end(b) { okPayload = JSON.parse(b); } });
  assert.equal(okStatus, 200);
  assert.equal(okPayload.ok, true);
  assert.equal(okPayload.action, 'start');
});

test('apply() 的 migrateLegacy 默认会清理指向的文件（用临时目录）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-migrate-'));
  const previous = { home: process.env.DSH_HOME, dir: process.env.DSH_PROFILE_DIR, profile: process.env.DSH_PROFILE };
  try {
    // 先把 dsh home **与 profile 目录**都指向临时目录。注意：DSH_PROFILE_DIR 的
    // 优先级高于 DSH_HOME，只改 DSH_HOME 会让 patchPath 落到真实 profile 上
    // （这正是本测试曾经误改真实文件的原因）。
    const profileDir = join(dir, 'profiles', 'test-profile');
    process.env.DSH_HOME = dir;
    process.env.DSH_PROFILE = 'test-profile';
    process.env.DSH_PROFILE_DIR = profileDir;
    mkdirSync(profileDir, { recursive: true });
    const settings = join(dir, 'settings.yaml');
    const patch = join(profileDir, 'cordis.patch.yml');
    writeFileSync(settings, SETTINGS, 'utf8');
    writeFileSync(patch, PATCH, 'utf8');

    const { ctx } = fakeCtx();
    const result = apply(ctx, { projectRoot: join(dir, 'nowhere'), autoStart: false, tools: false, commands: false, routes: false });
    // 语义：`cleaned` 记录这次删了什么，`found` 是**清理之后**是否还有残留
    assert.equal(result.state.legacy.cleaned.changed, true);
    assert.equal(result.state.legacy.found, false, '清理干净之后不应再报“检测到旧路由”');
    assert.ok(result.state.legacy.cleaned.files.some((f) => f.changed && f.backup), '必须有文件被改且留下备份');
    assert.equal(result.state.dshPaths.patchPath, patch, 'patchPath 必须落在临时目录里');
    assert.doesNotMatch(readFileSync(settings, 'utf8'), /workbuddy:/);
    assert.doesNotMatch(readFileSync(patch, 'utf8'), /^\s+workbuddy:$/m);
    // patch 里其它内容与插件自己的条目都不受影响
    assert.match(readFileSync(patch, 'utf8'), /- id: workbuddy\n  name: dsh-plugin-workbuddy/);
    assert.match(readFileSync(patch, 'utf8'), /keep-me:/);
  } finally {
    if (previous.home === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous.home;
    if (previous.dir === undefined) delete process.env.DSH_PROFILE_DIR; else process.env.DSH_PROFILE_DIR = previous.dir;
    if (previous.profile === undefined) delete process.env.DSH_PROFILE; else process.env.DSH_PROFILE = previous.profile;
    rmSync(dir, { recursive: true, force: true });
  }
});
