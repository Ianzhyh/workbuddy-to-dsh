/**
 * 探针：量一下英文模式下头部副标题（`.sub`）到底被切掉多少。
 *
 *   node tools/dev/probe-sub-clamp.mjs
 *
 * 背景：`.sub` 是 `max-height: 48px; overflow: hidden`，中文两行刚好装下，
 * 英文译文长一截 —— 第三行被**硬切**（截图里能看到字被横腰截断，且没有省略号）。
 * 这个脚本给出真实几何（scrollHeight vs clientHeight / 实际行数），
 * 免得改 CSS 时凭猜数值。
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startStaticServer, openPage, waitFor, q, sleep } from './ui-harness.mjs';
import { baseRoutes } from './fixtures.mjs';

const PORT = 8796;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 取 .sub 的几何 + 行盒信息。 */
const MEASURE = `(() => {
  const el = document.querySelector('.sub');
  if (!el) return null;
  const cs = getComputedStyle(el);
  const lh = parseFloat(cs.lineHeight);
  const r = el.getBoundingClientRect();
  // Range 拿到的是**真实文本行盒**，比 scrollHeight 更能说明"渲染成了几行"
  const range = document.createRange();
  range.selectNodeContents(el);
  const lines = [...range.getClientRects()].filter((x) => x.width > 1 && x.height > 1);
  return {
    lang: document.documentElement.lang,
    text: el.textContent.trim().slice(0, 48) + '…',
    chars: el.textContent.trim().length,
    maxHeight: cs.maxHeight,
    lineHeight: lh,
    lineCount: lines.length,
    lastLineBottom: lines.length ? Math.round(lines[lines.length - 1].bottom - r.top) : 0,
    boxHeight: Math.round(r.height),
    clientHeight: el.clientHeight,
    scrollHeight: el.scrollHeight,
    overflow: el.scrollHeight > el.clientHeight + 1,
    clippedPx: Math.max(0, el.scrollHeight - el.clientHeight),
    width: Math.round(r.width),
  };
})()`;

const server = await startStaticServer(PORT);
for (const width of [1280, 420]) {
  const { cdp, close } = await openPage(`http://127.0.0.1:${PORT}/`, baseRoutes(), { width, height: 780 });
  try {
    await waitFor(cdp, `!!document.querySelector('.sub')`, 10000, '副标题存在');
    // 从英文开始，点一下切换
    await q(cdp, `(function(){ var t = document.getElementById('langToggle'); if (t) t.click(); })()`);
    await sleep(300);

    console.log(`\n${'='.repeat(52)}\n视口宽 ${width}px\n${'='.repeat(52)}`);
    for (const lang of ['en', 'zh']) {
      if (lang === 'zh') {
        await q(cdp, `(function(){ var t = document.getElementById('langToggle'); if (t) t.click(); })()`);
        await sleep(300);
      }
      const m = await q(cdp, MEASURE);
      console.log(`\n[${m.lang}] ${m.chars} 字符，宽 ${m.width}px`);
      console.log(`  渲染行数=${m.lineCount}  盒子高=${m.boxHeight}  scrollHeight=${m.scrollHeight}`);
      console.log(m.overflow
        ? `  ❌ 被截断：溢出 ${m.clippedPx}px`
        : `  ✅ 完整显示（最后一行底边 ${m.lastLineBottom}px ≤ 盒底 ${m.boxHeight}px）`);
    }

    // 折叠态：is-scrolled 必须把副标题收到 0（头部变矮是刻意的滚动反馈）
    await q(cdp, `document.getElementById('topBarSticky').classList.remove('is-scrolled')`);
    // 切回英文再截图（循环最后一轮停在中文）
    await q(cdp, `(function(){ var t = document.getElementById('langToggle'); if (t) t.click(); })()`);
    await sleep(400);

    // 存档一张头部截图（英文模式），改这块 CSS 时肉眼可比
    const shot = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      clip: { x: 0, y: 0, width, height: 140, scale: 2 },
    });
    const out = join(ROOT, `.backup`, `sub-clamp-${width}-en.png`);
    writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
    console.log(`\n📸 ${out}`);

    await q(cdp, `document.getElementById('topBarSticky').classList.add('is-scrolled')`);
    await sleep(500);
    const c = await q(cdp, `(() => { const e = document.querySelector('.sub'); return { h: Math.round(e.getBoundingClientRect().height), op: getComputedStyle(e).opacity }; })()`);
    console.log(`\n[折叠态] 高度=${c.h}px opacity=${c.op} ${c.h === 0 ? '✅ 已收起' : '❌ 没收起'}`);
  } finally {
    await close();
  }
}
server.close();

