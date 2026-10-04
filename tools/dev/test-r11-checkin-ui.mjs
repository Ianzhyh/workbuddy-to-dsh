/**
 * R11 签到面板 验收（Task 33）。
 *
 *   node tools/dev/test-r11-checkin-ui.mjs
 *
 * 覆盖：开关默认开且可写、说明写清两条触发路径与「桥侧需重启」、
 * 状态三分支（自动/手动已签、失败红字、国际版无活动）、手动路径保留、
 * 与未签到提醒的一致性。
 */
import { startStaticServer, openPage, waitFor, q, sleep } from './ui-harness.mjs';

const PORT = 8776;
const URL_ = `http://127.0.0.1:${PORT}/`;

let failures = 0;
const fail = (m) => { console.error('✗ ' + m); failures += 1; };
const pass = (m) => console.log('✓ ' + m);

const now = Date.now();
const CATALOG = [{ id: 'alpha', name: 'ALPHA', context_window: 128000, max_output_tokens: 8192, credits: 0.11 }];
const HHMM = new Date(now - 600000).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' });

const FIX = {
  status: { active: true, todayCheckedIn: true, streakDays: 6, dailyCredit: 18 },
  checkin: { auto: true, lastAt: now - 600000, lastResult: 'ok', lastError: null, lastSource: 'startup' },
};

const routes = {
  '/api/models': { body: { models: CATALOG } },
  '/api/overview': {
    body: {
      bridge: { running: true, ok: true, host: '127.0.0.1', port: 8790, endpoint: 'http://127.0.0.1:8790/v1', pid: 1, startedAt: new Date(now - 1000).toISOString(), uptimeMs: 1000, catalogSize: 1, catalogAt: new Date(now - 60000).toISOString() },
      credentials: { active: { account: 'a', userId: 'a', remainingMs: 40 * 86400000, expiresAt: now + 40 * 86400000 }, error: '' },
      quota: { total: 10, packages: [] },
      dsh: { routeLive: true, hasBridgeKey: true, bundlesOk: true, bundles: [], registeredModels: [] },
      console: { version: '1.0.0', node: 'v22' },
    },
  },
  '/api/probe-results': { body: { updatedAt: null, results: {}, lastRun: null } },
  '/api/diagnose': { body: { items: [] } },
  '/api/usage': { body: { usage: null } },
  '/api/requests': { body: { requests: [] } },
  '/api/accounts': { body: { accounts: [] } },
  '/api/checkin': {
    body: () => ({ ok: true, status: window.__FIX.status, checkin: window.__FIX.checkin }),
  },
  '/api/checkin/settings': { body: () => ({ saved: true, checkin: window.__FIX.checkin }) },
  '/api/bridge/log': { body: { lines: [] } },
};

const INJECT = `(() => { window.__FIX = ${JSON.stringify(FIX)}; try { localStorage.clear(); } catch (e) {} })();`;

const server = await startStaticServer(PORT);
const { cdp, close } = await openPage(URL_, routes, { inject: INJECT });
const cleanup = () => { try { cdp.close(); } catch { /* 忽略 */ } try { server.close(); } catch { /* 忽略 */ } };
process.on('exit', cleanup);

const boxText = () => q(cdp, `document.querySelector('#checkinBox').textContent`);
const alertText = () => q(cdp, `[...document.querySelectorAll('#alertBar .alert')].map(e => e.querySelector('.alert-text').textContent).join(' | ')`);
const setFix = (patch) => { Object.assign(FIX, patch); return q(cdp, `(window.__FIX = ${JSON.stringify(FIX)}, true)`); };
const reloadData = () => q(cdp, `(async () => { await loadCheckin(); await loadRequests(); return true; })()`);
const posts = (path) => q(cdp, `window.__posts.filter(p => p.path === ${JSON.stringify(path)}).map(p => p.body)`);

