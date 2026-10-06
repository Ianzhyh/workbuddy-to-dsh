/**
 * 交互流程与性能审计。
 *
 *   node tools/dev/audit-ux.mjs
 *
 * 目标：把「用户要完成一件事需要几步、首屏能看到什么、页面运行时有多重」
 * 量成数字，据此定优化目标 —— 而不是凭感觉说"这里不够顺"。
 *
 * 桩数据来自共享夹具（形状由 ui-harness 自动校验）。
 */
import { startStaticServer, openPage, waitFor, q, sleep } from './ui-harness.mjs';
import { baseRoutes } from './fixtures.mjs';

const PORT = 8781;
const URL_ = `http://127.0.0.1:${PORT}/`;

let pass = (m) => console.log('  ✓ ' + m);
let fail = (m) => console.log('  ✗ ' + m);
const server = await startStaticServer(PORT);
const { cdp, close } = await openPage(URL_, baseRoutes(), { width: 1280, height: 800 });
const cleanup = () => { try { cdp.close(); } catch { /* 忽略 */ } try { server.close(); } catch { /* 忽略 */ } };
process.on('exit', cleanup);

const line = (s) => console.log('\n' + '═'.repeat(70) + '\n' + s + '\n' + '═'.repeat(70));

await waitFor(cdp, `document.querySelectorAll('#clientsBox .clientpicker button').length >= 4`, 8000, '首屏就绪');

// ── 1. 加载性能 ─────────────────────────────────────────────────────────
line('1. 加载性能');

const perf = await q(cdp, `(() => {
  const nav = performance.getEntriesByType('navigation')[0] || {};
  const paints = {};
  for (const p of performance.getEntriesByType('paint')) paints[p.name] = Math.round(p.startTime);
  const res = performance.getEntriesByType('resource');
  return {
    ttfb: Math.round(nav.responseStart || 0),
    domInteractive: Math.round(nav.domInteractive || 0),
    domComplete: Math.round(nav.domComplete || 0),
    firstPaint: paints['first-paint'] || null,
    firstContentfulPaint: paints['first-contentful-paint'] || null,
    domNodes: document.querySelectorAll('*').length,
    transferKB: Math.round(res.reduce((s, r) => s + (r.transferSize || 0), 0) / 1024),
    resourceCount: res.length,
  };
})()`);
console.log(`  TTFB                 ${perf.ttfb} ms`);
console.log(`  DOMContentLoaded     ${perf.domInteractive} ms`);
console.log(`  load 完成            ${perf.domComplete} ms`);
console.log(`  首次绘制             ${perf.firstPaint} ms`);
console.log(`  首次内容绘制 (FCP)    ${perf.firstContentfulPaint} ms`);
console.log(`  DOM 节点数           ${perf.domNodes}`);
console.log(`  资源数 / 传输量       ${perf.resourceCount} 个 / ${perf.transferKB} KB`);

// 渲染开销：各面板重建一次要多久
const renderCost = await q(cdp, `(() => {
  const bench = (name, fn) => { const t = performance.now(); fn(); return { name, ms: Number((performance.now() - t).toFixed(2)) }; };
  const out = [];
  if (typeof renderClients === 'function') out.push(bench('客户端接入面板', renderClients));
  if (typeof renderModels === 'function') out.push(bench('模型表', renderModels));
  if (typeof loadUsage === 'function') out.push(bench('用量（含图表）', () => { /* 异步，另测 */ }));
  return out;
})()`);
console.log('\n  重建开销：');
for (const r of renderCost) console.log(`    ${r.name.padEnd(18)} ${r.ms} ms`);

// ── 2. 空闲时的请求量（验证轮询门控）────────────────────────────────────
line('2. 空闲 30 秒内的网络请求');

await q(cdp, `window.__REQ = []; (() => { const o = window.fetch; window.fetch = (...a) => { window.__REQ.push(String(a[0])); return o.apply(window, a); }; })()`);
await sleep(30000);
const reqs = await q(cdp, `window.__REQ`);
const byPath = {};
for (const r of reqs) { const p = String(r).split('?')[0]; byPath[p] = (byPath[p] || 0) + 1; }
console.log(`  30 秒内共 ${reqs.length} 个请求（约 ${(reqs.length * 2).toFixed(0)} 个/分钟）`);
for (const [p, n] of Object.entries(byPath).sort((a, b) => b[1] - a[1])) {
  console.log(`    ${String(n).padStart(3)} 次  ${p}`);
}

