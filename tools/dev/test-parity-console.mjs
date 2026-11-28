/**
 * 控制台 ⇄ dsh 面板「功能对齐」验收（无头 Chromium + 全量打桩）。
 *
 *   node tools/dev/test-parity-console.mjs
 *
 * ## 这一组用例守的是什么
 *
 * 用户的要求是「控制台功能对齐插件里面功能」。对齐不是"看起来差不多"，而是
 * **同一份数据、两处给出同一个结论**。所以这里逐块验证控制台新补上的四块：
 *
 *   1. **用量上限（跨账号）**：三条不同 `kind` 必须给出三种不同处置文案
 *      （额度用尽带倒计时 / 积分不足**不带**倒计时 / 被风控只能换号），
 *      并且属于另一个账号的条目也要显示（否则用户以为只看得到当前号）。
 *      已有文件、坏文件、过期条目都由 `dsh-plugin/tests/limit-history.test.mjs`
 *      与 `lib` 侧单测钉住，这里只管界面结论。
 *
 *   2. **本机各账号签到**：分母必须是"有活动的账号数"而不是账号总数
 *      （国际版网关没有积分活动，算进去进度条永远填不满、`2/4` 与可见的 2 行
 *      打架）；无活动的账号是**折叠**而不是藏起来；过期账号不算可领取。
 *
 *   3. **模型测速**：只在你点名时才打 `/api/tps`（不许自动跑 —— 每次三趟
 *      要花钱），结果**不落盘**，失败要说清是哪一种。
 *
 *   4. **「未列出」标记与筛选**：网关有、官方选择器不铺的模型必须可辨识，
 *      「隐藏未列出」在表格每 20 秒重建后仍保留（否则用户以为开关坏了）。
 *
 * 全程打桩，不启真控制台、不消耗任何额度。
 */
import {
  startStaticServer, openPage, waitFor, click, q, sleep,
} from './ui-harness.mjs';
import {
  baseRoutes, limitsFixture, limitsEmptyFixture, checkinAccountsFixture,
  checkinClaimAllFixture, CATALOG,
} from './fixtures.mjs';

const PORT = process.env.PARITY_PORT ? Number(process.env.PARITY_PORT) : 8785;
const URL_ = `http://127.0.0.1:${PORT}/`;

let failures = 0;
const fail = (m) => { console.error('✗ ' + m); failures += 1; };
const pass = (m) => console.log('✓ ' + m);

/*
 * 目录里刻意放一个 `official: false`（网关有、官方选择器不铺）——
 * 「隐藏未列出」与「仅未列出」两条分支都靠它才走得到。
 */
const CATALOG2 = [
  { ...CATALOG[0], id: 'm1', name: 'M1', official: true },
  { ...CATALOG[0], id: 'm2', name: 'M2', official: true },
  { ...CATALOG[0], id: 'gray-x', name: 'GRAY-X', official: false },
];

const routes = {
  ...baseRoutes({ catalog: CATALOG2 }),
  '/api/checkin/accounts': { body: checkinAccountsFixture() },
  '/api/checkin/all': { body: checkinClaimAllFixture() },
  '/api/limits': { body: limitsFixture() },
  '/api/tps': {
    /*
     * 桩里**只按查询串取模型 id**，且整个函数必须自包含。
     *
     * `serializeRoutes` 用 `toString()` 把函数塞进页面执行 —— 页面里既没有
     * `tpsFixture`（那是 Node 侧模块），也不能用 `new URL(相对串)`（会抛）。
     * 前者让 fetch 直接抛异常、页面拿到的是 undefined，于是每次测速都显示
     * "失败"（实测踩到这一条）。所以这里**手写返回对象**。
     */
    body: (url) => {
      const m = /model=([^&]+)/.exec(String(url || ''));
      return {
        ok: true,
        cached: false,
        sample: {
          model: m ? decodeURIComponent(m[1]) : 'm1',
          tokensPerSecond: 416,
          timeToFirstTokenMs: 815,
          samples: 3,
          complete: true,
        },
      };
    },
  },
};

const server = await startStaticServer(PORT);
const { cdp, close } = await openPage(URL_, routes, {
  /* 捕获页面自己抛出的错误（i18n 用例同一套做法，不依赖 CDP 的异常事件） */
  inject: `window.__ERRORS = []; window.addEventListener('error', (e) => window.__ERRORS.push(String(e.message)));`,
});
const cleanup = () => { try { cdp.close(); } catch { /* 忽略 */ } try { server.close(); } catch { /* 忽略 */ } };
process.on('exit', cleanup);

