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
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
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

/**
 * 用**原始 socket** 发一个请求，返回状态码。
 *
 * 为什么不用 `fetch`：**Fetch 规范把 `Host` 列为禁止头**，用它根本发不出去 ——
 * 排查「畸形 Host」时用 `fetch` 只会得到假阴性（第一次就是这么误判的）。
 */
function rawStatus(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, path, method: 'GET', headers: { authorization: `Bearer ${TOKEN}`, ...headers } },
      (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); },
    );
    req.on('error', reject);
    req.end();
  });
}

// ── 打桩上游：验证「桥实际发了什么出去」─────────────────────────────────
/**
 * 记录收到的每个请求（headers/body），回最小 SSE。
 *
 * 配合 `CODEBUDDY_ENDPOINT` 把桥的出站流量全部导向这里 —— 审计模板改写、
 * 出站身份指纹、限流计数之类的断言都靠它（不触真上游、不耗额度）。
 *
 * @param {string[]} [models] `/v2/enterprises/personal/models` 返回的模型 id
 */
async function startStubUpstream(models = ['stub-model'], opts = {}) {
  const seen = [];
  /** `/v2/plugin/auth/token/refresh` 被调了几次 —— 「并发只刷一次」的用例靠它判定。 */
  let refreshCalls = 0;
  const srv = createServer((req, res) => {
    const path = new URL(req.url, 'http://127.0.0.1').pathname;
    if (path === '/v2/enterprises/personal/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        code: 0,
        data: { models: models.map((id) => ({ id, maxInputTokens: 128000, maxOutputTokens: 4096 })) },
      }));
    }
    /*
     * 刷新端点：给「并发只刷一次」的用例用。
     *
     * **故意慢**（默认 200ms）—— 否则并发请求可能前后错开：第一个刷新完，
     * 第二个才发现令牌已经新鲜，于是「没做单飞」也能凑出 1 次，用例就测不出差异。
     * 慢一点才能让 N 个请求真的同时在飞。
     */
    if (path === '/v2/plugin/auth/token/refresh') {
      refreshCalls += 1;
      const n = refreshCalls;
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          code: 0,
          data: { accessToken: `refreshed-${n}`, refreshToken: `rotated-${n}`, expiresIn: 3600, refreshExpiresIn: 86400 },
        }));
      }, opts.refreshDelayMs ?? 200);
      return;
    }
    if (path === '/v3/config') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ code: 0, data: { models: [] } }));
    }
    if (path === '/v2/chat/completions') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        seen.push({ headers: req.headers, body });
        /*
         * `opts.chatRaw`：模拟「上游 HTTP 200，但返回的不是 SSE」。
         * 网关把错误包成 200 的 HTML 是真实会发生的（见 BUG-2 的用例）。
         */
        if (opts.chatRaw !== undefined) {
          res.writeHead(opts.chatStatus || 200, { 'content-type': opts.chatType || 'text/html' });
          return res.end(opts.chatRaw);
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n');
        res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}\n\n');
        res.end('data: [DONE]\n\n');
      });
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return {
    base: `http://127.0.0.1:${srv.address().port}`,
    seen,
    get refreshCalls() { return refreshCalls; },
    close: () => new Promise((r) => srv.close(r)),
  };
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

  /*
   * 用自动生成的令牌（传空 = 让桥自己生成），再从启动日志里取出来。
   *
   * 注意这里**不能在 `WORKBUDDY_LOCAL_TOKEN: ''` 下裸跑请求** —— 那正是
   * 「未配置即放行」的旧契约，已被「不得静默放行」用例推翻。本用例要验的是
   * **Origin 这道防线**，所以必须在一个合法令牌之上比对，否则 403 会被 401 抢先。
   */
  const bridge = await startBridge(
    { CODEBUDDY_ENDPOINT: upstreamBase, WORKBUDDY_LOCAL_TOKEN: '' },
    { auth: READABLE_FAKE_AUTH },
  );
  const autoToken = bridge.out().match(/WORKBUDDY_LOCAL_TOKEN=([A-Za-z0-9._-]{16,})/)?.[1];
  assert.ok(autoToken, '本用例依赖桥自动生成令牌（启动日志里应有 WORKBUDDY_LOCAL_TOKEN=…）');
  const bearer = { authorization: `Bearer ${autoToken}` };
  const body = JSON.stringify({ model: 'origin-model', messages: [{ role: 'user', content: 'hi' }] });
  try {
    await fetch(bridge.baseUrl + '/v1/models?all=1', { headers: bearer }); // 预热目录，让预校验认识该模型

    // ① 外来 Origin（跨站形状：text/plain 简单请求）→ 403，且**一次上游都不打**
    const before = calls.chat;
    const cross = await fetch(bridge.baseUrl + '/v1/chat/completions', {
      method: 'POST',
      headers: { ...bearer, Origin: 'https://evil.example', 'Content-Type': 'text/plain' },
      body,
      signal: AbortSignal.timeout(15000),
    });
    assert.equal(cross.status, 403, '外来 Origin 必须被 403 拒绝');
    await cross.text();
    assert.equal(calls.chat, before, '被拒的请求绝不能打到上游（副作用必须为零）');

    // ② 回环 Origin 放行（本机网页版客户端仍然可用）
    const loop = await fetch(bridge.baseUrl + '/v1/chat/completions', {
      method: 'POST',
      headers: { ...bearer, Origin: 'http://127.0.0.1:9999', 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(15000),
    });
    assert.equal(loop.status, 200, '回环 Origin 必须放行');
    await loop.text();

    // ③ 无 Origin（curl / dsh 插件 / 控制台内部代理）放行
    const none = await fetch(bridge.baseUrl + '/v1/chat/completions', {
      method: 'POST',
      headers: { ...bearer, 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(15000),
    });
    assert.equal(none.status, 200, '无 Origin 必须放行（本机 CLI/SDK 不发这个头）');
    await none.text();

    // ④ 基础安全响应头
    const models = await fetch(bridge.baseUrl + '/v1/models', { headers: bearer });
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

test('桥：出站 system 已做审计模板最小改写（黑名单原文不得出现在上游看到的请求里）', { timeout: 90_000 }, async () => {
  // 背景（2026-10-08 实测）：带 Claude Code 原文模板的请求被上游**逐字拉黑**
  // —— 400 `Illegal API invocation from an unapproved channel`；按报告
  // §8.7 #44 最小改写（CLI→CLI tool、Main branch→Default branch）后放行。
  // 本用例把「出站不含黑名单原文」钉死为回归（打桩上游直接审视桥发了什么）。
  const stub = await startStubUpstream(['audit-model']);
  const bridge = await startBridge({ CODEBUDDY_ENDPOINT: stub.base }, { auth: READABLE_FAKE_AUTH });
  try {
    await fetch(bridge.baseUrl + '/v1/models?all=1'); // 预热目录，让预校验认识 audit-model

    const res = await fetch(bridge.baseUrl + '/v1/messages', {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'audit-model',
        max_tokens: 16,
        system: [
          { type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." },
          { type: 'text', text: 'Main branch (you will usually use this for PRs)' },
        ],
        messages: [{ role: 'user', content: 'ping' }],
      }),
      signal: AbortSignal.timeout(15000),
    });
    assert.equal(res.status, 200);
    await res.text();

    assert.equal(stub.seen.length, 1, '桥应向上游发出恰好一条聊天请求');
    const outbound = JSON.parse(stub.seen[0].body);
    const sysText = outbound.messages
      .filter((m) => m.role === 'system')
      .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
      .join('\n');
    assert.ok(!sysText.includes("Anthropic's official CLI for Claude."),
      '出站 system 不得含黑名单原文（…official CLI for Claude.）');
    assert.ok(!sysText.includes('Main branch (you will usually use this for PRs)'),
      '出站 system 不得含黑名单原文（Main branch …）');
    assert.ok(sysText.includes("Anthropic's official CLI tool for Claude."),
      '应含最小改写后的形态（CLI tool）');
    assert.ok(sysText.includes('Default branch (you will usually use this for PRs)'),
      '应含最小改写后的形态（Default branch）');
  } finally {
    await bridge.stop();
    try { await stub.close(); } catch { /* 忽略 */ }
    rmSync(bridge.dir, { recursive: true, force: true });
  }
});

test('桥：出站身份指纹可用 env 覆盖（上游版本漂移时的逃生门）', { timeout: 90_000 }, async () => {
  // 上游按 UA / X-IDE-* / X-Product-Version 校验调用来源；官方客户端升级后
  // 旧指纹可能整体被拒。三个值必须能用 .env（→ bridgeEnv → 桥）覆盖，
  // 否则用户只能改源码 —— 这是报告 §8.6 风险 1 的最低成本逃生门。
  const stub = await startStubUpstream(['id-model']);
  const bridge = await startBridge(
    {
      CODEBUDDY_ENDPOINT: stub.base,
      WORKBUDDY_APP_VERSION: '9.9.9-test',
      WORKBUDDY_IDE_NAME: 'TestIDE',
      // IDE_VERSION 故意不覆盖 → 应保持默认
    },
    { auth: READABLE_FAKE_AUTH },
  );
  try {
    await fetch(bridge.baseUrl + '/v1/models?all=1'); // 预热目录，让预校验认识 id-model
    const res = await fetch(bridge.baseUrl + '/v1/chat/completions', {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'id-model', messages: [{ role: 'user', content: 'hi' }] }),
      signal: AbortSignal.timeout(15000),
    });
    assert.equal(res.status, 200);
    await res.text();

    assert.equal(stub.seen.length, 1);
    const h = stub.seen[0].headers;
    assert.equal(h['user-agent'], 'TestIDE/1.119.0 CodeBuddy/9.9.9-test',
      'UA 应由 env 覆盖的 IDE 名/版本与 App 版本拼出，未覆盖项保持默认');
    assert.equal(h['x-ide-name'], 'TestIDE');
    assert.equal(h['x-ide-version'], '1.119.0', '未设置的 IDE_VERSION 应保持默认值');
    assert.equal(h['x-product-version'], '9.9.9-test');
  } finally {
    await bridge.stop();
    try { await stub.close(); } catch { /* 忽略 */ }
    rmSync(bridge.dir, { recursive: true, force: true });
  }
});

