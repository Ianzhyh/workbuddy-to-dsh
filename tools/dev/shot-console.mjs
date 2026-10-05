/**
 * 生成控制台截图（用打桩数据渲染），用于 README 与人工确认新控件。
 *
 *   node tools/dev/shot-console.mjs
 *
 * 产物：docs/screenshot.png
 *
 * 刻意用打桩数据而不是真实控制台：截图会进仓库，真实账号 / 目录不该出现在里面。
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startStaticServer, openPage, waitFor, click, q, sleep } from './ui-harness.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = join(root, 'docs', 'screenshot.png');
const PORT = 8791;

const now = Date.now();
const CATALOG = [
  { id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash', context_window: 1000000, max_output_tokens: 128000, credits: 0.11 },
  { id: 'glm-5.3', name: 'GLM-5.3', context_window: 1000000, max_output_tokens: 48000, credits: 0.79 },
  { id: 'kimi-k3', name: 'Kimi-K3', context_window: 960000, max_output_tokens: 32000, credits: 0.35 },
  { id: 'hy3', name: 'HY3', context_window: 131072, max_output_tokens: 8192, credits: 0, free: true },
];

const USAGE = {
  windowDays: 7,
  total: { calls: 42, promptTokens: 186000, completionTokens: 42000, ms: 38000, credit: 1.24, creditCalls: 38, failed: 3 },
  models: [
    { model: 'deepseek-v4.1-flash', calls: 21, promptTokens: 120000, completionTokens: 30000, ms: 20000, credit: 0.62, creditCalls: 20 },
    { model: 'glm-5.3', calls: 12, promptTokens: 50000, completionTokens: 8000, ms: 12000, credit: 0.48, creditCalls: 11 },
    { model: 'kimi-k3', calls: 9, promptTokens: 16000, completionTokens: 4000, ms: 6000, credit: 0.14, creditCalls: 7 },
  ],
  days: [
    { day: '2026-09-28', calls: 3, promptTokens: 9000, completionTokens: 2000, credit: 0.08, creditCalls: 3 },
    { day: '2026-09-29', calls: 6, promptTokens: 21000, completionTokens: 5000, credit: 0.19, creditCalls: 6 },
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
  { t: now - 60000, model: 'glm-5.3', stream: false, ok: false, ms: 2400, status: 400, code: 'invalid_request', error: '{"error":{"message":"model not available in this region"}}' },
  { t: now - 90000, model: 'kimi-k3', stream: true, ok: true, ms: 960, promptTokens: 410, completionTokens: 130, credit: 0.02 },
  { t: now - 150000, model: 'deepseek-v4.1-flash', stream: false, ok: true, ms: 1440, promptTokens: 1200, completionTokens: 380, credit: 0.04 },
];

const routes = {
  '/api/models': { body: { models: CATALOG } },
  // 客户端接入面板：不打桩的话它会在截图里渲染成「读取失败」，而这张图要进 README。
  // 令牌用文档里的默认值 —— 它是本地回环令牌、README 本来就写着，不是上游凭据。
  '/api/clients': {
    body: {
      running: true,
      host: '127.0.0.1',
      port: 8790,
      baseUrlOpenAI: 'http://127.0.0.1:8790/v1',
      baseUrlAnthropic: 'http://127.0.0.1:8790',
      token: 'wb-local-bridge',
      anthropicModel: 'glm-5.3',
      anthropicFastModel: 'glm-5.3-flash',
      models: CATALOG.map((m) => m.id),
      // 逐字段复制表要拿真实的上下文 / 输出上限；不给的话模型那几行会是空的，
      // 而这张图是给用户看「该往表单里填什么」的，空着就失去意义了。
      modelDetails: CATALOG.map((m) => ({
        id: m.id,
        name: m.name,
        context: m.context_window,
        maxOutput: m.max_output_tokens,
        supportsReasoning: true,
        supportsImages: false,
      })),
    },
  },
  '/api/overview': {
    body: {
      bridge: { running: true, ok: true, host: '127.0.0.1', port: 8790, endpoint: 'http://127.0.0.1:8790/v1', pid: 18432, startedAt: new Date(now - 5400000).toISOString(), uptimeMs: 5400000, catalogSize: 4, catalogAt: new Date(now - 420000).toISOString() },
      credentials: { active: { account: 'example-account', userId: 'example-user-id', remainingMs: 44 * 86400000, expiresAt: now + 44 * 86400000 }, error: '' },
      quota: { total: 118, packages: [{ name: '每日签到', remain: 18, size: 20 }, { name: '月度额度', remain: 100, size: 200 }] },
      dsh: { routeLive: true, hasBridgeKey: true, bundlesOk: true, bundles: ['a', 'b', 'c'], registeredModels: ['deepseek-v4.1-flash', 'glm-5.3'] },
      console: { version: '1.0.0', node: 'v22.22.2' },
    },
  },
  '/api/probe-results': {
    body: {
      updatedAt: now - 180000,
      results: {
        'deepseek-v4.1-flash': { ok: true, ms: 1180, at: now - 200000, credit: 0 },
        'glm-5.3': { ok: false, ms: 2400, at: now - 190000, error: 'HTTP 400' },
        'kimi-k3': { ok: true, ms: 960, at: now - 185000, credit: 0 },
      },
      lastRun: { scope: 'checked', count: 2 },
    },
  },
  '/api/diagnose': { body: { items: [] } },
  '/api/usage': { body: { usage: USAGE } },
  '/api/requests': { body: { requests: REQUESTS } },
  '/api/accounts': { body: { accounts: [{ path: 'workbuddy-desktop.info', active: true, accountId: 'example-account' }] } },
  '/api/checkin': {
    body: {
      status: { active: true, todayCheckedIn: true, todayCredit: 18, streakDays: 6 },
      checkin: { auto: true, lastAt: now - 3600000, lastResult: 'ok', lastError: null, lastSource: 'startup' },
    },
  },
  '/api/bridge/log': { body: { lines: [] } },
};

const server = await startStaticServer(PORT);
const { cdp, close } = await openPage(`http://127.0.0.1:${PORT}/`, routes, { width: 1500, height: 1400 });
try {
  await waitFor(cdp, `document.querySelectorAll('#modelTable tbody tr').length === 4`, 10000, '模型表');
  // 切到「积分」指标：截图里体现新的折线 + 累计虚线
  await q(cdp, `(() => { const s = document.querySelector('#trendMetric'); if (s) { s.value = 'credit'; s.dispatchEvent(new Event('change')); } return true; })()`);
  // 点一次用量表行，把「已筛选」联动状态也拍进去
  await q(cdp, `(() => { const tr = document.querySelector('#usageBox tr.pickrow'); if (tr) tr.click(); return true; })()`);
  await sleep(800);
  const res = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  writeFileSync(OUT, Buffer.from(res.result.data, 'base64'));
  console.log('已生成：' + OUT);
} finally {
  close(); server.close();
}
