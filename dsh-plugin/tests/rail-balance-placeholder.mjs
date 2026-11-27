/**
 * 余额胶囊不应该"突然出现"（用户：「怎么是突然出现的，和其他不是同一时间出现的」）。
 *
 * ## 问题
 *
 * `/workbuddy/quota-all` 比 `/api/accounts` 慢得多（桥要串行打上游），
 * 而我的实现是"没有数据就不渲染" —— 于是账号行先只有名字和按钮，
 * 一会儿胶囊才补出来，布局跟着跳。
 *
 * ## 这条用例钉什么
 *
 * **在 quota-all 还没返回时**，胶囊就应该占位存在（内容为 `··`）。
 * 做法：把 quota-all 的响应人为延迟，在延迟期间采样 DOM。
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startStaticServer, openPage, waitFor, sleep } from '../../tools/dev/ui-harness.mjs';
import { FIXTURES, buildRoutes, ensureVendor, harnessHtml } from './_panel-fixtures.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN = join(HERE, '..');
const PORT = 8999;

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

  /* 把 quota-all 变成"永不返回"的角色：从路由表里删掉，让 fetch 也走不到真实网络 */
  await page.cdp.evaluate(`(() => {
    /* 让 quota-all 挂起：返回一个永不 resolve 的 Promise */
    const origRoutes = window.__routes;
    const origFetch = window.fetch;
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (url.includes('quota-all')) return new Promise(() => {});
      return origFetch.apply(this, arguments);
    };
  })()`);

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
  await sleep(600);

  await page.cdp.evaluate(`(() => {
    const b = [...document.querySelectorAll('[data-workbuddy-rail] .wb-segmented-item')]
      .find((x) => /账号|Account/.test(x.textContent || ''));
    if (b) b.click();
  })()`);
  await sleep(1600);

  const during = JSON.parse(await page.cdp.evaluate(`JSON.stringify((() => {
    const rail = document.querySelector('[data-workbuddy-rail]');
    const card = [...rail.querySelectorAll('.wb-card')].find((c) => {
      const h = c.querySelector('h3');
      return h && /切换账号/.test(h.textContent || '');
    });
    if (!card) return { error: 'no card' };
    const badges = [...card.querySelectorAll('.wb-balance-badge')];
    return {
      rows: card.querySelectorAll('.wb-rail-item').length,
      badgeCount: badges.length,
      texts: badges.map((b) => b.textContent.trim()),
    };
  })())`));
  console.log('quota-all 挂起时：', JSON.stringify(during));

  if (during.error) problems.push(during.error);
  else {
    /*
     * 关键断言：**余额还没到，但胶囊应该已经在**。
     * 如果 badgeCount 是 0，就说明它还在"没有数据就不渲染"的旧逻辑里。
     */
    if (during.rows > 0 && during.badgeCount === 0) {
      problems.push('余额未返回时胶囊完全不存在 —— 这就是"突然出现"的原因，应显示占位 ··');
    }
    if (during.badgeCount > 0 && !during.texts.every((t) => t === '··')) {
      problems.push(`占位内容应是 ··，实际 ${JSON.stringify(during.texts)}`);
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
  console.log('\n✔ 余额未返回时胶囊已占位（··），不会突然出现');
  process.exit(0);
}