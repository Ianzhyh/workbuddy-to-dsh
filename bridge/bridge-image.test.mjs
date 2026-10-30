/**
 * /v1/images 的端到端合约：真起桥 + 桩 WorkBuddy 网关与 Miora 上游。
 *
 * 覆盖：文生图/图生图路径语义、图片映射、查询与下载、错误码、本地令牌闸门、账本。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pickBridgePort } from '../tools/dev/bridge-ports.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(HERE);
const BRIDGE = join(REPO, 'bridge', 'workbuddy-bridge.mjs');
const TOKEN = 'image-test-token';

const submitCalls = [];
const queryCalls = [];
let apiKeyCalls = 0;
// 模拟账号积分：每次成功提交扣 1.5，桥用提交前后余额差记录 creditEstimate。
let quotaRemain = 1000;

const stub = createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { /* 非 JSON */ }
    const json = (status, value, headers = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(value));
    };

    if (req.url === '/v2/api-keys') {
      apiKeyCalls += 1;
      return json(200, {
        code: 0,
        data: { key: `ck_t_image_${apiKeyCalls}`, expires_at: new Date(Date.now() + 900_000).toISOString() },
      });
    }
    if (req.url === '/v2/billing/meter/get-user-resource') {
      return json(200, {
        code: 0,
        data: {
          Response: {
            Data: {
              Accounts: [{ CapacityType: 0, CapacitySize: 1000, CapacityRemain: quotaRemain }],
            },
          },
        },
      });
    }
    if (req.url === '/api/ai/workbuddy-proxy/image/generate/submit'
      || req.url === '/api/ai/workbuddy-proxy/image/edit/submit') {
      submitCalls.push({ path: req.url, headers: req.headers, body });
      const prompt = String(body?.prompt || '');
      if (prompt.includes('reject')) {
        return json(200, {
          failed: true,
          message: 'upstream image-generate failed: status=400 code=14407 msg=CONTENT_SAFETY',
        });
      }
      if (prompt.includes('sync-fail')) {
        return json(200, {
          code: 0,
          failed: false,
          data: {
            upstreamTaskId: 'wb-sync-img-fail',
            mode: 'sync',
            status: 'FAILED',
            errorMessage: 'content safety',
          },
        });
      }
      if (prompt.includes('processing')) {
        quotaRemain -= 1.5;
        return json(200, {
          code: 0,
          failed: false,
          data: { upstreamTaskId: 'img-processing', model: 'miora-image', provider: 'copilot-image', mode: 'async' },
        });
      }
      if (prompt.includes('sync-ok')) {
        // 不改余额：同步完成不一定当场扣分（也可能延迟出账），估算应保持 null。
        return json(200, {
          code: 0,
          failed: false,
          data: {
            upstreamTaskId: 'wb-sync-img-ok',
            model: 'hy-image',
            provider: 'copilot-image',
            mode: 'sync',
            status: 'completed',
            resultFiles: [{
              signedUrl: 'https://cdn.example/sync.png',
              mimeType: 'image/png',
              fileKey: 'file/sync-image',
            }],
          },
        });
      }
      quotaRemain -= 1.5;
      return json(200, {
        code: 0,
        failed: false,
        data: {
          upstreamTaskId: req.url.endsWith('/edit/submit') ? 'img-edit' : 'img-1',
          model: 'miora-image',
          provider: 'copilot-image',
          mode: 'async',
        },
      });
    }
    if (req.url === '/api/ai/workbuddy-proxy/image/query-task') {
      queryCalls.push({ headers: req.headers, body });
      const id = body?.upstreamTaskIds?.[0];
      if (id === 'missing') return json(200, { code: 0, failed: false, data: {} });
      if (id === 'img-processing') {
        return json(200, { code: 0, failed: false, data: { 'img-processing': { status: 'processing' } } });
      }
      if (id === 'img-empty') {
        return json(200, {
          code: 0, failed: false, data: { 'img-empty': { status: 'completed', resultFiles: [] } },
        });
      }
      if (id === 'img-failed') {
        return json(200, {
          code: 0,
          failed: false,
          data: { 'img-failed': { status: 'failed', errorMessage: 'content safety' } },
        });
      }
      return json(200, {
        code: 0,
        failed: false,
        data: {
          [id]: {
            status: 'completed',
            resultFiles: [{
              signedUrl: 'https://cdn.example/image.png',
              mimeType: 'image/png',
              fileKey: 'file/image',
            }],
          },
        },
      });
    }
    return json(404, {});
  });
});
await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
const STUB = `http://127.0.0.1:${stub.address().port}`;

