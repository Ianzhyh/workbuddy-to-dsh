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
  // 提交元数据只驻内存，但同一进程内查询应前后一致（不是 null）
  assert.equal(queried.created_at, 1);
  assert.equal(queried.mode, 'text');
  assert.equal(queried.seconds, 5);
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

test('提交：HTTP 200 但 code 非 0 也不能当成功解包', async () => {
  const fetchImpl = async (url) => {
    if (String(url).endsWith('/v2/api-keys')) {
      return jsonResponse(200, {
        code: 0,
        data: { key: 'ck_t_code', expires_at: new Date(Date.now() + 900_000).toISOString() },
      });
    }
    if (String(url).endsWith('/video/submit')) {
      return jsonResponse(200, { code: 1002, failed: false, httpStatus: 400, message: 'MODEL_NOT_ALLOWED' });
    }
    throw new Error(`unexpected ${url}`);
  };

  await assert.rejects(
    () => submitVideo(AUTH, { prompt: 'x' }, { fetchImpl, baseUrl: BASE }),
    (err) => {
      assert.equal(err.code, 'VIDEO_UPSTREAM_REJECTED');
      assert.equal(err.status, 400);
      assert.match(err.message, /MODEL_NOT_ALLOWED/);
      return true;
    },
  );
});

test('提交：业务 400 藏在 HTTP 200 的 message 里时也要映射成 400', async () => {
  const fetchImpl = async (url) => {
    if (String(url).endsWith('/v2/api-keys')) {
      return jsonResponse(200, {
        code: 0,
        data: { key: 'ck_t_nested', expires_at: new Date(Date.now() + 900_000).toISOString() },
      });
    }
    if (String(url).endsWith('/video/submit')) {
      // 真机实测形状：代理 HTTP 200 + failed，真正的 status/code 只在 message 里。
      return jsonResponse(200, {
        failed: true,
        message: 'upstream video-submit failed: status=400 code=14407 msg=unsupported video duration: 3 seconds, supported range: 4-15 seconds',
      });
    }
    throw new Error(`unexpected ${url}`);
  };

  await assert.rejects(
    () => submitVideo(AUTH, { prompt: 'x', duration: 3 }, { fetchImpl, baseUrl: BASE }),
    (err) => {
      assert.equal(err.code, 'VIDEO_UPSTREAM_REJECTED');
      assert.equal(err.status, 400);
      assert.match(err.message, /supported range: 4-15 seconds/);
      return true;
    },
  );
});

test('提交：外层 502 包裹的业务 400 也要还原成 400', async () => {
  const fetchImpl = async (url) => {
    if (String(url).endsWith('/v2/api-keys')) {
      return jsonResponse(200, {
        code: 0,
        data: { key: 'ck_t_outer', expires_at: new Date(Date.now() + 900_000).toISOString() },
      });
    }
    if (String(url).endsWith('/video/submit')) {
      return jsonResponse(502, {
        failed: true,
        message: 'upstream video-submit failed: status=400 code=14407 msg=unsupported video resolution: 720p, supported values: [768P 2K]',
      });
    }
    throw new Error(`unexpected ${url}`);
  };

  await assert.rejects(
    () => submitVideo(AUTH, { prompt: 'x', resolution: '720p' }, { fetchImpl, baseUrl: BASE }),
    (err) => {
      assert.equal(err.code, 'VIDEO_UPSTREAM_REJECTED');
      assert.equal(err.status, 400);
      assert.match(err.message, /768P/);
      return true;
    },
  );
});

test('临时 key：429/403 不能被笼统报成登录失败', async () => {
  const rateLimited = async () => jsonResponse(429, { code: 15001, msg: 'too many keys' }, { 'retry-after': '9' });
  await assert.rejects(
    () => submitVideo(AUTH, { prompt: 'x' }, { fetchImpl: rateLimited, baseUrl: BASE }),
    (err) => {
      assert.equal(err.code, 'VIDEO_RATE_LIMITED');
      assert.equal(err.status, 429);
      assert.equal(err.retryAfter, 9);
      return true;
    },
  );

  const forbidden = async () => jsonResponse(403, { code: 14003, msg: 'no video scope' });
  await assert.rejects(
    () => submitVideo(AUTH, { prompt: 'x' }, { fetchImpl: forbidden, baseUrl: BASE }),
    (err) => {
      assert.equal(err.code, 'VIDEO_SCOPE_DENIED');
      assert.equal(err.status, 403);
      return true;
    },
  );
});

