/**
 * 「一个回 401、但和 workbuddy 毫无关系的服务」—— 仅供 consoleStop.test.mjs 使用。
 *
 * 模拟场景：用户自己的 dev server / API mock / 代理占着桥的端口（默认 8790），
 * 它要求鉴权，于是对任何请求都回 401。
 *
 * ## 为什么这个桩必须存在（实测事故）
 *
 * 控制台的 `isOurBridge()` 原先**只凭 `status === 401`** 就认定"这是我们自己的桥"，
 * 随后 `stopBridge()` 会 `taskkill /F` 掉那个 pid。实测（`.tmp-audit/p3-401-kill.mjs`）：
 *
 *   无关服务已监听 127.0.0.1:3496（/health 回 401）
 *   stopBridgeAndWait → {"stopped":true,"pid":47928}
 *   调用后该进程存活 = false
 *
 * 也就是说，用户点一下「停止桥服务」，被杀掉的是**自己的开发服务器**。
 * 这是整个控制台里唯一会主动破坏用户环境的行为，而它藏在一个标注为"安全"的守卫里。
 *
 * 修复后 401 只是**必要条件**：还要有正向证据（响应体是本项目 `unauthorizedBody()`
 * 的形状）才敢认领。这个桩故意回一个**别人的** 401（不带任何 workbuddy 标识），
 * 用来钉住"绝不能因为看到 401 就 kill"。
 *
 *   node dsh-plugin/tests/_foreign401Holder.mjs
 */
import { createServer } from 'node:http';

const server = createServer((req, res) => {
  // 一个典型的、要求 Bearer 鉴权的普通服务：只回状态码与标准错误体
  res.writeHead(401, {
    'content-type': 'application/json',
    'www-authenticate': 'Bearer realm="dev-server"',
  });
  res.end(JSON.stringify({ error: 'unauthorized', message: 'missing or invalid bearer token' }));
});

server.listen(0, '127.0.0.1', () => {
  process.stdout.write(`${server.address().port}\n`);
});
