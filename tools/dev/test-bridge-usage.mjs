/**
 * 桥级验收（不依赖登录文件、不消耗上游额度）：
 *
 *   D5  按天统计使用**本地日期**分桶（凌晨的调用不会被记到前一天）
 *   D10 账本被删除 / 清空后不会「复活」已删除的历史
 *   R1.4/R1.6 小时桶：24 桶齐全、空桶补 0、本地时区不漂移、桶级 credit/creditCalls、
 *              桶合计与 total 一致、不带 hours=1 时不返回 hours
 *
 * 做法：起一个本地 stub 上游 + 一个临时端口、临时账本的桥实例，
 * 全部断言跑完后自动清理。
 *
 *   node tools/dev/test-bridge-usage.mjs
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BRIDGE_PORT = 8899;
const STUB_PORT = 8900;
const TOKEN = 'wb-test-token';
const BASE = `http://127.0.0.1:${BRIDGE_PORT}`;

const fail = (m) => { console.error('✗ ' + m); process.exitCode = 1; };
const pass = (m) => console.log('✓ ' + m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (n) => String(n).padStart(2, '0');
const localDay = (ts) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const utcDay = (ts) => new Date(ts).toISOString().slice(0, 10);
const countLines = (file) => {
  try { return readFileSync(file, 'utf8').split('\n').filter(Boolean).length; } catch { return 0; }
};

const dir = mkdtempSync(join(tmpdir(), 'wb-bridge-test-'));
const ledger = join(dir, 'usage.jsonl');

// ── stub 上游：返回一段带 usage 的 SSE，让桥能记下一条成功请求 ─────────────
const stub = createServer((req, res) => {
  if (req.method !== 'POST') { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.write('data: {"id":"stub-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"ok"}}]}\n\n');
  res.write('data: {"id":"stub-1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],'
    + '"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4,"credit":0}}\n\n');
  res.write('data: [DONE]\n\n');
  res.end();
});

let bridge = null;
const cleanup = () => {
  try { bridge?.kill(); } catch { /* 已退出 */ }
  try { stub.close(); } catch { /* 已关闭 */ }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* 已清理 */ }
};
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });

