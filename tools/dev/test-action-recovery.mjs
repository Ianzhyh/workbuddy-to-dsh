/**
 * 操作反馈与文案形态 验收（本轮 bug 排查新增，2026-11-12）。
 *
 *   node tools/dev/test-action-recovery.mjs
 *
 * 三条用例，各自钉住一条**实测踩到的**体验缺陷：
 *
 * 1. **启动失败 + 概览接口异常 → 按钮永久禁用**
 *    复位语句写在 `loadOverview()` 之后，而它在概览失败时提前 return，于是复位走不到。
 *    用户看到的最后一句话是「桥已启动失败：port 8790 already in use」，而唯一能补救的
 *    按钮已经点不动。
 *
 * 2. **界面文案里出现 Markdown `**…**` 字面星号**
 *    弹窗补充行与客户端说明都是纯文本节点（`textContent`），`**` 不会变粗，只是多出四颗星。
 *    用户会以为复制错了 / 界面坏了。同时它还会让 i18n 词条表对不上（键里带 `**`）。
 *
 * 3. **英文模式下的操作反馈没有翻译**（`setMsg` 走的是文本拼接，DOM 扫描层靠不住）
 *    这条用「退出插件账号」的确认框验证：它曾是唯一还在用原生 `confirm` 的地方。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startStaticServer, openPage, waitFor, q, sleep } from './ui-harness.mjs';
import { accountsFixture, baseRoutes } from './fixtures.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
/*
 * 端口：8845/8846/8847（本文件三个场景各占一个区间）。
 *
 * 原来写 8865（+1/+2）—— 那与 `dsh-plugin/tests/panel-render.mjs` 的区间重叠，
 * 而 `npm run test:ui` 与 `npm run panel:check` 经常并行。约束与全仓分配见
 * `tools/dev/test-port-bands.test.mjs`（把这条约定钉成断言，防止再撞）。
 */
const PORT = 8845;
const URL_ = `http://127.0.0.1:${PORT}/`;

let failures = 0;
const fail = (m) => { console.error('✗ ' + m); failures += 1; };
const pass = (m) => console.log('✓ ' + m);

// ── 静态守卫：用户可见的文案不许带 Markdown 强调语法 ────────────────────────
{
  /*
   * 为什么是静态守卫而不是渲染断言：这些文案分散在 6 个面板、部分只在特定分支出现
   * （「表单没有上下文长度格」只在 opencode 页签下渲染），靠点一遍页面覆盖不全。
   * 而"字符串字面量里出现 `**`"这件事本身就可疑 —— 本项目**没有** Markdown 渲染器，
   * 所有文案都是 textContent。
   *
   * 只扫**中文文案字面量**：注释里写 `**粗体**` 是文档习惯（本仓库大量使用），
   * 不算缺陷。所以先剥注释，再只挑含中文的字符串字面量。
   */
  const files = ['dashboard/public/index.html', 'dsh-plugin/lib/client.js'];
  const offenders = [];
  for (const rel of files) {
    const raw = readFileSync(join(root, rel), 'utf8');
    const noComments = raw
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*)/.test(line))
      .join('\n');
    const lines = noComments.split('\n');
    lines.forEach((line, i) => {
      // 只挑带中文的单行字符串字面量；`\*\*` 是两个星号
      for (const m of line.matchAll(/'([^'\\]|\\.)*'/g)) {
        const lit = m[0];
        if (!/[\u4e00-\u9fa5]/.test(lit)) continue;
        if (!/\*\*/.test(lit)) continue;
        offenders.push(`${rel}:${i + 1} ${lit.slice(0, 60)}`);
      }
    });
  }
  if (offenders.length === 0) pass('文案字面量里没有 Markdown `**` 强调语法');
  else {
    fail(`有 ${offenders.length} 处文案含字面星号（不渲染成粗体，只是多出四颗星）：\n    `
      + offenders.slice(0, 8).join('\n    '));
  }
}

