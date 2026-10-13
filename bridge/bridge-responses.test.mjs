/**
 * `/v1/responses`（Codex 走的 Responses 协议）的**合约测试**。
 *
 *   node --test bridge/bridge-responses.test.mjs
 *
 * 为什么必须真起桥 + 真打 HTTP：翻译层的价值全在"字节对得上"上 ——
 * 事件顺序错一个、`output_item.done` 少带一份完整数据，Codex 那边就是判流损坏、
 * 整轮中断。纯函数级单测证明不了这条链路，只能端到端验。
 *
 * 用**打桩上游**（`CODEBUDDY_ENDPOINT` 指向本机假服务）：不消耗真实额度，
 * 而且能把"上游的行为"做成确定性的，否则断言得看模型当天心情。
 *
 * ## 断言依据（都来自 Codex 自己的解析器，不是猜的）
 *
 * 见 `bridge/workbuddy-bridge.mjs` 里 Responses 兼容层的头部注释。关键三条：
 *   1. Codex 只在 `response.output_item.done` 里取内容；
 *   2. `output_text.delta` 之前必须先有 `output_item.added`；
 *   3. `response.completed.response.usage` 的三个总数是必填。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(HERE);
const BRIDGE = join(REPO, 'bridge', 'workbuddy-bridge.mjs');
const TOKEN = 'responses-test-token';

// ── 打桩上游 ──────────────────────────────────────────────────────────────
/**
 * 当前场景。每个用例开跑前设好，假上游按它决定回什么 ——
 * 这样不用给每个用例起一套进程，也不会互相串。
 */
let scenario = { kind: 'text' };
/** 最近一次上游收到的 chat/completions 请求体（验请求翻译用）。 */
let lastUpstreamBody = null;

const sse = (obj) => `data: ${JSON.stringify(obj)}\n\n`;

const upstream = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    if (!req.url.startsWith('/v2/chat/completions')) {
      // 目录 / 计费 / 刷新等端点：一律空成功，让桥走"没有目录"的兜底路径
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 0, data: { models: [] } }));
      return;
    }
    try { lastUpstreamBody = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { lastUpstreamBody = null; }

    if (scenario.kind === 'error') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ msg: 'upstream says no', code: 40101 }));
      return;
    }

    if (scenario.kind === 'error429') {
      res.writeHead(429, { 'Content-Type': 'application/json', 'retry-after': '7' });
      res.end(JSON.stringify({ msg: 'slow down', code: 42901 }));
      return;
    }

    if (scenario.kind === 'error500') {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ msg: 'boom', code: 50001 }));
      return;
    }

    if (scenario.kind === 'ctxlen') {
      // 上游用 400 + 上下文超限的措辞 —— 桥要把它映射成 context_length_exceeded，
      // 否则 Codex 只会当成普通 upstream_error、不做上下文裁剪就整轮失败
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ msg: 'maximum context length exceeded', code: 40001 }));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (scenario.kind === 'truncated') {
      // 上游因 max_tokens 截断 —— finish_reason 是 length
      res.write(sse({ id: 'c1', model: 'm', choices: [{ index: 0, delta: { content: 'partial' } }] }));
      res.write(sse({
        id: 'c1',
        model: 'm',
        choices: [{ index: 0, delta: {}, finish_reason: 'length' }],
        usage: { prompt_tokens: 5, completion_tokens: 16, total_tokens: 21 },
      }));
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    if (scenario.kind === 'usageDetails') {
      res.write(sse({ id: 'c1', model: 'm', choices: [{ index: 0, delta: { content: 'ok' } }] }));
      res.write(sse({
        id: 'c1',
        model: 'm',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 40,
          total_tokens: 140,
          prompt_tokens_details: { cached_tokens: 64 },
          completion_tokens_details: { reasoning_tokens: 25 },
        },
      }));
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    if (scenario.kind === 'text') {
      res.write(sse({ id: 'c1', model: 'm', choices: [{ index: 0, delta: { role: 'assistant', content: 'Hel' } }] }));
      res.write(sse({ id: 'c1', model: 'm', choices: [{ index: 0, delta: { content: 'lo ' } }] }));
      res.write(sse({ id: 'c1', model: 'm', choices: [{ index: 0, delta: { content: 'world' } }] }));
    } else if (scenario.kind === 'tool') {
      res.write(sse({ id: 'c1', model: 'm', choices: [{ index: 0, delta: { content: 'let me check' } }] }));
      // 名字**分片**下发 —— 这正是 Anthropic 那条流踩过的坑，这里必须同样能扛
      res.write(sse({ id: 'c1', model: 'm', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_abc', type: 'function', function: { name: 'get_' } }] } }] }));
      res.write(sse({ id: 'c1', model: 'm', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: 'weather' } }] } }] }));
      res.write(sse({ id: 'c1', model: 'm', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"city"' } }] } }] }));
      res.write(sse({ id: 'c1', model: 'm', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: ':"SH"}' } }] } }] }));
    } else if (scenario.kind === 'customTool') {
      /*
       * freeform（`type:"custom"`）工具的调用 —— 上游按我们声明的函数接口回，
       * 参数是 JSON（`{"input":"…"}`）而且**分片**到达（真实网关就这么发）。
       * 桥要做两件事：把 JSON 外壳拆掉取 `input` 正文，并把项类型换成
       * `custom_tool_call`（发成 function_call 会被 Codex 判 incompatible payload）。
       */
      res.write(sse({ id: 'c1', model: 'm', choices: [{ index: 0, delta: { content: 'editing' } }] }));
      res.write(sse({ id: 'c1', model: 'm', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_patch', type: 'function', function: { name: 'apply_patch' } }] } }] }));
      res.write(sse({ id: 'c1', model: 'm', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"input":"*** Begin Patch\\n' } }] } }] }));
      res.write(sse({ id: 'c1', model: 'm', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '*** Add File: a.txt\\n+hi\\n*** End Patch\\n"}' } }] } }] }));
    } else if (scenario.kind === 'reasoning') {
      /*
       * 上游先给思维链、再给正文 —— 这是**真实顺序**（实测日志里就是这样），
       * 也是整件事的难点：Codex 要求 reasoning 的 delta 到达时已有 active output item，
       * 而 reasoning 永远在最前面。
       */
      res.write(sse({ id: 'c1', model: 'm', choices: [{ index: 0, delta: { reasoning_content: '让我想想…' } }] }));
      res.write(sse({ id: 'c1', model: 'm', choices: [{ index: 0, delta: { reasoning_content: '嗯，答案是 42。' } }] }));
      res.write(sse({ id: 'c1', model: 'm', choices: [{ index: 0, delta: { content: '答案是 42。' } }] }));
    } else if (scenario.kind === 'empty') {
      // 上游只回 usage、没有任何内容帧
      res.write(sse({ id: 'c1', model: 'm', choices: [{ index: 0, delta: {} }] }));
    }
    res.write(sse({
      id: 'c1',
      model: 'm',
      choices: [{ index: 0, delta: {}, finish_reason: scenario.kind === 'empty' ? 'stop' : 'stop' }],
      usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
    }));
    res.write('data: [DONE]\n\n');
    res.end();
  });
});
await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
const UPSTREAM_PORT = upstream.address().port;

