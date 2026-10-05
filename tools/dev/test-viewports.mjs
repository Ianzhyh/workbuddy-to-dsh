/**
 * 多视口溢出扫描（Task 36.2）。
 *
 *   node tools/dev/test-viewports.mjs
 *
 * 用打桩数据在 1440 / 1100 / 820 / 420 四个宽度下渲染整页，
 * 检查**没有横向溢出** —— 新增的列、提示条、详情行、图表都是重点。
 */
import { startStaticServer, openPage, waitFor, q, sleep } from './ui-harness.mjs';

const PORT = 8775;
const WIDTHS = [1440, 1100, 820, 420];
const now = Date.now();

let failures = 0;
const fail = (m) => { console.error('✗ ' + m); failures += 1; };
const pass = (m) => console.log('✓ ' + m);

const CATALOG = ['deepseek-v4.1-flash', 'glm-5.3', 'kimi-k3', 'hy3'].map((id) => ({
  id, name: id, context_window: 1000000, max_output_tokens: 128000, credits: 0.11, supports_images: true,
}));
const USAGE = {
  windowDays: 7,
  total: { calls: 42, promptTokens: 186000, completionTokens: 42000, ms: 38000, credit: 1.24, creditCalls: 38, failed: 3 },
  models: [
    { model: 'deepseek-v4.1-flash', calls: 21, promptTokens: 120000, completionTokens: 30000, ms: 20000, credit: 0.62, creditCalls: 20 },
    { model: 'glm-5.3', calls: 12, promptTokens: 50000, completionTokens: 8000, ms: 12000, credit: 0.48, creditCalls: 11 },
    { model: 'kimi-k3', calls: 9, promptTokens: 16000, completionTokens: 4000, ms: 6000, credit: 0.14, creditCalls: 7 },
  ],
  days: Array.from({ length: 7 }, (_, i) => ({
    day: '2026-10-0' + (i + 1), calls: i + 1, promptTokens: 9000, completionTokens: 2000, credit: 0.08, creditCalls: i + 1,
  })),
  failures: [],
};
const REQUESTS = Array.from({ length: 30 }, (_, i) => ({
  t: now - i * 1000,
  model: i % 2 ? 'glm-5.3' : 'deepseek-v4.1-flash',
  stream: i % 3 === 0,
  ok: i % 5 !== 0,
  ms: 900 + i,
  promptTokens: 100, completionTokens: 30, credit: 0.01,
  status: i % 5 === 0 ? 400 : 0,
  code: i % 5 === 0 ? 'invalid_request' : null,
  error: i % 5 === 0 ? 'a very long upstream error message that should wrap instead of overflowing the table horizontally' : null,
}));

