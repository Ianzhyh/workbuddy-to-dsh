/**
 * issue #32 后续反馈（JokesLin, 1.24.4）的三条遗漏。
 *
 *   ① `autoCheckinTargets()` 没纳入**插件 OAuth 账号**；
 *   ② 全部 settled 后永久静默、当前账号结束就跳过枚举；
 *   ③ `fetch failed` 等暂时性失败被"3 次即当天停止"锁死。
 *
 * ## 为什么用源码求值而不是起桥进程
 *
 * ①③ 都是**纯逻辑**（一个数组过滤 + 一个分类器 + 一个 skip 判定），
 * 起进程只能验证端到端，反而把"哪条规则错了"藏进日志里。
 *
 * ② 的"重新发现"是时间闸门，用真实时钟等 30 分钟不现实 —— 需要
 * `WORKBUDDY_CHECKIN_REDISCOVER_MS=0` 才能立刻放行，而这条用常量求值
 * 更能说清"闸门存在且可关闭"。
 *
 * 插件凭据（加密信封）**没有**在这里构造：桥的 .cred 是 AES-256-GCM 信封，
 * 密钥由客户端的 at-rest 机制派生，测试里伪造不现实也不该伪造。
 * 所以 ① 的验证方式是：把"插件账号数组"直接喂给 `autoCheckinTargets`，
 * 断言它确实被纳入且去重 —— 这正是被修的那段逻辑的边界。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, 'workbuddy-bridge.mjs'), 'utf8');

/** 取出一个顶层函数的源码（用于真的调用它，而不是断言字符串存在）。 */
function grabFunction(name) {
  const at = SRC.indexOf(`function ${name}(`);
  assert.ok(at > 0, `找不到 ${name}`);
  let i = SRC.indexOf('{', at);
  let depth = 0;
  for (; i < SRC.length; i += 1) {
    if (SRC[i] === '{') depth += 1;
    else if (SRC[i] === '}') { depth -= 1; if (depth === 0) return SRC.slice(at, i + 1); }
  }
  throw new Error(`${name} 括号不配对`);
}

test('① 插件 OAuth 账号必须进入 autoCheckinTargets（并与桌面账号去重）', () => {
  const autoCheckinTargets = new Function(
    `${grabFunction('autoCheckinTargets')}\nreturn autoCheckinTargets;`,
  )();

  const currentAuth = { userId: 'uid-intl-current', access: 't-current' };
  const desktop = [
    // 桌面凭据的形状：`access`（不是 accessToken）+ `expiresAt`
    { userId: 'uid-cn-desktop', nickname: '桌面国内号', access: 't-desktop', expiresAt: Date.now() + 86_400_000 },
    // 已过期的桌面凭据：不该被打上游（签到路径不会刷新令牌）
    { userId: 'uid-desktop-expired', nickname: '过期桌面号', access: 't-old', expiresAt: Date.now() - 1000 },
    // 缺 access 的坏条目
    { userId: 'uid-desktop-no-access', nickname: '无令牌桌面号' },
  ];
  const plugin = [
    // 只在插件里登录过、桌面目录没有痕迹的那种
    { uid: 'uid-cn-plugin', nickname: '插件国内号', accessToken: 't-plugin', expiresAt: Date.now() + 86_400_000 },
    // 与桌面同一个号：必须去重，且优先桌面那份（令牌更新更及时）
    { uid: 'uid-cn-desktop', nickname: '插件里的同名号', accessToken: 't-plugin-dup', expiresAt: Date.now() + 86_400_000 },
    // 已过期的插件凭据：不该被打上游
    { uid: 'uid-expired', nickname: '过期号', accessToken: 't-old', expiresAt: Date.now() - 1000 },
    // 没有 accessToken 的坏条目
    { uid: 'uid-no-token', nickname: '无令牌' },
  ];

  const targets = autoCheckinTargets(currentAuth, desktop, plugin);
  const keys = targets.map((t) => t.key);
  console.log('targets =', JSON.stringify(keys));

  assert.ok(keys.includes('uid-cn-plugin'),
    `插件 OAuth 账号必须被纳入（修复前只扫桌面 .info）。实际：${JSON.stringify(keys)}`);
  assert.ok(keys.includes('uid-intl-current'), '当前账号仍要在列');
  assert.ok(keys.includes('uid-cn-desktop'), '桌面账号仍要在列');
  assert.ok(!keys.includes('uid-expired'), '已过期的插件凭据不该被打上游');
  assert.ok(!keys.includes('uid-no-token'), '没有 accessToken 的条目要跳过');
  /*
   * 桌面凭据同样要过滤过期 / 缺令牌：
   * 签到路径（billingHeaders）直接用 `auth.access`，**不会刷新令牌**，
   * 拿过期的去打上游只会换来 401，白占当天的重试额度。
   */
  assert.ok(!keys.includes('uid-desktop-expired'), '已过期的桌面凭据不该被打上游');
  assert.ok(!keys.includes('uid-desktop-no-access'), '缺 access 的桌面条目要跳过');

  /* 去重：同一个 uid 只能出现一次，且用桌面那份 */
  assert.equal(keys.filter((k) => k === 'uid-cn-desktop').length, 1, '同一 uid 必须只出现一次');
  const dup = targets.find((t) => t.key === 'uid-cn-desktop');
  /*
   * 桌面凭据的令牌字段是 `access`（插件凭据用 `accessToken`）—— 断言要按
   * 各自形状取，否则会拿到 undefined 并误判成"没用到桌面那份"。
   */
  const tokenOf = (auth) => auth.access ?? auth.accessToken;
  assert.equal(tokenOf(dup.auth), 't-desktop',
    '同号去重时必须优先桌面凭据（插件那份可能已过期）');

  /* 向后兼容：不传插件数组时行为与旧版一致（单账号机器走一个） */
  const onlyCurrent = autoCheckinTargets(currentAuth, []);
  assert.equal(onlyCurrent.length, 1, '不传插件账号时只签当前账号');
});

