/**
 * 控制台启动的两个行为回归（本轮用户诉求）：
 *
 *   ① 「启动控制台给我自动跳浏览器」
 *      —— 用户点了才开，**不能**变成"每次 dsh 启动都弹窗"。
 *   ② 「为什么有时候我在插件里面重启不了、到控制台就可以」
 *      —— 插件的 stop() 必须有强杀兜底，且**不能**因此误杀无关进程。
 *
 * 这两条都容易被后来的重构悄悄改坏：
 *   · ① 最"顺手"的写法是把 DASHBOARD_OPEN_BROWSER 设成 1 —— 那就退化成
 *     进程级开关，dsh 后台拉起时也会弹窗；
 *   · ② 最"顺手"的写法是把 ownsPid 放宽成"形状像桥就杀" —— 那会误杀别人的服务
 *     （audit3 用例钉的另一面）。
 *
 *   node --test dsh-plugin/tests/console-launch.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

test('① 控制台进程本身仍然「不自动弹浏览器」（DASHBOARD_OPEN_BROWSER 恒为 0）', () => {
  const src = read('dsh-plugin/lib/console.mjs');
  /*
   * 插件拉起控制台时必须是 '0'：那是**后台**拉起（dsh 启动、闲置退出后补拉）。
   * 用户主动要控制台时走 openInBrowser()，不是改这个开关。
   */
  assert.match(src, /DASHBOARD_OPEN_BROWSER:\s*'0'/, 
    '插件拉起控制台必须保持 DASHBOARD_OPEN_BROWSER=0（否则每次 dsh 启动都弹窗）');
});

test('① 控制台提供 openInBrowser()，且用户主动启动时会调用它', () => {
  const consoleSrc = read('dsh-plugin/lib/console.mjs');
  assert.match(consoleSrc, /openInBrowser\(\)\s*\{/, 'ConsoleSupervisor 应提供 openInBrowser()');
  // 三个平台都要覆盖：Windows 用 cmd/start，mac 用 open，其它 xdg-open
  assert.match(consoleSrc, /win32:\s*\['cmd',\s*\['\/c',\s*'start'/);
  assert.match(consoleSrc, /darwin:\s*\['open'/);
  assert.match(consoleSrc, /xdg-open/);

  /*
   * 两个**用户主动**入口都要调：面板按钮（routes）与 /workbuddy console 命令（index）。
   * 只改一处的话，另一个入口仍是"只给地址、不打开"。
   */
  const routesSrc = read('dsh-plugin/lib/routes.mjs');
  assert.match(routesSrc, /consoleSupervisor\.openInBrowser\(\)/,
    '面板「启动控制台」应在就绪后打开浏览器');
  const indexSrc = read('dsh-plugin/lib/index.js');
  assert.match(indexSrc, /consoleSupervisor\.openInBrowser\(\)/,
    '/workbuddy console 命令应在就绪后打开浏览器');
});

test('① 打不开浏览器不能让「启动控制台」整体失败', () => {
  const src = read('dsh-plugin/lib/routes.mjs');
  /*
   * openInBrowser 抛错时，路由仍要 200 + `ok: true`（服务确实起来了），
   * 只是 `opened: false`。否则用户会因为"浏览器没弹"而以为控制台没启动。
   */
  assert.match(src, /opened:\s*opened\.ok\s*===\s*true/);
  assert.match(src, /typeof consoleSupervisor\.openInBrowser === 'function'/,
    '缺少 openInBrowser 的桩（装配测试）不应让路由 500');
});

test('② stop() 有强杀兜底（SIGTERM 不生效时不能直接放弃）', () => {
  const src = read('dsh-plugin/lib/bridge.mjs');
  assert.match(src, /async forceKill\(/, 'BridgeSupervisor 应有 forceKill()');
  // Windows 用 taskkill /T /F（/T 连子进程），其它平台 SIGKILL
  assert.match(src, /taskkill',\s*\['\/PID'/, 'Windows 强杀应走 taskkill');
  assert.match(src, /'\/T',\s*'\/F'/, 'taskkill 要带 /T（连子进程）与 /F（强制）');
  assert.match(src, /SIGKILL/, '非 Windows 应升级为 SIGKILL');
  /*
   * 关键：stop() 在 SIGTERM 超时后要**调用** forceKill，而不是直接 return 报错。
   * 这正是"插件里重启不了、控制台可以"的直接原因。
   */
  const stopBlock = src.slice(src.indexOf('async stop('), src.indexOf('async forceKill('));
  assert.match(stopBlock, /this\.forceKill\(/, 'stop() 超时后必须尝试 forceKill');
});

test('② 但**不能**因此误杀无关进程（安全边界仍在）', () => {
  const src = read('dsh-plugin/lib/bridge.mjs');
  /*
   * 放宽 ownsPid 是本轮的需求（旧版桥 / 控制台拉起的桥要能重启），
   * 但「形状像桥、build 却是另一个值」的进程必须仍然拒绝 ——
   * audit3-regressions 用例钉的是同一件事，这里从源码侧再守一道。
   */
  assert.match(src, /ownAuthDirs\(\)/, '放宽的判据必须落在"登录目录属于本项目"上');
  assert.match(src, /不是 workbuddy-bridge/, '拒绝时仍要给出明确原因');
  // 判据里不能出现"只要 build 非空就认"这种无归属证明的写法
  assert.doesNotMatch(src, /if \(expected && actual\) return \{ ok: true/,
    '不能仅凭"上报了 build"就认（那会误杀别人的服务）');
});
