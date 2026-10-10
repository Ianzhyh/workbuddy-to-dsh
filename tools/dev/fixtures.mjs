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

/** 控制台自述（`/api/overview` 的 `console`）。 */
export function consoleFixture() {
  return { version: '1.0.0', node: 'v22.22.2' };
}

/**
 * 积分总览（`/api/overview` 的 `quota`）。
 *
 * `total === null` 表示**查不到**（页面走空态），这时真实接口回 `null` ——
 * 与「查到 0 分」是两回事，别混。
 */
export function quotaFixture({ total = 715 } = {}) {
  if (total === null) return null;
  return {
    ok: true,
    total,
    /*
     * **给 3 个包**：控制台积分卡只在「包数 > 2」时才拼「等 N 个套餐」，
     * 只给一个包这条分支永远不渲染 —— i18n 验收也就扫不到它。
     * 包名用真实的上游名称（它们在 I18N_TERMS_EN 里是**故意**翻的）。
     */
    packages: [
      { name: 'CodeBuddy个人体验版', remain: 18, size: 20 },
      { name: 'CodeBuddy个人版拉新权益包', remain: 100, size: 100 },
      { name: 'CodeBuddy个人版国内运营裂变包', remain: 100, size: 100 },
    ],
    productCode: 'wb',
  };
}

/**
 * dsh 接入状态（`/api/overview` 的 `dsh`）。
 *
 * `ready: false` 是「还没接上」的完整形状 —— 不是「少了几个字段」。
 * 这点很关键：字段缺失会让页面**静默地不渲染**某一块，而看起来一切正常。
 */
export function dshFixture({ ready = true } = {}) {
  return ready ? {
    settingsExists: true, settingsHasRoute: true, patchHasRoute: true,
    routeLive: true, routeSource: 'settings.yaml', hasBridgeKey: true,
    bundlesOk: true, bundles: ['a'], registeredModels: ['glm-5.3'],
  } : {
    settingsExists: false, settingsHasRoute: false, patchHasRoute: false,
    routeLive: false, routeSource: null, hasBridgeKey: false,
    bundlesOk: false, bundles: [], registeredModels: [],
  };
}

