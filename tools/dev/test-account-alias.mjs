/**
 * 账号自定义名字（别名）界面验收。
 *
 *   node tools/dev/test-account-alias.mjs
 *
 * 盯五件事，每件都能单独失败：
 *   1. **有名字就用名字**：卡片主标题 = 自定义名、uin 落到副行；没名字的卡片
 *      **逐字不变**（主标题仍是 uin、副行**不重复** uin）—— 防止"顺手把默认渲染也改了"。
 *   2. 点「改名」→ 弹窗 → 输入 → 保存：POST `/api/account/alias`，body 是
 *      `{file: <登录文件名>, alias}`。**file 必须是文件名**：服务端要拿它现读 uin
 *      当键，前端传 uin 的话，客户端换号（同名文件被原地覆盖）后名字会贴到另一个账号上。
 *   3. 取消（Esc / 点遮罩）→ **一个请求都不发**。
 *   4. **按钮顺序契约**：harness 自动接管自绘弹窗时，`b[0]` 当取消、`b[最后一个]` 当确定。
 *      所以「取消」必须在 DOM 里排在前、「保存」排在后 —— 顺序反了不会报错，
 *      只会让所有依赖自动接管的用例**静默点错按钮**。这里显式把它钉住。
 *   5. 英文模式下弹窗里没有残留中文 —— 弹窗是运行时新建的节点，最容易漏翻。
 *
 * 弹窗本身要检查，所以先 `setDialogAuto(false)` 关掉自动接管（见 ui-harness 的说明）。
 */
import { startStaticServer, openPage, waitFor, q, sleep } from './ui-harness.mjs';
import { baseRoutes } from './fixtures.mjs';

const PORT = 8836;
const URL_ = `http://127.0.0.1:${PORT}/`;

let failures = 0;
const fail = (m) => { console.error('✗ ' + m); failures += 1; };
const pass = (m) => console.log('✓ ' + m);

const now = Date.now();
const A1 = {
  name: 'workbuddy-desktop.info', path: 'C:\\auth\\workbuddy-desktop.info',
  active: true, usable: true, account: '330000000001', domain: 'www.workbuddy.cn',
  encrypted: true, expiresAt: now + 30 * 86400000, remainingMs: 30 * 86400000,
  modifiedAt: now - 3600000, userId: 'uid-1', aliasKey: '330000000001', alias: '工作号',
};
const A2 = {
  name: 'workbuddy-desktop-ai.info', path: 'C:\\auth\\workbuddy-desktop-ai.info',
  active: false, usable: true, account: '450000000002', domain: 'www.workbuddy.ai',
  encrypted: true, expiresAt: now + 30 * 86400000, remainingMs: 30 * 86400000,
  modifiedAt: now - 7200000, userId: 'uid-2', aliasKey: '450000000002', alias: '',
};

const routes = {
  ...baseRoutes({ accounts: [A1, A2] }),
  // 写接口的响应（只有真的发出请求才会用到）
  '/api/account/alias': { body: { ok: true, key: '450000000002', alias: '个人号', accountAliases: {} } },
};

const server = await startStaticServer(PORT);
const { cdp, close, setDialogAuto, setDialogHandler } = await openPage(URL_, routes);
const cleanup = () => { try { cdp.close(); } catch { /* 忽略 */ } try { server.close(); } catch { /* 忽略 */ } };
process.on('exit', cleanup);

