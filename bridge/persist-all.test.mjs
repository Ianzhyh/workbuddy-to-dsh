/**
 * 端到端检查：**桥退出再启动，这些数据必须还在**。
 *
 * 用户诉求：「这些数据可以不丢吗」（选了：账号触顶/限流、用量与积分统计、
 * 模型勾选与账号别名）。
 *
 * 真起两个桥进程、同一个数据目录，逐项核对：
 *   1. 用量与积分统计 —— /v1/usage 的 total（账本 usage.jsonl 落盘）；
 *   2. 模型勾选 —— /v1/models 返回保存的可见集合（models-default.json）；
 *   3. 账号别名 —— state.json 的 accountAliases（由控制台读，桥不暴露）；
 *   4. 账号触顶 —— /health rateLimit.quota（见 rate-state-persist.test.mjs）。
 *
 * 测试卫生（bridge-startup.test.mjs 的守卫要求）：
 *   · WORKBUDDY_USAGE_FILE 显式指向临时目录 —— 不写使用者的真实账本；
 *   · 桥端口用 pickBridgePort() —— 不横跨 Linux 临时端口段；
 *   · 子进程登记进 liveChildren，文件级 test.after 统一收尾 ——
 *     finally 覆盖不了"进 try 之前"的异常，漏杀会让 node --test 永不退出
 *     （本会话实测卡死 7 分钟）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pickBridgePort } from '../tools/dev/bridge-ports.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BRIDGE = join(HERE, 'workbuddy-bridge.mjs');
const TOKEN = 'persist-all-token';
const auth = { authorization: `Bearer ${TOKEN}` };

/* ── 文件级子进程登记（见 bridge-startup.test.mjs 的长注释） ── */
const liveChildren = new Set();

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
  // Windows 上桥不响应 SIGTERM：兜底强杀
  for (const child of liveChildren) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    try { child.kill('SIGKILL'); } catch { /* 已经退出 */ }
  }
  await new Promise((resolve) => setTimeout(resolve, 300));
  liveChildren.clear();
});

