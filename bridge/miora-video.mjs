/**
 * WorkBuddy Miora 视频生成客户端。
 *
 * 底层（临时 key / 提交 / 轮询 / 图片归一）在 `miora-media-core.mjs`，与图片模块共用。
 * 本文件只负责视频的三种模式：文生视频、首尾帧、参考图。
 *
 * 临时 key 只放内存、按账号与 token 指纹缓存；不落盘、不进日志或响应。
 * 提交是计费动作，任何失败都不自动重试 —— 只有 401（请求未被受理）会换 key 重试一次。
 */
import {
  MioraMediaError,
  MAX_MEDIA_WAIT_MS,
  SUBMIT_TIMEOUT_MS,
  assertInlineInputBudget,
  isObject,
  isTerminalMediaStatus,
  mediaClientOptions,
  mediaPayload,
  mioraRequest,
  normalizeMediaEntry,
  pollMediaTask,
  recallSubmission,
  rememberSubmission,
  resolveImageInput,
  submissionScope,
} from './miora-media-core.mjs';

export const VIDEO_SUBMIT_PATH = '/api/ai/workbuddy-proxy/video/submit';
export const VIDEO_QUERY_PATH = '/api/ai/workbuddy-proxy/video/query-task';

/** 视频查询的长轮询上限（与图片共用同一套预算语义）。 */
export const MAX_VIDEO_WAIT_MS = MAX_MEDIA_WAIT_MS;

const invalid = (message) => new MioraMediaError('VIDEO_INVALID_INPUT', message, { status: 400 });

/*
 * 允许的顶层字段。**不接受未知字段**：拼错一个键（firstFrameImage / image / size）
 * 原先会被静默忽略 —— 请求退化成文生视频，图片没带上，但提交照样计费。
 * 这里宁可 400 也不猜。
 */
const VIDEO_INPUT_KEYS = new Set([
  'prompt',
  'mode',
  'duration',
  'seconds',
  'resolution',
  'aspect_ratio',
  'aspectRatio',
  'first_frame',
  'first_frame_path',
  'firstFrame',
  'input_reference',
  'last_frame',
  'last_frame_path',
  'lastFrame',
  'references',
  'reference_paths',
  'model', // 文档写明：不参与模型选择，接受但忽略
]);

/** 常见错写的指路牌（只说该用什么，不替用户猜意图）。 */
const KEY_HINTS = new Map([
  ['size', 'use resolution + aspect_ratio instead'],
  ['image', 'use first_frame or references instead'],
  ['reference_images', 'use references instead'],
  ['referenceImages', 'use references instead'],
  ['firstFrameImage', 'use first_frame instead'],
  ['lastFrameImage', 'use last_frame instead'],
  ['image_url', 'use first_frame or references instead'],
  ['n', 'one video per request; remove n'],
]);

function assertKnownKeys(input) {
  const unknown = Object.keys(input).filter((key) => !VIDEO_INPUT_KEYS.has(key));
  if (!unknown.length) return;
  const hinted = unknown.map((key) => (KEY_HINTS.has(key) ? `${key} (${KEY_HINTS.get(key)})` : key));
  throw invalid(`unknown field(s): ${hinted.join(', ')}. Accepted: ${[...VIDEO_INPUT_KEYS].join(', ')}.`);
}

/**
 * 取一个字符串字段（含别名）。
 * 出现但为空 / 类型不对时显式报错 —— 静默忽略会让图生视频悄悄变成文生视频。
 */
function pickString(input, keys, field) {
  // null / undefined 视为“没给”；空字符串才是显式错误（常见于变量没填）。
  const present = keys.filter((key) => Object.prototype.hasOwnProperty.call(input, key)
    && input[key] !== undefined && input[key] !== null);
  if (!present.length) return '';
  const provided = present.filter((key) => input[key] !== '');
  if (!provided.length) {
    throw invalid(`${field} is empty (${present.join('/')}); omit it instead of passing an empty value.`);
  }
  if (provided.length > 1) {
    throw invalid(`${field} is given more than once (${provided.join('/')}); pass only one.`);
  }
  const [key] = provided;
  const value = input[key];
  if (typeof value !== 'string') throw invalid(`${field} must be a string.`);
  if (!value.trim()) throw invalid(`${field} is empty.`);
  return value.trim();
}

