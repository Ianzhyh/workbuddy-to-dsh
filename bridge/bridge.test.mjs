/**
 * 本地桥的**合约测试**：起一个真实桥进程，用真实 HTTP 打它。
 *
 *   node --test bridge/
 *
 * 为什么这么测：`bridge/workbuddy-bridge.mjs` 是"启动即监听"的脚本，没有导出
 * 可直接单测的单元；而它对外的东西恰恰是**HTTP 契约**（面板、控制台、dsh 插件
 * 都按这些端点对接）。所以这里起真进程、打真请求 —— 验的是别人实际依赖的那层。
 *
 * 隔离措施（绝不碰使用者的真实凭据与额度）：
 *   - 临时目录里放一份**假的登录文件**，用 WORKBUDDY_AUTH_FILE 指过去；
 *   - 端口用 0 让内核分配，避免和正在跑的 8790 撞车；
 *   - 临时目录里的 usage.jsonl 是独立账本，不写使用者的那份；
 *   - 不触达上游：这里只验"不需要上游就能答"的契约（鉴权、/、模型目录形状、
 *     计数类端点），需要真实额度的 /v1/chat/completions 由 dsh-plugin 的
 *     adapter 测试用打桩上游覆盖。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(HERE);
const BRIDGE = join(REPO, 'bridge', 'workbuddy-bridge.mjs');
const TOKEN = 'test-token-abc';

/**
 * 一份"看起来像登录文件"的假凭据：桥能读结构，但拿不到真实令牌。
 *
 * 注意这里是**扁平**的（没有 `auth` 包裹层）。这不是笔误，而是刻意保留的：
 * 桥读的是 `raw.auth.accessToken`，扁平文件会让 `readStoredAuth()` 抛
 * 「login file has no accessToken」—— 正好被 `/health` 那条用例用来复现
 * 「凭据异常」。
 */
const FAKE_AUTH = {
  userId: 'test-account-000000',
  accessToken: 'fake-access-token',
  refreshToken: 'fake-refresh-token',
  endpoint: 'https://example.invalid',
  domain: 'example.invalid',
  expiresAt: Date.now() + 30 * 86_400_000,
};

/**
 * 一份**结构正确**的假登录文件：`auth` 包裹层齐全，`readStoredAuth()` 能读通。
 *
 * 需要它的场景（如 D3 的模型预校验）必须先让桥成功读到凭据，否则抓目录那步
 * 直接抛异常、`catalogCache` 永远是空的，预校验按设计放行就测不到。
 * 令牌本身仍是假的 —— 断言的是「桥怎么处理目录」，不是「能不能打通上游」。
 */
const READABLE_FAKE_AUTH = {
  auth: {
    accessToken: 'fake-access-token',
    refreshToken: 'fake-refresh-token',
    domain: 'example.invalid',
    expiresAt: Date.now() + 30 * 86_400_000,
  },
};

/**
 * 起一个隔离的桥实例。
 * @param {object} [env] 额外环境变量
 * @param {object} [opts]
 * @param {object} [opts.auth] 写入登录文件的凭据（默认 FAKE_AUTH）。
 *   `readStoredAuth()` 要求 `auth.accessToken` 存在；传 READABLE_FAKE_AUTH
 *   可让桥"读得到凭据"，从而走到抓目录 / 打上游那几步。
 * @returns {Promise<{baseUrl: string, dir: string, out: () => string, stop: () => Promise<void>}>}
 */
async function startBridge(env = {}, opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wb-bridge-test-'));
  const authFile = join(dir, 'fake-auth.info');
  writeFileSync(authFile, JSON.stringify(opts.auth || FAKE_AUTH));

  // 端口 0 让内核分配：用一个事先探好的空闲端口不保险（可能与真实桥撞车）
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [BRIDGE], {
    cwd: dir, // 工作目录放在临时目录：账本/日志都落在里面
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      WORKBUDDY_HOST: '127.0.0.1',
      WORKBUDDY_PORT: String(port),
      WORKBUDDY_LOCAL_TOKEN: TOKEN,
      WORKBUDDY_AUTH_FILE: authFile,
      WORKBUDDY_USAGE_FILE: join(dir, 'usage.jsonl'),
      WORKBUDDY_AUTO_CHECKIN: '0', // 别在测试里触发签到
      WORKBUDDY_LOG: '0',
      ...env,
    },
  });

  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });

  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`桥提前退出（code ${child.exitCode}）：\n${output}`);
    try {
      const res = await fetch(baseUrl + '/', { headers: { authorization: `Bearer ${TOKEN}` }, signal: AbortSignal.timeout(1500) });
      if (res.status > 0) {
        return {
          baseUrl,
          dir,
          out: () => output,
          stop: () => new Promise((resolve) => {
            child.once('exit', resolve);
            child.kill();
            setTimeout(resolve, 3000);
          }),
        };
      }
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  child.kill();
  throw new Error(`桥未在 20 秒内就绪：\n${output}`);
}

const auth = { authorization: `Bearer ${TOKEN}` };

