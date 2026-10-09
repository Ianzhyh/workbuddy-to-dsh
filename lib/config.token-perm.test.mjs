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

/** 读文件的 ACL 文本。 */
const acl = (file) => spawnSync('icacls', [file], { encoding: 'utf8', windowsHide: true }).stdout || '';

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
}, () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-token-perm-'));
  const file = join(dir, '.bridge-token');
  try {
    writeFileSync(file, `${'x'.repeat(32)}\n`, { mode: 0o600 });
    const before = acl(file);

    hardenTokenFile(file);
    const after = acl(file);

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
