/**
 * R9 验收（Task 5–7）：体检范围可控 / 一键取消勾选不可用 / 归档时间线。
 *
 *   node tools/dev/test-r9-scope.mjs
 *
 * 全程用 fetch 打桩喂已知数据，不碰真实桥、不消耗上游额度。
 */
import { startStaticServer, openPage, waitFor, click, q, sleep } from './ui-harness.mjs';

const PORT = 8796;
const URL_ = `http://127.0.0.1:${PORT}/`;

let failures = 0;
const fail = (m) => { console.error('✗ ' + m); failures += 1; };
const pass = (m) => console.log('✓ ' + m);

const CATALOG = ['m1', 'm2', 'm3', 'm4', 'm5'].map((id) => ({
  id, name: id.toUpperCase(), context_window: 128000, max_output_tokens: 8192, credits: 0.11,
}));
const REGISTERED = ['m1', 'm2', 'm3'];

const now = Date.now();
const PROBE_RESULTS = {
  m1: { ok: true, ms: 100, at: now - 60000, credit: 0 },
  m2: { ok: false, ms: 900, at: now - 50000, error: 'HTTP 400' },
  m3: { ok: true, ms: 120, at: now - 40000, credit: 0 },
  m5: { ok: false, ms: 800, at: now - 30000, error: 'HTTP 500' },
};

const routes = {
  '/api/models': { body: { models: CATALOG } },
  '/api/overview': {
    body: {
      bridge: { running: true, ok: true, host: '127.0.0.1', port: 8790, endpoint: 'http://127.0.0.1:8790/v1', pid: 1234, startedAt: new Date(now - 3600000).toISOString(), uptimeMs: 3600000, catalogSize: 5, catalogAt: new Date(now - 120000).toISOString() },
      credentials: { accountId: '330000000000', domain: 'www.codebuddy.cn', remainingMs: 44 * 86400000, atrestOk: true },
      quota: { total: 120, packages: [] },
      dsh: { settingsExists: true, settingsHasRoute: true, patchHasRoute: true, routeLive: true, routeSource: 'cordis.patch.yml', hasBridgeKey: true, bundlesOk: true, bundles: [], registeredModels: REGISTERED },
      console: { version: '1.0.0', node: 'v22.22.2' },
    },
  },
  '/api/probe-results': { body: { updatedAt: now - 60000, results: PROBE_RESULTS, lastRun: { scope: 'checked', count: 3 } } },
  '/api/probe': { body: { ok: true, ms: 12, credit: 0 } },
  '/api/diagnose': { body: { items: [] } },
  '/api/usage': { body: { usage: { windowDays: 7, total: { calls: 0, promptTokens: 0, completionTokens: 0, credit: 0, creditCalls: 0, failed: 0 }, models: [], days: [], failures: [] } } },
  '/api/requests': { body: { requests: [] } },
  '/api/accounts': { body: { accounts: [{ path: 'a.info', active: true, accountId: '330000000000' }] } },
  '/api/checkin': { body: { status: { active: true, todayCheckedIn: true, todayCredit: 10, streak: 3 } } },
  '/api/bridge/log': { body: { lines: [] } },
};

const server = await startStaticServer(PORT);
const { cdp, close } = await openPage(URL_, routes);
const cleanup = () => { try { cdp.close(); } catch { /* 忽略 */ } try { server.close(); } catch { /* 忽略 */ } };
process.on('exit', cleanup);

const txt = (sel) => q(cdp, `(document.querySelector(${JSON.stringify(sel)})||{}).textContent || ''`);
const count = (sel) => q(cdp, `document.querySelectorAll(${JSON.stringify(sel)}).length`);
const visibleRows = () => q(cdp, `[...document.querySelectorAll('#modelTable tbody tr')].filter(tr => tr.style.display !== 'none').length`);
const probeCalls = () => q(cdp, `window.__calls.filter(p => p === '/api/probe').length`);
const resetCalls = () => q(cdp, `(window.__calls = [], true)`);

