/**
 * 面板 i18n（中 / 英）验收。
 *
 *   node dsh-plugin/tests/panel-i18n.mjs
 *
 * ## 断言什么
 *
 * 1. 切到英文后，**9 个标签页里可见的中文数 = 0**（文本节点 + 悬停可见的属性，
 *    以及**打开后**的下拉菜单项）；
 * 2. 每个标签页**内容够厚**（≥12 个文本节点）—— 防「没渲染 → 0 残留」的假绿；
 * 3. **指示框真的包住当前项** —— 切语言后标签宽度变了，指示框没重新量就会露出来
 *    （用户实拍发现的 bug：白框只包住 "Overvie"，"w" 掉在外面）；
 * 4. 切回中文能还原、无运行时报错。
 *
 * ## 三处「第一版漏掉」的教训（都已补进桩与断言）
 *
 * - **桩只覆盖一个分支**：签到状态原来固定成「未签到」，而「已签到（+N）」
 *   那一支是拼接串、需要单独的规则 —— 漏了整整一支没人知道。
 *   现在**跑两遍**（已签到 / 未签到），两类分支都过。
 * - **桩的形状与真实契约不一致**：`/workbuddy/models` 原来写的是桥的原始字段名
 *   （`supports_images`），而归一化器（lib/models.mjs）输出的是 `images` ——
 *   于是对话页下拉读不到 `m.images`，`· 多模态` 后缀根本没渲染，
 *   验收在**错误的地方**变绿。
 * - **数据与文案的分界要显式**：桩里的中文一律换成 ASCII，这样扫到的中文
 *   只可能来自界面文案。**例外是已知的促销徽章标签**（`限时免费` 等）——
 *   它们虽是上游数据，但我们**故意**翻了，所以要留在桩里一起验。
 *
 * ## 为什么要跑两遍
 *
 * 面板里大量文案是「有值 / 无值」两支（已签到 vs 未签到、有失败 vs 无失败、
 * 有旧路由 vs 无）。只跑一套桩，另一套分支的文案永远扫不到。
 * 每遍 ~9 秒，两遍的代价换「分支也进检查」，值。
 *
 * 桩数据与渲染骨架来自 `_panel-fixtures.mjs`（与 panel-render.mjs 共用一份）。
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startStaticServer, openPage, waitFor, sleep } from '../../tools/dev/ui-harness.mjs';
import { FIXTURES, buildRoutes, ensureVendor, harnessHtml } from './_panel-fixtures.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN = join(HERE, '..');
const PORT = 8820; // 与控制台用例（8774~8798）分开，避免同时跑时抢端口

let failures = 0;
const fail = (m) => { console.error('✗ ' + m); failures += 1; };
const pass = (m) => console.log('✓ ' + m);

/** 面板的 9 个标签页（顺序与 client.js 的 TABS 一致）。 */
const TAB_COUNT = 9;

/**
 * 桩数据里**保留**中文的字符串：已知的促销徽章标签。
 * 它们虽然是上游数据，但界面**故意**翻译了它们（控制台词条表里也有那两条），
 * 所以要留在桩里参与验收 —— 否则「徽章没翻」这类问题永远扫不到。
 */
const KEEP_ZH = new Set([
  // 上游促销标签
  '限时免费', '限时折扣', '夜间免费', '夜间折扣', '错峰使用',
  // 权益包名（上游账单系统的专有名称，我们**故意**翻了）
  'CodeBuddy个人体验版', 'CodeBuddy个人版拉新权益包', 'CodeBuddy个人版国内运营裂变包',
]);

/** 把桩数据里的中文换成 ASCII：这样扫到的任何中文都只可能来自界面文案。 */
function asciiData(value) {
  if (typeof value === 'string') {
    if (KEEP_ZH.has(value)) return value;
    // 徽章标签也藏在 tags 的 `badge:标签:#色` 规格里
    const m = /^badge:([^:]+)(:.+)?$/.exec(value);
    if (m && KEEP_ZH.has(m[1])) return 'badge:' + m[1] + (m[2] || '');
    return value.replace(/[\u4e00-\u9fff]+/g, 'X');
  }
  if (Array.isArray(value)) return value.map(asciiData);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = asciiData(v);
    return out;
  }
  return value;
}

