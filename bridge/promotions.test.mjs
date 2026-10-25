import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyPromotion,
  groupPromotions,
  isPromotionActive,
  minutesInTimeZone,
  normalizePromotion,
  parseClockMinutes,
  promotionFactor,
  selectPromotion,
} from './promotions.mjs';

const at = (iso) => new Date(iso);
const rule = (over = {}) => normalizePromotion({
  enabled: true,
  badge: { label: '夜间免费', color: '#1E90FF' },
  discount: { factor: 0, discountedCredits: '0x' },
  schedule: {
    daily: [{ start: '23:00', end: '08:00' }],
    timezone: 'Asia/Shanghai',
    validUntil: '2026-11-01T00:00:00+08:00',
  },
  hover: { textZh: '每晚 23:00—次日 8:00 享免费额度', textEn: 'Free every night 23:00–08:00' },
  ...over,
});

test('时间解析：HH:MM / 个位小时 / 24:00，非法值拒绝', () => {
  assert.equal(parseClockMinutes('23:00'), 23 * 60);
  assert.equal(parseClockMinutes('7:50'), 7 * 60 + 50);
  assert.equal(parseClockMinutes('24:00'), 24 * 60);
  assert.equal(parseClockMinutes('24:01'), null);
  assert.equal(parseClockMinutes('7:5'), null);
  assert.equal(parseClockMinutes('abc'), null);
});

test('时区分钟数：Asia/Shanghai 与 UTC 的同一时刻不同', () => {
  const now = at('2026-10-25T15:30:00Z'); // 上海 23:30
  assert.equal(minutesInTimeZone(now, 'Asia/Shanghai'), 23 * 60 + 30);
  assert.equal(minutesInTimeZone(now, 'UTC'), 15 * 60 + 30);
});

test('夜间免费：23:00 开始、08:00 结束，跨午夜正确', () => {
  const hy4 = rule();
  assert.equal(isPromotionActive(hy4, at('2026-10-25T22:59:00+08:00')), false);
  assert.equal(isPromotionActive(hy4, at('2026-10-25T23:00:00+08:00')), true);
  assert.equal(isPromotionActive(hy4, at('2026-10-26T02:00:00+08:00')), true);
  assert.equal(isPromotionActive(hy4, at('2026-10-26T07:59:00+08:00')), true);
  assert.equal(isPromotionActive(hy4, at('2026-10-26T08:00:00+08:00')), false);
});

test('validUntil 是绝对边界：10/31 夜间仍生效，11/1 00:00 结束', () => {
  const hy4 = rule();
  assert.equal(isPromotionActive(hy4, at('2026-10-31T23:30:00+08:00')), true);
  assert.equal(isPromotionActive(hy4, at('2026-11-01T00:00:00+08:00')), false);
});

test('只有日期范围的活动：hy3 当前生效，step-5 今天 0 点已过期', () => {
  const hy3 = normalizePromotion({
    enabled: true,
    badge: { label: '限时免费', color: '#FF0000', display: 'activeOnly' },
    discount: { factor: 0 },
    schedule: { timezone: 'Asia/Shanghai', validFrom: '2026-07-06T00:00:00+08:00', validUntil: '2026-11-01T00:00:00+08:00' },
  });
  const step5 = normalizePromotion({
    enabled: true,
    badge: { label: '独家限免', color: '#009273', display: 'activeOnly' },
    discount: { factor: 0 },
    schedule: { timezone: 'Asia/Shanghai', validFrom: '2026-10-12T00:00:00+08:00', validUntil: '2026-10-25T00:00:00+08:00' },
  });
  const now = at('2026-10-25T10:00:00+08:00');
  assert.equal(isPromotionActive(hy3, now), true);
  assert.equal(isPromotionActive(step5, now), false);
});

test('夜间折扣：白天原价、23:00–7:50 五折，多个规则按时段选', () => {
  const night = normalizePromotion({
    enabled: true,
    badge: { label: '夜间折扣', color: '#1E90FF' },
    discount: { factor: 0.5, discountedCredits: '0.50x' },
    schedule: { daily: [{ start: '23:00', end: '7:50' }], timezone: 'Asia/Shanghai' },
  });
  const day = normalizePromotion({
    enabled: true,
    badge: { label: '夜间折扣', color: '#1E90FF' },
    schedule: { daily: [{ start: '7:50', end: '23:00' }], timezone: 'Asia/Shanghai' },
  });
  const rules = [day, night];
  const base = 0.79;

  const daytime = applyPromotion({ baseCredits: base, promotions: rules, now: at('2026-10-25T10:00:00+08:00') });
  assert.equal(daytime.credits, 0.79);
  assert.equal(daytime.free, false);
  assert.equal(daytime.badge, '夜间折扣');
  assert.equal(daytime.promotionActive, false, '白天不标“进行中”');

  const nightTime = applyPromotion({ baseCredits: base, promotions: rules, now: at('2026-10-25T23:30:00+08:00') });
  assert.equal(nightTime.credits, 0.395);
  assert.equal(nightTime.free, false);
  assert.equal(nightTime.badge, '夜间折扣');
  assert.equal(nightTime.promotionActive, true);
  assert.equal(nightTime.promotionFactor, 0.5);
});

