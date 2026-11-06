/**
 * 第三份审计（dsh-plugin 侧）修复的回归。
 *
 * 挑的是**会破坏用户环境或写坏用户配置**的那几条，逐条钉住：
 *
 *   1. `stop()` 不许凭 `/health` 里的 pid 就 SIGTERM —— 端口上任何一个本地服务
 *      只要回 `{ok:true,pid:N}`，N 就能是本机任意进程。这是整份代码里唯一会
 *      **主动杀掉别人进程**的行为（实测过无关进程被杀死）。
 *   2. `start()` 不许在 spawn 失败时报 `ok:true` —— `spawn` 的失败多数从
 *      `error` 事件异步来，不看 `child.pid` 就会把"没有任何进程"报成成功。
 *   3. legacy YAML 清理不许把**别人**的 `providers:` 改成 `{}`，也不许留下
 *      悬空的 `providers:`（那会让文件变成语法非法，dsh 下次启动直接抛错）。
 *   4. `cleanLegacyRoutes().found` 不许把「没找到」判成「找到了」。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = dirname(HERE);
const REPO = dirname(PLUGIN_DIR);

const home = mkdtempSync(join(tmpdir(), 'wb-audit3-home-'));
process.env.DSH_HOME = home;
mkdirSync(join(home, 'profiles', 'desktop'), { recursive: true });
writeFileSync(join(home, 'profiles', 'desktop', 'cordis.patch.yml'), '# 用户自己的 patch\n', 'utf8');
process.env.WORKBUDDY_PORT = '0';
process.env.WORKBUDDY_EXT_TOKEN = process.env.WORKBUDDY_EXT_TOKEN || 'wb-test-panel-token';

const { BridgeSupervisor } = await import('../lib/bridge.mjs');
const { stripProviderBlock, cleanLegacyRoutes } = await import('../lib/legacy.mjs');

/** 起一个假的 HTTP 服务，按给定 handler 应答。 */
async function startStub(handler) {
  const server = createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, port: server.address().port };
}

/** 拿一个确实活着、但与桥无关的 pid（用当前进程的父进程）。 */
function foreignAlivePid() {
  const pid = process.ppid;
  if (!Number.isFinite(pid) || pid <= 0) throw new Error('拿不到一个无关 pid');
  return pid;
}

test('审计：stop() 不肯杀死端口上那个"自称是桥"的无关进程', async () => {
  const victim = foreignAlivePid();
  // 假服务：形状和真桥的 /health 一模一样，只是 pid 指向一个无关进程
  const stub = await startStub((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, pid: victim, build: 'deadbeefcafe' }));
  });
  const sup = new BridgeSupervisor({
    projectRoot: REPO,
    host: '127.0.0.1',
    port: stub.port,
    token: 'test-token',
    nodePath: process.execPath,
    env: {},
    onLog: () => {},
  });
  try {
    const probe = await sup.probe();
    // 形状上它"像桥"（ok:true + pid），但构建指纹对不上
    assert.equal(probe.state, 'running', `probe 应认出这是个 pid 应答，实际 ${probe.state}`);

    const result = await sup.stop();
    assert.equal(result.ok, false, `必须拒绝 kill，实际：${JSON.stringify(result)}`);
    assert.equal(result.stopped, false);
    assert.match(String(result.error || ''), /不是 workbuddy-bridge|构建指纹|无法确认/,
      `错误信息应说明为什么拒绝，实际：${result.error}`);

    // 最关键：那个无关进程必须还活着
    let alive = true;
    try { process.kill(victim, 0); } catch { alive = false; }
    assert.equal(alive, true, '❌ 无关进程被杀掉了 —— stop() 必须证明归属才允许 SIGTERM');
  } finally {
    stub.server.close();
  }
});

