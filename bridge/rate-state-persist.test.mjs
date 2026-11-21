/**
 * 端到端验证：**桥退出后，账号触顶记录必须还在**。
 *
 * 用户反馈：「那个账号触顶为什么我退出应用就没了」
 *
 * 这条用例真起两个桥进程（同数据目录）：
 *   1. 第一个进程收到上游 6004（额度上限）→ 写入 quotaResetStats；
 *   2. 停掉它；
 *   3. 第二个进程启动 → `/health rateLimit` 必须仍能报出这条触顶与 resetAt。
 *
 * 用真实进程而不是 import：这正是"退出应用"的场景，进程内断言证明不了落盘。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pickBridgePort } from '../tools/dev/bridge-ports.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
// 本文件在 bridge/ 下，桥脚本就在同目录 —— 写成 '..','..' 会跑到仓库根之外
const BRIDGE = join(HERE, 'workbuddy-bridge.mjs');
const TOKEN = 'persist-test-token';
const auth = { authorization: `Bearer ${TOKEN}` };

/*
 * 文件级子进程登记（见 bridge-startup.test.mjs 的长注释）：
 * finally 覆盖不了"进 try 之前"的异常，漏杀会把管道挂在测试进程上，
 * node --test 跑完不退出（实测卡死 7 分钟）。
 */
const liveChildren = new Set();

/** 起一个子进程并登记，返回它（收尾由 test.after 兜底）。 */
function spawnTracked(command, args, options) {
  const child = spawn(command, args, options);
  liveChildren.add(child);
  child.once('exit', () => liveChildren.delete(child));
  return child;
}

test.after(async () => {
  for (const child of liveChildren) {
    try { child.kill('SIGTERM'); } catch { /* 已经退出 */ }
  }
  await new Promise((resolve) => {
    if (!liveChildren.size) { resolve(); return; }
    const timer = setTimeout(resolve, 3000);
    for (const child of liveChildren) child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
  // Windows 上桥不响应 SIGTERM，兜底强杀（等它真的死，见 stopBridge 的注释）
  for (const child of liveChildren) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    try { child.kill('SIGKILL'); } catch { /* 已经退出 */ }
  }
  await new Promise((resolve) => setTimeout(resolve, 300));
  liveChildren.clear();
});

/** 起一个桥，等到 /health 可读。 */
async function startBridge(env) {
  const port = pickBridgePort();
  const child = spawnTracked(process.execPath, [BRIDGE], {
    env: {
      ...process.env,
      WORKBUDDY_LOCAL_TOKEN: TOKEN,
      WORKBUDDY_HOST: '127.0.0.1',
      WORKBUDDY_PORT: String(port),
      WORKBUDDY_SKIP_MODEL_PREFLIGHT: '1',
      // 测试卫生：账本必须指到临时目录，不许写进使用者的真实账本
      WORKBUDDY_USAGE_FILE: join(tmpdir(), `wb-test-usage-${port}.jsonl`),
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  /*
   * 把子进程输出攒起来：起来失败时最需要的就是它说了什么。
   * 我前两版只报「20 秒没起来」，把真正的错误藏住了 —— 排查时等于自断线索。
   */
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { out += c; });
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, { headers: auth, signal: AbortSignal.timeout(1500) });
      if (res.status === 200 || res.status === 503) {
        return { port, baseUrl: `http://127.0.0.1:${port}`, child };
      }
    } catch { /* 还没起来 */ }
  }
  child.kill('SIGKILL');
  throw new Error(`桥没有在 20 秒内起来。子进程输出：\n${out.slice(-2000)}`);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

async function stopBridge(child) {
  /*
   * 必须**强杀并等它真的死**。
   *
   * 桥在 Windows 上不响应 SIGTERM（插件侧 forceKill 解决的正是同一个问题），
   * 而 taskkill 是**异步**的：发出去不等它返回就等于没杀 —— 子进程会一直活着，
   * node --test 的进程因此永不退出（实测卡死 7 分钟，只能手动清理）。
   */
  child.kill('SIGTERM');
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  await new Promise((resolve) => {
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(); } };
    try {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore', windowsHide: true,
      });
      killer.on('error', done);
      killer.on('exit', done);
      setTimeout(done, 5000).unref?.();
    } catch { done(); }
  });
  const hard = Date.now() + 5000;
  while (Date.now() < hard) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise((r) => setTimeout(r, 100));
  }
}