// ── 静态守卫：控制台不许再用原生 confirm（含 window. 前缀写法）──────────────
{
  const raw = readFileSync(join(root, 'dashboard', 'public', 'index.html'), 'utf8');
  const noComments = raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join('\n');
  const stripped = noComments.replace(/appConfirm\s*\(/g, '').replace(/confirmDangerous/g, '');
  const hits = [...stripped.matchAll(/(?:^|[^.\w])(?:window\s*\.\s*)?confirm\s*\(/g)];
  if (hits.length === 0) pass('控制台没有原生 confirm（含 window.confirm）');
  else fail(`控制台还有 ${hits.length} 处原生 confirm —— 它会阻塞主线程且绕过 i18n`);
}

// ── 静态守卫：不许用显式 `behavior: 'smooth'` 绕过 reduced-motion ──────────
{
  /*
   * 浏览器语义：**显式 behavior 优先于 CSS `scroll-behavior`**。而 reduced-motion
   * 的兜底正是把 `scroll-behavior` 压成 `auto` —— 所以任何
   * `scrollTo({behavior:'smooth'})` / `scrollIntoView({behavior:'smooth'})`
   * 都会给晕动症用户留一段滚动动画。
   *
   * 实测（`.tmp-ux/poc-smooth-override.mjs`，同一元素、同一起止位置）：
   *   不传 behavior → 1 个位置（瞬间到位）
   *   显式 smooth   → 21 个中间位置
   *
   * plans/002 已经把控制台两处改掉了，插件侧漏了一处（模型详情行）——
   * 这条守卫把"漏下一处"变成红灯。
   */
  const files = ['dashboard/public/index.html', 'dsh-plugin/lib/client.js'];
  const offenders = [];
  for (const rel of files) {
    const raw = readFileSync(join(root, rel), 'utf8');
    const noComments = raw
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*)/.test(line))
      .join('\n');
    noComments.split('\n').forEach((line, i) => {
      if (/behavior\s*:\s*'smooth'/.test(line)) offenders.push(`${rel}:${i + 1} ${line.trim().slice(0, 70)}`);
    });
  }
  if (offenders.length === 0) pass('没有显式 behavior:\'smooth\'（滚动跟随 CSS + reduced-motion）');
  else fail(`有 ${offenders.length} 处显式平滑滚动，会绕过 reduced-motion 兜底：\n    ` + offenders.join('\n    '));
}

// ── 1. 启动失败 + 概览异常：按钮必须能再点 ─────────────────────────────────
{
  const routes = baseRoutes();
  routes['/api/bridge/start'] = { status: 500, body: { ok: false, started: false, error: 'port 8790 already in use' } };
  routes['/api/overview'] = { status: 500, body: { error: '控制台异常：读取桥状态失败' } };

  const server = await startStaticServer(PORT);
  const { cdp, close } = await openPage(URL_, routes, { width: 1280, height: 900, skipShapeCheck: true });
  try {
    await waitFor(cdp, `document.querySelectorAll('.nav-tab').length === 5`, 15000, '页签就绪');
    await sleep(1200);
    const before = await q(cdp, `document.getElementById('startBtn').disabled`);
    if (before !== false) fail('前置条件不成立：启动按钮一开始就是禁用的');
    await q(cdp, `(() => { const b = document.getElementById('startBtn'); setTimeout(() => b.click(), 0); return true; })()`);
    await sleep(1800);
    const after = await q(cdp, `JSON.stringify({
      disabled: document.getElementById('startBtn').disabled,
      msg: (document.getElementById('actionMsg') || {}).textContent || '',
    })`);
    const st = JSON.parse(after);
    if (st.disabled) fail('概览接口异常 + 启动失败后，启动按钮永久禁用（用户无法重试）');
    else pass(`启动失败后按钮已复位（提示：${st.msg.slice(0, 34)}）`);
  } finally {
    await close();
    server.close();
  }
}

// ── 2. 切号确认框里没有字面星号 ─────────────────────────────────────────────
{
  const routes = baseRoutes();
  const one = accountsFixture().accounts[0];
  routes['/api/accounts'] = {
    ...routes['/api/accounts'],
    body: accountsFixture({
      accounts: [
        { ...one, name: 'a.info', active: true, alias: '工作号' },
        {
          ...one, name: 'b.info', active: false, alias: '个人号',
          account: '330000000001', aliasKey: '330000000001',
          userId: '11111111-1111-1111-1111-111111111111',
        },
      ],
    }),
  };

  const server = await startStaticServer(PORT + 1);
  const { cdp, close, setDialogAuto } = await openPage(
    `http://127.0.0.1:${PORT + 1}/`, routes, { width: 1280, height: 900, cdpPort: 9389 },
  );
  try {
    await waitFor(cdp, `document.querySelectorAll('.nav-tab').length === 5`, 15000, '页签就绪');
    await q(cdp, `document.querySelector('.nav-tab[data-tab="all"]').click(); true`);
    await sleep(1600);
    const btn = await q(cdp, `document.querySelector('#accountList [data-switch]') ? 1 : 0`);
    if (!btn) {
      fail('前置条件不成立：账号列表里没有「切换」按钮（夹具两个账号被合并了？）');
    } else {
      setDialogAuto(false);
      await q(cdp, `(() => { const b = document.querySelector('#accountList [data-switch]'); setTimeout(() => b.click(), 0); return true; })()`);
      await sleep(700);
      const text = await q(cdp, `(() => {
        const s = document.querySelector('.modal-scrim');
        return s ? [...s.querySelectorAll('.modal-body p')].map((p) => p.textContent).join(' / ') : '';
      })()`);
      if (!text) fail('没等到切号确认框');
      else if (String(text).includes('**')) fail(`确认框里有字面星号：${String(text).slice(0, 60)}`);
      else pass('切号确认框没有字面星号');
      // 清掉弹窗，免得影响后续用例
      await q(cdp, `(() => { const s = document.querySelector('.modal-scrim'); const b = s && s.querySelectorAll('.modal-actions button'); if (b && b.length) b[0].click(); return true; })()`);
      await sleep(400);
      setDialogAuto(true);
    }
  } finally {
    await close();
    server.close();
  }
}

