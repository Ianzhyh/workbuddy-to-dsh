/**
 * 动效审计：量「哪些交互真的在动、动的是不是安全属性、无障碍降级有没有生效」。
 *
 *   node tools/dev/audit-motion.mjs
 *
 * 为什么要有这个：动效最容易出的三个问题是**看不见的** ——
 *   1. 写了 animation 却因为元素一直在 DOM 里（只切 display）而永远不触发；
 *   2. 动了 width / height / top 这类会触发布局的属性，长列表上直接掉帧；
 *   3. 没做 prefers-reduced-motion 降级，对前庭功能敏感的用户是真实伤害。
 * 三个都读代码看不出来，只能实测。
 */
import { startStaticServer, openPage, waitFor, q, sleep } from './ui-harness.mjs';
import { baseRoutes } from './fixtures.mjs';

const PORT = 8778;
let failures = 0;
const pass = (m) => console.log('  ✓ ' + m);
const fail = (m) => { console.error('  ✗ ' + m); failures += 1; };
const line = (s) => console.log('\n' + '═'.repeat(70) + '\n' + s + '\n' + '═'.repeat(70));

const server = await startStaticServer(PORT);
const { cdp, close } = await openPage(`http://127.0.0.1:${PORT}/`, baseRoutes(), { width: 1280, height: 800 });
const cleanup = () => { try { cdp.close(); } catch { /* 忽略 */ } try { server.close(); } catch { /* 忽略 */ } };
process.on('exit', cleanup);
await waitFor(cdp, `document.querySelectorAll('#clientsBox .clientpicker button').length >= 4`, 8000, '就绪');

// ── 1. 无障碍降级 ───────────────────────────────────────────────────────
line('1. prefers-reduced-motion 降级');

const reduceRule = await q(cdp, `(() => {
  // 找出样式表里所有 prefers-reduced-motion 规则
  let hits = 0;
  let kills = 0;
  for (const ss of document.styleSheets) {
    let rules; try { rules = ss.cssRules; } catch { continue; }
    for (const r of rules) {
      if (r.type === CSSRule.MEDIA_RULE && r.conditionText && r.conditionText.includes('prefers-reduced-motion')) {
        hits += 1;
        for (const inner of r.cssRules) {
          if (inner.style && (inner.style.animationDuration || inner.style.transitionDuration)) kills += 1;
        }
      }
    }
  }
  return { mediaRules: hits, neutralizingDecls: kills };
})()`);
if (reduceRule.mediaRules > 0 && reduceRule.neutralizingDecls > 0) {
  pass(`存在 prefers-reduced-motion 规则（${reduceRule.mediaRules} 条媒体查询 / ${reduceRule.neutralizingDecls} 条归零声明）`);
} else {
  fail('缺少 prefers-reduced-motion 降级 —— 对前庭功能敏感的用户是真实伤害');
}

// 真的生效吗：模拟该偏好，量一个已知有过渡的元素的 transition-duration
await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
await sleep(200);
const reducedDur = await q(cdp, `(() => {
  const el = document.querySelector('.nav-tab') || document.body;
  const cs = getComputedStyle(el);
  return { transition: cs.transitionDuration, animation: cs.animationDuration };
})()`);
const reduced = parseFloat(reducedDur.transition) < 0.01 && parseFloat(reducedDur.animation) < 0.01;
if (reduced) pass(`开启「减少动态效果」后过渡被归零（transition=${reducedDur.transition}）`);
else fail(`开启「减少动态效果」后过渡仍为 ${reducedDur.transition} —— 媒体查询没覆盖到`);
await cdp.send('Emulation.setEmulatedMedia', { features: [] });
await sleep(200);

// ── 2. 关键交互是否真的在动 ─────────────────────────────────────────────
line('2. 关键交互的实测动画');

/**
 * 触发一次交互，只报**这次新触发的**动画。
 *
 * 不能直接数「页面上正在跑的动画」—— 常驻的呼吸光晕（`elegant-pulse`）与
 * 其它元素上尚未结束的过渡都会被算进来，结果是「每个交互都有一堆动画」，
 * 完全分不清是不是这个交互触发的。所以先拍快照、触发、再取差集。
 */
async function measure(label, setup, trigger) {
  await q(cdp, setup);
  await sleep(250);
  const got = await q(cdp, `(() => {
    const snap = () => {
      const m = new Map();
      for (const el of document.querySelectorAll('*')) {
        for (const a of el.getAnimations()) m.set(a, el);
      }
      return m;
    };
    const before = snap();
    ${trigger}
    const after = snap();
    const anims = [];
    for (const [a, el] of after) if (!before.has(a)) anims.push(a);
    return anims.map((a) => {
      const eff = a.effect && a.effect.getKeyframes ? a.effect.getKeyframes() : [];
      const props = new Set();
      for (const k of eff) for (const p of Object.keys(k)) if (!['offset', 'computedOffset', 'easing'].includes(p)) props.add(p);
      return { name: a.animationName || '(transition)', dur: Math.round(a.effect?.getTiming?.().duration || 0), props: [...props] };
    });
  })()`);
  const running = got.filter((a) => a.dur > 0);
  if (running.length === 0) { fail(`${label}：没有任何动画在跑（交互是突变的）`); return []; }
  const props = [...new Set(running.flatMap((a) => a.props))];
  pass(`${label}：${running.length} 个动画在跑（${running.map((a) => a.name).slice(0, 3).join(', ')}）`);
  return props;
}