test('桥：本地限流 reject 模式 —— 上限 N 时上游恰好收到 N 条，第 N+1 条 429 + Retry-After', { timeout: 90_000 }, async () => {
  const stub = await startStubUpstream(['rl-model']);
  const bridge = await startBridge(
    {
      CODEBUDDY_ENDPOINT: stub.base,
      WORKBUDDY_RATE_LIMIT_RPM: '2',
      WORKBUDDY_RATE_LIMIT_MODE: 'reject',
    },
    { auth: READABLE_FAKE_AUTH },
  );
  const chat = () => fetch(bridge.baseUrl + '/v1/chat/completions', {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'rl-model', messages: [{ role: 'user', content: 'hi' }] }),
    signal: AbortSignal.timeout(15000),
  });
  try {
    await fetch(bridge.baseUrl + '/v1/models?all=1'); // 预热目录（不打 chat，不消耗许可）

    const r1 = await chat();
    const r2 = await chat();
    const r3 = await chat();
    await r1.text(); await r2.text(); await r3.text();

    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
    assert.equal(r3.status, 429, '第 3 条必须被限流拒绝');
    assert.ok(Number(r3.headers.get('retry-after')) >= 1, 'Retry-After 头必须存在且 ≥1 秒');
    assert.equal(stub.seen.length, 2, '上游恰好收到 2 条 —— 被限流的请求不得打上游');

    // 账本归因：被限流的请求要留下 rate_limited 痕迹（控制台据此可见）
    await new Promise((r) => setTimeout(r, 100)); // 等账本落盘
    const ledger = readFileSync(join(bridge.dir, 'usage.jsonl'), 'utf8');
    assert.match(ledger, /rate_limited/, '账本必须记录限流归因');
  } finally {
    await bridge.stop();
    try { await stub.close(); } catch { /* 忽略 */ }
    rmSync(bridge.dir, { recursive: true, force: true });
  }
});

