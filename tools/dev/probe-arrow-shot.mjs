/**
 * 一次性探针：自绘下拉箭头**像素级**复核。
 *
 * 用途：`test-accent-icons.mjs` 只能证明"箭头元素的 background-color 等于令牌、
 * mask-image 非 none" —— 但**mask 到底有没有渲染成"箭头"**（而不是一块实心方块 /
 * 被别的规则盖掉）属于"计算样式看不出来"的那类。这里截真实截图，人工看。
 *
 *   node tools/dev/probe-arrow-shot.mjs
 *
 * 产物：`E:/tmp/arrow-<accent>.png`（2x 放大）
 */
import { writeFileSync } from 'node:fs';
import { startStaticServer, openPage, waitFor, q, sleep } from './ui-harness.mjs';
import { baseRoutes } from './fixtures.mjs';

const PORT = 8836;
const server = await startStaticServer(PORT);
const { cdp, close } = await openPage(`http://127.0.0.1:${PORT}/`, baseRoutes(), { width: 1440, height: 900, cdpPort: 9400 });

try {
  await waitFor(cdp, `document.querySelectorAll('.dd .dd-arrow').length >= 9`, 10000, '自绘下拉就绪');
  await sleep(400);

  for (const accent of ['terracotta', 'moss']) {
    await q(cdp, `(() => {
      document.documentElement.setAttribute('data-theme', 'light');
      document.documentElement.setAttribute('data-accent', '${accent}');
      window.ddCloseAll && window.ddCloseAll();
      return true;
    })()`);
    await sleep(150);
    // 打开一个下拉 → 箭头进入 --primary 态
    await q(cdp, `(() => { const t = document.querySelector('.dd .dd-trigger'); t.click(); return true; })()`);
    await sleep(200);

    const box = await q(cdp, `(() => {
      const a = document.querySelector('.dd .dd-arrow');
      const r = a.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    })()`);
    const res = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      clip: { x: Math.max(0, box.x - 14), y: Math.max(0, box.y - 14), width: box.w + 28, height: box.h + 28, scale: 4 },
    });
    const out = `E:/tmp/arrow-${accent}.png`;
    writeFileSync(out, Buffer.from(res.result.data, 'base64'));
    console.log(`${accent}: ${out}  (箭头框 ${Math.round(box.w)}×${Math.round(box.h)} @ ${Math.round(box.x)},${Math.round(box.y)})`);
  }
} finally {
  close();
  server.close();
}
