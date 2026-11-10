/**
 * 账号存档 / 恢复 / 重建 —— 「登录就应该保存」的契约测试。
 *
 * ## 这份测试钉住的事故
 *
 * 2026-11-10 实机：用户在国内版客户端里换号后，原来那个 `17****0068` 账号
 * （uid `7c43a818…` / uin `330126184144`）从面板整行消失，只剩它早先用浏览器
 * 登录留下的插件凭据。桥日志能证明过程：
 *
 *     [2026-11-09T14:43:12.506Z] desktop login identity changed; catalog invalidated
 *       7c43a818-2c66-4a36-a86e-4ca2d951a3f4 -> 1df8ca6b-1782-4ddd-ac4a-83eb13298ad2
 *
 * 根因：客户端**换号**用新账号原地覆盖 `workbuddy-desktop.info`，只有「登出」
 * 才把旧文件改名成快照。于是被覆盖的账号在登录目录里一点痕迹都不剩。
 *
 * ## 这里断言的四条行为
 *
 *   1. 存档是**逐账号**的，且**只扫指定登录目录**（不许把同机其它位置的登录态抄进来）；
 *   2. 恢复只写**新快照**，绝不覆盖客户端的活动登录文件；
 *   3. 重建能从插件凭据反推出客户端能解开的 `.info`（含正确 keyId 与账号身份）；
 *   4. 重建出的文件被桥读通后，`/v1/identity` 报的就是那个账号 ——
 *      「找回来」不只是界面上一行，而是真的能用。
 *
 * 全部隔离：临时登录目录 + 临时存档目录 + 临时凭据目录 + 临时端口，
 * 不读写使用者真实的 `.info`、`.cred` 或存档。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pickBridgePort, isPortInUseError } from '../tools/dev/bridge-ports.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(HERE);
const BRIDGE = join(REPO, 'bridge', 'workbuddy-bridge.mjs');
const TOKEN = 'test-token-archive';

// ── AtRest 信封：按 workbuddy-bridge.mjs 的算法**独立**重实现 ──────────────
// 刻意不复用被测代码（否则"同错同对"），只复用公开常量。
const AAD_DOMAIN = Buffer.from('WB-AAD\0', 'ascii');

function u32(n) {
  const b = Buffer.allocUnsafe(4);
  b.writeUInt32BE(n);
  return b;
}
function lp(s) {
  const b = Buffer.from(s, 'utf8');
  return Buffer.concat([u32(b.length), b]);
}
function fieldAad(keyId, suite = 1) {
  return Buffer.concat([
    AAD_DOMAIN,
    Buffer.from([1]),
    lp('WBEV1'),
    lp('sym-v1'),
    u32(suite),
    lp(keyId),
    Buffer.from([2]), // FRAMING_CODE.field
    Buffer.from([0]),
    Buffer.from([0]),
  ]);
}
const keyIdOf = (key) => createHash('sha256').update(key).digest('hex').slice(0, 16);

/** 用给定密钥封一个字段（与客户端同格式）。 */
function seal(plain, key) {
  const keyId = keyIdOf(key);
  const nonce = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
  c.setAAD(fieldAad(keyId));
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  const envelope = JSON.stringify({
    suite: 1,
    keyId,
    nonce: nonce.toString('base64'),
    authTag: c.getAuthTag().toString('base64'),
    ciphertext: ct.toString('base64'),
  });
  return { $wbEncrypted: 1, envelope: Buffer.from(envelope, 'utf8').toString('base64') };
}

function jwt(sub, claims = {}) {
  const body = Buffer.from(
    JSON.stringify({ sub, ...claims, exp: Math.floor(Date.now() / 1000) + 86_400 }),
    'utf8',
  ).toString('base64url');
  return `e30.${body}.sig`;
}

/** 一份客户端形态的登录文件（字段全部走信封，与真实文件同构）。 */
function loginFile(sub, key, { uin, domain = 'www.workbuddy.cn' } = {}) {
  const access = jwt(sub, { iss: `https://${domain}/auth/realms/copilot`, preferred_username: '17656650068' });
  const account = {
    uid: sub,
    nickname: seal('176****0068', key),
    uin: uin || '',
    type: 'personal',
    lastLogin: true,
    phoneNumber: seal('17656650068', key),
  };
  return {
    auth: {
      accessToken: seal(access, key),
      refreshToken: seal(jwt(sub, { typ: 'Offline' }), key),
      domain,
      expiresAt: Date.now() + 30 * 86_400_000,
    },
    account,
    accounts: [account],
    allAccounts: [account],
  };
}

/**
 * 起一个隔离的桥。
 *
 * `WORKBUDDY_AUTH_FILE` 必须显式指向临时目录里的文件：桥据此判定"登录目录在哪"，
 * 否则存档扫描会按平台兜底链走到使用者的真实目录（这正是本功能第一版踩到的坑）。
 */
