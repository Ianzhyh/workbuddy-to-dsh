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
import { createServer, request as httpRequest, Agent as HttpAgent } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, readdirSync, utimesSync } from 'node:fs';
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

/** 可解码的假 JWT（只带 sub/exp）—— 账号跟随用例靠 sub 区分身份。 */
function fakeJwt(sub) {
  const body = Buffer.from(JSON.stringify({ sub, exp: Math.floor(Date.now() / 1000) + 86_400 }), 'utf8').toString('base64url');
  return `e30.${body}.sig`;
}

/** 一份可被桥解密的登录文件内容（纯文本字段，不走 at-rest 信封）。 */
function authFileFor(sub, domain = 'example.invalid') {
  return {
    auth: {
      accessToken: fakeJwt(sub),
      refreshToken: 'fake-refresh-token',
      domain,
      expiresAt: Date.now() + 30 * 86_400_000,
    },
  };
}

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
      // 凭据库必须隔离：否则测试会读到本机真实的插件登录凭据（/health 不再是 503）。
      WORKBUDDY_CREDENTIAL_DIR: join(dir, 'credentials'),
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

/**
 * 用 keep-alive agent 发一个请求，返回状态、正文与「是否复用了已有 socket」。
 *
 * `fetch` 走 undici 连接池，无法稳定断言「下一条请求落在同一条 socket 上」；
 * 而 413 漏 `req.resume()` 的故障恰恰只在这条路径上出现。
 */
function agentRequest(agent, port, path, { method = 'POST', body = '' } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: '127.0.0.1',
      port,
      path,
      method,
      agent,
      headers: {
        authorization: `Bearer ${TOKEN}`,
        ...(body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}),
      },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: text, reusedSocket: req.reusedSocket }));
    });
    req.on('error', reject);
    req.end(body);
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
        /*
         * `chatHang`：只回响应头，永远不写 body、不 end —— 模拟“连接建立了但
         * 上游一直不说话”。首字节超时用例靠它验证不会永久 loading。
         */
        if (opts.chatHang) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.flushHeaders();
          return;
        }
        /*
         * `opts.chatSequence`：按顺序返回**不同**的响应，用于测「重试若干次后成功」。
         * 每项 `{ status, type, raw }`；用完最后一项后**一直重复它**。
         *
         * 为什么需要它：`chatRaw` 是恒定响应，只能表达「永远失败」，无法表达
         * 「前 2 次 400、第 3 次 200」—— 而后者才是「重试确实救回了请求」的证据。
         */
        if (Array.isArray(opts.chatSequence) && opts.chatSequence.length) {
          const idx = Math.min(seen.length - 1, opts.chatSequence.length - 1);
          const step = opts.chatSequence[idx];
          res.writeHead(step.status || 200, { 'content-type': step.type || 'application/json' });
          return res.end(step.raw ?? '{}');
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
    /*
     * ⚠️ 判据不能是「仓库账本字节数前后相等」。
     *
     * 那份账本属于**正在运行的真实桥**：开发者本机跑用例时，任何并发请求
     * （控制台轮询、另一个终端里的对话、甚至 CI 之外的实测脚本）都会往里追加一行，
     * 于是这条断言会**误报**成"测试改到了使用者的账本"。
     * 实测踩过：并发跑基准脚本时它报 `223443 !== 222905` —— 差的 538 字节
     * 正好是一条真实请求的账本行，与本次 DELETE 毫无关系。
     *
     * 换成对**本用例动作**真正敏感、且对并发追加免疫的判据：
     *   · DELETE 会把整份文件**清空**，所以"非空 → 空"是它造成的铁证；
     *   · 追加**永远不会改首行**，而清空/截断一定会 —— 所以首行是可靠指纹。
     * 这样"测试真的写坏了使用者账本"照旧会被抓住，并发流量则不再误报。
     */
    const repoLedgerBefore = existsSync(repoLedger) ? readFileSync(repoLedger, 'utf8') : '';
    const firstLineBefore = repoLedgerBefore.split('\n')[0] ?? '';

    // 触发一次"清空账本"（不需要上游）
    const cleared = await fetch(bridge.baseUrl + '/v1/usage', { method: 'DELETE', headers: auth });
    assert.ok([200, 204].includes(cleared.status), `清空账本应当成功，实际 ${cleared.status}`);

    const repoLedgerAfter = existsSync(repoLedger) ? readFileSync(repoLedger, 'utf8') : '';
    const firstLineAfter = repoLedgerAfter.split('\n')[0] ?? '';
    assert.ok(!(repoLedgerBefore.length > 0 && repoLedgerAfter.length === 0),
      '测试绝不能把使用者的真实账本清空');
    assert.equal(firstLineAfter, firstLineBefore,
      '测试绝不能改动使用者真实账本的内容（首行指纹变了 = 被清空/截断/重写了）');

    /*
     * 反证隔离真的生效：被清空的是**测试桥自己**那份（temp 目录里）。
     * 少了这一条，"两边都没动"也能让上面的断言通过 —— 那就成了空转用例。
     */
    assert.ok(existsSync(localLedger), `测试桥的账本应当落在临时目录：${localLedger}`);

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

test('桥：413 后同一条 keep-alive 连接仍可复用（count_tokens / responses）', { timeout: 60_000 }, async () => {
  /*
   * 回归背景：`readBody` 超限时只 pause、不丢字节；413 写完后漏掉
   * `req.resume()` 的端点会让 socket 停在暂停状态。下一条复用同一连接的
   * 请求要么挂住、要么 ECONNRESET。`/v1/responses` 与
   * `/v1/messages/count_tokens` 都曾漏过这一行。
   */
  const bridge = await startBridge({ WORKBUDDY_MAX_BODY_BYTES: String(64 * 1024) });
  const agent = new HttpAgent({ keepAlive: true, maxSockets: 1 });
  try {
    const port = Number(new URL(bridge.baseUrl).port);
    const big = JSON.stringify({
      model: 'x',
      messages: [{ role: 'user', content: 'z'.repeat(256 * 1024) }],
    });
    const cases = [
      ['/v1/messages/count_tokens', 'request_too_large'],
      ['/v1/responses', 'payload_too_large'],
    ];
    for (const [path, errorType] of cases) {
      const first = await agentRequest(agent, port, path, { body: big });
      assert.equal(first.status, 413, `${path} 超限必须是 413`);
      const payload = JSON.parse(first.body);
      assert.equal(payload?.error?.type, errorType, `${path} 的错误形状必须符合协议`);
      const second = await agentRequest(agent, port, '/', { method: 'GET' });
      assert.equal(second.status, 200, `${path} 拒绝后桥必须仍可用`);
      assert.equal(second.reusedSocket, true, `${path} 的 413 必须让同一条 socket 可复用`);
    }
  } finally {
    agent.destroy();
    await bridge.stop();
    rmSync(bridge.dir, { recursive: true, force: true });
  }
});

test('目录补全：国际版漏列的模型必须带上**实测过的**视觉 / 推理标记（2026-10-12 用户反馈）', { timeout: 90_000 }, async () => {
  /*
   * 现场：国际版网关能调 `deepseek-v4.1-flash`，但**任何一个目录端点里都没有它**
   * → 桥用 FEATURED 补全 → 补全项原先不带任何能力字段 → dsh 把它显示成
   * 「纯文本、不支持推理」，用户点思考强度直接被拒：
   *   session/model-unavailable: model "deepseek-v4.1-flash" does not support reasoning effort "high"
   *
   * 真实能力是**实测过**的（1×1 红点图答出颜色；reasoning_effort 五档全 200，
   * 见 tools/dev/probe-capability.mjs / probe-effort.mjs），所以补全必须把它们带上。
   *
   * 同时钉住区域过滤：`deepseek-v4-pro` 在国际版实测 400
   * （`model [...] service info not found`），不能补进去当死条目。
   */
  const upstream = createServer((req, res) => {
    const path = new URL(req.url, 'http://127.0.0.1').pathname;
    if (path === '/v2/enterprises/personal/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      // 故意只给 glm-5.3：两个 deepseek 都不在目录里（国际版的真实形状）
      return res.end(JSON.stringify({
        code: 0,
        data: {
          models: [{
            id: 'glm-5.3', name: 'GLM-5.3', maxInputTokens: 1000000, maxOutputTokens: 48000,
            supportsImages: true, supportsReasoning: true, credits: 'x0.79',
          }],
        },
      }));
    }
    if (path === '/v3/config') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ code: 0, data: { models: [] } }));
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const upstreamBase = `http://127.0.0.1:${upstream.address().port}`;

  // 国际版凭据：域名为 workbuddy.ai（区域判定看**登录域名**，不看 endpoint —— 
  // CODEBUDDY_ENDPOINT 只是把出站流量导向桩）
  const intlAuth = {
    auth: {
      accessToken: 'fake-access-token',
      refreshToken: 'fake-refresh-token',
      domain: 'workbuddy.ai',
      expiresAt: Date.now() + 30 * 86_400_000,
    },
  };
  const bridge = await startBridge({ CODEBUDDY_ENDPOINT: upstreamBase }, { auth: intlAuth });
  try {
    const models = await (await fetch(bridge.baseUrl + '/v1/models?all=1', { headers: auth })).json();
    const flash = models.data.find((m) => m.id === 'deepseek-v4.1-flash');
    assert.ok(flash, `国际版目录缺它时，精选补全必须列出来。实际：${models.data.map((m) => m.id).join(',')}`);
    assert.equal(flash.supports_images, true, '实测视觉可用 → 补全项必须声明 supports_images');
    assert.equal(flash.supports_reasoning, true, '实测接受 reasoning_effort → 补全项必须声明 supports_reasoning');
    assert.equal(flash.context_window, 1000000, '上下文窗口照精选定义（1M）');

    // 上游真给了的模型：能力标记用上游的（不被精选定义覆盖）
    const glm = models.data.find((m) => m.id === 'glm-5.3');
    assert.equal(glm.supports_reasoning, true, '目录里有的模型，标记来自上游');

    // 区域过滤：国际版不提供 v4-pro（实测 400），不能出现在列表里
    assert.ok(
      !models.data.some((m) => m.id === 'deepseek-v4-pro'),
      '国际版不得补出 deepseek-v4-pro —— 那个区域实测 400（service info not found）',
    );

    // 默认视图（不带 all=1）走的是 pickFeatured 那条路，同样要带能力标记
    const def = await (await fetch(bridge.baseUrl + '/v1/models', { headers: auth })).json();
    const flashDef = def.data.find((m) => m.id === 'deepseek-v4.1-flash');
    assert.ok(flashDef, '默认视图也要列出精选模型');
    assert.equal(flashDef.supports_images, true, '默认视图同样要带视觉标记（原先只在补全路径里修是不够的）');
    assert.equal(flashDef.supports_reasoning, true, '默认视图同样要带推理标记');
    assert.ok(
      !def.data.some((m) => m.id === 'deepseek-v4-pro'),
      '默认视图同样要过区域过滤：国际版不该出现 v4-pro',
    );
  } finally { await bridge.stop(); upstream.close(); }
});

test('目录补全：国内版仍会补 deepseek-v4-pro（region 过滤只挡"该区域不提供"的）', { timeout: 90_000 }, async () => {
  // 与上一条互补：区域过滤不能把国内版的兜底一起挡掉。
  // 凭据用默认的 example.invalid 域 → pickUpstream 落到国内端点。
  const upstream = createServer((req, res) => {
    const path = new URL(req.url, 'http://127.0.0.1').pathname;
    if (path === '/v2/enterprises/personal/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ code: 0, data: { models: [{ id: 'cn-model', maxInputTokens: 1000, maxOutputTokens: 100 }] } }));
    }
    if (path === '/v3/config') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ code: 0, data: { models: [] } }));
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const upstreamBase = `http://127.0.0.1:${upstream.address().port}`;

  const bridge = await startBridge({ CODEBUDDY_ENDPOINT: upstreamBase }, { auth: READABLE_FAKE_AUTH });
  try {
    const models = await (await fetch(bridge.baseUrl + '/v1/models?all=1', { headers: auth })).json();
    const ids = models.data.map((m) => m.id);
    assert.ok(ids.includes('deepseek-v4-pro'), `国内版应当照旧补出 deepseek-v4-pro。实际：${ids.join(',')}`);
    assert.ok(ids.includes('deepseek-v4.1-flash'), '精选里的全区域模型照旧补出');
  } finally { await bridge.stop(); upstream.close(); }
});

test('/v1/models：每模型给出**实测过**的 reasoning_efforts 档位（写死三档的旧做法）', { timeout: 90_000 }, async () => {
  /*
   * 2026-10-12 用户反馈："每个模型只有三个档"，而上游对支持推理的模型其实收
   * minimal/low/medium/high（多数模型还收 xhigh/max，少数连 minimal/max 都不收）。
   * 目录里没有任何字段说"接受哪几档"，所以桥按**实测表**（REASONING_EFFORTS_BY_MODEL）给。
   *
   * 这条用例钉五件事：
   *   1. 有实测覆盖的模型给覆盖表里的档位（含 xhigh）；
   *   2. 没有覆盖的模型给默认三档（**不含 xhigh/minimal/max** —— 实测里这三个
   *      都有模型不收，未测模型不能赌）；
   *   3. 目录没说支持推理的模型**完全没有** reasoning_efforts 字段；
   *   4. 显式空数组（实测一个档都不收，如网关暂时不接的 claude-* / glm-5.0）
   *      → 同样不出字段，插件会因此不声明推理；
   *   5. 国内版 2026-10-12 实测并进来的 id 同样按表给（auto 全档 / glm-5.0 空数组）。
   */
  const upstream = createServer((req, res) => {
    const path = new URL(req.url, 'http://127.0.0.1').pathname;
    if (path === '/v2/enterprises/personal/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        code: 0,
        data: {
          models: [
            { id: 'glm-5.3', name: 'GLM-5.3', maxInputTokens: 1000000, maxOutputTokens: 48000, supportsReasoning: true, supportsImages: true },
            { id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash', maxInputTokens: 1000000, maxOutputTokens: 65536, supportsReasoning: true, supportsImages: true },
            { id: 'claude-haiku-4.5', name: 'Claude Haiku 4.5', maxInputTokens: 176000, maxOutputTokens: 24000, supportsReasoning: true, supportsImages: true },
            { id: 'auto', name: 'Auto', maxInputTokens: 1000000, maxOutputTokens: 48000, supportsReasoning: true },
            { id: 'glm-5.0', name: 'GLM-5.0', maxInputTokens: 1000000, maxOutputTokens: 48000, supportsReasoning: true },
            { id: 'stub-reasoner', name: 'Stub Reasoner', maxInputTokens: 1000, maxOutputTokens: 100, supportsReasoning: true },
            { id: 'plain-1', name: 'Plain', maxInputTokens: 1000, maxOutputTokens: 100 },
          ],
        },
      }));
    }
    if (path === '/v3/config') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ code: 0, data: { models: [] } }));
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const upstreamBase = `http://127.0.0.1:${upstream.address().port}`;

  const bridge = await startBridge({ CODEBUDDY_ENDPOINT: upstreamBase }, { auth: READABLE_FAKE_AUTH });
  try {
    const models = await (await fetch(bridge.baseUrl + '/v1/models?all=1', { headers: auth })).json();
    const byId = new Map(models.data.map((m) => [m.id, m]));

    // ① 实测覆盖表里的模型：连 xhigh 一起给
    assert.deepEqual(
      byId.get('glm-5.3').reasoning_efforts,
      ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
      'glm-5.3 实测连 xhigh 都收 —— 档位必须按实测表给，不能写死三档',
    );
    // ② 没有覆盖的模型：默认三档，**不含** xhigh/minimal/max（实测都有模型不收）
    assert.deepEqual(
      byId.get('stub-reasoner').reasoning_efforts,
      ['low', 'medium', 'high'],
      '没有实测覆盖的模型用默认三档；未测的档不能赌',
    );
    // ②b 国内版实测并进来的 id：auto 全档 / glm-5.0 对照 400 → 显式空数组
    assert.deepEqual(
      byId.get('auto').reasoning_efforts,
      ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
      '国内版实测全档的模型（auto）必须给全 6 档',
    );
    assert.deepEqual(
      byId.get('glm-5.0').reasoning_efforts,
      [],
      '国内版目录在列但网关不接（glm-5.0 对照 400 service info not found）→ 空数组',
    );
    // ③ 目录没说支持推理的模型：一个档位字段都不该有
    assert.equal(byId.get('plain-1').supports_reasoning, undefined, 'plain-1 不声明推理');
    assert.equal(byId.get('plain-1').reasoning_efforts, undefined, '不声明推理就没有档位字段');
    // ④ 显式空数组（实测一个档都不收）→ 同样不出字段
    assert.deepEqual(
      byId.get('claude-haiku-4.5').reasoning_efforts,
      [],
      'claude-* 网关当前不接，实测表里是显式空数组',
    );

    // ⑤ 补全进来的模型同样要有档位（FEATURED 的 deepseek-v4.1-flash 实测过）
    const flash = models.data.find((m) => m.id === 'deepseek-v4.1-flash');
    assert.ok(flash, '补全模型要在列表里');
    assert.deepEqual(
      flash.reasoning_efforts,
      ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
      '补全进来的模型也要带档位 —— 否则 dsh 里它还是没有思考强度可选',
    );
  } finally { await bridge.stop(); upstream.close(); }
});