test('审计：start() 不许在 spawn 失败时报 ok:true', async () => {
  const port = await new Promise((r) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); });
  });
  const sup = new BridgeSupervisor({
    projectRoot: REPO,
    host: '127.0.0.1',
    port,
    token: 'test-token',
    // 指向一个不存在的可执行文件：spawn 会失败
    nodePath: join(REPO, 'no-such-node-binary-for-audit-test.exe'),
    scriptPath: join(REPO, 'bridge', 'workbuddy-bridge.mjs'),
    env: {},
    onLog: () => {},
  });
  const result = await sup.start();
  assert.equal(result.ok, false, `spawn 失败必须报 ok:false，实际：${JSON.stringify(result)}`);
  assert.equal(result.pid, null);
  assert.ok(String(result.error || '').length > 0, '必须带出失败原因');
  assert.equal(sup.spawnedPid, null, '没有 pid 时不能留下归属，否则后续 stop() 会按它去 kill 别人');
});

test('审计：legacy 清理保留别人的 providers 段，且不留下悬空键', () => {
  const text = [
    'other-plugin:',
    '  providers:',
    '    foo:',
    '      baseURL: http://example.invalid',
    'llm-pi-ai:',
    '  providers:',
    '    workbuddy:',
    '      baseURL: http://127.0.0.1:8790/v1',
    '',
  ].join('\n');

  const cleaned = stripProviderBlock(text, 'workbuddy');
  assert.equal(cleaned.changed, true);
  assert.ok(!cleaned.text.includes('workbuddy'), 'workbuddy 段应被删掉');
  assert.ok(cleaned.text.includes('other-plugin:\n  providers:\n    foo:'),
    `别人的 providers 段必须原样保留，实际：${JSON.stringify(cleaned.text)}`);

  // 悬空键检查：`key:`（无值）后面必须紧跟更深缩进的行
  const lines = cleaned.text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^[ \t]*[A-Za-z0-9_.\-/"']+:\s*$/.test(lines[i])) continue;
    let j = i + 1;
    while (j < lines.length && lines[j].trim() === '') j += 1;
    if (j >= lines.length) continue;
    const own = /^[ \t]*/.exec(lines[i])[0].length;
    const next = /^[ \t]*/.exec(lines[j])[0].length;
    assert.ok(next > own,
      `第 ${i + 1} 行是悬空键 ${JSON.stringify(lines[i])}，后面跟同级行 ${JSON.stringify(lines[j])}`
      + '（这会让 YAML 变成语法非法）');
  }
  assert.match(cleaned.text, /^ *providers: \{\}$/m, '自己的空 providers 应写成显式 {}');
});

test('审计：cleanLegacyRoutes 的 found 不能把「没找到」判成「找到了」', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-legacy-audit-'));
  mkdirSync(join(dir, 'profiles'), { recursive: true });
  const settingsPath = join(dir, 'settings.yaml');
  const patchPath = join(dir, 'profiles', 'cordis.patch.yml');
  writeFileSync(settingsPath, 'web-search:\n  provider: deepseek-official\n', 'utf8');
  writeFileSync(patchPath, '- id: other\n  config: {}\n', 'utf8');

  try {
    const none = cleanLegacyRoutes({ settingsPath, patchPath });
    assert.equal(none.found, false, '没有旧路由时 found 必须是 false');
    assert.equal(none.changed, false);
    assert.ok(readFileSync(settingsPath, 'utf8').includes('deepseek-official'), '不该动别人的文件');

    // 有旧路由时：found = true，且文件被清理
    writeFileSync(settingsPath, 'llm-pi-ai:\n  providers:\n    workbuddy:\n      baseURL: x\n', 'utf8');
    const hit = cleanLegacyRoutes({ settingsPath, patchPath });
    assert.equal(hit.found, true, '有旧路由时 found 必须是 true');
    assert.equal(hit.changed, true);
    assert.ok(!readFileSync(settingsPath, 'utf8').includes('workbuddy'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

after(() => {
  try { rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* 已清理 */ }
});
