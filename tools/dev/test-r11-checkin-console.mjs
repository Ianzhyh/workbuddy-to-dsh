/**
 * R11 控制台侧自动签到 验收（Task 32）。
 *
 *   node tools/dev/test-r11-checkin-console.mjs
 *
 * 做法：stub 一个「桥」（只服务 /v1/checkin）+ 临时端口的控制台。
 * 断言：启动时检查一次、条件不满足不打上游、结果落盘、冷却生效、开关可写。
 *
 * 安全：.state.json 里可能有真实数据，本脚本**先快照、结束时还原**。
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const STATE = join(root, '.state.json');
const BRIDGE_PORT = 8777;   // 控制台会把这个当成「桥」的端口
const CONSOLE_PORT = 8778;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const fail = (m) => { console.error('✗ ' + m); failures += 1; };
const pass = (m) => console.log('✓ ' + m);

const snapshot = existsSync(STATE) ? readFileSync(STATE, 'utf8') : null;
const restore = () => {
  try {
    if (snapshot === null) { if (existsSync(STATE)) rmSync(STATE, { force: true }); }
    else writeFileSync(STATE, snapshot, 'utf8');
  } catch { /* 尽力还原 */ }
};

/**
 * 重置签到状态但**保留其余键**（probe / authFile 等是用户的真实数据）。
 * 早前直接写 `{}`：万一脚本中途被 SIGKILL，用户的体检结论就没了。
 */
const baseState = (() => { try { return JSON.parse(snapshot || '{}') || {}; } catch { return {}; } })();
const resetCheckin = (extra = {}) => {
  const s = { ...baseState, checkin: { auto: true, lastAt: 0, lastResult: null, lastError: null, lastSource: null, ...extra } };
  writeFileSync(STATE, `${JSON.stringify(s, null, 2)}\n`, 'utf8');
};

// ── stub 桥 ─────────────────────────────────────────────────────────────
let statusObj = { active: true, todayCheckedIn: false, streakDays: 5, dailyCredit: 18 };
let getHits = 0;
let postHits = 0;
let postMode = 'ok'; // 'ok' | 'already' | 'error'
const stub = createServer((req, res) => {
  const p = (req.url || '').split('?')[0];
  const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if (p === '/v1/checkin' && req.method === 'GET') {
    getHits += 1;
    return send(200, { ok: true, status: statusObj });
  }
  if (p === '/v1/checkin' && req.method === 'POST') {
    postHits += 1;
    if (postMode === 'error') return send(502, { ok: false, error: 'upstream boom' });
    if (postMode === 'already') return send(200, { ok: true, already: true, credit: 0, status: statusObj });
    statusObj = { ...statusObj, todayCheckedIn: true };
    return send(200, { ok: true, already: false, credit: 18, status: statusObj });
  }
  res.writeHead(404).end();
});

let consoleProc = null;
const cleanup = () => {
  try { consoleProc?.kill(); } catch { /* 已退出 */ }
  try { stub.close(); } catch { /* 已关闭 */ }
  restore();
};
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });

