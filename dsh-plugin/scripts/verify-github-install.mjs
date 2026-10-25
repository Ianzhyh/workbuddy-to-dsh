/**
 * GitHub 直装形态演练（issue #3 的发布前门禁）。
 *
 * 为什么需要它：`verify-standalone` 演练的是「只有 dsh-plugin/ 文件夹 + vendor」
 * 的 tgz 形态；而 `dsh plugin add github:Ianzhyh/workbuddy-to-dsh` 装的是
 * **仓库根包**。两者文件布局、包名、Loader 条目名都不同 —— issue #3 正是
 * 只验了前者，漏掉了后者的客户端模块 id，直到用户启动失败才发现。
 *
 * 这里按用户真实路径走一遍：
 *   1. `npm pack` 仓库根（GitHub 直装拿到的就是这棵树）；
 *   2. `npm install` 进临时 profile 的 node_modules/workbuddy-to-dsh；
 *   3. 校验包名 = cordis.patch.yml 的 Loader 名 = 客户端注册 id；
 *   4. 从安装后的位置 import 宿主入口，确认 projectRoot / 必需文件；
 *   5. 用 dsh 的 `/plugins/<id>/client.js` 加载语义执行客户端 bundle。
 *
 *   npm run verify:github
 *
 * 临时目录、随机端口都不碰本机正在使用的资源；失败非零退出。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN = dirname(SCRIPT_DIR);
const REPO = dirname(PLUGIN);
const ROOT_PKG = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
const SUB_PKG = JSON.parse(readFileSync(join(PLUGIN, 'package.json'), 'utf8'));
const PATCH_ENTRY_RE = /-\s*insert:\s*\r?\n\s*-\s*id:\s*([^\s#]+)\s*\r?\n\s*name:\s*([^\s#]+)/;

let failed = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? '✅' : '❌'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed += 1;
};
const readPatchEntry = (file) => {
  const m = PATCH_ENTRY_RE.exec(readFileSync(file, 'utf8'));
  if (!m) throw new Error(`找不到 insert 条目：${file}`);
  return { id: m[1], name: m[2] };
};
const runNpm = (args, cwd) => {
  const npmCli = process.env.npm_execpath;
  const out = npmCli && existsSync(npmCli)
    ? spawnSync(process.execPath, [npmCli, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    : spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32',
    });
  if (out.error) throw new Error(`npm ${args.join(' ')} 起不来：${out.error.message}`);
  if (out.status !== 0) {
    throw new Error(`npm ${args.join(' ')} 失败（exit ${out.status}，signal ${out.signal || '无'}）：${String(out.stderr || out.stdout || '').slice(0, 500)}`);
  }
  return out.stdout || '';
};
const clientIds = (clientSrc, { scriptSrc } = {}) => {
  const ids = [];
  const sandbox = { window: { __ModuleLoader__: { load: (handoff) => ids.push(handoff.id) } } };
  if (scriptSrc) sandbox.document = { currentScript: { src: scriptSrc } };
  vm.runInNewContext(clientSrc, sandbox, { filename: 'client.js' });
  return ids;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitForHttp = async (url, { headers, ms = 20000 } = {}) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(3000) });
      return { status: res.status, text: await res.text().catch(() => '') };
    } catch { await sleep(400); }
  }
  return null;
};

const sandbox = mkdtempSync(join(tmpdir(), 'wb-github-drill-'));
const children = [];
const packDir = join(sandbox, 'pack');
const profileDir = join(sandbox, 'profile');
const prevRoot = process.env.WORKBUDDY_ROOT;
delete process.env.WORKBUDDY_ROOT;
let installedDir = '';

try {
  console.log(`仓库根包：${ROOT_PKG.name}@${ROOT_PKG.version}\n`);

  // ── 1. 打包仓库根（与 github 直装拿到的文件集一致）
  mkdirSync(packDir, { recursive: true });
  const packed = JSON.parse(runNpm(['pack', REPO, '--json', '--pack-destination', packDir], sandbox));
  const asset = Array.isArray(packed) ? packed[0] : packed;
  const tgz = join(packDir, asset.filename);
  const rootPaths = (asset.files || []).map((f) => (typeof f === 'string' ? f : f.path || ''));
  check(existsSync(tgz), '仓库根能 npm pack', `${asset.filename}（${rootPaths.length} 项）`);
  // files 白名单收紧后，本地 npm pack 也不该把运行日志 / 备份 / 测试带进发布物
  const junk = rootPaths.filter((p) => /\.(?:log|jsonl)$/i.test(p) || /\.bak(?:-|$)/i.test(p) || /\.test\.mjs$/i.test(p));
  check(junk.length === 0, '根包不包含日志 / 备份 / 测试文件', junk.length ? junk.join(', ') : '干净');

  // ── 2. 装进临时 profile 的 node_modules（真实安装路径）
  mkdirSync(profileDir, { recursive: true });
  runNpm(['install', '--prefix', profileDir, '--no-save', '--ignore-scripts', '--no-audit', '--no-fund', tgz], profileDir);
  installedDir = join(profileDir, 'node_modules', ROOT_PKG.name);
  check(existsSync(installedDir), '根包能安装到 profile/node_modules', installedDir);

  const installedPkg = JSON.parse(readFileSync(join(installedDir, 'package.json'), 'utf8'));
  check(installedPkg.name === ROOT_PKG.name && installedPkg.version === ROOT_PKG.version,
    '安装后的包名 / 版本正确', `${installedPkg.name}@${installedPkg.version}`);

  // ── 3. Loader 名 = 包名 = 客户端 id（issue #3 的核心）
  const entry = readPatchEntry(join(installedDir, 'cordis.patch.yml'));
  check(entry.name === installedPkg.name,
    'cordis.patch.yml 的 Loader 名等于包名', `${entry.id} → ${entry.name}`);
  const clientRel = installedPkg.exports?.['./client'];
  const clientPath = typeof clientRel === 'string' ? resolve(installedDir, clientRel) : '';
  check(Boolean(clientPath && existsSync(clientPath)), 'exports["./client"] 指向真实文件', clientRel || '（缺失）');

  const clientSrc = readFileSync(clientPath, 'utf8');
  const fixedIds = clientIds(clientSrc);
  check(fixedIds.includes(entry.name),
    'client.js 的固定注册列表覆盖 Loader 名', fixedIds.join(', '));
  const byUrl = clientIds(clientSrc, {
    scriptSrc: `dsh-app://app/plugins/${entry.name}/client.js?rev=drill`,
  });
  check(byUrl.includes(entry.name),
    '按 /plugins/<entry>/client.js 加载时注册 Loader 名', byUrl.join(', '));

  // ── 4. 宿主入口与运行时文件（安装后的相对路径必须都对）
  const required = [
    'bridge/workbuddy-bridge.mjs',
    'bridge/promotions.mjs',
    'dashboard/server.mjs',
    'dashboard/public/index.html',
    'dashboard/public/style.css',
    'config.mjs',
    'lib/state.mjs',
    'lib/diagnostics.mjs',
    'dsh-plugin/lib/index.js',
    'dsh-plugin/lib/client.js',
    'dsh-plugin/lib/packageNames.mjs',
    'dsh-plugin/vendor/bridge/workbuddy-bridge.mjs',
    'dsh-plugin/vendor/bridge/promotions.mjs',
  ];
  const missing = required.filter((rel) => !existsSync(join(installedDir, rel)));
  check(missing.length === 0, '根包包含全部运行时文件', missing.length ? `缺少 ${missing.join(', ')}` : `${required.length} 项齐全`);

  const mod = await import(`${pathToFileURL(join(installedDir, 'dsh-plugin', 'lib', 'index.js')).href}?drill=${Date.now()}`);
  const projectRoot = mod.detectProjectRoot();
  check(projectRoot && realpathSync(projectRoot) === realpathSync(installedDir),
    '宿主入口把 projectRoot 解析到安装目录', projectRoot);
  const config = mod.resolveConfig({ autoStart: false, consoleAutoStart: false });
  check(config.provider === 'workbuddy' && config.bridgePort > 0,
    '安装后的配置解析正常', `provider=${config.provider} bridge=${config.bridgePort}`);

  // ── 5. 子包 / tgz 形态：同样真实 pack + install，别只信"目录里看着有"
  const subEntry = readPatchEntry(join(PLUGIN, 'cordis.patch.yml'));
  check(subEntry.name === SUB_PKG.name,
    '子包 cordis.patch.yml 的 Loader 名等于包名', `${subEntry.id} → ${subEntry.name}`);

  const subPackDir = join(sandbox, 'pack-sub');
  mkdirSync(subPackDir, { recursive: true });
  const subPacked = JSON.parse(runNpm(['pack', PLUGIN, '--json', '--pack-destination', subPackDir], sandbox));
  const subAsset = Array.isArray(subPacked) ? subPacked[0] : subPacked;
  const subTgz = join(subPackDir, subAsset.filename);
  const packedPaths = (subAsset.files || []).map((f) => (typeof f === 'string' ? f : f.path || ''));
  const neededInTgz = [
    'package.json',
    'cordis.patch.yml',
    'lib/index.js',
    'lib/client.js',
    'lib/packageNames.mjs',
    'scripts/preflight.mjs',
    'vendor/bridge/workbuddy-bridge.mjs',
    'vendor/bridge/promotions.mjs',
    'vendor/dashboard/server.mjs',
    'vendor/config.mjs',
  ];
  const notPacked = neededInTgz.filter((p) => !packedPaths.includes(p));
  check(notPacked.length === 0, '子包 tgz 包含全部运行时文件', notPacked.length ? `缺少 ${notPacked.join(', ')}` : `${neededInTgz.length} 项齐全`);

  const subProfileDir = join(sandbox, 'profile-sub');
  mkdirSync(subProfileDir, { recursive: true });
  runNpm(['install', '--prefix', subProfileDir, '--no-save', '--ignore-scripts', '--no-audit', '--no-fund', subTgz], subProfileDir);
  const subInstalledDir = join(subProfileDir, 'node_modules', SUB_PKG.name);
  check(existsSync(subInstalledDir), '子包 tgz 能安装到 profile/node_modules', subInstalledDir);

  const subByUrl = clientIds(readFileSync(join(subInstalledDir, 'lib', 'client.js'), 'utf8'), {
    scriptSrc: `dsh-app://app/plugins/${subEntry.name}/client.js?rev=drill`,
  });
  check(subByUrl.includes(subEntry.name),
    '子包按 /plugins/<entry>/client.js 加载时也注册 Loader 名', subByUrl.join(', '));
  const subMod = await import(`${pathToFileURL(join(subInstalledDir, 'lib', 'index.js')).href}?drill=${Date.now()}`);
  check(realpathSync(subMod.detectProjectRoot()) === realpathSync(join(subInstalledDir, 'vendor')),
    '子包把 projectRoot 解析到自带 vendor/', subMod.detectProjectRoot());

  // ── 6. 安装后的根包真的能起桥与控制台：files 白名单漏一个运行时文件就会在这里现形
  const bridgePort = 18891;
  const consolePort = 18893;
  const fakeAuth = join(sandbox, 'fake-auth.info');
  writeFileSync(fakeAuth, JSON.stringify({ userId: 'drill', accessToken: 'x', expiresAt: Date.now() + 86400000 }));
  const bridge = spawn(process.execPath, [join(installedDir, 'bridge', 'workbuddy-bridge.mjs')], {
    cwd: installedDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      WORKBUDDY_HOST: '127.0.0.1',
      WORKBUDDY_PORT: String(bridgePort),
      WORKBUDDY_LOCAL_TOKEN: 'drill-token',
      WORKBUDDY_LOG: '1',
      WORKBUDDY_AUTH_FILE: fakeAuth,
      // 沙箱桥绝不能读到本机真实的插件登录凭据
      WORKBUDDY_CREDENTIAL_DIR: join(sandbox, 'credentials'),
    },
  });
  children.push(bridge);
  let bridgeOut = '';
  bridge.stdout.on('data', (d) => { bridgeOut += d; });
  bridge.stderr.on('data', (d) => { bridgeOut += d; });
  const up = await waitForHttp(`http://127.0.0.1:${bridgePort}/`, { ms: 20000 });
  check(up !== null, '根包的桥能启动并监听', `端口 ${bridgePort}`);
  if (up) {
    const health = await waitForHttp(`http://127.0.0.1:${bridgePort}/health`, {
      headers: { authorization: 'Bearer drill-token' }, ms: 8000,
    });
    check(health?.status === 503 && /login file/i.test(health.text),
      '假登录文件下 /health 如实报 503', health ? `HTTP ${health.status}` : '无响应');
  } else {
    console.log('   桥的输出：\n' + bridgeOut.split('\n').slice(-8).map((l) => '     ' + l).join('\n'));
  }

  const consoleProc = spawn(process.execPath, [join(installedDir, 'dashboard', 'server.mjs')], {
    cwd: installedDir,
    stdio: 'ignore',
    env: {
      ...process.env,
      DASHBOARD_PORT: String(consolePort),
      DASHBOARD_AUTO_START_BRIDGE: '0',
      DASHBOARD_OPEN_BROWSER: '0',
      WORKBUDDY_AUTH_FILE: fakeAuth,
    },
  });
  children.push(consoleProc);
  const page = await waitForHttp(`http://127.0.0.1:${consolePort}/`, { ms: 25000 });
  check(page !== null && /id="navTabs"/.test(page.text),
    '根包的控制台能启动且页面结构完整', `端口 ${consolePort}`);
} catch (error) {
  check(false, '演练异常', error?.message || String(error));
} finally {
  for (const child of children) {
    if (child?.pid) { try { child.kill(); } catch { /* 已退出 */ } }
  }
  await sleep(500);
  if (prevRoot !== undefined) process.env.WORKBUDDY_ROOT = prevRoot;
  rmSync(sandbox, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} 项不通过` : '\n两种安装形态演练（github 直装 + tgz）全部通过');
process.exit(failed ? 1 : 0);
