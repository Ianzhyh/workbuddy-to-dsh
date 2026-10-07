/** Verify that the at-rest credentials can be opened. Prints no token material. */
import { existsSync, readFileSync } from 'node:fs';
import {
  defaultExecutableCandidates,
  deriveAtRestKeyId,
  envelopeKeyId,
  fetchKeyFor,
  isEncryptedFieldWrapper,
  openEncryptedField,
} from '../lib/atrest.mjs';

const AUTH =
  process.env.WORKBUDDY_AUTH_FILE ||
  'C:\\Users\\demo\\AppData\\Local\\CodeBuddyExtension\\Data\\Public\\auth\\workbuddy-desktop.info';

const raw = JSON.parse(readFileSync(AUTH, 'utf8'));
const field0 = raw.auth?.accessToken;
// 以登录文件信封的 keyId 为基准挑 build（机器上可能并存多个客户端）
const targetKeyId = isEncryptedFieldWrapper(field0) ? envelopeKeyId(field0) || '' : '';

const candidates = defaultExecutableCandidates().filter((p) => p && existsSync(p));
console.log('candidates   :', candidates.length ? candidates.join('\n               ') : '<not found>');
if (candidates.length === 0) process.exit(1);

const t0 = Date.now();
const { exe, key, payloadJson } = await fetchKeyFor(candidates, targetKeyId);
console.log('exe          :', exe);
console.log('key fetch ms :', Date.now() - t0);
console.log('payload keys :', Object.keys(JSON.parse(payloadJson)).join(', '));
console.log('derived keyId:', deriveAtRestKeyId(key));

const present = Object.keys(raw.auth).filter((k) => /token/i.test(k)).join(', ');
console.log('auth *token* :', present);

for (const field of ['accessToken', 'refreshToken']) {
  const node = raw.auth[field];
  if (!isEncryptedFieldWrapper(node)) {
    console.log(`${field.padEnd(13)}: not encrypted (${typeof node})`);
    continue;
  }
  const envKeyId = envelopeKeyId(node);
  process.stdout.write(`${field.padEnd(13)}: envelope keyId=${envKeyId} `);
  if (envKeyId !== deriveAtRestKeyId(key)) {
    console.log('-> MISMATCH (wrong app build)');
    continue;
  }
  const plain = openEncryptedField(node, key);
  console.log(`-> DECRYPTED len=${plain.length} jws-like=${plain.startsWith('eyJ')}`);
}
