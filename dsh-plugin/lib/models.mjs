/**
 * 桥的模型目录 → dsh 的模型元数据。
 *
 * 桥的 `/v1/models` 是「OpenAI 模型对象 + 项目自加的字段」：
 *   id, name, context_window, max_output_tokens, credits, supports_images,
 *   vendor, tags, description_zh, description_en, badge, free
 * 这里只做一次单向映射，保证「模型选择器里看到的上下文 / 输出上限 / 多模态」
 * 与桥上「可用模型」面板里的数字**同源**，不会两处各说一套。
 */

/** 已知的非对话模型（桥的目录层已过滤过一轮，这里是第二道保险）。 */
const NON_CHAT_PATTERNS = [
  /embedding/i,
  /rerank/i,
  /^text-moderation/i,
  /tts/i,
  /whisper/i,
  /image-generation/i,
];

export function isChatModel(id) {
  return !NON_CHAT_PATTERNS.some((re) => re.test(String(id)));
}

/** 目录里的数字 → 短文本：1_000_000 → 1M，128_000 → 128K，8192 → 8192。 */
function shortCount(n) {
  const value = Number(n);
  if (!Number.isFinite(value) || value <= 0) return '';
  if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}M`;
  if (value >= 10_000) return `${Math.round(value / 1000)}K`;
  return String(value);
}

/** 上下文档位数组 → 正整数、去重、升序。 */
function normalizeLengths(list) {
  return [...new Set((Array.isArray(list) ? list : []).map((n) => Number(n))
    .filter((n) => Number.isSafeInteger(n) && n > 0))].sort((a, b) => a - b);
}

/**
 * 该模型已知的上下文上限：显式上限 > 官方可选档最大值。
 *
 * **不拿当前声明值当上限**：老桥 / 精选兜底目录可能没有 `context_window_max`，
 * 此时把“当前值”当上限会让用户选了 600K 却被悄悄按回 300K；与 `.env`
 * 覆盖的旧语义（不知道上限就不收敛）保持一致。
 */
function contextMaxOf(model) {
  const explicit = Number(model?.context_window_max || model?.contextWindowMax) || 0;
  const options = normalizeLengths(model?.context_window_options || model?.contextWindowOptions);
  return Math.max(explicit, ...options, 0);
}

/**
 * dsh 实际使用的上下文容量。
 *
 * 优先级：该模型的面板偏好 > 桥目录里的 `context_window`（可能已被 .env 覆盖）> 0。
 * 偏好是**按模型**传入的；这里只负责按该模型已知的上限收敛 —— 给 300K 的
 * 模型设 1M 也不会让它虚报容量。
 */
export function effectiveContextWindow(model, override = 0) {
  const current = Number(model?.context_window || model?.contextWindow) || 0;
  const wanted = Number(override) > 0 ? Number(override) : current;
  const max = contextMaxOf(model);
  return max && wanted > max ? max : wanted;
}

/**
 * 模型的一句话简介，给 dsh 的模型选择器用。
 *
 * `LlmModelInfo.description` 是契约允许的字段，但 dsh 的**选择器不展示目录里的
 * 其它元数据**（context / maxTokens / credits 只存在于 resolved 形态）。不填这段
 * 文字，30 个模型在选择器里就只剩名字 —— 面板里能看到的上下文、倍率、多模态、
 * 推理能力全都看不见。这里把目录已有的数字拼成一句，两处口径天然同源。
 */
export function describeModel(model, contextOverride = 0) {
  const bits = [];
  const context = shortCount(effectiveContextWindow(model, contextOverride));
  const maxContext = shortCount(contextMaxOf(model));
  if (context) bits.push(`上下文 ${context}${maxContext && maxContext !== context ? `（上限 ${maxContext}）` : ''}`);
  const output = shortCount(model?.max_output_tokens || model?.maxTokens);
  if (output) bits.push(`输出 ${output}`);
  // 积分倍率放到模型名后面（见 modelCostLabel），描述里不再重复一遍
  if (model?.supports_images === true || model?.images === true) bits.push('图片');
  if (model?.supports_reasoning === true || model?.supportsReasoning === true || model?.reasoning === true) bits.push('推理');
  return bits.join(' · ');
}

/**
 * 模型名后缀：让选择器/聊天顶部的模型名直接带上消耗倍率。
 * `credits` 是桥目录里的积分倍率（0.11 = 每次扣 0.11 倍），免费模型给「免费」。
 */
export function modelCostLabel(model) {
  const credits = Number(model?.credits);
  if (model?.free === true || credits === 0) return '免费';
  if (Number.isFinite(credits) && credits > 0) return '×' + String(credits);
  return '';
}

/**
 * 桥的一个模型对象翻译成 dsh 适配器的模型元数据。
 *
 * 能力字段来自桥 `/v1/models`（OpenAI 模型对象 + 项目自加的字段）：
 *   `supports_images` / `supports_reasoning` / `reasoning_efforts` / `only_reasoning`。
 *
 * ⚠️ `reasoning_efforts` 是**每模型实测**出来的档位表（桥侧按 id 查表给出，
 * 见 bridge 的 REASONING_EFFORTS_BY_MODEL）。没有它就不声明推理 —— 老桥没有
 * 这个字段时退回"低/中/高"三档兜底（adapter 里做，见 FALLBACK_EFFORTS）。
 * @param {object} model 桥上 `/v1/models` 的一项
 * @param {{ contextWindow?: number }} [options] 面板选择的上下文预算（0 = 跟随目录）
 */
export function toAdapterModel(model, options = {}) {
  const id = String(model.id);
  const contextWindow = effectiveContextWindow(model, options.contextWindow) || undefined;
  const maxTokens = Number(model.max_output_tokens || model.maxTokens || 0) || undefined;
  const images = model.supports_images === true || model.images === true;
  // 推理能力：桥以 supports_reasoning（上游 supportsReasoning 的透传）标记；
  // 兼容直接给 reasoning:true 的旧形状。
  const reasoning = model.supports_reasoning === true || model.supportsReasoning === true || model.reasoning === true;
  // 档位表：只收非空字符串、去重、保序（dsh 要求 id 非空且不重复）
  const efforts = Array.isArray(model.reasoning_efforts)
    ? [...new Set(model.reasoning_efforts.map((e) => String(e || '').trim()).filter(Boolean))]
    : null;
  const baseName = String(model.name || id);
  const cost = modelCostLabel(model);
  const contextWindowDefault = Number(model.context_window_default) || undefined;
  const contextWindowMax = Number(model.context_window_max) || undefined;
  const contextWindowOptions = Array.isArray(model.context_window_options)
    ? normalizeLengths(model.context_window_options)
    : undefined;
  return {
    id,
    name: cost ? baseName + ' · ' + cost : baseName,
    ...(describeModel(model, options.contextWindow)
      ? { description: describeModel(model, options.contextWindow) }
      : {}),
    ...(contextWindow ? { contextWindow } : {}),
    ...(maxTokens ? { maxTokens } : {}),
    ...(contextWindowDefault ? { contextWindowDefault } : {}),
    ...(contextWindowMax ? { contextWindowMax } : {}),
    ...(contextWindowOptions && contextWindowOptions.length ? { contextWindowOptions } : {}),
    inputModalities: images ? ['text', 'image'] : ['text'],
    ...(reasoning ? { reasoning: true } : {}),
    ...(efforts ? { reasoningEfforts: efforts } : {}),
    ...(typeof model.default_reasoning_effort === 'string' && model.default_reasoning_effort
      ? { defaultReasoningEffort: model.default_reasoning_effort }
      : {}),
    ...(['upstream', 'measured', 'fallback'].includes(model.reasoning_efforts_source)
      ? { reasoningEffortsSource: model.reasoning_efforts_source }
      : {}),
    ...(model.official === true ? { official: true } : model.official === false ? { official: false } : {}),
  };
}

/**
 * 目录 → 适配器模型列表。
 * @param {Array<object>} catalog 桥 `/v1/models?all=1` 的 data
 * @param {{ allow?: string[], deny?: string[] }} [filter]
 */
export function toAdapterModels(catalog, filter = {}) {
  /*
   * `hideAll` 与 `allow: []` 是**两种不同的意图**：
   *   - `allow: []`（未设置）= 没有白名单 → 全显示（旧语义，保留）；
   *   - `hideAll: true`   = 用户在面板点了"全不选" → 一个都不显示。
   * 旧实现只有 allow，空数组被当成"不过滤"，于是面板上"全不选 → 保存"后
   * dsh 里反而**全部还在**（提示语却写着"将不显示"）。
   */
  if (filter?.hideAll === true && !filter?.keep?.length) return [];
  const allow = new Set((filter.allow || []).map(String));
  const deny = new Set((filter.deny || []).map(String));
  // 官方目录外（official === false）默认不进 dsh 选择器；allow 里显式勾选、
  // 或面板打开"显示非官方模型"、或当前 dsh 默认模型就是它（keep）时例外。
  const includeUnofficial = filter?.includeUnofficial === true;
  const keep = new Set((filter?.keep || []).map(String));
  const seen = new Set();
  const out = [];
  for (const raw of catalog || []) {
    if (!raw || typeof raw.id !== 'string' || !raw.id) continue;
    if (!isChatModel(raw.id)) continue;
    const kept = keep.has(raw.id);
    // keep 是“当前正在用的模型”：即使面板勾了别的/全不选，也要留在清单里，
    // 否则用户打开选择器会发现当前模型凭空消失。
    if (filter?.hideAll === true && !kept) continue;
    if (allow.size > 0 && !allow.has(raw.id) && !kept) continue;
    if (deny.has(raw.id)) continue;
    if (raw.official === false && !includeUnofficial && !allow.has(raw.id) && !kept) continue;
    if (seen.has(raw.id)) continue;
    seen.add(raw.id);
    // 上下文预算按模型 id 取：每个模型有自己的官方档位和上限，不能全局一刀切。
    out.push(toAdapterModel(raw, { contextWindow: filter?.contextWindows?.[raw.id] }));
  }
  return out;
}

/**
 * 桥侧的完整目录（含 credits / vendor 等展示字段），给面板与工具用。
 * `contextWindow` 是**实际生效值**（该模型的面板偏好优先）；`contextWindowAuto`
 * 是桥目录里的自动值（官方默认 / .env），官方默认/可选档另列。
 * @param {{ contextWindows?: Record<string, number> }} [options]
 */
export function toDirectory(catalog, options = {}) {
  return (catalog || [])
    .filter((m) => m && typeof m.id === 'string' && isChatModel(m.id))
    .map((m) => {
      // 上游把促销徽章混在 tags 里，形如 `badge:限时免费:#FF0000`。
      // 直接当标签显示就是一条噪音（而且把颜色丢了），所以这里拆出来：
      //   - 干净的标签 → tags
      //   - 结构化的徽章（label + color）→ badges，前端可渲染成带色小胶囊
      const tags = [];
      const badges = [];
      for (const raw of Array.isArray(m.tags) ? m.tags : []) {
        const text = String(raw);
        const match = /^badge:(.+?)(?::(#[0-9a-fA-F]{3,8}))?$/.exec(text);
        if (match) badges.push({ label: match[1], color: match[2] || null });
        else tags.push(text);
      }
      // 桥另外给了字段级 badge（促销标签），补进去并去重
      if (m.badge && !badges.some((b) => b.label === String(m.badge))) {
        badges.push({ label: String(m.badge), color: null });
      }
      // 推理能力：判据与 toAdapterModel **同一套**（supports_reasoning 透传、
      // 兼容旧形状 reasoning:true）—— 两处不一致会让面板说的和 dsh 里能选的对不上。
      const reasoning = m.supports_reasoning === true || m.supportsReasoning === true || m.reasoning === true;
      // 档位表：与 toAdapterModel 同样去空、去重、保序。
      // **注意空数组的语义**：`reasoning_efforts: []` 是桥实测"一个档都不收"
      // （如网关暂时不接的 claude-*）—— 那是"有推理能力但当前无可选档"，
      // 与"没有这个字段"（老桥 / 非推理模型）不同，面板要能分开这两种情形。
      const efforts = Array.isArray(m.reasoning_efforts)
        ? [...new Set(m.reasoning_efforts.map((e) => String(e || '').trim()).filter(Boolean))]
        : null;
      return {
        id: m.id,
        name: String(m.name || m.id),
        contextWindow: effectiveContextWindow(m, options.contextWindows?.[m.id]) || null,
        // 桥目录里的「自动」值（官方默认，或 .env 的全局覆盖），不受面板每模型偏好影响
        contextWindowAuto: Number(m.context_window || 0) || null,
        maxTokens: Number(m.max_output_tokens || 0) || null,
        // 官方 GUI 的上下文档位：默认预算 / 可选档 / 模型上限
        contextWindowDefault: Number(m.context_window_default || 0) || null,
        contextWindowOptions: normalizeLengths(m.context_window_options),
        contextWindowMax: Number(m.context_window_max || 0) || null,
        // 官方默认采样温度（上游目录的 temperature；null = 上游没给）
        defaultTemperature: m.default_temperature != null && Number.isFinite(Number(m.default_temperature))
          ? Number(m.default_temperature)
          : null,
        images: m.supports_images === true,
        // 推理：reasoning=是否支持；efforts=实测档位（null=未知/无此字段，[]=实测无档）
        reasoning,
        efforts,
        // 档位来源：upstream = 官方目录 supportedEfforts；measured = 本地实测表
        effortsSource: ['upstream', 'measured', 'fallback'].includes(m.reasoning_efforts_source)
          ? m.reasoning_efforts_source
          : null,
        defaultEffort: typeof m.default_reasoning_effort === 'string' ? m.default_reasoning_effort : null,
        canDisableThinking: m.can_disable_thinking === true,
        // 官方模型选择器是否列出它（null = 无法判定）
        official: m.official === true ? true : m.official === false ? false : null,
        supplemented: m.supplemented === true,
        // 只推理模型（上游 only_reasoning）：面板据此提示"这是纯思考模型"。
        onlyReasoning: m.only_reasoning === true,
        credits: typeof m.credits === 'number' ? m.credits : null,
        free: m.free === true,
        // 上游的厂商标识是单字母代码（f/j/v/e…），不是名字；原样保留但由界面
        // 标注为"标识"，免得被当成厂商名
        vendor: m.vendor ? String(m.vendor) : null,
        badge: m.badge ? String(m.badge) : (badges[0]?.label ?? null),
        badges,
        description: String(m.description_zh || m.description_en || ''),
        tags,
      };
    });
}

/** 面板/工具里的默认推荐模型：优先免费/精选，其次上下文最大的那个。 */
export function pickDefaultModel(catalog) {
  const list = (catalog || []).filter((m) => m && typeof m.id === 'string' && isChatModel(m.id));
  if (!list.length) return null;
  const preferred = ['deepseek-v4.1-flash', 'deepseek-v4-flash', 'glm-5.3', 'kimi-k3', 'hy4-preview'];
  for (const id of preferred) {
    if (list.some((m) => m.id === id)) return id;
  }
  const free = list.find((m) => m.free === true || m.credits === 0);
  if (free) return free.id;
  return [...list].sort((a, b) => Number(b.context_window || 0) - Number(a.context_window || 0))[0].id;
}

/** 把毫秒时长写成「3 小时 12 分」这样的短文本。 */
export function humanDuration(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '0 分';
  const totalMinutes = Math.floor(n / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const parts = [];
  if (days) parts.push(`${days} 天`);
  if (hours) parts.push(`${hours} 小时`);
  if (!days && minutes) parts.push(`${minutes} 分`);
  return parts.join(' ') || '不到 1 分';
}
