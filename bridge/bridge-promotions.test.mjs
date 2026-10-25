/**
 * 桥的模型目录促销集成测试。
 *
 * 用假上游回放三条 `modelPromotions`：
 *   - hy4-preview：全天免费的测试窗口 → 倍率 0 / free / promotion_active；
 *   - step-5-preview：已过期且 activeOnly → 徽章与 free 必须消失；
 *   - glm-5.2：0.5 折 → 0.395，且保留活动名；
 * 同时验证 tags 里的旧 `badge:` 不会把过期活动又带回来。
 *
 * 精确的 23:00/08:00 边界由 `promotions.test.mjs` 用固定时钟覆盖。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(HERE);
const BRIDGE = join(REPO, 'bridge', 'workbuddy-bridge.mjs');
const TOKEN = 'promotion-test-token';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const stub = createServer((req, res) => {
  if (req.url?.startsWith('/v3/config')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      data: {
        models: [
          {
            id: 'hy4-preview', name: 'Hy4 preview', maxInputTokens: 300000, maxOutputTokens: 64000,
            credits: 0.29, supportsToolCall: true, supportsImages: true, supportsReasoning: true,
            reasoning: { supportedEfforts: ['high'] }, tags: ['craft'],
          },
          {
            id: 'step-5-preview', name: 'Step-5-Preview', maxInputTokens: 1000000, maxOutputTokens: 64000,
            credits: 0.43, supportsToolCall: true, tags: ['craft'],
          },
          {
            id: 'glm-5.2', name: 'GLM-5.2', maxInputTokens: 300000, maxOutputTokens: 48000,
            credits: 0.79, supportsToolCall: true, supportsReasoning: true,
            reasoning: { supportedEfforts: ['high'] }, tags: ['craft'],
          },
        ],
        modelPromotions: [
          {
            enabled: true, kind: 'discount', modelIds: ['hy4-preview'],
            badge: { label: '夜间免费', color: '#1E90FF' },
            discount: { factor: 0, discountedCredits: '0x' },
            schedule: { daily: [{ start: '00:00', end: '23:59' }], timezone: 'Asia/Shanghai' },
            hover: { textZh: '测试：全天免费' },
          },
          {
            enabled: true, kind: 'discount', modelIds: ['step-5-preview'],
            badge: { label: '独家限免', display: 'activeOnly' },
            discount: { factor: 0 },
            schedule: { validUntil: '2020-01-01T00:00:00+08:00', timezone: 'Asia/Shanghai' },
          },
          {
            enabled: true, kind: 'discount', modelIds: ['glm-5.2'],
            badge: { label: '夜间折扣' },
            discount: { factor: 0.5, discountedCredits: '0.50x' },
            schedule: { daily: [{ start: '00:00', end: '23:59' }], timezone: 'Asia/Shanghai' },
          },
        ],
      },
    }));
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end('{}');
});
await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
const STUB = `http://127.0.0.1:${stub.address().port}`;

const dir = mkdtempSync(join(tmpdir(), 'wb-promotions-'));
const authFile = join(dir, 'auth.info');
writeFileSync(authFile, JSON.stringify({
  auth: {
    accessToken: 'fake-promotion-token',
    refreshToken: 'fake-refresh-token',
    domain: 'example.invalid',
    expiresAt: Date.now() + 3_600_000,
  },
}));

const port = 23000 + Math.floor(Math.random() * 20000);
const child = spawn(process.execPath, [BRIDGE], {
  cwd: dir,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    WORKBUDDY_HOST: '127.0.0.1',
    WORKBUDDY_PORT: String(port),
    WORKBUDDY_LOCAL_TOKEN: TOKEN,
    WORKBUDDY_AUTH_FILE: authFile,
    WORKBUDDY_CREDENTIAL_DIR: join(dir, 'credentials'),
    WORKBUDDY_USAGE_FILE: join(dir, 'usage.jsonl'),
    CODEBUDDY_ENDPOINT: STUB,
    WORKBUDDY_AUTO_CHECKIN: '0',
    WORKBUDDY_LOG: '0',
  },
  windowsHide: true,
});
let logs = '';
child.stdout.on('data', (d) => { logs += d; });
child.stderr.on('data', (d) => { logs += d; });

const base = `http://127.0.0.1:${port}`;
const auth = { authorization: `Bearer ${TOKEN}` };
for (let i = 0; i < 80; i += 1) {
  try {
    const res = await fetch(base + '/', { headers: auth, signal: AbortSignal.timeout(1000) });
    if (res.ok) break;
  } catch { /* 还没起来 */ }
  if (i === 79) throw new Error(`桥未就绪：\n${logs.slice(-1200)}`);
  await sleep(200);
}

test('桥：促销按生效时间输出倍率/free/badge，过期活动被隐藏', async () => {
  let payload = null;
  for (let i = 0; i < 40; i += 1) {
    const res = await fetch(base + '/v1/models?all=1', { headers: auth, signal: AbortSignal.timeout(15000) });
    assert.equal(res.status, 200);
    payload = await res.json();
    if (payload.data?.some((model) => model.id === 'hy4-preview')) break;
    await sleep(200);
  }
  const models = new Map((payload?.data || []).map((model) => [model.id, model]));
  assert.ok(models.has('hy4-preview'), logs.slice(-1000));

  const hy4 = models.get('hy4-preview');
  assert.equal(hy4.credits, 0, '生效中的 factor 0 必须把倍率算成 0');
  assert.equal(hy4.free, true);
  assert.equal(hy4.badge, '夜间免费');
  assert.equal(hy4.promotion_active, true);
  assert.equal(hy4.promotion_text, '测试：全天免费');
  assert.deepEqual(hy4.tags.filter((tag) => /^badge:/.test(tag)), ['badge:夜间免费:#1E90FF']);

  const expired = models.get('step-5-preview');
  assert.equal(expired.credits, 0.43);
  assert.equal(expired.free, undefined);
  assert.equal(expired.badge, undefined, '过期 activeOnly 活动不能继续显示徽章');
  assert.equal(expired.promotion_active, undefined);
  assert.deepEqual(expired.tags.filter((tag) => /^badge:/.test(tag)), [], 'tags 里也不能残留旧徽章');

  const discounted = models.get('glm-5.2');
  assert.equal(discounted.credits, 0.395);
  assert.equal(discounted.free, undefined);
  assert.equal(discounted.badge, '夜间折扣');
  assert.equal(discounted.promotion_active, true);
  assert.equal(discounted.promotion_factor, 0.5);
});

test.after(async () => {
  try { child.kill(); } catch { /* 忽略 */ }
  if (child.exitCode === null) {
    await new Promise((resolve) => {
      child.once('exit', resolve);
      setTimeout(resolve, 1200);
    });
  }
  try { stub.close(); } catch { /* 忽略 */ }
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
});
