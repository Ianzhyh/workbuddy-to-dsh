/**
 * 控制台「整页切换」动效验收：主题切换与语言切换。
 *
 *   node tools/dev/test-transitions.mjs
 *
 * ## 这两处为什么必须有验收
 *
 * 它们是**整页状态换一次**，动画写错了不会报错、也不影响功能 —— 只会让人看到
 * 「啪一下」。历史上连着踩了三轮（逐属性补间漏属性、全局规则加 box-shadow 后
 * 性能崩塌、两段式计时器与 CSS 时长对不上），而**读 CSS 看不出来**。
 *
 * ## 现在的机制
 *
 * 交给平台的 View Transitions API：`withViewTransition(cb)` 包住状态变更，
 * 浏览器把「旧的一帧」「新的一帧」各自快照后自己交叉淡化。
 * 所以断言的对象变了 —— 不再逐帧取某个属性的中间值，而是：
 *
 *   1. `startViewTransition` **真的被调用**（用 spy，不是查有没有 class）；
 *   2. 过渡期间存在 `::view-transition-old/new(root)` 的伪元素动画，
 *      **且 currentTime 在推进** —— 只有动画对象、不推进，等于没动；
 *   3. 状态落点正确（主题属性、图标显隐、语言文案）；
 *   4. **降级路径**：没有这个 API 时状态**照样要能切** ——
 *      动画是装饰，状态不能因为动画而丢。这条最容易在重构里被忽略。
 */
import { startStaticServer, openPage, waitFor, q, sleep } from './ui-harness.mjs';
import { baseRoutes, CATALOG } from './fixtures.mjs';

const PORT = 8779;

let failures = 0;
const fail = (m) => { console.error('✗ ' + m); failures += 1; };
const pass = (m) => console.log('✓ ' + m);

const server = await startStaticServer(PORT);
const { cdp, close } = await openPage(`http://127.0.0.1:${PORT}/`, baseRoutes({ dshReady: true, catalog: CATALOG }), {
  width: 1280, height: 900,
  inject: `window.__ERRORS = []; window.addEventListener('error', (e) => window.__ERRORS.push(String(e.message)));`,
});

/** 给 `startViewTransition` 装个计数器。 */
const SPY = `(() => {
  if (window.__vtSpy) return;
  window.__vtSpy = { calls: 0 };
  const orig = document.startViewTransition.bind(document);
  document.startViewTransition = (cb) => { window.__vtSpy.calls += 1; return orig(cb); };
})()`;

/** 过渡期间正在跑的伪元素动画（含进度，用来判「有没有在推进」）。 */
const PSEUDO = `document.getAnimations()
  .filter((a) => a.effect && a.effect.pseudoElement)
  .map((a) => ({ p: a.effect.pseudoElement, t: Math.round(a.currentTime || 0) }))`;

