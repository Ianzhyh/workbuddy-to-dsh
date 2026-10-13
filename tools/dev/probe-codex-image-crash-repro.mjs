/**
 * 决定性复现：用会话里真实的 4 张截图，复刻桥当前的「图片降级成纯文本」行为，
 * 看能否一比一复现上游的 `prompt is too long: 1252936 tokens > 1048576 maximum`。
 *
 * 对照组：同样 4 张图，改走 image_url 视觉通道。
 *
 * 若复现成功 → 机制 100% 确认，且证明修复后总量会掉到上游上限以内。
 *
 * 用法: node tools/dev/probe-codex-image-crash-repro.mjs
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

/**
 * 按时间顺序抠出会话里全部截图。
 *
 * 会话文件（`rollout-<时间>-<uuid>.jsonl`）默认**自动挑当天最新的一个**：
 * 原来把 uuid 写死在代码里 —— 那是**个人会话标识**，不该进仓库；
 * 而且换一天、换一次会话就跑不通了。需要指定时用 `WB_ROLLOUT` 覆盖。
 */
function extractImages() {
  const dir = process.env.WB_ROLLOUT_DIR
    || path.join(process.env.USERPROFILE || process.env.HOME || '.', '.codex', 'sessions', '2026', '10', '13');
  let file = process.env.WB_ROLLOUT;
  if (!file) {
    // 目录不存在时给一条能照着做的提示，而不是丢一个 ENOENT
    if (!fs.existsSync(dir)) {
      throw new Error(`找不到会话目录 ${dir}。设 WB_ROLLOUT_DIR 指向 .codex/sessions/<年>/<月>/<日>，`
        + '或设 WB_ROLLOUT 指向具体的 rollout-*.jsonl。');
    }
    /*
     * 挑**含截图**的最新会话，而不是单纯的"最新一个"。
     *
     * 实测教训：当天有 15 个会话，最新的那个一张截图都没有（那次对话没用到
     * computer-use）—— 按 mtime 取最新会挑到它，于是"会话截图数: 0"、
     * 探针静默失去意义。本探针的存在意义就是复现**带图**的崩溃，
     * 所以必须挑有图的。
     */
    const candidates = fs.readdirSync(dir)
      .filter((f) => f.startsWith('rollout-') && f.endsWith('.jsonl'))
      .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    if (!candidates.length) throw new Error(`${dir} 下没有 rollout-*.jsonl`);
    const withImage = candidates.find((c) => {
      const txt = fs.readFileSync(path.join(dir, c.f), 'utf8');
      return /data:image\/jpeg;base64,[A-Za-z0-9+/=]{5000,}/.test(txt);
    });
    if (!withImage) {
      throw new Error(`${dir} 下 ${candidates.length} 个会话都没有截图。`
        + '本探针需要一个**带 computer-use 截图**的会话；设 WB_ROLLOUT 指定，'
        + '或设 WB_ROLLOUT_DIR 指到别的日期。');
    }
    file = withImage.f;
  }
  const lines = fs.readFileSync(path.join(dir, file), 'utf8').split('\n').filter(Boolean);
  const out = [];
  for (const l of lines) {
    let o; try { o = JSON.parse(l); } catch { continue }
    if (o.payload?.type !== 'function_call_output') continue;
    const s = JSON.stringify(o.payload.output || '');
    const m = s.match(/data:image\/jpeg;base64,[A-Za-z0-9+/=]+/g);
    if (m) out.push({ ts: o.timestamp, uri: m[0] });
  }
  return out;
}

async function post(messages, label) {
  const t0 = Date.now();
  try {
    const res = await fetch(BRIDGE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ model: MODEL, max_tokens: 4, stream: false, messages }),
    });
    const text = await res.text();
    let j; try { j = JSON.parse(text); } catch { return { label, status: res.status, raw: text.slice(0, 300) }; }
    return {
      label,
      status: res.status,
      ms: Date.now() - t0,
      prompt: j.usage?.prompt_tokens,
      err: j.error ? String(j.error.message || JSON.stringify(j.error)).slice(0, 200) : undefined,
    };
  } catch (e) {
    return { label, status: 'throw', err: e.message };
  }
}

const imgs = extractImages();
console.log(`会话截图数: ${imgs.length}`);
let cum = 0;
for (const i of imgs) { cum += i.uri.length; console.log(`  ${i.ts}  ${i.uri.length} 字符`); }
console.log(`累计 base64: ${cum} 字符 (约 ${Math.round(cum / 1024)} KB)\n`);

const SYS = 'You are Codex.' + ' x'.repeat(5000); // 粗略的文本基线（系统提示 + 历史）

/** 桥当前行为：每个工具输出把图片块 JSON.stringify 成纯文本。 */
function asTextMessages() {
  const msgs = [{ role: 'system', content: SYS }];
  imgs.forEach((img, i) => {
    msgs.push({ role: 'user', content: `call tool ${i}` });
    msgs.push({ role: 'assistant', content: null, tool_calls: [{ id: `call_${i}`, type: 'function', function: { name: 'js', arguments: '{}' } }] });
    msgs.push({ role: 'tool', tool_call_id: `call_${i}`, content: JSON.stringify({ type: 'input_image', image_url: img.uri }) });
  });
  return msgs;
}

/** 修复后：工具输出用内容数组走视觉通道。 */
function asImageMessages() {
  const msgs = [{ role: 'system', content: SYS }];
  imgs.forEach((img, i) => {
    msgs.push({ role: 'user', content: `call tool ${i}` });
    msgs.push({ role: 'assistant', content: null, tool_calls: [{ id: `call_${i}`, type: 'function', function: { name: 'js', arguments: '{}' } }] });
    msgs.push({
      role: 'tool',
      tool_call_id: `call_${i}`,
      content: [{ type: 'text', text: 'screenshot captured' }, { type: 'image_url', image_url: { url: img.uri } }],
    });
  });
  return msgs;
}

console.log('=== A: 复刻桥当前行为（图片当纯文本）===');
console.log(JSON.stringify(await post(asTextMessages(), 'A 降级'), null, 0));
console.log('');
console.log('=== B: 修复后（图片走视觉通道）===');
console.log(JSON.stringify(await post(asImageMessages(), 'B 视觉'), null, 0));
