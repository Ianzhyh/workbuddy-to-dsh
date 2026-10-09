/**
 * AtRest 凭据信封测试。
 *
 * 这个文件此前是**零直接单测**（211 行，触碰率 0%），却承载凭据红线：
 * 「凭据不落盘」这条产品承诺的正确性完全取决于这里的解密与 keyId 校验。
 * 它跑在两类输入上：
 *   1. 客户端写出的正常信封；
 *   2. **被外部改坏的登录文件**（半截写入、异构 build、手工编辑）——
 *      诊断路径（lib/diagnostics.mjs）正是拿这类输入去拼「为什么不工作」，
 *      所以这里的错误信息会被直接展示给用户。
 *
 * 隔离手法：所有用例只调用**纯函数**（deriveAtRestKey / openEncryptedField /
 * isEncryptedFieldWrapper / envelopeKeyId），
 * 不碰 exe、不碰磁盘、不起进程。需要文件的场景在 diagnose 层测，不在这里。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  deriveAtRestKey,
  deriveAtRestKeyId,
  envelopeKeyId,
  isEncryptedFieldWrapper,
  openEncryptedField,
} from './atrest.mjs';

// ── 夹具：按 atrest.mjs 的算法**独立**重实现一次加密 ────────────────────
// 刻意不复用被测代码的任何内部函数（fieldAad 未导出），否则「同错同对」，
// 测试就失去了证伪能力。这里的常量是照着公开算法抄的第二份实现。

const AAD_DOMAIN = Buffer.from('WB-AAD\0', 'ascii');
const FORMAT_FIELD = 'WBEV1';
const SCHEME = 'sym-v1';
const SUITE = 1;

function u32(n) {
  const b = Buffer.allocUnsafe(4);
  b.writeUInt32BE(n);
  return b;
}
function lp(s) {
  const b = Buffer.from(s, 'utf8');
  return Buffer.concat([u32(b.length), b]);
}
function aad(keyId) {
  return Buffer.concat([
    AAD_DOMAIN,
    Buffer.from([1]),
    lp(FORMAT_FIELD),
    lp(SCHEME),
    u32(SUITE),
    lp(keyId),
    Buffer.from([2]), // FRAMING_CODE.field
    Buffer.from([0]),
    Buffer.from([0]),
  ]);
}

/** 用 node 自带的加密能力做真正的 AES-256-GCM 封装（第二实现）。 */
function encryptField(plain, key, keyIdOverride) {
  const keyId = keyIdOverride || deriveAtRestKeyId(key);
  const nonce = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
  c.setAAD(aad(keyId));
  const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  const envelope = JSON.stringify({
    suite: SUITE,
    keyId,
    nonce: nonce.toString('base64'),
    authTag: c.getAuthTag().toString('base64'),
    ciphertext: body.toString('base64'),
  });
  return { $wbEncrypted: 1, envelope: Buffer.from(envelope, 'utf8').toString('base64') };
}

const KEY = createHash('sha256').update('fake-secret-for-tests').digest();
const KEY_B = createHash('sha256').update('another-build-secret').digest();

// ── 基本契约 ────────────────────────────────────────────────────────────

test('往返：用密钥解开自己封的信封，得到原文', () => {
  const field = encryptField('hello-token', KEY);
  assert.equal(openEncryptedField(field, KEY), 'hello-token');
});

test('keyId 由密钥确定：同一密钥稳定、不同密钥必不同', () => {
  assert.equal(deriveAtRestKeyId(KEY), deriveAtRestKeyId(KEY));
  assert.notEqual(deriveAtRestKeyId(KEY), deriveAtRestKeyId(KEY_B));
  assert.match(deriveAtRestKeyId(KEY), /^[0-9a-f]{16}$/u, 'keyId 必须是 16 位小写 hex');
});

