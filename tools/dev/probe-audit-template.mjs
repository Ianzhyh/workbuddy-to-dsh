/**
 * 探针：上游内容审核是否逐字拉黑 Claude Code 的固定 system 模板。
 *
 *   node tools/dev/probe-audit-template.mjs
 *
 * 背景（调研报告 §7 P1-10 / §8.7 #44）：竞品 workbuddy-cliproxy 实测上游把
 * Claude Code 的两句固定 system 模板**逐字**拉黑；本桥此前未见对应改写层。
 * 本脚本发两条**最小**请求（消耗极少量积分）做判定：
 *
 *   A 带模板句（`You are Claude Code…` + `Main branch…`）
 *   B 不带（对照组，同时验证"当前固定客户端身份仍被上游接受"）
 *
 * 判定：A 被拒而 B 通过 → 命中拉黑（需要最小改写层）；两者都通过 → 未命中。
 * 结果无论正反都会写入 docs/TROUBLESHOOTING.md（不留悬案）。
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BRIDGE = process.env.WORKBUDDY_BRIDGE_URL || 'http://127.0.0.1:8790';
// 旧默认值 wb-local-bridge 是公开口令；优先沿用环境变量，其次读插件落盘令牌。
const TOKEN = process.env.WORKBUDDY_LOCAL_TOKEN || (() => {
  try { return readFileSync(join(ROOT, 'dsh-plugin', '.bridge-token'), 'utf8').trim(); } catch { return 'wb-local-bridge'; }
})();
const MODEL = process.env.WORKBUDDY_PROBE_MODEL || 'deepseek-v4.1-flash';

/** Claude Code 真实发出的前两个 system 块（逐字）。 */
const CLAUDE_CODE_SYSTEM = [
  { type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." },
  { type: 'text', text: 'Main branch (you will usually use this for PRs)' },
];

/** 按 §8.7 #44 的最小改写版（CLI → CLI tool、Main branch → Default branch）。 */
const CLAUDE_CODE_SYSTEM_REWRITTEN = [
  { type: 'text', text: "You are Claude Code, Anthropic's official CLI tool for Claude." },
  { type: 'text', text: 'Default branch (you will usually use this for PRs)' },
];

async function ask(name, system) {
  const t0 = Date.now();
  let res;
  try {
    res = await fetch(`${BRIDGE}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 16,
        system,
        messages: [{ role: 'user', content: 'ping' }],
      }),
      signal: AbortSignal.timeout(90_000),
    });
  } catch (err) {
    console.log(`\n[${name}] 请求失败：${err.message}`);
    return { status: 0, summary: err.message };
  }
  const text = await res.text();
  let summary;
  try {
    const j = JSON.parse(text);
    if (j.error) {
      summary = `错误: ${JSON.stringify(j.error).slice(0, 400)}`;
    } else {
      const joined = (j.content || []).map((c) => c.text || '').join('');
      summary = `正常回复: ${JSON.stringify(joined).slice(0, 120)} (usage in=${j.usage?.input_tokens} out=${j.usage?.output_tokens})`;
    }
  } catch {
    summary = `非 JSON 响应（前 300 字符）: ${text.slice(0, 300)}`;
  }
  console.log(`\n[${name}] HTTP ${res.status} · ${Date.now() - t0}ms`);
  console.log(`  ${summary}`);
  return { status: res.status, summary };
}

/**
 * dsh 真正走的 `/v1/chat/completions` 形状：identity + persona + runtime context
 * + 一个工具 + 一轮 tool 结果。只发 max_tokens 8，成本极小。
 *
 * 这条比“只发 system 句”更能发现**字段级**模板/工具问题：如果它 400，而前面的
 * 最小 system 探针 200，就说明触发点在 tools/工具结果/chat 路径，而不是身份句。
 */
async function askChat(name, payload) {
  const t0 = Date.now();
  let res;
  try {
    res = await fetch(`${BRIDGE}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(90_000),
    });
  } catch (err) {
    console.log(`\n[${name}] 请求失败：${err.message}`);
    return { status: 0, summary: err.message };
  }
  const text = await res.text();
  let summary;
  try {
    const j = JSON.parse(text);
    if (j.error) summary = `错误: ${JSON.stringify(j.error).slice(0, 400)}`;
    else summary = `正常回复: ${JSON.stringify(j.choices?.[0]?.message?.content || '').slice(0, 120)}`
      + ` (usage in=${j.usage?.prompt_tokens} out=${j.usage?.completion_tokens})`;
  } catch {
    summary = `非 JSON 响应（前 300 字符）: ${text.slice(0, 300)}`;
  }
  console.log(`\n[${name}] HTTP ${res.status} · ${Date.now() - t0}ms`);
  console.log(`  ${summary}`);
  return { status: res.status, summary };
}

