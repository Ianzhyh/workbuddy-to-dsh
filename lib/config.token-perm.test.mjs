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
     * 断言「**只剩当前用户一条 ACE**」，而不是「没有某个特定组名」。
     *
     * 为什么：第一版写的是「不该有 Authenticated Users / Users」—— 结果**假绿**。
     * 临时目录里新建的文件继承到的是 `CodexSandboxUsers:(M)`、一个裸 SID、SYSTEM、
     * Administrators、当前用户，**根本没有那两个名字**，所以不加修复也会通过。
     * 只有数 ACE 条目数才能真的区分「收紧了」和「没收紧」。
     */
    const left = aces(after);
    assert.equal(
      left.length, 1,
      `加固后应当只剩当前用户一条 ACE，实际 ${left.length} 条：${left.join(' | ')}\n原始输出：\n${after}`,
    );
    const user = process.env.USERNAME || process.env.USER || '';
    assert.ok(
      user && left[0].includes(user),
      `剩下的应当是当前用户 ${user}，实际：${left[0]}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
