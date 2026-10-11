/**
 * 自绘下拉（`.dd`）能不能**真的打开**。
 *
 *   node tools/dev/test-dropdowns.mjs
 *
 * ## 为什么需要它
 *
 * 第一版检查只看了「点第一个下拉，DOM 里有没有 `.dd-menu`」—— 于是漏掉了一个
 * **真 bug**：`#probeScope`（体检范围）**点了打不开**。
 *
 * 根因：它被包在 `<label class="check">范围<select>…</select></label>` 里。
 * 点 label 内部的任何地方，浏览器都会**额外给 label 的控件转发一次 click**；
 * 那次是独立事件，触发器上的 `stopPropagation` 拦不住，于是它冒泡到 document
 * 触发了「点外面就关」，菜单**刚开就被关**。9 个下拉里只有它一个在 label 里，
 * 所以只有它坏 —— 而"只测第一个"的检查方式永远看不到。
 *
 * ## 判据（四条）
 *
 * 1. **真实点击能打开** —— 用 CDP 派发真鼠标事件（不是 `el.click()`），
 *    且**必须先确保它是关闭态**，否则测的是"点击能不能关掉一个已开的"。
 * 2. **菜单在视口内** —— 超出视口的菜单用户看不见。注意得先把触发器滚进视口
 *    再点，否则量出来全是假象。
 * 3. **没被祖先裁掉** —— 绝对定位的菜单会被 `overflow: hidden` 的祖先切掉。
 * 4. **没被别的层盖住** —— `elementFromPoint` 量菜单中心点被谁接住。
 */
import { startStaticServer, openPage, waitFor, q, sleep } from './ui-harness.mjs';
import { baseRoutes } from './fixtures.mjs';

let failures = 0;
let lastLayout = null;
const pass = (m) => console.log('✓ ' + m);
const fail = (m) => { console.error('✗ ' + m); failures += 1; };

const PORT = 8832;
const URL_ = `http://127.0.0.1:${PORT}/`;

/** 打开第 i 个下拉并量它的几何 / 遮挡。 */
const OPEN_AND_MEASURE = (i) => `(() => {
  const dd = [...document.querySelectorAll('.dd')][${i}];
  if (!dd) return JSON.stringify({ err: '没有第 ${i} 个下拉' });
  const id = (dd.querySelector('select') || {}).id || '(无)';
  const trig = dd.querySelector('.dd-trigger');
  if (!trig) return JSON.stringify({ id, err: '没有 .dd-trigger' });

  // 先滚进视口（instant：页面有 scroll-behavior:smooth，动画中取的矩形是过时的）
  trig.scrollIntoView({ block: 'center', behavior: 'instant' });
  ddClose(dd);                       // 确保从**关闭**态开始
  const tr = trig.getBoundingClientRect();

  const menu = dd.querySelector('.dd-menu');
  if (menu) return JSON.stringify({ id, err: '点击前菜单就已存在' });

  const cx = Math.round(tr.x + tr.width / 2), cy = Math.round(tr.y + tr.height / 2);
  /*
   * 记下点击点**当前**被谁接住 —— 真鼠标事件走完整管线，若被浮层（吸顶条、
   * 提示气泡）盖住，click 就落不到触发器上，表现为"点了没反应"。
   * 程序化 el.click() 不受这个影响，所以这条只在真实点击的用例里能抓到。
   */
  const hit = document.elementFromPoint(cx, cy);
  return JSON.stringify({ id, cx, cy, inLabel: !!dd.closest('label'),
    hitIsTrigger: !!(hit && (hit === trig || trig.contains(hit))),
    hitTag: hit ? hit.tagName.toLowerCase() + '.' + String(hit.className || '').slice(0, 24) : null });
})()`;

const MEASURE_AFTER = (i) => `(() => {
  const dd = [...document.querySelectorAll('.dd')][${i}];
  const menu = dd.querySelector('.dd-menu');
  if (!menu) return JSON.stringify({ open: false });
  const r = menu.getBoundingClientRect();
  const clippers = [];
  for (let p = menu.parentElement; p && p !== document.body; p = p.parentElement) {
    const cs = getComputedStyle(p);
    if (cs.overflow === 'visible' && cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
    const pr = p.getBoundingClientRect();
    if (r.bottom > pr.bottom + 0.5 || r.right > pr.right + 0.5 || r.top < pr.top - 0.5 || r.left < pr.left - 0.5) {
      clippers.push(String(p.className || p.tagName).slice(0, 24) + '/' + cs.overflow);
    }
  }
  const hx = Math.min(Math.max(r.x + r.width / 2, 1), innerWidth - 1);
  const hy = Math.min(Math.max(r.y + Math.min(r.height / 2, 20), 1), innerHeight - 1);
  const hit = document.elementFromPoint(hx, hy);
  return JSON.stringify({
    open: true,
    items: menu.querySelectorAll('.dd-item').length,
    inViewport: r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight + 0.5 && r.right <= innerWidth + 0.5,
    clippers,
    hitIsMenu: !!(hit && (menu === hit || menu.contains(hit))),
    hitTag: hit ? hit.tagName.toLowerCase() + '.' + String(hit.className || '').slice(0, 20) : null,
  });
})()`;

const server = await startStaticServer(PORT);
const { cdp, close } = await openPage(URL_, baseRoutes(), { width: 1280, height: 900, cdpPort: 9390 });
const cleanup = () => { try { close(); } catch { /* 忽略 */ } try { server.close(); } catch { /* 忽略 */ } };
process.on('exit', cleanup);