try {
  await waitFor(cdp, `document.querySelectorAll('#modelTable tbody tr').length > 0`, 15000, '控制台渲染');
  await sleep(700);
  await q(cdp, SPY);

  // ── 1. 主题切换 ───────────────────────────────────────────────────────
  await q(cdp, `commitTheme('light')`); // 只落状态、不带动画：给断言一个确定的起点
  await sleep(250);
  const before = await q(cdp, `(() => {
    const sun = document.getElementById('themeIconSun'), moon = document.getElementById('themeIconMoon');
    return {
      theme: document.documentElement.getAttribute('data-theme'),
      sun: getComputedStyle(sun).opacity, moon: getComputedStyle(moon).opacity,
      calls: window.__vtSpy.calls,
    };
  })()`);

  await q(cdp, `document.getElementById('themeToggle').click()`);
  /*
   * 取样要**等一帧以上**：View Transition 的伪元素动画是浏览器在下一帧才建的，
   * 点击后立刻读会拿到空数组（第一次就是这么误报的）。
   */
  await sleep(90);
  const during = await q(cdp, `(() => ({ calls: window.__vtSpy.calls, pseudo: ${PSEUDO} }))()`);
  await sleep(90);
  const later = await q(cdp, `${PSEUDO}`);
  await sleep(500);
  const after = await q(cdp, `(() => {
    const sun = document.getElementById('themeIconSun'), moon = document.getElementById('themeIconMoon');
    return {
      theme: document.documentElement.getAttribute('data-theme'),
      sun: getComputedStyle(sun).opacity, moon: getComputedStyle(moon).opacity,
    };
  })()`);

  if (during.calls === before.calls + 1) pass('切主题调用了 startViewTransition');
  else fail(`切主题没有走 View Transition（调用数 ${before.calls} → ${during.calls}）`);

  const kinds = new Set(during.pseudo.map((x) => x.p));
  if ([...kinds].some((p) => p.includes('view-transition-new(root)'))) {
    pass(`过渡期间有整页伪元素动画（${[...kinds].join(' / ')}）`);
  } else fail(`没有整页交叉淡化的伪元素动画：${JSON.stringify(during.pseudo)}`);

  const maxT0 = Math.max(0, ...during.pseudo.map((x) => x.t));
  const maxT1 = Math.max(0, ...later.map((x) => x.t));
  if (later.length && maxT1 > maxT0) pass(`交叉淡化在推进（currentTime ${maxT0}ms → ${maxT1}ms）`);
  else fail(`伪元素动画没有推进：${JSON.stringify(during.pseudo)} → ${JSON.stringify(later)}`);

  if (before.theme === 'light' && after.theme === 'dark') pass('主题状态落点正确（light → dark）');
  else fail(`主题没切换：${before.theme} → ${after.theme}`);
  if (before.moon === '1' && after.sun === '1' && after.moon === '0') pass('图标状态正确（浅色显月亮、深色显太阳）');
  else fail(`图标状态不对：浅色 moon/sun=${before.moon}/${before.sun}，深色 sun/moon=${after.sun}/${after.moon}`);

  // ── 2. 语言切换 ───────────────────────────────────────────────────────
  const langBefore = await q(cdp, `(() => ({
    text: document.getElementById('langToggleText').textContent,
    nav: document.querySelector('.nav-tab').textContent.trim(),
    calls: window.__vtSpy.calls,
  }))()`);
  await q(cdp, `document.getElementById('langToggle').click()`);
  await sleep(90); // 同上：伪元素动画在下一帧才建
  const langDuring = await q(cdp, `(() => ({ calls: window.__vtSpy.calls, pseudo: ${PSEUDO} }))()`);
  await sleep(500);
  const langAfter = await q(cdp, `(() => ({
    text: document.getElementById('langToggleText').textContent,
    nav: document.querySelector('.nav-tab').textContent.trim(),
  }))()`);

  if (langDuring.calls === langBefore.calls + 1) pass('切语言调用了 startViewTransition');
  else fail(`切语言没有走 View Transition（调用数 ${langBefore.calls} → ${langDuring.calls}）`);
  if (langDuring.pseudo.length) pass('语言切换期间有整页交叉淡化');
  else fail('语言切换期间没有伪元素动画');
  if (langAfter.text !== langBefore.text && langAfter.nav !== langBefore.nav && /^[\x20-\x7e]+$/.test(langAfter.nav)) {
    pass(`语言确实切了（${langBefore.nav} → ${langAfter.nav}）`);
  } else fail(`语言没切换：${langBefore.nav} → ${langAfter.nav}`);

  // ── 3. 降级路径：没有这个 API 时，状态照样要能切 ─────────────────────
  await q(cdp, `(() => { window.__vtOrig = document.startViewTransition; document.startViewTransition = undefined; })()`);
  await q(cdp, `document.getElementById('themeToggle').click()`);
  const fbTheme = await q(cdp, `document.documentElement.getAttribute('data-theme')`);
  await q(cdp, `document.getElementById('langToggle').click()`);
  await sleep(120);
  const fbLang = await q(cdp, `document.getElementById('langToggleText').textContent`);
  if (fbTheme !== after.theme) pass('无 View Transitions 时主题仍然切换（状态不依赖动画）');
  else fail(`降级时主题没切：${after.theme} → ${fbTheme}`);
  if (fbLang !== langAfter.text) pass('无 View Transitions 时语言仍然切换');
  else fail('降级时语言没切 —— 动画失败把状态一起带走了');
  await q(cdp, `document.startViewTransition = window.__vtOrig`);

  // ── 4. reduce 下交叉淡化保留（只是压短）──────────────────────────────
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await sleep(200);
  const rmReduce = await q(cdp, `matchMedia('(prefers-reduced-motion: reduce)').matches`);
  await q(cdp, `document.getElementById('themeToggle').click()`);
  await sleep(90); // 同样要等伪元素动画建出来
  /*
   * 只看 `old` / `new` 两条淡入淡出：`::view-transition-group(root)` 那一条是
   * 浏览器给快照做定位/尺寸用的（默认 250ms），不该被我们改 ——
   * 改它会与淡入淡出的节奏错开。第一版把三条一起断言，于是恒红。
   */
  const rmDurations = await q(cdp, `document.getAnimations()
    .filter((a) => a.effect && a.effect.pseudoElement && /view-transition-(old|new)/.test(a.effect.pseudoElement))
    .map((a) => a.effect.getTiming().duration)`);
  await sleep(300);
  await cdp.send('Emulation.setEmulatedMedia', { features: [] });
  if (!rmReduce) fail('模拟 prefers-reduced-motion 没生效，这段断言没意义');
  else if (rmDurations.length && rmDurations.every((d) => d <= 200)) {
    pass(`reduce 下交叉淡化保留但压短（${rmDurations[0]}ms）—— 颜色/透明度不是 motion，不该被一起关掉`);
  } else fail(`reduce 下的过渡时长不符合预期：${JSON.stringify(rmDurations)}`);

  // ── 5. 运行时报错 ─────────────────────────────────────────────────────
  const errs = await q(cdp, `window.__ERRORS`);
  if (!errs.length) pass('无页面运行时报错');
  else fail(`有运行时报错：${errs.slice(0, 3).join(' / ')}`);
} finally {
  try { close(); } catch { /* 忽略 */ }
  server.close();
}

console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
process.exit(failures ? 1 : 0);