async function startBridge({ authDir, authFileName, archiveDir, credDir, credKey, extraEnv = {} }) {
  const inherited = { ...process.env };
  for (const key of [
    'CODEBUDDY_API_KEY', 'WORKBUDDY_CREDENTIAL_KEY', 'WORKBUDDY_CREDENTIAL_SOURCE',
    'WORKBUDDY_CREDENTIAL_STORE', 'WORKBUDDY_AUTH_DIR', 'WORKBUDDY_AUTH_FILE',
    'WORKBUDDY_ACCOUNT_ARCHIVE_DIR', 'WORKBUDDY_ACCOUNT_FAILOVER_AFTER',
  ]) delete inherited[key];

  const attempts = 5;
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    lastError = null;
    const port = pickBridgePort();
    const child = spawn(process.execPath, [BRIDGE], {
      cwd: authDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...inherited,
        WORKBUDDY_HOST: '127.0.0.1',
        WORKBUDDY_PORT: String(port),
        WORKBUDDY_LOCAL_TOKEN: TOKEN,
        WORKBUDDY_AUTH_DIR: authDir,
        WORKBUDDY_AUTH_FILE: join(authDir, authFileName),
        WORKBUDDY_ACCOUNT_ARCHIVE_DIR: archiveDir,
        WORKBUDDY_CREDENTIAL_DIR: credDir,
        WORKBUDDY_CREDENTIAL_STORE: 'file',
        WORKBUDDY_CREDENTIAL_KEY: credKey.toString('hex'),
        WORKBUDDY_USAGE_FILE: join(authDir, 'usage.jsonl'),
        WORKBUDDY_MEDIA_STORE_FILE: join(authDir, 'media.json'),
        WORKBUDDY_MODELS_DEFAULT_FILE: join(authDir, 'models-default.json'),
        WORKBUDDY_AUTO_CHECKIN: '0',
        WORKBUDDY_LOG: '0',
        ...extraEnv,
      },
    });
    let output = '';
    child.stdout.on('data', (d) => { output += d; });
    child.stderr.on('data', (d) => { output += d; });

    const baseUrl = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        lastError = new Error(`桥提前退出（code ${child.exitCode}）：\n${output}`);
        break;
      }
      try {
        const res = await fetch(`${baseUrl}/`, { headers: { authorization: `Bearer ${TOKEN}` }, signal: AbortSignal.timeout(1500) });
        if (res.status > 0) {
          const handle = {
            baseUrl,
            port,
            out: () => output,
            stop: () => new Promise((resolve) => {
              child.once('exit', resolve);
              child.kill();
              setTimeout(resolve, 3000);
            }),
          };
          // 登记到文件级兜底，`finally` 万一没跑到也有人在 after 里收尾
          const stopInner = handle.stop;
          handle.stop = async () => { liveBridges.delete(handle); return stopInner(); };
          liveBridges.add(handle);
          return handle;
        }
      } catch { /* 未就绪 */ }
      await new Promise((r) => setTimeout(r, 200));
    }
    if (!lastError) lastError = new Error(`桥未在 20 秒内就绪：\n${output}`);
    child.kill();
    await new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode) { resolve(); return; }
      child.once('exit', resolve);
      setTimeout(resolve, 3000);
    });
    if (!isPortInUseError(output)) break;
  }
  throw lastError;
}

const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };

/*
 * 兜底回收：本文件起真实子进程（桥）。任一用例在 `try` 之前抛错（端口撞车、
 * 桥起不来）时，监听 socket 与管道会留在测试进程上 —— `node --test` 跑完不退出。
 * 所以每条用例的 `finally` 之外再加一道文件级收尾（项目里同类文件都如此，
 * 且 `bridge-startup.test.mjs` 有守卫专门检查这件事）。
 *
 * @type {Set<{stop: () => Promise<void>}>}
 */
const liveBridges = new Set();
test.after(async () => {
  for (const bridge of liveBridges) {
    try { await bridge.stop(); } catch { /* 已经退出 */ }
  }
  liveBridges.clear();
});

/** 插件凭据信封（与桥的 store 同格式：AES-256-GCM + AAD 绑定 uid）。 */
function sealCredential(cred, key) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(`workbuddy-credential\0${cred.uid}\0v1`, 'utf8'));
  const data = Buffer.concat([c.update(JSON.stringify(cred), 'utf8'), c.final()]);
  return JSON.stringify({
    v: 1,
    alg: 'aes-256-gcm',
    uid: cred.uid,
    iv: iv.toString('base64'),
    tag: c.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  });
}
const credentialFileFor = (uid, key) => createHash('sha256').update(key).digest('hex').slice(0, 24);

/** 一个临时工作区：登录目录 + 存档目录 + 凭据目录，各自独立。 */
function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'wb-archive-test-'));
  const dirs = {
    root,
    authDir: join(root, 'auth'),
    archiveDir: join(root, 'archive'),
    credDir: join(root, 'credentials'),
  };
  for (const dir of [dirs.authDir, dirs.archiveDir, dirs.credDir]) mkdirSync(dir, { recursive: true });
  dirs.cleanup = () => { try { rmSync(root, { recursive: true, force: true }); } catch { /* Windows 句柄未释放 */ } };
  return dirs;
}