function parseReferences(input) {
  const keys = ['references', 'reference_paths'].filter((key) => Object.prototype.hasOwnProperty.call(input, key)
    && input[key] !== undefined && input[key] !== null);
  if (!keys.length) return [];
  if (keys.length > 1) throw invalid('use either references or reference_paths, not both.');
  const [key] = keys;
  const value = input[key];
  if (!Array.isArray(value)) throw invalid(`${key} must be an array of image strings.`);
  return value.map((item, index) => {
    if (typeof item !== 'string' || !item.trim()) {
      throw invalid(`${key}[${index}] must be a non-empty string.`);
    }
    return item.trim();
  });
}

function optionalDuration(value) {
  if (value === undefined || value === null || value === '') return undefined;
  // Number(true) === 1：布尔值不能因为“能转成数字”就当成 1 秒提交。
  if (typeof value === 'boolean') {
    throw invalid('duration must be a positive integer number of seconds.');
  }
  const number = Number(value);
  if (!Number.isFinite(number) || !Number.isInteger(number) || number <= 0) {
    throw invalid('duration must be a positive integer number of seconds.');
  }
  return number;
}

function optionalString(value, field, limit = 64) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw invalid(`${field} must be a string.`);
  const text = value.trim();
  if (!text || text.length > limit) throw invalid(`${field} must be 1-${limit} characters.`);
  return text;
}

/** 大小写归一：上游认 `768P` / `2K`。未知取值原样透传（不替它发明新档位）。 */
const RESOLUTION_ALIASES = new Map([['768p', '768P'], ['2k', '2K']]);

function normalizeResolution(value) {
  const text = optionalString(value, 'resolution');
  if (!text) return undefined;
  return RESOLUTION_ALIASES.get(text.toLowerCase()) || text;
}

function normalizeAspectRatio(value) {
  const text = optionalString(value, 'aspect_ratio');
  if (!text) return undefined;
  const compact = text.replace(/\s*:\s*/g, ':');
  if (!/^[1-9]\d?:[1-9]\d?$/.test(compact)) {
    throw invalid('aspect_ratio must be a positive ratio like "16:9", "9:16" or "1:1".');
  }
  return compact;
}

/**
 * 校验并构造上游提交体。三种模式：
 *   text      = 纯提示词
 *   frame     = first_frame（可选 last_frame）
 *   reference = 一张或多张参考图
 * `input_reference` / `firstFrame` 是 first_frame 的别名（前者沿用 OpenAI 风格）。
 *
 * 校验原则：**能明确判错的都在本地 400**，绝不把「图片没带上」的请求当文生视频提交
 * （提交即计费）。上游才是时长/分辨率档位的权威，本地只归一写法、不擅自扩缩范围。
 */