test('/v1/models：对齐官方 GUI 清单，并直取 supportedEfforts / contextWindow', { timeout: 90_000 }, async () => {
  /*
   * issue #5：插件列表比 WorkBuddy 官方多、档位也比官方多。
   * 根因是桥只读 `/v2/.../models` 全量并把档位写死在本地实测表；官方 GUI
   * 用的是 `/v3/config` 的 models + agents[]，且目录本身就带
   * `reasoning.supportedEfforts` 与 `contextWindow.supportedLengths`。
   * 本用例钉住：官方清单标注、档位来源、上下文档位、以及显式覆盖。
   */
  const upstream = createServer((req, res) => {
    const path = new URL(req.url, 'http://127.0.0.1').pathname;
    if (path === '/v2/enterprises/personal/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        code: 0,
        data: {
          models: [
            // v2 的薄条目：档位表在 v3，但 defaultEffort/canDisableThinking 只在这里
            {
              id: 'glm-5.3', name: 'GLM 5.3', maxInputTokens: 1000000, maxOutputTokens: 64000,
              supportsReasoning: true, supportsToolCall: true,
              reasoning: { defaultEffort: 'high', canDisableThinking: true },
              contextWindow: { defaultLength: 300000 },
            },
            // 只在 v2 出现 = 官方目录外
            { id: 'old-model', name: 'Old Model', maxInputTokens: 64000, maxOutputTokens: 8192, supportsReasoning: true, supportsToolCall: true, reasoning: { supportedEfforts: ['low', 'high'] } },
            // v2 单独挂 chat 标签：官方 GUI 也认，必须算 official
            { id: 'chat-only', name: 'Chat Only', maxInputTokens: 64000, maxOutputTokens: 8192, supportsToolCall: true, tags: ['chat'] },
          ],
        },
      }));
    }
    if (path === '/v3/config') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        code: 0,
        data: {
          models: [
            {
              id: 'glm-5.3', name: 'GLM-5.3', maxInputTokens: 1000000, maxOutputTokens: 131072,
              supportsReasoning: true, onlyReasoning: true, supportsToolCall: true, tags: ['craft'],
              reasoning: { supportedEfforts: ['low', 'high', 'max'] },
              contextWindow: { supportedLengths: [1000000, 300000, 600000] },
            },
            // 产品目录里有、但不在会话 agent 的 models 里 = 官方选择器不列
            {
              id: 'memory-model', name: 'Memory Model', maxInputTokens: 128000, maxOutputTokens: 8192,
              supportsToolCall: true,
            },
          ],
          agents: [{ name: 'craft', models: ['glm-5.3'] }],
        },
      }));
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const upstreamBase = `http://127.0.0.1:${upstream.address().port}`;

  const bridge = await startBridge(
    { CODEBUDDY_ENDPOINT: upstreamBase, WORKBUDDY_CONTEXT_WINDOW: '600000' },
    { auth: READABLE_FAKE_AUTH },
  );
  try {
    const payload = await (await fetch(bridge.baseUrl + '/v1/models?all=1', { headers: auth })).json();
    const byId = new Map(payload.data.map((m) => [m.id, m]));
    const glm = byId.get('glm-5.3');
    assert.equal(glm.official, true, '官方 craft agent 的模型必须标 official=true');
    assert.deepEqual(glm.reasoning_efforts, ['low', 'high', 'max'], '档位必须直取上游 supportedEfforts（低/高/极致）');
    assert.equal(glm.default_reasoning_effort, 'high');
    assert.equal(glm.reasoning_efforts_source, 'upstream');
    assert.equal(glm.context_window, 600000, 'WORKBUDDY_CONTEXT_WINDOW 显式覆盖生效，且不能超过模型上限');
    assert.equal(glm.context_window_default, 300000);
    assert.deepEqual(glm.context_window_options, [300000, 600000, 1000000], '上下文档位排序去重后原样给出');
    assert.equal(glm.context_window_max, 1000000);
    assert.equal(glm.can_disable_thinking, true);

    const old = byId.get('old-model');
    assert.equal(old.official, false, '只在 /v2 出现的模型必须标 official=false');
    assert.deepEqual(old.reasoning_efforts, ['low', 'high'], 'v2 自带 supportedEfforts 时同样优先采用');

    const chatOnly = byId.get('chat-only');
    assert.equal(chatOnly.official, true, 'v2 单独带 chat 标签的模型也算官方可选');

    const mem = byId.get('memory-model');
    assert.equal(mem.official, false, '产品目录里但不在会话 agent 清单里的模型不算官方可选');
  } finally { await bridge.stop(); upstream.close(); }
});

test('目录：v3 成功后 v2 的单端点 401 不得触发刷新/换号（否则目录永远建不起来）', { timeout: 90_000 }, async () => {
  let refreshCalls = 0;
  const upstream = createServer((req, res) => {
    const path = new URL(req.url, 'http://127.0.0.1').pathname;
    if (path === '/v3/config') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        code: 0,
        data: {
          models: [{ id: 'workbuddy-cn-model', name: 'CN', maxInputTokens: 300000, maxOutputTokens: 64000, supportsToolCall: true }],
          agents: [{ name: 'craft', models: ['workbuddy-cn-model'] }],
        },
      }));
    }
    if (path === '/v2/enterprises/personal/models') {
      // 部分 workbuddy.cn 账号这个端点单独 401，但 v3 正常
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ code: 401, msg: 'unauthorized' }));
    }
    if (path === '/v2/plugin/auth/token/refresh') {
      refreshCalls += 1;
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ code: 10001, msg: 'refreshToken is empty' }));
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const upstreamBase = `http://127.0.0.1:${upstream.address().port}`;
  const bridge = await startBridge({ CODEBUDDY_ENDPOINT: upstreamBase }, { auth: READABLE_FAKE_AUTH });
  try {
    const models = await (await fetch(bridge.baseUrl + '/v1/models?all=1', { headers: auth })).json();
    assert.ok(models.data.some((m) => m.id === 'workbuddy-cn-model'), 'v3 目录必须保留');
    assert.equal(refreshCalls, 0, '已有端点成功时不得因为另一端点 401 去刷新令牌');
    const health = await (await fetch(bridge.baseUrl + '/health', { headers: auth })).json();
    assert.match(String(health.upstreamShape?.sources?.['/v2/enterprises/personal/models']), /ignored/,
      '诊断里要能看出 v2 的 401 被跳过，而不是被当成令牌过期');
  } finally { await bridge.stop(); upstream.close(); }
});

test('账本：体检请求要标 probe，面板不再把它算进“最近失败”待办', { timeout: 90_000 }, async () => {
  const upstream = await startStubUpstream(['stub-model']);
  const bridge = await startBridge({ CODEBUDDY_ENDPOINT: upstream.base }, { auth: READABLE_FAKE_AUTH });
  try {
    const call = (probe) => fetch(bridge.baseUrl + '/v1/chat/completions', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
        ...(probe ? { 'x-workbuddy-probe': '1' } : {}),
      },
      body: JSON.stringify({
        model: 'stub-model', stream: true, max_tokens: 64,
        messages: [{ role: 'system', content: 'You are a helpful assistant.' }, { role: 'user', content: 'hi' }],
      }),
    }).then((res) => res.text());
    await call(true);
    await call(false);
    const ledger = await (await fetch(bridge.baseUrl + '/v1/requests?limit=5', { headers: auth })).json();
    const rows = ledger.requests.filter((r) => r.model === 'stub-model');
    assert.equal(rows.length, 2);
    assert.equal(rows[1].probe, true, '体检请求必须带 probe 标记');
    assert.equal(rows[0].probe, undefined, '普通对话不能被误标成体检');
  } finally { await bridge.stop(); upstream.close(); }
});

test('目录：一个端点 5xx 不能吞掉另一个端点已成功的目录', { timeout: 90_000 }, async () => {
  /*
   * 旧逻辑用全局 hardError：v3 500 + v2 200 时整份结果被丢弃，模型只剩
   * FEATURED。现在只有“没有任何端点成功”才保留旧缓存。
   */
  const upstream = createServer((req, res) => {
    const path = new URL(req.url, 'http://127.0.0.1').pathname;
    if (path === '/v3/config') {
      res.writeHead(500, { 'content-type': 'text/html' });
      return res.end('<html>gateway error</html>');
    }
    if (path === '/v2/enterprises/personal/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        code: 0,
        data: { models: [{ id: 'v2-survivor', name: 'V2 Survivor', maxInputTokens: 128000, maxOutputTokens: 8192, supportsToolCall: true }] },
      }));
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const upstreamBase = `http://127.0.0.1:${upstream.address().port}`;
  const bridge = await startBridge({ CODEBUDDY_ENDPOINT: upstreamBase }, { auth: READABLE_FAKE_AUTH });
  try {
    const models = await (await fetch(bridge.baseUrl + '/v1/models?all=1', { headers: auth })).json();
    assert.ok(models.data.some((m) => m.id === 'v2-survivor'), 'v2 成功的目录必须保留');
    const health = await (await fetch(bridge.baseUrl + '/health', { headers: auth })).json();
    assert.match(String(health.upstreamShape?.sources?.['/v3/config']), /500/, 'v3 的 5xx 仍要记进诊断');
  } finally { await bridge.stop(); upstream.close(); }
});

test('刷新竞态：刷新期间桌面换号，旧令牌不得写回 memoryAuth', { timeout: 90_000 }, async () => {
  /*
   * 401 → refresh 请求在飞时，桌面端完成了换号。旧实现会在刷新返回后把
   * **旧账号的 userId** 和**新文件的 mtime/size** 一起写进 memoryAuth，
   * 于是桥一直用旧账号令牌（#6 的复发形态）。修复后这次刷新结果必须丢弃，
   * 下一次 readStoredAuth 读到新文件。
   */
  let refreshStarted = false;
  const upstream = createServer((req, res) => {
    const path = new URL(req.url, 'http://127.0.0.1').pathname;
    if (path === '/v2/plugin/auth/token/refresh') {
      refreshStarted = true;
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ code: 0, data: { accessToken: 'refreshed-old', refreshToken: 'rotated', expiresIn: 3600, refreshExpiresIn: 86400 } }));
      }, 700);
      return;
    }
    if (path === '/v2/chat/completions') {
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ code: 401, msg: 'expired' }));
    }
    if (path === '/v3/config' || path === '/v2/enterprises/personal/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ code: 0, data: { models: [] } }));
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const upstreamBase = `http://127.0.0.1:${upstream.address().port}`;
  const bridge = await startBridge(
    { CODEBUDDY_ENDPOINT: upstreamBase, WORKBUDDY_SKIP_MODEL_PREFLIGHT: '1' },
    { auth: authFileFor('account-a') },
  );
  try {
    const chat = fetch(bridge.baseUrl + '/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'stub-model', stream: false, max_tokens: 8,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    }).then((res) => res.text());
    for (let i = 0; i < 40 && !refreshStarted; i += 1) await new Promise((r) => setTimeout(r, 50));
    assert.equal(refreshStarted, true, '请求 401 后必须触发一次 refresh');
    writeFileSync(join(bridge.dir, 'fake-auth.info'), JSON.stringify(authFileFor('account-b')));
    await chat;
    await new Promise((r) => setTimeout(r, 300));
    const h = await (await fetch(bridge.baseUrl + '/health', { headers: auth })).json();
    assert.equal(h.auth?.userId, 'account-b', '刷新期间换号后不能把旧账号令牌写回；health 必须读新文件');
  } finally { await bridge.stop(); upstream.close(); }
});

test('账号跟随：桌面端换号后桥自动改读桌面登录文件；换回则恢复钉住的快照', { timeout: 90_000 }, async () => {
  /*
   * issue #6：面板切换账号把桥钉在快照上，用户随后在 WorkBuddy 客户端换号，
   * 客户端覆盖的是它自己的默认登录文件 —— 桥必须能发现并跟随。
   */
  const pinSub = 'account-pinned';
  const desktopAtPin = 'account-desktop';
  const desktopAfterSwitch = 'account-switched';
  const aux = mkdtempSync(join(tmpdir(), 'wb-bridge-follow-'));
  const followPath = join(aux, 'workbuddy-desktop.info');
  writeFileSync(followPath, JSON.stringify(authFileFor(desktopAtPin)));

  const bridge = await startBridge(
    {
      WORKBUDDY_AUTH_FILE_FOLLOW: followPath,
      WORKBUDDY_AUTH_FOLLOW_UID: desktopAtPin,
    },
    { auth: authFileFor(pinSub) },
  );
  const health = async () => (await (await fetch(bridge.baseUrl + '/health', { headers: auth })).json());
  const waitForUid = async (uid) => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const h = await health().catch(() => null);
      if (h?.auth?.userId === uid) return h;
      await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error(`10 秒内没有切换到 ${uid}；最后一次 health=${JSON.stringify(await health().catch(() => null))}`);
  };
  try {
    const before = await waitForUid(pinSub);
    assert.equal(before.authFollow, undefined, '桌面账号未变时必须继续用用户钉住的快照');

    // 模拟用户在 WorkBuddy 客户端换号：客户端覆盖自己的默认登录文件
    writeFileSync(followPath, JSON.stringify(authFileFor(desktopAfterSwitch)));
    const after = await waitForUid(desktopAfterSwitch);
    assert.equal(after.authFilePinned, join(bridge.dir, 'fake-auth.info'), '健康信息里要能看出钉住的是哪份文件');
    assert.equal(after.authFollow, true, '跟随桌面后必须如实报告');

    // 用户在客户端换回原账号：钉住仍然有效，桥回到快照
    writeFileSync(followPath, JSON.stringify(authFileFor(desktopAtPin)));
    const restored = await waitForUid(pinSub);
    assert.equal(restored.authFollow, undefined, '桌面账号恢复后应回到钉住的快照');
  } finally { await bridge.stop(); rmSync(aux, { recursive: true, force: true }); }
});

