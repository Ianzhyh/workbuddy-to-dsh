/**
 * 用量上限（跨账号）与恢复时间 —— **控制台与 dsh 插件共用的一份实现**。
 *
 * ## 为什么必须共用
 *
 * 「哪个账号的哪个模型触顶了」这张表原先只有插件面板有（`dsh-plugin/lib/index.js`
 * 的 `readLimits`），控制台只是间接用过它自己那点 `health.rateLimit`（自动切号）。
 * 两个前端各写一遍的后果是四类规则必然漂移：
 *
 *   1. 分类（`quota` / `credits` / `account_restricted` / `rate_limit`）
 *   2. 历史合并（空 `resetAt` 不能覆盖已知值）
 *   3. 恢复时间三层兜底（health 结构化字段 → health 文案 → 失败账本原文）
 *   4. 过期清理（`resetAt` 到了 / 无时间的最多留 7 天）
 *
 * 任何一处不一致，用户就会看到控制台说「额度已用尽」而面板说「没有账号触顶」。
 * 所以这里把它们做成纯函数 + 一份落盘读写，两边都从这里取。插件侧的
 * `parseResetFromText` / `readLimitHistory` / `writeLimitHistory` 仍然导出（有单测
 * 钉着），只是改成转调本模块。
 *
 * ## 落盘位置
 *
 * `<数据目录>/limit-history.json`（`WORKBUDDY_DATA_DIR`，缺省 `~/.workbuddy-bridge`）
 * —— 控制台与插件**读同一份**。桥的 `rateLimit` 是进程内的，重启即清；这张表是
 * 「别的号是不是用完了」的唯一跨账号、跨重启记录。两个进程都会写，所以写入用
 * 同目录唯一临时文件 + rename（原子），最坏丢掉一次缓存，不会写出半截 JSON。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** 没有恢复时间的条目最多保留多久（上游从此不再提它了）。 */
export const LIMIT_HISTORY_MAX_AGE_MS = 7 * 24 * 3_600_000;

/**
 * 恢复时间只在「还没过去」且「不超过 30 天」时才采信（与桥的判据同一套）。
 * 留 1 分钟余量：时钟抖动不该让一条刚记下的结论立刻作废。
 */
export function withinResetRange(ts, now = Date.now()) {
  if (!Number.isFinite(ts)) return false;
  if (ts <= now - 60_000) return false;
  if (ts > now + 30 * 86_400_000) return false;
  return true;
}

/**
 * 从一句报错原文里解析恢复时刻。
 *
 * 三种写法都出现过（都是真实报文）：
 *   `（恢复时间 2026-11-14T11:07:27.000Z）`   ← 桥自己拼的 ISO
 *   `恢复时间 2026-11-14 11:07:27`            ← 上游给的墙钟
 *   `2026-11-14T11:07:27+08:00`               ← 带偏移
 *
 * 桥的 `parseResetWallClock` 只认「带秒的日期时间 + 可选 UTC 偏移」，遇到纯 ISO
 * 的 `…Z` 会按区域猜偏移（对 `Z` 会算错），所以面板侧必须自己实现一份：
 * **只认明确写出来的偏移**；没有偏移就按本机时区理解（面板与桥同机）。
 *
 * 解析不出或明显超范围返回 0 —— 不编造。
 */
export function parseResetFromText(text, now = Date.now()) {
  const raw = String(text || '');
  if (!raw) return 0;
  const iso = raw.match(
    /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:?\d{2}))/,
  );
  if (iso) {
    const ts = Date.parse(iso[1]);
    if (Number.isFinite(ts)) return withinResetRange(ts, now) ? ts : 0;
  }
  const wall = raw.match(/(\d{4})[-/](\d{2})[-/](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (wall) {
    const [, y, mo, d, h, mi, s] = wall;
    const ts = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)).getTime();
    if (Number.isFinite(ts)) return withinResetRange(ts, now) ? ts : 0;
  }
  return 0;
}

/** 历史表的键：同一账号同一模型可能既限额又被风控，所以 kind 也要进键。 */
export function limitHistoryKey(uid, model, kind) {
  return `${uid}\u0000${model}\u0000${kind}`;
}

