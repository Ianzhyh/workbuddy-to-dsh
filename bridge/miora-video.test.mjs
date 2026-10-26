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
  assert.equal(normalizeVideoStatus('success'), 'completed');
  assert.equal(normalizeVideoStatus('done'), 'completed');
  assert.equal(normalizeVideoStatus('failed'), 'failed');
  assert.equal(normalizeVideoStatus('timeout'), 'failed');
  assert.equal(normalizeVideoStatus('expired'), 'failed');
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

test('同步完成：视频也认 mode=sync，查询从缓存恢复', async () => {
  let calls = 0;
  const fetchImpl = async (url) => {
    calls += 1;
    if (String(url).endsWith('/v2/api-keys')) {
      return jsonResponse(200, {
        code: 0,
        data: { key: 'ck_t_video_sync', expires_at: new Date(Date.now() + 900_000).toISOString() },
      });
    }
    if (String(url).endsWith('/video/submit')) {
      return jsonResponse(200, {
        code: 0,
        failed: false,
        data: {
          upstreamTaskId: 'wb-sync-video',
          mode: 'sync',
          status: 'completed',
          resultFiles: [{ signedUrl: 'https://cdn.example/sync.mp4', fileKey: 'file/sync-video' }],
        },
      });
    }
    throw new Error(`unexpected ${url}`);
  };

  const submitted = await submitVideo(AUTH, { prompt: 'x' }, { fetchImpl, baseUrl: BASE });
  assert.equal(submitted.status, 'completed');
  assert.equal(submitted.sync, true);
  assert.equal(submitted.output.url, 'https://cdn.example/sync.mp4');

  const queried = await queryVideo(AUTH, 'wb-sync-video', { fetchImpl, baseUrl: BASE, waitMs: 60_000 });
  assert.equal(queried.status, 'completed');
  assert.equal(queried.output.url, 'https://cdn.example/sync.mp4');
  assert.equal(calls, 2, '缓存命中不应再查询上游');
});

test('多帧 inline 预算：三张 10 MB 帧会超过 32 MB 请求体，提交前 400', async () => {
  const tenMb = Buffer.alloc(10 * 1024 * 1024);
  await assert.rejects(
    () => buildVideoSubmitBody(
      { prompt: 'x', references: [localPng, localPng, localPng] },
      { readFile: async () => tenMb, maxBodyBytes: 32 * 1024 * 1024 },
    ),
    (err) => {
      assert.equal(err.code, 'VIDEO_INVALID_INPUT');
      assert.match(err.message, /request body budget/);
      return true;
    },
  );
});

test('失败原因兼容对象形状：error.message 不会变成 [object Object]', async () => {
  const fetchImpl = async (url) => {
    if (String(url).endsWith('/v2/api-keys')) {
      return jsonResponse(200, {
        code: 0,
        data: { key: 'ck_t_video_err_obj', expires_at: new Date(Date.now() + 900_000).toISOString() },
      });
    }
    if (String(url).endsWith('/video/query-task')) {
      return jsonResponse(200, {
        code: 0,
        failed: false,
        data: { 'task-obj': { status: 'failed', error: { message: 'render exploded' } } },
      });
    }
    throw new Error(`unexpected ${url}`);
  };
  const failed = await queryVideo(AUTH, 'task-obj', { fetchImpl, baseUrl: BASE });
  assert.equal(failed.error.message, 'render exploded');
});

