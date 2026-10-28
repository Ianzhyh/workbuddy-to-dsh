/**
 * 桥的**启动参数解析** —— 只关心"参数写错了桥还能不能起来"。
 *
 * 为什么单独一个文件：`bridge.test.mjs` 的 `startBridge()` 总是注入合法端口，
 * 所以「端口写错」这条路径在该文件里**永远走不到**。这正是当年
 * 「未配令牌即放行」那个洞能长期潜伏的同一类盲区：夹具把所有输入都摆成正的，
 * 负的路径没人走。
 *
 * 两层验证：
 *   1. **纯逻辑**：照桥里 `numEnv()` 的规则复刻一份第二实现，逐条对照边界。
 *      便宜、确定、跨平台一致 —— 是主力。
 *   2. **进程级 smoke**：真起一次桥，确认"端口写错不再抛 ERR_SOCKET_BAD_PORT"。
 *      只需 1 例，避免在 CI 上跟别人的端口抢来抢去。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pickBridgePort, isPortInUseError, BRIDGE_PORT_MIN, BRIDGE_PORT_MAX } from '../tools/dev/bridge-ports.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BRIDGE = join(HERE, '..', 'bridge', 'workbuddy-bridge.mjs');
const TOKEN = 'test-token-badport-0123456789';

/*
 * 本文件里起过的子进程 —— 由文件级 `test.after` 统一收尾。
 *
 * 为什么需要：本文件的三个进程级用例都是「spawn → 读输出 → 断言 → finally kill」。
 * `finally` 能覆盖断言失败，但覆盖不了**断言之前**的异常（spawn 之后、进 try 之前
 * 那一小段，以及用例里第一个 await 抛错的情形）。一旦漏杀，子进程的 stdout/stderr
 * 管道挂在测试进程上，`node --test` 跑完所有用例后**不退出** ——
 * CI 上表现为 job 跑满 timeout 被 cancel，而不是一条能看懂的失败。
 * 同批的 `bridge.test.mjs` 就是这么挂住的（见 `bridge-ports.mjs` 的注释）。
 */
const liveChildren = new Set();

/** 起一个子进程并登记，返回它（收尾由 `test.after` 兜底）。 */
function spawnTracked(command, args, options) {
  const child = spawn(command, args, options);
  liveChildren.add(child);
  child.once('exit', () => liveChildren.delete(child));
  return child;
}

