/**
 * 卡片入场动效：**依次浮现**，且**不会把悬停抬升压死**。
 *
 *   node tools/dev/test-card-motion.mjs
 *
 * ## 为什么值得单独测
 *
 * 入场动画用 CSS animation 实现，而 **animation 的优先级高于普通声明** ——
 * 只要 fill-mode 写了 `both`/`forwards`，动画的结束帧就会**永久**留在元素上，
 * `.card:hover { transform: translateY(-2px) }` 会被无声地压掉：
 * 鼠标移上去什么都不发生，**代码读起来完全正常**，控制台也不报任何错。
 *
 * 这类"动画吃掉了交互"的问题没法靠看代码发现，只能真的把鼠标移上去量 transform。
 * 所以本用例用 CDP 的 Input.dispatchMouseEvent 发真实鼠标事件，量计算样式。
 *
 * 另一条：延迟必须是**递增**的。八个延迟写成一样，看起来"有动画"，但那是
 * 八个各自为政的小动画，不是"一屏数据依次铺开"—— 编排和堆叠的区别就在这里。
 */
import { startStaticServer, openPage, q, sleep } from './ui-harness.mjs';
import { baseRoutes } from './fixtures.mjs';

let failures = 0;
const pass = (m) => console.log('✓ ' + m);
const fail = (m) => { console.error('✗ ' + m); failures += 1; };

const PORT = 8814;
const URL_ = `http://127.0.0.1:${PORT}/`;

const server = await startStaticServer(PORT);
const { cdp, close } = await openPage(URL_, baseRoutes(), { width: 1440, height: 1200, cdpPort: 9364 });
const cleanup = () => { try { close(); } catch { /* 忽略 */ } try { server.close(); } catch { /* 忽略 */ } };
process.on('exit', cleanup);

// ── 1. 延迟递增 ────────────────────────────────────────────────────────
await sleep(1400); // 等首屏数据渲染完（卡片是 innerHTML 拼出来的）
/*
 * **按各自的 `.cards` 容器分组**再判递增。
 *
 * 页面上不止一个卡片网格（状态卡 8 张 + 诊断卡 5 张），而 `:nth-child`
 * 是**按父元素**数的 —— 拍平成一个序列去看，第二个网格会从 0 重新开始，
 * 于是"递增"这条会假失败。（第一版就是这么写的，报出
 * [0,45,…,315,0,45,…] 这种看着像 bug、其实是测法错的序列。）
 */
const grids = await q(cdp, `(() => {
  return [...document.querySelectorAll('.cards')].map((g) =>
    [...g.querySelectorAll(':scope > .card')].map((c) => {
      const d = getComputedStyle(c).animationDelay;
      return d.endsWith('ms') ? parseFloat(d) : parseFloat(d) * 1000;
    }));
})()`);

console.log('  各网格的 animation-delay: ' + JSON.stringify(grids));
const total = grids.reduce((n, g) => n + g.length, 0);
if (total >= 4) pass('卡片渲染出 ' + total + ' 张（' + grids.length + ' 个网格）');
else fail('只渲染出 ' + total + ' 张卡，网格没铺开（后续断言无意义）');

for (let i = 0; i < grids.length; i++) {
  const g = grids[i];
  const rising = g.length > 1 && g.every((d, k) => k === 0 || d > g[k - 1]);
  if (rising) pass('网格 #' + (i + 1) + '（' + g.length + ' 张）延迟严格递增 —— 依次铺开，不是同时闪');
  else fail('网格 #' + (i + 1) + ' 的延迟没有递增：' + JSON.stringify(g));
}

// ── 2. 动画结束后 transform 必须"还"给层叠 ─────────────────────────────
await sleep(900); // 让 0.34s 动画 + 最长 315ms 延迟全部跑完
const settled = await q(cdp, `(() => {
  const c = document.querySelector('.cards > .card');
  const cs = getComputedStyle(c);
  return { transform: cs.transform, opacity: cs.opacity };
})()`);
console.log('  动画结束后: transform=' + settled.transform + ' opacity=' + settled.opacity);
/*
 * 必须**严格**是 `none`。
 *
 * 这里第一版写成"`none` 或 `matrix(1,0,0,1,0,0)` 都算过"，结果 `both` 那个 bug
 * 也能通过 —— 因为 `both` 留下的结束帧正好就是 `translateY(0)`，算出来正是
 * `matrix(1,0,0,1,0,0)`。一条**分不出对错**的断言等于没有，所以收紧：
 * `.card` 自己没有任何 transform 声明，只有"动画确实不再生效"时才会是 `none`。
 */
if (settled.transform === 'none') {
  pass('动画结束后 transform 已归还层叠（没有残留动画帧）');
} else {
  fail('动画结束后 transform 仍是 ' + settled.transform + ' —— fill-mode 用错了，会永久压住悬停');
}

// ── 3. 真实鼠标悬停：抬升必须生效 ──────────────────────────────────────
const box = await q(cdp, `(() => {
  const r = document.querySelector('.cards > .card').getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
})()`);
await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y, buttons: 0 });
await sleep(420); // 过渡 0.2s

const hovered = await q(cdp, `getComputedStyle(document.querySelector('.cards > .card')).transform`);
const m = /matrix\(([^)]+)\)/.exec(hovered || '');
const ty = m ? parseFloat(m[1].split(',')[5]) : 0;
console.log('  悬停后 transform=' + hovered + '（translateY = ' + ty + 'px）');
if (ty <= -1.5) pass('悬停抬升生效（translateY ' + ty + 'px）—— 动画没有吃掉交互');
else fail('悬停后没有抬升（translateY ' + ty + 'px）—— 入场动画把 :hover 压死了');

// 移开鼠标，别影响后续断言
await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 4, y: 4, buttons: 0 });

// ── 4. prefers-reduced-motion 下必须关掉 ───────────────────────────────
await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
await sleep(200);
const rmName = await q(cdp, `getComputedStyle(document.querySelector('.cards > .card')).animationName`);
if (rmName === 'none') pass('prefers-reduced-motion: reduce 下动画已关闭');
else fail('晕动症用户仍会看到入场动画（animation-name=' + rmName + '）');
await cdp.send('Emulation.setEmulatedMedia', { features: [] });

console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
cleanup();
process.exit(failures ? 1 : 0);
