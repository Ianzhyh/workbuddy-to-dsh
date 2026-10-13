#!/usr/bin/env node
/**
 * 极小的 MCP server，走 **Streamable HTTP** 传输（零依赖）。
 * 为什么需要它：本机 `codex exec` 起 stdio MCP server 一律失败
 *   （`MCP server startup failed … 所有的管道范例都在使用中。 (os error 231)`），
 *   连真 node_repl.exe 也一样。换成 HTTP 传输可以绕开这条坏掉的管道路径，
 *   从而把"MCP 工具在 tools[] 里长什么样"这个变量单独测出来。
 *
 * 用法：node http-mcp-server.mjs <port>
 * 端点：POST /mcp  （JSON-RPC，application/json 应答）
 */
import { createServer } from 'node:http';
import { SERVER_NAME, handle, log } from './mcp-core.mjs';

const port = Number(process.argv[2] || 0);

const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    if (req.method === 'GET') {
      // 可选的 server→client SSE 流：开一个空流即可
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      res.write(': open\n\n');
      return;
    }
    if (req.method === 'DELETE') { res.writeHead(200); res.end(); return; }
    const raw = Buffer.concat(chunks).toString('utf8');
    let msg;
    try { msg = JSON.parse(raw); } catch {
      log(`! 无法解析: ${raw.slice(0, 200)}`);
      res.writeHead(400); res.end(); return;
    }
    let out;
    try { out = handle(msg); } catch (e) {
      out = { jsonrpc: '2.0', id: msg?.id, error: { code: -32603, message: String(e && e.message) } };
    }
    if (!out) { res.writeHead(202); res.end(); return; } // notification
    const headers = { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'probe-session-1' };
    res.writeHead(200, headers);
    res.end(JSON.stringify(out));
  });
});

server.listen(port, '127.0.0.1', () => {
  log(`http 监听 127.0.0.1:${server.address().port} name=${SERVER_NAME} pid=${process.pid}`);
  process.stdout.write(`listening ${server.address().port}\n`);
});