const dir = mkdtempSync(join(tmpdir(), 'wb-image-'));
const authFile = join(dir, 'auth.info');
writeFileSync(authFile, JSON.stringify({
  auth: {
    accessToken: 'fake-access-token',
    refreshToken: 'fake-refresh-token',
    domain: 'example.invalid',
    expiresAt: Date.now() + 3_600_000,
  },
}));

const port = pickBridgePort();
const child = spawn(process.execPath, [BRIDGE], {
  cwd: dir,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    WORKBUDDY_HOST: '127.0.0.1',
    WORKBUDDY_PORT: String(port),
    WORKBUDDY_LOCAL_TOKEN: TOKEN,
    WORKBUDDY_CLIENT_KEYS: 'image-client-key',
    WORKBUDDY_AUTH_FILE: authFile,
    WORKBUDDY_CREDENTIAL_DIR: join(dir, 'credentials'),
    WORKBUDDY_USAGE_FILE: join(dir, 'usage.jsonl'),
    WORKBUDDY_MEDIA_STORE_FILE: join(dir, 'media-tasks.json'),
    CODEBUDDY_ENDPOINT: STUB,
    WORKBUDDY_MIORA_BASE: STUB,
    WORKBUDDY_BILLING_BASE: STUB,
    WORKBUDDY_SKIP_MODEL_PREFLIGHT: '1',
    WORKBUDDY_AUTO_CHECKIN: '0',
    WORKBUDDY_LOG: '0',
    // 长轮询测试只需要确认“等不到会回 202”，不要真等 90 秒。
    WORKBUDDY_IMAGE_SYNC_WAIT_S: '1',
    // 小上限只用于验证 413 的形状；正常提交（含 prompt）远低于它。
    WORKBUDDY_MAX_BODY_BYTES: '65536',
  },
  windowsHide: true,
});
let logs = '';
child.stdout.on('data', (data) => { logs += data; });
child.stderr.on('data', (data) => { logs += data; });

const base = `http://127.0.0.1:${port}`;
const headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
for (let attempt = 0; attempt < 80; attempt += 1) {
  try {
    const response = await fetch(`${base}/`, { headers, signal: AbortSignal.timeout(1000) });
    if (response.ok) break;
  } catch { /* 还没起来 */ }
  if (attempt === 79) throw new Error(`桥未就绪：\n${logs.slice(-1200)}`);
  await new Promise((resolve) => setTimeout(resolve, 200));
}

const post = (path, body) => fetch(base + path, {
  method: 'POST',
  headers,
  body: JSON.stringify(body),
  signal: AbortSignal.timeout(15_000),
});
const get = (path, options = {}) => fetch(base + path, {
  headers,
  signal: AbortSignal.timeout(15_000),
  ...options,
});

test.after(async () => {
  child.kill();
  await new Promise((resolve) => { child.once('exit', resolve); setTimeout(resolve, 2000); });
  await new Promise((resolve) => stub.close(resolve));
  rmSync(dir, { recursive: true, force: true });
});

test('文生图：POST /v1/images 返回 202，查询补回元数据，下载 302', async () => {
  const submit = await post('/v1/images', {
    prompt: 'a red fox in snow',
    size: '1024x1024',
    quality: 'HD',
  });
  assert.equal(submit.status, 202);
  const image = await submit.json();
  assert.equal(image.object, 'image');
  assert.equal(image.id, 'img-1');
  assert.equal(image.status, 'queued');
  assert.equal(image.mode, 'generate');
  assert.equal(image.size, '1024x1024');

  const sent = submitCalls.at(-1);
  assert.equal(sent.path, '/api/ai/workbuddy-proxy/image/generate/submit');
  assert.deepEqual(sent.body, { prompt: 'a red fox in snow', size: '1024x1024', quality: 'HD' });

  const lookup = await get('/v1/images/img-1');
  assert.equal(lookup.status, 200);
  const queried = await lookup.json();
  assert.equal(queried.status, 'completed');
  assert.equal(queried.mode, 'generate');
  assert.equal(queried.size, '1024x1024');
  assert.equal(typeof queried.created_at, 'number');
  assert.equal(queried.output.url, 'https://cdn.example/image.png');

  const content = await get('/v1/images/img-1/content', { redirect: 'manual' });
  assert.equal(content.status, 302);
  assert.equal(content.headers.get('location'), 'https://cdn.example/image.png');
});

