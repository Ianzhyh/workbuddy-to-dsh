/**
 * 生成 README 用的**视口尺寸**截图（浅色 + 深色、中 + 英，共四张）。
 *
 *   node tools/dev/shot-hero.mjs
 *
 * 产物：
 *   `docs/console-hero-light.png`    / `docs/console-hero-dark.png`     （中文 README）
 *   `docs/console-hero-en-light.png` / `docs/console-hero-en-dark.png`  （英文 README）
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

/**
 * 强调色显式钉死。
 *
 * `data-accent` 不设时读的是**当前默认值**，而默认值会变（10-10 这轮从蓝改到陶土）。
 * README 里 hero / clients-panel / screenshot 是一整套，色系必须一致 ——
 * 让截图依赖"碰巧的默认值"，下次改默认色时就会只更新到其中一张。
 */
const ACCENT = 'blue';

/*
 * 中 / 英各出一套。英文 README 原先用的是 `screenshot-en.png` —— 那是
 * `captureBeyondViewport` 的**整页长图**（1494×4607）。按 README 的 800px 宽算，
 * 它会缩到 54%、占到 2466px 高，字全糊在一起，而且把页面拉得极长。
 * 中文 README 早就改成了视口图，英文这边漏了 —— 这里补上。
 *
 * 语言走**真实的 `langToggle` 开关**（不注入、不改源码），这样截图顺带验收了切换。
 */
const LANGS = [
  { tag: '', suffix: '', name: '中文' },
  { tag: 'en', suffix: '-en', name: 'English' },
];

const server = await startStaticServer(PORT);

for (const lang of LANGS) {
  for (const theme of ['light', 'dark']) {
    const { cdp, close } = await openPage(`http://127.0.0.1:${PORT}/`, baseRoutes(), { width: W, height: H });
    try {
      // 切到「概览与用量」页签：首屏最能说明这个控制台是干什么的
      await waitFor(cdp, `document.querySelectorAll('.nav-tab').length >= 5`, 10000, '页签就绪');
      await q(cdp, `switchTab('overview')`);
      await q(cdp, `document.documentElement.setAttribute('data-theme', '${theme}');
                   document.documentElement.setAttribute('data-accent', '${ACCENT}')`);
      // 英文版：点真实的语言开关，不是改源码
      if (lang.tag) {
        await q(cdp, `document.getElementById('langToggle').click()`);
        await sleep(500);
      }
      // 等状态卡与图表渲染完
      await waitFor(cdp, `document.querySelectorAll('#cards .card').length >= 6`, 8000, '状态卡');
      await sleep(700);

      const out = join(root, 'docs', `console-hero${lang.suffix}-${theme}.png`);
      // 刻意**不**用 captureBeyondViewport：要的就是首屏
      const res = await cdp.send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(out, Buffer.from(res.result.data, 'base64'));
      console.log(`已生成：${out}（${W}×${H}，${theme}，${lang.name}）`);
    } finally {
      close();
    }
  }
}

server.close();
