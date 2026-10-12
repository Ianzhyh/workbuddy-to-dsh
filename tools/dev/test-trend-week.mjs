/**
 * 趋势图「按周」粒度 验收（交接文档未完成项）。
 *
 *   node tools/dev/test-trend-week.mjs
 *
 * ## 口径（与实现同源，改了一边要改另一边）
 *
 * - 「按周」= 取数窗口 **84 天（12 周）**，按**自然周**分桶，**周一为一周之首**。
 * - 桶的起点锚在**数据**上：从「最早一天所在的那一周」画到「本周」，
 *   中间**空周补 0**。为什么不是固定画 12 个桶：取数窗口是**滚动 84 天**
 *   而不是对齐到周一，窗口首尾那两个半截周与 12 个整周对不齐 ——
 *   固定 12 桶会把窗口里最早那几天的数据漏在桶外，而它们仍计入面板 total
 *   （违反「图上的数字必须能在面板里对上」这条硬要求）。
 * - 空周补 0 与小时视图同一约定：缺的周直接消失会让柱状图"跳变"。
 *
 * ## 这个用例为什么存在
 *
 * 交接文档把「趋势图只有按天 / 最近 24 小时」列为未完成项。实现前先写这条用例，
 * 第一版全红（`#trendGran` 里根本没有 `week` 这个选项）。
 */
import { startStaticServer, openPage, waitFor, q, sleep } from './ui-harness.mjs';
import { accountsFixture, bridgeFixture, checkinFixture, consoleFixture, credentialsFixture, diagnoseFixture, dshFixture, quotaFixture, requestsFixture } from './fixtures.mjs';

const PORT = 8834;
const URL_ = `http://127.0.0.1:${PORT}/`;

let failures = 0;
const fail = (m) => { console.error('✗ ' + m); failures += 1; };
const pass = (m) => console.log('✓ ' + m);

/*
 * 日期一律**相对今天**构造 —— 「按周」分桶天然依赖今天是星期几，
 * 写死日期会让用例在某些工作日红、某些绿。
 */
const now = new Date();
const ymd = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const at = (y, m, d) => new Date(y, m, d);
const dow = (now.getDay() + 6) % 7;                       // 周一 = 0
const thisMonday = at(now.getFullYear(), now.getMonth(), now.getDate() - dow);
const mondayAgo = (weeks) => at(thisMonday.getFullYear(), thisMonday.getMonth(), thisMonday.getDate() - weeks * 7);
const plusDays = (d, n) => at(d.getFullYear(), d.getMonth(), d.getDate() + n);
const wk2 = ymd(mondayAgo(2));       // 两周前的周一
const wk1 = ymd(mondayAgo(1));       // 上周一（这一周故意没有数据 → 验「空周补 0」）
const wk0 = ymd(mondayAgo(0));       // 本周一
const today = ymd(now);
const d1 = ymd(plusDays(mondayAgo(2), 0));
const d2 = ymd(plusDays(mondayAgo(2), 3));

/**
 * 已知输入：两周前 2 次（分两天）、上周 0 次、本周 4 次 → 合计 6 次 / 0.6 积分。
 * 期望周桶：wk2=2、wk1=0（补的）、wk0=4。
 */
const WEEK_USAGE = {
  ok: true,
  windowDays: 84,
  total: { calls: 6, promptTokens: 600, completionTokens: 120, ms: 600, credit: 0.6, creditCalls: 6, failed: 0 },
  models: [
    { model: 'alpha', calls: 5, promptTokens: 500, completionTokens: 100, ms: 500, credit: 0.5, creditCalls: 5 },
    { model: 'beta', calls: 1, promptTokens: 100, completionTokens: 20, ms: 100, credit: 0.1, creditCalls: 1 },
  ],
  days: [
    { day: d1, calls: 1, promptTokens: 100, completionTokens: 20, credit: 0.1, creditCalls: 1, byModel: [{ model: 'alpha', calls: 1, promptTokens: 100, completionTokens: 20, credit: 0.1, creditCalls: 1 }] },
    { day: d2, calls: 1, promptTokens: 100, completionTokens: 20, credit: 0.1, creditCalls: 1, byModel: [{ model: 'beta', calls: 1, promptTokens: 100, completionTokens: 20, credit: 0.1, creditCalls: 1 }] },
    { day: today, calls: 4, promptTokens: 400, completionTokens: 80, credit: 0.4, creditCalls: 4, byModel: [{ model: 'alpha', calls: 4, promptTokens: 400, completionTokens: 80, credit: 0.4, creditCalls: 4 }] },
  ],
  failures: [],
};

