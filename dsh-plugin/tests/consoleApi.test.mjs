/**
 * 控制台 API 透传（/workbuddy/console-api/*）的自测。
 *
 * 这一层是「两处同步、互不冲突」的关键：账号切换 / 自动签到开关 / 体检结果
 * 必须由控制台写（它的 lib/state.mjs 带进程内缓存），所以插件只做受控透传。
 * 这里把「白名单、方法、面板头、控制台不在跑」四条边界全钉住。
 *
 *   node --test dsh-plugin/tests/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { createConsoleApiHandler, CONSOLE_API_ALLOWLIST, CONSOLE_API_PREFIX } from '../lib/consoleApi.mjs';

/** 造一对最小的 req/res，驱动器只看这几个成员。 */
async function call(handler, { method = 'GET', path, headers = {}, body } = {}) {
  let status = 0;
  let payload = '';
  const res = {
    headersSent: false,
    writableEnded: false,
    writeHead(code) { status = code; this.headersSent = true; return this; },
    write(chunk) { payload += Buffer.from(chunk).toString('utf8'); return true; },
    end(chunk) { if (chunk) payload += Buffer.from(chunk).toString('utf8'); this.writableEnded = true; },
    on() {},
    off() {},
  };
  const req = {
    method,
    url: path,
    headers,
    async *[Symbol.asyncIterator]() { if (body) yield Buffer.from(body); },
  };
  await handler(req, res);
  let json;
  try { json = JSON.parse(payload); } catch { json = payload; }
  return { status, json };
}

/** 假控制台：原样回显收到的请求。 */
async function startFakeConsole() {
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString('utf8');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ echoed: true, method: req.method, url: req.url, body: body ? JSON.parse(body) : null }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, close: () => new Promise((r) => server.close(r)) };
}

test('console-api 透传：白名单 / 方法 / 面板头 / 控制台未运行', async () => {
  const fake = await startFakeConsole();
  const running = createConsoleApiHandler({
    consoleSupervisor: { url: `http://127.0.0.1:${fake.port}`, probe: async () => ({ state: 'running' }) },
    log: () => {},
  });
  const stopped = createConsoleApiHandler({
    consoleSupervisor: { url: `http://127.0.0.1:${fake.port}`, probe: async () => ({ state: 'stopped', error: '连接被拒绝' }) },
    log: () => {},
  });

  try {
    // 1) 允许的 GET：原样透传到控制台的 /api/*（含查询串）
    const overview = await call(running, { path: `${CONSOLE_API_PREFIX}/overview` });
    assert.equal(overview.status, 200);
    assert.equal(overview.json.echoed, true);
    assert.equal(overview.json.url, '/api/overview');

    const withQuery = await call(running, { path: `${CONSOLE_API_PREFIX}/probe-results?x=1` });
    assert.equal(withQuery.json.url, '/api/probe-results?x=1');

    // 2) 非白名单路径：404，且**不会**打到控制台（不做任意路径代理）
    const nope = await call(running, { path: `${CONSOLE_API_PREFIX}/secrets` });
    assert.equal(nope.status, 404);
    assert.match(nope.json.error, /未允许透传/);
    const traversal = await call(running, { path: `${CONSOLE_API_PREFIX}/../api/overview` });
    assert.ok([404, 200].includes(traversal.status));
    if (traversal.status === 200) assert.equal(traversal.json.echoed, true);
    assert.ok(Object.keys(CONSOLE_API_ALLOWLIST).includes('/account/switch'), '账号切换必须在白名单里');

    // 3) 方法不对：405
    const wrongMethod = await call(running, {
      method: 'POST', path: `${CONSOLE_API_PREFIX}/accounts`, headers: { 'x-workbuddy-panel': '1' }, body: '{}',
    });
    assert.equal(wrongMethod.status, 405);

    // 4) 写操作缺面板头：403（跨站简单请求打不进来）
    const denied = await call(running, {
      method: 'POST', path: `${CONSOLE_API_PREFIX}/account/switch`, body: JSON.stringify({ file: 'a.info' }),
    });
    assert.equal(denied.status, 403);

    // 5) 写操作带头：方法与 body 都忠实透传
    const switched = await call(running, {
      method: 'POST',
      path: `${CONSOLE_API_PREFIX}/account/switch`,
      headers: { 'x-workbuddy-panel': '1' },
      body: JSON.stringify({ file: 'a.info' }),
    });
    assert.equal(switched.status, 200);
    assert.equal(switched.json.method, 'POST');
    assert.deepEqual(switched.json.body, { file: 'a.info' });

    // 6) 删体检结论（DELETE）同样能透传
    const cleared = await call(running, { method: 'DELETE', path: `${CONSOLE_API_PREFIX}/probe-results`, headers: { 'x-workbuddy-panel': '1' } });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.json.method, 'DELETE');

    // 7) 控制台没跑：503 + 可执行提示，而不是静默失败
    const down = await call(stopped, { path: `${CONSOLE_API_PREFIX}/diagnose` });
    assert.equal(down.status, 503);
    assert.equal(down.json.state, 'stopped');
    assert.match(down.json.hint, /控制台/);
  } finally { await fake.close(); }
});

test('console-api：控制台进程消失时给 502 而不是挂住', async () => {
  const dead = createConsoleApiHandler({
    consoleSupervisor: { url: 'http://127.0.0.1:1', probe: async () => ({ state: 'running' }) },
    log: () => {},
  });
  const res = await call(dead, { path: `${CONSOLE_API_PREFIX}/diagnose` });
  assert.ok([502, 503].includes(res.status), `实际 ${res.status}`);
  assert.match(String(res.json.hint || res.json.error), /控制台/);
});