test.after(async () => {
  for (const child of liveChildren) {
    try { child.kill(); } catch { /* 已经退出 */ }
  }
  await new Promise((resolve) => {
    if (!liveChildren.size) { resolve(); return; }
    const timer = setTimeout(resolve, 3000);
    for (const child of liveChildren) child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
  liveChildren.clear();
});

// ── 第一层：纯逻辑（第二实现） ────────────────────────────────────────────

/**
 * 复刻桥与 config.mjs 共用的规则。
 *
 * 刻意**不复用**被测代码（桥无法被 import，且它的 numEnv 不导出）——
 * 照着规则独立写一份，测试才有证伪能力。
 */
function parseNum(raw, fallback, range = {}) {
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  if (value < (range.min ?? -Infinity) || value > (range.max ?? Infinity)) return fallback;
  return value;
}
const parsePort = (raw, fallback = 8790) => parseNum(raw, fallback, { min: 1, max: 65535 });

// ── 测试端口来源（`tools/dev/bridge-ports.mjs`）──────────────────────────
//
// 这一节防的是 2026-10-27 那次发版门禁翻车：测试自己挑端口时用了
// `20000 + Math.random() * 20000`，这个区间横跨 Linux 的临时端口段，
// 而打桩上游全都 `listen(0)` 被内核分到同一段里 —— 于是撞车。
// 详见 `tools/dev/bridge-ports.mjs` 的头注释与 `startBridge` 的注释。

test('测试端口落在 12000–19999，且永远避开默认端口', () => {
  for (let i = 0; i < 500; i += 1) {
    const p = pickBridgePort();
    assert.ok(Number.isInteger(p), `端口必须是整数，实得 ${p}`);
    assert.ok(p >= BRIDGE_PORT_MIN && p <= BRIDGE_PORT_MAX,
      `端口 ${p} 越出 ${BRIDGE_PORT_MIN}–${BRIDGE_PORT_MAX}`);
    assert.notEqual(p, 8790, '不能撞上默认的桥端口（用户本机可能正跑着一个）');
    assert.notEqual(p, 8792, '不能撞上默认的控制台端口');
  }
});

test('测试端口段必须整体低于临时端口下界（否则 listen(0) 迟早撞上来）', () => {
  /*
   * Linux 默认 32768–60999，macOS / Windows 默认 49152–65535。
   * 取三者里**最小**的下界当红线：只有上界低于它，三个平台才都安全。
   * 这条把"我们以为的随机"变成可验证的边界，而不是靠谁记得。
   */
  const EPHEMERAL_FLOOR_MIN = 32768;
  assert.ok(BRIDGE_PORT_MAX < EPHEMERAL_FLOOR_MIN,
    `${BRIDGE_PORT_MAX} 不低于临时端口下界 ${EPHEMERAL_FLOOR_MIN}：`
    + '打桩上游用 listen(0)，内核会把它们分进那一段，撞车只是时间问题');
  // 下界也别贴着桥的默认端口，给本机正在跑的实例留出空间
  assert.ok(BRIDGE_PORT_MIN > 8792, `${BRIDGE_PORT_MIN} 离默认端口太近`);
});

test('isPortInUseError 只认真正的端口占用（别把配置写错也当成可重试）', () => {
  assert.equal(isPortInUseError('Error: listen EADDRINUSE: address already in use 127.0.0.1:39846'), true);
  assert.equal(isPortInUseError('listen EADDRINUSE'), true);
  assert.equal(isPortInUseError('Error: Cannot find module ./nope.mjs'), false,
    '依赖缺失换端口也没用，重试只会把 5 次都耗在同一个错误上');
  assert.equal(isPortInUseError(''), false);
  assert.equal(isPortInUseError(undefined), false, '子进程还没来得及输出时不能抛');
});

test('端口解析：非数值 / 空白 / 带单位一律回退默认（旧写法会得 NaN）', () => {
  for (const bad of ['879O', 'abc', '8790ms', '  ', 'NaN', 'Infinity', '-']) {
    const got = parsePort(bad);
    assert.equal(got, 8790, `WORKBUDDY_PORT=${JSON.stringify(bad)} 应回退 8790，实际 ${got}`);
    assert.ok(Number.isFinite(got), '绝不能是 NaN —— listen(NaN) 会让桥整个起不来');
  }
});

test('端口解析：越界回退默认，而不是截断到边界', () => {
  // 99999 显然是写错了，静默改成 65535 会让用户以为配置生效了
  for (const bad of ['0', '-1', '65536', '99999']) {
    assert.equal(parsePort(bad), 8790, `端口 ${bad} 越界应回退默认`);
  }
});

test('端口解析：合法值原样保留（含边界）；未设置/空串用默认', () => {
  assert.equal(parsePort('1'), 1);
  assert.equal(parsePort('8790'), 8790);
  assert.equal(parsePort('65535'), 65535);
  assert.equal(parsePort(undefined), 8790, '未设置时用默认');
  assert.equal(parsePort(''), 8790, '空串视为未设置');});

test('上限类解析：NaN 绝不能"静默取消限制"（MAX_BODY_BYTES 的安全含义）', () => {
  /*
   * 这是本轮最要紧的一条：`readBody` 里是 `if (size > limit)`。
   * 若 limit 变成 NaN，`size > NaN` **恒为 false** —— 请求体上限彻底消失，
   * 同机任何进程都能灌爆内存。所以上限类参数必须回退到**有限正数**默认。
   */
  const DEFAULT_32MB = 32 * 1024 * 1024;
  for (const bad of ['abc', '8790ms', 'NaN', '', '  ']) {
    const got = parseNum(bad, DEFAULT_32MB, { min: 1024 });
    assert.equal(got, DEFAULT_32MB, `上限参数 ${JSON.stringify(bad)} 必须回退默认`);
    assert.ok(Number.isFinite(got) && got > 0, '上限必须是有限正数，否则限制消失');
  }
});

test('超时类解析：非法值与负数一律归 0（NaN 会让 setTimeout 立即触发）', () => {
  for (const bad of ['abc', 'nope', '-5', 'NaN']) {
    assert.equal(parseNum(bad, 0, { min: 0 }), 0, `超时 ${JSON.stringify(bad)} 应归 0`);
  }
  assert.equal(parseNum('30000', 0, { min: 0 }), 30000, '合法超时原样保留');
});

// ── 第二层：进程级 smoke ─────────────────────────────────────────────────
//
// 只留 1 例。断言的是**行为类别**（不再抛端口解析异常），不是具体端口 ——
// 因为 CI runner 上 8790 可能空闲也可能被占，两种都算正确，
// 真去断言"必须监听 8790"反而会和同 job 的其它测试抢端口（本机就踩过这个坑：
// 8790 上跑着用户的真桥，回 401，于是"子进程崩了"也被判成就绪）。

test('桥 smoke：端口写成非数值时不再抛 ERR_SOCKET_BAD_PORT', { timeout: 30_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-port-'));
  const authFile = join(dir, 'fake-auth.info');
  writeFileSync(authFile, JSON.stringify({
    auth: {
      accessToken: 'fake-access-token',
      refreshToken: 'fake-refresh-token',
      domain: 'example.invalid',
      expiresAt: Date.now() + 30 * 86_400_000,
    },
  }));

  const child = spawnTracked(process.execPath, [BRIDGE], {
    cwd: dir,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      WORKBUDDY_HOST: '127.0.0.1',
      WORKBUDDY_PORT: '879O', // ← 字母 O：旧写法得到 NaN
      WORKBUDDY_LOCAL_TOKEN: TOKEN,
      WORKBUDDY_AUTH_FILE: authFile,
      WORKBUDDY_CREDENTIAL_DIR: join(dir, 'credentials'),
      WORKBUDDY_USAGE_FILE: join(dir, 'usage.jsonl'),
      WORKBUDDY_AUTO_CHECKIN: '0',
      WORKBUDDY_LOG: '0',
    },
  });

  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });

  try {
    const deadline = Date.now() + 12_000;
    // 等它要么成功监听，要么以可解释的原因退出
    while (Date.now() < deadline) {
      if (child.exitCode !== null) break;
      if (/listening|已监听|LISTENING|EADDRINUSE/iu.test(output)) break;
      await new Promise((r) => setTimeout(r, 200));
    }

    assert.ok(
      !/ERR_SOCKET_BAD_PORT|options\.port should be/u.test(output),
      `端口写错时仍死在解析上（用户看不出是自己 .env 写错了）：\n${output.slice(-500)}`,
    );
    if (child.exitCode !== null) {
      assert.match(
        output,
        /EADDRINUSE|listen/iu,
        `若非正常退出，输出里必须能看出原因，实际：\n${output.slice(-500)}`,
      );
    }
  } finally {
    await new Promise((resolve) => {
      child.once('exit', resolve);
      child.kill();
      setTimeout(resolve, 3000);
    });
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 顺带钉住"桥确实用了这条规则" ─────────────────────────────────────────

/**
 * 登录文件目录必须在**真实环境变量缺失**时仍然给出绝对路径。
 *
 * 现场（子进程实测）：Windows 默认**只有 `USERPROFILE`、没有 `HOME`**，而桥的
 * `AUTH_DIRS` 只认 `LOCALAPPDATA` / `HOME` / `XDG_DATA_HOME`。一旦 `LOCALAPPDATA`
 * 也没了（精简过的环境、从计划任务启动、CI），三个都为空 → 最后那行
 * `join(AUTH_DIRS[0] || '.', 'workbuddy-desktop.info')` 拼出**相对路径**
 * `workbuddy-desktop.info`。相对路径按 cwd 解析 → 桥找不到登录文件，
 * 而用户看到的是"没登录"，跟环境变量毫无关系，根本猜不到。
 * （同一份实现在 config.mjs 里有 `USERPROFILE` 兜底，桥这边漏了 —— 两套实现必然漂移。）
 */
test('登录文件目录：LOCALAPPDATA / HOME 都缺时也必须给出绝对路径', async () => {
  const child = spawnTracked(process.execPath, [BRIDGE], {
    cwd: HERE,
    env: {
      ...process.env,
      WORKBUDDY_PORT: String(pickBridgePort()),
      WORKBUDDY_LOCAL_TOKEN: TOKEN,
      // 模拟"精简过 / 非交互式"的 Windows 环境：三者全空，只剩 USERPROFILE
      LOCALAPPDATA: '', HOME: '', XDG_DATA_HOME: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  try {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && !/auth file/iu.test(output) && child.exitCode === null) {
      await new Promise((r) => setTimeout(r, 200));
    }
    const m = output.match(/auth file\s*:\s*(.+)/iu);
    assert.ok(m, `桥没打印 auth file 行，输出：\n${output.slice(-400)}`);
    const authPath = m[1].trim();
    assert.ok(
      /^[A-Za-z]:[\\/]|^\//u.test(authPath),
      `登录文件路径是**相对路径**（${authPath}）—— 它会按启动目录解析，`
      + '于是"桥找不到登录文件"会表现成"用户没登录"，而真凶是环境变量缺失。',
    );
  } finally {
    await new Promise((resolve) => {
      child.once('exit', resolve);
      child.kill();
      setTimeout(resolve, 3000);
    });
  }
});

test('登录文件选择：两个客户端的活动文件按最近写入选，登出快照不参与', async () => {
  /*
   * 与 config.mjs 同一条规则（桥不 import 它，只能靠用例守住）：
   * 只用国际版、或当前使用国际版时，不能被国内版的旧活动文件抢走；
   * 带时间戳的登出快照即使 mtime 最新也不能选。
   */
  const dir = mkdtempSync(join(tmpdir(), 'wb-bridge-authpick-'));
  const domestic = join(dir, 'workbuddy-desktop.info');
  const intl = join(dir, 'workbuddy-desktop-ai.info');
  const snapshot = join(dir, 'workbuddy-desktop.2026-01-01T00-00-00-000Z.1.abc.info');
  const now = Date.now();
  for (const file of [domestic, intl, snapshot]) writeFileSync(file, '{}');
  utimesSync(domestic, new Date(now - 60_000), new Date(now - 60_000));
  utimesSync(intl, new Date(now - 30_000), new Date(now - 30_000));
  utimesSync(snapshot, new Date(now), new Date(now));
  const env = {
    ...process.env,
    WORKBUDDY_PORT: String(pickBridgePort()),
    WORKBUDDY_LOCAL_TOKEN: TOKEN,
    WORKBUDDY_AUTH_DIR: dir,
    WORKBUDDY_AUTO_CHECKIN: '0',
  };
  delete env.WORKBUDDY_AUTH_FILE;
  const child = spawnTracked(process.execPath, [BRIDGE], { cwd: HERE, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  try {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && !/auth file/iu.test(output) && child.exitCode === null) {
      await new Promise((r) => setTimeout(r, 150));
    }
    const m = output.match(/auth file\s*:\s*(.+)/iu);
    assert.ok(m, `桥没打印 auth file 行，输出：\n${output.slice(-500)}`);
    assert.equal(m[1].trim(), intl, '应选最近写入的国际版活动文件，而不是国内版或快照');
  } finally {
    await new Promise((resolve) => {
      child.once('exit', resolve);
      child.kill();
      setTimeout(resolve, 3000);
    });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('桥源码里不再有裸 Number(process.env.*) 的数值读取（防止回退）', () => {
  /*
   * 规则写对了、但某处忘了改，是这个 bug 最可能的复发方式（本轮就是
   * config.mjs 修了、桥没修）。所以直接扫源码：**所有**数值型 env 读取
   * 都必须经过 numEnv()。
   *
   * 字符串/开关类（HOST / 版本号 / LOG 等）本来就不该走 numEnv，不在其列。
   */
  const src = readFileSync(BRIDGE, 'utf8');
  const offenders = [];
  for (const [i, line] of src.split(/\r?\n/).entries()) {
    // 只看代码：注释里会引用旧写法作对照（`Number(process.env.X || 默认)`），
    // 那是文档不是实现，不该被判为违规。
    const code = line.replace(/\/\/.*$/u, '');
    if (/^\s*\*|^\s*\/\*/u.test(line)) continue;
    for (const m of code.matchAll(/\bNumber\(\s*process\.env\.([A-Z0-9_]+)/gu)) {
      offenders.push(`${m[1]} (第 ${i + 1} 行)`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `这些 env 读取绕过了 numEnv()，非法值会变 NaN：${offenders.join(', ')}`,
  );
});

test('桥源码里不再有 spawnSync（取密钥 / DPAPI 必须异步，不能阻塞事件循环）', () => {
  /*
   * 冷路径的 spawnSync 会让**所有**在途流式响应停摆（PowerShell 最长 20s）。
   * 统一走 runChild() 的异步子进程；这里防止以后又在某个分支里写回同步版。
   */
  const src = readFileSync(BRIDGE, 'utf8');
  const offenders = [];
  for (const [i, line] of src.split(/\r?\n/).entries()) {
    const code = line.replace(/\/\/.*$/u, '');
    if (/\bspawnSync\s*\(/u.test(code)) offenders.push(i + 1);
  }
  assert.deepEqual(offenders, [], `这些行仍在同步起子进程：${offenders.join(', ')}`);
});

/**
 * 任何**起了桥进程**的测试都必须显式隔离账本。
 *
 * ## 为什么是"扫源码"而不是"跑一遍看有没有写脏"
 *
 * 后者测的是"当前这几个文件"，新增一个测试文件时它无效 —— 而漏掉隔离的
 * 恰恰是新增文件。扫源码能把**未来**的文件也覆盖住。
 *
 * ## 这条守的是什么（2026-10-13 实测的数据损失）
 *
 * `usageFile()` = `WORKBUDDY_USAGE_FILE`，否则退回**桥脚本所在目录**下的
 * `usage.jsonl` —— 也就是使用者的真实账本。它**与 cwd 无关**，所以测试里
 * 惯用的 `cwd: dir`（临时目录）根本挡不住。
 *
 * 实测后果：`bridge-responses.test.mjs` 一次运行就往真实账本写进 **36 行**
 * 测试记录（真实账本里累计 914 条 `resolved-default` + 58 条 `resolved-fast`
 * + 14 条 `stub-model`，占总量一半以上）。而账本到 `MAX_USAGE_LINES`(2000)
 * 会**截断保留最近一半** —— 等于把用户自己的用量历史挤掉。
 *
 * `bridge.test.mjs` / `bridge-startup.test.mjs` 早就设了这一项，
 * `bridge-responses.test.mjs` 与 `bridge-cors.test.mjs` 是漏的（已补）。
 */
test('起了桥进程的测试文件必须隔离账本（否则会写坏使用者的真实账本）', () => {
  const files = readdirSync(HERE).filter((f) => f.endsWith('.test.mjs'));
  const offenders = [];
  for (const f of files) {
    const src = readFileSync(join(HERE, f), 'utf8');
    // 只有"真的 spawn 了桥"的文件才需要隔离；纯逻辑用例不产生上游请求
    if (!/spawn\(\s*process\.execPath/u.test(src)) continue;
    /*
     * 判据必须看**赋值**，不能只搜名字。
     *
     * 第一版就是搜 `WORKBUDDY_USAGE_FILE` 这个字符串，结果把**注释里的解释**也算
     * 成"已隔离" —— 反证时（把赋值删掉、注释留着）守卫照样变绿，等于这条用例
     * 测不出它该测的东西。现在要求出现 `WORKBUDDY_USAGE_FILE:` 或
     * `WORKBUDDY_USAGE_FILE =` 这样真正的赋值形状。
     */
    if (!/WORKBUDDY_USAGE_FILE\s*[:=]/u.test(src)) offenders.push(f);
  }
  assert.deepEqual(
    offenders,
    [],
    `这些测试文件起了桥却没设 WORKBUDDY_USAGE_FILE，会往仓库 bridge/usage.jsonl `
    + `（使用者的真实账本）里写测试记录：${offenders.join(', ')}`,
  );
});

/**
 * 起桥的端口必须来自 `bridge-ports.mjs`，不能就地写死一个区间。
 *
 * ## 这条守的是 2026-10-27 那次发版门禁
 *
 * v1.17.0 的 `release-check` 在 ubuntu-latest 上挂在一条**和代码无关**的用例上：
 *
 *   Error: listen EADDRINUSE: address already in use 127.0.0.1:39846
 *     startBridge (bridge/bridge.test.mjs:131)
 *
 * 旧写法是 `20000 + Math.floor(Math.random() * 20000)` —— 这个区间**横跨 Linux 的
 * 临时端口段**（默认 32768–60999）。同一批测试里的打桩上游全都走 `listen(0)`，
 * 内核把它们分到同一段里，于是"随机挑的固定端口"迟早会等于"内核刚分给别人的端口"。
 * macOS 那次刚好没撞上，于是同一份代码一个平台红、一个平台绿。
 *
 * 更糟的是失败形态：`startBridge` 一抛错，用例的 `finally` 根本没轮到执行，
 * 打桩上游的 listen socket 留在测试进程上 → `node --test` 跑完全部用例**不退出**
 * → CI 只能按 `timeout-minutes` 取消 job。**一条 1 秒能看懂的端口撞车，
 * 被放大成 20 分钟 + 一条 cancelled。**
 *
 * ## 为什么扫源码而不是"跑一遍看看"
 *
 * 和上一条同理：撞车是概率事件，跑一遍很可能不撞 —— 那这条用例就永远绿。
 * 扫源码能把**以后新增的**测试文件一起管住。
 */
test('起桥的测试必须用 bridge-ports.mjs 取端口（不能落在临时端口段里）', () => {
  const files = readdirSync(HERE).filter((f) => f.endsWith('.test.mjs'));
  const offenders = [];
  for (const f of files) {
    const src = readFileSync(join(HERE, f), 'utf8');
    // 只有真的给桥指定端口（WORKBUDDY_PORT）才需要这条规则
    if (!/WORKBUDDY_PORT\s*[:=]/u.test(src)) continue;
    /*
     * 判据是「端口从哪来」，不是「赋值行长什么样」：
     * 各文件普遍写成 `const port = pickBridgePort()` 再由 `String(port)` 传下去，
     * 两段式是正常的。真正要拦住的是**自己算一个固定区间**：
     *
     *   const port = 20000 + Math.floor(Math.random() * 20000);   ← 就是它撞的车
     *
     * 所以查两件事：引了 pickBridgePort；且没有「数字 + Math.random()」这种算式。
     */
    if (!/pickBridgePort/u.test(src)) {
      offenders.push(`${f}（没引用 pickBridgePort）`);
      continue;
    }
    /*
     * 只看代码：本文件自己的注释里就引用了旧写法作对照（那是文档，不是实现），
     * 不剥掉的话守卫会被自己的说明文字判红。
     */
    for (const [i, line] of src.split(/\r?\n/).entries()) {
      if (/^\s*\*|^\s*\/\*/u.test(line)) continue;
      const code = line.replace(/\/\/.*$/u, '');
      for (const m of code.matchAll(/(\d{4,6})\s*\+\s*Math\.floor\(\s*Math\.random\(\)/gu)) {
        offenders.push(`${f}:${i + 1}（${m[1]} + Math.random()… 自己算端口）`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    '这些写法会把测试端口落进临时端口段（打桩上游用 listen(0) 被内核分到那里），'
    + `撞车后还会因为 finally 没跑到而挂住整个 node --test：${offenders.join('; ')}`,
  );
});

/**
 * 起桥的测试必须有**文件级收尾**（`test.after`），否则一次失败会挂住整个 job。
 *
 * 与上一条是一对：端口撞车是**诱因**，收尾缺失是**后果被放大成 20 分钟的原因**。
 * 只修端口不改收尾，下次换个原因（断言失败、超时、Ctrl-C）照样挂住。
 *
 * 判据只看"这个文件里有没有 test.after" —— 内容对不对是各文件自己的事
 * （它们各自要关的东西不同：桥进程、打桩上游、临时目录）。
 */
test('起桥的测试必须有 test.after 收尾（否则失败时 node --test 会挂住）', () => {
  const files = readdirSync(HERE).filter((f) => f.endsWith('.test.mjs'));
  const offenders = [];
  for (const f of files) {
    const src = readFileSync(join(HERE, f), 'utf8');
    if (!/spawn\(\s*process\.execPath/u.test(src)) continue;
    /*
     * 必须看真正的调用形状 `test.after(`，而不是注释里提到过 ——
     * 否则反证时（删掉钩子、注释留着）守卫照样变绿，等于什么都没测。
     */
    if (!/^test\.after\(/mu.test(src)) offenders.push(f);
  }
  assert.deepEqual(
    offenders,
    [],
    '这些测试文件起了子进程却没有 test.after：任一用例在 try 之前抛错（端口撞车、'
    + `桥起不来）时，监听 socket / 管道会留在测试进程上，node --test 跑完不退出：${offenders.join(', ')}`,
  );
});
