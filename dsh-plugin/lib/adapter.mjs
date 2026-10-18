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

/**
 * 思考强度的档位显示名（id → name）。
 *
 * 档位集合与**国际版桌面端产物**一致（`EXTENDED_THINKING_LEVELS`）。
 * `off` / `none` 不在表里：那是"关闭思考"，而网关对它们的处理不一致
 * （一部分模型 400、另一部分模型收了但仍然思考）—— 所以桥侧根本不发这两个值。
 */
export const EFFORT_NAMES = {
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra High',
  max: 'Max',
};

/**
 * 老桥（没有 `reasoning_efforts` 字段）时的兜底档位。
 *
 * 这三个值是 OpenAI 系的标准档，也是实测里**所有可调通模型都接受**的一档
 * （见 bridge 的 REASONING_EFFORTS_BY_MODEL 注释）—— 宁可少两档，
 * 也不要给出上游不接受的值（那正是"选了就报错"的来源）。
 */
export const FALLBACK_EFFORTS = ['low', 'medium', 'high'];

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

/** 失败时给用户一句"下一步做什么"（dsh 只展示 message，错误码本身不解释）。 */
export const ERROR_HINTS = {
  [CODE.AUTH]: '登录态可能已失效：在 WorkBuddy 桌面端重新登录后重试。',
  [CODE.QUOTA]: '积分不足：签到可领取每日积分，或换一个免费模型。',
  [CODE.RATE_LIMIT]: '触发上游频率限制：稍等再试，或换一个模型。',
  [CODE.CONTEXT]: '上下文超出该模型上限：压缩对话，或换上下文更大的模型。',
  [CODE.INVALID]: '上游拒绝了请求参数（常见：思考强度 / 输出上限不被该模型接受）——换个档位或恢复默认参数。',
  [CODE.TRANSPORT]: '本地桥连接异常：运行 /workbuddy restart 或确认桥进程还活着。',
};

/** 把上游错误文本 / HTTP 状态分类成 dsh 错误码。 */
export function classifyError(message, status) {
  const text = String(message || '');
  // 桥把"上游登录态失效"包成 502（本地令牌没错，错的是上游会话）——
  // 按 AUTH 归类，避免 dsh 把它当 5xx 重试两次再报同一个错。
  if (/upstream login expired|re-?login in the workbuddy/i.test(text)) return CODE.AUTH;
  if (status === 401 || status === 403 || /\b(?:401|403)\b/.test(text)) return CODE.AUTH;
  if (/quota|insufficient|balance|积分|余额/i.test(text)) return CODE.QUOTA;
  if (status === 429 || /\b429\b|rate.?limit|too many requests/i.test(text)) return CODE.RATE_LIMIT;
  if (/context|token.{0,12}(?:limit|exceed)|maximum context/i.test(text)) return CODE.CONTEXT;
  if (status === 400 || status === 422 || /\b(?:400|422)\b|invalid.?request/i.test(text)) return CODE.INVALID;
  if (status >= 500 || /\b5\d\d\b/.test(text)) return CODE.SERVER;
  if (/timeout|timed?\s*out|ETIMEDOUT/i.test(text)) return CODE.TIMEOUT;
  // 「流中途断了」是传输层故障（可重试），不能落到 PROVIDER_ERROR：
  // 桥补发的错误帧消息形如 "upstream stream interrupted before completion: …"。
  if (/stream (?:interrupted|ended before)|interrupted before completion/i.test(text)) return CODE.TRANSPORT;
  if (/fetch failed|ECONN|socket|network|terminated|prematurely/i.test(text)) return CODE.TRANSPORT;
  return 'PROVIDER_ERROR';
}

/**
 * 取一组「同义字段」里最大的有限数值。
 *
 * 上游对同一件事常有多种写法，且**会同时下发真实值与恒 0 的占位**：本机实测
 * `prompt_tokens_details.cached_tokens = 1280` 与顶层 `cached_tokens = 0` 并存，
 * 用 `??` 逐个回退会被那个 0 直接挡住（0 不是 nullish）。取最大值只在这组确实
 * 是同一语义的别名时才安全，而它们全都是「缓存读」。
 */
function maxAlias(values) {
  let best = 0;
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n) && n > best) best = n;
  }
  return best;
}

