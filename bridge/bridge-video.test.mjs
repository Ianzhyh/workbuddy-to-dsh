/**
 * /v1/videos 的端到端合约测试：真起桥 + 桩 WorkBuddy 网关与 Miora 上游。
 *
 * 覆盖：三种模式的请求体、临时 key 复用与 401 刷新、429 透传、
 * 查询状态归一化、/content 跳转与本地参数校验。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pickBridgePort } from '../tools/dev/bridge-ports.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(HERE);
const BRIDGE = join(REPO, 'bridge', 'workbuddy-bridge.mjs');
const TOKEN = 'video-test-token';

const submitCalls = [];
const queryCalls = [];
let apiKeyCalls = 0;
let refreshKeySubmits = 0;
let slowPolls = 0;

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

    if (req.url?.startsWith('/v2/plugin/auth/token/refresh')) {
      return json(200, {
        code: 0,
        data: { accessToken: 'fresh-video-token', refreshToken: 'rotated-video', expiresIn: 3600 },
      });
    }
    if (req.url === '/v2/api-keys') {
      apiKeyCalls += 1;
      return json(200, {
        code: 0,
        data: { key: `ck_t_video_${apiKeyCalls}`, expires_at: new Date(Date.now() + 900_000).toISOString() },
      });
    }
    if (req.url === '/v2/billing/meter/get-user-resource') {
      // 余额常量：差值恒为 0，生成消耗估算应为 null（不能把“没变化”写成 0）。
      return json(200, {
        code: 0,
        data: {
          Response: {
            Data: {
              Accounts: [{ CapacityType: 0, CapacitySize: 1000, CapacityRemain: 1000 }],
            },
          },
        },
      });
    }
    if (req.url === '/api/ai/workbuddy-proxy/video/submit') {
      submitCalls.push({ headers: req.headers, body });
      const prompt = String(body?.prompt || '');
      if (prompt.includes('rate-limit')) {
        return json(429, { code: 15001, msg: 'too many requests' }, { 'retry-after': '7' });
      }
      if (prompt.includes('refresh-key')) {
        refreshKeySubmits += 1;
        if (refreshKeySubmits === 1) return json(401, { code: 401, msg: 'expired temp key' });
      }
      if (prompt.includes('reject')) {
        return json(200, { code: 1001, failed: true, httpStatus: 400, message: 'CONTENT_SAFETY' });
      }
      return json(200, {
        code: 0,
        failed: false,
        data: {
          upstreamTaskId: prompt.includes('refresh-key') ? 'task-refresh' : 'task-1',
          model: 'miora-video',
          provider: 'copilot-video',
          mode: 'async',
        },
      });
    }
    if (req.url === '/api/ai/workbuddy-proxy/video/query-task') {
      queryCalls.push({ headers: req.headers, body });
      const id = body?.upstreamTaskIds?.[0];
      if (id === 'missing') return json(200, { code: 0, failed: false, data: {} });
      if (id === 'task-empty') {
        return json(200, {
          code: 0,
          failed: false,
          data: { 'task-empty': { status: 'completed', resultFiles: [] } },
        });
      }
      if (id === 'task-slow') {
        slowPolls += 1;
        const status = slowPolls < 2 ? 'processing' : 'completed';
        return json(200, {
          code: 0,
          failed: false,
          data: {
            'task-slow': {
              status,
              resultFiles: status === 'completed' ? [{ signedUrl: 'https://cdn.example/slow.mp4' }] : [],
            },
          },
        });
      }
      if (id === 'task-processing') {
        return json(200, { code: 0, failed: false, data: { 'task-processing': { status: 'processing' } } });
      }
      if (id === 'task-failed') {
        return json(200, {
          code: 0,
          failed: false,
          data: { 'task-failed': { status: 'failed', errorMessage: 'upstream render failed' } },
        });
      }
      return json(200, {
        code: 0,
        failed: false,
        data: {
          [id]: {
            status: 'completed',
            resultFiles: [{
              signedUrl: 'https://cdn.example/video.mp4',
              mimeType: 'video/mp4',
              fileKey: 'file/video',
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

const dir = mkdtempSync(join(tmpdir(), 'wb-video-'));
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
    WORKBUDDY_CLIENT_KEYS: 'video-client-key',
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
    const response = await fetch(`${base}/`, {
      headers: { authorization: `Bearer ${TOKEN}` },
      signal: AbortSignal.timeout(1000),
    });
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

test('文生视频：提交 202，请求体与临时 key 正确；查询/下载可用', async () => {
  const beforeApiKeys = apiKeyCalls;
  const submit = await post('/v1/videos', {
    prompt: 'a cat running on grass',
    duration: 5,
    resolution: '720p',
    aspect_ratio: '9:16',
  });
  assert.equal(submit.status, 202);
  const video = await submit.json();
  assert.equal(video.object, 'video');
  assert.equal(video.id, 'task-1');
  assert.equal(video.status, 'queued');
  assert.equal(video.mode, 'text');
  assert.equal(video.seconds, 5);
  assert.equal(apiKeyCalls, beforeApiKeys + 1, '首次提交应申请临时 key');

  const sent = submitCalls.at(-1);
  assert.equal(sent.headers.authorization, `Bearer ck_t_video_${apiKeyCalls}`);
  assert.deepEqual(sent.body, {
    prompt: 'a cat running on grass',
    duration: 5,
    resolution: '720p',
    aspect_ratio: '9:16',
  });

  const lookup = await get('/v1/videos/task-1');
  assert.equal(lookup.status, 200);
  const queried = await lookup.json();
  assert.equal(queried.status, 'completed');
  // 提交元数据在同一个桥进程内会补回（不写盘；重启后为 null）
  assert.equal(queried.mode, 'text');
  assert.equal(queried.seconds, 5);
  assert.equal(typeof queried.created_at, 'number');
  assert.equal(queried.output.url, 'https://cdn.example/video.mp4');
  assert.equal(queryCalls.at(-1).body.upstreamTaskIds[0], 'task-1');
  assert.equal(apiKeyCalls, beforeApiKeys + 1, '查询应复用同一把临时 key');

  const content = await get('/v1/videos/task-1/content', { redirect: 'manual' });
  assert.equal(content.status, 302);
  assert.equal(content.headers.get('location'), 'https://cdn.example/video.mp4');
});

test('图生视频：首尾帧与参考图分别映射到 input', async () => {
  const frame = await post('/v1/videos', {
    mode: 'frame',
    prompt: 'slow push in',
    first_frame: 'data:image/png;base64,AAAA',
    last_frame: 'https://cdn.example/last.png',
  });
  assert.equal(frame.status, 202);
  assert.equal((await frame.json()).mode, 'frame');
  assert.deepEqual(submitCalls.at(-1).body, {
    prompt: 'slow push in',
    input: {
      first_frame_image: { base64: 'AAAA' },
      last_frame_image: { url: 'https://cdn.example/last.png' },
    },
  });

  const reference = await post('/v1/videos', {
    prompt: 'same character waving',
    references: ['file/abc/ref', 'https://cdn.example/ref.png'],
  });
  assert.equal(reference.status, 202);
  assert.equal((await reference.json()).mode, 'reference');
  assert.deepEqual(submitCalls.at(-1).body, {
    prompt: 'same character waving',
    input: {
      reference_images: [{ file_key: 'file/abc/ref' }, { url: 'https://cdn.example/ref.png' }],
    },
  });
});

test('本地校验：缺 prompt / 冲突模式 / 未知字段都不提交上游', async () => {
  const before = submitCalls.length;
  const missing = await post('/v1/videos', {});
  assert.equal(missing.status, 400);
  assert.equal((await missing.json()).error.code, 'VIDEO_INVALID_INPUT');

  const conflict = await post('/v1/videos', {
    mode: 'text', prompt: 'x', first_frame: 'file/a',
  });
  assert.equal(conflict.status, 400);

  // 拼错的键不能被静默忽略：否则请求退化成文生视频，图片没带上却照常计费。
  const unknown = await post('/v1/videos', { prompt: 'x', size: '1280x720' });
  assert.equal(unknown.status, 400);
  const body = await unknown.json();
  assert.equal(body.error.code, 'VIDEO_INVALID_INPUT');
  assert.match(body.error.message, /unknown field/);

  assert.equal(submitCalls.length, before, '非法输入不应打上游');
});

test('client key 不能调用视频接口（会读本地文件/花积分）', async () => {
  const clientHeaders = { authorization: 'Bearer video-client-key', 'content-type': 'application/json' };
  const submit = await fetch(`${base}/v1/videos`, {
    method: 'POST',
    headers: clientHeaders,
    body: JSON.stringify({ prompt: 'x' }),
    signal: AbortSignal.timeout(15_000),
  });
  assert.equal(submit.status, 403);
  assert.equal((await submit.json()).error.code, 'VIDEO_LOCAL_TOKEN_REQUIRED');

  const lookup = await fetch(`${base}/v1/videos/task-1`, {
    headers: { authorization: 'Bearer video-client-key' },
    signal: AbortSignal.timeout(15_000),
  });
  assert.equal(lookup.status, 403);
  assert.equal((await lookup.json()).error.code, 'VIDEO_LOCAL_TOKEN_REQUIRED');
});

test('401 时刷新临时 key 并重试；429 不重试且透出 Retry-After', async () => {
  const beforeApiKeys = apiKeyCalls;
  const refresh = await post('/v1/videos', { prompt: 'refresh-key test' });
  assert.equal(refresh.status, 202);
  assert.equal((await refresh.json()).id, 'task-refresh');
  assert.equal(apiKeyCalls, beforeApiKeys + 1, '401 后应重新申请一次临时 key');
  assert.equal(refreshKeySubmits, 2, '401 后只重试一次');

  const beforeSubmit = submitCalls.length;
  const limited = await post('/v1/videos', { prompt: 'rate-limit test' });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '7');
  assert.equal((await limited.json()).error.code, 'VIDEO_RATE_LIMITED');
  assert.equal(submitCalls.length, beforeSubmit + 1, '429 不能自动重试（会重复计费）');
});

test('上游拒绝：200+failed 转成 400，任务失败查询仍返回 200', async () => {
  const rejected = await post('/v1/videos', { prompt: 'reject me' });
  assert.equal(rejected.status, 400);
  assert.equal((await rejected.json()).error.code, 'VIDEO_UPSTREAM_REJECTED');

  const failed = await get('/v1/videos/task-failed');
  assert.equal(failed.status, 200);
  const body = await failed.json();
  assert.equal(body.status, 'failed');
  assert.equal(body.error.message, 'upstream render failed');

  const missing = await get('/v1/videos/missing');
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error.code, 'VIDEO_NOT_FOUND');
});

test('未完成任务的 /content 返回 409；completed 但无产物返回 502；畸形 id 返回 400', async () => {
  const pending = await get('/v1/videos/task-processing/content', { redirect: 'manual' });
  assert.equal(pending.status, 409);
  assert.equal((await pending.json()).error.code, 'VIDEO_NOT_READY');

  // 上游说 completed 却没有 https 产物：报 502 NO_OUTPUT，不能再让客户端以为「继续等」
  const empty = await get('/v1/videos/task-empty/content', { redirect: 'manual' });
  assert.equal(empty.status, 502);
  assert.equal((await empty.json()).error.code, 'VIDEO_NO_OUTPUT');

  const bad = await get('/v1/videos/bad%2Fid');
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error.code, 'VIDEO_INVALID_INPUT');
});

test('长轮询 wait：桥代客户端等到出片；非法 wait 不静默当 0', async () => {
  const before = queryCalls.length;
  const waited = await get('/v1/videos/task-slow?wait=1');
  assert.equal(waited.status, 200);
  const body = await waited.json();
  assert.equal(body.status, 'completed');
  assert.equal(body.output.url, 'https://cdn.example/slow.mp4');
  assert.ok(queryCalls.length - before >= 2, `桥应自己轮询，实际 ${queryCalls.length - before} 次查询`);

  const badWait = await get('/v1/videos/task-1?wait=abc');
  assert.equal(badWait.status, 400);
  assert.equal((await badWait.json()).error.code, 'VIDEO_INVALID_INPUT');
});

test('账本：视频提交单独计数，不污染模型调用/tokens/积分', async () => {
  const ledger = await (await get('/v1/requests?limit=50')).json();
  const rows = ledger.requests.filter((row) => row.kind === 'video');
  assert.ok(rows.length >= 4, `视频提交应进账本，实际 ${rows.length} 条`);
  assert.ok(rows.some((row) => row.ok === true), '成功提交应进账本');
  assert.ok(rows.some((row) => row.ok === false), '失败的视频提交也要留痕');
  assert.ok(rows.every((row) => row.model === 'video'));

  const usage = await (await get('/v1/usage?days=1')).json();
  assert.ok(usage.total.videos >= 4, `成功提交应计入 videos，实际 ${usage.total.videos}`);
  assert.ok(usage.total.videoFailed >= 1, `失败提交应计入 videoFailed，实际 ${usage.total.videoFailed}`);
  assert.equal(usage.total.calls, 0, '视频不能混进模型调用次数');
  assert.equal(usage.total.promptTokens + usage.total.completionTokens, 0, '视频没有模型 token');
  assert.equal(usage.total.videoCreditKnown, 0, '余额没变化时不能伪造生成消耗');
  assert.equal(usage.total.videoCredit, 0);
  assert.equal(usage.models.some((model) => model.model === 'video'), false, '模型排行不应出现 video');
  assert.ok(usage.failures.some((failure) => failure.kind === 'video'), '失败列表要能区分视频');
});
