/**
 * 模型拥堵探测（`/v2/chat/busy`）的回归。
 *
 * 这个功能的价值全在**"不编事实"**上，所以测试的重心不是"能不能解析"，
 * 而是四类边界：
 *
 *   1. 枚举外的等级必须变 `unknown`，**不能**被当成 `normal` 画出去；
 *   2. `unknown` / 缺字段 / `normal` 在展示层的区别必须保住
 *      （`unknown` 说"没数据"，`normal` 说"上游说正常"—— 混起来就是对用户撒谎）；
 *   3. 国际区没有这个端点（实测 404）时，`/health` 与 `/v1/models` 都必须照常
 *      工作，只是没有拥堵数据 —— 一个锦上添花的功能不能把主功能拖下水；
 *   4. 拥堵是"这一分钟"的事实，**绝不落盘**。
 *
 * 纯函数部分直接测；降级与端到端用真桥 + 假上游。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pickBridgePort } from '../tools/dev/bridge-ports.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(HERE);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const busy = await import('../lib/busy.mjs');

// ── 纯函数 ─────────────────────────────────────────────────────────────

test('拥堵：枚举外的等级变 unknown，不能落到 normal', () => {
  assert.equal(busy.normalizeBusyLevel('idle'), 'idle');
  assert.equal(busy.normalizeBusyLevel('congested'), 'congested');
  // 关键：这些都不是上游的词，必须 unknown
  for (const bad of ['', null, undefined, 'IDLE', 'Busy', 'very-busy', 0, 1, {}, []]) {
    assert.equal(busy.normalizeBusyLevel(bad), 'unknown', `${JSON.stringify(bad)} 应归一为 unknown`);
  }
  assert.notEqual(busy.normalizeBusyLevel('weird'), 'normal',
    'unknown 绝不能变成 normal —— 那会把"没数据"说成"一切正常"');
});

test('拥堵：解析容忍坏条目，但保留"上游说了但看不懂"这条事实', () => {
  const m = busy.parseBusyLevels([
    { model: 'a', busy_level: 'idle' },
    { model: 'b', busy_level: 'nonsense' },   // 上游答了、但我们看不懂
    { model: '', busy_level: 'busy' },        // 没有 id：跳过
    null, 'x', 42,                            // 不是对象：跳过
    { model: 'c' },                           // 没有 level：unknown
  ]);
  assert.equal(m.get('a'), 'idle');
  assert.equal(m.get('b'), 'unknown', '看不懂的等级仍是关于该模型的一条事实');
  assert.equal(m.get('c'), 'unknown');
  assert.equal(m.has(''), false);
  assert.equal(m.size, 3);
  // 非数组输入不能抛
  assert.equal(busy.parseBusyLevels(null).size, 0);
  assert.equal(busy.parseBusyLevels({}).size, 0);
});

test('拥堵：批次去重保序，不超过上游上限', () => {
  const ids = Array.from({ length: 120 }, (_, i) => `m${i}`);
  const dup = [...ids, 'm0', 'm1', ''];
  const batches = busy.batchModelIds(dup);
  assert.equal(batches.length, 3, '120 个 id 按 50 一批应分 3 批');
  assert.deepEqual(batches[0].slice(0, 2), ['m0', 'm1']);
  assert.equal(batches[2].length, 20);
  const flat = batches.flat();
  assert.equal(new Set(flat).size, flat.length, '批次之间不能重复');
  assert.equal(flat.length, 120, '去重后正好 120 个');
  // 自定义批次大小
  assert.equal(busy.batchModelIds(['a', 'b', 'c'], 2).length, 2);
  // 空输入
  assert.deepEqual(busy.batchModelIds([]), []);
  assert.deepEqual(busy.batchModelIds(null), []);
});

test('拥堵：展示层必须区分"正常"与"没数据"', () => {
  // 有词的四个等级
  assert.equal(busy.busyLabel('idle'), '空闲');
  assert.equal(busy.busyLabel('busy'), '轻微拥堵');
  assert.equal(busy.busyLabel('congested'), '极度拥堵');
  assert.equal(busy.busyLabel('unavailable'), '不可用');
  // 这两个刻意**没有词**：normal 是健康默认值（二十行里十七行写"正常"是噪音），
  // unknown 是"上游没说"（编一个比不画更糟）
  assert.equal(busy.busyLabel('normal'), '');
  assert.equal(busy.busyLabel('unknown'), '');
  // 英文
  assert.equal(busy.busyLabel('congested', 'en'), 'Extremely congested');
  assert.equal(busy.busyLabel('normal', 'en'), '');

  // 模型名后缀：只有需要用户做决定的才画
  assert.equal(busy.busyDisplaySuffix('unknown'), '');
  assert.equal(busy.busyDisplaySuffix(''), '');
  assert.equal(busy.busyDisplaySuffix('congested'), ' 🧍🧍🧍');
  assert.equal(busy.busyDisplaySuffix('idle'), ' 🚀');

  // "要提醒用户避开"的判据：idle 是好消息，不是警告
  assert.equal(busy.isBusyLevel('busy'), true);
  assert.equal(busy.isBusyLevel('congested'), true);
  assert.equal(busy.isBusyLevel('unavailable'), true);
  assert.equal(busy.isBusyLevel('idle'), false);
  assert.equal(busy.isBusyLevel('normal'), false);
  assert.equal(busy.isBusyLevel('unknown'), false);
});

test('拥堵：attachBusyLevels 不原地改、没答的保持原样', () => {
  const models = [{ id: 'a' }, { id: 'b' }, { id: 'c', busyLevel: 'busy' }];
  const levels = new Map([['a', 'idle']]);
  const out = busy.attachBusyLevels(models, levels);
  assert.equal(out[0].busyLevel, 'idle');
  assert.equal(out[1].busyLevel, undefined, '探针没答的模型不编一个等级');
  assert.equal(out[2].busyLevel, 'busy', '没答时保持原值');
  assert.equal(models[0].busyLevel, undefined, '不能原地改入参');
  assert.equal(out[2], models[2], '值没变时应返回同一个对象（避免无谓重渲染）');
});

test('拥堵：媒体模型不进负载探针', () => {
  const ids = busy.probeableModelIds([
    { id: 'chat-a' },
    { id: 'img-1', tag: 'text-to-image' },
    { id: 'vid-1', tag: 'text-to-video' },
    { id: 'emb-1', tag: 'embedding' },
    { id: '' },
    null,
  ]);
  assert.deepEqual(ids, ['chat-a']);
});

test('拥堵：过期判定 —— 从没过是 -1 而不是 0，刚好到期就算过期', () => {
  /*
   * ageMs 的两条口径必须钉住：
   *   · 从没探过 → ageMs = -1。用 0 会让调用方以为"刚刚探过"，
   *     于是"没有数据"会被读成"新鲜的数据"；
   *   · 边界用 >= 而不是 >：TTL 是"最多信这么久"，30 秒整就该算过期。
   */
  assert.equal(busy.busyFreshness(0).probed, false);
  assert.equal(busy.busyFreshness(0).ageMs, -1, '从没探过必须是 -1');
  assert.equal(busy.busyFreshness(0).stale, false, '没有数据不等于过期');

  const now = 1_000_000;
  const fresh = busy.busyFreshness(now - 1_000, now, busy.BUSY_TTL_MS);
  assert.equal(fresh.probed, true);
  assert.equal(fresh.ageMs, 1_000);
  assert.equal(fresh.stale, false, '1 秒前的数据是新鲜的');

  const edge = busy.busyFreshness(now - busy.BUSY_TTL_MS, now, busy.BUSY_TTL_MS);
  assert.equal(edge.stale, true, '刚好到期即过期（>= 不是 >）');

  const old = busy.busyFreshness(now - busy.BUSY_TTL_MS - 1, now, busy.BUSY_TTL_MS);
  assert.equal(old.stale, true);
  assert.ok(old.ageMs > busy.BUSY_TTL_MS);
});

