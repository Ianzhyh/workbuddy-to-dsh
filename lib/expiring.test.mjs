/**
 * 积分临期与账号排序的回归（2026-11-07，学自 dsh-connect-workbuddy 的账号池优先级）。
 *
 * 这一层的价值全在**别把用户的钱算错**上，所以测试重心是三组口径 + 一条顺序：
 *
 *   1. 用 `remain` 而不是 `size` —— 用错会把已花掉的算成"还能花"；
 *   2. 月包（`monthly: true`）不算临期 —— 它的归零是周期性的，不是钱消失；
 *      算进去会让每个账号永远"临期"，排序彻底失去意义；
 *   3. 已过期的积分不算 —— 那部分本来就没了，追一笔不存在的钱没有意义；
 *   4. 排序里「临期优先」必须排在「积分总量」**之前** —— 否则总量几乎从不相等，
 *      临期规则永远不生效（实测过：196 分当天作废，只因少约 1200 分就永远排最后）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  expiringCredits, rankAccounts, pickFailoverTarget, pickAccountFailoverTarget,
  CREDITS_EXPIRING_MS,
} = await import('../lib/failover.mjs');

/**
 * 生成一个「距 now 还有 days 天」的墙钟字符串（上游给的就是这个格式）。
 *
 * ⚠️ 必须用**本地时间**拼，不能用 `toISOString()`：上游的 `expiresAt` 是
 * **无时区墙钟**，而 `expiringCredits` 用 `Date.parse('YYYY-MM-DDTHH:mm:ss')`
 * 解析 —— 后者按**本地时区**解释。用 toISOString 拼会引入一个时区偏移
 * （本机 +8h），边界用例因此偏 1/3 天，测试自己算错还以为实现错了。
 */
