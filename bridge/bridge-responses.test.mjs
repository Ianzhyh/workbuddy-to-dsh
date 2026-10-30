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
import { pickBridgePort, isPortInUseError } from '../tools/dev/bridge-ports.mjs';

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

    if (scenario.kind === '11128thenText') {
      scenario.calls = (scenario.calls || 0) + 1;
      if (scenario.calls === 1) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 11128, msg: 'Illegal API invocation from an unapproved channel' }));
        return;
      }
      // 第二次走下面的正常文本分支
    }

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

    if (scenario.kind === 'ctxlenReal') {
      /*
       * **上游真实原文**（2026-10-13 bridge.log 实测，不是编的）：
       *   {"code":11115,"msg":"prompt is too long: 1252936 tokens > 1048576 maximum"}
       * 旧正则只认 "context length" / "too many tokens" / "maximum context"，
       * 这条**一个都不匹配** → 落兜底 upstream_error → Codex 归到 Retryable →
       * 原样重发 6 次、白烧 249 秒才失败（实测 08:50:33→08:52:16 连 6 条）。
       */
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 11115, msg: 'prompt is too long: 1252936 tokens > 1048576 maximum' }));
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

    if (scenario.kind === 'noTrailingNewline') {
      /*
       * 尾帧不带换行就 end()：上游/代理正常 close，但最后一帧没有 `\n`。
       * 旧实现只解析 `split('\n')` 出来的完整行，尾帧被留在 buffer 里丢掉。
       */
      res.write(sse({ id: 'c1', model: 'm', choices: [{ index: 0, delta: { content: 'done' } }] }));
      res.write('data: ' + JSON.stringify({
        id: 'c1',
        model: 'm',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
      }));
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
    } else if (scenario.kind === 'toolSearch') {
      /*
       * 模型调用「延迟工具检索」。上游看到的只是我们声明的普通函数 `tool_search`
       * （参数 `{query, limit?}`）；桥必须把这次调用回成 `tool_search_call`
       * （Codex 的**客户端**会去执行检索），回 `function_call` 会被它拒掉，
       * 检索这一步就永远发生不了。
       */
      res.write(sse({ id: 'c1', model: 'm', choices: [{ index: 0, delta: { content: 'searching' } }] }));
      res.write(sse({ id: 'c1', model: 'm', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_ts_1', type: 'function', function: { name: 'tool_search' } }] } }] }));
      res.write(sse({ id: 'c1', model: 'm', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"query":"node_repl js' } }] } }] }));
      res.write(sse({ id: 'c1', model: 'm', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '","limit":3}' } }] } }] }));
    } else if (scenario.kind === 'mcpTool') {
      /*
       * 模型调用一个**延迟下发**的 MCP 工具。桥给上游声明的是拍平名
       * `mcp__node_repl__js`；回给 Codex 必须是**短名 + 独立 namespace 字段**
       * （本机 2026-08-09 那次跑通的会话里 135/135 条 MCP 调用都是这个形状）。
       */
      res.write(sse({ id: 'c1', model: 'm', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_js_1', type: 'function', function: { name: 'mcp__node_repl__js' } }] } }] }));
      res.write(sse({ id: 'c1', model: 'm', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"code":"nodeRepl.write(1)"}' } }] } }] }));
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
    } else if (scenario.kind === 'midBreak') {
      /*
       * 上游在**流中途**断掉：已经吐了半句话，然后连接被掐（没有 finish_reason、
       * 没有 [DONE]）。真实成因：网络故障 / 上游超时 / 网关掐连接。
       *
       * 这时回答是**截断在半句话上**的。桥原来无条件发 `response.completed`
       * + `end_turn:true` → Codex 以为"回合正常结束" → 用户看到
       * **说话说一半突然停下**，且不报错、不重试。必须改成 `response.failed`。
       */
      res.write(sse({ id: 'c1', model: 'm', choices: [{ index: 0, delta: { content: '我来验证一下' } }] }));
      res.write(sse({ id: 'c1', model: 'm', choices: [{ index: 0, delta: { content: '——这句话说到一半' } }] }));
      setTimeout(() => res.destroy(), 20);
      return;   // 不走下面的正常收尾
    } else if (scenario.kind === 'halfClose') {
      // **干净半关**：上游正常 end()，但没有 finish_reason / usage / [DONE]
      res.write(sse({ id: 'c1', model: 'm', choices: [{ index: 0, delta: { content: '说到一半' } }] }));
      res.end();
      return;   // 不走下面的正常收尾
    } else if (scenario.kind === 'undeclaredToolSearch') {
      /*
       * 模型调了 `tool_search`，但**当前请求没有声明**该工具
       * （Codex 在轮次之间丢掉/改名它、或历史回放时会出现）。
       *
       * 此时 `closeTool` 的 `routes?.toolSearch` 判据为假，会落到普通
       * `function_call` 分支 —— 那条分支**会**发 `function_call_arguments.done`
       * 与 `output_item.done`。而 `flushTool` 原先**无条件**为 `tool_search`
       * 跳过 `output_item.added`，于是客户端收到一个「从未 announced 过的 item
       * 在收参数」——正好违反桥自己文档化的「added 必须先于第一个 delta」硬约束。
       */
      res.write(sse({ id: 'c1', model: 'm', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_ts', function: { name: 'tool_search' } }] } }] }));
      res.write(sse({ id: 'c1', model: 'm', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"query":"mcp"}' } }] } }] }));
    } else if (scenario.kind === 'lateToolArgs') {
      /*
       * 工具参数被**文本块打断**，之后还有该工具的迟到参数分片。
       *
       * 文本块一开就会把当时的工具块强制收尾（`output_item.done` 已交给客户端），
       * 而 Responses 的 item 是按**顺序递增且互不重叠**的 output_index 解析的，
       * 所以迟到分片**不能**再往那个已完成的 item 上拼 —— 拼了客户端就会拿到
       * 被截断的 arguments（`{"cmd":` 这种非法 JSON，工具必然执行失败）。
       */
      res.write(sse({ id: 'c1', model: 'm', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_a', function: { name: 'exec_command' } }] } }] }));
      res.write(sse({ id: 'c1', model: 'm', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"cmd":"ls"}' } }] } }] }));
      res.write(sse({ id: 'c1', model: 'm', choices: [{ index: 0, delta: { content: '顺带说一句' } }] }));
      // 迟到分片：必须在守卫处被丢弃，绝不能污染上面那个已完成的 item
      res.write(sse({ id: 'c1', model: 'm', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '" --extra"}' } }] } }] }));
    } else if (scenario.kind === 'newIndexAfterText') {
      /*
       * 工具块被文本收尾之后，上游**换一个 index** 继续发新工具调用。
       * 这种是合法形状，新调用必须照常成为独立 item（不能连它一起丢）。
       */
      res.write(sse({ id: 'c1', model: 'm', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'first_tool' } }] } }] }));
      res.write(sse({ id: 'c1', model: 'm', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"a":1}' } }] } }] }));
      res.write(sse({ id: 'c1', model: 'm', choices: [{ index: 0, delta: { content: '中间插一句' } }] }));
      res.write(sse({ id: 'c1', model: 'm', choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: 'call_2', function: { name: 'second_tool' } }] } }] }));
      res.write(sse({ id: 'c1', model: 'm', choices: [{ index: 0, delta: { tool_calls: [{ index: 1, function: { arguments: '{"b":2}' } }] } }] }));
    } else if (scenario.kind === 'parallelToolCalls') {
      /*
       * 并行工具调用**交错**下发：B 在 A 参数还没结束时出现，A 的尾片
       * 又在 B 之后回来。Codex 要求 output item 顺序递增且不重叠 —— 桥必须
       * 把 B 攒到 A 的 done 之后再 announce。
       */
      res.write(sse({ id: 'c1', model: 'm', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_a', function: { name: 'first_tool' } }] } }] }));
      res.write(sse({ id: 'c1', model: 'm', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"a":' } }] } }] }));
      res.write(sse({ id: 'c1', model: 'm', choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: 'call_b', function: { name: 'second_tool' } }] } }] }));
      res.write(sse({ id: 'c1', model: 'm', choices: [{ index: 0, delta: { tool_calls: [{ index: 1, function: { arguments: '{"b":2}' } }] } }] }));
      res.write(sse({ id: 'c1', model: 'm', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '1}' } }] } }] }));
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

