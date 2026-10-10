/**
 * 「一键接入」面板验收：**读取失败要说话，已接入要能验证**。
 *
 *   node tools/dev/test-connect-panel.mjs
 *
 * 覆盖两条真实踩过的坑（都不是"渲染得不好看"，而是"界面在说假话"）：
 *
 *   1. **读不到状态却一直显示「正在读取接入状态…」。** 控制台进程还在跑改动前的
 *      旧代码时，`/api/connect` 回 404；前端原来把失败吞掉（`lastConnect = null`），
 *      于是面板永远停在占位态 —— 用户看到的是一个转不完的圈，也没有任何重试入口。
 *      实测证据：控制台进程 08:55 启动、路由 22:28 才加，用户截图里就是这块。
 *   2. **「已接入」只是一个 manifest 文件的存在性。** 配置里写的是不是**当前**的
 *      桥地址与令牌，写进去的令牌现在还能不能连上桥 —— 服务端早就有
 *      `/api/connect/verify`（静态读回 + 端到端），命令行 `npm run connect verify`
 *      也在用，但控制台里没有任何按钮能触发它。半成品就半在这里。
 *
 * 不启真控制台、不消耗上游额度：静态服务 + 无头 Chromium，`/api/*` 全打桩。
 */
import { startStaticServer, openPage, waitFor, q, sleep } from './ui-harness.mjs';
import { baseRoutes, connectFixture } from './fixtures.mjs';

const PORT = 8801;
const URL_ = `http://127.0.0.1:${PORT}/`;