function startConsole(extraEnv = {}) {
  consoleProc = spawn(process.execPath, [join(root, 'dashboard', 'server.mjs')], {
    cwd: root,
    env: {
      ...process.env,
      DASHBOARD_PORT: String(CONSOLE_PORT),
      DASHBOARD_AUTO_START_BRIDGE: '0',
      DASHBOARD_OPEN_BROWSER: '0',
      WORKBUDDY_PORT: String(BRIDGE_PORT), // 控制台据此找「桥」
      WORKBUDDY_LOG: '0',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

async function waitReady() {
  for (let i = 0; i < 40; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${CONSOLE_PORT}/api/checkin`);
      if (r.ok) return true;
    } catch { /* 还没起来 */ }
    await sleep(250);
  }
  return false;
}

const stateCheckin = () => {
  try { return JSON.parse(readFileSync(STATE, 'utf8')).checkin || null; } catch { return null; }
};
const post = (path, body) => fetch(`http://127.0.0.1:${CONSOLE_PORT}${path}`, {
  method: 'POST',
  // 面板头：控制台对写操作的要求（挡跨站请求），少一个就 403
  headers: { 'Content-Type': 'application/json', 'x-workbuddy-panel': '1' },
  body: JSON.stringify(body),
}).then((r) => r.json());

// ── 开跑 ────────────────────────────────────────────────────────────────
await new Promise((ok) => stub.listen(BRIDGE_PORT, '127.0.0.1', ok));
resetCheckin(); // 干净起点（保留 probe 等真实数据）

// 1. R11.3-1 启动时检查一次：没签 → 打上游 → 结果落盘
{
  startConsole();
  if (!await waitReady()) { fail('控制台未能就绪'); cleanup(); process.exit(1); }
  console.log(`控制台就绪：http://127.0.0.1:${CONSOLE_PORT}\n`);

  await sleep(4200); // 启动 tick 有 3 秒延迟
  if (getHits >= 1 && postHits === 1) {
    pass(`R11.3-1 启动时先查「签了没」（GET ${getHits} 次）再决定是否打上游（POST ${postHits} 次）`);
  } else {
    fail(`R11.3-1 启动检查异常：GET=${getHits} POST=${postHits}`);
  }
  const c = stateCheckin();
  if (c && c.auto === true && c.lastResult === 'ok' && c.lastSource === 'startup') {
    pass(`R11.3-2 结果落盘 .state.json：${JSON.stringify({ auto: c.auto, lastResult: c.lastResult, lastSource: c.lastSource })}`);
  } else {
    fail(`R11.3-2 落盘异常：${JSON.stringify(c)}`);
  }
  if (typeof c.lastAt === 'number' && c.lastAt > 0) pass('R11.3-2 记录了 lastAt（面板「上次尝试」可追溯）');
  else fail(`R11.3-2 lastAt 异常：${c.lastAt}`);
}

// 2. R11.3-1 冷却：重启控制台也不重复打上游
{
  consoleProc.kill();
  await sleep(400);
  const beforePost = postHits;
  startConsole();
  if (!await waitReady()) { fail('控制台重启失败'); cleanup(); process.exit(1); }
  await sleep(4200);
  if (postHits === beforePost) pass('R11.3-1 距上次尝试 <1 小时 → 重启控制台也不重复签到');
  else fail(`R11.3-1 冷却未生效：又打了 ${postHits - beforePost} 次`);
}

// 3. R11.1-1 开关写入
{
  const r = await post('/api/checkin/settings', { auto: false });
  const c = stateCheckin();
  if (r.saved && c && c.auto === false) pass('R11.1-1 关闭开关写入 .state.json 的 checkin.auto=false');
  else fail(`R11.1-1 开关写入异常：${JSON.stringify({ r, c })}`);

  // 关掉后重启：即使没有冷却也不该打上游
  consoleProc.kill();
  await sleep(400);
  startConsole();
  if (!await waitReady()) { fail('控制台重启失败'); cleanup(); process.exit(1); }
  // 探活本身会代理一次 GET，必须在探活**之后**再取基线
  const beforeGet = getHits;
  const beforePost = postHits;
  await sleep(4200);
  if (getHits === beforeGet && postHits === beforePost) {
    pass('R11.1-1 开关关闭后控制台侧完全不发起（连「查状态」都不打）');
  } else {
    fail(`R11.1-1 关闭后仍在请求：GET +${getHits - beforeGet} POST +${postHits - beforePost}`);
  }
  const bad = await post('/api/checkin/settings', { auto: 'yes' });
  if (!bad.saved) pass('R11.1-1 非法开关值被拒绝（auto 必须是布尔值）');
  else fail('R11.1-1 非法值竟然被接受');
}

// 4. R11.3-1 已签到 → 不重复打上游，如实记 already
{
  statusObj = { active: true, todayCheckedIn: true, streakDays: 6, dailyCredit: 18 };
  resetCheckin();
  consoleProc.kill();
  await sleep(400);
  const beforePost = postHits;
  startConsole();
  if (!await waitReady()) { fail('控制台重启失败'); cleanup(); process.exit(1); }
  await sleep(4200);
  const c = stateCheckin();
  if (postHits === beforePost && c && c.lastResult === 'already') {
    pass('R11.3-1 已签到 → 不打上游，如实记 result=already');
  } else {
    fail(`R11.3-1 已签到分支异常：POST +${postHits - beforePost} / ${JSON.stringify(c)}`);
  }
}

// 5. R11.4 国际版（无签到活动）→ no-activity，不算失败
{
  statusObj = { active: false, todayCheckedIn: false, streakDays: 0, dailyCredit: 0 };
  resetCheckin();
  consoleProc.kill();
  await sleep(400);
  const beforePost = postHits;
  startConsole();
  if (!await waitReady()) { fail('控制台重启失败'); cleanup(); process.exit(1); }
  await sleep(4200);
  const c = stateCheckin();
  if (postHits === beforePost && c && c.lastResult === 'no-activity' && !c.lastError) {
    pass('R11.4 无签到活动 → result=no-activity，不记成失败');
  } else {
    fail(`R11.4 无活动分支异常：POST +${postHits - beforePost} / ${JSON.stringify(c)}`);
  }
}

// 6. R11.4 上游失败 → error 带原因（不静默）
{
  statusObj = { active: true, todayCheckedIn: false, streakDays: 5, dailyCredit: 18 };
  postMode = 'error';
  resetCheckin();
  consoleProc.kill();
  await sleep(400);
  startConsole();
  if (!await waitReady()) { fail('控制台重启失败'); cleanup(); process.exit(1); }
  await sleep(4200);
  const c = stateCheckin();
  if (c && c.lastResult === 'error' && /upstream boom/.test(c.lastError || '')) {
    pass(`R11.4 上游失败 → result=error 且留痕原因：${c.lastError}`);
  } else {
    fail(`R11.4 失败分支异常：${JSON.stringify(c)}`);
  }
}

// 7. R11.5-1 手动签到：走同一接口、结果标注 manual
{
  postMode = 'ok';
  statusObj = { active: true, todayCheckedIn: false, streakDays: 5, dailyCredit: 18 };
  resetCheckin();
  consoleProc.kill();
  await sleep(400);
  startConsole();
  if (!await waitReady()) { fail('控制台重启失败'); cleanup(); process.exit(1); }
  const r = await post('/api/checkin', {});
  const c = stateCheckin();
  if (r.ok && c && c.lastSource === 'manual' && c.lastResult === 'ok') {
    pass('R11.5-1 手动签到走同一接口，结果标注 lastSource=manual');
  } else {
    fail(`R11.5-1 手动分支异常：${JSON.stringify({ ok: r.ok, c })}`);
  }
  // GET 也要把本地状态带回给页面
  const g = await fetch(`http://127.0.0.1:${CONSOLE_PORT}/api/checkin`).then((x) => x.json());
  if (g.checkin && g.checkin.lastSource === 'manual') pass('R11.5-1 /api/checkin 把本地状态一起带回（页面据此显示「手动」）');
  else fail(`R11.5-1 响应缺 checkin：${JSON.stringify(g.checkin)}`);
}

cleanup();
console.log(failures ? `\n存在 ${failures} 项失败` : '\n全部通过');
process.exit(failures ? 1 : 0);
