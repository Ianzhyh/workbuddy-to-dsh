/**
 * 前端验收骨架：无头 Chromium + CDP + `window.fetch` 打桩。
 *
 * 为什么不用真控制台：页面要的数据（目录 / 用量 / 体检结论 / 请求明细）都来自
 * 后端接口，靠真实实例构造「已知输入」既慢又会消耗上游额度。这里只起一个
 * **静态**文件服务，把 `/api/*` 全部打桩，让页面的渲染分支完全可控。
 *
 * 用法见 tools/dev/test-r9-scope.mjs。
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PUBLIC_DIR = join(root, 'dashboard', 'public');

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 静态服务（只服务 dashboard/public）──────────────────────────────────
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };

export async function startStaticServer(port) {
  const server = createServer((req, res) => {
    const path = (req.url || '/').split('?')[0];
    const file = path === '/' ? join(PUBLIC_DIR, 'index.html') : join(PUBLIC_DIR, path.replace(/^\/+/, ''));
    if (!file.startsWith(PUBLIC_DIR) || !existsSync(file)) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(readFileSync(file));
  });
  await new Promise((ok) => server.listen(port, '127.0.0.1', ok));
  return server;
}

// ── 无头 Chrome ─────────────────────────────────────────────────────────
function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
  ];
  return candidates.find((p) => p && existsSync(p));
}

async function devtoolsPage(port) {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await res.json();
      const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* 还没起来 */ }
    await sleep(250);
  }
  throw new Error('无法连接 DevTools');
}

/** 极简 CDP 客户端。 */
function connect(url) {
  const ws = new WebSocket(url);
  let id = 0;
  const pending = new Map();
  const listeners = new Map();

  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
    if (msg.method && listeners.has(msg.method)) for (const fn of listeners.get(msg.method)) fn(msg.params);
  });

  const ready = new Promise((ok, bad) => {
    ws.addEventListener('open', ok);
    ws.addEventListener('error', () => bad(new Error('WebSocket 连接失败')));
  });

  const send = (method, params = {}) => new Promise((ok) => {
    id += 1;
    pending.set(id, ok);
    ws.send(JSON.stringify({ id, method, params }));
  });

  const on = (method, fn) => {
    if (!listeners.has(method)) listeners.set(method, []);
    listeners.get(method).push(fn);
  };

  const evaluate = async (expression) => {
    const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (res.result && res.result.exceptionDetails) {
      throw new Error(`页面求值异常：${res.result.exceptionDetails.text}\n${expression.slice(0, 300)}`);
    }
    return res.result && res.result.result ? res.result.result.value : undefined;
  };

  return { ready, send, on, evaluate, close: () => ws.close() };
}

/**
 * 把路由表序列化成**注入用的 JS 字面量**。
 *
 * 不能用 JSON.stringify：`body` 允许是函数（按查询串分流时必需），而
 * JSON.stringify 会把函数直接丢掉，页面拿到的是一个没有 body 的空路由。
 */
function serializeRoutes(routes) {
  const parts = [];
  for (const [path, r] of Object.entries(routes)) {
    const body = typeof r.body === 'function'
      ? `(${r.body.toString()})`
      : JSON.stringify(r.body === undefined ? {} : r.body);
    parts.push(`${JSON.stringify(path)}: { status: ${Number(r.status) || 200}, hang: ${!!r.hang}, delay: ${Number(r.delay) || 0}, type: ${JSON.stringify(r.type || '')}, chunks: ${JSON.stringify(r.chunks || null)}, body: ${body} }`);
  }
  return `{ ${parts.join(', ')} }`;
}

/**
 * 打桩脚本：把 `/api/*` 的响应换成测试给定值，并记录所有被请求的路径。
 *
 * routes: { '/api/models': { status?, body } }；body 为对象 / 字符串 / 函数
 *         （函数收到完整 URL，用于按查询串分流）；未命中的路径一律返回 `{}`。
 */