/**
 * 按「有值 / 无值」造两套桩。
 *
 * `variant === 'checked'` 时今日已签到（胶囊是 `已签到（+N）` 拼接串），
 * 否则未签到（胶囊是整串 `未签到`，词条表里直接有）。两支的文案来源不同，必须都跑到。
 */
function routesFor(variant) {
  const routes = asciiData(buildRoutes(FIXTURES));
  const checked = variant === 'checked';
  const status = { todayCheckedIn: checked, todayCredit: checked ? 100 : 0, streakDays: 7 };
  /*
   * 覆盖 `/workbuddy/status` 时**也要过一遍 asciiData** —— 直接 spread 原始
   * `FIXTURES.status` 会把桩里的中文（如权益包名 `CodeBuddy个人体验版`）漏回来，
   * 于是被当成「漏翻的界面文案」报出来（第一版就漏了这一步）。
   *
   * 权益包名属于**上游账单系统的专有名称**（数据），与控制台一样不翻 ——
   * 所以它本来就该被 ASCII 化掉，不该进「漏翻」判定。
   */
  routes['/workbuddy/status'] = asciiData({ ...FIXTURES.status, checkin: { status, auto: { auto: true } } });
  routes['/workbuddy/checkin'] = {
    ok: true, status,
    auto: { auto: true, lastAt: Date.now() - 3600_000, lastResult: 'ok', lastError: null, lastSource: 'manual' },
  };
  /*
   * ⚠️ 诊断项的 label / detail / hint **不能** ASCII 化 —— 它们由共用的
   * `lib/diagnostics.mjs` 生成，是**我们自己库产出的界面文案**（控制台词条表里
   * 也翻了那一整组），不是上游数据。
   *
   * 第一版把整棵路由树一把 ASCII 掉，等于把**整块诊断界面**从检查范围里删掉了 ——
   * 用户实拍发现诊断页整页还是中文。这是「一刀切转换」的典型代价：
   * 「数据 / 文案」的分界要**按字段**判，不能按整个响应体判。
   */
  routes['/workbuddy/console-api/diagnose'] = FIXTURES.consoleDiagnose;
  return routes;
}

/** 扫「可见中文」：文本节点 + 悬停可见的属性。**只扫面板本身**（#root）。 */
const COLLECT_ZH = `(() => {
  const root = document.getElementById('root') || document.body;
  const SKIP = new Set(['SCRIPT', 'STYLE', 'TEXTAREA']);
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      const p = n.parentElement;
      // data-wb-raw 子树里是**数据**（对话正文 / 日志行 / 上游原文 / 语言代码），
      // 不是界面文案 —— 不参与「漏翻」判定
      if (!p || SKIP.has(p.tagName) || p.closest('[data-wb-raw]')) return NodeFilter.FILTER_REJECT;
      return /[\\u4e00-\\u9fff]/.test(n.data) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  const out = [];
  let n;
  while ((n = w.nextNode())) {
    const t = n.data.replace(/\\s+/g, ' ').trim();
    if (!t) continue;
    const p = n.parentElement;
    out.push(p.tagName.toLowerCase() + (p.className ? '.' + String(p.className).split(' ')[0] : '') + ' | ' + t);
  }
  for (const el of root.querySelectorAll('[title],[placeholder],[aria-label],[alt]')) {
    if (el.closest('[data-wb-raw]')) continue;
    for (const a of ['title', 'placeholder', 'aria-label', 'alt']) {
      const v = el.getAttribute(a);
      if (v && /[\\u4e00-\\u9fff]/.test(v)) out.push('@' + a + ' | ' + v.replace(/\\s+/g, ' ').trim());
    }
  }
  return [...new Set(out)];
})()`;

