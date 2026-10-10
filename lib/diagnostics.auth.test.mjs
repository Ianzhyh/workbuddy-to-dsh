/**
 * 「桥在跑，但拒绝本控制台的令牌（401）」必须被识别出来 —— 不许说成「桥未运行」。
 *
 *   node --test lib/diagnostics.auth.test.mjs
 *
 * ## 缺陷现场（本机实测）
 *
 * 桥与控制台**各自**解析本地令牌：控制台读 `dsh-plugin/.bridge-token`，
 * 而独立启动的桥（没配 `WORKBUDDY_LOCAL_TOKEN`）会自己生成一把随机令牌，
 * 只打印在启动日志里、不落盘。两边不一致时，桥对控制台的每个请求都回 401：
 *
 *   $ curl -H "Authorization: Bearer <控制台那份>" http://127.0.0.1:8790/health
 *   401
 *
 * 而界面上写的是「桥未运行」—— **一句假话**：桥明明在跑（端口有人应答、进程在），
 * 用户按提示去点「启动桥服务」只会得到"已经在跑了"。更糟的是这一个假话会漏进
 * 「一键接入」：面板会照常把控制台那份令牌写进客户端配置，写完才在验证里
 * 报一句 401，用户根本不知道真正要动的是**桥**（重启桥 = 让桥按控制台这份令牌重启）。
 *
 * 所以这里钉住：`bridgeHealth()` 要明确给出 `authRejected`，
 * `buildConnectBase()` 要把它透出来，界面才有依据说清"令牌不一致"。
 *
 * 桩桥：`/health` 与 `/v1/models` 一律回 401（形状照抄真实桥的 JSON 体）。
 * `config.bridge` 的 host/port 来自环境变量，所以要在 `import` **之前**设好
 * —— 这也是这里用动态 import 的原因。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

/** 起一个「永远 401」的假桥。 */
async function startUnauthorizedBridge() {
  const hits = [];
  const srv = createServer((req, res) => {
    hits.push(new URL(req.url, 'http://127.0.0.1').pathname);
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'unauthorized', hint: '本地回环令牌不匹配' }));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return {
    port: srv.address().port,
    hits,
    close: () => new Promise((r) => srv.close(r)),
  };
}

test('桥回 401 时要报「在跑但令牌被拒」，不能报「未运行」', { timeout: 30_000 }, async () => {
  const stub = await startUnauthorizedBridge();
  process.env.WORKBUDDY_HOST = '127.0.0.1';
  process.env.WORKBUDDY_PORT = String(stub.port);
  const { bridgeHealth } = await import('./diagnostics.mjs');
  const { buildConnectBase } = await import('./client-connect.mjs');

  try {
    const health = await bridgeHealth(3000);
    assert.equal(health.running, true, '端口有人应答，就该算「在跑」——报 false 会让界面说假话');
    assert.equal(health.ok, false, '被拒了不能算「可用」');
    assert.equal(health.authRejected, true, '必须能区分出这是 401（令牌不一致），不是一个坏掉的桥');

    const base = await buildConnectBase();
    assert.equal(base.running, false, '「能不能用」仍然是 false（令牌不对就是不能用）');
    assert.equal(base.bridge?.up, true, '进程级状态要透出来：桥在跑');
    assert.equal(base.bridge?.authRejected, true, '令牌被拒这件事要透到界面，否则用户无从下手');

    // 目录抓不到时退回精选集，保证「先写配置、再启桥」那条路仍然可用
    assert.ok(Array.isArray(base.models) && base.models.length > 0, '抓不到目录也要退回精选集');
  } finally {
    await stub.close();
  }
});
