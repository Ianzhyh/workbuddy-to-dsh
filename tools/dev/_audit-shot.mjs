/**
 * 临时审计截图：按区域截取控制台渲染细节，用于视觉评审（用完即删）。
 *   node tools/dev/_audit-shot.mjs [outDir]
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { startStaticServer, openPage, waitFor, q, sleep } from './ui-harness.mjs';
import { baseRoutes } from './fixtures.mjs';

const OUT = process.argv[2] || 'E:/tmp/ui-audit2';
mkdirSync(OUT, { recursive: true });
const PORT = 8797;

const server = await startStaticServer(PORT);
const { cdp, close } = await openPage(`http://127.0.0.1:${PORT}/`, baseRoutes(), { width: 1440, height: 900 });

const shot = async (name, sel) => {
  const area = await q(cdp, `(() => { const e = document.querySelector(${JSON.stringify(sel)});
    if (!e) return null; const r = e.getBoundingClientRect();
    return { x: 0, y: Math.max(0, Math.round(r.top + window.scrollY - 14)), width: 1440, height: Math.min(1600, Math.round(r.height + 28)), scale: 1 }; })()`);
  if (!area) { console.log('跳过（找不到 ' + sel + '）'); return; }
  const res = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: area });
  const f = `${OUT}/${name}.png`;
  writeFileSync(f, Buffer.from(res.result.data, 'base64'));
  console.log('→ ' + f);
};

const theme = async (t) => { await q(cdp, `document.documentElement.setAttribute('data-theme','${t}')`); await sleep(450); };

try {
  await waitFor(cdp, `document.querySelectorAll('#modelTable tbody tr').length > 0`, 15000, '模型表');
  await waitFor(cdp, `document.querySelector('#usageBox') && !document.querySelector('#usageBox .empty')`, 12000, '用量面板');
  await waitFor(cdp, `document.querySelector('#clientsBox') && !document.querySelector('#clientsBox .empty')`, 12000, '客户端面板');
  await sleep(900);

  for (const t of ['light', 'dark']) {
    await theme(t);
    const p = t === 'light' ? 'L' : 'D';
    await shot(`${p}1-hero`, '.top-bar-sticky');
    await shot(`${p}2-actions`, '.actions');
    await shot(`${p}3-cards`, '#cards');
    await shot(`${p}4-usage`, '[data-section="overview"]:nth-of-type(2)');
    await shot(`${p}5-models`, '[data-section="models"]');
    await shot(`${p}6-clients`, '[data-section="clients"]');
  }

  // 窄屏（浅色）
  await theme('light');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 900, deviceScaleFactor: 1, mobile: true });
  await sleep(700);
  const narrow = async (name, sel) => {
    const area = await q(cdp, `(() => { const e = document.querySelector(${JSON.stringify(sel)});
      if (!e) return null; const r = e.getBoundingClientRect();
      return { x: 0, y: Math.max(0, Math.round(r.top + window.scrollY - 14)), width: 390, height: Math.min(1600, Math.round(r.height + 28)), scale: 1 }; })()`);
    if (!area) { console.log('跳过 ' + sel); return; }
    const res = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: area });
    writeFileSync(`${OUT}/${name}.png`, Buffer.from(res.result.data, 'base64'));
    console.log('→ ' + `${OUT}/${name}.png`);
  };
  await narrow('N1-hero', '.top-bar-sticky');
  await narrow('N2-cards', '#cards');

  console.log('完成');
} finally {
  close(); server.close();
}
