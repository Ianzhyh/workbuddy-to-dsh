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
 * 进程级缓存。
 *
 * 取密钥要**启动一个 Electron 进程**（约 340ms），而控制台每 20 秒轮询一次
 * 状态、每次还要查两遍（凭据 + 账号列表）——不缓存等于每 20 秒拉起
 * 2 个 WorkBuddy.exe。密钥来自客户端构建，进程存活期间不会变，缓存没有副作用。
 */
let keyPayloadCache = null;

/** Ask the installed desktop app for its key payload over its own binary. */
export function fetchKeyPayload(executable) {
  if (keyPayloadCache) return keyPayloadCache;

  const script =
    "try{process.stdout.write(process._linkedBinding('electron_browser_workbuddy_storage').loggerGet())}" +
    'catch(e){process.exitCode=3;process.stderr.write(String((e&&e.message)||e))}';

  keyPayloadCache = new Promise((resolve, reject) => {
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
          keyPayloadCache = null; // 失败不缓存，下次仍可重试
          reject(new Error(`key fetch failed: ${stderr || error.message}`));
          return;
        }
        resolve(stdout);
      },
    );
  });

  return keyPayloadCache;
}

/** 清空密钥缓存（客户端换版本、重新登录后需要重新取）。 */
export function resetKeyPayloadCache() {
  keyPayloadCache = null;
}

/**
 * Locate the WorkBuddy desktop executable.
 * Overridable with WORKBUDDY_APP_EXECUTABLE.
 */
export function defaultExecutableCandidates() {
  const explicit = process.env.WORKBUDDY_APP_EXECUTABLE;
  const out = [];
  if (explicit) out.push(explicit);
  if (process.platform === 'win32') {
    for (const root of [process.env.LOCALAPPDATA, process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)']]) {
      if (root) out.push(`${root}\\Programs\\WorkBuddy\\WorkBuddy.exe`);
    }
    out.push('E:\\App\\WorkBuddy\\WorkBuddy.exe');
  } else if (process.platform === 'darwin') {
    out.push('/Applications/WorkBuddy.app/Contents/MacOS/WorkBuddy');
    out.push('/Applications/WorkBuddy AI.app/Contents/MacOS/WorkBuddy');
  } else {
    out.push('/opt/WorkBuddy/workbuddy');
  }
  return out;
}

export { envelopeKeyId };