test('桥：本地限流 queue 模式 —— 并发请求按最小间隔排队放行，不拒绝', { timeout: 90_000 }, async () => {
  const stub = await startStubUpstream(['rl2-model']);
  const bridge = await startBridge(
    {
      CODEBUDDY_ENDPOINT: stub.base,
      WORKBUDDY_RATE_LIMIT_MIN_INTERVAL_MS: '400',
      WORKBUDDY_RATE_LIMIT_MODE: 'queue',
    },
    { auth: READABLE_FAKE_AUTH },
  );
  const chat = () => fetch(bridge.baseUrl + '/v1/chat/completions', {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'rl2-model', messages: [{ role: 'user', content: 'hi' }] }),
    signal: AbortSignal.timeout(20000),
  });
  try {
    await fetch(bridge.baseUrl + '/v1/models?all=1');

    const t0 = Date.now();
    const rs = await Promise.all([chat(), chat(), chat()]); // 并发：必须被串行化排队
    const elapsed = Date.now() - t0;
    for (const r of rs) {
      assert.equal(r.status, 200, 'queue 模式不得拒绝');
      await r.text();
    }
    assert.equal(stub.seen.length, 3, '三条最终都要发往上游');
    // 第 1 条立即、第 2 条等 ~400ms、第 3 条等 ~800ms —— 明显长于"无排队"的几十毫秒
    assert.ok(elapsed >= 700, `并发三条在 400ms 最小间隔下应排队 ≥700ms（实测 ${elapsed}ms）`);
  } finally {
    await bridge.stop();
    try { await stub.close(); } catch { /* 忽略 */ }
    rmSync(bridge.dir, { recursive: true, force: true });
  }
});

test('桥：开销头与进程计数 —— 响应带 X-WorkBuddy-Overhead-Ms，/health 报 process 段', { timeout: 90_000 }, async () => {
  const stub = await startStubUpstream(['ov-model']);
  const bridge = await startBridge({ CODEBUDDY_ENDPOINT: stub.base }, { auth: READABLE_FAKE_AUTH });
  try {
    await fetch(bridge.baseUrl + '/v1/models?all=1');

    const res = await fetch(bridge.baseUrl + '/v1/chat/completions', {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'ov-model', messages: [{ role: 'user', content: 'hi' }] }),
      signal: AbortSignal.timeout(15000),
    });
    assert.equal(res.status, 200);
    const raw = res.headers.get('x-workbuddy-overhead-ms');
    const overhead = Number(raw);
    assert.ok(raw !== null && Number.isFinite(overhead) && overhead >= 0,
      `对话响应必须带 ≥0 的开销头（实测 ${raw}）`);
    await res.text();

    // /health 的进程计数：真实请求入账、探活不入账
    const health = await fetch(bridge.baseUrl + '/health', { headers: auth, signal: AbortSignal.timeout(10000) }).then((r) => r.json());
    assert.equal(health.ok, true);
    assert.ok(health.process && typeof health.process.requests === 'number', '/health 必须带 process 段');
    assert.ok(health.process.requests >= 2, `进程计数应 ≥2（models 预热 + chat），实测 ${health.process.requests}`);
    assert.ok((health.process.byStatus['200'] || 0) >= 2, '状态码分布应含 200');
  } finally {
    await bridge.stop();
    try { await stub.close(); } catch { /* 忽略 */ }
    rmSync(bridge.dir, { recursive: true, force: true });
  }
});

test('桥：在途请求可见 —— 成功 / 失败 / 客户端断开三条路径都正确登记与释放', { timeout: 120_000 }, async () => {
  // stub 上游可以"挂起"（等测试放行才响应），用来制造稳定的"进行中"观察窗口。
  let releaseHold = null;
  let holdGate = new Promise((r) => { releaseHold = r; });
  let mode = 'ok';
  const upstream = createServer((req, res) => {
    const path = new URL(req.url, 'http://127.0.0.1').pathname;
    if (path === '/v2/enterprises/personal/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ code: 0, data: { models: [{ id: 'act-model', maxInputTokens: 128000, maxOutputTokens: 4096 }] } }));
    }
    if (path === '/v3/config') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ code: 0, data: { models: [] } }));
    }
    if (path === '/v2/chat/completions') {
      req.resume();
      (async () => {
        await holdGate; // 「挂起」：模拟长回答 / 卡死中的上游
        if (mode === 'fail') {
          res.writeHead(500, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ code: 50000, msg: 'boom' }));
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n');
        res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}\n\n');
        res.end('data: [DONE]\n\n');
      })();
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const bridge = await startBridge(
    { CODEBUDDY_ENDPOINT: `http://127.0.0.1:${upstream.address().port}` },
    { auth: READABLE_FAKE_AUTH },
  );

  const reqs = () => fetch(bridge.baseUrl + '/v1/requests', { headers: auth, signal: AbortSignal.timeout(5000) }).then((r) => r.json());
  const waitFor = async (pred, label) => {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const d = await reqs();
      if (pred(d)) return d;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`等待超时：${label}`);
  };
  const resetGate = () => { holdGate = new Promise((r) => { releaseHold = r; }); };
  const chat = (signal) => fetch(bridge.baseUrl + '/v1/chat/completions', {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'act-model', messages: [{ role: 'user', content: 'hi' }] }),
    signal,
  });

  try {
    await fetch(bridge.baseUrl + '/v1/models?all=1'); // 预热目录

    // ① 成功路径：登记 → 放行 → 释放
    mode = 'ok'; resetGate();
    const p1 = chat(AbortSignal.timeout(30000));
    const seen = await waitFor((d) => d.active.length === 1, '出现进行中条目');
    assert.equal(seen.active[0].model, 'act-model');
    assert.ok(seen.active[0].id, '进行中条目必须带 id');
    assert.ok(typeof seen.active[0].runningMs === 'number' && seen.active[0].runningMs >= 0,
      'runningMs 必须存在（UI 的「已运行」时长靠它）');
    assert.ok(typeof seen.activeAlertMs === 'number' && seen.activeAlertMs > 0,
      'activeAlertMs 必须随响应带回（阈值由桥单点定义）');
    releaseHold();
    const r1 = await p1; await r1.text();
    assert.equal(r1.status, 200);
    await waitFor((d) => d.active.length === 0, '成功后被释放');

    // ② 失败路径：上游 500 → 同样释放
    mode = 'fail'; resetGate();
    const p2 = chat(AbortSignal.timeout(30000));
    await waitFor((d) => d.active.length === 1, '失败场景出现进行中条目');
    releaseHold();
    const r2 = await p2; await r2.text();
    assert.equal(r2.status, 500);
    await waitFor((d) => d.active.length === 0, '失败后被释放');

    // ③ 客户端断开：abort → 同样释放（注册表不得泄漏）
    mode = 'ok'; resetGate();
    const ac = new AbortController();
    const p3 = chat(ac.signal).catch(() => null);
    await waitFor((d) => d.active.length === 1, '断开场景出现进行中条目');
    ac.abort();
    await p3;
    await waitFor((d) => d.active.length === 0, '客户端断开后被释放');
  } finally {
    try { releaseHold(); } catch { /* 忽略 */ }
    await bridge.stop();
    try { upstream.close(); } catch { /* 忽略 */ }
    rmSync(bridge.dir, { recursive: true, force: true });
  }
});

