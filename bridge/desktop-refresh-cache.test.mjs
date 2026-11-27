/**
 * 桌面凭据续期缓存：验证**决策逻辑**（纯函数，不依赖起桥）。
 *
 * ## 为什么改测这一层
 *
 * 端到端验证要触发一次真实续期，而续期只发生在 `callUpstream` 的前置检查里
 * （`/health` 与目录抓取都不走它）。上一版用 `/v1/models` 想触发，结果
 * **续期根本没发生、缓存没写出来**，测试红在一个与逻辑无关的地方。
 *
 * 而真正需要钉住的判断只有三条，全是纯逻辑：
 *   1. 桌面文件里的令牌**还能用** → 用文件（缓存不该盖掉桌面端自己续期的结果）；
 *   2. 文件里的**已过期 + 有有效缓存** → 用缓存（这就是"免重登"）；
 *   3. 文件过期 + 缓存也过期/不存在 → 如实返回过期的（让上层报"请重登"，
 *      而不是假装可用）。
 *
 * 这三条覆盖了全部行为分支，且不受"续期何时发生"这个无关变量的影响。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, 'workbuddy-bridge.mjs'), 'utf8');

/** 取出一个函数源码（用于真的调用它）。 */
function grabFunction(name) {
  let at = SRC.indexOf(`function ${name}(`);
  assert.ok(at > 0, `找不到 ${name}`);
  if (SRC.slice(Math.max(0, at - 6), at) === 'async ') at -= 6;
  let i = SRC.indexOf('{', at);
  let depth = 0;
  for (; i < SRC.length; i += 1) {
    if (SRC[i] === '{') depth += 1;
    else if (SRC[i] === '}') { depth -= 1; if (depth === 0) return SRC.slice(at, i + 1); }
  }
  throw new Error(`${name} 括号不配对`);
}

/**
 * 构造一个可注入的 `preferFreshDesktopAuth`：
 * `readDesktopRefreshCache` 与 `log` 用参数注入，避免真的碰磁盘。
 */
function makePrefer(cache) {
  const code = [
    grabFunction('preferFreshDesktopAuth'),
    'return preferFreshDesktopAuth;',
  ].join('\n');
  const factory = new Function('readDesktopRefreshCache', 'log', code);
  return factory(async () => cache, () => {});
}

const NOW = Date.now();

test('桌面令牌还有效时，用文件里的（缓存不该盖掉桌面端自己续期的结果）', async () => {
  const future = NOW + 3_600_000;
  const fileAuth = { source: 'desktop', userId: 'u1', access: 'file-access', refresh: 'file-r', expiresAt: future };

  let cacheRead = false;
  const code = [grabFunction('preferFreshDesktopAuth'), 'return preferFreshDesktopAuth;'].join('\n');
  const fn = new Function('readDesktopRefreshCache', 'log', code)(
    async () => { cacheRead = true; return { uid: 'u1', access: 'cache-access', expiresAt: NOW + 9_999_999 }; },
    () => {},
  );

  const out = await fn(fileAuth);
  assert.equal(out.access, 'file-access', '文件里的还能用，就该用文件的');
  assert.equal(cacheRead, false, '文件有效时根本不该去读缓存（省一次解密）');
});

test('文件已过期 + 缓存有效 → 用缓存（这就是"免重登"）', async () => {
  const fileAuth = { source: 'desktop', userId: 'u1', access: 'stale', refresh: 'r1', expiresAt: NOW - 3_600_000 };
  const cache = { uid: 'u1', access: 'fresh-from-cache', refresh: 'r2', expiresAt: NOW + 3_000_000 };

  const out = await makePrefer(cache)(fileAuth);
  assert.equal(out.access, 'fresh-from-cache', '过期文件 + 有效缓存时必须用缓存');
  assert.equal(out.expiresAt, cache.expiresAt, '到期时刻也要跟着缓存走（否则上层还会判过期）');
  assert.equal(out.refresh, 'r2', 'refresh token 也要用缓存里轮换后的那个');
  /* 其它字段必须保留，否则域名/端点会丢，请求打到错网关 */
  assert.equal(out.userId, 'u1');
  assert.equal(out.source, 'desktop');
});

test('文件过期 + 缓存也过期 → 如实返回过期的（让上层报"请重登"）', async () => {
  const fileAuth = { source: 'desktop', userId: 'u1', access: 'stale', expiresAt: NOW - 3_600_000 };
  const cache = { uid: 'u1', access: 'also-stale', expiresAt: NOW - 1000 };

  const out = await makePrefer(cache)(fileAuth);
  assert.equal(out.access, 'stale', '缓存也过期时不能假装可用');
});

test('文件过期 + 缓存是**另一个账号**的 → 不能用（换号后不能拿别人的令牌）', async () => {
  const fileAuth = { source: 'desktop', userId: 'u-current', access: 'stale', expiresAt: NOW - 60_000 };
  const cache = { uid: 'u-other', access: 'someone-else', expiresAt: NOW + 3_000_000 };

  const out = await makePrefer(cache)(fileAuth);
  assert.equal(out.access, 'stale',
    '缓存属于另一个账号时绝不能拿来用 —— 那会把请求发到别人的钱包');
});

test('文件过期 + 没有缓存 → 原样返回', async () => {
  const fileAuth = { source: 'desktop', userId: 'u1', access: 'stale', expiresAt: NOW - 60_000 };
  const out = await makePrefer(null)(fileAuth);
  assert.equal(out.access, 'stale');
});

test('没有 expiresAt（老文件）→ 当作有效，不拿缓存顶', async () => {
  const fileAuth = { source: 'desktop', userId: 'u1', access: 'file-access' };
  const cache = { uid: 'u1', access: 'cache-access', expiresAt: NOW + 3_000_000 };
  const out = await makePrefer(cache)(fileAuth);
  assert.equal(out.access, 'file-access', '没有过期信息时不该假设它过期');
});

test('续期缓存必须加密落盘，不能是明文令牌', () => {
  /*
   * 缓存里是 access/refresh token。明文躺在磁盘上等于把账号交给任何能读
   * 那个目录的进程。这条断言防止有人"为了简单"改成 JSON 直存。
   */
  assert.match(SRC, /writeFileAtomic\(desktopRefreshCacheFile\(\),\s*await sealCredential\(/,
    '续期缓存必须经 sealCredential 加密后写盘');
  assert.doesNotMatch(SRC, /writeFileSync\(desktopRefreshCacheFile\(\)/,
    '不得绕过加密直接写续期缓存');
});

test('续期结果确实会落盘（persistDesktopRefresh 在桌面刷新分支里被调用）', () => {
  /*
   * 上一版的坑：函数写好了却没接上，缓存永远为空 —— 测试只要不查这一点
   * 就会一直"绿"而功能从未生效。
   */
  const callAt = SRC.indexOf('await persistDesktopRefresh(');
  assert.ok(callAt > 0, 'persistDesktopRefresh 必须被调用');

  const doRefreshAt = SRC.indexOf('async function doRefreshAuth(');
  const pluginAt = SRC.indexOf('async function doRefreshPluginAuth(');
  assert.ok(doRefreshAt > 0 && pluginAt > 0);
  assert.ok(callAt > doRefreshAt && callAt < pluginAt,
    'persistDesktopRefresh 必须在 doRefreshAuth（桌面分支）内，不能落到插件分支');
});