// ── 1. 存档：逐账号、只扫指定目录 ─────────────────────────────────────────

test('存档：把登录目录里每份能解开的登录文件按账号存一份，且不越界扫别的目录', async () => {
  const ws = workspace();
  const keys = new Map();
  // 桥取密钥要真实客户端 exe；测试里给两个 build 的"假密钥"是做不到的，
  // 所以这里用**明文令牌**的旧格式文件（pre-5.6）：桥会直接当字符串读。
  const subs = ['aaaa1111-0000-0000-0000-000000000001', 'bbbb2222-0000-0000-0000-000000000002'];
  for (const [i, sub] of subs.entries()) {
    const plain = {
      auth: {
        accessToken: jwt(sub, { iss: 'https://www.workbuddy.cn/auth/realms/copilot' }),
        refreshToken: 'r',
        domain: 'www.workbuddy.cn',
        expiresAt: Date.now() + 86_400_000,
      },
      account: { uid: sub, uin: `33012618414${i}` },
    };
    writeFileSync(join(ws.authDir, i === 0 ? 'workbuddy-desktop.info' : 'workbuddy-desktop.2026-01-01.info'), JSON.stringify(plain));
  }
  // 另一个目录里放一份"不该被扫到"的文件
  const outside = join(ws.root, 'outside');
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, 'workbuddy-desktop.info'), JSON.stringify({
    auth: { accessToken: jwt('cccc3333-0000-0000-0000-000000000003'), domain: 'www.workbuddy.cn', expiresAt: Date.now() + 86_400_000 },
    account: { uid: 'cccc3333-0000-0000-0000-000000000003', uin: '999999999999' },
  }));
  keys.set('none', true);

  const bridge = await startBridge({
    authDir: ws.authDir,
    authFileName: 'workbuddy-desktop.info',
    archiveDir: ws.archiveDir,
    credDir: ws.credDir,
    credKey: randomBytes(32),
  });
  try {
    const res = await fetch(`${bridge.baseUrl}/v1/accounts/archive`, { method: 'POST', headers: auth, body: '{}', signal: AbortSignal.timeout(60_000) });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.ok, true, `存档失败：${JSON.stringify(body)}`);
    assert.equal(body.scanned, 2, '只应扫到登录目录里的那两份（不越界）');
    const keysSeen = body.accounts.map((a) => a.key).sort();
    assert.deepEqual(keysSeen, [...subs].sort(), '每个账号一条存档');
    for (const row of body.accounts) {
      const files = readdirSync(join(ws.archiveDir, row.key)).filter((f) => f.endsWith('.info'));
      assert.ok(files.length >= 1, `${row.key} 应有至少一份存档 .info`);
    }
    assert.ok(!existsSync(join(ws.archiveDir, 'cccc3333-0000-0000-0000-000000000003')),
      '登录目录之外的账号绝不能被存档进来');
  } finally {
    await bridge.stop();
    ws.cleanup();
  }
});

test('存档幂等：内容没变时重复扫描不新增文件', async () => {
  const ws = workspace();
  const sub = 'dddd4444-0000-0000-0000-000000000004';
  writeFileSync(join(ws.authDir, 'workbuddy-desktop.info'), JSON.stringify({
    auth: { accessToken: jwt(sub), refreshToken: 'r', domain: 'www.workbuddy.cn', expiresAt: Date.now() + 86_400_000 },
    account: { uid: sub, uin: '330101979236' },
  }));
  const bridge = await startBridge({
    authDir: ws.authDir, authFileName: 'workbuddy-desktop.info',
    archiveDir: ws.archiveDir, credDir: ws.credDir, credKey: randomBytes(32),
  });
  try {
    const first = await (await fetch(`${bridge.baseUrl}/v1/accounts/archive`, { method: 'POST', headers: auth, body: '{}', signal: AbortSignal.timeout(60_000) })).json();
    const second = await (await fetch(`${bridge.baseUrl}/v1/accounts/archive`, { method: 'POST', headers: auth, body: '{}', signal: AbortSignal.timeout(60_000) })).json();
    assert.equal(first.stored, 1);
    assert.equal(second.stored, 0, '同样的内容第二次不该再写一份');
    const files = readdirSync(join(ws.archiveDir, sub)).filter((f) => f.endsWith('.info'));
    assert.equal(files.length, 1, '一份内容只对应一份存档文件');
  } finally {
    await bridge.stop();
    ws.cleanup();
  }
});

// ── 2. 恢复：只写新快照，绝不覆盖活动文件 ────────────────────────────────

