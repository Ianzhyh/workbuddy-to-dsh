/**
 * R6 选模型更明白 验收（Task 21–22）。
 *
 *   node tools/dev/test-r6-detail.mjs
 *
 * 覆盖：详情弹层内容与交互（同屏一个 / Esc / 点空白）、缺项不显示、
 * 不重建整表、数字紧凑显示与精确值 tooltip。
 */
import { startStaticServer, openPage, waitFor, q, sleep } from './ui-harness.mjs';

const PORT = 8786;
const URL_ = `http://127.0.0.1:${PORT}/`;

let failures = 0;
const fail = (m) => { console.error('✗ ' + m); failures += 1; };
const pass = (m) => console.log('✓ ' + m);

const now = Date.now();
const CATALOG = [
  {
    id: 'hy4', name: 'HY4', context_window: 1000000, max_output_tokens: 128000, credits: 0.11,
    description_zh: '面向长上下文的高性价比模型', description_en: 'Long-context model',
    vendor: '腾讯混元', tags: ['craft', 'reasoning'], supports_images: true, badge: '限时免费', free: true,
  },
  { id: 'hy3', name: 'HY3', context_window: 960000, max_output_tokens: 48000, credits: 0.51 },
  { id: 'nes-gf', name: 'NES-GF', context_window: 131072, max_output_tokens: 8192, credits: 0.79 },
];

const USAGE = {
  windowDays: 7,
  total: { calls: 3, promptTokens: 2000, completionTokens: 0, ms: 300, credit: 0.24, creditCalls: 3, failed: 0 },
  models: [{ model: 'hy4', calls: 3, promptTokens: 2000, completionTokens: 0, ms: 300, credit: 0.24, creditCalls: 3 }],
  days: [{ day: '2026-10-04', calls: 3, promptTokens: 2000, completionTokens: 0, credit: 0.24, creditCalls: 3 }],
  failures: [],
};

const routes = {
  '/api/models': { body: { models: CATALOG } },
  '/api/overview': {
    body: {
      bridge: { running: true, ok: true, host: '127.0.0.1', port: 8790, endpoint: 'http://127.0.0.1:8790/v1', pid: 1, startedAt: new Date(now - 1000).toISOString(), uptimeMs: 1000, catalogSize: 3, catalogAt: new Date(now - 60000).toISOString() },
      credentials: { active: { account: 'a', userId: 'a', remainingMs: 40 * 86400000, expiresAt: now + 40 * 86400000 }, error: '' },
      quota: { total: 10, packages: [] },
      dsh: { routeLive: true, hasBridgeKey: true, bundlesOk: true, bundles: [], registeredModels: ['hy4'] },
      console: { version: '1.0.0', node: 'v22' },
    },
  },
  '/api/probe-results': {
    body: { updatedAt: now - 60000, results: { hy4: { ok: true, ms: 1180, at: now - 60000, credit: 0 }, hy3: { ok: false, ms: 2400, at: now - 60000, error: 'HTTP 400' } }, lastRun: { scope: 'checked', count: 2 } },
  },
  '/api/diagnose': { body: { items: [] } },
  '/api/usage': { body: { usage: USAGE } },
  '/api/requests': { body: { requests: [] } },
  '/api/accounts': { body: { accounts: [] } },
  '/api/checkin': { body: { status: { active: true, todayCheckedIn: true } } },
  '/api/bridge/log': { body: { lines: [] } },
};

const server = await startStaticServer(PORT);
const { cdp, close } = await openPage(URL_, routes);
const cleanup = () => { try { cdp.close(); } catch { /* 忽略 */ } try { server.close(); } catch { /* 忽略 */ } };
process.on('exit', cleanup);

const detailText = () => q(cdp, `(document.querySelector('#modelTable tr.detail-row')||{}).textContent || ''`);
const detailRows = () => q(cdp, `document.querySelectorAll('#modelTable tr.detail-row').length`);
const clickInfo = (id) => q(cdp, `(() => { const b = document.querySelector('#modelTable button.infobtn[data-info="${id}"]'); if (!b) return false; b.click(); return true; })()`);

