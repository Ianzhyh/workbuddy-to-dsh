/**
 * 把 dsh 内置的 Web search provider 一键指向 WorkBuddy 本地桥。
 *
 * 只改两处：
 *   - `web-search-deepseek.baseURL` → 本地桥 `/v1`（provider 会追加 `/messages`）；
 *   - `web-search-deepseek.apiKeyEnv` → 一个**独立**的凭据引用
 *     `WORKBUDDY_SEARCH_BRIDGE_KEY`，值为桥本地令牌。
 * 不改用户的 `DEEPSEEK_API_KEY`，也不把令牌写进 settings/patch 文件。
 *
 * 这两个服务由 dsh 宿主提供；插件不 import dsh 内部包，保持 vendor 形态可用。
 */

export const WEB_SEARCH_ENTRY_ID = 'web-search-deepseek';
export const WEB_ENTRY_ID = 'web';
export const SEARCH_KEY_REF = 'WORKBUDDY_SEARCH_BRIDGE_KEY';

/**
 * 网页搜索当前实际用的**通道**（issue #33）。
 *
 * 为什么需要这个枚举：面板原先只有「已接入本地桥 / 未接入」两态，于是把
 * **用户主动选择的其它渠道**也报成「需要处理的问题」，还写了句「会消耗
 * DeepSeek 钱包」—— 既冤枉了用户的选择，也对非 DeepSeek 的渠道说了假话
 * （第三方端点、`deepseek-search-api` 这类都不是同一个计费口径）。
 *
 * 现在四态分开：
 *   - `bridge`            走 WorkBuddy 本地桥；
 *   - `deepseek-official` 走 dsh 自带的 DeepSeek 官方搜索（默认形态）；
 *   - `external`          用户自己配的第三方端点/其它 provider —— 这是**选择**，不是故障；
 *   - `unknown`           读不到配置 / dsh 没加载搜索 provider —— 这才是需要提示的。
 */
export const SEARCH_CHANNEL_BRIDGE = 'bridge';
export const SEARCH_CHANNEL_DEEPSEEK = 'deepseek-official';
export const SEARCH_CHANNEL_EXTERNAL = 'external';
export const SEARCH_CHANNEL_UNKNOWN = 'unknown';

/** 面板「切到 X」用的稳定值（与上面的通道一一对应，只有一个方向是 external 之外）。 */
export const SEARCH_SWITCH_TARGET_BRIDGE = 'bridge';
export const SEARCH_SWITCH_TARGET_DEEPSEEK = 'deepseek-official';

/**
 * @param {object} deps
 * @param {{ update: (ns: string, patch: object) => Promise<void>, get?: (ns: string) => unknown }} deps.settings
 * @param {{ set: (ref: string, value: string) => Promise<void> }} deps.credentials
 * @param {string} deps.baseURL 例如 http://127.0.0.1:8790/v1
 * @param {string} deps.token 桥本地令牌
 * @returns {Promise<{ baseURL: string, provider: string, apiKeyRef: string, providerSelected: boolean, clearedLiteralKey: boolean }>}
 */
export async function configureWorkBuddyWebSearch({ settings, credentials, baseURL, token }) {
  if (!settings || typeof settings.update !== 'function') {
    throw new Error('dsh settings service is unavailable; cannot configure web search');
  }
  if (!credentials || typeof credentials.set !== 'function') {
    throw new Error('dsh credentials service is unavailable; cannot store the bridge token');
  }
  if (typeof baseURL !== 'string' || !/^https?:\/\//i.test(baseURL)) {
    throw new Error('invalid bridge base URL for web search');
  }
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('bridge local token is empty; start the bridge first');
  }

  // 1) 独立凭据引用：不碰 DEEPSEEK_API_KEY，避免影响其它 DeepSeek 功能。
  await credentials.set(SEARCH_KEY_REF, token);

  /*
   * 2) 确保选中的是 Messages provider（baseURL/apiKeyEnv 属于它）。
   *
   * 只有 dsh 把 `web` 注册成 settings 分节时才写；rc.6 的 provider 选择在
   * bundle patch 里（默认就是 deepseek-official），并不存在 `web` 分节。
   * 无条件 update 会直接抛 "namespace is not registered"，把一键配置打断。
   */
  let providerSelected = false;
  /*
   * 真实 dsh 的 settings 服务没有 `get(ns)`，只有 `describe()`；这里必须用
   * describe 判断 `web` 分节是否存在，否则永远跳过 provider 选择。
   */
  const config = readWebSearchConfig(settings);
  const hasWebSection = config.hasWeb;
  if (hasWebSection) {
    await settings.update(WEB_ENTRY_ID, { searchProvider: 'deepseek-official' });
    providerSelected = true;
  }

  // 3) 指向桥，并使用上面的独立引用。
  const patch = { baseURL, apiKeyEnv: SEARCH_KEY_REF };
  // 老配置可能把字面 apiKey 写进了分节；provider 会优先用它，导致桥令牌被忽略。
  // 置空即可回落到 apiKeyEnv，同时不把任何秘密写进 settings/patch。
  const current = config.section;
  const clearedLiteralKey = Boolean(current && typeof current === 'object'
    && typeof current.apiKey === 'string' && current.apiKey.length > 0);
  if (clearedLiteralKey) patch.apiKey = '';
  await settings.update(WEB_SEARCH_ENTRY_ID, patch);

  return {
    baseURL,
    provider: 'deepseek-official',
    apiKeyRef: SEARCH_KEY_REF,
    providerSelected,
    clearedLiteralKey,
  };
}

