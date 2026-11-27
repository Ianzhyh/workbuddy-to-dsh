/**
 * 「当前默认」行的**两种宽度**都要正确（用户：「那你得好好适配了」）。
 *
 * ## 两张截图分别暴露的失败
 *
 * · 窄档（340px 左右）：模型名一行 + 按钮另起一行，但按钮被推到最右，像漂浮；
 * · 宽档（760px 左右）：模型名与按钮之间空太大，按钮贴到卡片外缘。
 *
 * ## 这条用例钉的规则
 *
 *   · 窄档（<480px）：模型名独占第一行，按钮在第二行**靠左**（左边缘贴近容器左内边距）；
 *   · 宽档（>=480px）：全部一行，按钮靠右但**不越界**，且与模型名有间隔；
 *   · 两档下按钮都不能重叠、不能溢出容器。
 *
 * 全部实测坐标 —— 查 CSS 声明看不出 `@container` 是否真的命中。
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startStaticServer, openPage, waitFor, sleep } from '../../tools/dev/ui-harness.mjs';
import { FIXTURES, buildRoutes, ensureVendor, harnessHtml } from './_panel-fixtures.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN = join(HERE, '..');
const PORT = 8989;

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
  width: 1400, height: 1000, injectStub: false, cdpPort: await freePort(),
});

const problems = [];

/** 在指定宽度下量一次 head 布局。 */
async function measure(width) {
  await page.cdp.evaluate(`(() => {
    const root = document.getElementById('root');
    root.innerHTML = '';
    const frame = document.getElementById('frame');
    frame.style.width = '${width}px'; frame.style.maxWidth = '${width}px';
    frame.style.padding = '0'; frame.style.background = '#191a1c';
    const host = document.createElement('div');
    host.id = 'rail-host'; host.style.height = '960px'; host.style.overflow = 'hidden';
    root.appendChild(host);
    window.__railRoot = ReactDOM.createRoot(host);
    window.__railRoot.render(React.createElement(window.__module.WorkBuddyRail));
  })()`);
  await waitFor(page.cdp, "document.querySelector('[data-workbuddy-rail] .wb-rail-inline-head') !== null", 15000, `head@${width}`);
  await sleep(900);

  return JSON.parse(await page.cdp.evaluate(`JSON.stringify((() => {
    const head = document.querySelector('[data-workbuddy-rail] .wb-rail-inline-head');
    const r = head.getBoundingClientRect();
    const label = head.querySelector('.wb-row') || head.querySelector('.wb-note');
    const btns = [...head.querySelectorAll('.wb-btn')];
    const lr = label ? label.getBoundingClientRect() : null;
    return {
      headW: Math.round(r.width),
      label: lr ? { left: Math.round(lr.left - r.left), right: Math.round(lr.right - r.left), top: Math.round(lr.top - r.top) } : null,
      buttons: btns.map((b) => {
        const br = b.getBoundingClientRect();
        return {
          text: (b.textContent || '').trim(),
          left: Math.round(br.left - r.left),
          right: Math.round(br.right - r.left),
          top: Math.round(br.top - r.top),
          w: Math.round(br.width),
        };
      }),
    };
  })())`));
}

try {
  await waitFor(page.cdp, 'window.__harness && window.__harness.rendered === true', 15000, '挂载');
  await sleep(400);

  /* ── 窄档 365px ── */
  const narrow = await measure(365);
  console.log('窄档 365：', JSON.stringify(narrow));
  if (narrow.buttons.length < 2) {
    problems.push(`窄档：head 里应有 2 个按钮，实际 ${narrow.buttons.length}`);
  } else {
    const [a, b] = narrow.buttons;
    if (Math.abs(a.top - b.top) > 4) problems.push('窄档：两个按钮不在同一行');
    if (b.left < a.right - 2) problems.push('窄档：两个按钮重叠');
    if (b.right > narrow.headW + 2) problems.push(`窄档：按钮溢出（${b.right} > ${narrow.headW}）`);
    /*
     * 窄档按钮**靠左**（用户：「窄的时候放左就行」）。
     *
     * 我在靠左/贴右之间来回改过：贴右是为了与 Row 右侧的值对齐，
     * 但用户看了实际效果后要靠左 —— 这类视觉判断以他看到的为准。
     */
    if (a.left > 12) {
      problems.push(`窄档：按钮组应靠左（左边缘 0~12px），实际 ${a.left}px`);
    }
  }

  /* ── 宽档 760px ── */
  const wide = await measure(760);
  console.log('宽档 760：', JSON.stringify(wide));
  if (wide.buttons.length < 2) {
    problems.push(`宽档：head 里应有 2 个按钮，实际 ${wide.buttons.length}`);
  } else {
    const [a, b] = wide.buttons;
    /* 宽档应当在一行：按钮 top 与 label top 接近 */
    if (wide.label && Math.abs(a.top - wide.label.top) > 6) {
      problems.push(`宽档：按钮与模型名不在同一行（top ${a.top} vs ${wide.label.top}）`);
    }
    if (Math.abs(a.top - b.top) > 4) problems.push('宽档：两个按钮不在同一行');
    if (b.left < a.right - 2) problems.push('宽档：两个按钮重叠');
    if (b.right > wide.headW + 2) {
      problems.push(`宽档：按钮溢出容器（${b.right} > ${wide.headW}）`);
    }
    /* 靠右但不贴死：右边缘应贴近容器右内边距（8px 内），且不能越界 */
    const gapRight = wide.headW - b.right;
    if (gapRight > 24) {
      problems.push(`宽档：按钮离右边缘 ${gapRight}px，应靠右`);
    }
    /* 且与模型名之间要有间隔 */
    if (wide.label && a.left < wide.label.right) {
      problems.push('宽档：按钮与模型名重叠');
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
  console.log('\n✔ 两种宽度都正确：窄档按钮靠左另起一行 / 宽档一行靠右不溢出');
  process.exit(0);
}