/**
 * OpenAI usage → dsh TokenUsage。缺失字段省略，不编造 0。
 *
 * **`inputTokens` 是「未命中缓存的输入」，不是上游的 `prompt_tokens`。**
 * 契约依据（均来自 dsh 自身实现，非推测）：
 *   - `dsh-token-meter` 的 usage 投影：`uncachedInputTokens: usage.inputTokens`
 *     —— 它把适配器给的 inputTokens 直接当作「未命中」桶；
 *   - 会话命中率 = `cacheReadTokens / (uncachedInputTokens + cacheReadTokens +
 *     cacheWriteTokens)`（三个互斥计费桶之和）；
 *   - 内置适配器的算法：`input = max(0, prompt_tokens - cacheRead - cacheWrite)`，
 *     且 `totalTokens = input + output + cacheRead + cacheWrite`。
 *
 * 上游的 `prompt_tokens` 恰恰相反，是**含缓存**的全部输入（实测
 * `cached_tokens=1280` + `prompt_cache_miss_tokens=176` = `prompt_tokens=1456`）。
 * 所以把 prompt_tokens 直接映射过去，等于把缓存部分在分母里再算一遍：
 * 命中率会变成 `cached / (prompt + cached)`，**上限被死死压到 50%**（全命中时
 * 1280/(1456+1280) = 46.8%，而真实值是 87.9%）。
 */