test('桥：端点契约 —— 鉴权、身份、模型目录形状', { timeout: 90_000 }, async () => {
  const bridge = await startBridge();
  try {
    // ① 无令牌 → 401（本地端口默认要求令牌）
    const noAuth = await fetch(bridge.baseUrl + '/v1/models');
    assert.equal(noAuth.status, 401, '没有 Authorization 时必须是 401');

    // ② 错令牌 → 401
    const badAuth = await fetch(bridge.baseUrl + '/v1/models', { headers: { authorization: 'Bearer wrong' } });
    assert.equal(badAuth.status, 401);

    // ③ 身份端点：给插件/控制台用来确认"端口上的确实是我们"
    const root = await (await fetch(bridge.baseUrl + '/', { headers: auth })).json();
    assert.ok(root.name || root.service || root.version, 'GET / 必须能自报名号');
    assert.match(JSON.stringify(root), /workbuddy/i, '身份信息里应当有 workbuddy 字样');

    // ④ 模型目录：OpenAI 兼容形状（object/data + 每项 id）
    const modelsRes = await fetch(bridge.baseUrl + '/v1/models', { headers: auth });
    assert.equal(modelsRes.status, 200);
    const models = await modelsRes.json();
    assert.ok(Array.isArray(models.data), '/v1/models 必须返回 {data: [...]}（OpenAI 兼容）');
    assert.ok(models.data.length > 0, '假凭据下也应当有内置的模型目录（不依赖上游）');
    for (const m of models.data) {
      assert.equal(typeof m.id, 'string', '每个模型必须有字符串 id');
      assert.ok(m.id.length > 0);
    }

    // ⑤ 计数类端点必须是"不需要上游就能答"的：不能挂
    for (const endpoint of ['/v1/usage', '/v1/requests']) {
      const res = await fetch(bridge.baseUrl + endpoint, { headers: auth, signal: AbortSignal.timeout(8000) });
      assert.equal(res.status, 200, `${endpoint} 应当直接 200（本地账本，不需要上游）`);
      const body = await res.json();
      assert.equal(typeof body, 'object');
    }

    // ⑥ 未知路径 → 404，且是 JSON（不是 HTML 错误页）
    const missing = await fetch(bridge.baseUrl + '/nope', { headers: auth });
    assert.equal(missing.status, 404);
    assert.match(missing.headers.get('content-type') || '', /json/, '错误也必须是 JSON，调用方才能解析');
  } finally {
    await bridge.stop();
    rmSync(bridge.dir, { recursive: true, force: true });
  }
});

test('桥：账本是本地文件，且不写使用者的那份', { timeout: 90_000 }, async () => {
  const bridge = await startBridge();
  try {
    const usage = await (await fetch(bridge.baseUrl + '/v1/usage', { headers: auth })).json();
    assert.equal(typeof usage, 'object');
    // 临时目录里应当出现（或可创建）账本文件；关键是**工作目录隔离**
    const localLedger = join(bridge.dir, 'usage.jsonl');
    const repoLedger = join(REPO, 'bridge', 'usage.jsonl');
    const repoLedgerBefore = existsSync(repoLedger) ? readFileSync(repoLedger, 'utf8').length : -1;

    // 触发一次"清空账本"（不需要上游）
    const cleared = await fetch(bridge.baseUrl + '/v1/usage', { method: 'DELETE', headers: auth });
    assert.ok([200, 204].includes(cleared.status), `清空账本应当成功，实际 ${cleared.status}`);

    const repoLedgerAfter = existsSync(repoLedger) ? readFileSync(repoLedger, 'utf8').length : -1;
    assert.equal(repoLedgerAfter, repoLedgerBefore, '测试绝不能改到使用者的真实账本');

    // 清空后仍可读，且是空账本
    const after = await (await fetch(bridge.baseUrl + '/v1/usage', { headers: auth })).json();
    const total = after.total || after.usage?.total || {};
    assert.ok((total.calls || 0) === 0, '清空后调用数应为 0');
    assert.ok(localLedger === join(bridge.dir, 'usage.jsonl'));
  } finally {
    await bridge.stop();
    rmSync(bridge.dir, { recursive: true, force: true });
  }
});

test('桥：无凭据时 /health 如实报 503 并带上原因（插件据此判"凭据异常"）', { timeout: 90_000 }, async () => {
  // 故意指向一个不存在的登录文件：模拟"WorkBuddy 没登录/登录文件被删"
  const bridge = await startBridge({ WORKBUDDY_AUTH_FILE: 'C:\\definitely\\missing\\auth.info' });
  try {
    const res = await fetch(bridge.baseUrl + '/health', { headers: auth, signal: AbortSignal.timeout(8000) });
    assert.equal(res.status, 503, '读不出凭据时 /health 必须是 503（不是 200，也不能崩）');
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.ok(body.error, '必须给出原因，调用方才能显示给用户');
    assert.ok(body.authFile, '必须回带它尝试读的登录文件路径（便于排查）');
    // 关键：进程还活着，且其它端点仍可用（不是整个桥挂掉）
    assert.equal((await fetch(bridge.baseUrl + '/', { headers: auth })).status, 200, '凭据坏了也应当能自报名号');
  } finally {
    await bridge.stop();
    rmSync(bridge.dir, { recursive: true, force: true });
  }
});

