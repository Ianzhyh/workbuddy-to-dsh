/** Verify that the at-rest credentials can be opened. Prints no token material. */
import { existsSync, readFileSync } from 'node:fs';
import {
  defaultExecutableCandidates,
  deriveAtRestKey,
  deriveAtRestKeyId,
  fetchKeyPayload,
  isEncryptedFieldWrapper,
  openEncryptedField,
} from '../lib/atrest.mjs';

const AUTH =
  process.env.WORKBUDDY_AUTH_FILE ||
  'C:\\Users\\demo\\AppData\\Local\\CodeBuddyExtension\\Data\\Public\\auth\\workbuddy-desktop.info';

const exe = defaultExecutableCandidates().find((p) => p && existsSync(p));
console.log('exe          :', exe || '<not found>');
if (!exe) process.exit(1);

const t0 = Date.now();
const payloadJson = await fetchKeyPayload(exe);
console.log('key fetch ms :', Date.now() - t0);
console.log('payload keys :', Object.keys(JSON.parse(payloadJson)).join(', '));

const key = deriveAtRestKey(payloadJson);
console.log('derived keyId:', deriveAtRestKeyId(key));

const raw = JSON.parse(readFileSync(AUTH, 'utf8'));
const present = Object.keys(raw.auth).filter((k) => /token/i.test(k)).join(', ');
console.log('auth *token* :', present);

for (const field of ['accessToken', 'refreshToken']) {
  const node = raw.auth[field];
  if (!isEncryptedFieldWrapper(node)) {
    console.log(`${field.padEnd(13)}: not encrypted (${typeof node})`);
    continue;
  }
  const envKeyId = JSON.parse(Buffer.from(node.envelope, 'base64').toString('utf8')).keyId;
  process.stdout.write(`${field.padEnd(13)}: envelope keyId=${envKeyId} `);
  if (envKeyId !== deriveAtRestKeyId(key)) {
    console.log('-> MISMATCH (wrong app build)');
    continue;
  }
  const plain = openEncryptedField(node, key);
  console.log(`-> DECRYPTED len=${plain.length} jws-like=${plain.startsWith('eyJ')}`);
}
