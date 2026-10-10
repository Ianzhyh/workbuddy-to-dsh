/**
 * 通用对比度守卫：**凡是有不透明底色的控件，它的文字必须过 AA。**
 *
 *   node tools/dev/test-solid-contrast.mjs
 *
 * ## 为什么需要它
 *
 * 现有的对比度用例（`test-clients-panel.mjs` 第 6d 节）是**逐元素点名**的 ——
 * 只量了 `.formrow-*` / `.clientcard-note` 那几个「说明文字」。但真正容易出事的
 * 是**实色填充控件**：它们的文字色往往是写死的白（`color: #fff`），而底色是令牌。
 *
 * 一旦把令牌从「深色填充」改成「浅色填充」（比如深色主题里主按钮反转成浅底），
 * 写死的白字就**整片消失**。实测踩到过：深色主题下客户端选择器的当前项变成
 * **一块没有任何文字的白板** —— 因为 `.clientchip.active` 的 `background` 换成了
 * `var(--primary-solid)`，而 `color` 还留着 `#fff`。读代码完全看不出来。
 *
 * 所以这里**不点名**：把所有「有文字 + 有不透明底色」的元素全捞出来逐个体检。
 * 新增控件自动纳入覆盖，不需要有人记得来加断言。
 *
 * ## 判据
 *
 *   · 正文（< 18.66px 或非粗体）需要 4.5:1
 *   · 大字（≥ 24px，或 ≥ 18.66px 且 bold）需要 3:1 —— 与 WCAG AA 一致
 *   · 背景透明度 < 0.9 的元素**跳过**：半透明底上的有效色取决于它压在什么上，
 *     这类交给别的用例（本用例只保证「实色填充」这条最容易出错的路）
 */
import { startStaticServer, openPage, q, sleep } from './ui-harness.mjs';
import { baseRoutes, CATALOG } from './fixtures.mjs';

let failures = 0;
const pass = (m) => console.log('✓ ' + m);
const fail = (m) => { console.error('✗ ' + m); failures += 1; };

const PORT = 8824;
const URL_ = `http://127.0.0.1:${PORT}/`;

const server = await startStaticServer(PORT);
// 桥跑起来、目录非空 —— 让「主按钮」「当前项」这些只在有数据时才出现的控件真的渲染出来
const { cdp, close } = await openPage(URL_, baseRoutes({ dshReady: true, catalog: CATALOG }), {
  width: 1400, height: 1100, cdpPort: 9374,
});
const cleanup = () => { try { close(); } catch { /* 忽略 */ } try { server.close(); } catch { /* 忽略 */ } };
process.on('exit', cleanup);

/** 注入到页面里的体检器：把所有实色填充 + 有文字的元素捞出来量对比度。 */
const SCAN = `(() => {
  const parse = (s) => { const m = String(s).match(/rgba?\\(([^)]+)\\)/); if (!m) return null;
    const p = m[1].split(',').map((x) => parseFloat(x.trim()));
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); const hi = Math.max(l1, l2), lo = Math.min(l1, l2);
    return (hi + 0.05) / (lo + 0.05); };

  const out = [];
  const seen = new Set();
  const cand = document.querySelectorAll(
    'button, .badge, .tag, .clientchip, .quick-pill, .nav-tab, .filterchip, .modelpick-chip, .back-to-top, summary, .connectml-row'
  );
  for (const el of cand) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;               // 不可见
    const bg = parse(cs.backgroundColor);
    if (!bg || bg.a < 0.9) continue;                          // 只查实色填充
    const fg = parse(cs.color);
    if (!fg) continue;
    // 只查"自己直接承载文字"的元素；纯图标容器跳过
    const text = (el.textContent || '').trim();
    if (!text) continue;
    const size = parseFloat(cs.fontSize);
    const weight = parseInt(cs.fontWeight, 10) || 400;
    const large = size >= 24 || (size >= 18.66 && weight >= 700);
    const need = large ? 3 : 4.5;
    const rt = ratio(fg, bg);
    // 同一个类可能有多份，去重后只报一次
    const key = (el.className || el.tagName) + '|' + cs.backgroundColor + '|' + cs.color;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ sel: el.tagName.toLowerCase() + (el.className ? '.' + String(el.className).split(' ').join('.') : ''),
      text: text.slice(0, 16), bg: cs.backgroundColor, fg: cs.color,
      ratio: Number(rt.toFixed(2)), need, ok: rt >= need, size, weight });
  }
  return out;
})()`;

await sleep(1400);

let checked = 0;
for (const theme of ['light', 'dark']) {
  await q(cdp, `document.documentElement.setAttribute('data-theme','${theme}')`);
  await sleep(350);
  const rows = await q(cdp, SCAN);
  console.log(`\n── ${theme}：量到 ${rows.length} 个实色填充控件 ──`);
  for (const r of rows) {
    checked++;
    const label = `${r.sel} 「${r.text}」 ${r.bg} 上压 ${r.fg}`;
    if (r.ok) pass(`[${theme}] ${label} ${r.ratio}:1`);
    else fail(`[${theme}] ${label} 只有 ${r.ratio}:1（要 ${r.need}）`);
  }
}

// 防假绿：一个都没量到，说明选择器或桩数据坏了，不能算通过
if (checked < 8) fail(`只量到 ${checked} 个控件 —— 太少，扫描或桩数据有问题（防「没渲染 = 0 失败」的假绿）`);
else pass(`两套主题共体检 ${checked} 个实色填充控件`);

console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
cleanup();
process.exit(failures ? 1 : 0);
