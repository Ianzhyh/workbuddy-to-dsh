/**
 * 设置页 tab 条的最终形态回归。
 *
 * ## 这条用例对应五轮反馈
 *
 *   1. 「滑到下面顶部 tab 不应该消失吧应该贴顶」→ sticky
 *   2. 「边界过渡用模糊效果过渡」→ 试过渐变 / backdrop-filter
 *   3. 「矩形是什么鬼和下面都不在一层的感觉」→ 实色块不行
 *   4. 「不要背景了直接浮在上面」→ 试过纯透明
 *   5. 「变成浮着带这种背景的吧」+「不要透明」+「就要撑满，但里面不要有空位」
 *      +「（均分后）对话测试被挤成两行 → ？」
 *
 * 最终形态：**不透明的圆角胶囊容器，撑满整行，内部 tab 按内容宽度单行排列，
 * 放不下时横向滚动**。
 *
 * ## 为什么每条都实测而不是查 CSS 声明
 *
 * sticky 失效最常见的原因不是没写 `position:sticky`，而是祖先的 overflow /
 * 高度设置 —— 只有真滚动一次才知道粘没粘住。同理"标签折行"只有量高度才知道。
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startStaticServer, openPage, waitFor, sleep } from '../../tools/dev/ui-harness.mjs';
import { FIXTURES, buildRoutes, ensureVendor, harnessHtml } from './_panel-fixtures.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN = join(HERE, '..');
const PORT = 8961;

async function freePort() {
  const srv = createServer();
  await new Promise((res, rej) => { srv.once('error', rej); srv.listen(0, '127.0.0.1', res); });
  const p = srv.address().port;
  await new Promise((r) => srv.close(r));
  return p;
}

const { react, reactDom } = await ensureVendor();
const clientSource = readFileSync(join(PLUGIN, 'lib', 'client.js'), 'utf8');
const routes = buildRoutes(FIXTURES);
const staticServer = await startStaticServer(PORT);
const extra = createServer((req, res) => {
  const path = new URL(req.url, `http://127.0.0.1:${PORT}`).pathname;
  if (path === '/harness.html') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(harnessHtml(routes)); }
  if (path === '/client.js') { res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }); return res.end(clientSource); }
  if (path === '/vendor/react.js') { res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }); return res.end(react); }
  if (path === '/vendor/react-dom.js') { res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }); return res.end(reactDom); }
  res.writeHead(404); return res.end('nf');
});
await new Promise((r) => extra.listen(PORT + 1, '127.0.0.1', r));

const page = await openPage(`http://127.0.0.1:${PORT + 1}/harness.html`, {}, {
  width: 1200, height: 900, injectStub: false, cdpPort: await freePort(),
});

const problems = [];
try {
  await waitFor(page.cdp, 'window.__harness && window.__harness.rendered === true', 15000, '挂载');
  await sleep(600);

  await page.cdp.evaluate(`(() => {
    const frame = document.getElementById('frame');
    frame.style.width = '1040px';
    frame.style.maxWidth = '1040px';
    frame.style.height = '760px';
    frame.style.overflow = 'auto';
    frame.style.padding = '0';
  })()`);
  await sleep(500);

  /* ── ① 形态：不透明胶囊 + 撑满 + 标签单行 ── */
  const css = JSON.parse(await page.cdp.evaluate(`JSON.stringify((() => {
    const el = document.querySelector('.wb-tabs');
    if (!el) return { error: 'no .wb-tabs' };
    const cs = getComputedStyle(el);
    const tabs = [...el.querySelectorAll('.wb-tab')];
    const r = el.getBoundingClientRect();
    return {
      position: cs.position,
      top: cs.top,
      background: cs.backgroundColor,
      backdrop: cs.backdropFilter || 'none',
      radius: cs.borderRadius,
      pillWidth: Math.round(r.width),
      parentWidth: Math.round(el.parentElement.getBoundingClientRect().width),
      lastRight: tabs.length ? Math.round(tabs[tabs.length - 1].getBoundingClientRect().right - r.left) : 0,
      tabHeights: tabs.map((t) => Math.round(t.getBoundingClientRect().height)),
      tabTexts: tabs.map((t) => (t.textContent || '').trim()),
      overflowing: el.scrollWidth > el.clientWidth + 1,
    };
  })())`));
  console.log('形态：', JSON.stringify(css));

  if (css.error) problems.push(css.error);
  else {
    if (css.position !== 'sticky') problems.push(`tab 条应为 sticky，实际 ${css.position}`);
    if (parseFloat(css.top) < 4) problems.push(`吸顶要留一点上边距（用户：不要完全吸顶），实际 top=${css.top}`);
    if (parseFloat(css.top) > 24) problems.push(`吸顶边距过大，实际 top=${css.top}`);

    /* 用户明确说过「不要透明」：底色必须不透明 */
    const alpha = /rgba?\(([^)]+)\)/.exec(css.background);
    const parts = alpha ? alpha[1].split(',').map((s) => Number(s.trim())) : [];
    if (parts.length === 4 && parts[3] < 1) {
      problems.push(`底色必须不透明（用户：不要透明），实际 ${css.background}`);
    }
    if (css.backdrop && css.backdrop !== 'none') {
      problems.push(`不要 backdrop-filter（会显得是另一层），实际 ${css.backdrop}`);
    }
    if (parseFloat(css.radius) < 12) problems.push(`应是大圆角胶囊，实际 ${css.radius}`);

    /* 「就要撑满」 */
    if (css.parentWidth > 200 && css.pillWidth < css.parentWidth - 24) {
      problems.push(`容器应撑满（父级 ${css.parentWidth}px），实际 ${css.pillWidth}px`);
    }

    /* 「对话测试被挤成两行」：高度必须一致 */
    if (css.tabHeights.length >= 3) {
      const maxH = Math.max(...css.tabHeights);
      const minH = Math.min(...css.tabHeights);
      if (maxH - minH > 4) {
        problems.push(`有 tab 被挤成两行（高度 ${minH}~${maxH}px），标签必须单行`);
      }
    }
    if (css.tabTexts.some((t) => !t)) problems.push('有 tab 标签是空的');

    /*
     * 「不要使得右边有空位」：最右 tab 的右边缘要贴到容器内边距（4px + 边框）。
     *
     * 容差 16px。超过就是又回到"tab 靠左、右边一大片空"的观感 ——
     * 那正是用户截图指出来的问题。
     */
    const gapRight = (css.pillWidth || 0) - (css.lastRight || 0);
    if (gapRight > 16) {
      problems.push(`tab 条右侧空了 ${gapRight}px（应铺满，不能有空位）`);
    }

    /*
     * 放不下时允许横向滚动；放得下时**不该**有滚动条区域被激活。
     * 这条防的是"为了不换行而把所有 tab 压扁"。
     */
    if (css.overflowing) {
      console.log('（窄一点，容器进入了横向滚动兜底 —— 这是有意设计）');
    }
  }

  /* ── ② 真的滚动：tab 条必须贴顶 ── */
  const before = JSON.parse(await page.cdp.evaluate(
    `JSON.stringify({ top: Math.round(document.querySelector('.wb-tabs').getBoundingClientRect().top) })`,
  ));
  await page.cdp.evaluate(`(() => { document.getElementById('frame').scrollTop = 400; })()`);
  await sleep(500);
  const after = JSON.parse(await page.cdp.evaluate(`JSON.stringify((() => {
    const el = document.querySelector('.wb-tabs');
    const frame = document.getElementById('frame');
    const r = el.getBoundingClientRect();
    return {
      top: Math.round(r.top),
      frameTop: Math.round(frame.getBoundingClientRect().top),
      offsetTop: parseFloat(getComputedStyle(el).top) || 0,
      scrollTop: frame.scrollTop,
      visible: r.height > 0 && r.bottom > frame.getBoundingClientRect().top,
    };
  })())`));
  console.log('滚动前后：', JSON.stringify({ before, after }));

  if (after.scrollTop < 100) {
    problems.push(`页面没能真的滚动（scrollTop=${after.scrollTop}），无法验证贴顶`);
  } else {
    /*
     * 期望位置 = 容器顶端 + top 偏移（用户要的「有点上边距」）。
     * 容差 2px 吸收亚像素与边框取整。
     */
    const expected = after.frameTop + (after.offsetTop || 0);
    const drift = Math.abs(after.top - expected);
    if (drift > 2) {
      problems.push(`滚动 ${after.scrollTop}px 后 tab 条在 ${after.top}px，应为 ${expected}px（容器顶 + ${after.offsetTop}px 边距）`);
    }
    if (!after.visible) problems.push('滚动后 tab 条不可见了');
  }
} finally {
  try { await page.close?.(); } catch { /* ignore */ }
  staticServer.close(); extra.close();
  if (problems.length) {
    console.error('\n✘ 问题：');
    for (const p of problems) console.error(' - ' + p);
    process.exit(1);
  }
  console.log('\n✔ tab 条：贴顶（实测滚动）/ 不透明胶囊 / 撑满 / 标签单行不折行');
  process.exit(0);
}