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

/**
 * 目录给足 30 个，而**精选集仍是 4 个** —— 与线上一致（`/api/clients` 只回精选，
 * 选择器列完整目录）。截图里会显示「已选 4 / 30」。
 *
 * 用默认夹具的话两边都是 4 个，会显示成「已选 4 / 4」—— 恰好是用户报过的那个
 * bug（选择器只列精选集）的样子，放进 README 会让人误以为还没修。
 */
const CATALOG_30 = Array.from({ length: 30 }, (_, i) => ({
  id: i < 4
    ? ['deepseek-v4.1-flash', 'glm-5.3', 'glm-5.3-flash', 'kimi-k3-1'][i]
    : `model-${String(i + 1).padStart(2, '0')}`,
  name: i < 4 ? ['DeepSeek-V4.1-Flash', 'GLM-5.3', 'GLM-5.3-Flash', 'Kimi-K3.1'][i] : `Model ${i + 1}`,
  context_window: 128000 + i * 1000,
  max_output_tokens: 8192 + i * 100,
  credits: 0.1 + i * 0.01,
}));

// 桩数据来自共享夹具（tools/dev/fixtures.mjs）—— 形状由 ui-harness 自动校验
const routes = baseRoutes({ catalog: CATALOG_30 });

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
