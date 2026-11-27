/**
 * 「自动换号」开关的回归（用户明确要求：「自动换号你在设置里面给个开关呗」）。
 *
 * ## 这条用例钉什么
 *
 * 1. 设置页**真的有**这个开关（能力早就有，但界面上一个入口都没有 —— 之前
 *    只能手写 `accountFailoverAfter` 配置文件）；
 * 2. 默认是**关**（换号会改写用户正在用的账号，默认开等于在用户不知情时换钱包）；
 * 3. 点阈值按钮真的发出 POST，且带正确的 `after` 值；
 * 4. 说明文字要把"账号级触顶一次即切、不受阈值影响"写出来 —— 否则用户会
 *    以为额度用尽也要等 N 次才发现。
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startStaticServer, openPage, waitFor, sleep } from '../../tools/dev/ui-harness.mjs';
import { FIXTURES, buildRoutes, ensureVendor, harnessHtml } from './_panel-fixtures.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN = join(HERE, '..');
const PORT = 8971;

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
    frame.style.width = '360px'; frame.style.maxWidth = '360px'; frame.style.padding = '0';
    frame.style.background = '#191a1c';
    const host = document.createElement('div');
    host.id = 'rail-host'; host.style.height = '980px'; host.style.overflow = 'hidden';
    root.appendChild(host);
    window.__railRoot = ReactDOM.createRoot(host);
    window.__railRoot.render(React.createElement(window.__module.WorkBuddyRail));
  })()`);
  await waitFor(page.cdp, "document.querySelector('[data-workbuddy-rail]') !== null", 15000, 'rail');
  await sleep(900);

  /* 切到「账号」tab */
  await page.cdp.evaluate(`(() => {
    const b = [...document.querySelectorAll('[data-workbuddy-rail] .wb-segmented-item')]
      .find((x) => /账号|Account/.test(x.textContent || ''));
    if (b) b.click();
  })()`);
  await sleep(1200);

  /* ── ① 开关存在、默认关 ── */
  const initial = JSON.parse(await page.cdp.evaluate(`JSON.stringify((() => {
    const rail = document.querySelector('[data-workbuddy-rail]');
    const box = rail.querySelector('.wb-auto-switch');
    const btns = box ? [...box.querySelectorAll('.wb-btn')].map((b) => (b.textContent || '').trim()) : [];
    return {
      hasBox: Boolean(box),
      text: box ? box.textContent.trim().slice(0, 220) : '',
      buttons: btns,
      /* 默认态应是「已关闭」 */
      closed: box ? /已关闭/.test(box.textContent) : false,
    };
  })())`));
  console.log('初始：', JSON.stringify(initial));

  if (!initial.hasBox) {
    problems.push('账号页没有「自动换号」开关 —— 用户明确要求过要有');
  } else {
    if (!initial.closed) problems.push('自动换号默认应是「已关闭」（换号会改写用户正在用的账号）');
    if (!initial.buttons.some((b) => /关闭/.test(b))) {
      problems.push(`阈值按钮里应有「关闭」，实际 ${JSON.stringify(initial.buttons)}`);
    }
    for (const n of ['3 次', '5 次', '10 次']) {
      if (!initial.buttons.some((b) => b === n)) {
        problems.push(`阈值按钮缺 ${n}，实际 ${JSON.stringify(initial.buttons)}`);
      }
    }
    /*
     * 说明必须提到"账号级一次即切"：否则用户以为额度用尽也要等 N 次才发现 ——
     * 那是两种完全不同的失败（一个是限流，一个是钱花完了）。
     */
    if (!/不限|不受|一次即切/.test(initial.text)) {
      problems.push('说明文字没讲清「账号用量上限/风控是一次即切、不受阈值影响」');
    }
  }

  /* ── ② 点「5 次」→ 发出 POST，body.after = 5 ── */
  await page.cdp.evaluate(`(() => {
    const box = document.querySelector('[data-workbuddy-rail] .wb-auto-switch');
    const btn = [...box.querySelectorAll('.wb-btn')].find((b) => (b.textContent || '').trim() === '5 次');
    if (btn) btn.click();
  })()`);
  await sleep(700);

  const posted = JSON.parse(await page.cdp.evaluate(`JSON.stringify(
    (window.__reqs || []).filter((r) => /auto-switch/.test(r.path))
  )`));
  console.log('请求：', JSON.stringify(posted));

  const posts = posted.filter((r) => r.method === 'POST');
  if (posts.length !== 1) {
    problems.push(`点一次应只发 1 个 POST，实际 ${posts.length} 个`);
  } else if (Number(posts[0].body?.after) !== 5) {
    problems.push(`POST body.after 应为 5，实际 ${JSON.stringify(posts[0].body)}`);
  }

  /* ── ③ 保存后有可见反馈 ── */
  const feedback = JSON.parse(await page.cdp.evaluate(`JSON.stringify((() => {
    const rail = document.querySelector('[data-workbuddy-rail]');
    const notice = rail.querySelector('.wb-rail-notice');
    return { text: notice ? notice.textContent.trim() : '' };
  })())`));
  console.log('反馈：', JSON.stringify(feedback));
  if (!/自动换号/.test(feedback.text)) {
    problems.push(`保存后应有可见反馈，实际 ${JSON.stringify(feedback.text)}`);
  }
} finally {
  try { await page.close?.(); } catch { /* ignore */ }
  staticServer.close(); extra.close();
  if (problems.length) {
    console.error('\n✘ 问题：');
    for (const p of problems) console.error(' - ' + p);
    process.exit(1);
  }
  console.log('\n✔ 自动换号开关：存在于账号页 / 默认关 / 点阈值发对 POST / 有反馈 / 说明讲清一次即切');
  process.exit(0);
}