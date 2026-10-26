/**
 * 视频工具的 agent 侧合约：
 *   1. 提交只做“拿任务 id”，不在工具里阻塞等待出片；
 *   2. 失败文案必须阻止 agent 盲目重提（视频提交会重复计费）；
 *   3. 查询工具把 completed / processing / failed 三种状态讲清楚。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createTools } from '../lib/tools.mjs';

function makeTools(videoSubmit, videoStatus) {
  return createTools({
    snapshot: async () => ({}),
    supervisor: { probe: async () => ({ state: 'stopped' }) },
    consoleSupervisor: {},
    adapter: {},
    client: { videoSubmit, videoStatus },
  });
}

const tool = (name, videoSubmit, videoStatus) => makeTools(videoSubmit, videoStatus)
  .find((item) => item.name === name);

test('视频工具：注册生成与查询两个入口', () => {
  const tools = makeTools(async () => ({}), async () => ({}));
  assert.deepEqual(
    tools.filter((item) => item.name.includes('video')).map((item) => item.name).sort(),
    ['workbuddy_generate_video', 'workbuddy_video_status'],
  );
  const submit = tools.find((item) => item.name === 'workbuddy_generate_video');
  assert.equal(submit.parameters.type, 'object');
  assert.equal(submit.parameters.additionalProperties, false);
  const status = tools.find((item) => item.name === 'workbuddy_video_status');
  assert.deepEqual(status.parameters.required, ['id']);
  assert.equal(status.parameters.properties.wait_seconds.maximum, 120);
  assert.equal(submit.parameters.properties.save_to.type, 'string', '同步完成时可直接落盘');
});

test('生成工具：映射参数，返回任务 id 并明确不要重复提交', async () => {
  let seen;
  const submit = tool('workbuddy_generate_video', async (args) => {
    seen = args;
    return { id: 'task-1', status: 'queued', mode: 'reference', model: 'miora-video' };
  });
  const output = await submit.execute({
    prompt: '  same character waving  ',
    mode: 'reference',
    references: [' file/abc ', 'https://cdn.example/ref.png '],
    duration: 5,
    resolution: '720p',
    aspect_ratio: '9:16',
  });
  assert.equal(seen.prompt, '  same character waving  ');
  assert.deepEqual(seen.references, ['file/abc', 'https://cdn.example/ref.png']);
  assert.equal(seen.duration, 5);
  assert.equal(seen.resolution, '720p');
  assert.equal(seen.aspectRatio, '9:16');
  assert.match(output, /task-1/);
  assert.match(output, /积分计费/);
  assert.match(output, /不要.*再提交/);
  assert.match(output, /workbuddy_video_status/);
});

test('生成工具：429/401/400/桥未运行都给可执行结论，且不暗示重提', async () => {
  const failed = (status, message = 'boom') => tool('workbuddy_generate_video', async () => {
    const error = new Error(message);
    if (status) error.status = status;
    throw error;
  });

  const limited = await failed(429, 'too many requests').execute({ prompt: 'x' });
  assert.match(limited, /限流/);
  assert.match(limited, /不要重复提交/);
  assert.match(limited, /workbuddy_video_status/);

  const unauthorized = await failed(401, 'login expired').execute({ prompt: 'x' });
  assert.match(unauthorized, /登录态/);

  const forbidden = await failed(403, 'local token required').execute({ prompt: 'x' });
  assert.match(forbidden, /本地管理令牌/);

  const rejected = await failed(400, 'CONTENT_SAFETY').execute({ prompt: 'x' });
  assert.match(rejected, /被拒绝/);
  assert.match(rejected, /不要原样重试/);

  const down = await failed(0, 'fetch failed').execute({ prompt: 'x' });
  assert.match(down, /桥未运行/);
});

test('生成工具：上游同步完成时直接交付产物，不再让用户查一个查不到的任务', async () => {
  const submit = tool('workbuddy_generate_video', async () => ({
    id: 'wb-sync-1',
    status: 'completed',
    upstream_status: 'completed',
    mode: 'text',
    sync: true,
    result_files: [{ signedUrl: 'https://cdn.example/v.mp4', fileKey: 'file/video-9' }],
    output: { url: 'https://cdn.example/v.mp4', urls: ['https://cdn.example/v.mp4'] },
  }));
  const output = await submit.execute({ prompt: 'x' });
  assert.match(output, /视频已生成/);
  assert.match(output, /https:\/\/cdn\.example\/v\.mp4/);
  assert.match(output, /不要重复生成/);
  assert.doesNotMatch(output, /稍后用 workbuddy_video_status/);
});

test('生成工具：同步失败直接给失败原因，不说“已提交、稍后查询”', async () => {
  const submit = tool('workbuddy_generate_video', async () => ({
    id: 'wb-sync-2',
    status: 'failed',
    upstream_status: 'failed',
    mode: 'text',
    sync: true,
    error: { message: 'content safety' },
  }));
  const output = await submit.execute({ prompt: 'x' });
  assert.match(output, /视频生成失败/);
  assert.match(output, /content safety/);
  assert.match(output, /不要原样重提/);
  assert.doesNotMatch(output, /已提交视频任务/);
  assert.doesNotMatch(output, /稍后用 workbuddy_video_status/);
});

test('查询工具：cancelled 与同步缓存丢失都不被说成“普通失败”', async () => {
  const cancelled = tool('workbuddy_video_status', async () => ({}), async () => ({
    status: 'cancelled', upstream_status: 'cancelled',
  }));
  const cancelledText = await cancelled.execute({ id: 'task-1' });
  assert.match(cancelledText, /已取消/);
  assert.match(cancelledText, /不是生成失败/);

  const stale = tool('workbuddy_video_status', async () => ({}), async () => ({
    status: 'failed',
    upstream_status: 'failed',
    sync_result_unavailable: true,
    error: { message: '该任务是同步完成的' },
  }));
  const staleText = await stale.execute({ id: 'wb-sync-old' });
  assert.match(staleText, /同步完成/);
  assert.match(staleText, /不要把它当成普通失败/);
  assert.match(staleText, /重新生成/);
});

test('错误文案：413 / 账号无权限 / 临时 key 限流各有可执行结论', async () => {
  const failing = (status, message, code) => tool('workbuddy_generate_video', async () => {
    const error = new Error(message);
    error.status = status;
    if (code) error.payload = { error: { code, message } };
    throw error;
  });

  const tooLarge = await failing(413, 'body too large', 'VIDEO_PAYLOAD_TOO_LARGE').execute({ prompt: 'x' });
  assert.match(tooLarge, /请求体太大/);
  assert.match(tooLarge, /fileKey/);

  const denied = await failing(403, 'no scope', 'VIDEO_SCOPE_DENIED').execute({ prompt: 'x' });
  assert.match(denied, /账号没有视频生成权限/);

  const keyLimited = await failing(429, 'too many keys', 'VIDEO_KEY_RATE_LIMITED').execute({ prompt: 'x' });
  assert.match(keyLimited, /尚未提交/);
  assert.match(keyLimited, /不会计费/);
  assert.match(keyLimited, /直接重试/);
});

test('查询工具：completed 返回有时效 URL，processing 不催重提，failed 给原因', async () => {
  const completed = tool('workbuddy_video_status', async () => ({}), async (id) => {
    assert.equal(id, 'task-1');
    return {
      status: 'completed',
      upstream_status: 'completed',
      mode: 'text',
      seconds: 5,
      resolution: '768P',
      created_at: 1761390000,
      result_files: [{ signedUrl: 'https://cdn.example/v.mp4', fileKey: 'file/video-1' }],
      output: { url: 'https://cdn.example/v.mp4', urls: ['https://cdn.example/v.mp4'] },
    };
  });
  const done = await completed.execute({ id: ' task-1 ' });
  assert.match(done, /completed/);
  assert.match(done, /768P/);
  assert.match(done, /提交时间/);
  assert.match(done, /https:\/\/cdn\.example\/v\.mp4/);
  assert.match(done, /有时效/);
  assert.doesNotMatch(done, /file\/video-1/, '视频 fileKey 不是图片，不能宣称可直接当首帧复用');

  const processing = tool('workbuddy_video_status', async () => ({}), async () => ({
    status: 'in_progress', upstream_status: 'processing',
  }));
  const waiting = await processing.execute({ id: 'task-2' });
  assert.match(waiting, /仍在生成/);
  assert.match(waiting, /不要重新提交/);

  const failed = tool('workbuddy_video_status', async () => ({}), async () => ({
    status: 'failed', upstream_status: 'failed', error: { message: 'render failed' },
  }));
  const errorText = await failed.execute({ id: 'task-3' });
  assert.match(errorText, /render failed/);
  assert.match(errorText, /不要直接重复提交/);
});

test('查询工具：默认代等 20 秒，wait_seconds=0 立即返回，超预算按 60 秒分段', async () => {
  const seen = [];
  const status = tool('workbuddy_video_status', async () => ({}), async (id, options) => {
    seen.push({ id, waitMs: options?.waitMs });
    return { status: 'in_progress', upstream_status: 'processing' };
  });

  const waited = await status.execute({ id: 'task-1' });
  assert.equal(seen[0].waitMs, 20_000);
  assert.match(waited, /最多等待约 20 秒/);
  assert.match(waited, /不要重新提交/);

  const immediate = await status.execute({ id: 'task-1', wait_seconds: 0 });
  assert.equal(seen[1].waitMs, 0);
  assert.doesNotMatch(immediate, /最多等待/);

  const long = await status.execute({ id: 'task-1', wait_seconds: 999 });
  // 120 秒预算 = 两段 60 秒；仍是 pending 就收手，不会空转。
  assert.deepEqual(seen.slice(2).map((entry) => entry.waitMs), [60_000, 60_000]);
  assert.match(long, /最多等待约 120 秒/);
  assert.deepEqual(status.parameters.properties.wait_seconds.maximum, 120);
});

test('查询工具：409 与 VIDEO_NO_OUTPUT 都给出「别重提」的可执行结论', async () => {
  const conflict = tool('workbuddy_video_status', async () => ({}), async () => {
    const error = new Error('not ready');
    error.status = 409;
    throw error;
  });
  const conflictText = await conflict.execute({ id: 'task-1' });
  assert.match(conflictText, /还没完成/);
  assert.match(conflictText, /不要重新提交/);

  const noOutput = tool('workbuddy_video_status', async () => ({}), async () => {
    const error = new Error('no https output');
    error.status = 502;
    error.payload = { error: { code: 'VIDEO_NO_OUTPUT', message: 'no https output' } };
    throw error;
  });
  const noOutputText = await noOutput.execute({ id: 'task-1' });
  assert.match(noOutputText, /没有返回可下载/);
  assert.match(noOutputText, /不要重新提交/);
});

test('查询工具：404 与空 id 都给人话', async () => {
  const missing = tool('workbuddy_video_status', async () => ({}), async () => {
    const error = new Error('no such task');
    error.status = 404;
    throw error;
  });
  assert.match(await missing.execute({ id: 'missing' }), /没有找到/);

  const empty = tool('workbuddy_video_status', async () => ({}), async () => ({}));
  await assert.rejects(empty.execute({ id: '  ' }), /id 不能为空/);
});

test('生成工具：图片输入认出对象包装，认不出就拒绝提交', async () => {
  let seen;
  const submit = tool('workbuddy_generate_video', async (args) => {
    seen = args;
    return { id: 'task-1', status: 'queued', mode: 'frame' };
  });

  // 模型常把首帧写成 {url}/{path}：原先会被静默丢掉 → 退化成文生视频却照常计费。
  await submit.execute({
    prompt: 'move',
    first_frame: { path: ' C:/frames/start.png ' },
    last_frame: { url: 'https://cdn.example/end.png' },
    references: [{ file_key: 'file/abc/ref.png' }],
  });
  assert.equal(seen.firstFrame, 'C:/frames/start.png');
  assert.equal(seen.lastFrame, 'https://cdn.example/end.png');
  assert.deepEqual(seen.references, ['file/abc/ref.png']);

  let submitted = false;
  const strict = tool('workbuddy_generate_video', async () => {
    submitted = true;
    return { id: 'task-2', status: 'queued' };
  });
  const rejected = await strict.execute({ prompt: 'x', first_frame: { blob: 'zzz' } });
  assert.match(rejected, /没有提交（未计费）/);
  assert.match(rejected, /first_frame/);
  assert.equal(submitted, false);
});

test('查询工具：save_to 把签名 URL 落盘成本地文件', async () => {
  const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'wb-tool-save-'));

  // saveMediaFile 只允许 https；这里替换 fetch 挡住真实网络，但仍走完整下载路径。
  const payload = Buffer.from('MP4-FAKE-CONTENT');
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.match(String(url), /^https:\/\//);
    return new Response(payload, { status: 200, headers: { 'content-type': 'video/mp4' } });
  };
  try {
    const status = tool('workbuddy_video_status', async () => ({}), async () => ({
      status: 'completed',
      upstream_status: 'completed',
      output: { url: 'https://cdn.example/v.mp4', urls: ['https://cdn.example/v.mp4'] },
    }));
    const output = await status.execute({ id: 'task-1', save_to: dir });
    assert.match(output, /已保存到本地/);
    const match = /- (.+\.mp4)/.exec(output);
    assert.ok(match, `回执里应有本地路径：${output}`);
    assert.equal(readFileSync(match[1]).toString(), 'MP4-FAKE-CONTENT');
  } finally {
    globalThis.fetch = original;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('生成工具：同步完成时 save_to 当场落盘，不必再查一次', async () => {
  const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'wb-tool-submit-save-'));
  const payload = Buffer.from('SYNC-MP4');
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(payload, {
    status: 200,
    headers: { 'content-type': 'video/mp4' },
  });
  try {
    const submit = tool('workbuddy_generate_video', async () => ({
      id: 'wb-sync-save',
      status: 'completed',
      upstream_status: 'completed',
      sync: true,
      output: { url: 'https://cdn.example/s.mp4', urls: ['https://cdn.example/s.mp4'] },
    }));
    const output = await submit.execute({ prompt: 'x', save_to: dir });
    assert.match(output, /已保存到本地/);
    const match = /- (.+\.mp4)/.exec(output);
    assert.ok(match, `回执里应有本地路径：${output}`);
    assert.equal(readFileSync(match[1]).toString(), 'SYNC-MP4');
    assert.doesNotMatch(output, /稍后用 workbuddy_video_status/);
  } finally {
    globalThis.fetch = original;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('查询工具：不给 save_to 时仍只回 URL，并提示可以直接落盘', async () => {
  const status = tool('workbuddy_video_status', async () => ({}), async () => ({
    status: 'completed',
    upstream_status: 'completed',
    output: { urls: ['https://cdn.example/v.mp4'] },
  }));
  const output = await status.execute({ id: 'task-1' });
  assert.match(output, /有时效/);
  assert.match(output, /https:\/\/cdn\.example\/v\.mp4/);
  assert.match(output, /save_to/);
});

test('查询工具：save_to 下载失败时不报错，退回 URL 并说明原因', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('nope', { status: 403 });
  try {
    const status = tool('workbuddy_video_status', async () => ({}), async () => ({
      status: 'completed',
      upstream_status: 'completed',
      output: { urls: ['https://cdn.example/v.mp4'] },
    }));
    const output = await status.execute({ id: 'task-1', save_to: 'C:/definitely/not/writable' });
    assert.doesNotMatch(output, /^视频.*失败：/, '落盘失败不该让整次查询看起来失败');
    assert.match(output, /https:\/\/cdn\.example\/v\.mp4/, '失败后仍应给出可临时访问的 URL');
  } finally {
    globalThis.fetch = original;
  }
});