/*
 * 端口不能落在临时端口段里：打桩上游走 `listen(0)`，内核会把它分到临时端口段
 * （Linux 32768–60999），而旧写法 `20000 + random()*20000` 正好横跨它 ——
 * 实测撞车过（EADDRINUSE）。理由与取端口规则见 `tools/dev/bridge-ports.mjs`。
 */
const bridgePort = pickBridgePort();
const child = spawn(process.execPath, [BRIDGE], {
  cwd: dir,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    WORKBUDDY_HOST: '127.0.0.1',
    WORKBUDDY_PORT: String(bridgePort),
    WORKBUDDY_LOCAL_TOKEN: TOKEN,
    WORKBUDDY_AUTH_FILE: authFile,
    WORKBUDDY_CREDENTIAL_DIR: join(dir, 'credentials'),
    CODEBUDDY_ENDPOINT: `http://127.0.0.1:${UPSTREAM_PORT}`,
    CODEBUDDY_API_KEY: 'stub-key',
    WORKBUDDY_AUTO_CHECKIN: '0',
    /*
     * ⚠️ 账本必须**显式**指到临时目录，`cwd: dir` 是不够的。
     *
     * `usageFile()` 解析的是 `WORKBUDDY_USAGE_FILE`，否则退回
     * **桥脚本所在目录**（`dirname(fileURLToPath(import.meta.url))`）——
     * 那是仓库里的 `bridge/usage.jsonl`，**使用者的真实账本**，与 cwd 无关。
     * 少了这一行，每跑一次本文件就会往真实账本里写几十条测试记录，
     * 而账本到 2000 行会截断保留最近一半 —— 等于把用户自己的用量历史挤掉。
     * 本文件模型名固定为 `resolved-default`/`resolved-fast`，
     * 所以污染在账本里一眼可辨（实测真实账本里 914 条 `resolved-default`、
     * 58 条 `resolved-fast`、14 条 `stub-model`，占总量一半以上）。
     */
    WORKBUDDY_USAGE_FILE: join(dir, 'usage.jsonl'),
    /*
     * 日志**开着**：有一条用例要断言请求日志里的 `dropped=` 字段
     * （"被丢掉的工具必须可见"）。关掉的话那条用例没法验，
     * 而它守的正是 2026-10-13 连续两次翻车的那个盲区。
     * 日志走 stderr，用例用 `bridgeLog` 收着，不会污染测试输出。
     */
    WORKBUDDY_LOG: '1',
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
async function post(payload, extraHeaders = {}) {
  const r = await fetch(`${BASE}/v1/responses`, {
    method: 'POST',
    headers: { ...auth, ...extraHeaders },
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

test('延迟工具检索：tool_search 必须转发，模型的调用必须回 tool_search_call', async () => {
  await waitReady();
  scenario = { kind: 'toolSearch' };
  const { text } = await post({
    model: 'gpt-5.1-codex', stream: true,
    input: [{ type: 'message', role: 'user', content: 'use computer use' }],
    tools: [
      { type: 'function', name: 'exec_command', description: 'run', parameters: { type: 'object', properties: {} } },
      {
        type: 'tool_search',
        execution: 'client',
        description: '# Tool discovery\n\nSearches over deferred tool metadata with BM25.',
        parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      },
      { type: 'web_search', external_web_access: true },
    ],
  });

  const sent = lastUpstreamBody?.tools || [];
  assert.ok(sent.some((t) => t.function?.name === 'tool_search'),
    'tool_search 必须转发给上游 —— 原先它被**静默丢弃**，于是 Codex 的 MCP 工具'
    + '（含 computer-use 的唯一入口 mcp__node_repl.js）走桥时永远发现不了，且不报错');
  assert.equal(sent.some((t) => t.function?.name === 'web_search'), false,
    'web_search 上游没有对应能力，仍然丢掉');

  const evs = parseSse(text);
  const done = evs.find((e) => e.event === 'response.output_item.done' && e.data.item.type === 'tool_search_call');
  assert.ok(done, 'tool_search 的调用必须回 tool_search_call —— 发成 function_call 会被 Codex 的工具路由器拒掉');
  assert.equal(done.data.item.call_id, 'call_ts_1');
  assert.equal(done.data.item.execution, 'client');
  assert.equal(done.data.item.status, 'completed');
  assert.deepEqual(done.data.item.arguments, { query: 'node_repl js', limit: 3 },
    'arguments 必须是**对象**（Codex 的 ToolSearchCallResponseItem 就长这样），不是 JSON 字符串');
  assert.equal(evs.some((e) => e.data?.item?.type === 'function_call'), false,
    '同一个块不能既当 tool_search_call 又当 function_call');
  assert.equal(evs.some((e) => e.event === 'response.function_call_arguments.delta'), false,
    'tool_search 不发逐片参数 delta（它没有 delta 事件，参数只走 output_item.done）');
});

test('延迟下发：tool_search_output 里的 MCP 工具要补进上游 tools[]，分组调用要拍平', async () => {
  await waitReady();
  scenario = { kind: 'text' };
  await post({
    model: 'gpt-5.1-codex', stream: true,
    input: [
      { type: 'message', role: 'user', content: 'control the desktop' },
      {
        type: 'tool_search_call', execution: 'client', call_id: 'call_ts_9', status: 'completed',
        arguments: { query: 'node_repl js', limit: 3 },
      },
      {
        type: 'tool_search_output', execution: 'client', call_id: 'call_ts_9', status: 'completed',
        tools: [
          {
            type: 'namespace',
            name: 'mcp__node_repl',
            description: 'Tools in the mcp__node_repl namespace.',
            tools: [
              {
                type: 'function',
                name: 'js',
                description: 'Run JavaScript in a persistent Node-backed kernel.',
                strict: false,
                defer_loading: true,
                parameters: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] },
              },
            ],
          },
        ],
      },
      { type: 'function_call', call_id: 'call_js_9', name: 'js', namespace: 'mcp__node_repl', arguments: '{"code":"1"}' },
      { type: 'function_call_output', call_id: 'call_js_9', output: 'ok' },
    ],
    tools: [
      {
        type: 'tool_search', execution: 'client', description: 'search',
        parameters: { type: 'object', properties: { query: { type: 'string' } } },
      },
    ],
  });

  const sent = lastUpstreamBody?.tools || [];
  const js = sent.find((t) => t.function?.name === 'mcp__node_repl__js');
  assert.ok(js, 'tool_search_output 里的 MCP 工具必须补进上游 tools[] —— 不补的话模型看不到也调不了，'
    + 'Codex 自带的 computer-use 走桥就是不可达的');
  assert.deepEqual(js.function.parameters.required, ['code'], '内层 function 的 parameters 要原样带过去');

  const msgs = lastUpstreamBody.messages;
  const tsAssistant = msgs.find((m) => Array.isArray(m.tool_calls)
    && m.tool_calls.some((c) => c.function?.name === 'tool_search'));
  assert.ok(tsAssistant, 'tool_search_call 历史要回放成 assistant.tool_calls（名称 tool_search）');
  const tsOut = msgs.find((m) => m.role === 'tool' && m.tool_call_id === 'call_ts_9');
  assert.ok(tsOut, 'tool_search_output 要转成 role:"tool" 消息 —— 原先它和 reasoning 一起被**静默丢弃**');
  assert.match(String(tsOut.content), /mcp__node_repl__js/, '工具结果里要列出检索到的工具名，否则模型不知道检索生效了');

  const call = msgs.flatMap((m) => m.tool_calls || []).find((c) => c.id === 'call_js_9');
  assert.ok(call, '带 namespace 的 function_call 历史要回放成 assistant.tool_calls');
  assert.equal(call.function.name, 'mcp__node_repl__js',
    '带 namespace 的调用必须拍平成**出站声明过的同一个名字**，否则上游看到的是一个从没声明过的工具');
});

test('分组工具（MCP）回包：短名 + 独立 namespace 字段（与 Codex 实测形状一致）', async () => {
  await waitReady();
  scenario = { kind: 'mcpTool' };
  const { text } = await post({
    model: 'gpt-5.1-codex', stream: true,
    input: [
      { type: 'message', role: 'user', content: 'go' },
      {
        type: 'tool_search_output', execution: 'client', call_id: 'call_ts_0', status: 'completed',
        tools: [
          {
            type: 'namespace',
            name: 'mcp__node_repl',
            tools: [
              {
                type: 'function',
                name: 'js',
                description: 'run js',
                parameters: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] },
              },
            ],
          },
        ],
      },
    ],
    tools: [
      {
        type: 'tool_search', execution: 'client', description: 'search',
        parameters: { type: 'object', properties: { query: { type: 'string' } } },
      },
    ],
  });
  const evs = parseSse(text);
  const done = evs.find((e) => e.event === 'response.output_item.done' && e.data.item.type === 'function_call');
  assert.ok(done, 'MCP 工具的调用回包用 function_call');
  assert.equal(done.data.item.name, 'js', 'name 必须是**短名**（不是 mcp__node_repl__js）');
  assert.equal(done.data.item.namespace, 'mcp__node_repl',
    '必须带独立的 namespace 字段 —— 少了它 Codex 的路由器认不出这条调用属于哪个 MCP server');
  assert.equal(done.data.item.arguments, '{"code":"nodeRepl.write(1)"}');
  const added = evs.find((e) => e.event === 'response.output_item.added' && e.data.item.type === 'function_call');
  assert.ok(added, '分组工具也是普通 tool 块，delta 之前必须先有 added');
  assert.equal(added.data.item.namespace, 'mcp__node_repl', 'added 与 done 的 namespace 要一致');
  assert.equal(added.data.item.name, 'js', 'added 与 done 的 name 要一致');
});

test('非流式：tool_search 同样回 tool_search_call（与流式形状一致）', async () => {
  await waitReady();
  scenario = { kind: 'toolSearch' };
  const { status, text } = await post({
    model: 'gpt-5.1-codex', stream: false,
    input: [{ type: 'message', role: 'user', content: 'search' }],
    tools: [
      {
        type: 'tool_search', execution: 'client', description: 'search',
        parameters: { type: 'object', properties: { query: { type: 'string' } } },
      },
    ],
  });
  assert.equal(status, 200);
  const j = JSON.parse(text);
  const item = j.output.find((i) => i.type === 'tool_search_call');
  assert.ok(item, '非流式的 output 里也必须是 tool_search_call（两边形状不一致客户端会判 payload 不符）');
  assert.equal(item.execution, 'client');
  assert.deepEqual(item.arguments, { query: 'node_repl js', limit: 3 });
  assert.equal(j.output.some((i) => i.type === 'function_call'), false);
});

test('非流式：分组工具的调用同样回短名 + namespace', async () => {
  await waitReady();
  scenario = { kind: 'mcpTool' };
  const { status, text } = await post({
    model: 'gpt-5.1-codex', stream: false,
    input: [
      { type: 'message', role: 'user', content: 'go' },
      {
        type: 'tool_search_output', execution: 'client', call_id: 'call_ts_0', status: 'completed',
        tools: [
          {
            type: 'namespace',
            name: 'mcp__node_repl',
            tools: [{ type: 'function', name: 'js', description: 'run js', parameters: { type: 'object', properties: {} } }],
          },
        ],
      },
    ],
  });
  assert.equal(status, 200);
  const j = JSON.parse(text);
  const item = j.output.find((i) => i.type === 'function_call');
  assert.ok(item, '非流式也要给出 function_call');
  assert.equal(item.name, 'js');
  assert.equal(item.namespace, 'mcp__node_repl');
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

test('previous_response_id：桥无服务端状态，必须明确 400 且不打上游', async () => {
  await waitReady();
  scenario = { kind: 'text' };
  lastUpstreamBody = null;
  const { status, text } = await post({
    model: 'gpt-5.1-codex',
    stream: false,
    store: true,
    previous_response_id: 'resp_old',
    input: [{ type: 'message', role: 'user', content: 'hello' }],
  });
  assert.equal(status, 400);
  const j = JSON.parse(text);
  assert.equal(j.error.code, 'previous_response_not_found');
  assert.match(j.error.message, /stateless|full input history/i);
  assert.equal(lastUpstreamBody, null, '明确拒绝后不能再打上游（否则会静默丢上下文）');
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
 * 所以只能另起一个。端口随机（但避开临时端口段，见 `bridge-ports.mjs`）、
 * 令牌与假上游都复用主桥那一套；撞端口就换一个重试。
 */
async function startBridge(extraEnv = {}) {
  let lastLog = '';
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const port = pickBridgePort();
    const proc = spawn(process.execPath, [BRIDGE], {
      cwd: dir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        WORKBUDDY_HOST: '127.0.0.1',
        WORKBUDDY_PORT: String(port),
        WORKBUDDY_LOCAL_TOKEN: TOKEN,
        WORKBUDDY_AUTH_FILE: authFile,
        WORKBUDDY_CREDENTIAL_DIR: join(dir, 'credentials'),
        CODEBUDDY_ENDPOINT: `http://127.0.0.1:${UPSTREAM_PORT}`,
        CODEBUDDY_API_KEY: 'stub-key',
        WORKBUDDY_AUTO_CHECKIN: '0',
        WORKBUDDY_LOG: '0',
        // 账本隔离：同上，`cwd: dir` 挡不住（usageFile 按**脚本目录**解析）
        WORKBUDDY_USAGE_FILE: join(dir, 'usage.jsonl'),
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
      if (proc.exitCode !== null) break;
      try {
        const r = await fetch(`${base}/health`, { headers: auth });
        if (r.status === 200 && (await r.json())?.pid === proc.pid) {
          return {
            base,
            kill: () => proc.kill(),
            post: async (payload, extraHeaders = {}) => {
              const rr = await fetch(`${base}/v1/responses`, {
                method: 'POST', headers: { ...auth, ...extraHeaders }, body: JSON.stringify(payload),
              });
              return { status: rr.status, text: await rr.text() };
            },
          };
        }
      } catch { /* 还没起来 */ }
      await new Promise((r) => setTimeout(r, 150));
    }
    lastLog = log;
    proc.kill();
    await new Promise((resolve) => {
      if (proc.exitCode !== null || proc.signalCode) { resolve(); return; }
      proc.once('exit', resolve);
      setTimeout(resolve, 3000);
    });
    if (!isPortInUseError(log)) break;
  }
  throw new Error(`开关桥没起来\n${lastLog.slice(-1500)}`);
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
    /*
     * 只对 Codex / 显式请求 reasoning 的客户端转发。Cherry Studio 的严格
     * 解析器收到 reasoning summary 事件会整轮 abort（#20940），所以即使
     * 开关打开，非 Codex 客户端也必须拿到最小事件集。
     */
    const nonCodex = parseSse((await b.post(payload, { 'user-agent': 'CherryStudio/1.0' })).text);
    assert.equal(nonCodex.some((e) => /reasoning/.test(e.event || '')), false,
      '非 Codex 客户端即使开了开关也不能收到 reasoning 事件');
    assert.ok(nonCodex.some((e) => e.event === 'response.output_text.delta'), '正文仍要正常');
    assert.ok(nonCodex.some((e) => e.event === 'response.completed'), '仍要正常收尾');

    const evs = parseSse((await b.post(payload, { 'user-agent': 'codex_cli_rs/0.59.0' })).text);
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

test('上下文超限：上游真实措辞 "prompt is too long" 也必须认出来（否则白重试 6 次）', async () => {
  await waitReady();
  scenario = { kind: 'ctxlenReal' };
  const { status, text } = await post({
    model: 'gpt-5.1-codex', stream: false,
    input: [{ type: 'message', role: 'user', content: 'hi' }],
  });
  assert.equal(status, 400);
  const j = JSON.parse(text);
  /*
   * 这是 2026-10-13 真实崩溃的原文（`prompt is too long: 1252936 tokens > 1048576 maximum`）。
   * 映射成 `context_length_exceeded` 后，Codex 走 ContextWindowExceeded 分支：
   * 立刻给出「上下文超了」的准确提示，而不是当成可重试错误反复重发。
   * **撤掉正则里的 `too long` 这一支，本用例即红。**
   */
  assert.equal(j.error.code, 'context_length_exceeded',
    '上游原文是 "prompt is too long: N tokens > M maximum"，桥必须认出来');
});

test('工具输出里的图片：必须走视觉通道，不能 JSON.stringify 成纯文本（187 倍 token 差）', async () => {
  await waitReady();
  scenario = { kind: 'text' };
  /*
   * Codex 的截图工具输出长这样（rollout 实测）：
   *   output: [{type:'input_text',text:'Wall time…'}, {type:'input_image',image_url:'data:image/jpeg;base64,…'}]
   *
   * 旧实现 `responsesOutputText` 对没有 `text` 字段的块走 `JSON.stringify(p)`
   * → 整段 base64 变成 `role:"tool"` 消息里的**纯文本**。
   * 实测代价：同一张图，视觉通道 987 tokens，纯文本 184,718 tokens（**187 倍**）。
   * 后果不是"慢"，是**整轮崩掉** —— Codex 按 ~1K 记帐、永不自动压缩，
   * 上游实际收到 125 万 tokens 直接 400。
   */
  const dataUri = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAA==';
  await post({
    model: 'gpt-5.1-codex',
    stream: false,
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'look' }] },
      { type: 'function_call', call_id: 'call_img', name: 'js', arguments: '{}' },
      {
        type: 'function_call_output',
        call_id: 'call_img',
        output: [
          { type: 'input_text', text: 'Wall time: 0.4 seconds' },
          { type: 'input_image', image_url: dataUri },
        ],
      },
    ],
    tools: [{ type: 'function', name: 'js', parameters: { type: 'object', properties: {} } }],
    max_output_tokens: 64,
  });

  const m = lastUpstreamBody;
  assert.ok(m, '上游没收到请求体');
  const toolMsg = m.messages.find((x) => x.role === 'tool');
  assert.ok(toolMsg, '缺 role:"tool" 消息');

  // 关键：content 必须是**数组**且含 image_url 块
  assert.ok(Array.isArray(toolMsg.content),
    `工具输出含图片时必须回内容块数组，实际是 ${typeof toolMsg.content}`
    + '（降级成字符串会让单图从 ~1K 变 18 万 tokens）');
  const img = toolMsg.content.find((p) => p.type === 'image_url');
  assert.ok(img, '图片块丢了：tool 消息的 content 里必须有一个 image_url 块');
  assert.equal(img.image_url.url, dataUri, '图片必须原样透传（data URI 不变形）');
  assert.equal(toolMsg.content.find((p) => p.type === 'text')?.text, 'Wall time: 0.4 seconds',
    '同一条输出里的文本块要保留');

  // 反证：整段 base64 不得出现在任何**字符串** content 里
  const asText = JSON.stringify(toolMsg.content);
  assert.ok(!(typeof toolMsg.content === 'string' && toolMsg.content.includes('base64')),
    'base64 不得被当成纯文本塞进 tool 消息');
  assert.ok(asText.includes(dataUri), '图片数据本身要在（只是换了通道）');
});

test('工具输出里的图片：纯文本输出仍然降级成字符串（不多包一层数组）', async () => {
  await waitReady();
  scenario = { kind: 'text' };
  await post({
    model: 'gpt-5.1-codex',
    stream: false,
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'go' }] },
      { type: 'function_call', call_id: 'call_txt', name: 'js', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_txt', output: [{ type: 'input_text', text: 'plain result' }] },
    ],
    tools: [{ type: 'function', name: 'js', parameters: { type: 'object', properties: {} } }],
    max_output_tokens: 64,
  });
  const m = lastUpstreamBody;
  const toolMsg = m.messages.find((x) => x.role === 'tool');
  assert.equal(toolMsg.content, 'plain result',
    '只有一个文本块时应降成字符串（保持既有形状，避免无谓的数组包装）');
});

