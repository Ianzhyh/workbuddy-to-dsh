/**
 * 控制台 `/api/accounts` 的跨站门槛（与 audit R4 同类）。
 *
 * `/api/accounts` 不只是"读列表"：钉住状态过期时它会写 `.state.json` 并重启桥，
 * 而浏览器发 `<img>`/`<script>` 时不带 Origin —— 能绕过 `originAllowed` 的
 * 跨站检查，也带不上 `x-workbuddy-panel`。所以它必须和 `/api/diagnose` 一样
 * 要求面板头。这里起一个真控制台进程验证两个方向：
 *   1. 无头（等价浏览器 `<img>`）→ 403；
 *   2. 面板头 → 200（页面与插件内部调用照常可用）。
 *
 * 隔离：临时 state/data/auth 目录 + 随机端口，不碰使用者真实账号。
 *
 *   node --test dsh-plugin/tests/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pickBridgePort } from '../../tools/dev/bridge-ports.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const SERVER = join(REPO, 'dashboard', 'server.mjs');

test('控制台 /api/accounts 必须带面板头（无 Origin 的跨站请求挡得住）', { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-console-gate-'));
  const port = pickBridgePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [SERVER], {
    cwd: REPO,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      DASHBOARD_HOST: '127.0.0.1',
      DASHBOARD_PORT: String(port),
      DASHBOARD_AUTO_START_BRIDGE: '0',
      DASHBOARD_IDLE_EXIT_MS: '0',
      DASHBOARD_OPEN_BROWSER: '0',
      WORKBUDDY_LOCAL_TOKEN: 'console-gate-token',
      WORKBUDDY_STATE_FILE: join(dir, 'state.json'),
      WORKBUDDY_DATA_DIR: dir,
      WORKBUDDY_AUTH_DIR: join(dir, 'auth'),
      WORKBUDDY_USAGE_FILE: join(dir, 'usage.jsonl'),
      WORKBUDDY_PORT: String(pickBridgePort()),
    },
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  try {
    const deadline = Date.now() + 20_000;
    let ready = false;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) break;
      try {
        const res = await fetch(base + '/api/version', { signal: AbortSignal.timeout(1000) });
        if (res.ok) { ready = true; await res.text(); break; }
      } catch { /* 还没起来 */ }
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.ok(ready, `控制台未就绪：\n${out.slice(-1500)}`);

    const anon = await fetch(base + '/api/accounts', { signal: AbortSignal.timeout(10_000) });
    assert.equal(anon.status, 403, '没有面板头的 /api/accounts 必须拒绝（等价于浏览器 <img>）');
    await anon.text();

    const panel = await fetch(base + '/api/accounts', {
      headers: { 'x-workbuddy-panel': '1' },
      signal: AbortSignal.timeout(15_000),
    });
    assert.equal(panel.status, 200, '控制台页面（带面板头）必须照常可用');
    await panel.text();
  } finally {
    child.kill();
    await new Promise((resolve) => {
      if (child.exitCode !== null) { resolve(); return; }
      child.once('exit', resolve);
      setTimeout(resolve, 2000);
    });
    rmSync(dir, { recursive: true, force: true });
  }
});
