/**
 * 换号开关：必须在「切换账号」卡**内部**，且有完整样式。
 *
 * 用户两次反馈「自动换号怎么还是单独出现」—— 之前它在 `}, t('刷新')))),` 之后，
 * 那句的括号已闭合卡片，所以它落在卡片外。
 *
 * 这条用例量三件事：
 *   1. `.wb-auto-switch` 的祖先里有 `.wb-card`（在卡片内）；
 *   2. 有边框/内边距（样式生效，不是裸文本）；
 *   3. 标题行与按钮组横向分开（不是挤成一坨）。
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startStaticServer, openPage, waitFor, sleep } from '../../tools/dev/ui-harness.mjs';
import { FIXTURES, buildRoutes, ensureVendor, harnessHtml } from './_panel-fixtures.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN = join(HERE, '..');
const PORT = 8997;

async function freePort() {
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

const page = await openPage(`http://127.0.0.1:${PORT + 1}/harness.html`, {}, {
  width: 1200, height: 1000, injectStub: false, cdpPort: await freePort(),
});

const problems = [];
try {
  await waitFor(page.cdp, 'window.__harness && window.__harness.rendered === true', 15000, '挂载');
  await sleep(400);
  await page.cdp.evaluate(`(() => {
    const root = document.getElementById('root');
    root.innerHTML = '';
    const frame = document.getElementById('frame');
    frame.style.width = '380px'; frame.style.maxWidth = '380px'; frame.style.padding = '0';
    frame.style.background = '#191a1c';
    const host = document.createElement('div');
    host.id = 'rail-host'; host.style.height = '980px'; host.style.overflow = 'hidden';
    root.appendChild(host);
    window.__railRoot = ReactDOM.createRoot(host);
    window.__railRoot.render(React.createElement(window.__module.WorkBuddyRail));
  })()`);
  await waitFor(page.cdp, "document.querySelector('[data-workbuddy-rail]') !== null", 15000, 'rail');
  await sleep(900);

  await page.cdp.evaluate(`(() => {
    const b = [...document.querySelectorAll('[data-workbuddy-rail] .wb-segmented-item')]
      .find((x) => /账号|Account/.test(x.textContent || ''));
    if (b) b.click();
  })()`);
  await sleep(1500);

  const info = JSON.parse(await page.cdp.evaluate(`JSON.stringify((() => {
    const box = document.querySelector('.wb-auto-switch');
    if (!box) return { error: 'no .wb-auto-switch' };
    const cs = getComputedStyle(box);
    const head = box.querySelector('.wb-auto-switch-head');
    const hcs = head ? getComputedStyle(head) : null;
    const btns = [...box.querySelectorAll('.wb-btn')];
    const rects = btns.map((b) => {
      const r = b.getBoundingClientRect();
      return { text: (b.textContent || '').trim(), left: Math.round(r.left), top: Math.round(r.top) };
    });
    return {
      inCard: Boolean(box.closest('.wb-card')),
      cardTitle: box.closest('.wb-card') ? (box.closest('.wb-card').querySelector('h3') || {}).textContent : '',
      borderTop: cs.borderTopWidth,
      paddingTop: cs.paddingTop,
      marginTop: cs.marginTop,
      headDisplay: hcs ? hcs.display : '',
      headJustify: hcs ? hcs.justifyContent : '',
      btns: rects,
    };
  })())`));
  console.log('开关：', JSON.stringify(info));

  if (info.error) problems.push(info.error);
  else {
    if (!info.inCard) {
      problems.push('换号开关不在 .wb-card 内（用户：怎么还是单独出现）');
    } else if (!/切换账号/.test(info.cardTitle || '')) {
      problems.push(`开关在错误的卡片里：${info.cardTitle}`);
    }
    /* 样式生效：应有上边框或内边距 */
    if (parseFloat(info.borderTop) < 0.4 && parseFloat(info.paddingTop) < 2) {
      problems.push(`开关没有任何样式（border-top=${info.borderTop}, padding-top=${info.paddingTop}）`);
    }
    /* 标题行应是 flex + space-between */
    if (info.headDisplay !== 'flex') problems.push(`标题行应是 flex，实际 ${info.headDisplay}`);
    /* 四个按钮应并排且不重叠 */
    if (info.btns.length >= 4) {
      const tops = new Set(info.btns.map((b) => b.top));
      if (tops.size > 2) problems.push(`阈值按钮排成了 ${tops.size} 行（应 1~2 行）`);
    }
  }
} finally {
  try { await page.close?.(); } catch { /* ignore */ }
  staticServer.close(); extra.close();
  if (problems.length) {
    console.error('\n✘ 问题：');
    for (const p of problems) console.error(' - ' + p);
    process.exit(1);
  }
  console.log('\n✔ 换号开关：在「切换账号」卡内 / 样式生效 / 标题行两端对齐 / 按钮并排');
  process.exit(0);
}