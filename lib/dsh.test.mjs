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

import { bundlesAllInstalled, detectNativeRoute, isOptionalBundle } from './dsh.mjs';

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

test('bundlesAllInstalled：可选实验 bundle 缺失不算不健康（issue #1）', () => {
  assert.equal(bundlesAllInstalled([
    { name: '@deepseek-ai/dsh-base', installed: true },
    { name: '@deepseek-ai/dsh-experimental-agent-team-profile', installed: false, optional: true },
  ]), true, '只有可选 bundle 缺失时不能把整体判成不健康');
  assert.equal(bundlesAllInstalled([
    { name: '@deepseek-ai/dsh-base', installed: false },
    { name: '@deepseek-ai/dsh-experimental-agent-team-profile', installed: false, optional: true },
  ]), false, '必需 bundle 缺失仍然必须判为不健康');
  assert.equal(isOptionalBundle('@deepseek-ai/dsh-experimental-voice-input-bundle'), true);
  assert.equal(isOptionalBundle('@deepseek-ai/dsh-base'), false);
});

test('detectNativeRoute：插件 bundle 已装且未被 patch 关闭 → 原生路由生效', () => {
  const bundles = [
    { name: '@deepseek-ai/dsh-base', installed: true },
    { name: 'dsh-plugin-workbuddy', installed: true },
  ];
  const off = detectNativeRoute('', bundles);
  assert.deepEqual(off, {
    installed: true,
    enabled: true,
    disabledByPatch: false,
    provider: 'workbuddy',
    bundle: 'dsh-plugin-workbuddy',
  });
});

test('detectNativeRoute：patch 里 disabled: true 必须判为未启用', () => {
  const bundles = [{ name: 'workbuddy-to-dsh', installed: true }];
  const patch = [
    '- id: workbuddy',
    '  disabled: true',
    '- id: subagent',
  ].join('\n');
  const r = detectNativeRoute(patch, bundles);
  assert.equal(r.installed, true);
  assert.equal(r.disabledByPatch, true);
  assert.equal(r.enabled, false);
});

test('detectNativeRoute：bundle 没装 / 不在 bundles 列表 → 不构成原生路由', () => {
  assert.equal(detectNativeRoute('', []).enabled, false);
  assert.equal(detectNativeRoute('', [{ name: 'dsh-plugin-workbuddy', installed: false }]).enabled, false);
  assert.equal(detectNativeRoute('', [{ name: 'some-other-plugin', installed: true }]).enabled, false);
});

test('detectNativeRoute：config 里同名字段 / 注释行不能误判成关闭', () => {
  const bundles = [{ name: 'dsh-plugin-workbuddy', installed: true }];
  const patch = [
    '- id: workbuddy',
    '  config:',
    '    disabled: true',
    '    items:',
    '      - a',
    '  # disabled: true',
  ].join('\n');
  assert.equal(detectNativeRoute(patch, bundles).enabled, true, '只有条目级 disabled 才生效');

  const real = [
    '- id: workbuddy',
    '  config:',
    '    items:',
    '      - a',
    '  disabled: true',
  ].join('\n');
  assert.equal(detectNativeRoute(real, bundles).enabled, false, 'config 里的缩进列表不能提前结束条目');
});
