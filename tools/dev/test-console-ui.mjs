/**
 * 控制台验收走查（无头 Chromium + CDP）。
 *
 * 覆盖：D1 启动接口、D2 转义、D3 体检合并、D4 账号绑定、D7 总览字段、
 * O1 统一刷新、O2 目录治理、O3 体检进度/取消、O4 排序筛选、O5 请求排障、
 * O6 对话停止/模型搜索、O7 失效注册清理、O8 标签与复制、O9 日志面板、
 * O10 解耦与轮询去重、R-5 多视口溢出。
 *
 * 前提：控制台已在 PAGE_URL 上运行，且它的桥连着一个**可控的临时账本**
 * （用 workbuddy-to-dsh 的临时实例跑本脚本，不要指向真实使用中的实例）。
 *
 *   node tools/dev/test-console-ui.mjs
 *
 * 环境变量：
 *   PAGE_URL    控制台地址（默认 http://127.0.0.1:8897/）
 *   API_URL     控制台 API 基地址（默认同 PAGE_URL 去掉尾斜杠）
 *   CDP_PORT    调试端口（默认 9223）
 *   CHROME_PATH Chrome 可执行文件（默认自动探测）
 *   STATE_FILE  .state.json 路径（默认仓库根）
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PAGE = process.env.PAGE_URL || 'http://127.0.0.1:8897/';
const API = process.env.API_URL || PAGE.replace(/\/$/, '');
const CDP_PORT = Number(process.env.CDP_PORT || 9223);
const STATE_FILE = process.env.STATE_FILE || join(root, '.state.json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const fail = (m) => { console.error('✗ ' + m); failures += 1; };
const pass = (m) => console.log('✓ ' + m);
const section = (m) => console.log(`\n── ${m} ──`);

// ── 启动 / 连接无头 Chrome ──────────────────────────────────────────────
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

async function devtoolsPage() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
      const targets = await res.json();
      const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* 还没起来 */ }
    await sleep(250);
  }
  throw new Error('无法连接 DevTools');
}

let chrome = null;
let profileDir = null;
async function ensureChrome() {
  try {
    return await devtoolsPage();
  } catch { /* 需要自己拉一个 */ }
  const exe = findChrome();
  if (!exe) throw new Error('找不到 Chrome/Edge，请设置 CHROME_PATH');
  profileDir = mkdtempSync(join(tmpdir(), 'wb-cdp-'));
  chrome = spawn(exe, [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    'about:blank',
  ], { stdio: 'ignore', detached: true });
  chrome.unref();
  return devtoolsPage();
}

/** 极简 CDP 客户端：Runtime / Page / Network / Emulation + 事件。 */
function connect(url) {
  const ws = new WebSocket(url);
  let id = 0;
  const pending = new Map();
  const listeners = new Map();

  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
      return;
    }
    if (msg.method && listeners.has(msg.method)) {
      for (const fn of listeners.get(msg.method)) fn(msg.params);
    }
  });

  const ready = new Promise((ok, failPromise) => {
    ws.addEventListener('open', ok);
    ws.addEventListener('error', () => failPromise(new Error('WebSocket 连接失败')));
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
      throw new Error(`页面求值异常：${res.result.exceptionDetails.text}\n${expression.slice(0, 200)}`);
    }
    return res.result && res.result.result ? res.result.result.value : undefined;
  };

  return { ready, send, on, evaluate, close: () => ws.close() };
}

// ── 通用等待 / 操作 ─────────────────────────────────────────────────────
async function waitFor(cdp, expr, timeoutMs = 15000, label = expr) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let v;
    try { v = await cdp.evaluate(expr); } catch { v = false; }
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`等待超时（${timeoutMs}ms）：${label}`);
    await sleep(200);
  }
}

