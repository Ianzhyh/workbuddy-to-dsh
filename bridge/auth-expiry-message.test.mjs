/**
 * 登录态失效的两种消息必须**说人话**：
 *   ① 上游 401/403 → "登录过期，请重新登录"，不是 "api invalid"；
 *   ② 本机读不到凭据 → "本机没有登录凭据，什么都没发出去"，同样不是 "api invalid"。
 *
 * 用户原话：「还有账号令牌过期桥有提示吗不要说 api invalid」。
 *
 * 这条诉求背后是个真实误导：这两条路径都**没有**"API key 无效"这回事——
 *   ① 走的是登录态（access/refresh token），过期只需重新登录；
 *   ② 连凭据都没读到，一个字节都没发往上游。
 * 若文案写成 "invalid api key"，用户会跑去改客户端的 key 设置，而那里根本
 * 没有需要改的东西。
 *
 * 另外 `no usable credential (auto): desktop: ...; plugin: ...` 那种把内部
 * 来源名与底层报错原文直接摊开的写法也已废弃：它既没说怎么办，也读不懂。
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

test('上游登录过期：提示重新登录，且不提 api key', () => {
  const fnSrc = SRC.slice(
    SRC.indexOf('function upstreamAuthMessage('),
    SRC.indexOf('function upstreamAuthMessage(') + 900,
  );
  assert.ok(fnSrc.includes('login expired'), '上游 401 应说 "login expired"');
  assert.match(fnSrc, /re-login|sign in again/i, '必须给出"重新登录"这个动作');
  assert.match(fnSrc, /WorkBuddy desktop app|desktop app/i, '要说清在哪儿重新登录');
  /*
   * 关键词护栏：这两条路径都与 "api key" 无关，出现就是把用户引向错误的方向。
   */
  assert.doesNotMatch(fnSrc, /api[ _-]?key/i, '上游登录过期不该提 api key');
  assert.doesNotMatch(fnSrc, /invalid/i, '不该用 "invalid" 这种含糊措辞');
});

test('本地无凭据：提示重新登录，并说明"什么都没发出去"', () => {
  const noCredentialMessage = new Function(`${grabFunction('noCredentialMessage')}\nreturn noCredentialMessage;`)();
  const msg = noCredentialMessage(
    new Error('login file not found'),
    new Error('no plugin credential yet'),
  );

  assert.match(msg, /no local login credential/i, '要说清"本机没有登录凭据"');
  assert.match(msg, /sign in again|re-login/i, '必须给出"重新登录"这个动作');
  assert.match(msg, /Nothing was sent upstream/i,
    '要说明"什么都没发出去"——否则用户会以为请求被上游拒了');
  /* 排障细节仍保留（截断），但不再是未加工的内部结构 */
  assert.match(msg, /desktop:/, '保留 desktop 侧原因供排障');
  assert.match(msg, /plugin:/, '保留 plugin 侧原因供排障');

  /*
   * 关键：不能出现 "api key" / "invalid"。这条路径根本没走到上游鉴权。
   */
  assert.doesNotMatch(msg, /api[ _-]?key/i, '本地无凭据与 api key 无关，不该提');
  assert.doesNotMatch(msg, /invalid/i, '不该用 "invalid"');
  /* 也不该把内部来源名当主语甩给用户 */
  assert.doesNotMatch(msg, /no usable credential \(auto\)/,
    '旧写法（内部来源名 + 原始异常）已废弃');

  /* 底层报错很长时要截断，别让 413/401 的 body 被撑爆 */
  const longMsg = noCredentialMessage(new Error('x'.repeat(500)), new Error('y'.repeat(500)));
  assert.ok(longMsg.length < 700, `消息应被截断，实际 ${longMsg.length} 字符`);
});

test('/health 明确标出登录态是否过期（用户问的正是这个）', () => {
  const body = SRC.slice(SRC.indexOf('async function credentialStatus()'));
  const block = body.slice(0, 3000);

  assert.match(block, /expired: typeof auth\.expiresAt === 'number'/,
    'credentialStatus 应给出 expired 布尔（只有时间戳的话得用户自己算）');
  /*
   * 没有 expiresAt 时必须给 null 而不是 false：false 会被读成"确认没过期"，
   * 而 null 才表示"不适用"。
   */
  assert.match(block, /: null,/, '无 expiresAt 时应为 null（不适用），不是 false');
  assert.match(block, /effective\.hint/, '过期时要给一句可执行的 hint');
  assert.match(block, /login expired/i, 'hint 也要用"登录过期"的说法');
});
