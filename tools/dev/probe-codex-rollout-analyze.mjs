// 临时诊断脚本：分析 Codex rollout，找出「跑一半就断」「工具失败」类证据。
// 用法: node tools/dev/probe-codex-rollout-analyze.mjs <rollout.jsonl>
import fs from 'node:fs';
import readline from 'node:readline';

const file = process.argv[2];
const rs = fs.createReadStream(file, { encoding: 'utf8' });
const rl = readline.createInterface({ input: rs, crlfDelay: Infinity });

const typeCount = new Map();
const payloadTypeCount = new Map();
const events = [];

rl.on('line', (line) => {
  if (!line.trim()) return;
  let o;
  try { o = JSON.parse(line); } catch { return; }
  typeCount.set(o.type, (typeCount.get(o.type) || 0) + 1);
  const pt = o.payload?.type;
  if (pt) payloadTypeCount.set(pt, (payloadTypeCount.get(pt) || 0) + 1);
  events.push(o);
});

rl.on('close', () => {
  const out = [];
  const P = (...a) => out.push(a.join(' '));

  P('### 顶层 type 计数');
  for (const [k, v] of [...typeCount].sort((a, b) => b[1] - a[1])) P(`  ${k}: ${v}`);
  P('');
  P('### payload.type 计数');
  for (const [k, v] of [...payloadTypeCount].sort((a, b) => b[1] - a[1])) P(`  ${k}: ${v}`);
  P('');

  // 1) turn / task_complete 相关
  P('### turn 结束相关事件');
  for (const e of events) {
    const p = e.payload || {};
    if (['task_complete', 'turn_aborted', 'task_started', 'turn_context', 'error', 'stream_error'].includes(p.type)) {
      const info = {
        ts: e.timestamp,
        type: p.type,
        model_needs_follow_up: p.model_needs_follow_up,
        duration_ms: p.duration_ms,
        turn_id: p.turn_id,
        reason: p.reason,
        error: p.error ? JSON.stringify(p.error).slice(0, 400) : undefined,
        message: typeof p.message === 'string' ? p.message.slice(0, 300) : undefined,
      };
      P('  ' + JSON.stringify(Object.fromEntries(Object.entries(info).filter(([, v]) => v !== undefined))));
    }
  }
  P('');

  // 2) 所有 error 字段出现的地方
  P('### 含 error / 失败字样的条目（前 60）');
  let n = 0;
  for (const e of events) {
    const s = JSON.stringify(e);
    if (/incompatible payload|ERROR|error"|stream error|failed|429|rate limit|unexpected status|Stream/i.test(s) && n < 60) {
      const p = e.payload || {};
      const snippet = s.length > 700 ? s.slice(0, 700) + '…' : s;
      P(`  [${e.timestamp}] ${p.type || e.type} :: ${snippet}`);
      n++;
    }
  }
  if (n === 0) P('  （无）');
  P('');

  // 3) 工具调用统计
  P('### 工具调用统计');
  const toolCalls = new Map();
  const toolOutputs = [];
  for (const e of events) {
    const p = e.payload || {};
    if (p.type === 'function_call' || p.type === 'custom_tool_call' || p.type === 'local_shell_call' || p.type === 'tool_search_call') {
      const name = p.name || p.type;
      const key = p.namespace ? `${p.namespace}.${name}` : name;
      toolCalls.set(key, (toolCalls.get(key) || 0) + 1);
    }
    if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
      const o = typeof p.output === 'string' ? p.output : JSON.stringify(p.output ?? '');
      toolOutputs.push({ ts: e.timestamp, type: p.type, len: o.length, head: o.slice(0, 200) });
    }
  }
  for (const [k, v] of [...toolCalls].sort((a, b) => b[1] - a[1])) P(`  ${k}: ${v}`);
  P('');
  P(`### 工具输出条数: ${toolOutputs.length}（前 15 条头部）`);
  for (const t of toolOutputs.slice(0, 15)) P(`  [${t.ts}] ${t.type} len=${t.len} :: ${JSON.stringify(t.head)}`);
  P('');

  // 4) 助手消息的最后文本（判断"断在半句话"）
  P('### 助手消息（最后 12 条，看是否断在半句）');
  const assistantMsgs = [];
  for (const e of events) {
    const p = e.payload || {};
    if (p.type === 'message' && p.role === 'assistant') {
      const texts = (p.content || []).filter((c) => c.type === 'output_text' || c.type === 'text').map((c) => c.text).join('');
      assistantMsgs.push({ ts: e.timestamp, text: texts });
    }
    if (p.type === 'agent_message' && typeof p.message === 'string') {
      assistantMsgs.push({ ts: e.timestamp, text: p.message });
    }
  }
  for (const m of assistantMsgs.slice(-12)) {
    const t = m.text.length > 400 ? m.text.slice(-400) : m.text;
    P(`  [${m.ts}] len=${m.text.length} …尾: ${JSON.stringify(t)}`);
  }
  P('');

  // 5) usage / token
  P('### token usage 事件');
  for (const e of events) {
    const p = e.payload || {};
    if (p.type === 'token_count' || p.type === 'usage' || (p.info && p.info.total_token_usage)) {
      P('  ' + JSON.stringify(p).slice(0, 500));
    }
  }

  console.log(out.join('\n'));
});
