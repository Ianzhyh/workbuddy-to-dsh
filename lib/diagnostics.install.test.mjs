/**
 * 「WorkBuddy 客户端」诊断项：安装布局三种分支 —— 找不到 / 两个产品装进同一目录 / 正常。
 *
 *   node --test lib/diagnostics.install.test.mjs
 *
 * ## 真实事故（2026-10-17，用户机器）
 *
 * WorkBuddy 国内版（5.8.3，`WorkBuddy.exe`）与 WorkBuddy AI 国际版（5.8.4，
 * `WorkBuddyAI.exe`）被自动更新装进了**同一个目录** `E:\App\WB\WorkBuddy`。
 * 两个产品共用同一份 `resources/app.asar`，后装的国际版把前一套覆盖掉 →
 * 国内版 exe 只剩壳（启动会跑成国际版），而界面上完全看不出原因。
 *
 * 判据**不能靠目录名猜**（那次目录名很正常），只能看"同一目录里是否出现两个
 * 不同产品的 exe"—— 这正是 `describeClientInstall()` 做的事。
 *
 * 这些用例只喂路径字符串，不读磁盘、不碰真实安装。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeClientInstall } from './diagnostics.mjs';

test('找不到客户端 → fail + 提示用 WORKBUDDY_APP_EXECUTABLE 指定', () => {
  const r = describeClientInstall([]);
  assert.equal(r.status, 'fail');
  assert.match(r.detail, /未找到 WorkBuddy 客户端/);
  assert.match(r.hint, /WORKBUDDY_APP_EXECUTABLE/);
});

test('两个客户端装进同一目录 → fail，并说清后果与修法（真实事故形态）', () => {
  const dir = 'E:\\App\\WB\\WorkBuddy';
  const r = describeClientInstall([`${dir}\\WorkBuddy.exe`, `${dir}\\WorkBuddyAI.exe`]);
  assert.equal(r.status, 'fail');
  assert.match(r.detail, /两个客户端被装进了同一个目录/);
  assert.ok(r.detail.includes(dir), 'detail 要给出具体目录，用户才知道去哪看');
  assert.match(r.detail, /resources/);
  assert.match(r.hint, /分别重装到两个不同目录/);
  assert.match(r.hint, /不会丢账号/, '先说清"卸载重装不丢账号"，用户才敢动手');
  assert.match(r.hint, /docs\/TROUBLESHOOTING\.md/);
  assert.match(r.hint, /更新缓存/, '还要告诉人清掉共用的更新缓存 —— 不清会反复合并');
});

test('两个客户端分别装在两个目录 → ok（这才是能共存的状态）', () => {
  const r = describeClientInstall([
    'E:\\App\\WB\\CN\\WorkBuddy.exe',
    'E:\\App\\WB\\AI\\WorkBuddyAI.exe',
  ]);
  assert.equal(r.status, 'ok');
  assert.equal(r.hint, '');
  assert.match(r.detail, /WorkBuddy\.exe$/, 'detail 给出实际使用的 exe 路径');
});

test('单套安装 → ok', () => {
  const r = describeClientInstall(['C:\\Users\\demo\\AppData\\Local\\Programs\\WorkBuddy\\WorkBuddy.exe']);
  assert.equal(r.status, 'ok');
  assert.match(r.detail, /WorkBuddy\.exe$/);
});