try {
  await waitFor(cdp, `document.querySelectorAll('.dd').length >= 5`, 10000, '自绘下拉');
  await sleep(800);

  /*
   * 先等页面布局稳定再开始，且**测量与点击之间不留 sleep**。
   *
   * 实测踩到：第一批数据（overview / models / usage / clients）陆续到达会让页面
   * 继续位移；若量完坐标先睡 150ms 再点，那一下就落在别处 —— 日志里只有
   * `closeAll`、`ddOpen` 从没被调用，看起来像"这个下拉点不开"，其实是**测试的
   * 时序问题**。靠后的下拉不会中招（那时页面已经稳定），所以只有第一个失败。
   *
   * 判稳的判据用整页高度 + 第一个触发器的纵坐标：连续两次一致就认为不再动了。
   */
  let stableFor = 0;
  for (let i = 0; i < 40 && stableFor < 3; i += 1) {
    const s = await q(cdp, `(() => {
      const t = document.querySelector('.dd-trigger');
      return document.body.scrollHeight + '|' + (t ? Math.round(t.getBoundingClientRect().y) : '-');
    })()`);
    stableFor = s === lastLayout ? stableFor + 1 : 0;
    lastLayout = s;
    await sleep(250);
  }
  if (stableFor >= 3) pass('页面布局已稳定（高度与触发器位置连续 3 次一致）');
  else fail('页面布局一直不稳定 —— 后面的坐标测量不可信');

  const n = await q(cdp, `document.querySelectorAll('.dd').length`);
  console.log(`\n共 ${n} 个自绘下拉，逐个用**真实鼠标点击**打开：\n`);

  let checked = 0;
  for (let i = 0; i < n; i += 1) {
    const pre = JSON.parse(await q(cdp, OPEN_AND_MEASURE(i)));
    if (pre.err) { fail(`[${i}] ${pre.id || '?'}：${pre.err}`); continue; }

    // 真鼠标点击 —— 不是 el.click()。label 转发那条路径只有真实点击才会走到。
    // 这里**不能再 sleep**：量完坐标一睡，页面可能已经位移（见上面的说明）。
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pre.cx, y: pre.cy, button: 'left', buttons: 1, clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pre.cx, y: pre.cy, button: 'left', buttons: 0, clickCount: 1 });
    await sleep(300);

    const r = JSON.parse(await q(cdp, MEASURE_AFTER(i)));
    checked += 1;
    const where = pre.inLabel ? '（在 <label> 里）' : '';

    if (!r.open) {
      fail(`[${i}] ${pre.id}${where} 点了**没有打开** —— 用户看到的就是"这个下拉点不开"`
        + `（点击点 (${pre.cx},${pre.cy}) 命中的是 ${pre.hitTag}${pre.hitIsTrigger ? ' = 触发器本身' : ''}）`);
      continue;
    }
    const flags = [];
    if (r.items < 1) flags.push('菜单里没有选项');
    if (!r.inViewport) flags.push('菜单超出视口');
    if (r.clippers.length) flags.push(`被祖先裁掉（${r.clippers.join(',')}）`);
    if (!r.hitIsMenu) flags.push(`被盖住（命中的是 ${r.hitTag}）`);
    if (flags.length) fail(`[${i}] ${pre.id}${where} ${r.items} 项 —— ${flags.join('；')}`);
    else pass(`[${i}] ${pre.id}${where} ${r.items} 项，可见且未被遮挡`);

    await q(cdp, `ddClose(document.querySelectorAll('.dd')[${i}])`);
    await sleep(120);
  }

  /*
   * 防假绿：一个都没量到说明选择器或桩数据坏了。
   * 另：**必须真的覆盖到"在 <label> 里的那个"** —— 那正是出过 bug 的那类。
   */
  if (checked < 5) fail(`只量到 ${checked} 个下拉 —— 太少（防假绿）`);
  else pass(`共量到 ${checked} 个下拉`);

  const inLabel = await q(cdp, `[...document.querySelectorAll('.dd')].filter((d) => d.closest('label')).length`);
  if (inLabel >= 1) pass(`覆盖到了 ${inLabel} 个「包在 <label> 里」的下拉（出过 bug 的那类）`);
  else fail('没有「包在 <label> 里」的下拉 —— 这条最容易坏的路径没被覆盖到');

  // 选一项要真的改到值 + 触发器文案跟着走
  const pick = JSON.parse(await q(cdp, `(() => {
    const dd = document.querySelectorAll('.dd')[0];
    const trig = dd.querySelector('.dd-trigger');
    trig.scrollIntoView({ block: 'center', behavior: 'instant' });
    ddClose(dd);
    trig.click();
    const items = [...dd.querySelectorAll('.dd-item')];
    const target = items[items.length - 1];
    const before = dd.querySelector('.dd-label').textContent;
    target.click();
    const sel = dd.querySelector('select');
    return JSON.stringify({ before, after: dd.querySelector('.dd-label').textContent,
      value: sel.value, menuGone: !dd.querySelector('.dd-menu') });
  })()`));
  if (pick.after !== pick.before && pick.menuGone) pass(`选一项后触发器文案从「${pick.before}」变为「${pick.after}」且菜单收起`);
  else fail(`选项交互异常：${JSON.stringify(pick)}`);
} finally {
  console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
  cleanup();
  process.exit(failures ? 1 : 0);
}
