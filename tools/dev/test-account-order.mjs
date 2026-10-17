/**
 * 账号列表的排序 / 隐藏 验收（控制台侧；dsh 插件面板由 panel-render / panel-i18n 覆盖）。
 *
 *   node tools/dev/test-account-order.mjs
 *
 * 盯八件事：
 *   1. 上移 / 下移提交的是**整个顺序数组**（不是"挪到谁前面"）—— 两边手里同一份列表，
 *      直接给结果才不会因为各算一套插入规则而对不上。
 *   2. 拖拽排序：dragstart 只能从**手柄**发起；落点看指针在目标行的上/下半 → 插前/插后。
 *   3. 键盘那条路与鼠标那条路**都要能排**（拖拽满足鼠标，按钮满足键盘与读屏）。
 *   4. 隐藏只发 `{file, hidden:true}`，**不动磁盘上的登录文件**；默认列表里立刻不见，
 *      勾「显示已隐藏」又能看见，并且该行带"已隐藏"标记。
 *   5. **当前生效中的那个没有隐藏按钮**（服务端也会拒：它正被桥读着）。
 *   6. 拖到自己身上 / 到头或尾的移动：不发请求、不出红字。
 *   7. **同一个账号的多份登录文件只显示一行**（用户报的"账号被记重了"）：
 *      服务端已合并，但前端也要兜住"控制台进程还是旧代码"的情况 ——
 *      同一个 uin 只渲染一行，保留"更该被看到"的那份（生效中 > 可用 > 最近），
 *      排序提交的整表里也不能出现同一账号的两行。
 *   8. 新文案在英文模式下全部翻掉。
 */
import { startStaticServer, openPage, waitFor, q, sleep } from './ui-harness.mjs';
import { baseRoutes } from './fixtures.mjs';

const PORT = 8839;
const URL_ = `http://127.0.0.1:${PORT}/`;

let failures = 0;
const fail = (m) => { console.error('✗ ' + m); failures += 1; };
const pass = (m) => console.log('✓ ' + m);

const now = Date.now();
const mk = (name, account, active = false, extra = {}) => ({
  name, path: `C:\\auth\\${name}`, active, usable: true, account,
  domain: 'www.workbuddy.cn', encrypted: true, aliasKey: account,
  expiresAt: now + 30 * 86400000, remainingMs: 30 * 86400000,
  modifiedAt: now - 3600000, userId: 'uid-' + account, alias: '', ...extra,
});
const A = mk('workbuddy-desktop.info', '330000000001', true);
const B = mk('b-snapshot.info', '450000000002');
const C = mk('c-snapshot.info', '660000000003');

const routes = {
  ...baseRoutes({ accounts: [A, B, C] }),
  '/api/account/order': { body: { ok: true, order: [A.name, B.name, C.name] } },
  '/api/account/hidden': { body: { ok: true, hidden: [B.name] } },
};

const server = await startStaticServer(PORT);
const { cdp, close } = await openPage(URL_, routes);
const cleanup = () => { try { cdp.close(); } catch { /* 忽略 */ } try { server.close(); } catch { /* 忽略 */ } };
process.on('exit', cleanup);

