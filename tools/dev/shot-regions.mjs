/**
 * 按区域截图，用于设计审查（整页截图缩得太小看不清细节）。
 *
 *   node tools/dev/shot-regions.mjs
 *
 * 输出到 docs/_review/（下划线前缀已被 .gitignore 忽略，属临时审查产物）。
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { startStaticServer, openPage, waitFor, q, sleep } from './ui-harness.mjs';

const PORT = 8784;
const URL_ = `http://127.0.0.1:${PORT}/`;
const OUTDIR = join(process.cwd(), 'docs', '_review');

const CATALOG = [
  { id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash', context_window: 1000000, max_output_tokens: 128000, credits: 0.11, supports_images: true },
  { id: 'glm-5.3', name: 'GLM-5.3', context_window: 1000000, max_output_tokens: 48000, credits: 0.79, supports_images: true },
  { id: 'glm-5.3-flash', name: 'GLM-5.3-Flash', context_window: 1000000, max_output_tokens: 131072, credits: 0.06 },
  { id: 'kimi-k3-1', name: 'Kimi-K3.1', context_window: 960000, max_output_tokens: 32000, credits: 1.62 },
];
const now = Date.now();
const USAGE = {
  windowDays: 7,
  // 字段名与真实 /api/usage 保持一致（total / models / days），写错会让用量表静默不渲染
  total: { calls: 118, promptTokens: 241000, completionTokens: 51000, ms: 92000, credit: 1.28, creditCalls: 104, failed: 3 },
  models: [
    { model: 'deepseek-v4.1-flash', calls: 61, promptTokens: 128000, completionTokens: 30000, ms: 48000, credit: 0.61, creditCalls: 55 },
    { model: 'glm-5.3', calls: 44, promptTokens: 97000, completionTokens: 19000, ms: 38000, credit: 0.62, creditCalls: 42 },
    { model: 'kimi-k3-1', calls: 13, promptTokens: 16000, completionTokens: 2000, ms: 6000, credit: 0.05, creditCalls: 7 },
  ],
  days: [
    { day: '2026-09-30', calls: 4, promptTokens: 14000, completionTokens: 3000, credit: 0.11, creditCalls: 4 },
    { day: '2026-10-01', calls: 9, promptTokens: 38000, completionTokens: 9000, credit: 0.27, creditCalls: 8 },
    { day: '2026-10-02', calls: 7, promptTokens: 30000, completionTokens: 7000, credit: 0.22, creditCalls: 7 },
    { day: '2026-10-03', calls: 8, promptTokens: 44000, completionTokens: 11000, credit: 0.24, creditCalls: 7 },
    { day: '2026-10-04', calls: 5, promptTokens: 30000, completionTokens: 5000, credit: 0.13, creditCalls: 3 },
  ],
  failures: [],
};
const REQUESTS = [
  { t: now - 20000, model: 'deepseek-v4.1-flash', stream: true, ok: true, ms: 1180, promptTokens: 820, completionTokens: 240, credit: 0.03 },
  { t: now - 60000, model: 'glm-5.3', stream: false, ok: false, ms: 2400, status: 400, code: 11101, error: '{"msg":"Non-stream chat request is currently not supported"}' },
  { t: now - 90000, model: 'kimi-k3-1', stream: true, ok: true, ms: 960, promptTokens: 410, completionTokens: 130, credit: 0.02 },
  { t: now - 150000, model: 'glm-5.3-flash', stream: false, ok: true, ms: 1440, promptTokens: 1200, completionTokens: 380, credit: 0.04 },
];

const routes = {
  '/api/models': { body: { models: CATALOG } },
  '/api/clients': { body: { running: true, host: '127.0.0.1', port: 8790, baseUrlOpenAI: 'http://127.0.0.1:8790/v1', baseUrlAnthropic: 'http://127.0.0.1:8790', token: 'wb-local-bridge', anthropicModel: 'glm-5.3', anthropicFastModel: 'glm-5.3-flash', models: CATALOG.map((m) => m.id), modelDetails: CATALOG.map((m) => ({ id: m.id, name: m.name, context: m.context_window, maxOutput: m.max_output_tokens })) } },
  '/api/overview': {
    body: {
      bridge: { running: true, ok: true, host: '127.0.0.1', port: 8790, endpoint: 'http://127.0.0.1:8790/v1', pid: 18432, startedAt: new Date(now - 5400000).toISOString(), uptimeMs: 5400000, catalogSize: 4, catalogAt: new Date(now - 420000).toISOString() },
      credentials: { active: { account: '330101979236', userId: '330101979236', remainingMs: 37 * 86400000, expiresAt: now + 37 * 86400000 }, error: '' },
      quota: { total: 715, packages: [{ name: '每日签到', remain: 18, size: 20 }] },
      dsh: { routeLive: true, hasBridgeKey: true, bundlesOk: true, bundles: ['a'], registeredModels: ['glm-5.3'] },
      console: { version: '1.0.0', node: 'v22.22.2' },
    },
  },
  '/api/probe-results': { body: { updatedAt: null, results: {}, lastRun: null } },
  '/api/diagnose': { body: { items: [] } },
  '/api/usage': { body: { usage: USAGE } },
  '/api/requests': { body: { requests: REQUESTS } },
  '/api/accounts': { body: { accounts: [] } },
  '/api/checkin': { body: { status: { active: true, todayCheckedIn: true, todayCredit: 18, streakDays: 3 } } },
  '/api/bridge/log': { body: { lines: [] } },
};

mkdirSync(OUTDIR, { recursive: true });
const server = await startStaticServer(PORT);
const { cdp, close } = await openPage(URL_, routes, { width: 1280, height: 900 });
await sleep(1400);

const REGIONS = [
  ['cards', '.cards'],
  ['usage', '[data-section="overview"]:nth-of-type(2)'],
  ['models', '[data-section="models"]'],
  ['requests', '#reqBox'],
];

for (const [name, sel] of REGIONS) {
  const box = await q(cdp, `(() => {
    const el = document.querySelector('${sel}');
    if (!el) return null;
    el.scrollIntoView({ block: 'start' });
    const r = el.getBoundingClientRect();
    return { x: Math.max(0, r.x), y: Math.max(0, r.y + window.scrollY), w: r.width, h: Math.min(r.height, 1600) };
  })()`);
  if (!box) { console.log('skip (not found):', name, sel); continue; }
  const shot = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
    clip: { x: box.x, y: box.y, width: box.w, height: box.h, scale: 1 },
  });
  const out = join(OUTDIR, name + '.png');
  writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
  console.log('wrote', out, `${Math.round(box.w)}×${Math.round(box.h)}`);
}

close();
server.close();