test('桥：超大请求体必须是 413 JSON，且桥仍然可用（D2）', { timeout: 90_000 }, async () => {
  // 把上限压到 64KB，这样才能用一个几 MB 的 body 稳定触发它 —— 真按 32MB 默认值
  // 测，就得在测试里造 32MB 的字符串（慢、吃内存），而这里验的是**拒绝逻辑**，
  // 不是那个具体数值。上限可配正是为这种场景留的。
  const bridge = await startBridge({ WORKBUDDY_MAX_BODY_BYTES: String(64 * 1024) });
  try {
    // 一个远超上限的 body：桥会在读到 64KB 时就判定超限、停止消费，并回 413。
    // 注意这里**必须**断言拿到的是 413 而不仅仅是"连接断了" —— 早期实现在
    // readBody 里直接 req.destroy()，客户端只会收到 ECONNRESET，413 根本发不
    // 出来。这正是本用例要钉住的行为。
    const oversized = 'x'.repeat(256 * 1024);
    const body = JSON.stringify({ model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: oversized }] });

    let status = 0;
    let payload = null;
    let contentType = '';
    try {
      const res = await fetch(bridge.baseUrl + '/v1/chat/completions', {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body,
        signal: AbortSignal.timeout(15000),
      });
      status = res.status;
      contentType = res.headers.get('content-type') || '';
      payload = await res.json().catch(() => null);
    } catch (e) {
      // 连接被掐断（ECONNRESET）说明 413 没发出来 —— 契约要求的是明确的
      // 413 JSON，所以这里直接判失败，而不是"连接异常也算过"。
      assert.fail(`超大 body 应当拿到 413 JSON 响应，实际连接异常：${e.message}`);
    }

    assert.equal(status, 413, `超大 body 必须是 413，实际 ${status}`);
    assert.match(contentType, /json/, '413 也必须是 JSON（调用方才能解析）');
    assert.ok(payload?.error?.message, '413 必须带可读的错误说明');
    assert.match(payload.error.message, /too large|limit/i, '错误信息要说明是"太大"而不是别的');

    // 关键：拒绝一次超大请求之后，桥自己必须还活着（不是被那个 body 打崩）
    const stillUp = await fetch(bridge.baseUrl + '/', { headers: auth, signal: AbortSignal.timeout(8000) });
    assert.equal(stillUp.status, 200, '拒绝超大 body 之后桥必须仍然可用');

    // 回归：**大 body 下的 413 不能变成 ECONNRESET**。
    // 早期实现在 413 分支里 destroy()，客户端还没读到响应就被 RST 掉 ——
    // 实测 8MB 时 10/10 丢失。修法是回完 413 后 req.resume() 把剩余字节读掉。
    // 这里用 8MB（远超 64KB 上限）连打 3 次，每次都必须拿到 413。
    const big = JSON.stringify({
      model: 'deepseek-v4.1-flash',
      messages: [{ role: 'user', content: 'y'.repeat(8 * 1024 * 1024) }],
    });
    for (let i = 0; i < 3; i += 1) {
      let bigStatus = 0;
      try {
        const r = await fetch(bridge.baseUrl + '/v1/chat/completions', {
          method: 'POST',
          headers: { ...auth, 'content-type': 'application/json' },
          body: big,
          signal: AbortSignal.timeout(20000),
        });
        bigStatus = r.status;
        await r.arrayBuffer().catch(() => {});
      } catch (e) {
        assert.fail(`第 ${i + 1} 次 8MB 请求应当拿到 413，实际连接异常：${e.message}`);
      }
      assert.equal(bigStatus, 413, `第 ${i + 1} 次 8MB 请求必须是 413（不能被 RST 吞掉）`);
    }
  } finally {
    await bridge.stop();
    rmSync(bridge.dir, { recursive: true, force: true });
  }
});

test('桥：目录非空时拒绝未知模型，且不打上游（D3）', { timeout: 90_000 }, async () => {
  // 起一个**打桩上游**：它按上游的目录形状回模型清单，并记录 chat 有没有被调过。
  // 为什么必须打桩、不能沿用 example.invalid：预校验只在「目录已知」时生效，
  // 而目录只有在真正抓到上游之后才会被填上（FEATURED 补全也在那之后）。
  // 用假域名的话缓存永远是空的，预校验按设计放行，这个用例就白测了。
  const calls = { chat: 0 };
  const upstream = createServer((req, res) => {
    const path = new URL(req.url, 'http://127.0.0.1').pathname;
    if (path === '/v2/enterprises/personal/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        code: 0,
        data: {
          models: [
            { id: 'stub-known', name: 'Stub Known', maxInputTokens: 128000, maxOutputTokens: 8192 },
            { id: 'stub-other', name: 'Stub Other', maxInputTokens: 32000, maxOutputTokens: 4096 },
          ],
        },
      }));
    }
    if (path === '/v3/config') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ code: 0, data: { models: [] } }));
    }
    if (path === '/v2/chat/completions') {
      calls.chat += 1;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      return res.end('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n');
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const upstreamBase = `http://127.0.0.1:${upstream.address().port}`;

  const bridge = await startBridge({ CODEBUDDY_ENDPOINT: upstreamBase }, { auth: READABLE_FAKE_AUTH });
  try {
    // 先打一次 /v1/models?all=1：这一步会把上游目录真的抓进 catalogCache，
    // 从而让预校验进入「目录非空」这条分支。
    const models = await (await fetch(bridge.baseUrl + '/v1/models?all=1', { headers: auth })).json();
    const ids = models.data.map((m) => m.id);
    assert.ok(ids.includes('stub-known'), `前置条件：目录里应当有 stub-known，实际 ${ids.join(',')}`);

    const chatCallsBefore = calls.chat;

    // ① 未知模型 → 400，且**上游 chat 一次都没被打**
    const res = await fetch(bridge.baseUrl + '/v1/chat/completions', {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'definitely-not-a-real-model-id',
        messages: [{ role: 'user', content: 'hi' }],
      }),
      signal: AbortSignal.timeout(15000),
    });

    assert.equal(res.status, 400, '未知模型必须被本地拦成 400（不是打一次上游再报错）');
    assert.equal(calls.chat, chatCallsBefore, '预校验必须在**打上游之前**拦下，上游 chat 不能被调过');
    const body = await res.json();
    const message = body?.error?.message || '';
    assert.match(message, /not in the current catalog/i, '错误信息必须说明"不在当前目录中"');
    assert.match(message, /\/v1\/models/, '必须给出可操作提示（怎么看到完整目录）');
    assert.match(message, /WORKBUDDY_SKIP_MODEL_PREFLIGHT/, '必须告诉用户逃生开关，目录滞后时能放行');

    // ② 必须落账：否则这次拒绝在控制台"最近请求"里看不见（D3 的初衷之一）
    const requests = await (await fetch(bridge.baseUrl + '/v1/requests', { headers: auth })).json();
    const rejected = (requests.requests || []).find((r) => r.model === 'definitely-not-a-real-model-id');
    assert.ok(rejected, '被拒的请求必须记进账本，否则控制台看不到这次拒绝');
    assert.equal(rejected.ok, false, '这条账必须是失败态');
    assert.equal(rejected.status, 400, '账上要能看出是 400');

    // ③ 目录里的模型必须放行（不能把合法模型一起误杀）
    const known = await fetch(bridge.baseUrl + '/v1/chat/completions', {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'stub-known', messages: [{ role: 'user', content: 'hi' }] }),
      signal: AbortSignal.timeout(15000),
    });
    assert.equal(known.status, 200, '目录里确实存在的模型必须放行到上游');
    assert.equal(calls.chat, chatCallsBefore + 1, '放行的模型应当真的打了一次上游');

    // ④ 桥**对外承诺过**的精选模型也不能被否掉：/v1/models 在目录为空时回退到
    //    FEATURED 定义，客户端可能正拿着这些 id 来调。预校验只查 catalogCache
    //    的话，就会出现「桥让你选，转头又说不在目录里」的自相矛盾。
    const featured = await fetch(bridge.baseUrl + '/v1/chat/completions', {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: 'hi' }] }),
      signal: AbortSignal.timeout(15000),
    });
    assert.equal(featured.status, 200, 'FEATURED 里的模型必须放行（桥自己列出来过它们）');

    // ⑤ 逃生开关：关掉预校验后，同一个未知模型不能再被本地拦下
    const bridge2 = await startBridge(
      { CODEBUDDY_ENDPOINT: upstreamBase, WORKBUDDY_SKIP_MODEL_PREFLIGHT: '1' },
      { auth: READABLE_FAKE_AUTH },
    );
    try {
      await fetch(bridge2.baseUrl + '/v1/models?all=1', { headers: auth });
      const res2 = await fetch(bridge2.baseUrl + '/v1/chat/completions', {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'still-not-real', messages: [{ role: 'user', content: 'hi' }] }),
        signal: AbortSignal.timeout(15000),
      });
      assert.notEqual(res2.status, 400, '逃生开关打开时，未知模型不能再被预校验拦下');
    } finally {
      await bridge2.stop();
      rmSync(bridge2.dir, { recursive: true, force: true });
    }
  } finally {
    await bridge.stop();
    rmSync(bridge.dir, { recursive: true, force: true });
    await new Promise((r) => upstream.close(r));
  }
});

