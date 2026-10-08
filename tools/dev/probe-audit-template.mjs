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

const BRIDGE = process.env.WORKBUDDY_BRIDGE_URL || 'http://127.0.0.1:8790';
const TOKEN = process.env.WORKBUDDY_LOCAL_TOKEN || 'wb-local-bridge';
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

const a = await ask('A 带 Claude Code 模板句（原文）', CLAUDE_CODE_SYSTEM);
const a2 = await ask('A2 最小改写版（CLI tool / Default branch）', CLAUDE_CODE_SYSTEM_REWRITTEN);
const b = await ask('B 对照（普通 system）', 'You are a helpful assistant.');

const ok = (r) => r.status >= 200 && r.status < 300;
console.log('\n════════ 判定 ════════');
if (ok(a) && ok(b)) {
  console.log('✅ A（原文）经当前桥通过 —— Claude Code 模板链路**可用**。');
  console.log('   （桥自 2026-10-08 起在出站层做最小改写：CLI→CLI tool、Main branch→Default branch。');
  console.log('     此结果 = 改写层生效（或上游未拉黑）。若 A 突然变红，说明上游换了判据 ——');
  console.log('     用本脚本复核后，按 §8.7 #44 的方式更新改写表。）');
} else if (!ok(a) && ok(a2) && ok(b)) {
  console.log('⛔ A（原文）被拒、A2（改写版）通过 —— **桥的改写层没有生效**（检查 normalizePayload 的 audit 段），');
  console.log('   或上游改了判据但最小改写仍然有效。');
} else if (!ok(a) && !ok(a2) && ok(b)) {
  console.log('⛔ A 与 A2 都被拒、B 通过 —— 上游换了判据，**最小改写已不够**，需要重新分析（§8.6 风险 1）。');
} else {
  console.log(`⚠️ A/A2/B 都被拒（${a.status}/${a2.status}/${b.status}）—— 整体性故障，先按 A 的报错排查`);
}
