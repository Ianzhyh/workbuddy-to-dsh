/**
 * R5 可观测与留证 验收（Task 18–20）。
 *
 *   node tools/dev/test-r5-observability.mjs
 *
 * 覆盖：诊断报告内容与「不含令牌值」、请求明细 CSV 的范围一致性、
 * 模型 CSV 增列、日志关键字过滤。
 */
import { startStaticServer, openPage, waitFor, q, sleep } from './ui-harness.mjs';
import { accountsFixture, bridgeFixture, checkinFixture, consoleFixture, credentialsFixture, diagnoseFixture, dshFixture, quotaFixture, requestsFixture } from './fixtures.mjs';

const PORT = 8787;
const URL_ = `http://127.0.0.1:${PORT}/`;

let failures = 0;
const fail = (m) => { console.error('✗ ' + m); failures += 1; };
const pass = (m) => console.log('✓ ' + m);

const now = Date.now();
const CATALOG = [
  { id: 'alpha', name: 'ALPHA', context_window: 128000, max_output_tokens: 8192, credits: 0.11, supports_images: true },
  { id: 'beta', name: 'BETA', context_window: 64000, max_output_tokens: 4096, credits: 0.51 },
  { id: 'gamma', name: 'GAMMA', context_window: 32000, max_output_tokens: 2048, credits: 0.79 },
];

const USAGE = {
  ok: true,
  windowDays: 7,
  total: { calls: 3, promptTokens: 2000, completionTokens: 0, ms: 300, credit: 0.24, creditCalls: 3, failed: 0 },
  models: [{ model: 'alpha', calls: 3, promptTokens: 2000, completionTokens: 0, ms: 300, credit: 0.24, creditCalls: 3 }],
  days: [{ day: '2026-10-04', calls: 3, promptTokens: 2000, completionTokens: 0, credit: 0.24, creditCalls: 3 }],
  failures: [],
};

const REQUESTS = [
  { t: now - 1000, model: 'alpha', stream: true, ok: true, ms: 900, promptTokens: 10, completionTokens: 5, credit: 0.01 },
  { t: now - 2000, model: 'beta', stream: false, ok: false, ms: 1500, status: 400, code: 'invalid_request', error: '{"error":{"message":"bad model"}}' },
  { t: now - 3000, model: 'beta', stream: false, ok: true, ms: 800, promptTokens: 20, completionTokens: 8, credit: 0.02 },
  { t: now - 4000, model: 'gamma', stream: false, ok: false, ms: 2000, status: 500, code: 'upstream_error', error: 'boom' },
  { t: now - 5000, model: 'alpha', stream: false, ok: true, ms: 700, promptTokens: 30, completionTokens: 9, credit: 0.03 },
];

const LOG_LINES = [
  '2026-10-04 09:00:00 bridge listening on 127.0.0.1:8790',
  '2026-10-04 09:00:01 catalog fetched 30 models',
  '2026-10-04 09:00:02 ERROR upstream 502 from copilot.tencent.com',
  '2026-10-04 09:00:03 request interrupted by user',
  '2026-10-04 09:00:04 token refresh failed (network)',
  '2026-10-04 09:00:05 Error: mixed case message',
  '2026-10-04 09:00:06 normal heartbeat line',
];

// 故意在 overview 里塞一个「令牌值」字段：报告**绝不能**把它带出去
const SECRET = 'eyJhbGciOiJIUzI1NiJ9.SUPER_SECRET_TOKEN_VALUE';

