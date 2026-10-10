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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BRIDGE = join(HERE, '..', 'bridge', 'workbuddy-bridge.mjs');
const TOKEN = 'test-token-badport-0123456789';

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
  assert.equal(parsePort(''), 8790, '空串视为未设置');
});

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

  const child = spawn(process.execPath, [BRIDGE], {
    cwd: dir,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      WORKBUDDY_HOST: '127.0.0.1',
      WORKBUDDY_PORT: '879O', // ← 字母 O：旧写法得到 NaN
      WORKBUDDY_LOCAL_TOKEN: TOKEN,
      WORKBUDDY_AUTH_FILE: authFile,
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
  const child = spawn(process.execPath, [BRIDGE], {
    cwd: HERE,
    env: {
      ...process.env,
      WORKBUDDY_PORT: String(20000 + Math.floor(Math.random() * 20000)),
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