/** 数「可见文本节点」+ 取几条英文样本。用来防「0 残留 = 压根没渲染」的假绿。 */
const TEXT_STATS = `(() => {
  const root = document.getElementById('root') || document.body;
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      const p = n.parentElement;
      if (!p || p.closest('[data-wb-raw]')) return NodeFilter.FILTER_REJECT;
      return n.data.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  const out = [];
  let n;
  while ((n = w.nextNode())) {
    const t = n.data.replace(/\\s+/g, ' ').trim();
    if (t) out.push(t);
  }
  return { count: out.length, sample: out.filter((s) => /[A-Za-z]/.test(s)).slice(0, 3) };
})()`;

/**
 * 指示框必须**真的包住**当前项 —— 切语言后标签文字变宽/变窄，
 * 指示框没重新量就会露出来（实拍：白框只包住 "Overvie"，"w" 掉在外面）。
 * 返回差值，调用方判「是否都在 ±2px 内」。
 */
const INDICATOR_FIT = `(() => {
  const root = document.getElementById('root') || document.body;
  const pairs = [
    ['.wb-tab-indicator', '.wb-tab.on'],
    ['.wb-segmented-indicator', '.wb-segmented-item.on'],
  ];
  const out = [];
  for (const [indSel, onSel] of pairs) {
    const ind = root.querySelector(indSel);
    const on = root.querySelector(onSel);
    if (!ind || !on) continue;
    const a = ind.getBoundingClientRect();
    const b = on.getBoundingClientRect();
    out.push({ sel: onSel, dx: Math.round(a.x - b.x), dy: Math.round(a.y - b.y),
      dw: Math.round(a.width - b.width), dh: Math.round(a.height - b.height) });
  }
  return out;
})()`;

const { react, reactDom } = await ensureVendor();
const clientSource = readFileSync(join(PLUGIN, 'lib', 'client.js'), 'utf8');

/**
 * 一个自包含的壳服务：harness 页面 + client.js + React UMD **都挂在同一个源**上。
 *
 * 必须同源：harness 页面里写的是 `/vendor/react.js` 这类绝对路径，
 * 换一个端口就 404，React 加载不到 → 面板根本不挂载（第一次就踩了，
 * 表现为 `等待超时：面板挂载`）。
 */
function makeServer(routes, port) {
  return createServer((req, res) => {
    const path = new URL(req.url, `http://127.0.0.1:${port}`).pathname;
    if (path === '/harness.html') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(harnessHtml(routes)); }
    if (path === '/client.js') { res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }); return res.end(clientSource); }
    if (path === '/vendor/react.js') { res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }); return res.end(react); }
    if (path === '/vendor/react-dom.js') { res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }); return res.end(reactDom); }
    res.writeHead(404); res.end('not found');
  });
}

const server = await startStaticServer(PORT);

