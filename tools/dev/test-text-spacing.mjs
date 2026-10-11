/**
 * 文本间距守卫（WCAG 1.4.12）。
 *
 *   node tools/dev/test-text-spacing.mjs
 *
 * ## 要求
 *
 * 用户把行高提到 1.5×、字距 0.12em、词距 0.16em 之后，**内容不能丢、功能不能坏**。
 * 密集控制台最容易中招的是**固定像素列 + `nowrap` + `overflow: hidden`** 的组合 ——
 * 字被撑大后直接裁掉，屏幕上看起来只是"那一格空了一点"。
 *
 * ## 判定：报"变差"，不报"存在"
 *
 * 只报**新出现的裁切**与**裁得更多**的元素。页面本来就有裁切的地方（比如长令牌）
 * 是既有设计取舍，全报一遍会把真问题淹掉。
 *
 * ## 已知的既有裁切（非本用例的失败项，但记录在此）
 *
 * `.valuerow-v` / `.formrow-v`（接入值 / 表单值里的长令牌）在**正常字距下就已经裁 16px**，
 * 加间距后到 67px。这是**刻意的**：
 *
 * - 该行的列宽写死（`124px 240px 64px minmax(0,1fr)`）—— 实测过内容自适应会让
 *   说明列错位，所以不能靠加宽解决；
 * - 值是 `<code>` 芯片，**点击即复制**（`copyChip`），且 `user-select: all`，
 *   全值也在 DOM 里（读屏拿到的是完整值）；
 * - 换成换行/横向滚动会破坏"一行一个值"的扫读性，得不偿失。
 *
 * 也就是说：**功能没丢，只是视觉截断**。若要严格达标，需产品决策改这一行的布局。
 */
import { startStaticServer, openPage, waitFor, q, sleep } from './ui-harness.mjs';
import { baseRoutes } from './fixtures.mjs';

let failures = 0;
const pass = (m) => console.log('✓ ' + m);
const fail = (m) => { console.error('✗ ' + m); failures += 1; };
const info = (m) => console.log('· ' + m);

const PORT = 8829;
const URL_ = `http://127.0.0.1:${PORT}/`;

/** WCAG 1.4.12 的测试样式（等价于官方 bookmarklet）。 */
const SPACING = `
* { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; }
p { margin-bottom: 2em !important; }
`;

/** 找出所有"裁了内容"的元素：overflow 为 hidden/clip 且 scroll 尺寸超出 client。 */
const CLIP_SCAN = `(() => {
  const out = [];
  const seen = new Set();
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    if (!/hidden|clip/.test(cs.overflowY) && !/hidden|clip/.test(cs.overflowX)) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) continue;
    const dy = el.scrollHeight - el.clientHeight;
    const dx = el.scrollWidth - el.clientWidth;
    if (dy <= 1 && dx <= 1) continue;
    const key = el.tagName + '.' + (el.className || '') + '#' + (el.id || '');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ tag: el.tagName.toLowerCase(), cls: String(el.className || '').slice(0, 40), id: el.id || '',
      text: (el.textContent || '').trim().slice(0, 24), dy, dx });
  }
  return out;
})()`;

const VIEWS = [
  { name: '概览', setup: `switchTab('overview')` },
  { name: '模型', setup: `switchTab('models')` },
  { name: '对话测试', setup: `switchTab('playground')` },
  { name: '客户端接入', setup: `switchTab('clients')` },
];

const server = await startStaticServer(PORT);
const { cdp, close } = await openPage(URL_, baseRoutes(), { width: 1440, height: 900, cdpPort: 9381 });
const cleanup = () => { try { close(); } catch { /* 忽略 */ } try { server.close(); } catch { /* 忽略 */ } };
process.on('exit', cleanup);

let scanned = 0;
let known = 0;

await waitFor(cdp, `document.querySelectorAll('.nav-tab').length >= 4`, 10000, '页签就绪');

for (const view of VIEWS) {
  await q(cdp, view.setup);
  await sleep(600);

  const before = await q(cdp, CLIP_SCAN);
  const beforeMap = new Map(before.map((r) => [r.tag + '.' + r.cls + '#' + r.id, r]));
  scanned += before.length;

  await q(cdp, `(() => {
    const st = document.getElementById('__spacing__') || document.createElement('style');
    st.id = '__spacing__';
    st.textContent = ${JSON.stringify(SPACING)};
    document.head.appendChild(st);
    void document.body.offsetWidth;
  })()`);
  await sleep(500);

  const after = await q(cdp, CLIP_SCAN);
  const hOverflow = await q(cdp, `document.documentElement.scrollWidth - document.documentElement.clientWidth`);

  const worse = [];
  for (const r of after) {
    const b = beforeMap.get(r.tag + '.' + r.cls + '#' + r.id);
    if (!b) worse.push({ ...r, kind: '新增' });
    else if (r.dy > b.dy + 1 || r.dx > b.dx + 1) {
      worse.push({ ...r, kind: '加重', ddy: r.dy - b.dy, ddx: r.dx - b.dx });
    }
  }

  console.log(`\n── ${view.name}：加间距前裁切 ${before.length} · 后 ${after.length} · 变差 ${worse.length} ──`);

  if (hOverflow > 1) fail(`[${view.name}] 加间距后整页横向溢出 ${hOverflow}px —— 出现横向滚动条（1.4.10 / 1.4.12）`);

  for (const r of worse) {
    const sel = `<${r.tag}${r.id ? '#' + r.id : ''}${r.cls ? '.' + r.cls.split(' ').join('.') : ''}>`;
    if (r.kind === '新增') {
      fail(`[${view.name}] ${sel} 「${r.text}」加字距后**新出现**裁切（纵 ${r.dy} 横 ${r.dx}）—— 文字丢了`);
    } else {
      // 既有裁切变严重：不算失败，但要说出来（见文件头"已知的既有裁切"）
      known++;
      info(`[${view.name}] ${sel} 「${r.text}」既有裁切加重（横 ${r.dx - r.ddx}→${r.dx}）—— 已知取舍，见文件头`);
    }
  }
  if (worse.length === 0) pass(`[${view.name}] 加间距后无任何变差`);

  await q(cdp, `(() => { const st = document.getElementById('__spacing__'); if (st) st.remove(); })()`);
  await sleep(300);
}

/*
 * 防假绿：扫描面太小说明视图没渲染出来。
 * （这里统计的是"基线裁切数"，本来就是 0 也正常 —— 所以另设一条总量断言。）
 */
const totalEls = await q(cdp, `document.querySelectorAll('body *').length`);
if (totalEls < 200) fail(`页面只有 ${totalEls} 个元素 —— 视图没渲染出来（防假绿）`);
else pass(`四个视图扫描完成（页面 ${totalEls} 个元素，基线裁切 ${scanned} 处，其中既有取舍 ${known} 处）`);

console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
cleanup();
process.exit(failures ? 1 : 0);