let failures = 0;
const fail = (m) => { console.error('✗ ' + m); failures += 1; };
const pass = (m) => console.log('✓ ' + m);
const eq = (actual, expected, label) => {
  if (actual === expected) pass(`${label} = ${JSON.stringify(actual)}`);
  else fail(`${label} 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
};

/** 扫描一个子树里的可见中文（含 title / aria-label 这类用户看得到的属性）。 */
const ZH_IN = (sel) => `(() => {
  const root = document.querySelector(${JSON.stringify(sel)});
  if (!root) return ['（找不到 ' + ${JSON.stringify(sel)} + '）'];
  const out = [];
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      const p = n.parentElement;
      if (!p || p.closest('[data-i18n-skip]')) return NodeFilter.FILTER_REJECT;
      return /[\\u4e00-\\u9fff]/.test(n.data) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  let n;
  while ((n = w.nextNode())) { const t = n.data.replace(/\\s+/g, ' ').trim(); if (t) out.push(t); }
  for (const el of root.querySelectorAll('[title],[aria-label],[placeholder]')) {
    if (el.closest('[data-i18n-skip]')) continue;
    for (const a of ['title', 'aria-label', 'placeholder']) {
      const v = el.getAttribute(a);
      if (v && /[\\u4e00-\\u9fff]/.test(v)) out.push('@' + a + ' | ' + v.replace(/\\s+/g, ' ').trim());
    }
  }
  return [...new Set(out)];
})()`;

/**
 * 三个客户端刻意覆盖三种状态（而不是清一色的"未接入"）：
 *   - codex  已接入且配置与当前值一致 → 绿色的「已接入」；
 *   - claude 已接入但**配置已变**（比如桥换过令牌）→ 必须提示"需重新写入"，
 *            不能继续挂绿色的「已接入」；
 *   - opencode 装了但没接入 → 中性标签，且不该出现「验证接入」。
 */
const CLIENTS = [
  {
    id: 'codex', label: 'Codex', e2e: true, installed: true, exists: true,
    path: 'C:\\Users\\you\\.codex\\config.toml',
    changed: false, applied: true, appliedAt: '2026-10-09T14:00:00.000Z', reformats: false,
    changes: [], preview: 'model_provider = "workbuddy"\n',
    pathSource: { source: 'client', envName: 'CODEX_HOME' },
    effectiveModel: 'deepseek-v4.1-flash',
    effectiveModels: ['deepseek-v4.1-flash', 'glm-5.3'],
    models: ['deepseek-v4.1-flash', 'glm-5.3'],
    /**
     * Codex 的 profile 通道（零写入接入）。它**不是第四行**，而是挂在 Codex 这一行
     * 详情里的一个可选项 —— 与"改基础配置"是同一个决策的两个选项。
     */
    profile: {
      id: 'codex-profile', label: 'Codex · profile',
      path: 'C:\\Users\\you\\.codex\\workbuddy.config.toml',
      exists: false, applied: false, changed: true, canSwitchBack: false,
      error: null, catalogSkipped: null,
      launch: 'codex -p workbuddy', appSupported: false,
    },
    catalog: {
      path: 'C:\\Users\\you\\.codex\\workbuddy-model-catalog.json',
      name: 'workbuddy-model-catalog.json',
      added: ['kimi-k3'],
      kept: 2,
      from: 'C:\\Users\\you\\.codex\\cc-switch-model-catalog.json',
    },
    catalogSkipped: null,
  },
  {
    id: 'claude', label: 'Claude Code', e2e: false, installed: true, exists: true,
    path: 'C:\\Users\\you\\.claude\\settings.json',
    changed: true, applied: true, appliedAt: '2026-10-08T09:00:00.000Z', reformats: false,
    changes: [
      { path: 'env.ANTHROPIC_API_KEY', kind: 'value', from: 'stale-token', to: 'stub-token-not-a-real-value-9f3a2b1c' },
    ],
    preview: '{}\n',
    effectiveModel: 'glm-5.3',
    effectiveModels: ['glm-5.3'],
    models: ['glm-5.3'],
    catalog: null,
    catalogSkipped: null,
  },
  {
    id: 'opencode', label: 'opencode', e2e: false, installed: true, exists: false,
    path: 'C:\\Users\\you\\.config\\opencode\\opencode.json',
    changed: true, applied: false, appliedAt: null, reformats: false,
    changes: [{ path: 'provider.workbuddy', kind: 'value', from: null, to: '{…}' }],
    preview: '{}\n',
    effectiveModel: 'deepseek-v4.1-flash',
    effectiveModels: ['deepseek-v4.1-flash', 'glm-5.3'],
    models: ['deepseek-v4.1-flash', 'glm-5.3'],
    catalog: null,
    catalogSkipped: null,
  },
];

/**
 * 目录给足 20 个（真实环境是 30 个）。
 *
 * 为什么不能只给 2 个：模型清单是**可滚动的固定高度窗口**，候选太少时它不会滚动，
 * 「搜索」也没有东西可过滤 —— 这两条断言就会变成假绿（第一版就是这么写的，
 * 结果"清单可滚动"和"搜索过滤"两条根本验不到东西）。
 *
 * 第 5 个是**只在展示名里**含 "kimi" 的：用来钉住"搜索同时匹配 id 与展示名"，
 * 只按 id 过滤的话它会漏掉，而用户是按展示名找模型的。
 */
const MODEL_OPTIONS = [
  'deepseek-v4.1-flash', 'glm-5.3', 'kimi-k3-1', 'glm-5.2', 'gg-5.1', 'kimi-k2.8-preview',
  'deepseek-v4-flash', 'hunyuan-chat', 'minimax-m3', 'kimi-k2.7', 'glm-5.3-flash', 'space-bunny',
  'hy3', 'hy4-preview', 'glm-5v-turbo', 'default', 'kimi-k2.5', 'minimax-m2.5', 'kimi-k2.6', 'glm-5.0',
].map((id) => ({
  id,
  name: id === 'gg-5.1' ? 'Kimi K3.9 特别版' : id.replace(/-/g, ' ').toUpperCase(),
}));

const CONNECT = {
  ...connectFixture({ clients: CLIENTS }),
  modelOptions: MODEL_OPTIONS,
  bridge: { up: true, authRejected: false },
};

const VERIFY_OK = { ok: true, written: { ok: true }, auth: { ok: true, models: 5 } };

const routes = baseRoutes({ clients: CLIENTS });
routes['/api/connect'] = { body: CONNECT };
routes['/api/connect/verify'] = { body: VERIFY_OK };

const server = await startStaticServer(PORT);

/**
 * 记录**完整请求 URL**（含查询串）。
 *
 * 打桩骨架里的 `window.__calls` 只记路径（把 `?…` 切掉了），而「勾了几个模型」
 * 恰恰只在查询串里 —— 没有这个包装就断言不到"取消勾选真的发给了服务端"。
 * 打桩脚本先注册、这段后注册，所以包住的是打桩后的 fetch。
 */
const URL_RECORDER = `window.__urls = [];
  (() => { const orig = window.fetch; window.fetch = (input, init) => {
    window.__urls.push(typeof input === 'string' ? input : (input && input.url) || '');
    return orig(input, init);
  }; })();`;

// ── 第一段：正常读到状态 ─────────────────────────────────────────────────
const { cdp, close } = await openPage(URL_, routes, { width: 1440, height: 1000, cdpPort: 9335, inject: URL_RECORDER });

const rowsOf = () => q(cdp, `[...document.querySelectorAll('#clientsBox .connectrow')].map((r) => ({
  label: (r.querySelector('.connectmeta b') || {}).textContent || '',
  tags: [...r.querySelectorAll('.connectmeta .tag')].map((t) => t.textContent.trim()),
  buttons: [...r.querySelectorAll('.connectacts button')].map((b) => b.textContent.trim()),
  results: [...r.querySelectorAll('.connectresult div')].map((d) => d.textContent.trim()),
}))`);

try {
  await waitFor(cdp, `document.querySelectorAll('#clientsBox .connectrow').length === 3`, 10000, '一键接入三行');
  const rows = await rowsOf();
  const byLabel = Object.fromEntries(rows.map((r) => [r.label, r]));

  // ── 1. 状态必须三种都不一样，且都不是假的 ─────────────────────────────
  if ((byLabel['Codex'] || {}).tags?.includes('已接入')) pass('Codex：已接入且配置一致 → 显示「已接入」');
  else fail(`Codex 状态不对：${JSON.stringify((byLabel['Codex'] || {}).tags)}`);

  const claudeTags = (byLabel['Claude Code'] || {}).tags || [];
  if (claudeTags.some((t) => t.includes('需重新写入'))) pass('Claude Code：已接入但配置已变 → 提示「需重新写入」');
  else fail(`Claude Code 配置已变却没提示重新写入：${JSON.stringify(claudeTags)}`);

  const opencodeTags = (byLabel['opencode'] || {}).tags || [];
  if (opencodeTags.includes('已安装，尚未接入')) pass('opencode：已安装未接入 → 中性状态');
  else fail(`opencode 状态不对：${JSON.stringify(opencodeTags)}`);

  // ── 2. 「验证接入」在已接入的行**详情里**，没接入的行没有 ───────────────
  /*
   * 它从行内挪进了「详情」：默认态每行只留「写入 + 详情」两个按钮，
   * 三行才排得齐（实测已接入那行原先挂 5 个按钮、比另外两行高一倍多）。
   */
  for (const [label, want] of [['Codex', true], ['Claude Code', true], ['opencode', false]]) {
    await q(cdp, `(() => { const row = [...document.querySelectorAll('#clientsBox .connectrow')]
      .find((r) => (r.querySelector('.connectname') || {}).textContent === ${JSON.stringify(label)});
      const b = [...row.querySelectorAll('.connectacts button')].find((x) => x.textContent.trim() === '详情');
      if (b) b.click(); })()`);
    await sleep(150);
    const btnTexts = await q(cdp, `(() => { const row = [...document.querySelectorAll('#clientsBox .connectrow')]
      .find((r) => (r.querySelector('.connectname') || {}).textContent === ${JSON.stringify(label)});
      return [...row.querySelectorAll('button')].map((b) => b.textContent.trim()); })()`);
    const has = btnTexts.includes('验证接入');
    if (has === want) pass(`${label}：验证接入按钮 ${want ? '在详情里有' : '没有'}（符合预期）`);
    else fail(`${label}：验证接入按钮 ${want ? '应该有' : '不该有'}，实际 ${JSON.stringify(btnTexts)}`);
    await q(cdp, `(() => { const row = [...document.querySelectorAll('#clientsBox .connectrow')]
      .find((r) => (r.querySelector('.connectname') || {}).textContent === ${JSON.stringify(label)});
      const b = [...row.querySelectorAll('.connectacts button')].find((x) => x.textContent.trim() === '收起详情');
      if (b) b.click(); })()`);
    await sleep(120);
  }

  // ── 2b. 紧凑行：状态/名称/路径/操作在**同一行**，模型计数可读 ───────────
  const compact = await q(cdp, `(() => {
    const row = [...document.querySelectorAll('#clientsBox .connectrow')]
      .find((r) => (r.querySelector('.connectname') || {}).textContent === 'Codex');
    const meta = row.querySelector('.connectmeta');
    const acts = row.querySelector('.connectacts');
    const mr = meta.getBoundingClientRect(); const ar = acts.getBoundingClientRect();
    return {
      sameLine: Math.abs(mr.top + mr.height / 2 - (ar.top + ar.height / 2)) < 24,
      /**
       * 只量「客户端信息 + 操作」这一行的高度，**不含**下面的验证结论块 ——
       * 那个是按需出现的附加内容，算进来会把"行高"量成一个没有意义的值
       * （第一版就是这样：113px 里 80px 是验证结论）。
       */
      lineHeight: Math.round(Math.max(mr.height, ar.height)),
      count: (row.querySelector('.connectmcount') || {}).textContent || '',
      hasDetailBtn: [...acts.querySelectorAll('button')].some((b) => b.textContent.trim() === '详情'),
      // 默认态只该有「写入 + 详情」两个按钮：撤销/验证/改动都在详情里
      buttons: [...acts.querySelectorAll('button')].map((b) => b.textContent.trim()),
      rowHeight: Math.round(row.getBoundingClientRect().height),
    };
  })()`);
  if (compact.sameLine && compact.lineHeight <= 36) pass(`客户端行是紧凑一行（信息行高 ${compact.lineHeight}px，操作同排）`);
  else fail(`客户端行不紧凑：${JSON.stringify(compact)}`);
  if (/^2 个模型$/.test(compact.count.trim())) pass(`模型计数显示「${compact.count.trim()}」`);
  else fail(`模型计数不对：${JSON.stringify(compact.count)}`);
  if (compact.hasDetailBtn) pass('有「详情」入口');
  else fail('没有「详情」入口');

  // ── 2b-2. 路径来源要如实标注（别人的机器上可能设了 CODEX_HOME / CLAUDE_CONFIG_DIR）──
  /*
   * 只显示一个最终路径的话，用户没法确认"它认没认对地方" —— 而这正是把配置写进
   * 客户端根本不读的位置的原因。夹具里 Codex 是 `CODEX_HOME` 重定位、另两个是默认。
   */
  const srcInfo = await q(cdp, `(() => {
    const out = {};
    for (const r of document.querySelectorAll('#clientsBox .connectrow')) {
      const name = (r.querySelector('.connectname') || {}).textContent;
      const tag = r.querySelector('.connectpsrc');
      out[name] = tag ? tag.textContent.trim() : null;
    }
    return out;
  })()`);
  if (srcInfo['Codex'] && srcInfo['Codex'].includes('CODEX_HOME')) {
    pass(`Codex 的路径来源如实标注：「${srcInfo['Codex']}」`);
  } else {
    fail(`Codex 的路径来源没标出来：${JSON.stringify(srcInfo['Codex'])}`);
  }
  if (srcInfo['opencode'] === null) pass('默认路径的行不啰嗦（没有多余的来源标注）');
  else fail(`默认路径的行多标了来源：${JSON.stringify(srcInfo['opencode'])}`);
  if (compact.buttons.length === 2
    && (compact.buttons.includes('写入') || compact.buttons.includes('重新写入'))) {
    pass(`默认态每行只有两个按钮：${JSON.stringify(compact.buttons)}`);
  } else {
    fail(`默认态按钮太多/不对：${JSON.stringify(compact.buttons)}`);
  }

  // ── 2b-2. 三行等高：详情里的东西不该把某一行撑高 ───────────────────────
  const heights = await q(cdp, `[...document.querySelectorAll('#clientsBox .connectrow')].map((r) => Math.round(r.getBoundingClientRect().height))`);
  if (Math.max(...heights) - Math.min(...heights) <= 8) {
    pass(`三行等高（${heights.join(' / ')}px）—— 验证结论不再撑高某一行`);
  } else {
    fail(`三行不等高：${JSON.stringify(heights)}`);
  }

  // ── 2c. 多模型：展开详情 → 勾选改变集合 → 请求带上 models.<client> ──────
  await q(cdp, `(() => { const row = [...document.querySelectorAll('#clientsBox .connectrow')]
    .find((r) => (r.querySelector('.connectname') || {}).textContent === 'Codex');
    [...row.querySelectorAll('button')].find((b) => b.textContent.trim() === '详情').click(); })()`);
  await waitFor(cdp, `document.querySelectorAll('#clientsBox .connectml-row').length > 0`, 8000, '模型清单').catch(() => {});
  const panel = await q(cdp, `(() => {
    const p = document.querySelector('#clientsBox .connectmodels');
    if (!p) return null;
    const list = p.querySelector('.connectml-list');
    return {
      count: (p.querySelector('.modelpick-count') || {}).textContent || '',
      rows: [...p.querySelectorAll('.connectml-row')].map((r) => ({
        id: (r.querySelector('.connectml-id') || {}).textContent,
        on: r.querySelector('.connectml-box').checked,
        main: r.querySelector('.connectml-star').getAttribute('aria-pressed') === 'true',
      })),
      hasSearch: !!p.querySelector('.connectml-search'),
      // 30 个模型不能把面板撑开：清单必须是**可滚动**的固定高度
      listH: Math.round(list.getBoundingClientRect().height),
      scrollable: list.scrollHeight > list.clientHeight + 1,
    };
  })()`);
  if (panel && panel.rows.filter((r) => r.on).length === 2 && panel.rows.length === MODEL_OPTIONS.length) {
    pass(`模型清单列出全部 ${panel.rows.length} 个候选，其中 2 个已勾选`);
  } else {
    fail(`模型清单勾选状态不对：${JSON.stringify(panel)}`);
  }
  if (panel && panel.rows.filter((r) => r.main).length === 1) pass('恰好一个主模型（★）');
  else fail(`主模型标记不对：${JSON.stringify(panel && panel.rows)}`);
  if (panel && panel.hasSearch) pass('模型清单带搜索框');
  else fail('模型清单没有搜索框');
  if (panel && panel.scrollable && panel.listH <= 240) {
    pass(`模型清单固定高度 ${panel.listH}px 且可滚动（${MODEL_OPTIONS.length} 个模型不再铺满面板）`);
  } else {
    fail(`模型清单没有做成可滚动窗口：${JSON.stringify(panel)}`);
  }

  // 搜索是纯前端过滤：不重新拉状态
  const urlsBefore = await q(cdp, `window.__urls.length`);
  await q(cdp, `(() => { const s = document.querySelector('#clientsBox .connectml-search');
    s.value = 'kimi'; s.dispatchEvent(new Event('input')); })()`);
  await sleep(200);
  const filtered = await q(cdp, `(() => {
    const rows = [...document.querySelectorAll('#clientsBox .connectml-row')].map((r) => ({
      id: (r.querySelector('.connectml-id') || {}).textContent,
      name: (r.querySelector('.connectml-id') || {}).title || '',
    }));
    return { rows, urls: window.__urls.length };
  })()`);
  /*
   * 判据：命中项必须**id 或展示名**含关键词。
   * 只要求 id 含关键词是错的 —— 展示名匹配到的那些（id 里没有 kimi）会被误判成失败。
   */
  const hitsOk = filtered.rows.every((r) => r.id.includes('kimi') || r.name.toLowerCase().includes('kimi'));
  if (filtered.rows.length && hitsOk && filtered.urls === urlsBefore) {
    pass(`搜索是纯前端过滤（命中 ${filtered.rows.length} 个，未发请求）`);
  } else {
    fail(`搜索行为不对：${JSON.stringify(filtered)}（之前请求数 ${urlsBefore}）`);
  }
  // 展示名也要能搜到：gg-5.1 的 id 里没有 kimi，只有展示名里有
  if (filtered.rows.some((r) => r.id === 'gg-5.1')) {
    pass('搜索同时匹配展示名（gg-5.1 的展示名含 kimi，被搜出来了）');
  } else {
    fail(`搜索只按 id 过滤，漏了展示名匹配：${JSON.stringify(filtered.rows)}`);
  }

  // 取消勾选一个模型 → 重新拉状态时请求要带上 models.codex
  await q(cdp, `(() => { const s = document.querySelector('#clientsBox .connectml-search');
    s.value = ''; s.dispatchEvent(new Event('input')); })()`);
  await sleep(150);
  await q(cdp, `(() => { const rows = [...document.querySelectorAll('#clientsBox .connectml-row')];
    const row = rows.find((r) => (r.querySelector('.connectml-id') || {}).textContent === 'glm-5.3');
    row.querySelector('.connectml-box').click(); })()`);
  await waitFor(cdp, `window.__urls.some((u) => u.includes('models.codex='))`, 8000, '带模型集合的请求').catch(() => {});
  const listReq = await q(cdp, `window.__urls.filter((u) => u.includes('models.codex=')).pop() || ''`);
  if (listReq.includes('models.codex=deepseek-v4.1-flash') && !listReq.includes('glm-5.3')) {
    pass(`取消勾选后请求带上了新的模型集合：${listReq.split('?')[1] || listReq}`);
  } else {
    fail(`取消勾选没有反映到请求里：${JSON.stringify(listReq)}`);
  }

  // ── 3. 已接入且配置一致的行**自动**验一遍：静态读回 + 端到端 ───────────
  await waitFor(cdp, `window.__posts.filter((p) => p.path === '/api/connect/verify').length >= 1`, 8000,
    '已接入且一致的行自动验证').catch(() => {});
  const verifies = await q(cdp, `window.__posts.filter((p) => p.path === '/api/connect/verify').map((p) => p.body && p.body.client)`);
  if (verifies.includes('codex')) pass(`已接入且配置一致的行自动验证：${JSON.stringify(verifies)}`);
  else fail(`已接入且一致的行没有自动验证（实际请求：${JSON.stringify(verifies)}）`);
  if (!verifies.includes('opencode')) pass('没接入的行不会被验证（不打扰）');
  else fail('没接入的行也被验证了 —— 会给出"读不到文件"这种没意义的失败');
  /*
   * 配置已经漂移（标签写着「需重新写入」）的行**不自动验**：验了必然报
   * 「静态自检未通过」—— 那不是新问题，是界面已经说过的状态；自动跑只会
   * 制造一条看着吓人的红字。想验可以点那行的「验证接入」。
   */
  if (!verifies.includes('claude')) pass('配置已漂移的行不自动验证（避免制造已知的红色失败）');
  else fail('配置已漂移的行也被自动验证了 —— 会显示一条界面早已提示过的失败');

  await waitFor(cdp, `document.querySelectorAll('#clientsBox .connectresult').length >= 1`, 8000, '验证结果渲染').catch(() => {});
  const afterVerify = await rowsOf();
  const codexResults = ((afterVerify.find((r) => r.label === 'Codex') || {}).results || []).join(' | ');
  if (codexResults.includes('静态自检通过') && codexResults.includes('端到端验证通过')) {
    pass(`Codex 验证结论渲染到位：${codexResults}`);
  } else {
    fail(`Codex 的验证结论没渲染出来：${JSON.stringify(codexResults)}`);
  }

  // ── 3b. 英文模式下这一块不许留中文（含上面刚渲染出来的验证结论）────────
  await q(cdp, `document.getElementById('langToggle').click()`);
  await sleep(400);
  const zh = await q(cdp, ZH_IN('#clientsBox .connectbox'));
  if (zh.length === 0) pass('英文模式：一键接入块（含验证结论）无残留中文');
  else fail(`英文模式下一键接入块仍有 ${zh.length} 处中文：\n     ` + zh.slice(0, 8).join('\n     '));
  await q(cdp, `document.getElementById('langToggle').click()`);
  await sleep(300);

  // ── 4. 手动验证：静态自检没过时，不能给出"通过" ────────────────────────
  /*
   * 用 Codex（已接入且配置一致）来验：失败结论要落到它的标签上。
   * Claude 那行配置已经漂移（标签是「需重新写入」），标签保持那句更有用的话
   * —— 它给出的下一步动作比"验证没过"更具体。
   */
  await q(cdp, `window.__setRoute('/api/connect/verify', { status: 200, body: {
    ok: false, written: { ok: false, reason: '写入后读不到文件' }, auth: null } })`);
  await q(cdp, `(() => { const row = [...document.querySelectorAll('#clientsBox .connectrow')]
    .find((r) => (r.querySelector('.connectmeta b') || {}).textContent === 'Codex');
    const b = [...row.querySelectorAll('button')].find((x) => x.textContent.trim() === '验证接入');
    if (b) b.click(); })()`);
  await waitFor(cdp, `[...document.querySelectorAll('#clientsBox .connectrow')]
    .find((r) => (r.querySelector('.connectmeta b') || {}).textContent === 'Codex')
    .querySelector('.connectresult.bad') !== null`, 8000, '验证失败结论').catch(() => {});
  const claudeBad = await q(cdp, `(() => { const row = [...document.querySelectorAll('#clientsBox .connectrow')]
    .find((r) => (r.querySelector('.connectmeta b') || {}).textContent === 'Codex');
    const res = row.querySelector('.connectresult');
    return res ? { cls: res.className, text: res.textContent.trim() } : null; })()`);
  if (claudeBad && claudeBad.cls.includes('bad') && claudeBad.text.includes('静态自检未通过')) {
    pass(`验证失败如实渲染：${claudeBad.text.replace(/\s+/g, ' ')}`);
  } else {
    fail(`验证失败没有如实渲染：${JSON.stringify(claudeBad)}`);
  }
  if (claudeBad && claudeBad.text.includes('没有做端到端验证')) pass('静态自检没过时明说「没做端到端验证」');
  else fail(`静态自检没过却没说明端到端没做：${JSON.stringify(claudeBad)}`);

  // ── 4b. 验证没过 → 状态标签不能再挂绿色的「已接入」────────────────────
  const codexTag = await q(cdp, `(() => { const row = [...document.querySelectorAll('#clientsBox .connectrow')]
    .find((r) => (r.querySelector('.connectmeta b') || {}).textContent === 'Codex');
    const tag = row.querySelector('.connectmeta .tag');
    return { text: tag.textContent.trim(), cls: tag.className }; })()`);
  if (codexTag.text === '已接入，验证未通过' && !codexTag.cls.includes('ok')) {
    pass(`验证没过时标签如实变成「${codexTag.text}」（不再挂绿色的「已接入」）`);
  } else {
    fail(`验证没过却仍显示 ${JSON.stringify(codexTag)}`);
  }

  // ── 6. 读不到状态时：必须说出来 + 给重试入口（不再永远转圈）────────────
  await q(cdp, `window.__setRoute('/api/connect', { status: 404, body: '404' })`);
  await q(cdp, `(() => { const b = [...document.querySelectorAll('#clientsBox .connectbox button')]
    .find((x) => x.textContent.trim() === '重新读取'); if (b) b.click(); })()`);
  await waitFor(cdp, `document.querySelector('#clientsBox .connectbox button') !== null
    && [...document.querySelectorAll('#clientsBox .connectbox button')].some((b) => b.textContent.trim() === '重试')`,
    8000, '读取失败后的重试按钮').catch(() => {});
  const soft = await q(cdp, `(() => {
    const box = document.querySelector('#clientsBox .connectbox');
    return {
      text: box.textContent,
      retry: [...box.querySelectorAll('button')].map((b) => b.textContent.trim()),
      rows: box.querySelectorAll('.connectrow').length,
      spinner: box.textContent.includes('正在读取接入状态'),
    };
  })()`);
  if (soft.retry.includes('重试')) pass('读取失败后给了「重试」按钮');
  else fail(`读取失败后没有重试入口：${JSON.stringify(soft.retry)}`);
  if (soft.text.includes('404')) pass('读取失败的原因（HTTP 404）如实说出来');
  else fail('读取失败没说原因（用户只会看到转圈）');
  if (soft.spinner === false) pass('失败态不再显示「正在读取接入状态…」（不再假装还在加载）');
  else fail('读取失败却仍显示「正在读取接入状态…」—— 就是用户遇到的那个转不完的圈');
  eq(soft.rows, 3, '读取失败时保留上次读到的行（比清空更诚实）');

  // ── 7. 恢复后点「重试」能真的回来 ──────────────────────────────────────
  await q(cdp, `window.__setRoute('/api/connect', { status: 200, body: ${JSON.stringify(CONNECT)} })`);
  await q(cdp, `(() => { const b = [...document.querySelectorAll('#clientsBox .connectbox button')]
    .find((x) => x.textContent.trim() === '重试'); if (b) b.click(); })()`);
  await waitFor(cdp, `![...document.querySelectorAll('#clientsBox .connectbox button')].some((b) => b.textContent.trim() === '重试')`,
    8000, '重试后恢复正常').catch(() => {});
  const recovered = await q(cdp, `(() => { const box = document.querySelector('#clientsBox .connectbox');
    return { rows: box.querySelectorAll('.connectrow').length, text: box.textContent }; })()`);
  eq(recovered.rows, 3, '重试后行还在');
  if (!recovered.text.includes('404')) pass('重试成功后失败提示消失');
  else fail('重试成功了却还留着失败提示');

  // ── 8. 「桥在跑但令牌被拒」不能说成「桥未运行」─────────────────────────
  /*
   * 实测踩到：桥独立启动时自己生成随机令牌，与控制台读的 `.bridge-token` 不一致
   * → 桥对控制台每次请求回 401。这时若显示「桥未运行」，用户会去点「启动桥服务」
   * 并得到"已经在跑了"，而真正该做的是「重启桥」（按控制台这份令牌重启）。
   */
  const unauthorized = { ...CONNECT, running: false, bridge: { up: true, authRejected: true } };
  await q(cdp, `window.__setRoute('/api/connect', { status: 200, body: ${JSON.stringify(unauthorized)} })`);
  await q(cdp, `(() => { const b = [...document.querySelectorAll('#clientsBox .connectbox button')]
    .find((x) => x.textContent.trim() === '重新读取'); if (b) b.click(); })()`);
  await waitFor(cdp, `document.querySelector('#clientsBox .connectbox .notice') !== null`, 8000, '令牌不一致提示').catch(() => {});
  const mismatch = await q(cdp, `(() => { const n = document.querySelector('#clientsBox .connectbox .notice'); return n ? n.textContent : ''; })()`);
  if (mismatch.includes('令牌不一致')) pass('桥在跑但令牌被拒 → 说的是「令牌不一致」');
  else fail(`令牌不一致没有被如实说明：${JSON.stringify(mismatch.slice(0, 80))}`);
  if (mismatch.includes('重启桥')) pass('并指出处置办法（重启桥，而不是启动桥）');
  else fail('令牌不一致时没有指出处置办法');
  if (!mismatch.includes('桥未运行')) pass('没有把「令牌被拒」说成「桥未运行」');
  else fail('把令牌被拒说成了「桥未运行」—— 用户会去点启动桥服务，然后卡住');

  // ── 8b. 桥没起时：模型候选来自"上次抓到的目录"，这件事必须说出来 ──────────
  /*
   * 审计 R5：桥没起时 `/v1/models` 拿不到，"这个模型存不存在"本该无从校验。
   * 现在的做法是拿**上次成功抓到的目录**兜底 —— 那属于"校验过了"，但**不等于**
   * "校验可信"。所以界面必须把话说全：候选可能已过期。
   * 不说的话，用户会以为面板上列出的模型一定存在。
   */
  const staleDown = {
    ...CONNECT, running: false, catalogStale: true, catalogAt: '2026-10-10T08:00:00.000Z',
    bridge: { up: false, authRejected: false },
  };
  await q(cdp, `window.__setRoute('/api/connect', { status: 200, body: ${JSON.stringify(staleDown)} })`);
  await q(cdp, `(() => { const b = [...document.querySelectorAll('#clientsBox .connectbox button')]
    .find((x) => x.textContent.trim() === '重新读取'); if (b) b.click(); })()`);
  await waitFor(cdp, `document.querySelector('#clientsBox .connectbox .notice') !== null`, 8000, '桥未运行提示').catch(() => {});
  const staleNotice = await q(cdp, `(() => { const n = document.querySelector('#clientsBox .connectbox .notice'); return n ? n.textContent : ''; })()`);
  if (staleNotice.includes('上次抓到的目录')) {
    pass(`桥没起 + 目录来自缓存 → 明说候选可能过期：${staleNotice.slice(0, 46)}…`);
  } else {
    fail(`没说清候选来自缓存（用户会以为列出的模型一定存在）：${JSON.stringify(staleNotice.slice(0, 80))}`);
  }

  // ── 9. 点「重新写入」：POST 必须带上**整批勾选的模型** ──────────────────
  /*
   * 现场（用户实际遇到的那次）：面板里勾了 5 个模型 → 点「重新写入」→ 客户端里
   * 始终只有 4 个，重启客户端多少次都一样。
   *
   * 根因是这个 POST 只发了 `model`（主模型），没发 `models`（勾选的那一批）。
   * 服务端在没收到 `models` 时会回落到"沿用配置文件里现在那批"（那是给命令行
   * `connect apply` 不带 `--models` 用的兜底），于是把旧的 4 个又写了一遍；
   * 而面板显示的个数来自它**自己的**勾选状态 —— 界面于是永远显示 5 个 +
   * 「已接入，需重新写入」，用户没有任何办法看出差异。
   *
   * 这一段钉住两件事：
   *   a. 请求体里必须带 `models`（否则新勾的模型永远写不进去）；
   *   b. 写入成功后，面板显示的个数要跟着**真正写进去的那批**走，
   *      而不是继续念自己那份勾选状态。
   *
   * 状态接口换成**按查询串回话**的桩：勾选变了，它回的 effectiveModels 也跟着变。
   * 不换的话页面拿到的永远是夹具里那份固定状态 —— b 这条就验不出来（假绿）。
   */
  await q(cdp, `window.__FIXCONNECT = ${JSON.stringify(CONNECT)}`);
  await q(cdp, `window.__setRoute('/api/connect', { body: (url) => {
    const raw = new URL(url, 'http://x').searchParams.get('models.codex');
    const ids = raw ? raw.split(',') : ['deepseek-v4.1-flash', 'glm-5.3'];
    const fix = window.__FIXCONNECT;
    return { ...fix, clients: fix.clients.map((c) => (c.id === 'codex'
      ? { ...c, effectiveModels: ids, models: ids, effectiveModel: ids[0], changed: false } : c)) };
  } })`);
  await q(cdp, `(() => { const b = [...document.querySelectorAll('#clientsBox .connectbox button')]
    .find((x) => x.textContent.trim() === '重新读取'); if (b) b.click(); })()`);
  await sleep(300);
  await q(cdp, `(() => { const row = [...document.querySelectorAll('#clientsBox .connectrow')]
    .find((r) => (r.querySelector('.connectname') || {}).textContent === 'Codex');
    const b = [...row.querySelectorAll('.connectacts button')].find((x) => x.textContent.trim() === '详情');
    if (b) b.click(); })()`);
  await waitFor(cdp, `document.querySelectorAll('#clientsBox .connectml-row').length > 0`, 8000, '模型清单').catch(() => {});

  // 取消勾选 glm-5.3，只留 deepseek-v4.1-flash
  await q(cdp, `(() => { const rows = [...document.querySelectorAll('#clientsBox .connectml-row')];
    const row = rows.find((r) => (r.querySelector('.connectml-id') || {}).textContent === 'glm-5.3');
    if (row && row.querySelector('.connectml-box').checked) row.querySelector('.connectml-box').click(); })()`);
  await waitFor(cdp, `window.__urls.some((u) => u.includes('models.codex=deepseek-v4.1-flash') && !u.includes('glm-5.3'))`,
    8000, '勾选更新').catch(() => {});

  // 写入接口回一份"真正写进去的是另外两个模型"的结果，用来验面板会不会跟着走
  await q(cdp, `window.__setRoute('/api/connect/apply', { status: 200, body: ${JSON.stringify({
    ok: true, changed: true, models: ['deepseek-v4.1-flash', 'glm-5.2'],
    verify: { ok: true }, auth: { ok: true, models: 2 },
  })} })`);
  await q(cdp, `(() => { const row = [...document.querySelectorAll('#clientsBox .connectrow')]
    .find((r) => (r.querySelector('.connectname') || {}).textContent === 'Codex');
    const b = [...row.querySelectorAll('.connectacts button')].find((x) => x.textContent.trim() === '重新写入');
    if (b) b.click(); })()`);
  await waitFor(cdp, `window.__posts.some((p) => p.path === '/api/connect/apply')`, 8000, '写入请求').catch(() => {});
  const applyBody = await q(cdp, `(window.__posts.filter((p) => p.path === '/api/connect/apply').pop() || {}).body || null`);
  if (applyBody && Array.isArray(applyBody.models) && applyBody.models.join(',') === 'deepseek-v4.1-flash') {
    pass(`写入请求带上了整批勾选的模型：models=${JSON.stringify(applyBody.models)}`);
  } else {
    fail(`写入请求没带 models —— 勾选的模型永远写不进去：${JSON.stringify(applyBody)}`);
  }
  if (applyBody && applyBody.model === 'deepseek-v4.1-flash') pass(`写入请求带上了主模型：model=${applyBody.model}`);
  else fail(`写入请求没带主模型：${JSON.stringify(applyBody)}`);

  await sleep(400);
  const afterApply = await q(cdp, `(() => { const row = [...document.querySelectorAll('#clientsBox .connectrow')]
    .find((r) => (r.querySelector('.connectname') || {}).textContent === 'Codex');
    return {
      count: (row.querySelector('.connectmcount') || {}).textContent || '',
      checked: [...document.querySelectorAll('#clientsBox .connectml-row')]
        .filter((r) => r.querySelector('.connectml-box').checked)
        .map((r) => (r.querySelector('.connectml-id') || {}).textContent),
    }; })()`);
  if (afterApply.count.trim() === '2 个模型' && afterApply.checked.join(',') === 'deepseek-v4.1-flash,glm-5.2') {
    pass(`写入后面板跟着真实结果走：${afterApply.count.trim()}（${afterApply.checked.join(' / ')}）`);
  } else {
    fail(`面板没跟着写入结果走（界面在说假话）：${JSON.stringify(afterApply)}`);
  }
} catch (err) {
  fail(`第一段抛错：${err.message}`);
}

// ── 第二段：**一开始就**读不到（用户实际遇到的那种：整个面板从没渲染出来过）──
/*
 * ⚠️ 这一段必须用**自己的** `page2.cdp`，不能沿用第一段的 `cdp`。
 * 早先这里写的是 `q(cdp, …)`（闭包里的第一张页面），而 `openPage` 当时会复用
 * 同一张页面，所以"碰巧"能过 —— 属于**假绿**：harness 一旦改成"每次开一张干净页面"
 * （见 ui-harness 的页面隔离修复），断言就会去查上一张页面，整段失败。
 */
{
  const broken = baseRoutes({ clients: CLIENTS });
  broken['/api/connect'] = { status: 404, body: '404' };
  const page2 = await openPage(`${URL_}?case=hard-404`, broken, { width: 1440, height: 1000, cdpPort: 9335 });
  const cdp2 = page2.cdp;
  try {
    await waitFor(cdp2, `document.querySelector('#clientsBox .connectbox') !== null`, 10000, '一键接入块').catch(() => {});
    const hard = await q(cdp2, `(() => {
      const box = document.querySelector('#clientsBox .connectbox');
      if (!box) return null;
      return {
        text: box.textContent,
        buttons: [...box.querySelectorAll('button')].map((b) => b.textContent.trim()),
        spinner: box.textContent.includes('正在读取接入状态'),
        rows: box.querySelectorAll('.connectrow').length,
      };
    })()`);
    if (!hard) {
      fail('读不到 /api/connect 时整块都没渲染出来');
    } else {
      if (hard.spinner === false) pass('从未读到状态时也不显示「正在读取接入状态…」');
      else fail('从未读到状态时仍显示占位文案 —— 用户看到的就是这个');
      if (hard.buttons.includes('重试')) pass('从未读到状态时给了「重试」');
      else fail(`从未读到状态时没有重试入口：${JSON.stringify(hard.buttons)}`);
      if (hard.text.includes('重启控制台')) pass('提示了「控制台还在跑旧代码，重启控制台」（这就是本次的真实成因）');
      else fail('没有提示"重启控制台"，用户拿到 404 无从下手');
      eq(hard.rows, 0, '没有数据时不渲染伪行');
    }

    // 英文模式下同样不许留中文
    await q(cdp2, `document.getElementById('langToggle').click()`);
    await sleep(400);
    const zh2 = await q(cdp2, ZH_IN('#clientsBox .connectbox'));
    if (zh2.length === 0) pass('英文模式：读取失败态无残留中文');
    else fail(`英文模式下失败态仍有中文：\n     ` + zh2.slice(0, 8).join('\n     '));
  } catch (err) {
    fail(`第二段抛错：${err.message}`);
  } finally {
    page2.close();
  }
}

// ── 第三段：用户自己照「复制片段」抄进配置文件的，要认成已接入 ─────────────
/*
 * 没有 manifest（不是我们写的）不等于没接入。这一档如果显示成「已安装，尚未接入」，
 * 用户会以为还得点一次「写入」—— 而那份配置其实完全正确。
 */
{
  const handWritten = CLIENTS.map((c) => (c.id === 'opencode'
    ? { ...c, applied: false, exists: true, changed: false, changes: [] }
    : c));
  const routes3 = baseRoutes({ clients: handWritten });
  routes3['/api/connect'] = { body: { ...CONNECT, clients: handWritten } };
  routes3['/api/connect/verify'] = { body: VERIFY_OK };
  const page3 = await openPage(`${URL_}?case=hand-written`, routes3, { width: 1440, height: 1000, cdpPort: 9335 });
  const cdp3 = page3.cdp;   // 同第二段：必须用自己的页面，别再沿用第一段的 cdp
  try {
    await waitFor(cdp3, `document.querySelectorAll('#clientsBox .connectrow').length === 3`, 10000, '第三段三行');
    const oc = await q(cdp3, `(() => {
      const row = [...document.querySelectorAll('#clientsBox .connectrow')]
        .find((r) => (r.querySelector('.connectname') || {}).textContent === 'opencode');
      const tag = row.querySelector('.connectmeta .tag');
      return { text: tag.textContent.trim(), cls: tag.className, buttons: [...row.querySelectorAll('button')].map((b) => b.textContent.trim()) };
    })()`);
    if (oc.text === '已接入（非本控制台写入）' && oc.cls.includes('ok')) {
      pass('手抄进配置文件的客户端被认成「已接入（非本控制台写入）」');
    } else {
      fail(`手抄的配置没有被认成已接入：${JSON.stringify(oc)}`);
    }
    // 「验证接入」现在在详情里：先展开再找
    await q(cdp3, `(() => { const row = [...document.querySelectorAll('#clientsBox .connectrow')]
      .find((r) => (r.querySelector('.connectname') || {}).textContent === 'opencode');
      const b = [...row.querySelectorAll('.connectacts button')].find((x) => x.textContent.trim() === '详情');
      if (b) b.click(); })()`);
    await waitFor(cdp3, `[...document.querySelectorAll('#clientsBox .connectrow')]
      .find((r) => (r.querySelector('.connectname') || {}).textContent === 'opencode')
      .querySelector('.connectdetail') !== null`, 8000, 'opencode 详情').catch(() => {});
    const ocDetail = await q(cdp3, `(() => { const row = [...document.querySelectorAll('#clientsBox .connectrow')]
      .find((r) => (r.querySelector('.connectname') || {}).textContent === 'opencode');
      return { buttons: [...row.querySelectorAll('button')].map((b) => b.textContent.trim()) }; })()`);
    if (ocDetail.buttons.includes('验证接入')) pass('手抄的配置也能点「验证接入」（在详情里）');
    else fail(`手抄的配置没有验证入口：${JSON.stringify(ocDetail.buttons)}`);

    await waitFor(cdp3, `window.__posts.some((p) => p.path === '/api/connect/verify' && p.body && p.body.client === 'opencode')`,
      8000, '手抄配置自动验证').catch(() => {});
    const posted = await q(cdp3, `window.__posts.some((p) => p.path === '/api/connect/verify' && p.body && p.body.client === 'opencode')`);
    if (posted) pass('手抄的配置也会自动验证（否则它会悄悄烂掉，用户永远不知道）');
    else fail('手抄的配置没有自动验证');
  } catch (err) {
    fail(`第三段抛错：${err.message}`);
  } finally {
    page3.close();
  }
}

// ── 第四段：模式切换（走桥 ↔ 客户端自己的模型）────────────────────────────
/*
 * 这是「撤销」之外的另一条路，也是用户真正会问的那个问题：
 * "我这两天想用 Codex 自己的模型，回头还想接着用桥"。
 *
 * 这一段钉住三件事：
 *   a. 桥模式下详情里有「切回原始模型」这个入口（而不是只能靠「撤销」拆掉）；
 *   b. 点它发出的请求体是 `{client, mode:'native'}` —— 少了 mode 服务端就不知道
 *      用户要干什么（接口是显式的，不靠猜）；
 *   c. 切完之后界面必须跟着变成「已切回原始模型」，并且告诉用户**要重启客户端**
 *      —— 实测踩过：用户写完、客户端里没变、于是反复点写入，而客户端是启动时读一次配置。
 */
{
  const clientsFor = (mode) => CLIENTS.map((c) => (c.id === 'codex'
    ? { ...c, mode, applied: mode === 'bridge', canSwitchBack: true, changed: false }
    : c));
  const routes4 = baseRoutes({ clients: clientsFor('bridge') });
  routes4['/api/connect'] = {
    body: (url) => (window.__MODE === 'native' ? window.__C.native : window.__C.bridge),
  };
  routes4['/api/connect/verify'] = { body: VERIFY_OK };
  routes4['/api/connect/mode'] = {
    body: {
      ok: true, changed: true, mode: 'native', id: 'codex',
      backup: 'E:\\backup\\client-configs\\codex\\20261010-170000-config.toml',
      verify: { ok: true },
      catalog: { path: 'C:\\Users\\you\\.codex\\workbuddy-model-catalog.json', kept: true },
    },
  };
  const inject = 'window.__MODE = "bridge";'
    + 'window.__C = ' + JSON.stringify({
      bridge: { ...CONNECT, clients: clientsFor('bridge') },
      native: { ...CONNECT, clients: clientsFor('native') },
    }) + ';'
    + 'window.__modeBody = null;'
    + 'window.__applyBody = null;'
    + '(() => { const orig = window.fetch; window.fetch = (input, init) => {'
    + '  const u = typeof input === "string" ? input : (input && input.url) || "";'
    + '  if (u.includes("/api/connect/mode")) { window.__MODE = "native"; window.__modeBody = init && init.body; }'
    + '  if (u.includes("/api/connect/apply")) { window.__applyBody = init && init.body; }'
    + '  return orig(input, init); }; })();';

  const page4 = await openPage(`${URL_}?case=mode`, routes4, { width: 1440, height: 1000, cdpPort: 9335, inject });
  const cdp4 = page4.cdp;
  try {
    await waitFor(cdp4, `document.querySelectorAll('#clientsBox .connectrow').length === 3`, 10000, '第四段三行');
    await q(cdp4, `(() => { const row = [...document.querySelectorAll('#clientsBox .connectrow')]
      .find((r) => (r.querySelector('.connectname') || {}).textContent === 'Codex');
      const b = [...row.querySelectorAll('.connectacts button')].find((x) => x.textContent.trim() === '详情');
      if (b) b.click(); })()`);
    await waitFor(cdp4, `document.querySelector('#clientsBox .connectmode') !== null`, 8000, '模式区块');

    const before = await q(cdp4, `(() => {
      const box = document.querySelector('#clientsBox .connectmode');
      const row = [...document.querySelectorAll('#clientsBox .connectrow')]
        .find((r) => (r.querySelector('.connectname') || {}).textContent === 'Codex');
      return {
        text: box.textContent,
        buttons: [...box.querySelectorAll('button')].map((b) => b.textContent.trim()),
        tag: (row.querySelector('.connectmeta .tag') || {}).textContent.trim(),
      };
    })()`);
    if (before.text.includes('正在走桥') && before.buttons.includes('切回原始模型')) {
      pass(`桥模式下详情里有模式区块与「切回原始模型」：${JSON.stringify(before.buttons)}`);
    } else {
      fail(`桥模式下的模式区块不对：${JSON.stringify(before)}`);
    }
    if (before.tag === '已接入') pass('桥模式下状态标签是「已接入」');
    else fail(`桥模式下的标签不对：${before.tag}`);

    // 点「切回原始模型」
    await q(cdp4, `(() => { const box = document.querySelector('#clientsBox .connectmode');
      [...box.querySelectorAll('button')].find((b) => b.textContent.trim() === '切回原始模型').click(); })()`);
    await waitFor(cdp4, `window.__modeBody !== null`, 8000, '切模式请求').catch(() => {});
    const body = await q(cdp4, `window.__modeBody`);
    let parsed = null;
    try { parsed = JSON.parse(body || 'null'); } catch { /* 保留 null，下面断言会报出来 */ }
    if (parsed && parsed.client === 'codex' && parsed.mode === 'native') {
      pass(`切模式请求体明确带了目标模式：${body}`);
    } else {
      fail(`切模式请求体不对（服务端无从判断用户要干什么）：${JSON.stringify(body)}`);
    }

    await sleep(600);
    const after = await q(cdp4, `(() => {
      const box = document.querySelector('#clientsBox .connectmode');
      const row = [...document.querySelectorAll('#clientsBox .connectrow')]
        .find((r) => (r.querySelector('.connectname') || {}).textContent === 'Codex');
      return {
        text: box.textContent,
        buttons: [...box.querySelectorAll('button')].map((b) => b.textContent.trim()),
        tag: (row.querySelector('.connectmeta .tag') || {}).textContent.trim(),
        result: [...row.querySelectorAll('.connectresult div')].map((d) => d.textContent.trim()).join(' | '),
      };
    })()`);
    if (after.tag === '已切回原始模型') pass(`切完之后标签变成「${after.tag}」（不再挂着绿色的「已接入」）`);
    else fail(`切完之后标签不对：${after.tag}`);
    if (after.buttons.includes('切到桥的模型')) pass(`模式区块给了反向入口：${JSON.stringify(after.buttons)}`);
    else fail(`切完之后没有「切到桥的模型」入口：${JSON.stringify(after.buttons)}`);
    if (after.text.includes("客户端自己的模型")) pass('模式区块如实说明现在用的是客户端自己的模型');
    else fail(`模式区块没说清当前模式：${after.text.slice(0, 80)}`);
    if (after.result.includes('重启该客户端后生效')) {
      pass('结论里明说「重启该客户端后生效」（客户端是启动时读一次配置）');
    } else {
      fail(`没有告诉用户要重启客户端：${after.result}`);
    }

    // ── 第四段 b：Codex 的 profile 通道（零写入接入）──────────────────────
    /*
     * `codex -p <name>` 会叠加 `$CODEX_HOME/<name>.config.toml`，所以有一条
     * **基础配置一个字节都不动**的接入方式。它是"便捷性与安全性同时更好"的那一档，
     * 但**桌面应用不接受命令行开关** —— 这条限制必须在界面上写着，否则用户会白试。
     */
    const prof = await q(cdp4, `(() => {
      const box = document.querySelector('#clientsBox .connectprofile');
      if (!box) return null;
      return { text: box.textContent, buttons: [...box.querySelectorAll('button')].map((b) => b.textContent.trim()) };
    })()`);
    if (prof && prof.buttons.includes('写入 profile 文件')) {
      pass(`Codex 详情里有 profile 通道入口：${JSON.stringify(prof.buttons)}`);
    } else {
      fail(`没有 profile 通道入口：${JSON.stringify(prof && prof.buttons)}`);
    }
    if (prof && prof.text.includes('codex -p workbuddy')) pass('给出了要照着敲的启动命令');
    else fail('没有给出启动命令（用户不知道写完怎么用）');
    if (prof && prof.text.includes('桌面应用不接受命令行开关')) pass('如实标注了「只对命令行生效」这条限制');
    else fail('没有标注限制 —— 用户会以为桌面应用也能用 profile');
    if (prof && prof.text.includes('config.toml') && prof.text.includes('一个字节都不动')) {
      pass('说清了它不动基础配置');
    } else {
      fail('没说清"不动你的配置"这个关键好处');
    }

    // 点「写入 profile 文件」→ 请求体必须指向 profile 那个客户端，并带上勾选的模型
    await q(cdp4, `(() => { const box = document.querySelector('#clientsBox .connectprofile');
      [...box.querySelectorAll('button')].find((b) => b.textContent.trim() === '写入 profile 文件').click(); })()`);
    await waitFor(cdp4, `window.__applyBody !== null`, 8000, 'profile 写入请求').catch(() => {});
    const pbody = await q(cdp4, `window.__applyBody`);
    let pparsed = null;
    try { pparsed = JSON.parse(pbody || 'null'); } catch { /* 下面断言会报出来 */ }
    if (pparsed && pparsed.client === 'codex-profile') {
      pass(`profile 写入请求指向 profile 客户端：${pbody}`);
    } else {
      fail(`profile 写入请求的客户端不对（会写到基础配置上去）：${JSON.stringify(pbody)}`);
    }
    if (pparsed && Array.isArray(pparsed.models) && pparsed.models.join(',') === 'deepseek-v4.1-flash,glm-5.3') {
      pass(`并沿用了 Codex 那行勾选的模型：${JSON.stringify(pparsed.models)}`);
    } else {
      fail(`profile 没沿用勾选的模型（用户得再勾一遍）：${JSON.stringify(pparsed && pparsed.models)}`);
    }

    // 英文模式下这块也不许留中文
    await q(cdp4, `document.getElementById('langToggle').click()`);
    await sleep(400);
    const zh4 = await q(cdp4, ZH_IN('#clientsBox .connectbox'));
    if (zh4.length === 0) pass('英文模式：模式与 profile 区块无残留中文');
    else fail(`英文模式下模式区块仍有 ${zh4.length} 处中文：\n     ` + zh4.slice(0, 8).join('\n     '));

    // ── 第四段 c：Esc 要能退出展开的详情（键盘可达性）──────────────────────
    /*
     * 界面规范里那条"每个可交互元素都要能被键盘走到、也要能被键盘退出来"。
     * 原先 Esc 只关模型详情，接入面板展开的客户端详情关不掉 —— 键盘用户
     * 只能回去点「收起详情」按钮。
     */
    const openBefore = await q(cdp4, `document.querySelector('#clientsBox .connectdetail') !== null`);
    await q(cdp4, `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await sleep(350);
    const openAfter = await q(cdp4, `document.querySelector('#clientsBox .connectdetail') !== null`);
    if (openBefore && !openAfter) pass('Esc 关掉了展开的详情（键盘能进也能退）');
    else fail(`Esc 没能收起详情（前=${openBefore} 后=${openAfter}）—— 键盘用户只能去点按钮`);

    // ── 第四段 d：确认弹窗在英文模式下也必须是英文 ─────────────────────────
    /*
     * **翻译层够不到 `confirm()` 弹窗**（它不在 DOM 里），所以"英文模式无残留中文"
     * 那几条渲染断言**覆盖不到它** —— 而写入确认框是用户每次接入都会看到的一段字，
     * 还是**多行拼出来**的（最容易漏翻的形状）。
     *
     * 这一条以前没有任何测试：`check-i18n-coverage` 会把它的字面量报成"翻不动"，
     * 而那是**静态扫描**，看不出运行时到底翻了没有。所以这里实测一次。
     */
    // 此刻页面已经是英文（上面那条渲染断言切过去之后没有切回来）
    await q(cdp4, `(() => { const row = [...document.querySelectorAll('#clientsBox .connectrow')]
      .find((r) => (r.querySelector('.connectname') || {}).textContent === 'Codex');
      const b = [...row.querySelectorAll('.connectacts button')].find((x) => x.className.includes('primary'));
      if (b) b.click(); })()`);
    await sleep(500);
    const dlg = page4.lastDialog() || '';
    if (dlg && !/[\u4e00-\u9fff]/.test(dlg)) {
      pass(`英文模式下写入确认框是英文：${JSON.stringify(dlg.slice(0, 60))}…`);
    } else if (!dlg) {
      fail('没抓到确认框 —— 用例失效（按钮选择器变了？）');
    } else {
      fail(`英文模式的确认框里还有中文：${JSON.stringify(dlg.slice(0, 120))}`);
    }
  } catch (err) {
    fail(`第四段抛错：${err.message}`);
  } finally {
    page4.close();
  }
}

