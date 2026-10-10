/**
 * 令牌文件的权限加固用例。
 *
 *   node --test lib/config.token-perm.test.mjs
 *
 * 背景：令牌改成随机生成的**理由**是「旧默认值是公开口令，本机任何程序都能拿它
 * 调用桥」。但 `writeFileSync({ mode: 0o600 })` 的 `mode` 只在 POSIX 上有意义 ——
 * Windows 走 NTFS ACL，`mode` 基本被忽略。实测新建出来的文件继承目录权限，结果是
 * `Authenticated Users:(M)`（任何已认证用户可改）+ `Users:(RX)`（任何用户可读），
 * 也就是**同机任何用户都能读到令牌**，随机化被抵消掉一半。
 *
 * 这条用例只在 Windows 上跑（POSIX 上 `mode` 本来就生效，测的是另一套东西）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { hardenTokenFile } from '../config.mjs';

/**
 * 读文件的 ACL 文本。
 *
 * **`stdio[0]` 必须是 `'ignore'`**（或 `'inherit'`），否则在本机必抛 `EBUSY`。
 *
 * 这一条踩过两次，值得写清楚：原先写的是
 * `spawnSync('icacls', [file], { encoding: 'utf8', windowsHide: true })` ——
 * 默认 `stdio` 是三个 `'pipe'`，**stdin 也走管道**，于是每次调用都返回
 * `{ error: EBUSY, stdout: null }`。`stdout` 是 `null`，上面 `|| ''` 兜成空串，
 * 正则数出 0 条 ACE，用例就红在「加固后不该一条 ACE 都不剩」上 ——
 * 红的是环境，不是被测代码，而且报错信息完全指不到真正的原因。
 *
 * 实测（本机，同一进程里连续 22 次）：
 *   默认 stdio（stdin 管道）  → 22/22 失败
 *   `stdio[0]: 'ignore'`      → 0/22 失败
 * 也就是说，之前以为的「连打同一个可执行文件会 EBUSY」是**误判** ——
 * 真正的触发条件是那个 stdin 管道。产品侧 `hardenTokenFile()` 一直用的就是
 * `stdio: ['ignore', 'pipe', 'pipe']`，所以它从来没中过这个招。
 */
const acl = (file) => spawnSync('icacls', [file], {
  encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
}).stdout || '';

/**
 * 从 `icacls` 输出里数出**主体**（ACE）的名字。
 *
 * 两个坑：
 * ① 不能「按行切」—— 首行是「文件名 + 第一条 ACE」，末尾还有一行 **OEM 编码**的
 *    处理提示（UTF-8 下是乱码，按中文正则过滤不掉）；
 * ② 权限段可能是**多个括号**：继承来的 ACE 是 `:(I)(M)`，不是 `:(M)`。
 *    只匹配单个括号会让「未加固」的情况数出 0 条 —— 断言虽然还是红的，
 *    但红的原因变成了「正则没匹配上」，不是「条目数不对」，那就白测了。
 */
const aces = (text) => [...text.matchAll(/([^\s:()]+):((?:\([A-Z]+\))+)/g)].map((m) => m[1]);

test('令牌文件加固后，除当前用户外没有别的可读主体', {
  skip: process.platform !== 'win32' ? '仅 Windows（NTFS ACL）' : false,
}, (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-token-perm-'));
  const file = join(dir, '.bridge-token');
  try {
    writeFileSync(file, `${'x'.repeat(32)}\n`, { mode: 0o600 });
    const before = acl(file);

    const res = hardenTokenFile(file);
    const after = acl(file);

    /*
     * **icacls 根本起不来**（沙箱拦了、组策略禁用、PATH 里没有…）时，
     * 本机没有任何可断言的东西 —— 这时只要求函数**如实报告**，然后跳过。
     *
     * 判据必须精确到 `code === 'spawn-failed'`，不能写成「只要 ok 为假就跳过」：
     * 那样在「icacls 跑得起来但配置失败」的真实故障上也会跳过，
     * 等于把要防的回归放过去了。
     */
    if (res.code === 'spawn-failed') {
      assert.match(res.reason, /icacls/, '起不来时必须说清是 icacls 的问题，否则用户无从下手');
      t.skip(`本机跑不起 icacls（${res.reason}）—— 用户 ACL 断言无从验证`);
      return;
    }
    assert.equal(res.ok, true, `加固应当成功，却拿到：${JSON.stringify(res)}\n加固前：\n${before}`);

    /*
     * 断言「**剩下的 ACE 都属于安全集合**」，而不是「只剩一条」或「没有某个组名」。
     *
     * 三种写法各自的坑（前两种都踩过）：
     * ① 「不该有 Authenticated Users / Users」→ **假绿**：临时目录里继承到的主体
     *    根本没有这两个名字，不加修复也会通过。
     * ② 「必须只剩 1 条」→ **太严**：本机实测确实剩 1 条，但 CI 的 Windows runner
     *    上剩 3 条（runner 的用户名/继承关系不同），于是本地绿、CI 红。
     * ③ 现在这种：把 ACE 名字逐个拿出来，要求每个都在安全集合里 ——
     *    加固前那些 `CodexSandboxUsers`、裸 SID 会被挡下（有效），
     *    而 SYSTEM / Administrators / 当前用户怎么组合都通过（不受环境干扰）。
     */
    const left = aces(after);
    assert.ok(left.length > 0, `加固后不该一条 ACE 都不剩：\n${after}`);
    const user = (process.env.USERNAME || process.env.USER || '').toLowerCase();
    const allowed = (name) => {
      const n = name.toLowerCase();
      return n === user
        || n.endsWith(`\\${user}`)
        || n.includes('system')
        || n.includes('administrators')
        || n.includes('trustedinstaller'); // Windows 上某些目录会带上它，无害
    };
    const unexpected = left.filter((n) => !allowed(n));
    assert.deepEqual(
      unexpected, [],
      `加固后不该还留着这些主体：${unexpected.join(' | ')}\n全部 ACE：${left.join(' | ')}\n原始输出：\n${after}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/*
 * 加固**失败**时必须如实回报。
 *
 * 这条是冲着「静默失效」去的：`spawnSync` 失败**不抛异常** —— 它把失败塞进
 * `r.error` / `r.status` 返回来。原先的写法是 `try { spawnSync(...) } catch {}`，
 * 没看返回值，于是「icacls 没跑成」和「icacls 跑成了」在调用方看来完全一样：
 * 文件权限其实没收紧（同机任何用户仍能读到令牌），而没有任何地方会提到这件事。
 *
 * 用一个**不存在的路径**构造失败：这是真实故障（icacls 会以非 0 退出），
 * 不需要给 I/O 造替身，在任何机器上都不依赖具体环境。
 */
test('加固失败时如实回报，不静默吞掉', () => {
  const res = hardenTokenFile(join(tmpdir(), 'wb-definitely-not-here', '.bridge-token'));
  assert.equal(typeof res, 'object', '必须返回结果对象 —— 返回 undefined 就说明失败被吞了');
  assert.equal(res.ok, false);
  assert.equal(typeof res.reason, 'string');
  assert.ok(res.reason.length > 0, '要说清楚为什么没成功，否则用户无从下手');
  assert.equal(typeof res.code, 'string', 'code 供调用方判别（用例要区分「起不来」和「跑失败」）');
});

