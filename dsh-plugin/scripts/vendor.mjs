/**
 * 把仓库里的桥 / 控制台 / 共享库复制进插件，做成**自带一切**的独立包。
 *
 *   node dsh-plugin/scripts/vendor.mjs           # 生成/更新 vendor/
 *   node dsh-plugin/scripts/vendor.mjs --check   # 只校验是否与仓库同步（CI 用）
 *
 * 为什么要有这一步：插件本身只有宿主端/客户端两半，真正干活的是
 *   bridge/workbuddy-bridge.mjs（桥）
 *   dashboard/server.mjs + dashboard/public（数据控制台）
 *   config.mjs + lib/*.mjs（两者共用）
 * 这几样在仓库里是同级目录。把插件单独拷给别人时它们就找不到了 —— 于是把它们
 * 按同样的相对布局复制进 dsh-plugin/vendor/，插件把这个目录当作 projectRoot，
 * 一个文件夹就能跑（config.mjs 以自身位置为根，所以 .env/.state.json/日志
 * 全都落在 vendor/ 里，不会污染别处）。
 *
 * 优先顺序（见 lib/index.js 的 detectProjectRoot）：仓库检出目录**优先**，
 * vendor 只是"找不到仓库时"的后备 —— 这样本机开发时改 bridge 立刻生效，
 * 分发出去的单文件夹也能独立工作。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = dirname(HERE);
const REPO_ROOT = dirname(PLUGIN_DIR);
const VENDOR_DIR = join(PLUGIN_DIR, 'vendor');
const checkOnly = process.argv.includes('--check');

/** 要复制的东西：目标相对路径 → 源相对仓库根。目录会递归拷贝。 */
const ENTRIES = [
  ['bridge', 'bridge'],
  ['dashboard', 'dashboard'],
  ['config.mjs', 'config.mjs'],
  ['lib', 'lib'],
  ['LICENSE', 'LICENSE'],
  ['NOTICE.md', 'NOTICE.md'],
  ['.env.example', '.env.example'],
];

/**
 * 明确不复制的东西：**运行期数据**与备份。
 *
 * `usage.jsonl` 是本地用量账本（含用户每次调用的时间/模型/token），
 * `bridge.log` / `console.log` 是日志，`.state.json` 是状态 —— 这些属于使用者本人，
 * 绝不能进分发包（`npm pack` 会把它一起发出去，等于泄漏使用记录）。
 */
const SKIP = [
  /\.log$/i,
  /\.jsonl$/i,          // 用量账本
  /\.bak($|-)/i,        // 备份（index.html.bak 之类）
  /^\.state\.json$/i,
  /^\.env$/i,           // 使用者自己的配置（发 .env.example 就够）
  /^node_modules$/,
  /^\.backup$/,
  /^\.trae$/,
  /^\.workbuddy-ai$/,
  /^__pycache__$/,
  /^\.tmp-/,
];

function walk(base, rel, out) {
  const abs = join(base, rel);
  const stat = statSync(abs);
  if (stat.isDirectory()) {
    for (const name of readdirSync(abs)) {
      if (SKIP.some((re) => re.test(name))) continue;
      walk(base, join(rel, name), out);
    }
    return out;
  }
  if (SKIP.some((re) => re.test(rel.split(/[\\/]/).pop()))) return out;
  out.push({ rel, abs, size: stat.size });
  return out;
}

if (!existsSync(join(REPO_ROOT, 'bridge', 'workbuddy-bridge.mjs'))) {
  console.error(`✖ 这个脚本要在仓库里运行：${REPO_ROOT} 下找不到 bridge/workbuddy-bridge.mjs`);
  process.exit(1);
}

const files = [];
for (const [destRel, srcRel] of ENTRIES) {
  const src = join(REPO_ROOT, srcRel);
  if (!existsSync(src)) {
    console.warn(`• 跳过（仓库里没有）：${srcRel}`);
    continue;
  }
  const found = walk(REPO_ROOT, srcRel, []).map((f) => ({ ...f, destRel: join(destRel, relative(srcRel, f.rel) || '') }));
  files.push(...found);
}

let bytes = 0;
const stale = [];
const expected = new Set();
for (const file of files) {
  const dest = join(VENDOR_DIR, file.destRel);
  expected.add(dest.toLowerCase());
  const buf = readFileSync(file.abs);
  bytes += buf.length;
  const same = existsSync(dest) && readFileSync(dest).equals(buf);
  if (!same) stale.push(file.destRel);
  if (checkOnly) continue;
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, buf);
}

/** 删掉 vendor/ 里"不该在"的文件：运行期数据（账本/日志/状态）与上一次遗留的旧文件。 */
function prune(dir) {
  const removed = [];
  if (!existsSync(dir)) return removed;
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    const rel = relative(VENDOR_DIR, abs);
    if (SKIP.some((re) => re.test(name))) {
      rmSync(abs, { recursive: true, force: true });
      removed.push(rel);
      continue;
    }
    if (statSync(abs).isDirectory()) { removed.push(...prune(abs)); continue; }
    if (!expected.has(abs.toLowerCase())) { rmSync(abs, { force: true }); removed.push(rel); }
  }
  return removed;
}
const pruned = checkOnly ? [] : prune(VENDOR_DIR);

if (checkOnly) {
  if (stale.length) {
    console.error(`✖ vendor/ 与仓库不同步，共 ${stale.length} 个文件需要更新：`);
    for (const f of stale.slice(0, 20)) console.error(`   ${f}`);
    console.error('   运行：node dsh-plugin/scripts/vendor.mjs');
    process.exit(1);
  }
  console.log(`✅ vendor/ 与仓库一致（${files.length} 个文件，${(bytes / 1024).toFixed(0)} KB）`);
  process.exit(0);
}

console.log(`✅ 已生成 ${VENDOR_DIR}`);
console.log(`   ${files.length} 个文件，${(bytes / 1024).toFixed(0)} KB（本次更新 ${stale.length} 个）`);
if (pruned.length) {
  console.log(`   清理掉 ${pruned.length} 个不该在分发件里的文件（运行期数据/旧文件）：`);
  for (const f of pruned.slice(0, 10)) console.log(`   · ${f}`);
}
for (const f of files.filter((x) => /(bridge|server\.mjs|index\.html|config\.mjs)$/.test(x.destRel))) {
  console.log(`   · ${f.destRel}  ${(f.size / 1024).toFixed(0)} KB`);
}
console.log(`
下一步：
  · 本机开发：不用管 vendor/ —— 插件会优先用仓库检出目录，改完立刻生效。
  · 分发给别人：把整个 dsh-plugin/ 文件夹（含 vendor/）拷过去，或
      cd dsh-plugin && npm pack        # 生成 dsh-plugin-workbuddy-<版本>.tgz
    对方用 dsh 的插件安装功能指向该文件夹 / tgz 即可。
  · 提醒：vendor/ 是快照。仓库里的 bridge/dashboard/lib 改动后要重新跑一次本脚本
    （npm run vendor），CI/发布前用 npm run vendor:check 校验同步。`);
