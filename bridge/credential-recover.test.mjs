/**
 * 真正走完整降级 → 恢复链路的回归（issue #16）。
 *
 * 上一版这条用例是**空转**的：它只把目录换成文件，但降级只在**写入**凭据时
 * 才发生，而那次测试从没触发过写入 —— `storeMode` 全程是 file，自愈路径
 * 一次都没执行。测试绿了，但什么都没验到（这种"假绿"比没有测试更危险）。
 *
 * 这一版走**真实的设备码登录**（本地桩上游），于是：
 *   1. 目录不可写 → savePluginCredential 失败 → 降级到 memory；
 *   2. /health 如实报 storeMode=memory + fallbackReason；
 *   3. 目录恢复 + 自愈窗口过去 → 回到 file，并清掉 fallbackReason。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  mkdtempSync, mkdirSync, rmSync, writeFileSync, readdirSync, existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pickBridgePort } from '../tools/dev/bridge-ports.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BRIDGE = join(HERE, 'workbuddy-bridge.mjs');
const TOKEN = 'recover-flow-token';
const auth = { authorization: `Bearer ${TOKEN}` };

const liveChildren = new Set();
function spawnTracked(command, args, options) {
  const child = spawn(command, args, options);
  liveChildren.add(child);
  child.once('exit', () => liveChildren.delete(child));
  return child;
}

test.after(async () => {
  for (const child of liveChildren) {
    try { child.kill('SIGTERM'); } catch { /* 已退出 */ }
  }
  await new Promise((resolve) => {
    if (!liveChildren.size) { resolve(); return; }
    const timer = setTimeout(resolve, 3000);
    for (const child of liveChildren) child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
  for (const child of liveChildren) {
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
    }
  }
  await new Promise((r) => setTimeout(r, 300));
  liveChildren.clear();
});

async function stopBridge(child) {
  child.kill('SIGTERM');
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  await new Promise((resolve) => {
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(); } };
    try {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      killer.on('error', done); killer.on('exit', done);
      setTimeout(done, 5000).unref?.();
    } catch { done(); }
  });
}

