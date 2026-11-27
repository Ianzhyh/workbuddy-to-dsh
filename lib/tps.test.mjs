/**
 * 测速（tokens/second）的纯函数回归。
 *
 * 这些数字要进面板供用户选模型，错了比不显示更糟 —— 所以每条用例都钉
 * "为什么这个规则是这样"，而不是只钉输出形状。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  summarizeTps, median, tpsSampleUsable, tpsProbeable,
  MIN_GENERATION_MS, TPS_PROBE_MAX_TOKENS,
} from './tps.mjs';

test('中位数：奇数取中间、偶数取均值、空数组 undefined', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([]), undefined);
  // 非有限值必须被剔除，否则会算出 NaN
  assert.equal(median([1, NaN, 3, undefined, 5]), 3);
});

test('三次测量取中位数：离群值不能污染结果', () => {
  /*
   * 实测依据：glm-5.3-flash 五次 110/105/177/103/109，那个 177 是离群值。
   * 三次取中位数能把它丢掉。这里用同样比例构造：
   *   110/105/287 → 中位数 110（不是均值 167）
   */
  const sample = summarizeTps('m', [
    { generationMs: 1000, outputTokens: 110 },
    { generationMs: 1000, outputTokens: 105 },
    { generationMs: 1000, outputTokens: 287 },
  ], 3);
  assert.equal(sample.tokensPerSecond, 110, '中位数必须是 110，均值会把离群值算进来');
  assert.equal(sample.samples, 3);
  assert.equal(sample.complete, true);
});

test('短样本被丢弃，而不是算出一个荒谬的高速度', () => {
  /*
   * generationMs=3 / outputTokens=1 会得出 333 tok/s，而真实吞吐可能只有 50。
   * 这种样本必须整条丢弃 —— 宁可没有数字，也不要一个错数字。
   */
  const sample = summarizeTps('m', [{ generationMs: 3, outputTokens: 1 }], 3);
  assert.equal(sample.tokensPerSecond, undefined, '不该从 3ms 的样本算出速度');
  assert.equal(sample.reason, 'few-chunks', '要说明是"样本太短"而不是"模型慢"');
  assert.equal(sample.samples, 1);
  assert.equal(sample.complete, false, '只成功 1 次/发了 3 次，不能报完整');
});

test('边界：恰好等于 MIN_GENERATION_MS 的样本算可用', () => {
  const atBoundary = summarizeTps('m', [
    { generationMs: MIN_GENERATION_MS, outputTokens: 10 },
  ], 1);
  assert.ok(atBoundary.tokensPerSecond !== undefined, '>= 阈值就该参与计算');
  const belowBoundary = summarizeTps('m', [
    { generationMs: MIN_GENERATION_MS - 1, outputTokens: 10 },
  ], 1);
  assert.equal(belowBoundary.tokensPerSecond, undefined);
});

test('全部失败 / 没有 usage 时，reason 要区分开', () => {
  assert.equal(summarizeTps('m', [], 3).reason, 'all-failed');
  // 有轮次但拿不到 outputTokens（上游没回 usage）
  assert.equal(summarizeTps('m', [{ generationMs: 900 }], 1).reason, 'no-usage');
});

test('首字节延迟取中位数，且与速度分开算', () => {
  const sample = summarizeTps('m', [
    { firstContentMs: 300, generationMs: 500, outputTokens: 250 },
    { firstContentMs: 900, generationMs: 520, outputTokens: 260 },
    { firstContentMs: 400, generationMs: 480, outputTokens: 240 },
  ], 3);
  assert.equal(sample.timeToFirstTokenMs, 400, '首字节中位数应为 400');
  assert.ok(sample.tokensPerSecond > 0);
  // 两者语义不同：首字节是延迟，速度是吞吐，不能混用同一个数
  assert.notEqual(sample.timeToFirstTokenMs, sample.tokensPerSecond);
});

test('credit 累加并保留两位；缺字段时不写（不是写 0）', () => {
  const withCredit = summarizeTps('m', [
    { generationMs: 500, outputTokens: 100, credit: 0.012 },
    { generationMs: 500, outputTokens: 100, credit: 0.013 },
  ], 2);
  assert.equal(withCredit.credit, 0.03, '0.012+0.013 保留两位 = 0.03');
  const withoutCredit = summarizeTps('m', [{ generationMs: 500, outputTokens: 100 }], 1);
  assert.equal('credit' in withoutCredit, false, '上游没报花费时不该写 0（那会被读成"免费"）');
});

test('finish 原因：stop/length 可用，其余不可用', () => {
  assert.equal(tpsSampleUsable({ kind: 'stop' }), true);
  /*
   * length 是最常见的情况：我们只给 256 token，模型通常写满就被截断。
   * 把它判成不可用等于永远测不出速度。
   */
  assert.equal(tpsSampleUsable({ kind: 'length' }), true);
  assert.equal(tpsSampleUsable({ kind: 'content_filter' }), false);
  assert.equal(tpsSampleUsable({ kind: 'tool-call' }), false);
  assert.equal(tpsSampleUsable({ kind: 'aborted' }), false);
  assert.equal(tpsSampleUsable(undefined), false, '没有 finish 原因时不能假设可用');
});

test('可测模型判定：只要有 id 就测，不按倍率主观筛掉', () => {
  assert.equal(tpsProbeable({ id: 'a' }), true);
  assert.equal(tpsProbeable({ id: 'expensive-model', credits: 99 }), true,
    '贵的模型也可能快到值得选，不能因为倍率高就跳过');
  assert.equal(tpsProbeable({}), false);
  assert.equal(tpsProbeable(null), false);
  assert.equal(tpsProbeable({ id: '' }), false);
});

test('输出上限是 256 —— 够摊薄首字节开销，又不贵', () => {
  /*
   * 太小（如 16）会让生成阶段过短、落进 MIN_GENERATION_MS 的丢弃区；
   * 太大则成本上升且容易被内容过滤打断。256 是实测过的折中。
   */
  assert.equal(TPS_PROBE_MAX_TOKENS, 256);
});