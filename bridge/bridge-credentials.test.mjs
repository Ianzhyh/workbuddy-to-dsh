/**
 * 插件凭据的落盘安全（1.20.0）：
 *
 *   1. `active.json` 指向的 `.cred` 解不开（换过密钥/文件损坏）时，要回退到
 *      最近一个**可读**凭据并修好指针 —— 用户还有可用账号，不该每次请求都报错；
 *   2. `store.key` 被轮换（文件变了）时必须重新读取，不能一直用进程里缓存的旧钥；
 *   3. `store.key` 丢失但目录里还有 `.cred` 时**拒绝**静默生成新钥 ——
 *      新钥能工作，旧凭据却永远解不开，用户只会看到"登录过期"。
 *
 * 这些逻辑在桥进程里（没有导出），所以用真实桥 + 真实加密文件跑 HTTP 契约。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pickBridgePort, isPortInUseError } from '../tools/dev/bridge-ports.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(HERE);
const BRIDGE = join(REPO, 'bridge', 'workbuddy-bridge.mjs');
const TOKEN = 'test-token-cred';
const auth = { authorization: `Bearer ${TOKEN}` };

/** 起了的桥进程：失败路径（try 之前抛错）也要能收干净，否则 node --test 不退出。 */
const openBridges = new Set();
test.after(async () => {
  for (const bridge of [...openBridges]) {
    try { await bridge.stop(); } catch { /* 已退出 */ }
  }
});

const KEY_A = randomBytes(32);
const KEY_B = randomBytes(32);
const KEY_C = randomBytes(32);

/** 与桥内 `credentialFileFor()` 同一算法。 */
const credFileFor = (dir, uid) => join(dir, `${createHash('sha256').update(String(uid), 'utf8').digest('hex').slice(0, 24)}.cred`);

/** 与桥内 `sealCredential()` 同一格式（AES-256-GCM + uid 绑定 AAD）。 */
function sealCredential(cred, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(`workbuddy-credential\0${cred.uid}\0v1`, 'utf8'));
  const data = Buffer.concat([cipher.update(JSON.stringify(cred), 'utf8'), cipher.final()]);
  return JSON.stringify({
    v: 1,
    alg: 'aes-256-gcm',
    uid: cred.uid,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  });
}

function credentialRecord(uid) {
  return {
    uid,
    accessToken: `access-${uid}`,
    refreshToken: `refresh-${uid}`,
    expiresAtMs: Date.now() + 86_400_000,
    refreshExpiresAtMs: Date.now() + 7 * 86_400_000,
    region: 'cn',
    endpoint: 'https://example.invalid',
    updatedAt: new Date().toISOString(),
  };
}

/**
 * 造一份凭据目录 + 起桥。
 * @param {{keys?: Array<[string, Buffer]>, active?: string, source?: string, writeStoreKey?: boolean}} setup
 */
async function startWithCredentials(setup) {
  const dir = mkdtempSync(join(tmpdir(), 'wb-cred-test-'));
  const credDir = join(dir, 'credentials');
  mkdirSync(credDir, { recursive: true });
  const authFile = join(dir, 'fake-auth.info');
  writeFileSync(authFile, JSON.stringify({
    auth: {
      accessToken: 'desktop-access',
      refreshToken: 'desktop-refresh',
      domain: 'example.invalid',
      expiresAt: Date.now() + 30 * 86_400_000,
    },
  }));
  for (const [uid, key] of setup.keys || []) {
    writeFileSync(credFileFor(credDir, uid), sealCredential(credentialRecord(uid), key), 'utf8');
  }
  if (setup.writeStoreKey !== false) {
    writeFileSync(join(credDir, 'store.key'), (setup.storeKey || KEY_A).toString('hex'), { mode: 0o600 });
  }
  if (setup.active) {
    writeFileSync(join(credDir, 'active.json'), JSON.stringify({ uid: setup.active, updatedAt: new Date().toISOString() }), 'utf8');
  }
  if (setup.source) {
    writeFileSync(join(credDir, 'source.json'), JSON.stringify({ source: setup.source, updatedAt: new Date().toISOString() }), 'utf8');
  }

  const inherited = { ...process.env };
  for (const key of ['WORKBUDDY_CREDENTIAL_KEY', 'CODEBUDDY_API_KEY', 'WORKBUDDY_CREDENTIAL_SOURCE']) delete inherited[key];

  let lastError = null;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    lastError = null;
    const port = pickBridgePort();
    const child = spawn(process.execPath, [BRIDGE], {
      cwd: dir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...inherited,
        WORKBUDDY_HOST: '127.0.0.1',
        WORKBUDDY_PORT: String(port),
        WORKBUDDY_LOCAL_TOKEN: TOKEN,
        WORKBUDDY_AUTH_FILE: authFile,
        WORKBUDDY_CREDENTIAL_STORE: 'file',
        WORKBUDDY_CREDENTIAL_DIR: credDir,
        WORKBUDDY_USAGE_FILE: join(dir, 'usage.jsonl'),
        WORKBUDDY_MODELS_DEFAULT_FILE: join(dir, 'models-default.json'),
        WORKBUDDY_AUTO_CHECKIN: '0',
        WORKBUDDY_LOG: '0',
      },
    });
    let output = '';
    child.stdout.on('data', (d) => { output += d; });
    child.stderr.on('data', (d) => { output += d; });
    const baseUrl = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 20_000;
    let ready = false;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        lastError = new Error(`桥提前退出（code ${child.exitCode}）：\n${output}`);
        break;
      }
      try {
        const res = await fetch(`${baseUrl}/`, { headers: auth, signal: AbortSignal.timeout(1500) });
        if (res.status > 0) { ready = true; break; }
      } catch { /* 还没起来 */ }
      await new Promise((r) => setTimeout(r, 200));
    }
    if (ready) {
      const handle = {
        baseUrl,
        dir,
        credDir,
        out: () => output,
        stop: () => new Promise((resolve) => {
          openBridges.delete(handle);
          if (child.exitCode !== null) return resolve();
          child.once('exit', resolve);
          child.kill();
          setTimeout(resolve, 2000);
        }),
      };
      openBridges.add(handle);
      return handle;
    }
    child.kill();
    await new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode) { resolve(); return; }
      child.once('exit', resolve);
      setTimeout(resolve, 3000);
    });
    if (!isPortInUseError(output)) break;
  }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
  throw lastError || new Error('桥未就绪');
}