export function mapUsage(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const hasPrompt = raw.prompt_tokens != null || raw.input_tokens != null;
  const promptTokens = Number(raw.prompt_tokens ?? raw.input_tokens ?? 0) || 0;
  const output = Number(raw.completion_tokens ?? raw.output_tokens ?? 0) || 0;
  // 缓存读（命中）/ 缓存写：字段名与内置适配器同一套，另兼容 Anthropic 风格别名
  const cacheRead = maxAlias([
    raw.prompt_tokens_details?.cached_tokens,
    raw.prompt_cache_hit_tokens,
    raw.cache_read_tokens,
    raw.cache_read_input_tokens,
    raw.cached_tokens,
  ]);
  const cacheWrite = maxAlias([
    raw.prompt_tokens_details?.cache_write_tokens,
    raw.prompt_cache_write_tokens,
    raw.cache_creation_input_tokens,
  ]);
  /*
   * ⚠️ 桶之和**必须**等于 `totalTokens`。
   *
   * 契约（`docs/dsh-llm-adapter-contract.md` §6）要求
   * `totalTokens = input + output + cacheRead + cacheWrite`，并且明确写着：
   * 数字不可信 / 总数冲突时，`dsh-token-meter` 的整次测量会**直接丢弃**
   * （"returns no result when … counts are unsafe, or exact totals conflict"）。
   *
   * 上游**只给 `total_tokens`、不给 `prompt_tokens`** 时，原实现把 prompt 当 0，
   * 于是产出自相矛盾的对象：`{inputTokens:0, outputTokens:0, totalTokens:1050}`
   * （桶和 0 ≠ 1050）—— 既触发上面的"冲突即丢弃"，又形同一个
   * **"这次请求没花钱"的零点声明**（契约 §6 特别点名：零点声明比不给更糟）。
   *
   * 所以缺 prompt 时按恒等式**从 total 反推** input：这样桶和永远自洽、
   * `totalTokens` 这个锚点仍是上游原值，不会丢测量。
   */
  const totalRaw = Number(raw.total_tokens ?? 0) || 0;
  let input;
  if (!hasPrompt && totalRaw > 0) {
    input = Math.max(0, totalRaw - output - cacheRead - cacheWrite);
  } else {
    // 上游若直接给了未命中计数（DeepSeek 原生 prompt_cache_miss_tokens），优先采信它 ——
    // 但只在与另外两个桶**自洽**（相加等于 prompt_tokens）时才采信，避免上游漏报时倒推。
    const miss = Number(raw.prompt_cache_miss_tokens);
    const missSelfConsistent = Number.isFinite(miss) && miss >= 0
      && miss + cacheRead + cacheWrite === promptTokens;
    input = missSelfConsistent ? miss : Math.max(0, promptTokens - cacheRead - cacheWrite);
  }
  const total = totalRaw || input + output + cacheRead + cacheWrite;
  const reasoning = Number(raw.completion_tokens_details?.reasoning_tokens ?? raw.reasoning_tokens ?? 0) || 0;
  const usage = { inputTokens: input, outputTokens: output, totalTokens: total };
  if (cacheRead > 0) usage.cacheReadTokens = cacheRead;
  if (cacheWrite > 0) usage.cacheWriteTokens = cacheWrite;
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
      /*
       * ⚠️ "有内容"的判据必须同时认**字符串**与**多段数组**。
       *
       * 原先只判 `typeof content === 'string'`。而助手消息一旦带图，content 就是
       * `[{type:'text'},{type:'image_url'}]` 这种数组 —— 被这里判成"空助手轮"
       * **整条丢掉**：不光丢图，连文字也一起没了（实测：助手轮直接从历史里消失，
       * 表现为模型"忘了自己刚说过什么"）。
       *
       * 数组形态要求至少有一个真有内容的段（text 非空，或有 image_url）。
       */
      const c = message.content;
      const hasText = (typeof c === 'string' && c.length > 0)
        || (Array.isArray(c) && c.some((p) => (
          (p?.type === 'text' && typeof p.text === 'string' && p.text.length > 0)
          || p?.type === 'image_url'
        )));
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
    /*
     * ⚠️ 助手消息里的**图片块**也要带上（2026-10-13 修）。
     *
     * 原先这里只处理 `text` 与 `tool-call`，`image` 块被**静默丢掉**。
     * 影响的是「模型自己产出过图（截图/绘图）后、用户下一轮追问」：
     * 历史被重发时图没了 → 模型只能凭记忆答，或直接说"我看不到那张图"。
     * 与 user 侧同因：丢了不报错，只是"看不见"。
     *
     * 注意 assistant 的 content 允许为 `null`（只有 tool_calls 时），
     * 所以"有图"时必须换成数组形态，不能仍走 `content: null`。
     */
    const imageParts = [];
    for (const block of blocks) {
      if (block?.type === 'text') textParts.push(block.text || '');
      else if (block?.type === 'tool-call') {
        toolCalls.push({
          id: String(block.id || ''),
          type: 'function',
          function: { name: String(block.name || ''), arguments: String(block.arguments ?? '{}') },
        });
      } else if (block?.type === 'image' && block.offloaded !== true) {
        const url = await resolveImage(block.attachment).catch(() => null);
        if (url) imageParts.push({ type: 'image_url', image_url: { url } });
      }
      // reasoning 块不回灌：兼容端点对 reasoning 字段的接受度不一致，上游也不需要。
    }
    const text = textParts.join('');
    if (imageParts.length) {
      // 多段内容：文字在前、图在后（与 user 侧同序，读起来自然）
      const content = [...(text ? [{ type: 'text', text }] : []), ...imageParts];
      const out = { role: 'assistant', content };
      if (toolCalls.length) out.tool_calls = toolCalls;
      return out;
    }
    const out = { role: 'assistant', content: text || null };
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
    /**
     * 流内错误帧（`data: {"error":{…}}`）。
     *
     * OpenAI 兼容网关表达「这一轮出错」的方式就是这样发一帧 `error` 再 `[DONE]`；
     * 本项目自己的桥在「上游流中途断了」时也补发同一形状（见 bridge 的
     * `upstream stream interrupted before completion`）。
     *
     * 这一帧**没有 `choices`**。原实现的 `pushLine` 只认 `choices`，于是它被
     * 静默忽略；只要此前吐过内容，`finish()` 里的 `mapFinishReason(undefined, …)`
     * 就返回 `stop` —— 用户看到半截回答、dsh 认为成功、不会重试。
     */
    this.error = null;
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
    /*
     * 错误帧必须**先于 choices 判断**接住：OpenAI 兼容网关与本地桥都用
     * `{"error":{…}}`（有的还带 `type:"error"`）表达流内失败，而这一帧没有
     * `choices`。原先直接 `if (!choice) return out` 会把它吞掉，使断流变成
     * 「正常 stop」（见构造函数里 `this.error` 的说明）。
     */
    if (frame.error && typeof frame.error === 'object') {
      const err = frame.error;
      const message = (typeof err.message === 'string' && err.message)
        || (typeof frame.message === 'string' && frame.message)
        || (typeof err.type === 'string' && err.type)
        || '上游在流中途报错';
      const upstreamCode = err.code ?? frame.code;
      this.error = {
        message: upstreamCode !== undefined && upstreamCode !== null && String(upstreamCode)
          ? `${message}（code ${upstreamCode}）`
          : message,
      };
      return out;
    }
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
    if (this.error) {
      // 流内错误：已吐出的块照常收尾（上面已补 block-end），但这一轮**不是成功**。
      out.push({
        type: 'finish',
        reason: { kind: 'error', failure: { message: this.error.message, code: classifyError(this.error.message) } },
      });
      return out;
    }
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
   * @param {{ maxTokens?: number, temperature?: number, reasoningEffort?: string }} [options.defaults]
   *   agent 链路的默认请求参数：调用方没显式给时用这里的值下发。undefined 的字段
   *   完全不下发（交给上游默认）—— 不同模型对 reasoning_effort 接受度不同，不猜。
   */
  constructor(options) {
    this.provider = options.provider;
    this.displayName = options.displayName;
    this.client = options.client;
    this.ensureReady = options.ensureReady || (async () => this.client);
    this.resolveImage = options.resolveImage || (async () => null);
    this.log = options.log || (() => {});
    /** 对话 TRANSPORT 失败时回调（宿主端用来作废「桥活着」的短 TTL 缓存）。 */
    this.onTransportFailure = options.onTransportFailure || (() => {});
    this.filter = {
      allow: Array.isArray(options.filter?.allow) ? options.filter.allow.map(String) : [],
      deny: Array.isArray(options.filter?.deny) ? options.filter.deny.map(String) : [],
      hideAll: options.filter?.hideAll === true,
    };
    /** 构造时的过滤器：面板点「恢复全部」时回到这份配置意图（含 deny）。 */
    this.configFilter = {
      allow: [...this.filter.allow],
      deny: [...this.filter.deny],
      hideAll: this.filter.hideAll,
    };
    this.defaults = options.defaults || {};
    /**
     * 每个模型自己的默认参数（`{ [modelId]: { temperature, maxTokens, reasoningEffort } }`）。
     * 优先级：调用方显式 > 该模型默认 > 全局配置默认 > 不发。
     */
    this.modelParams = {};
    /**
     * 空闲看门狗（毫秒，0 = 关）。**只看"多久没数据"，不看总时长** ——
     * 长回答该等多久等多久，这里只抓"上游卡住不吐字"的场景。
     * 默认关：与项目红线「不加默认上游超时」一致，需要的人显式打开。
     */
    this.streamIdleTimeoutMs = Number(options.streamIdleTimeoutMs) > 0
      ? Number(options.streamIdleTimeoutMs)
      : 0;
    this.catalogTtlMs = options.catalogTtlMs ?? 60_000;
    /** 目录缓存，避免每次模型选择都打一次桥。 */
    this.catalogCache = { at: 0, models: [] };
    /** 最近一次目录请求的刷新结果（`staleMs>0` = 刷新失败、退回旧缓存）。 */
    this.lastRefresh = { refresh: false, staleMs: 0, at: 0 };
    /** 最近一次目录错误的文本，给面板显示。 */
    this.catalogError = '';
  }

  /** 注册时**同步**调用：不能有 I/O。 */
  providerInfo(provider) {
    return { id: provider, name: this.displayName };
  }

  /**
   * 声明「本路由不做图片计价」——**必须存在，不能省略**。
   *
   * dsh 的 `llm.imageRequestPricing(provider, model)` 只对 *适配器本身* 做了可选链
   * （`this.adapters.get(provider)?.adapter.imageRequestPricing(provider, model)`），
   * 对**方法**没有：适配器注册上了但没这个方法，就是
   * `TypeError: ...imageRequestPricing is not a function`。
   *
   * 触发点很具体：**压缩上下文（compact）**要重建历史并按图片计价，于是走这条路径；
   * 平时的纯文本对话不碰它，所以只有 compact 才炸。0.2.1-rc.2 的三处调用点仍无判空。
   *
   * 契约文档（`docs/dsh-llm-adapter-contract.md:892-898`）说「纯文本端点**省略**它即可」，
   * 与运行时的实际行为不一致 —— 按运行时的要求来：返回 `undefined` 表示不声明计价，
   * 由 token meter 退回中性估算，正是我们想要的。
   *
   * 同步、无 I/O（契约要求）；桥这边的目录是异步的，这里也**不能**去查。
   */
  imageRequestPricing() {
    return undefined;
  }

  /**
   * 图片请求尺寸投影：**也不可省略**，原因同上（dsh 对方法不做判空）。
   *
   * 语义照抄 dsh 基础类 `LlmAdapter.imageRequestTarget` 的默认实现 —— **原样透传**：
   * 宽高与字节上限都取图片自身的值，表示「不要为我预缩放，按原图发」。
   * 桥把图片作为 image_url 原样转发给上游，正是这个语义。
   *
   * 返回 `{ width, height, maxBytes }`（`ImageRequestTarget`，三个字段都必填）。
   */
  imageRequestTarget(_provider, _model, image) {
    return {
      width: image?.width,
      height: image?.height,
      maxBytes: image?.bytes,
    };
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
    /*
     * 桥在"强制刷新失败、退回旧缓存"时会带 `staleMs`（缓存有多旧）。
     * 面板必须能说出"这次刷新没成功、你看到的是 N 分钟前的目录" ——
     * 旧实现把它丢掉，刷新失败看起来和成功一模一样。
     */
    this.lastRefresh = {
      refresh: refresh === true,
      staleMs: Number(payload?.staleMs) > 0 ? Number(payload.staleMs) : 0,
      at: Date.now(),
    };
    this.catalogError = '';
    return data;
  }

  /** 失效缓存（面板里「刷新目录」/ 启停桥之后调用）。 */
  invalidate() {
    this.catalogCache = { at: 0, models: [] };
  }

  /**
   * 运行时更新模型过滤器（面板勾选"在 dsh 中显示"时调用）。
   *
   * 为什么不重建适配器：adapter 已注册进 dsh 的 llm 路由，重建意味着解绑重绑
   * （模型选择器会闪断）。过滤只影响 listModels 的输出，改一个字段就够。
   * allow 语义是"只显示勾选的"（空 = 全显示），与配置文件里的 modelAllow 一致。
   */
  setFilter(filter) {
    /*
     * `deny` **不随面板勾选消失**：它是配置文件（modelDeny）表达的排除意图，
     * 面板只表达"显示哪些"。旧实现整体替换 filter，于是用户在面板保存一次
     * 显示设置，配置里的 deny 就被清空 —— 被排除的模型重新出现在选择器里，
     * 而界面上没有任何地方提示这件事。
     */
    this.filter = {
      allow: Array.isArray(filter?.allow) ? filter.allow.map(String) : this.filter.allow,
      deny: Array.isArray(filter?.deny) ? filter.deny.map(String) : this.filter.deny,
      hideAll: filter?.hideAll === true,
    };
  }

  /** 运行时更新「每模型默认参数」（面板保存后即时生效，无需重建适配器）。 */
  setModelParams(map) {
    this.modelParams = map && typeof map === 'object' && !Array.isArray(map) ? map : {};
  }

  /** 当前生效的每模型默认参数快照。 */
  modelParamsSnapshot() {
    return { ...(this.modelParams || {}) };
  }

  /** 回到构造时的配置过滤器（面板「恢复全部」/ 未设置偏好时使用）。 */
  resetFilter() {
    this.filter = { ...this.configFilter, allow: [...this.configFilter.allow], deny: [...this.configFilter.deny] };
  }

  /** 当前生效的过滤器快照（面板展示"哪些是配置排除的"用）。 */
  filterSnapshot() {
    return { ...this.filter, allow: [...this.filter.allow], deny: [...this.filter.deny] };
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
      // 选择器里唯一能看到"这个模型多大 / 多贵 / 吃不吃图"的地方：
      // dsh 的 LlmModelInfo 只带 id/name/description/inputModalities。
      ...(m.description ? { description: m.description } : {}),
      ...(m.inputModalities ? { inputModalities: m.inputModalities } : {}),
    }));
  }

  /**
   * 单个模型的精确元数据（上下文 / 输出上限 / 推理等级）。
   *
   * reasoning 元数据的形状由 dsh 的 llm 服务校验（INVALID_MODEL_REASONING）：
   * `efforts` 每项 {id, name} 且 id 非空不重复；`defaultEffort` 必须在 efforts 里。
   * 选择器据此显示"推理等级"下拉；用户选的值经 stream(options.reasoningEffort)
   * 回到我们这里，翻成上游的 reasoning_effort（见 stream 内）。
   *
   * 档位来源分三种：
   *   1. 桥给了 `reasoning_efforts`（**每模型实测**的档位表）→ 照单全给。
   *      **显式空数组也算数**：那是桥实测"一个档都不收"（如网关暂时不接的
   *      claude-*），此时不给 reasoning 字段，选择器不显示思考强度；
   *   2. 桥老、没这个字段、但目录说支持推理 → 退回 FALLBACK_EFFORTS（低/中/高）；
   *   3. 目录没说支持推理 → 不给 reasoning 字段（发了上游可能 400，
   *      与"不猜参数"同一原则）。
   */
  async resolveModel(provider, model) {
    const catalog = await this.catalog();
    const hit = catalog.find((m) => m && m.id === model);
    if (!hit) return { provider, id: model, name: model };
    const [mapped] = toAdapterModels([hit]);
    const levels = Array.isArray(mapped?.reasoningEfforts)
      ? mapped.reasoningEfforts
      : (mapped?.reasoning ? FALLBACK_EFFORTS : []);
    // defaultEffort 必须在列表里（dsh 会校验）：优先 medium，退 high，再退化到最强档
    const defaultEffort = ['medium', 'high'].find((e) => levels.includes(e)) || levels[levels.length - 1];
    return {
      provider,
      id: model,
      name: mapped?.name || model,
      ...(mapped?.description ? { description: mapped.description } : {}),
      ...(mapped?.contextWindow ? { context: { contextWindow: mapped.contextWindow } } : {}),
      ...(mapped?.maxTokens ? { defaultMaxTokens: mapped.maxTokens } : {}),
      ...(mapped?.inputModalities ? { inputModalities: mapped.inputModalities } : {}),
      ...(levels.length
        ? { reasoning: { efforts: levels.map((id) => ({ id, name: EFFORT_NAMES[id] || id })), defaultEffort } }
        : {}),
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
      this.onTransportFailure();
      yield { type: 'finish', reason: { kind: 'error', failure: { message: `本地桥不可用：${error?.message || error} —— ${ERROR_HINTS[CODE.TRANSPORT]}`, code: CODE.TRANSPORT } } };
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
      // 参数优先级：调用方显式给的 > 该模型自己的默认 > 插件全局默认 > 不发。
      // 刻意不用 ?? 链合并成一层：显式 undefined 与"没配"是同一件事，
      // 但显式 0（temperature=0 是合法值）必须被保留。
      const perModel = this.modelParams?.[model] && typeof this.modelParams[model] === 'object'
        ? this.modelParams[model]
        : {};
      const hasCallerTemp = typeof options.temperature === 'number';
      const temperature = hasCallerTemp
        ? options.temperature
        : (typeof perModel.temperature === 'number' ? perModel.temperature : this.defaults.temperature);
      if (typeof temperature === 'number') payload.temperature = temperature;
      const callerMax = typeof options.maxTokens === 'number' && options.maxTokens > 0;
      const maxTokens = callerMax
        ? options.maxTokens
        : (Number(perModel.maxTokens) > 0 ? Number(perModel.maxTokens) : this.defaults.maxTokens);
      if (typeof maxTokens === 'number' && maxTokens > 0) payload.max_tokens = maxTokens;
      // 推理强度：选择器里用户选的（options.reasoningEffort）优先；其次该模型的
      // 默认；最后全局默认。都没有就完全不发 —— 上游对未知/无意义参数的容忍度
      // 不一，不猜（与 max_tokens/temperature 同一原则）。
      const reasoningEffort = typeof options.reasoningEffort === 'string' && options.reasoningEffort
        ? options.reasoningEffort
        : (typeof perModel.reasoningEffort === 'string' && perModel.reasoningEffort
          ? perModel.reasoningEffort
          : this.defaults.reasoningEffort);
      if (reasoningEffort) payload.reasoning_effort = reasoningEffort;
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
      if (!aborted) this.onTransportFailure(); // 桥可能刚挂：作废「活着」缓存，下次先探测
      yield {
        type: 'finish',
        reason: aborted
          ? { kind: 'aborted', failure: { message: '已取消', code: CODE.ABORTED } }
          : { kind: 'error', failure: { message: `本地桥连接失败：${error?.message || error} —— ${ERROR_HINTS[CODE.TRANSPORT]}`, code: CODE.TRANSPORT } },
      };
      return;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let detail = text;
      let codeLabel = null;
      try {
        const parsed = JSON.parse(text);
        // 桥现在包成 { error: { message, type, code } }（上游原始字段名兜底兼容）
        detail = parsed?.error?.message || parsed?.msg || parsed?.message || text;
        const rawCode = parsed?.error?.code ?? parsed?.code;
        codeLabel = rawCode === undefined || rawCode === null ? null : String(rawCode);
      } catch { /* 非 JSON 错误体，保留原文 */ }
      const failureCode = signal?.aborted
        ? CODE.ABORTED
        : classifyError(`${detail} ${codeLabel || ''}`, res.status);
      /*
       * 错误消息要给**下一步动作**，不能只有上游原文：dsh 的界面只展示 message，
       * 用户看到 "upstream 400: the request parameters were rejected" 时无从下手。
       */
      const hint = ERROR_HINTS[failureCode];
      const message = `上游 ${res.status}：${String(detail || '').slice(0, 400)}`
        + `${codeLabel ? `（code ${codeLabel}）` : ''}`
        + `${hint ? ` —— ${hint}` : ''}`;
      this.log(`chat failed model=${model} status=${res.status}`, String(detail || '').slice(0, 200));
      yield {
        type: 'finish',
        reason: {
          kind: signal?.aborted ? 'aborted' : 'error',
          failure: {
            message,
            code: failureCode,
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
    /*
     * ⚠️ 取 reader 必须在 try **内部**。
     *
     * `res.body` 理论上总是有 `getReader()`（`client.chat` 走 fetch，200 且
     * 有体时一定有流），但适配器的硬契约是「任何失败都以 finish 块收尾、
     * 绝不向调用方抛」。放在 try 外面时，一个不合形状的响应（替身 / 中间层 /
     * 将来换传输）会让 `getReader is not a function` 直接冒泡出去，
     * 契约当场破裂 —— 实测被打桩测试抓到。
     */
    let reader = null;
    try {
      reader = res.body.getReader();
      /*
       * 空闲看门狗：只对"读到下一块"计时。上游卡住（不回也不断）时，
       * 旧实现会永远等下去 —— dsh 一直转圈，用户只能手动取消。
       * 默认 0（关），显式配置后才启用，符合「不加默认上游超时」的红线。
       */
      const readNext = async () => {
        if (!this.streamIdleTimeoutMs) return reader.read();
        let timer = null;
        const idle = new Promise((_, reject) => {
          timer = setTimeout(() => {
            const error = new Error(`上游 ${Math.max(1, Math.round(this.streamIdleTimeoutMs / 1000))} 秒没有返回数据`);
            error.code = 'IDLE_TIMEOUT';
            reject(error);
          }, this.streamIdleTimeoutMs);
        });
        try {
          return await Promise.race([reader.read(), idle]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      };
      for (;;) {
        const { done, value } = await readNext();
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
      const idleTimeout = error?.code === 'IDLE_TIMEOUT';
      this.log(`stream interrupted model=${model}`, error?.message || error);
      yield {
        type: 'finish',
        reason: aborted
          ? { kind: 'aborted', failure: { message: '已取消', code: CODE.ABORTED } }
          : (idleTimeout
            ? { kind: 'error', failure: { message: `${error.message} —— 已停止等待，可重试或换模型。`, code: CODE.TIMEOUT } }
            : { kind: 'error', failure: { message: `流中断：${error?.message || error} —— 上游连接提前结束，可重试或换模型。`, code: CODE.TRANSPORT } }),
      };
    } finally {
      /*
       * 消费方**提前退出**（不再 next()，dsh 会对迭代器调 `return()`）时，这个
       * 生成器在 yield 点被就地恢复并跑 finally —— 此时上游的响应体还开着。
       * 契约要求适配器主动收掉它（`docs/dsh-llm-adapter-contract.md` §4.6：
       * "adapters abort the underlying fetch from their own `finally` so the
       * socket does not leak"），否则每次"用户停止"都白留一条上游连接，
       * 直到上游把整段回答吐完。
       *
       * `cancel()` 会一路传到被包装的源流，进而 abort 掉 fetch —— 与调用方
       * signal 那条路径互补：signal 管"上层要取消"，这里管"消费者不要了"。
       *
       * `reader` 为 null 表示连 `getReader()` 都没成功（响应体不合形状）：
       * 那种情况已在 catch 里报过错，这里无事可做。
       */
      if (reader) await reader.cancel().catch(() => {});
    }
  }
}
