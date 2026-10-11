/** 在若干宽度下扫横向溢出。test-viewports 只测 1440/1100/820/420，这里补测中间档。 */
import { startStaticServer, openPage, waitFor, q, sleep } from './ui-harness.mjs';
import { baseRoutes } from './fixtures.mjs';

const PORT = 8812;
const server = await startStaticServer(PORT);
let bad = 0;
for (const w of [1440, 1280, 1180, 1100, 1024, 960, 900, 820, 720, 640, 560, 480, 420, 380]) {
  const { cdp, close } = await openPage(`http://127.0.0.1:${PORT}/`, baseRoutes(), { width: w, height: 900, cdpPort: 9393 });
  try {
    await waitFor(cdp, `document.querySelectorAll('.nav-tab').length >= 4`, 10000, '页签').catch(() => {});
    await sleep(900);
    const r = JSON.parse(await q(cdp, `(() => {
      const de = document.documentElement;
      const over = de.scrollWidth - de.clientWidth;
      const hits = [];
      if (over > 1) {
        for (const el of document.querySelectorAll('*')) {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          if (r.right > de.clientWidth + 1) {
            const cs = getComputedStyle(el);
            if (cs.position === 'fixed') continue;
            hits.push({ tag: el.tagName.toLowerCase(), cls: String(el.className || '').slice(0, 40),
              right: Math.round(r.right), w: Math.round(r.width), text: (el.textContent || '').trim().slice(0, 26) });
          }
        }
      }
      return JSON.stringify({ over, limit: de.clientWidth, hits: hits.slice(0, 8), total: hits.length });
    })()`));
    const mark = r.over > 1 ? '✗' : '✓';
    if (r.over > 1) bad += 1;
    console.log(`  ${String(w).padStart(5)}  ${mark} 溢出 ${String(r.over).padStart(4)}px${r.over > 1 ? `  (${r.total} 个元素越界)` : ''}`);
    for (const h of r.hits) console.log(`          <${h.tag} class="${h.cls}"> w=${h.w} right=${h.right} 「${h.text}」`);
  } finally { close(); }
}
console.log(`\n=== ${bad} 个宽度有横向溢出 ===`);
server.close();