/** 按天视图用的 3 天（切回按天时应恢复成 3 根柱） */
const DAY_USAGE = {
  ok: true,
  windowDays: 7,
  total: { calls: 6, promptTokens: 600, completionTokens: 120, ms: 600, credit: 0.6, creditCalls: 6, failed: 0 },
  models: WEEK_USAGE.models,
  days: WEEK_USAGE.days,
  failures: [],
};

/** 只有本周有数据 → 周桶只有 1 个 → 应给「只有 1 个时间点」的文案而不是空白 */
const SINGLE_WEEK = {
  ...WEEK_USAGE,
  total: { calls: 4, promptTokens: 400, completionTokens: 80, ms: 400, credit: 0.4, creditCalls: 4, failed: 0 },
  models: [WEEK_USAGE.models[0]],
  days: [WEEK_USAGE.days[2]],
};

const FIX = { dayUsage: DAY_USAGE, weekUsage: WEEK_USAGE, hourUsage: WEEK_USAGE };

const routes = {
  '/api/models': { body: { models: [] } },
  '/api/overview': {
    body: {
      bridge: { ...bridgeFixture(), running: true, ok: true, host: '127.0.0.1', port: 8790, endpoint: 'http://127.0.0.1:8790/v1', pid: 1, startedAt: new Date(now.getTime() - 1000).toISOString(), uptimeMs: 1000, catalogSize: 0, catalogAt: new Date(now.getTime() - 60000).toISOString() },
      credentials: { ...credentialsFixture(), active: { account: 'a', userId: 'a', remainingMs: 40 * 86400000, expiresAt: now.getTime() + 40 * 86400000 }, error: '' },
      quota: { ...quotaFixture(), total: 10, packages: [] },
      dsh: { ...dshFixture(), routeLive: true, hasBridgeKey: true, bundlesOk: true, bundles: [], registeredModels: [] },
      console: { ...consoleFixture(), version: '1.0.0', node: 'v22' },
    },
  },
  '/api/probe-results': { body: { updatedAt: null, results: {}, lastRun: null } },
  '/api/diagnose': { body: diagnoseFixture({ items: [] }) },
  '/api/requests': { body: requestsFixture({ requests: [] }) },
  '/api/accounts': { body: accountsFixture({ accounts: [] }) },
  '/api/checkin': { body: checkinFixture() },
  '/api/bridge/log': { body: { lines: [] } },
  /*
   * 函数体在页面里执行（**不能引用 Node 侧闭包**，共享状态挂 window.__FIX / __REQ）。
   * 顺手把请求 URL 记下来 —— 「按周要取 84 天」这条只能从请求上验。
   * （这段是模板字符串，注释里**不能带反引号**，会提前闭合。）
   */
  '/api/usage': {
    body: (url) => {
      window.__REQ.push(url);
      if (url.indexOf('hours=1') >= 0) return { usage: window.__FIX.hourUsage };
      if (url.indexOf('days=84') >= 0) return { usage: window.__FIX.weekUsage };
      return { usage: window.__FIX.dayUsage };
    },
  },
};

const INJECT = `(() => { window.__FIX = ${JSON.stringify(FIX)}; window.__REQ = []; })();`;

const server = await startStaticServer(PORT);
const { cdp, close } = await openPage(URL_, routes, { inject: INJECT });
const cleanup = () => { try { cdp.close(); } catch { /* 忽略 */ } try { server.close(); } catch { /* 忽略 */ } };
process.on('exit', cleanup);