async function json(url, options = {}) {
  const res = await fetch(url, { headers: auth, signal: AbortSignal.timeout(10_000), ...options });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

test('active 凭据解不开：回退到最近可读凭据并修好 active.json', { timeout: 60_000 }, async () => {
  const uidA = 'uid-readable';
  const uidB = 'uid-unreadable';
  const bridge = await startWithCredentials({
    keys: [[uidA, KEY_A], [uidB, KEY_B]], // B 用另一把钥加密 → 当前 store.key 解不开
    active: uidB,
    source: 'plugin',
  });
  try {
    const list = await json(`${bridge.baseUrl}/v1/auth/credentials`);
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.credentials.map((c) => c.uid), [uidA], '读不出的凭据不出现在清单里');

    const health = await json(`${bridge.baseUrl}/health`);
    assert.equal(health.body.auth?.source, 'plugin');
    assert.equal(health.body.auth?.userId, uidA, 'active 坏了要回退到可读凭据，而不是直接报错');
    const active = JSON.parse(readFileSync(join(bridge.credDir, 'active.json'), 'utf8'));
    assert.equal(active.uid, uidA, '回退后必须把 active.json 指针修好');
  } finally { await bridge.stop(); rmSync(bridge.dir, { recursive: true, force: true }); }
});

test('source=plugin 且凭据暂时解不开：不得静默降级到桌面账号', { timeout: 60_000 }, async () => {
  const uidA = 'uid-temporarily-unreadable';
  const bridge = await startWithCredentials({
    // 文件在、但当前 store.key（KEY_A）解不开：这是"暂时读不出"，不是"不存在"
    keys: [[uidA, KEY_B]],
    active: uidA,
    source: 'plugin',
  });
  try {
    const src = await json(`${bridge.baseUrl}/v1/auth/source`);
    assert.equal(src.status, 200);
    assert.equal(src.body.configured, 'plugin',
      '凭据存在但读不出时不能把已保存的 source=plugin 改成 auto');
    assert.notEqual(src.body.effective?.source, 'desktop',
      '不得悄悄改用桌面账号（那是另一个钱包）');
  } finally { await bridge.stop(); rmSync(bridge.dir, { recursive: true, force: true }); }
});

test('store.key 轮换：桥必须重新读取密钥，不能一直用进程里的旧钥', { timeout: 60_000 }, async () => {
  const uidA = 'uid-rotated';
  const bridge = await startWithCredentials({
    keys: [[uidA, KEY_A]],
    active: uidA,
    source: 'plugin',
  });
  try {
    const before = await json(`${bridge.baseUrl}/v1/auth/credentials`);
    assert.deepEqual(before.body.credentials.map((c) => c.uid), [uidA], '初始密钥能解开凭据');

    // 轮换密钥（内容不同、mtime 也变）：用 KEY_C 覆盖 store.key
    const keyFile = join(bridge.credDir, 'store.key');
    writeFileSync(keyFile, KEY_C.toString('hex'), { mode: 0o600 });
    const later = new Date(Date.now() + 5000);
    utimesSync(keyFile, later, later);

    const after = await json(`${bridge.baseUrl}/v1/auth/credentials`);
    assert.equal(after.status, 200);
    assert.deepEqual(after.body.credentials, [],
      '轮换后旧钥必须作废；仍列出凭据说明桥一直用着缓存的旧密钥');
    assert.match(String(after.body.error || ''), /credential|decrypt|unable|错误|unreadable/i);
  } finally { await bridge.stop(); rmSync(bridge.dir, { recursive: true, force: true }); }
});

test('store.key 丢失但已有 .cred：拒绝静默生成新钥（否则旧凭据永久解不开）', { timeout: 60_000 }, async () => {
  const uidA = 'uid-orphan';
  const bridge = await startWithCredentials({
    keys: [[uidA, KEY_A]],
    active: uidA,
    source: 'plugin',
    writeStoreKey: false,
  });
  try {
    const res = await json(`${bridge.baseUrl}/v1/auth/credentials`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.credentials, []);
    assert.match(String(res.body.error || ''), /missing|refusing/i);
    assert.equal(existsSync(join(bridge.credDir, 'store.key')), false,
      '不能静默创建新密钥（那会让已有 .cred 永久无法解密）');
  } finally { await bridge.stop(); rmSync(bridge.dir, { recursive: true, force: true }); }
});
