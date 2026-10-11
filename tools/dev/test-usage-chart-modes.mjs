/**
 * 用量面板的两个新控件：趋势图**形态切换** + 积分排行的**按模型配色**。
 *
 *   node tools/dev/test-usage-chart-modes.mjs
 *
 * ## 为什么要测
 *
 * 这两处都是「看着像那么回事、但错了也不报错」的地方：
 *
 * 1. **形态切换**：`#trendKind` 选了折线，图上却还是柱子 —— 页面不会报错，
 *    只是白点一下。而且三种指标 × 三种形态有 9 种组合，人眼不可能逐个点。
 * 2. **配色**：第一版用**哈希取色**，实测 3 个模型里就有 2 个撞成同一个颜色
 *    （`glm-5.3` 与 `deepseek-v4.1-flash`），而"不同模型不同颜色"正是这个功能的
 *    全部意义。撞色在页面上完全看不出来是 bug。
 *
 * ## 判据
 *
 * - 形态：数 SVG 里的 `rect[fill^="url("]`（柱）与 `polyline`（线）。
 * - 特别盯 **`credit` + 柱状**：应当是「柱子 + 累计虚线」的混合形态 ——
 *   累计值画成柱子会被读成"当天消耗"，这是**语义差异**不是画法偏好。
 * - 配色：排行各行 `.rank-fill` 的实际渲染色**两两不同**；
 *   且「其它（N 个）」是聚合行，必须是中性色、不参与配色。
 */
import { startStaticServer, openPage, waitFor, q, sleep } from './ui-harness.mjs';
import { baseRoutes, usageFixture } from './fixtures.mjs';

let failures = 0;
const pass = (m) => console.log('✓ ' + m);
const fail = (m) => { console.error('✗ ' + m); failures += 1; };

const PORT = 8830;
const URL_ = `http://127.0.0.1:${PORT}/`;

/*
 * 纯数据断言：桩里每天的 `byModel` 加起来必须等于当天合计。
 *
 * 为什么值得单独钉一条：图上一根柱子的各段之和**就是**那天的高度，而面板上还有
 * 一个"当天合计"。两者对不上，就等于"图上的数字在面板里对不上" —— 这个项目的
 * 硬要求是**图上每个数字都能在面板里找到**。夹具手写，很容易改了一边忘了另一边。
 */
{
  const days = usageFixture().usage.days;
  let bad = 0;
  for (const d of days) {
    const sum = (k) => (d.byModel || []).reduce((n, m) => n + (Number(m[k]) || 0), 0);
    const r4 = (n) => Math.round(n * 10000) / 10000;
    const checks = [['calls', d.calls, sum('calls')], ['credit', d.credit, r4(sum('credit'))],
      ['promptTokens', d.promptTokens, sum('promptTokens')], ['completionTokens', d.completionTokens, sum('completionTokens')],
      ['creditCalls', d.creditCalls, sum('creditCalls')]];
    for (const [k, want, got] of checks) {
      if (want !== got) { bad++; fail(`桩数据 ${d.day} 的 byModel.${k} 合计 ${got} ≠ 当天 ${want}`); }
    }
  }
  if (bad === 0) pass(`桩数据自洽：${days.length} 天的 byModel 五项小计都与当天合计一致`);
}

/** 图上有什么：柱 / 线 / 虚线。 */
const SHAPE = `(() => {
  const svg = document.querySelector('#usageBox svg.chart');
  if (!svg) return { none: true };
  return {
    bars: svg.querySelectorAll('rect[fill^="url("]').length,
    lines: svg.querySelectorAll('polyline').length,
    dashed: svg.querySelectorAll('polyline[stroke-dasharray]').length,
  };
})()`;

const set = (id, val) => `(() => { const e = document.getElementById('${id}'); e.value = '${val}'; e.dispatchEvent(new Event('change')); })()`;

const server = await startStaticServer(PORT);
const { cdp, close } = await openPage(URL_, baseRoutes(), { width: 1440, height: 1000, cdpPort: 9386 });
const cleanup = () => { try { close(); } catch { /* 忽略 */ } try { server.close(); } catch { /* 忽略 */ } };
process.on('exit', cleanup);

