// SPDX-License-Identifier: MIT
/**
 * workbuddy-bridge — expose the locally signed-in CodeBuddy / WorkBuddy desktop
 * session as a local OpenAI-compatible endpoint, for any client that accepts a
 * custom base URL (DeepSeek Harness, Cherry Studio, Open WebUI, ...).
 *
 * How it works (all behaviours verified against the live backend):
 *   - The upstream backend (copilot.tencent.com/v2/chat/completions) already
 *     speaks the OpenAI protocol, so this proxy does NOT translate protocols.
 *     It only injects authentication/tracing headers and guarantees streaming.
 *   - The backend rejects non-streaming requests (400 code 11101), so a
 *     non-streaming client request is converted to streaming upstream and
 *     aggregated back into a single JSON response.
 *   - Auth reuses the desktop session (OAuth access/refresh token) from the
 *     local login file, refreshing it in memory before expiry. The login file
 *     is never rewritten: it holds app-owned at-rest envelopes.
 *   - Compatibility fix: the backend only accepts the `system` role for the
 *     system prompt, while newer OpenAI-spec clients send `developer`. Those
 *     messages are rewritten in place before forwarding.
 *
 * Security boundary: binds 127.0.0.1 only; never logs or persists a token or
 * any conversation content.
 */
import {
  readFileSync, writeFileSync, appendFileSync, existsSync, readdirSync, statSync, renameSync,
  mkdirSync, chmodSync, unlinkSync, openSync, closeSync, copyFileSync,
} from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Agent as HttpAgent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import { join, dirname, isAbsolute } from 'node:path';
import { homedir, userInfo, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { spawn } from 'node:child_process';
import { waitDrain } from './wait-drain.mjs';
import { applyPromotion, groupPromotions } from './promotions.mjs';
import { submitVideo, queryVideo, MioraVideoError, MAX_VIDEO_WAIT_MS } from './miora-video.mjs';
import { submitImage, queryImage } from './miora-image.mjs';
import { configureSubmissionStore, publicHttpsUrl } from './miora-media-core.mjs';

/**
 * 本桥源码的构建指纹。
 *
 * 为什么需要它：桥是**常驻后台进程**，升级插件/控制台只会换磁盘上的脚本，
 * 已经在跑的那一个仍然是旧代码。v1.9.6 就踩到了这个坑 —— 插件已经升级，
 * 但旧桥继续服务，于是目录/思考档位/换号逻辑全是旧的，而面板里看不出原因。
 *
 * 指纹取脚本内容（不是 mtime：拷贝/安装会改 mtime，内容却没变；反过来
 * 内容变了 mtime 也可能被保留）。`/health.build` 暴露它，启动方拿本地脚本
 * 算出期望值，不一致就自动重启桥。
 */
const BRIDGE_SELF_PATH = fileURLToPath(import.meta.url);
const BRIDGE_BUILD = (() => {
  try {
    return createHash('sha256').update(readFileSync(BRIDGE_SELF_PATH)).digest('hex').slice(0, 16);
  } catch {
    return '';
  }
})();

// ── Static constants (values match the desktop app / official extension) ──
/**
 * 出站客户端身份。上游按 User-Agent / X-IDE-* / X-Product-Version 校验调用
 * 来源，官方客户端升级后旧指纹可能被拒（报告 §8.6 风险 1 的「上游版本漂移」）。
 * 因此三个值都可用环境变量覆盖（.env 由 config.mjs 统一注入），改完重启桥即生效。
 */
/**
 * 数值型环境变量解析：非法值回退默认，**绝不产生 NaN**。
 *
 * 与 `config.mjs` 的 `numEnv()` 同款逻辑（桥刻意保持单文件自包含，
 * 不能 import 那个模块，所以这里是内联副本 —— 改动时两处要一起改）。
 *
 * 为什么必须有：`Number(process.env.WORKBUDDY_PORT || 8790)` 在用户把
 * `.env` 写成 `WORKBUDDY_PORT=879O`（字母 O）时得到 `NaN`，`listen(NaN)` 直接抛
 * `RangeError [ERR_SOCKET_BAD_PORT]` —— 桥**整个起不来**，而报错信息里
 * 完全看不出是自己配置写错了。实测确认过这条路径。
 *
 * 另一条更隐蔽的后果：`MAX_BODY_BYTES = NaN` 会让 `size > NaN` 恒为 `false`，
 * 请求体上限**静默消失**（无界内存）。
 *
 * @param {string} name
 * @param {number} fallback
 * @param {{ min?: number, max?: number, integer?: boolean }} [range] 越界同样回退（不截断到边界）
 */
function numEnv(name, fallback, range = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  if (value < (range.min ?? -Infinity) || value > (range.max ?? Infinity)) return fallback;
  return range.integer ? Math.trunc(value) : value;
}

/**
 * 合并取消信号。`AbortSignal.any` 是 Node 20.3 才有的 API，而包声明的是
 * Node >=18；在旧运行时上用等价的监听实现，避免搜索/聊天在 Node 18 直接抛错。
 */
function combineAbortSignals(signals) {
  const list = signals.filter((signal) => signal instanceof AbortSignal);
  if (list.length === 0) return undefined;
  if (list.length === 1) return list[0];
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(list);

  const controller = new AbortController();
  let cleanup = () => {};
  const onAbort = (event) => {
    cleanup();
    controller.abort(event.target.reason);
  };
  cleanup = () => {
    for (const signal of list) signal.removeEventListener('abort', onAbort);
  };
  for (const signal of list) {
    if (signal.aborted) {
      cleanup();
      controller.abort(signal.reason);
      return controller.signal;
    }
    signal.addEventListener('abort', onAbort, { once: true });
  }
  return controller.signal;
}

const APP_VERSION = process.env.WORKBUDDY_APP_VERSION || '4.9.29177644';
const IDE_VERSION = process.env.WORKBUDDY_IDE_VERSION || '1.119.0';
const IDE_NAME = process.env.WORKBUDDY_IDE_NAME || 'VSCode';
const CHAT_PATH = '/v2/chat/completions';
/**
 * WorkBuddy 的独立网页搜索端点（WorkBuddy 客户端 WebSearch 工具在用）。
 *
 * 它不是 chat/completions 的一部分：客户端用当前登录 token 直接 POST，
 * 返回结构化 results。这里把它接进桥，供 dsh 的 web-search provider 使用，
 * 从而不消耗 DeepSeek 钱包。
 */
const SEARCH_PATH = '/agenttool/v1/search';
const SEARCH_BASE_OVERRIDE = String(process.env.WORKBUDDY_SEARCH_BASE || '').replace(/\/+$/, '');
const VIDEO_BASE_OVERRIDE = String(process.env.WORKBUDDY_MIORA_BASE || '').trim().replace(/\/+$/, '');
const SEARCH_VERSION_OVERRIDE = String(process.env.WORKBUDDY_SEARCH_VERSION || '').trim();
const SEARCH_TIMEOUT_MS = numEnv('WORKBUDDY_SEARCH_TIMEOUT_MS', 20_000, { min: 1000 });
const SEARCH_DEFAULT_MAX_RESULTS = numEnv('WORKBUDDY_SEARCH_MAX_RESULTS', 8, { min: 1, max: 10, integer: true });
const SEARCH_MAX_RESULTS = 10;
const SEARCH_FRESHNESS_RE = /^(?:d(?:[1-9]|[12]\d|30)?|m(?:[1-9]|1[0-2])?|y[1-5]?)$/;
const REFRESH_SKEW_MS = 5 * 60 * 1000;
const REFRESH_COOLDOWN_MS = 15 * 1000;
/**
 * 非确定性 400（code 11133）的退避表（毫秒）。
 *
 * `WORKBUDDY_TRANSIENT_400_DELAYS` 可覆盖（逗号分隔），空值 = 用默认。
 * 留这个旋钮是为了**能测**：默认表跑满要 40 秒，验收用例不可能真等
 * 40 秒去证明"瞬时 400 仍然会重试"，所以用例把它压到毫秒级。
 * 生产上没有人需要改它，文档也不宣传 —— 它纯粹是可测性接口。
 */
const TRANSIENT_400_DELAYS = (() => {
  const raw = String(process.env.WORKBUDDY_TRANSIENT_400_DELAYS ?? '').trim();
  if (!raw) return [1000, 4000, 10000, 25000];
  const parsed = raw.split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n >= 0);
  return parsed.length ? parsed : [1000, 4000, 10000, 25000];
})();

/**
 * 上游 400 里**确定性拒绝**的识别表 —— 命中即**不重试**，立刻把错误交给客户端。
 *
 * ## 为什么必须有这张表（2026-10-13 实测）
 *
 * 桥原先对**所有** `400 code 11133` 一视同仁地退避重试
 * （`TRANSIENT_400_DELAYS` = 1s+4s+10s+25s = 40 秒）。但 11133 只是一个
 * **包装码**，真正的原因在 `extError.code` 里，其中多数是**确定性**的：
 *
 *   · `model_param_invalid` —— 文案「the request parameters were rejected by the
 *     model provider」。参数被模型提供方拒了，**同样的参数原样重发一万次也不会变**。
 *   · `invalid_reasoning_effort` —— 该模型不接受这个思考档位，同上。
 *
 * 日志取证（`bridge/bridge.log`，2026-10-12）：
 *   · 467 条 `transient 400 (11133), retry N`，聚成 117 簇；
 *   · 其中 **109 簇跑满 4 档退避**，最后**仍然**落 `upstream error 400`；
 *   · `extError.code` 分布：`model_param_invalid` 116 次、`invalid_reasoning_effort` 6 次
 *     —— **122 次全是确定性拒绝**，没有一次是真正的瞬时故障；
 *   · 纯等待累计 **2460 秒**（41 分钟），平均每簇白等 **37.3 秒**。
 *
 * 用户直接感知就是「问一句，卡 40 秒，然后报错」——这正是要修的东西。
 *
 * ## 判据为什么用 extError.code 而不是文案匹配
 *
 * 文案是上游的展示文本，会随语言/版本变（实测响应里同时有 en/zh/zh-hant 三份）。
 * `extError.code` 是**协议层枚举**，稳定得多。所以：
 *   1. 优先看 `extError.code` / `extError.type` 是否命中表；
 *   2. 兜底看 `displayMsg` / `msg` 里的明确措辞（应对上游漏填 extError 的情况）；
 *   3. **两者都没有 → 视为瞬时**，照旧重试（保守：不认识的不擅自放弃）。
 *
 * 环境变量 `WORKBUDDY_TRANSIENT_400_RETRY=0` 可完全关闭这套 400 重试（走「快速失败」）。
 */
const DETERMINISTIC_400_CODES = new Set([
  'model_param_invalid',
  'invalid_reasoning_effort',
  'invalid_request_error',
  'model_not_found',
  'model_unavailable',
  'context_length_exceeded',
  'content_filter',
  'insufficient_quota',
]);

/**
 * 上游 400 的**确定性**判定。返回拒绝理由字符串（用于日志）或 null（= 可重试）。
 *
 * 判据顺序刻意如此：协议码优先（稳定），文案兜底（覆盖上游漏填），
 * 都不命中就放行去重试 —— 宁可多等，也不要误杀一个本来能救回的请求。
 *
 * @param {string} text 上游 400 响应体原文
 * @returns {string|null}
 */
function deterministic400Reason(text) {
  let body;
  try { body = JSON.parse(text); } catch { return null; } // 非 JSON：无法判定，按瞬时处理
  if (!body || typeof body !== 'object') return null;

  const ext = body.extError || body.ext_error || {};
  const extCode = String(ext.code || '').trim();
  if (extCode && DETERMINISTIC_400_CODES.has(extCode)) return `extError.code=${extCode}`;

  const extType = String(ext.type || '').trim();
  if (extType === 'invalid_request_error') return `extError.type=${extType}`;

  // 兜底：上游偶尔只给文案不给 extError。只认**明确表达"参数被拒"**的措辞，
  // 不认 "please retry"（那句恰恰说明是瞬时的）。
  const hay = [
    body.msg, body.message,
    body.displayMsg?.en, body.displayMsg?.zh,
    ext.message,
  ].filter((s) => typeof s === 'string').join(' ');
  if (/rejected by the model provider|parameters were rejected/i.test(hay)) return 'message: parameters rejected by provider';
  if (/invalid_reasoning_effort|reasoning effort/i.test(hay) && /invalid|not support|unsupported/i.test(hay)) return 'message: invalid reasoning effort';
  return null;
}

/**
 * `WORKBUDDY_TRANSIENT_400_RETRY=0` → 完全不重试 400（快速失败）。
 * 默认开：非确定性 400 仍按 TRANSIENT_400_DELAYS 退避，确定性 400 一律不重试。
 */
const TRANSIENT_400_RETRY_ENABLED = process.env.WORKBUDDY_TRANSIENT_400_RETRY !== '0';

/**
 * 上游 11128（通道模板校验）兜底。
 *
 * 已知模板句已在 `rewriteAuditTemplate` 里做最小改写；这里防的是**上游再新增
 * 一条 system 黑名单**。命中 11128 时按“删品牌行 → 删第一条 system 首段
 * （保留 skills/workspace/规则）→ 整段中性 system”渐进降级；用户消息、
 * 工具定义/结果与 tools 都不动。成功时回 `X-WorkBuddy-11128-Fallback` 头并
 * 记入账本。默认开；设 `WORKBUDDY_11128_FALLBACK=0` 可关闭。
 */
const CHANNEL_FALLBACK_ENABLED = process.env.WORKBUDDY_11128_FALLBACK !== '0';
const CHANNEL_FALLBACK_HEADER = 'X-WorkBuddy-11128-Fallback';
const NEUTRAL_SYSTEM = 'You are a helpful AI assistant.';
/**
 * assistant 历史也做**精确身份模板**中和（默认开）。
 *
 * 同类项目已实测（hub #574）：assistant 历史里只要出现
 * `You are an AI agent powered by DeepSeek Harness.`，之后每一轮都会 11128；
 * 换 key/换账号都没用，新会话才正常。这里只替换两句精确模板，不碰普通正文，
 * 避免把用户在界面上看到的回答语义改掉。设置 `WORKBUDDY_SANITIZE_ASSISTANT_HISTORY=0`
 * 可关闭，便于真机 A/B。
 */
const SANITIZE_ASSISTANT_HISTORY = process.env.WORKBUDDY_SANITIZE_ASSISTANT_HISTORY !== '0';

/** 上游函数名规则。与 OpenAI/Anthropic/Codex 实际接受的字符集一致。 */
const TOOL_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * 11128 的渐进降级候选。
 *
 * 顺序刻意从“只动最小范围”到“牺牲 system”：
 *   1. 删除 system 里含宿主品牌的整行（保留其余 instructions）；
 *   2. 删除第一条 system 的首段（identity/persona 通常在第一段），保留后面的
 *      skills/workspace/安全规则；
 *   3. 删除 assistant 历史里含宿主品牌的整行（hub #574：assistant 历史也会
 *      被同一套指纹校验，且一处命中会让整条会话之后每轮都挂）；
 *   4. 整段换成中性 system（最后手段）。
 *
 * user / tool / tools 永远不动。返回**去重后的候选列表**；调用方只在仍收到
 * 11128 时才继续试下一个。
 */
function channelFallbackCandidates(payload) {
  if (!CHANNEL_FALLBACK_ENABLED) return [];
  const messages = Array.isArray(payload?.messages) ? payload.messages : [];
  const isSystem = (m) => m && (m.role === 'system' || m.role === 'System');
  if (!messages.some(isSystem)) return [];

  const out = [];
  const seen = new Set();
  const push = (strategy, nextMessages) => {
    const key = JSON.stringify(nextMessages);
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ strategy, payload: { ...payload, messages: nextMessages } });
  };

  // 1) 只删品牌行，其余 system 原样保留。
  let changed = false;
  const trimmed = messages.map((m) => {
    if (!isSystem(m) || typeof m.content !== 'string') return m;
    const next = m.content
      .split(/\r?\n/)
      .filter((line) => !/deepseek\s+harness/i.test(line))
      .join('\n')
      .trim();
    if (next !== m.content) changed = true;
    return { ...m, content: next };
  }).filter((m) => !(isSystem(m) && !m.content));
  if (changed && trimmed.some(isSystem)) push('remove-brand-lines', trimmed);

  // 2) 只删第一条 system 的首段；后面的段落（skills/workspace/规则）保留。
  let dropped = false;
  let firstSystemSeen = false;
  const droppedMessages = messages.map((m) => {
    if (!isSystem(m) || typeof m.content !== 'string' || firstSystemSeen) return m;
    firstSystemSeen = true;
    const parts = m.content.split(/\r?\n\s*\r?\n/);
    if (parts.length < 2) return m;
    const next = parts.slice(1).join('\n\n').trim();
    if (!next) return m;
    dropped = true;
    return { ...m, content: next };
  }).filter((m) => !(isSystem(m) && !m.content));
  if (dropped && droppedMessages.some(isSystem)) push('drop-first-system-paragraph', droppedMessages);

  // 3) assistant 历史里的品牌行：assistant 正文只删含品牌词的整行，其余保留。
  //    带 tool_calls 的 assistant 即使 content 被删空也要留下，否则工具配对会断。
  let assistantChanged = false;
  const assistantTrimmed = messages.map((m) => {
    if (!m || m.role !== 'assistant' || typeof m.content !== 'string') return m;
    const next = m.content
      .split(/\r?\n/)
      .filter((line) => !/deepseek\s+harness/i.test(line))
      .join('\n')
      .trim();
    if (next !== m.content) {
      assistantChanged = true;
      return { ...m, content: next };
    }
    return m;
  }).filter((m) => !(m && m.role === 'assistant' && !m.content
    && !(Array.isArray(m.tool_calls) && m.tool_calls.length)));
  if (assistantChanged) push('remove-brand-lines-assistant', assistantTrimmed);

  // 4) 最后手段：整段中性 system，保住这次调用。
  push('neutral-system', [
    { role: 'system', content: NEUTRAL_SYSTEM },
    ...messages.filter((m) => !isSystem(m)),
  ]);
  return out;
}

/**
 * 传输层（DNS / 建连）瞬时失败后、重试前的等待（毫秒）。默认 250ms。
 *
 * 只在失败路径上花这个时间；成功请求完全不受影响。`WORKBUDDY_TRANSPORT_RETRY_MS`
 * 可覆盖（0 = 立刻重试），验收用例靠它把等待压到 0 以免拖慢测试。
 */
const TRANSPORT_RETRY_DELAY_MS = numEnv('WORKBUDDY_TRANSPORT_RETRY_MS', 250, { min: 0 });

/**
 * 上游 5xx 的桥侧重试（默认：500/502/503/504 各重试 1 次，间隔 500ms）。
 *
 * ## 为什么加（2026-10-15 真实故障）
 *
 * DeepSeek 官方 V4.1 Flash / V4 Pro 当天 08:11 起出现部分中断，上游回 5xx。
 * 用户当天 23 次失败里，多数在 1 秒后**原样重发就成功**；而桥当时对 5xx
 * 直接读体返回，客户端只看到失败 —— 明明一次重试就能救回整轮对话。
 *
 * ## 边界
 *
 *   · 只重试 `500 / 502 / 503 / 504`。501（未实现）、505 等重发也不会变，
 *     不在表里 —— 不认识的状态码不做无根据的重试。
 *   · 只在**响应体还没交给调用方**时重试：调用方拿到 `res` 后就不会再动它，
 *     不存在“流已经发了一半再重发”的问题。
 *   · `WORKBUDDY_5XX_RETRY=0` 关闭；退避时间用
 *     `WORKBUDDY_5XX_RETRY_DELAY_MS` 覆盖（测试把它压到毫秒级）。
 *   · 重试是**原样重发**（同一份 body / 同一组请求头），不会重新组装请求。
 */
const UPSTREAM_5XX_RETRIES = numEnv('WORKBUDDY_5XX_RETRY', 1, { min: 0, max: 5, integer: true });
const UPSTREAM_5XX_RETRY_DELAY_MS = numEnv('WORKBUDDY_5XX_RETRY_DELAY_MS', 500, { min: 0 });
const UPSTREAM_5XX_RETRY_STATUSES = new Set([500, 502, 503, 504]);

/**
 * 上游 429（code 14003 "too many requests"）的**桥侧等待计划**（毫秒）。
 *
 * ⚠️ **默认关闭**（2026-10-13 16:5x 改）：默认 20s/45s/60s 上线后实测，上游拥塞时段
 * 等了也多半还是 429（等待 20s → 依旧 429），白白把每条请求拖慢 20-65s —— 用户
 * 直接感知为"反应好慢"。速度优先：默认快速返回，把重试交给客户端（Codex 自己
 * 会退避重试）；想要"桥替你等"的人显式配置，如 `WORKBUDDY_429_WAITS=30000,60000`。
 *
 * 若上游带了 retry-after，取它与计划里较小者；单次等待上限 90s。
 */
const UPSTREAM_429_WAITS = String(process.env.WORKBUDDY_429_WAITS ?? '')
  .split(',')
  /*
   * ⚠️ 先**按字符串**过滤空项，再转数字。
   *
   * 原先直接 `.map(Number).filter(n => n >= 0)`：未设置时
   * `''.split(',')` = `['']` → `Number('')` = **0** → `0 >= 0` 通过 ⇒ 计划变成
   * `[0]`。于是"默认关闭"（注释写得很清楚）实际是**每个 429 都立刻原样重发一次**：
   * 对拥塞中的上游做零退避重试，是最差的反应（只会加重拥塞），还多烧一次请求。
   * 实测：未设置 / 空串都得到 `[0]`；日志里 148 条 `bridge waits` 有 133 条是
   * `waits 0s … (1/1)` —— 这就是它的现场。
   */
  .map((s) => s.trim())
  .filter((s) => s !== '')
  .map(Number)
  .filter((n) => Number.isFinite(n) && n >= 0);

/**
 * 上游 429 里带的"过多久再试"提示（`retry-after` 头或 body 里的 `retry_after*` 字段）；没有则 null。
 *
 * ⚠️ `res` 是 `shimResponse` 的产物，它的 `headers` 就是 Node
 * `IncomingMessage.headers` —— 一个**普通对象，没有 `.get()`**。
 * 原先写的是 `res?.headers?.get?.('retry-after')`，可选链把"没有这个方法"
 * 静默吞掉，于是这个头**从来没被读到过**（实测返回 null）。同文件里
 * Responses 那条路径早就用 `up.headers?.['retry-after']` 并留了注释，
 * 这里漏了。两种形状都认：Node 普通对象优先，fetch Response 也兼容。
 */
function upstreamRetryAfterMs(res, bodyText) {
  const rawHeader = res?.headers?.['retry-after'] ?? res?.headers?.get?.('retry-after');
  // `retry-after` 允许是秒数，也允许是 HTTP 日期（RFC 7231）
  const asNumber = Number(rawHeader);
  if (Number.isFinite(asNumber) && asNumber > 0) return asNumber * 1000;
  if (typeof rawHeader === 'string' && rawHeader) {
    const asDate = Date.parse(rawHeader);
    if (Number.isFinite(asDate)) {
      const delta = asDate - Date.now();
      if (delta > 0) return delta;
    }
  }
  try {
    const j = JSON.parse(bodyText);
    for (const key of ['retry_after_ms', 'retryAfterMs', 'retry_after']) {
      const n = Number(j?.[key]);
      if (Number.isFinite(n) && n > 0) return n;
    }
  } catch { /* body 不是 JSON：没有提示 */ }
  return null;
}
const UPSTREAM_TIMEOUT_MS = numEnv('WORKBUDDY_TIMEOUT_MS', 0, { min: 0 }); // 0 = unlimited (long answers need it)
/**
 * 首字节超时：从拿到 socket 到收到上游**第一块响应体**。
 *
 * 不是总时长限制 —— 模型想多久都可以，只抓“连接建立了但一直不说话”的卡死。
 * 默认 120s（远高于实测 TTFT 1–6s），设 0 关闭。
 */
const UPSTREAM_FIRST_BYTE_TIMEOUT_MS = numEnv('WORKBUDDY_FIRST_BYTE_TIMEOUT_MS', 120_000, { min: 0 });
/**
 * 连接池排队超时：长流把 socket 占满时，后续请求不能无限排队。
 * 默认 120s，设 0 关闭。
 */
const UPSTREAM_QUEUE_TIMEOUT_MS = numEnv('WORKBUDDY_QUEUE_TIMEOUT_MS', 120_000, { min: 0 });
/** 上游连接池上限。默认 32：dsh 多会话 + 子 agent + 外部客户端同时用时不至于互等。 */
const MAX_UPSTREAM_SOCKETS = numEnv('WORKBUDDY_MAX_SOCKETS', 32, { min: 1, max: 1024, integer: true });

/**
 * Codex 的「延迟工具检索闸门」。MCP 提供的工具（含 Codex 自带 computer-use 的
 * 唯一入口 `mcp__node_repl.js`）**不在** `tools[]` 里，模型得先调 `tool_search`
 * 检索，命中结果下一轮才以 `namespace` 分组出现。
 *
 * 桥把它翻成同名普通函数；回包侧必须回 `tool_search_call`（见 closeTool），
 * 且**不能**把它当普通 `function_call` 发回去。
 */
const TOOL_SEARCH_NAME = 'tool_search';

// ── Upstream keep-alive connection pool ────────────────────────────────────
// 为什么要自己管连接：Node 全局 fetch（undici）的空闲连接只保留 ~4 秒。写代码
// 的间隙一过，下一次请求就要重付一遍 DNS + TLS 握手（实测 ~150ms，温连接 ~82ms；
// 复现：node tools/dev/bench-overhead.mjs）。
// 用 http/https 的 keep-alive Agent：空闲连接保留 5 分钟，跨请求复用同一条
// TLS 会话，「首 token 延迟」稳定砍掉一大截。测试桩走纯 HTTP，所以两套都要。
const KEEPALIVE_MS = numEnv('WORKBUDDY_KEEPALIVE_MS', 300_000, { min: 0 }); // 5 min, 0 = off
const httpAgent = new HttpAgent({ keepAlive: KEEPALIVE_MS > 0, keepAliveMsecs: Math.max(1000, KEEPALIVE_MS), maxSockets: MAX_UPSTREAM_SOCKETS, scheduling: 'lifo' });
const httpsAgent = new HttpsAgent({
  keepAlive: KEEPALIVE_MS > 0,
  keepAliveMsecs: Math.max(1000, KEEPALIVE_MS),
  maxSockets: MAX_UPSTREAM_SOCKETS,
  scheduling: 'lifo',
  // 刻意**不设** socket timeout：LLM 流式回答中间可能有几十秒的 reasoning 停顿，
  // 空闲超时会在流中间掐断长回答。死连接靠 sendWithRetry 的 reusedSocket 重试兜底。
});
const agentFor = (endpoint) => (String(endpoint).startsWith('https:') ? httpsAgent : httpAgent);

const PORT = numEnv('WORKBUDDY_PORT', 8790, { min: 1, max: 65535 });
const HOST = process.env.WORKBUDDY_HOST || '127.0.0.1';
/**
 * 本地回环令牌。**永远非空** —— 这是认证闸门的前提。
 *
 * 曾经的写法是 `process.env.WORKBUDDY_LOCAL_TOKEN || ''`，配合闸门里的
 * `if ((LOCAL_TOKEN || ...) && identifyClientId(req) === null)`，含义变成
 * 「没配令牌就不校验」。而 `config.mjs` 那份默认值只在**控制台启动桥**时注入，
 * 用户直接 `node bridge/workbuddy-bridge.mjs` 拿到的是空串 → 等于无鉴权：
 * `/health`、`/v1/chat/completions` 对同机任意进程敞开（会真实消耗账号额度）。
 *
 * 现在：未显式配置时**自动生成随机令牌**并在启动日志打印，用户可从日志复制到客户端。
 * 安全默认应当是「拒绝未授权」，不是「放行一切」。（已由 bridge.test.mjs
 * 的「未配置 … 时不得静默放行」用例钉住。）
 */
const EXPLICIT_LOCAL_TOKEN = process.env.WORKBUDDY_LOCAL_TOKEN || '';
const LOCAL_TOKEN = EXPLICIT_LOCAL_TOKEN || randomBytes(24).toString('base64url');
/**
 * 客户端凭据分层（opt-in）：`WORKBUDDY_CLIENT_KEYS=逗号分隔的多把 key`。
 *
 * 用途：把不同客户端（Claude Code / opencode / Cursor…）**分开记账与限流**；
 * 某个客户端失控时，在 .env 里删掉它的 key 单独吊销（重启桥生效）。
 *
 * **内存中只保留 SHA-256 哈希**（前 8 位作展示标识），明文只在启动时读一次
 * env，之后不再出现；账本里的 `client` 字段就是这 8 位 —— 日志与账本都不泄露
 * 完整 key。默认空 = 功能关，行为与之前完全一致（只有 LOCAL_TOKEN 一把钥匙）。
 */
const CLIENT_KEY_HASHES = new Map(); // sha256hex -> 展示 id（哈希前 8 位）
for (const rawKey of String(process.env.WORKBUDDY_CLIENT_KEYS || '').split(',')) {
  const key = rawKey.trim();
  if (!key) continue;
  const hex = createHash('sha256').update(key).digest('hex');
  CLIENT_KEY_HASHES.set(hex, hex.slice(0, 8));
}
const EXPLICIT_ENDPOINT = process.env.CODEBUDDY_ENDPOINT || '';
const API_KEY = process.env.CODEBUDDY_API_KEY || '';
/**
 * 每日自动签到（R11.2）。默认**开** —— 用户的诉求就是「别让我记着」。
 * 独立启动的桥也签（不依赖控制台在不在）。`WORKBUDDY_AUTO_CHECKIN=0` 关闭。
 */
const AUTO_CHECKIN_ENABLED = process.env.WORKBUDDY_AUTO_CHECKIN !== '0';
const LOG = process.env.WORKBUDDY_LOG === '1';
/** 进程启动时刻，供 /health 汇报运行时长。 */
const STARTED_AT = Date.now();

// Curated models exposed by default; others remain reachable via /v1/models?all=1
/**
 * 已知可用、但**上游目录可能漏掉**的模型（兜底展示 + 放行用）。
 *
 * 倍率优先取上游的 `credits`（形如 `x0.11`），这里的数值取自上游实测、
 * 仅在上游没给时才用 —— 注意它们会随官方调价而过时。
 *
 * ## 为什么必须带能力标记（2026-10-12 修）
 *
 * 上游目录**并不完整**：国际版能成功调用 `deepseek-v4.1-flash`，但它不出现在
 * 任何一个目录端点里（`/health.upstreamShape.supplemented` 能看到补了谁）。
 * 走补全进来的模型**原本不带任何能力字段** —— 于是 dsh 的模型选择器把它显示成
 * 「纯文本、不支持推理」，用户想选思考强度还会被 dsh 直接拒掉：
 * `session/model-unavailable: model "deepseek-v4.1-flash" does not support reasoning effort "high"`。
 *
 * 所以这里的能力标记**必须实测过**（不猜，与项目其它地方同一纪律）：
 *   · `deepseek-v4.1-flash` —— 2026-10-12 打真实国际版网关实测：
 *     ① 视觉：塞一张 1×1 红点图，它答出「粉色」；
 *     ② 推理：`reasoning_effort` 五档（minimal/low/medium/high/max）全部 200，
 *        且都返回 `reasoning_content`（探针见 `tools/dev/probe-capability.mjs`
 *        与 `tools/dev/probe-effort.mjs`）。
 *
 * ## `regions`：只在列出的区域补全
 *
 * `deepseek-v4-pro` 在国际版网关实测 **400 `model [...] service info not found`**
 * —— 那个区域根本不提供它。补进去只会得到选择器里一个一调就报错的死条目，
 * 所以标 `['cn']`：国内版照旧补，国际版不补。
 * 没写 `regions` 的条目视为**全区域**。
 */
const FEATURED = [
  {
    id: 'deepseek-v4.1-flash',
    name: 'DeepSeek-V4.1-Flash',
    context: 1000000,
    maxOutput: 128000,
    credits: 0.11,
    images: true,
    supportsReasoning: true,
  },
  { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', context: 1000000, maxOutput: 50000, credits: 0.51, regions: ['cn'] },
  { id: 'glm-5.3', name: 'GLM-5.3', context: 1000000, maxOutput: 48000, credits: 0.79 },
];

/**
 * 登录文件对应的上游区域：`'cn' | 'intl'`（只用于 FEATURED 的 `regions` 过滤）。
 *
 * 按**登录域名**判，不看 `auth.endpoint`：`CODEBUDDY_ENDPOINT` 会把 endpoint
 * 覆盖成桩地址（验收用例靠它把出站流量导向本地），那不是区域信息。
 */
function upstreamRegion(auth) {
  return pickUpstream(auth?.domain) === 'https://copilot.tencent.com' ? 'cn' : 'intl';
}

/** 某个 FEATURED 条目在当前区域是否可用（未标 `regions` = 全区域）。 */
function featuredAllowedIn(f, region) {
  return !Array.isArray(f.regions) || f.regions.includes(region);
}

/**
 * 默认视图给几个模型：`WORKBUDDY_MODELS_DEFAULT` / 面板里保存的偏好。
 *
 * ## 为什么需要它（2026-10-26 反馈）
 *
 * `/v1/models` 不带 `all=1` 时**只回 3 个精选**，而几乎所有客户端的「获取模型
 * 列表 / 一键同步」按钮打的就是这个不带参数的地址 —— 于是用户看到「桥只认三个
 * 模型」，完整目录其实躺在 `?all=1` 里。精选是**给默认视图收窄噪音**的默认值，
 * 不该是唯一选项：用户想把 32 个全灌进客户端，必须有办法说出口。
 *
 * ## 取值
 *
 * - 不设（默认）→ `curated`：精选集，行为与之前完全一致；
 * - `all`        → 全量目录（等价于让客户端自动带 `all=1`）；
 * - 正整数 N     → 精选在前、其余按目录顺序补上，取前 N 个。
 *
 * ## 两个来源，优先级明确
 *
 * ① 面板「可用模型」里保存的值（`models-default.json`，改了**立即生效**）；
 * ② 环境变量 `WORKBUDDY_MODELS_DEFAULT`（部署级默认）。
 *
 * 面板存的优先 —— 用户点了保存就该立刻看到效果，不该被 `.env` 里一个旧值压回去。
 * 面板没存过（文件不存在 / 空）才用环境变量。
 *
 * 另外 `/v1/models?limit=N` 是**请求级**覆盖，两者取更宽的那个。
 *
 * 非法值**不报错**：回退 `curated` 并记一次日志 —— 与 `numEnv()` 同一套纪律
 * （写错一个环境变量不应该让桥起不来，但也不能静默假装生效）。
 */
function parseModelsDefault(raw) {
  const text = String(raw ?? '').trim().toLowerCase();
  if (!text) return { mode: 'curated' };
  if (text === 'all' || text === 'full') return { mode: 'all' };
  if (text === 'curated') return { mode: 'curated' };
  const n = Number(text);
  if (Number.isFinite(n) && n > 0) return { mode: 'limit', limit: Math.trunc(n) };
  return { mode: 'curated', invalid: String(raw) };
}

/**
 * 「只给这几个模型」——`{ mode: 'ids', ids: [...] }`。
 *
 * 与 `all` / 数字三选一：数字按**目录顺序**取前 N 个（用户不关心是哪几个），
 * 而这里是用户**逐个点名**的（比如"只要三个能看图的和一个便宜的快模型"）。
 * 顺序按用户提交的顺序保留 —— 它同时决定了客户端模型列表里的先后。
 *
 * id 会过一遍可见 ASCII 与长度校验（与 `HEADER_SAFE_RE` 同一套理由：这些 id
 * 之后要作为 `X-Model-ID` 发上游，含中文/换行的 id 会让请求在更远的地方炸）。
 * **不能直接引用 `HEADER_SAFE_RE` / `MAX_MODEL_ID_LEN`**：它们定义在本文件后段，
 * 模块顶层求值的解析函数引用了它们会撞 TDZ（报错还跟"选哪几个模型"毫无关系）。
 *
 * 不存在的 id **不在这里剔除**：目录可能只是暂时没刷到，硬删等于把用户的选择
 * 静默改掉；由 `/v1/models` 返回时与实际目录求交集即可。
 */
const MODELS_DEFAULT_ID_MAX = 200;
const MODELS_DEFAULT_ID_RE = /^[\x20-\x7e]+$/;
function parseIdsDefault(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const seen = new Set();
  const ids = [];
  for (const item of list) {
    const id = typeof item === 'string' ? item.trim() : '';
    if (!id || id.length > MODELS_DEFAULT_ID_MAX) continue;
    if (!MODELS_DEFAULT_ID_RE.test(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids.length ? { mode: 'ids', ids } : null;
}
/**
 * 面板保存的偏好文件（`WORKBUDDY_MODELS_DEFAULT_FILE` 仅供测试覆盖）。
 *
 * **惰性求值**：`RUNTIME_DATA_DIR` 在本文件后面才定义（它还要读 HOME 兜底），
 * 在模块顶层直接引用会撞 TDZ —— 表现为桥启动即 `Cannot access before
 * initialization`，而这个错误跟"默认给几个模型"毫无关系，极难对上号。
 */
function modelsDefaultFile() {
  return process.env.WORKBUDDY_MODELS_DEFAULT_FILE
    || join(RUNTIME_DATA_DIR, 'models-default.json');
}
/**
 * 已保存面板偏好（内存副本）。`undefined` = 还没读过，`null` = 读过但没有偏好。
 * 每次读文件太亏（`/v1/models` 是客户端的高频路径），但**改了要立刻生效**：
 * 保存接口会就地更新这份内存副本，不需要重启桥。
 */
let savedModelsDefault = undefined;
function readSavedModelsDefault() {
  if (savedModelsDefault !== undefined) return savedModelsDefault;
  try {
    const raw = JSON.parse(readFileSync(modelsDefaultFile(), 'utf8'));
    // 指定清单优先：文件里两种形状都认（`value` 字符串 = curated/all/N，
    // `ids` 数组 = 用户逐个点名的模型）。写成数组而不是把 id 拼成逗号串，
    // 是为了让 id 里的逗号 / 空格不需要转义。
    const ids = parseIdsDefault(raw?.ids);
    if (ids) { savedModelsDefault = ids; return savedModelsDefault; }
    const value = typeof raw?.value === 'string' ? raw.value.trim() : '';
    savedModelsDefault = value ? parseModelsDefault(value) : null;
  } catch {
    savedModelsDefault = null; // 没有文件 / 读坏了：都当「没保存过」
  }
  return savedModelsDefault;
}
/**
 * 当前生效的默认视图规模。
 *
 * `source` 只用于展示与排查（面板要能说清「这个数是从哪来的」）：
 * `panel` = 面板保存的；`env` = 环境变量；`builtin` = 都没设，用精选。
 */
function effectiveModelsDefault() {
  const saved = readSavedModelsDefault();
  if (saved) return { ...saved, source: 'panel' };
  const fromEnv = parseModelsDefault(process.env.WORKBUDDY_MODELS_DEFAULT);
  if (process.env.WORKBUDDY_MODELS_DEFAULT && process.env.WORKBUDDY_MODELS_DEFAULT.trim()) {
    return { ...fromEnv, source: 'env' };
  }
  return { ...fromEnv, source: 'builtin' };
}

/**
 * 每个模型**实测**支持的 `reasoning_effort` 档位。
 *
 * ## 为什么需要它（2026-10-12 用户反馈）
 *
 * 插件给 dsh 声明的档位原先**写死**成低/中/高三档。而上游到底收哪些值，
 * 目录里**没有任何字段可查**（`supportsReasoning` 只说"这个模型会推理"，
 * 不说"接受哪几档 reasoning_effort"）。声明了却不接受的值，用户一选就报错
 * （`does not support reasoning effort "xxx"`）—— 与"能力标记"是同一类问题。
 *
 * ## 数据怎么来的：实测，不猜
 *
 * `tools/dev/probe-efforts-all.mjs` 对**真实网关**逐模型 × 逐档位打一遍
 * （判据 = HTTP 200；另打一个**不带档位的对照组**，用来把"模型不可用"和
 * "这个档位不支持"分开）。2026-10-12 国际版账号、20 个模型的结论：
 *
 * - 档位全集取自**国际版桌面端产物**的 `EXTENDED_THINKING_LEVELS`
 *   （off / minimal / low / medium / high / xhigh / max，另加 none）；
 * - **档位差异是真实存在的**（这正是不能写死的原因）：
 *   · `gpt-5.6-sol / terra / luna` **不收 `minimal`**；`gpt-6-luna` 收；
 *   · `gpt-5.3-codex / 5.4 / 5.5 / primary-model` 连 **`max` 都不收**；
 *   · `gemini-3.5-flash` 不收 `xhigh`；`deepseek-v4.1-flash` 不收 `off`；
 * - **`off` / `none` 一律不声明**：`off` 对一部分模型 400、对另一部分模型虽然
 *   200 但**照样思考**（实测 reasoning_tokens > 0）；`none` 对 gemini 400。
 *   暴露出来只会造成误导或报错；
 * - `claude-haiku-4.5` / `claude-opus-4.8`：对照请求就 400
 *   （`service info not found`）—— 网关当前不接。显式空数组 = 不声明推理。
 *
 * 同日国内版账号、CN 目录 29 个推理模型的结论（矩阵与上表**按模型 id 共用**）：
 *
 * - **22 个全档**；`deepseek-v4-pro` / `deepseek-v4-flash` 只拒 `off`
 *   （`off` 照例不声明）；`deepseek-v4-pro` 国内版可用（国际版目录里根本没有它，
 *   只在国内版补全，所以并表对国际版无影响）；
 * - **7 个目录在列但网关不接**（对照即 400 `service info not found`）：
 *   `glm-4.6 / 4.6v / 4.7 / 5.0`、`hy4-preview-x`、`kimi-k2-thinking`、
 *   `minimax-m2.5` —— 显式空数组，与 claude-* 同款处理；
 * - 两端共有的 5 个模型（hy3 / hy4-preview / glm-5.2 / glm-5.3 / kimi-k2.6）
 *   复测**结论一致** → 表不需要区域维度；
 * - `deepseek-v4.1-flash` 的 CN 复测**已于 2026-10-12 16:04 补完**（换新账号后
 *   不起 429 了）：对照组 200、`off` 400、`none` 200、`minimal…max` 六档全 200
 *   （reasoning_tokens 99/147/164/49/40/123/60）→ **与国际版结论一致**，
 *   即"只拒 `off`"。先前的 429 是**旧账号**的模型级频率限制，与档位无关。
 *
 * ## 教训：第一批矩阵全错，原因是探针自己
 *
 * 第一版探针用 `max_tokens: 8` 发请求，而**推理模型会拒绝过小的输出预算**
 * （`gpt-5.6-sol`：8 → 400 `model_param_invalid`，≥64 → 200 正常答题），
 * 于是 9 个模型被误判成"完全不可调"——对照组也用 8，所以对照没对照出问题。
 * 探针现在用 1024。**测量脚本自己的参数也是被测系统的一部分。**
 *
 * ## 教训：孤立单格 400 要复测再缩表（2026-10-12 CN）
 *
 * CN 矩阵里 `space-bunny/minimal` 与 `hunyuan-2.0-thinking/xhigh` 各出现过
 * **一次** 400，其余格子全 200。直接信它就会把这两个模型误判成"不收某档"。
 * 复测 **6/6 全 200** → 判定为网关在 16 分钟持续高压下的**偶发拒绝**。
 * 区分依据：真不支持的档位是**确定性** 400（7 个死模型 9/9 格全 400、
 * gpt-5.6 不收 minimal、gemini 不收 xhigh），而偶发拒绝是孤立单格。
 * 探针对 400 不重试（只对 429 退避）—— **看到孤立 400，手动复测再决定**。
 *
 * ⚠️ 表会随上游变化而过时。上游改了档位、或加了新模型，**复跑探针**并按结果更新本表
 * （新模型先用默认三档 —— 安全：宁可少一档，不可多一个会 400 的档）。
 */
const DEFAULT_REASONING_EFFORTS = ['low', 'medium', 'high'];

/** 实测与默认不同的模型（key = 模型 id，value = 实测接受的档位，顺序即展示顺序）。 */
const REASONING_EFFORTS_BY_MODEL = {
  // 全档（minimal…max + xhigh）—— 2026-10-12 实测
  'deepseek-v4.1-flash': ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  'fast-model': ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  'balanced-model': ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  'hy3': ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  'hy4-preview': ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  'glm-5.2': ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  'glm-5.3': ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  'kimi-k3': ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  'kimi-k2.6': ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  'gpt-6-luna': ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  // gpt-5.6 系：**不收 minimal**（实测 400）
  'gpt-5.6-sol': ['low', 'medium', 'high', 'xhigh', 'max'],
  'gpt-5.6-terra': ['low', 'medium', 'high', 'xhigh', 'max'],
  'gpt-5.6-luna': ['low', 'medium', 'high', 'xhigh', 'max'],
  // 这四个连 max 都不收
  'gpt-5.3-codex': ['low', 'medium', 'high', 'xhigh'],
  'gpt-5.4': ['low', 'medium', 'high', 'xhigh'],
  'gpt-5.5': ['low', 'medium', 'high', 'xhigh'],
  'primary-model': ['low', 'medium', 'high', 'xhigh'],
  // gemini：不收 xhigh（none / off 也 400）
  'gemini-3.5-flash': ['minimal', 'low', 'medium', 'high', 'max'],

  // ===== 国内版 2026-10-12 实测（CN 目录 29 个推理模型，全部实测）=====
  // 与上表**共有的 5 个模型**（hy3 / hy4-preview / glm-5.2 / glm-5.3 / kimi-k2.6）
  // 复测结论一致，已在上表，不重复列。deepseek-v4.1-flash 的 CN 复测**已补完**
  // （2026-10-12 16:04，换账号后）：只拒 off、其余六档全 200，与国际版一致
  // —— 同一 id 共用上表条目，此处不重复列。
  //
  // 全档（minimal…max + xhigh）——16 个。其中 space-bunny / hunyuan-2.0-thinking
  // 探针各有一格偶发 400（space-bunny/minimal、hunyuan/xhigh），**复测 6/6 全 200**
  // —— 判定为网关在持续高压下的偶发拒绝，按全档入表。真不支持的档位（见上表
  // gpt-5.6 不收 minimal、gemini 不收 xhigh）是**确定性** 400，与此不同。
  'auto': ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  'deepseek-v3-2-volc': ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  'deepseek-v4-flash': ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  'deepseek-v4-pro': ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  'glm-5.1': ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  'glm-5.3-flash': ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  'glm-5v-turbo': ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  'hunyuan-2.0-thinking': ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  'hy3-x': ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  'kimi-k2.5': ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  'kimi-k2.7': ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  'kimi-k2.8-preview': ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  'kimi-k3-1': ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  'minimax-m3': ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  'space-bunny': ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  'step-5-preview': ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],

  // 网关当前不接（对照请求 400 `service info not found`）→ 显式空数组 =
  // "不声明推理"，dsh 选择器不显示思考强度（比显示一个必然失败的控件好）。
  // 网关真提供后：复跑探针，把实测档位填回来。
  // claude-*（国际版目录在列）：
  'claude-haiku-4.5': [],
  'claude-opus-4.8': [],
  // 国内版目录在列、**网关不接**：连不带档位的对照请求都 400
  // `service info not found`（与 claude-* 同类，是可用性问题不是档位问题）。
  // 显式空数组 = 不声明推理，dsh 选择器不显示思考强度（比显示一个必然失败的控件好）。
  'glm-4.6': [],
  'glm-4.6v': [],
  'glm-4.7': [],
  'glm-5.0': [],
  'hy4-preview-x': [],
  'kimi-k2-thinking': [],
  'minimax-m2.5': [],
};

/** 取某模型的档位（只有目录说它支持推理时才该调用）。 */
function effortsFor(id) {
  const hit = REASONING_EFFORTS_BY_MODEL[id];
  // 显式空数组 = 实测一个档都不收 → 照实返回（插件会因此不声明推理）
  return Array.isArray(hit) ? hit : DEFAULT_REASONING_EFFORTS;
}

/**
 * 上游目录里 `reasoning.supportedEfforts` 的合法取值。
 *
 * 官方客户端（以及 dsh 适配器）只认这几个 id；未知值既不能展示也不能下发。
 * `off` / `none` 不在表里：它们表达"关闭思考"，而网关对它们处理不一致。
 */
const KNOWN_REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/** 目录数组 → 去空、去重、只留已知档位；不是数组/没有有效值返回 null。 */
function normalizeEfforts(list) {
  if (!Array.isArray(list)) return null;
  const out = [];
  for (const raw of list) {
    const id = String(raw || '').trim();
    if (KNOWN_REASONING_EFFORTS.includes(id) && !out.includes(id)) out.push(id);
  }
  return out.length ? out : null;
}

/** 上下文档位（如 300000 / 600000 / 1000000）→ 去重升序；无效返回空数组。 */
function normalizeContextLengths(list) {
  if (!Array.isArray(list)) return [];
  return [...new Set(list.map((n) => Number(n)).filter((n) => Number.isSafeInteger(n) && n > 0))].sort((a, b) => a - b);
}

/**
 * 用户显式指定的上下文预算（`WORKBUDDY_CONTEXT_WINDOW=600000`）。
 *
 * dsh 的适配器契约只有**一个** contextWindow，没有"选择器"；默认跟随官方
 * 的 `defaultLength`（多数模型 300K），显式设置才钉到某个值（上限仍受模型
 * maxInputTokens 约束）。不设置时默认 0 = 用官方默认。
 */
const CONTEXT_WINDOW_OVERRIDE = numEnv('WORKBUDDY_CONTEXT_WINDOW', 0, { min: 1, integer: true });

/** 该模型对 dsh 暴露的上下文容量：显式覆盖 > 官方默认 > 模型上限。 */
function contextWindowForModel(model) {
  const max = Number(model?.context) || 0;
  const wanted = CONTEXT_WINDOW_OVERRIDE || Number(model?.contextDefault) || max;
  return max && wanted > max ? max : wanted;
}

/**
 * 同一模型在 `/v2/.../models` 与 `/v3/config` 里各有一份描述。
 *
 * 两个端点字段并不等价：`/v3/config` 带官方选择器用的 `reasoning.supportedEfforts`
 * 与 `contextWindow.supportedLengths`，`/v2/.../models` 有时反而缺。合并时
 * **不能让后到的薄条目把先到的丰富字段冲掉**，否则又会退回"硬编码六档"。
 */
function mergeCatalogModel(prev, next) {
  if (!prev) return next;
  // `/v3/config` 先到（官方真源）：它的标量字段优先，`/v2` 只补 v3 没给的。
  const merged = { ...next, ...prev };
  for (const [key, value] of Object.entries(next)) {
    if (merged[key] === undefined) merged[key] = value;
  }
  // reasoning / contextWindow 必须**按子字段合并**：v3 可能只给
  // supportedEfforts、v2 才带 defaultEffort/canDisableThinking；整块二选一
  // 会把另一半丢掉（实测 defaultEffort 因此消失）。
  if (prev?.reasoning || next?.reasoning) {
    merged.reasoning = {
      ...(next?.reasoning && typeof next.reasoning === 'object' ? next.reasoning : {}),
      ...(prev?.reasoning && typeof prev.reasoning === 'object' ? prev.reasoning : {}),
    };
    if (!normalizeEfforts(merged.reasoning.supportedEfforts)
      && normalizeEfforts(next?.reasoning?.supportedEfforts)) {
      merged.reasoning.supportedEfforts = next.reasoning.supportedEfforts;
    }
  }
  if (prev?.contextWindow || next?.contextWindow) {
    merged.contextWindow = {
      ...(next?.contextWindow && typeof next.contextWindow === 'object' ? next.contextWindow : {}),
      ...(prev?.contextWindow && typeof prev.contextWindow === 'object' ? prev.contextWindow : {}),
    };
    if (!normalizeContextLengths(merged.contextWindow.supportedLengths).length
      && normalizeContextLengths(next?.contextWindow?.supportedLengths).length) {
      merged.contextWindow.supportedLengths = next.contextWindow.supportedLengths;
    }
    if (!(Number(merged.contextWindow.defaultLength) > 0)
      && Number(next?.contextWindow?.defaultLength) > 0) {
      merged.contextWindow.defaultLength = next.contextWindow.defaultLength;
    }
  }
  // tags 取并集：官方选择器判定依赖 craft/chat 标签，任一端点给了都算。
  const tags = [...new Set([...(Array.isArray(prev.tags) ? prev.tags : []), ...(Array.isArray(next.tags) ? next.tags : [])])];
  if (tags.length) merged.tags = tags;
  return merged;
}

/**
 * 官方模型选择器实际列出的 id。
 *
 * 桌面端 GUI 不是把 `/v2/.../models` 全量铺出来：它用 `/v3/config` 里
 * `agents[]` 的会话 agent（tag=default → name=cli → 第一个有 models 的）
 * 加 `chat` 标签模型。这里复刻同一判据（付费线路过滤依赖账号权益，桥侧
 * 拿不到可靠输入，不做臆测）；拿不到 agent 时返回 null（= 未知，不能因此
 * 把所有模型都打成"非官方"）。
 */
function officialPickerIds(agents, models) {
  const list = Array.isArray(agents) ? agents.filter((a) => a && Array.isArray(a.models) && a.models.length) : [];
  const picker = list.find((a) => Array.isArray(a.tags) && a.tags.includes('default'))
    || list.find((a) => a.name === 'cli')
    || list[0]
    || null;
  const ids = new Set();
  if (picker) for (const id of picker.models) if (typeof id === 'string' && id) ids.add(id);
  for (const m of Array.isArray(models) ? models : []) {
    if (!m || typeof m.id !== 'string' || !m.id) continue;
    if (Array.isArray(m.tags) && m.tags.includes('chat')) ids.add(m.id);
    // 用户自定义模型在 GUI 里始终可见（selectConversationModels 的 custom 分支）
    if ((Array.isArray(m.tags) && m.tags.includes('custom')) || m.id.startsWith('custom:')) ids.add(m.id);
  }
  return ids.size ? ids : null;
}

/**
 * 取某模型的消耗倍率。
 *
 * 上游给的 `credits` 可能是**数字**，也可能是形如 `"x0.03"` 的**字符串**——
 * 只认数字会把后者静默丢掉。
 *
 * **拿不到就返回 undefined，不回退到别的区域的值**：倍率随区域与促销变化，
 * 用国内实测值去填国际版的同一个模型 id，会把免费模型标成 0.11。
 */
function creditsOf(model) {
  const raw = model?.credits;
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'string') {
    const hit = /x\s*([0-9]*\.?[0-9]+)/i.exec(raw);
    if (hit) return Number(hit[1]);
  }
  return undefined;
}

// Locate the CodeBuddy / WorkBuddy desktop login file across platforms.
// Override with WORKBUDDY_AUTH_FILE when the desktop app stores it elsewhere.
//
// ⚠️ 这里必须与 `config.mjs` 的 `authDir()` **同一套口径**（两处实现，只能靠这条注释
// 与用例守住）。原先桥这边少两样，实测都出真故障：
//   1. **没有 `USERPROFILE` 兜底** —— 而 Windows 默认只有 `USERPROFILE`、没有 `HOME`；
//   2. 三个变量全空时会拼出 `join('.', 'workbuddy-desktop.info')` = **相对路径**，
//      按 cwd 解析 → 桥找不到登录文件，表现却是"用户没登录"，真凶完全看不出来。
// Windows 上优先用 LOCALAPPDATA，缺失时退回 `<home>/AppData/Local`（与 config.mjs 一致）。
/**
 * 家目录，**三级兜底**：`USERPROFILE`（Windows）→ `HOME`（POSIX）→ 系统查询。
 *
 * 为什么要 `userInfo()` 这一层（实测踩到，CI 矩阵上两个平台同时红）：
 * `homedir()` 在 `HOME` **存在但为空字符串**时直接返回**空串** ——
 * libuv 只判断 `getenv("HOME") != NULL`，**不看内容**。
 * 于是 `USERPROFILE`(无) || `HOME`('') || `homedir()`('') 整条链全落空，
 * 家目录变成空串，`join('', 'Library', ...)` 拼出相对路径。
 * `userInfo().homedir` 在 POSIX 上走 `getpwuid`，**不受空 HOME 影响**，
 * 正是「LOCALAPPDATA / HOME 都缺」这个场景需要的兜底。
 */
const HOME_FOR_AUTH = (() => {
  const fromEnv = process.env.USERPROFILE || process.env.HOME;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  const h = homedir();
  if (h && h.trim()) return h.trim();
  try { return userInfo().homedir || ''; } catch { return ''; }
})();
/**
 * 运行期数据目录（账本、状态、令牌）。默认 `~/.workbuddy-bridge`，与插件
 * 凭据目录同一棵树；`WORKBUDDY_DATA_DIR` 可覆盖（测试 / 便携部署）。
 *
 * 不放在安装目录的原因：pnpm 换 tgz / 重装会重写安装目录，账本与令牌
 * 都会丢（同类项目已多次因此让客户端 401、历史清零）。
 */
const RUNTIME_DATA_DIR = (() => {
  const raw = String(process.env.WORKBUDDY_DATA_DIR || '').trim();
  if (raw) return isAbsolute(raw) ? raw : join(process.cwd(), raw);
  return join(HOME_FOR_AUTH || homedir(), '.workbuddy-bridge');
})();
/**
 * 媒体任务元数据落盘：同步任务上游不保存，桥重启后必须靠本地缓存才能回答查询。
 * 只存 id/元数据（不含 prompt）；`WORKBUDDY_MEDIA_STORE=0` 可关闭。
 */
const MEDIA_STORE_FILE = process.env.WORKBUDDY_MEDIA_STORE_FILE
  || join(RUNTIME_DATA_DIR, 'media-tasks.json');
if (process.env.WORKBUDDY_MEDIA_STORE !== '0') {
  configureSubmissionStore({ file: MEDIA_STORE_FILE });
}
const WIN_LOCAL_APPDATA = process.env.LOCALAPPDATA
  || (process.platform === 'win32' ? join(HOME_FOR_AUTH, 'AppData', 'Local') : '');
const AUTH_DIRS = [
  process.env.WORKBUDDY_AUTH_DIR,
  WIN_LOCAL_APPDATA && join(WIN_LOCAL_APPDATA, 'CodeBuddyExtension', 'Data', 'Public', 'auth'),
  /*
   * macOS / Linux 这两条**必须用 `HOME_FOR_AUTH`（三级兜底）**，
   * 不能用裸 `process.env.HOME`。
   *
   * 现场（CI 矩阵实测）：`LOCALAPPDATA` / `HOME` / `XDG_DATA_HOME` 三者全空时
   * （精简环境、计划任务启动、CI），上面第二条在**非 Windows 平台**上是空串，
   * 而这两条又都依赖 `process.env.HOME` —— 于是整个 AUTH_DIRS 为空，
   * 末尾 `AUTH_DIRS[0] || '.'` 拼出**相对路径** `workbuddy-desktop.info`。
   * 相对路径按 cwd 解析，于是「桥找不到登录文件」会表现成「用户没登录」，
   * 真凶却是环境变量缺失 —— 极难查。
   *
   * Windows 之所以没暴露这个问题：`WIN_LOCAL_APPDATA` 会退到
   * `HOME_FOR_AUTH/AppData/Local`（那条**已经有兜底**）。同一个文件里两套写法不一致，
   * 于是只在矩阵里才现形。顺序不变 —— Windows 上第二条仍先命中，这两条只是兜底。
   */
  join(HOME_FOR_AUTH, 'Library', 'Application Support', 'CodeBuddyExtension', 'Data', 'Public', 'auth'),
  join(HOME_FOR_AUTH, '.local', 'share', 'CodeBuddyExtension', 'Data', 'Public', 'auth'),
  process.env.XDG_DATA_HOME && join(process.env.XDG_DATA_HOME, 'CodeBuddyExtension', 'Data', 'Public', 'auth'),
  /*
   * 最后一道闸：**只放行绝对路径**。
   * 家目录万一还是解析不出来（极端容器 / 被剥光的 env），宁可让这个候选为空，
   * 也不能让一个相对路径混进 AUTH_DIRS —— 那正是本 bug 的形态。
   */
].filter((d) => d && isAbsolute(d));

/**
 * Explicit override wins; otherwise the default file name, then the first
 * `*.info` in sorted order.
 *
 * Taking "the first entry the directory happens to list" is NOT safe: the
 * login directory commonly holds more than one account snapshot (e.g. the
 * international build's `workbuddy-desktop-ai.info`) and that one sorts before
 * `workbuddy-desktop.info`. Standing alone, the bridge would then silently
 * serve the wrong account. config.mjs resolves the same way, so both entry
 * points agree.
 */
/**
 * 当前客户端的**活动**登录文件名。
 *
 * 客户端登出/换号会留下 `workbuddy-desktop.<时间>.info` 快照；它们不是活动
 * 文件，按文件名排序还会排到活动文件前面。活动文件只有这两个固定名字。
 */
const ACTIVE_AUTH_NAMES = ['workbuddy-desktop.info', 'workbuddy-desktop-ai.info'];

/**
 * 挑活动登录文件：两个客户端同时装着时，用**最近被写入**的那个。
 *
 * 旧逻辑写死优先 `workbuddy-desktop.info`（国内版）。只用国际版、或两个都装
 * 但当前用国际版时，桥一直读国内版旧账号 —— 客户端换号当然看不到变化。
 * 与 config.mjs 的 resolveAuthFile() 必须同一判据。
 */
function pickActiveAuthFile() {
  let best = '';
  let bestAt = -1;
  for (const dir of AUTH_DIRS) {
    for (const name of ACTIVE_AUTH_NAMES) {
      const full = join(dir, name);
      try {
        const st = statSync(full);
        if (st.mtimeMs > bestAt) { best = full; bestAt = st.mtimeMs; }
      } catch { /* 这个客户端没装 */ }
    }
  }
  return best;
}

function defaultAuthPath() {
  const active = pickActiveAuthFile();
  if (active) return active;
  const fallback = join(AUTH_DIRS[0] || HOME_FOR_AUTH || process.cwd(), 'workbuddy-desktop.info');
  for (const dir of AUTH_DIRS) {
    try {
      const hit = readdirSync(dir).filter((f) => f.endsWith('.info')).sort()[0];
      if (hit) return join(dir, hit);
    } catch { /* directory absent on this platform */ }
  }
  /*
   * `AUTH_DIRS` 已经滤掉了非绝对路径，正常情况下 `[0]` 必然是绝对的。
   * 万一全空（家目录与所有 env 都解析不出来），**也不能退回 `'.'`** ——
   * 那正是「绝对路径悄悄变成相对路径」这个 bug 的形态。
   * 退到 `HOME_FOR_AUTH`，再不行退到 cwd，两者都是绝对的。
   */
  return fallback;
}

function resolveAuthPath() {
  if (process.env.WORKBUDDY_AUTH_FILE) return process.env.WORKBUDDY_AUTH_FILE;
  return defaultAuthPath();
}

/*
 * 多账号切换时，控制台会把桥钉在某个 `.info` 快照上（WORKBUDDY_AUTH_FILE）。
 * 但用户随后在 WorkBuddy 客户端里换号，客户端覆盖的是**它自己的默认登录文件**，
 * 不是我们钉住的快照 —— 于是桥一直读旧账号，面板显示旧账号（issue #6）。
 *
 * `WORKBUDDY_AUTH_FILE_FOLLOW` 是「桌面端当前登录文件」，`WORKBUDDY_AUTH_FOLLOW_UID`
 * 是**钉住那一刻**该文件里的账号 uid。之后该文件账号变了 = 用户在客户端换了号，
 * 桥自动改读它；账号没变（只是令牌刷新）则继续用用户显式选的快照。
 * 没给 FOLLOW_UID（旧状态）时按"快照账号 ≠ 桌面账号"迁移一次。
 */
const AUTH_FILE_FOLLOW = (() => {
  const raw = String(process.env.WORKBUDDY_AUTH_FILE_FOLLOW || '').trim();
  if (!raw) return '';
  /*
   * `auto` = 跟随客户端自己的默认登录文件。
   *
   * 插件拉起桥时只知道 `.state.json` 里的钉住快照，不应该自己再复制一份
   * 「默认登录文件在哪」的探测逻辑（两套规则迟早漂移）。让桥在这里解析，
   * 与控制台/配置共用同一套 AUTH_DIRS 顺序。只在启动时解析一次。
   */
  if (raw.toLowerCase() === 'auto') return defaultAuthPath();
  return isAbsolute(raw) ? raw : '';
})();
const AUTH_FOLLOW_UID = String(process.env.WORKBUDDY_AUTH_FOLLOW_UID || '').trim();
/**
 * 显式指定了登录文件 = 用户/面板的钉住选择；否则启动时取“当前活动客户端”的文件。
 *
 * 只在**启动时**选一次，运行中不随另一个客户端的令牌刷新来回切 —— 两个
 * 客户端同时装着时，后台刷新会让 mtime 互相追超，动态跟着切会把钱包切来
 * 切去。客户端内换号（同一个文件被重写）由 readStoredAuth 的文件指纹处理。
 */
const AUTH_PINNED_PATH = resolveAuthPath();
let AUTH_PATH = AUTH_PINNED_PATH;
const authFollowProbe = { path: '', mtimeMs: -1, size: -1, uid: '', error: '' };
const authPinnedProbe = { mtimeMs: -1, size: -1, uid: '' };

const log = (...a) => { if (LOG) console.error(`[${new Date().toISOString()}]`, ...a); };

// ── At-rest credential opener (WorkBuddy desktop 5.6.0+) ─────────────────
// 5.6.0+ seals auth fields in an AES-256-GCM envelope
// ({"$wbEncrypted":1,"envelope":"<base64 of {suite,keyId,nonce,authTag,ciphertext}>"}).
// The field key is a build-time constant that the app exposes only through its
// own Electron native binding, so we ask the installed binary for it and cache
// the derived key for the process lifetime.
const ATREST_AAD_DOMAIN = Buffer.from('WB-AAD\0', 'ascii');
let atRestKeyCache;
let atRestKeyPending = null; // 并发取钥合并：第二个请求等第一个 Promise，不重复拉 Electron
let atRestUsedExe = ''; // 最近一次成功取到密钥的客户端 exe（供启动日志/诊断显示）
let wantedKeyId = ''; // 登录文件里信封的 keyId —— 由 readStoredAuth 每次读取时刷新
let memoryAuth = null; // refreshed in-process; the desktop file is never rewritten

// ── Locate the WorkBuddy desktop executable ──────────────────────────────
// 客户端可以装到任意目录（E:\App\WorkBuddy、E:\App\WorkbuddyInternational、
// C:\Program Files\Tencent\WorkBuddy…），exe 名也随版本不同（WorkBuddy.exe /
// WorkBuddyAI.exe / CodeBuddy.exe）。只写死几个路径在"换目录重装"后必然失效
// —— 现象正是 `key fetch failed: spawnSync … ENOENT`。
//
// 探测顺序：显式覆盖 → 默认位置 → 磁盘浅扫描 → 系统信号兜底（进程路径 +
// 注册表安装记录，见下方）。与 lib/find-workbuddy.mjs 是同一套算法（桥刻意
// 保持自包含单文件、不 import 本项目模块；改动时两边需同步）。
const WB_EXE_NAME_RE = /^(?:workbuddy(?:\s*ai)?|codebuddy(?:\s*ai)?)\.exe$/i;
const WB_DIR_KEYWORD_RE = /workbuddy|codebuddy/i;
const WB_DESCEND_RE = /^(?:app|apps|application|applications|program|programs|program files(?:\s*\(x86\))?|software|soft|tools?|tencent|portable|green|dev|develop|development|应用|软件)$/i;
const WB_SCAN_MAX_DIRS = 400;
const WB_SCAN_MIN_INTERVAL_MS = 3000;
const WB_MISS_RETRY_MS = 5000;

let wbExeCache = '';
let wbScanCache = null;
let wbScanAt = 0;
let wbMissAt = 0;

function wbListDirs(dir, budget) {
  if (budget.dirs <= 0) return [];
  budget.dirs -= 1;
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/** Direct child of `dir` that looks like the client binary (full path or ''). */
function wbExeInDir(dir) {
  try {
    const hit = readdirSync(dir, { withFileTypes: true })
      .find((e) => !e.isDirectory() && WB_EXE_NAME_RE.test(e.name));
    return hit ? join(dir, hit.name) : '';
  } catch {
    return '';
  }
}

/** 磁盘浅扫描：盘根 → {App | Program Files | Tencent | …} → {含 workbuddy 的目录} → exe。 */
function wbScan() {
  if (process.platform !== 'win32') return [];
  const found = [];
  const seen = new Set();
  const budget = { dirs: WB_SCAN_MAX_DIRS };
  const push = (p) => { if (p && !seen.has(p)) { seen.add(p); found.push(p); } };

  for (let c = 67; c <= 90; c += 1) { // C: … Z:
    const drive = `${String.fromCharCode(c)}:\\`;
    if (!existsSync(drive)) continue;
    for (const name1 of wbListDirs(drive, budget)) {
      const p1 = join(drive, name1);
      if (WB_DIR_KEYWORD_RE.test(name1)) {
        // E:\App\WorkbuddyInternational\WorkBuddy.exe
        push(wbExeInDir(p1));
        for (const name2 of wbListDirs(p1, budget)) push(wbExeInDir(join(p1, name2)));
      } else if (WB_DESCEND_RE.test(name1)) {
        for (const name2 of wbListDirs(p1, budget)) {
          const p2 = join(p1, name2);
          if (WB_DIR_KEYWORD_RE.test(name2)) {
            push(wbExeInDir(p2));
            for (const name3 of wbListDirs(p2, budget)) push(wbExeInDir(join(p2, name3)));
          } else if (WB_DESCEND_RE.test(name2)) {
            // C:\Program Files\Tencent\WorkBuddy\WorkBuddy.exe
            for (const name3 of wbListDirs(p2, budget)) {
              if (WB_DIR_KEYWORD_RE.test(name3)) push(wbExeInDir(join(p2, name3)));
            }
          }
        }
      }
    }
  }
  return found;
}

/**
 * 静态候选：显式覆盖 + 各平台默认安装位置，最可信在前。
 * 只做路径拼接、不碰磁盘 —— 调用方可先用它做廉价的 `existsSync` 命中判断。
 */
function workBuddyStaticCandidates() {
  const out = [];
  if (process.env.WORKBUDDY_APP_EXECUTABLE) out.push(process.env.WORKBUDDY_APP_EXECUTABLE);
  if (process.platform === 'win32') {
    const names = ['WorkBuddy.exe', 'WorkBuddyAI.exe', 'CodeBuddy.exe'];
    for (const root of [
      process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs'),
      process.env.ProgramFiles,
      process.env['ProgramFiles(x86)'],
    ].filter(Boolean)) {
      for (const dir of ['WorkBuddy', 'WorkBuddy AI', 'WorkBuddyAI', 'CodeBuddy']) {
        for (const name of names) out.push(join(root, dir, name));
      }
    }
    out.push('E:\\App\\WorkBuddy\\WorkBuddy.exe');
    out.push('E:\\App\\WorkBuddy\\WorkBuddyAI.exe');
    out.push('D:\\App\\WorkBuddy\\WorkBuddy.exe');
  } else if (process.platform === 'darwin') {
    out.push('/Applications/WorkBuddy.app/Contents/MacOS/WorkBuddy');
    out.push('/Applications/WorkBuddy AI.app/Contents/MacOS/WorkBuddy');
  } else {
    out.push('/opt/WorkBuddy/workbuddy');
  }
  return out;
}

/**
 * 全部候选：静态在前，扫描兜底（带缓存与失败防抖 —— "客户端正在重装"的窗口期内
 * 不会每次调用都全盘扫一遍）。返回**数组**而不是单个路径：机器上可能并存
 * 多个 build，由 atRestKey() 按登录文件的 keyId 挑选。
 * 只想找一个可用 exe 时优先用 workBuddyStaticCandidates()，别为标准安装白付扫描成本。
 */
function workBuddyExeCandidates() {
  if (wbExeCache && existsSync(wbExeCache)) return [wbExeCache];

  const out = workBuddyStaticCandidates();

  if (wbScanCache && !wbScanCache.some((p) => existsSync(p))) {
    wbScanCache = null; // 陈旧：命中的文件都不在了 → 允许重扫（由防抖限制频率）
  }
  if (!wbScanCache && Date.now() - wbScanAt >= WB_SCAN_MIN_INTERVAL_MS) {
    wbScanAt = Date.now();
    const hits = wbScan();
    if (hits.length) wbScanCache = hits;
  }
  if (wbScanCache) {
    for (const p of wbScanCache) {
      if (!out.includes(p)) out.push(p); // 静态与扫描可能重叠，去重
    }
  }
  return out;
}

// ── 系统信号兜底（Windows）：进程镜像路径 + 注册表安装记录 ───────────────
// 静态候选与目录扫描本质上都在"猜路径"；客户端装进 `D:\随机名字\` 就会全部
// 落空。而下面两类信号是**客户端自己留下的、与安装位置无关**：
//   ① 运行中进程的镜像路径（客户端在用时即安装位置，最准）；
//   ② 注册表卸载记录 / 深链协议（workbuddy://…）/ App Paths —— 官方安装器
//      必写（否则"应用和功能"里看不到它），装到任何目录都有。
// PowerShell 冷启动数秒，故只在前面全部落空时执行，且带缓存与失败防抖。
// 与 lib/find-workbuddy.mjs 同款（桥保持自包含单文件；改动时两边需同步）。
const WB_SYS_PROBE_MIN_INTERVAL_MS = 120000;
let wbSysHits = null;
let wbSysProbeAt = 0;

/**
 * 异步子进程：stdin 可选、输出有限收集、超时 kill。
 *
 * 请求路径上的 `spawnSync` 会阻塞整个事件循环（取密钥最长 20s，期间所有
 * 在途流式响应停摆），所以统一走这里。返回形状与 spawnSync 对齐：
 * `{ error, code, stdout, stderr }`，调用方自己决定如何解释。
 */
/**
 * @param {string} exe
 * @param {string[]} args
 * @param {{
 *   input?: string | null,
 *   env?: NodeJS.ProcessEnv,
 *   timeout?: number,
 *   maxBuffer?: number,
 *   stdio?: import('node:child_process').StdioOptions,
 * }} [options]
 * @returns {Promise<{ error: Error | null, code: number | null, stdout: string, stderr: string }>}
 */
function runChild(exe, args, {
  input = null,
  env = undefined,
  timeout = 20000,
  maxBuffer = 1024 * 1024,
  stdio = ['ignore', 'pipe', 'pipe'],
} = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    let child = null;
    let timer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    timer = setTimeout(() => {
      try { child?.kill(); } catch { /* 已经退出 */ }
      finish({ error: new Error(`timeout after ${timeout}ms`), code: null, stdout, stderr });
    }, timeout);
    try {
      child = spawn(exe, args, { env: env || process.env, stdio, cwd: tmpdir(), windowsHide: true });
    } catch (e) {
      finish({ error: e, code: null, stdout: '', stderr: '' });
      return;
    }
    if (child.stdout) {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
        if (stdout.length > maxBuffer) {
          try { child.kill(); } catch { /* 已经退出 */ }
          finish({ error: new Error(`stdout exceeded ${maxBuffer} bytes`), code: null, stdout: '', stderr });
        }
      });
    }
    if (child.stderr) {
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        if (stderr.length < maxBuffer) stderr += chunk;
      });
    }
    child.on('error', (e) => finish({ error: e, code: null, stdout, stderr }));
    child.on('close', (code) => finish({ error: null, code, stdout, stderr }));
    if (input !== null && child.stdin) {
      // 子进程提前退出时 EPIPE 不应变成未捕获异常。
      child.stdin.on('error', () => { /* ignore */ });
      child.stdin.end(input);
    }
  });
}

function wbPowershellPath() {
  const full = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return existsSync(full) ? full : 'powershell';
}

/** 一次调用收集全部信号，base64 输出（免受编码/引号影响）。 */
const WB_SYS_PROBE_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$out = @{ procs = @(); reg = @() }
Get-Process | Where-Object { $_.Name -match '^(WorkBuddy|CodeBuddy)' } | ForEach-Object {
  if ($_.Path) { $out.procs += $_.Path }
}
$roots = @(
  'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
  'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
  'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
)
foreach ($r in $roots) {
  Get-ChildItem $r | ForEach-Object {
    $p = Get-ItemProperty $_.PSPath
    if ("$($p.DisplayName)" -match 'WorkBuddy|CodeBuddy') {
      $out.reg += @{ icon = "$($p.DisplayIcon)"; uninst = "$($p.UninstallString)" }
    }
  }
}
foreach ($proto in @('workbuddy', 'workbuddyai', 'codebuddy')) {
  foreach ($hive in @('HKCU:\Software\Classes', 'HKLM:\Software\Classes')) {
    $cmd = (Get-ItemProperty "$hive\$proto\shell\open\command").'(default)'
    if ($cmd) { $out.reg += @{ cmd = "$cmd" } }
  }
}
foreach ($hive in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\App Paths', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\App Paths')) {
  Get-ChildItem $hive | Where-Object { $_.PSChildName -match 'WorkBuddy|CodeBuddy' } | ForEach-Object {
    $d = (Get-ItemProperty $_.PSPath).'(default)'
    if ($d) { $out.reg += @{ cmd = "$d" } }
  }
}
[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($out | ConvertTo-Json -Depth 5 -Compress)))
`;

/**
 * PowerShell 5.1 的 ConvertTo-Json 会把**单元素数组退化成标量**（`["a"]` 输出成
 * `"a"`）。单客户端机器上 procs / reg 恰好可能只有一个元素 —— 不归一化就会在
 * `for...of` 里遍历字符串的字符。一律先过数组。
 */
const wbAsArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);

/** 从信号里提取客户端 exe：exe 名直接认；卸载器/图标路径取所在目录再找本体。 */
function wbExtractExePaths(signal) {
  const out = [];
  const push = (p) => {
    const v = String(p || '').trim();
    if (v && !out.includes(v)) out.push(v);
  };
  const baseOf = (p) => String(p || '').split(/[\\/]/).pop() || '';
  for (const p of wbAsArray(signal?.procs)) {
    if (WB_EXE_NAME_RE.test(baseOf(p))) push(p);
  }
  for (const rec of wbAsArray(signal?.reg)) {
    // 三个字段都要尝试（而非短路取值）：icon 可能指向无关程序甚至系统图标，
    // 此时 uninst（卸载器路径）是唯一线索。
    for (const raw of [rec.icon, rec.uninst, rec.cmd]) {
      const m = /([A-Za-z]:\\[^"]*?\.exe)/i.exec(String(raw || ''));
      if (!m) continue;
      const exe = m[1];
      if (WB_EXE_NAME_RE.test(baseOf(exe))) {
        push(exe);
        continue;
      }
      const hit = wbExeInDir(dirname(exe)); // 卸载器与客户端同目录
      if (hit) push(hit);
    }
  }
  return out;
}

/** 系统信号兜底（Windows）。成功缓存；失败 2 分钟内不重试；任何异常静默返回 []。 */
async function wbProbeSystemSignals() {
  if (wbSysHits && wbSysHits.some((p) => existsSync(p))) return wbSysHits;
  wbSysHits = null; // 陈旧：命中都已不存在 → 允许重探（由防抖限制频率）
  if (process.platform !== 'win32') return [];
  if (Date.now() - wbSysProbeAt < WB_SYS_PROBE_MIN_INTERVAL_MS) return [];
  wbSysProbeAt = Date.now();

  let signal;
  try {
    const res = await runChild(wbPowershellPath(), ['-NoProfile', '-NonInteractive', '-Command', WB_SYS_PROBE_SCRIPT], {
      timeout: 20000,
      maxBuffer: 1048576,
    });
    if (res.error || res.code !== 0 || !res.stdout) return [];
    signal = JSON.parse(Buffer.from(String(res.stdout).replace(/\s+/g, ''), 'base64').toString('utf8'));
  } catch {
    return [];
  }
  const hits = wbExtractExePaths(signal).filter((p) => existsSync(p));
  if (hits.length) wbSysHits = hits;
  return hits;
}

/**
 * 首个存在的客户端 exe；全部落空返回 ''。成功结果缓存，缓存失效自动重探。
 * 先便宜的（静态 + 扫描），全落空才动 PowerShell 兜底。
 */
async function resolveWorkBuddyExe() {
  if (wbExeCache && existsSync(wbExeCache)) return wbExeCache;
  wbExeCache = '';
  if (Date.now() - wbMissAt < WB_MISS_RETRY_MS) return '';
  let hit = workBuddyStaticCandidates().find((p) => existsSync(p));
  if (!hit) hit = workBuddyExeCandidates().find((p) => existsSync(p));
  if (!hit) hit = (await wbProbeSystemSignals()).find((p) => existsSync(p));
  if (hit) {
    wbExeCache = hit;
    return hit;
  }
  wbMissAt = Date.now();
  return '';
}

/** Length-prefixed UTF-8 string: uint32 big-endian length then the bytes. */
function encodeLengthPrefixed(value) {
  const bytes = Buffer.from(value, 'utf8');
  const len = Buffer.allocUnsafe(4);
  len.writeUInt32BE(bytes.length);
  return Buffer.concat([len, bytes]);
}

/** Additional authenticated data for a FIELD-framed sym-v1 envelope. */
function atRestFieldAad(keyId, suite) {
  const suiteBytes = Buffer.allocUnsafe(4);
  suiteBytes.writeUInt32BE(suite);
  return Buffer.concat([
    ATREST_AAD_DOMAIN,
    Buffer.from([1]),
    encodeLengthPrefixed('WBEV1'),
    encodeLengthPrefixed('sym-v1'),
    suiteBytes,
    encodeLengthPrefixed(keyId),
    Buffer.from([2]),
    Buffer.from([0]),
    Buffer.from([0]),
  ]);
}

/** keyId of a derived field key — same truncation the envelopes use. */
function atRestKeyId(key) {
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

/** Envelope keyId carried by an encrypted field ('' for plaintext / malformed). */
function fieldKeyIdOf(value) {
  if (!isEncryptedField(value)) return '';
  try {
    return JSON.parse(Buffer.from(value.envelope, 'base64').toString('utf8')).keyId || '';
  } catch {
    return '';
  }
}

/** 从某个 exe 取一次密钥载荷；失败返回 { error }。按 exe 缓存 Promise（并发合并）。 */
const keyPayloadCache = new Map();
async function fetchKeyPayloadFrom(exe) {
  const slot = String(exe || '');
  const cached = keyPayloadCache.get(slot);
  if (cached) return cached;
  const pending = (async () => {
    const script =
      "try{process.stdout.write(process._linkedBinding('electron_browser_workbuddy_storage').loggerGet())}"
      + 'catch(e){process.exitCode=3;process.stderr.write(String((e&&e.message)||e))}';
    // stdin 必须忽略：Electron 二进制在 stdin 开管道时会 EBUSY（runChild 默认 ignore）。
    const res = await runChild(exe, ['-e', script], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      timeout: 20000,
      maxBuffer: 1048576,
    });
    if (res.error) return { error: res.error.message };
    if (res.code !== 0) {
      return { error: `exit ${res.code}: ${String(res.stderr || '').trim()}` };
    }
    try {
      const secret = JSON.parse(res.stdout).atRestSecretKey;
      if (typeof secret !== 'string' || secret === '') {
        return { error: 'payload carries no atRestSecretKey' };
      }
      return { secret };
    } catch (err) {
      return { error: `unparsable payload: ${String((err && err.message) || err)}` };
    }
  })();
  keyPayloadCache.set(slot, pending);
  const result = await pending;
  if (!result.secret) keyPayloadCache.delete(slot); // 失败不缓存，下次仍可重试
  return result;
}

/**
 * The 32-byte field key, derived from the app's own key payload.
 *
 * 机器上可能并存多个 WorkBuddy build（如国内版 WorkBuddyAI.exe 与国际版
 * WorkBuddy.exe）——它们的 atRestSecretKey 不同，只有"写登录文件的那个"能
 * 解开信封。所以按登录文件里信封的 keyId 逐个候选试，命中即用；一个都不
 * 匹配时退回第一个能取到密钥的，让 openAuthField 给出准确的 keyId 报错。
 */
async function atRestKey() {
  if (atRestKeyCache) return atRestKeyCache;
  if (atRestKeyPending) return atRestKeyPending;
  atRestKeyPending = (async () => {
    let candidates = workBuddyExeCandidates().filter((p) => existsSync(p));
    // 廉价层全 miss 才动 PowerShell 兜底（系统信号：进程 + 注册表）
    if (candidates.length === 0) candidates = (await wbProbeSystemSignals()).filter((p) => existsSync(p));
    if (candidates.length === 0) {
      throw new Error(
        'key fetch failed: WorkBuddy 客户端可执行文件未找到'
        + '（已探测默认安装位置并扫描常见目录）。'
        + '若客户端装在非常规目录，请在 .env 设置 WORKBUDDY_APP_EXECUTABLE 指向其 WorkBuddy.exe',
      );
    }
    const failures = [];
    let fallback;
    for (const exe of candidates) {
      const { secret, error } = await fetchKeyPayloadFrom(exe);
      if (!secret) {
        failures.push(`${exe} -> ${error}`);
        continue;
      }
      // The app hashes the base64 STRING, not its decoded bytes.
      const key = createHash('sha256').update(secret, 'utf8').digest();
      if (!wantedKeyId || atRestKeyId(key) === wantedKeyId) {
        atRestKeyCache = key;
        atRestUsedExe = exe;
        return key;
      }
      if (!fallback) fallback = { key, exe }; // 可能不是写登录文件的那个 build：先留着
    }
    if (fallback) {
      atRestKeyCache = fallback.key;
      atRestUsedExe = fallback.exe;
      return fallback.key;
    }
    throw new Error(`key fetch failed from all ${candidates.length} candidate(s): ${failures.join(' | ')}`);
  })();
  try {
    return await atRestKeyPending;
  } finally {
    atRestKeyPending = null;
  }
}

/** Whether a value is the app's encrypted-field wrapper. */
function isEncryptedField(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  return keys.length === 2 && keys[0] === '$wbEncrypted' && keys[1] === 'envelope'
    && value.$wbEncrypted === 1 && typeof value.envelope === 'string';
}

/** Plaintext of an auth field, transparently opening the 5.6+ envelope. */
async function openAuthField(value, label) {
  if (typeof value === 'string') return value; // pre-5.6 plaintext, or a refreshed value
  if (!isEncryptedField(value)) return '';
  const envelope = JSON.parse(Buffer.from(value.envelope, 'base64').toString('utf8'));
  const key = await atRestKey();
  const expected = createHash('sha256').update(key).digest('hex').slice(0, 16);
  if (envelope.keyId !== expected) {
    throw new Error(`${label} was sealed under key ${envelope.keyId}, not ${expected};`
      + ' is this the desktop build that wrote the login file?');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.nonce, 'base64'), { authTagLength: 16 });
  decipher.setAAD(atRestFieldAad(envelope.keyId, envelope.suite));
  decipher.setAuthTag(Buffer.from(envelope.authTag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

/**
 * 按登录域名选择上游网关。
 *
 * 国际版与国内版是**不同的网关**，用错会直接 401：
 *   workbuddy.ai / workbuddy.cc  →  https://www.workbuddy.ai
 *   国内版（默认）                →  https://copilot.tencent.com
 *
 * 原实现只判断 `codebuddy.ai`，于是 `www.workbuddy.ai` 落到了国内网关——
 * 只有存在国际版账号（多账号切换）时才会暴露。
 */
function pickUpstream(domain) {
  const d = String(domain || '');
  if (d.includes('workbuddy.ai') || d.includes('workbuddy.cc')) return 'https://www.workbuddy.ai';
  if (d.includes('codebuddy.ai')) return 'https://www.codebuddy.ai';
  return 'https://copilot.tencent.com';
}

// ── Auth: read the local desktop session ─────────────────────────────────
/**
 * 登录文件解析缓存：`{ mtimeMs, size, auth }`。
 *
 * 每个模型请求（以及控制台每 8 秒一次的 /health）都要读一次登录文件，再做
 * AES-256-GCM 解密与 JWT 解码 —— 单次只有几毫秒，但它在**请求关键路径**上，
 * 而且内容几乎从不变。用 stat 指纹判新旧：桌面端刷新令牌 / 换账号会原子替换
 * 文件，mtime 与（通常）size 都会变，下次调用自然重读。
 *
 * 读失败（文件被换走、权限问题）不缓存，保持原先"每次都能自愈"的行为。
 */
let authFileCache = null;

/** 读取某个登录文件里的账号 uid（只解密 accessToken，不缓存全量 auth）。 */
async function fileAccountUid(path) {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  const field = raw?.auth?.accessToken;
  if (!field) return '';
  const token = await openAuthField(field, 'accessToken');
  return decodeJwt(token).sub || '';
}

/**
 * 桌面端换号检测：只做 stat + （文件变了才）解密 accessToken。
 *
 * 热路径上每个请求会多一次 stat（微秒级）；文件没变就直接用上次结论。
 * 解密失败（另一个 build 写的信封 / 文件正在替换）时**不切换**，保持原位。
 */
async function syncAuthPathFollow() {
  const followPath = AUTH_FILE_FOLLOW;
  if (!followPath || followPath === AUTH_PINNED_PATH) return;
  let stat;
  try {
    stat = statSync(followPath);
  } catch {
    authFollowProbe.error = 'missing';
    /*
     * 正在跟随桌面文件时它被删掉（客户端登出/换号中间态）：不能继续拿一个
     * 不存在的路径读令牌。回到用户钉住的快照；若快照也没了，下一次读取会
     * 如实报“登录文件不存在”，而不是把旧 AUTH_PATH 留在内存里。
     */
    if (AUTH_PATH !== AUTH_PINNED_PATH) {
      AUTH_PATH = AUTH_PINNED_PATH;
      memoryAuth = null;
      authFileCache = null;
      invalidateCatalogCache();
      log('desktop auth file disappeared; falling back to pinned file');
    }
    return;
  }
  if (authFollowProbe.path === followPath
    && authFollowProbe.mtimeMs === stat.mtimeMs
    && authFollowProbe.size === stat.size) {
    // 结论已缓存，直接按上次结果执行下方切换
  } else {
    let uid = '';
    let error = '';
    try { uid = await fileAccountUid(followPath); }
    catch (e) { error = String(e?.message || e).slice(0, 160); }
    Object.assign(authFollowProbe, {
      path: followPath, mtimeMs: stat.mtimeMs, size: stat.size, uid, error,
    });
    if (error) log('auth follow file is unreadable; keeping the pinned account', error);
  }
  const followUid = authFollowProbe.uid;
  if (!followUid) return;
  let shouldFollow = false;
  if (AUTH_FOLLOW_UID) {
    shouldFollow = followUid !== AUTH_FOLLOW_UID;
  } else {
    // 旧控制台只写了 authFile：以钉住文件里的账号为基准迁移一次。
    let pinnedUid = '';
    try {
      const st = statSync(AUTH_PINNED_PATH);
      if (authPinnedProbe.mtimeMs !== st.mtimeMs || authPinnedProbe.size !== st.size) {
        authPinnedProbe.uid = await fileAccountUid(AUTH_PINNED_PATH);
        authPinnedProbe.mtimeMs = st.mtimeMs;
        authPinnedProbe.size = st.size;
      }
      pinnedUid = authPinnedProbe.uid;
    } catch { /* 读不出就跟随桌面 */ }
    shouldFollow = !pinnedUid || followUid !== pinnedUid;
  }
  if (shouldFollow && AUTH_PATH !== followPath) {
    AUTH_PATH = followPath;
    memoryAuth = null;
    authFileCache = null;
    // 目录属于账号：换号后旧目录的模型/倍率/官方标记都不再成立。
    invalidateCatalogCache();
    log('desktop switched account; following', followPath);
  } else if (!shouldFollow && AUTH_PATH !== AUTH_PINNED_PATH) {
    AUTH_PATH = AUTH_PINNED_PATH;
    memoryAuth = null;
    authFileCache = null;
    invalidateCatalogCache();
    log('desktop account restored; using pinned auth file', AUTH_PINNED_PATH);
  }
}

/**
 * 桌面端换号时，把来源从 plugin 带回桌面。
 *
 * 真实场景：用户以前用浏览器登录过插件账号（来源因此固定为 plugin），
 * 后来在 WorkBuddy 客户端里换号。旧实现只让 desktop 来源跟随，于是面板
 * 显示旧账号/旧余额，桌面登录文件却是新账号 —— issue #6 的「账号是新的、
 * 积分是旧的」。
 *
 * 规则：**客户端换号是更新的用户意图**，桥跟随桌面；用户若随后在面板里
 * 主动选回「仅插件登录」，记下当前桌面 UID，不再反复抢回来。桌面下一次
 * 换号时再跟随。环境变量锁定来源时永远不抢。
 *
 * 只在 AUTH_FOLLOW_UID（钉住那一刻的桌面账号）与当前桌面账号不同的时候
 * 触发；单纯令牌刷新（UID 不变）不会改变来源。
 */
let adoptedDesktopFollowUid = '';
const authAdoptProbe = { path: '', mtimeMs: -1, size: -1, uid: '', error: '' };
async function probeAuthFileUid(path) {
  if (!path) return '';
  const probe = path === AUTH_FILE_FOLLOW ? authFollowProbe : authAdoptProbe;
  try {
    const st = statSync(path);
    if (probe.path === path
      && probe.mtimeMs === st.mtimeMs
      && probe.size === st.size) {
      return probe.uid;
    }
    const uid = await fileAccountUid(path);
    Object.assign(probe, {
      path, mtimeMs: st.mtimeMs, size: st.size, uid, error: '',
    });
    return uid;
  } catch (e) {
    probe.error = String(e?.message || e).slice(0, 160);
    return '';
  }
}

/** 没有钉住快照时，插件来源也能跟随“客户端自己的默认登录文件”。 */
function pluginFollowPath() {
  const follow = AUTH_FILE_FOLLOW;
  if (follow) return follow;
  const candidate = defaultAuthPath();
  const norm = (p) => String(p || '').replace(/\\/g, '/').toLowerCase();
  // 显式 WORKBUDDY_AUTH_FILE 指向别的快照时，不越过用户的显式选择
  return norm(AUTH_PINNED_PATH) === norm(candidate) ? candidate : '';
}

async function probeFollowUidForAdopt() {
  return probeAuthFileUid(pluginFollowPath());
}

let adoptInflight = null;
/**
 * 单飞：启动时目录刷新与 /health 会并发调用这里。两次调用如果各跑一遍，
 * 后一次可能在前一次已经把来源改成 desktop 之后又按“没有基线”写回 plugin
 * （source.json 实测被这样来回覆盖）。并发调用必须共享同一个结论。
 */
async function adoptDesktopAfterPluginSwitch() {
  if (adoptInflight) return adoptInflight;
  const task = adoptDesktopAfterPluginSwitchOnce();
  adoptInflight = task;
  try {
    return await task;
  } finally {
    if (adoptInflight === task) adoptInflight = null;
  }
}

async function adoptDesktopAfterPluginSwitchOnce() {
  if (CREDENTIAL_SOURCE_PINNED) return false;
  const followPath = pluginFollowPath();
  if (!followPath) return false;
  if ((await effectiveSource()) !== 'plugin') return false;
  const followUid = await probeAuthFileUid(followPath);
  if (!followUid) return false;
  if (adoptedDesktopFollowUid === followUid) return false;
  /*
   * 基线 = 「用户选择插件登录时，桌面端是哪个账号」。
   *   - 钉住过快照：`.state.json` 记录了那一刻的桌面 UID；
   *   - 新版本登录/切换来源：source.json 记录了 desktopUid；
   *   - 老 source.json 没有基线：用桌面文件与 source.json 的写入时间判断 ——
   *     桌面文件在「选择插件」之后被重写，说明客户端换号（或最近一次使用
   *     是桌面端）是更新的意图，跟随桌面；否则保留插件来源并补记基线。
   *     这样升级后第一次就能跟上用户刚在客户端做的换号，而不是再等一次。
   */
  let baseline = credentialSourceMeta.desktopUid;
  /*
   * 老 source.json 有 updatedAt 但没有 desktopUid：选择时刻比 .state.json 的
   * 钉住时刻更可靠，走下面的时间比较；连 updatedAt 都没有的远古文件才退回
   * 钉住时的桌面 UID。
   */
  if (!baseline && !credentialSourceMeta.updatedAt) baseline = AUTH_FOLLOW_UID;
  if (!baseline) {
    let desktopIsNewer = !credentialSourceMeta.updatedAt;
    try {
      const st = statSync(followPath);
      desktopIsNewer = !credentialSourceMeta.updatedAt || st.mtimeMs > credentialSourceMeta.updatedAt;
    } catch { /* 桌面文件读不到：保持插件来源 */ }
    if (!desktopIsNewer) {
      // 结论可能已被并发调用改写；只有来源仍是 plugin 时才补记基线
      if ((await effectiveSource()) === 'plugin') {
        try { await setSourcePreference('plugin'); } catch { /* 写不了就仅进程内记住 */ }
      }
      return false;
    }
    log('plugin source had no desktop baseline; desktop login is newer, following desktop');
  } else if (String(followUid) === String(baseline)) {
    return false;
  }
  /*
   * 先占住“已跟随这个 UID”：即使 setSourcePreference 内部有 await，
   * 其他路径看到同一个桌面账号时也不会重复进入跟随分支。
   */
  adoptedDesktopFollowUid = String(followUid);
  try {
    await setSourcePreference('desktop');
  } catch (e) {
    adoptedDesktopFollowUid = '';
    throw e;
  }
  memoryAuth = null;
  authFileCache = null;
  invalidateCatalogCache();
  log('desktop account switched; following desktop instead of the plugin credential', followUid);
  return true;
}

async function readStoredAuth() {
  // 先确认"桌面端是否换号"：换号后必须立刻改读桌面登录文件，
  // 否则下面 memoryAuth/authFileCache 会继续供旧账号（issue #6）。
  await syncAuthPathFollow();
  /** 重读前的身份：同一个文件内容被换号时，也要让账号相关的目录缓存失效。 */
  const previousAuth = memoryAuth || authFileCache?.auth || null;
  /*
   * 刷新出的内存令牌可以比文件新，但**不能越过文件里的账号切换**：
   * 桌面端换号会原子替换 auth 文件，此时必须立刻丢掉旧 memoryAuth，
   * 否则桥会继续用旧账号令牌（旧钱包）直到过期，甚至在全量 401 后才自愈。
   */
  if (memoryAuth) {
    let fileChanged = false;
    try {
      const st = statSync(AUTH_PATH);
      fileChanged = memoryAuth.authFileMtimeMs !== st.mtimeMs || memoryAuth.authFileSize !== st.size;
    } catch {
      fileChanged = true;
    }
    if (fileChanged) {
      memoryAuth = null;
      authFileCache = null;
    } else if (Date.now() < memoryAuth.expiresAt - REFRESH_SKEW_MS) {
      return memoryAuth;
    }
  }
  const stat = statSync(AUTH_PATH);
  if (authFileCache && authFileCache.mtimeMs === stat.mtimeMs && authFileCache.size === stat.size) {
    return authFileCache.auth;
  }
  const raw = JSON.parse(readFileSync(AUTH_PATH, 'utf8'));
  const auth = raw.auth || {};
  if (!auth.accessToken) throw new Error('login file has no accessToken; sign in to the WorkBuddy desktop app first');
  // 密钥选择以本文件为基准：机器上多客户端并存时，优先用"写这份登录文件的
  // build"。文件被另一个 build 重写过 → 已缓存的密钥失效，重新挑。
  wantedKeyId = fieldKeyIdOf(auth.accessToken) || fieldKeyIdOf(auth.refreshToken) || '';
  if (wantedKeyId && atRestKeyCache && atRestKeyId(atRestKeyCache) !== wantedKeyId) {
    atRestKeyCache = undefined;
  }
  const access = await openAuthField(auth.accessToken, 'accessToken');
  const refresh = await openAuthField(auth.refreshToken, 'refreshToken');
  const claims = decodeJwt(access);
  const domain = auth.domain || claims.iss || '';
  const endpoint = EXPLICIT_ENDPOINT || pickUpstream(domain);
  const result = {
    source: 'desktop',
    access,
    refresh,
    expiresAt: Number(auth.expiresAt || claims.exp * 1000 || 0),
    refreshExpiresAt: Number(auth.refreshExpiresAt || 0),
    userId: claims.sub || '',
    enterpriseId: claims.enterprise_id || '',
    tenantId: claims.tenant_id || claims.tenant || '',
    endpoint,
    domain,
  };
  /*
   * 同一个登录文件被客户端原地换号时，路径没变、`syncAuthPathFollow` 也可能
   * 因为 followPath === AUTH_PATH 而不走“切换路径”分支。目录属于账号：
   * 身份或区域变了就必须作废，否则模型/倍率/思考档位会继续用上一个账号的。
   */
  if (previousAuth && (
    String(previousAuth.userId || '') !== String(result.userId || '')
    || String(previousAuth.endpoint || '') !== String(result.endpoint || '')
    || String(previousAuth.domain || '') !== String(result.domain || '')
  )) {
    invalidateCatalogCache();
    log('desktop login identity changed; catalog invalidated',
      `${previousAuth.userId || '?'} -> ${result.userId || '?'}`);
  }
  authFileCache = { mtimeMs: stat.mtimeMs, size: stat.size, auth: result };
  return result;
}

function decodeJwt(token) {
  try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')); }
  catch { return {}; }
}

// ── Plugin-owned credentials: DPAPI + AES-256-GCM store ──────────────────
/*
 * 第二条凭据来源：不读桌面端登录文件，由本桥自己走 OAuth 设备码登录。
 * 令牌是**我们自己的**，所以必须落盘（否则桥一重启就要重登），也就必须加密：
 *
 *   store.key   32 字节随机密钥，由 Windows DPAPI（CurrentUser）保护
 *   <sha256(uid)>.cred  AES-256-GCM 信封（AAD 绑定 uid）
 *   active.json 当前 active 的账号（非机密）
 *
 * 换机器 / 换 Windows 用户 → DPAPI 解不开 store.key → 凭据不可用。
 * DPAPI 不可用时**绝不静默写明文**：退回进程内内存，诊断里如实说明。
 * 注意：这防的是"文件被拷走"，不防同用户的恶意进程（它也能调 DPAPI / 读内存）。
 */
const CREDENTIAL_SOURCE_ENV = (() => {
  const raw = String(process.env.WORKBUDDY_CREDENTIAL_SOURCE || '').trim().toLowerCase();
  return ['auto', 'desktop', 'plugin', 'api-key'].includes(raw) ? raw : '';
})();
/**
 * `auto` 是**软默认**，不是锁：它表示"按运行时/持久化选择，默认桌面优先"。
 * 只有显式写 desktop / plugin / api-key 才锁定（UI 的切换会被拒绝）。
 * 这样 `.env` 里留着 `WORKBUDDY_CREDENTIAL_SOURCE=auto` 不会让"插件登录成功"
 * 变成"登录了但永远不生效"。
 */
const CREDENTIAL_SOURCE_PINNED = CREDENTIAL_SOURCE_ENV !== '' && CREDENTIAL_SOURCE_ENV !== 'auto';
/**
 * 鉴权失败时的另一条凭据接管策略：
 *   same-account（默认）—— 只有两边是**同一账号**才自动接管（钱包不变，安全）；
 *   any                  —— 任意账号都接管（会切换账号/钱包，显式 opt-in）；
 *   off                  —— 不接管，按原样报错。
 */
const CREDENTIAL_FAILOVER = (() => {
  const raw = String(process.env.WORKBUDDY_CREDENTIAL_FAILOVER || '').trim().toLowerCase();
  return ['off', 'same-account', 'any'].includes(raw) ? raw : 'same-account';
})();
/** 未用 env 锁定时的运行时选择（登录成功后切到 plugin，面板可切回）。 */
let credentialSourcePreference = null;
/**
 * source.json 里除 `source` 之外的元数据：
 *   - `desktopUid`：选择插件登录那一刻桌面端的账号（换号基线）；
 *   - `updatedAt`：选择时刻（诊断用）。
 */
let credentialSourceMeta = { desktopUid: '', updatedAt: 0 };
const CREDENTIAL_STORE_MODE = (() => {
  const raw = String(process.env.WORKBUDDY_CREDENTIAL_STORE || '').trim().toLowerCase();
  if (raw === 'memory' || raw === 'dpapi') return raw;
  return process.platform === 'win32' ? 'dpapi' : 'memory';
})();
const CREDENTIAL_DIR = (() => {
  const raw = String(process.env.WORKBUDDY_CREDENTIAL_DIR || '').trim();
  if (raw) return isAbsolute(raw) ? raw : join(process.cwd(), raw);
  return join(RUNTIME_DATA_DIR, 'credentials');
})();

/** DPAPI 失败后的进程内回退原因（空串 = 未回退）。 */
let credentialStoreFallback = '';
/** 进程内凭据（memory 模式 / DPAPI 回退时使用）。 */
const memoryCredentials = new Map();
let memoryActiveUid = '';
/** store.key 与 active 凭据的进程内缓存。 */
let credentialKey = null;
let credentialKeyPrint = '';
let credentialKeyPending = null; // 并发首次建钥合并：否则两个请求可能各写一把，先写的凭据再也解不开
let pluginAuthCache = { file: '', uid: '', mtimeMs: -1, size: -1, auth: null };
function invalidatePluginAuthCache() {
  pluginAuthCache = { file: '', uid: '', mtimeMs: -1, size: -1, auth: null };
}
let credentialLockTail = Promise.resolve();

const credentialStoreMode = () => (credentialStoreFallback ? 'memory' : CREDENTIAL_STORE_MODE);
const credentialFileFor = (uid) => join(CREDENTIAL_DIR, `${createHash('sha256').update(String(uid), 'utf8').digest('hex').slice(0, 24)}.cred`);
const credentialActiveFile = () => join(CREDENTIAL_DIR, 'active.json');
const credentialSourceFile = () => join(CREDENTIAL_DIR, 'source.json');
const VALID_SOURCES = new Set(['auto', 'desktop', 'plugin', 'api-key']);

/** env 优先；否则用运行时/持久化的选择；都没有 = auto。 */
async function effectiveSource() {
  if (CREDENTIAL_SOURCE_PINNED) return CREDENTIAL_SOURCE_ENV;
  if (credentialSourcePreference !== null) return credentialSourcePreference || 'auto';
  let stored = '';
  try {
    const parsed = JSON.parse(readFileSync(credentialSourceFile(), 'utf8'));
    if (VALID_SOURCES.has(parsed?.source)) stored = parsed.source;
    credentialSourceMeta = {
      desktopUid: typeof parsed?.desktopUid === 'string' ? parsed.desktopUid : '',
      updatedAt: Date.parse(parsed?.updatedAt) || 0,
    };
  } catch { /* 没有就是 auto */ }
  /*
   * 上次选了 plugin，但凭据已经不存在（memory 模式重启 / 被手动删掉）：
   * 继续按 plugin 只会让每个请求都报"没有插件凭据"。回到 auto，桌面端可用时照常服务；
   * 诊断里仍能看到 source.json 的内容，不会假装没发生过。
   */
  if (stored === 'plugin' && (await readAllPluginCredentials()).length === 0) {
    log('stored source=plugin but no readable plugin credential; falling back to auto');
    stored = '';
  }
  credentialSourcePreference = stored;
  return stored || 'auto';
}

async function setSourcePreference(source) {
  const value = String(source || '').trim().toLowerCase();
  if (!VALID_SOURCES.has(value)) throw new Error(`source must be one of ${[...VALID_SOURCES].join(', ')}`);
  if (CREDENTIAL_SOURCE_PINNED) throw new Error(`credential source is pinned by WORKBUDDY_CREDENTIAL_SOURCE=${CREDENTIAL_SOURCE_ENV}`);
  if (value === 'plugin' && (await readAllPluginCredentials()).length === 0) {
    throw new Error(pluginCredentialError
      ? `plugin credentials are unreadable: ${pluginCredentialError}`
      : 'no plugin credential yet; sign in first');
  }
  credentialSourcePreference = value;
  /*
   * 用户在面板里主动选「仅插件登录」：记住**当前桌面账号**作为换号基线，
   * 避免下一次请求又被自动抢回桌面；桌面下一次换号仍会跟随。
   */
  let desktopUid = '';
  if (value === 'plugin') {
    adoptedDesktopFollowUid = await probeFollowUidForAdopt();
    desktopUid = adoptedDesktopFollowUid || '';
  }
  credentialSourceMeta = { desktopUid, updatedAt: Date.now() };
  // 来源变了 → 账号/区域可能也变了，模型目录必须重取（后台，不阻塞本请求）。
  invalidateCatalogCache();
  if (credentialStoreMode() === 'memory') return;
  try {
    await withCredentialLock(async () => {
      ensureCredentialDir();
      writeFileAtomic(credentialSourceFile(), JSON.stringify({
        source: value,
        updatedAt: new Date().toISOString(),
        ...(desktopUid ? { desktopUid } : {}),
      }, null, 2), 0o600);
    });
  } catch (e) {
    // 持久化失败不影响本次进程内的选择（下次启动回到 auto）
    log('credential source preference not persisted', shortError(e?.message || e, 160));
  }
}
const credentialKeyFile = () => join(CREDENTIAL_DIR, 'store.key');
const credentialLockFile = () => join(CREDENTIAL_DIR, '.lock');
const credentialAad = (uid) => Buffer.from(`workbuddy-credential\0${uid}\0v1`, 'utf8');

function ensureCredentialDir() {
  mkdirSync(CREDENTIAL_DIR, { recursive: true, mode: 0o700 });
  try { chmodSync(CREDENTIAL_DIR, 0o700); } catch { /* Windows 上大多无效，尽力而为 */ }
}

function writeFileAtomic(file, text, mode = 0o600) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, text, { mode });
  try { chmodSync(tmp, mode); } catch { /* 同上 */ }
  renameSync(tmp, file);
}

/** DPAPI 调用的 PowerShell 脚本：密钥走 stdin，绝不进命令行（进程列表可见）。 */
async function dpapiCall(verb, inputBase64) {
  if (process.platform !== 'win32') throw new Error('DPAPI is only available on Windows');
  const script = 'Add-Type -AssemblyName System.Security; '
    + '$in=[Console]::In.ReadToEnd().Trim(); $b=[Convert]::FromBase64String($in); '
    + `$p=[Security.Cryptography.ProtectedData]::${verb}($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); `
    + '[Console]::Out.Write([Convert]::ToBase64String($p))';
  const res = await runChild(wbPowershellPath(), ['-NoProfile', '-NonInteractive', '-Command', script], {
    input: inputBase64,
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 20000,
    maxBuffer: 1024 * 1024,
  });
  if (res.error) throw new Error(`DPAPI ${verb} failed: ${res.error.message}`);
  if (res.code !== 0) {
    throw new Error(`DPAPI ${verb} failed: exit ${res.code} ${String(res.stderr || '').trim().slice(0, 200)}`);
  }
  const out = String(res.stdout || '').trim();
  if (!out) throw new Error(`DPAPI ${verb} returned empty output`);
  return out;
}

const dpapiProtect = (buffer) => dpapiCall('Protect', buffer.toString('base64'));
const dpapiUnprotect = async (base64) => Buffer.from(await dpapiCall('Unprotect', base64), 'base64');

/** 取/建字段密钥；失败**不静默明文**，由调用方回退到 memory。 */
async function loadOrCreateCredentialKey() {
  if (credentialKey) return credentialKey;
  if (credentialKeyPending) return credentialKeyPending;
  credentialKeyPending = (async () => {
    ensureCredentialDir();
    const file = credentialKeyFile();
    if (existsSync(file)) {
      const st = statSync(file);
      const print = `${st.mtimeMs}:${st.size}`;
      if (credentialKey && credentialKeyPrint === print) return credentialKey;
      let blob;
      try { blob = readFileSync(file, 'utf8').trim(); }
      catch (e) { throw new Error(`cannot read credential key: ${e.message}`, { cause: e }); }
      try { credentialKey = await dpapiUnprotect(blob); }
      catch (e) { throw new Error(`credential key cannot be opened on this machine/user: ${e.message}`, { cause: e }); }
      credentialKeyPrint = print;
      return credentialKey;
    }
    const key = randomBytes(32);
    const blob = await dpapiProtect(key);
    writeFileAtomic(file, blob, 0o600);
    credentialKey = key;
    const st = statSync(file);
    credentialKeyPrint = `${st.mtimeMs}:${st.size}`;
    return key;
  })();
  try {
    return await credentialKeyPending;
  } finally {
    credentialKeyPending = null;
  }
}

async function sealCredential(cred) {
  const key = await loadOrCreateCredentialKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(credentialAad(cred.uid));
  const data = Buffer.concat([cipher.update(JSON.stringify(cred), 'utf8'), cipher.final()]);
  return JSON.stringify({
    v: 1,
    alg: 'aes-256-gcm',
    uid: cred.uid,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  });
}

async function openCredential(text) {
  const env = JSON.parse(text);
  if (!env || env.v !== 1 || env.alg !== 'aes-256-gcm' || typeof env.uid !== 'string' || !env.uid) {
    throw new Error('unsupported credential envelope');
  }
  const key = await loadOrCreateCredentialKey();
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(env.iv, 'base64'), { authTagLength: 16 });
  decipher.setAAD(credentialAad(env.uid));
  decipher.setAuthTag(Buffer.from(env.tag, 'base64'));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(env.data, 'base64')),
    decipher.final(),
  ]).toString('utf8');
  const cred = JSON.parse(plain);
  if (String(cred.uid) !== env.uid) throw new Error('credential envelope uid mismatch');
  return cred;
}

/** 跨进程刷新锁：同一凭据目录只允许一个刷新/写入者。 */
async function acquireCredentialLock() {
  ensureCredentialDir();
  const file = credentialLockFile();
  const deadline = Date.now() + 8000;
  for (;;) {
    try {
      const fd = openSync(file, 'wx');
      try { writeFileSync(fd, String(process.pid)); } finally { closeSync(fd); }
      return () => { try { unlinkSync(file); } catch { /* 已被清理 */ } };
    } catch (e) {
      const code = /** @type {{ code?: string, mtimeMs?: number }} */ (e).code;
      if (code !== 'EEXIST') throw e;
      try {
        const st = statSync(file);
        if (Date.now() - st.mtimeMs > 15000) { unlinkSync(file); continue; } // 崩溃遗留
      } catch { /* 锁刚被释放 */ }
      if (Date.now() > deadline) throw new Error('credential store is locked by another process', { cause: e });
      await sleep(60);
    }
  }
}

async function withCredentialLock(fn) {
  const run = credentialLockTail.then(async () => {
    const release = await acquireCredentialLock();
    try { return await fn(); } finally { release(); }
  });
  credentialLockTail = run.catch(() => {});
  return run;
}

function writeActiveUid(uid) {
  if (credentialStoreMode() === 'memory') { memoryActiveUid = uid; return; }
  ensureCredentialDir();
  writeFileAtomic(credentialActiveFile(), JSON.stringify({ uid, updatedAt: new Date().toISOString() }, null, 2), 0o600);
}

function readActiveUid() {
  if (credentialStoreMode() === 'memory') return memoryActiveUid;
  try {
    const parsed = JSON.parse(readFileSync(credentialActiveFile(), 'utf8'));
    return typeof parsed.uid === 'string' ? parsed.uid : '';
  } catch { return ''; }
}

/** 写入一条插件凭据；返回 `{stored:'dpapi'|'memory', degraded?:true, reason?}`。 */
async function savePluginCredential(cred) {
  const uid = String(cred.uid || '').trim();
  if (!uid) throw new Error('credential has no uid');
  const record = { ...cred, uid, updatedAt: new Date().toISOString() };
  if (credentialStoreMode() === 'memory') {
    memoryCredentials.set(uid, record);
    memoryActiveUid = uid;
    invalidatePluginAuthCache();
    return { stored: 'memory' };
  }
  try {
    return await withCredentialLock(async () => {
      ensureCredentialDir();
      writeFileAtomic(credentialFileFor(uid), await sealCredential(record), 0o600);
      writeActiveUid(uid);
      invalidatePluginAuthCache();
      return { stored: 'dpapi' };
    });
  } catch (e) {
    credentialStoreFallback = String(e?.message || e);
    memoryCredentials.set(uid, record);
    memoryActiveUid = uid;
    invalidatePluginAuthCache();
    log('credential store unavailable; keeping this login in memory only', credentialStoreFallback);
    return { stored: 'memory', degraded: true, reason: credentialStoreFallback };
  }
}

/** 最近一次读取插件凭据时的错误（诊断/UI 用；不含令牌）。 */
let pluginCredentialError = '';

/** 全部插件凭据（含令牌，**仅供内部使用**）。 */
async function readAllPluginCredentials() {
  const out = [];
  pluginCredentialError = '';
  if (credentialStoreMode() === 'memory') {
    for (const cred of memoryCredentials.values()) out.push(cred);
    return out;
  }
  let files;
  try { files = readdirSync(CREDENTIAL_DIR).filter((f) => f.endsWith('.cred')); }
  catch { return out; }
  for (const file of files) {
    const full = join(CREDENTIAL_DIR, file);
    try { out.push(await openCredential(readFileSync(full, 'utf8'))); }
    catch (e) {
      pluginCredentialError = `${file}: ${e.message}`;
      log('credential file unreadable', shortError(pluginCredentialError, 160));
    }
  }
  return out;
}

/** 对外清单：永不含 access / refresh。 */
function publicCredential(cred) {
  return {
    uid: cred.uid,
    region: cred.region || '',
    nickname: cred.nickname || '',
    enterpriseId: cred.enterpriseId || '',
    domain: cred.domain || '',
    expiresAt: cred.expiresAtMs ? new Date(cred.expiresAtMs).toISOString() : '',
    updatedAt: cred.updatedAt || '',
  };
}

async function listPluginCredentials() {
  const active = readActiveUid();
  const all = await readAllPluginCredentials();
  return all
    .map((c) => ({ ...publicCredential(c), active: c.uid === active }))
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

function pluginAuthFromCredential(cred) {
  return {
    source: 'plugin',
    uid: cred.uid,
    access: cred.accessToken,
    refresh: cred.refreshToken || '',
    expiresAt: Number(cred.expiresAtMs) || 0,
    refreshExpiresAt: Number(cred.refreshExpiresAtMs) || 0,
    userId: cred.uid,
    enterpriseId: cred.enterpriseId || '',
    tenantId: '',
    endpoint: cred.endpoint || (cred.region === 'global' ? 'https://www.workbuddy.ai' : (EXPLICIT_ENDPOINT || 'https://copilot.tencent.com')),
    domain: cred.domain || (cred.region === 'global' ? 'www.workbuddy.ai' : 'www.codebuddy.cn'),
    region: cred.region || 'cn',
  };
}

/** 取 active 插件凭据（热路径，按文件 mtime 缓存解密结果）。 */
async function readPluginAuth() {
  if (credentialStoreMode() === 'memory') {
    const uid = memoryActiveUid;
    const cred = (uid && memoryCredentials.get(uid)) || [...memoryCredentials.values()].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0];
    if (!cred) throw new Error('no plugin credential; sign in first (POST /v1/auth/device)');
    return pluginAuthFromCredential(cred);
  }
  let uid = readActiveUid();
  let file = uid ? credentialFileFor(uid) : '';
  if (!file || !existsSync(file)) {
    // active 指针丢失：挑最近写入的那个，并修好指针
    let files;
    try { files = readdirSync(CREDENTIAL_DIR).filter((f) => f.endsWith('.cred')); }
    catch { files = []; }
    if (!files.length) throw new Error('no plugin credential; sign in first (POST /v1/auth/device)');
    const newest = files.map((f) => ({ f, mtimeMs: statSync(join(CREDENTIAL_DIR, f)).mtimeMs }))
      .sort((a, b) => b.mtimeMs - a.mtimeMs)[0].f;
    file = join(CREDENTIAL_DIR, newest);
    uid = '';
  }
  const st = statSync(file);
  if (pluginAuthCache.auth && pluginAuthCache.file === file
    && pluginAuthCache.mtimeMs === st.mtimeMs && pluginAuthCache.size === st.size) {
    return pluginAuthCache.auth;
  }
  const cred = await openCredential(readFileSync(file, 'utf8'));
  const auth = pluginAuthFromCredential(cred);
  pluginAuthCache = { file, uid: cred.uid, mtimeMs: st.mtimeMs, size: st.size, auth };
  if (!uid) { try { writeActiveUid(cred.uid); } catch { /* 只影响下次选择 */ } }
  return auth;
}

async function deletePluginCredential(uid) {
  if (!uid) throw new Error('uid is required');
  if (credentialStoreMode() === 'memory') {
    memoryCredentials.delete(uid);
    if (memoryActiveUid === uid) memoryActiveUid = [...memoryCredentials.keys()][0] || '';
    invalidatePluginAuthCache();
  } else {
    await withCredentialLock(async () => {
      const file = credentialFileFor(uid);
      try { unlinkSync(file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      if (readActiveUid() === uid) {
        const rest = (await readAllPluginCredentials()).filter((c) => c.uid !== uid);
        writeActiveUid(rest[0]?.uid || '');
      }
      invalidatePluginAuthCache();
    });
  }
  // 最后一条插件凭据被删掉时，来源回到 auto（否则下次请求会报"没有插件凭据"）。
  if (!CREDENTIAL_SOURCE_PINNED && (await effectiveSource()) === 'plugin' && (await readAllPluginCredentials()).length === 0) {
    try { await setSourcePreference('auto'); } catch { /* 下次启动回到 auto */ }
  }
}

async function setActivePluginCredential(uid) {
  const exists = (await readAllPluginCredentials()).some((c) => c.uid === uid);
  if (!exists) throw new Error(`unknown credential: ${uid}`);
  if (credentialStoreMode() === 'memory') {
    writeActiveUid(uid);
  } else {
    await withCredentialLock(async () => { writeActiveUid(uid); });
  }
  invalidatePluginAuthCache();
  invalidateCatalogCache();
}

/** auto / desktop / plugin / api-key 的来源解析。 */
function apiKeyAuth() {
  return {
    source: 'api-key',
    endpoint: EXPLICIT_ENDPOINT || 'https://copilot.tencent.com',
    domain: (EXPLICIT_ENDPOINT || '').includes('codebuddy.ai') ? 'www.codebuddy.ai' : 'www.codebuddy.cn',
    access: '',
    refresh: '',
    expiresAt: 0,
  };
}

/**
 * 当前凭据身份的“版本”：账号/来源/区域一变就更新 `changedAt`。
 *
 * 面板/客户端不必等 8~20 秒的整页轮询：轮询一个极轻的 `/v1/identity`，发现
 * `changedAt` 变了就立刻重拉账号、积分与模型目录。账号切换必须**当场生效**，
 * 而不是等下一次目录 TTL 或余额缓存过期。
 */
let authIdentity = { key: '', changedAt: 0, source: '', userId: '', enterpriseId: '', tenantId: '' };
function identityKeyOf(auth) {
  return [
    auth?.source || '',
    auth?.userId || auth?.uid || '',
    auth?.enterpriseId || '',
    auth?.tenantId || '',
    auth?.endpoint || '',
    auth?.domain || '',
  ].join('\u0000');
}
function noteAuthIdentity(auth) {
  const key = identityKeyOf(auth);
  if (key === authIdentity.key) return;
  const previous = authIdentity.key;
  authIdentity = {
    key,
    changedAt: Date.now(),
    source: auth?.source || '',
    userId: auth?.userId || auth?.uid || '',
    enterpriseId: auth?.enterpriseId || '',
    tenantId: auth?.tenantId || '',
  };
  if (previous) {
    log('auth identity changed', `${authIdentity.source}:${authIdentity.userId || '?'}`);
  }
}

/** 内部解析 + 记录身份版本；对外只暴露 {@link resolveAuth}。 */
async function resolveAuthInner() {
  if (API_KEY) return apiKeyAuth();
  /*
   * 每次解析凭据前确认桌面端是否换号。原先只有 readStoredAuth() 会做这件事，
   * 所以来源是 plugin 时永远发现不了桌面换号（issue #6 的另一半）。
   */
  await syncAuthPathFollow();
  let configured = await effectiveSource();
  if (configured === 'api-key') {
    throw new Error('credential source is api-key but CODEBUDDY_API_KEY is not set');
  }
  if (configured === 'plugin') {
    if (await adoptDesktopAfterPluginSwitch()) {
      const adopted = await readStoredAuth();
      log('adopted desktop auth', adopted.userId || '(none)', 'from', AUTH_PATH);
      return adopted;
    }
    /*
     * 并发请求可能在上面这一小段时间里已经完成了“跟随桌面”并把来源改成
     * desktop。此时不能拿着开头读到的 plugin 继续走 readPluginAuth() ——
     * 否则同一个账号切换会表现为「有的请求用新号、有的还用旧号」（启动时
     * 的目录刷新与 /health 并发就撞过这个）。
     */
    configured = await effectiveSource();
    if (configured === 'plugin') return await readPluginAuth();
  }
  if (configured === 'desktop') return await readStoredAuth();
  // auto：桌面端优先（老行为不变），仅在**本地不可用**时回退到插件登录。
  // 上游 401 不会触发中途换号 —— 账户可预测性优先（见 SECURITY 文档）。
  let desktopError;
  try { return await readStoredAuth(); }
  catch (e) { desktopError = e; }
  try { return await readPluginAuth(); }
  catch (e) {
    /** @type {Error & { code?: string }} */
    const err = new Error(`no usable credential (auto): desktop: ${desktopError.message}; plugin: ${e.message}`);
    err.code = 'NO_CREDENTIAL';
    throw err;
  }
}

async function resolveAuth() {
  const auth = await resolveAuthInner();
  noteAuthIdentity(auth);
  return auth;
}

/**
 * 另一条可接管的凭据（鉴权失败时用）。
 *
 * same-account 只认 uid 相等：桌面 JWT 的 `sub` 与插件凭据的 `uid` 是同一套
 * 账号标识（实测对得上）。any 模式才允许跨账号接管 —— 那会换钱包，必须显式开。
 */
async function resolveCredentialAlternative(auth) {
  if (!auth || auth.source === 'api-key' || CREDENTIAL_FAILOVER === 'off') return null;
  if (auth.source === 'desktop') {
    const creds = await readAllPluginCredentials();
    if (!creds.length) return null;
    const match = CREDENTIAL_FAILOVER === 'any'
      ? (creds.find((c) => c.uid === auth.userId) || creds.find((c) => c.active) || creds[0])
      : creds.find((c) => c.uid === auth.userId);
    return match ? pluginAuthFromCredential(match) : null;
  }
  if (auth.source === 'plugin') {
    try {
      const desktop = await readStoredAuth();
      if (CREDENTIAL_FAILOVER === 'any' || (auth.uid && desktop.userId === auth.uid)) return desktop;
    } catch { /* 桌面端不可用：没有可接管项 */ }
  }
  return null;
}

/**
 * 登录区域默认值：显式 env > 当前插件账号 > 桌面账号域名 > 国内版。
 * 以前面板写死 cn，国际版用户每次都要手动切；这里让环境自己说话。
 */
async function suggestedLoginRegion() {
  const env = String(process.env.WORKBUDDY_LOGIN_REGION || '').trim().toLowerCase();
  if (env === 'global' || env === 'cn') return env;
  try {
    const list = await listPluginCredentials();
    const active = list.find((c) => c.active) || list[0];
    if (active?.region === 'global' || active?.region === 'cn') return active.region;
  } catch { /* 没有插件凭据 */ }
  try {
    const d = await readStoredAuth();
    if (/workbuddy\.ai|codebuddy\.ai|\.ai(?:\/|$)/i.test(`${d.domain || ''} ${d.endpoint || ''}`)) return 'global';
  } catch { /* 桌面端不可用 */ }
  return 'cn';
}

/** 诊断/健康用的来源状态：不含任何令牌。 */
async function credentialStatus() {
  const status = {
    configured: await effectiveSource(),
    envPinned: CREDENTIAL_SOURCE_PINNED,
    storeMode: credentialStoreMode(),
    storeDir: credentialStoreMode() === 'memory' ? '' : CREDENTIAL_DIR,
    fallbackReason: credentialStoreFallback,
    failover: CREDENTIAL_FAILOVER,
    desktop: { available: false, error: '', userId: '' },
    plugin: { available: false, count: 0, activeUid: '', uids: [], error: '' },
    /** 当前选中的桌面账号与插件 active 账号是否为同一账号（用 JWT sub ↔ plugin uid 匹配）。 */
    sameAccount: false,
    effective: null,
    error: '',
  };
  try {
    const d = await readStoredAuth();
    status.desktop.available = true;
    status.desktop.userId = d.userId || '';
  } catch (e) { status.desktop.error = String(e?.message || e).slice(0, 300); }
  try {
    const list = await listPluginCredentials();
    status.plugin.available = list.length > 0;
    status.plugin.count = list.length;
    status.plugin.activeUid = list.find((c) => c.active)?.uid || '';
    status.plugin.uids = list.map((c) => c.uid);
    if (pluginCredentialError) status.plugin.error = pluginCredentialError.slice(0, 300);
    status.sameAccount = !!(status.desktop.userId && status.plugin.activeUid
      && String(status.desktop.userId) === String(status.plugin.activeUid));
  } catch (e) { status.plugin.error = String(e?.message || e).slice(0, 300); }
  try {
    const auth = await resolveAuth();
    status.effective = {
      source: auth.source,
      uid: auth.uid || auth.userId || '',
      region: auth.region || '',
      endpoint: auth.endpoint || '',
      expiresAt: auth.expiresAt ? new Date(auth.expiresAt).toISOString() : '',
    };
  } catch (e) { status.error = String(e?.message || e).slice(0, 400); }
  status.loginRegion = await suggestedLoginRegion();
  return status;
}

// ── OAuth device-code sign-in (second credential source) ─────────────────
const LOGIN_UA = process.env.WORKBUDDY_LOGIN_UA || 'CLI/2.63.2 CodeBuddy/2.63.2';
const LOGIN_BASE_OVERRIDE = process.env.WORKBUDDY_LOGIN_BASE || '';
const LOGIN_ORIGIN_OVERRIDE = process.env.WORKBUDDY_LOGIN_ORIGIN || '';
// 可调是为了让用例不必真等 10 分钟 / 3 秒；生产没有理由改它们。
const LOGIN_STATE_TTL_MS = numEnv('WORKBUDDY_LOGIN_STATE_TTL_MS', 10 * 60 * 1000, { min: 1000 });
const LOGIN_POLL_MIN_MS = numEnv('WORKBUDDY_LOGIN_POLL_MIN_MS', 3000, { min: 0 });

/**
 * 插件登录来源的"上游身份"。
 *
 * 桌面端令牌配桌面仿真头（现行默认）已经实测可用；设备码令牌是另一条授权
 * 来源，参考实现（molly-ovo/dsh-workbuddy-oauth）实测下来用的是 **WorkBuddy
 * 桌面 App 形状**的 UA/身份头，而不是 CodeBuddy 扩展的 VSCode 形状：
 *
 *   User-Agent: WorkBuddy/<ver> WorkBuddy/<ver>（国际版第二段是 WorkBuddy AI）
 *   X-IDE-Type / X-IDE-Name: WorkBuddy, X-IDE-Version: <ver>
 *   Origin / Referer: 区域站点（国内 codebuddy.cn / 国际 workbuddy.ai）
 *
 * 因此插件来源单独走这套；桌面来源一个字不动。上游若收紧，可用
 * `WORKBUDDY_PLUGIN_IDENTITY=vscode` 退回旧头，或用版本变量覆盖声明值。
 */
const PLUGIN_IDENTITY = process.env.WORKBUDDY_PLUGIN_IDENTITY === 'vscode' ? 'vscode' : 'workbuddy';
const PLUGIN_APP_VERSION_CN = safeVersion(
  process.env.WORKBUDDY_PLUGIN_APP_VERSION_CN || process.env.WORKBUDDY_PLUGIN_APP_VERSION,
  '5.5.6',
);
const PLUGIN_APP_VERSION_GLOBAL = safeVersion(
  process.env.WORKBUDDY_PLUGIN_APP_VERSION_GLOBAL || process.env.WORKBUDDY_PLUGIN_APP_VERSION,
  '5.5.2',
);

/** 版本会进 HTTP 头：只接受形如 5.5.6 的安全值，非法值回退（绝不注入换行）。 */
function safeVersion(raw, fallback) {
  const value = String(raw || '').trim();
  return /^\d{1,6}(?:\.\d{1,6}){1,3}(?:-[0-9A-Za-z.]+)?$/.test(value) ? value : fallback;
}

function pluginClientVersion(region) {
  return region === 'global' ? PLUGIN_APP_VERSION_GLOBAL : PLUGIN_APP_VERSION_CN;
}

function pluginUserAgent(region) {
  const v = pluginClientVersion(region);
  return region === 'global'
    ? `WorkBuddy/${v} WorkBuddy AI/${v}`
    : `WorkBuddy/${v} WorkBuddy/${v}`;
}

function pluginCatalogUserAgent(region) {
  // 参考实现实测：国际版目录要 `WorkBuddyAI/<ver>`（无空格），国内版用 CLI UA。
  return region === 'global' ? `WorkBuddyAI/${pluginClientVersion(region)}` : LOGIN_UA;
}
/** 在飞的登录尝试（state → 元数据）。令牌**不**放在这里。 */
const pendingLogins = new Map();

function loginRegionConfig(region) {
  const r = String(region || 'cn').toLowerCase();
  if (r !== 'cn' && r !== 'global') throw new Error('region must be "cn" or "global"');
  const global = r === 'global';
  return {
    region: r,
    loginBase: LOGIN_BASE_OVERRIDE || (global ? 'https://www.workbuddy.ai' : 'https://www.workbuddy.cn'),
    origin: LOGIN_ORIGIN_OVERRIDE || (global ? 'https://www.workbuddy.ai' : 'https://www.codebuddy.cn'),
    endpoint: EXPLICIT_ENDPOINT || (global ? 'https://www.workbuddy.ai' : 'https://copilot.tencent.com'),
    domain: global ? 'www.workbuddy.ai' : 'www.codebuddy.cn',
  };
}

function loginHeaders(origin, token) {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    Origin: origin,
    Referer: `${origin}/`,
    'User-Agent': LOGIN_UA,
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

/**
 * @param {string} url
 * @param {{ method?: string, headers?: Record<string, string>, body?: string, timeoutMs?: number }} init
 */
async function loginJson(url, { method = 'GET', headers = {}, body, timeoutMs = 30000 }) {
  const res = await fetch(url, {
    method,
    headers,
    ...(body === undefined ? {} : { body }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text().catch(() => '');
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* 非 JSON：下面按原文报错 */ }
  return { res, text, parsed };
}

function prunePendingLogins() {
  const now = Date.now();
  for (const [state, entry] of pendingLogins) {
    if (now - entry.createdAt > LOGIN_STATE_TTL_MS) pendingLogins.delete(state);
  }
}

/** 开始一次设备码登录：返回用户需要在浏览器打开的 URL。 */
/**
 * 打开授权页。只接受 https，且不等待子进程 —— 登录结果仍以轮询为准。
 * 调用方必须显式要求（open:true）；默认不弹浏览器，方便脚本与远程环境。
 */
function openExternalUrl(url) {
  let parsed;
  try { parsed = new URL(String(url)); } catch { return false; }
  if (parsed.protocol !== 'https:') return false;
  try {
    const [cmd, args] = process.platform === 'win32'
      ? ['rundll32', ['url.dll,FileProtocolHandler', parsed.toString()]]
      : process.platform === 'darwin'
        ? ['open', [parsed.toString()]]
        : ['xdg-open', [parsed.toString()]];
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
    // xdg-open 在精简环境里可能不存在：不接 error 会变成未捕获异常，把桥带走
    child.on('error', () => {});
    child.unref();
    return true;
  } catch { return false; }
}

async function startDeviceLogin(region) {
  const cfg = loginRegionConfig(region);
  const url = `${cfg.loginBase}/v2/plugin/auth/state?platform=workbuddy`;
  const { res, text, parsed } = await loginJson(url, {
    method: 'POST', headers: loginHeaders(cfg.origin), body: '{}',
  });
  if (!res.ok || !parsed || parsed.code !== 0 || !parsed.data?.state || !parsed.data?.authUrl) {
    throw new Error(`login state rejected: HTTP ${res.status} ${shortError(parsed?.msg || text, 200)}`);
  }
  const state = String(parsed.data.state);
  let authUrl = String(parsed.data.authUrl);
  try {
    const u = new URL(authUrl);
    if (!u.searchParams.has('loginSessionId')) u.searchParams.set('loginSessionId', randomUUID());
    authUrl = u.href;
  } catch { /* 上游给的 URL 解析不了就原样返回 */ }
  prunePendingLogins();
  pendingLogins.set(state, { region: cfg.region, createdAt: Date.now(), lastPolledAt: 0 });
  return {
    region: cfg.region,
    state,
    url: authUrl,
    expiresAt: new Date(Date.now() + LOGIN_STATE_TTL_MS).toISOString(),
  };
}

/**
 * 轮询一次。返回 `{status:'pending'|'ready', ...}`；上游业务失败抛错。
 * 节流是**先于请求**执行的：连点/重试不会打到上游。
 */
async function pollDeviceLogin(state) {
  prunePendingLogins();
  const entry = pendingLogins.get(state);
  if (!entry) throw new Error('unknown or expired login state; start a new login');
  const now = Date.now();
  if (now - entry.lastPolledAt < LOGIN_POLL_MIN_MS) {
    return { status: 'pending', retryAfterMs: LOGIN_POLL_MIN_MS - (now - entry.lastPolledAt) };
  }
  entry.lastPolledAt = now;
  const cfg = loginRegionConfig(entry.region);
  const { res, text, parsed } = await loginJson(
    `${cfg.loginBase}/v2/plugin/auth/token?state=${encodeURIComponent(state)}`,
    { method: 'GET', headers: loginHeaders(cfg.origin) },
  );
  const code = parsed?.code;
  const msg = String(parsed?.msg || '');
  if (code === 11217 || /login ing/i.test(msg)) return { status: 'pending' };
  if (!res.ok || code !== 0 || !parsed?.data?.accessToken) {
    throw new Error(`login token rejected: HTTP ${res.status} ${shortError(msg || text, 200)}`);
  }
  const d = parsed.data;
  const accessToken = String(d.accessToken);
  const refreshToken = typeof d.refreshToken === 'string' ? d.refreshToken : '';
  const expiresIn = Number(d.expiresIn) || 0;
  const domain = typeof d.domain === 'string' && d.domain ? d.domain : cfg.domain;

  // 账号身份：上游每次调用都要 uid；拿不到就当作失败，避免写一条不可用的凭据
  const acct = await loginJson(
    `${cfg.loginBase}/v2/plugin/login/account?state=${encodeURIComponent(state)}`,
    { method: 'GET', headers: loginHeaders(cfg.origin, accessToken) },
  );
  const account = acct.parsed?.code === 0 ? (acct.parsed.data || {}) : {};
  const uid = typeof account.uid === 'string' ? account.uid : '';
  if (!uid) throw new Error('login completed but the upstream returned no uid');

  // expiresIn 偶发缺失 → 用 JWT exp 兜底（否则会立刻触发一次刷新）
  const expiresAtMs = expiryFromToken(accessToken, expiresIn);
  const stored = await savePluginCredential({
    uid,
    region: cfg.region,
    nickname: typeof account.nickname === 'string' ? account.nickname : '',
    enterpriseId: typeof account.enterpriseId === 'string' ? account.enterpriseId : '',
    accessToken,
    refreshToken,
    expiresAtMs,
    refreshExpiresAtMs: 0,
    domain,
    endpoint: cfg.endpoint,
  });
  pendingLogins.delete(state);
  // 登录是用户的显式动作：没被 env 锁定时，立即让新账号生效（面板会明示）。
  let sourceSwitched = false;
  if (!CREDENTIAL_SOURCE_PINNED) {
    try { await setSourcePreference('plugin'); sourceSwitched = true; }
    catch (e) { log('switch to plugin source failed', shortError(e?.message || e, 160)); }
  }
  log(`device login complete region=${cfg.region} store=${stored.stored}${stored.degraded ? ' (degraded)' : ''}`);
  return {
    status: 'ready',
    account: {
      uid,
      nickname: typeof account.nickname === 'string' ? account.nickname : '',
      region: cfg.region,
      expiresAt: new Date(expiresAtMs).toISOString(),
    },
    stored,
    sourceSwitched,
    effectiveSource: await effectiveSource(),
  };
}

// ── Auth: refresh and write back the login file (cross-process lock + atomic write) ──
/**
 * 每个来源/账号自己的冷却与在飞表。
 *
 * 为什么按 key 分开：桌面端刷新失败不应挡住插件凭据的刷新（反之亦然）。
 * 同一个 key 内仍然单飞 —— 上游会轮换 refresh token，并发刷新会让后到的
 * 请求拿着已作废的令牌。
 */
const refreshFailedAt = new Map();
const refreshInFlight = new Map();
const refreshKeyOf = (auth) => `${auth.source || 'desktop'}:${auth.uid || auth.userId || ''}`;

/** 单飞入口：同飞（同来源同账号）的调用方拿到**同一个** promise。 */
function refreshAuth(auth) {
  if (!auth.refresh) return Promise.resolve(null);
  const key = refreshKeyOf(auth);
  if (Date.now() - (refreshFailedAt.get(key) || 0) < REFRESH_COOLDOWN_MS) return Promise.resolve(null);
  const inflight = refreshInFlight.get(key);
  if (inflight) return inflight;
  const run = doRefreshAuth(auth)
    .then((next) => {
      if (next) refreshFailedAt.delete(key);
      else refreshFailedAt.set(key, Date.now());
      return next;
    })
    .catch((e) => {
      refreshFailedAt.set(key, Date.now());
      log('refresh error', e.message);
      return null;
    })
    .finally(() => { refreshInFlight.delete(key); });
  refreshInFlight.set(key, run);
  return run;
}

/** 用 JWT exp 兜底过期时间：上游偶尔不回 expiresIn。 */
function expiryFromToken(access, expiresIn, fallbackMs = 3600_000) {
  const sec = Number(expiresIn) || 0;
  if (sec > 0) return Date.now() + sec * 1000;
  const exp = Number(decodeJwt(access).exp) || 0;
  return exp > 0 ? exp * 1000 : Date.now() + fallbackMs;
}

async function doRefreshAuth(auth) {
  if (auth.source === 'plugin') return doRefreshPluginAuth(auth);
  /*
   * 刷新期间桌面端可能换号。先记住“这份 refresh 属于哪份文件、哪个指纹”：
   * 请求回来时若文件已经被换掉，刷新结果属于旧账号，绝不能写回 memoryAuth
   * （否则会带着新文件的指纹继续供旧账号令牌，issue #6 复发）。
   */
  const refreshAuthPath = AUTH_PATH;
  let refreshFilePrint = '';
  try {
    const st = statSync(refreshAuthPath);
    refreshFilePrint = `${st.mtimeMs}:${st.size}`;
  } catch { /* 文件读不到就不做指纹比对，交给下一次 readStoredAuth */ }
  try {
    const res = await fetch(`${auth.endpoint}/v2/plugin/auth/token/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${auth.refresh}` },
      signal: AbortSignal.timeout(8000),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body || body.code !== 0 || !body.data?.accessToken) {
      // **绝不打印响应体全文**：失败条件里含 `!res.ok`，也就是说非 2xx 的响应体
      // 仍可能带着 `data.accessToken` —— 而这一行会落进 bridge.log（控制台的日志
      // 面板还会把它显示出来），那就直接违反了「不落盘令牌 / 凭据不落盘」的承诺。
      // 只取协议层的 code 与 msg：定位问题够用，且不含凭据。
      const reason = body && typeof body === 'object'
        ? `${body.code ?? ''} ${body.msg || body.message || ''}`.trim()
        : '';
      log('refresh failed', res.status, shortError(reason || '(no protocol message)'));
      return null;
    }
    let currentPrint = '';
    try {
      const st = statSync(AUTH_PATH);
      currentPrint = `${st.mtimeMs}:${st.size}`;
    } catch { /* 见上 */ }
    if (AUTH_PATH !== refreshAuthPath
      || (refreshFilePrint && currentPrint && refreshFilePrint !== currentPrint)) {
      log('refresh result discarded: login file changed during refresh');
      return null;
    }
    const now = Date.now();
    let authFileMtimeMs = 0;
    let authFileSize = 0;
    try {
      const st = statSync(AUTH_PATH);
      authFileMtimeMs = st.mtimeMs;
      authFileSize = st.size;
    } catch { /* 文件暂时不可读：下次 readStoredAuth 会按变更处理 */ }
    memoryAuth = {
      source: 'desktop',
      access: body.data.accessToken,
      refresh: body.data.refreshToken || auth.refresh,
      expiresAt: now + Number(body.data.expiresIn || 0) * 1000,
      refreshExpiresAt: now + Number(body.data.refreshExpiresIn || 0) * 1000,
      userId: auth.userId,
      enterpriseId: auth.enterpriseId,
      tenantId: auth.tenantId,
      endpoint: auth.endpoint,
      domain: auth.domain,
      // 绑定当时登录文件的指纹：文件一换（换号/桌面端刷新）就丢弃内存令牌。
      authFileMtimeMs,
      authFileSize,
    };
    // 放在赋值**之后**：它只是「我们没回写登录文件」的一条说明性日志。
    // 名字原先叫 persistRefreshed —— 承诺「持久化」，行为却是明确不持久化，
    // 读代码的人很容易以为令牌已经落盘。这条「绝不回写」是项目的硬约束，
    // 代码不该长得像在回写。
    logWriteBackSkipped();
    log('refreshed access token (in memory; file untouched)');
    return memoryAuth;
  } catch (e) {
    log('refresh error', e.message);
    return null;
  }
}

/**
 * 插件凭据的刷新：头与桌面路径**不同**（上游按来源区分），成功后必须把
 * 轮换后的 refresh token 写回加密存储 —— 否则下一次桥重启就失效了。
 */
async function doRefreshPluginAuth(auth) {
  const region = auth.region === 'global' ? 'global' : 'cn';
  const cfg = loginRegionConfig(region);
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    'User-Agent': LOGIN_UA,
    Origin: cfg.origin,
    Referer: `${cfg.origin}/`,
    'X-Refresh-Token': auth.refresh,
    // 上游按这个头区分刷新来源：国内版 App 是 workbuddy，其余是 plugin。
    'X-Auth-Refresh-Source': region === 'cn' ? 'workbuddy' : 'plugin',
    'X-CodeBuddy-Request': '1',
    'Accept-Language': region === 'global' ? 'en-US' : 'zh-CN',
    ...(auth.uid ? { 'X-User-Id': auth.uid } : {}),
    ...(auth.domain ? { 'X-Domain': auth.domain } : {}),
    ...(auth.enterpriseId ? { 'X-Enterprise-Id': auth.enterpriseId } : {}),
  };
  const { res, text, parsed } = await loginJson(`${auth.endpoint}/v2/plugin/auth/token/refresh`, {
    method: 'POST', headers, body: '{}', timeoutMs: 15000,
  });
  const inner = parsed?.data?.data ?? parsed?.data;
  if (!res.ok || !inner?.accessToken) {
    log('plugin refresh failed', res.status, shortError(parsed?.msg || text, 200));
    return null;
  }
  const access = String(inner.accessToken);
  const refresh = typeof inner.refreshToken === 'string' && inner.refreshToken ? inner.refreshToken : auth.refresh;
  const next = {
    ...auth,
    access,
    refresh,
    expiresAt: expiryFromToken(access, inner.expiresIn),
  };
  try {
    await savePluginCredential({
      uid: auth.uid,
      region,
      nickname: auth.nickname || '',
      enterpriseId: auth.enterpriseId || '',
      accessToken: next.access,
      refreshToken: next.refresh,
      expiresAtMs: next.expiresAt,
      refreshExpiresAtMs: 0,
      domain: auth.domain || cfg.domain,
      endpoint: auth.endpoint,
    });
    log('refreshed plugin credential (persisted)');
  } catch (e) {
    // 持久化失败不影响本次调用（内存里已有新令牌）；下次重启会退回旧令牌并再试刷新。
    log('plugin credential persist failed', shortError(e?.message || e, 200));
  }
  return next;
}

/** 说明性日志：刷新出的令牌只留内存，登录文件归桌面端所有。 */
function logWriteBackSkipped() {
  // The login file now holds AES-256-GCM envelopes and the desktop app owns its
  // own refresh cycle. Writing a decrypted token back would corrupt that store,
  // so a refreshed token is kept in memory for this process only.
  log('write-back skipped: the at-rest credential store belongs to the desktop app');
}

// ── Upstream payload normalization ───────────────────────────────────────
/**
 * 上游（copilot.tencent.com）比 OpenAI 规范更严：有几处「规范允许、上游拒绝」
 * 的写法，必须在转发前归一化，否则客户端一用就整条请求失败。目前三处：
 *
 * 1. `developer` 角色 —— 新版 OpenAI 规范用它承载 system 提示，而官方客户端
 *    只发 `system`。上游只认后者，遇到 `developer` 直接 400 code 11128。
 * 2. `tool_choice` 对象形式 —— 规范允许 `{type:'function', function:{name}}`
 *    强制调用某个具体函数，上游的 Go 结构体把它声明成了 `string`，
 *    收到对象会 400 code 11101。Cursor / Trae / opencode 这类基于 AI SDK
 *    的 Agent 客户端会发对象形式。
 * 3. 首条消息必须是 system —— 上游会以 `400 code 11128 first message is not
 *    system prompt` 拒绝纯 user 开头的请求，而不少客户端（含自带的
 *    「对话测试」和只发单轮的 CLI）并不发 system。
 * 4. Claude Code 的固定 system 模板被上游**逐字拉黑**（2026-10-08 实测）：
 *    带原文 → `400 Illegal API invocation from an unapproved channel`；
 *    按报告 §8.7 #44 做最小改写（CLI→CLI tool、Main branch→Default branch）
 *    后 → 200。上游用它识别「经代理转发的 Claude Code」，因此改写放在出站层
 *    统一做（两条协议路径共用 —— OpenAI 路径带同样句子的请求一样会被拒）。
 *    承认这是 cat-and-mouse：只做**已被实测证明有效**的最小改写，不发明更多。
 */
const AUDIT_TEMPLATE_REWRITES = [
  ["You are Claude Code, Anthropic's official CLI for Claude.",
    "You are Claude Code, Anthropic's official CLI tool for Claude."],
  ['Main branch (you will usually use this for PRs)',
    'Default branch (you will usually use this for PRs)'],
];

/**
 * dsh 的宿主身份句。
 *
 * 2026-10-21 实测：上游对 system 开头的
 * `You are an AI agent powered by DeepSeek Harness.` 直接回 400 code 11128；
 * 把这一句换成中性表述后，同样的 system / messages / tools 全部 200。
 * 品牌词单独出现（user 内容或后半段）不拦 —— 拦的是系统提示的这句身份模板。
 * 只改 system（rewriteAuditContent 只对 system 调用），不动用户/工具内容。
 */
// 只吃掉可选版本/build 后缀，不再用 `[^\n.]*` 吞到第一个句点 ——
// 否则 `Harness v5.8.3. Keep this rule.` 会变成 `NEUTRAL8.3. Keep this rule.`。
const DSH_IDENTITY_RE = /You are an AI agent powered by DeepSeek\s+Harness(?:\s+(?:version|build|v)?\s*\d+(?:\.\d+){0,3}(?:[-+][0-9A-Za-z.-]+)?)?\.?/gi;
const DSH_IDENTITY_NEUTRAL = "You are an AI agent running inside the user's development environment.";
/**
 * system 里除首句身份之外，**其它行**也可能带 `DeepSeek Harness` 品牌词。
 *
 * 2026-10 同类项目逐句 A/B（hub #570）：DSH 的 developer 提示第 33/35 行
 * `The runtime context names the DeepSeek Harness implementation checkout.` /
 * `You are interacting with the user through the DeepSeek Harness Web GUI ...`
 * 同样会被上游 11128 拦。只洗首句不够，但**不能删整行**（会丢语义）——
 * 把品牌名换成中性称呼，保留该行其余指令。
 */
const DSH_BRAND_RE = /\bDeepSeek\s+Harness\b/gi;
const DSH_BRAND_NEUTRAL = 'the local runtime';
/**
 * 另一句会被 11128 拦的自述：`You are a coding agent powered by the
 * cn-deepseek-v4.1-flash-0.11x model.`。只替换这一整句，不动后面的内容；
 * 模型名本身可能随账号/区域变化，所以用非贪婪到 `model.` 收尾。
 */
const DSH_AGENT_MODEL_RE = /You are a coding agent powered by the [^\n.]{1,120}? model\./gi;
const DSH_AGENT_MODEL_NEUTRAL = "You are a coding agent running in the user's development environment.";

/**
 * system / assistant 文本的最小改写；无命中时返回原值（引用不变，便于命中计数）。
 *
 * `assistant` 作用域刻意**只洗两句精确身份模板**，不替换任意品牌词：
 * assistant 正文可能是用户正在看的回答，广泛改写会改变语义。system 才是
 * 模板指纹的主要来源，允许把其余品牌词做中性替换。
 */
function rewriteAuditTemplate(text, { assistant = false } = {}) {
  if (typeof text !== 'string' || text === '') return text;
  let out = text;
  for (const [from, to] of AUDIT_TEMPLATE_REWRITES) {
    if (out.includes(from)) out = out.split(from).join(to);
  }
  out = out.replace(DSH_IDENTITY_RE, DSH_IDENTITY_NEUTRAL);
  out = out.replace(DSH_AGENT_MODEL_RE, DSH_AGENT_MODEL_NEUTRAL);
  if (!assistant) out = out.replace(DSH_BRAND_RE, DSH_BRAND_NEUTRAL);
  return out;
}

/** content 可能是 string 或 parts 数组（Anthropic 的 [{type:'text',text}]）。 */
function rewriteAuditContent(content, options = {}) {
  if (typeof content === 'string') return rewriteAuditTemplate(content, options);
  if (Array.isArray(content)) {
    let changed = false;
    const nextParts = content.map((part) => {
      if (part && typeof part === 'object' && typeof part.text === 'string') {
        const t = rewriteAuditTemplate(part.text, options);
        if (t !== part.text) {
          changed = true;
          return { ...part, text: t };
        }
      }
      return part;
    });
    return changed ? nextParts : content;
  }
  return content;
}

/**
 * 工具名是上游会**确定性拒绝**的字段：带 `.` / `/` / 空格或重名时，整条请求
 * 400（实测 code 11152 / `invalid_request_error`），且不会重试。
 *
 * 在本地先拦：不花一次上游往返，错误里能直接指出是哪个工具。只校验 OpenAI
 * 形状（`tools[].function.name`）；Anthropic/Responses 的翻译结果也先转成这个
 * 形状再校验。
 */
function toolNameError(tools) {
  if (!Array.isArray(tools)) return null;
  const seen = new Set();
  for (const tool of tools) {
    const name = tool?.function?.name ?? tool?.name;
    if (typeof name !== 'string' || !name) return 'tool name is missing';
    if (!TOOL_NAME_RE.test(name)) {
      return `tool name "${shortError(name, 60)}" is invalid`
        + ' (allowed: letters, digits, "_" and "-", max 64 chars)';
    }
    if (seen.has(name)) return `tool name "${name}" is duplicated`;
    seen.add(name);
  }
  return null;
}

/**
 * 模型是否支持图片输入。`true/false` 来自目录或精选表；未知模型返回 null。
 *
 * 不用“默认支持”猜：上游目录对没有视觉能力的模型通常省略 `images`，
 * 把它当 true 会让客户端收到上游 400；把它当 false 又可能误伤新模型。
 * 只有明确为 false 时才降级。
 */
function modelVisionSupport(modelId) {
  const id = String(modelId || '');
  if (!id) return null;
  const catalog = Array.isArray(catalogCache.models) ? catalogCache.models : [];
  const hit = catalog.find((m) => m && m.id === id);
  if (hit) {
    // 只有上游**明确**给过 supportsImages 才下结论；缺失当未知（不敢降级，
    // 否则会把实际上能看图的模型错误降级成文本）。
    if (hit.imagesKnown === true) return hit.images === true;
    if (hit.images === true) return true;
    return null;
  }
  const featured = FEATURED.find((f) => f.id === id);
  if (featured) {
    if (featured.images === true) return true;
    if (featured.images === false) return false;
    return null;
  }
  return null;
}

/**
 * 非视觉模型收到图片时，把图片块降级成文本占位，而不是原样上行吃 400。
 *
 * 同类客户端实测（Chatbox #1638）：历史里一旦带过图，非视觉模型之后每一轮
 * 都会 400，用户只能清会话。降级不完美（模型看不到图），但比整条会话死掉好，
 * 而且账本会记下 `imageOmitted`，面板可以解释“这次图片被忽略了”。
 */
function degradeImagesForModel(payload, model) {
  if (modelVisionSupport(model) !== false) return { payload, omitted: 0 };
  const messages = Array.isArray(payload?.messages) ? payload.messages : null;
  if (!messages) return { payload, omitted: 0 };
  let omitted = 0;
  const nextMessages = messages.map((m) => {
    if (!m || typeof m !== 'object' || !Array.isArray(m.content)) return m;
    let changed = false;
    const nextContent = m.content.map((part) => {
      if (!part || typeof part !== 'object') return part;
      if (part.type === 'image_url' || part.type === 'image' || part.type === 'input_image') {
        omitted += 1;
        changed = true;
        return { type: 'text', text: '[image omitted: model has no vision]' };
      }
      return part;
    });
    return changed ? { ...m, content: nextContent } : m;
  });
  if (!omitted) return { payload, omitted: 0 };
  return { payload: { ...payload, messages: nextMessages }, omitted };
}

/** 应用图片降级，并把次数记进本次请求的账本上下文。 */
function applyVisionDegrade(payload, model) {
  const vision = degradeImagesForModel(payload, model);
  if (!vision.omitted) return payload;
  const scope = requestScope.getStore();
  if (scope) scope.imageOmitted = vision.omitted;
  log(`image(s) omitted for non-vision model ${model}: ${vision.omitted}`);
  return vision.payload;
}

/**
 * 工具调用历史自愈。
 *
 * 上游对工具历史的要求比 OpenAI 规范更严（panel #81 / xdpool #73 / Codex #7051）：
 *   - 同一个 `tool_call.id` 在历史里重复出现 → 400/11148；
 *   - assistant 发了 tool_calls 但后面没有对应 tool result → 400；
 *   - 只有 reasoning、没有正文和 tool_calls 的空 assistant → 400/11151，且之后
 *     每轮都挂；
 *   - 孤儿 tool result（没有对应 call）同样会被拒。
 *
 * 这里做**最小必要修复**：重复 id 改名并同步 result；缺 result 合成一条
 * `is_error:true` 的结果；孤儿 result 丢弃；空 assistant 剔除。合法历史原样
 * 返回（引用不变），不改变正常请求的字节。
 *
 * 默认开启；`WORKBUDDY_REPAIR_TOOL_HISTORY=0` 可关闭。
 */
const REPAIR_TOOL_HISTORY_ENABLED = !/^(0|false|off|no)$/i.test(
  String(process.env.WORKBUDDY_REPAIR_TOOL_HISTORY || '1').trim(),
);

function repairToolHistory(messages) {
  if (!REPAIR_TOOL_HISTORY_ENABLED || !Array.isArray(messages) || messages.length === 0) {
    return { messages, changed: false, renames: 0, synthesized: 0, dropped: 0 };
  }
  let changed = false;
  let renames = 0;
  let synthesized = 0;
  let dropped = 0;
  let seq = 0;
  const used = new Set();
  const out = [];
  let pending = []; // 当前 assistant 回合尚未收到 result 的调用

  const freshId = (original) => {
    const base = String(original || 'call').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 32) || 'call';
    let id;
    do {
      seq += 1;
      id = `repair_${seq}_${base}`;
    } while (used.has(id));
    used.add(id);
    return id;
  };
  const flushMissing = () => {
    for (const p of pending) {
      if (p.done) continue;
      out.push({
        role: 'tool',
        tool_call_id: p.newId,
        content: 'tool result unavailable (bridge repaired a missing tool result)',
      });
      synthesized += 1;
      changed = true;
    }
    pending = [];
  };

  for (const m of messages) {
    if (!m || typeof m !== 'object') { out.push(m); continue; }

    if (m.role === 'assistant') {
      const toolCalls = Array.isArray(m.tool_calls) ? m.tool_calls : [];
      // content 可能是字符串、parts 数组，或 null；图片等非文本块也算内容，
      // 不能因为 messageText() 为空就把一条有内容的 assistant 消息丢掉。
      const hasContent = typeof m.content === 'string'
        ? m.content.trim().length > 0
        : (Array.isArray(m.content) ? m.content.length > 0 : Boolean(m.content));
      // 只有 reasoning / 什么都没有的空 assistant：上游会判 11151，整条会话之后
      // 每轮都失败。剔除它不会丢失可回放的内容（reasoning 不是正文）。
      if (!toolCalls.length && !hasContent) {
        dropped += 1;
        changed = true;
        continue;
      }
      flushMissing();
      if (!toolCalls.length) { out.push(m); continue; }

      const rewrittenCalls = toolCalls.map((call) => {
        const original = typeof call?.id === 'string' ? call.id : '';
        let id = original;
        if (!id || used.has(id)) {
          id = freshId(original);
          renames += 1;
          changed = true;
        } else {
          used.add(id);
        }
        pending.push({ origId: original, newId: id, done: false });
        return { ...call, id };
      });
      out.push({ ...m, tool_calls: rewrittenCalls });
      continue;
    }

    if (m.role === 'tool') {
      const original = m.tool_call_id;
      const idx = pending.findIndex((p) => !p.done && p.origId === original);
      if (idx >= 0) {
        const p = pending[idx];
        p.done = true;
        if (p.newId !== original) {
          changed = true;
          out.push({ ...m, tool_call_id: p.newId });
        } else {
          out.push(m);
        }
      } else {
        // 孤儿 result：没有对应 call（或 call 已被处理过）。原样上行必 400。
        dropped += 1;
        changed = true;
      }
      continue;
    }

    // user / system / 其它角色之前，把上一轮缺失的 result 补齐，避免下一轮
    // assistant 消息把 pending 冲掉后上游看到“有 call 无 result”。
    flushMissing();
    out.push(m);
  }
  flushMissing();

  return { messages: changed ? out : messages, changed, renames, synthesized, dropped };
}

function normalizePayload(payload) {
  let next = payload;

  // ── tool_choice：对象 → 字符串 ─────────────────────────────────────────
  // `{type:'function'}` 表达的是「必须调用工具」里最强的那档，而上游没有
  // 「指定某一个函数」的表达，取语义最接近的 `required`（必须调用工具，
  // 但不限定是哪一个）。
  //
  // 认不出来的对象**丢弃而不是原样转发**：留着必然 400，丢掉最多退化成
  // `auto`（让模型自己决定），这比整条请求失败好得多。
  const tc = next.tool_choice;
  if (tc !== null && typeof tc === 'object' && !Array.isArray(tc)) {
    const mapped = tc.type === 'function' ? 'required'
      : (tc.type === 'auto' || tc.type === 'none' || tc.type === 'required') ? tc.type
        : null;
    next = { ...next };
    if (mapped) {
      next.tool_choice = mapped;
      log(`normalize: tool_choice object -> "${mapped}"`);
    } else {
      delete next.tool_choice;
      log('normalize: dropped unrecognized tool_choice object');
    }
  }

  // ── messages：工具历史自愈 → developer → system → 首条 system ─────────
  const originalMessages = next.messages;
  if (!Array.isArray(originalMessages) || originalMessages.length === 0) return next;
  const repaired = repairToolHistory(originalMessages);
  const messages = repaired.messages;
  if (repaired.changed) {
    log(`normalize: repaired tool history (renamed=${repaired.renames}`
      + ` synthesized=${repaired.synthesized} dropped=${repaired.dropped})`);
    // 账本只记计数，便于面板回答“这次为什么被修过”，不记任何内容。
    const scope = requestScope.getStore();
    if (scope) scope.toolRepair = {
      renames: repaired.renames,
      synthesized: repaired.synthesized,
      dropped: repaired.dropped,
    };
  }

  let rewritten = 0;
  const fixed = messages.map((m) => {
    if (m && (m.role === 'developer' || m.role === 'Developer')) {
      rewritten++;
      return { ...m, role: 'system' };
    }
    return m;
  });

  // ── 内容审核模板的最小改写（system + 可选 assistant；命中才动）───────────
  let auditFixedSystem = 0;
  let auditFixedAssistant = 0;
  const sanitized = fixed.map((m) => {
    if (!m) return m;
    const isSystem = m.role === 'system' || m.role === 'System';
    const isAssistant = m.role === 'assistant' && SANITIZE_ASSISTANT_HISTORY;
    if (!isSystem && !isAssistant) return m;
    const nextContent = rewriteAuditContent(m.content, { assistant: isAssistant });
    if (nextContent !== m.content) {
      if (isSystem) auditFixedSystem++;
      else auditFixedAssistant++;
      return { ...m, content: nextContent };
    }
    return m;
  });

  let prepended = 0;
  const first = sanitized[0];
  if (!first || (first.role !== 'system' && first.role !== 'System')) {
    sanitized.unshift({ role: 'system', content: 'You are a helpful assistant.' });
    prepended = 1;
  }

  if (rewritten) log(`normalize: rewrote ${rewritten} developer message(s) -> system`);
  if (auditFixedSystem) log(`normalize: rewrote ${auditFixedSystem} audit-template system message(s)`);
  if (auditFixedAssistant) log(`normalize: rewrote ${auditFixedAssistant} audit-template assistant message(s)`);
  if (prepended) log('normalize: prepended a system message (upstream requires one first)');
  if (!rewritten && !prepended && !auditFixedSystem && !auditFixedAssistant && !repaired.changed) return next;
  return { ...next, messages: sanitized };
}

// ── Request header construction ──────────────────────────────────────────
const trace = () => randomUUID().replace(/-/g, '');

/**
 * 会话 ID 的解析与稳定化。
 *
 * 背景（同类项目实测，hub #99 / panel #169）：
 *   - 上游**按 body 的 `conversation_id` 分前缀缓存槽**；只发 header 不发 body
 *     时，长会话的缓存命中率可能一直是 0。
 *   - 部分客户端（尤其 DSH）不传 `X-Conversation-ID`；旧实现每轮 `trace()`，
 *     等于每轮都换一个缓存槽，既贵又慢。
 *
 * 解析顺序：
 *   1. 客户端显式 `x-conversation-id` 或 body `conversation_id` —— 尊重原值；
 *   2. 会话指纹：第一条 system + 第一条 user + 模型 的 SHA-256 前 32 位；
 *   3. 都没有（空请求）才回退随机值。
 *
 * 指纹只算文本，不落盘、不打印正文；日志最多打前 8 位与来源。
 */
function messageText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part && typeof part === 'object' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n');
}

function resolveConversationId(req, payload) {
  const explicit = req?.headers?.['x-conversation-id'] || payload?.conversation_id;
  if (typeof explicit === 'string' && explicit.trim()) {
    const raw = explicit.trim();
    // header 对非法字符敏感：客户端给了超长/怪字符时先哈希，避免 400 500 难排查。
    const id = /^[A-Za-z0-9._:-]{1,200}$/.test(raw)
      ? raw
      : createHash('sha256').update(raw).digest('hex');
    return { id, source: 'client' };
  }
  const messages = Array.isArray(payload?.messages) ? payload.messages : [];
  const system = messages.find((m) => m && (m.role === 'system' || m.role === 'System'));
  const user = messages.find((m) => m && m.role === 'user');
  const seed = [messageText(system?.content), messageText(user?.content), payload?.model || ''].join('\u0000');
  if (seed.trim()) {
    const id = createHash('sha256').update(seed).digest('hex').slice(0, 32);
    return { id, source: 'derived' };
  }
  return { id: trace(), source: 'random' };
}

/**
 * body `conversation_id` 注入开关（默认开）。
 *
 * 上游是官方客户端协议的一部分；如果未来某个上游 build 把它当未知字段拒绝，
 * `callUpstreamWithChannelFallback` 会自动去掉字段重试一次并关闭本进程的注入，
 * 不需要用户改配置。`WORKBUDDY_CONVERSATION_ID_BODY=0` 可永久关闭。
 */
const CONVERSATION_ID_BODY_ENABLED = !/^(0|false|off|no)$/i.test(
  String(process.env.WORKBUDDY_CONVERSATION_ID_BODY || '1').trim(),
);
let conversationIdBodyEnabled = CONVERSATION_ID_BODY_ENABLED;

/** 上游是否明确在抱怨 `conversation_id` 这个字段（不是 11128 的缺会话 id）。 */
function isConversationIdFieldRejected(parsed, text) {
  const hay = [
    parsed?.msg, parsed?.message, parsed?.displayMsg?.zh, parsed?.displayMsg?.en, text,
  ].filter((s) => typeof s === 'string').join(' ');
  if (!/conversation[_ ]?id/i.test(hay)) return false;
  return /unknown|unexpected|unrecognized|invalid|not allowed|extra field|additional propert/i.test(hay);
}

function buildHeaders(auth, model, conversationId) {
  const messageId = trace();
  const traceId = trace();
  const spanId = traceId.slice(0, 16);
  const parentSpanId = traceId.slice(16, 32);
  const h = {
    Accept: 'application/json, text/plain, */*',
    'Content-Type': 'application/json',
    'X-Requested-With': 'XMLHttpRequest',
    'X-Agent-Intent': 'craft',
    'X-IDE-Type': IDE_NAME,
    'X-IDE-Name': IDE_NAME,
    'X-IDE-Version': IDE_VERSION,
    'X-Product-Version': APP_VERSION,
    'X-Env-ID': 'production',
    'X-Domain': auth.domain,
    'X-Product': 'SaaS',
    'User-Agent': `${IDE_NAME}/${IDE_VERSION} CodeBuddy/${APP_VERSION}`,
    'X-Request-ID': messageId,
    'X-Conversation-ID': conversationId || trace(),
    'X-Conversation-Request-ID': messageId,
    'X-Conversation-Message-ID': messageId,
    'X-Request-Trace-Id': traceId,
    b3: `${traceId}-${spanId}-1-${parentSpanId}`,
    'X-B3-TraceId': traceId,
    'X-B3-ParentSpanId': parentSpanId,
    'X-B3-SpanId': spanId,
    'X-B3-Sampled': '1',
  };
  if (model) {
    // 兜底。入口（/v1/chat/completions）已按 HEADER_SAFE_RE 校验并回 400，这里再挡
    // 一次是为了防止**将来新增的调用方**绕过入口校验、把非法值直接送进 http.request ——
    // 那样抛出的 `Invalid character in header content` 会变成 500，而根因（谁传的）
    // 在栈里完全看不出来。Anthropic 路径的模型名会先被映射成真实 id，天然安全。
    if (!HEADER_SAFE_RE.test(model)) {
      throw new Error(`model id would produce an invalid X-Model-ID header: ${shortError(model, 60)}`);
    }
    h['X-Model-ID'] = model;
  }
  if (API_KEY) {
    h.Authorization = `Bearer ${API_KEY}`;
    h['X-API-Key'] = API_KEY;
  } else {
    h.Authorization = `Bearer ${auth.access}`;
    if (auth.userId) h['X-User-Id'] = auth.userId;
    if (auth.enterpriseId) h['X-Enterprise-Id'] = auth.enterpriseId;
    if (auth.tenantId) h['X-Tenant-Id'] = auth.tenantId;
  }
  return h;
}

/**
 * Chat 请求头：插件来源用 WorkBuddy 身份（见 PLUGIN_IDENTITY 的说明），
 * 桌面来源保持原样。所有 chat 协议路径最终都走 callUpstream → 这里。
 */
function buildChatHeaders(auth, model, conversationId) {
  const base = buildHeaders(auth, model, conversationId);
  if (auth.source !== 'plugin' || PLUGIN_IDENTITY === 'vscode') return base;
  const region = auth.region === 'global' ? 'global' : 'cn';
  const origin = loginRegionConfig(region).origin;
  const version = pluginClientVersion(region);
  const h = {
    ...base,
    'User-Agent': pluginUserAgent(region),
    Origin: origin,
    Referer: `${origin}/`,
    'X-IDE-Type': 'WorkBuddy',
    'X-IDE-Name': 'WorkBuddy',
    'X-IDE-Version': version,
    'X-Product-Version': version,
    'X-Product': 'SaaS',
  };
  if (auth.uid || auth.userId) h['X-User-Id'] = auth.uid || auth.userId;
  else { delete h['X-User-Id']; h['X-No-User-Id'] = '1'; }
  if (auth.enterpriseId) h['X-Enterprise-Id'] = auth.enterpriseId;
  else { delete h['X-Enterprise-Id']; h['X-No-Enterprise-Id'] = '1'; }
  if (auth.domain) h['X-Domain'] = auth.domain;
  else { delete h['X-Domain']; h['X-No-Department-Info'] = '1'; }
  delete h['X-Tenant-Id']; // 插件凭据没有 tenant；不猜
  return h;
}

/** 模型目录头：插件来源按参考实现实测的 UA 形状（国际版 WorkBuddyAI，国内版 CLI）。 */
function buildCatalogHeaders(auth) {
  if (auth.source !== 'plugin' || PLUGIN_IDENTITY === 'vscode') return buildHeaders(auth, '', '');
  const region = auth.region === 'global' ? 'global' : 'cn';
  const origin = loginRegionConfig(region).origin;
  const h = {
    Accept: 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    Origin: origin,
    Referer: `${origin}/`,
    'User-Agent': pluginCatalogUserAgent(region),
    // 目录同样是鉴权请求：漏了它会让插件来源永远拿不到模型列表（401）。
    ...(auth.access ? { Authorization: `Bearer ${auth.access}` } : {}),
  };
  if (auth.uid) h['X-User-Id'] = auth.uid; else h['X-No-User-Id'] = '1';
  if (auth.enterpriseId) h['X-Enterprise-Id'] = auth.enterpriseId; else h['X-No-Enterprise-Id'] = '1';
  if (auth.domain) h['X-Domain'] = auth.domain; else h['X-No-Department-Info'] = '1';
  if (region === 'global') h['X-Product'] = 'SaaS';
  return h;
}

// ── WorkBuddy native web search ──────────────────────────────────────────
/**
 * 搜索网关与 chat 网关不一定是同一个主机：
 *   国际版 chat = www.workbuddy.ai，产品端点也是 www.workbuddy.ai
 *   国内版 chat = copilot.tencent.com，产品端点是 www.workbuddy.cn
 * 因此不能直接复用 auth.endpoint；可用 WORKBUDDY_SEARCH_BASE 覆盖以便 A/B。
 */
function searchBaseFor(auth) {
  if (SEARCH_BASE_OVERRIDE) return SEARCH_BASE_OVERRIDE;
  /*
   * 自建/诊断网关（CODEBUDDY_ENDPOINT）通常把 chat 和搜索放在同一 origin；
   * 先按它推导，避免把 WorkBuddy 的 key 发到默认区域域名。
   */
  if (EXPLICIT_ENDPOINT) {
    try {
      const origin = new URL(EXPLICIT_ENDPOINT).origin;
      /*
       * copilot.tencent.com 是 **chat** 网关，国内版的搜索产品端点是
       * www.workbuddy.cn；把搜索错发到 chat 网关会 404/401。
       * 其它显式 origin（自建/桩/WorkBuddy 产品域）与搜索同源。
       */
      if (!origin.includes('copilot.tencent.com')) return origin;
    } catch { /* 非法 URL：继续按账号区域 */ }
  }
  if (auth?.region === 'global') return 'https://www.workbuddy.ai';
  if (auth?.region === 'cn') return 'https://www.workbuddy.cn';
  const hint = `${auth?.endpoint || ''} ${auth?.domain || ''}`.toLowerCase();
  if (hint.includes('workbuddy.ai')) return 'https://www.workbuddy.ai';
  if (hint.includes('codebuddy.ai')) return 'https://www.codebuddy.ai';
  return 'https://www.workbuddy.cn';
}

function searchVersionFor(auth) {
  if (SEARCH_VERSION_OVERRIDE) return SEARCH_VERSION_OVERRIDE;
  if (auth?.source === 'plugin') {
    return pluginClientVersion(auth.region === 'global' ? 'global' : 'cn');
  }
  return APP_VERSION;
}

// ── Miora 媒体生成（视频：text/frame/reference；图片：generate/edit）──────
const MEDIA_TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const MEDIA_WAIT_MAX_S = MAX_VIDEO_WAIT_MS / 1000;

/** 视频 / 图片共用的错误响应；type 按 code 前缀区分，失败日志统一走 media failed。 */
function respondMediaError(res, err, fallbackPrefix = 'VIDEO') {
  const status = err instanceof MioraVideoError ? err.status : (Number(err?.status) || 502);
  const headers = err?.retryAfter ? { 'Retry-After': String(err.retryAfter) } : {};
  const code = err?.code || `${fallbackPrefix}_ERROR`;
  // 未分类异常没有 IMAGE_/VIDEO_ 前缀时，按调用来源（提交/查询路径）归类，
  // 不能把图片侧的 TypeError 一概记成 video。
  const kind = code.startsWith('IMAGE_')
    ? 'image'
    : (code.startsWith('VIDEO_') ? 'video' : fallbackPrefix.toLowerCase());
  if (status >= 500) log('media failed', kind, status, code, shortError(err?.message || err, 200));
  const type = status === 429
    ? 'rate_limit_error'
    : (code.endsWith('_NOT_READY') || code.endsWith('_NO_OUTPUT')
      ? `${kind}_not_ready`
      : `${kind}_generation_error`);
  return json(res, status, {
    error: {
      message: `workbuddy-bridge: ${shortError(err?.message || err, 300)}`,
      type,
      code,
      // 上游自己的错误码（如 CONTENT_SAFETY / 14407）对排障很有用，别只留在日志里。
      ...(err?.upstreamCode !== undefined && err?.upstreamCode !== null
        ? { upstream_code: err.upstreamCode }
        : {}),
    },
  }, headers);
}

async function mediaAuth(prefix) {
  try {
    return { auth: await resolveAuth() };
  } catch (e) {
    return {
      error: {
        status: 401,
        body: {
          error: {
            message: `workbuddy-bridge: ${shortError(e?.message || e, 300)}`,
            type: 'authentication_error',
            code: `${prefix}_NO_CREDENTIAL`,
          },
        },
      },
    };
  }
}

/**
 * 账号积分余额（生成类“消耗”估算用）。
 *
 * 上游不回报单次视频/图片的积分，只能拿提交前后的余额差做估算。
 * 读不到就返回 null —— 余额是锦上添花，绝不能阻断已经计费的提交。
 */
async function quotaBalance(auth) {
  try {
    // 估算不该给提交添两次最长 15 秒的等待：读不到余额就放弃，creditEstimate=null。
    const quota = await fetchQuota(auth, { timeoutMs: 5000 });
    return typeof quota?.total === 'number' ? quota.total : null;
  } catch {
    return null;
  }
}

// ── 媒体提交幂等（防客户端超时重试造成重复扣费）──────────────────────────
const MEDIA_IDEMPOTENCY_MS = numEnv('WORKBUDDY_MEDIA_IDEMPOTENCY_MS', 10 * 60 * 1000, { min: 0 });
const mediaIdemCache = new Map();

/**
 * 同一个 `Idempotency-Key` + 账号 + 媒体类型在窗口内只提交一次。
 * 并发重复请求共享同一个 pending Promise；命中时回 `X-WorkBuddy-Idempotent-Replay: 1`。
 * 没有 header 时不启用（不擅自把两个相同的 prompt 合并，用户可能真的要画两张）。
 */
async function withMediaIdempotency(req, res, kind, auth, fn) {
  const raw = String(req.headers['idempotency-key'] || '').trim().slice(0, 200);
  if (!raw || MEDIA_IDEMPOTENCY_MS <= 0) return fn();
  const account = auth?.userId || auth?.uid || '';
  const key = createHash('sha256').update(`${kind}|${account}|${raw}`).digest('hex');
  const now = Date.now();
  for (const [cachedKey, cached] of mediaIdemCache) {
    if (now - cached.at >= MEDIA_IDEMPOTENCY_MS) mediaIdemCache.delete(cachedKey);
  }
  const hit = mediaIdemCache.get(key);
  if (hit) {
    res.setHeader('X-WorkBuddy-Idempotent-Replay', '1');
    return hit.pending ? hit.pending : hit.result;
  }
  const pending = Promise.resolve().then(fn);
  mediaIdemCache.set(key, { at: now, pending });
  try {
    const result = await pending;
    mediaIdemCache.set(key, { at: Date.now(), result });
    return result;
  } catch (e) {
    mediaIdemCache.delete(key);
    throw e;
  }
}

/**
 * 提交（视频 / 图片共用）。`defaultMode` 让路径带上语义：
 * `/v1/images` = 文生图，`/v1/images/edits` = 图生图（body 显式 mode 优先）。
 */
async function handleMediaSubmit(req, res, { submit, kind, label, prefix, defaultMode = '' }) {
  const startedAt = Date.now();
  let raw;
  try {
    raw = await readBody(req);
  } catch (e) {
    if (e.code === 'BODY_TOO_LARGE') {
      // 413 也是一次真实的媒体请求失败，进账本（否则用量页只能看到成功/参数错误）。
      recordRequest({
        model: kind,
        kind,
        stream: false,
        ms: Date.now() - startedAt,
        ok: false,
        status: 413,
        code: `${prefix}_PAYLOAD_TOO_LARGE`,
        error: `${label} request body exceeds ${MAX_BODY_BYTES} bytes`,
      });
      return rejectTooLarge(
        req,
        res,
        'openai',
        `${label} request body too large (limit ${MAX_BODY_BYTES} bytes); `
          + 'use miora fileKeys/https URLs for large images, or raise WORKBUDDY_MAX_BODY_BYTES',
        `${prefix}_PAYLOAD_TOO_LARGE`,
      );
    }
    throw e;
  }
  let body;
  try { body = JSON.parse(raw); }
  catch {
    return json(res, 400, {
      error: {
        message: 'workbuddy-bridge: invalid JSON body',
        type: 'invalid_request',
        code: `${prefix}_INVALID_INPUT`,
      },
    });
  }

  const resolved = await mediaAuth(prefix);
  if (resolved.error) return json(res, resolved.error.status, resolved.error.body);
  try {
    let payload = body;
    if (defaultMode && body && typeof body === 'object' && !Array.isArray(body) && body.mode === undefined) {
      payload = { ...body, mode: defaultMode };
    }
    /*
     * 余额要在**本地校验通过、即将发上游**时读：放在 submit 之前会让「未知字段/
     * 图片路径写错」这类 400 也先等一次余额接口（最长 5 秒），纯属浪费。
     */
    let balanceBefore = null;
    const media = await withMediaIdempotency(req, res, kind, resolved.auth, () => submit(resolved.auth, payload, {
      baseUrl: VIDEO_BASE_OVERRIDE || undefined,
      // 提交前预算：多张 inline 图片叠加不能先长到几十 MB 再被 413 顶回来。
      maxBodyBytes: MAX_BODY_BYTES,
      onBeforeRequest: async () => { balanceBefore = await quotaBalance(resolved.auth); },
    }));
    /*
     * 生成消耗只能估算：提交前后各读一次账号余额，差值写进账本（creditEstimate）。
     * 差值 ≤ 0 / 读不到 → 不记（界面显示「—」），绝不把“没测到”写成 0。
     * 同步失败就不必再读一次（本来也不会记 creditEstimate）。
     */
    const failedTask = media.status === 'failed' || media.status === 'cancelled';
    const balanceAfter = failedTask ? null : await quotaBalance(resolved.auth);
    const creditEstimate = balanceBefore !== null && balanceAfter !== null && balanceBefore > balanceAfter
      ? Math.round((balanceBefore - balanceAfter) * 10000) / 10000
      : null;
    /*
     * 上游可能同步跑完（`media.sync === true`）：这时 202 是错的语义，
     * 任务已经是终态，结果/错误就在这次响应里。HTTP 200 让调用方不必再查；
     * 账本也按真实成败记（同步失败不能再算一次“成功提交”）。
     */
    const terminal = media.status === 'completed' || media.status === 'failed' || media.status === 'cancelled';
    const syncTerminal = media.sync === true && terminal;
    const generationFailed = media.status === 'failed' || media.status === 'cancelled';
    const httpStatus = syncTerminal ? 200 : 202;
    recordRequest({
      model: kind,
      kind,
      stream: false,
      ms: Date.now() - startedAt,
      ok: !generationFailed,
      status: httpStatus,
      code: generationFailed ? `${prefix}_GENERATION_FAILED` : null,
      ...(generationFailed
        ? { error: media.error?.message || `upstream ${kind} task ${media.status}` }
        : {}),
      ...(!generationFailed && creditEstimate !== null ? { creditEstimate } : {}),
    });
    log(`${label} submit id=${media.id} mode=${media.mode} status=${media.status}`
      + `${media.sync ? ' sync=true' : ''}`
      + `${media.output?.urls?.length ? ` outputs=${media.output.urls.length}` : ''}`
      + `${generationFailed ? ` error=${shortError(media.error?.message || media.status, 200)}` : ''}`);
    return json(res, httpStatus, media, { 'Cache-Control': 'no-store' });
  } catch (e) {
    recordRequest({
      model: kind, kind, stream: false, ms: Date.now() - startedAt,
      ok: false, status: e?.status || 502, code: e?.code || null, error: e?.message || String(e),
    });
    return respondMediaError(res, e, prefix);
  }
}

/**
 * 查询 / 下载（视频 / 图片共用）。
 * `?wait=N` 让桥代客户端轮询 N 秒（上限 60）；只接受整数秒，
 * 收到 `wait=abc` 要明确拒绝，而不是当 0 静默返回“还在生成”。
 */
async function handleMediaLookup(req, res, pathname, url, { basePath, query, label, prefix }) {
  const rest = pathname.slice(basePath.length);
  const wantsContent = rest.endsWith('/content');
  const rawId = wantsContent ? rest.slice(0, -'/content'.length) : rest;
  let id;
  try { id = decodeURIComponent(rawId); }
  catch {
    return json(res, 400, {
      error: {
        message: `workbuddy-bridge: malformed ${label} id`,
        type: 'invalid_request',
        code: `${prefix}_INVALID_INPUT`,
      },
    });
  }
  if (!MEDIA_TASK_ID_RE.test(id)) {
    return json(res, 400, {
      error: {
        message: `workbuddy-bridge: malformed ${label} id`,
        type: 'invalid_request',
        code: `${prefix}_INVALID_INPUT`,
      },
    });
  }

  const waitRaw = url.searchParams.get('wait');
  let waitMs = 0;
  if (waitRaw !== null && waitRaw !== '') {
    if (!/^\d{1,4}$/.test(waitRaw)) {
      return json(res, 400, {
        error: {
          message: `workbuddy-bridge: wait must be an integer number of seconds (0-${MEDIA_WAIT_MAX_S})`,
          type: 'invalid_request',
          code: `${prefix}_INVALID_INPUT`,
        },
      });
    }
    waitMs = Math.min(Number(waitRaw) * 1000, MAX_VIDEO_WAIT_MS);
  }

  const resolved = await mediaAuth(prefix);
  if (resolved.error) return json(res, resolved.error.status, resolved.error.body);
  try {
    const media = await query(resolved.auth, id, {
      baseUrl: VIDEO_BASE_OVERRIDE || undefined,
      waitMs,
    });
    if (!wantsContent) return json(res, 200, media, { 'Cache-Control': 'no-store' });
    if (media.status !== 'completed') {
      return json(res, 409, {
        error: {
          message: `workbuddy-bridge: ${label} ${id} is ${media.status}; no downloadable output yet`,
          type: `${label}_not_ready`,
          code: `${prefix}_NOT_READY`,
        },
      });
    }
    if (!media.output?.url) {
      /*
       * 上游说 completed 却没给 https 产物：这不是「没生成完」，重试查询也许能拿到，
       * 但绝不能再报 409 NOT_READY（客户端会以为继续等就行）。明确 502 + 可区分的 code。
       */
      return json(res, 502, {
        error: {
          message: `workbuddy-bridge: ${label} ${id} is completed but Miora returned no https output; query again later`,
          type: `${label}_generation_error`,
          code: `${prefix}_NO_OUTPUT`,
        },
      });
    }
    res.writeHead(302, {
      Location: media.output.url,
      'Cache-Control': 'no-store',
      ...SECURITY_HEADERS,
    });
    return res.end();
  } catch (e) {
    return respondMediaError(res, e, prefix);
  }
}

const handleVideoSubmit = (req, res) => handleMediaSubmit(req, res, {
  submit: submitVideo, kind: 'video', label: 'video', prefix: 'VIDEO',
});
const handleImageGenerate = (req, res) => handleMediaSubmit(req, res, {
  submit: submitImage, kind: 'image', label: 'image', prefix: 'IMAGE', defaultMode: 'generate',
});
const handleImageEdit = (req, res) => handleMediaSubmit(req, res, {
  submit: submitImage, kind: 'image', label: 'image', prefix: 'IMAGE', defaultMode: 'edit',
});
const handleVideoLookup = (req, res, pathname, url) => handleMediaLookup(req, res, pathname, url, {
  basePath: '/v1/videos/', query: queryVideo, label: 'video', prefix: 'VIDEO',
});
const handleImageLookup = (req, res, pathname, url) => handleMediaLookup(req, res, pathname, url, {
  basePath: '/v1/images/', query: queryImage, label: 'image', prefix: 'IMAGE',
});

// ── OpenAI Images 兼容门面 ────────────────────────────────────────────────
/*
 * 标准客户端（Cherry Studio / Open WebUI / LobeChat）只认
 * `POST /v1/images/generations` 的同步语义，不认本项目的异步任务 id。
 * 这里复用现有 submitImage/queryImage：提交后最多等 N 秒；同步完成直接回
 * `{created,data:[{url|b64_json}]}`，仍未完成回 202 + job id（非标准降级，
 * 文档会说明客户端可能不认）。自定义 `/v1/images` 保持原样。
 */
const OPENAI_IMAGE_SYNC_WAIT_S = numEnv('WORKBUDDY_IMAGE_SYNC_WAIT_S', 90, { min: 0, max: 300 });
const OPENAI_IMAGE_B64_MAX_BYTES = numEnv('WORKBUDDY_IMAGE_B64_MAX_BYTES', 20 * 1024 * 1024, { min: 1024 });
const OPENAI_IMAGE_ALLOWED_FIELDS = new Set([
  'prompt', 'model', 'n', 'size', 'quality', 'response_format', 'style', 'user',
  'background', 'moderation', 'output_compression', 'output_format', 'partial_images', 'stream',
]);
const isOpenAIImageTerminal = (status) => ['completed', 'failed', 'cancelled'].includes(status);

function openAIImageError(res, status, message, code = 'IMAGE_INVALID_INPUT') {
  return json(res, status, {
    error: { message: `workbuddy-bridge: ${message}`, type: 'image_generation_error', code },
  });
}

async function imageUrlToBase64(url) {
  const safe = publicHttpsUrl(url, 'image output URL', 'IMAGE_NO_OUTPUT');
  const res = await fetch(safe, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`image download failed HTTP ${res.status}`);
  const declared = Number(res.headers.get('content-length') || 0);
  if (declared > OPENAI_IMAGE_B64_MAX_BYTES) {
    throw new Error(`image is larger than ${OPENAI_IMAGE_B64_MAX_BYTES} bytes`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > OPENAI_IMAGE_B64_MAX_BYTES) {
    throw new Error(`image is larger than ${OPENAI_IMAGE_B64_MAX_BYTES} bytes`);
  }
  return buf.toString('base64');
}

async function handleOpenAIImagesGenerations(req, res) {
  const startedAt = Date.now();
  let raw;
  try {
    raw = await readBody(req);
  } catch (e) {
    if (e.code === 'BODY_TOO_LARGE') {
      recordRequest({
        model: 'image', kind: 'image', stream: false, ms: Date.now() - startedAt,
        ok: false, status: 413, code: 'IMAGE_PAYLOAD_TOO_LARGE',
        error: `image request body exceeds ${MAX_BODY_BYTES} bytes`,
      });
      return rejectTooLarge(req, res, 'openai', `image request body too large (limit ${MAX_BODY_BYTES} bytes)`,
        'IMAGE_PAYLOAD_TOO_LARGE');
    }
    throw e;
  }
  let body;
  try { body = JSON.parse(raw); }
  catch { return openAIImageError(res, 400, 'invalid JSON body'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return openAIImageError(res, 400, 'body must be a JSON object');
  }
  const unknown = Object.keys(body).filter((key) => !OPENAI_IMAGE_ALLOWED_FIELDS.has(key));
  if (unknown.length) {
    return openAIImageError(res, 400,
      `unknown field(s): ${unknown.join(', ')}; accepted: ${[...OPENAI_IMAGE_ALLOWED_FIELDS].join(', ')}`);
  }
  if (typeof body.prompt !== 'string' || !body.prompt.trim()) {
    return openAIImageError(res, 400, 'prompt is required');
  }
  const n = body.n === undefined ? 1 : Number(body.n);
  if (!Number.isInteger(n) || n !== 1) {
    return openAIImageError(res, 400, 'n must be 1 (multiple images would multiply billing)');
  }
  const responseFormat = body.response_format === undefined ? 'url' : body.response_format;
  if (responseFormat !== 'url' && responseFormat !== 'b64_json') {
    return openAIImageError(res, 400, 'response_format must be "url" or "b64_json"');
  }
  if (body.stream === true) {
    return openAIImageError(res, 400, 'stream=true is not supported; use the custom /v1/images job API');
  }

  const input = {
    prompt: body.prompt,
    mode: 'generate',
    ...(body.size !== undefined ? { size: body.size } : {}),
    ...(body.quality !== undefined ? { quality: body.quality } : {}),
  };
  const resolved = await mediaAuth('IMAGE');
  if (resolved.error) return json(res, resolved.error.status, resolved.error.body);
  try {
    let balanceBefore = null;
    const submitted = await withMediaIdempotency(req, res, 'image', resolved.auth, () => submitImage(resolved.auth, input, {
      baseUrl: VIDEO_BASE_OVERRIDE || undefined,
      maxBodyBytes: MAX_BODY_BYTES,
      onBeforeRequest: async () => { balanceBefore = await quotaBalance(resolved.auth); },
    }));
    const failedAtSubmit = submitted.status === 'failed' || submitted.status === 'cancelled';
    const balanceAfter = failedAtSubmit ? null : await quotaBalance(resolved.auth);
    const creditEstimate = balanceBefore !== null && balanceAfter !== null && balanceBefore > balanceAfter
      ? Math.round((balanceBefore - balanceAfter) * 10000) / 10000
      : null;

    let media = submitted;
    const deadline = Date.now() + OPENAI_IMAGE_SYNC_WAIT_S * 1000;
    while (!isOpenAIImageTerminal(media.status) && Date.now() < deadline) {
      const waitMs = Math.min(Math.max(0, deadline - Date.now()), MAX_VIDEO_WAIT_MS);
      try {
        media = await queryImage(resolved.auth, media.id, {
          baseUrl: VIDEO_BASE_OVERRIDE || undefined,
          waitMs,
        });
      } catch (e) {
        log('openai images: query while waiting failed', e.message);
        break;
      }
    }

    const failed = media.status === 'failed' || media.status === 'cancelled';
    const terminal = isOpenAIImageTerminal(media.status);
    let httpStatus = terminal ? (failed ? 400 : 200) : 202;
    let payload;
    if (terminal && failed) {
      payload = {
        error: {
          message: `workbuddy-bridge: ${media.error?.message || 'image generation failed'}`,
          type: 'image_generation_error',
          code: 'IMAGE_GENERATION_FAILED',
        },
      };
    } else if (terminal) {
      const url = media.output?.url;
      if (!url) {
        httpStatus = 502;
        payload = {
          error: {
            message: 'workbuddy-bridge: image completed but upstream returned no https output; query again later',
            type: 'image_generation_error',
            code: 'IMAGE_NO_OUTPUT',
          },
        };
      } else if (responseFormat === 'b64_json') {
        try {
          payload = { created: Math.floor(Date.now() / 1000), data: [{ b64_json: await imageUrlToBase64(url) }] };
        } catch (e) {
          httpStatus = 502;
          payload = {
            error: {
              message: `workbuddy-bridge: ${e.message}`,
              type: 'image_generation_error',
              code: 'IMAGE_NO_OUTPUT',
            },
          };
        }
      } else {
        payload = { created: Math.floor(Date.now() / 1000), data: [{ url }] };
      }
    } else {
      // 非标准降级：标准客户端可能不认 202；文档要求调用方按 job id 查询。
      payload = {
        id: media.id,
        object: 'image',
        status: media.status,
        sync: false,
        created: Math.floor(Date.now() / 1000),
        model: media.model || '',
      };
    }

    recordRequest({
      model: 'image', kind: 'image', stream: false, ms: Date.now() - startedAt,
      ok: httpStatus === 200 || httpStatus === 202,
      status: httpStatus,
      code: httpStatus === 400 ? 'IMAGE_GENERATION_FAILED'
        : httpStatus === 502 ? 'IMAGE_NO_OUTPUT' : null,
      ...(httpStatus === 400 || httpStatus === 502
        ? { error: payload?.error?.message || 'image generation failed' }
        : {}),
      ...(!failed && creditEstimate !== null ? { creditEstimate } : {}),
    });
    const headers = {
      'Cache-Control': 'no-store',
      ...(httpStatus === 202 ? {
        'X-WorkBuddy-Job-Id': media.id,
        Location: `/v1/images/${media.id}`,
        'Retry-After': '5',
      } : {}),
    };
    return json(res, httpStatus, payload, headers);
  } catch (e) {
    recordRequest({
      model: 'image', kind: 'image', stream: false, ms: Date.now() - startedAt,
      ok: false, status: e?.status || 502, code: e?.code || null, error: e?.message || String(e),
    });
    return respondMediaError(res, e, 'IMAGE');
  }
}

/**
 * 搜索端的头与 chat 不同：WorkBuddy CLI 的 WebSearch 用的是 WorkBuddy 身份
 * （X-IDE-Type/Name=WorkBuddy、X-Agent-Intent=craft、独立的 trace id）。
 * 这里按同一形状构造，不带 CodeBuddy/VSCode 指纹。
 */
function buildSearchHeaders(auth, conversationId) {
  const version = searchVersionFor(auth);
  const messageId = trace();
  const traceId = trace();
  const h = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'X-Requested-With': 'XMLHttpRequest',
    'User-Agent': `WorkBuddy/${version}`,
    Authorization: `Bearer ${API_KEY || auth.access}`,
    'X-Agent-Intent': 'craft',
    'X-Conversation-ID': conversationId || trace(),
    'X-Conversation-Request-ID': messageId,
    'X-Conversation-Message-ID': messageId,
    'X-Request-ID': messageId,
    'X-Product': 'SaaS',
    'X-IDE-Type': 'WorkBuddy',
    'X-IDE-Name': 'WorkBuddy',
    'X-IDE-Version': version,
    'X-Request-Trace-Id': traceId,
  };
  const userId = auth.userId || auth.uid;
  if (userId) h['X-User-Id'] = userId;
  if (auth.enterpriseId) h['X-Enterprise-Id'] = auth.enterpriseId;
  if (auth.domain) h['X-Domain'] = auth.domain;
  return h;
}

/** 一次搜索请求；401/403 时刷新/接管凭据后重试一次（与 chat 路径一致）。 */
async function searchUpstream(auth, requestBody, conversationId, clientSignal) {
  const endpoint = `${searchBaseFor(auth)}${SEARCH_PATH}`;
  /*
   * 整个搜索（含 401 刷新、换凭据、5xx 重试）共享一个预算。原先每个 attempt
   * 各算一次 20s，最坏会把一次搜索拖到 ~80s；dsh 早就放弃了，桥却还在扣额度。
   */
  const deadline = Date.now() + SEARCH_TIMEOUT_MS;
  const timeoutError = () => {
    const err = /** @type {Error & { code?: string }} */ (new Error(
      `web search timed out after ${SEARCH_TIMEOUT_MS}ms`,
    ));
    err.code = 'WEB_SEARCH_TIMEOUT';
    return err;
  };
  const abortedError = () => {
    const err = /** @type {Error & { code?: string }} */ (new Error('web search aborted'));
    err.code = 'WEB_SEARCH_ABORTED';
    return err;
  };
  const attempt = async (a) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw timeoutError();
    const timeoutSignal = AbortSignal.timeout(remaining);
    const signal = combineAbortSignals([clientSignal, timeoutSignal]);
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        // 与 WorkBuddy 客户端一致：允许网关做同站重定向（例如区域入口跳转）。
        redirect: 'follow',
        headers: buildSearchHeaders(a, conversationId),
        body: JSON.stringify(requestBody),
        signal,
      });
      let text;
      try {
        text = await res.text();
      } catch (error) {
        if (clientSignal?.aborted) throw abortedError();
        const readError = /** @type {Error & { code?: string }} */ (new Error(
          `web search response read failed: ${error?.message || error}`,
        ));
        readError.code = 'WEB_SEARCH_TRANSPORT';
        throw readError;
      }
      let parsed = null;
      try { parsed = JSON.parse(text); } catch { /* 非 JSON 原文留给错误处理 */ }
      return { res, text, parsed };
    } catch (error) {
      // 先看调用方取消：fetch/undici 的 abort 错误也可能自带 code（如 ABORT_ERR），
      // 不能因为“有 code”就把取消误报成上游 502。
      if (clientSignal?.aborted) throw abortedError();
      if (error?.code === 'WEB_SEARCH_TRANSPORT'
        || error?.code === 'WEB_SEARCH_ABORTED'
        || error?.code === 'WEB_SEARCH_TIMEOUT') throw error;
      const timeout = error?.name === 'TimeoutError' || /timeout|timed out/i.test(String(error?.message || ''));
      const err = /** @type {Error & { code?: string }} */ (new Error(
        timeout ? `web search timed out after ${SEARCH_TIMEOUT_MS}ms` : `web search request failed: ${error?.message || error}`,
      ));
      err.code = timeout ? 'WEB_SEARCH_TIMEOUT' : 'WEB_SEARCH_TRANSPORT';
      throw err;
    }
  };

  let currentAuth = auth;
  let result = await attempt(currentAuth);
  if ((result.res.status === 401 || result.res.status === 403)
    && currentAuth.source !== 'api-key' && currentAuth.refresh) {
    const next = await refreshAuth(currentAuth).catch(() => null);
    if (next) {
      currentAuth = next;
      result = await attempt(currentAuth);
    }
  }
  if (result.res.status === 401 || result.res.status === 403) {
    const alt = await resolveCredentialAlternative(currentAuth).catch(() => null);
    if (alt) {
      let fresh = alt;
      if (fresh.refresh && fresh.expiresAt - REFRESH_SKEW_MS < Date.now()) {
        const next = await refreshAuth(fresh).catch(() => null);
        if (next) fresh = next;
      }
      currentAuth = fresh;
      result = await attempt(currentAuth);
    }
  }
  // 与 chat 路径一致：搜索网关的短时 5xx 也原样重试（只重试常见的四个状态码）。
  for (let i = 0; UPSTREAM_5XX_RETRY_STATUSES.has(result.res.status) && i < UPSTREAM_5XX_RETRIES; i += 1) {
    const wait = UPSTREAM_5XX_RETRY_DELAY_MS * (i + 1);
    if (wait > 0) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw timeoutError();
      await sleep(Math.min(wait, remaining));
      if (Date.now() >= deadline) throw timeoutError();
    }
    result = await attempt(currentAuth);
  }
  return { ...result, endpoint };
}

/**
 * 调 WorkBuddy 搜索并归一化。结果按 maxResults 截断；错误码区分凭据/限流/上游。
 * 不记录 query 原文（用户内容），只记录结果数与耗时。
 * @param {{ query: string, maxResults?: number, allowedDomains?: string[], freshness?: string }} request
 * @param {{ conversationId?: string, signal?: AbortSignal }} [options]
 */
async function workbuddySearch({ query, maxResults = SEARCH_DEFAULT_MAX_RESULTS, allowedDomains, freshness }, { conversationId, signal } = {}) {
  const auth = await resolveAuth();
  const requestBody = {
    query,
    type: 'text2text',
    max_results: Math.min(Math.max(Number(maxResults) || 5, 1), SEARCH_MAX_RESULTS),
    ...(Array.isArray(allowedDomains) && allowedDomains.length
      ? { allowed_domains: allowedDomains.filter((d) => typeof d === 'string' && d.trim()).slice(0, 20) }
      : {}),
    ...(typeof freshness === 'string' && SEARCH_FRESHNESS_RE.test(freshness) ? { freshness } : {}),
  };
  const startedAt = Date.now();
  const { res, text, parsed, endpoint } = await searchUpstream(auth, requestBody, conversationId, signal);
  if (res.status === 401 || res.status === 403) {
    const err = /** @type {Error & { code?: string, status?: number }} */ (new Error(
      auth.source === 'api-key'
        ? 'workbuddy search rejected the API key — check WORKBUDDY_SEARCH_BASE / credentials'
        : 'workbuddy search login expired — re-login in the WorkBuddy desktop app',
    ));
    err.code = 'WEB_SEARCH_AUTH';
    err.status = 502;
    throw err;
  }
  if (!res.ok) {
    const err = /** @type {Error & { code?: string, status?: number, retryAfterMs?: number }} */ (new Error(
      String(parsed?.msg || parsed?.message || text || `workbuddy search HTTP ${res.status}`).slice(0, 300),
    ));
    err.code = res.status === 429 || Number(parsed?.code) === 15001 ? 'WEB_SEARCH_RATE_LIMITED' : 'WEB_SEARCH_UPSTREAM';
    err.status = res.status === 429 || Number(parsed?.code) === 15001 ? 429 : 502;
    err.retryAfterMs = upstreamRetryAfterMs(res, text) ?? 5000;
    throw err;
  }
  /*
   * 上游 200 但返回 HTML / 空体时，JSON.parse 会得到 null；旧逻辑把它当成
   * “0 条结果”回 200，面板自检也会通过 —— 故障被伪装成成功。这里把
   * “不是对象 / 没有 results 数组”明确归为上游错误。
   */
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const err = /** @type {Error & { code?: string, status?: number }} */ (new Error(
      'workbuddy search returned a non-JSON response',
    ));
    err.code = 'WEB_SEARCH_UPSTREAM';
    err.status = 502;
    throw err;
  }
  if (parsed.code !== undefined && Number(parsed.code) !== 0) {
    const code = Number(parsed.code);
    const err = /** @type {Error & { code?: string, status?: number, retryAfterMs?: number }} */ (new Error(
      String(parsed.msg || parsed.message || `workbuddy search error ${parsed.code}`).slice(0, 300),
    ));
    err.code = code === 15001 ? 'WEB_SEARCH_RATE_LIMITED' : 'WEB_SEARCH_UPSTREAM';
    err.status = code === 15001 ? 429 : 502;
    err.retryAfterMs = upstreamRetryAfterMs(res, text) ?? 5000;
    throw err;
  }
  const data = parsed.data && typeof parsed.data === 'object' && !Array.isArray(parsed.data)
    ? parsed.data
    : parsed;
  if (!Array.isArray(data.results)) {
    const err = /** @type {Error & { code?: string, status?: number }} */ (new Error(
      'workbuddy search response is missing a results array',
    ));
    err.code = 'WEB_SEARCH_UPSTREAM';
    err.status = 502;
    throw err;
  }
  const rawResults = data.results;
  const results = rawResults
    // 只接受 http(s) 绝对地址：避免把 javascript:/file: 之类的结果交给下游渲染。
    .filter((r) => r && typeof r.url === 'string' && /^https?:\/\//i.test(r.url))
    .map((r) => ({
      title: typeof r.title === 'string' && r.title ? r.title : r.url,
      url: r.url,
      snippet: typeof r.snippet === 'string' ? r.snippet : '',
      ...(typeof r.site === 'string' && r.site ? { site: r.site } : {}),
      ...(typeof r.favicon === 'string' && r.favicon ? { favicon: r.favicon } : {}),
      // 不同搜索网关的日期字段名不一；有就带上，没有不影响 provider。
      ...(typeof (r.publishedAt || r.published_at || r.page_age || r.date) === 'string'
        ? { publishedAt: r.publishedAt || r.published_at || r.page_age || r.date }
        : {}),
    }));
  const truncated = results.length > requestBody.max_results;
  const capped = truncated ? results.slice(0, requestBody.max_results) : results;
  return {
    provider: typeof data.provider === 'string' ? data.provider : '',
    results: capped,
    total_results: Number(data.total_results) || capped.length,
    response_time_ms: Number(data.response_time_ms) || (Date.now() - startedAt),
    truncated,
    endpoint,
    status: res.status,
  };
}

/**
 * dsh 的 `dsh-web-search-deepseek` provider 通过 Anthropic Messages 发送
 * `web_search_20250305`。桥在这里识别这种请求，直接返回 WorkBuddy 搜索结果
 * 的 Anthropic 形状（web_search_tool_result + text citations），不再打 DeepSeek。
 */
function nativeSearchTool(body) {
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  return tools.find((t) => t && (t.type === 'web_search_20250305'
    || (t.type === 'web_search' && t.name === 'web_search')));
}

function extractNativeSearchQuery(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  // 只取**最后一条 user**：最后一条是图片/空文本时不能回头搜更早的旧问题。
  let message = null;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'user') { message = messages[i]; break; }
  }
  if (!message) return '';
  const text = typeof message.content === 'string'
    ? message.content
    : Array.isArray(message.content)
      ? message.content.map((part) => (part && part.type === 'text' ? part.text || '' : '')).join('\n')
      : '';
  return text.replace(/^\s*Perform a web search for the query:\s*/i, '').trim();
}

function anthropicSearchMessage(model, search, query) {
  const toolUseId = `srvtoolu_${trace().slice(0, 24)}`;
  /** @type {any[]} */
  const blocks = [{
    // Anthropic 的 tool_use_id 必须指向同一响应里的 server_tool_use；原实现
    // 只回 tool_result，严格客户端会把它当成悬空引用。dsh provider 按 type
    // 过滤，不依赖块顺序，因此补在前面是安全的。
    type: 'server_tool_use',
    id: toolUseId,
    name: 'web_search',
    input: { query },
  }, {
    type: 'web_search_tool_result',
    tool_use_id: toolUseId,
    content: search.results.map((r) => ({
      type: 'web_search_result',
      title: r.title,
      url: r.url,
      ...(r.publishedAt ? { page_age: r.publishedAt } : {}),
    })),
  }];
  const citations = search.results
    .filter((r) => r.snippet)
    .map((r) => ({
      type: 'web_search_result_location',
      url: r.url,
      title: r.title,
      cited_text: r.snippet,
    }));
  if (citations.length) blocks.push({ type: 'text', text: '', citations });
  return {
    id: `msg_${trace().slice(0, 24)}`,
    type: 'message',
    role: 'assistant',
    model,
    content: blocks,
    stop_reason: 'end_turn',
    stop_sequence: null,
    /*
     * 不伪造 encrypted_content / encrypted_index：它们是 Anthropic 侧生成、
     * 用于多轮回放的 opaque 字段，桥无法凭空签发。dsh provider 只消费
     * web_search_tool_result 与 citations，因此这里如实省略。
     */
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      server_tool_use: { web_search_requests: 1 },
    },
  };
}

// ── Upstream call (with refresh retry and transient-400 retry) ───────────
/**
 * 用 node:http/https + keep-alive Agent 发一次上游请求，返回 IncomingMessage。
 *
 * 为什么不用全局 fetch：Node 内建 fetch（undici）的连接池不开放、空闲连接只留
 * ~4 秒，达不到「跨请求复用 TLS 连接」的目的。node:http 的 Agent 可以。
 * 返回的 res 兼容 bridge 现有消费方式（res.ok / res.status / res.text() /
 * res.body.getReader() 由下面的 shim 补齐）。
 */
function upstreamRequest(endpointUrl, { headers, body, signal }) {
  const url = new URL(endpointUrl);
  const doRequest = url.protocol === 'https:' ? httpsRequest : httpRequest;
  /*
   * 显式给 Content-Length：不设时 Node 会退回 `Transfer-Encoding: chunked`，
   * 上游要按块重组 1MB+ 的请求体；给长度后网关可以直接按总量读取与分配。
   * 大上下文（实测单次 40 万 token）下这是每个请求都要付一次的固定成本。
   */
  const payloadLength = body === undefined ? 0 : Buffer.byteLength(body);
  return new Promise((resolve, reject) => {
    let settled = false;
    let queueTimer = null;
    let headerTimer = null;
    const clearQueueTimer = () => {
      if (queueTimer) { clearTimeout(queueTimer); queueTimer = null; }
    };
    const clearHeaderTimer = () => {
      if (headerTimer) { clearTimeout(headerTimer); headerTimer = null; }
    };

    const req = doRequest(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        headers: { ...headers, 'Content-Length': String(payloadLength) },
        agent: agentFor(url.protocol),
      },
      (res) => {
        clearQueueTimer();
        clearHeaderTimer();
        resolve(res);
      },
    );
    req.once('socket', () => {
      if (settled) return;
      clearQueueTimer();
      // 连接建立后到响应头到达也不能无限等（DNS 卡住/TCP 半开/网关不响应）。
      if (UPSTREAM_FIRST_BYTE_TIMEOUT_MS > 0) {
        headerTimer = setTimeout(() => {
          if (settled) return;
          settled = true;
          const error = /** @type {Error & { code?: string }} */ (new Error(
            `upstream response-header timeout after ${UPSTREAM_FIRST_BYTE_TIMEOUT_MS}ms`,
          ));
          error.code = 'UPSTREAM_FIRST_BYTE_TIMEOUT';
          req.destroy(error);
          reject(error);
        }, UPSTREAM_FIRST_BYTE_TIMEOUT_MS);
      }
    });
    if (UPSTREAM_QUEUE_TIMEOUT_MS > 0) {
      queueTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        const error = /** @type {Error & { code?: string }} */ (new Error(
          `upstream socket queue timeout after ${UPSTREAM_QUEUE_TIMEOUT_MS}ms (maxSockets=${MAX_UPSTREAM_SOCKETS})`,
        ));
        error.code = 'UPSTREAM_QUEUE_TIMEOUT';
        req.destroy(error);
        reject(error);
      }, UPSTREAM_QUEUE_TIMEOUT_MS);
    }
    req.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearQueueTimer();
      clearHeaderTimer();
      reject(error);
    });
    if (signal) {
      if (signal.aborted) { req.destroy(new Error('aborted')); return; }
      const onAbort = () => req.destroy(new Error(signal.reason?.message || 'aborted'));
      signal.addEventListener('abort', onAbort, { once: true });
      req.on('close', () => signal.removeEventListener('abort', onAbort));
      req.on('response', (res) => res.on('close', () => signal.removeEventListener('abort', onAbort)));
    }
    req.end(body);
  });
}

/**
 * 从响应到达的那一刻起**就**开始攒数据，与调用方何时消费无关。
 *
 * 为什么必须在拿到响应时立刻挂监听：`IncomingMessage` 是「热」流 ——
 * 数据在网卡到达就派发，没有暂停机制。真实调用链里，响应回到
 * `callUpstream` 之后还要先等 `refreshAuth`（失败路径有 8 秒超时）
 * 才轮到读体；这段时间里没人 `data`/`end` 监听，等轮到读时流早已
 * `complete && destroyed`，**事件永远不会再触发**，`text()` 永久挂起、
 * 客户端只看到超时。这不是理论风险，是实测复现的线上卡死（上游回
 * 401 + 非 JSON 体时必现）。
 */
function shimResponse(res) {
  const chunks = [];
  let done = false;
  let failure = null;
  let settle;
  const finished = new Promise((r) => { settle = r; });

  res.on('data', (c) => { chunks.push(c); });
  res.on('end', () => { done = true; settle(); });
  res.on('aborted', () => { failure = failure || new Error('upstream aborted'); done = true; settle(); });
  res.on('error', (e) => { failure = failure || e; done = true; settle(); });
  res.on('close', () => {
    // 没等到 'end' 就 close = 连接被掐断：不能再等，否则永久挂起。
    if (!done) { failure = failure || new Error('upstream closed before response completed'); done = true; settle(); }
  });

  /*
   * 首字节超时放在这里，而不是 upstreamRequest：这里一进来就同步挂 data 监听，
   * 不会和 shimResponse 的缓冲抢流。只收到响应头、迟迟没有第一块体时才触发。
   */
  if (UPSTREAM_FIRST_BYTE_TIMEOUT_MS > 0) {
    let firstByteTimer = null;
    const clearFirstByteTimer = () => {
      if (firstByteTimer) { clearTimeout(firstByteTimer); firstByteTimer = null; }
    };
    firstByteTimer = setTimeout(() => {
      if (done) return;
      const error = /** @type {Error & { code?: string }} */ (new Error(
        `upstream first-byte timeout after ${UPSTREAM_FIRST_BYTE_TIMEOUT_MS}ms`,
      ));
      error.code = 'UPSTREAM_FIRST_BYTE_TIMEOUT';
      failure = failure || error;
      done = true;
      res.destroy(error);
      settle();
    }, UPSTREAM_FIRST_BYTE_TIMEOUT_MS);
    res.once('data', clearFirstByteTimer);
    res.once('end', clearFirstByteTimer);
    res.once('aborted', clearFirstByteTimer);
    res.once('error', clearFirstByteTimer);
    res.once('close', clearFirstByteTimer);
  }

  const bodyText = () => Buffer.concat(chunks).toString('utf8');

  return {
    ok: res.statusCode >= 200 && res.statusCode < 300,
    status: res.statusCode,
    headers: res.headers,
    text: async () => {
      if (!done) await finished;
      if (failure) throw failure;
      return bodyText();
    },
    body: new ReadableStream({
      async start(controller) {
        // 数据可能已经在 `text()` 之外的时机攒好了：先补发缓冲区，再接力实时事件。
        let sent = 0;
        const flush = () => {
          // 直接入队 Buffer：它本身就是 Uint8Array，`new Uint8Array(buf)` 会整块拷贝。
          // 流式大响应下这段拷贝是纯开销（适配器只读内容，不改底层字节）。
          while (sent < chunks.length) controller.enqueue(chunks[sent++]);
        };
        for (;;) {
          flush();
          if (done) break;
          const before = chunks.length;
          await Promise.race([finished, new Promise((r) => res.once('data', r))]);
          if (chunks.length === before && done) break;
        }
        flush();
        if (failure) controller.error(failure);
        else controller.close();
      },
      cancel() { res.destroy(); },
    }),
    // 诊断/重试逻辑用：这条连接是不是复用的（见 sendWithRetry）
    reusedSocket: res.reusedSocket === true,
  };
}

/**
 * 发送并处理「复用的空闲连接已被服务端掐断」：ECONNRESET / socket hang up
 * 发生在**复用** socket 且还没收到任何响应字节时，换新连接重试一次。
 */
// ── Local rate limiting (opt-in) ─────────────────────────────────────────
/**
 * 本地限流 —— 「保护账号配额」的唯一机制：单个失控的客户端（脚本 bug、
 * 死循环重试）能把账号打爆，而在此之前代码里零实现、文档里只有一句提醒。
 *
 * 两个独立旋钮、**默认全关**（0），关着时行为与没有本机制完全一致：
 *   WORKBUDDY_RATE_LIMIT_RPM               每分钟最多向上游发多少条
 *   WORKBUDDY_RATE_LIMIT_MIN_INTERVAL_MS   两条之间的最小间隔
 *
 * 超限行为（WORKBUDDY_RATE_LIMIT_MODE）：
 *   queue （默认）—— 排队等待，轮到再发（对齐 copilot-api 的 --wait 语义）；
 *   reject        —— 立刻 429 + Retry-After，适合会自行退避重试的客户端。
 *
 * 实现：许可分配走一条 promise 链**串行化** —— 并发请求按到达顺序排队，不惊群；
 * 等待循环对客户端断开敏感（abort 即退出队列，不占位）。闸门在读凭据 / 打上游
 * **之前**：被限流的请求不产生任何上游副作用。
 */
const RATE_LIMIT_RPM = Math.floor(numEnv('WORKBUDDY_RATE_LIMIT_RPM', 0, { min: 0 }));
const RATE_LIMIT_MIN_INTERVAL_MS = Math.floor(numEnv('WORKBUDDY_RATE_LIMIT_MIN_INTERVAL_MS', 0, { min: 0 }));
const RATE_LIMIT_MODE = process.env.WORKBUDDY_RATE_LIMIT_MODE === 'reject' ? 'reject' : 'queue';

const rateState = {
  /** scope -> { recent, lastStart, tail }：local 与每个 client key 各一个独立桶。 */
  byScope: new Map(),
  /** 触发计数：账本与控制台可见「被限流了多少次」。 */
  limited: 0,
};

/** 取（或建）调用方自己的限流桶 —— 桶之间互不影响（B2 凭据分层）。 */
function bucketFor(scope) {
  let bucket = rateState.byScope.get(scope);
  if (!bucket) {
    bucket = { recent: [], lastStart: 0, tail: Promise.resolve() };
    rateState.byScope.set(scope, bucket);
  }
  return bucket;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 现在能不能放行？不能则返回还需等待的毫秒数。 */
function rateWaitMs(now, bucket) {
  let wait = 0;
  if (RATE_LIMIT_RPM > 0) {
    const cutoff = now - 60_000;
    while (bucket.recent.length && bucket.recent[0] <= cutoff) bucket.recent.shift();
    if (bucket.recent.length >= RATE_LIMIT_RPM) {
      wait = Math.max(wait, bucket.recent[0] + 60_000 - now + 1);
    }
  }
  if (RATE_LIMIT_MIN_INTERVAL_MS > 0 && bucket.lastStart > 0) {
    wait = Math.max(wait, bucket.lastStart + RATE_LIMIT_MIN_INTERVAL_MS - now + 1);
  }
  return wait;
}

/**
 * 取一张「发往上游」的许可。
 * queue 模式等到许可返回；reject 模式超限抛 code=RATE_LIMITED（带 retryAfterMs）。
 * @returns {Promise<{ waitedMs: number, limited: boolean }>}
 */
async function acquireRateSlot(clientSignal, scope = 'local') {
  if (RATE_LIMIT_RPM <= 0 && RATE_LIMIT_MIN_INTERVAL_MS <= 0) return { waitedMs: 0, limited: false };
  const bucket = bucketFor(scope);
  const enter = Date.now();
  const prev = bucket.tail;
  let release;
  bucket.tail = new Promise((resolve) => { release = resolve; });
  await prev;
  let limited = false;
  try {
    for (;;) {
      const now = Date.now();
      const wait = rateWaitMs(now, bucket);
      if (wait <= 0) {
        bucket.recent.push(now);
        bucket.lastStart = now;
        return { waitedMs: now - enter, limited };
      }
      if (!limited) {
        limited = true;
        rateState.limited += 1;
        log(`rate limit engaged (mode=${RATE_LIMIT_MODE}): waiting ${wait}ms`);
      }
      if (RATE_LIMIT_MODE === 'reject') {
        // Node 惯用：给 Error 挂自定义字段（识别码 + Retry-After 毫秒数）
        const err = /** @type {Error & { code?: string, retryAfterMs?: number }} */ (new Error(`local rate limit exceeded; retry in ${Math.ceil(wait / 1000)}s`));
        err.code = 'RATE_LIMITED';
        err.retryAfterMs = wait;
        throw err;
      }
      if (clientSignal?.aborted) {
        const err = /** @type {Error & { code?: string }} */ (new Error('client aborted while waiting for a rate-limit slot'));
        err.code = 'RATE_LIMIT_ABORTED';
        throw err;
      }
      await sleep(Math.min(wait, 500));
    }
  } finally {
    release();
  }
}

async function callUpstream(bodyString, model, conversationId, clientSignal, { skipRateLimit = false } = {}) {
  // 限流闸门（opt-in；默认关）。放在最前：超限的请求连凭据都不读、更不打上游。
  // 限流桶按调用方分（local / 各 client key）—— B2 凭据分层的一部分。
  // 11128 的兜底重试是**同一次逻辑请求**，不能再占一个许可（RPM=1 时会白等 60s）。
  if (!skipRateLimit) await acquireRateSlot(clientSignal, requestScope.getStore()?.client || 'local');
  // 上游开始前的时刻戳（供端点计算 `X-WorkBuddy-Overhead-Ms`：
  // overhead = 上游请求发出前，桥自身做的前置处理耗时 —— 鉴权、读凭据、
  // payload 归一化、Anthropic→OpenAI 翻译。**不含限流排队**（那是我们主动
  // 让请求等的）也**不含上游等待**（那是上游的耗时）—— 口径精确、可复现。
  const upEnter = Date.now();

  // 凭据来源：api-key（显式覆盖）→ 桌面端 → 插件登录（auto，见 resolveAuth）。
  let auth = await resolveAuth();
  if (auth.source !== 'api-key' && auth.refresh && auth.expiresAt - REFRESH_SKEW_MS < Date.now()) {
    const next = await refreshAuth(auth);
    if (next) auth = next;
  }

  const attempt = (a) => {
    // WORKBUDDY_TIMEOUT_MS > 0 时给整个上游往返加超时（0/未设 = 不限，
    // LLM 长回答需要）；与客户端取消信号合并。
    const timeoutSignal = UPSTREAM_TIMEOUT_MS > 0 ? AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) : null;
    const signal = combineAbortSignals([clientSignal, timeoutSignal]);
    return upstreamRequest(`${a.endpoint}${CHAT_PATH}`, {
      headers: buildChatHeaders(a, model, conversationId),
      body: bodyString,
      signal,
    }).then(shimResponse);
  };

  const attemptWithStaleRetry = async (a) => {
    try {
      return await attempt(a);
    } catch (error) {
      if (clientSignal?.aborted) throw error;
      const msg = String(error?.message || error?.code || '');
      /*
       * ① 复用的空闲连接被上游掐断（服务器先关）→ 换新连接重试一次。
       *    新连接必然不是 reused；首次连接就失败属于真故障，不重试。
       */
      if (/ECONNRESET|socket hang up|EPIPE/i.test(msg)) {
        log('stale keep-alive socket, retrying once on a fresh connection');
        return attempt(a);
      }
      /*
       * ② **瞬时 DNS / 建连失败**：同样换新连接重试一次。
       *
       * 为什么必须有（2026-10-13 实测）：账本里 20 条
       * `getaddrinfo ENOTFOUND www.workbuddy.ai`，**17 条挤在同一个小时里** ——
       * 典型的解析器抖动（VPN/代理切换、DNS 缓存过期、上游 LB 换 IP），
       * 不是"域名不存在"。同一台机器随后连测 12 次解析全部成功、中位 0.2ms。
       *
       * 原先只认 ECONNRESET 那一族，于是这类抖动**一次都不重试**就直接
       * 500 给客户端 —— 用户看到「本地桥连接失败」，实际只是抖了一下。
       * 重试一次的代价是毫秒级，救回的却是一整轮对话（含已发送的上下文）。
       *
       * 注意 ENOTFOUND 也可能是真·域名配错；但那种情况重试一次同样立刻失败，
       * 成本仅一次解析，不会掩盖配置错误（错误原文照旧回给客户端）。
       */
      if (/ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNREFUSED|EADDRNOTAVAIL|network|getaddrinfo/i.test(msg)) {
        log(`transient transport failure (${shortError(msg, 80)}), retrying once in ${TRANSPORT_RETRY_DELAY_MS}ms`);
        /*
         * 隔一小会儿再试，而不是立刻重发：DNS 抖动往往是"这一刻的解析器不可用"，
         * 立刻重查很可能撞上同一个坏状态。延迟只在**失败路径**上产生，
         * 成功路径一分钱不花。
         */
        if (TRANSPORT_RETRY_DELAY_MS > 0) await sleep(TRANSPORT_RETRY_DELAY_MS);
        if (clientSignal?.aborted) throw error;
        return attempt(a);
      }
      throw error;
    }
  };

  let res = await attemptWithStaleRetry(auth);
  if (auth.source !== 'api-key' && (res.status === 401 || res.status === 403) && auth.refresh) {
    const next = await refreshAuth(auth);
    if (next) { auth = next; res = await attemptWithStaleRetry(auth); }
  }
  /*
   * 另一条凭据接管（默认只接同一账号）。
   * 桌面端与插件端如果是同一个账号，两把钥匙本来就是互通的；一把鉴权失败时
   * 自动换另一把，不改变钱包。不同账号默认不接管（那会静默换钱包），
   * 需要 WORKBUDDY_CREDENTIAL_FAILOVER=any 显式开启。
   */
  if (auth.source !== 'api-key' && (res.status === 401 || res.status === 403)) {
    const alt = await resolveCredentialAlternative(auth).catch(() => null);
    if (alt) {
      let fresh = alt;
      if (fresh.refresh && fresh.expiresAt - REFRESH_SKEW_MS < Date.now()) {
        const next = await refreshAuth(fresh).catch(() => null);
        if (next) fresh = next;
      }
      const previous = auth;
      log(`credential failover: ${previous.source} -> ${fresh.source}`
        + `${CREDENTIAL_FAILOVER === 'any' ? ' (any account)' : ' (same account)'}`);
      auth = fresh;
      // 换到不同账号时旧目录不再可信；至少清掉预校验依据，避免误杀新账号模型。
      if (previous.source !== auth.source
        || String(previous.uid || previous.userId || '') !== String(auth.uid || auth.userId || '')) {
        invalidateCatalogCache();
      }
      res = await attemptWithStaleRetry(auth);
    }
  }

  /*
   * 上游 429（code 14003）：按 UPSTREAM_429_WAITS 的计划在**桥这层**等待并原样重发，
   * 客户端没断就一直等到成功或计划用完。这期间上游还没开始流，重发没有副作用；
   * 客户端断开（abort）就立刻放弃，把已读到的 429 原样返回。
   */
  for (let i = 0; res.status === 429 && i < UPSTREAM_429_WAITS.length; i++) {
    const text = await res.text().catch(() => '');
    if (clientSignal?.aborted) return { res, bodyText: text, upstreamStartedAt: upEnter };
    const wait = Math.min(Math.max(upstreamRetryAfterMs(res, text) ?? UPSTREAM_429_WAITS[i], 0), 90_000);
    log(`upstream 429, bridge waits ${Math.round(wait / 1000)}s then retries (${i + 1}/${UPSTREAM_429_WAITS.length})`);
    await new Promise((r) => setTimeout(r, wait));
    if (clientSignal?.aborted) return { res, bodyText: text, upstreamStartedAt: upEnter };
    res = await attemptWithStaleRetry(auth);
    // 重试后的响应若不再是 429/400/2xx，同样要在这里把体读掉（见下面的说明）
    if (res.status !== 429 && res.status !== 400 && (res.status < 200 || res.status >= 300)) {
      const t = await res.text().catch(() => '');
      return { res, bodyText: t, upstreamStartedAt: upEnter };
    }
  }

  /*
   * 上游 5xx（网关/模型服务短时中断）：在桥这层等一小会儿原样重发。
   * 实测（2026-10-15）这类失败里多数 1 秒后重发即成功；不重试等于让用户
   * 白白丢掉一整轮已经发出去的上下文。响应体还没交给调用方，重发无歧义。
   */
  for (let i = 0; UPSTREAM_5XX_RETRY_STATUSES.has(res.status) && i < UPSTREAM_5XX_RETRIES; i += 1) {
    const text = await res.text().catch(() => '');
    if (clientSignal?.aborted) return { res, bodyText: text, upstreamStartedAt: upEnter };
    const wait = UPSTREAM_5XX_RETRY_DELAY_MS * (i + 1);
    log(`upstream ${res.status}, bridge retries in ${wait}ms (${i + 1}/${UPSTREAM_5XX_RETRIES})`);
    if (wait > 0) await sleep(wait);
    if (clientSignal?.aborted) return { res, bodyText: text, upstreamStartedAt: upEnter };
    res = await attemptWithStaleRetry(auth);
  }

  // the gateway occasionally wraps a momentary upstream failure as 400 code 11133: retry idempotently
  /*
   * 非 2xx 的响应体必须**在这里读完**并随 `bodyText` 一起返回。
   *
   * 为什么：调用方拿到 `!up.ok` 后会 `bodyText ?? await up.text()`。
   * 而 `shimResponse.text()` 是**事件式**的（`res.on('data')` / `on('end')`）——
   * 只有在第一份数据到达**之前**挂上监听才收得全。若中途换过一次响应
   * （401 刷新重试、或 400-11133 重试），新响应的 `end` 很可能在调用方
   * 挂监听之前就已经派发过了，于是 `await up.text()` **永远不 resolve**，
   * 请求挂死且客户端只看到超时。
   *
   * 实测复现：上游先回 400（触发一次重试）再回 401 + 一段 HTML →
   * 桥在 25 秒后仍未响应（`tools/dev` 之外的独立脚本验证）。
   * 修法：在返回前就把体读出来，让调用方**不需要**再碰这个流。
   */
  const status = res.status;
  if (status !== 400 && (status < 200 || status >= 300)) {
    const text = await res.text().catch(() => '');
    return { res, bodyText: text, upstreamStartedAt: upEnter };
  }

  for (let i = 0; res.status === 400 && TRANSIENT_400_RETRY_ENABLED && i < TRANSIENT_400_DELAYS.length; i++) {
    const text = await res.text();
    let code;
    try { code = JSON.parse(text)?.code; } catch {}
    if (code !== 11133) return { res, bodyText: text, upstreamStartedAt: upEnter };
    /*
     * 确定性拒绝 → **立刻**返回，不进退避。
     *
     * 11133 只是包装码；`model_param_invalid` / `invalid_reasoning_effort` 这类
     * 表示"参数被模型提供方拒了"，原样重发不可能成功。实测这类占了 11133 的
     * **全部**（122/122），每次都白等 40 秒后照样报错 —— 见 DETERMINISTIC_400_CODES
     * 的注释（含日志取证数字）。
     */
    const deterministic = deterministic400Reason(text);
    if (deterministic) {
      log(`deterministic 400 (11133, ${deterministic}), not retrying`);
      return { res, bodyText: text, upstreamStartedAt: upEnter };
    }
    if (clientSignal?.aborted) return { res, bodyText: text, upstreamStartedAt: upEnter };
    log(`transient 400 (11133), retry ${i + 1}`);
    await new Promise((r) => setTimeout(r, TRANSIENT_400_DELAYS[i]));
    if (clientSignal?.aborted) return { res, bodyText: text, upstreamStartedAt: upEnter };
    res = await attemptWithStaleRetry(auth);
    // 重试后的响应若不再是 400/2xx，同样要在这里把体读掉（见上面的说明）
    if (res.status !== 400 && (res.status < 200 || res.status >= 300)) {
      const t = await res.text().catch(() => '');
      return { res, bodyText: t, upstreamStartedAt: upEnter };
    }
  }
  return { res, bodyText: null, upstreamStartedAt: upEnter };
}

/** 11128 可能出现在顶层 code，也可能被网关塞进 extError；两种都认。 */
function is11128Response(res, parsed) {
  if (!res || res.status !== 400) return false;
  const code = parsed?.code ?? parsed?.extError?.code ?? parsed?.ext_error?.code;
  return Number(code) === 11128;
}

function upstreamAuthFailure(res) {
  return res?.status === 401 || res?.status === 403;
}

function upstreamErrorCode(parsed) {
  return parsed?.extError?.code || parsed?.ext_error?.code
    || (typeof parsed?.code === 'number' ? parsed.code : null);
}

/** 账本仍优先记上游顶层数字 code（11128/11133/6004），便于统计；没有才退回 extError。 */
function upstreamLedgerCode(parsed) {
  return typeof parsed?.code === 'number' ? parsed.code : upstreamErrorCode(parsed);
}

function upstreamErrorText(parsed, text, res) {
  return String(
    parsed?.error?.message || parsed?.msg || parsed?.message || text || `upstream HTTP ${res?.status}`,
  ).slice(0, 400);
}

/** 上面的错误原文里保留上游 msg，同时给出“是 WorkBuddy 登录过期”的可操作说明。 */
function upstreamAuthMessage(parsed) {
  const detail = String(parsed?.msg || parsed?.message || '').trim();
  return 'workbuddy-bridge: upstream login expired — re-login in the WorkBuddy desktop app, then retry'
    + (detail ? ` (${shortError(detail, 160)})` : '');
}

/**
 * 三条协议共用的上游调用：11128 时按“删品牌行 → 删首段 → 中性 system”渐进
 * 重试，并把成功/最后尝试的兜底策略带回去，供响应头与账本记录。
 *
 * 限流许可只取一次：兜底是同一逻辑请求的延续。
 */
async function callUpstreamWithChannelFallback(payload, model, conversationId, clientSignal) {
  const readFailure = async (attempt) => {
    const text = attempt.res.ok ? '' : (attempt.bodyText ?? await attempt.res.text().catch(() => ''));
    let parsed;
    try { parsed = JSON.parse(text); } catch { /* 非 JSON：保留原文 */ }
    return { ...attempt, bodyText: text, parsed, fallback: null };
  };

  /*
   * body 级 conversation_id：上游按它分前缀缓存槽（panel #169 的决定性实验）。
   * 同时保留 header（部分客户端/风控头族需要它）。若某个上游 build 把它当
   * 未知字段拒绝，就自动去掉并关闭本进程注入 —— 不让用户为兼容性改配置。
   */
  const withBodyId = (p) => (conversationIdBodyEnabled && conversationId
    ? { ...p, conversation_id: conversationId }
    : p);
  let payloadForUpstream = withBodyId(payload);
  let attempt = await readFailure(
    await callUpstream(JSON.stringify(payloadForUpstream), model, conversationId, clientSignal),
  );
  if (!attempt.res.ok && payloadForUpstream !== payload
    && isConversationIdFieldRejected(attempt.parsed, attempt.bodyText)) {
    conversationIdBodyEnabled = false;
    log('upstream rejected conversation_id body field; disabling body injection for this process');
    payloadForUpstream = payload;
    attempt = await readFailure(
      await callUpstream(JSON.stringify(payloadForUpstream), model, conversationId, clientSignal),
    );
  }
  if (!is11128Response(attempt.res, attempt.parsed)) return attempt;

  let lastFallback = null;
  let tried = 0;
  for (const candidate of channelFallbackCandidates(payloadForUpstream)) {
    if (clientSignal?.aborted) break;
    tried += 1;
    lastFallback = candidate.strategy;
    log(`upstream 11128; retrying with ${candidate.strategy}`);
    attempt = await readFailure(
      await callUpstream(
        JSON.stringify(candidate.payload),
        model,
        conversationId,
        clientSignal,
        { skipRateLimit: true },
      ),
    );
    attempt.fallback = candidate.strategy;
    if (attempt.res.ok) return attempt;
    if (!is11128Response(attempt.res, attempt.parsed)) return attempt;
  }
  log('channel fallback exhausted', attempt.res.status, String(attempt.bodyText || '').slice(0, 300));
  attempt.fallback = lastFallback;
  /*
   * 兜底全失败且最终仍是 11128：给调用方一个明确的「通道拒绝」信号。
   * 这不是普通上游 4xx，重复点一次不会有不同的结果；UI 应该提示用户
   * 停止重试并查看诊断，而不是把 11128 原样丢回去让人反复试。
   */
  if (is11128Response(attempt.res, attempt.parsed)) {
    attempt.channelRejected = true;
    attempt.channelAttempts = 1 + tried;
  }
  return attempt;
}

/** 一次上游尝试的账本/响应头元数据（三条协议共用）。 */
function channelAttemptMeta(attempt, up) {
  return {
    ...(attempt.fallback ? { fallback: attempt.fallback, fallbackOk: up.ok } : {}),
    ...(attempt.channelRejected
      ? { channelRejected: true, channelAttempts: attempt.channelAttempts }
      : {}),
  };
}

/** 11128 全降级失败时给用户的可操作文案（不包含任何对话内容）。 */
function channelRejectedMessage(attempt) {
  const n = Math.max(1, Number(attempt?.channelAttempts) || 1);
  return 'workbuddy-bridge: upstream channel verification rejected this request'
    + ` after ${n} attempt(s). The bridge already neutralized the known host/identity templates;`
    + ' resending the same payload is unlikely to help. See docs/TROUBLESHOOTING.md (11128).';
}

/**
 * 首包/排队超时的统一错误响应。返回 true 表示已处理（调用方直接 return）。
 * 三条协议各自保留自己的错误形状，但状态码统一 504，客户端会按超时重试。
 */
function handleUpstreamTimeout(res, protocol, error) {
  if (error?.code !== 'UPSTREAM_FIRST_BYTE_TIMEOUT' && error?.code !== 'UPSTREAM_QUEUE_TIMEOUT') return false;
  const message = `workbuddy-bridge: ${error.message}`;
  if (protocol === 'anthropic') {
    json(res, 504, { type: 'error', error: { type: 'api_error', message } });
  } else if (protocol === 'responses') {
    json(res, 504, { error: { type: 'upstream_error', code: 'upstream_timeout', message } });
  } else {
    json(res, 504, { error: { type: 'upstream_timeout', message } });
  }
  return true;
}

// ── SSE parsing and aggregation (non-streaming clients only) ─────────────
function mergeToolCallDelta(acc, deltas) {
  for (const d of deltas || []) {
    const idx = d.index ?? acc.length;
    acc[idx] ??= { id: undefined, type: 'function', function: { name: '', arguments: '' } };
    const slot = acc[idx];
    if (d.id) slot.id = d.id;
    if (d.type) slot.type = d.type;
    if (d.function?.name) slot.function.name += d.function.name;
    if (d.function?.arguments) slot.function.arguments += d.function.arguments;
  }
}

async function aggregateStream(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '', reasoning = '', finishReason = null, usage = null, id = null, model = null, created = null;
  /*
   * 成功解析出的 SSE 数据块数。
   *
   * 为什么需要它：上游回 **HTTP 200 但不是 SSE**（典型：网关把错误包成 200 的
   * HTML）时，这个函数会安静地返回一个「content 为空」的聚合结果 —— 调用方原先
   * 无条件记 `ok: true` 并回 200，用户拿到的是「结构完整但没内容」的成功响应，
   * 账本也记成功。**静默错数据**比报错难查得多。
   * `parsed === 0` 就是「这一坨根本不是 SSE」，据此按失败处理。
   */
  let parsed = 0;
  /*
   * 是否看到了「这一轮正常结束」的信号：`finish_reason` 或 `[DONE]`。
   *
   * 为什么与 `parsed` 分开：`parsed > 0` 只说明"解析出了 SSE 块"，不代表流**跑完了**。
   * 上游在吐了几段内容之后**干净地半关**（代理超时后正常收尾、chunked 结束但没给
   * finish_reason / usage / [DONE]）时，原先这个函数照样返回
   * `finish_reason: "stop"` 的完整对象 → 调用方回 200 并记 `ok:true`，客户端以为
   * 回答说完了（其实是半句），账本上还是一条健康的 0/0 tokens 记录。
   * 实测：只喂一帧 content、然后干净 EOF → `parsed=1, finish_reason="stop", usage=undefined`。
   */
  let sawDone = false;
  let sawFinishReason = false;
  const toolCalls = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;
      if (payload === '[DONE]') { sawDone = true; continue; }
      let j; try { j = JSON.parse(payload); } catch { continue; }
      parsed += 1;
      id ??= j.id; model ??= j.model; created ??= j.created;
      if (j.usage) usage = j.usage;
      const choice = j.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) { finishReason = choice.finish_reason; sawFinishReason = true; }
      const d = choice.delta || {};
      if (typeof d.content === 'string') content += d.content;
      if (typeof d.reasoning_content === 'string') reasoning += d.reasoning_content;
      if (d.tool_calls) mergeToolCallDelta(toolCalls, d.tool_calls);
    }
  }
  // 收尾：最后一行可能没有换行符结尾（干净结束但缺 `\n`），别把它丢掉
  if (buffer.trim()) {
    const payload = buffer.trim().startsWith('data:') ? buffer.trim().slice(5).trim() : '';
    if (payload === '[DONE]') sawDone = true;
    else if (payload) {
      try {
        const j = JSON.parse(payload);
        parsed += 1;
        id ??= j.id; model ??= j.model; created ??= j.created;
        if (j.usage) usage = j.usage;
        const choice = j.choices?.[0];
        if (choice) {
          if (choice.finish_reason) { finishReason = choice.finish_reason; sawFinishReason = true; }
          const d = choice.delta || {};
          if (typeof d.content === 'string') content += d.content;
          if (typeof d.reasoning_content === 'string') reasoning += d.reasoning_content;
          if (d.tool_calls) mergeToolCallDelta(toolCalls, d.tool_calls);
        }
      } catch { /* 半截 JSON：丢弃 */ }
    }
  }
  const message = { role: 'assistant', content: content || null };
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCalls.length) message.tool_calls = toolCalls.filter(Boolean);
  return {
    parsed,
    /*
     * 「这一轮真的跑完了吗」。`parsed === 0` 是"根本不是 SSE"；这里再补一条
     * "是 SSE、但流在半路干净地断了" —— 调用方据此按失败处理，不要伪装成成功。
     * 工具调用也算终止信号：上游给了完整 tool_calls 就会带 finish_reason，
     * 但万一只给工具不给 finish_reason，我们也不该把它判成截断。
     */
    completed: sawDone || sawFinishReason || toolCalls.length > 0,
    id: id || `chatcmpl-${trace().slice(0, 24)}`,
    object: 'chat.completion',
    created: created || Math.floor(Date.now() / 1000),
    model: model || '',
    choices: [{ index: 0, message, finish_reason: finishReason || 'stop' }],
    ...(usage ? { usage } : {}),
  };
}

/**
 * 上游 usage → 本地账本字段。
 *
 * **必须留在模块级**：OpenAI 的 `/v1/chat/completions` 与 Anthropic 的
 * `/v1/messages` 两条协议路径都要用它。原先它定义在 chat/completions 的
 * 块作用域里，Anthropic 路由根本看不到，一调就是 `ReferenceError`。
 */
const usageOf = (u) => ({
  promptTokens: Number(u?.prompt_tokens) || 0,
  completionTokens: Number(u?.completion_tokens) || 0,
  /*
   * 提示缓存命中量（2026-10-13 加）。
   *
   * ## 为什么必须记它
   *
   * 提示缓存是这条链路上**最大的单因素**，而且只体现在两处、都不记账：
   *   · **成本**：实测同一批大请求，未命中 0.0142 积分/1k tokens、
   *     已命中 0.0005 —— 差 **26 倍**。93 条 >=40k 的请求里，
   *     **6 条未命中就花掉 10.00 积分**，而 87 条命中合计才 10.20。
   *     不记缓存量的话，这 10 个积分在控制台上看起来和"正常用量"毫无区别。
   *   · **延迟**：实测冷缓存 TTFT 14.8s → 命中后 5.9s（2.5 倍）；
   *     66k 上下文下 4.6s → 5.6s 量级的抖动也主要来自这里。
   *
   * ## 字段口径
   *
   * 上游同时给 `prompt_tokens_details.cached_tokens`（真实值）与顶层的
   * `cached_tokens`/`prompt_cache_hit_tokens`（有时是恒 0 的占位）——
   * 所以取**一组同义字段的最大值**，而不是 `??` 链：0 不是 nullish，
   * 用 `??` 会被那个占位 0 挡住（`adapter.mjs` 的 `maxAlias` 是同款理由）。
   *
   * 缺失时**不写字段**（老账本、桩上游都没有），而不是写 0 ——
   * 0 是"确实没命中"，与"上游没报"是两件事，混起来会让命中率统计失真。
   */
  ...(() => {
    const cached = [
      u?.prompt_tokens_details?.cached_tokens,
      u?.prompt_cache_hit_tokens,
      u?.cached_tokens,
      u?.cache_read_tokens,
    ].reduce((best, v) => {
      const n = Number(v);
      return Number.isFinite(n) && n > best ? n : best;
    }, 0);
    // 上游直接给了未命中计数时优先采信（DeepSeek 原生 prompt_cache_miss_tokens）
    const miss = Number(u?.prompt_cache_miss_tokens);
    const out = {};
    if (cached > 0) out.cachedTokens = cached;
    if (Number.isFinite(miss) && miss >= 0) out.cacheMissTokens = miss;
    return out;
  })(),
  // 上游在 usage 里回报本次实际扣减的积分，一并记进本地账本（只记数字）
  ...(typeof u?.credit === 'number' ? { credit: u.credit } : {}),
});

// ── Anthropic Messages API 兼容层（POST /v1/messages）─────────────────────
/**
 * 为什么需要这一层
 * ----------------
 * Claude Code 说的是 Anthropic 的 Messages 协议，**不是** OpenAI 的
 * chat/completions。两者在请求结构、响应结构、流式事件格式上都不一样，
 * 光把 Base URL 指过来是接不上的（会直接 404，因为桥原先没有这个路由）。
 *
 * 这一层做两件事：把 Anthropic 请求翻译成上游认的 OpenAI 请求；再把上游的
 * OpenAI 流翻译回 Anthropic 的事件流。翻译是**有损但语义等价**的，下面每处
 * 不可逆的映射都单独注明了原因。
 *
 * 上游只支持流式，所以这里统一走上游流式：`stream:false` 的客户端先收完
 * 再聚合成一个完整 message。
 */

/**
 * 模型名解析。Claude Code 会发 `claude-sonnet-4-...` 这类名字，上游没有这些 id。
 *
 * 顺序：① 精确命中上游目录就原样用（允许用 `ANTHROPIC_MODEL` 指定真实模型）；
 * ② 带 haiku/flash 这类「小快」字样的走 fast 模型（Claude Code 拿它跑标题生成、
 * 文件摘要这类后台活，用大模型纯属浪费额度）；③ 其余走默认模型。
 *
 * 默认取 `glm-5.3` 而不是桥的通用默认 `deepseek-v4.1-flash`：Claude Code 是
 * Agent，全程依赖工具调用，而 `glm-5.3` 是实测 tool_calls 最稳的一个。
 */
const ANTHROPIC_MODEL = process.env.WORKBUDDY_ANTHROPIC_MODEL || 'glm-5.3';
const ANTHROPIC_FAST_MODEL = process.env.WORKBUDDY_ANTHROPIC_FAST_MODEL || 'glm-5.3-flash';

function resolveAnthropicModel(requested) {
  const name = typeof requested === 'string' ? requested : '';
  if (name && catalogCache.models.some((m) => m.id === name)) return name;
  if (name && /haiku|flash|mini|small|fast/i.test(name)) return ANTHROPIC_FAST_MODEL;
  return ANTHROPIC_MODEL;
}

/**
 * Anthropic 的 stop_reason 与 OpenAI 的 finish_reason 不是一一对应，需显式映射。
 *
 * ⚠️ `sawToolUse` 这一路是必要的兜底，不能只认 `finish_reason`：
 * Anthropic 的协议不变量是「有 `tool_use` 内容块 ⇒ `stop_reason: "tool_use"`」。
 * 而上游偶尔以 `stop` 收尾却已经把工具块发了出来（工具块已经在 wire 上了），
 * 此时报 `end_turn` 会让客户端把工具块当成**装饰性内容**、直接结束回合 ——
 * 工具调用被静默丢掉。既然块已经发出去了，stop_reason 就必须与之一致。
 */
function anthropicStopReason(finishReason, sawToolUse = false) {
  if (finishReason === 'tool_calls') return 'tool_use';
  if (finishReason === 'length') return 'max_tokens';
  if (sawToolUse) return 'tool_use';
  return 'end_turn';
}

/** 上游给的 arguments 是字符串形式的 JSON；模型偶尔吐半截，别让整个请求炸掉。 */
function safeJsonParse(s) {
  if (typeof s !== 'string' || !s.trim()) return {};
  try {
    const v = JSON.parse(s);
    // Anthropic 要求 tool_use.input 必须是对象
    return v && typeof v === 'object' ? v : {};
  } catch { return {}; }
}

/**
 * 零依赖的 token 估算（如实标注"估算"）。
 *
 * 上游没有任何 tokenizer 端点；这里用经验公式：ASCII ≈ 4 字符/token，
 * 非 ASCII（CJK 等）≈ 1 token/字 —— 比原来的"字节数 / 4"准得多（UTF-8 中文
 * 是 3 字节/字，按字节估会把中文算少一半以上）。Claude Code 用它显示上下文
 * 占用，**量级正确**即可。
 */
function estimateTokens(text) {
  const s = String(text ?? '');
  let ascii = 0;
  let wide = 0;
  for (const ch of s) {
    if (ch.codePointAt(0) > 0x7f) wide += 1;
    else ascii += 1;
  }
  return Math.ceil(ascii / 4) + wide;
}

/**
 * 一张图片折算多少 token。
 *
 * 图片按**像素**计价，与 base64 长度无关（Anthropic 官方口径：约 `宽×高/750`，
 * 单图大致落在 1,000–1,600）。我们没有解码尺寸的依赖（零依赖项目），
 * 所以取一个居中的常数。
 *
 * 为什么必须单独有这个常数：原先 `estimateRequestTokens` **完全没有图片分支**，
 * 于是同一张 260KB 的截图按放置位置得到两个都错的结果 ——
 *   ① 放在 `tool_result.content`（数组）里：走 `JSON.stringify` → 按字符数计价
 *      得 **66,584** tokens（真实约 1,000–1,600，**高估约 40–60 倍**）；
 *   ② 放在顶层 `{type:'image'}` 块里：既无 `.text` 无 `.content` 无 `.input`
 *      → 计 **0–4** tokens（**几乎不计**）。
 *
 * 这两个数字都直接喂给 Claude Code 的 `/context` 占用条与自动压缩阈值：
 * ① 会让它在每个截图工具的后续回合**过早压缩/拒绝历史**；② 则相反，
 * 让它**低估到溢出**。同一张图两种答案本身就说明口径不一致。
 */
const IMAGE_TOKEN_ALLOWANCE = 1200;

/** 这个内容块是不是一张图（Anthropic image / OpenAI image_url 两种形状）。 */
function isImagePart(part) {
  return part.type === 'image' || part.type === 'image_url';
}

/**
 * 从 `tool_result.content` / 工具输入等**任意嵌套结构**里估 token：
 * 文本按字符计价，图片按常数计价，**裸 base64 载荷不按字符算**。
 *
 * 递归是必要的：`tool_result.content` 可能是
 * `[{type:'text'}, {type:'image'}]`，也可能被再套一层（`{content:[...]}`）。
 * 只要在任意深度认出 `type:'image'` 就按图片计价（`isImagePart` 已经提前返回，
 * 连它的 `source.data` 都不会走到）。
 */
function estimateStructuredTokens(value, depth = 0) {
  if (value == null || depth > 8) return 0;
  if (typeof value === 'string') {
    // data URL 整串按一张图算；其余按字符
    return /^data:[^;,]+;base64,/i.test(value) ? IMAGE_TOKEN_ALLOWANCE : estimateTokens(value);
  }
  if (typeof value !== 'object') return 0;
  if (Array.isArray(value)) {
    let sum = 0;
    for (const item of value) sum += estimateStructuredTokens(item, depth + 1);
    return sum;
  }
  if (isImagePart(value)) return IMAGE_TOKEN_ALLOWANCE;
  let sum = 0;
  for (const [key, v] of Object.entries(value)) {
    /*
     * 兜底：没有 `type:'image'` 标记、但挂着**一长串 base64** 的载荷
     * （`{data: "iVBORw0..."}` 这类）。只对"长且是 base64 字符集"的值按图片算 ——
     * 不能无条件跳过 `data` / `base64` 键：工具输入里完全可能有个正经的短字段
     * 就叫 `data`，无条件跳过会把它的内容算丢。
     */
    if ((key === 'data' || key === 'base64') && typeof v === 'string'
      && v.length >= 512 && /^[A-Za-z0-9+/=\s]+$/.test(v)) {
      sum += IMAGE_TOKEN_ALLOWANCE;
      continue;
    }
    sum += estimateStructuredTokens(v, depth + 1);
  }
  return sum;
}

/**
 * 估算一条 /v1/messages 请求的输入 token：system + messages + tools 的文本面。
 * 供 `POST /v1/messages/count_tokens` 与流式首帧的 input_tokens 兜底使用。
 */
function estimateRequestTokens(body) {
  let total = estimateTokens(anthropicSystemText(body?.system));
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  for (const m of messages) {
    total += 4; // 每条消息的角色与分隔开销（Anthropic 实测约 3–5）
    const c = m?.content;
    if (typeof c === 'string') {
      total += estimateTokens(c);
    } else if (Array.isArray(c)) {
      for (const part of c) {
        if (!part || typeof part !== 'object') continue;
        if (typeof part.text === 'string') total += estimateTokens(part.text);
        // 图片块：整块计价（不能再落到下面按字符算）
        if (isImagePart(part)) { total += IMAGE_TOKEN_ALLOWANCE; continue; }
        // tool_result（字符串 / 块数组）与 tool_use 的 input：递归估，
        // 图片按常数、base64 不计字符 —— 见 estimateStructuredTokens 的说明。
        if (part.content !== undefined) total += estimateStructuredTokens(part.content);
        if (part.input !== undefined) total += estimateStructuredTokens(part.input);
      }
    }
  }
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  for (const t of tools) {
    total += estimateTokens(t?.name) + estimateTokens(t?.description) + estimateTokens(JSON.stringify(t?.input_schema || {}));
  }
  return Math.max(1, total);
}

/** Anthropic 的 `system` 可以是字符串，也可以是 `[{type:'text',text}]`。 */
function anthropicSystemText(system) {
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) {
    return system
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n');
  }
  return '';
}

/**
 * Anthropic 的 `tool_result.content` 同样有字符串 / 块数组两种形态。
 *
 * ⚠️ 与 Responses 侧同源的坑（那边已修，见 `responsesOutputContent`）：
 * 这里原来**只挑 `type:"text"` 的块**，于是 `tool_result` 里的图片被**静默丢掉**。
 * Anthropic 协议允许 `tool_result.content` 里放 image 块（Claude Code 的截图工具
 * 就是这么回的），丢了不报错、只是模型"看不见图"，排查起来毫无线索。
 *
 * 这里改成返回**内容块数组**（保留 `image_url` 块），与 Responses 侧同款；
 * 只有纯文本时才降成字符串。
 */
function anthropicToolResultContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const b of content) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'text' && typeof b.text === 'string') {
        parts.push({ type: 'text', text: b.text });
        continue;
      }
      if (b.type === 'image') {
        const img = anthropicImageToOpenAI(b);
        if (img) parts.push(img);
      }
    }
    if (!parts.length) return '';
    if (parts.length === 1 && parts[0].type === 'text') return parts[0].text;
    return parts;
  }
  if (content == null) return '';
  return JSON.stringify(content);
}

/** Anthropic 的 image block → OpenAI 的 image_url（base64 走 data URI）。 */
function anthropicImageToOpenAI(block) {
  const src = block && block.source;
  if (!src) return null;
  if (src.type === 'base64' && src.data) {
    return { type: 'image_url', image_url: { url: `data:${src.media_type || 'image/png'};base64,${src.data}` } };
  }
  if (src.type === 'url' && src.url) {
    return { type: 'image_url', image_url: { url: src.url } };
  }
  return null;
}

/**
 * Anthropic messages → OpenAI messages。
 *
 * 三处结构性差异必须处理，否则上游一定拒：
 * 1. Anthropic 的 system 是**顶层字段**，OpenAI 是**首条消息**；而且上游要求
 *    首条必须是 system，所以即使 system 为空也要补一条占位。
 * 2. Anthropic 把工具调用和结果**混在 content 块数组**里（`tool_use` /
 *    `tool_result`），OpenAI 拆成 assistant.tool_calls + 独立的 `role:"tool"` 消息。
 * 3. 顺序不能乱：带 tool_calls 的 assistant 消息必须排在对应 `role:"tool"`
 *    消息之前，否则上游会以「tool 消息没有前置调用」拒绝。
 */
function anthropicToOpenAIMessages(body) {
  const out = [];
  const sys = anthropicSystemText(body.system);
  out.push({ role: 'system', content: sys || 'You are a helpful assistant.' });

  for (const msg of Array.isArray(body.messages) ? body.messages : []) {
    if (!msg || typeof msg !== 'object') continue;
    const role = msg.role === 'assistant' ? 'assistant' : 'user';

    // 纯字符串是最常见的形态，直接透传
    if (typeof msg.content === 'string') {
      out.push({ role, content: msg.content });
      continue;
    }
    if (!Array.isArray(msg.content)) continue;

    const parts = [];       // OpenAI content 数组（text / image_url）
    const toolCalls = [];   // assistant 的 tool_calls
    const toolResults = []; // user 的 tool_result → 独立的 role:"tool" 消息

    for (const block of msg.content) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'text' && typeof block.text === 'string') {
        parts.push({ type: 'text', text: block.text });
      } else if (block.type === 'image') {
        const img = anthropicImageToOpenAI(block);
        if (img) parts.push(img);
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id || `call_${trace().slice(0, 20)}`,
          type: 'function',
          function: { name: block.name || '', arguments: JSON.stringify(block.input ?? {}) },
        });
      } else if (block.type === 'tool_result') {
        toolResults.push({
          role: 'tool',
          tool_call_id: block.tool_use_id || '',
          /*
           * ⚠️ 用 `anthropicToolResultContent`（保留 image 块），不是 `…Text`。
           * Claude Code 的截图工具把图放在 `tool_result.content` 里；
           * 只取 text 块会让图片**静默消失**（不报错、模型只是"看不见"）。
           */
          content: anthropicToolResultContent(block.content),
        });
      }
    }

    if (role === 'assistant') {
      const m = { role: 'assistant' };
      const text = parts.filter((p) => p.type === 'text').map((p) => p.text).join('');
      // 有 tool_calls 时 content 允许为 null（OpenAI 语义就是如此）
      m.content = text || (toolCalls.length ? null : '');
      if (toolCalls.length) m.tool_calls = toolCalls;
      out.push(m);
    } else {
      // tool_result 逻辑上先于本轮的新内容
      for (const tr of toolResults) out.push(tr);
      if (parts.length) {
        out.push({ role: 'user', content: parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts });
      } else if (!toolResults.length) {
        out.push({ role: 'user', content: '' });
      }
    }
  }
  return out;
}

/**
 * Anthropic tools → OpenAI tools。`input_schema` 与 `parameters` 是同一份
 * JSON Schema，只是字段名不同。
 */
function anthropicToolsToOpenAIMessages(tools) {
  if (!Array.isArray(tools)) return null;
  const out = tools
    .filter((t) => t && typeof t.name === 'string' && t.name)
    .map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description || '',
        parameters: t.input_schema || { type: 'object', properties: {} },
      },
    }));
  return out.length ? out : null;
}

/**
 * Anthropic: {type:'auto'} | {type:'any'} | {type:'tool',name} | {type:'none'}
 * OpenAI:    'auto' | 'required' | {type:'function',...} | 'none'
 *
 * 这里**直接产出字符串**：上游只收字符串，虽然 normalizePayload 会兜底把对象
 * 转掉，但没必要多绕一圈。
 */
function anthropicToolChoiceToOpenAI(tc) {
  if (!tc || typeof tc !== 'object') return null;
  if (tc.type === 'any' || tc.type === 'tool') return 'required';
  if (tc.type === 'auto' || tc.type === 'none') return tc.type;
  return null;
}

/** 聚合后的 OpenAI 响应 → Anthropic message 对象（非流式）。 */
function openAIToAnthropicMessage(agg, model) {
  const choice = (agg.choices || [])[0] || {};
  const msg = choice.message || {};
  const content = [];

  if (typeof msg.content === 'string' && msg.content) {
    content.push({ type: 'text', text: msg.content });
  }
  for (const tc of msg.tool_calls || []) {
    if (!tc) continue;
    content.push({
      type: 'tool_use',
      id: tc.id || `toolu_${trace().slice(0, 24)}`,
      name: tc.function?.name || '',
      input: safeJsonParse(tc.function?.arguments),
    });
  }

  return {
    id: `msg_${String(agg.id || trace()).replace(/[^A-Za-z0-9]/g, '').slice(0, 40)}`,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: anthropicStopReason(choice.finish_reason, content.some((b) => b.type === 'tool_use')),
    stop_sequence: null,
    usage: {
      input_tokens: Number(agg.usage?.prompt_tokens) || 0,
      output_tokens: Number(agg.usage?.completion_tokens) || 0,
    },
  };
}

/**
 * 把上游的 OpenAI SSE 流翻译成 Anthropic 的 SSE 事件流，直接写进 `res`。
 *
 * Anthropic 的流比 OpenAI 严格得多：它用 `event:` 行标注事件类型，而且
 * **每个内容块必须有 start / delta… / stop 三件套配对**，块索引单调递增且
 * 不复用。少任何一对，Claude Code 会判定流损坏并中断会话。
 *
 * 文本块与工具块共用一个索引空间：文本先来就占 0、工具接着占 1，反之亦然。
 *
 * 返回 `{ finishReason, usage, streamError }` 供调用方记账。
 */
async function relayAnthropicStream(up, res, model, estInputTokens) {
  /*
   * 背压状态：`res.write()` 返回 false 表示已超过高水位线。
   *
   * 这里只**记录**、不 await —— `write` 被散落在十几处事件写入里调用，改成 async
   * 会污染每一处调用点。统一在下面读循环的顶部等排空就够了（见 waitDrain）：
   * 那里才是「从上游拉下一块」的节流点。
   */
  let backpressured = false;
  const write = (type, obj) => {
    backpressured = !res.write(`event: ${type}\ndata: ${JSON.stringify(obj)}\n\n`);
  };

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    ...SECURITY_HEADERS,
  });

  write('message_start', {
    type: 'message_start',
    message: {
      id: `msg_${trace().slice(0, 32)}`,
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      // input_tokens 在流开始时上游还没给，先用字符数粗估；真实值在
      // message_delta 里补正。给 0 会让 Claude Code 的上下文占用显示失真。
      usage: { input_tokens: estInputTokens, output_tokens: 0 },
    },
  });

  let blockIndex = -1;
  /**
   * 正文块。**同一时刻至多一个**：文本流是连续的，遇到工具块就收尾。
   *
   * `toolSlots` 里的工具块则**允许同时打开多个** —— 这正是 Anthropic 自己
   * 流式下发并行工具调用的形状（客户端不受"只有一个块是打开的"这个假设约束，
   * 它按 index 组装）。原先用一个 `openKind` 表示"当前打开的块"，
   * 于是任何新块到来都得先把上一个关掉，见下面 `toolSlots` 处的事故说明。
   */
  let textBlock = null; // { index, open }
  const toolSlots = new Map(); // 上游 tool_calls 的 index -> { blockIndex, id, name, started, closed }

  /** 补发工具块的 content_block_start（幂等）。 */
  const flushTool = (slot) => {
    if (!slot || slot.started) return;
    slot.started = true;
    write('content_block_start', {
      type: 'content_block_start',
      index: slot.blockIndex,
      content_block: { type: 'tool_use', id: slot.id, name: slot.name, input: {} },
    });
  };

  /** 收尾正文块（工具块不受影响 —— 它们可以同时开着）。 */
  const closeText = () => {
    if (!textBlock || !textBlock.open) return;
    textBlock.open = false;
    write('content_block_stop', { type: 'content_block_stop', index: textBlock.index });
  };

  /**
   * 收尾**全部**仍打开的块，按 index 升序发出 `content_block_stop`。
   *
   * 为什么必须按 index 升序、且不能提前关：见下面新工具块分支的长注释。
   *
   * 未发过 start 的块要先补 start：否则 stop 会落在一个从未 start 过的 index 上
   * （Anthropic 判协议错）。补发必须是**对每个未 start 的块**，不能只补"最后
   * 一个"—— 用一个 `pendingTool` 变量记"待发块"曾在这里出过事故：
   * **两个工具都只有 name、没有 arguments** 时（模型决定不传参数），
   * 第二个块创建时把 pendingTool 覆盖掉，于是第一个块永远没 start，
   * 收尾却仍给它补了一个 stop —— 实测 starts=[1] / stops=[0,1]，
   * 客户端那边第一个工具调用**根本不存在**（被静默吞掉）。
   * 现在直接遍历 toolSlots 逐个补，不存在"被覆盖"的状态。
   */
  const closeAll = () => {
    for (const slot of toolSlots.values()) {
      if (!slot.started) flushTool(slot);
    }
    const closes = [];
    if (textBlock && textBlock.open) closes.push({ index: textBlock.index, kind: 'text' });
    for (const slot of toolSlots.values()) {
      if (!slot.closed) closes.push({ index: slot.blockIndex, kind: 'tool', slot });
    }
    closes.sort((a, b) => a.index - b.index);
    for (const entry of closes) {
      if (entry.kind === 'text') textBlock.open = false;
      else entry.slot.closed = true;
      write('content_block_stop', { type: 'content_block_stop', index: entry.index });
    }
  };

  let finishReason = null;
  let usage = null;
  let streamError = null;
  /** 是否见过 `[DONE]`：与 finish_reason 一起作为"这一轮真的跑完了"的信号。 */
  let sawDone = false;
  const reader = up.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      // 背压：上一轮写满了就先等客户端排空，再向上游拉下一块
      if (backpressured) { await waitDrain(res); backpressured = false; }
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const raw = line.slice(5).trim();
        if (!raw) continue;
        if (raw === '[DONE]') { sawDone = true; continue; }
        let j; try { j = JSON.parse(raw); } catch { continue; }
        if (j.usage) usage = j.usage;
        const choice = (j.choices || [])[0];
        if (!choice) continue;
        if (choice.finish_reason) finishReason = choice.finish_reason;
        const d = choice.delta || {};

        if (typeof d.content === 'string' && d.content) {
          if (!textBlock || !textBlock.open) {
            closeText(); // 理论上已关；留一道幂等保险
            blockIndex++;
            textBlock = { index: blockIndex, open: true };
            write('content_block_start', {
              type: 'content_block_start',
              index: blockIndex,
              content_block: { type: 'text', text: '' },
            });
          }
          write('content_block_delta', {
            type: 'content_block_delta',
            index: textBlock.index,
            delta: { type: 'text_delta', text: d.content },
          });
        }

        for (const tc of d.tool_calls || []) {
          if (!tc) continue;
          const upIdx = typeof tc.index === 'number' ? tc.index : 0;
          let slot = toolSlots.get(upIdx);
          if (!slot) {
            /*
             * 新工具块：**不能**在这里把上一个工具块关掉。
             *
             * 原先这里调 `closeOpen()`（把唯一"打开的块"收尾）再 `blockIndex++`。
             * 而 OpenAI 的并行工具调用**允许多个调用交错下发** —— 典型形状是
             * "先把所有 name/id 发完，再逐个发 arguments"。此时第二个工具的
             * name 一到，第一个工具块就被提前 stop，紧接着它的 arguments 分片
             * 变成"stop 之后的 delta"：
             *
             *   content_block_start idx=0 {name:"Read"}
             *   content_block_stop  idx=0            ← 提前关闭
             *   content_block_delta idx=0 {partial_json:'{"file_path":"/a.ts"}'}  ← 落在 stop 之后
             *   content_block_start idx=1 {name:"Grep"}
             *
             * 按 Anthropic 协议，块关闭后的 delta 会被客户端丢弃，于是第一个
             * 工具调用的 input 变成空对象；更糟的是参数可能被算到"当前打开的块"
             * 头上。并行工具调用在 Claude Code 里是常态，代价很大。
             *
             * 实测（合成交错 SSE 驱动本函数）：修复前 `index 0 在
             * content_block_stop 之后又收到了 delta`；修复后无违规。
             *
             * 所以工具块改为**各自独立**打开，只在真正的收尾点（读完 / 出错）
             * 统一按 index 升序关闭。正文块仍然独占（文本是连续的，遇到工具
             * 就该收尾），见上面的 closeText()。
             */
            closeText();
            blockIndex++;
            slot = {
              blockIndex,
              id: tc.id || `toolu_${trace().slice(0, 24)}`,
              name: '',
              started: false,
              closed: false,
            };
            toolSlots.set(upIdx, slot);
            /*
             * 先不发 `content_block_start`，等名字收齐再发：`function.name`
             * **可能分片到达**，而 start 一旦发出，里面的 name 就定死了 ——
             * 先发会把半截名字（如 `get_`）交给客户端，工具调用必然失败。
             * OpenAI 的流式协议里名字总在 arguments 之前到齐，所以"等第一个
             * arguments 分片来了再发"是安全的（见下面 flushTool 的调用点）；
             * 完全没有 arguments 的调用由 `closeAll()` 遍历补发。
             */
          }
          if (slot.closed) continue; // 已收尾的块不再接受 delta（幂等）
          /*
           * 名字**累加**，不是「只在为空时取一次」。
           *
           * 原先的守卫是 `else if (tc.function?.name && !slot.name)`，而 slot 建立时
           * 已经把首片写进了 `name` —— 于是 `!slot.name` 恒为 false，除首片外的
           * 分片全被丢掉。`+=` 本身就说明这里预期分片到达，两者自相矛盾。
           * 现在初值是空串、每片都追加，收齐后再由 flushTool 一次性发出。
           */
          if (tc.function?.name) slot.name += tc.function.name;
          if (typeof tc.function?.arguments === 'string' && tc.function.arguments) {
            flushTool(slot); // 参数开始来了 → 名字必然已收齐，这时才发 start
            write('content_block_delta', {
              type: 'content_block_delta',
              index: slot.blockIndex,
              delta: { type: 'input_json_delta', partial_json: tc.function.arguments },
            });
          }
        }
      }
    }
  } catch (e) {
    streamError = e;
    log('anthropic stream interrupted', e.message);
  }

  closeAll();

  /*
   * 干净半关（上游正常收尾、但既没有 finish_reason 也没有 [DONE]）与"连接被掐"
   * 是同一个结果：回答截断在半句话上。之前只认 `catch` 里的异常，于是干净半关
   * 会一路走到 `end_turn + message_stop` —— Claude Code 认为回合正常结束。
   */
  if (!streamError && !sawDone && !finishReason && !res.writableEnded) {
    streamError = new Error('upstream stream ended before completion (no finish_reason / [DONE])');
    log('anthropic stream ended without a completion signal, reporting as failure');
  }

  /*
   * ⚠️ **上游在流中途断掉时，绝不能以「干净的 end_turn + message_stop」收尾。**
   *
   * `streamError` 非空表示上游连接在流中间断了（被掐 / 网络故障 / 上游超时），
   * 此时回答**已经截断在半句话上**。原来这里无条件写 `message_delta`
   * （stop_reason 落到 `end_turn`）+ `message_stop` → Claude Code 认为
   * "回合正常结束" → 用户看到的就是**说话说一半突然停下**，而且不报错、
   * 不重试（它以为成功了）。`streamError` 当时只被用来记一笔账，从未影响
   * 发给客户端的事件流。
   *
   * 这与 Responses 那条路径是**同一个坑**（见 `response.failed` 处的长注释），
   * 那边已经修好，Anthropic 这条漏了 —— 同一个坑出现在两条路径上时，
   * 改完一处要顺手搜另一处（项目里已记过这条教训）。
   *
   * Anthropic 流式协议里表达"这一轮没跑完"的方式是 `event: error`：客户端
   * 认它、会转成可读错误并按错误类型决定是否重试。所以这里改发 error 并
   * **不发 `message_stop`** —— 一个失败的消息不该有"消息结束"信号。
   * 用法与形状对齐官方流式错误事件：
   *   event: error
   *   data: {"type":"error","error":{"type":"api_error","message":"..."}}
   */
  if (streamError && !res.writableEnded) {
    write('error', {
      type: 'error',
      error: {
        type: 'api_error',
        message: `workbuddy-bridge: upstream stream interrupted before completion: ${streamError.message}`,
      },
    });
    res.end();
    return { finishReason, usage, streamError };
  }

  write('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: anthropicStopReason(finishReason, toolSlots.size > 0), stop_sequence: null },
    usage: {
      input_tokens: Number(usage?.prompt_tokens) || estInputTokens,
      output_tokens: Number(usage?.completion_tokens) || 0,
    },
  });
  write('message_stop', { type: 'message_stop' });
  res.end();
  return { finishReason, usage, streamError };
}

// ── OpenAI Responses API 兼容层（POST /v1/responses，Codex 走这条）─────────
/**
 * 为什么需要这一层
 * ----------------
 * Codex 说的是 OpenAI 的 **Responses 协议**（`/v1/responses`），不是
 * chat/completions。而且上游已经把 `wire_api = "chat"` **彻底移除**了 ——
 * 配置里写 `chat` 会直接报「`chat` is no longer supported」
 * （见 codex-rs/model-provider-info 的 CHAT_WIRE_API_REMOVED_ERROR，0.162.0
 * 稳定版里已经是这样）。所以「把 Base URL 指过去就行」这条路对 Codex 关死了，
 * 必须由桥来转换协议。
 *
 * 职责与 Anthropic 那层完全对称：把 Responses 请求翻译成上游认的
 * chat/completions，再把上游的流翻译回 Responses 的事件流。
 * CC Switch 走的也是这个思路（Codex Responses → 本地路由 → 第三方
 * Chat Completions → 转换回 Responses 响应）。
 *
 * ## 这些约束是**从 Codex 自己的解析器读出来的**，不是猜的
 *
 * 事件名与字段对照 `codex-rs/codex-api/src/sse/responses.rs` 的
 * `process_responses_event` 逐条核过：
 *
 * 1. **Codex 只在 `response.output_item.done` 里取内容**（文本与工具调用都是）。
 *    `response.function_call_arguments.done` 它直接忽略 —— 所以每个 item 的
 *    `done` 必须带**完整**数据，光发 delta 是不够的。
 * 2. `response.output_text.delta` 与工具参数 delta 到达时，Codex 要求
 *    `active_item` 已存在（否则 `error_or_panic`）—— 所以
 *    `response.output_item.added` 必须**先于**第一个 delta 发出。
 * 3. `response.completed.response.usage` 只要出现，`input_tokens` /
 *    `output_tokens` / `total_tokens` 就都是**必填**（`ResponseCompletedUsage`
 *    里这三个没有 Option）。漏一个会让 Codex 判「流损坏」并中断整轮。
 * 4. 未知事件与任何 `*.delta` 都是安全忽略的，所以多发的噪音事件不会炸。
 * 5. **freeform（`type:"custom"`）工具另有项类型**：请求侧声明成 custom 的工具
 *    （Codex 的 `apply_patch`），回包必须用 `custom_tool_call`（正文在 `input`），
 *    配 `response.custom_tool_call_input.delta/.done` 事件；发成 `function_call`
 *    会被 Codex 的工具路由器判 `tool … invoked with incompatible payload`。
 *    这两条是 2026-10-13 用**真实 codex.exe**（0.162.0-alpha.17.2，临时 CODEX_HOME +
 *    桩上游）对照实验确认的：桩按上面形状发，Codex 照常执行补丁并把
 *    `custom_tool_call` / `custom_tool_call_output` 回传进下一轮 `input`。
 * 6. `apply_patch` 是否声明**由客户端的模型目录决定**（`apply_patch_tool_type`，
 *    本机 Codex 只认 `"freeform"`，写别的报 `unknown variant`；不写=完全不提供）。
 * 7. **MCP / 分组工具是「延迟下发」的**（2026-10-13 实测，`codex-cli 0.162`，
 *    证据 `.workbuddy/artifacts/capture-codex-mcp-tools.md` + 真实 rollout）：
 *    它们**不在** `tools[]` 里，模型得先调 `type:"tool_search"` 的检索工具；
 *    命中结果以 `tool_search_output` 出现在**下一轮请求的 `input[]`** 里，形如
 *      `{type:"namespace", name:"mcp__node_repl", tools:[{type:"function", name:"js", …}]}`
 *    （注意：分组靠 `type:"namespace"` 的**嵌套对象**，不是 function 上的字符串字段）。
 *    桥三处都要做：① `tool_search` 翻成同名普通函数；② namespace 内层拍平成
 *    `mcp__<server>__<tool>` 声明给上游；③ 把 `tool_search_output` 里的工具**补进
 *    上游 `tools[]`**。回包侧：`tool_search` 必须回 `tool_search_call`
 *    （`execution:"client"`，`arguments` 是**对象**），分组工具必须回
 *    **短名 + 独立的 `namespace` 字段**（`FunctionCallResponseItem` 的可空字段；
 *    本机 08-09 那次跑通的会话里 135/135 条 MCP 调用都是这个形状）。
 *    少了任何一处，Codex 自带的 computer-use（唯一入口 `mcp__node_repl.js`）走桥
 *    就用不了 —— 而且**全程不报错**，只表现为"模型说要用但用不上"。
 * 8. `web_search` 等上游没有对应能力的内置工具**仍然丢掉**；丢的时候可以在请求日志
 *    的 `names=[…]` 里看出来（那里列出发往上游的**全部工具名**）。
 */

/**
 * 模型名解析。Codex 发的是它 config.toml 里的 `model`（默认 `gpt-5.1-codex`
 * 这类名字），上游没有这些 id。
 *
 * 顺序：① 精确命中上游目录就原样用（允许用户在 config.toml 里直接写真实模型）；
 * ② 带 mini/nano/flash/haiku 这类「小快」字样的走 fast 模型；
 * ③ 其余走默认。
 *
 * 默认取 `glm-5.3` 而不是桥的通用默认 `deepseek-v4.1-flash`：Codex 是 Agent，
 * 整轮依赖工具调用，`glm-5.3` 是实测 tool_calls 最稳的一个（与 Anthropic 层同理）。
 * **刻意不匹配 "codex" 这个词** —— `gpt-5.1-codex` 是它的主力模型，不是小快模型，
 * 拿它去当 fast 会把主任务降级。
 */
const RESPONSES_MODEL = process.env.WORKBUDDY_RESPONSES_MODEL || 'glm-5.3';
const RESPONSES_FAST_MODEL = process.env.WORKBUDDY_RESPONSES_FAST_MODEL || 'glm-5.3-flash';

function resolveResponsesModel(requested) {
  const name = typeof requested === 'string' ? requested : '';
  if (name && catalogCache.models.some((m) => m.id === name)) return name;
  if (name && /mini|nano|small|fast|flash|haiku/i.test(name)) return RESPONSES_FAST_MODEL;
  return RESPONSES_MODEL;
}

/** Responses 的 id 形如 `resp_…` / `msg_…` / `fc_…`；统一在这里生成。 */
const responsesId = (prefix) => `${prefix}_${trace().slice(0, 32)}`;

/**
 * Responses 的 `content` 归一成 chat/completions 的 content。
 *
 * 允许三种形态（真实客户端三种都会发）：
 *   - 纯字符串
 *   - `[{type:'input_text'|'output_text'|'text', text}]`
 *   - 带图片：`{type:'input_image', image_url}`（Responses 里 image_url 是**字符串**，
 *     与 chat 的 `{image_url:{url}}` 不同，要转一层）
 * `file_id` 形态的图片上游不支持，**显式丢弃并在日志里说一声**，不静默丢。
 */
function responsesPartsToOpenAI(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const p of content) {
    if (!p || typeof p !== 'object') continue;
    if (typeof p.text === 'string') {
      parts.push({ type: 'text', text: p.text });
      continue;
    }
    if (p.type === 'input_image' || p.type === 'image_url') {
      const url = typeof p.image_url === 'string' ? p.image_url : p.image_url?.url;
      if (typeof url === 'string' && url) {
        parts.push({ type: 'image_url', image_url: { url } });
      } else if (p.file_id) {
        // 上游没有文件 API，引用式图片接不了 —— 说清楚，别让模型凭空猜
        parts.push({ type: 'text', text: '[image omitted: file_id references are not supported by this bridge]' });
      }
      continue;
    }
  }
  if (!parts.length) return '';
  if (parts.length === 1 && parts[0].type === 'text') return parts[0].text;
  return parts;
}

/**
 * `function_call_output.output` 在线上是字符串**或**内容块数组。
 *
 * ⚠️ **图片块必须走视觉通道，绝不能 `JSON.stringify` 成文本。**
 *
 * 2026-10-13 实测（`.tmp-tool-image-degrade.mjs`，真实网关）：同一张 26 万字符的
 * 截图，两种发法的上游 `prompt_tokens`：
 *
 *   | 发法 | prompt_tokens | 单图成本 |
 *   |---|---|---|
 *   | 作为 `image_url` 内容块（视觉通道） | 1,005 | **987** |
 *   | `JSON.stringify` 成纯文本（原行为） | 184,736 | **184,718** |
 *
 * **差 187 倍。** 后果不是"慢"，而是**整轮崩掉**：Codex 自己按 ~1K 记帐，认为
 * 上下文才用 20 万 / 95 万，于是**永不触发自动压缩**；上游实际已收到 125 万
 * tokens → 400 `prompt is too long: 1252936 tokens > 1048576 maximum`。
 * 用户看到的是"干到一半整个回合突然断掉"（真实 rollout + bridge.log 双证）。
 *
 * 该会话 4 张图的复刻实验（`.tmp-reproduce-crash.mjs`）：
 * 降级 = 476,483 tokens；视觉通道 = 7,668 tokens（降 62 倍）。
 *
 * 所以这里返回**内容块数组** —— chat 协议里 `role:"tool"` 的 content 允许是数组，
 * 实测上游 200 且按视觉通道计费。只有"纯文本"时才降成字符串（省一层包装）。
 *
 * `file_id` 引用式图片上游没有文件 API，换成一句明确说明（不静默丢）；
 * 认不出的块保留 `JSON.stringify` 兜底 —— 丢内容比多花 token 更糟，
 * 只是不再有"图片被当文本"这种量级的代价。
 */
function responsesOutputContent(output) {
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) {
    const parts = [];
    for (const p of output) {
      if (typeof p === 'string') { parts.push({ type: 'text', text: p }); continue; }
      if (!p || typeof p !== 'object') { parts.push({ type: 'text', text: String(p) }); continue; }
      if (typeof p.text === 'string') { parts.push({ type: 'text', text: p.text }); continue; }
      if (p.type === 'input_image' || p.type === 'image_url') {
        const url = typeof p.image_url === 'string' ? p.image_url : p.image_url?.url;
        if (typeof url === 'string' && url) {
          parts.push({ type: 'image_url', image_url: { url } });
        } else if (p.file_id) {
          parts.push({ type: 'text', text: '[image omitted: file_id references are not supported by this bridge]' });
        }
        continue;
      }
      parts.push({ type: 'text', text: JSON.stringify(p) });
    }
    if (!parts.length) return '';
    if (parts.length === 1 && parts[0].type === 'text') return parts[0].text;
    return parts;
  }
  if (output == null) return '';
  return JSON.stringify(output);
}

/**
 * 只要文本的地方用它（`custom_tool_call.input` 之类**必须**是字符串的字段）。
 *
 * 图片在这里**降级成一句占位**而不是 `JSON.stringify` 整段 base64 —— 那些调用点
 * 没有视觉通道可走，把 26 万字符塞进字符串参数只会重演"图当文本"的灾难。
 */
function responsesOutputText(output) {
  const c = responsesOutputContent(output);
  if (typeof c === 'string') return c;
  return c.map((p) => (p.type === 'text' ? p.text : '[image omitted in this field]')).join('\n');
}

/**
 * Responses 的 `input` → OpenAI messages。
 *
 * 与 Anthropic 那层同源的几处结构性差异：
 * 1. 系统提示在这里可能出现在**两个地方**：顶层的 `instructions`，或 `input`
 *    第一条 `role:"system"|"developer"` 的 message（**Codex 用的是后者** ——
 *    它的请求结构里根本没有 `instructions` 字段）。两处都收，合并成一条 system。
 * 2. 工具调用与结果在 Responses 里是**平铺的独立 item**
 *    （`function_call` / `function_call_output`，以及 freeform 工具的
 *    `custom_tool_call` / `custom_tool_call_output`），而 chat 要求前者嵌在
 *    assistant.tool_calls、后者是独立的 `role:"tool"` 消息。freeform 的裸正文
 *    要按出站时声明过的 `{input}` 形状重新包成 JSON（见 `customToolDescription`）。
 * 3. 连续多个 `function_call` 必须**合成同一条** assistant 消息（chat 的语义就是
 *    "一次 assistant 回合发出多个调用"），否则上游会看到多条只带 tool_calls 的
 *    assistant 消息，与随后的 tool 结果对不上号。
 */
function responsesToOpenAIMessages(body) {
  const out = [];
  let systemText = typeof body?.instructions === 'string' ? body.instructions : '';

  const rawInput = body?.input;
  const items = typeof rawInput === 'string'
    ? [{ type: 'message', role: 'user', content: rawInput }]
    : (Array.isArray(rawInput) ? rawInput : []);

  /** 收集中的连续 function_call，攒够一段再合成一条 assistant 消息。 */
  let pendingCalls = [];
  const flushCalls = () => {
    if (!pendingCalls.length) return;
    out.push({ role: 'assistant', content: null, tool_calls: pendingCalls });
    pendingCalls = [];
  };

  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const type = typeof item.type === 'string' ? item.type : (item.role ? 'message' : '');

    if (type === 'message') {
      const role = item.role === 'assistant' ? 'assistant'
        : (item.role === 'system' || item.role === 'developer') ? 'system' : 'user';
      const content = responsesPartsToOpenAI(item.content);
      if (role === 'system') {
        /*
         * ⚠️ **多段 content 必须拍成文本，不能因为"不是字符串"就整段丢掉。**
         *
         * `responsesPartsToOpenAI` 的返回值有两种形态：纯文本时是 string，
         * 多段时是**内容块数组**。原先这里写的是
         *   `const text = typeof content === 'string' ? content : ''`
         * —— 数组一律变成空串，于是**整个 system 提示被静默丢弃**。
         *
         * 这不是理论问题：Codex Desktop 的 system prompt 正是
         * **一个 developer 项里挂 5 个 part**（app-context / skills_instructions /
         * permissions / collaboration_mode / plugins_instructions，实测 24,273 字符、
         * 占整个 system 的约 65%）。丢掉之后走下面的兜底
         * （`systemText || 'You are a helpful assistant.'`），模型拿到的是**一句
         * 通用问候语**：agent 人设、技能清单、沙箱与权限规则、协作模式全没了。
         *
         * 实测（假上游抓桥真正转发的 messages）：5 个 part 到达 0 个，
         * 转发的 system 就是 `"You are a helpful assistant."`。
         *
         * 所以这里按块拍平：文本块取 `text`，图片块给一句**明确说明**
         * （与 `file_id` 图片同一套处理 —— 不静默丢，也绝不把 base64 塞进 system）。
         * 空块跳过，避免拼出多余的空行。
         */
        const text = Array.isArray(content)
          ? content.map((p) => (p?.type === 'text' ? (p.text || '')
            : p?.type === 'image_url' ? '[image omitted: system messages carry text only]'
              : '')).filter(Boolean).join('\n')
          : (typeof content === 'string' ? content : '');
        if (text) systemText = systemText ? `${systemText}\n${text}` : text;
        continue;
      }
      flushCalls();
      out.push({ role, content });
    } else if (type === 'function_call') {
      /*
       * 分组工具（MCP / namespace）的调用记录带 `namespace` 字段（实测：
       * `{name:"js", namespace:"mcp__node_repl"}`）。回放给上游时必须拍平成**出站
       * 声明过的同一个名字** `mcp__node_repl__js`，否则上游看到的是一个从没声明过的工具。
       */
      const ns = typeof item.namespace === 'string' ? item.namespace : '';
      pendingCalls.push({
        id: item.call_id || item.id || `call_${trace().slice(0, 20)}`,
        type: 'function',
        function: {
          name: flattenToolName(ns, typeof item.name === 'string' ? item.name : ''),
          arguments: typeof item.arguments === 'string'
            ? item.arguments
            : JSON.stringify(item.arguments ?? {}),
        },
      });
    } else if (type === 'custom_tool_call') {
      /*
       * freeform 工具（apply_patch）的调用记录：客户端手里是裸正文，而上游的
       * 函数接口要 JSON —— 回传时按我们在出站时声明的同一形状（`{input}`）重新包上，
       * 否则下一轮上游会看到一条"参数不是合法 JSON"的 assistant tool_call。
       */
      const ns = typeof item.namespace === 'string' ? item.namespace : '';
      pendingCalls.push({
        id: item.call_id || item.id || `call_${trace().slice(0, 20)}`,
        type: 'function',
        function: {
          name: flattenToolName(ns, typeof item.name === 'string' ? item.name : ''),
          arguments: JSON.stringify({ input: responsesOutputText(item.input) }),
        },
      });
    } else if (type === 'tool_search_call') {
      /*
       * 上一轮模型做的「延迟工具检索」。上游没有这个概念，按出站声明过的名字
       * （`tool_search`）回放成一次普通函数调用 —— 不回放的话历史里就少了一环，
       * 模型会以为检索没做过、对同一个 query 反复重试。
       */
      pendingCalls.push({
        id: item.call_id || item.id || `call_${trace().slice(0, 20)}`,
        type: 'function',
        function: {
          name: TOOL_SEARCH_NAME,
          arguments: JSON.stringify(item.arguments ?? {}),
        },
      });
    } else if (type === 'tool_search_output') {
      /*
       * 检索结果：内容是一堆 `namespace{tools[]}` 分组定义。那些工具接下来会被
       * 补进上游的 `tools[]`（见 withDeferredTools），所以这里只需要给模型一条
       * **工具结果消息**，把「现在多了哪些工具」讲清楚；不回的话模型不知道检索
       * 生效了，会反复检索。原先这里与 reasoning 一起被**静默丢弃**。
       */
      flushCalls();
      out.push({
        role: 'tool',
        /*
         * ⚠️ 必须与上面 push `pendingCalls` 时**用同一个表达式**取 id。
         *
         * assistant 侧写的是 `item.call_id || item.id || call_…`，而这里原先只认
         * `item.call_id` —— 于是历史里出现「调用 id = `fc_1`、结果 id = ""」的
         * 不对称：上游拿这个 tool 消息对不上任何一次调用，只能把它当孤儿丢掉，
         * 模型表现为"忘了自己刚才查过什么"、然后重复做同一件事。
         *
         * `call_id` 在客户端 schema 里是可选的（桥自己发出的每一项都带 `id`），
         * 所以 `item.id` 这条回退是必需的 —— 与 assistant 侧保持一致。
         */
        tool_call_id: item.call_id || item.id || '',
        content: describeDiscoveredTools(item.tools),
      });
    } else if (type === 'function_call_output' || type === 'custom_tool_call_output') {
      flushCalls();
      out.push({
        role: 'tool',
        // 同上：与 assistant 侧同款回退，避免出现对不上号的 tool 结果
        tool_call_id: item.call_id || item.id || '',
        /*
         * ⚠️ 这里用 `responsesOutputContent`（保留图片块），**不是** `responsesOutputText`。
         * 截图经 tool 输出回来时是 `{type:"input_image", image_url:"data:image/jpeg;base64,…"}`；
         * 一旦降级成字符串，单图从 ~1K 变 18 万 tokens（实测 187 倍），
         * 会话会因上游 `prompt is too long` 整轮崩掉。详见该函数的注释。
         */
        content: responsesOutputContent(item.output),
      });
    }
    // reasoning / 其它 item：丢弃。思维链不回传给上游（拿不到加密的
    // reasoning content，回传一个空壳反而会污染上下文）。
  }
  flushCalls();

  out.unshift({ role: 'system', content: systemText || 'You are a helpful assistant.' });
  return out;
}

/**
 * Responses tools → OpenAI tools。
 *
 * 两种写法都收：Responses 是**扁平**的 `{type:'function',name,parameters}`，
 * chat 是**嵌套**的 `{type:'function',function:{name,parameters}}`。
 * 只认一种的话，客户端换个写法就在桥这里静默变成「没有工具」——
 * 那会让 Agent 直接失去动手能力，且不报错。
 *
 * 逐类工具的处理：
 *   1. `function` —— 直接翻；
 *   2. `custom`（freeform，如 Codex 的 `apply_patch`）—— **翻成 `input: string` 的
 *      普通函数**（见 `customToolFunction`）。原先这里是**静默丢掉**，结果是
 *      "系统提示让模型用 apply_patch、工具表里却没有它"：模型靠提示去蒙调用，
 *      Codex 收到 function_call 又因为该工具声明是 freeform 而判
 *      `tool apply_patch invoked with incompatible payload`，整轮白烧（2026-10-13
 *      实测现场）。回包侧按 `custom_tool_call` 回（见 relayResponsesStream）。
 *   3. `tool_search`（**延迟工具检索的闸门**，`execution:"client"`）—— 翻成同名普通
 *      函数，回包侧必须回 `tool_search_call`（见 closeTool）。**原先这里与 web_search
 *      一起被丢掉**：于是 Codex 的 MCP 工具（含 computer-use 的唯一入口
 *      `mcp__node_repl.js`）走桥时永远发现不了，而且**不报错**——这是
 *      「走桥就用不了 computer-use」的直接原因，不是"协议本来不通"。
 *   4. `namespace` 分组（`{type:"namespace", name:"mcp__x", tools:[…]}`）—— 内层拍平成
 *      `mcp__x__tool`（见 flattenToolName），回包侧再拆回短名 + `namespace` 字段。
 *      原先整个分组被丢掉，组里的工具一个都到不了上游。
 *   5. 其它内置工具（`web_search` / `local_shell` 等）上游没有对应能力，丢掉。
 *      ⚠️ **丢掉的名字要记下来**（`dropped`），请求日志里打出来 ——
 *      2026-10-13 的 `apply_patch`（custom）与 `tool_search` 两次翻车，
 *      根因都是"工具被静默丢掉"，而日志只记**翻译后**的个数与名字，
 *      于是这件事在日志里完全不可见。见 `buildToolRoutes` 的 `dropped`。
 */
function responsesToolsToOpenAI(tools) {
  if (!Array.isArray(tools)) return null;
  const out = [];
  for (const t of tools) {
    if (!t || typeof t !== 'object') continue;
    if (t.type === 'custom') {
      const name = typeof t.name === 'string' ? t.name : '';
      if (!name) continue;
      out.push(customToolFunction(name, t));
      continue;
    }
    if (t.type === TOOL_SEARCH_NAME) {
      out.push({
        type: 'function',
        function: {
          name: TOOL_SEARCH_NAME,
          description: typeof t.description === 'string' ? t.description : '',
          parameters: t.parameters && typeof t.parameters === 'object'
            ? t.parameters
            : { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
        },
      });
      continue;
    }
    if (Array.isArray(t.tools)) {
      const ns = typeof t.name === 'string' ? t.name : '';
      for (const child of t.tools) {
        const decl = toolDeclarationToOpenAI(ns, child);
        if (decl) out.push(decl);
      }
      continue;
    }
    if (typeof t.type === 'string' && t.type !== 'function') continue;
    const fn = t.function && typeof t.function === 'object' ? t.function : t;
    const name = typeof fn.name === 'string' ? fn.name : '';
    if (!name) continue;
    out.push({
      type: 'function',
      function: {
        name,
        description: typeof fn.description === 'string' ? fn.description : '',
        parameters: fn.parameters && typeof fn.parameters === 'object'
          ? fn.parameters
          : { type: 'object', properties: {} },
      },
    });
  }
  return out.length ? out : null;
}

/** 桥给 custom（freeform）工具补的说明：告诉模型"在这里它就是个普通函数"。 */
const CUSTOM_TOOL_BRIDGE_NOTE = 'Local bridge note: this tool is exposed here as an ordinary '
  + 'function — put the complete payload text (not a JSON-wrapped copy) in the string argument `input`.';

/**
 * custom/freeform 工具的描述改写。
 *
 * 原文是给 freeform 通道写的（Codex 的 apply_patch 明说 "do not wrap the patch in
 * JSON"），而桥这边**必须**让模型包一层 JSON —— 两句话直接打架，模型就会犹豫或
 * 蒙调用。把那一句就地改写成事实（用 `input` 参数），再补一条桥说明。
 */
function customToolDescription(t) {
  const raw = typeof t.description === 'string' ? t.description : '';
  const fixed = raw.replace(
    /do not wrap the (?:patch|payload|tool input|input) in json/gi,
    'pass the patch text in the `input` argument',
  );
  return fixed ? `${fixed}\n\n${CUSTOM_TOOL_BRIDGE_NOTE}` : CUSTOM_TOOL_BRIDGE_NOTE;
}

/**
 * 请求里声明为 `custom`（freeform）的工具名集合 —— 回包侧要靠它决定**项类型**
 * （`custom_tool_call` 还是 `function_call`），错了客户端就判
 * `incompatible payload`。
 *
 * 两种摆放位置都扫（与 `responsesToolsToOpenAI` / `responsesToolsFromAdditional`
 * 同一套遍历规则）：顶层 `tools`，以及 code mode 的 `input[].additional_tools`（可嵌套 namespace）。
 */
function collectCustomToolNames(body) {
  const names = new Set();
  const walk = (list) => {
    if (!Array.isArray(list)) return;
    for (const t of list) {
      if (!t || typeof t !== 'object') continue;
      if (Array.isArray(t.tools)) { walk(t.tools); continue; }
      if (t.type === 'custom' && typeof t.name === 'string' && t.name) names.add(t.name);
    }
  };
  walk(body?.tools);
  if (Array.isArray(body?.input)) {
    for (const it of body.input) {
      if (it && it.type === 'additional_tools') walk(it.tools);
    }
  }
  return names;
}

/**
 * Codex 的「分组工具」命名约定 → 上游函数名。
 *
 * Codex 里一组工具长这样：`{type:"namespace", name:"mcp__node_repl",
 * tools:[{type:"function", name:"js", …}]}` —— 内层用的是**短名**；调用记录则是
 * `{type:"function_call", name:"js", namespace:"mcp__node_repl", arguments:"{…}"}`
 * （本机 2026-08-09 那次真正跑通的 computer-use 会话里，135 条 MCP 调用**全部**
 * 是这个形状：短名 + 独立的 `namespace` 字段）。
 *
 * 上游 chat/completions 没有 namespace 概念，所以拍平成一个唯一名字
 * `mcp__node_repl__js`（这个格式 Codex 自己的二进制里也写着）。
 */
function flattenToolName(namespace, name) {
  return namespace ? `${namespace}__${name}` : name;
}

/** 出站时记下的映射：上游函数名 → Codex 的 namespace。回包时按它拆回短名。 */
function splitWireName(routes, wireName) {
  const namespace = routes?.namespace?.get(wireName);
  if (!namespace) return { name: wireName, namespace: '' };
  return { name: wireName.slice(namespace.length + 2), namespace };
}

/** `tool_search` 的实参：Codex 要的是**对象**（`{query, limit?}`），不是 JSON 字符串。 */
function parseToolSearchArgs(args) {
  if (args && typeof args === 'object') return args;
  if (typeof args !== 'string') return { query: '' };
  try {
    const parsed = JSON.parse(args);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch { /* 不是 JSON：按原样塞进 query，别把调用整条丢掉 */ }
  return { query: args };
}

/** custom（freeform）声明的上游函数形状：唯一必需的字符串参数 `input`。 */
function customToolFunction(name, spec) {
  return {
    type: 'function',
    function: {
      name,
      description: customToolDescription(spec),
      /*
       * freeform 的 grammar 传不过去（chat/completions 没有这个字段），
       * 退化成唯一必需的字符串参数。模型按 JSON 调，桥再把 `input` 拆出来
       * 当 freeform 正文回给客户端。
       */
      parameters: {
        type: 'object',
        properties: {
          input: {
            type: 'string',
            description: 'The complete payload for this freeform tool (e.g. the full patch text).',
          },
        },
        required: ['input'],
        additionalProperties: false,
      },
    },
  };
}

/** 一份工具声明 → 上游函数（`custom` 与 `function` 的差异只在这一处）。 */
function toolDeclarationToOpenAI(namespace, spec) {
  if (!spec || typeof spec !== 'object') return null;
  const name = typeof spec.name === 'string' ? spec.name : '';
  if (!name) return null;
  const wire = flattenToolName(namespace, name);
  if (spec.type === 'custom') return customToolFunction(wire, spec);
  return {
    type: 'function',
    function: {
      name: wire,
      description: typeof spec.description === 'string' ? spec.description : '',
      parameters: spec.parameters && typeof spec.parameters === 'object'
        ? spec.parameters
        : { type: 'object', properties: {} },
    },
  };
}

function addDeferred(map, namespace, spec) {
  if (!spec || typeof spec !== 'object') return;
  const name = typeof spec.name === 'string' ? spec.name : '';
  if (!name) return;
  const wire = flattenToolName(namespace, name);
  if (!map.has(wire)) map.set(wire, { namespace, name, spec });
}

/**
 * 收集**延迟下发**的工具声明。
 *
 * Codex 不把 MCP 工具放进顶层 `tools[]`，只给一个 `type:"tool_search"` 的检索工具；
 * 模型检索过之后，命中结果才以 `{type:"tool_search_output", tools:[namespace…]}`
 * 的形式出现在**下一轮请求**的 `input[]` 里（实测：`codex-cli 0.162`，见
 * `.workbuddy/artifacts/capture-codex-mcp-tools.md`）。
 *
 * 桥必须把它们补进上游的 `tools[]` —— 否则模型既看不到也调不了。Codex 自带
 * computer-use 的唯一入口 `mcp__node_repl.js` 正是走这条路：**这就是「走桥就用不了
 * computer-use」的直接原因**，不是「协议本来不通」。
 */
function collectDeferredTools(body) {
  const out = new Map();
  const items = Array.isArray(body?.input) ? body.input : [];
  for (const item of items) {
    if (!item || item.type !== 'tool_search_output') continue;
    for (const group of Array.isArray(item.tools) ? item.tools : []) {
      if (!group || typeof group !== 'object') continue;
      if (Array.isArray(group.tools)) {
        const ns = typeof group.name === 'string' ? group.name : '';
        for (const child of group.tools) addDeferred(out, ns, child);
      } else {
        addDeferred(out, '', group);
      }
    }
  }
  return out;
}

/**
 * 一次 `/v1/responses` 请求的工具路由表：请求侧建好，回包侧照着还原。
 *
 * - `custom`     freeform 工具名 → 回 `custom_tool_call`（裸正文放 `input`）
 * - `namespace`  上游函数名 → Codex 的 namespace → 回 `function_call` 时补 `namespace`
 * - `deferred`   `tool_search_output` 带出来的工具定义 → 补进上游 `tools[]`
 * - `toolSearch` 本次是否声明了 `tool_search` → 模型调它时要回 `tool_search_call`
 * - `dropped`    **被丢掉、没转发给上游**的工具名/类型 → 只用于日志
 *
 * ## `dropped` 为什么必须有
 *
 * 请求日志原先打 `tools=N names=[…]`，而 `N` 与 `names` 都是**翻译后**的结果，
 * 两者必然自洽 —— 于是"某个工具被静默丢掉"在日志里**完全看不出来**。
 * 2026-10-13 连续两次翻车（`apply_patch` 的 `custom`、MCP 的 `tool_search`）
 * 都栽在这个盲区上：日志显示 `tools=10` 看着正常，实际少了模型唯一的入口。
 *
 * 现在把丢掉的名字也打出来，下次同类问题**一眼可见**。
 */
function buildToolRoutes(body) {
  const routes = {
    custom: collectCustomToolNames(body),
    namespace: new Map(),
    deferred: collectDeferredTools(body),
    toolSearch: false,
    dropped: new Set(),
  };
  for (const [wire, entry] of routes.deferred) {
    if (entry.namespace) routes.namespace.set(wire, entry.namespace);
    if (entry.spec && entry.spec.type === 'custom') routes.custom.add(wire);
  }
  // 顶层 `tools[]` 里的分组声明（Codex 的 multi-agent / `collaboration` 用这个形状）
  const list = Array.isArray(body?.tools) ? body.tools : [];
  for (const t of list) {
    if (!t || typeof t !== 'object') continue;
    if (t.type === TOOL_SEARCH_NAME) { routes.toolSearch = true; continue; }
    if (!Array.isArray(t.tools)) {
      /*
       * 判据必须与 `responsesToolsToOpenAI` **逐条一致**，否则会误报：
       * 那里能处理的类型是 `custom`（freeform）、`function`、以及无 type 的普通函数；
       * 其余（`web_search` / `local_shell` / `mcp` …）才是真的被丢掉。
       *
       * 实测教训：第一版这里漏了排除 `custom`，于是日志打出
       * `dropped=apply_patch,web_search` —— 而同一行还写着 `freeform=apply_patch`
       * （即它**转发成功了**）。一条自相矛盾的日志比没有日志更坏：
       * 它会让人去查一个根本不存在的故障。
       */
      if (typeof t.type === 'string' && t.type !== 'function' && t.type !== 'custom') {
        routes.dropped.add(typeof t.name === 'string' && t.name ? t.name : t.type);
      }
      continue;
    }
    const ns = typeof t.name === 'string' ? t.name : '';
    if (!ns) continue;
    for (const child of t.tools) {
      const cn = child && typeof child.name === 'string' ? child.name : '';
      if (!cn) continue;
      routes.namespace.set(flattenToolName(ns, cn), ns);
      if (child.type === 'custom') routes.custom.add(flattenToolName(ns, cn));
    }
  }
  return routes;
}

/** 把延迟工具补进上游的 `tools[]`（已有同名声明就不重复发）。 */
function withDeferredTools(tools, deferred) {
  if (!deferred || !deferred.size) return tools;
  const out = Array.isArray(tools) ? tools.slice() : [];
  const seen = new Set(out.map((t) => t?.function?.name).filter(Boolean));
  for (const [wire, entry] of deferred) {
    if (seen.has(wire)) continue;
    const decl = toolDeclarationToOpenAI(entry.namespace, entry.spec);
    if (!decl) continue;
    seen.add(wire);
    out.push(decl);
  }
  return out.length ? out : null;
}

/**
 * `tool_search` 检索结果 → 给模型的**工具结果正文**。
 *
 * 只列名字、不重复描述：这些描述紧接着会随 `tools[]` 一起发过去，抄两遍纯属烧
 * token（本仓对上行 token 很敏感）。但没有这条消息的话，模型不知道检索生效了，
 * 会对同一个 query 反复检索。
 */
function describeDiscoveredTools(groups) {
  const names = [];
  for (const g of Array.isArray(groups) ? groups : []) {
    if (!g || typeof g !== 'object') continue;
    if (Array.isArray(g.tools)) {
      const ns = typeof g.name === 'string' ? g.name : '';
      for (const c of g.tools) {
        const n = c && typeof c.name === 'string' ? c.name : '';
        if (n) names.push(flattenToolName(ns, n));
      }
    } else if (typeof g.name === 'string') {
      names.push(g.name);
    }
  }
  if (!names.length) return 'Tool search returned no matching tools. Try a different query.';
  return `Tool search results. These tools are now callable: ${names.join(', ')}`;
}

/**
 * 模型回给 custom 工具的调用参数 → freeform 正文。
 *
 * 模型按上游的函数接口调用，参数是 JSON（`{"input":"*** Begin Patch…"}`）；
 * 客户端要的是**裸正文**。认几个常见键名，都没有就原样回 —— 至少不会丢内容，
 * 客户端那边会给出"补丁格式不对"的明确报错，比静默乱猜好。
 */
function customToolInput(argumentsText) {
  const raw = typeof argumentsText === 'string' ? argumentsText : '';
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return raw; }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    for (const key of ['input', 'patch', 'text', 'content', 'body']) {
      if (typeof parsed[key] === 'string') return parsed[key];
    }
  }
  return raw;
}

/**
 * 新版 Codex 的 **code mode** 把工具定义塞在 `input[]` 的 `additional_tools` 条目里
 * （顶层**没有** `tools`），形状是 `namespace` 套 `function`，外加一个 freeform 的
 * `custom` 工具（`exec`：让模型写 JavaScript 去编排工具调用，shell / apply_patch
 * 都收在它后面）。
 *
 * 桥的上游是 chat/completions，**接不了 freeform 那套**：`exec` 是"让模型写 JS
 * 去编排工具"的**编排协议**，不是普通工具调用（与 `apply_patch` 那种独立
 * freeform 工具不同 —— 后者在经典 function tools 路径上已经支持，见
 * `responsesToolsToOpenAI` 的 `custom` 分支）。这里把能翻的 `function` 工具
 * 翻出来（至少 collaboration 那几个还能用），并在碰到 `custom` 时**说清楚**：
 * 否则用户看到的是"模型把工具调用写进正文"（一串
 * `<||DSML||invoke name="exec_command">` 标记），完全不知道问题出在哪。
 * 正解是让客户端的模型目录里 `use_responses_lite: false`（见 lib/client-connect.mjs
 * 的 makeCatalogEntry）——那会走经典 function tools，也就是这条兜底路径没被触发的状态。
 */
function responsesToolsFromAdditional(body) {
  const items = Array.isArray(body?.input)
    ? body.input.filter((x) => x && x.type === 'additional_tools')
    : [];
  if (!items.length) return null;

  const flat = [];
  const freeform = [];
  const walk = (list) => {
    for (const t of list || []) {
      if (!t || typeof t !== 'object') continue;
      if (Array.isArray(t.tools)) { walk(t.tools); continue; }        // namespace
      if (t.type === 'custom') { freeform.push(t.name || '(未命名)'); continue; }
      if (t.type === 'function' || (!t.type && typeof t.name === 'string')) flat.push(t);
    }
  };
  for (const it of items) walk(it.tools);

  if (freeform.length) {
    log(
      `code-mode 工具协议：客户端把工具放在 input[].additional_tools 里，其中 `
      + `${freeform.join('/')} 是 freeform 编排工具（模型要写 JS 去编排），桥这层不翻译 `
      + `—— 只转发了 ${flat.length} 个 classic function 工具。`
      + `解决办法：让该客户端的模型目录里 use_responses_lite=false（回到经典 function tools）。`,
    );
  }
  return responsesToolsToOpenAI(flat);
}

/**
 * Responses 的 tool_choice：字符串（`auto`/`none`/`required`）或对象
 * （`{type:'function',name}` / `{type:'allowed_tools',...}`）。
 * 对象形式统一落到 `required`（上游只认字符串，见 normalizePayload 的同类处理）。
 */
function responsesToolChoiceToOpenAI(tc) {
  if (typeof tc === 'string') return ['auto', 'none', 'required'].includes(tc) ? tc : null;
  if (tc && typeof tc === 'object') return 'required';
  return null;
}

/**
 * 上游 HTTP 状态码 / 错误文本 → Codex 认识的 `error.code`。
 *
 * 为什么要映射：Codex 的 `parse_failed_response`
 * （`codex-rs/codex-api/src/sse/responses_error.rs`）按 `error.code` 分派：
 *   - `rate_limit_exceeded` / `slow_down` → `RateLimitExceeded`（**带 retry_after，可自动退避**）
 *   - `context_length_exceeded`          → `ContextWindowExceeded`（界面给准确提示）
 *   - `server_is_overloaded`             → `ServerOverloaded`
 *   - `insufficient_quota` 等            → `QuotaExceeded`
 *   - 其余（含认不出的字串）              → `Retryable`
 *
 * 原来我们发的是 `String(up.status)`（`"429"` / `"500"`…），**全部落进 `_`
 * 那一支的 Retryable**：429 拿不到官方退避节奏、上下文超限退化成泛化提示。
 * 这里做最小映射（只映射语义明确的几个），其余保持原状不误导。
 */
function responsesErrorCode(status, message, parsedCode) {
  const text = String(message || '').toLowerCase();
  if (Number(status) === 429) return 'rate_limit_exceeded';
  /*
   * 上下文超限的措辞要认全。**上游真实原文**（2026-10-13 bridge.log 实测）：
   *
   *   {"code":11115,"msg":"prompt is too long: 1252936 tokens > 1048576 maximum"}
   *
   * 原来这条**不匹配**（旧正则只认 `context length` / `too many tokens` /
   * `maximum context`），于是 `responsesErrorCode` 落到兜底 `upstream_error`
   * → Codex 归到 `Retryable` → **原样重发 6 次、耗掉 249 秒**，最后给用户一句
   * 泛化的失败；而它本可以立刻走 `ContextWindowExceeded` 去裁剪/压缩上下文。
   * 实测同一请求连续 6 条 400 全是这个原因（08:50:33 → 08:52:16）。
   *
   * 所以补上 `too long` / `exceeds the maximum` 这两个真实措辞。
   */
  if (/context[_ ]?length|context[_ ]?window|too many tokens|maximum context/.test(text)
    || /(prompt|input|request|message|conversation)[^.]{0,40}too long/.test(text)
    || /exceeds? the maximum|maximum (?:number of )?tokens/.test(text)) {
    return 'context_length_exceeded';
  }
  if (/insufficient[_ ]?quota|credit[_ ]?balance|spend[_ ]?limit/.test(text)) return 'insufficient_quota';
  if (Number(status) >= 500) return 'server_is_overloaded';
  // 上游自己给的机器可读 code 若本来就是官方认识的字串，原样透传
  return typeof parsedCode === 'string' && parsedCode ? parsedCode : 'upstream_error';
}

/**
 * 上游 usage → Responses 的 usage。三个总数是 Codex 的必填项，一律补齐。
 *
 * **明细要透传**（`input_tokens_details.cached_tokens` /
 * `output_tokens_details.reasoning_tokens`）—— Codex 的 `ResponseCompletedUsage`
 * 会把它们读进 `TokenUsage`
 * （`codex-rs/codex-api/src/sse/responses.rs` 的 `impl From<ResponseCompletedUsage>`），
 * 用户据此看到「缓存命中」与「思考 token」。原来硬编码成 0，等于把上游给的账丢了。
 *
 * 上游 chat 协议里的对应字段名不同（`prompt_tokens_details.cached_tokens` /
 * `completion_tokens_details.reasoning_tokens`），这里做一次映射；
 * 上游没给就补 0（Codex 这几个子字段是非 Option 的，缺了会解析失败）。
 */
function responsesUsage(u) {
  const input = Number(u?.prompt_tokens) || 0;
  const output = Number(u?.completion_tokens) || 0;
  const total = Number(u?.total_tokens) || input + output;
  const cached = Number(u?.prompt_tokens_details?.cached_tokens) || 0;
  const reasoning = Number(u?.completion_tokens_details?.reasoning_tokens) || 0;
  return {
    input_tokens: input,
    input_tokens_details: { cached_tokens: cached },
    output_tokens: output,
    output_tokens_details: { reasoning_tokens: reasoning },
    total_tokens: total,
  };
}

/** 聚合后的 assistant 消息 → Responses 的 `output` 数组。 */
function openAIToResponsesOutput(message, routes = null) {
  const customTools = routes?.custom ?? new Set();
  const items = [];
  const text = typeof message?.content === 'string' ? message.content : '';
  if (text) {
    items.push({
      id: responsesId('msg'),
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text, annotations: [] }],
    });
  }
  for (const tc of message?.tool_calls || []) {
    if (!tc) continue;
    const name = tc.function?.name || '';
    const callId = tc.id || `call_${trace().slice(0, 20)}`;
    const args = typeof tc.function?.arguments === 'string'
      ? tc.function.arguments
      : JSON.stringify(tc.function?.arguments ?? {});
    /*
     * 形状必须与**流式那条一致**：请求里声明为 custom（freeform）的工具回
     * `custom_tool_call`（裸正文），普通工具回 `function_call`（JSON 字符串）。
     * 两边不一致时，非流式客户端的工具路由器会判 `incompatible payload`。
     */
    if (customTools.has(name)) {
      items.push({
        id: responsesId('ctc'),
        type: 'custom_tool_call',
        status: 'completed',
        call_id: callId,
        name,
        input: customToolInput(args),
      });
      continue;
    }
    /*
     * 延迟工具检索：Codex 只认 `tool_search_call`（`execution:"client"`，且
     * `arguments` 是**对象**而不是 JSON 字符串）。回 `function_call` 会被它的
     * 工具路由器拒掉。与流式那条同形。
     */
    if (name === TOOL_SEARCH_NAME && routes?.toolSearch) {
      items.push({
        id: responsesId('tsc'),
        type: 'tool_search_call',
        status: 'completed',
        execution: 'client',
        call_id: callId,
        arguments: parseToolSearchArgs(args),
      });
      continue;
    }
    /*
     * 分组工具还原成 Codex 认的形状：`name` 用**短名** + 独立的 `namespace` 字段
     * （实测 135/135 条 MCP 调用都是这个形状）。上游侧用的是拍平名
     * `mcp__node_repl__js`，这里按出站时记下的映射拆回去。
     */
    const { name: emitName, namespace } = splitWireName(routes, name);
    items.push({
      id: responsesId('fc'),
      type: 'function_call',
      status: 'completed',
      call_id: callId,
      name: emitName,
      ...(namespace ? { namespace } : {}),
      arguments: args,
    });
  }
  // 空回答也要给一条 message：output 是空数组时 Codex 会当成「没有任何输出」，
  // 用户看到的是卡住而不是「模型返回了空内容」，两者处置方式完全不同。
  if (!items.length) {
    items.push({
      id: responsesId('msg'),
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: '', annotations: [] }],
    });
  }
  return items;
}

/** output 数组 → 顶层的 `output_text`（真实 API 会带这个便利字段）。 */
const responsesTextOf = (output) => output
  .filter((i) => i.type === 'message')
  .flatMap((i) => i.content || [])
  .map((c) => c.text || '')
  .join('');

/** 聚合结果 → 完整的 Responses 对象（非流式）。 */
function openAIToResponsesResponse(agg, model, routes = null) {
  const choice = (agg.choices || [])[0] || {};
  const output = openAIToResponsesOutput(choice.message, routes);
  const truncated = choice.finish_reason === 'length';
  return {
    id: responsesId('resp'),
    object: 'response',
    created_at: Number(agg.created) || Math.floor(Date.now() / 1000),
    status: truncated ? 'incomplete' : 'completed',
    model,
    headers: { 'openai-model': model },
    output,
    output_text: responsesTextOf(output),
    parallel_tool_calls: true,
    tool_choice: 'auto',
    tools: [],
    usage: responsesUsage(agg.usage),
    error: null,
    // 同流式那条：`incomplete` 的 reason 只能是 `interrupted`（见 relayResponsesStream
    // 里那段说明）。`end_turn` 两边一致地给。
    incomplete_details: truncated ? { reason: 'interrupted' } : null,
    end_turn: !truncated,
    instructions: null,
    metadata: {},
    temperature: null,
    top_p: null,
    max_output_tokens: null,
  };
}

/**
 * 把上游的 OpenAI SSE 流翻译成 Responses 的 SSE 事件流，直接写进 `res`。
 *
 * 事件顺序（照真实 Responses API 的形状，见本层顶部那四条实测约束）：
 *
 *   text : created → in_progress → output_item.added → content_part.added
 *          → output_text.delta× → output_text.done → content_part.done
 *          → output_item.done
 *   tool : output_item.added → function_call_arguments.delta×
 *          → function_call_arguments.done → output_item.done
 *   freeform 工具（`customTools`，如 Codex 的 apply_patch）:
 *          output_item.added(item.type=custom_tool_call)
 *          → custom_tool_call_input.delta → custom_tool_call_input.done
 *          → output_item.done(item.type=custom_tool_call, input=裸正文)
 *   延迟工具检索（模型调 `tool_search`）:
 *          output_item.done(item.type=tool_search_call, arguments=**对象**)
 *          —— 它没有 delta 事件，所以既不发 added 也不发任何 `*_arguments.*`
 *   分组工具（MCP，出站声明为 `mcp__node_repl__js`）:
 *          与普通 tool 同形，但回包时把名字拆回**短名 + `namespace` 字段**
 *   收尾 : response.completed（带完整 output 与 usage）
 *
 * 文本块与工具块共用一个 **单调递增的 output_index**，且每开新块前必须先把
 * 上一个块关掉（`closeText()`）—— 顺序乱了 Codex 会判流损坏。
 *
 * 返回 `{ finishReason, usage, streamError }` 供调用方记账。
 */
async function relayResponsesStream(up, res, model, routes = null, options = {}) {
  const customTools = routes?.custom ?? new Set();
  let backpressured = false;
  const send = (type, obj) => {
    backpressured = !res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...obj })}\n\n`);
  };

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    ...SECURITY_HEADERS,
  });

  const responseId = responsesId('resp');
  const createdAt = Math.floor(Date.now() / 1000);
  /**
   * `headers.openai-model` 是 Codex 认「**实际生效的模型**」的地方
   * （`codex-rs/codex-api/src/sse/responses.rs` 的 `response_model()` 优先读
   * `response.headers` 里的 `openai-model`）。我们这里 model 是**解析后**的真实
   * 上游模型（Codex 发来的可能是 `gpt-5.1-codex`），回显它，客户端的模型显示
   * 才是真的、而不是它自己填的那个占位名。
   */
  const envelope = (status) => ({
    id: responseId,
    object: 'response',
    created_at: createdAt,
    status,
    model,
    headers: { 'openai-model': model },
    output: [],
    output_text: '',
    parallel_tool_calls: true,
    tool_choice: 'auto',
    tools: [],
    usage: null,
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: {},
  });

  send('response.created', { response: envelope('in_progress') });
  send('response.in_progress', { response: envelope('in_progress') });

  let outputIndex = -1;
  const output = [];          // 按顺序攒完整 item，最后一次给 response.completed
  let textSlot = null;        // 打开中的 message 项
  const toolSlots = new Map(); // 上游 tool_calls 的 index → slot
  let pendingTool = null;     // 已分配索引但还没发 output_item.added 的工具块

  /**
   * 上游的思维链要不要转给 Codex（`WORKBUDDY_FORWARD_REASONING=1`）。
   *
   * ## 为什么默认**关**
   *
   * Codex 要求 `response.reasoning_summary_text.delta` 到达时**已有 active output
   * item**（桥的注释里记着：不满足会让它中断整轮），而上游的 `reasoning_content`
   * 总是先于任何 content / tool_call 到达 —— 所以要先把 reasoning 项**打开**、
   * 发完 delta 再关掉，才轮到文本块。顺序是：reasoning item → message item。
   *
   * 事件名不是猜的：在 `codex.exe` 里能搜到 `reasoning_summary_text.delta` /
   * `reasoning_summary_part.added` / `response.reasoning_summary_text.done` /
   * `output_item.added`，说明它认这套。但**两件事必须真机对照实验才能定论**：
   *   1. 这个事件顺序它是否全盘接受（不接受的表现是整轮中断）；
   *   2. 我们目录条目里的 `default_reasoning_summary` 取值（本机模板给的是
   *      `"none"`）—— 若 Codex 尊重它，光转发事件用户还是看不到东西。
   *
   * 所以做成开关：**默认行为一个字节不变**（丢弃 + 记一条日志），想试的人自己开，
   * 试坏了把开关去掉即可。验证办法见 `docs/TROUBLESHOOTING.md`。
   */
  /*
   * 思维链事件只发给**明确要它的客户端**。
   *
   * 背景（Cherry Studio #20940）：Cherry 的 Responses 解析器是 Zod 白名单，
   * 只认 `response.output_text.delta` 一类事件；收到
   * `response.reasoning_summary_text.delta` / `response.output_item.added`
   * 会直接 abort 整轮。Codex 则需要 reasoning summary 事件才会显示摘要。
   *
   * 因此即使打开 `WORKBUDDY_FORWARD_REASONING=1`，也只对 Codex UA、请求里
   * 显式声明 reasoning summary、或带 `x-workbuddy-forward-reasoning: 1` 的
   * 请求转发；其它客户端保持最小事件集。
   */
  const forwardReasoning = options.forwardReasoning === true;
  let reasoningSlot = null;

  /** 关闭打开中的 reasoning 项（幂等）。必须在文本/工具块之前调用。 */
  const closeReasoning = () => {
    if (!reasoningSlot) return;
    send('response.reasoning_summary_text.done', {
      item_id: reasoningSlot.id, output_index: reasoningSlot.outputIndex, summary_index: 0, text: reasoningSlot.text,
    });
    send('response.reasoning_summary_part.done', {
      item_id: reasoningSlot.id,
      output_index: reasoningSlot.outputIndex,
      summary_index: 0,
      part: { type: 'summary_text', text: reasoningSlot.text },
    });
    const item = {
      id: reasoningSlot.id,
      type: 'reasoning',
      status: 'completed',
      summary: [{ type: 'summary_text', text: reasoningSlot.text }],
    };
    send('response.output_item.done', { output_index: reasoningSlot.outputIndex, item });
    output[reasoningSlot.outputIndex] = item;
    reasoningSlot = null;
  };

  /** 打开 reasoning 项（幂等）。`summary` 先给空数组，真实 API 也是这么发的。 */
  const openReasoning = () => {
    if (reasoningSlot) return reasoningSlot;
    outputIndex += 1;
    reasoningSlot = { id: responsesId('rs'), outputIndex, text: '' };
    send('response.output_item.added', {
      output_index: reasoningSlot.outputIndex,
      item: { id: reasoningSlot.id, type: 'reasoning', status: 'in_progress', summary: [] },
    });
    send('response.reasoning_summary_part.added', {
      item_id: reasoningSlot.id,
      output_index: reasoningSlot.outputIndex,
      summary_index: 0,
      part: { type: 'summary_text', text: '' },
    });
    return reasoningSlot;
  };

  /** 关闭打开中的文本项（幂等）。 */
  const closeText = () => {
    if (!textSlot) return;
    send('response.output_text.done', {
      item_id: textSlot.id, output_index: textSlot.outputIndex, content_index: 0, text: textSlot.text,
    });
    send('response.content_part.done', {
      item_id: textSlot.id,
      output_index: textSlot.outputIndex,
      content_index: 0,
      part: { type: 'output_text', text: textSlot.text, annotations: [] },
    });
    const item = {
      id: textSlot.id,
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: textSlot.text, annotations: [] }],
    };
    send('response.output_item.done', { output_index: textSlot.outputIndex, item });
    output[textSlot.outputIndex] = item;
    textSlot = null;
  };

  /**
   * 补发工具块的 `output_item.added`（幂等）。
   *
   * 为什么要拖后发：`function.name` 与 Anthropic 那条流一样**可能分片到达**，
   * 而 `added` 一旦发出，里面的 name 就定死了 —— 先发会把半截名字（`get_`）
   * 交给客户端。等第一个 arguments 分片来了再发（chat 协议里名字总在参数之前
   * 到齐），没有参数的在收尾时补发。
   *
   * 注意 `added` 里 arguments 给空串（真实 API 就是这么发的），
   * 完整参数靠 `output_item.done` —— Codex 只认后者。
   *
   * **项类型按请求侧的声明定**：`custom`（freeform）工具回 `custom_tool_call`
   * + `input`，否则 Codex 的工具路由器判 `incompatible payload`（2026-10-13
   * 用真实 codex.exe 对照实验确认过：`custom_tool_call` 它照常执行）。
   */
  const flushTool = (slot) => {
    if (!slot || slot.started) return;
    slot.started = true;
    pendingTool = null;
    /*
     * `tool_search` 不发 `output_item.added`：它的 item 形状里 `arguments` 是
     * **对象**（见 closeTool），参数分片过程中拼不出合法形状。它也没有 delta
     * 事件，而「任何 `*.delta` 前必须先发 added」那条硬约束只约束
     * `function_call_arguments.*` / `custom_tool_call_input.*`，所以直接等收尾
     * 一次性给 `output_item.done` 是安全的。
     *
     * ⚠️ 但**必须与 `closeTool` 的判据完全一致**：`closeTool` 只在
     * `routes?.toolSearch` 为真时才发 `tool_search_call`，否则会落到普通
     * `function_call` 分支 —— 那条分支**会**发 `function_call_arguments.done`
     * 与 `output_item.done`。此时若这里仍然 `return`（跳过 added），客户端收到的
     * 就是一个**从未 announced 过的 item** 在收参数，正好违反桥自己文档化的
     * 「added 必须先于第一个 delta」硬约束（Codex 要求有 active item）。
     *
     * 触发条件：模型这一轮调了 `tool_search`，而当前请求**没有**声明它
     * （Codex 在轮次之间丢掉/改名该工具、或历史回放）。所以判据要与 closeTool 同款。
     */
    if (slot.name === TOOL_SEARCH_NAME && routes?.toolSearch) return;
    const isCustom = customTools.has(slot.name);
    /*
     * 分组工具（MCP）必须还原成 Codex 认的形状：`name` 用**短名**、命名空间放
     * 独立的 `namespace` 字段（实测 135/135 条 MCP 调用都是这个形状）。上游侧
     * 用的是拍平名 `mcp__node_repl__js`。
     */
    const { name: emitName, namespace } = splitWireName(routes, slot.name);
    send('response.output_item.added', {
      output_index: slot.outputIndex,
      item: isCustom
        ? {
          id: slot.id,
          type: 'custom_tool_call',
          status: 'in_progress',
          call_id: slot.callId,
          name: emitName,
          input: '',
        }
        : {
          id: slot.id,
          type: 'function_call',
          status: 'in_progress',
          call_id: slot.callId,
          name: emitName,
          ...(namespace ? { namespace } : {}),
          arguments: '',
        },
    });
  };

  const closeTool = (slot) => {
    flushTool(slot);
    /*
     * 延迟工具检索：Codex 只认 `tool_search_call`
     * （`{type, arguments, execution:"client", call_id, status}`，且 `arguments`
     * 是**对象**而不是 JSON 字符串）。回 `function_call` 会被它的工具路由器拒掉，
     * 检索这一步就永远发生不了，MCP 工具也就永远发现不了 —— 而 `mcp__node_repl.js`
     * （Codex 自带 computer-use 的唯一入口）正是只能靠检索拿到。
     */
    if (slot.name === TOOL_SEARCH_NAME && routes?.toolSearch) {
      const item = {
        id: slot.id,
        type: 'tool_search_call',
        status: 'completed',
        execution: 'client',
        call_id: slot.callId,
        arguments: parseToolSearchArgs(slot.arguments),
      };
      send('response.output_item.done', { output_index: slot.outputIndex, item });
      output[slot.outputIndex] = item;
      return;
    }
    if (customTools.has(slot.name)) {
      /*
       * freeform：上游给的是 JSON 参数，客户端要裸正文。`input` 在 added 里
       * 是空串（真实 API 同款），正文靠 delta/done 送到 —— 一次给全即可，
       * 反正参数在桥这边已经攒完整了。
       */
      const input = customToolInput(slot.arguments);
      send('response.custom_tool_call_input.delta', {
        item_id: slot.id, output_index: slot.outputIndex, delta: input,
      });
      send('response.custom_tool_call_input.done', {
        item_id: slot.id, output_index: slot.outputIndex, input,
      });
      const item = {
        id: slot.id,
        type: 'custom_tool_call',
        status: 'completed',
        call_id: slot.callId,
        name: splitWireName(routes, slot.name).name,
        input,
      };
      send('response.output_item.done', { output_index: slot.outputIndex, item });
      output[slot.outputIndex] = item;
      return;
    }
    const { name: emitName, namespace } = splitWireName(routes, slot.name);
    send('response.function_call_arguments.done', {
      item_id: slot.id, output_index: slot.outputIndex, arguments: slot.arguments,
    });
    const item = {
      id: slot.id,
      type: 'function_call',
      status: 'completed',
      call_id: slot.callId,
      name: emitName,
      ...(namespace ? { namespace } : {}),
      arguments: slot.arguments,
    };
    send('response.output_item.done', { output_index: slot.outputIndex, item });
    output[slot.outputIndex] = item;
  };

  let finishReason = null;
  let usage = null;
  let streamError = null;
  let sawReasoning = false;
  /** 是否见过 `[DONE]`：与 finish_reason 一起作为"这一轮真的跑完了"的信号。 */
  let sawDone = false;
  const reader = up.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      if (backpressured) { await waitDrain(res); backpressured = false; }
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const raw = line.slice(5).trim();
        if (!raw) continue;
        if (raw === '[DONE]') { sawDone = true; continue; }
        let j; try { j = JSON.parse(raw); } catch { continue; }
        if (j.usage) usage = j.usage;
        const choice = (j.choices || [])[0];
        if (!choice) continue;
        if (choice.finish_reason) finishReason = choice.finish_reason;
        const d = choice.delta || {};

        // 上游给的思维链：默认**刻意不往 Codex 发**（见上面 forwardReasoning 的说明），
        // 开了开关才按 reasoning 项转发。无论发不发都要记下"上游给了"，日志里要说。
        if (typeof d.reasoning_content === 'string' && d.reasoning_content) {
          sawReasoning = true;
          if (forwardReasoning) {
            const rs = openReasoning();
            rs.text += d.reasoning_content;
            send('response.reasoning_summary_text.delta', {
              item_id: rs.id, output_index: rs.outputIndex, summary_index: 0, delta: d.reasoning_content,
            });
          }
        }

        if (typeof d.content === 'string' && d.content) {
          if (!textSlot) {
            // 工具块先关掉，output_index 才能安全前进；reasoning 项也必须先关
            for (const s of toolSlots.values()) if (!s.closed) { s.closed = true; closeTool(s); }
            closeReasoning();
            outputIndex += 1;
            textSlot = { id: responsesId('msg'), outputIndex, text: '' };
            send('response.output_item.added', {
              output_index: outputIndex,
              item: { id: textSlot.id, type: 'message', status: 'in_progress', role: 'assistant', content: [] },
            });
            send('response.content_part.added', {
              item_id: textSlot.id,
              output_index: outputIndex,
              content_index: 0,
              part: { type: 'output_text', text: '', annotations: [] },
            });
          }
          textSlot.text += d.content;
          send('response.output_text.delta', {
            item_id: textSlot.id, output_index: textSlot.outputIndex, content_index: 0, delta: d.content,
          });
        }

        for (const tc of d.tool_calls || []) {
          if (!tc) continue;
          const upIdx = typeof tc.index === 'number' ? tc.index : 0;
          let slot = toolSlots.get(upIdx);
          if (!slot) {
            closeText(); // 文本块必须先关，索引才能前进
            closeReasoning();
            outputIndex += 1;
            slot = {
              id: responsesId('fc'),
              outputIndex,
              callId: tc.id || `call_${trace().slice(0, 20)}`,
              name: '',
              arguments: '',
              started: false,
              closed: false,
            };
            toolSlots.set(upIdx, slot);
            pendingTool = slot; // 先不发 added，等名字收齐
          }
          /*
           * ⚠️ **已收尾的块绝不能再接受 delta。**
           *
           * 文本块一开就会把当时所有工具块强制收尾（上面 `closeText()` 前那段
           * `s.closed = true; closeTool(s)`）—— 而 `closeTool` 会发出
           * `output_item.done` 并把 item 钉进 `output[slot.outputIndex]`。
           * 如果之后还有同一个 `index` 的 tool_calls 分片（上游在文本之后
           * 继续补参数、或把该 index 复用给下一个调用），原先这里**没有守卫**：
           *
           *   - 参数继续累加进那个**已经完成**的 slot，而发出去的 item 是收尾
           *     那一刻的快照 → 客户端拿到**被截断的 arguments**（实测
           *     `{"cmd":` 这种非法 JSON，工具直接执行失败）；
           *   - 该 index 若是被复用成**新的一次调用**，新调用的 name/arguments
           *     全部挂到旧 item 上，**永远不会成为 output item** —— 模型的工具
           *     调用凭空消失，而 `response.completed` 里少一次调用。
           *
           * Anthropic 那层刚修过同一类问题（那边允许多块同时打开，做法是让工具块
           * 各自独立）；**但 Responses 这条不能照搬**：Codex 按**顺序递增且互不
           * 重叠**的 `output_index` 解析 item（见上面 `closeText()` 那句
           * "工具块先关掉，output_index 才能安全前进"），所以这里保持"文本一开
           * 就收尾工具块"的行为，只补上守卫：宁可**显式丢弃**迟到的分片，
           * 也绝不让它污染一个已经交给客户端的 item。
           */
          if (slot.closed) continue;
          // 名字**累加**（与 Anthropic 层同款修复：首片写入 + `!slot.name` 守卫
          // 会让后续分片全被丢掉）
          if (tc.function?.name) slot.name += tc.function.name;
          if (typeof tc.function?.arguments === 'string' && tc.function.arguments) {
            flushTool(slot);
            slot.arguments += tc.function.arguments;
            /*
             * custom（freeform）工具的参数是 JSON 外壳（`{"input":…}`），
             * 逐片转发出去只会让客户端看到乱码般的 JSON 片段 —— 它要的是
             * 裸正文，而正文要等参数攒完才拆得出来。所以这类块**不发** delta，
             * 收尾时一次性给 `custom_tool_call_input.done` + `output_item.done`。
             * `tool_search` 同理：它的 `arguments` 在 Codex 侧必须是**对象**，
             * 分片拼不出合法形状，也只在收尾给一次 `output_item.done`。
             */
            if (!customTools.has(slot.name) && slot.name !== TOOL_SEARCH_NAME) {
              send('response.function_call_arguments.delta', {
                item_id: slot.id, output_index: slot.outputIndex, delta: tc.function.arguments,
              });
            }
          }
        }
      }
    }
  } catch (e) {
    streamError = e;
    log('responses stream interrupted', e.message);
  }

  // 收尾：先补发漏掉的工具块，再关文本块，顺序不能反；reasoning 项最先关
  if (pendingTool && !pendingTool.started) flushTool(pendingTool);
  closeReasoning();
  closeText();
  for (const s of toolSlots.values()) if (!s.closed) { s.closed = true; closeTool(s); }

  if (sawReasoning && !forwardReasoning) {
    log('responses: upstream sent reasoning_content; it is not forwarded '
      + '(set WORKBUDDY_FORWARD_REASONING=1 to try forwarding it as a reasoning item; '
      + 'see docs/TROUBLESHOOTING.md)');
  }

  const finalOutput = output.filter(Boolean);
  const truncated = finishReason === 'length';
  /*
   * 干净半关同样要按失败处理：旧实现只在 `catch` 里设 `streamError`，
   * 上游"正常收尾但没有 finish_reason / [DONE]"时会发 `response.completed`。
   */
  if (!streamError && !sawDone && !finishReason && !res.writableEnded) {
    streamError = new Error('upstream stream ended before completion (no finish_reason / [DONE])');
    log('responses stream ended without a completion signal, reporting as failure');
  }
  /*
   * ⚠️ **上游在流中途断掉时，绝不能发 `response.completed`。**
   *
   * `streamError` 非空表示上游连接在流中间断了（被掐 / 网络故障 / 上游超时），
   * 此时回答**已经截断在半句话上**。原来这里无条件发 `completed` + `end_turn:true`
   * → Codex 认为"回合正常结束" → 用户看到的就是**说话说一半突然停下**，
   * 而且不报错、不重试（它以为成功了）。
   *
   * 这与 `docs/TROUBLESHOOTING.md` 里记的"跑一半就断"是**两种不同成因**：
   * 那种是模型自己决定结束回合（`model_needs_follow_up=false`），
   * 这种是**传输层断了却被我们报成成功** —— 后者是桥的错，必须修。
   *
   * 正确的收尾：发 `response.failed`（Codex 认这个事件，会转成可读错误并按
   * `error.code` 决定要不要重试），让客户端知道这一轮**没跑完**。
   * `end_turn` 不给（失败响应没有"回合结束"语义）。
   */
  if (streamError && !res.writableEnded) {
    send('response.failed', {
      response: {
        ...envelope('failed'),
        output: finalOutput,
        output_text: responsesTextOf(finalOutput),
        usage: responsesUsage(usage),
        error: {
          type: 'upstream_error',
          code: 'server_error',
          message: `workbuddy-bridge: upstream stream interrupted before completion: ${streamError.message}`,
        },
      },
    });
    res.end();
    return { finishReason, usage, streamError };
  }

  /*
   * ⚠️ `response.incomplete` 的 `reason` **只能是 `"interrupted"`**。
   *
   * Codex 的解析器（`codex-rs/codex-api/src/sse/responses.rs`：
   *   let interrupted = kind == "response.incomplete";
   *   if reason == "content_filter" { return Err(ContentFilter); }
   *   if reason != "interrupted" {
   *       return Err(ApiError::Stream("Incomplete response returned, reason: {reason}"));
   *   }
   * ）**会把任何别的 reason 当成流损坏并中断整轮**。
   *
   * 我们原来发的是 `"max_output_tokens"`（照 OpenAI 官方文档写的）—— 结果
   * 上游一旦因 max_tokens 截断，用户看到的不是「回答被截断」，而是整轮报错。
   * 实测（本机 glm-5.3 + max_output_tokens:16）确认了这条。
   *
   * 真实 OpenAI 在「被中断」时用的也是 `interrupted`；`max_output_tokens` 那种
   * 语义在这里**没有客户端认**，所以只能映射成 `interrupted`。
   * 另：官方 `responses.rs` 在 interrupted 分支里把 `end_turn` 强制成 `Some(false)`，
   * 我们两边都显式带上 `end_turn`（completed 为 `true`）。
   */
  send(truncated ? 'response.incomplete' : 'response.completed', {
    response: {
      ...envelope(truncated ? 'incomplete' : 'completed'),
      output: finalOutput,
      output_text: responsesTextOf(finalOutput),
      usage: responsesUsage(usage),
      end_turn: !truncated,
      ...(truncated ? { incomplete_details: { reason: 'interrupted' } } : {}),
    },
  });
  res.end();
  return { finishReason, usage, streamError };
}

// ── Usage accounting (local only) ────────────────────────────────────────
/**
 * 本地请求账本（`bridge/usage.jsonl`）。**只记元数据，从不记对话内容**：
 * 时间、模型、是否流式、耗时、token 数、扣分；失败时记状态码与错误码。
 *
 * 成功与失败写同一个文件，靠 `ok` 区分——旧记录没有该字段，一律按成功处理。
 * 把失败也记下来是必要的：否则「某个模型调不通」在控制台上完全不可见，
 * 只能去翻原始日志。
 *
 * 上限 MAX_USAGE_LINES 条，超出后截断保留最近一半，避免文件无限增长。
 */
const MAX_USAGE_LINES = 2000;
let usageLines = null;
/**
 * 上次与账本文件同步后的**指纹**（字节数 + mtimeMs），用来发现「文件被外部改动」。
 *
 * 为什么不能只用字节数比大小：镜像可能是空的（`usageBytes === 0`，例如外部刚把
 * 文件删掉、或进程还没记过任何账），这时 `size < usageBytes` 恒为 false ——
 * 于是外部随后写进来的**任何**文件都不会触发重载，镜像会永久性地读成空。
 * 实测这条在「删除文件 → 外部写入新账本」的序列里会真实发生（D4-E7）。
 * 带上 mtime 后，"外部换了个文件" 与 "我们自己刚追加过" 就能区分开。
 */
let usageBytes = 0;
let usageMtimeMs = -1;
/** 账本位置：运行期数据目录，可用 `WORKBUDDY_USAGE_FILE` 覆盖。 */
let usageMigrated = false;
function usageFile() {
  if (process.env.WORKBUDDY_USAGE_FILE) return process.env.WORKBUDDY_USAGE_FILE;
  const target = join(RUNTIME_DATA_DIR, 'usage.jsonl');
  if (!usageMigrated) {
    usageMigrated = true;
    // 旧版账本在 bridge/ 脚本目录；升级后第一次启动复制过去。只复制不删除。
    if (!existsSync(target)) {
      const legacy = join(dirname(fileURLToPath(import.meta.url)), 'usage.jsonl');
      if (existsSync(legacy) && legacy !== target) {
        try {
          mkdirSync(dirname(target), { recursive: true });
          copyFileSync(legacy, target);
          log('usage ledger migrated to runtime data dir');
        } catch { /* 迁移失败就起一份新账本；不阻塞请求 */ }
      }
    }
  }
  return target;
}

/** 读文件指纹；文件不存在时返回 { size: 0, mtimeMs: -1 }。 */
function usageStat(file) {
  try {
    const st = existsSync(file) ? statSync(file) : null;
    return st ? { size: st.size, mtimeMs: st.mtimeMs } : { size: 0, mtimeMs: -1 };
  } catch {
    return { size: 0, mtimeMs: -1 };
  }
}

function loadUsageLines(file) {
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  usageLines = text.split('\n').filter(Boolean);
  usageBytes = Buffer.byteLength(text);
  usageMtimeMs = usageStat(file).mtimeMs;
}

/**
 * 错误摘要：单行、截断。
 *
 * 上游的错误消息是协议层的（`code` + 一句说明），**不含用户输入**；这里再截一刀
 * 防止异常里夹带整段 HTML（APISIX 的 401 就是一大段 HTML）。
 */
function shortError(text, limit = 160) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > limit ? `${s.slice(0, limit)}…` : s;
}

/**
 * 确保内存镜像与文件一致，必要时重新加载。
 *
 * 抽成独立函数是因为它现在有**两个**调用方：`recordRequest`（写之前要确认
 * 镜像没被外部清空）和 `readUsageRows`（读之前同样要确认）。这段判断是语义
 * 核心，复制成两份迟早会分叉。
 *
 * **判据：文件指纹与上次同步时不一致就重载。** 指纹 = 字节数 + mtimeMs。
 *
 * 演进过程（两次都栽在"只比大小"上，记下来免得再犯）：
 *   - 最初只判 `size < usageBytes`。这能覆盖「清空账本」（0 字节）与「截断」，
 *     但**镜像为空时失效**：`usageBytes === 0` 意味着 `size < 0` 恒为 false，
 *     外部此后写的任何文件都不会被看到。实测 D4-E7 就是这样读成空账本的
 *     （外部删除文件 → 换入一个非空文件 → 桥永远读 0 条），而 HEAD 的全量
 *     重读没有这个问题。
 *   - 补 `mtimeMs < usageMtimeMs` 也没救：外部**新写**的文件 mtime 只会变大。
 *
 * 所以改成「指纹不等就重载」。这样「删除→重建」「换成另一个文件」「清空」
 * 全都能覆盖，代价只是我们自己每次 append 后要刷新一次指纹
 * （见 recordRequest 末尾），否则会把自己的写入误判成外部改动、白重载一次。
 *
 * `usageLines === null`（进程刚起，一次请求都还没记过）也走这里初始化：
 * 这正是 D4 之前缺失的路径 —— 冷启动后第一个 `/v1/usage` 请求读不到内存副本，
 * 只能回磁盘，改成镜像优先之后必须有地方把它建起来。
 */
function syncUsageMirror(file) {
  if (usageLines === null) {
    loadUsageLines(file);
    return;
  }
  const { size, mtimeMs } = usageStat(file);
  if (size !== usageBytes || mtimeMs !== usageMtimeMs) loadUsageLines(file);
}

/**
 * 失败归因：把上游状态码/错误码/文案收敛成有限类别。
 *
 * 这不是为了好看，而是为了决定“要不要重试”。11128/403/额度耗尽重试多少次
 * 都不会变，而 429/5xx/流中断值得退避重试；面板必须能一眼分开。
 */
function classifyFailure(entry) {
  const status = Number(entry?.status) || 0;
  const code = entry?.code;
  const text = `${code ?? ''} ${entry?.error ?? ''}`;
  if (entry?.channelRejected === true || Number(code) === 11128 || /11128|unapproved channel/i.test(text)) {
    return { failureKind: 'channel', retryable: false, failureAction: 'diagnose' };
  }
  if (status === 401) return { failureKind: 'auth', retryable: false, failureAction: 'relogin' };
  if (status === 403) return { failureKind: 'account', retryable: false, failureAction: 'check-account' };
  if (status === 429 || Number(code) === 14003 || Number(code) === 15001 || /rate.?limit|too many requests/i.test(text)) {
    return { failureKind: 'rate_limit', retryable: true, failureAction: 'backoff' };
  }
  if (Number(code) === 6004 || /insufficient[_ ]?quota|quota (exhausted|exceeded)|credit (balance|exhausted)/i.test(text)) {
    return { failureKind: 'quota', retryable: false, failureAction: 'wait-reset' };
  }
  if (Number(code) === 11148 || /11148|tool calls and tool results/i.test(text)) {
    return { failureKind: 'tool_history', retryable: false, failureAction: 'new-session' };
  }
  if (/stream ended|stream interrupted|no finish_reason|no parseable SSE|EMPTY_RESPONSE|no parseable SSE data/i.test(text)) {
    return { failureKind: 'stream', retryable: true, failureAction: 'retry' };
  }
  if (status >= 500) return { failureKind: 'upstream', retryable: true, failureAction: 'retry' };
  if (status >= 400) return { failureKind: 'request', retryable: false, failureAction: 'fix-request' };
  if (status === 0) return { failureKind: 'stream', retryable: true, failureAction: 'retry' };
  return { failureKind: 'unknown', retryable: false, failureAction: 'diagnose' };
}

function recordRequest(entry) {
  try {
    // 调用方归因（B2 凭据分层）： ALS 里带着本次请求的 client id（local 或
    // key 哈希前 8 位）—— 桥不可用时静默跳过，不影响记账主流程。
    const client = requestScope.getStore()?.client;
    if (client) entry = { ...entry, client };
    // 工具历史修复计数：只记数字，便于面板回答“这次为什么被修过”。
    const toolRepair = requestScope.getStore()?.toolRepair;
    if (toolRepair) entry = { ...entry, toolRepair };
    const imageOmitted = requestScope.getStore()?.imageOmitted;
    if (imageOmitted) entry = { ...entry, imageOmitted };
    // 面板「体检」是主动探测，失败是预期结果之一；单独标记，避免计入待办。
    if (requestScope.getStore()?.probe === true) entry = { ...entry, probe: true };
    /*
     * 失败原文在**写入侧**就压平并截断。
     *
     * 上游的错误体常常是一整段 HTML（网关 401/502 页面），动辄几 KB 且带换行。
     * 账本是一行一条 JSON 的 jsonl：原文里的 `\n` 会被 JSON.stringify 转义成
     * `\\n` 尚可，但**整段 HTML 灌进去**会让单行膨胀到几 KB，控制台「最近请求」
     * 与 CSV 导出都会被撑爆，而且真正有用的信息（状态码 + 头几个字）被淹没。
     *
     * 放在这里而不是每个调用点：调用点有十来处，漏一处就是一个新的漏口。
     * 读取侧（recentRequests / summary）的 shortError 保留 —— 那是给**历史
     * 账本**兜底的，老文件里已经存着未截断的原文。
     */
    if (typeof entry.error === 'string') entry = { ...entry, error: shortError(entry.error) };
    if (entry.ok === false && !entry.failureKind) {
      entry = { ...entry, ...classifyFailure(entry) };
    }
    const file = usageFile();
    syncUsageMirror(file);

    const line = JSON.stringify({ t: Date.now(), ...entry });
    usageLines.push(line);
    if (usageLines.length > MAX_USAGE_LINES) {
      usageLines = usageLines.slice(-Math.floor(MAX_USAGE_LINES / 2));
      const text = `${usageLines.join('\n')}\n`;
      /*
       * **原子替换**：先写临时文件再 rename，不直接覆盖账本。
       *
       * 截断是「重写整份文件」，用 `writeFileSync(file, ...)` 的话，进程正好
       * 在这时被杀 / 断电就会留下半份文件 —— 丢的是**用户自己的用量历史**，
       * 而项目里没有第二份副本。同目录内 rename 是原子的（Windows 上也是），
       * 崩在任何一步都不会破坏原文件。
       *
       * 这也是项目自己的标准：`lib/dsh.mjs` 写 dsh 配置是先备份再写。
       * 账本这份数据比配置更没有第二份副本，不该比它更随意。
       */
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, text);
      renameSync(tmp, file);
      usageBytes = Buffer.byteLength(text);
    } else {
      appendFileSync(file, `${line}\n`);
      usageBytes += Buffer.byteLength(`${line}\n`);
    }
    // 我们自己刚写过，指纹要跟上：否则下一次 syncUsageMirror 会把自己的写入
    // 当成「外部改动」而白重载一次（虽然结果正确，纯属浪费一次全文件解析）。
    usageMtimeMs = usageStat(file).mtimeMs;
  } catch (e) {
    log('usage record failed', e.message); // 记账失败绝不影响请求
  }
}

/** 清空账本：文件与进程内副本一起重置（DELETE /v1/usage）。 */
function resetUsageLedger() {
  const file = usageFile();
  writeFileSync(file, '');
  usageLines = [];
  usageBytes = 0;
  usageMtimeMs = usageStat(file).mtimeMs;
}

// ── 配额快照（账实核对用）────────────────────────────────────────────────
/**
 * 余额积分只在 `/v1/quota` 成功时取得到；把它按小时留一份快照，页面才能
 * 回答“本地账本合计”和“账号余额变化”对不对得上。只存数字与套餐名，
 * 不存任何对话内容；默认最多每小时一条，避免把轮询写成大文件。
 */
const QUOTA_SNAPSHOT_INTERVAL_MS = numEnv('WORKBUDDY_QUOTA_SNAPSHOT_MS', 3600000, { min: 0 });
const QUOTA_HISTORY_MAX_LINES = 4000;
let lastQuotaSnapshot = { at: 0, account: '' };
function quotaHistoryFile() {
  return process.env.WORKBUDDY_QUOTA_HISTORY_FILE
    || join(RUNTIME_DATA_DIR, 'quota-history.jsonl');
}
function recordQuotaSnapshot(quota, auth) {
  if (!quota || typeof quota.total !== 'number') return;
  const account = auth?.userId || auth?.uid || '';
  const now = Date.now();
  if (lastQuotaSnapshot.account === account && now - lastQuotaSnapshot.at < QUOTA_SNAPSHOT_INTERVAL_MS) return;
  lastQuotaSnapshot = { at: now, account };
  const file = quotaHistoryFile();
  const line = JSON.stringify({
    t: now,
    account,
    total: quota.total,
    packages: (quota.packages || []).map((p) => ({
      name: p.name, remain: p.remain, size: p.size, monthly: p.monthly, expiresAt: p.expiresAt || '',
    })),
  });
  try {
    mkdirSync(dirname(file), { recursive: true });
    const before = existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
    if (before.length >= QUOTA_HISTORY_MAX_LINES) {
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, `${before.slice(-Math.floor(QUOTA_HISTORY_MAX_LINES / 2)).join('\n')}\n${line}\n`);
      renameSync(tmp, file);
    } else {
      appendFileSync(file, `${line}\n`);
    }
    log('quota snapshot', quota.total);
  } catch (e) {
    log('quota snapshot failed', e.message); // 快照失败绝不影响余额查询
  }
}
function readQuotaHistory(days = 7) {
  const since = Date.now() - Math.max(1, Math.min(Number(days) || 7, 90)) * 86400000;
  try {
    const file = quotaHistoryFile();
    if (!existsSync(file)) return [];
    return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter((row) => row && typeof row.t === 'number' && row.t >= since);
  } catch {
    return [];
  }
}

/**
 * 读账本原始行（解析失败的行直接跳过）。
 *
 * 优先用内存镜像（`usageLines`），不再每次 `readFileSync` 全文件 + 逐行
 * `JSON.parse`：这个函数被 `/v1/usage` 与 `/v1/requests` 调用，而控制台每 20 秒
 * 轮询一次、插件面板也按 interval 拉 —— 每次重读磁盘并解析 2000 行 JSON，
 * 纯属把事件循环堵上一段，而进程里本来就有一份同步的副本。
 *
 * 镜像里的行是**写入时的原样字符串**（`recordRequest` 只 push 不重排），所以
 * 解析结果与直接读文件**逐字节等价**；输出结构因此完全不变。
 *
 * 保留的唯一磁盘访问是 `syncUsageMirror` 里的 `statSync` —— 它撑住「外部清空
 * 账本」的语义，删掉就会让已清掉的历史被下一次整块重写带回来。
 */
function readUsageRows() {
  try {
    syncUsageMirror(usageFile());
    return usageLines
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter((r) => r && typeof r.t === 'number');
  } catch {
    return [];
  }
}

/**
 * 最近请求明细（新的在前）。
 *
 * 只回元数据白名单字段——**不回请求体、不回消息内容**，即使账本里将来多写了字段
 * 也不会泄漏出去。
 */
function recentRequests(limit = 50) {
  /*
   * 只解析尾部：`readUsageRows()` 会把整本账（可能上万行）全部 JSON.parse，
   * 而聊天页每 15 秒、请求页每 5 秒都只要最新 N 条。从尾部往前凑够 limit
   * 就停；解析失败的行和坏行跳过，语义与 readUsageRows 的过滤一致。
   */
  let rows = [];
  try {
    syncUsageMirror(usageFile());
    rows = [];
    for (let i = usageLines.length - 1; i >= 0 && rows.length < limit; i -= 1) {
      try {
        const r = JSON.parse(usageLines[i]);
        if (r && typeof r.t === 'number') rows.push(r);
      } catch { /* 坏行跳过 */ }
    }
  } catch {
    rows = [];
  }
  return rows.map((r) => ({
    t: r.t,
    model: r.model || '',
    ...(r.kind === 'search' || r.kind === 'video' || r.kind === 'image' ? { kind: r.kind } : {}),
    ...(r.probe === true ? { probe: true } : {}),
    stream: r.stream === true,
    ms: Number(r.ms) || 0,
    ok: r.ok !== false,
    ...(r.ok === false
      ? { status: Number(r.status) || 0, code: r.code ?? null, error: shortError(r.error) }
      : {}),
    ...(typeof r.promptTokens === 'number' ? { promptTokens: r.promptTokens } : {}),
    ...(typeof r.completionTokens === 'number' ? { completionTokens: r.completionTokens } : {}),
    // 缓存命中量：上游不一定回报，缺字段就不写 0（0 是“确实未命中”）。
    ...(typeof r.cachedTokens === 'number' ? { cachedTokens: r.cachedTokens } : {}),
    ...(typeof r.cacheMissTokens === 'number' ? { cacheMissTokens: r.cacheMissTokens } : {}),
    ...(r.toolRepair && typeof r.toolRepair === 'object' ? { toolRepair: r.toolRepair } : {}),
    ...(typeof r.imageOmitted === 'number' ? { imageOmitted: r.imageOmitted } : {}),
    ...(typeof r.channelRejected === 'boolean' ? { channelRejected: r.channelRejected } : {}),
    ...(typeof r.channelAttempts === 'number' ? { channelAttempts: r.channelAttempts } : {}),
    ...(typeof r.failureKind === 'string' ? { failureKind: r.failureKind } : {}),
    ...(typeof r.retryable === 'boolean' ? { retryable: r.retryable } : {}),
    ...(typeof r.failureAction === 'string' ? { failureAction: r.failureAction } : {}),
    ...(typeof r.credit === 'number' ? { credit: r.credit } : {}),
    // 生成类（视频/图片）的**估算**消耗：提交前后账号余额差。上游不回报单次积分，
    // 这个值可能为 null（余额没变化/读不到），调用方必须当“参考值”而非账单。
    ...(typeof r.creditEstimate === 'number' ? { creditEstimate: r.creditEstimate } : {}),
    // 诊断用的两个时延拆分：桥前置处理 vs 上游首个字节（不含内容解析耗时）。
    // 面板/控制台用它回答"慢在桥还是慢在上游"，账本里可能没有（旧记录 / 非流式）。
    ...(typeof r.overheadMs === 'number' ? { overheadMs: r.overheadMs } : {}),
    ...(typeof r.ttfbMs === 'number' ? { ttfbMs: r.ttfbMs } : {}),
    ...(typeof r.fallback === 'string' ? { fallback: r.fallback } : {}),
    ...(typeof r.fallbackOk === 'boolean' ? { fallbackOk: r.fallbackOk } : {}),
  }));
}

/**
 * 本地日期 `YYYY-MM-DD`。
 *
 * 必须与页面其它地方（「最近请求」用 getHours() 显示本地时间）同一时区口径。
 * `toISOString().slice(0,10)` 取的是 **UTC 日期**，UTC+8 下凌晨 00:00–07:59 的
 * 调用会被记进前一天，趋势图看起来「少了一天、多了一天」。
 */
function localDay(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 本地时区的小时键 `YYYY-MM-DD HH`。与 localDay() 同一套补零规则，**不用 UTC**——
 *  否则页面上的「今天 13 时」会和用户墙上时钟错位。 */
function localHour(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}`;
}

/** 汇总用量：总数、按模型、按天（本地日期）、按小时（可选），外加失败统计（失败不计入 token / 扣分）。 */
function summarizeUsage(days = 7, opts = {}) {
  // 小时桶只在显式要求时才算：7/30 天视图用不到，白算 24 个桶没意义。
  const wantHours = opts.hours === true;

  // 小时视图把窗口**对齐到整点**（从当前整点往前推 23 小时，共 24 个整点桶）。
  // 若沿用 `now - 24h` 的滚动窗口，最旧那个桶只会统计到半截，图上合计就和
  // 面板的 total 对不上了——「图上的每个数字都能在面板里对上」是硬要求。
  // 不用小时桶时（wantHours=false）走原来的滚动窗口，既有语义完全不变。
  const hourAnchor = (() => { const a = new Date(); a.setMinutes(0, 0, 0); return a.getTime(); })();
  const since = wantHours ? hourAnchor - 23 * 3600000 : Date.now() - days * 86400000;

  const rows = readUsageRows();

  const byModel = new Map();
  const byDay = new Map();
  const byHour = wantHours ? new Map() : null;
  const failures = [];
  const failureByModel = new Map();
  // creditCalls 单独计数：上游**并非每次**都回报 credit。不区分「回报了 0」和
  // 「没回报」的话，两者在页面上只能显示成同一个「—」，看起来像统计坏了。
  // 另外上游是**两位小数**量化，几十 token 的小请求真实扣分就是 0.00——
  // 那是「这次没扣到」，不是「没数据」。
  // searches / searchFailed 与模型调用分开：搜索不消耗模型 tokens/积分，
  // 混进 calls 会让「调用次数」和平均耗时对不上模型账。
  // videos / videoFailed 同理：视频提交按次计费，但不回报 token；单独一列，
  // 才能和模型调用、网页搜索放在同一张账本里而不互相污染。
  // images / imageFailed 与视频同构：图片提交也不回报 token/积分。
  let total = {
    calls: 0, promptTokens: 0, completionTokens: 0, ms: 0,
    credit: 0, creditCalls: 0, failed: 0, searches: 0, searchFailed: 0,
    videos: 0, videoFailed: 0, images: 0, imageFailed: 0,
    failureKinds: {},
    // 生成类的估算积分（提交前后余额差）。Known 表示有多少次采到了差值；
    // 0 次时界面要显示「—」而不是 0，避免把“没测到”说成“没花钱”。
    videoCredit: 0, videoCreditKnown: 0, imageCredit: 0, imageCreditKnown: 0,
    // 提示缓存：上游回报了才计数。cacheKnownCalls 区分「没命中」与「没回报」。
    cachedTokens: 0, cacheMissTokens: 0, cacheKnownCalls: 0, cacheHitRate: null,
  };

  const ensureDay = (ts) => {
    const day = localDay(ts);
    let bucket = byDay.get(day);
    if (!bucket) {
      bucket = {
        day, calls: 0, promptTokens: 0, completionTokens: 0, credit: 0, creditCalls: 0,
        searches: 0, searchFailed: 0, videos: 0, videoFailed: 0,
        images: 0, imageFailed: 0, failed: 0, byModel: new Map(),
      };
      byDay.set(day, bucket);
    }
    return bucket;
  };
  const ensureHour = (ts) => {
    if (!byHour) return null;
    const key = localHour(ts);
    let bucket = byHour.get(key);
    if (!bucket) {
      bucket = {
        key, calls: 0, promptTokens: 0, completionTokens: 0, credit: 0, creditCalls: 0,
        searches: 0, searchFailed: 0, videos: 0, videoFailed: 0,
        images: 0, imageFailed: 0, failed: 0, byModel: new Map(),
      };
      byHour.set(key, bucket);
    }
    return bucket;
  };
  // 老账本没有 kind；model=web-search 是 v1.9.4 起的稳定标记。
  const isSearchRow = (row) => row.kind === 'search' || row.model === 'web-search';
  const isVideoRow = (row) => row.kind === 'video';
  const isImageRow = (row) => row.kind === 'image';

  for (const r of rows) {
    if (r.t < since) continue;
    const isSearch = isSearchRow(r);
    const isVideo = isVideoRow(r);
    const isImage = isImageRow(r);
    // 体检失败是“探测结果”，不是用户请求事故：不进失败数/失败列表。
    if (r.probe === true && r.ok === false) continue;

    // 失败的请求单独归类：它没有 token、没有扣分，混进成功率会误导
    if (r.ok === false) {
      if (isVideo) total.videoFailed += 1;
      else if (isImage) total.imageFailed += 1;
      else if (isSearch) total.searchFailed += 1;
      else total.failed += 1;
      const failureKind = r.failureKind || 'unknown';
      total.failureKinds[failureKind] = (total.failureKinds[failureKind] || 0) + 1;
      failures.push({
        t: r.t,
        model: r.model || '',
        stream: r.stream === true,
        ms: Number(r.ms) || 0,
        status: Number(r.status) || 0,
        code: r.code ?? null,
        error: shortError(r.error),
        kind: isVideo ? 'video' : (isImage ? 'image' : (isSearch ? 'search' : 'call')),
        failureKind,
        retryable: r.retryable === true,
      });
      const failModel = r.model || '(unknown)';
      // `models` 保持“成功调用过的模型”这一既有契约（D4）；失败单独放
      // `failureByModel`，否则图片/视频/搜索的失败会把模型排行污染成
      // image / video / web-search（回归用例已钉住）。
      const fm = failureByModel.get(failModel) || { model: failModel, failed: 0, byKind: {} };
      fm.failed += 1;
      fm.byKind[failureKind] = (fm.byKind[failureKind] || 0) + 1;
      failureByModel.set(failModel, fm);
      const existingModel = byModel.get(failModel);
      if (existingModel) existingModel.failed = (existingModel.failed || 0) + 1;
      const failDay = ensureDay(r.t);
      failDay.failed = (failDay.failed || 0) + 1;
      const failHour = ensureHour(r.t);
      if (failHour) failHour.failed = (failHour.failed || 0) + 1;
      if (isVideo) {
        ensureDay(r.t).videoFailed += 1;
        const h = ensureHour(r.t);
        if (h) h.videoFailed += 1;
      } else if (isImage) {
        ensureDay(r.t).imageFailed += 1;
        const h = ensureHour(r.t);
        if (h) h.imageFailed += 1;
      } else if (isSearch) {
        ensureDay(r.t).searchFailed += 1;
        const h = ensureHour(r.t);
        if (h) h.searchFailed += 1;
      }
      continue;
    }

    if (isVideo) {
      total.videos += 1;
      if (typeof r.creditEstimate === 'number') {
        total.videoCredit += r.creditEstimate;
        total.videoCreditKnown += 1;
      }
      ensureDay(r.t).videos += 1;
      const h = ensureHour(r.t);
      if (h) h.videos += 1;
      continue;
    }

    if (isImage) {
      total.images += 1;
      if (typeof r.creditEstimate === 'number') {
        total.imageCredit += r.creditEstimate;
        total.imageCreditKnown += 1;
      }
      ensureDay(r.t).images += 1;
      const h = ensureHour(r.t);
      if (h) h.images += 1;
      continue;
    }

    if (isSearch) {
      total.searches += 1;
      ensureDay(r.t).searches += 1;
      const h = ensureHour(r.t);
      if (h) h.searches += 1;
      continue;
    }

    const pt = Number(r.promptTokens) || 0;
    const ct = Number(r.completionTokens) || 0;
    const hasCredit = typeof r.credit === 'number';
    const cr = hasCredit ? r.credit : 0;
    // 缓存字段缺失 ≠ 未命中：只有上游真的回报了才计入命中率。
    const hasCache = typeof r.cachedTokens === 'number' || typeof r.cacheMissTokens === 'number';
    const cached = Number(r.cachedTokens) || 0;
    const cacheMiss = Number(r.cacheMissTokens) || 0;
    const addCache = (bucket) => {
      if (!hasCache) return;
      bucket.cachedTokens = (bucket.cachedTokens || 0) + cached;
      bucket.cacheMissTokens = (bucket.cacheMissTokens || 0) + cacheMiss;
    };

    total.calls += 1;
    total.promptTokens += pt;
    total.completionTokens += ct;
    total.ms += Number(r.ms) || 0;
    if (hasCredit) { total.credit += cr; total.creditCalls += 1; }
    if (hasCache) total.cacheKnownCalls += 1;
    addCache(total);

    const m = byModel.get(r.model)
      || { model: r.model, calls: 0, promptTokens: 0, completionTokens: 0, ms: 0, credit: 0, creditCalls: 0 };
    m.calls += 1; m.promptTokens += pt; m.completionTokens += ct; m.ms += Number(r.ms) || 0;
    if (hasCredit) { m.credit += cr; m.creditCalls += 1; }
    addCache(m);
    byModel.set(r.model, m);

    const d = ensureDay(r.t);
    d.calls += 1; d.promptTokens += pt; d.completionTokens += ct;
    if (hasCredit) { d.credit += cr; d.creditCalls += 1; }
    addCache(d);
    /*
     * 当天 × 该模型的小计。
     *
     * 「哪些模型把积分花掉了」在时间轴上是**叠加**的，而上面两个聚合各自缺一半：
     * `models[]` 只有整窗口的合计、`days[]` 只有每天不分模型的合计。
     * 图表要按模型堆叠每天那根柱，就得有这个交叉维度。
     */
    const dm = d.byModel.get(r.model)
      || { model: r.model, calls: 0, promptTokens: 0, completionTokens: 0, credit: 0, creditCalls: 0 };
    dm.calls += 1; dm.promptTokens += pt; dm.completionTokens += ct;
    if (hasCredit) { dm.credit += cr; dm.creditCalls += 1; }
    addCache(dm);
    d.byModel.set(r.model, dm);

    const h = ensureHour(r.t);
    if (h) {
      h.calls += 1; h.promptTokens += pt; h.completionTokens += ct;
      if (hasCredit) { h.credit += cr; h.creditCalls += 1; }
      addCache(h);
      // 小时桶同样带按模型小计 —— 否则切到「最近 24 小时」这个功能就没了
      const hm = h.byModel.get(r.model)
        || { model: r.model, calls: 0, promptTokens: 0, completionTokens: 0, credit: 0, creditCalls: 0 };
      hm.calls += 1; hm.promptTokens += pt; hm.completionTokens += ct;
      if (hasCredit) { hm.credit += cr; hm.creditCalls += 1; }
      addCache(hm);
      h.byModel.set(r.model, hm);
    }
  }

  // 浮点累加会攒出 0.6900000000000001 这种噪声，出接口前收一下
  const round4 = (n) => Math.round(n * 10000) / 10000;
  total.credit = round4(total.credit);
  total.videoCredit = round4(total.videoCredit);
  total.imageCredit = round4(total.imageCredit);
  /*
   * 命中率 = cachedTokens / promptTokens。分母用 promptTokens 而不是
   * cached + miss：上游可能只回报其中一项，cacheMissTokens 也并非每个
   * 模型都给。没有 promptTokens 或上游一次都没回报缓存时保持 null，
   * 页面显示「—」，不能把“没数据”写成 0%。
   */
  if (total.cacheKnownCalls > 0 && total.promptTokens > 0) {
    total.cacheHitRate = round4(total.cachedTokens / total.promptTokens);
  }
  for (const m of byModel.values()) {
    m.credit = round4(m.credit);
    if (m.promptTokens > 0 && (m.cachedTokens || m.cacheMissTokens)) {
      m.cacheHitRate = round4((m.cachedTokens || 0) / m.promptTokens);
    }
  }
  for (const d of byDay.values()) {
    d.credit = round4(d.credit);
    for (const dm of d.byModel.values()) dm.credit = round4(dm.credit);
  }

  // 补齐 24 个桶：没调用的整点也要出现（记 0），否则柱状图会跳变——
  // 空的那小时直接消失，看上去像时间轴缺了一段。
  let hours = null;
  if (byHour) {
    for (const h of byHour.values()) {
      h.credit = round4(h.credit);
      for (const hm of h.byModel.values()) hm.credit = round4(hm.credit);
    }
    hours = [];
    for (let i = 23; i >= 0; i -= 1) {
      const key = localHour(hourAnchor - i * 3600000);
      // 补出来的空桶也要带 `byModel: []`，形状与真实桶一致 —— 前端不必分支判空
      const h = byHour.get(key) || {
        key, calls: 0, promptTokens: 0, completionTokens: 0, credit: 0, creditCalls: 0,
        searches: 0, searchFailed: 0, videos: 0, videoFailed: 0,
        images: 0, imageFailed: 0, byModel: new Map(),
      };
      hours.push({ ...h, byModel: [...h.byModel.values()].sort((a, b) => b.credit - a.credit) });
    }
  }

  return {
    windowDays: days,
    total,
    models: [...byModel.values()].sort((a, b) => b.calls - a.calls),
    /*
     * 每天一行，带**当天按模型的小计**（`byModel`，按扣分降序）——
     * 图表的「按模型堆叠」靠它。排序放在这里而不是前端：前端拿到的顺序就是
     * 图例顺序，两处各排一次迟早不一致。
     */
    days: [...byDay.values()]
      .sort((a, b) => a.day.localeCompare(b.day))
      .map((d) => ({ ...d, byModel: [...d.byModel.values()].sort((a, b) => b.credit - a.credit) })),
    // 只有 ?hours=1 才带这个字段（checklist R1.4-4：按需计算，不白算）
    ...(hours ? { hours } : {}),
    // 最近 20 条失败，新的在前；页面用它做「为什么调不通」的第一手线索
    failures: failures.slice(-20).reverse(),
    // 按模型的失败计数，与成功模型排行分开；byKind 便于直接看是通道还是限流
    failureByModel: [...failureByModel.values()].sort((a, b) => b.failed - a.failed),
  };
}

// ── Model list ───────────────────────────────────────────────────────────
/**
 * 判定「明显不能对话」的内部模型 —— 完全基于上游目录字段，不猜哪些能调通。
 *
 * 实测样本：`nes-gf` 没有上下文窗口（maxInputTokens 缺省）、最大输出仅 256、
 * 也没有倍率，选中它必然失败。规则只排除**同时**满足「未声明上下文」与
 * 「声明了输出上限但低于 1024」的条目；字段缺失无法判定的一律保留。
 */
function isNonChatModel(m) {
  const ctx = Number(m?.maxInputTokens) || 0;
  const out = Number(m?.maxOutputTokens) || 0;
  return ctx <= 0 && out > 0 && out < 1024;
}

/**
 * 模型目录端点。两个端点返回的**不是同一份目录**：
 *
 *   /v2/enterprises/personal/models  具体模型（带 credits 倍率、tags）
 *   /v3/config                       产品配置，其中 models 是**档位/内部型号**
 *                                    （default-model、enhance-1.0 这类）
 *
 * 单用任何一个都会漏。`/v3/config` 是**官方模型选择器的真源**（models + agents，
 * 带 supportedEfforts / contextWindow），所以放第一位、字段优先；`/v2/.../models`
 * 用来补 v3 没列出的型号。两个都请求、按 id 合并。
 */
const CATALOG_PATHS = ['/v3/config', '/v2/enterprises/personal/models'];

function catalogPathsFor() {
  return CATALOG_PATHS;
}

const CATALOG_TTL_MS = 5 * 60 * 1000;
// `upstreamModelCount` 初值必须是 0：冷启动时一个模型都没看过，此时任何请求都
// 该放行。它同时也是「模型预校验能不能启用」的唯一开关（见 preflightModelError）。
let catalogCache = { at: 0, models: [], shape: null, upstreamModelCount: 0, account: '', source: '' };
let catalogRefreshing = null;
/**
 * 目录代次：换号 / 换来源时 +1。
 *
 * 光清空缓存不够 —— 换号前已经在飞的目录请求还会把**旧账号**的结果写回来。
 * `fetchCatalog` 捕获发起时的代次，写缓存前必须再核对；不一致就直接丢弃。
 * 这也是 `refreshCatalog({force:true})` 存在的原因：旧请求无法取消，只能作废
 * 它的结果并立刻发起新一代请求。
 */
let catalogGeneration = 0;

/**
 * 换号 / 换凭据来源后，模型目录可能属于另一个账号或另一个区域：清空并后台重取。
 * 不能在旧目录上继续做预校验，否则会把新账号可用的模型误杀。
 */
function invalidateCatalogCache() {
  catalogGeneration += 1;
  catalogCache = { at: 0, models: [], shape: null, upstreamModelCount: 0, account: '', source: '' };
  refreshCatalog({ force: true }).catch(() => {});
}

/**
 * 触发一次目录刷新；同一时刻只允许一个在飞（并发调用复用同一个 Promise）。
 *
 * `force`：忽略在飞请求，按当前代次重新发起。只给 `invalidateCatalogCache`
 * 用 —— 普通调用必须复用在飞请求，否则每次轮询都会多打一轮上游。
 *
 * 返回 `{ ok, at }`：`ok` 表示这次确实把缓存更新了（失败、空目录、因换号
 * 作废都算 false）。手动刷新目录（`/v1/models?refresh=1`）要靠它判断
 * 「是不是白刷了一次」，以便如实告诉用户「刷新失败，仍显示旧缓存」。
 */
function refreshCatalog({ force = false } = {}) {
  if (catalogRefreshing && !force) return catalogRefreshing;
  const generation = catalogGeneration;
  const promise = fetchCatalog(generation)
    .then((r) => ({ ok: r.upstreamOk && !r.stale, at: catalogCache.at }))
    .catch((e) => {
      log('catalog fetch failed', e.message);
      return { ok: false, at: catalogCache.at };
    })
    .finally(() => {
      // 只清自己的标记：换号后旧请求晚到的 finally 不能把新一代的在飞标记抹掉
      if (catalogRefreshing === promise) catalogRefreshing = null;
    });
  catalogRefreshing = promise;
  return promise;
}

/**
 * 模型目录。
 *
 * 冷启动（还没有任何缓存）才同步抓一次；已有缓存一律**立刻返回**，过期只在
 * 后台刷新。控制台的健康探测超时是 4 秒，而抓目录要串行打两个上游端点——
 * 把这段延迟转嫁给调用方，会让「桥在跑」被误判成「桥没起」。
 */
async function upstreamCatalog() {
  /*
   * 目录属于账号：缓存里记着它是用哪个账号抓的。来源变化（plugin ↔ desktop、
   * 自动回退到另一条凭据）不一定走 setSourcePreference，不能只靠那里作废；
   * 这里按当前实际凭据再核一次，避免把上一个账号的模型/倍率发给客户端。
   */
  if (catalogCache.models.length && catalogCache.account) {
    try {
      const auth = await resolveAuth();
      const account = auth.userId || auth.uid || '';
      if (account && account !== catalogCache.account) {
        log('catalog account changed; refetching', `${catalogCache.account} -> ${account}`);
        invalidateCatalogCache();
        await refreshCatalog();
      }
    } catch { /* 凭据读不出来：沿用缓存，调用方会另行报鉴权错误 */ }
  }
  if (!catalogCache.models.length) await refreshCatalog();
  else if (Date.now() - catalogCache.at > CATALOG_TTL_MS) refreshCatalog();
  return catalogCache.models;
}

/**
 * 是否对请求里的 model 做目录预校验。`WORKBUDDY_SKIP_MODEL_PREFLIGHT=1` 关闭。
 *
 * 为什么必须留这个开关：上游目录**已知是不完整的** —— 上面 fetchCatalog 里
 * 「FEATURED 补全」那段注释记着同一件事（国际版能调 deepseek-v4.1-flash，
 * 目录端点里却没有它）。目录滞后于实际上线模型时，预校验会**误杀一个本来
 * 能用的模型**，这比「省一次上游往返」严重得多。所以：默认开（它能挡住的
 * 是绝大多数拼错 id 的调用），但必须给用户一个立刻能关掉它的出口。
 */
const MODEL_PREFLIGHT_ENABLED = process.env.WORKBUDDY_SKIP_MODEL_PREFLIGHT !== '1';

/**
 * 客户端送来的模型 id 长度上限。
 *
 * 为什么必须有：model 是**客户端可控**且会被**存进账本、写进日志、原样回显**
 * 的字段（400 响应体、/v1/requests、/v1/usage 的分组键）。实测：一个 30 万字符
 * 的 model 会让账本单行变成 30 万字符（文件 600KB/次）、让 400 响应体也是
 * 30 万字符、让 /v1/requests 回显 30 万字符 —— 反复打就能把磁盘/内存灌爆。
 * 真实模型 id 都很短（`deepseek-v4.1-flash` 19 字符），200 是极宽松的上限。
 */
const MAX_MODEL_ID_LEN = 200;

/**
 * 模型 id 会被当作 `X-Model-ID` 请求头发给上游，所以**必须只含 HTTP 头能承载的字符**。
 *
 * 这条约束与「模型在不在目录里」无关，因此**不能交给 `preflightModelError`** ——
 * 后者在目录没拿到时会直接放行（`upstreamModelCount === 0`）。而目录没拿到是常见状态：
 * 冷启动、上游目录接口抖动，以及用户按桥自己的提示设了
 * `WORKBUDDY_SKIP_MODEL_PREFLIGHT=1`。
 *
 * 不校验的后果（实测）：传 `模型-中文名` → Node 的 `http.request` 抛
 * `Invalid character in header content ["X-Model-ID"]` → 外层 catch 把它当未知故障，
 * 客户端收到 **500** 与一段内部报错。含 CR/LF 同理（Node 会拒绝，所以**不存在注入**，
 * 但用户拿到的仍是一个无法理解的 500）。
 *
 * 真实模型 id 都是可见 ASCII（见 `/v1/models`），所以这个约束挡不掉任何合法请求。
 */
const HEADER_SAFE_RE = /^[\x20-\x7e]*$/;

/**
 * chat 前的本地模型预校验。返回错误文本表示「该拒」，返回 null 表示「放行」。
 *
 * **启用条件只有一个：`catalogCache.upstreamModelCount > 0`** —— 即这一轮缓存里
 * 确实有模型是从上游目录端点拿到并留下的。
 *
 * 这里踩过一个真实的坑，记下来免得再犯：最初的判据是 `catalogCache.models.length
 * > 0`，看起来等价，其实完全不等价 —— `fetchCatalog` 末尾会用 FEATURED **无条件**
 * 补全，所以只要两个目录端点都**不返回 5xx**（404 / 字段改名 / 返回空数组 /
 * 模型全被 isNonChatModel 过滤掉…），缓存里也至少躺着 3 个精选模型。
 * 于是「桥对真实目录一无所知」被误判成「目录已知」，任何不在 FEATURED 里的
 * 真实可用模型都会被本地 400 拦下、一次上游都不打 —— 正是这条预校验本该
 * 避免的伤害。FEATURED 是**给客户端兜底的展示数据**，不是目录已知的证据。
 * 实测这条误杀在 404 / 空数组 / 字段改名 / 全被 supportsToolCall:false 挡掉
 * 四种常见故障下**全部可达**（只有 500 硬失败那条路径是对的）。
 *
 * 计数为 0（目录未知）时一律放行：我们不知道有哪些模型，就不该猜。
 *
 * 判定用 `catalogCache` 而不是 `upstreamCatalog()`：后者是 async 且可能触发一次
 * 抓取，放在请求路径上会把「校验」变成「多等几秒」。预校验的卖点就是省一次
 * 上游往返，不能自己先花掉一次。
 *
 * **FEATURED 仍然要在放行名单里**：`/v1/models` 在缓存为空时会退回 FEATURED
 * 定义（见那个端点的 `if (!catalog.length)` 分支），也就是桥刚刚才把这些 id
 * 告诉过客户端。若预校验只认缓存，就会出现「桥让你选 deepseek-v4.1-flash，
 * 转头又说这个模型不在目录里」的自相矛盾。所以放行判断是「在目录里 **或**
 * 在精选定义里」—— 桥对外承诺过的 id 一律不能自己否掉。
 * 注意这两件事是分开的：FEATURED 参与**放行**，但不参与**激活**预校验。
 */
function preflightModelError(model) {
  if (!MODEL_PREFLIGHT_ENABLED) return null;
  // 只在「真的从上游拿到过模型」时才敢拒。404 / 空数组 / 字段改名 / 全被过滤
  // 以及 5xx 硬失败，全都落在这个 0 上。
  if (!catalogCache.upstreamModelCount) return null;
  const catalog = catalogCache.models;
  if (!catalog.length) return null; // 理论上计数 > 0 时不会为空，兜一手
  if (typeof model !== 'string' || !model) return null; // 交给后面的默认值逻辑
  if (catalog.some((m) => m.id === model)) return null;
  if (FEATURED.some((f) => f.id === model)) return null;

  // 提示要**可操作**：光说「模型不存在」，用户下一步只能去猜。这里给出三个
  // 真实出口 —— 看完整目录（默认只回精选，具体模型在 ?all=1 里）、刷新目录
  // （缓存可能过期）、关掉预校验（目录可能漏了这个模型）。
  return `workbuddy-bridge: model "${model}" is not in the current catalog`
    + ` (${catalog.length} models). Check GET /v1/models?all=1 for the full list`
    + ' or GET /v1/models?refresh=1 if the catalog may be stale;'
    + ' set WORKBUDDY_SKIP_MODEL_PREFLIGHT=1 to forward unknown model ids anyway.';
}

async function fetchCatalog(generation = catalogGeneration) {
  // 是否**真的**从上游取到了目录。下面 FEATURED 补全会让 merged 永远非空，
  // 所以不能靠「目录非空」判断这次抓取成没成功。
  let upstreamOk = false;
  // 上游目录里**真正进了缓存的**模型条数（即通过了下面那套过滤、且不是
  // FEATURED 补出来的）。这才是「桥认识哪些模型」的唯一硬证据：
  // upstreamOk 只说明「端点回了 models 数组」，一个空数组也算 true，
  // 而全被过滤掉的情况（非对话模型 / supportsToolCall:false）同样算 true。
  // 模型预校验只有在这个计数 > 0 时才敢启用（见 preflightModelError）。
  let upstreamModelCount = 0;
  // 是否遇到**硬失败**（上游 5xx / 网络异常 / 解析异常）。硬失败时绝不用半份
  // 目录顶掉完整缓存——否则用户的模型列表会凭空少几个，还看不出原因。
  let hardError = false;
  try {
    let auth = await resolveAuth();
    const shape = { paths: catalogPathsFor(), sources: {}, model: [] };
    const merged = new Map();
    /**
     * modelId → 促销规则数组。一个模型可以有多条规则（例如 glm-5.2 的
     * 夜间五折 + 白天原价两段），所以不能像旧实现那样只留最后一条。
     */
    const promotions = new Map();
    // `/v3/config` 是官方模型选择器的真源；单独留下 models/agents 用来标 official。
    let productModels = [];
    let productAgents = [];

    for (const path of catalogPathsFor()) {
      try {
        const doFetch = () => fetch(`${auth.endpoint}${path}`, {
          // 用外层 auth：刷新/同账号接管后会更新它；旧 auth 会继续 401。
          headers: buildCatalogHeaders(auth),
          signal: AbortSignal.timeout(8000),
        });
        let res = await doFetch();
        /*
         * 401/403 不是「这个区域没有这个端点」，而是**令牌过期**（或会话失效）。
         * 但**另一个目录端点已经成功**时不能因为这份 401 去刷新/换号：
         * `/v2/enterprises/personal/models` 对部分 workbuddy.cn 账号就会单独
         * 401，而权威的 `/v3/config` 正常返回 —— 旧逻辑会因此每 8 秒刷新一次、
         * 再接管到插件凭据，目录永远建不起来。
         */
        if ((res.status === 401 || res.status === 403) && merged.size === 0) {
          const refreshed = await refreshAuth(auth).catch(() => null);
          if (refreshed) {
            auth = refreshed;
            log('catalog auth expired, retried after token refresh');
            res = await doFetch();
          }
          // 同账号的另一条凭据可以接管；不同账号默认不接管（见 resolveCredentialAlternative）。
          if (res.status === 401 || res.status === 403) {
            const alt = await resolveCredentialAlternative(auth).catch(() => null);
            if (alt) {
              let fresh = alt;
              if (fresh.refresh && fresh.expiresAt - REFRESH_SKEW_MS < Date.now()) {
                const next = await refreshAuth(fresh).catch(() => null);
                if (next) fresh = next;
              }
              auth = fresh;
              log(`catalog credential failover: -> ${auth.source}`);
              res = await doFetch();
            }
          }
        } else if (res.status === 401 || res.status === 403) {
          shape.sources[path] = `HTTP ${res.status} (ignored: another catalog endpoint already succeeded)`;
          continue;
        }
        // 5xx 是上游临时故障 → 硬失败；4xx / 端点没有 models 字段只算「这个
        // 区域没有这个端点」，不能因此让目录永远不更新。
        if (res.status >= 500) {
          hardError = true;
          shape.sources[path] = `HTTP ${res.status}`;
          continue;
        }
        const body = await res.json();
        // 包裹层级随端点而异，都试一遍
        const data = body?.data || {};
        const list = body?.data?.models
          ?? body?.data?.data?.models
          ?? body?.data?.Data?.models;
        if (!Array.isArray(list)) {
          shape.sources[path] = `no models (HTTP ${res.status})`;
          continue;
        }
        upstreamOk = true;
        shape.sources[path] = list.length;
        if (path === '/v3/config') {
          productModels = list;
          productAgents = Array.isArray(data.agents) ? data.agents : [];
        }
        for (const m of list) {
          if (!m || typeof m.id !== 'string') continue;
          merged.set(m.id, mergeCatalogModel(merged.get(m.id), m));
        }
        if (!shape.model.length && list[0]) shape.model = Object.keys(list[0]);

        // 诊断：客户端界面里的模型可能有别的来源，把这些候选字段的类型记下来
        const d = body?.data || {};
        shape.dataKeys = Object.keys(d);
        // agents[].models 可能是另一个模型来源，值得单独看
        const ag = d.agents;
        if (Array.isArray(ag)) {
          const holders = ag.filter((a) => a && Array.isArray(a.models) && a.models.length);
          shape.agentsWithModels = holders.length;
          if (holders[0]) {
            shape.agentModelsSample = JSON.stringify(holders[0].models.slice(0, 4));
            shape.agentName = holders[0].name;
          }
        }
        const wl = d.fillToolCallContentModelWhitelist;
        if (Array.isArray(wl)) shape.whitelistSample = JSON.stringify(wl.slice(0, 6));

        for (const key of ['agents', 'fillToolCallContentModelWhitelist', 'productFeatures']) {
          const v = d[key];
          if (Array.isArray(v)) {
            const first = v.find((x) => x && typeof x === 'object');
            shape[key] = `array(${v.length})${first ? ` keys=${Object.keys(first).join('/')}` : ''}`;
          } else if (v && typeof v === 'object') {
            shape[key] = `object keys=${Object.keys(v).slice(0, 8).join('/')}`;
          } else {
            shape[key] = typeof v;
          }
        }

        // modelPromotions 是**促销标注**（badge/discount + modelIds），不是模型本身：
        // 它给已有模型挂上「Free now」这类徽章，别把它当模型加进目录。
        const promos = body?.data?.modelPromotions;
        if (Array.isArray(promos) && promos.length) {
          shape.sources[`${path}#modelPromotions`] = promos.length;
          if (!shape.promotionFields) shape.promotionFields = Object.keys(promos[0] || {});
          shape.promotionDetail = promos.map((p) => ({
            badge: typeof p.badge === 'object' ? JSON.stringify(p.badge) : p.badge,
            discount: p.discount,
            enabled: p.enabled,
            kind: p.kind,
            models: p.modelIds,
            // 诊断用：活动时间窗/文案。真正是否生效由 promotions.mjs 现算，
            // 这样 23:00/08:00 切换时不必等目录重新抓取。
            schedule: p.schedule,
            hover: p.hover,
          }));
          for (const [modelId, rules] of groupPromotions(promos)) {
            const existing = promotions.get(modelId) || [];
            promotions.set(modelId, [...existing, ...rules]);
          }
        }
      } catch (e) {
        hardError = true;
        shape.sources[path] = `error: ${e.message}`;
      }
    }

    /*
     * 浏览器登录来源的促销补抓。
     *
     * 实测（同账号只读 A/B，issue #10）：
     *   - 桌面来源 `/v3/config`：25 个模型 + 8 条 modelPromotions；
     *   - 插件来源（默认 WorkBuddy/CLI 身份）：34 个模型，但 **0 条促销**；
     *   - 插件来源 + `WORKBUDDY_PLUGIN_IDENTITY=vscode`：25 个模型 + 8 条促销。
     * 也就是说插件身份能拿到更全的模型清单（v2 独有 13 个），但拿不到促销规则；
     * 促销只认桌面身份。不能整体切回 vscode 身份（会丢那 13 个模型），
     * 所以这里**额外用桌面身份只抓一份 /v3/config，只合并 modelPromotions**，
     * 模型清单仍以插件身份那份为准。
     *
     * 这是只读请求；失败只写进 shape 诊断，不影响模型目录和请求主链路。
     */
    if (auth.source === 'plugin' && PLUGIN_IDENTITY !== 'vscode') {
      try {
        const res = await fetch(`${auth.endpoint}/v3/config`, {
          headers: buildHeaders(auth, '', ''),
          signal: AbortSignal.timeout(8000),
        });
        if (res.ok) {
          const body = await res.json();
          const promos = body?.data?.modelPromotions;
          if (Array.isArray(promos) && promos.length) {
            shape.sources['/v3/config#desktopPromotions'] = promos.length;
            for (const [modelId, rules] of groupPromotions(promos)) {
              const existing = promotions.get(modelId) || [];
              const mergedRules = [...existing];
              for (const rule of rules) {
                if (!mergedRules.some((r) => JSON.stringify(r) === JSON.stringify(rule))) {
                  mergedRules.push(rule);
                }
              }
              promotions.set(modelId, mergedRules);
            }
            log(`plugin catalog: merged ${promos.length} promotion rule(s) from desktop identity`);
          } else {
            shape.sources['/v3/config#desktopPromotions'] = 0;
          }
        } else {
          shape.sources['/v3/config#desktopPromotions'] = `HTTP ${res.status}`;
        }
      } catch (e) {
        shape.sources['/v3/config#desktopPromotions'] = `error: ${e.message}`;
      }
    }

    // 在这里定格「上游给了几个模型」：**必须**在下面 FEATURED 补全之前取，
    // 因为补全之后 merged 至少会有 3 条，那个数字就不再代表上游了。
    // 用 merged.size 而不是各端点 list 长度之和：merged 是去重后的 Map，
    // 重复 id 不会把计数灌水，正好等于「桥实际认识多少个上游模型」。
    upstreamModelCount = merged.size;

    /*
     * 官方选择器的模型清单。**只用来标注 official，不删模型**：
     * `/v2/.../models` 里有些模型官方 GUI 不列（老型号 / 未开通线路），
     * 但直接调网关仍可能可用。插件默认只把 official 的放进 dsh 选择器，
     * 面板仍能看到全部并手动勾选。
     */
    const officialIds = officialPickerIds(productAgents, productModels);
    if (officialIds) {
      /*
       * v2 也可能单独给某个模型挂 `chat` 标签（v3 目录没列它）。官方 GUI 的
       * selectConversationModels 同样认这个标签；只遍历 v3 会把这类模型误标成
       * 非官方并在 dsh 里隐藏。
       */
      for (const m of merged.values()) {
        if (m._supplemented) continue;
        if (Array.isArray(m.tags) && m.tags.includes('chat')) officialIds.add(m.id);
      }
      shape.officialPickerCount = officialIds.size;
      shape.officialPicker = [...officialIds];
    }
    shape.productModelCount = productModels.length;

    // 目录接口**并不完整**：国际版能成功调用 deepseek-v4.1-flash，
    // 但它不出现在任何一个目录端点里。因此把已知可用、目录却漏掉的模型补进来
    // ——能不能用最终由上游决定，列出来才有机会被选到。
    //
    // ⚠️ 能力标记（images / supportsReasoning）**必须一起带上**：补全项一旦缺了
    // 它们，dsh 就会把模型显示成「纯文本、不支持推理」，用户连思考强度都选不了
    // （2026-10-12 的真实反馈）。这些值都是实测过的，见 FEATURED 的注释。
    // `regions` 过滤同理：不提供的区域不要补，否则是个一调就报错的死条目。
    const region = upstreamRegion(auth);
    for (const f of FEATURED) {
      if (merged.has(f.id)) continue;
      if (!featuredAllowedIn(f, region)) {
        shape.skippedByRegion = [...(shape.skippedByRegion || []), f.id];
        continue;
      }
      // 倍率**不猜**：本区域目录没给这个模型，就说明不知道该区域的定价。
      // 早前直接套用 FEATURED 的值（那是国内实测），会把国际版的免费模型
      // 标成 0.11——除非促销明确说它免费，否则一律留空。促销规则照存，
      // 由输出层按当前时间算（夜间活动不会整天显示免费）。
      const promotionRules = promotions.get(f.id) || [];
      merged.set(f.id, {
        id: f.id,
        name: f.name,
        maxInputTokens: f.context,
        maxOutputTokens: f.maxOutput,
        ...(f.images ? { supportsImages: true } : {}),
        ...(f.supportsReasoning ? { supportsReasoning: true } : {}),
        ...(promotionRules.length ? { promotionRules } : {}),
        _supplemented: true,
      });
      shape.supplemented = [...(shape.supplemented || []), f.id];
    }

    const models = [...merged.values()];
    // 某个端点 5xx 不代表另一个端点拿到的目录不可用；只有“一个成功端点都没有”
    // 时才保留旧缓存、拒绝写入。
    if (models.length && (upstreamOk || !hardError)) {
      /*
       * 发起后发生过换号 / 换来源：这份结果属于**旧凭据**，绝不能写进新缓存。
       * 旧请求无法取消（已经打出去了），只能在这里作废；invalidate 已经用
       * force 发起了新一代请求，最终缓存由新一代决定。
       */
      if (generation !== catalogGeneration) {
        log('catalog refresh result discarded: credential/source changed');
        return { models: catalogCache.models, upstreamOk: false, stale: true };
      }
      // 目录里排掉的东西登记下来，便于在 /health 的 upstreamShape 里追溯
      shape.droppedNonChat = models.filter((m) => isNonChatModel(m)).map((m) => m.id);
      // 与写进缓存的 models 用**同一套过滤**，保证这个计数就是"桥认识几个模型"，
      // 不会因为过滤规则前后不一致而虚高。
      const kept = models.filter((m) => m.supportsToolCall !== false
        && !/^(codewise|hunyuan-image)/.test(m.id)
        && !isNonChatModel(m));
      // 过滤后还剩几个是**真的来自上游**的（FEATURED 补全项带 _supplemented 标记，
      // 要排除掉——否则补全又会把计数顶上去，等于没修）。
      const upstreamKept = kept.filter((m) => !m._supplemented).length;
      /*
       * 这次**一条上游模型都没拿到**（401/403 刷新后仍失败、端点全无 models）：
       * 绝不能拿 FEATURED 补出来的 2-3 条顶掉已有目录 —— 用户会看到"模型只剩
       * 几个"，而且要等满 5 分钟 TTL 才可能恢复。保留旧目录，把缓存时间往前拨
       * 30 秒（下次请求就会再试），并在日志里说清楚。
       */
      const nextAt = upstreamOk ? Date.now() : Date.now() - CATALOG_TTL_MS + 30_000;
      if (!upstreamOk && catalogCache.models.length > 0) {
        catalogCache = { ...catalogCache, at: nextAt };
        log('catalog refresh got no upstream models; keeping previous catalog, retry in 30s');
      } else {
      catalogCache = {
        at: nextAt,
        account: auth.userId || auth.uid || '',
        source: auth.source || '',
        models: kept.map((m) => ({
          id: m.id,
          name: m.name || m.id,
          context: m.maxInputTokens,
          maxOutput: m.maxOutputTokens,
          /*
           * 官方 GUI 的上下文选择器（300K / 600K / 1M）来自
           * `contextWindow.{defaultLength,supportedLengths}`。默认预算与上限
           * 是两回事：上限仍是 maxInputTokens，选择器只影响客户端压缩预算。
           */
          contextDefault: Number(m.contextWindow?.defaultLength) > 0 ? Number(m.contextWindow.defaultLength) : 0,
          contextOptions: normalizeContextLengths(m.contextWindow?.supportedLengths),
          /*
           * 官方模型的默认采样温度。上游目录的模型对象里**确实有这个字段**
           * （见 /health 的 upstreamShape.model），旧实现整个丢掉了 —— 面板
           * 只能写"官方未公开"，用户无法判断该填多少。`temperature: 0` 是合法值，
           * 所以用 null 表示"上游没给"，不能拿 0 当缺省。
           */
          defaultTemperature: m.temperature != null && Number.isFinite(Number(m.temperature)) && Number(m.temperature) >= 0
            ? Number(m.temperature)
            : null,
          // 只有上游明确给了 supportsImages 才落 imagesKnown；缺失当未知，
          // 避免把“没上报”误判成“不支持图片”而错误降级。
          ...(m.supportsImages === true ? { images: true, imagesKnown: true } : {}),
          ...(m.supportsImages === false ? { images: false, imagesKnown: true } : {}),
          // 基础倍率；真正展示给客户端的是按当前促销时段算出的有效倍率，
          // 见 /v1/models 的输出层。
          credits: m.credits,
          ...(Array.isArray(promotions.get(m.id)) && promotions.get(m.id).length
            ? { promotionRules: promotions.get(m.id) }
            : {}),
          // 上游的推理能力标记：supportsReasoning=true 表示该模型接受推理强度控制
          //（选择器要据此显示"推理等级"下拉）；onlyReasoning 表示该模型只能以
          // 推理模式使用。不上报数据里的这两个字段，插件就无法给模型声明
          // reasoning 元数据 —— dsh 的选择器会少一个有用的控件。
          supportsReasoning: m.supportsReasoning === true,
          /*
           * 档位首选**上游目录**的 `reasoning.supportedEfforts`（这正是官方
           * GUI 下拉里的 low/high/max）。没有这个字段时才退回按 id 的实测表
           * （见 REASONING_EFFORTS_BY_MODEL）；两者都没有则按默认三档。
           * 存 null = "上游没给，输出时走实测兜底"。
           */
          reasoningEfforts: normalizeEfforts(m.reasoning?.supportedEfforts),
          defaultReasoningEffort: typeof m.reasoning?.defaultEffort === 'string'
            ? m.reasoning.defaultEffort
            : '',
          canDisableThinking: m.reasoning?.canDisableThinking === true,
          onlyReasoning: m.onlyReasoning === true,
          /*
           * 官方模型选择器是否列出它。supplemented 项是我们按实测补的，
           * 无法据此断言"官方未上架"，所以留 null（未知），既不隐藏也不冒充。
           */
          official: m._supplemented ? null : (officialIds ? officialIds.has(m.id) : null),
          supplemented: m._supplemented === true,
          // 保留上游的说明与标签：国际版把具体型号写在 description 里，
          // 光看 id（default-model 这类档位名）无法判断它其实是哪个模型
          vendor: m.vendor,
          tags: m.tags,
          descriptionZh: m.descriptionZh,
          descriptionEn: m.descriptionEn,
          isDefault: m.isDefault,
        })),
        // 诊断用：各端点的命中数量与模型字段名
        shape,
        /**
         * 缓存里**真正来自上游目录**、且能对话的模型条数。模型预校验的启用
         * 依据（见 preflightModelError），0 表示放行一切。
         *
         * 为什么不能用 `models.length > 0`：上面的 FEATURED 补全会**无条件**
         * 把 3 个精选模型塞进来，所以哪怕两个目录端点一个模型都没给出
         * （404 / 字段改名 / 空数组 / 全被 isNonChatModel 过滤），`models`
         * 照样非空。**非空 ≠ 已知**，差的就是这个 `_supplemented` 的排除。
         *
         * 也不要拿 upstreamOk 顶替：那个变量的语义是「端点回了一个 models
         * 数组」，空数组同样算 true，它服务于 /v1/models?refresh=1 的
         * "这次刷新算不算成功"提示，与本处的「桥认识几个模型」不是一回事。
         */
        upstreamModelCount: upstreamOk && !hardError ? upstreamKept : 0,
        // 原始计数留在诊断口径里，/health 的 upstreamShape 能直接看到
        upstreamModelsSeen: upstreamModelCount,
      };
      }
    } else if (hardError) {
      log('catalog refresh failed; keeping cached catalog');
    }
  } catch (e) { log('catalog fetch failed', e.message); hardError = true; }
  // 至少一个目录端点成功就算刷新成功；另一个端点的 5xx 只记在 shape.sources。
  return { models: catalogCache.models, upstreamOk };
}

/**
 * 精选模型：优先取 FEATURED 里**上游确实存在**的那些。
 *
 * 上游模型目录随地区而异——国际版（www.workbuddy.ai）就没有
 * deepseek-v4.1-flash，只有 default-model / fast-model 这类档位名。
 * 若一律照搬 FEATURED，就会报出上游根本没有的模型。
 */
/**
 * 默认视图的精选集：目录里有的用目录条目，缺的用定义兜底。
 *
 * `region` 只约束**兜底**那部分：目录里**有**的条目一律保留（它来自上游，
 * 说明这个区域确实提供它）；要拿定义补的则必须过 `regions` 过滤 ——
 * 否则国际版的默认视图里还会挂着 `deepseek-v4-pro` 这个一调就 400 的死条目。
 */
function pickFeatured(catalog, region = '') {
  const byId = new Map(catalog.map((m) => [m.id, m]));
  // 精选模型始终保留：目录里没有的用定义值补上（上游目录并不完整，
  // 例如国际版能调 deepseek-v4.1-flash，但目录里没有它）。
  //
  // ⚠️ 能力标记要跟着一起补（原先这里只补 id/name/context/maxOutput/credits）——
  // 少了 `images` / `supportsReasoning`，默认视图里的精选模型就是"纯文本 +
  // 不支持推理"，与补全路径（fetchCatalog）给的形状不一致。
  return FEATURED
    .filter((f) => byId.has(f.id) || featuredAllowedIn(f, region))
    .map((f) => byId.get(f.id) ?? {
      id: f.id,
      name: f.name,
      context: f.context,
      maxOutput: f.maxOutput,
      credits: f.credits,
      ...(f.images ? { images: true, imagesKnown: true } : {}),
      ...(f.images === false ? { images: false, imagesKnown: true } : {}),
      ...(f.supportsReasoning ? { supportsReasoning: true } : {}),
    });
}

/** 目录为空时的兜底视图：直接照 FEATURED 的定义造（过区域过滤）。 */
function fallbackCatalog(region = '') {
  return FEATURED
    .filter((f) => featuredAllowedIn(f, region))
    .map((f) => ({
      id: f.id,
      name: f.name,
      context: f.context,
      maxOutput: f.maxOutput,
      images: f.images === true,
      supportsReasoning: f.supportsReasoning === true,
    }));
}

/**
 * 把「保存的默认值」（面板 / 环境变量）与 `?limit=N`（请求级）合流成一次生效值。
 *
 * 语义：**请求级优先**。显式在 URL 里写 `limit=2` 就是"这次只要 2 个"，
 * 不该被桥里保存的那个更大的默认值放大回去（早先写成取更宽的那个，
 * 实测 `?limit=2` 在默认值 4 的情况下回了 4 个 —— 与用户的字面要求相反）。
 * 返回 `Infinity` 表示全量。
 *
 * @param {number} [requestLimit] `?limit=N` 解析后的值（非法/缺省传 0）
 */
function effectiveModelLimit(requestLimit = 0) {
  if (requestLimit > 0) return requestLimit;
  const current = effectiveModelsDefault();
  return current.mode === 'all' ? Infinity : (current.limit || 0);
}

/**
 * 精选里某个 id 的兜底条目（目录里暂时没它时用）。
 *
 * 只认**精选定义里有的** id：不在精选里、又不在当前目录里的 id，我们既不知道
 * 它的能力也不知道它还能不能用 —— 发给客户端只会得到一个必然失败的条目
 * （模型下架后尤其明显：用户点名过一个已下架的 id，不该继续挂在客户端列表里）。
 */
function fallbackCatalogEntry(id, region = '') {
  const f = FEATURED.find((x) => x.id === id);
  if (!f || !featuredAllowedIn(f, region)) return null;
  return {
    id: f.id,
    name: f.name,
    context: f.context,
    maxOutput: f.maxOutput,
    images: f.images === true,
    supportsReasoning: f.supportsReasoning === true,
  };
}

/**
 * 默认视图（不带 `all=1`）到底给哪些模型。
 *
 * `/v1/models` 与 `/health.modelsDefault.count` **必须**走同一个函数 —— 否则
 * 面板说「一键拉取会拿到 8 个」、客户端真拉到 3 个，就是又一处自相矛盾。
 *
 * @param {Array<{ id: string, [key: string]: any }>} catalog 完整目录（可能为空）
 * @param {string} region 区域（只影响精选兜底那部分）
 * @param {number} [requestLimit] `?limit=N`
 */
function defaultViewModels(catalog, region = '', requestLimit = 0) {
  const current = effectiveModelsDefault();
  /*
   * 「只给这几个」（面板里勾选的模型）：**先于**数量规则。
   *
   * 三个来源的优先级在这一个函数里定死，别处不要再判一次：
   *   ① `?limit=N`（请求级，最具体）
   *   ② 面板/环境变量里点名的 `ids`
   *   ③ `all` / 数字 / curated
   *
   * 点名清单与目录求交集：用户勾的时候它在目录里，之后上游下架了就不该继续
   * 冒充"可用"（客户端会拿着它去调，必然 404/400）。**顺序按用户点的顺序**，
   * 因为那同时是客户端列表里的显示顺序。
   */
  if (!(requestLimit > 0) && current.mode === 'ids' && Array.isArray(current.ids)) {
    const byId = new Map(catalog.map((m) => [m.id, m]));
    return current.ids
      .map((id) => byId.get(id) ?? fallbackCatalogEntry(id, region))
      .filter(Boolean);
  }  const wanted = effectiveModelLimit(requestLimit);
  /*
   * 精选集是**保底**：`wanted` 没设（0 = curated）时全给；设了就给到 `wanted`
   * 个 —— 包括**少于**精选数的情况。
   *
   * 早先这里写成"少于精选数就照旧全给"，看起来更安全（别把精选砍掉），
   * 但直接违背了用户的字面要求：`?limit=2` 回了 3 个。精选的用处是"默认视图
   * 先给几个"，用户显式要 2 个时，priority 是**他要 2 个**。
   */
  const slice = (list) => (wanted > 0 && wanted !== Infinity ? list.slice(0, wanted) : list);
  if (!catalog.length) return slice(fallbackCatalog(region));
  const curated = pickFeatured(catalog, region).map((u) => ({
    ...u,
    name: FEATURED.find((f) => f.id === u.id)?.name || u.name,
  }));
  if (wanted === Infinity) return catalog;
  if (wanted === 0 || wanted <= curated.length) return slice(curated);
  /*
   * 精选在前，其余按目录顺序补齐到 wanted。用 id 去重：目录里**有**的精选条目
   * 本身就在 catalog 里，不去重会重复列出同一个模型。
   */
  const seen = new Set(curated.map((m) => m.id));
  return [...curated, ...catalog.filter((m) => !seen.has(m.id))].slice(0, wanted);
}

// ── Billing / credits ────────────────────────────────────────────────────
/**
 * 计费网关与 chat 网关**不是同一个主机**：
 *   国内 chat = copilot.tencent.com，计费 = www.codebuddy.cn
 *   国际 = www.workbuddy.ai（chat 与计费同域；codebuddy.ai 登录则用 www.codebuddy.ai）
 */
/**
 * 显式覆盖计费网关。正常部署下不设，按域名推断；
 * 自建网关或验收脚本可以指到本地 stub，否则签到这条路径没法在离线环境验证。
 */
const EXPLICIT_BILLING_BASE = process.env.WORKBUDDY_BILLING_BASE || '';

function billingBase(auth) {
  if (EXPLICIT_BILLING_BASE) return EXPLICIT_BILLING_BASE;
  /*
   * 计费网关要跟着**登录域名**走，而不是只看 chat 端点：workbuddy.cn 账号的
   * chat 仍在 copilot.tencent.com，但计费/签到只认 www.workbuddy.cn ——
   * 发到 codebuddy.cn 会回 401（issue #5 截图里的「积分读取失败 HTTP 401」）。
   */
  const endpoint = typeof auth === 'string' ? auth : String(auth?.endpoint || '');
  const domain = typeof auth === 'object' ? String(auth?.domain || '') : '';
  const hint = `${endpoint} ${domain}`;
  if (hint.includes('codebuddy.ai')) return 'https://www.codebuddy.ai';
  if (hint.includes('workbuddy.ai')) return 'https://www.workbuddy.ai';
  if (hint.includes('workbuddy.cn')) return 'https://www.workbuddy.cn';
  return 'https://www.codebuddy.cn';
}

/** 计费类请求共用的请求头。 */
function billingHeaders(auth) {
  return {
    Authorization: `Bearer ${auth.access}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    ...(auth.userId ? { 'X-User-Id': auth.userId } : {}),
    ...(auth.enterpriseId ? { 'X-Enterprise-Id': auth.enterpriseId } : {}),
  };
}

/** 向计费网关发一次 POST，返回解包后的 data。 */
async function billingPost(auth, path, body = {}) {
  const res = await fetch(`${billingBase(auth)}${path}`, {
    method: 'POST',
    headers: billingHeaders(auth),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const envelope = await res.json().catch(() => null);
  if (!res.ok || !envelope || envelope.code !== 0) {
    throw new Error((envelope && (envelope.msg || envelope.message)) || `HTTP ${res.status}`);
  }
  return typeof envelope.data === 'object' && envelope.data !== null ? envelope.data : {};
}

/** 今日签到状态（只读，不改状态）。 */
async function fetchCheckinStatus(auth) {
  const d = await billingPost(auth, '/v2/billing/meter/checkin-activity-status');
  const num = (k) => (typeof d[k] === 'number' ? d[k] : 0);
  return {
    active: d.active === true,
    todayCheckedIn: d.today_checked_in === true,
    streakDays: num('streak_days'),
    dailyCredit: num('daily_credit'),
    todayCredit: num('today_credit'),
    isStreakDay: d.is_streak_day === true,
    nextStreakDay: num('next_streak_day'),
    streakBonusDays: num('streak_bonus_days'),
    streakBonusCredit: num('streak_bonus_credit'),
  };
}

/**
 * 领取今日签到奖励。
 *
 * 重复签到上游会返回非零业务码（含「已签到」），那是**幂等成功**而非失败——
 * 今天的奖励已经在账上，报成失败反而会误导用户。
 */
async function claimDailyCheckin(auth) {
  try {
    const d = await billingPost(auth, '/v2/billing/meter/daily-checkin');
    const num = (k) => (typeof d[k] === 'number' ? d[k] : 0);
    return {
      ok: true,
      already: false,
      credit: num('credit'),
      streakDays: num('streak_days'),
      isStreakDay: d.is_streak_day === true,
    };
  } catch (e) {
    const msg = String(e.message || e);
    if (/已签到|already/i.test(msg)) {
      return { ok: true, already: true, credit: 0, message: msg };
    }
    throw e;
  }
}

// ── 每日自动签到（R11.2）────────────────────────────────────────────────
// 内存态：桥重启后重新判定（上游幂等兜底，重复签也只是「已签到」）。
// 触发点有两个：/v1/chat/completions 开头（fire-and-forget，绝不阻塞这次调用）
// 与**桥自己的定时器**（见 startAutoCheckinTimer 的说明）。
const AUTO_CHECKIN_COOLDOWN_MS = numEnv('WORKBUDDY_CHECKIN_COOLDOWN_MS', 3600000, { min: 0 }); // 失败后冷却 1 小时再试
const AUTO_CHECKIN_MAX_PER_DAY = 3;       // 当天最多试 3 次，避免对上游打无效请求
let autoCheckinDay = '';                  // 「今天已尝试」的本地日期
let autoCheckinDoneDay = '';              // 「今天已签成功」的本地日期 —— 当天不再重试
let autoCheckinTries = 0;
let autoCheckinLastAt = 0;
let autoCheckinInflight = null;
let autoCheckinState = null;              // { at, result, error?, credit? }

/**
 * 触发一次自动签到（不 await）。失败策略写死，避免对上游打无效请求：
 * 失败后冷却 1 小时、当天最多 3 次；上游「已签到」按**成功**处理。
 */
function maybeAutoCheckin() {
  if (!AUTO_CHECKIN_ENABLED) return;

  const today = localDay(Date.now());
  if (today !== autoCheckinDay) {
    autoCheckinDay = today;
    autoCheckinTries = 0;
    autoCheckinLastAt = 0;
  }
  // 今天已经签成功了就别再打上游 —— 没有这条的话，定时器每小时都会问一次
  // 「签了没」，而答案永远是「签了」。
  if (autoCheckinDoneDay === today) return;
  if (autoCheckinTries >= AUTO_CHECKIN_MAX_PER_DAY) return;
  if (autoCheckinLastAt && Date.now() - autoCheckinLastAt < AUTO_CHECKIN_COOLDOWN_MS) return;
  if (autoCheckinInflight) return;

  autoCheckinLastAt = Date.now();
  autoCheckinTries += 1;
  autoCheckinInflight = (async () => {
    try {
      const claim = await claimDailyCheckin(await resolveAuth());
      autoCheckinState = {
        at: new Date().toISOString(),
        // 上游「已签到」是成功，不是失败（复用 claimDailyCheckin 的幂等语义）
        result: claim.already ? 'already' : 'ok',
        credit: typeof claim.credit === 'number' ? claim.credit : 0,
      };
      // 「已签到」也算今天不用再管了
      autoCheckinDoneDay = localDay(Date.now());
      log('auto checkin', autoCheckinState.result, autoCheckinState.credit);
    } catch (e) {
      const msg = shortError(e);
      // 国际版网关没有积分系统：这不是「失败」，如实区分开
      const noActivity = /no.?activity|not.?support|无.?签到|不存在|not.?found/i.test(msg);
      autoCheckinState = {
        at: new Date().toISOString(),
        result: noActivity ? 'no-activity' : 'error',
        error: msg,
      };
      // 没有签到活动的地方永远不会「成功」，再试也是白试 —— 当天收工
      if (noActivity) autoCheckinDoneDay = localDay(Date.now());
      log('auto checkin', autoCheckinState.result, msg);
    } finally {
      autoCheckinInflight = null;
    }
  })();
}

/**
 * 桥自己的每日签到定时器。
 *
 * **为什么必须有这个**：签到原先只挂在 `/v1/chat/completions` 开头 ——
 * 也就是说「有人调模型」才顺带签一次。但**桥才是常驻后台的那个进程**，
 * 而用户完全可能一整天不调模型（刚装好还没接客户端、周末没写代码、
 * 只用网页版而没走这个桥……）。
 *
 * 实测就撞上了：桥从 13:03 一直跑着，10-07 一整天**没有一条模型请求**，
 * 于是**一次签到都没发生**，用户晚上打开控制台才发现还得手动签。
 *
 * 控制台侧的 hourly 定时覆盖不了这种情况 —— 它要求控制台开着，而控制台
 * 恰恰是用户平时会关掉的那个（关掉后桥会留下，这是刻意的）。
 * 所以「按天自动」这件事必须由常驻的那一方负责。
 *
 * 间隔取 1 小时与失败冷却同频：`maybeAutoCheckin` 自己会挡掉重复调用
 * （当天成功过、超次数、冷却中都会直接返回），这里不需要再判。
 */
function startAutoCheckinTimer() {
  if (!AUTO_CHECKIN_ENABLED) return;
  // 启动后先等一会儿再试：上游连接预热与目录抓取都在开头，别挤在一起。
  // 可调是为了让测试不必真等 20 秒（生产环境没有理由改它）。
  const kickMs = numEnv('WORKBUDDY_CHECKIN_KICK_MS', 20000, { min: 0 });
  const kick = () => maybeAutoCheckin();
  setTimeout(kick, kickMs).unref?.();
  setInterval(kick, AUTO_CHECKIN_COOLDOWN_MS).unref?.();
}


/**
 * 只读查询积分余额（按套餐聚合）。
 *
 * 该端点不会消耗积分，可安全地按需调用。月度套餐（CapacityType=4）看
 * CycleCapacityRemain，一次性套餐看 CapacityRemain。
 */
async function fetchQuota(auth, { timeoutMs = 15000 } = {}) {
  const pad = (n) => String(n).padStart(2, '0');
  const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    + ` ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const now = new Date();

  const res = await fetch(`${billingBase(auth)}/v2/billing/meter/get-user-resource`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${auth.access}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(auth.userId ? { 'X-User-Id': auth.userId } : {}),
      ...(auth.enterpriseId ? { 'X-Enterprise-Id': auth.enterpriseId } : {}),
    },
    body: JSON.stringify({
      PageNumber: 1,
      PageSize: 100,
      ProductCode: 'p_tcaca',
      Status: [0, 3],
      PackageEndTimeRangeBegin: fmt(now),
      PackageEndTimeRangeEnd: fmt(new Date(now.getTime() + 3185136e6)),
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  const body = await res.json().catch(() => null);
  if (!res.ok || !body || body.code !== 0) {
    throw new Error((body && (body.msg || body.message)) || `HTTP ${res.status}`);
  }

  const accounts = body?.data?.Response?.Data?.Accounts;
  const list = Array.isArray(accounts) ? accounts : [];
  let total = 0;
  const packages = [];
  for (const a of list) {
    if (!a || typeof a !== 'object') continue;
    const num = (k) => (typeof a[k] === 'number' ? a[k] : 0);
    const monthly = num('CapacityType') === 4;
    const size = monthly ? num('CycleCapacitySize') : num('CapacitySize');
    const remainRaw = monthly ? num('CycleCapacityRemain') : num('CapacityRemain');
    const remain = remainRaw < 0 ? 0 : remainRaw;
    if (!monthly && remain <= 0) continue;
    total += remain;
    packages.push({
      name: a.PackageName || '(unnamed)',
      remain,
      size,
      monthly,
      expiresAt: a.ExpiredTime || (monthly ? a.CycleEndTime : undefined) || undefined,
    });
  }
  const result = { total, packages, productCode: 'p_tcaca' };
  recordQuotaSnapshot(result, auth);
  return result;
}

// ── HTTP server ──────────────────────────────────────────────────────────
/**
 * chat 请求体上限。
 *
 * 32MB 这个数是**从最大合法请求倒推**的，不是随手取的：dsh / 控制台的「图片
 * 转 base64 内联」会把整张图塞进 messages，1MB 的 PNG 编码后约 1.37MB，一条
 * 多轮带图对话叠到十几 MB 是正常现象。控制台自己那条 readBody 只给 512KB ——
 * 那是**控制台内部**的管理类小请求，桥这边不能照抄，否则一张稍大的图就被拒。
 * 反过来，无上限就等于「一个坏客户端能把这个零依赖的本地进程内存吃干」。
 * 32MB 足够覆盖真实的多模态对话，又能在单个请求层面兜住内存。
 *
 * 可用 `WORKBUDDY_MAX_BODY_BYTES` 覆盖：上限是随用法变的（比如有人专门灌长
 * 上下文做压测），写死会让那种场景没有任何出口。
 */
const MAX_BODY_BYTES = numEnv('WORKBUDDY_MAX_BODY_BYTES', 32 * 1024 * 1024, { min: 1024 });

/**
 * 读取请求体，超过 MAX_BODY_BYTES 立刻失败。
 *
 * **超限时既不在这里 destroy，调用方也不 destroy** —— 这是两次实测才定下来的：
 *
 *   1. 控制台那份 readBody 是「fail() + req.destroy()」，桥这边不能照抄：destroy
 *      会把 socket 直接拆掉，413 还没写出去，客户端只收到 ECONNRESET。
 *   2. 于是改成「这里 pause()、调用方写完 413 再 destroy」—— **仍然不行**。
 *      实测（1MB~16MB）：pause() 之后客户端**还在继续发**，此时 destroy 让内核
 *      回 RST，客户端在读到 413 之前就被复位，丢失率最高到 10/10（8MB）。
 *      对照实验：把 destroy 换成 resume()、其余一字不改 → 0/50 丢失。
 *
 * 所以最终做法是：超限时 `req.pause()` 停止为它累计内存，调用方回完 413 后
 * 用 `req.resume()` 把剩余字节**读掉并丢弃**，让这条连接自然收尾。
 *
 * 代价是确实还会从网络上读走那部分字节 —— 但这不违背 D2 的目标：D2 要挡的是
 * 「无上限地往内存里 Buffer.concat」，而 resume() 之后没有任何东西被累计，
 * 每条请求仍有 MAX_BODY_BYTES 的硬上限兜底。
 *
 * 抛出的错误带上 `code = 'BODY_TOO_LARGE'`：调用方要据此回**明确的 413**，
 * 而不是和「JSON 解析失败」共用同一个 400。
 */
const readBody = (req, limit = MAX_BODY_BYTES) => new Promise((resolve, reject) => {
  let size = 0;
  let done = false;
  const chunks = [];
  req.on('data', (c) => {
    if (done) return; // 已经判定超限：后续在途 chunk 一律丢弃，不再累计
    size += c.length;
    if (size > limit) {
      done = true;
      const err = /** @type {Error & { code?: string }} */ (new Error(`request body exceeds ${limit} bytes`));
      err.code = 'BODY_TOO_LARGE';
      // 先停住继续灌数据，再 reject —— 顺序反过来的话，pause 之前可能又塞进来
      // 几个 chunk（Node 的 data 事件是同步派发的），白占内存。
      // 注意这里**只是暂停**：真正丢弃剩余字节要等 413 写完之后（见调用方）。
      req.pause();
      reject(err);
      return;
    }
    chunks.push(c);
  });
  req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks).toString('utf8')); } });
  // 连接被对端提前掐断等情况：已经 settle 过就别再 reject 一次
  req.on('error', (e) => { if (!done) { done = true; reject(e); } });
});

/**
 * 所有响应的基础安全头。
 *
 * `nosniff`：不让浏览器去猜 Content-Type（响应里既有 JSON 又有 SSE，猜错会
 * 把数据当可执行内容处理）。`frame-ancestors 'none'`：本服务不该被任何页面嵌。
 */
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "frame-ancestors 'none'",
};

const json = (res, status, obj, extraHeaders = {}) => {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...extraHeaders, ...SECURITY_HEADERS });
  res.end(body);
};

/**
 * 统一的「请求体超限」出口。
 *
 * 两条协议的错误形状不同，但**收尾动作必须一致**：`readBody` 超限时只
 * `pause()`、不丢字节；413 写完后必须 `resume()` 把剩余字节读掉，否则
 * keep-alive 连接会停在暂停状态，下一条请求要么挂住、要么 ECONNRESET。
 * 这个动作曾在两个端点漏掉（`/v1/responses`、`/v1/messages/count_tokens`），
 * 所以收敛成一个函数，避免再靠手写复制。
 */
function rejectTooLarge(
  req,
  res,
  protocol,
  message = `request body too large (limit ${MAX_BODY_BYTES} bytes)`,
  code = null,
) {
  const body = protocol === 'anthropic'
    ? { type: 'error', error: { type: 'request_too_large', message, ...(code ? { code } : {}) } }
    : { error: { type: 'payload_too_large', message, ...(code ? { code } : {}) } };
  json(res, 413, body);
  req.resume();
}

/**
 * 这个请求的 Origin 是否可以放行。
 *
 * **为什么必须校验：绑定 127.0.0.1 挡不住浏览器。** 恶意网页可以把域名解析到
 * 127.0.0.1（DNS rebinding），让浏览器把请求发到本机服务；响应被 CORS 挡住读不到，
 * 但**副作用已经发生** —— 桥会照常转发、消耗账号配额。实测：带
 * `Origin: https://evil.example` 的跨站形状请求（text/plain、无鉴权）得到 200，
 * 打桩上游确实被调用。桥自身的本地令牌默认是**空**，所以不能只靠令牌兜底。
 *
 * 判据：本机 CLI / SDK（curl、dsh 插件、控制台）**不发 Origin**，一律放行；
 * 带 Origin 的只放行**回环来源**（本机网页版客户端照常可用），其余一律拒绝。
 */
function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // 非浏览器调用（CLI / SDK / 内部代理）
  let host;
  try { host = new URL(origin).hostname; } catch { return false; } // 含 `Origin: null`
  const bare = String(host).replace(/^\[|\]$/g, '');
  return bare === '127.0.0.1' || bare === 'localhost' || bare === '::1';
}

/**
 * 回环 Origin 的 CORS 响应头（**只回显回环，永不 `*`**）。
 *
 * ## 为什么需要
 *
 * `originAllowed()` 的注释承诺「本机网页版客户端照常可用」，但浏览器做跨源
 * 请求**必须先过预检**，而预检按设计**不带 Authorization** —— 它会先撞上令牌
 * 闸门（401）或被 404 兜底吃掉，于是这条承诺从来没能兑现（实测：
 * `OPTIONS /v1/chat/completions` 带回环 Origin → 401；带合法令牌 → 404，
 * 两个状态下都没有任何 `Access-Control-Allow-*`）。
 *
 * ## 为什么不是"放开"
 *
 * 加 CORS 会动到 `docs/CLIENT-CONNECT-AUDIT.md` 里明确依赖的一条性质
 * （"跨站页面读不到响应"）。所以这里取**收窄**做法：
 *   - 只对 `originAllowed()` 已经认可的回环 Origin 回显该 Origin —— 非回环一律不发头，
 *     跨站页面仍然读不到响应（原性质保留）；
 *   - **永不发 `*`**：`*` 会让任意网页读响应，等于把原性质直接拆掉；
 *   - **不发 `Access-Control-Allow-Credentials`**：本桥不靠 Cookie 鉴权（靠
 *     Bearer / x-api-key 头），带上它只会平白扩大攻击面。
 *
 * 回显得用请求里的**原样** Origin（预检是逐 Origin 的，回显别的值浏览器不认）；
 * 能用 `originAllowed()` 做谓词说明它已过 URL 解析，这里再取一次是安全的。
 *
 * @returns {object} 要合并进响应的头；非回环 / 无 Origin 时返回 `{}`
 */
function corsHeaders(req) {
  const origin = req.headers.origin;
  if (!origin || !originAllowed(req)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Vary': 'Origin',
  };
}

/**
 * 处理浏览器预检（`OPTIONS` + `Access-Control-Request-Method`）。
 *
 * **必须放在令牌闸门之前**：预检按规范**不带凭证**，放到闸门后面等于没加
 * （这正是当前 401 的成因）。预检本身不碰上游、不落账、不产生副作用，
 * 所以在这里放行是安全的 —— 真正的安全性仍由后续真实请求的令牌校验保证。
 *
 * 只对回环 Origin 应答；非回环 Origin 返回 false，让调用方走正常流程
 * （那会和以前一样被 `originAllowed` 判 403）。
 *
 * @returns {boolean} 已处理并结束响应则 true
 */
function handlePreflight(req, res) {
  if (req.method !== 'OPTIONS') return false;
  const origin = req.headers.origin;
  if (!origin || !originAllowed(req)) return false; // 非回环：交给正常流程拒绝
  // 请求预检时浏览器会带 Access-Control-Request-Method；不带也照答，无害。
  res.writeHead(204, {
    // 只声明我们真的会处理的请求头/方法，不做无根据的放大
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, x-api-key, anthropic-version, anthropic-beta',
    'Access-Control-Max-Age': '600',
    ...corsHeaders(req),
    ...SECURITY_HEADERS,
  });
  res.end();
  return true;
}

/**
 * 本地令牌校验。两种写法都收：
 *   - `Authorization: Bearer <token>` —— OpenAI 系客户端的惯例
 *   - `x-api-key: <token>`            —— Anthropic 系客户端的惯例（Claude Code 用这个）
 *
 * 两者承载的是同一个「本机回环令牌」，用途完全一致，没有理由让用户为了换一个
 * 客户端就记两套写法。**只影响本机回环端口上的这一个校验点**，与上游凭据无关。
 * （B2 起鉴权入口改用下方的 identifyClientId —— 它在令牌之上还支持客户端
 * 凭据分层；本函数保留给只需要「是不是管理钥匙」布尔判断的调用方。）
 */

/**
 * 请求级上下文（AsyncLocalStorage）：把「这是哪个调用方」传播到请求处理链的
 * 任何深处（账本、限流都在深处取用），不需要把 res 一路传下去。
 */
const requestScope = new AsyncLocalStorage();

/**
 * 识别调用方：`'local'`（管理 / 控制台 / 默认钥匙）| 客户端 id（key 哈希前 8 位）
 * | `null`（未识别 → 401）。LOCAL_TOKEN 是万能钥匙；client key 是分层的调用方
 * 凭据（可单独吊销、独立限流、独立记账）。两种写法（Bearer / x-api-key）同
 * hasLocalToken，一并支持。
 */
function identifyClientId(req) {
  let token = null;
  if (typeof req.headers.authorization === 'string' && req.headers.authorization.startsWith('Bearer ')) {
    token = req.headers.authorization.slice(7);
  }
  if (!token && typeof req.headers['x-api-key'] === 'string') token = req.headers['x-api-key'];
  if (!token) return null;
  if (safeEqual(token, LOCAL_TOKEN)) return 'local';
  const hex = createHash('sha256').update(token).digest('hex');
  return CLIENT_KEY_HASHES.get(hex) || null;
}

/**
 * 常量时间字符串比较。
 *
 * 为什么不能直接 `token === LOCAL_TOKEN`：JS 的字符串比较**短路**——
 * 第一个不同的字符就返回，比较耗时与实际匹配长度成正比。本机进程可以反复
 * 发请求、按返回时序逐字节恢复口令（`wb-local-bridge` 这种短口令尤其容易）。
 * 走 timingSafeEqual 先比长度（长度不等直接 false，这个信息本身不敏感），
 * 等长时定时比较。
 */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * 401 的响应体：失败原因 + **可操作的排查步骤**。
 *
 * 为什么值得单独写一段：令牌默认值从固定串 `wb-local-bridge` 改为随机生成后，
 * **所有历史用户升级后都会撞 401** —— 他们的客户端配置里还存着旧口令，
 * 而原响应体只有干巴巴一句 `bad or missing token`，用户既不知道"为什么昨天还行"
 * 也不知道"去哪找新值"。401 是升级后最高频的故障，却只给了一句无信息量的话。
 *
 * **绝不能把真实令牌写进这里**：桥绑在回环端口上，同机的任何进程（包括攻击者
 * 的脚本）都能发请求拿到响应体 —— 把答案写在错误信息里，等于把 401 变成
 * "免费领取令牌"接口。所以只给**获取路径**，不给值。
 *
 * 措辞刻意覆盖三种来源，因为它们的第一反应各不相同：
 *   - 老用户升级 → "昨天还能用" → 要明确说令牌变过、旧值请换；
 *   - 新用户首次接入 → "还没填" → 要直接指到控制台面板；
 *   - 填错 → 指到同一个地方即可，无需单独分支。
 */
function unauthorizedBody() {
  const hints = [
    'workbuddy-bridge: bad or missing token',
    '',
    '如果之前能用、升级后突然 401：本地回环令牌的默认值已改为**随机生成**'
      + '（旧版本是固定串 wb-local-bridge）。请把客户端里填的旧值换成新令牌。',
    '',
    '**如果你填的就是文件里的新令牌、却仍然 401**：那不是客户端填错了，而是'
      + '**在跑的桥**内存里还是旧令牌 —— 它是在升级前启动的，而令牌文件后来被'
      + '别的进程创建成了另一个值（`config.mjs` 在**模块求值时**就会生成并落盘，'
      + '所以跑测试、跑工具也会创建它）。',
    '处置：把**桥和控制台一起重启**（走 `启动.cmd`），两边会收敛到文件里的同一个值；'
      + '只重启一边会继续 401。',
    '如果这是首次接入：还没填过令牌。',
    '',
    '新令牌在这里：',
    '  · 控制台 →「客户端接入」面板（直接显示，可一键复制）',
    '  · 或读文件 dsh-plugin/.bridge-token',
    '  · 或看你启动桥时的日志：WORKBUDDY_LOCAL_TOKEN=<值>',
    '',
    '想固定成自己的值：在 .env 里设 WORKBUDDY_LOCAL_TOKEN=<你的值>（优先级最高）。',
    '注意：桥只服务本机（127.0.0.1），不对外提供令牌查询接口。',
  ];
  return { error: { message: hints.join('\n'), type: 'invalid_api_key', code: 'invalid_api_key' } };
}

// ── 响应观测：进程级计数 + 开销头（横切两件事，只包一次）──────────────────
/**
 * 进程级计数（供 /health 的 `process` 段）：
 *   requests —— 真实客户端请求数（**排除 /health 探活**，否则会被控制台
 *               每 20 秒的轮询灌水，"本进程处理了多少请求"就没意义了）；
 *   errors / byStatus —— 4xx/5xx 数与状态码分布，排障时一眼看清失败类形。
 */
const procStats = { requests: 0, errors: 0, byStatus: {} };

/**
 * 包装 `res.writeHead`，统一做两件事：
 *   ① 计数（真实请求的状态码分布，健康探活不计）；
 *   ② 注入 `X-WorkBuddy-Overhead-Ms` —— 端点把「桥自身处理耗时」写到
 *      `res.__overheadMs`（= 总耗时 − 上游往返），这里统一发出。
 * 这样各响应点不必各自拼头；没设置该字段的响应（/health、/v1/models 等
 * 本地应答）自然不带 —— 头只出现在"性能主张相关"的对话路径上。
 */
function observeResponse(req, res) {
  if (req.url?.startsWith('/health')) return; // 探活不计数、不加头
  // CORS 头在这里统一注入：**所有**响应（含 401 / 403 / 404 / 上游错误）
  // 都要带上，否则浏览器读不到那条错误 —— 用户看到的是"CORS 错误"而不是
  // "令牌不对"，排查会南辕北辙。非回环 Origin 时 corsHeaders 返回 {}，等于不加。
  // 放在 writeHead 包装里是刻意的：8 个响应点分散在各处，逐个改必漏。
  const cors = corsHeaders(req);
  const origWriteHead = res.writeHead.bind(res);
  res.writeHead = (...args) => {
    const statusCode = args[0];
    if (typeof statusCode === 'number') {
      /*
       * 探活类请求不进进程计数：控制台/插件现在每 2 秒打一次 /v1/identity
       * （外加各自的 /health）。算进去会把“真实请求数/失败数”稀释成噪音，
       * 面板的待办与成功率也会被探活污染。
       */
      const statPath = String(req.url || '').split('?')[0];
      if (statPath !== '/health' && statPath !== '/v1/identity') {
        procStats.requests += 1;
        procStats.byStatus[statusCode] = (procStats.byStatus[statusCode] || 0) + 1;
        if (statusCode >= 400) procStats.errors += 1;
      }
    }
    // 只在 (status, headers对象) 形态时注入；其余形态（数组头/statusMessage）原样放行
    if (args.length === 2 && args[1] && typeof args[1] === 'object' && !Array.isArray(args[1])) {
      args[1] = { ...cors, ...args[1] };
      if (res.__overheadMs !== undefined) {
        args[1] = { 'X-WorkBuddy-Overhead-Ms': String(res.__overheadMs), ...args[1] };
      }
    }
    return origWriteHead(...args);
  };
}

// ── 在途请求注册表（卡死可见性）──────────────────────────────────────────
/**
 * 进行中的对话请求（id / 开始时刻 / 模型 / 流式标记）。
 *
 * 目的：长回答静默几十秒时，用户能区分「模型在想」与「真的卡死了」——
 * 控制台「最近请求」显示进行中条目与已运行时长，超阈值标黄提醒。
 *
 * **红线：不加任何默认超时** —— 长回答需要无限等待（见 README 注意事项），
 * 本注册表只负责**显示**，绝不主动打断请求。
 *
 * 释放：统一挂 `res.once('close')`（响应完成或连接中断都会触发），
 * 成功 / 失败 / 客户端断开三条路径一个挂点全覆盖 —— 不会泄漏。
 */
const inflight = new Map();
let inflightSeq = 0;
/** 运行超过该毫秒数即判「疑似卡死」——只影响显示高亮，不干预请求。 */
const ACTIVE_ALERT_MS = numEnv('WORKBUDDY_ACTIVE_ALERT_MS', 300_000, { min: 1000 });

function trackInflight(req, res, model, stream) {
  const id = `req_${(++inflightSeq).toString(36)}-${Date.now().toString(36)}`;
  inflight.set(id, { id, startedAt: Date.now(), model: String(model || ''), stream: !!stream });
  res.once('close', () => { inflight.delete(id); });
}

const server = createServer((req, res) => {
  // 请求级上下文：入口处识别调用方一次（local / client key 哈希前 8 位），
  // 账本与限流在处理链的任何深处用 requestScope.getStore() 取用。
  requestScope.run({
    client: identifyClientId(req),
    probe: req.headers['x-workbuddy-probe'] === '1',
  }, () => handleRequest(req, res));
});

async function handleRequest(req, res) {
  /*
   * `Host` 是**客户端可控的**，而 `new URL()` 会对非法 Host 抛 `ERR_INVALID_URL`。
   * 这一句原先在下面那个 try **之外** —— 抛出的异常没被捕获，Node 直接退出进程：
   * 任何能访问本机端口的进程用一条 `Host: bad host with spaces` 就能把桥打死
   * （实测 exitCode=1，见 bridge.test.mjs 的「畸形 Host 头回 400」）。
   * 现在按「非法请求」挡下，与其余入口校验同一处理方式。
   *
   * `Host` 缺失/为空时给个回环默认值：`http://undefined` 也是合法 URL，
   * 但把它当成本机更贴近事实，也不会让下游的绝对 URL 拼出怪东西。
   */
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  } catch {
    return json(res, 400, { error: { message: 'workbuddy-bridge: invalid Host header' } });
  }
  observeResponse(req, res);
  try {
    if (!originAllowed(req)) {
      return json(res, 403, { error: { message: 'workbuddy-bridge: cross-origin request rejected (this bridge serves local clients only)' } });
    }
    /*
     * 浏览器预检必须在令牌闸门**之前**处理：预检按规范不带 Authorization，
     * 放到闸门后面就会被 401 吃掉（这正是「本机网页版客户端」一直不可用的原因）。
     * 详见 handlePreflight 的说明。
     */
    if (handlePreflight(req, res)) return;
    /*
     * 令牌**始终必需**。
     *
     * 旧写法是 `if ((LOCAL_TOKEN || CLIENT_KEY_HASHES.size) && ...)` —— 未配置令牌时
     * 整个分支不执行，等于「不配令牌就不鉴权」。LOCAL_TOKEN 现在永远非空
     * （未配置时自动生成，见 LOCAL_TOKEN 定义），所以这里可以直接判 null。
     * 保留 `CLIENT_KEY_HASHES.size` 只是为了让「只配了 client key」的语义清楚。
     */
    if (identifyClientId(req) === null) {
      // 带着排查指引返回（见 unauthorizedBody 的说明）；**不含真实令牌**。
      // API-key-404 的失败同样要落账，否则"客户端为什么连不上"在控制台上
      // 完全不可见 —— 用户只能看到一个 401，账本上一片空白。
      recordRequest({
        model: '',
        stream: false,
        ms: 0,
        ok: false,
        status: 401,
        code: null,
        error: 'bad or missing token (client not identified)',
      });
      return json(res, 401, unauthorizedBody());
    }

    /*
     * 管理面只认 local（LOCAL_TOKEN）。
     *
     * client key 是给普通 OpenAI 客户端用的：能聊天、列模型就够了。旧实现里
     * 它同样能切凭据来源、切换 active 账号、删插件凭据、发起设备码登录、
     * 清空账本 —— 只要客户端配置泄漏一把 key，就能切走别人的钱包或清掉历史。
     */
    const managementRequest = url.pathname.startsWith('/v1/auth/')
      || (url.pathname === '/v1/usage' && req.method === 'DELETE')
      || (url.pathname === '/v1/checkin' && req.method === 'POST');
    if (managementRequest && requestScope.getStore()?.client !== 'local') {
      return json(res, 403, {
        error: {
          message: 'workbuddy-bridge: management endpoint requires the local token '
            + '(client keys are chat-only)',
          type: 'management_forbidden',
        },
      });
    }

    /*
     * 视频/图片接口能读本机绝对路径图片、且提交会消耗账号积分 —— 和聊天不是同一类
     * 能力。client key 按设计是“仅聊天”，不能借媒体接口越权读文件或花积分。
     */
    const videoRequest = url.pathname === '/v1/videos' || url.pathname.startsWith('/v1/videos/');
    const imageRequest = url.pathname === '/v1/images'
      || url.pathname === '/v1/images/edits'
      || url.pathname.startsWith('/v1/images/');
    if ((videoRequest || imageRequest) && requestScope.getStore()?.client !== 'local') {
      const kind = imageRequest ? 'image' : 'video';
      return json(res, 403, {
        error: {
          message: `workbuddy-bridge: ${kind} generation requires the local token `
            + '(client keys are chat-only)',
          type: `${kind}_forbidden`,
          code: `${kind.toUpperCase()}_LOCAL_TOKEN_REQUIRED`,
        },
      });
    }

    /*
     * 极轻的身份端点：只解析凭据并返回「现在是谁」，不抓目录、不打上游。
     * 面板每 2 秒轮询它，身份版本一变就立刻重拉账号/积分/模型目录。
     */
    if (url.pathname === '/v1/identity') {
      try {
        const a = await resolveAuth();
        let desktopUserId = '';
        try {
          const desktop = a.source === 'desktop' ? a : await readStoredAuth();
          desktopUserId = desktop.userId || '';
        } catch { /* 桌面文件读不出：只报桥自己的身份 */ }
        return json(res, 200, {
          ok: true,
          pid: process.pid,
          build: BRIDGE_BUILD,
          startedAt: new Date(STARTED_AT).toISOString(),
          authFile: AUTH_PATH,
          ...(AUTH_PATH !== AUTH_PINNED_PATH ? { authFilePinned: AUTH_PINNED_PATH, authFollow: true } : {}),
          auth: {
            source: a.source,
            userId: a.userId || a.uid || '',
            enterpriseId: a.enterpriseId || '',
            tenantId: a.tenantId || '',
            endpoint: a.endpoint || '',
            expiresAt: a.expiresAt ? new Date(a.expiresAt).toISOString() : '',
            changedAt: authIdentity.changedAt ? new Date(authIdentity.changedAt).toISOString() : '',
          },
          desktopUserId,
        });
      } catch (e) {
        return json(res, 503, {
          ok: false,
          error: e.message,
          pid: process.pid,
          build: BRIDGE_BUILD,
          authFile: AUTH_PATH,
          ...(AUTH_PATH !== AUTH_PINNED_PATH ? { authFilePinned: AUTH_PINNED_PATH, authFollow: true } : {}),
        });
      }
    }

    if (url.pathname === '/health') {
      let auth = null;
      let region = '';
      const credential = {
        configured: await effectiveSource(),
        storeMode: credentialStoreMode(),
        storeDir: credentialStoreMode() === 'memory' ? '' : CREDENTIAL_DIR,
        fallbackReason: credentialStoreFallback,
        source: '',
        pluginCount: 0,
      };
      try {
        let a = await resolveAuth();
        credential.source = a.source;
        /*
         * 桌面登录文件当前是谁：用于面板/插件对照「桥实际使用的账号」。
         * 来源是 plugin 时 `a` 是插件账号，必须再读一次桌面文件才能发现
         * 「桌面已换号、桥还在用旧账号」这种不一致（issue #6）。
         */
        try {
          const desktop = a.source === 'desktop' ? a : await readStoredAuth();
          credential.desktopUserId = desktop.userId || '';
        } catch (desktopError) {
          credential.desktopUserId = '';
          credential.desktopError = String(desktopError?.message || desktopError).slice(0, 200);
        }
        /*
         * 并发请求可能在这段时间完成“跟随桌面”并改写来源。再对一次，避免
         * 这一份 /health 同时报出新账号的 desktopUserId 和旧账号的 auth。
         */
        if ((await effectiveSource()) !== a.source) a = await resolveAuth();
        region = upstreamRegion(a);
        credential.source = a.source;
        try {
          credential.pluginCount = credentialStoreMode() === 'memory'
            ? memoryCredentials.size
            : readdirSync(CREDENTIAL_DIR).filter((f) => f.endsWith('.cred')).length;
        } catch { credential.pluginCount = 0; }
        auth = {
          source: a.source,
          userId: a.userId || a.uid || '',
          endpoint: a.endpoint,
          expiresAt: a.expiresAt ? new Date(a.expiresAt).toISOString() : '',
          expired: a.expiresAt ? a.expiresAt < Date.now() : false,
          changedAt: authIdentity.changedAt ? new Date(authIdentity.changedAt).toISOString() : '',
        };
      } catch (e) {
        // 带上 pid：未登录/凭据异常时 stop() 也要能停掉自己的进程（否则用户点停止只会得到一个假错误）
        return json(res, 503, {
          ok: false, error: e.message, authFile: AUTH_PATH, pid: process.pid,
          build: BRIDGE_BUILD,
          ...(AUTH_PATH !== AUTH_PINNED_PATH ? { authFilePinned: AUTH_PINNED_PATH, authFollow: true } : {}),
          startedAt: new Date(STARTED_AT).toISOString(),
          credential: await credentialStatus(),
        });
      }
      // 这里**绝不能等上游**：控制台的探测超时是 4 秒，冷缓存时抓目录要好几秒，
      // 一旦超时就会被误判成「桥未运行」。有缓存立刻答，没有或过期都只触发后台刷新。
      if (!catalogCache.models.length || Date.now() - catalogCache.at > CATALOG_TTL_MS) refreshCatalog();
      const catalog = catalogCache.models;
      return json(res, 200, {
        ok: true,
        pid: process.pid,
        build: BRIDGE_BUILD,
        startedAt: new Date(STARTED_AT).toISOString(),
        uptimeMs: Date.now() - STARTED_AT,
        auth,
        authFile: AUTH_PATH,
        ...(AUTH_PATH !== AUTH_PINNED_PATH ? { authFilePinned: AUTH_PINNED_PATH, authFollow: true } : {}),
        credential,
        // 客户端定位结果（**只读内存缓存、绝不触发探测** —— /health 有 4 秒超时
        // 约束，慢探测会让控制台把桥误判成"未运行"；没定位过就显示空）
        clientExe: atRestUsedExe || wbExeCache || '',
        /*
         * 默认视图**实际**给哪些模型：与 `GET /v1/models`（不带参数）走同一个
         * 函数。面板拿它当「客户端一键拉取会看到什么」的权威口径 —— 早先这里
         * 写死 `pickFeatured`，一改默认规模就会与客户端真正拉到的对不上。
         */
        models: defaultViewModels(catalog, region).map((m) => m.id),
        /*
         * 默认视图的规模设置。
         *
         * 面板与「接入」卡片要能说清三件事：客户端一键拉取会看到几个（`count`）、
         * 这个数**从哪来**（`source`：panel / env / builtin）、全量目录有多少
         * （`total`）。写错值时 `invalid` 会带上原始字符串，诊断页据此提示
         * 「这个值没被采用」—— 而不是让用户以为配置生效了。
         */
        modelsDefault: {
          ...effectiveModelsDefault(),
          total: catalog.length || fallbackCatalog(region).length,
          /** 客户端不带参数时（`GET /v1/models`）实际会拿到几个。 */
          count: defaultViewModels(catalog, region).length,
        },
        catalogSize: catalog.length,
        catalogAt: catalogCache.at ? new Date(catalogCache.at).toISOString() : null,
        catalogRefreshing: !!catalogRefreshing,
        upstreamShape: catalogCache.shape || null,
        // 进程级计数：真实请求数（不含 /health 探活）/ 失败数 / 状态码分布 / 限流触发数
        process: {
          requests: procStats.requests,
          errors: procStats.errors,
          byStatus: procStats.byStatus,
          rateLimited: rateState.limited,
        },
        // 客户端凭据分层（B2）：只暴露启用状态与数量，**绝不回显 key 或哈希**
        clients: { enabled: CLIENT_KEY_HASHES.size > 0, count: CLIENT_KEY_HASHES.size },
        // 自动签到的内存态：桥重启后清空、重新判定（上游幂等兜底）
        autoCheckinEnabled: AUTO_CHECKIN_ENABLED,
        autoCheckin: autoCheckinState,
      });
    }

    // ── 默认视图规模（面板「可用模型」里的「桥返回几个模型」）─────────────
    /*
     * 这条不是 OpenAI 协议的一部分，是本项目自己的设置面：客户端的「获取模型
     * 列表」按钮不会带 `all=1`，用户想让它们看到全部就得改**默认视图**。
     *
     * 存在桥的数据目录（不是 `.env`）：改了**立即生效**、不需要重启桥，也不需要
     * 用户去手改配置文件。环境变量仍是部署级默认，面板没存过时才用。
     */
    if (url.pathname === '/v1/models/default' && req.method === 'GET') {
      const current = effectiveModelsDefault();
      /*
       * 与 POST 回同一套字段（含 `count` / `total`）。
       *
       * 为什么 GET 也要算这两个数：面板刚打开时只调一次 GET 就要把
       * 「当前一键拉取给 N 个 · 目录共 M 个」显示出来 —— 若 GET 不给，
       * 页面得等一次目录加载才敢显示，而那时文案会先空一截。
       * 用**缓存**里的目录算，不触发上游抓取（这条是高频探活路径）。
       */
      const catalog = catalogCache.models;
      let region = '';
      try { region = upstreamRegion(await resolveAuth()); } catch { region = ''; }
      return json(res, 200, {
        ok: true,
        ...current,
        env: process.env.WORKBUDDY_MODELS_DEFAULT || '',
        saved: readSavedModelsDefault(),
        file: modelsDefaultFile(),
        total: catalog.length || fallbackCatalog(region).length,
        count: defaultViewModels(catalog, region).length,
      });
    }

    if (url.pathname === '/v1/models/default' && req.method === 'POST') {
      let body;
      try { body = JSON.parse(await readBody(req)); } catch { body = null; }
      if (!body || typeof body !== 'object') {
        return json(res, 400, { ok: false, error: 'body must be a JSON object' });
      }
      /*
       * 两种提交形状，二选一：
       *   - `{ value }` → `curated` / `all` / 正整数（按数量给）；
       *        传 `null` / 空串 = 清掉面板偏好，回落到环境变量或内建精选。
       *   - `{ ids: [...] }` → **只给这几个**（按名字点名，保持提交顺序）。
       *
       * 非法值**直接 400**（与配置校验同一套判据）：这是用户主动提交的设置，
       * 静默回退会让面板显示的和实际生效的不是一回事。
       */
      const rawIds = body.ids;
      const wantsIds = Array.isArray(rawIds);
      const rawValue = body.value;
      const clearing = !wantsIds && (rawValue === null || rawValue === undefined
        || (typeof rawValue === 'string' && rawValue.trim() === ''));
      const parsedIds = wantsIds ? parseIdsDefault(rawIds) : null;
      if (wantsIds && !parsedIds) {
        return json(res, 400, {
          ok: false,
          error: 'ids 里没有可用的模型 id（不能为空，且必须是可见 ASCII）',
        });
      }
      const parsed = wantsIds ? parsedIds : (clearing ? null : parseModelsDefault(rawValue));
      if (!wantsIds && !clearing
        && (parsed.invalid || (parsed.mode === 'curated' && String(rawValue).trim().toLowerCase() !== 'curated'))) {
        return json(res, 400, {
          ok: false,
          error: `不认识的取值：${String(rawValue)}（只能是 curated / all / 正整数）`,
        });
      }
      try {
        if (clearing) {
          if (existsSync(modelsDefaultFile())) unlinkSync(modelsDefaultFile());
          savedModelsDefault = null;
        } else {
          mkdirSync(dirname(modelsDefaultFile()), { recursive: true });
          // 原子写：半截 JSON 会让下次启动读到「没保存过」，看似回滚、毫无提示
          const tmp = `${modelsDefaultFile()}.tmp`;
          const record = wantsIds
            ? { ids: parsed.ids, savedAt: new Date().toISOString() }
            : {
              value: String(typeof rawValue === 'number' ? rawValue : String(rawValue).trim()),
              savedAt: new Date().toISOString(),
            };
          writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
          renameSync(tmp, modelsDefaultFile());
          savedModelsDefault = parsed;
        }
      } catch (e) {
        return json(res, 500, { ok: false, error: `保存失败：${e.message}` });
      }
      const current = effectiveModelsDefault();
      const catalog = await upstreamCatalog().catch(() => []);
      let region = '';
      try { region = upstreamRegion(await resolveAuth()); } catch { region = ''; }
      return json(res, 200, {
        ok: true,
        ...current,
        saved: readSavedModelsDefault(),
        total: catalog.length || fallbackCatalog(region).length,
        count: defaultViewModels(catalog, region).length,
      });
    }

    // ── OAuth device-code sign-in（第二条凭据来源）─────────────────────
    // 全部走同一道本地令牌闸门；响应里**永远不含** access / refresh token。
    if (url.pathname === '/v1/auth/source' && req.method === 'GET') {
      return json(res, 200, { ok: true, ...await credentialStatus() });
    }

    if (url.pathname === '/v1/auth/source' && req.method === 'POST') {
      let body;
      try { body = JSON.parse(await readBody(req)); } catch { body = null; }
      try {
        await setSourcePreference(body?.source);
        return json(res, 200, { ok: true, ...await credentialStatus() });
      } catch (e) {
        return json(res, 400, { ok: false, error: e.message });
      }
    }

    if (url.pathname === '/v1/auth/credentials' && req.method === 'GET') {
      return json(res, 200, {
        ok: true,
        configuredSource: await effectiveSource(),
        storeMode: credentialStoreMode(),
        fallbackReason: credentialStoreFallback,
        activeUid: readActiveUid(),
        credentials: await listPluginCredentials(),
        ...(pluginCredentialError ? { error: pluginCredentialError } : {}),
      });
    }

    if (url.pathname === '/v1/auth/credentials' && req.method === 'DELETE') {
      const uid = url.searchParams.get('uid') || '';
      if (!uid) return json(res, 400, { ok: false, error: 'uid is required' });
      try {
        await deletePluginCredential(uid);
        return json(res, 200, { ok: true, credentials: await listPluginCredentials() });
      } catch (e) {
        return json(res, 500, { ok: false, error: e.message });
      }
    }

    if (url.pathname === '/v1/auth/active' && req.method === 'POST') {
      let body;
      try { body = JSON.parse(await readBody(req)); } catch { body = null; }
      if (!body || typeof body.uid !== 'string' || !body.uid) {
        return json(res, 400, { ok: false, error: 'uid is required' });
      }
      try {
        await setActivePluginCredential(body.uid);
        return json(res, 200, { ok: true, activeUid: body.uid });
      } catch (e) {
        return json(res, 400, { ok: false, error: e.message });
      }
    }

    if (url.pathname === '/v1/auth/device' && req.method === 'POST') {
      let body;
      try { body = JSON.parse(await readBody(req)); } catch { body = null; }
      const region = body?.region || process.env.WORKBUDDY_LOGIN_REGION || 'cn';
      try {
        const started = await startDeviceLogin(region);
        const opened = body?.open === true ? openExternalUrl(started.url) : false;
        return json(res, 200, { ok: true, ...started, opened });
      } catch (e) {
        return json(res, 502, { ok: false, error: e.message });
      }
    }

    if (url.pathname === '/v1/auth/device' && req.method === 'GET') {
      const state = url.searchParams.get('state') || '';
      if (!state) return json(res, 400, { ok: false, error: 'state is required' });
      try {
        const result = await pollDeviceLogin(state);
        return json(res, 200, { ok: true, ...result });
      } catch (e) {
        return json(res, 502, { ok: false, error: e.message });
      }
    }

    if (url.pathname === '/v1/auth/device' && req.method === 'DELETE') {
      const state = url.searchParams.get('state') || '';
      pendingLogins.delete(state);
      return json(res, 200, { ok: true });
    }

    if (url.pathname === '/v1/models') {
      const all = url.searchParams.get('all') === '1';
      // refresh=1：强制重取上游目录。失败**不清空旧缓存**——宁可给一份标了
      // 年纪的目录，也别让页面突然空白；staleMs 就是那个「年纪」。
      const wantRefresh = url.searchParams.get('refresh') === '1';
      let staleMs = null;
      if (wantRefresh) {
        const startedAt = Date.now();
        const r = await refreshCatalog();
        if (!r.ok) {
          // 只有缓存**确实比本次刷新更旧**才叫「旧缓存」。若本次刷新已经更新过
          // 缓存（例如冷启动只拿到部分目录），说「0 秒前的缓存」是误导。
          staleMs = catalogCache.at && catalogCache.at < startedAt ? Date.now() - catalogCache.at : null;
          log('models refresh failed; serving cached catalog',
            staleMs === null ? 'no usable cache' : `${Math.round(staleMs / 1000)}s old`);
        }
      }
      // 刚刷过就别再走 upstreamCatalog()（它在缓存为空时会再触发一次刷新，等于白打一轮上游）
      const catalog = wantRefresh ? catalogCache.models : await upstreamCatalog();

      /*
       * 区域（用于 FEATURED 的 `regions` 过滤）。
       * 凭据读不出来时给空串 —— 那时只列**全区域**条目：region-restricted 的
       * 条目在没有区域信息时不敢声称可用（多报一个一调就 400 的模型比少报更糟）。
       */
      let region = '';
      try { region = upstreamRegion(await resolveAuth()); } catch { region = ''; }

      let models;
      if (!catalog.length) {
        // 上游目录取不到：退回精选定义，至少让客户端能用。
        // 能力标记照抄 FEATURED 的定义（原先这里给所有模型硬写 `images: true`
        // 且从不给 reasoning —— 对非视觉模型是**多报**，对推理模型是**漏报**）。
        models = fallbackCatalog(region);
      } else if (all) {
        models = catalog;
      } else {
        /*
         * 默认视图：精选集 + 可选放大。
         *
         * `WORKBUDDY_MODELS_DEFAULT`（桥级）与 `?limit=N`（请求级）在
         * `defaultViewModels` 里合流：没配就是原来的 3 个精选，配了才放宽。
         */
        const rawLimit = Number(url.searchParams.get('limit'));
        models = defaultViewModels(
          catalog,
          region,
          Number.isFinite(rawLimit) && rawLimit > 0 ? Math.trunc(rawLimit) : 0,
        );
      }

      // 促销是否生效按“现在”算，而不是目录抓取那一刻：夜间免费/折扣在
      // 23:00、08:00 切换时，只要客户端重新拉目录就能看到新价格。
      const promoNow = new Date();
      const list = models.map((m) => {
        const promo = applyPromotion({
          baseCredits: creditsOf(m),
          promotions: m.promotionRules,
          now: promoNow,
        });
        const credits = promo.credits;
        // 上游 tags 里混着旧促销徽章；这里只保留有效的那一个，过期活动
        // （step-5-preview / space-bunny）不会继续以 badge: 形式露出来。
        const tags = Array.isArray(m.tags)
          ? m.tags.filter((tag) => !/^badge:/.test(String(tag)))
          : [];
        if (promo.badge) {
          tags.push(`badge:${promo.badge}${promo.badgeColor ? `:${promo.badgeColor}` : ''}`);
        }
        /*
         * 档位：只在目录说"支持推理"时才给。
         *   1. 上游给了 `reasoning.supportedEfforts`（官方 GUI 的档位表）→ 原样用；
         *   2. 没给（老账号 / 老目录）→ 退回按 id 的实测表；
         *   3. 实测表也没有 → 默认低/中/高。
         * **空数组也要发**：那是"实测一个档都不收"（如网关暂时不接的 claude-*），
         * 插件看到空数组就不声明推理 —— 选择器不显示一个必然失败的控件。
         */
        const upstreamEfforts = Array.isArray(m.reasoningEfforts) && m.reasoningEfforts.length
          ? m.reasoningEfforts
          : null;
        const efforts = m.supportsReasoning ? (upstreamEfforts || effortsFor(m.id)) : null;
        const defaultEffort = typeof m.defaultReasoningEffort === 'string'
          && Array.isArray(efforts) && efforts.includes(m.defaultReasoningEffort)
          ? m.defaultReasoningEffort
          : '';
        const contextWindow = contextWindowForModel(m);
        return {
          id: m.id,
          object: 'model',
          created: Math.floor(Date.now() / 1000),
          owned_by: 'workbuddy',
          ...(m.name ? { name: m.name } : {}),
          ...(contextWindow ? { context_window: contextWindow } : {}),
          // 官方 GUI 的上下文档位（默认 + 可选）；dsh 只消费 context_window，
          // 面板用这两个字段显示"默认 300K / 可选 300K·600K·1M"。
          ...(m.contextDefault ? { context_window_default: m.contextDefault } : {}),
          ...(Array.isArray(m.contextOptions) && m.contextOptions.length
            ? { context_window_options: m.contextOptions }
            : {}),
          ...(m.context ? { context_window_max: m.context } : {}),
          ...(m.maxOutput ? { max_output_tokens: m.maxOutput } : {}),
          // 兼容别名：不同客户端读不同的字段名（Claude Code 读 context_length /
          // max_input_tokens，Roo 读 max_tokens）。值与上一行保持同源，不另算一套。
          ...(contextWindow ? { context_length: contextWindow, max_input_tokens: contextWindow } : {}),
          ...(m.maxOutput ? { max_tokens: m.maxOutput } : {}),
          capabilities: {
            vision: m.images === true,
            tools: m.supportsToolCall !== false,
            reasoning: m.supportsReasoning === true,
          },
          architecture: { input_modalities: m.images ? ['text', 'image'] : ['text'] },
          ...(typeof credits === 'number' ? { credits } : {}),
          ...(m.images ? { supports_images: true } : {}),
          ...(m.supportsReasoning ? { supports_reasoning: true } : {}),
          ...(Array.isArray(efforts) ? { reasoning_efforts: efforts } : {}),
          ...(defaultEffort ? { default_reasoning_effort: defaultEffort } : {}),
          // 来源必须能分辨三种：官方目录给了 → upstream；按 id 实测过 → measured；
          // 两者都没有、只能用默认三档 → fallback。面板据此决定是否标「实测档位」。
          ...(Array.isArray(efforts)
            ? {
              reasoning_efforts_source: upstreamEfforts
                ? 'upstream'
                : (REASONING_EFFORTS_BY_MODEL[m.id] ? 'measured' : 'fallback'),
            }
            : {}),
          ...(Number.isFinite(m.defaultTemperature) ? { default_temperature: m.defaultTemperature } : {}),
          ...(m.canDisableThinking ? { can_disable_thinking: true } : {}),
          ...(m.onlyReasoning ? { only_reasoning: true } : {}),
          ...(m.official === true ? { official: true } : m.official === false ? { official: false } : {}),
          ...(m.supplemented ? { supplemented: true } : {}),
          ...(m.vendor ? { vendor: m.vendor } : {}),
          ...(tags.length ? { tags } : {}),
          ...(m.descriptionZh ? { description_zh: m.descriptionZh } : {}),
          ...(m.descriptionEn ? { description_en: m.descriptionEn } : {}),
          ...(promo.badge ? { badge: promo.badge } : {}),
          ...(promo.free ? { free: true } : {}),
          ...(promo.promotionActive ? { promotion_active: true } : {}),
          ...(promo.promotionText ? { promotion_text: promo.promotionText } : {}),
          ...(promo.promotionTextEn ? { promotion_text_en: promo.promotionTextEn } : {}),
          ...(promo.promotionUntil ? { promotion_until: promo.promotionUntil } : {}),
          ...(Number.isFinite(promo.promotionFactor) ? { promotion_factor: promo.promotionFactor } : {}),
        };
      });
      // staleMs 只在「刷新失败、退回过期缓存」时出现；成功时不带这个字段
      return json(res, 200, { object: 'list', data: list, ...(staleMs !== null ? { staleMs } : {}) });
    }

    if (url.pathname === '/v1/quota') {
      try {
        /*
         * 把「这份余额属于哪个账号」一并带回。
         *
         * 控制台/插件都有自己的积分缓存；换号后如果只比余额数字，根本看不出
         * 旧账号的值还挂着（issue #6 的「账号新、余额旧」）。带 account 后，
         * 缓存可以按身份作废，而不是靠某个进程记得去 invalidate。
         */
        const auth = await resolveAuth();
        const quota = await fetchQuota(auth);
        return json(res, 200, {
          ok: true,
          ...quota,
          account: auth.userId || auth.uid || '',
          source: auth.source,
          // 账实核对：最近 7 天的余额快照 + 采集间隔。页面用首尾快照对比
          // 本地账本；不足两条时显示“—”，不拿单点冒充变化。
          history: readQuotaHistory(7),
          snapshotIntervalMs: QUOTA_SNAPSHOT_INTERVAL_MS,
        });
      } catch (e) {
        return json(res, 502, { ok: false, error: e.message });
      }
    }

    if (url.pathname === '/v1/usage') {
      if (req.method === 'DELETE') {
        try {
          resetUsageLedger();
          return json(res, 200, { ok: true, cleared: true });
        } catch (e) {
          return json(res, 500, { ok: false, error: e.message });
        }
      }
      const days = Math.min(Math.max(Number(url.searchParams.get('days')) || 7, 1), 90);
      const hours = url.searchParams.get('hours') === '1';
      return json(res, 200, { ok: true, ...summarizeUsage(days, { hours }) });
    }

    if (url.pathname === '/v1/requests') {
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 500);
      // 进行中的请求（卡死可见性）：只报告，不干预 —— 本桥没有任何默认超时。
      const active = [...inflight.values()].map((r) => ({ ...r, runningMs: Date.now() - r.startedAt }));
      return json(res, 200, { ok: true, requests: recentRequests(limit), active, activeAlertMs: ACTIVE_ALERT_MS });
    }

    if (url.pathname === '/v1/checkin') {
      try {
        const auth = await resolveAuth();
        if (req.method === 'POST') {
          const claim = await claimDailyCheckin(auth);
          const status = await fetchCheckinStatus(auth).catch(() => null);
          return json(res, 200, { ...claim, status });
        }
        return json(res, 200, { ok: true, status: await fetchCheckinStatus(auth) });
      } catch (e) {
        return json(res, 502, { ok: false, error: e.message });
      }
    }

    // ── Miora 媒体生成（计费能力，提交是异步的）─────────────────────────
    if (url.pathname === '/v1/videos' && req.method === 'POST') {
      return handleVideoSubmit(req, res);
    }
    if (url.pathname.startsWith('/v1/videos/') && req.method === 'GET') {
      return handleVideoLookup(req, res, url.pathname, url);
    }
    if (url.pathname === '/v1/images/generations' && req.method === 'POST') {
      return handleOpenAIImagesGenerations(req, res);
    }
    if (url.pathname === '/v1/images' && req.method === 'POST') {
      return handleImageGenerate(req, res);
    }
    if (url.pathname === '/v1/images/edits' && req.method === 'POST') {
      return handleImageEdit(req, res);
    }
    if (url.pathname.startsWith('/v1/images/') && url.pathname !== '/v1/images/edits' && req.method === 'GET') {
      return handleImageLookup(req, res, url.pathname, url);
    }

    // ── WorkBuddy 原生网页搜索（不经过 DeepSeek）────────────────────────
    if (url.pathname === '/v1/web_search' && req.method === 'POST') {
      let raw;
      try {
        raw = await readBody(req, 64 * 1024);
      } catch (e) {
        if (e.code === 'BODY_TOO_LARGE') {
          return rejectTooLarge(req, res, 'openai', 'web_search body too large');
        }
        throw e;
      }
      let body;
      try { body = JSON.parse(raw); }
      catch { return json(res, 400, { error: { message: 'invalid JSON body', type: 'invalid_request' } }); }
      const query = typeof body?.query === 'string' ? body.query.trim() : '';
      if (query.length < 2) {
        return json(res, 400, { error: { message: 'workbuddy-bridge: "query" must be at least 2 characters', type: 'invalid_request' } });
      }
      if (query.length > 4000) {
        return json(res, 400, { error: { message: 'workbuddy-bridge: "query" is too long (max 4000)', type: 'invalid_request' } });
      }
      if (body?.freshness !== undefined && !SEARCH_FRESHNESS_RE.test(String(body.freshness))) {
        return json(res, 400, {
          error: {
            message: 'workbuddy-bridge: "freshness" must be d/d1..d30, m/m1..m12 or y/y1..y5',
            type: 'invalid_request',
          },
        });
      }
      let maxResults = 5;
      if (body?.max_results !== undefined) {
        const n = Number(body.max_results);
        if (!Number.isInteger(n) || n < 1 || n > SEARCH_MAX_RESULTS) {
          return json(res, 400, {
            error: {
              message: `workbuddy-bridge: "max_results" must be an integer 1-${SEARCH_MAX_RESULTS}`,
              type: 'invalid_request',
            },
          });
        }
        maxResults = n;
      }
      const startedAt = Date.now();
      const ac = new AbortController();
      req.on('aborted', () => ac.abort());
      res.on('close', () => { if (!res.writableEnded) ac.abort(); });
      try {
        await acquireRateSlot(ac.signal, requestScope.getStore()?.client || 'local');
        const search = await workbuddySearch(
          {
            query,
            maxResults,
            allowedDomains: body?.allowed_domains,
            freshness: body?.freshness,
          },
          { conversationId: req.headers['x-conversation-id'] || trace(), signal: ac.signal },
        );
        recordRequest({
          model: 'web-search', kind: 'search', stream: false, ms: Date.now() - startedAt,
          ok: true, status: 200, code: null,
        });
        log(`web_search results=${search.results.length} provider=${search.provider || '-'} ms=${Date.now() - startedAt}`);
        return json(res, 200, {
          object: 'web_search',
          query,
          provider: search.provider,
          results: search.results,
          total_results: search.total_results,
          response_time_ms: search.response_time_ms,
          truncated: search.truncated,
        });
      } catch (e) {
        if (e?.code === 'RATE_LIMIT_ABORTED' || e?.code === 'WEB_SEARCH_ABORTED' || ac.signal.aborted) return;
        const rateLimited = e?.code === 'RATE_LIMITED' || e?.code === 'WEB_SEARCH_RATE_LIMITED';
        const status = rateLimited ? 429 : (Number(e?.status) || (e?.code === 'WEB_SEARCH_TIMEOUT' ? 504 : 502));
        recordRequest({
          model: 'web-search', kind: 'search', stream: false, ms: Date.now() - startedAt,
          ok: false, status, code: e?.code || null, error: e?.message || String(e),
        });
        log('web_search failed', status, e?.code || '', shortError(e?.message || e, 200));
        const retryAfter = (rateLimited || status === 429)
          ? Math.max(1, Math.ceil((e?.retryAfterMs || (rateLimited ? 1000 : 5000)) / 1000))
          : 0;
        return json(res, status, {
          error: {
            message: `workbuddy-bridge: ${shortError(e?.message || e, 300)}`,
            type: rateLimited ? 'rate_limit_error' : 'web_search_error',
            code: e?.code || 'WEB_SEARCH_ERROR',
          },
        }, retryAfter ? { 'Retry-After': String(retryAfter) } : {});
      }
    }

    if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
      let raw;
      try {
        raw = await readBody(req);
      } catch (e) {
        if (e.code === 'BODY_TOO_LARGE') {
          // 明确的 413 + JSON：客户端要能一眼分清「请求太大」和「JSON 写错了」，
          // 这两种 400 类失败的处置方式完全不同。这里**不记账**是对的 ——
          // 连 body 都没读全，没有 model / 耗时可言，记一条全是 0 的账只会污染
          // 控制台的失败列表。
          log('rejected oversized body', e.message);
          /*
           * 413 写完后 `resume()` 把剩余字节读掉丢弃（helper 内统一做）。
           *
           * **不要改成 destroy()**：实测这样会让客户端在读到 413 之前就吃 RST
           * （8MB 下丢失率可达 10/10，详见 readBody 的注释）。resume() 之后
           * 没有任何东西被累计进内存，D2 的内存上限目标依然成立，而契约
           * （"明确的 413 JSON"）才真的兑现了。
           */
          return rejectTooLarge(req, res, 'openai',
            `workbuddy-bridge: request body too large (limit ${MAX_BODY_BYTES} bytes);`
              + ' raise WORKBUDDY_MAX_BODY_BYTES if this is a legitimate multi-modal request');
        }
        throw e;
      }
      let payload;
      try { payload = JSON.parse(raw); } catch { return json(res, 400, { error: { message: 'invalid JSON body' } }); }
      const wantStream = payload.stream === true;
      // model 的类型与长度必须**先收敛**：它是客户端可控字段，会进账本、进日志、
      // 还会被原样回显（见 MAX_MODEL_ID_LEN 的说明）。数组/对象/数字/布尔一律拒绝
      // —— 否则类型混淆会让"长度"判断失效（如数组的 length 是元素个数），而且
      // 静默换成默认模型等于"替用户换了个要计费的模型"，比直接报错更糟。
      // `null` 与缺省视同"没给"（沿用原有的回落行为），不当成类型错误。
      if (payload.model != null && typeof payload.model !== 'string') {
        return json(res, 400, { error: { message: 'workbuddy-bridge: "model" must be a string', type: 'invalid_request' } });
      }
      const model = payload.model || 'deepseek-v4.1-flash';
      if (model.length > MAX_MODEL_ID_LEN) {
        const message = `workbuddy-bridge: model id too long (${model.length} chars, max ${MAX_MODEL_ID_LEN})`;
        // 落账与日志都只留**截断版**：账本行必须有界，也绝不把这段垃圾原样回显
        const trimmed = shortError(model, MAX_MODEL_ID_LEN);
        log('rejected oversized model id', trimmed);
        recordRequest({
          model: trimmed, stream: wantStream, ms: 0, ok: false, status: 400, code: null, error: message,
        });
        return json(res, 400, { error: { message, type: 'invalid_request' } });
      }

      // 字符集校验：模型 id 会进 `X-Model-ID` 请求头，非可见 ASCII 会让
      // Node 的 http.request 直接抛异常（外层只能回 500）。见 HEADER_SAFE_RE 的说明。
      // **放在 preflightModelError 之前**：这是格式错误，与目录无关，任何时候都该拦。
      if (!HEADER_SAFE_RE.test(model)) {
        const message = 'workbuddy-bridge: model id must be printable ASCII'
          + ' (it is forwarded as the X-Model-ID header)';
        const trimmed = shortError(model, MAX_MODEL_ID_LEN);
        log('rejected non-ascii model id', trimmed);
        // 与其它拒绝路径一致地落账：否则这次拒绝在控制台「最近请求」里不可见
        recordRequest({
          model: trimmed, stream: wantStream, ms: 0, ok: false, status: 400, code: null, error: message,
        });
        return json(res, 400, { error: { message, type: 'invalid_request' } });
      }

      // 模型预校验：桥手里就有目录，拼错的 id 不该花一次上游往返（详见
      // preflightModelError 的注释）。放在 maybeAutoCheckin 之前是刻意的 ——
      // 一次注定失败的调用不该顺带触发签到。
      // 工具名是上游确定性拒绝的字段：本地先拦，省一次上游往返并指出具体工具。
      const toolError = toolNameError(payload.tools);
      if (toolError) {
        const message = `workbuddy-bridge: ${toolError}`;
        log('rejected invalid tool name', toolError);
        recordRequest({
          model, stream: wantStream, ms: 0, ok: false, status: 400, code: null, error: message,
        });
        return json(res, 400, { error: { message, type: 'invalid_request' } });
      }

      const modelError = preflightModelError(model);
      if (modelError) {
        log('rejected unknown model', model);
        // **必须落账**：否则这次拒绝在控制台「最近请求」里完全不可见，用户
        // 看到的是一个客户端报错、而账本上什么都没有，只能去翻原始日志 ——
        // 这正是 D3 想解决的场景，不记等于白改。
        recordRequest({
          model,
          stream: wantStream,
          ms: 0,
          ok: false,
          status: 404,
          code: 'model_not_found',
          error: modelError,
        });
        return json(res, 404, { error: { message: modelError, type: 'model_not_found' } });
      }

      // 每日自动签到：**先转发、后台补签**。放在这里是因为「有人调模型」
      // 就是「在用」的最强信号；不 await，绝不拖慢这次请求。
      maybeAutoCheckin();
      // diagnostics: log request shape only, never conversation content
      if (process.env.WORKBUDDY_SHAPE === '1') {
        const roles = {};
        let chars = 0;
        for (const m of payload.messages || []) {
          roles[m.role] = (roles[m.role] || 0) + 1;
          chars += JSON.stringify(m.content ?? '').length;
        }
        const sys = (payload.messages || []).find((m) => m.role === 'system' || m.role === 'developer');
        const hdrs = Object.keys(req.headers).sort();
        log('SHAPE ' + JSON.stringify({
          bodyKeys: Object.keys(payload).sort(),
          model, stream: payload.stream,
          roles, chars,
          sysChars: typeof sys?.content === 'string' ? sys.content.length : null,
          toolCount: payload.tools?.length ?? 0,
          toolNames: (payload.tools || []).map((t) => t?.function?.name).slice(0, 40),
          headers: hdrs,
          ua: req.headers['user-agent'],
        }));
      }
      log(`→ ${model} stream=${wantStream} msgs=${payload.messages?.length ?? 0} tools=${payload.tools?.length ?? 0}`);
      const startedAt = Date.now();
      trackInflight(req, res, model, wantStream);

      // the backend is streaming-only: always stream upstream, aggregate for non-streaming clients
      const upstream = applyVisionDegrade(
        normalizePayload({ ...payload, stream: true, stream_options: { include_usage: true } }),
        model,
      );
      /*
       * `max_completion_tokens` 是**新式写法**（OpenAI 现行字段），上游 Go 结构体只认
       * `max_tokens`。原先这里直接 `delete` —— 于是客户端给的**输出上限静默消失**：
       * 它预算了 500 token，实际拿到的是一次**无上限**的回合（模型跑自己的默认值）。
       * 而 `max_tokens` 是原样转发的，两种写法行为完全不同，用户只会觉得"设了没用"。
       *
       * 正确做法是**翻译**而不是丢弃：两个都给时以 `max_tokens` 为准（保留原注释
       * 里"避免语义冲突"的意图），只给新式字段时把它挪过去，然后再删掉旧键。
       */
      if (upstream.max_completion_tokens != null && upstream.max_tokens == null) {
        upstream.max_tokens = upstream.max_completion_tokens;
      }
      delete upstream.max_completion_tokens;
      /*
       * 思考档位按**实测表**校验：目录里声明了 reasoning_efforts，请求侧却从不检查，
       * 于是客户端发来目录外的值（老客户端写死三档、curl 直接写 off/none、
       * 本地表比上游旧）必然吃 400 `invalid_reasoning_effort`。这类 400 被
       * DETERMINISTIC_400_CODES 判成"确定性拒绝、不重试"，用户只能看到
       * "不支持该思考强度"这类无从下手的错误。
       *
       * 只对**表里明确测过**的模型动手：不在表里的模型（新模型）保持原样 ——
       * 没有实测数据时擅自删参数，等于把用户的选择静默吞掉。
       */
      if (upstream.reasoning_effort != null) {
        const measured = REASONING_EFFORTS_BY_MODEL[model];
        if (Array.isArray(measured) && !measured.includes(String(upstream.reasoning_effort))) {
          log(`drop unsupported reasoning_effort=${upstream.reasoning_effort} model=${model} (measured: ${measured.join('/') || 'none'})`);
          delete upstream.reasoning_effort;
        }
      }
      const conv = resolveConversationId(req, upstream);
      const conversationId = conv.id;
      if (conv.source !== 'client') {
        log(`conversation id: source=${conv.source} id=${conversationId.slice(0, 8)}…`);
      }

      const ac = new AbortController();
      req.on('aborted', () => ac.abort());
      res.on('close', () => { if (!res.writableEnded) ac.abort(); });

      // 从这一刻起的任何异常都要落账：否则「登录文件坏了 / 取密钥失败」这类故障
      // 在控制台上完全不可见（只有原始日志里有），用户只能看到一个 500。
      try {
        const attempt = await callUpstreamWithChannelFallback(upstream, model, conversationId, ac.signal);
        const up = attempt.res;
        const upstreamStartedAt = attempt.upstreamStartedAt;
        const text = attempt.bodyText ?? (up.ok ? '' : await up.text().catch(() => ''));
        const parsed = attempt.parsed;
        const fallbackInfo = channelAttemptMeta(attempt, up);
        if (attempt.fallback) res.setHeader(CHANNEL_FALLBACK_HEADER, attempt.fallback);
        if (!up.ok) {
          log('upstream error', up.status, text.slice(0, 300));
          const channelRejected = attempt.channelRejected === true;
          const upstreamMessage = upstreamErrorText(parsed, text, up);
          recordRequest({
            model,
            stream: wantStream,
            ms: Date.now() - startedAt,
            ok: false,
            status: up.status,
            code: upstreamLedgerCode(parsed),
            error: channelRejected ? channelRejectedMessage(attempt) : upstreamMessage,
            overheadMs: Math.max(0, upstreamStartedAt - startedAt),
            ...fallbackInfo,
          });
          /*
           * 错误体必须包成 OpenAI 的 `{ error: { message, type, code } }`。
           *
           * 原先这条路径**原样透传**上游的 `{code, msg}`：按 OpenAI 规范读
           * `error.message` 的客户端拿不到内容，只剩一个状态码或整段原始 JSON。
           * 另两条路径（Anthropic / Responses）早就包好了正确形状。
           *
           * 上游 401/403 也不能原样回 401：调用方会以为**本地桥的令牌**错了，
           * 实际是上游登录态失效。回 502 + 明确文案，修法只有一个 ——
           * 在 WorkBuddy 桌面端重新登录。
           */
          const extCode = upstreamErrorCode(parsed);
          const authFailure = upstreamAuthFailure(up);
          return json(res, up.status === 200 || authFailure ? 502 : up.status, {
            error: {
              message: authFailure
                ? upstreamAuthMessage(parsed)
                : channelRejected
                  ? channelRejectedMessage(attempt)
                  : `workbuddy-bridge: upstream ${up.status}: ${upstreamMessage}`,
              type: authFailure
                ? 'upstream_auth_error'
                : channelRejected
                  ? 'upstream_channel_error'
                  : (up.status === 429 ? 'rate_limit_error' : 'upstream_error'),
              ...(channelRejected ? { code: 'CHANNEL_REJECTED' } : (extCode ? { code: extCode } : {})),
            },
          });
        }

        if (wantStream) {
          res.__overheadMs = Math.max(0, upstreamStartedAt - startedAt);
          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
            ...SECURITY_HEADERS,
          });
          const reader = up.body.getReader();
          const decoder = new TextDecoder();
          let usageSeen = null;
          /*
           * 首字节时刻：用户感知的"多久开始出字"。
           * 与 `X-WorkBuddy-Overhead-Ms`（桥前置处理）和总耗时一起落账后，
           * 才能区分"上游排队/预填充慢"与"桥自己慢"。
           */
          let firstChunkAt = 0;
          let streamError = null;
          /*
           * 「这一轮到底跑完了没有」—— 与非流式路径（`aggregateStream` 的
           * `completed`）用同一套判据：`finish_reason` / `[DONE]` / 完整工具调用。
           *
           * 旧实现只跟踪 `usage`，于是**干净半关**被当成了成功：上游吐几段内容后
           * 正常收尾（代理超时、chunked 结束、网关省略 `[DONE]`），客户端看到的是
           * 一个干净的 EOF；dsh 适配器据此判 `stop` —— 用户看到半句话就停，
           * 既不报错也不重试。非流式路径早就修过这个坑，流式才是真实流量。
           */
          let sawDone = false;
          let sawFinish = false;
          let sawToolCall = false;

          /*
           * 流式帧归一（`WORKBUDDY_SSE_NORMALIZE=0` 可整段关掉）。
           *
           * 上游是能跑的，但它的帧不是所有客户端都吃得下：
           *   - Cline 在 `choices[0].delta` 缺失时直接 `reading 'type'` 崩（#939）；
           *   - Cherry Studio 会把逐字符的 `reasoning_content` 当成一个个独立
           *     思考块（issue #9），这里把 reasoning 聚合到内容/工具/终止帧前
           *     一次性发出；
           *   - 顺手补齐缺失的 `delta`，不改 content/tool 的顺序与内容。
           *
           * 按 **SSE block**（空行分隔）处理，而不是按行/按字节：块边界是协议
           * 语义，拆行会把一个事件拆散。没有 data 的注释块原样透传。
           */
          const normalizeSse = process.env.WORKBUDDY_SSE_NORMALIZE !== '0';
          let sseBuf = '';
          let reasoningBuf = '';
          let chunkMeta = null;
          const writeOut = async (text) => {
            // 背压：写不动就等排空，别把上游的数据堆进内存（见 waitDrain）。
            if (!res.write(text)) await waitDrain(res);
          };
          const flushReasoning = async () => {
            if (!reasoningBuf) return;
            const obj = {
              id: chunkMeta?.id || 'chatcmpl-bridge',
              object: 'chat.completion.chunk',
              created: chunkMeta?.created || Math.floor(Date.now() / 1000),
              ...(chunkMeta?.model ? { model: chunkMeta.model } : {}),
              choices: [{ index: 0, delta: { reasoning_content: reasoningBuf }, finish_reason: null }],
            };
            reasoningBuf = '';
            await writeOut(`data: ${JSON.stringify(obj)}\n\n`);
          };
          const inspectBlock = (block) => {
            const dataLine = block.split('\n').find((line) => line.startsWith('data:'));
            if (!dataLine) return;
            const raw = dataLine.slice(5).trim();
            if (!raw) return;
            if (raw === '[DONE]') { sawDone = true; return; }
            // 只解析可能带终止/用量信息的块；纯内容帧不值得逐块 JSON.parse。
            if (!raw.includes('"usage"') && !raw.includes('"finish_reason"') && !raw.includes('"tool_calls"')) return;
            try {
              const j = JSON.parse(raw);
              if (j.usage) usageSeen = j.usage; // 最后一帧的 usage 胜出
              const choice = j.choices?.[0];
              if (choice?.finish_reason) sawFinish = true;
              if (Array.isArray(choice?.delta?.tool_calls) && choice.delta.tool_calls.length) sawToolCall = true;
            } catch { /* 半截帧，忽略 */ }
          };
          const normalizeBlock = (block) => {
            const lines = block.split('\n');
            const dataIdx = lines.findIndex((line) => line.startsWith('data:'));
            if (dataIdx < 0) return block;
            const raw = lines[dataIdx].slice(5).trim();
            if (!raw || raw === '[DONE]') return block;
            let j;
            try { j = JSON.parse(raw); } catch { return block; }
            if (!chunkMeta && j && typeof j === 'object') {
              chunkMeta = { id: j.id, created: j.created, model: j.model };
            }
            if (!Array.isArray(j?.choices) || !j.choices.length) return block;

            let hasNonReasoning = false;
            for (const choice of j.choices) {
              if (!choice || typeof choice !== 'object') continue;
              if (!choice.delta || typeof choice.delta !== 'object') {
                // Cline #939：没有 delta 时客户端直接崩；把顶层 content 挪进去。
                choice.delta = {};
                if (typeof choice.content === 'string') {
                  choice.delta.content = choice.content;
                  delete choice.content;
                }
              }
              /*
               * 上游每帧都会带一堆**空占位**（实测 deepseek-v4.1-flash）：
               *   {"content":"","reasoning_content":"We","function_call":null,
               *    "refusal":"","tool_calls":[],"extra_fields":null}
               * Cherry Studio 的 @ai-sdk/openai-compatible 把 `tool_calls != null`
               * 当成“reasoning 段结束”，空数组 `[]` 也满足——于是每个字符都被切成
               * 一个独立思考块（issue #9）。桥在转发前剔掉空占位，既修 Cherry，
               * 也不影响其它客户端（它们本来就忽略空数组）。
               */
              for (const key of Object.keys(choice.delta)) {
                const value = choice.delta[key];
                const emptyToolCalls = key === 'tool_calls' && Array.isArray(value) && value.length === 0;
                const emptyText = (key === 'content' || key === 'reasoning_content' || key === 'refusal')
                  && value === '';
                const nullPlaceholder = (key === 'function_call' || key === 'extra_fields')
                  && (value === null || value === undefined);
                if (emptyToolCalls || emptyText || nullPlaceholder) delete choice.delta[key];
              }
              if (typeof choice.delta.reasoning_content === 'string' && choice.delta.reasoning_content) {
                reasoningBuf += choice.delta.reasoning_content;
                delete choice.delta.reasoning_content;
              }
              if (Object.keys(choice.delta).length || choice.finish_reason) hasNonReasoning = true;
            }
            // 纯 reasoning 帧先扣住，等正文/工具/终止帧来了再合并发出。
            if (!hasNonReasoning) return null;
            lines[dataIdx] = `data: ${JSON.stringify(j)}`;
            return lines.join('\n');
          };
          const handleBlock = async (block) => {
            inspectBlock(block);
            if (!normalizeSse) {
              await writeOut(`${block}\n\n`);
              return;
            }
            const next = normalizeBlock(block);
            if (next === null) return;
            if (reasoningBuf) await flushReasoning();
            await writeOut(`${next}\n\n`);
          };

          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              if (!firstChunkAt) firstChunkAt = Date.now();
              sseBuf += decoder.decode(value, { stream: true });
              const blocks = sseBuf.split('\n\n');
              sseBuf = blocks.pop() ?? '';
              for (const block of blocks) await handleBlock(block);
              // 上游若不按空行收尾，别让缓冲无限增长（异常流保护）
              if (sseBuf.length > 200000) sseBuf = sseBuf.slice(-4096);
            }
            // 最后一个块可能没有结尾空行
            if (sseBuf.trim()) await handleBlock(sseBuf);
            if (reasoningBuf) await flushReasoning();
          } catch (e) {
            streamError = e;
            log('stream interrupted', e.message);
          }
          const aborted = ac.signal.aborted;
          if (!streamError && !aborted && !(sawDone || sawFinish || sawToolCall)) {
            streamError = new Error('upstream stream ended before completion (no finish_reason / [DONE])');
            log('stream ended without a completion signal, reporting as failure');
          }
          // 上游在流中途断了（连接被掐 / 网络故障）**不是成功**：客户端的回答
          // 已被截断，账本要如实记一笔失败，否则「回答为什么少了一半」在控制台上
          // 完全不可见 —— 与非流式路径的处理保持一致（那里同样记 ok:false）。
          //
          // 客户端自己断开（用户点了停止 / 关了页面）不是失败的另一种：请求已经
          // 服务过了，照旧记成功。用 ac.signal.aborted 区分这两者。
          if (streamError && !aborted) {
            recordRequest({
              model,
              stream: true,
              ms: Date.now() - startedAt,
              ok: false,
              status: 0,
              code: null,
              error: streamError.message,
              overheadMs: Math.max(0, upstreamStartedAt - startedAt),
              ...(firstChunkAt ? { ttfbMs: firstChunkAt - startedAt } : {}),
              ...fallbackInfo,
            });
            /*
             * ⚠️ **截断必须让客户端知道**，不能只记一笔账就 `res.end()`。
             *
             * 原先这条路径**一个字节都不写**就结束响应：客户端在 200 事件流上看到
             * 一个干净的 EOF。dsh 的适配器据此判定"上游说完了"（
             * `mapFinishReason(undefined, sawToolCall, sawContent)` 在**有内容**时
             * 返回 `{kind:'stop'}`），于是 agent 被告知"这一轮正常完成" ——
             * 用户看到的就是**说话说一半突然停下**，既不报错也不重试。
             *
             * 另两条路径早就修过同一个坑（Anthropic 发 `event: error`、Responses 发
             * `response.failed`，注释里都写着"绝不能伪装成干净回合"），只有 chat
             * 这条漏了。日志取证：`stream interrupted` 在这条路径上有 21 条，
             * 另两条各 0 条 —— 说明真实流量就在走这里。
             *
             * OpenAI 的流式协议里表达"出错"就是发一个 `error` 对象再 `[DONE]`；
             * 客户端（含本项目自己的适配器）认它并按错误处理。
             */
            if (!res.writableEnded) {
              try {
                res.write(`data: ${JSON.stringify({
                  error: {
                    // 已经自带 "upstream stream …" 前缀的消息（干净半关那条）原样用，
                    // 免得写成 "interrupted …: upstream stream ended …" 这种叠词
                    message: /^upstream stream/i.test(streamError.message)
                      ? `workbuddy-bridge: ${streamError.message}`
                      : `workbuddy-bridge: upstream stream interrupted before completion: ${streamError.message}`,
                    type: 'upstream_error',
                  },
                })}\n\n`);
                res.write('data: [DONE]\n\n');
              } catch { /* 客户端已经走了：写不进去也没关系 */ }
            }
          } else {
            recordRequest({
              model,
              stream: true,
              ok: true,
              ms: Date.now() - startedAt,
              overheadMs: Math.max(0, upstreamStartedAt - startedAt),
              ...(firstChunkAt ? { ttfbMs: firstChunkAt - startedAt } : {}),
              ...usageOf(usageSeen),
              ...fallbackInfo,
            });
          }
          return res.end();
        }

        const aggregated = await aggregateStream(up);
        res.__overheadMs = Math.max(0, upstreamStartedAt - startedAt);
        /*
         * 上游回 200 但一个 SSE 块都没解析出来 → 这不是「空回答」，是失败。
         * 典型场景：网关把错误包成 200 的 HTML。原先这里无条件记 ok:true 并回 200，
         * 用户看到空白回答、控制台把它算作成功 —— 静默错数据。
         */
        /*
         * 上游在吐了内容之后**干净地半关**（没有 finish_reason / usage / [DONE]）
         * 同样是失败，不能报成"完整回答"。
         *
         * 与上面 `parsed === 0`（根本不是 SSE）是**两条不同的**判据：
         * `parsed > 0` 只说明解析出了 SSE 块。实测：只喂一帧 content 然后干净 EOF →
         * `parsed=1, finish_reason="stop"`，客户端拿到半句却以为说完了、不重试，
         * 账本还记成 ok:true 的 0/0 tokens 健康记录。
         */
        if (!aggregated.parsed || aggregated.completed === false) {
          const reason = !aggregated.parsed
            ? 'upstream returned 200 but no parseable SSE data'
            : 'upstream stream ended before completion (no finish_reason / usage / [DONE])';
          recordRequest({
            model,
            stream: false,
            ms: Date.now() - startedAt,
            ok: false,
            status: up.status,
            code: null,
            error: reason,
            overheadMs: Math.max(0, upstreamStartedAt - startedAt),
            ...fallbackInfo,
          });
          return json(res, 502, {
            error: {
              message: `workbuddy-bridge: ${reason}`,
              type: 'upstream_error',
            },
          });
        }
        recordRequest({
          model,
          stream: false,
          ok: true,
          ms: Date.now() - startedAt,
          overheadMs: Math.max(0, upstreamStartedAt - startedAt),
          ...usageOf(aggregated.usage),
          ...fallbackInfo,
        });
        return json(res, 200, aggregated);
      } catch (e) {
        if (handleUpstreamTimeout(res, 'openai', e)) {
          recordRequest({
            model, stream: wantStream, ms: Date.now() - startedAt, ok: false,
            status: 504, code: null, error: e.message,
          });
          return;
        }
        if (e?.code === 'RATE_LIMITED') {
          const retryAfter = Math.max(1, Math.ceil((e.retryAfterMs || 1000) / 1000));
          recordRequest({ model, stream: wantStream, ms: Date.now() - startedAt, ok: false, status: 429, code: null, error: `rate_limited (retry in ${retryAfter}s)` });
          return json(res, 429, { error: { type: 'rate_limit_error', message: e.message } }, { 'Retry-After': String(retryAfter) });
        }
        if (e?.code === 'RATE_LIMIT_ABORTED') {
          // 客户端在队列里等待时断开：没打到上游、也没发出任何响应，不记账
          return;
        }
        recordRequest({
          model,
          stream: wantStream,
          ms: Date.now() - startedAt,
          ok: false,
          status: 0,
          code: null,
          error: e.message,
        });
        throw e; // 交给外层统一回 500
      }
    }

    // ── Anthropic count_tokens（Claude Code 用它显示上下文占用）───────────
    // 纯本地**估算**（上游没有 tokenizer 端点，口径见 estimateTokens 注释）；
    // 不打上游、不记账 —— 这个端点随输入变化频繁调用，转上游纯属烧额度。
    if (url.pathname === '/v1/messages/count_tokens' && req.method === 'POST') {
      let raw;
      try {
        raw = await readBody(req);
      } catch (e) {
        if (e.code === 'BODY_TOO_LARGE') {
          return rejectTooLarge(req, res, 'anthropic');
        }
        throw e;
      }
      let body;
      try { body = JSON.parse(raw); }
      catch { return json(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'invalid JSON body' } }); }
      return json(res, 200, { input_tokens: estimateRequestTokens(body) });
    }

    // ── Anthropic Messages API（Claude Code 等）────────────────────────────
    if (url.pathname === '/v1/messages' && req.method === 'POST') {
      let raw;
      try {
        raw = await readBody(req);
      } catch (e) {
        if (e.code === 'BODY_TOO_LARGE') {
          // 同 /v1/web_search：先把剩余字节读掉，保证 413 后连接仍可复用。
          return rejectTooLarge(req, res, 'anthropic');
        }
        throw e;
      }
      let body;
      try { body = JSON.parse(raw); }
      catch { return json(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'invalid JSON body' } }); }

      /*
       * DeepSeek 的网页搜索 provider 会向 Messages API 发 `web_search_20250305`
       * 服务端工具。这里不转发给 chat 上游（那边没有这个能力），而是直接调用
       * WorkBuddy 的原生搜索端点，并回 Anthropic 的 web_search_tool_result。
       * dsh 的 provider 只解析这些结构化块，因此不需要伪造模型答案。
       */
      const nativeSearch = nativeSearchTool(body);
      if (nativeSearch) {
        /*
         * 这条兼容分支只服务 dsh provider 的非流式搜索调用。流式请求不能返回
         * JSON（客户端会把它当 SSE 解析），也不能伪造模型答案；明确 400 比
         * “结构不对的 200”安全。
         */
        if (body.stream === true) {
          return json(res, 400, {
            type: 'error',
            error: {
              type: 'invalid_request_error',
              message: 'workbuddy-bridge: native web search is non-streaming; send stream:false',
            },
          });
        }
        const query = extractNativeSearchQuery(body);
        if (query.length < 2 || query.length > 4000) {
          return json(res, 400, {
            type: 'error',
            error: { type: 'invalid_request_error', message: 'web search query must be 2-4000 characters' },
          });
        }
        // `max_uses` 是服务端工具可执行次数，不是结果条数；结果上限独立配置。
        const maxResults = SEARCH_DEFAULT_MAX_RESULTS;
        const startedAt = Date.now();
        const ac = new AbortController();
        req.on('aborted', () => ac.abort());
        res.on('close', () => { if (!res.writableEnded) ac.abort(); });
        try {
          await acquireRateSlot(ac.signal, requestScope.getStore()?.client || 'local');
          const search = await workbuddySearch(
            { query, maxResults },
            { conversationId: req.headers['x-conversation-id'] || trace(), signal: ac.signal },
          );
          recordRequest({
            model: 'web-search', kind: 'search', stream: false, ms: Date.now() - startedAt,
            ok: true, status: 200, code: null,
          });
          log(`web_search (anthropic) results=${search.results.length} provider=${search.provider || '-'} ms=${Date.now() - startedAt}`);
          return json(res, 200, anthropicSearchMessage(body.model || 'workbuddy-web-search', search, query));
        } catch (e) {
          if (e?.code === 'RATE_LIMIT_ABORTED' || e?.code === 'WEB_SEARCH_ABORTED' || ac.signal.aborted) return;
          const rateLimited = e?.code === 'RATE_LIMITED' || e?.code === 'WEB_SEARCH_RATE_LIMITED';
          const status = rateLimited ? 429 : (Number(e?.status) || (e?.code === 'WEB_SEARCH_TIMEOUT' ? 504 : 502));
          recordRequest({
            model: 'web-search', kind: 'search', stream: false, ms: Date.now() - startedAt,
            ok: false, status, code: e?.code || null, error: e?.message || String(e),
          });
          log('web_search (anthropic) failed', status, e?.code || '', shortError(e?.message || e, 200));
          const retryAfter = rateLimited
            ? Math.max(1, Math.ceil((e?.retryAfterMs || 1000) / 1000))
            : (status === 429 ? Math.max(1, Math.ceil((e?.retryAfterMs || 5000) / 1000)) : 0);
          return json(res, status, {
            type: 'error',
            error: {
              type: rateLimited ? 'rate_limit_error' : 'api_error',
              message: `workbuddy-bridge: ${shortError(e?.message || e, 300)}`,
              ...(e?.code ? { code: e.code } : {}),
            },
          }, retryAfter ? { 'Retry-After': String(retryAfter) } : {});
        }
      }

      // Anthropic 的 `stream` 缺省是 false（与 OpenAI 相反）
      const wantStream = body.stream === true;
      const model = resolveAnthropicModel(body.model);
      const messages = anthropicToOpenAIMessages(body);
      const tools = anthropicToolsToOpenAIMessages(body.tools);
      const toolChoice = anthropicToolChoiceToOpenAI(body.tool_choice);

      const oai = { model, messages, stream: true, stream_options: { include_usage: true } };
      if (tools) oai.tools = tools;
      if (toolChoice) oai.tool_choice = toolChoice;
      if (typeof body.max_tokens === 'number') oai.max_tokens = body.max_tokens;
      if (typeof body.temperature === 'number') oai.temperature = body.temperature;
      if (typeof body.top_p === 'number') oai.top_p = body.top_p;
      if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) oai.stop = body.stop_sequences;

      const toolError = toolNameError(tools);
      if (toolError) {
        const message = `workbuddy-bridge: ${toolError}`;
        log('rejected invalid tool name (anthropic)', toolError);
        recordRequest({
          model, stream: wantStream, ms: 0, ok: false, status: 400, code: null, error: message,
        });
        return json(res, 400, {
          type: 'error',
          error: { type: 'invalid_request_error', message },
        });
      }

      const modelError = preflightModelError(model);
      if (modelError) {
        log('rejected unknown model (anthropic)', model);
        recordRequest({
          model, stream: wantStream, ms: 0, ok: false, status: 404, code: 'model_not_found', error: modelError,
        });
        return json(res, 404, {
          type: 'error',
          error: { type: 'not_found_error', message: modelError },
        });
      }

      maybeAutoCheckin();
      log(`→ [anthropic] ${body.model || '(no model)'} => ${model} stream=${wantStream} msgs=${messages.length} tools=${tools?.length ?? 0}`);

      const startedAt = Date.now();
      trackInflight(req, res, model, wantStream);
      const ac = new AbortController();
      req.on('aborted', () => ac.abort());
      res.on('close', () => { if (!res.writableEnded) ac.abort(); });

      try {
        const upstreamPayload = applyVisionDegrade(normalizePayload(oai), model);
        const conv = resolveConversationId(req, upstreamPayload);
        if (conv.source !== 'client') {
          log(`conversation id: source=${conv.source} id=${conv.id.slice(0, 8)}…`);
        }
        const attempt = await callUpstreamWithChannelFallback(
          upstreamPayload,
          model,
          conv.id,
          ac.signal,
        );
        const up = attempt.res;
        const upstreamStartedAt = attempt.upstreamStartedAt;
        const text = attempt.bodyText ?? (up.ok ? '' : await up.text().catch(() => ''));
        const parsed = attempt.parsed;
        const fallbackInfo = channelAttemptMeta(attempt, up);
        if (attempt.fallback) res.setHeader(CHANNEL_FALLBACK_HEADER, attempt.fallback);
        if (!up.ok) {
          const authFailure = upstreamAuthFailure(up);
          const channelRejected = attempt.channelRejected === true;
          const message = authFailure
            ? upstreamAuthMessage(parsed)
            : channelRejected
              ? channelRejectedMessage(attempt)
              : upstreamErrorText(parsed, text, up);
          const code = upstreamErrorCode(parsed);
          log('upstream error (anthropic)', up.status, text.slice(0, 300));
          recordRequest({
            model,
            stream: wantStream,
            ms: Date.now() - startedAt,
            ok: false,
            status: up.status,
            code: upstreamLedgerCode(parsed),
            error: message,
            ...fallbackInfo,
          });
          // 错误体也必须是 Anthropic 的形状，否则客户端只会显示「未知错误」
          return json(res, up.status === 200 || authFailure ? 502 : up.status, {
            type: 'error',
            error: {
              type: authFailure
                ? 'authentication_error'
                : channelRejected ? 'upstream_channel_error' : 'api_error',
              message,
              ...(channelRejected ? { code: 'CHANNEL_REJECTED' } : (code !== null ? { code } : {})),
            },
          });
        }

        if (wantStream) {
          res.__overheadMs = Math.max(0, upstreamStartedAt - startedAt);
          const r = await relayAnthropicStream(up, res, model, estimateRequestTokens(body));
          if (r.streamError && !ac.signal.aborted) {
            recordRequest({ model, stream: true, ms: Date.now() - startedAt, ok: false, status: 0, code: null, error: r.streamError.message, ...fallbackInfo });
          } else {
            recordRequest({ model, stream: true, ok: true, ms: Date.now() - startedAt, ...usageOf(r.usage), ...fallbackInfo });
          }
          return;
        }

        const aggregated = await aggregateStream(up);
        res.__overheadMs = Math.max(0, upstreamStartedAt - startedAt);
        // 同 OpenAI 路径：上游 200 但解析不出任何 SSE 块 = 失败，不是「空回答」；
        // 解析出了块但流在半路干净地断了（`completed === false`）同样是失败。
        if (!aggregated.parsed || aggregated.completed === false) {
          const reason = !aggregated.parsed
            ? 'upstream returned 200 but no parseable SSE data'
            : 'upstream stream ended before completion (no finish_reason / usage / [DONE])';
          recordRequest({
            model,
            stream: false,
            ms: Date.now() - startedAt,
            ok: false,
            status: up.status,
            code: null,
            error: reason,
            ...fallbackInfo,
          });
          return json(res, 502, {
            type: 'error',
            error: { type: 'api_error', message: `workbuddy-bridge: ${reason}` },
          });
        }
        recordRequest({
          model,
          stream: false,
          ok: true,
          ms: Date.now() - startedAt,
          overheadMs: Math.max(0, upstreamStartedAt - startedAt),
          ...usageOf(aggregated.usage),
          ...fallbackInfo,
        });
        return json(res, 200, openAIToAnthropicMessage(aggregated, model));
      } catch (e) {
        if (handleUpstreamTimeout(res, 'anthropic', e)) {
          recordRequest({
            model, stream: wantStream, ms: Date.now() - startedAt, ok: false,
            status: 504, code: null, error: e.message,
          });
          return;
        }
        if (e?.code === 'RATE_LIMITED') {
          const retryAfter = Math.max(1, Math.ceil((e.retryAfterMs || 1000) / 1000));
          recordRequest({ model, stream: wantStream, ms: Date.now() - startedAt, ok: false, status: 429, code: null, error: `rate_limited (retry in ${retryAfter}s)` });
          return json(res, 429, { type: 'error', error: { type: 'rate_limit_error', message: e.message } }, { 'Retry-After': String(retryAfter) });
        }
        if (e?.code === 'RATE_LIMIT_ABORTED') {
          return; // 客户端等待时断开：无上游副作用，不记账
        }
        recordRequest({ model, stream: wantStream, ms: Date.now() - startedAt, ok: false, status: 0, code: null, error: e.message });
        throw e;
      }
    }

    // ── OpenAI Responses API（Codex 等）────────────────────────────────────
    // 形状与 /v1/messages 那条保持一致：同样的读体、同样的限流/记账/中断处理，
    // 只换翻译层。Codex 只认这条协议（`wire_api="chat"` 已被上游移除）。
    if (url.pathname === '/v1/responses' && req.method === 'POST') {
      let raw;
      try {
        raw = await readBody(req);
      } catch (e) {
        if (e.code === 'BODY_TOO_LARGE') {
          return rejectTooLarge(req, res, 'openai');
        }
        throw e;
      }
      let body;
      try { body = JSON.parse(raw); }
      catch { return json(res, 400, { error: { type: 'invalid_request', message: 'invalid JSON body' } }); }

      /*
       * 桥是无状态的：没有实现 Responses 的服务端 store。客户端带
       * `previous_response_id` 时，如果静默当新会话处理，会把上一轮上下文吞掉，
       * 用户只会看到“模型失忆”。明确拒绝，让客户端改发完整 input 历史。
       */
      if (typeof body.previous_response_id === 'string' && body.previous_response_id.trim()) {
        const message = 'workbuddy-bridge: previous_response_id is not supported '
          + '(the bridge is stateless); send the full input history and omit store/previous_response_id';
        recordRequest({
          model: String(body.model || ''), stream: false, ms: 0, ok: false, status: 400,
          code: 'previous_response_not_found', error: message,
        });
        return json(res, 400, {
          error: { type: 'invalid_request_error', code: 'previous_response_not_found', message },
        });
      }

      const wantStream = body.stream === true;
      const model = resolveResponsesModel(body.model);
      const messages = responsesToOpenAIMessages(body);
      /*
       * 工具可能出现在三个地方：
       *   1. 顶层 `tools`（经典 function tools）；
       *   2. `input[].additional_tools`（新版 Codex 的 code mode）；
       *   3. `input[].tool_search_output`（**延迟下发**：Codex 把 MCP 工具藏起来，
       *      模型得先用 `tool_search` 检索，命中结果在下一轮才以 namespace 分组出现）。
       * 三处都收 —— 只看前两处的话，Codex 自带的 MCP 工具（含 computer-use 的唯一
       * 入口 `mcp__node_repl.js`）走桥时一个都到不了上游，而且全程不报错。
       */
      const routes = buildToolRoutes(body);
      const tools = withDeferredTools(
        responsesToolsToOpenAI(body.tools) || responsesToolsFromAdditional(body),
        routes.deferred,
      );
      const toolChoice = responsesToolChoiceToOpenAI(body.tool_choice);
      const modelError = preflightModelError(model);
      if (modelError) {
        log('rejected unknown model (responses)', model);
        recordRequest({
          model, stream: wantStream, ms: 0, ok: false, status: 404, code: 'model_not_found', error: modelError,
        });
        return json(res, 404, {
          error: { type: 'invalid_request_error', code: 'model_not_found', message: modelError },
        });
      }
      /*
       * 请求里声明为 custom（freeform）的工具名 —— 回包侧要按 `custom_tool_call`
       * 回（Codex 的 apply_patch 就是这一类）。丢了这份名单，工具调用就会被当成
       * 普通 function_call 发回去，客户端判 `incompatible payload`。
       * `routes.namespace` 同理：分组工具的调用必须带回 `namespace` 字段，否则
       * Codex 的工具路由器认不出它属于哪个 MCP server。
       */
      const customTools = routes.custom;

      const oai = { model, messages, stream: true, stream_options: { include_usage: true } };
      if (tools) oai.tools = tools;
      if (toolChoice) oai.tool_choice = toolChoice;
      // Responses 的 `max_output_tokens` 对应 chat 的 `max_tokens`
      if (typeof body.max_output_tokens === 'number') oai.max_tokens = body.max_output_tokens;
      if (typeof body.temperature === 'number') oai.temperature = body.temperature;
      if (typeof body.top_p === 'number') oai.top_p = body.top_p;

      const toolError = toolNameError(tools);
      if (toolError) {
        const message = `workbuddy-bridge: ${toolError}`;
        log('rejected invalid tool name (responses)', toolError);
        recordRequest({
          model, stream: wantStream, ms: 0, ok: false, status: 400, code: null, error: message,
        });
        return json(res, 400, {
          error: { type: 'invalid_request', message },
        });
      }

      maybeAutoCheckin();
      /*
       * 工具**名字**也打出来：只记个数的话，「工具被静默丢掉」这类问题在日志里
       * 完全不可见 —— 2026-10-13 的 `tool_search` 被丢就是这样：`tools=10` 看着
       * 正常，实际少了 MCP 工具的唯一入口。名字属元数据，不含任何对话内容。
       */
      log(`→ [responses] ${body.model || '(no model)'} => ${model} stream=${wantStream} msgs=${messages.length} tools=${tools?.length ?? 0}`
        + (customTools.size ? ` freeform=${[...customTools].join(',')}` : '')
        + (routes.deferred.size ? ` deferred=${[...routes.deferred.keys()].join(',')}` : '')
        + (routes.toolSearch ? ' tool_search=1' : '')
        /*
         * **被丢掉的工具**也要打出来（见 buildToolRoutes 的 `dropped` 说明）。
         * 不打的话，"模型有个工具用不了"在日志里完全不可见 ——
         * `apply_patch` 与 `tool_search` 两次翻车都是这么被藏起来的。
         */
        + (routes.dropped.size ? ` dropped=${[...routes.dropped].join(',')}` : '')
        + ` names=[${(tools || []).map((t) => t.function?.name).filter(Boolean).join(',')}]`);

      const startedAt = Date.now();
      trackInflight(req, res, model, wantStream);
      const ac = new AbortController();
      req.on('aborted', () => ac.abort());
      res.on('close', () => { if (!res.writableEnded) ac.abort(); });

      try {
        const upstreamPayload = applyVisionDegrade(normalizePayload(oai), model);
        const conv = resolveConversationId(req, upstreamPayload);
        if (conv.source !== 'client') {
          log(`conversation id: source=${conv.source} id=${conv.id.slice(0, 8)}…`);
        }
        const attempt = await callUpstreamWithChannelFallback(
          upstreamPayload,
          model,
          conv.id,
          ac.signal,
        );
        const up = attempt.res;
        const upstreamStartedAt = attempt.upstreamStartedAt;
        const text = attempt.bodyText ?? (up.ok ? '' : await up.text().catch(() => ''));
        const parsed = attempt.parsed;
        const fallbackInfo = channelAttemptMeta(attempt, up);
        if (attempt.fallback) res.setHeader(CHANNEL_FALLBACK_HEADER, attempt.fallback);
        if (!up.ok) {
          log('upstream error (responses)', up.status, text.slice(0, 300));
          const authFailure = upstreamAuthFailure(up);
          const channelRejected = attempt.channelRejected === true;
          const message = authFailure
            ? upstreamAuthMessage(parsed)
            : channelRejected
              ? channelRejectedMessage(attempt)
              : upstreamErrorText(parsed, text, up);
          const errorCode = authFailure
            ? 'upstream_auth_error'
            : channelRejected
              ? 'CHANNEL_REJECTED'
              : responsesErrorCode(up.status, message, parsed?.code ?? parsed?.error?.code);
          recordRequest({
            model,
            stream: wantStream,
            ms: Date.now() - startedAt,
            ok: false,
            status: up.status,
            code: upstreamLedgerCode(parsed),
            error: message,
            ...fallbackInfo,
          });
          // 非流式：按 Responses 的错误形状回
          if (!wantStream) {
            return json(res, up.status === 200 || authFailure ? 502 : up.status, {
              error: {
                type: authFailure
                  ? 'upstream_auth_error'
                  : channelRejected ? 'upstream_channel_error' : 'upstream_error',
                code: errorCode,
                message,
              },
            });
          }
          // 已经答应过客户端「这是事件流」，就不能中途改回 JSON —— 用 SSE 发
          // response.failed（Codex 认这个事件并会把它转成可读的 API 错误）。
          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
            ...SECURITY_HEADERS,
          });
          /*
           * `error.code` 走映射（见 responsesErrorCode 的说明），让 429 能命中
           * Codex 的 RateLimitExceeded（它会按 retry_after 自动退避）、上下文超限
           * 能命中 ContextWindowExceeded。
           * `error.headers` 里放 `retry-after`：Codex 的 `parse_failed_response`
           * 正是从 `error.headers` 里取 retry-after（responses_error.rs:31-35）。
           * 上游给了就用上游的秒数，没给就 429 兜底 1s（避免客户端立刻猛重试）。
           */
          /*
           * ⚠️ `up` 是 node 的 `http.IncomingMessage`，**不是** fetch 的 `Response` ——
           * `up.headers` 是普通对象，没有 `.get()`。写 `up.headers.get(...)` 会静默
           * 返回 undefined（可选链把它吞掉），于是上游给的 retry-after 永远读不到、
           * 一律落到下面的兜底 1s。node 侧要按小写键名直接取。
           */
          const retryAfterSec = up.headers?.['retry-after']
            || (Number(up.status) === 429 ? '1' : null);
          const failed = JSON.stringify({
            type: 'response.failed',
            response: {
              id: responsesId('resp'),
              object: 'response',
              status: 'failed',
              model,
              headers: { 'openai-model': model },
              output: [],
              usage: null,
              error: {
                code: errorCode,
                message,
                ...(retryAfterSec ? { headers: { 'retry-after': String(retryAfterSec) } } : {}),
              },
            },
          });
          res.write(`event: response.failed\ndata: ${failed}\n\n`);
          return res.end();
        }

        if (wantStream) {
          res.__overheadMs = Math.max(0, upstreamStartedAt - startedAt);
          const wantsReasoning = process.env.WORKBUDDY_FORWARD_REASONING === '1' && (
            /codex/i.test(String(req.headers['user-agent'] || ''))
            || req.headers['x-workbuddy-forward-reasoning'] === '1'
            || (Array.isArray(body.include) && body.include.some((v) => /reasoning/i.test(String(v))))
            || (body.reasoning && typeof body.reasoning === 'object'
              && (body.reasoning.summary != null || body.reasoning.generate_summary != null))
          );
          if (process.env.WORKBUDDY_FORWARD_REASONING === '1' && !wantsReasoning) {
            log('responses: reasoning summary suppressed for non-Codex client');
          }
          const r = await relayResponsesStream(up, res, model, routes, {
            forwardReasoning: wantsReasoning,
          });
          if (r.streamError && !ac.signal.aborted) {
            recordRequest({ model, stream: true, ms: Date.now() - startedAt, ok: false, status: 0, code: null, error: r.streamError.message, ...fallbackInfo });
          } else {
            recordRequest({ model, stream: true, ok: true, ms: Date.now() - startedAt, ...usageOf(r.usage), ...fallbackInfo });
          }
          return;
        }

        const aggregated = await aggregateStream(up);
        res.__overheadMs = Math.max(0, upstreamStartedAt - startedAt);
        // 同另两条路径：上游 200 但解析不出任何 SSE 块 = 失败，不是「空回答」；
        // 解析出了块但流在半路干净地断了（`completed === false`）同样是失败。
        if (!aggregated.parsed || aggregated.completed === false) {
          const reason = !aggregated.parsed
            ? 'upstream returned 200 but no parseable SSE data'
            : 'upstream stream ended before completion (no finish_reason / usage / [DONE])';
          recordRequest({
            model,
            stream: false,
            ms: Date.now() - startedAt,
            ok: false,
            status: up.status,
            code: null,
            error: reason,
            ...fallbackInfo,
          });
          return json(res, 502, {
            error: { type: 'upstream_error', message: `workbuddy-bridge: ${reason}` },
          });
        }
        recordRequest({
          model,
          stream: false,
          ok: true,
          ms: Date.now() - startedAt,
          overheadMs: Math.max(0, upstreamStartedAt - startedAt),
          ...usageOf(aggregated.usage),
          ...fallbackInfo,
        });
        return json(res, 200, openAIToResponsesResponse(aggregated, model, routes));
      } catch (e) {
        if (handleUpstreamTimeout(res, 'responses', e)) {
          recordRequest({
            model, stream: wantStream, ms: Date.now() - startedAt, ok: false,
            status: 504, code: null, error: e.message,
          });
          return;
        }
        if (e?.code === 'RATE_LIMITED') {
          const retryAfter = Math.max(1, Math.ceil((e.retryAfterMs || 1000) / 1000));
          recordRequest({ model, stream: wantStream, ms: Date.now() - startedAt, ok: false, status: 429, code: null, error: `rate_limited (retry in ${retryAfter}s)` });
          /*
           * 流式请求不能中途改回 JSON —— 客户端（Codex）的解析器只认 SSE。
           * 统一发 `response.failed`，并把 `retry-after` 放进 `error.headers`，
           * 让 Codex 命中 `RateLimitExceeded` 并按官方节奏自动退避
           * （codex-rs/codex-api/src/sse/responses_error.rs:31-35）。
           */
          if (wantStream) {
            res.writeHead(200, {
              'Content-Type': 'text/event-stream; charset=utf-8',
              'Cache-Control': 'no-cache, no-transform',
              Connection: 'keep-alive',
              'X-Accel-Buffering': 'no',
              ...SECURITY_HEADERS,
            });
            const failed = JSON.stringify({
              type: 'response.failed',
              response: {
                id: responsesId('resp'),
                object: 'response',
                status: 'failed',
                model,
                headers: { 'openai-model': model },
                output: [],
                usage: null,
                error: {
                  code: 'rate_limit_exceeded',
                  message: e.message,
                  headers: { 'retry-after': String(retryAfter) },
                },
              },
            });
            res.write(`event: response.failed\ndata: ${failed}\n\n`);
            return res.end();
          }
          return json(res, 429, { error: { type: 'rate_limit_error', code: 'rate_limit_exceeded', message: e.message } }, { 'Retry-After': String(retryAfter) });
        }
        if (e?.code === 'RATE_LIMIT_ABORTED') {
          return; // 客户端等待时断开：无上游副作用，不记账
        }
        recordRequest({ model, stream: wantStream, ms: Date.now() - startedAt, ok: false, status: 0, code: null, error: e.message });
        throw e;
      }
    }

    // ── 上游没有的能力：明确 501，不做假的 ────────────────────────────────
    // 上游 30 个模型全是对话类，**没有任何 embedding 模型**。这里若返回一堆
    // 无意义的向量，客户端的知识库会"看起来建成了、实际全是噪声"，用户要等
    // 检索结果离谱时才发现。宁可现在就讲清楚。
    if (url.pathname === '/v1/embeddings' && req.method === 'POST') {
      return json(res, 501, {
        error: {
          message: 'workbuddy-bridge: /v1/embeddings is not available — the upstream gateway serves chat models only '
            + '(its catalog contains no embedding model). Clients that need embeddings for a knowledge base / RAG '
            + 'should configure a separate embedding provider.',
          type: 'not_implemented',
        },
      });
    }

    if (url.pathname === '/' ) {
      return json(res, 200, {
        service: 'workbuddy-bridge',
        usage: 'POST /v1/chat/completions · POST /v1/messages (Anthropic) · POST /v1/responses (Codex) · POST /v1/videos · GET /v1/videos/{id} · POST /v1/images · POST /v1/images/edits · GET /v1/images/{id} · GET /v1/models · GET /v1/usage · GET /v1/requests · GET /v1/quota · GET /v1/checkin · POST /v1/auth/device (device-code login) · GET /v1/auth/credentials · GET /v1/auth/source · GET /health',
        featured: FEATURED.map((m) => m.id),
      });
    }
    return json(res, 404, { error: { message: `no route for ${req.method} ${url.pathname}` } });
  } catch (e) {
    log('handler error', e.stack || e.message);
    if (!res.headersSent) return json(res, 500, { error: { message: e.message } });
    try { res.end(); } catch {}
  }
}

// ── Preflight (--check): report prerequisites without starting the server ──
if (process.argv.includes('--check')) {
  const lines = [];
  const major = Number(process.versions.node.split('.')[0]);
  lines.push(`node            ${process.version}${major >= 18 ? '' : '  [FAIL] Node 18+ required'}`);
  lines.push(`auth file       ${AUTH_PATH}`);
  let authOk = false;
  let checkRegion = '';
  lines.push(`credential store ${credentialStoreMode()}`
    + `${credentialStoreMode() === 'memory' ? ' (not persisted)' : ` @ ${CREDENTIAL_DIR}`}`
    + `${credentialStoreFallback ? `  [degraded: ${credentialStoreFallback}]` : ''}`);
  try {
    const a = await resolveAuth();
    authOk = true;
    lines.push(`credential      ${a.source}${a.uid ? ` (${a.uid})` : ''}${a.region ? ` · ${a.region}` : ''}`);
    lines.push(`account         ${a.userId || a.uid || '(no sub claim)'}`);
    lines.push(`endpoint        ${a.endpoint}`);
    lines.push(`token expires   ${new Date(a.expiresAt).toISOString()}${a.expiresAt < Date.now() ? '  (expired: the bridge refreshes on first request)' : ''}`);
    checkRegion = upstreamRegion(a);
  } catch (e) {
    lines.push(`auth            [FAIL] ${e.message}`);
  }
  lines.push(`client exe      ${atRestUsedExe || (await resolveWorkBuddyExe()) || '未找到（若只用插件登录，此行可忽略）'}`);
  // 精选列表按区域过滤 —— 日志里列一个当前区域**不提供**的模型，会让人以为
  // "桥明明认识它、为什么 /v1/models 里没有"（诊断日志的可信度就靠这点）
  lines.push(`models          ${FEATURED.filter((m) => featuredAllowedIn(m, checkRegion)).map((m) => m.id).join(', ')}`);
  lines.push(`video           POST /v1/videos (Miora ${VIDEO_BASE_OVERRIDE || 'public.miora.qq.com'})`);
  lines.push(`image           POST /v1/images · POST /v1/images/edits (Miora ${VIDEO_BASE_OVERRIDE || 'public.miora.qq.com'})`);
  console.log(lines.join('\n'));
  process.exit(authOk || API_KEY ? 0 : 1);
}

server.listen(PORT, HOST, async () => {
  /*
   * 先打印监听地址与登录文件路径，**再**尝试读凭据。
   *
   * 读凭据要跑客户端进程取 AtRest 密钥，在慢盘 / 高负载 / 客户端刚升级时
   * 可能卡住好几秒。原顺序把这行日志压在它后面，于是启动日志看起来像
   * "桥没起来"，验收脚本也会误判成启动失败（实测：并行跑整套测试时
   * 10 秒等不到这一行）。这两行是纯本地信息，先说出来不需要任何代价。
   */
  console.log(`workbuddy-bridge listening on http://${HOST}:${PORT}/v1`);
  console.log(`auth file  : ${AUTH_PATH}`);
  // 只报**已经定位过**的 exe：这里不触发探测。探测要起 PowerShell（数秒），
  // 启动日志不该为一行诊断信息付这个代价；真正需要时 atRestKey 会异步定位。
  console.log(`client exe : ${atRestUsedExe || wbExeCache || '未定位（首次读取桌面凭据时再探测）'}`);
  let who = '(no desktop session read)';
  let region = '';
  try { const a = await resolveAuth(); region = upstreamRegion(a); who = `${a.userId || a.uid} @ ${a.endpoint} (${a.source})`; } catch (e) { who = `ERROR: ${e.message}`; }
  console.log(`auth       : ${API_KEY ? 'API key (CODEBUDDY_API_KEY)' : `desktop session ${who}`}`);
  // 同上：精选列表按区域过滤（国际版别在日志里列 v4-pro —— 那个区域不提供它）
  console.log(`models     : ${FEATURED.filter((m) => featuredAllowedIn(m, region)).map((m) => m.id).join(', ')}  (all models: /v1/models?all=1)`);
  console.log(`video      : POST /v1/videos (Miora ${VIDEO_BASE_OVERRIDE || 'public.miora.qq.com'})`);
  console.log(`image      : POST /v1/images · POST /v1/images/edits (Miora ${VIDEO_BASE_OVERRIDE || 'public.miora.qq.com'})`);
  /*
   * 只在**开了**的时候说一句：默认行为（丢弃思维链）不需要每次都提醒，
   * 但既然有人开了这个开关，就要让他一眼看到"确实生效了"——
   * 否则他会去猜"是不是没读到我设的环境变量"。
   */
  if (process.env.WORKBUDDY_FORWARD_REASONING === '1') {
    console.log('reasoning  : forwarded as a `reasoning` output item (WORKBUDDY_FORWARD_REASONING=1)');
  }
  console.log(`keep-alive : ${KEEPALIVE_MS > 0 ? `${Math.round(KEEPALIVE_MS / 1000)}s idle pool` : 'off'}`);
  /*
   * 未显式配置令牌时把自动生成的值打印出来。
   *
   * 只打印「本次生成的」：用户自己配了 `WORKBUDDY_LOCAL_TOKEN` 就不需要看这段，
   * 也不该把用户的口令回显到日志里（日志可能被随手贴出去）。
   * 前缀写成 `WORKBUDDY_LOCAL_TOKEN=` 是刻意的 —— 用户可以直接整行复制进 .env。
   */
  if (!EXPLICIT_LOCAL_TOKEN) {
    console.log(`token      : 未配置 WORKBUDDY_LOCAL_TOKEN，已自动生成（重启会变）：`);
    console.log(`             WORKBUDDY_LOCAL_TOKEN=${LOCAL_TOKEN}`);
    console.log(`             要固定它，请把上面这行写进 .env；客户端就用这个值。`);
  }

  // ── 连接预热：listen 后立刻向上游开一条 TLS 连接放进池子 ─────────────────
  // 首次对话请求就免去 DNS + TCP + TLS 握手（实测 ~150ms）。只预热、不发请求体；
  // 失败完全无害 —— Agent 会在真正请求时重连。
  try {
    const endpoint = API_KEY ? (EXPLICIT_ENDPOINT || 'https://copilot.tencent.com') : pickUpstream(JSON.parse(readFileSync(AUTH_PATH, 'utf8'))?.auth?.domain || '');
    const url = new URL(endpoint);
    const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: '/',
      method: 'GET',
      agent: agentFor(url.protocol),
      timeout: 8000,
    });
    // 拿到响应就算预热完成（连接已进池）；上游 4xx/5xx 都无所谓，我们要的只是连接
    req.on('response', (res) => { res.resume(); log(`warmed upstream connection to ${url.hostname}`); });
    req.on('error', () => {});   // 预热失败不吵不闹
    req.on('timeout', () => req.destroy());
    req.end();
  } catch { /* 登录文件读不出来等：真正请求时自会报错 */ }

  // ── 每日自动签到的定时器 ─────────────────────────────────────────────
  // 必须由**常驻的那一方**负责：桥会在后台一直活着，控制台不会。
  // 详见 startAutoCheckinTimer 的注释（实测：桥跑了一整天、零模型请求，
  // 结果一次签到都没发生）。
  startAutoCheckinTimer();
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { console.log('\nworkbuddy-bridge stopped'); process.exit(0); });
}
