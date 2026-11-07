/**
 * 模型拥堵程度 —— 读上游自己的只读探针 `POST /v2/chat/busy`。
 *
 * ## 为什么值得做
 *
 * 「这个模型现在挤不挤」是**选模型时最想知道的一件事**，而目录里没有任何线索：
 * `/v3/config` 只列模型与价格，一个字都不提负载。用户只能靠试 —— 挑一个模型、
 * 等它 429、再换一个。
 *
 * 上游其实发布了这个事实，只是放在一个独立探针里（见 {@link BUSY_PATHS}）。
 * 它是**只读且免费**的（不扣积分、不改账号状态），一次最多问 50 个 id。
 *
 * ## 边界（学自 dsh-connect-workbuddy 的实测经验，并在本机复核）
 *
 *   1. **国际区没有这个端点**：`www.workbuddy.ai` 对同一请求回
 *      `404 {"error_msg":"404 Route Not Found"}`，而同一凭据读它的 `/v3/config`
 *      是正常的 —— 所以不是路径写错、不是权限问题，是那个区上游根本没发布。
 *      国际区因此**每次都失败**：必须由调用方 catch 掉，`/health` 照常返回，
 *      只是没有拥堵数据。**绝不能**用延迟或预扣积分去"推测"一个等级。
 *   2. **不落盘**。拥堵是「这一分钟」的事实：一个能活过重启的等级就是假话。
 *      目录会写盘，等级不会 —— 只挂在内存里的目录条目上，随进程消失。
 *   3. **`unknown` ≠ `normal`**。`unknown` 是"上游没告诉我们"，
 *      `normal` 是"上游说正常"。把前者画成后者就是替上游编事实。
 *   4. **`normal` 不画**。二十个模型里十七个都挂「正常」是装饰不是信息；
 *      只画需要用户做决定的那些（见 {@link busyLabel}）。
 *
 * ## 与「被动推断」的关系
 *
 * 桥里已有一套 `modelBusyStats`：从真实的 429 错误里记录"哪个模型忙过"。
 * 那是**事后**证据，仍然有用（用户刚被限流，面板该说清是哪个模型）。
 * 本模块是**事前**探测，两者互补，不要互相替代：
 *
 *   - 主动探测：现在要选模型 → 看这个
 *   - 被动统计：刚刚失败了 → 看那个
 */

/** 上游的等级枚举，顺序与官方 bundle 一致。 */
export const BUSY_LEVELS = /** @type {const} */ ([
  'idle', 'normal', 'busy', 'congested', 'unavailable', 'unknown',
]);

/**
 * 探针路径，按顺序尝试。
 *
 * 只保留实测评测过的第一条 —— 多看几个拼写没有成本，但**必须**在
 * 「全部 404」时安静地失败（国际区就是这种情况）。
 */
const BUSY_PATHS = ['/v2/chat/busy'];

/** 上游单次调用最多接受的模型 id 数。 */
export const BUSY_BATCH_SIZE = 50;

/**
 * 一次探测的超时。
 *
 * 刻意很短：负载数据回答的是"现在"，一个慢吞吞的探针比它服务的刷新还不值钱，
 * 而且**目录绝不能等它**。超时就当没有数据。
 */
export const BUSY_TIMEOUT_MS = 5_000;

/**
 * 堵的数据多久算过期。
 *
 * 30 秒：比一次对话的间隔略长，又不至于让用户盯着一个十分钟前的"空闲"做决定。
 * 过期后重新探测，但**不阻塞**请求 —— 先回旧值并后台刷新。
 */
export const BUSY_TTL_MS = 30_000;

/**
 * 规范化一个 `busy_level`。枚举外的值一律 `unknown`（不丢条目：
 * "上游说了但我们看不懂"仍然是关于这个模型的一条事实）。
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeBusyLevel(value) {
  return typeof value === 'string' && BUSY_LEVELS.includes(/** @type {any} */ (value))
    ? value
    : 'unknown';
}