test('流中途断开：必须发 response.failed，不能发 completed（否则「说话说一半」被当成功）', async () => {
  await waitReady();
  scenario = { kind: 'midBreak' };
  const { status, text } = await post({
    model: 'gpt-5.1-codex',
    stream: true,
    input: [{ type: 'message', role: 'user', content: 'do the thing' }],
  });
  assert.equal(status, 200, '已经答应过是事件流，只能 200 + SSE');

  const events = parseSse(text);
  const kinds = events.map((e) => e.event);

  /*
   * 核心断言：截断的流**不能**被报成成功。
   * 发 completed 会让 Codex 认为回合正常结束 → 用户看到半句话就停、不报错、不重试。
   */
  assert.ok(!kinds.includes('response.completed'),
    `上游流中途断了，绝不能发 response.completed（会伪装成成功）。实际事件：${kinds.join(', ')}`);
  const failed = events.find((e) => e.event === 'response.failed');
  assert.ok(failed, `缺 response.failed。实际事件：${kinds.join(', ')}`);
  assert.equal(failed.data.response.status, 'failed');
  assert.ok(failed.data.response.error, 'response.failed 必须带 error');
  assert.match(failed.data.response.error.message, /interrupted/i,
    '错误信息要说清是"上游流中途断了"');

  // 已经收到的半截内容仍要带出去（便于排查，但不代表成功）
  assert.match(JSON.stringify(failed.data.response.output), /说到一半/,
    '已收到的半截内容应保留在 output 里');
});