try {
  await waitFor(cdp, `document.querySelectorAll('#usageBox svg.chart').length >= 1`, 10000, '趋势图');
  await sleep(600);

  console.log('── 形态切换（指标 × 形态）──');
  /*
   * 期望值写死。`auto` 是**按指标推导**的默认：次数=柱、tokens=堆叠柱、积分=折线。
   * `bar` / `line` 是用户显式选择。
   * 注意 `credit + bar` 的期望是「有柱**且**有虚线」—— 混合形态。
   */
  const cases = [
    ['calls', 'auto', { bars: 3, lines: 0 }],
    ['calls', 'bar', { bars: 3, lines: 0 }],
    ['calls', 'line', { bars: 0, lines: 1 }],
    ['tokens', 'auto', { bars: 6, lines: 0 }],
    ['tokens', 'bar', { bars: 6, lines: 0 }],
    ['tokens', 'line', { bars: 0, lines: 2 }],
    ['credit', 'auto', { bars: 0, lines: 2, dashed: 1 }],
    ['credit', 'line', { bars: 0, lines: 2, dashed: 1 }],
    ['credit', 'bar', { bars: 3, lines: 1, dashed: 1 }],
    // 按模型堆叠：桩里 3 天 × 2 个模型 = 6 段
    ['credit', 'bymodel', { bars: 6, lines: 0 }],
    ['calls', 'bymodel', { bars: 6, lines: 0 }],
    ['tokens', 'bymodel', { bars: 6, lines: 0 }],
  ];

  for (const [metric, kind, want] of cases) {
    await q(cdp, set('trendMetric', metric));
    await sleep(120);
    await q(cdp, set('trendKind', kind));
    await sleep(260);
    const got = await q(cdp, SHAPE);
    if (got.none) { fail(`[${metric}/${kind}] 没有图`); continue; }
    const ok = got.bars === want.bars && got.lines === want.lines
      && (want.dashed === undefined || got.dashed === want.dashed);
    const desc = `柱 ${got.bars} 线 ${got.lines} 虚线 ${got.dashed}`;
    if (ok) pass(`[${metric}/${kind}] ${desc}`);
    else fail(`[${metric}/${kind}] 期望 柱 ${want.bars} 线 ${want.lines}${want.dashed !== undefined ? ' 虚线 ' + want.dashed : ''}，实际 ${desc}`);
  }

  console.log('\n── 积分排行的模型配色 ──');
  await q(cdp, set('trendMetric', 'credit'));
  await sleep(120);
  await q(cdp, set('trendKind', 'auto'));
  await sleep(400);

  const rows = JSON.parse(await q(cdp, `JSON.stringify([...document.querySelectorAll('#usageBox .rank-row')].map((r) => ({
    name: r.querySelector('.rank-name').textContent,
    other: /^其它/.test(r.querySelector('.rank-name').textContent),
    color: getComputedStyle(r.querySelector('.rank-fill')).backgroundColor,
  })))`));

  const models = rows.filter((r) => !r.other);
  const others = rows.filter((r) => r.other);
  console.log(`  量到 ${rows.length} 行（模型 ${models.length} · 聚合 ${others.length}）`);
  for (const r of rows) console.log(`    ${r.other ? '[其它] ' : '       '}${r.name.padEnd(24)} ${r.color}`);

  if (models.length < 2) fail(`只量到 ${models.length} 个模型行 —— 桩数据或选择器有问题（防假绿）`);
  else {
    const colors = models.map((r) => r.color);
    const uniq = new Set(colors);
    if (uniq.size === colors.length) pass(`${models.length} 个模型 ${uniq.size} 种颜色，两两不同`);
    else {
      const dup = colors.filter((c, i) => colors.indexOf(c) !== i);
      fail(`${models.length} 个模型只用了 ${uniq.size} 种颜色 —— 撞色：${[...new Set(dup)].join(', ')}`);
    }
  }

  // 聚合行不该占用模型色
  for (const r of others) {
    const isModelColor = models.some((m) => m.color === r.color);
    if (isModelColor) fail(`「${r.name}」是聚合行，却用了某个模型的颜色 ${r.color}`);
    else pass(`「${r.name}」用中性色 ${r.color}，没冒充模型`);
  }

  /*
   * 换指标/形态来回切之后颜色必须**不变**（映射表是持久的）。
   * 这是"按出现顺序分配"能成立的前提 —— 若每次渲染重算，切一下就换色。
   */
  const before = models.map((m) => m.color).join(',');
  await q(cdp, set('trendMetric', 'calls'));
  await sleep(300);
  await q(cdp, set('trendMetric', 'credit'));
  await sleep(400);
  const after = JSON.parse(await q(cdp, `JSON.stringify([...document.querySelectorAll('#usageBox .rank-row')]
    .filter((r) => !/^其它/.test(r.querySelector('.rank-name').textContent))
    .map((r) => getComputedStyle(r.querySelector('.rank-fill')).backgroundColor))`)).join(',');
  if (before === after) pass('来回切指标后配色不变（映射是持久的，不是每次重算）');
  else fail(`来回切指标后配色变了：${before} → ${after}`);

  /*
   * 配色必须在「按模型堆叠」的图例与「积分排行」之间**一致**。
   *
   * 这条挡的是一个很容易再犯的错：`modelColor` 按"首次出现顺序"分配，而两处的
   * 排序依据不同（排行按扣分、图表按当前指标）。谁先渲染谁就定顺序 ——
   * 切一下指标，同一个模型在两个地方就是两个颜色。所以加载时先按
   * `usage.models`（与图表无关的稳定顺序）预分配好（`seedModelColors`）。
   */
  await q(cdp, set('trendMetric', 'credit'));
  await sleep(120);
  await q(cdp, set('trendKind', 'bymodel'));
  await sleep(450);

  const legend = JSON.parse(await q(cdp, `JSON.stringify([...document.querySelectorAll('#usageBox .chart-legend .lg')].map((e) => ({
    name: e.textContent,
    color: getComputedStyle(e.querySelector('i')).backgroundColor,
  })))`));
  const rankColors = new Map(JSON.parse(await q(cdp, `JSON.stringify([...document.querySelectorAll('#usageBox .rank-row')]
    .filter((r) => !/^其它/.test(r.querySelector('.rank-name').textContent))
    .map((r) => [r.querySelector('.rank-name').textContent, getComputedStyle(r.querySelector('.rank-fill')).backgroundColor]))`)));

  if (legend.length < 2) fail(`图例只有 ${legend.length} 项 —— 桩数据或选择器有问题（防假绿）`);
  else pass(`按模型堆叠的图例有 ${legend.length} 个模型：${legend.map((l) => l.name).join(' / ')}`);

  let mismatch = 0;
  for (const l of legend) {
    const r = rankColors.get(l.name);
    if (r === undefined) { fail(`图例里的「${l.name}」在积分排行里找不到`); continue; }
    if (r !== l.color) { mismatch++; fail(`「${l.name}」两处颜色不一致：图例 ${l.color} vs 排行 ${r}`); }
  }
  if (legend.length >= 2 && mismatch === 0) pass('图例与积分排行的模型配色完全一致');

  console.log('\n页面错误：', await q(cdp, `JSON.stringify(window.__errors || [])`));
} finally {
  console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
  cleanup();
  process.exit(failures ? 1 : 0);
}
