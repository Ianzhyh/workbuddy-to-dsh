/**
 * 面板 i18n（中 / 英）验收。
 *
 *   node dsh-plugin/tests/panel-i18n.test.mjs
 *
 * 断言：切到英文后，**9 个标签页里可见的中文数 = 0**（文本节点 + 悬停可见的属性）。
 * 与控制台同一套判据 —— 「某句话等于某个英文」那种断言挡不住新增界面，
 * 而「可见中文 = 0」会自动把新界面纳入检查。
 *
 * ## 桩数据里的中文会被换成 ASCII
 *
 * 否则「上游返回的中文」与「漏翻的界面文案」在扫描结果里分不开。
 * 换掉之后，**扫到的任何中文都只可能来自 client.js 的界面文案** ——
 * 这正是这条断言想要的性质。
 *
 * 桩数据与渲染骨架来自 `_panel-fixtures.mjs`（与 panel-render.mjs 共用一份，
 * 避免两份桩漂移 —— 桩一漂移，两边验的就不是同一个东西了）。
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startStaticServer, openPage, waitFor, sleep } from '../../tools/dev/ui-harness.mjs';
import { FIXTURES, buildRoutes, ensureVendor, harnessHtml } from './_panel-fixtures.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN = join(HERE, '..');
const PORT = 8796;

let failures = 0;
const fail = (m) => { console.error('✗ ' + m); failures += 1; };
const pass = (m) => console.log('✓ ' + m);

/** 面板的 9 个标签页（顺序与 client.js 的 TABS 一致）。 */
const TAB_COUNT = 9;

/** 把桩数据里的中文换成 ASCII：见文件头说明。 */
function asciiData(value) {
  if (typeof value === 'string') return value.replace(/[\u4e00-\u9fff]+/g, 'X');
  if (Array.isArray(value)) return value.map(asciiData);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = asciiData(v);
    return out;
  }
  return value;
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
  return { count: out.length, sample: out.filter((s) => /[A-Za-z]/.test(s)).slice(0, 5) };
})()`;

// 路由桩与截图脚本共用一份；桩里的中文换成 ASCII，见文件头说明
const routes = asciiData(buildRoutes(FIXTURES));
const clientSource = readFileSync(join(PLUGIN, 'lib', 'client.js'), 'utf8');
const { react, reactDom } = await ensureVendor();

const server = await startStaticServer(PORT);
const extra = createServer((req, res) => {
  const path = new URL(req.url, `http://127.0.0.1:${PORT}`).pathname;
  if (path === '/harness.html') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(harnessHtml(routes)); }
  if (path === '/client.js') { res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }); return res.end(clientSource); }
  if (path === '/vendor/react.js') { res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }); return res.end(react); }
  if (path === '/vendor/react-dom.js') { res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }); return res.end(reactDom); }
  res.writeHead(404); res.end('not found');
});
await new Promise((resolve) => extra.listen(PORT + 1, '127.0.0.1', resolve));

const page = await openPage(`http://127.0.0.1:${PORT + 1}/harness.html`, {}, { width: 900, height: 1400, injectStub: false, cdpPort: 9336 });
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
  const langBtn = await q(`!!document.querySelector('.wb-lang')`);
  if (langBtn) pass('面板右上角有语言开关');
  else fail('找不到语言开关 .wb-lang');
  await q(`document.querySelector('.wb-lang').click()`);
  await sleep(700);
  const label = await q(`(document.querySelector('.wb-lang') || {}).textContent || ''`);
  if (label.trim() === '中') pass('切到英文后按钮显示「中」（表示可切回）');
  else fail(`语言按钮文案不对：${label}`);

  // 逐个标签页扫
  const leftovers = [];
  const thin = [];
  for (let i = 0; i < TAB_COUNT; i += 1) {
    await q(`(() => { const b = document.querySelectorAll('.wb-tab')[${i}]; if (b) b.click(); })()`);
    await sleep(550);
    const zh = await q(COLLECT_ZH);
    const stats = await q(TEXT_STATS);
    const name = await q(`(() => { const b = document.querySelectorAll('.wb-tab')[${i}]; return b ? b.textContent : '?'; })()`);
    // 「0 残留」也可能是**内容没渲染**造成的假绿 —— 所以同时要求内容够厚
    if (stats.count < 12) thin.push(`${name}(${stats.count})`);
    if (zh.length === 0) pass(`标签页 ${i + 1}/9「${name}」无残留中文（${stats.count} 个文本节点）`);
    else { leftovers.push([name, zh]); fail(`标签页 ${i + 1}/9「${name}」仍有 ${zh.length} 条中文`); }
    if (stats.sample.length) console.log(`      ↳ 样本：${stats.sample.join(' / ').slice(0, 110)}`);
  }
  if (thin.length) fail(`这些标签页内容过少，可能是没渲染（0 残留不可信）：${thin.join(', ')}`);
  else pass(`9 个标签页内容都足够厚（防「没渲染 = 0 残留」的假绿）`);

  if (leftovers.length) {
    console.log('\n—— 残留清单（供补词条）——');
    for (const [name, zh] of leftovers) {
      console.log(`\n【${name}】`);
      for (const l of zh) console.log('   ' + l);
    }
  }

  // 切回中文：确认能还原。**要回到同一个标签页再比** —— 基线是在概览页量的，
  // 停在第 9 页（日志）去比必然对不上。
  await q(`document.querySelector('.wb-lang').click()`);
  await sleep(600);
  await q(`(() => { const b = document.querySelectorAll('.wb-tab')[0]; if (b) b.click(); })()`);
  await sleep(550);
  const back = await q(COLLECT_ZH);
  if (back.length >= zhBaseline.length - 2) pass(`切回中文可还原（${back.length} 条，基线 ${zhBaseline.length}）`);
  else fail(`切回中文没还原：只剩 ${back.length} 条（基线 ${zhBaseline.length}）`);

  const errs = await q(`window.__errors || []`);
  if (!errs.length) pass('无页面运行时报错');
  else fail('页面报错：' + errs.join(' | '));
} finally {
  try { page.close(); } catch { /* 忽略 */ }
  server.close();
  extra.close();
}

console.log(`\n${failures ? '✗ 失败 ' + failures + ' 项' : '✓ 全部通过'}`);
process.exit(failures ? 1 : 0);
