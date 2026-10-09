/**
 * 积分缓存的**作废竞态**用例 —— 切账号 / 签到后不许再显示上一个账号的余额。
 *
 *   node --test lib/diagnostics.quota.test.mjs
 *
 * 缺陷：`invalidateQuotaCache()` 原先只清 `quotaCache`、**没管在途请求**，
 * 而在途请求完成时会**无条件**把结果写回缓存。于是这个时序会出错：
 *
 *   轮询发起查询（在途，属于账号 A）
 *     → 用户切到账号 B（作废缓存）
 *     → 在途请求完成，把 A 的余额写回
 *     → 控制台最多 60 秒显示的是 A 的余额
 *
 * 修法：加 `quotaGeneration` 代次 —— 在途请求只在「自己那一代仍是当前代」时
 * 才写回；作废时同时把在途句柄置空，让下一次调用立刻发起新查询。
 *
 * 怎么测：桩故意**慢 500ms**，这样「作废」能落在在途窗口里 —— 快桩会让请求
 * 在作废之前就结束，竞态根本触发不到，用例就白写了。
 * `config.bridge` 的 host/port 来自环境变量，所以在 `import` **之前**设好即可
 * （这也是这里用动态 import 的原因）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

/** 起一个假的桥，`/v1/quota` 返回当前 `state.balance`，故意慢。 */
async function startStubQuota(state, delayMs = 500) {
  const calls = [];
  const srv = createServer((req, res) => {
    const path = new URL(req.url, 'http://127.0.0.1').pathname;
    if (path !== '/v1/quota') { res.writeHead(404); return res.end('{}'); }
    const snapshot = state.balance; // 快照：模拟「这一份响应属于哪个账号」
    calls.push(snapshot);
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, balance: snapshot }));
    }, delayMs);
    return undefined;
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return {
    port: srv.address().port,
    calls,
    close: () => new Promise((r) => srv.close(r)),
  };
}

test('切账号后，在途的积分请求不得把上一个账号的余额写回缓存', { timeout: 30_000 }, async () => {
  const state = { balance: 'A' };
  const stub = await startStubQuota(state);
  // config 在 import 时读环境变量 → 必须先设好再动态 import
  process.env.WORKBUDDY_HOST = '127.0.0.1';
  process.env.WORKBUDDY_PORT = String(stub.port);
  const { bridgeQuota, invalidateQuotaCache } = await import('./diagnostics.mjs');

  try {
    // ① 发起一次查询（属于账号 A），**不等它** —— 要的就是「在途」这个状态
    const inFlight = bridgeQuota({ force: true });
    await new Promise((r) => setTimeout(r, 80)); // 让请求真的发出去

    // ② 在途期间用户切到账号 B：作废缓存，并把桩的返回值也切过去
    state.balance = 'B';
    invalidateQuotaCache();

    // ③ 在 A 的请求**还没回来**时再取一次 —— 这次必须是 B
    const after = await bridgeQuota();

    assert.equal(
      after?.balance, 'B',
      `切账号后取到的必须是新账号的余额，实际 ${after?.balance}（说明被在途的旧结果污染了）`,
    );
    assert.ok(stub.calls.length >= 2, `作废后应当重新发起查询，实际只发了 ${stub.calls.length} 次`);

    // 收尾：把第一次的 promise 消化掉，免得测试结束后还有未处理拒绝
    await inFlight.catch(() => {});
  } finally {
    await stub.close();
  }
});
