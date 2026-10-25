/**
 * WorkBuddy 模型促销（夜间免费 / 夜间折扣 / 限时活动）的时间窗评估。
 *
 * 上游 `/v3/config` 的 `modelPromotions` 只给“活动规则”，不会替客户端算
 * “现在生不生效”：
 *   {
 *     modelIds: ['hy4-preview'],
 *     badge: { label: '夜间免费', color: '#1E90FF' },
 *     discount: { factor: 0, discountedCredits: '0x' },
 *     schedule: {
 *       daily: [{ start: '23:00', end: '08:00' }],
 *       timezone: 'Asia/Shanghai',
 *       validUntil: '2026-11-01T00:00:00+08:00'
 *     },
 *     hover: { textZh: '每晚 23:00—次日 8:00 享免费额度' }
 *   }
 *
 * 旧实现只看 `discount.factor`，于是：
 *   - 夜间免费模型整天显示“免费”（即使现在是白天）；
 *   - 夜间折扣永远显示原价；
 *   - 已过期活动（step-5-preview / space-bunny）仍挂着“限免”徽章。
 *
 * 这个模块是纯函数，桥与测试共用，不读时钟以外的任何外部状态。
 */

const DEFAULT_TIMEZONE = 'Asia/Shanghai';

/** `"23:00"` / `"7:50"` / `"24:00"` → 当天分钟数；非法返回 null。 */
export function parseClockMinutes(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours === 24 && minutes === 0) return 1440;
  if (!Number.isInteger(hours) || hours < 0 || hours > 23) return null;
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/** 某一时刻在指定时区的“当天分钟数”（0–1439）；时区非法时退回本机时区。 */
export function minutesInTimeZone(date, timeZone) {
  const at = date instanceof Date ? date : new Date(date);
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timeZone || DEFAULT_TIMEZONE,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(at);
    const hours = Number(parts.find((part) => part.type === 'hour')?.value);
    const minutes = Number(parts.find((part) => part.type === 'minute')?.value);
    if (Number.isInteger(hours) && Number.isInteger(minutes)) {
      return (hours % 24) * 60 + minutes;
    }
  } catch { /* 非法时区：退回本机时间 */ }
  return at.getHours() * 60 + at.getMinutes();
}

