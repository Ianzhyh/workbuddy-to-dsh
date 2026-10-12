/**
 * 一次性探针：国际版网关上 deepseek-v4.1-flash / deepseek-v4-pro 的真实能力。
 *
 * 目的：桥的目录里这两个是 FEATURED **补全项**（上游目录没有它们），补全项
 * 不带任何能力字段 → 插件给 dsh 报的是"纯文本 + 无推理"。用户反馈"
 * 明明是视觉模型却被识别成纯文本"。
 *
 * 这里**不猜**，直接打上游问两件事：
 *   1. 视觉：塞一张 1×1 红点图，看上游接不接、答得出颜色吗；
 *   2. 推理：带 reasoning_effort=high，看上游是接受还是报错，
 *      并从响应里看有没有 reasoning_content / reasoning_tokens。
 *
 * 走的是桥（与 dsh 同一条路），所以结论可直接用于修桥的目录。
 */
const TOKEN = process.argv[2];
const BASE = 'http://127.0.0.1:8790';
const h = { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' };

// 1×1 纯红 PNG（base64）
const RED_PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function chat(body) {
  const res = await fetch(BASE + '/v1/chat/completions', { method: 'POST', headers: h, body: JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 保留原文 */ }
  return { status: res.status, json, text };
}

const MODELS = ['deepseek-v4.1-flash', 'deepseek-v4-pro'];

for (const model of MODELS) {
  console.log('\n========================', model, '========================');

  // ── 1. 视觉：给一张红点图，问它什么颜色 ──
  {
    const r = await chat({
      model,
      max_tokens: 24,
      stream: false,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: '这张图里是什么颜色？只回颜色名。' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,' + RED_PX } },
        ],
      }],
    });
    const msg = r.json?.choices?.[0]?.message;
    const content = typeof msg?.content === 'string' ? msg.content : JSON.stringify(msg?.content ?? '');
    console.log('[视觉] HTTP', r.status, '→', JSON.stringify(String(content).slice(0, 80)));
    if (r.status !== 200) console.log('       错误原文：', r.text.slice(0, 300));
    if (msg?.reasoning_content) console.log('       （带 reasoning_content：', String(msg.reasoning_content).slice(0, 60), '）');
  }

  // ── 2. 推理强度 high ──
  {
    const r = await chat({
      model,
      max_tokens: 24,
      stream: false,
      reasoning_effort: 'high',
      messages: [{ role: 'user', content: '1+1=？只回数字。' }],
    });
    const j = r.json;
    const msg = j?.choices?.[0]?.message;
    const content = typeof msg?.content === 'string' ? msg.content : JSON.stringify(msg?.content ?? '');
    console.log('[推理] HTTP', r.status, '→', JSON.stringify(String(content).slice(0, 60)));
    console.log('       usage=', JSON.stringify(j?.usage ?? null).slice(0, 160));
    if (msg?.reasoning_content) console.log('       reasoning_content 长度:', String(msg.reasoning_content).length);
    else console.log('       无 reasoning_content 字段');
    if (r.status !== 200) console.log('       错误原文：', r.text.slice(0, 300));
  }
}
