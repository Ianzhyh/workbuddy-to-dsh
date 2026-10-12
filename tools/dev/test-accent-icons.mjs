/**
 * 视觉对齐守卫：**控件图标的颜色必须走令牌**（不得写死在 SVG data-URI 里）。
 *
 *   node tools/dev/test-accent-icons.mjs
 *
 * ## 这条守卫的来历（真实缺陷）
 *
 * 自绘下拉的箭头原先画在一枚 SVG data-URI 里，颜色**写死**成上一套设计系统的
 * 皇家蓝（浅色 `#2563eb` / 深色 `#3b82f6`）与冷灰（`#64748b` / `#94a3b8`）。
 * data-URI 里的颜色改不了 —— 于是：
 *
 *   1. **不跟随配色方案**：切到陶土 / 苔绿 / 雾紫 / 青绿时全站都跟着变，
 *      只有这个箭头还是蓝的；
 *   2. **不跟随主题的中性色系**：暖纸底上压着两档冷灰，跟整页不一个调。
 *
 * 这种缺陷**读代码看不出来**（`stroke='%232563eb'` 混在一串 URL 编码里），
 * 页面上也不报错 —— 只有把"当前方案的主色"和"箭头实际渲染色"对起来量才发现。
 *
 * ## 两道检查
 *
 * 1. **静态**：样式与页面里不允许再出现"带写死颜色的图标 data-URI"。
 *    唯一的例外是 `mask-image` —— mask 只取图形的 alpha 通道，颜色由
 *    `background-color` 决定，图形里写什么色都无效（见 style.css 注释）。
 * 2. **运行时**：5 套配色 × 2 主题逐个量箭头**实际渲染色**，
 *    必须分别等于 `--muted`（空闲）与 `--primary`（悬停 / 展开），
 *    且**绝不能等于**旧皇家蓝的那两个值。
 *
 * 量之前必须 `withTransitionsOff`（箭头颜色本身是过渡属性）——
 * 否则读到的是过渡起始帧（本项目在对比度扫描上踩过同一个坑）。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startStaticServer, openPage, waitFor, q, sleep } from './ui-harness.mjs';
import { baseRoutes } from './fixtures.mjs';
import { withTransitionsOff, ACCENT_IDS } from './contrast-scan.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = 8835;

let failures = 0;
const fail = (m) => { console.error('✗ ' + m); failures += 1; };
const pass = (m) => console.log('✓ ' + m);

// ── 一、静态守卫：不许有写死颜色的图标 data-URI ──────────────────────────
{
  const FILES = ['dashboard/public/style.css', 'dashboard/public/index.html'];
  let hits = 0;
  let masked = 0;
  for (const rel of FILES) {
    const lines = readFileSync(join(ROOT, rel), 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      if (!line.includes('data:image/svg+xml')) return;
      // mask 例外：颜色由 background-color 决定，图形里的色值不参与渲染
      if (/mask-image\s*:/.test(line)) { masked += 1; return; }
      // 写死的颜色：%23 是 URL 编码的 '#'；也兜住没编码的写法
      if (/(%23|#)[0-9a-fA-F]{3}/.test(line)) {
        hits += 1;
        fail(`${rel}:${i + 1} 图标 data-URI 里写死了颜色 —— 它不会跟随主题 / 配色方案`);
        console.error(`    ${line.trim().slice(0, 120)}…`);
      }
    });
  }
  if (!hits) pass(`静态扫描：${FILES.join(' / ')} 中没有写死颜色的图标 data-URI（mask 例外 ${masked} 处）`);

  // 防假绿：这条守卫的前提是"图标确实用 mask 实现"，一个 mask 都没有说明实现被整体撤掉了
  if (masked === 0) fail('一处 mask-image 都没有 —— 箭头实现被撤掉了？（静态扫描此刻等于空跑）');
  else pass(`mask 实现存在（${masked} 处），静态扫描不是空跑`);
}

// ── 二、运行时：5 套配色 × 2 主题，箭头实际渲染色必须跟着令牌走 ────────
const OLD_ROYAL = ['rgb(37, 99, 235)', 'rgb(59, 130, 246)']; // 旧设计系统残留色，绝不允许再出现

const server = await startStaticServer(PORT);
const { cdp, close } = await openPage(`http://127.0.0.1:${PORT}/`, baseRoutes(), { width: 1440, height: 900, cdpPort: 9399 });
const cleanup = () => { try { cdp.close(); } catch { /* 忽略 */ } try { server.close(); } catch { /* 忽略 */ } };
process.on('exit', cleanup);