// 切到后台应停止
await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 }).catch(() => {});
await q(cdp, `Object.defineProperty(document, 'hidden', { value: true, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); window.__REQ = [];`);
await sleep(25000);
const hiddenReqs = await q(cdp, `window.__REQ.length`);
console.log(`\n  标记为隐藏后 25 秒：${hiddenReqs} 个请求 ${hiddenReqs === 0 ? '✅ 已停' : '❌ 仍在轮询'}`);
await q(cdp, `Object.defineProperty(document, 'hidden', { value: false, configurable: true }); document.dispatchEvent(new Event('visibilitychange'));`);

// ── 3. 首屏能看到什么（不滚动）──────────────────────────────────────────
line('3. 首屏信息清单（1280×800，不滚动）');

const firstScreen = await q(cdp, `(() => {
  const vh = window.innerHeight;
  const seen = [];
  for (const el of document.querySelectorAll('h2, .card .k, button, .nav-tab')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (r.top >= 0 && r.bottom <= vh) {
      seen.push({ tag: el.tagName.toLowerCase(), text: (el.textContent || '').trim().slice(0, 22) });
    }
  }
  return { vh, seen, docHeight: document.documentElement.scrollHeight };
})()`);
console.log(`  视口高 ${firstScreen.vh}px，文档总高 ${firstScreen.docHeight}px（可滚 ${(firstScreen.docHeight / firstScreen.vh).toFixed(1)} 屏）`);
console.log('  首屏可见的可操作元素：');
for (const s of firstScreen.seen.slice(0, 24)) console.log(`    [${s.tag}] ${s.text}`);
if (firstScreen.seen.length > 24) console.log(`    …共 ${firstScreen.seen.length} 个`);

// ── 4. 关键任务的步数 ───────────────────────────────────────────────────
line('4. 关键任务要几步');

const flow = await q(cdp, `(() => {
  const steps = {};
  const tabs = [...document.querySelectorAll('.nav-tab')];
  const panelOf = (name) => document.querySelector('[data-section="' + name + '"]');

  // 任务 A：找到「怎么接 Claude Code」
  // 首屏有没有直接指向？没有的话要点几下
  let a = 0;
  const clientTab = tabs.find((t) => t.dataset.tab === 'clients');
  if (!clientTab) return { error: '找不到客户端接入页签' };
  // 该页签是否在首屏
  const tr = clientTab.getBoundingClientRect();
  const tabInFirstScreen = tr.top >= 0 && tr.bottom <= window.innerHeight;
  a += tabInFirstScreen ? 0 : 1;   // 需要滚动
  a += 1;                          // 点页签
  steps['接 Claude Code：找到配置片段'] = a;

  // 任务 B：拿到 Base URL 并复制
  clientTab.click();
  const cards = document.querySelectorAll('#clientsBox .clientcard');
  steps['接 Claude Code：定位到具体片段'] = cards.length;
  const btns = document.querySelectorAll('#clientsBox button.mini');
  steps['接 Claude Code：面板内复制按钮总数'] = btns.length;

  // 任务 C：桥挂了要恢复
  const alertBar = document.getElementById('alertBar');
  const alertVisible = alertBar && alertBar.offsetHeight > 0;
  steps['桥挂了：告警条是否可见'] = alertVisible ? '可见' : '不可见（要自己发现）';

  // 任务 D：日常看一眼用量
  let d = 0;
  const usagePanel = panelOf('overview');
  if (usagePanel) {
    const r = usagePanel.getBoundingClientRect();
    if (r.top > window.innerHeight) d += 1;   // 要滚动
  }
  steps['看用量：进入页面后滚动次数'] = d;

  return { steps, tabCount: tabs.length, panelCount: document.querySelectorAll('[data-section]').length };
})()`);
console.log(`  页签 ${fixture(f => 0) === 0 ? '' : ''}共 ${flow.tabCount} 个，面板 ${flow.panelCount} 块`);
for (const [k, v] of Object.entries(flow.steps)) console.log(`    ${k.padEnd(34)} ${v}`);

