/**
 * 控制台 i18n（中 / 英）验收。
 *
 *   node tools/dev/test-i18n.mjs
 *
 * 覆盖：
 *   - 默认中文；点「EN」后外壳 / 面板标题 / 表头 / 按钮 / 选项 / 空态变英文
 *   - 语言选择持久化（重载后仍是英文）
 *   - 切回中文能**精确还原**（含规则生成的动态串，靠 __i18nSrc）
 *   - 数据区不被翻译（对话正文 / 桥日志）
 *   - 残留中文清单（**不判失败**，只打印，供增量补词条）
 *   - 无运行时报错；多视口无横向溢出
 *
 * 不启真控制台、不消耗上游额度：只起静态服务 + 无头 Chromium，把 /api/* 全打桩。
 */
import { startStaticServer, openPage, waitFor, q, sleep } from './ui-harness.mjs';
import { baseRoutes, CATALOG } from './fixtures.mjs';

const PORT = 8791;
const PAGE = `http://127.0.0.1:${PORT}/`;

let failures = 0;
const fail = (m) => { console.error('✗ ' + m); failures += 1; };
const pass = (m) => console.log('✓ ' + m);

/** 收集「可见中文文本节点」——排除 skip 子树与数据标签。 */
const COLLECT_ZH = `(() => {
  const SKIP = new Set(['SCRIPT', 'STYLE', 'TEXTAREA']);
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      const p = n.parentElement;
      if (!p || SKIP.has(p.tagName) || p.closest('[data-i18n-skip]')) return NodeFilter.FILTER_REJECT;
      return /[\\u4e00-\\u9fff]/.test(n.data) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  const out = [];
  let n;
  while ((n = w.nextNode())) {
    const t = n.data.replace(/\\s+/g, ' ').trim();
    if (t) out.push(p2(n) + ' | ' + t);
  }
  // **属性里的文案**（title 提示 / placeholder …）用户也看得见（悬停就能看到），
  // 而 TreeWalker 只看文本节点 —— 这是一条能整片漏掉的通道。
  // 体检结果的「测得时间（2 天前）」、成本列的完整口径说明都在 title 里。
  for (const el of document.querySelectorAll('[title],[placeholder],[aria-label],[alt],[data-prompt]')) {
    if (el.closest('[data-i18n-skip]')) continue;
    for (const a of ['title', 'placeholder', 'aria-label', 'alt', 'data-prompt']) {
      const v = el.getAttribute(a);
      if (v && /[\\u4e00-\\u9fff]/.test(v)) {
        out.push('@' + a + (el.id ? '#' + el.id : '') + ' | ' + v.replace(/\\s+/g, ' ').trim());
      }
    }
  }
  // 标了「可翻」的预填 value 也要扫 —— 它不是文本节点，光走 TreeWalker 会漏掉。
  // 但**用户自己改过的输入框不算界面文案**：本脚本会往 promptInput 里打字来验
  // 「对话正文不被翻译」，那段中文是测试的输入，不是产品残留。
  // 判据用页面自己的记账（__i18nAttr.__valueOut）：值仍等于它写进去的那个 → 界面文案。
  for (const el of document.querySelectorAll('[data-i18n-value]')) {
    const st = el.__i18nAttr;
    if (st && st.__valueOut !== undefined && el.value !== st.__valueOut) continue;
    const v = String(el.value || '').trim();
    if (/[\\u4e00-\\u9fff]/.test(v)) out.push('value' + (el.id ? '#' + el.id : '') + ' | ' + v);
  }
  function p2(node) {
    const p = node.parentElement;
    return p.tagName.toLowerCase() + (p.id ? '#' + p.id : '') + (p.className ? '.' + String(p.className).split(' ')[0] : '');
  }
  return [...new Set(out)];
})()`;

const text = (cdp, sel) => q(cdp, `(document.querySelector(${JSON.stringify(sel)})||{}).textContent || ''`);

