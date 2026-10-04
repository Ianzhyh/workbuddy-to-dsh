/**
 * 「占住一个端口」的独立子进程 —— 仅供 consoleStop.test.mjs 使用。
 *
 * 为什么要单独开一个进程：`stopBridgeAndWait` 会**真的**把端口上的监听者杀掉。
 * 如果测试自己在同进程里 listen，被杀的 PID 就是测试进程自己 ——
 * `taskkill /F` 一枪下去，现场连断言报错都看不到（进程是被外部结束的，
 * uncaughtException 都不触发），只剩一句笼统的 "test failed"。
 *
 * 所以让这个子进程来当"那个该死的桥"：它占住端口、把端口号打在 stdout 第一行
 * （OS 分配，绝不硬编码），然后什么都不做，等信号。
 *
 *   node dsh-plugin/tests/_holder.mjs
 */
import { createServer } from 'node:http';

const server = createServer((req, res) => { res.writeHead(200); res.end('holder'); });

server.listen(0, '127.0.0.1', () => {
  // 必须是**第一行**：父进程按行读取，多打一个字都会解析失败
  process.stdout.write(`${server.address().port}\n`);
});
