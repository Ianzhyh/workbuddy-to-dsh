/**
 * R2.2 / R2.3 前端验收（Task 12–13）：目录抓取时间、手动刷新目录。
 *
 *   node tools/dev/test-r2-catalog.mjs
 */
import { startStaticServer, openPage, waitFor, click, q, sleep } from './ui-harness.mjs';

const PORT = 8793;
const URL_ = `http://127.0.0.1:${PORT}/`;

let failures = 0;
const fail = (m) => { console.error('✗ ' + m); failures += 1; };
const pass = (m) => console.log('✓ ' + m);

const now = Date.now();
const CATALOG = ['alpha', 'beta', 'gamma', 'delta'].map((id) => ({
  id, name: id.toUpperCase(), context_window: 128000, max_output_tokens: 8192, credits: 0.11,
}));
// catalogAt 固定成「本地 08:07」，方便断言「目录 HH:MM」
const catalogAt = new Date();
catalogAt.setHours(8, 7, 30, 0);
const EXPECT_CLOCK = '08:07';

const routes = {
  '/api/models': { body: { models: CATALOG } },
  '/api/overview': {
    body: {
      bridge: { running: true, ok: true, host: '127.0.0.1', port: 8790, endpoint: 'http://127.0.0.1:8790/v1', pid: 1, startedAt: new Date(now - 1000).toISOString(), uptimeMs: 1000, catalogSize: 4, catalogAt: catalogAt.toISOString() },
      credentials: { active: null, error: '' },
      quota: { total: 10, packages: [] },
      dsh: { routeLive: true, hasBridgeKey: true, bundlesOk: true, bundles: [], registeredModels: [] },
      console: { version: '1.0.0', node: 'v22' },
    },
  },
  '/api/probe-results': { body: { updatedAt: null, results: {}, lastRun: null } },
  '/api/diagnose': { body: { items: [] } },
  '/api/usage': { body: { usage: null } },
  '/api/requests': { body: { requests: [] } },
  '/api/accounts': { body: { accounts: [] } },
  '/api/checkin': { body: { status: null } },
  '/api/bridge/log': { body: { lines: [] } },
};

const server = await startStaticServer(PORT);
const { cdp, close } = await openPage(URL_, routes);
const cleanup = () => { try { cdp.close(); } catch { /* 忽略 */ } try { server.close(); } catch { /* 忽略 */ } };
process.on('exit', cleanup);

const txt = (sel) => q(cdp, `(document.querySelector(${JSON.stringify(sel)})||{}).textContent || ''`);
const modelCalls = () => q(cdp, `window.__calls.filter(p => p === '/api/models').length`);
const resetCalls = () => q(cdp, `(window.__calls = [], true)`);
const rowCount = () => q(cdp, `document.querySelectorAll('#modelTable tbody tr').length`);