test('桥：上游目录拿不到模型时，未知模型必须放行（D3 不能误杀）', { timeout: 120_000 }, async () => {
  // 这条用例钉住 D3 最容易写错的地方，也是 verifier 报出的**真实误杀**。
  //
  // 背景：fetchCatalog 末尾会用 FEATURED **无条件**补全，所以只要目录端点不返回
  // 5xx，catalogCache.models 就至少躺着 3 个精选模型 —— 但那**不代表桥认识目录**。
  // 若预校验拿 "models.length > 0" 当启用条件，下面这些常见故障下所有不在
  // FEATURED 里的真实可用模型都会被本地 400 拦下、一次上游都不打。
  //
  // 场景全部取自 verifier 的 probe-d3-realistic.mjs，都是上游**真实可能**出现的
  // 非 5xx 失败：代理没放通目录端点（404）、字段改名、返回空数组、模型全被过滤。
  const CASES = [
    ['目录端点 404（代理/WAF 未放通）', 404, () => ({ code: 404, message: 'not found' })],
    ['目录 200 但 models 是空数组', 200, () => ({ code: 0, data: { models: [] } })],
    ['目录 200 但没有 models 字段（上游改名）', 200, () => ({ code: 0, data: { agents: [], other: 1 } })],
    ['目录 200 但模型全被 supportsToolCall:false 挡掉', 200, () => ({
      code: 0,
      data: { models: [{ id: 'no-tools-a', maxInputTokens: 1000, maxOutputTokens: 100, supportsToolCall: false }] },
    })],
  ];

  for (const [label, status, bodyFn] of CASES) {
    const hits = { chat: 0 };
    const upstream = createServer((req, res) => {
      const path = new URL(req.url, 'http://127.0.0.1').pathname;
      if (path === '/v2/chat/completions') {
        hits.chat += 1;
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        return res.end('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n');
      }
      if (path === '/v3/config') {
        // /v3/config 给 200 空表：贴近真实（它通常不是主目录端点）
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ code: 0, data: { models: [] } }));
      }
      if (path === '/v2/enterprises/personal/models') {
        res.writeHead(status, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(bodyFn()));
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{}');
    });
    await new Promise((r) => upstream.listen(0, '127.0.0.1', r));

    const bridge = await startBridge(
      { CODEBUDDY_ENDPOINT: `http://127.0.0.1:${upstream.address().port}` },
      { auth: READABLE_FAKE_AUTH },
    );
    try {
      // 触发一次目录抓取（会失败/落空），再给后台刷新一点时间
      await fetch(bridge.baseUrl + '/v1/models?all=1', { headers: auth, signal: AbortSignal.timeout(15000) }).catch(() => {});
      await new Promise((r) => setTimeout(r, 600));

      // 这个 id 上游 chat 完全能答（stub 对任何 model 都回 200），只是目录里没有。
      // 桥对目录一无所知时必须**原样转发**，而不是自作聪明地 400。
      const res = await fetch(bridge.baseUrl + '/v1/chat/completions', {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'available-but-unlisted-model', messages: [{ role: 'user', content: 'hi' }] }),
        signal: AbortSignal.timeout(15000),
      });

      assert.notEqual(res.status, 400, `${label}：目录未知时绝不能 400 误杀（实际 ${res.status}）`);
      assert.equal(hits.chat, 1, `${label}：目录未知时必须把请求原样转发给上游（chat 被调 ${hits.chat} 次）`);
    } finally {
      await bridge.stop();
      rmSync(bridge.dir, { recursive: true, force: true });
      await new Promise((r) => upstream.close(r));
    }
  }
});

