/**
 * 「客户端接入」面板验收。
 *
 *   node tools/dev/test-clients-panel.mjs
 *
 * 覆盖：页签可达性、三个接入值渲染、opencode / Claude Code 配置片段内容、
 * 兼容性分档（已实测 / 协议兼容 / 不支持）、复制按钮接线、多视口无横向溢出。
 *
 * 不启真控制台、不消耗上游额度：静态服务 + 无头 Chromium，`/api/*` 全打桩。
 */
import { startStaticServer, openPage, waitFor, q, sleep } from './ui-harness.mjs';
import { baseRoutes, clientsFixture, CATALOG } from './fixtures.mjs';

const PORT = 8788;
const URL_ = `http://127.0.0.1:${PORT}/`;

let failures = 0;
const fail = (m) => { console.error('✗ ' + m); failures += 1; };
const pass = (m) => console.log('✓ ' + m);
const eq = (actual, expected, label) => {
  if (actual === expected) pass(`${label} = ${JSON.stringify(actual)}`);
  else fail(`${label} 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
};

/** 手工构造的已知输入：断言里直接写死期望值，不依赖真实使用数据。 */
// 桩数据来自共享夹具（tools/dev/fixtures.mjs）—— 形状由 ui-harness 自动校验。
// CLIENTS 与页面实际收到的 /api/clients 是同一份，断言直接对着它写。
const CLIENTS = clientsFixture();
/**
 * 目录里**多放一个精选集之外的模型**：用来验证「用户能把任意可用模型加进配置」。
 * 注意桩数据在 openPage 时就序列化进页面了，**事后改 routes 对象没用** ——
 * 必须在打开页面之前就准备好。
 */
const EXTRA_MODEL = { id: 'kimi-k3-9', name: 'Kimi-K3.9', context_window: 512000, max_output_tokens: 16000, credits: 0.5 };
const routes = baseRoutes({ catalog: [...CATALOG, EXTRA_MODEL] });

/** 在页面里注入的对比度测量工具（与 audit-clients-panel.mjs 同源）。 */
const MEASURE_HELPERS = `
window.__AUDIT = {
  parseRgb(s) {
    const m = String(s).match(/rgba?\\(([^)]+)\\)/);
    if (!m) return null;
    const p = m[1].split(',').map(x => parseFloat(x.trim()));
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  },
  lum(c) {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  },
  contrast(a, b) {
    const l1 = this.lum(a), l2 = this.lum(b);
    const hi = Math.max(l1, l2), lo = Math.min(l1, l2);
    return (hi + 0.05) / (lo + 0.05);
  },
  effBg(el) {
    let node = el, stack = [];
    while (node && node !== document.documentElement) {
      const bg = this.parseRgb(getComputedStyle(node).backgroundColor);
      if (bg && bg.a > 0) {
        if (bg.a >= 0.999) return { r: bg.r, g: bg.g, b: bg.b, a: 1 };
        stack.push(bg);
      }
      node = node.parentElement;
    }
    let base = { r: 255, g: 255, b: 255 };
    const htmlBg = this.parseRgb(getComputedStyle(document.documentElement).backgroundColor);
    if (htmlBg && htmlBg.a >= 0.999) base = { r: htmlBg.r, g: htmlBg.g, b: htmlBg.b };
    for (let i = stack.length - 1; i >= 0; i--) {
      const s = stack[i];
      base = {
        r: base.r * (1 - s.a) + s.r * s.a,
        g: base.g * (1 - s.a) + s.g * s.a,
        b: base.b * (1 - s.a) + s.b * s.a,
      };
    }
    return base;
  },
  ratioOf(el) {
    const cs = getComputedStyle(el);
    const fg = this.parseRgb(cs.color);
    const bg = this.effBg(el);
    if (!fg || !bg) return null;
    const f = fg.a >= 0.999 ? fg : {
      r: bg.r * (1 - fg.a) + fg.r * fg.a,
      g: bg.g * (1 - fg.a) + fg.g * fg.a,
      b: bg.b * (1 - fg.a) + fg.b * fg.a,
    };
    return { ratio: this.contrast(f, bg), size: parseFloat(cs.fontSize), weight: cs.fontWeight };
  },
};
`;

const INJECT = MEASURE_HELPERS;

const server = await startStaticServer(PORT);
const { cdp, close } = await openPage(URL_, routes, { inject: INJECT });
const cleanup = () => { try { cdp.close(); } catch { /* 忽略 */ } try { server.close(); } catch { /* 忽略 */ } };
process.on('exit', cleanup);

/**
 * 切到某个客户端页签。
 *
 * 「客户端接入」现在是**先选后展开**（只渲染选中的那一块），所以每一节断言之前
 * 都要先切到对应页签 —— 否则量到的是空面板，断言会成片地假失败。
 */
const CLIENT_CHIP = { opencode: 'opencode', claude: 'Claude Code', form: '图形表单', other: '其它客户端' };
async function selectClient(id) {
  const label = JSON.stringify(CLIENT_CHIP[id]);
  await q(cdp, '(() => { const b = [...document.querySelectorAll("#clientsBox .clientpicker button")]'
    + '.find((x) => x.textContent.trim() === ' + label + '); if (b) b.click(); })()');
  await sleep(150);
}

/** 读当前页签里的卡片（先选后展开，所以每次切换后都要重读）。 */
async function readCards() {
  return q(cdp, `[...document.querySelectorAll('#clientsBox .clientcard')].map(c => ({
    name: c.querySelector('.clientcard-head b')?.textContent || '',
    tag: c.querySelector('.clientcard-head .tag')?.textContent || '',
    code: [...c.querySelectorAll('.codeblock pre')].map(p => p.textContent).join('\\n'),
  }))`);
}

// ── 1. 页签可达 ──────────────────────────────────────────────────────────
const tabCount = await q(cdp, `document.querySelectorAll('.nav-tab').length`);
eq(tabCount, 5, '导航页签数量');

const hasClientsTab = await q(cdp, `!!document.querySelector('.nav-tab[data-tab="clients"]')`);
if (hasClientsTab) pass('存在「客户端接入」页签'); else fail('缺少「客户端接入」页签');

await q(cdp, `document.querySelector('.nav-tab[data-tab="clients"]').click()`);
await sleep(300);

const vis = await q(cdp, `(() => {
  const secs = [...document.querySelectorAll('[data-section]')];
  const on = secs.filter(s => s.style.display !== 'none' && s.dataset.section === 'clients').length;
  const off = secs.filter(s => s.style.display === 'none').length;
  return { on, off, total: secs.length };
})()`);
if (vis.on >= 1 && vis.off >= 1) pass(`切到页签后只显示 clients 区块（显示 ${vis.on} 个，隐藏 ${vis.off}/${vis.total}）`);
else fail(`页签切换异常：${JSON.stringify(vis)}`);

// ── 2. 三个接入值 ────────────────────────────────────────────────────────
await waitFor(cdp, `document.querySelectorAll('#clientsBox .valuerow').length >= 3`, 8000, '三个接入值');

const vals = await q(cdp, `[...document.querySelectorAll('#clientsBox .valuerow')].map(r => ({
  k: r.querySelector('.valuerow-k').textContent,
  v: r.querySelector('.valuerow-v').textContent,
}))`);
eq(vals.length, 3, '接入值行数');
eq(vals[0].v, CLIENTS.baseUrlOpenAI, 'OpenAI Base URL');
eq(vals[1].v, CLIENTS.baseUrlAnthropic, 'Anthropic Base URL');
eq(vals[2].v, CLIENTS.token, '令牌（必须来自接口，不能写死）');

// ── 3. opencode 片段 ────────────────────────────────────────────────────
await selectClient('opencode');
const opencode = (await readCards()).find((c) => c.name === 'opencode');
if (opencode) {
  pass(`opencode 卡片存在（状态「${opencode.tag}」）`);
  if (opencode.code.includes('@ai-sdk/openai-compatible')) pass('opencode 片段含 @ai-sdk/openai-compatible');
  else fail('opencode 片段缺少 npm 包名');
  if (opencode.code.includes(CLIENTS.baseUrlOpenAI)) pass('opencode 片段含真实 Base URL');
  else fail('opencode 片段未填真实 Base URL');
  if (opencode.code.includes('glm-5.3')) pass('opencode 片段含真实模型清单');
  else fail('opencode 片段缺少模型清单');
  // limit 是「上下文 0」的根治点：自定义 provider 必须显式声明
  if (opencode.code.includes('"limit"') && opencode.code.includes(String(CLIENTS.modelDetails[0].context))) {
    pass('opencode 片段含 limit（上下文 / 输出上限真实值）');
  } else fail('opencode 片段缺少 limit，客户端会显示「上下文 0」');
} else fail('缺少 opencode 卡片');

// ── 3b. 模型选择器：勾什么，配置就生成什么 ──────────────────────────────
// 选择器列的是完整目录（/api/models），要等它到 —— 它与桥状态解耦、允许后到
await waitFor(cdp, `!!(Array.isArray(lastModels) && lastModels.length > 4)`, 8000, '完整目录');
await selectClient('opencode');

const pick = await q(cdp, `(() => {
  const w = document.querySelector('#clientsBox .modelpick');
  if (!w) return null;
  return {
    count: (w.querySelector('.modelpick-count') || {}).textContent || '',
    chips: [...w.querySelectorAll('.modelpick-chip')].map((c) => ({
      // 这段是**注入到页面里执行的模板串**：里面的反斜杠必须写两层，
      // 否则制表符/换行的转义会先被模板串求值成真字符，塞进正则字面量直接语法错误。
      // （原写法用简写的空白转义，在模板串里反斜杠会被吃掉 —— 实际注入的是
      //  匹配「✓ + 若干 s」的正则，只是靠后面的 .trim() 侥幸没错。）
      id: c.textContent.replace(/^✓[ \\t\\r\\n]*/, '').trim(), on: c.classList.contains('on'),
    })),
    blockVisible: (() => {
      const pre = document.querySelector('#clientsBox .codeblock pre');
      return !!pre && pre.getBoundingClientRect().height > 0;
    })(),
    blockText: (document.querySelector('#clientsBox .codeblock pre') || {}).textContent || '',
  };
})()`);
if (pick) pass('存在模型选择器'); else fail('缺少模型选择器');
if (pick && pick.blockVisible) pass('配置块默认**展开可见**（看不到内容却要人复制是自相矛盾的）');
else fail('配置块默认不可见 —— 用户看不到自己要复制的东西');
if (pick && pick.chips.some((c) => c.id === 'kimi-k3-9')) pass('目录里精选集之外的模型也出现在选择器里');
else fail('选择器只列了精选集，用户加不了别的模型');
// 芯片总数必须等于**完整目录**的长度，而不是精选集 —— 这条盯的是
// 「目录后到、选择器不重渲染」那个 bug（曾表现为 30 个模型只显示 4 个）
eq(pick.chips.length, CATALOG.length + 1, `选择器列出完整目录（${CATALOG.length + 1} 个），而非精选集`);
if (pick && pick.blockText.includes('kimi-k3-9') === false) pass('未勾选的模型不在配置里');
else fail('未勾选的模型却出现在配置里');

// 勾上目录外的模型 → 配置里应出现，且带上真实上下文
await q(cdp, `(() => {
  const c = [...document.querySelectorAll('#clientsBox .modelpick-chip')].find((x) => x.textContent.includes('kimi-k3-9'));
  if (c) c.click();
})()`);
await sleep(250);
const afterAdd = await q(cdp, `(() => {
  const pre = document.querySelector('#clientsBox .codeblock pre');
  const w = document.querySelector('#clientsBox .modelpick');
  return {
    has: pre ? pre.textContent.includes('kimi-k3-9') : false,
    ctx: pre ? pre.textContent.includes('512000') : false,
    count: (w.querySelector('.modelpick-count') || {}).textContent || '',
  };
})()`);
if (afterAdd.has) pass('勾选后该模型出现在配置片段里');
else fail('勾选后配置片段没有更新 —— 选择器没接线');
if (afterAdd.ctx) pass('新加入的模型带上了真实上下文长度（512000）');
else fail('新加入的模型缺少真实上下文长度，客户端会显示「上下文 0」');

// 取消勾选 → 应从配置里消失
await q(cdp, `(() => {
  const c = [...document.querySelectorAll('#clientsBox .modelpick-chip')].find((x) => x.textContent.includes('kimi-k3-9'));
  if (c) c.click();
})()`);
await sleep(250);
const afterRemove = await q(cdp, `(() => {
  const pre = document.querySelector('#clientsBox .codeblock pre');
  return pre ? pre.textContent.includes('kimi-k3-9') : false;
})()`);
if (!afterRemove) pass('取消勾选后该模型从配置里消失');
else fail('取消勾选后模型仍在配置里');

// 「清空」后配置里不应残留任何模型
await q(cdp, `(() => {
  const b = [...document.querySelectorAll('#clientsBox .modelpick-head button')].find((x) => x.textContent.trim() === '清空');
  if (b) b.click();
})()`);
await sleep(250);
// 注意：页面求值的字符串里引用不到 Node 侧的变量，要先把值插进去
const firstId = JSON.stringify(CLIENTS.modelDetails[0].id);
const cleared = await q(cdp, '(() => {'
  + ' const pre = document.querySelector("#clientsBox .codeblock pre");'
  + ' return pre ? pre.textContent.includes(' + firstId + ') : true;'
  + ' })()');
if (!cleared) pass('「清空」后配置里不再残留模型');
else fail('「清空」没有生效');

// 复原，后面的用例还要用
await q(cdp, `(() => {
  const b = [...document.querySelectorAll('#clientsBox .modelpick-head button')].find((x) => x.textContent.trim() === '全选');
  if (b) b.click();
})()`);
await sleep(250);

// ── 4. Claude Code 片段 ─────────────────────────────────────────────────
await selectClient('claude');
const cc = (await readCards()).find((c) => c.name === 'Claude Code');
if (cc) {
  pass(`Claude Code 卡片存在（状态「${cc.tag}」）`);
  if (cc.code.includes('ANTHROPIC_BASE_URL=' + CLIENTS.baseUrlAnthropic)) pass('Claude Code 片段含正确 ANTHROPIC_BASE_URL');
  else fail('Claude Code 片段 ANTHROPIC_BASE_URL 不正确');
  if (cc.code.includes(CLIENTS.token)) pass('Claude Code 片段含真实令牌');
  else fail('Claude Code 片段未用真实令牌');
} else fail('缺少 Claude Code 卡片');

// ── 5. 图形表单：逐格可复制 ─────────────────────────────────────────────
await selectClient('form');
// 字段按「提供商级 / 模型 N」分组渲染，这里把组标题拼回 key，断言仍是扁平的
const frows = await q(cdp, `[...document.querySelectorAll('#clientsBox .formguide .fggroup')].flatMap(g => {
  const t = g.querySelector('.fggh')?.textContent || '';
  return [...g.querySelectorAll('.formrow')].map(r => ({
    k: (t ? t + ' · ' : '') + (r.querySelector('.formrow-k')?.textContent || ''),
    v: r.querySelector('.formrow-v')?.textContent ?? null,
    hasBtn: !!r.querySelector('button.mini'),
  }));
})`);
if (frows.length >= 5) pass(`图形表单字段行 ${frows.length} 条`);
else fail(`图形表单字段行不足：${frows.length}`);

// 分组数 = 1 个提供商级 + **当前勾选的模型数**（选择器可增删，不能写死精选集长度）
const chosenNow = await q(cdp, `document.querySelectorAll('#clientsBox .modelpick-chip.on').length`);
const groupCount = await q(cdp, `document.querySelectorAll('#clientsBox .formguide .fggroup').length`);
eq(groupCount, chosenNow + 1, `字段分组数（提供商级 + 已勾选的 ${chosenNow} 个模型各一组）`);

// 分组标题必须写明归属，不能靠缩进让用户猜
const groupTitles = await q(cdp, `[...document.querySelectorAll('#clientsBox .formguide .fggh')].map(e => e.textContent)`);
for (let i = 1; i <= CLIENTS.modelDetails.length; i += 1) {
  if (groupTitles.includes('模型 ' + i)) pass(`存在分组标题「模型 ${i}」`);
  else fail(`缺少分组标题「模型 ${i}」`);
}

for (const [k, want] of Object.entries({
  '提供商 ID': 'workbuddy',
  '显示名称': 'WorkBuddy',
  '基础 URL': CLIENTS.baseUrlOpenAI,
  'API 密钥': CLIENTS.token,
  '请求头': null,
  // 这两格是关键：留空/填 0 会让客户端把上下文显示成 0
  '模型 1 · model-id': CLIENTS.modelDetails[0].id,
  '模型 1 · 上下文长度': String(CLIENTS.modelDetails[0].context),
  '模型 1 · 输出上限': String(CLIENTS.modelDetails[0].maxOutput),
})) {
  const row = frows.find((r) => r.k === k);
  if (!row) { fail(`表单缺少字段「${k}」`); continue; }
  if (row.v === want) pass(`表单字段「${k}」→ ${want === null ? '（留空）' : want}`);
  else fail(`表单字段「${k}」取值错：${JSON.stringify(row.v)}`);
}

// 每个有值的格子都必须有**独立的**复制按钮（这是本次的核心诉求）
const noBtn = frows.filter((r) => r.v && !r.hasBtn).map((r) => r.k);
if (noBtn.length === 0) pass('每个有值的字段都有独立复制按钮');
else fail(`以下字段缺复制按钮：${JSON.stringify(noBtn)}`);

// 模型行：桥返回的每个模型都要能单独复制
const modelRows = frows.filter((r) => r.k.includes('model-id'));
eq(modelRows.length, chosenNow, '模型行数（应与选择器里勾选的数量一致）');

// ── 5a. 排版：四列必须全表对齐 ──────────────────────────────────────────
// 「照着抄」的场景里，值列如果每行起点不同，眼睛就没法竖着扫下来
const align = await q(cdp, `(() => {
  const rows = [...document.querySelectorAll('#clientsBox .formguide .formrow')];
  const valLeft = rows.map(r => Math.round(r.querySelector('.formrow-v, .formrow-empty').getBoundingClientRect().left));
  const btnLeft = rows.map(r => {
    const b = r.querySelector('button.mini');
    return b ? Math.round(b.getBoundingClientRect().left) : null;
  }).filter(v => v !== null);
  const kWidth = rows.map(r => Math.round(r.querySelector('.formrow-k').getBoundingClientRect().width));
  const hintLeft = rows.map(r => {
    const h = r.querySelector('.formrow-h');
    return h ? Math.round(h.getBoundingClientRect().left) : null;
  }).filter(v => v !== null);
  return {
    valLefts: [...new Set(valLeft)],
    btnLefts: [...new Set(btnLeft)],
    kWidths: [...new Set(kWidth)],
    hintLefts: [...new Set(hintLeft)],
  };
})()`);
eq(align.kWidths.length, 1, `字段名列宽一致（${align.kWidths.join('/')}px）`);
eq(align.valLefts.length, 1, '值列左边缘对齐');
eq(align.btnLefts.length, 1, '复制按钮左边缘对齐');
eq(align.hintLefts.length, 1, '说明列左边缘对齐');

// ── 5b. 接入值也必须有可见的复制按钮 ────────────────────────────────────
const valBtns = await q(cdp, `[...document.querySelectorAll('#clientsBox .valuerow')].filter(r => r.querySelector('button.mini')).length`);
eq(valBtns, 3, '三个接入值各有复制按钮');

// ── 5c. 「复制全部」 ───────────────────────────────────────────────────
const allBtn = await q(cdp, `!!document.getElementById('clientsCopyAllBtn')`);
if (allBtn) pass('存在「复制全部」按钮'); else fail('缺少「复制全部」按钮');

const allBtnClick = await q(cdp, `(() => {
  try { document.getElementById('clientsCopyAllBtn').click(); return true; } catch (e) { return 'ERR: ' + e.message; }
})()`);
eq(allBtnClick, true, '点击「复制全部」不抛错');

// ── 6. 兼容性分档 ───────────────────────────────────────────────────────
await selectClient('other');
// 「不支持」是常驻尾注；「已实测」只在对应的客户端页签里（先选后展开）
const otherTags = await q(cdp, `[...document.querySelectorAll('#clientsBox .clientcard-head .tag')].map(e => e.textContent)`);
if (otherTags.includes('不支持')) pass('存在「不支持」档'); else fail('缺少「不支持」档');
await selectClient('opencode');
const okTags = await q(cdp, `[...document.querySelectorAll('#clientsBox .clientcard-head .tag')].map(e => e.textContent)`);
if (okTags.includes('已实测')) pass('存在「已实测」档'); else fail('缺少「已实测」档');
await selectClient('other');

const chips = await q(cdp, `[...document.querySelectorAll('#clientsBox .clientchip')].map(e => e.textContent)`);
for (const need of ['Cursor', 'Trae', 'Cherry Studio', 'LobeChat']) {
  if (chips.includes(need)) pass(`兼容清单含 ${need}`); else fail(`兼容清单缺少 ${need}`);
}

const ragText = await q(cdp, `(() => {
  const c = [...document.querySelectorAll('#clientsBox .clientcard')].find(x => (x.querySelector('b')?.textContent || '').includes('RAG'));
  return c ? c.textContent : '';
})()`);
if (ragText.includes('501') && ragText.includes('embedding')) pass('RAG 卡片如实说明 501 与 embedding 缺失');
else fail('RAG 卡片说明不完整');

// ── 6. 复制按钮接线 ─────────────────────────────────────────────────────
// 代码块只在具体客户端的页签里（opencode / Claude Code），先切过去
await selectClient('opencode');
// 只数复制按钮：head 里现在还有折叠开关，用不带 .copybtn 的选择器会把它算进来
const copyBtns = await q(cdp, `document.querySelectorAll('#clientsBox .codeblock-head button.copybtn').length`);
if (copyBtns >= 1) pass(`代码块复制按钮 ${copyBtns} 个`); else fail('复制按钮缺失');

// 复制按钮必须真的能跑通（点击后不抛错）
const clickOk = await q(cdp, `(() => {
  const b = document.querySelector('#clientsBox .codeblock-head button.copybtn');
  try { b.click(); return true; } catch (e) { return 'ERR: ' + e.message; }
})()`);
eq(clickOk, true, '点击复制按钮不抛错');

// ── 6a. 代码块折叠开关：必须始终可用 ────────────────────────────────────
// 曾经只在 `collapsed: true` 时挂 onclick —— 默认展开后那些块就成了死控件。
// 默认展开是对的（看不到内容却要人复制自相矛盾），但**开关本身不能失灵**。
//
// 每次都**重新查询元素**再操作：面板是可重建的（选客户端 / 目录刷新都会
// `renderClients()`），缓存下来的 DOM 引用随时可能变成游离节点，
// 对着游离节点 click() 什么都不会发生 —— 那会表现成"开关失灵"，其实是测试写错了。
const toggleTrace = await q(cdp, `(async () => {
  const find = () => {
    const block = document.querySelector('#clientsBox .codeblock');
    return block && {
      block,
      body: block.querySelector('.codeblock-body'),
      toggle: block.querySelector('.codeblock-toggle'),
    };
  };
  const h = (el) => Math.round(el.getBoundingClientRect().height);
  const trace = [];
  let cur = find();
  const diag = (c) => {
    const cs = getComputedStyle(c.body);
    const pre = c.body.querySelector('pre');
    return {
      rows: cs.gridTemplateRows, disp: cs.display,
      preMin: pre ? getComputedStyle(pre).minHeight : '(无 pre)',
      preOv: pre ? getComputedStyle(pre).overflow : '',
      pane: (document.querySelector('#clientsBox .clientpicker button.active') || {}).textContent || '?',
      n: document.querySelectorAll('#clientsBox .codeblock').length,
    };
  };
  trace.push({ step: '初始', cls: cur.block.className, h: h(cur.body), aria: cur.toggle.getAttribute('aria-expanded'), ...diag(cur) });
  cur.toggle.click();
  trace.push({ step: '点击后(同步)', cls: cur.block.className, h: h(cur.body), aria: cur.toggle.getAttribute('aria-expanded') });
  await new Promise((r) => setTimeout(r, 500));
  cur = find();
  trace.push({ step: '等待后', cls: cur.block.className, h: h(cur.body), aria: cur.toggle.getAttribute('aria-expanded'), ...diag(cur) });
  const collapsed = { cls: cur.block.className, h: h(cur.body), aria: cur.toggle.getAttribute('aria-expanded') };
  cur.toggle.click();
  await new Promise((r) => setTimeout(r, 500));
  cur = find();
  return { trace, collapsed, restored: { cls: cur.block.className, h: h(cur.body), aria: cur.toggle.getAttribute('aria-expanded') } };
})()`);

for (const t of toggleTrace.trace) {
  console.log(`    · ${t.step.padEnd(12)} ${(t.cls || '').padEnd(20)} 高度=${String(t.h).padStart(4)}px  aria-expanded=${t.aria}  grid-rows=${t.rows}`);
}
if (toggleTrace.collapsed.cls.includes('collapsed') && toggleTrace.collapsed.h < 40) {
  pass(`折叠开关可用（收起到 ${toggleTrace.collapsed.h}px）`);
} else {
  fail(`折叠开关点了没反应（class=${toggleTrace.collapsed.cls}，高度 ${toggleTrace.collapsed.h}px）`);
}
if (!toggleTrace.restored.cls.includes('collapsed') && toggleTrace.restored.h > 100) {
  pass(`再次点击恢复展开（${toggleTrace.restored.h}px）`);
} else {
  fail(`展开没恢复（class=${toggleTrace.restored.cls}，高度 ${toggleTrace.restored.h}px）`);
}
eq(toggleTrace.collapsed.aria, 'false', '折叠后 aria-expanded=false');
eq(toggleTrace.restored.aria, 'true', '展开后 aria-expanded=true');

// ── 6b. 可访问性：可访问名、播报区、命中区 ──────────────────────────────
const a11y = await q(cdp, `(() => {
  const panel = document.querySelector('[data-section="clients"]');
  const box = document.getElementById('clientsBox');
  const btns = [...box.querySelectorAll('button')];
  const names = btns.map(b => (b.getAttribute('aria-label') || '').trim()).filter(Boolean);
  // 有效命中区 = 视觉 rect ∪ 伪元素 ::after（Chromium 读不到 inset 简写，得逐边读）
  const hit = (el) => {
    const r = el.getBoundingClientRect();
    const a = getComputedStyle(el, '::after');
    if (!a.content || a.content === 'none') return { w: r.width, h: r.height };
    const t = parseFloat(a.top) || 0, bo = parseFloat(a.bottom) || 0;
    const l = parseFloat(a.left) || 0, ri = parseFloat(a.right) || 0;
    return { w: r.width - l - ri, h: r.height - t - bo };
  };
  // 只有**自身没有可辨识文案**的按钮才需要 aria-label —— 页签芯片、展开开关
  // 都有可见文字，给它们也套 aria-label 反而啰嗦。要盯住的是那些全叫「复制」的。
  const copyBtns = btns.filter(b => (b.textContent || '').trim() === '复制');
  const copyNames = copyBtns.map(b => (b.getAttribute('aria-label') || '').trim());
  return {
    total: btns.length,
    copyCount: copyBtns.length,
    copyLabelled: copyNames.filter(Boolean).length,
    copyUnique: new Set(copyNames.filter(Boolean)).size,
    live: panel.querySelectorAll('[aria-live]').length,
    small: btns.filter(b => { const h = hit(b); return h.h < 32 || h.w < 32; }).length,
  };
})()`);
if (a11y.copyCount > 0) pass(`当前页签有 ${a11y.copyCount} 个「复制」按钮`);
else fail('当前页签一个「复制」按钮都没有 —— 复制功能丢了');
eq(a11y.copyLabelled, a11y.copyCount, '每个「复制」按钮都有 aria-label');
eq(a11y.copyUnique, a11y.copyCount, '「复制」按钮的可访问名互不重复');
if (a11y.live >= 1) pass('存在 aria-live 播报区'); else fail('缺少 aria-live 播报区');
eq(a11y.small, 0, '有效命中区均 ≥ 32px');

// ── 6c. 交互：就地反馈（顶部提示条在长面板底部够不着）────────────────────
// head 里现在是 [展开开关, 复制按钮]，要点的必须是复制那个
await q(cdp, `document.querySelector('#clientsBox .codeblock-head button.copybtn').click()`);
await sleep(200);
const fbState = await q(cdp, `(() => {
  const b = document.querySelector('#clientsBox .codeblock-head button.copybtn');
  const live = document.getElementById('clientsLive');
  return { text: (b.textContent || '').trim(), live: (live ? live.textContent : '').trim() };
})()`);
if (fbState.text === '已复制' || fbState.text === '失败') pass(`就地反馈生效（按钮文本 → "${fbState.text}"）`);
else fail(`就地反馈未生效，按钮文本仍是 "${fbState.text}"`);
if (fbState.live) pass(`aria-live 收到播报（"${fbState.live}"）`);
else fail('aria-live 未收到播报');
await sleep(1800);
eq(await q(cdp, `document.querySelector('#clientsBox .codeblock-head button.copybtn').textContent.trim()`), '复制', '1.8 秒后按钮文本恢复');

// ── 6d. 对比度（WCAG AA 4.5:1）──────────────────────────────────────────
// .formrow-* 只在「图形表单」页签里渲染，先切过去
await selectClient('form');
for (const theme of ['light', 'dark']) {
  await q(cdp, `document.documentElement.setAttribute('data-theme','${theme}')`);
  await sleep(150);
  const rows = await q(cdp, `(() => {
    const sel = {
      '字段名': '#clientsBox .formrow-k',
      '说明文字': '#clientsBox .formrow-h',
      '值': '#clientsBox .formrow-v',
      '卡片说明': '#clientsBox .clientcard-note',
      '值行说明': '#clientsBox .valuerow-h',
      '时间戳': '#clientsStamp',
    };
    return Object.entries(sel).map(([k, s]) => {
      const el = document.querySelector(s);
      if (!el) return { k, ratio: null };
      const m = window.__AUDIT.ratioOf(el);
      return { k, ratio: m ? Number(m.ratio.toFixed(2)) : null };
    });
  })()`);
  for (const r of rows) {
    if (r.ratio === null) { fail(`[${theme}] 找不到元素「${r.k}」`); continue; }
    if (r.ratio >= 4.5) pass(`[${theme}] ${r.k} 对比度 ${r.ratio}:1`);
    else fail(`[${theme}] ${r.k} 对比度仅 ${r.ratio}:1，低于 WCAG AA 的 4.5:1`);
  }
}
await q(cdp, `document.documentElement.setAttribute('data-theme','light')`);

// 代码块头只在有代码块的页签里（先选后展开），单独量
await selectClient('opencode');
for (const theme of ['light', 'dark']) {
  await q(cdp, `document.documentElement.setAttribute('data-theme','${theme}')`);
  await sleep(120);
  const m = await q(cdp, `(() => {
    const el = document.querySelector('#clientsBox .codeblock-head');
    if (!el) return null;
    const r = window.__AUDIT.ratioOf(el);
    return r ? Number(r.ratio.toFixed(2)) : null;
  })()`);
  if (m === null) fail(`[${theme}] 找不到代码块头`);
  else if (m >= 4.5) pass(`[${theme}] 代码块头 对比度 ${m}:1`);
  else fail(`[${theme}] 代码块头 对比度仅 ${m}:1，低于 WCAG AA 的 4.5:1`);
}
await q(cdp, `document.documentElement.setAttribute('data-theme','light')`);

// ── 7. 多视口横向溢出扫描 ───────────────────────────────────────────────
for (const w of [320, 390, 768, 1024, 1440]) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: 900, deviceScaleFactor: 1, mobile: w < 768 });
  await sleep(200);
  const ov = await q(cdp, `(() => {
    const box = document.getElementById('clientsBox');
    const de = document.documentElement;
    const bad = [...box.querySelectorAll('*')].filter(el => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.right > de.clientWidth + 1;
    }).slice(0, 3).map(el => el.className || el.tagName);
    // 配置片段不该需要横向滚动：窄屏上没有「横着滚一下」这个习惯，
    // 用户会以为内容被截断了（而这些片段本来就是整段复制走的，换行不影响用途）
    const scrollers = [...box.querySelectorAll('pre')].filter(p => p.scrollWidth > p.clientWidth + 1).length;
    return { doc: de.scrollWidth - de.clientWidth, bad, scrollers };
  })()`);
  if (ov.doc <= 1 && ov.bad.length === 0 && ov.scrollers === 0) pass(`视口 ${w}px 无横向溢出，配置片段无需横向滚动`);
  else fail(`视口 ${w}px：doc=${ov.doc}px 溢出元素=${JSON.stringify(ov.bad)} 需横向滚动的代码块=${ov.scrollers}`);
}
await cdp.send('Emulation.clearDeviceMetricsOverride');

// ── 8. 深色模式渲染不报错 ───────────────────────────────────────────────
await q(cdp, `document.documentElement.setAttribute('data-theme','dark')`);
await sleep(200);
const darkOk = await q(cdp, `(() => {
  const v = document.querySelector('#clientsBox .valuerow-v');
  const cs = getComputedStyle(v);
  return { color: cs.color, bg: cs.backgroundColor };
})()`);
if (darkOk && darkOk.color && darkOk.bg) pass(`深色模式样式可解析（color=${darkOk.color}）`);
else fail('深色模式样式异常');

cleanup();
console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