test('桥：count_tokens —— 规范同形、纯本地估算（不打上游）、中文按字计', { timeout: 90_000 }, async () => {
  const stub = await startStubUpstream(['ct-model']);
  const bridge = await startBridge({ CODEBUDDY_ENDPOINT: stub.base }, { auth: READABLE_FAKE_AUTH });
  const countTokens = (payload) => fetch(bridge.baseUrl + '/v1/messages/count_tokens', {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10000),
  });
  try {
    // 中文：每字 ≥ 1 token（旧的"字节/4"会把中文算少一半以上）
    const cn = await countTokens({ model: 'ct-model', messages: [{ role: 'user', content: '你好世界'.repeat(25) }] });
    assert.equal(cn.status, 200);
    const cnBody = await cn.json();
    assert.ok(typeof cnBody.input_tokens === 'number' && cnBody.input_tokens >= 100,
      `中文 100 字应估算 ≥100 token（实测 ${cnBody.input_tokens}）`);

    // ASCII：≈ 4 字符/token（400 字符的 system ≈ 100）
    const en = await countTokens({ model: 'ct-model', system: 'a'.repeat(400), messages: [{ role: 'user', content: 'hi' }] });
    const enBody = await en.json();
    assert.ok(enBody.input_tokens >= 100 && enBody.input_tokens <= 120,
      `400 个 ASCII 字符应估算 ≈100–120（实测 ${enBody.input_tokens}）`);

    // 纯本地：这个端点一条请求都不该打到上游
    assert.equal(stub.seen.length, 0, 'count_tokens 不得触达上游（没有 tokenizer 可打）');
  } finally {
    await bridge.stop();
    try { await stub.close(); } catch { /* 忽略 */ }
    rmSync(bridge.dir, { recursive: true, force: true });
  }
});

