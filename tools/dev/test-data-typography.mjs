/**
 * 数据排版检查：数字等宽 + 数值列右对齐。
 *
 *   node tools/dev/test-data-typography.mjs
 *
 * 这是**数据控制台**的两条基本要求，而它们都不是"看起来对不对"能判断的：
 *
 * 1. **数字必须等宽**。实测这台机器上 Segoe UI 的 Regular(400)/Bold(700) 用等宽
 *    数字，而 Medium(500)/Semibold(600) 用比例数字 —— 同一个界面里数字对不对得齐，
 *    取决于那个元素恰好用了哪个字重。表现是列对不齐、数值刷新时横向抖动。
 * 2. **数值列必须右对齐**，且**表头要跟着对齐**。左对齐时小数点各起各的，
 *    量级扫不出来；表头漏了 `.num` 则会与数值差出一大截。
 *
 * 判定方式是**直接量渲染宽度**，不是查有没有写某个 CSS 属性 —— 写了也可能不生效。
 */
import { startStaticServer, openPage, q, sleep } from './ui-harness.mjs';

let failures = 0;
const pass = (m) => console.log('✓ ' + m);
const fail = (m) => { console.error('✗ ' + m); failures += 1; };

const PORT = 8785;
const URL_ = `http://127.0.0.1:${PORT}/`;