test('账号跟随：没有 uid 元数据的旧钉住按“快照账号 ≠ 桌面账号”迁移一次', { timeout: 90_000 }, async () => {
  const aux = mkdtempSync(join(tmpdir(), 'wb-bridge-follow-legacy-'));
  const followPath = join(aux, 'workbuddy-desktop.info');
  writeFileSync(followPath, JSON.stringify(authFileFor('desktop-current')));
  const bridge = await startBridge(
    { WORKBUDDY_AUTH_FILE_FOLLOW: followPath },
    { auth: authFileFor('snapshot-old') },
  );
  try {
    const deadline = Date.now() + 10_000;
    let h = null;
    while (Date.now() < deadline) {
      h = await (await fetch(bridge.baseUrl + '/health', { headers: auth })).json().catch(() => null);
      if (h?.auth?.userId === 'desktop-current') break;
      await new Promise((r) => setTimeout(r, 150));
    }
    assert.equal(h?.auth?.userId, 'desktop-current', '旧状态必须跟随桌面当前账号，而不是继续用过期快照');
    assert.equal(h?.authFollow, true);
  } finally { await bridge.stop(); rmSync(aux, { recursive: true, force: true }); }
});

test('/v1/quota：余额必须带上归属账号，供面板按身份作废缓存', { timeout: 90_000 }, async () => {
  /*
   * issue #6 的第二段现象：「账号显示新、积分还是旧的」。控制台/插件各自
   * 有积分缓存；桌面端在客户端里换号时没有任何东西通知它们。只有让余额
   * 自带 account，才能在下一次读取时发现「这份缓存不属于当前账号」。
   */
  const upstream = createServer((req, res) => {
    const path = new URL(req.url, 'http://127.0.0.1').pathname;
    if (path === '/v2/billing/meter/get-user-resource') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        code: 0,
        data: {
          Response: {
            Data: {
              Accounts: [{
                PackageName: 'stub-package',
                CapacityType: 4,
                CycleCapacitySize: 100,
                CycleCapacityRemain: 42,
              }],
            },
          },
        },
      }));
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    return res.end('{}');
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const bridge = await startBridge(
    {
      CODEBUDDY_ENDPOINT: `http://127.0.0.1:${upstream.address().port}`,
      WORKBUDDY_BILLING_BASE: `http://127.0.0.1:${upstream.address().port}`,
    },
    { auth: authFileFor('quota-account') },
  );
  try {
    const res = await fetch(bridge.baseUrl + '/v1/quota', { headers: auth, signal: AbortSignal.timeout(15000) });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.total, 42);
    assert.equal(body.account, 'quota-account', '/v1/quota 必须说明这份余额属于哪个账号');
    assert.equal(body.source, 'desktop', '来源也要一并带回，面板才能解释账号与桌面文件为何不同');

    const health = await (await fetch(bridge.baseUrl + '/health', { headers: auth })).json();
    assert.match(String(health.build || ''), /^[0-9a-f]{16}$/, '/health 必须带构建指纹（启动方据此重启旧桥）');
  } finally {
    await bridge.stop();
    upstream.close();
  }
});

test('目录缓存：桌面换号后必须作废上一个账号的模型目录', { timeout: 90_000 }, async () => {
  /*
   * 目录属于账号。若只在“切换路径”时作废，同路径原地换号（或来源自动回退
   * 到另一条凭据）会让 /v1/models 继续返回上一个账号的模型/倍率，而 /health
   * 已经是新账号 —— 面板与 dsh 选择器各说一套。
   */
  const stubModels = ['model-a'];
  const stub = await startStubUpstream(stubModels);
  const aux = mkdtempSync(join(tmpdir(), 'wb-catalog-account-'));
  const followPath = join(aux, 'workbuddy-desktop.info');
  writeFileSync(followPath, JSON.stringify(authFileFor('catalog-a')));
  const bridge = await startBridge(
    {
      CODEBUDDY_ENDPOINT: stub.base,
      WORKBUDDY_AUTH_FILE_FOLLOW: followPath,
      WORKBUDDY_AUTH_FOLLOW_UID: 'catalog-a',
      WORKBUDDY_SKIP_MODEL_PREFLIGHT: '1',
    },
    { auth: authFileFor('catalog-a') },
  );
  const health = async () => (await fetch(`${bridge.baseUrl}/health`, { headers: auth })).json();
  const waitUid = async (uid) => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const h = await health().catch(() => null);
      if (h?.auth?.userId === uid) return h;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`10 秒内没有切换到 ${uid}`);
  };
  try {
    const first = await (await fetch(`${bridge.baseUrl}/v1/models?all=1`, { headers: auth })).json();
    assert.ok(first.data.some((m) => m.id === 'model-a'), '初始目录必须来自账号 A');

    stubModels.splice(0, stubModels.length, 'model-b');
    writeFileSync(followPath, JSON.stringify(authFileFor('catalog-b')));
    await waitUid('catalog-b');

    const second = await (await fetch(`${bridge.baseUrl}/v1/models?all=1`, { headers: auth })).json();
    const ids = second.data.map((m) => m.id);
    assert.ok(ids.includes('model-b'), `换号后必须重取目录，实际：${ids.join(',')}`);
    assert.ok(!ids.includes('model-a'), '不能把上一个账号的模型继续留在目录里');
  } finally {
    await bridge.stop();
    stub.close();
    rmSync(aux, { recursive: true, force: true });
  }
});

test('目录：上游 401 时必须刷新令牌后重试（不能把目录缩成 2-3 个精选模型）', { timeout: 90_000 }, async () => {
  /*
   * 凭据过期时目录端点回 401。旧实现把 401 当成「这个区域没有这个端点」跳过，
   * 于是一条上游模型都拿不到，FEATURED 补出 2-3 个精选后照样写进 5 分钟缓存 ——
   * 用户看到"模型只剩几个"，得等 TTL 过期才恢复。聊天路径早就会 refresh+retry，
   * 目录这条路必须一致。
   */
  let refreshed = 0;
  const upstream = createServer((req, res) => {
    const path = new URL(req.url, 'http://127.0.0.1').pathname;
    if (path === '/v2/plugin/auth/token/refresh') {
      refreshed += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ code: 0, data: { accessToken: 'fresh-token', refreshToken: 'rotated', expiresIn: 3600, refreshExpiresIn: 86400 } }));
    }
    if (path === '/v2/enterprises/personal/models') {
      const tokenOk = /fresh-token/.test(String(req.headers.authorization || ''));
      if (!tokenOk) {
        res.writeHead(401, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ code: 401, msg: 'token expired' }));
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        code: 0,
        data: { models: [{ id: 'fresh-model', maxInputTokens: 128000, maxOutputTokens: 4096 }] },
      }));
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code: 0, data: { models: [] } }));
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));

  const bridge = await startBridge({
    CODEBUDDY_ENDPOINT: `http://127.0.0.1:${upstream.address().port}`,
    WORKBUDDY_TRANSPORT_RETRY_MS: '0',
  }, { auth: READABLE_FAKE_AUTH });
  try {
    const res = await fetch(`${bridge.baseUrl}/v1/models?all=1&refresh=1`, { headers: auth, signal: AbortSignal.timeout(20_000) });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(refreshed >= 1, '401 之后必须尝试刷新令牌');
    assert.ok((body.data || []).some((m) => m.id === 'fresh-model'),
      `刷新令牌后必须拿到上游目录，而不是只剩精选模型。实际：${JSON.stringify((body.data || []).map((m) => m.id))}`);
  } finally {
    await bridge.stop();
    await new Promise((r) => upstream.close(r));
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

test('桥：上游 429（14003）在桥这层等待重试，客户端无感', { timeout: 90_000 }, async () => {
  /*
   * 现场（2026-10-13 16:0x 实测）：上游按账号限流回 429，桥原先原样甩给 Codex，
   * 它 1-30s 一条地重试（5 连 429），回合被砍成"说话说一半"。修法：桥按
   * WORKBUDDY_429_WAITS 的计划在本地等待并原样重发，成功后客户端完全无感。
   */
  let chatHits = 0;
  const seen = [];
  const srv = createServer((req, res) => {
    const path = new URL(req.url, 'http://127.0.0.1').pathname;
    if (path === '/v2/enterprises/personal/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        code: 0,
        data: { models: [{ id: 'r429-model', maxInputTokens: 128000, maxOutputTokens: 4096 }] },
      }));
    }
    if (path === '/v3/config') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ code: 0, data: { models: [] } }));
    }
    if (path === '/v2/chat/completions') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        seen.push(body);
        chatHits += 1;
        if (chatHits === 1) {
          res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '1' });
          return res.end(JSON.stringify({ code: 14003, msg: 'too many requests', retry_policy: { retry: true } }));
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"choices":[{"delta":{"content":"ok-after-429"}}]}\n\n');
        res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}\n\n');
        res.end('data: [DONE]\n\n');
      });
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const bridge = await startBridge(
    {
      CODEBUDDY_ENDPOINT: `http://127.0.0.1:${srv.address().port}`,
      WORKBUDDY_429_WAITS: '200',
    },
    { auth: READABLE_FAKE_AUTH },
  );
  try {
    await fetch(bridge.baseUrl + '/v1/models?all=1'); // 预热目录
    const res = await fetch(bridge.baseUrl + '/v1/chat/completions', {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'r429-model', messages: [{ role: 'user', content: 'hi' }] }),
      signal: AbortSignal.timeout(15000),
    });
    assert.equal(res.status, 200, '上游 429 必须在桥这层重试掉 —— 客户端拿到 200，而不是失败');
    const j = await res.json();
    assert.equal(j.choices?.[0]?.message?.content, 'ok-after-429', '重试成功后的回答要原样到达客户端');
    assert.equal(chatHits, 2, '上游应被命中 2 次：第一次 429，桥等待后重试成功');
    assert.equal(seen.length, 2, '两次请求体应完全一致（原样重发，不是重新组装）');
    assert.equal(seen[0], seen[1]);
  } finally {
    await bridge.stop();
    try { await srv.close(); } catch { /* 忽略 */ }
    rmSync(bridge.dir, { recursive: true, force: true });
  }
});

/**
 * 上游 5xx 重试：2026-10-15 的真实故障里，多数 500/502 在 1 秒后原样重发即可成功。
 * 桥不重试 = 用户丢掉一整轮已经发出去的上下文。
 */
test('桥：上游 502 在桥这层重试一次，客户端无感', { timeout: 90_000 }, async () => {
  const okRaw = 'data: {"choices":[{"delta":{"content":"ok-after-502"}}]}\n\n'
    + 'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}\n\n'
    + 'data: [DONE]\n\n';
  const stub = await startStubUpstream(['stub-model'], {
    chatSequence: [
      { status: 502, type: 'application/json', raw: JSON.stringify({ msg: 'upstream temporarily unavailable' }) },
      { status: 200, type: 'text/event-stream', raw: okRaw },
    ],
  });
  const bridge = await startBridge({
    CODEBUDDY_ENDPOINT: stub.base,
    WORKBUDDY_SKIP_MODEL_PREFLIGHT: '1',
    WORKBUDDY_5XX_RETRY_DELAY_MS: '10',
  }, { auth: READABLE_FAKE_AUTH });
  try {
    const res = await fetch(bridge.baseUrl + '/v1/chat/completions', {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'stub-model', messages: [{ role: 'user', content: 'hi' }], max_tokens: 8 }),
      signal: AbortSignal.timeout(20_000),
    });
    assert.equal(res.status, 200, '上游 502 必须在桥这层重试掉 —— 客户端拿到 200');
    const j = await res.json();
    assert.equal(j.choices?.[0]?.message?.content, 'ok-after-502');
    const calls = stub.seen.filter((s) => JSON.parse(s.body || '{}').model).length;
    assert.equal(calls, 2, '应恰好重试 1 次（共 2 次上游请求）');
  } finally {
    await bridge.stop();
    stub.close();
    rmSync(bridge.dir, { recursive: true, force: true });
  }
});

test('桥：WORKBUDDY_5XX_RETRY=0 时 502 不重试（快速失败）', { timeout: 90_000 }, async () => {
  const stub = await startStubUpstream(['stub-model'], {
    chatStatus: 502,
    chatType: 'application/json',
    chatRaw: JSON.stringify({ msg: 'upstream temporarily unavailable' }),
  });
  const bridge = await startBridge({
    CODEBUDDY_ENDPOINT: stub.base,
    WORKBUDDY_SKIP_MODEL_PREFLIGHT: '1',
    WORKBUDDY_5XX_RETRY: '0',
  }, { auth: READABLE_FAKE_AUTH });
  try {
    const res = await fetch(bridge.baseUrl + '/v1/chat/completions', {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'stub-model', messages: [{ role: 'user', content: 'hi' }], max_tokens: 8 }),
      signal: AbortSignal.timeout(20_000),
    });
    assert.equal(res.status, 502, '关闭重试后 502 原样返回');
    const calls = stub.seen.filter((s) => JSON.parse(s.body || '{}').model).length;
    assert.equal(calls, 1, '开关关闭时只许打上游 1 次');
  } finally {
    await bridge.stop();
    stub.close();
    rmSync(bridge.dir, { recursive: true, force: true });
  }
});

