/**
 * 测试里起桥时用的端口范围 —— **唯一的端口来源**。
 *
 *   import { pickBridgePort } from '../tools/dev/bridge-ports.mjs';
 *   const port = pickBridgePort();
 *
 * ## 为什么不能随手写 `20000 + Math.random() * 20000`
 *
 * 那个区间**和操作系统的临时端口段重叠**：打桩上游都走 `listen(0)`，内核把它们
 * 分到临时端口段里（Linux 默认 32768–60999，macOS / Windows 默认 49152–65535）。
 * 于是"随机挑一个固定端口"迟早会挑到**另一个测试文件刚被内核分配走的那个端口**。
 *
 * 实测（2026-10-27，v1.17.0 的发版门禁，ubuntu-latest）：
 *
 *   Error: listen EADDRINUSE: address already in use 127.0.0.1:39846
 *     startBridge (bridge/bridge.test.mjs:131)
 *
 * 39846 正在临时端口段内。那条用例当场失败，macOS 上同一个端口号刚好空闲，
 * 于是"同一份代码、一个平台红一个平台绿"。
 *
 * 后果还不止一次失败：`startBridge()` 抛错时**打桩上游已经 listen 了**，
 * 用例的 `finally` 根本没轮到执行，那个 listen socket 就一直挂在测试进程上 ——
 * `node --test` 等不到事件循环清空，**跑完全部用例后进程不退**，
 * GitHub Actions 只能按 `timeout-minutes` 取消整个 job（那次是 20 分钟后被 cancel）。
 * 也就是说：一个 1 秒就能暴露的端口撞车，被放大成了 20 分钟 + 一条 cancelled。
 *
 * ## 规则
 *
 * 只用 **12000–19999**：低于三大平台的临时端口下界，也避开桥 / 控制台的默认端口
 * （8790 / 8792）。撞车概率从"迟早"降到"需要同时起上百个桥"。
 *
 * 端口仍然是随机的（不是自增），这样同一台机器上并行跑两份测试不会从同一个
 * 起点开始互相踩。
 */

/** 起始端口（含）。留在 10000–20000 的空档里，避让 8790/8792 与临时端口段。 */
export const BRIDGE_PORT_MIN = 12000;

/** 结束端口（含）。 */
export const BRIDGE_PORT_MAX = 19999;

/**
 * 挑一个测试用端口。
 *
 * 注意这只是"挑"，不保证空闲 —— 所以起桥的那一侧仍然要能处理 EADDRINUSE
 * （见 `bridge.test.mjs` 的 `startBridge`：撞上就换端口重试，而不是直接判失败）。
 *
 * @returns {number} 12000–19999 之间的整数
 */
export function pickBridgePort() {
  const span = BRIDGE_PORT_MAX - BRIDGE_PORT_MIN + 1;
  return BRIDGE_PORT_MIN + Math.floor(Math.random() * span);
}

/**
 * 子进程输出里是否报了端口被占。
 *
 * 用来区分"换个端口就能好"（EADDRINUSE）与"换端口也没用"（配置写错、
 * 依赖缺失）—— 只有前者值得重试。
 *
 * @param {string} output 子进程的 stdout + stderr
 */
export function isPortInUseError(output) {
  return /EADDRINUSE|address already in use/i.test(String(output || ''));
}
