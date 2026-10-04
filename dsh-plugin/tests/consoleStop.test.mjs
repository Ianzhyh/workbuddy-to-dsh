/**
 * 控制台「停桥」路径的自测（对应的实现是 dashboard/server.mjs）。
 *
 * 为什么这一层要单独钉住：`stopBridgeAndWait` 曾经在**等待端口释放**的轮询
 * 循环里调同步的 findPortPid，于是一次"重启桥"最坏会 spawnSync 几十次
 * netstat —— 每次都把事件循环卡住，页面上表现为"点了停止，整个控制台僵几秒"。
 * 这里把三件事钉死：
 *
 *   1. "端口上没有监听进程"时**立刻**返回（不白等 5 秒端口轮询）；
 *   2. 端口上真有监听者时，停完仍返回承诺过的结构；
 *   3. 失败 / 成功的返回形状固定（`{stopped:false, error}` ↔ `{stopped:true, pid}`），
 *      前端与其它测试都按这个形状读。
 *
 * ## 关于"谁来当那个监听者"——这一条踩过坑，别改回去
 *
 * `stopBridgeAndWait` 会**真的**杀掉端口上的监听进程。第一版让测试自己在
 * 同进程里 `listen(0)`，于是 stopBridge 顺着端口找到的 PID 就是**测试进程自己**，
 * `taskkill /F` 一枪把测试打成 exit 1 —— 现场什么断言都看不到，只有一句笼统的
 * "test failed"（连 uncaughtException 都不给，因为进程是被外部结束的）。
 *
 * 所以监听者必须是**独立子进程**：[_holder.mjs](./_holder.mjs) 只负责占住端口、
 * 把端口号打在 stdout 的第一行，然后等死。这样被杀的就不是 runner，
 * 而我们仍然验的是"真的子进程 + 真的端口"这条路。
 *
 * ## 关于端口号
 *
 * 一律由 OS 分配（`listen(0)` 后读 `server.address().port`），**一个都不硬编码**。
 * `test:plugin` 的 glob 会把所有测试文件收进去，硬编码端口一旦撞上（本机在跑的
 * 控制台、同批的另一个测试文件）就是 EADDRINUSE，而那属于 uncaughtException ——
 * 整个文件直接判失败，轮不到断言说话。
 *
 * ## 关于 import 副作用
 *
 * `dashboard/server.mjs` 现在只在**被当作进程入口**时才 `listen`（见该文件的
 * `isMainModule`）。此前它是 import 即 listen，测试进程会挂着一个永不关闭的
 * 监听 socket，`node --test` 的子进程因此永远不退出 —— 同样是那种"没有报错
 * 的失败"。这几个环境变量仍要在 import **之前**设好：config.mjs 在 import 时求值。
 *
 *   node --test dsh-plugin/tests/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOLDER = join(HERE, '_holder.mjs');

// 必须在 import server.mjs 之前定好：
//   - WORKBUDDY_EXT_TOKEN：config.mjs 在 import 时校验令牌，缺了会 process.exit(1)，
//     测试进程会静默死在 import 那一行；
//   - DASHBOARD_AUTO_START_BRIDGE=0：否则控制台若被拉起来就会去动本机真实的桥；
//   - 端口一律交给 OS —— 测试自己不起服务，这里给个占位值即可。
process.env.WORKBUDDY_EXT_TOKEN = process.env.WORKBUDDY_EXT_TOKEN || 'wb-test-panel-token';
process.env.DASHBOARD_AUTO_START_BRIDGE = '0';
process.env.DASHBOARD_PORT = process.env.DASHBOARD_PORT || '0';
process.env.WORKBUDDY_PORT = process.env.WORKBUDDY_PORT || '0';

const { stopBridgeAndWait } = await import('../../dashboard/server.mjs');

/**
 * 起一个**独立子进程**占住某个端口，返回 {port, child, waitClose}。
 * 端口从子进程 stdout 的第一行读（OS 分配，绝不硬编码）。
 */
function startHolder() {
  const child = spawn(process.execPath, [HOLDER], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  const port = new Promise((ok, fail) => {
    let buf = '';
    const timer = setTimeout(() => fail(new Error('占位子进程 5 秒内没有报出端口')), 5000);
    child.stdout.on('data', (c) => {
      buf += c;
      const line = buf.split('\n')[0].trim();
      if (/^\d+$/.test(line)) { clearTimeout(timer); ok(Number(line)); }
    });
    child.on('error', (e) => { clearTimeout(timer); fail(e); });
    child.on('exit', () => { clearTimeout(timer); fail(new Error('占位子进程提前退出')); });
  });
  return { child, port };
}

/** 挑一个"刚刚证明过没人占"的端口号（用子进程绑一次再放掉）。 */
async function freePort() {
  const holder = startHolder();
  try {
    const port = await holder.port;
    holder.child.kill();
    await new Promise((r) => { holder.child.once('exit', r); setTimeout(r, 2000); });
    return port;
  } catch {
    return 0;
  }
}

test('停桥：端口上没有监听进程时必须立刻返回，不进入 5 秒端口轮询', async () => {
  const port = await freePort();
  assert.ok(port > 0, '没能取得一个空闲端口号');

  const started = Date.now();
  const result = await stopBridgeAndWait(port);
  const elapsed = Date.now() - started;

  // 结构没变：失败时只有 {stopped:false, error}
  assert.equal(result.stopped, false);
  assert.match(result.error, new RegExp(`端口 ${port} 上没有监听进程`));
  assert.equal(result.pid, undefined);
  assert.equal(result.warning, undefined, '没在跑就不该出现 warning');
  // 旧实现会先跑满 20 次同步 findPortPid（5 秒）。给足余量，但必须远小于 5 秒。
  assert.ok(elapsed < 2000, `停止"本来就没跑"的桥耗时 ${elapsed}ms，疑似仍在空转端口轮询`);
});

test('停桥：端口有真监听者时真的把它停掉，返回结构稳定', async () => {
  const holder = startHolder();
  const port = await holder.port;
  const exited = new Promise((r) => holder.child.once('exit', r));

  try {
    const started = Date.now();
    const result = await stopBridgeAndWait(port);
    const elapsed = Date.now() - started;

    // 无论平台如何，返回形状必须固定：成功 = {stopped:true, pid}，失败 = {stopped:false, error}
    if (result.stopped) {
      assert.ok(Number.isInteger(result.pid) && result.pid > 0, `必须报出被停的 pid，实际 ${result.pid}`);
      assert.equal(result.error, undefined);
      assert.equal(result.warning, undefined, '进程已退出就不该有 warning');
      // 真的把它结束了（端口轮询是异步的，应当**很快**发现）
      await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
      assert.equal(holder.child.exitCode !== null || holder.child.signalCode !== null, true,
        '报了 stopped:true，子进程却还活着');
      assert.ok(elapsed < 5000, `端口已释放却等了 ${elapsed}ms`);
    } else {
      // 权限不足等情况下 taskkill/SIGTERM 会失败：仍然是同一个形状，只多一个 error
      assert.equal(typeof result.error, 'string');
      assert.ok(result.error.length > 0);
    }
  } finally {
    try { holder.child.kill(); } catch { /* 已经退了 */ }
  }
});

test('停桥：失败路径的返回必须是干净的两个字段，不掺杂内部状态', async () => {
  const port = await freePort();
  assert.ok(port > 0, '没能取得一个空闲端口号');
  const result = await stopBridgeAndWait(port);

  assert.equal(result.stopped, false);
  assert.deepEqual(Object.keys(result).sort(), ['error', 'stopped']);
});
