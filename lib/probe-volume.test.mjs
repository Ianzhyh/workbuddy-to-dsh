/**
 * 体积感知体检的回归（2026-11-07）。
 *
 * ## 为什么这个功能值得一整套测试
 *
 * 旧体检发的是 `hi`（约 21 token）就宣布"可用"。而上游**按请求体积限流**，
 * 所以那个结论对用户真正关心的问题（"我这个长对话能不能过"）是**错答**——
 * 而且它错得看不出来：界面上写着"可用"，用户一用就被限。
 *
 * 这组用例钉住四件事：
 *   1. 档位归一（非法值不能变成"发 1 个 token"或"发 100 万"）；
 *   2. 填充量按**实测比例**补偿，否则"选 20k 实际发 11k"；
 *   3. 积分估算按实测锚点分段（10k→12k 之间有 4 倍跳变，乘单价会失真）；
 *   4. **前后端两张表必须一致**——控制台为了不额外发网络请求，在前端复制了
 *      一份锚点；两份一旦漂移，界面会说"约 0.45"而实际扣 4.91。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(HERE);

const {
  PROBE_INPUT_TOKEN_CHOICES,
  DEFAULT_PROBE_INPUT_TOKENS,
  PROBE_FILLER_RATIO,
  resolveProbeInputTokens,
  estimateProbeCredits,
  probeFiller,
} = await import('./diagnostics.mjs');

test('体检：档位归一 —— 非法值回默认，超表取最大档，不超目标', () => {
  assert.equal(resolveProbeInputTokens(undefined), DEFAULT_PROBE_INPUT_TOKENS);
  assert.equal(resolveProbeInputTokens(null), DEFAULT_PROBE_INPUT_TOKENS);
  assert.equal(resolveProbeInputTokens(0), DEFAULT_PROBE_INPUT_TOKENS);
  assert.equal(resolveProbeInputTokens(-1), DEFAULT_PROBE_INPUT_TOKENS);
  assert.equal(resolveProbeInputTokens('abc'), DEFAULT_PROBE_INPUT_TOKENS);
  assert.equal(resolveProbeInputTokens(NaN), DEFAULT_PROBE_INPUT_TOKENS);

  // 档位值原样返回
  for (const c of PROBE_INPUT_TOKEN_CHOICES) {
    assert.equal(resolveProbeInputTokens(c), c, `档位 ${c} 应原样返回`);
  }
  // 非档位值：取**不超过**目标的最大档（宁可少测，不要超测多花钱）
  assert.equal(resolveProbeInputTokens(7_000), 5_000);
  assert.equal(resolveProbeInputTokens(25_000), 20_000);
  assert.equal(resolveProbeInputTokens(999_999), PROBE_INPUT_TOKEN_CHOICES.at(-1));
  // 比最小档还小 → 用最小档（不能变成"发几十个 token"的伪探针）
  assert.equal(resolveProbeInputTokens(100), PROBE_INPUT_TOKEN_CHOICES[0]);
});

test('体检：默认档必须有代表性（不能退回 21 token 那种伪探针）', () => {
  assert.ok(DEFAULT_PROBE_INPUT_TOKENS >= 5_000,
    `默认档 ${DEFAULT_PROBE_INPUT_TOKENS} 太小，无法代表真实长对话`);
  assert.ok(PROBE_INPUT_TOKEN_CHOICES.includes(DEFAULT_PROBE_INPUT_TOKENS),
    '默认档必须在档位表里，否则界面上选不回来');
  // 档位表升序无重复
  const sorted = [...PROBE_INPUT_TOKEN_CHOICES].sort((a, b) => a - b);
  assert.deepEqual(PROBE_INPUT_TOKEN_CHOICES, sorted, '档位表必须升序');
  assert.equal(new Set(PROBE_INPUT_TOKEN_CHOICES).size, PROBE_INPUT_TOKEN_CHOICES.length);
});

test('体检：填充量按实测比例补偿（选多少就发多少 token）', () => {
  /*
   * 实测重复中文被分词器压缩到约 56%：填 20,000 汉字只算 11,269 token。
   * 不补偿的话"选 20k 档"实际只发 11k —— 那正是我们要消灭的"说一套做一套"。
   */
  assert.ok(PROBE_FILLER_RATIO > 0 && PROBE_FILLER_RATIO <= 1,
    `补偿比例 ${PROBE_FILLER_RATIO} 不合理`);

  for (const target of [5_000, 10_000, 50_000]) {
    const text = probeFiller(target);
    const chars = text.length;
    const expectedChars = target / PROBE_FILLER_RATIO;
    // 允许一个单元的误差（按整单元拼接）
    assert.ok(Math.abs(chars - expectedChars) < 20,
      `目标 ${target}: 填充 ${chars} 字，期望约 ${Math.round(expectedChars)} 字`);
    // 关键：补偿后**不能**比目标还小
    assert.ok(chars > target, `目标 ${target}: 填充量 ${chars} 未超过目标，补偿没生效`);
  }
  // 极小值也不能产出空串（空 content 会被上游拒绝）
  assert.ok(probeFiller(1).length > 0);
  assert.ok(probeFiller(0).length > 0);
});