test('干净半关：同样必须发 response.failed（不能只认"被掐断"）', async () => {
  /*
   * 与上一条的区别：上游是**正常 end()**，只是没给 finish_reason / [DONE]。
   * 旧实现只在 catch 里设 streamError，这条会一路发 response.completed。
   */
  await waitReady();
  scenario = { kind: 'halfClose' };
  const { status, text } = await post({
    model: 'gpt-5.1-codex',
    stream: true,
    input: [{ type: 'message', role: 'user', content: 'do the thing' }],
  });
  assert.equal(status, 200);
  const events = parseSse(text);
  const kinds = events.map((e) => e.event);
  assert.ok(!kinds.includes('response.completed'),
    `干净半关绝不能发 response.completed。实际事件：${kinds.join(', ')}`);
  const failed = events.find((e) => e.event === 'response.failed');
  assert.ok(failed, `缺 response.failed。实际事件：${kinds.join(', ')}`);
  assert.match(String(failed.data?.response?.error?.message), /before completion|interrupted/i);
  assert.match(JSON.stringify(failed.data.response.output), /说到一半/);
});

/*
 * ── Responses 层的两条回归（2026-10-15 实测暴露）────────────────────────
 *
 * ① **多段 developer 消息不能被丢掉**。
 *    `responsesPartsToOpenAI` 对多段内容返回**数组**，而 system 分支原先只认
 *    字符串（`typeof content === 'string' ? content : ''`）—— 数组一律变空串。
 *    Codex Desktop 的 system prompt 正是**一个 developer 项挂 5 个 part**
 *    （app-context / skills / permissions / collaboration_mode / plugins，
 *    实测 24,273 字符、约占 system 的 65%）。丢掉之后走兜底，模型拿到的是
 *    一句 `"You are a helpful assistant."`：agent 人设、技能清单、沙箱与权限
 *    规则全没了。实测 5 个 part 到达 0 个。
 */
