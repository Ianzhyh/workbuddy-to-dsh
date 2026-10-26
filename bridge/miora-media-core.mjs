/**
 * Miora 媒体客户端底层（视频 / 图片共用）。
 *
 * 上游链路（从桌面端 miora MCP 的 dist/cli.cjs 反查并实测）：
 *   1. 用当前登录 token 调 `<chat endpoint>/v2/api-keys`，
 *      申请名为 workbuddy-connect-cloud-service 的 15 分钟临时 key（ck_t_…）；
 *   2. 以 Bearer 临时 key 调 `public.miora.qq.com/api/ai/workbuddy-proxy/*`。
 *
 * 临时 key 只放内存、按账号与 token 指纹缓存；不落盘、不进日志或响应。
 * 提交是计费动作，任何失败都不自动重试 —— 只有 401（请求未被受理）会换 key 重试一次。
 *
 * 错误码按媒体类型加前缀（`VIDEO_*` / `IMAGE_*`）：同一个网关失败，客户端仍能按
 * 能力区分；`prefix` 由各模块通过 options 传下来，默认 VIDEO。
 */
import { createHash } from 'node:crypto';
import {
  existsSync, mkdirSync, readFileSync, renameSync, writeFileSync,
} from 'node:fs';
import { readFile, stat as statFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute } from 'node:path';

export const DEFAULT_MIORA_BASE = 'https://public.miora.qq.com';

const CLIENT_TEMP_KEY_PATH = '/v2/api-keys';
const CLIENT_TEMP_KEY_NAME = 'workbuddy-connect-cloud-service';
const TEMP_KEY_TTL_MS = 15 * 60 * 1000;
const TEMP_KEY_REFRESH_SKEW_MS = 60 * 1000;
// 视频帧单张 10 MB（与官方 miora MCP 的 MAX_FRAME_BYTES 一致）；图片走 20 MB，
// 由 image 模块显式传入 maxBytes。
export const DEFAULT_INPUT_MAX_BYTES = 10 * 1024 * 1024;
const TEMP_KEY_TIMEOUT_MS = 10_000;
// 与官方 miora MCP 的 MIORA_SUBMIT_HTTP_TIMEOUT_MS 一致：提交接口是异步的，
// 正常几秒返回；把预算放足，避免上游慢时桥先放弃、任务 id 丢失却已计费。
export const SUBMIT_TIMEOUT_MS = 390_000;
export const QUERY_TIMEOUT_MS = 30_000;

// 长轮询：`GET /v1/{videos,images}/{id}?wait=N` 由桥代客户端轮询。
// 上限 60 秒（工具侧还会留出单次查询的超时余量），间隔 2 秒。
export const MAX_MEDIA_WAIT_MS = 60_000;
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

export class MioraMediaError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'MioraMediaError';
    this.code = code;
    this.status = options.status ?? 502;
    this.retryAfter = options.retryAfter ?? null;
    this.upstreamCode = options.upstreamCode ?? null;
  }
}

/** 兼容旧名：video 模块与桥仍按 `MioraVideoError` 导入/判断（同一个类）。 */
export const MioraVideoError = MioraMediaError;

export function invalidInput(prefix, message) {
  return new MioraMediaError(`${prefix}_INVALID_INPUT`, message, { status: 400 });
}

function shortMessage(value, limit = 300) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function trimSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

export function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function normalizeMediaStatus(status) {
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
    case 'success':
    case 'done':
    case 'finished':
      return 'completed';
    case 'failed':
    case 'error':
    case 'timeout':
    case 'timed_out':
    case 'expired':
      return 'failed';
    case 'cancelled':
    case 'canceled':
      return 'cancelled';
    default:
      return 'in_progress';
  }
}

/** 兼容旧名（视频的对外字段就叫 status 归一，测试直接测它）。 */
export const normalizeVideoStatus = normalizeMediaStatus;

/** 终态判断统一走归一化：`FAILED` / `success` / `done` 等都算。 */
export function isTerminalMediaStatus(status) {
  const normalized = normalizeMediaStatus(status);
  return normalized === 'completed' || normalized === 'failed' || normalized === 'cancelled';
}

