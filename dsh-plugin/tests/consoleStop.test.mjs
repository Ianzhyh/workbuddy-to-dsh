/**
 * 控制台「停桥」路径的自测（对应的实现是 dashboard/server.mjs）。
 *
 * 为什么这一层要单独钉住：`stopBridgeAndWait` 曾经在**等待端口释放**的轮询
 * 循环里调同步的 findPortPid，于是一次"重启桥"最坏会 spawnSync 几十次
 * netstat —— 每次都把事件循环卡住，页面上表现为"点了停止，整个控制台僵几秒"。
 * 这里把四件事钉死：
 *
 *   1. "端口上没有监听进程"时**立刻**返回（不白等 5 秒端口轮询）；
 *   2. **端口上是无关进程时拒绝 kill**（归属校验，见文件末尾 foreign 用例）；
 *   3. 端口上是**真桥**时照常能停（别为了安全把功能一起挡掉）；
 *   4. 成功 / 失败的返回形状固定（`{stopped:true, pid}` ↔ `{stopped:false, error}`），
 *      前端与其它测试都按这个形状读。
 *
 * ## 关于"谁来当那个监听者"——这一条踩过坑，别改回去
 *
 * `stopBridgeAndWait` 会**真的**杀掉端口上的监听进程。第一版让测试自己在
 * 同进程里 `listen(0)`，于是 stopBridge 顺着端口找到的 PID 就是**测试进程自己**，
 * `taskkill /F` 一枪把测试打成 exit 1 —— 现场什么断言都看不到，只有一句笼统的
 * "test failed"（连 uncaughtException 都不给，因为进程是被外部结束的）。
 *
 * 所以监听者必须是**独立子进程**，且现在有两种：
 *   - `_holder.mjs`        —— 无关进程（回一段纯文本），验证「不该被杀」；
 *   - `_bridgeHolder.mjs`  —— 像桥的进程（回形状正确的 /health），验证「该杀的要杀掉」。
 * 两个方向都要有，否则修归属校验时很容易把正常功能一起挡掉。
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

/**
 * 起一个**像桥的**独立子进程（回形状正确的 `/health`），用于验证
 * 「该杀的仍然杀得掉」—— 免得为了防误杀把正常停止功能一起挡掉。
 */