/**
 * 把一次探针响应读成 modelId → 等级。
 *
 * 宽容解析：不是对象、没写 model 的条目跳过；枚举外的等级记 `unknown`。
 * @param {unknown} entries `data` 数组
 * @returns {Map<string, string>}
 */
export function parseBusyLevels(entries) {
  const levels = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || typeof entry !== 'object') continue;
    const id = typeof entry.model === 'string' ? entry.model : '';
    if (!id) continue;
    levels.set(id, normalizeBusyLevel(entry.busy_level));
  }
  return levels;
}

/**
 * 把 id 切成上游能接受的批次：去重、保持顺序。
 *
 * 去重是必要的：我们发的名单是"目录 + 用户保留的 id"合并而来，
 * 同一个 id 合法地出现两次，而上游**按你问的条数计**。
 * @param {readonly string[]} ids
 * @param {number} [size]
 * @returns {string[][]}
 */
export function batchModelIds(ids, size = BUSY_BATCH_SIZE) {
  const unique = [...new Set((ids || []).filter((id) => typeof id === 'string' && id !== ''))];
  const limit = Number.isInteger(size) && size > 0 ? size : BUSY_BATCH_SIZE;
  const batches = [];
  for (let i = 0; i < unique.length; i += limit) batches.push(unique.slice(i, i + limit));
  return batches;
}

/** 官方客户端自己的中文措辞。`normal` / `unknown` 没有词。 */
const LABELS_ZH = {
  idle: '空闲',
  busy: '轻微拥堵',
  congested: '极度拥堵',
  unavailable: '不可用',
};

/** 官方客户端自己的英文措辞。 */
const LABELS_EN = {
  idle: 'Idle',
  busy: 'Slightly congested',
  congested: 'Extremely congested',
  unavailable: 'Unavailable',
};

/**
 * 这个等级该不该画出来，画的话用什么词。
 *
 * `normal` 与 `unknown` 都返回空：前者是"健康默认值"，二十行里十七行写「正常」
 * 是噪音；后者是"上游没说"，编一个比不画更糟。
 * @param {string} level
 * @param {'zh'|'en'} [locale]
 * @returns {string}
 */
export function busyLabel(level, locale = 'zh') {
  const table = locale === 'en' ? LABELS_EN : LABELS_ZH;
  return table[level] || '';
}

/**
 * 一个字符代表等级 —— 给**只能渲染纯文本**的位置用（DSH 模型选择器就是这样：
 * 它把 `name` 原样画出来，没有图片槽、不支持标记）。
 *
 * 图形沿用官方客户端的视觉语言：一个人 = 空闲，两个人 = 排队，
 * 三个人挤在一起 = 极度拥堵，划掉 = 不可用。
 * @param {string} level
 * @returns {string}
 */
export function busySymbol(level) {
  switch (level) {
    case 'congested': return '🧍🧍🧍';
    case 'busy': return '🧍🧍';
    case 'normal': return '🧍';
    case 'idle': return '🚀';
    case 'unavailable': return '🚫';
    default: return '';
  }
}

/**
 * 挂到模型名后面的后缀（含前导空格）；不该画时返回空串。
 *
 * 为什么挂在名字上：DSH 渲染 `name` 是逐字的，没有单独的徽标槽位。
 * 模型名本来就是展示用的（所有 join 都按 id），所以这是唯一能"在名字右边"
 * 显示负载的位置。
 *
 * 只画 `busy` / `congested` / `unavailable` / `idle`：
 * 实测国内区 20 个模型里 7 个空闲，每一行都带徽标会变成装饰。
 * @param {string} level
 * @returns {string}
 */
export function busyDisplaySuffix(level) {
  if (!level || level === 'unknown') return '';
  const symbol = busySymbol(level);
  return symbol ? ` ${symbol}` : '';
}

/**
 * 判定一个模型"该不该提醒用户避开"。
 *
 * 只有真的会让人等（或根本用不了）的等级才算 —— `idle` 是好消息，不是警告。
 * @param {string} level
 * @returns {boolean}
 */
