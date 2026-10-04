/**
 * workbuddy 的 dsh LLM 适配器。
 *
 * 只做「dsh 词汇 ↔ OpenAI Chat Completions 词汇」的双向翻译，然后交给本地桥
 * （bridge/workbuddy-bridge.mjs）转发。上游本来就讲 OpenAI 协议，所以这里
 * **不做协议转换**，只做两侧词汇表的对齐：
 *
 *   dsh GenerateOptions.messages  →  OpenAI messages / tools
 *   OpenAI SSE delta              →  dsh StreamChunk
 *
 * 契约来源（已核对 dsh 实现，不是猜的）：
 *   - `llm.registerAdapter(providers, adapter)` 只调用
 *     `adapter.providerInfo(provider)` 与 `adapter.providerRetryPolicy(provider)`，
 *     **没有 instanceof 检查** —— 适配器可以是普通对象，插件不必 import
 *     `@deepseek-ai/dsh-llm`（profile 的 node_modules 里也解析不到它）。
 *   - StreamChunk 顺序：block-start → *-delta → block-end，末尾 usage → finish。
 *   - 派发失败必须**以 finish 块收尾**（kind:'error'），不能向调用方抛。
 */
import { toAdapterModels, isChatModel } from './models.mjs';

/** dsh 侧的错误码取值（与内置适配器同一套词汇）。 */
export const CODE = {
  AUTH: 'AUTH',
  RATE_LIMIT: 'RATE_LIMIT',
  QUOTA: 'QUOTA_EXCEEDED',
  INVALID: 'INVALID_REQUEST',
  SERVER: 'SERVER',
  TIMEOUT: 'TIMEOUT',
  TRANSPORT: 'TRANSPORT',
  ABORTED: 'ABORTED',
  EMPTY: 'EMPTY_RESPONSE',
  CONTEXT: 'CONTEXT_WINDOW_EXCEEDED',
};

/** 把上游错误文本 / HTTP 状态分类成 dsh 错误码。 */
export function classifyError(message, status) {
  const text = String(message || '');
  if (status === 401 || status === 403 || /\b(?:401|403)\b/.test(text)) return CODE.AUTH;
  if (/quota|insufficient|balance|积分|余额/i.test(text)) return CODE.QUOTA;
  if (status === 429 || /\b429\b|rate.?limit|too many requests/i.test(text)) return CODE.RATE_LIMIT;
  if (/context|token.{0,12}(?:limit|exceed)|maximum context/i.test(text)) return CODE.CONTEXT;
  if (status === 400 || status === 422 || /\b(?:400|422)\b|invalid.?request/i.test(text)) return CODE.INVALID;
  if (status >= 500 || /\b5\d\d\b/.test(text)) return CODE.SERVER;
  if (/timeout|timed?\s*out|ETIMEDOUT/i.test(text)) return CODE.TIMEOUT;
  if (/fetch failed|ECONN|socket|network|terminated|prematurely/i.test(text)) return CODE.TRANSPORT;
  return 'PROVIDER_ERROR';
}

/** OpenAI usage → dsh TokenUsage。缺失字段省略，不编造 0。 */
export function mapUsage(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const input = Number(raw.prompt_tokens ?? raw.input_tokens ?? 0) || 0;
  const output = Number(raw.completion_tokens ?? raw.output_tokens ?? 0) || 0;
  const total = Number(raw.total_tokens ?? 0) || input + output;
  const cacheRead = Number(raw.prompt_tokens_details?.cached_tokens ?? raw.cache_read_tokens ?? 0) || 0;
  const reasoning = Number(raw.completion_tokens_details?.reasoning_tokens ?? raw.reasoning_tokens ?? 0) || 0;
  const usage = { inputTokens: input, outputTokens: output, totalTokens: total };
  if (cacheRead > 0) usage.cacheReadTokens = cacheRead;
  if (reasoning > 0) usage.reasoningTokens = reasoning;
  return usage;
}

/** OpenAI finish_reason → dsh FinishReason。 */
export function mapFinishReason(reason, sawToolCall, sawContent) {
  switch (reason) {
    case 'tool_calls':
    case 'function_call':
      return { kind: 'tool-calls' };
    case 'length':
      return { kind: 'max-tokens' };
    case 'content_filter':
      return { kind: 'error', failure: { message: '上游以 content_filter 结束本次回复', code: CODE.INVALID } };
    case 'stop':
      if (sawToolCall) return { kind: 'tool-calls' };
      // 与内置适配器同一判定：stop 但一个块都没有 = 空回复，属于错误而不是成功
      if (!sawContent) return { kind: 'error', failure: { message: '上游回复结束但没有任何内容', code: CODE.EMPTY } };
      return { kind: 'stop' };
    default:
      if (sawToolCall) return { kind: 'tool-calls' };
      if (!sawContent) {
        return { kind: 'error', failure: { message: '上游回复结束但没有任何内容', code: CODE.EMPTY } };
      }
      return { kind: 'stop' };
  }
}