try {
  await waitFor(cdp, `!!document.querySelector('#checkinAuto')`, 10000, '签到面板渲染');
  await sleep(300);

  // ── R11.1-1 / R11.1-2 开关与说明 ────────────────────────────────────
  {
    const checked = await q(cdp, `document.querySelector('#checkinAuto').checked`);
    if (checked) pass('R11.1-1「每日自动签到」默认勾选');
    else fail('R11.1-1 默认未勾选');

    const text = await boxText();
    if (/桥在跑：每天首次模型请求时自动签/.test(text) && /控制台开着：启动时与每小时检查一次/.test(text)) {
      pass('R11.1-2 说明写清两条触发路径');
    } else {
      fail(`R11.1-2 触发路径说明缺失：${text.slice(0, 120)}`);
    }
    if (/桥侧需重启桥生效/.test(text)) pass('R11.1-2 如实标注「桥侧需重启桥生效」');
    else fail('R11.1-2 未标注桥侧生效时机');
    if (/上次尝试：/.test(text)) pass(`R11.1-2 / R11.4-1「上次自动尝试」可追溯`);
    else fail(`R11.1-2 缺少「上次尝试」：${text.slice(0, 140)}`);
  }

  // ── R11.4-1 分支一：今日已签到 · 自动 ───────────────────────────────
  {
    const text = await boxText();
    if (new RegExp('今日已签到 · 自动（' + HHMM.replace(':', '\\:') + '）').test(text)) {
      pass(`R11.4-1 显示「今日已签到 · 自动（${HHMM}）」`);
    } else {
      fail(`R11.4-1 自动已签分支异常：${text.slice(0, 140)}`);
    }
    const alert = await alertText();
    if (!/还没签到/.test(alert)) pass('R11.5-2 自动签到成功 → **不**出现「未签到」提醒');
    else fail(`R11.5-2 已签却仍提醒：「${alert}」`);
  }

  // ── R11.4-1 分支一（续）：手动 ──────────────────────────────────────
  {
    await setFix({ checkin: { auto: true, lastAt: now - 300000, lastResult: 'ok', lastError: null, lastSource: 'manual' } });
    await reloadData();
    await sleep(300);
    const text = await boxText();
    if (/今日已签到 · 手动（\d{2}:\d{2}）/.test(text)) pass('R11.4-1 手动签到时标注「手动（HH:MM）」');
    else fail(`R11.4-1 手动分支异常：${text.slice(0, 140)}`);
  }

  // ── R11.4-1 分支二：自动签到失败（红字 + 可手动重试）────────────────
  {
    await setFix({
      status: { active: true, todayCheckedIn: false, streakDays: 5, dailyCredit: 18 },
      checkin: { auto: true, lastAt: now - 120000, lastResult: 'error', lastError: 'upstream boom', lastSource: 'hourly' },
    });
    await reloadData();
    await sleep(300);
    const text = await boxText();
    if (/自动签到失败：upstream boom（\d{2}:\d{2}）· 可手动重试/.test(text)) {
      pass('R11.4-1 失败分支：红字原因 + 「可手动重试」');
    } else {
      fail(`R11.4-1 失败分支异常：${text.slice(0, 160)}`);
    }
    const isRed = await q(cdp, `!!document.querySelector('#checkinBox .acct-sub.errline')`);
    if (isRed) pass('R11.4-1 失败文案带 errline 样式（红字，不静默）');
    else fail('R11.4-1 失败文案没有红字样式');

    const alert = await alertText();
    if (/还没签到/.test(alert) && /上次自动签到失败：upstream boom/.test(alert)) {
      pass(`R11.5-2 失败时提醒出现且带上失败原因：${alert}`);
    } else {
      fail(`R11.5-2 提醒未带失败原因：「${alert}」`);
    }
    const hasBtn = await q(cdp, `!!document.querySelector('#checkinBtn')`);
    if (hasBtn) pass('R11.5-1 未签到时「立即签到」按钮保留');
    else fail('R11.5-1 缺少手动签到入口');
  }

  // ── R11.4-1 分支三：国际版无签到活动 ────────────────────────────────
  {
    await setFix({
      status: { active: false, todayCheckedIn: false, streakDays: 0, dailyCredit: 0 },
      checkin: { auto: true, lastAt: now - 60000, lastResult: 'no-activity', lastError: null, lastSource: 'startup' },
    });
    await reloadData();
    await sleep(300);
    const text = await boxText();
    if (/当前账号没有签到活动（国际版网关不含积分系统）/.test(text)) {
      pass('R11.4-1 第三分支：国际版如实说明，不算失败');
    } else {
      fail(`R11.4-1 无活动分支异常：${text.slice(0, 140)}`);
    }
    if (!/自动签到失败/.test(text)) pass('R11.4-1 无签到活动**不**被显示成失败');
    else fail('R11.4-1 无活动被误显示为失败');
    const alert = await alertText();
    if (!/还没签到/.test(alert)) pass('R11.4-1 无签到活动时不弹「未签到」提醒');
    else fail(`R11.4-1 无活动却提醒未签到：「${alert}」`);
  }

  // ── R11.1-1 开关写入 ────────────────────────────────────────────────
  {
    await setFix({ status: { active: true, todayCheckedIn: true, streakDays: 6, dailyCredit: 18 } });
    await reloadData();
    await sleep(300);
    await q(cdp, `(window.__posts = [], true)`);
    await q(cdp, `(() => { const cb = document.querySelector('#checkinAuto'); cb.checked = false; cb.dispatchEvent(new Event('change')); return true; })()`);
    await sleep(500);
    const sent = await posts('/api/checkin/settings');
    if (sent.length === 1 && sent[0].auto === false) {
      pass('R11.1-1 取消勾选 → POST /api/checkin/settings {auto:false}');
    } else {
      fail(`R11.1-1 开关未写入：${JSON.stringify(sent)}`);
    }
  }

  // ── R11.5-1 手动签到（走同一接口、标注 manual）──────────────────────
  {
    await setFix({
      status: { active: true, todayCheckedIn: false, streakDays: 5, dailyCredit: 18 },
      checkin: { auto: true, lastAt: now - 60000, lastResult: 'ok', lastError: null, lastSource: 'startup' },
    });
    await reloadData();
    await sleep(300);
    await q(cdp, `(window.__reqs = [], true)`);
    // 模拟服务端：手动签完之后状态变为「已签到 · 手动」
    await q(cdp, `(window.__FIX.status = { active: true, todayCheckedIn: true, streakDays: 6, dailyCredit: 18 },
      window.__FIX.checkin = { auto: true, lastAt: Date.now(), lastResult: 'ok', lastError: null, lastSource: 'manual' }, true)`);
    await q(cdp, `(document.querySelector('#checkinBtn').click(), true)`);
    await sleep(600);
    // 手动签到不带 body，只能按 {path, method} 计数
    const sent = await q(cdp, `window.__reqs.filter(r => r.path === '/api/checkin' && r.method === 'POST').length`);
    if (sent === 1) pass('R11.5-1「立即签到」走 POST /api/checkin（与自动同一接口）');
    else fail(`R11.5-1 手动签到请求异常：POST ${sent} 次`);
    const text = await boxText();
    if (/今日已签到 · 手动（\d{2}:\d{2}）/.test(text)) pass('R11.5-1 手动成功后状态标注为「手动」');
    else fail(`R11.5-1 手动后状态异常：${text.slice(0, 140)}`);
  }
} catch (err) {
  fail(`异常中断：${err.message}`);
} finally {
  cleanup();
}

console.log(failures ? `\n存在 ${failures} 项失败` : '\n全部通过');
process.exit(failures ? 1 : 0);
