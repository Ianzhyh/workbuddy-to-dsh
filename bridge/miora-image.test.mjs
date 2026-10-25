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