/**
 * dsh 宿主身份句（2026-10-21 被上游按模板拦截）与桥的中性改写版。
 * 用同一把桥令牌各发一条最小请求，确认改写层在运行中的桥上真的生效。
 */
const DSH_IDENTITY = 'You are an AI agent powered by DeepSeek Harness.';
const DSH_NEUTRAL = "You are an AI agent running inside the user's development environment.";

const DSH_CHAT_SYSTEM = [
  DSH_IDENTITY,
  `You are a coding agent powered by the ${MODEL} model.`,
  'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.',
  `Working directory: ${ROOT}`,
].join('\n\n');

const DSH_CHAT_PAYLOAD = {
  model: MODEL,
  max_tokens: 8,
  stream: false,
  messages: [
    { role: 'system', content: DSH_CHAT_SYSTEM },
    { role: 'user', content: 'hi' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call_probe_1', type: 'function', function: { name: 'diag_probe', arguments: '{}' } }],
    },
    { role: 'tool', tool_call_id: 'call_probe_1', content: 'ok' },
  ],
  tools: [{
    type: 'function',
    function: {
      name: 'diag_probe',
      description: 'Return ok.',
      parameters: { type: 'object', properties: {} },
    },
  }],
};

const a = await ask('A 带 Claude Code 模板句（原文）', CLAUDE_CODE_SYSTEM);
const a2 = await ask('A2 最小改写版（CLI tool / Default branch）', CLAUDE_CODE_SYSTEM_REWRITTEN);
const b = await ask('B 对照（普通 system）', 'You are a helpful assistant.');
const d = await ask('D dsh 身份句（原文，应被桥改写）', DSH_IDENTITY);
const d2 = await ask('D2 dsh 中性身份句（对照）', DSH_NEUTRAL);
const e = await askChat('E dsh 形状 /chat/completions（system+tools+tool 结果）', DSH_CHAT_PAYLOAD);

const ok = (r) => r.status >= 200 && r.status < 300;
const all = [a, a2, b, d, d2, e];
let failed = false;
const fail = (message) => { failed = true; console.log(`⛔ ${message}`); };

console.log('\n════════ 判定 ════════');
if (all.some((r) => r.status === 401)) {
  console.log('⚠️ 出现 401：探针用的本地令牌与运行中的桥不一致。');
  console.log('   先到控制台/插件里点「重启桥」，或把 WORKBUDDY_LOCAL_TOKEN 设成桥当前令牌后重试。');
}
if (all.some((r) => r.status === 0)) {
  fail('至少一条请求没有拿到 HTTP 响应（桥未运行/端口不通/超时）—— 本探针不能作为通过。');
}
if (ok(d)) {
  console.log('✅ dsh 身份句经当前桥通过 —— system 最小改写生效。');
} else if (ok(d2)) {
  fail('dsh 身份句被拒、中性身份句通过 —— 运行中的桥还是旧代码（重启/升级桥），或上游又改了判据。');
} else {
  fail('dsh 身份句与中性句都被拒 —— 先排整体通道（令牌/凭据/UA），不是模板问题。');
}
if (ok(a) && ok(b)) {
  console.log('✅ A（原文）经当前桥通过 —— Claude Code 模板链路可用。');
  console.log('   （桥在出站层做最小改写：CLI→CLI tool、Main branch→Default branch；');
  console.log('     此结果 = 改写层生效（或上游未拉黑）。A 变红说明上游换了判据。）');
} else if (!ok(a) && ok(a2) && ok(b)) {
  fail('A（原文）被拒、A2（改写版）通过 —— 桥的改写层没有生效（检查 normalizePayload 的 audit 段）。');
} else if (!ok(a) && !ok(a2) && ok(b)) {
  fail('A 与 A2 都被拒、B 通过 —— 上游换了判据，最小改写已不够，需要重新分析。');
} else {
  fail(`A/A2/B 都被拒（${a.status}/${a2.status}/${b.status}）—— 整体性故障，先按 A 的报错排查。`);
}
if (ok(e)) {
  console.log('✅ E dsh 形状 chat 请求通过 —— 当前 tools/工具结果/system 组合没有被拦截。');
} else {
  fail('E dsh 形状 chat 请求失败 —— 若 D/D2 通过，触发点在 tools/工具结果/chat 路径，而不是身份句。');
}

console.log(failed
  ? '\n结论：存在失败项（退出码 1）。'
  : '\n结论：全部通过（退出码 0）。');
process.exitCode = failed ? 1 : 0;