test('桥：501 不在 5xx 重试表内（重发也不会变）', { timeout: 90_000 }, async () => {
  const okRaw = 'data: {"choices":[{"delta":{"content":"should-not-arrive"}}]}\n\n'
    + 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
  const stub = await startStubUpstream(['stub-model'], {
    chatSequence: [
      { status: 501, type: 'application/json', raw: JSON.stringify({ msg: 'not implemented' }) },
      { status: 200, type: 'text/event-stream', raw: okRaw },
    ],
  });
  const bridge = await startBridge({
    CODEBUDDY_ENDPOINT: stub.base,
    WORKBUDDY_SKIP_MODEL_PREFLIGHT: '1',
    WORKBUDDY_5XX_RETRY_DELAY_MS: '10',
  }, { auth: READABLE_FAKE_AUTH });
  try {
    const res = await fetch(bridge.baseUrl + '/v1/chat/completions', {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'stub-model', messages: [{ role: 'user', content: 'hi' }], max_tokens: 8 }),
      signal: AbortSignal.timeout(20_000),
    });
    assert.equal(res.status, 501, '501 不该被重试，原样返回');
    const calls = stub.seen.filter((s) => JSON.parse(s.body || '{}').model).length;
    assert.equal(calls, 1, '501 只许打上游 1 次');
  } finally {
    await bridge.stop();
    stub.close();
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

    // ③ 客户端断开：abort → 同样释放（注册表不得泄漏），且必须留下账本记录
    mode = 'ok'; resetGate();
    const usageFile = join(bridge.dir, 'usage.jsonl');
    const usageCount = () => {
      try { return readFileSync(usageFile, 'utf8').split('\n').filter(Boolean).length; } catch { return 0; }
    };
    const usageBefore = usageCount();
    const ac = new AbortController();
    const p3 = chat(ac.signal).catch(() => null);
    await waitFor((d) => d.active.length === 1, '断开场景出现进行中条目');
    ac.abort();
    await p3;
    await waitFor((d) => d.active.length === 0, '客户端断开后被释放');
    const usageDeadline = Date.now() + 8000;
    while (usageCount() <= usageBefore && Date.now() < usageDeadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(usageCount() > usageBefore, '客户端断开后该请求仍必须记账（账本上不能静默消失）');
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

    // ⑤ client key 只能聊天：管理面（切号 / 删凭据 / 清账本 / 登录 / 签到）必须 403
    const mgmt = (path, method, token) => fetch(bridge.baseUrl + path, {
      method,
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10000),
    });
    for (const [path, method] of [
      ['/v1/auth/source', 'GET'],
      ['/v1/auth/credentials', 'GET'],
      ['/v1/auth/source', 'POST'],
      ['/v1/usage', 'DELETE'],
      ['/v1/checkin', 'POST'],
    ]) {
      const res = await mgmt(path, method, 'key-bbb');
      assert.equal(res.status, 403, `${method} ${path} 不应接受 client key`);
      await res.text();
    }
    const localSource = await mgmt('/v1/auth/source', 'GET', TOKEN);
    assert.equal(localSource.status, 200, 'LOCAL_TOKEN 仍必须能访问管理面');
    await localSource.text();
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
 * Anthropic `tool_result` 里的图片**不能静默丢掉**。
 *
 * Claude Code 的截图工具把图放在 `tool_result.content` 的 image 块里。
 * 桥原先只挑 `type:"text"` 的块（`anthropicToolResultText` 的 filter），
 * 于是图片**不报错地消失** —— 模型"看不见图"，排查时毫无线索。
 *
 * 与 Responses 侧同源的坑（那边是 `JSON.stringify` 成纯文本，代价 187 倍；
 * 这边是直接丢，代价是功能没了）。两处都已改成走内容块数组。
 */
test('桥：Anthropic tool_result 里的图片必须转发（不能静默丢）', { timeout: 30_000 }, async () => {
  const stub = await startStubUpstream(['stub-model']);
  const bridge = await startBridge({ CODEBUDDY_ENDPOINT: stub.base }, { auth: READABLE_FAKE_AUTH });
  try {
    const dataUri = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';
    const res = await fetch(`${bridge.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'stub-model',
        max_tokens: 64,
        stream: false,
        messages: [
          { role: 'user', content: 'screenshot it' },
          {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'toolu_1', name: 'screenshot', input: {} }],
          },
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu_1',
                content: [
                  { type: 'text', text: 'captured' },
                  { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUg==' } },
                ],
              },
            ],
          },
        ],
      }),
    });
    assert.equal(res.status, 200);

    const sent = stub.seen.find((s) => s.body.includes('toolu_1'));
    assert.ok(sent, '上游没收到带 tool_result 的请求');
    const body = JSON.parse(sent.body);
    const toolMsg = body.messages.find((m) => m.role === 'tool');
    assert.ok(toolMsg, '缺 role:"tool" 消息');

    assert.ok(Array.isArray(toolMsg.content),
      `tool_result 含图片时必须回内容块数组，实际是 ${typeof toolMsg.content}（图片被静默丢掉了）`);
    const img = toolMsg.content.find((p) => p.type === 'image_url');
    assert.ok(img, '图片丢了：tool_result 里的 image 块必须转成 image_url');
    assert.equal(img.image_url.url, dataUri, 'base64 图片要按 data URI 原样透传');
    assert.equal(toolMsg.content.find((p) => p.type === 'text')?.text, 'captured',
      '同一条 tool_result 里的文本块要保留');
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
 * 提示缓存命中量必须记进账本。
 *
 * ## 为什么钉这条（2026-10-13 实测：26 倍的隐藏成本）
 *
 * 提示缓存是这条链路上**最大的单因素**，但它原先在账本里**完全不可见** ——
 * `usageOf()` 只记 promptTokens / completionTokens / credit，于是：
 *   · **成本**：同一批 >=40k 的请求里，未命中 **0.0142 积分/1k tokens**、
 *     已命中 **0.0005** —— 差 **26 倍**；93 条里 **6 条未命中就花掉 10.00 积分**，
 *     而 87 条命中合计才 10.20。这 10 个积分在控制台上与"正常用量"毫无区别。
 *   · **延迟**：实测冷缓存 TTFT 14.8s → 命中后 5.9s（2.5 倍）。
 *
 * 现在账本带 `cachedTokens` / `cacheMissTokens`，控制台就能把"贵且慢"的
 * 那几条单独标出来。
 *
 * ## 口径要点
 *
 * 上游对同一件事给了**多个别名**，且常与恒 0 的占位并存（实测 usage 里
 * `prompt_tokens_details.cached_tokens` 与顶层 `cached_tokens`、
 * `prompt_cache_hit_tokens` 同时存在）——所以取最大值，不是 `??` 链。
 * 这里就把"占位 0 不能挡住真实值"钉死。
 */
test('桥：提示缓存命中量必须记进账本（26 倍成本差异的来源）', { timeout: 30_000 }, async () => {
  const stub = await startStubUpstream(['stub-model'], {
    chatRaw: 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'
      + 'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{'
      // 真实值藏在 details 里；顶层两个同义字段是**恒 0 的占位**（上游实测形状）
      + '"prompt_tokens":1000,"completion_tokens":5,"total_tokens":1005,'
      + '"cached_tokens":0,"prompt_cache_hit_tokens":0,'
      + '"prompt_cache_miss_tokens":120,'
      + '"prompt_tokens_details":{"cached_tokens":880}'
      + '}}\n\n'
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
    const last = rows[rows.length - 1];

    assert.equal(last.cachedTokens, 880,
      '必须取到 prompt_tokens_details.cached_tokens 的真实值，不能被顶层占位 0 挡住');
    assert.equal(last.cacheMissTokens, 120, '未命中计数要一并记下');
    assert.equal(last.promptTokens, 1000, '原有字段不受影响');
    assert.ok(!/NaN|Infinity/.test(JSON.stringify(last)), '账本行不得含 NaN/Infinity');
  } finally {
    await bridge.stop();
    try { await stub.close(); } catch { /* 忽略 */ }
    rmSync(bridge.dir, { recursive: true, force: true });
  }
});

/**
 * 上游**没报**缓存字段时，账本不得凭空写 0。
 *
 * 0 是"确实没命中"，缺字段是"上游没报"——两者混起来会让命中率统计失真
 * （拿"没报"当"未命中"会把命中率系统性压低）。所以缺失时字段应当**不出现**。
 */
test('桥：上游没报缓存字段时不得写 0（缺报 ≠ 未命中）', { timeout: 30_000 }, async () => {
  const stub = await startStubUpstream(['stub-model'], {
    chatRaw: 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'
      + 'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}\n\n'
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
    const last = rows[rows.length - 1];

    assert.ok(!('cachedTokens' in last), '上游没报命中量时不该写 0');
    assert.ok(!('cacheMissTokens' in last), '上游没报未命中量时不该写 0');
    assert.equal(last.promptTokens, 10, '原有字段照常');
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

/**
 * 确定性 400 必须**快速失败**，不许进退避重试。
 *
 * ## 为什么钉这条（2026-10-13 实测的 40 秒白等）
 *
 * 桥原先对所有 `400 code 11133` 一视同仁地跑 `TRANSIENT_400_DELAYS`
 * （1s+4s+10s+25s = **40 秒**）。但 11133 只是包装码，真因在 `extError.code`：
 * 日志取证显示 122 次 11133 **全是**确定性的
 * （`model_param_invalid` 116 + `invalid_reasoning_effort` 6），
 * 没有一次是瞬时故障 —— 109 个重试簇跑满 4 档后**照样**报错，
 * 纯等待累计 2460 秒（41 分钟）。用户感知就是「问一句，卡 40 秒，然后报错」。
 *
 * ## 口径
 *
 * 退避表被 `WORKBUDDY_TRANSIENT_400_DELAYS=30,30,30,30` 压到毫秒级：
 * 这样「不该重试」的用例能在 2 秒内证伪（真跑 40 秒的用例没人会保留）。
 * 断言不看耗时（CI 上机器慢会假红），而是看**打到上游的对话请求次数** ——
 * 确定性 400 必须**恰好 1 次**，一次都不许多打。
 */
test('桥：确定性 400（11133 + model_param_invalid）必须快速失败，不得退避重试 40 秒', { timeout: 60_000 }, async () => {
  const stub = await startStubUpstream(['stub-model'], {
    chatStatus: 400,
    chatType: 'application/json',
    chatRaw: JSON.stringify({
      code: 11133,
      msg: 'Invalid request parameters',
      extError: {
        code: 'model_param_invalid',
        message: 'the request parameters were rejected by the model provider',
        type: 'invalid_request_error',
      },
    }),
  });
  // 退避压到 30ms：若代码回退成"照旧重试"，本用例仍会重试 4 次，但只花 ~120ms，
  // 于是"上游命中次数"这条断言能在毫秒级抓住回归（不必等 40 秒）。
  const bridge = await startBridge({
    CODEBUDDY_ENDPOINT: stub.base,
    WORKBUDDY_SKIP_MODEL_PREFLIGHT: '1',
    WORKBUDDY_TRANSIENT_400_DELAYS: '30,30,30,30',
  }, { auth: READABLE_FAKE_AUTH });
  try {
    const res = await fetch(`${bridge.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'stub-model', messages: [{ role: 'user', content: 'hi' }], max_tokens: 8 }),
      signal: AbortSignal.timeout(20_000),
    });
    assert.equal(res.status, 400, '确定性 400 必须原样回给客户端');
    const text = await res.text();
    assert.match(text, /model_param_invalid/, '错误体要带上真因，便于用户改参数');

    const chatCalls = stub.seen.filter((s) => JSON.parse(s.body || '{}').model).length;
    assert.equal(chatCalls, 1,
      `确定性 400 只许打上游 1 次；实际 ${chatCalls} 次（重试回归了，用户会白等 40 秒）`);
  } finally {
    await bridge.stop();
    stub.close();
    rmSync(bridge.dir, { recursive: true, force: true });
  }
});

/**
 * 真瞬时 400（11133 但**没有** extError 判据）必须**仍然重试**，并且能救回。
 *
 * 这条与上一条配对，缺一不可：
 *   · 上一条钉「不许对确定性错误瞎等」；
 *   · 这一条钉「不许矫枉过正，把真瞬时的也一并放弃」。
 *
 * 桩按 `chatSequence` 前 2 次回 400、第 3 次回正常 SSE —— 断言最终 200，
 * 证明重试链确实把请求救回来了（而不是只看日志里"有 retry"这种弱证据）。
 */
test('桥：真瞬时 400（11133 无 extError 判据）必须仍然重试并救回', { timeout: 60_000 }, async () => {
  const transient400 = JSON.stringify({ code: 11133, msg: 'Invalid request parameters' });
  const stub = await startStubUpstream(['stub-model'], {
    chatSequence: [
      { status: 400, type: 'application/json', raw: transient400 },
      { status: 400, type: 'application/json', raw: transient400 },
      {
        status: 200,
        type: 'text/event-stream',
        raw: 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n'
          + 'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}\n\n'
          + 'data: [DONE]\n\n',
      },
    ],
  });
  const bridge = await startBridge({
    CODEBUDDY_ENDPOINT: stub.base,
    WORKBUDDY_SKIP_MODEL_PREFLIGHT: '1',
    WORKBUDDY_TRANSIENT_400_DELAYS: '20,20,20,20',
  }, { auth: READABLE_FAKE_AUTH });
  try {
    const res = await fetch(`${bridge.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'stub-model', messages: [{ role: 'user', content: 'hi' }], max_tokens: 8 }),
      signal: AbortSignal.timeout(30_000),
    });
    assert.equal(res.status, 200, '瞬时 400 重试后必须成功');
    const body = await res.json();
    assert.equal(body.choices?.[0]?.message?.content, 'ok', '救回的响应内容要完整');

    const chatCalls = stub.seen.filter((s) => JSON.parse(s.body || '{}').model).length;
    assert.equal(chatCalls, 3, `应当恰好重试 2 次（共 3 次）；实际 ${chatCalls} 次`);
  } finally {
    await bridge.stop();
    stub.close();
    rmSync(bridge.dir, { recursive: true, force: true });
  }
});

/**
 * `WORKBUDDY_TRANSIENT_400_RETRY=0` 必须把 400 重试**整体**关掉（含真瞬时的）。
 *
 * 这是给"速度绝对优先"的用户留的出口：宁可立刻报错让客户端自己退避，
 * 也不要桥在这里替它等。默认开，所以必须有用例证明这个开关真的有效 ——
 * 否则它只是一个写在文档里、实际不生效的旋钮。
 */
test('桥：WORKBUDDY_TRANSIENT_400_RETRY=0 时连瞬时 400 也不重试', { timeout: 60_000 }, async () => {
  const stub = await startStubUpstream(['stub-model'], {
    chatStatus: 400,
    chatType: 'application/json',
    chatRaw: JSON.stringify({ code: 11133, msg: 'Invalid request parameters' }),
  });
  const bridge = await startBridge({
    CODEBUDDY_ENDPOINT: stub.base,
    WORKBUDDY_SKIP_MODEL_PREFLIGHT: '1',
    WORKBUDDY_TRANSIENT_400_DELAYS: '20,20,20,20',
    WORKBUDDY_TRANSIENT_400_RETRY: '0',
  }, { auth: READABLE_FAKE_AUTH });
  try {
    const res = await fetch(`${bridge.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'stub-model', messages: [{ role: 'user', content: 'hi' }], max_tokens: 8 }),
      signal: AbortSignal.timeout(20_000),
    });
    assert.equal(res.status, 400);
    const chatCalls = stub.seen.filter((s) => JSON.parse(s.body || '{}').model).length;
    assert.equal(chatCalls, 1, `开关关闭时必须一次就返回；实际打了 ${chatCalls} 次`);
  } finally {
    await bridge.stop();
    stub.close();
    rmSync(bridge.dir, { recursive: true, force: true });
  }
});