const server = await startStaticServer(PORT);
/*
 * 桩数据要**故意「脏」**。
 *
 * `baseRoutes()` 的默认值里：dsh 已就绪 → 「桥已就绪」提示条被隐藏；模型没有
 * 促销标签；体检结果是空的 → 表头时间线与每行的结果标签整块不渲染。
 * 而这几处恰恰是历史上漏翻的地方 —— 桩太干净，扫描扫到 0 个中文，
 * 断言就变成"假绿"，直到用户拿真实界面截图打脸。
 *
 * 所以这里显式把三个分支都打开，让它们进入扫描范围。
 */
const routes = baseRoutes({
  dshReady: false, // 让「桥已就绪。下一步：…」提示条渲染出来
  catalog: CATALOG.map((m, i) => (
    i === 1 ? { ...m, badge: '限时免费' }
      : i === 2 ? { ...m, badge: '夜间免费' }
        // 这两个是用户实拍才发现的（上游换促销词就会多一个，集合不封闭）
        : i === 3 ? { ...m, badge: '错峰使用' }
          : i === 4 ? { ...m, badge: '限时折扣' } : m
  )),
});
const { cdp, close } = await openPage(PAGE, routes, {
  width: 1440,
  height: 1000,
  inject: `window.__ERRORS = []; window.addEventListener('error', (e) => window.__ERRORS.push(String(e.message)));`,
});