export function fetchStubSource(routes) {
  return `(() => {
    const ROUTES = ${serializeRoutes(routes)};
    window.__calls = [];
    window.__setRoute = (path, route) => { ROUTES[path] = route; };
    const origFetch = window.fetch;
    window.__posts = []; // 记录带 JSON body 的请求（「本轮发送 N 条消息」这类断言要用）
    window.__reqs = [];  // 记录**所有**请求的 {path, method, body}——无 body 的 POST 只能靠它
    window.fetch = async function (input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      const path = url.replace(/^https?:\\/\\/[^/]+/, '').split('?')[0];
      const method = (init && init.method) || 'GET';
      let parsed = null;
      if (init && typeof init.body === 'string') {
        try { parsed = JSON.parse(init.body); } catch (e) { parsed = null; }
      }
      window.__calls.push(path);
      window.__reqs.push({ path: path, method: method, body: parsed });
      if (parsed !== null) window.__posts.push({ path: path, method: method, body: parsed });
      const r = ROUTES[path];
      if (!r) return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (r.hang) return new Promise(() => {});
      // delay 用来观察「进行中」状态（按钮禁用 / 文案变化）
      if (r.delay) await new Promise((res) => setTimeout(res, r.delay));
      // chunks 用来模拟 SSE 分块流（每块可带自己的 delay）——「停止但已有内容」要靠它。
      // 必须**自己接 signal**：这是打桩的 fetch，浏览器不会替我们把 abort 接到流上，
      // 不接的话页面调 abort() 完全无效，「手动停止」就没法验。
      if (r.chunks) {
        const enc = new TextEncoder();
        const signal = init && init.signal;
        const stream = new ReadableStream({
          async start(controller) {
            let done = false;
            const fail = () => {
              if (done) return;
              done = true;
              try { controller.error(new DOMException('The operation was aborted.', 'AbortError')); } catch (e) { /* 已关闭 */ }
            };
            if (signal) {
              if (signal.aborted) { fail(); return; }
              signal.addEventListener('abort', fail, { once: true });
            }
            for (const c of r.chunks) {
              if (c.delay) await new Promise((res) => setTimeout(res, c.delay));
              if (done || (signal && signal.aborted)) { fail(); return; }
              try { controller.enqueue(enc.encode(c.text)); } catch (e) { return; }
            }
            if (done) return;
            done = true;
            try { controller.close(); } catch (e) { /* 已关闭 */ }
          },
        });
        return new Response(stream, { status: r.status || 200, headers: { 'Content-Type': r.type || 'text/event-stream' } });
      }
      // body 传函数时把完整 URL（含查询串）交给它：同一路径下 days=7 与
      // days=1&hours=1 往往要返回不同的数据
      const body = typeof r.body === 'function' ? r.body(url) : r.body;
      const text = typeof body === 'string' ? body : JSON.stringify(body === undefined ? {} : body);
      return new Response(text, { status: r.status || 200, headers: { 'Content-Type': r.type || 'application/json' } });
    };
    window.__origFetch = origFetch;
  })();`;
}

/**
 * 启动（或复用）无头 Chrome，打开打桩后的页面。
 * 返回 { cdp, chrome, profileDir, close() }。
 *
 * `injectStub: false` 用于**页面内嵌 iframe** 的场景：打桩脚本是装在
 * 每个新文档上的（含 iframe），而未命中路径一律回 `{}` —— 内嵌的真实页面
 * 会因此拿不到自己的数据。此时由调用方自己在页面里做打桩。
 */
