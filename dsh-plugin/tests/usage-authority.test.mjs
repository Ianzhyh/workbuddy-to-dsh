/**
 * 用量统计的两条口径回归（本轮用户诉求）：
 *
 *   ④ 「你用量统计优先取权威数据而不是自己猜测」
 *   ⑥ 「本轮积分怎么重进应用就消失了（没有准确数据你就用之前积分减去当前不就是消耗吗）」
 *   ⑤ 「换别的不是 workbuddy 模型不要出现本轮积分」
 *
 * 三件事的共同点：**别编数字**。
 *   · ④ 账单口径：上游没给单次扣费时，用账号余额前后差（权威值）兜底，
 *     并且标出来源，不冒充"上游回报"；
 *   · ⑥ 账本里要有 credit 字段才能被面板匹配到 —— 余额差正是把它补上，
 *     所以重进应用后仍能显示；
 *   · ⑤ 不是我们的模型就不该显示这一行（那条尾巴读的是我们的账本）。
 *
 *   node --test dsh-plugin/tests/usage-authority.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

test('④ 上游没回报 credit 时，用余额差值兜底并标出来源', () => {
  const src = read('bridge/workbuddy-bridge.mjs');
  assert.match(src, /async function withCreditDelta\(/, '应有余额差值采样');
  /*
   * usageOf 的三态：上游给了就记上游的；没给才用 ALS 里的差值；都没有就不写字段。
   * 「都没有就不写」是硬要求 —— 写 0 会被面板当成"本轮免费"。
   */
  assert.match(src, /creditSource: 'upstream'/, '上游回报的值要标 upstream');
  assert.match(src, /creditSource: 'balance-delta'/, '余额差值要标 balance-delta');
  assert.match(src, /typeof delta === 'number' && delta >= 0/,
    '差值必须是有限非负数才采信（充值/活动会让差值变负）');
});

test('④ 余额差值必须前后各读一次，且只在该请求独占窗口时才算', () => {
  const src = read('bridge/workbuddy-bridge.mjs');
  const fn = src.slice(src.indexOf('async function withCreditDelta('), src.indexOf('async function withCreditDelta(') + 2500);
  assert.match(fn, /const before = await quotaBalance\(auth\)/, '先读余额');
  assert.match(fn, /const after = await quotaBalance\(auth\)/, '后读余额');
  assert.match(fn, /CREDIT_DELTA_INFLIGHT/, '并发请求之间不能互相污染差值');
  // 失败请求也可能扣分：后采样必须放在 finally 里
  assert.match(fn, /finally \{[\s\S]{0,600}quotaBalance/, '后采样要在 finally 里（失败也扣分）');
});

test('④ 三条协议路径都接上了余额差值（chat / messages / responses）', () => {
  const src = read('bridge/workbuddy-bridge.mjs');
  /*
   * 按**调用点**数（`await withCreditDelta(`），不数单词出现次数 ——
   * 定义与注释里也会出现这个名字，数错就会变成假失败。
   */
  const calls = src.split('await withCreditDelta(').length - 1;
  assert.equal(calls, 3, `三条协议路径各调用一次，实际 ${calls}`);
});

test('⑤ 不是 WorkBuddy 的模型时不显示「本轮积分」', () => {
  const src = read('dsh-plugin/lib/client.js');
  assert.match(src, /workbuddyModelIdCache/, '需要一个模型目录缓存来判断归属');
  // 判据：本轮路由到的模型一个都不在我们的目录里 → 整条隐藏
  assert.match(src, /routeIds\.length && !routeIds\.some\(/, 
    '路由模型全部不在 WorkBuddy 目录时应隐藏本轮积分');
  /*
   * 但"不知道"时不能隐藏：目录还没拉到（null）要按原行为继续尝试匹配，
   * 否则首屏几秒会闪一下消失。
   */
  assert.match(src, /railModels && railModels\.length && turnUsage/,
    '目录未知时不能隐藏（否则首屏会闪）');
});

test('⑥ 余额差值的显示必须标 ≈，不能冒充精确值', () => {
  const src = read('dsh-plugin/lib/client.js');
  assert.match(src, /isBalanceDelta/, '渲染时要识别 balance-delta 来源');
  assert.match(src, /data-credit-source/, '把来源写进 DOM，便于验收与用户排查');
  // ≈ 的判据要覆盖"余额差值"这种情况
  assert.match(src, /const approx = info\.exact && !isBalanceDelta \|\| info\.credit === 0 \? '' : '≈'/,
    '余额差值不是上游权威值，必须带 ≈');
});

test('④「今日消耗」取当天日桶，不是 7 天合计', () => {
  const src = read('dsh-plugin/lib/client.js');
  const block = src.slice(src.indexOf('const usagePage = () =>'), src.indexOf('const accountPage = () =>'));
  assert.match(block, /localDayKey\(new Date\(\)\)/, '今日要按本地日期取桶');
  assert.match(block, /days\.find\(\(d\) => d && d\.day === key\)/, '在 days 里找当天那条');
  /*
   * 今日消耗必须来自 `todayCredit`（当天的桶），不能来自 `totalCredit`（窗口合计）。
   * 判据直接看渲染那一行，别用跨段落的正则 —— 注释里也会提到 total.credit，
   * 那种"匹配到注释"的假失败会让人去改根本没错的代码。
   */
  assert.match(block, /h\('b', null, '-' \+ num\(todayCredit\)\)/,
    '「今日消耗」必须渲染 todayCredit（当天的桶）');
  assert.doesNotMatch(block, /今日消耗'\)[\s\S]{0,80}num\(totalCredit\)/,
    '「今日消耗」不能用 totalCredit（那是 7 天合计）');
});
