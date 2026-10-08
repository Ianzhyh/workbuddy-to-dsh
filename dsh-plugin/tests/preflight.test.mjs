/**
 * 环境自检脚本（scripts/preflight.mjs）的健壮性测试。
 *
 * 为什么这一层要单独钉住：preflight 是**新机器上装好之后第一个要跑的东西**，
 * 它的全部价值就是"在还没跑通的时候告诉你为什么"。而它曾经在最需要它的那两个
 * 场景里直接抛未捕获异常（Node 堆栈 + 退出码 1），把用户挡在门外：
 *
 *   1. `WORKBUDDY_AUTH_FILE` 指向的文件**不存在**（路径写错 / 文件被删 / 换了账号）
 *      —— 旧实现在 `if (active)` 里直接 readFileSync，没有先判存在。
 *      这是实测出来的：把 exe 与登录文件都指到不存在的路径，preflight 崩溃。
 *   2. `WORKBUDDY_AUTH_DIR` 指向的目录不存在 —— 这条本来就处理了，一并钉住，
 *      免得以后重构时把两条分支合并错。
 *
 * 断言的重点不是"输出了什么文案"，而是**它必须能跑完并给出可读结论**：
 *   - 进程必须正常退出（不能是 uncaughtException / 非 0 的崩溃码）
 *   - 必须把问题作为一条检查项报出来（含"修法"），而不是抛堆栈
 *
 * ## 为什么断言 "没有堆栈痕迹" 而不是断言具体文案
 *
 * 文案是产品措辞、会变；而"自检脚本自己崩了"是结构性缺陷、不该再发生。
 * 所以这里钉的是行为边界（不崩 + 给出可读结论），文案只做弱匹配。
 *
 *   node --test dsh-plugin/tests/preflight.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const PREFLIGHT = join(PLUGIN_DIR, 'scripts', 'preflight.mjs');

/** 在一个隔离的临时目录里跑 preflight，注入指定的环境变量。 */
function runPreflight(extraEnv) {
  const sandbox = mkdtempSync(join(tmpdir(), 'wb-preflight-'));
  try {
    const env = { ...process.env, ...extraEnv };
    // 端口指到高位空闲端口，避免与"本机正在跑的真桥/真控制台"互相干扰 ——
    // 那会让这个测试的结论取决于运行环境，而不是被测代码。
    env.WORKBUDDY_PORT = '18896';
    env.DASHBOARD_PORT = '18898';
    const r = spawnSync(process.execPath, [PREFLIGHT], {
      cwd: PLUGIN_DIR,
      env,
      encoding: 'utf8',
      timeout: 60000,
      /**
       * **必须显式给 `stdio`。**
       *
       * Windows 上 `spawnSync` 默认会为子进程的 stdin 打开管道，而在这台机器上
       * 那样做直接 `EBUSY`：进程根本没起来，`stdout` 是空串、`status` 是 `null`，
       * 于是断言全部失败并**误报成「preflight 没有输出」**——查了半天脚本，
       * 其实脚本是好的，是测试自己没跑起来。
       *
       * 这与桥启动 Electron 用的是同一条约定（见 docs/TROUBLESHOOTING.md
       * 「Node 子进程相关」）：`stdio: ['ignore','pipe','pipe']`。
       */
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ...r, stdout: r.stdout || '', stderr: r.stderr || '' };
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

/** Node 崩溃时会在 stderr 打这个；它出现就说明"自检脚本自己炸了"。 */
const CRASH_MARKERS = [/^node:.+:\d+/m, /^\s+at .+:\d+:\d+\)?$/m, /Uncaught|ERR_UNHANDLED|ENOENT: no such file or directory/];

function assertNoCrash(r, label) {
  const combined = `${r.stdout}\n${r.stderr}`;
  const hit = CRASH_MARKERS.find((re) => re.test(combined));
  assert.equal(hit, undefined,
    `${label}：自检脚本不应以未捕获异常结束，但输出里出现了崩溃痕迹 ${hit}\n` +
    `--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`);
  // 被信号杀死（未捕获异常在 Node 里通常是 1，signal 则是另一回事）
  assert.equal(r.signal, null, `${label}：进程被信号 ${r.signal} 终止，属于崩溃`);
}

test('preflight：登录文件路径不存在时，必须给出可读结论而不是崩溃', async () => {
  /*
   * 造一个**真实存在**的登录目录，再把 WORKBUDDY_AUTH_FILE 指到里面一个不存在的
   * 文件 —— 这样命中的必然是「指定的文件不存在」那条分支。
   *
   * 为什么必须自己造目录：原来的写法只把 WORKBUDDY_AUTH_DIR 清空，指望 preflight
   * 的候选列表回落到**本机真实的**登录目录。于是这条测试的结论取决于
   * 「跑测试的机器装没装 WorkBuddy」：装了才走文件分支，没装就落到
   * 「找不到登录目录」分支，而那条消息里没有 `不存在`，断言直接失败。
   *
   * 实测表现是最难查的那种：单独跑 `node --test preflight.test.mjs` 是绿的，
   * 跑全套 `test:plugin` 就红（沙箱里读不到用户目录）。本文件自己的注释就写着
   * 「不该让结论取决于运行环境」—— 这里把它落到实处。
   */
  const authDir = mkdtempSync(join(tmpdir(), 'wb-preflight-auth-'));
  try {
    const r = runPreflight({
      WORKBUDDY_AUTH_DIR: authDir,
      WORKBUDDY_AUTH_FILE: join(authDir, 'no-such-auth.info'),
    });

    assertNoCrash(r, '登录文件不存在');

    // 必须把这件事报成一条检查项，并且带上"修法"（这是 preflight 的契约）
    assert.match(r.stdout, /登录文件/, '应当报告登录文件这一项');
    assert.match(r.stdout, /不存在|ENOENT/, '应当说明文件不存在');
    assert.match(r.stdout, /修法/, '应当给出可操作的修法');

    // 有 bad 项 → 退出码 1（这是脚本既有的契约，不能因为不崩了就变成 0）
    assert.equal(r.status, 1, '存在 bad 项时应以退出码 1 结束');
  } finally {
    rmSync(authDir, { recursive: true, force: true });
  }
});

test('preflight：登录目录整体不存在时也不崩（真实目录解析不到的场景）', async () => {
  // 这一条与上面那条测的是**不同分支**：上面那条是"用户指定的文件不存在"，
  // 这条是"连登录目录都找不到"（全新机器、还没装客户端）。
  //
  // 隔离难点：preflight 的 authDirs 是**候选列表**，`find()` 会跳过不存在的项
  // 继续往下找，而它的第三个候选是 `join(homedir(), 'AppData', ...)` —— 直指
  // 真实路径，环境变量改不掉（homedir 读 USERPROFILE，改它会影响 Node 自身）。
  // 所以在"装了客户端"的机器上没法真正构造出这个场景。
  //
  // 与其用一堆环境变量把测试写成"看起来隔离、其实仍读到真实目录"（那是自欺），
  // 这里只断言**它不会崩**这一件事 —— 这正是本文件存在的意义（preflight 曾经在
  // 这条路径上抛未捕获异常）。分支是否真的被命中，由上面那条测试保证。
  const sandbox = mkdtempSync(join(tmpdir(), 'wb-preflight-home-'));
  try {
    const r = spawnSync(process.execPath, [PREFLIGHT], {
      cwd: PLUGIN_DIR,
      env: {
        ...process.env,
        WORKBUDDY_AUTH_FILE: '',
        WORKBUDDY_AUTH_DIR: join(sandbox, 'no-such-auth-dir'),
        WORKBUDDY_PORT: '18896',
        DASHBOARD_PORT: '18898',
      },
      encoding: 'utf8',
      timeout: 60000,
      // 不给 stdio 就会 EBUSY（原因见上面 runPreflight 的注释）
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = r.stdout || '';
    assertNoCrash({ ...r, stdout, stderr: r.stderr || '' }, '登录目录不存在');
    assert.match(stdout, /登录文件/, '应当报告登录文件这一项');
    // 退出码取决于是否解析到了真实目录，因此**不断言**它 —— 断言了就变成
    // "依赖跑测试这台机器的环境"，那种测试在 CI 上会时红时绿。
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test('preflight：--json 模式下上述两种情况也必须产出合法 JSON（供脚本消费）', async () => {
  const r = spawnSync(process.execPath, [PREFLIGHT, '--json'], {
    cwd: PLUGIN_DIR,
    env: {
      ...process.env,
      WORKBUDDY_AUTH_FILE: join(tmpdir(), 'wb-no-such-dir-xyz', 'no-such-auth.info'),
      WORKBUDDY_AUTH_DIR: '',
      WORKBUDDY_PORT: '18896',
      DASHBOARD_PORT: '18898',
    },
    encoding: 'utf8',
    timeout: 60000,
    // 不给 stdio 就会 EBUSY（原因见上面 runPreflight 的注释）
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = r.stdout || '';
  assertNoCrash({ ...r, stdout, stderr: r.stderr || '' }, '--json 模式');

  // --json 的契约：stdout 必须是**能被解析的 JSON**（退出码 1 表示有 bad 项，
  // 但那不该污染 stdout —— 消费方按退出码判断，不按 JSON 内容猜）。
  let parsed;
  assert.doesNotThrow(() => { parsed = JSON.parse(stdout); },
    `--json 的 stdout 必须是合法 JSON，实际：\n${stdout.slice(0, 400)}`);
  assert.ok(Array.isArray(parsed) || typeof parsed === 'object', 'JSON 应当是数组或对象');
});