try {
  await waitFor(cdp, `document.querySelectorAll('#modelTable tbody tr').length === 4`, 10000, '模型表渲染');

  // ── R2.2-2 目录抓取时间 ─────────────────────────────────────────────
  {
    const stamp = await txt('#modelStamp');
    if (new RegExp('目录 ' + EXPECT_CLOCK).test(stamp)) {
      pass(`R2.2-2 模型面板显示「目录 ${EXPECT_CLOCK}」（本地时间）：${stamp}`);
    } else {
      fail(`R2.2-2 未显示目录时间，实际「${stamp}」`);
    }
  }

  // ── R2.2-2（续）catalogAt 为空时不显示该段 ──────────────────────────
  {
    await q(cdp, `window.__setRoute('/api/overview', { body: { bridge: { running: true, ok: true, catalogAt: null }, credentials: { active: null }, quota: null, dsh: { registeredModels: [] }, console: {} } })`);
    await q(cdp, `(() => { const b = document.querySelector('#refreshBtn'); if (b) b.click(); return true; })()`);
    await sleep(400);
    const stamp = await txt('#modelStamp');
    if (!/目录 /.test(stamp)) pass('R2.2-2 catalogAt 为空时不显示「目录 HH:MM」');
    else fail(`R2.2-2 catalogAt 为空却仍显示：${stamp}`);
    // 还原
    await q(cdp, `window.__setRoute('/api/overview', { body: ${JSON.stringify(routes['/api/overview'].body)} })`);
  }

  // ── R2.3-1 刷新目录：进行中三态 + 成功提示 ──────────────────────────
  {
    await q(cdp, `window.__setRoute('/api/models', { delay: 500, body: (url) => url.includes('refresh=1') ? { models: ${JSON.stringify(CATALOG.concat([{ id: 'epsilon', name: 'EPS', context_window: 1000, max_output_tokens: 100 }]))} } : { models: ${JSON.stringify(CATALOG)} } })`);
    await resetCalls();
    await click(cdp, '#refreshCatalogBtn');
    await sleep(150); // 请求还在飞
    const disabled = await q(cdp, `document.querySelector('#refreshCatalogBtn').disabled`);
    const label = await txt('#refreshCatalogBtn');
    if (disabled && label === '正在刷新目录…') pass('R2.3-1 刷新期间按钮禁用 + 文案「正在刷新目录…」');
    else fail(`R2.3-1 进行中状态异常：disabled=${disabled} text=「${label}」`);

    await sleep(700);
    const msg = await txt('#regMsg');
    const rows = await rowCount();
    if (/目录已更新（5 个模型）/.test(msg)) pass(`R2.3-1 成功提示带数量：${msg}`);
    else fail(`R2.3-1 成功提示异常：「${msg}」`);
    if (rows === 5) pass('R2.3-1 表格已更新为 5 行');
    else fail(`R2.3-1 表格行数应为 5，实际 ${rows}`);
    const back = await q(cdp, `document.querySelector('#refreshCatalogBtn').disabled`);
    if (!back) pass('R2.3-1 结束后按钮恢复可用');
    else fail('R2.3-1 按钮未恢复');
  }

  // ── R2.3-2 连点不并发 ───────────────────────────────────────────────
  {
    await q(cdp, `window.__setRoute('/api/models', { delay: 300, body: (url) => url.includes('refresh=1') ? { models: ${JSON.stringify(CATALOG)} } : { models: ${JSON.stringify(CATALOG)} } })`);
    await resetCalls();
    await q(cdp, `(() => { const b = document.querySelector('#refreshCatalogBtn'); for (let i = 0; i < 5; i += 1) b.click(); return true; })()`);
    await sleep(800);
    const n = await modelCalls();
    if (n === 1) pass('R2.3-2 连点 5 次只发起 1 次刷新请求（按钮禁用兜底）');
    else fail(`R2.3-2 连点 5 次发起了 ${n} 次请求（应为 1）`);
  }

  // ── R2.3-3 刷新失败：保留表格 + staleMs 提示 ────────────────────────
  {
    await q(cdp, `window.__setRoute('/api/models', { body: (url) => url.includes('refresh=1') ? { models: ${JSON.stringify(CATALOG)}, staleMs: 125000 } : { models: ${JSON.stringify(CATALOG)} } })`);
    await click(cdp, '#refreshCatalogBtn');
    await sleep(400);
    const msg = await txt('#regMsg');
    const rows = await rowCount();
    if (/刷新失败/.test(msg) && /仍显示 .*的缓存/.test(msg)) {
      pass(`R2.3-3 刷新失败如实提示原因与缓存时间：${msg}`);
    } else {
      fail(`R2.3-3 失败提示异常：「${msg}」`);
    }
    if (rows === 4) pass('R2.3-3 上游失败时表格不清空（保留 4 行）');
    else fail(`R2.3-3 表格被清空，剩 ${rows} 行`);
  }

  // ── R2.3-4 不带 refresh 的行为不变 ──────────────────────────────────
  {
    await q(cdp, `window.__setRoute('/api/models', { body: { models: ${JSON.stringify(CATALOG)} } })`);
    await resetCalls();
    await q(cdp, `(() => { const b = document.querySelector('#refreshBtn'); if (b) b.click(); return true; })()`);
    await sleep(500);
    const withRefresh = await q(cdp, `window.__calls.length`);
    const rows = await rowCount();
    if (withRefresh > 0 && rows === 4) pass('R2.3-4 普通刷新走 /api/models（不带 refresh），表格正常');
    else fail(`R2.3-4 普通刷新异常：calls=${withRefresh} rows=${rows}`);
  }
} catch (err) {
  fail(`异常中断：${err.message}`);
} finally {
  cleanup();
}

console.log(failures ? `\n存在 ${failures} 项失败` : '\n全部通过');
process.exit(failures ? 1 : 0);