test('账号触顶记录跨进程保留（退出应用再进来仍然看得到）', { timeout: 120_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'wb-ratestate-'));
  const authDir = mkdtempSync(join(tmpdir(), 'wb-rateauth-'));

  /*
   * 上游：回 **HTTP 429** + code 6004，文案带"将在 <时刻> UTC+8 重置"。
   *
   * 两处细节都对齐了现有用例（bridge.test.mjs 的 6004 那条），否则走不到记账分支：
   *   · 状态码必须是 429（200 会被当成 SSE 解析失败 → 502「no parseable SSE data」）；
   *   · 重置时刻要带 **UTC+8** 后缀，桥的 parseResetWallClock 才认得。
   * 时刻取"现在 + 20 小时"，避免写死日期在将来某天变成过去时。
   */
  const resetAtMs = Math.floor((Date.now() + 20 * 3_600_000) / 1000) * 1000;
  const resetWall = new Date(resetAtMs + 8 * 3_600_000);
  const pad = (n) => String(n).padStart(2, '0');
  const resetStamp = `${resetWall.getUTCFullYear()}-${pad(resetWall.getUTCMonth() + 1)}-${pad(resetWall.getUTCDate())}`
    + ` ${pad(resetWall.getUTCHours())}:${pad(resetWall.getUTCMinutes())}:${pad(resetWall.getUTCSeconds())}`;
  const quotaRaw = JSON.stringify({
    code: 6004,
    msg: `usage exceeds frequency limit, but don't worry, your usage will reset at ${resetStamp} UTC+8, alternatively, you can switch to the other models to continue using it.`,
  });
  const upstream = createServer((req, res) => {
    res.writeHead(429, { 'content-type': 'application/json' });
    res.end(quotaRaw);
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));

  const authFile = join(authDir, 'auth.json');
  const { writeFileSync } = await import('node:fs');
  /*
   * 凭据文件要**结构正确**（`auth` 包裹层 + endpoint + expiresAt 在未来），
   * 否则桥在启动阶段读凭据就失败、`/health` 永远不就绪 —— 我第一版就是这么
   * 卡了 20 秒超时，与持久化本身无关。
   */
  writeFileSync(authFile, JSON.stringify({
    auth: {
      userId: 'persist-uid',
      accessToken: 'fake-access-token',
      refreshToken: 'fake-refresh-token',
      endpoint: `http://127.0.0.1:${upstream.address().port}`,
      domain: 'example.invalid',
      expiresAt: Date.now() + 30 * 86_400_000,
    },
  }), 'utf8');

  const env = {
    WORKBUDDY_DATA_DIR: dataDir,
    WORKBUDDY_AUTH_FILE: authFile,
    CODEBUDDY_ENDPOINT: `http://127.0.0.1:${upstream.address().port}`,
    WORKBUDDY_TRANSPORT_RETRY_MS: '0',
  };

  let first;
  try {
    // ── 第一段：让桥吃一次 6004 ──
    first = await startBridge(env);
    const resp = await fetch(`${first.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      /*
       * 必须 `stream: true`。
       *
       * 非流式请求会被桥转成流式发往上游，然后按 SSE 解析响应体 —— 我们这里
       * 回的是普通 JSON，于是先炸成「no parseable SSE data」(502)，根本走不到
       * 6004 的判定分支（第一版就是这么失败的）。
       * stream 模式下桥会解析 code/msg，才能进 noteQuotaReset。
       */
      body: JSON.stringify({ model: 'persist-model', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
      signal: AbortSignal.timeout(15000),
    }).catch((e) => ({ error: String(e?.message || e) }));
    const respText = typeof resp?.text === 'function' ? await resp.text().catch(() => '') : JSON.stringify(resp);
    console.log('第一次请求：', resp?.status ?? '(fetch error)', String(respText).slice(0, 300));

    // 等落盘（saveRateStateSoon 有 2s 合并窗口）
    await new Promise((r) => setTimeout(r, 3000));
    const stateFile = join(dataDir, 'rate-state.json');
    assert.ok(existsSync(stateFile), '桥应把限流/触顶状态落盘到 rate-state.json');
    const saved = JSON.parse(readFileSync(stateFile, 'utf8'));
    assert.ok((saved.quotaReset || []).length >= 1,
      `落盘内容里应有额度上限记录，实际：${JSON.stringify(saved.quotaReset)}`);

    await stopBridge(first.child);
    first = null;

    // ── 第二段：新进程读回 ──
    const second = await startBridge(env);
    try {
      const health = await (await fetch(`${second.baseUrl}/health`, { headers: auth })).json();
      const rl = health.rateLimit || {};
      /*
       * 触顶信息在 `rateLimit.quota` 里（`{model, count, resetAt, lastAt}`），
       * 不是 `models` —— `models` 是 10 分钟窗口内的 429 计数。
       * 我第一版断言查错了地方，误报成"没恢复"。
       */
      const quota = rl.quota || {};
      assert.ok(quota.model && Number(quota.count) >= 1,
        `重启后 /health 仍应报出触顶（用户："退出应用就没了"）。实际 rateLimit=${JSON.stringify(rl)}`);
      assert.ok(quota.resetAt,
        `触顶记录必须带恢复时刻（那是它值得跨进程保留的理由）。实际：${JSON.stringify(quota)}`);
    } finally {
      await stopBridge(second.child);
    }
  } finally {
    if (first) await stopBridge(first.child);
    upstream.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(authDir, { recursive: true, force: true });
  }
});