/** 条目是否已过上游承诺的恢复时刻（解析不出 → 不判过期，绝不凭空判）。 */
export function isLimitExpired(entry, nowMs = Date.now()) {
  const resetAt = typeof entry?.resetAt === 'string' ? entry.resetAt : '';
  if (!resetAt) return false;
  const ts = Date.parse(resetAt);
  if (!Number.isFinite(ts)) return false;
  return ts <= nowMs;
}

/**
 * 把桥 `/health.rateLimit` 拆成**逐条**条目。
 *
 * 四种分类（处置方式完全不同，不能合并）：
 *   - `quota`              账号级额度上限（6004 / 14018）→ 换模型或换号；
 *   - `credits`            积分/余额不足（14018 / 402）→ 充钱或换号，**等不来**；
 *   - `account_restricted` 账号被风控（11140）→ 换号（重登无效）；
 *   - `rate_limit`         瞬时限流（14003 / 429）→ 稍等再试。
 *
 * `quotaModels` 优先（每条一条 —— 桥的 `quota` 只保留最新一条，多个模型同时触顶
 * 时面板会只剩一个，用户原话："我用别的不是 workbuddy 的用量上限怎么又只剩一个了"）；
 * 老桥没有该字段时回落到单个 `quota`。总量限流只在**没有更具体的结论**时才展示：
 * `quota` 已经把"哪个模型满了"说清楚了，再叠一条「429 N 次」只是同一件事的噪音。
 *
 * @param {any} rateLimit 桥 `/health.rateLimit`
 * @param {string} uid 桥当前登录账号
 * @returns {{ items: Array<object>, expiredCount: number }}
 */
export function collectLimitItems(rateLimit, uid = '', nowMs = Date.now()) {
  const rl = rateLimit && typeof rateLimit === 'object' ? rateLimit : {};
  const items = [];
  let expiredCount = 0;
  /**
   * @param {any} raw 桥给的条目
   * @param {string} kind 分类
   * @param {boolean} [countOptional] 允许缺 `count`
   *
   * **`account_restricted` 必须允许缺 count**：桥侧的 `latestTimed()` 只回
   * `{ model, lastAt, resetAt }` —— 它本来就不带次数（风控是"状态"不是"计数"）。
   * 旧实现一律要求 `count >= 1`，于是风控条目被静默丢掉，只有在没有任何更具体
   * 结论时才被总量限流顶上来 —— 用户看到的会是「触发了限流」（稍等再试），
   * 而真相是「账号被风控」（重登无效、必须换号）。处置方式完全不同。
   */
  const push = (raw, kind, countOptional = false) => {
    if (!raw || typeof raw !== 'object') return;
    const parsed = Number(raw.count);
    const count = Number.isFinite(parsed) && parsed >= 1 ? parsed : (countOptional ? 1 : 0);
    if (count < 1) return;
    if (isLimitExpired(raw, nowMs)) { expiredCount += 1; return; }
    items.push({
      kind,
      model: typeof raw.model === 'string' ? raw.model : '',
      count,
      lastAt: typeof raw.lastAt === 'string' ? raw.lastAt : '',
      /*
       * 积分不足（`credits`）**永远不带恢复时间**：它没有"到点自己好"这回事，
       * 而文案里常混着套餐到期日 —— 一旦被当成 resetAt，界面就会出现
       * 「积分不足但还剩 X 小时」（用户直接指出来的）。这里显式清空。
       */
      resetAt: kind === 'credits' ? '' : (typeof raw.resetAt === 'string' ? raw.resetAt : ''),
      uid,
    });
  };
  const quotaList = Array.isArray(rl.quotaModels) && rl.quotaModels.length
    ? rl.quotaModels
    : [rl.quota];
  for (const q of quotaList) {
    if (!q || typeof q !== 'object') continue;
    const creditsHint = q.kind === 'credits'
      || (q.kind === undefined && Number(rl.creditsEmpty) > 0 && !q.resetAt);
    push(q, creditsHint ? 'credits' : 'quota');
  }
  push(rl.accountRestricted, 'account_restricted', true);
  if (!items.length) push(rl, 'rate_limit');
  return { items, expiredCount };
}

