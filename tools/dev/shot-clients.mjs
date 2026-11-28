/**
 * 给「客户端接入」面板截图（中/英 × 浅色/深色 + 窄屏）。
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

const CATALOG_30 = Array.from({ length: 30 }, (_, i) => ({
  id: i < 4
    ? ['deepseek-v4.1-flash', 'glm-5.3', 'glm-5.3-flash', 'kimi-k3-1'][i]
    : `model-${String(i + 1).padStart(2, '0')}`,
  name: i < 4 ? ['DeepSeek-V4.1-Flash', 'GLM-5.3', 'GLM-5.3-Flash', 'Kimi-K3.1'][i] : `Model ${i + 1}`,
  context_window: 128000 + i * 1000,
  max_output_tokens: 8192 + i * 100,
  credits: 0.1 + i * 0.01,
}));

function buildClientsRoutes() {
  const routes = baseRoutes({ catalog: CATALOG_30 });
  const futureMs = Date.now() + 28 * 86400000;
  const futureIso = new Date(futureMs).toISOString();

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
  if (ov.quota && Array.isArray(ov.quota.packages)) {
    ov.quota.packages = ov.quota.packages.map((p) => {
      const copy = { ...p };
      delete copy.expiresAt;
      return copy;
    });
  }
  const reqs = routes['/api/requests'].body;
  if (reqs && Array.isArray(reqs.requests)) {
    reqs.requests = reqs.requests.filter((it) => it.ok !== false);
  }
  const lim = routes['/api/limits'].body;
  if (lim && Array.isArray(lim.limiting)) {
    lim.limiting = [];
  }
  return routes;
}

mkdirSync(OUTDIR, { recursive: true });
const server = await startStaticServer(PORT);

for (const lang of [{ tag: '', suffix: '' }, { tag: 'en', suffix: '-en' }]) {
  const { cdp, close } = await openPage(URL_, buildClientsRoutes(), { width: 1360, height: 1180, skipShapeCheck: true });
  try {
    await waitFor(cdp, `document.querySelectorAll('.nav-tab').length >= 5`, 10000, '页签就绪');
    await q(cdp, `switchTab('clients')`);
    if (lang.tag) {
      await q(cdp, `document.getElementById('langToggle').click()`);
      await sleep(500);
    }
    await waitFor(cdp, `!!document.querySelector('#clientsBox details.manualconnect')`, 8000, '客户端面板');

    const opened = await q(cdp, `(() => {
      const d = document.querySelector('#clientsBox details.manualconnect');
      if (!d) return 'no-details';
      d.open = true;
      d.dispatchEvent(new Event('toggle'));
      return d.open ? 'ok' : 'still-closed';
    })()`);
    if (opened !== 'ok') throw new Error(`手动接入折叠区展开失败：${opened}`);

    await waitFor(cdp, `!!document.querySelector('#clientsBox details.manualconnect pre')`, 8000, '配置片段');
    await sleep(500);

    for (const theme of ['light', 'dark']) {
      await q(cdp, `document.documentElement.setAttribute('data-theme', '${theme}');
                   document.documentElement.setAttribute('data-accent', 'blue')`);
      await sleep(350);
      const res = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      const out = join(OUTDIR, `clients-panel${lang.suffix}-${theme}.png`);
      writeFileSync(out, Buffer.from(res.result.data, 'base64'));
      console.log('wrote', out);
    }

    if (!lang.tag) {
      await q(cdp, `document.documentElement.setAttribute('data-theme', 'light');
                   document.documentElement.setAttribute('data-accent', 'blue')`);
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 430, height: 1400, deviceScaleFactor: 1, mobile: false });
      await sleep(450);
      const narrow = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      const narrowOut = join(OUTDIR, 'clients-panel-narrow.png');
      writeFileSync(narrowOut, Buffer.from(narrow.result.data, 'base64'));
      console.log('wrote', narrowOut);
    }
  } finally {
    close();
  }
}

server.close();
process.exit(0);