test('拥堵：过期时输出层必须交空 —— 绝不把旧值当新值', () => {
  /*
   * 这是 2026-11-07 实测发现的真缺陷：
   * /health.load 报 stale=true（ageMs 从 48s 一路涨到 64s），
   * 而 /v1/models 的 22 个 busy_level 一直挂着、值一模一样。
   *
   * 为什么必须交空、而不是"先回旧值再后台刷新"：输出层只有"有没有等级"
   * 这一个信号，旧值与刚探到的值在界面上完全相同 —— 用户会拿"上一分钟"的
   * 负载做"现在"的决定。那是一段**看起来像真相的假信息**，比"没有数据"糟得多。
   */
  const levels = new Map([['glm-5.3', 'idle'], ['hy3', 'congested']]);
  const now = 1_000_000;

  const fresh = busy.gatedBusyLevels(levels, now - 1_000, now, busy.BUSY_TTL_MS);
  assert.equal(fresh.size, 2, '新鲜时必须原样交出');
  assert.equal(fresh.get('glm-5.3'), 'idle');

  const stale = busy.gatedBusyLevels(levels, now - busy.BUSY_TTL_MS, now, busy.BUSY_TTL_MS);
  assert.equal(stale.size, 0, '过期必须交空 —— 界面显示「—」才是诚实的');

  /*
   * 从没探过（at=0）**不构成过期**：
   * 那一天的"有没有数据"由 known/unsupported 判定，不是由新鲜度判定。
   * 把两者混起来会让"区域不支持"被误报成"数据过期"。
   */
  const never = busy.gatedBusyLevels(levels, 0, now, busy.BUSY_TTL_MS);
  assert.equal(never.size, 2, 'at=0 不算过期（语义上是"还没探过"，由调用方另外判定');
});