function startBridge() {
  bridge = spawn(process.execPath, [join(root, 'bridge', 'workbuddy-bridge.mjs')], {
    cwd: root,
    env: {
      ...process.env,
      WORKBUDDY_HOST: '127.0.0.1',
      WORKBUDDY_PORT: String(BRIDGE_PORT),
      WORKBUDDY_LOCAL_TOKEN: TOKEN,
      WORKBUDDY_USAGE_FILE: ledger,
      WORKBUDDY_AUTH_FILE: join(dir, 'missing.info'),
      WORKBUDDY_LOG: '0',
      // API-key 模式 + 本地 stub 上游：不需要真实凭据也能走完记账路径
      CODEBUDDY_API_KEY: 'test-key',
      CODEBUDDY_ENDPOINT: `http://127.0.0.1:${STUB_PORT}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

async function waitReady() {
  for (let i = 0; i < 40; i += 1) {
    try {
      const r = await fetch(`${BASE}/v1/usage?days=7`, { headers: { Authorization: `Bearer ${TOKEN}` } });
      if (r.ok) return true;
    } catch { /* 还没起来 */ }
    await sleep(250);
  }
  return false;
}

/** 打一次最小对话请求（走 stub 上游），触发一条账本记录。 */
async function oneChat(model = 'stub-model') {
  const r = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], stream: false }),
  });
  if (!r.ok) throw new Error(`chat 请求失败：HTTP ${r.status}`);
  await r.json();
}

async function usage(days = 7) {
  const r = await fetch(`${BASE}/v1/usage?days=${days}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  return r.json();
}

// ── 准备 ────────────────────────────────────────────────────────────────
await new Promise((ok) => stub.listen(STUB_PORT, '127.0.0.1', ok));

// D5 的两条记录：今天**本地 00:30**（在 UTC+8 下属于前一个 UTC 日）+ 现在
const now = Date.now();
const early = new Date(now);
early.setHours(0, 30, 0, 0);
const rows = [
  { t: early.getTime(), model: 'day-test', stream: false, ok: true, ms: 100, promptTokens: 5, completionTokens: 1 },
  { t: now, model: 'day-test', stream: false, ok: true, ms: 120, promptTokens: 6, completionTokens: 2 },
];
writeFileSync(ledger, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');

startBridge();
if (!await waitReady()) {
  fail('桥实例未能在 10 秒内就绪');
  cleanup();
  process.exit(1);
}
console.log(`桥实例就绪：${BASE}\n`);

// ── D5：按天分桶用本地日期 ──────────────────────────────────────────────
{
  const u = await usage(7);
  const days = u.days || [];
  const todayLocal = localDay(now);
  const earlyUtc = utcDay(early.getTime());

  const todayBucket = days.find((d) => d.day === todayLocal);
  if (todayBucket && todayBucket.calls === 2) {
    pass(`D5 今天（本地 ${todayLocal}）的柱子包含两条记录，含本地 00:30 那条`);
  } else {
    fail(`D5 本地今天 ${todayLocal} 的柱子应含 2 次调用，实际 ${todayBucket ? todayBucket.calls : '缺桶'}`);
  }

  if (earlyUtc !== todayLocal && !days.some((d) => d.day === earlyUtc)) {
    pass(`D5 没有出现 UTC 日期 ${earlyUtc} 的假柱子（改造前会把凌晨算到这一天）`);
  } else {
    fail(`D5 出现了 UTC 日期 ${earlyUtc} 的桶（说明仍在按 UTC 分桶）`);
  }
}

// ── Task 34.1：小时桶（R1.4 / R1.6）─────────────────────────────────────
{
  const anchor = new Date();
  anchor.setMinutes(0, 0, 0);
  const hKey = (ts) => {
    const d = new Date(ts);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}`;
  };
  const utcKeyOf = (ts) => new Date(ts).toISOString().slice(0, 13).replace('T', ' ');

  const t0 = anchor.getTime();               // 当前整点：2 次，含扣分
  const t3 = anchor.getTime() - 3 * 3600000; // 3 小时前：1 次，含扣分
  const t5 = anchor.getTime() - 5 * 3600000; // 5 小时前：1 次，**未回报扣分**
  const midnight = (() => { const d = new Date(); d.setHours(0, 30, 0, 0); return d.getTime(); })();

  // 00:30 那条只在它的小时键不与上面三个冲突时才加（避免在 00 点跑测试时撞桶）
  const mKey = hKey(midnight);
  const includeMidnight = ![hKey(t0), hKey(t3), hKey(t5)].includes(mKey);

  const hrows = [
    { t: t0 + 60000, model: 'h-test', stream: false, ok: true, ms: 10, promptTokens: 10, completionTokens: 5, credit: 0.03 },
    { t: t0 + 120000, model: 'h-test', stream: false, ok: true, ms: 10, promptTokens: 10, completionTokens: 5, credit: 0.07 },
    { t: t3 + 60000, model: 'h-test', stream: false, ok: true, ms: 10, promptTokens: 4, completionTokens: 2, credit: 0.02 },
    { t: t5 + 60000, model: 'h-nocredit', stream: false, ok: true, ms: 10, promptTokens: 1, completionTokens: 1 },
    ...(includeMidnight
      ? [{ t: midnight, model: 'h-mid', stream: false, ok: true, ms: 10, promptTokens: 1, completionTokens: 1 }]
      : []),
  ];
  writeFileSync(ledger, `${hrows.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
  bridge.kill();
  await sleep(300);
  startBridge();
  if (!await waitReady()) { fail('桥实例重启失败'); cleanup(); process.exit(1); }

  const r = await fetch(`${BASE}/v1/usage?days=1&hours=1`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  const u = await r.json();
  const hs = u.hours || [];

  if (hs.length === 24) pass('R1.4-1 小时桶共 24 个');
  else fail(`R1.4-1 小时桶应为 24 个，实际 ${hs.length}`);

  if (hs.every((b, i) => i === 0 || hs[i - 1].key < b.key)) pass('R1.4-1 桶序从旧到新');
  else fail('R1.4-1 桶序不是从旧到新');

  if (hs.every((b) => ['calls', 'promptTokens', 'completionTokens', 'credit', 'creditCalls']
    .every((k) => typeof b[k] === 'number'))) {
    pass('R1.4-1 空桶已补齐（calls/credit/creditCalls 均为 0，不是缺字段）');
  } else {
    fail('R1.4-1 存在未补齐的空桶');
  }

  const cur = hs.find((b) => b.key === hKey(t0));
  if (cur && cur.calls === 2 && Math.abs(cur.credit - 0.1) < 1e-9 && cur.creditCalls === 2) {
    pass('R1.6 当前整点桶：calls=2 / credit=0.1 / creditCalls=2');
  } else {
    fail(`R1.6 当前整点桶异常：${JSON.stringify(cur)}`);
  }

  const p3 = hs.find((b) => b.key === hKey(t3));
  if (p3 && p3.calls === 1 && Math.abs(p3.credit - 0.02) < 1e-9) pass('R1.6 3 小时前桶：calls=1 / credit=0.02');
  else fail(`R1.6 3 小时前桶异常：${JSON.stringify(p3)}`);

  const p5 = hs.find((b) => b.key === hKey(t5));
  if (p5 && p5.calls === 1 && p5.creditCalls === 0 && p5.credit === 0) {
    pass('R1.6 未回报扣分的调用：calls=1 但 creditCalls=0（「没回报」与「回报 0」区分得开）');
  } else {
    fail(`R1.6 未回报扣分桶异常：${JSON.stringify(p5)}`);
  }

  // 本地时区：记录必须落在**本地**小时键，而不是 UTC 小时键
  const localKey = hKey(t3);
  const utcKey = utcKeyOf(t3);
  if (localKey === utcKey) {
    pass('R1.4-2 本机时区偏移为 0，本地键与 UTC 键相同（本项不适用）');
  } else if (hs.find((b) => b.key === utcKey)?.calls > 0) {
    fail(`R1.4-2 记录落在 UTC 桶 ${utcKey} 上（时区漂移）`);
  } else {
    pass(`R1.4-2 记录落在本地桶 ${localKey}，未漂移到 UTC 桶 ${utcKey}`);
  }

  if (includeMidnight) {
    const mb = hs.find((b) => b.key === mKey);
    if (mb && mb.calls === 1) pass(`R1.4-2 本地 00:30 的记录落在 ${mKey} 桶`);
    else fail(`R1.4-2 本地 00:30 未落在 ${mKey} 桶`);
  } else {
    pass('R1.4-2 当前处于 00 点，00:30 桶与当前桶重合，本项跳过（避免撞桶）');
  }

  // 口径一致性：桶合计必须等于 total（图上每个数字都要能在面板对上）
  const sumCalls = hs.reduce((s, b) => s + b.calls, 0);
  const sumCredit = Math.round(hs.reduce((s, b) => s + b.credit, 0) * 10000) / 10000;
  const sumCreditCalls = hs.reduce((s, b) => s + b.creditCalls, 0);
  if (sumCalls === u.total.calls && Math.abs(sumCredit - u.total.credit) < 1e-9
    && sumCreditCalls === u.total.creditCalls) {
    pass(`R10.1 小时桶合计与 total 一致（${sumCalls} 次 / ${sumCredit} / ${sumCreditCalls} 次有扣分）`);
  } else {
    fail(`小时桶合计(${sumCalls}/${sumCredit}/${sumCreditCalls}) 与 total(${u.total.calls}/${u.total.credit}/${u.total.creditCalls}) 不一致`);
  }

  // 按需计算：不带 hours=1 时不该出现 hours 字段
  const u2 = await usage(1);
  if (!('hours' in u2)) pass('R1.4-4 不带 hours=1 时响应中没有 hours 字段（按需计算）');
  else fail('R1.4-4 未请求小时桶却返回了 hours 字段');

  // days[] 桶级 credit 也应存在（R10 积分图按天口径）
  const dayWithCredit = (u.days || []).find((d) => typeof d.credit === 'number');
  if (dayWithCredit) pass('R1.6 days[] 桶已带 credit/creditCalls 字段');
  else fail('R1.6 days[] 桶缺少 credit/creditCalls');
}

// ── D10：账本重置语义 ───────────────────────────────────────────────────
{
  // 先用 1999 条历史 + 1 次新请求把内存副本推到正好 2000 行（走 append 路径）
  const filler = Array.from({ length: 1999 }, (_, i) => JSON.stringify({
    t: now, model: 'filler', stream: false, ok: true, ms: 1, promptTokens: 1, completionTokens: 1,
  })).join('\n');
  writeFileSync(ledger, `${filler}\n`, 'utf8');
  // 上一段已经让桥读过账本：重启一次，确保内存副本从这份 1999 行的文件重新加载
  bridge.kill();
  await sleep(300);
  startBridge();
  if (!await waitReady()) { fail('桥实例重启失败'); cleanup(); process.exit(1); }

  await oneChat();
  const grown = countLines(ledger);
  if (grown === 2000) pass(`D10 账本按追加路径增长到 ${grown} 行（未触发整块重写）`);
  else fail(`D10 账本行数异常：期望 2000，实际 ${grown}`);

  // 手工删除账本文件后继续请求：改造前会把内存里的 2000 行整块写回
  rmSync(ledger, { force: true });
  await oneChat();
  const afterDelete = countLines(ledger);
  if (afterDelete <= 2) pass(`D10 手工删除账本后只写入新记录（${afterDelete} 行，未复活历史）`);
  else fail(`D10 删除后出现 ${afterDelete} 行：已删除的历史被写回`);

  // 「清空账本」接口：清文件 + 清内存副本
  const del = await fetch(`${BASE}/v1/usage`, { method: 'DELETE', headers: { Authorization: `Bearer ${TOKEN}` } });
  const delBody = await del.json().catch(() => null);
  if (del.ok && delBody?.cleared) pass('D10 DELETE /v1/usage 返回 cleared');
  else fail(`D10 DELETE /v1/usage 失败：HTTP ${del.status}`);

  await oneChat();
  const afterReset = countLines(ledger);
  const u2 = await usage(7);
  if (afterReset === 1 && u2.total?.calls === 1) {
    pass(`D10 重置后继续请求：账本 ${afterReset} 行、用量统计 ${u2.total.calls} 次（无复活）`);
  } else {
    fail(`D10 重置后异常：账本 ${afterReset} 行、用量统计 ${u2.total?.calls} 次`);
  }
}

cleanup();
console.log(process.exitCode ? '\n存在失败项' : '\n全部通过');