/**
 * R7 防误操作与阅读体验 验收（Task 23–24）。
 *
 *   node tools/dev/test-r7-safety.mjs
 *
 * 覆盖：三个危险动作的二次确认（文案含影响 + 最近 60 秒请求事实）、
 * 体检中追加提示、取消不产生请求、暂停自动刷新、滚动位置保持。
 */
import { startStaticServer, openPage, waitFor, q, sleep } from './ui-harness.mjs';
import { accountsFixture, bridgeFixture, checkinFixture, consoleFixture, credentialsFixture, diagnoseFixture, dshFixture, quotaFixture } from './fixtures.mjs';

const PORT = 8785;
const URL_ = `http://127.0.0.1:${PORT}/`;

let failures = 0;
const fail = (m) => { console.error('✗ ' + m); failures += 1; };
const pass = (m) => console.log('✓ ' + m);

const now = Date.now();
const CATALOG = ['alpha', 'beta'].map((id) => ({
  id, name: id.toUpperCase(), context_window: 128000, max_output_tokens: 8192, credits: 0.11,
}));

const FIX = {
  // 默认：最近 60 秒内没有请求
  requests: [
    { t: now - 300000, model: 'alpha', stream: false, ok: true, ms: 100, promptTokens: 1, completionTokens: 1, credit: 0 },
  ],
};

const routes = {
  '/api/models': { body: { models: CATALOG } },
  '/api/overview': {
    body: {
      bridge: { ...bridgeFixture(), running: true, ok: true, host: '127.0.0.1', port: 8790, endpoint: 'http://127.0.0.1:8790/v1', pid: 555, startedAt: new Date(now - 1000).toISOString(), uptimeMs: 1000, catalogSize: 2, catalogAt: new Date(now - 60000).toISOString() },
      credentials: { ...credentialsFixture(), active: { account: '330000000000', userId: 'a', remainingMs: 40 * 86400000, expiresAt: now + 40 * 86400000 }, error: '' },
      quota: { ...quotaFixture(), total: 10, packages: [] },
      dsh: { ...dshFixture(), routeLive: true, hasBridgeKey: true, bundlesOk: true, bundles: [], registeredModels: ['alpha'] },
      console: { ...consoleFixture(), version: '1.0.0', node: 'v22' },
    },
  },
  '/api/probe-results': { body: { updatedAt: null, results: {}, lastRun: null } },
  '/api/diagnose': { body: diagnoseFixture({ items: [] }) },
  '/api/usage': { body: { usage: null } },
  '/api/requests': { body: () => ({ requests: window.__FIX.requests }) },
  '/api/accounts': {
    body: accountsFixture({
      accounts: [{
        name: 'other.info', path: 'other.info', account: '999',
        active: false, usable: true, remainingMs: 40 * 86400000, domain: 'www.codebuddy.cn',
      }],
    }),
  },
  '/api/checkin': { body: checkinFixture() },
  '/api/bridge/log': { body: { lines: [] } },
  // 危险动作的响应（只有「接受确认」时才会被调用到）
  '/api/bridge/stop': { body: { stopped: true, pid: 555 } },
  '/api/bridge/restart': { body: { started: true, pid: 556 } },
  '/api/account/switch': { body: { switched: true, account: { account: '999' } } },
  // 体检：挂住不返回，用来制造「体检进行中」
  '/api/probe': { hang: true },
};

const INJECT = `(() => { window.__FIX = ${JSON.stringify(FIX)}; })();`;

const server = await startStaticServer(PORT);
const { cdp, close, lastDialog, setDialogHandler } = await openPage(URL_, routes, { inject: INJECT });
const cleanup = () => { try { cdp.close(); } catch { /* 忽略 */ } try { server.close(); } catch { /* 忽略 */ } };
process.on('exit', cleanup);

const calls = () => q(cdp, `window.__calls.slice()`);
const resetCalls = () => q(cdp, `(window.__calls = [], true)`);
const click = (sel) => q(cdp, `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.click(); return true; })()`);

