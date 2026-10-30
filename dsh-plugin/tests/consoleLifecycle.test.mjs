/**
 * ConsoleSupervisor 的进程生命周期（1.20.0）：
 *
 *   1. 拉起的控制台必须继承插件的桥配置（WORKBUDDY_*），且 DASHBOARD_IDLE_EXIT_MS
 *      始终注入（显式 0 = 常驻，不能被 `.env` 反向覆盖）；
 *   2. 子进程退出后必须清掉 `spawnedPid`（否则面板显示"可管理"，stop 可能误杀）；
 *   3. 旧控制台没有 `/api/version` 时，按端口监听者确认归属后才停；无法确认就拒绝。
 *
 * 用真实子进程（fixture）而不是 mock：spawn/env/exit 这三件事正是要验证的对象。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ConsoleSupervisor } from '../lib/console.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** OS 分配一个空闲端口（listen 0 → 取号 → 关）。 */
async function freePort() {
  const srv = createServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  await new Promise((r) => srv.close(r));
  return port;
}

/** 造一个临时 projectRoot：`dashboard/server.mjs` 指向 fixture。 */
function makeProjectRoot() {
  const dir = mkdtempSync(join(tmpdir(), 'wb-console-life-'));
  mkdirSync(join(dir, 'dashboard'), { recursive: true });
  copyFileSync(join(HERE, '_consoleFixture.mjs'), join(dir, 'dashboard', 'server.mjs'));
  return dir;
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(50);
  }
  throw new Error(`等待超时：${label}`);
}

test('拉起的控制台拿到 WORKBUDDY_* 桥配置，且 idleExitMs=0 也显式注入', async () => {
  const dir = makeProjectRoot();
  const port = await freePort();
  const sup = new ConsoleSupervisor({
    projectRoot: dir,
    port,
    idleExitMs: 0,
    cacheTtlMs: 0,
    env: {
      WB_FIXTURE_DIR: dir,
      WB_FIXTURE_VERSION: '1',
      WORKBUDDY_HOST: '127.0.0.1',
      WORKBUDDY_PORT: '9911',
      WORKBUDDY_LOCAL_TOKEN: 'tok-child',
    },
  });
  try {
    const ensured = await sup.ensure({ readyTimeoutMs: 8000 });
    assert.equal(ensured.ok, true, ensured.error);
    await waitFor(() => existsSync(join(dir, 'env.json')), 3000, 'fixture 写出 env.json');
    const env = JSON.parse(readFileSync(join(dir, 'env.json'), 'utf8'));
    assert.equal(env.DASHBOARD_IDLE_EXIT_MS, '0', '显式 0（常驻）必须注入，不能被 .env 反向覆盖');
    assert.equal(env.DASHBOARD_PORT, String(port));
    assert.equal(env.WORKBUDDY_PORT, '9911', '控制台必须连插件配置的桥端口');
    assert.equal(env.WORKBUDDY_LOCAL_TOKEN, 'tok-child');
  } finally {
    await sup.stop().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});

test('子进程退出后 spawnedPid 清空（面板不再把它算成"可管理"）', async () => {
  const dir = makeProjectRoot();
  const port = await freePort();
  const sup = new ConsoleSupervisor({
    projectRoot: dir, port, idleExitMs: 0, cacheTtlMs: 0,
    env: { WB_FIXTURE_DIR: dir, WB_FIXTURE_VERSION: '1' },
  });
  try {
    const ensured = await sup.ensure({ readyTimeoutMs: 8000 });
    assert.equal(ensured.ok, true, ensured.error);
    const pid = sup.spawnedPid;
    assert.ok(pid > 0, '拉起的控制台应当有 pid');
    process.kill(pid, 'SIGTERM');
    await waitFor(() => sup.spawnedPid === null, 5000, 'spawnedPid 被清空');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('旧控制台没有 /api/version：按端口监听者确认归属后才停', async () => {
  const dir = makeProjectRoot();
  const port = await freePort();
  const sup = new ConsoleSupervisor({
    projectRoot: dir, port, idleExitMs: 0, cacheTtlMs: 0,
    env: { WB_FIXTURE_DIR: dir, WB_FIXTURE_VERSION: '0' },
  });
  try {
    const ensured = await sup.ensure({ readyTimeoutMs: 8000 });
    assert.equal(ensured.ok, true, ensured.error);
    assert.equal(await sup.fetchVersion(), null, 'fixture 不应提供 /api/version');
    const stopped = await sup.stop();
    assert.equal(stopped.ok, true, stopped.error);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('归属对不上时拒绝 kill（不能误杀端口上的另一个实例）', async () => {
  const dir = makeProjectRoot();
  const port = await freePort();
  const sup = new ConsoleSupervisor({
    projectRoot: dir, port, idleExitMs: 0, cacheTtlMs: 0,
    env: { WB_FIXTURE_DIR: dir, WB_FIXTURE_VERSION: '1' },
  });
  try {
    const ensured = await sup.ensure({ readyTimeoutMs: 8000 });
    assert.equal(ensured.ok, true, ensured.error);
    sup.spawnedPid = 999_999; // 模拟"记忆里的 pid 已过期，端口上是另一个实例"
    const stopped = await sup.stop();
    assert.equal(stopped.ok, false);
    assert.match(stopped.error, /另一个实例/);
    assert.equal((await sup.probe({ cached: false })).state, 'running', '拒绝后不能把控制台杀掉');
  } finally {
    await sup.stop().catch(() => {});
    // spawnedPid 已被拒绝逻辑清空，直接按端口善后；并等进程真的退出再删目录
    // （Windows 上进程仍以该目录为 cwd 时 rmSync 会 EPERM）。
    try {
      const { findPortPid } = await import('../lib/console.mjs');
      const pid = findPortPid(port);
      if (pid) process.kill(pid, 'SIGTERM');
    } catch { /* 已退出 */ }
    for (let i = 0; i < 80; i += 1) {
      if ((await sup.probe({ cached: false })).state !== 'running') break;
      await sleep(50);
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