test('桥：客户端凭据分层 —— key 鉴权、账本归因、独立限流桶', { timeout: 120_000 }, async () => {
  const stub = await startStubUpstream(['ck-model']);
  const bridge = await startBridge(
    {
      CODEBUDDY_ENDPOINT: stub.base,
      WORKBUDDY_CLIENT_KEYS: 'key-aaa,key-bbb',
      WORKBUDDY_RATE_LIMIT_RPM: '2',
      WORKBUDDY_RATE_LIMIT_MODE: 'reject',
    },
    { auth: READABLE_FAKE_AUTH },
  );
  const chat = (token) => fetch(bridge.baseUrl + '/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'ck-model', messages: [{ role: 'user', content: 'hi' }] }),
    signal: AbortSignal.timeout(15000),
  });
  try {
    // ① LOCAL_TOKEN 仍然万能（管理面 / 控制台用它）
    const rLocal = await chat(TOKEN);
    assert.equal(rLocal.status, 200, 'LOCAL_TOKEN 必须仍然可用');
    await rLocal.text();

    // ② client key 可用；未登记的 key 401
    const rA = await chat('key-aaa');
    assert.equal(rA.status, 200, '已登记的 client key 应被接受');
    await rA.text();
    const rBad = await chat('key-wrong');
    assert.equal(rBad.status, 401, '未登记的 key 必须 401');
    await rBad.text();

    // ③ per-key 限流：key-aaa 的桶打满 → 429；key-bbb 的桶独立不受影响
    const rA2 = await chat('key-aaa');
    assert.equal(rA2.status, 200);
    await rA2.text();
    const rA3 = await chat('key-aaa');
    assert.equal(rA3.status, 429, 'key-aaa 第 3 条应被自己的桶限流');
    await rA3.text();
    const rB1 = await chat('key-bbb');
    assert.equal(rB1.status, 200, 'key-bbb 的桶独立，不受 key-aaa 打满影响');
    await rB1.text();

    // ④ 账本归因：client key 的记录带「哈希前 8 位」，明文绝不落账
    await new Promise((r) => setTimeout(r, 100));
    const ledger = readFileSync(join(bridge.dir, 'usage.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const expected = createHash('sha256').update('key-aaa').digest('hex').slice(0, 8);
    assert.ok(ledger.some((l) => l.client === expected), 'key-aaa 的记录必须带哈希前 8 位归因');
    assert.ok(ledger.some((l) => l.client === 'local'), 'LOCAL_TOKEN 的记录归因为 local');
    assert.ok(!ledger.some((l) => String(l.client || '').includes('key-aaa')), '明文 key 不得出现在账本');
  } finally {
    await bridge.stop();
    try { await stub.close(); } catch { /* 忽略 */ }
    rmSync(bridge.dir, { recursive: true, force: true });
  }
});

/**
 * 畸形 `Host` 头必须回 400，**进程必须活着**。
 *
 * 踩过的坑：`handleRequest` 里 `new URL(req.url, 'http://' + req.headers.host)`
 * 原先在 `try` **之外**，而 Host 是客户端可控的 —— `new URL()` 对
 * `Host: bad host with spaces` 抛 `ERR_INVALID_URL`，异常没被捕获，
 * Node 直接退出进程（实测 exitCode=1）。也就是说**任何能访问本机端口的进程
 * 用一条请求就能把桥打死**，之后控制台/插件只会显示「桥未运行」。
 *
 * 用原始 socket 发：`fetch` 发不出自定义 Host（Fetch 规范把它列为禁止头），
 * 用它测这条只会得到假阴性。
 */
test('桥：畸形 Host 头回 400，且进程不被带走', { timeout: 30_000 }, async () => {
  const bridge = await startBridge();
  try {
    const port = Number(new URL(bridge.baseUrl).port);
    const status = await rawStatus(port, '/v1/models', { Host: 'bad host with spaces' });
    assert.equal(status, 400, '畸形 Host 应当按非法请求挡下（400）');

    await new Promise((r) => setTimeout(r, 300));
    const health = await fetch(`${bridge.baseUrl}/health`, {
      headers: { authorization: `Bearer ${TOKEN}` }, signal: AbortSignal.timeout(3000),
    });
    assert.ok(health.status > 0, '桥必须还活着 —— 畸形 Host 不该让进程退出');
    assert.ok(
      !/ERR_INVALID_URL|Unhandled/i.test(bridge.out()),
      `输出里不该有未捕获异常：\n${bridge.out().slice(-300)}`,
    );
  } finally {
    await bridge.stop();
    rmSync(bridge.dir, { recursive: true, force: true });
  }
});

/**
 * 上游回 **HTTP 200 但内容不是 SSE**（典型：网关把错误包成 200 的 HTML）时，
 * 桥必须**记失败**，不能回 200 + 空内容。
 *
 * 踩过的坑：非流式路径在 `aggregateStream()` 之后**无条件** `ok: true`，
 * 于是上游给一坨 HTML 时，客户端拿到的是「结构完整但 content 为空」的成功响应，
 * 账本记 `{"ok":true,"promptTokens":0,"completionTokens":0}` ——
 * 用户以为模型没说话，控制台的成功率还把它算作成功。**静默错数据**比报错更难查。
 *
 * `choices: []` 是同一类：一个 SSE 块都没解析出内容。
 */
test('桥：上游 200 但不是 SSE → 记失败，不回「空回答成功」', { timeout: 30_000 }, async () => {
  const stub = await startStubUpstream(['stub-model'], { chatRaw: '<html>gateway error</html>' });
  /*
   * **必须用 READABLE_FAKE_AUTH**：默认的 FAKE_AUTH 是扁平的（刻意用来复现
   * 「凭据异常」），桥读到它会直接 500 —— 那样断言会因为「请求压根没走到 chat
   * 路径」而变绿，是假绿。第一版就是这么写的，靠打印实际响应才发现。
   */
  const bridge = await startBridge({ CODEBUDDY_ENDPOINT: stub.base }, { auth: READABLE_FAKE_AUTH });
  try {
    const res = await fetch(`${bridge.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'stub-model', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.ok(res.status >= 400, `上游返回非 SSE 时不能回 200（实际 ${res.status}）`);

    await new Promise((r) => setTimeout(r, 300));
    const ledger = readFileSync(join(bridge.dir, 'usage.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const last = ledger[ledger.length - 1];
    assert.equal(last.ok, false, '账本必须记失败 —— 否则控制台把它算作成功（静默错数据）');
  } finally {
    await bridge.stop();
    try { await stub.close(); } catch { /* 忽略 */ }
    rmSync(bridge.dir, { recursive: true, force: true });
  }
});

/**
 * 账本超过 `MAX_USAGE_LINES`(2000) 时的**截断路径** —— 这条路径此前从未被执行过。
 *
 * 它做的是「重写整份文件」，而原来是直接 `writeFileSync` 覆盖：进程正好在这时
 * 被杀 / 断电就留下半份文件，丢的是用户自己的用量历史（项目里没有第二份副本）。
 * 现在改成「写临时文件 + rename」原子替换。
 *
 * 断言里那句「每一行都必须是合法 JSON」就是用来抓半截行的：
 * 非原子写入一旦发生，文件末尾会出现一行断掉的 JSON。
 */
test('桥：账本截断保留最近一半，且每行仍是合法 JSON（原子替换）', { timeout: 30_000 }, async () => {
  const stub = await startStubUpstream(['stub-model']);
  const bridge = await startBridge({ CODEBUDDY_ENDPOINT: stub.base }, { auth: READABLE_FAKE_AUTH });
  try {
    const file = join(bridge.dir, 'usage.jsonl');
    const pre = Array.from({ length: 2001 }, (_, i) => JSON.stringify({
      t: Date.now() - (2001 - i) * 1000, model: 'pre', stream: false, ms: 1, ok: true,
    }));
    writeFileSync(file, `${pre.join('\n')}\n`);

    await fetch(`${bridge.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'stub-model', messages: [{ role: 'user', content: 'hi' }] }),
    });
    await new Promise((r) => setTimeout(r, 400));

    const lines = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
    assert.ok(lines.length <= 1002, `截断后应保留最近一半，实际 ${lines.length} 行`);
    assert.ok(lines.length >= 900, `不该把账本清空，实际 ${lines.length} 行`);
    for (const l of lines) JSON.parse(l); // 半截行会在这里抛
    assert.ok(!existsSync(`${file}.tmp`), '临时文件必须被 rename 掉，不该留在目录里');
  } finally {
    await bridge.stop();
    try { await stub.close(); } catch { /* 忽略 */ }
    rmSync(bridge.dir, { recursive: true, force: true });
  }
});

