#!/usr/bin/env node
/**
 * 极小的 stdio MCP server —— 零依赖，手写 JSON-RPC 2.0。
 * 传输：stdio，newline-delimited JSON（MCP 标准）。
 * 证据落盘：收到的每个请求追加一行到 $DEMO_MCP_LOG（若设置了该环境变量），
 *           以便区分「server 没被拉起」和「被拉起但没被调用」。
 */
import { handle, log } from './mcp-core.mjs';

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { log(`! 无法解析: ${line.slice(0, 200)}`); continue; }
    let out;
    try { out = handle(msg); } catch (e) { out = { jsonrpc: '2.0', id: msg?.id, error: { code: -32603, message: String(e && e.message) } }; }
    if (out) process.stdout.write(`${JSON.stringify(out)}\n`);
  }
});
process.stdin.on('end', () => { log('stdin closed'); process.exit(0); });
log(`stdio 启动 pid=${process.pid}`);