export async function buildVideoSubmitBody(input, options = {}) {
  if (!isObject(input)) throw invalid('request body must be a JSON object.');
  assertKnownKeys(input);

  if (input.mode !== undefined && input.mode !== null && typeof input.mode !== 'string') {
    throw invalid('mode must be a string: text, frame or reference.');
  }
  const modeRaw = typeof input.mode === 'string' ? input.mode.trim().toLowerCase() : '';
  if (modeRaw && !['text', 'frame', 'reference'].includes(modeRaw)) {
    throw invalid('mode must be one of: text, frame, reference.');
  }

  const firstRaw = pickString(input, ['first_frame', 'first_frame_path', 'firstFrame', 'input_reference'], 'first_frame');
  const lastRaw = pickString(input, ['last_frame', 'last_frame_path', 'lastFrame'], 'last_frame');
  const references = parseReferences(input);

  const hasFrame = Boolean(firstRaw || lastRaw);
  const hasReferences = references.length > 0;
  const mode = modeRaw || (hasFrame ? 'frame' : (hasReferences ? 'reference' : 'text'));

  if (mode === 'text' && (hasFrame || hasReferences)) {
    throw invalid('mode "text" does not accept frames or references.');
  }
  if (mode === 'frame') {
    if (!firstRaw) throw invalid('frame mode requires first_frame (alias: input_reference); last_frame alone is not enough.');
    if (hasReferences) throw invalid('frame mode does not accept references.');
  }
  if (mode === 'reference') {
    if (!hasReferences) throw invalid('reference mode requires at least one references[] item.');
    if (hasFrame) throw invalid('reference mode does not accept first_frame/last_frame.');
  }

  if (input.prompt !== undefined && input.prompt !== null && typeof input.prompt !== 'string') {
    throw invalid('prompt must be a string.');
  }
  const promptRaw = typeof input.prompt === 'string' ? input.prompt.trim() : '';
  if ((mode === 'text' || mode === 'reference') && !promptRaw) {
    throw invalid(`prompt is required for ${mode} mode.`);
  }
  if (promptRaw.length > 8000) throw invalid('prompt is longer than 8000 characters.');

  const hasDuration = input.duration !== undefined && input.duration !== null;
  const hasSeconds = input.seconds !== undefined && input.seconds !== null;
  if (hasDuration && hasSeconds && Number(input.duration) !== Number(input.seconds)) {
    throw invalid('duration and seconds disagree; pass only one.');
  }
  const duration = optionalDuration(input.duration ?? input.seconds);
  const resolution = normalizeResolution(input.resolution);
  const hasAspectRatio = input.aspect_ratio !== undefined && input.aspect_ratio !== null;
  const hasCamelAspectRatio = input.aspectRatio !== undefined && input.aspectRatio !== null;
  if (hasAspectRatio && hasCamelAspectRatio
    && String(input.aspect_ratio).replace(/\s*:\s*/g, ':') !== String(input.aspectRatio).replace(/\s*:\s*/g, ':')) {
    throw invalid('aspect_ratio and aspectRatio disagree; pass only one.');
  }
  const aspectRatio = normalizeAspectRatio(input.aspect_ratio ?? input.aspectRatio);

  const body = {};
  if (promptRaw) body.prompt = promptRaw;
  if (duration !== undefined) body.duration = duration;
  if (resolution) body.resolution = resolution;
  if (aspectRatio) body.aspect_ratio = aspectRatio;

  if (mode === 'frame') {
    const first = await resolveImageInput(firstRaw, { ...options, fieldName: 'first_frame' });
    const frame = { first_frame_image: mediaPayload(first) };
    const resolved = [first];
    if (lastRaw) {
      const last = await resolveImageInput(lastRaw, { ...options, fieldName: 'last_frame' });
      frame.last_frame_image = mediaPayload(last);
      resolved.push(last);
    }
    assertInlineInputBudget(resolved, options.maxBodyBytes, { prefix: 'VIDEO', what: 'frame' });
    body.input = frame;
  } else if (mode === 'reference') {
    const resolved = [];
    for (let index = 0; index < references.length; index += 1) {
      resolved.push(await resolveImageInput(references[index], {
        ...options,
        fieldName: `references[${index}]`,
      }));
    }
    assertInlineInputBudget(resolved, options.maxBodyBytes, { prefix: 'VIDEO', what: 'frame' });
    body.input = { reference_images: resolved.map(mediaPayload) };
  }

  return { mode, body, prompt: promptRaw, duration, resolution, aspectRatio };
}