test('图生图：/v1/images/edits 默认 edit，images 映射到上游 images[]', async () => {
  const edit = await post('/v1/images/edits', {
    prompt: 'make the sky purple',
    images: ['file/abc/ref.png', 'https://cdn.example/ref.png'],
    size: '1024x768',
  });
  assert.equal(edit.status, 202);
  const body = await edit.json();
  assert.equal(body.mode, 'edit');
  assert.equal(body.id, 'img-edit');

  const sent = submitCalls.at(-1);
  assert.equal(sent.path, '/api/ai/workbuddy-proxy/image/edit/submit');
  assert.deepEqual(sent.body, {
    prompt: 'make the sky purple',
    size: '1024x768',
    images: [{ file_key: 'file/abc/ref.png' }, { url: 'https://cdn.example/ref.png' }],
  });
});

test('路径语义：/v1/images 带 images 会 400，不会悄悄改成图生图', async () => {
  const before = submitCalls.length;
  const conflict = await post('/v1/images', { prompt: 'x', images: ['file/a'] });
  assert.equal(conflict.status, 400);
  const body = await conflict.json();
  assert.equal(body.error.code, 'IMAGE_INVALID_INPUT');
  assert.match(body.error.message, /does not accept images/);
  assert.equal(submitCalls.length, before, '非法输入不应打上游');
});

test('本地校验：未知字段/坏 size 不提交上游', async () => {
  const before = submitCalls.length;
  const unknown = await post('/v1/images', { prompt: 'x', aspect_ratio: '16:9' });
  assert.equal(unknown.status, 400);
  assert.match((await unknown.json()).error.message, /unknown field/);

  const badSize = await post('/v1/images', { prompt: 'x', size: 'wide' });
  assert.equal(badSize.status, 400);
  assert.match((await badSize.json()).error.message, /WIDTHxHEIGHT/);
  assert.equal(submitCalls.length, before);
});

test('client key 不能调用图片接口', async () => {
  const clientHeaders = { authorization: 'Bearer image-client-key', 'content-type': 'application/json' };
  const submit = await fetch(`${base}/v1/images`, {
    method: 'POST',
    headers: clientHeaders,
    body: JSON.stringify({ prompt: 'x' }),
    signal: AbortSignal.timeout(15_000),
  });
  assert.equal(submit.status, 403);
  assert.equal((await submit.json()).error.code, 'IMAGE_LOCAL_TOKEN_REQUIRED');

  const lookup = await fetch(`${base}/v1/images/img-1`, {
    headers: { authorization: 'Bearer image-client-key' },
    signal: AbortSignal.timeout(15_000),
  });
  assert.equal(lookup.status, 403);
  assert.equal((await lookup.json()).error.code, 'IMAGE_LOCAL_TOKEN_REQUIRED');
});

test('查询错误：不存在 404；失败任务 200 + error；未完成/无产物分别 409/502', async () => {
  const missing = await get('/v1/images/missing');
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error.code, 'IMAGE_NOT_FOUND');

  const failed = await get('/v1/images/img-failed');
  assert.equal(failed.status, 200);
  const failedBody = await failed.json();
  assert.equal(failedBody.status, 'failed');
  assert.equal(failedBody.error.message, 'content safety');

  const pending = await get('/v1/images/img-processing/content', { redirect: 'manual' });
  assert.equal(pending.status, 409);
  assert.equal((await pending.json()).error.code, 'IMAGE_NOT_READY');

  const empty = await get('/v1/images/img-empty/content', { redirect: 'manual' });
  assert.equal(empty.status, 502);
  assert.equal((await empty.json()).error.code, 'IMAGE_NO_OUTPUT');
});

test('上游拒绝：200+failed(status=400) 映射成 400 IMAGE_UPSTREAM_REJECTED', async () => {
  const rejected = await post('/v1/images', { prompt: 'reject me' });
  assert.equal(rejected.status, 400);
  const body = await rejected.json();
  assert.equal(body.error.code, 'IMAGE_UPSTREAM_REJECTED');
  assert.match(body.error.message, /CONTENT_SAFETY/);
});

