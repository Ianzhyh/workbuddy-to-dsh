/**
 * 可见性门控的真浏览器验证（dashboard/public/index.html）。
 *
 * 单元测试只能证明源码结构对；这条优化的价值是"真的少打请求"，
 * 那句结论必须在真的页面里量出来。做法：
 *
 *   1. 静态服务挂 dashboard/public，用 CDP 打桩 `/api/*` 并逐次记账；
 *   2. 在页面里**替换 `document.hidden` 这个 getter**，再派发
 *      `visibilitychange` —— 等价于浏览器切标签页时发生的事（页面读到的
 *      是真实 DOM 属性，事件也是真的走 addEventListener 注册的那条链路）；
 *   3. 断言：隐藏期间请求数**不增**；切回可见后**立刻**增（不等 20 秒周期）。
 *
 * 为什么不用 CDP 的 `Emulation.setPageVisibilityState`：本机 Chrome 上这个命令
 * 不生效（发了不报错，但 `document.hidden` 仍是 false），于是测出来的全是
 * 假阴性。这里改成直接改 getter，行为等价而且确定。
 *
 * 注意 20 秒轮询是页面里的常量，所以"隐藏期间不增"必须等超过一个周期才说明问题。
 *
 *   node tools/dev/test-visibility.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';

import { openPage, sleep } from './ui-harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(HERE, '..', '..', 'dashboard', 'public');
const PORT = 18801;
const CDP_PORT = 9401;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

/** 页面会打的 `/api/*`。给最小可用的空壳，让首帧渲染跑完而不报错。 */
const routes = {
  '/api/overview': { body: { bridge: { running: false }, console: { version: '1' }, credentials: {}, quota: {}, dsh: {} } },
  '/api/models': { body: { models: [] } },
  '/api/usage': { body: { usage: { total: {}, models: [], days: [] } } },
  '/api/requests': { body: { requests: [] } },
  '/api/accounts': { body: { accounts: [] } },
  '/api/probe-results': { body: { updatedAt: null, results: {}, lastRun: null } },
  '/api/checkin': { body: { ok: true, status: {} } },
  '/api/diagnose': { body: { items: [], summary: {} } },
  '/api/bridge/log': { body: { lines: [] } },
};

/** 把页面切成"隐藏/可见"，并让 `document.hidden` 真的跟着变。
 *
 * 直接改写 `document.hidden` 的 getter（它在原型链上、是访问器属性），
 * 再派发 `visibilitychange` —— 这就是浏览器切标签页时页面看到的东西。
 * 走 `Object.defineProperty` 而不是赋值：`document.hidden` 是只读的。
 */
const SET_VISIBILITY = (state) => `(() => {
  const value = ${state === 'hidden'};
  if (!window.__origHidden) {
    window.__origHidden = Object.getOwnPropertyDescriptor(Document.prototype, 'hidden')
      || Object.getOwnPropertyDescriptor(document, 'hidden');
  }
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => value });
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value ? 'hidden' : 'visible' });
  document.dispatchEvent(new Event('visibilitychange'));
  return document.hidden;
})()`;

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const rel = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
  try {
    const buf = readFileSync(join(PUBLIC, rel));
    res.writeHead(200, { 'content-type': MIME[extname(rel)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(buf);
  } catch {
    res.writeHead(404); res.end('404');
  }
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const page = await openPage(`http://127.0.0.1:${PORT}/`, routes, { width: 1200, height: 900, cdpPort: CDP_PORT });
const problems = [];
try {
  // 首帧：可见状态下的正常取数
  await sleep(2500);
  const initial = await page.cdp.evaluate('window.__calls.length');
  if (initial < 4) problems.push(`首帧只打了 ${initial} 个请求，页面没跑起来`);

  // ── 切到后台，等**超过一个 20 秒周期** ──────────────────────
  const beforeHide = await page.cdp.evaluate('window.__calls.length');
  const hiddenFlag = await page.cdp.evaluate(SET_VISIBILITY('hidden'));
  if (hiddenFlag !== true) problems.push(`没能把页面置为 hidden（document.hidden=${hiddenFlag}）`);

  await sleep(1000);
  const afterHideSettled = await page.cdp.evaluate('window.__calls.length'); // 丢掉在途请求收尾的噪声
  await sleep(22000);                                                      // 跨越一个完整周期
  const afterHide = await page.cdp.evaluate('window.__calls.length');
  if (afterHide !== afterHideSettled) {
    problems.push(`隐藏期间仍然打了 ${afterHide - afterHideSettled} 个请求（应当为 0）`);
  }

  // ── 切回前台：必须**立刻**补一次 ────────────────────────────
  await page.cdp.evaluate(SET_VISIBILITY('visible'));
  await sleep(1200); // 远小于 20 秒：补数据不该等到下一个周期
  const afterShow = await page.cdp.evaluate('window.__calls.length');
  if (afterShow <= afterHide) problems.push(`切回可见后没有立刻补数据（${afterHide} → ${afterShow}）`);

  console.log(`可见性门控实测：首帧 ${initial} 个请求；`
    + `隐藏期间（含跨越一个 20s 周期）+${afterHide - afterHideSettled}（应为 0）；`
    + `切回可见后 +${afterShow - afterHide}（应 ≥1）`);

  // ── 第二轮：**再来一次隐藏→可见，并多跨一个周期** ──────────────
  //
  // 为什么必须多等这一个周期：真出过的事故是"切回可见补了一次数据，
  // 但定时器没恢复"—— 只验"补了数据"是发现不了的（补数据与恢复定时是两回事）。
  // 这里隔一个完整周期再数一次，才能证明轮询真的回来了，而不是静默停更。
  await page.cdp.evaluate(SET_VISIBILITY('hidden'));
  await sleep(600);
  const beforeIdle = await page.cdp.evaluate('window.__calls.length');
  await sleep(22000);   // 隐藏着跨越一个完整周期：必须一个都不打
  const afterIdle = await page.cdp.evaluate('window.__calls.length');
  if (afterIdle !== beforeIdle) {
    problems.push(`第二轮隐藏期间仍打了 ${afterIdle - beforeIdle} 个请求`);
  }

  await page.cdp.evaluate(SET_VISIBILITY('visible'));
  await sleep(1200);
  const afterResume = await page.cdp.evaluate('window.__calls.length');
  if (afterResume <= afterIdle) problems.push('第二轮切回可见没有立刻补数据');

  await sleep(22000);   // 再跨一个周期：必须**又自动打了一轮**（= 定时器真的回来了）
  const afterNextCycle = await page.cdp.evaluate('window.__calls.length');
  if (afterNextCycle <= afterResume) {
    problems.push('切回可见后定时器没有恢复 —— 页面会静默停更（这正是修掉的 bug）');
  }
  console.log(`恢复定时实测：第二轮隐藏 +${afterIdle - beforeIdle}（应为 0）；`
    + `切回可见 +${afterResume - afterIdle}（应 ≥1）；再过一周期 +${afterNextCycle - afterResume}（应 ≥1，证明定时器真的恢复了）`);
} catch (error) {
  problems.push(`执行失败：${error.message}`);
} finally {
  page.close();
  await new Promise((r) => server.close(r));
}

if (problems.length) {
  console.error('可见性门控问题：');
  for (const p of problems) console.error(` - ${p}`);
  process.exit(1);
}
console.log('可见性门控通过：后台标签页不再轮询，切回可见立刻补一次。');