async function startBridge(env) {
  const port = pickBridgePort();
  const child = spawnTracked(process.execPath, [BRIDGE], {
    env: {
      ...process.env,
      WORKBUDDY_LOCAL_TOKEN: TOKEN,
      WORKBUDDY_HOST: '127.0.0.1',
      WORKBUDDY_PORT: String(port),
      WORKBUDDY_SKIP_MODEL_PREFLIGHT: '1',
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
      if (res.status === 200 || res.status === 503) return { port, baseUrl: `http://127.0.0.1:${port}`, child, output: () => out };
    } catch { /* 还没起来 */ }
  }
  child.kill('SIGKILL');
  throw new Error(`桥没有在 20 秒内起来：\n${out.slice(-1200)}`);
}

function fakeJwt(sub) {
  const body = Buffer.from(JSON.stringify({ sub, exp: Math.floor(Date.now() / 1000) + 86400 }), 'utf8').toString('base64url');
  return `e30.${body}.sig`;
}

/**
 * 桩上游：完整实现设备码登录的三个端点。
 *
 * 必须真实现，因为"降级"只有在**保存凭据**那一刻才会发生 —— 而那一步在
 * 登录成功之后。
 */
function startLoginStub() {
  const hits = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    hits.push(url.pathname);
    res.writeHead(200, { 'content-type': 'application/json' });
    if (url.pathname === '/v2/plugin/auth/state') {
      return res.end(JSON.stringify({
        code: 0,
        data: { state: 'state-fixture', authUrl: 'https://example.invalid/auth?state=state-fixture' },
      }));
    }
    if (url.pathname === '/v2/plugin/auth/token') {
      return res.end(JSON.stringify({
        code: 0,
        data: {
          accessToken: fakeJwt('uid-plugin-fixture'),
          refreshToken: 'refresh-fixture',
          expiresIn: 3600,
          domain: 'www.workbuddy.cn',
        },
      }));
    }
    if (url.pathname === '/v2/plugin/login/account') {
      return res.end(JSON.stringify({
        code: 0,
        data: { uid: 'uid-plugin-fixture', nickname: '恢复测试号' },
      }));
    }
    if (url.pathname === '/v2/enterprises/personal/models') {
      return res.end(JSON.stringify({ code: 0, data: { models: [] } }));
    }
    return res.end(JSON.stringify({ code: 0, data: {} }));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, hits, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

test('设备码登录时目录不可写 → 降级；目录恢复 + 自愈窗口过后 → 自动回到 file', { timeout: 180_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'wb-recover2-'));
  const authDir = mkdtempSync(join(tmpdir(), 'wb-recover2-auth-'));
  const credDir = join(dataDir, 'credentials');
  mkdirSync(credDir, { recursive: true });

  const stub = await startLoginStub();

  const authFile = join(authDir, 'auth.json');
  writeFileSync(authFile, JSON.stringify({
    auth: {
      accessToken: fakeJwt('uid-desktop'),
      refreshToken: 'r',
      domain: 'www.workbuddy.cn',
      expiresAt: Date.now() + 30 * 86_400_000,
    },
  }), 'utf8');

  const env = {
    WORKBUDDY_DATA_DIR: dataDir,
    WORKBUDDY_AUTH_DIR: authDir,
    WORKBUDDY_AUTH_FILE: authFile,
    WORKBUDDY_CREDENTIAL_STORE: 'file',
    WORKBUDDY_CREDENTIAL_DIR: credDir,
    CODEBUDDY_ENDPOINT: stub.base,
    // 登录域名指到桩上：设备码的三个端点都走 LOGIN_BASE_OVERRIDE
    WORKBUDDY_LOGIN_BASE: stub.base,
    WORKBUDDY_LOGIN_ORIGIN: stub.base,
    WORKBUDDY_TRANSPORT_RETRY_MS: '0',
    WORKBUDDY_AUTO_CHECKIN: '0',
    // 自愈窗口压到 300ms，测试才等得起（生产默认 60 秒）
    WORKBUDDY_CREDENTIAL_FALLBACK_RETRY_MS: '300',
    // 轮询节流压到 0：测试要一次就拿到终态（生产默认 3 秒）
    WORKBUDDY_LOGIN_POLL_MIN_MS: '0',
  };

  let bridge;
  try {
    bridge = await startBridge(env);
    const base = await (await fetch(`${bridge.baseUrl}/health`, { headers: auth })).json();
    assert.equal(base?.credential?.storeMode, 'file', '初始应为 file');

    /* ① 让凭据目录不可写：换成同名文件，任何写入都会 ENOTDIR */
    rmSync(credDir, { recursive: true, force: true });
    writeFileSync(credDir, 'not a directory', 'utf8');

    /* ② 发起设备码登录 → 轮询 → 触发 savePluginCredential（会失败并降级） */
    const started = await (await fetch(`${bridge.baseUrl}/v1/auth/device`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ region: 'cn' }),
    })).json();
    assert.equal(started.ok, true, `设备码登录应发起成功：${JSON.stringify(started)}`);

    const polled = await (await fetch(`${bridge.baseUrl}/v1/auth/device?state=${encodeURIComponent(started.state)}`, {
      headers: auth,
    })).json();
    console.log('轮询结果:', JSON.stringify(polled).slice(0, 220));
    assert.equal(polled.status, 'ready', `轮询应完成登录：${JSON.stringify(polled)}`);
    /*
     * `stored` 的形状是 { stored, degraded?, reason? } —— 它是 savePluginCredential
     * 的返回值原样带出来。降级与否看 degraded，而不是 stored 字段本身。
     */
    assert.equal(polled.stored?.stored, 'memory', '目录不可写时应降级为 memory');
    assert.equal(polled.stored?.degraded, true, '应标明这是降级，不是用户的选择');
    assert.ok(String(polled.stored?.reason || '').length > 0, '降级必须带原因，否则用户不知道发生了什么');

    /* ③ /health 必须如实报降级 */
    const degraded = await (await fetch(`${bridge.baseUrl}/health`, { headers: auth })).json();
    console.log('降级后 storeMode =', degraded?.credential?.storeMode, '| reason =', JSON.stringify(degraded?.credential?.fallbackReason));
    assert.equal(degraded?.credential?.storeMode, 'memory', '降级后 storeMode 应为 memory');
    assert.ok(String(degraded?.credential?.fallbackReason || '').length > 0,
      '必须带上降级原因，否则用户不知道发生了什么');

    /* ④ 恢复目录，等自愈窗口，再读一次 health（它会触发恢复尝试） */
    rmSync(credDir, { force: true });
    mkdirSync(credDir, { recursive: true });
    await new Promise((r) => setTimeout(r, 700));

    const recovered = await (await fetch(`${bridge.baseUrl}/health`, { headers: auth })).json();
    console.log('恢复后 storeMode =', recovered?.credential?.storeMode, '| reason =', JSON.stringify(recovered?.credential?.fallbackReason));
    assert.equal(recovered?.credential?.storeMode, 'file',
      '磁盘恢复 + 窗口过后应自动回到 file（用户不用重启就能恢复持久化）');
    assert.equal(recovered?.credential?.fallbackReason || '', '', '恢复后不该再报降级原因');

    /* ⑤ 降级期间只在内存的那份凭据，必须在恢复时补写落盘 */
    const files = existsSync(credDir) ? readdirSync(credDir).filter((f) => f.endsWith('.cred')) : [];
    console.log('恢复后凭据文件:', JSON.stringify(files));
    assert.ok(files.length >= 1,
      '降级期间登录的账号必须被补写落盘 —— 否则"恢复了"对重启仍然无效');
  } finally {
    if (bridge) await stopBridge(bridge.child);
    stub.server.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(authDir, { recursive: true, force: true });
  }
});