test('多段 developer 消息必须全部转成 system 文本（否则 Codex 的 system prompt 被换成通用兜底）', async () => {
  await waitReady();
  scenario = { kind: 'text' };
  const parts = [
    'APP_CONTEXT: you are Codex',
    'SKILLS_INSTRUCTIONS: skills below',
    'PERMISSIONS: sandbox=workspace-write',
    'COLLABORATION_MODE: default',
    'PLUGINS_INSTRUCTIONS: plugins available',
  ];
  await post({
    model: 'gpt-5.1-codex',
    stream: false,
    input: [
      { type: 'message', role: 'developer', content: parts.map((text) => ({ type: 'input_text', text })) },
      { type: 'message', role: 'user', content: 'go' },
    ],
    max_output_tokens: 64,
  });

  const sys = lastUpstreamBody.messages.find((m) => m.role === 'system');
  assert.ok(sys, '必须有 system 消息');
  assert.equal(typeof sys.content, 'string', 'system 内容应当是文本（多段要拍平）');
  for (const p of parts) {
    assert.ok(sys.content.includes(p),
      `developer 的 part 被丢了：「${p}」\n实际 system 内容：${JSON.stringify(sys.content)}`);
  }
  assert.notEqual(sys.content, 'You are a helpful assistant.',
    '整个 system 退化成兜底问候语 —— Codex 的人设/技能/权限规则全部丢失');
});

