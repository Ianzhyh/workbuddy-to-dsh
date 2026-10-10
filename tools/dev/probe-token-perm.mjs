/**
 * 探针：令牌文件加固前后的 ACL 到底长什么样。
 *
 *   node tools/dev/probe-token-perm.mjs
 *
 * `lib/config.token-perm.test.mjs` 的断言失败时用它看**原始 icacls 输出** ——
 * 用例里的正则是为了在多种环境下都能数对 ACE 才写成那样的，
 * 输出里到底有什么，只有把原文打出来才知道。
 */
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { hardenTokenFile } from '../../config.mjs';

const dir = mkdtempSync(join(tmpdir(), 'wb-token-probe-'));
const file = join(dir, '.bridge-token');
writeFileSync(file, `${'x'.repeat(32)}\n`, { mode: 0o600 });

const run = (args) => {
  // `stdio[0]` 必须是 `'ignore'`：默认三个 `'pipe'` 时 stdin 也走管道，
  // 在本机每次 spawnSync 都返回 `{ error: EBUSY }`，探针只会打出一片空。
  const r = spawnSync('icacls', args, {
    encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  return `status=${r.status} error=${r.error?.code ?? '(none)'}\n${r.stdout ?? '(stdout null)'}`;
};

console.log('平台      :', process.platform);
console.log('USERNAME  :', JSON.stringify(process.env.USERNAME));
console.log('USER      :', JSON.stringify(process.env.USER));
console.log('\n=== 加固前 icacls ===\n' + run([file]));

hardenTokenFile(file);
console.log('\n=== 加固后 icacls ===\n' + run([file]));

console.log('\n=== 文件还在吗 ===', existsSync(file));
rmSync(dir, { recursive: true, force: true });
