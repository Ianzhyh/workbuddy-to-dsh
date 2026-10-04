/**
 * Task 4 验收（R9.3 后端）：体检归档的「本轮范围」lastRun。
 *
 *   node tools/dev/test-probe-lastrun.mjs
 *
 * 做法：以临时端口启动控制台（**不自动拉起桥**，本项只碰状态文件），
 * 反复 POST /api/probe-results 构造合法/非法 lastRun，核对落盘与回读。
 *
 * 安全：.state.json 里可能有用户真实的体检结论，本脚本**先快照、结束时还原**。
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const STATE = join(root, '.state.json');
const PORT = 8798;
const BASE = `http://127.0.0.1:${PORT}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const fail = (m) => { console.error('✗ ' + m); failures += 1; };
const pass = (m) => console.log('✓ ' + m);

// ── 快照 .state.json（不存在则记为 null，结束时按原样恢复）────────────────
const snapshot = existsSync(STATE) ? readFileSync(STATE, 'utf8') : null;
const restore = () => {
  try {
    if (snapshot === null) { if (existsSync(STATE)) rmSync(STATE, { force: true }); }
    else writeFileSync(STATE, snapshot, 'utf8');
  } catch { /* 尽力还原 */ }
};

let server = null;
const cleanup = () => {
  try { server?.kill(); } catch { /* 已退出 */ }
  restore();
};
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });

