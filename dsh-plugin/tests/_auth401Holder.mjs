/**
 * 「一个活着、但一律回 401 的桥」—— 仅供 consoleStop.test.mjs 使用。
 *
 * 模拟场景：桥在跑，但控制台手里的令牌跟它不一致（改过 .env、用旧配置起过桥）。
 * 这是**真实的桥**，只是我们认证不过 —— 因此控制台应当仍然能把它停掉，
 * 而不是误报"端口上那个不是 workbuddy-bridge"。
 *
 * ## ⚠️ 401 的响应体必须与真桥**逐字一致**
 *
 * 控制台的归属校验（`isOurBridge`）不能在只看到「401」这一件事时就下结论：
 * 用户自己的 dev server / API mock 回 401 也是常有的事，而那个判定后面跟着
 * 的是 `taskkill /F` —— 实测过无关进程被杀死（`.tmp-audit/p3-401-kill.mjs`）。
 *
 * 所以它现在要一份**正向证据**：响应体是本项目 `unauthorizedBody()` 的形状
 * （`error.message` 以 `workbuddy-bridge: bad or missing token` 开头，
 * 并且提到 `WORKBUDDY_LOCAL_TOKEN` / `.bridge-token`）。
 *
 * 这个桩原先只回 `{ error: { message: 'bad or missing token' } }` —— 比真桥少了
 * 关键标识，于是「给证据之后就不再认自家桥」这件事被它掩盖了：桩要是忠实于
 * 真桥，那条用例本来就能同时验证「自家的能停」与「别人的不能停」两件事。
 *
 *   node dsh-plugin/tests/_auth401Holder.mjs
 */
import { createServer } from 'node:http';

/**
 * 与 `bridge/workbuddy-bridge.mjs` 的 `unauthorizedBody()` 同形。
 *
 * 只保留判定用得上的部分：真实实现里 hints 是一大段处置指引（十几行），
 * 这里保留首句与「新令牌在这里 / WORKBUDDY_LOCAL_TOKEN」这些**唯一标识**，
 * 其余内容对归属校验没有影响。
 */
const UNAUTHORIZED_BODY = {
  error: {
    message: [
      'workbuddy-bridge: bad or missing token',
      '',
      '新令牌在这里：',
      '  · 或读文件 dsh-plugin/.bridge-token',
      '想固定成自己的值：在 .env 里设 WORKBUDDY_LOCAL_TOKEN=<你的值>。',
    ].join('\n'),
    type: 'invalid_api_key',
    code: 'invalid_api_key',
  },
};

const server = createServer((req, res) => {
  res.writeHead(401, { 'content-type': 'application/json' });
  res.end(JSON.stringify(UNAUTHORIZED_BODY));
});

server.listen(0, '127.0.0.1', () => {
  process.stdout.write(`${server.address().port}\n`);
});
