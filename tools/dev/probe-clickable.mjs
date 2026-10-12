/**
 * 全量「可交互元素是否真的可点」排查。
 *
 *   node tools/dev/probe-clickable.mjs
 *
 * ## 为什么要有它
 *
 * 上一轮修的「下拉点不开」属于一类**静默**故障：元素在 DOM 里、看起来好好的，
 * 但点击落不到它身上（那次是 label 转发把刚开的菜单关了）。这类 bug 不会报错，
 * 读代码也看不出来 —— 只能**量**。
 *
 * 而且它暴露了排查方式本身的缺陷：早先的检查"只测第一个 + 只看 DOM 里有没有"。
 * 所以这里改成**全量**：所有可交互元素逐个量。
 *
 * ## 判据（三条，都不需要真的点击，因此无副作用）
 *
 * 1. **命中测试**：`elementFromPoint(中心)` 拿到的必须是它自己或它的后代。
 *    被浮层（吸顶条、提示气泡、遮罩）盖住 → 用户点不到。
 * 2. **尺寸**：宽高都不为 0。
 * 3. **可见**：不在 `display:none` / `visibility:hidden` 的容器里。
 *
 * 只量**当前可见视图**：没激活的页签面板不渲染，量它们只会得到一堆"不可见"。
 */
import { startStaticServer, openPage, waitFor, q, sleep } from './ui-harness.mjs';
import { baseRoutes } from './fixtures.mjs';

const PORT = 8813;
const server = await startStaticServer(PORT);
const { cdp, close } = await openPage(`http://127.0.0.1:${PORT}/`, baseRoutes(), { width: 1280, height: 900, cdpPort: 9394 });

/**
 * 逐个量。注意：**每个元素都要先滚进视口**再量 —— 视口外的元素
 * `elementFromPoint` 必然返回别的东西，那是假阳性。
 */
const SCAN_VIEW = `(() => {
  const SEL = 'button, a[href], input:not([type=hidden]), select, textarea, summary, [role=button], [role=tab], [role=switch], [tabindex]:not([tabindex="-1"])';
  const out = [];
  for (const el of document.querySelectorAll(SEL)) {
    // 只量真正可见的（含祖先链）
    let vis = true;
    for (let p = el; p && p !== document.documentElement; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) { vis = false; break; }
      /*
       * **闭合的 DETAILS 要跳过**：Chrome 用 content-visibility: hidden 渲染它，
       * 子元素的 getBoundingClientRect() **仍然有值**，但 elementFromPoint
       * 会返回 null（点在视口外/未渲染区）—— 于是全被报成"被盖住"。
       * 实测：折叠的「手动接入」里 5 个客户端芯片就是这么误报的。
       *
       * （这段在模板字符串里，**注释不能带反引号**，否则会提前闭包 —— 本项目
       *  这一步已经踩了四次，别再写。）
       */
      if (p.tagName === 'DETAILS' && !p.open) { vis = false; break; }
    }
    if (!vis) continue;
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) {
      out.push({ why: 'zero-size', tag: el.tagName.toLowerCase(), cls: String(el.className || '').slice(0, 30),
        id: el.id || '', text: (el.textContent || '').trim().slice(0, 24) });
      continue;
    }
    const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
    const hit = document.elementFromPoint(cx, cy);
    const ok = !!hit && (hit === el || el.contains(hit) || (hit.contains && hit.contains(el)));
    if (!ok) {
      out.push({ why: 'covered', tag: el.tagName.toLowerCase(), cls: String(el.className || '').slice(0, 30),
        id: el.id || '', text: (el.textContent || '').trim().slice(0, 24),
        hitTag: hit ? hit.tagName.toLowerCase() : null,
        hitCls: hit ? String(hit.className || '').slice(0, 30) : null,
        at: Math.round(cx) + ',' + Math.round(cy) });
    }
  }
  return JSON.stringify({ total: document.querySelectorAll(SEL).length, bad: out });
})()`;

const VIEWS = [
  { name: '全部面板', setup: `switchTab('all')` },
  { name: '概览', setup: `switchTab('overview')` },
  { name: '模型', setup: `switchTab('models')` },
  { name: '对话测试', setup: `switchTab('playground')` },
  { name: '客户端接入', setup: `switchTab('clients')` },
  { name: '日志抽屉', setup: `(() => { const d = document.getElementById('logDrawer'); if (d) { d.open = true; d.dispatchEvent(new Event('toggle')); } })()` },
];

try {
  await waitFor(cdp, `document.querySelectorAll('.nav-tab').length >= 4`, 10000, '页签');
  await sleep(1000);

  let totalBad = 0;
  for (const v of VIEWS) {
    await q(cdp, v.setup);
    /*
     * 等切页签的**滑入动画**落定再量。
     *
     * 第一版只睡 700ms，结果量到动画中途：`switchTab` 会给 section 加
     * `slide-right`，transform 期间 `elementFromPoint` 命中的是**那个 section**
     * 而不是按钮本身 —— 于是"复制"按钮被报成被 `<h2>` / `<section>` 盖住。
     *
     * ⚠️ 但**不能无条件等所有动画**：页面上有三处 infinite 动画
     * （状态点呼吸光晕 `elegant-pulse`、骨架屏 `sk-shimmer`、请求指示器
     * `reqpulse`），`animation.finished` 对它们**永远不会 settle** ——
     * 实测整个探针会在这里静默挂死（跑 10 分钟零输出，端口还被占着）。
     * 所以：只等**有限次数**的动画，另加 3 秒硬上限兜底 ——
     * 以后再加新的无限动画也不会把探针卡住。
     */
    await sleep(700);
    await q(cdp, `Promise.race([
      Promise.all(document.getAnimations()
        .filter((a) => { const t = a.effect && a.effect.getTiming ? a.effect.getTiming().iterations : 1; return t !== Infinity; })
        .map((a) => a.finished.catch(() => {}))).then(() => true),
      new Promise((r) => setTimeout(() => r(true), 3000)),
    ])`).catch(() => {});
    await sleep(200);
    const r = JSON.parse(await q(cdp, SCAN_VIEW));
    console.log(`\n── ${v.name}：共 ${r.total} 个可交互元素 ──`);
    const covered = r.bad.filter((b) => b.why === 'covered');
    const zero = r.bad.filter((b) => b.why === 'zero-size');
    if (!r.bad.length) console.log('  ✓ 全部可点');
    for (const b of covered) {
      totalBad += 1;
      console.log(`  ✗ 被盖住 <${b.tag}${b.id ? '#' + b.id : ''}.${b.cls}> 「${b.text}」 @(${b.at}) → 命中的是 <${b.hitTag}.${b.hitCls}>`);
    }
    for (const b of zero) {
      totalBad += 1;
      console.log(`  ✗ 零尺寸 <${b.tag}${b.id ? '#' + b.id : ''}.${b.cls}> 「${b.text}」`);
    }
  }
  console.log(`\n=== ${totalBad} 个元素点不到 ===`);
} finally { close(); server.close(); }
