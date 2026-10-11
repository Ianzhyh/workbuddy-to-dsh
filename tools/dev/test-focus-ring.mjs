/**
 * 焦点可见性守卫：**凡能被键盘 Tab 到的元素，聚焦后屏幕上必须有可见变化。**
 *
 *   node tools/dev/test-focus-ring.mjs
 *
 * ## 为什么需要它
 *
 * 规范（`docs/UI-GUIDELINES.md` 第 7 条）写着「焦点走到哪都要看得见」，但此前
 * **没有任何用例在量它** —— 全是靠人肉 Tab 一遍。于是两类缺陷长期存在：
 *
 *   1. **同特异性陷阱把焦点环吃掉**。`button:focus-visible`（0,1,1）设
 *      `box-shadow: var(--ring)`，而 `button.primary`（0,1,1）设
 *      `box-shadow: var(--shadow-primary-sm)` —— 同特异性下靠后的胜出，
 *      于是**所有主按钮聚焦时屏幕上什么都不变**。读代码完全看不出来。
 *   2. **写了 `outline: none` 却没给替代**。`#logDrawer > summary` 就是这样，
 *      键盘 Tab 到「查看桥日志」时毫无反馈。
 *
 * 这两类都是"读代码看不出来、必须真聚焦一次才知道"的问题，所以只能在真实浏览器里量。
 *
 * ## 判据
 *
 * 对每个可交互元素：先 `blur()` 取基线，再 `focus()` 取终值，比较
 * `outline*` / `box-shadow` / `border-*-color` / `background-color` / `color` /
 * `text-decoration-line`。**全部没变 = 没有可见焦点指示**。
 *
 * ## 三个必须做对的地方
 *
 * - **要逐视图**。控制台是标签页结构，未激活的面板不渲染 —— 只审概览页会漏掉
 *   整个「客户端接入」面板与日志抽屉（实测漏了 9 个元素，其中 1 个是真缺陷）。
 * - **要先建立"键盘模态"**。不先发一次真实 Tab 键，后续 `focus()` 不命中
 *   `:focus-visible`，会把**所有**元素误判成"没有焦点环"。
 * - **测量期间关掉过渡**。焦点环本身是过渡属性，不关的话读到的是过渡起始帧。
 *
 * ## 与「焦点环够不够显眼」的分工
 *
 * 本用例只保证**有**可见变化（WCAG AA 2.4.7 的要求）。
 * 环的**对比度**是另一件事：实测浅色 1.43:1 / 深色 2.08:1，低于 AAA 2.4.11
 * 建议的 3:1 —— 那是设计取舍（柔和光环 vs 实色描边），不在本用例的判据里。
 */
import { startStaticServer, openPage, waitFor, q, sleep } from './ui-harness.mjs';
import { baseRoutes } from './fixtures.mjs';

let failures = 0;
const pass = (m) => console.log('✓ ' + m);
const fail = (m) => { console.error('✗ ' + m); failures += 1; };

const PORT = 8826;
const URL_ = `http://127.0.0.1:${PORT}/`;

/** 页面里的体检器：逐个聚焦可交互元素，比较聚焦前后的计算样式。 */
const AUDIT = `(() => {
  const SEL = 'button, a[href], input, select, textarea, summary, [tabindex]:not([tabindex="-1"])';
  const READ = ['outlineStyle','outlineWidth','outlineColor','boxShadow','borderTopColor','borderBottomColor','backgroundColor','color','textDecorationLine'];
  const snap = (el) => { const cs = getComputedStyle(el); const o = {}; for (const k of READ) o[k] = cs[k]; return o; };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0';
  };
  const diff = (a, b) => READ.filter((k) => a[k] !== b[k]);

  /*
   * 为什么聚焦会失败：disabled、祖先 display:none / visibility:hidden、
   * 或祖先 <details> 未展开。这几种**不是缺陷**（元素本就不该被 Tab 到），
   * 必须与"能聚焦却没焦点环"分开 —— 否则会报一堆假阳性。
   */
  const whyNotFocusable = (el) => {
    if (el.disabled) return 'disabled';
    let p = el;
    while (p && p !== document.body) {
      const cs = getComputedStyle(p);
      if (cs.display === 'none') return 'display:none 祖先';
      if (cs.visibility === 'hidden') return 'visibility:hidden 祖先';
      p = p.parentElement;
    }
    return '';
  };

  const out = [];
  const seen = new Set();
  for (const el of [...document.querySelectorAll(SEL)].filter(visible)) {
    const key = el.tagName + '.' + (el.className || '') + '#' + (el.id || '');
    if (seen.has(key)) continue;
    seen.add(key);

    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
    void document.body.offsetWidth;
    const before = snap(el);

    el.focus();
    void document.body.offsetWidth;
    const after = snap(el);

    const changed = diff(before, after);
    const hasOutline = after.outlineStyle !== 'none' && parseFloat(after.outlineWidth) > 0;
    const changedVisible = changed.filter((k) => k !== 'outlineColor').length > 0;
    const isFocused = document.activeElement === el;

    out.push({
      tag: el.tagName.toLowerCase(),
      cls: String(el.className || '').slice(0, 40),
      id: el.id || '',
      text: (el.textContent || '').trim().slice(0, 18),
      focusable: isFocused,
      why: isFocused ? '' : whyNotFocusable(el),
      ok: hasOutline || changedVisible,
    });
    el.blur();
  }
  return out;
})()`;