/**
 * 把本次条目并进历史表（**原地改动** `map`）。
 *
 * ⚠️ 不能简单 `{...prev, ...next}`：桥重启后内存表清空，下一次只带
 * `resetAt: ''`，那样写会把已经知道的恢复时间**抹掉**，界面立刻退回
 * 「上游未给恢复时间」。只在新值非空时覆盖 —— 这条有单测钉着
 * （`dsh-plugin/tests/reset-time.test.mjs`）。
 *
 * 同时清掉两类陈旧条目：已过恢复时刻的、以及上游从没给过时间且超过 7 天的
 * （否则这张卡会永远挂着一次早就不存在的上限）。
 *
 * @returns {{ changed: boolean, pruned: number }}
 */
export function mergeLimitHistory(map, items, {
  at = new Date().toISOString(), nowMs = Date.now(), labelOf = /** @type {(uid: string) => string} */ (() => ''),
} = {}) {
  let changed = false;
  let pruned = 0;
  for (const it of Array.isArray(items) ? items : []) {
    if (!it || typeof it !== 'object') continue;
    const key = limitHistoryKey(it.uid, it.model, it.kind);
    const prev = map.get(key);
    changed = true;
    map.set(key, {
      ...prev,
      ...it,
      resetAt: it.resetAt || prev?.resetAt || '',
      resetAtSource: it.resetAt ? 'upstream' : (prev?.resetAtSource || ''),
      accountLabel: labelOf(it.uid) || prev?.accountLabel || '',
      firstSeenAt: prev?.firstSeenAt || at,
      seenAt: at,
    });
  }
  for (const [key, it] of map) {
    if (isLimitExpired(it, nowMs)) { map.delete(key); changed = true; pruned += 1; continue; }
    const seen = Date.parse(it?.seenAt || it?.lastAt || 0);
    if (Number.isFinite(seen) && nowMs - seen > LIMIT_HISTORY_MAX_AGE_MS) {
      map.delete(key);
      changed = true;
      pruned += 1;
    }
  }
  return { changed, pruned };
}

/**
 * 历史表 → 界面需要的列表。
 *
 * 条目不因为"当前不是这个账号"而隐藏 —— `isCurrent` 只用来打标记；排序把
 * 当前账号排前面（用户最先关心"我正在用的这个"），其余按最近命中倒序。
 */
export function listLimitHistory(map, {
  uid = '', labelOf = /** @type {(uid: string) => string} */ (() => ''), nowMs = Date.now(),
} = {}) {
  const limiting = [];
  const seen = new Set();
  let expiredCount = 0;
  for (const it of map.values()) {
    if (isLimitExpired(it, nowMs)) { expiredCount += 1; continue; }
    const key = limitHistoryKey(it.uid, it.model, it.kind);
    if (seen.has(key)) continue;
    seen.add(key);
    limiting.push({
      ...it,
      accountLabel: it.accountLabel || labelOf(it.uid) || '',
      isCurrent: Boolean(uid && it.uid === uid),
    });
  }
  limiting.sort((a, b) => Number(b.isCurrent) - Number(a.isCurrent)
    || String(b.lastAt || '').localeCompare(String(a.lastAt || '')));
  return {
    limiting,
    expiredCount,
    accountCount: new Set(limiting.map((it) => it.uid)).size,
  };
}

/**
 * 恢复时间兜底：三处一起找，**只补空着的**，都拿不到就保持空（绝不编造）。
 *
 *   1. 桥 health 里 `quota` / `accountRestricted` 自带的 `resetAt`（收集时已进条目）；
 *   2. health 里这两块的 `message` 文本（有时只有文字、没有结构化字段）；
 *   3. 失败账本里每条 error 原文（客户端收到的那句里就有时间）。
 *
 * 补到的结果**写回历史**：否则每轮都要重新捞一遍，且桥重启清空内存表后又退回
 * 「未给」。
 *
 * @param {object} deps
 * @param {Map<string, any>} deps.map 历史表（会被原地改动）
 * @param {any[]} deps.limiting 要补时间的条目（会被原地改动）
 * @param {any} [deps.rateLimit] 桥 `/health.rateLimit`
 * @param {any[]} [deps.requests] 失败账本明细
 * @param {number} [deps.nowMs]
 * @returns {{ changed: boolean }}
 */
