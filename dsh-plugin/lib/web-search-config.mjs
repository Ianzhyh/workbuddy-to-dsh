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
  const hasWebSection = typeof settings.get === 'function' && settings.get(WEB_ENTRY_ID) !== undefined;
  if (hasWebSection) {
    await settings.update(WEB_ENTRY_ID, { searchProvider: 'deepseek-official' });
    providerSelected = true;
  }

  // 3) 指向桥，并使用上面的独立引用。
  const patch = { baseURL, apiKeyEnv: SEARCH_KEY_REF };
  // 老配置可能把字面 apiKey 写进了分节；provider 会优先用它，导致桥令牌被忽略。
  // 置空即可回落到 apiKeyEnv，同时不把任何秘密写进 settings/patch。
  const current = typeof settings.get === 'function' ? settings.get(WEB_SEARCH_ENTRY_ID) : undefined;
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
  const normalize = (value) => (typeof value === 'string' ? value.replace(/\/+$/, '') : '');
  const baseURL = normalize(section?.baseURL);
  const apiKeyRef = typeof section?.apiKeyEnv === 'string' ? section.apiKeyEnv : '';
  const provider = typeof webSection?.searchProvider === 'string' ? webSection.searchProvider : '';
  const pointsToBridge = baseURL !== '' && baseURL === normalize(expectedBaseURL);
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