const CATALOG = [
  { id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash', context_window: 1000000, max_output_tokens: 128000, credits: 0.11 },
  { id: 'glm-5.3', name: 'GLM-5.3', context_window: 1000000, max_output_tokens: 48000, credits: 0.79 },
];
const now = Date.now();
const USAGE = {
  windowDays: 7,
  // 字段名必须与真实接口一致（/api/usage 的 usage 里是 total / models / days）——
  // 写错的话用量表会**静默地不渲染**，而页面看起来一切正常，很容易误判成"没问题"
  total: { calls: 118, promptTokens: 241000, completionTokens: 51000, ms: 92000, credit: 1.28, creditCalls: 104, failed: 3 },
  models: [
    { model: 'deepseek-v4.1-flash', calls: 61, promptTokens: 128000, completionTokens: 30000, ms: 48000, credit: 0.61, creditCalls: 55 },
    { model: 'glm-5.3', calls: 44, promptTokens: 97000, completionTokens: 19000, ms: 38000, credit: 0.62, creditCalls: 42 },
  ],
  days: [
    { day: '2026-10-01', calls: 9, promptTokens: 38000, completionTokens: 9000, credit: 0.27, creditCalls: 8 },
    { day: '2026-10-02', calls: 7, promptTokens: 30000, completionTokens: 7000, credit: 0.22, creditCalls: 7 },
    { day: '2026-10-03', calls: 8, promptTokens: 44000, completionTokens: 11000, credit: 0.24, creditCalls: 7 },
  ],
  failures: [],
};
const REQUESTS = [
  { t: now - 20000, model: 'deepseek-v4.1-flash', stream: true, ok: true, ms: 1180, promptTokens: 820, completionTokens: 240, credit: 0.03 },
  { t: now - 60000, model: 'glm-5.3', stream: false, ok: true, ms: 2400, promptTokens: 1180, completionTokens: 380, credit: 0.11 },
];

const routes = {
  '/api/models': { body: { models: CATALOG } },
  '/api/clients': { body: { running: true, host: '127.0.0.1', port: 8790, baseUrlOpenAI: 'http://127.0.0.1:8790/v1', baseUrlAnthropic: 'http://127.0.0.1:8790', token: 'wb-local-bridge', anthropicModel: 'glm-5.3', anthropicFastModel: 'glm-5.3-flash', models: CATALOG.map((m) => m.id), modelDetails: CATALOG.map((m) => ({ id: m.id, name: m.name, context: m.context_window, maxOutput: m.max_output_tokens })) } },
  '/api/overview': {
    body: {
      bridge: { running: true, ok: true, host: '127.0.0.1', port: 8790, endpoint: 'http://127.0.0.1:8790/v1', pid: 18432, startedAt: new Date(now - 5400000).toISOString(), uptimeMs: 5400000, catalogSize: 2, catalogAt: new Date(now - 420000).toISOString() },
      credentials: { active: { account: '330101979236', userId: '330101979236', remainingMs: 37 * 86400000, expiresAt: now + 37 * 86400000 }, error: '' },
      quota: { total: 715, packages: [{ name: '每日签到', remain: 18, size: 20 }] },
      dsh: { routeLive: true, hasBridgeKey: true, bundlesOk: true, bundles: ['a'], registeredModels: ['glm-5.3'] },
      console: { version: '1.0.0', node: 'v22.22.2' },
    },
  },
  '/api/probe-results': { body: { updatedAt: null, results: {}, lastRun: null } },
  '/api/diagnose': { body: { items: [] } },
  '/api/usage': { body: { usage: USAGE } },
  '/api/requests': { body: { requests: REQUESTS } },
  '/api/accounts': { body: { accounts: [] } },
  '/api/checkin': { body: { status: { active: true, todayCheckedIn: true, todayCredit: 18, streakDays: 3 } } },
  '/api/bridge/log': { body: { lines: [] } },
};

const server = await startStaticServer(PORT);
const { cdp, close } = await openPage(URL_, routes, { width: 1440, height: 1200 });
const cleanup = () => { try { cdp.close(); } catch { /* 忽略 */ } try { server.close(); } catch { /* 忽略 */ } };
process.on('exit', cleanup);

await sleep(1200);

/**
 * 在给定选择器的元素上，量 '1111111111' 与 '8888888888' 的渲染宽度。
 * 两者不等宽 → 数字是比例字形 → 列对不齐、刷新时抖动。
 *
 * **必须克隆元素本身来量，不能新建一个 span 再复制字体**：第一版就是那么做的，
 * 结果 `-apple-system` 那条栈在新 span 里和在原元素上解析到了不同字体，
 * 报出「19px 等宽、13.5px 不等宽」这种自相矛盾的结论。克隆能原样继承
 * 该元素在**真实位置**上的计算样式。
 */
const probe = await q(cdp, `(() => {
  const A = '1111111111';
  const B = '8888888888';
  const targets = [
    ['状态卡大数字', '.card .v'],
    ['状态卡小数字', '.card .v.small'],
    ['卡片脚注', '.card .note'],
    ['用量表数值列', 'td.mono'],
    ['表头', 'table th'],
    ['时间戳', '.stamp'],
    ['接入值', '.valuerow-v'],
    ['徽章', '.badge'],
    ['模型标签', '.tag'],
    ['诊断值', '.diag-row .s-text'],
    ['筛选芯片', '.filterchip'],
  ];
  const widthOf = (el, text) => {
    const c = el.cloneNode(false);      // 同标签、同 class、同位置 → 同计算样式
    c.textContent = text;
    c.style.position = 'absolute';
    c.style.visibility = 'hidden';
    c.style.whiteSpace = 'pre';
    c.style.width = 'auto';
    (el.parentElement || document.body).appendChild(c);
    const w = c.getBoundingClientRect().width;
    c.remove();
    return w;
  };
  const out = [];
  for (const [label, sel] of targets) {
    const el = document.querySelector(sel);
    if (!el) { out.push({ label, missing: true }); continue; }
    const cs = getComputedStyle(el);
    const wa = widthOf(el, A);
    const wb = widthOf(el, B);
    out.push({
      label,
      declared: cs.fontVariantNumeric,
      wa: Number(wa.toFixed(2)),
      wb: Number(wb.toFixed(2)),
      delta: Number(Math.abs(wa - wb).toFixed(2)),
      size: cs.fontSize.replace('px', ''),
      weight: cs.fontWeight,
      font: cs.fontFamily.split(',')[0].replace(/["']/g, ''),
      sample: (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 18),
    });
  }
  return out;
})()`);

console.log('\n数字宽度一致性（1111111111 vs 8888888888）');
for (const r of probe) {
  if (r.missing) { console.log(`  · ${r.label}（元素不存在，跳过）`); continue; }
  if (r.delta < 0.01) pass(`${r.label} 等宽（${r.size}px/${r.weight}，宽 ${r.wa}）`);
  else fail(`${r.label} 数字不等宽：${r.wa} vs ${r.wb}（差 ${r.delta}px，${r.size}px/${r.weight}）—— 列对不齐、刷新时会横向抖动`);
}

// ── 数值列的右对齐 ──────────────────────────────────────────────────────
// 光有等宽数字还不够：左对齐时小数点各起各的，量级依然扫不出来。
// 这里量的是**表头文字的右缘**与**该列数值的右缘**是否重合 —— 只有两者都右对齐
// 才会重合；表头漏了 .num 就会差出一大截。
const align = await q(cdp, `(() => {
  const rightEdge = (el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const rects = range.getClientRects();
    return rects.length ? Math.round(rects[rects.length - 1].right) : null;
  };
  const out = [];
  for (const table of document.querySelectorAll('table')) {
    const ths = [...table.querySelectorAll('thead th')];
    const tds = [...table.querySelectorAll('tbody tr:first-child td')];
    ths.forEach((th, i) => {
      const td = tds[i];
      if (!td || !td.textContent.trim()) return;
      out.push({
        col: (th.textContent || '').trim().slice(0, 10),
        thAlign: getComputedStyle(th).textAlign,
        tdAlign: getComputedStyle(td).textAlign,
        thRight: rightEdge(th),
        tdRight: rightEdge(td),
      });
    });
  }
  return out;
})()`);

console.log('\n数值列对齐（表头右缘 vs 数值右缘）');
let numericCols = 0;
for (const x of align) {
  const isNum = x.tdAlign === 'right' || x.thAlign === 'right';
  if (!isNum) continue;
  numericCols += 1;
  const delta = Math.abs(x.thRight - x.tdRight);
  if (delta <= 2) pass(`数值列「${x.col}」表头与数值右缘一致（差 ${delta}px）`);
  else fail(`数值列「${x.col}」表头没跟上：表头右缘 ${x.thRight} vs 数值右缘 ${x.tdRight}，差 ${delta}px`);
}
if (numericCols === 0) fail('一个数值列都没找到 —— .num 类可能没生效，或表格没渲染（检查桩数据字段名是否与真实接口一致）');

cleanup();
console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