/**
 * 瞬时 DNS / 建连失败必须**重试**，而不是直接 500。
 *
 * ## 为什么钉这条（2026-10-13 实测）
 *
 * 账本里有 20 条 `getaddrinfo ENOTFOUND www.workbuddy.ai`，其中 **17 条挤在同一个
 * 小时**——典型的解析器抖动（VPN/代理切换、DNS 缓存过期），不是域名不存在：
 * 同一台机器随后连测 12 次解析全部成功、中位 0.2ms。
 *
 * 桥原先的重试只认 `ECONNRESET|socket hang up|EPIPE`（keep-alive 复用被掐），
 * 对 DNS/建连这一族**一次都不重试**，直接把 500 丢给客户端。用户看到
 * 「本地桥连接失败」，实际只是抖了一下。
 *
 * ## 判据为什么看日志标记
 *
 * DNS 失败**没有外部可观测的"试了几次"**：两次尝试都解析不到同一个不存在的名字，
 * 客户端拿到的都是 500。所以判据取桥自己打的标记 ——
 * `transient transport failure` 只在**新加的那条重试分支**里出现，
 * 老代码（只认 ECONNRESET 那一族）永远不会打它。标记出现 = 这条分支真的生效了。
 *
 * 域名用 `.invalid`：RFC 2606 保留、**保证解析不了**，所以不依赖任何环境，
 * 也不会因为"碰巧解析成功"而假绿。
 */
test('桥：瞬时 DNS 失败必须走重试分支（不是直接 500）', { timeout: 60_000 }, async () => {
  const bridge = await startBridge({
    // RFC 2606 保留域名：保证 ENOTFOUND
    CODEBUDDY_ENDPOINT: 'http://workbuddy-bridge-test.invalid:8790',
    WORKBUDDY_SKIP_MODEL_PREFLIGHT: '1',
    WORKBUDDY_TRANSPORT_RETRY_MS: '0',
    WORKBUDDY_LOG: '1',
  }, { auth: READABLE_FAKE_AUTH });
  try {
    const res = await fetch(`${bridge.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'stub-model', messages: [{ role: 'user', content: 'hi' }], max_tokens: 8 }),
      signal: AbortSignal.timeout(30_000),
    });
    // 域名确实不存在 → 最终仍然是失败（重试救不回来），但**必须**已经试过重试
    assert.ok(res.status >= 400, '解析不了的域名最终必须报错，不能假装成功');
    const out = bridge.out();
    assert.match(out, /transient transport failure/,
      `DNS 失败必须走重试分支（日志里应有 "transient transport failure"）。实际输出：\n${out.slice(-1500)}`);
    // 且错误原文要如实回给客户端，便于用户区分"域名配错"与"网络抖动"
    const text = await res.text();
    assert.match(text, /ENOTFOUND|getaddrinfo|EAI_AGAIN|ENOTFOUND/i,
      `错误体要带上真实原因，实际：${text.slice(0, 200)}`);
  } finally {
    await bridge.stop();
    rmSync(bridge.dir, { recursive: true, force: true });
  }
});

/**
 * 传输层瞬时失败**恢复后必须救回**（端到端）：第一次连接被粗暴断开、第二次正常。
 *
 * 与上一条互补：上一条证明"重试分支会被走到"，这一条证明"重试真的能救回请求"
 * （最终 200 + 正文完整，且上游恰好被打了 2 次）。
 *
 * 用 `req.socket.destroy()` 造错而不是"先关端口再抢时间起服务"：
 * 后者依赖时序，在 CI 上会随机红。
 */
test('桥：传输层瞬时失败重试后必须救回完整响应', { timeout: 60_000 }, async () => {
  let chatHits = 0;
  const srv = createServer((req, res) => {
    const p = new URL(req.url, 'http://127.0.0.1').pathname;
    if (p === '/v2/enterprises/personal/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ code: 0, data: { models: [{ id: 'stub-model', maxInputTokens: 128000, maxOutputTokens: 4096 }] } }));
    }
    if (p === '/v3/config') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ code: 0, data: { models: [] } }));
    }
    if (p === '/v2/chat/completions') {
      req.resume();
      req.on('end', () => {
        chatHits += 1;
        if (chatHits === 1) { req.socket.destroy(); return; } // 第一次：粗暴断开
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"choices":[{"delta":{"content":"recovered"}}]}\n\n');
        res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}\n\n');
        res.end('data: [DONE]\n\n');
      });
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));

  const bridge = await startBridge({
    CODEBUDDY_ENDPOINT: `http://127.0.0.1:${srv.address().port}`,
    WORKBUDDY_SKIP_MODEL_PREFLIGHT: '1',
    WORKBUDDY_TRANSPORT_RETRY_MS: '0',
  }, { auth: READABLE_FAKE_AUTH });
  try {
    const res = await fetch(`${bridge.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'stub-model', messages: [{ role: 'user', content: 'hi' }], max_tokens: 8 }),
      signal: AbortSignal.timeout(30_000),
    });
    assert.equal(res.status, 200, '瞬时传输失败重试后必须成功（而不是 500）');
    const body = await res.json();
    assert.equal(body.choices?.[0]?.message?.content, 'recovered', '救回的响应内容要完整');
    assert.equal(chatHits, 2, `应当恰好重试 1 次（共 2 次上游对话）；实际 ${chatHits} 次`);
  } finally {
    await bridge.stop();
    await new Promise((r) => srv.close(r));
    rmSync(bridge.dir, { recursive: true, force: true });
  }
});

/*
 * ═══ 聊天路径的两条「不能把失败伪装成成功」═══════════════════════════════
 *
 * 另两条路径（Anthropic / Responses）早就修过同一类坑，只有 chat 这条漏了。
 * 日志取证：`stream interrupted` 在这条路径上有 21 条，另两条各 0 条 ——
 * 真实流量就在走这里。
 */

test('桥：流中途断掉时必须告诉客户端（不能只记一笔账就干净 EOF）', { timeout: 60_000 }, async () => {
  const srv = createServer((req, res) => {
    const path = new URL(req.url, 'http://127.0.0.1').pathname;
    if (path !== '/v2/chat/completions') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ code: 0, data: { models: [] } }));
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"id":"c1","model":"m","choices":[{"delta":{"content":"说到一半"}}]}\n\n');
    // 粗暴掐断：没有 finish_reason、没有 usage、没有 [DONE]
    setTimeout(() => res.destroy(), 30);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));

  const bridge = await startBridge({
    CODEBUDDY_ENDPOINT: `http://127.0.0.1:${srv.address().port}`,
    WORKBUDDY_SKIP_MODEL_PREFLIGHT: '1',
    WORKBUDDY_TRANSPORT_RETRY_MS: '0',
  }, { auth: READABLE_FAKE_AUTH });
  try {
    const res = await fetch(`${bridge.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'stub-model', messages: [{ role: 'user', content: 'hi' }], stream: true }),
      signal: AbortSignal.timeout(30_000),
    });
    assert.equal(res.status, 200, '已经答应过是事件流，只能 200 + SSE');
    const text = await res.text();

    /*
     * 核心断言：客户端必须能看出"这一轮没跑完"。
     * 原先这条路径**一个字节都不写**就 res.end() —— 客户端在 200 事件流上看到
     * 一个干净的 EOF，dsh 的适配器把"有内容 + 无 finish_reason"判成
     * `{kind:'stop'}`，于是 agent 被告知"正常完成"，用户看到半句话就停、
     * 不报错也不重试。
     */
    assert.match(text, /"error"/,
      `流中途断了却没有任何错误信号（客户端只会看到一个干净的 EOF）。实际响应体：${JSON.stringify(text.slice(-300))}`);
    assert.match(text, /interrupted/i, '错误信息要说清是"上游流中途断了"');
    // 已收到的半截内容仍要带出去（便于排查）
    assert.match(text, /说到一半/, '已经收到的内容不该被丢掉');
    // 收尾信号：给了 error 之后补 [DONE]，客户端才好干净地结束解析
    assert.match(text, /\[DONE\]/, '错误之后要有 [DONE]，否则有的客户端会一直等');
  } finally {
    await bridge.stop();
    await new Promise((r) => srv.close(r));
    rmSync(bridge.dir, { recursive: true, force: true });
  }
});

test('桥：流式遇到「有内容但干净半关」也必须报错（不能只修非流式）', { timeout: 60_000 }, async () => {
  /*
   * 与上一条（res.destroy 硬断）不同的失败形态：上游**正常收尾**，但既没有
   * finish_reason 也没有 [DONE]（代理超时后正常关闭、chunked 结束、网关漏发）。
   *
   * 旧实现只跟踪 `usage`，于是这条路径记 ok:true 且一个错误信号都不发；
   * dsh 的适配器看到干净 EOF + 有内容，判成 `stop` —— 用户看到半句话就停。
   * 非流式路径早就用 `completed === false` 修过，流式才是真实流量。
   */
  const srv = createServer((req, res) => {
    const path = new URL(req.url, 'http://127.0.0.1').pathname;
    if (path !== '/v2/chat/completions') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ code: 0, data: { models: [] } }));
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"id":"c1","model":"m","choices":[{"delta":{"content":"说到一半"}}]}\n\n');
    res.end(); // 干净半关：没有 finish_reason / usage / [DONE]
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));

  const bridge = await startBridge({
    CODEBUDDY_ENDPOINT: `http://127.0.0.1:${srv.address().port}`,
    WORKBUDDY_SKIP_MODEL_PREFLIGHT: '1',
    WORKBUDDY_TRANSPORT_RETRY_MS: '0',
  }, { auth: READABLE_FAKE_AUTH });
  try {
    const res = await fetch(`${bridge.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'stub-model', messages: [{ role: 'user', content: 'hi' }], stream: true }),
      signal: AbortSignal.timeout(30_000),
    });
    assert.equal(res.status, 200, '已经答应过是事件流，只能 200 + SSE');
    const text = await res.text();
    assert.match(text, /说到一半/, '已经收到的内容不该被丢掉');
    assert.match(text, /"error"/, '干净半关也必须补 error 帧，客户端才知道被截断');
    assert.match(text, /before completion/i, '错误信息要指出"流没跑完"');
    assert.match(text, /\[DONE\]/, 'error 之后要有 [DONE]，客户端才好干净地结束解析');

    // 账本同样要记失败：否则"回答为什么少了一半"在控制台上不可见
    const ledger = await (await fetch(`${bridge.baseUrl}/v1/requests?limit=5`, { headers: auth, signal: AbortSignal.timeout(8000) })).json();
    const last = (ledger.requests || [])[0];
    assert.equal(last?.ok, false, `流式截断必须记 ok:false。实际账本：${JSON.stringify(last)}`);
    assert.match(String(last?.error), /before completion/i);
  } finally {
    await bridge.stop();
    await new Promise((r) => srv.close(r));
    rmSync(bridge.dir, { recursive: true, force: true });
  }
});

test('桥：非流式聚合遇到「有内容但没跑完」必须回 502，不能报成完整回答', { timeout: 60_000 }, async () => {
  const srv = createServer((req, res) => {
    const path = new URL(req.url, 'http://127.0.0.1').pathname;
    if (path !== '/v2/chat/completions') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ code: 0, data: { models: [] } }));
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    // **干净地**半关：有内容，但没有 finish_reason / usage / [DONE]
    res.end('data: {"id":"c1","model":"m","choices":[{"delta":{"content":"The answer is 4"}}]}\n\n');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));

  const bridge = await startBridge({
    CODEBUDDY_ENDPOINT: `http://127.0.0.1:${srv.address().port}`,
    WORKBUDDY_SKIP_MODEL_PREFLIGHT: '1',
    WORKBUDDY_TRANSPORT_RETRY_MS: '0',
  }, { auth: READABLE_FAKE_AUTH });
  try {
    const res = await fetch(`${bridge.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'stub-model', messages: [{ role: 'user', content: 'hi' }] }),
      signal: AbortSignal.timeout(30_000),
    });
    /*
     * 原先：`parsed > 0` 就放过 → 回 200 + `finish_reason:"stop"` + 半句内容，
     * 客户端以为回答说完了、不重试；账本还记成 ok:true 的 0/0 tokens 健康记录。
     */
    assert.equal(res.status, 502,
      '上游在吐了内容后干净地半关，必须按失败处理（回 200 会让客户端以为回答完整）');
    const j = await res.json();
    assert.match(JSON.stringify(j), /before completion|no parseable SSE data/i,
      `错误信息要指出"流没跑完"。实际：${JSON.stringify(j).slice(0, 300)}`);
  } finally {
    await bridge.stop();
    await new Promise((r) => srv.close(r));
    rmSync(bridge.dir, { recursive: true, force: true });
  }
});

test('桥：max_completion_tokens 必须翻译成 max_tokens（不能静默丢掉输出上限）', { timeout: 60_000 }, async () => {
  let seen = null;
  const srv = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const path = new URL(req.url, 'http://127.0.0.1').pathname;
      if (path !== '/v2/chat/completions') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ code: 0, data: { models: [] } }));
      }
      try { seen = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { seen = null; }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: {"id":"c1","model":"m","choices":[{"delta":{"content":"ok"}}]}\n\ndata: {"id":"c1","model":"m","choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));

  const bridge = await startBridge({
    CODEBUDDY_ENDPOINT: `http://127.0.0.1:${srv.address().port}`,
    WORKBUDDY_SKIP_MODEL_PREFLIGHT: '1',
    WORKBUDDY_TRANSPORT_RETRY_MS: '0',
  }, { auth: READABLE_FAKE_AUTH });
  try {
    // 只给新式字段：上限必须被翻译过去，而不是丢掉
    await fetch(`${bridge.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'stub-model', messages: [{ role: 'user', content: 'hi' }], max_completion_tokens: 500 }),
      signal: AbortSignal.timeout(30_000),
    }).then((r) => r.text());
    assert.equal(seen?.max_tokens, 500,
      `max_completion_tokens=500 必须翻译成上游认的 max_tokens（否则输出上限静默消失，回合变成无上限）。实际 payload：${JSON.stringify(seen)?.slice(0, 200)}`);
    assert.equal('max_completion_tokens' in (seen || {}), false, '翻译后不该再把新式字段原样转发');

    // 两个都给时：以 max_tokens 为准（保留"避免语义冲突"的原意）
    await fetch(`${bridge.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'stub-model', messages: [{ role: 'user', content: 'hi' }], max_tokens: 128, max_completion_tokens: 500 }),
      signal: AbortSignal.timeout(30_000),
    }).then((r) => r.text());
    assert.equal(seen?.max_tokens, 128, '两个都给时以 max_tokens 为准');
  } finally {
    await bridge.stop();
    await new Promise((r) => srv.close(r));
    rmSync(bridge.dir, { recursive: true, force: true });
  }
});


