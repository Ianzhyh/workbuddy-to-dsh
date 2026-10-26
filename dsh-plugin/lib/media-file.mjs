/**
 * 把生成的产物（视频 / 图片）从签名 URL 落到本地文件。
 *
 * ## 为什么需要这一步
 *
 * 上游返回的是 COS 签名 URL，**有时效**（实测视频约 12 小时）。此前查询工具只把
 * URL 原样交给模型，用户看到的就是一条长链接：
 *
 *   - 在聊天里点不动，或者点开是浏览器播放页，想存下来还得另存为；
 *   - 隔天再回去拿，链接已经过期，而**任务本身已完成、不会再生成一次** ——
 *     要重拿只能祈祷上游还留着旧签名，实际上常常是彻底拿不到了（想再要就得
 *     重新提交，等于再扣一次积分）。
 *
 * 所以这里提供「下载成文件」的能力：拿到本地绝对路径后，用户得到的是一份
 * 不会过期的产物，模型也能直接把它当成文件交付。
 *
 * ## 边界
 *
 * - 只接受 **公网 https**：产物地址来自上游，不该出现 http；明显的本机/内网字面量
 *   也拒绝（避免一个被篡改的响应把下载器变成内网探测器）；
 * - **流式落盘**：视频可能几十 MB，先 `arrayBuffer()` 会把整段读进内存；
 * - 有大小上限（默认 256 MB）与超时（默认 120 秒），异常一律**不删已有结果**，
 *   由调用方回退到「给 URL」；
 * - 文件名由 `kind + 时间 + id 片段` 生成，id 会被清洗成安全字符 —— 上游的
 *   taskId 里带 `:`、`/` 也不能让它逃出目标目录。
 */
import { createWriteStream } from 'node:fs';
import { mkdir, stat, unlink } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** 单次落盘的默认上限：够放 4K 短视频，又不至于把磁盘吃穿。 */
export const DEFAULT_MAX_DOWNLOAD_BYTES = 256 * 1024 * 1024;
export const DEFAULT_DOWNLOAD_TIMEOUT_MS = 120_000;

const MIME_EXT = new Map([
  ['video/mp4', '.mp4'],
  ['video/quicktime', '.mov'],
  ['video/webm', '.webm'],
  ['video/x-matroska', '.mkv'],
  ['image/png', '.png'],
  ['image/jpeg', '.jpg'],
  ['image/jpg', '.jpg'],
  ['image/webp', '.webp'],
  ['image/gif', '.gif'],
  ['image/bmp', '.bmp'],
]);

