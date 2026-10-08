/**
 * 最小开销基准 —— 把「keep-alive / 桥自身开销」从注释里的数字变成可复现输出。
 *
 *   node tools/dev/bench-overhead.mjs [条数]     条数默认 5，上限 50
 *
 * 对**运行中的桥**（默认 127.0.0.1:8790）连续发 N 条最短对话请求，输出每条
 * 的总耗时与桥自身开销（响应头 `X-WorkBuddy-Overhead-Ms`，已扣除上游往返）。
 *
 * 注意：会消耗极少量账号积分（每条输出 max_tokens=8）；数字依赖网络环境与
 * 上游负载，**只用于同机前后对比**，不作为跨机器基准。
 */
const BRIDGE = process.env.WORKBUDDY_BRIDGE_URL || 'http://127.0.0.1:8790';
const TOKEN = process.env.WORKBUDDY_LOCAL_TOKEN || 'wb-local-bridge';
const N = Math.max(1, Math.min(50, Number(process.argv[2] || 5) || 5));
const MODEL = process.env.WORKBUDDY_BENCH_MODEL || 'deepseek-v4.1-flash';

const rows = [];
for (let i = 1; i <= N; i += 1) {
  const t0 = Date.now();
  let res;
  try {
    res = await fetch(`${BRIDGE}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'hi' }], max_tokens: 8 }),
      signal: AbortSignal.timeout(120_000),
    });
  } catch (err) {
    console.log(`第 ${String(i).padStart(2)} 条: 请求失败 — ${err.message}（桥在跑吗？）`);
    break;
  }
  const text = await res.text();
  const total = Date.now() - t0;
  const overheadRaw = res.headers.get('x-workbuddy-overhead-ms');
  const overhead = overheadRaw === null ? null : Number(overheadRaw);
  rows.push({ i, status: res.status, total, overhead });
  console.log(`第 ${String(i).padStart(2)} 条: status=${res.status} total=${String(total).padStart(5)}ms overhead=${overheadRaw ?? '(无头)'}${overheadRaw ? 'ms' : ''}`);
  if (res.status !== 200) console.log(`  响应片段: ${text.slice(0, 160)}`);
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
const ok = rows.filter((r) => r.status === 200);
if (ok.length) {
  const totals = ok.map((r) => r.total);
  const ovhs = ok.map((r) => r.overhead).filter((v) => v !== null && Number.isFinite(v));
  console.log('\n──────── 汇总 ────────');
  console.log(`成功 ${ok.length}/${N} 条 | 总耗时中位数 ${median(totals)}ms（第 1 条 ${rows[0].total}ms，含连接建立）`);
  if (ovhs.length) console.log(`桥自身开销中位数 ${median(ovhs)}ms（不含上游往返，来自响应头）`);
  console.log('提示：先冷后热的两条对比可见 keep-alive 的连接复用效果（省去 DNS+TLS 握手）。');
}
