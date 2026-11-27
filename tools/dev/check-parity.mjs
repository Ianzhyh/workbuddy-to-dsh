/**
 * 插件面板 ⇄ 控制台 功能对照检查。
 *
 * ## 为什么需要它
 *
 * 用户原话：「两边插件面板进度要同步，不然万一漏了」。
 * 这一轮我确实漏了：自动换号开关先加在右栏，设置页的账号标签完全没有；
 * 余额也一样。靠人记"两边都要改"必然会漏 —— 所以把它变成可执行的检查。
 *
 * ## 判据
 *
 * 读 `parity.json`：每一项列出两边的实现痕迹（文件 + 若干标记字符串）。
 * 缺任何一边就报错，并指出缺的是哪边、期望在哪个文件里找到什么。
 *
 * `intentional` 的项只检查**有实现的那一边**（另一边是刻意不做，理由写在清单里）。
 *
 * 这不是功能测试 —— 它只保证"两边都没有被忘掉"。功能正确性由各自的用例负责。
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');

const manifest = JSON.parse(readFileSync(join(HERE, 'parity.json'), 'utf8'));

/** 读文件内容；不存在返回 null。 */
function readIfExists(rel) {
  const p = join(ROOT, rel);
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
}

const problems = [];
let checked = 0;

for (const item of manifest.features) {
  const name = item.name || '(未命名)';

  /** 检查一侧：文件存在且所有标记都在。 */
  const checkSide = (side, spec, sideLabel) => {
    if (!spec) return;
    const text = readIfExists(spec.file);
    if (text === null) {
      problems.push(`${name}：${sideLabel} 的文件不存在 —— ${spec.file}`);
      return;
    }
    const missing = (spec.markers || []).filter((m) => !text.includes(m));
    if (missing.length) {
      problems.push(
        `${name}：${sideLabel} 缺少实现痕迹 —— ${spec.file} 里找不到 ${missing.map((m) => JSON.stringify(m)).join('、')}`,
      );
    }
  };

  /* intentional：只验存在的那一边 */
  if (item.intentional) {
    const side = item.plugin ? 'plugin' : 'console';
    checkSide(side, item[side], side);
    checked += 1;
    continue;
  }

  checkSide('plugin', item.plugin, '插件面板');
  checkSide('console', item.console, '控制台');
  if (item.shared) checkSide('shared', item.shared, '共享模块');
  checked += 1;
}

if (problems.length) {
  console.error(`✘ 插件面板与控制台不同步（检查了 ${checked} 项）：\n`);
  for (const p of problems) console.error('  · ' + p);
  console.error('\n改完任一边都要同步另一边；确实不该同步的，在 tools/dev/parity.json 里加 intentional 并写清理由。');
  process.exit(1);
}

console.log(`✅ 插件面板与控制台已同步（${checked} 项功能对照通过）`);
