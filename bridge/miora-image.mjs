/**
 * WorkBuddy Miora 图片生成客户端（文生图 / 图生图）。
 *
 * 上游（从桌面端 miora MCP 的 dist/cli.cjs 反查）：
 *   POST /api/ai/workbuddy-proxy/image/generate/submit  { prompt, size?, quality? }
 *   POST /api/ai/workbuddy-proxy/image/edit/submit      { prompt, images[], size? }
 *   POST /api/ai/workbuddy-proxy/image/query-task       { upstreamTaskIds: [id] }
 *
 * 与视频共用 miora-media-core（临时 key / 提交 / 401 重试 / 错误映射 / 长轮询）。
 * 提交是计费动作：本地校验宁可 400，也不把「图片没带上」的请求当文生图提交。
 */
import {
  MAX_MEDIA_WAIT_MS,
  MioraMediaError,
  SUBMIT_TIMEOUT_MS,
  assertInlineInputBudget,
  invalidInput,
  isObject,
  mediaClientOptions,
  mediaPayload,
  mioraRequest,
  normalizeMediaEntry,
  pollMediaTask,
  recallSubmission,
  rememberSubmission,
  resolveImageInput,
} from './miora-media-core.mjs';

export const IMAGE_GENERATE_PATH = '/api/ai/workbuddy-proxy/image/generate/submit';
export const IMAGE_EDIT_PATH = '/api/ai/workbuddy-proxy/image/edit/submit';
export const IMAGE_QUERY_PATH = '/api/ai/workbuddy-proxy/image/query-task';

/** 图片查询的长轮询上限（与视频一致：60 秒 / 2 秒间隔）。 */
export const MAX_IMAGE_WAIT_MS = MAX_MEDIA_WAIT_MS;

// 官方 miora MCP 的 MAX_IMAGE_BYTES：图片输入单张 20 MB（视频帧是 10 MB）。
const IMAGE_INPUT_MAX_BYTES = 20 * 1024 * 1024;
const INVALID = 'IMAGE_INVALID_INPUT';
const invalid = (message) => invalidInput('IMAGE', message);

/*
 * 允许的顶层字段。未知字段一律 400：拼错 `images` 或误传 `aspect_ratio`
 * 若被静默忽略，就会用错的参数提交并计费。
 */
const IMAGE_INPUT_KEYS = new Set([
  'prompt',
  'mode',
  'size',
  'quality',
  'images',
  'image',
  'model', // 接受但忽略（选模型由 Miora 决定）
]);

const KEY_HINTS = new Map([
  ['aspect_ratio', 'use size (e.g. "1024x1024") instead'],
  ['aspectRatio', 'use size (e.g. "1024x1024") instead'],
  ['width', 'use size (e.g. "1024x1024") instead'],
  ['height', 'use size (e.g. "1024x1024") instead'],
  ['image_url', 'use images[] instead'],
  ['image_path', 'use images[] instead'],
  ['image_paths', 'use images[] instead'],
  ['image_urls', 'use images[] instead'],
  ['n', 'one image per request; remove n'],
]);

function assertKnownKeys(input) {
  const unknown = Object.keys(input).filter((key) => !IMAGE_INPUT_KEYS.has(key));
  if (!unknown.length) return;
  const hinted = unknown.map((key) => (KEY_HINTS.has(key) ? `${key} (${KEY_HINTS.get(key)})` : key));
  throw invalid(`unknown field(s): ${hinted.join(', ')}. Accepted: ${[...IMAGE_INPUT_KEYS].join(', ')}.`);
}

function optionalString(value, field, limit = 64) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw invalid(`${field} must be a string.`);
  const text = value.trim();
  if (!text || text.length > limit) throw invalid(`${field} must be 1-${limit} characters.`);
  return text;
}

/** `size` 统一成小写 `宽x高`；上游认 `1024x1024` / `1024x768` 这类形状。 */
function normalizeSize(value) {
  const text = optionalString(value, 'size');
  if (!text) return undefined;
  const compact = text.replace(/\s+/g, '').toLowerCase();
  const match = /^(\d{2,5})x(\d{2,5})$/.exec(compact);
  if (!match || Number(match[1]) <= 0 || Number(match[2]) <= 0) {
    throw invalid('size must look like "1024x1024" (WIDTHxHEIGHT).');
  }
  return compact;
}

function parseImages(input) {
  const hasImages = input.images !== undefined && input.images !== null;
  const hasSingle = input.image !== undefined && input.image !== null;
  if (hasImages && hasSingle) throw invalid('use either images[] or image, not both.');
  if (hasSingle) {
    if (typeof input.image !== 'string' || !input.image.trim()) {
      throw invalid('image must be a non-empty string.');
    }
    return [input.image.trim()];
  }
  if (!hasImages) return [];
  if (!Array.isArray(input.images)) throw invalid('images must be an array of image strings.');
  return input.images.map((item, index) => {
    if (typeof item !== 'string' || !item.trim()) {
      throw invalid(`images[${index}] must be a non-empty string.`);
    }
    return item.trim();
  });
}

/**
 * 校验并构造上游提交体。
 *
 * mode 可显式传 `generate` / `edit`；不传时按是否带 images 推断。
 * 图片输入支持：绝对本地路径、miora fileKey、公网 https URL、base64 data URI（≤ 20 MB）。
 */
