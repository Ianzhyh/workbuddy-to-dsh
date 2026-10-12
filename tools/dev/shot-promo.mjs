/**
 * 渲染推广图：`docs/promo/social-preview.html` → `docs/promo/social-preview.png`。
 *
 *   node tools/dev/shot-promo.mjs
 *
 * 产物是 GitHub 的社交预览图（1280×640，@2x 输出 2560×1280）。
 * 原文件是自包含的单页（无外部资源），所以这里只起一个"永远返回它"的静态服务，
 * 在无头 Chrome 里按 2 倍像素密度截图。
 *
 * ⚠️ 截图前必须**先把视口调成 1280×640 再等一帧**：页面按固定尺寸排版
 * （`html,body{width:1280px;height:640px;overflow:hidden}`），视口不对会把
 * 边缘裁掉或留白。
 */
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openPage, q, sleep } from './ui-harness.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = join(ROOT, 'docs', 'promo', 'social-preview.html');
const OUT = join(ROOT, 'docs', 'promo', 'social-preview.png');
const PORT = 8838;

const server = createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(readFileSync(SRC));
});
await new Promise((ok) => server.listen(PORT, '127.0.0.1', ok));

const { cdp, close } = await openPage(`http://127.0.0.1:${PORT}/`, {}, { injectStub: false, width: 1280, height: 640, cdpPort: 9402 });
try {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 640, deviceScaleFactor: 2, mobile: false });
  await sleep(600); // 等字体与布局落定（无外部资源，600ms 足够）

  const size = await q(cdp, `document.documentElement.scrollWidth + 'x' + document.documentElement.scrollHeight`);
  if (size !== '1280x640') throw new Error(`页面尺寸 ${size}，应为 1280x640 —— 社交预览图会被裁切`);

  const res = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(OUT, Buffer.from(res.result.data, 'base64'));
  console.log(`已写入 ${OUT}（${Math.round(statSync(OUT).size / 1024)} KB，页面 ${size} @2x）`);
} finally {
  close();
  server.close();
}