/**
 * 在一键接入前备份 dsh 的搜索配置，供“恢复原配置”使用。
 *
 * 返回值里的 `credential` 是上一份桥令牌，只允许留在插件内存中；
 * 对外的 `summary` 不含令牌，可直接放进状态快照给面板。
 *
 * @param {object} deps
 * @param {{ get?: (ns: string) => unknown, describe?: () => Array<{ ns: string, user?: unknown }>, replace?: (ns: string, section: object) => Promise<void> }} deps.settings
 * @param {{ resolve?: (ref: string) => Promise<{ value: string } | undefined>, set?: (ref: string, value: string) => Promise<void>, unset?: (ref: string) => Promise<void> }} deps.credentials
 * @returns {Promise<{ ok: boolean, at: number, section: object | null, webSection: object | null, credential: string | null, summary: { baseURL: string, apiKeyRef: string, hadLiteralKey: boolean, provider: string } }>}
 */
export async function snapshotWorkBuddyWebSearch({ settings, credentials } = {}) {
  const snapshot = {
    ok: false,
    at: Date.now(),
    section: null,
    webSection: null,
    credential: null,
    summary: { baseURL: '', apiKeyRef: '', hadLiteralKey: false, provider: '' },
  };
  /*
   * 真实 dsh 的 settings 服务**没有 get(ns)**，只有 describe/update/replace。
   * 原先强制要求 get，导致生产环境快照永远 ok:false —— "恢复原配置"不可达，
   * 撤销只能走"按指纹删键"的兜底，可能误删用户自己的同名本机端点。
   */
  if (!settings || (typeof settings.get !== 'function' && typeof settings.describe !== 'function')) return snapshot;
  if (!settings.replace || typeof settings.replace !== 'function') return snapshot;
  if (!credentials || typeof credentials.resolve !== 'function'
    || typeof credentials.set !== 'function' || typeof credentials.unset !== 'function') {
    return snapshot;
  }

  let section;
  let webSection;
  let sectionExists = false;
  let webExists = false;
  try {
    /*
     * 优先用 describe() 的 **user 层**：get() 返回的是 base/default 合并后的
     * 解析值，直接写回去会把 base 里的密钥或默认值“固化”成用户覆盖。
     */
    if (typeof settings.describe === 'function') {
      const descriptors = settings.describe();
      const list = Array.isArray(descriptors) ? descriptors : [];
      const searchDesc = list.find((item) => item && item.ns === WEB_SEARCH_ENTRY_ID);
      const webDesc = list.find((item) => item && item.ns === WEB_ENTRY_ID);
      sectionExists = Boolean(searchDesc);
      webExists = Boolean(webDesc);
      section = searchDesc
        ? (searchDesc.user && typeof searchDesc.user === 'object' && !Array.isArray(searchDesc.user)
          ? { ...searchDesc.user }
          : {})
        : null;
      webSection = webDesc
        ? (webDesc.user && typeof webDesc.user === 'object' && !Array.isArray(webDesc.user)
          ? { ...webDesc.user }
          : {})
        : null;
    } else {
      section = settings.get(WEB_SEARCH_ENTRY_ID);
      webSection = settings.get(WEB_ENTRY_ID);
      sectionExists = section !== undefined;
      webExists = webSection !== undefined;
    }
  } catch { return snapshot; }

  try {
    const resolved = await credentials.resolve(SEARCH_KEY_REF);
    snapshot.credential = resolved && typeof resolved.value === 'string' ? resolved.value : null;
  } catch { return snapshot; }

  snapshot.section = sectionExists && section && typeof section === 'object' && !Array.isArray(section)
    ? { ...section }
    : (sectionExists ? {} : null);
  snapshot.webSection = webExists && webSection && typeof webSection === 'object' && !Array.isArray(webSection)
    ? { ...webSection }
    : (webExists ? {} : null);
  snapshot.summary = {
    baseURL: typeof section?.baseURL === 'string' ? section.baseURL : '',
    apiKeyRef: typeof section?.apiKeyEnv === 'string' ? section.apiKeyEnv : '',
    hadLiteralKey: typeof section?.apiKey === 'string' && section.apiKey.length > 0,
    provider: typeof webSection?.searchProvider === 'string' ? webSection.searchProvider : '',
  };
  // 分节不存在时没有“原配置”可恢复（一键接入本身也会因 namespace 未注册失败）。
  snapshot.ok = sectionExists;
  return snapshot;
}

/**
 * 把 dsh 的搜索配置恢复到一键接入前的快照。
 *
 * 只恢复 `web` / `web-search-deepseek` 两个分节和独立凭据引用；不碰
 * DEEPSEEK_API_KEY 或任何 WorkBuddy 客户端文件。任何一步失败都保留快照，
 * 让用户可以重试。
 *
 * @param {object} deps
 * @param {{ replace?: (ns: string, section: object) => Promise<void> }} deps.settings
 * @param {{ set?: (ref: string, value: string) => Promise<void>, unset?: (ref: string) => Promise<void> }} deps.credentials
 * @param {Awaited<ReturnType<typeof snapshotWorkBuddyWebSearch>>} deps.snapshot
 * @returns {Promise<{ reverted: boolean, summary: object }>}
 */