const txt = (sel) => q(cdp, `(document.querySelector(${JSON.stringify(sel)})||{}).textContent || ''`);
const setRoute = (path, route) => q(cdp, `(window.__setRoute(${JSON.stringify(path)}, ${JSON.stringify(route)}), true)`);
const callsTo = (path) => q(cdp, `window.__calls.filter(p => p === ${JSON.stringify(path)}).length`);

try {
  await waitFor(cdp, `!!document.querySelector('#limitsBox') && !!document.querySelector('#acctCheckinBox')`, 12000, '新增面板存在');
  await waitFor(cdp, `document.querySelectorAll('#modelTable tbody tr').length === 3`, 12000, '模型表渲染');
  await sleep(400);

  /* ── 1. 用量上限：三种 kind 三种结论 + 跨账号 + 倒计时 ───────────── */
  {
    const box = await txt('#limitsBox');
    if (/额度已用尽/.test(box)) pass('用量上限：quota 条目显示「额度已用尽」');
    else fail(`用量上限：缺少「额度已用尽」—— ${box.slice(0, 160)}`);

    if (/积分不足/.test(box) && /需充值，不会自动恢复/.test(box)) {
      pass('用量上限：credits 条目写明「需充值，不会自动恢复」');
    } else fail(`用量上限：credits 分支异常 —— ${box.slice(0, 200)}`);

    /*
     * 「积分不足」**不许**带倒计时。这是用户直接指出来的缺陷：
     * 上游文案里混着套餐到期日，被当成 resetAt 后界面出现「积分不足但还剩 X 小时」。
     */
    if (!/积分不足[^]*?还剩/.test(box)) pass('用量上限：credits 条目**不显示**倒计时');
    else fail(`用量上限：credits 条目错误地显示了倒计时 —— ${box.slice(0, 240)}`);

    if (/账号被风控/.test(box) && /换号（重新登录无效）/.test(box)) {
      pass('用量上限：account_restricted 写明「换号（重新登录无效）」');
    } else fail(`用量上限：风控分支异常 —— ${box.slice(0, 200)}`);

    if (/国际版1/.test(box)) pass('用量上限：属于**另一个账号**的条目也在列表里（跨账号）');
    else fail(`用量上限：看不到另一个账号的条目 —— ${box.slice(0, 200)}`);

    if (/所有账号都已列出，不只当前这个/.test(box)) {
      pass('用量上限：写明「所有账号都已列出，不只当前这个」');
    } else fail('用量上限：缺少"不只是当前账号"的说明');

    if (/还剩 /.test(box)) pass('用量上限：带恢复时间的条目显示倒计时');
    else fail(`用量上限：没有倒计时 —— ${box.slice(0, 200)}`);
  }

  /* ── 1b. 上限清空后必须说「没有」，而不是留白 ────────────────────── */
  {
    await setRoute('/api/limits', { body: limitsEmptyFixture({ expiredCount: 2 }) });
    await q(cdp, `loadLimits({refresh:true})`);
    await sleep(300);
    const box = await txt('#limitsBox');
    if (/额度已恢复（刚到期移除）/.test(box)) {
      pass('用量上限：清空时说明「额度已恢复（刚到期移除）」');
    } else fail(`用量上限：清空态文案异常 —— ${box.slice(0, 160)}`);
    // 恢复现场
    await setRoute('/api/limits', { body: limitsFixture() });
    await q(cdp, `loadLimits({refresh:true})`);
    await sleep(200);
  }

  /* ── 2. 本机各账号签到 ───────────────────────────────────────────── */
  {
    const box = await txt('#acctCheckinBox');
    /*
     * 分母 = 有活动的账号数（2），不是账号总数（3）—— 第三个是 noActivity。
     * 写死 `1/2` 而不是"包含 1/3"，是因为后者正是这条断言要防的错误。
     */
    if (/今日已签\s*1\/2\b/.test(box.replace(/\u00a0/g, ' ')) || /1\/2/.test(box)) {
      pass('账号签到：分母是「有活动的账号数」（1/2），不是账号总数');
    } else fail(`账号签到：分母异常 —— ${box.slice(0, 200)}`);

    if (!/1\/3/.test(box)) pass('账号签到：无活动的账号**不**计入分母');
    else fail(`账号签到：把无活动账号算进了分母 —— ${box.slice(0, 200)}`);

    if (/个账号无签到活动，已折叠/.test(box)) {
      pass('账号签到：无活动的账号折叠成一行可点开的摘要');
    } else fail(`账号签到：缺少折叠摘要 —— ${box.slice(0, 220)}`);

    if (/全部领取/.test(box)) pass('账号签到：「全部领取」按钮存在');
    else fail('账号签到：缺少「全部领取」');

    /* 点「展开」必须真的把无活动的行渲染出来（只折叠不给入口 = 把号藏起来） */
    await q(cdp, `(document.getElementById('acctCheckinToggle').click(), true)`);
    await sleep(160);
    const opened = await txt('#acctCheckinBox');
    if (/国际版2/.test(opened)) pass('账号签到：展开后能看到无活动账号的真实行');
    else fail(`账号签到：展开后仍看不到无活动账号 —— ${opened.slice(0, 240)}`);
  }

  /* ── 2b. 「全部领取」只发一次 POST，且结果如实汇总 ────────────────── */
  {
    const before = await q(cdp, `window.__reqs.filter(r => r.path === '/api/checkin/all' && r.method === 'POST').length`);
    await click(cdp, '#acctCheckinAllBtn');
    await sleep(600);
    const after = await q(cdp, `window.__reqs.filter(r => r.path === '/api/checkin/all' && r.method === 'POST').length`);
    if (after === before + 1) pass('账号签到：「全部领取」只发一次 POST');
    else fail(`账号签到：「全部领取」发了 ${after - before} 次 POST`);

    const msg = await txt('#actionMsg');
    if (/全部领取：/.test(msg) && /领取 1 个/.test(msg)) {
      pass(`账号签到：结果如实汇总（${msg.trim().slice(0, 40)}）`);
    } else fail(`账号签到：结果汇总异常 —— 「${msg.slice(0, 120)}」`);
  }

  /* ── 3. 模型测速：默认不跑、点名才跑、结果不落盘 ─────────────────── */
  {
    const before = await callsTo('/api/tps');
    if (before === 0) pass('测速：页面加载时**不打** /api/tps（要花钱，必须点名）');
    else fail(`测速：页面自己打了 ${before} 次 /api/tps`);

    const cellText = await q(cdp, `(document.querySelector('#modelTable td[data-tps="m1"]')||{}).textContent || ''`);
    if (/测速/.test(cellText)) pass('测速：表格里每个模型都有「测速」按钮');
    else fail(`测速：单元格里没有按钮 —— 「${cellText}」`);

    await q(cdp, `(() => {
      const td = document.querySelector('#modelTable td[data-tps="m1"]');
      const b = td && td.querySelector('button.tpsbtn');
      if (!b) return false;
      b.click();
      return true;
    })()`);
    await sleep(700);
    const after = await callsTo('/api/tps');
    if (after === 1) pass('测速：点一次只打一次 /api/tps');
    else fail(`测速：点一次打了 ${after} 次 /api/tps`);

    const cell = await txt('#modelTable td[data-tps="m1"]');
    if (/416 tok\/s/.test(cell) && /首字节 815ms/.test(cell)) {
      pass(`测速：结果按「tok/s · 首字节」渲染（${cell.trim().slice(0, 40)}）`);
    } else fail(`测速：结果渲染异常 —— 「${cell}」`);

    /* 结果**不落盘**：本地存储里不该出现任何与测速有关的东西 */
    const persisted = await q(cdp, `Object.keys(localStorage).filter(k => /tps|speed/i.test(k)).length`);
    if (persisted === 0) pass('测速：结果不落盘（localStorage 里没有任何测速键）');
    else fail(`测速：结果被写进了 localStorage（${persisted} 个键）`);
  }

  /* ── 3b. 测速失败必须说清是哪一种，不是破折号 ─────────────────────── */
  {
    await setRoute('/api/tps', {
      body: { ok: false, error: 'upstream boom', sample: { model: 'm2', samples: 0, complete: false, reason: 'all-failed' } },
    });
    await q(cdp, `(() => {
      const td = document.querySelector('#modelTable td[data-tps="m2"]');
      const b = td && td.querySelector('button.tpsbtn');
      if (!b) return false;
      b.click();
      return true;
    })()`);
    await sleep(600);
    const cell = await txt('#modelTable td[data-tps="m2"]');
    if (/测速失败/.test(cell)) pass('测速：失败时显示「测速失败」，不是破折号');
    else fail(`测速：失败态异常 —— 「${cell}」`);
  }

  /* ── 4. 「未列出」标记与「隐藏未列出」 ────────────────────────────── */
  {
    const tag = await q(cdp, `!!document.querySelector('#modelTable tr[data-model-id="gray-x"] .tag.unlisted')`);
    if (tag) pass('未列出：官方选择器不铺的模型带「未列出」徽标');
    else fail('未列出：gray-x 行没有「未列出」徽标');

    const officialRow = await q(cdp, `!!document.querySelector('#modelTable tr[data-model-id="m1"] .tag.unlisted')`);
    if (!officialRow) pass('未列出：官方列出的模型**不**带该徽标（不误标）');
    else fail('未列出：官方列出的 m1 也被标成了未列出');

    /* 勾上「隐藏未列出」→ gray-x 消失，计数条说清「已隐藏 N」 */
    await q(cdp, `(() => {
      const cb = document.getElementById('modelHideUnlisted');
      cb.checked = true;
      cb.dispatchEvent(new Event('change'));
      return true;
    })()`);
    await sleep(160);
    const visible = await q(cdp, `[...document.querySelectorAll('#modelTable tbody tr')].filter(tr => tr.style.display !== 'none').map(tr => tr.dataset.modelId)`);
    if (!visible.includes('gray-x')) pass('未列出：「隐藏未列出」把 gray-x 从视图里去掉了');
    else fail(`未列出：勾了隐藏仍看到 gray-x —— ${JSON.stringify(visible)}`);

    const info = await txt('#filterInfo');
    if (/已隐藏 1/.test(info)) pass(`未列出：计数条说清「已隐藏 N」（${info.trim()}）`);
    else fail(`未列出：计数条没有说明隐藏了多少 —— 「${info}」`);

    /*
     * **表格重建后开关必须还在**。表格每 20 秒按目录指纹重建一次；
     * 如果开关回到默认关，用户会以为它坏了（而他正靠它把 50 多个模型收窄）。
     */
    await q(cdp, `(() => {
      lastModelSig = '';
      renderModelSection();
      return true;
    })()`);
    await sleep(300);
    const stillChecked = await q(cdp, `document.getElementById('modelHideUnlisted') && document.getElementById('modelHideUnlisted').checked`);
    const stillHidden = await q(cdp, `(() => {
      const tr = document.querySelector('#modelTable tr[data-model-id="gray-x"]');
      return !tr || tr.style.display === 'none';
    })()`);
    if (stillChecked && stillHidden) pass('未列出：表格重建后开关仍勾着、行仍隐藏（状态被保留）');
    else fail(`未列出：重建后状态丢了（checked=${stillChecked} hidden=${stillHidden}）`);
  }

  /* ── 4b. 「仅未列出」下拉与「隐藏未列出」语义互补 ─────────────────── */
  {
    await q(cdp, `(() => {
      const cb = document.getElementById('modelHideUnlisted');
      cb.checked = false;
      cb.dispatchEvent(new Event('change'));
      const s = document.getElementById('modelKind');
      s.value = 'unlisted';
      s.dispatchEvent(new Event('change'));
      return true;
    })()`);
    await sleep(160);
    const visible = await q(cdp, `[...document.querySelectorAll('#modelTable tbody tr')].filter(tr => tr.style.display !== 'none').map(tr => tr.dataset.modelId)`);
    if (visible.length === 1 && visible[0] === 'gray-x') {
      pass('未列出：「仅未列出」只留未列出的模型（便于先体检再决定显示）');
    } else fail(`未列出：「仅未列出」筛出了 ${JSON.stringify(visible)}`);
  }

  /* ── 5. 无页面运行时报错 ──────────────────────────────────────────── */
  {
    const errs = await q(cdp, `window.__ERRORS || []`);
    if (errs.length === 0) pass('无页面运行时报错');
    else fail(`页面有 ${errs.length} 条运行时报错：${JSON.stringify(errs.slice(0, 3))}`);
  }
} finally {
  cleanup();
}

console.log('');
if (failures) {
  console.error(`✗ 对齐验收失败 ${failures} 项`);
  process.exit(1);
}
console.log('✓ 控制台 ⇄ 面板 功能对齐验收全部通过');