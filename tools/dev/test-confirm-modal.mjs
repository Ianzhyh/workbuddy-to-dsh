/**
 * 自绘确认框（替代原生 `confirm`）。
 *
 *   node tools/dev/test-confirm-modal.mjs
 *
 * ## 为什么要测
 *
 * 原生 `confirm` 的三个问题：**样式由浏览器决定**（与页面两套观感，深色主题下
 * 弹出来是一片亮白）、**阻塞主线程**、**不在 DOM 里**（i18n 的 DOM 翻译层够不着）。
 * 换成自绘之后，前两个没了，但第三个变成了**新的陷阱**：
 *
 * > 弹窗是**运行时新建**的，而 i18n 的 DOM 扫描早就跑完了 —— 按钮文案若写死
 * > 中文字面量，英文模式下会留中文。所以按钮必须过 `t()`。
 *
 * 这条不测就发现不了（切英文点一下才知道），所以这里专门钉住它。
 *
 * ## 还包含一条静态守卫
 *
 * 源码里**不许再有原生 `confirm(`** —— 否则新加的确认框会悄悄退回浏览器默认样式，
 * 而这种"退回去"在页面上看起来只是"这次弹的框长得不一样"，很容易漏。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startStaticServer, openPage, waitFor, q, sleep } from './ui-harness.mjs';
import { baseRoutes } from './fixtures.mjs';

let failures = 0;
const pass = (m) => console.log('✓ ' + m);
const fail = (m) => { console.error('✗ ' + m); failures += 1; };

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = 8831;
const URL_ = `http://127.0.0.1:${PORT}/`;

// ── 静态守卫：源码里不许再有原生 confirm ─────────────────────────────────
{
  const raw = readFileSync(join(root, 'dashboard', 'public', 'index.html'), 'utf8');
  /*
   * 先剥注释再扫 —— 否则**注释里提到** `confirm(` 也会算命中。
   * 实测踩到过：文档注释里写着「把 `confirm(` 换成 `await appConfirm(`」，
   * 于是这条守卫永远红。只剥「整行注释」与单行块注释：
   * 不能用通用的 `//.*` —— 那会把 `http://127.0.0.1` 这类字符串一起吃掉。
   */
  const noComments = raw
    .replace(/\/\*[\s\S]*?\*\//g, '')          // 块注释（含文档注释）
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))   // 整行行注释 / 注释续行
    .join('\n');

  // `appConfirm(` 里含子串 `Confirm(`，先摘掉再找裸的 confirm(
  const stripped = noComments.replace(/appConfirm\s*\(/g, '').replace(/confirmDangerous/g, '');
  const hits = [...stripped.matchAll(/(^|[^.\w])confirm\s*\(/g)];
  if (hits.length === 0) pass('源码里没有裸的原生 confirm（全部走 appConfirm）');
  else {
    const at = hits.map((m) => stripped.slice(0, m.index).split('\n').length);
    fail(`源码里还有 ${hits.length} 处原生 confirm（约在第 ${at.join('、')} 行）—— 会退回浏览器默认样式`);
  }
}

const MODAL = `JSON.stringify({
  scrim: document.querySelectorAll('.modal-scrim').length,
  dialog: document.querySelectorAll('.modal[role=alertdialog]').length,
  title: document.querySelector('.modal-body p') ? document.querySelector('.modal-body p').textContent : '',
  buttons: [...document.querySelectorAll('.modal-actions button')].map((b) => b.textContent),
  focusIsButton: document.activeElement && document.activeElement.tagName === 'BUTTON',
})`;

const server = await startStaticServer(PORT);
/*
 * `setDialogAuto(false)`：这个用例要**检查弹窗本身**（标题、按钮、焦点、Esc），
 * 所以不能让 harness 自动把它点掉。其余用例默认是自动接管的。
 */
const { cdp, close, setDialogAuto } = await openPage(URL_, baseRoutes(), { width: 1280, height: 900, cdpPort: 9387 });
setDialogAuto(false);
const cleanup = () => { try { close(); } catch { /* 忽略 */ } try { server.close(); } catch { /* 忽略 */ } };
process.on('exit', cleanup);

/** 真实鼠标点击（先滚进视口 —— 切语言后按钮可能被挤出视口，点击会落空）。 */
async function click(sel) {
  /*
   * `behavior: 'instant'` **不能省**。
   *
   * 页面里有 `html { scroll-behavior: smooth }`，而 `scrollIntoView` 默认跟着它走 ——
   * 于是滚到一半就取 `getBoundingClientRect()`，拿到的是**滚动过程中的**坐标，
   * 点击落空。表现为"第一次点击没反应、后面几次正常"（后面页面已经滚到位了），
   * 而且**单独跑通过、在整套里跑失败**（整套里首次点击时页面还在顶部，要滚很远）。
   * 实测踩到：套件里第一次点「清空账本」没弹出弹窗。
   */
  await q(cdp, `document.querySelector(${JSON.stringify(sel)}).scrollIntoView({ block: 'center', behavior: 'instant' })`);
  await sleep(150);
  const b = JSON.parse(await q(cdp, `(() => { const e = document.querySelector(${JSON.stringify(sel)}); const r = e.getBoundingClientRect();
    return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }); })()`));
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: b.x, y: b.y, button: 'left', buttons: 1, clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', buttons: 0, clickCount: 1 });
  await sleep(320);
}
async function esc() {
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await sleep(320);
}

/** 打开弹窗并等它真的挂上（避免"点了但还没渲染"的竞态）。 */
async function openModal() {
  await click('#usageClearBtn');
  await waitFor(cdp, `document.querySelectorAll('.modal-scrim').length > 0`, 3000, '弹窗出现').catch(() => {});
}

try {
  await waitFor(cdp, `document.getElementById('usageClearBtn')`, 10000, '用量面板');
  await sleep(900);

  // ── 打开 ──────────────────────────────────────────────────────────────
  await openModal();
  const open = JSON.parse(await q(cdp, MODAL));
  if (open.scrim === 1 && open.dialog === 1) pass('点「清空账本」弹出的是自绘弹窗（在 DOM 里）');
  else fail(`没弹出弹窗：scrim=${open.scrim} dialog=${open.dialog}`);
  if (open.title) pass(`弹窗标题：${open.title.slice(0, 30)}…`);
  else fail('弹窗没有正文');
  if (open.buttons.length === 2) pass(`两个按钮：${open.buttons.join(' / ')}`);
  else fail(`按钮数异常：${JSON.stringify(open.buttons)}`);
  if (open.focusIsButton) pass('打开时焦点落在按钮上（键盘用户不用先 Tab 一圈）');
  else fail('打开时焦点不在按钮上');

  // ── Esc 取消 ──────────────────────────────────────────────────────────
  await esc();
  if (await q(cdp, `document.querySelectorAll('.modal-scrim').length`) === 0) pass('Esc 关闭弹窗');
  else fail('Esc 没能关闭弹窗');

  // ── 点「取消」 ────────────────────────────────────────────────────────
  await openModal();
  await click('.modal-actions button:first-child');
  if (await q(cdp, `document.querySelectorAll('.modal-scrim').length`) === 0) pass('点「取消」关闭弹窗');
  else fail('点「取消」没关闭');

  // ── 点遮罩 ────────────────────────────────────────────────────────────
  await openModal();
  await q(cdp, `(() => { const s = document.querySelector('.modal-scrim');
    s.dispatchEvent(new MouseEvent('click', { bubbles: true })); })()`);
  await sleep(250);
  if (await q(cdp, `document.querySelectorAll('.modal-scrim').length`) === 0) pass('点遮罩关闭弹窗');
  else fail('点遮罩没关闭');

  // ── 英文模式：按钮必须翻 ──────────────────────────────────────────────
  await q(cdp, `document.getElementById('langToggle').click()`);
  await sleep(900);
  await openModal();
  const en = JSON.parse(await q(cdp, MODAL));
  const zhIn = en.buttons.filter((b) => /[\u4e00-\u9fa5]/.test(b));
  if (zhIn.length === 0) pass(`英文模式按钮已翻译：${en.buttons.join(' / ')}`);
  else fail(`英文模式按钮还留中文：${zhIn.join(', ')}`);
  if (!/[\u4e00-\u9fa5]/.test(en.title)) pass(`英文模式标题已翻译：${en.title.slice(0, 40)}…`);
  else fail(`英文模式标题还留中文：${en.title}`);
  await esc();

  console.log('\n页面错误：', await q(cdp, `JSON.stringify(window.__errors || [])`));
} finally {
  console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
  cleanup();
  process.exit(failures ? 1 : 0);
}