// ── 桥 ────────────────────────────────────────────────────────────────────
const dir = mkdtempSync(join(tmpdir(), 'wb-resp-test-'));

/*
 * 一份**结构完整**的假登录文件。
 *
 * 必须给真的：`/health` 会调 `readStoredAuth()`，登录文件缺失或结构不对时它
 * 直接回 503 —— 而 waitReady 是靠 /health 判桥起没起来的，于是整份测试
 * 会以「桥没起来」的假象全红（第一次跑就是这么翻的车）。
 * 令牌本身仍是假的：这些用例只验协议翻译，不验能不能真打通上游。
 */
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const authFile = join(dir, 'fake-auth.info');
writeFileSync(authFile, JSON.stringify({
  auth: {
    accessToken: `${b64({ alg: 'none' })}.${b64({ sub: 'resp-test-user', exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`,
    refreshToken: 'fake-refresh',
    expiresAt: Date.now() + 3600_000,
    domain: 'copilot.tencent.com',
  },
}));

const bridgePort = 20000 + Math.floor(Math.random() * 20000);
const child = spawn(process.execPath, [BRIDGE], {
  cwd: dir,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    WORKBUDDY_HOST: '127.0.0.1',
    WORKBUDDY_PORT: String(bridgePort),
    WORKBUDDY_LOCAL_TOKEN: TOKEN,
    WORKBUDDY_AUTH_FILE: authFile,
    CODEBUDDY_ENDPOINT: `http://127.0.0.1:${UPSTREAM_PORT}`,
    CODEBUDDY_API_KEY: 'stub-key',
    WORKBUDDY_AUTO_CHECKIN: '0',
    WORKBUDDY_LOG: '0',
    // 固定解析结果，免得住默认值一变用例就跟着漂
    WORKBUDDY_RESPONSES_MODEL: 'resolved-default',
    WORKBUDDY_RESPONSES_FAST_MODEL: 'resolved-fast',
  },
});
let bridgeLog = '';
child.stdout.on('data', (d) => { bridgeLog += d; });
child.stderr.on('data', (d) => { bridgeLog += d; });

const BASE = `http://127.0.0.1:${bridgePort}`;
const auth = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };

/**
 * 等桥起来。
 *
 * **必须校验到我们自己这个进程**（200 + 我们的令牌）：只判「端口上有人应答」
 * 的话，本机真实桥占用同一端口时会假绿 —— 这个坑 bridge-startup 那边踩过一次。
 */
async function waitReady() {
  for (let i = 0; i < 100; i += 1) {
    try {
      const r = await fetch(`${BASE}/health`, { headers: auth });
      if (r.status === 200) {
        const j = await r.json();
        if (j?.pid === child.pid) return true;
      }
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`桥没起来（pid=${child.pid}）\n${bridgeLog.slice(-2000)}`);
}

/** 发一个 /v1/responses 请求，回原始文本 + 状态码。 */
async function post(payload) {
  const r = await fetch(`${BASE}/v1/responses`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify(payload),
  });
  return { status: r.status, text: await r.text(), headers: r.headers };
}

/** 把 SSE 文本解析成 [{event, data}]。 */
function parseSse(text) {
  const out = [];
  for (const block of text.split('\n\n')) {
    const ev = block.split('\n').find((l) => l.startsWith('event:'));
    const da = block.split('\n').find((l) => l.startsWith('data:'));
    if (!da) continue;
    try {
      out.push({ event: ev ? ev.slice(6).trim() : null, data: JSON.parse(da.slice(5).trim()) });
    } catch { /* 忽略半包 */ }
  }
  return out;
}

// ── 用例 ──────────────────────────────────────────────────────────────────

