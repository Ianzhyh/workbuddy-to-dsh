// SPDX-License-Identifier: MIT
/**
 * 等 `res` 的发送缓冲排空 —— 流式转发要的背压。
 *
 * `res.write()` 返回 `false` 表示已超过高水位线：数据还在 Node 的内存里排队。
 * 同时监听 `close`：客户端中途断开时 `drain` 永远不会来，只等 drain 会把
 * 转发协程永久挂住。
 *
 * 关键在预检：客户端可能**在调用本函数之前**就已经断开（`close` 已经 emit），
 * 这时 `once('close')` 永远不会再触发。`destroyed` / `writableEnded` 是判断
 * 「这个响应已经不可能再 drain」的可靠信号。
 */

/**
 * @param {import('node:http').ServerResponse} res
 * @returns {Promise<void>} 排空（或响应已结束 / 断开）后兑现
 */
export const waitDrain = (res) => new Promise((resolve) => {
  if (res.destroyed || res.writableEnded || res.writableFinished) {
    resolve();
    return;
  }
  const done = () => {
    res.off('drain', done);
    res.off('close', done);
    res.off('error', done);
    resolve();
  };
  res.once('drain', done);
  res.once('close', done);
  res.once('error', done);
});