const FIX = { requests: REQUESTS };
const routes = {
  '/api/models': { body: { models: CATALOG } },
  '/api/overview': {
    body: {
      bridge: { running: true, ok: true, host: '127.0.0.1', port: 8790, endpoint: 'http://127.0.0.1:8790/v1', pid: 1, startedAt: new Date(now - 1000).toISOString(), uptimeMs: 5400000, catalogSize: 4, catalogAt: new Date(now - 60000).toISOString(), upstreamShape: { droppedNonChat: ['nes-gf'] } },
      credentials: { active: { account: 'example-account', userId: 'example-user-id', domain: 'www.codebuddy.cn', remainingMs: 44 * 86400000, expiresAt: now + 44 * 86400000 }, error: '' },
      quota: { total: 118, packages: [{ name: '每日签到', remain: 18, size: 20 }] },
      dsh: { routeLive: true, routeSource: 'cordis.patch.yml', hasBridgeKey: true, bundlesOk: true, bundles: [], registeredModels: ['deepseek-v4.1-flash', 'glm-5.3'] },
      console: { version: '1.0.0', node: 'v22.22.2' },
    },
  },
  '/api/probe-results': {
    body: {
      updatedAt: now - 180000,
      results: { 'deepseek-v4.1-flash': { ok: true, ms: 1180, at: now - 200000 }, 'glm-5.3': { ok: false, ms: 2400, at: now - 190000, error: 'HTTP 400' } },
      lastRun: { scope: 'checked', count: 2 },
    },
  },
  '/api/diagnose': { body: { items: [{ id: 'exe', label: 'WorkBuddy 客户端', status: 'ok', detail: 'ok', hint: '' }] } },
  '/api/usage': { body: { usage: USAGE } },
  '/api/requests': { body: () => ({ requests: window.__FIX.requests }) },
  '/api/accounts': { body: { accounts: [{ name: 'a.info', account: 'example-account', active: true, usable: true, remainingMs: 44 * 86400000, domain: 'www.codebuddy.cn' }] } },
  '/api/checkin': { body: { status: { active: true, todayCheckedIn: false, streakDays: 5, dailyCredit: 18 }, checkin: { auto: true, lastAt: now - 60000, lastResult: 'error', lastError: 'upstream boom', lastSource: 'hourly' } } },
  '/api/bridge/log': { body: { lines: ['2026-10-04 09:00:00 ERROR upstream 502', '2026-10-04 09:00:01 normal heartbeat line'] } },
};

const server = await startStaticServer(PORT);
const INJECT = `window.__FIX = ${JSON.stringify(FIX)};`;

// 复用一个浏览器：逐宽度改视口再重载，比开四次 Chrome 快得多
const { cdp, close } = await openPage(`http://127.0.0.1:${PORT}/`, routes, {
  cdpPort: 9340, width: WIDTHS[0], height: 900, inject: INJECT,
});

try {
  for (const w of WIDTHS) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: 900, deviceScaleFactor: 1, mobile: false });
    await cdp.send('Page.reload', { ignoreCache: false });
    await sleep(1200);

    await waitFor(cdp, `document.querySelectorAll('#modelTable tbody tr').length === 4`, 12000, `${w}px 模型表`);
    // 展开一个详情行 + 日志面板：新增的宽内容最容易撑破
    await q(cdp, `(() => { const b = document.querySelector('#modelTable button.infobtn'); if (b) b.click(); return true; })()`);
    await q(cdp, `(document.querySelector('details').open = true, true)`);
    await sleep(600);

    const r = await q(cdp, `(function(){
      const de = document.documentElement;
      const over = [];
      const vw = window.innerWidth;
      document.querySelectorAll('body *').forEach((el) => {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0) return;
        if (rect.right > vw + 1) {
          // 可横向滚动的容器内部允许超出：.nav-tabs 是刻意做成 overflow-x:auto
          // 的标签条（窄屏时横向滚动，见 style.css），它的最后一个标签越出
          // 视口右缘是设计行为，不是溢出 bug。
          const wrap = el.closest('.tablewrap, #chatOut, pre.log, #alertBar, .nav-tabs');
          if (wrap) return; // 可横向滚动的容器内部允许超出
          over.push((el.id ? '#' + el.id : (el.className || el.tagName)) + ' right=' + Math.round(rect.right));
        }
      });
      return { docScrollW: de.scrollWidth, clientW: de.clientWidth, over: over.slice(0, 5) };
    })()`);

    if (r.docScrollW <= r.clientW + 1) pass(`${w}px 无横向溢出（scrollWidth ${r.docScrollW} <= ${r.clientW}）`);
    else fail(`${w}px 横向溢出：scrollWidth ${r.docScrollW} > ${r.clientW}`);
    if (!r.over.length) pass(`${w}px 没有元素越出视口右边界`);
    else fail(`${w}px 越界元素：${r.over.join(' | ')}`);
  }
} catch (err) {
  fail(`异常中断：${err.message}`);
} finally {
  close();
  server.close();
}

console.log(failures ? `\n存在 ${failures} 项失败` : '\n全部通过');
process.exit(failures ? 1 : 0);
