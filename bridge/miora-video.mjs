/**
 * WorkBuddy Miora 视频生成客户端。
 *
 * 上游链路（从桌面端 miora MCP 的 dist/cli.cjs 反查并实测）：
 *   1. 用当前登录 token 调 `<chat endpoint>/v2/api-keys`，
 *      申请名为 workbuddy-connect-cloud-service 的 15 分钟临时 key（ck_t_…）；
 *   2. 以 Bearer 临时 key 调 `public.miora.qq.com/api/ai/workbuddy-proxy/video/*`。
 *
 * 临时 key 只放内存、按账号与 token 指纹缓存；不落盘、不进日志或响应。
 * 提交是计费动作，任何失败都不自动重试 —— 只有 401（请求未被受理）会换 key 重试一次。
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, isAbsolute } from 'node:path';

export const DEFAULT_MIORA_BASE = 'https://public.miora.qq.com';
export const VIDEO_SUBMIT_PATH = '/api/ai/workbuddy-proxy/video/submit';
export const VIDEO_QUERY_PATH = '/api/ai/workbuddy-proxy/video/query-task';

const CLIENT_TEMP_KEY_PATH = '/v2/api-keys';
const CLIENT_TEMP_KEY_NAME = 'workbuddy-connect-cloud-service';
const TEMP_KEY_TTL_MS = 15 * 60 * 1000;
const TEMP_KEY_REFRESH_SKEW_MS = 60 * 1000;
const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const TEMP_KEY_TIMEOUT_MS = 10_000;
// 与官方 miora MCP 的 MIORA_SUBMIT_HTTP_TIMEOUT_MS 一致：提交接口是异步的，
// 正常几秒返回；把预算放足，避免上游慢时桥先放弃、任务 id 丢失却已计费。
const SUBMIT_TIMEOUT_MS = 390_000;
const QUERY_TIMEOUT_MS = 30_000;

// 长轮询：`GET /v1/videos/{id}?wait=N` 由桥代客户端轮询，避免 agent 每两秒打一次。
// 上限 60 秒（工具侧还会留出单次查询的超时余量），间隔 2 秒。
export const MAX_VIDEO_WAIT_MS = 60_000;
const QUERY_POLL_INTERVAL_MS = 2_000;

/*
 * 提交元数据的**内存**缓存：mode / seconds / resolution / created_at 只有提交时才知道，
 * 上游查询接口不返回。存它只是为了让「提交 → 查询」前后字段一致，不是持久化：
 * 不含 prompt、不落盘，桥重启后自然丢失（文档写明是 best-effort）。
 */
const META_TTL_MS = 6 * 60 * 60 * 1000;
const META_MAX_ENTRIES = 500;

const EXT_TO_MIME = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.bmp', 'image/bmp'],
  ['.svg', 'image/svg+xml'],
]);

const FILE_KEY_RE = /^(?:bga|file)\//;

export class MioraVideoError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'MioraVideoError';
    this.code = code;
    this.status = options.status ?? 502;
    this.retryAfter = options.retryAfter ?? null;
    this.upstreamCode = options.upstreamCode ?? null;
  }
}

const invalid = (message) => new MioraVideoError('VIDEO_INVALID_INPUT', message, { status: 400 });

function shortMessage(value, limit = 300) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function trimSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function normalizeVideoStatus(status) {
  switch (String(status || '').toLowerCase()) {
    case 'pending':
    case 'queued':
      return 'queued';
    case 'processing':
    case 'in_progress':
    case 'running':
      return 'in_progress';
    case 'completed':
    case 'succeeded':
      return 'completed';
    case 'failed':
    case 'error':
      return 'failed';
    case 'cancelled':
    case 'canceled':
      return 'cancelled';
    default:
      return 'in_progress';
  }
}

function mediaPayload(resolved) {
  if (resolved.origin === 'url') return { url: resolved.url };
  if (resolved.origin === 'fileKey') return { file_key: resolved.fileKey };
  return { base64: resolved.base64 };
}

function isPrivateIpv4(host) {
  const parts = host.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 10
    || parts[0] === 127
    || (parts[0] === 169 && parts[1] === 254)
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168)
    || parts[0] === 0;
}