try {
  await waitFor(cdp, `document.querySelectorAll('#modelTable tbody tr').length === 3`, 10000, '模型表渲染');
  await sleep(300);

  // ── R6.2-1 数字紧凑显示 ─────────────────────────────────────────────
  {
    const cells = await q(cdp, `[...document.querySelectorAll('#modelTable tbody tr')].map(tr => ({
      id: tr.querySelector('td.copyable').textContent.trim(),
      ctx: tr.children[3].textContent,
      ctxTitle: tr.children[3].title,
      out: tr.children[4].textContent,
      outTitle: tr.children[4].title
    }))`);
    const hy4 = cells.find((c) => c.id.startsWith('hy4'));
    const hy3 = cells.find((c) => c.id.startsWith('hy3'));
    const nes = cells.find((c) => c.id.startsWith('nes-gf'));
    if (hy4.ctx === '1M' && hy3.ctx === '960K' && nes.ctx === '131K') {
      pass(`R6.2-1 上下文列紧凑显示：${hy4.ctx} / ${hy3.ctx} / ${nes.ctx}`);
    } else {
      fail(`R6.2-1 上下文列异常：${hy4.ctx} / ${hy3.ctx} / ${nes.ctx}`);
    }
    if (hy4.ctxTitle === '1,000,000' && hy4.outTitle === '128,000') {
      pass(`R6.2-1 tooltip 保留精确值：${hy4.ctxTitle} / ${hy4.outTitle}`);
    } else {
      fail(`R6.2-1 tooltip 精确值异常：${hy4.ctxTitle} / ${hy4.outTitle}`);
    }
    if (hy4.out === '128K' && hy3.out === '48K') pass(`R6.2-1 最大输出列同样紧凑：${hy4.out} / ${hy3.out}`);
    else fail(`R6.2-1 最大输出列异常：${hy4.out} / ${hy3.out}`);
  }

  // ── R6.1-1 详情弹层内容 ─────────────────────────────────────────────
  {
    // 先打一个标记，验证「不重建整表」
    await q(cdp, `(document.querySelector('#modelTable tbody tr').__marker = 'row0', true)`);
    const widthsBefore = await q(cdp, `[...document.querySelectorAll('#modelTable thead th')].map(th => Math.round(th.getBoundingClientRect().width))`);

    await clickInfo('hy4');
    await sleep(250);

    const text = await detailText();
    const checks = [
      [/面向长上下文的高性价比模型/, '中文描述'],
      [/Long-context model/, '英文描述'],
      [/腾讯混元/, '厂商'],
      [/craft、reasoning/, '标签'],
      [/支持图片/, '支持图片'],
      [/1,000,000/, '上下文精确值'],
      [/128,000/, '最大输出精确值'],
      [/限时免费/, '促销'],
      [/0\.12 \/ 千 token（3 次）/, '实测成本'],
      [/可用/, '体检结论'],
      [/已注册/, 'dsh 注册状态'],
    ];
    let bad = 0;
    for (const [re, label] of checks) if (!re.test(text)) { fail(`R6.1-1 详情缺少「${label}」`); bad += 1; }
    if (!bad) pass(`R6.1-1 详情包含全部字段（${checks.length} 项）`);

    // 不重建整表：同一批 DOM 节点还在，列宽不变
    const marker = await q(cdp, `document.querySelector('#modelTable tbody tr').__marker`);
    const widthsAfter = await q(cdp, `[...document.querySelectorAll('#modelTable thead th')].map(th => Math.round(th.getBoundingClientRect().width))`);
    if (marker === 'row0') pass('R6.1-2 展开详情**未重建**整表（原 DOM 节点保留）');
    else fail('R6.1-2 表格被重建了');
    if (JSON.stringify(widthsBefore) === JSON.stringify(widthsAfter)) pass('R6.1-2 展开详情未改变列宽');
    else fail(`R6.1-2 列宽变了：${JSON.stringify(widthsBefore)} → ${JSON.stringify(widthsAfter)}`);

    // 同屏只开一个
    await clickInfo('hy3');
    await sleep(250);
    if (await detailRows() === 1) pass('R6.1-1 同屏只开一个详情（开第二个时第一个自动收起）');
    else fail(`R6.1-1 详情行数应为 1，实际 ${await detailRows()}`);
    const hy3Text = await detailText();
    if (/960,000/.test(hy3Text)) pass('R6.1-1 切到 hy3 的详情');
    else fail(`R6.1-1 第二个详情内容异常：${hy3Text.slice(0, 80)}`);
    if (!/无/.test(hy3Text.replace(/未注册/g, ''))) pass('R6.1-2 hy3 缺数据的字段整行不显示（没有「无」占位）');
    else fail(`R6.1-2 出现了「无」占位：${hy3Text.slice(0, 120)}`);

    // Esc 关闭
    await q(cdp, `(document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })), true)`);
    await sleep(200);
    if (await detailRows() === 0) pass('R6.1-1 Esc 可关闭详情');
    else fail('R6.1-1 Esc 未关闭详情');

    // 点空白关闭
    await clickInfo('hy4');
    await sleep(200);
    await q(cdp, `(document.body.click(), true)`);
    await sleep(200);
    if (await detailRows() === 0) pass('R6.1-1 点空白可关闭详情');
    else fail('R6.1-1 点空白未关闭详情');

    // 再点同一个 ⓘ 收起
    await clickInfo('hy4');
    await sleep(200);
    const opened = await detailRows();
    await clickInfo('hy4');
    await sleep(200);
    if (opened === 1 && await detailRows() === 0) pass('R6.1-1 再点同一个 ⓘ 收起详情');
    else fail(`R6.1-1 再点未收起：opened=${opened} now=${await detailRows()}`);

    // 搜索词 / 勾选在展开收起后保持
    await q(cdp, `(() => { const el = document.querySelector('#modelFilter'); el.value = 'hy'; el.dispatchEvent(new Event('input')); return true; })()`);
    await sleep(200);
    const checkedBefore = await q(cdp, `document.querySelectorAll('#modelTable input[data-id]:checked').length`);
    await clickInfo('hy4');
    await sleep(200);
    const search = await q(cdp, `document.querySelector('#modelFilter').value`);
    const checkedAfter = await q(cdp, `document.querySelectorAll('#modelTable input[data-id]:checked').length`);
    if (search === 'hy' && checkedBefore === checkedAfter) pass('R6.1-2 展开详情不影响搜索词与勾选状态');
    else fail(`R6.1-2 状态被冲掉：search=「${search}」checked ${checkedBefore}→${checkedAfter}`);
  }
} catch (err) {
  fail(`异常中断：${err.message}`);
} finally {
  cleanup();
}

console.log(failures ? `\n存在 ${failures} 项失败` : '\n全部通过');
process.exit(failures ? 1 : 0);
