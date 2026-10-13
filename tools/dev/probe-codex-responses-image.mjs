/**
 * 最关键的真机验证：**走 Codex 真实路径 `/v1/responses`**，
 * 确认工具输出里的图片块以**视觉通道**发给上游。
 *
 * 前面的验证走的是 `/v1/chat/completions`（我自己构造的 chat 形状）；
 * 而 Codex 实际发的是 Responses 形状（`input[].function_call_output.output` 是
 * 内容块数组，图片在 `{type:"input_image", image_url:"data:..."}`）。
 * 必须确认**这条路径**也修好了 —— 否则修了个不相关的入口。
 *
 * 做法：给桥发一个真实的 Responses 请求（带图片的 tool 输出），
 * 然后读桥的日志/上游 usage，确认：
 *   - 桥接受了请求
 *   - 上游返回的 prompt_tokens 是**视觉量级**（约 1K），不是 18 万
 *
 * 用法: node tools/dev/probe-codex-responses-image.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const BRIDGE = 'http://127.0.0.1:8790';
/**
 * 本地桥令牌：**从 .bridge-token 读，不写进代码**。
 * 换令牌时设 WB_TOKEN 覆盖即可。
 */
function readBridgeToken() {
  const p = new URL('../../dsh-plugin/.bridge-token', import.meta.url);
  try {
    return fs.readFileSync(p, 'utf8').trim();
  } catch {
    throw new Error('WB_TOKEN 未设置，且读不到 dsh-plugin/.bridge-token。'
      + '先启动桥（首次运行会生成它），或显式设 WB_TOKEN=...');
  }
}

const TOKEN = process.env.WB_TOKEN || readBridgeToken();
const MODEL = 'deepseek-v4.1-flash';

// 取一张真图
const dir = path.join(process.env.USERPROFILE, '.codex', 'sessions', '2026', '10', '13');
let uri = null;
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.jsonl'))) {
  const t = fs.readFileSync(path.join(dir, f), 'utf8');
  const m = t.match(/data:image\/jpeg;base64,[A-Za-z0-9+/=]{5000,}/);
  if (m) { uri = m[0]; break; }
}
if (!uri) { console.log('找不到测试图片'); process.exit(1); }
console.log(`图片 ${uri.length} 字符（约 ${Math.round(uri.length / 1024)} KB）`);
console.log('');

/**
 * 构造一个**完全按 Codex 实测形状**的 Responses 请求：
 * 工具输出是内容块数组，图片在 input_image 块里（rollout 里就是这个形状）。
 */
const body = {
  model: MODEL,
  stream: false,
  input: [
    { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'You are Codex.' }] },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'look at the screenshot' }] },
    { type: 'function_call', call_id: 'call_img_1', name: 'js', arguments: '{}' },
    {
      type: 'function_call_output',
      call_id: 'call_img_1',
      output: [
        { type: 'input_text', text: 'Wall time: 0.4 seconds\nOutput:' },
        { type: 'input_image', image_url: uri },
      ],
    },
  ],
  tools: [{ type: 'function', name: 'js', description: 'run js', parameters: { type: 'object', properties: {} } }],
  tool_choice: 'auto',
  max_output_tokens: 32,
};

const res = await fetch(`${BRIDGE}/v1/responses`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
  body: JSON.stringify(body),
});
const text = await res.text();
let j; try { j = JSON.parse(text); } catch { j = null; }

console.log(`HTTP ${res.status}`);
if (!j) { console.log(text.slice(0, 400)); process.exit(1); }
if (j.error) { console.log('error: ' + JSON.stringify(j.error).slice(0, 300)); process.exit(1); }

const usage = j.usage || {};
console.log(`status        = ${j.status}`);
console.log(`prompt_tokens = ${usage.input_tokens}`);
console.log(`output_tokens = ${usage.output_tokens}`);
console.log('');

/*
 * 判据：视觉通道下这张图约 1K tokens（实测 987）；
 * 若走了文本通道，会是 18 万量级。阈值取 5000 —— 两边差 35 倍，足够分辨。
 */
const pt = usage.input_tokens;
if (typeof pt !== 'number') {
  console.log('FAIL 没拿到 input_tokens');
} else if (pt < 5000) {
  console.log(`OK   图片走了视觉通道（prompt_tokens=${pt}，视觉量级约 1K）`);
} else {
  console.log(`FAIL 图片疑似仍走文本通道（prompt_tokens=${pt}，视觉量级应约 1K）`);
}