export async function restoreWorkBuddyWebSearch({ settings, credentials, snapshot } = {}) {
  if (!snapshot?.ok) throw new Error('no restorable web search snapshot');
  if (!settings || typeof settings.replace !== 'function') {
    throw new Error('dsh settings service does not support restoring the previous section');
  }

  const errors = [];
  if (snapshot.webSection !== null) {
    try {
      await settings.replace(WEB_ENTRY_ID, snapshot.webSection);
    } catch (error) {
      errors.push(`web: ${String(error?.message || error)}`);
    }
  }
  try {
    await settings.replace(WEB_SEARCH_ENTRY_ID, snapshot.section || {});
  } catch (error) {
    errors.push(`web-search-deepseek: ${String(error?.message || error)}`);
  }

  if (!credentials || typeof credentials.set !== 'function') {
    errors.push('credentials service is unavailable');
  } else {
    try {
      if (snapshot.credential) await credentials.set(SEARCH_KEY_REF, snapshot.credential);
      else if (typeof credentials.unset === 'function') await credentials.unset(SEARCH_KEY_REF);
      else errors.push('credentials service does not support unset');
    } catch (error) {
      errors.push(`credential: ${String(error?.message || error)}`);
    }
  }

  if (errors.length) throw new Error(`restore incomplete: ${errors.join('; ')}`);
  return { reverted: true, summary: snapshot.summary || {} };
}

const normalizeBaseURL = (value) => (typeof value === 'string' ? value.replace(/\/+$/, '') : '');

/**
 * 这个地址是不是本地桥的搜索入口。
 *
 * 端口不参与判断：桥换端口（改配置、旧进程迁移）后仍应认成“我们自己接的”，
 * 由自动接入自愈，而不是把它误判成用户手工配置的第三方端点。
 */
export function isBridgeSearchEndpoint(value, expectedBaseURL) {
  const actual = normalizeBaseURL(value);
  const expected = normalizeBaseURL(expectedBaseURL);
  if (!actual) return false;
  if (expected && actual === expected) return true;
  try {
    const url = new URL(actual);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname)) return false;
    return url.pathname.replace(/\/+$/, '') === '/v1';
  } catch {
    return false;
  }
}

/**
 * 当前配置是否就是本插件写的那种形态。
 *
 * 只看“像不像”，不证明是谁写的：地址指向本机桥、没有字面 key、凭据引用是
 * 插件专用引用、provider 还是官方默认。自动接入用它区分「自己留下的配置」
 * 和「用户手写的配置」。
 */
export function looksLikeManagedSearchConfig({
  section,
  webSection,
  expectedBaseURL,
  searchKeyRef = SEARCH_KEY_REF,
} = {}) {
  if (!isBridgeSearchEndpoint(section?.baseURL, expectedBaseURL)) return false;
  const apiKeyEnv = typeof section?.apiKeyEnv === 'string' ? section.apiKeyEnv : '';
  if (apiKeyEnv !== '' && apiKeyEnv !== searchKeyRef) return false;
  if (typeof section?.apiKey === 'string' && section.apiKey.length > 0) return false;
  const provider = typeof webSection?.searchProvider === 'string' ? webSection.searchProvider : '';
  return provider === '' || provider === 'deepseek-official';
}

/**
 * 用户是否**显式**选择了搜索后端。
 *
 * 入参必须是 `settings.describe()` 里的 user 层（只含用户改写过的字段），
 * 不能传合并后的解析值 —— 否则 bundle 默认值会被当成用户选择，自动接入永远
 * 不敢动。判据只取“换后端”的字段：baseURL / apiKey / apiKeyEnv / searchProvider；
 * maxUses 这类调参不算。
 */
export function hasExplicitSearchOverride({
  section,
  webSection,
  expectedBaseURL,
  searchKeyRef = SEARCH_KEY_REF,
} = {}) {
  const userSection = section && typeof section === 'object' ? section : {};
  const userWeb = webSection && typeof webSection === 'object' ? webSection : {};
  const baseURL = normalizeBaseURL(userSection.baseURL);
  const managedEndpoint = baseURL !== '' && isBridgeSearchEndpoint(baseURL, expectedBaseURL);

  if (baseURL !== '' && !managedEndpoint) return true;
  if (typeof userSection.apiKey === 'string' && userSection.apiKey.length > 0) return true;
  if (typeof userSection.apiKeyEnv === 'string' && userSection.apiKeyEnv !== ''
    && userSection.apiKeyEnv !== searchKeyRef) return true;
  const provider = typeof userWeb.searchProvider === 'string' ? userWeb.searchProvider : '';
  if (provider !== '' && provider !== 'deepseek-official') return true;
  // 显式选回官方 DeepSeek，但端点却不是桥：这是用户的决定，不能覆盖。
  if (provider === 'deepseek-official' && !managedEndpoint) return true;
  return false;
}

/**
 * 启动时要不要自动接入。
 *
 * @returns {{ action: 'configure' | 'skip' | 'wait', reason: string }}
 *   - configure：可以写配置（auto = 首次接入，heal = 修复令牌/端口漂移）
 *   - skip：用户显式配置、已接入、或宿主没有搜索 provider
 *   - wait：桥/服务还没就绪，稍后再试
 */