/** 把浏览器拉到"键盘模态"，否则后续 focus() 不命中 :focus-visible，会全体误判。 */
async function enterKeyboardMode(cdp) {
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 9, key: 'Tab', code: 'Tab' });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 9, key: 'Tab', code: 'Tab' });
  await sleep(120);
}

/*
 * 逐视图审计。未激活的页签面板不渲染，只审一个视图会漏掉大半控件。
 * 「日志抽屉」单独列，因为它默认折叠、内容在展开后才进 DOM。
 */
const VIEWS = [
  { name: '概览', setup: `switchTab('overview')` },
  { name: '模型', setup: `switchTab('models')` },
  { name: '对话测试', setup: `switchTab('playground')` },
  { name: '客户端接入', setup: `switchTab('clients')` },
  { name: '日志抽屉', setup: `(() => { const d = document.getElementById('logDrawer'); if (d) { d.open = true; d.dispatchEvent(new Event('toggle')); } })()` },
];

const server = await startStaticServer(PORT);
// 桥跑起来、目录非空 —— 让「主按钮」这类只在有数据时才出现的控件真的渲染出来
const { cdp, close } = await openPage(URL_, baseRoutes(), { width: 1440, height: 900, cdpPort: 9376 });
const cleanup = () => { try { close(); } catch { /* 忽略 */ } try { server.close(); } catch { /* 忽略 */ } };
process.on('exit', cleanup);

let checked = 0;

await waitFor(cdp, `document.querySelectorAll('.nav-tab').length >= 4`, 10000, '页签就绪');

// 测量期间关掉过渡（只注入一次，之后一直有效）
await q(cdp, `(() => {
  if (document.getElementById('__focus_test__')) return;
  const st = document.createElement('style');
  st.id = '__focus_test__';
  st.textContent = '*,*::before,*::after{transition:none!important;animation:none!important}';
  document.head.appendChild(st);
  void document.body.offsetWidth;
})()`);

for (const view of VIEWS) {
  await q(cdp, view.setup);
  await sleep(500);
  await enterKeyboardMode(cdp);

  const rows = await q(cdp, AUDIT);
  const bad = rows.filter((r) => r.focusable && !r.ok);
  const good = rows.filter((r) => r.focusable && r.ok);

  console.log(`\n── ${view.name}：${rows.length} 类元素，可聚焦 ${good.length + bad.length} ──`);
  checked += good.length + bad.length;

  for (const r of bad) {
    const sel = `<${r.tag}${r.id ? '#' + r.id : ''}${r.cls ? '.' + r.cls.split(' ').join('.') : ''}>`;
    fail(`[${view.name}] ${sel} 「${r.text}」聚焦后计算样式**零变化** —— 键盘用户看不见焦点在哪`);
  }
  if (bad.length === 0 && good.length > 0) pass(`[${view.name}] ${good.length} 个可聚焦元素全部有可见焦点指示`);
  if (good.length === 0) fail(`[${view.name}] 一个可聚焦元素都没量到 —— 视图没渲染出来？`);
}

/*
 * 防假绿：总样本太少说明桩数据或选择器坏了，
 * 「没渲染 = 0 失败」不能算通过（对比度用例同款守卫）。
 */
if (checked < 30) fail(`全部视图只量到 ${checked} 个可聚焦元素 —— 太少，扫描或桩数据有问题（防假绿）`);
else pass(`五个视图共体检 ${checked} 个可聚焦元素`);

console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
cleanup();
process.exit(failures ? 1 : 0);