test('夜间免费：到点倍率 0 / free，白天回原价但保留活动名', () => {
  const rules = [rule()];
  const night = applyPromotion({ baseCredits: 0.29, promotions: rules, now: at('2026-10-25T23:30:00+08:00') });
  assert.equal(night.credits, 0);
  assert.equal(night.free, true);
  assert.equal(night.badge, '夜间免费');
  assert.equal(night.promotionActive, true);
  assert.match(night.promotionText, /23:00/);
  assert.equal(night.promotionUntil, '2026-11-01T00:00:00+08:00');

  const day = applyPromotion({ baseCredits: 0.29, promotions: rules, now: at('2026-10-25T10:00:00+08:00') });
  assert.equal(day.credits, 0.29);
  assert.equal(day.free, false);
  assert.equal(day.badge, '夜间免费', '长期活动名在白天保留');
  assert.equal(day.promotionActive, false);
});

test('过期且 activeOnly 的活动：徽章与 free 都消失', () => {
  const step5 = normalizePromotion({
    enabled: true,
    badge: { label: '独家限免', color: '#009273', display: 'activeOnly' },
    discount: { factor: 0 },
    schedule: { timezone: 'Asia/Shanghai', validFrom: '2026-10-12T00:00:00+08:00', validUntil: '2026-10-25T00:00:00+08:00' },
  });
  const now = at('2026-10-25T10:00:00+08:00');
  const result = applyPromotion({ baseCredits: 0.43, promotions: [step5], now });
  assert.equal(result.credits, 0.43);
  assert.equal(result.free, false);
  assert.equal(result.badge, null);
  assert.equal(result.promotionActive, false);
});

test('无折扣的“错峰使用”按时段展示徽章，但不改倍率', () => {
  const peak = normalizePromotion({
    enabled: true,
    badge: { label: '错峰使用', color: '#1E90FF', display: 'activeOnly' },
    schedule: { daily: [{ start: '00:00', end: '23:59' }], timezone: 'Asia/Shanghai' },
    hover: { textZh: '高峰期原价，非高峰期积分5折' },
  });
  const result = applyPromotion({ baseCredits: 0.11, promotions: [peak], now: at('2026-10-25T10:00:00+08:00') });
  assert.equal(result.credits, 0.11);
  assert.equal(result.badge, '错峰使用');
  assert.equal(result.promotionActive, false);
});

test('折扣解析与分组：0x / 0.50x / factor，同模型多规则', () => {
  assert.equal(promotionFactor({ factor: 0 }), 0);
  assert.equal(promotionFactor({ discountedCredits: '0x' }), 0);
  assert.equal(promotionFactor({ discountedCredits: '0.50x' }), 0.5);
  assert.equal(promotionFactor({}), null);

  const grouped = groupPromotions([
    { enabled: true, modelIds: ['m1', 'm2'], badge: { label: '限时免费' }, discount: { factor: 0 } },
    { enabled: false, modelIds: ['m1'], badge: { label: '已关闭' } },
    { enabled: true, modelIds: ['m1'], badge: { label: '夜间折扣' }, discount: { factor: 0.5 } },
  ]);
  assert.equal(grouped.get('m1').length, 2);
  assert.equal(grouped.get('m2').length, 1);
});

test('选择规则：免费优先于折扣，生效折扣优先于仅展示的规则', () => {
  const free = rule();
  const discount = normalizePromotion({
    enabled: true,
    badge: { label: '五折' },
    discount: { factor: 0.5 },
    schedule: { daily: [{ start: '00:00', end: '23:59' }], timezone: 'Asia/Shanghai' },
  });
  const chosen = selectPromotion([discount, free], at('2026-10-25T23:30:00+08:00'));
  assert.equal(chosen.discounted, true);
  assert.equal(chosen.rule.label, '夜间免费');
  assert.equal(chosen.rule.factor, 0);
});

test('未知时区/坏 schedule 不炸：退回不看 daily 的安全路径', () => {
  const broken = normalizePromotion({
    enabled: true,
    badge: { label: '测试' },
    discount: { factor: 0 },
    schedule: { daily: [{ start: 'bad', end: 'worse' }], timezone: 'Not/AZone' },
  });
  const result = applyPromotion({ baseCredits: 1, promotions: [broken], now: new Date() });
  assert.equal(result.credits, 1, '坏窗口不能误判为免费');
  assert.equal(result.free, false);
});