test('② 全部 settled 后的重新发现闸门存在，且可关闭', () => {
  /*
   * 用户反馈的这一条：全部账号结束后**永久静默到跨天**，当天新登录的账号
   * 发现不了。修法是加一个 `AUTO_CHECKIN_REDISCOVER_MS` 闸门。
   *
   * 这里验三件事：常量存在、默认值合理（>0 且 <= 1 小时）、
   * 且快速退出条件里**真的用了它**（而不是写了常量却没用）。
   */
  const m = /const AUTO_CHECKIN_REDISCOVER_MS = numEnv\('WORKBUDDY_CHECKIN_REDISCOVER_MS', ([^,]+),/.exec(SRC);
  assert.ok(m, '缺少 AUTO_CHECKIN_REDISCOVER_MS 常量');
  // 默认值是表达式（如 30 * 60_000），求值后核对范围
  const defaultValue = new Function(`return (${m[1].replace(/_/g, '')});`)();
  assert.ok(defaultValue > 0, '默认值应为正（0 等于退化成旧行为）');
  assert.ok(defaultValue <= 3_600_000, `默认值不该超过 1 小时，实际 ${defaultValue}ms`);

  assert.match(SRC, /autoCheckinLastScanAt/,
    '需要记录"上次真正扫过账号"的时刻');
  assert.match(SRC, /now - autoCheckinLastScanAt < AUTO_CHECKIN_REDISCOVER_MS/,
    '快速退出必须受重新发现闸门约束（否则就是永久静默）');

  /*
   * 且当前账号结束后**不再跳过枚举** —— 原来那句
   * `const accounts = currentSettled ? [] : await safeLocalAccounts()`
   * 会让插件账号在"当前号已签"时永远进不来。
   *
   * 判据要**先剥掉注释再查**：那段历史行为在注释里被引用着（说明修了什么），
   * 直接对全文 doesNotMatch 会匹配到注释，把正确的代码判成没改（实测踩过）。
   */
  const codeOnly = SRC
    .replace(/\/\*[\s\S]*?\*\//g, '')   // 块注释
    .replace(/^\s*\/\/.*$/gm, '');      // 行注释
  assert.doesNotMatch(codeOnly, /currentSettled\s*\?\s*\[\]\s*:/,
    '不应再因为"当前账号已结束"跳过账号枚举');
});

test('③ 暂时性失败：短冷却、不锁死当天；业务错误仍当天收工', () => {
  const grabExact = (name) => grabFunction(name);
  const MAX = 3;
  const COOLDOWN = 3_600_000;
  const skipReason = new Function(
    'AUTO_CHECKIN_MAX_PER_DAY', 'AUTO_CHECKIN_COOLDOWN_MS',
    `${grabExact('autoCheckinSkipReason')}\nreturn autoCheckinSkipReason;`,
  )(MAX, COOLDOWN);

  const now = Date.now();
  /* 暂时性失败（cooldownMs=5min）：5 分钟后应可重试，而不是等 1 小时 */
  assert.equal(skipReason({ done: false, tries: 1, lastAt: now - 60_000, cooldownMs: 5 * 60_000 }, now), 'cooldown');
  assert.equal(skipReason({ done: false, tries: 1, lastAt: now - 6 * 60_000, cooldownMs: 5 * 60_000 }, now), '',
    '暂时性失败过了短冷却就该能重试（否则网络恢复后要白等到跨天）');
  /* 没设 cooldownMs 时回落默认 1 小时（业务错误语义） */
  assert.equal(skipReason({ done: false, tries: 1, lastAt: now - 6 * 60_000 }, now), 'cooldown');
  /* 业务错误当天收工 */
  assert.equal(skipReason({ done: true, tries: 1, lastAt: 0 }, now), 'done');
  /* 当天上限仍存在（防打爆上游） */
  assert.equal(skipReason({ done: false, tries: MAX, lastAt: 0, cooldownMs: 1000 }, now), 'tries');

  /* 分类器：业务错误绝不能进暂时性分支 */
  const isTransient = new Function(`${grabExact('isTransientCheckinError')}\nreturn isTransientCheckinError;`)();
  for (const [msg, code, want] of [
    ['fetch failed', '', true],
    ['getaddrinfo ENOTFOUND copilot.tencent.com', '', true],
    ['', 'ECONNRESET', true],
    ['upstream 503 Service Unavailable', '', true],
    ['socket hang up', '', true],
    ['签到活动未开启或已过期', '', false],
    ['code 6004 usage exceeds frequency limit', '', false],
    ['login expired', '', false],
    ['参数错误 400', '', false],
  ]) {
    assert.equal(isTransient({ message: msg, code }), want,
      `暂时性判定错误：${msg || code} 应为 ${want}`);
  }

  /* 暂时性分支必须落盘到 slot.cooldownMs，否则上面的短冷却不会生效 */
  assert.match(SRC, /slot\.cooldownMs = AUTO_CHECKIN_TRANSIENT_COOLDOWN_MS/,
    '暂时性失败必须写入短冷却时长');
  /* 且该分支不能把 done 置真（那会当天不再尝试） */
  const catchBlock = SRC.slice(
    SRC.indexOf('const noActivity = NO_CHECKIN_ACTIVITY_RE.test(msg)'),
    SRC.indexOf('const current = results.find'),
  );
  assert.match(catchBlock, /isTransientCheckinError\(e\)/, 'catch 里要识别暂时性失败');
  assert.match(catchBlock, /continue;/, '暂时性失败分支要跳过"收工"逻辑');
});