export function backfillResetTimes(deps = /** @type {any} */ ({})) {
  const {
    map, limiting, rateLimit = {}, requests = [], nowMs = Date.now(),
  } = deps;
  const list = Array.isArray(limiting) ? limiting : [];
  if (!list.some((it) => !it.resetAt)) return { changed: false };
  let changed = false;
  const setTime = (it, ts, source) => {
    it.resetAt = new Date(ts).toISOString();
    it.resetAtSource = source;
  };
  for (const raw of [rateLimit.quota, rateLimit.accountRestricted]) {
    if (!raw || typeof raw !== 'object') continue;
    const ts = parseResetFromText(String(raw.message || raw.msg || ''), nowMs);
    if (!ts) continue;
    for (const it of list) {
      if (it.resetAt) continue;
      if (it.model && raw.model && it.model !== raw.model) continue;
      setTime(it, ts, 'health-message');
    }
  }
  for (const row of Array.isArray(requests) ? requests : []) {
    if (!row || row.ok) continue;
    const raw = String(row.error || '');
    if (!raw) continue;
    const ts = parseResetFromText(raw, nowMs);
    if (!ts) continue;
    for (const it of list) {
      if (it.resetAt) continue;
      if (it.model && row.model && it.model !== row.model) continue;
      setTime(it, ts, 'ledger');
    }
  }
  for (const it of list) {
    if (!it.resetAt) continue;
    const key = limitHistoryKey(it.uid, it.model, it.kind);
    const prev = map.get(key);
    if (!prev) continue;
    if (!prev.resetAt) {
      map.set(key, { ...prev, resetAt: it.resetAt, resetAtSource: it.resetAtSource || 'ledger' });
      changed = true;
    }
  }
  return { changed };
}

/** 同目录临时文件名：每个写者唯一，避免互相搬走对方的中转文件。 */
let tmpSeq = 0;

/**
 * 读历史表（容忍一切异常：文件不存在、坏 JSON、权限不对 —— 都当成"还没有历史"）。
 * 一个缓存文件不该让控制台/插件起不来。读到时就丢掉已经过期的条目。
 */
export function readLimitHistoryFile(file, nowMs = Date.now()) {
  const map = new Map();
  try {
    if (!file || !existsSync(file)) return map;
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    const list = Array.isArray(parsed?.entries) ? parsed.entries : [];
    for (const raw of list) {
      if (!raw || typeof raw !== 'object') continue;
      const uid = String(raw.uid || '');
      const model = String(raw.model || '');
      const kind = String(raw.kind || '');
      if (!kind) continue;
      if (isLimitExpired(raw, nowMs)) continue;
      map.set(limitHistoryKey(uid, model, kind), {
        uid,
        model,
        kind,
        count: Number(raw.count) || 1,
        lastAt: typeof raw.lastAt === 'string' ? raw.lastAt : '',
        resetAt: typeof raw.resetAt === 'string' ? raw.resetAt : '',
        resetAtSource: typeof raw.resetAtSource === 'string' ? raw.resetAtSource : '',
        accountLabel: typeof raw.accountLabel === 'string' ? raw.accountLabel : '',
        firstSeenAt: typeof raw.firstSeenAt === 'string' ? raw.firstSeenAt : '',
        seenAt: typeof raw.seenAt === 'string' ? raw.seenAt : '',
      });
    }
  } catch { /* 坏文件 → 空表（下次写会重建） */ }
  return map;
}

/**
 * 写历史表。
 *
 * 调用方应**先读**（`readLimitHistoryFile`）、在它上面合并、再写 —— 这样两个进程
 * 交替写时不会把对方刚加的条目整份覆盖掉。写失败静默：这只是缓存。
 */
export function writeLimitHistoryFile(file, map) {
  try {
    if (!file) return;
    const dir = dirname(file);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const entries = [...(map instanceof Map ? map.values() : [])];
    const tmp = `${file}.${process.pid}-${(tmpSeq += 1)}-${Math.random().toString(36).slice(2, 8)}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ at: new Date().toISOString(), entries }, null, 1)}\n`, 'utf8');
    renameSync(tmp, file);
  } catch { /* 缓存写失败：静默 */ }
}