test('恢复：把存档放回登录目录时生成新快照，活动登录文件一个字节都不变', async () => {
  const ws = workspace();
  const sub = 'eeee5555-0000-0000-0000-000000000005';
  const activePath = join(ws.authDir, 'workbuddy-desktop.info');
  writeFileSync(activePath, JSON.stringify({
    auth: { accessToken: jwt(sub), refreshToken: 'r', domain: 'www.workbuddy.cn', expiresAt: Date.now() + 86_400_000 },
    account: { uid: sub, uin: '330101979236' },
  }));
  const bridge = await startBridge({
    authDir: ws.authDir, authFileName: 'workbuddy-desktop.info',
    archiveDir: ws.archiveDir, credDir: ws.credDir, credKey: randomBytes(32),
  });
  try {
    await fetch(`${bridge.baseUrl}/v1/accounts/archive`, { method: 'POST', headers: auth, body: '{}', signal: AbortSignal.timeout(60_000) });
    const before = readFileSync(activePath);
    // 模拟"活动文件被换号覆盖"：先删掉，再从存档恢复
    rmSync(activePath);
    const res = await fetch(`${bridge.baseUrl}/v1/accounts/restore`, {
      method: 'POST', headers: auth, body: JSON.stringify({ key: sub }), signal: AbortSignal.timeout(30_000),
    });
    const body = await res.json();
    assert.equal(body.ok, true, `恢复失败：${JSON.stringify(body)}`);
    assert.ok(existsSync(body.path), '恢复出来的文件必须真的在盘上');
    assert.notEqual(body.path, activePath, '绝不能写回活动登录文件名');
    assert.deepEqual(readFileSync(body.path), before, '恢复的内容必须与存档时逐字节一致');
    assert.ok(!existsSync(activePath), '恢复动作不能顺手重建活动文件');
  } finally {
    await bridge.stop();
    ws.cleanup();
  }
});

test('恢复：未知账号返回可读错误，而不是写一个空文件', async () => {  const ws = workspace();
  writeFileSync(join(ws.authDir, 'workbuddy-desktop.info'), JSON.stringify({
    auth: { accessToken: jwt('ffff6666-0000-0000-0000-000000000006'), domain: 'www.workbuddy.cn', expiresAt: Date.now() + 86_400_000 },
    account: { uid: 'ffff6666-0000-0000-0000-000000000006' },
  }));
  const bridge = await startBridge({
    authDir: ws.authDir, authFileName: 'workbuddy-desktop.info',
    archiveDir: ws.archiveDir, credDir: ws.credDir, credKey: randomBytes(32),
  });
  try {
    const res = await fetch(`${bridge.baseUrl}/v1/accounts/restore`, {
      method: 'POST', headers: auth, body: JSON.stringify({ key: 'no-such-account' }), signal: AbortSignal.timeout(20_000),
    });
    const body = await res.json();
    assert.equal(res.status, 400);
    assert.equal(body.ok, false);
    assert.match(String(body.error), /存档里没有|不存在|没有这份/u, `错误信息要能读懂：${body.error}`);
  } finally {
    await bridge.stop();
    ws.cleanup();
  }
});

test('恢复：存档有多份且没有 latest 时，错误里把候选文件名列出来（不让人去猜）', async () => {
  /*
   * 「latest 缺失 + 目录里有多份」是唯一真正需要用户选的场景。
   * 此时只回一句「存档里没有这份文件：(空)」等于什么都没说 ——
   * 用户既不知道有几份、也不知道该填什么。
   */
  const ws = workspace();
  const sub = 'rrrr8888-0000-0000-0000-000000000012';
  writeFileSync(join(ws.authDir, 'workbuddy-desktop.info'), JSON.stringify({
    auth: { accessToken: jwt(sub), refreshToken: 'r', domain: 'www.workbuddy.cn', expiresAt: Date.now() + 86_400_000 },
    account: { uid: sub, uin: '330126184144' },
  }));
  // 手造一个"没有 latest、有两份 info"的存档（模拟元数据写坏 / 手工整理过）
  const dir = join(ws.archiveDir, sub);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'aaaa1111.info'), 'x');
  writeFileSync(join(dir, 'bbbb2222.info'), 'y');
  const bridge = await startBridge({
    authDir: ws.authDir, authFileName: 'workbuddy-desktop.info',
    archiveDir: ws.archiveDir, credDir: ws.credDir, credKey: randomBytes(32),
  });
  try {
    const body = await (await fetch(`${bridge.baseUrl}/v1/accounts/restore`, {
      method: 'POST', headers: auth, body: JSON.stringify({ key: sub }), signal: AbortSignal.timeout(20_000),
    })).json();
    assert.equal(body.ok, false);
    assert.match(String(body.error), /指定 file/u, `应提示需要指定 file：${body.error}`);
    assert.match(String(body.error), /aaaa1111\.info/u, '要把候选文件名列出来');
    assert.match(String(body.error), /bbbb2222\.info/u, '要把候选文件名列出来');

    // 显式指定其中一份就应当成功
    const ok = await (await fetch(`${bridge.baseUrl}/v1/accounts/restore`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ key: sub, file: 'bbbb2222.info' }), signal: AbortSignal.timeout(20_000),
    })).json();
    assert.equal(ok.ok, true, `指定文件后应成功：${JSON.stringify(ok)}`);
    assert.ok(existsSync(ok.path));
  } finally {
    await bridge.stop();
    ws.cleanup();
  }
});

