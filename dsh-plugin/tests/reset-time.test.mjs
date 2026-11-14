import assert from 'node:assert/strict';
import test from 'node:test';

import { parseResetFromText } from '../lib/index.js';

/**
 * 恢复时间解析。
 *
 * 这些用例来自**真实报错原文**（用户截图里的那条）：桥明明写出了
 * `恢复时间 2026-11-14T11:07:27.000Z`，面板却显示"上游未给恢复时间"。
 * 根因有两层，这里钉的是第二层：
 *   1. 桥只在**当前账号**的 `/health.rateLimit` 里带 resetAt，跨账号查不到；
 *   2. 即使拿到原文，桥的 `parseResetWallClock` 不认纯 ISO 的 `…Z`，
 *      面板侧必须自己解析（本文件的被测函数）。
 */
const NOW = Date.parse('2026-11-13T14:47:17.777Z');

test('恢复时间：桥拼出的 ISO（带 Z）必须能解析', () => {
  /* 这就是截图里那句报错，一个字都没改 */
  const text = '该账号在此模型上已确认不可用（恢复时间 2026-11-14T11:07:27.000Z），本次请求未发往上游';
  const ts = parseResetFromText(text, NOW);
  assert.equal(ts, Date.parse('2026-11-14T11:07:27.000Z'));
});

test('恢复时间：上游给的墙钟（无时区）按本机时区理解', () => {
  const ts = parseResetFromText('恢复时间 2026-11-14 11:07:27', NOW);
  /* 按本地时区解析 —— 不写成 UTC，否则东八区会差 8 小时 */
  assert.equal(ts, new Date(2026, 10, 14, 11, 7, 27).getTime());
});

test('恢复时间：带偏移的 ISO 按偏移换算', () => {
  const ts = parseResetFromText('reset at 2026-11-14T11:07:27+08:00', NOW);
  assert.equal(ts, Date.parse('2026-11-14T03:07:27.000Z'));
});

test('恢复时间：没有时间的报文一律返回 0（不编造）', () => {
  assert.equal(parseResetFromText('上游 429，请稍后再试', NOW), 0);
  assert.equal(parseResetFromText('', NOW), 0);
  assert.equal(parseResetFromText(null, NOW), 0);
});

test('恢复时间：已经过去 / 超出 30 天的都不采信', () => {
  assert.equal(parseResetFromText('2020-01-01T00:00:00Z', NOW), 0, '已过去');
  assert.equal(parseResetFromText('2027-06-01T00:00:00Z', NOW), 0, '超过 30 天');
});

test('恢复时间：刚过去 1 分钟内的仍采信（时钟抖动余量）', () => {
  const slightlyPast = new Date(NOW - 30_000).toISOString();
  assert.ok(parseResetFromText(slightlyPast, NOW) > 0);
});

/**
 * 历史条目**不能被空 resetAt 覆盖**。
 *
 * 这是真实踩到的坑：桥重启后内存表清空，下一次 `rateLimit` 只带 `resetAt: ''`；
 * 如果合并时简单写 `{...prev, ...next}`，那条已经知道的恢复时间就被抹掉，
 * 界面立刻退回"上游未给恢复时间" —— 用户看到的就是"这不是有时间吗"。
 *
 * 这里复刻合并规则的**唯一判据**：新值非空才覆盖。
 */
const mergeHistoryEntry = (prev, next) => ({
  ...prev,
  ...next,
  resetAt: next.resetAt || prev?.resetAt || '',
  resetAtSource: next.resetAt ? 'upstream' : (prev?.resetAtSource || ''),
});

test('历史合并：上游这次没给时间，不能抹掉上次已知的恢复时间', () => {
  const prev = {
    uid: 'u1', model: 'deepseek-v4.1-flash', kind: 'quota',
    resetAt: '2026-11-14T11:07:27.000Z', resetAtSource: 'upstream',
  };
  const merged = mergeHistoryEntry(prev, {
    uid: 'u1', model: 'deepseek-v4.1-flash', kind: 'quota', resetAt: '',
  });
  assert.equal(merged.resetAt, '2026-11-14T11:07:27.000Z', '空值不能覆盖');
  assert.equal(merged.resetAtSource, 'upstream', '来源也要保留');
});

test('历史合并：上游给了新时间就更新（可能被延长）', () => {
  const prev = {
    uid: 'u1', model: 'm', kind: 'quota', resetAt: '2026-11-14T11:07:27.000Z',
  };
  const merged = mergeHistoryEntry(prev, {
    uid: 'u1', model: 'm', kind: 'quota', resetAt: '2026-11-15T00:00:00.000Z',
  });
  assert.equal(merged.resetAt, '2026-11-15T00:00:00.000Z');
  assert.equal(merged.resetAtSource, 'upstream');
});

test('历史合并：首次记录且没有时间，保持空（不编造）', () => {
  const merged = mergeHistoryEntry(undefined, {
    uid: 'u1', model: 'm', kind: 'rate_limit', resetAt: '',
  });
  assert.equal(merged.resetAt, '');
});
