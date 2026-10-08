/**
 * R8 细节 验收（Task 25–26；Task 27 = R8.4 明确不做）。
 *
 *   node tools/dev/test-r8-details.mjs
 *
 * 覆盖：保存后的生效时机提示、同步可用模型到 dsh（集合正确 / 取消不写 / 空集合禁用）。
 */
import { startStaticServer, openPage, waitFor, q, sleep } from './ui-harness.mjs';
import { accountsFixture, checkinFixture, diagnoseFixture, requestsFixture } from './fixtures.mjs';

const PORT = 8784;
const URL_ = `http://127.0.0.1:${PORT}/`;

let failures = 0;
const fail = (m) => { console.error('✗ ' + m); failures += 1; };
const pass = (m) => console.log('✓ ' + m);

const now = Date.now();
const CATALOG = ['alpha', 'beta', 'gamma', 'delta'].map((id) => ({
  id, name: id.toUpperCase(), context_window: 128000, max_output_tokens: 8192, credits: 0.11,
}));

// alpha 可用 / beta 不可用 / gamma 可用；ghost 可用但已不在目录 → 不算进 S
const PROBE = {
  alpha: { ok: true, ms: 100, at: now - 60000, credit: 0 },
  beta: { ok: false, ms: 900, at: now - 60000, error: 'HTTP 400' },
  gamma: { ok: true, ms: 120, at: now - 60000, credit: 0 },
  ghost: { ok: true, ms: 130, at: now - 60000, credit: 0 },
};

// 注意：函数体是在**页面里**执行的，闭包变量（如 now）不存在，
// 所有时间戳都要先在 Node 侧算好、放进 window.__FIX
const FIX = {
  routeSource: 'cordis.patch.yml',
  startedAt: new Date(now - 1000).toISOString(),
  catalogAt: new Date(now - 60000).toISOString(),
  expiresAt: now + 40 * 86400000,
  remainingMs: 40 * 86400000,
};

const routes = {
  '/api/models': { body: { models: CATALOG } },
  '/api/overview': {
    body: () => ({
      bridge: { running: true, ok: true, host: '127.0.0.1', port: 8790, endpoint: 'http://127.0.0.1:8790/v1', pid: 1, startedAt: window.__FIX.startedAt, uptimeMs: 1000, catalogSize: 4, catalogAt: window.__FIX.catalogAt },
      credentials: { active: { account: 'a', userId: 'a', remainingMs: window.__FIX.remainingMs, expiresAt: window.__FIX.expiresAt }, error: '' },
      quota: { total: 10, packages: [] },
      dsh: { routeLive: true, routeSource: window.__FIX.routeSource, hasBridgeKey: true, bundlesOk: true, bundles: [], registeredModels: ['alpha'] },
      console: { version: '1.0.0', node: 'v22' },
    }),
  },
  '/api/probe-results': { body: { updatedAt: now - 60000, results: PROBE, lastRun: { scope: 'checked', count: 3 } } },
  '/api/diagnose': { body: diagnoseFixture({ items: [] }) },
  '/api/usage': { body: { usage: null } },
  '/api/requests': { body: requestsFixture({ requests: [] }) },
  '/api/accounts': { body: accountsFixture({ accounts: [] }) },
  '/api/checkin': { body: checkinFixture() },
  '/api/bridge/log': { body: { lines: [] } },
  '/api/register': { body: { saved: true, count: 2, backup: true } },
};

const INJECT = `(() => { window.__FIX = ${JSON.stringify(FIX)}; })();`;

const server = await startStaticServer(PORT);
const { cdp, close, lastDialog, setDialogHandler } = await openPage(URL_, routes, { inject: INJECT });
const cleanup = () => { try { cdp.close(); } catch { /* 忽略 */ } try { server.close(); } catch { /* 忽略 */ } };
process.on('exit', cleanup);

const txt = (sel) => q(cdp, `(document.querySelector(${JSON.stringify(sel)})||{}).textContent || ''`);
const regPosts = () => q(cdp, `window.__posts.filter(p => p.path === '/api/register').map(p => p.body)`);
const resetPosts = () => q(cdp, `(window.__posts = [], true)`);
const click = (sel) => q(cdp, `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.click(); return true; })()`);

