import { readFileSync } from 'node:fs';
/**
 * 真机验证第 4 项（单独跑）：上游上下文超限时，桥回的错误码是不是
 * `context_length_exceeded`。
 *
 * 踩过的坑：第一版用 `'x'.repeat(1_300_000)` —— 重复字符在 BPE 里压缩率极高，
 * 1.3M 字符根本没到 1M token，上游正常 200，用例测了个寂寞。
 * 改用**随机十六进制**（tokenize 效率差，约 2 字符/token）。
 *
 * 用法: node tools/dev/probe-codex-ctxlen-mapping.mjs
 */
const BRIDGE = 'http://127.0.0.1:8790';
/**
 * 本地桥令牌：**从 .bridge-token 读，不写进代码**。
 * 换令牌时设 WB_TOKEN 覆盖即可。
 */
function readBridgeToken() {
  const p = new URL('../../dsh-plugin/.bridge-token', import.meta.url);
  try {
    return readFileSync(p, 'utf8').trim();
  } catch {
    throw new Error('WB_TOKEN 未设置，且读不到 dsh-plugin/.bridge-token。'
      + '先启动桥（首次运行会生成它），或显式设 WB_TOKEN=...');
  }
}

const TOKEN = process.env.WB_TOKEN || readBridgeToken();
const MODEL = 'deepseek-v4.1-flash';

// 随机 hex：每个字符接近独立 token，2.6M 字符 ≈ 1.3M tokens，稳超 1,048,576
const CHUNK = 65536;
const parts = [];
let total = 0;
const target = 2_600_000;
while (total < target) {
  const b = Buffer.alloc(CHUNK);
  for (let i = 0; i < CHUNK; i += 1) b[i] = 48 + (Math.random() * 10 | 0);
  const s = b.toString('latin1');
  parts.push(s);
  total += s.length;
}
const huge = parts.join('');
console.log(`发送 ${huge.length} 字符随机文本（约 ${Math.round(huge.length / 2 / 1000)}K tokens 量级）`);

const res = await fetch(`${BRIDGE}/v1/responses`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
  body: JSON.stringify({ model: MODEL, stream: false, input: [{ type: 'message', role: 'user', content: huge }] }),
});
const t = await res.text();
let j; try { j = JSON.parse(t); } catch { j = null; }

console.log(`HTTP ${res.status}`);
console.log(`error.code    = ${j?.error?.code}`);
console.log(`error.message = ${String(j?.error?.message || t.slice(0, 300)).slice(0, 300)}`);
const pass = j?.error?.code === 'context_length_exceeded';
console.log(pass ? 'OK   映射正确（Codex 会走 ContextWindowExceeded，不再白重试）'
  : 'FAIL 期望 context_length_exceeded');
