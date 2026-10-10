/**
 * 主题「跟随系统」：**用户没表态之前一直跟着系统走，表态之后以用户为准**。
 *
 *   node tools/dev/test-theme-follow.mjs
 *
 * ## 为什么必须实测
 *
 * 这条逻辑的正确性**完全**藏在两个不容易看出来的细节里：
 *
 *   1. 初始化时如果 `localStorage.setItem` 照写不误，那么第一次访问就把
 *      "跟随系统"**永久固化**成"记住这一次" —— 之后用户在系统里切深色，
 *      页面不会跟，而且再也回不到跟随状态。代码读起来仍然"在跟随系统"。
 *   2. 跟随必须是**活**的：系统主题变了要当场跟着变，而不是等下次刷新。
 *
 * 这两条都只能靠"改系统偏好 → 看页面"来验，所以用
 * `Emulation.setEmulatedMedia` 真的把 prefers-color-scheme 改掉。
 */
import { startStaticServer, openPage, q, sleep } from './ui-harness.mjs';
import { baseRoutes } from './fixtures.mjs';

let failures = 0;
const pass = (m) => console.log('✓ ' + m);
const fail = (m) => { console.error('✗ ' + m); failures += 1; };

const PORT = 8816;
const URL_ = `http://127.0.0.1:${PORT}/`;

const server = await startStaticServer(PORT);
const { cdp, close } = await openPage(URL_, baseRoutes(), { width: 1200, height: 900, cdpPort: 9366 });
const cleanup = () => { try { close(); } catch { /* 忽略 */ } try { server.close(); } catch { /* 忽略 */ } };
process.on('exit', cleanup);

/** 设系统配色偏好。 */
const setSystem = (v) => cdp.send('Emulation.setEmulatedMedia', {
  features: v ? [{ name: 'prefers-color-scheme', value: v }] : [],
});

/** 清掉本地偏好并重载，模拟"第一次访问这台机器"。 */
async function freshVisit(systemTheme) {
  await q(cdp, `localStorage.removeItem('wb.theme')`);
  await setSystem(systemTheme);
  await cdp.send('Page.reload', { ignoreCache: false });
  for (let i = 0; i < 40; i++) {
    await sleep(100);
    const t = await q(cdp, `document.documentElement.getAttribute('data-theme')`);
    if (t) return t;
  }
  return null;
}

const theme = () => q(cdp, `document.documentElement.getAttribute('data-theme')`);
const saved = () => q(cdp, `localStorage.getItem('wb.theme')`);

// ── 1. 首次访问跟随系统 ────────────────────────────────────────────────
let t = await freshVisit('dark');
if (t === 'dark') pass('首次访问 + 系统深色 → 深色');
else fail('首次访问跟随系统失败：期望 dark，实得 ' + t);

t = await freshVisit('light');
if (t === 'light') pass('首次访问 + 系统浅色 → 浅色');
else fail('首次访问跟随系统失败：期望 light，实得 ' + t);

// ── 2. 跟随来的主题**不能落盘** ────────────────────────────────────────
const persisted = await saved();
if (persisted === null) pass('跟随系统而来的主题没有写进 localStorage（否则就"跟不动"了）');
else fail('初始化就把主题写进了 localStorage（值=' + JSON.stringify(persisted) + '）—— 跟随系统会被固化成记住一次');

// ── 3. 系统当场变，页面要跟着变 ────────────────────────────────────────
await freshVisit('dark');
await setSystem('light');
await sleep(350);
t = await theme();
if (t === 'light') pass('系统切到浅色 → 页面当场跟着变（不必刷新）');
else fail('系统切到浅色后页面没跟：仍是 ' + t);

// ── 4. 用户亲手切换后，系统变化不再覆盖 ────────────────────────────────
await q(cdp, `document.getElementById('themeToggle').click()`);
await sleep(400);
const afterClick = await theme();
const savedAfterClick = await saved();
if (savedAfterClick) pass('用户亲手切换后落盘（值=' + savedAfterClick + '）');
else fail('用户亲手切换后没有落盘 —— 下次访问又会回到跟随系统');

// 现在把系统改成相反值，页面**不该**跟着变
await setSystem(afterClick === 'dark' ? 'light' : 'dark');
await sleep(400);
t = await theme();
if (t === afterClick) pass('用户已表态后，系统主题变化不再覆盖他的选择（保持 ' + t + '）');
else fail('用户的选择被系统覆盖了：' + afterClick + ' → ' + t);

// ── 5. 重新访问时以用户的选择为准 ──────────────────────────────────────
await setSystem(afterClick === 'dark' ? 'light' : 'dark');
await cdp.send('Page.reload', { ignoreCache: false });
await sleep(900);
t = await theme();
if (t === afterClick) pass('再次访问沿用用户的选择（' + t + '），而不是系统偏好');
else fail('再次访问没有沿用用户选择：期望 ' + afterClick + '，实得 ' + t);

await setSystem('');
console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
cleanup();
process.exit(failures ? 1 : 0);
