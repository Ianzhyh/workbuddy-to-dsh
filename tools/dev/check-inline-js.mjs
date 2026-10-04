/**
 * 把 dashboard/public/index.html 里的内联 <script> 抽出来做语法检查。
 *
 * 页面是单文件、无构建步骤的，没有 lint 兜底；改完前端后跑一下这个，
 * 比等到浏览器里报 SyntaxError 再回头找要快。
 *
 *   node tools/dev/check-inline-js.mjs
 */
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const htmlPath = join(root, 'dashboard', 'public', 'index.html');
const html = readFileSync(htmlPath, 'utf8');

const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
if (!blocks.length) {
  console.error('未找到内联 <script>');
  process.exit(1);
}

let failed = 0;
blocks.forEach((code, i) => {
  const tmp = join(root, 'dashboard', 'public', `.check-${i}.mjs`);
  writeFileSync(tmp, code, 'utf8');
  try {
    const r = spawnSync(process.execPath, ['--check', tmp], {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      windowsHide: true,
    });
    if (r.status !== 0) {
      failed += 1;
      console.error(`内联脚本 #${i} 语法错误：\n${r.stderr}`);
    }
  } finally {
    try { unlinkSync(tmp); } catch { /* 已经没了 */ }
  }
});

if (failed) process.exit(1);
console.log(`内联脚本语法检查通过（${blocks.length} 段，共 ${html.length} 字符）`);
