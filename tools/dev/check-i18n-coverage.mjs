/**
 * i18n 覆盖率检查：找出**翻不动**的中文串。
 *
 *   node tools/dev/check-i18n-coverage.mjs                      # 控制台
 *   node tools/dev/check-i18n-coverage.mjs dsh-plugin/lib/client.js
 *
 * ## 为什么需要它
 *
 * 「英文模式下扫可见中文 = 0」那套验收只能发现**已经渲染出来**的漏翻。
 * 没被桩数据走到、或者藏在某个错误分支里的文案，扫不到 —— 而它们同样是漏翻，
 * 用户迟早会碰上（本会话就连着踩了三轮：签到胶囊、`· 多模态`、整页诊断）。
 *
 * 这里换个角度，**从源码侧**查：把源码里所有含中文的字符串字面量抽出来，
 * 逐条过一遍词条表与规则 —— 翻不动的就是嫌疑名单，再人工判断它是不是界面文案。
 *
 * ## 实现要点
 *
 * 词条表与规则表直接从源码里**切出来求值**（它们是纯字面量），
 * 这样检查用的翻译逻辑与被测代码永远是同一份 —— 复制一份到检查脚本里必然漂移。
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');

const file = process.argv[2] ? resolve(process.cwd(), process.argv[2]) : join(ROOT, 'dashboard', 'public', 'index.html');
const src = readFileSync(file, 'utf8');

// ── 1. 切出词条表与规则表并求值 ────────────────────────────────────────
function sliceBlock(startMarker) {
  const i = src.indexOf(startMarker);
  if (i < 0) throw new Error(`找不到 ${startMarker}`);
  const openIdx = src.indexOf(startMarker.includes('{') ? '{' : '[', i);
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
  throw new Error(`切不出 ${startMarker} 的块`);
}

const tableSrc = sliceBlock('const I18N_EN = {');
const rulesSrc = sliceBlock('const I18N_RULES_EN = [');
/*
 * 专有名词表（权益包名 / 促销标签）。**必须一起加载并复刻 `applyTerms`** ——
 * 否则检查器会把「名词表里的条目本身」报成漏翻（它们是 key，整串查表当然查不到），
 * 而实际上运行时会走子串替换翻掉。
 */
const termsSrc = sliceBlock('const I18N_TERMS_EN = {');
const I18N_TERMS_EN = new Function(`return (${termsSrc})`)();
function applyTerms(s) {
  let out = s;
  for (const [zh, en] of Object.entries(I18N_TERMS_EN)) {
    if (out.indexOf(zh) !== -1) out = out.split(zh).join(en);
  }
  return out;
}

// translateText 在规则里会被调用；有些规则还会直接查表（`I18N_EN[verb] || verb`），
// 所以两个都要传进去 —— 控制台那份就用了 `I18N_EN`（插件那份没有）。
let i18nDepth = 0;
let translateText;
const I18N_EN = new Function(`return (${tableSrc})`)();
const I18N_RULES_EN = new Function('translateText', 'I18N_EN', `return (${rulesSrc})`)(
  (s) => translateText(s), I18N_EN,
);

translateText = (text) => {
  const s = String(text);
  if (Object.prototype.hasOwnProperty.call(I18N_EN, s)) return I18N_EN[s];
  /*
   * **折叠空白后再试一次** —— 必须与源码里那份 translateText 保持一致：
   * DOM 文本节点已折叠过，而 `t()`（原生弹窗用）没有，规则又是按折叠后的文本写的。
   * 检查器不复刻这一步，就会把「其实能翻」的串报成漏翻。
   */
  const folded = s.replace(/\s+/g, ' ').trim();
  if (folded !== s && Object.prototype.hasOwnProperty.call(I18N_EN, folded)) return I18N_EN[folded];
  if (i18nDepth >= 3) return applyTerms(s);
  i18nDepth += 1;
  try {
    for (const target of (folded === s ? [s] : [s, folded])) {
      for (const rule of I18N_RULES_EN) {
        const m = target.match(rule[0]);
        if (!m) continue;
        const out = typeof rule[1] === 'function' ? rule[1].apply(null, m) : target.replace(rule[0], rule[1]);
        return applyTerms(out);
      }
    }
    return applyTerms(s);
  } finally { i18nDepth -= 1; }
};

// ── 2. 抽出源码里所有含中文的字符串字面量 ──────────────────────────────
const CJK = /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/;

/**
 * 把源码字面量还原成**运行时真正拿到的字符串**。
 *
 * 两个必须做的还原（第一版漏了，导致 8 条假阳性）：
 *   1. **反转义**：源码里写的是 `'…\n\n…'`（两个字符 `\` `n`），
 *      运行时是**真换行**。不还原就永远匹配不上按真换行写的规则。
 *   2. **不要 trim**：有些规则（如 `^ · 扣分 …`）是带前导空格的，
 *      先 trim 掉就等于把这条规则从检查范围里删了。
 */
