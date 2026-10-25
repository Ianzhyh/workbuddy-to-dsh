/**
 * 打包完整性门禁：**入口及其递归 import 的本地文件，必须都在 package.json `files` 里**。
 *
 *   node tools/dev/check-package-files.mjs
 *
 * ## 为什么需要它
 *
 * `files` 是一份白名单。`bridge/workbuddy-bridge.mjs` 静态 import `./miora-video.mjs`，
 * 但只要漏写这一条，`npm pack` 就会打出一个**缺模块**的包：从 npm 安装后
 * `detectProjectRoot()` 会选中根目录的 `bridge/`（因为它看到了 workbuddy-bridge.mjs），
 * 桥一启动就 `ERR_MODULE_NOT_FOUND`。本地跑仓库永远不红 —— 因为文件就在那儿。
 *
 * `verify:standalone` 验的是插件自带的 vendor 快照，`verify:release` 验的是插件 tgz，
 * 都覆盖不到根包 `files` 这一层，所以单独做这个检查并接进 `release:check`。
 *
 * 覆盖范围：根包入口（package.json `main`）+ 会被独立拉起的进程脚本（桥 / 启动器 /
 * 控制台）。**不**遍历测试文件与 `dsh-plugin/vendor`（它们是快照，另有 vendor:check）。
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

/** 会被用户实际拉起的入口：根包 main + 桥 / 启动器 / 控制台。 */
const ENTRIES = [
  pkg.main,
  'bridge/workbuddy-bridge.mjs',
  'bridge/launch.mjs',
  'dashboard/server.mjs',
].filter(Boolean);

const FILES = (pkg.files || []).map((entry) => String(entry).replace(/\\/g, '/').replace(/^\.\//, ''));

const toPosix = (value) => value.split('\\').join('/').replace(/^\.\//, '');

/** npm `files` 语义的简化版：精确文件、目录前缀、以及 `*` / `**` 通配。 */
function coveredByFiles(relPath) {
  return FILES.some((entry) => {
    const clean = entry.replace(/\/+$/, '');
    if (clean === relPath) return true;
    if (clean.includes('*')) {
      const pattern = clean
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*/g, '\u0000')
        .replace(/\*/g, '[^/]*')
        .replace(/\u0000/g, '.*');
      return new RegExp(`^${pattern}$`).test(relPath);
    }
    const abs = join(ROOT, clean);
    if (existsSync(abs) && statSync(abs).isDirectory()) return relPath.startsWith(`${clean}/`);
    return false;
  });
}

/* `from './x'` / `import './x'` / `import('./x')` -- 只看相对路径。 */
const IMPORT_RE = /(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g;

const queue = [...new Set(ENTRIES.map(toPosix))];
const seen = new Set();
const missingInFiles = new Set();
const brokenImports = new Set();

while (queue.length) {
  const relPath = queue.shift();
  if (seen.has(relPath)) continue;
  seen.add(relPath);

  if (!coveredByFiles(relPath)) missingInFiles.add(relPath);

  const abs = join(ROOT, relPath);
  if (!existsSync(abs)) {
    brokenImports.add(relPath);
    continue;
  }
  if (!['.mjs', '.js', '.cjs'].includes(extname(relPath))) continue;

  const source = readFileSync(abs, 'utf8');
  for (const match of source.matchAll(IMPORT_RE)) {
    const target = resolve(dirname(abs), match[1]);
    if (!target.startsWith(ROOT)) continue; // 仓库外的引用不归 files 管
    const targetRel = toPosix(relative(ROOT, target));
    if (targetRel.startsWith('node_modules/')) continue;
    if (!existsSync(target)) {
      brokenImports.add(`${relPath} → ${targetRel}`);
      continue;
    }
    queue.push(targetRel);
  }
}

let failures = 0;
const bad = (message) => { console.error(`✗ ${message}`); failures += 1; };

console.log(`入口 ${ENTRIES.length} 个，递归检查 ${seen.size} 个本地文件\n`);
if (brokenImports.size) {
  for (const item of brokenImports) bad(`import 指向不存在的文件：${item}`);
}
if (missingInFiles.size) {
  for (const item of missingInFiles) bad(`不在 package.json files 里：${item}`);
}
if (!brokenImports.size && !missingInFiles.size) {
  console.log(`✓ 入口与依赖都在 files 白名单内（${FILES.length} 条）`);
}
console.log(failures ? `\n✗ 失败 ${failures} 项` : '\n✓ 打包完整性检查通过');
process.exit(failures ? 1 : 0);
