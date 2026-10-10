/**
 * i18n 覆盖率检查：找出**翻不动**的中文串。
 *
 *   node tools/dev/check-i18n-coverage.mjs                      # 控制台
 *   node tools/dev/check-i18n-coverage.mjs dsh-plugin/lib/client.js
 *   node tools/dev/check-i18n-coverage.mjs --check '某个串'      # 只问这几串翻不翻
 *   node tools/dev/check-i18n-coverage.mjs --why 3729           # 问「这一行为什么进/不进名单」
 *   node tools/dev/check-i18n-coverage.mjs --why '保存到 dsh 设置（'
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
 *
 * 判据顺序（任一成立就算「翻得动」，不进名单）：
 *   1. 整串能翻（含 HTML 的串按拆出的文本片段逐段判）；
 *   2. 它是**拼接片段** —— 同行拼接、或跨行 `+` 链拼起来能翻（见 `chainSep`）。
 *
 * 名单里的条数只说明「嫌疑」，不说明「缺陷」：注释、日志、上游数据也会进来。
 * 判断单条真伪用 `--why`，别靠猜。
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');

/*
 * 参数：`[文件] [--check 串…] [--why 行号|串] [--debug]`
 *
 * 位置参数与开关要分开解析 —— 否则 `--check` 后面那串会被当成文件名
 * （实测：`ENOENT: open '…\--check'`）。
 */
const argv = process.argv.slice(2);
const checkStrings = [];
const positional = [];
let whyLine = 0;
let whyArg = '';
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--check') {
    i += 1;
    while (i < argv.length && !argv[i].startsWith('--')) { checkStrings.push(argv[i]); i += 1; }
    i -= 1;
    continue;
  }
  if (argv[i] === '--why') {
    whyArg = argv[i + 1];
    whyLine = Number(whyArg) || 0;
    i += 1;
    continue;
  }
  if (argv[i].startsWith('--')) continue;
  positional.push(argv[i]);
}
const file = positional[0] ? resolve(process.cwd(), positional[0]) : join(ROOT, 'dashboard', 'public', 'index.html');
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

/*
 * 「拼接片段」的判据要**按 `+` 链**，不能按行。
 *
 * 旧实现把**同一行**的字面量用 `'1'` 连起来再判，两个问题：
 *   1. **跨行拼接看不见**。`'…前半句'` 换行 `+ '后半句…'` 是这份文件里最常见的
 *      写法（一行太长要断），而词条表里的键是**拼完的整句**。按行拆开判，
 *      整句永远拼不上，永远是「片段翻不动」——实测 Codex 卡片那 6 条全是这类假阳性。
 *   2. **分隔符一律用 `'1'` 也不对**：`'a' + n + 'b'` 运行时是 `a1b`（中间是变量），
 *      而 `'a' + 'b'` 运行时就是 `ab`。分隔符取决于**两个字面量之间夹了什么**。
 *
 * 所以先按源码位置把所有字面量排好，再看相邻两个之间的「缝」：
 *   缝里只有 `+`         → 直接相接，用 `''` 拼；
 *   缝是 `+ … +`         → 中间夹了表达式，用 `'1'` 当占位；
 *   其他（逗号 / 冒号 / 换行分隔的数组元素）→ **不拼**。它们在运行时本来就是
 *   各自独立的文本节点（`appendParts` 就是干这个的），必须各自能翻。
 */