/**
 * 上游产物文件列表 → https 地址。
 *
 * 上游给的不只是 `signedUrl`：实测里还见过 `url` / `downloadUrl` / 裸字符串，
 * 以及被包在 `{file:{...}}` 里的形态。只认 `signedUrl || url` 会让「任务已完成、
 * 也有产物」被报成 `*_NO_OUTPUT`（用户看到的是「上游没给产物」，其实给了）。
 */
export function collectOutputUrls(files) {
  if (!Array.isArray(files)) return [];
  const pick = (item) => {
    if (typeof item === 'string') return item;
    if (!isObject(item)) return '';
    const nested = isObject(item.file) ? item.file : (isObject(item.result) ? item.result : null);
    const nestedValue = nested
      ? (nested.signedUrl || nested.signed_url || nested.url || nested.downloadUrl || nested.download_url)
      : '';
    const value = item.signedUrl || item.signed_url || item.url || item.downloadUrl
      || item.download_url || nestedValue;
    return typeof value === 'string' ? value : '';
  };
  const urls = [];
  for (const item of files) {
    const url = pick(item).trim();
    if (/^https:\/\//i.test(url) && !urls.includes(url)) urls.push(url);
  }
  return urls;
}

/**
 * 同步任务（`mode:"sync"`）的结果只在提交响应里；上游不保存可按 id 查询的任务。
 * 它的查询接口会返回 `INVALID_TASK_ID_FOR_SYNC_MODE` —— 这是「查法不对」，
 * 不是「生成失败」。工具层要据此给出完全不同的建议，不能劝用户重提。
 */
const SYNC_QUERY_MISS_RE = /INVALID_TASK_ID_FOR_SYNC_MODE/i;

/** 失败原因可能是字符串、Error 形状或 `{message}`：统一取出可读文本。 */
function errorMessageOf(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (isObject(value)) {
    const nested = value.message ?? value.msg ?? value.errorMessage ?? value.error;
    if (typeof nested === 'string') return nested;
  }
  return '';
}

/** 上游字段偶尔在 `resultFiles` / `result_files` 之间摇摆；两边都认。 */
function pickResultFiles(entry, data) {
  for (const candidate of [entry?.resultFiles, entry?.result_files, data?.resultFiles, data?.result_files]) {
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

/**
 * 归一化状态 + 失败原因（两个模块共用）。
 *
 * 踩过的坑：`status` 归一用的是**大小写不敏感**的 `normalizeMediaStatus`，
 * 但判断「是不是失败」时却写了 `entry.status === 'failed'`。上游回过
 * `FAILED` / `Failed` / ` failed ` 时，对外状态是 `failed`，`error` 却是 `null`
 * —— 用户和 agent 都拿不到失败原因，只能看到一句「任务未成功：上游未给失败原因」。
 * 所以失败判定必须和归一化用同一套比较。
 */
export function normalizeMediaEntry({ id, data, entry, meta = null, object, defaultProvider }) {
  const rawStatus = String(entry?.status ?? data?.status ?? 'pending').trim();
  const status = normalizeMediaStatus(rawStatus);
  const files = pickResultFiles(entry, data);
  const urls = collectOutputUrls(files);
  const failed = status === 'failed' || status === 'cancelled';
  const rawMessage = failed
    ? errorMessageOf(
      entry?.errorMessage
      ?? entry?.error_message
      ?? entry?.error
      ?? entry?.failReason
      ?? data?.errorMessage
      ?? data?.error_message,
    )
    : '';
  const syncResultUnavailable = failed && SYNC_QUERY_MISS_RE.test(rawMessage);
  return {
    id: String(data?.upstreamTaskId || id || ''),
    object,
    status,
    upstream_status: rawStatus,
    created_at: meta?.createdAt ?? null,
    model: data?.model ?? meta?.model ?? null,
    provider: data?.provider ?? meta?.provider ?? defaultProvider,
    result_files: files,
    output: urls.length ? { url: urls[0], urls } : null,
    error: rawMessage && !syncResultUnavailable
      ? { message: String(rawMessage).replace(/\s+/g, ' ').trim().slice(0, 300) }
      : (syncResultUnavailable
        ? {
          message: '该任务是同步完成的：上游只把结果放在提交响应里，不保存可按 id 查询的任务。'
            + '桥的短期缓存已不包含它（过期或重启）。需要产物请查看提交时的响应，或重新生成（会再次计费）。',
        }
        : null),
    // 给 API/工具一个明确的判别位：这不是普通的「生成失败」，不要建议按 id 重查。
    ...(syncResultUnavailable ? { sync_result_unavailable: true } : {}),
  };
}

export function mediaPayload(resolved) {
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
    // CGNAT 100.64/10：云厂商的「内网」常落在这段，和 10/8 一样不该被公网接口打到。
    || (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127)
    || parts[0] === 0
    // 组播 / 保留段：不是可抓取的公网 HTTPS 主机。
    || parts[0] >= 224;
}

/**
 * IPv6 字面量的私有/保留判定。
 *
 * 这里收口两类历史问题（都用桩输入实测过）：
 *
 *   1. **误杀合法公网域名**。原先用 `/^(?:fc|fd|fe8|fe9|fea|feb)/` 判 ULA/link-local，
 *      但那是对**域名字符串**做前缀比对 —— `fc2.com`、`fcdn.cloudflare.net`、
 *      `fd.example.com`、`fe8.images.xyz` 全部被当成内网地址拒掉。用户拿公网图片
 *      URL 做首帧时，会收到一条「private/reserved hosts are rejected」，可主机根本
 *      是公网。域名和 IPv6 字面量必须分开判。
 *   2. **IPv4-mapped 绕过**。`https://[::ffff:127.0.0.1]/` 规范化后是 `[::ffff:7f00:1]`，
 *      既不是 `::1`、也不命中那条前缀正则、`isPrivateIpv4` 又只认点分格式 —— 于是
 *      直接放行，等于把回环地址塞进了上游。
 *
 * 所以这里先把 IPv6 **解析成分段**再判断，而不是对字符串做前缀比对。
 */
function isPrivateIpv6(host) {
  const text = host.toLowerCase();
  if (text === '::' || text === '::1') return true;
  /*
   * 先把地址**严格展开成 8 个 16 位段**再判断。
   *
   * 不能只按字符串前缀猜：`::ffff:127.0.0.1` 与 `::ffff:7f00:1` 是同一个地址，
   * 但写法完全不同；末尾的点分 IPv4 会占**两个**段，所以段数要在展开时一并算准，
   * 否则补零的数量会错，后面的段位判断全部跟着错。
   */
  const expand = (group) => {
    if (!group.includes('.')) return [group];
    const v4 = group.split('.').map(Number);
    if (v4.length !== 4 || v4.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    return [(((v4[0] << 8) | v4[1]) >>> 0).toString(16), (((v4[2] << 8) | v4[3]) >>> 0).toString(16)];
  };
  const [headRaw, tailRaw] = text.includes('::') ? text.split('::') : [text, null];
  const split = (part) => (part ? part.split(':').filter((piece) => piece !== '') : []);
  const head = [];
  for (const group of split(headRaw)) {
    const expanded = expand(group);
    if (!expanded) return true;
    head.push(...expanded);
  }
  const tail = [];
  for (const group of split(tailRaw === null ? '' : tailRaw)) {
    const expanded = expand(group);
    if (!expanded) return true;
    tail.push(...expanded);
  }
  const fill = tailRaw === null ? 0 : 8 - head.length - tail.length;
  // 段数不合法（含 `::` 但补不齐、或不含 `::` 却不是 8 段）→ 按不可信处理
  if (fill < 0 || head.length + fill + tail.length !== 8) return true;
  const groups = [...head, ...Array.from({ length: fill }, () => '0'), ...tail];

  const nums = [];
  for (const group of groups) {
    const n = Number.parseInt(group, 16);
    if (!Number.isFinite(n) || n < 0 || n > 0xffff) return true;
    nums.push(n);
  }

  const words = (hi, lo) => `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
  const isZero = (n) => n === 0;
  // ::ffff:a.b.c.d（IPv4-mapped，前 5 段为 0、第 6 段是 ffff）
  if (nums.slice(0, 5).every(isZero) && nums[5] === 0xffff) {
    return isPrivateIpv4(words(nums[6], nums[7]));
  }
  // ::a.b.c.d（IPv4-compatible，前 6 段为 0）—— 已弃用但仍可能出现在输入里
  if (nums.slice(0, 6).every(isZero)) {
    return isPrivateIpv4(words(nums[6], nums[7]));
  }
  if ((nums[0] & 0xfe00) === 0xfc00) return true; // ULA fc00::/7
  if ((nums[0] & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((nums[0] & 0xffc0) === 0xfec0) return true; // 站点本地 fec0::/10
  if ((nums[0] & 0xff00) === 0xff00) return true; // 组播 ff00::/8
  if (nums[0] === 0x2001 && nums[1] === 0x0db8) return true; // 文档段 2001:db8::/32
  return false;
}

export function publicHttpsUrl(raw, field, invalidCode) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new MioraMediaError(invalidCode, `${field} is not a valid URL.`, { status: 400 });
  }
  if (url.protocol !== 'https:') {
    throw new MioraMediaError(invalidCode, `${field} must be a public https URL.`, { status: 400 });
  }
  if (url.username || url.password) {
    throw new MioraMediaError(invalidCode, `${field} must not contain credentials.`, { status: 400 });
  }
  // 末尾的根点（`localhost.` / `foo.local.`）解析结果不变，必须一起归一，
  // 否则 `https://localhost./` 能绕过 localhost 判定。
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (!host) {
    throw new MioraMediaError(invalidCode, `${field} has no usable host.`, { status: 400 });
  }
  /*
   * 域名与 IP 字面量分开判：`fc2.com` 是公网域名，`fc00::1` 才是内网地址。
   * 早先两者共用一条前缀正则，结果公网域名被误杀（见 isPrivateIpv6 的注释）。
   */
  // 常见 hosts 别名（Debian 系默认把 localhost.localdomain / ip6-localhost
  // 指到回环）；只按精确主机名判，不误伤 localhost.example.com。
  const loopbackAlias = host === 'localhost' || host === 'localhost.localdomain'
    || host === 'ip6-localhost' || host === 'ip6-loopback';
  const rejected = loopbackAlias
    || host.endsWith('.localhost')
    || host.endsWith('.local')
    || (host.includes(':') ? isPrivateIpv6(host) : isPrivateIpv4(host));
  if (rejected) {
    throw new MioraMediaError(
      invalidCode,
      `${field} must be a public https URL (private/reserved hosts are rejected).`,
      { status: 400 },
    );
  }
  return url.toString();
}

function safeFileKey(raw, field, invalidCode) {
  const segments = raw.split('/').slice(1);
  if (segments.length === 0 || segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new MioraMediaError(invalidCode, `${field} is a miora fileKey with path-traversal segments.`, { status: 400 });
  }
  return raw;
}

function parseDataUri(raw, field, { maxBytes, invalidCode }) {
  // 方案名大小写不敏感（RFC 2397）：DATA: 与 data: 等价。
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/is.exec(raw);
  if (!match) throw new MioraMediaError(invalidCode, `${field} is not a valid data URI.`, { status: 400 });
  if (!match[2]) {
    throw new MioraMediaError(invalidCode, `${field} data URI must use ;base64 encoding.`, { status: 400 });
  }
  const mimeType = match[1]?.trim();
  if (mimeType && !/^image\//i.test(mimeType)) {
    throw new MioraMediaError(
      invalidCode,
      `${field} data URI must be an image/* type (got ${mimeType}).`,
      { status: 400 },
    );
  }
  const payload = match[3] ?? '';
  const buffer = Buffer.from(payload, 'base64');
  if (buffer.length === 0) {
    throw new MioraMediaError(invalidCode, `${field} data URI has an empty payload.`, { status: 400 });
  }
  if (buffer.length > maxBytes) {
    throw new MioraMediaError(invalidCode, `${field} exceeds ${maxBytes}B (${buffer.length}B).`, { status: 400 });
  }
  return { origin: 'dataUri', base64: payload, mimeType: mimeType || undefined, sizeBytes: buffer.length };
}

/**
 * 内联图片（本地路径 / data URI）在请求体里占多少空间。
 *
 * 单张上限（图片 20 MB / 视频帧 10 MB）只管一张，**多张参考图叠加**时仍可能
 * 超出桥的请求体上限，最后只得到一句 413。这里按真实的 body 预算提前算出可用的
 * 原始字节数（base64 膨胀 4/3，再留 256 KB 给 prompt/JSON 其它字段），提交前即可
 * 给出「改用 fileKey/URL」这种可执行的 400，而不是等解析完几十 MB 才失败。
 */
export function inlineInputBudgetBytes(maxBodyBytes) {
  const limit = Number(maxBodyBytes) > 0 ? Number(maxBodyBytes) : 32 * 1024 * 1024;
  const reserve = 256 * 1024;
  return Math.max(0, Math.floor((limit - reserve) * 3 / 4));
}

export function inlineInputBytes(resolvedList) {
  return (Array.isArray(resolvedList) ? resolvedList : [])
    .reduce((sum, item) => sum + (Number(item?.sizeBytes) || 0), 0);
}

/** 人类可读的 MB（只用于错误文案，保留一位小数）。 */
function mb(bytes) {
  return `${((Number(bytes) || 0) / (1024 * 1024)).toFixed(1)} MB`;
}

export function assertInlineInputBudget(resolvedList, maxBodyBytes, { prefix = 'VIDEO', what = 'image' } = {}) {
  const total = inlineInputBytes(resolvedList);
  const budget = inlineInputBudgetBytes(maxBodyBytes);
  if (total <= budget) return;
  throw new MioraMediaError(
    `${prefix}_INVALID_INPUT`,
    `inline ${what} data is ${mb(total)} raw, which exceeds the request body budget (${mb(budget)} of raw data; base64 expands by 4/3). `
      + 'Use a miora fileKey or public https URL instead of local paths/data URIs, or send fewer/smaller inputs.',
    { status: 400 },
  );
}

/**
 * 把图片输入归一成上游 media payload。
 * 支持：绝对本地路径、miora fileKey（bga/… 或 file/…）、公网 https URL、base64 data URI。
 *
 * @param {string} raw
 * @param {{ fieldName?: string, maxBytes?: number, invalidCode?: string, readFile?: Function, statFile?: Function }} [options]
 */
export async function resolveImageInput(raw, options = {}) {
  const field = options.fieldName || 'image';
  const maxBytes = options.maxBytes ?? DEFAULT_INPUT_MAX_BYTES;
  const invalidCode = options.invalidCode || 'VIDEO_INVALID_INPUT';
  const invalid = (message) => new MioraMediaError(invalidCode, message, { status: 400 });
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) throw invalid(`${field} is empty.`);
  if (/^data:/i.test(text)) return parseDataUri(text, field, { maxBytes, invalidCode });
  if (/^https?:\/\//i.test(text)) {
    return { origin: 'url', url: publicHttpsUrl(text, field, invalidCode), sizeBytes: 0 };
  }
  if (FILE_KEY_RE.test(text)) {
    return { origin: 'fileKey', fileKey: safeFileKey(text, field, invalidCode), sizeBytes: 0 };
  }
  if (!isAbsolute(text)) {
    throw invalid(`${field} must be an absolute local path, miora fileKey, public https URL, or data URI.`);
  }
  const mimeType = EXT_TO_MIME.get(extname(text).toLowerCase());
  if (!mimeType) throw invalid(`${field} has an unsupported image extension: ${text}`);
  /*
   * **先看大小再读内容**。原先直接 `readFile()` 拿到 Buffer 之后才比 maxBytes：
   * 传一个 2 GB 的文件时，桥会先把 2 GB 读进内存（base64 之前还要再涨 1/3），
   * 然后才告诉用户「太大了」。这既是明显的浪费，也让一个坏输入能把本地进程
   * 的堆打穿 —— 而判断所需的信息（文件长度）在读之前就能拿到。
   *
   * 只有**真实读盘**才做这道预检：注入了 `readFile`（测试桩、虚拟文件）却没给
   * `statFile` 时，磁盘上未必真有那个路径，拿 stat 的失败去否决调用是不对的。
   */
  const readImpl = options.readFile || readFile;
  const statImpl = options.statFile || (options.readFile ? null : statFile);
  if (statImpl) {
    const info = await statImpl(text).catch(() => null);
    if (!info || !Number.isFinite(info.size)) throw invalid(`${field} could not be read: ${text}`);
    if (info.size === 0) throw invalid(`${field} is empty: ${text}`);
    if (info.size > maxBytes) throw invalid(`${field} exceeds ${maxBytes}B (${info.size}B): ${text}`);
  }
  const buffer = await readImpl(text).catch((err) => {
    throw invalid(`${field} could not be read: ${text} (${err.message})`);
  });
  if (buffer.length === 0) throw invalid(`${field} is empty: ${text}`);
  // 读的过程中文件可能被换掉/变大：仍要按真实长度兜一次，不能只信 stat。
  if (buffer.length > maxBytes) throw invalid(`${field} exceeds ${maxBytes}B (${buffer.length}B): ${text}`);
  return {
    origin: 'path',
    base64: buffer.toString('base64'),
    mimeType,
    sizeBytes: buffer.length,
  };
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

function upstreamFailure(status, body, path, { prefix = 'VIDEO', retryAfter = null } = {}) {
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
    return new MioraMediaError(`${prefix}_AUTH`, 'Miora rejected the temporary key. Check the current login and retry.', {
      status: 401,
      upstreamCode: code,
    });
  }
  if (effectiveStatus === 403) {
    return new MioraMediaError(`${prefix}_SCOPE_DENIED`, message, { status: 403, upstreamCode: code });
  }
  if (effectiveStatus === 429) {
    return new MioraMediaError(`${prefix}_RATE_LIMITED`, message, {
      status: 429,
      retryAfter,
      upstreamCode: code,
    });
  }
  if (effectiveStatus === 400 || effectiveStatus === 422) {
    return new MioraMediaError(`${prefix}_UPSTREAM_REJECTED`, message, { status: 400, upstreamCode: code });
  }
  return new MioraMediaError(`${prefix}_UPSTREAM`, message, { status: 502, upstreamCode: code });
}

const tempKeyCache = new Map();
const tempKeyPending = new Map();

function cacheKeyFor(auth) {
  const fingerprint = createHash('sha256').update(String(auth?.access || '')).digest('hex').slice(0, 16);
  return `${trimSlash(auth?.endpoint)}|${auth?.userId || auth?.uid || ''}|${fingerprint}`;
}

const submissionMeta = new Map();
let submissionStoreFile = '';

/**
 * 让提交元数据跨桥重启保留（同步任务尤其重要：上游不保存 sync 任务，重启后
 * 只能靠本地缓存回答查询）。只存 id 与元数据（含签名 URL/失败原因），不含 prompt；
 * 调用方负责把文件放在运行期数据目录里。
 *
 * 不配置 file 时保持纯内存行为（单元测试默认走这条）。
 */
/**
 * @param {{ file?: string }} [options]
 */
export function configureSubmissionStore({ file } = {}) {
  submissionStoreFile = file ? String(file) : '';
  if (!submissionStoreFile) return;
  try {
    if (!existsSync(submissionStoreFile)) return;
    const parsed = JSON.parse(readFileSync(submissionStoreFile, 'utf8'));
    const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
    for (const entry of entries) {
      if (!entry || typeof entry.id !== 'string' || !entry.meta) continue;
      if (Date.now() - Number(entry.meta.savedAt || 0) > META_TTL_MS) continue;
      submissionMeta.set(entry.id, entry.meta);
    }
    while (submissionMeta.size > META_MAX_ENTRIES) {
      const oldest = submissionMeta.keys().next().value;
      submissionMeta.delete(oldest);
    }
  } catch {
    // 坏文件/权限问题按空缓存启动；查询会退回上游，不影响主链路。
  }
}

function persistSubmissionStore() {
  if (!submissionStoreFile) return;
  try {
    mkdirSync(dirname(submissionStoreFile), { recursive: true });
    const entries = [...submissionMeta.entries()]
      .filter(([, meta]) => Date.now() - Number(meta?.savedAt || 0) <= META_TTL_MS)
      .map(([id, meta]) => ({ id, meta }));
    const tmp = `${submissionStoreFile}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ version: 1, entries })}\n`, 'utf8');
    renameSync(tmp, submissionStoreFile);
  } catch {
    // 磁盘问题不能影响已经计费的提交/查询。
  }
}

/** 记住一次提交的元数据（仅供同进程内的查询回填；不含 prompt）。 */
export function rememberSubmission(id, meta) {
  if (!id) return;
  submissionMeta.delete(id);
  submissionMeta.set(id, meta);
  while (submissionMeta.size > META_MAX_ENTRIES) {
    const oldest = submissionMeta.keys().next().value;
    submissionMeta.delete(oldest);
  }
  persistSubmissionStore();
}

/**
 * 提交缓存的**账号作用域**。
 *
 * 缓存里有同步任务的产物 URL / 失败原因，不能只按 taskId 命中：同一台机器
 * 切换账号后，新账号拿到旧账号的任务 id 时，必须重新走上游（通常 404），
 * 而不是从本进程缓存里读到别人的产物。用 endpoint + userId 做作用域，
 * 这样同账号 token 刷新后仍能命中；没有 userId 的 API key 模式才退回 token 指纹。
 */
export function submissionScope(auth) {
  const id = auth?.userId || auth?.uid || '';
  const endpoint = trimSlash(auth?.endpoint);
  if (id) return `${endpoint}|${id}`;
  return cacheKeyFor(auth);
}

export function recallSubmission(id, scope = null) {
  const meta = submissionMeta.get(id);
  if (!meta) return null;
  // 老进程里可能残留没有 account 的条目；有 account 且与当前账号不符时绝不返回。
  if (scope && meta.account && meta.account !== scope) return null;
  // TTL 用真实时钟：`now` 是可注入的（测试用来固定 created_at），不该影响缓存寿命。
  if (Date.now() - meta.savedAt > META_TTL_MS) {
    submissionMeta.delete(id);
    persistSubmissionStore();
    return null;
  }
  return meta;
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
  const prefix = options.prefix || 'VIDEO';
  const endpoint = trimSlash(auth?.endpoint);
  if (!endpoint) {
    throw new MioraMediaError(`${prefix}_AUTH`, 'no upstream endpoint for the current login.', { status: 401 });
  }
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
    throw new MioraMediaError(
      `${prefix}_UNAVAILABLE`,
      `could not reach the WorkBuddy gateway: ${shortMessage(err.message)}`,
      { status: 502 },
    );
  }
  let body = null;
  try { body = await response.json(); } catch { /* 非 JSON 按下述错误处理 */ }
  const key = body?.data?.key;
  if (!response.ok || body?.code !== 0 || typeof key !== 'string' || !key.startsWith('ck_t_')) {
    const message = shortMessage(body?.msg ?? body?.message)
      || `could not obtain a temporary Miora key (HTTP ${response.status}).`;
    if (response.status === 429) {
      /*
       * 这是**申请临时 key** 被限流，提交请求还没发出去 —— 和提交接口的 429
       * 是两回事：后者可能已经受理并计费，前者绝不会。用独立 code 让工具能说
       * “可以直接稍后重试”，而不是劝用户去查一个不存在的任务。
       */
      throw new MioraMediaError(`${prefix}_KEY_RATE_LIMITED`, message, {
        status: 429,
        retryAfter: retryAfterSeconds(response.headers),
        upstreamCode: body?.code ?? null,
      });
    }
    if (response.status === 403) {
      throw new MioraMediaError(`${prefix}_SCOPE_DENIED`, message, {
        status: 403,
        upstreamCode: body?.code ?? null,
      });
    }
    throw new MioraMediaError(`${prefix}_AUTH`, message, {
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

/**
 * 带临时 key 的 POST（401 换 key 重试一次）。
 * 视频 / 图片共用；错误码前缀由 `options.prefix` 决定。
 */
export async function mioraRequest(auth, path, body, options, retried = false) {
  const prefix = options.prefix || 'VIDEO';
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
    throw new MioraMediaError(`${prefix}_UNAVAILABLE`, `Miora is unreachable: ${shortMessage(err.message)}`, { status: 502 });
  }

  const text = await response.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }

  if (response.status === 401 && !retried) {
    tempKeyCache.delete(cacheKeyFor(auth));
    return mioraRequest(auth, path, body, options, true);
  }
  if (!response.ok) {
    throw upstreamFailure(response.status, parsed ?? { message: text }, path, {
      prefix,
      retryAfter: retryAfterSeconds(response.headers),
    });
  }
  if (!isObject(parsed)) {
    throw new MioraMediaError(`${prefix}_UPSTREAM`, `Miora ${path} returned a non-JSON body.`, { status: 502 });
  }
  const failed = bodyFailure(parsed);
  if (failed) throw upstreamFailure(Number(failed.httpStatus) || response.status, failed, path, { prefix });
  // 有些网关用 HTTP 200 + 非 0 code 表达失败（没有 failed 字段）；不能当成成功解包。
  if (typeof parsed.code === 'number' && parsed.code !== 0) {
    throw upstreamFailure(Number(parsed.httpStatus) || response.status, parsed, path, { prefix });
  }
  return unwrapEnvelope(parsed);
}

export function mediaClientOptions(options = {}) {
  return {
    fetchImpl: options.fetchImpl || fetch,
    now: options.now || Date.now,
    baseUrl: options.baseUrl || DEFAULT_MIORA_BASE,
    timeoutMs: options.timeoutMs,
    readFile: options.readFile,
    // 提交前预算用：桥的请求体上限（默认 32 MB）。纯客户端调用可以不传。
    maxBodyBytes: options.maxBodyBytes,
    prefix: options.prefix || 'VIDEO',
  };
}

/**
 * 查询任务；`waitMs > 0` 时由桥代客户端轮询（每 2 秒），直到终态或预算用完。
 * 查询不计费，重复查询安全；超时返回最后一次状态，不是失败。
 *
 * @param {object} auth
 * @param {string} id
 * @param {{
 *   queryPath?: string, normalize?: Function, prefix?: string, label?: string,
 *   waitMs?: number, sleep?: Function, fetchImpl?: Function, now?: Function,
 *   baseUrl?: string, timeoutMs?: number,
 * }} options
 */
export async function pollMediaTask(auth, id, options = {}) {
  const prefix = options.prefix || 'VIDEO';
  const label = options.label || 'media';
  if (typeof options.normalize !== 'function' || !options.queryPath) {
    throw new Error('pollMediaTask requires queryPath and normalize');
  }
  const taskId = typeof id === 'string' ? id.trim() : '';
  if (!taskId) throw invalidInput(prefix, `${label} id is required.`);
  const opts = mediaClientOptions(options);
  const waitMs = Math.min(Math.max(Number(options.waitMs) || 0, 0), MAX_MEDIA_WAIT_MS);
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const attempts = waitMs > 0 ? Math.ceil(waitMs / QUERY_POLL_INTERVAL_MS) + 1 : 1;
  // 预算是**真实时间**：单次查询很慢时也要按时收手，不能只靠轮询次数兜底。
  const deadline = opts.now() + waitMs;

  let last = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const data = await mioraRequest(auth, options.queryPath, { upstreamTaskIds: [taskId] }, opts);
    const entry = isObject(data) ? data[taskId] : null;
    if (!isObject(entry)) {
      throw new MioraMediaError(`${prefix}_NOT_FOUND`, `Miora has no ${label} task ${taskId}.`, { status: 404 });
    }
    last = options.normalize({
      id: taskId,
      entry,
      meta: recallSubmission(taskId, submissionScope(auth)),
    });
    const terminal = last.status === 'completed' || last.status === 'failed' || last.status === 'cancelled';
    if (terminal || attempt === attempts - 1) return last;
    // 最后一段可能不足一个轮询间隔：别让 wait=1 实际等了 2 秒。
    const remaining = Math.min(deadline - opts.now(), waitMs - attempt * QUERY_POLL_INTERVAL_MS);
    if (remaining <= 0) return last;
    await sleep(Math.min(QUERY_POLL_INTERVAL_MS, remaining));
  }
  return last;
}
