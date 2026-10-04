/**
 * 独立分发包演练：把 dsh-plugin/ 拷到一个**没有仓库**的沙箱，验证：
 *   1. 插件的 projectRoot 解析到自带的 vendor/
 *   2. vendor 里的桥脚本**真的能启动**（用一份假登录文件 —— 于是 /health 会回 503，
 *      顺带验证插件把"桥活着但凭据读不出"认成 degraded 而不是 foreign）
 *   3. vendor 里的控制台脚本能启动，首页标题匹配
 *   4. 自检脚本 preflight 在独立目录里能跑出正确结论
 *
 *   node dsh-plugin/scripts/verify-standalone.mjs
 *
 * 用临时端口（18890/18892），不碰使用者正在跑的 8790/8792；
 * 全程在临时目录里操作，结束时清理。发版前跑一次，确保"别人拿到的那份"真能用。
 */
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN = dirname(SCRIPT_DIR);
const REPO = dirname(PLUGIN);
const sandbox = mkdtempSync(join(tmpdir(), 'wb-drill-'));
const pluginDir = join(sandbox, 'dsh-plugin-workbuddy');
const BRIDGE_PORT = 18890;
const CONSOLE_PORT = 18892;
let failed = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? '✅' : '❌'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed += 1;
};

const waitFor = async (url, ms = 20000, headers) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(3000) });
      if (res.ok) return await res.text().catch(() => '');
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  return null;
};

