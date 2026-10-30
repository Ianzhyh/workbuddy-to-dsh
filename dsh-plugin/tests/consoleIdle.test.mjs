/**
 * 控制台闲置自动退出（`DASHBOARD_IDLE_EXIT_MS`，插件拉起时默认 10 分钟）。
 *
 * 钉住两件容易写反的事：
 *   1. 插件探活（`/` 与 `/api/version`）**不能**算活动 —— 否则每 20 秒一次探活，
 *      控制台永远等不到闲置；
 *   2. 页面/数据请求算活动 —— 页面还开着、还在轮询时不能把进程杀掉。
 *
 * 端口交给 OS 分配（`listen(0)` 后读回），不硬编码；数据目录用临时目录，
 * 绝不碰使用者真实的 `.state.json` / 账本。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, '..', '..', 'dashboard', 'server.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function freePort() {
  const srv = createServer();
  await new Promise((ok, fail) => {
    srv.once('error', fail);
    srv.listen(0, '127.0.0.1', ok);
  });
  const { port } = srv.address();
  await new Promise((r) => srv.close(r));
  return port;
}

async function startConsole(idleExitMs) {
  const port = await freePort();
  const dataDir = mkdtempSync(join(tmpdir(), 'wb-console-idle-'));
  const child = spawn(process.execPath, [SERVER], {
    cwd: dirname(SERVER),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: {
      ...process.env,
      // config.mjs 在 import 时校验/生成令牌：给测试值，别读写使用者的令牌文件
      WORKBUDDY_EXT_TOKEN: 'wb-test-panel-token',
      WORKBUDDY_LOCAL_TOKEN: 'wb-test-local-token',
      WORKBUDDY_DATA_DIR: dataDir,
      // 桥不启动，只给一个合法端口
      WORKBUDDY_PORT: String(port + 1),
      DASHBOARD_AUTO_START_BRIDGE: '0',
      DASHBOARD_OPEN_BROWSER: '0',
      DASHBOARD_HOST: '127.0.0.1',
      DASHBOARD_PORT: String(port),
      DASHBOARD_IDLE_EXIT_MS: String(idleExitMs),
    },
  });
  let output = '';
  child.stdout.on('data', (c) => { output += c; });
  child.stderr.on('data', (c) => { output += c; });
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    try {
      const res = await fetch(`${url}/api/version`, { signal: AbortSignal.timeout(1000) });
      await res.body?.cancel().catch(() => { /* 不看 body */ });
      if (res.status === 200) return { child, url, dataDir, output: () => output };
    } catch { /* 还没 listen */ }
    await sleep(150);
  }
  try { child.kill(); } catch { /* 已退出 */ }
  await sleep(200);
  rmSync(dataDir, { recursive: true, force: true });
  throw new Error(`控制台没有就绪（port ${port}）：\n${output.slice(-1200)}`);
}

function waitExit(child, ms) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) return resolve({ code: child.exitCode, timedOut: false });
    const timer = setTimeout(() => resolve({ code: null, timedOut: true }), ms);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, timedOut: false });
    });
  });
}

test('控制台闲置：探活请求不算活动，超时后自己退出', { timeout: 30_000 }, async () => {
  const { child, url, dataDir, output } = await startConsole(3000);
  const exit = waitExit(child, 12_000);
  try {
    // 模拟插件每 20 秒的探活（这里加速到 250ms）：都不应把闲置计时顶回去
    const deadline = Date.now() + 12_000;
    while (child.exitCode === null && Date.now() < deadline) {
      try {
        const version = await fetch(`${url}/api/version`, { signal: AbortSignal.timeout(1000) });
        await version.body?.cancel().catch(() => { /* 忽略 */ });
        const home = await fetch(`${url}/`, { signal: AbortSignal.timeout(1000) });
        await home.body?.cancel().catch(() => { /* 不看 500KB 页面 */ });
      } catch { /* 进程退出后连接被拒 */ }
      await sleep(250);
    }
    const result = await exit;
    assert.equal(result.timedOut, false, `控制台被探活请求保活了：\n${output()}`);
    assert.equal(result.code, 0, `闲置退出应以 0 退出：\n${output()}`);
    assert.match(output(), /闲置.*自动退出/, '日志要说明是自己退出的');
  } finally {
    try { child.kill(); } catch { /* 已退出 */ }
    await sleep(100);
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('控制台闲置：页面请求会保活，停止活动后仍会退出', { timeout: 30_000 }, async () => {
  const { child, url, dataDir, output } = await startConsole(1500);
  try {
    // 页面打开时的常规静态请求（算活动）
    const aliveUntil = Date.now() + 3000;
    while (Date.now() < aliveUntil) {
      try {
        const res = await fetch(`${url}/style.css`, { signal: AbortSignal.timeout(1000) });
        await res.body?.cancel().catch(() => { /* 忽略 */ });
      } catch { /* 忽略 */ }
      await sleep(200);
    }
    assert.equal(child.exitCode, null, `页面还在请求，控制台不该退出：\n${output()}`);

    const result = await waitExit(child, 8000);
    assert.equal(result.timedOut, false, `停止活动后没有按闲置时间退出：\n${output()}`);
    assert.equal(result.code, 0);
  } finally {
    try { child.kill(); } catch { /* 已退出 */ }
    await sleep(100);
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('控制台闲置：被 403 拒绝的跨站请求不算活动（不能靠恶意请求保活）', { timeout: 30_000 }, async () => {
  /*
   * 任意网页都能让浏览器发几个跨站请求。若这些被拒的请求也刷新活动时间，
   * 控制台就能被"外部网页"无限保活（白占 80+MB），而用户根本没在用。
   * 活动计时必须在 origin 校验**通过之后**才更新。
   */
  const { child, url, dataDir, output } = await startConsole(1500);
  try {
    const deadline = Date.now() + 6000;
    while (child.exitCode === null && Date.now() < deadline) {
      try {
        const res = await fetch(`${url}/api/overview`, {
          method: 'POST',
          headers: { origin: 'https://evil.example', 'content-type': 'text/plain' },
          body: 'x',
          signal: AbortSignal.timeout(1000),
        });
        assert.equal(res.status, 403, '跨站请求必须被拒');
        await res.body?.cancel().catch(() => { /* 忽略 */ });
      } catch (error) {
        if (child.exitCode !== null) break;
        throw error;
      }
      await sleep(400);
    }
    const result = await waitExit(child, 6000);
    assert.equal(result.timedOut, false, `跨站请求把控制台保活了：\n${output()}`);
    assert.equal(result.code, 0, `闲置退出应以 0 退出：\n${output()}`);
  } finally {
    try { child.kill(); } catch { /* 已退出 */ }
    await sleep(100);
    rmSync(dataDir, { recursive: true, force: true });
  }
});
