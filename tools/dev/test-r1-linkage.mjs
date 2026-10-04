/**
 * R1 排障联动 + R2.1 实测成本列 验收（Task 8–11）。
 *
 *   node tools/dev/test-r1-linkage.mjs
 *
 * 全程 fetch 打桩；剪贴板用 navigator.clipboard.writeText 打桩捕获。
 */
import { startStaticServer, openPage, waitFor, click, q, sleep } from './ui-harness.mjs';

const PORT = 8795;
const URL_ = `http://127.0.0.1:${PORT}/`;

let failures = 0;
const fail = (m) => { console.error('✗ ' + m); failures += 1; };
const pass = (m) => console.log('✓ ' + m);

const now = Date.now();
const CATALOG = ['alpha', 'beta', 'gamma', 'delta'].map((id) => ({
  id, name: id.toUpperCase(), context_window: 128000, max_output_tokens: 8192, credits: 0.11,
}));

// alpha: 3 次成功 / 2000 tokens / 扣分 0.24 → 0.12 每千 token
// beta : 成功但没有回报扣分（creditCalls=0）→ 「—」
// gamma: 免费且回报 0 → 显示 0
const DAY_USAGE = {
  windowDays: 7,
  total: { calls: 6, promptTokens: 5000, completionTokens: 1000, ms: 900, credit: 0.24, creditCalls: 3, failed: 1 },
  models: [
    { model: 'alpha', calls: 3, promptTokens: 1500, completionTokens: 500, ms: 300, credit: 0.24, creditCalls: 3 },
    { model: 'beta', calls: 2, promptTokens: 1000, completionTokens: 400, ms: 200, credit: 0, creditCalls: 0 },
    { model: 'gamma', calls: 1, promptTokens: 100, completionTokens: 100, ms: 100, credit: 0, creditCalls: 1 },
  ],
  days: [
    { day: '2026-09-30', calls: 1, promptTokens: 10, completionTokens: 5, credit: 0.01, creditCalls: 1 },
    { day: '2026-10-01', calls: 2, promptTokens: 20, completionTokens: 10, credit: 0.02, creditCalls: 2 },
    { day: '2026-10-02', calls: 3, promptTokens: 30, completionTokens: 15, credit: 0.03, creditCalls: 3 },
  ],
  failures: [],
};

const HOUR_USAGE = {
  windowDays: 1,
  total: { calls: 2, promptTokens: 100, completionTokens: 50, ms: 100, credit: 0.05, creditCalls: 1, failed: 0 },
  models: [{ model: 'alpha', calls: 2, promptTokens: 100, completionTokens: 50, ms: 100, credit: 0.05, creditCalls: 1 }],
  days: [{ day: '2026-10-04', calls: 2, promptTokens: 100, completionTokens: 50, credit: 0.05, creditCalls: 1 }],
  hours: Array.from({ length: 24 }, (_, i) => ({
    key: `2026-10-04 ${String(i).padStart(2, '0')}`,
    calls: i === 9 ? 2 : 0,
    promptTokens: i === 9 ? 100 : 0,
    completionTokens: i === 9 ? 50 : 0,
    credit: i === 9 ? 0.05 : 0,
    creditCalls: i === 9 ? 1 : 0,
  })),
  failures: [],
};

const REQUESTS = [
  { t: now - 5000, model: 'alpha', stream: false, ok: true, ms: 100, promptTokens: 10, completionTokens: 5, credit: 0.01 },
  { t: now - 4000, model: 'beta', stream: true, ok: true, ms: 120, promptTokens: 20, completionTokens: 8, credit: 0.02 },
  { t: now - 3000, model: 'alpha', stream: false, ok: false, ms: 900, status: 400, code: 'invalid_request', error: '<img onerror=alert(1)>bad model' },
  { t: now - 2000, model: 'beta', stream: false, ok: true, ms: 110, promptTokens: 15, completionTokens: 6, credit: 0.01 },
];