test('同步完成：HTTP 200 + sync=true，查询与 /content 都命中提交缓存', async () => {
  const submit = await post('/v1/images', { prompt: 'sync-ok please' });
  assert.equal(submit.status, 200, '同步完成已不是 202 Accepted');
  const image = await submit.json();
  assert.equal(image.id, 'wb-sync-img-ok');
  assert.equal(image.status, 'completed');
  assert.equal(image.sync, true);
  assert.equal(image.output.url, 'https://cdn.example/sync.png');
  assert.equal(image.result_files[0].fileKey, 'file/sync-image');

  const queriesBefore = queryCalls.length;
  const lookup = await get('/v1/images/wb-sync-img-ok');
  assert.equal(lookup.status, 200);
  const queried = await lookup.json();
  assert.equal(queried.status, 'completed');
  assert.equal(queried.sync, true);
  assert.equal(queried.output.url, 'https://cdn.example/sync.png');
  assert.equal(queryCalls.length, queriesBefore, '缓存命中不应再查询上游');

  const content = await get('/v1/images/wb-sync-img-ok/content', { redirect: 'manual' });
  assert.equal(content.status, 302);
  assert.equal(content.headers.get('location'), 'https://cdn.example/sync.png');
});

test('同步失败：账本按失败记（IMAGE_GENERATION_FAILED），查询仍能拿到真实原因', async () => {
  const usageBefore = await (await get('/v1/usage?days=1')).json();
  const submit = await post('/v1/images', { prompt: 'sync-fail please' });
  assert.equal(submit.status, 200);
  const failed = await submit.json();
  assert.equal(failed.status, 'failed');
  assert.equal(failed.sync, true);
  assert.equal(failed.error.message, 'content safety');

  const lookup = await get('/v1/images/wb-sync-img-fail');
  const queried = await lookup.json();
  assert.equal(queried.status, 'failed');
  assert.equal(queried.error.message, 'content safety');

  const usageAfter = await (await get('/v1/usage?days=1')).json();
  assert.equal(usageAfter.total.imageFailed, usageBefore.total.imageFailed + 1, '同步失败要计入失败');
  assert.equal(usageAfter.total.images, usageBefore.total.images, '同步失败不能算成功提交');

  const ledger = await (await get('/v1/requests?limit=100')).json();
  assert.ok(ledger.requests.some((row) => row.kind === 'image'
    && row.ok === false
    && row.code === 'IMAGE_GENERATION_FAILED'
    && /content safety/.test(row.error || '')), '账本要留下同步失败原因');
});

test('请求体超限：413 带 IMAGE_PAYLOAD_TOO_LARGE 与可执行建议', async () => {
  const huge = await post('/v1/images', { prompt: 'x'.repeat(70000) });
  assert.equal(huge.status, 413);
  const body = await huge.json();
  assert.equal(body.error.code, 'IMAGE_PAYLOAD_TOO_LARGE');
  assert.match(body.error.message, /fileKey|https|WORKBUDDY_MAX_BODY_BYTES/);

  const ledger = await (await get('/v1/requests?limit=100')).json();
  assert.ok(ledger.requests.some((row) => row.kind === 'image'
    && row.ok === false
    && row.code === 'IMAGE_PAYLOAD_TOO_LARGE'), '413 也要进账本失败列表');
});

test('账本：图片提交单独计数，不污染模型调用/tokens/积分', async () => {
  const ledger = await (await get('/v1/requests?limit=50')).json();
  const rows = ledger.requests.filter((row) => row.kind === 'image');
  assert.ok(rows.length >= 3, `图片提交应进账本，实际 ${rows.length} 条`);
  assert.ok(rows.some((row) => row.ok === true), '成功提交应进账本');
  assert.ok(rows.some((row) => row.ok === false), '失败的图片提交也要留痕');
  assert.ok(rows.every((row) => row.model === 'image'));

  const usage = await (await get('/v1/usage?days=1')).json();
  assert.ok(usage.total.images >= 2, `成功提交应计入 images，实际 ${usage.total.images}`);
  assert.ok(usage.total.imageFailed >= 1, `失败提交应计入 imageFailed，实际 ${usage.total.imageFailed}`);
  assert.equal(usage.total.calls, 0, '图片不能混进模型调用次数');
  assert.ok(rows.some((row) => row.creditEstimate === 1.5), '提交前后余额差应记进 creditEstimate');
  assert.ok(usage.total.imageCredit >= 3, `图片估算积分应累加，实际 ${usage.total.imageCredit}`);
  assert.equal(usage.total.imageCreditKnown, 2, '只有两次成功提交采到了余额差');
  assert.equal(usage.total.promptTokens + usage.total.completionTokens, 0, '图片没有模型 token');
  assert.equal(usage.models.some((model) => model.model === 'image'), false, '模型排行不应出现 image');
  assert.ok(usage.failures.some((failure) => failure.kind === 'image'), '失败列表要能区分图片');
});