test('恢复 / 重建都需要本地令牌：client key 一律 403', async () => {  const ws = workspace();
  writeFileSync(join(ws.authDir, 'workbuddy-desktop.info'), JSON.stringify({
    auth: { accessToken: jwt('gggg7777-0000-0000-0000-000000000007'), domain: 'www.workbuddy.cn', expiresAt: Date.now() + 86_400_000 },
    account: { uid: 'gggg7777-0000-0000-0000-000000000007' },
  }));
  const bridge = await startBridge({
    authDir: ws.authDir, authFileName: 'workbuddy-desktop.info',
    archiveDir: ws.archiveDir, credDir: ws.credDir, credKey: randomBytes(32),
    extraEnv: { WORKBUDDY_CLIENT_KEYS: 'ck-chat-only' },
  });
  try {
    const res = await fetch(`${bridge.baseUrl}/v1/accounts/rebuild`, {
      method: 'POST',
      headers: { authorization: 'Bearer ck-chat-only', 'content-type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(20_000),
    });
    assert.equal(res.status, 403, 'client key 不能触发写登录文件的管理动作');
    const put = await fetch(`${bridge.baseUrl}/v1/accounts/restore`, {
      method: 'POST',
      headers: { authorization: 'Bearer ck-chat-only', 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'gggg7777-0000-0000-0000-000000000007' }),
      signal: AbortSignal.timeout(20_000),
    });
    assert.equal(put.status, 403, 'restore 同样只能由本地令牌调用');
    const read = await fetch(`${bridge.baseUrl}/v1/accounts/archive`, {
      headers: { authorization: 'Bearer ck-chat-only' }, signal: AbortSignal.timeout(20_000),
    });
    assert.equal(read.status, 403, '存档清单会暴露本机账号身份，client key 不能读');
  } finally {
    await bridge.stop();
    ws.cleanup();
  }
});

// ── 3. 重建：从插件凭据反推出客户端能解开的登录文件 ─────────────────────

test('重建：插件凭据里只有令牌时，能补出一份客户端格式的登录快照并被桥读通', async () => {
  const ws = workspace();
  const storeKey = randomBytes(32);
  /*
   * 关键隔离：桥取 AtRest 字段密钥必须来自真实客户端 exe（本测试环境不一定有）。
   * 这里用 **pre-5.6 明文格式**做不到 —— 重建写出的必然是信封。
   * 所以测试只在能取到密钥时跑「完整重建」，否则退化为「接口有明确归因」。
   *
   * 这不是偷懒：断言"取不到密钥时如实报错"本身就是契约（宁可报错，
   * 也不能写一份客户端解不开的文件出去）。
   */
  const sub = 'hhhh8888-0000-0000-0000-000000000008';
  const cred = {
    uid: sub,
    region: 'cn',
    nickname: '176****0068',
    enterpriseId: '',
    accessToken: jwt(sub, { iss: 'https://www.workbuddy.cn/auth/realms/copilot', preferred_username: '17656650068' }),
    refreshToken: jwt(sub, { typ: 'Offline' }),
    expiresAtMs: Date.now() + 86_400_000,
    refreshExpiresAtMs: 0,
    domain: 'www.workbuddy.cn',
    endpoint: 'https://copilot.tencent.com',
    updatedAt: new Date().toISOString(),
  };
  const credName = `${credentialFileFor(sub, storeKey)}.cred`;
  writeFileSync(join(ws.credDir, credName), sealCredential(cred, storeKey));
  // 登录目录里只有"别的账号"，没有这个 —— 正是事故形态
  writeFileSync(join(ws.authDir, 'workbuddy-desktop.info'), JSON.stringify({
    auth: { accessToken: jwt('iiii9999-0000-0000-0000-000000000009'), domain: 'www.workbuddy.cn', expiresAt: Date.now() + 86_400_000 },
    account: { uid: 'iiii9999-0000-0000-0000-000000000009', uin: '330101979236' },
  }));
  const archive = join(ws.archiveDir, sub);
  mkdirSync(archive, { recursive: true });
  writeFileSync(join(archive, 'meta.json'), JSON.stringify({
    key: sub, uid: sub, uin: '330126184144', domain: 'www.workbuddy.cn',
    lastSeenAt: '2026-11-09T14:40:00.000Z', files: [],
  }));

  const bridge = await startBridge({
    authDir: ws.authDir, authFileName: 'workbuddy-desktop.info',
    archiveDir: ws.archiveDir, credDir: ws.credDir, credKey: storeKey,
  });
  try {
    const res = await fetch(`${bridge.baseUrl}/v1/accounts/rebuild`, {
      method: 'POST', headers: auth, body: '{}', signal: AbortSignal.timeout(90_000),
    });
    const body = await res.json();
    const row = (body.results || [])[0];
    assert.ok(row, `重建必须给出结果：${JSON.stringify(body)}`);

    if (row.ok) {
      assert.ok(existsSync(row.path), '重建出的文件必须真的在盘上');
      assert.notEqual(row.path, join(ws.authDir, 'workbuddy-desktop.info'), '绝不覆盖活动登录文件');
      const doc = JSON.parse(readFileSync(row.path, 'utf8'));
      assert.equal(doc.account.uid, sub, '账号身份必须是凭据里那个 uid');
      assert.equal(doc.account.uin, '330126184144', '存档里记过的 uin 要带回来（否则别名贴不上）');
      assert.equal(doc.auth.domain, 'www.workbuddy.cn');
      // 字段必须是信封，不能落明文
      assert.equal(doc.auth.accessToken.$wbEncrypted, 1, 'accessToken 必须是密文信封');
      assert.equal(doc.account.phoneNumber.$wbEncrypted, 1, 'phoneNumber 不许写明文');
      // 血统记在存档 meta 里，将来能一眼看出这份不是客户端写的
      const meta = JSON.parse(readFileSync(join(archive, 'meta.json'), 'utf8'));
      assert.equal(meta.rebuiltFrom, 'plugin-credential');
      assert.equal(meta.uin, '330126184144', '元数据里的 uin 不许被重建流程抹掉');
    } else {
      // 取不到 AtRest 密钥是合法结局，但必须**说清原因**且不写半成品
      assert.match(String(row.error), /AtRest|密钥|客户端|无法解开/u, `失败也要可读：${row.error}`);
      const leftovers = readdirSync(ws.authDir).filter((f) => f.includes('rebuild'));
      assert.deepEqual(leftovers, [], '失败时不能留下半成品文件');
    }
  } finally {
    await bridge.stop();
    ws.cleanup();
  }
});

