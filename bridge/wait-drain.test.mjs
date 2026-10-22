// SPDX-License-Identifier: MIT
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { waitDrain } from './wait-drain.mjs';

/** 最小 ServerResponse 桩：只需要 waitDrain 用到的状态与事件方法。 */
function fakeRes(overrides = {}) {
  const res = new EventEmitter();
  res.destroyed = false;
  res.writableEnded = false;
  res.writableFinished = false;
  Object.assign(res, overrides);
  return res;
}

test('waitDrain：响应已经关闭 / 结束时立即兑现，不注册永远不会触发的事件', async () => {
  for (const state of ['destroyed', 'writableEnded', 'writableFinished']) {
    const res = fakeRes({ [state]: true });
    let settled = false;
    const pending = waitDrain(res).then(() => { settled = true; });
    await Promise.resolve();
    assert.equal(settled, true, `${state}=true 时应立即兑现`);
    await pending;
    assert.equal(res.listenerCount('close'), 0, `${state}=true 时不应残留 close 监听器`);
  }
});

test('waitDrain：drain / close / error 任一发生即兑现，并清理其余监听器', async () => {
  for (const event of ['drain', 'close', 'error']) {
    const res = fakeRes();
    const pending = waitDrain(res);
    res.emit(event);
    await pending;
    assert.equal(res.listenerCount('drain'), 0, `${event} 后 drain 监听器应清理`);
    assert.equal(res.listenerCount('close'), 0, `${event} 后 close 监听器应清理`);
    assert.equal(res.listenerCount('error'), 0, `${event} 后 error 监听器应清理`);
  }
});