test('流式文本：事件顺序正确，且内容在 output_item.done 里完整给出', async () => {
  await waitReady();
  scenario = { kind: 'text' };
  const { status, text, headers } = await post({
    model: 'gpt-5.1-codex',
    stream: true,
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
  });

  assert.equal(status, 200, '流式必须回 200');
  assert.match(headers.get('content-type') || '', /text\/event-stream/, '必须是 SSE');

  const evs = parseSse(text);
  const kinds = evs.map((e) => e.event);
  const idx = (k) => kinds.indexOf(k);

  assert.equal(kinds[0], 'response.created', '首个事件必须是 response.created');
  assert.ok(idx('response.in_progress') > -1, '缺 response.in_progress');
  assert.ok(idx('response.output_item.added') > -1, '缺 output_item.added');
  assert.ok(idx('response.output_item.added') < idx('response.output_text.delta'),
    'output_item.added 必须先于第一个 delta（Codex 要求 active_item 已存在）');
  assert.equal(kinds.at(-1), 'response.completed', '最后一个事件必须是 response.completed');

  // 文本分片必须逐片转发（三片 → 三条 delta）
  const deltas = evs.filter((e) => e.event === 'response.output_text.delta').map((e) => e.data.delta);
  assert.deepEqual(deltas, ['Hel', 'lo ', 'world'], '文本分片被丢了或合并了');

  // Codex 只在 done 里取内容 —— 这里必须是完整文本
  const done = evs.find((e) => e.event === 'response.output_item.done');
  assert.ok(done, '缺 output_item.done');
  assert.equal(done.data.item.type, 'message');
  assert.equal(done.data.item.role, 'assistant');
  assert.equal(done.data.item.content[0].type, 'output_text');
  assert.equal(done.data.item.content[0].text, 'Hello world', 'done 里的文本不完整');

  // 同一个 item_id 必须贯穿 added / delta / done，否则 Codex 对不上号
  const added = evs.find((e) => e.event === 'response.output_item.added');
  assert.equal(added.data.item.id, done.data.item.id, 'added 与 done 的 item id 不一致');
  for (const d of evs.filter((e) => e.event === 'response.output_text.delta')) {
    assert.equal(d.data.item_id, done.data.item.id, 'delta 的 item_id 与 done 不一致');
  }
});

test('response.completed 的 usage 三个总数齐全（少一个 Codex 判流损坏）', async () => {
  await waitReady();
  scenario = { kind: 'text' };
  const { text } = await post({
    model: 'gpt-5.1-codex', stream: true,
    input: [{ type: 'message', role: 'user', content: 'hi' }],
  });
  const completed = parseSse(text).find((e) => e.event === 'response.completed');
  assert.ok(completed, '缺 response.completed');
  const u = completed.data.response.usage;
  for (const k of ['input_tokens', 'output_tokens', 'total_tokens']) {
    assert.equal(typeof u[k], 'number', `usage.${k} 必须是数字（Codex 的 ResponseCompletedUsage 里没有 Option）`);
    assert.ok(Number.isFinite(u[k]), `usage.${k} 不能是 NaN`);
  }
  assert.equal(u.input_tokens, 7);
  assert.equal(u.output_tokens, 3);
  assert.equal(u.total_tokens, 10);
});

test('工具调用：名字分片必须拼回完整名字，且在 done 里带全参数', async () => {
  await waitReady();
  scenario = { kind: 'tool' };
  const { text } = await post({
    model: 'gpt-5.1-codex', stream: true,
    input: [{ type: 'message', role: 'user', content: 'weather in SH?' }],
    tools: [{ type: 'function', name: 'get_weather', description: 'w', parameters: { type: 'object', properties: {} } }],
  });
  const evs = parseSse(text);
  const fcd = evs.find((e) => e.event === 'response.output_item.done' && e.data.item.type === 'function_call');
  assert.ok(fcd, '缺 function_call 的 output_item.done —— Codex 只从这里取工具调用');

  assert.equal(fcd.data.item.name, 'get_weather',
    '名字被拼错/截断（首片写入 + 后续守卫会丢掉分片，这是 Anthropic 那条流踩过的同一个坑）');
  assert.equal(fcd.data.item.call_id, 'call_abc');
  assert.equal(fcd.data.item.status, 'completed');
  assert.equal(fcd.data.item.arguments, '{"city":"SH"}', 'done 里的 arguments 必须完整');

  // 参数分片也要转发
  const argDeltas = evs.filter((e) => e.event === 'response.function_call_arguments.delta');
  assert.equal(argDeltas.map((e) => e.data.delta).join(''), '{"city":"SH"}');
  // added 必须在第一个 delta 之前
  const aIdx = evs.findIndex((e) => e.event === 'response.output_item.added' && e.data.item.type === 'function_call');
  const dIdx = evs.findIndex((e) => e.event === 'response.function_call_arguments.delta');
  assert.ok(aIdx > -1 && aIdx < dIdx, 'output_item.added 必须先于参数 delta');

  // 文本块与工具块共用一个单调递增的 output_index，且不能重复
  const indices = evs
    .filter((e) => e.event === 'response.output_item.done')
    .map((e) => e.data.output_index);
  assert.deepEqual(indices, [...new Set(indices)], `output_index 有重复：${indices}`);
  assert.deepEqual(indices, indices.slice().sort((a, b) => a - b), `output_index 必须单调递增：${indices}`);
});

test('freeform（custom）工具：回 custom_tool_call + 裸正文，不发 function_call 那套', async () => {
  await waitReady();
  scenario = { kind: 'customTool' };
  const { text } = await post({
    model: 'gpt-5.1-codex', stream: true,
    input: [{ type: 'message', role: 'user', content: 'edit the file' }],
    tools: [
      { type: 'function', name: 'exec_command', description: 'run', parameters: { type: 'object', properties: { cmd: { type: 'string' } } } },
      {
        type: 'custom',
        name: 'apply_patch',
        description: 'The `apply_patch` tool can be used to edit files. This is a FREEFORM tool, so do not wrap the patch in JSON.',
        format: { type: 'grammar', syntax: 'lark', definition: 'start: begin_patch' },
      },
    ],
  });
  const evs = parseSse(text);

  const done = evs.find((e) => e.event === 'response.output_item.done' && e.data.item.type === 'custom_tool_call');
  assert.ok(done, 'apply_patch 必须回 custom_tool_call —— 发成 function_call 时 Codex 的工具路由器判 '
    + '`tool apply_patch invoked with incompatible payload`（2026-10-13 真机实测）');
  assert.equal(done.data.item.name, 'apply_patch');
  assert.equal(done.data.item.call_id, 'call_patch');
  assert.equal(done.data.item.status, 'completed');
  assert.equal(done.data.item.input, '*** Begin Patch\n*** Add File: a.txt\n+hi\n*** End Patch\n',
    'done 里必须是拆掉 JSON 外壳的裸正文（分片也要拼完整）');

  // 项类型二选一：不能同时出现 function_call 块
  assert.equal(evs.some((e) => e.data?.item?.type === 'function_call'), false,
    '同一个工具块不能既当 custom_tool_call 又当 function_call');
  // 参数 delta 是 JSON 外壳（对客户端是乱码）—— 这类块不该逐片转发
  assert.equal(evs.some((e) => e.event === 'response.function_call_arguments.delta'), false,
    'custom 块不能发 function_call_arguments.delta');

  const added = evs.find((e) => e.event === 'response.output_item.added' && e.data.item.type === 'custom_tool_call');
  assert.ok(added, '缺 custom_tool_call 的 output_item.added（delta 之前必须先有 active item）');
  assert.equal(added.data.item.input, '', 'added 里 input 给空串，完整正文靠 done（真实 API 同款）');
  assert.equal(added.data.item.id, done.data.item.id, 'added 与 done 的 item id 要一致');

  const inputDone = evs.find((e) => e.event === 'response.custom_tool_call_input.done');
  assert.ok(inputDone, '缺 response.custom_tool_call_input.done');
  assert.equal(inputDone.data.input, done.data.item.input);
  assert.equal(inputDone.data.item_id, done.data.item.id);

  const aIdx = evs.findIndex((e) => e.event === 'response.output_item.added' && e.data.item.type === 'custom_tool_call');
  const dIdx = evs.findIndex((e) => e.event === 'response.custom_tool_call_input.delta');
  assert.ok(aIdx > -1 && dIdx > aIdx, 'output_item.added 必须先于 input delta');
});