/** 把 dsh 的内容块数组拍成纯文本。 */
function textOf(blocks) {
  if (typeof blocks === 'string') return blocks;
  if (!Array.isArray(blocks)) return '';
  return blocks.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('');
}

/**
 * 一条 dsh 消息 → 一条 OpenAI wire 消息。
 *
 * @param {object} message dsh Message（system/developer/user/assistant/tool）
 * @param {(ref: object) => Promise<string|null>} resolveImage 图片引用 → data URL
 */
/**
 * wire 层净化：把历史里"上游一定会拒绝"的消息剔掉。
 *
 * dsh 侧的历史可能包含：
 *   - 空的助手消息（上一轮失败/中断留下的占位）→ 上游对 `content:null` 且无
 *     tool_calls 的助手轮态度不一，有的直接 400；
 *   - 孤儿 tool 结果（没有对应的 assistant.tool_calls 声明）→ OpenAI schema 要求
 *     每个 tool 消息必须能对上一次 tool_call_id，否则 400。
 * 两类都只影响"能不能发出去"，剔掉不改变语义（它们本来就没有内容）。
 */
function sanitizeWire(messages) {
  const kept = [];
  const declaredCallIds = new Set();
  for (const message of messages) {
    if (message.role === 'assistant') {
      const hasText = typeof message.content === 'string' && message.content.length > 0;
      const hasCalls = Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
      if (!hasText && !hasCalls) continue; // 空的助手轮：丢掉
      if (hasCalls) for (const call of message.tool_calls) declaredCallIds.add(String(call.id));
      kept.push(message);
      continue;
    }
    if (message.role === 'tool') {
      if (!declaredCallIds.has(String(message.tool_call_id))) continue; // 孤儿工具结果：丢掉
      kept.push(message);
      continue;
    }
    kept.push(message);
  }
  return kept;
}

async function toWireMessage(message, resolveImage) {
  const role = message.role === 'developer' ? 'system' : message.role;
  const blocks = Array.isArray(message.content) ? message.content : [];

  if (role === 'tool') {
    const parts = [];
    for (const block of blocks) {
      if (block?.type === 'text') parts.push(block.text || '');
    }
    return {
      role: 'tool',
      tool_call_id: String(message.toolCallId || ''),
      content: parts.join('') || '(no output)',
    };
  }

  if (role === 'assistant') {
    const textParts = [];
    const toolCalls = [];
    for (const block of blocks) {
      if (block?.type === 'text') textParts.push(block.text || '');
      else if (block?.type === 'tool-call') {
        toolCalls.push({
          id: String(block.id || ''),
          type: 'function',
          function: { name: String(block.name || ''), arguments: String(block.arguments ?? '{}') },
        });
      }
      // reasoning 块不回灌：兼容端点对 reasoning 字段的接受度不一致，上游也不需要。
    }
    const out = { role: 'assistant', content: textParts.join('') || null };
    if (toolCalls.length) out.tool_calls = toolCalls;
    return out;
  }

  // system / user：带图片时走 OpenAI 的多段内容数组
  const hasImage = blocks.some((b) => b?.type === 'image' && b.offloaded !== true);
  if (!hasImage) return { role, content: textOf(blocks) };

  const parts = [];
  for (const block of blocks) {
    if (block?.type === 'text' && block.text) parts.push({ type: 'text', text: block.text });
    else if (block?.type === 'image') {
      const url = await resolveImage(block.attachment).catch(() => null);
      if (url) parts.push({ type: 'image_url', image_url: { url } });
      else parts.push({ type: 'text', text: '[图片：无法读取该附件]' });
    }
  }
  if (!parts.length) parts.push({ type: 'text', text: '' });
  return { role, content: parts };
}