export function decideWebSearchAutoSetup({
  enabled = true,
  status,
  explicitOverride = false,
  managed = false,
  bridgeState = 'stopped',
} = {}) {
  if (!enabled) return { action: 'skip', reason: 'disabled' };
  if (!status || status.available !== true) return { action: 'wait', reason: 'unavailable' };
  if (status.reason === 'namespace-missing') return { action: 'skip', reason: 'unavailable' };
  // 读配置本身失败时绝不能“当作没配过”然后去写，先等下一轮。
  if (status.reason === 'error') return { action: 'wait', reason: 'settings' };
  if (status.configured === true && status.tokenMatches !== false) {
    return { action: 'skip', reason: 'configured' };
  }
  if (explicitOverride && !managed) return { action: 'skip', reason: 'explicit' };
  if (bridgeState !== 'running') return { action: 'wait', reason: 'bridge' };
  return { action: 'configure', reason: managed ? 'heal' : 'auto' };
}

/**
 * 读搜索配置的**生效值 + 用户层**。
 *
 * 这台 dsh 的 `settings` 服务只有 `describe()/update()/replace()`，**没有
 * `get(ns)`**；旧代码用 `settings.get` 判断，结果把真实存在的搜索配置误判成
 * “不可用”，自动接入也被跳过（issue #7 里入口看起来消失的根因）。
 *
 * 读取顺序：
 *   1. 有 `describe()` 就以它为准（`value` = 生效值，`user` = 用户改写层）；
 *   2. 兼容只有 `get(ns)` 的旧宿主；
 *   3. 两者都没有 → 不可用。
 *
 * 某些测试桩的 `describe()` 只给 `user` 不给 `value`，此时用 `get` 补生效值；
 * 两者都没有时用空对象，交给调用方按“分节存在但为空”处理。
 *
 * @returns {{
 *   available: boolean, error: boolean, section: object | undefined,
 *   webSection: object | undefined, searchUser: object | null,
 *   webUser: object | null, hasWeb: boolean, source: string
 * }}
 */
export function readWebSearchConfig(settings) {
  const empty = {
    available: false,
    error: false,
    section: undefined,
    webSection: undefined,
    searchUser: null,
    webUser: null,
    hasWeb: false,
    source: 'none',
  };
  if (!settings) return empty;

  let descriptors = null;
  if (typeof settings.describe === 'function') {
    try {
      const list = settings.describe();
      if (Array.isArray(list)) descriptors = list;
    } catch {
      return { ...empty, error: true, source: 'describe' };
    }
  }

  const read = (ns) => {
    let fallback;
    const getValue = () => {
      if (fallback !== undefined) return fallback;
      fallback = null;
      if (typeof settings.get === 'function') {
        try { fallback = settings.get(ns); } catch { fallback = null; }
      }
      return fallback;
    };

    if (descriptors) {
      const descriptor = descriptors.find((item) => item && item.ns === ns);
      if (!descriptor) return { exists: false, value: undefined, user: {} };
      const value = descriptor.value && typeof descriptor.value === 'object'
        ? descriptor.value
        : (getValue() || {});
      return {
        exists: true,
        value,
        user: descriptor.user && typeof descriptor.user === 'object' ? { ...descriptor.user } : {},
      };
    }
    if (typeof settings.get === 'function') {
      const value = getValue();
      return { exists: value !== undefined && value !== null, value, user: null };
    }
    return { exists: false, value: undefined, user: null };
  };

  const search = read(WEB_SEARCH_ENTRY_ID);
  const web = read(WEB_ENTRY_ID);
  return {
    available: search.exists,
    error: false,
    section: search.exists ? search.value : undefined,
    webSection: web.exists ? web.value : undefined,
    searchUser: search.user,
    webUser: web.user,
    hasWeb: web.exists,
    source: descriptors ? 'describe' : (typeof settings.get === 'function' ? 'get' : 'none'),
  };
}

/**
 * 读 describe() 的 user 层（只有用户改写过的字段）。
 * 保留这个轻量入口给恢复/退出自动接入使用；需要生效值时用
 * {@link readWebSearchConfig}（一次 describe 同时拿两份数据）。
 *
 * @returns {{ available: boolean, search: object | null, web: object | null, hasWeb: boolean }}
 */
export function readWebSearchUserLayers(settings) {
  const config = readWebSearchConfig(settings);
  return {
    available: config.available,
    search: config.searchUser,
    web: config.webUser,
    hasWeb: config.hasWeb,
  };
}

/**
 * 把网页搜索**切回 dsh 自带的 DeepSeek 官方搜索**（issue #33）。
 *
 * 与 {@link configureWorkBuddyWebSearch} 完全对称：那个负责"切到本地桥"，这个
 * 负责"切回去"。用户手动切换必须是一条**明确的、可重复执行**的操作，
 * 而不是只能靠「恢复接入前的配置」这个语义模糊的按钮（快照丢了就点不动）。
 *
 * 边界（与恢复/回滚同一条纪律）：
 *   - 只动 `web-search-deepseek` 与 `web` 两个分节里**换后端**的那几个字段；
 *     `maxUses` 这类调参原样保留；
 *   - **删除**桥地址而不是写上官方地址：dsh 的 provider 自己有默认端点，
 *     写死一个地址只会在上游改域名时变成新的故障源；
 *   - `DEEPSEEK_API_KEY` 一个字都不碰（也更不该把桥令牌留在引用里）；
 *   - 用完的独立凭据引用 `WORKBUDDY_SEARCH_BRIDGE_KEY` 顺手清掉 —— 它只属于
 *     桥通道，留着等于留一份无主凭据。
 *
 * @returns {Promise<{ provider: string, removed: string[], credentialCleared: boolean }>}
 */