const allProps = [];
allProps.push(...await measure('页签切换', `switchTab('overview')`, `switchTab('clients')`));
allProps.push(...await measure('客户端页签切换', `clientsChoice = 'opencode'; renderClients()`, `clientsChoice = 'form'; renderClients()`));
allProps.push(...await measure('模型芯片勾选', `renderClients()`, `
  const c = document.querySelector('#clientsBox .modelpick-chip');
  if (c) c.click();
`));
// 前置状态要回到有代码块的那个页签 —— 上一次测量把面板切到「图形表单」了
allProps.push(...await measure('配置块折叠/展开', `clientsChoice = 'opencode'; renderClients()`, `
  const t = document.querySelector('#clientsBox .codeblock-toggle');
  if (t) t.click();
`));

// 伸缩是不是真的平滑：折叠过程中连续采样高度，应当看到**中间值**
// （如果只是 display:none 硬切，只会看到「原高」和「0」两个值）
await q(cdp, `clientsChoice = 'opencode'; renderClients()`);
await sleep(300);
const expandTrace = await q(cdp, `(async () => {
  const block = document.querySelector('#clientsBox .codeblock');
  const body = block.querySelector('.codeblock-body');
  const toggle = block.querySelector('.codeblock-toggle');
  const h0 = Math.round(body.getBoundingClientRect().height);
  toggle.click();                       // 收起
  const samples = [];
  for (let i = 0; i < 14; i++) {
    await new Promise((r) => requestAnimationFrame(r));
    samples.push(Math.round(body.getBoundingClientRect().height));
  }
  const h1 = samples[samples.length - 1];
  toggle.click();                       // 恢复
  const mid = samples.filter((h) => h > 1 && h < h0 - 1).length;
  return { h0, h1, mid, samples: samples.slice(0, 6) };
})()`);
console.log(`  折叠过程采样：起始 ${expandTrace.h0}px → 结束 ${expandTrace.h1}px，中间值 ${expandTrace.mid} 个`);
console.log(`    前几帧高度：${expandTrace.samples.join(' → ')}`);
if (expandTrace.mid >= 3) pass(`伸缩是平滑的（采到 ${expandTrace.mid} 个中间高度，不是硬切）`);
else fail(`伸缩不平滑：只有起始与结束两个值（中间值 ${expandTrace.mid} 个）—— 说明是 display 硬切`);

// ── 3. 动的是不是安全属性（不触发 layout）────────────────────────────────
line('3. 动画属性是否安全（不触发布局）');

const LAYOUT_PROPS = ['width', 'height', 'top', 'left', 'right', 'bottom', 'margin', 'padding', 'font-size', 'border-width', 'grid-template-rows'];
const unsafe = [...new Set(allProps)].filter((p) => LAYOUT_PROPS.some((l) => p.startsWith(l)));
console.log(`  实测到的动画属性：${[...new Set(allProps)].sort().join(', ') || '（无）'}`);
if (unsafe.length === 0) pass('全部动的是 transform / opacity / 颜色类属性（合成层友好）');
else console.log(`  · 涉及布局属性：${unsafe.join(', ')}（若在长列表上会掉帧，需确认是刻意为之）`);

// ── 4. 缓动曲线是否统一 ─────────────────────────────────────────────────
line('4. 缓动曲线统一性');

// 必须用 getComputedStyle：样式表里写的是 `var(--ease)`，读原始文本只能拿到
// 字面量 `var(--ease)`，永远匹配不到 cubic-bezier。
const easings = await q(cdp, `(() => {
  const seen = new Map();
  for (const el of document.querySelectorAll('*')) {
    const cs = getComputedStyle(el);
    if (cs.transitionDuration === '0s' || !cs.transitionProperty || cs.transitionProperty === 'none') continue;
    // 直接取整串：多属性过渡会返回逗号分隔的多个曲线，逐条拆要处理括号里的逗号，
    // 得不偿失 —— 这里只关心「有没有偏离统一曲线」，整串比对足够。
    const t = (cs.transitionTimingFunction || '').trim();
    if (t) seen.set(t, (seen.get(t) || 0) + 1);
  }
  return [...seen.entries()].sort((a, b) => b[1] - a[1]);
})()`);
console.log('  实际生效的缓动曲线（按使用元素数）：');
for (const [t, n] of easings) console.log(`    ${String(n).padStart(4)} 个元素  ${t}`);
const curves = easings.map(([t]) => t);
const offSpec = curves.filter((t) => t.includes('cubic-bezier') && !t.includes('0.16, 1, 0.3, 1'));
if (curves.length === 0) fail('没有任何元素带过渡');
else if (offSpec.length === 0) pass('所有 cubic-bezier 都用统一的 --ease 曲线');
else console.log(`  · 另有曲线（需确认是刻意的）：${offSpec.join(' | ')}`);

cleanup();
console.log(failures === 0 ? '\n动效审计全部通过' : `\n${failures} 项需要处理`);
process.exit(failures === 0 ? 0 : 1);
