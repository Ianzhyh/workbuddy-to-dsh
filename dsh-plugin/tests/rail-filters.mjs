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

  // ── ① 点「未列出」徽标 → 出一个 toast（不重复提醒；详见 rail-unlisted-toast.mjs） ──
  /*
   * 这一段的详细断言（恰好一个 toast、浮层可见、aria、自动消失、不误勾选）
   * 都在 `rail-unlisted-toast.mjs` 里。这里只做最小确认：徽标可点、
   * 且**没有**行内说明块残留（那会与 toast 重复，用户明确要求不要）。
   */
  const badge = JSON.parse(await page.cdp.evaluate(`JSON.stringify((() => {
    const rail = document.querySelector("[data-workbuddy-rail]");
    const btn = rail.querySelector(".wb-rail-badge-btn");
    return {
      badges: rail.querySelectorAll(".wb-rail-badge-btn").length,
      inlineHints: rail.querySelectorAll(".wb-rail-unlisted-hint").length,
      hasExpanded: btn ? btn.hasAttribute("aria-expanded") : null,
      label: btn ? (btn.getAttribute("aria-label") || "") : "",
    };
  })())`));
  console.log("徽标：", JSON.stringify(badge));
  if (badge.badges < 1) problems.push("没有可点击的「未列出」徽标");
  if (badge.inlineHints !== 0) {
    problems.push(`仍有行内说明块（${badge.inlineHints} 个）—— 与 toast 重复，用户要求不要重复提醒`);
  }
  /* 没有展开态了，就不该再挂 aria-expanded（否则读屏会念一个不存在的状态） */
  if (badge.hasExpanded === true) problems.push("徽标仍有 aria-expanded，但已无展开态");
  if (!/点击查看说明/.test(badge.label)) problems.push(`徽标 aria-label 应说明可点击，实际「${badge.label}」`);

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
