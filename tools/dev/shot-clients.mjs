/**
 * 给「客户端接入」面板截图（浅色 + 深色）。
 *
 *   node tools/dev/shot-clients.mjs
 *
 * 不启真控制台、不消耗上游额度：静态服务 + 无头 Chromium，`/api/*` 全打桩。
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { startStaticServer, openPage, waitFor, q, sleep } from './ui-harness.mjs';
import { baseRoutes } from './fixtures.mjs';

const PORT = 8787;
const URL_ = `http://127.0.0.1:${PORT}/`;
const OUTDIR = join(process.cwd(), 'docs');

// 桩数据来自共享夹具（tools/dev/fixtures.mjs）—— 形状由 ui-harness 自动校验
const routes = baseRoutes();

const INJECT = '';

mkdirSync(OUTDIR, { recursive: true });
const server = await startStaticServer(PORT);
const { cdp, close } = await openPage(URL_, routes, { inject: INJECT, width: 1280, height: 1200 });

await q(cdp, `document.querySelector('.nav-tab[data-tab="clients"]').click()`);
await waitFor(cdp, `document.querySelectorAll('#clientsBox .clientpicker button').length >= 4`, 8000, '面板渲染');

// 展开 opencode 与 Claude Code 的代码块（它们是 details？不是——直接渲染的，无需展开）
await sleep(400);

for (const [name, theme] of [['clients-panel-light.png', 'light'], ['clients-panel-dark.png', 'dark']]) {
  await q(cdp, `document.documentElement.setAttribute('data-theme', '${theme}')`);
  await sleep(300);
  const res = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  const out = join(OUTDIR, name);
  writeFileSync(out, Buffer.from(res.result.data, 'base64'));
  console.log('wrote', out);
}

// 窄屏：四列会挤成一团，靠媒体查询折成「字段名 / 值+按钮 / 说明」三行
await q(cdp, `document.documentElement.setAttribute('data-theme', 'light')`);
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 430, height: 1400, deviceScaleFactor: 1, mobile: false });
await sleep(400);
const narrow = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
writeFileSync(join(OUTDIR, 'clients-panel-narrow.png'), Buffer.from(narrow.result.data, 'base64'));
console.log('wrote', join(OUTDIR, 'clients-panel-narrow.png'));

close();
server.close();