/** 把某个 CSS 变量的**解析结果**用一枚探针元素量出来（hex 与 rgb 不好直接比）。 */
const tokenRgb = (name) => q(cdp, `(() => {
  const el = document.getElementById('__probe_token__') || Object.assign(document.createElement('span'), { id: '__probe_token__' });
  el.style.color = 'var(${name})';
  if (!el.isConnected) document.body.appendChild(el);
  return getComputedStyle(el).color;
})()`);

const arrowNow = () => q(cdp, `(() => {
  const a = document.querySelector('.dd .dd-arrow');
  if (!a) return null;
  const cs = getComputedStyle(a);
  return { bg: cs.backgroundColor, mask: cs.webkitMaskImage || cs.maskImage, w: a.getBoundingClientRect().width };
})()`);

try {
  await waitFor(cdp, `document.querySelectorAll('.dd .dd-arrow').length >= 9`, 10000, '自绘下拉就绪');
  await sleep(300);

  await withTransitionsOff(cdp, async () => {
    let checked = 0;
    for (const theme of ['light', 'dark']) {
      for (const accent of ACCENT_IDS) {
        await q(cdp, `(() => {
          document.documentElement.setAttribute('data-theme', '${theme}');
          document.documentElement.setAttribute('data-accent', '${accent}');
          window.ddCloseAll && window.ddCloseAll();
          return true;
        })()`);
        await sleep(60);

        const wantIdle = await tokenRgb('--muted');
        const wantActive = await tokenRgb('--primary');
        const info = await arrowNow();
        if (!info || !(info.w > 0)) { fail(`[${theme}/${accent}] 找不到箭头元素（或尺寸为 0）`); continue; }

        // 空闲态
        if (info.bg === wantIdle) pass(`[${theme}/${accent}] 空闲箭头 = --muted ${wantIdle}`);
        else fail(`[${theme}/${accent}] 空闲箭头 = ${info.bg}，应为 --muted ${wantIdle}`);
        if (OLD_ROYAL.includes(info.bg)) fail(`[${theme}/${accent}] 空闲箭头又出现了旧皇家蓝 ${info.bg}`);

        // 展开态（.dd.open）
        await q(cdp, `(() => { const t = document.querySelector('.dd .dd-trigger'); t.click(); return true; })()`);
        await sleep(60);
        const open = await arrowNow();
        const isOpen = await q(cdp, `!!document.querySelector('.dd.open')`);
        if (!isOpen) { fail(`[${theme}/${accent}] 下拉没打开，展开态量不到`); continue; }
        if (open.bg === wantActive) pass(`[${theme}/${accent}] 展开箭头 = --primary ${wantActive}`);
        else fail(`[${theme}/${accent}] 展开箭头 = ${open.bg}，应为 --primary ${wantActive}`);
        if (OLD_ROYAL.includes(open.bg)) fail(`[${theme}/${accent}] 展开箭头又出现了旧皇家蓝 ${open.bg}`);

        // 图形还在（mask 没被改成 none）—— 颜色对了但形状没了同样是坏
        if (open.mask && open.mask !== 'none') pass(`[${theme}/${accent}] 箭头图形由 mask 提供`); 
        else fail(`[${theme}/${accent}] mask 缺失（mask=${open.mask}）—— 箭头会被画成一块实心方块`);

        await q(cdp, `window.ddCloseAll && window.ddCloseAll()`);
        checked += 1;
      }
    }
    if (checked === ACCENT_IDS.length * 2) pass(`共体检 ${checked} 个主题 × 配色组合`);
    else fail(`只体检了 ${checked} 个组合（应为 ${ACCENT_IDS.length * 2}）—— 防假绿`);
  });
} catch (err) {
  fail(`异常中断：${err.message}`);
} finally {
  cleanup();
}

console.log(failures ? `\n存在 ${failures} 项失败` : '\n全部通过');
process.exit(failures ? 1 : 0);
