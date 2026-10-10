/**
 * 共用的「实色填充控件对比度扫描」源码片段。
 *
 * 抽出来是因为它现在有两个使用者（`test-solid-contrast.mjs` 与
 * `test-accent-schemes.mjs`）。**复制两份的话一定会漂移** —— 一边修了判据、
 * 另一边没跟上，而两条用例都还是绿的，看不出哪边是对的。
 *
 * 用法（两步）：
 *
 * ```js
 * await withTransitionsOff(cdp, async () => {
 *   const rows = await q(cdp, SCAN_SOLID_CONTRAST);
 *   ...
 * });
 * ```
 *
 * ## 为什么必须先关过渡（踩过，试错三轮才定位）
 *
 * 这段代码读 `getComputedStyle` 的**当前值**，而 CSS 过渡会让它返回过渡的
 * 起始帧或插值中的中间色，**不是屏幕上稳定后的样子**。两种坏结果：
 *
 * 1. **视口外的元素永远读不到终值。** Chrome 不为视口外的元素启动合成，它们的
 *    过渡 `startTime` 恒为 `null`、`currentTime` 恒为 0，于是计算样式**永远停在
 *    过渡的起始帧**。实测：`.modelpick-chip.on` 在 y≈4182（视口只有 1100 高），
 *    切强调色后读到的底色永远是上一套方案的 `--primary-subtle`，与新的
 *    `--primary` 文字色配成只有 3.4:1 的组合 —— 看起来像"新配色漏了深色档"的真 bug。
 *    但滚进视口后重截图像素，底色**完全正确**（light/blue → #edf1f7、
 *    light/terracotta → #f7ece5，逐套与令牌一致）。**屏幕是对的，读数骗人。**
 *
 * 2. **过渡中途采样会取到不同步的插值。** bg 与 fg 的过渡起点错开，中途读会量到
 *    "深色底 + 浅色字"这种屏幕上不存在的组合。实测：`button.mini.danger` 在 dark
 *    下报 2.83:1 不达标，而它真实的终值是 5.26:1，本来完全达标。
 *
 * 试过的错解（都已否决，别再走一遍）：
 *   · 逐个 `scrollIntoView` 送进视口 —— **把 4 项失败变成 29 项**：控件分布在页面
 *     很长的一段里，滚到 A 把 B 挤出视口；滚动还会触发布局重排、让过渡重新起算。
 *   · 只 `await settleTransitions()` —— 好了一半（9 项 → 4 项），但对**视口外**
 *     的元素无效，它们压根不会落定。
 *
 * 正解是**关掉过渡再读**：得到静态终值，与视口位置、采样时机都无关。
 * 这就是 `withTransitionsOff()` 做的事。
 */
import { q, sleep } from './ui-harness.mjs';

/** 参与体检的控件选择器 —— 扫描器与 settleControls 共用同一份，避免两边漂移。 */
export const CONTROL_SELECTOR =
  'button, .badge, .tag, .clientchip, .quick-pill, .nav-tab, .filterchip, .modelpick-chip, .back-to-top, summary, .connectml-row';

export const SCAN_SOLID_CONTRAST = `(() => {
  const parse = (s) => { const m = String(s).match(/rgba?\\(([^)]+)\\)/); if (!m) return null;
    const p = m[1].split(',').map((x) => parseFloat(x.trim()));
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); const hi = Math.max(l1, l2), lo = Math.min(l1, l2);
    return (hi + 0.05) / (lo + 0.05); };

  const out = [];
  const seen = new Set();
  const cand = document.querySelectorAll(${JSON.stringify(CONTROL_SELECTOR)});

  /*
   * 不做任何滚动：读数是否可信取决于**过渡有没有在跑**，与元素在不在视口里无关。
   * 调用方先 withTransitionsOff() 把过渡关掉再调这里，就能拿到静态终值。
   */
  const targets = [];
  for (const el of cand) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;   // 不可见
    if (!(el.textContent || '').trim()) continue;
    targets.push(el);
  }

  for (const el of targets) {
    const bg = parse(getComputedStyle(el).backgroundColor);
    if (!bg || bg.a < 0.9) continue;             // 只查实色填充
    const fg = parse(getComputedStyle(el).color);
    if (!fg) continue;
    const text = (el.textContent || '').trim();
    if (!text) continue;
    const size = parseFloat(getComputedStyle(el).fontSize);
    const weight = parseInt(getComputedStyle(el).fontWeight, 10) || 400;
    const large = size >= 24 || (size >= 18.66 && weight >= 700);
    const need = large ? 3 : 4.5;
    const rt = ratio(fg, bg);
    // 同一个类可能有多份，去重后只报一次
    const key = (el.className || el.tagName) + '|' + getComputedStyle(el).backgroundColor + '|' + getComputedStyle(el).color;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ sel: el.tagName.toLowerCase() + (el.className ? '.' + String(el.className).split(' ').join('.') : ''),
      text: text.slice(0, 16), bg: getComputedStyle(el).backgroundColor, fg: getComputedStyle(el).color,

      ratio: Number(rt.toFixed(2)), need, ok: rt >= need, size, weight });
  }
  return out;
})()`;

/** 配色方案的 id 列表 —— 用例与界面共用同一份口径。 */
export const ACCENT_IDS = ['blue', 'terracotta', 'moss', 'violet', 'teal'];

/**
 * 让候选控件**可被可信地测量**：测量期间临时关掉过渡。
 *
 * ## 为什么是"关过渡"而不是"滚进视口"（踩过，试错了两轮）
 *
 * 起初想用 `scrollIntoView` 把每个控件送进视口 —— **行不通**：控件分布在页面
 * 上很长的一段里，滚到 A 会把 B 挤出视口，而且滚动本身会触发布局重排、让正在跑
 * 的过渡重新起算。实测把用例从 4 项失败**变成 29 项失败**（大量控件被滚到视口外，
 * 读数全成了旧配色）。
 *
 * 真正的症结是**过渡**：它让 `getComputedStyle` 返回起始帧或插值中的值。
 * 那就把过渡关掉再读 —— 得到的是**静态终值**，与视口位置完全无关，也不会中途采样。
 * 这是"测量的是终态样式"这个意图最直接的实现。
 *
 * 关过渡只影响测量这一瞬间，且只作用于样式读取；恢复后页面照常。为了不留痕，
 * 用 `<style>` 节点注入、读完即移除。
 *
 * 用法：`await withTransitionsOff(cdp, async () => { ...读样式... })`
 */
export async function withTransitionsOff(cdp, fn) {
  await q(cdp, `(() => {
    if (document.getElementById('__contrast_probe__')) return;
    const st = document.createElement('style');
    st.id = '__contrast_probe__';
    st.textContent = '*,*::before,*::after{transition:none!important;animation:none!important}';
    document.head.appendChild(st);
    // 强制一次重算，让"无过渡"立刻生效
    void document.body.offsetWidth;
  })()`);
  await sleep(80);
  try {
    return await fn();
  } finally {
    await q(cdp, `(() => { const st = document.getElementById('__contrast_probe__'); if (st) st.remove(); })()`);
  }
}
