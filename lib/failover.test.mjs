/**
 * 共享的账号切号判定（`lib/failover.mjs`）。
 *
 * 这两条规则被 Web 控制台与 dsh 插件共用；任何一处改动都必须两边同时生效 ——
 * 所以测试直接钉这个模块，而不是各自的调用点。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { failoverSignal, pickAccountFailoverTarget } from './failover.mjs';

test('pickAccountFailoverTarget：currentUid 优先于 active 标记（active 可能过期）', () => {
  const accounts = [
    { name: 'a.info', active: true, usable: true, userId: 'u1' }, // 控制台记录的钉住项
    { name: 'b.info', usable: true, userId: 'u2' },              // 桥实际在服务的账号
    { name: 'c.info', usable: true, userId: 'u3' },
  ];
  assert.equal(
    pickAccountFailoverTarget(accounts, 'u2')?.name,
    'c.info',
    '必须从桥当前真正服务的 u2 往后找，而不是从过期的 active（u1）往后找',
  );
});

test('pickAccountFailoverTarget：没有 currentUid 时 active 兜底', () => {
  const accounts = [
    { name: 'a.info', active: true, usable: true, userId: 'u1' },
    { name: 'b.info', usable: true, userId: 'u2' },
  ];
  assert.equal(pickAccountFailoverTarget(accounts, '')?.name, 'b.info');
});

test('pickAccountFailoverTarget：跳过不可用 / 隐藏 / 当前账号', () => {
  const accounts = [
    { name: 'a.info', active: true, usable: true, userId: 'u1' },
    { name: 'b.info', usable: false },
    { name: 'c.info', usable: true, hidden: true },
    { name: 'd.info', usable: true, userId: 'u4' },
  ];
  assert.equal(pickAccountFailoverTarget(accounts, 'u1')?.name, 'd.info');
  assert.equal(pickAccountFailoverTarget([{ name: 'a.info', active: true, usable: true }], 'u1'), null,
    '只有一个可用账号时没有可切换目标');
});

test('pickAccountFailoverTarget：同一账号的多份登录快照不算"下一个账号"', () => {
  const accounts = [
    { name: 'a.info', active: true, usable: true, userId: 'u1', account: '330000' },
    { name: 'a.snapshot.info', usable: true, userId: 'u1', account: '330000' },
    { name: 'b.info', usable: true, userId: 'u2', account: '450000' },
  ];
  assert.equal(pickAccountFailoverTarget(accounts, 'u1')?.name, 'b.info',
    '切到同账号的另一份文件还是同一个钱包，限流不会缓解');
  assert.equal(pickAccountFailoverTarget(accounts.slice(0, 2), 'u1'), null,
    '只有同账号快照时宁可不切');
});

test('pickAccountFailoverTarget：没有 active / uid 时从第一个可用账号开始', () => {
  assert.equal(pickAccountFailoverTarget([
    { name: 'x.info', usable: true },
    { name: 'y.info', usable: true },
  ], '')?.name, 'x.info');
});

test('failoverSignal：只有 desktop 来源且达到阈值才触发', () => {
  const health = (extra = {}) => ({
    ok: true,
    auth: { source: 'desktop', userId: 'u1' },
    rateLimit: { count: 3, model: 'glm-5.3', lastAt: '2026-10-30T00:00:00.000Z' },
    ...extra,
  });
  assert.deepEqual(failoverSignal(health(), 3), {
    count: 3, model: 'glm-5.3', lastAt: '2026-10-30T00:00:00.000Z', reason: 'rate_limit',
  });
  assert.equal(failoverSignal(health(), 4), null, '没到阈值不切');
  assert.equal(failoverSignal(health(), 0), null, '阈值为 0 = 功能关闭');
  assert.equal(failoverSignal(health({ auth: { source: 'plugin' } }), 1), null,
    '插件来源下切桌面账号不会生效，只会在用户不知情时把钱包换掉');
  assert.equal(failoverSignal(health({ auth: { source: 'api-key' } }), 1), null);
  assert.equal(failoverSignal(health({ ok: false }), 1), null, '桥不健康时不切');
  assert.equal(failoverSignal(null, 1), null);
});

test('failoverSignal：11140 账号风控一次即切；14003/队列永不切', () => {
  const base = {
    ok: true,
    auth: { source: 'desktop', userId: 'u1' },
    rateLimit: { count: 0, model: '', lastAt: '' },
  };
  const restricted = {
    ...base,
    rateLimit: {
      ...base.rateLimit,
      accountRestricted: {
        model: 'glm-5.3',
        lastAt: '2026-11-02T11:15:00.000Z',
        resetAt: '',
      },
    },
  };
  assert.deepEqual(failoverSignal(restricted, 3), {
    count: 1,
    model: 'glm-5.3',
    lastAt: '2026-11-02T11:15:00.000Z',
    resetAt: '',
    reason: 'account_restricted',
  });
  assert.equal(failoverSignal(restricted, 0), null, '未开启自动切号时不切');
  // 模型级失败不能触发换号（换号拿到的是同一个模型）。
  assert.equal(failoverSignal({
    ...base,
    rateLimit: { ...base.rateLimit, modelBusy: { model: 'glm-5.3', lastAt: '', resetAt: '' } },
  }, 1), null, '14003 模型繁忙不能换号');
  assert.equal(failoverSignal({
    ...base,
    rateLimit: { ...base.rateLimit, queue: { model: 'glm-5.3', code: 6020, position: 7 } },
  }, 1), null, '队列不能换号');
});

test('failoverSignal：账号用量上限（6004/14018）一次就切，且带重置时刻', () => {
  /*
   * 重置在数小时后：等 N 次瞬时限流没有意义。同类项目（账号池/多账号反代）
   * 的共同做法就是 6004 一次即换号；这里只要求用户已开启自动切号（after>0）。
   */
  const health = {
    ok: true,
    auth: { source: 'desktop', userId: 'u1' },
    rateLimit: {
      count: 0,
      model: '',
      lastAt: '',
      quota: {
        count: 1,
        model: 'deepseek-v4.1-flash',
        lastAt: '2026-11-02T11:15:00.000Z',
        resetAt: '2026-11-03T07:19:12.000Z',
      },
    },
  };
  assert.deepEqual(failoverSignal(health, 3), {
    count: 1,
    model: 'deepseek-v4.1-flash',
    lastAt: '2026-11-02T11:15:00.000Z',
    resetAt: '2026-11-03T07:19:12.000Z',
    reason: 'quota',
  });
  assert.equal(failoverSignal(health, 0), null, '未开启自动切号时不切');
  assert.equal(failoverSignal({ ...health, auth: { source: 'plugin' } }, 1), null,
    '插件来源不在桌面切号范围内');
  assert.deepEqual(
    failoverSignal({ ...health, rateLimit: { ...health.rateLimit, quota: { count: 1, model: 'm', resetAt: '' } } }, 1),
    { count: 1, model: 'm', lastAt: '', resetAt: '', reason: 'quota' },
    '上游没给重置时刻也要立即切，只是 resetAt 为空',
  );
});