function startServer() {
  server = spawn(process.execPath, [join(root, 'dashboard', 'server.mjs')], {
    cwd: root,
    env: {
      ...process.env,
      DASHBOARD_PORT: String(PORT),
      DASHBOARD_AUTO_START_BRIDGE: '0',
      DASHBOARD_OPEN_BROWSER: '0',
      WORKBUDDY_LOG: '0',
      // 关掉自动签到：本项只碰状态文件，绝不能顺手对真实账号发起签到
      WORKBUDDY_AUTO_CHECKIN: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

async function waitReady() {
  for (let i = 0; i < 40; i += 1) {
    try {
      const r = await fetch(`${BASE}/api/probe-results`);
      if (r.ok) return true;
    } catch { /* 还没起来 */ }
    await sleep(250);
  }
  return false;
}

const post = (body) => fetch(`${BASE}/api/probe-results`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
}).then((r) => r.json());

const get = () => fetch(`${BASE}/api/probe-results`).then((r) => r.json());

// ── 开跑 ────────────────────────────────────────────────────────────────
// 先清成干净状态：只重置 probe 键，**保留**其余键（authFile 等是用户的真实数据）。
// 直接写 `{}` 的话，脚本中途被 SIGKILL 就会把用户的选择一起抹掉。
const baseState = (() => { try { return JSON.parse(snapshot || '{}') || {}; } catch { return {}; } })();
writeFileSync(STATE, `${JSON.stringify({ ...baseState, probe: null }, null, 2)}\n`, 'utf8');

startServer();
if (!await waitReady()) {
  fail('控制台未能在 10 秒内就绪');
  cleanup();
  process.exit(1);
}
console.log(`控制台就绪：${BASE}\n`);

const entry = (id) => ({ [id]: { ok: true, ms: 120, at: Date.now(), credit: 0 } });

// 1. 合法 lastRun → 落盘且可回读
{
  const r = await post({ results: { ...entry('a'), ...entry('b') }, lastRun: { scope: 'checked', count: 2 } });
  if (r.saved && r.lastRun?.scope === 'checked' && r.lastRun?.count === 2) {
    pass('R9.3-2 合法 lastRun 被接受（scope=checked / count=2）');
  } else {
    fail(`R9.3-2 合法 lastRun 未被接受：${JSON.stringify(r)}`);
  }
  const g = await get();
  if (g.lastRun?.scope === 'checked' && g.lastRun?.count === 2) {
    pass('R9.3-1 GET /api/probe-results 回读 lastRun（表头 K 值来源）');
  } else {
    fail(`R9.3-1 回读的 lastRun 异常：${JSON.stringify(g.lastRun)}`);
  }
  // 合并语义不回归：既有结果仍在
  if (g.results?.a && g.results?.b) pass('R9.3-2 合并写入语义未回归（本轮结果已并入）');
  else fail('R9.3-2 结果合并异常');
}

// 2. 非法 scope → 整条丢弃，且上一轮 K 被清掉（不显示过期数字）
{
  const r = await post({ results: entry('c'), lastRun: { scope: 'x', count: 1 } });
  if (r.saved && r.lastRun === null) pass('R9.3-2 非法 scope 被丢弃（lastRun=null）');
  else fail(`R9.3-2 非法 scope 未被丢弃：${JSON.stringify(r.lastRun)}`);

  const g = await get();
  if (g.lastRun === null) pass('R9.3-2 非法 lastRun 未落盘，回读为 null（不显示过期的 K）');
  else fail(`R9.3-2 非法 lastRun 竟然落盘了：${JSON.stringify(g.lastRun)}`);
  if (g.results?.c) pass('R9.3-2 同批的合法 results 照常写入（只丢 lastRun，不牵连结果）');
  else fail('R9.3-2 同批 results 被误丢');
}

// 3. count 超出本次结果条数 → 丢弃
{
  const r = await post({ results: entry('d'), lastRun: { scope: 'all', count: 99 } });
  if (r.lastRun === null) pass('R9.3-2 count(99) > 本次结果条数(1) 被丢弃');
  else fail(`R9.3-2 超界 count 未被丢弃：${JSON.stringify(r.lastRun)}`);
}

// 4. count 为负数 / 小数 / 字符串数字 → 丢弃
{
  const bads = [
    { scope: 'all', count: -1 },
    { scope: 'all', count: 1.5 },
    { scope: 'all', count: '2' },
    { scope: 'all' },
    { count: 1 },
    null,
  ];
  let ok = true;
  for (const bad of bads) {
    const r = await post({ results: entry('e'), lastRun: bad });
    if (r.lastRun !== null) { ok = false; fail(`R9.3-2 非法 lastRun 未被丢弃：${JSON.stringify(bad)}`); }
  }
  if (ok) pass('R9.3-2 负数 / 小数 / 字符串 / 缺字段 / null 的 lastRun 全部被丢弃');
}

// 5. count 恰等于本次结果条数 → 接受（边界）
{
  const r = await post({ results: { ...entry('f'), ...entry('g') }, lastRun: { scope: 'registered', count: 2 } });
  if (r.lastRun?.count === 2) pass('R9.3-2 count == 本次结果条数（边界）被接受');
  else fail(`R9.3-2 边界 count 被误拒：${JSON.stringify(r.lastRun)}`);
}

// 6. 缺 lastRun → 不落盘、返回 null，且不残留上一轮的 K
{
  const r = await post({ results: entry('h') });
  if (r.lastRun === null) pass('R9.3-2 不提交 lastRun 时返回 null');
  else fail(`R9.3-2 未提交 lastRun 却返回了值：${JSON.stringify(r.lastRun)}`);
  const g = await get();
  if (g.lastRun === null) pass('R9.3-2 未提交 lastRun 时上一轮的 K 已被清掉（不显示过期数字）');
  else fail(`R9.3-2 残留了上一轮 lastRun：${JSON.stringify(g.lastRun)}`);
}

// 7. 清空体检结果 → lastRun 一并消失
{
  await fetch(`${BASE}/api/probe-results`, { method: 'DELETE' });
  const g = await get();
  if (g.lastRun === null && Object.keys(g.results || {}).length === 0) {
    pass('R9.3-2 DELETE 清空体检结果后 lastRun 一并消失');
  } else {
    fail(`R9.3-2 清空后仍残留：${JSON.stringify(g)}`);
  }
}

cleanup();
console.log(failures ? `\n存在 ${failures} 项失败` : '\n全部通过');
process.exit(failures ? 1 : 0);
