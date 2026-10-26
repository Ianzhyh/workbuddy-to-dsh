/**
 * Miora 图片客户端：请求体 / 校验 / 上游交互合约。
 *
 * 不发真实请求：注入 fetch 断言临时 key、请求路径、错误码前缀与长轮询。
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildImageSubmitBody,
  queryImage,
  submitImage,
} from './miora-image.mjs';
import { resetTempKeyCache } from './miora-media-core.mjs';

const AUTH = {
  access: 'test-login-token',
  endpoint: 'https://chat.example',
  userId: 'user-1',
};
const BASE = 'https://miora.example';
const localPng = process.platform === 'win32' ? 'C:\\tmp\\ref.png' : '/tmp/ref.png';

const jsonResponse = (status, body, headers = {}) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json', ...headers },
});

const tempKeyResponse = (key = 'ck_t_image') => jsonResponse(200, {
  code: 0,
  data: { key, expires_at: new Date(Date.now() + 900_000).toISOString() },
});

beforeEach(() => resetTempKeyCache());

test('文生图：prompt/size/quality 原样进请求体，size 归一成小写', async () => {
  const built = await buildImageSubmitBody({
    prompt: '  a red fox in snow  ',
    size: ' 1024X768 ',
    quality: 'HD',
  });
  assert.equal(built.mode, 'generate');
  assert.deepEqual(built.body, {
    prompt: 'a red fox in snow',
    size: '1024x768',
    quality: 'HD',
  });
});

test('图生图：images 支持 fileKey / URL / data URI / 本地路径', async () => {
  const built = await buildImageSubmitBody({
    prompt: 'make the sky purple',
    images: ['file/abc/ref.png', 'https://cdn.example/ref.png', 'data:image/png;base64,AAAA'],
    size: '1024x1024',
  });
  assert.equal(built.mode, 'edit');
  assert.equal(built.imageCount, 3);
  assert.deepEqual(built.body.images, [
    { file_key: 'file/abc/ref.png' },
    { url: 'https://cdn.example/ref.png' },
    { base64: 'AAAA' },
  ]);

  const local = await buildImageSubmitBody(
    { prompt: 'x', images: [localPng] },
    { readFile: async () => Buffer.from('png-bytes') },
  );
  assert.equal(local.body.images[0].base64, Buffer.from('png-bytes').toString('base64'));

  // data URI 的 scheme 大小写不敏感（RFC 2397）。
  const upper = await buildImageSubmitBody({
    prompt: 'x',
    images: ['DATA:image/png;base64,AAAA'],
  });
  assert.deepEqual(upper.body.images, [{ base64: 'AAAA' }]);
});

test('图生图：单张 image 是 images[] 的别名', async () => {
  const built = await buildImageSubmitBody({ prompt: 'x', image: ' file/abc/one.png ' });
  assert.equal(built.mode, 'edit');
  assert.deepEqual(built.body.images, [{ file_key: 'file/abc/one.png' }]);
});

test('图片输入上限 20 MB：11 MB 文件在图片接口仍可用（视频帧是 10 MB）', async () => {
  const big = Buffer.alloc(11 * 1024 * 1024);
  const built = await buildImageSubmitBody(
    { prompt: 'x', images: [localPng] },
    { readFile: async () => big },
  );
  assert.ok(built.body.images[0].base64.length > 0);
});

test('校验：未知字段/缺 prompt/模式冲突/坏 size 都在本地 400', async () => {
  const cases = [
    [{}, /prompt is required/],
    [{ prompt: 'x', aspect_ratio: '16:9' }, /unknown field/],
    [{ prompt: 'x', n: 2 }, /unknown field/],
    [{ prompt: 'x', mode: 'generate', images: ['file/a'] }, /does not accept images/],
    [{ prompt: 'x', mode: 'edit' }, /requires at least one images/],
    [{ prompt: 'x', size: '1024*1024' }, /WIDTHxHEIGHT/],
    [{ prompt: 'x', size: 'wide' }, /WIDTHxHEIGHT/],
    [{ prompt: 'x', images: [123] }, /images\[0\]/],
    [{ prompt: 'x', images: 'file/a' }, /must be an array/],
    [{ prompt: 'x', images: ['file/a'], image: 'file/b' }, /either images/],
    [{ prompt: 'x', quality: 2 }, /quality must be a string/],
    [{ prompt: 'x'.repeat(8001) }, /longer than 8000/],
  ];
  for (const [input, pattern] of cases) {
    await assert.rejects(
      () => buildImageSubmitBody(input, { readFile: async () => Buffer.from('x') }),
      (err) => {
        assert.equal(err.code, 'IMAGE_INVALID_INPUT');
        assert.equal(err.status, 400);
        assert.match(err.message, pattern);
        return true;
      },
      JSON.stringify(input).slice(0, 120),
    );
  }
});

test('提交：文生图走 generate 路径，改图走 edit 路径（quality 不进改图）', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith('/v2/api-keys')) return tempKeyResponse();
    if (String(url).endsWith('/image/generate/submit')) {
      return jsonResponse(200, {
        code: 0,
        failed: false,
        data: { upstreamTaskId: 'img-1', model: 'miora-image', provider: 'copilot-image', mode: 'async' },
      });
    }
    if (String(url).endsWith('/image/edit/submit')) {
      return jsonResponse(200, {
        code: 0,
        failed: false,
        data: { upstreamTaskId: 'img-2', mode: 'async' },
      });
    }
    throw new Error(`unexpected ${url}`);
  };

  const generated = await submitImage(AUTH, { prompt: 'a fox', size: '1024x1024', quality: 'hd' }, {
    fetchImpl, baseUrl: BASE, now: () => 1000,
  });
  assert.equal(generated.id, 'img-1');
  assert.equal(generated.object, 'image');
  assert.equal(generated.status, 'queued');
  assert.equal(generated.mode, 'generate');
  assert.equal(generated.size, '1024x1024');
  assert.equal(generated.created_at, 1);

  const generateCall = calls.find((call) => call.url.endsWith('/image/generate/submit'));
  assert.equal(generateCall.init.headers.Authorization, 'Bearer ck_t_image');
  assert.deepEqual(JSON.parse(generateCall.init.body), {
    prompt: 'a fox', size: '1024x1024', quality: 'hd',
  });

  const edited = await submitImage(AUTH, {
    prompt: 'purple sky', images: ['file/abc/ref.png'], size: '1024x768', quality: 'hd',
  }, { fetchImpl, baseUrl: BASE, now: () => 2000 });
  assert.equal(edited.mode, 'edit');
  assert.equal(edited.id, 'img-2');
  const editCall = calls.find((call) => call.url.endsWith('/image/edit/submit'));
  assert.deepEqual(JSON.parse(editCall.init.body), {
    prompt: 'purple sky',
    size: '1024x768',
    images: [{ file_key: 'file/abc/ref.png' }],
  });
});

test('查询：waitMs 内等到 completed，并回填提交元数据', async () => {
  let queries = 0;
  const fetchImpl = async (url) => {
    if (String(url).endsWith('/v2/api-keys')) return tempKeyResponse('ck_t_image_query');
    if (String(url).endsWith('/image/generate/submit')) {
      return jsonResponse(200, {
        code: 0,
        failed: false,
        data: { upstreamTaskId: 'img-poll', mode: 'async' },
      });
    }
    if (String(url).endsWith('/image/query-task')) {
      queries += 1;
      const status = queries < 2 ? 'processing' : 'completed';
      return jsonResponse(200, {
        code: 0,
        failed: false,
        data: {
          'img-poll': {
            status,
            resultFiles: status === 'completed'
              ? [{ signedUrl: 'https://cdn.example/i.png', mimeType: 'image/png', fileKey: 'file/i' }]
              : [],
          },
        },
      });
    }
    throw new Error(`unexpected ${url}`);
  };

  await submitImage(AUTH, { prompt: 'x', size: '1024x1024' }, { fetchImpl, baseUrl: BASE, now: () => 1000 });
  const done = await queryImage(AUTH, 'img-poll', {
    fetchImpl, baseUrl: BASE, waitMs: 10_000, sleep: async () => {},
  });
  assert.equal(done.status, 'completed');
  assert.equal(done.mode, 'generate');
  assert.equal(done.size, '1024x1024');
  assert.equal(done.created_at, 1);
  assert.equal(done.output.url, 'https://cdn.example/i.png');
  assert.equal(queries, 2);
});

test('同步完成：提交响应即终态，查询命中缓存、不再打上游', async () => {
  let calls = 0;
  const fetchImpl = async (url) => {
    calls += 1;
    if (String(url).endsWith('/v2/api-keys')) return tempKeyResponse('ck_t_sync_ok');
    if (String(url).endsWith('/image/generate/submit')) {
      return jsonResponse(200, {
        code: 0,
        failed: false,
        data: {
          upstreamTaskId: 'wb-sync-ok',
          model: 'hy-image',
          provider: 'copilot-image',
          mode: 'sync',
          status: 'completed',
          resultFiles: [{ signedUrl: 'https://cdn.example/sync.png', fileKey: 'file/sync' }],
        },
      });
    }
    throw new Error(`unexpected ${url}`);
  };

  const submitted = await submitImage(AUTH, { prompt: 'x' }, { fetchImpl, baseUrl: BASE, now: () => 5000 });
  assert.equal(submitted.status, 'completed');
  assert.equal(submitted.sync, true);
  assert.equal(submitted.output.url, 'https://cdn.example/sync.png');
  assert.equal(calls, 2, '临时 key + 提交');

  const queried = await queryImage(AUTH, 'wb-sync-ok', {
    fetchImpl, baseUrl: BASE, waitMs: 60_000,
  });
  assert.equal(queried.status, 'completed');
  assert.equal(queried.sync, true);
  assert.equal(queried.created_at, 5);
  assert.equal(queried.output.url, 'https://cdn.example/sync.png');
  assert.equal(calls, 2, '缓存命中不应再查询上游');
});

test('同步缓存按账号隔离：切号后不能读到旧账号的产物；同账号换 token 仍可命中', async () => {
  let calls = 0;
  let queryCalls = 0;
  const fetchImpl = async (url) => {
    calls += 1;
    if (String(url).endsWith('/v2/api-keys')) {
      return tempKeyResponse(`ck_t_account_${calls}`);
    }
    if (String(url).endsWith('/image/generate/submit')) {
      return jsonResponse(200, {
        code: 0,
        failed: false,
        data: {
          upstreamTaskId: 'wb-sync-account',
          mode: 'sync',
          status: 'completed',
          resultFiles: [{ signedUrl: 'https://cdn.example/account.png' }],
        },
      });
    }
    if (String(url).endsWith('/image/query-task')) {
      queryCalls += 1;
      return jsonResponse(200, { code: 0, failed: false, data: {} });
    }
    throw new Error(`unexpected ${url}`);
  };

  await submitImage(AUTH, { prompt: 'x' }, { fetchImpl, baseUrl: BASE });

  // 同账号、access token 轮换：作用域用 endpoint+userId，缓存仍命中。
  const rotated = await queryImage({ ...AUTH, access: 'rotated-login-token' }, 'wb-sync-account', {
    fetchImpl, baseUrl: BASE,
  });
  assert.equal(rotated.status, 'completed');
  assert.equal(rotated.output.url, 'https://cdn.example/account.png');
  assert.equal(queryCalls, 0, '同账号换 token 不应失效');

  // 换账号：必须重新走上游，不能从本进程缓存里读别人的结果。
  await assert.rejects(
    () => queryImage({ ...AUTH, userId: 'user-2' }, 'wb-sync-account', { fetchImpl, baseUrl: BASE }),
    (err) => {
      assert.equal(err.code, 'IMAGE_NOT_FOUND');
      return true;
    },
  );
  assert.equal(queryCalls, 1, '不同账号必须重新查询上游');
});

test('同步失败：真实失败原因随提交返回；图生图不再回显未生效的 quality', async () => {
  let calls = 0;
  const fetchImpl = async (url) => {
    calls += 1;
    if (String(url).endsWith('/v2/api-keys')) return tempKeyResponse('ck_t_sync_fail');
    if (String(url).endsWith('/image/edit/submit')) {
      return jsonResponse(200, {
        code: 0,
        failed: false,
        data: {
          upstreamTaskId: 'wb-sync-fail',
          mode: 'sync',
          status: 'FAILED',
          errorMessage: 'content safety',
        },
      });
    }
    throw new Error(`unexpected ${url}`);
  };

  const failed = await submitImage(AUTH, {
    prompt: 'x', images: ['file/abc/ref.png'], quality: 'hd',
  }, { fetchImpl, baseUrl: BASE });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.upstream_status, 'FAILED');
  assert.equal(failed.sync, true);
  assert.equal(failed.error.message, 'content safety');
  assert.equal(failed.quality, null, '图生图没有发送 quality，不能回显成已生效');

  const queried = await queryImage(AUTH, 'wb-sync-fail', { fetchImpl, baseUrl: BASE });
  assert.equal(queried.status, 'failed');
  assert.equal(queried.error.message, 'content safety');
  assert.equal(calls, 2, '同步失败的结果也来自提交缓存');
});

test('mode=sync 但 status 非终态：不缓存成永远 in_progress，按异步查询上游', async () => {
  let queryCalls = 0;
  const fetchImpl = async (url) => {
    if (String(url).endsWith('/v2/api-keys')) return tempKeyResponse('ck_t_sync_running');
    if (String(url).endsWith('/image/generate/submit')) {
      return jsonResponse(200, {
        code: 0,
        failed: false,
        data: {
          upstreamTaskId: 'wb-sync-running',
          mode: 'sync',
          status: 'processing',
        },
      });
    }
    if (String(url).endsWith('/image/query-task')) {
      queryCalls += 1;
      return jsonResponse(200, {
        code: 0,
        failed: false,
        data: {
          'wb-sync-running': {
            status: 'completed',
            resultFiles: [{ signedUrl: 'https://cdn.example/running.png' }],
          },
        },
      });
    }
    throw new Error(`unexpected ${url}`);
  };

  const submitted = await submitImage(AUTH, { prompt: 'x' }, { fetchImpl, baseUrl: BASE });
  assert.equal(submitted.status, 'in_progress');
  assert.equal(submitted.sync, false, '非终态不能标成同步完成');

  const done = await queryImage(AUTH, 'wb-sync-running', { fetchImpl, baseUrl: BASE });
  assert.equal(done.status, 'completed');
  assert.equal(done.output.url, 'https://cdn.example/running.png');
  assert.equal(queryCalls, 1, '非终态应重新查上游');
});

test('同步任务缓存丢失：查询伪失败被标记 sync_result_unavailable，并给出人话', async () => {
  const fetchImpl = async (url) => {
    if (String(url).endsWith('/v2/api-keys')) return tempKeyResponse('ck_t_sync_gone');
    if (String(url).endsWith('/image/query-task')) {
      return jsonResponse(200, {
        code: 0,
        failed: false,
        data: {
          'wb-sync-gone': {
            status: 'failed',
            errorMessage: 'INVALID_TASK_ID_FOR_SYNC_MODE: this task was completed synchronously',
          },
        },
      });
    }
    throw new Error(`unexpected ${url}`);
  };
  const result = await queryImage(AUTH, 'wb-sync-gone', { fetchImpl, baseUrl: BASE });
  assert.equal(result.status, 'failed');
  assert.equal(result.sync_result_unavailable, true);
  assert.match(result.error.message, /同步完成/);
  assert.match(result.error.message, /重新生成/);
});

test('多图 inline 预算：按请求体上限提前 400，而不是读完几十 MB 再 413', async () => {
  const twelveMb = Buffer.alloc(12 * 1024 * 1024);
  await assert.rejects(
    () => buildImageSubmitBody(
      { prompt: 'x', images: [localPng, localPng] },
      { readFile: async () => twelveMb, maxBodyBytes: 32 * 1024 * 1024 },
    ),
    (err) => {
      assert.equal(err.code, 'IMAGE_INVALID_INPUT');
      assert.match(err.message, /request body budget/);
      assert.match(err.message, /fileKey/);
      return true;
    },
  );

  const twentyMb = Buffer.alloc(20 * 1024 * 1024);
  const one = await buildImageSubmitBody(
    { prompt: 'x', images: [localPng] },
    { readFile: async () => twentyMb, maxBodyBytes: 32 * 1024 * 1024 },
  );
  assert.ok(one.body.images[0].base64.length > 0, '单张 20 MB 仍应放行');
});

test('临时 key 限流使用独立 code：任务尚未提交，可以直接稍后重试', async () => {
  const limited = async () => jsonResponse(429, { msg: 'slow down' }, { 'retry-after': '3' });
  await assert.rejects(
    () => submitImage(AUTH, { prompt: 'x' }, { fetchImpl: limited, baseUrl: BASE }),
    (err) => {
      assert.equal(err.code, 'IMAGE_KEY_RATE_LIMITED');
      assert.equal(err.status, 429);
      assert.equal(err.retryAfter, 3);
      return true;
    },
  );
});

test('查询：不存在返回 IMAGE_NOT_FOUND；失败任务保留 errorMessage', async () => {
  const fetchImpl = async (url) => {
    if (String(url).endsWith('/v2/api-keys')) return tempKeyResponse('ck_t_image_fail');
    if (String(url).endsWith('/image/query-task')) {
      return jsonResponse(200, {
        code: 0,
        failed: false,
        data: { 'img-failed': { status: 'failed', errorMessage: 'content safety' } },
      });
    }
    throw new Error(`unexpected ${url}`);
  };
  const failed = await queryImage(AUTH, 'img-failed', { fetchImpl, baseUrl: BASE });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error.message, 'content safety');

  await assert.rejects(
    () => queryImage(AUTH, 'missing', { fetchImpl, baseUrl: BASE }),
    (err) => {
      assert.equal(err.code, 'IMAGE_NOT_FOUND');
      assert.equal(err.status, 404);
      return true;
    },
  );
});

test('错误前缀：限流/拒绝/scope 都是 IMAGE_*，不会混成 VIDEO_*', async () => {
  const limited = async (url) => {
    if (String(url).endsWith('/v2/api-keys')) return tempKeyResponse('ck_t_image_429');
    return jsonResponse(429, { code: 15001, msg: 'too many requests' }, { 'retry-after': '5' });
  };
  await assert.rejects(
    () => submitImage(AUTH, { prompt: 'x' }, { fetchImpl: limited, baseUrl: BASE }),
    (err) => {
      assert.equal(err.code, 'IMAGE_RATE_LIMITED');
      assert.equal(err.status, 429);
      assert.equal(err.retryAfter, 5);
      return true;
    },
  );

  const rejected = async (url) => {
    if (String(url).endsWith('/v2/api-keys')) return tempKeyResponse('ck_t_image_reject');
    return jsonResponse(200, {
      code: 1001,
      failed: true,
      httpStatus: 400,
      message: 'upstream image-generate failed: status=400 code=14407 msg=unsupported size',
    });
  };
  await assert.rejects(
    () => submitImage(AUTH, { prompt: 'x', size: '9999x9999' }, { fetchImpl: rejected, baseUrl: BASE }),
    (err) => {
      assert.equal(err.code, 'IMAGE_UPSTREAM_REJECTED');
      assert.equal(err.status, 400);
      assert.match(err.message, /unsupported size/);
      return true;
    },
  );

  const forbidden = async () => jsonResponse(403, { code: 14003, msg: 'no image scope' });
  await assert.rejects(
    () => submitImage(AUTH, { prompt: 'x' }, { fetchImpl: forbidden, baseUrl: BASE }),
    (err) => {
      assert.equal(err.code, 'IMAGE_SCOPE_DENIED');
      assert.equal(err.status, 403);
      return true;
    },
  );
});
