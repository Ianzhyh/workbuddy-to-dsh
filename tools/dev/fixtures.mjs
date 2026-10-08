/**
 * 控制台 API 的共享桩数据（形状与真实接口一致）。
 *
 * ## 为什么集中在这里
 *
 * 桩数据的字段名一旦与真实接口不一致，页面**不会报错**，只会静默地不渲染 ——
 * 而页面看起来一切正常。这个坑一天里踩了三次，每次都是「以为发现了产品 bug，
 * 其实是自己的夹具错了」：
 *
 *   1. `/api/usage` 的 `models` 写成 `byModel` → **用量表整张没渲染**，
 *      此前所有截图都漏掉了它；
 *   2. `/api/diagnose` 的 `label` 写成 `name` → 诊断面板渲染出一串 `undefined`；
 *   3. `/api/checkin` 的桥挂掉态写成 `{status:{active:false}}`（真实是
 *      `{ok:false,error}`）→ 页面显示「国际版网关不含积分系统」，
 *      看起来像产品在无依据地下结论。
 *
 * 所以桩数据不再由各工具手写，而是**集中在这里维护一份**，并由
 * `ui-harness.openPage` 用 `api-shape.json` 自动校验形状 —— 写错就直接失败。
 *
 * ## 改这里的规矩
 *
 * - 新增字段前先跑 `node tools/dev/api-shape.mjs capture` 拿真实形状；
 * - 只想改数值就传参数（见各 `xxxFixture`），**不要**手写整个对象，
 *   否则容易漏字段（漏了校验会拦，但白跑一趟）。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** 固定时间戳，让截图与断言可复现。 */
export const NOW = 1791200000000;

