/**
 * 控制台的边界输入探查。
 *
 *   node tools/dev/test-console-edges.mjs
 *
 * 与 `probe-bridge-edges.mjs` 分工：那个打桥（自己起假上游），这个打控制台
 * （按项目惯例跑在**已在运行**的实例上，默认 http://127.0.0.1:8792）。
 *
 * 环境变量：
 *   PAGE_URL   控制台地址（默认 http://127.0.0.1:8792）
 *
 * ## 为什么必须有这一条
 *
 * 控制台的 `readBody` 原先是「超限 → fail() + req.destroy()」。destroy 会把
 * socket 直接拆掉，响应还没来得及写就 RST 了 —— 实测往 `/api/chat` 发 600KB：
 *
 *     curl: (56) Recv failure: Connection was reset
 *
 * 客户端拿不到任何错误信息。而「对话测试」的历史是**不自动裁剪**的，聊久了就会
 * 撞上 512KB 上限。桥那边早就修好了（并留了详细注释），控制台漏改。
 *
 * 断言的是**状态码与错误码**，不是文案 —— 用户要的是「知道发生了什么」。
 */
import net from 'node:net';

const BASE = (process.env.PAGE_URL || 'http://127.0.0.1:8792').replace(/\/$/, '');
const PANEL_HEADER = 'x-workbuddy-panel';

let failures = 0;
const pass = (m) => console.log('✓ ' + m);
const fail = (m) => { console.error('✗ ' + m); failures += 1; };

/** 带面板头 POST（写接口的准入要求），返回 { status, body, raw }。 */
async function post(path, payload, { raw = false } = {}) {
  const body = raw ? payload : JSON.stringify(payload);
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', [PANEL_HEADER]: '1' },
    body,
    signal: AbortSignal.timeout(15000),
  });
  const text = await r.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* 非 JSON 也允许 */ }
  return { status: r.status, body: parsed, raw: text.slice(0, 120) };
}

// 探活：控制台没跑就直接说清楚，别报一堆连接错误
try {
  const r = await fetch(BASE + '/', { signal: AbortSignal.timeout(3000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
} catch (e) {
  console.error(`控制台没在 ${BASE} 上运行（${e.message}）。先起它：node dashboard/server.mjs`);
  process.exit(1);
}
console.log(`控制台边界探查 → ${BASE}\n`);

// ── 1. 请求体超限：必须是 413，不能是连接重置 ───────────────────────────
// 512KB 是控制台 readBody 的默认上限；给到 ~700KB 确保越过
const oversized = JSON.stringify({ model: 'glm-5.3', messages: [{ role: 'user', content: 'x'.repeat(700_000) }] });
try {
  const r = await post('/api/chat', oversized, { raw: true });
  if (r.status === 413) pass(`/api/chat 超限请求体 → 413（${(oversized.length / 1024).toFixed(0)}KB）`);
  else fail(`/api/chat 超限请求体 → HTTP ${r.status}，应为 413`);
  if (r.body && r.body.code === 'BODY_TOO_LARGE') pass('响应带 code=BODY_TOO_LARGE，客户端能据此给出可操作提示');
  else fail(`响应缺少 code=BODY_TOO_LARGE：${r.raw}`);
  if (r.body && typeof r.body.error === 'string' && r.body.error.length > 0) pass('响应带人类可读的 error 文案');
  else fail('响应没有可读的 error 文案');
} catch (e) {
  fail(`/api/chat 超限请求体：连接层就失败了 —— ${e.message}（这正是要避免的「Connection reset」）`);
}

// ── 2. 正常大小的请求不受影响 ───────────────────────────────────────────
// 不消耗额度：故意发一个模型不存在的请求，桥会 400 拒绝，但控制台的读取路径已被走通
try {
  const r = await post('/api/probe', { model: '' });
  if (r.status === 400) pass('/api/probe 空 model → 400（读取路径正常，不是 500）');
  else fail(`/api/probe 空 model → HTTP ${r.status}，应为 400`);
} catch (e) {
  fail(`/api/probe 请求失败：${e.message}`);
}

// ── 3. 非法 JSON ────────────────────────────────────────────────────────
try {
  const r = await post('/api/probe', '{ not json', { raw: true });
  if (r.status === 400) pass('/api/probe 非法 JSON → 400');
  else fail(`/api/probe 非法 JSON → HTTP ${r.status}，应为 400`);
} catch (e) {
  fail(`/api/probe 非法 JSON 连接层失败：${e.message}`);
}

// ── 4. 缺面板头必须被拒（写操作的准入检查）────────────────────────────
try {
  const r = await fetch(BASE + '/api/probe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'glm-5.3' }),
    signal: AbortSignal.timeout(8000),
  });
  if (r.status === 403) pass('写接口缺 x-workbuddy-panel 头 → 403（跨站写防线生效）');
  else fail(`写接口缺面板头 → HTTP ${r.status}，应为 403`);
} catch (e) {
  fail(`缺面板头探测失败：${e.message}`);
}

// ── 5. 路径穿越必须被拒 ────────────────────────────────────────────────
for (const p of ['/../package.json', '/..%2fpackage.json', '/%2e%2e%2fpackage.json', '/index.html.bak']) {
  try {
    const r = await fetch(BASE + p, { signal: AbortSignal.timeout(8000) });
    if (r.status === 404 || r.status === 403) pass(`静态路径 ${p} → ${r.status}`);
    else fail(`静态路径 ${p} → HTTP ${r.status}，应为 404/403`);
  } catch (e) {
    fail(`静态路径 ${p} 探测失败：${e.message}`);
  }
}

// ── 6. 非法百分号编码不能变成 500 ──────────────────────────────────────
try {
  const r = await fetch(BASE + '/%', { signal: AbortSignal.timeout(8000) });
  if (r.status === 404) pass('非法百分号编码 → 404（不是 500）');
  else fail(`非法百分号编码 → HTTP ${r.status}，应为 404`);
} catch (e) {
  // 某些客户端会在发出前就拒绝这个 URL，那也算没打到服务端
  pass(`非法百分号编码被客户端拦下（${e.name}）`);
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
