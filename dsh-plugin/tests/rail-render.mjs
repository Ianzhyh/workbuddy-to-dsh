/**
 * 右栏（sidebar.right）视觉/行为验收：把 WorkBuddyRail 挂进 340px 宽的容器，
 * 用与 panel-render 同一份桩数据，逐页截图 + 断言。
 *
 *   node dsh-plugin/tests/rail-render.mjs        （或 npm run panel:rail）
 *
 * 断什么：
 *   1. 320–340px 这一列里**没有横向溢出**（右栏默认就是 320，可拖到 480）；
 *   2. 三页都真的渲染出卡片与内容（不是白屏、也不是只有壳）；
 *   3. 每页的关键动作发出**正确的请求**（保存显示偏好 / 领取签到 / 切插件凭据）；
 *   4. 页面无运行时报错。
 *
 * 截图落在 `dsh-plugin/tests/out/rail/*.png`（与 panel-render 同目录约定）。
 */
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startStaticServer, openPage, waitFor, sleep } from '../../tools/dev/ui-harness.mjs';
import { FIXTURES, buildRoutes, ensureVendor, harnessHtml } from './_panel-fixtures.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN = join(HERE, '..');
/*
 * 截图落在 `docs/review-rail/`（与 panel-render 的 `docs/` 约定同源，但单独一个
 * 目录）：右栏是**新开的东西**，把它们混进已有的 plugin-panel-*.png 会让
 * `git diff` 里的既有评审图无端变化。这些图会进版本库，供 PR 里直接看。
 */
const OUT = join(HERE, '..', '..', 'docs', 'review-rail');
const PORT = 8901;

async function freeCdpPort() {
  const srv = createServer();
  await new Promise((resolve, reject) => { srv.once('error', reject); srv.listen(0, '127.0.0.1', resolve); });
  const port = srv.address().port;
  await new Promise((resolve) => srv.close(resolve));
  return port;
}

mkdirSync(OUT, { recursive: true });
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
  res.writeHead(404); res.end('not found');
});
await new Promise((resolve) => extra.listen(PORT + 1, '127.0.0.1', resolve));

/*
 * 视口必须比最宽的用例还宽：档位用例会拖到 900px，视口只有 520px 时
 * `<html>` 自己就会横向滚动 —— 那会被"页面横向溢出"的断言当成缺陷（假阳性）。
 * 右栏的宽度由宿主元素控制，与视口无关，所以放宽视口不影响被测行为。
 */
const page = await openPage(`http://127.0.0.1:${PORT + 1}/harness.html`, {}, {
  width: 1100, height: 1000, injectStub: false, cdpPort: await freeCdpPort(),
});

const problems = [];
const shot = async (name) => {
  /*
   * 截图走"把右栏临时钉到页面原点"这条路，而不是算 clip 坐标。
   *
   * 为什么不用 clip：右栏在 #frame → #root → #host 三层里，clip 用的是文档坐标，
   * 而它的 getBoundingClientRect 受外层 padding / 滚动影响 —— 两者一旦不一致，
   * 截出来就是**整体偏移**的图（实测：底部操作条被裁掉，看着像"dock 消失了"，
   * 但几何断言明明说它在可视区内）。这种假象比没有截图更糟。
   *
   * 所以：记下 rail 自己的宽高 → 临时 position:fixed 到 (0,0) 并隐藏其余内容 →
   * 按这个尺寸截全页 → 还原。坐标永远从 0 开始，没有偏移的余地。
   */
  const box = JSON.parse(await page.cdp.evaluate(`JSON.stringify((() => {
    const el = document.querySelector('[data-workbuddy-rail]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width));
    const h = Math.max(1, Math.round(r.height));
    window.__shotRestore = {
      html: document.documentElement.getAttribute('style'),
      body: document.body.getAttribute('style'),
      rail: el.getAttribute('style'),
    };
    document.documentElement.style.cssText += ';overflow:hidden;';
    document.body.style.cssText += ';margin:0;padding:0;overflow:hidden;';
    /* 把 rail 提到 (0,0) 并钉住尺寸：之后全页就是它自己 */
    el.style.cssText += ';position:fixed;left:0;top:0;right:auto;bottom:auto;'
      + 'width:' + w + 'px;height:' + h + 'px;z-index:2147483647;';
    return { width: w, height: h };
  })())`));
  const res = await page.cdp.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
    clip: { x: 0, y: 0, width: box.width, height: box.height, scale: 1 },
  });
  writeFileSync(join(OUT, name), Buffer.from(res.result.data, 'base64'));
  await page.cdp.evaluate(`(() => {
    const el = document.querySelector('[data-workbuddy-rail]');
    const r = window.__shotRestore || {};
    if (el) { if (r.rail == null) el.removeAttribute('style'); else el.setAttribute('style', r.rail); }
    if (r.html == null) document.documentElement.removeAttribute('style');
    else document.documentElement.setAttribute('style', r.html);
    if (r.body == null) document.body.removeAttribute('style');
    else document.body.setAttribute('style', r.body);
    delete window.__shotRestore;
  })()`);
  await sleep(120);
  return name;
};

