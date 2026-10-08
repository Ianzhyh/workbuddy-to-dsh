/**
 * 无头 UI 测试的统一入口。
 *
 *   node tools/dev/run-ui-tests.mjs            # 跑全部
 *   node tools/dev/run-ui-tests.mjs i18n r9    # 只跑名字含 i18n / r9 的
 *
 * ## 为什么需要它
 *
 * `tools/dev/` 下有一批 `test-*.mjs`，各自起静态服务 + 无头 Chromium + 打桩，
 * 谁都跑得动、但**没有统一入口**。后果是实测出来的：有一批早期脚本因为形状表
 * 变严，在 `openPage` 的桩校验处就抛错，**根本没跑到断言** —— 而且很久没人发现。
 * 验收面悄悄烂掉一大块，比某个用例失败危险得多。
 *
 * 所以这里做两件事：**统一跑** + **失败时把每个脚本的尾部输出打出来**
 * （不然只会看到一堆「某个脚本挂了」，还得一个个手工复现）。
 *
 * ## 只跑「打桩型」用例
 *
 * 判据是**是否 import `./ui-harness.mjs`** —— 那是打桩骨架。不 import 它的脚本
 * （`test-bridge-*` / `test-console-ui` / `test-probe-lastrun` 等）需要**真的**
 * 起一个桥或控制台，属于人工/集成走查，不在这里跑（跑了会占用端口、消耗上游额度）。
 *
 * ## 为什么用 spawnSync
 *
 * 这台机器上 `execSync` / `execFileSync` 会抛 `EBUSY`（见项目记忆），
 * 所以一律 `spawnSync` + `stdio: ['ignore','pipe','pipe']`。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');

const filters = process.argv.slice(2);

/** 打桩型用例：import 了 ui-harness 的 test-*.mjs。 */
function discover() {
  return readdirSync(HERE)
    .filter((f) => /^test-.*\.mjs$/.test(f))
    .filter((f) => readFileSync(join(HERE, f), 'utf8').includes("'./ui-harness.mjs'"))
    .filter((f) => !filters.length || filters.some((k) => f.includes(k)))
    .sort();
}

const files = discover();
if (!files.length) {
  console.error('没有匹配的用例（判据：import ./ui-harness.mjs 的 test-*.mjs）');
  process.exit(1);
}

console.log(`打桩型 UI 用例 ${files.length} 个：\n`);

const results = [];
for (const f of files) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [join(HERE, f)], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 180000,
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const ok = r.status === 0;
  results.push({ f, ok, out, secs });
  console.log(`${ok ? '✓' : '✗'} ${f.replace(/\.mjs$/, '').padEnd(28)} ${secs}s`);
}

const failed = results.filter((r) => !r.ok);

if (failed.length) {
  console.log('\n' + '─'.repeat(72));
  for (const r of failed) {
    console.log(`\n✗ ${r.f} —— 尾部输出：\n`);
    const lines = r.out.trim().split('\n');
    console.log(lines.slice(-18).map((l) => '   ' + l).join('\n'));
  }
}

console.log('\n' + '─'.repeat(72));
console.log(`通过 ${results.length - failed.length} / ${results.length}`);
if (failed.length) {
  console.log(`失败：${failed.map((r) => r.f.replace(/\.mjs$/, '')).join(', ')}`);
  process.exit(1);
}
console.log('全部通过');