const cards = () => q(cdp, `Array.from(document.querySelectorAll('#accountList .acct')).map((el) => ({
  title: el.querySelector('.acct-name').textContent.trim(),
  sub: el.querySelector('.acct-sub').textContent.trim(),
  file: el.querySelector('[data-alias]') ? el.querySelector('[data-alias]').dataset.alias : null,
}))`);
const posts = (path) => q(cdp, `window.__reqs.filter((r) => r.path === ${JSON.stringify(path)})`);
const resetReqs = () => q(cdp, `(window.__reqs = [], true)`);
const clickSel = (sel) => q(cdp, `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.click(); return true; })()`);
const openRename = (nth) => clickSel(`#accountList .acct:nth-child(${nth}) [data-alias]`);
const dialogOpen = () => q(cdp, `!!document.querySelector('.modal-input')`);
const dialogText = () => q(cdp, `document.querySelector('.modal') ? document.querySelector('.modal').textContent : ''`);
const setInput = (sel, text) => q(cdp, `(() => {
  const el = document.querySelector(${JSON.stringify(sel)});
  if (!el) return false;
  el.value = ${JSON.stringify(text)};
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
const esc = () => q(cdp, `(document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })), true)`);

setDialogAuto(false); // 弹窗要自己看、自己点

try {
  await waitFor(cdp, `document.querySelectorAll('#accountList .acct').length === 2`, 10000, '账号卡片渲染');
  await sleep(250);

  // ── 1. 显示：有名字用名字，没名字逐字不变 ───────────────────────────
  {
    const list = await cards();
    if (list[0].title.startsWith('工作号')) pass('有名字的卡片：主标题用自定义名');
    else fail(`有名字的卡片主标题不对：「${list[0].title}」`);
    if (list[0].sub.includes('330000000001') && list[0].sub.includes('workbuddy-desktop.info')) {
      pass('有名字的卡片：副行仍给出 uin 与文件名（名字不吞掉身份信息）');
    } else fail(`副行缺 uin/文件名：「${list[0].sub}」`);

    if (list[1].title.startsWith('450000000002')) pass('没名字的卡片：主标题仍是 uin（默认渲染不变）');
    else fail(`没名字的卡片主标题不对：「${list[1].title}」`);
    if (!list[1].sub.includes('450000000002')) pass('没名字的卡片：副行不重复 uin（与改动前逐字一致）');
    else fail(`没名字的卡片副行多出了 uin：「${list[1].sub}」`);
    if (list[0].file === 'workbuddy-desktop.info' && list[1].file === 'workbuddy-desktop-ai.info') {
      pass('「改名」按钮带的是**登录文件名**（不是 uin）');
    } else fail(`改名按钮上的标识不对：${list[0].file} / ${list[1].file}`);
  }

  // ── 2. 改名：弹窗 + 输入 + 请求体 ───────────────────────────────────
  {
    await resetReqs();
    if (!await openRename(2)) fail('点不到第 2 张卡片的「改名」按钮');
    await waitFor(cdp, `!!document.querySelector('.modal-input')`, 5000, '改名弹窗出现');
    const text = await dialogText();
    if (/给这个账号起个名字/.test(text)) pass('弹窗写明用途');
    else fail(`弹窗文案不对：「${text}」`);
    if (/留空/.test(text)) pass('弹窗写明「留空 = 恢复默认显示」');
    else fail('弹窗没写清留空的效果');
    const pre = await q(cdp, `document.querySelector('.modal-input').value`);
    if (pre === '') pass('没名字时输入框为空（不是 undefined）');
    else fail(`输入框预填异常：「${pre}」`);
    const ph = await q(cdp, `document.querySelector('.modal-input').placeholder`);
    if (/工作号/.test(ph)) pass('输入框有示例占位符（提示能填什么）');
    else fail(`占位符异常：「${ph}」`);

    await setInput('.modal-input', '个人号');
    await clickSel('.modal-actions button.primary');
    await sleep(400);
    const list = await posts('/api/account/alias');
    if (list.length === 1) pass('保存后恰好发出一条改名请求');
    else fail(`改名请求条数异常：${list.length}`);
    const body = list[0] && list[0].body;
    if (body && body.file === 'workbuddy-desktop-ai.info') {
      pass('请求体 file = 登录文件名（服务端据此现读 uin 当键）');
    } else fail(`请求体 file 不对：${JSON.stringify(body)}`);
    if (body && body.alias === '个人号') pass('请求体 alias = 输入的名字');
    else fail(`请求体 alias 不对：${JSON.stringify(body)}`);
    if (!await dialogOpen()) pass('保存后弹窗关闭');
    else fail('保存后弹窗没关');
  }

  // ── 3. 取消：一个请求都不发 ─────────────────────────────────────────
  {
    await resetReqs();
    await openRename(1);
    await waitFor(cdp, `!!document.querySelector('.modal-input')`, 5000, '第二次弹窗出现');
    const pre = await q(cdp, `document.querySelector('.modal-input').value`);
    if (pre === '工作号') pass('已有名字时输入框预填现有名字（可直接改）');
    else fail(`输入框预填现有名字失败：「${pre}」`);
    await esc();
    await sleep(300);
    if (!await dialogOpen()) pass('Esc 关闭弹窗');
    else fail('Esc 没关掉弹窗');

    await openRename(1);
    await waitFor(cdp, `!!document.querySelector('.modal-input')`, 5000, '第三次弹窗出现');
    await clickSel('.modal-scrim');
    await sleep(300);
    if (!await dialogOpen()) pass('点遮罩关闭弹窗');
    else fail('点遮罩没关掉弹窗');

    const list = await posts('/api/account/alias');
    if (list.length === 0) pass('两次取消都**没有**发出改名请求');
    else fail(`取消后仍发出了 ${list.length} 条改名请求`);
  }

  // ── 4. 按钮顺序契约（harness 自动接管时靠 b[0]=取消 / b[last]=确定）──
  {
    setDialogAuto(true);
    // 4a. 自动「取消」：harness 点 b[0]，必须真的取消（不能把名字改掉）
    setDialogHandler(() => false);
    await resetReqs();
    await openRename(1);
    await sleep(500);
    if (!await dialogOpen()) pass('自动接管（拒绝）时弹窗被关掉');
    else fail('自动接管（拒绝）时弹窗没关');
    if ((await posts('/api/account/alias')).length === 0) pass('自动「取消」点的是**取消**按钮（b[0]），没发请求');
    else fail('自动「取消」却发出了请求 —— 按钮顺序可能被调换了');

    // 4b. 自动「确定」：harness 点最后一个按钮，必须真的保存
    setDialogHandler(() => true);
    await resetReqs();
    await openRename(1);
    await sleep(500);
    const list = await posts('/api/account/alias');
    if (list.length === 1) pass('自动「确定」点的是**保存**按钮（b[last]），请求正常发出');
    else fail(`自动「确定」没发出请求（${list.length} 条）—— 按钮顺序可能被调换了`);
  }

  // ── 5. 英文模式：弹窗与副行都不能有残留中文 ─────────────────────────
  {
    setDialogAuto(false);
    await q(cdp, `document.getElementById('langToggle').click()`);
    await sleep(400);
    await openRename(1);
    await waitFor(cdp, `!!document.querySelector('.modal-input')`, 5000, '英文模式弹窗出现');
    const text = await dialogText();
    const cjk = text.match(/[\u4e00-\u9fff]/g);
    if (!cjk) pass('英文模式下弹窗无残留中文');
    else fail(`英文模式弹窗仍有中文：${[...new Set(cjk)].join('')} —— 「${text}」`);
    const btns = await q(cdp, `Array.from(document.querySelectorAll('.modal-actions button')).map((b) => b.textContent)`);
    if (btns.join('|') === 'Cancel|Save') pass('英文模式按钮文案 = Cancel / Save');
    else fail(`英文模式按钮文案不对：${JSON.stringify(btns)}`);
    const ph = await q(cdp, `document.querySelector('.modal-input').placeholder`);
    if (ph && !/[\u4e00-\u9fff]/.test(ph)) pass('英文模式占位符已翻（属性通道也要扫）');
    else fail(`英文模式占位符仍有中文：「${ph}」`);

    await esc();
    await sleep(250);
    // 副行的四段形态（有名字时多一段 uin）也要能翻 —— i18n 规则顺序的现场证明
    const enSub = await q(cdp, `document.querySelector('#accountList .acct .acct-sub').textContent`);
    if (enSub.includes('left') && !/剩余/.test(enSub)) pass('英文模式副行「剩余」已翻（四段形态）');
    else fail(`英文模式副行没翻干净：「${enSub}」`);

    await q(cdp, `document.getElementById('langToggle').click()`); // 还原中文，避免影响后续截图
    await sleep(300);
  }
} catch (err) {
  fail(`异常中断：${err.message}`);
} finally {
  cleanup();
}

console.log(failures ? `\n存在 ${failures} 项失败` : '\n全部通过');
process.exit(failures ? 1 : 0);
