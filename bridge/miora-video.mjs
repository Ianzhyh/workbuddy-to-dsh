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
  const payload = match[3] ?? '';
  const buffer = Buffer.from(payload, 'base64');
  if (buffer.length === 0) throw invalid(`${field} data URI has an empty payload.`);
  if (buffer.length > IMAGE_MAX_BYTES) {
    throw invalid(`${field} exceeds ${IMAGE_MAX_BYTES}B (${buffer.length}B).`);
  }
  return { origin: 'dataUri', base64: payload, mimeType: match[1]?.trim() || undefined };
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

function stringList(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === 'string' && item.trim() !== '').map((item) => item.trim());
}

function optionalNumber(value, field) {
  if (value === undefined || value === null) return undefined;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw invalid(`${field} must be a positive number.`);
  return number;
}

function optionalString(value, field, limit = 64) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw invalid(`${field} must be a string.`);
  const text = value.trim();
  if (!text || text.length > limit) throw invalid(`${field} must be 1-${limit} characters.`);
  return text;
}

/**
 * 校验并构造上游提交体。三种模式：
 *   text      = 纯提示词
 *   frame     = first_frame（可选 last_frame）
 *   reference = 一张或多张参考图
 * `input_reference` 是 first_frame 的 OpenAI 风格别名。
 */
export async function buildVideoSubmitBody(input, options = {}) {
  if (!isObject(input)) throw invalid('request body must be a JSON object.');

  const modeRaw = typeof input.mode === 'string' ? input.mode.trim().toLowerCase() : '';
  if (modeRaw && !['text', 'frame', 'reference'].includes(modeRaw)) {
    throw invalid('mode must be one of: text, frame, reference.');
  }

  const firstRaw = [input.first_frame, input.first_frame_path, input.input_reference]
    .find((value) => typeof value === 'string' && value.trim() !== '');
  const lastRaw = [input.last_frame, input.last_frame_path]
    .find((value) => typeof value === 'string' && value.trim() !== '');
  const references = stringList(input.references).length
    ? stringList(input.references)
    : stringList(input.reference_paths);

  const hasFrame = Boolean(firstRaw || lastRaw);
  const hasReferences = references.length > 0;
  const mode = modeRaw || (hasFrame ? 'frame' : (hasReferences ? 'reference' : 'text'));

  if (mode === 'text' && (hasFrame || hasReferences)) {
    throw invalid('mode "text" does not accept frames or references.');
  }
  if (mode === 'frame') {
    if (!firstRaw) throw invalid('frame mode requires first_frame (alias: input_reference).');
    if (hasReferences) throw invalid('frame mode does not accept references.');
  }
  if (mode === 'reference') {
    if (!hasReferences) throw invalid('reference mode requires at least one references[] item.');
    if (hasFrame) throw invalid('reference mode does not accept first_frame/last_frame.');
  }

  const promptRaw = typeof input.prompt === 'string' ? input.prompt.trim() : '';
  if ((mode === 'text' || mode === 'reference') && !promptRaw) {
    throw invalid(`prompt is required for ${mode} mode.`);
  }
  if (promptRaw.length > 8000) throw invalid('prompt is longer than 8000 characters.');

  const duration = optionalNumber(input.duration ?? input.seconds, 'duration');
  const resolution = optionalString(input.resolution, 'resolution');
  const aspectRatio = optionalString(input.aspect_ratio, 'aspect_ratio');
  if (aspectRatio && !/^\d{1,2}:\d{1,2}$/.test(aspectRatio)) {
    throw invalid('aspect_ratio must look like "16:9", "9:16" or "1:1".');
  }

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

function normalizeResult({ id, data, entry, built = null, submittedAt = null }) {
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
    created_at: submittedAt === null ? null : Math.floor(submittedAt / 1000),
    model: data?.model ?? null,
    provider: data?.provider ?? 'copilot-video',
    mode: built?.mode ?? null,
    seconds: built?.duration ?? null,
    resolution: built?.resolution ?? null,
    aspect_ratio: built?.aspectRatio ?? null,
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
  return normalizeResult({ id: data.upstreamTaskId, data, entry, built, submittedAt: startedAt });
}

export async function queryVideo(auth, id, options = {}) {
  const taskId = typeof id === 'string' ? id.trim() : '';
  if (!taskId) throw invalid('video id is required.');
  const opts = clientOptions(options);
  const data = await mioraPost(auth, VIDEO_QUERY_PATH, { upstreamTaskIds: [taskId] }, opts);
  const entry = isObject(data) ? data[taskId] : null;
  if (!isObject(entry)) {
    throw new MioraVideoError('VIDEO_NOT_FOUND', `Miora has no video task ${taskId}.`, { status: 404 });
  }
  return normalizeResult({ id: taskId, data: { upstreamTaskId: taskId }, entry });
}