export async function switchWorkBuddyWebSearchToDeepSeek({
  settings,
  credentials,
  expectedBaseURL = '',
  searchKeyRef = SEARCH_KEY_REF,
  confirmExternal = false,
} = {}) {
  if (!settings || typeof settings.describe !== 'function' || typeof settings.replace !== 'function') {
    throw new Error('dsh settings service does not support switching web search settings');
  }
  const descriptors = settings.describe();
  const list = Array.isArray(descriptors) ? descriptors : [];
  const searchDesc = list.find((item) => item && item.ns === WEB_SEARCH_ENTRY_ID);
  if (!searchDesc) throw new Error('dsh web search section is not configurable');

  // 只改**用户层**：写合并值会把 base 里的默认值固化进 profile。
  const section = searchDesc.user && typeof searchDesc.user === 'object' ? { ...searchDesc.user } : {};
  const removed = [];
  const endpointBefore = typeof section.baseURL === 'string' ? section.baseURL : '';
  /*
   * 端点：只在它确实是**我们写的**时候才直接删。
   *
   * 两个充分条件之一即可（都是我们的指纹）：
   *   · 与当前桥地址完全一致（`expectedBaseURL`）；
   *   · 是本地 /v1 且凭据引用就是插件专用引用（`WORKBUDDY_SEARCH_BRIDGE_KEY`）
   *     —— 端口漂移后地址会对不上，但这个引用是我们独有的。
   *
   * 只看"像不像本机 /v1"是不够的：用户自己起的本地搜索服务（同样是
   * `127.0.0.1:PORT/v1`）会被那种判据认成我们的桥然后删掉。
   */
  const ownedEndpoint = Boolean(endpointBefore)
    && (normalizeBaseURL(endpointBefore) === normalizeBaseURL(expectedBaseURL)
      || (section.apiKeyEnv === searchKeyRef && isBridgeSearchEndpoint(endpointBefore, '')));
  /*
   * 第三方端点：**不替用户删**。
   *
   * 「切到 DeepSeek 官方」在 dsh 里的真实含义就是"让 provider 用它自己的默认
   * 端点"，也就是必须把这个地址去掉。但那是用户自己的配置，静默抹掉既越权、
   * 也让他下次切回来时无处可去 —— 所以必须先要一次明确确认。
   * 确认后才删，并把原值放进返回值里，让调用方有机会存快照。
   */
  const externalEndpoint = Boolean(endpointBefore) && !ownedEndpoint;
  if (externalEndpoint && !confirmExternal) {
    return {
      switched: false,
      needsConfirm: true,
      endpoint: endpointBefore,
      reason: 'external-endpoint',
    };
  }
  if (endpointBefore) {
    delete section.baseURL;
    removed.push('baseURL');
  }
  /*
   * 只有**确认是我们写的**配置才顺手清掉插件专用凭据引用。
   *
   * 不去动用户自己的 `apiKeyEnv`：`MY_KEY` 配合官方默认端点仍然是「官方
   * DeepSeek，只是用自己的计费账号」，那是他的选择；删了就变成"凭据凭空消失"。
   */
  if (section.apiKeyEnv === searchKeyRef && (ownedEndpoint || endpointBefore === '')) {
    delete section.apiKeyEnv;
    removed.push('apiKeyEnv');
  }
  /*
   * 字面 key 只可能是旧版配置遗留：provider 会优先用它，留着就永远绕过引用。
   */
  if (typeof section.apiKey === 'string' && section.apiKey.length > 0) {
    section.apiKey = '';
    removed.push('apiKey');
  }
  // 保留原来的 `{}` 语义：确实什么都没写时也落一次空分节，行为与旧版一致。
  await settings.replace(WEB_SEARCH_ENTRY_ID, section);

  const webDesc = list.find((item) => item && item.ns === WEB_ENTRY_ID);
  if (webDesc) {
    const webSection = webDesc.user && typeof webDesc.user === 'object' ? { ...webDesc.user } : {};
    webSection.searchProvider = 'deepseek-official';
    await settings.replace(WEB_ENTRY_ID, webSection);
  } else {
    /*
     * 没有 `web` 分节（rc.6）时没有 provider 选项可写，只能靠"不指向桥"来表达
     * 官方通道。这里额外写 `apiKeyEnv: DEEPSEEK_API_KEY`：与默认值等价，但它会
     * 进 user 层，自动接入据此认出「用户选过官方」，不会又把桥接回去。
     */
    if (section.apiKeyEnv === undefined) {
      section.apiKeyEnv = 'DEEPSEEK_API_KEY';
      await settings.replace(WEB_SEARCH_ENTRY_ID, section);
    }
  }

  let credentialCleared = false;
  if (credentials && typeof credentials.unset === 'function') {
    try {
      await credentials.unset(searchKeyRef);
      credentialCleared = true;
    } catch { /* 凭据本来就不存在时忽略 */ }
  }
  return {
    switched: true,
    provider: 'deepseek-official',
    removed,
    credentialCleared,
    // 第三方端点在确认后被删掉了：把原值如实交回，调用方可以据此留快照。
    endpoint: '',
    previousEndpoint: endpointBefore,
  };
}