test('桥：账本改用内存镜像后，/v1/usage 与 /v1/requests 的形状不变（D4）', { timeout: 90_000 }, async () => {
  const bridge = await startBridge();
  try {
    // 先在**桥外面**写一份账本，模拟"上次运行留下的真实历史"。
    // 关键是这份文件必须在桥读过它之前就存在，从而同时覆盖两条路径：
    //   - 冷启动时 usageLines === null，必须先初始化镜像
    //   - 镜像建起来之后，后续读取应当与直接解析文件逐字段一致
    const now = Date.now();
    const rows = [
      { t: now - 3600_000, model: 'deepseek-v4.1-flash', stream: false, ms: 120, ok: true, promptTokens: 10, completionTokens: 20, credit: 0.11 },
      { t: now - 1800_000, model: 'deepseek-v4-pro', stream: true, ms: 900, ok: true, promptTokens: 5, completionTokens: 7 },
      { t: now - 600_000, model: 'glm-5.3', stream: false, ms: 300, ok: false, status: 429, code: 11133, error: 'rate limited' },
    ];
    writeFileSync(join(bridge.dir, 'usage.jsonl'), `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);

    const usage = await (await fetch(bridge.baseUrl + '/v1/usage', { headers: auth })).json();
    assert.equal(usage.ok, true);
    assert.equal(usage.windowDays, 7, '默认窗口 7 天');

    // 形状断言：这些字段是控制台/插件实际读的，一个都不能少
    assert.equal(typeof usage.total, 'object');
    assert.ok(Array.isArray(usage.models), 'models 必须是数组');
    assert.ok(Array.isArray(usage.days), 'days 必须是数组');
    assert.ok(Array.isArray(usage.failures), 'failures 必须是数组');

    // 语义断言：成功的 2 条计入 total，失败的第 3 条单独归类
    assert.equal(usage.total.calls, 2, '成功调用数应为 2（失败那条不算）');
    assert.equal(usage.total.failed, 1, '失败数应为 1');
    assert.equal(usage.total.promptTokens, 15);
    assert.equal(usage.total.completionTokens, 27);
    // creditCalls 只数"上游真的回报了 credit"的那条（第 1 条），第 2 条没报
    assert.equal(usage.total.creditCalls, 1, '只有回报了 credit 的调用才算 creditCalls');
    assert.equal(usage.total.credit, 0.11);

    // 逐字段核对：内存镜像解析出来的模型聚合必须与直接解析文件得到的完全一致
    const expectedModels = rows.filter((r) => r.ok !== false).map((r) => r.model).sort();
    assert.deepEqual(
      usage.models.map((m) => m.model).sort(),
      expectedModels,
      '按模型聚合的结果必须与账本文件一致（镜像不能丢行、不能重复）',
    );

    // 失败明细：字段名与内容必须与写进去的一致
    assert.equal(usage.failures.length, 1);
    assert.equal(usage.failures[0].model, 'glm-5.3');
    assert.equal(usage.failures[0].status, 429);
    assert.equal(usage.failures[0].code, 11133);
    assert.equal(usage.failures[0].error, 'rate limited');

    // /v1/requests：新的在前，且元数据白名单字段齐全
    const requests = await (await fetch(bridge.baseUrl + '/v1/requests', { headers: auth })).json();
    assert.equal(requests.ok, true);
    assert.ok(Array.isArray(requests.requests));
    assert.equal(requests.requests.length, 3, '三条账都应当出现在最近请求里');
    assert.deepEqual(
      requests.requests.map((r) => r.model),
      ['glm-5.3', 'deepseek-v4-pro', 'deepseek-v4.1-flash'],
      '最近请求必须新的在前',
    );
    const failed = requests.requests[0];
    assert.equal(failed.ok, false);
    assert.equal(failed.status, 429);
    assert.equal(failed.code, 11133);
    // 白名单：不能带出账本里的其它字段（这里本来也没有，但形状要固定）
    assert.deepEqual(
      Object.keys(failed).sort(),
      ['code', 'error', 'model', 'ms', 'ok', 'status', 'stream', 't'],
      '/v1/requests 的字段集必须稳定（只回元数据白名单）',
    );

    // 小时视图：只有 ?hours=1 才带 hours 字段，且必须是补齐的 24 个桶
    const hourly = await (await fetch(bridge.baseUrl + '/v1/usage?days=1&hours=1', { headers: auth })).json();
    assert.ok(Array.isArray(hourly.hours), 'hours=1 时必须带 hours 数组');
    assert.equal(hourly.hours.length, 24, '小时桶必须补齐到 24 个');
    const plain = await (await fetch(bridge.baseUrl + '/v1/usage', { headers: auth })).json();
    assert.equal(plain.hours, undefined, '不带 hours=1 时不能出现 hours 字段');

    // 外部清空账本：内存镜像必须跟着作废（syncUsageMirror 的语义，不能被 D4 丢掉）
    writeFileSync(join(bridge.dir, 'usage.jsonl'), '');
    const after = await (await fetch(bridge.baseUrl + '/v1/usage', { headers: auth })).json();
    assert.equal(after.total.calls, 0, '文件被外部清空后，镜像必须一起作废（不能读回旧数据）');
    assert.equal(after.failures.length, 0);

    // 回归：外部**删除**账本文件、再换入一个**非空**文件时，镜像必须重新加载。
    //
    // 这条钉住一个真实踩过的坑：最初的重载判据是 `size < usageBytes`，而文件被
    // 删除后 usageBytes 归 0 —— `size < 0` 恒不成立，于是此后外部写进来的任何
    // 账本都读不到，镜像永久性地读成空。改成"指纹（字节数 + mtime）不一致就重载"
    // 之后才正确。先删再写，正是让 usageBytes 归零的最短路径。
    const ledger = join(bridge.dir, 'usage.jsonl');
    const externalRows = [
      { t: now - 60_000, model: 'external-a', stream: false, ms: 11, ok: true, promptTokens: 1, completionTokens: 2 },
      { t: now - 30_000, model: 'external-b', stream: false, ms: 22, ok: true, promptTokens: 3, completionTokens: 4 },
    ];
    rmSync(ledger, { force: true });
    const afterDelete = await (await fetch(bridge.baseUrl + '/v1/requests', { headers: auth })).json();
    assert.equal(afterDelete.requests.length, 0, '文件被删除后不得复活旧记录');

    writeFileSync(ledger, `${externalRows.map((r) => JSON.stringify(r)).join('\n')}\n`);
    const afterExternal = await (await fetch(bridge.baseUrl + '/v1/requests', { headers: auth })).json();
    assert.deepEqual(
      afterExternal.requests.map((r) => r.model),
      ['external-b', 'external-a'],
      '删除后外部换入的新账本必须被读到（只比大小的判据会在这里永久读成空）',
    );
  } finally {
    await bridge.stop();
    rmSync(bridge.dir, { recursive: true, force: true });
  }
});

test('桥：上游流中途断开必须记成失败（与非流式路径一致）', { timeout: 90_000 }, async () => {
  // 打桩上游：发一帧正文后**掐断连接**，模拟"回答到一半上游断了"。
  // 这是真实会出现的情况（网络抖动 / 上游重启），而客户端只会看到回答被截断。
  const upstream = createServer((req, res) => {
    const path = new URL(req.url, 'http://127.0.0.1').pathname;
    if (path === '/v2/enterprises/personal/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ code: 0, data: { models: [{ id: 'stub-stream', name: 'Stub', maxInputTokens: 128000, maxOutputTokens: 4096 }] } }));
    }
    if (path === '/v3/config') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ code: 0, data: { models: [] } }));
    }
    if (path === '/v2/chat/completions') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"部分"}}]}\n\n');
      setTimeout(() => { try { res.socket.destroy(); } catch { /* 已断 */ } }, 50);
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const upstreamBase = `http://127.0.0.1:${upstream.address().port}`;

  const bridge = await startBridge({ CODEBUDDY_ENDPOINT: upstreamBase }, { auth: READABLE_FAKE_AUTH });
  try {
    // 先抓一次目录：让模型预校验认识 stub-stream（否则会被本地 400 拦下）
    await fetch(bridge.baseUrl + '/v1/models?all=1', { headers: auth });

    const res = await fetch(bridge.baseUrl + '/v1/chat/completions', {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'stub-stream', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
      signal: AbortSignal.timeout(15000),
    });
    // 流已经以 200 开始，错误无法再改 HTTP 状态 —— 只能反映在账本里
    assert.equal(res.status, 200, '流已开始后状态只能是 200');
    try {
      const reader = res.body.getReader();
      for (;;) { const { done } = await reader.read(); if (done) break; }
    } catch { /* 上游被掐断，客户端读流异常属预期 */ }

    await new Promise((r) => setTimeout(r, 300)); // 等落账（异步写文件）
    const requests = await (await fetch(bridge.baseUrl + '/v1/requests', { headers: auth })).json();
    const row = (requests.requests || []).find((r) => r.model === 'stub-stream');
    assert.ok(row, '这次调用必须落账');
    assert.equal(row.ok, false, '上游流中断不是成功：必须记失败（曾长期被错记为 ok:true）');
    assert.ok(row.error, '失败行必须带错误原文，控制台才能显示"为什么被截断"');

    // 对照：账本的失败汇总也要能看到它（否则"失败数"统计漏报）
    const usage = await (await fetch(bridge.baseUrl + '/v1/usage?days=1', { headers: auth })).json();
    assert.equal(usage.total.failed, 1, '失败数必须把这笔算进去');
  } finally {
    await bridge.stop();
    try { upstream.close(); } catch { /* 忽略 */ }
    rmSync(bridge.dir, { recursive: true, force: true });
  }
});

test('桥：拒绝外来 Origin（DNS rebinding 防线），且不误伤本机调用', { timeout: 90_000 }, async () => {
  // 刻意用**空令牌**启动 —— 那是桥自身的默认（`WORKBUDDY_LOCAL_TOKEN` 缺省为空），
  // 也是 Origin 这道防线真正要覆盖的场景：没有令牌时，如果连 Origin 都不看，
  // 一个恶意网页就能靠 DNS rebinding 把浏览器指向 127.0.0.1 来消耗账号配额。
  const calls = { chat: 0 };
  const upstream = createServer((req, res) => {
    const path = new URL(req.url, 'http://127.0.0.1').pathname;
    if (path === '/v2/enterprises/personal/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ code: 0, data: { models: [{ id: 'origin-model', maxInputTokens: 128000, maxOutputTokens: 4096 }] } }));
    }
    if (path === '/v3/config') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ code: 0, data: { models: [] } }));
    }
    if (path === '/v2/chat/completions') {
      calls.chat += 1;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      return res.end('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n');
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const upstreamBase = `http://127.0.0.1:${upstream.address().port}`;

  const bridge = await startBridge(
    { CODEBUDDY_ENDPOINT: upstreamBase, WORKBUDDY_LOCAL_TOKEN: '' },
    { auth: READABLE_FAKE_AUTH },
  );
  const body = JSON.stringify({ model: 'origin-model', messages: [{ role: 'user', content: 'hi' }] });
  try {
    await fetch(bridge.baseUrl + '/v1/models?all=1'); // 预热目录，让预校验认识该模型

    // ① 外来 Origin（跨站形状：text/plain 简单请求）→ 403，且**一次上游都不打**
    const before = calls.chat;
    const cross = await fetch(bridge.baseUrl + '/v1/chat/completions', {
      method: 'POST',
      headers: { Origin: 'https://evil.example', 'Content-Type': 'text/plain' },
      body,
      signal: AbortSignal.timeout(15000),
    });
    assert.equal(cross.status, 403, '外来 Origin 必须被 403 拒绝');
    await cross.text();
    assert.equal(calls.chat, before, '被拒的请求绝不能打到上游（副作用必须为零）');

    // ② 回环 Origin 放行（本机网页版客户端仍然可用）
    const loop = await fetch(bridge.baseUrl + '/v1/chat/completions', {
      method: 'POST',
      headers: { Origin: 'http://127.0.0.1:9999', 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(15000),
    });
    assert.equal(loop.status, 200, '回环 Origin 必须放行');
    await loop.text();

    // ③ 无 Origin（curl / dsh 插件 / 控制台内部代理）放行
    const none = await fetch(bridge.baseUrl + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(15000),
    });
    assert.equal(none.status, 200, '无 Origin 必须放行（本机 CLI/SDK 不发这个头）');
    await none.text();

    // ④ 基础安全响应头
    const models = await fetch(bridge.baseUrl + '/v1/models');
    assert.equal(models.headers.get('x-content-type-options'), 'nosniff');
    assert.match(models.headers.get('content-security-policy') || '', /frame-ancestors 'none'/);
    await models.text();
  } finally {
    await bridge.stop();
    try { upstream.close(); } catch { /* 忽略 */ }
    rmSync(bridge.dir, { recursive: true, force: true });
  }
});

test('桥：客户端可控的 model 必须收敛类型与长度（账本/日志/回显都不能被撑爆）', { timeout: 90_000 }, async () => {
  const calls = { chat: 0 };
  const upstream = createServer((req, res) => {
    const path = new URL(req.url, 'http://127.0.0.1').pathname;
    if (path === '/v2/enterprises/personal/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ code: 0, data: { models: [{ id: 'len-model', maxInputTokens: 128000, maxOutputTokens: 4096 }] } }));
    }
    if (path === '/v3/config') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ code: 0, data: { models: [] } }));
    }
    if (path === '/v2/chat/completions') {
      calls.chat += 1;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      return res.end('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n');
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const upstreamBase = `http://127.0.0.1:${upstream.address().port}`;

  const bridge = await startBridge({ CODEBUDDY_ENDPOINT: upstreamBase }, { auth: READABLE_FAKE_AUTH });
  const post = (body) => fetch(bridge.baseUrl + '/v1/chat/completions', {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  try {
    await fetch(bridge.baseUrl + '/v1/models?all=1', { headers: auth }); // 预热目录

    // ① 超长 model：本地 400，且响应体**不能**原样回显那 30 万字符
    const huge = 'x'.repeat(300000);
    const over = await post({ model: huge, messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(over.status, 400, '超长 model 必须被本地拒绝');
    const overText = await over.text();
    assert.ok(overText.length < 1000, `400 响应体必须短（实际 ${overText.length} 字符）—— 不能回显客户端输入`);
    assert.ok(!overText.includes(huge), '响应体里不得原样回显超长 model');

    // ② 账本行必须有界，否则反复打就能把磁盘灌爆
    await new Promise((r) => setTimeout(r, 300));
    const ledger = readFileSync(join(bridge.dir, 'usage.jsonl'), 'utf8').trim().split('\n');
    const lastRow = JSON.parse(ledger[ledger.length - 1]);
    assert.ok(String(lastRow.model).length <= 210, `账本行 model 必须被截断（实际 ${String(lastRow.model).length} 字符）`);
    assert.equal(lastRow.ok, false);

    // ③ /v1/requests 回显也必须是有界的
    const reqs = await (await fetch(bridge.baseUrl + '/v1/requests', { headers: auth })).json();
    assert.ok(String(reqs.requests[0].model || '').length <= 210, '/v1/requests 的 model 不得原样回显超长串');

    // ④ model 不是字符串（数组/对象/数字/布尔）→ 类型混淆会让"长度"判断失效，必须拒
    for (const badModel of [['a', 'b'], { id: 'x' }, 123, true]) {
      const r = await post({ model: badModel, messages: [{ role: 'user', content: 'hi' }] });
      assert.equal(r.status, 400, `model=${JSON.stringify(badModel)} 必须被拒（必须是字符串）`);
      await r.text();
    }

    // ⑤ `null` / 缺省视同"没给" → 沿用原有的默认模型回落（不算类型错误）
    for (const missing of [null, undefined]) {
      const r = await post({ model: missing, messages: [{ role: 'user', content: 'hi' }] });
      assert.equal(r.status, 200, `model=${String(missing)} 应当回落到默认模型，而不是被拒`);
      await r.text();
    }

    // ⑥ 正常模型不受影响
    const before = calls.chat;
    const okModel = await post({ model: 'len-model', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(okModel.status, 200);
    await okModel.text();
    assert.equal(calls.chat, before + 1, '合法模型必须照常打到上游');
  } finally {
    await bridge.stop();
    try { upstream.close(); } catch { /* 忽略 */ }
    rmSync(bridge.dir, { recursive: true, force: true });
  }
});

test('桥：刷新失败时不得把响应体写进日志（响应体可能带 accessToken）', { timeout: 90_000 }, async () => {
  const SENTINEL = 'SENTINEL-ACCESS-TOKEN-MUST-NOT-BE-LOGGED';
  const upstream = createServer((req, res) => {
    const path = new URL(req.url, 'http://127.0.0.1').pathname;
    if (path === '/v2/plugin/auth/token/refresh') {
      // 关键形状：**非 2xx，但响应体里带着 accessToken** —— 这正是"打印响应体"
      // 会把令牌落进 bridge.log 的场景（失败条件含 !res.ok）。
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ code: 0, data: { accessToken: SENTINEL, refreshToken: SENTINEL } }));
    }
    if (path === '/v2/chat/completions') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      return res.end('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n');
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const upstreamBase = `http://127.0.0.1:${upstream.address().port}`;

  // expiresAt 只剩 60 秒（< 5 分钟 skew）→ 请求会先触发一次 token 刷新
  const nearExpiry = {
    auth: {
      accessToken: 'fake-access-token',
      refreshToken: 'fake-refresh-token',
      domain: 'example.invalid',
      expiresAt: Date.now() + 60_000,
    },
  };
  const bridge = await startBridge(
    { CODEBUDDY_ENDPOINT: upstreamBase, WORKBUDDY_LOG: '1' },
    { auth: nearExpiry },
  );
  try {
    const r = await fetch(bridge.baseUrl + '/v1/chat/completions', {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: 'hi' }] }),
      signal: AbortSignal.timeout(15000),
    });
    await r.text().catch(() => '');
    await new Promise((res) => setTimeout(res, 400));

    // 路径确实走到了（否则这条断言是空转）
    assert.match(bridge.out(), /refresh failed/, '应当记录了一次刷新失败（用例必须真的覆盖到目标路径）');
    assert.ok(!bridge.out().includes(SENTINEL), '日志里不得出现刷新响应体里的令牌（违反"不落盘令牌"）');
  } finally {
    await bridge.stop();
    try { upstream.close(); } catch { /* 忽略 */ }
    rmSync(bridge.dir, { recursive: true, force: true });
  }
});

test('桥：keep-alive 连接被复用，且复用连接被掐断时自动换新连接重试', { timeout: 90_000 }, async () => {
  // 两个断言点：
  //  ① 复用：第二次对话请求命中上游**同一个** TCP socket（server 端连接计数不涨）；
  //  ② 稳定：上游把空闲 socket 掐断后，下一次请求必须成功（桥换新连接重试一次），
  //     客户端看到的是正常回答，而不是 ECONNRESET。
  let socketsOpened = 0;
  let chatCalls = 0;
  const upstream = createServer((req, res) => {
    const path = new URL(req.url, 'http://127.0.0.1').pathname;
    if (path === '/v2/enterprises/personal/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ code: 0, data: { models: [{ id: 'ka-model', maxInputTokens: 128000, maxOutputTokens: 4096 }] } }));
    }
    if (path === '/v3/config') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ code: 0, data: { models: [] } }));
    }
    if (path === '/v2/chat/completions') {
      chatCalls += 1;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`data: {"choices":[{"delta":{"content":"call${chatCalls}"}}]}\n\ndata: [DONE]\n\n`);
      if (chatCalls === 3) {
        // 第 3 次：应答完整返回**之后**掐掉底层 socket，
        // 让 Agent 池里留一条**服务端已关闭**的死连接给第 4 次。
        setTimeout(() => { try { res.socket.destroy(); } catch { /* 已断 */ } }, 30);
      }
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{}');
  });
  upstream.on('connection', () => { socketsOpened += 1; });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const upstreamBase = `http://127.0.0.1:${upstream.address().port}`;

  const bridge = await startBridge({ CODEBUDDY_ENDPOINT: upstreamBase }, { auth: READABLE_FAKE_AUTH });
  const chat = () => fetch(bridge.baseUrl + '/v1/chat/completions', {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'ka-model', messages: [{ role: 'user', content: 'hi' }] }),
    signal: AbortSignal.timeout(15000),
  }).then((r) => r.text());
  try {
    await fetch(bridge.baseUrl + '/v1/models?all=1'); // 预热目录，让预校验认识 ka-model

    const r1 = await chat();
    const socketsAfterFirst = socketsOpened;
    const r2 = await chat();
    assert.match(r1, /call1/);
    assert.match(r2, /call2/);
    assert.equal(socketsOpened, socketsAfterFirst, '第二次请求必须复用同一条 keep-alive 连接（不得新开 socket）');

    // 第 3 次：正常拿到回答，但上游随后掐掉 socket（池子里留下一条死连接）
    const r3 = await chat();
    assert.match(r3, /call3/);
    await new Promise((r) => setTimeout(r, 100)); // 等 socket 真正被掐断

    // 第 4 次：撞上死连接 → 桥自动换新连接重试并成功（对客户端透明）
    const r4 = await chat();
    assert.match(r4, /call4/, '复用连接被掐断后必须自动重试成功，客户端无感');
  } finally {
    await bridge.stop();
    try { upstream.close(); } catch { /* 忽略 */ }
    rmSync(bridge.dir, { recursive: true, force: true });
  }
});
