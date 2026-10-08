/**
 * i18n 表的**一致性**与**自检**（纯 Node，不需要浏览器）。
 *
 *   node --test dsh-plugin/tests/i18n-terms.test.mjs
 *
 * 为什么这些要单独钉住：插件面板（`dsh-plugin/lib/client.js`）与控制台
 * （`dashboard/public/index.html`）各自带一份 i18n 表 —— 本项目**零构建**，
 * 两个文件没法共享代码（控制台是直接给浏览器加载的 HTML）。
 * 于是「同一份东西存在两处」这件事只能靠测试守住，否则必然漂移：
 * 本会话就踩过一次（徽章词条在两张表里各有一份，改了一处忘了另一处）。
 *
 * 钉三件事：
 *   1. 两边 `I18N_TERMS_EN`（专有名词表）**逐条一致** —— 键与值都不能差；
 *   2. 词条表的**值里不能有中文** —— 半翻（`'X': 'English（中文）'`）是最难发现的一类；
 *   3. 名词表的**值里不能有中文**（同上）。
 *
 * 放在 `dsh-plugin/tests/` 是有意的：`npm run test:plugin` 的 glob 是唯一
 * 会跑「仓库级纯 Node 测试」的入口，不用改任何脚本就能进 CI。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 从源码里切出一个 `const X = {…}` / `[…]` 字面量并求值。 */
function evalBlock(src, marker) {
  const i = src.indexOf(marker);
  assert.notEqual(i, -1, `找不到 ${marker}`);
  const openIdx = src.indexOf(marker.includes('{') ? '{' : '[', i);
  const open = src[openIdx];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inStr = null;
  for (let k = openIdx; k < src.length; k += 1) {
    const c = src[k];
    if (inStr) {
      if (c === '\\') { k += 1; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { inStr = c; continue; }
    if (c === '/' && src[k + 1] === '/') { while (k < src.length && src[k] !== '\n') k += 1; continue; }
    if (c === open) depth += 1;
    else if (c === close) { depth -= 1; if (depth === 0) return src.slice(openIdx, k + 1); }
  }
  throw new Error(`切不出 ${marker} 的块`);
}

const PLUGIN = readFileSync(join(ROOT, 'dsh-plugin', 'lib', 'client.js'), 'utf8');
const CONSOLE = readFileSync(join(ROOT, 'dashboard', 'public', 'index.html'), 'utf8');

const CJK = /[\u4e00-\u9fff]/;

test('i18n：插件与控制台的专有名词表逐条一致', () => {
  const a = new Function(`return (${evalBlock(PLUGIN, 'const I18N_TERMS_EN = {')})`)();
  const b = new Function(`return (${evalBlock(CONSOLE, 'const I18N_TERMS_EN = {')})`)();

  const keysA = Object.keys(a).sort();
  const keysB = Object.keys(b).sort();
  assert.deepEqual(keysA, keysB,
    '两张名词表的**键**不一致 —— 上游新增一个促销词/套餐类型时，两边都要补\n'
    + `插件独有：${keysA.filter((k) => !keysB.includes(k)).join(', ') || '（无）'}\n`
    + `控制台独有：${keysB.filter((k) => !keysA.includes(k)).join(', ') || '（无）'}`);

  const diff = keysA.filter((k) => a[k] !== b[k]);
  assert.deepEqual(diff.map((k) => `${k}: 插件「${a[k]}」/ 控制台「${b[k]}」`), [],
    '名词表同名条目的**值**不一致');
});

test('i18n：词条表与名词表的**值**里不能有中文', () => {
  const bad = [];
  for (const [label, src] of [['插件', PLUGIN], ['控制台', CONSOLE]]) {
    for (const marker of ['const I18N_EN = {', 'const I18N_TERMS_EN = {']) {
      const obj = new Function(`return (${evalBlock(src, marker)})`)();
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v === 'string' && CJK.test(v)) bad.push(`${label} ${marker.includes('TERMS') ? '名词表' : '词条表'}：'${k}' → '${v}'`);
      }
    }
  }
  assert.deepEqual(bad, [],
    '译文里还留着中文 —— 典型的「半翻」（`\'X\': \'English（中文）\'`），\n'
    + '渲染扫描扫不到（它只查「有没有中文」，不查「比例」），只能在这里拦');
});
