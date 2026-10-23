/**
 * 面板验收用的**共享桩数据与渲染骨架**。
 *
 * 为什么单独一份：`panel-render.mjs`（出截图）与 `panel-i18n.test.mjs`（扫残留
 * 中文）需要**完全相同**的桩 —— 两份各写一份必然漂移，而桩一漂移，两边验的就不是
 * 同一个东西了（这个坑在 tools/dev/fixtures.mjs 的注释里已经记过一次）。
 *
 * **默认离线**：真实数据必须显式要（见 panel-render.mjs 文件头 —— 默认 live 曾把
 * 用户账号 UUID 写进仓库）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const VENDOR = join(ROOT, '.tmp-research', 'vendor');

export const LIVE = 'http://127.0.0.1:19387';

const now = Date.now();

/** 内置样例：真实端点不可用时的退路，字段与真实响应一致。 */
export const FIXTURES = {
  status: {
    ok: true,
    bridge: {
      state: 'running',
      health: {
        ok: true, pid: 31840, startedAt: new Date(now - 45_600_000).toISOString(), uptimeMs: 45_600_000,
        // 样例值要与真实响应同形：账号是掩码后的 id，端点是真实上游地址。
        // 早先这里写 'example.invalid'，截出来的图会像未完成的占位稿。
        // endpoint 只到源站，**不带**接口路径 —— 桥的 /health 就是这么上报的
        // （曾经误写成 `.../v2/chat/completions`，于是 README 截图里显示的"上游端点"
        //  是个接口路径，与真实面板对不上）
        auth: { userId: 'uid-fixture-0001', source: 'plugin', endpoint: 'https://copilot.tencent.com', expiresAt: new Date(now + 44 * 86_400_000).toISOString(), expired: false },
        // 与 /workbuddy/login 的插件账号保持一致：实际生效来源是插件，
        // 桌面账号那一行只能显示「已选（未生效）」。
        credential: { source: 'plugin', storeMode: 'dpapi', pluginCount: 1 },
        catalogSize: 30, catalogAt: new Date(now - 300_000).toISOString(),
      },
      error: '',
    },
    // 路径同样用中性值：这些截图会进仓库，真实目录不该出现在里面
    config: { provider: 'workbuddy', configuredProvider: 'workbuddy', displayName: 'WorkBuddy', bridgeUrl: 'http://127.0.0.1:8790', consoleUrl: 'http://127.0.0.1:8792', projectRoot: 'D:\\workbuddy-to-dsh', autoStart: true, consoleAutoStart: true, logPath: 'bridge\\bridge.log' },
    /** 控制台状态：这一页的主入口。 */
    console: { state: 'running', url: 'http://127.0.0.1:8792', error: '', managed: false, autoStart: true },
    route: { registered: true, provider: 'workbuddy', error: '', fallback: false },
    /*
     * 模型目录夹具。
     *
     * ⚠️ `reasoning` / `efforts` / `onlyReasoning` **必须有** —— 面板要在模型行标
     * 「推理」徽章、在详情里列实测档位；夹具里缺这几个字段，那部分渲染就等于没测
     * （本项目栽过两次：服务端拼的界面文案，桩里没有就测不到）。
     * 排序也特意覆盖三种形态：全档 / 无档位字段（老桥） / 显式空数组（网关不接）。
     */
    directory: [
      { id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash', contextWindow: 300000, maxTokens: 128000, contextWindowDefault: 300000, contextWindowOptions: [300000, 600000, 1000000], contextWindowMax: 1000000, effortsSource: 'upstream', defaultEffort: 'high', official: true, images: true, reasoning: true, efforts: ['low', 'high', 'max'], onlyReasoning: true, credits: 0.11, free: false, vendor: 'f', tags: ['craft'], badges: [] },
      { id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 300000, maxTokens: 48000, contextWindowDefault: 300000, contextWindowOptions: [300000, 600000, 1000000], contextWindowMax: 1000000, effortsSource: 'upstream', defaultEffort: 'high', official: true, images: true, reasoning: true, efforts: ['low', 'high', 'max'], onlyReasoning: true, credits: 0.79, free: false, vendor: 'e', tags: ['craft'], badges: [] },
      // 没有 efforts 字段：老桥 / 上游未给档位 → 面板提示"按低/中/高三档兜底"
      { id: 'kimi-k3', name: 'Kimi-K3', contextWindow: 960000, maxTokens: 32000, images: false, reasoning: true, efforts: null, onlyReasoning: false, credits: 0.35, free: false, vendor: 'v', tags: ['craft'], badges: [] },
      // 带促销徽章的样例：既让"徽章要渲染成带色标记"这条断言在离线模式下也成立，
      // 也顺带验证「同名套餐/徽章」的展示
      { id: 'hy3', name: 'HY3', contextWindow: 131072, maxTokens: 8192, images: false, reasoning: false, efforts: null, onlyReasoning: false, credits: 0, free: true, vendor: 'j', tags: ['craft', 'badge:限时免费:#FF0000'], badges: [{ label: '限时免费', color: '#FF0000' }] },
      { id: 'hy4-preview', name: 'Hy4 preview', contextWindow: 960000, maxTokens: 64000, images: true, reasoning: true, efforts: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'], onlyReasoning: true, credits: 0, free: true, vendor: 'j', tags: ['badge:夜间免费:#FF0000'], badges: [{ label: '夜间免费', color: '#FF0000' }] },
      // 显式空数组：桥实测"一个档都不收"（网关暂时不接）→ 面板提示"暂无可选档位"
      { id: 'glm-5v-turbo', name: 'GLM-5v-Turbo', contextWindow: 200000, maxTokens: 64000, images: true, reasoning: true, efforts: [], onlyReasoning: false, credits: 0.71, free: false, vendor: 'e', tags: [], badges: [], official: false },
    ],
    catalogAt: new Date(now - 300_000).toISOString(),
    catalogError: '',
    legacy: { found: false, files: [], cleaned: null },
    // 已接入形态：面板顶部应显示「网页搜索 / 已接入本地桥」；未接入形态在
    // panel-render.mjs 里通过覆盖路由单独验（提醒 + 接入按钮）。
    webSearch: {
      available: true,
      configured: true,
      ready: true,
      bridgeState: 'running',
      tokenMatches: true,
      pointsToBridge: true,
      providerSelected: true,
      provider: '',
      baseURL: 'http://127.0.0.1:8790/v1',
      expectedBaseURL: 'http://127.0.0.1:8790/v1',
      apiKeyRef: 'WORKBUDDY_SEARCH_BRIDGE_KEY',
      keyConfigured: true,
      reason: '',
      lastVerifiedAt: new Date(now - 60_000).toISOString(),
      lastVerifySourceCount: 2,
      lastVerifyError: '',
      lastVerifyStale: false,
      lastVerifyFailed: false,
      lastVerifyVerified: true,
      revert: {
        available: true,
        at: new Date(now - 120_000).toISOString(),
        previous: {
          baseURL: 'https://api.deepseek.com/v1',
          apiKeyRef: 'DEEPSEEK_API_KEY',
          hadLiteralKey: false,
          provider: '',
        },
      },
    },
    /*
     * 权益包：**必须带 monthly / expiresAt** —— 不带就渲染不出
     * 「月度 · 到期 2026-10-31 23:59:59」那一行（那是两段 join 出来的拼接串，
     * 需要单独的规则），i18n 验收也就扫不到它。用户实拍才发现漏了。
     * 包名也是**我们故意翻译的**（见 panel-i18n.mjs 的 KEEP_ZH）。
     */
    quota: {
      ok: true, total: 1427,
      packages: [
        { name: 'CodeBuddy个人体验版', remain: 426, size: 500, monthly: true, expiresAt: '2026-10-31 23:59:59' },
        { name: 'CodeBuddy个人版拉新权益包', remain: 100, size: 100 },
      ],
    },
    quotaError: '',
    checkin: { status: { todayCheckedIn: true, todayCredit: 18, streakDays: 6 }, auto: { auto: true } },
    dsh: { home: 'C:\\Users\\demo\\.dsh', profileDir: 'C:\\Users\\demo\\.dsh\\profiles\\desktop' },
    runtime: { node: 'v24.8.0', pid: 1234 },
    sampleModel: 'deepseek-v4.1-flash',
  },
  models: { ok: true, at: now - 300_000, models: [], error: '' },
  usage: {
    ok: true,
    usage: {
      windowDays: 7,
      total: {
        calls: 36, promptTokens: 186000, completionTokens: 42000, ms: 38000,
        credit: 1.24, creditCalls: 30, failed: 2, searches: 4, searchFailed: 1,
      },
      models: [
        { model: 'deepseek-v4.1-flash', calls: 24, promptTokens: 120000, completionTokens: 30000, credit: 0.76, creditCalls: 20 },
        { model: 'glm-5.3', calls: 12, promptTokens: 50000, completionTokens: 8000, credit: 0.48, creditCalls: 10 },
      ],
      // 趋势图数据（离线模式下也要有，否则"用量页必须渲染 SVG"的断言会失败）
      days: [
        { key: '2026-09-28', calls: 3, promptTokens: 12000, completionTokens: 3000, credit: 0.08, searches: 2, searchFailed: 0 },
        { key: '2026-09-29', calls: 5, promptTokens: 21000, completionTokens: 5200, credit: 0.14 },
        { key: '2026-09-30', calls: 4, promptTokens: 18000, completionTokens: 4100, credit: 0.1 },
        { key: '2026-10-01', calls: 7, promptTokens: 32000, completionTokens: 7600, credit: 0.22 },
        { key: '2026-10-02', calls: 6, promptTokens: 27000, completionTokens: 6300, credit: 0.19 },
        { key: '2026-10-03', calls: 8, promptTokens: 41000, completionTokens: 9800, credit: 0.31 },
        { key: '2026-10-04', calls: 3, promptTokens: 15000, completionTokens: 4000, credit: 0.2 },
      ],
      hours: [
        { key: '2026-10-04T10', calls: 1, promptTokens: 4000, completionTokens: 900, credit: 0.03 },
        { key: '2026-10-04T11', calls: 2, promptTokens: 9000, completionTokens: 2100, credit: 0.07 },
      ],
      failures: [
        { t: now - 3_600_000, model: 'glm-5.3', error: 'invalid_request: 该模型当前不可用' },
        { t: now - 1_800_000, model: 'web-search', kind: 'search', status: 504, code: 'WEB_SEARCH_TIMEOUT', error: 'WEB_SEARCH_TIMEOUT' },
      ],
    },
  },
  checkin: { ok: true, status: { todayCheckedIn: true, todayCredit: 18, streakDays: 6 }, auto: { auto: true, lastError: null } },
  log: { ok: true, path: 'bridge\\bridge.log', size: 4096, lines: ['workbuddy-bridge listening on http://127.0.0.1:8790/v1', '→ deepseek-v4.1-flash stream=true msgs=12 tools=8', 'stream interrupted ECONNRESET'] },
};
/*
 * `/workbuddy/models` 的响应形状 = **归一化器（lib/models.mjs）的输出**，
 * 不是桥的原始形状。
 *
 * ⚠️ 这里原来写的是桥的原始字段名（`supports_images` / `context_window` /
 * `max_output_tokens`）—— 于是对话页那个模型下拉读 `m.images` 拿到 undefined，
 * `· 多模态` 后缀**根本没渲染出来**，i18n 验收因此漏掉了一处未翻译文案
 * （用户实拍才发现）。桩的形状与真实契约不一致时，验收会在错误的地方变绿。
 */
FIXTURES.models.models = FIXTURES.status.directory.map((m) => ({
  id: m.id, name: m.name, contextWindow: m.contextWindow, maxTokens: m.maxTokens,
  credits: m.credits, images: m.images, free: m.free, vendor: m.vendor,
  // 推理能力：与 lib/models.mjs 的 toDirectory 输出**逐字段对齐**（含 null /
  // 空数组的区分语义）—— 少一个字段，模型页的「推理」徽章与详情档位就渲染不出来，
  // 而 i18n 验收只扫渲染出来的东西，于是会静默漏掉。
  reasoning: m.reasoning === true, efforts: m.efforts ?? null, onlyReasoning: m.onlyReasoning === true,
  // 官方清单 / 上下文档位 / 档位来源：与 lib/models.mjs 的输出逐字段对齐
  official: m.official === true ? true : m.official === false ? false : null,
  contextWindowDefault: m.contextWindowDefault ?? null,
  contextWindowOptions: m.contextWindowOptions ?? [],
  contextWindowMax: m.contextWindowMax ?? null,
  effortsSource: m.effortsSource ?? null,
  defaultEffort: m.defaultEffort ?? null,
  canDisableThinking: m.canDisableThinking === true,
  supplemented: m.supplemented === true,
  // tags 要洗干净（`badge:标签:#色` 已拆进 badges）；模型页的促销徽章靠 badges 渲染
  tags: (m.tags || []).filter((t) => !/^badge:/.test(t)), badges: m.badges,
  description: '',
}));

/**
 * 控制台域功能的样例（走 /workbuddy/console-api/* 透传，形状与控制台一致）。
 *
 * 故意塞进**真实机器上会出现**的长内容：完整 Windows 路径、多个登录文件、
 * 以及「诊断库旧口径误报」那条 fail —— 用它们钉住溢出与误报两个回归。
 */
FIXTURES.consoleOverview = { bridge: { running: true, port: 8790 }, dsh: { routeLive: false, hasBridgeKey: true, bundlesOk: true }, console: { version: '1.0.0', node: 'v24.8.0' } };
FIXTURES.consoleAccounts = {
  dir: 'C:\\Users\\demo\\AppData\\Local\\CodeBuddyExtension\\Data\\Public\\auth',
  active: 'C:\\Users\\demo\\AppData\\Local\\CodeBuddyExtension\\Data\\Public\\auth\\workbuddy-desktop.info',
  accounts: [
    /*
     * 三个登录文件、两个账号：国内版那份是「同一账号的另一份登录文件」。
     * 服务端会合并成一行；夹具**故意保留两行**，钉住面板自己的兜底
     * （控制台进程可能还是旧代码）—— 截图里不许出现两个一样的账号。
     */
    { name: 'workbuddy-desktop.info', path: 'C:\\Users\\demo\\AppData\\Local\\CodeBuddyExtension\\Data\\Public\\auth\\workbuddy-desktop.info', active: true, usable: true, account: '330000000000', userId: 'uid-fixture-0001', domain: 'copilot.tencent.com', encrypted: true, expiresAt: now + 44 * 86400000, remainingMs: 44 * 86400000, aliasKey: '330000000000', alias: '', hidden: false, sameAccount: 2 },
    { name: 'workbuddy-desktop.2026-10-12.info', path: 'C:\\Users\\demo\\AppData\\Local\\CodeBuddyExtension\\Data\\Public\\auth\\workbuddy-desktop.2026-10-12.info', active: false, usable: true, account: '330000000000', userId: 'uid-fixture-0001', domain: 'copilot.tencent.com', encrypted: true, expiresAt: now + 44 * 86400000, remainingMs: 44 * 86400000, aliasKey: '330000000000', alias: '', hidden: false, sameAccount: 2 },
    { name: 'workbuddy-desktop-ai.info', path: 'C:\\Users\\demo\\AppData\\Local\\CodeBuddyExtension\\Data\\Public\\auth\\workbuddy-desktop-ai.info', active: false, usable: true, account: '450000000000', userId: 'uid-fixture-0002', domain: 'www.workbuddy.ai', encrypted: true, expiresAt: now + 342 * 86400000, remainingMs: 342 * 86400000, aliasKey: '450000000000', alias: '', hidden: false, sameAccount: 1 },
  ],
};
FIXTURES.consoleDiagnose = {
  items: [
    // 真实机器上出现过的误报：诊断库只认 settings.yaml，原生路由它不认识
    { id: 'settings', label: 'dsh 模型路由', status: 'fail', detail: '尚未配置 workbuddy 路由', hint: '在「可用模型」里勾选后保存。DSH Desktop 0.2.0 会在下次启动时把 settings.yaml 导入 profile 的 patch 层' },
    { id: 'auth', label: '登录文件', status: 'warn', detail: 'workbuddy-desktop-ai.info  ·  workbuddy-desktop.info' },
    { id: 'exe', label: 'WorkBuddy 客户端', status: 'ok', detail: 'E:\\App\\WorkBuddy\\WorkBuddy.exe' },
    { id: 'atrest', label: 'AtRest 密钥', status: 'ok', detail: 'keyId=9127dea1b44020a7（与信封一致）' },
    { id: 'cred', label: '凭据解密', status: 'ok', detail: '账号 330000000000 · 剩余 44 天 9 小时' },
    { id: 'bridge', label: '桥服务', status: 'ok', detail: '127.0.0.1:8790 已响应' },
    // 同一轮的真实误报：原生路由不走 llm-pi-ai，旧口径却要求占位凭据
    { id: 'credref', label: '凭据引用', status: 'fail', detail: '缺少占位凭据', hint: 'pi-ai 的 OpenAI 实现要求必须提供 API key 引用' },
    { id: 'bundles', label: 'profile bundles', status: 'ok', detail: '4 个，缺失 0 个 · DSH 0.2.0-rc.2' },
  ],
  summary: { fail: 2, warn: 1, ok: 5 },
};
FIXTURES.consoleProbe = {
  updatedAt: now - 60000,
  lastRun: { scope: 'checked', count: 1 },
  results: { 'deepseek-v4.1-flash': { ok: true, ms: 1180, at: now - 60000, credit: 0.02 } },
};
FIXTURES.consoleCheckin = {
  ok: true,
  status: { todayCheckedIn: true, todayCredit: 18, streakDays: 6 },
  checkin: { auto: true, lastAt: now - 3600000, lastResult: 'ok', lastError: null, lastSource: 'manual' },
};

/** 尽量抓真实数据；任一接口失败就整体退回样例（保持自洽）。 */
export async function gather({ offline = true } = {}) {
  if (offline) return { data: FIXTURES, source: '内置样例（--offline）' };
  const get = async (path) => {
    const res = await fetch(`${LIVE}${path}`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
    return res.json();
  };
  try {
    const [status, models, usage, checkin, log, requests] = await Promise.all([
      get('/workbuddy/status'),
      get('/workbuddy/models'),
      get('/workbuddy/usage?days=7'),
      get('/workbuddy/checkin'),
      get('/workbuddy/log?lines=100'),
      get('/workbuddy/requests?limit=40'),
    ]);
    // `/workbuddy/models` 返回的就是归一化目录，与 status.directory 同一形状。
    // 运行中的实例可能还是旧代码（ESM 缓存 → 改动要重启 dsh 才生效），
    // 用 status.directory 覆盖可保证面板始终拿到**当前代码约定的形状**。
    if (Array.isArray(status?.directory) && status.directory.length) models.models = status.directory;
    // 同理：旧代码的 status 里没有 console 字段，补一个当前形状的，保证这一页
    // 按**新协议**渲染（`console` 是这页的主入口）。
    if (!status?.console) {
      status.console = { state: 'running', url: 'http://127.0.0.1:8792', error: '', managed: false, autoStart: true };
    }
    return { data: { status, models, usage, checkin, log, requests }, source: `实时数据（${LIVE}）`, liveStatus: status };
  } catch (error) {
    console.warn(`抓实时数据失败（${error.message}），改用内置样例`);
    return { data: FIXTURES, source: '内置样例（实时端点不可用）', liveStatus: null };
  }
}

export async function ensureVendor() {
  mkdirSync(VENDOR, { recursive: true });
  const files = [['react.js', 'https://unpkg.com/react@18.3.1/umd/react.production.min.js'], ['react-dom.js', 'https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js']];
  for (const [name, url] of files) {
    const dest = join(VENDOR, name);
    if (existsSync(dest)) continue;
    const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`下载 ${name} 失败：HTTP ${res.status}`);
    writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  }
  return { react: readFileSync(join(VENDOR, 'react.js'), 'utf8'), reactDom: readFileSync(join(VENDOR, 'react-dom.js'), 'utf8') };
}

/**
 * 外壳页面。
 *
 * 关键点：fetch 打桩**只装在父页面里**（不是用 CDP 的
 * `addScriptToEvaluateOnNewDocument`）。CDP 那种注入会连 iframe 一起打桩，
 * 而未命中的路径它一律回 `{}` —— 内嵌的真控制台就再也拿不到自己的
 * `/api/overview`，会一直显示「还没取到桥的状态」。装在这里，iframe 走真实网络。
 */
export function harnessHtml(fixtures) {
  const routes = JSON.stringify(fixtures);
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>WorkBuddy 面板渲染验证</title>
<style>body{margin:0;background:#0f1115;color:#f9fafb;font-family:"Microsoft YaHei",system-ui,sans-serif}
#frame{max-width:860px;margin:0 auto;padding:24px 28px 60px;background:#191a1c;min-height:100vh}
#head{color:#adb2b8;font-size:12px;margin-bottom:16px}</style></head>
<body><div id="frame"><div id="head">dsh 设置 → WorkBuddy</div><div id="root"></div></div>
<script src="/vendor/react.js"></script>
<script src="/vendor/react-dom.js"></script>
<script>
window.__errors = [];
window.addEventListener('error', (e) => window.__errors.push(String(e.message)));
window.__calls = [];
window.__hits = {};
window.__dialogs = [];
window.confirm = function (message) { window.__dialogs.push(String(message)); return window.__confirmAnswer !== false; };
(function () {
  const ROUTES = ${routes};
  const original = window.fetch;
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const path = String(url).replace(/^https?:\\/\\/[^/]+/, '').split('?')[0];
    try { window.__calls.push([path, (init && init.method) || 'GET']); } catch (e) { /* ignore */ }
    if (!(path in ROUTES)) return original.apply(this, arguments); // 未命中：透传真实网络
    // firstStatus：模拟「刷新页面时宿主还没挂上路由」的 404 窗口 —— 第一次 404，
    // 之后正常。用来钉住「404 必须自动重试、不能把红字挂一分钟」这条回归。
    const route = ROUTES[path];
    window.__hits[path] = (window.__hits[path] || 0) + 1;
    // fetchError：模拟网络层直接 reject（桥刚退出、断网），不是 HTTP 错误。
    if (route && route.fetchError) return Promise.reject(new Error(String(route.fetchError)));
    if (route && route.firstStatus && window.__hits[path] === 1) {
      return Promise.resolve(new Response(JSON.stringify({ ok: false, error: 'not ready' }), { status: route.firstStatus, headers: { 'content-type': 'application/json' } }));
    }
    // sse：对话流（text/event-stream）。用来端到端验证对话测试的渲染、
    // 逐轮元数据、以及"空助手消息不回灌"这条逻辑。
    if (route && Object.prototype.hasOwnProperty.call(route, 'httpStatus')) {
      return Promise.resolve(new Response(JSON.stringify(route.payload !== undefined ? route.payload : {}), {
        status: route.httpStatus,
        headers: { 'content-type': 'application/json' },
      }));
    }
    if (route && Array.isArray(route.sse)) {
      const payload = route.sse.map((line) => 'data: ' + line + '\\n\\n').join('') + 'data: [DONE]\\n\\n';
      return Promise.resolve(new Response(payload, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    }
    const body = route && Object.prototype.hasOwnProperty.call(route, 'payload') ? route.payload : route;
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
  };
  window.__routes = ROUTES;
  window.__setRoute = (path, route) => { ROUTES[path] = route; };
})();
window.__registrations = [];
window.__ModuleLoader__ = {
  load(registration) {
    window.__registrations.push({ id: registration.id });
    // 同一份 bundle 会按安装形态注册两个 id；渲染只 materialize 第一次。
    if (window.__registration) return;
    window.__registration = registration;
    try {
      window.__module = registration.factory(function (specifier) {
        if (specifier === 'react') return window.React;
        throw new Error('harness: unexpected module request "' + specifier + '"');
      });
    } catch (error) { window.__errors.push('factory: ' + error.message); }
  },
};
</script>
<script src="/client.js"></script>
<script>
(function () {
  const registration = window.__registration || {};
  const mod = window.__module || {};
  const slots = [];
  const injectedSlots = [];
  /* 按核心插件的真实契约造桩：apply 直接从 ctx.slots 取服务，
     注册项用 name 指槽位，并包在 slots.inject(槽位, …) 里。 */
  const service = {
    inject(key, callback) { window.__injectedSlot = key; injectedSlots.push(key); return callback(); },
    register(options, component) { slots.push({ options, component }); return () => {}; },
  };
  const ctx = {
    slots: service,
    get(name) { return name === 'slots' ? service : undefined; },
    effect(fn) { return fn(); },
  };
  let applyError = '';
  try { mod.apply(ctx); } catch (error) { applyError = String(error && error.message ? error.message : error); }
  const first = slots[0] || {};
  window.__harness = {
    bundleId: registration.id,
    bundleIds: (window.__registrations || []).map((r) => r.id),
    exportsName: mod.name,
    hasApply: typeof mod.apply === 'function',
    /** 模块级 inject 导出 = cordis 服务依赖；核心插件都是这么写的 */
    moduleInject: mod.inject,
    injectSlot: window.__injectedSlot || '',
    injectedSlots,
    registrations: slots.map((s) => s.options),
    applyError,
    rendered: false,
  };
  if (first.component) {
    const root = ReactDOM.createRoot(document.getElementById('root'));
    root.render(React.createElement(first.component));
    window.__harness.rendered = true;
  }
})();
</script></body></html>`;
}

/**
 * 一套完整的路由桩（路径 → 响应体）。
 *
 * `panel-render.mjs`（出截图）与 `panel-i18n.test.mjs`（扫残留中文）**必须用同一份** ——
 * 两边各写一份必然漂移，而桩一漂移，验的就不是同一个东西了。
 *
 * @param {object} data gather() 的产物，或内置的 FIXTURES
 */
export function buildRoutes(data) {
  /** 一条合成的失败请求：用来**稳定**触发概览页的「最近有失败」待办（真实数据里不一定正好有）。 */
  const syntheticFailure = {
    t: Date.now() - 60_000, model: 'deepseek-v4.1-flash', stream: true, ok: false, ms: 812,
    promptTokens: 100, completionTokens: 0, credit: 0, status: 429, code: 'RATE_LIMIT',
    error: '您的使用量已超出频率限制（harness 合成样例）',
  };

  const routes = {
    // checkin 固定成"今日未签到"，好让概览页的待办提醒可断言（真实数据取决于今天签没签）
    '/workbuddy/status': { ...data.status, checkin: { status: { todayCheckedIn: false, streakDays: 3, todayCredit: 0 }, auto: { auto: true } } },
    '/workbuddy/models': data.models,
    // 插件登录（第二条凭据来源）：给一条已登录的插件账号，让账号页的
    // 来源选择 / 账号行 / 按钮文案都进入 i18n 验收（空态由别的用例覆盖）。
    '/workbuddy/login': {
      ok: true,
      configured: 'plugin',
      envPinned: false,
      storeMode: 'dpapi',
      failover: 'same-account',
      fallbackReason: '',
      desktop: { available: true, error: '', userId: 'uid-fixture-0001' },
      plugin: { available: true, count: 2, activeUid: 'uid-fixture-0001', uids: ['uid-fixture-0001', 'uid-fixture-0002'], error: '' },
      sameAccount: true,
      effective: { source: 'plugin', uid: 'uid-fixture-0001', region: 'cn', endpoint: 'https://example.invalid', expiresAt: new Date(now + 86_400_000).toISOString() },
      credentials: [{
        uid: 'uid-fixture-0001',
        region: 'cn',
        nickname: 'Fixture',
        enterpriseId: '',
        domain: 'example.invalid',
        expiresAt: new Date(now + 86_400_000).toISOString(),
        updatedAt: new Date(now).toISOString(),
        active: true,
      }, {
        uid: 'uid-fixture-0002',
        region: 'global',
        nickname: 'Fixture Other',
        enterpriseId: '',
        domain: 'example.invalid',
        expiresAt: new Date(now + 86_400_000).toISOString(),
        updatedAt: new Date(now - 60_000).toISOString(),
        active: false,
      }],
    },
    // 运行中的宿主可能还是旧构建（宿主改动要重启 dsh 才生效）：早期 /workbuddy/usage
    // 套了一层 {usage:{…}}，这里按**当前契约**摊平，保证面板拿到的形状与新代码一致。
    '/workbuddy/usage': (data.usage && data.usage.usage) ? { ok: true, ...data.usage.usage } : data.usage,
    // 签到固定成"今日未签到"（真实数据取决于今天签没签），好让概览待办与签到页都可断言
    '/workbuddy/checkin': { ok: true, status: { todayCheckedIn: false, streakDays: 3, todayCredit: 0 }, auto: { auto: true, lastAt: now - 3600000, lastResult: 'ok', lastError: null, lastSource: 'manual' } },
    '/workbuddy/log': data.log,
    // 请求页故意走「首帧 404」：模拟刷新页面时宿主还没挂上路由的窗口期，
    // 面板必须自己重试恢复，而不是把 HTTP 404 红字挂一两分钟。
    '/workbuddy/requests': {
      firstStatus: 404,
      payload: {
        ok: true,
        requests: [syntheticFailure, ...((data.requests && Array.isArray(data.requests.requests)) ? data.requests.requests : [])],
        /*
         * 进行中请求必须给一条 **runningMs 超过 activeAlertMs** 的 ——
         * 「 · 流式 · 已运行 」与「 · 疑似卡死（超过 …）—— …」这两行的文案是拼接串，
         * 桩里没有就永远不渲染，也就永远不被 i18n 验收扫到
         * （静态扫描 tools/dev/check-i18n-coverage.mjs 查出来的）。
         */
        active: [
          { id: 'req-live-1', model: 'deepseek-v4.1-flash', stream: true, startedAt: now - 400_000, runningMs: 400_000 },
        ],
        activeAlertMs: 300_000,
      },
    },
    // 登录卡片的动作桩：面板的 i18n/渲染用例会点来源分段按钮
    '/workbuddy/login/source': {
      ok: true, configured: 'plugin', envPinned: false, storeMode: 'dpapi',
      credentials: [{
        uid: 'uid-fixture-0001', region: 'cn', nickname: 'Fixture', enterpriseId: '',
        expiresAt: new Date(now + 86_400_000).toISOString(), updatedAt: new Date(now).toISOString(), active: true,
      }],
    },
    '/workbuddy/login/start': { ok: true, state: 'state-fixture', url: 'https://example.invalid/login?state=state-fixture', region: 'cn' },
    '/workbuddy/login/poll': { ok: true, status: 'pending' },
    '/workbuddy/login/cancel': { ok: true },
    '/workbuddy/login/active': { ok: true },
    '/workbuddy/login/logout': { ok: true },
    '/workbuddy/bridge': { ok: true, action: 'restart', result: { ok: true, health: { pid: 4242 } } },
    '/workbuddy/console': { ok: true, action: 'start', url: 'http://127.0.0.1:8792', result: { ok: true, reused: true } },
    '/workbuddy/migrate': { ok: true, found: false, files: [], changed: false },
    // 积分刷新（POST）的桩：返回一份"刷新后"的形状
    '/workbuddy/quota': { ok: true, quota: FIXTURES.status.quota, quotaError: '', at: new Date().toISOString(), refreshed: true, bridgeState: 'running' },
    // 控制台域功能（插件透传）。这些**不依赖**实时抓取，始终用内置样例，
    // 形状与控制台一致。
    '/workbuddy/console-api/overview': FIXTURES.consoleOverview,
    '/workbuddy/console-api/accounts': FIXTURES.consoleAccounts,
    '/workbuddy/console-api/diagnose': FIXTURES.consoleDiagnose,
    '/workbuddy/console-api/probe-results': FIXTURES.consoleProbe,
    '/workbuddy/console-api/checkin': FIXTURES.consoleCheckin,
    // 对话测试：一个两帧的流（含 usage），用来验证渲染 + 逐轮元数据 + 事件流解析
    '/workbuddy/console-api/chat': {
      sse: [
        JSON.stringify({ choices: [{ delta: { content: '桥' } }] }),
        JSON.stringify({ choices: [{ delta: { content: '已接通。' }, finish_reason: 'stop' }] }),
        JSON.stringify({ choices: [{ delta: {} }], usage: { prompt_tokens: 12, completion_tokens: 5, credit: 0.004 } }),
      ],
    },
  };
  return routes;
}