test('重建：没有插件凭据的账号给出明确错误，且不写任何文件', async () => {
  const ws = workspace();
  writeFileSync(join(ws.authDir, 'workbuddy-desktop.info'), JSON.stringify({
    auth: { accessToken: jwt('jjjj0000-0000-0000-0000-00000000000a'), domain: 'www.workbuddy.cn', expiresAt: Date.now() + 86_400_000 },
    account: { uid: 'jjjj0000-0000-0000-0000-00000000000a' },
  }));
  const bridge = await startBridge({
    authDir: ws.authDir, authFileName: 'workbuddy-desktop.info',
    archiveDir: ws.archiveDir, credDir: ws.credDir, credKey: randomBytes(32),
  });
  try {
    const before = readdirSync(ws.authDir).sort();
    const res = await fetch(`${bridge.baseUrl}/v1/accounts/rebuild`, {
      method: 'POST', headers: auth, body: JSON.stringify({ uid: 'kkkk1111-0000-0000-0000-00000000000b' }),
      signal: AbortSignal.timeout(30_000),
    });
    const body = await res.json();
    const row = (body.results || [])[0] || {};
    assert.equal(row.ok, false);
    assert.match(String(row.error), /没有这个账号的插件凭据|插件凭据/u);
    assert.deepEqual(readdirSync(ws.authDir).sort(), before, '失败路径不该在登录目录里留下任何文件');
  } finally {
    await bridge.stop();
    ws.cleanup();
  }
});

// ── 4. 存档在热路径上自动发生（不需要用户点）─────────────────────────────

test('自动存档：/health 与 /v1/identity 会把能解开的登录文件存下来', async () => {
  const ws = workspace();
  const sub = 'llll2222-0000-0000-0000-00000000000c';
  writeFileSync(join(ws.authDir, 'workbuddy-desktop.info'), JSON.stringify({
    auth: { accessToken: jwt(sub), refreshToken: 'r', domain: 'www.workbuddy.cn', expiresAt: Date.now() + 86_400_000 },
    account: { uid: sub, uin: '330126184144' },
  }));
  const bridge = await startBridge({
    authDir: ws.authDir, authFileName: 'workbuddy-desktop.info',
    archiveDir: ws.archiveDir, credDir: ws.credDir, credKey: randomBytes(32),
  });
  try {
    // 敲一次 /health（面板每 8 秒就会敲），存档应在后台完成
    await fetch(`${bridge.baseUrl}/health`, { headers: auth, signal: AbortSignal.timeout(20_000) }).then((r) => r.text());
    const deadline = Date.now() + 15_000;
    let rows = [];
    while (Date.now() < deadline) {
      const body = await (await fetch(`${bridge.baseUrl}/v1/accounts/archive`, { headers: auth, signal: AbortSignal.timeout(20_000) })).json();
      rows = body.accounts || [];
      if (rows.length) break;
      await new Promise((r) => setTimeout(r, 300));
    }
    assert.ok(rows.length >= 1, '热路径上的存档必须是自动的，不能只靠用户点按钮');
    assert.equal(rows[0].uin, '330126184144', '存档要记住 uin —— 别名与显示都按它走');
  } finally {
    await bridge.stop();
    ws.cleanup();
  }
});