function publicHttpsUrl(raw, field) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw invalid(`${field} is not a valid URL.`);
  }
  if (url.protocol !== 'https:') throw invalid(`${field} must be a public https URL.`);
  if (url.username || url.password) throw invalid(`${field} must not contain credentials.`);
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.local') || host === '::1'
    || /^(?:fc|fd|fe8|fe9|fea|feb)/.test(host) || isPrivateIpv4(host)) {
    throw invalid(`${field} must be a public https URL (private/reserved hosts are rejected).`);
  }
  return url.toString();
}

function safeFileKey(raw, field) {
  const segments = raw.split('/').slice(1);
  if (segments.length === 0 || segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw invalid(`${field} is a miora fileKey with path-traversal segments.`);
  }
  return raw;
}

function parseDataUri(raw, field) {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(raw);
  if (!match) throw invalid(`${field} is not a valid data URI.`);
  if (!match[2]) throw invalid(`${field} data URI must use ;base64 encoding.`);
  const mimeType = match[1]?.trim();
  if (mimeType && !/^image\//i.test(mimeType)) {
    throw invalid(`${field} data URI must be an image/* type (got ${mimeType}).`);
  }
  const payload = match[3] ?? '';
  const buffer = Buffer.from(payload, 'base64');
  if (buffer.length === 0) throw invalid(`${field} data URI has an empty payload.`);
  if (buffer.length > IMAGE_MAX_BYTES) {
    throw invalid(`${field} exceeds ${IMAGE_MAX_BYTES}B (${buffer.length}B).`);
  }
  return { origin: 'dataUri', base64: payload, mimeType: mimeType || undefined };
}

/**
 * 把图片输入归一成上游 media payload。
 * 支持：绝对本地路径、miora fileKey（bga/… 或 file/…）、公网 https URL、base64 data URI。
 */
export async function resolveImageInput(raw, options = {}) {
  const field = options.fieldName || 'image';
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) throw invalid(`${field} is empty.`);
  if (text.startsWith('data:')) return parseDataUri(text, field);
  if (/^https?:\/\//i.test(text)) return { origin: 'url', url: publicHttpsUrl(text, field) };
  if (FILE_KEY_RE.test(text)) return { origin: 'fileKey', fileKey: safeFileKey(text, field) };
  if (!isAbsolute(text)) {
    throw invalid(`${field} must be an absolute local path, miora fileKey, public https URL, or data URI.`);
  }
  const buffer = await (options.readFile || readFile)(text).catch((err) => {
    throw invalid(`${field} could not be read: ${text} (${err.message})`);
  });
  if (buffer.length === 0) throw invalid(`${field} is empty: ${text}`);
  if (buffer.length > IMAGE_MAX_BYTES) {
    throw invalid(`${field} exceeds ${IMAGE_MAX_BYTES}B (${buffer.length}B): ${text}`);
  }
  const mimeType = EXT_TO_MIME.get(extname(text).toLowerCase());
  if (!mimeType) throw invalid(`${field} has an unsupported image extension: ${text}`);
  return { origin: 'path', base64: buffer.toString('base64'), mimeType };
}

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

/** 大小写归一：上游认 `768P` / `2K`。未知取值原样透传，由上游判定（不替它发明新档位）。 */
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
    if (lastRaw) {
      const last = await resolveImageInput(lastRaw, { ...options, fieldName: 'last_frame' });
      frame.last_frame_image = mediaPayload(last);
    }
    body.input = frame;
  } else if (mode === 'reference') {
    const resolved = [];
    for (let index = 0; index < references.length; index += 1) {
      resolved.push(await resolveImageInput(references[index], {
        ...options,
        fieldName: `references[${index}]`,
      }));
    }
    body.input = { reference_images: resolved.map(mediaPayload) };
  }

  return { mode, body, prompt: promptRaw, duration, resolution, aspectRatio };
}

function unwrapEnvelope(body) {
  if (isObject(body) && 'code' in body && 'failed' in body && 'data' in body) return body.data;
  return body;
}

function bodyFailure(body) {
  if (!isObject(body)) return null;
  if (body.failed === true) return body;
  if (typeof body.message === 'string') {
    try {
      const inner = JSON.parse(body.message);
      if (isObject(inner) && inner.failed === true) return inner;
    } catch { /* 不是嵌套 JSON */ }
  }
  return null;
}