export const CATALOG = [
  { id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash', context_window: 1000000, max_output_tokens: 128000, credits: 0.11, supports_images: true, supports_reasoning: true },
  { id: 'glm-5.3', name: 'GLM-5.3', context_window: 1000000, max_output_tokens: 64000, credits: 0.79, supports_images: true, supports_reasoning: true },
  { id: 'glm-5.3-flash', name: 'GLM-5.3-Flash', context_window: 1000000, max_output_tokens: 131072, credits: 0.06 },
  { id: 'kimi-k3-1', name: 'Kimi-K3.1', context_window: 960000, max_output_tokens: 32000, credits: 1.62 },
];

/** 桥进程的完整自述（字段与 `/api/overview` 的 bridge 一致）。 */
export function bridgeFixture({ running = true } = {}) {
  if (!running) {
    return {
      running: false, ok: false, host: '127.0.0.1', port: 8790,
      endpoint: 'http://127.0.0.1:8790/v1', error: 'connect ECONNREFUSED 127.0.0.1:8790',
      upstream: '', authFile: '', selectedAuthFile: '', pid: null, startedAt: null, uptimeMs: null,
      catalogSize: null, catalogAt: null, upstreamShape: null,
      autoCheckin: null, autoCheckinEnabled: false,
    };
  }
  return {
    running: true, ok: true, host: '127.0.0.1', port: 8790,
    endpoint: 'http://127.0.0.1:8790/v1', error: null,
    upstream: 'https://copilot.tencent.com',
    authFile: 'C:\\path\\to\\workbuddy-desktop.info',
    selectedAuthFile: 'C:\\path\\to\\workbuddy-desktop.info',
    pid: 18432, startedAt: new Date(NOW - 5400000).toISOString(), uptimeMs: 5400000,
    catalogSize: CATALOG.length, catalogAt: new Date(NOW - 420000).toISOString(),
    // upstreamShape 是目录治理的诊断形状，字段不少；这里按真实结构给全，
    // 免得少一个键就被形状校验拦下（它本身在页面上只用于诊断抽屉）
    upstreamShape: {
      paths: ['/v2/enterprises/personal/models'],
      sources: {},
      model: [],
      dataKeys: [],
      agentsWithModels: 0,
      agentModelsSample: '',
      agentName: '',
      agents: '',
      fillToolCallContentModelWhitelist: '',
      productFeatures: '',
      whitelistSample: '',
      promotionFields: [],
      promotionDetail: [],
      droppedNonChat: [],
    },
    autoCheckin: { at: NOW - 300000, result: 'ok', credit: 18 },
    autoCheckinEnabled: true,
  };
}

/** 凭据状态（`/api/overview` 与 `/api/diagnose` 共用同一形状）。 */
export function credentialsFixture({ active = true } = {}) {
  return {
    files: active ? [{ name: 'workbuddy-desktop.info', isActiveTarget: true, account: '330000000000', domain: 'copilot.tencent.com', encrypted: true, expiresAt: NOW + 37 * 86400000, modifiedAt: NOW - 3600000 }] : [],
    active: active ? {
      keyId: '0123456789abcdef', envelopeKeyId: '0123456789abcdef', keyIdMatches: true,
      encrypted: true, account: '330000000000', userId: '00000000-0000-0000-0000-000000000000',
      domain: 'copilot.tencent.com', tokenLen: 1359,
      expiresAt: NOW + 37 * 86400000, remainingMs: 37 * 86400000,
    } : null,
    error: active ? null : '无法读取登录目录：ENOENT',
    authFile: 'C:\\path\\to\\workbuddy-desktop.info',
  };
}

export function overviewFixture({ bridgeRunning = true, active = true, quota = 715, dshReady = true } = {}) {
  return {
    bridge: bridgeFixture({ running: bridgeRunning }),
    console: { version: '1.0.0', node: 'v22.22.2' },
    credentials: credentialsFixture({ active }),
    quota: quota === null ? null : { ok: true, total: quota, packages: [{ name: '每日签到', remain: 18, size: 20 }], productCode: 'wb' },
    dsh: dshReady ? {
      settingsExists: true, settingsHasRoute: true, patchHasRoute: true,
      routeLive: true, routeSource: 'settings.yaml', hasBridgeKey: true,
      bundlesOk: true, bundles: ['a'], registeredModels: ['glm-5.3'],
    } : {
      settingsExists: false, settingsHasRoute: false, patchHasRoute: false,
      routeLive: false, routeSource: null, hasBridgeKey: false,
      bundlesOk: false, bundles: [], registeredModels: [],
    },
  };
}

/**
 * 用量账本。
 *
 * `total` / `models` / `days` 都可整体替换 —— README 截图要的是一组好看的
 * 具体数字，直接给整块比逐字段覆盖更清楚。
 */
export function usageFixture({
  total = null, models = null, days = null, failures = [], windowDays = 7,
} = {}) {
  return {
    usage: {
      ok: true,
      windowDays,
      total: total || { calls: 118, promptTokens: 241000, completionTokens: 51000, ms: 92000, credit: 1.28, creditCalls: 104, failed: failures.length },
      models: models || [
        { model: 'deepseek-v4.1-flash', calls: 61, promptTokens: 128000, completionTokens: 30000, ms: 48000, credit: 0.61, creditCalls: 55 },
        { model: 'glm-5.3', calls: 44, promptTokens: 97000, completionTokens: 19000, ms: 38000, credit: 0.62, creditCalls: 42 },
        { model: 'kimi-k3-1', calls: 13, promptTokens: 16000, completionTokens: 2000, ms: 6000, credit: 0.05, creditCalls: 7 },
      ],
      days: days || [
        { day: '2026-10-01', calls: 9, promptTokens: 38000, completionTokens: 9000, credit: 0.27, creditCalls: 8 },
        { day: '2026-10-02', calls: 7, promptTokens: 30000, completionTokens: 7000, credit: 0.22, creditCalls: 7 },
        { day: '2026-10-03', calls: 8, promptTokens: 44000, completionTokens: 11000, credit: 0.24, creditCalls: 7 },
      ],
      failures,
    },
  };
}

export function requestsFixture({ requests = null } = {}) {
  return {
    requests: requests || [
      { t: NOW - 20000, model: 'deepseek-v4.1-flash', stream: true, ok: true, ms: 1180, promptTokens: 820, completionTokens: 240, credit: 0.03 },
      { t: NOW - 60000, model: 'glm-5.3', stream: false, ok: false, ms: 2400, status: 400, code: 11101, error: '{"msg":"Non-stream chat request is currently not supported"}' },
      { t: NOW - 90000, model: 'kimi-k3-1', stream: true, ok: true, ms: 960, promptTokens: 410, completionTokens: 130, credit: 0.02 },
    ],
    // 进行中的请求（批次二加的字段）：默认给空数组 = 没有在途请求，
    // 需要验收「疑似卡死」提示的用例自己传 active。
    active: [],
    activeAlertMs: 300000,
  };
}

export function diagnoseFixture({ items = null } = {}) {
  return {
    items: items || [
      { id: 'bridge', label: '桥服务', status: 'ok', detail: '127.0.0.1:8790 已响应', hint: '' },
      { id: 'settings', label: 'dsh 模型路由', status: 'warn', detail: '尚未配置 workbuddy 路由', hint: '在「可用模型」里勾选后保存' },
    ],
    summary: { fail: 0, warn: 1, ok: 1 },
    bridge: { running: true, ok: true, body: { ok: true, models: CATALOG.map((m) => m.id), catalogSize: CATALOG.length } },
    credentials: credentialsFixture(),
    dsh: {
      home: 'C:\\path\\to\\.dsh', settingsPath: 'C:\\path\\to\\.dsh\\settings.yaml',
      credentialsPath: 'C:\\path\\to\\.dsh\\.credentials.yaml', patchPath: 'C:\\path\\to\\.dsh\\profiles\\desktop\\cordis.patch.yml',
      settingsExists: true, settingsHasRoute: true, patchHasRoute: true,
      settingsText: '', settingsModels: ['glm-5.3'], patchModels: ['glm-5.3'],
      registeredModels: ['glm-5.3'], hasBridgeKey: true, refNames: ['WORKBUDDY_BRIDGE_KEY'],
      bundles: ['a'], bundlesOk: true, routeLive: true, routeSource: 'settings.yaml',
    },
  };
}

export function accountsFixture({ accounts = null } = {}) {
  return {
    dir: 'C:\\path\\to\\auth',
    active: 'C:\\path\\to\\auth\\workbuddy-desktop.info',
    accounts: accounts || [{
      name: 'workbuddy-desktop.info', path: 'C:\\path\\to\\auth\\workbuddy-desktop.info',
      active: true, usable: true, account: '330000000000', domain: 'copilot.tencent.com',
      encrypted: true, expiresAt: NOW + 37 * 86400000, remainingMs: 37 * 86400000,
      modifiedAt: NOW - 3600000, userId: '00000000-0000-0000-0000-000000000000',
    }],
    keyError: null,
  };
}

export function checkinFixture({ active = true, todayCheckedIn = true } = {}) {
  return {
    ok: true,
    status: {
      active, todayCheckedIn, streakDays: 3, dailyCredit: 18, todayCredit: 18,
      isStreakDay: true, nextStreakDay: 4, streakBonusDays: 7, streakBonusCredit: 100,
    },
    checkin: { auto: true, lastAt: NOW - 300000, lastResult: 'ok', lastError: null, lastSource: 'auto' },
  };
}

export function clientsFixture({ running = true } = {}) {
  return {
    running, host: '127.0.0.1', port: 8790,
    baseUrlOpenAI: 'http://127.0.0.1:8790/v1',
    baseUrlAnthropic: 'http://127.0.0.1:8790',
    token: 'wb-local-bridge',
    anthropicModel: 'glm-5.3',
    anthropicFastModel: 'glm-5.3-flash',
    models: CATALOG.map((m) => m.id),
    modelDetails: CATALOG.map((m) => ({
      id: m.id, name: m.name, context: m.context_window, maxOutput: m.max_output_tokens,
      supportsReasoning: !!m.supports_reasoning, supportsImages: !!m.supports_images,
    })),
  };
}

export function probeResultsFixture() {
  return { updatedAt: null, results: {}, lastRun: null };
}

/**
 * 一套形状完整的基础路由。各工具在此基础上按需覆盖。
 *
 * **注意 `catalog` 与 `usage.models` 是两个不同的东西**：前者是模型目录
 * （`/api/models`，字段是 `id`/`context_window`/`credits`…），后者是用量账本按模型
 * 汇总（字段是 `model`/`calls`/`promptTokens`…）。早先把同一个 `models` 选项
 * 串给了两边，直接触发形状校验失败 —— 参数名必须能区分开。
 */
export function baseRoutes({ catalog = CATALOG, usage, ...rest } = {}) {
  return {
    '/api/overview': { body: overviewFixture(rest) },
    '/api/models': { body: { models: catalog } },
    '/api/clients': { body: clientsFixture(rest) },
    '/api/diagnose': { body: diagnoseFixture(rest) },
    '/api/usage': { body: usageFixture(usage || {}) },
    '/api/requests': { body: requestsFixture(rest) },
    '/api/accounts': { body: accountsFixture(rest) },
    '/api/checkin': { body: checkinFixture(rest) },
    '/api/probe-results': { body: probeResultsFixture() },
    '/api/bridge/log': { body: { lines: [] } },
  };
}

/** 读取已捕获的接口形状（供工具自查用）。 */
export function loadShape() {
  return JSON.parse(readFileSync(join(HERE, 'api-shape.json'), 'utf8'));
}
