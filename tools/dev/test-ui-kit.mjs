/**
 * 控制台「自绘控件」验收：下拉（.dd-*）与提示气泡（.tip）。
 *
 *   node tools/dev/test-ui-kit.mjs
 *
 * ## 为什么要单独一条
 *
 * 这两块都是「把系统自带的那一层换成本地绘制」，而它们**必须同时满足两个约束**：
 *   1. 用户看到的是自绘的那层（圆角、主题色、动画）；
 *   2. **原生控件仍然是真值来源** —— `.value` / `.options` / `change` / 盒模型照旧，
 *      否则所有自动化用例（它们直接写 `.value` 再派 `change`）全部失效。
 *
 * 第 2 条尤其容易在后续改动里被破坏（比如"顺手"把原生 `<select>` 改成 display:none，
 * 或者不再派 change）。所以这里逐条钉住。
 *
 * 提示气泡还有个反直觉点：**浏览器没有禁用 `title` 提示的开关**，只能悬停时把
 * `title` 摘下来。所以断言里既要有「气泡出现」，也要有「title 被摘下 / 移开后还原」。
 */
import { startStaticServer, openPage, waitFor, q, sleep } from './ui-harness.mjs';
import { baseRoutes, CATALOG } from './fixtures.mjs';

const PORT = 8778;

let failures = 0;
const fail = (m) => { console.error('✗ ' + m); failures += 1; };
const pass = (m) => console.log('✓ ' + m);

const server = await startStaticServer(PORT);
const routes = baseRoutes({
  dshReady: false,
  catalog: CATALOG.map((m, i) => (i === 1 ? { ...m, badge: '限时免费' } : m)),
});
const { cdp, close } = await openPage(`http://127.0.0.1:${PORT}/`, routes, {
  width: 1280, height: 900,
  inject: `window.__ERRORS = []; window.addEventListener('error', (e) => window.__ERRORS.push(String(e.message)));`,
});