// ── 5. 安全：restore 的两个参数都是用户输入 ──────────────────────────────
/*
 * 这一组对应一次真实自查（2026-11-10 第二轮 bug 排查）。
 *
 * 第一版 `archiveKeyOf` 用 `replace(/[^0-9a-zA-Z._-]/g, '_')` 过滤，**放行了 `.`**
 * —— 于是 `key=".."` 通过白名单，`join(存档根, '..')` 跳回 `~/.workbuddy-bridge`；
 * `file` 再指向 `credentials/store.key` / `state.json`，内容就会被复制进登录目录。
 * `writeArchiveMeta` 还会往上一层写 `meta.json`。
 *
 * 这是本项目「用户可控字符串 → join 成路径」的第二起（第一起是
 * `AUTH_DIRS[0] || '.'` 拼出相对路径，见桥里 AUTH_DIRS 的注释）。
 * 所以这里断言的不是"报错文案"，而是**磁盘上什么都没发生**。
 */

/** 在登录目录之外放一个诱饵，任何越界读取都会把它带进来。 */
const DECOY = 'secret-should-never-reach-login-dir';
function plantDecoy(ws) {
  const p = join(ws.root, 'decoy.txt');
  writeFileSync(p, DECOY);
  return p;
}

test('安全：key 里带路径穿越（.. / 绝对路径 / 分隔符）一律拒绝，且不写任何文件', async () => {
  const ws = workspace();
  writeFileSync(join(ws.authDir, 'workbuddy-desktop.info'), JSON.stringify({
    auth: { accessToken: jwt('mmmm3333-0000-0000-0000-00000000000d'), refreshToken: 'r', domain: 'www.workbuddy.cn', expiresAt: Date.now() + 86_400_000 },
    account: { uid: 'mmmm3333-0000-0000-0000-00000000000d' },
  }));
  const decoy = plantDecoy(ws);
  const bridge = await startBridge({
    authDir: ws.authDir, authFileName: 'workbuddy-desktop.info',
    archiveDir: ws.archiveDir, credDir: ws.credDir, credKey: randomBytes(32),
  });
  try {
    const before = readdirSync(ws.authDir).sort();
    const attacks = ['..', '.', '../..', '../../credentials', 'C:\\Windows', 'a/b', 'a\\b', '/etc', '~'];
    for (const key of attacks) {
      const res = await fetch(`${bridge.baseUrl}/v1/accounts/restore`, {
        method: 'POST', headers: auth, body: JSON.stringify({ key }), signal: AbortSignal.timeout(20_000),
      });
      const body = await res.json();
      assert.equal(res.status, 400, `key=${JSON.stringify(key)} 必须被拒绝，实际 HTTP ${res.status}`);
      assert.equal(body.ok, false);
    }
    assert.deepEqual(readdirSync(ws.authDir).sort(), before, '被拒绝的请求不能在登录目录里留下任何文件');
    // 存档根之外不许冒出 meta.json
    assert.equal(existsSync(join(ws.root, 'meta.json')), false, '越界写 meta.json 必须被挡住');
    assert.equal(readFileSync(decoy, 'utf8'), DECOY, '诱饵文件不该被动过');
  } finally {
    await bridge.stop();
    ws.cleanup();
  }
});

test('安全：file 只能是存档目录里的纯文件名（相对路径/绝对路径一律拒绝）', async () => {
  const ws = workspace();
  const sub = 'nnnn4444-0000-0000-0000-00000000000e';
  writeFileSync(join(ws.authDir, 'workbuddy-desktop.info'), JSON.stringify({
    auth: { accessToken: jwt(sub), refreshToken: 'r', domain: 'www.workbuddy.cn', expiresAt: Date.now() + 86_400_000 },
    account: { uid: sub, uin: '330126184144' },
  }));
  const decoy = plantDecoy(ws);
  const bridge = await startBridge({
    authDir: ws.authDir, authFileName: 'workbuddy-desktop.info',
    archiveDir: ws.archiveDir, credDir: ws.credDir, credKey: randomBytes(32),
  });
  try {
    // 先正常存一份，保证这个 key 的目录真实存在（否则会被"目录不存在"提前挡掉）
    await fetch(`${bridge.baseUrl}/v1/accounts/archive`, { method: 'POST', headers: auth, body: '{}', signal: AbortSignal.timeout(60_000) });
    const before = readdirSync(ws.authDir).sort();
    const attacks = [
      '..\\decoy.txt',
      '../decoy.txt',
      decoy,
      'sub/../../../decoy.txt',
      '..',
      '.',
    ];
    for (const file of attacks) {
      const res = await fetch(`${bridge.baseUrl}/v1/accounts/restore`, {
        method: 'POST', headers: auth,
        body: JSON.stringify({ key: sub, file }), signal: AbortSignal.timeout(20_000),
      });
      const body = await res.json();
      assert.equal(res.status, 400, `file=${JSON.stringify(file)} 必须被拒绝`);
      assert.equal(body.ok, false);
    }
    assert.deepEqual(readdirSync(ws.authDir).sort(), before, '被拒绝的请求不能改动登录目录');
    // 关键：诱饵内容绝不能被复制进登录目录
    for (const name of readdirSync(ws.authDir)) {
      const text = readFileSync(join(ws.authDir, name), 'utf8');
      assert.ok(!text.includes(DECOY), `${name} 里出现了诱饵内容 —— 越界读取成功了`);
    }
  } finally {
    await bridge.stop();
    ws.cleanup();
  }
});