function fixture() { return 0; }

// ── 5. 可发现性：页面自己有没有告诉用户下一步 ──────────────────────────
line('5. 可发现性');

const discover = await q(cdp, `(() => {
  const text = document.body.innerText;
  return {
    // 注意：这里量的是**当前状态**（dsh 已配）下页面有没有引导。
    // 引导条是状态相关的，完整的状态机断言在第 6 节。
    hasNextStepHint: /下一步|首次使用|建议先|开始使用/.test(text),
    alertBarPresent: !!document.getElementById('alertBar'),
    nextStepBarPresent: !!document.getElementById('nextStepBar'),
    panelCount: document.querySelectorAll('[data-section]').length,
    emptyStates: document.querySelectorAll('.empty').length,
  };
})()`);
console.log(`  引导条元素存在：${discover.nextStepBarPresent ? '✅ 有' : '❌ 没有'}`);
console.log(`  当前状态（dsh 已配）下可见的引导文案：${discover.hasNextStepHint ? '有' : '无（符合预期，见第 6 节）'}`);
console.log(`  空状态元素数：${discover.emptyStates}`);
console.log(`  默认展示的面板数：${discover.panelCount}`);

// ── 6. 「下一步」引导条的状态机 ─────────────────────────────────────────
line('6. 「下一步」引导条');

/** 在给定状态下的桩数据里打开页面，返回引导条状态。 */
async function probeNextStep(opts, label) {
  const s = await startStaticServer(PORT + 1);
  const { cdp: c2, close: close2 } = await openPage(
    `http://127.0.0.1:${PORT + 1}/`, baseRoutes(opts), { width: 1280, height: 800 },
  );
  await sleep(1200);
  const r = await q(c2, `(() => {
    const bar = document.getElementById('nextStepBar');
    const btn = [...bar.querySelectorAll('button')].map((b) => b.textContent.trim());
    return {
      hidden: bar.hidden,
      text: (bar.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60),
      buttons: btn,
      // 跳转按钮真的能切页签吗
      switched: (() => {
        const go = [...bar.querySelectorAll('button')].find((b) => b.textContent.includes('接客户端'));
        if (!go) return null;
        go.click();
        return document.querySelector('.nav-tab.active')?.dataset.tab || null;
      })(),
    };
  })()`);
  console.log(`  [${label}] ${r.hidden ? '隐藏' : '显示'}  ${r.hidden ? '' : '｜按钮：' + r.buttons.join(' / ')}`);
  if (!r.hidden) console.log(`      ${r.text}`);
  if (r.switched) console.log(`      点「去接客户端」后活动页签 → ${r.switched}`);
  close2();
  s.close();
  return r;
}

// 桥在跑 + dsh 未配置 → 应该出现（这是唯一「两种接入都没走通」的状态）
const nsShow = await probeNextStep({ dshReady: false }, '桥在跑 · dsh 未配');
if (!nsShow.hidden) pass('桥就绪但未接入时显示引导');
else fail('桥就绪但未接入时**没有**显示引导 —— 新用户仍无指引');
if (nsShow.switched === 'clients') pass('「去接客户端」能跳到客户端接入页签');
else fail(`「去接客户端」没有跳转（活动页签 = ${nsShow.switched}）`);

// dsh 已配置 → 应该隐藏（日常用户不该被引导条占地方）
const nsHide = await probeNextStep({ dshReady: true }, '桥在跑 · dsh 已配');
if (nsHide.hidden) pass('已接入后自动隐藏，不占日常用户的地方');
else fail('已接入后仍然显示引导');

// 桥没跑 → 隐藏（告警条已经在说这件事，不重复）
const nsDown = await probeNextStep({ bridgeRunning: false, dshReady: false }, '桥未运行');
if (nsDown.hidden) pass('桥未运行时隐藏（由告警条负责，不重复提示）');
else fail('桥未运行时仍显示引导 —— 与告警条重复');

cleanup();
console.log('\n审计完成。');