/**
 * Anthropic 流式：上游把 `function.name` **分片**下发时，工具名必须拼完整。
 *
 * 踩过的坑：slot 建立时把首片写进了 `name`，追加的守卫却是 `!slot.name` ——
 * 首片非空，所以除首片外的分片全被丢掉，客户端拿到的是截断的名字（`get_`），
 * 工具调用必然失败。`+=` 本身就说明这里预期分片到达，两者自相矛盾。
 *
 * 附带一层：`content_block_start` 原先在**建槽时**就发出去了，里面带着当时那个
 * 半截名字 —— 所以光把守卫改掉不够，得把 start 推迟到名字收齐（参数开始到达）。
 */
test('桥：Anthropic 流式工具名分片必须拼完整（不能只留首片）', { timeout: 30_000 }, async () => {
  const sse = [
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"get_"}}]}}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"weather"}}]}}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"city\\":"}}]}}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"SF\\"}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":5,"completion_tokens":6}}',
    'data: [DONE]',
    '',
  ].join('\n\n');
  const stub = await startStubUpstream(['stub-model'], { chatRaw: sse, chatType: 'text/event-stream' });
  const bridge = await startBridge({ CODEBUDDY_ENDPOINT: stub.base }, { auth: READABLE_FAKE_AUTH });
  try {
    const res = await fetch(`${bridge.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'stub-model', max_tokens: 64, stream: true,
        messages: [{ role: 'user', content: 'weather?' }],
      }),
    });
    const text = await res.text();
    assert.match(text, /"name":"get_weather"/, `工具名必须拼完整；实际输出里没有 get_weather：\n${text.slice(0, 400)}`);
    assert.ok(!/"name":"get_"/.test(text), '不能把首片当成完整名字发出去');
    assert.ok(text.includes('event: message_stop'), '流必须正常收尾');
  } finally {
    await bridge.stop();
    try { await stub.close(); } catch { /* 忽略 */ }
    rmSync(bridge.dir, { recursive: true, force: true });
  }
});

/**
 * 令牌过期瞬间的并发请求，**只该刷新一次**（单飞）。
 *
 * 为什么必须有：响应里可能带**轮换后的 refreshToken**，后到的请求拿的是已经
 * 作废的旧令牌 —— 必然失败，于是写 `lastRefreshFailedAt`，把接下来 15 秒内
 * **所有**刷新都挡住（包括本该成功的）。确定的代价是每次过期多打 N-1 次上游
 * 刷新；更坏的推测是上游对 refreshToken 做「重复使用即吊销」检测时会话被吊销。
 *
 * 限流**不**会替这里串行化（两个阈值默认都是 0，直接返回），所以并发是真的并行。
 *
 * 桩的刷新端点故意慢 200ms：否则并发请求会前后错开、第一个刷完第二个才发现
 * 令牌已新鲜，「没做单飞」也能凑出 1 次，用例就白写了。
 */
test('桥：令牌过期瞬间的 5 个并发请求只刷新一次', { timeout: 30_000 }, async () => {
  const stub = await startStubUpstream(['stub-model'], { refreshDelayMs: 200 });
  const nearExpiry = {
    auth: {
      accessToken: 'fake-access-token',
      refreshToken: 'fake-refresh-token',
      domain: 'example.invalid',
      expiresAt: Date.now() + 60_000, // < 5 分钟 skew → 每个请求都会先判过期
    },
  };
  const bridge = await startBridge({ CODEBUDDY_ENDPOINT: stub.base }, { auth: nearExpiry });
  try {
    const one = () => fetch(`${bridge.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'stub-model', messages: [{ role: 'user', content: 'hi' }] }),
    }).then((r) => r.text());
    /*
     * 先确认请求**真的成功了**再数刷新次数。
     *
     * 为什么：这条用例原本只断言「刷新 1 次」。如果因为环境原因（端口冲突、
     * 凭据没写进去、上游桩没起来）请求根本没走到刷新那一步，计数会是 **0** ——
     * 断言会红，但红的原因看不出是「设置坏了」还是「单飞坏了」。
     * 在门禁链里就遇到过 `实际 0 次`，单跑却 3/3 全过。把这一步显式断言出来，
     * 失败时能直接看到响应内容。
     */
    const bodies = await Promise.all([one(), one(), one(), one(), one()]);
    for (const b of bodies) {
      assert.ok(
        b.includes('"content"') || b.includes('"role"'),
        `每个请求都应当拿到正常的补全响应；实际是：${b.slice(0, 160)}`,
      );
    }
    await new Promise((r) => setTimeout(r, 300));

    assert.equal(stub.refreshCalls, 1, `5 个并发请求只该刷新一次，实际 ${stub.refreshCalls} 次`);
  } finally {
    await bridge.stop();
    try { await stub.close(); } catch { /* 忽略 */ }
    rmSync(bridge.dir, { recursive: true, force: true });
  }
});