const LITERAL_RE = /'([^'\\]*(?:\\.[^'\\]*)*)'|"([^"\\]*(?:\\.[^"\\]*)*)"|`([^`\\]*(?:\\.[^`\\]*)*)`/g;
const srcLines = src.split('\n');
const lineStarts = [];
{
  let off = 0;
  for (const l of srcLines) { lineStarts.push(off); off += l.length + 1; }
}
const tokens = [];
srcLines.forEach((raw, i) => {
  const isComment = /^(\/\/|\*|\/\*)/.test(raw.trim());
  for (const m of raw.matchAll(LITERAL_RE)) {
    const startAbs = lineStarts[i] + m.index;
    tokens.push({
      line: i + 1,
      startAbs,
      endAbs: startAbs + m[0].length,
      val: m[1] ?? m[2] ?? m[3],
      isComment,
    });
  }
});

/**
 * 判断两个字面量之间那道「缝」的性质，返回 `{ sep, depth }`：
 *
 *   `sep = ''`   —— 直接相接（`'a' + 'b'` 运行时是 `ab`）
 *   `sep = '1'`  —— 中间夹着表达式（`'a' + n + 'b'` 运行时是 `a1b`）
 *   `sep = null` —— 不是同一条 `+` 链，**不拼**（调用方就此收链）
 *
 * `depth` 是**进入下一个字面量时的括号深度**，必须由调用方沿着链传下去 ——
 * 不能每道缝都从 0 开始。反例（实测踩过）：
 *   `'今天已经签过了（' + (d.message || '') + '）'`
 * 头一道缝里开了 `(`（结束时深度 1），第二道缝一上来就是 `)`，它闭合的是
 * **上一道缝开的括号**。每道缝各自从 0 起算，这个 `)` 就会被当成「在深度 0
 * 闭合 → 表达式结束」，链断在这里，整句永远拼不上。
 *
 * 判据里那个「深度 0 闭合即收链」不能省。反例：
 *   `('已切换到 ' + file) : ('切换失败：' + err)`
 * 这两个字面量在**三元的两个分支**上，运行时永远不会拼在一起，
 * 但缝里确实有个 `+`。只有括号闭合在深度 0 才说明表达式真的结束了。
 */
function chainSep(gap, startDepth) {
  let depth = startDepth;
  let sawPlus = false;
  let sawExpr = false; // 第一个 `+` 之后是否出现过操作数（一旦为真不再复位）
  for (let i = 0; i < gap.length; i += 1) {
    const c = gap[i];
    if (c === '(' || c === '[' || c === '{') { depth += 1; if (sawPlus) sawExpr = true; continue; }
    if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) return { sep: null, depth }; // 表达式在这里就结束了
      depth -= 1;
      continue;
    }
    if (depth > 0) { if (sawPlus) sawExpr = true; continue; }
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') continue;
    if (c === '+') { sawPlus = true; continue; }
    // 深度 0 上遇到这些 → 换了一个操作数 / 一条语句，不是同一条 `+` 链
    if (c === '?' || c === ':' || c === ',' || c === ';') return { sep: null, depth };
    if (!sawPlus) return { sep: null, depth }; // 第一个 `+` 之前就有别的符号
    sawExpr = true;
  }
  if (!sawPlus) return { sep: null, depth };
  return { sep: sawExpr ? '1' : '', depth };
}

// 串成 `+` 链，每个成员记住自己所在链的「运行时拼接形态」。
let t = 0;
while (t < tokens.length) {
  const members = [tokens[t]];
  let joined = tokens[t].val;
  let u = t;
  let depth = 0;
  while (u + 1 < tokens.length) {
    const r = chainSep(src.slice(tokens[u].endAbs, tokens[u + 1].startAbs), depth);
    if (r.sep === null) break;
    depth = r.depth;
    u += 1;
    joined += r.sep + tokens[u].val;
    members.push(tokens[u]);
  }
  if (u > t) for (const tk of members) tk.chain = joined;
  t = u + 1;
}

const hits = new Map();
/** 同一行的字面量（按行号索引）：连同下面的 `+` 链一起判「拼接片段」。 */
const byLine = new Map();
srcLines.forEach((raw, i) => {
  const vals = [];
  for (const m of raw.matchAll(LITERAL_RE)) {
    const val = m[1] ?? m[2] ?? m[3];
    if (val != null && CJK.test(val)) vals.push(val);
  }
  if (vals.length) byLine.set(i + 1, vals);
});

for (const tk of tokens) {
  if (tk.isComment || !CJK.test(tk.val)) continue;
  const key = tk.val.replace(/\s+/g, ' ').trim();
  if (!hits.has(key)) hits.set(key, { line: tk.line, raw: tk.val, count: 0, chains: new Set() });
  const meta = hits.get(key);
  meta.count += 1;
  /*
   * 链是**按字面量的值**收集的（`meta` 本身就按值去重），不是按出现位置 ——
   * 所以同一个串只要在**任意一处**是能翻的片段，整条就都被抑制。
   * 这符合「同一个串在同一个文件里，作者意图一致」的预设；
   * 反过来的情形（同串在一处是片段、另一处是真漏翻）极罕见，且查得出来
   * （`--why <串>` 会把每一处都列出来）。
   */
  if (tk.chain && tk.chain !== tk.val) meta.chains.add(tk.chain);
}

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
/*
 * `--check <串>…`：直接问「这几串翻不翻」。
 * 排查时最常用的动作 —— 名单里挑出可疑的一条，想知道它到底是真漏还是片段。
 */
if (checkStrings.length) {
  for (const s of checkStrings) {
    const out = translateText(s);
    console.log(`${out === s ? '✗ 翻不动' : '✓ 能翻  '}  ${JSON.stringify(s)}`);
    if (out !== s) console.log(`             → ${JSON.stringify(out)}`);
  }
  process.exit(0);
}

/*
 * `--why <行号 | 字面量>`：两问之一。
 *   给行号 —— 把这一行上每个中文字面量、它所在的 `+` 链、以及两者各自翻不翻打出来。
 *   给字面量 —— 直接把它的 meta（首次出现行、所在链、各判据的结论）打出来。
 * 名单上出现一条不知道是真是假时，这是最快的判据来源 —— `--check` 只能问
 * 「这串翻不翻」，回答不了「它为什么没被认成片段 / 为什么压根不在名单里」。
 */
if (whyArg) {
  if (whyLine) {
    const onLine = tokens.filter((tk) => tk.line === whyLine);
    console.log(`L${whyLine} 上共 ${onLine.length} 个字面量：\n`);
    for (const tk of onLine) reportLiteral(tk);
  } else {
    const key = whyArg.replace(/\s+/g, ' ').trim();
    const meta = hits.get(key);
    if (!meta) {
      console.log(`词条表里没有 ${JSON.stringify(whyArg)} 这个**字面量**（注意：查的是源码字面量，不是词条表的键）。`);
    } else {
      console.log(`字面量 ${JSON.stringify(meta.raw)}`);
      console.log(`  首次出现：L${meta.line}（全文件共 ${meta.count} 处）`);
      console.log(`  单独看  ：${translates(fillTemplate(unescapeLiteral(meta.raw))) ? '算能翻 → 不进名单' : '翻不动'}`);
      const lv = byLine.get(meta.line) || [];
      console.log(`  同行情境：${lv.length > 1 ? `${JSON.stringify(lv.join('1')).slice(0, 70)} → ${translates(fillTemplate(unescapeLiteral(lv.join('1')))) ? '能翻 → 被抑制' : '翻不动'}` : '该行只有这一个中文字面量，此判据不适用'}`);
      if (!meta.chains.size) console.log('  链      ：（无）');
      for (const c of meta.chains) {
        console.log(`  链      ：${JSON.stringify(c).slice(0, 70)} → ${translates(fillTemplate(unescapeLiteral(c))) ? '能翻 → 被抑制' : '翻不动'}`);
      }
      console.log('');
      for (const tk of tokens.filter((x) => x.val === meta.raw)) reportLiteral(tk);
    }
  }
  process.exit(0);
}

/** 打印一个 token 的判据结论（`--why` 用）。 */
function reportLiteral(tk) {
  const self = translateText(fillTemplate(unescapeLiteral(tk.val))) !== fillTemplate(unescapeLiteral(tk.val));
  console.log(`  ${CJK.test(tk.val) ? '中' : '·'} 字面量 ${JSON.stringify(tk.val).slice(0, 70)}`);
  console.log(`     单独看：${self ? '能翻' : '翻不动'}${tk.isComment ? '（注释行，不参与统计）' : ''}`);
  if (tk.chain) {
    const c = fillTemplate(unescapeLiteral(tk.chain));
    console.log(`     链形态：${JSON.stringify(tk.chain).slice(0, 70)}`);
    console.log(`     链看  ：${translateText(c) !== c ? '能翻' : '翻不动'}`);
  } else {
    console.log('     链形态：（无 —— 前后字面量不在同一条 `+` 链上）');
  }
  console.log('');
}

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
   *
   * 两个判据**取并集**，各有各的覆盖范围：
   *   1. **同行**：把该行所有中文字面量用 `'1'` 连起来 —— 覆盖
   *      `'已导出请求明细（' + requestScopeText() + ' · ' + n + ' 条）'` 这类
   *      「一行里好几个字面量、中间夹着调用」。它比下面那条松，但正因为松，
   *      才能处理「缝里有逗号/三元/嵌套调用」的情形。
   *   2. **`+` 链（可跨行）**：按运行时真实的拼接形态还原 —— 覆盖
   *      `'…前半句'` 换行 `+ '后半句…'`，这是这份文件里最常见的断行写法，
   *      同行判据**看不见**（实测 Codex 卡片那 6 条就是栽在这里）。
   *
   * 为什么不全用第 2 条：链会一路吃掉 HTML 标签，拼出一串横跨多个文本节点
   * 的长串，而 `translates()` 对含标签的串要求**每一段都能翻** —— 反而判不出来。
   * 宁可多留一条松判据，也不要为了「更精确」把已有的覆盖丢掉。
   */
  const lineVals = byLine.get(meta.line) || [];
  if (lineVals.length > 1 && translates(fillTemplate(unescapeLiteral(lineVals.join('1'))))) continue;

  let isFragment = false;
  for (const c of meta.chains) {
    if (translates(fillTemplate(unescapeLiteral(c)))) { isFragment = true; break; }
  }
  if (isFragment) continue;
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
/*
 * 人工过一遍的结果（2026-10-10，39 条），记在这里免得下一个人重做：
 *   · 相对时间后缀（`秒前` / `分钟前` / `小时前` / `天前`）→ **由规则覆盖**：
 *     运行时拼出来的整串是「5 秒前」，命中 `/^(\\d+) 秒前$/` 那条规则 ✓
 *   · 多行确认弹窗（`原文件会自动备份。\n\n确定继续？`）→ 已**实测**为英文
 *     （面板用例里那条"英文模式下写入确认框不许有中文"就是钉它的）
 *   · `innerHTML` 模板片段（带 `<div class=…>` 的那些）→ 由 **DOM 层在运行时**翻译，
 *     静态扫字面量看不见这条路径
 *   · 单个标点 / 单字（`。` / `：` / `时`）→ 拼接用，整串由规则或词条表覆盖
 *
 * **所以：这份清单不是"漏翻列表"。** 真正能抓漏翻的是**英文模式的渲染断言**
 * （`tools/dev/test-i18n.mjs` + 各面板用例里的 `ZH_IN()` 扫描），
 * 它们跑的是页面里**实际渲染出来**的东西。这个脚本的价值在另一处：
 * 它是**新增文案时的自查**（写完新串立刻跑一下，看它有没有进词条表）。
 */
console.log('    （人工过一遍的结论见源码末尾注释：这份清单里的多数条目属预期，不是漏翻列表）');
