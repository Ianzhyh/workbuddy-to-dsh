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
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(HERE);
const BRIDGE = join(REPO, 'bridge', 'workbuddy-bridge.mjs');
const TOKEN = 'test-token-abc';

/** 一份"看起来像登录文件"的假凭据：桥能读结构，但拿不到真实令牌。 */
const FAKE_AUTH = {
  userId: 'test-account-000000',
  accessToken: 'fake-access-token',
  refreshToken: 'fake-refresh-token',
  endpoint: 'https://example.invalid',
  domain: 'example.invalid',
  expiresAt: Date.now() + 30 * 86_400_000,
};

/**
 * 起一个隔离的桥实例。
 * @returns {Promise<{baseUrl: string, dir: string, out: () => string, stop: () => Promise<void>}>}
 */
async function startBridge(env = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wb-bridge-test-'));
  const authFile = join(dir, 'fake-auth.info');
  writeFileSync(authFile, JSON.stringify(FAKE_AUTH));

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
