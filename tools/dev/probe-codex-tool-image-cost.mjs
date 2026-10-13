/**
 * 决定性实验：Codex 的「工具输出里的图片」在桥里被降级成了纯文本。
 *
 * 现象（2026-10-13 rollout 实测）：
 *   `function_call_output.output` 是内容块数组，其中图片长这样：
 *     {type:"input_image", image_url:"data:image/jpeg;base64,<26 万字符>"}
 *   而桥的 `responsesOutputText()` 对非 text 块走 `JSON.stringify(p)`
 *   → **整段 base64 变成 tool 消息里的纯文本**。
 *
 * 本探针对同一个 base64 图片，比较三种发送形态的上游 prompt_tokens：
 *   A. 不带图（基线）
 *   B. 作为 image_url 内容块（视觉通道）
 *   C. 作为纯文本字符串（= 桥当前的 JSON.stringify 行为）
 *
 * 用法: node tools/dev/probe-codex-tool-image-cost.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const BRIDGE = 'http://127.0.0.1:8790/v1/chat/completions';
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

function extractImage() {
  const dir = path.join(process.env.USERPROFILE, '.codex', 'sessions', '2026', '10', '13');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
    .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t);
  for (const { f } of files) {
    const txt = fs.readFileSync(path.join(dir, f), 'utf8');
    const m = txt.match(/data:image\/jpeg;base64,[A-Za-z0-9+/=]{5000,}/);
    if (m) return m[0];
  }
  return null;
}

async function ask(body, label) {
  const res = await fetch(BRIDGE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ model: MODEL, max_tokens: 4, stream: false, ...body }),
  });
  const text = await res.text();
  let j; try { j = JSON.parse(text); } catch { return { label, status: res.status, raw: text.slice(0, 300) }; }
  return { label, status: res.status, prompt: j.usage?.prompt_tokens, err: j.error ? JSON.stringify(j.error).slice(0, 200) : undefined };
}

const uri = extractImage();
if (!uri) { console.log('没找到图片'); process.exit(1); }
console.log(`图片 base64: ${uri.length} 字符 (约 ${Math.round(uri.length / 1024)} KB)\n`);

const TEXT = 'Reply with the single word: ok';

// A: 基线
const a = await ask({ messages: [{ role: 'user', content: TEXT }] }, 'A 基线');

// B: 作为真正的图片块（视觉通道）
const b = await ask({
  messages: [{ role: 'user', content: [{ type: 'text', text: TEXT }, { type: 'image_url', image_url: { url: uri } }] }],
}, 'B image_url 块');

// C: 复刻桥的行为 —— JSON.stringify 成纯文本，塞进 tool 消息
const degraded = JSON.stringify({ type: 'input_image', image_url: uri });
const c = await ask({
  messages: [
    { role: 'user', content: 'call the tool' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'js', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call_1', content: degraded },
  ],
}, 'C 纯文本(桥当前行为)');

console.log('=== 结果 ===');
for (const r of [a, b, c]) console.log(JSON.stringify(r));

if (typeof a.prompt === 'number' && typeof c.prompt === 'number') {
  console.log('');
  console.log(`基线              : ${a.prompt} tokens`);
  console.log(`视觉通道 (B)      : ${b.prompt} tokens   → 单图成本 ≈ ${b.prompt - a.prompt}`);
  console.log(`纯文本降级 (C)    : ${c.prompt} tokens   → 单图成本 ≈ ${c.prompt - a.prompt}`);
  const ratio = (c.prompt - a.prompt) / Math.max(1, b.prompt - a.prompt);
  console.log('');
  console.log(`>>> 降级后的代价是视觉通道的 ${ratio.toFixed(1)} 倍`);
  console.log(`>>> 该会话有 9 张图 → 降级多烧 ≈ ${Math.round((c.prompt - a.prompt - (b.prompt - a.prompt)) * 9 / 1000)}K tokens`);
}