function startBridgeHolder() {
  const BRIDGE_HOLDER = join(HERE, '_bridgeHolder.mjs');
  const child = spawn(process.execPath, [BRIDGE_HOLDER], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  const port = new Promise((ok, fail) => {
    let buf = '';
    const timer = setTimeout(() => fail(new Error('桥占位子进程 5 秒内没有报出端口')), 5000);
    child.stdout.on('data', (c) => {
      buf += c;
      const line = buf.split('\n')[0].trim();
      if (/^\d+$/.test(line)) { clearTimeout(timer); ok(Number(line)); }
    });
    child.on('error', (e) => { clearTimeout(timer); fail(e); });
    child.on('exit', () => { clearTimeout(timer); fail(new Error('桥占位子进程提前退出')); });
  });
  return { child, port };
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

/**
 * 这条用例的**语义已随归属校验的引入而改变**，名字与断言同步改了 ——
 * 旧版本用 `_holder.mjs`（一个无关进程）当监听者，断言"必须把它停掉"，
 * 那实际上是在为「误杀无关进程」背书（见文件末尾 foreign 用例的长注释）。
 *
 * 现在 `_holder.mjs` 扮演的是**占用端口的无关进程**，期望行为变成"拒绝 kill"。
 * 真正的"停掉桥"由下面的 `_bridgeHolder.mjs` 用例覆盖。
 *
 * 保留这条是为了钉住**返回结构**：无论拒绝还是成功，形状必须固定，
 * 前端与其它测试都按这个形状读。
 */
test('停桥：拒绝 kill 无关进程时返回结构仍稳定（形状契约）', async () => {
  const holder = startHolder();
  const port = await holder.port;

  try {
    const started = Date.now();
    const result = await stopBridgeAndWait(port);
    const elapsed = Date.now() - started;

    // 无论平台如何，返回形状必须固定：成功 = {stopped:true, pid}，失败 = {stopped:false, error}
    if (result.stopped) {
      assert.ok(Number.isInteger(result.pid) && result.pid > 0, `必须报出被停的 pid，实际 ${result.pid}`);
      assert.equal(result.error, undefined);
      assert.equal(result.warning, undefined, '进程已退出就不该有 warning');
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

test('停桥：失败路径的返回必须干净，不掺杂内部状态', async () => {
  const port = await freePort();
  assert.ok(port > 0, '没能取得一个空闲端口号');
  const result = await stopBridgeAndWait(port);

  assert.equal(result.stopped, false);
  /*
   * 「端口上没有人」这条失败路径只给两个字段。
   *
   * 注意**另一条**失败路径（端口上是无关进程，被归属校验挡下）会多一个 `pid` ——
   * 那不是"内部状态"，而是用户排查时最需要的那条信息（谁占着这个端口）。
   * 两条失败路径的字段集不同是**有意的**：没找到进程时没有 pid 可给。
   * 这里断言的是"没有多余的东西"，不是"所有失败都长一样"。
   */
  assert.deepEqual(Object.keys(result).sort(), ['error', 'stopped']);
});

/*
 * ── 归属校验：端口上那个进程，到底是不是我们的桥？ ──────────────────────
 *
 * 上面那条「端口有真监听者时真的把它停掉」的用例，把**杀掉任意监听者**
 * 当成了期望行为 —— 它用 `_holder.mjs` 起一个跟 workbuddy 毫无关系的
 * 纯占位进程，然后断言"必须把它停掉"。
 *
 * 这固化了错误的行为：**用户点一下"停止桥服务"，会强杀端口上任何一个无关进程。**
 * 现实里 8790 经常被别的工具占用（另一个 node、某个开发服务器），
 * 这时控制台不但停不掉桥，还会替用户杀掉别人的进程，且不做任何确认。
 *
 * 对比：dsh 插件的 `BridgeSupervisor.probe()` 有 foreign 判定 —— 它先打
 * `/health`，认不出是自己人就报 `state:'foreign'`，绝不 kill。控制台这条
 * 路径缺了同一道校验。
 *
 * 契约：
 *   ① 端口上的监听者**不是桥**时，必须拒绝 kill，返回 stopped:false + 说明；
 *   ② 那个无辜进程必须**还活着**；
 *   ③ 端口上是**真桥**时，照常能停（不能为了安全把正常功能也一起挡掉）。
 */
test('停桥：端口上不是桥（foreign）时必须拒绝 kill，绝不能误杀无关进程', { timeout: 30_000 }, async () => {
  const holder = startHolder(); // 纯占位进程：不响应 /health，或响应非桥形状
  const port = await holder.port;

  try {
    const result = await stopBridgeAndWait(port);

    assert.equal(result.stopped, false,
      '端口上不是 workbuddy-bridge，不该报"已停止"——那意味着我们杀了一个无关进程');
    assert.equal(typeof result.error, 'string');
    assert.ok(result.error.length > 0, '必须说明为什么没停');
    assert.ok(/不是|foreign|非.*桥|not .*bridge|不认得|认不出/i.test(result.error),
      `错误信息要让人看懂"端口上那个不是桥"，实际是：${result.error}`);
    // 必须报出"是谁占着端口" —— 这是用户排查时唯一能动手的线索
    assert.ok(Number.isInteger(result.pid) && result.pid > 0,
      `拒绝 kill 时要报出占用者的 pid，实际 ${result.pid}`);

    // ② 最关键的一条：无辜进程必须还活着
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(holder.child.exitCode, null,
      '❌ 无关进程被杀了 —— 用户点"停止桥"不该误伤端口上的其它服务');
    assert.equal(holder.child.signalCode, null, '无关进程被信号杀掉了');
  } finally {
    try { holder.child.kill(); } catch { /* 忽略 */ }
  }
});

test('停桥：端口上是真桥时仍能正常停掉（别为了安全把功能一起挡掉）', { timeout: 30_000 }, async () => {
  const holder = startBridgeHolder();
  try {
    const port = await holder.port;
    const result = await stopBridgeAndWait(port);
    assert.equal(result.stopped, true,
      `端口上确实是桥，应当能停掉。实际：${JSON.stringify(result)}`);
    await new Promise((r) => setTimeout(r, 600));
    assert.ok(holder.child.exitCode !== null || holder.child.signalCode !== null,
      '报了 stopped:true，桥进程却还活着');
  } finally {
    try { holder.child.kill(); } catch { /* 已退 */ }
  }
});

/*
 * 归属校验的边界：**令牌不一致 ≠ 不是桥**。
 *
 * 这条是上一条的必然推论，但很容易被漏掉：如果 isOurBridge 把 401 一律当成
 * "不是桥"，那么「桥用旧令牌跑着、控制台手里是新令牌」这种真实场景下，
 * 控制台会拒绝停桥，还告诉用户"端口上那个不是 workbuddy-bridge" ——
 * **诊断是假的**，用户会去找一个不存在的进程冲突。
 *
 * 契约：桥回 401 时仍然要能把它停掉（它确实是我们自己的进程）。
 */

test('停桥：桥回 401（令牌不一致）时仍应能停掉它 —— 401 不等于"不是桥"', { timeout: 30_000 }, async () => {
  const child = spawn(process.execPath, [join(HERE, '_auth401Holder.mjs')],
    { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });

  const port = await new Promise((ok, fail) => {
    let buf = '';
    const timer = setTimeout(() => fail(new Error('401 占位进程没报端口')), 5000);
    child.stdout.on('data', (c) => {
      buf += c;
      const line = buf.split(String.fromCharCode(10))[0].trim();
      if (/^[0-9]+$/.test(line)) { clearTimeout(timer); ok(Number(line)); }
    });
    child.on('error', (e) => { clearTimeout(timer); fail(e); });
  });

  try {
    const result = await stopBridgeAndWait(port);
    assert.equal(result.stopped, true,
      '401 说明这确实是我们自己的桥（只是令牌不一致），应当能停。实际：' + JSON.stringify(result));
    await new Promise((r) => setTimeout(r, 600));
    assert.ok(child.exitCode !== null || child.signalCode !== null, '报了 stopped:true，进程却还活着');
  } finally {
    try { child.kill(); } catch { /* 已退 */ }
  }
});