const setGran = (g) => q(cdp, `(() => { const s = document.querySelector('#trendGran'); s.value = ${JSON.stringify(g)}; s.dispatchEvent(new Event('change')); return true; })()`);
const setMetric = (m) => q(cdp, `(() => { const s = document.querySelector('#trendMetric'); s.value = ${JSON.stringify(m)}; s.dispatchEvent(new Event('change')); return true; })()`);
const setKind = (k) => q(cdp, `(() => { const s = document.querySelector('#trendKind'); s.value = ${JSON.stringify(k)}; s.dispatchEvent(new Event('change')); return true; })()`);
const xLabels = () => q(cdp, `[...document.querySelectorAll('#usageBox svg.chart text')].filter(t => t.getAttribute('text-anchor') === 'middle').map(t => t.textContent)`);
const titles = () => q(cdp, `[...document.querySelectorAll('#usageBox svg.chart title')].map(t => t.textContent)`);
const aria = () => q(cdp, `(document.querySelector('#usageBox svg.chart')||{getAttribute:()=>''}).getAttribute('aria-label')`);
const resetReq = () => q(cdp, `(window.__REQ.length = 0, true)`);
const reqs = () => q(cdp, `window.__REQ.slice()`);

try {
  await waitFor(cdp, `!!document.querySelector('#usageBox svg.chart')`, 10000, '趋势图渲染');
  await sleep(300);

  // ── 1. 粒度选项存在（这条现在是红的：没有 week 选项）─────────────────
  {
    const opt = await q(cdp, `(() => { const o = document.querySelector('#trendGran option[value="week"]'); return o ? o.textContent : ''; })()`);
    if (/周/.test(opt)) pass(`粒度下拉有「按周」选项：「${opt}」`);
    else fail(`#trendGran 里没有 value="week" 的选项（当前拿到「${opt}」）`);
  }

  // ── 2. 切「按周」→ 取 84 天窗口 ──────────────────────────────────────
  {
    await resetReq();
    await setGran('week');
    await sleep(500);
    const r = await reqs();
    if (r.length === 1 && r[0].indexOf('days=84') >= 0) pass(`切「按周」发起 1 次 /api/usage 且窗口为 84 天：${r[0]}`);
    else fail(`切「按周」的请求不对：${JSON.stringify(r)}`);
  }

  // ── 3. 自然周分桶（周一起算）：3 个桶、标签为「MM-DD 周」──────────────
  {
    const labels = await xLabels();
    const want = [wk2.slice(5) + ' 周', wk1.slice(5) + ' 周', wk0.slice(5) + ' 周'];
    if (labels.length === 3 && want.every((w) => labels.indexOf(w) >= 0)) {
      pass(`按周视图 3 个桶、x 轴为周一的「MM-DD 周」：${labels.join(' / ')}`);
    } else {
      fail(`按周 x 轴异常：期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(labels)}`);
    }
  }

  // ── 4. 空周补 0 + 同周多天合并 ────────────────────────────────────────
  {
    const ts = await titles();
    const mid = ts.find((t) => t.indexOf(wk1.slice(5)) === 0);
    const first = ts.find((t) => t.indexOf(wk2.slice(5)) === 0);
    if (mid && /调用次数 0(?!\d)/.test(mid)) pass(`上周没数据 → 桶仍在且记 0：${mid}`);
    else fail(`空周补 0 失败：${JSON.stringify(ts)}`);
    if (first && /调用次数 2(?!\d)/.test(first)) pass(`同一周的两天合并成一个桶：${first}`);
    else fail(`同周合并失败：${JSON.stringify(first)}`);
  }

  // ── 5. 合计与面板一致（图上数字必须能在面板里对上）────────────────────
  {
    const a = await aria();
    if (/^最近 3 周调用次数图，合计 6 次$/.test(a)) pass(`aria 口径正确：${a}`);
    else fail(`aria 异常：「${a}」`);
    const cards = await q(cdp, `(document.querySelector('#usageBox .cards')||{}).textContent || ''`);
    if (/最近 84 天/.test(cards)) pass('面板卡片口径为 84 天窗口（与请求一致）');
    else fail(`面板卡片窗口异常：「${cards.slice(0, 60)}」`);
  }

  // ── 6. 积分指标在周视图同样对得上（周合计 == 面板 0.6）────────────────
  {
    await setMetric('credit');
    await sleep(300);
    const a = await aria();
    const cards = await q(cdp, `(document.querySelector('#usageBox .cards')||{}).textContent || ''`);
    if (/合计 0\.6/.test(a) && /0\.6/.test(cards)) pass(`周视图积分合计 0.6，与面板一致：${a}`);
    else fail(`周视图积分对不上：aria「${a}」cards「${cards.slice(0, 80)}」`);
  }

  // ── 7. 按模型堆叠在周视图可用（byModel 逐周合并）──────────────────────
  {
    await setKind('bymodel');
    await sleep(300);
    const legend = await q(cdp, `(document.querySelector('#usageBox .chart-legend')||{}).textContent || ''`);
    const rects = await q(cdp, `document.querySelectorAll('#usageBox svg.chart rect').length`);
    if (/alpha/.test(legend) && /beta/.test(legend) && rects > 0) pass(`按模型堆叠：图例含 alpha / beta（${rects} 段柱）`);
    else fail(`按模型堆叠异常：legend「${legend}」rects=${rects}`);
    await setKind('auto');
    await setMetric('calls');
    await sleep(200);
  }

  // ── 8. 切回按天：用缓存、不发新请求、恢复日桶 ─────────────────────────
  {
    await resetReq();
    await setGran('day');
    await sleep(400);
    const r = await reqs();
    const labels = await xLabels();
    if (r.length === 0) pass('切回按天不发新请求（走缓存）');
    else fail(`切回按天发了 ${r.length} 次请求：${JSON.stringify(r)}`);
    if (labels.length === 3 && labels.every((l) => /^\d{2}-\d{2}$/.test(l))) pass(`按天视图恢复（3 根柱，标签无「周」后缀）：${labels.join(' / ')}`);
    else fail(`按天视图异常：${JSON.stringify(labels)}`);
  }

  // ── 9. 单周数据 → 给文案，不是空白 ───────────────────────────────────
  {
    await q(cdp, `(window.__FIX.weekUsage = ${JSON.stringify(SINGLE_WEEK)}, true)`);
    // 先切回周视图（这时可能命中旧缓存），再主动 loadUsage 强制按新夹具取一次 ——
    // 直接把夹具塞进 window.__FIX 不会让已缓存的 usageWeekCache 失效
    await setGran('week');
    await q(cdp, `(async () => { await loadUsage(); return true; })()`);
    await sleep(400);
    const hasSvg = await q(cdp, `!!document.querySelector('#usageBox svg.chart')`);
    const text = await q(cdp, `document.querySelector('#usageBox').textContent`);
    if (!hasSvg && /只有 1 个时间点/.test(text)) pass('只有 1 个周桶 → 给文案而不是空白');
    else fail(`单桶文案异常：hasSvg=${hasSvg} text「${text.slice(0, 60)}」`);
  }

  // ── 10. 英文模式不留中文（新文案都必须进词条表）──────────────────────
  {
    await q(cdp, `document.getElementById('langToggle').click()`);
    await sleep(500);
    const opt = await q(cdp, `(document.querySelector('#trendGran option[value="week"]')||{}).textContent || ''`);
    const text = await q(cdp, `document.querySelector('#usageBox').textContent`);
    const cjk = /[\u4e00-\u9fff]/;
    if (opt === 'Weekly') pass(`英文模式下「按周」选项已翻译：「${opt}」`);
    else fail(`英文模式下「按周」应为 Weekly，实际「${opt}」`);
    // 单桶文案此刻仍在屏上（夹具没换）——它也必须翻译过
    if (/Only one data point/.test(text) && !cjk.test(text)) pass('英文模式下单桶提示已翻译且无中文残留');
    else fail(`英文模式提示异常：「${text.slice(0, 80)}」`);
    await q(cdp, `document.getElementById('langToggle').click()`); // 还原
    await sleep(300);
  }

  // ── 11. 英文模式 aria 规则（周）也兜住 ───────────────────────────────
  {
    await q(cdp, `(window.__FIX.weekUsage = ${JSON.stringify(WEEK_USAGE)}, true)`);
    await q(cdp, `(async () => { await loadUsage(); return true; })()`);
    await sleep(300);
    await q(cdp, `document.getElementById('langToggle').click()`);
    await sleep(400);
    const a = await aria();
    if (/^Last 3 weeks calls chart, 6 total$/.test(a)) pass(`英文 aria 规则覆盖「周」：${a}`);
    else fail(`英文 aria 异常：「${a}」`);
    await q(cdp, `document.getElementById('langToggle').click()`);
    await sleep(200);
  }
} catch (err) {
  fail(`异常中断：${err.message}`);
} finally {
  cleanup();
}

console.log(failures ? `\n存在 ${failures} 项失败` : '\n全部通过');
process.exit(failures ? 1 : 0);
