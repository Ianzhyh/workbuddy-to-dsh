/**
 * WorkBuddy at-rest credential opener.
 *
 * WorkBuddy desktop 5.6.0+ seals sensitive auth fields with an AES-256-GCM
 * envelope (`{"$wbEncrypted":1,"envelope":"<base64>"}`). The field key is not
 * stored on disk: it is derived from a build-time secret that the app exposes
 * only through its own Electron native binding, so we ask the installed app
 * for it by running its binary as plain Node.
 *
 * Reimplemented from the public algorithm used by dsh-workbuddy-xdpool
 * (src/at-rest.ts). No key material is bundled here; every call reads it from
 * the app that wrote the file.
 */
import { execFile } from 'node:child_process';
import { createDecipheriv, createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { probeSystemSignalsExe, workBuddyExeCandidates } from './find-workbuddy.mjs';

const FRAMING_CODE = { file: 1, field: 2, record: 3, stream: 4 };
const STANDARD_FORMAT_ID = { file: 'WBEF1', field: 'WBEV1', record: 'WBER1', stream: 'WBES1' };
const AAD_DOMAIN = Buffer.from('WB-AAD\0', 'ascii');
const SYMMETRIC_SCHEME = 'sym-v1';
const KEY_FETCH_TIMEOUT_MS = 20000;

function encodeUint32(value) {
  const bytes = Buffer.allocUnsafe(4);
  bytes.writeUInt32BE(value);
  return bytes;
}

function encodeLengthPrefixed(value) {
  const bytes = Buffer.from(value, 'utf8');
  return Buffer.concat([encodeUint32(bytes.length), bytes]);
}

/** Additional authenticated data for a FIELD-framed `sym-v1` envelope. */
function fieldAad(keyId, suite, scheme = SYMMETRIC_SCHEME) {
  if (!/^[0-9a-f]{16}$/u.test(keyId)) throw new Error('envelope keyId is malformed');
  return Buffer.concat([
    AAD_DOMAIN,
    Buffer.from([1]),
    encodeLengthPrefixed(STANDARD_FORMAT_ID.field),
    encodeLengthPrefixed(scheme),
    encodeUint32(suite),
    encodeLengthPrefixed(keyId),
    Buffer.from([FRAMING_CODE.field]),
    Buffer.from([0]),
    Buffer.from([0]),
  ]);
}

/** Whether a value is the app's encrypted-field wrapper. */
export function isEncryptedFieldWrapper(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  return (
    keys.length === 2 &&
    keys[0] === '$wbEncrypted' &&
    keys[1] === 'envelope' &&
    value.$wbEncrypted === 1 &&
    typeof value.envelope === 'string'
  );
}

function envelopeKeyId(field) {
  const record = JSON.parse(Buffer.from(field.envelope, 'base64').toString('utf8'));
  return typeof record.keyId === 'string' ? record.keyId : undefined;
}

/** 32-byte field key derived from the app's key payload JSON. */
export function deriveAtRestKey(payloadJson) {
  const payload = JSON.parse(payloadJson);
  const secret = payload.atRestSecretKey;
  if (typeof secret !== 'string' || secret === '') {
    throw new Error('at-rest key payload carries no atRestSecretKey');
  }
  // The app hashes the base64 STRING, not its decoded bytes.
  return createHash('sha256').update(secret, 'utf8').digest();
}

export function deriveAtRestKeyId(key) {
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

/** Open one encrypted field with a derived key. */
export function openEncryptedField(field, key) {
  const envelope = JSON.parse(Buffer.from(field.envelope, 'base64').toString('utf8'));
  const { suite, keyId, nonce, authTag, ciphertext } = envelope;
  if (typeof suite !== 'number' || typeof keyId !== 'string') {
    throw new Error('envelope is missing suite or keyId');
  }
  if (typeof nonce !== 'string' || typeof authTag !== 'string' || typeof ciphertext !== 'string') {
    throw new Error('envelope is missing nonce, authTag or ciphertext');
  }
  const expected = deriveAtRestKeyId(key);
  if (keyId !== expected) {
    throw new Error(`envelope belongs to key ${keyId}, not ${expected}`);
  }
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(nonce, 'base64'), {
    authTagLength: 16,
  });
  decipher.setAAD(fieldAad(keyId, suite));
  decipher.setAuthTag(Buffer.from(authTag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

/**
 * 进程级缓存（按 exe 分别缓存）。
 *
 * 取密钥要**启动一个 Electron 进程**（约 340ms），而控制台每 20 秒轮询一次
 * 状态、每次还要查两遍（凭据 + 账号列表）——不缓存等于每 20 秒拉起
 * 2 个 WorkBuddy.exe。密钥来自客户端构建，进程存活期间不会变，缓存没有副作用。
 *
 * 之所以按 exe 分开缓存：机器上可能并存多个 build（国内版 / 国际版），
 * 选密钥时要逐个候选试（见 fetchKeyFor）——只缓存"第一个"会让后续候选
 * 直接拿到别的 exe 的载荷，永远试不出正确的那把钥。
 */
const keyPayloadCache = new Map();

/** Ask the installed desktop app for its key payload over its own binary. */
export function fetchKeyPayload(executable) {
  const slot = String(executable || '');
  const cached = keyPayloadCache.get(slot);
  if (cached) return cached;

  const script =
    "try{process.stdout.write(process._linkedBinding('electron_browser_workbuddy_storage').loggerGet())}" +
    'catch(e){process.exitCode=3;process.stderr.write(String((e&&e.message)||e))}';

  const pending = new Promise((resolve, reject) => {
    execFile(
      executable,
      ['-e', script],
      {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        timeout: KEY_FETCH_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 1048576,
      },
      (error, stdout, stderr) => {
        if (error) {
          keyPayloadCache.delete(slot); // 失败不缓存，下次仍可重试
          reject(new Error(`key fetch failed: ${stderr || error.message}`));
          return;
        }
        resolve(stdout);
      },
    );
  });

  keyPayloadCache.set(slot, pending);
  return pending;
}

/**
 * 依次尝试候选可执行文件，返回**与目标 keyId 匹配**的那个密钥。
 *
 * 机器上可能并存多个 WorkBuddy build（不同安装目录 / 国内版国际版），它们的
 * atRestSecretKey 未必相同——"第一个存在的 exe"未必是写登录文件的那个
 * （症状：`envelope belongs to key …`）。按信封 keyId 挑可以消除这种不确定性；
 * 一个都不匹配时退回第一个成功的，让上层的 keyId 校验如实报错。
 *
 * @param {string[]} candidates 候选 exe 路径（调用方已过滤存在的）
 * @param {string} [targetKeyId] 登录文件信封里的 keyId（'' = 无基准，取第一个成功的）
 * @returns {Promise<{ exe: string, key: Buffer, payloadJson: string }>}
 */
export async function fetchKeyFor(candidates, targetKeyId = '') {
  let fallback = null;
  let lastError = null;
  for (const exe of candidates) {
    try {
      const payloadJson = await fetchKeyPayload(exe);
      const key = deriveAtRestKey(payloadJson);
      if (!targetKeyId || deriveAtRestKeyId(key) === targetKeyId) {
        return { exe, key, payloadJson };
      }
      if (!fallback) fallback = { exe, key, payloadJson };
    } catch (err) {
      lastError = err; // 这个 exe 取不到密钥：换下一个候选
    }
  }
  if (fallback) return fallback;
  throw lastError || new Error('未找到可用的 WorkBuddy 可执行文件');
}

/** 清空密钥缓存（客户端换版本、重新登录后需要重新取）。 */
export function resetKeyPayloadCache() {
  keyPayloadCache.clear();
}

/**
 * Locate the WorkBuddy desktop executable.
 * Overridable with WORKBUDDY_APP_EXECUTABLE.
 *
 * 候选 = 静态常用位置 + 磁盘浅扫描（+ 全 miss 时的系统信号兜底）。
 * 只列静态路径在"客户端换目录重装"后会全部落空（然后桥取密钥报
 * `spawnSync … ENOENT`），所以扫描与系统信号兜底是必须的。
 * 探测算法与缓存见 find-workbuddy.mjs（桥侧 resolveWorkBuddyExe 为同款内联）。
 */
export function defaultExecutableCandidates() {
  const base = workBuddyExeCandidates();
  // 廉价层全 miss 才动 PowerShell 兜底（冷启动数秒，勿在常规路径触发）
  if (base.some((p) => existsSync(p))) return base;
  return [...base, ...probeSystemSignalsExe()];
}

export { envelopeKeyId };
