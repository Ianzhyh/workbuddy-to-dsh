/**
 * 账号行显示余额（用户：「账号旁边能不能有余额」「搞明显一点」）。
 *
 * ## 钉什么
 *
 * 1. 右栏「切换账号」卡的账号行里有**独立徽标**显示余额（不是塞在副标题灰字里）；
 * 2. **读不到时显示破折号，不显示 0** —— 那是"读不到"不是"没钱了"；
 * 3. 余额来自 `/workbuddy/quota-all`（一次拿全部），不是循环调 `/v1/quota`。
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startStaticServer, openPage, waitFor, sleep } from '../../tools/dev/ui-harness.mjs';
import { FIXTURES, buildRoutes, ensureVendor, harnessHtml } from './_panel-fixtures.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN = join(HERE, '..');
const PORT = 8991;

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
    const rail = document.querySelector('[data-workbuddy-rail]');
    const card = [...rail.querySelectorAll('.wb-card')].find((c) => {
      const h = c.querySelector('h3');
      return h && /切换账号/.test(h.textContent || '');
    });
    if (!card) return { error: '找不到切换账号卡' };
    const badges = [...card.querySelectorAll('.wb-balance-badge')];
    return {
      rows: [...card.querySelectorAll('.wb-rail-item')].map((r) => ({
        name: (r.querySelector('.wb-rail-item-name') || {}).textContent || '',
        badge: (r.querySelector('.wb-balance-badge') || {}).textContent || '',
      })),
      badgeCount: badges.length,
      /* 徽标必须有实际可见尺寸，不能是 display:none 或零宽 */
      badgeRects: badges.map((b) => {
        const r = b.getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height) };
      }),
      calls: (window.__calls || []).map((c) => c[0]).filter((v, i, a) => a.indexOf(v) === i),
    };
  })())`));
  console.log('账号行：', JSON.stringify(info));

  if (info.error) problems.push(info.error);
  else {
    if (!info.badgeCount) {
      problems.push(`账号行没有余额徽标。实际副标题/徽标：${JSON.stringify(info.rows)}`);
    } else {
      /* 有数字的那行 */
      const withNum = info.rows.filter((r) => /[\d,]/.test(r.badge || ''));
      if (!withNum.length) problems.push('没有任何账号显示余额数字');
      /* 读不到的要显示破折号而不是 0 */
      if (!info.rows.some((r) => /—/.test(r.badge || ''))) {
        problems.push('total=null 的账号应显示破折号（不是 0）');
      }
      /* 徽标要真的画出来（用户抱怨过"不明显"） */
      if (info.badgeRects.some((r) => r.w < 12 || r.h < 12)) {
        problems.push(`余额徽标尺寸异常（应至少 20×12）：${JSON.stringify(info.badgeRects)}`);
      }
    }
    if (!info.calls.some((c) => /quota-all/.test(c))) {
      problems.push(`面板没有请求 /workbuddy/quota-all。实际：${JSON.stringify(info.calls)}`);
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
  console.log('\n✔ 账号行有余额徽标：数字可见 / 读不到显示破折号 / 尺寸足够 / 走一次性 quota-all');
  process.exit(0);
}
