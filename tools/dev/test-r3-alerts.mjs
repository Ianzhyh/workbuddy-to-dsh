/**
 * R3 主动提醒 验收（Task 14–15）。
 *
 *   node tools/dev/test-r3-alerts.mjs
 *
 * 覆盖：标签页标题四态、顶部提示条（桥不可用 / 令牌临期 / 新失败 / 未签到）、
 * 水位线持久化、跨天恢复、转义、提醒数与面板同源。
 */
import { startStaticServer, openPage, waitFor, q, sleep } from './ui-harness.mjs';

const PORT = 8789;
const URL_ = `http://127.0.0.1:${PORT}/`;

let failures = 0;
const fail = (m) => { console.error('✗ ' + m); failures += 1; };
const pass = (m) => console.log('✓ ' + m);

const now = Date.now();
const CATALOG = ['alpha', 'beta', 'gamma', 'delta'].map((id) => ({
  id, name: id.toUpperCase(), context_window: 128000, max_output_tokens: 8192, credits: 0.11,
}));

/**
 * 夹具由 **Node 侧**维护：页面重载后 `addScriptToEvaluateOnNewDocument` 会把
 * `window.__FIX` 重置成初始快照，所以每次重载后都要把当前值重新注入回去。
 */
const FIX = {
  bridge: { running: true, ok: true, host: '127.0.0.1', port: 8790, endpoint: 'http://127.0.0.1:8790/v1', pid: 4242, startedAt: new Date(now - 1000).toISOString(), uptimeMs: 1000, catalogSize: 4, catalogAt: new Date(now - 60000).toISOString(), error: null },
  remainingMs: 40 * 86400000,
  requests: [],
  checkin: { active: true, todayCheckedIn: true, todayCredit: 18, streakDays: 3 },
};

const routes = {
  '/api/models': { body: { models: CATALOG } },
  '/api/overview': {
    body: () => ({
      bridge: window.__FIX.bridge,
      credentials: { active: { account: '330000000000', userId: '330000000000', remainingMs: window.__FIX.remainingMs, expiresAt: Date.now() + window.__FIX.remainingMs }, error: '' },
      quota: { total: 10, packages: [] },
      dsh: { routeLive: true, hasBridgeKey: true, bundlesOk: true, bundles: [], registeredModels: ['alpha'] },
      console: { version: '1.0.0', node: 'v22' },
    }),
  },
  '/api/probe-results': { body: { updatedAt: null, results: {}, lastRun: null } },
  '/api/diagnose': { body: { items: [] } },
  '/api/usage': { body: { usage: null } },
  '/api/requests': { body: () => ({ requests: window.__FIX.requests }) },
  '/api/accounts': { body: { accounts: [] } },
  '/api/checkin': { body: () => ({ status: window.__FIX.checkin }) },
  '/api/bridge/log': { body: { lines: [] } },
};

// localStorage 只在**首次**文档清一次：用 sessionStorage 做哨兵（重载后仍在），
// 否则每次重载都会把失败水位线抹掉，「刷新后不重复提醒」就没法验了
const INJECT = `(() => {
  window.__FIX = ${JSON.stringify(FIX)};
  try {
    if (!sessionStorage.getItem('__seeded')) { localStorage.clear(); sessionStorage.setItem('__seeded', '1'); }
  } catch (e) { /* 忽略 */ }
})();`;

const server = await startStaticServer(PORT);
const { cdp, close } = await openPage(URL_, routes, { inject: INJECT });
const cleanup = () => { try { cdp.close(); } catch { /* 忽略 */ } try { server.close(); } catch { /* 忽略 */ } };
process.on('exit', cleanup);

const title = () => q(cdp, `document.title`);
const alertText = () => q(cdp, `[...document.querySelectorAll('#alertBar .alert')].map(e => e.querySelector('.alert-text').textContent).join(' | ')`);
const alertHidden = () => q(cdp, `document.querySelector('#alertBar').hidden`);
const alertHtml = () => q(cdp, `document.querySelector('#alertBar').textContent`);
const ls = (k) => q(cdp, `(function(){ try { return localStorage.getItem(${JSON.stringify(k)}); } catch(e){ return null; } })()`);
const setFix = (patch) => { Object.assign(FIX, patch); return q(cdp, `(window.__FIX = ${JSON.stringify(FIX)}, true)`); };

/** 重新拉一遍数据（不走 refreshBtn，免得和它的禁用逻辑纠缠） */
const reloadData = () => q(cdp, `(async () => {
  await loadOverview(); await loadModels(); await loadRequests(); await loadCheckin(); return true;
})()`);

/** 点某个提示上的按钮（按文案定位）。 */
const clickAlertBtn = (match, which) => q(cdp, `(() => {
  const b = [...document.querySelectorAll('#alertBar [data-alert-${which}]')]
    .find(x => x.closest('.alert').textContent.includes(${JSON.stringify(match)}));
  if (!b) return false;
  b.click(); return true;
})()`);