/**
 * 把网页搜索切到本地桥（面板「切到 WorkBuddy」的**手动**入口）。
 *
 * `configureWorkBuddyWebSearch` 只负责写配置；它不知道桥是否在跑、令牌对不对，
 * 也不负责自检。面板按钮需要"点一下就成"的语义，所以把**前置检查**放在这里：
 * 桥没在跑就明确说"先启动桥"，而不是写一份注定 401 的配置再让用户猜。
 *
 * 之所以不把这段塞进 `configureWorkBuddyWebSearch`：自动接入那条路已经在
 * `enableWebSearch()` 里做过同样的检查，且它的错误文案要按"自动/手动"区分。
 *
 * @returns {Promise<{ baseURL: string, provider: string, apiKeyRef: string }>}
 */
export async function switchWorkBuddyWebSearchToBridge({
  settings,
  credentials,
  baseURL,
  token,
} = {}) {
  return configureWorkBuddyWebSearch({ settings, credentials, baseURL, token });
}

/**
 * 没有内存快照时的回滚：只摘掉本插件写进去的字段。
 *
 * 用在「自动接入后重启了 dsh」：这时原配置快照已经随内存消失，但我们仍能
 * 认出自己的指纹（桥地址 + 插件专用凭据引用），把它们删掉就回到 bundle 默认。
 * 不会碰用户的其它搜索字段（maxUses 等）。
 */
export async function resetWorkBuddyWebSearchOverrides({
  settings,
  credentials,
  expectedBaseURL,
  searchKeyRef = SEARCH_KEY_REF,
} = {}) {
  if (!settings || typeof settings.describe !== 'function' || typeof settings.replace !== 'function') {
    throw new Error('dsh settings service does not support inspecting or restoring search settings');
  }
  const descriptors = settings.describe();
  const list = Array.isArray(descriptors) ? descriptors : [];
  const searchDesc = list.find((item) => item && item.ns === WEB_SEARCH_ENTRY_ID);
  if (!searchDesc) throw new Error('dsh web search section is not configurable');

  const section = searchDesc.user && typeof searchDesc.user === 'object' ? { ...searchDesc.user } : {};
  const removed = [];
  if (isBridgeSearchEndpoint(section.baseURL, expectedBaseURL)) {
    delete section.baseURL;
    removed.push('baseURL');
  }
  if (typeof section.apiKeyEnv === 'string' && section.apiKeyEnv === searchKeyRef) {
    delete section.apiKeyEnv;
    removed.push('apiKeyEnv');
  }
  if (section.apiKey === '') {
    delete section.apiKey;
    removed.push('apiKey');
  }
  if (!removed.length) throw new Error('current web search configuration was not installed by WorkBuddy');

  await settings.replace(WEB_SEARCH_ENTRY_ID, section);

  const webDesc = list.find((item) => item && item.ns === WEB_ENTRY_ID);
  if (webDesc) {
    const webSection = webDesc.user && typeof webDesc.user === 'object' ? { ...webDesc.user } : {};
    webSection.searchProvider = 'deepseek-official';
    await settings.replace(WEB_ENTRY_ID, webSection);
  } else {
    // 没有 web 分节时，用显式的默认凭据引用留下“用户选择”标记，
    // 避免下次启动又自动接回来。
    section.apiKeyEnv = 'DEEPSEEK_API_KEY';
    await settings.replace(WEB_SEARCH_ENTRY_ID, section);
  }

  if (credentials && typeof credentials.unset === 'function') {
    try { await credentials.unset(searchKeyRef); } catch { /* 凭据本来就不存在时忽略 */ }
  }
  return { reverted: true, removed, summary: { baseURL: '', apiKeyRef: '' } };
}

/**
 * 回滚之后留下“不要再自动接入”的显式标记。
 *
 * 优先写 `web.searchProvider = deepseek-official`（dsh 认识的原生字段）；
 * 没有 web 分节时写 `apiKeyEnv = DEEPSEEK_API_KEY`。两者都与默认值等价，
 * 但会进入 user 层，自动接入据此尊重用户选择。
 *
 * @returns {{ marked: boolean, reason: string }}
 */
export async function markWorkBuddyWebSearchOptOut({
  settings,
  searchKeyRef = SEARCH_KEY_REF,
} = {}) {
  if (!settings || typeof settings.describe !== 'function' || typeof settings.replace !== 'function') {
    return { marked: false, reason: 'settings-unavailable' };
  }
  const layers = readWebSearchUserLayers(settings);
  if (!layers.available) return { marked: false, reason: 'section-missing' };
  const search = layers.search || {};
  const web = layers.web || {};
  const explicit = hasExplicitSearchOverride({
    section: search,
    webSection: web,
    expectedBaseURL: '',
    searchKeyRef,
  });
  if (explicit) return { marked: false, reason: 'already-explicit' };

  if (layers.hasWeb) {
    await settings.replace(WEB_ENTRY_ID, { ...web, searchProvider: 'deepseek-official' });
    return { marked: true, reason: 'provider' };
  }
  await settings.replace(WEB_SEARCH_ENTRY_ID, { ...search, apiKeyEnv: 'DEEPSEEK_API_KEY' });
  return { marked: true, reason: 'key-ref' };
}