const wallClock = (now, days) => {
  const d = new Date(now + days * 86_400_000);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
    + ` ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

const NOW = Date.parse('2026-11-07T04:00:00Z');

test('临期：用 remain 而不是 size（用错会把已花掉的算成还能花）', () => {
  const r = expiringCredits([
    { remain: 10, size: 500, monthly: false, expiresAt: wallClock(NOW, 1) },
  ], NOW);
  assert.equal(r.expiring, 10, '临期量必须是 remain');
  assert.equal(r.total, 10);
});

test('临期：月包不算（它的归零是周期性的，不是钱消失）', () => {
  const r = expiringCredits([
    { remain: 1000, monthly: true, expiresAt: wallClock(NOW, 1) },
    { remain: 50, monthly: false, expiresAt: wallClock(NOW, 1) },
  ], NOW);
  assert.equal(r.expiring, 50, '月包不能计进临期 —— 否则每个账号永远临期');
  // 但月包的积分仍然算进总量（它是真能花的钱）
  assert.equal(r.total, 1050);
});

test('临期：已过期的积分不算', () => {
  const r = expiringCredits([
    { remain: 999, monthly: false, expiresAt: wallClock(NOW, -1) },
  ], NOW);
  assert.equal(r.expiring, 0, '过期积分已经不存在了，不能追它');
});

test('临期：窗口边界 —— 3 天内算、之外的算', () => {
  const inside = expiringCredits(
    [{ remain: 100, monthly: false, expiresAt: wallClock(NOW, 2.9) }], NOW,
  );
  assert.equal(inside.expiring, 100, '2.9 天到期应算临期');

  const outside = expiringCredits(
    [{ remain: 100, monthly: false, expiresAt: wallClock(NOW, 3.1) }], NOW,
  );
  assert.equal(outside.expiring, 0, '3.1 天到期不算临期');
  assert.equal(CREDITS_EXPIRING_MS, 3 * 24 * 3_600_000);
});

test('临期：没有到期信息时 known=false（不是"零积分"）', () => {
  const noExpiry = expiringCredits([{ remain: 100, monthly: false }], NOW);
  assert.equal(noExpiry.known, false, '缺 expiresAt 时不能声称"有读数"');
  const noPackages = expiringCredits([], NOW);
  assert.equal(noPackages.known, false);
  assert.equal(noPackages.total, 0);
  // 非数组输入不能抛
  assert.equal(expiringCredits(null, NOW).expiring, 0);
  assert.equal(expiringCredits(undefined, NOW).total, 0);
});

test('临期：解析上游的"无时区墙钟"格式', () => {
  // 上游给的是 `2026-11-17 16:44:30`（空格分隔、无 T、无 Z），
  // 直接 Date.parse 在部分引擎上会得到 NaN —— 必须能正确解析
  const r = expiringCredits(
    [{ remain: 160, monthly: false, expiresAt: '2026-11-08 10:00:00' }],
    NOW,
  );
  assert.equal(r.known, true, '墙钟格式必须能解析');
  assert.ok(r.earliestExpiry > NOW, '解析出的时刻必须在未来');
});

test('排序：临期优先**不被积分总量遮蔽**（这条是核心）', () => {
  const accounts = [
    // 余额 5 万，但都不临期
    {
      name: 'rich', usable: true, userId: 'u-rich', expiresAt: NOW + 30 * 86_400_000,
      quota: { packages: [{ remain: 50_000, monthly: false, expiresAt: wallClock(NOW, 20) }] },
    },
    // 只有 196 分，但当天作废
    {
      name: 'expiring', usable: true, userId: 'u-exp', expiresAt: NOW + 86_400_000,
      quota: { packages: [{ remain: 196, monthly: false, expiresAt: wallClock(NOW, 0.5) }] },
    },
  ];
  const top = rankAccounts(accounts, { now: NOW });
  assert.equal(top?.name, 'expiring',
    '临期 196 分必须排在余额 5 万的前面 —— 那 196 分确定会损失，5 万下一轮还在');
});

test('排序：两个都临期时，临期多的优先；一样多时先到期的优先', () => {
  const many = rankAccounts([
    { name: 'few', usable: true, userId: 'a', quota: { packages: [{ remain: 10, monthly: false, expiresAt: wallClock(NOW, 1) }] } },
    { name: 'many', usable: true, userId: 'b', quota: { packages: [{ remain: 500, monthly: false, expiresAt: wallClock(NOW, 2) }] } },
  ], { now: NOW });
  assert.equal(many?.name, 'many', '临期积分多的优先');

  const sooner = rankAccounts([
    { name: 'later', usable: true, userId: 'a', quota: { packages: [{ remain: 100, monthly: false, expiresAt: wallClock(NOW, 2.5) }] } },
    { name: 'sooner', usable: true, userId: 'b', quota: { packages: [{ remain: 100, monthly: false, expiresAt: wallClock(NOW, 0.5) }] } },
  ], { now: NOW });
  assert.equal(sooner?.name, 'sooner', '一样多时先到期的优先');
});

test('排序：不可用的账号不参与', () => {
  const top = rankAccounts([
    { name: 'dead', usable: false, userId: 'a' },
    { name: 'ok', usable: true, userId: 'b' },
  ], { now: NOW });
  assert.equal(top?.name, 'ok');
  // 全不可用 → null（不能随便挑一个）
  assert.equal(rankAccounts([{ name: 'x', usable: false }], { now: NOW }), null);
  assert.equal(rankAccounts([], { now: NOW }), null);
});

test('排序：一边有积分读数、一边没有时，不拿"没有"当 0 去比', () => {
  /*
   * 若把"没读数"当 0 积分，它会被永远排到最后 —— 刚发现的账号因此永远不被使用。
   * 正确做法：只在**双方都有读数**时比积分，否则往下走凭据过期时间。
   */
  const top = rankAccounts([
    { name: 'no-quota', usable: true, userId: 'a', expiresAt: NOW + 10 * 86_400_000 },
    { name: 'has-quota', usable: true, userId: 'b', expiresAt: NOW + 1 * 86_400_000,
      quota: { packages: [{ remain: 100, monthly: false, expiresAt: wallClock(NOW, 20) }] } },
  ], { now: NOW });
  // 没有临期积分时，凭据更晚过期的赢 —— no-quota 的凭据晚 10 天
  assert.equal(top?.name, 'no-quota',
    '没读数的账号不该因为"看起来 0 积分"被埋掉；这里它凭据更晚过期，应当胜出');
});

test('排序：excludeUid 排除指定账号', () => {
  const top = rankAccounts([
    { name: 'a', usable: true, userId: 'u1', expiresAt: NOW + 2 * 86_400_000 },
    { name: 'b', usable: true, userId: 'u2', expiresAt: NOW + 1 * 86_400_000 },
  ], { now: NOW, excludeUid: 'u1' });
  assert.equal(top?.name, 'b');
});

test('排序：结果是全序、可复现（表顺序变化不影响）', () => {
  const mk = (name, id) => ({ name, usable: true, userId: id, expiresAt: NOW });
  const forward = rankAccounts([mk('a', 'u1'), mk('b', 'u2'), mk('c', 'u3')], { now: NOW });
  const backward = rankAccounts([mk('c', 'u3'), mk('b', 'u2'), mk('a', 'u1')], { now: NOW });
  assert.equal(forward?.name, backward?.name,
    '所有键都相等时必须按 id 收尾，否则顺序会随账号表顺序抖动');
});

test('降级：没有临期积分时，pickFailoverTarget 与改动前**逐字等价**', () => {
  /*
   * 这条是"不影响别的功能"的护栏。
   *
   * 切号发生在故障路径上，行为变化必须有意识。所以没有临期读数时，
   * `pickFailoverTarget` 必须退化成原来的列表轮转 —— 逐个账号比对，
   * 不是"大致相同"。
   */
  const accounts = [
    { name: 'a.info', usable: true, userId: 'u1', active: true, expiresAt: NOW + 86_400_000 },
    { name: 'b.info', usable: true, userId: 'u2', expiresAt: NOW + 2 * 86_400_000 },
    { name: 'c.info', usable: true, userId: 'u3', expiresAt: NOW + 3 * 86_400_000 },
    { name: 'd.info', usable: false, userId: 'u4' },
  ];
  for (const uid of ['', 'u1', 'u2', 'u3', 'u4', 'none']) {
    const fallback = pickAccountFailoverTarget(accounts, uid);
    const picked = pickFailoverTarget(accounts, uid, { now: NOW });
    assert.deepEqual(picked, fallback,
      `uid=${uid || '(空)'} 时没有临期读数，必须走原来的轮转`);
  }

  // 有 quota 但都不临期（20 天后才到期）时，同样必须降级
  const later = accounts.map((a) => ({
    ...a,
    quota: { packages: [{ remain: 100, monthly: false, expiresAt: wallClock(NOW, 20) }] },
  }));
  assert.deepEqual(pickFailoverTarget(later, 'u1', { now: NOW }), pickAccountFailoverTarget(later, 'u1'),
    '有到期时间但都在窗口外时，不能因此改变轮转');
});

test('降级：一旦有临期积分，就按优先级选（而不是轮转下一个）', () => {
  const accounts = [
    // 当前账号，积分 5 万不临期
    { name: 'current.info', usable: true, userId: 'u-cur', active: true, expiresAt: NOW + 86_400_000,
      quota: { packages: [{ remain: 50_000, monthly: false, expiresAt: wallClock(NOW, 20) }] } },
    // 轮转顺序上的下一个
    { name: 'next.info', usable: true, userId: 'u-next', expiresAt: NOW + 2 * 86_400_000 },
    // 有临期积分，但排在列表最后
    { name: 'expiring.info', usable: true, userId: 'u-exp', expiresAt: NOW + 3 * 86_400_000,
      quota: { packages: [{ remain: 196, monthly: false, expiresAt: wallClock(NOW, 1) }] } },
  ];
  const picked = pickFailoverTarget(accounts, 'u-cur', { now: NOW });
  assert.equal(picked?.name, 'expiring.info',
    '有临期积分时应当优先它，而不是轮转到列表里的下一个');
});
