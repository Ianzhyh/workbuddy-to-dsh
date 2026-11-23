/**
 * 验证本轮的三个用户诉求：
 *   ① 点「未列出」徽标要有说明（用户：「点击未列出怎么没有提示」）；
 *   ② 「隐藏未列出」开关；
 *   ③ 「只列免费」开关。
 *
 * 同时守住两条容易踩的坑：
 *   · 点徽标**不能顺带切换勾选**（徽标在 <label> 内时就会）；
 *   · 计数条的分母要跟着筛选变（否则隐藏了 37 个还写 /53）。
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startStaticServer, openPage, waitFor, sleep } from '../../tools/dev/ui-harness.mjs';
import { FIXTURES, buildRoutes, ensureVendor, harnessHtml } from './_panel-fixtures.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN = join(HERE, '..');
const PORT = 8935;

async function freeCdpPort() {
  const srv = createServer();
  await new Promise((res, rej) => { srv.once('error', rej); srv.listen(0, '127.0.0.1', res); });
  const p = srv.address().port;
  await new Promise((r) => srv.close(r));
  return p;
}

const { react, reactDom } = await ensureVendor();
const clientSource = readFileSync(join(PLUGIN, 'lib', 'client.js'), 'utf8');
const routes = buildRoutes(FIXTURES);
const staticServer = await startStaticServer(PORT);
const extra = createServer((req, res) => {
  const path = new URL(req.url, `http://127.0.0.1:${PORT}`).pathname;
  if (path === '/harness.html') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(harnessHtml(routes)); }
  if (path === '/client.js') { res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }); return res.end(clientSource); }
  if (path === '/vendor/react.js') { res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }); return res.end(react); }
  if (path === '/vendor/react-dom.js') { res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }); return res.end(reactDom); }
  res.writeHead(404); return res.end('nf');
});
await new Promise((r) => extra.listen(PORT + 1, '127.0.0.1', r));
const page = await openPage(`http://127.0.0.1:${PORT + 1}/harness.html`, {}, { width: 1200, height: 1000, injectStub: false, cdpPort: await freeCdpPort() });

const problems = [];
try {
  await waitFor(page.cdp, 'window.__harness && window.__harness.rendered === true', 15000, '挂载');
  await sleep(400);
  await page.cdp.evaluate(`(() => {
    const root = document.getElementById('root');
    root.innerHTML = '';
    const frame = document.getElementById('frame');
    frame.style.width = '340px'; frame.style.maxWidth = '340px'; frame.style.padding = '0';
    frame.style.background = '#191a1c';
    const host = document.createElement('div');
    host.id = 'rail-host'; host.style.height = '900px'; host.style.overflow = 'hidden';
    root.appendChild(host);
    window.__railRoot = ReactDOM.createRoot(host);
    window.__railRoot.render(React.createElement(window.__module.WorkBuddyRail));
  })()`);
  await waitFor(page.cdp, "document.querySelector('[data-workbuddy-rail]') !== null", 15000, 'rail');
  await sleep(900);

  // ── ① 点「未列出」徽标 ──
  const badge = await page.cdp.evaluate(`JSON.stringify((() => {
    const rail = document.querySelector('[data-workbuddy-rail]');
    const btn = rail.querySelector('.wb-rail-badge-btn');
    if (!btn) return { error: '没有「未列出」徽标', badges: 0 };
    const before = {
      badges: rail.querySelectorAll('.wb-rail-badge-btn').length,
      hintBlocks: rail.querySelectorAll('.wb-rail-unlisted-hint').length,
      expanded: btn.getAttribute('aria-expanded'),
      // 记下同行的 checkbox 状态：点徽标不该动它
      checked: btn.closest('.wb-rail-item') ? btn.closest('.wb-rail-item').querySelector('input[type=checkbox]')?.checked : null,
    };
    btn.click();
    return { before };
  })())`);
  const b1 = JSON.parse(badge);
  if (b1.error) problems.push(b1.error);
  else {
    if (b1.before.badges < 1) problems.push('没有可点击的「未列出」徽标');
    if (b1.before.expanded !== 'false') problems.push(`徽标初始 aria-expanded 应为 false，实际 ${b1.before.expanded}`);
  }
  await sleep(300);
  const afterClick = JSON.parse(await page.cdp.evaluate(`JSON.stringify((() => {
    const rail = document.querySelector('[data-workbuddy-rail]');
    const hint = rail.querySelector('.wb-rail-unlisted-hint');
    const btn = rail.querySelector('.wb-rail-badge-btn.on');
    const cb = rail.querySelector('.wb-rail-badge-btn')?.closest('.wb-rail-item')?.querySelector('input[type=checkbox]');
    return {
      hintShown: Boolean(hint),
      hintText: hint ? hint.innerText.replace(/\\s+/g, ' ').trim() : '',
      hintSentences: hint ? hint.querySelectorAll('p').length : 0,
      hasDismiss: hint ? [...hint.querySelectorAll('button')].some((b) => /知道了/.test(b.textContent)) : false,
      expandedNow: btn ? btn.getAttribute('aria-expanded') : null,
      checkboxChecked: cb ? cb.checked : null,
    };
  })())`));
  console.log('点徽标后：', JSON.stringify(afterClick).slice(0, 260));
  if (!afterClick.hintShown) problems.push('点「未列出」徽标没有出现任何说明（用户明确反馈过这条）');
  if (afterClick.hintSentences < 3) problems.push(`说明应有 3 段（是什么/为什么不在名单/还能不能用），实际 ${afterClick.hintSentences}`);
  if (!/官方/.test(afterClick.hintText)) problems.push(`说明内容不对：${afterClick.hintText.slice(0, 120)}`);
  if (!afterClick.hasDismiss) problems.push('说明块缺少「知道了」收起按钮');
  if (afterClick.expandedNow !== 'true') problems.push(`展开后 aria-expanded 应为 true，实际 ${afterClick.expandedNow}`);
  if (b1.before.checked !== null && afterClick.checkboxChecked !== b1.before.checked) {
    problems.push(`点徽标顺带改了勾选状态（${b1.before.checked} → ${afterClick.checkboxChecked}）—— 徽标必须在 label 外`);
  }

  // ── ② 隐藏未列出 ──
  const beforeHide = JSON.parse(await page.cdp.evaluate(`JSON.stringify((() => {
    const rail = document.querySelector('[data-workbuddy-rail]');
    return {
      rows: rail.querySelectorAll('.wb-rail-list .wb-rail-item').length,
      count: rail.querySelector('.wb-rail-count')?.textContent || '',
      filters: rail.querySelectorAll('.wb-rail-filter').length,
    };
  })())`));
  if (beforeHide.filters !== 2) problems.push(`应有两个筛选开关（隐藏未列出 / 只列免费），实际 ${beforeHide.filters}`);

  const hideResult = JSON.parse(await page.cdp.evaluate(`JSON.stringify((() => {
    const rail = document.querySelector('[data-workbuddy-rail]');
    const labels = [...rail.querySelectorAll('.wb-rail-filter')];
    const target = labels.find((l) => /隐藏未列出/.test(l.textContent));
    if (!target) return { error: '找不到「隐藏未列出」开关' };
    target.querySelector('input').click();
    return { clicked: true };
  })())`));
  if (hideResult.error) problems.push(hideResult.error);
  await sleep(400);
  const afterHide = JSON.parse(await page.cdp.evaluate(`JSON.stringify((() => {
    const rail = document.querySelector('[data-workbuddy-rail]');
    return {
      rows: rail.querySelectorAll('.wb-rail-list .wb-rail-item').length,
      badges: rail.querySelectorAll('.wb-rail-badge-btn').length,
      count: rail.querySelector('.wb-rail-count')?.textContent || '',
    };
  })())`));
  console.log('隐藏未列出后：', JSON.stringify(afterHide));
  if (afterHide.rows >= beforeHide.rows) {
    problems.push(`「隐藏未列出」没有减少行数（${beforeHide.rows} → ${afterHide.rows}）`);
  }
  if (afterHide.badges !== 0) problems.push(`隐藏后仍能看到「未列出」徽标（${afterHide.badges} 个）`);
  if (afterHide.count === beforeHide.count) {
    problems.push(`隐藏后计数条没变（仍是「${afterHide.count}」）—— 分母应跟着筛选走`);
  }

  // ── ③ 只列免费 ──
  const freeResult = JSON.parse(await page.cdp.evaluate(`JSON.stringify((() => {
    const rail = document.querySelector('[data-workbuddy-rail]');
    const labels = [...rail.querySelectorAll('.wb-rail-filter')];
    const target = labels.find((l) => /只列免费/.test(l.textContent));
    if (!target) return { error: '找不到「只列免费」开关' };
    target.querySelector('input').click();
    return { clicked: true };
  })())`));
  if (freeResult.error) problems.push(freeResult.error);
  await sleep(400);
  const afterFree = JSON.parse(await page.cdp.evaluate(`JSON.stringify((() => {
    const rail = document.querySelector('[data-workbuddy-rail]');
    const rows = [...rail.querySelectorAll('.wb-rail-list .wb-rail-item')];
    return {
      rows: rows.length,
      // 每一行都必须带「免费」徽标，否则说明筛选没生效
      rowsWithoutFreeBadge: rows.filter((r) => !/免费/.test(r.textContent)).length,
      activeFilters: rail.querySelectorAll('.wb-rail-filter.on').length,
    };
  })())`));
  console.log('只列免费后：', JSON.stringify(afterFree));
  if (afterFree.rowsWithoutFreeBadge > 0) {
    problems.push(`「只列免费」下仍有 ${afterFree.rowsWithoutFreeBadge} 行不是免费模型`);
  }
  if (afterFree.activeFilters !== 2) {
    problems.push(`两个开关应能**同时**生效（active=2），实际 ${afterFree.activeFilters}`);
  }
} finally {
  try { await page.close?.(); } catch { /* ignore */ }
  staticServer.close(); extra.close();
  if (problems.length) {
    console.error('\n✘ 问题：');
    for (const p of problems) console.error(` - ${p}`);
    process.exit(1);
  }
  console.log('\n✔ 未列出说明 / 隐藏未列出 / 只列免费 全部通过');
  process.exit(0);
}