test('请求翻译：custom 工具翻成函数（input 参数），custom 调用记录双向映射', async () => {
  await waitReady();
  scenario = { kind: 'text' };
  await post({
    model: 'gpt-5.1-codex', stream: true,
    input: [
      { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'sys' }] },
      { type: 'message', role: 'user', content: 'edit it' },
      { type: 'custom_tool_call', call_id: 'call_p1', name: 'apply_patch', input: '*** Begin Patch\n*** End Patch\n' },
      { type: 'custom_tool_call_output', call_id: 'call_p1', output: 'Success. Updated the following files:\nA a.txt\n' },
    ],
    tools: [
      {
        type: 'custom',
        name: 'apply_patch',
        description: 'The `apply_patch` tool can be used to edit files. This is a FREEFORM tool, so do not wrap the patch in JSON.',
        format: { type: 'grammar', syntax: 'lark', definition: 'start: begin_patch' },
      },
    ],
  });

  const tool = (lastUpstreamBody?.tools || []).find((t) => t?.function?.name === 'apply_patch');
  assert.ok(tool, 'custom 工具必须转发给上游 —— 原先这里是**静默丢弃**，模型只能靠系统提示蒙调用');
  assert.equal(tool.type, 'function', '上游不认 freeform，翻成普通函数');
  assert.deepEqual(tool.function.parameters.required, ['input'], 'freeform 正文走唯一必需的字符串参数 input');
  assert.doesNotMatch(tool.function.description, /do not wrap the patch in JSON/i,
    '模板里"别包 JSON"那句必须改掉 —— 与这里的函数接口直接打架');
  assert.match(tool.function.description, /string argument `input`/, '要明确告诉模型正文放哪个参数');

  const msgs = lastUpstreamBody.messages;
  const assistant = msgs.find((m) => Array.isArray(m.tool_calls));
  assert.ok(assistant, 'custom_tool_call 要转成 assistant.tool_calls');
  const call = assistant.tool_calls.find((c) => c.id === 'call_p1');
  assert.ok(call, 'call_id 必须原样带过去（否则下一轮 tool 结果对不上号）');
  assert.equal(call.function.name, 'apply_patch');
  assert.deepEqual(JSON.parse(call.function.arguments), { input: '*** Begin Patch\n*** End Patch\n' },
    '裸正文要按出站时声明的 {input} 形状重新包成 JSON');
  const toolMsg = msgs.find((m) => m.role === 'tool' && m.tool_call_id === 'call_p1');
  assert.ok(toolMsg, 'custom_tool_call_output 要转成 role:"tool" 消息');
  assert.match(String(toolMsg.content), /Success\. Updated the following files/);
});

test('非流式：custom 工具同样回 custom_tool_call（与流式形状一致）', async () => {
  await waitReady();
  scenario = { kind: 'customTool' };
  const { status, text } = await post({
    model: 'gpt-5.1-codex', stream: false,
    input: [{ type: 'message', role: 'user', content: 'edit' }],
    tools: [{ type: 'custom', name: 'apply_patch', description: 'edit files' }],
  });
  assert.equal(status, 200);
  const j = JSON.parse(text);
  const item = j.output.find((i) => i.type === 'custom_tool_call');
  assert.ok(item, '非流式的 output 里也必须是 custom_tool_call（两边形状不一致客户端会判 payload 不符）');
  assert.equal(item.input, '*** Begin Patch\n*** Add File: a.txt\n+hi\n*** End Patch\n');
  assert.equal(j.output.some((i) => i.type === 'function_call'), false);
});

test('非流式：回完整的 Responses 对象（output / output_text / usage）', async () => {
  await waitReady();
  scenario = { kind: 'text' };
  const { status, text } = await post({
    model: 'gpt-5.1-codex', stream: false,
    input: [{ type: 'message', role: 'user', content: 'hi' }],
  });
  assert.equal(status, 200);
  const j = JSON.parse(text);
  assert.equal(j.object, 'response');
  assert.match(j.id, /^resp_/, 'id 必须是 resp_ 前缀');
  assert.equal(j.status, 'completed');
  assert.equal(j.model, 'resolved-default', '模型名必须被解析成桥认识的 id');
  assert.equal(j.output_text, 'Hello world');
  assert.equal(j.output[0].type, 'message');
  assert.equal(j.output[0].content[0].type, 'output_text');
  for (const k of ['input_tokens', 'output_tokens', 'total_tokens']) {
    assert.equal(typeof j.usage[k], 'number', `usage.${k} 缺失`);
  }
});