/** dsh 工具表 → OpenAI tools；toolHistory 里的动态新增一并带上。 */
export function toWireTools(options) {
  const byName = new Map();
  const add = (tool) => {
    if (!tool || typeof tool.name !== 'string' || !tool.name || byName.has(tool.name)) return;
    byName.set(tool.name, {
      type: 'function',
      function: {
        name: tool.name,
        description: typeof tool.description === 'string' ? tool.description : '',
        parameters: tool.parameters && typeof tool.parameters === 'object'
          ? tool.parameters
          : { type: 'object', properties: {} },
      },
    });
  };
  for (const tool of options.tools || []) add(tool);
  for (const update of options.toolHistory?.updates || []) {
    for (const tool of update.additions || []) add(tool);
  }
  return [...byName.values()];
}

/**
 * SSE 增量解析器：把上游的 `data:` 行喂进来，产出 dsh 的流块。
 *
 * 状态机与内置适配器一致：块索引按**出现顺序**分配，每个块先 block-start、
 * 期间发增量、收尾时 block-end 携带完整内容。
 */
class StreamTranslator {
  constructor() {
    this.nextIndex = 0;
    this.text = null;
    this.reasoning = null;
    this.tools = new Map(); // wire tool index → { index, id, name, args }
    this.order = [];
    this.usage = null;
    this.finishReason = undefined;
    this.sawToolCall = false;
  }

  get sawContent() {
    return this.text !== null || this.reasoning !== null || this.sawToolCall;
  }

  /** 解析一行 `data: {...}`；返回本次新增的块数组。 */
  pushLine(line) {
    const out = [];
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return out;
    const body = trimmed.slice(5).trim();
    if (!body || body === '[DONE]') return out;
    let frame;
    try { frame = JSON.parse(body); } catch { return out; }
    if (frame.usage) this.usage = frame.usage;
    const choice = frame.choices?.[0];
    if (!choice) return out;
    const delta = choice.delta || {};

    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length) {
      if (!this.reasoning) {
        this.reasoning = { index: this.nextIndex++, text: '' };
        this.order.push({ kind: 'reasoning', index: this.reasoning.index });
        out.push({ type: 'block-start', index: this.reasoning.index, blockType: 'reasoning' });
      }
      this.reasoning.text += delta.reasoning_content;
      out.push({ type: 'reasoning-delta', index: this.reasoning.index, text: delta.reasoning_content });
    }

    if (typeof delta.content === 'string' && delta.content.length) {
      if (!this.text) {
        this.text = { index: this.nextIndex++, text: '' };
        this.order.push({ kind: 'text', index: this.text.index });
        out.push({ type: 'block-start', index: this.text.index, blockType: 'text' });
      }
      this.text.text += delta.content;
      out.push({ type: 'text-delta', index: this.text.index, text: delta.content });
    }

    for (const call of delta.tool_calls || []) {
      const wireIndex = Number.isInteger(call.index) ? call.index : 0;
      let entry = this.tools.get(wireIndex);
      if (!entry) {
        entry = { index: this.nextIndex++, id: '', name: '', args: '' };
        this.tools.set(wireIndex, entry);
        this.sawToolCall = true;
        this.order.push({ kind: 'tool-call', index: entry.index });
        out.push({ type: 'block-start', index: entry.index, blockType: 'tool-call' });
      }
      if (call.id) entry.id = String(call.id);
      if (!entry.id) entry.id = `call_${wireIndex}`;
      if (call.function?.name) entry.name += String(call.function.name);
      const argsDelta = call.function?.arguments;
      if (typeof argsDelta === 'string' && argsDelta.length) {
        entry.args += argsDelta;
        out.push({
          type: 'tool-call-delta',
          index: entry.index,
          id: entry.id,
          ...(entry.name ? { name: entry.name } : {}),
          argumentsDelta: argsDelta,
        });
      }
    }

    if (choice.finish_reason) this.finishReason = choice.finish_reason;
    return out;
  }

  /** 收尾：按开启顺序补 block-end，再补 usage 与 finish。 */
  finish() {
    const out = [];
    for (const { kind, index } of this.order) {
      if (kind === 'text' && this.text) out.push({ type: 'block-end', index, block: { type: 'text', text: this.text.text } });
      else if (kind === 'reasoning' && this.reasoning) out.push({ type: 'block-end', index, block: { type: 'reasoning', text: this.reasoning.text } });
      else if (kind === 'tool-call') {
        for (const entry of this.tools.values()) {
          if (entry.index !== index) continue;
          out.push({
            type: 'block-end',
            index,
            block: { type: 'tool-call', id: entry.id, name: entry.name, arguments: entry.args || '{}' },
          });
        }
      }
    }
    const usage = mapUsage(this.usage);
    if (usage) out.push({ type: 'usage', usage });
    out.push({ type: 'finish', reason: mapFinishReason(this.finishReason, this.sawToolCall, this.sawContent) });
    return out;
  }
}

