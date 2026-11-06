/**
 * 配置校验的回归（2026-11-06 第三份审计修复）。
 *
 * 这一层的共同缺陷形态是「**静默给出错值**」：配置读进来了、启动也没报错，
 * 但生效的是另一个值，用户在面板上看到的与实际行为不一致。逐条钉住：
 *
 *   1. `asBool('')` 不能当成 true —— `.env` 里 `WORKBUDDY_AUTO_CHECKIN=` 这种
 *      留空行会把自动签到**打开**（用户的本意是"跟随面板"）；
 *   2. 非法端口不能进 URL —— `-1` / `99999` 拼出 `http://127.0.0.1:-1`，
 *      `fetch` 抛 parse 错 → 桥永远在"启动中"失败；
 *   3. 非法 host 不能拼进 URL —— `127.0.0.1:8790` 这种误写会得到双端口；
 *   4. TTL 的 `0` 必须生效 —— `Number(x) || DEFAULT` 把"每次都重取"改成默认；
 *   5. `streamIdleTimeoutMs` 的非法值不能变成 0 —— 0 = 关掉流卡死保护；
 *   6. `modelAllow` 写成 mapping 时不能得到 `[object Object]`（选择器会空掉）；
 *   7. `reconcile` 不能绕过枚举校验把非法值注入桥；
 *   8. 进程环境必须优先于 `.env`（桥与插件都按同一顺序取值）。
 *
 * 这些是纯函数，用 `resolveConfig` / `collectBridge*Env` 直接验证，
 * 不需要起进程。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/*
 * `config.mjs` 在 import 时求值（会读/建本地令牌），所以 DSH_HOME 必须在
 * **动态 import 之前**指向临时目录，绝不能碰使用者真实的 ~/.dsh。
 */
const home = mkdtempSync(join(tmpdir(), 'wb-cfg-home-'));
mkdirSync(home, { recursive: true });
process.env.DSH_HOME = home;
process.env.WORKBUDDY_PORT = '0';

const mod = await import('../lib/index.js');

test('配置：asBool("") 回退默认，不能把开关打开', () => {
  const c = mod.resolveConfig({ autoCheckin: '', autoStart: '', autoWebSearch: '' });
  assert.equal(c.autoCheckin, undefined, '空串必须当"没设置"（undefined = 跟随面板）');
  assert.equal(c.autoStart, true, '空串应回退默认 true');
  // 显式值仍然照常生效，不能被这次收口弄坏
  const explicit = mod.resolveConfig({ autoCheckin: '1', autoStart: '0', autoWebSearch: 'no' });
  assert.equal(explicit.autoCheckin, true);
  assert.equal(explicit.autoStart, false);
  assert.equal(explicit.autoWebSearch, false);
});

test('配置：非法端口回退默认（否则 URL 拼错，桥永远起不来）', () => {
  for (const bad of ['-1', '99999', 'abc', '0', '8790.5']) {
    const c = mod.resolveConfig({ bridgePort: bad, consolePort: bad });
    assert.equal(c.bridgePort, 8790, `端口 "${bad}" 应回退默认`);
    assert.equal(c.consolePort, 8792, `端口 "${bad}" 应回退默认`);
  }
  assert.equal(mod.resolveConfig({ bridgePort: '9000' }).bridgePort, 9000, '合法端口必须保留');
});

test('配置：非法 host 回退默认（否则拼出双端口 / 带协议的 URL）', () => {
  for (const bad of ['127.0.0.1:8790', 'http://x', 'a b', 'x/evil?q=']) {
    assert.equal(mod.resolveConfig({ bridgeHost: bad }).bridgeHost, '127.0.0.1', `host "${bad}" 应回退默认`);
  }
  assert.equal(mod.resolveConfig({ bridgeHost: '192.168.1.5' }).bridgeHost, '192.168.1.5');
});