test('多段 developer 与 instructions 共存时两者都要保留', async () => {
  await waitReady();
  scenario = { kind: 'text' };
  await post({
    model: 'gpt-5.1-codex',
    stream: false,
    instructions: 'FROM-INSTRUCTIONS',
    input: [
      { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'P1' }, { type: 'input_text', text: 'P2' }] },
      { type: 'message', role: 'user', content: 'go' },
    ],
    max_output_tokens: 64,
  });
  const sys = lastUpstreamBody.messages.find((m) => m.role === 'system');
  assert.match(sys.content, /FROM-INSTRUCTIONS/, 'instructions 要保留');
  assert.match(sys.content, /P1/, 'developer 的第一个 part 要保留');
  assert.match(sys.content, /P2/, 'developer 的第二个 part 要保留');
});

/*
 * ② **已收尾的工具 item 不得再收 delta**。
 *
 * 文本块一开就把当时的工具块强制收尾（`output_item.done` 已发给客户端），
 * 而 Responses 的 item 是按顺序递增、互不重叠的 output_index 解析的 ——
 * 迟到分片不能往那个已完成的 item 上拼。
 *
 * ⚠️ 断言必须盯**事件序列**，不能盯 `output_item.done` 里的快照：
 * 那个事件在迟到分片**之前**就发出去了，有没有守卫拿到的都是同一份（正确的）
 * 快照 —— 第一版用例就是这么写的，结果恒真（反向验证时才发现）。
 * 真正的差异是：没有守卫时，`output_item.done` **之后**还会冒出一个
 * `response.function_call_arguments.delta`（实测无守卫 1 个、有守卫 0 个），
 * 也就是"已完成的 item 还在收参数" —— Codex 的解析器要判流损坏的形状。
 */
