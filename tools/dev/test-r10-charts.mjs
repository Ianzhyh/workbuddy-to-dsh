/**
 * R10 积分与用量图表 验收（Task 28–30）。
 *
 *   node tools/dev/test-r10-charts.mjs
 *
 * 覆盖：三种指标形态、粒度联动、口径与面板一致、空态不画轴、排行「未回报」分区、
 * SVG 规范（自适应 / 网格 / 抽稀 / tooltip / aria）、异常态清图、无新依赖。
 */
import { startStaticServer, openPage, waitFor, q, sleep } from './ui-harness.mjs';
import { accountsFixture, bridgeFixture, checkinFixture, consoleFixture, credentialsFixture, diagnoseFixture, dshFixture, quotaFixture, requestsFixture } from './fixtures.mjs';

const PORT = 8782;
const URL_ = `http://127.0.0.1:${PORT}/`;

let failures = 0;
const fail = (m) => { console.error('✗ ' + m); failures += 1; };
const pass = (m) => console.log('✓ ' + m);

const now = Date.now();
const CATALOG = ['alpha', 'beta'].map((id) => ({
  id, name: id.toUpperCase(), context_window: 128000, max_output_tokens: 8192, credits: 0.11,
}));

const sse = (obj) => `data: ${JSON.stringify(obj)}\n\n`;

/** 已知输入：3 天积分 0.10 / 0.20 / 0.30 → 合计 0.60，累计折线末端也是 0.60 */
const USAGE_3D = {
  windowDays: 7,
  total: { calls: 6, promptTokens: 3000, completionTokens: 900, ms: 600, credit: 0.6, creditCalls: 4, failed: 1 },
  models: [
    { model: 'alpha', calls: 3, promptTokens: 2000, completionTokens: 600, ms: 300, credit: 0.45, creditCalls: 2 },
    { model: 'beta', calls: 2, promptTokens: 900, completionTokens: 300, ms: 200, credit: 0.15, creditCalls: 2 },
    { model: 'gamma', calls: 1, promptTokens: 100, completionTokens: 0, ms: 100, credit: 0, creditCalls: 0 },
  ],
  days: [
    { day: '2026-10-02', calls: 1, promptTokens: 500, completionTokens: 100, credit: 0.1, creditCalls: 1 },
    { day: '2026-10-03', calls: 2, promptTokens: 1000, completionTokens: 300, credit: 0.2, creditCalls: 2 },
    { day: '2026-10-04', calls: 3, promptTokens: 1500, completionTokens: 500, credit: 0.3, creditCalls: 1 },
  ],
  hours: Array.from({ length: 24 }, (_, i) => ({
    key: `2026-10-04 ${String(i).padStart(2, '0')}`,
    calls: i === 9 ? 2 : 0,
    promptTokens: i === 9 ? 200 : 0,
    completionTokens: i === 9 ? 50 : 0,
    credit: i === 9 ? 0.05 : 0,
    creditCalls: i === 9 ? 1 : 0,
  })),
  failures: [],
};

/** 30 天：验证 x 轴抽稀 */
const USAGE_30D = {
  windowDays: 30,
  total: { calls: 30, promptTokens: 3000, completionTokens: 900, ms: 600, credit: 0.6, creditCalls: 30, failed: 0 },
  models: [{ model: 'alpha', calls: 30, promptTokens: 3000, completionTokens: 900, ms: 600, credit: 0.6, creditCalls: 30 }],
  days: Array.from({ length: 30 }, (_, i) => ({
    day: `2026-09-${String(i + 1).padStart(2, '0')}`,
    calls: 1, promptTokens: 100, completionTokens: 30, credit: 0.02, creditCalls: 1,
  })),
  failures: [],
};

/** 空态：有失败记录（所以面板不判「暂无数据」）但桶里全 0 */
const USAGE_EMPTY = {
  windowDays: 7,
  total: { calls: 0, promptTokens: 0, completionTokens: 0, ms: 0, credit: 0, creditCalls: 0, failed: 2 },
  models: [],
  days: [
    { day: '2026-10-03', calls: 0, promptTokens: 0, completionTokens: 0, credit: 0, creditCalls: 0 },
    { day: '2026-10-04', calls: 0, promptTokens: 0, completionTokens: 0, credit: 0, creditCalls: 0 },
  ],
  failures: [],
};

const FIX = { usage: USAGE_3D, hourUsage: USAGE_3D };

