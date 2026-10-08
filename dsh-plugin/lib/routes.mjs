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
  const { snapshot, supervisor, consoleSupervisor, client, adapter, paths, provider, log, onUpstreamMutation = () => {}, onWritePrefs = () => {}, notifyAdaptersUpdated = () => false } = deps;

  /** 写操作的准入检查。 */
  const guard = (req) => req.headers['x-workbuddy-panel'] === '1';

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
      // 积分专用：GET 读缓存，POST 强制刷新（要面板头，避免跨站触发上游调用）
      kind: 'exact',
      path: '/workbuddy/quota',
      async handler(req, res) {
        try {
          if (req.method === 'POST') {
            if (!guard(req)) return sendJson(res, 403, { ok: false, error: 'missing x-workbuddy-panel header' });
            const snap = await snapshot({ quota: true });
            return sendJson(res, 200, { ok: snap.quota?.ok !== false, quota: snap.quota, quotaError: snap.quotaError, at: snap.quotaAt, refreshed: true });
          }
          if (readOnly(req, res)) return;
          const snap = await snapshot({});
          sendJson(res, 200, { ok: snap.quota?.ok !== false, quota: snap.quota, quotaError: snap.quotaError, at: snap.quotaAt });
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
          sendJson(res, 200, { ok: true, models: toDirectory(catalog), at: adapter.catalogCache.at, error: adapter.catalogError || '' });
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
            const visible = Array.isArray(body?.visible) ? body.visible.map(String).filter(Boolean) : [];
            // 目录里不存在的 id 也照存：上游目录可能暂时没抓到，用户勾选的意图优先，
            // 目录恢复后自然重新生效。
            adapter.setFilter({ allow: visible });
            onWritePrefs(visible);
            // 广播 llm/adapters-updated：dsh 的模型选择器**不轮询**目录，只认这个
            // 事件。不广播的话 filter 虽已生效，但 UI 会一直显示旧清单 —— 用户保存
            // 完看模型数量没变，报的就是这个。返回 applied 让前端如实告知：
            // 旧版 dsh 没有这个内部方法时 applied=false，前端提示"重启一次 dsh"。
            const applied = notifyAdaptersUpdated();
            return sendJson(res, 200, { ok: true, visible, count: visible.length, applied });
          }
          if (readOnly(req, res)) return;
          const current = typeof deps.readPrefs === 'function' ? deps.readPrefs() : null;
          sendJson(res, 200, { ok: true, visible: current, at: adapter.catalogCache.at });
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
            adapter.invalidate();
            return sendJson(res, 200, { ok: result.ok, action, result });
          }
          if (action === 'stop') {
            const result = await supervisor.stop();
            adapter.invalidate();
            return sendJson(res, 200, { ok: result.ok, action, result });
          }
          if (action === 'restart') {
            const result = await supervisor.ensure({ restart: true });
            adapter.invalidate();
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
      handler: createConsoleApiHandler({ consoleSupervisor, log, onUpstreamMutation }),
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
