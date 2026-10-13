// 共享的 MCP 工具定义与 JSON-RPC 处理。stdio 与 HTTP 两个 server 都 import 它。
import { appendFileSync } from 'node:fs';

export const SERVER_NAME = process.env.DEMO_MCP_NAME || 'demo';
const LOG = process.env.DEMO_MCP_LOG || '';

export function log(line) {
  if (!LOG) return;
  try { appendFileSync(LOG, `${new Date().toISOString()} [${SERVER_NAME}] ${line}\n`); } catch { /* ignore */ }
}

export const TOOLS = [
  {
    name: 'demo_echo',
    description: 'Echo a fixed greeting. Takes no arguments.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'demo_shout',
    description: 'Uppercase the provided text and return it.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'Text to shout.' } },
      required: ['text'],
      additionalProperties: false,
    },
  },
];

/** 处理一条 JSON-RPC 消息；返回 null 表示这是 notification，不应答。 */
export function handle(msg) {
  const { id, method, params } = msg;
  log(`← ${method} ${params ? JSON.stringify(params) : ''}`);
  if (method === 'initialize') {
    return {
      jsonrpc: '2.0', id,
      result: {
        protocolVersion: params?.protocolVersion || '2024-11-05',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: '1.0.0' },
      },
    };
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return null;
  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
  if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
  if (method === 'tools/call') {
    const name = params?.name;
    const args = params?.arguments || {};
    let text;
    if (name === 'demo_echo') text = 'hello from demo_echo';
    else if (name === 'demo_shout') text = String(args.text ?? '').toUpperCase();
    else return { jsonrpc: '2.0', id, error: { code: -32602, message: `unknown tool: ${name}` } };
    return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError: false } };
  }
  if (id === undefined) return null; // 其它 notification，静默
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } };
}
