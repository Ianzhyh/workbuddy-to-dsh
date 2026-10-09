/**
 * `bundlesAllInstalled()` 的用例 —— 「空 = 未知，未知不等于健康」。
 *
 *   node --test lib/dsh.test.mjs
 *
 * 为什么要单独钉这一条：`[].every(...)` 在 JS 里返回 `true`，所以只要
 * 「插件列表读不出来」这条路径一旦走到（profile 目录缺失、解析异常被 catch 吞掉），
 * 原来的写法就会把「什么都没检查」报成「健康」。这类 bug 不会报错、也不会崩，
 * 只会让用户看着一个绿点以为一切正常 —— 只有用例能拦住。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { bundlesAllInstalled } from './dsh.mjs';

test('bundlesAllInstalled：空列表不算健康（读不到 ≠ 都装好了）', () => {
  assert.equal(bundlesAllInstalled([]), false, '空数组必须判为 false —— 这是本用例存在的唯一理由');
});

test('bundlesAllInstalled：非数组输入一律 false', () => {
  for (const bad of [null, undefined, 'x', 0, {}]) {
    assert.equal(bundlesAllInstalled(bad), false, `${JSON.stringify(bad)} 应当判为 false`);
  }
});

test('bundlesAllInstalled：全装好为 true，缺一个为 false', () => {
  assert.equal(bundlesAllInstalled([{ installed: true }, { installed: true }]), true);
  assert.equal(bundlesAllInstalled([{ installed: true }, { installed: false }]), false);
});