// ── 端到端：真桥 + 假上游 ─────────────────────────────────────────────

const stubState = { busyMode: 'ok', busyHits: 0 };
const stub = createServer((req, res) => {
  if (req.url?.startsWith('/v2/chat/busy')) {
    stubState.busyHits += 1;
    if (stubState.busyMode === '404') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error_msg: '404 Route Not Found' }));
      return;
    }
    if (stubState.busyMode === 'bizcode') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"code":14001,"msg":"no permission"}');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      code: 0,
      data: [
        { model: 'glm-5.3', busy_level: 'congested' },
        { model: 'hy3', busy_level: 'idle' },
        { model: 'weird-model', busy_level: 'not-a-level' },
      ],
    }));
    return;
  }
  if (req.url?.startsWith('/v3/config')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      code: 0,
      data: {
        models: [
          { id: 'glm-5.3', name: 'GLM-5.3', maxInputTokens: 300000, maxOutputTokens: 48000, credits: 0.79 },
          { id: 'hy3', name: 'HY3', maxInputTokens: 128000, maxOutputTokens: 16000, credits: 1 },
          { id: 'weird-model', name: 'Weird', maxInputTokens: 64000, maxOutputTokens: 8000, credits: 2 },
        ],
      },
    }));
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end('{}');
});
await new Promise((r) => stub.listen(0, '127.0.0.1', r));
const STUB = `http://127.0.0.1:${stub.address().port}`;

const dir = mkdtempSync(join(tmpdir(), 'wb-busy-'));
const authFile = join(dir, 'auth.info');
writeFileSync(authFile, JSON.stringify({
  auth: { accessToken: 't', refreshToken: 'r', domain: 'example.invalid', expiresAt: Date.now() + 3_600_000 },
}));
const TOKEN = 'busy-test-token';
const PORT = pickBridgePort();

const child = spawn(process.execPath, [join(REPO, 'bridge', 'workbuddy-bridge.mjs')], {
  cwd: dir,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    WORKBUDDY_HOST: '127.0.0.1',
    WORKBUDDY_PORT: String(PORT),
    WORKBUDDY_LOCAL_TOKEN: TOKEN,
    WORKBUDDY_AUTH_FILE: authFile,
    WORKBUDDY_CREDENTIAL_DIR: join(dir, 'cred'),
    WORKBUDDY_USAGE_FILE: join(dir, 'usage.jsonl'),
    WORKBUDDY_DATA_DIR: dir,
    CODEBUDDY_ENDPOINT: STUB,
    WORKBUDDY_LOG: '0',
    WORKBUDDY_AUTO_CHECKIN: '0',
  },
  windowsHide: true,
});
let logs = '';
child.stdout.on('data', (d) => { logs += d; });
child.stderr.on('data', (d) => { logs += d; });

const base = `http://127.0.0.1:${PORT}`;
const auth = { authorization: `Bearer ${TOKEN}` };
for (let i = 0; i < 100; i += 1) {
  try {
    const r = await fetch(`${base}/health`, { headers: auth, signal: AbortSignal.timeout(1200) });
    if (r.ok || r.status === 503) break;
  } catch { /* 还没起来 */ }
  if (i === 99) throw new Error(`桥未就绪：\n${logs.slice(-1000)}`);
  await sleep(200);
}