async function reloadPage() {
  try { await q(cdp, `(location.reload(), true)`); } catch { /* 导航期间上下文会失效 */ }
  await sleep(800);
  await waitFor(cdp, `!!document.querySelector('#modelTable tbody tr')`, 10000, '重载后模型表');
  await q(cdp, `(window.__FIX = ${JSON.stringify(FIX)}, true)`); // 恢复夹具
  await reloadData();
  await sleep(300);
}

try {
  await waitFor(cdp, `document.querySelectorAll('#modelTable tbody tr').length === 4`, 10000, '模型表渲染');
  await sleep(300);

  // ── R3.1-1 基线标题 ─────────────────────────────────────────────────
  {
    const t = await title();
    if (t === '桥运行中 · 4 模型 · WorkBuddy 中转控制台') pass(`R3.1-1 正常态标题：${t}`);
    else fail(`R3.1-1 标题应为「桥运行中 · 4 模型 · WorkBuddy 中转控制台」，实际「${t}」`);
    if (await alertHidden()) pass('R3.2 一切正常时提示条隐藏');
    else fail(`R3.2 无异常时提示条不该出现：「${await alertText()}」`);
  }

  // ── R3.2-1 桥不可用 ─────────────────────────────────────────────────
  {
    await setFix({ bridge: { ...FIX.bridge, running: false, ok: false } });
    await reloadData(); await sleep(250);
    const t = await title();
    if (/^⚠ 桥未运行/.test(t)) pass(`R3.1-1 桥掉线 → 标题「${t}」`);
    else fail(`R3.1-1 桥掉线标题应为「⚠ 桥未运行 · …」，实际「${t}」`);
    if (!/4242|4242/.test(t) && !/\d{4,}/.test(t)) pass('R3.1-2 标题不含 PID 这类频繁变化的数字');
    else fail(`R3.1-2 标题里出现了 PID：${t}`);

    const body = await alertHtml();
    if (/桥未运行/.test(body) && /启动桥服务/.test(body)) pass('R3.2-1 桥不可用提示含「启动桥服务」');
    else fail(`R3.2-1 桥不可用提示异常：「${body}」`);
    const dismiss = await q(cdp, `document.querySelectorAll('#alertBar [data-alert-dismiss]').length`);
    if (dismiss === 0) pass('R3.2-1 桥不可用提示**不可关闭**');
    else fail(`R3.2-1 桥不可用提示竟然可以关闭（${dismiss} 个关闭按钮）`);

    await setFix({ bridge: { ...FIX.bridge, running: true, ok: true } });
    await reloadData(); await sleep(250);
    if (await alertHidden()) pass('R3.2-1 桥恢复后提示自动消失');
    else fail(`R3.2-1 桥恢复后提示仍在：「${await alertText()}」`);
  }

  // ── R3.2-2 令牌临期 ─────────────────────────────────────────────────
  {
    await setFix({ remainingMs: 2 * 86400000 });
    await reloadData(); await sleep(250);
    const text = await alertText();
    if (/2 天后到期/.test(text) && /续期/.test(text) && /401/.test(text)) {
      pass(`R3.2-2 令牌 ≤3 天提醒且措辞如实：${text}`);
    } else {
      fail(`R3.2-2 令牌提醒文案不符：「${text}」`);
    }

    await clickAlertBtn('到期', 'dismiss');
    await sleep(250);
    if (await alertHidden()) pass('R3.2-2 令牌提醒可关闭');
    else fail(`R3.2-2 关闭后仍在：「${await alertText()}」`);
    if (await ls('wb.muted.token') === '1') pass('R3.2-2 静默标记已写入 wb.muted.token');
    else fail('R3.2-2 静默标记未写入');

    await setFix({ remainingMs: 40 * 86400000 });
    await reloadData(); await sleep(200);
    if (await alertHidden()) pass('R3.2-2 令牌充足后不提醒');
    else fail('R3.2-2 令牌充足却仍提醒');
  }

  // ── R3.2-3 / R3.2-4 新失败 + 水位线 ─────────────────────────────────
  {
    await setFix({
      requests: [
        { t: now - 5000, model: 'alpha', stream: false, ok: false, ms: 100, status: 400, code: 'bad', error: 'boom-1' },
        { t: now - 4000, model: 'beta', stream: false, ok: false, ms: 100, status: 500, code: 'bad', error: 'boom-2' },
        { t: now - 3000, model: 'gamma', stream: false, ok: true, ms: 100, promptTokens: 1, completionTokens: 1, credit: 0 },
      ],
    });
    await reloadData(); await sleep(250);
    const text = await alertText();
    const t = await title();
    if (/2 条新的失败/.test(text)) pass(`R3.2-3 新失败提醒计数正确：${text}`);
    else fail(`R3.2-3 新失败提醒异常：「${text}」`);
    if (/新失败 2/.test(t)) pass(`R3.1-2 标题追加「 · 新失败 2」：${t}`);
    else fail(`R3.1-2 标题未追加新失败：${t}`);

    // R3.3-1 与面板同源同算
    const panelCount = await q(cdp, `(function(){
      const w = Number(localStorage.getItem('wb.failSeenTs') || 0);
      return lastRequests.filter(r => !r.ok && Number(r.t) > w).length;
    })()`);
    const barCount = await q(cdp, `(function(){
      const m = (document.querySelector('#alertBar .alert-text')||{}).textContent || '';
      const g = m.match(/(\\d+) 条新的失败/);
      return g ? Number(g[1]) : -1;
    })()`);
    if (panelCount === 2 && barCount === panelCount) {
      pass(`R3.3-1 提示条失败数(${barCount}) == 比水位线新的失败行数(${panelCount})`);
    } else {
      fail(`R3.3-1 两处数字不一致：提示条 ${barCount} / 面板 ${panelCount}`);
    }

    await clickAlertBtn('新的失败', 'dismiss');
    await sleep(250);
    const wm = await ls('wb.failSeenTs');
    if (wm && Number(wm) > 0) pass(`R3.2-3 点「知道了」推进水位线并落盘（wb.failSeenTs=${wm}）`);
    else fail(`R3.2-3 水位线未落盘：${wm}`);
    if (await alertHidden()) pass('R3.2-3 关闭后提醒消失');
    else fail('R3.2-3 关闭后提醒仍在');
    if (!/新失败/.test(await title())) pass('R3.2-3 标题里的「新失败」同步清除');
    else fail(`R3.2-3 标题仍有新失败：${await title()}`);

    await reloadPage();
    if (await alertHidden()) pass('R3.2-3 刷新页面后**不**重复提醒同一批失败（水位线持久化）');
    else fail(`R3.2-3 刷新后又提醒了：「${await alertText()}」`);

    // 更新的失败 → 再次提醒
    await setFix({
      requests: [
        { t: now - 5000, model: 'alpha', stream: false, ok: false, ms: 100, status: 400, code: 'bad', error: 'boom-1' },
        { t: now + 60000, model: 'delta', stream: false, ok: false, ms: 100, status: 502, code: 'bad', error: 'boom-3' },
      ],
    });
    await reloadData(); await sleep(250);
    const text3 = await alertText();
    if (/1 条新的失败/.test(text3)) pass('R3.2-4 出现更新的失败 → 再次提醒，计数正确（1 条）');
    else fail(`R3.2-4 再次提醒异常：「${text3}」`);
  }

  // ── R3.2-5 未签到 ───────────────────────────────────────────────────
  {
    await setFix({ requests: [], checkin: { active: true, todayCheckedIn: false, todayCredit: 18, streakDays: 3 } });
    await reloadData(); await sleep(250);
    const text = await alertText();
    if (/今天还没签到/.test(text)) pass(`R3.2-5 未签到提醒出现：${text}`);
    else fail(`R3.2-5 未签到提醒未出现：「${text}」`);
    const hasBtn = await q(cdp, `!!document.querySelector('#alertBar .alert button[data-alert-act]')`);
    if (hasBtn) pass('R3.2-5 未签到提醒带动作按钮');
    else fail('R3.2-5 未签到提醒缺少动作按钮');

    await clickAlertBtn('签到', 'dismiss');
    await sleep(250);
    const muted = await ls('wb.muted.checkin');
    const today = await q(cdp, `localDateStr()`);
    if (muted === today) pass(`R3.2-5 关闭状态按**本地日期**记（wb.muted.checkin=${muted}）`);
    else fail(`R3.2-5 静默日期不符：${muted} vs ${today}`);
    if (await alertHidden()) pass('R3.2-5 关闭后当天不再出现');
    else fail('R3.2-5 关闭后仍在');

    // 跨天恢复：把静默日期改成很久以前，然后**真实重载**（initAlerts 会重新读取）
    await q(cdp, `(localStorage.setItem('wb.muted.checkin', '2000-01-01'), true)`);
    await reloadPage();
    if (!(await alertHidden())) pass('R3.2-5 跨天后提醒自动恢复');
    else fail('R3.2-5 跨天后未恢复提醒');

    await setFix({ checkin: { active: true, todayCheckedIn: true, todayCredit: 18, streakDays: 4 } });
    await reloadData(); await sleep(250);
    if (await alertHidden()) pass('R3.2-5 已签到后不再提醒');
    else fail('R3.2-5 已签到却仍提醒');
  }

  // ── R3.2-6 转义 ─────────────────────────────────────────────────────
  {
    await setFix({ bridge: { ...FIX.bridge, running: true, ok: false, error: '<img src=x onerror=window.__XSS=1>' } });
    await reloadData(); await sleep(250);
    const injected = await q(cdp, `!!document.querySelector('#alertBar img')`);
    const xss = await q(cdp, `!!window.__XSS`);
    if (!injected && !xss) pass('R3.2-6 提示条文案经过 escapeAttr（未产生元素注入）');
    else fail(`R3.2-6 发生了注入：img=${injected} xss=${xss}`);
    await setFix({ bridge: { ...FIX.bridge, ok: true, error: null } });
    await reloadData(); await sleep(200);
  }
} catch (err) {
  fail(`异常中断：${err.message}`);
} finally {
  cleanup();
}

console.log(failures ? `\n存在 ${failures} 项失败` : '\n全部通过');
process.exit(failures ? 1 : 0);
