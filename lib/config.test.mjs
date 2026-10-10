/**
 * 配置解析测试（`config.mjs`）。
 *
 * 这个文件此前**零直接单测**，但它是全项目唯一配置真源：控制台与桥的每一个
 * 数值参数（端口、超时、限流、缓存时长）都经它流转。它读 `process.env` 是
 * **导入时求值**的，无法在用例里改环境变量，所以这里用「子进程 + 环境变量」
 * 的方式测 —— 也正好顺带验证 `.env` 与真实进程环境两条路径。
 *
 * 重点不是"默认值对不对"，而是**用户写错值时会不会静默变成 NaN**：
 * 一个 `.env` 里的拼写错误不应该表现为"端口 NaN / 超时 NaN"这种看不懂的症状。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CONFIG_URL = new URL('../config.mjs', import.meta.url).href;

const FIELDS = {
  bridgePort: 'config.bridge.port',
  bridgeUrl: 'config.bridge.url',
  chatUrl: 'config.bridge.chatUrl',
  modelsUrl: 'config.bridge.modelsUrl',
  healthUrl: 'config.bridge.healthUrl',
  dashPort: 'config.dashboard.port',
  dashUrl: 'config.dashboard.url',
  timeout: 'config.bridge.upstreamTimeoutMs',
  quota: 'config.bridge.quotaTtlMs',
  rpm: 'config.bridge.rateLimitRpm',
  minInterval: 'config.bridge.rateLimitMinIntervalMs',
  mode: 'config.bridge.rateLimitMode',
  alert: 'config.bridge.activeAlertMs',
  appVersion: 'config.bridge.appVersion',
};

/** 起一个子进程跑一段 ESM，回传 stdout。用异步 spawn：同步版在本机会反复
 *  撞 `EBUSY`（Windows 上同一镜像被父进程占用时 execFileSync 会拒绝）。 */
function runNode(script, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(`子进程退出码 ${code}\n${err}`));
      else resolve(out);
    });
  });
}

/**
 * 在指定环境变量下导入 config.mjs，回传关注的字段。
 * 用子进程是因为 config 在 import 时就把 env 固化进对象了。
 */
