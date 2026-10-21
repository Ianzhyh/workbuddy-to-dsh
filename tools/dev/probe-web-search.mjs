/**
 * 手动探针：经本地桥调用 WorkBuddy 原生网页搜索（会消耗少量 WorkBuddy 搜索额度）。
 *
 *   node tools/dev/probe-web-search.mjs "DeepSeek latest news"
 *
 * 用途：确认 dsh Web search provider 指向桥之前，桥 → WorkBuddy 搜索链路是否通。
 * 不打印任何 token；query 会发给 WorkBuddy，这是搜索本身必需的。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BASE = process.env.WORKBUDDY_BRIDGE_URL || 'http://127.0.0.1:8790';
const TOKEN = process.env.WORKBUDDY_LOCAL_TOKEN
  || (() => {
    try { return readFileSync(join(ROOT, 'dsh-plugin', '.bridge-token'), 'utf8').trim(); } catch { return ''; }
  })();
const query = process.argv.slice(2).join(' ').trim() || 'DeepSeek latest news';

if (!TOKEN) {
  console.error('没有本地令牌：设置 WORKBUDDY_LOCAL_TOKEN 或确认 dsh-plugin/.bridge-token 存在。');
  process.exit(2);
}

const t0 = Date.now();
try {
  const res = await fetch(`${BASE}/v1/web_search`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query, max_results: 5 }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = null; }
  if (!res.ok) {
    console.error(`HTTP ${res.status} · ${Date.now() - t0}ms`);
    console.error(text.slice(0, 800));
    process.exit(1);
  }
  console.log(`HTTP ${res.status} · ${Date.now() - t0}ms · provider=${body?.provider ?? '-'} · ${body?.results?.length ?? 0} results`);
  for (const [i, r] of (body?.results || []).entries()) {
    console.log(`\n${i + 1}. ${r.title || '(no title)'}\n   ${r.url}\n   ${String(r.snippet || '').slice(0, 180)}`);
  }
  process.exit(0);
} catch (error) {
  console.error(`请求失败：${error?.message || error}`);
  process.exit(1);
}