test('deriveAtRestKey 哈希的是 base64 字符串本身，不是解码后的字节', () => {
  const secret = Buffer.from('some-raw-key-material-32bytes!!').toString('base64');
  const key = deriveAtRestKey(JSON.stringify({ atRestSecretKey: secret }));
  const asString = createHash('sha256').update(secret, 'utf8').digest();
  const asBytes = createHash('sha256').update(Buffer.from(secret, 'base64')).digest();
  assert.deepEqual(key, asString, '必须按字符串哈希（与客户端一致）');
  assert.notDeepEqual(key, asBytes, '若按字节哈希，就会与客户端不一致，全盘解不开');
  assert.equal(key.length, 32, 'AES-256 需要 32 字节');
});

test('isEncryptedFieldWrapper：只认形态完全一致的信封', () => {
  assert.equal(isEncryptedFieldWrapper({ $wbEncrypted: 1, envelope: 'x' }), true);
  assert.equal(isEncryptedFieldWrapper({ $wbEncrypted: 1, envelope: 'x', extra: 1 }), false,
    '多一个键就不是信封（防止把任意对象当凭据解）');
  assert.equal(isEncryptedFieldWrapper({ $wbEncrypted: 2, envelope: 'x' }), false);
  assert.equal(isEncryptedFieldWrapper({ $wbEncrypted: 1, envelope: 5 }), false);
  assert.equal(isEncryptedFieldWrapper(null), false);
  assert.equal(isEncryptedFieldWrapper([]), false);
  assert.equal(isEncryptedFieldWrapper('str'), false);
});

// ── 失败分支：诊断路径直接消费这些错误信息 ──────────────────────────────

test('密钥不匹配时明确报「属于另一把钥」，而不是底层的 GCM 校验失败', () => {
  const field = encryptField('secret', KEY_B);
  assert.throws(
    () => openEncryptedField(field, KEY),
    /belongs to key [0-9a-f]{16}, not [0-9a-f]{16}/u,
    '必须给出可读归因（用户要据此判断是不是装了两个客户端）',
  );
});