test('请求翻译：系统提示、工具、tool_choice、tool 结果都转成上游认的形状', async () => {
  await waitReady();
  scenario = { kind: 'text' };
  await post({
    model: 'gpt-5.1-codex',
    stream: false,
    // Codex 把系统提示放在 input 里（它的请求结构没有 instructions 字段）
    input: [
      { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'You are Codex.' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'do it' }] },
      { type: 'function_call', call_id: 'call_1', name: 'shell', arguments: '{"cmd":"ls"}' },
      { type: 'function_call', call_id: 'call_2', name: 'read_file', arguments: '{"p":"a"}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'file1\nfile2' },
      { type: 'function_call_output', call_id: 'call_2', output: [{ type: 'input_text', text: 'contents' }] },
    ],
    tools: [
      { type: 'function', name: 'shell', description: 'run', parameters: { type: 'object', properties: { cmd: { type: 'string' } } } },
      { type: 'function', name: 'read_file', parameters: { type: 'object', properties: {} } },
    ],
    tool_choice: 'auto',
    max_output_tokens: 128,
  });

  const m = lastUpstreamBody;
  assert.ok(m, '上游没收到请求体');
  assert.equal(m.stream, true, '桥必须始终向上游要流式（上游只有流式）');
  assert.equal(m.tool_choice, 'auto');
  assert.equal(m.max_tokens, 128, 'max_output_tokens 应映射成 max_tokens');

  // 首条必须是 system，且系统提示来自 input 里的 developer 项
  assert.equal(m.messages[0].role, 'system');
  assert.match(m.messages[0].content, /You are Codex\./);

  // 两个连续 function_call 必须合成**一条** assistant 消息（chat 的语义）
  const assistants = m.messages.filter((x) => x.role === 'assistant');
  assert.equal(assistants.length, 1, `连续 function_call 应合成一条 assistant 消息，实际 ${assistants.length} 条`);
  assert.equal(assistants[0].tool_calls.length, 2);
  assert.equal(assistants[0].tool_calls[0].function.name, 'shell');
  assert.equal(assistants[0].function, undefined, 'tool_calls 必须是嵌套的 function 形状（chat 协议）');

  // tool 结果两条，且顺序在 assistant 之后
  const toolMsgs = m.messages.filter((x) => x.role === 'tool');
  assert.equal(toolMsgs.length, 2, '两条 function_call_output 应转成两条 role:tool');
  assert.equal(toolMsgs[0].tool_call_id, 'call_1');
  assert.equal(toolMsgs[0].content, 'file1\nfile2', '字符串 output 应原样透传');
  assert.equal(toolMsgs[1].content, 'contents', '内容块数组形态的 output 应被抽成文本');
  const firstTool = m.messages.findIndex((x) => x.role === 'tool');
  const lastAssistant = m.messages.map((x) => x.role).lastIndexOf('assistant');
  assert.ok(lastAssistant < firstTool, 'tool 结果必须排在发出调用的 assistant 消息之后');

  // 工具定义：扁平 → 嵌套
  assert.equal(m.tools.length, 2);
  assert.equal(m.tools[0].type, 'function');
  assert.equal(m.tools[0].function.name, 'shell');
  assert.deepEqual(m.tools[0].function.parameters.properties.cmd, { type: 'string' });
});

/*
 * 新版 Codex 的 code mode：工具在 `input[].additional_tools` 里，顶层没有 `tools`。
 *
 * 只看顶层 tools 的话，上游一个工具都收不到 —— 模型只能把工具调用写进正文
 * （用户截图里那串 `<||DSML||invoke name="exec_command">`），Codex 无工具可执行，
 * 一个回合就此结束。这里把能翻的 `function` 工具翻出来；freeform 的 `exec`
 * 翻不了（上游是 chat/completions），但**必须在日志里说清楚**。
 */
test('code mode：input[].additional_tools 里的 function 工具要救回来', async () => {
  await waitReady();
  scenario = { kind: 'text' };
  await post({
    model: 'glm-5.3',
    stream: false,
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
      {
        type: 'additional_tools',
        id: 'at_1',
        role: 'developer',
        tools: [
          {
            type: 'namespace',
            name: 'functions',
            tools: [
              { type: 'custom', name: 'exec', format: { type: 'grammar', syntax: 'lark', definition: 'x' } },
              { type: 'function', name: 'wait', description: 'wait', parameters: { type: 'object', properties: { ms: { type: 'number' } } } },
            ],
          },
          {
            type: 'namespace',
            name: 'collaboration',
            tools: [{ type: 'function', name: 'send_message', description: 'send', parameters: { type: 'object', properties: {} } }],
          },
        ],
      },
    ],
    tool_choice: 'auto',
  });

  const m = lastUpstreamBody;
  assert.ok(m, '上游没收到请求体');
  assert.ok(Array.isArray(m.tools), 'code mode 下也要把能翻的 function 工具转过去');
  assert.deepEqual(m.tools.map((t) => t.function.name).sort(), ['send_message', 'wait']);
  assert.equal(m.tools.every((t) => t.type === 'function' && t.function.parameters), true, '翻出来的必须是完整 function 形状');
  // `additional_tools` 只是工具定义，不该被当成对话消息塞进 messages
  assert.equal(m.messages.some((x) => /additional_tools/.test(String(x.content))), false);
});

test('模型解析：上游真实 id 原样用，小快名字走 fast，其余走默认', async () => {
  await waitReady();
  const seen = async (model) => {
    scenario = { kind: 'text' };
    await post({ model, stream: false, input: [{ type: 'message', role: 'user', content: 'x' }] });
    return lastUpstreamBody.model;
  };
  assert.equal(await seen('gpt-5.1-codex'), 'resolved-default', '认不出的模型应走默认');
  assert.equal(await seen('gpt-5.1-codex-mini'), 'resolved-fast', 'mini 应走 fast');
  assert.equal(await seen(''), 'resolved-default', '没给模型时走默认');
  assert.equal(await seen('resolved-fast'), 'resolved-fast', '目录里有的 id 原样用');
});

