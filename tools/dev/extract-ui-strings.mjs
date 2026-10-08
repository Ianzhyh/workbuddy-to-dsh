// 一次性辅助脚本：从 dashboard/public/index.html 里抽出「需要翻译的 UI 文案」候选，
// 用于人工/半自动构建 i18n 词条表。产出为去重后的列表（含出现次数与首个行号）。
//
// 抽三类来源：
//   1. JS 里的字符串字面量（单引号 / 双引号 / 模板字面量）
//   2. HTML 文本节点（> ... < 之间的可见文字）
//   3. 关键属性值（title / placeholder / aria-label / alt）
// 过滤：纯注释行（// 与 * 开头）、纯代码行。
//
// 用法：node tools/dev/extract-ui-strings.mjs [--json]
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const file = join(here, '..', '..', 'dashboard', 'public', 'index.html');
const src = readFileSync(file, 'utf8');
const lines = src.split('\n');

const CJK = /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/;
const hits = new Map(); // text -> { count, firstLine, kinds:Set }

function add(text, line, kind) {
  const t = String(text).replace(/\s+/g, ' ').trim();
  if (!t || !CJK.test(t)) return;
  if (!hits.has(t)) hits.set(t, { count: 0, firstLine: line, kinds: new Set() });
  const e = hits.get(t);
  e.count += 1;
  e.kinds.add(kind);
}

lines.forEach((raw, i) => {
  const lineNo = i + 1;
  const trimmed = raw.trim();
  const isComment = /^(\/\/|\*|\/\*)/.test(trimmed);
  if (isComment) return;

  // 1) 字符串字面量
  for (const m of raw.matchAll(/'([^'\\]*(?:\\.[^'\\]*)*)'|"([^"\\]*(?:\\.[^"\\]*)*)"|`([^`\\]*(?:\\.[^`\\]*)*)`/g)) {
    const val = m[1] ?? m[2] ?? m[3];
    if (val != null) add(val, lineNo, 'string');
  }

  // 2) HTML 文本节点（>文字<）与属性值
  for (const m of raw.matchAll(/>([^<>]+)</g)) add(m[1], lineNo, 'html-text');
  for (const m of raw.matchAll(/\b(title|placeholder|aria-label|alt)="([^"]*)"/g)) add(m[2], lineNo, 'attr');
});

const out = [...hits.entries()]
  .map(([text, e]) => ({ text, count: e.count, firstLine: e.firstLine, kinds: [...e.kinds].join('+') }))
  .sort((a, b) => a.firstLine - b.firstLine);

if (process.argv.includes('--json')) {
  process.stdout.write(JSON.stringify(out, null, 2));
} else {
  console.log(`共 ${out.length} 条候选文案（去重后）\n`);
  for (const o of out) console.log(`${String(o.firstLine).padStart(5)}  x${String(o.count).padStart(2)}  [${o.kinds}]  ${o.text}`);
}