/**
 * workbuddy 适配器（普通对象，不需要继承 dsh 的 LlmAdapter 抽象类）。
 */
export class WorkBuddyAdapter {
  /**
   * @param {object} options
   * @param {string} options.provider provider 路由名
   * @param {string} options.displayName 模型选择器里显示的名字
   * @param {import('./bridge.mjs').BridgeClient} options.client
   * @param {() => Promise<import('./bridge.mjs').BridgeClient>} [options.ensureReady] 取用前保证桥在跑
   * @param {(ref: object) => Promise<string|null>} [options.resolveImage]
   * @param {(message: string, detail?: unknown) => void} [options.log]
   * @param {{ allow?: string[], deny?: string[] }} [options.filter] 模型允许/排除清单
   */
  constructor(options) {
    this.provider = options.provider;
    this.displayName = options.displayName;
    this.client = options.client;
    this.ensureReady = options.ensureReady || (async () => this.client);
    this.resolveImage = options.resolveImage || (async () => null);
    this.log = options.log || (() => {});
    this.filter = options.filter || {};
    this.catalogTtlMs = options.catalogTtlMs ?? 60_000;
    /** 目录缓存，避免每次模型选择都打一次桥。 */
    this.catalogCache = { at: 0, models: [] };
    /** 最近一次目录错误的文本，给面板显示。 */
    this.catalogError = '';
  }

  /** 注册时**同步**调用：不能有 I/O。 */
  providerInfo(provider) {
    return { id: provider, name: this.displayName };
  }

  providerRetryPolicy() {
    return {
      mode: 'normal',
      maxRetries: 2,
      retryableCodes: [CODE.RATE_LIMIT, CODE.SERVER, CODE.TRANSPORT, CODE.TIMEOUT],
      initialDelayMs: 600,
      maxDelayMs: 10_000,
      jitterRatio: 0.2,
    };
  }

  /** 拉取桥的目录（带 TTL 缓存）。 */
  async catalog({ refresh = false } = {}) {
    const now = Date.now();
    if (!refresh && this.catalogCache.models.length && now - this.catalogCache.at < this.catalogTtlMs) {
      return this.catalogCache.models;
    }
    const client = await this.ensureReady();
    const payload = await client.models({ all: true, refresh });
    const data = Array.isArray(payload?.data) ? payload.data : [];
    this.catalogCache = { at: Date.now(), models: data };
    this.catalogError = '';
    return data;
  }

  /** 失效缓存（面板里「刷新目录」/ 启停桥之后调用）。 */
  invalidate() {
    this.catalogCache = { at: 0, models: [] };
  }

  /** 模型选择器看到的目录。 */
  async listModels(provider = this.provider) {
    let catalog;
    try {
      catalog = await this.catalog();
    } catch (error) {
      this.catalogError = String(error?.message || error);
      throw error;
    }
    return toAdapterModels(catalog, this.filter).map((m) => ({
      provider,
      id: m.id,
      name: m.name,
      ...(m.inputModalities ? { inputModalities: m.inputModalities } : {}),
    }));
  }

  /** 单个模型的精确元数据（上下文 / 输出上限）。 */
  async resolveModel(provider, model) {
    const catalog = await this.catalog();
    const hit = catalog.find((m) => m && m.id === model);
    if (!hit) return { provider, id: model, name: model };
    const [mapped] = toAdapterModels([hit]);
    return {
      provider,
      id: model,
      name: mapped?.name || model,
      ...(mapped?.contextWindow ? { context: { contextWindow: mapped.contextWindow } } : {}),
      ...(mapped?.maxTokens ? { defaultMaxTokens: mapped.maxTokens } : {}),
      ...(mapped?.inputModalities ? { inputModalities: mapped.inputModalities } : {}),
    };
  }

  /** one-generation 绑定：解析与派发之间不让配置变化串味。 */
  async prepareCall(provider, model, signal) {
    const resolved = await this.resolveModel(provider, model, signal);
    return { model: resolved, stream: (options) => this.stream(options) };
  }

