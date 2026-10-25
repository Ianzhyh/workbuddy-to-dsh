/**
 * 图片工具的 agent 侧合约：
 *   1. 提交只拿任务 id，不在工具里阻塞等出图；给 images 就是图生图；
 *   2. 失败文案必须阻止 agent 盲目重提（会重复计费）；
 *   3. 查询工具把 completed / processing / failed 三种状态讲清楚。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createTools } from '../lib/tools.mjs';

function makeTools(client) {
  return createTools({
    snapshot: async () => ({}),
    supervisor: { probe: async () => ({ state: 'stopped' }) },
    consoleSupervisor: {},
    adapter: {},
    client,
  });
}

const tool = (name, client) => makeTools(client).find((item) => item.name === name);

test('图片工具：注册生成与查询入口，参数严格', () => {
  const tools = makeTools({});
  assert.deepEqual(
    tools.filter((item) => item.name.includes('image')).map((item) => item.name).sort(),
    ['workbuddy_generate_image', 'workbuddy_image_status'],
  );
  const submit = tools.find((item) => item.name === 'workbuddy_generate_image');
  assert.equal(submit.parameters.additionalProperties, false);
  assert.deepEqual(submit.parameters.required, ['prompt']);
  const status = tools.find((item) => item.name === 'workbuddy_image_status');
  assert.deepEqual(status.parameters.required, ['id']);
  assert.equal(status.parameters.properties.wait_seconds.maximum, 45);
});

test('文生图：只传 prompt → mode=generate，返回任务 id 并禁止重提', async () => {
  let seen;
  const submit = tool('workbuddy_generate_image', {
    imageSubmit: async (args) => {
      seen = args;
      return { id: 'img-1', status: 'queued', mode: 'generate', size: '1024x1024' };
    },
  });
  const output = await submit.execute({ prompt: '  a red fox  ', size: '1024x1024', quality: 'hd' });
  assert.equal(seen.prompt, '  a red fox  ');
  assert.deepEqual(seen.images, []);
  assert.equal(seen.mode, 'generate');
  assert.equal(seen.size, '1024x1024');
  assert.equal(seen.quality, 'hd');
  assert.match(output, /img-1/);
  assert.match(output, /积分计费/);
  assert.match(output, /不要.*再提交/);
  assert.match(output, /workbuddy_image_status/);
});

test('图生图：给 images → mode=edit，空项被过滤', async () => {
  let seen;
  const submit = tool('workbuddy_generate_image', {
    imageSubmit: async (args) => {
      seen = args;
      return { id: 'img-2', status: 'queued', mode: 'edit' };
    },
  });
  await submit.execute({ prompt: 'purple sky', images: [' file/abc/ref.png ', '', 3] });
  assert.equal(seen.mode, 'edit');
  assert.deepEqual(seen.images, ['file/abc/ref.png']);
});

test('图片错误：400/403/429/NO_OUTPUT 都是「图片」口径且不暗示重提', async () => {
  const failed = (status, message = 'boom', payload) => tool('workbuddy_generate_image', {
    imageSubmit: async () => {
      const error = new Error(message);
      if (status) error.status = status;
      if (payload) error.payload = payload;
      throw error;
    },
  });

  const rejected = await failed(400, 'unsupported size').execute({ prompt: 'x' });
  assert.match(rejected, /图片请求被拒绝/);
  assert.match(rejected, /不要原样重试/);

  const forbidden = await failed(403, 'local token required').execute({ prompt: 'x' });
  assert.match(forbidden, /图片接口只接受本地管理令牌/);

  const limited = await failed(429, 'too many requests').execute({ prompt: 'x' });
  assert.match(limited, /图片提交被 Miora 限流/);
  assert.match(limited, /workbuddy_image_status/);

  const missing = await failed(404, 'no such task').execute({ prompt: 'x' });
  assert.match(missing, /没有找到这个图片任务/);

  const noOutput = await failed(502, 'no https output', {
    error: { code: 'IMAGE_NO_OUTPUT', message: 'no https output' },
  }).execute({ prompt: 'x' });
  assert.match(noOutput, /没有返回可下载/);
  assert.match(noOutput, /workbuddy_image_status/);
  assert.match(noOutput, /不要重新提交/);
});

test('图片查询：completed 给 URL，processing 不催重提，failed 给原因', async () => {
  const completed = tool('workbuddy_image_status', {
    imageStatus: async (id, options) => {
      assert.equal(id, 'img-1');
      assert.equal(options.waitMs, 20_000);
      return {
        status: 'completed',
        upstream_status: 'completed',
        mode: 'generate',
        size: '1024x1024',
        created_at: 1761390000,
        output: { url: 'https://cdn.example/i.png', urls: ['https://cdn.example/i.png'] },
      };
    },
  });
  const done = await completed.execute({ id: ' img-1 ' });
  assert.match(done, /completed/);
  assert.match(done, /1024x1024/);
  assert.match(done, /提交时间/);
  assert.match(done, /https:\/\/cdn\.example\/i\.png/);
  assert.match(done, /有时效/);

  const processing = tool('workbuddy_image_status', {
    imageStatus: async () => ({ status: 'in_progress', upstream_status: 'processing' }),
  });
  const waiting = await processing.execute({ id: 'img-2', wait_seconds: 0 });
  assert.match(waiting, /仍在生成/);
  assert.match(waiting, /不要重新提交/);
  assert.doesNotMatch(waiting, /已等待/);

  const failed = tool('workbuddy_image_status', {
    imageStatus: async () => ({ status: 'failed', upstream_status: 'failed', error: { message: 'content safety' } }),
  });
  const errorText = await failed.execute({ id: 'img-3' });
  assert.match(errorText, /content safety/);
  assert.match(errorText, /不要直接重复提交/);
});

test('图片查询：空 id 直接报错', async () => {
  const empty = tool('workbuddy_image_status', { imageStatus: async () => ({}) });
  await assert.rejects(empty.execute({ id: '  ' }), /id 不能为空/);
});