test('桥：思考档位按实测表校验 —— 表外值剥掉、表内值保留', { timeout: 60_000 }, async () => {
  // deepseek-v4.1-flash 实测 6 档（不含 off，见 REASONING_EFFORTS_BY_MODEL）。
  // 客户端（老面板写死三档 / curl）发 off 会被上游确定性 400，桥应在出站前剥掉。
  const seen = [];
  const srv = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const path = new URL(req.url, 'http://127.0.0.1').pathname;
      if (path !== '/v2/chat/completions') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ code: 0, data: { models: [] } }));
      }
      try { seen.push(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { seen.push(null); }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: {"id":"c1","model":"m","choices":[{"delta":{"content":"ok"}}]}\n\ndata: {"id":"c1","model":"m","choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const bridge = await startBridge({
    CODEBUDDY_ENDPOINT: `http://127.0.0.1:${srv.address().port}`,
    WORKBUDDY_SKIP_MODEL_PREFLIGHT: '1',
    WORKBUDDY_TRANSPORT_RETRY_MS: '0',
  }, { auth: READABLE_FAKE_AUTH });
  try {
    const call = (effort) => fetch(`${bridge.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: 'hi' }], reasoning_effort: effort }),
      signal: AbortSignal.timeout(30_000),
    }).then((r) => r.text());

    await call('off');
    assert.equal('reasoning_effort' in (seen.at(-1) || {}), false,
      '表外档位（off）必须在出站前剥掉，否则必然吃确定性 400');

    await call('high');
    assert.equal(seen.at(-1)?.reasoning_effort, 'high', '表内档位必须原样保留');
  } finally {
    await bridge.stop();
    await new Promise((r) => srv.close(r));
    rmSync(bridge.dir, { recursive: true, force: true });
  }
});

test('桥：chat 错误体必须是 OpenAI 形状，且上游 401 不能被误认成本地令牌错', { timeout: 90_000 }, async () => {
  const stub = await startStubUpstream(['stub-model'], {
    chatRaw: JSON.stringify({ code: 11133, msg: 'the request parameters were rejected by the model provider', extError: { code: 'model_param_invalid' } }),
    chatStatus: 400,
    chatType: 'application/json',
  });
  const bridge = await startBridge({ CODEBUDDY_ENDPOINT: stub.base, WORKBUDDY_SKIP_MODEL_PREFLIGHT: '1' }, { auth: READABLE_FAKE_AUTH });
  try {
    const res = await fetch(`${bridge.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'stub-model', messages: [{ role: 'user', content: 'hi' }] }),
      signal: AbortSignal.timeout(30_000),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.ok(body.error?.message, '必须是 {error:{message}} 形状（客户端按 OpenAI 规范读）');
    assert.match(body.error.message, /rejected by the model provider/i);
    assert.equal(body.error.code, 'model_param_invalid', 'extError.code 要透出来，便于给出"换参数"而不是"重试"');
    assert.equal(body.error.type, 'upstream_error');
  } finally {
    await bridge.stop();
    try { await stub.close(); } catch { /* 忽略 */ }
    rmSync(bridge.dir, { recursive: true, force: true });
  }

  const stub401 = await startStubUpstream(['stub-model'], { chatRaw: '<html>401</html>', chatStatus: 401, chatType: 'text/html' });
  const bridge2 = await startBridge({ CODEBUDDY_ENDPOINT: stub401.base, WORKBUDDY_SKIP_MODEL_PREFLIGHT: '1' }, { auth: READABLE_FAKE_AUTH });
  try {
    const res = await fetch(`${bridge2.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'stub-model', messages: [{ role: 'user', content: 'hi' }] }),
      signal: AbortSignal.timeout(60_000),
    });
    assert.equal(res.status, 502, '上游 401 不能原样回 401（那会被当成本地令牌错误）');
    const body = await res.json();
    assert.equal(body.error?.type, 'upstream_auth_error');
    assert.match(body.error?.message || '', /re-?login/i);
  } finally {
    await bridge2.stop();
    try { await stub401.close(); } catch { /* 忽略 */ }
    rmSync(bridge2.dir, { recursive: true, force: true });
  }
});
test('凭据缓存：登录文件改写后立即生效；上游请求带 Content-Length，账本记首字耗时', { timeout: 90_000 }, async () => {
  /*
   * readStoredAuth() 原先每个请求都读盘 + AES 解密 + JWT 解码。现在按
   * stat 指纹（mtime + size）缓存 —— 本用例钉住"缓存不能把换号/换令牌挡住"：
   * 用**同长度**的不同令牌改写文件，只靠 mtime 也必须立刻失效。
   */
  const stub = await startStubUpstream(['stub-model']);
  const authFileA = {
    auth: {
      accessToken: 'token-aaaaaaaa',
      refreshToken: 'refresh-token',
      domain: 'example.invalid',
      expiresAt: Date.now() + 30 * 86_400_000,
    },
  };
  const bridge = await startBridge(
    { CODEBUDDY_ENDPOINT: stub.base, WORKBUDDY_SKIP_MODEL_PREFLIGHT: '1' },
    { auth: authFileA },
  );
  const chat = () => fetch(`${bridge.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'stub-model', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    signal: AbortSignal.timeout(30_000),
  });
  try {
    assert.equal((await chat()).status, 200);
    assert.equal(stub.seen.at(-1).headers.authorization, 'Bearer token-aaaaaaaa');
    // 未改写时连续请求：缓存命中也必须仍然是同一个令牌
    assert.equal((await chat()).status, 200);
    assert.equal(stub.seen.at(-1).headers.authorization, 'Bearer token-aaaaaaaa');

    const authFile = join(bridge.dir, 'fake-auth.info');
    writeFileSync(authFile, JSON.stringify({
      auth: {
        accessToken: 'token-bbbbbbbb',
        refreshToken: 'refresh-token',
        domain: 'example.invalid',
        expiresAt: Date.now() + 30 * 86_400_000,
      },
    }));
    // 强制把 mtime 推到未来：不依赖文件系统的毫秒精度，也避免同毫秒写入
    const future = new Date(Date.now() + 2000);
    utimesSync(authFile, future, future);

    assert.equal((await chat()).status, 200);
    assert.equal(stub.seen.at(-1).headers.authorization, 'Bearer token-bbbbbbbb',
      '登录文件改写后必须立刻重读 —— 缓存不能把换号/换令牌挡住');

    const { headers, body } = stub.seen.at(-1);
    assert.equal(Number(headers['content-length']), Buffer.byteLength(body),
      '发给上游的请求必须带 Content-Length（不再退回 chunked）');

    const requests = await (await fetch(bridge.baseUrl + '/v1/requests', { headers: auth })).json();
    const rec = (requests.requests || []).find((r) => r.model === 'stub-model' && r.ok);
    assert.ok(rec, '成功请求必须落账');
    assert.equal(typeof rec.overheadMs, 'number', '账本要能回答"桥自身花了多久"');
    assert.equal(typeof rec.ttfbMs, 'number', '账本要能回答"多久开始出字"');
  } finally {
    await bridge.stop();
    await stub.close();
    rmSync(bridge.dir, { recursive: true, force: true });
  }
});