test('信封缺字段时报可读错误，而不是 SyntaxError / TypeError', () => {
  const mk = (obj) => ({ $wbEncrypted: 1, envelope: Buffer.from(JSON.stringify(obj), 'utf8').toString('base64') });
  const base = { suite: 1, keyId: deriveAtRestKeyId(KEY), nonce: 'AAAAAAAAAAAAAAAA', authTag: 'AAAA', ciphertext: 'AAAA' };

  for (const [drop, label] of [['suite', 'suite'], ['keyId', 'keyId'], ['nonce', 'nonce'], ['authTag', 'authTag'], ['ciphertext', 'ciphertext']]) {
    const obj = { ...base };
    delete obj[drop];
    let msg = '';
    try { openEncryptedField(mk(obj), KEY); } catch (e) { msg = String(e.message); }
    assert.ok(msg, `缺 ${label} 必须抛错`);
    assert.ok(
      !/Unexpected|Cannot read|is not a function|undefined \(reading/u.test(msg),
      `缺 ${label} 的错误信息不能是原始 JS 异常：得到「${msg}」`,
    );
  }
});

test('envelope 不是合法 base64 / 不是 JSON 时，给出可读错误', () => {
  for (const bad of ['!!!not-base64!!!', 'AAAA', '']) {
    let msg = '';
    try { envelopeKeyId({ $wbEncrypted: 1, envelope: bad }); } catch (e) { msg = String(e.message); }
    assert.ok(msg, `坏 envelope「${bad}」必须抛错`);
    assert.ok(
      !/Unexpected token|Unexpected end|Unexpected number/u.test(msg),
      `坏 envelope 的错误信息不能直接漏出 JSON.parse 原文：得到「${msg}」`,
    );
  }
});

test('派生密钥遇到无 atRestSecretKey 的载荷时给出可读错误', () => {
  for (const payload of ['{}', '{"atRestSecretKey":""}', '{"atRestSecretKey":123}']) {
    assert.throws(
      () => deriveAtRestKey(payload),
      /no atRestSecretKey|atRestSecretKey/u,
      `载荷 ${payload} 必须明确报缺少 atRestSecretKey`,
    );
  }
});
// ── 多候选 / 多 build 选钥 ──────────────────────────────────────────────
//
// 故障现场：机器上并存两个客户端 build（国内版 / 国际版、或换目录重装后的
// 旧残留），它们的 atRestSecretKey 不同，而「第一个存在的 exe」未必是写登录
// 文件的那一个。选错钥的症状是 `envelope belongs to key …`，用户看不懂。
//
// 选择规则本身是纯逻辑，直接测 pickKeyCandidate；I/O 的部分（execFile 取载荷）
// 只在下面的集成用例里验证错误传播，不去 mock 进程。

import { pickKeyCandidate, fetchKeyFor, resetKeyPayloadCache } from './atrest.mjs';

/** 造一个"取到了密钥"的候选。 */
function entry(exe, secret) {
  const payloadJson = JSON.stringify({ atRestSecretKey: secret });
  return { exe, key: deriveAtRestKey(payloadJson), payloadJson };
}
/** 造一个"取不到密钥"的候选。 */
function failed(exe, message = 'key fetch failed: boom') {
  return { exe, error: new Error(message) };
}

test('pickKeyCandidate：匹配项不是第一个候选时也必须选中它', () => {
  const target = deriveAtRestKeyId(entry('a', 'secret-A').key);
  const picked = pickKeyCandidate([entry('other', 'secret-B'), entry('right', 'secret-A')], target);
  assert.equal(picked.exe, 'right', '必须跳过 keyId 不匹配的候选');
});

test('pickKeyCandidate：无基准时取第一个成功的', () => {
  const picked = pickKeyCandidate([entry('first', 's1'), entry('second', 's2')], '');
  assert.equal(picked.exe, 'first');
});

test('pickKeyCandidate：有基准但全不匹配时退回第一个成功的（不吞掉 keyId 报错信号）', () => {
  const picked = pickKeyCandidate([entry('only', 's1')], 'ffffffffffffffff');
  assert.equal(picked.exe, 'only', '退回而非抛错，让上层报 envelope belongs to key …');
});

test('pickKeyCandidate：失败的候选被跳过，不影响后续成功者', () => {
  const picked = pickKeyCandidate([failed('bad'), entry('good', 's')], '');
  assert.equal(picked.exe, 'good', '单个 build 取不到密钥不能中断遍历');
});

test('pickKeyCandidate：匹配项在失败候选之后出现，仍要选中它', () => {
  const target = deriveAtRestKeyId(entry('target', 'wanted-secret').key);
  const picked = pickKeyCandidate([failed('bad'), entry('target', 'wanted-secret')], target);
  assert.equal(picked.exe, 'target');
});

test('pickKeyCandidate：全部失败时抛出最后一个真实原因', () => {
  assert.throws(
    () => pickKeyCandidate([failed('a', 'key fetch failed: first'), failed('b', 'key fetch failed: last')], ''),
    /key fetch failed: last/u,
    '必须报最后那个真实原因，而不是笼统的"未找到可执行文件"',
  );
});

test('pickKeyCandidate：空列表时给出可读错误，而不是 undefined', () => {
  assert.throws(() => pickKeyCandidate([], ''), /可执行文件|WorkBuddy/u);
  assert.throws(() => pickKeyCandidate([], 'abc'), /可执行文件|WorkBuddy/u);
});

test('pickKeyCandidate：只有不匹配的候选、且都取不到密钥时，报的是取密钥失败', () => {
  assert.throws(
    () => pickKeyCandidate([failed('a', 'key fetch failed: nope')], 'ffffffffffffffff'),
    /key fetch failed: nope/u,
  );
});

test('fetchKeyFor：候选 exe 不存在时，错误信息可读且含失败原因（不被吞成空）', async () => {
  resetKeyPayloadCache();
  const bogus = join(tmpdir(), 'definitely-not-a-workbuddy-exe.exe');
  assert.equal(existsSync(bogus), false, '前置条件：这个路径必须不存在');
  await assert.rejects(
    () => fetchKeyFor([bogus], ''),
    /key fetch failed/u,
    '取钥失败必须带上原因（spawn ENOENT 等），否则用户无法自查',
  );
});