export function isBusyLevel(level) {
  return level === 'busy' || level === 'congested' || level === 'unavailable';
}

/**
 * 给一组模型附上等级（返回新数组，不原地改）。
 *
 * 探针没答的模型**保持原样**——对一份刚发现的名单来说那就是"没有等级"。
 * 条目不复制时返回原对象，避免下游无谓的重渲染。
 * @template {{ id: string, busyLevel?: string }} T
 * @param {readonly T[]} models
 * @param {ReadonlyMap<string, string>} levels
 * @returns {T[]}
 */
export function attachBusyLevels(models, levels) {
  return (models || []).map((model) => {
    const level = levels.get(model.id);
    if (level === undefined || level === model.busyLevel) return model;
    return { ...model, busyLevel: level };
  });
}

/**
 * 从一份模型名单里挑出「值得探测」的 id。
 *
 * 非对话模型（图/视频/嵌入）上游不会有负载数据，问了只是浪费一次往返。
 * @param {readonly { id?: string, tag?: string, supportsToolCall?: boolean }[]} models
 * @returns {string[]}
 */
export function probeableModelIds(models) {
  const ids = [];
  for (const m of Array.isArray(models) ? models : []) {
    if (!m || typeof m.id !== 'string' || !m.id) continue;
    // 带媒体 tag 的是生图/生视频模型，不属于 chat 负载探针的范围
    if (typeof m.tag === 'string' && /image|video|embed/i.test(m.tag)) continue;
    ids.push(m.id);
  }
  return ids;
}

/**
 * 探测一次模型负载。失败**抛错**，由调用方决定是否可容忍
 * （区域不支持、网络抖动都应当降级为"没有数据"，而不是让目录也失败）。
 *
 * @param {object} deps
 * @param {(path: string, options?: { body?: any, signal?: AbortSignal }) =>
 *   Promise<{ ok: boolean, status: number, json?: any, text?: string }>} deps.fetchJson
 *   发一次探测请求；由调用方注入（它知道 base、headers、凭据刷新）
 * @param {readonly string[]} deps.modelIds
 * @param {AbortSignal} [deps.signal]
 * @returns {Promise<{ levels: Map<string, string>, path: string }>}
 */
export async function fetchBusyLevels({ fetchJson, modelIds, signal }) {
  const batches = batchModelIds(modelIds);
  if (!batches.length) return { levels: new Map(), path: '' };

  /** 带 HTTP 状态的错误。上游的 404 与 500 必须能区分，见下面的 catch。 */
  class UpstreamBusyError extends Error {
    /**
     * @param {string} message
     * @param {number} status
     */
    constructor(message, status) {
      super(message);
      this.name = 'UpstreamBusyError';
      this.status = status;
    }
  }

  let lastError = null;
  for (const path of BUSY_PATHS) {
    try {
      const levels = new Map();
      for (const batch of batches) {
        const res = await fetchJson(path, { body: { models: batch }, signal });
        if (!res || !res.ok) {
          throw new UpstreamBusyError(
            `upstream ${res?.status || 0} for ${path}`,
            res?.status || 0,
          );
        }
        const payload = res.json;
        // 业务错误码同样算失败：`code !== 0` 时 `data` 不可信
        if (payload && typeof payload === 'object' && payload.code !== undefined && payload.code !== 0) {
          throw new UpstreamBusyError(
            `upstream code ${payload.code}: ${payload.msg || ''}`.trim(),
            res.status,
          );
        }
        for (const [id, level] of parseBusyLevels(payload?.data)) levels.set(id, level);
      }
      return { levels, path };
    } catch (error) {
      lastError = error;
      /*
       * 404/400 是"这个区域没有这个端点"——换下一个拼写试；其余（401/5xx/网络）
       * 直接上抛，别把一次鉴权失败当成"端点不存在"去掩盖。
       */
      const status = /** @type {any} */ (error)?.status;
      if (status !== 404 && status !== 400) throw error;
    }
  }
  throw lastError || new Error('busy probe unavailable');
}
