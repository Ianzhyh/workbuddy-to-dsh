/**
 * 验证**已发布**的插件包。
 *
 *   node tools/dev/verify-release.mjs             # 验 package.json 版本对应的 tag
 *   node tools/dev/verify-release.mjs v1.4.0      # 指定 tag
 *   node tools/dev/verify-release.mjs --refresh   # 忽略本地缓存，重新下载
 *
 * ## 为什么需要它
 *
 * `npm run release:check` 里的 `verify:standalone` 验的是**本地**的
 * `dsh-plugin/` + `vendor/`；用户真正下载到的是 GitHub Release 上的那个 tgz。
 * 两者之间还隔着「`npm pack` 到底打进去了什么」这一层 ——
 * 少打包一个文件、或者 `vendor/` 快照不对，**本地门禁一个都不会红**。
 *
 * 所以这里做三件事：
 *   1. 把发布产物下下来，与本地打包产物**逐字节比对**（能对上的话，
 *      「门禁验过的」与「用户下载到的」就是同一份东西）；
 *   2. 读 tar 头列出包内文件，核对关键文件在不在（不落盘，也不依赖 tar 命令）；
 *   3. 把包内几个关键文件**取出内容**与仓库当前版本逐字节比对
 *      （只比大小会漏掉「同样大小但内容是旧快照」这种情况）。
 *
 * 任何一项不对就非零退出，可以接进门禁。
 *
 * ## 本机环境注意事项（都踩过）
 *
 * - **GitHub 直连不稳定**（常 `UND_ERR_CONNECT_TIMEOUT`），所以下载结果缓存在
 *   `.tmp-research/release/` 下，重跑不必再下。要强制重下加 `--refresh`。
 * - **TLS**：这台机器上有中间证书，Node 的 fetch 会报
 *   `UNABLE_TO_VERIFY_LEAF_SIGNATURE`。用合并 CA 跑：
 *   `NODE_EXTRA_CA_CERTS=E:/tmp/combined-ca.pem node tools/dev/verify-release.mjs`
 *   （与 `git push` 用的是同一个 `combined-ca.pem`，见项目记忆）。
 *   不用 `curl`：它的 schannel 后端会报 `CRYPT_E_NO_REVOCATION_CHECK`。
 * - 不用 `tar` 命令：Windows 的 bsdtar 解这个包会 `Error is not recoverable`。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const CACHE = join(ROOT, '.tmp-research', 'release');

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const repoUrl = (pkg.repository && pkg.repository.url) || '';
const m = /github\.com[/:]([^/]+)\/([^/.]+)/.exec(repoUrl);
if (!m) throw new Error(`package.json 里没有可解析的 repository.url：${repoUrl}`);
const [, OWNER, REPO] = m;

const args = process.argv.slice(2);
const refresh = args.includes('--refresh');
const tag = args.find((a) => !a.startsWith('--')) || `v${pkg.version}`;
const version = tag.replace(/^v/, '');
const asset = `dsh-plugin-workbuddy-${version}.tgz`;
const url = `https://github.com/${OWNER}/${REPO}/releases/download/${tag}/${asset}`;

let failures = 0;
const ok = (s) => console.log('✓ ' + s);
const bad = (s) => { console.error('✗ ' + s); failures += 1; };

console.log(`目标：${OWNER}/${REPO}  ${tag}  ${asset}\n`);

// ── 1. 取发布产物（带本地缓存）──────────────────────────────────────────
mkdirSync(CACHE, { recursive: true });
const cached = join(CACHE, `${tag}-${asset}`);
let pub;
if (!refresh && existsSync(cached)) {
  pub = readFileSync(cached);
  console.log(`（复用缓存 ${cached}）`);
} else {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`下载失败：HTTP ${res.status} —— ${url}`);
  pub = Buffer.from(await res.arrayBuffer());
  writeFileSync(cached, pub);
}
const sha = (b) => createHash('sha256').update(b).digest('hex');
console.log(`发布产物：${pub.length} 字节  sha256 ${sha(pub)}\n`);

// ── 2. 与本地打包产物逐字节比对 ─────────────────────────────────────────
const localPath = join(ROOT, 'dsh-plugin', asset);
if (!existsSync(localPath)) {
  console.log(`· 本地没有 ${asset}（没跑过 npm run pack:plugin？），跳过逐字节比对`);
} else if (pub.equals(readFileSync(localPath))) {
  ok('与本地打包产物逐字节一致 —— 门禁验的就是用户下载到的那份');
} else {
  bad('与本地打包产物**不一致** —— 重新打包并确认已上传');
}

// ── 3. 解 gzip + 读 tar（不落盘，也不依赖 tar 命令）─────────────────────
/** @returns {{name:string,size:number,body:Buffer}[]} */
function readTar(gz) {
  const raw = gunzipSync(gz);
  const out = [];
  let off = 0;
  while (off + 512 <= raw.length) {
    const head = raw.subarray(off, off + 512);
    if (head.every((b) => b === 0)) break;
    const name = head.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const size = parseInt(head.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim(), 8) || 0;
    const start = off + 512;
    if (name) out.push({ name, size, body: raw.subarray(start, start + size) });
    off = start + Math.ceil(size / 512) * 512;
  }
  return out;
}

let files;
try {
  files = readTar(pub);
} catch (err) {
  bad(`不是合法的 gzip/tar：${err.message}`);
  console.log(`\n✗ 失败 ${failures} 项`);
  process.exit(1);
}
console.log(`包内 ${files.length} 项文件`);

/*
 * 关键文件清单：缺任何一个，用户装上去都是坏的 ——
 * lib/ 是插件本体，vendor/ 是它自带的那份桥与控制台快照（分发给别人时靠它跑）。
 */
const need = [
  'package/package.json',
  'package/README.md',
  'package/lib/index.js',
  'package/lib/client.js',
  'package/lib/routes.mjs',
  'package/vendor/config.mjs',
  'package/vendor/bridge/workbuddy-bridge.mjs',
  'package/vendor/dashboard/server.mjs',
  'package/vendor/dashboard/public/index.html',
  'package/vendor/dashboard/public/style.css',
  'package/vendor/lib/dsh.mjs',
];
const byName = new Map(files.map((f) => [f.name, f]));
const missing = need.filter((n) => !byName.has(n));
if (missing.length) bad(`关键文件缺失：${missing.join(', ')}`);
else ok(`关键文件齐全（${need.length} 项）`);

/*
 * 包内关键文件必须与仓库当前版本**逐字节一致** —— 防止「改了代码但打的是旧快照」。
 * 只比大小会漏掉同样大小却内容不同的情况。
 */
const mirrors = [
  ['package/lib/client.js', 'dsh-plugin/lib/client.js'],
  ['package/vendor/dashboard/public/index.html', 'dashboard/public/index.html'],
  ['package/vendor/dashboard/public/style.css', 'dashboard/public/style.css'],
  ['package/vendor/config.mjs', 'config.mjs'],
  ['package/vendor/bridge/workbuddy-bridge.mjs', 'bridge/workbuddy-bridge.mjs'],
];
for (const [inPkg, inRepo] of mirrors) {
  const f = byName.get(inPkg);
  const local = join(ROOT, inRepo);
  if (!f || !existsSync(local)) continue;
  if (f.body.equals(readFileSync(local))) ok(`${inPkg} 与仓库逐字节一致`);
  else bad(`${inPkg} 与仓库**不一致** —— 可能打进了旧快照，重跑 npm run pack:plugin`);
}

console.log(`\n${failures ? '✗ 失败 ' + failures + ' 项' : '✓ 发布产物验证通过'}`);
process.exit(failures ? 1 : 0);