async function loadConfig(envOverrides = {}) {
  const picks = Object.entries(FIELDS).map(([k, expr]) => `${k}: ${expr}`).join(',\n  ');
  const script = `const { config } = await import(${JSON.stringify(CONFIG_URL)});
process.stdout.write(JSON.stringify({
  ${picks}
}));`;
  // 值为 undefined 的键要从 env 里去掉（子进程只认字符串）
  const env = { ...process.env };
  for (const [k, v] of Object.entries(envOverrides)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return JSON.parse(await runNode(script, env));
}

/** 断言某个字段是有限数值（不是 NaN / null / 字符串）。 */
function assertFinite(value, label) {
  assert.equal(typeof value, 'number', `${label} 必须是 number，实际 ${typeof value}`);
  assert.ok(Number.isFinite(value), `${label} 不能是 NaN/Infinity，实际 ${value}`);
}

// ── 默认值：没有环境变量时的基线 ────────────────────────────────────────

test('默认值：端口、超时、缓存、限流都落在预期基线', async () => {
  const c = await loadConfig({
    WORKBUDDY_PORT: '', DASHBOARD_PORT: '', WORKBUDDY_TIMEOUT_MS: '',
    WORKBUDDY_QUOTA_TTL_MS: '', WORKBUDDY_RATE_LIMIT_RPM: '',
  });
  assert.equal(c.bridgePort, 8790);
  assert.equal(c.dashPort, 8792);
  assert.equal(c.timeout, 0, '默认不加超时（这是产品设计：桥不设默认超时）');
  assert.equal(c.quota, 60000);
  assert.equal(c.rpm, 0, '限流默认关闭');
  assert.equal(c.mode, 'queue');
});

test('URL 派生字段与实际端口一致（改端口后不能还指向旧地址）', async () => {
  const c = await loadConfig({ WORKBUDDY_PORT: '9123', DASHBOARD_PORT: '9124' });
  assert.equal(c.bridgeUrl, 'http://127.0.0.1:9123');
  assert.equal(c.chatUrl, 'http://127.0.0.1:9123/v1/chat/completions');
  assert.equal(c.modelsUrl, 'http://127.0.0.1:9123/v1/models');
  assert.equal(c.healthUrl, 'http://127.0.0.1:9123/health');
  assert.equal(c.dashUrl, 'http://127.0.0.1:9124');
});

// ── 非法数值：必须是"回退到默认"，而不是静默 NaN ────────────────────────
//
// 这些是最容易发生的用户错误：`.env` 里手滑（`WORKBUDDY_PORT=879O` 字母 O、
// 多一个空格、写成 `8790ms`）。旧行为是 Number('879O') === NaN 直接进对象，
// 后果是监听报错 / 超时立即触发，而错误信息里看不出是配置写错了。

test('非法数值型环境变量必须回退到默认值，而不是变成 NaN', async () => {
  const cases = [
    ['WORKBUDDY_PORT', 'bridgePort', 8790],
    ['DASHBOARD_PORT', 'dashPort', 8792],
    ['WORKBUDDY_QUOTA_TTL_MS', 'quota', 60000],
    ['WORKBUDDY_RATE_LIMIT_RPM', 'rpm', 0],
    ['WORKBUDDY_RATE_LIMIT_MIN_INTERVAL_MS', 'minInterval', 0],
    ['WORKBUDDY_ACTIVE_ALERT_MS', 'alert', 300000],
  ];
  for (const [envName, field, expected] of cases) {
    const c = await loadConfig({ [envName]: 'abc' });
    assert.equal(c[field], expected, `${envName}=abc 应回退到 ${expected}，实际 ${c[field]}`);
    assertFinite(c[field], `${envName}=abc → ${field}`);
  }
});

test('WORKBUDDY_TIMEOUT_MS 非法时回退 0（NaN 会让超时立即触发，比不设更糟）', async () => {
  for (const bad of ['abc', '8790ms', ' ', '1e', 'NaN', 'Infinity']) {
    const c = await loadConfig({ WORKBUDDY_TIMEOUT_MS: bad });
    assert.equal(c.timeout, 0, `WORKBUDDY_TIMEOUT_MS=${JSON.stringify(bad)} 必须回退 0`);
  }
});

test('端口非法时，派生 URL 也不能出现 NaN', async () => {
  const c = await loadConfig({ WORKBUDDY_PORT: 'abc', DASHBOARD_PORT: 'abc' });
  for (const [label, url] of [['bridgeUrl', c.bridgeUrl], ['chatUrl', c.chatUrl], ['dashUrl', c.dashUrl]]) {
    assert.ok(!/NaN/u.test(url), `${label} 不能含 NaN：${url}`);
  }
  assert.equal(c.bridgeUrl, 'http://127.0.0.1:8790');
});

// ── 边界值：数值给对了也要挡住明显不合理的范围 ──────────────────────────

test('端口超出 1..65535 时回退到默认（listen 会失败且错误难懂）', async () => {
  for (const bad of ['0', '-1', '65536', '99999', '70000']) {
    const c = await loadConfig({ WORKBUDDY_PORT: bad, DASHBOARD_PORT: bad });
    assert.equal(c.bridgePort, 8790, `WORKBUDDY_PORT=${bad} 应回退默认`);
    assert.equal(c.dashPort, 8792, `DASHBOARD_PORT=${bad} 应回退默认`);
  }
});

test('端口合法边界值原样保留（1 与 65535 都是合法的）', async () => {
  assert.equal((await loadConfig({ WORKBUDDY_PORT: '1' })).bridgePort, 1);
  assert.equal((await loadConfig({ WORKBUDDY_PORT: '65535' })).bridgePort, 65535);
});

test('负数的超时 / 缓存 / 限流被规整为非负，不会被当成"负数超大值"', async () => {
  assert.equal((await loadConfig({ WORKBUDDY_TIMEOUT_MS: '-5' })).timeout, 0, '负超时等于立即超时，必须归零');
  assert.equal((await loadConfig({ WORKBUDDY_QUOTA_TTL_MS: '-5' })).quota, 60000, '负缓存时长回退默认');
  assert.equal((await loadConfig({ WORKBUDDY_RATE_LIMIT_RPM: '-5' })).rpm, 0);
  assert.equal((await loadConfig({ WORKBUDDY_RATE_LIMIT_MIN_INTERVAL_MS: '-5' })).minInterval, 0);
});

test('小数端口按整数处理（8790.7 不能变成非法端口）', async () => {
  const c = await loadConfig({ WORKBUDDY_PORT: '8790.7' });
  assert.ok(Number.isInteger(c.bridgePort), `端口必须是整数，实际 ${c.bridgePort}`);
  assert.equal(c.bridgePort, 8790);
});

test('限流模式只认 "reject"，其余一律 queue', async () => {
  assert.equal((await loadConfig({ WORKBUDDY_RATE_LIMIT_MODE: 'reject' })).mode, 'reject');
  for (const bad of ['REJECT', 'rejct', 'drop', '']) {
    assert.equal((await loadConfig({ WORKBUDDY_RATE_LIMIT_MODE: bad })).mode, 'queue', `mode=${bad} 应回落 queue`);
  }
});

// ── `.env` 解析：用户会从 README / 别处粘贴 `export` 形式的行 ──────────────
//
// 这是真实会发生的：`.env` 与 shell 脚本的写法很像，粘一行
// `export WORKBUDDY_PORT=8901` 进来，若解析器把它当成键名
// "export WORKBUDDY_PORT"，配置就**静默失效** —— 用户以为改了端口，
// 实际还在 8790 上，且没有任何提示。这类"配置不生效"最难排查。

test('.env 里的 `export KEY=VALUE` 行必须被当成 KEY=VALUE', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cfg-env-'));
  try {
    // 造一个"迷你仓库"：把 config.mjs 与其依赖 lib/ 拷过去，再放 .env
    // （config.mjs 从**自身所在目录**读 .env，无法用环境变量重定向）
    const root = join(dir, 'repo');
    mkdirSync(root, { recursive: true });
    copyFileSync(fileURLToPath(new URL('../config.mjs', import.meta.url)), join(root, 'config.mjs'));
    cpSync(fileURLToPath(new URL('.', import.meta.url)), join(root, 'lib'), { recursive: true });
    writeFileSync(join(root, '.env'), 'export WORKBUDDY_PORT=8901\n');

    const out = await runNode(`
      const { config } = await import(${JSON.stringify(pathToFileURL(join(root, 'config.mjs')).href)});
      process.stdout.write(String(config.bridge.port));
    `, (() => {
      // 清掉可能干扰的变量；确保只有 .env 在起作用
      const env = { ...process.env };
      delete env.WORKBUDDY_PORT;
      delete env.WORKBUDDY_ENV_FILE;
      return env;
    })());
    assert.equal(out, '8901', '`export KEY=VALUE` 必须被识别（否则用户粘贴的配置静默失效）');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── dsh 路径：`DSH_HOME` 必须在**读取那一刻**生效 ────────────────────────
//
// 现场：`config.dsh` 原先在 import 那一刻就把 home / settingsPath / credentialsPath /
// profileDir 全算成常量了。于是「先 import 再设 DSH_HOME」—— 也就是**最自然的写法**
// （测试这么做、`启动.cmd` 这类脚本也可能先加载再补环境）—— 会静默失效：
// 用户以为配置改到了别处，实际还在 `~/.dsh`，而**写 dsh 配置是会动用户文件的**，
// 认错地方就可能往真实 profile 里写路由。
//
// 用 getter 修（而不是把四处调用点全改成函数调用）：所有消费点都是普通属性读取，
// getter 让它们一行都不用动，也不会漏掉某一处。

test('dsh 路径：import 之后设 DSH_HOME 也必须生效（不能是加载时定死的常量）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cfg-dsh-'));
  try {
    const target = join(dir, 'moved-dsh');
    const out = await runNode(`
      const { config } = await import(${JSON.stringify(CONFIG_URL)});
      const before = config.dsh.home;
      process.env.DSH_HOME = ${JSON.stringify(target)};
      process.stdout.write(JSON.stringify({
        before,
        home: config.dsh.home,
        settingsPath: config.dsh.settingsPath,
        credentialsPath: config.dsh.credentialsPath,
        profileDir: config.dsh.profileDir,
      }));
    `, (() => {
      const env = { ...process.env };
      delete env.DSH_HOME;               // 确保"改之前"走的是默认
      return env;
    })());

    const got = JSON.parse(out);
    assert.match(got.before, /[\\/]\.dsh$/u, `默认应是家目录下的 .dsh，实际 ${got.before}`);
    assert.equal(got.home, target, 'DSH_HOME 改了之后 home 必须跟着变');
    // 三个派生路径也必须跟着走 —— 否则会把 dsh 配置写到旧位置
    assert.equal(got.settingsPath, join(target, 'settings.yaml'));
    assert.equal(got.credentialsPath, join(target, '.credentials.yaml'));
    assert.equal(got.profileDir, join(target, 'profiles', 'desktop'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dsh 路径：DSH_HOME 为空/未设时回落到家目录，且始终是绝对路径', async () => {
  for (const value of [undefined, '', '   ']) {
    const dir = mkdtempSync(join(tmpdir(), 'cfg-dsh2-'));
    try {
      const out = await runNode(`
        const { config } = await import(${JSON.stringify(CONFIG_URL)});
        process.stdout.write(config.dsh.home);
      `, (() => {
        const env = { ...process.env };
        if (value === undefined) delete env.DSH_HOME; else env.DSH_HOME = value;
        return env;
      })());
      assert.match(out, /[\\/]\.dsh$/u, `DSH_HOME=${JSON.stringify(value)} 时应回落到 ~/.dsh，实际 ${out}`);
      assert.match(out, /^([A-Za-z]:[\\/]|\/)/u, `必须是绝对路径，实际 ${out}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