test('上游非 2xx（流式）：改发 response.failed 事件，不能中途改回 JSON', async () => {
  await waitReady();
  scenario = { kind: 'error' };
  const { status, text, headers } = await post({
    model: 'gpt-5.1-codex', stream: true,
    input: [{ type: 'message', role: 'user', content: 'hi' }],
  });
  // 已经答应过「这是事件流」，就必须用 SSE 收尾 —— 半路换成 JSON 会让
  // 客户端既解析不出事件、又拿不到结构化的错误。
  assert.equal(status, 200, '流式路径的错误也要用 200 + SSE 表达');
  assert.match(headers.get('content-type') || '', /text\/event-stream/);
  const evs = parseSse(text);
  const failed = evs.find((e) => e.event === 'response.failed');
  assert.ok(failed, '缺 response.failed');
  assert.equal(failed.data.response.status, 'failed');
  assert.match(failed.data.response.error.message, /upstream says no/, '上游的错误原文应透出');
});

test('上游非 2xx（非流式）：按 Responses 的错误形状回 JSON', async () => {
  await waitReady();
  scenario = { kind: 'error' };
  const { status, text } = await post({
    model: 'gpt-5.1-codex', stream: false,
    input: [{ type: 'message', role: 'user', content: 'hi' }],
  });
  assert.notEqual(status, 200, '非流式路径应如实回上游的状态码');
  const j = JSON.parse(text);
  assert.ok(j.error, '必须有 error 字段');
  assert.match(j.error.message, /upstream says no/);
});

test('空回答：仍要有 output_item.done 与 completed（不能什么都不发）', async () => {
  await waitReady();
  scenario = { kind: 'empty' };
  const { text } = await post({
    model: 'gpt-5.1-codex', stream: true,
    input: [{ type: 'message', role: 'user', content: 'hi' }],
  });
  const evs = parseSse(text);
  assert.ok(evs.some((e) => e.event === 'response.created'), '缺 response.created');
  assert.ok(evs.some((e) => e.event === 'response.completed'),
    '上游没有内容帧时也必须收尾 —— 否则客户端会一直挂着等流');
});