/** URL 里能安全沿用的图片/视频扩展名（其它一律不认，避免把 `.html` 存成产物）。 */
const URL_EXT = new Set(['.mp4', '.mov', '.webm', '.mkv', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']);

const DEFAULT_KIND_EXT = { video: '.mp4', image: '.png' };

/**
 * taskId → 文件名里能用的片段。
 *
 * 上游 id 形如 `1312831544-WandVideo-3a0edea9…`，但也见过带 `:` 的。
 * 任何路径分隔符、`..`、控制字符都不能进文件名 —— 否则 `save_to` 给的目录
 * 会被 `../` 直接穿透。
 */
export function safeIdFragment(id, limit = 32) {
  const cleaned = String(id || '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+/, '')
    .replace(/[-.]+$/, '');
  return (cleaned || 'task').slice(0, limit);
}

/** 从 mime / URL / kind 三层里挑一个扩展名。 */
export function pickExtension({ mimeType, url, kind = 'video' } = {}) {
  const mime = String(mimeType || '').split(';')[0].trim().toLowerCase();
  if (MIME_EXT.has(mime)) return MIME_EXT.get(mime);
  let pathname = '';
  try { pathname = new URL(String(url || '')).pathname; } catch { /* 非法 URL：走默认 */ }
  const ext = extname(pathname).toLowerCase();
  if (URL_EXT.has(ext)) return ext === '.jpeg' ? '.jpg' : ext;
  return DEFAULT_KIND_EXT[kind] || '.bin';
}

/**
 * 生成落盘文件名：`video-20261026-093015-1312831544.mp4`。
 * 时间前缀让同一目录下的多次生成按时间天然排序，也避免同名覆盖。
 *
 * 一次任务返回多个产物时，同一秒内的时间戳+taskId 完全相同；`index > 0`
 * 会补 `-2` / `-3`（显式文件名场景）。目录模式由 saveMediaFile 按磁盘去重，
 * 不会覆盖已有文件（`rename` 在 Windows/Linux 都会静默替换）。
 */
export function mediaFileName({ id, kind = 'video', mimeType, url, now = Date.now(), index = 0 } = {}) {
  const d = new Date(now);
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
    + `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const seq = index > 0 ? `-${index + 1}` : '';
  return `${kind}-${stamp}-${safeIdFragment(id)}${seq}${pickExtension({ mimeType, url, kind })}`;
}

/**
 * 判断 `saveTo` 应该被当成目录还是完整文件路径。
 *
 * 判据尽量简单且可预测：已存在的目录、以分隔符结尾、或**没有扩展名** → 目录。
 * 最后一条是关键 —— 用户传 `C:\Users\me\Pictures` 时，那个目录可能还不存在，
 * 但它显然不是文件名。
 */
export async function resolveTargetPath({ saveTo, fileName }) {
  const raw = String(saveTo || '').trim();
  if (!raw) throw new Error('save_to is empty.');
  if (!isAbsolute(raw)) throw new Error(`save_to must be an absolute path: ${raw}`);
  const target = resolve(raw);
  /*
   * 先看路径本身是什么，再用「有没有扩展名」猜不存在的路径：
   * 已存在的无扩展名**文件**不能被当成目录，否则 mkdir 会失败；
   * 不存在的 `C:\Users\me\Pictures` 则确实应该当目录。
   */
  let info = null;
  try { info = await stat(target); } catch { /* 不存在：按下面的启发式 */ }
  if (info?.isDirectory()) return { file: join(target, fileName), dir: target, isDir: true };
  if (info?.isFile()) return { file: target, dir: dirname(target), isDir: false };
  const looksLikeDir = raw.endsWith('/') || raw.endsWith(sep) || extname(target) === '';
  if (looksLikeDir) return { file: join(target, fileName), dir: target, isDir: true };
  return { file: target, dir: dirname(target), isDir: false };
}

/** 路径是否已被占用（目录也算；stat 的失败按“不存在”处理，真正的权限问题留给写入时报）。 */
async function fileExists(path, statImpl) {
  try {
    await statImpl(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * 目录模式下的去重：`foo.mp4` 已存在就试 `foo-2.mp4`、`foo-3.mp4`…
 * 只用于“目录 + 自动文件名”，用户显式给完整文件名时仍按原语义覆盖（首个产物）。
 */
async function uniqueTarget(file, statImpl, { from = 2, limit = 100 } = {}) {
  if (!(await fileExists(file, statImpl))) return file;
  const ext = extname(file);
  const stem = ext ? file.slice(0, -ext.length) : file;
  for (let n = from; n <= limit; n += 1) {
    const candidate = `${stem}-${n}${ext}`;
    if (!(await fileExists(candidate, statImpl))) return candidate;
  }
  throw new Error(`could not find an unused file name next to ${file}`);
}

/**
 * 下载地址只接受公网 https。产物 URL 由上游给出，正常情况下是 COS 签名地址；
 * 这里再挡一道明显的本机/内网字面量，避免一个被篡改的响应把工具变成内网探测器。
 * （域名解析到内网（DNS rebinding）无法在这里完全防住，详见安全文档。）
 */
function assertDownloadUrl(raw) {
  const text = String(raw || '').trim();
  let url;
  try { url = new URL(text); } catch { throw new Error(`invalid artifact URL: ${text.slice(0, 80)}`); }
  if (url.protocol !== 'https:') throw new Error(`refusing to download a non-https artifact URL: ${text.slice(0, 80)}`);
  if (url.username || url.password) throw new Error('refusing to download an artifact URL with credentials');
  // 根点（`localhost.`）不是另一个主机，归一后再判，避免绕过。
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (!host) throw new Error('artifact URL has no usable host');
  const localName = host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local');
  let localIp = false;
  if (host.includes(':')) {
    // 只对 IPv6 字面量做保守判定：:: / ::1 / IPv4-mapped(::ffff:) / ULA / link-local。
    localIp = host === '::' || host === '::1'
      || host.startsWith('::')
      || /^(?:fc|fd|fe[89a-f])/i.test(host);
  } else {
    const parts = host.split('.').map(Number);
    if (parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
      const [a, b] = parts;
      localIp = a === 10 || a === 127 || a === 0
        || (a === 169 && b === 254)
        || (a === 172 && b >= 16 && b <= 31)
        || (a === 192 && b === 168)
        || (a === 100 && b >= 64 && b <= 127)
        || a >= 224;
    }
  }
  if (localName || localIp) {
    throw new Error(`refusing to download an artifact from a private/local host: ${host}`);
  }
  return url;
}

/**
 * 把产物 URL 下载到本地。
 *
 * @param {{
 *   url: string, saveTo: string, id?: string, kind?: 'video'|'image',
 *   mimeType?: string, index?: number,
 * }} request
 * @param {{
 *   fetchImpl?: Function, now?: () => number, mkdirImpl?: Function,
 *   createWriteStreamImpl?: Function, statImpl?: Function,
 *   maxBytes?: number, timeoutMs?: number, index?: number,
 * }} [options]
 * @returns {Promise<{ path: string, bytes: number }>}
 */
export async function saveMediaFile(request, options = {}) {
  const {
    url, saveTo, id, kind = 'video', mimeType, index: requestIndex,
  } = request || {};
  const target = assertDownloadUrl(String(url || '').trim()).toString();
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_DOWNLOAD_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl || fetch;
  const now = options.now || Date.now;
  const mkdirImpl = options.mkdirImpl || mkdir;
  const openWrite = options.createWriteStreamImpl || createWriteStream;
  const statImpl = options.statImpl || stat;
  const index = Math.max(0, Math.trunc(Number(options.index ?? requestIndex) || 0));

  // 目录模式的序号交给磁盘去重（第一个产物不带序号，后续是 -2/-3）；
  // 显式文件名才需要这里按 index 主动分段。
  const fileName = mediaFileName({ id, kind, mimeType, url: target, now: now() });
  const resolved = await resolveTargetPath({ saveTo, fileName });
  let file = resolved.file;
  const { dir, isDir } = resolved;
  if (isDir) {
    // 目录模式绝不覆盖已有产物：同名就换 -2/-3。
    file = await uniqueTarget(file, statImpl);
  } else if (index > 0) {
    // 用户给了完整文件名、但一次有多个产物：首个用原名，后续从 -2 开始加序号。
    file = await uniqueTarget(file, statImpl, { from: index + 1 });
  }
  if (dir) await mkdirImpl(dir, { recursive: true });

  let response;
  try {
    response = await fetchImpl(target, { method: 'GET', signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new Error(`download failed: ${error?.message || error}`, { cause: error });
  }
  if (!response.ok) {
    throw new Error(`download failed: HTTP ${response.status}`);
  }
  const declared = Number(response.headers?.get?.('content-length')) || 0;
  if (declared > maxBytes) {
    throw new Error(`artifact is too large to save (${declared}B > ${maxBytes}B)`);
  }

  // 流式写盘：先写临时文件，成功后再改名，避免半个文件被当成完整产物。
  const partial = `${file}.part`;
  let written = 0;
  const out = openWrite(partial);
  try {
    const body = response.body;
    if (!body) {
      // 某些 fetch 实现没有 body 流：退回整段读取（此时 content-length 已兜过一次）。
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length === 0) throw new Error('artifact is empty');
      if (buffer.length > maxBytes) throw new Error(`artifact is too large to save (${buffer.length}B > ${maxBytes}B)`);
      const { writeFile } = await import('node:fs/promises');
      await writeFile(partial, buffer);
      written = buffer.length;
    } else {
      const source = Readable.fromWeb(body);
      source.on('data', (chunk) => {
        written += chunk.length;
        if (written > maxBytes) source.destroy(new Error(`artifact is too large to save (>${maxBytes}B)`));
      });
      await pipeline(source, out);
    }
    if (written === 0) throw new Error('artifact is empty');
    const { rename } = await import('node:fs/promises');
    await rename(partial, file);
    return { path: file, bytes: written };
  } catch (error) {
    // 失败时不留半截文件：`unlink` 失败（文件没建出来）也不该盖住真正的原因。
    await unlink(partial).catch(() => {});
    throw error instanceof Error ? error : new Error(String(error));
  }
}

/** 人类可读大小，给工具回执用。 */
export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
