/**
 * 「一个**真的** workbuddy-bridge」的独立子进程 —— 仅供 consoleStop.test.mjs 使用。
 *
 * 与 `_holder.mjs` 的区别：`_holder.mjs` 是**无关进程**（回一段纯文本，
 * 不是桥的响应形状），用来验证「不该被杀」；本文件是**真桥**，
 * 用来验证「该杀的时候仍然杀得掉」—— 两个方向都要钉住，
 * 否则修 foreign 校验时容易把正常功能一起挡掉。
 *
 * 为什么必须起真进程、而不是在本进程里 mock：`stopBridgeAndWait` 会真的
 * `taskkill /F` 端口上的 PID，同进程 listen 等于自杀。
 *
 * 为什么不用真桥脚本（`bridge/workbuddy-bridge.mjs`）：那需要可用的登录凭证、
 * 会去连上游、还得处理真实凭据 —— 对一个「测停桥」的用例来说太重且不稳。
 * 这里只需要**能被认出来是桥**：回一个形状正确的 `/health` JSON。
 *
 * 输出：stdout 第一行 = 端口号（OS 分配，绝不硬编码，理由同 _holder.mjs）。
 *
 *   node dsh-plugin/tests/_bridgeHolder.mjs
 */
import { createServer } from 'node:http';

const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://127.0.0.1').pathname;
  /*
   * 只实现「让 BridgeSupervisor.probe() 认得出这是自己人」所需的最小面。
   *
   * probe() 的判据是：`health.ok === true && typeof health.pid === 'number'`
   * （见 dsh-plugin/lib/bridge.mjs:198）。控制台的归属校验用的是同一套判据，
   * 所以这里回这个形状即可。
   */
  if (path === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, pid: process.pid, version: 'test-holder' }));
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end('{}');
});

server.listen(0, '127.0.0.1', () => {
  // 必须是**第一行**：父进程按行读取，多打一个字都会解析失败
  process.stdout.write(`${server.address().port}\n`);
});