test('临时 key：429/403 不能被笼统报成登录失败', async () => {
  const rateLimited = async () => jsonResponse(429, { code: 15001, msg: 'too many keys' }, { 'retry-after': '9' });
  await assert.rejects(
    () => submitVideo(AUTH, { prompt: 'x' }, { fetchImpl: rateLimited, baseUrl: BASE }),
    (err) => {
      // 申请 key 被限流 ≠ 提交被限流：任务还没创建，可以直接稍后重试。
      assert.equal(err.code, 'VIDEO_KEY_RATE_LIMITED');
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
    [{ prompt: 'x', duration: true }, /positive integer/],
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

test('长轮询：预算按真实时间收手（慢查询不会拖到次数上限）', async () => {
  let clock = 0;
  let queries = 0;
  const fetchImpl = async (url) => {
    if (String(url).endsWith('/v2/api-keys')) {
      return jsonResponse(200, {
        code: 0,
        data: { key: 'ck_t_slow', expires_at: new Date(Date.now() + 900_000).toISOString() },
      });
    }
    if (String(url).endsWith('/video/query-task')) {
      queries += 1;
      clock += 10_000; // 模拟每次查询都很慢
      return jsonResponse(200, {
        code: 0,
        failed: false,
        data: { 'task-deadline': { status: 'processing' } },
      });
    }
    throw new Error(`unexpected ${url}`);
  };

  const result = await queryVideo(AUTH, 'task-deadline', {
    fetchImpl, baseUrl: BASE, waitMs: 20_000, sleep: async () => {}, now: () => clock,
  });
  assert.equal(result.status, 'in_progress');
  assert.equal(queries, 2, '20 秒预算被两次 10 秒查询用尽，第三次不该再打');
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

test('状态归一：FAILED / Cancelled 等大小写变体也要带上失败原因', async () => {
  /*
   * 回归：归一化用 normalizeMediaStatus（大小写不敏感），失败判定却曾写成
   * `entry.status === 'failed'`。上游回 `FAILED` 时，对外 status 是 failed、
   * error 却是 null —— 用户只看到「上游未给失败原因」，真正原因被吞掉。
   */
  const cases = [
    ['FAILED', 'failed'],
    [' failed ', 'failed'],
    ['Failed', 'failed'],
    ['CANCELLED', 'cancelled'],
    ['Cancelled', 'cancelled'],
  ];
  for (const [raw, expected] of cases) {
    resetTempKeyCache();
    const fetchImpl = async (url) => {
      if (String(url).endsWith('/v2/api-keys')) {
        return jsonResponse(200, { code: 0, data: { key: 'ck_t_case' } });
      }
      if (String(url).endsWith('/video/query-task')) {
        return jsonResponse(200, {
          code: 0,
          failed: false,
          data: { 'task-case': { status: raw, errorMessage: 'blocked by content safety' } },
        });
      }
      throw new Error(`unexpected ${url}`);
    };
    const result = await queryVideo(AUTH, 'task-case', { fetchImpl, baseUrl: BASE });
    assert.equal(result.status, expected, `status=${raw}`);
    assert.equal(result.upstream_status, raw.trim(), '上游原值原样保留（去掉首尾空白）');
    assert.equal(result.error?.message, 'blocked by content safety', `error 不能丢（status=${raw}）`);
  }
});

test('产物地址：downloadUrl / 裸字符串 / 嵌套 file 都认，不能误报 NO_OUTPUT', async () => {
  /*
   * 回归：原先只取 `signedUrl || url`，上游换成 downloadUrl 或直接给字符串时，
   * 「completed 且有产物」会被报成没有可下载产物。
   */
  const shapes = [
    [[{ signedUrl: 'https://cdn.example/a.mp4' }], 'https://cdn.example/a.mp4'],
    [[{ downloadUrl: 'https://cdn.example/b.mp4' }], 'https://cdn.example/b.mp4'],
    [[{ signed_url: 'https://cdn.example/c.mp4' }], 'https://cdn.example/c.mp4'],
    [['https://cdn.example/d.mp4'], 'https://cdn.example/d.mp4'],
    [[{ file: { url: 'https://cdn.example/e.mp4' } }], 'https://cdn.example/e.mp4'],
    [[{ result: { signedUrl: 'https://cdn.example/f.mp4' } }], 'https://cdn.example/f.mp4'],
  ];
  for (const [resultFiles, expected] of shapes) {
    resetTempKeyCache();
    const fetchImpl = async (url) => {
      if (String(url).endsWith('/v2/api-keys')) {
        return jsonResponse(200, { code: 0, data: { key: 'ck_t_out' } });
      }
      if (String(url).endsWith('/video/query-task')) {
        return jsonResponse(200, {
          code: 0,
          failed: false,
          data: { 'task-out': { status: 'completed', resultFiles } },
        });
      }
      throw new Error(`unexpected ${url}`);
    };
    const result = await queryVideo(AUTH, 'task-out', { fetchImpl, baseUrl: BASE });
    assert.equal(result.status, 'completed');
    assert.equal(result.output?.url, expected, JSON.stringify(resultFiles));
    assert.deepEqual(result.output.urls, [expected]);
  }

  // 非 https / 重复项要被过滤，且不产生重复 url
  resetTempKeyCache();
  const fetchImpl = async (url) => {
    if (String(url).endsWith('/v2/api-keys')) {
      return jsonResponse(200, { code: 0, data: { key: 'ck_t_out2' } });
    }
    return jsonResponse(200, {
      code: 0,
      failed: false,
      data: {
        'task-out': {
          status: 'completed',
          resultFiles: [
            { url: 'https://cdn.example/a.mp4' },
            { url: 'https://cdn.example/a.mp4' },
            { url: 'http://cdn.example/insecure.mp4' },
            { mimeType: 'video/mp4' },
          ],
        },
      },
    });
  };
  const filtered = await queryVideo(AUTH, 'task-out', { fetchImpl, baseUrl: BASE });
  assert.deepEqual(filtered.output.urls, ['https://cdn.example/a.mp4']);
});

test('图片输入：公网域名不再被私有地址规则误杀，内网字面量仍拒绝', async () => {
  /*
   * 回归：原先用 /^(?:fc|fd|fe8|fe9|fea|feb)/ 同时判域名和 IPv6 字面量，
   * `fc2.com`、`fcdn.cloudflare.net`、`fd.example.com` 都被当成内网拒掉；
   * 而 `[::ffff:127.0.0.1]` 这种 IPv4-mapped 地址反而能绕过。
   */
  const built = await buildVideoSubmitBody({
    mode: 'frame',
    prompt: 'x',
    first_frame: 'https://fc2.com/a.png',
    last_frame: 'https://fcdn.cloudflare.net/b.png',
  });
  assert.deepEqual(built.body.input, {
    first_frame_image: { url: 'https://fc2.com/a.png' },
    last_frame_image: { url: 'https://fcdn.cloudflare.net/b.png' },
  });

  const rejected = [
    'https://localhost/a.png',
    // 根点写法与常见 hosts 别名解析结果一样，不能绕过 localhost 判定。
    'https://localhost./a.png',
    'https://localhost.localdomain/a.png',
    'https://ip6-localhost/a.png',
    'https://127.0.0.1/a.png',
    'https://127.0.0.1./a.png',
    'https://10.1.2.3/a.png',
    'https://192.168.1.1/a.png',
    'https://100.64.0.1/a.png',
    'https://224.0.0.1/a.png',
    'https://240.0.0.1/a.png',
    'https://[::1]/a.png',
    'https://[ff02::1]/a.png',
    'https://[::]/a.png',
    'https://[fe80::1]/a.png',
    'https://[fc00::1]/a.png',
    'https://[2001:db8::1]/a.png',
    'http://example.com/a.png',
  ];
  for (const url of rejected) {
    await assert.rejects(
      () => buildVideoSubmitBody({ mode: 'frame', prompt: 'x', first_frame: url }),
      (err) => {
        assert.equal(err.code, 'VIDEO_INVALID_INPUT');
        assert.match(err.message, /public https URL|must be a public/);
        return true;
      },
      url,
    );
  }
});

test('图片输入：IPv4-mapped 地址的两种写法都要拦住（点分 与 十六进制）', async () => {
  /*
   * 回归（真机发现）：`https://[::ffff:127.0.0.1]/` 曾被**放到上游**去提交。
   *
   * 第一版改法把 `::ffff:` 判成了「第 3 段是 ffff」，可它的真实结构是
   * 前 5 段为 0、第 6 段是 ffff、最后两段才是 IPv4 —— 段位判错就整条判据失效。
   * 同一个地址还有 `::ffff:7f00:1` 这种纯十六进制写法，两种都必须拦住。
   */
  const mapped = [
    'https://[::ffff:127.0.0.1]/a.png',
    'https://[::ffff:7f00:1]/a.png',
    'https://[::ffff:a00:1]/a.png',
    'https://[::ffff:c0a8:101]/a.png',
    'https://[::127.0.0.1]/a.png',
  ];
  for (const url of mapped) {
    await assert.rejects(
      () => buildVideoSubmitBody({ mode: 'frame', prompt: 'x', first_frame: url }),
      (err) => {
        assert.equal(err.code, 'VIDEO_INVALID_INPUT');
        return true;
      },
      url,
    );
  }

  // 公网 IPv6 与公网 IPv4-mapped 地址不能被误杀
  const built = await buildVideoSubmitBody({
    mode: 'frame',
    prompt: 'x',
    first_frame: 'https://[2606:4700::1111]/a.png',
    last_frame: 'https://[::ffff:8.8.8.8]/b.png',
  });
  assert.equal(built.body.input.first_frame_image.url, 'https://[2606:4700::1111]/a.png');
  // 公网 IPv4-mapped 会被 URL 规范化成十六进制写法（::ffff:808:808），只断言「放行」
  assert.match(built.body.input.last_frame_image.url, /^https:\/\/\[::ffff:[0-9a-f]+:[0-9a-f]+\]\/b\.png$/);
});

test('图片输入：超限文件在读盘之前就被拒绝（不先把整个文件读进内存）', async () => {
  const readCalls = [];
  const statFile = async () => ({ size: 40 * 1024 * 1024 });
  await assert.rejects(
    () => buildVideoSubmitBody(
      { mode: 'frame', prompt: 'x', first_frame: localPng },
      {
        statFile,
        readFile: async (file) => { readCalls.push(file); return Buffer.alloc(40 * 1024 * 1024); },
      },
    ),
    (err) => {
      assert.equal(err.code, 'VIDEO_INVALID_INPUT');
      assert.match(err.message, /exceeds .*B/);
      return true;
    },
  );
  assert.deepEqual(readCalls, [], '超限时不应该读文件内容');

  // 空文件也要在读之前拒绝，且文案说清楚是「空」
  await assert.rejects(
    () => buildVideoSubmitBody(
      { mode: 'frame', prompt: 'x', first_frame: localPng },
      { statFile: async () => ({ size: 0 }), readFile: async () => Buffer.alloc(0) },
    ),
    (err) => { assert.match(err.message, /is empty/); return true; },
  );

  // 正常大小放行
  const ok = await buildVideoSubmitBody(
    { mode: 'frame', prompt: 'x', first_frame: localPng },
    { statFile: async () => ({ size: 8 }), readFile: async () => Buffer.from('fake-png') },
  );
  assert.equal(ok.body.input.first_frame_image.base64, Buffer.from('fake-png').toString('base64'));
});