const rows = () => q(cdp, `Array.from(document.querySelectorAll('#accountList .acct')).map((r) => ({
  file: r.getAttribute('data-acct'),
  grip: !!r.querySelector('[data-grip]'),
  hide: r.querySelector('[data-hide]') ? r.querySelector('[data-hide]').dataset.hide : null,
  hidden: r.className.includes('acct-hidden'),
  up: !!r.querySelector('[data-up]'),
  down: !!r.querySelector('[data-down]'),
}))`);
const posts = (path) => q(cdp, `window.__reqs.filter((r) => r.path === ${JSON.stringify(path)})`);
const resetReqs = () => q(cdp, `(window.__reqs = [], true)`);
const clickSel = (sel) => q(cdp, `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.click(); return true; })()`);
const clickRowBtn = (nth, attr) => clickSel(`#accountList .acct:nth-child(${nth}) [${attr}]`);
const dragFromTo = (fromSel, toSel, half) => q(cdp, `(() => {
  const from = document.querySelector(${JSON.stringify(fromSel)});
  const to = document.querySelector(${JSON.stringify(toSel)});
  if (!from || !to) return 'missing';
  const dt = new DataTransfer();
  from.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
  const r = to.getBoundingClientRect();
  const y = ${JSON.stringify(half)} === 'bottom' ? r.bottom - 2 : r.top + 2;
  to.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientY: y }));
  to.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientY: y }));
  return 'ok';
})()`);
/** 像真实服务端那样换一份账号列表（桩不会自己记状态）。 */
const setAccounts = (list) => q(cdp, `(() => {
  window.__setRoute('/api/accounts', {
    status: 200,
    body: { dir: 'C:\\\\auth', active: 'C:\\\\auth\\\\${A.name}', accounts: ${JSON.stringify(list)}, keyError: null },
  });
  return true;
})()`);
/** 把「服务端已按这个顺序存好」这件事也同步给桩，否则页面每次重读都回到初始顺序。 */
const applyOrder = async (names) => {
  const byName = { [A.name]: A, [B.name]: B, [C.name]: C };
  await setAccounts(names.map((n) => byName[n]));
  await reloadAccounts();
};
const reloadAccounts = () => q(cdp, `(loadAccounts(), true)`);
/** 点某个账号行的「隐藏/恢复」按钮 —— 按文件名找行，不依赖第几行（顺序每步都在变）。 */
const clickHide = (name) => q(cdp, `(() => {
  const row = document.querySelector(${JSON.stringify(`#accountList .acct[data-acct="${name}"]`)});
  const btn = row && row.querySelector('[data-hide]');
  if (!btn) return false;
  btn.click();
  return true;
})()`);

try {
  await waitFor(cdp, `document.querySelectorAll('#accountList .acct').length === 3`, 10000, '账号卡片渲染');
  await sleep(250);

  // ── 0. 结构：手柄 / 三个操作按钮 / 生效中的没有隐藏按钮 ─────────────
  {
    const list = await rows();
    if (list.every(r => r.grip)) pass('每行都有拖拽手柄');
    else fail('有行缺拖拽手柄');
    if (list.every(r => r.up && r.down)) pass('每行都有上移/下移（键盘那条路）');
    else fail('有行缺上移/下移按钮');
    if (list[0].hide === null) pass('当前生效中的账号**没有**隐藏按钮');
    else fail(`生效中的账号竟有隐藏按钮（${list[0].hide}）`);
    if (list[1].hide === 'b-snapshot.info' && list[2].hide === 'c-snapshot.info') pass('非生效行有隐藏按钮，且带的是文件名');
    else fail(`隐藏按钮不对：${JSON.stringify(list.map(r => r.hide))}`);
  }

  // ── 1. 上移：提交整个顺序 ─────────────────────────────────────────
  {
    await resetReqs();
    await clickRowBtn(3, 'data-up');
    await sleep(400);
    const list = await posts('/api/account/order');
    if (list.length === 1) pass('上移发出一条 order 请求');
    else fail(`order 请求条数异常：${list.length}`);
    const body = list[0] && list[0].body;
    if (body && JSON.stringify(body.order) === JSON.stringify([A.name, C.name, B.name])) {
      pass('上移提交的是**整表顺序**（第 3 行挪到第 2 位）');
    } else fail(`上移提交的顺序不对：${JSON.stringify(body)}`);
    await applyOrder(body.order); // 桩同步，让下一步从新顺序出发
  }

  // ── 2. 下移：提交整个顺序 ─────────────────────────────────────────
  {
    await resetReqs();
    await clickRowBtn(2, 'data-down');
    await sleep(400);
    const one = (await posts('/api/account/order'))[0];
    const body = one && one.body;
    if (body && JSON.stringify(body.order) === JSON.stringify([A.name, B.name, C.name])) {
      pass('下移提交的是整表顺序（第 2 行与第 3 行对调，回到初序）');
    } else fail(`下移提交的顺序不对：${JSON.stringify(body)}`);
    await applyOrder(body.order);
  }

  // ── 3. 到头/尾的移动：不发请求 ────────────────────────────────────
  {
    await resetReqs();
    await clickRowBtn(1, 'data-up');   // 已经在第一位
    await sleep(350);
    if ((await posts('/api/account/order')).length === 0) pass('已经在第一位还点上移：不发请求');
    else fail('已经在第一位还发了 order 请求');
    if (await q(cdp, `!document.querySelector('#actionMsg').textContent`)) pass('越界移动不弹错误提示（本来就不该是错误）');
    else fail(`越界移动给了错误提示：「${await q(cdp, `document.querySelector('#actionMsg').textContent`)}」`);
  }

  // ── 4. 拖拽：下半 → 插到目标之后 ─────────────────────────────────
  {
    await resetReqs();
    const r = await dragFromTo('#accountList .acct:nth-child(1) [data-grip]', '#accountList .acct:nth-child(3)', 'bottom');
    if (r === 'ok') pass('拖拽事件链跑通（dragstart → dragover → drop）');
    else fail(`拖拽事件没连上（${r}）`);
    await sleep(500);
    const one = (await posts('/api/account/order'))[0];
    const body = one && one.body;
    if (body && JSON.stringify(body.order) === JSON.stringify([B.name, C.name, A.name])) {
      pass('拖到第 3 行下半：插到它**后面**（第 1 行 → 末尾）');
    } else fail(`拖拽后的顺序不对：${JSON.stringify(body)}`);
    await applyOrder(body.order);
  }

  // ── 5. 拖拽：上半 → 插到目标之前 ─────────────────────────────────
  {
    await resetReqs();
    await dragFromTo('#accountList .acct:nth-child(3) [data-grip]', '#accountList .acct:nth-child(2)', 'top');
    await sleep(500);
    const one = (await posts('/api/account/order'))[0];
    const body = one && one.body;
    if (body && JSON.stringify(body.order) === JSON.stringify([B.name, A.name, C.name])) {
      pass('拖到第 2 行上半：插到它**前面**（第 3 行 → 第 2 位）');
    } else fail(`拖拽后的顺序不对：${JSON.stringify(body)}`);
    await applyOrder(body.order);
  }

  // ── 6. 拖到自己身上：不发请求 ─────────────────────────────────────
  {
    await resetReqs();
    await dragFromTo('#accountList .acct:nth-child(2) [data-grip]', '#accountList .acct:nth-child(2)', 'bottom');
    await sleep(400);
    if ((await posts('/api/account/order')).length === 0) pass('拖到自己身上：不发请求');
    else fail('拖到自己身上也发了 order 请求');
  }

  // ── 7. 隐藏：请求体 + 行立刻不见 + 计数徽标 ───────────────────────
  {
    await resetReqs();
    if (!await clickHide(B.name)) fail('点不到 B 行的「隐藏」按钮');
    await sleep(450);
    const list = await posts('/api/account/hidden');
    if (list.length === 1 && list[0].body.file === B.name && list[0].body.hidden === true) {
      pass('隐藏请求体 = {file: 登录文件名, hidden: true}');
    } else fail(`隐藏请求体不对：${JSON.stringify(list)}`);
    // 桩不会自己记状态：像真实服务端那样把列表换成"B 已隐藏"（顺序仍是上一步的结果）
    await setAccounts([{ ...B, hidden: true }, A, C]);
    await reloadAccounts();
    await sleep(300);
    const n = await q(cdp, `document.querySelectorAll('#accountList .acct').length`);
    if (n === 2) pass(`默认列表里该行立刻不见（3 → ${n}）`);
    else fail(`隐藏后应剩 2 行，实际 ${n}`);
    const badge = await q(cdp, `(() => { const b = document.querySelector('#acctHiddenCount'); return { hidden: b.hidden, text: b.textContent }; })()`);
    if (badge.hidden === false && badge.text === '1') pass('「显示已隐藏」旁边出现计数 1');
    else fail(`计数徽标不对：${JSON.stringify(badge)}`);
  }

  // ── 8. 勾「显示已隐藏」：行回来且带标记 ──────────────────────────
  {
    await q(cdp, `(() => { const t = document.querySelector('#acctShowHidden'); t.checked = true; t.dispatchEvent(new Event('change')); return true; })()`);
    await sleep(400);
    const list = await rows();
    if (list.length === 3) pass('勾上「显示已隐藏」后三行都回来');
    else fail(`勾上后应 3 行，实际 ${list.length}`);
    if (list.find(r => r.file === B.name).hidden === true) pass('隐藏过的那行带 acct-hidden（压暗 + 虚线边）');
    else fail('隐藏过的行没有 hidden 标记');
    const tag = await q(cdp, `document.querySelector('#accountList .acct.acct-hidden .acct-name').textContent`);
    if (/已隐藏/.test(tag)) pass('该行标题带「已隐藏」标签');
    else fail(`缺「已隐藏」标签：「${tag}」`);
    // 恢复
    await resetReqs();
    if (!await clickHide(B.name)) fail('点不到 B 行的「恢复」按钮');
    await sleep(450);
    await setAccounts([A, B, C]);
    await reloadAccounts();
    const restored = (await posts('/api/account/hidden'))[0];
    if (restored && restored.body.hidden === false) pass('再点一次 = 恢复（hidden: false）');
    else fail(`恢复请求不对：${JSON.stringify(await posts('/api/account/hidden'))}`);
  }

  // ── 9. 同账号多份快照：只显示一行（前端兜底，旧服务端也看不到重复） ──
  {
    /*
     * 服务端 `listAccounts()` 已经合并同一账号的多份登录文件；这里模拟**旧服务端**
     * （控制台进程没重启、lib/ 还是旧代码）仍回两行的情况 —— 界面必须兜住：
     * 同一个 uin 只渲染一行，且留下"更该被看到"的那份（这里是更新的快照）。
     */
    const B2 = { ...B, name: 'b-snapshot-2.info', modifiedAt: now - 1000 };
    await setAccounts([A, B, B2, C]);
    await reloadAccounts();
    await sleep(350);
    const list = await rows();
    if (list.length === 3) pass('同一账号的两份登录文件只显示 1 行（4 个文件 → 3 行）');
    else fail(`应 3 行，实际 ${list.length}：${JSON.stringify(list.map(r => r.file))}`);
    const sameAcctRows = list.filter(r => r.file === B.name || r.file === B2.name);
    if (sameAcctRows.length === 1) pass('同一个账号没有出现两行（用户不会看到两个一样的账号）');
    else fail(`同一账号仍渲染 ${sameAcctRows.length} 行：${JSON.stringify(sameAcctRows.map(r => r.file))}`);
    if (sameAcctRows[0] && sameAcctRows[0].file === B2.name) pass('留下的是更新的那份快照（生效中 > 可用 > 最近）');
    else fail(`留下的快照不对：${sameAcctRows[0] && sameAcctRows[0].file}`);
    if (list.filter(r => r.file === A.name || r.file === C.name).length === 2) pass('其它账号不受影响');
    else fail('其它账号被误合并了');

    // 三个不同账号：不出现重复行，也不需要任何"合并"提示
    await setAccounts([A, B, C]);
    await reloadAccounts();
    await sleep(300);
    const again = await rows();
    if (again.length === 3) pass('三个不同账号：三行都在');
    else fail(`三个不同账号应 3 行，实际 ${again.length}`);
    // 生效中的账号必须留下（哪怕另一份快照更新）
    await setAccounts([A, B2, { ...A, name: 'a-snapshot-2.info', active: false, modifiedAt: now }]);
    await reloadAccounts();
    await sleep(350);
    const activeKept = (await rows()).filter(r => r.file === A.name || r.file === 'a-snapshot-2.info');
    if (activeKept.length === 1 && activeKept[0].file === A.name) pass('合并时保留生效中的那份（active 优先于"更新"）');
    else fail(`生效中的账号没被留下：${JSON.stringify(activeKept.map(r => r.file))}`);
  }

  // ── 10. 合并后排序：提交的整表里不能出现同一账号的两行 ────────────────
  {
    const B2 = { ...B, name: 'b-snapshot-2.info', modifiedAt: now - 1000 };
    await setAccounts([A, B, B2, C]);
    await reloadAccounts();
    await sleep(300);
    await resetReqs();
    // 点 C 的「上移」：桩里有 4 个文件 / 3 个账号，提交的顺序里只能有 3 个文件名
    await clickSel(`#accountList .acct[data-acct="${C.name}"] [data-up]`);
    await sleep(400);
    const one = (await posts('/api/account/order'))[0];
    const body = one && one.body;
    if (body && JSON.stringify(body.order) === JSON.stringify([A.name, C.name, B2.name])) {
      pass('合并后「上移」提交的整表顺序只有一行一个账号（跳过被合并的快照）');
    } else fail(`合并后上移提交顺序不对：${JSON.stringify(body && body.order)}`);
    // 拖拽同理
    await setAccounts([A, C, B, B2]);
    await reloadAccounts();
    await sleep(250);
    await resetReqs();
    await dragFromTo(`#accountList .acct[data-acct="${A.name}"] [data-grip]`, `#accountList .acct[data-acct="${C.name}"]`, 'bottom');
    await sleep(500);
    const dragOne = (await posts('/api/account/order'))[0];
    const dragOrder = dragOne && dragOne.body && dragOne.body.order;
    if (dragOrder && JSON.stringify(dragOrder) === JSON.stringify([C.name, A.name, B2.name])) {
      pass('合并后拖拽提交的顺序同样只有一行一个账号（A 拖到 C 后面 → [C, A, B]）');
    } else fail(`合并后拖拽提交顺序不对：${JSON.stringify(dragOrder)}`);
  }

  // ── 11. 英文：新文案都翻了 ────────────────────────────────────────
  {
    const B2 = { ...B, name: 'b-snapshot-2.info' };
    await setAccounts([A, B, B2, C]);
    await reloadAccounts();
    await sleep(300);
    await q(cdp, `document.getElementById('langToggle').click()`);
    await sleep(400);
    const cjk = await q(cdp, `(() => {
      const el = document.querySelector('#accountList');
      const m = el.textContent.match(/[\\u4e00-\\u9fff]/g);
      return m ? [...new Set(m)].join('') : '';
    })()`);
    if (!cjk) pass('英文模式账号面板无残留中文');
    else fail(`英文模式仍有中文：${cjk}（看 accountOrder 的渲染）`);
    const grip = await q(cdp, `document.querySelector('.acct-grip').getAttribute('aria-label')`);
    if (grip === 'Drag to reorder') pass('拖拽手柄的 aria-label 也翻了');
    else fail(`手柄标签不对：「${grip}」`);
    await q(cdp, `document.getElementById('langToggle').click()`);
    await sleep(300);
  }
} catch (err) {
  fail(`异常中断：${err.message}`);
} finally {
  cleanup();
}

console.log(failures ? `\n存在 ${failures} 项失败` : '\n全部通过');
process.exit(failures ? 1 : 0);