// ── 3. 英文模式下「退出插件账号」弹的是自绘框且已英文化 ──────────────────────
{
  const routes = baseRoutes();
  routes['/api/login'] = {
    ...routes['/api/login'],
    body: {
      ...routes['/api/login'].body,
      credentials: [{
        uid: 'uid-plugin-0001', nickname: 'Test Account', region: 'cn', active: true,
        expiresAt: new Date(Date.now() + 20 * 86400000).toISOString(), enterpriseId: '',
      }],
      effective: { source: 'plugin', uid: 'uid-plugin-0001' },
      configured: 'plugin',
      sameAccount: false,
    },
  };

  const server = await startStaticServer(PORT + 2);
  const { cdp, close, lastDialog, setDialogAuto } = await openPage(
    `http://127.0.0.1:${PORT + 2}/`, routes, { width: 1280, height: 900, cdpPort: 9388 },
  );
  /*
   * **必须关掉自动接管**：自绘弹窗的文案会经同一个 binding 写进 `lastDialog`，
   * 而自动接管会立刻把它点掉 —— 于是"自绘框"和"原生框 + 已被点掉"在读到的
   * 证据上长得一模一样（第一版用例就因此误判成「还在用原生 confirm」）。
   */
  setDialogAuto(false);
  try {
    await waitFor(cdp, `document.querySelectorAll('.nav-tab').length === 5`, 15000, '页签就绪');
    await q(cdp, `document.querySelector('.nav-tab[data-tab="all"]').click(); true`);
    await sleep(1500);
    await q(cdp, `document.getElementById('langToggle').click(); true`);
    await sleep(900);
    const lang = await q(cdp, `document.documentElement.lang`);
    const hasBtn = await q(cdp, `document.querySelector('#accountList [data-plugin-logout]') ? 1 : 0`);
    if (lang !== 'en') fail('前置条件不成立：语言没切到英文');
    else if (!hasBtn) fail('前置条件不成立：插件账号的「退出」按钮没渲染');
    else {
      await q(cdp, `(() => { const b = document.querySelector('#accountList [data-plugin-logout]'); setTimeout(() => b.click(), 0); return true; })()`);
      await sleep(800);
      // 原生 confirm 会被 harness 接管并记录；自绘框会进 DOM。两者都要能读到文案。
      const native = await lastDialog();
      const modal = await q(cdp, `(() => {
        const s = document.querySelector('.modal-scrim');
        return s ? [...s.querySelectorAll('.modal-body p')].map((p) => p.textContent).join(' / ') : '';
      })()`);
      const text = String(modal || native || '');
      if (!text) fail('点「退出」之后没有任何确认框 —— 危险动作静默执行了');
      else if (native && !modal) fail('「退出」还在用原生 confirm：它会阻塞主线程，且在英文模式下留中文');
      else if (/[\u4e00-\u9fa5]/.test(text)) fail(`英文模式下确认框仍有中文：${text.slice(0, 60)}`);
      else pass(`「退出插件账号」用自绘框且已英文化：${text.slice(0, 46)}`);
      // 点「取消」：这条用例只验文案，不该真的清掉凭据
      await q(cdp, `(() => { const s = document.querySelector('.modal-scrim'); const b = s && s.querySelectorAll('.modal-actions button'); if (b && b.length) b[0].click(); return true; })()`);
      await sleep(300);
      const loggedOut = await q(cdp, `(window.__reqs || []).some((r) => r.path === '/api/login/logout')`);
      if (loggedOut) fail('点「取消」仍然发出了退出请求 —— 确认框没起到拦截作用');
      else pass('点「取消」没有发退出请求');
    }
  } finally {
    await close();
    server.close();
  }
}

if (failures) {
  console.error(`\n${failures} 项失败`);
  process.exit(1);
}
console.log('\n全部通过');