try {
  await waitFor(cdp, `document.querySelectorAll('#modelTable tbody tr').length === 2`, 10000, '模型表渲染');
  await sleep(300);

  // ── R7.1-1 / R7.1-3 停止桥：取消 → 零请求 ───────────────────────────
  {
    setDialogHandler(() => false); // 取消
    await resetCalls();
    await click('#stopBtn');
    await sleep(400);
    const msg = lastDialog();
    const list = await calls();
    if (/确定停止桥服务/.test(msg)) pass('R7.1-1 停止桥弹出确认框');
    else fail(`R7.1-1 确认文案异常：「${msg}」`);
    if (/最近 60 秒没有请求/.test(msg)) pass('R7.1-1 文案含「最近 60 秒没有请求」（无请求时如实写）');
    else fail(`R7.1-1 缺少最近请求事实：「${msg}」`);
    if (/无法调用模型|需要重新点/.test(msg)) pass('R7.1-1 文案写清影响与恢复方式');
    else fail(`R7.1-1 未写清影响：「${msg}」`);
    if (!list.includes('/api/bridge/stop')) pass('R7.1-3 取消确认 → **未**发出停止请求');
    else fail('R7.1-3 取消后仍发出了停止请求');
  }

  // ── R7.1-1 有请求时文案写清条数 ─────────────────────────────────────
  {
    await q(cdp, `(window.__FIX.requests = [
      { t: Date.now() - 5000, model: 'alpha', stream: false, ok: true, ms: 1, promptTokens: 1, completionTokens: 1, credit: 0 },
      { t: Date.now() - 8000, model: 'beta', stream: false, ok: true, ms: 1, promptTokens: 1, completionTokens: 1, credit: 0 },
      { t: Date.now() - 90000, model: 'alpha', stream: false, ok: true, ms: 1, promptTokens: 1, completionTokens: 1, credit: 0 }
    ], true)`);
    setDialogHandler(() => false);
    await click('#stopBtn');
    await sleep(400);
    const msg = lastDialog();
    if (/最近 60 秒内有 2 条请求，会打断正在进行的调用/.test(msg)) {
      pass('R7.1-1 有请求时写明条数（当场取明细，2 条在窗口内、1 条不在）');
    } else {
      fail(`R7.1-1 条数文案异常：「${msg}」`);
    }
  }

  // ── R7.1-1 重启桥确认 ───────────────────────────────────────────────
  {
    setDialogHandler(() => false);
    await resetCalls();
    await click('#restartBtn');
    await sleep(400);
    const msg = lastDialog();
    const list = await calls();
    if (/确定重启桥服务/.test(msg) && /中断正在进行的调用/.test(msg)) pass('R7.1-1 重启桥确认写清「会中断调用」');
    else fail(`R7.1-1 重启确认文案异常：「${msg}」`);
    if (!list.includes('/api/bridge/restart')) pass('R7.1-3 取消重启 → 未发出请求');
    else fail('R7.1-3 取消后仍发出了重启请求');
  }

  // ── R7.1-1 切换账号确认（含清空体检结论）────────────────────────────
  {
    setDialogHandler(() => false);
    await resetCalls();
    await click('#accountList button');
    await sleep(400);
    const msg = lastDialog();
    const list = await calls();
    if (/确定切换到账号/.test(msg)) pass('R7.1-1 切换账号弹出确认框');
    else fail(`R7.1-1 切换账号确认文案异常：「${msg}」`);
    if (/清空上一个账号的体检结论/.test(msg)) pass('R7.1-1 切账号额外说明「会清空体检结论」');
    else fail(`R7.1-1 缺少体检结论说明：「${msg}」`);
    if (!list.includes('/api/account/switch')) pass('R7.1-3 取消切账号 → 未发出请求');
    else fail('R7.1-3 取消后仍发出了切账号请求');
  }

  // ── R7.1-2 体检进行中追加提示 ───────────────────────────────────────
  {
    // 让体检卡住：/api/probe 是 hang 的，probeAll 会一直飞
    await click('#probeAllBtn');
    await sleep(400);
    const running = await q(cdp, `!!probeCtrl`);
    if (!running) { fail('R7.1-2 未能制造「体检进行中」状态'); } else {
      setDialogHandler(() => false);
      await click('#stopBtn');
      await sleep(400);
      const msg = lastDialog();
      if (/体检进行中，停止桥会中断本轮体检/.test(msg)) pass('R7.1-2 体检进行中时追加「会中断本轮体检」');
      else fail(`R7.1-2 缺少体检提示：「${msg}」`);
      // 收尾：取消体检
      await q(cdp, `(() => { const b = document.querySelector('#probeCancelBtn'); if (b) b.click(); return true; })()`);
      await sleep(500);
    }
  }

  // ── R7.1-3 接受确认 → 请求正常发出 ──────────────────────────────────
  {
    setDialogHandler(() => true);
    await resetCalls();
    await click('#stopBtn');
    await sleep(600);
    const list = await calls();
    if (list.includes('/api/bridge/stop')) pass('R7.1-3 接受确认 → 停止请求正常发出');
    else fail(`R7.1-3 接受后未发出请求：${JSON.stringify(list)}`);
  }

  // ── R7.2-1 暂停自动刷新 ─────────────────────────────────────────────
  {
    // 直接调页面自己的轮询函数体，避免等 20 秒
    const pollBody = `(function(){
      loadOverview(); loadModels(); loadUsage();
      if (!document.querySelector('#reqPause') || !document.querySelector('#reqPause').checked) loadRequests();
      return true;
    })()`;

    await q(cdp, `(document.querySelector('#reqPause').checked = false, document.querySelector('#reqPause').dispatchEvent(new Event('change')), true)`);
    await resetCalls();
    await q(cdp, pollBody);
    await sleep(300);
    let list = await calls();
    if (list.includes('/api/requests')) pass('R7.2-1 未暂停时轮询会请求 /api/requests');
    else fail('R7.2-1 未暂停时轮询没有请求明细');

    await q(cdp, `(document.querySelector('#reqPause').checked = true, document.querySelector('#reqPause').dispatchEvent(new Event('change')), true)`);
    await sleep(150);
    const note = await q(cdp, `document.querySelector('#reqPauseNote').textContent`);
    if (note === '已暂停自动刷新') pass('R7.2-1 暂停后开关旁显示「已暂停自动刷新」');
    else fail(`R7.2-1 缺少暂停标记：「${note}」`);

    await resetCalls();
    await q(cdp, pollBody);
    await sleep(300);
    list = await calls();
    if (!list.includes('/api/requests')) pass('R7.2-1 暂停后轮询**跳过** /api/requests');
    else fail('R7.2-1 暂停后仍请求了明细');

    // 手动刷新仍可用
    await resetCalls();
    await click('#reqRefreshBtn');
    await sleep(300);
    list = await calls();
    if (list.includes('/api/requests')) pass('R7.2-1 暂停期间手动「刷新」仍然可用');
    else fail('R7.2-1 暂停期间手动刷新失效');
    await q(cdp, `(document.querySelector('#reqPause').checked = false, document.querySelector('#reqPause').dispatchEvent(new Event('change')), true)`);
  }

  // ── R7.2-2 重绘保持滚动位置 ─────────────────────────────────────────
  {
    // 造 200 条明细，让面板可滚动
    await q(cdp, `(window.__FIX.requests = Array.from({ length: 200 }, (_, i) => ({
      t: Date.now() - i * 1000, model: i % 2 ? 'alpha' : 'beta', stream: false, ok: true, ms: 10,
      promptTokens: 1, completionTokens: 1, credit: 0
    })), true)`);
    await q(cdp, `(document.querySelector('#reqLimit').value = '200', true)`);
    await click('#reqRefreshBtn');
    await waitFor(cdp, `!!document.querySelector('#reqTableWrap') && document.querySelector('#reqTableWrap').scrollHeight > 400`, 8000, '明细可滚动');
    await sleep(200);

    await q(cdp, `(document.querySelector('#reqTableWrap').scrollTop = 420, true)`);
    const before = await q(cdp, `document.querySelector('#reqTableWrap').scrollTop`);
    await q(cdp, `(renderRequests(), true)`);
    await sleep(200);
    const after = await q(cdp, `document.querySelector('#reqTableWrap').scrollTop`);
    if (before > 0 && Math.abs(after - before) <= 2) pass(`R7.2-2 重绘前后 scrollTop 保持（${before} → ${after}）`);
    else fail(`R7.2-2 滚动位置丢失：${before} → ${after}`);
  }
} catch (err) {
  fail(`异常中断：${err.message}`);
} finally {
  cleanup();
}

console.log(failures ? `\n存在 ${failures} 项失败` : '\n全部通过');
process.exit(failures ? 1 : 0);
