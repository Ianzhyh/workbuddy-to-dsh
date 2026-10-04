/**
 * 控制台 API 的受控透传。
 *
 * 为什么这两类功能要走控制台而不是插件自己实现：
 *
 *   - **账号切换 / 签到开关 / 体检结果** 都写在 `.state.json` 里，而控制台的
 *     `lib/state.mjs` 是**带进程内缓存**的（第一次读之后就不再碰磁盘）。如果插件
 *     自己写这个文件，控制台那份缓存就过期了 —— 页面会显示旧账号、旧体检结论，
 *     正好违反"两边同步变化"的要求。让控制台自己写，它写完顺手更新自己的缓存，
 *     两边立刻一致。
 *   - **对话测试**本来就是「浏览器 → 控制台 → 桥」的流式透传，插件再实现一遍
 *     没有意义。
 *
 * 因此这里遵守一条规则：
 *   **读**：插件自己读（同一个桥、同一份文件）；
 *   **写**：能走控制台就走控制台；控制台没跑时，能自己做的自己做（见 routes.mjs），
 *          做不了的如实报「需要先启动控制台」。
 *
 * 透传只对**白名单**开放：不做任意路径代理，免得把控制台的静态资源、调试接口
 * 一起暴露出去。
 */
import { toDirectory } from './models.mjs';

/** 允许透传的控制台接口 → 允许的方法。 */
export const CONSOLE_API_ALLOWLIST = {
  '/overview': ['GET'],
  '/diagnose': ['GET'],
  '/accounts': ['GET'],
  '/account/switch': ['POST'],
  '/probe': ['POST'],
  '/probe-results': ['GET', 'POST', 'DELETE'],
  '/checkin': ['GET', 'POST'],
  '/checkin/settings': ['POST'],
  '/chat': ['POST'],
};

/** 插件侧暴露的挂载前缀。 */
export const CONSOLE_API_PREFIX = '/workbuddy/console-api';

async function readRawBody(req, limit = 8 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  return chunks.length ? Buffer.concat(chunks) : undefined;
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

/**
 * 造一个 `(req, res)` 处理器，挂在 `CONSOLE_API_PREFIX` 前缀路由上。
 *
 * @param {object} deps
 * @param {{ url: string, probe: (o?: object) => Promise<{state: string, error?: string}> }} deps.consoleSupervisor
 * @param {(line: string, detail?: unknown) => void} [deps.log]
 */
export function createConsoleApiHandler({ consoleSupervisor, log = () => {}, onUpstreamMutation = () => {} }) {
  /** 每个请求一个，避免并发请求互相干扰（SSE 长连接尤其需要）。 */
  return async function handleConsoleApi(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const sub = url.pathname.slice(CONSOLE_API_PREFIX.length) || '/overview';
    const allowed = CONSOLE_API_ALLOWLIST[sub];
    if (!allowed) {
      return sendJson(res, 404, { ok: false, error: `未允许透传的控制台接口：${sub}`, allowed: Object.keys(CONSOLE_API_ALLOWLIST) });
    }
    const method = req.method || 'GET';
    if (!allowed.includes(method)) {
      return sendJson(res, 405, { ok: false, error: `${method} ${sub} 不被允许`, allowed });
    }
    // 写操作照旧要面板头（跨站简单请求会被 CORS 预检挡住）
    if (method !== 'GET' && req.headers['x-workbuddy-panel'] !== '1') {
      return sendJson(res, 403, { ok: false, error: 'missing x-workbuddy-panel header' });
    }

    // 会改变"上游余额/签到状态"的透传：成功后要作废插件自己的积分缓存，
    // 否则面板最长 120 秒还显示旧余额（换号 bug 的同源缺口，这是第三个消费方）
    const mutatesQuota =
      (sub === '/checkin' && method === 'POST')
      || (sub === '/account/switch' && method === 'POST');

    const probe = await consoleSupervisor.probe({ cached: true });
    if (probe.state !== 'running') {
      return sendJson(res, 503, {
        ok: false,
        state: probe.state,
        error: probe.error || '控制台没有在运行',
        hint: `这项功能由控制台提供（它保证 .state.json 只有一份写者）。先启动控制台：POST ${CONSOLE_API_PREFIX}/../console {action:"start"}`,
      });
    }

    const target = `${consoleSupervisor.url}/api${sub}${url.search}`;
    const ac = new AbortController();
    const onClose = () => { if (!res.writableEnded) ac.abort(); };
    res.on('close', onClose);

    try {
      let body;
      if (method !== 'GET' && method !== 'DELETE') {
        try { body = await readRawBody(req); } catch (error) {
          return sendJson(res, 413, { ok: false, error: String(error?.message || error) });
        }
      }
      const upstream = await fetch(target, {
        method,
        headers: {
          'content-type': req.headers['content-type'] || 'application/json',
          accept: req.headers.accept || 'application/json',
        },
        body,
        signal: ac.signal,
      });

      // 原样透传状态与类型，body 逐块转发 —— JSON 与 SSE 都能走这一条
      const headers = { 'cache-control': 'no-store' };
      const ctype = upstream.headers.get('content-type');
      if (ctype) headers['content-type'] = ctype;
      res.writeHead(upstream.status, headers);
      if (upstream.body) {
        const reader = upstream.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(Buffer.from(value));
        }
      }
      res.end();
      // 透传完成后（成功状态码才作废）：下一次 snapshot 会重新打上游取新余额
      if (mutatesQuota && upstream.ok) {
        try { onUpstreamMutation(); } catch { /* 回调异常不影响响应 */ }
      }
    } catch (error) {
      if (ac.signal.aborted) { try { res.end(); } catch { /* 客户端已断开 */ } return; }
      log(`透传 ${method} ${sub} 失败`, error);
      if (!res.headersSent) {
        sendJson(res, 502, { ok: false, error: `控制台不可达：${error?.message || error}`, hint: '确认控制台在运行（设置页可一键启动）' });
      } else {
        try { res.end(); } catch { /* 已结束 */ }
      }
    } finally {
      res.off('close', onClose);
    }
  };
}

/** 控制台体检结果（.state.json 的 probe）→ 页面用的形状。仅供测试与文档参考。 */
export function summarizeProbeResults(probe) {
  const results = probe && typeof probe === 'object' && probe.results && typeof probe.results === 'object' ? probe.results : {};
  return {
    updatedAt: Number(probe?.updatedAt) || null,
    lastRun: probe?.lastRun || null,
    results,
    count: Object.keys(results).length,
  };
}

/** 模型目录 → 体检面板要用的行（与 /workbuddy/models 同形）。 */
export function probeRowsFor(catalog) {
  return toDirectory(catalog);
}