test('工具被文本打断后的迟到参数分片：不得在 output_item.done 之后继续发 delta', async () => {
  await waitReady();
  scenario = { kind: 'lateToolArgs' };
  const { status, text } = await post({
    model: 'gpt-5.1-codex', stream: true,
    input: [{ type: 'message', role: 'user', content: 'go' }],
  });
  assert.equal(status, 200);
  const events = parseSse(text);

  // 核心断言：任何 item 的 done 之后，都不能再有属于它的 arguments delta
  const doneAt = new Map();
  const strays = [];
  events.forEach((e, i) => {
    if (e.event === 'response.output_item.done' && e.data.item?.id) doneAt.set(e.data.item.id, i);
    if (e.event === 'response.function_call_arguments.delta' && doneAt.has(e.data.item_id)
      && doneAt.get(e.data.item_id) < i) {
      strays.push(e.data.item_id);
    }
  });
  assert.deepEqual(strays, [],
    `有 ${strays.length} 个 arguments delta 落在该 item 的 output_item.done 之后 —— `
    + 'Codex 会判流损坏（已完成 item 不该再收参数）');

  // 顺带：交付的 arguments 仍要完整合法
  const toolItems = events
    .filter((e) => e.event === 'response.output_item.done' && e.data.item?.type === 'function_call')
    .map((e) => e.data.item);
  assert.equal(toolItems.length, 1, `应当只有一次工具调用，实际 ${toolItems.length}`);
  assert.doesNotThrow(() => JSON.parse(toolItems[0].arguments),
    `交付的 arguments 不是合法 JSON（${JSON.stringify(toolItems[0].arguments)}）`);
  assert.equal(JSON.parse(toolItems[0].arguments).cmd, 'ls');
});

test('工具被文本收尾后换 index 的新调用：必须照常成为独立 item（不能连它一起丢）', async () => {
  await waitReady();
  scenario = { kind: 'newIndexAfterText' };
  const { status, text } = await post({
    model: 'gpt-5.1-codex', stream: true,
    input: [{ type: 'message', role: 'user', content: 'go' }],
  });
  assert.equal(status, 200);
  const events = parseSse(text);
  const names = events
    .filter((e) => e.event === 'response.output_item.done' && e.data.item?.type === 'function_call')
    .map((e) => e.data.item.name);
  assert.deepEqual(names, ['first_tool', 'second_tool'],
    `换 index 的新工具调用丢了。实际交付：${JSON.stringify(names)}`);
  // output_index 必须互不重复且递增（Codex 按它拼 item）
  const idxs = events
    .filter((e) => e.event === 'response.output_item.done')
    .map((e) => e.data.output_index);
  assert.equal(new Set(idxs).size, idxs.length, `output_index 重复：${JSON.stringify(idxs)}`);
});

test('尾帧没有换行也必须被解析（usage / finish 不能丢）', async () => {
  await waitReady();
  scenario = { kind: 'noTrailingNewline' };
  const { status, text } = await post({
    model: 'gpt-5.1-codex', stream: true,
    input: [{ type: 'message', role: 'user', content: 'finish without newline' }],
  });
  assert.equal(status, 200);
  const events = parseSse(text);
  const completed = events.find((e) => e.event === 'response.completed');
  assert.ok(completed, `无换行尾帧被当成半关/失败。实际事件：${events.map((e) => e.event).join(', ')}`);
  assert.ok(!events.some((e) => e.event === 'response.failed'), '完成流不能报 failed');
  const u = completed.data.response.usage;
  assert.equal(u.input_tokens, 7, '尾帧里的 usage 不能丢');
  assert.equal(u.output_tokens, 3);
});

test('并行工具调用交错下发：item 必须按序且互不重叠，参数不丢', async () => {
  await waitReady();
  scenario = { kind: 'parallelToolCalls' };
  const { status, text } = await post({
    model: 'gpt-5.1-codex', stream: true,
    input: [{ type: 'message', role: 'user', content: 'run both' }],
  });
  assert.equal(status, 200);
  const events = parseSse(text);
  const added = events
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => e.event === 'response.output_item.added' && e.data.item?.type === 'function_call')
    .map(({ e, i }) => ({ name: e.data.item.name, at: i, id: e.data.item.id }));
  const done = events
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => e.event === 'response.output_item.done' && e.data.item?.type === 'function_call')
    .map(({ e, i }) => ({ name: e.data.item.name, at: i, id: e.data.item.id, args: e.data.item.arguments }));
  assert.deepEqual(added.map((x) => x.name), ['first_tool', 'second_tool'], '两个调用都必须交付');
  assert.deepEqual(done.map((x) => x.name), ['first_tool', 'second_tool'], 'done 顺序必须与创建顺序一致');

  // 每个 item 的 added 早于自己的 done；B 的 added 必须晚于 A 的 done
  assert.ok(added[0].at < done[0].at, 'first_tool 的 added 必须先于 done');
  assert.ok(done[0].at < added[1].at,
    'second_tool 在 first_tool 收尾前被 announce —— Codex 会看到两个同时打开的 item');
  assert.ok(added[1].at < done[1].at, 'second_tool 的 added 必须先于 done');

  assert.deepEqual(JSON.parse(done[0].args), { a: 1 }, '并行交错时 first_tool 的尾片不能丢');
  assert.deepEqual(JSON.parse(done[1].args), { b: 2 });
  const idxs = events
    .filter((e) => e.event === 'response.output_item.done')
    .map((e) => e.data.output_index);
  assert.equal(new Set(idxs).size, idxs.length, `output_index 重复：${JSON.stringify(idxs)}`);
});

