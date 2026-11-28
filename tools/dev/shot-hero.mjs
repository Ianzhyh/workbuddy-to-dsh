/**
 * 生成 README 用的**视口尺寸**截图（浅色 + 深色、中 + 英，共四张）。
 *
 *   node tools/dev/shot-hero.mjs
 *
 * 产物：
 *   `docs/console-hero-light.png`    / `docs/console-hero-dark.png`     （中文 README）
 *   `docs/console-hero-en-light.png` / `docs/console-hero-en-dark.png`  （英文 README）
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
const W = 1360;
const H = 840;
const ACCENT = 'blue';

const LANGS = [
  { tag: '', suffix: '', name: '中文' },
  { tag: 'en', suffix: '-en', name: 'English' },
];

/** 基于标准夹具构造健康状态的脱敏演示数据（避免过时时间戳或模拟告警遮挡首屏）。 */
function buildHeroRoutes() {
  const routes = baseRoutes();
  const now = Date.now();
  const futureMs = now + 28 * 86400000;
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

  const acc = routes['/api/accounts'].body;
  if (acc && Array.isArray(acc.accounts)) {
    acc.accounts = [
      {
        ...acc.accounts[0],
        alias: 'Work CN',
        account: '330000000001',
        expiresAt: futureMs,
        remainingMs: 28 * 86400000,
        expired: false,
        active: true,
        valid: true,
        quotaRemain: 715,
        pluginAccount: 'demo-cn',
      },
      {
        ...acc.accounts[0],
        file: 'workbuddy-desktop-global.info',
        path: 'C:\\path\\to\\workbuddy-desktop-global.info',
        alias: 'Global Dev',
        account: '450000000002',
        domain: 'www.workbuddy.ai',
        expiresAt: futureMs + 7 * 86400000,
        remainingMs: 35 * 86400000,
        expired: false,
        active: false,
        valid: true,
        quotaRemain: 420,
        pluginAccount: 'demo-global',
      },
    ];
  }

  routes['/api/login'].body = {
    ok: true,
    configured: 'auto',
    envPinned: false,
    storeMode: 'dpapi',
    fallbackReason: '',
    desktop: { available: true, error: '' },
    plugin: { available: true, count: 2, activeUid: 'demo-uid-cn-0001', error: '' },
    effective: {
      source: 'desktop',
      uid: 'demo-uid-cn-0001',
      region: 'cn',
      endpoint: 'https://copilot.tencent.com',
      expiresAt: futureIso,
    },
    credentials: [
      {
        uid: 'demo-uid-cn-0001',
        account: 'demo-cn',
        region: 'cn',
        endpoint: 'https://copilot.tencent.com',
        expiresAt: futureIso,
        expired: false,
        active: true,
      },
      {
        uid: 'demo-uid-gl-0002',
        account: 'demo-global',
        region: 'global',
        endpoint: 'https://www.workbuddy.ai',
        expiresAt: futureIso,
        expired: false,
        active: false,
      },
    ],
  };

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

const server = await startStaticServer(PORT);

for (const lang of LANGS) {
  for (const theme of ['light', 'dark']) {
    const { cdp, close } = await openPage(
      `http://127.0.0.1:${PORT}/`,
      buildHeroRoutes(),
      { width: W, height: H, skipShapeCheck: true },
    );
    try {
      await waitFor(cdp, `document.querySelectorAll('.nav-tab').length >= 5`, 10000, '页签就绪');
      await q(cdp, `switchTab('overview')`);
      await q(cdp, `document.documentElement.setAttribute('data-theme', '${theme}');
                   document.documentElement.setAttribute('data-accent', '${ACCENT}')`);
      if (lang.tag) {
        await q(cdp, `document.getElementById('langToggle').click()`);
        await sleep(500);
      }
      await waitFor(cdp, `document.querySelectorAll('#cards .wb-kpi').length >= 6`, 8000, '状态卡');
      await sleep(700);

      const out = join(root, 'docs', `console-hero${lang.suffix}-${theme}.png`);
      const res = await cdp.send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(out, Buffer.from(res.result.data, 'base64'));
      console.log(`已生成：${out}（${W}×${H}，${theme}，${lang.name}）`);
    } finally {
      close();
    }
  }
}

server.close();
process.exit(0);
