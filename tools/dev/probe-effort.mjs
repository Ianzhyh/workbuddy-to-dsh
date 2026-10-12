/**
 * 一次性探针：WorkBuddy（国际版）网关对 `reasoning_effort` 各档的接受度。
 *
 * 为什么必须实测：插件给 dsh 声明的是低/中/高三档（adapter 里写死），
 * 而上游到底收哪些值没有任何目录字段可查 —— 声明了却不接受，用户就会再次
 * 撞上「does not support reasoning effort "xxx"」这类错误。
 *
 * 用法：node tools/dev/probe-effort.mjs <bridge-token> [model...]
 */
const TOKEN = process.argv[2];
const BASE = 'http://127.0.0.1:8790';
const MODELS = process.argv.slice(3).length ? process.argv.slice(3) : ['deepseek-v4.1-flash', 'glm-5.3'];
const EFFORTS = ['minimal', 'low', 'medium', 'high', 'max'];

const h = { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' };

for (const model of MODELS) {
  console.log('\n===', model, '===');
  for (const effort of EFFORTS) {
    const body = {
      model, max_tokens: 16, stream: false, reasoning_effort: effort,
      messages: [{ role: 'user', content: '只回一个数字：2' }],
    };
    try {
      const res = await fetch(BASE + '/v1/chat/completions', { method: 'POST', headers: h, body: JSON.stringify(body) });
      const json = await res.json().catch(() => null);
      const msg = json?.choices?.[0]?.message;
      const rTok = json?.usage?.completion_tokens_details?.reasoning_tokens ?? 0;
      const hasRc = typeof msg?.reasoning_content === 'string' && msg.reasoning_content.length > 0;
      const content = typeof msg?.content === 'string' ? msg.content.trim().slice(0, 12) : '';
      const err = res.status === 200 ? '' : ' | ' + String(json?.error?.message || JSON.stringify(json).slice(0, 120));
      console.log(`  ${effort.padEnd(8)} HTTP ${res.status}  正文=${JSON.stringify(content)}  推理tokens=${rTok}  reasoning_content=${hasRc ? 'Y' : '-'}${err}`);
    } catch (e) {
      console.log(`  ${effort.padEnd(8)} 请求异常：${e.message}`);
    }
  }
}