function normalizeResult({ id, data, entry, meta = null }) {
  // 状态归一、失败原因与产物地址都走共用实现：两处各写一份时，
  // 「status 是 FAILED 但 error 是 null」和「产物字段换了名字」都会只修好一边。
  return {
    ...normalizeMediaEntry({ id, data, entry, meta, object: 'video', defaultProvider: 'copilot-video' }),
    mode: meta?.mode ?? null,
    seconds: meta?.duration ?? null,
    resolution: meta?.resolution ?? null,
    aspect_ratio: meta?.aspectRatio ?? null,
    // 与图片一致：sync=true 表示结果已在提交响应里，不能按 id 再查。
    sync: meta?.sync === true,
  };
}

export async function submitVideo(auth, input, options = {}) {
  const opts = mediaClientOptions(options);
  const built = await buildVideoSubmitBody(input, {
    readFile: opts.readFile,
    maxBodyBytes: opts.maxBodyBytes,
  });
  const startedAt = opts.now();
  // 只有**通过本地校验、真要发上游**时才读余额：拼错参数不该先等一次余额请求。
  await options.onBeforeRequest?.();
  const data = await mioraRequest(auth, VIDEO_SUBMIT_PATH, built.body, {
    ...opts,
    timeoutMs: options.timeoutMs ?? SUBMIT_TIMEOUT_MS,
  });
  if (!isObject(data) || !data.upstreamTaskId) {
    throw new MioraMediaError('VIDEO_UPSTREAM', 'Miora video submit did not return an upstreamTaskId.', { status: 502 });
  }
  // 视频通常异步，但上游同样可能同步返回；处理方式与图片一致。
  const syncEntry = data.mode === 'sync'
    ? {
      status: data.status ?? 'failed',
      resultFiles: data.resultFiles ?? data.result_files,
      errorMessage: data.errorMessage ?? data.error_message ?? data.error ?? data.failReason,
    }
    : null;
  // 只有终态才值得缓存；非终态的 mode=sync 按异步任务处理，交给查询接口。
  const syncTerminal = Boolean(syncEntry && isTerminalMediaStatus(syncEntry.status));
  const meta = {
    kind: 'video',
    // 产物/失败原因只在当前账号下可查；切号后不能从缓存里读到别人的结果。
    account: submissionScope(auth),
    mode: built.mode,
    duration: built.duration,
    resolution: built.resolution,
    aspectRatio: built.aspectRatio,
    model: data.model ?? null,
    provider: data.provider ?? null,
    createdAt: Math.floor(startedAt / 1000),
    savedAt: Date.now(),
    sync: syncTerminal,
    ...(syncTerminal ? { syncEntry } : {}),
  };
  rememberSubmission(String(data.upstreamTaskId), meta);
  return normalizeResult({ id: data.upstreamTaskId, data, entry: syncEntry, meta });
}

/**
 * 查询任务；`waitMs > 0` 时由桥代客户端轮询（每 2 秒），直到终态或预算用完。
 * 查询不计费，重复查询安全；超时返回最后一次状态，不是失败。
 */
export async function queryVideo(auth, id, options = {}) {
  const taskId = typeof id === 'string' ? id.trim() : '';
  const remembered = taskId ? recallSubmission(taskId, submissionScope(auth)) : null;
  if (remembered?.kind === 'video' && remembered.syncEntry) {
    return normalizeResult({
      id: taskId,
      data: { upstreamTaskId: taskId },
      entry: remembered.syncEntry,
      meta: remembered,
    });
  }
  return pollMediaTask(auth, id, {
    ...options,
    queryPath: VIDEO_QUERY_PATH,
    prefix: 'VIDEO',
    label: 'video',
    normalize: ({ id: taskId, entry, meta }) => normalizeResult({
      id: taskId,
      data: { upstreamTaskId: taskId },
      entry,
      meta,
    }),
  });
}

// 兼容既有导入：桥 / 测试 / 文档都按 miora-video 的旧名取这些能力。
export {
  DEFAULT_MIORA_BASE,
  MioraVideoError,
  normalizeVideoStatus,
  resetTempKeyCache,
  resolveImageInput,
} from './miora-media-core.mjs';
