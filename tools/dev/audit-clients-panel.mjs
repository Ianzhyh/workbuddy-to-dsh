/**
 * 「客户端接入」面板的多维度量化审计。
 *
 *   node tools/dev/audit-clients-panel.mjs
 *
 * 目的：**先量再改**。把可访问性、交互、性能、多设备、视觉五个维度的现状
 * 测成数字，据此定优化目标和验收标准，而不是凭感觉调样式。
 *
 * 不启真控制台、不消耗上游额度：静态服务 + 无头 Chromium，`/api/*` 全打桩。
 */
import { startStaticServer, openPage, waitFor, q, sleep } from './ui-harness.mjs';

const PORT = 8786;
const URL_ = `http://127.0.0.1:${PORT}/`;

const CLIENTS = {
  running: true,
  host: '127.0.0.1',
  port: 8790,
  baseUrlOpenAI: 'http://127.0.0.1:8790/v1',
  baseUrlAnthropic: 'http://127.0.0.1:8790',
  token: 'wb-local-bridge',
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

/** 在页面里注入的测量工具：对比度、有效背景、可聚焦性。 */
const MEASURE_HELPERS = `
window.__AUDIT = {
  parseRgb(s) {
    const m = String(s).match(/rgba?\\(([^)]+)\\)/);
    if (!m) return null;
    const p = m[1].split(',').map(x => parseFloat(x.trim()));
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  },
  // WCAG 相对亮度
  lum(c) {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  },
  contrast(a, b) {
    const l1 = this.lum(a), l2 = this.lum(b);
    const hi = Math.max(l1, l2), lo = Math.min(l1, l2);
    return (hi + 0.05) / (lo + 0.05);
  },
  // 沿祖先链找第一个不透明背景（半透明要与其下背景混合）
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
    // 从下往上依次混合
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
    // 文字色若半透明，先与背景混合
    const f = fg.a >= 0.999 ? fg : {
      r: bg.r * (1 - fg.a) + fg.r * fg.a,
      g: bg.g * (1 - fg.a) + fg.g * fg.a,
      b: bg.b * (1 - fg.a) + fg.b * fg.a,
    };
    return { ratio: this.contrast(f, bg), size: parseFloat(cs.fontSize), weight: cs.fontWeight };
  },
};
`;

const server = await startStaticServer(PORT);
const { cdp, close } = await openPage(URL_, routes, { inject: `window.__FIX = ${JSON.stringify(FIX)};${MEASURE_HELPERS}`, width: 1440, height: 1000 });
const cleanup = () => { try { cdp.close(); } catch { /* 忽略 */ } try { server.close(); } catch { /* 忽略 */ } };
process.on('exit', cleanup);

const line = (s) => console.log('\n' + '═'.repeat(64) + '\n' + s + '\n' + '═'.repeat(64));

await q(cdp, `document.querySelector('.nav-tab[data-tab="clients"]').click()`);
await waitFor(cdp, `document.querySelectorAll('#clientsBox .clientcard').length >= 4`, 8000, '面板渲染');

// ── A. 可访问性 ─────────────────────────────────────────────────────────
line('A. 可访问性');

for (const theme of ['light', 'dark']) {
  await q(cdp, `document.documentElement.setAttribute('data-theme','${theme}')`);
  await sleep(150);
  const rows = await q(cdp, `(() => {
    const sel = {
      '字段名 .formrow-k': '#clientsBox .formrow-k',
      '说明 .formrow-h': '#clientsBox .formrow-h',
      '值 .formrow-v': '#clientsBox .formrow-v',
      '卡片说明 .clientcard-note': '#clientsBox .clientcard-note',
      '章节标题 .clienth': '#clientsBox .clienth',
      '分组标题 .fggh': '#clientsBox .fggh',
      '兼容性 chip': '#clientsBox .clientchip',
      '代码块 .codeblock pre': '#clientsBox .codeblock pre',
      '代码块头 .codeblock-head': '#clientsBox .codeblock-head',
      '值行说明 .valuerow-h': '#clientsBox .valuerow-h',
    };
    const out = [];
    for (const [label, s] of Object.entries(sel)) {
      const el = document.querySelector(s);
      if (!el) { out.push({ label, missing: true }); continue; }
      const m = window.__AUDIT.ratioOf(el);
      out.push({ label, ratio: m ? Number(m.ratio.toFixed(2)) : null, size: m ? m.size : null, weight: m ? m.weight : null });
    }
    return out;
  })()`);
  console.log(`\n  [${theme}]`);
  for (const r of rows) {
    if (r.missing) { console.log(`    ${r.label.padEnd(26)} 元素不存在`); continue; }
    // WCAG AA：正文 <18.66px(14pt) 需 4.5:1；大字或粗体 ≥14pt 需 3:1
    const large = r.size >= 18.66 || (r.size >= 14 && Number(r.weight) >= 700);
    const need = large ? 3 : 4.5;
    const mark = r.ratio >= need ? '✅' : (r.ratio >= 3 ? '⚠️ ' : '❌');
    console.log(`    ${mark} ${r.label.padEnd(26)} ${String(r.ratio).padStart(5)}:1  (${r.size}px/${r.weight}, 需 ${need}:1)`);
  }
}

await q(cdp, `document.documentElement.setAttribute('data-theme','light')`);
await sleep(150);

const kb = await q(cdp, `(() => {
  // 量整个面板 section（live region 是 #clientsBox 的兄弟节点，只量 box 会漏掉）
  const panel = document.querySelector('[data-section="clients"]');
  const box = document.getElementById('clientsBox');
  const btns = [...box.querySelectorAll('button')];
  const names = btns.map(b => (b.getAttribute('aria-label') || b.textContent || '').trim());
  const dupNames = names.filter((n, i) => names.indexOf(n) !== i);

  // 命中区：视觉 rect 是 24px，但伪元素 ::after 会往外扩。两者取并集才是真实可点范围。
  // 注意 getComputedStyle(el, '::after').inset 在 Chromium 里读不到简写值，
  // 必须逐边读 top/right/bottom/left（负值 = 向外扩）。
  const hit = (el) => {
    const r = el.getBoundingClientRect();
    const a = getComputedStyle(el, '::after');
    if (!a.content || a.content === 'none') return { w: r.width, h: r.height };
    const t = parseFloat(a.top) || 0;
    const b = parseFloat(a.bottom) || 0;
    const l = parseFloat(a.left) || 0;
    const rr = parseFloat(a.right) || 0;
    return { w: r.width - l - rr, h: r.height - t - b };
  };
  const tiny = btns.map(b => {
    const h = hit(b);
    return { w: Math.round(h.w), h: Math.round(h.h), text: (b.textContent || '').trim() };
  }).filter(t => t.h < 32 || t.w < 32);

  // 鼠标专用的值块（故意不进 Tab 顺序，旁边有带可访问名的按钮兜底）
  const chips = [...box.querySelectorAll('.formrow-v, .valuerow-v')];

  return {
    totalButtons: btns.length,
    uniqueNames: [...new Set(names)].length,
    duplicateNames: dupNames.length,
    tinyTargets: tiny.length,
    tinySample: tiny.slice(0, 3),
    mouseOnlyChips: chips.length,
    chipsInTabOrder: chips.filter(c => c.hasAttribute('tabindex')).length,
    ariaLive: panel.querySelectorAll('[aria-live]').length,
    withAriaLabel: box.querySelectorAll('[aria-label]').length,
    liveRole: (panel.querySelector('[aria-live]') || {}).getAttribute
      ? panel.querySelector('[aria-live]').getAttribute('role') : null,
  };
})()`);
console.log('\n  键盘与语义：');
console.log(`    按钮总数              ${kb.totalButtons}，不同可访问名 ${kb.uniqueNames}，重名 ${kb.duplicateNames} ${kb.duplicateNames === 0 ? '✅' : '❌'}`);
console.log(`    带 aria-label         ${kb.withAriaLabel} ${kb.withAriaLabel === kb.totalButtons ? '✅' : '❌'}`);
console.log(`    含 aria-live          ${kb.ariaLive}（role=${kb.liveRole}） ${kb.ariaLive > 0 ? '✅' : '❌'}`);
console.log(`    有效命中区 < 32px     ${kb.tinyTargets} ${kb.tinyTargets === 0 ? '✅' : '⚠️ '}${JSON.stringify(kb.tinySample)}`);
console.log(`    鼠标专用值块          ${kb.mouseOnlyChips} 个，其中进 Tab 顺序 ${kb.chipsInTabOrder} 个（刻意保持 0，避免 20 行 × 2 个焦点停靠点）`);

// ── B. 交互流程：复制反馈是否可见 ───────────────────────────────────────
line('B. 交互流程');

const fb = await q(cdp, `(() => {
  const box = document.getElementById('clientsBox');
  const all = [...box.querySelectorAll('.codeblock-head button.copybtn')];
  const target = all[all.length - 1];
  target.scrollIntoView({ block: 'center' });
  return { scrolled: Math.round(window.scrollY), targetTop: Math.round(target.getBoundingClientRect().top) };
})()`);
await sleep(200);

// 点长面板**最底部**那个复制按钮：顶部提示条此时完全够不着
await q(cdp, `(() => {
  const box = document.getElementById('clientsBox');
  const all = [...box.querySelectorAll('.codeblock-head button.copybtn')];
  all[all.length - 1].click();
})()`);
await sleep(150);

const fbResult = await q(cdp, `(() => {
  const box = document.getElementById('clientsBox');
  const all = [...box.querySelectorAll('.codeblock-head button.copybtn')];
  const btn = all[all.length - 1];
  const br = btn.getBoundingClientRect();
  const live = document.getElementById('clientsLive');
  const msg = document.querySelector('.actions .msg');
  return {
    btnText: (btn.textContent || '').trim(),
    btnVisible: br.top >= 0 && br.bottom <= window.innerHeight,
    liveText: live ? (live.textContent || '') : '(无 live 区域)',
    liveAria: live ? live.getAttribute('aria-live') : null,
    topBarTop: msg ? Math.round(msg.getBoundingClientRect().top) : null,
  };
})()`);
console.log(`  滚到底部后 scrollY = ${fb.scrolled}`);
console.log(`  就地反馈：按钮文本="${fbResult.btnText}"，按钮在视口内=${fbResult.btnVisible ? '✅' : '❌'}`);
console.log(`  屏幕阅读器播报：live="${fbResult.liveText}"（aria-live=${fbResult.liveAria}）${fbResult.liveText ? '✅' : '❌'}`);
console.log(`  顶部提示条 top=${fbResult.topBarTop}px → ${fbResult.topBarTop >= 0 ? '在视口内' : '在视口外（所以只靠它不可靠）'}`);

await sleep(1800);
const restored = await q(cdp, `(() => {
  const box = document.getElementById('clientsBox');
  const all = [...box.querySelectorAll('.codeblock-head button.copybtn')];
  return (all[all.length - 1].textContent || '').trim();
})()`);
console.log(`  1.8 秒后按钮文本恢复为 "${restored}" ${restored === '复制' ? '✅' : '❌'}`);

// ── C. 性能 ─────────────────────────────────────────────────────────────
line('C. 性能');

const perf = await q(cdp, `(() => {
  const box = document.getElementById('clientsBox');
  const count = (el) => el.querySelectorAll('*').length;
  const t0 = performance.now();
  renderClients();
  const t1 = performance.now();
  return {
    domNodes: count(box),
    rerenderMs: Number((t1 - t0).toFixed(2)),
    docNodes: document.querySelectorAll('*').length,
    fullRenderMs: (() => { const a = performance.now(); renderClients(); return Number((performance.now() - a).toFixed(2)); })(),
  };
})()`);
console.log(`  面板 DOM 节点数      ${perf.domNodes}`);
console.log(`  整页 DOM 节点数      ${perf.docNodes}`);
console.log(`  renderClients() 耗时 ${perf.rerenderMs} ms / ${perf.fullRenderMs} ms`);

const apiTiming = await q(cdp, `(async () => {
  const t0 = performance.now();
  await fetch('/api/clients', { headers: { 'x-workbuddy-panel': '1' } }).then(r => r.json());
  return Number((performance.now() - t0).toFixed(1));
})()`);
console.log(`  /api/clients 往返     ${apiTiming} ms（打桩值；真实值受 bridgeModels(8000) 影响）`);

// ── D. 多设备兼容性 ─────────────────────────────────────────────────────
line('D. 多设备兼容性');

const VIEWPORTS = [320, 360, 414, 480, 600, 768, 834, 1024, 1280, 1920];
console.log('  视口     文档溢出   pre 横向滚动  窄元素(<44px)  字段名截断');
for (const w of VIEWPORTS) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: 900, deviceScaleFactor: 1, mobile: w < 768 });
  await sleep(180);
  const r = await q(cdp, `(() => {
    const box = document.getElementById('clientsBox');
    const de = document.documentElement;
    const pres = [...box.querySelectorAll('pre')];
    const scrollers = pres.filter(p => p.scrollWidth > p.clientWidth + 1).length;
    const maxPreOverflow = pres.reduce((m, p) => Math.max(m, p.scrollWidth - p.clientWidth), 0);
    const small = [...box.querySelectorAll('button, .formrow-v, .valuerow-v, .clientchip')]
      .map(e => e.getBoundingClientRect())
      .filter(r => r.width > 0 && (r.height < 32))
      .length;
    const clipped = [...box.querySelectorAll('.formrow-k, .valuerow-k')]
      .filter(e => e.scrollWidth > e.clientWidth + 1).length;
    const outside = [...box.querySelectorAll('*')]
      .filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.right > de.clientWidth + 1; }).length;
    return { docOverflow: de.scrollWidth - de.clientWidth, scrollers, maxPreOverflow, small, clipped, outside };
  })()`);
  const ok = r.docOverflow <= 1 && r.outside === 0;
  console.log(`  ${String(w).padStart(5)}px  ${String(r.docOverflow).padStart(6)}px  ${String(r.scrollers).padStart(9)} 个  ${String(r.small).padStart(9)} 个  ${String(r.clipped).padStart(8)} 个  ${ok ? '' : '❌'}`);
}
await cdp.send('Emulation.clearDeviceMetricsOverride');

// ── E. 视觉 ─────────────────────────────────────────────────────────────
line('E. 视觉');

const vis = await q(cdp, `(() => {
  const box = document.getElementById('clientsBox');
  const sizes = {};
  for (const el of box.querySelectorAll('*')) {
    if (!el.textContent || !el.textContent.trim()) continue;
    const fs = parseFloat(getComputedStyle(el).fontSize);
    sizes[fs] = (sizes[fs] || 0) + 1;
  }
  return { sizes, minFont: Math.min(...Object.keys(sizes).map(Number)) };
})()`);
console.log(`  字号分布：${JSON.stringify(vis.sizes)}`);
// 阈值 11.5px：控制台的标签类元素（.tag / .fggh / .stamp）统一在这个尺寸，
// 是刻意的设计值而不是遗漏。低于它才算问题 —— 阈值设成 12 会一直误报，
// 久了就没人看这条了。
console.log(`  最小字号：${vis.minFont}px ${vis.minFont >= 11.5 ? '✅' : '⚠️ 低于 11.5px'}`);

cleanup();
console.log('\n审计完成。');
