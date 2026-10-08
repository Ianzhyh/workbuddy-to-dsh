/**
 * 验收：「进行中请求」区块（卡死可见性，对应 ACTION-PLAN 2.3 / 报告 P1-8）。
 *
 *   node tools/dev/test-active-requests.mjs
 *
 * 打桩 /api/requests 喂已知数据（正常 + 超阈值各一条），断言：
 *   ① 进行中条目按 active[] 渲染（数量 / 模型 / 流式标记）；
 *   ② 超过 activeAlertMs 的条目恰有一条标黄，且带「疑似卡死」提示；
 *   ③ 「已运行」秒级刷新（ticker 生效）。
 * 不碰真实桥、不消耗上游额度。
 */
import { startStaticServer, openPage, waitFor, q, sleep, shapeStub } from './ui-harness.mjs';

const PORT = 8797;
const URL_ = `http://127.0.0.1:${PORT}/`;
let failures = 0;
const fail = (m) => { console.error('✗ ' + m); failures += 1; };
const pass = (m) => console.log('✓ ' + m);

const now = Date.now();
// 值不重要的接口全部用形状表生成合法桩（结构永远对得上，不手抄）；
// 只有 /api/requests 需要真实值 —— 在形状底上覆盖。
const ROUTES = {
  '/api/overview': { body: shapeStub('/api/overview') },
  '/api/models': { body: shapeStub('/api/models') },
  '/api/usage': { body: shapeStub('/api/usage') },
  '/api/accounts': { body: shapeStub('/api/accounts') },
  '/api/checkin': { body: shapeStub('/api/checkin') },
  '/api/diagnose': { body: shapeStub('/api/diagnose') },
  '/api/probe-results': { body: shapeStub('/api/probe-results') },
  '/api/bridge/log': { body: { lines: [] } },
  '/api/requests': {
    body: {
      ...shapeStub('/api/requests'),
      requests: [{
        t: now - 60_000, model: 'deepseek-v4.1-flash', stream: true, ms: 1200,
        ok: true, promptTokens: 10, completionTokens: 5, credit: 0.01, status: 200, code: 0, error: '',
      }],
      active: [
        { id: 'req_a', startedAt: now - 15_000, model: 'deepseek-v4.1-flash', stream: true, runningMs: 15_000 },
        { id: 'req_b', startedAt: now - 400_000, model: 'glm-5.3', stream: false, runningMs: 400_000 },
      ],
      activeAlertMs: 300_000,
    },
  },
};

const server = await startStaticServer(PORT);
const { cdp, close } = await openPage(URL_, ROUTES);
const cleanup = () => { try { cdp.close(); } catch { /* 忽略 */ } try { server.close(); } catch { /* 忽略 */ } };
process.on('exit', cleanup);

try {
  await waitFor(cdp, `document.querySelectorAll('.reqactive').length === 2`, 10000, '进行中条目渲染');
  pass('进行中条目按 active[] 渲染（2 条）');

  const hotCount = await q(cdp, `document.querySelectorAll('.reqactive.hot').length`);
  if (hotCount === 1) pass('超过 activeAlertMs 的条目恰有 1 条被标黄');
  else fail(`标黄条目应为 1，实测 ${hotCount}`);

  const firstText = await q(cdp, `document.querySelector('.reqactive').textContent`);
  if (firstText.includes('deepseek-v4.1-flash') && firstText.includes('已运行')) {
    pass('条目含模型名与「已运行」时长');
  } else {
    fail('条目文本缺模型或时长：' + JSON.stringify(firstText));
  }

  const hotText = await q(cdp, `document.querySelector('.reqactive.hot').textContent`);
  if (hotText.includes('疑似卡死')) pass('标黄条目带「疑似卡死」提示');
  else fail('标黄条目缺提示文案：' + JSON.stringify(hotText));

  // 秒级 ticker：等一个更新周期，文本必须变化（「15 秒」→ 更大）
  const t1 = await q(cdp, `document.querySelector('.reqactive .runfor').textContent`);
  await sleep(1600);
  const t2 = await q(cdp, `document.querySelector('.reqactive .runfor').textContent`);
  if (t1 !== t2) pass(`「已运行」秒级刷新（${t1} → ${t2}）`);
  else fail(`「已运行」未刷新（${t1} → ${t2}）`);
} catch (err) {
  fail('异常：' + err.message);
}

console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
process.exit(failures ? 1 : 0);