export async function openPage(url, routes, { cdpPort = 9333, width = 1440, height = 900, inject = '', injectStub = true, skipShapeCheck = false } = {}) {
  /*
   * 打桩前先校验形状。
   *
   * 桩数据的字段名一旦与真实接口不一致，页面**不会报错**，只会静默地不渲染 ——
   * 而页面看起来一切正常。这个坑一天里踩了三次（用量表整张没渲染、诊断面板
   * 渲染出 undefined、签到面板显示了一个无依据的结论），每次都是
   * 「以为发现了产品 bug，其实是自己的夹具错了」。
   *
   * 所以这里**默认拒绝形状不对的桩**，让问题在渲染前就暴露。
   * 形状来自 tools/dev/api-shape.json（只有键名与类型，不含真实数据）。
   */
  if (injectStub && !skipShapeCheck) {
    const { validateRoutes, loadShape } = await import('./api-shape.mjs');
    const shape = loadShape();
    if (shape) {
      const problems = validateRoutes(routes, shape);
      if (problems.length) {
        const detail = problems.map((p) => {
          const lines = [`  ${p.route}`];
          if (p.missing && p.missing.length) {
            lines.push(`    缺少：${p.missing.slice(0, 6).join(', ')}${p.missing.length > 6 ? ` …共 ${p.missing.length} 项` : ''}`);
          }
          if (p.unknown && p.unknown.length) {
            lines.push(`    真实接口没有这些键（多半是名字写错了）：${p.unknown.slice(0, 6).join(', ')}`);
          }
          return lines.join('\n');
        }).join('\n');
        throw new Error(
          '桩数据与真实接口形状不一致 —— 页面会静默地不渲染，先修夹具再跑：\n' + detail
          + '\n  形状来源：tools/dev/api-shape.json（重取：node tools/dev/api-shape.mjs capture）'
          + '\n  确实需要绕过时传 skipShapeCheck: true',
        );
      }
    }
  }

  let chrome = null;
  let profileDir = null;
  let wsUrl;
  try {
    wsUrl = await devtoolsPage(cdpPort);
  } catch {
    const exe = findChrome();
    if (!exe) throw new Error('找不到 Chrome/Edge，请设置 CHROME_PATH');
    profileDir = mkdtempSync(join(tmpdir(), 'wb-cdp-'));
    chrome = spawn(exe, [
      '--headless=new',
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      `--window-size=${width},${height}`,
      'about:blank',
    ], { stdio: 'ignore', detached: true });
    chrome.unref();
    wsUrl = await devtoolsPage(cdpPort);
  }

  const cdp = connect(wsUrl);
  await cdp.ready;
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });

  /**
   * 清空目标源的 local/sessionStorage —— 必须在**导航之前**。
   *
   * 为什么需要：openPage 会**复用**已在调试端口上的浏览器（为了多个脚本串跑
   * 时不必反复冷启动），而复用的页面带着上一次运行留下的存储。实测：重复跑
   * test-r3-alerts 时，上一轮点过的「知道了」把 `wb.muted.token=1` 留在了
   * localStorage 里，令牌提醒就不再出现 —— 断言全部以脏状态开跑，且看起来
   * 像产品坏了。测试脚本永远假设自己从干净状态开始，这里统一兑现这个前提。
   * （新起的 profile 本来就是干净的，这一步对它是无害的空操作。）
   */
  try {
    await cdp.send('Storage.clearDataForOrigin', {
      origin: new URL(url).origin,
      storageTypes: 'local_storage,session_storage',
    });
  } catch { /* 个别发行版没有该命令时忽略：新 profile 不受影响 */ }

  if (injectStub) await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: fetchStubSource(routes) });
  if (inject) await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: inject });

  // confirm() / alert() 会阻塞页面：必须始终接管，否则页面直接卡死。
  // 默认接受；测试可以用 setDialogHandler 改成拒绝，并读取 last 检查文案。
  const dialog = { last: null, handler: null };
  cdp.on('Page.javascriptDialogOpening', (p) => {
    dialog.last = p.message;
    const accept = dialog.handler ? dialog.handler(p.message) : true;
    cdp.send('Page.handleJavaScriptDialog', { accept: !!accept });
  });

  const loaded = new Promise((ok) => cdp.on('Page.loadEventFired', ok));
  await cdp.send('Page.navigate', { url });
  await Promise.race([loaded, sleep(8000)]);

  const close = () => {
    try { cdp.close(); } catch { /* 忽略 */ }
    if (chrome) { try { chrome.kill(); } catch { /* 忽略 */ } }
    if (profileDir) { try { rmSync(profileDir, { recursive: true, force: true }); } catch { /* 忽略 */ } }
  };
  return {
    cdp,
    close,
    /** 最近一次 confirm 的文案。 */
    lastDialog: () => dialog.last,
    /** 设置对话框处理：返回 true 接受，false 取消。 */
    setDialogHandler: (fn) => { dialog.handler = fn; },
  };
}

/** 等待页面条件成立。 */
export async function waitFor(cdp, expr, timeoutMs = 10000, label = expr) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let v;
    try { v = await cdp.evaluate(expr); } catch { v = false; }
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`等待超时（${timeoutMs}ms）：${label}`);
    await sleep(150);
  }
}

export const click = (cdp, sel) => cdp.evaluate(
  `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.click(); return true; })()`,
);

export const q = (cdp, expr) => cdp.evaluate(expr);
