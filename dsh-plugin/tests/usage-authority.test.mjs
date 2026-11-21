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
  /*
   * 判据现在是"**账本里对不上这一轮**就不显示"。
   *
   * 第一版拿 /workbuddy/models 当白名单（routes 的模型全不在目录里就藏），
   * 结果把正常回合也藏了：那个接口只在打开模型页时才拉，聊天页挂载时目录
   * 还是空的 —— panel-render 的「每轮积分没有渲染」「一轮多次请求的回合
   * 没有渲染积分」当场红。
   */
  assert.match(src, /if \(info\.reason !== 'read-failed'\) return null;/,
    '账本里对不上这一轮时应隐藏（不是我们经手的轮次就别显示）');
  /*
   * 但"读接口失败"要照说 —— 那是真故障，静默会让人以为这一轮免费。
   *
   * 实现形态是「reason 不是 read-failed 就返回 null」，所以这里断它的反面：
   * 只有 read-failed 这一种原因会继续往下渲染。
   */
  assert.match(src, /info\.reason !== 'read-failed'\) return null;/,
    '读接口失败时仍要显示「未读到」（不能把真故障静默掉）');
  /*
   * 不能再有"模型目录白名单"那套：它会把正常回合误藏。
   */
  assert.doesNotMatch(src, /workbuddyModelIdCache/,
    '不应再用模型目录白名单判断归属（会误藏正常回合）');
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
  /*
   * 右栏「用量」现在**迁移**了设置页的 UsagePanel，不再自己算一套。
   *
   * 所以断言从"右栏怎么取今天的桶"改成"右栏没有另起一套口径" ——
   * 今天的口径由 UsagePanel 负责（它按页面日期补日桶），右栏不该重复实现。
   */
  const railUsage = src.slice(src.indexOf('const usagePage = () =>'), src.indexOf('const accountPage = () =>'));
  assert.match(railUsage, /h\(UsagePanel, \{\}\)/,
    '右栏用量应直接渲染设置页的 UsagePanel（迁移，不是复制）');
  assert.doesNotMatch(railUsage, /totalCredit/,
    '右栏不该自己算"今日消耗"（那是设置页组件的职责，重算必然口径漂移）');
  /*
   * 设置页那份必须仍然是"当天日桶"，不能是窗口合计 —— 那是本条断言的真正含义。
   *
   * UsagePanel 的做法：把上游返回的日数据按 day 建成 Map，再从**今天**倒推
   * 逐天取（取不到就补一个空桶）。所以判据是这两步，不是某个具体写法。
   */
  assert.match(src, /localDayKey\(date\)/, '今日要按本地日期取桶');
  assert.match(src, /byKey\.get\(key\)/, '按当天日期键从日数据里取值');
  assert.match(src, /const byKey = new Map\(source\.map/, '日数据要先按 day 建索引');
});