function retryAfterSeconds(headers) {
  const raw = headers?.get?.('retry-after');
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.floor(seconds);
  const at = Date.parse(raw);
  if (!Number.isFinite(at)) return null;
  const delta = Math.ceil((at - Date.now()) / 1000);
  return delta > 0 ? delta : null;
}

function statusFromMessage(message) {
  const match = /\bstatus=(\d{3})\b/.exec(String(message || ''));
  return match ? Number(match[1]) : 0;
}

function upstreamFailure(status, body, path, retryAfter = null) {
  const code = body?.code ?? body?.error?.code ?? null;
  const message = shortMessage(body?.message ?? body?.msg ?? body?.error?.message) || `Miora ${path} failed (HTTP ${status}).`;
  /*
   * Miora 的 submit 代理有时用外层 2xx/5xx 包住上游的业务错误，
   * 真正的状态码只写在 message 里：`upstream video-submit failed: status=400 ...`。
   * 不解析它就会把「时长/分辨率不支持」这种明确的 400 误报成 502。
   * 外层 401/403/429 是网关自己的鉴权/限流，优先保留，不去猜内层。
   */
  const embeddedStatus = statusFromMessage(message);
  const effectiveStatus = embeddedStatus
    && (status >= 500 || (status >= 200 && status < 300))
    ? embeddedStatus
    : status;
  if (effectiveStatus === 401) {
    return new MioraVideoError('VIDEO_AUTH', 'Miora rejected the temporary key. Check the current login and retry.', {
      status: 401,
      upstreamCode: code,
    });
  }
  if (effectiveStatus === 403) {
    return new MioraVideoError('VIDEO_SCOPE_DENIED', message, { status: 403, upstreamCode: code });
  }
  if (effectiveStatus === 429) {
    return new MioraVideoError('VIDEO_RATE_LIMITED', message, {
      status: 429,
      retryAfter,
      upstreamCode: code,
    });
  }
  if (effectiveStatus === 400 || effectiveStatus === 422) {
    return new MioraVideoError('VIDEO_UPSTREAM_REJECTED', message, { status: 400, upstreamCode: code });
  }
  return new MioraVideoError('VIDEO_UPSTREAM', message, { status: 502, upstreamCode: code });
}

const tempKeyCache = new Map();
const tempKeyPending = new Map();

function cacheKeyFor(auth) {
  const fingerprint = createHash('sha256').update(String(auth?.access || '')).digest('hex').slice(0, 16);
  return `${trimSlash(auth?.endpoint)}|${auth?.userId || auth?.uid || ''}|${fingerprint}`;
}

export function resetTempKeyCache() {
  tempKeyCache.clear();
  tempKeyPending.clear();
  // 单元测试共用它做隔离；提交元数据也必须一起清，否则用例之间会串。
  submissionMeta.clear();
}

function parseExpiry(value, fallback) {
  const text = String(value ?? '').trim();
  if (!text) return fallback;
  const asDate = Date.parse(text);
  if (Number.isFinite(asDate)) return asDate;
  const asNumber = Number(text);
  if (Number.isFinite(asNumber) && asNumber > 0) {
    return asNumber < 1e12 ? asNumber * 1000 : asNumber;
  }
  return fallback;
}

async function requestClientTempKey(auth, options) {
  const endpoint = trimSlash(auth?.endpoint);
  if (!endpoint) throw new MioraVideoError('VIDEO_AUTH', 'no upstream endpoint for the current login.', { status: 401 });
  const url = `${endpoint}${CLIENT_TEMP_KEY_PATH}`;
  const now = options.now();
  let response;
  try {
    response = await options.fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${auth.access}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: CLIENT_TEMP_KEY_NAME,
        expire_in_seconds: 900,
        temporary: true,
      }),
      signal: AbortSignal.timeout(options.timeoutMs ?? TEMP_KEY_TIMEOUT_MS),
    });
  } catch (err) {
    throw new MioraVideoError('VIDEO_UNAVAILABLE', `could not reach the WorkBuddy gateway: ${shortMessage(err.message)}`, { status: 502 });
  }
  let body = null;
  try { body = await response.json(); } catch { /* 非 JSON 按下述错误处理 */ }
  const key = body?.data?.key;
  if (!response.ok || body?.code !== 0 || typeof key !== 'string' || !key.startsWith('ck_t_')) {
    const message = shortMessage(body?.msg ?? body?.message)
      || `could not obtain a temporary Miora key (HTTP ${response.status}).`;
    if (response.status === 429) {
      throw new MioraVideoError('VIDEO_RATE_LIMITED', message, {
        status: 429,
        retryAfter: retryAfterSeconds(response.headers),
        upstreamCode: body?.code ?? null,
      });
    }
    if (response.status === 403) {
      throw new MioraVideoError('VIDEO_SCOPE_DENIED', message, {
        status: 403,
        upstreamCode: body?.code ?? null,
      });
    }
    throw new MioraVideoError('VIDEO_AUTH', message, {
      status: response.status === 401 ? 401 : 502,
      upstreamCode: body?.code ?? null,
    });
  }
  return {
    key,
    expiresAt: parseExpiry(body?.data?.expires_at, now + TEMP_KEY_TTL_MS),
  };
}

