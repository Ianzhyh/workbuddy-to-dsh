/**
 * 右栏「测速」按钮的回归。
 *
 * ## 为什么这条值得单独测
 *
 * 测速是**唯一一个会花积分**的读接口（三次测量约 0.01–0.15）。它的 UI 有三条
 * 必须成立的约束，任何一条破了都会让用户"不知不觉付费"或"看不懂结果"：
 *
 *   1. 不点就不测 —— 页面渲染完成时**不能**有 tps 请求；
 *   2. 点了才测，且只测**当前默认**那个模型（不给列表每一行都放按钮）；
 *   3. 结果必须把"样本不完整"说出来 —— 把 2/3 次说成完整测量是错数据。
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startStaticServer, openPage, waitFor, sleep } from '../../tools/dev/ui-harness.mjs';
import { FIXTURES, buildRoutes, ensureVendor, harnessHtml } from './_panel-fixtures.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN = join(HERE, '..');
const PORT = 8941;

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
  if (path === '/harness.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(harnessHtml(routes));
  }
  if (path === '/client.js') {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
    return res.end(clientSource);
  }
  if (path === '/vendor/react.js') {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
    return res.end(react);
  }
  if (path === '/vendor/react-dom.js') {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
    return res.end(reactDom);
  }
  res.writeHead(404);
  return res.end('nf');
});
await new Promise((r) => extra.listen(PORT + 1, '127.0.0.1', r));

const page = await openPage(
  `http://127.0.0.1:${PORT + 1}/harness.html`,
  {},
  { width: 1200, height: 1000, injectStub: false, cdpPort: await freePort() },
);

const problems = [];
try {
  await waitFor(page.cdp, 'window.__harness && window.__harness.rendered === true', 15000, '挂载');
  await sleep(300);
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

  // ── ① 初始状态：有按钮、没有结果、**没有发出 tps 请求** ──
  const initial = JSON.parse(await page.cdp.evaluate(`JSON.stringify((() => {
    const rail = document.querySelector('[data-workbuddy-rail]');
    const btn = [...rail.querySelectorAll('button')].find((b) => /测速/.test(b.textContent || ''));
    const calls = (window.__calls || []).filter((c) => /tps/.test(c[0] || ''));
    return {
      hasButton: Boolean(btn),
      buttonText: btn ? btn.textContent.trim() : '',
      tpsCalls: calls.length,
      hasValue: Boolean(rail.querySelector('.wb-rail-tps-val')),
    };
  })())`));
  console.log('初始：', JSON.stringify(initial));
  if (!initial.hasButton) problems.push('模型页没有「测速」按钮');
  if (initial.tpsCalls !== 0) {
    problems.push(`渲染时就发起了 ${initial.tpsCalls} 次测速请求 —— 测速花积分，绝不能自动跑`);
  }
  if (initial.hasValue) problems.push('还没点就显示了速度值');

  // ── ② 点一下：发出恰好 1 次请求，并显示 tok/s ──
  await page.cdp.evaluate(`(() => {
    const rail = document.querySelector('[data-workbuddy-rail]');
    const btn = [...rail.querySelectorAll('button')].find((b) => /测速/.test(b.textContent || ''));
    btn.click();
  })()`);
  await sleep(700);
  const after = JSON.parse(await page.cdp.evaluate(`JSON.stringify((() => {
    const rail = document.querySelector('[data-workbuddy-rail]');
    const calls = (window.__calls || []).filter((c) => /tps/.test(c[0] || ''));
    const val = rail.querySelector('.wb-rail-tps-val');
    return {
      tpsCalls: calls.length,
      lastCall: (() => { const u = (window.__urls || []).filter((x) => /tps/.test(x)); return u.length ? u[u.length - 1] : ''; })(),
      valueText: val ? val.textContent.trim() : '',
      hasNote: Boolean(rail.querySelector('.wb-rail-tps-note')),
    };
  })())`));
  console.log('点击后：', JSON.stringify(after));
  if (after.tpsCalls !== 1) {
    problems.push(`点一次应只发 1 次测速请求（防重复扣费），实际 ${after.tpsCalls} 次`);
  }
  if (!/\?model=/.test(after.lastCall)) {
    problems.push(`测速请求必须点名模型（否则测谁都不知道）：${after.lastCall}`);
  }
  if (!/416\s*tok\/s/.test(after.valueText)) {
    problems.push(`没有显示 tok/s：${JSON.stringify(after.valueText)}`);
  }
  if (!/首字节/.test(after.valueText)) {
    problems.push(`首字节延迟没显示：${JSON.stringify(after.valueText)}`);
  }
  if (after.hasNote) {
    problems.push('样本完整（3/3）时不该标注「样本不完整」');
  }

  // ── ③ 样本不完整时如实标注 ──
  await page.cdp.evaluate(`(() => {
    window.__setRoute('/workbuddy/tps', {
      ok: true, cached: false,
      sample: { modelId: 'glm-5.3', tokensPerSecond: 210, timeToFirstTokenMs: 900, samples: 2, complete: false },
    });
    const rail = document.querySelector('[data-workbuddy-rail]');
    const btn = [...rail.querySelectorAll('button')].find((b) => /测速/.test(b.textContent || ''));
    btn.click();
  })()`);
  await sleep(700);
  const partial = JSON.parse(await page.cdp.evaluate(`JSON.stringify((() => {
    const rail = document.querySelector('[data-workbuddy-rail]');
    const val = rail.querySelector('.wb-rail-tps-val');
    return {
      valueText: val ? val.textContent.trim() : '',
      hasNote: Boolean(rail.querySelector('.wb-rail-tps-note')),
      err: (rail.querySelector('.wb-rail-tps-err') || {}).textContent || '',
    };
  })())`));
  console.log('不完整样本：', JSON.stringify(partial));
  if (!/2\/3/.test(partial.valueText)) {
    problems.push(`样本 2/3 时必须写出来：${JSON.stringify(partial.valueText)}`);
  }
  if (!partial.hasNote) problems.push('样本不完整时应有「（样本不完整）」提示');

  // ── ④ 失败时说清楚是哪一种没成，而不是一个破折号 ──
  await page.cdp.evaluate(`(() => {
    window.__setRoute('/workbuddy/tps', {
      ok: true, cached: false,
      sample: { modelId: 'glm-5.3', samples: 0, complete: false, reason: 'all-failed' },
    });
    const rail = document.querySelector('[data-workbuddy-rail]');
    const btn = [...rail.querySelectorAll('button')].find((b) => /测速/.test(b.textContent || ''));
    btn.click();
  })()`);
  await sleep(700);
  const failed = JSON.parse(await page.cdp.evaluate(`JSON.stringify((() => {
    const rail = document.querySelector('[data-workbuddy-rail]');
    const val = rail.querySelector('.wb-rail-tps-val');
    return { valueText: val ? val.textContent.trim() : '' };
  })())`));
  console.log('全失败：', JSON.stringify(failed));
  if (!/三次都失败了/.test(failed.valueText)) {
    problems.push(`全失败时必须说是"三次都失败"而不是空白：${JSON.stringify(failed.valueText)}`);
  }
} finally {
  try { await page.close?.(); } catch { /* ignore */ }
  staticServer.close(); extra.close();
  if (problems.length) {
    console.error('\n✘ 问题：');
    for (const p of problems) console.error(' - ' + p);
    process.exit(1);
  }
  console.log('\n✔ 测速 UI：不自动跑 / 点一次只测一次 / 显示 tok/s 与首字节 / 样本不完整如实标注 / 失败可读');
  process.exit(0);
}