const routes = {
  '/api/models': { body: { models: CATALOG } },
  '/api/overview': {
    body: {
      bridge: { running: true, ok: true, host: '127.0.0.1', port: 8790, endpoint: 'http://127.0.0.1:8790/v1', pid: 1, startedAt: new Date(now - 1000).toISOString(), uptimeMs: 1000, catalogSize: 4, catalogAt: new Date(now - 60000).toISOString() },
      credentials: { active: null, error: '' },
      quota: { total: 10, packages: [] },
      dsh: { routeLive: true, hasBridgeKey: true, bundlesOk: true, bundles: [], registeredModels: ['alpha'] },
      console: { version: '1.0.0', node: 'v22' },
    },
  },
  '/api/probe-results': { body: { updatedAt: null, results: {}, lastRun: null } },
  '/api/diagnose': { body: { items: [] } },
  // 同一路径按查询串分流。注意：函数体是在**页面里**执行的，闭包变量不存在，
  // 所以数据必须挂在 window.__FIX 上（由 INJECT 注入）
  '/api/usage': { body: (url) => ({ usage: url.includes('hours=1') ? window.__FIX.hourUsage : window.__FIX.dayUsage }) },
  '/api/requests': { body: { requests: REQUESTS } },
  '/api/accounts': { body: { accounts: [] } },
  '/api/checkin': { body: { status: null } },
  '/api/bridge/log': { body: { lines: [] } },
};

const INJECT = `(() => {
  window.__clip = null;
  window.__FIX = ${JSON.stringify({ dayUsage: DAY_USAGE, hourUsage: HOUR_USAGE })};
  try {
    if (!navigator.clipboard) Object.defineProperty(navigator, 'clipboard', { value: {}, configurable: true });
    navigator.clipboard.writeText = (t) => { window.__clip = t; return Promise.resolve(); };
  } catch (e) { /* 兜底：copyText 会走 textarea 分支 */ }
})();`;

const server = await startStaticServer(PORT);
const { cdp, close } = await openPage(URL_, routes, { inject: INJECT });
const cleanup = () => { try { cdp.close(); } catch { /* 忽略 */ } try { server.close(); } catch { /* 忽略 */ } };
process.on('exit', cleanup);

const txt = (sel) => q(cdp, `(document.querySelector(${JSON.stringify(sel)})||{}).textContent || ''`);
const reqPaths = () => q(cdp, `window.__calls.filter(p => p === '/api/requests').length`);
const usagePaths = () => q(cdp, `window.__calls.filter(p => p === '/api/usage').length`);
const resetCalls = () => q(cdp, `(window.__calls = [], true)`);
const reqRows = () => q(cdp, `[...document.querySelectorAll('#reqBox tbody tr')].length`);
const reqModels = () => q(cdp, `[...document.querySelectorAll('#reqBox tbody tr')].map(tr => tr.children[1].textContent)`);