try {
  await waitFor(cdp, `document.querySelectorAll('#modelTable tbody tr').length > 0`, 15000, '模型表渲染');
  await sleep(700);

  // ── 1. 每个原生 select 都被包成 .dd ────────────────────────────────────
  const info = await q(cdp, `(() => {
    const sels = [...document.querySelectorAll('select')];
    return {
      selects: sels.length,
      enhanced: sels.filter((s) => s.dataset.ddOn === '1').length,
      triggers: document.querySelectorAll('.dd-trigger').length,
      emptyLabels: [...document.querySelectorAll('.dd-label')].filter((e) => !e.textContent.trim()).length,
    };
  })()`);
  if (info.selects > 0 && info.enhanced === info.selects && info.triggers === info.selects) {
    pass(`${info.selects} 个原生 select 全部增强（触发器 ${info.triggers} 个）`);
  } else {
    fail(`增强不全：select=${info.selects} enhanced=${info.enhanced} triggers=${info.triggers}`);
  }
  if (info.emptyLabels === 0) pass('所有触发器都有文案（没有空白下拉）');
  else fail(`${info.emptyLabels} 个触发器文案为空`);

  // ── 2. 原生 select 仍是真值来源 ────────────────────────────────────────
  // 盒模型必须还在（自动化用例会量它、也要能点）
  const box = await q(cdp, `(() => {
    const s = document.getElementById('trendGran');
    const r = s.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height) };
  })()`);
  if (box.w > 20 && box.h >= 30) pass(`原生 select 盒模型保留（${box.w}×${box.h}）`);
  else fail(`原生 select 盒模型异常：${JSON.stringify(box)}`);

  // 程序化写 .value + 派 change → 触发器文案要跟上
  await q(cdp, `(() => { const s = document.getElementById('trendMetric'); s.value = 'credit'; s.dispatchEvent(new Event('change')); })()`);
  await sleep(400);
  const afterSet = await q(cdp, `(() => {
    const s = document.getElementById('trendMetric');
    return { value: s.value, label: s.closest('.dd').querySelector('.dd-label').textContent };
  })()`);
  if (afterSet.value === 'credit' && afterSet.label.trim() === '积分') {
    pass(`程序化改值后触发器跟上：value=${afterSet.value} label=${afterSet.label}`);
  } else fail(`触发器没跟上：${JSON.stringify(afterSet)}`);

  // ── 3. 点菜单条目要写回原生 select 并派 change ─────────────────────────
  await q(cdp, `(() => {
    const dd = document.getElementById('trendGran').closest('.dd');
    dd.scrollIntoView({ block: 'center' });
  })()`);
  await sleep(300);
  await q(cdp, `(() => { document.getElementById('trendGran').closest('.dd').querySelector('.dd-trigger').click(); })()`);
  await sleep(350);
  const menu = await q(cdp, `(() => {
    const dd = document.getElementById('trendGran').closest('.dd');
    const m = dd.querySelector('.dd-menu');
    if (!m) return { open: false };
    return { open: true, items: m.querySelectorAll('.dd-item').length,
      radius: getComputedStyle(m).borderRadius,
      itemRadius: getComputedStyle(m.querySelector('.dd-item')).borderRadius };
  })()`);
  if (menu.open && menu.items >= 2) pass(`菜单打开，${menu.items} 个条目，圆角 ${menu.radius} / 条目 ${menu.itemRadius}`);
  else fail(`菜单没打开或条目不对：${JSON.stringify(menu)}`);

  await q(cdp, `(() => { const dd = document.getElementById('trendGran').closest('.dd');
    const items = dd.querySelectorAll('.dd-item'); items[items.length - 1].click(); })()`);
  await sleep(350);
  const picked = await q(cdp, `(() => {
    const s = document.getElementById('trendGran');
    const dd = s.closest('.dd');
    return { value: s.value, label: dd.querySelector('.dd-label').textContent, open: dd.classList.contains('open') };
  })()`);
  if (picked.value === 'hour' && picked.label.trim() === '最近 24 小时' && !picked.open) {
    pass(`点条目写回原生 select 并关菜单：value=${picked.value} label=${picked.label}`);
  } else fail(`点条目结果不对：${JSON.stringify(picked)}`);

  // 动态渲染出来的 select（#probeScope 是 innerHTML 拼的）也要被增强
  const dynamic = await q(cdp, `(() => {
    const s = document.getElementById('probeScope');
    return s ? s.dataset.ddOn === '1' : null;
  })()`);
  if (dynamic === true) pass('动态渲染的 select（#probeScope）也被增强');
  else fail(`动态渲染的 select 没被增强：${dynamic}`);

  // ── 4. 提示气泡 ────────────────────────────────────────────────────────
  // 自动挑一个**视口内可见**的带 title 元素（控制台是整页固定 + 内部滚动，
  // 写死选择器很容易落到视口外，鼠标事件就不会命中）
  const pick = await q(cdp, `(() => {
    const cands = [...document.querySelectorAll('[title]')].filter((e) => {
      const r = e.getBoundingClientRect();
      return r.width > 8 && r.height > 8 && r.top >= 0 && r.bottom <= innerHeight;
    }).sort((a, b) => (b.getAttribute('title') || '').length - (a.getAttribute('title') || '').length);
    const el = cands[0];
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { title: el.getAttribute('title'), x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);
  if (!pick) throw new Error('视口内找不到带 title 的元素');
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pick.x, y: pick.y, buttons: 0 });
  await sleep(350);
  const tip = await q(cdp, `(() => {
    const el = document.elementFromPoint(${pick.x}, ${pick.y});
    const owner = el && el.closest('[title], [data-tip]');
    const t = document.getElementById('tip');
    if (!t) return { tipExists: false };
    return { tipExists: true, hidden: t.hidden, text: t.textContent,
      ownerTitle: owner ? owner.getAttribute('title') : null,
      radius: getComputedStyle(t).borderRadius };
  })()`);
  if (tip.tipExists && !tip.hidden && tip.text.trim()) pass(`悬停出现自绘气泡（圆角 ${tip.radius}）：${tip.text.slice(0, 40)}`);
  else fail(`气泡没出现：${JSON.stringify(tip)}`);
  if (tip.ownerTitle === null) pass('悬停期间 title 已摘下（原生提示框不会弹）');
  else fail(`悬停期间 title 还在：${tip.ownerTitle}`);

  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 4, y: 4, buttons: 0 });
  await sleep(300);
  const after = await q(cdp, `(() => {
    const t = document.getElementById('tip');
    const el = document.elementFromPoint(${pick.x}, ${pick.y});
    const owner = el && el.closest('[title], [data-tip]');
    return { tipHidden: t ? t.hidden : null, restored: owner ? owner.getAttribute('title') : null };
  })()`);
  if (after.tipHidden === true && after.restored === pick.title) pass('移开后气泡收起、title 还原');
  else fail(`移开后状态不对：${JSON.stringify(after)}`);

  // ── 5. 无运行时报错 ────────────────────────────────────────────────────
  const errs = await q(cdp, `window.__ERRORS || []`);
  if (!errs.length) pass('无运行时报错');
  else fail('运行时报错：' + errs.join(' | '));
} finally {
  close();
  server.close();
}

console.log(`\n${failures ? '✗ 失败 ' + failures + ' 项' : '✓ 全部通过'}`);
process.exit(failures ? 1 : 0);