/**
 * 未配置本地令牌时，桥**不得**静默放行。
 *
 * 为什么必须钉住：`handleRequest` 的闸门写成
 * `if ((LOCAL_TOKEN || CLIENT_KEY_HASHES.size) && identifyClientId(req) === null)` ——
 * `LOCAL_TOKEN` 为空时整个 401 分支不执行，于是 `/health`、`/v1/chat/completions`
 * 等全部无鉴权可达。而夹具此前**永远**注入 `WORKBUDDY_LOCAL_TOKEN`（见 startBridge），
 * 这条默认路径从未被测过，所以漏洞能长期存在。
 *
 * 现场证据：用户直接 `node bridge/workbuddy-bridge.mjs`（不经控制台）时，
 * `config.mjs` 那份默认值不参与 —— 桥拿到的是空令牌，等于无鉴权。
 *
 * 断言的是**行为明确**：要么拒绝（401），要么启用了自动生成的替代令牌。
 * 唯一不允许的结果是「无令牌也 200」。
 */
test('桥：未配置 WORKBUDDY_LOCAL_TOKEN 时不得静默放行', { timeout: 30_000 }, async () => {
  const bridge = await startBridge({ WORKBUDDY_LOCAL_TOKEN: '' }, { auth: READABLE_FAKE_AUTH });
  try {
    // ① 不带任何凭据：绝不能 200
    const anon = await fetch(`${bridge.baseUrl}/v1/models`, { signal: AbortSignal.timeout(5000) });
    assert.notEqual(anon.status, 200,
      `未配置令牌时无凭据访问 /v1/models 不能成功（实际 ${anon.status}）—— 等于把账号对同机任意程序敞开`);

    // ② 不带凭据的对话请求更不能成功（这条会真的消耗上游额度）
    const anonChat = await fetch(`${bridge.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'stub-model', messages: [{ role: 'user', content: 'hi' }] }),
      signal: AbortSignal.timeout(5000),
    });
    assert.notEqual(anonChat.status, 200,
      `未配置令牌时无凭据对话请求不能成功（实际 ${anonChat.status}）`);
  } finally {
    await bridge.stop();
    rmSync(bridge.dir, { recursive: true, force: true });
  }
});

/**
 * 自动生成的令牌必须**可见**（从启动日志里能读出来），否则用户配不上客户端。
 *
 * 「拒绝一切」是安全但不可用；「随机生成 + 打印出来」才是可用的安全。
 * 这条与上一条配对：一个管「不能放行」，一个管「不能把用户锁在门外」。
 */
test('桥：自动生成令牌时必须把值打印到启动日志（否则用户无法接入客户端）', { timeout: 30_000 }, async () => {
  const bridge = await startBridge({ WORKBUDDY_LOCAL_TOKEN: '' }, { auth: READABLE_FAKE_AUTH });
  try {
    // 生成出来的令牌必须能用于访问；并从启动输出里找得到，供用户复制
    const out = bridge.out();
    const m = out.match(/WORKBUDDY_LOCAL_TOKEN=([A-Za-z0-9._-]{16,})/);
    assert.ok(m, `启动日志里必须给出自动生成的令牌（实际输出：\n${out}\n）`);

    const ok = await fetch(`${bridge.baseUrl}/v1/models`, {
      headers: { authorization: `Bearer ${m[1]}` },
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(ok.status, 200, '日志里打印的令牌必须真的能用');
  } finally {
    await bridge.stop();
    rmSync(bridge.dir, { recursive: true, force: true });
  }
});

/**
 * 账本的数值字段必须**永远是数字**，NaN / Infinity / 字符串都不能进磁盘。
 *
 * 为什么必须钉住：账本由控制台「用量统计」直接聚合。一个 NaN 进去，
 * `合计` 会变成 NaN 并让整张表显示成 NaN —— 用户看到的是"统计坏了"，
 * 而根因是上游回了脏 usage。`usageOf` 用 `Number(x) || 0` 兜底，这里把它钉死。
 *
 * 上游回 `"prompt_tokens": "abc"`（字符串）、`Infinity`、缺字段，都是真实可能
 * 出现的脏数据（网关版本漂移 / 代理改写）。
 */
test('桥：上游 usage 是脏数据（字符串 / NaN / 缺字段）时账本不得落 NaN', { timeout: 30_000 }, async () => {
  const stub = await startStubUpstream(['stub-model'], {
    // 一坨脏 usage：字符串、null、缺字段混在一起
    chatRaw: 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'
      + 'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":"abc","completion_tokens":null,"total_tokens":1e999}}\n\n'
      + 'data: [DONE]\n\n',
    chatType: 'text/event-stream',
  });
  const bridge = await startBridge({ CODEBUDDY_ENDPOINT: stub.base }, { auth: READABLE_FAKE_AUTH });
  try {
    const res = await fetch(`${bridge.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'stub-model', messages: [{ role: 'user', content: 'hi' }] }),
    });
    await res.text();

    await new Promise((r) => setTimeout(r, 300));
    const rows = readFileSync(join(bridge.dir, 'usage.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.ok(rows.length > 0, '应当记了一条账');

    const last = rows[rows.length - 1];
    for (const k of ['promptTokens', 'completionTokens', 'ms']) {
      if (k in last) {
        assert.equal(typeof last[k], 'number', `${k} 必须是数字（实际 ${typeof last[k]}）`);
        assert.ok(Number.isFinite(last[k]), `${k} 不能是 NaN / Infinity（实际 ${last[k]}）`);
      }
    }
    // 原始 JSON 里也不能出现 NaN/Infinity 字面量（JSON.stringify 会把它们变成 null）
    assert.ok(!/NaN|Infinity/.test(JSON.stringify(last)), '账本行不得含 NaN/Infinity');
  } finally {
    await bridge.stop();
    try { await stub.close(); } catch { /* 忽略 */ }
    rmSync(bridge.dir, { recursive: true, force: true });
  }
});

/**
 * 超长错误原文必须被截断并压成单行。
 *
 * 上游的 401 会返回**整段 HTML**（APISIX 网关），若不截断：
 * ① 账本单行被撑到几十 KB；② 控制台「点失败标签复制错误详情」会复制出一坨 HTML。
 * `shortError` 同时做「压单行 + 截断 160」，这里双向钉住。
 */