test('未带令牌：401 且不落任何上游请求', async () => {
  await waitReady();
  scenario = { kind: 'text' };
  lastUpstreamBody = null;
  const r = await fetch(`${BASE}/v1/responses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'x', stream: true, input: [] }),
  });
  assert.equal(r.status, 401);
  assert.equal(lastUpstreamBody, null, '未鉴权的请求绝不能打到上游（会真实扣额度）');
});

/**
 * 另起一个桥（带额外环境变量）—— 用来验"开关类"行为。
 *
 * 主桥的 env 在模块加载时就定死了，而开关必须**在桥启动时**生效（进程级配置），
 * 所以只能另起一个。端口随机、令牌与假上游都复用主桥那一套。
 */
async function startBridge(extraEnv = {}) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const proc = spawn(process.execPath, [BRIDGE], {
    cwd: dir,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      WORKBUDDY_HOST: '127.0.0.1',
      WORKBUDDY_PORT: String(port),
      WORKBUDDY_LOCAL_TOKEN: TOKEN,
      WORKBUDDY_AUTH_FILE: authFile,
      CODEBUDDY_ENDPOINT: `http://127.0.0.1:${UPSTREAM_PORT}`,
      CODEBUDDY_API_KEY: 'stub-key',
      WORKBUDDY_AUTO_CHECKIN: '0',
      WORKBUDDY_LOG: '0',
      WORKBUDDY_RESPONSES_MODEL: 'resolved-default',
      WORKBUDDY_RESPONSES_FAST_MODEL: 'resolved-fast',
      ...extraEnv,
    },
  });
  let log = '';
  proc.stdout.on('data', (d) => { log += d; });
  proc.stderr.on('data', (d) => { log += d; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i += 1) {
    try {
      const r = await fetch(`${base}/health`, { headers: auth });
      if (r.status === 200 && (await r.json())?.pid === proc.pid) {
        return {
          base,
          kill: () => proc.kill(),
          post: async (payload) => {
            const rr = await fetch(`${base}/v1/responses`, {
              method: 'POST', headers: auth, body: JSON.stringify(payload),
            });
            return { status: rr.status, text: await rr.text() };
          },
        };
      }
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  proc.kill();
  throw new Error(`开关桥没起来\n${log.slice(-1500)}`);
}

/*
 * 上游的思维链：默认**丢弃**，开了开关才按 reasoning 项转发。
 *
 * 为什么默认关（见桥里 `forwardReasoning` 的注释）：Codex 要求 reasoning 的 delta
 * 到达时已有 active output item，而上游的 reasoning 总在最前面 —— 得先把 reasoning
 * 项打开、发完再关掉。事件名在 `codex.exe` 里能搜到（说明它认这套），但**事件顺序
 * 与目录里 `default_reasoning_summary` 的取值**都要一次真机对照实验才能定论。
 * 所以这里钉两件事：默认行为**一个字节不变**；开了开关时事件顺序符合那条硬约束。
 */
test('思维链：默认丢弃；开开关后按 reasoning 项转发且顺序正确', async () => {
  await waitReady();
  scenario = { kind: 'reasoning' };
  const payload = { model: 'gpt-5.1-codex', stream: true, input: [{ type: 'message', role: 'user', content: 'hi' }] };

  // 1) 默认：不许出现任何 reasoning 事件（这条改动不能把现有行为带跑）
  const off = parseSse((await post(payload)).text);
  assert.equal(off.some((e) => /reasoning/.test(e.event || '')), false,
    '默认不该发 reasoning 事件');
  assert.ok(off.some((e) => e.event === 'response.completed'), '默认路径仍要正常收尾');
  assert.ok(off.some((e) => e.event === 'response.output_text.delta'), '正文照旧要发');

  // 2) 开开关：另起一个桥
  const b = await startBridge({ WORKBUDDY_FORWARD_REASONING: '1' });
  try {
    const evs = parseSse((await b.post(payload)).text);
    const names = evs.map((e) => e.event);
    const first = evs.find((e) => e.event === 'response.reasoning_summary_text.delta');
    assert.ok(first, '开了开关就要转发思维链 delta');
    assert.equal(first.data.summary_index, 0, 'summary_index 固定 0');
    assert.match(JSON.stringify(evs.filter((e) => e.event === 'response.reasoning_summary_text.delta')),
      /让我想想/, '两段思维链都要发出去');
    assert.ok(names.includes('response.reasoning_summary_part.added'), '要先开 summary part');
    /*
     * 硬约束：reasoning 的 delta 必须**晚于**它自己的 output_item.added，
     * 且整个 reasoning 项要在文本块之前关掉 —— Codex 就是按这个顺序解析的。
     */
    const idxReasonAdded = evs.findIndex((e) => e.event === 'response.output_item.added' && e.data.item?.type === 'reasoning');
    const idxFirstDelta = evs.findIndex((e) => e.event === 'response.reasoning_summary_text.delta');
    const idxText = names.indexOf('response.output_text.delta');
    assert.ok(idxReasonAdded >= 0, 'reasoning 项要先 added');
    assert.ok(idxFirstDelta > idxReasonAdded, 'delta 必须晚于 reasoning 项的 added（Codex 的硬约束）');
    assert.ok(idxText > idxFirstDelta, '文本块要排在 reasoning 之后');
    // 收尾：done 事件齐全，且进 completed.output
    assert.ok(names.includes('response.reasoning_summary_text.done'));
    assert.ok(names.includes('response.reasoning_summary_part.done'));
    const done = evs.find((e) => e.event === 'response.output_item.done' && e.data.item?.type === 'reasoning');
    assert.ok(done, 'reasoning 项要有 output_item.done');
    assert.match(JSON.stringify(done.data.item.summary), /答案是 42/, 'done 里要带完整思维链');
    const completed = evs.find((e) => e.event === 'response.completed');
    assert.ok(completed.data.response.output.some((it) => it.type === 'reasoning'),
      'completed.output 里要带上 reasoning 项（否则客户端拼不出完整输出）');
    assert.equal(completed.data.response.output_text, '答案是 42。', '正文照旧');
  } finally {
    b.kill();
  }
});

/*
 * 截断收尾：Codex **只认** `reason: "interrupted"`。
 *
 * 依据 `codex-rs/codex-api/src/sse/responses.rs`：`response.incomplete` 的
 * `reason` 除 `interrupted` 外一律 `Err(Stream("Incomplete response returned,
 * reason: {reason}"))` —— 也就是**整轮中断**，用户看到的是报错而不是"回答被截断"。
 * 桥原先发的是 `max_output_tokens`，等于每次触发 max_output_tokens 都把回合炸掉。
 *
 * 另外 `end_turn` 必须显式 `false`（`ResponseCompleted.end_turn: Option<bool>`），
 * 否则 Codex 会把这一轮当成"模型自己说完了"，不去续写剩下的部分。
 */
test('max_output_tokens 截断：reason 必须是 interrupted（发 max_output_tokens 会让 Codex 炸流）', async () => {
  await waitReady();
  scenario = { kind: 'truncated' };
  const { status, text } = await post({
    model: 'gpt-5.1-codex', stream: true, max_output_tokens: 16,
    input: [{ type: 'message', role: 'user', content: 'hi' }],
  });
  assert.equal(status, 200);
  const evs = parseSse(text);
  const inc = evs.find((e) => e.event === 'response.incomplete');
  assert.ok(inc, '截断时必须发 response.incomplete');
  assert.equal(inc.data.response.status, 'incomplete');
  assert.equal(inc.data.response.incomplete_details.reason, 'interrupted',
    'reason 只能是 interrupted —— 其它任何值（包括 max_output_tokens）都会让 Codex 抛流错误、整轮失败');
  assert.equal(inc.data.response.end_turn, false,
    '截断时 end_turn 必须是 false，否则 Codex 以为模型自己说完了、不会继续');
  // 截断的正文仍要完整给出（Codex 只在 done 里取内容）
  const done = evs.find((e) => e.event === 'response.output_item.done');
  assert.ok(done, '缺 output_item.done');
  assert.equal(done.data.item.content[0].text, 'partial');
  // 截断路径不该再出现 completed
  assert.equal(evs.some((e) => e.event === 'response.completed'), false,
    '截断时不能同时发 completed —— 两个收尾事件会让 Codex 行为未定义');
});

test('非流式截断：incomplete_details.reason 同样是 interrupted，且 end_turn=false', async () => {
  await waitReady();
  scenario = { kind: 'truncated' };
  const { status, text } = await post({
    model: 'gpt-5.1-codex', stream: false, max_output_tokens: 16,
    input: [{ type: 'message', role: 'user', content: 'hi' }],
  });
  assert.equal(status, 200);
  const j = JSON.parse(text);
  assert.equal(j.status, 'incomplete');
  assert.equal(j.incomplete_details.reason, 'interrupted',
    '非流式也必须用 interrupted（同一个枚举值）');
  assert.equal(j.end_turn, false);
  assert.equal(j.output_text, 'partial');
});

/*
 * 正常收尾：`end_turn: true` + `response.headers["openai-model"]` 回显真实模型。
 *
 * - `end_turn: true` 是 Codex 判"这一轮自然结束"的依据（`Some(false)` 会被当成需要继续）。
 * - `openai-model` 头是 Codex `response_model()` 的来源：不回显的话它只能沿用请求里
 *   那个（可能是 `gpt-5.1-codex` 这种桥内部再映射的别名），界面上显示的模型就是错的。
 */
test('正常收尾：end_turn=true 且回显真实模型（openai-model 头）', async () => {
  await waitReady();
  scenario = { kind: 'text' };
  const { text } = await post({
    model: 'gpt-5.1-codex', stream: true,
    input: [{ type: 'message', role: 'user', content: 'hi' }],
  });
  const completed = parseSse(text).find((e) => e.event === 'response.completed');
  assert.ok(completed, '缺 response.completed');
  assert.equal(completed.data.response.end_turn, true, '正常收尾要显式 end_turn:true');
  /*
   * `incomplete_details` 在正常收尾时给 `null` 是**安全的**：Codex 的
   * `ResponseCompleted` 只有 4 个字段（id/usage/usage_metadata/end_turn，
   * 见 `codex-rs/codex-api/src/sse/responses.rs:108`），既没有 `incomplete_details`
   * 也没有 `deny_unknown_fields` —— 多了的字段被 serde 直接忽略。
   * 所以这里只要求"不是非 null 的截断标记"，不要求它消失。
   */
  assert.ok(completed.data.response.incomplete_details == null,
    '正常收尾不该带截断标记（null / 缺省都行，Codex 都当 None）');
  assert.equal(completed.data.response.headers?.['openai-model'], 'resolved-default',
    'completed 里要回显上游真实模型（Codex 的 response_model() 读这个头）');
});

test('usage 细节：cached_tokens / reasoning_tokens 要透传（Codex 的用量面板读这两项）', async () => {
  await waitReady();
  scenario = { kind: 'usageDetails' };
  const { text } = await post({
    model: 'gpt-5.1-codex', stream: true,
    input: [{ type: 'message', role: 'user', content: 'hi' }],
  });
  const u = parseSse(text).find((e) => e.event === 'response.completed').data.response.usage;
  assert.equal(u.input_tokens_details?.cached_tokens, 64, '缓存命中数要透传');
  assert.equal(u.output_tokens_details?.reasoning_tokens, 25, '思维链 token 数要透传');
  // 三个总数仍必须在
  assert.equal(u.input_tokens, 100);
  assert.equal(u.output_tokens, 40);
  assert.equal(u.total_tokens, 140);
});

/*
 * 429 的错误码映射：Codex 按 `error.code` 决定要不要自动退避重试。
 *
 * 依据 `codex-rs/codex-api/src/sse/responses_error.rs`：只认
 * `rate_limit_exceeded` / `server_is_overloaded` / `context_length_exceeded` 等少数几个；
 * 不映射的话它就当成普通 `upstream_error` —— 上下文超限不会被裁剪、限流不会退避，
 * 用户只能手动重试。`retry-after` 要从 `error.headers` 里读。
 */
test('429 限流（流式）：response.failed 带 rate_limit_exceeded 与 retry-after', async () => {
  await waitReady();
  scenario = { kind: 'error429' };
  const { status, text, headers } = await post({
    model: 'gpt-5.1-codex', stream: true,
    input: [{ type: 'message', role: 'user', content: 'hi' }],
  });
  assert.equal(status, 200, '流式路径必须用 200 + SSE 收尾');
  assert.match(headers.get('content-type') || '', /text\/event-stream/);
  const failed = parseSse(text).find((e) => e.event === 'response.failed');
  assert.ok(failed, '缺 response.failed');
  assert.equal(failed.data.response.error.code, 'rate_limit_exceeded',
    '429 必须映射成 rate_limit_exceeded，否则 Codex 不会自动退避重试');
  assert.equal(failed.data.response.error.headers?.['retry-after'], '7',
    'retry-after 要放进 error.headers（Codex 从这里读退避时长）');
});

test('5xx：映射成 server_is_overloaded；非流式也带 error.code，且如实回状态码', async () => {
  await waitReady();
  scenario = { kind: 'error500' };
  const { status, text } = await post({
    model: 'gpt-5.1-codex', stream: false,
    input: [{ type: 'message', role: 'user', content: 'hi' }],
  });
  assert.equal(status, 500, '非流式如实回上游状态码');
  const j = JSON.parse(text);
  assert.equal(j.error.code, 'server_is_overloaded', '5xx 要映射成 server_is_overloaded');
  assert.match(j.error.message, /boom/);

  // 同一条上游行为在流式路径上要变成 SSE response.failed
  scenario = { kind: 'error500' };
  const s = await post({
    model: 'gpt-5.1-codex', stream: true,
    input: [{ type: 'message', role: 'user', content: 'hi' }],
  });
  const failed = parseSse(s.text).find((e) => e.event === 'response.failed');
  assert.ok(failed, '流式路径缺 response.failed');
  assert.equal(failed.data.response.error.code, 'server_is_overloaded');
});

test('上下文超限：按措辞识别成 context_length_exceeded（Codex 才会去裁剪上下文）', async () => {
  await waitReady();
  scenario = { kind: 'ctxlen' };
  const { status, text } = await post({
    model: 'gpt-5.1-codex', stream: false,
    input: [{ type: 'message', role: 'user', content: 'hi' }],
  });
  assert.equal(status, 400);
  const j = JSON.parse(text);
  assert.equal(j.error.code, 'context_length_exceeded',
    '上游只说 "maximum context length exceeded"，桥要认出来并映射');
});

// ── 收尾 ──────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test.after(async () => {
  child.kill();
  upstream.close();
  /*
   * Windows 上删临时目录会碰到 EPERM：桥进程刚被 kill、它持有的文件句柄还没释放，
   * `rmSync` 就直接失败 —— 于是**全部断言都过了，整个测试文件仍然报错**
   * （退出码非 0，卡住 `npm run release:check`）。实测每次必现。
   *
   * 处理：先等进程真的退出，再带重试地删；仍然删不掉就**只警告**——
   * 临时目录清理失败不该被判成产品缺陷，那会让门禁长期挂着一个假的红。
   */
  await new Promise((r) => {
    if (child.exitCode !== null || child.signalCode) { r(); return; }
    child.once('exit', r);
    setTimeout(r, 2000);   // 兜底：不让收尾钩子无限等
  });
  for (let i = 0; i < 5; i += 1) {
    try { rmSync(dir, { recursive: true, force: true }); return; } catch { await sleep(200); }
  }
  try { rmSync(dir, { recursive: true, force: true }); } catch (e) {
    console.warn(`[收尾] 临时目录没能删掉（不影响用例结论）：${dir} —— ${e.code || e.message}`);
  }
});