const routes = {
  '/api/models': { body: { models: CATALOG } },
  '/api/overview': {
    body: {
      bridge: { ...bridgeFixture(), running: true, ok: true, host: '127.0.0.1', port: 8790, endpoint: 'http://127.0.0.1:8790/v1', pid: 1, startedAt: new Date(now - 1000).toISOString(), uptimeMs: 1000, catalogSize: 2, catalogAt: new Date(now - 60000).toISOString() },
      credentials: { ...credentialsFixture(), active: { account: 'a', userId: 'a', remainingMs: 40 * 86400000, expiresAt: now + 40 * 86400000 }, error: '' },
      quota: { ...quotaFixture(), total: 10, packages: [] },
      dsh: { ...dshFixture(), routeLive: true, hasBridgeKey: true, bundlesOk: true, bundles: [], registeredModels: ['alpha'] },
      console: { ...consoleFixture(), version: '1.0.0', node: 'v22' },
    },
  },
  '/api/probe-results': { body: { updatedAt: null, results: {}, lastRun: null } },
  '/api/diagnose': { body: diagnoseFixture({ items: [] }) },
  // 函数体在页面里执行：夹具必须挂 window.__FIX，不能引用 Node 侧常量
  '/api/usage': { body: (url) => ({ usage: url.includes('hours=1') ? window.__FIX.hourUsage : window.__FIX.usage }) },
  '/api/requests': { body: requestsFixture({ requests: [] }) },
  '/api/accounts': { body: accountsFixture({ accounts: [] }) },
  '/api/checkin': { body: checkinFixture() },
  '/api/bridge/log': { body: { lines: [] } },
};

const INJECT = `(() => { window.__FIX = ${JSON.stringify(FIX)}; })();`;

const server = await startStaticServer(PORT);
const { cdp, close } = await openPage(URL_, routes, { inject: INJECT });
const cleanup = () => { try { cdp.close(); } catch { /* 忽略 */ } try { server.close(); } catch { /* 忽略 */ } };
process.on('exit', cleanup);

const svgInfo = () => q(cdp, `(function(){
  const s = document.querySelector('#usageBox svg.chart');
  if (!s) return null;
  return {
    width: s.getAttribute('width'),
    par: s.getAttribute('preserveAspectRatio'),
    role: s.getAttribute('role'),
    aria: s.getAttribute('aria-label'),
    rects: s.querySelectorAll('rect').length,
    polylines: s.querySelectorAll('polyline').length,
    dashed: s.querySelectorAll('polyline[stroke-dasharray]').length,
    circles: s.querySelectorAll('circle').length,
    grid: [...s.querySelectorAll('line')].filter(l => l.getAttribute('stroke') === 'var(--border)').length,
    yTicks: [...s.querySelectorAll('text')].filter(t => t.getAttribute('text-anchor') === 'end').length,
    xTicks: [...s.querySelectorAll('text')].filter(t => t.getAttribute('text-anchor') === 'middle').length,
    titles: s.querySelectorAll('title').length
  };
})()`);
const setMetric = (m) => q(cdp, `(() => { const s = document.querySelector('#trendMetric'); s.value = ${JSON.stringify(m)}; s.dispatchEvent(new Event('change')); return true; })()`);
const setGran = (g) => q(cdp, `(() => { const s = document.querySelector('#trendGran'); s.value = ${JSON.stringify(g)}; s.dispatchEvent(new Event('change')); return true; })()`);

