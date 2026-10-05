/**
 * 按区域截图，用于设计审查（整页截图缩得太小看不清细节）。
 *
 *   node tools/dev/shot-regions.mjs
 *
 * 输出到 docs/_review/（下划线前缀已被 .gitignore 忽略，属临时审查产物）。
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { startStaticServer, openPage, waitFor, q, sleep } from './ui-harness.mjs';
import { baseRoutes } from './fixtures.mjs';

const PORT = 8784;
const URL_ = `http://127.0.0.1:${PORT}/`;
const OUTDIR = join(process.cwd(), 'docs', '_review');

// 桩数据来自共享夹具（tools/dev/fixtures.mjs）—— 形状由 ui-harness 自动校验
const routes = baseRoutes();


mkdirSync(OUTDIR, { recursive: true });
const server = await startStaticServer(PORT);
const { cdp, close } = await openPage(URL_, routes, { width: 1280, height: 900 });
await sleep(1400);

const REGIONS = [
  ['cards', '.cards'],
  ['usage', '[data-section="overview"]:nth-of-type(2)'],
  ['models', '[data-section="models"]'],
  ['requests', '#reqBox'],
];

for (const [name, sel] of REGIONS) {
  const box = await q(cdp, `(() => {
    const el = document.querySelector('${sel}');
    if (!el) return null;
    el.scrollIntoView({ block: 'start' });
    const r = el.getBoundingClientRect();
    return { x: Math.max(0, r.x), y: Math.max(0, r.y + window.scrollY), w: r.width, h: Math.min(r.height, 1600) };
  })()`);
  if (!box) { console.log('skip (not found):', name, sel); continue; }
  const shot = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
    clip: { x: box.x, y: box.y, width: box.w, height: box.h, scale: 1 },
  });
  const out = join(OUTDIR, name + '.png');
  writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
  console.log('wrote', out, `${Math.round(box.w)}×${Math.round(box.h)}`);
}

close();
server.close();
