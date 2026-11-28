/**
 * 共享用量上限规则（`lib/limits.mjs`）—— 控制台与 dsh 插件**同一份实现**。
 *
 * `npm run test:lib`（= `node --test "lib/*.test.mjs"`）会跑它。
 *
 * ## 为什么这些断言值得单独存在
 *
 * 两个前端（控制台网页 / dsh 设置页）读同一份桥数据，但规则一旦各写一遍必然
 * 漂移 —— 用户就会看到「控制台说额度已用尽、面板说没有账号触顶」。所以规则
 * 收进本模块，这里把它逐条钉住：
 *
 *   1. 四条分类（quota / credits / account_restricted / rate_limit）的判定；
 *   2. 空 `resetAt` **不能**抹掉已知恢复时间（桥重启后内存表清空，下一次只带空串）；
 *   3. 恢复时间三层兜底（health 结构化字段 → health 文案 → 失败账本原文）；
 *   4. 过期与 7 天清理；
 *   5. 落盘读回（坏文件不崩、过期不复活）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  collectLimitItems,
  mergeLimitHistory,
  listLimitHistory,
  backfillResetTimes,
  parseResetFromText,
  limitHistoryKey,
  isLimitExpired,
  readLimitHistoryFile,
  writeLimitHistoryFile,
  withinResetRange,
  LIMIT_HISTORY_MAX_AGE_MS,
} from './limits.mjs';

const HOUR = 3_600_000;

test('分类：quotaModels 逐条读，不被单个 quota 顶掉', () => {
  const now = Date.now();
  const { items } = collectLimitItems({
    quotaModels: [
      { model: 'a', kind: 'quota', count: 1, resetAt: new Date(now + 2 * HOUR).toISOString(), lastAt: new Date(now - 1000).toISOString() },
      { model: 'b', kind: 'quota', count: 2, resetAt: new Date(now + 5 * HOUR).toISOString(), lastAt: new Date(now - 2000).toISOString() },
    ],
    // 单个 quota 只留最新那条 —— 面板若只读它就会「只剩一个」（用户原话）
    quota: { model: 'b', count: 3, resetAt: new Date(now + 5 * HOUR).toISOString() },
  }, 'u1', now);
  assert.equal(items.length, 2, '两个模型同时触顶时必须是两条');
  assert.deepEqual(items.map((i) => i.model).sort(), ['a', 'b']);
  assert.equal(items.every((i) => i.kind === 'quota'), true);
  assert.equal(items.every((i) => i.uid === 'u1'), true, '每条都要带账号归属');
});

test('分类：credits 永远不带恢复时间（等不来）', () => {
  const now = Date.now();
  const { items } = collectLimitItems({
    quotaModels: [
      // 上游文案里常混着套餐到期日；即便它塞了 resetAt，也必须被清掉
      { model: 'x', kind: 'credits', count: 1, resetAt: new Date(now + 3 * HOUR).toISOString() },
    ],
  }, 'u1', now);
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'credits');
  assert.equal(items[0].resetAt, '', '积分不足不许带恢复时间，否则界面会出现"还剩 X 小时"');
});

test('分类：老桥没有 kind，但 creditsEmpty>0 且无 resetAt → 按 credits 处理', () => {
  const now = Date.now();
  const { items } = collectLimitItems({
    quota: { model: 'x', count: 1, resetAt: '' },
    creditsEmpty: 1,
  }, 'u1', now);
  assert.equal(items[0].kind, 'credits');
});

test('分类：accountRestricted 单列，且不会被 rate_limit 顶掉', () => {
  const now = Date.now();
  const { items } = collectLimitItems({
    count: 4, model: 'y', lastAt: new Date(now - 60_000).toISOString(),
    accountRestricted: { model: 'y', lastAt: new Date(now - 120_000).toISOString() },
  }, 'u1', now);
  assert.equal(items.length, 1, '有更具体的结论时不再叠一条"429 N 次"');
  assert.equal(items[0].kind, 'account_restricted');
});

test('分类：什么都没有时才把总量限流当 rate_limit 报出来', () => {
  const now = Date.now();
  const { items } = collectLimitItems({ count: 2, model: 'z' }, 'u1', now);
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'rate_limit');
});

test('分类：已过恢复时刻的条目在收集阶段就被丢掉并计数', () => {
  const now = Date.now();
  const { items, expiredCount } = collectLimitItems({
    quotaModels: [
      { model: 'old', kind: 'quota', count: 1, resetAt: new Date(now - 60_000).toISOString() },
      { model: 'live', kind: 'quota', count: 1, resetAt: new Date(now + HOUR).toISOString() },
    ],
  }, 'u1', now);
  assert.equal(items.length, 1);
  assert.equal(items[0].model, 'live');
  assert.equal(expiredCount, 1);
});

test('合并：这一次没带 resetAt，不能抹掉上次已知的恢复时间', () => {
  const now = Date.now();
  const reset = new Date(now + 6 * HOUR).toISOString();
  const map = new Map();
  mergeLimitHistory(map, [{
    uid: 'u1', model: 'm', kind: 'quota', count: 1, resetAt: reset,
    lastAt: new Date(now - 1000).toISOString(),
  }], { nowMs: now });
  const key = limitHistoryKey('u1', 'm', 'quota');
  assert.equal(map.get(key).resetAt, reset);
  assert.equal(map.get(key).resetAtSource, 'upstream');

  // 桥重启后内存表清空：下一次只剩空串
  mergeLimitHistory(map, [{
    uid: 'u1', model: 'm', kind: 'quota', count: 1, resetAt: '',
    lastAt: new Date(now).toISOString(),
  }], { nowMs: now });
  assert.equal(map.get(key).resetAt, reset, '空值不能覆盖已知的恢复时间');
  assert.equal(map.get(key).resetAtSource, 'upstream', '来源也要保留');
});

test('合并：上游给了更晚的时间就更新（可能被延长）', () => {
  const now = Date.now();
  const map = new Map();
  mergeLimitHistory(map, [{ uid: 'u1', model: 'm', kind: 'quota', count: 1, resetAt: new Date(now + HOUR).toISOString() }], { nowMs: now });
  const later = new Date(now + 4 * HOUR).toISOString();
  mergeLimitHistory(map, [{ uid: 'u1', model: 'm', kind: 'quota', count: 1, resetAt: later }], { nowMs: now });
  assert.equal(map.get(limitHistoryKey('u1', 'm', 'quota')).resetAt, later);
});

test('合并：过期条目被清掉；无时间且超过 7 天的也清掉', () => {
  const now = Date.now();
  const map = new Map();
  map.set(limitHistoryKey('u1', 'expired', 'quota'), {
    uid: 'u1', model: 'expired', kind: 'quota', resetAt: new Date(now - HOUR).toISOString(),
  });
  map.set(limitHistoryKey('u1', 'stale', 'rate_limit'), {
    uid: 'u1', model: 'stale', kind: 'rate_limit', resetAt: '',
    seenAt: new Date(now - LIMIT_HISTORY_MAX_AGE_MS - HOUR).toISOString(),
  });
  map.set(limitHistoryKey('u1', 'fresh', 'rate_limit'), {
    uid: 'u1', model: 'fresh', kind: 'rate_limit', resetAt: '',
    seenAt: new Date(now - HOUR).toISOString(),
  });
  const { changed, pruned } = mergeLimitHistory(map, [], { nowMs: now });
  assert.equal(changed, true);
  assert.equal(pruned, 2);
  assert.deepEqual([...map.values()].map((v) => v.model), ['fresh']);
});

test('列表：当前账号排前，其余按最近命中倒序，且不因"不是当前号"而隐藏', () => {
  const now = Date.now();
  const map = new Map();
  const rows = [
    { uid: 'u1', model: 'a', kind: 'quota', lastAt: new Date(now - 3000).toISOString() },
    { uid: 'u2', model: 'b', kind: 'quota', lastAt: new Date(now - 1000).toISOString() },
    { uid: 'u2', model: 'c', kind: 'quota', lastAt: new Date(now - 2000).toISOString() },
  ];
  for (const r of rows) map.set(limitHistoryKey(r.uid, r.model, r.kind), r);
  const out = listLimitHistory(map, { uid: 'u2', nowMs: now });
  assert.equal(out.limiting.length, 3);
  assert.equal(out.limiting[0].isCurrent, true, '当前账号排第一');
  assert.equal(out.limiting[0].model, 'b', '同一账号内按最近命中倒序');
  assert.equal(out.accountCount, 2);
});

test('兜底：health 文案里的时间补到没有时间的条目上，并写回历史', () => {
  const now = Date.now();
  const reset = new Date(now + 3 * HOUR).toISOString();
  const map = new Map();
  const entry = { uid: 'u1', model: 'm', kind: 'quota', count: 1, resetAt: '' };
  map.set(limitHistoryKey('u1', 'm', 'quota'), { ...entry });
  const limiting = [{ ...entry }];
  const { changed } = backfillResetTimes({
    map,
    limiting,
    rateLimit: { quota: { model: 'm', message: `该账号在此模型上已确认不可用（恢复时间 ${reset}），本次请求未发往上游` } },
    nowMs: now,
  });
  assert.equal(changed, true);
  assert.equal(limiting[0].resetAt, reset);
  assert.equal(limiting[0].resetAtSource, 'health-message');
  assert.equal(map.get(limitHistoryKey('u1', 'm', 'quota')).resetAt, reset, '补到的时间要写回历史（否则每轮重捞）');
});

test('兜底：账本里那句真实报错也能补出时间（只按同一个模型补）', () => {
  const now = Date.now();
  const reset = new Date(now + 2 * HOUR).toISOString();
  const map = new Map();
  const a = { uid: 'u1', model: 'same', kind: 'quota', count: 1, resetAt: '' };
  const b = { uid: 'u1', model: 'other', kind: 'quota', count: 1, resetAt: '' };
  map.set(limitHistoryKey('u1', 'same', 'quota'), { ...a });
  map.set(limitHistoryKey('u1', 'other', 'quota'), { ...b });
  const limiting = [{ ...a }, { ...b }];
  backfillResetTimes({
    map,
    limiting,
    requests: [{ ok: false, model: 'same', error: `恢复时间 ${reset}` }],
    nowMs: now,
  });
  assert.equal(limiting[0].resetAt, reset);
  assert.equal(limiting[1].resetAt, '', '别的模型不该被这条报文补上时间');
});

test('兜底：都拿不到时间就保持空（绝不编造）', () => {
  const now = Date.now();
  const map = new Map();
  const it = { uid: 'u1', model: 'm', kind: 'quota', count: 1, resetAt: '' };
  map.set(limitHistoryKey('u1', 'm', 'quota'), { ...it });
  const limiting = [{ ...it }];
  const { changed } = backfillResetTimes({
    map, limiting, rateLimit: { quota: { message: '上游 429，请稍后再试' } }, requests: [], nowMs: now,
  });
  assert.equal(changed, false);
  assert.equal(limiting[0].resetAt, '');
});

test('解析：ISO / 墙钟 / 带偏移都认；过去与超 30 天的不采信', () => {
  const now = Date.parse('2026-11-13T14:47:17.777Z');
  assert.equal(
    parseResetFromText('恢复时间 2026-11-14T11:07:27.000Z', now),
    Date.parse('2026-11-14T11:07:27.000Z'),
  );
  assert.equal(parseResetFromText('恢复时间 2026-11-14 11:07:27', now), new Date(2026, 10, 14, 11, 7, 27).getTime());
  assert.equal(parseResetFromText('reset at 2026-11-14T11:07:27+08:00', now), Date.parse('2026-11-14T03:07:27.000Z'));
  assert.equal(parseResetFromText('上游 429，请稍后再试', now), 0);
  assert.equal(parseResetFromText('2020-01-01T00:00:00Z', now), 0);
  assert.equal(parseResetFromText('2027-06-01T00:00:00Z', now), 0, '超过 30 天不采信');
  assert.equal(withinResetRange(now - 30_000, now), true, '刚过去 30 秒仍采信（时钟抖动余量）');
});

test('落盘：写入后能原样读回（控制台与插件读同一份）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-shared-limits-'));
  const file = join(dir, 'limit-history.json');
  const now = Date.now();
  try {
    const map = new Map();
    map.set(limitHistoryKey('u1', 'm', 'quota'), {
      uid: 'u1', model: 'm', kind: 'quota', count: 2,
      lastAt: new Date(now).toISOString(),
      resetAt: new Date(now + HOUR).toISOString(),
      resetAtSource: 'upstream', accountLabel: '国内版1',
      firstSeenAt: new Date(now).toISOString(), seenAt: new Date(now).toISOString(),
    });
    writeLimitHistoryFile(file, map);
    const back = readLimitHistoryFile(file, now);
    assert.equal(back.size, 1);
    const e = [...back.values()][0];
    assert.equal(e.model, 'm');
    assert.equal(e.accountLabel, '国内版1');
    assert.equal(e.resetAtSource, 'upstream');
    /* 落盘文件是给人看/排障用的，必须有 entries 数组 */
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).entries.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('落盘：坏 JSON 当成"还没有历史"，不抛', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-shared-limits-bad-'));
  const file = join(dir, 'limit-history.json');
  try {
    writeFileSync(file, '{ not json', 'utf8');
    assert.equal(readLimitHistoryFile(file).size, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('落盘：读回时丢掉已过期的条目（关机期间到期的不再复活）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-shared-limits-exp-'));
  const file = join(dir, 'limit-history.json');
  const now = Date.now();
  try {
    writeFileSync(file, JSON.stringify({
      at: new Date(now).toISOString(),
      entries: [
        { uid: 'u1', model: 'old', kind: 'quota', resetAt: new Date(now - HOUR).toISOString() },
        { uid: 'u1', model: 'live', kind: 'quota', resetAt: new Date(now + HOUR).toISOString() },
      ],
    }), 'utf8');
    const back = readLimitHistoryFile(file, now);
    assert.equal(back.size, 1);
    assert.equal([...back.values()][0].model, 'live');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('isLimitExpired：没有时间 / 解析不出 → 不判过期（不凭空判）', () => {
  assert.equal(isLimitExpired({ resetAt: '' }), false);
  assert.equal(isLimitExpired({ resetAt: 'not-a-time' }), false);
  assert.equal(isLimitExpired({ resetAt: new Date(Date.now() - 60_000).toISOString() }), true);
});