/**
 * 判断 dsh 的网页搜索当前是否真的指向本地桥。
 *
 * 只做配置层判断（不发起搜索）：接口地址、凭据引用、provider 选择三者都对了
 * 才算“已接入”。凭据是否真的存在由调用方查 credentials 后传入。
 *
 * @param {object} deps
 * @param {object | undefined} deps.section `web-search-deepseek` 的已解析分节
 * @param {object | undefined} deps.webSection `web` 分节的已解析值（rc.6 不存在）
 * @param {string} deps.expectedBaseURL 本地桥地址，例如 http://127.0.0.1:8790/v1
 * @param {boolean} deps.keyConfigured 凭据引用（或字面 apiKey）是否已配置
 * @returns {{ configured: boolean, pointsToBridge: boolean, providerSelected: boolean, provider: string, baseURL: string, apiKeyRef: string, reason: string }}
 */
export function deriveWebSearchStatus({ section, webSection, expectedBaseURL, keyConfigured = false }) {
  const baseURL = normalizeBaseURL(section?.baseURL);
  const apiKeyRef = typeof section?.apiKeyEnv === 'string' ? section.apiKeyEnv : '';
  const provider = typeof webSection?.searchProvider === 'string' ? webSection.searchProvider : '';
  const pointsToBridge = baseURL !== '' && baseURL === normalizeBaseURL(expectedBaseURL);
  // rc.6 没有 `web` 分节；没有显式选择时沿用 bundle patch 的 deepseek-official。
  const providerSelected = provider === '' || provider === 'deepseek-official';
  const configured = pointsToBridge && keyConfigured === true && providerSelected;
  const reason = configured
    ? ''
    : !pointsToBridge ? 'endpoint'
      : !keyConfigured ? 'key'
        : 'provider';
  return { configured, pointsToBridge, providerSelected, provider, baseURL, apiKeyRef, reason };
}

/**
 * 网页搜索现在实际走哪条通道（issue #33）。
 *
 * 判据顺序刻意是「先证明确实指向桥，再区分用户选的其它渠道」：
 *   1. 端点确实是本地桥 + provider 没换成别的 → `bridge`（后面再看桥/令牌/凭据是否就绪）；
 *   2. provider 是空或 `deepseek-official` 且端点不是桥 → `deepseek-official`
 *      （dsh bundle 的默认形态：官方搜索）；
 *   3. 有明确的自定义端点（第三方 baseURL / 别的 apiKeyEnv / 别的 provider）
 *      → `external`。**这是用户的选择**，不是故障；
 *   4. 读不到分节 / 宿主没加载搜索 provider → `unknown`（这才是要提示的）。
 *
 * @param {object} deps
 * @param {object | undefined} deps.section `web-search-deepseek` 分节
 * @param {object | undefined} deps.webSection `web` 分节（可能不存在）
 * @param {string} deps.expectedBaseURL 本地桥地址
 * @param {boolean} [deps.available] 分节是否存在（false = dsh 没加载 provider）
 * @param {boolean} [deps.configError] 读配置本身失败
 * @returns {{ channel: string, deliberate: boolean, label: string, endpoint: string, provider: string }}
 *   `deliberate: true` 表示这是「用户选择的结果」，面板不得把它报成需要处理的问题。
 */
export function deriveSearchChannel({
  section,
  webSection,
  expectedBaseURL,
  available = true,
  configError = false,
} = {}) {
  const baseURL = normalizeBaseURL(section?.baseURL);
  const provider = typeof webSection?.searchProvider === 'string' ? webSection.searchProvider : '';
  const unknown = { channel: SEARCH_CHANNEL_UNKNOWN, deliberate: false, label: '', endpoint: baseURL, provider };

  // 读不到配置 / 宿主没加载 provider：这才是需要提示的「不知道」。
  if (configError || !available) return unknown;

  // 1) 指向本地桥 + provider 没换成别的 = 本插件的接入形态。
  //    是否真的能用交给 `deriveWebSearchReadiness`（桥没跑/令牌变了它才是故障）。
  if (isBridgeSearchEndpoint(baseURL, expectedBaseURL)
    && (provider === '' || provider === 'deepseek-official')) {
    return { channel: SEARCH_CHANNEL_BRIDGE, deliberate: true, label: 'bridge', endpoint: baseURL, provider };
  }

  /*
   * 2) 有自定义端点但没指向本机桥 = 用户自己接的第三方通道（可以是官方
   *    DeepSeek 的 anthropic 兼容端点，也可以是任何别的服务）。
   *
   *    这里**不判断它属于谁**：地址不是我们的桥，就不是我们该议论的东西。
   *    面板只能说"当前走 <这个端点>"，不能断言费用、更不能说成故障。
   */
  if (baseURL !== '') {
    return {
      channel: SEARCH_CHANNEL_EXTERNAL,
      deliberate: true,
      label: provider || baseURL,
      endpoint: baseURL,
      provider,
    };
  }

  // 3) 换过 provider、但端点交给 provider 自己决定 = 用户选的另一个后端。
  if (provider !== '' && provider !== 'deepseek-official') {
    return {
      channel: SEARCH_CHANNEL_EXTERNAL, deliberate: true, label: provider, endpoint: '', provider,
    };
  }

  // 4) 其余（含空分节）= dsh 自带官方搜索，也就是默认形态。
  //    `apiKeyEnv` 被改成别的引用但端点没改时仍属官方通道：引用只影响鉴权。
  return {
    channel: SEARCH_CHANNEL_DEEPSEEK,
    deliberate: true,
    label: 'deepseek-official',
    endpoint: '',
    provider: provider || 'deepseek-official',
  };
}

