/**
 * 面板的 HTTP 数据面 —— 客户端半边（lib/client.js）通过同源 fetch 调它。
 *
 * 为什么走 webServer 路由而不是 RPC/typert：客户端半边只要求「读状态 + 触发
 * 启停」，用普通 HTTP 路由最简单、最好调试，也不必为它维护一套严格反射定义。
 *
 * 安全边界：
 *   - 路由挂在 dsh 自己的 Web 载体上（只监听回环地址）；
 *   - **写操作**额外要求 `x-workbuddy-panel: 1` 头：这会让跨站表单/简单请求
 *     直接打不进来（带自定义头会触发 CORS 预检，而预检不会被放行），
 *     等于用最小代价挡掉 CSRF；读操作只暴露非敏感元数据。
 */
import { writeFileSync } from 'node:fs';

import { cleanLegacyRoutes, detectLegacyRoutes } from './legacy.mjs';
import { toDirectory } from './models.mjs';
import { createConsoleApiHandler, CONSOLE_API_PREFIX } from './consoleApi.mjs';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { ...JSON_HEADERS, 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

async function readJsonBody(req, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('request body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return {}; }
}

/** 校验"每模型默认参数"：只收认识且合法的字段，其余丢弃。 */
function sanitizeModelParams(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const out = {};
  if (typeof input.temperature === 'number' && Number.isFinite(input.temperature)
    && input.temperature >= 0 && input.temperature <= 2) out.temperature = input.temperature;
  if (Number.isInteger(input.maxTokens) && input.maxTokens > 0) out.maxTokens = input.maxTokens;
  if (typeof input.reasoningEffort === 'string' && input.reasoningEffort.trim()) out.reasoningEffort = input.reasoningEffort.trim();
  return Object.keys(out).length ? out : null;
}

/**
 * @param {object} deps
 * @param {() => object} deps.snapshot 运行态快照
 * @param {() => object} deps.supervisor 桥管理器
 * @param {() => object} deps.consoleSupervisor 控制台管理器
 * @param {() => object} deps.client 桥客户端
 * @param {() => object} deps.adapter
 * @param {object} deps.paths { settingsPath, patchPath }
 * @param {string} deps.provider
 * @param {(line: string, detail?: unknown) => void} deps.log
 */
export function createRouteTable(deps) {
  const {
    snapshot, supervisor, consoleSupervisor, client, adapter, paths, provider, log,
    onUpstreamMutation = () => {}, onWritePrefs = () => {}, notifyAdaptersUpdated = () => false,
    enableWebSearch = async () => { throw new Error('web search configuration is unavailable'); },
    verifyWebSearch = async () => { throw new Error('web search verification is unavailable'); },
    revertWebSearch = async () => { throw new Error('web search restore is unavailable'); },
  } = deps;

  /** 写操作的准入检查。 */
  const guard = (req) => req.headers['x-workbuddy-panel'] === '1';

  /**
   * 凭据/账号变了：目录属于旧账号，必须重取，并通知 dsh 的模型选择器。
   * dsh 不轮询目录，只认 `llm/adapters-updated`；只 invalidate 不通知的话，
   * 用户登录成功、模型其实已经可用，选择器里却还是旧清单（看起来像没登录）。
   */
  const refreshModelCatalog = () => {
    adapter.invalidate();
    const task = typeof adapter.warmup === 'function' ? adapter.warmup() : Promise.resolve();
    Promise.resolve(task).then(
      () => notifyAdaptersUpdated(),
      () => notifyAdaptersUpdated(),
    );
  };

  /**
   * 只读路由的方法守门：只允许 GET/HEAD。
   * 目前非 GET 走进去也只是"当成读"（没有副作用），但显式拒绝更严谨 ——
   * 免得将来有人在某个读分支里加写逻辑，而代理/表单又恰好能打到它。
   */
  const readOnly = (req, res) => {
    if (req.method === 'GET' || req.method === 'HEAD') return false;
    sendJson(res, 405, { ok: false, error: `${req.method} not allowed on a read-only route` });
    return true;
  };

  return [
    {
      kind: 'exact',
      path: '/workbuddy/status',
      async handler(req, res) {
        if (readOnly(req, res)) return;
        try {
          // ?quota=1：**强制**重读积分（平时 120 秒缓存；面板上的"刷新"按钮要立刻看到新值）
          const url = new URL(req.url, 'http://127.0.0.1');
          const forceQuota = url.searchParams.get('quota') === '1';
          sendJson(res, 200, { ok: true, ...(await snapshot({ quota: forceQuota })) });
        } catch (error) {
          log('panel status failed', error);
          sendJson(res, 500, { ok: false, error: String(error?.message || error) });
        }
      },
    },
    {
      kind: 'exact',
      path: '/workbuddy/web-search/enable',
      async handler(req, res) {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: `${req.method} not allowed` });
        if (!guard(req)) return sendJson(res, 403, { ok: false, error: 'missing x-workbuddy-panel header' });
        try {
          const result = await enableWebSearch();
          sendJson(res, 200, { ok: true, ...result });
        } catch (error) {
          log('panel web-search configure failed', error);
          sendJson(res, 500, { ok: false, error: String(error?.message || error) });
        }
      },
    },
    {
      // 只跑自检、不改配置：状态卡上的「重新检测」用它，避免为了看一眼结果
      // 重新写入 settings/credentials。真实搜索会消耗一次额度，因此仍要求面板头。
      kind: 'exact',
      path: '/workbuddy/web-search/verify',
      async handler(req, res) {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: `${req.method} not allowed` });
        if (!guard(req)) return sendJson(res, 403, { ok: false, error: 'missing x-workbuddy-panel header' });
        try {
          const result = await verifyWebSearch();
          sendJson(res, 200, { ok: true, ...result });
        } catch (error) {
          log('panel web-search verify failed', error);
          sendJson(res, 500, { ok: false, error: String(error?.message || error) });
        }
      },
    },
    {
      // 恢复一键接入前的 dsh 搜索配置。只改 dsh settings/独立凭据引用，
      // 不碰 WorkBuddy 客户端文件；仍要求面板头，避免跨站触发配置回滚。
      kind: 'exact',
      path: '/workbuddy/web-search/revert',
      async handler(req, res) {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: `${req.method} not allowed` });
        if (!guard(req)) return sendJson(res, 403, { ok: false, error: 'missing x-workbuddy-panel header' });
        try {
          const result = await revertWebSearch();
          sendJson(res, 200, { ok: true, ...result });
        } catch (error) {
          log('panel web-search restore failed', error);
          sendJson(res, 500, { ok: false, error: String(error?.message || error) });
        }
      },
    },
    {
      // 积分专用：GET 读缓存，POST 强制刷新（要面板头，避免跨站触发上游调用）
      kind: 'exact',
      path: '/workbuddy/quota',
      async handler(req, res) {
        try {
          if (req.method === 'POST') {
            if (!guard(req)) return sendJson(res, 403, { ok: false, error: 'missing x-workbuddy-panel header' });
            const snap = await snapshot({ quota: true });
            return sendJson(res, 200, {
              ok: snap.quota?.ok !== false,
              quota: snap.quota,
              quotaError: snap.quotaError,
              at: snap.quotaAt,
              refreshed: true,
              /*
               * 桥状态随积分一起返回：桥掉登录态时 quota 可能还是上一个账号的
               * 缓存，光看 `ok/quotaError` 分辨不出来。客户端据此决定要不要
               * 把胶囊换成登录入口，不必再单独轮询 /workbuddy/status。
               */
              bridgeState: snap.bridge?.state || '',
              bridgeAccount: snap.bridgeAccount || null,
              quotaAccount: snap.quotaAccount || null,
            });
          }
          if (readOnly(req, res)) return;
          const snap = await snapshot({});
          sendJson(res, 200, {
            ok: snap.quota?.ok !== false,
            quota: snap.quota,
            quotaError: snap.quotaError,
            at: snap.quotaAt,
            bridgeState: snap.bridge?.state || '',
            bridgeAccount: snap.bridgeAccount || null,
            quotaAccount: snap.quotaAccount || null,
          });
        } catch (error) {
          sendJson(res, 200, { ok: false, error: String(error?.message || error) });
        }
      },
    },
    {
      // 插件登录状态：来源 + 凭据清单。桥是唯一事实来源；这里只做展示。
      // 响应里**永远不含** access / refresh token（桥侧已经保证，这里也不二次加工）。
      kind: 'exact',
      path: '/workbuddy/login',
      async handler(req, res) {
        if (readOnly(req, res)) return;
        try {
          const [source, creds] = await Promise.all([client.authSource(), client.authCredentials()]);
          sendJson(res, 200, {
            ok: true,
            ...source,
            configuredSource: creds.configuredSource,
            credentials: Array.isArray(creds.credentials) ? creds.credentials : [],
          });
        } catch (error) {
          sendJson(res, 200, { ok: false, error: String(error?.message || error), credentials: [] });
        }
      },
    },
    {
      kind: 'exact',
      path: '/workbuddy/login/start',
      async handler(req, res) {
        if (!guard(req)) return sendJson(res, 403, { ok: false, error: 'missing x-workbuddy-panel header' });
        try {
          const body = await readJsonBody(req);
          const started = await client.deviceLoginStart({
            region: body?.region === 'global' ? 'global' : 'cn',
            open: body?.open === true,
          });
          sendJson(res, 200, { ok: true, ...started });
        } catch (error) {
          sendJson(res, 200, { ok: false, error: String(error?.message || error) });
        }
      },
    },
    {
      kind: 'exact',
      path: '/workbuddy/login/poll',
      async handler(req, res) {
        if (!guard(req)) return sendJson(res, 403, { ok: false, error: 'missing x-workbuddy-panel header' });
        try {
          const body = await readJsonBody(req);
          if (!body?.state) return sendJson(res, 400, { ok: false, error: 'state is required' });
          const result = await client.deviceLoginPoll(String(body.state));
          if (result?.status === 'ready') {
            // 账号换了：模型目录与余额/签到缓存都属于上一个账号
            refreshModelCatalog();
            onUpstreamMutation();
          }
          sendJson(res, 200, result);
        } catch (error) {
          sendJson(res, 200, { ok: false, error: String(error?.message || error) });
        }
      },
    },
    {
      kind: 'exact',
      path: '/workbuddy/login/cancel',
      async handler(req, res) {
        if (!guard(req)) return sendJson(res, 403, { ok: false, error: 'missing x-workbuddy-panel header' });
        try {
          const body = await readJsonBody(req);
          const result = await client.deviceLoginCancel(String(body?.state || ''));
          sendJson(res, 200, { ok: true, ...result });
        } catch (error) {
          sendJson(res, 200, { ok: false, error: String(error?.message || error) });
        }
      },
    },
    {
      kind: 'exact',
      path: '/workbuddy/login/active',
      async handler(req, res) {
        if (!guard(req)) return sendJson(res, 403, { ok: false, error: 'missing x-workbuddy-panel header' });
        try {
          const body = await readJsonBody(req);
          if (!body?.uid) return sendJson(res, 400, { ok: false, error: 'uid is required' });
          const result = await client.authSetActive(String(body.uid));
          refreshModelCatalog();
          onUpstreamMutation();
          sendJson(res, 200, { ok: true, ...result });
        } catch (error) {
          sendJson(res, 200, { ok: false, error: String(error?.message || error) });
        }
      },
    },
    {
      kind: 'exact',
      path: '/workbuddy/login/logout',
      async handler(req, res) {
        if (!guard(req)) return sendJson(res, 403, { ok: false, error: 'missing x-workbuddy-panel header' });
        try {
          const body = await readJsonBody(req);
          if (!body?.uid) return sendJson(res, 400, { ok: false, error: 'uid is required' });
          const result = await client.authLogout(String(body.uid));
          refreshModelCatalog();
          onUpstreamMutation();
          sendJson(res, 200, { ok: true, ...result });
        } catch (error) {
          sendJson(res, 200, { ok: false, error: String(error?.message || error) });
        }
      },
    },
    {
      kind: 'exact',
      path: '/workbuddy/login/source',
      async handler(req, res) {
        if (!guard(req)) return sendJson(res, 403, { ok: false, error: 'missing x-workbuddy-panel header' });
        try {
          const body = await readJsonBody(req);
          const result = await client.setAuthSource(String(body?.source || 'auto'));
          refreshModelCatalog();
          onUpstreamMutation();
          sendJson(res, 200, { ok: true, ...result });
        } catch (error) {
          sendJson(res, 200, { ok: false, error: String(error?.message || error) });
        }
      },
    },
    {
      kind: 'exact',
      path: '/workbuddy/models',
      async handler(req, res) {
        if (readOnly(req, res)) return;
        try {
          const url = new URL(req.url, 'http://127.0.0.1');
          const refresh = url.searchParams.get('refresh') === '1';
          const catalog = await adapter.catalog({ refresh });
          // 返回**归一化后**的目录（contextWindow/maxTokens/images/free…），
          // 不退上游原始字段名（context_window/max_output_tokens）：
          // 面板与其它消费者只认一种形状，免得两处各说一套。
          sendJson(res, 200, {
            ok: true,
            models: toDirectory(catalog),
            at: adapter.catalogCache.at,
            error: adapter.catalogError || '',
            // staleMs>0 = 这次强制刷新失败、退回旧缓存：面板要能如实说"你看到的是旧目录"
            refreshed: adapter.lastRefresh?.refresh === true,
            staleMs: Number(adapter.lastRefresh?.staleMs) || 0,
          });
        } catch (error) {
          sendJson(res, 200, { ok: false, models: [], error: String(error?.message || error) });
        }
      },
    },
    {
      // 模型显示偏好：GET 读当前生效清单，POST 写并即时生效（无需重启）。
      // 读：任何 GET 都行（非敏感）；写：要面板头（挡跨站，与其它写路由一致）。
      // 注意这里**没有**碰 .state.json —— 那份文件是控制台的单写者领地，
      // 偏好存在插件自己的 .model-prefs.json（见 index.js 里的说明）。
      kind: 'exact',
      path: '/workbuddy/model-visibility',
      async handler(req, res) {
        try {
          if (req.method === 'POST') {
            if (!guard(req)) return sendJson(res, 403, { ok: false, error: 'missing x-workbuddy-panel header' });
            const body = await readJsonBody(req);
            const current = (typeof deps.readPrefs === 'function' ? deps.readPrefs() : null)
              || { visible: null, hideAll: false, paramsByModel: {} };
            /*
             * 每模型默认参数：与"显示哪些"分开保存（同一份 prefs 文件的不同字段）。
             * `params: null` = 清除该模型的默认参数；其余字段做白名单校验。
             */
            if (typeof body?.model === 'string' && Object.prototype.hasOwnProperty.call(body, 'params')) {
              const model = body.model;
              const paramsByModel = { ...(current.paramsByModel || {}) };
              const cleaned = body.params === null ? null : sanitizeModelParams(body.params);
              if (cleaned) paramsByModel[model] = cleaned;
              else delete paramsByModel[model];
              if (typeof adapter.setModelParams === 'function') adapter.setModelParams(paramsByModel);
              onWritePrefs({
                visible: current.visible,
                hideAll: current.hideAll === true,
                includeUnofficial: current.includeUnofficial === true,
                paramsByModel,
              });
              return sendJson(res, 200, { ok: true, model, params: paramsByModel[model] || null, paramsByModel });
            }
            /*
             * 「显示官方目录外的模型」：与 visible/hideAll 正交。
             * 官方列表（official=true）之外的老型号/未开通线路默认不进 dsh
             * 选择器；打开这个开关后按 visible 的规则一并显示。
             *
             * 只有**单独**提交这个开关时才走捷径。面板保存会同时带
             * `visible`/`unset`/`hideAll` —— 旧实现先命中这里就直接返回，
             * 把用户的勾选整批丢掉（实测：保存后面板读回空数组）。
             */
            const hasVisibilityIntent = Object.prototype.hasOwnProperty.call(body, 'visible')
              || Object.prototype.hasOwnProperty.call(body, 'unset')
              || Object.prototype.hasOwnProperty.call(body, 'hideAll');
            if (typeof body?.includeUnofficial === 'boolean' && !hasVisibilityIntent) {
              const includeUnofficial = body.includeUnofficial;
              adapter.setFilter({
                allow: current.visible === null ? undefined : (current.visible || []),
                hideAll: current.hideAll === true,
                includeUnofficial,
              });
              onWritePrefs({
                visible: current.visible,
                hideAll: current.hideAll === true,
                includeUnofficial,
                paramsByModel: current.paramsByModel || {},
              });
              const applied = notifyAdaptersUpdated();
              return sendJson(res, 200, { ok: true, includeUnofficial, applied });
            }
            /*
             * 三种显示意图，必须分开建模（旧实现只认 `visible` 数组）：
             *   - unset（恢复全部）：回到配置的 allow/deny（每模型参数保留）；
             *   - hideAll（全不选）：一个都不显示 —— `visible: []` 单独存在时
             *     不能当成"没设置"，否则 dsh 里反而全部还在；
             *   - 勾选清单：只显示这些。
             */
            const wantsUnset = body?.unset === true || body?.visible === null;
            const includeUnofficial = typeof body?.includeUnofficial === 'boolean'
              ? body.includeUnofficial
              : current.includeUnofficial === true;
            if (wantsUnset) {
              // 只重置"哪些模型显示"，不重置"是否包含官方目录外"
              adapter.resetFilter();
              adapter.setFilter({ includeUnofficial });
              onWritePrefs({
                visible: null,
                hideAll: false,
                includeUnofficial,
                paramsByModel: current.paramsByModel || {},
              });
              const applied = notifyAdaptersUpdated();
              return sendJson(res, 200, {
                ok: true, unset: true, visible: null, hideAll: false, includeUnofficial, count: 0, applied,
              });
            }
            const visible = Array.isArray(body?.visible) ? body.visible.map(String).filter(Boolean) : [];
            const hideAll = body?.hideAll === true || visible.length === 0;
            // 目录里不存在的 id 也照存：上游目录可能暂时没抓到，用户勾选的意图优先，
            // 目录恢复后自然重新生效。
            adapter.setFilter({ allow: visible, hideAll, includeUnofficial });
            onWritePrefs({
              visible,
              hideAll,
              includeUnofficial,
              paramsByModel: current.paramsByModel || {},
            });
            // 广播 llm/adapters-updated：dsh 的模型选择器**不轮询**目录，只认这个
            // 事件。不广播的话 filter 虽已生效，但 UI 会一直显示旧清单。
            const applied = notifyAdaptersUpdated();
            return sendJson(res, 200, {
              ok: true,
              unset: false,
              visible,
              hideAll,
              includeUnofficial,
              count: hideAll ? 0 : visible.length,
              applied,
            });
          }
          if (readOnly(req, res)) return;
          const current2 = typeof deps.readPrefs === 'function' ? deps.readPrefs() : null;
          const filter = typeof adapter.filterSnapshot === 'function'
            ? adapter.filterSnapshot()
            : { allow: [], deny: [], hideAll: false };
          sendJson(res, 200, {
            ok: true,
            // `unset` 与 `visible: []` 是两种状态：前者=跟随配置（全显示），
            // 后者=用户点过"全不选"（全隐藏）。只有每模型参数、没有显示偏好时
            // visible 也是 null（显示跟随配置）。
            unset: !current2 || current2.visible === null,
            visible: current2 ? current2.visible : null,
            hideAll: current2 ? current2.hideAll === true : false,
            /** 是否把官方目录外的模型也放进 dsh 选择器 */
            includeUnofficial: current2 ? current2.includeUnofficial === true : false,
            /** 每模型默认参数（面板详情里编辑） */
            paramsByModel: typeof adapter.modelParamsSnapshot === 'function'
              ? adapter.modelParamsSnapshot()
              : (current2?.paramsByModel || {}),
            /** 配置里 modelDeny 排除的模型：面板据此标出来，避免"勾了也不出现"的疑惑 */
            deny: filter.deny || [],
            at: adapter.catalogCache.at,
          });
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String(error?.message || error) });
        }
      },
    },
    {
      kind: 'exact',
      path: '/workbuddy/usage',
      async handler(req, res) {
        try {
          if (req.method === 'DELETE') {
            if (!guard(req)) return sendJson(res, 403, { ok: false, error: 'missing x-workbuddy-panel header' });
            // 账本由桥维护（内存副本 + 文件），必须让桥自己清 —— 与控制器同一条路径
            await client.clearUsage();
            return sendJson(res, 200, { ok: true, cleared: true });
          }
          const url = new URL(req.url, 'http://127.0.0.1');
          const days = Math.min(Math.max(Number(url.searchParams.get('days')) || 7, 1), 90);
          const hours = url.searchParams.get('hours') === '1';
          sendJson(res, 200, { ok: true, ...(await client.usage({ days, hours })) });
        } catch (error) {
          sendJson(res, 200, { ok: false, error: String(error?.message || error) });
        }
      },
    },
    {
      kind: 'exact',
      path: '/workbuddy/requests',
      async handler(req, res) {
        if (readOnly(req, res)) return;
        try {
          const url = new URL(req.url, 'http://127.0.0.1');
          const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 500);
          sendJson(res, 200, { ok: true, ...(await client.requests({ limit })) });
        } catch (error) {
          sendJson(res, 200, { ok: false, error: String(error?.message || error) });
        }
      },
    },
    {
      kind: 'exact',
      path: '/workbuddy/log',
      async handler(req, res) {
        try {
          if (req.method === 'DELETE') {
            if (!guard(req)) return sendJson(res, 403, { ok: false, error: 'missing x-workbuddy-panel header' });
            // 桥持有 bridge.log 的追加 fd：截断后它从新文件末尾继续（O_APPEND），与控制器一致
            try {
              writeFileSync(supervisor.logPath, '');
              return sendJson(res, 200, { ok: true, cleared: true });
            } catch (error) {
              return sendJson(res, 500, { ok: false, cleared: false, error: String(error?.message || error) });
            }
          }
          const url = new URL(req.url, 'http://127.0.0.1');
          const lines = Math.min(Math.max(Number(url.searchParams.get('lines')) || 200, 1), 2000);
          sendJson(res, 200, { ok: true, ...supervisor.readLog({ lines }) });
        } catch (error) {
          sendJson(res, 200, { ok: false, error: String(error?.message || error) });
        }
      },
    },
    {
      kind: 'exact',
      path: '/workbuddy/checkin',
      async handler(req, res) {
        try {
          // GET = 读状态；POST?claim=1 = 领取（写，需要面板头）；其它方法拒绝
          if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'POST') {
            return sendJson(res, 405, { ok: false, error: `${req.method} not allowed` });
          }
          const url = new URL(req.url, 'http://127.0.0.1');
          const claim = req.method === 'POST' && url.searchParams.get('claim') === '1';
          if (claim && !guard(req)) return sendJson(res, 403, { ok: false, error: 'missing x-workbuddy-panel header' });
          const result = await client.checkin({ claim });
          // 领取成功 = 上游余额变了：作废插件侧积分/签到缓存（下一次快照重取新值），
          // 否则面板最长 120 秒还显示领取前的余额
          if (claim && result?.ok !== false) onUpstreamMutation();
          sendJson(res, 200, { ok: true, ...result });
        } catch (error) {
          sendJson(res, 200, { ok: false, error: String(error?.message || error) });
        }
      },
    },
    {
      kind: 'exact',
      path: '/workbuddy/bridge',
      async handler(req, res) {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' });
        if (!guard(req)) return sendJson(res, 403, { ok: false, error: 'missing x-workbuddy-panel header' });
        try {
          const body = await readJsonBody(req);
          const action = String(body?.action || 'status');
          if (action === 'start') {
            const result = await supervisor.ensure({});
            refreshModelCatalog();
            return sendJson(res, 200, { ok: result.ok, action, result });
          }
          if (action === 'stop') {
            const result = await supervisor.stop();
            adapter.invalidate();
            return sendJson(res, 200, { ok: result.ok, action, result });
          }
          if (action === 'restart') {
            const result = await supervisor.ensure({ restart: true });
            refreshModelCatalog();
            return sendJson(res, 200, { ok: result.ok, action, result });
          }
          const probe = await supervisor.probe();
          return sendJson(res, 200, { ok: true, action: 'status', result: probe });
        } catch (error) {
          log('panel bridge action failed', error);
          sendJson(res, 500, { ok: false, error: String(error?.message || error) });
        }
      },
    },
    {
      kind: 'exact',
      path: '/workbuddy/console',
      async handler(req, res) {
        try {
          if (req.method !== 'POST') {
            if (readOnly(req, res)) return;
            const probe = await consoleSupervisor.probe({ cached: false });
            return sendJson(res, 200, { ok: true, url: consoleSupervisor.url, state: probe.state, error: probe.error || '', managed: consoleSupervisor.spawnedPid !== null });
          }
          if (!guard(req)) return sendJson(res, 403, { ok: false, error: 'missing x-workbuddy-panel header' });
          const body = await readJsonBody(req);
          const action = String(body?.action || 'start');
          if (action === 'stop') {
            const result = await consoleSupervisor.stop();
            return sendJson(res, 200, { ok: result.ok, action, url: consoleSupervisor.url, result });
          }
          const result = await consoleSupervisor.ensure({});
          return sendJson(res, 200, { ok: result.ok, action: 'start', url: consoleSupervisor.url, result });
        } catch (error) {
          log('panel console action failed', error);
          sendJson(res, 500, { ok: false, error: String(error?.message || error) });
        }
      },
    },
    {
      kind: 'exact',
      path: '/workbuddy/migrate',
      async handler(req, res) {
        try {
          if (req.method === 'POST') {
            if (!guard(req)) return sendJson(res, 403, { ok: false, error: 'missing x-workbuddy-panel header' });
            const body = await readJsonBody(req);
            const dryRun = body?.dryRun === true;
            const result = cleanLegacyRoutes({ settingsPath: paths.settingsPath, patchPath: paths.patchPath, provider, dryRun });
            log(`legacy cleanup ${dryRun ? '(dry-run) ' : ''}changed=${result.changed}`);
            return sendJson(res, 200, { ok: true, ...result });
          }
          if (readOnly(req, res)) return;
          const detected = detectLegacyRoutes({ settingsPath: paths.settingsPath, patchPath: paths.patchPath, provider });
          sendJson(res, 200, { ok: true, ...detected });
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String(error?.message || error) });
        }
      },
    },
    // 控制台域的功能（账号 / 诊断 / 体检 / 对话测试 / 自动签到开关）原样透传，
    // 白名单见 consoleApi.mjs —— 单写者，两边状态才不会各说一套。
    {
      kind: 'prefix',
      path: CONSOLE_API_PREFIX,
      handler: createConsoleApiHandler({
        consoleSupervisor,
        log,
        onUpstreamMutation,
        onAccountSwitch: refreshModelCatalog,
      }),
    },
  ];
}

/**
 * 把路由表挂到 dsh 的 Web 载体上。
 * @param {object} target 要么是 webServer 服务本身，要么是一个能 `get('webServer')` 的 ctx
 * @returns {() => void} 幂等 disposer
 */
export function mountRoutes(target, routes, log = () => {}) {
  const webServer = typeof target?.register === 'function' ? target : target?.get?.('webServer');
  if (!webServer) {
    log('webServer 服务不可用，面板数据面未挂载（GUI 面板会显示离线）');
    return () => {};
  }
  const disposers = [];
  for (const route of routes) {
    try {
      disposers.push(webServer.register({ kind: route.kind, path: route.path, handler: route.handler }));
    } catch (error) {
      log(`挂载路由 ${route.path} 失败`, error);
    }
  }
  log(`已挂载 ${disposers.length}/${routes.length} 条面板路由`);
  return () => { for (const dispose of disposers.splice(0)) { try { dispose(); } catch { /* 忽略 */ } } };
}