test('体检：积分估算按实测锚点分段，不是乘单价', () => {
  /*
   * 实测关键数据：10,072 token 扣 0.45，而 11,269 token 扣 1.86 ——
   * 1.2k token 差异让费用涨 4 倍（上游在约 10k–11k 处有计价分界）。
   * 若用统一单价，跨过分界时误差可达 4 倍。
   */
  assert.equal(estimateProbeCredits(5_000), 0.26);
  assert.equal(estimateProbeCredits(10_000), 0.45);
  assert.equal(estimateProbeCredits(12_000), 1.86);
  assert.equal(estimateProbeCredits(30_000), 4.91);
  assert.equal(estimateProbeCredits(50_000), 8.16);

  // 分界两侧必须体现出跳变（这正是分段的意义）
  const before = estimateProbeCredits(10_000);
  const after = estimateProbeCredits(12_000);
  assert.ok(after / before > 2,
    `10k→12k 应体现计价跳变，实际 ${before} → ${after}`);

  // 单调不减
  let prev = 0;
  for (const n of [1_000, 5_000, 8_000, 10_000, 12_000, 20_000, 30_000, 50_000, 100_000]) {
    const v = estimateProbeCredits(n);
    assert.ok(v >= prev, `估算必须单调不减：${n} 处从 ${prev} 掉到 ${v}`);
    prev = v;
  }
  // 非法输入
  assert.equal(estimateProbeCredits(0), 0);
  assert.equal(estimateProbeCredits(-1), 0);
  assert.equal(estimateProbeCredits('abc'), 0);
});

test('体检：前端成本提示表必须与后端一致（两份表不能漂移）', () => {
  /*
   * 控制台为了"换档不额外打网络"，在前端复制了一份锚点表。
   * 两份漂移的后果很具体：界面说"约 0.45 积分"，实际扣 4.91 —— 用户点完才发现。
   * 所以这条用例直接从 HTML 里把那张表读出来，与后端逐点比对。
   */
  const html = readFileSync(join(REPO, 'dashboard', 'public', 'index.html'), 'utf8');
  const m = /const ANCHORS = (\[\[[\s\S]*?\]\]);/.exec(html);
  assert.ok(m, '前端 refreshProbeCostHint 里的 ANCHORS 表没找到（可能被改名/移动）');
  let frontAnchors;
  try {
    frontAnchors = JSON.parse(m[1]);
  } catch {
    // 允许 JS 字面量里的空格差异
    frontAnchors = Function(`"use strict";return (${m[1]});`)();
  }
  assert.ok(Array.isArray(frontAnchors) && frontAnchors.length >= 5,
    `前端锚点表异常：${JSON.stringify(frontAnchors)}`);

  for (const [tokens, credits] of frontAnchors) {
    const back = estimateProbeCredits(tokens);
    assert.equal(back, credits,
      `锚点 ${tokens} token：前端写 ${credits}，后端算 ${back} —— 两张表已漂移`);
  }
});
