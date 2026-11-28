/**
 * 生成控制台整页截图（用打桩数据渲染），用于归档参考与人工确认控件。
 *
 *   node tools/dev/shot-console.mjs
 *
 * 产物：docs/screenshot.png / docs/screenshot-en.png
 *
 * 刻意用打桩数据而不是真实控制台：截图会进仓库，真实账号 / 目录不该出现在里面。
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startStaticServer, openPage, waitFor, q, sleep } from './ui-harness.mjs';
import { baseRoutes } from './fixtures.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = join(root, 'docs', 'screenshot.png');
const OUT_EN = join(root, 'docs', 'screenshot-en.png');
const PORT = 8791;

const now = Date.now();
const futureMs = now + 28 * 86400000;
const futureIso = new Date(futureMs).toISOString();

const CATALOG = [
  { id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash', context_window: 1000000, max_output_tokens: 128000, credits: 0.11, supports_images: true, supports_reasoning: true },
  { id: 'glm-5.3', name: 'GLM-5.3', context_window: 1000000, max_output_tokens: 48000, credits: 0.79, supports_images: true, supports_reasoning: true },
  { id: 'kimi-k3', name: 'Kimi-K3', context_window: 960000, max_output_tokens: 32000, credits: 0.35 },
  { id: 'hy3', name: 'HY3', context_window: 131072, max_output_tokens: 8192, credits: 0, free: true },
];

const USAGE = {
  windowDays: 7,
  total: { calls: 42, promptTokens: 186000, completionTokens: 42000, cachedTokens: 119000, ms: 38000, credit: 1.24, creditCalls: 38, failed: 3 },
  models: [
    { model: 'deepseek-v4.1-flash', calls: 21, promptTokens: 120000, completionTokens: 30000, ms: 20000, credit: 0.62, creditCalls: 20 },
    { model: 'glm-5.3', calls: 12, promptTokens: 50000, completionTokens: 8000, ms: 12000, credit: 0.48, creditCalls: 11 },
    { model: 'kimi-k3', calls: 9, promptTokens: 16000, completionTokens: 4000, ms: 6000, credit: 0.14, creditCalls: 7 },
  ],
  days: [
    { day: '2026-11-22', calls: 3, promptTokens: 9000, completionTokens: 2000, credit: 0.08, creditCalls: 3 },
    { day: '2026-11-23', calls: 6, promptTokens: 21000, completionTokens: 5000, credit: 0.19, creditCalls: 6 },
    { day: '2026-11-24', calls: 4, promptTokens: 14000, completionTokens: 3000, credit: 0.11, creditCalls: 4 },
    { day: '2026-11-25', calls: 9, promptTokens: 38000, completionTokens: 9000, credit: 0.27, creditCalls: 8 },
    { day: '2026-11-26', calls: 7, promptTokens: 30000, completionTokens: 7000, credit: 0.22, creditCalls: 7 },
    { day: '2026-11-27', calls: 8, promptTokens: 44000, completionTokens: 11000, credit: 0.24, creditCalls: 7 },
    { day: '2026-11-28', calls: 5, promptTokens: 30000, completionTokens: 5000, credit: 0.13, creditCalls: 3 },
  ],
  failures: [],
};

const REQUESTS = [
  { t: now - 20000, model: 'deepseek-v4.1-flash', stream: true, ok: true, ms: 1180, promptTokens: 820, completionTokens: 240, credit: 0.03 },
  { t: now - 60000, model: 'glm-5.3', stream: false, ok: false, ms: 2400, status: 400, code: 'invalid_request', error: '{"error":{"message":"model not available in this region"}}' },
  { t: now - 90000, model: 'kimi-k3', stream: true, ok: true, ms: 960, promptTokens: 410, completionTokens: 130, credit: 0.02 },
  { t: now - 150000, model: 'deepseek-v4.1-flash', stream: false, ok: true, ms: 1440, promptTokens: 1200, completionTokens: 380, credit: 0.04 },
];

const routes = baseRoutes({ catalog: CATALOG, usage: USAGE, requests: REQUESTS });
const ov = routes['/api/overview'].body;
if (ov.console) ov.console.version = '1.24.7';
if (ov.bridge?.auth) {
  ov.bridge.auth.expiresAt = futureIso;
  ov.bridge.auth.expired = false;
}
if (ov.credentials?.active) {
  ov.credentials.active.expiresAt = futureMs;
  ov.credentials.active.remainingMs = 28 * 86400000;
}
if (Array.isArray(ov.credentials?.files) && ov.credentials.files[0]) {
  ov.credentials.files[0].expiresAt = futureMs;
}

const server = await startStaticServer(PORT);
const { cdp, close } = await openPage(`http://127.0.0.1:${PORT}/`, routes, { width: 1480, height: 1400, skipShapeCheck: true });
try {
  await waitFor(cdp, `document.querySelectorAll('.nav-tab').length >= 5`, 10000, '页签就绪');
  await q(cdp, `switchTab('all')`);
  await q(cdp, `document.documentElement.setAttribute('data-theme', 'dark');
               document.documentElement.setAttribute('data-accent', 'blue')`);
  await waitFor(cdp, `document.querySelectorAll('#modelTable tbody tr').length === 4`, 10000, '模型表');
  await q(cdp, `(() => {
    const btns = Array.from(document.querySelectorAll('#usageBox button'));
    const creditBtn = btns.find((b) => (b.textContent || '').trim() === '积分');
    if (creditBtn) creditBtn.click();
    return true;
  })()`);
  await q(cdp, `(() => { const tr = document.querySelector('#usageBox tr.pickrow'); if (tr) tr.click(); return true; })()`);
  await sleep(450);
  await q(cdp, 'window.scrollTo(0, 0)');
  await sleep(450);
  const res = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  writeFileSync(OUT, Buffer.from(res.result.data, 'base64'));
  console.log('已生成：' + OUT);

  await q(cdp, `document.getElementById('langToggle').click()`);
  await sleep(700);
  await q(cdp, 'window.scrollTo(0, 0)');
  await sleep(350);
  const resEn = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  writeFileSync(OUT_EN, Buffer.from(resEn.result.data, 'base64'));
  console.log('已生成：' + OUT_EN);
} finally {
  close();
  server.close();
}
process.exit(0);
