/**
 * 积分查询的「不阻塞总览」契约。
 *
 *   node tools/dev/test-quota-stale.mjs
 *
 * ## 背景
 *
 * `/api/overview` 每 20 秒轮询一次，而积分要打上游计费网关。原先 `bridgeQuota`
 * 在缓存未命中时会**同步等最多 20 秒** —— 上游一抖动，整份 overview（含 2ms
 * 就能拿到的桥状态与凭据）全被拖住，页面看起来像卡死。**实测见过 14 秒。**
 *
 * ## 钉住的三条
 *
 *   1. 冷启动 + 上游慢 → 最多等 QUOTA_BLOCK_MS 就返回 null，**不等满超时**
 *   2. 缓存新鲜      → 不打上游
 *   3. 缓存过期但仍有旧值 → **立刻返回旧值**，刷新在后台进行
 *
 * 用**假桥**（可控延迟）而不是真桥：真桥的延迟取决于上游，测不出确定性结论。
 */
import { createServer } from 'node:http';

const PORT = 18871;
process.env.WORKBUDDY_PORT = String(PORT);
process.env.WORKBUDDY_LOCAL_TOKEN = 'test-token';
// TTL 调到 1500ms：既不用真等 60 秒，又给「新鲜」这条分支留足 1 秒以上余量，
// 避免断言取决于毫秒级调度（第一版用 300ms，结果步骤之间互相踩到对方的缓存状态）
process.env.WORKBUDDY_QUOTA_TTL_MS = '1500';

let quotaDelayMs = 50;
let quotaCalls = 0;

const server = createServer((req, res) => {
  if (req.url.startsWith('/v1/quota')) {
    quotaCalls += 1;
    setTimeout(() => {
      const body = JSON.stringify({ ok: true, total: 715, packages: [] });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
      res.end(body);
    }, quotaDelayMs);
    return;
  }
  res.writeHead(404);
  res.end('{}');
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

// 必须在设置 env **之后**再动态 import：config.mjs 在 import 时就把环境变量固化了
const { bridgeQuota, invalidateQuotaCache } = await import('../../lib/diagnostics.mjs');

let failures = 0;
const pass = (m) => console.log('✓ ' + m);
const fail = (m) => { console.error('✗ ' + m); failures += 1; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const timed = async (fn) => { const t0 = Date.now(); const value = await fn(); return { ms: Date.now() - t0, value }; };

// ── 1. 冷启动 + 上游慢：必须在 3 秒左右放弃等待 ─────────────────────────
// 时间线：t=0 发起 → t≈3.0s 超时返回 null → 后台那次在 t≈6.0s 完成并落缓存
quotaDelayMs = 6000;
invalidateQuotaCache();
quotaCalls = 0;
let r = await timed(() => bridgeQuota());
if (r.ms <= 3600) pass(`冷启动 + 上游 6s：${r.ms}ms 就返回了，没等满 20 秒超时`);
else fail(`冷启动 + 上游 6s：等了 ${r.ms}ms，应 ≤ 3600ms`);
if (r.value === null) pass('超时返回 null（页面显示「—」而不是卡住）');
else fail(`超时应返回 null，实际 ${JSON.stringify(r.value)}`);

// 放弃等待 ≠ 放弃这次查询：后台那次要继续跑完并落缓存，否则就白打了
await sleep(3400);   // t≈6.4s，缓存于 t≈6.0s 写入 → 年龄 ~0.4s，仍在 1.5s TTL 内
r = await timed(() => bridgeQuota());
if (r.value && r.value.total === 715) pass(`后台那次请求补上了值（total=${r.value.total}）`);
else fail(`后台请求没有落缓存：${JSON.stringify(r.value)}`);

// ── 2. 缓存新鲜 → 一次上游都不打 ────────────────────────────────────────
quotaDelayMs = 50;
quotaCalls = 0;
r = await timed(() => bridgeQuota());
await sleep(150);    // 给「万一真发了请求」留出到达假桥的时间，否则断言会漏判
if (r.ms < 60) pass(`缓存新鲜时 ${r.ms}ms 返回`);
else fail(`缓存新鲜却等了 ${r.ms}ms`);
if (quotaCalls === 0) pass('缓存新鲜时不打上游');
else fail(`缓存新鲜却打了 ${quotaCalls} 次上游`);

// ── 3. 缓存过期但仍有旧值 → 立刻给旧值，刷新走后台 ──────────────────────
await sleep(1600);         // 越过 1.5s 的 TTL
quotaDelayMs = 6000;       // 让刷新变得很慢，好区分「等」和「不等」
quotaCalls = 0;
r = await timed(() => bridgeQuota());
if (r.ms <= 200) pass(`缓存过期时 ${r.ms}ms 就返回旧值，没有等上游`);
else fail(`缓存过期时等了 ${r.ms}ms，应 ≤ 200ms —— 这正是「不让慢上游拖住页面」的核心`);
if (r.value && r.value.total === 715) pass('返回的是旧值（stale-while-revalidate）');
else fail(`应返回旧值，实际 ${JSON.stringify(r.value)}`);
await sleep(200);          // 等后台那个请求真正到达假桥
if (quotaCalls >= 1) pass('同时在后台发起了刷新');
else fail('没有在后台刷新，旧值会永远陈旧下去');

// 后台刷新完成后，下一次调用应拿到新值
await sleep(6300);
quotaDelayMs = 50;
r = await timed(() => bridgeQuota());
if (r.value && r.value.total === 715) pass('后台刷新完成后缓存已更新');
else fail(`后台刷新后仍拿不到值：${JSON.stringify(r.value)}`);

server.close();
console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
