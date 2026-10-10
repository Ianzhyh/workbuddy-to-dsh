/**
 * 配色方案：五套强调色 × 两套主题，**共十种组合都要过对比度**。
 *
 *   node tools/dev/test-accent-schemes.mjs
 *
 * ## 为什么值得单独测
 *
 * 配色方案是「改一处令牌、影响全站」的功能：新增一套方案只需要写九个变量，
 * 但它会落到按钮、标签、徽章、选中态、焦点环……**几十个控件**上。
 * 手工一套套看过去既慢又不可靠（浅色好看的那档，深色下常常不够亮）。
 *
 * 所以这里不抽查，而是**把十种组合全部跑一遍**实色填充控件的对比度体检
 * （与 test-solid-contrast.mjs 共用同一份扫描源码，避免两边判据漂移）。
 *
 * 顺带守两件容易坏的事：
 *   1. 每套方案的 `--primary` **必须真的不一样** —— 否则说明 data-accent
 *      的规则没生效（选择器写错、或被默认值盖掉），而界面上看起来"能选"。
 *   2. 选完要能**落盘并读回** —— 刷新后不能变回默认。
 */
import { startStaticServer, openPage, q, sleep } from './ui-harness.mjs';
import { baseRoutes, CATALOG } from './fixtures.mjs';
import { SCAN_SOLID_CONTRAST, ACCENT_IDS, withTransitionsOff } from './contrast-scan.mjs';

let failures = 0;
const pass = (m) => console.log('✓ ' + m);
const fail = (m) => { console.error('✗ ' + m); failures += 1; };

const PORT = 8826;
const URL_ = `http://127.0.0.1:${PORT}/`;

const server = await startStaticServer(PORT);
const { cdp, close } = await openPage(URL_, baseRoutes({ dshReady: true, catalog: CATALOG }), {
  width: 1400, height: 1100, cdpPort: 9376,
});
const cleanup = () => { try { close(); } catch { /* 忽略 */ } try { server.close(); } catch { /* 忽略 */ } };
process.on('exit', cleanup);

const THEMES = ['light', 'dark'];
const seenPrimary = { light: new Set(), dark: new Set() };
let checks = 0;

await sleep(1400);

// 菜单必须真的建出来了 —— 否则下面的"选一套"全是空操作，断言恒真
const itemCount = await q(cdp, `document.querySelectorAll('#accentMenu .accentitem').length`);
if (itemCount === ACCENT_IDS.length) pass(`配色菜单渲染出 ${itemCount} 项`);
else fail(`配色菜单只渲染出 ${itemCount} 项（期望 ${ACCENT_IDS.length}）`);

for (const accent of ACCENT_IDS) {
  for (const theme of THEMES) {
    await q(cdp, `document.documentElement.setAttribute('data-accent','${accent}');
                 document.documentElement.setAttribute('data-theme','${theme}')`);
    /*
     * 测量必须在**关掉过渡**的状态下做，否则读到的是过渡的起始帧或插值中间色：
     *   · 视口外的元素过渡永不推进 → 读数永远停在上一套配色；
     *   · 过渡中途的 bg/fg 不同步 → 量到"深色底 + 浅色字"（屏幕上没有的组合）。
     * 详见 tools/dev/contrast-scan.mjs 文件头。
     */
    const rows = await withTransitionsOff(cdp, () => q(cdp, SCAN_SOLID_CONTRAST));

    const primary = await q(cdp, `getComputedStyle(document.documentElement).getPropertyValue('--primary').trim()`);
    seenPrimary[theme].add(primary);

    const bad = rows.filter((r) => !r.ok);
    checks += rows.length;
    if (bad.length === 0) {
      pass(`[${theme}/${accent}] ${primary} —— ${rows.length} 个控件全部达标`);
    } else {
      for (const r of bad) fail(`[${theme}/${accent}] ${r.sel} 「${r.text}」 ${r.bg} 上压 ${r.fg} 只有 ${r.ratio}:1（要 ${r.need}）`);
    }
  }
}

// 防"方案根本没生效"：五套方案的主色必须各不相同
for (const theme of THEMES) {
  if (seenPrimary[theme].size === ACCENT_IDS.length) pass(`[${theme}] 五套方案的 --primary 各不相同（data-accent 确实生效了）`);
  else fail(`[${theme}] 只有 ${seenPrimary[theme].size} 种不同的 --primary —— 有方案没生效：${[...seenPrimary[theme]].join(', ')}`);
}

// 选完要能落盘、刷新后读回
await q(cdp, `document.documentElement.setAttribute('data-accent','blue');`);
await sleep(150);
await q(cdp, `document.querySelector('#accentMenu .accentitem[data-accent="violet"]').click()`);
await sleep(400);
const afterClick = await q(cdp, `document.documentElement.getAttribute('data-accent')`);
const stored = await q(cdp, `localStorage.getItem('wb.accent')`);
if (afterClick === 'violet' && stored === 'violet') pass('点选后生效并落盘（violet）');
else fail(`点选后状态不对：属性=${afterClick} 存储=${stored}`);

const menuHidden = await q(cdp, `document.getElementById('accentMenu').hidden`);
if (menuHidden) pass('选完自动收起菜单');
else fail('选完菜单没有收起');

await cdp.send('Page.reload', { ignoreCache: false });
await sleep(1200);
const afterReload = await q(cdp, `document.documentElement.getAttribute('data-accent')`);
if (afterReload === 'violet') pass('刷新后读回用户选择（violet）');
else fail(`刷新后变回 ${afterReload} —— 没有落盘或没读回`);

// Esc 与点外部要能关掉
await q(cdp, `document.getElementById('accentToggle').click()`);
await sleep(200);
await q(cdp, `document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
await sleep(200);
if (await q(cdp, `document.getElementById('accentMenu').hidden`)) pass('Esc 能关掉菜单');
else fail('Esc 关不掉菜单');

if (checks < 40) fail(`十种组合一共只量到 ${checks} 个控件 —— 太少，扫描或桩数据有问题（防假绿）`);
else pass(`十种组合共体检 ${checks} 个实色填充控件`);

console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
cleanup();
process.exit(failures ? 1 : 0);