const routes = {
  '/api/models': { body: { models: CATALOG } },
  // 本用例**故意**在 credentials 里塞了一个假令牌（见 SECRET），用来断言
  // 「凭据绝不进诊断报告」。真实接口不会返回这个键，所以放行「多余键」检查。
  '/api/overview': {
    allowExtra: true,
    body: {
      bridge: { ...bridgeFixture(),
        running: true, ok: true, host: '127.0.0.1', port: 8790, endpoint: 'http://127.0.0.1:8790/v1',
        pid: 987654, startedAt: new Date(now - 5400000).toISOString(), uptimeMs: 5400000,
        catalogSize: 3, catalogAt: new Date(now - 120000).toISOString(),
        upstreamShape: { ...bridgeFixture().upstreamShape, paths: ['/v2/enterprises/personal/models', '/v3/config'], droppedNonChat: ['nes-gf', 'hunyuan-image'] },
      },
      credentials: { ...credentialsFixture(),
        active: { account: '330000000000', userId: '330000000000abcdef', domain: 'www.codebuddy.cn', remainingMs: 44 * 86400000, expiresAt: now + 44 * 86400000, accessToken: SECRET },
        error: '',
      },
      quota: { ...quotaFixture(), total: 10, packages: [] },
      dsh: { ...dshFixture(), routeLive: true, hasBridgeKey: true, bundlesOk: true, bundles: [], registeredModels: ['alpha', 'gone-model'] },
      console: { ...consoleFixture(), version: '1.0.0', node: 'v22.22.2' },
    },
  },
  '/api/probe-results': {
    body: {
      updatedAt: now - 60000,
      results: { alpha: { ok: true, ms: 1180, at: now - 60000, credit: 0 }, beta: { ok: false, ms: 2400, at: now - 60000, error: 'HTTP 400' } },
      lastRun: { scope: 'checked', count: 2 },
    },
  },
  // 信封（summary / bridge / credentials / dsh）由共享夹具提供；
  // 这里只覆盖 items —— 保留本用例自己的诊断条目。
  '/api/diagnose': {
    body: {
      ...diagnoseFixture(),
      items: [
        { id: 'exe', label: 'WorkBuddy 客户端', status: 'ok', detail: 'E:\\App\\WorkBuddy\\WorkBuddy.exe', hint: '' },
        { id: 'atrest', label: 'AtRest 密钥', status: 'ok', detail: 'keyId=9127dea1b44020a7（与信封一致）', hint: '' },
        { id: 'token', label: '凭据解密', status: 'ok', detail: '账号 330000000000 · 剩余 44 天 15 小时', hint: '' },
        { id: 'bridge', label: '桥服务', status: 'ok', detail: '127.0.0.1:8790 已响应', hint: '' },
        { id: 'settings', label: 'dsh 模型路由', status: 'warn', detail: 'settings.yaml 存在，但缺少 workbuddy 路由', hint: '在「可用模型」里勾选后保存' },
      ],
    },
  },
  '/api/usage': { body: { usage: USAGE } },
  '/api/requests': { body: requestsFixture({ requests: REQUESTS }) },
  '/api/accounts': { body: accountsFixture({ accounts: [] }) },
  '/api/checkin': { body: checkinFixture() },
  '/api/bridge/log': { body: { lines: LOG_LINES } },
};

const INJECT = `(() => {
  window.__clip = null;
  window.__csv = null;
  try {
    if (!navigator.clipboard) Object.defineProperty(navigator, 'clipboard', { value: {}, configurable: true });
    navigator.clipboard.writeText = (t) => { window.__clip = t; return Promise.resolve(); };
  } catch (e) { /* 忽略 */ }
})();`;

const server = await startStaticServer(PORT);
const { cdp, close } = await openPage(URL_, routes, { inject: INJECT });
const cleanup = () => { try { cdp.close(); } catch { /* 忽略 */ } try { server.close(); } catch { /* 忽略 */ } };
process.on('exit', cleanup);

const txt = (sel) => q(cdp, `(document.querySelector(${JSON.stringify(sel)})||{}).textContent || ''`);
const logShown = () => q(cdp, `document.querySelectorAll('#logOut').length ? document.querySelector('#logOut').textContent.split('\\n').filter(Boolean).length : 0`);