// ── 第五段：刷新页面不该丢掉"还没写入的勾选" ──────────────────────────────
/*
 * 实测的抱怨：勾好了 5 个、还没点写入，刷新一下回到 4 个 —— 因为面板的勾选状态
 * 原本只在内存里，刷新后是从配置文件重建的。现在把**选择**存进 localStorage
 * （只存选择，不存任何凭据），恢复出来的选择还要**真的发给服务端** ——
 * 只在本地显示没用，预览与写入都得按它算。
 */
{
  const routes5 = baseRoutes({ clients: CLIENTS });
  routes5['/api/connect'] = {
    body: (url) => {
      const fix = window.__F5;
      const raw = new URL(url, 'http://x').searchParams.get('models.codex');
      const ids = raw ? raw.split(',') : ['deepseek-v4.1-flash', 'glm-5.3'];
      return {
        ...fix,
        clients: fix.clients.map((c) => (c.id === 'codex'
          ? { ...c, effectiveModels: ids, models: ids, effectiveModel: ids[0], changed: false } : c)),
      };
    },
  };
  routes5['/api/connect/verify'] = { body: VERIFY_OK };
  const page5 = await openPage(`${URL_}?case=persist`, routes5, {
    width: 1440,
    height: 1000,
    cdpPort: 9335,
    inject: `window.__F5 = ${JSON.stringify({ ...CONNECT, clients: CLIENTS })};` + URL_RECORDER,
  });
  const cdp5 = page5.cdp;
  const expand5 = () => q(cdp5, `(() => { const row = [...document.querySelectorAll('#clientsBox .connectrow')]
    .find((r) => (r.querySelector('.connectname') || {}).textContent === 'Codex');
    const b = [...row.querySelectorAll('.connectacts button')].find((x) => x.textContent.trim() === '详情');
    if (b) b.click(); })()`);
  try {
    await waitFor(cdp5, `document.querySelectorAll('#clientsBox .connectrow').length === 3`, 10000, '第五段三行');
    await expand5();
    await waitFor(cdp5, `document.querySelectorAll('#clientsBox .connectml-row').length > 0`, 8000, '模型清单');

    // 取消勾选 glm-5.3 → 只剩 1 个（模拟"改完还没点写入"）
    await q(cdp5, `(() => { const r = [...document.querySelectorAll('#clientsBox .connectml-row')]
      .find((x) => (x.querySelector('.connectml-id') || {}).textContent === 'glm-5.3');
      if (r && r.querySelector('.connectml-box').checked) r.querySelector('.connectml-box').click(); })()`);
    await waitFor(cdp5, `window.__urls.some((u) => u.includes('models.codex=deepseek-v4.1-flash') && !u.includes('glm-5.3'))`,
      8000, '勾选更新').catch(() => {});
    const stored = await q(cdp5, `window.localStorage.getItem('wb-connect-selection')`);
    if (stored && stored.includes('deepseek-v4.1-flash')) pass(`勾选写进了 localStorage：${String(stored).slice(0, 60)}…`);
    else fail(`勾选没落盘（刷新就会丢）：${stored}`);

    // 刷新页面（harness 只在 openPage 时清一次存储，重载不会清）
    /*
     * 重载要**确定性地等到新文档**，不能只等"行数 == 3"：
     * 重载期间 `Runtime.evaluate` 可能打在新旧文档交替的那一刻，于是抛
     * `Uncaught`（满负载跑时实测到过 —— 单跑这条用例却过，典型的竞态）。
     * 判据用一个只存在于旧文档的标记：新文档里它是 undefined。
     */
    await q(cdp5, `window.__OLD_DOC = 1`);
    await q(cdp5, `location.reload()`);
    await waitFor(cdp5, `typeof window.__OLD_DOC === 'undefined' && document.readyState === 'complete'`,
      20000, '重载到新文档').catch(() => {});
    await waitFor(cdp5, `document.querySelectorAll('#clientsBox .connectrow').length === 3`, 20000, '刷新后三行');
    await waitFor(cdp5, `!![...document.querySelectorAll('#clientsBox .connectrow')]
      .find((r) => (r.querySelector('.connectname') || {}).textContent === 'Codex')`, 8000, '刷新后 Codex 行').catch(() => {});
    await expand5();
    await waitFor(cdp5, `document.querySelectorAll('#clientsBox .connectml-row').length > 0`, 8000, '刷新后模型清单');
    const after = await q(cdp5, `(() => ({
      count: (document.querySelector('#clientsBox .modelpick-count') || {}).textContent || '',
      checked: [...document.querySelectorAll('#clientsBox .connectml-row')]
        .filter((r) => r.querySelector('.connectml-box').checked)
        .map((r) => (r.querySelector('.connectml-id') || {}).textContent),
    }))()`);
    if (after.checked.join(',') === 'deepseek-v4.1-flash') {
      pass(`刷新后保住了"还没写入"的选择：${after.count.trim()}（${after.checked.join(',')}）`);
    } else {
      fail(`刷新把用户没写完的勾选丢了：${JSON.stringify(after)}`);
    }
    const req = await q(cdp5, `window.__urls.filter((u) => u.includes('models.codex=')).pop() || ''`);
    if (req.includes('models.codex=deepseek-v4.1-flash') && !req.includes('glm-5.3')) {
      pass('恢复的选择也真的发给了服务端（预览与写入都会按它算）');
    } else {
      fail(`恢复的选择没发给服务端（只在本地显示，等于没用）：${req}`);
    }
  } catch (err) {
    fail(`第五段抛错：${err.message}`);
  } finally {
    page5.close();
  }
}

close();
server.close();
console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