try {
  await waitFor(cdp, `document.querySelectorAll('#modelTable tbody tr').length > 0`, 15000, '模型表渲染');
  await sleep(400);

  // ── 1. 默认中文 ────────────────────────────────────────────────────────
  if ((await q(cdp, `document.documentElement.lang`)) === 'zh-CN') pass('默认 <html lang> = zh-CN');
  else fail('默认 lang 不是 zh-CN');

  const navBefore = await text(cdp, '.nav-tab[data-tab="overview"]');
  if (navBefore.includes('概览与用量')) pass('默认导航为中文');
  else fail('默认导航不是中文：' + navBefore);

  const zhNodesBefore = (await q(cdp, COLLECT_ZH)).length;
  if (zhNodesBefore > 40) pass(`默认中文文本节点 ${zhNodesBefore} 个（合理）`);
  else fail(`默认中文文本节点只有 ${zhNodesBefore} 个，页面可能没渲染`);

  // ── 2. 切到英文 ────────────────────────────────────────────────────────
  await q(cdp, `document.getElementById('langToggle').click()`);
  await sleep(500);

  const checks = [
    ['<html lang>', `document.documentElement.lang`, 'en'],
    ['导航「概览与用量」', null, 'Overview & usage'],
    ['面板标题「账号」', null, 'Account'],
    ['动作按钮「启动桥服务」', null, 'Start bridge'],
    ['表头「显示名」', null, 'Display name'],
  ];
  if ((await q(cdp, checks[0][1])) === 'en') pass('<html lang> 切到 en');
  else fail('<html lang> 没切到 en');

  const navAfter = await text(cdp, '.nav-tab[data-tab="overview"]');
  if (navAfter.trim() === 'Overview & usage') pass('导航变英文');
  else fail('导航未变英文：' + navAfter);

  const startBtn = await text(cdp, '#startBtn');
  if (startBtn.includes('Start bridge')) pass('动作按钮变英文');
  else fail('动作按钮未变英文：' + startBtn);

  const bodyHtml = await q(cdp, `document.querySelector('#modelWrap').innerHTML`);
  if (bodyHtml.includes('Display name') && bodyHtml.includes('Max output')) pass('模型表表头变英文');
  else fail('模型表表头未变英文');

  const langBtn = await text(cdp, '#langToggleText');
  if (langBtn.trim() === '中') pass('语言按钮显示「中」（表示可切回中文）');
  else fail('语言按钮文案不对：' + langBtn);

  const title = await q(cdp, `document.title`);
  if (!/[\u4e00-\u9fff]/.test(title)) pass('标签页标题变英文：' + title);
  else fail('标签页标题仍是中文：' + title);

  // 规则层：体检范围提示是拼接出来的（`只测「勾选的（12）」；…`），且内层还要再翻一次
  await q(cdp, `(() => { const s = document.getElementById('probeScope'); s.value = 'all'; s.dispatchEvent(new Event('change')); })()`);
  await sleep(300);
  const scopeTitle = await q(cdp, `document.getElementById('probeAllBtn').title`);
  if (!/[\u4e00-\u9fff]/.test(scopeTitle) && /probing/i.test(scopeTitle)) {
    pass('规则层生效（拼接提示已英文化）：' + scopeTitle);
  } else fail('规则层未生效：' + scopeTitle);

  // 规则层：面板时间戳「更新于 HH:MM:SS」
  const stamp = await text(cdp, '#overviewStamp');
  if (/^Updated \d{2}:\d{2}:\d{2}$/.test(stamp.trim())) pass('规则层生效（时间戳）：' + stamp.trim());
  else fail('时间戳未英文化：' + stamp);

  // ── 2b. 四处「拼出来的 / 来自数据的」文案（历史上都漏过） ──────────────
  // (a) 概览页提示条：`<b>` + 两个文本节点拼成，最容易只翻前半句
  const nextStep = await q(cdp, `(document.getElementById('nextStepBar')||{}).textContent || ''`);
  if (!nextStep.trim()) fail('桥就绪提示条没渲染，扫描没覆盖到');
  else if (!/[\u4e00-\u9fff]/.test(nextStep)) pass('提示条已英文化：' + nextStep.trim().slice(0, 56) + '…');
  else fail('提示条仍是中文：' + nextStep.trim());

  // (b) 上游促销标签（中文业务文案，直接来自数据）
  const promo = await q(cdp, `[...document.querySelectorAll('#modelTable .tag.promo')].map((e) => e.textContent).join(' | ')`);
  if (promo && !/[\u4e00-\u9fff]/.test(promo)) pass('促销标签已英文化：' + promo);
  else fail('促销标签没渲染或仍是中文：' + promo);

  // (c) 体检结果标签：`可用 1551ms · 扣 0` / `不可用`
  const probeTags = await q(cdp, `[...document.querySelectorAll('#modelTable td[data-probe] .tag')].map((e) => e.textContent).join(' | ')`);
  if (probeTags && !/[\u4e00-\u9fff]/.test(probeTags)) pass('体检结果标签已英文化：' + probeTags);
  else fail('体检结果标签没渲染或仍是中文：' + probeTags);

  // (d) 表头时间线：`上次体检 2 天前 · 可用 2 / 3`（三段拼成，捕获组要各自再翻）
  const probeStamp = await text(cdp, '#probeStamp');
  if (!probeStamp.trim()) fail('体检时间线没渲染，扫描没覆盖到');
  else if (!/[\u4e00-\u9fff]/.test(probeStamp)) pass('体检时间线已英文化：' + probeStamp.trim());
  else fail('体检时间线仍是中文：' + probeStamp);

  // (e) 「实测成本」列：`0.0028 / 千 token（7 次）` —— 用户截图里点名的那一处。
  //     规则 `^(.+) \/ 千 token（(\d+) 次）$` 必须**排在通用规则之前**才轮得到
  //     （整串以「次」结尾，会被 `^(.+) 次$` 抢走）。这条断言就是钉住那个顺序。
  const costCells = await q(cdp, `[...document.querySelectorAll('#modelTable td')]
    .map((e) => e.textContent.trim()).filter((t) => /token/i.test(t)).join(' | ')`);
  if (/1k tokens/.test(costCells) && !/[\u4e00-\u9fff]/.test(costCells)) {
    pass('实测成本列已英文化：' + costCells.slice(0, 90));
  } else fail('实测成本列没英文化：' + costCells);

  // ── 3. 数据区不被翻译 ──────────────────────────────────────────────────
  await q(cdp, `(() => { document.getElementById('promptInput').value = '你好世界'; document.getElementById('sendBtn').click(); })()`);
  await sleep(300);
  const chatBody = await q(cdp, `(document.querySelector('.turn-body')||{}).textContent || ''`);
  if (chatBody.includes('你好世界')) pass('对话正文未被翻译（data-i18n-skip 生效）');
  else fail('对话正文被翻译了：' + chatBody);

  // ── 4. 残留中文清单（不判失败，供补词条） ──────────────────────────────
  const dump = async (label) => {
    const left = await q(cdp, COLLECT_ZH);
    console.log(`\n—— ${label}：仍为中文的文本节点 ${left.length} 个 ——`);
    for (const l of left) console.log('   ' + l);
    return left;
  };
  // ── 4c. 复制到剪贴板的文本（不进 DOM，最容易漏） ────────────────────────
  for (const [name, expr] of [
    ['接入信息（复制全部）', `translateMultiline(clientsCheatSheet(lastClients || {}))`],
    ['诊断报告（复制诊断报告）', `translateMultiline(buildDiagReport())`],
  ]) {
    const txt = await q(cdp, expr);
    const zh = String(txt).split('\n').filter((l) => /[\u4e00-\u9fff]/.test(l));
    if (zh.length === 0) pass(`${name}：复制内容无残留中文（${String(txt).split('\n').length} 行）`);
    else fail(`${name}：仍有 ${zh.length} 行中文 → ${zh.slice(0, 4).join(' / ')}`);
  }

  const left1 = await dump('英文模式 / 默认界面');
  if (left1.length === 0) pass('默认界面无残留中文');
  else fail(`默认界面仍有 ${left1.length} 个中文文本节点（见上）`);

  // ── 4b. 展开更多界面再扫一遍 ───────────────────────────────────────────
  // 默认状态没覆盖到的：对话用量摘要、在途请求区块、模型详情弹层、桥日志。
  const sse = (o) => `data: ${JSON.stringify(o)}\n\n`;
  await q(cdp, `window.__setRoute('/api/chat', { type: 'text/event-stream', chunks: [
    { text: ${JSON.stringify(sse({ choices: [{ index: 0, delta: { content: 'hello' } }] }))} },
    { text: ${JSON.stringify(sse({ choices: [{ index: 0, delta: {} }], usage: { prompt_tokens: 12, completion_tokens: 7, credit: 0.02 } }))} },
    { text: 'data: [DONE]\\n\\n' },
  ] })`);
  await q(cdp, `window.__setRoute('/api/requests', { body: {
    requests: [
      { t: Date.now() - 20000, model: 'glm-5.3', stream: true, ok: true, ms: 1180, promptTokens: 820, completionTokens: 240, credit: 0.03 },
      { t: Date.now() - 60000, model: 'glm-5.3', stream: false, ok: false, ms: 2400, status: 400, code: 11101, error: '{"msg":"Non-stream chat request is currently not supported"}' },
    ],
    active: [{ id: 'r1', model: 'glm-5.3', stream: true, startedAt: Date.now() - 900000, runningMs: 900000 }],
    activeAlertMs: 300000,
  } })`);
  await q(cdp, `window.__setRoute('/api/bridge/log', { body: { lines: [
    '[2026-10-08T05:00:00.000Z] bridge listening on 127.0.0.1:8790',
    '[2026-10-08T05:00:01.000Z] auto checkin ok 100',
  ] } })`);
  await q(cdp, `document.getElementById('refreshBtn').click()`);
  await sleep(600);
  await q(cdp, `(() => { document.getElementById('promptInput').value = 'hi'; document.getElementById('sendBtn').click(); })()`);
  await sleep(700);
  await q(cdp, `(() => { const b = document.querySelector('#modelTable button.infobtn'); if (b) b.click(); })()`);
  await sleep(300);
  // 断言详情弹层真的开了 —— 否则下面的「无残留中文」是假绿
  const detailOpen = await q(cdp, `document.querySelectorAll('#modelTable tr.detail-row').length`);
  if (detailOpen > 0) pass('模型详情弹层已打开（纳入扫描）');
  else fail('模型详情弹层没打开，扫描没覆盖到');

  await q(cdp, `(() => { document.getElementById('logDrawer').open = true;
    document.querySelectorAll('#clientsBox details').forEach((d) => { d.open = true; }); })()`);
  await sleep(500);
  // 「复制全部」的接入信息块也要纳入（它是给用户照抄的长文）
  const sheetVisible = await q(cdp, `document.querySelectorAll('#clientsBox pre, #clientsBox .cheatsheet, #clientsBox details').length`);
  if (sheetVisible > 0) pass(`客户端接入面板展开 ${sheetVisible} 个块（纳入扫描）`);
  else fail('客户端接入面板没有可展开的块，扫描没覆盖到');
  const left2 = await dump('英文模式 / 展开在途请求 + 对话用量 + 模型详情 + 日志抽屉');

  const leftovers = left2.length;
  if (leftovers === 0) pass('展开后的界面无残留中文');
  else fail(`展开后仍有 ${leftovers} 个中文文本节点（见上）`);

  // ── 5. 切回中文精确还原 ────────────────────────────────────────────────
  await q(cdp, `document.getElementById('langToggle').click()`);
  await sleep(500);
  const navBack = await text(cdp, '.nav-tab[data-tab="overview"]');
  if (navBack.trim() === '概览与用量') pass('切回中文：导航还原');
  else fail('切回中文失败：' + navBack);
  const zhNodesAfter = (await q(cdp, COLLECT_ZH)).length;
  if (zhNodesAfter >= zhNodesBefore - 2) pass(`切回中文后中文节点 ${zhNodesAfter} 个（还原到基线 ${zhNodesBefore}）`);
  else fail(`切回中文后只剩 ${zhNodesAfter} 个中文节点，还原不完整（基线 ${zhNodesBefore}）`);

  // ── 6. 持久化 ──────────────────────────────────────────────────────────
  await q(cdp, `document.getElementById('langToggle').click()`); // 再切英文
  await sleep(300);
  await cdp.send('Page.reload', { ignoreCache: false });
  await waitFor(cdp, `document.querySelectorAll('#modelTable tbody tr').length > 0`, 15000, '重载后模型表');
  await sleep(500);
  if ((await q(cdp, `document.documentElement.lang`)) === 'en') pass('重载后仍是英文（localStorage 持久化）');
  else fail('重载后语言没保持');
  await q(cdp, `document.getElementById('langToggle').click()`); // 还原成中文，避免影响后续截图
  await sleep(300);

  // ── 7. 多视口无横向溢出 ────────────────────────────────────────────────
  for (const w of [1440, 1024, 768, 390]) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: 900, deviceScaleFactor: 1, mobile: false });
    await sleep(250);
    await q(cdp, `document.getElementById('langToggle').click()`); // 英文下量
    await sleep(350);
    const over = await q(cdp, `document.documentElement.scrollWidth - document.documentElement.clientWidth`);
    if (over <= 2) pass(`视口 ${w}px 无横向溢出`);
    else fail(`视口 ${w}px 横向溢出 ${over}px`);
    await q(cdp, `document.getElementById('langToggle').click()`);
    await sleep(200);
  }

  // ── 8. 运行时报错 ──────────────────────────────────────────────────────
  const errs = await q(cdp, `window.__ERRORS || []`);
  if (!errs.length) pass('无运行时报错');
  else fail('运行时报错：' + errs.join(' | '));
} finally {
  await close();
  server.close();
}

console.log(`\n${failures ? '✗ 失败 ' + failures + ' 项' : '✓ 全部通过'}`);
process.exit(failures ? 1 : 0);