export async function buildImageSubmitBody(input, options = {}) {
  if (!isObject(input)) throw invalid('request body must be a JSON object.');
  assertKnownKeys(input);

  if (input.mode !== undefined && input.mode !== null && typeof input.mode !== 'string') {
    throw invalid('mode must be a string: generate or edit.');
  }
  const modeRaw = typeof input.mode === 'string' ? input.mode.trim().toLowerCase() : '';
  if (modeRaw && !['generate', 'edit'].includes(modeRaw)) {
    throw invalid('mode must be one of: generate, edit.');
  }

  const images = parseImages(input);
  const mode = modeRaw || (images.length > 0 ? 'edit' : 'generate');
  if (mode === 'generate' && images.length > 0) {
    throw invalid('mode "generate" does not accept images; use mode "edit".');
  }
  if (mode === 'edit' && images.length === 0) {
    throw invalid('edit mode requires at least one images[] item.');
  }

  if (input.prompt !== undefined && input.prompt !== null && typeof input.prompt !== 'string') {
    throw invalid('prompt must be a string.');
  }
  const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
  if (!prompt) throw invalid('prompt is required.');
  if (prompt.length > 8000) throw invalid('prompt is longer than 8000 characters.');

  const size = normalizeSize(input.size);
  const quality = optionalString(input.quality, 'quality', 32);

  const body = { prompt };
  if (size) body.size = size;
  // quality 只对文生图有意义；改图时上游 schema 没有这个字段，不传。
  if (quality && mode === 'generate') body.quality = quality;

  if (mode === 'edit') {
    const resolved = [];
    for (let index = 0; index < images.length; index += 1) {
      resolved.push(await resolveImageInput(images[index], {
        ...options,
        fieldName: `images[${index}]`,
        maxBytes: IMAGE_INPUT_MAX_BYTES,
        invalidCode: INVALID,
      }));
    }
    assertInlineInputBudget(resolved, options.maxBodyBytes, { prefix: 'IMAGE', what: 'image' });
    body.images = resolved.map(mediaPayload);
  }

  return {
    mode, body, prompt, size, quality, imageCount: images.length,
  };
}

function normalizeResult({ id, data, entry, meta = null }) {
  // 与视频共用同一套状态/失败原因/产物归一（见 normalizeMediaEntry 的注释）。
  return {
    ...normalizeMediaEntry({ id, data, entry, meta, object: 'image', defaultProvider: 'copilot-image' }),
    mode: meta?.mode ?? null,
    size: meta?.size ?? null,
    // 图生图时上游 schema 没有 quality，别回显一个“看起来生效了”的值。
    quality: meta?.mode === 'edit' ? null : (meta?.quality ?? null),
    // 上游 `mode:"sync"`：结果已经在提交响应里，不能当异步任务再查。
    sync: meta?.sync === true,
  };
}

export async function submitImage(auth, input, options = {}) {
  const opts = mediaClientOptions({ ...options, prefix: 'IMAGE' });
  const built = await buildImageSubmitBody(input, {
    readFile: opts.readFile,
    maxBodyBytes: opts.maxBodyBytes,
  });
  const startedAt = opts.now();
  const path = built.mode === 'edit' ? IMAGE_EDIT_PATH : IMAGE_GENERATE_PATH;
  // 只有**通过本地校验、真要发上游**时才读余额：拼错参数不该先等一次余额请求。
  await options.onBeforeRequest?.();
  const data = await mioraRequest(auth, path, built.body, {
    ...opts,
    timeoutMs: options.timeoutMs ?? SUBMIT_TIMEOUT_MS,
  });
  if (!isObject(data) || !data.upstreamTaskId) {
    throw new MioraMediaError('IMAGE_UPSTREAM', 'Miora image submit did not return an upstreamTaskId.', { status: 502 });
  }
  /*
   * 上游有时会同步跑完（image 实测常见）：结果只在 submit 响应里，按 id 查询
   * 会得到 `INVALID_TASK_ID_FOR_SYNC_MODE`。这里把终态存进提交元数据缓存，
   * 让「提交 → 查询」和「/content」在同一桥进程内仍然拿得到真实结果。
   */
  const syncEntry = data.mode === 'sync'
    ? {
      status: data.status ?? 'failed',
      resultFiles: data.resultFiles ?? data.result_files,
      errorMessage: data.errorMessage ?? data.error_message ?? data.error ?? data.failReason,
    }
    : null;
  const meta = {
    kind: 'image',
    mode: built.mode,
    size: built.size,
    // 图生图上游 schema 没有 quality；连元数据都不记，避免以后又回显成“已生效”。
    quality: built.mode === 'edit' ? null : built.quality,
    model: data.model ?? null,
    provider: data.provider ?? null,
    createdAt: Math.floor(startedAt / 1000),
    savedAt: Date.now(),
    sync: Boolean(syncEntry),
    ...(syncEntry ? { syncEntry } : {}),
  };
  rememberSubmission(String(data.upstreamTaskId), meta);
  return normalizeResult({ id: data.upstreamTaskId, data, entry: syncEntry, meta });
}

/** 查询图片任务；`waitMs > 0` 时由桥代轮询。查询不计费。 */
export async function queryImage(auth, id, options = {}) {
  const taskId = typeof id === 'string' ? id.trim() : '';
  /*
   * 同步完成的任务上游不保存，查询只会返回伪失败。优先用提交时缓存的终态
   * （含产物/失败原因）；缓存过期或桥重启后才落到上游的“查不到”提示。
   */
  const remembered = taskId ? recallSubmission(taskId) : null;
  if (remembered?.kind === 'image' && remembered.syncEntry) {
    return normalizeResult({
      id: taskId,
      data: { upstreamTaskId: taskId },
      entry: remembered.syncEntry,
      meta: remembered,
    });
  }
  return pollMediaTask(auth, id, {
    ...options,
    queryPath: IMAGE_QUERY_PATH,
    prefix: 'IMAGE',
    label: 'image',
    normalize: ({ id: taskId, entry, meta }) => normalizeResult({
      id: taskId,
      data: { upstreamTaskId: taskId },
      entry,
      meta,
    }),
  });
}