test('桥：上游超长错误原文必须压成单行并截断（不得把整段 HTML 灌进账本）', { timeout: 120_000 }, async () => {
  /*
   * 超时给到 120 秒（而不是别的用例的 30 秒）：上游回 401 会**触发一次令牌刷新**，
   * 而刷新在测试桩上必然失败（桩没有 /v2/plugin/auth/token/refresh），
   * 走满 `refreshAuth` 的 8 秒超时 + 后续重试。这是**刻意保留的真实行为**
   * （生产里刷新成功就会重试），不该为了让测试快而去掉。
   */
  // 造一段带换行的长 HTML：既测截断，也测换行被压平
  const longHtml = '<html>\n  <head><title>401</title></head>\n  <body>\n'
    + 'x'.repeat(4000)
    + '\n  </body>\n</html>';
  const stub = await startStubUpstream(['stub-model'], { chatRaw: longHtml, chatStatus: 401, chatType: 'text/html' });
  const bridge = await startBridge({ CODEBUDDY_ENDPOINT: stub.base }, { auth: READABLE_FAKE_AUTH });
  try {
    const res = await fetch(`${bridge.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'stub-model', messages: [{ role: 'user', content: 'hi' }] }),
    });
    await res.text();
    assert.ok(res.status >= 400, '上游 401 时桥不能回 200');

    await new Promise((r) => setTimeout(r, 300));
    const rows = readFileSync(join(bridge.dir, 'usage.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const last = rows[rows.length - 1];
    assert.equal(last.ok, false, '必须记失败');
    assert.ok(typeof last.error === 'string' && last.error.length <= 201,
      `错误原文必须被截断到 160 字符左右（实际 ${last.error?.length}）`);
    assert.ok(!last.error.includes('\n'), '错误原文必须压成单行（换行会被账本/CSV 吃掉）');
  } finally {
    await bridge.stop();
    try { await stub.close(); } catch { /* 忽略 */ }
    rmSync(bridge.dir, { recursive: true, force: true });
  }
});

/*
 * ── 401 的自诊断 ────────────────────────────────────────────────────────
 *
 * 背景：令牌默认值从固定串 `wb-local-bridge` 改成随机值之后，**所有老用户
 * 升级后都会撞 401** —— 他们的客户端配置里还存着旧口令。断得毫无预兆，
 * 且原响应体只有一句 `bad or missing token`，用户根本不知道该去哪找新值。
 *
 * 契约（三条同时成立）：
 *   ① 401 必须说明「可能是升级前的旧令牌」并指出去哪拿新值；
 *   ② **绝不能**把真实令牌写进响应体 —— 那等于给同机攻击者直接送答案；
 *   ③ 用对令牌的请求不受影响（提示只在失败路径上）。
 */
test('桥：401 必须自带排查指引（升级后旧令牌失效是高频场景）', { timeout: 30_000 }, async () => {
  const bridge = await startBridge();
  try {
    // 老用户升级后的典型状态：配置里还存着历史默认值
    const stale = await fetch(bridge.baseUrl + '/v1/models', {
      headers: { authorization: 'Bearer wb-local-bridge' },
    });
    assert.equal(stale.status, 401, '旧令牌必须被拒绝（这正是本次安全修复的目的）');

    const body = await stale.text();
    // ① 必须给出可操作指引
    assert.match(body, /bridge-token|-token|客户端接入|clients/,
      `401 响应体要指出去哪拿新令牌，实际是：${body.slice(0, 200)}`);
    assert.match(body, /upgrade|升级|旧|stale|changed|变/i,
      `401 响应体要说明「令牌可能变了」，实际是：${body.slice(0, 200)}`);
    /*
     * ③ 必须覆盖「填的就是文件里的新令牌、却仍然 401」这一种 ——
     * 它不是客户端填错，而是**在跑的桥**内存里还是升级前的旧令牌
     * （令牌文件可能由别的进程先创建：`config.mjs` 在模块求值时就会生成并落盘，
     * 跑测试/工具也会创建它）。只照「换客户端令牌」做会一直 401 转不出来，
     * 必须告诉用户「桥和控制台一起重启」。
     */
    assert.match(body, /重启/,
      `401 响应体要覆盖「令牌对但仍 401 → 重启桥与控制台」这一种，实际是：${body.slice(0, 300)}`);

    // ② 绝不能泄漏真实令牌。取启动日志里的自动生成值作为对照。
    const out = bridge.out();
    const real = out.match(/WORKBUDDY_LOCAL_TOKEN=([A-Za-z0-9._-]{16,})/)?.[1];
    if (real) {
      assert.ok(!body.includes(real), '401 响应体绝不能包含真实令牌（等于把答案送给攻击者）');
    }

    // ③ 用对令牌时正常，且提示不会污染成功响应
    const ok = await fetch(bridge.baseUrl + '/v1/models', { headers: auth });
    assert.equal(ok.status, 200, '正确令牌必须照常放行');
    const okBody = await ok.text();
    assert.ok(!/bridge-token|升级/.test(okBody), '成功响应里不该出现排查提示');
  } finally {
    await bridge.stop();
    rmSync(bridge.dir, { recursive: true, force: true });
  }
});

test('桥：完全没带凭据时也要给指引（新用户第一次接入手忙脚乱）', { timeout: 30_000 }, async () => {
  const bridge = await startBridge();
  try {
    const res = await fetch(bridge.baseUrl + '/v1/models');
    assert.equal(res.status, 401);
    const body = await res.text();
    assert.match(body, /bridge-token|-token|客户端接入|clients/,
      `无凭据的 401 同样要指路，实际是：${body.slice(0, 200)}`);

    // 同样地，不许泄漏真实令牌
    const real = bridge.out().match(/WORKBUDDY_LOCAL_TOKEN=([A-Za-z0-9._-]{16,})/)?.[1];
    if (real) assert.ok(!body.includes(real), '401 响应体绝不能包含真实令牌');
  } finally {
    await bridge.stop();
    rmSync(bridge.dir, { recursive: true, force: true });
  }
});