test('插件登录：设备码 → 加密落盘 → auto 回退 → 刷新轮换持久化', { timeout: 180_000 }, async () => {
  /*
   * 端到端验证第二条凭据来源：
   *   ① 没有桌面端登录文件时，设备码登录能把凭据写进插件自己的库；
   *   ② 密文里不出现令牌；
   *   ③ 令牌快过期时自动刷新，并把轮换后的 refresh token 持久化；
   *   ④ 桥重启后继续用刷新后的令牌（证明持久化有效）；
   *   ⑤ auto 在"桌面端可用"时仍然优先桌面端（老行为不变）。
   */
  const credRoot = mkdtempSync(join(tmpdir(), 'wb-cred-'));
  const credDir = join(credRoot, 'credentials');
  const missingAuth = join(credRoot, 'missing-auth.info');
  let tokenPolls = 0;
  let refreshes = 0;
  const chatAuths = [];
  const chatHeaders = [];
  const catalogAuths = [];
  const refreshHeaders = [];
  // 与插件 uid-1 同一账号的桌面 JWT（readStoredAuth 只解码 payload，不验签）
  const desktopJwtForSameAccount = `e30.${Buffer.from(JSON.stringify({
    sub: 'uid-1',
    exp: Math.floor((Date.now() + 30 * 86_400_000) / 1000),
  })).toString('base64url')}.sig`;
  const desktopJwtOtherAccount = `e30.${Buffer.from(JSON.stringify({
    sub: 'uid-other',
    exp: Math.floor((Date.now() + 30 * 86_400_000) / 1000),
  })).toString('base64url')}.sig`;

  const stub = createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    const send = (status, obj) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (u.pathname === '/v2/plugin/auth/state') {
      // http 桩 URL：open:true 必须被 https 校验挡住，避免测试真的弹出浏览器
      return send(200, { code: 0, data: { state: 'state-1', authUrl: 'http://127.0.0.1/login?state=state-1' } });
    }
    if (u.pathname === '/v2/plugin/auth/token' && req.method === 'GET') {
      tokenPolls += 1;
      if (tokenPolls === 1) return send(200, { code: 11217, msg: '11217:login ing' });
      return send(200, {
        code: 0,
        data: { accessToken: 'plugin-access-1', refreshToken: 'plugin-refresh-1', expiresIn: 60, domain: 'www.codebuddy.cn' },
      });
    }
    if (u.pathname === '/v2/plugin/login/account') {
      return send(200, { code: 0, data: { uid: 'uid-1', nickname: 'Tester' } });
    }
    if (u.pathname === '/v2/plugin/auth/token/refresh') {
      refreshes += 1;
      refreshHeaders.push(req.headers);
      return send(200, {
        code: 0,
        data: {
          accessToken: `plugin-access-${refreshes + 1}`,
          refreshToken: `plugin-refresh-${refreshes + 1}`,
          expiresIn: 3600,
        },
      });
    }
    if (u.pathname === '/v2/chat/completions') {
      chatAuths.push(req.headers.authorization);
      chatHeaders.push(req.headers);
      if (req.headers.authorization === `Bearer ${desktopJwtForSameAccount}`
        || req.headers.authorization === `Bearer ${desktopJwtOtherAccount}`) {
        res.writeHead(401, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'desktop session expired' } }));
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n');
      res.end('data: [DONE]\n\n');
      return;
    }
    if (u.pathname === '/v2/enterprises/personal/models') {
      catalogAuths.push(req.headers.authorization);
      return send(200, { code: 0, data: { models: [] } });
    }
    if (u.pathname === '/v3/config') return send(200, { code: 0, data: { models: [] } });
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  const stubBase = `http://127.0.0.1:${stub.address().port}`;

  const storeMode = process.platform === 'win32' ? 'dpapi' : 'memory';
  const sharedEnv = {
    CODEBUDDY_ENDPOINT: stubBase,
    WORKBUDDY_LOGIN_BASE: stubBase,
    WORKBUDDY_LOGIN_ORIGIN: 'http://127.0.0.1',
    WORKBUDDY_LOGIN_POLL_MIN_MS: '0',
    WORKBUDDY_CREDENTIAL_DIR: credDir,
    WORKBUDDY_CREDENTIAL_STORE: storeMode,
    // 用户的真实场景：.env 里留着 auto。auto 是软默认，不应阻止登录后切到插件。
    WORKBUDDY_CREDENTIAL_SOURCE: 'auto',
    WORKBUDDY_SKIP_MODEL_PREFLIGHT: '1',
    WORKBUDDY_5XX_RETRY: '0',
  };
  const chat = async (base) => {
    const r = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'stub-model', messages: [{ role: 'user', content: 'hi' }] }),
      signal: AbortSignal.timeout(30_000),
    });
    await r.text();
    return r;
  };

  const bridge1 = await startBridge({ ...sharedEnv, WORKBUDDY_AUTH_FILE: missingAuth }, { auth: READABLE_FAKE_AUTH });
  let bridge2 = null;
  let bridge3 = null;
  let bridge4 = null;
  let bridge5 = null;
  let bridge6 = null;
  let bridgeFollow = null;
  let bridgeLegacyFollow = null;
  try {
    // ① 设备码开始 → 第一次 poll 返回 pending → 第二次拿到令牌
    const device = await (await fetch(`${bridge1.baseUrl}/v1/auth/device`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ region: 'cn', open: true }),
    })).json();
    assert.equal(device.ok, true);
    assert.ok(device.state);
    assert.match(device.url, /loginSessionId=/);
    assert.equal(device.opened, false, '测试桩是 http URL：open 必须被 https 校验挡住，不能真弹浏览器');

    const poll1 = await (await fetch(`${bridge1.baseUrl}/v1/auth/device?state=${encodeURIComponent(device.state)}`, { headers: auth })).json();
    assert.equal(poll1.status, 'pending', '上游 code 11217 必须映射成 pending，而不是失败');
    const poll2 = await (await fetch(`${bridge1.baseUrl}/v1/auth/device?state=${encodeURIComponent(device.state)}`, { headers: auth })).json();
    assert.equal(poll2.status, 'ready');
    assert.equal(poll2.account.uid, 'uid-1');
    assert.equal(poll2.sourceSwitched, true, '登录是显式动作：成功后应把来源切到插件');
    assert.equal(poll2.effectiveSource, 'plugin', 'env=auto 是软默认，不能把插件登录锁成不生效');

    // ② 对外清单不能出现任何令牌
    const credRes = await fetch(`${bridge1.baseUrl}/v1/auth/credentials`, { headers: auth });
    const credText = await credRes.text();
    assert.ok(!credText.includes('plugin-access'), '凭据清单绝对不能回显 access token');
    assert.ok(!credText.includes('plugin-refresh'), '凭据清单绝对不能回显 refresh token');
    const creds = JSON.parse(credText);
    assert.equal(creds.credentials.length, 1);
    assert.equal(creds.credentials[0].uid, 'uid-1');

    // ③ 桌面端缺失 → auto 回退到插件凭据
    const source = await (await fetch(`${bridge1.baseUrl}/v1/auth/source`, { headers: auth })).json();
    assert.equal(source.configured, 'plugin', '登录成功后来源应切到插件');
    assert.equal(source.envPinned, false);
    assert.equal(source.effective.source, 'plugin');
    assert.equal(source.desktop.available, false);
    assert.equal(source.plugin.count, 1);
    assert.equal(source.loginRegion, 'cn', '登录区域建议应来自当前插件账号，而不是写死');

    // ④ 第一次 chat：令牌 60s 过期 < 5min 刷新余量 → 先刷新再请求
    assert.equal((await chat(bridge1.baseUrl)).status, 200);
    assert.deepEqual(chatAuths, ['Bearer plugin-access-2'], '刷新后的 access token 必须用于本次请求');
    const pluginHeaders = chatHeaders.at(-1);
    assert.equal(pluginHeaders['x-ide-type'], 'WorkBuddy', '插件来源必须用 WorkBuddy 身份，而不是 VSCode');
    assert.equal(pluginHeaders['x-ide-name'], 'WorkBuddy');
    assert.equal(pluginHeaders['x-user-id'], 'uid-1');
    assert.match(pluginHeaders['user-agent'], /^WorkBuddy\/5\.5\.6 WorkBuddy\/5\.5\.6/);
    assert.equal(pluginHeaders['x-product'], 'SaaS');
    // 目录请求必须带插件凭据的 Authorization（否则模型列表永远 401）
    const deadline = Date.now() + 2000;
    while (!catalogAuths.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    assert.ok(catalogAuths.some((a) => /^Bearer plugin-access-/.test(String(a || ''))),
      `插件来源的目录请求必须带 Authorization，实际：${catalogAuths.join(' / ') || '(无请求)'}`);
    assert.equal(refreshes, 1);
    assert.equal(refreshHeaders[0]['x-refresh-token'], 'plugin-refresh-1');
    assert.equal(refreshHeaders[0]['x-auth-refresh-source'], 'workbuddy', '国内版刷新来源头必须是 workbuddy');
    assert.equal(refreshHeaders[0]['x-user-id'], 'uid-1');

    // ⑤ 落盘形态：只有密文，令牌不出现在文件里
    if (storeMode === 'dpapi') {
      const files = readdirSync(credDir);
      assert.ok(files.includes('store.key'), 'DPAPI 密钥必须独立落在 store.key');
      const credFile = files.find((f) => f.endsWith('.cred'));
      assert.ok(credFile, '凭据必须写进 .cred 文件');
      const credCipher = readFileSync(join(credDir, credFile), 'utf8');
      assert.ok(!credCipher.includes('plugin-access-2'), '凭据文件里不能出现明文 access token');
      assert.ok(!credCipher.includes('plugin-refresh-2'), '凭据文件里不能出现明文 refresh token');
      const keyCipher = readFileSync(join(credDir, 'store.key'), 'utf8');
      assert.ok(!keyCipher.includes('plugin-'), 'store.key 里不能出现任何令牌');
    } else {
      assert.ok(!existsSync(credDir) || readdirSync(credDir).filter((f) => f.endsWith('.cred')).length === 0,
        'memory 模式不得把凭据写到磁盘');
    }

    // ⑥ 重启桥：必须用持久化后的 access token（证明轮换后的 refresh 也落盘了）
    if (storeMode === 'dpapi') {
      await bridge1.stop();
      bridge2 = await startBridge({ ...sharedEnv, WORKBUDDY_AUTH_FILE: missingAuth }, { auth: READABLE_FAKE_AUTH });
      assert.equal((await chat(bridge2.baseUrl)).status, 200);
      assert.equal(chatAuths.at(-1), 'Bearer plugin-access-2', '重启后应继续使用刷新后的令牌');
      assert.equal(refreshes, 1, '1 小时有效期内不应再次刷新');
    }

    // ⑥b 来源=plugin，但用户在桌面客户端换号：桥必须跟随桌面（issue #6 的残留形态）
    if (storeMode === 'dpapi') {
      const followPath = join(credRoot, 'desktop-follow.info');
      writeFileSync(followPath, JSON.stringify(authFileFor('uid-1')));
      // 模拟「用户在桌面文件最后一次写入之后才选择插件来源」：此刻不该抢桌面
      writeFileSync(join(credDir, 'source.json'), JSON.stringify({
        source: 'plugin',
        updatedAt: new Date(Date.now() + 60_000).toISOString(),
      }));
      bridgeFollow = await startBridge({
        ...sharedEnv,
        WORKBUDDY_AUTH_FILE_FOLLOW: followPath,
        WORKBUDDY_AUTH_FOLLOW_UID: 'uid-1',
      }, { auth: authFileFor('uid-1') });
      const health = async () => (await fetch(`${bridgeFollow.baseUrl}/health`, { headers: auth })).json();
      const before = await health();
      assert.equal(before.auth?.source, 'plugin', '来源偏好仍是 plugin（上一步登录造成）');
      assert.equal(before.auth?.userId, 'uid-1');

      writeFileSync(followPath, JSON.stringify(authFileFor('uid-new')));
      let after = null;
      const deadlineFollow = Date.now() + 10_000;
      while (Date.now() < deadlineFollow) {
        after = await health().catch(() => null);
        if (after?.auth?.userId === 'uid-new' && after?.auth?.source === 'desktop') break;
        await new Promise((r) => setTimeout(r, 150));
      }
      assert.equal(after?.auth?.userId, 'uid-new', '桌面换号后桥必须改读桌面，而不是继续用旧插件账号');
      assert.equal(after?.auth?.source, 'desktop', '桌面换号是更新的用户意图：来源应从 plugin 跟随到 desktop');
      assert.equal(after?.authFollow, true);
    }

    /*
     * ⑥c 旧 source.json（没有 desktopUid 基线）但桌面文件在选择之后被重写：
     * 升级后第一次就要跟上用户刚做的换号，不能要求再换一次。
     */
    if (storeMode === 'dpapi') {
      const legacyFollow = join(credRoot, 'legacy-follow.info');
      writeFileSync(legacyFollow, JSON.stringify(authFileFor('legacy-desktop-new')));
      writeFileSync(join(credDir, 'source.json'), JSON.stringify({
        source: 'plugin',
        updatedAt: new Date(Date.now() - 3600_000).toISOString(),
      }));
      bridgeLegacyFollow = await startBridge({
        ...sharedEnv,
        WORKBUDDY_AUTH_FILE_FOLLOW: legacyFollow,
      }, { auth: authFileFor('legacy-desktop-old') });
      let legacy = null;
      const deadlineLegacy = Date.now() + 10_000;
      while (Date.now() < deadlineLegacy) {
        legacy = await (await fetch(`${bridgeLegacyFollow.baseUrl}/health`, { headers: auth })).json().catch(() => null);
        if (legacy?.auth?.userId === 'legacy-desktop-new' && legacy?.auth?.source === 'desktop') break;
        await new Promise((r) => setTimeout(r, 150));
      }
      assert.equal(legacy?.auth?.userId, 'legacy-desktop-new',
        '旧 source.json 没有基线时，桌面文件更新于选择时刻 → 应跟随桌面；输出：\n'
        + bridgeLegacyFollow.out()
        + '\nsource.json=' + readFileSync(join(credDir, 'source.json'), 'utf8'));
      assert.equal(legacy?.auth?.source, 'desktop');
    }

    // ⑦ auto：桌面端可用时仍然优先桌面端（老行为不变）
    // 先把来源偏好写回 auto —— 否则上一段的登录会把偏好留在 plugin。
    if (storeMode === 'dpapi') {
      writeFileSync(join(credDir, 'source.json'), JSON.stringify({ source: 'auto' }));
    }
    bridge3 = await startBridge({ ...sharedEnv }, { auth: READABLE_FAKE_AUTH });
    const sourceBoth = await (await fetch(`${bridge3.baseUrl}/v1/auth/source`, { headers: auth })).json();
    assert.equal(sourceBoth.desktop.available, true);
    assert.equal(sourceBoth.plugin.count, storeMode === 'dpapi' ? 1 : 0);
    assert.equal(sourceBoth.effective.source, 'desktop', 'auto 必须桌面端优先');
    assert.equal((await chat(bridge3.baseUrl)).status, 200);
    assert.equal(chatAuths.at(-1), 'Bearer fake-access-token', 'auto 下请求应使用桌面端令牌');
    assert.equal(chatHeaders.at(-1)['x-ide-type'], 'VSCode', '桌面来源的身份头必须保持原样');

    // ⑧ 显式 desktop 是硬锁：envPinned 必须为 true，且桌面优先
    bridge4 = await startBridge({ ...sharedEnv, WORKBUDDY_CREDENTIAL_SOURCE: 'desktop' }, { auth: READABLE_FAKE_AUTH });
    const sourcePin = await (await fetch(`${bridge4.baseUrl}/v1/auth/source`, { headers: auth })).json();
    assert.equal(sourcePin.envPinned, true, '显式 desktop 必须锁定来源');
    assert.equal(sourcePin.effective.source, 'desktop');

    /*
     * ⑨ 同账号双凭据互通：桌面 JWT 的 sub = 插件 uid，桌面端 401 后必须自动
     * 接管到插件凭据，且请求身份切到 WorkBuddy。memory 模式下另一个进程没有
     * 插件凭据（设计如此），这条只在能落盘的 Windows 跑。
     */
    if (storeMode === 'dpapi') {
      const sameAuth = {
        auth: {
          accessToken: desktopJwtForSameAccount,
          refreshToken: '',
          domain: 'example.invalid',
          expiresAt: Date.now() + 30 * 86_400_000,
        },
      };
      bridge5 = await startBridge({ ...sharedEnv }, { auth: sameAuth });
      const sourceSame = await (await fetch(`${bridge5.baseUrl}/v1/auth/source`, { headers: auth })).json();
      assert.equal(sourceSame.desktop.available, true);
      assert.equal(sourceSame.sameAccount, true, '桌面 JWT sub 与插件 uid 相同时必须识别为同一账号');
      assert.equal(sourceSame.effective.source, 'desktop', 'auto 仍先走桌面端');
      assert.equal((await chat(bridge5.baseUrl)).status, 200);
      assert.ok(chatAuths.some((a) => a === `Bearer ${desktopJwtForSameAccount}`), '必须先尝试桌面凭据');
      assert.match(String(chatAuths.at(-1) || ''), /^Bearer plugin-access-/, '桌面端 401 后必须自动接管到同账号插件凭据');
      assert.equal(chatHeaders.at(-1)['x-ide-type'], 'WorkBuddy', '接管后身份头要切到插件来源');
    }

    // ⑩ 不同账号：默认不接管（上一步已证）；显式 any 才允许跨账号接管
    if (storeMode === 'dpapi') {
      const otherAuth = {
        auth: {
          accessToken: desktopJwtOtherAccount,
          refreshToken: '',
          domain: 'example.invalid',
          expiresAt: Date.now() + 30 * 86_400_000,
        },
      };
      bridge6 = await startBridge(
        { ...sharedEnv, WORKBUDDY_CREDENTIAL_FAILOVER: 'any' },
        { auth: otherAuth },
      );
      const sourceOther = await (await fetch(`${bridge6.baseUrl}/v1/auth/source`, { headers: auth })).json();
      assert.equal(sourceOther.sameAccount, false, '不同 uid 不能被识别成同一账号');
      assert.equal(sourceOther.failover, 'any');
      assert.equal((await chat(bridge6.baseUrl)).status, 200);
      assert.match(String(chatAuths.at(-1) || ''), /^Bearer plugin-access-/, 'any 模式下跨账号接管应成功');
      assert.equal(chatHeaders.at(-1)['x-ide-type'], 'WorkBuddy');
    }
  } finally {
    for (const b of [bridge1, bridge2, bridge3, bridge4, bridge5, bridge6, bridgeFollow, bridgeLegacyFollow]) {
      if (b) { try { await b.stop(); } catch { /* 忽略 */ } }
    }
    try { await stub.close(); } catch { /* 忽略 */ }
    for (const b of [bridge1, bridge2, bridge3, bridge4, bridge5, bridge6, bridgeFollow, bridgeLegacyFollow]) {
      if (b) { try { rmSync(b.dir, { recursive: true, force: true }); } catch { /* 忽略 */ } }
    }
    rmSync(credRoot, { recursive: true, force: true });
  }
});

test('目录刷新竞态：换来源后旧目录请求晚到，不能覆盖新一代结果', { timeout: 60_000 }, async () => {
  /*
   * 回归：invalidateCatalogCache() 以前只清缓存、再调 refreshCatalog()；
   * 若此刻已有一个目录请求在飞，refreshCatalog() 会把**旧请求**原样返回，
   * 于是换来源后既没有重新取目录，旧请求晚到的结果还会写回新缓存 ——
   * 新账号在最长 5 分钟内继续看到旧账号的模型。
   *
   * 用一个按请求次数变脸的假上游：第 2 次（换来源前触发的 refresh）故意慢，
   * 第 3 次（换来源后强制发起）返回 new-model。旧实现只有 2 次请求，
   * 最终目录仍是 old-model。
   */
  let personalCalls = 0;
  let slowNext = false;
  let slowStartedResolve;
  const slowStarted = new Promise((resolve) => { slowStartedResolve = resolve; });
  const stub = createServer((req, res) => {
    const path = new URL(req.url, 'http://127.0.0.1').pathname;
    const send = (models) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: 0, data: { models } }));
    };
    if (path === '/v2/enterprises/personal/models') {
      personalCalls += 1;
      const n = personalCalls;
      const model = n >= 3 ? 'new-model' : 'old-model';
      const payload = [{ id: model, maxInputTokens: 128000, maxOutputTokens: 4096 }];
      if (slowNext) {
        slowNext = false;
        slowStartedResolve();
        setTimeout(() => send(payload), 500);
        return;
      }
      return send(payload);
    }
    if (path === '/v3/config') return send([]);
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  const stubBase = `http://127.0.0.1:${stub.address().port}`;
  const bridge = await startBridge({
    CODEBUDDY_ENDPOINT: stubBase,
    CODEBUDDY_API_KEY: 'api-key-race',
    WORKBUDDY_SKIP_MODEL_PREFLIGHT: '1',
    WORKBUDDY_AUTO_CHECKIN: '0',
  });
  try {
    const warm = await (await fetch(bridge.baseUrl + '/v1/models?all=1', { headers: auth })).json();
    assert.ok(warm.data.some((m) => m.id === 'old-model'), '先预热旧目录');

    // 让下一次目录请求变慢，并等它真的开始
    slowNext = true;
    const slowRefresh = fetch(bridge.baseUrl + '/v1/models?refresh=1', { headers: auth });
    await slowStarted;

    // 旧请求在飞时换来源 → 必须作废旧请求并发起新一代
    const switched = await fetch(bridge.baseUrl + '/v1/auth/source', {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'api-key' }),
    });
    assert.equal(switched.status, 200);
    await slowRefresh; // 旧请求完成（可能写回）
    await new Promise((r) => setTimeout(r, 700)); // 给晚到的写回留出窗口

    const final = await (await fetch(bridge.baseUrl + '/v1/models?all=1', { headers: auth })).json();
    const ids = final.data.map((m) => m.id);
    assert.ok(ids.includes('new-model'), `最终目录必须来自新一代请求：${ids}`);
    assert.ok(!ids.includes('old-model'), `旧请求晚到不能覆盖新目录：${ids}`);
    assert.ok(personalCalls >= 3, `换来源后必须重新打一次目录（实际 ${personalCalls} 次）`);
  } finally {
    await bridge.stop();
    await new Promise((r) => stub.close(r));
    rmSync(bridge.dir, { recursive: true, force: true });
  }
});

test('账本明细只解析尾部：大量历史 + 坏行仍返回最新 N 条', { timeout: 60_000 }, async () => {
  const bridge = await startBridge();
  try {
    const lines = [];
    for (let i = 1; i <= 5000; i += 1) {
      lines.push(JSON.stringify({
        t: i, model: `m${i}`, stream: false, ms: 1, ok: true, promptTokens: 1, completionTokens: 1,
      }));
    }
    lines.push('{broken-json');
    lines.push(JSON.stringify({ t: 999999, model: 'last', stream: false, ms: 2, ok: true }));
    writeFileSync(join(bridge.dir, 'usage.jsonl'), `${lines.join('\n')}\n`);

    const one = await (await fetch(`${bridge.baseUrl}/v1/requests?limit=1`, { headers: auth })).json();
    assert.equal(one.requests.length, 1);
    assert.equal(one.requests[0].model, 'last', 'limit=1 必须拿到最后一条，且坏行不能把结果挤掉');

    const fifty = await (await fetch(`${bridge.baseUrl}/v1/requests?limit=50`, { headers: auth })).json();
    assert.equal(fifty.requests.length, 50);
    assert.equal(fifty.requests[0].model, 'last');
    assert.equal(fifty.requests[49].model, 'm4952', '尾部 50 条按时间倒序，且不解析整本账');
  } finally {
    await bridge.stop();
    rmSync(bridge.dir, { recursive: true, force: true });
  }
});