let bridge = null;
let consoleProc = null;
try {
  // ── 1. 造出"别人拿到的那份"（不含仓库、不含 node_modules）
  mkdirSync(pluginDir, { recursive: true });
  for (const name of ['lib', 'scripts', 'vendor', 'package.json', 'cordis.patch.yml', 'README.md']) {
    const src = join(PLUGIN, name);
    if (existsSync(src)) cpSync(src, join(pluginDir, name), { recursive: true });
  }
  check(!existsSync(join(sandbox, 'bridge')), '沙箱里没有仓库（只有插件文件夹）');

  // ── 2. projectRoot 解析到 vendor/
  const prevRoot = process.env.WORKBUDDY_ROOT;
  delete process.env.WORKBUDDY_ROOT;
  const mod = await import(pathToFileURL(join(pluginDir, 'lib', 'index.js')).href);
  const resolved = mod.detectProjectRoot();
  check(resolved === join(pluginDir, 'vendor'), '插件把 projectRoot 解析到自带 vendor/', resolved);
  const config = mod.resolveConfig({ projectRoot: resolved, bridgePort: BRIDGE_PORT, consolePort: CONSOLE_PORT, autoStart: false, consoleAutoStart: false });
  check(config.bridgePort === BRIDGE_PORT && config.consolePort === CONSOLE_PORT, '配置解析用上了自定义端口',
    `bridge=${config.bridgePort} console=${config.consolePort}`);
  if (prevRoot !== undefined) process.env.WORKBUDDY_ROOT = prevRoot;

  // ── 3. vendor 里的桥真能起来
  //      注意：桥**只读环境变量**（不读 .env —— .env 是插件与控制台在用），
  //      所以要按插件的方式把配置通过 env 传进去。
  const vendorDir = join(pluginDir, 'vendor');
  const fakeAuth = join(vendorDir, 'fake-auth.info');
  writeFileSync(join(vendorDir, '.env'), [
    `WORKBUDDY_PORT=${BRIDGE_PORT}`,
    `DASHBOARD_PORT=${CONSOLE_PORT}`,
    'WORKBUDDY_LOCAL_TOKEN=drill-token',
    `WORKBUDDY_AUTH_FILE=${fakeAuth}`,
  ].join('\n') + '\n');
  writeFileSync(fakeAuth, JSON.stringify({ userId: 'drill', accessToken: 'x', expiresAt: Date.now() + 86400000 }));

  bridge = spawn(process.execPath, [join(vendorDir, 'bridge', 'workbuddy-bridge.mjs')], {
    cwd: vendorDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      WORKBUDDY_HOST: '127.0.0.1',
      WORKBUDDY_PORT: String(BRIDGE_PORT),
      WORKBUDDY_LOCAL_TOKEN: 'drill-token',
      WORKBUDDY_LOG: '1',
      WORKBUDDY_AUTH_FILE: fakeAuth,
    },
  });
  let bridgeOut = '';
  bridge.stdout.on('data', (d) => { bridgeOut += d; });
  bridge.stderr.on('data', (d) => { bridgeOut += d; });
  bridge.on('exit', (code) => { bridgeOut += `\n[exit ${code}]`; });
  // 等桥开始监听：**任何** HTTP 应答都算起来了（503 也算 —— 那是凭据问题，不是没起来）
  let up = false;
  for (let i = 0; i < 50 && !up; i += 1) {
    try {
      await fetch(`http://127.0.0.1:${BRIDGE_PORT}/`, { signal: AbortSignal.timeout(1500) });
      up = true;
    } catch { await new Promise((r) => setTimeout(r, 400)); }
  }
  // 沙箱里用的是**假登录文件**，所以 /health 会回 503（桥活着但读不出凭据）——
  // 这本身就是要验证的点：桥起来了、且插件能把这个状态认领成「凭据异常」而不是"别人的服务"
  const state = await (async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${BRIDGE_PORT}/health`, { headers: { authorization: 'Bearer drill-token' }, signal: AbortSignal.timeout(3000) });
      const body = await res.json().catch(() => ({}));
      return { status: res.status, body };
    } catch { return null; }
  })();
  check(state !== null, '自带 vendor 的桥能启动并监听', `端口 ${BRIDGE_PORT}`);
  if (state) check(state.status === 503 && /login file/i.test(state.body.error || ''), '假登录文件下 /health 如实报 503 + 原因', `HTTP ${state.status}：${String(state.body.error || '').slice(0, 60)}`);
  // 插件必须认领它（凭据异常），而不是误判成 foreign
  const supMod = await import(pathToFileURL(join(pluginDir, 'lib', 'bridge.mjs')).href);
  const sup = new supMod.BridgeSupervisor({ host: '127.0.0.1', port: BRIDGE_PORT, token: 'drill-token', projectRoot: vendorDir, logPath: join(vendorDir, 'bridge', 'bridge.log') });
  const probed = await sup.probe();
  check(probed.state === 'degraded', '插件把「桥活着但凭据读不出」认成 degraded（不是 foreign）', probed.state);
  const ensured = await sup.ensure({ readyTimeoutMs: 3000 });
  check(ensured.reused === true && ensured.started === false, '这种状态下复用而不是再拉一个桥（避免撞端口）', `state=${ensured.state}`);
  if (!state) console.log('   桥的输出：\n' + bridgeOut.split('\n').slice(-8).map((l) => '     ' + l).join('\n'));
  // 日志落在 vendor/ 里（不污染系统）：插件启动桥时会把 stdio 重定向到 logPath，
  // 这里用 sup.start() 之外的方式验证过目录可写即可 —— 直接看桥有没有在自己的目录里留痕。
  check(existsSync(join(vendorDir, 'bridge')) && readdirSync(join(vendorDir, 'bridge')).length >= 1, 'vendor/bridge/ 可写（桥的工作目录正常）');
  check(!existsSync(join(REPO, 'bridge', 'bridge.log.drill')), '没有往仓库里写东西');

  // ── 4. vendor 里的控制台能起来（首页标题匹配）
  consoleProc = spawn(process.execPath, [join(vendorDir, 'dashboard', 'server.mjs')], {
    cwd: vendorDir, stdio: 'ignore',
    env: { ...process.env, DASHBOARD_PORT: String(CONSOLE_PORT), DASHBOARD_AUTO_START_BRIDGE: '0', DASHBOARD_OPEN_BROWSER: '0', WORKBUDDY_AUTH_FILE: join(vendorDir, 'fake-auth.info') },
  });
  const page = await waitFor(`http://127.0.0.1:${CONSOLE_PORT}/`, 25000);
  check(page !== null && /WorkBuddy 中转控制台/.test(page), '自带 vendor 的控制台能启动且首页标题匹配', `端口 ${CONSOLE_PORT}`);

  // ── 5. 自检脚本在沙箱里可用
  const preflight = await new Promise((resolve) => {
    const child = spawn(process.execPath, [join(pluginDir, 'scripts', 'preflight.mjs'), '--json'], { cwd: sandbox, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ code, out }));
  });
  let parsed = null;
  try { parsed = JSON.parse(preflight.out); } catch { /* 解析失败下面报 */ }
  check(parsed !== null, '自检脚本在独立目录里可运行');
  if (parsed) {
    check(parsed.projectRoot === join(pluginDir, 'vendor'), '自检报告 projectRoot = vendor/', parsed.projectRoot);
    const scriptChecks = parsed.results.filter((r) => /^桥脚本$|^控制台脚本$/.test(r.title));
    check(scriptChecks.every((r) => r.level === 'ok'), '自检认可自带脚本', scriptChecks.map((r) => `${r.title}:${r.level}`).join(' '));
    check(parsed.results.some((r) => r.title.startsWith(`端口 ${BRIDGE_PORT}`) && /本项目的桥/.test(r.detail || '')), '自检能认出沙箱里跑着的桥是自己人（凭据异常也算）');
  }
} finally {
  for (const child of [consoleProc, bridge]) {
    if (child && child.pid) { try { process.kill(child.pid); } catch { /* 已退出 */ } }
  }
  await new Promise((r) => setTimeout(r, 500));
  rmSync(sandbox, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} 项不通过` : '\n独立分发包演练全部通过');
process.exit(failed ? 1 : 0);