try {
  await waitFor(cdp, `!!document.querySelector('#modelTable tbody tr')`, 10000, '模型表渲染');
  await waitFor(cdp, `document.querySelectorAll('#modelTable tbody tr').length === 5`, 10000, '5 行模型');

  // ── R9.1-1 默认范围与按钮文案 ────────────────────────────────────────
  {
    const scope = await q(cdp, `document.querySelector('#probeScope').value`);
    const label = await q(cdp, `document.querySelector('#probeScope').options[document.querySelector('#probeScope').selectedIndex].textContent`);
    const btn = await txt('#probeAllBtn');
    const k = await q(cdp, `document.querySelectorAll('#modelTable input[data-id]:checked').length`);

    if (k === 3) pass('R9.1-1 已注册的 3 个模型默认处于勾选态（K=3）');
    else fail(`R9.1-1 初始勾选数应为 3，实际 ${k}`);

    if (scope === 'checked') pass('R9.1-1 有勾选时默认范围 =「勾选的」');
    else fail(`R9.1-1 默认范围应为 checked，实际 ${scope}`);

    if (btn === '测试可用性（3 个）') pass(`R9.1-1 按钮文案带数量：${btn}`);
    else fail(`R9.1-1 按钮文案应为「测试可用性（3 个）」，实际「${btn}」`);

    if (/勾选的（3）/.test(label)) pass(`R9.1-1 范围选项带数量：${label}`);
    else fail(`R9.1-1 范围选项文案异常：「${label}」`);
  }

  // ── R9.1-5 hint ─────────────────────────────────────────────────────
  {
    const hint = await q(cdp, `[...document.querySelectorAll('.panel .hint')].map(e => e.textContent).join(' ')`);
    if (/未测的不会被跳过/.test(hint) && /已知不可用/.test(hint)) {
      pass('R9.1-5 hint 写明「未测的不会被跳过，跳过只依据已知结论」');
    } else {
      fail(`R9.1-5 hint 未写明跳过规则：「${hint.slice(0, 120)}」`);
    }
  }

  // ── R9.1-1（续）无勾选 → 默认「全部」 ────────────────────────────────
  {
    await click(cdp, '#clearSelBtn');
    await sleep(120);
    const scope = await q(cdp, `document.querySelector('#probeScope').value`);
    const btn = await txt('#probeAllBtn');
    if (scope === 'all') pass('R9.1-1 K=0 时默认范围自动变为「全部」（首次使用不会只测 0 个）');
    else fail(`R9.1-1 K=0 时范围应为 all，实际 ${scope}`);
    if (btn === '测试可用性（5 个）') pass(`R9.1-1 K=0 时按钮显示全部数量：${btn}`);
    else fail(`R9.1-1 K=0 时按钮文案应为「测试可用性（5 个）」，实际「${btn}」`);
  }

  // ── R9.1-3 K=0 且选「勾选的」→ 禁用 ─────────────────────────────────
  {
    await q(cdp, `(() => { const s = document.querySelector('#probeScope'); s.value = 'checked'; s.dispatchEvent(new Event('change')); return true; })()`);
    await sleep(120);
    const disabled = await q(cdp, `document.querySelector('#probeAllBtn').disabled`);
    const title = await q(cdp, `document.querySelector('#probeAllBtn').title`);
    if (disabled && /先勾选要测的模型/.test(title)) {
      pass('R9.1-3 K=0 且选「勾选的」→ 按钮禁用 + tooltip「先勾选要测的模型」');
    } else {
      fail(`R9.1-3 应为禁用且带 tooltip，实际 disabled=${disabled} title=「${title}」`);
    }
  }

  // ── R9.2-1 一键取消勾选不可用 ───────────────────────────────────────
  {
    // 重新勾上 m1/m2/m3（其中 m2 结论为不可用）
    await q(cdp, `(() => {
      for (const id of ['m1','m2','m3']) {
        const cb = document.querySelector('#modelTable input[data-id="' + id + '"]');
        if (cb) { cb.checked = true; cb.dispatchEvent(new Event('change')); }
      }
      return true;
    })()`);
    await sleep(150);

    const hidden = await q(cdp, `document.querySelector('#uncheckBadBtn').hidden`);
    const label = await txt('#uncheckBadBtn');
    if (!hidden && /（1 个）/.test(label)) pass(`R9.2-1 存在「不可用且被勾选」时按钮出现：${label}`);
    else fail(`R9.2-1 按钮状态异常：hidden=${hidden} text=「${label}」`);

    await resetCalls();
    await click(cdp, '#uncheckBadBtn');
    await sleep(150);

    const m2 = await q(cdp, `document.querySelector('#modelTable input[data-id="m2"]').checked`);
    const k = await q(cdp, `document.querySelectorAll('#modelTable input[data-id]:checked').length`);
    const msg = await txt('#regMsg');
    const posts = await q(cdp, `window.__calls.filter(p => p === '/api/register').length`);

    if (!m2 && k === 2) pass('R9.2-1 点击后不可用模型被取消勾选（m2 去掉，剩 2 个）');
    else fail(`R9.2-1 取消勾选结果异常：m2.checked=${m2} K=${k}`);
    if (/已取消勾选 1 个不可用模型/.test(msg) && /未保存前不影响 dsh/.test(msg)) {
      pass(`R9.2-1 提示写明数量与「未保存前不影响 dsh」：${msg}`);
    } else {
      fail(`R9.2-1 提示文案异常：「${msg}」`);
    }
    if (posts === 0) pass('R9.2-1 只改本地勾选，**未写盘**（没有 /api/register 请求）');
    else fail(`R9.2-1 竟然发起了 ${posts} 次写盘请求`);
  }

  // ── R9.2-2 再次点击无副作用 ─────────────────────────────────────────
  {
    await click(cdp, '#uncheckBadBtn');
    await sleep(120);
    const hidden = await q(cdp, `document.querySelector('#uncheckBadBtn').hidden`);
    if (hidden) pass('R9.2-2 没有可取消项时按钮自动隐藏（无副作用）');
    else fail('R9.2-2 按钮仍然可见');
  }

  // ── R9.3-1 表头时间线 ───────────────────────────────────────────────
  {
    const stamp = await txt('#probeStamp');
    if (/上次体检 .+ · 本轮 3 个 · 可用 2 \/ 4/.test(stamp)) {
      pass(`R9.3-1 表头显示「上次体检 X 前 · 本轮 K 个 · 可用 M / N」：${stamp}`);
    } else {
      fail(`R9.3-1 表头文案异常：「${stamp}」`);
    }
  }

  // ── R9.3-3「仅可用」筛选行数 == M ───────────────────────────────────
  {
    await q(cdp, `(() => { const s = document.querySelector('#modelKind'); s.value = 'probe-ok'; s.dispatchEvent(new Event('change')); return true; })()`);
    await sleep(150);
    const rows = await visibleRows();
    if (rows === 2) pass(`R9.3-3「仅可用」筛选可见行数 == M（2 行）`);
    else fail(`R9.3-3「仅可用」可见行数应为 2，实际 ${rows}`);
    await q(cdp, `(() => { const s = document.querySelector('#modelKind'); s.value = ''; s.dispatchEvent(new Event('change')); return true; })()`);
    await sleep(120);
  }

  // ── R9.1-2 三个范围实际发起的探测次数 = K / R / M ───────────────────
  {
    const cases = [
      ['checked', ['m1', 'm3'], 2],
      ['registered', ['m1', 'm2', 'm3'], 3],
      ['all', ['m1', 'm2', 'm3', 'm4', 'm5'], 5],
    ];
    for (const [scope, check, expect] of cases) {
      await q(cdp, `(() => {
        document.querySelectorAll('#modelTable input[data-id]').forEach(c => { c.checked = false; });
        for (const id of ${JSON.stringify(check)}) {
          const cb = document.querySelector('#modelTable input[data-id="' + id + '"]');
          if (cb) { cb.checked = true; cb.dispatchEvent(new Event('change')); }
        }
        const s = document.querySelector('#probeScope');
        s.value = ${JSON.stringify(scope)};
        s.dispatchEvent(new Event('change'));
        return true;
      })()`);
      await sleep(150);

      await resetCalls();
      await click(cdp, '#probeAllBtn');
      // 等体检跑完（按钮重新可用）
      await waitFor(cdp, `!document.querySelector('#probeAllBtn').disabled`, 15000, `范围 ${scope} 体检结束`);
      await sleep(200);

      const n = await probeCalls();
      if (n === expect) pass(`R9.1-2 范围「${scope}」发起 ${n} 次探测（= 期望 ${expect}）`);
      else fail(`R9.1-2 范围「${scope}」发起 ${n} 次探测，期望 ${expect}`);

      const msg = await txt('#regMsg');
      if (new RegExp('/' + expect + ' 个模型可正常调用').test(msg) || new RegExp('完成 ' + expect).test(msg)) {
        pass(`R9.1-2 结束消息用真实范围数（${expect}）`);
      } else {
        fail(`R9.1-2 结束消息未反映真实范围数：「${msg}」`);
      }
    }
  }

  // ── R9.1-4 范围外模型保持原结论与时间戳 ─────────────────────────────
  {
    // 只测 m1：m2..m5 的结论与 at 必须原样保留
    await q(cdp, `(() => {
      document.querySelectorAll('#modelTable input[data-id]').forEach(c => { c.checked = false; });
      const cb = document.querySelector('#modelTable input[data-id="m1"]');
      if (cb) { cb.checked = true; cb.dispatchEvent(new Event('change')); }
      const s = document.querySelector('#probeScope'); s.value = 'checked'; s.dispatchEvent(new Event('change'));
      return true;
    })()`);
    await sleep(150);

    const before = await q(cdp, `JSON.stringify(Object.fromEntries(Object.entries(probeResults).map(([k,v]) => [k, v.at])))`);
    await click(cdp, '#probeAllBtn');
    await waitFor(cdp, `!document.querySelector('#probeAllBtn').disabled`, 15000, '单模型体检结束');
    await sleep(200);
    const after = await q(cdp, `JSON.stringify(Object.fromEntries(Object.entries(probeResults).map(([k,v]) => [k, v.at])))`);

    const b = JSON.parse(before); const a = JSON.parse(after);
    const kept = ['m2', 'm3', 'm4', 'm5'].every((id) => a[id] === b[id]);
    if (kept) pass('R9.1-4 范围外模型保持原结论与时间戳（D3 合并语义未回归）');
    else fail(`R9.1-4 范围外结论被改动：before=${before} after=${after}`);
    if (a.m1 !== b.m1) pass('R9.1-4 范围内模型结论已刷新');
    else fail('R9.1-4 范围内模型未被重新测量');
  }
} catch (err) {
  fail(`异常中断：${err.message}`);
} finally {
  cleanup();
}

console.log(failures ? `\n存在 ${failures} 项失败` : '\n全部通过');
process.exit(failures ? 1 : 0);