try {
  await waitFor(cdp, `document.querySelectorAll('#modelTable tbody tr').length === 3`, 10000, '模型表渲染');
  // 拦下 CSV 下载：必须在页面脚本**执行完之后**覆盖 —— downloadCsv 是函数声明，
  // 注入阶段的覆盖会被页面脚本自己的声明冲掉
  await q(cdp, `(window.downloadCsv = (filename, rows) => { window.__csv = { filename: filename, rows: rows }; }, true)`);
  await sleep(400);

  // ── R5.1-1 / R5.1-2 诊断报告 ────────────────────────────────────────
  {
    await q(cdp, `(window.__clip = null, true)`);
    await q(cdp, `(document.querySelector('#copyDiagBtn').click(), true)`);
    await sleep(400);
    const rep = await q(cdp, `window.__clip || ''`);

    const checks = [
      [/控制台 v1\.0\.0 · Node v22\.22\.2/, '控制台版本与 Node 版本'],
      [/PID 987654/, '桥 PID'],
      [/目录 3 个 @ \d{2}:\d{2}/, '目录数量与抓取时间'],
      [/账号：330000000000/, '账号'],
      [/域名：www\.codebuddy\.cn/, '域名'],
      [/令牌剩余：44 天/, '令牌剩余'],
      [/keyId=9127dea1b44020a7（与信封一致）/, 'AtRest keyId 结论'],
      [/\[✓\] WorkBuddy 客户端/, '诊断逐项（含状态符号）'],
      [/建议：在「可用模型」里勾选后保存/, '诊断建议'],
      [/被排除的非对话模型：nes-gf、hunyuan-image/, '目录摘要里的被排除 id'],
      [/已注册：2 个（其中 1 个已不在目录：gone-model）/, '已注册与失效注册数'],
      [/## 最近 5 条失败/, '最近 5 条失败小节'],
      [/HTTP 400 · invalid_request/, '失败明细含状态码与错误码'],
      [/bad model/, '失败明细含错误原文'],
    ];
    let bad = 0;
    for (const [re, label] of checks) {
      if (!re.test(rep)) { fail(`R5.1-1 报告缺少「${label}」`); bad += 1; }
    }
    if (!bad) pass(`R5.1-1 报告包含全部关键行（${checks.length} 项）`);

    if (!rep.includes(SECRET) && !/accessToken/i.test(rep)) {
      pass('R5.1-2 报告**不含**任何令牌值（即使后端多给了字段也不带出去）');
    } else {
      fail('R5.1-2 报告里出现了令牌值！');
    }
    const msg = await txt('#actionMsg');
    if (/诊断报告已复制/.test(msg)) pass(`R5.1-2 复制成功有如实提示：${msg}`);
    else fail(`R5.1-2 复制提示异常：「${msg}」`);
  }

  // ── R5.2-1 请求明细 CSV ─────────────────────────────────────────────
  {
    // 先不加筛选：应导出全部 5 条
    await q(cdp, `(window.__csv = null, true)`);
    await q(cdp, `(document.querySelector('#exportReqBtn').click(), true)`);
    await sleep(300);
    let csv = await q(cdp, `window.__csv`);
    if (csv && csv.rows.length === 6) pass(`R5.2-1 无筛选时导出全部 5 条（含表头共 ${csv.rows.length} 行）`);
    else fail(`R5.2-1 导出行数异常：${csv ? csv.rows.length : 'null'}`);
    const header = csv ? csv.rows[0].join(',') : '';
    if (/状态码/.test(header) && /错误码/.test(header) && /错误原文/.test(header)) {
      pass(`R5.2-1 CSV 含状态码 / 错误码 / 错误原文列`);
    } else {
      fail(`R5.2-1 CSV 表头缺列：${header}`);
    }
    /*
     * R5.2-4 导出文件名必须是**本地日期**。
     *
     * 原先页面里有两个「今天」：`localDateStr()`（本地，注释写明与桥的 localDay
     * 同规则）与 `today()`（`toISOString().slice(0,10)`，那是 **UTC**）。
     * 文件名用的是后者 —— 在 UTC+8 的 00:00–08:00 导出，文件名会比墙上时钟早一天。
     * 现在只留 `localDateStr()`，这条断言钉住文件名走的是它。
     */
    const expectDay = await q(cdp, `(() => {
      const d = new Date();
      const p = (n) => String(n).padStart(2, '0');
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
    })()`);
    if (csv && String(csv.filename).includes(expectDay)) {
      pass(`R5.2-4 导出文件名用本地日期（${expectDay}）`);
    } else {
      fail(`R5.2-4 导出文件名没带本地日期：${csv ? csv.filename : 'null'}（期望含 ${expectDay}）`);
    }
    /*
     * 上面那条**在 UTC 与本地同一天时区分不出两种实现**（一天里有 2/3 的时间是
     * 这种情形），所以再钉一条实现层面的：页面里不该存在那个 UTC 版的「今天」。
     *
     * `today()` 是 `new Date().toISOString().slice(0, 10)` —— 只要它回来，
     * 文件名就会在 UTC+8 的凌晨写成「昨天」，而上面那条断言那时才变红。
     * 与其等凌晨，不如直接断言它不存在。
     */
    const utcToday = await q(cdp, `typeof today`);
    if (utcToday === 'undefined') {
      pass('R5.2-4 页面里只有 localDateStr 一个「今天」（UTC 版 today() 已移除）');
    } else {
      fail(`R5.2-4 又出现了第二个「今天」：typeof today = ${utcToday}`);
    }

    // 加筛选（模型 beta + 仅失败）→ 只应导出 1 条
    await q(cdp, `(() => { const s = document.querySelector('#reqModelFilter'); s.value = 'beta'; s.dispatchEvent(new Event('change')); const c = document.querySelector('#reqFailOnly'); c.checked = true; c.dispatchEvent(new Event('change')); return true; })()`);
    await sleep(200);
    const visible = await q(cdp, `document.querySelectorAll('#reqBox tbody tr').length`);
    await q(cdp, `(window.__csv = null, true)`);
    await q(cdp, `(document.querySelector('#exportReqBtn').click(), true)`);
    await sleep(300);
    csv = await q(cdp, `window.__csv`);
    if (csv && csv.rows.length - 1 === visible) pass(`R5.2-1 导出条数 == 当前筛选可见条数（${visible}）`);
    else fail(`R5.2-1 导出条数(${csv ? csv.rows.length - 1 : 'null'}) != 可见条数(${visible})`);
    const msg = await txt('#regMsg');
    if (/模型 beta · 仅失败/.test(msg)) pass(`R5.2-1 提示写清导出范围：${msg}`);
    else fail(`R5.2-1 范围提示异常：「${msg}」`);

    // 复原
    await q(cdp, `(() => { const s = document.querySelector('#reqModelFilter'); s.value = ''; s.dispatchEvent(new Event('change')); const c = document.querySelector('#reqFailOnly'); c.checked = false; c.dispatchEvent(new Event('change')); return true; })()`);
    await sleep(200);
  }

  // ── R5.3-1 模型 CSV 增列 ────────────────────────────────────────────
  {
    await q(cdp, `(window.__csv = null, true)`);
    await q(cdp, `(document.querySelector('#exportModelsBtn').click(), true)`);
    await sleep(300);
    const csv = await q(cdp, `window.__csv`);
    const header = csv ? csv.rows[0].join(',') : '';
    if (/体检结论/.test(header) && /体检耗时/.test(header) && /支持图片/.test(header) && /实测成本/.test(header) && /成本样本/.test(header)) {
      pass('R5.3-1 模型 CSV 新增：体检结论 / 耗时 / 支持图片 / 实测成本（含样本数）');
    } else {
      fail(`R5.3-1 模型 CSV 表头缺列：${header}`);
    }
    const alpha = csv && csv.rows.find((r) => r[0] === 'alpha');
    const beta = csv && csv.rows.find((r) => r[0] === 'beta');
    const gamma = csv && csv.rows.find((r) => r[0] === 'gamma');
    if (alpha && alpha[7] === '可用' && Number(alpha[8]) === 1180 && alpha[9] === '是') {
      pass(`R5.3-1 alpha 行口径正确（可用 / 1180ms / 支持图片）：${alpha.slice(7, 10).join(' | ')}`);
    } else {
      fail(`R5.3-1 alpha 行异常：${alpha ? alpha.slice(7, 10).join(' | ') : 'n/a'}`);
    }
    if (beta && beta[7] === '不可用') pass('R5.3-1 beta 行体检结论为「不可用」');
    else fail(`R5.3-1 beta 行结论异常：${beta ? beta[7] : 'n/a'}`);
    if (gamma && gamma[7] === '未测') pass('R5.3-1 gamma 行体检结论为「未测」');
    else fail(`R5.3-1 gamma 行结论异常：${gamma ? gamma[7] : 'n/a'}`);
    if (alpha && Number(alpha[10]) === 0.12 && Number(alpha[11]) === 3) {
      pass(`R5.3-1 实测成本与页面同源（0.12 / 3 次）：${alpha[10]} / ${alpha[11]}`);
    } else {
      fail(`R5.3-1 实测成本列异常：${alpha ? alpha[10] + ' / ' + alpha[11] : 'n/a'}`);
    }
  }

  // ── R5.4 日志过滤 ───────────────────────────────────────────────────
  {
    /*
     * 按 **id** 打开日志抽屉，不要用 `document.querySelector('details')`。
     *
     * 后者取的是全文档第一个 `<details>`，而页面上现在不止一个（「客户端接入」里
     * 新增了折叠区）—— 取错了对象，抽屉一直是关的，日志永远不加载，
     * 表现为一个 8 秒超时。这个选择器从一开始就脆，只是以前恰好只有一个 details。
     */
    await q(cdp, `(document.getElementById('logDrawer').open = true, true)`);
    await waitFor(cdp, `document.querySelector('#logOut').textContent.includes('heartbeat')`, 8000, '日志加载');
    await sleep(200);

    const info0 = await txt('#logInfo');
    if (info0 === '显示 7 / 总 7 行') pass(`R5.4-1 无过滤时显示「显示 7 / 总 7 行」`);
    else fail(`R5.4-1 计数异常：「${info0}」`);

    // 大小写不敏感
    await q(cdp, `(() => { const el = document.querySelector('#logFilter'); el.value = 'error'; el.dispatchEvent(new Event('input')); return true; })()`);
    await sleep(200);
    const lines = await q(cdp, `document.querySelector('#logOut').textContent.split('\\n')`);
    const info1 = await txt('#logInfo');
    if (lines.length === 2 && lines.every((l) => /error/i.test(l))) {
      pass('R5.4-1 过滤大小写不敏感（小写 error 同时命中 ERROR 与 Error）');
    } else {
      fail(`R5.4-1 过滤结果异常（${lines.length} 行）：${JSON.stringify(lines)}`);
    }
    if (info1 === '显示 2 / 总 7 行') pass(`R5.4-1 过滤后仍显示「显示 N / 总 M 行」：${info1}`);
    else fail(`R5.4-1 过滤后计数异常：「${info1}」`);

    // 「只看错误」快捷
    await q(cdp, `(() => { const el = document.querySelector('#logFilter'); el.value = ''; el.dispatchEvent(new Event('input')); const c = document.querySelector('#logErrorsOnly'); c.checked = true; c.dispatchEvent(new Event('change')); return true; })()`);
    await sleep(200);
    const errLines = await q(cdp, `document.querySelector('#logOut').textContent.split('\\n')`);
    const hitAll = ['ERROR upstream', 'interrupted by user', 'failed (network)', 'Error: mixed case'].every(
      (frag) => errLines.some((l) => l.includes(frag)),
    );
    const noNormal = !errLines.some((l) => l.includes('normal heartbeat'));
    if (errLines.length === 4 && hitAll && noNormal) {
      pass('R5.4-2 「只看错误」滤出 error / interrupted / failed 四行，普通行被排除');
    } else {
      fail(`R5.4-2 「只看错误」结果异常（${errLines.length} 行）：${JSON.stringify(errLines)}`);
    }

    // 与「只看本次启动」叠加：后者是请求参数，改它会重新请求
    await q(cdp, `(window.__calls = [], true)`);
    await q(cdp, `(() => { const c = document.querySelector('#logCurrentOnly'); c.checked = true; c.dispatchEvent(new Event('change')); return true; })()`);
    await sleep(400);
    const logReqs = await q(cdp, `window.__calls.filter(p => p === '/api/bridge/log').length`);
    if (logReqs === 1) pass('R5.4-1 勾「只看本次启动」重新请求一次日志（参数变化）');
    else fail(`R5.4-1 「只看本次启动」请求次数异常：${logReqs}`);
    const info2 = await txt('#logInfo');
    if (/^显示 \d+ \/ 总 \d+ 行$/.test(info2)) pass(`R5.4-1 与「只看本次启动」叠加后仍显示计数：${info2}`);
    else fail(`R5.4-1 叠加后计数异常：「${info2}」`);
  }
} catch (err) {
  fail(`异常中断：${err.message}`);
} finally {
  cleanup();
}

console.log(failures ? `\n存在 ${failures} 项失败` : '\n全部通过');
process.exit(failures ? 1 : 0);
