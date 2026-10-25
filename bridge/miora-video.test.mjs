/**
 * Miora 视频客户端的纯逻辑 + 上游交互合约测试。
 *
 * 不发真实请求：用注入的 fetch 断言临时 key、请求体、状态与错误映射。
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildVideoSubmitBody,
  normalizeVideoStatus,
  queryVideo,
  resetTempKeyCache,
  submitVideo,
} from './miora-video.mjs';

const AUTH = {
  access: 'test-login-token',
  endpoint: 'https://chat.example',
  userId: 'user-1',
};
const BASE = 'https://miora.example';

const jsonResponse = (status, body, headers = {}) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json', ...headers },
});

const localPng = process.platform === 'win32' ? 'C:\\tmp\\frame.png' : '/tmp/frame.png';
const readFile = async () => Buffer.from('fake-png');

beforeEach(() => resetTempKeyCache());

test('视频请求体：文生视频带上时长/分辨率/画幅', async () => {
  const built = await buildVideoSubmitBody({
    prompt: ' a cat running ',
    duration: 5,
    resolution: '720p',
    aspect_ratio: '9:16',
  });
  assert.equal(built.mode, 'text');
  assert.deepEqual(built.body, {
    prompt: 'a cat running',
    duration: 5,
    resolution: '720p',
    aspect_ratio: '9:16',
  });
});

test('视频请求体：首尾帧走 input 的 base64/url 两种来源', async () => {
  const built = await buildVideoSubmitBody({
    mode: 'frame',
    prompt: 'camera pushes in',
    first_frame: 'data:image/png;base64,AAAA',
    last_frame: 'https://cdn.example/last.png',
  });
  assert.equal(built.mode, 'frame');
  assert.deepEqual(built.body.input, {
    first_frame_image: { base64: 'AAAA' },
    last_frame_image: { url: 'https://cdn.example/last.png' },
  });

  const local = await buildVideoSubmitBody({ first_frame: localPng }, { readFile });
  assert.equal(local.mode, 'frame');
  assert.equal(local.body.input.first_frame_image.base64, Buffer.from('fake-png').toString('base64'));
});

test('视频请求体：参考图支持 fileKey / URL，并可多张', async () => {
  const built = await buildVideoSubmitBody({
    prompt: 'same character',
    references: ['file/abc/def', 'https://cdn.example/ref.png'],
  });
  assert.equal(built.mode, 'reference');
  assert.deepEqual(built.body.input.reference_images, [
    { file_key: 'file/abc/def' },
    { url: 'https://cdn.example/ref.png' },
  ]);
});

test('视频请求体：input_reference 是 first_frame 的别名', async () => {
  const built = await buildVideoSubmitBody({ input_reference: 'bga/x/y.png' });
  assert.equal(built.mode, 'frame');
  assert.deepEqual(built.body.input.first_frame_image, { file_key: 'bga/x/y.png' });
});

test('视频请求体：模式冲突、缺字段与非法值在本地 400', async () => {
  const cases = [
    [{}, 'VIDEO_INVALID_INPUT'],
    [{ mode: 'text', prompt: 'x', first_frame: 'file/a' }, 'VIDEO_INVALID_INPUT'],
    [{ mode: 'frame' }, 'VIDEO_INVALID_INPUT'],
    [{ mode: 'frame', first_frame: 'file/a', references: ['file/b'] }, 'VIDEO_INVALID_INPUT'],
    [{ mode: 'reference', prompt: 'x' }, 'VIDEO_INVALID_INPUT'],
    [{ mode: 'reference', prompt: 'x', first_frame: 'file/a', references: ['file/b'] }, 'VIDEO_INVALID_INPUT'],
    [{ prompt: 'x', duration: 'abc' }, 'VIDEO_INVALID_INPUT'],
    [{ prompt: 'x', aspect_ratio: 'wide' }, 'VIDEO_INVALID_INPUT'],
    [{ prompt: 'x', first_frame: '/tmp/x.txt' }, 'VIDEO_INVALID_INPUT'],
    [{ prompt: 'x', references: ['file/../secret'] }, 'VIDEO_INVALID_INPUT'],
    [{ prompt: 'x', references: ['http://cdn.example/x.png'] }, 'VIDEO_INVALID_INPUT'],
    [{ prompt: 'x', references: ['https://127.0.0.1/x.png'] }, 'VIDEO_INVALID_INPUT'],
    [{ prompt: 'x', references: ['data:image/png,plain'] }, 'VIDEO_INVALID_INPUT'],
    [{ prompt: 'x'.repeat(8001) }, 'VIDEO_INVALID_INPUT'],
  ];
  for (const [input, code] of cases) {
    await assert.rejects(
      () => buildVideoSubmitBody(input, { readFile }),
      (err) => { assert.equal(err.code, code); assert.equal(err.status, 400); return true; },
      JSON.stringify(input).slice(0, 120),
    );
  }
});

test('状态归一：pending/processing/completed/failed/cancelled', () => {
  assert.equal(normalizeVideoStatus('pending'), 'queued');
  assert.equal(normalizeVideoStatus('processing'), 'in_progress');
  assert.equal(normalizeVideoStatus('completed'), 'completed');
  assert.equal(normalizeVideoStatus('failed'), 'failed');
  assert.equal(normalizeVideoStatus('cancelled'), 'cancelled');
  assert.equal(normalizeVideoStatus('something-new'), 'in_progress');
});

test('提交/查询：临时 key 只申请一次，Authorization 用 ck_t_ key', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith('/v2/api-keys')) {
      return jsonResponse(200, {
        code: 0,
        data: { key: 'ck_t_unit_test', expires_at: new Date(Date.now() + 900_000).toISOString() },
      });
    }
    if (String(url).endsWith('/video/submit')) {
      return jsonResponse(200, {
        code: 0,
        failed: false,
        data: { upstreamTaskId: 'task-1', model: 'miora-video', provider: 'copilot-video', mode: 'async' },
      });
    }
    if (String(url).endsWith('/video/query-task')) {
      return jsonResponse(200, {
        code: 0,
        failed: false,
        data: {
          'task-1': {
            status: 'completed',
            resultFiles: [{ signedUrl: 'https://cdn.example/v.mp4', mimeType: 'video/mp4', fileKey: 'file/v' }],
          },
        },
      });
    }
    throw new Error(`unexpected ${url}`);
  };

  const submitted = await submitVideo(AUTH, { prompt: 'a cat', duration: 5 }, {
    fetchImpl, baseUrl: BASE, now: () => 1000,
  });
  assert.equal(submitted.id, 'task-1');
  assert.equal(submitted.status, 'queued');
  assert.equal(submitted.created_at, 1);
  assert.equal(submitted.mode, 'text');
  assert.equal(submitted.seconds, 5);

  const queried = await queryVideo(AUTH, 'task-1', { fetchImpl, baseUrl: BASE });
  assert.equal(queried.status, 'completed');
  assert.equal(queried.created_at, null);
  assert.equal(queried.output.url, 'https://cdn.example/v.mp4');
  assert.equal(queried.result_files.length, 1);

  assert.equal(calls.filter((call) => call.url.endsWith('/v2/api-keys')).length, 1);
  const submitCall = calls.find((call) => call.url.endsWith('/video/submit'));
  assert.equal(submitCall.init.headers.Authorization, 'Bearer ck_t_unit_test');
  assert.deepEqual(JSON.parse(submitCall.init.body), { prompt: 'a cat', duration: 5 });
  const queryCall = calls.find((call) => call.url.endsWith('/video/query-task'));
  assert.equal(queryCall.init.headers.Authorization, 'Bearer ck_t_unit_test');
});

test('提交：401 时换临时 key 重试一次（仅一次）', async () => {
  let apiKeyCalls = 0;
  let submitCalls = 0;
  const fetchImpl = async (url) => {
    if (String(url).endsWith('/v2/api-keys')) {
      apiKeyCalls += 1;
      return jsonResponse(200, {
        code: 0,
        data: { key: `ck_t_key_${apiKeyCalls}`, expires_at: new Date(Date.now() + 900_000).toISOString() },
      });
    }
    if (String(url).endsWith('/video/submit')) {
      submitCalls += 1;
      if (submitCalls === 1) return jsonResponse(401, { code: 401, msg: 'expired' });
      return jsonResponse(200, { code: 0, failed: false, data: { upstreamTaskId: 'task-retry', mode: 'async' } });
    }
    throw new Error(`unexpected ${url}`);
  };

  const result = await submitVideo(AUTH, { prompt: 'x' }, { fetchImpl, baseUrl: BASE });
  assert.equal(result.id, 'task-retry');
  assert.equal(apiKeyCalls, 2);
  assert.equal(submitCalls, 2);
});

test('提交：429 不重试，透出 Retry-After', async () => {
  let submitCalls = 0;
  const fetchImpl = async (url) => {
    if (String(url).endsWith('/v2/api-keys')) {
      return jsonResponse(200, {
        code: 0,
        data: { key: 'ck_t_rate', expires_at: new Date(Date.now() + 900_000).toISOString() },
      });
    }
    if (String(url).endsWith('/video/submit')) {
      submitCalls += 1;
      return jsonResponse(429, { code: 15001, msg: 'too many requests' }, { 'retry-after': '7' });
    }
    throw new Error(`unexpected ${url}`);
  };

  await assert.rejects(
    () => submitVideo(AUTH, { prompt: 'x' }, { fetchImpl, baseUrl: BASE }),
    (err) => {
      assert.equal(err.code, 'VIDEO_RATE_LIMITED');
      assert.equal(err.status, 429);
      assert.equal(err.retryAfter, 7);
      return true;
    },
  );
  assert.equal(submitCalls, 1, '429 后盲目重提会重复计费');
});

test('提交：上游 200+failed 映射成明确的不会重试的拒绝', async () => {
  let submitCalls = 0;
  const fetchImpl = async (url) => {
    if (String(url).endsWith('/v2/api-keys')) {
      return jsonResponse(200, {
        code: 0,
        data: { key: 'ck_t_reject', expires_at: new Date(Date.now() + 900_000).toISOString() },
      });
    }
    if (String(url).endsWith('/video/submit')) {
      submitCalls += 1;
      return jsonResponse(200, { code: 1001, failed: true, httpStatus: 400, message: 'CONTENT_SAFETY' });
    }
    throw new Error(`unexpected ${url}`);
  };

  await assert.rejects(
    () => submitVideo(AUTH, { prompt: 'x' }, { fetchImpl, baseUrl: BASE }),
    (err) => {
      assert.equal(err.code, 'VIDEO_UPSTREAM_REJECTED');
      assert.equal(err.status, 400);
      assert.match(err.message, /CONTENT_SAFETY/);
      return true;
    },
  );
  assert.equal(submitCalls, 1);
});

test('查询：任务不存在返回 404，失败任务保留 errorMessage', async () => {
  const fetchImpl = async (url) => {
    if (String(url).endsWith('/v2/api-keys')) {
      return jsonResponse(200, {
        code: 0,
        data: { key: 'ck_t_query', expires_at: new Date(Date.now() + 900_000).toISOString() },
      });
    }
    if (String(url).endsWith('/video/query-task')) {
      return jsonResponse(200, {
        code: 0,
        failed: false,
        data: {
          'task-failed': { status: 'failed', errorMessage: 'upstream render failed' },
          'task-pending': { status: 'pending', errorMessage: 'stale 400 from an earlier probe' },
        },
      });
    }
    throw new Error(`unexpected ${url}`);
  };

  const failed = await queryVideo(AUTH, 'task-failed', { fetchImpl, baseUrl: BASE });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error.message, 'upstream render failed');

  const pending = await queryVideo(AUTH, 'task-pending', { fetchImpl, baseUrl: BASE });
  assert.equal(pending.status, 'queued');
  assert.equal(pending.error, null, '非终态任务不能把上游残留的 errorMessage 当成失败');

  await assert.rejects(
    () => queryVideo(AUTH, 'missing', { fetchImpl, baseUrl: BASE }),
    (err) => { assert.equal(err.code, 'VIDEO_NOT_FOUND'); assert.equal(err.status, 404); return true; },
  );
});