async function getTempKey(auth, options) {
  const cacheKey = cacheKeyFor(auth);
  const cached = tempKeyCache.get(cacheKey);
  if (cached && cached.expiresAt - TEMP_KEY_REFRESH_SKEW_MS > options.now()) return cached.key;

  let pending = tempKeyPending.get(cacheKey);
  if (!pending) {
    pending = requestClientTempKey(auth, options)
      .then((entry) => {
        tempKeyCache.set(cacheKey, entry);
        return entry.key;
      })
      .finally(() => { tempKeyPending.delete(cacheKey); });
    tempKeyPending.set(cacheKey, pending);
  }
  return pending;
}

async function mioraPost(auth, path, body, options, retried = false) {
  const base = trimSlash(options.baseUrl || DEFAULT_MIORA_BASE);
  const tempKey = await getTempKey(auth, options);
  let response;
  try {
    response = await options.fetchImpl(`${base}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tempKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeoutMs ?? QUERY_TIMEOUT_MS),
    });
  } catch (err) {
    throw new MioraVideoError('VIDEO_UNAVAILABLE', `Miora is unreachable: ${shortMessage(err.message)}`, { status: 502 });
  }

  const text = await response.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }

  if (response.status === 401 && !retried) {
    tempKeyCache.delete(cacheKeyFor(auth));
    return mioraPost(auth, path, body, options, true);
  }
  if (!response.ok) {
    throw upstreamFailure(response.status, parsed ?? { message: text }, path, retryAfterSeconds(response.headers));
  }
  if (!isObject(parsed)) {
    throw new MioraVideoError('VIDEO_UPSTREAM', `Miora ${path} returned a non-JSON body.`, { status: 502 });
  }
  const failed = bodyFailure(parsed);
  if (failed) throw upstreamFailure(Number(failed.httpStatus) || response.status, failed, path);
  // 有些网关用 HTTP 200 + 非 0 code 表达失败（没有 failed 字段）；不能当成成功解包。
  if (typeof parsed.code === 'number' && parsed.code !== 0) {
    throw upstreamFailure(Number(parsed.httpStatus) || response.status, parsed, path);
  }
  return unwrapEnvelope(parsed);
}

const submissionMeta = new Map();

/** 记住一次提交的元数据（仅供同进程内的查询回填；不含 prompt）。 */
function rememberSubmission(id, meta) {
  if (!id) return;
  submissionMeta.delete(id);
  submissionMeta.set(id, meta);
  while (submissionMeta.size > META_MAX_ENTRIES) {
    const oldest = submissionMeta.keys().next().value;
    submissionMeta.delete(oldest);
  }
}

function recallSubmission(id) {
  const meta = submissionMeta.get(id);
  if (!meta) return null;
  // TTL 用真实时钟：`now` 是可注入的（测试用来固定 created_at），不该影响缓存寿命。
  if (Date.now() - meta.savedAt > META_TTL_MS) {
    submissionMeta.delete(id);
    return null;
  }
  return meta;
}

function normalizeResult({ id, data, entry, meta = null }) {
  const rawStatus = String(entry?.status ?? data?.status ?? 'pending');
  const files = Array.isArray(entry?.resultFiles)
    ? entry.resultFiles
    : (Array.isArray(data?.resultFiles) ? data.resultFiles : []);
  const urls = files
    .map((file) => (isObject(file) ? (file.signedUrl || file.url) : ''))
    .filter((value) => typeof value === 'string' && /^https:\/\//i.test(value));
  const failed = entry?.status === 'failed' || entry?.status === 'cancelled';
  const errorMessage = failed ? (entry?.errorMessage ?? `Miora task ${rawStatus}.`) : '';

  return {
    id: String(data?.upstreamTaskId || id || ''),
    object: 'video',
    status: normalizeVideoStatus(rawStatus),
    upstream_status: rawStatus,
    created_at: meta?.createdAt ?? null,
    model: data?.model ?? meta?.model ?? null,
    provider: data?.provider ?? meta?.provider ?? 'copilot-video',
    mode: meta?.mode ?? null,
    seconds: meta?.duration ?? null,
    resolution: meta?.resolution ?? null,
    aspect_ratio: meta?.aspectRatio ?? null,
    result_files: files,
    output: urls.length ? { url: urls[0], urls } : null,
    error: errorMessage ? { message: shortMessage(errorMessage) } : null,
  };
}

function clientOptions(options = {}) {
  return {
    fetchImpl: options.fetchImpl || fetch,
    now: options.now || Date.now,
    baseUrl: options.baseUrl || DEFAULT_MIORA_BASE,
    timeoutMs: options.timeoutMs,
    readFile: options.readFile,
  };
}

export async function submitVideo(auth, input, options = {}) {
  const opts = clientOptions(options);
  const built = await buildVideoSubmitBody(input, { readFile: opts.readFile });
  const startedAt = opts.now();
  const data = await mioraPost(auth, VIDEO_SUBMIT_PATH, built.body, {
    ...opts,
    timeoutMs: options.timeoutMs ?? SUBMIT_TIMEOUT_MS,
  });
  if (!isObject(data) || !data.upstreamTaskId) {
    throw new MioraVideoError('VIDEO_UPSTREAM', 'Miora video submit did not return an upstreamTaskId.', { status: 502 });
  }
  const entry = data.mode === 'sync'
    ? {
      status: data.status ?? 'failed',
      resultFiles: data.resultFiles,
      errorMessage: data.errorMessage,
    }
    : null;
  const meta = {
    mode: built.mode,
    duration: built.duration,
    resolution: built.resolution,
    aspectRatio: built.aspectRatio,
    model: data.model ?? null,
    provider: data.provider ?? null,
    createdAt: Math.floor(startedAt / 1000),
    savedAt: Date.now(),
  };
  rememberSubmission(String(data.upstreamTaskId), meta);
  return normalizeResult({ id: data.upstreamTaskId, data, entry, meta });
}

/**
 * 查询任务；`waitMs > 0` 时由桥代客户端轮询（每 2 秒），直到终态或预算用完。
 * 查询不计费，重复查询安全；超时返回最后一次状态，不是失败。
 */
export async function queryVideo(auth, id, options = {}) {
  const taskId = typeof id === 'string' ? id.trim() : '';
  if (!taskId) throw invalid('video id is required.');
  const opts = clientOptions(options);
  const waitMs = Math.min(Math.max(Number(options.waitMs) || 0, 0), MAX_VIDEO_WAIT_MS);
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const attempts = waitMs > 0 ? Math.ceil(waitMs / QUERY_POLL_INTERVAL_MS) + 1 : 1;

  let last = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const data = await mioraPost(auth, VIDEO_QUERY_PATH, { upstreamTaskIds: [taskId] }, opts);
    const entry = isObject(data) ? data[taskId] : null;
    if (!isObject(entry)) {
      throw new MioraVideoError('VIDEO_NOT_FOUND', `Miora has no video task ${taskId}.`, { status: 404 });
    }
    last = normalizeResult({
      id: taskId,
      data: { upstreamTaskId: taskId },
      entry,
      meta: recallSubmission(taskId),
    });
    const terminal = last.status === 'completed' || last.status === 'failed' || last.status === 'cancelled';
    if (terminal || attempt === attempts - 1) return last;
    // 最后一段可能不足一个轮询间隔：别让 wait=1 实际等了 2 秒。
    const remaining = waitMs - attempt * QUERY_POLL_INTERVAL_MS;
    await sleep(Math.max(0, Math.min(QUERY_POLL_INTERVAL_MS, remaining)));
  }
  return last;
}
