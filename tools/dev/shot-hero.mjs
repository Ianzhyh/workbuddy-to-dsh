/**
 * 生成 README 用的**视口尺寸**截图（浅色 + 深色各一张）。
 *
 *   node tools/dev/shot-hero.mjs
 *
 * 产物：`docs/console-hero-light.png` / `docs/console-hero-dark.png`
 *
 * ## 为什么不能直接用 docs/screenshot.png
 *
 * 那张是 `captureBeyondViewport: true` 拍的**整页长图**（8.6 屏压成一张）。
 * 放进 README 会被缩到 800px 宽以内 —— 上面的字全部糊成一团，等于没有。
 * README 的头部图必须是**首屏视口**：在这个宽度下每个字都还读得出来。
 *
 * ## 为什么出两套配色
 *
 * GitHub 的 README 跟随系统配色。用 `<picture>` + `prefers-color-scheme`
 * 就能让深色用户看到深色图 —— 浅色截图放在深色页面上非常刺眼。
 *
 * 打桩数据：截图会进仓库，**真实账号 / 目录不该出现在里面**。
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startStaticServer, openPage, waitFor, q, sleep } from './ui-harness.mjs';
import { baseRoutes } from './fixtures.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = 8793;
const W = 1280;
const H = 780;   // 略低于 800：README 里视觉上更紧凑，且避开整屏滚动条

const server = await startStaticServer(PORT);

for (const theme of ['light', 'dark']) {
  const { cdp, close } = await openPage(`http://127.0.0.1:${PORT}/`, baseRoutes(), { width: W, height: H });
  try {
    // 切到「概览与用量」页签：首屏最能说明这个控制台是干什么的
    await waitFor(cdp, `document.querySelectorAll('.nav-tab').length >= 5`, 10000, '页签就绪');
    await q(cdp, `switchTab('overview')`);
    await q(cdp, `document.documentElement.setAttribute('data-theme', '${theme}')`);
    // 等状态卡与图表渲染完
    await waitFor(cdp, `document.querySelectorAll('#cards .card').length >= 6`, 8000, '状态卡');
    await sleep(700);

    const out = join(root, 'docs', `console-hero-${theme}.png`);
    // 刻意**不**用 captureBeyondViewport：要的就是首屏
    const res = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(out, Buffer.from(res.result.data, 'base64'));
    console.log(`已生成：${out}（${W}×${H}，${theme}）`);
  } finally {
    close();
  }
}

server.close();