  /**
   * 真正的流式调用。所有失败都以 `finish` 块收尾。
   * @param {object} options dsh GenerateOptions
   */
  async *stream(options) {
    const model = String(options.model || '');
    const signal = options.signal;
    if (!isChatModel(model)) {
      yield { type: 'finish', reason: { kind: 'error', failure: { message: `workbuddy 不接受模型 "${model}"`, code: CODE.INVALID } } };
      return;
    }

    let client;
    try {
      client = await this.ensureReady();
    } catch (error) {
      yield { type: 'finish', reason: { kind: 'error', failure: { message: `本地桥不可用：${error?.message || error}`, code: CODE.TRANSPORT } } };
      return;
    }

    // ── 组装 OpenAI 请求 ────────────────────────────────────────────────
    let payload;
    try {
      const messages = [];
      if (typeof options.system === 'string' && options.system.length) {
        messages.push({ role: 'system', content: options.system });
      }
      for (const message of options.messages || []) {
        messages.push(await toWireMessage(message, this.resolveImage));
      }
      payload = { model, messages: sanitizeWire(messages), stream: true };
      const tools = toWireTools(options);
      if (tools.length) payload.tools = tools;
      if (typeof options.temperature === 'number') payload.temperature = options.temperature;
      if (typeof options.maxTokens === 'number' && options.maxTokens > 0) payload.max_tokens = options.maxTokens;
      if (Array.isArray(options.stop) && options.stop.length) payload.stop = options.stop;
    } catch (error) {
      yield { type: 'finish', reason: { kind: 'error', failure: { message: `请求组装失败：${error?.message || error}`, code: CODE.INVALID } } };
      return;
    }

    let res;
    try {
      res = await client.chat(payload, { signal });
    } catch (error) {
      const aborted = signal?.aborted === true;
      yield {
        type: 'finish',
        reason: aborted
          ? { kind: 'aborted', failure: { message: '已取消', code: CODE.ABORTED } }
          : { kind: 'error', failure: { message: `本地桥连接失败：${error?.message || error}`, code: CODE.TRANSPORT } },
      };
      return;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let detail = text;
      let upstreamCode = null;
      try {
        const parsed = JSON.parse(text);
        detail = parsed?.error?.message || parsed?.msg || parsed?.message || text;
        upstreamCode = typeof parsed?.code === 'number' ? parsed.code : null;
      } catch { /* 非 JSON 错误体，保留原文 */ }
      const message = `上游 ${res.status}：${String(detail || '').slice(0, 400)}${upstreamCode !== null ? `（code ${upstreamCode}）` : ''}`;
      this.log(`chat failed model=${model} status=${res.status}`, String(detail || '').slice(0, 200));
      yield {
        type: 'finish',
        reason: {
          kind: signal?.aborted ? 'aborted' : 'error',
          failure: {
            message,
            code: signal?.aborted ? CODE.ABORTED : classifyError(detail, res.status),
            ...(res.status ? { status: res.status } : {}),
          },
        },
      };
      return;
    }

    // ── 逐块转译并**即时** yield（不能攒到最后，否则流式就废了） ────────
    const translator = new StreamTranslator();
    const decoder = new TextDecoder();
    let tail = '';
    try {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        tail += decoder.decode(value, { stream: true });
        const lines = tail.split('\n');
        tail = lines.pop() ?? '';
        for (const line of lines) {
          for (const chunk of translator.pushLine(line)) yield chunk;
        }
        if (tail.length > 200_000) tail = tail.slice(-8192); // 上游不按行收尾时的兜底
      }
      if (tail.trim()) {
        for (const chunk of translator.pushLine(tail)) yield chunk;
      }
      for (const chunk of translator.finish()) yield chunk;
    } catch (error) {
      // 流中断：已吐出的内容保留，补上已开块的 block-end，再用终止块收尾。
      // 绝不向调用方抛 —— 契约要求失败也走 finish 块。
      for (const { kind, index } of translator.order) {
        if (kind === 'text' && translator.text) yield { type: 'block-end', index, block: { type: 'text', text: translator.text.text } };
        else if (kind === 'reasoning' && translator.reasoning) yield { type: 'block-end', index, block: { type: 'reasoning', text: translator.reasoning.text } };
        else if (kind === 'tool-call') {
          for (const entry of translator.tools.values()) {
            if (entry.index !== index) continue;
            yield { type: 'block-end', index, block: { type: 'tool-call', id: entry.id, name: entry.name, arguments: entry.args || '{}' } };
          }
        }
      }
      const aborted = signal?.aborted === true;
      this.log(`stream interrupted model=${model}`, error?.message || error);
      yield {
        type: 'finish',
        reason: aborted
          ? { kind: 'aborted', failure: { message: '已取消', code: CODE.ABORTED } }
          : { kind: 'error', failure: { message: `流中断：${error?.message || error}`, code: CODE.TRANSPORT } },
      };
    }
  }
}