test('OpenAI Images：同步完成回 200 + data[].url，并剥掉标准字段', async () => {
  const res = await post('/v1/images/generations', {
    model: 'gpt-image-1',
    prompt: 'sync-ok',
    n: 1,
    size: '1024x1024',
    response_format: 'url',
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(typeof body.created, 'number');
  assert.deepEqual(body.data, [{ url: 'https://cdn.example/sync.png' }]);
  const sent = submitCalls.at(-1);
  assert.equal(sent.path, '/api/ai/workbuddy-proxy/image/generate/submit');
  assert.deepEqual(sent.body, { prompt: 'sync-ok', size: '1024x1024' },
    'model/n/response_format 是标准客户端字段，不能原样塞给上游');
});

test('OpenAI Images：等待超时回 202 + job id，不伪装成成功', async () => {
  const res = await post('/v1/images/generations', { prompt: 'processing' });
  assert.equal(res.status, 202);
  assert.equal(res.headers.get('x-workbuddy-job-id'), 'img-processing');
  assert.match(res.headers.get('location') || '', /\/v1\/images\/img-processing$/);
  const body = await res.json();
  assert.equal(body.id, 'img-processing');
  assert.equal(body.status, 'in_progress', '上游 processing 归一成 in_progress');
  assert.equal(body.data, undefined, '未完成时不能给 data');
});

test('OpenAI Images：同一个 Idempotency-Key 只提交一次，第二次标记 replay', async () => {
  const before = submitCalls.length;
  const send = () => fetch(base + '/v1/images/generations', {
    method: 'POST',
    headers: { ...headers, 'idempotency-key': 'idem-sync-1' },
    body: JSON.stringify({ prompt: 'sync-ok', size: '512x512' }),
    signal: AbortSignal.timeout(15_000),
  });
  const first = await send();
  const second = await send();
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(second.headers.get('x-workbuddy-idempotent-replay'), '1',
    '第二次命中幂等缓存时必须如实标记');
  assert.equal(submitCalls.length, before + 1, '重复请求不能再次提交上游（会重复扣积分）');
});

test('客户端中途断开上传不能打死桥进程', { timeout: 30_000 }, async () => {
  /*
   * 上传进行到一半客户端取消（用户点停止 / 网络断）：readBody 会以 socket 错误
   * reject。这个 Rejection 必须被 media handler/dispatcher 接住 —— 逃出去就是
   * unhandled rejection，Node 默认直接退出整个桥进程。
   */
  await new Promise((resolve) => {
    const req = httpRequest({
      hostname: '127.0.0.1',
      port,
      path: '/v1/images',
      method: 'POST',
      headers: { ...headers, 'content-length': '60000' },
    }, (res) => { res.resume(); resolve(); });
    req.on('error', () => resolve());
    req.write('{"prompt":"aborted upload"');
    setTimeout(() => { req.destroy(); resolve(); }, 200);
  });
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(child.exitCode, null, `客户端断开不应让桥退出：\n${logs.slice(-800)}`);
  const health = await fetch(`${base}/health`, { headers, signal: AbortSignal.timeout(3000) });
  assert.equal(health.status, 200, '桥必须仍然可用');
  await health.text();
});

test('OpenAI Images：n>1 / stream / 未知字段在本地 400，不提交上游', async () => {
  const before = submitCalls.length;
  const multi = await post('/v1/images/generations', { prompt: 'x', n: 2 });
  assert.equal(multi.status, 400);
  assert.match((await multi.json()).error.message, /n must be 1/);

  const streamed = await post('/v1/images/generations', { prompt: 'x', stream: true });
  assert.equal(streamed.status, 400);
  assert.match((await streamed.json()).error.message, /stream=true/);

  const unknown = await post('/v1/images/generations', { prompt: 'x', made_up: 1 });
  assert.equal(unknown.status, 400);
  assert.match((await unknown.json()).error.message, /unknown field/);
  assert.equal(submitCalls.length, before, '校验失败不能提交上游（否则会白扣积分）');
});