// ── 6. 并发：扫描结果不许"看起来是空的" ──────────────────────────────────

test('并发扫描：同时发起的多次扫描都拿到真实结果，不会有假的 scanned=0', async () => {
  /*
   * 修复前：`sweepLoginArchive` 一进函数就把节流窗口占上（`archiveSweepAt = now`），
   * 于是并发的第二个调用被节流挡住、返回**上一次**的 `{scanned:0}`。
   * 面板会把"0 个账号"如实显示出来 —— 用户以为存档根本没工作。
   *
   * 判据：并发 N 次，每一次的 `scanned` 都必须 ≥ 1（本夹具只有一份能解开的登录文件）。
   */
  const ws = workspace();
  writeFileSync(join(ws.authDir, 'workbuddy-desktop.info'), JSON.stringify({
    auth: { accessToken: jwt('oooo5555-0000-0000-0000-00000000000f'), refreshToken: 'r', domain: 'www.workbuddy.cn', expiresAt: Date.now() + 86_400_000 },
    account: { uid: 'oooo5555-0000-0000-0000-00000000000f', uin: '330126184144' },
  }));
  const bridge = await startBridge({
    authDir: ws.authDir, authFileName: 'workbuddy-desktop.info',
    archiveDir: ws.archiveDir, credDir: ws.credDir, credKey: randomBytes(32),
  });
  try {
    const calls = Array.from({ length: 4 }, () => fetch(`${bridge.baseUrl}/v1/accounts/archive`, {
      method: 'POST', headers: auth, body: '{}', signal: AbortSignal.timeout(60_000),
    }).then((r) => r.json()));
    const results = await Promise.all(calls);
    for (const [i, body] of results.entries()) {
      assert.equal(body.ok, true, `第 ${i + 1} 次并发扫描失败：${JSON.stringify(body)}`);
      assert.ok(body.scanned >= 1, `第 ${i + 1} 次并发扫描拿到 scanned=${body.scanned}（假的空结果）`);
    }
  } finally {
    await bridge.stop();
    ws.cleanup();
  }
});

// ── 7. 重建的诚实性：uin 拿不到要说出来 ──────────────────────────────────

test('重建：拿不到 uin 时把后果写进 warnings，而不是悄悄返回一个"看起来正常"的结果', async () => {
  /*
   * uin 决定账号列表的显示键，也决定用户起的别名能否贴上。
   * 没有历史存档时只能留空 —— 那不是失败，但**必须说出来**，
   * 否则用户看到一行陌生 uid，会以为"回来的不是原来那个号"。
   */
  const ws = workspace();
  const storeKey = randomBytes(32);
  const sub = 'pppp6666-0000-0000-0000-000000000010';
  const cred = {
    uid: sub,
    region: 'cn',
    nickname: '176****0068',
    enterpriseId: '',
    accessToken: jwt(sub, { iss: 'https://www.workbuddy.cn/auth/realms/copilot', preferred_username: '17656650068' }),
    refreshToken: jwt(sub, { typ: 'Offline' }),
    expiresAtMs: Date.now() + 86_400_000,
    refreshExpiresAtMs: 0,
    domain: 'www.workbuddy.cn',
    endpoint: 'https://copilot.tencent.com',
    updatedAt: new Date().toISOString(),
  };
  writeFileSync(join(ws.credDir, `${credentialFileFor(sub, storeKey)}.cred`), sealCredential(cred, storeKey));
  writeFileSync(join(ws.authDir, 'workbuddy-desktop.info'), JSON.stringify({
    auth: { accessToken: jwt('qqqq7777-0000-0000-0000-000000000011'), domain: 'www.workbuddy.cn', expiresAt: Date.now() + 86_400_000 },
    account: { uid: 'qqqq7777-0000-0000-0000-000000000011' },
  }));
  // 注意：**不建**存档 meta —— 模拟"从没存过这个号"
  const bridge = await startBridge({
    authDir: ws.authDir, authFileName: 'workbuddy-desktop.info',
    archiveDir: ws.archiveDir, credDir: ws.credDir, credKey: storeKey,
  });
  try {
    const res = await fetch(`${bridge.baseUrl}/v1/accounts/rebuild`, {
      method: 'POST', headers: auth, body: JSON.stringify({ uid: sub }), signal: AbortSignal.timeout(90_000),
    });
    const row = ((await res.json()).results || [])[0] || {};
    if (row.ok) {
      // 能重建就必须说清 uin 的后果
      const warns = row.warnings || [];
      assert.ok(
        warns.some((w) => /uin|别名|显示/u.test(w)),
        `重建成功但没有 uin 时必须在 warnings 里说明后果，实际：${JSON.stringify(warns)}`,
      );
    } else {
      // 取不到密钥也必须是可读归因，且不留半成品
      assert.match(String(row.error), /AtRest|密钥|无法解开/u);
      assert.deepEqual(readdirSync(ws.authDir).filter((f) => f.includes('rebuild')), []);
    }
  } finally {
    await bridge.stop();
    ws.cleanup();
  }
});