try {
  await waitFor(cdp, `!!document.querySelector('#usageBox tr.pickrow')`, 10000, '用量表渲染');
  await waitFor(cdp, `document.querySelectorAll('#reqBox tbody tr').length === 4`, 10000, '请求明细渲染');

  // ── R2.1 实测成本列 ────────────────────────────────────────────────
  {
    const alpha = await q(cdp, `(document.querySelector('#modelTable td[data-cost="alpha"]')||{}).textContent || ''`);
    const beta = await q(cdp, `(document.querySelector('#modelTable td[data-cost="beta"]')||{}).textContent || ''`);
    const betaTitle = await q(cdp, `(document.querySelector('#modelTable td[data-cost="beta"]')||{}).title || ''`);
    const gamma = await q(cdp, `(document.querySelector('#modelTable td[data-cost="gamma"]')||{}).textContent || ''`);
    const headerTitle = await q(cdp, `(document.querySelector('#modelTable th[title*="扣分合计"]')||{}).title || ''`);

    if (alpha === '0.12 / 千 token（3 次）') pass(`R2.1-1 实测成本列正确：${alpha}`);
    else fail(`R2.1-1 期望「0.12 / 千 token（3 次）」，实际「${alpha}」`);

    if (beta === '—' && /上游一次都没回报扣分/.test(betaTitle)) {
      pass('R2.1-3 creditCalls=0 → 「—」+ 原因 tooltip（不用目录倍率顶替）');
    } else {
      fail(`R2.1-3 beta 应为「—」+ 原因，实际「${beta}」/「${betaTitle}」`);
    }

    if (/^0 \/ 千 token（1 次）$/.test(gamma)) pass('R2.1-4 免费且回报 0 → 显示 0（不是「—」）');
    else fail(`R2.1-4 gamma 应显示 0，实际「${gamma}」`);

    if (/只含成功且回报了扣分的调用/.test(headerTitle)) pass('R2.1-5 表头 tooltip 写清口径');
    else fail(`R2.1-5 表头 tooltip 未写口径：「${headerTitle}」`);
  }

  // ── R1.1-1 用量表行 → 明细联动 ──────────────────────────────────────
  {
    await resetCalls();
    await q(cdp, `(() => { document.querySelector('#usageBox tr.pickrow[data-model="alpha"]').click(); return true; })()`);
    await sleep(200);

    const models = await reqModels();
    const chip = await txt('#reqFilterChip');
    const selVal = await q(cdp, `document.querySelector('#reqModelFilter').value`);
    const active = await q(cdp, `!!document.querySelector('#usageBox tr.pickrow[data-model="alpha"].rowactive')`);
    const reqs = await reqPaths();

    if (models.length === 2 && models.every((m) => m === 'alpha')) pass('R1.1-1 点用量表 alpha 行 → 明细只剩 alpha（2 条）');
    else fail(`R1.1-1 明细应为 2 条 alpha，实际 ${JSON.stringify(models)}`);
    if (/已筛选：/.test(chip) && /alpha/.test(chip)) pass(`R1.1-1 出现「已筛选：X ×」标记：${chip.replace(/\s+/g, ' ')}`);
    else fail(`R1.1-1 缺少筛选标记：「${chip}」`);
    if (selVal === 'alpha') pass('R1.1-2 下拉与行点击共用同一状态（下拉已同步为 alpha）');
    else fail(`R1.1-2 下拉未同步，实际「${selVal}」`);
    if (active) pass('R1.1-2 用量表对应行带 .rowactive 选中态');
    else fail('R1.1-2 用量表行未标记选中态');
    if (reqs === 0) pass('R1.2-2 联动只重绘，未产生新的 /api/requests 请求');
    else fail(`R1.2-2 联动产生了 ${reqs} 次新请求`);
  }

  // ── R1.1-2 再点同一行 = 取消 ────────────────────────────────────────
  {
    await q(cdp, `(() => { document.querySelector('#usageBox tr.pickrow[data-model="alpha"]').click(); return true; })()`);
    await sleep(180);
    const rows = await reqRows();
    const chip = await txt('#reqFilterChip');
    const active = await q(cdp, `!!document.querySelector('#usageBox tr.pickrow.rowactive')`);
    if (rows === 4 && !chip.trim() && !active) pass('R1.1-2 再点同一行 → 取消筛选，恢复全部 4 条');
    else fail(`R1.1-2 取消失败：rows=${rows} chip=「${chip}」active=${active}`);
  }

  // ── R1.2-1 三条件叠加 ───────────────────────────────────────────────
  {
    await q(cdp, `(() => { const s = document.querySelector('#reqModelFilter'); s.value = 'alpha'; s.dispatchEvent(new Event('change')); return true; })()`);
    await sleep(150);
    let rows = await reqRows();
    if (rows === 2) pass('R1.2-1 下拉筛选 alpha → 2 条');
    else fail(`R1.2-1 下拉筛选 alpha 应为 2 条，实际 ${rows}`);

    await q(cdp, `(() => { const c = document.querySelector('#reqFailOnly'); c.checked = true; c.dispatchEvent(new Event('change')); return true; })()`);
    await sleep(150);
    rows = await reqRows();
    if (rows === 1) pass('R1.2-1 叠加「仅看失败」→ 1 条（alpha 的失败）');
    else fail(`R1.2-1 叠加失败筛选应为 1 条，实际 ${rows}`);
  }

  // ── R1.3-1 / R1.3-2 失败行复制 ──────────────────────────────────────
  {
    await q(cdp, `(window.__clip = null, true)`);
    await click(cdp, '#reqBox button.copyfail');
    await sleep(200);
    const clip = await q(cdp, `window.__clip || ''`);
    if (/^HTTP 400 · invalid_request · alpha\n/.test(clip) && /bad model/.test(clip)) {
      pass(`R1.3-1 复制内容含「状态码 · 错误码 · 模型」+ 错误原文`);
    } else {
      fail(`R1.3-1 剪贴板内容不符：「${clip}」`);
    }
    if (!/&lt;|&amp;/.test(clip)) pass('R1.3-1 剪贴板是纯文本（未被 HTML 转义）');
    else fail(`R1.3-1 剪贴板被转义了：「${clip}」`);

    // 成功行不给复制入口
    await q(cdp, `(() => { const c = document.querySelector('#reqFailOnly'); c.checked = false; c.dispatchEvent(new Event('change')); return true; })()`);
    await q(cdp, `(() => { const s = document.querySelector('#reqModelFilter'); s.value = ''; s.dispatchEvent(new Event('change')); return true; })()`);
    await sleep(180);
    const okRows = await q(cdp, `[...document.querySelectorAll('#reqBox tbody tr')].filter(tr => /成功/.test(tr.textContent)).length`);
    const copyBtns = await q(cdp, `document.querySelectorAll('#reqBox button.copyfail').length`);
    if (okRows === 3 && copyBtns === 1) pass('R1.3-2 只有失败行有复制入口（3 条成功行无按钮）');
    else fail(`R1.3-2 成功行数 ${okRows} / 复制按钮数 ${copyBtns}（期望 3 / 1）`);
  }

  // ── R1.1-3 明细里没有该模型 ─────────────────────────────────────────
  {
    await q(cdp, `(() => { const s = document.querySelector('#reqModelFilter'); s.value = 'delta'; s.dispatchEvent(new Event('change')); return true; })()`);
    await sleep(150);
    // delta 不在明细里 → 选项里也没有，先手工塞一个再触发
    await q(cdp, `(() => {
      const s = document.querySelector('#reqModelFilter');
      if (!s.querySelector('option[value="delta"]')) { const o = document.createElement('option'); o.value = 'delta'; o.textContent = 'delta'; s.appendChild(o); }
      s.value = 'delta'; s.dispatchEvent(new Event('change'));
      return true;
    })()`);
    await sleep(180);
    const box = await txt('#reqBox');
    if (/最近 4 条里没有 delta 的记录，可把条数调大到 200/.test(box)) {
      pass('R1.1-3 明细里没有该模型时给出「最近 N 条里没有 X，可调大到 200」的提示');
    } else {
      fail(`R1.1-3 提示文案不符：「${box.slice(0, 140)}」`);
    }
  }

  // ── R1.2-3 选中模型从明细里消失 → 回落 + 提示 ───────────────────────
  {
    // 明细换成**不含 alpha** 的一批
    await q(cdp, `window.__setRoute('/api/requests', { body: { requests: ${JSON.stringify(REQUESTS.filter((r) => r.model !== 'alpha'))} } })`);
    await q(cdp, `(() => { const s = document.querySelector('#reqModelFilter'); s.value = 'alpha'; s.dispatchEvent(new Event('change')); return true; })()`);
    await sleep(150);
    await click(cdp, '#reqRefreshBtn');
    await sleep(300);
    const selVal = await q(cdp, `document.querySelector('#reqModelFilter').value`);
    const chip = await txt('#reqFilterChip');
    if (selVal === '' && /已不在最近明细里/.test(chip)) {
      pass('R1.2-3 选中模型消失 → 回落「全部模型」并提示一次');
    } else {
      fail(`R1.2-3 回落失败：sel=「${selVal}」chip=「${chip}」`);
    }
  }

  // ── R1.4-1 / R1.4-3 趋势粒度 ────────────────────────────────────────
  {
    await resetCalls();
    await q(cdp, `(() => { const s = document.querySelector('#trendGran'); s.value = 'hour'; s.dispatchEvent(new Event('change')); return true; })()`);
    await sleep(400);
    const usageReqs = await usagePaths();
    // 趋势图在 R10 里换成了内联 SVG：每根柱 = 一个带 <title> 的命中组
    const bars = await q(cdp, `document.querySelectorAll('#usageBox svg.chart title').length`);
    const firstLabel = await q(cdp, `(document.querySelector('#usageBox svg.chart text[text-anchor="middle"]')||{}).textContent || ''`);
    if (usageReqs === 1) pass('R1.4-1 切「最近 24 小时」发起 1 次 /api/usage');
    else fail(`R1.4-1 切小时视图应请求 1 次，实际 ${usageReqs}`);
    if (bars === 24) pass('R1.4-1 小时视图渲染 24 根柱（空桶补 0）');
    else fail(`R1.4-1 小时视图应有 24 根柱，实际 ${bars}`);
    if (/^\d{2} 时$/.test(firstLabel)) pass(`R1.4-1 x 轴为「HH 时」：${firstLabel}`);
    else fail(`R1.4-1 x 轴标签不符：「${firstLabel}」`);

    await resetCalls();
    await q(cdp, `(() => { const s = document.querySelector('#trendGran'); s.value = 'day'; s.dispatchEvent(new Event('change')); return true; })()`);
    await sleep(300);
    const after = await usagePaths();
    const dayBars = await q(cdp, `document.querySelectorAll('#usageBox svg.chart title').length`);
    const dayLabel = await q(cdp, `(document.querySelector('#usageBox svg.chart text[text-anchor="middle"]')||{}).textContent || ''`);
    if (after === 0) pass('R1.4-3 切回按天用缓存，**不发新请求**');
    else fail(`R1.4-3 切回按天发了 ${after} 次请求`);
    if (dayBars === 3 && /^\d{2}-\d{2}$/.test(dayLabel)) pass(`R1.4-3 按天视图恢复（3 根柱，x 轴 ${dayLabel}）`);
    else fail(`R1.4-3 按天视图异常：bars=${dayBars} label=「${dayLabel}」`);
  }

  // ── R2.1-2 窗口天数变化 → 成本重算 ──────────────────────────────────
  {
    await q(cdp, `(window.__FIX.dayUsage = ${JSON.stringify({
      windowDays: 30,
      total: { calls: 3, promptTokens: 3000, completionTokens: 0, ms: 300, credit: 0.9, creditCalls: 3, failed: 0 },
      models: [{ model: 'alpha', calls: 3, promptTokens: 3000, completionTokens: 0, ms: 300, credit: 0.9, creditCalls: 3 }],
      days: [{ day: '2026-10-04', calls: 3, promptTokens: 3000, completionTokens: 0, credit: 0.9, creditCalls: 3 }],
      failures: [],
    })}, true)`);
    await q(cdp, `(() => { const s = document.querySelector('#usageDays'); s.value = '30'; s.dispatchEvent(new Event('change')); return true; })()`);
    await sleep(400);
    const alpha = await q(cdp, `(document.querySelector('#modelTable td[data-cost="alpha"]')||{}).textContent || ''`);
    const beta = await q(cdp, `(document.querySelector('#modelTable td[data-cost="beta"]')||{}).textContent || ''`);
    if (/^0\.3 \/ 千 token（3 次）$/.test(alpha)) pass(`R2.1-2 换 30 天窗口后成本重算：${alpha}`);
    else fail(`R2.1-2 换窗口后 alpha 应为「0.3 / 千 token（3 次）」，实际「${alpha}」`);
    if (beta === '—') pass('R2.1-2 新窗口下没有调用的模型回落「—」（无旧值残留）');
    else fail(`R2.1-2 beta 应为「—」，实际「${beta}」`);
  }
} catch (err) {
  fail(`异常中断：${err.message}`);
} finally {
  cleanup();
}

console.log(failures ? `\n存在 ${failures} 项失败` : '\n全部通过');
process.exit(failures ? 1 : 0);