test('视频请求体：未知字段/空帧/坏参考图一律本地 400（不许静默退化成文生视频）', async () => {
  const cases = [
    [{ prompt: 'x', size: '1280x720' }, /unknown field/],
    [{ prompt: 'x', image: 'file/a' }, /unknown field/],
    [{ prompt: 'x', first_frame: '' }, /first_frame is empty/],
    [{ prompt: 'x', first_frame: 'file/a', firstFrame: 'file/b' }, /more than once/],
    [{ prompt: 'x', references: [123] }, /references\[0\]/],
    [{ prompt: 'x', references: 'file/a' }, /must be an array/],
    [{ prompt: 'x', last_frame: 'file/a' }, /last_frame alone is not enough/],
    [{ prompt: 'x', duration: 4.5 }, /positive integer/],
    [{ prompt: 'x', duration: 5, seconds: 6 }, /disagree/],
    [{ prompt: 'x', aspect_ratio: '0:0' }, /positive ratio/],
    [{ prompt: 'x', references: ['data:text/plain;base64,AAAA'] }, /image\//],
    [{ prompt: 123 }, /prompt must be a string/],
    [{ prompt: 'x', mode: 1 }, /mode must be a string/],
  ];
  for (const [input, pattern] of cases) {
    await assert.rejects(
      () => buildVideoSubmitBody(input, { readFile }),
      (err) => {
        assert.equal(err.code, 'VIDEO_INVALID_INPUT');
        assert.equal(err.status, 400);
        assert.match(err.message, pattern);
        return true;
      },
      JSON.stringify(input).slice(0, 120),
    );
  }
});

test('视频请求体：分辨率大小写归一、画幅去空格、camelCase 别名等价', async () => {
  const lower = await buildVideoSubmitBody({ prompt: 'x', resolution: '768p', aspect_ratio: '16 : 9', seconds: 5 });
  assert.equal(lower.resolution, '768P');
  assert.equal(lower.aspectRatio, '16:9');
  assert.deepEqual(lower.body, {
    prompt: 'x', duration: 5, resolution: '768P', aspect_ratio: '16:9',
  });

  const camel = await buildVideoSubmitBody({ firstFrame: 'bga/x/y.png', aspectRatio: '9:16' });
  assert.equal(camel.mode, 'frame');
  assert.deepEqual(camel.body.input.first_frame_image, { file_key: 'bga/x/y.png' });
  assert.equal(camel.aspectRatio, '9:16');

  const upper = await buildVideoSubmitBody({ prompt: 'x', resolution: '2K' });
  assert.equal(upper.resolution, '2K');
});

test('视频请求体：null 视为“没给”，空字符串仍然报错', async () => {
  const built = await buildVideoSubmitBody({
    prompt: 'x', first_frame: null, references: null, duration: null,
  });
  assert.equal(built.mode, 'text');
  assert.deepEqual(built.body, { prompt: 'x' });
});

test('长轮询：waitMs 内等到 completed；预算用完返回最后一次状态', async () => {
  let queries = 0;
  const makeFetch = (finalStatus) => async (url) => {
    if (String(url).endsWith('/v2/api-keys')) {
      return jsonResponse(200, {
        code: 0,
        data: { key: 'ck_t_poll', expires_at: new Date(Date.now() + 900_000).toISOString() },
      });
    }
    if (String(url).endsWith('/video/query-task')) {
      queries += 1;
      const status = queries < 3 ? 'processing' : finalStatus;
      return jsonResponse(200, {
        code: 0,
        failed: false,
        data: {
          'task-poll': {
            status,
            resultFiles: status === 'completed' ? [{ signedUrl: 'https://cdn.example/poll.mp4' }] : [],
          },
        },
      });
    }
    throw new Error(`unexpected ${url}`);
  };

  const done = await queryVideo(AUTH, 'task-poll', {
    fetchImpl: makeFetch('completed'), baseUrl: BASE, waitMs: 10_000, sleep: async () => {},
  });
  assert.equal(done.status, 'completed');
  assert.equal(queries, 3, '应轮询到终态后立刻返回');
  assert.equal(done.output.url, 'https://cdn.example/poll.mp4');

  queries = 0;
  const timedOut = await queryVideo(AUTH, 'task-poll', {
    fetchImpl: makeFetch('processing'), baseUrl: BASE, waitMs: 4_000, sleep: async () => {},
  });
  assert.equal(timedOut.status, 'in_progress');
  assert.equal(queries, 3, '4 秒预算 = 首次 + 2 次重试；超时是「还没出来」，不是失败');
});

test('查询：没有本地提交记录的任务不伪造元数据', async () => {
  const fetchImpl = async (url) => {
    if (String(url).endsWith('/v2/api-keys')) {
      return jsonResponse(200, {
        code: 0,
        data: { key: 'ck_t_meta', expires_at: new Date(Date.now() + 900_000).toISOString() },
      });
    }
    if (String(url).endsWith('/video/query-task')) {
      return jsonResponse(200, { code: 0, failed: false, data: { 'task-other': { status: 'processing' } } });
    }
    throw new Error(`unexpected ${url}`);
  };
  const video = await queryVideo(AUTH, 'task-other', { fetchImpl, baseUrl: BASE });
  assert.equal(video.mode, null);
  assert.equal(video.seconds, null);
  assert.equal(video.created_at, null);
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