try {
  await waitFor(cdp, `document.querySelectorAll('#modelTable tbody tr').length === 4`, 10000, '模型表渲染');
  await sleep(300);

  // ── R8.3-1 集合与按钮状态 ───────────────────────────────────────────
  {
    const label = await txt('#syncUsableBtn');
    const disabled = await q(cdp, `document.querySelector('#syncUsableBtn').disabled`);
    if (!disabled && label === '同步可用模型到 dsh（2 个）') {
      pass(`R8.3-1 S = 体检可用 ∩ 目录 = 2 个（alpha/gamma；ghost 不在目录被排除）：${label}`);
    } else {
      fail(`R8.3-1 按钮状态异常：disabled=${disabled} text=「${label}」`);
    }
  }

  // ── R8.3-2 取消 → 什么都不写 ────────────────────────────────────────
  {
    setDialogHandler(() => false);
    await resetPosts();
    await click('#syncUsableBtn');
    await sleep(400);
    const msg = lastDialog();
    const posts = await regPosts();
    if (/将把 2 个「体检可用」的模型写入 dsh/.test(msg) && /替换当前勾选/.test(msg) && /自动备份/.test(msg)) {
      pass('R8.3-2 确认框写清「替换勾选 + 自动备份」');
    } else {
      fail(`R8.3-2 确认文案异常：「${msg}」`);
    }
    if (posts.length === 0) pass('R8.3-2 取消 → 什么都没写（零 /api/register 请求）');
    else fail(`R8.3-2 取消后仍写盘 ${posts.length} 次`);
  }

  // ── R8.3-1 接受 → 写入的正好是 S ────────────────────────────────────
  {
    setDialogHandler(() => true);
    await resetPosts();
    await click('#syncUsableBtn');
    await sleep(600);
    const posts = await regPosts();
    const ids = posts.length ? posts[0].models.map((m) => m.id).sort() : [];
    if (JSON.stringify(ids) === JSON.stringify(['alpha', 'gamma'])) {
      pass(`R8.3-1 写入的正是 S（${ids.join('、')}），ghost 被排除`);
    } else {
      fail(`R8.3-1 写入集合不对：${JSON.stringify(ids)}`);
    }
  }

  // ── R8.1-1 生效时机提示（cordis.patch.yml → 立即生效）───────────────
  {
    const msg = await txt('#regMsg');
    if (/已写入 2 个模型/.test(msg) && /已写入 cordis\.patch\.yml，立即生效/.test(msg)) {
      pass(`R8.1-1 routeSource=cordis.patch.yml → 提示「立即生效」：${msg}`);
    } else {
      fail(`R8.1-1 生效时机提示异常：「${msg}」`);
    }
  }

  // ── R8.1-1 另一条路径：下次启动导入 ─────────────────────────────────
  {
    await q(cdp, `(window.__FIX.routeSource = 'settings.yaml', true)`);
    await q(cdp, `(async () => { await loadOverview(); return true; })()`);
    await sleep(400);
    await resetPosts();
    setDialogHandler(() => true);
    await click('#saveRegBtn');
    await sleep(600);
    const msg = await txt('#regMsg');
    if (/DSH Desktop 0\.2\.0 会在下次启动时把 settings\.yaml 导入 patch 层/.test(msg)) {
      pass(`R8.1-1 非 patch 路径提示「下次启动导入」：${msg.slice(0, 70)}…`);
    } else {
      fail(`R8.1-1 提示异常：「${msg}」`);
    }
  }

  // ── R8.3-1 S 为空 → 禁用 + tooltip ──────────────────────────────────
  {
    await q(cdp, `(probeResults = {}, probeLastRun = null, refreshProbeStamp(), true)`);
    await sleep(250);
    const disabled = await q(cdp, `document.querySelector('#syncUsableBtn').disabled`);
    const title = await q(cdp, `document.querySelector('#syncUsableBtn').title`);
    if (disabled && /先做一次体检/.test(title)) pass('R8.3-1 S 为空 → 按钮禁用 + tooltip「先做一次体检」');
    else fail(`R8.3-1 空集合状态异常：disabled=${disabled} title=「${title}」`);

    await resetPosts();
    await click('#syncUsableBtn');
    await sleep(300);
    const posts = await regPosts();
    if (posts.length === 0) pass('R8.3-1 S 为空时点击不会写盘');
    else fail('R8.3-1 空集合却发起了写入');
  }
} catch (err) {
  fail(`异常中断：${err.message}`);
} finally {
  cleanup();
}

console.log(failures ? `\n存在 ${failures} 项失败` : '\n全部通过');
process.exit(failures ? 1 : 0);