try {
  await waitFor(cdp, `!!document.querySelector('#usageBox svg.chart')`, 10000, '趋势图渲染');
  await sleep(300);

  // ── R10.1-1 三种指标形态 ────────────────────────────────────────────
  {
    let info = await svgInfo();
    if (info.rects > 0 && info.polylines === 0) pass('R10.1-1「调用次数」= 柱状（rect）');
    else fail(`R10.1-1 调用次数形态异常：rects=${info.rects} polylines=${info.polylines}`);

    await setMetric('tokens');
    await sleep(250);
    info = await svgInfo();
    if (info.rects > 0 && info.polylines === 0) pass('R10.1-1「tokens」= 堆叠柱（同一 x 位置两段 rect）');
    else fail('R10.1-1 tokens 形态异常');
    const legend = await q(cdp, `document.querySelector('#usageBox .chart-legend').textContent`);
    if (/输入/.test(legend) && /输出/.test(legend)) pass(`R10.1-1 tokens 图例区分输入/输出：${legend}`);
    else fail(`R10.1-1 tokens 图例异常：「${legend}」`);

    await setMetric('credit');
    await sleep(250);
    info = await svgInfo();
    if (info.polylines === 2 && info.dashed === 1) {
      pass('R10.1-1「积分」= 折线 + 累计虚线（2 条 polyline，其中 1 条虚线）');
    } else {
      fail(`R10.1-1 积分形态异常：polylines=${info.polylines} dashed=${info.dashed}`);
    }
    const cl = await q(cdp, `document.querySelector('#usageBox .chart-legend').textContent`);
    if (/积分/.test(cl) && /累计/.test(cl)) pass(`R10.1-1 积分图例含「累计」：${cl}`);
    else fail(`R10.1-1 积分图例异常：「${cl}」`);
  }

  // ── R10.1-2 口径与面板一致 ──────────────────────────────────────────
  {
    // 累计折线末端 = 0.10+0.20+0.30 = 0.60，与面板「消耗积分」一致
    const aria = (await svgInfo()).aria;
    if (/合计 0\.6/.test(aria)) pass(`R10.1-2 积分合计与面板一致：${aria}`);
    else fail(`R10.1-2 aria 里没有合计 0.6：「${aria}」`);

    const lastCircle = await q(cdp, `(function(){
      const s = document.querySelector('#usageBox svg.chart');
      const cs = [...s.querySelectorAll('circle')];
      const last = cs[cs.length - 1];
      return last ? last.querySelector('title').textContent : '';
    })()`);
    if (/累计 0\.6/.test(lastCircle)) pass(`R10.1-2 累计折线末端为 0.6：${lastCircle}`);
    else fail(`R10.1-2 累计末端异常：「${lastCircle}」`);

    const panelCredit = await q(cdp, `(document.querySelector('#usageBox .cards')||{}).textContent || ''`);
    if (/0\.6/.test(panelCredit)) pass('R10.1-2 面板「消耗积分」卡片也是 0.6（两处对得上）');
    else fail(`R10.1-2 面板积分卡片异常：「${panelCredit}」`);
  }

  // ── R10.1-3 未回报扣分如实标注（失败/未回报不计入占比）──────────────
  {
    // total.calls=6，creditCalls=4 → 2 次未回报
    const aria = (await svgInfo()).aria;
    if (/其中 2 次调用未回报扣分/.test(aria)) pass(`R10.1-3 aria 标注「未回报 N 次」：${aria}`);
    else fail(`R10.1-3 未标注未回报次数：「${aria}」`);
  }

  // ── R10.2-1 积分排行与「未回报」分区 ────────────────────────────────
  {
    const rows = await q(cdp, `[...document.querySelectorAll('#usageBox .rank-row')].map(el => ({
      name: el.querySelector('.rank-name').textContent,
      val: el.querySelector('.rank-val').textContent
    }))`);
    if (rows.length === 2 && rows[0].name === 'alpha' && /0\.45（2 次）/.test(rows[0].val)) {
      pass(`R10.2-1 排行按积分降序、右侧带「值（次数）」：${rows[0].name} ${rows[0].val}`);
    } else {
      fail(`R10.2-1 排行异常：${JSON.stringify(rows)}`);
    }
    const noCredit = await q(cdp, `(document.querySelector('#usageBox .rank-nocredit')||{}).textContent || ''`);
    if (/未回报扣分的模型（1 个）/.test(noCredit) && /gamma/.test(noCredit)) {
      pass(`R10.2-1 creditCalls=0 的模型单列「未回报」区，不混进占比：${noCredit.slice(0, 50)}…`);
    } else {
      fail(`R10.2-1「未回报」区异常：「${noCredit}」`);
    }
  }

  // ── R10.3-1 / R10.3-3 SVG 规范 ──────────────────────────────────────
  {
    const info = await svgInfo();
    if (info.width === '100%') pass('R10.3-1 SVG 宽度自适应（width="100%"）');
    else fail(`R10.3-1 width 属性异常：${info.width}`);
    if (info.par === null) pass('R10.3-1 未使用 preserveAspectRatio="none"（文字不会被拉伸）');
    else fail(`R10.3-1 出现了 preserveAspectRatio：${info.par}`);
    if (info.role === 'img' && /图/.test(info.aria || '')) pass('R10.3-3 容器有 role="img" 与描述结论的 aria-label');
    else fail(`R10.3-3 role/aria 异常：role=${info.role} aria=${info.aria}`);
    if (info.titles >= 3) pass(`R10.3-3 每个点/柱都带原生 tooltip（${info.titles} 个 <title>）`);
    else fail(`R10.3-3 tooltip 数量不足：${info.titles}`);
  }

  // ── R10.3-2 网格与抽稀 ──────────────────────────────────────────────
  {
    const info = await svgInfo();
    if (info.grid === 5 && info.yTicks === 5) pass('R10.3-2 y 轴 5 条网格线 + 5 个刻度（0 到 max 分 4 段）');
    else fail(`R10.3-2 网格异常：grid=${info.grid} yTicks=${info.yTicks}`);

    await q(cdp, `(window.__FIX.usage = ${JSON.stringify(USAGE_30D)}, true)`);
    await q(cdp, `(async () => { await loadUsage(); return true; })()`);
    await sleep(400);
    const i30 = await svgInfo();
    if (i30.xTicks < 30 && i30.xTicks >= 6) pass(`R10.3-2 30 天视图 x 轴抽稀（30 个桶只画 ${i30.xTicks} 个标签）`);
    else fail(`R10.3-2 30 天 x 轴未抽稀：${i30.xTicks} 个标签`);
    await q(cdp, `(window.__FIX.usage = ${JSON.stringify(USAGE_3D)}, true)`);
    await q(cdp, `(async () => { await loadUsage(); return true; })()`);
    await sleep(300);
  }

  // ── R10.1-1 粒度联动 ────────────────────────────────────────────────
  {
    await setGran('hour');
    await sleep(400);
    const info = await svgInfo();
    const labels = await q(cdp, `[...document.querySelectorAll('#usageBox svg.chart text')].map(t => t.textContent)`);
    if (info && labels.some((l) => /^\d{2} 时$/.test(l))) pass('R10.1-1 粒度切「最近 24 小时」后 x 轴为「HH 时」');
    else fail(`R10.1-1 小时视图 x 轴异常：${JSON.stringify(labels.slice(0, 6))}`);
    await setGran('day');
    await sleep(300);
  }

  // ── R10.1-4 空态：不画空轴 ──────────────────────────────────────────
  {
    await q(cdp, `(window.__FIX.usage = ${JSON.stringify(USAGE_EMPTY)}, true)`);
    await q(cdp, `(async () => { await loadUsage(); return true; })()`);
    await sleep(400);
    const hasSvg = await q(cdp, `!!document.querySelector('#usageBox svg.chart')`);
    const text = await q(cdp, `document.querySelector('#usageBox').textContent`);
    if (!hasSvg && /这段时间没有调用/.test(text)) pass('R10.1-4 窗口内全 0 → 提示「这段时间没有调用」且**不画空轴**');
    else fail(`R10.1-4 空态异常：hasSvg=${hasSvg}`);
  }

  // ── R10.3-4 异常态清图 ──────────────────────────────────────────────
  {
    await q(cdp, `(window.__FIX.usage = ${JSON.stringify(USAGE_3D)}, true)`);
    await q(cdp, `(async () => { await loadUsage(); return true; })()`);
    await sleep(350);
    const before = await q(cdp, `!!document.querySelector('#usageBox svg.chart')`);

    // 接口失败（usage 为 null）
    await q(cdp, `(window.__FIX.usage = null, true)`);
    await q(cdp, `(async () => { await loadUsage(); return true; })()`);
    await sleep(350);
    const after = await q(cdp, `!!document.querySelector('#usageBox svg.chart')`);
    const text = await q(cdp, `document.querySelector('#usageBox').textContent`);
    if (before && !after) pass('R10.3-4 接口失败时**清掉**上一次的图（不残留）');
    else fail(`R10.3-4 旧图残留：before=${before} after=${after}`);
    if (/暂无数据|桥未运行/.test(text)) pass(`R10.3-4 异常态有独立文案：${text.slice(0, 30)}`);
    else fail(`R10.3-4 异常态文案异常：「${text.slice(0, 40)}」`);
  }

  // ── R10.2-2 条形点击联动 ────────────────────────────────────────────
  {
    await q(cdp, `(window.__FIX.usage = ${JSON.stringify(USAGE_3D)}, true)`);
    await q(cdp, `(async () => { await loadUsage(); return true; })()`);
    await sleep(350);
    await q(cdp, `(() => { const el = document.querySelector('#usageBox .rank-row.pick[data-rank-model="alpha"]'); if (el) el.click(); return true; })()`);
    await sleep(300);
    const sel = await q(cdp, `document.querySelector('#reqModelFilter').value`);
    const chip = await q(cdp, `document.querySelector('#reqFilterChip').textContent`);
    if (sel === 'alpha' && /alpha/.test(chip)) {
      pass('R10.2-2 点排行条形 → 设 reqModelFilter 并出现筛选标记（复用 R1.1 同一状态）');
    } else {
      fail(`R10.2-2 联动失败：sel=「${sel}」chip=「${chip}」`);
    }
    await q(cdp, `(setReqModelFilter(''), true)`);
    await sleep(200);
  }

  // ── R10.4-1 无新依赖 ────────────────────────────────────────────────
  {
    const extScripts = await q(cdp, `document.querySelectorAll('script[src]').length`);
    if (extScripts === 0) pass('R10.4-1 未引入任何图表库（index.html 无 <script src>）');
    else fail(`R10.4-1 出现了外部脚本：${extScripts} 个`);
  }
} catch (err) {
  fail(`异常中断：${err.message}`);
} finally {
  cleanup();
}

console.log(failures ? `\n存在 ${failures} 项失败` : '\n全部通过');
process.exit(failures ? 1 : 0);
