/**
 * 探针：找出 1440px 视口下**谁**撑出了横向滚动。
 *
 *   node tools/dev/probe-overflow.mjs
 *
 * 只看 `documentElement.scrollWidth` 超了多少是不够的 —— 得知道是哪个元素。
 * 这里列出所有「右边界超出可视宽度」的元素，按超出量排序。
 */
import { startStaticServer, openPage, waitFor, q, sleep } from './ui-harness.mjs';
import { baseRoutes } from './fixtures.mjs';

const PORT = 8795;
const W = Number(process.argv[2] || 1440);

const server = await startStaticServer(PORT);
const { cdp, close } = await openPage(`http://127.0.0.1:${PORT}/`, baseRoutes(), { width: W, height: 900 });
try {
  await waitFor(cdp, `document.querySelectorAll('.nav-tab').length >= 5`, 10000, '页签');
  // 切英文（溢出是英文下才出现的）
  await q(cdp, `(function(){ var t=document.getElementById('langToggle'); if (t) t.click(); })()`);
  await sleep(500);
  // 可选：切到客户端面板（第一个参数是 'clients' 时）
  if (process.argv[3] === 'clients') { await q(cdp, `switchTab('clients')`); await sleep(600); }

  // 与 test-i18n 第 7 步保持一致：用 CDP 的设备度量覆盖，而不是窗口尺寸
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: W, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(300);
  // test-i18n 在量溢出之前刚 reload 过 —— 一并复现
  if (process.argv[3] === 'reload') {
    await cdp.send('Page.reload', { ignoreCache: false });
    await waitFor(cdp, `document.querySelectorAll('#modelTable tbody tr').length > 0`, 15000, '重载后模型表');
    await sleep(600);
  }

  const report = await q(cdp, `(() => {
    const cw = document.documentElement.clientWidth;
    const out = [];
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const over = Math.round(r.right - cw);
      if (over > 0) {
        out.push({
          over,
          tag: el.tagName.toLowerCase() + (el.id ? '#' + el.id : '')
               + (typeof el.className === 'string' && el.className ? '.' + el.className.split(' ').join('.') : ''),
          w: Math.round(r.width),
          text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60),
        });
      }
    }
    out.sort((a, b) => b.over - a.over);
    return {
      clientWidth: cw,
      scrollWidth: document.documentElement.scrollWidth,
      over: document.documentElement.scrollWidth - cw,
      offenders: out.slice(0, 15),
    };
  })()`);

  console.log(`视口 ${W}px  clientWidth=${report.clientWidth} scrollWidth=${report.scrollWidth} 溢出=${report.over}px`);
  if (!report.offenders.length) console.log('没有元素越界（溢出可能来自 body/html 自身的内边距）');
  for (const o of report.offenders) {
    console.log(`  +${String(o.over).padStart(4)}px  w=${String(o.w).padStart(5)}  ${o.tag}`);
    if (o.text) console.log(`           「${o.text}」`);
  }
} finally {
  await close();
  server.close();
}
