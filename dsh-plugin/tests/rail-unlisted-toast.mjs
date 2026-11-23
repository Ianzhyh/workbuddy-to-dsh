/**
 * 验证用户这两条反馈的修复：
 *   1. 「现在也勾选不了啊，你这就完全不然我勾」—— 勾选必须真的生效；
 *   2. 「点未列出不应该给个 toast 提醒吗」+「不要重复提醒」
 *      —— 点徽标只出现**一个** toast，不再有行内说明块。
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startStaticServer, openPage, waitFor, sleep } from '../../tools/dev/ui-harness.mjs';
import { FIXTURES, buildRoutes, ensureVendor, harnessHtml } from './_panel-fixtures.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN = join(HERE, '..');
const PORT = 8937;

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

  // ── ① 勾选「未列出」的模型必须生效 ──
  const toggle = JSON.parse(await page.cdp.evaluate(`JSON.stringify((() => {
    const rail = document.querySelector('[data-workbuddy-rail]');
    // 找一个带「未列出」徽标的行（这些正是之前勾不上的）
    const badge = rail.querySelector('.wb-rail-badge-btn');
    if (!badge) return { error: '没有未列出徽标' };
    const row = badge.closest('.wb-rail-item') || badge.parentElement.querySelector('.wb-rail-item');
    const cb = row ? row.querySelector('input[type=checkbox]') : null;
    if (!cb) return { error: '找不到该行的 checkbox' };
    const before = { checked: cb.checked, disabled: cb.disabled };
    cb.click();
    return { before };
  })())`));
  if (toggle.error) problems.push(toggle.error);
  await sleep(350);
  const afterToggle = JSON.parse(await page.cdp.evaluate(`JSON.stringify((() => {
    const rail = document.querySelector('[data-workbuddy-rail]');
    const badge = rail.querySelector('.wb-rail-badge-btn');
    const row = badge ? (badge.closest('.wb-rail-item') || badge.parentElement.querySelector('.wb-rail-item')) : null;
    const cb = row ? row.querySelector('input[type=checkbox]') : null;
    return {
      checked: cb ? cb.checked : null,
      rowClass: row ? row.className : '',
      dock: rail.querySelector('.wb-rail-dock')?.textContent || '',
    };
  })())`));
  console.log('勾选前/后：', JSON.stringify(toggle.before), '→', JSON.stringify(afterToggle));
  if (toggle.before?.disabled) problems.push('「未列出」模型的 checkbox 仍然是 disabled');
  if (afterToggle.checked === toggle.before?.checked) {
    problems.push(`勾选没有生效（${toggle.before?.checked} 未变）—— 这正是用户说的"完全不让勾"`);
  }
  if (!/保存/.test(afterToggle.dock)) problems.push('勾选后底栏没有出现「保存」');
  if (!/\bon\b/.test(afterToggle.rowClass)) problems.push(`勾选后行没有 .on 选中态：${afterToggle.rowClass}`);

  // ── ② 点徽标只出一个 toast，且没有行内说明块 ──
  const click = JSON.parse(await page.cdp.evaluate(`JSON.stringify((() => {
    const rail = document.querySelector('[data-workbuddy-rail]');
    const badge = rail.querySelector('.wb-rail-badge-btn');
    const before = { toasts: document.querySelectorAll('.wb-rail-toast').length };
    badge.click();
    return { before };
  })())`));
  await sleep(300);
  const afterClick = JSON.parse(await page.cdp.evaluate(`JSON.stringify((() => {
    const toasts = [...document.querySelectorAll('.wb-rail-toast')];
    const rail = document.querySelector('[data-workbuddy-rail]');
    return {
      toastCount: toasts.length,
      toastText: toasts[0] ? toasts[0].textContent.trim() : '',
      toastRole: toasts[0] ? toasts[0].getAttribute('role') : '',
      toastAriaLive: toasts[0] ? toasts[0].getAttribute('aria-live') : '',
      /* 浮层必须真的在视口内可见 */
      toastVisible: (() => {
        if (!toasts[0]) return false;
        const r = toasts[0].getBoundingClientRect();
        const cs = getComputedStyle(toasts[0]);
        return cs.position === 'fixed' && r.width > 40 && r.height > 10;
      })(),
      /* 旧的实例：行内说明块必须已删除 */
      inlineHints: rail.querySelectorAll('.wb-rail-unlisted-hint').length,
    };
  })())`));
  console.log('点徽标后：', JSON.stringify(afterClick));
  if (click.before.toasts > 0) problems.push('点击前就存在 toast（应只在点击后出现）');
  if (afterClick.toastCount !== 1) {
    problems.push(`点徽标应出现**恰好一个** toast（用户要求"不要重复提醒"），实际 ${afterClick.toastCount} 个`);
  }
  if (!afterClick.toastText) problems.push('toast 没有文字');
  if (afterClick.toastRole !== 'status') problems.push(`toast 的 role 应为 status，实际 ${afterClick.toastRole}`);
  if (afterClick.toastAriaLive !== 'polite') problems.push(`toast 应 polite 播报，实际 ${afterClick.toastAriaLive}`);
  if (!afterClick.toastVisible) problems.push('toast 不是可见的浮层（position 应为 fixed 且在视口内）');
  if (afterClick.inlineHints > 0) {
    problems.push(`仍存在行内说明块（${afterClick.inlineHints} 个）—— 与 toast 重复，用户明确要求不要重复`);
  }

  // ── ③ toast 会自己消失，不必手动关 ──
  await sleep(4600);
  const gone = JSON.parse(await page.cdp.evaluate("JSON.stringify({ toasts: document.querySelectorAll('.wb-rail-toast').length })"));
  if (gone.toasts !== 0) problems.push(`toast 应自动消失（4.2s），4.6s 后仍有 ${gone.toasts} 个`);
} finally {
  try { await page.close?.(); } catch { /* ignore */ }
  staticServer.close(); extra.close();
  if (problems.length) {
    console.error('\n✘ 问题：');
    for (const p of problems) console.error(` - ${p}`);
    process.exit(1);
  }
  console.log('\n✔ 勾选生效 / 单个 toast / 无重复提醒 / 自动消失 全部通过');
  process.exit(0);
}