/*
 * ③ **`output_item.added` 必须先于该 item 的任何参数事件**（桥自己文档化的
 *    Codex 硬约束：Codex 要求有 active item 才接受 `*.delta`）。
 *
 *    模型调了 `tool_search`、而当前请求**没有声明**它时，`closeTool` 的
 *    `routes?.toolSearch` 判据为假 → 落到普通 `function_call` 分支 → 会发
 *    `function_call_arguments.done` + `output_item.done`。而 `flushTool` 原先
 *    **无条件**为 `tool_search` 跳过 `output_item.added`，于是这些事件属于一个
 *    从未 announced 过的 item。修法：两处判据必须一致。
 */
test('未声明的 tool_search 被调用：不得发出没有 added 的孤立 item 事件', async () => {
  await waitReady();
  scenario = { kind: 'undeclaredToolSearch' };
  const { status, text } = await post({
    model: 'gpt-5.1-codex',
    stream: true,
    // 故意**不声明** tool_search
    tools: [{ type: 'function', name: 'exec_command', parameters: { type: 'object', properties: {} } }],
    input: [{ type: 'message', role: 'user', content: 'find tools' }],
  });
  assert.equal(status, 200);
  const events = parseSse(text);

  const addedIds = new Set(events
    .filter((e) => e.event === 'response.output_item.added' && e.data.item?.id)
    .map((e) => e.data.item.id));
  const orphanArgs = events.filter((e) => e.event === 'response.function_call_arguments.delta'
    || e.event === 'response.function_call_arguments.done')
    .filter((e) => !addedIds.has(e.data.item_id));
  const orphanDone = events
    .filter((e) => e.event === 'response.output_item.done' && e.data.item?.id)
    .filter((e) => !addedIds.has(e.data.item.id));

  assert.deepEqual(orphanArgs.map((e) => e.event), [],
    '有参数事件属于一个从未 output_item.added 过的 item —— Codex 要求先有 active item');
  assert.deepEqual(orphanDone.map((e) => e.data.item.id), [],
    '有 output_item.done 属于一个从未 output_item.added 过的 item');
});

test('被丢掉的工具必须在请求日志里可见（否则「模型有个工具用不了」永远查不出来）', async () => {
  await waitReady();
  scenario = { kind: 'text' };
  const mark = bridgeLog.length;   // 只看本用例之后的日志
  await post({
    model: 'gpt-5.1-codex',
    stream: false,
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
    tools: [
      // 桥**能**转发这三类 —— 都不该出现在 dropped 里
      { type: 'function', name: 'exec_command', parameters: { type: 'object', properties: {} } },
      { type: 'custom', name: 'apply_patch', description: 'patch' },
      { type: 'tool_search' },
      // 桥**不能**转发 —— 必须出现在 dropped 里
      { type: 'web_search' },
    ],
    max_output_tokens: 64,
  });

  const logs = bridgeLog.slice(mark);
  const line = logs.split('\n').filter((l) => l.includes('[responses]') && l.includes('dropped=')).pop();
  assert.ok(line, `请求日志里没有 dropped= 字段。本用例日志：\n${logs.slice(-800)}`);
  assert.match(line, /dropped=web_search/, 'web_search 被丢掉了，必须在日志里点名');
  /*
   * 反向断言（这条是踩过的坑）：`apply_patch` 是 `custom` 类型，桥**能**转发它
   * （同一行还会有 `freeform=apply_patch`）。第一版实现漏了这个排除，
   * 日志打出 `dropped=apply_patch,web_search` —— 自相矛盾、会误导排查。
   */
  assert.ok(!/dropped=\S*apply_patch/.test(line),
    `apply_patch 是能转发的 custom 工具，不该出现在 dropped 里：${line}`);
  assert.ok(!/dropped=\S*tool_search/.test(line),
    `tool_search 是能转发的，不该出现在 dropped 里：${line}`);
  assert.ok(!/dropped=\S*exec_command/.test(line),
    `exec_command 是普通 function，不该出现在 dropped 里：${line}`);
  assert.match(line, /freeform=apply_patch/, '同一行应能看到 apply_patch 确实被转发了');
});

test('11128：Responses 路径也要渐进兜底，成功时回 fallback 头', async () => {
  await waitReady();
  scenario = { kind: '11128thenText' };
  const { status, headers } = await post({
    model: 'gpt-5.1-codex',
    stream: false,
    input: [
      {
        type: 'message',
        role: 'developer',
        content: `First paragraph identity.

Second paragraph instructions.`,
      },
      { type: 'message', role: 'user', content: 'hi' },
    ],
  });
  assert.equal(status, 200, '第一次 11128 后应降级 system 并成功');
  assert.equal(scenario.calls, 2, '应只多打一次上游');
  assert.equal(headers.get('x-workbuddy-11128-fallback'), 'drop-first-system-paragraph');
  assert.ok(lastUpstreamBody.messages.some((m) => m.role === 'system' && m.content.includes('Second paragraph instructions')),
    '第二条请求应保留首段之后的 system instructions');
});

test('上游 401：Responses 非流式回 502 + upstream_auth_error，并提示重登 WorkBuddy', async () => {
  await waitReady();
  scenario = { kind: 'error' };
  const { status, text } = await post({
    model: 'gpt-5.1-codex',
    stream: false,
    input: [{ type: 'message', role: 'user', content: 'hi' }],
  });
  assert.equal(status, 502, '上游登录过期不能原样回 401');
  const j = JSON.parse(text);
  assert.equal(j.error.code, 'upstream_auth_error');
  assert.match(j.error.message, /upstream login expired/i);
  assert.match(j.error.message, /upstream says no/, '上游原始 msg 仍应保留用于排查');
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
