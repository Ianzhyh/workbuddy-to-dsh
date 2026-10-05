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
const CLIENTS = {
  running: true,
  host: '127.0.0.1',
  port: 8790,
  baseUrlOpenAI: 'http://127.0.0.1:8790/v1',
  baseUrlAnthropic: 'http://127.0.0.1:8790',
  token: 'test-token-123',
  anthropicModel: 'glm-5.3',
  anthropicFastModel: 'glm-5.3-flash',
  models: ['glm-5.3', 'deepseek-v4.1-flash', 'deepseek-v4-pro'],
  modelDetails: [
    { id: 'glm-5.3', name: 'GLM-5.3', context: 1000000, maxOutput: 64000, supportsReasoning: true, supportsImages: true },
    { id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash', context: 1000000, maxOutput: 128000, supportsReasoning: true, supportsImages: true },
    { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', context: 1000000, maxOutput: 128000, supportsReasoning: true, supportsImages: true },
  ],
};

const FIX = { bridge: { running: true, ok: true, host: '127.0.0.1', port: 8790, endpoint: 'http://127.0.0.1:8790/v1', pid: 1, startedAt: new Date().toISOString(), uptimeMs: 1000, catalogSize: 3, catalogAt: new Date().toISOString(), error: null } };

const routes = {
  '/api/clients': { body: CLIENTS },
  '/api/models': { body: { models: [] } },
  '/api/overview': {
    body: () => ({
      bridge: window.__FIX.bridge,
      credentials: { active: { account: '330000000000', userId: '330000000000', remainingMs: 40 * 86400000, expiresAt: Date.now() + 40 * 86400000 }, error: '' },
      quota: { total: 10, packages: [] },
      dsh: { routeLive: true, hasBridgeKey: true, bundlesOk: true, bundles: [], registeredModels: [] },
      console: { version: '1.0.0', node: 'v22' },
    }),
  },
  '/api/probe-results': { body: { updatedAt: null, results: {}, lastRun: null } },
  '/api/diagnose': { body: { items: [] } },
  '/api/usage': { body: { usage: null } },
  '/api/requests': { body: { requests: [] } },
  '/api/accounts': { body: { accounts: [] } },
  '/api/checkin': { body: { status: { active: true, todayCheckedIn: true, todayCredit: 0, streakDays: 0 } } },
  '/api/bridge/log': { body: { lines: [] } },
};

const INJECT = `window.__FIX = ${JSON.stringify(FIX)};`;

const server = await startStaticServer(PORT);
const { cdp, close } = await openPage(URL_, routes, { inject: INJECT });
const cleanup = () => { try { cdp.close(); } catch { /* 忽略 */ } try { server.close(); } catch { /* 忽略 */ } };
process.on('exit', cleanup);

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
const cards = await q(cdp, `[...document.querySelectorAll('#clientsBox .clientcard')].map(c => ({
  name: c.querySelector('.clientcard-head b')?.textContent || '',
  tag: c.querySelector('.clientcard-head .tag')?.textContent || '',
  code: [...c.querySelectorAll('.codeblock pre')].map(p => p.textContent).join('\\n'),
}))`);
const opencode = cards.find((c) => c.name === 'opencode');
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

// ── 4. Claude Code 片段 ─────────────────────────────────────────────────
const cc = cards.find((c) => c.name === 'Claude Code');
if (cc) {
  pass(`Claude Code 卡片存在（状态「${cc.tag}」）`);
  if (cc.code.includes('ANTHROPIC_BASE_URL=' + CLIENTS.baseUrlAnthropic)) pass('Claude Code 片段含正确 ANTHROPIC_BASE_URL');
  else fail('Claude Code 片段 ANTHROPIC_BASE_URL 不正确');
  if (cc.code.includes(CLIENTS.token)) pass('Claude Code 片段含真实令牌');
  else fail('Claude Code 片段未用真实令牌');
} else fail('缺少 Claude Code 卡片');

// ── 5. 图形表单：逐格可复制 ─────────────────────────────────────────────
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

const groupCount = await q(cdp, `document.querySelectorAll('#clientsBox .formguide .fggroup').length`);
eq(groupCount, CLIENTS.modelDetails.length + 1, '字段分组数（提供商级 + 每个模型一组）');

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
eq(modelRows.length, CLIENTS.models.length, '模型行数（应与桥返回的模型数一致）');

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
const tags = await q(cdp, `[...document.querySelectorAll('#clientsBox .clientcard-head .tag')].map(e => e.textContent)`);
if (tags.includes('已实测')) pass('存在「已实测」档'); else fail('缺少「已实测」档');
if (tags.includes('不支持')) pass('存在「不支持」档'); else fail('缺少「不支持」档');

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
const copyBtns = await q(cdp, `document.querySelectorAll('#clientsBox .codeblock-head button').length`);
if (copyBtns >= 2) pass(`代码块复制按钮 ${copyBtns} 个`); else fail('复制按钮缺失');

// 复制按钮必须真的能跑通（点击后不抛错）
const clickOk = await q(cdp, `(() => {
  const b = document.querySelector('#clientsBox .codeblock-head button');
  try { b.click(); return true; } catch (e) { return 'ERR: ' + e.message; }
})()`);
eq(clickOk, true, '点击复制按钮不抛错');

// ── 7. 多视口横向溢出扫描 ───────────────────────────────────────────────
for (const w of [1440, 1024, 768, 390]) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(200);
  const ov = await q(cdp, `(() => {
    const box = document.getElementById('clientsBox');
    const de = document.documentElement;
    const bad = [...box.querySelectorAll('*')].filter(el => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.right > de.clientWidth + 1;
    }).slice(0, 3).map(el => el.className || el.tagName);
    return { doc: de.scrollWidth - de.clientWidth, bad };
  })()`);
  if (ov.doc <= 1 && ov.bad.length === 0) pass(`视口 ${w}px 无横向溢出`);
  else fail(`视口 ${w}px 溢出：doc=${ov.doc}px 元素=${JSON.stringify(ov.bad)}`);
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
