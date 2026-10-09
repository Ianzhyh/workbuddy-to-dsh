/**
 * 「一个活着、但一律回 401 的桥」—— 仅供 consoleStop.test.mjs 使用。
 *
 * 模拟场景：桥在跑，但控制台手里的令牌跟它不一致（改过 .env、用旧配置起过桥）。
 * 这是**真实的桥**，只是我们认证不过 —— 因此控制台应当仍然能把它停掉，
 * 而不是误报"端口上那个不是 workbuddy-bridge"。
 *
 *   node dsh-plugin/tests/_auth401Holder.mjs
 */
import { createServer } from 'node:http';

const server = createServer((req, res) => {
  res.writeHead(401, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'bad or missing token' } }));
});

server.listen(0, '127.0.0.1', () => {
  process.stdout.write(`${server.address().port}\n`);
});