try {
  await waitFor(page.cdp, 'window.__harness && window.__harness.rendered === true', 15000, '面板挂载');
  await sleep(400);

  // 关掉设置页那个大面板，换成 340px 宽（右栏默认宽度）里的 rail
  const mounted = await page.cdp.evaluate(`(() => {
    const mod = window.__module || {};
    if (typeof mod.WorkBuddyRail !== 'function') return { ok: false, reason: 'no WorkBuddyRail export' };
    const root = document.getElementById('root');
    root.innerHTML = '';
    const frame = document.getElementById('frame');
    frame.style.width = '340px';
    frame.style.maxWidth = '340px';
    frame.style.padding = '0';
    frame.style.background = '#191a1c';
    const head = document.getElementById('head');
    head.textContent = '右栏 340px';
    head.style.padding = '8px 12px';
    const host = document.createElement('div');
    host.id = 'rail-host';
    host.style.height = '960px';
    host.style.overflow = 'hidden';
    root.appendChild(host);
    window.__railRoot = ReactDOM.createRoot(host);
    window.__railRoot.render(React.createElement(mod.WorkBuddyRail));
    return { ok: true, exports: Object.keys(mod) };
  })()`);
  if (!mounted.ok) problems.push('无法挂载 WorkBuddyRail：' + mounted.reason);
  else console.log('rail 挂载，模块导出：', mounted.exports.join(', '));

  await waitFor(page.cdp, "document.querySelector('[data-workbuddy-rail]') !== null", 15000, 'rail 渲染');
  await sleep(900);

  const state = async () => JSON.parse(await page.cdp.evaluate(`JSON.stringify((() => {
    const rail = document.querySelector('[data-workbuddy-rail]');
    const cards = [...document.querySelectorAll('[data-workbuddy-rail] .wb-card')].map(c => ({
      title: c.querySelector('h3') ? c.querySelector('h3').textContent : '',
      rows: c.querySelectorAll('.wb-row').length,
      items: c.querySelectorAll('.wb-rail-item').length,
    }));
    return {
      text: rail ? rail.innerText : '',
      cards,
      width: rail ? Math.round(rail.getBoundingClientRect().width) : 0,
      scrollH: rail ? rail.scrollHeight : 0,
      clientH: rail ? rail.clientHeight : 0,
      overflowX: rail ? rail.scrollWidth > rail.clientWidth + 1 : null,
      tabs: [...document.querySelectorAll('[data-workbuddy-rail] .wb-segmented-item')].map(b => b.textContent),
      alerts: [...document.querySelectorAll('[data-workbuddy-rail] .wb-alert')].map(a => a.textContent),
      errors: window.__errors,
      calls: window.__calls.map(c => c[0] + ' ' + c[1]).filter((v,i,a) => a.indexOf(v) === i),
      checkboxes: document.querySelectorAll('[data-workbuddy-rail] input[type=checkbox]').length,
      checked: document.querySelectorAll('[data-workbuddy-rail] input[type=checkbox]:checked').length,
      dropdowns: document.querySelectorAll('[data-workbuddy-rail] .wb-dropdown-trigger').length,
    };
  })())`));

  const clickTab = async (label) => {
    await page.cdp.evaluate(`(() => {
      const b = [...document.querySelectorAll('[data-workbuddy-rail] .wb-segmented-item')].find(x => x.textContent === ${JSON.stringify(label)});
      if (b) b.click();
    })()`);
    await sleep(900);
  };

  // ── 模型页 ────────────────────────────────────────────────────────────
  let s = await state();
  await shot('rail-model.png');
  console.log('模型页：cards=', JSON.stringify(s.cards), 'tabs=', s.tabs, 'checkbox', s.checked + '/' + s.checkboxes, 'dropdowns=', s.dropdowns);
  if (s.width !== 340) problems.push(`rail 宽度应为 340，实际 ${s.width}`);
  if (s.overflowX) problems.push('模型页出现横向滚动（窄列里不该有）');
  if (s.tabs.length !== 3) problems.push(`分段控件应有 3 项，实际 ${s.tabs.length}`);
  if (s.dropdowns !== 1) problems.push(`模型页应有 1 个下拉，实际 ${s.dropdowns}`);
  if (s.checkboxes < 3) problems.push(`模型勾选清单没渲染（${s.checkboxes} 项）`);
  if (!/当前默认/.test(s.text)) problems.push('模型页缺少「当前默认」行');
  /*
   * 「上下文预算」：**右栏就地调上下文长度**，不必三级跳到设置页。
   * 断言三件事：卡片在、显示当前生效值、档位按钮来自目录（不是编造的数字）。
   */
  const ctxCard = (s.cards || []).find((c) => /上下文预算/.test(c.title || ''));
  if (!ctxCard) problems.push('模型页缺少「上下文预算」卡');
  if (!/当前生效/.test(s.text)) problems.push('上下文预算卡缺少「当前生效」行');
  if (!/300K/.test(s.text)) problems.push('上下文预算卡没有按目录档位渲染（缺 300K）');
  if (s.errors.length) problems.push('页面错误：' + s.errors.join(' | '));

  /*
   * 点一个档位按钮 → 断言真的发出了带 contextWindow 的保存请求。
   * 这条防的是"按钮画出来了但没接上 handler"。
   */
  await page.cdp.evaluate(`(() => {
    const btn = [...document.querySelectorAll('[data-workbuddy-rail] .wb-btn')]
      .find((b) => b.textContent.trim() === '600K');
    if (btn && !btn.disabled) btn.click();
  })()`);
  await sleep(900);
  const ctxReqs = JSON.parse(await page.cdp.evaluate(`JSON.stringify(
    window.__reqs.filter((r) => r.path === '/workbuddy/model-visibility' && r.body && r.body.contextWindow !== undefined)
  )`));
  console.log('上下文保存请求：', JSON.stringify(ctxReqs));
  const lastCtx = ctxReqs[ctxReqs.length - 1];
  if (!lastCtx) problems.push('点档位按钮没有发出带 contextWindow 的保存请求');
  else if (Number(lastCtx.body.contextWindow) !== 600000) {
    problems.push(`保存的 contextWindow 应为 600000，实际 ${lastCtx.body.contextWindow}`);
  }

  // 勾一个模型 → 保存 → 断言请求体
  await page.cdp.evaluate(`(() => {
    const box = document.querySelector('[data-workbuddy-rail] input[type=checkbox]');
    if (box && !box.disabled) box.click();
  })()`);
  await sleep(200);
  const before = JSON.parse(await page.cdp.evaluate(`JSON.stringify(window.__reqs.filter(r => r.path === '/workbuddy/model-visibility'))`));
  await page.cdp.evaluate(`(() => {
    const b = [...document.querySelectorAll('[data-workbuddy-rail] .wb-btn')].find(x => x.textContent === '保存');
    if (b) b.click();
  })()`);
  await sleep(700);
  const after = JSON.parse(await page.cdp.evaluate(`JSON.stringify(window.__reqs.filter(r => r.path === '/workbuddy/model-visibility'))`));
  const posted = after.filter((r) => r.method === 'POST');
  console.log('model-visibility 请求：before=', before.length, 'after=', after.length, JSON.stringify(posted.map((r) => r.body)));
  if (!posted.length) problems.push('点「保存」没有发出 model-visibility 的 POST');
  else if (!Array.isArray(posted[posted.length - 1].body?.visible)) problems.push('保存请求体里没有 visible 数组');
  const afterSave = await state();
  if (!afterSave.alerts.length) problems.push('保存后没有结果提示（Alert）');

  // ── 签到页 ────────────────────────────────────────────────────────────
  await clickTab('签到');
  await sleep(1200);
  s = await state();
  await shot('rail-checkin.png');
  console.log('签到页：cards=', JSON.stringify(s.cards));
  if (s.cards.length < 2) problems.push('签到页应有 2 张卡（每日签到 / 账号签到状态）');
  if (!/已签到|未签到|无活动/.test(s.text)) problems.push('签到页没有今日状态');
  if (s.overflowX) problems.push('签到页出现横向滚动');
  // 领取（桩里 todayCheckedIn 为 false，按钮应可点）
  await page.cdp.evaluate(`(() => {
    const b = [...document.querySelectorAll('[data-workbuddy-rail] .wb-btn')].find(x => x.textContent === '立即领取');
    if (b && !b.disabled) b.click();
  })()`);
  await sleep(900);
  const claimReqs = JSON.parse(await page.cdp.evaluate(`JSON.stringify(window.__reqs.filter(r => /checkin/.test(r.path)))`));
  console.log('签到请求：', JSON.stringify(claimReqs.map(r => r.method + ' ' + r.path)));
  if (!claimReqs.some(r => r.method === 'POST')) problems.push('点「立即领取」没有发出 POST 签到请求');

  // ── 账号页 ────────────────────────────────────────────────────────────
  await clickTab('账号');
  s = await state();
  await shot('rail-account.png');
  console.log('账号页：cards=', JSON.stringify(s.cards), 'calls=', s.calls.length);
  if (s.cards.length < 3) problems.push('账号页应有 3 张卡（切换账号 / 用量上限 / 凭据）');
  if (!/凭据来源/.test(s.text)) problems.push('账号页缺少「凭据来源」行');
  if (s.overflowX) problems.push('账号页出现横向滚动');
  /*
   * 用量上限卡：**必须同时说清"哪个账号"与"为什么"**。
   *
   * 早先这份数据只在桥内部给自动切号用，界面上一片空白，用户只能等请求整片
   * 变红才猜到"这个号的这个模型满了"。所以这里断言三件事：
   *   1. 列出了触顶的模型名（deepseek-v4.1-flash / glm-5.3）
   *   2. 两种原因分开写（额度已用尽 vs 账号被风控）—— 处置方式完全不同，
   *      混成一句"失败"会给出错误的下一步；
   *   3. 带上了账号标识（Fixture / Fixture Other）。
   */
  const limitsCalls = s.calls.filter((c) => c.includes('/workbuddy/limits'));
  console.log('上限请求：', JSON.stringify(limitsCalls));
  if (!limitsCalls.length) problems.push('账号页没有请求 /workbuddy/limits');
  if (!/用量上限/.test(s.text)) problems.push('账号页缺少「用量上限」卡');
  if (!/deepseek-v4\.1-flash/.test(s.text)) problems.push('用量上限卡没有列出触顶的模型名');
  if (!/额度已用尽/.test(s.text)) problems.push('用量上限卡没有「额度已用尽」（账号级额度上限）');
  if (!/账号被风控/.test(s.text)) problems.push('用量上限卡没有「账号被风控」（账号级风控，处置不同）');
  if (!/Fixture/.test(s.text)) problems.push('用量上限卡没有标出是哪个账号触顶');
  /*
   * **归属必须逐条正确**：quota 那条属于 Fixture（uid-0001），风控那条属于
   * Fixture Other（uid-0002）。早期实现把所有条目都盖上"当前账号"，于是换号
   * 之后界面看起来毫无变化 —— 用户的原话是"我换个账号上限还覆盖显示了"。
   * 所以这里读 DOM 里每条的实际账号归属，而不是只看页面出现过 "Fixture"。
   */
  const limitRows = JSON.parse(await page.cdp.evaluate(`JSON.stringify((() => {
    const rail = document.querySelector('[data-workbuddy-rail]');
    const card = [...rail.querySelectorAll('.wb-card')].find((c) => /用量上限/.test(c.textContent));
    if (!card) return [];
    return [...card.querySelectorAll('.wb-rail-item')].map((row) => ({
      text: row.innerText.replace(/\\s+/g, ' ').trim(),
      title: row.getAttribute('title') || '',
    }));
  })())`));
  console.log('上限行：', JSON.stringify(limitRows));
  if (limitRows.length !== 2) problems.push(`用量上限应有 2 行（额度用尽 / 账号风控），实际 ${limitRows.length}`);
  const quotaRow = limitRows.find((r) => /deepseek-v4\.1-flash/.test(r.text)) || {};
  const restrictRow = limitRows.find((r) => /glm-5\.3/.test(r.text)) || {};
  /*
   * 卡上必须明确写「所有账号」—— 用户要的是**跨账号总览**（"不管我是什么账号
   * 都得看得到别的是不是用完"），而不是只列当前号。这两条一起钉住：
   *   1. 说明文字讲的是"所有账号"；
   *   2. 属于**另一个**账号的那条也在列表里（不是被过滤掉）。
   */
  if (!/所有账号/.test(s.text)) problems.push('用量上限卡没有说明这是「所有账号」的记录');
  if (!/Fixture Other/.test(restrictRow.text || '')) {
    problems.push(`风控那条没有标出它属于另一个账号：${restrictRow.text || '(缺)'}`);
  }
  /*
   * 恢复时间必须是**倒计时**（"还剩 N 分"），不是绝对时刻 ——
   * 用户要回答的是"我还要等多久"。上游没给时间时也必须明说，不能编造。
   */
  if (!/还剩 |即将恢复|不到 1 分钟/.test(quotaRow.text || '')) {
    problems.push(`额度那条没有显示恢复倒计时：${quotaRow.text || '(缺)'}`);
  }
  if (!/上游未给恢复时间|10 分钟窗口内/.test(restrictRow.text || '')) {
    problems.push(`没有恢复时间的那条应明说原因：${restrictRow.text || '(缺)'}`);
  }
  /*
   * **触顶后要自动出现，不能等用户手动点刷新**。
   * 用户反馈："我这边提示上限了，还要我手动点刷新才会出现，不能自动刷吗"。
   *
   * 这条用例验证「失败即广播 → 上限卡立刻重拉」这条链路：
   *   1. 往路由表里加一条**新的**上限记录（模拟刚触顶）；
   *   2. 让页面发一个返回 429 的请求 —— getJson 判定"像上限"后广播；
   *   3. **不点任何刷新按钮**，断言 /workbuddy/limits 被自动重拉且新记录上卡。
   */
  const beforeAuto = JSON.parse(await page.cdp.evaluate(`JSON.stringify(
    window.__reqs.filter((r) => r.path === '/workbuddy/limits').length
  )`));
  await page.cdp.evaluate(`(() => {
    const cur = window.__routes['/workbuddy/limits'];
    window.__routes['/workbuddy/limits'] = {
      ...cur,
      limiting: [
        ...(cur.limiting || []),
        {
          kind: 'quota',
          model: 'glm-5.3-flash',
          count: 1,
          lastAt: new Date().toISOString(),
          resetAt: new Date(Date.now() + 1800000).toISOString(),
          uid: 'uid-fixture-0001',
          accountLabel: 'Fixture',
          isCurrent: true,
        },
      ],
    };
    /*
     * 让**账号页自己那个「刷新」**发出一次 429。
     *
     * 当前页面是账号页，它刷新的两个接口是 /workbuddy/login 与
     * /workbuddy/console-api/accounts —— 把 login 改成 429 即可，
     * 这样走的就是面板真实的 getJson 出口（不是我伪造一次 fetch）。
     *
     * 注意：looksLikeLimitHit 认 **HTTP status 429** 或 error 里的
     * 6004/14018/11140/恢复时间 等关键字；打桩层按 httpStatus 给状态码。
     */
    window.__savedLoginRoute = window.__routes['/workbuddy/login'];
    window.__routes['/workbuddy/login'] = {
      httpStatus: 429,
      payload: {
        ok: false,
        error: 'upstream 429 (code 6004): 该账号在此模型上已确认不可用（恢复时间 2026-11-14T11:07:27.000Z）',
      },
    };
  })()`);
  /* 点账号页的「刷新」——它只该用来触发一次失败请求，不必碰上限卡 */
  await page.cdp.evaluate(`(() => {
    const rail = document.querySelector('[data-workbuddy-rail]');
    const btn = [...rail.querySelectorAll('.wb-btn')].find((b) => b.textContent.trim() === '刷新');
    if (btn) btn.click();
  })()`);
  await sleep(1500);
  /*
   * ⚠️ 用完**立刻恢复** login 路由：后面的「切换账号」用例要靠它成功，
   * 留着 429 会让那条用例假失败（实测踩过）。
   * 恢复后点一次「刷新」把失败的旧状态刷掉，否则按钮仍是 disabled。
   */
  await page.cdp.evaluate(`(() => {
    window.__routes['/workbuddy/login'] = window.__savedLoginRoute;
    delete window.__savedLoginRoute;
  })()`);
  await page.cdp.evaluate(`(() => {
    const rail = document.querySelector('[data-workbuddy-rail]');
    const btn = [...rail.querySelectorAll('.wb-btn')].find((b) => b.textContent.trim() === '刷新');
    if (btn) btn.click();
  })()`);
  await sleep(1200);
  const afterAuto = JSON.parse(await page.cdp.evaluate(`JSON.stringify((() => {
    const rail = document.querySelector('[data-workbuddy-rail]');
    const card = [...rail.querySelectorAll('.wb-card')].find((c) => /用量上限/.test(c.textContent));
    return {
      requests: window.__reqs.filter((r) => r.path === '/workbuddy/limits').length,
      text: card ? card.innerText.replace(/\\s+/g, ' ').trim() : '',
    };
  })())`));
  console.log(`自动刷新：limits 请求 ${beforeAuto} → ${afterAuto.requests}；卡上有新记录=${/glm-5\.3-flash/.test(afterAuto.text)}`);
  if (afterAuto.requests <= beforeAuto) {
    problems.push(`遇到 429 后没有自动重拉上限（请求数仍为 ${afterAuto.requests}，需要手动刷新）`);
  }
  if (!/glm-5\.3-flash/.test(afterAuto.text)) {
    problems.push('自动重拉后，新触顶的记录没有出现在卡上');
  }

  const accountCalls = s.calls.filter((c) => c.includes('accounts') || c.includes('/login'));
  console.log('账号页请求：', JSON.stringify(accountCalls));
  if (!accountCalls.length) problems.push('账号页没有请求账号清单');
  if (s.errors.length) problems.push('页面错误：' + s.errors.join(' | '));

  // 切换插件凭据（桩里第二条凭据 active=false）
  await page.cdp.evaluate(`(() => {
    const b = [...document.querySelectorAll('[data-workbuddy-rail] .wb-btn')].find(x => x.textContent === '使用');
    if (b && !b.disabled) b.click();
  })()`);
  await sleep(900);
  const pluginReqs = JSON.parse(await page.cdp.evaluate(`JSON.stringify(window.__reqs.filter(r => /login\\/(active|source)/.test(r.path)))`));
  console.log('切换插件凭据请求：', JSON.stringify(pluginReqs.map(r => r.method + ' ' + r.path + ' ' + JSON.stringify(r.body))));
  if (!pluginReqs.some((r) => r.path === '/workbuddy/login/active')) problems.push('点「使用」没有发 login/active 请求');
  const afterSwitch = await state();
  if (!afterSwitch.alerts.length && !/已切换/.test(afterSwitch.text)) problems.push('切换后没有反馈');
  /*
   * 换号必须**立刻重取上限**，不能等 60 秒轮询 —— 否则界面在这段时间里仍挂着
   * 上一个号的数据（用户看到的正是"换个账号上限还覆盖显示"）。
   */
  const limitsAfterSwitch = JSON.parse(await page.cdp.evaluate(`JSON.stringify(
    window.__reqs.filter((r) => r.path === '/workbuddy/limits').length
  )`));
  console.log('换号后 limits 请求次数：', limitsAfterSwitch);
  if (limitsAfterSwitch < 2) problems.push('换账号后没有重新请求 /workbuddy/limits（界面会继续显示上一个号的上限）');

  /*
   * **到期必须自动消失**（干净场景 + 等到组件真的拿到数据再开始计时）。
   *
   * 夹具把页面 `Date` 钉死在 FIXTURE_NOW，而锚点算法用的是
   * `performance.now()` 这样的单调时钟 —— 两者一个冻结、一个真实走动，
   * 所以"冻结时钟里 10 分钟后到期"在测试里永远不会到期。
   *
   * 因此这里注入一份 **at 与 resetAt 相差 6 秒**的数据，并**等组件真的渲染出
   * 那一行**（而不是固定 sleep）再开始计时。这样断言的是产品行为：
   * 6 秒后那一行自己消失，且不需要新的请求。
   */
  /*
   * 6 秒后那一行自己消失，且不需要新的请求。
   *
   * ⚠️ 路由必须是**动态**的：真实后端 readLimits 每次都会按 resetAt 过滤掉
   * 已到期的条目。如果这里给一个静态对象，轮询就会把过期数据**再送回来**，
   * 前端刚摘掉又装回去 —— 那不是产品缺陷，是夹具没模拟后端行为（实测踩过：
   * leftMs 从 4993 递减到 1995 很正确，但每 15 秒被"复活"一次）。
   */
  await page.cdp.evaluate(`(() => {
    const base = window.__routes['/workbuddy/limits'];
    const realNow = (typeof performance !== 'undefined' && performance.timeOrigin)
      ? performance.timeOrigin + performance.now()
      : Date.now();
    /* 记账起点固定：at 与 resetAt 都基于注入那一刻 */
    window.__expireAt = realNow + 6000;
    window.__expireAt0 = realNow;
    const build = () => {
      const nowReal = (typeof performance !== 'undefined' && performance.timeOrigin)
        ? performance.timeOrigin + performance.now()
        : Date.now();
      const live = base.limiting
        .map((it) => (it.kind === 'quota' ? { ...it, resetAt: new Date(window.__expireAt).toISOString() } : it))
        /* 与真实后端一致：过期的不再返回 */
        .filter((it) => !it.resetAt || Date.parse(it.resetAt) > nowReal);
      return { ...base, at: new Date(window.__expireAt0).toISOString(), limiting: live };
    };
    /*
     * 用一个 getter 挂进路由表：桩层每次读该路径都会走到 getter，
     * 于是"每次请求都重新按时间过滤"，行为与真实后端一致。
     */
    Object.defineProperty(window.__routes, '/workbuddy/limits', {
      configurable: true,
      enumerable: true,
      get: build,
    });
    const host = document.getElementById('rail-host');
    host.innerHTML = '';
    window.__railRoot = ReactDOM.createRoot(host);
    window.__railRoot.render(React.createElement(window.__module.WorkBuddyRail));
  })()`);
  await sleep(1500);
  /* 切到账号页，上限卡才在视野里 */
  await page.cdp.evaluate(`(() => {
    const b = [...document.querySelectorAll('[data-workbuddy-rail] .wb-segmented-item')]
      .find((x) => x.textContent === '账号');
    if (b) b.click();
  })()`);
  /*
   * 轮询等到"那一行真的出现"（最多 12 秒）—— 固定 sleep 会因为请求还在飞而
   * 读到空态，把"还没加载完"误判成"已经消失了"。
   */
  let sawRow = false;
  for (let i = 0; i < 24; i += 1) {
    const has = JSON.parse(await page.cdp.evaluate(`Boolean(
      [...document.querySelectorAll('[data-workbuddy-rail] .wb-rail-item')]
        .some((r) => /deepseek-v4\\.1-flash/.test(r.textContent))
    )`));
    if (has) { sawRow = true; break; }
    await sleep(500);
  }
  if (!sawRow) problems.push('到期用例前提不成立：额度那条始终没渲染出来');
  const expireState = () => page.cdp.evaluate(`JSON.stringify((() => {
    const rail = document.querySelector('[data-workbuddy-rail]');
    const rows = [...rail.querySelectorAll('.wb-rail-item')];
    return {
      hasQuotaRow: rows.some((r) => /deepseek-v4\\.1-flash/.test(r.textContent)),
      quotaText: (rows.find((r) => /deepseek-v4\\.1-flash/.test(r.textContent)) || {}).innerText || '',
      requests: window.__reqs.filter((r) => r.path === '/workbuddy/limits').length,
    };
  })())`);
  const expireBefore = JSON.parse(await expireState());
  console.log('到期前：', JSON.stringify(expireBefore));
  /* 锚点探针：`atMs|nowTick`。若 atMs 每次都在变，说明锚点被重建了 */
  const anchorProbe = async () => String(await page.cdp.evaluate(
    `document.querySelector('[data-workbuddy-rail]').getAttribute('data-limits-anchor')`,
  ));
  const a1 = await anchorProbe();
  await sleep(2500);
  const a2 = await anchorProbe();
  console.log(`锚点：${a1} → ${a2}`);
  const [at1, now1] = a1.split('|').map(Number);
  const [at2, now2] = a2.split('|').map(Number);
  if (Number.isFinite(at1) && Number.isFinite(at2) && at1 !== at2) {
    problems.push(`锚点被重建了（${at1} → ${at2}）：轮询每次都会重置倒计时，条目永远不会过期`);
  }
  if (Number.isFinite(now1) && Number.isFinite(now2) && now2 <= now1) {
    problems.push(`单调时钟没有推进（${now1} → ${now2}）`);
  }
  /* 6 秒窗口：动态等到倒计时归零（最多 12 秒），而不是固定 sleep ——
     「等到行出现」和「锚点探针」已经吃掉一部分窗口，固定时长会假失败。 */
  let leftAtEnd = 1;
  for (let i = 0; i < 24; i += 1) {
    leftAtEnd = Number(await page.cdp.evaluate(
      `document.querySelector('[data-workbuddy-rail]').getAttribute('data-limits-left')`,
    ));
    if (leftAtEnd <= 0 || Number.isNaN(leftAtEnd)) break;
    await sleep(500);
  }
  const expireAfter = JSON.parse(await expireState());
  console.log('到期后：', JSON.stringify(expireAfter), '剩余毫秒：', leftAtEnd);
  if (leftAtEnd > 0) {
    problems.push(`倒计时到点后仍未归零（剩余 ${leftAtEnd} ms）—— 条目不会消失`);
  }


  // 深色/浅色两套主题下都得可读：这里只看容器是否继承了宿主 token
  const themeProbe = JSON.parse(await page.cdp.evaluate(`JSON.stringify((() => {
    const rail = document.querySelector('[data-workbuddy-rail]');
    const cs = getComputedStyle(rail);
    const card = document.querySelector('[data-workbuddy-rail] .wb-card');
    const csCard = card ? getComputedStyle(card) : null;
    return {
      color: cs.color,
      background: cs.backgroundColor,
      cardBg: csCard ? csCard.backgroundColor : '',
      cardRadius: csCard ? csCard.borderRadius : '',
      fontSize: cs.fontSize,
    };
  })())`));
  console.log('主题探针：', JSON.stringify(themeProbe));
  if (!themeProbe.color) problems.push('rail 没有拿到文字颜色');

  /*
   * ═════════════ 宽度档位：240 / 300 / 460 / 620 / 900 五档 ═════════════
   *
   * 右栏宽度是用户拖出来的，同一份内容要在这些宽度下都成立。这里真的把宿主
   * 容器改成每个宽度，逐档断言：
   *   - 没有横向溢出（scrollWidth > clientWidth）**任何一档**；
   *   - `data-rail-tier` 与 CSS 阈值一致（JS 判档与 @container 必须同步）；
   *   - 极窄档确实做了减法（副行/uid 行消失、按钮铺满）；
   *   - 宽档确实加上了内容（上下文长度出现在副行里）；
   *   - 每一档都还能点到关键按钮（不是被裁掉）。
   */
  const TIER_CASES = [
    { width: 240, tier: 'narrow' },
    { width: 299, tier: 'narrow' },
    { width: 300, tier: 'regular' },
    { width: 420, tier: 'regular' },
    { width: 460, tier: 'medium' },
    { width: 619, tier: 'medium' },
    { width: 620, tier: 'wide' },
    { width: 900, tier: 'wide' },
  ];
  const resize = async (width, height = 900) => {
    await page.cdp.evaluate(`(() => {
      const frame = document.getElementById('frame');
      const root = document.getElementById('root');
      /*
       * 高度必须**逐层**给：.wb-rail 是 height:100%，任何一层没高度它就会退化成
       * 内容高度 —— 那时 @container (max-height) 永远不成立，"矮面板"这一档
       * 在测试里根本走不到（实测：给了 host 高度但 root 没给，量到 900）。
       */
      for (const el of [frame, root]) {
        el.style.width = ${width} + 'px';
        el.style.maxWidth = ${width} + 'px';
        el.style.minWidth = '0';
        el.style.height = ${height} + 'px';
        el.style.minHeight = '0';
        el.style.overflow = 'hidden';
      }
      const host = document.getElementById('rail-host');
      if (host) {
        host.style.width = '100%';
        host.style.height = ${height} + 'px';
        host.style.minHeight = '0';
        host.style.overflow = 'hidden';
      }
    })()`);
    await sleep(420); // ResizeObserver → setState → 重排
  };

  /*
   * 分档用例跑在**模型页**：只有那里有长清单（is-grid），双栏/单栏的断言
   * 才有对象。跑完切回账号页，后面的英文截图仍按原来的顺序。
   */
  await clickTab('模型');
  for (const { width, tier } of TIER_CASES) {
    await resize(width);
    const probe = JSON.parse(await page.cdp.evaluate(`JSON.stringify((() => {
      const rail = document.querySelector('[data-workbuddy-rail]');
      if (!rail) return { missing: true };
      const box = rail.getBoundingClientRect();
      const gridList = rail.querySelector('.wb-rail-list.is-grid');
      const plainList = rail.querySelector('.wb-rail-list:not(.is-grid)');
      const items = rail.querySelectorAll('.wb-rail-item');
      const firstItem = items[0] || null;
      const sub = firstItem ? firstItem.querySelector('.wb-rail-item-sub') : null;
      const btns = [...rail.querySelectorAll('.wb-btn')];
      const btnBoxes = btns.map((b) => { const r = b.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; });
      const body = rail.querySelector('.wb-rail-body');
      const bodyCs = body ? getComputedStyle(body) : null;
      /* 对齐线：标题 / 页签 / 第一张卡各自的实际左边界（相对视口） */
      const leftOf = (el) => (el ? Math.round(el.getBoundingClientRect().left) : null);
      const inner = rail.querySelector('.wb-rail-inner');
      return {
        measured: Math.round(box.width),
        tier: rail.getAttribute('data-rail-tier'),
        titleLeft: leftOf(rail.querySelector('.wb-rail-title')),
        segLeft: leftOf(rail.querySelector('.wb-segmented')),
        cardLeft: leftOf(rail.querySelector('.wb-card')),
        innerWidth: inner ? Math.round(inner.getBoundingClientRect().width) : 0,
        railOverflow: rail.scrollWidth > rail.clientWidth + 1,
        docOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        bodyPaddingTop: bodyCs ? Math.round(parseFloat(bodyCs.paddingTop)) : -1,
        bodyPaddingBottom: bodyCs ? Math.round(parseFloat(bodyCs.paddingBottom)) : -1,
        bodyTransition: bodyCs ? bodyCs.transitionProperty : '',
        /* 长清单（模型勾选）才允许双栏 */
        gridDisplay: gridList ? getComputedStyle(gridList).display : '',
        gridCols: gridList ? getComputedStyle(gridList).gridTemplateColumns : '',
        /* 短清单（账号 / 凭据）在任何宽度都必须单栏 */
        plainDisplay: plainList ? getComputedStyle(plainList).display : '',
        subVisible: sub ? getComputedStyle(sub).display !== 'none' : null,
        hasSubNode: Boolean(sub),
        title: rail.querySelector('.wb-rail-title') ? rail.querySelector('.wb-rail-title').textContent : '',
        btnWidths: btnBoxes,
        clipped: btns.some((b) => { const r = b.getBoundingClientRect(); return r.width < 12 || r.height < 12; }),
        text: rail.innerText,
      };
    })())`));
    if (!probe || probe.missing) { problems.push(`宽度 ${width}：rail 不见了`); continue; }
    const label = `${width}px/${tier}`;
    console.log(`宽度 ${label}：实测 ${probe.measured}px tier=${probe.tier} 溢出=${probe.railOverflow} 副行=${probe.subVisible} 长清单=${probe.gridDisplay}/${probe.gridCols} 短清单=${probe.plainDisplay}`);

    if (probe.tier !== tier) problems.push(`宽度 ${width}：档位应为 ${tier}，实际 ${probe.tier}`);
    if (probe.railOverflow) problems.push(`宽度 ${width}：rail 出现横向溢出`);
    if (probe.docOverflow) problems.push(`宽度 ${width}：页面出现横向溢出`);
    if (probe.clipped) problems.push(`宽度 ${width}：有按钮被压到点不到（<12px）`);

    if (tier === 'narrow') {
      // 减法：副行节点根本不渲染（不是 display:none），标题换成短名
      if (probe.hasSubNode) problems.push(`宽度 ${width}：极窄档仍在渲染副行`);
      if (probe.title !== 'WorkBuddy') problems.push(`宽度 ${width}：极窄档标题应为短名，实际「${probe.title}」`);
    } else {
      if (!probe.hasSubNode) problems.push(`宽度 ${width}：${tier} 档缺少副行`);
      // 极窄档才让按钮铺满整行；其余档按钮应各自成块、不拉满
      const fullWidth = probe.btnWidths.filter((b) => b.w >= probe.measured - 20);
      if (fullWidth.length === probe.btnWidths.length && probe.btnWidths.length > 1) {
        problems.push(`宽度 ${width}：${tier} 档按钮仍全部铺满整行（窄档规则泄漏）`);
      }
    }
    /*
     * 双栏只给**长清单**（模型勾选）。短清单（账号 / 凭据）任何宽度都得单栏：
     * 实测过 900px 时把它们也拆两栏，「名字」和「切换按钮」被分到两块，
     * 眼睛要左右来回扫才拼得出一行。
     */
    const expectGrid = tier === 'wide';
    if (probe.gridDisplay && probe.gridDisplay !== (expectGrid ? 'grid' : 'flex')) {
      problems.push(`宽度 ${width}：模型清单应为 ${expectGrid ? 'grid' : 'flex'}，实际 ${probe.gridDisplay}`);
    }
    if (expectGrid && probe.gridCols && probe.gridCols.trim().split(/\s+/).length < 2) {
      problems.push(`宽度 ${width}：宽档模型清单没有真的分成两列（${probe.gridCols}）`);
    }
    if (probe.plainDisplay && probe.plainDisplay !== 'flex') {
      problems.push(`宽度 ${width}：短清单（账号/凭据）不该被拆栏，实际 ${probe.plainDisplay}`);
    }
    /*
     * **整列必须共用一条对齐线**。
     *
     * 宽档用一个 `.wb-rail-inner` 把内容限宽 760px 居中。早期只有标题被包进
     * 那个容器、卡片漏在外面 —— 于是"标题缩进、卡片拉满整宽"，一眼就看得出
     * 没对齐（用户就是拿截图这么问的）。所以量三条左边线，必须相同。
     */
    if (probe.titleLeft !== null && probe.segLeft !== null && probe.cardLeft !== null) {
      const lefts = [probe.titleLeft, probe.segLeft, probe.cardLeft];
      const spread = Math.max(...lefts) - Math.min(...lefts);
      if (spread > 1) {
        problems.push(`宽度 ${width}：标题/页签/卡片左边界不齐（${lefts.join(' / ')}，相差 ${spread}px）`);
      }
    }
    /* 宽档限宽：内容不该被拉成 900px 的长线 */
    if (tier === 'wide' && probe.innerWidth > 0 && probe.innerWidth > 800) {
      problems.push(`宽度 ${width}：宽档内容没有被限宽（inner=${probe.innerWidth}px，应 ≤760）`);
    }
    /*
     * 上下留白**任何一档都不许丢**。
     *
     * 极窄档第一版把 padding 写成 10px 8px 14px —— 横向收窄是对的，但纵向也
     * 跟着缩：内容直接贴到 tab 条与底边，用户第一眼就看出"上下边距没了"。
     * 这里把纵向留白钉成常量，未来加档位也不会再悄悄吃掉它。
     */
    if (probe.bodyPaddingTop < 12 || probe.bodyPaddingBottom < 18) {
      problems.push(`宽度 ${width}：上下留白被压缩（top=${probe.bodyPaddingTop} bottom=${probe.bodyPaddingBottom}，应 ≥12/18）`);
    }
    /*
     * 过渡：档位是硬阈值，但几何量必须有 transition，否则拖宽跨档会"啪"地跳。
     * 这不是主观项 —— 读 computed style 就能判定有没有声明。
     */
    if (!probe.bodyTransition.includes('padding')) {
      problems.push(`宽度 ${width}：.wb-rail-body 缺少 padding 过渡（${probe.bodyTransition}）`);
    }
  }

  /*
   * ═════════════ 高度档位：把右栏拖矮（半屏 / 浮动小窗）═════════════
   *
   * 高度不够是另一类故障：清单把下面的按钮挤出可视区，用户以为"没有保存按钮"。
   * 这里真的把宿主压到每个高度，逐档断言：
   *   - `data-rail-height` 与 JS 阈值一致（与 CSS 的 @container 同值）；
   *   - 短档（<420）主操作按钮**仍在可视区内**（这是这一档存在的唯一理由）；
   *   - 短档标题行让位，把高度给内容；
   *   - 任何高度都没有横向溢出。
   */
  const HEIGHT_CASES = [
    { height: 300, tier: 'short' },
    { height: 419, tier: 'short' },
    { height: 420, tier: 'normal' },
    { height: 719, tier: 'normal' },
    { height: 720, tier: 'tall' },
    { height: 1000, tier: 'tall' },
  ];
  for (const { height, tier } of HEIGHT_CASES) {
    await resize(340, height);
    const h = JSON.parse(await page.cdp.evaluate(`JSON.stringify((() => {
      const rail = document.querySelector('[data-workbuddy-rail]');
      if (!rail) return { missing: true };
      const railBox = rail.getBoundingClientRect();
      const btns = [...rail.querySelectorAll('.wb-btn')];
      /* 按钮是否落在右栏可视区里：容器可能滚，但至少它的**客户区**要够 */
      const reachable = btns.filter((b) => {
        const r = b.getBoundingClientRect();
        return r.height >= 12 && r.top < railBox.bottom + 1;
      }).length;
      const dock = rail.querySelector('.wb-rail-dock');
      const dockBtns = dock ? [...dock.querySelectorAll('.wb-btn')] : [];
      const dockBox = dock ? dock.getBoundingClientRect() : null;
      const dockReachable = dockBtns.filter((b) => {
        const r = b.getBoundingClientRect();
        return r.height >= 12 && r.bottom <= railBox.bottom + 1 && r.top >= railBox.top - 1;
      }).length;
      return {
        tier: rail.getAttribute('data-rail-height'),
        hasHead: Boolean(rail.querySelector('.wb-rail-head')),
        overflow: rail.scrollWidth > rail.clientWidth + 1,
        buttons: btns.length,
        reachable,
        dockButtons: dockBtns.length,
        dockReachable,
        dockText: dock ? dock.innerText.trim().slice(0, 40) : '',
        /*
         * dock 的**绝对位置**：只看"按钮在容器内"会漏掉"dock 被渲染到容器外"
         * 这种情形（截图里它就在可视区下面）。所以把上下边界一起带出来，
         * 由断言比较 railBox 与 dockBox。
         */
        railTop: Math.round(railBox.top),
        railBottom: Math.round(railBox.bottom),
        dockTop: dockBox ? Math.round(dockBox.top) : null,
        dockBottom: dockBox ? Math.round(dockBox.bottom) : null,
        /* 内容总高 vs 可视高：短档要能滚到，但按钮不该被内容顶出容器 */
        contentH: rail.querySelector('.wb-rail-body') ? rail.querySelector('.wb-rail-body').scrollHeight : 0,
        viewH: Math.round(railBox.height),
      };
    })())`));
    if (!h || h.missing) { problems.push(`高度 ${height}：rail 不见了`); continue; }
    console.log(`高度 ${height}px/${tier}：tier=${h.tier} 标题=${h.hasHead} 常驻操作 ${h.dockReachable}/${h.dockButtons} 可达（「${h.dockText}」）全部按钮 ${h.reachable}/${h.buttons} 可见高=${h.viewH} 内容高=${h.contentH}`);
    if (h.tier !== tier) problems.push(`高度 ${height}：高度档应为 ${tier}，实际 ${h.tier}`);
    if (h.overflow) problems.push(`高度 ${height}：出现横向溢出`);
    /*
     * 常驻操作条是**按需出现**的：没有待办（没改下拉、没改勾选、已签完、账号页）
     * 就不渲染 —— 一条空的常驻条只是把内容与底边之间留出一片空白，看起来像一块
     * 漂着的方框（用户就是这么问的）。
     *
     * 所以这里不要求"一定有常驻条"，而要求**操作永远够得着**：
     *   - 有常驻条 → 它必须整个落在可视区内；
     *   - 没有常驻条 → 卡片里至少有一个按钮在可视区内。
     */
    if (h.dockButtons > 0) {
      if (h.dockReachable !== h.dockButtons) {
        problems.push(`高度 ${height}：常驻操作条被挤出可视区（${h.dockReachable}/${h.dockButtons} 可达；rail ${h.railTop}–${h.railBottom} / dock ${h.dockTop}–${h.dockBottom}）`);
      }
      if (h.dockTop !== null && (h.dockTop < h.railTop - 1 || h.dockBottom > h.railBottom + 1)) {
        problems.push(`高度 ${height}：操作条不在可视区内（rail ${h.railTop}–${h.railBottom} / dock ${h.dockTop}–${h.dockBottom}）`);
      }
    } else if (h.reachable === 0) {
      problems.push(`高度 ${height}：既没有常驻操作条、卡片里也没有可点的按钮（操作彻底够不着）`);
    }
    /* 内容不该把容器撑高：内容高应 ≤ 可视高（否则就是"滚不出去也点不到"） */
    if (h.contentH > h.viewH + 2) {
      problems.push(`高度 ${height}：内容把容器撑高了（内容 ${h.contentH} > 可视 ${h.viewH}）`);
    }
    if (tier === 'short' && h.hasHead) problems.push(`高度 ${height}：矮面板应让出标题行，实际还在渲染`);
    if (tier !== 'short' && !h.hasHead) problems.push(`高度 ${height}：${tier} 档不该隐藏标题行`);
  }

  /*
   * 常驻操作条是**按需出现**的，所以必须验两个方向：
   *   A. 有待办（改了下拉 / 改了勾选 / 还能签到）→ 底部出现，且落在可视区内；
   *   B. 没待办（已签完 / 账号页）→ **整条不渲染**。
   *
   * B 是用户直接问出来的问题："下面那个方方正正的是什么" —— 一条空的常驻条
   * 会在内容与底边之间留一片空白，看着像一块漂着的方框。
   */
  const dockProbe = async () => JSON.parse(await page.cdp.evaluate(`JSON.stringify((() => {
    /*
     * 页面里可能同时挂着**多个** rail 实例（英文扫描那段会再挂一个），
     * 所以这里把每个都列出来，并取**当前可见的那个**做断言 —— 只取
     * querySelector 的第一个会在多实例时读到另一个实例的状态（实测过：
     * 当前页明明是模型，读到的却是签到页的底部条）。
     */
    const rails = [...document.querySelectorAll('[data-workbuddy-rail]')].map((el) => {
      const r = el.getBoundingClientRect();
      const dock = el.querySelector('.wb-rail-dock');
      const active = el.querySelector('.wb-segmented-item.on');
      return {
        visible: r.width > 0 && r.height > 0,
        tab: active ? active.textContent.trim() : '',
        hasDock: Boolean(dock),
        dockText: dock ? dock.innerText.replace(/\\s+/g, ' ').trim() : '',
        cardBtns: [...el.querySelectorAll('.wb-btn')]
          .filter((b) => !dock || !dock.contains(b))
          .map((b) => b.textContent.trim()),
      };
    });
    const first = rails.find((r) => r.visible) || rails[0] || {};
    return { rails: rails.length, ...first };
  })())`));

  // A1：改一下下拉 → 底部应出现「设为默认」
  await resize(340, 900);
  await clickTab('模型');
  /*
   * 先等模型页数据就位：切页后 useJson 还在拉，下拉可能还没渲染出来。
   * 直接改 select 会改到空元素上 —— 断言就变成"改了下拉但底部没出现"的假失败。
   */
  await sleep(900);
  /*
   * 切页要确认**真的切了**：这段用例跑在高度循环之后，页面停在哪一页取决于
   * 前面若干步。直接断言底部内容而不确认当前页，会把"还在签到页"误报成
   * "模型页的待办没升起来"。
   */
  const onModel = JSON.parse(await page.cdp.evaluate(`JSON.stringify((() => {
    const rail = document.querySelector('[data-workbuddy-rail]');
    const active = rail.querySelector('.wb-segmented-item.on');
    return {
      tab: active ? active.textContent.trim() : '',
      hasSelect: Boolean(rail.querySelector('select')),
      hasSearch: Boolean(rail.querySelector('.wb-rail-list.is-grid')),
    };
  })())`));
  console.log('当前页：', JSON.stringify(onModel));
  if (onModel.tab !== '模型') problems.push(`切页失败：应为「模型」，实际「${onModel.tab}」`);
  const dirtyOk = JSON.parse(await page.cdp.evaluate(`JSON.stringify((() => {
    /*
     * ⚠️ 右栏里有**两个**隐藏的原生 select：
     *   1. 页签（Segmented）的 a11y 兜底，aria-label = 「模型、签到与账号」；
     *   2. 模型下拉（DropdownSelect）的 a11y 兜底，aria-label = 「模型」。
     * 用 querySelector('select') 会拿到第 1 个 —— 改它等于切页（实测过：
     * "改了下拉"之后页面跑到签到页，看着像改动触发了意外切页）。
     * 所以必须按 aria-label 精确取模型那个。
     */
    const sel = document.querySelector('[data-workbuddy-rail] .wb-dropdown .wb-hidden-select');
    if (!sel || sel.options.length < 2) return { ok: false, options: sel ? sel.options.length : 0 };
    sel.value = sel.options[1].value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, picked: sel.value };
  })())`));
  if (!dirtyOk.ok) problems.push(`模型页下拉没渲染出来（options=${dirtyOk.options}），无法验证待办态`);
  await sleep(300);
  /*
   * 改完下拉再读一次当前页：如果这里变成了别的页，说明改动触发了意外切页
   * （比如某处 handler 顺手 setTab），那才是真问题，不能拿底部内容去猜。
   */
  const afterDirty = JSON.parse(await page.cdp.evaluate(`JSON.stringify((() => {
    const rail = document.querySelector('[data-workbuddy-rail]');
    const active = rail.querySelector('.wb-segmented-item.on');
    return { tab: active ? active.textContent.trim() : '' };
  })())`));
  console.log('改下拉后当前页：', JSON.stringify(afterDirty));
  const dockDirty = await dockProbe();
  console.log('改了下拉后：', JSON.stringify(dockDirty));
  if (dirtyOk.ok) {
    if (!dockDirty.hasDock) problems.push('改了下拉，底部没有出现「设为默认」');
    else if (!dockDirty.dockText.includes('设为默认')) {
      problems.push(`改了下拉，底部操作条内容不对：${dockDirty.dockText}`);
    }
  }
  // 取消，回到无待办
  await page.cdp.evaluate(`(() => {
    const rail = document.querySelector('[data-workbuddy-rail]');
    const dock = rail.querySelector('.wb-rail-dock');
    const cancel = dock && [...dock.querySelectorAll('.wb-btn')].find((b) => b.textContent.trim() === '取消');
    if (cancel) cancel.click();
  })()`);
  await sleep(260);

  // A2：勾一下模型 → 底部应出现「保存」
  await page.cdp.evaluate(`(() => {
    const box = document.querySelector('[data-workbuddy-rail] .wb-rail-item input[type="checkbox"]');
    if (box) box.click();
  })()`);
  await sleep(260);
  const dockVisible = await dockProbe();
  console.log('改了勾选后：', JSON.stringify(dockVisible));
  if (!dockVisible.hasDock) problems.push('改了勾选，底部没有出现「保存」');
  else if (!dockVisible.dockText.includes('保存')) {
    problems.push(`改了勾选，底部操作条内容不对：${dockVisible.dockText}`);
  }

  // B1：账号页没有待办 → 不该有常驻条（用户问的就是这个方块）
  await clickTab('账号');
  await resize(340, 900);
  const dockAccount = await dockProbe();
  console.log('账号页：', JSON.stringify(dockAccount));
  if (dockAccount.hasDock) {
    problems.push(`账号页不该有常驻操作条，实际渲染了「${dockAccount.dockText}」`);
  }
  if (!dockAccount.cardBtns.length) problems.push('账号页既没有常驻条、卡片里也没有按钮');

  /*
   * B2：签到已签完 → 不该有常驻条，但卡片里要留一个写明原因的禁用按钮。
   *
   * 顺序很重要：先切到签到页（`useJson` 的 enabled 只在 tab=checkin 时为真，
   * 切页前它根本不会去拉这个接口），**再**改路由并点「刷新」。反过来的话
   * 前端拿到的还是旧数据，断言就成了假失败（实测过）。
   */
  await clickTab('签到');
  await sleep(600);
  /*
   * 改的是**页面里**的路由表（window.__routes），不是测试进程里那个 routes
   * 对象 —— 后者已经被 JSON.stringify 进 HTML 成了副本，改它不生效。
   */
  const restoreCheckin = await page.cdp.evaluate(`(() => {
    window.__savedCheckin = window.__routes['/workbuddy/checkin'];
    window.__routes['/workbuddy/checkin'] = {
      ok: true,
      status: { active: true, todayCheckedIn: true, todayCredit: 100, streakDays: 3 },
      auto: { auto: true, lastAt: Date.now() - 3600000, lastResult: 'ok', lastError: null, lastSource: 'manual' },
    };
    return true;
  })()`);
  await page.cdp.evaluate(`(() => {
    const btns = [...document.querySelectorAll('[data-workbuddy-rail] .wb-btn')];
    const refresh = btns.find((b) => b.textContent.trim() === '刷新');
    if (refresh) refresh.click();
  })()`);
  await sleep(900);
  const dockDone = await dockProbe();
  console.log('签到已签完：', JSON.stringify(dockDone));
  if (dockDone.hasDock) {
    problems.push(`签到已签完时不该有常驻操作条，实际渲染了「${dockDone.dockText}」`);
  }
  if (!dockDone.cardBtns.some((t) => t.includes('今日已领完'))) {
    problems.push(`签到已签完时卡片里应有写明原因的「今日已领完」，实际按钮：${JSON.stringify(dockDone.cardBtns)}`);
  }
  await page.cdp.evaluate(`(() => {
    window.__routes['/workbuddy/checkin'] = window.__savedCheckin;
    delete window.__savedCheckin;
    const btns = [...document.querySelectorAll('[data-workbuddy-rail] .wb-btn')];
    const refresh = btns.find((b) => b.textContent.trim() === '刷新');
    if (refresh) refresh.click();
  })()`);
  await sleep(700);
  if (!restoreCheckin) problems.push('无法改写页面路由表（window.__routes 没暴露？）');

  // 极矮 + 极窄各出一张图
  await resize(320, 320);
  await shot('rail-short-320.png');
  await resize(340, 900);

  // 极窄 / 常规 / 中 / 宽各出一张图（回执里能直接对比四档差别）
  await resize(240);
  await shot('rail-narrow-240.png');
  await resize(320);
  await shot('rail-regular-320.png');
  await resize(460);
  await shot('rail-medium-460.png');
  await resize(900);
  await shot('rail-wide-900.png');
  // 回到默认停靠宽度继续后面几步
  await resize(340);

  /*
   * 另外两页也要在最窄 / 最宽两端成立 —— 截图只拍了模型页，但**签到页的账号行**
   * 与**账号页的双列（名字 + 切换按钮）**才是最容易挤坏的两处：
   * 它们每行都有「主文案 + 侧边按钮/胶囊」，宽度一紧就互相压。
   */
  for (const [pageLabel, shotAt] of [['签到', [240, 900]], ['账号', [240, 900]]]) {
    await clickTab(pageLabel);
    for (const width of shotAt) {
      await resize(width);
      const p2 = JSON.parse(await page.cdp.evaluate(`JSON.stringify((() => {
        const rail = document.querySelector('[data-workbuddy-rail]');
        const rows = [...rail.querySelectorAll('.wb-rail-item')];
        return {
          tier: rail.getAttribute('data-rail-tier'),
          overflow: rail.scrollWidth > rail.clientWidth + 1,
          clippedButtons: [...rail.querySelectorAll('.wb-btn')].filter((b) => {
            const r = b.getBoundingClientRect();
            return r.width < 12 || r.height < 12;
          }).length,
          /* 每行里的两块不能互相压：主文案右边界 <= 侧边左边界 */
          overlaps: rows.filter((row) => {
            const main = row.querySelector('.wb-rail-item-main');
            const side = row.querySelector('.wb-rail-item-side');
            if (!main || !side) return false;
            const a = main.getBoundingClientRect();
            const b = side.getBoundingClientRect();
            return a.right > b.left + 1;
          }).length,
          rowCount: rows.length,
        };
      })())`));
      console.log(`${pageLabel}页 ${width}px：tier=${p2.tier} 行=${p2.rowCount} 重叠=${p2.overlaps} 溢出=${p2.overflow}`);
      if (p2.overflow) problems.push(`${pageLabel}页 ${width}：出现横向溢出`);
      if (p2.clippedButtons) problems.push(`${pageLabel}页 ${width}：有 ${p2.clippedButtons} 个按钮被压到点不到`);
      if (p2.overlaps) problems.push(`${pageLabel}页 ${width}：有 ${p2.overlaps} 行主文案与按钮重叠`);
      if (p2.rowCount === 0) problems.push(`${pageLabel}页 ${width}：清单是空的（夹具没喂到？）`);
      if (width === 240) await shot(`rail-${pageLabel === '签到' ? 'checkin' : 'account'}-narrow-240.png`);
    }
  }
  // 回到模型页 + 默认宽度（后面的英文用例沿用）
  await clickTab('模型');
  await resize(340);

  /*
   * 切页动画必须**真的重放**。
   *
   * 陷阱：如果三个页是同一棵子树（只换内容），animation 不会重跑 —— 屏幕
   * 上看着"第二、三次切页没有动画"，而这种问题静态读代码看不出来。所以这里
   * 在切页那一刻读 getAnimations()，断言确实有一条 wb-rail-page-in。
   *
   * 注意：每点一次都要**重新查按钮**。切页会重渲染，先前抓到的元素引用会失效
   * （实测过：连点之后对旧节点 click 会抛，整个求值就 Uncaught）。
   */
  const animSource = `(async () => {
    try {
      const out = [];
      for (const label of ['签到', '账号', '模型']) {
        const target = [...document.querySelectorAll('[data-workbuddy-rail] .wb-segmented-item')]
          .find((b) => b.textContent === label);
        if (!target) { out.push({ label, anims: [], missing: true }); continue; }
        target.click();
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const pageBox = document.querySelector('[data-workbuddy-rail] .wb-rail-page');
        const anims = pageBox && typeof pageBox.getAnimations === 'function'
          ? pageBox.getAnimations().map((a) => a.animationName || '').filter(Boolean)
          : [];
        out.push({ label, anims });
        await new Promise((r) => setTimeout(r, 260));
      }
      return JSON.stringify(out);
    } catch (error) {
      return JSON.stringify({ __error: String((error && error.stack) || error) });
    }
  })()`;
  /*
   * 用 cdp.send 直接跑，而不是 evaluate 的封装：后者只报 "Uncaught"，看不到
   * 页面里的真实原因（这一处就这样白排了几轮）。
   */
  const animRaw = await page.cdp.send('Runtime.evaluate', {
    expression: animSource, returnByValue: true, awaitPromise: true,
  });
  if (animRaw.result?.exceptionDetails) {
    const detail = animRaw.result.exceptionDetails;
    problems.push('切页动画探针在页面内抛错：'
      + String(detail.exception?.description || detail.text || 'unknown').split('\n')[0]);
  }
  const animProbe = JSON.parse(String(animRaw.result?.result?.value ?? '[]'));
  if (!Array.isArray(animProbe) && animProbe && animProbe.__error) {
    problems.push('切页动画探针异常：' + String(animProbe.__error).split('\n')[0]);
  } else if (Array.isArray(animProbe)) {
    for (const { label, anims, missing } of animProbe) {
      console.log(`切到「${label}」动画：`, JSON.stringify(anims), missing ? '(按钮没找到)' : '');
      if (missing) problems.push(`切页时找不到「${label}」的页签按钮`);
      else if (!anims.includes('wb-rail-page-in')) problems.push(`切到「${label}」没有重放切页动画（${JSON.stringify(anims)}）`);
    }
  }

  /*
   * 减少动效：宿主或系统开了 prefers-reduced-motion 时，上面那条动画必须
   * 真的关掉 —— 不是"变快"，是不播（前庭功能敏感的用户会晕）。
   */
  await page.cdp.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
  });
  await sleep(120);
  const reduced = JSON.parse(await page.cdp.evaluate(`JSON.stringify((() => {
    const box = document.querySelector('[data-workbuddy-rail] .wb-rail-page');
    const cs = box ? getComputedStyle(box) : null;
    return { animationName: cs ? cs.animationName : '', duration: cs ? cs.animationDuration : '' };
  })())`));
  await page.cdp.send('Emulation.setEmulatedMedia', { media: '' });
  console.log('reduced-motion 下：', JSON.stringify(reduced));
  if (reduced.animationName && reduced.animationName !== 'none') {
    problems.push(`prefers-reduced-motion 下切页动画没有关掉（${reduced.animationName} / ${reduced.duration}）`);
  }


  const lightDark = {};
  for (const scheme of ['light', 'dark']) {
    await page.cdp.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: scheme }],
    });
    await sleep(150);
    lightDark[scheme] = JSON.parse(await page.cdp.evaluate(`JSON.stringify((() => {
      const card = document.querySelector('[data-workbuddy-rail] .wb-card');
      const input = document.querySelector('[data-workbuddy-rail] .wb-rail-item-sub');
      return {
        cardBg: card ? getComputedStyle(card).backgroundColor : '',
        subColor: input ? getComputedStyle(input).color : '',
      };
    })())`));
  }
  await page.cdp.send('Emulation.setEmulatedMedia', { media: '' });
  console.log('配色：', JSON.stringify(lightDark));
  if (!lightDark.light.cardBg || !lightDark.dark.cardBg) problems.push('拿不到卡片底色');
  else if (lightDark.light.cardBg === lightDark.dark.cardBg) {
    problems.push('切换深浅配色后卡片底色没变（颜色写死了，没跟 light-dark()）');
  }

  /*
   * 英文模式：右栏没有自己的语言开关（它跟 `wb-plugin-lang` 走），而 LANG 是
   * **模块加载时读一次**的常量 —— 所以不能只改 localStorage，必须用同一个 factory
   * 再求值一份新模块（浏览器里等价于刷新页面），再把它挂进一个新宿主。
   *
   * 两个实测过的坑，别退回旧写法：
   *   1. 包一层 `JSON.stringify((async …)())` 序列化的是 **Promise**，得到 `{}`；
   *      序列化必须在 async 函数**内部**做。
   *   2. 汉字判断用 new RegExp 在页面里现构造：模板串里的字符类转义在"源码 → 注入"
   *      这一跳很容易少一层反斜杠，扫描就永远"没有残留"（假绿）。
   * 也顺手把注入的源码落到 out/ 里 —— 求值异常时靠它定位，而不是靠猜。
   */
  const enScanSource = `(async () => {
    try {
      localStorage.setItem('wb-plugin-lang', 'en');
      const mod = window.__registration.factory((spec) => {
        if (spec === 'react') return window.React;
        throw new Error('harness: unexpected module request ' + spec);
      });
      const host = document.createElement('div');
      host.id = 'rail-host-en';
      host.style.height = '960px';
      host.style.width = '340px';
      document.body.appendChild(host);
      ReactDOM.createRoot(host).render(React.createElement(mod.WorkBuddyRail));
      await new Promise((r) => setTimeout(r, 1200));
      const CJK = new RegExp('[' + String.fromCharCode(0x4e00) + '-' + String.fromCharCode(0x9fff) + ']');
      const scan = (el) => {
        const found = [];
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          if (n.parentElement && n.parentElement.closest('[data-wb-raw]')) continue;
          const t = (n.textContent || '').trim();
          if (CJK.test(t)) found.push(t);
        }
        for (const node of el.querySelectorAll('[title],[aria-label],[placeholder]')) {
          if (node.closest('[data-wb-raw]')) continue;
          for (const attr of ['title', 'aria-label', 'placeholder']) {
            const v = node.getAttribute(attr);
            if (v && CJK.test(v)) found.push(attr + '=' + v);
          }
        }
        return found;
      };
      const pages = { __tabs: [...host.querySelectorAll('.wb-segmented-item')].map((b) => b.textContent) };
      for (const label of ['Model', 'Check-in', 'Account']) {
        const btn = [...host.querySelectorAll('.wb-segmented-item')].find((b) => b.textContent === label);
        if (btn) btn.click();
        await new Promise((r) => setTimeout(r, 800));
        pages[label] = { residue: scan(host) };
      }
      localStorage.removeItem('wb-plugin-lang');
      return JSON.stringify(pages);
    } catch (error) {
      localStorage.removeItem('wb-plugin-lang');
      return JSON.stringify({ __error: String((error && error.stack) || error) });
    }
  })()`;
  /*
   * 注入的源码只在 `--dump-scan` 时落盘：它是排障用的中间产物，不该进版本库
   * （求值异常时靠它定位，而不是靠猜）。
   */
  if (process.argv.includes('--dump-scan')) writeFileSync(join(OUT, 'rail-en-scan.js'), enScanSource);
  const enScanResult = await page.cdp.send('Runtime.evaluate', {
    expression: enScanSource, returnByValue: true, awaitPromise: true,
  });
  const exception = enScanResult.result?.exceptionDetails;
  if (exception) {
    problems.push('英文模式求值异常：' + (exception.exception?.description || exception.text || 'unknown'));
  }
  const englishScan = JSON.parse(String(enScanResult.result?.result?.value ?? '{}'));
  if (englishScan.__error) {
    problems.push('英文模式渲染失败：' + englishScan.__error.split('\n')[0]);
  }
  console.log('英文分段控件：', JSON.stringify(englishScan.__tabs));
  for (const [page, info] of Object.entries(englishScan)) {
    if (page === '__tabs') continue;
    console.log(`英文「${page}」：残留=${JSON.stringify(info.residue)}`);
    if (info.residue.length) problems.push(`英文模式下「${page}」页仍有中文：${info.residue.join(' / ')}`);
  }
  const enTabs = englishScan.__tabs || [];
  if (enTabs.join(',') !== 'Model,Check-in,Account') {
    problems.push(`英文模式下分段控件没翻：${JSON.stringify(enTabs)}`);
  }

  /*
   * 英文截图只要那一列：先把中文那一份（#root / 标题行）藏掉，让英文宿主成为
   * 页面唯一内容，再按它的盒子裁剪。**藏完必须重新量** —— scrollIntoView 之后再取
   * rect 会拿到滚动后的坐标，裁出来的图会偏移半屏（实拍踩到）。
   */
  const enBox = JSON.parse(await page.cdp.evaluate(`JSON.stringify((() => {
    const host = document.getElementById('rail-host-en');
    if (!host) return null;
    for (const el of [document.getElementById('root'), document.getElementById('head')]) {
      if (el) el.style.display = 'none';
    }
    host.style.width = '340px';
    host.style.height = '960px';
    const r = host.getBoundingClientRect();
    return {
      x: Math.max(0, Math.round(r.left)),
      y: Math.max(0, Math.round(r.top)),
      width: Math.max(1, Math.round(r.width)),
      height: Math.min(Math.round(r.height), 940),
    };
  })())`));
  if (enBox) {
    const res = await page.cdp.send('Page.captureScreenshot', {
      format: 'png', captureBeyondViewport: true, clip: { ...enBox, scale: 1 },
    });
    writeFileSync(join(OUT, 'rail-account-en.png'), Buffer.from(res.result.data, 'base64'));
    console.log('英文截图盒：', JSON.stringify(enBox));
  } else {
    problems.push('英文宿主节点不见了，无法截图');
  }
} catch (error) {
  problems.push('运行异常：' + (error && error.stack ? error.stack.split('\n')[0] : error));
} finally {
  try { await page.close(); } catch { /* ignore */ }
  try { await new Promise((r) => extra.close(r)); } catch { /* ignore */ }
  try { await new Promise((r) => staticServer.close(r)); } catch { /* ignore */ }
}

console.log(problems.length
  ? '✘ 问题：\n - ' + problems.join('\n - ')
  : `✔ 右栏验证通过（截图见 ${OUT}）`);
process.exit(problems.length ? 1 : 0);