/* ── 停一个桥：SIGTERM 不行就强杀，并且**等它真的死** ── */
async function stopBridge(child) {
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

/* ── 起一个桥（health 可读即就绪；探针失败时带出子进程输出） ── */
async function startBridge(env, usageFile) {
  const port = pickBridgePort();
  const child = spawnTracked(process.execPath, [BRIDGE], {
    env: {
      ...process.env,
      WORKBUDDY_LOCAL_TOKEN: TOKEN,
      WORKBUDDY_HOST: '127.0.0.1',
      WORKBUDDY_PORT: String(port),
      WORKBUDDY_SKIP_MODEL_PREFLIGHT: '1',
      // 测试卫生：账本指到临时目录（调用方传入），绝不写使用者的真实账本
      WORKBUDDY_USAGE_FILE: usageFile,
      WORKBUDDY_AUTO_CHECKIN: '0',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
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

test('桥退出再启动：用量、模型勾选、账号别名、触顶记录都不丢', { timeout: 150_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'wb-persistall-'));
  const authDir = mkdtempSync(join(tmpdir(), 'wb-persistauth-'));
  // 账本路径：预置历史记录写这里，WORKBUDDY_USAGE_FILE 也指这里 —— 两处一致
  const usageFile = join(dataDir, 'usage.jsonl');

  /* 上游：一个模型目录；其余端点回空（本用例只关心账本读回） */
  const upstream = createServer((req, res) => {
    const path = new URL(req.url, 'http://127.0.0.1').pathname;
    res.writeHead(200, { 'content-type': 'application/json' });
    if (path === '/v2/enterprises/personal/models') {
      return res.end(JSON.stringify({
        code: 0,
        data: { models: [{ id: 'persist-model', maxInputTokens: 128000, maxOutputTokens: 4096 }] },
      }));
    }
    res.end(JSON.stringify({ code: 0, data: {} }));
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));

  const authFile = join(authDir, 'auth.json');
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

  /*
   * 预置"上一次退出时留下的东西"。
   *
   * 账号别名是**按 uin 记**的（不是 userId）：桥从 account-archive/<uid>/meta.json
   * 读出 uin，控制台再用 state.json 的 accountAliases[uin] 贴上名字。
   * 所以验证别名要**两样都预置**：存档（提供 uin）+ 别名。
   */
  const ledger = usageFile;
  writeFileSync(ledger, JSON.stringify({
    t: Date.now() - 3600_000, model: 'persist-model', stream: true, ok: true,
    ms: 900, promptTokens: 1200, completionTokens: 34, credit: 0.42, creditSource: 'upstream',
  }) + '\n', 'utf8');
  const modelsDefault = join(dataDir, 'models-default.json');
  writeFileSync(modelsDefault, JSON.stringify({ ids: ['persist-model'], savedAt: new Date().toISOString() }), 'utf8');
  const stateFile = join(dataDir, 'state.json');
  writeFileSync(stateFile, JSON.stringify({
    accountAliases: { '330000000001': '别名一号' },
    accountOrder: [],
  }), 'utf8');
  const archiveDir = join(dataDir, 'account-archive', 'persist-uid');
  mkdirSync(archiveDir, { recursive: true });
  writeFileSync(join(archiveDir, 'meta.json'), JSON.stringify({
    uid: 'persist-uid',
    uin: '330000000001',
    domain: 'www.workbuddy.cn',
    latest: 'fake.info',
    lastSeenAt: new Date().toISOString(),
    key: 'persist-uid',
    files: ['fake.info'],
  }), 'utf8');

  const env = {
    WORKBUDDY_DATA_DIR: dataDir,
    WORKBUDDY_AUTH_FILE: authFile,
    CODEBUDDY_ENDPOINT: `http://127.0.0.1:${upstream.address().port}`,
    WORKBUDDY_TRANSPORT_RETRY_MS: '0',
  };

  let first;
  let second;
  try {
    // ── 第一个进程：读一遍当前状态，然后退出 ──
    first = await startBridge(env, usageFile);
    const usageBefore = await (await fetch(`${first.baseUrl}/v1/usage?days=7`, { headers: auth })).json();
    await stopBridge(first.child);
    first = null;

    // ── 第二个进程：重启后逐项核对 ──
    second = await startBridge(env, usageFile);
    const usageAfter = await (await fetch(`${second.baseUrl}/v1/usage?days=7`, { headers: auth })).json();

    /* ① 用量与积分统计（预置了 1 条：calls>=1、credit 0.42） */
    const callsAfter = Number(usageAfter?.total?.calls) || 0;
    assert.ok(callsAfter >= 1,
      `重启后应仍能读到账本历史（预置 1 条）。实际 calls=${callsAfter}，before=${JSON.stringify(usageBefore?.total)}`);
    const creditAfter = Number(usageAfter?.total?.credit) || 0;
    assert.ok(creditAfter > 0, `重启后消耗积分应仍在（预置 0.42）。实际 credit=${creditAfter}`);

    /* ② 模型勾选（models-default.json 保存的集合） */
    const modelsAfter = await (await fetch(`${second.baseUrl}/v1/models`, { headers: auth })).json();
    const ids = (modelsAfter?.data || []).map((m) => m.id);
    assert.ok(ids.includes('persist-model'),
      `重启后「可用模型」仍应是保存的那份。实际：${JSON.stringify(ids)}`);

    /* ③ 账号别名：state.json 与存档 uin 都要还在（桥不暴露别名，控制台读文件） */
    const stateAfter = JSON.parse(readFileSync(stateFile, 'utf8'));
    assert.equal(stateAfter?.accountAliases?.['330000000001'], '别名一号',
      `重启后账号别名应仍在 state.json。实际：${JSON.stringify(stateAfter?.accountAliases)}`);
    const meta = JSON.parse(readFileSync(join(archiveDir, 'meta.json'), 'utf8'));
    assert.equal(meta.uin, '330000000001', '账号存档里的 uin 应仍在（别名的键）');

    /* ④ 触顶记录的落盘由 rate-state-persist.test.mjs 专测；这里确认三件套存在 */
    assert.ok(existsSync(ledger), '账本文件应存在');
    assert.ok(existsSync(modelsDefault), 'models-default.json 应存在');
    assert.ok(existsSync(stateFile), 'state.json 应存在');
  } finally {
    if (first) await stopBridge(first.child);
    if (second) await stopBridge(second.child);
    upstream.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(authDir, { recursive: true, force: true });
  }
});