export function overviewFixture({ bridgeRunning = true, active = true, quota = 715, dshReady = true } = {}) {
  return {
    bridge: bridgeFixture({ running: bridgeRunning }),
    console: consoleFixture(),
    credentials: credentialsFixture({ active }),
    quota: quotaFixture({ total: quota }),
    dsh: dshFixture({ ready: dshReady }),
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
      /*
       * 令牌文件权限。**两种形态都放进桩**（成功 / 未能收紧）：
       *
       * 这段文案不在 index.html 里，而是由 `lib/diagnostics.mjs` 拼出来的 ——
       * 也就是说「英文模式下扫可见中文」是它唯一的验收手段，而那条验收只扫
       * **渲染出来的**东西：桩数据里没有它，它就等于没测。detail 是
       * 「路径 + 结论」的动态串（靠规则分流），hint 是一长段（靠整串查表），
       * 两个分支的翻法不一样，所以两种都要覆盖。
       */
      { id: 'tokenfile', label: '令牌文件权限', status: 'ok', detail: '.\\dsh-plugin\\.bridge-token（已收紧为仅本人可读）', hint: '' },
      {
        id: 'tokenfile-warn',
        label: '令牌文件权限',
        status: 'warn',
        detail: '.\\dsh-plugin\\.bridge-token 未能收紧：icacls 起不来：EBUSY',
        hint: '同机其它用户可能读到本地令牌并调用桥、消耗账号额度。常见原因：组策略禁用 icacls、受限沙箱、或 USERNAME 环境变量缺失。手动修复：icacls "<令牌文件>" /inheritance:r /grant:r "%USERNAME%:F"',
      },
    ],
    summary: { fail: 0, warn: 2, ok: 2 },
    /**
     * `authRejected` / `status` 同样是真实接口一直有、夹具一直缺的字段
     * （2026-10-10 重捕形状时才暴露）。`authRejected` 是「桥在跑但不认这把令牌」
     * 那一档 —— 诊断面板要靠它把「桥没起」与「令牌不一致」分开说。
     */
    bridge: { running: true, ok: true, authRejected: false, status: 200, body: { ok: true, models: CATALOG.map((m) => m.id), catalogSize: CATALOG.length } },
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

/**
 * 签到状态**读取失败**时的真实形状。
 *
 * 真实接口失败时只回 `{ ok: false, error }`，**不带 `status`** —— 这一点很重要：
 * 早先有测试把它写成 `{ status: null }`，于是页面走进「当前账号没有签到活动
 * （国际版网关不含积分系统）」那条分支，看起来像**产品在无依据地下结论**，
 * 其实只是桩没表达出「读取失败」。两个分支在页面上是两句话：
 *   - 读取失败  → `读取失败：<error>`
 *   - 无签到活动 → `当前账号没有签到活动（国际版网关不含积分系统）。`
 *
 * `ok: false` 同时让形状校验放行（失败态本来就没有成功载荷）。
 */
export function checkinFailFixture(error = '桥未运行') {
  return { ok: false, error };
}

export function clientsFixture({ running = true } = {}) {
  return {
    running, host: '127.0.0.1', port: 8790,
    baseUrlOpenAI: 'http://127.0.0.1:8790/v1',
    baseUrlAnthropic: 'http://127.0.0.1:8790',
    /*
     * 桩令牌**故意不像真的**，也**不能沿用 `wb-local-bridge`** ——
     * 那是令牌随机化之前的公开默认值，而这个夹具会出现在 README 与
     * 客户端面板截图里：截图里写着公开旧口令，等于自打「令牌已改为随机」的脸。
     * 保持 base64url + 长度够（页面按真令牌原样展示，太短会看不出形状）。
     */
    token: 'stub-token-not-a-real-value-9f3a2b1c',
    anthropicModel: 'glm-5.3',
    anthropicFastModel: 'glm-5.3-flash',
    /**
     * Responses 那条协议的默认模型。真实接口一直有这两个字段（`/api/clients`
     * 就是「复制片段」那一页用的），只是形状表重捕之前没人发现夹具漏了它们 ——
     * 漏了不会报错，只会让页面少渲染一行，属于形状表专门要防的那类静默缺口。
     */
    responsesModel: 'glm-5.3',
    responsesFastModel: 'glm-5.3-flash',
    models: CATALOG.map((m) => m.id),
    modelDetails: CATALOG.map((m) => ({
      id: m.id, name: m.name, context: m.context_window, maxOutput: m.max_output_tokens,
      supportsReasoning: !!m.supports_reasoning, supportsImages: !!m.supports_images,
    })),
  };
}

/**
 * 模型体检结果（`/api/probe-results`）。
 *
 * **默认按目录（catalog）生成一组非空结果，而不是空对象。** 空对象会让整块 UI
 * 根本不渲染 —— 表头时间线（`上次体检 X 前 · 本轮 K 个 · 可用 M / N`）、每行的
 * 体检结果标签、详情弹层里的「体检结论」全都是空字符串或「未测」。
 *
 * 历史教训：i18n 验收就是被这个坑骗过去的。桩是空的 → 那几处渲染不出来 →
 * 扫描扫到 0 个中文 → 断言"通过"，而真实界面上它们明明白白是中文
 * （用户截图打脸）。**桩数据太"干净"会让断言变成假绿**，这比桩写错更危险，
 * 因为写错会被形状校验拦下，太干净不会。
 *
 * 按 catalog 生成（而不是写死几个 id）是为了**自洽**：写死的话，截图脚本换个
 * 目录就会出现「表里 4 个模型，体检结论却是另外几个 id」的错位。
 *
 * @param {object} [opts]
 * @param {Array}  [opts.catalog]   模型目录；结果按它的 id 逐个生成
 * @param {number} [opts.updatedAt] 上次体检时间，默认 `NOW - 2 天`
 *   （页面用 `fmtAgo` 相对**真实当前时间**渲染，界面上会读作「N 天前」——
 *   断言只关心它有没有被英文化，不依赖具体数字）
 * @param {object} [opts.results]   整体覆盖结果
 * @param {object} [opts.lastRun]   `{ count }`；**不传**给默认值，传 `null` 表示不要这段
 */
export function probeResultsFixture({
  catalog = CATALOG,
  updatedAt = NOW - 2 * 86400000,
  results = null,
  lastRun,
} = {}) {
  const ids = (catalog || []).map((m) => m.id);
  const at = updatedAt;
  const credits = [0, 0.02, 0.01, 0.03];
  const built = {};
  ids.forEach((id, i) => {
    // 最后一个故意失败：让「不可用」标签与「上游错误原文 + 时间」的 title 有样本
    built[id] = i === ids.length - 1
      ? { ok: false, ms: 2400, at, error: 'HTTP 503: upstream busy' }
      : { ok: true, ms: 880 + i * 335, at, credit: credits[i % credits.length] };
  });
  return {
    updatedAt,
    results: results || built,
    lastRun: lastRun === undefined ? { count: ids.length, at } : lastRun,
  };
}

/**
 * 一套形状完整的基础路由。各工具在此基础上按需覆盖。
 *
 * **注意 `catalog` 与 `usage.models` 是两个不同的东西**：前者是模型目录
 * （`/api/models`，字段是 `id`/`context_window`/`credits`…），后者是用量账本按模型
 * 汇总（字段是 `model`/`calls`/`promptTokens`…）。早先把同一个 `models` 选项
 * 串给了两边，直接触发形状校验失败 —— 参数名必须能区分开。
 */
/**
 * 一键接入的状态（`/api/connect`）。
 *
 * **这段文案不在 index.html 里，而是由 `lib/client-connect.mjs` 算出来再送到界面上**
 * —— 所以「英文模式下扫可见中文」是它唯一的验收，而那条验收只扫**渲染出来的**东西：
 * 桩数据里没有它，整块「一键接入」就等于没测（和上面 `diagnoseFixture` 是同一个坑，
 * 这次是先栽过一次才补的）。
 */
export function connectFixture({ clients = null } = {}) {
  return {
    running: true,
    /**
     * 桥的进程级状态。`authRejected` 是实测踩到的那一种：桥独立启动时自己生成
     * 一把随机令牌，与控制台读的 `.bridge-token` 不一致 → 桥在跑但对控制台
     * 每次请求都回 401。界面必须能把它和「桥没起」分开说（处置不同：
     * 启动桥 / 重启桥），所以桩里也得有这个字段。
     */
    bridge: { up: true, authRejected: false },
    token: clientsFixture().token,
    /**
     * 模型下拉的候选。**真实接口一定给**（完整目录，桥没起时退回精选集），
     * 漏了它页面就会渲染出**空的下拉**：`connectModelPicker` 的候选来自这里，
     * `effectiveModel` 只负责选中哪一项 —— 两者都缺时 `.dd-label` 是空白，
     * `test-ui-kit` 的「所有触发器都有文案」正是被这个夹具缺口搞红的。
     * 形状取自真实响应：`[{ id, name }]`。
     */
    modelOptions: [
      { id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash' },
      { id: 'glm-5.3', name: 'GLM-5.3' },
    ],
    baseUrlOpenAI: 'http://127.0.0.1:8790/v1',
    baseUrlAnthropic: 'http://127.0.0.1:8790',
    model: 'deepseek-v4.1-flash',
    /**
     * 目录是不是"上次抓到的"（桥没起时的兜底校验，审计 R5）。
     * 形状表里它是顶层字段 → 夹具**必须**有，否则 openPage 的形状校验会拦下来。
     */
    catalogStale: false,
    catalogAt: null,
    backupDir: 'C:\\path\\to\\.backup\\client-configs',
    clients: clients || [
      {
        id: 'codex', label: 'Codex', e2e: true, installed: true, exists: true,
        path: 'C:\\Users\\you\\.codex\\config.toml',
        changed: true, applied: false, appliedAt: null, reformats: false,
        /**
         * 路径是怎么定下来的。别人的机器上可能设着 `CODEX_HOME` /
         * `CLAUDE_CONFIG_DIR`（各家官方支持的重定位）—— 界面要把这件事说出来，
         * 否则用户没法确认"它认没认对地方"。
         * 夹具里给成"跟随客户端的 CODEX_HOME"，好让 UI 断言覆盖到这条分支。
         */
        pathSource: { source: 'client', envName: 'CODEX_HOME' },
        effectiveModel: 'glm-5.3',
        effectiveModels: ['deepseek-v4.1-flash', 'glm-5.3'],
        /**
         * Codex 的多模型靠一份**单独的目录文件**（`model_catalog_json`）。
         * 桩里要有它，界面才会渲染「另外会写一份模型目录：<路径>」那一行 ——
         * 那是用户唯一能知道"它还动了第二个文件"的地方。
         */
        catalog: {
          path: 'C:\\Users\\you\\.codex\\workbuddy-model-catalog.json',
          name: 'workbuddy-model-catalog.json',
          added: ['kimi-k3'],
          kept: 2,
          from: 'C:\\Users\\you\\.codex\\cc-switch-model-catalog.json',
        },
        catalogSkipped: null,
        /**
         * 现在走哪条路。**判据是文件本身**（不是我们记的账）—— 用户可能手工改回去过。
         * 夹具里 Codex 是「已接入」→ bridge；另两个没接入 → native。
         * 与 mode/canSwitchBack 一起进形状表（tools/dev/api-shape.json）。
         */
        mode: 'bridge', recordedMode: 'bridge', canSwitchBack: true,
        /**
         * Codex 的 profile 通道（零写入接入）：**挂在 Codex 这一行上，不单开一行** ——
         * 它和"改基础配置"是同一个决策的两个选项，不是第四个客户端。
         * 字段与真实接口一致（形状表里有 `$.clients[].profile.*`）。
         */
        profile: {
          id: 'codex-profile', label: 'Codex · profile',
          path: 'C:\\Users\\you\\.codex\\workbuddy.config.toml',
          exists: false, applied: false, changed: true, canSwitchBack: false,
          error: null, catalogSkipped: null,
          launch: 'codex -p workbuddy', appSupported: false,
        },
        models: ['deepseek-v4.1-flash', 'glm-5.3'],
        changes: [
          { path: 'model', kind: 'value', from: 'glm-5.2', to: 'deepseek-v4.1-flash' },
          { path: 'model_provider', kind: 'value', from: 'custom', to: 'workbuddy' },
          { path: 'model_providers.workbuddy', kind: 'section', from: null, to: 'written' },
        ],
        preview: [
          'model_provider = "workbuddy"',
          'model = "deepseek-v4.1-flash"',
          '',
          '[model_providers.custom]',
          'name = "opencode_go"',
          '',
          '[model_providers.workbuddy]',
          'name = "WorkBuddy (local bridge)"',
          'base_url = "http://127.0.0.1:8790/v1"',
          'wire_api = "responses"',
          'experimental_bearer_token = "stub-token-not-a-real-value-9f3a2b1c"',
          '',
        ].join('\n'),
      },
      {
        id: 'claude', label: 'Claude Code', e2e: false, installed: false, exists: false,
        path: 'C:\\Users\\you\\.claude\\settings.json',
        changed: true, applied: false, appliedAt: null, reformats: false,
        effectiveModel: 'glm-5.3',
        effectiveModels: ['deepseek-v4.1-flash', 'glm-5.3'],
        catalog: null,
        catalogSkipped: null,
        mode: 'native', recordedMode: null, canSwitchBack: false,
        models: ['deepseek-v4.1-flash', 'glm-5.3'],
        changes: [
          { path: 'env.ANTHROPIC_BASE_URL', kind: 'value', from: null, to: 'http://127.0.0.1:8790' },
          { path: 'env.ANTHROPIC_API_KEY', kind: 'value', from: null, to: 'stub-token-not-a-real-value-9f3a2b1c' },
        ],
        preview: JSON.stringify({
          env: {
            ANTHROPIC_BASE_URL: 'http://127.0.0.1:8790',
            ANTHROPIC_API_KEY: 'stub-token-not-a-real-value-9f3a2b1c',
          },
        }, null, 2) + '\n',
      },
      {
        id: 'opencode', label: 'opencode', e2e: false, installed: true, exists: false,
        path: 'C:\\Users\\you\\.config\\opencode\\opencode.json',
        changed: true, applied: false, appliedAt: null, reformats: false,
        effectiveModel: 'deepseek-v4.1-flash',
        effectiveModels: ['deepseek-v4.1-flash', 'glm-5.3'],
        catalog: null,
        catalogSkipped: null,
        mode: 'native', recordedMode: null, canSwitchBack: false,
        models: ['deepseek-v4.1-flash', 'glm-5.3'],
        changes: [
          { path: '$schema', kind: 'value', from: null, to: 'https://opencode.ai/config.json' },
          { path: 'provider.workbuddy', kind: 'value', from: null, to: '{…}' },
          { path: 'model', kind: 'value', from: null, to: 'workbuddy/deepseek-v4.1-flash' },
        ],
        preview: JSON.stringify({
          $schema: 'https://opencode.ai/config.json',
          model: 'workbuddy/deepseek-v4.1-flash',
          provider: {
            workbuddy: {
              npm: '@ai-sdk/openai-compatible',
              name: 'WorkBuddy (local bridge)',
              options: { baseURL: 'http://127.0.0.1:8790/v1', apiKey: 'stub-token-not-a-real-value-9f3a2b1c' },
              models: {
                'deepseek-v4.1-flash': { name: 'DeepSeek-V4.1-Flash', limit: { context: 1000000, output: 128000 } },
              },
            },
          },
        }, null, 2) + '\n',
      },
    ],
  };
}

export function baseRoutes({ catalog = CATALOG, usage, probeResults, ...rest } = {}) {
  return {
    '/api/overview': { body: overviewFixture(rest) },
    '/api/models': { body: { models: catalog } },
    '/api/clients': { body: clientsFixture(rest) },
    '/api/connect': { body: connectFixture(rest) },
    '/api/diagnose': { body: diagnoseFixture(rest) },
    '/api/usage': { body: usageFixture(usage || {}) },
    '/api/requests': { body: requestsFixture(rest) },
    '/api/accounts': { body: accountsFixture(rest) },
    '/api/checkin': { body: checkinFixture(rest) },
    '/api/probe-results': { body: probeResultsFixture({ catalog, ...(probeResults || {}) }) },
    '/api/bridge/log': { body: { lines: [] } },
  };
}

/** 读取已捕获的接口形状（供工具自查用）。 */
export function loadShape() {
  return JSON.parse(readFileSync(join(HERE, 'api-shape.json'), 'utf8'));
}
