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

/**
 * 把桥的一个模型对象翻译成 dsh 适配器的模型元数据。
 * @param {object} model 桥上 `/v1/models` 的一项
 */
export function toAdapterModel(model) {
  const id = String(model.id);
  const contextWindow = Number(model.context_window || model.contextWindow || 0) || undefined;
  const maxTokens = Number(model.max_output_tokens || model.maxTokens || 0) || undefined;
  const images = model.supports_images === true || model.images === true;
  const reasoning = model.reasoning === true;
  return {
    id,
    name: String(model.name || id),
    ...(contextWindow ? { contextWindow } : {}),
    ...(maxTokens ? { maxTokens } : {}),
    inputModalities: images ? ['text', 'image'] : ['text'],
    ...(reasoning ? { reasoning: true } : {}),
  };
}

/**
 * 目录 → 适配器模型列表。
 * @param {Array<object>} catalog 桥 `/v1/models?all=1` 的 data
 * @param {{ allow?: string[], deny?: string[] }} [filter]
 */
export function toAdapterModels(catalog, filter = {}) {
  const allow = new Set((filter.allow || []).map(String));
  const deny = new Set((filter.deny || []).map(String));
  const seen = new Set();
  const out = [];
  for (const raw of catalog || []) {
    if (!raw || typeof raw.id !== 'string' || !raw.id) continue;
    if (!isChatModel(raw.id)) continue;
    if (allow.size > 0 && !allow.has(raw.id)) continue;
    if (deny.has(raw.id)) continue;
    if (seen.has(raw.id)) continue;
    seen.add(raw.id);
    out.push(toAdapterModel(raw));
  }
  return out;
}

/** 桥侧的完整目录（含 credits / vendor 等展示字段），给面板与工具用。 */
export function toDirectory(catalog) {
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
      return {
        id: m.id,
        name: String(m.name || m.id),
        contextWindow: Number(m.context_window || 0) || null,
        maxTokens: Number(m.max_output_tokens || 0) || null,
        images: m.supports_images === true,
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