function parseTime(value) {
  if (typeof value !== 'string' || value === '') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * 活动当前是否在时间窗内。
 *
 * 规则：
 *   - 没有 schedule = 不限制（兼容老数据）；
 *   - validFrom / validUntil 是绝对时间边界（含时区偏移）；
 *   - daily 按 schedule.timezone 的本地时间判断，支持跨午夜（23:00–08:00）；
 *   - 同时有日期范围和每日时段时，两者都要满足。
 */
export function isPromotionActive(promotion, now = new Date()) {
  if (!promotion || typeof promotion !== 'object' || promotion.enabled === false) return false;
  const at = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (!Number.isFinite(at)) return false;

  const schedule = promotion.schedule;
  if (!schedule || typeof schedule !== 'object') return true;

  const validFrom = parseTime(schedule.validFrom);
  const validUntil = parseTime(schedule.validUntil);
  if (validFrom !== null && at < validFrom) return false;
  if (validUntil !== null && at >= validUntil) return false;

  const daily = Array.isArray(schedule.daily) ? schedule.daily : [];
  if (!daily.length) return true;

  const minutes = minutesInTimeZone(new Date(at), schedule.timezone || DEFAULT_TIMEZONE);
  for (const window of daily) {
    const start = parseClockMinutes(window?.start);
    const end = parseClockMinutes(window?.end);
    if (start === null || end === null) continue;
    // 00:00–00:00 视为全天；其余相等窗口没有可服务的时间（继续看下一条）。
    if (start === end) {
      if (start === 0 && end === 0) return true;
      continue;
    }
    if (start < end) {
      if (minutes >= start && minutes < end) return true;
    } else if (minutes >= start || minutes < end) {
      return true;
    }
  }
  return false;
}

/** 折扣因子：`{factor:0.5}` 或 `{discountedCredits:'0.50x'}` → 0.5；没有折扣 → null。 */
export function promotionFactor(discount) {
  if (!discount || typeof discount !== 'object') return null;
  const direct = Number(discount.factor);
  if (Number.isFinite(direct) && direct >= 0) return direct;
  const text = String(discount.discountedCredits || '').trim().toLowerCase();
  const match = /^([0-9]*\.?[0-9]+)x$/.exec(text);
  if (match) {
    const value = Number(match[1]);
    if (Number.isFinite(value) && value >= 0) return value;
  }
  return null;
}

/**
 * 上游促销对象 → 内部规则。
 *
 * `activeOnly` 来自 `badge.display === 'activeOnly'`：这种徽章只在活动生效时
 * 展示（限时免费 / 限时折扣），过期后必须隐藏；夜间免费 / 夜间折扣没有这个
 * 标记，是长期展示的活动名。
 */
export function normalizePromotion(raw) {
  if (!raw || typeof raw !== 'object' || raw.enabled === false) return null;

  const badge = raw.badge;
  let label = '';
  let color = null;
  let activeOnly = false;
  if (badge && typeof badge === 'object') {
    label = String(badge.label || badge.text || badge.name || badge.value || '').trim();
    color = typeof badge.color === 'string' && badge.color ? badge.color : null;
    activeOnly = badge.display === 'activeOnly';
  } else if (typeof badge === 'string') {
    label = badge.trim();
  }

  const factor = promotionFactor(raw.discount);
  // 兼容旧形状：discount 直接是折扣百分比数字时，只用于生成文案。
  if (!label && typeof raw.discount === 'number' && raw.discount > 0) {
    label = `-${raw.discount}%`;
  }
  if (!label && factor === null) return null;

  const hover = raw.hover;
  const textZh = typeof hover === 'string'
    ? hover
    : (hover && typeof hover === 'object' && typeof hover.textZh === 'string' ? hover.textZh : '');
  const textEn = hover && typeof hover === 'object' && typeof hover.textEn === 'string' ? hover.textEn : '';

  return {
    label,
    color,
    activeOnly,
    factor,
    priority: Number(raw.priority) || 0,
    schedule: raw.schedule && typeof raw.schedule === 'object' ? raw.schedule : null,
    textZh,
    textEn,
  };
}

/** 上游 `modelPromotions` 数组 → `Map<modelId, rule[]>`（同一模型可有多个时段规则）。 */
export function groupPromotions(rawPromotions) {
  const byModel = new Map();
  for (const raw of Array.isArray(rawPromotions) ? rawPromotions : []) {
    const rule = normalizePromotion(raw);
    if (!rule) continue;
    for (const modelId of Array.isArray(raw?.modelIds) ? raw.modelIds : []) {
      if (typeof modelId !== 'string' || !modelId) continue;
      const list = byModel.get(modelId) || [];
      list.push(rule);
      byModel.set(modelId, list);
    }
  }
  return byModel;
}

/**
 * 选一条规则用于展示。
 *
 * 优先级：
 *   1. 正在生效的折扣（factor < 1）里选折扣最低的（免费优先）；
 *   2. 正在生效但无折扣的规则（如“错峰使用”），只用于显示徽章；
 *   3. 未生效但非 activeOnly 的规则（如白天的“夜间免费”），保留活动名；
 *   4. 其余（过期且 activeOnly）不展示。
 *
 * `active` 只代表“折扣正在生效”，不代表“促销名正在展示”：夜间折扣在白天
 * 仍会显示活动名，但倍率按原价。
 */
export function selectPromotion(promotions, now = new Date()) {
  const rules = Array.isArray(promotions) ? promotions.filter(Boolean) : [];
  const active = rules.filter((rule) => isPromotionActive(rule, now));
  const discounts = active
    .filter((rule) => Number.isFinite(rule.factor) && rule.factor < 1)
    .sort((a, b) => (a.factor - b.factor) || (b.priority - a.priority));
  if (discounts.length) return { rule: discounts[0], active: true, discounted: true };

  const scheduled = [...active].sort((a, b) => b.priority - a.priority)[0];
  if (scheduled) return { rule: scheduled, active: true, discounted: false };

  const marketing = rules
    .filter((rule) => rule.label && !rule.activeOnly)
    .sort((a, b) => b.priority - a.priority)[0];
  if (marketing) return { rule: marketing, active: false, discounted: false };

  return { rule: null, active: false, discounted: false };
}

/**
 * 计算某模型当前对外展示的倍率 / 免费状态 / 活动信息。
 *
 * @param {object} [deps]
 * @param {number|undefined} [deps.baseCredits] 上游基础倍率
 * @param {object[]} [deps.promotions] 该模型的促销规则
 * @param {Date} [deps.now] 用于测试的时钟
 * @returns {{
 *   credits: number|undefined, free: boolean, badge: string|null, badgeColor: string|null,
 *   promotionActive: boolean, promotionText: string, promotionTextEn: string,
 *   promotionUntil: string, promotionFactor: number|null
 * }}
 */
export function applyPromotion({ baseCredits, promotions, now = new Date() } = {}) {
  const base = Number.isFinite(Number(baseCredits)) ? Number(baseCredits) : undefined;
  const selection = selectPromotion(promotions, now);
  const rule = selection.rule;

  let credits = base;
  if (selection.discounted && Number.isFinite(rule?.factor)) {
    credits = base === undefined ? undefined : Math.round(base * rule.factor * 1000) / 1000;
  }
  const free = (selection.discounted && rule?.factor === 0) || credits === 0;

  return {
    credits,
    free,
    badge: rule?.label || null,
    badgeColor: rule?.color || null,
    promotionActive: selection.discounted,
    promotionText: rule?.textZh || '',
    promotionTextEn: rule?.textEn || '',
    promotionUntil: typeof rule?.schedule?.validUntil === 'string' ? rule.schedule.validUntil : '',
    promotionFactor: selection.discounted ? rule.factor : null,
  };
}