function unescapeLiteral(s) {
  return s
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\'/g, "'")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}

/** 把模板字面量里的 `${…}` 换成占位值再判。
 *
 * **必须替换**：词条表与规则匹配的是**渲染后的串**（`全部（6）`），
 * 而源码里是 `全部（${models.length}）` —— 拿带 `${}` 的原文去匹配，
 * 规则里的 `(\d+)` 永远不成立，整份清单会全是假阳性（第一版就是这样，
 * 46 条里 40 条是假的）。
 *
 * 占位值给 `1`：规则里的数量断言都按数字写，`1` 能命中绝大多数。
 */
function fillTemplate(s) {
  let out = '';
  for (let i = 0; i < s.length; i += 1) {
    if (s[i] === '$' && s[i + 1] === '{') {
      let depth = 1;
      let k = i + 2;
      while (k < s.length && depth > 0) {
        if (s[k] === '{') depth += 1;
        else if (s[k] === '}') depth -= 1;
        k += 1;
      }
      out += '1';
      i = k - 1;
      continue;
    }
    out += s[i];
  }
  return out;
}

const hits = new Map();
/** 同一行的字面量（按行号索引）：用来判「拼接片段」，见下面 joined 的处理。 */
const byLine = new Map();
src.split('\n').forEach((raw, i) => {
  const trimmed = raw.trim();
  if (/^(\/\/|\*|\/\*)/.test(trimmed)) return; // 注释行不算
  const lineVals = [];
  for (const m of raw.matchAll(/'([^'\\]*(?:\\.[^'\\]*)*)'|"([^"\\]*(?:\\.[^"\\]*)*)"|`([^`\\]*(?:\\.[^`\\]*)*)`/g)) {
    const val = m[1] ?? m[2] ?? m[3];
    if (val == null || !CJK.test(val)) continue;
    const key = val.replace(/\s+/g, ' ').trim();
    if (!hits.has(key)) hits.set(key, { line: i + 1, raw: val, count: 0 });
    hits.get(key).count += 1;
    lineVals.push(val);
  }
  if (lineVals.length) byLine.set(i + 1, lineVals);
});

/**
 * 一个字面量算「翻得动」的判据。
 *
 * 控制台翻的是**渲染后的文本节点**（`innerHTML` 拼进去的 HTML 会拆成一个个文本节点），
 * 所以 `'<span class="tag">测试中…</span>'` 这种字面量**不能整体去查表** ——
 * 它落到 DOM 里是 `测试中…` 那个文本节点，查的是后者。
 * 因此：整串能翻 → 过；否则拆掉 HTML 标签，**每个文本片段都能翻** → 也过。
 */
function translates(s) {
  if (!CJK.test(s)) return true;
  if (translateText(s) !== s) return true;
  // 含 HTML 标签的字面量：按**拆出来的文本片段**判（哪怕只有一片）
  if (!/[<>]/.test(s)) return false;
  /*
   * 片段两端还要去掉**孤立的 `>` / `<`**：`'> 每日自动签到</label>'` 这种，
   * 按 `<[^>]*>` 拆完第一段是 `> 每日自动签到`（那个 `>` 是 HTML 的收尾符，
   * 不属于文本），带着它去查表当然查不到 —— 实测就是这么误报的。
   */
  const pieces = s.split(/<[^>]*>/)
    .map((t) => t.replace(/^[<>]+/, '').replace(/[<>]+$/, '').trim())
    .filter(Boolean);
  if (!pieces.length) return true;
  return pieces.every((p) => !CJK.test(p) || translateText(p) !== p);
}

// ── 3. 逐条过翻译，列出翻不动的 ────────────────────────────────────────
const untranslated = [];
for (const [, meta] of hits) {
  // 用**未 trim 的原文**判：带前导空格的规则才验得到
  const filled = fillTemplate(unescapeLiteral(meta.raw));
  // **整串能翻就没问题** —— 不能再拿拆行结果去判，否则「多行整串有条目、
  // 单行没有」的情况会被误报（第一版就这么误报了 4 条确认弹窗）。
  if (translates(filled)) continue;
  /*
   * **拼接片段**：`'保存到 dsh 设置（' + n + '）'` 这种，单独看 `保存到 dsh 设置（`
   * 永远翻不动，但拼起来（`保存到 dsh 设置（1）`）是有规则的。
   * 所以把**同一行**的字面量用 `1` 连起来再判一次 —— 能翻就说明它只是片段。
   * （第一版没有这一步，112 条里绝大多数是这类噪音。）
   */
  const lineVals = byLine.get(meta.line) || [];
  if (lineVals.length > 1 && translates(fillTemplate(unescapeLiteral(lineVals.join('1'))))) continue;
  // 翻不动：再按行拆开，指出是**哪一段**翻不动（只是给线索，不是判据）
  const bad = filled.split('\n')
    .map((s) => s.trim())
    .filter((p) => p && !translates(p));
  untranslated.push({ text: meta.raw, line: meta.line, bad });
}

console.log(`文件：${file.replace(ROOT, '.')}`);
console.log(`含中文的字符串字面量 ${hits.size} 条；其中**翻不动**的 ${untranslated.length} 条\n`);

if (process.argv.includes('--debug')) {
  const first = untranslated[0];
  if (first) {
    const filled = fillTemplate(unescapeLiteral(first.text));
    console.log('--- 调试第一条 ---');
    console.log('原始 JSON     :', JSON.stringify(first.text).slice(0, 120));
    console.log('还原后 JSON   :', JSON.stringify(filled).slice(0, 120));
    console.log('表里有这个键吗:', Object.prototype.hasOwnProperty.call(I18N_EN, filled));
    const near = Object.keys(I18N_EN).filter((k) => k.slice(0, 8) === filled.slice(0, 8));
    console.log('表里前缀相同的键 JSON:', near.map((k) => JSON.stringify(k).slice(0, 60)));
    console.log('---\n');
  }
}

for (const u of untranslated) {
  console.log(`  L${String(u.line).padStart(5)}  ${u.text.slice(0, 90).replace(/\n/g, '⏎')}`);
  for (const b of u.bad) {
    if (b !== u.text) console.log(`          ↳ 片段翻不动：${b.slice(0, 80)}`);
  }
}
console.log(`\n注：翻不动 ≠ 一定是 bug —— 注释、日志、确认弹窗、以及**上游数据**都会出现在这里。`);
console.log(`    要人工判断它是不是「用户能看到的界面文案」。`);