test('桥：dsh 宿主身份句被上游 11128 拉黑，出站 system 必须中和', { timeout: 90_000 }, async () => {
  // 2026-10-21 实测：system 开头是 "You are an AI agent powered by DeepSeek Harness."
  // 时上游直接 400 code 11128；换成中性表述后同样的 messages/tools 全部 200。
  // 品牌词单独出现不拦，所以只改这一句，system 的其余内容必须原样保留。
  const stub = await startStubUpstream(['identity-model']);
  const bridge = await startBridge({ CODEBUDDY_ENDPOINT: stub.base }, { auth: READABLE_FAKE_AUTH });
  try {
    await fetch(bridge.baseUrl + '/v1/models?all=1'); // 预热目录，避免预校验拦住测试模型
    const res = await fetch(bridge.baseUrl + '/v1/chat/completions', {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'identity-model',
        stream: false,
        messages: [
          { role: 'system', content: 'You are an AI agent powered by DeepSeek Harness.\n\nExtra instructions.' },
          { role: 'user', content: 'hi' },
        ],
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
    assert.ok(!sysText.includes('powered by DeepSeek Harness'),
      '出站 system 不得含被 11128 拦截的 dsh 身份句');
    assert.ok(sysText.includes("running inside the user's development environment"),
      '应替换成中性身份句');
    assert.ok(sysText.includes('Extra instructions'),
      '只改身份句，system 其余内容必须原样保留');
  } finally {
    await bridge.stop();
    try { await stub.close(); } catch { /* 忽略 */ }
    rmSync(bridge.dir, { recursive: true, force: true });
  }
});

test('桥：未知 system 模板触发 11128 时，用中性 system 重试一次', { timeout: 90_000 }, async () => {
  const stub = await startStubUpstream(['fallback-model'], {
    chatSequence: [
      {
        status: 400,
        type: 'application/json',
        raw: JSON.stringify({ code: 11128, msg: 'Illegal API invocation from an unapproved channel' }),
      },
      {
        status: 200,
        type: 'text/event-stream',
        raw: 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}\n\ndata: [DONE]\n\n',
      },
    ],
  });
  const bridge = await startBridge({ CODEBUDDY_ENDPOINT: stub.base }, { auth: READABLE_FAKE_AUTH });
  try {
    await fetch(bridge.baseUrl + '/v1/models?all=1'); // 预热目录
    const tool = { type: 'function', function: { name: 'foo', description: 'foo', parameters: { type: 'object', properties: {} } } };
    const res = await fetch(bridge.baseUrl + '/v1/chat/completions', {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'fallback-model',
        stream: false,
        tools: [tool],
        messages: [
          { role: 'system', content: `You are a quirky host agent.

Keep this extra instruction.` },
          { role: 'user', content: 'hi' },
        ],
      }),
      signal: AbortSignal.timeout(15000),
    });
    assert.equal(res.status, 200);
    await res.text();

    assert.equal(stub.seen.length, 2, '11128 后应只重试一次');
    const first = JSON.parse(stub.seen[0].body);
    const second = JSON.parse(stub.seen[1].body);
    assert.ok(first.messages.some((m) => m.role === 'system' && m.content.includes('quirky')),
      '第一次应保留原始 system');
    assert.ok(!second.messages.some((m) => m.role === 'system' && m.content.includes('quirky')),
      '重试必须去掉触发黑名单的 system 首段');
    assert.ok(second.messages.some((m) => m.role === 'system' && m.content.includes('Keep this extra instruction')),
      '渐进降级应保留 system 后面的 instructions，而不是整段丢掉');
    assert.equal(res.headers.get('x-workbuddy-11128-fallback'), 'drop-first-system-paragraph',
      '响应头必须标明本次用的是哪一级兜底');
    assert.ok(second.messages.some((m) => m.role === 'user' && m.content === 'hi'),
      'user 消息必须原样保留');
    assert.deepEqual(second.tools, first.tools, 'tools 必须原样保留');
    const ledger = readFileSync(join(bridge.dir, 'usage.jsonl'), 'utf8').trim().split(/\r?\n/).map((l) => JSON.parse(l));
    assert.equal(ledger.at(-1).fallback, 'drop-first-system-paragraph', '账本必须记下兜底策略');
    assert.equal(ledger.at(-1).fallbackOk, true, '账本必须能区分兜底是否成功');
  } finally {
    await bridge.stop();
    try { await stub.close(); } catch { /* 忽略 */ }
    rmSync(bridge.dir, { recursive: true, force: true });
  }
});

test('桥：11128 连续命中时逐级降级，最后才换中性 system，且响应头/账本可见', { timeout: 90_000 }, async () => {
  const stub = await startStubUpstream(['fallback3-model'], {
    chatSequence: [
      {
        status: 400,
        type: 'application/json',
        raw: JSON.stringify({ code: 11128, msg: 'Illegal API invocation from an unapproved channel' }),
      },
      {
        status: 400,
        type: 'application/json',
        raw: JSON.stringify({ code: 11128, msg: 'Illegal API invocation from an unapproved channel' }),
      },
      {
        status: 200,
        type: 'text/event-stream',
        raw: 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}\n\ndata: [DONE]\n\n',
      },
    ],
  });
  const bridge = await startBridge({ CODEBUDDY_ENDPOINT: stub.base }, { auth: READABLE_FAKE_AUTH });
  try {
    await fetch(bridge.baseUrl + '/v1/models?all=1');
    const tool = { type: 'function', function: { name: 'foo', description: 'foo', parameters: { type: 'object', properties: {} } } };
    const res = await fetch(bridge.baseUrl + '/v1/chat/completions', {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'fallback3-model',
        stream: false,
        tools: [tool],
        messages: [
          { role: 'system', content: 'First paragraph identity.\n\nSecond paragraph instructions.' },
          { role: 'user', content: 'hi' },
        ],
      }),
      signal: AbortSignal.timeout(15000),
    });
    assert.equal(res.status, 200);
    await res.text();

    assert.equal(stub.seen.length, 3, '11128 连续命中时应依次尝试：删首段 → 中性 system');
    const second = JSON.parse(stub.seen[1].body);
    const third = JSON.parse(stub.seen[2].body);
    assert.ok(second.messages.some((m) => m.role === 'system' && m.content.includes('Second paragraph instructions')),
      '第二级应保留首段之后的 instructions');
    assert.ok(!third.messages.some((m) => m.role === 'system' && m.content.includes('Second paragraph instructions')),
      '最后一级才整段换中性 system');
    assert.ok(third.messages.some((m) => m.role === 'system' && m.content.includes('helpful AI assistant')));
    assert.deepEqual(third.tools, JSON.parse(stub.seen[0].body).tools, 'tools 必须始终原样保留');
    assert.equal(res.headers.get('x-workbuddy-11128-fallback'), 'neutral-system');
    const ledger = readFileSync(join(bridge.dir, 'usage.jsonl'), 'utf8').trim().split(/\r?\n/).map((l) => JSON.parse(l));
    assert.equal(ledger.at(-1).fallback, 'neutral-system');
    assert.equal(ledger.at(-1).fallbackOk, true);
  } finally {
    await bridge.stop();
    try { await stub.close(); } catch { /* 忽略 */ }
    rmSync(bridge.dir, { recursive: true, force: true });
  }
});

test('桥：非法 tool name 本地 400，不调用上游', { timeout: 90_000 }, async () => {
  const stub = await startStubUpstream(['tool-model']);
  const bridge = await startBridge(
    { CODEBUDDY_ENDPOINT: stub.base, WORKBUDDY_SKIP_MODEL_PREFLIGHT: '1' },
    { auth: READABLE_FAKE_AUTH },
  );
  try {
    const res = await fetch(bridge.baseUrl + '/v1/chat/completions', {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'tool-model',
        stream: false,
        messages: [{ role: 'system', content: 'You are a helpful assistant.' }, { role: 'user', content: 'hi' }],
        tools: [{ type: 'function', function: { name: 'bad.tool/name', description: 'x', parameters: { type: 'object', properties: {} } } }],
      }),
      signal: AbortSignal.timeout(15000),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error.message, /tool name.*invalid/i);
    assert.equal(stub.seen.length, 0, '非法工具名必须在本地拦下，绝不能花一次上游往返');
  } finally {
    await bridge.stop();
    try { await stub.close(); } catch { /* 忽略 */ }
    rmSync(bridge.dir, { recursive: true, force: true });
  }
});

test('桥：上游只回响应头不说话时，首字节超时返回 504（不能永久 loading）', { timeout: 30_000 }, async () => {
  const stub = await startStubUpstream(['hang-model'], { chatHang: true });
  const bridge = await startBridge(
    {
      CODEBUDDY_ENDPOINT: stub.base,
      WORKBUDDY_SKIP_MODEL_PREFLIGHT: '1',
      WORKBUDDY_FIRST_BYTE_TIMEOUT_MS: '150',
    },
    { auth: READABLE_FAKE_AUTH },
  );
  try {
    const startedAt = Date.now();
    const res = await fetch(bridge.baseUrl + '/v1/chat/completions', {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'hang-model',
        stream: false,
        messages: [{ role: 'system', content: 'You are a helpful assistant.' }, { role: 'user', content: 'hi' }],
      }),
      signal: AbortSignal.timeout(10_000),
    });
    assert.equal(res.status, 504);
    const body = await res.json();
    assert.match(body.error.message, /first-byte timeout/i);
    assert.ok(Date.now() - startedAt < 5000, '首字节超时必须及时收尾，不能等客户端超时');
  } finally {
    await bridge.stop();
    try { await stub.close(); } catch { /* 忽略 */ }
    rmSync(bridge.dir, { recursive: true, force: true });
  }
});

test('桥：桌面登录文件换号后，刷新出的 memoryAuth 不能继续压过新文件', { timeout: 60_000 }, async () => {
  const stub = await startStubUpstream(['switch-model'], {
    chatSequence: [
      {
        status: 401,
        type: 'application/json',
        raw: JSON.stringify({ code: 40101, msg: 'token expired' }),
      },
      {
        status: 200,
        type: 'text/event-stream',
        raw: 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}\n\ndata: [DONE]\n\n',
      },
    ],
  });
  const bridge = await startBridge(
    { CODEBUDDY_ENDPOINT: stub.base, WORKBUDDY_SKIP_MODEL_PREFLIGHT: '1' },
    {
      auth: {
        auth: {
          accessToken: 'old-file-token',
          refreshToken: 'r1',
          domain: 'example.invalid',
          expiresAt: Date.now() + 3_600_000,
        },
      },
    },
  );
  try {
    const send = () => fetch(bridge.baseUrl + '/v1/chat/completions', {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'switch-model',
        stream: false,
        messages: [{ role: 'system', content: 'You are a helpful assistant.' }, { role: 'user', content: 'hi' }],
      }),
      signal: AbortSignal.timeout(15000),
    });
    assert.equal((await send()).status, 200, '第一次 401 应刷新后成功');
    assert.match(String(stub.seen.at(-1).headers.authorization), /refreshed-1/,
      '刷新后的令牌应被用于重试');

    // 模拟桌面端换号：原子替换登录文件（内容与尺寸都变）。
    writeFileSync(join(bridge.dir, 'fake-auth.info'), JSON.stringify({
      auth: {
        accessToken: 'new-file-token-after-switch',
        refreshToken: 'r2',
        domain: 'example.invalid',
        expiresAt: Date.now() + 3_600_000,
      },
    }));
    assert.equal((await send()).status, 200);
    assert.match(String(stub.seen.at(-1).headers.authorization), /new-file-token-after-switch/,
      '登录文件变了就必须丢弃 memoryAuth，不能继续用旧账号令牌');
  } finally {
    await bridge.stop();
    try { await stub.close(); } catch { /* 忽略 */ }
    rmSync(bridge.dir, { recursive: true, force: true });
  }
});

test('桥：身份句带点号版本时只替换句子，不得吃掉后面的指令', { timeout: 60_000 }, async () => {
  const stub = await startStubUpstream(['version-model']);
  const bridge = await startBridge(
    { CODEBUDDY_ENDPOINT: stub.base, WORKBUDDY_SKIP_MODEL_PREFLIGHT: '1' },
    { auth: READABLE_FAKE_AUTH },
  );
  try {
    const res = await fetch(bridge.baseUrl + '/v1/chat/completions', {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'version-model',
        stream: false,
        messages: [
          {
            role: 'system',
            content: 'You are an AI agent powered by DeepSeek Harness v5.8.3. Keep this rule.',
          },
          { role: 'user', content: 'hi' },
        ],
      }),
      signal: AbortSignal.timeout(15000),
    });
    assert.equal(res.status, 200);
    await res.text();
    const system = JSON.parse(stub.seen.at(-1).body).messages.find((m) => m.role === 'system').content;
    assert.ok(!system.includes('DeepSeek Harness'), '身份句必须被替换');
    assert.ok(!system.includes('NEUTRAL8.3'), '版本号的小数点不能被拆成残留碎片');
    assert.ok(system.includes('Keep this rule'), '身份句后面的指令必须保留');
  } finally {
    await bridge.stop();
    try { await stub.close(); } catch { /* 忽略 */ }
    rmSync(bridge.dir, { recursive: true, force: true });
  }
});

test('桥：连接池排队超过上限时按超时失败，不能无限挂着', { timeout: 30_000 }, async () => {
  const stub = await startStubUpstream(['queue-model'], { chatHang: true });
  const bridge = await startBridge(
    {
      CODEBUDDY_ENDPOINT: stub.base,
      WORKBUDDY_SKIP_MODEL_PREFLIGHT: '1',
      WORKBUDDY_MAX_SOCKETS: '1',
      WORKBUDDY_QUEUE_TIMEOUT_MS: '200',
      WORKBUDDY_FIRST_BYTE_TIMEOUT_MS: '5000',
    },
    { auth: READABLE_FAKE_AUTH },
  );
  try {
    const ac = new AbortController();
    const payload = JSON.stringify({
      model: 'queue-model',
      stream: false,
      messages: [{ role: 'system', content: 'You are a helpful assistant.' }, { role: 'user', content: 'hi' }],
    });
    const first = fetch(bridge.baseUrl + '/v1/chat/completions', {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: payload,
      signal: ac.signal,
    }).catch(() => null);
    await new Promise((r) => setTimeout(r, 200)); // 让第一条占住唯一 socket
    const second = await fetch(bridge.baseUrl + '/v1/chat/completions', {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: payload,
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(second.status, 504);
    const body = await second.json();
    assert.match(body.error.message, /socket queue timeout/i);
    ac.abort();
    await first;
  } finally {
    await bridge.stop();
    try { await stub.close(); } catch { /* 忽略 */ }
    rmSync(bridge.dir, { recursive: true, force: true });
  }
});