/** 跑一遍：一套桩 + 一个页面，扫 9 个标签页。 */
async function runPass(variant, port, cdpPort) {
  console.log(`\n—— 第 ${variant === 'checked' ? '1' : '2'} 遍：今日${variant === 'checked' ? '已' : '未'}签到 ——`);
  const pageServer = makeServer(routesFor(variant), port);
  await new Promise((r) => pageServer.listen(port, '127.0.0.1', r));

  const page = await openPage(`http://127.0.0.1:${port}/harness.html`, {}, { width: 900, height: 1400, injectStub: false, cdpPort });
  const q = (expr) => page.cdp.evaluate(expr);
  try {
    await waitFor(page.cdp, 'window.__harness && window.__harness.rendered === true', 15000, '面板挂载');
    await sleep(900);

    const tabCount = await q(`document.querySelectorAll('.wb-tab').length`);
    if (tabCount === TAB_COUNT) pass(`面板渲染出 ${tabCount} 个标签页`);
    else fail(`标签页数量不对：${tabCount}（应为 ${TAB_COUNT}）`);

    // 默认中文：先确认基线（否则「英文 0 残留」可能是因为压根没渲染）
    const zhBaseline = await q(COLLECT_ZH);
    if (zhBaseline.length > 8) pass(`默认中文可见文案 ${zhBaseline.length} 条（合理）`);
    else fail(`默认中文只有 ${zhBaseline.length} 条，面板可能没渲染出来`);

    // 切到英文
    if (!await q(`!!document.querySelector('.wb-lang')`)) fail('找不到语言开关 .wb-lang');
    else pass('面板右上角有语言开关');
    await q(`document.querySelector('.wb-lang').click()`);
    await sleep(700);
    const label = await q(`(document.querySelector('.wb-lang') || {}).textContent || ''`);
    if (label.trim() === '中') pass('切到英文后按钮显示「中」（表示可切回）');
    else fail(`语言按钮文案不对：${label}`);

    // ★ 切语言后立刻查指示框：这正是实拍暴露的那个 bug
    const fit = await q(INDICATOR_FIT);
    if (!fit.length) fail('找不到指示框（.wb-tab-indicator）—— 断言没生效');
    for (const f of fit) {
      const worst = Math.max(Math.abs(f.dx), Math.abs(f.dy), Math.abs(f.dw), Math.abs(f.dh));
      if (worst <= 2) pass(`切英文后指示框仍包住当前项：${f.sel}`);
      else fail(`指示框没重新量：${f.sel} 偏差 dx=${f.dx} dy=${f.dy} dw=${f.dw} dh=${f.dh} —— 标签文字已变宽但框没跟上`);
    }

    // 逐个标签页扫
    const leftovers = [];
    const thin = [];
    for (let i = 0; i < TAB_COUNT; i += 1) {
      await q(`(() => { const b = document.querySelectorAll('.wb-tab')[${i}]; if (b) b.click(); })()`);
      await sleep(550);
      const name = await q(`(() => { const b = document.querySelectorAll('.wb-tab')[${i}]; return b ? b.textContent : '?'; })()`);
      const zh = await q(COLLECT_ZH);
      const stats = await q(TEXT_STATS);
      // 「0 残留」也可能是**内容没渲染**造成的假绿 —— 所以同时要求内容够厚
      if (stats.count < 12) thin.push(`${name}(${stats.count})`);
      if (zh.length === 0) pass(`标签页 ${i + 1}/9「${name}」无残留中文（${stats.count} 个文本节点）`);
      else { leftovers.push([name, zh]); fail(`标签页 ${i + 1}/9「${name}」仍有 ${zh.length} 条中文`); }

      /*
       * 指示框的几何断言要**逐页**做：`.wb-segmented-indicator`（分段胶囊）
       * 只在个别页面（如模型页）才有，只在概览页量一次等于没验到它。
       */
      for (const f of await q(INDICATOR_FIT)) {
        const worst = Math.max(Math.abs(f.dx), Math.abs(f.dy), Math.abs(f.dw), Math.abs(f.dh));
        if (worst <= 2) pass(`  「${name}」指示框包住当前项：${f.sel}`);
        else fail(`「${name}」指示框没重新量：${f.sel} 偏差 dx=${f.dx} dy=${f.dy} dw=${f.dw} dh=${f.dh}`);
      }

      /*
       * 下拉菜单里的文字**只有打开时才存在**（.dd-item 是打开时建的），
       * 所以逐个点开再扫一遍 —— 否则菜单里的漏翻扫不到。
       */
      const n = await q(`document.querySelectorAll('#root .wb-dropdown-trigger').length`);
      for (let k = 0; k < n; k += 1) {
        const opened = await q(`(() => { const t = document.querySelectorAll('#root .wb-dropdown-trigger')[${k}]; if (!t) return false; t.click(); return true; })()`);
        if (!opened) continue;
        await sleep(240);
        const mzh = await q(COLLECT_ZH);
        if (mzh.length) { leftovers.push([`${name} › 下拉 ${k + 1}`, mzh]); fail(`「${name}」第 ${k + 1} 个下拉打开后仍有 ${mzh.length} 条中文`); }
        await q(`(() => { const t = document.querySelectorAll('#root .wb-dropdown-trigger')[${k}]; if (t) t.click(); })()`);
        await sleep(160);
      }

      /*
       * 分段控件（Segmented）的每个选项也点一遍：切换会**换掉整块内容** ——
       * 图表的「时间趋势 / 各模型对比」、用量粒度、模型页的筛选…
       * 只扫默认那一支，等于其它分支的文案永远不进检查
       * （`· 多模态`、柱状图 tooltip 都是这么漏的）。
       */
      const segCount = await q(`document.querySelectorAll('#root .wb-segmented-item').length`);
      for (let k = 0; k < segCount; k += 1) {
        const clicked = await q(`(() => {
          const it = document.querySelectorAll('#root .wb-segmented-item')[${k}];
          if (!it || it.classList.contains('on')) return false;
          it.click(); return true;
        })()`);
        if (!clicked) continue;
        await sleep(340);
        const szh = await q(COLLECT_ZH);
        if (szh.length) { leftovers.push([`${name} › 分段 ${k + 1}`, szh]); fail(`「${name}」第 ${k + 1} 个分段选项切换后仍有 ${szh.length} 条中文`); }
      }

      /*
       * 模型页还有一整组「详情抽屉」文案（DetailItem），只有展开才渲染。
       * 展开第一行即可覆盖那一整块。
       */
      const openedDetail = await q(`(() => {
        const b = [...document.querySelectorAll('#root .wb-btn')].find((x) => /^(详情|Details)$/.test(x.textContent.trim()));
        if (!b) return false;
        b.click(); return true;
      })()`);
      if (openedDetail) {
        await sleep(420);
        const dzh = await q(COLLECT_ZH);
        if (dzh.length) { leftovers.push([`${name} › 详情抽屉`, dzh]); fail(`「${name}」展开详情抽屉后仍有 ${dzh.length} 条中文`); }
      }
    }
    if (thin.length) fail(`这些标签页内容过少，可能是没渲染（0 残留不可信）：${thin.join(', ')}`);
    else pass('9 个标签页内容都足够厚（防「没渲染 = 0 残留」的假绿）');

    if (leftovers.length) {
      console.log('\n—— 残留清单（供补词条）——');
      for (const [name, zh] of leftovers) {
        console.log(`\n【${name}】`);
        for (const l of zh) console.log('   ' + l);
      }
    }

    // 切回中文：确认能还原。**要回到同一个标签页再比** —— 基线是在概览页量的。
    await q(`document.querySelector('.wb-lang').click()`);
    await sleep(600);
    await q(`(() => { const b = document.querySelectorAll('.wb-tab')[0]; if (b) b.click(); })()`);
    await sleep(550);
    const back = await q(COLLECT_ZH);
    if (back.length >= zhBaseline.length - 2) pass(`切回中文可还原（${back.length} 条，基线 ${zhBaseline.length}）`);
    else fail(`切回中文没还原：只剩 ${back.length} 条（基线 ${zhBaseline.length}）`);

    // 切回中文后指示框也要重新量（另一个方向）
    const fitZh = await q(INDICATOR_FIT);
    for (const f of fitZh) {
      const worst = Math.max(Math.abs(f.dx), Math.abs(f.dy), Math.abs(f.dw), Math.abs(f.dh));
      if (worst <= 2) pass(`切回中文后指示框仍包住当前项：${f.sel}`);
      else fail(`切回中文后指示框没重新量：${f.sel} 偏差 dw=${f.dw}`);
    }

    const errs = await q(`window.__errors || []`);
    if (!errs.length) pass('无页面运行时报错');
    else fail('页面报错：' + errs.join(' | '));
  } finally {
    try { page.close(); } catch { /* 忽略 */ }
    pageServer.close();
  }
}

try {
  await runPass('checked', PORT + 2, 9336);
  await runPass('unchecked', PORT + 3, 9338);
} finally {
  server.close();
}

console.log(`\n${failures ? '✗ 失败 ' + failures + ' 项' : '✓ 全部通过'}`);
process.exit(failures ? 1 : 0);
