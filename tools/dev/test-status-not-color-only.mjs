/**
 * 状态不能只靠颜色传达（WCAG 1.4.1）。
 *
 *   node tools/dev/test-status-not-color-only.mjs
 *
 * ## 为什么需要它
 *
 * 环境诊断面板的全部意义是「**哪一项红了**，不解决模型就不会出现」。
 * 而它原先的状态通道**只有颜色**：一枚 8px 纯色圆点 + 整行染色
 * （`.diag-row:has(.s-fail)`）。两处都是颜色。
 *
 * 实测（Machado 2009 色觉缺陷模拟，严重度 1.0）三色两两的 CIEDE2000 色差：
 *
 *   | 主题 | 缺陷 | 最差一对 | ΔE00 |
 *   |---|---|---|---|
 *   | 浅色 | 绿色盲 | `--warn` vs `--fail` | **0.4** ← 就是同一个颜色 |
 *   | 浅色 | 红色盲 | ok/warn/fail 两两 | 6.9 – 7.1 |
 *   | 深色 | 绿色盲 | `--ok` vs `--fail` | **4.4** |
 *
 * 绿色盲在男性里约占 6% —— 对这部分用户，「哪行是失败」**完全读不出来**。
 * 窄屏更糟：`.diag-row .s-dot { display: none }` 把圆点也藏了，只剩底色浓淡。
 *
 * ## 判据（三条，缺一不可）
 *
 * 1. **每个状态都有字形** —— 非空、不是空白字符；
 * 2. **三个状态的字形互不相同** —— 否则等于没区分；
 * 3. **字形在徽章底色上看得见** —— 算对比度，要 ≥ 4.5:1。
 *
 * 第 3 条不量像素而是算计算样式：这里量的是"字形色 vs 徽章底色"，
 * 两者都是不透明实色，计算值就是屏幕值（像素复核见提交信息里那次实测：
 * 浅色 4.99–5.37:1、深色 6.07–7.75:1，与计算一致）。
 */
import { startStaticServer, openPage, waitFor, q, sleep } from './ui-harness.mjs';
import { baseRoutes } from './fixtures.mjs';

let failures = 0;
const pass = (m) => console.log('✓ ' + m);
const fail = (m) => { console.error('✗ ' + m); failures += 1; };

const PORT = 8828;
const URL_ = `http://127.0.0.1:${PORT}/`;

/*
 * 三种状态**都要在桩里**。默认夹具只有 ok/warn（`summary.fail: 0`），
 * 而 fail 恰恰是"不解决模型就不会出现"的那一档 —— 缺了它这张表最重要的
 * 视觉状态从来没被渲染过（与 fixtures.mjs 里那句"桩数据里没有它，它就等于没测"同源）。
 */
const DIAG_ITEMS = [
  { id: 'bridge', label: '桥服务', status: 'ok', detail: '127.0.0.1:8790 已响应', hint: '' },
  { id: 'settings', label: 'dsh 模型路由', status: 'warn', detail: '尚未配置 workbuddy 路由', hint: '在「可用模型」里勾选后保存' },
  { id: 'login', label: '登录文件', status: 'fail', detail: '找不到登录文件，无法读取凭据', hint: '先在 WorkBuddy 桌面端登录一次' },
];

const SCAN = `(() => {
  const parse = (s) => { const m = String(s).match(/rgba?\\(([^)]+)\\)/); if (!m) return null;
    const p = m[1].split(',').map((x) => parseFloat(x.trim()));
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); const hi = Math.max(l1, l2), lo = Math.min(l1, l2);
    return (hi + 0.05) / (lo + 0.05); };

  const out = [];
  for (const row of document.querySelectorAll('.diag-row')) {
    const dot = row.querySelector('.s-dot');
    if (!dot) { out.push({ err: '这一行没有 .s-dot' }); continue; }
    const cs = getComputedStyle(dot);
    const bg = parse(cs.backgroundColor);
    const fg = parse(cs.color);
    const glyph = (dot.textContent || '').trim();
    out.push({
      status: (dot.className.match(/s-(ok|warn|fail)/) || [])[1] || '?',
      glyph,
      glyphLen: glyph.length,
      blank: glyph.length === 0,
      bg: cs.backgroundColor,
      fg: cs.color,
      contrast: bg && fg && bg.a > 0.9 ? Number(ratio(fg, bg).toFixed(2)) : null,
      label: row.querySelector('.label') ? row.querySelector('.label').textContent.trim() : '',
    });
  }
  return out;
})()`;

const server = await startStaticServer(PORT);
const { cdp, close } = await openPage(URL_, baseRoutes({ items: DIAG_ITEMS }), {
  width: 1280, height: 900, cdpPort: 9380,
});
const cleanup = () => { try { close(); } catch { /* 忽略 */ } try { server.close(); } catch { /* 忽略 */ } };
process.on('exit', cleanup);

let checked = 0;
try {
  await waitFor(cdp, `document.querySelectorAll('.diag-row').length >= 3`, 10000, '诊断行');

  for (const theme of ['light', 'dark']) {
    await q(cdp, `document.documentElement.setAttribute('data-theme','${theme}')`);
    await sleep(300);
    const rows = await q(cdp, SCAN);
    console.log(`\n── ${theme}：${rows.length} 行诊断 ──`);

    const seen = new Map();
    for (const r of rows) {
      if (r.err) { fail(`[${theme}] ${r.err}`); continue; }
      checked++;

      // ① 有字形
      if (r.blank) {
        fail(`[${theme}] ${r.status}「${r.label}」的状态**只有颜色**（.s-dot 里没有字形）—— 色盲用户读不出来`);
        continue;
      }
      // ③ 字形看得见
      if (r.contrast === null) fail(`[${theme}] ${r.status} 徽章底色不透明，量不到对比度`);
      else if (r.contrast < 4.5) fail(`[${theme}] ${r.status} 字形 ${r.fg} 压在徽章底 ${r.bg} 上只有 ${r.contrast}:1（要 4.5）`);
      else pass(`[${theme}] ${r.status}「${r.label}」字形「${r.glyph}」对比度 ${r.contrast}:1`);

      // ② 互不相同（同一个状态多次出现是允许的，不同状态必须不同字形）
      if (seen.has(r.status) && seen.get(r.status) !== r.glyph) {
        fail(`[${theme}] ${r.status} 出现了两种字形：「${seen.get(r.status)}」与「${r.glyph}」`);
      }
      seen.set(r.status, r.glyph);
    }

    const glyphs = [...seen.values()];
    const uniq = new Set(glyphs);
    if (uniq.size !== glyphs.length) {
      fail(`[${theme}] 不同状态用了相同字形（${glyphs.join(' / ')}）—— 字形没起到区分作用`);
    } else if (glyphs.length) {
      pass(`[${theme}] ${glyphs.length} 个状态字形互不相同：${glyphs.join(' / ')}`);
    }
  }
} finally {
  /*
   * 防假绿：一个状态都没量到说明桩数据或选择器坏了。
   * 三种状态**都要**出现过 —— 少一种就少测一种视觉状态。
   */
  if (checked < 6) fail(`两套主题共只量到 ${checked} 行 —— 太少（防假绿）`);
  else pass(`两套主题共体检 ${checked} 行诊断`);

  console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
  cleanup();
  process.exit(failures ? 1 : 0);
}
