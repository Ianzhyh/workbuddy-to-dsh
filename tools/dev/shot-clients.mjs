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

const PORT = 8787;
const URL_ = `http://127.0.0.1:${PORT}/`;
const OUTDIR = join(process.cwd(), 'docs');

const CLIENTS = {
  running: true,
  host: '127.0.0.1',
  port: 8790,
  baseUrlOpenAI: 'http://127.0.0.1:8790/v1',
  baseUrlAnthropic: 'http://127.0.0.1:8790',
  token: 'wb-local-bridge',
  anthropicModel: 'glm-5.3',
  anthropicFastModel: 'glm-5.3-flash',
  models: ['glm-5.3', 'deepseek-v4.1-flash', 'deepseek-v4-pro'],
  modelDetails: [
    { id: 'glm-5.3', name: 'GLM-5.3', context: 1000000, maxOutput: 64000, supportsReasoning: true, supportsImages: true },
    { id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash', context: 1000000, maxOutput: 128000, supportsReasoning: true, supportsImages: true },
    { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', context: 1000000, maxOutput: 128000, supportsReasoning: true, supportsImages: true },
  ],
};

const FIX = { bridge: { running: true, ok: true, host: '127.0.0.1', port: 8790, endpoint: 'http://127.0.0.1:8790/v1', pid: 1, startedAt: new Date().toISOString(), uptimeMs: 1000, catalogSize: 3, catalogAt: new Date().toISOString(), error: null } };

const routes = {
  '/api/clients': { body: CLIENTS },
  '/api/models': { body: { models: [] } },
  '/api/overview': {
    body: () => ({
      bridge: window.__FIX.bridge,
      credentials: { active: { account: '330000000000', userId: '330000000000', remainingMs: 40 * 86400000, expiresAt: Date.now() + 40 * 86400000 }, error: '' },
      quota: { total: 10, packages: [] },
      dsh: { routeLive: true, hasBridgeKey: true, bundlesOk: true, bundles: [], registeredModels: [] },
      console: { version: '1.0.0', node: 'v22' },
    }),
  },
  '/api/probe-results': { body: { updatedAt: null, results: {}, lastRun: null } },
  '/api/diagnose': { body: { items: [] } },
  '/api/usage': { body: { usage: null } },
  '/api/requests': { body: { requests: [] } },
  '/api/accounts': { body: { accounts: [] } },
  '/api/checkin': { body: { status: { active: true, todayCheckedIn: true, todayCredit: 0, streakDays: 0 } } },
  '/api/bridge/log': { body: { lines: [] } },
};

const INJECT = `window.__FIX = ${JSON.stringify(FIX)};`;

mkdirSync(OUTDIR, { recursive: true });
const server = await startStaticServer(PORT);
const { cdp, close } = await openPage(URL_, routes, { inject: INJECT, width: 1280, height: 1200 });

await q(cdp, `document.querySelector('.nav-tab[data-tab="clients"]').click()`);
await waitFor(cdp, `document.querySelectorAll('#clientsBox .clientcard').length >= 4`, 8000, '面板渲染');

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