/**
 * 把配置状态、桥状态、凭据是否匹配和最近一次自检合并成面板可用的“现在能不能用”。
 *
 * `configured` 只代表 settings 写对了；桥没跑、令牌被轮换时它仍然为真。
 * 面板必须用这里的 `ready`，否则会出现“绿色但搜索必失败”。
 *
 * @param {object} deps
 * @param {ReturnType<typeof deriveWebSearchStatus>} deps.status
 * @param {string} deps.bridgeState supervisor.probe() 的状态
 * @param {boolean | null} deps.tokenMatches 凭据值是否等于当前桥令牌；null = 无法比对
 * @param {{ at?: number, verified?: boolean | null, sourceCount?: number, error?: string, baseURL?: string } | null} [deps.verification]
 * @param {string} [deps.expectedBaseURL]
 * @returns {{ ready: boolean, reason: string, bridgeState: string, tokenMatches: boolean | null, lastVerifiedAt: string, lastVerifySourceCount: number | null, lastVerifyError: string, lastVerifyStale: boolean, lastVerifyFailed: boolean, lastVerifyVerified: boolean | null }}
 */
export function deriveWebSearchReadiness({
  status,
  bridgeState,
  tokenMatches = null,
  verification = null,
  expectedBaseURL = '',
} = {}) {
  const configReady = status?.configured === true;
  const bridgeReady = bridgeState === 'running';
  const tokenReady = tokenMatches !== false;
  const ready = configReady && bridgeReady && tokenReady;

  let reason = '';
  if (!configReady) reason = typeof status?.reason === 'string' && status.reason ? status.reason : 'config';
  else if (!bridgeReady) {
    // 桥进程在、但登录/令牌/端口有问题：不要笼统说“桥未运行”，那会让用户
    // 去启动一个其实已经在跑的桥。
    if (bridgeState === 'degraded' || bridgeState === 'unauthenticated') reason = 'bridge-auth';
    else if (bridgeState === 'unauthorized' || bridgeState === 'foreign') reason = 'bridge-conflict';
    else reason = 'bridge';
  } else if (tokenMatches === false) reason = 'token';

  const hasVerification = Boolean(verification && verification.at);
  const stale = hasVerification && (
    tokenMatches === false
    || (typeof verification.baseURL === 'string'
      && verification.baseURL !== ''
      && typeof expectedBaseURL === 'string'
      && expectedBaseURL !== ''
      && verification.baseURL.replace(/\/+$/, '') !== expectedBaseURL.replace(/\/+$/, ''))
  );
  return {
    ready,
    reason,
    bridgeState: typeof bridgeState === 'string' ? bridgeState : '',
    tokenMatches: tokenMatches === true || tokenMatches === false ? tokenMatches : null,
    lastVerifiedAt: hasVerification ? new Date(verification.at).toISOString() : '',
    lastVerifySourceCount: hasVerification && Number.isFinite(verification.sourceCount)
      ? verification.sourceCount
      : null,
    lastVerifyError: hasVerification && typeof verification.error === 'string' ? verification.error : '',
    lastVerifyStale: stale,
    lastVerifyFailed: hasVerification && verification.verified === false && !stale,
    lastVerifyVerified: hasVerification && (verification.verified === true || verification.verified === false)
      ? verification.verified
      : null,
  };
}

/**
 * 用 dsh 自己的 web 服务跑一次真实搜索，证明「配置 + 凭据 + 桥」整条链路可用。
 *
 * 这比只回显 baseURL 更可靠：令牌不对、桥没起、provider 没热更，都会在这里
 * 以失败出现，而不是等用户下一次搜索才发现。
 *
 * @param {object} deps
 * @param {{ search: (request: object, signal?: AbortSignal) => Promise<object> } | undefined} deps.web
 * @param {string} [deps.query]
 * @param {number} [deps.maxResults]
 * @param {number} [deps.timeoutMs]
 * @returns {Promise<{ verified: boolean | null, sourceCount?: number, verifyError?: string }>}
 *   `verified: null` 表示当前 dsh 没有 web 服务，跳过自检（不是失败）。
 */
export async function verifyWorkBuddyWebSearch({
  web,
  query = 'WorkBuddy',
  maxResults = 1,
  timeoutMs = 20000,
} = {}) {
  if (!web || typeof web.search !== 'function') return { verified: null };

  const controller = new AbortController();
  let timedOut = false;
  const timer = timeoutMs > 0
    ? setTimeout(() => {
      timedOut = true;
      controller.abort(new Error('web search self-test timed out'));
    }, timeoutMs)
    : null;
  try {
    const result = await web.search({ query, maxResults }, controller.signal);
    const sourceCount = Array.isArray(result?.sources) ? result.sources.length : 0;
    // 自检请求的是固定词；0 来源说明链路有问题（桥回空、provider 没接上），
    // 不能把“没抛错”当成成功。
    if (sourceCount === 0) {
      return { verified: false, sourceCount: 0, verifyError: 'self-test returned 0 sources' };
    }
    return { verified: true, sourceCount };
  } catch (error) {
    return {
      verified: false,
      verifyError: timedOut
        ? `self-test timed out after ${timeoutMs}ms`
        : String(error?.message || error),
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