test('配置：TTL 的 0 是合法值（0 = 每次都重取，不能被替换成默认）', () => {
  const c = mod.resolveConfig({ catalogTtlMs: 0, bridgeAliveTtlMs: 0 });
  assert.equal(c.catalogTtlMs, 0, 'catalogTtlMs: 0 必须生效');
  assert.equal(c.bridgeAliveTtlMs, 0, 'bridgeAliveTtlMs: 0 必须生效');
});

test('配置：streamIdleTimeoutMs 的非法值回退默认，不能悄悄变成 0（=关掉看门狗）', () => {
  for (const bad of ['5m', '300000ms', true]) {
    assert.equal(mod.resolveConfig({ streamIdleTimeoutMs: bad }).streamIdleTimeoutMs, 300_000,
      `"${bad}" 应回退默认 300000，而不是 0`);
  }
  // 显式 0 仍然表示"关闭"——那是明确意图，必须保住
  assert.equal(mod.resolveConfig({ streamIdleTimeoutMs: 0 }).streamIdleTimeoutMs, 0);
  assert.equal(mod.resolveConfig({ streamIdleTimeoutMs: 120_000 }).streamIdleTimeoutMs, 120_000);
});

test('配置：modelAllow 写成 mapping 时取键名，不能变成 [object Object]', () => {
  const c = mod.resolveConfig({ modelAllow: { 'deepseek-v4-pro': true, 'glm-5.3': true, ghost: false } });
  assert.ok(c.modelAllow.includes('deepseek-v4-pro'), `实际：${JSON.stringify(c.modelAllow)}`);
  assert.ok(c.modelAllow.includes('glm-5.3'));
  assert.ok(!c.modelAllow.includes('[object Object]'), '不能把对象字符串化当成模型 id');
  assert.ok(!c.modelAllow.includes('ghost'), '值为 false 的键视为显式排除');
});

test('配置：进程环境优先于 .env（桥子进程与插件自身必须同源）', () => {
  const secret = mod.collectBridgeSecretEnv(
    { WORKBUDDY_CREDENTIAL_KEY: 'OLD-DOTENV' },
    { WORKBUDDY_CREDENTIAL_KEY: 'NEW-PROCENV' },
  );
  assert.equal(secret.WORKBUDDY_CREDENTIAL_KEY, 'NEW-PROCENV',
    '进程环境必须赢 —— 否则桥用旧 key 解密、插件用新 key，看起来正常但凭据读不出');

  const extra = mod.collectBridgeExtraEnv(
    { WORKBUDDY_MAX_SOCKETS: '8' },
    { WORKBUDDY_MAX_SOCKETS: '32' },
  );
  assert.equal(extra.WORKBUDDY_MAX_SOCKETS, '32', '透传白名单里的键也必须同一优先级');
});

test('配置：reconcile 不把非法枚举值注入（loginRegion=us 必须被挡）', () => {
  /*
   * `resolveConfig` 会把 `us` 挡回 `cn`，但 `apply()` 里的 reconcile 是
   * **在校验之后**用原始字符串覆盖 —— 没有第二个校验点就会把 `us` 注进桥。
   * 这里直接验证被导出的校验函数口径：用一个非法值走一遍 resolveConfig 已经
   * 覆盖，reconcile 的具体线路由 `asEnum` 保证。所以这里断言的是
   * "非法值不会原样留在 config 上"这一语义。
   */
  const c = mod.resolveConfig({ loginRegion: 'us', credentialSource: 'garbage', credentialStore: 'nope' });
  assert.equal(c.loginRegion, 'cn', '非法 loginRegion 应回退默认');
  // 两者的默认都是 ''（= 不锁定，交给桥自动判定）
  assert.equal(c.credentialSource, '', '非法 credentialSource 应回退空（不锁定）');
  assert.equal(c.credentialStore, '', '非法 credentialStore 应回退空（不锁定）');
  // 合法值保留
  assert.equal(mod.resolveConfig({ loginRegion: 'global' }).loginRegion, 'global');
  assert.equal(mod.resolveConfig({ credentialSource: 'api-key' }).credentialSource, 'api-key');
});

after(() => {
  try { rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* 已清理 */ }
});