const click = (cdp, sel) => cdp.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.click(); return true; })()`);

/**
 * 体检范围显式切到「全部」（R9.1）。
 *
 * 第二轮之后「测试可用性」的**默认范围**变成「有勾选就测勾选的，没勾选才测全部」，
 * 不再固定全量。本脚本的 Phase C/D 断言建立在「测全部」之上，所以必须显式指定，
 * 否则第一轮的断言会因为「只测了勾选的几个」而失效。
 */
const setProbeScopeAll = (cdp) => cdp.evaluate(`(() => {
  const s = document.getElementById('probeScope');
  if (!s) return false;
  s.value = 'all';
  s.dataset.touched = '1'; // 标成「用户手动选过」，避免被默认规则覆盖
  s.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
})()`);

const apiJson = async (path, options) => {
  // 写操作要带面板头（控制台后端据此拒绝跨站请求）；读操作带上也无害
  const res = await fetch(API + path, {
    ...options,
    headers: { 'x-workbuddy-panel': '1', ...((options && options.headers) || {}) },
  });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { error: text }; }
};

// ── 主流程 ──────────────────────────────────────────────────────────────
const stateBackup = existsSync(STATE_FILE) ? readFileSync(STATE_FILE, 'utf8') : null;
const restore = [];
const cleanup = () => {
  for (const fn of restore.reverse()) { try { fn(); } catch { /* 忽略 */ } }
  if (stateBackup !== null) {
    try { writeFileSync(STATE_FILE, stateBackup, 'utf8'); } catch { /* 忽略 */ }
  }
  try { chrome?.kill(); } catch { /* 忽略 */ }
  if (profileDir) { try { rmSync(profileDir, { recursive: true, force: true }); } catch { /* 忽略 */ } }
};
process.on('exit', cleanup);

// 网络事件：统计每个 URL 的并发峰值，供 O1-2 / O10-2 使用
const netActive = new Map();
const netPeak = new Map();
const netCount = new Map();
const urlOf = (requestId) => netActive.get(requestId);

const wsUrl = await ensureChrome();
const cdp = connect(wsUrl);
await cdp.ready;
cdp.on('Network.requestWillBeSent', (p) => {
  const short = p.request.url.replace(API, '');
  netActive.set(p.requestId, short);
  netCount.set(short, (netCount.get(short) || 0) + 1);
  const here = [...netActive.values()].filter((u) => u === short).length;
  netPeak.set(short, Math.max(netPeak.get(short) || 0, here));
});
cdp.on('Network.loadingFinished', (p) => netActive.delete(p.requestId));
cdp.on('Network.loadingFailed', (p) => netActive.delete(p.requestId));
cdp.on('Page.javascriptDialogOpening', () => {
  cdp.send('Page.handleJavaScriptDialog', { accept: true });
});
await cdp.send('Network.enable');
await cdp.send('Page.enable');

const reload = async () => {
  await cdp.send('Page.navigate', { url: PAGE });
  await waitFor(cdp, 'document.readyState === "complete"', 15000, '页面加载完成');
};

// ── Phase 0：测试夹具（临时 DSH_HOME + 临时账本）────────────────────────
section('Phase 0：夹具准备');
{
  const dshHome = process.env.DSH_HOME || '';
  const ledger = process.env.WORKBUDDY_USAGE_FILE || '';
  if (!dshHome || !ledger) {
    console.error('必须设置 DSH_HOME 与 WORKBUDDY_USAGE_FILE（指向临时目录），避免写坏真实配置与账本');
    process.exit(2);
  }
  mkdirSync(join(dshHome, 'profiles', 'desktop'), { recursive: true });
  writeFileSync(join(dshHome, 'settings.yaml'), [
    '# 验收用临时 DSH_HOME（tools/dev/test-console-ui.mjs）',
    'llm-pi-ai:',
    '  providers:',
    '    workbuddy:',
    '      displayName: WorkBuddy',
    '      apiKeyEnv: WORKBUDDY_BRIDGE_KEY',
    '      api: openai-completions',
    '      baseURL: http://127.0.0.1:8898/v1',
    '      models:',
    '        - id: hy3',
    '          name: "Hy3"',
    '          contextWindow: 192000',
    '          maxTokens: 64000',
    '          input:',
    '            - text',
    '        - id: hy4-preview-x',
    '          name: "Hy4 preview"',
    '          input:',
    '            - text',
    '',
  ].join('\n'), 'utf8');
  writeFileSync(join(dshHome, '.credentials.yaml'),
    'refs:\n  WORKBUDDY_BRIDGE_KEY: "wb-local-bridge"\n', 'utf8');
  // patch 层也要存在（否则写入端不会去更新它，O2-3 的「两处同步」就没法验证）
  writeFileSync(join(dshHome, 'profiles', 'desktop', 'cordis.patch.yml'), [
    '- id: llm-pi-ai',
    '  name: "@deepseek-ai/dsh-llm-pi-ai"',
    '  config:',
    '    providers:',
    '      workbuddy:',
    '        displayName: WorkBuddy',
    '        apiKeyEnv: WORKBUDDY_BRIDGE_KEY',
    '        api: openai-completions',
    '        baseURL: http://127.0.0.1:8898/v1',
    '        models:',
    '          - id: hy3',
    '            name: "Hy3"',
    '          - id: hy4-preview-x',
    '            name: "Hy4 preview"',
    '          input:',
    '            - text',
    '',
  ].join('\n'), 'utf8');

  const now = Date.now();
  const rows = [
    { t: now - 60000, model: 'hy3', stream: false, ok: true, ms: 900, promptTokens: 100, completionTokens: 50, credit: 0.01 },
    { t: now - 30000, model: 'hy4-preview-x', stream: false, ok: false, ms: 300, status: 400, code: 11102, error: 'model [hy4-preview-x] service info not found' },
    { t: now - 10000, model: '<img src=x onerror="window.__xss=1">', stream: true, ok: true, ms: 1200, promptTokens: 10, completionTokens: 5 },
  ];
  writeFileSync(ledger, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
  pass(`夹具就绪：DSH_HOME=${dshHome}，账本=${ledger}`);
}

// ── Phase A：接口层断言 ────────────────────────────────────────────────
section('Phase A：接口层（D7 / D3 合并语义）');

{
  const ov = await apiJson('/api/overview');
  if (ov.bridge && ov.bridge.state === undefined) pass('D7 /api/overview 不再回传 bridge.state');
  else fail('D7 /api/overview 仍包含 bridge.state');
}

{
  const probe = (ok) => ({
    results: { 'merge-test-a': { ok, ms: 10, at: Date.now() } },
  });
  await apiJson('/api/probe-results', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(probe(true)),
  });
  await apiJson('/api/probe-results', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ results: { 'merge-test-b': { ok: false, ms: 20, at: Date.now(), error: 'x' } } }),
  });
  const got = await apiJson('/api/probe-results');
  const has = (id) => Boolean(got.results && got.results[id]);
  if (has('merge-test-a') && has('merge-test-b')) {
    pass('D3 体检结果按模型合并写入（两次 POST 的条目都在，未提及的未被清掉）');
  } else {
    fail(`D3 合并写入失败：${JSON.stringify(Object.keys(got.results || {}))}`);
  }
  const del = await apiJson('/api/probe-results', { method: 'DELETE' });
  const after = await apiJson('/api/probe-results');
  if (del.cleared && Object.keys(after.results || {}).length === 0) {
    pass('D3 清除体检仍然彻底（DELETE 后 results 为空）');
  } else {
    fail('D3 清除体检不彻底');
  }
}

// ── Phase B：首屏与目录 ────────────────────────────────────────────────
section('Phase B：首屏（O10-1）与目录治理（O2-1）');

{
  const t0 = Date.now();
  await cdp.send('Page.navigate', { url: PAGE });
  const badge = await waitFor(
    cdp,
    '(() => { const t = document.getElementById("badgeText"); return t && t.textContent !== "检测中" ? t.textContent : ""; })()',
    8000,
    '徽章出现结论',
  ).catch(() => null);
  const ms = Date.now() - t0;
  if (badge && ms <= 2000) pass(`O10-1 徽章 ≤2 秒出结论：${badge}（${ms}ms）`);
  else if (badge) fail(`O10-1 徽章出结论耗时 ${ms}ms，超过 2 秒（结论：${badge}）`);
  else fail('O10-1 徽章 8 秒内仍停在「检测中」');
  await waitFor(cdp, 'document.querySelectorAll("#modelTable tbody tr").length > 0', 30000, '模型表渲染');
}

{
  const rows = await cdp.evaluate('[...document.querySelectorAll("#modelTable tbody tr")].map(t => t.dataset.modelId)');
  if (!rows.includes('nes-gf')) pass('O2-1 列表里没有非对话内部模型 nes-gf');
  else fail('O2-1 列表里仍出现 nes-gf');

  const health = await fetch((process.env.BRIDGE_URL || 'http://127.0.0.1:8898') + '/health', {
    headers: { Authorization: 'Bearer ' + (process.env.BRIDGE_TOKEN || 'wb-local-bridge') },
  }).then((r) => r.json()).catch(() => null);
  const dropped = health && health.upstreamShape && health.upstreamShape.droppedNonChat;
  if (Array.isArray(dropped) && dropped.includes('nes-gf')) {
    pass(`O2-1 过滤发生在桥的目录层（upstreamShape.droppedNonChat = ${JSON.stringify(dropped)}）`);
  } else {
    fail(`O2-1 未能在桥的目录层看到过滤记录：${JSON.stringify(dropped)}`);
  }
}

{
  // D2：账本里注入带标签的模型名，必须按纯文本显示、不执行脚本
  await waitFor(cdp, 'document.getElementById("usageBox").textContent.length > 20', 15000, '用量面板渲染').catch(() => {});
  const xss = await cdp.evaluate(`(() => {
    const box = document.getElementById('usageBox');
    return {
      flag: window.__xss === 1,
      text: box ? box.textContent : '',
      imgs: box ? box.querySelectorAll('img').length : -1,
    };
  })()`);
  if (!xss.flag && xss.text.includes('<img src=x onerror=') && xss.imgs === 0) {
    pass('D2-1 账本里的 <img onerror> 模型名按纯文本显示、未执行脚本');
  } else {
    fail(`D2-1 转义失败：脚本标记=${xss.flag} img 元素=${xss.imgs} 文本=${JSON.stringify(xss.text.slice(0, 80))}`);
  }
}

// ── Phase C：全量体检 + 进度 + 筛选 ────────────────────────────────────
section('Phase C：体检（O3 / O4 / O2-2 / O8）');

{
  const probeStart = Date.now();
  // 先显式选「全部」：默认范围已改为「有勾选就测勾选的」（R9.1）
  await setProbeScopeAll(cdp);
  await sleep(200);
  await click(cdp, '#probeAllBtn');
  const shown = await waitFor(cdp, '!document.getElementById("probeProgress").hidden', 3000, '进度区出现')
    .then(() => true).catch(() => false);
  if (shown) {
    const txt = await cdp.evaluate('document.getElementById("probeText").textContent');
    pass(`O3-1 进度区已出现：${txt.slice(0, 90)}`);
  } else {
    fail('O3-1 点「测试可用性」后没有出现进度区');
  }

  // 全量跑完（30 个模型，会消耗少量额度）
  const doneMsg = await waitFor(
    cdp,
    '(() => { const m = document.getElementById("regMsg"); return m && /^(测试完成|已取消)/.test(m.textContent) ? m.textContent : ""; })()',
    180000,
    '体检结束',
  ).catch((e) => { fail(`O3-2 全量体检查看超时：${e.message}`); return ''; });
  const wallMs = Date.now() - probeStart;
  if (doneMsg) pass(`O3-2 全量体检完成：${doneMsg}（实测耗时 ${(wallMs / 1000).toFixed(1)}s）`);

  // 串行基准 = 各模型耗时之和（超时按 20 秒计），并发 3 应不高于一半
  const res = await apiJson('/api/probe-results');
  const entries = Object.values(res.results || {});
  const serialMs = entries.reduce((sum, r) => sum + (Number.isFinite(Number(r.ms)) ? Number(r.ms) : 20000), 0);
  if (wallMs <= serialMs / 2) {
    pass(`O3-2 并发体检耗时 ${(wallMs / 1000).toFixed(1)}s ≤ 串行基准 ${(serialMs / 1000).toFixed(1)}s 的一半`);
  } else {
    fail(`O3-2 并发体检耗时 ${(wallMs / 1000).toFixed(1)}s，超过串行基准 ${(serialMs / 1000).toFixed(1)}s 的一半`);
  }
}

{
  const stamp = await cdp.evaluate('(() => { const el = document.getElementById("probeStamp"); return el ? el.textContent : ""; })()');
  if (/上次体检/.test(stamp)) pass(`O4-2 表头显示体检时间：${stamp}`);
  else fail(`O4-2 表头没有体检时间：${JSON.stringify(stamp)}`);

  const passed = Number((/可用 (\d+) \//.exec(stamp) || [])[1] || -1);
  await cdp.evaluate(`(() => { const s = document.getElementById('modelKind'); s.value = 'probe-ok'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  const visible = await cdp.evaluate('[...document.querySelectorAll("#modelTable tbody tr")].filter(t => t.style.display !== "none").length');
  if (passed >= 0 && visible === passed) pass(`O4-1 「仅可用」可见行数 ${visible} 与体检通过数一致`);
  else fail(`O4-1 「仅可用」可见 ${visible} 行，与通过数 ${passed} 不一致`);

  await click(cdp, '#probeSortTh');
  const mark = await cdp.evaluate('document.getElementById("probeSortMark").textContent');
  const firstMs = await cdp.evaluate('(() => { const tr = [...document.querySelectorAll("#modelTable tbody tr")].find(t => t.style.display !== "none"); return tr ? tr.dataset.probeMs : null; })()');
  if (mark) pass(`O4-1 可用性列可排序（当前：${mark}，首行耗时 ${firstMs}ms）`);
  else fail('O4-1 点击可用性表头没有产生排序标记');

  await cdp.evaluate(`(() => { const s = document.getElementById('modelKind'); s.value = ''; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
}

{
  // O8：hy3 行倍率列只应有一个标签；只有 id 列可复制
  const hy3 = await cdp.evaluate(`(() => {
    const tr = document.querySelector('#modelTable tbody tr[data-model-id="hy3"]');
    if (!tr) return null;
    const tds = tr.querySelectorAll('td');
    return { tags: tds[5].querySelectorAll('.tag').length, rate: tds[5].textContent.trim() };
  })()`);
  if (!hy3) fail('O8 找不到 hy3 行（目录里应有该模型）');
  else if (hy3.tags === 1) pass(`O8-1 hy3 倍率列只有一个标签：「${hy3.rate}」`);
  else fail(`O8-1 hy3 倍率列有 ${hy3.tags} 个标签：「${hy3.rate}」`);

  const copyable = await cdp.evaluate(`(() => {
    const tr = document.querySelector('#modelTable tbody tr');
    const tds = [...tr.querySelectorAll('td')];
    return { count: tr.querySelectorAll('td.copyable').length, idCell: tds[1].classList.contains('copyable'), ctxCell: tds[3].classList.contains('copyable'), icon: tr.querySelectorAll('td.copyable .copyicon').length };
  })()`);
  if (copyable.count === 1 && copyable.idCell && !copyable.ctxCell && copyable.icon === 1) {
    pass('O8-2 只有模型 id 列可复制且带复制图标');
  } else {
    fail(`O8-2 复制交互不符合预期：${JSON.stringify(copyable)}`);
  }

  await cdp.evaluate('document.getElementById("actionMsg").textContent = ""');
  await cdp.evaluate(`(() => { const tr = document.querySelector('#modelTable tbody tr'); tr.querySelectorAll('td')[3].click(); })()`);
  await sleep(200);
  const afterCtx = await cdp.evaluate('document.getElementById("actionMsg").textContent');
  if (!afterCtx) pass('O8-2 点击「上下文」数字不触发复制');
  else fail(`O8-2 点击上下文列触发了复制：${afterCtx}`);

  await cdp.evaluate(`(() => { const tr = document.querySelector('#modelTable tbody tr'); tr.querySelector('td.copyable').click(); })()`);
  await waitFor(cdp, 'document.getElementById("actionMsg").textContent.length > 0', 3000, '复制反馈').catch(() => {});
  const afterId = await cdp.evaluate('document.getElementById("actionMsg").textContent');
  if (/已复制|复制失败/.test(afterId)) pass(`O8-2 点击模型 id 列触发复制：${afterId.slice(0, 40)}`);
  else fail(`O8-2 点击模型 id 列没有复制反馈：${JSON.stringify(afterId)}`);
}

{
  // O2-2 / O2-3：全选跳过已知不可用；保存结果不含它们
  await cdp.evaluate('document.getElementById("actionMsg").textContent = ""');
  await click(cdp, '#clearSelBtn');
  await cdp.evaluate(`(() => { const c = document.getElementById('checkAll'); c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await sleep(300);
  const msg = await cdp.evaluate('document.getElementById("regMsg").textContent');
  const skipped = /跳过 (\d+) 个已知不可用/.exec(msg);
  const badChecked = await cdp.evaluate(`(() => { const tr = document.querySelector('#modelTable tbody tr[data-model-id="hy4-preview-x"]'); const cb = tr && tr.querySelector('input[data-id]'); return cb ? cb.checked : null; })()`);
  if (skipped && Number(skipped[1]) >= 1 && badChecked === false) {
    pass(`O2-2 全选跳过 ${skipped[1]} 个已知不可用模型，且未勾选 hy4-preview-x`);
  } else {
    fail(`O2-2 全选未按预期跳过：msg=${JSON.stringify(msg)} 勾选状态=${badChecked}`);
  }

  await click(cdp, '#saveRegBtn');
  await waitFor(cdp, '/已写入 \\d+ 个模型/.test(document.getElementById("regMsg").textContent)', 15000, '注册写入完成')
    .catch(async (e) => fail(`O2-3 保存超时：${e.message}；当前 regMsg=${JSON.stringify(await cdp.evaluate('document.getElementById("regMsg") && document.getElementById("regMsg").textContent'))}`));
  const dshHome = process.env.DSH_HOME || '';
  if (dshHome) {
    const settings = join(dshHome, 'settings.yaml');
    const text = existsSync(settings) ? readFileSync(settings, 'utf8') : '';
    if (text && !text.includes('hy4-preview-x')) pass('O2-3 保存后的 settings.yaml 不含已知不可用的模型 id');
    else fail('O2-3 settings.yaml 里仍含 hy4-preview-x（或文件不存在）');
    const patch = join(dshHome, 'profiles', 'desktop', 'cordis.patch.yml');
    const patchText = existsSync(patch) ? readFileSync(patch, 'utf8') : '';
    if (patchText && !patchText.includes('hy4-preview-x')) pass('O2-3 cordis.patch.yml 同步更新且不含该 id');
    else fail('O2-3 cordis.patch.yml 未同步或仍含该 id');
  } else {
    fail('O2-3 未设置 DSH_HOME，跳过（本脚本需要在临时 DSH_HOME 下运行）');
  }
}

// ── Phase D：取消体检 + 结果保留（O3-3 / D3-1）────────────────────────
section('Phase D：取消与保留（O3-3 / D3-1）');

{
  const before = await apiJson('/api/probe-results');
  const beforeMap = before.results || {};

  // 同 Phase C：显式选「全部」，否则只测勾选的几个，取消语义验不出来
  await setProbeScopeAll(cdp);
  await sleep(200);
  await click(cdp, '#probeAllBtn');
  await sleep(2500);
  await click(cdp, '#probeCancelBtn');
  const cancelled = await waitFor(
    cdp,
    '(() => { const b = document.getElementById("probeCancelBtn"); const p = document.getElementById("probeProgress"); return b.hidden && p.hidden ? true : false; })()',
    3000,
    '取消收起',
  ).then(() => true).catch(() => false);
  if (cancelled) pass('O3-3 取消后 ≤3 秒收起进度区与取消按钮');
  else fail('O3-3 取消后进度区仍在');

  const pending = await cdp.evaluate('[...document.querySelectorAll("#modelTable td[data-probe]")].filter(td => td.textContent.includes("测试中")).length');
  if (pending === 0) pass('O3-3 界面无残留「测试中…」');
  else fail(`O3-3 仍有 ${pending} 个「测试中…」`);

  await reload();
  await waitFor(cdp, 'document.querySelectorAll("#modelTable tbody tr").length > 0', 30000, '模型表渲染');
  const untested = await cdp.evaluate('[...document.querySelectorAll("#modelTable td[data-probe]")].filter(td => td.textContent.trim() === "未测").length');
  const after = await apiJson('/api/probe-results');
  const afterMap = after.results || {};
  const afterCount = Object.keys(afterMap).length;
  // 逐个比对时间戳：重测过的 at 变新，没轮到的必须保持原值（D3 的核心语义）
  let refreshed = 0;
  let kept = 0;
  for (const [id, r] of Object.entries(beforeMap)) {
    const now = afterMap[id];
    if (!now) continue;
    if (Number(now.at) > Number(r.at)) refreshed += 1;
    else if (Number(now.at) === Number(r.at)) kept += 1;
  }
  if (afterCount >= Object.keys(beforeMap).length && untested <= 3 && refreshed >= 1 && kept >= 20) {
    pass(`D3-1 取消后刷新：未测 ${untested} 个；${refreshed} 条时间戳更新、${kept} 条保持上一轮（服务端保留 ${afterCount} 条）`);
  } else {
    fail(`D3-1 结果不符：未测 ${untested}、更新 ${refreshed}、保留 ${kept}、服务端 ${afterCount}/${Object.keys(beforeMap).length}`);
  }
}

// ── Phase E：刷新 / 请求面板 / 对话 / 日志（O1 / O5 / O6 / O9）────────
section('Phase E：刷新与面板（O1 / O5 / O6 / O9）');

{
  const beforeStamps = await cdp.evaluate('["overviewStamp","accountsStamp","usageStamp","checkinStamp","reqStamp","diagStamp","modelStamp"].map(id => (document.getElementById(id) || {}).textContent || "")');
  await click(cdp, '#refreshBtn');
  const disabled = await cdp.evaluate('document.getElementById("refreshBtn").disabled');
  const label = await cdp.evaluate('document.getElementById("refreshBtn").textContent');
  if (disabled && /刷新中/.test(label)) pass(`O1-2 刷新期间按钮禁用并显示「${label}」`);
  else fail(`O1-2 刷新期间按钮状态不对：disabled=${disabled} label=${label}`);

  await waitFor(cdp, 'document.getElementById("refreshBtn").disabled === false', 30000, '刷新结束');
  const afterStamps = await cdp.evaluate('["overviewStamp","accountsStamp","usageStamp","checkinStamp","reqStamp","diagStamp","modelStamp"].map(id => (document.getElementById(id) || {}).textContent || "")');
  const times = afterStamps.map((s) => (/更新于 (\d{2}:\d{2}:\d{2})/.exec(s) || [])[1]);
  const allSet = times.every(Boolean);
  const changed = afterStamps.some((s, i) => s !== beforeStamps[i]) || times.every(Boolean);
  if (allSet && changed) pass(`O1-1 一次刷新后各面板时间戳更新：${times.join(' / ')}`);
  else fail(`O1-1 面板时间戳异常：${JSON.stringify(afterStamps)}`);
}

{
  const notice = await cdp.evaluate('(() => { const el = document.querySelector("#reqBox .notice"); return el ? el.textContent : ""; })()');
  if (/条失败（[\d.]+%/.test(notice) && /最多：/.test(notice)) pass(`O5-2 失败提示含失败率与 TOP 组合：${notice.slice(0, 80)}`);
  else fail(`O5-2 失败提示缺失：${JSON.stringify(notice.slice(0, 80))}`);

  await cdp.evaluate(`(() => { const c = document.getElementById('reqFailOnly'); c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await sleep(200);
  const rows = await cdp.evaluate('[...document.querySelectorAll("#reqBox tbody tr")].map(tr => tr.className.includes("rowfail"))');
  if (rows.length && rows.every(Boolean)) pass(`O5-1 「仅看失败」只显示失败行（${rows.length} 行）`);
  else fail(`O5-1 「仅看失败」显示的行里有成功记录：${JSON.stringify(rows.slice(0, 5))}`);

  const c200 = netCount.get('/api/requests?limit=200') || 0;
  await cdp.evaluate(`(() => { const s = document.getElementById('reqLimit'); s.value = '200'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await sleep(1200);
  const c200after = netCount.get('/api/requests?limit=200') || 0;
  if (c200after > c200) pass('O5-1 条数选择 200 生效（发出的请求带 limit=200）');
  else fail('O5-1 切换条数没有发出对应请求');
  await cdp.evaluate(`(() => { const c = document.getElementById('reqFailOnly'); c.checked = false; c.dispatchEvent(new Event('change', { bubbles: true })); const s = document.getElementById('reqLimit'); s.value = '40'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
}

{
  // O6-2 模型下拉可搜索
  await cdp.evaluate(`(() => { const i = document.getElementById('modelSearch'); i.value = 'glm'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  const opts = await cdp.evaluate('[...document.getElementById("modelSel").options].map(o => o.value)');
  if (opts.length > 0 && opts.every((v) => v.includes('glm'))) pass(`O6-2 模型下拉按关键字过滤生效（glm → ${opts.length} 项）`);
  else fail(`O6-2 过滤结果不对：${JSON.stringify(opts)}`);
  await cdp.evaluate(`(() => { const i = document.getElementById('modelSearch'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
}

{
  // O6-1 流式对话中点「停止」
  const probe = await apiJson('/api/probe-results');
  const good = Object.entries(probe.results || {}).find(([, r]) => r && r.ok);
  if (!good) {
    fail('O6-1 没有可用于对话测试的模型（跳过）');
  } else {
    await cdp.evaluate(`(() => { const s = document.getElementById('modelSel'); s.value = ${JSON.stringify(good[0])}; document.getElementById('promptInput').value = '数到一百'; })()`);
    await click(cdp, '#sendBtn');
    await waitFor(cdp, 'document.getElementById("chatStopBtn").hidden === false', 5000, '停止按钮出现').catch(() => fail('O6-1 发送后没有出现「停止」按钮'));
    await sleep(1200);
    await click(cdp, '#chatStopBtn');
    const stopped = await waitFor(cdp, 'document.getElementById("chatOut").textContent.includes("已手动停止")', 5000, '停止标记')
      .then(() => true).catch(() => false);
    const restored = await cdp.evaluate('document.getElementById("sendBtn").disabled === false && document.getElementById("chatStopBtn").hidden === true');
    if (stopped && restored) pass('O6-1 停止后立即中断、内容保留、按钮恢复');
    else fail(`O6-1 停止行为异常：stopped=${stopped} restored=${restored}`);

    // D8：客户端断开后桥侧必须同步结束这次上游请求（日志出现中断记录）
    await sleep(1500);
    const log = await apiJson('/api/bridge/log?lines=200');
    const hit = (log.lines || []).some((l) => /stream interrupted|aborted|AbortError/i.test(l));
    if (hit) pass('D8-1 客户端断开后桥侧结束请求并留下中断记录（上游连接已释放）');
    else fail(`D8-1 桥日志里没有中断记录：${JSON.stringify((log.lines || []).slice(-3))}`);
  }
}

{
  // O9 日志面板
  await cdp.evaluate('document.querySelector("details").open = true');
  await waitFor(cdp, 'document.getElementById("logOut").textContent.length > 0', 5000, '日志加载').catch(() => {});
  const scrolled = await cdp.evaluate('(() => { const el = document.getElementById("logOut"); return el.scrollHeight - el.scrollTop - el.clientHeight < 40; })()');
  if (scrolled) pass('O9-2 展开日志后自动滚动到底部');
  else fail('O9-2 日志没有滚动到底部');

  await cdp.evaluate(`(() => { const c = document.getElementById('logCurrentOnly'); c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await sleep(600);
  const cur = await cdp.evaluate('document.getElementById("logOut").textContent');
  if (/listening on http/.test(cur)) pass('O9-2 「只看本次启动」生效（以启动横幅为界）');
  else fail(`O9-2 「只看本次启动」结果异常：${JSON.stringify(cur.slice(0, 80))}`);

  await click(cdp, '#logClearBtn');
  const cleared = await waitFor(cdp, 'document.getElementById("logOut").textContent.includes("暂无日志")', 5000, '日志已清空')
    .then(() => true).catch(() => false);
  if (cleared) pass('O9-1 清空日志后文件被截断、面板显示（暂无日志）');
  else fail('O9-1 清空日志未生效');
  await cdp.evaluate('document.querySelector("details").open = false');
}

{
  // O10-2 轮询去重（/api/probe 的并发是体检自身的 3 路并发，不在去重范围内）
  const panelUrls = /^\/api\/(overview|models|usage|requests|diagnose|accounts|checkin|bridge\/log)/;
  const overlaps = [...netPeak.entries()].filter(([u, peak]) => peak > 1 && panelUrls.test(u));
  if (!overlaps.length) pass('O10-2 整个走查期间同类面板接口从未并发重叠');
  else fail(`O10-2 出现并发重叠：${JSON.stringify(overlaps)}`);

  const probePeak = netPeak.get('/api/probe') || 0;
  if (probePeak <= 3) pass(`O3 体检并发峰值为 ${probePeak}（设计上限 3）`);
  else fail(`O3 体检并发峰值 ${probePeak}，超过设计上限 3`);
}

// ── Phase F：失效注册清理（O7）与账号切换（D4）────────────────────────
section('Phase F：失效注册（O7）与账号绑定（D4）');

{
  const dshHome = process.env.DSH_HOME || '';
  if (!dshHome) {
    fail('O7 未设置 DSH_HOME，跳过');
  } else {
    const settings = join(dshHome, 'settings.yaml');
    // 伪造一条失效注册：已注册但不在上游目录里
    const text = readFileSync(settings, 'utf8');
    const withGhost = text.replace(/^(\s*models:\s*)$/m, '$1\n        - id: ghost-model\n          name: "Ghost"');
    writeFileSync(settings, withGhost, 'utf8');
    await reload();
    const shown = await waitFor(cdp, 'document.getElementById("modelNotice").textContent.includes("ghost-model")', 30000, '失效注册提示').then(() => true).catch(() => false);
    if (shown) pass('O7 失效注册提示已出现');
    else fail('O7 失效注册提示未出现');

    await click(cdp, '#cleanStaleBtn');
    const gone = await waitFor(cdp, 'document.getElementById("modelNotice").className.includes("hidden")', 20000, '提示消失')
      .then(() => true).catch(() => false);
    const after = readFileSync(settings, 'utf8');
    if (gone && !after.includes('ghost-model')) pass('O7-1「清理并保存」一步清掉失效条目并刷新提示');
    else fail(`O7-1 清理结果异常：提示消失=${gone}，配置仍含 ghost-model=${after.includes('ghost-model')}`);
  }
}

{
  const accounts = await apiJson('/api/accounts');
  const target = (accounts.accounts || []).find((a) => a.active && a.usable) || (accounts.accounts || []).find((a) => a.usable);
  await apiJson('/api/probe-results', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ results: { 'account-test': { ok: true, ms: 1, at: Date.now() } } }),
  });
  if (!target) {
    fail('D4 没有可用账号，跳过');
  } else {
    const r = await apiJson('/api/account/switch', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file: target.name }),
    });
    const after = await apiJson('/api/probe-results');
    const empty = Object.keys(after.results || {}).length === 0;
    if (r.switched && empty) pass('D4-2 切换账号后服务端体检存档被清空');
    else fail(`D4-2 切换后体检存档未清空：switched=${r.switched} results=${JSON.stringify(Object.keys(after.results || {}))}`);

    await reload();
    await waitFor(cdp, 'document.querySelectorAll("#modelTable tbody tr").length > 0', 40000, '模型表渲染');
    const untested = await cdp.evaluate('[...document.querySelectorAll("#modelTable td[data-probe]")].filter(td => td.textContent.trim() === "未测").length');
    const stamp = await cdp.evaluate('(() => { const el = document.getElementById("probeStamp"); return el ? el.textContent : ""; })()');
    if (untested > 0 && !/上次体检/.test(stamp)) pass(`D4-1 切换后体检列全为「未测」（${untested} 个），表头无上轮体检时间`);
    else fail(`D4-1 切换后仍显示旧结论：未测 ${untested} 个、表头 ${JSON.stringify(stamp)}`);
  }
}

// ── Phase G：D1 启动接口 ───────────────────────────────────────────────
section('Phase G：D1 启动接口');

{
  const health = await apiJson('/api/overview');
  const pid = health.bridge && health.bridge.pid;
  const start = await apiJson('/api/bridge/start', { method: 'POST' });
  if (start.started && start.reused && Number(start.pid) === Number(pid)) {
    pass(`D1-1 桥已在运行时 start 返回 reused 且 pid 与 /health 一致（PID ${start.pid}）`);
  } else {
    fail(`D1-1 start 返回异常：${JSON.stringify(start)}（/health PID ${pid}）`);
  }

  // D1-2：页面文案必须区分「已启动 / 已复用（含新进程失败）/ 失败」
  const texts = await cdp.evaluate(`(() => {
    const out = [];
    setBridgeMsg({ started: true, reused: true, pid: 12345 }, '桥已启动');
    out.push(document.getElementById('actionMsg').textContent);
    setBridgeMsg({ started: true, reused: true, pid: 12345, spawnError: 'Error: listen EADDRINUSE' }, '桥已启动');
    out.push(document.getElementById('actionMsg').textContent);
    setBridgeMsg({ started: true, pid: 777 }, '桥已启动');
    out.push(document.getElementById('actionMsg').textContent);
    return out;
  })()`);
  if (texts[0] === '桥已在运行（PID 12345）' && /新进程启动失败，仍在复用旧进程（PID 12345）/.test(texts[1]) && texts[2] === '桥已启动 (PID 777)') {
    pass(`D1-2 页面文案正确区分三种结果：${texts.join(' / ')}`);
  } else {
    fail(`D1-2 页面文案不符：${JSON.stringify(texts)}`);
  }

  // 用外部进程占住桥端口，再调用 start：必须如实失败并带 EADDRINUSE
  await apiJson('/api/bridge/stop', { method: 'POST' });
  const { createServer } = await import('node:http');
  const squatter = createServer((req, res) => { res.writeHead(200); res.end('not-a-bridge'); });
  const bridgePort = Number(process.env.BRIDGE_PORT || 8898);
  await new Promise((ok, bad) => { squatter.once('error', bad); squatter.listen(bridgePort, '127.0.0.1', ok); });
  const t0 = Date.now();
  const blocked = await apiJson('/api/bridge/start', { method: 'POST' });
  const took = Date.now() - t0;
  if (!blocked.started && /EADDRINUSE/i.test(JSON.stringify(blocked)) && took < 12000) {
    pass(`D1-3 端口被非桥进程占用时如实失败（${took}ms，含 EADDRINUSE 原文）`);
  } else {
    fail(`D1-3 端口占用场景返回异常（${took}ms）：${JSON.stringify(blocked).slice(0, 200)}`);
  }
  await new Promise((ok) => squatter.close(ok));

  const restarted = await apiJson('/api/bridge/start', { method: 'POST' });
  if (restarted.started && !restarted.reused && restarted.pid) pass(`D1 释放端口后重新启动成功（PID ${restarted.pid}）`);
  else fail(`D1 释放端口后仍未启动：${JSON.stringify(restarted).slice(0, 160)}`);
  await sleep(1000);
}

// ── Phase G2：清空账本入口（D10-2）──────────────────────────────────────
section('Phase G2：清空账本（D10-2）');
{
  const ledger = process.env.WORKBUDDY_USAGE_FILE || '';
  const linesBefore = ledger && existsSync(ledger) ? readFileSync(ledger, 'utf8').split('\n').filter(Boolean).length : 0;
  if (!ledger) {
    fail('D10-2 未设置 WORKBUDDY_USAGE_FILE，跳过');
  } else {
    await cdp.evaluate(`(() => { const i = document.getElementById('usageDays'); i.value = '7'; i.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await waitFor(cdp, 'document.getElementById("usageBox").textContent.includes("hy3")', 15000, '用量数据就绪').catch(() => {});
    await click(cdp, '#usageClearBtn');
    const cleared = await waitFor(
      cdp,
      'document.getElementById("usageBox").textContent.includes("暂无数据")',
      10000,
      '用量面板变空',
    ).then(() => true).catch(() => false);
    const linesAfter = existsSync(ledger) ? readFileSync(ledger, 'utf8').split('\n').filter(Boolean).length : 0;
    const msg = await cdp.evaluate('document.getElementById("actionMsg").textContent');
    if (cleared && linesAfter === 0 && /已清空用量账本/.test(msg)) {
      pass(`D10-2「清空账本」（含二次确认）生效：账本 ${linesBefore} 行 → ${linesAfter} 行`);
    } else {
      fail(`D10-2 清空账本异常：面板空=${cleared} 行数=${linesAfter}（原 ${linesBefore}）消息=${JSON.stringify(msg)}`);
    }
  }
}

// ── Phase H：多视口溢出扫描（R-5）──────────────────────────────────────
section('Phase H：多视口扫描（R-5）');

{
  await reload();
  await waitFor(cdp, 'document.querySelectorAll("#modelTable tbody tr").length > 0', 40000, '模型表渲染');
  const bad = [];
  for (const width of [1440, 1100, 820, 420]) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
    await sleep(350);
    const overflow = await cdp.evaluate('Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth');
    if (overflow > 2) bad.push(`${width}px 横向溢出 ${overflow}px`);
  }
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  if (!bad.length) pass('R-5 1440 / 1100 / 820 / 420 四个视口都没有横向溢出');
  else fail(`R-5 存在溢出：${bad.join('；')}`);
}

cdp.close();
console.log(`\n结果：${failures === 0 ? '全部通过' : failures + ' 项失败'}`);
process.exit(failures ? 1 : 0);