test('拥堵：正常路径 —— /v1/load 与 /v1/models 一致，unknown 不外泄', async () => {
  stubState.busyMode = 'ok';
  const load = await (await fetch(`${base}/v1/load?refresh=1`, {
    headers: auth, signal: AbortSignal.timeout(15_000),
  })).json();
  assert.equal(load.ok, true);
  assert.ok(load.known >= 3, `应探到 3 个模型，实际 ${load.known}`);

  const byId = new Map(load.models.map((m) => [m.model, m]));
  assert.equal(byId.get('glm-5.3')?.level, 'congested');
  assert.equal(byId.get('glm-5.3')?.warning, true, 'congested 必须标为"要提醒"');
  assert.equal(byId.get('hy3')?.level, 'idle');
  assert.equal(byId.get('hy3')?.warning, false, 'idle 是好消息，不是警告');
  assert.equal(byId.get('weird-model')?.level, 'unknown', '枚举外的等级归一为 unknown');

  // 忙的排前面：用户最想知道"哪些现在别选"
  assert.equal(load.models[0].warning, true, `第一条应是待避开的，实际 ${JSON.stringify(load.models[0])}`);

  // /v1/models 不输出 unknown，且与 /v1/load 一致
  const models = await (await fetch(`${base}/v1/models?all=1`, {
    headers: auth, signal: AbortSignal.timeout(15_000),
  })).json();
  const withBusy = models.data.filter((m) => m.busy_level);
  assert.ok(withBusy.length >= 2, `应有模型带 busy_level，实际 ${withBusy.length}`);
  for (const m of withBusy) {
    assert.notEqual(m.busy_level, 'unknown', `${m.id} 不该把 unknown 画出去`);
    assert.equal(m.busy_level, byId.get(m.id)?.level, `${m.id} 两处等级必须一致`);
  }
  // 明确有值的几个
  assert.equal(models.data.find((m) => m.id === 'glm-5.3')?.busy_level, 'congested');
  assert.equal(models.data.find((m) => m.id === 'weird-model')?.busy_level, undefined,
    'unknown 不出现在 /v1/models 里（等于"没有数据"）');
});

test('拥堵：/health.load 与 /v1/load 同源，且与 rateLimit.modelBusy 分开', async () => {
  const health = await (await fetch(`${base}/health`, { headers: auth })).json();
  assert.ok(health.load, '/health 必须有 load 段');
  assert.equal(typeof health.load.known, 'number');
  assert.equal(typeof health.load.counts, 'object');
  assert.ok(Array.isArray(health.load.warnings));
  // 两个字段语义不同，不能混
  assert.equal('modelBusy' in health.load, false, 'load 里不该嵌 modelBusy');
  assert.equal('load' in (health.rateLimit || {}), false, 'load 不该塞在 rateLimit 里');
});

test('拥堵：区域没有该端点时安静降级（不影响 /health 与目录）', async () => {
  stubState.busyMode = '404';
  const load = await (await fetch(`${base}/v1/load?refresh=1`, {
    headers: auth, signal: AbortSignal.timeout(15_000),
  })).json();
  assert.equal(load.unsupported, true, '404 应标记 unsupported');
  assert.equal(load.ok, true, '搭不上负载数据不是错误');
  // 目录必须照常
  const models = await (await fetch(`${base}/v1/models?all=1`, {
    headers: auth, signal: AbortSignal.timeout(15_000),
  })).json();
  assert.ok(models.data.length > 0, '目录不能因为负载探针失败而变空');
  const health = await fetch(`${base}/health`, { headers: auth });
  assert.equal(health.status, 200, '健康检查必须仍然 200');
});

test('拥堵：业务错误码不算成功（HTTP 200 但 code!=0）', async () => {
  stubState.busyMode = 'bizcode';
  const load = await (await fetch(`${base}/v1/load?refresh=1`, {
    headers: auth, signal: AbortSignal.timeout(15_000),
  })).json();
  assert.equal(load.known, 0, `业务错误时不能有等级，实际 known=${load.known}`);
  assert.ok(String(load.error || '').length > 0, '必须如实带出错误');
});

test('拥堵：等级不落盘（存活期只有这一分钟）', () => {
  const files = readdirSync(dir).filter((f) => /\.(json|jsonl)$/.test(f));
  for (const f of files) {
    const text = readFileSync(join(dir, f), 'utf8');
    // 目录文件里绝不能出现等级字段
    assert.equal(/busy_level|busyLevel/.test(text), false,
      `${f} 里出现了拥堵等级 —— 它能活过重启就成了一句假话`);
  }
});

/*
 * 收尾**必须**写成 `test.after(...)`，不能用独立导入的 `after(...)`：
 * `bridge-startup.test.mjs` 里有一条守卫按调用形状（`^test\.after\(`）检查
 * 「起了桥进程的测试必须有收尾」—— 它这样写是刻意的（注释里说明过）：
 * 只看是否"提到过 after"会让"删掉钩子但留下注释"的反证照样变绿。
 *
 * 为什么收尾这么重要：任一用例在 try 之前抛错（端口撞车、桥起不来）时，
 * 监听 socket 与管道会留在测试进程上，`node --test` 跑完不退出。
 */
test.after(async () => {
  try { child.kill(); } catch { /* 忽略 */ }
  if (child.exitCode === null) {
    await new Promise((resolve) => { child.once('exit', resolve); setTimeout(resolve, 1500); });
  }
  try { stub.close(); } catch { /* 忽略 */ }
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
});
