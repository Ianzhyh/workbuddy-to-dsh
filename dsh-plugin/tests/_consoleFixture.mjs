/**
 * 一个**像控制台**的独立子进程 —— 供 consoleLifecycle.test.mjs 使用。
 *
 * 只实现 ConsoleSupervisor 需要的面：
 *   - 首页带 `id="navTabs"` 结构标记（probe 用它认领）；
 *   - `/api/version` 自报 pid（`WB_FIXTURE_VERSION=0` 时故意不提供，
 *     模拟没有该路由的旧控制台）；
 *   - 把收到的环境变量写成 `<WB_FIXTURE_DIR>/env.json`，验证 spawn 时注入的
 *     DASHBOARD_* / WORKBUDDY_* 真的到达子进程。
 *
 * 端口来自 DASHBOARD_PORT（由 ConsoleSupervisor 注入），避免硬编码。
 */
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const outDir = process.env.WB_FIXTURE_DIR || '';
if (outDir) {
  const picked = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(WORKBUDDY|DASHBOARD|WB_FIXTURE)_/.test(key)) picked[key] = value;
  }
  writeFileSync(join(outDir, 'env.json'), `${JSON.stringify(picked, null, 2)}\n`, 'utf8');
}

const port = Number(process.env.DASHBOARD_PORT || 0);
const withVersion = process.env.WB_FIXTURE_VERSION !== '0';

const server = createServer((req, res) => {
  if (withVersion && req.url === '/api/version') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, pid: process.pid, build: 'fixture' }));
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><html><body><nav id="navTabs"></nav>fixture</body></html>');
});
server.listen(port, '127.0.0.1');
