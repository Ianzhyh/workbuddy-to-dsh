/**
 * 设置页「账号」标签的自动换号开关 + 余额。
 *
 * 用户两次指出这里没做：「还有账号卡还没有自动换号开关」「没有，这不难把」。
 * 前两次我都插错了位置（一次到文件头、一次到 i18n 词表）。
 * 这条用例**直接查渲染结果**，插错位置会立刻红。
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startStaticServer, openPage, waitFor, sleep } from '../../tools/dev/ui-harness.mjs';
import { FIXTURES, buildRoutes, ensureVendor, harnessHtml } from './_panel-fixtures.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN = join(HERE, '..');
const PORT = 8995;

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
  await sleep(500);
  /* 面板本体（设置页），不是右栏 */
  await page.cdp.evaluate(`(() => {
    const root = document.getElementById('root');
    root.innerHTML = '';
    const frame = document.getElementById('frame');
    frame.style.width = '1000px'; frame.style.maxWidth = '1000px'; frame.style.padding = '0';
    const host = document.createElement('div');
    host.id = 'panel-host'; host.style.height = '1600px';
    root.appendChild(host);
    window.__panelRoot = ReactDOM.createRoot(host);
    window.__panelRoot.render(React.createElement(window.__module.WorkBuddyPanel));
  })()`);
  await waitFor(page.cdp, "document.querySelector('.wb-tabs') !== null", 15000, '面板');
  await sleep(1200);

  /* 切到「账号」标签 */
  await page.cdp.evaluate(`(() => {
    const b = [...document.querySelectorAll('.wb-tab')].find((x) => /账号/.test(x.textContent || ''));
    if (b) b.click();
  })()`);
  await sleep(1500);

  const errs = await page.cdp.evaluate('JSON.stringify(window.__errors || [])');
  console.log('页面错误：', errs);
  const info = JSON.parse(await page.cdp.evaluate(`JSON.stringify((() => {
    const tabs = [...document.querySelectorAll('.wb-tab')].map((t) => t.textContent);
    const sw = document.querySelector('.wb-auto-switch');
    const btns = sw ? [...sw.querySelectorAll('.wb-btn')].map((b) => (b.textContent || '').trim()) : [];
    return {
      tabs,
      hasSwitch: Boolean(sw),
      switchText: sw ? sw.textContent.trim().slice(0, 160) : '',
      buttons: btns,
      /* 账号卡里的余额徽标 */
      balances: [...document.querySelectorAll('.wb-balance-badge')].map((b) => b.textContent.trim()),
      cardTitle: sw && sw.closest('.wb-card') ? ((sw.closest('.wb-card').querySelector('h3') || {}).textContent || '') : '',
    };
  })())`));
  console.log('设置页账号标签：', JSON.stringify(info));

  if (!info.hasSwitch) {
    if (info.hasSwitch && info.inCard === false) {
      problems.push(`换号开关不在卡片内（用户：怎么还是单独出现），实际在 ${JSON.stringify(info.cardTitle)}`);
    }
    problems.push(`设置页「账号」标签没有自动换号开关（用户两次反馈）`);
  } else {
    for (const n of ['关闭', '3 次', '5 次', '10 次']) {
      if (!info.buttons.includes(n)) problems.push(`阈值按钮缺「${n}」，实际 ${JSON.stringify(info.buttons)}`);
    }
    if (!/已关闭|已开启/.test(info.switchText)) problems.push('开关没有显示当前状态');
  }
  if (!info.balances.length) {
    problems.push('账号卡里没有余额徽标');
  }
} finally {
  try { await page.close?.(); } catch { /* ignore */ }
  staticServer.close(); extra.close();
  if (problems.length) {
    console.error('\n✘ 问题：');
    for (const p of problems) console.error(' - ' + p);
    process.exit(1);
  }
  console.log('\n✔ 设置页账号标签：有换号开关（四个阈值）/ 显示状态 / 账号卡有余额徽标');
  process.exit(0);
}