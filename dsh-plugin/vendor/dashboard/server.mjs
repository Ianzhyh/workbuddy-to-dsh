/**
 * WorkBuddy 中转控制台 —— 本地管理服务。
 *
 * 零依赖，仅绑 127.0.0.1。本身不碰凭据，只调用 lib/ 下的共享逻辑，
 * 因此页面看到的结论与 `tools/doctor.mjs` 完全一致。
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { closeSync, existsSync, openSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import config, { bridgeEnv } from '../config.mjs';
import {
  bridgeHealth,
  bridgeModels,
  bridgeQuota,
  bridgeRequests,
  bridgeUsage,
  credentialStatus,
  diagnose,
  invalidateQuotaCache,
  listAccounts,
  probeModel,
  readBridgeLog,
} from '../lib/diagnostics.mjs';
import { readDshStatus, writeRegistration } from '../lib/dsh.mjs';
import { effectiveAuthFile, readState, writeState } from '../lib/state.mjs';

// ── 基础工具 ────────────────────────────────────────────────────────────

function sendJson(res, code, body) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

// 控制台自身的版本信息（诊断报告要用）。读一次 package.json 就缓存，不每次请求都碰磁盘；
// 文件缺失或损坏时降级为 '?'，绝不让 /api/overview 因为读不到版本而 500。
let consoleVersionCache = null;
function consoleVersion() {
  if (consoleVersionCache !== null) return consoleVersionCache;
  try {
    const pkg = JSON.parse(readFileSync(join(config.paths.root, 'package.json'), 'utf8'));
    consoleVersionCache = typeof pkg.version === 'string' && pkg.version ? pkg.version : '?';
  } catch {
    consoleVersionCache = '?';
  }
  return consoleVersionCache;
}

function readBody(req, limit = 1024 * 512) {
  return new Promise((ok, fail) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        fail(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => ok(Buffer.concat(chunks).toString('utf8')));
    req.on('error', fail);
  });
}

/** Windows 系统工具的绝对路径，避免依赖 PATH 解析。 */
function systemExe(name) {
  if (process.platform !== 'win32') return name;
  return join(process.env.SystemRoot || 'C:\\Windows', 'System32', `${name}.exe`);
}

/** spawnSync 的公共选项：**必须**忽略 stdin，否则在 Windows 上会抛 EBUSY。 */
const SYNC_OPTS = {
  stdio: ['ignore', 'pipe', 'pipe'],
  encoding: 'utf8',
  windowsHide: true,
  timeout: 15000,
  maxBuffer: 4 * 1024 * 1024,
};

/**
 * 按端口找监听进程，跨平台。
 *
 * 不要用 execSync：它经 cmd.exe 执行且默认给 stdin 开管道，在 Windows 上必定
 * 抛 EBUSY。spawnSync + stdio:['ignore',...] 直连 exe 才是可靠路径。
 *
 * Windows 用 `netstat -ano`，macOS / Linux 用 `lsof`（缺 lsof 时退回 `ss`）。
 * 只认 LISTENING/LISTEN 的行，避免把「连到该端口的客户端」当成监听者。
 */
function findPortPid(port) {
  if (process.platform === 'win32') {
    const r = spawnSync(systemExe('netstat'), ['-ano'], SYNC_OPTS);
    if (r.error || !r.stdout) return null;
    for (const line of r.stdout.split('\n')) {
      if (line.includes(`:${port}`) && /LISTENING/i.test(line)) {
        const pid = Number(line.trim().split(/\s+/).pop());
        if (Number.isInteger(pid) && pid > 0) return pid;
      }
    }
    return null;
  }

  const lsof = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], SYNC_OPTS);
  if (!lsof.error && lsof.stdout) {
    const pid = Number(lsof.stdout.split('\n').map((s) => s.trim()).filter(Boolean)[0]);
    if (Number.isInteger(pid) && pid > 0) return pid;
  }

  const ss = spawnSync('ss', ['-lptnH', `sport = :${port}`], SYNC_OPTS);
  if (!ss.error && ss.stdout) {
    const hit = /pid=(\d+)/.exec(ss.stdout);
    if (hit) return Number(hit[1]);
  }
  return null;
}

// ── 桥进程管理 ──────────────────────────────────────────────────────────

/** 日志超过 2MB 就滚动一次，避免长期运行后无限增长。 */
const LOG_MAX_BYTES = 2 * 1024 * 1024;

function rotateLogIfNeeded(file) {
  try {
    if (existsSync(file) && statSync(file).size > LOG_MAX_BYTES) {
      renameSync(file, `${file}.1`);
    }
  } catch {
    /* 滚动失败（文件被占用等）不影响启动 */
  }
}

/**
 * 读取日志文件从 offset（字节）之后新增的内容。
 *
 * 子进程的 stdout/stderr 直接写进 bridge.log（日志面板读的就是它），因此进程
 * 启动失败（如 EADDRINUSE）时，原因就在这个偏移量之后的新增段落里——不需要
 * 额外挂一根管道，也避免了父进程退出后管道断裂反过来影响桥。
 */
function readLogSince(offset) {
  try {
    const buf = readFileSync(config.paths.bridgeLog);
    return buf.slice(Math.min(offset, buf.length)).toString('utf8').trim().slice(-400);
  } catch {
    return '';
  }
}

function startBridge(opts = {}) {
  const authFile = opts.authFile || effectiveAuthFile();
  const script = config.paths.bridgeScript;
  if (!existsSync(script)) return { started: false, error: `找不到桥脚本：${script}` };
  if (!existsSync(authFile)) return { started: false, error: `登录文件不存在：${authFile}` };

  rotateLogIfNeeded(config.paths.bridgeLog);
  const logPath = config.paths.bridgeLog;
  const logOffset = existsSync(logPath) ? statSync(logPath).size : 0;
  const logFd = openSync(logPath, 'a');
  const child = spawn(process.execPath, [script], {
    cwd: config.paths.root,
    // 自动签到的开关随启动注入一次 —— 桥侧读 env，改了要重启桥才生效
    env: bridgeEnv({ authFile, autoCheckin: readCheckinState().auto }),
    detached: true,
    stdio: ['ignore', logFd, logFd],
    windowsHide: true,
  });
  child.unref();
  // 子进程已继承自己的副本，父进程再留着就是纯泄漏（每次启停掉一个 fd）
  closeSync(logFd);

  // 记录退出事件与 stderr 摘要：调用方据此判断「新进程是不是真的起来了」
  const info = { started: true, pid: child.pid, logPath, authFile, exited: false, spawnError: null };
  child.on('error', (err) => {
    info.exited = true;
    info.spawnError = `进程启动失败：${err.message}`;
  });
  child.on('exit', (code, signal) => {
    info.exited = true;
    const tail = readLogSince(logOffset);
    info.spawnError = tail || `进程已退出（code ${code}${signal ? ` · ${signal}` : ''}）`;
  });
  return info;
}

function stopBridge() {
  const pid = findPortPid(config.bridge.port);
  if (!pid) return { stopped: false, error: `端口 ${config.bridge.port} 上没有监听进程` };

  if (process.platform === 'win32') {
    const r = spawnSync(systemExe('taskkill'), ['/F', '/PID', String(pid)], SYNC_OPTS);
    if (r.status !== 0) {
      return { stopped: false, error: (r.stderr || r.stdout || 'taskkill 失败').trim() };
    }
    return { stopped: true, pid };
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch (err) {
    return { stopped: false, error: err.message };
  }
  return { stopped: true, pid };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 模型体检结果（跨刷新保留） ──────────────────────────────────────────
//
// 「测试可用性」要串行打几十个请求，刷新一次就全丢太浪费。结果存进 .state.json
// 的 probe 字段，页面重开还在，并显示体检时间。
//
// 这里的清洗是必要的：状态文件是**程序可写**的，POST 进来的内容不能原样落盘。

const PROBE_MAX_ENTRIES = 300;
const PROBE_MAX_ERROR = 200;
const PROBE_SCOPES = new Set(['checked', 'registered', 'all']);

/** 归一化单条体检结果；非法则返回 null。 */
function cleanProbeEntry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (typeof raw.ok !== 'boolean') return null;
  const entry = {
    ok: raw.ok,
    ms: Number.isFinite(Number(raw.ms)) ? Math.max(0, Math.round(Number(raw.ms))) : 0,
    at: Number.isFinite(Number(raw.at)) ? Number(raw.at) : Date.now(),
  };
  if (Number.isFinite(Number(raw.credit))) entry.credit = Number(raw.credit);
  if (typeof raw.error === 'string' && raw.error) entry.error = raw.error.slice(0, PROBE_MAX_ERROR);
  return entry;
}

/**
 * 归一化「本轮体检范围」。非法一律返回 null（不落盘）——
 * 这个值会直接显示成「本轮 K 个」，宁可不说，也不能说错。
 *
 * `count` 必须是非负整数且不超过**本次提交的结果条数**：它描述的是
 * 「这一轮实际发起了几次探测」，不可能多于本轮提交上来的结果条数。
 */
function cleanLastRun(raw, incomingCount) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!PROBE_SCOPES.has(raw.scope)) return null;
  const count = Number(raw.count);
  if (!Number.isInteger(count) || count < 0 || count > incomingCount) return null;
  return { scope: raw.scope, count };
}

function readProbeResults() {
  const s = readState();
  const stored = s.probe;
  if (!stored || typeof stored !== 'object') return { updatedAt: null, results: {}, lastRun: null };
  const results = {};
  for (const [id, raw] of Object.entries(stored.results || {})) {
    const entry = cleanProbeEntry(raw);
    if (entry) results[id] = entry;
  }
  const lr = stored.lastRun;
  const lastRun = lr && typeof lr === 'object' && PROBE_SCOPES.has(lr.scope) && Number.isInteger(lr.count)
    ? { scope: lr.scope, count: lr.count }
    : null;
  return { updatedAt: Number(stored.updatedAt) || null, results, lastRun };
}

/**
 * 写入体检结果 —— **合并**语义，不是整体替换。
 *
 * 体检结论按模型各自成立：本轮没测到的模型必须保留历史条目（连同它自己的
 * `at`），否则「测两个就取消」会把其余模型的历史结论整片抹成「未测」。
 * 想彻底清除请走 {@link clearProbeResults}（DELETE /api/probe-results）。
 */
function writeProbeResults(payload) {
  const incoming = payload && typeof payload === 'object' ? payload.results : null;
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
    throw new Error('缺少 results 对象');
  }

  // 本轮范围随本批结果一起提交；非法就整条丢弃（不落盘），页面回退成不显示 K 段。
  // 注意是「整条」：不写入任何一半合法的 lastRun，避免页面上出现半个数字。
  const lastRun = cleanLastRun(payload.lastRun, Object.keys(incoming).length);

  const merged = { ...readProbeResults().results };
  let written = 0;
  for (const [id, raw] of Object.entries(incoming)) {
    const entry = cleanProbeEntry(raw);
    if (!entry) continue;
    merged[String(id).slice(0, 120)] = entry;
    written += 1;
  }

  // 超出上限时丢最旧的（按各自体检时间）
  const entries = Object.entries(merged);
  if (entries.length > PROBE_MAX_ENTRIES) {
    entries.sort((a, b) => (Number(b[1].at) || 0) - (Number(a[1].at) || 0));
    for (const [id] of entries.slice(PROBE_MAX_ENTRIES)) delete merged[id];
  }

  const updatedAt = Date.now();
  // writeState 是**合并写**，probe 整个对象被替换：本轮没带 lastRun 时，
  // 上一轮的 K 会自然消失——宁可不说，也不显示过期的「本轮 K 个」。
  const probe = { updatedAt, results: merged };
  if (lastRun) probe.lastRun = lastRun;
  writeState({ probe });
  return { saved: true, count: written, total: Object.keys(merged).length, updatedAt, lastRun };
}

function clearProbeResults() {
  // writeState 是**合并写**：传一个删掉 probe 的副本没用（load() 里的 probe 会
  // 被合回来）。传 null 才会被它剔除。
  writeState({ probe: null });
  return { cleared: true };
}

// ── 每日自动签到（R11.1 / R11.3）───────────────────────────────────────
//
// 控制台侧覆盖「开着控制台但没人调模型」的情况：启动时 + 每小时检查一次。
// 桥侧另有触发（有人调模型时补签），两条路径共用同一接口与幂等语义。
//
// 开关是**程序可写的运行时偏好**，与 authFile 同类，存在 .state.json。

/** 控制台进程级的关闭开关（测试用；日常由 .state.json 的 checkin.auto 控制）。 */
const AUTO_CHECKIN_ENABLED = process.env.WORKBUDDY_AUTO_CHECKIN !== '0';
const CHECKIN_COOLDOWN_MS = 3600000; // 距上次尝试 ≥1 小时才再试（与桥侧同节奏）
const CHECKIN_SOURCES = new Set(['startup', 'hourly', 'manual']);

/** 归一化签到运行时状态；非法值一律回落默认，绝不原样落盘。 */
function readCheckinState() {
  const c = readState().checkin;
  const o = (c && typeof c === 'object' && !Array.isArray(c)) ? c : {};
  return {
    auto: typeof o.auto === 'boolean' ? o.auto : true, // 默认**开**
    lastAt: Number.isFinite(Number(o.lastAt)) && Number(o.lastAt) > 0 ? Number(o.lastAt) : null,
    lastResult: typeof o.lastResult === 'string' ? o.lastResult.slice(0, 40) : null,
    lastError: typeof o.lastError === 'string' ? o.lastError.slice(0, 200) : null,
    lastSource: CHECKIN_SOURCES.has(o.lastSource) ? o.lastSource : null,
  };
}

function writeCheckinState(patch) {
  // writeState 是合并写，checkin 整个对象被替换 —— 这里显式给出完整字段
  const next = { ...readCheckinState(), ...patch };
  writeState({ checkin: next });
  return next;
}

/** 直接打桥的签到接口（控制台侧不自己读凭据，一律经桥）。 */
async function bridgeCheckin(method, timeoutMs) {
  const res = await fetch(`${config.bridge.url}/v1/checkin`, {
    method,
    headers: { Authorization: `Bearer ${config.bridge.token}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { res, body: await res.json().catch(() => null) };
}

/**
 * 控制台侧的自动签到检查。**先问「签了没」再决定要不要打上游**——
 * 不做这一步，每小时都会对上游打一次无意义的签到请求。
 *
 * 桥没起来时**本轮直接跳过、不记失败**：那不是「签到失败」，是「没法签」。
 */
async function autoCheckinTick(source) {
  if (!AUTO_CHECKIN_ENABLED) return;
  const st = readCheckinState();
  if (!st.auto) return;
  if (st.lastAt && Date.now() - st.lastAt < CHECKIN_COOLDOWN_MS) return;

  let status = null;
  try {
    const { body } = await bridgeCheckin('GET', 8000);
    status = body && body.status;
  } catch {
    return; // 桥不可达：跳过，不写失败
  }
  if (!status) return;

  if (!status.active) {
    // 国际版没有积分系统：如实记成 no-activity，**不算失败**
    writeCheckinState({ lastAt: Date.now(), lastResult: 'no-activity', lastError: null, lastSource: source });
    return;
  }
  if (status.todayCheckedIn) {
    writeCheckinState({ lastAt: Date.now(), lastResult: 'already', lastError: null, lastSource: source });
    return;
  }

  try {
    const { res, body } = await bridgeCheckin('POST', 15000);
    if (body && body.ok) {
      writeCheckinState({
        lastAt: Date.now(),
        lastResult: body.already ? 'already' : 'ok',
        lastError: null,
        lastSource: source,
      });
    } else {
      writeCheckinState({
        lastAt: Date.now(),
        lastResult: 'error',
        lastError: String((body && body.error) || `HTTP ${res.status}`).slice(0, 200),
        lastSource: source,
      });
    }
  } catch (err) {
    writeCheckinState({
      lastAt: Date.now(),
      lastResult: 'error',
      lastError: String(err.message || err).slice(0, 200),
      lastSource: source,
    });
  }
}

/** 归一化路径用于比对（Windows 上同一路径可能以 / 或 \ 出现）。 */
const normPath = (p) => String(p || '').replace(/\\/g, '/').toLowerCase();

/**
 * 启动桥，并等到「本次 spawn 的那个进程」真正在服务为止。
 *
 * 不能再接受「端口上有个健康应答者」就算成功：端口被上一个桥占用时，新 spawn
 * 的进程会立刻以 EADDRINUSE 退出，而旧的应答者仍在——那样会把死进程的 PID
 * 报成「已启动」。这里只认 PID 相符；不符时如实返回 reused + spawnError。
 */
async function startBridgeAndWait(opts = {}) {
  const expected = normPath(opts.authFile || effectiveAuthFile());

  // 已经在跑且账号一致的桥：直接复用，不做注定失败的重复启动
  const before = await bridgeHealth();
  if (before.running && normPath(before.body?.authFile) === expected) {
    return { started: true, reused: true, pid: before.body?.pid ?? null, health: before.body, authFile: expected };
  }

  const result = startBridge(opts);
  if (!result.started) return result;

  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    await sleep(500);
    if (result.exited) break; // 新进程已经退出，继续等也不会就绪
    const h = await bridgeHealth(1500);
    if (h.running && Number(h.body?.pid) === Number(result.pid)) {
      return { ...result, health: h.body };
    }
  }

  // 新进程没能成为服务方。端口上若仍有别的桥在答，说清楚「在复用谁」
  const now = await bridgeHealth(1500);
  if (now.running) {
    if (normPath(now.body?.authFile) === expected) {
      return {
        started: true,
        reused: true,
        pid: now.body?.pid ?? null,
        health: now.body,
        authFile: expected,
        spawnError: result.spawnError || null,
      };
    }
    return {
      started: false,
      pid: result.pid,
      authFile: expected,
      spawnError: result.spawnError || null,
      error: `端口 ${config.bridge.port} 已被另一个账号的桥占用（PID ${now.body?.pid ?? '未知'}），`
        + `本次启动的进程已退出：${result.spawnError || '原因见日志'}`,
    };
  }
  return {
    started: false,
    pid: result.pid,
    authFile: expected,
    logPath: result.logPath,
    spawnError: result.spawnError || null,
    error: result.spawnError
      ? `新进程启动失败：${result.spawnError}`
      : `端口 ${config.bridge.port} 在 10 秒内没有有效响应（进程 PID ${result.pid}）`,
  };
}

/** 停桥并等端口真正释放，避免重启时撞上 TIME_WAIT。 */
async function stopBridgeAndWait() {
  const result = stopBridge();
  let freed = false;
  for (let i = 0; i < 20; i += 1) {
    await sleep(250);
    if (!findPortPid(config.bridge.port)) { freed = true; break; }
  }
  // POSIX 下 SIGTERM 被忽略时升级为 SIGKILL，否则重启会一直撞在旧进程上
  if (!freed && result.stopped && process.platform !== 'win32') {
    try { process.kill(result.pid, 'SIGKILL'); } catch { /* 已经退出了 */ }
    for (let i = 0; i < 12; i += 1) {
      await sleep(250);
      if (!findPortPid(config.bridge.port)) { freed = true; break; }
    }
  }
  return freed || !result.stopped ? result : { ...result, warning: '进程未在超时内退出，端口可能仍被占用' };
}

// ── 对话代理（流式原样透传） ────────────────────────────────────────────

/**
 * 对话代理（流式原样透传）。
 *
 * 浏览器断开（关标签页 / 点停止 / 刷新）必须同步取消上游：否则控制台会把
 * 上游整段流读完再丢弃，白白占着桥与上游的连接。
 */
async function proxyChat(req, res, payload) {
  const ac = new AbortController();
  const onClientClose = () => { if (!res.writableEnded) ac.abort(); };
  res.on('close', onClientClose);

  try {
    let upstream;
    try {
      upstream = await fetch(config.bridge.chatUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.bridge.token}`,
        },
        body: JSON.stringify(payload),
        signal: ac.signal,
      });
    } catch (err) {
      if (!res.headersSent && !ac.signal.aborted) {
        sendJson(res, 502, { error: { message: `无法连接桥服务：${err.message}` } });
      }
      return;
    }

    if (!upstream.ok || !upstream.body) {
      const text = await upstream.text().catch(() => '');
      sendJson(res, upstream.status, { error: { message: text || `上游 HTTP ${upstream.status}` } });
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    const reader = upstream.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    res.end();
  } catch (err) {
    // 客户端主动断开时 reader.read() 会以 AbortError 终止，属预期路径
    if (!ac.signal.aborted) console.error('代理对话失败：', err.message);
    try { res.end(); } catch { /* 已断开 */ }
  } finally {
    res.off('close', onClientClose);
  }
}

// ── 静态资源 ────────────────────────────────────────────────────────────

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function serveStatic(res, pathname) {
  const base = resolve(config.paths.dashboardPublic);
  let rel;
  try {
    rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  } catch {
    // 百分号编码非法（decodeURIComponent 会抛）：当作 404，而不是 500
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404');
    return;
  }
  // resolve 后再比对，`..` 与符号链接都被规范化掉；加分隔符避免 public-x 这类同前缀目录被放行
  const full = resolve(base, rel);
  if (full !== base && !full.startsWith(base + sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403');
    return;
  }
  if (!existsSync(full)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404');
    return;
  }
  const ext = full.slice(full.lastIndexOf('.'));
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': 'no-store',
  });
  res.end(readFileSync(full));
}

// ── 路由 ────────────────────────────────────────────────────────────────

const server = createServer(async (req, res) => {
  const url = new URL(req.url, config.dashboard.url);
  const route = url.pathname;

  try {
    if (route === '/api/overview') {
      // 只包含页面真正使用的字段：**不带** model 目录（另有 /api/models），
      // 桥冷启动时抓目录要串行打两个上游端点，不能让徽章陪着一起等。
      const [health, creds, quota] = await Promise.all([
        bridgeHealth(),
        credentialStatus(),
        bridgeQuota(),
      ]);
      const dsh = readDshStatus();
      sendJson(res, 200, {
        bridge: {
          running: health.running,
          ok: health.ok,
          host: config.bridge.host,
          port: config.bridge.port,
          endpoint: config.bridge.url,
          error: health.error || null,
          upstream: health.body?.auth?.endpoint || '',
          authFile: health.body?.authFile || effectiveAuthFile(),
          selectedAuthFile: effectiveAuthFile(),
          // 桥自述的进程信息：用于在页面上显示 PID 与运行时长
          pid: health.body?.pid ?? null,
          startedAt: health.body?.startedAt ?? null,
          uptimeMs: typeof health.body?.uptimeMs === 'number' ? health.body.uptimeMs : null,
          catalogSize: typeof health.body?.catalogSize === 'number' ? health.body.catalogSize : null,
          // 目录上次成功抓取的时间（桥 /health 已有）；桥未运行时为 null，页面据此隐藏「目录 HH:MM」
          catalogAt: health.body?.catalogAt || null,
          // 目录治理的诊断形状（含 droppedNonChat）：诊断报告要回答「某个模型为什么不在列表里」
          upstreamShape: health.body?.upstreamShape || null,
        },
        // 控制台自身版本：诊断报告头部要用，避免用户报障时说不清是哪个版本
        console: { version: consoleVersion(), node: process.version },
        credentials: creds,
        quota,
        dsh: {
          settingsExists: dsh.settingsExists,
          settingsHasRoute: dsh.settingsHasRoute,
          patchHasRoute: dsh.patchHasRoute,
          routeLive: dsh.routeLive,
          routeSource: dsh.routeSource,
          hasBridgeKey: dsh.hasBridgeKey,
          bundlesOk: dsh.bundlesOk,
          bundles: dsh.bundles,
          registeredModels: dsh.registeredModels,
        },
      });
      return;
    }

    if (route === '/api/diagnose') {
      sendJson(res, 200, await diagnose());
      return;
    }

    if (route === '/api/bridge/start' && req.method === 'POST') {
      const result = await startBridgeAndWait();
      sendJson(res, result.started ? 200 : 400, result);
      return;
    }

    if (route === '/api/bridge/stop' && req.method === 'POST') {
      sendJson(res, 200, await stopBridgeAndWait());
      return;
    }

    if (route === '/api/bridge/restart' && req.method === 'POST') {
      const wasRunning = (await bridgeHealth()).running;
      if (wasRunning) await stopBridgeAndWait();
      const result = await startBridgeAndWait();
      sendJson(res, result.started ? 200 : 400, { ...result, wasRunning });
      return;
    }

    // 模型目录单独成接口（与 /api/overview 解耦）：冷启动时桥要串行抓两个
    // 上游端点，这里可以慢慢等，页面先用占位。
    if (route === '/api/models') {
      // refresh=1 透传给桥（强制重取上游）；失败时桥会带回 staleMs，
      // 页面据此提示「仍显示 HH:MM 的缓存」，而不是假装刷新成功。
      const refresh = url.searchParams.get('refresh') === '1';
      const result = await bridgeModels(25000, refresh);
      sendJson(res, 200, {
        models: result.models,
        ...(result.staleMs !== null ? { staleMs: result.staleMs } : {}),
        ...(result.error ? { error: result.error } : {}),
      });
      return;
    }

    if (route === '/api/bridge/log') {
      if (req.method === 'DELETE') {
        // 桥持有 bridge.log 的追加 fd：截断后它的写入会从新文件末尾继续（O_APPEND）
        try {
          writeFileSync(config.paths.bridgeLog, '');
          sendJson(res, 200, { cleared: true });
        } catch (err) {
          sendJson(res, 500, { cleared: false, error: String(err.message || err) });
        }
        return;
      }
      sendJson(res, 200, {
        lines: readBridgeLog(Number(url.searchParams.get('lines') || 80), {
          currentOnly: url.searchParams.get('current') === '1',
        }),
      });
      return;
    }

    if (route === '/api/usage') {
      if (req.method === 'DELETE') {
        // 账本由桥维护（内存副本 + 文件），必须让桥自己清：
        // 只删文件的话，桥一旦触发整块重写就会把旧行写回来。
        try {
          const upstream = await fetch(`${config.bridge.url}/v1/usage`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${config.bridge.token}` },
            signal: AbortSignal.timeout(5000),
          });
          const body = await upstream.json().catch(() => null);
          if (!upstream.ok || !body?.ok) throw new Error((body && body.error) || `HTTP ${upstream.status}`);
          sendJson(res, 200, { cleared: true });
        } catch (err) {
          sendJson(res, 502, {
            cleared: false,
            error: `未能清空账本：${err.message}`,
          });
        }
        return;
      }
      sendJson(res, 200, {
        usage: await bridgeUsage(
          Math.min(Math.max(Number(url.searchParams.get('days')) || 7, 1), 90),
          url.searchParams.get('hours') === '1',
        ),
      });
      return;
    }

    if (route === '/api/requests') {
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 200);
      sendJson(res, 200, { requests: await bridgeRequests(limit) });
      return;
    }

    if (route === '/api/probe-results') {
      if (req.method === 'GET') {
        sendJson(res, 200, readProbeResults());
        return;
      }
      if (req.method === 'POST') {
        try {
          sendJson(res, 200, writeProbeResults(JSON.parse(await readBody(req))));
        } catch (err) {
          sendJson(res, 400, { saved: false, error: err.message });
        }
        return;
      }
      if (req.method === 'DELETE') {
        sendJson(res, 200, clearProbeResults());
        return;
      }
    }

    if (route === '/api/accounts') {
      sendJson(res, 200, await listAccounts());
      return;
    }

    if (route === '/api/account/switch' && req.method === 'POST') {
      try {
        const { file } = JSON.parse(await readBody(req));
        if (typeof file !== 'string' || !file) throw new Error('缺少 file');

        // 用已列举的结果校验，避免构造任意路径
        const listed = await listAccounts();
        const hit = listed.accounts.find((a) => a.name === file);
        if (!hit) throw new Error(`未知账号：${file}`);
        if (!hit.usable) throw new Error(`该账号当前不可用：${hit.error || '无法解开凭据'}`);

        const wasRunning = (await bridgeHealth()).running;
        if (wasRunning) await stopBridgeAndWait();
        writeState({ authFile: hit.path });
        // 体检结论只对被测时的那个账号成立：换账号后旧结论不能再作为新账号的
        // 事实展示（模型 id 往往两个账号都有，混用会直接误导）
        clearProbeResults();
        invalidateQuotaCache(); // 换了账号，余额是另一个账号的
        const started = await startBridgeAndWait({ authFile: hit.path });

        sendJson(res, 200, {
          switched: true,
          account: { name: hit.name, account: hit.account, domain: hit.domain },
          restarted: started.started === true,
          health: started.health || null,
          warning: started.warning || started.error || null,
        });
      } catch (err) {
        sendJson(res, 400, { switched: false, error: err.message });
      }
      return;
    }

    // 自动签到的开关（R11.1）。写 .state.json 的 checkin.auto；
    // **桥侧要重启桥才生效**，这里只负责控制台侧与下次启动时的注入。
    if (route === '/api/checkin/settings' && req.method === 'POST') {
      try {
        const { auto } = JSON.parse(await readBody(req));
        if (typeof auto !== 'boolean') throw new Error('auto 必须是布尔值');
        sendJson(res, 200, { saved: true, checkin: writeCheckinState({ auto }) });
      } catch (err) {
        sendJson(res, 400, { saved: false, error: err.message });
      }
      return;
    }

    if (route === '/api/checkin') {
      try {
        // 注意别把这里命名成 res —— 那会遮蔽 HTTP 响应对象
        const upstream = await fetch(`${config.bridge.url}/v1/checkin`, {
          method: req.method === 'POST' ? 'POST' : 'GET',
          headers: { Authorization: `Bearer ${config.bridge.token}` },
          signal: AbortSignal.timeout(30000),
        });
        const body = await upstream.json().catch(() => ({ ok: false, error: `HTTP ${upstream.status}` }));
        // 领取成功后余额会变，缓存必须失效，否则页面还显示旧的积分
        if (req.method === 'POST') {
          invalidateQuotaCache();
          // 手动签到也记一笔：面板上的「上次尝试」要能区分自动 / 手动
          const s = body && body.status;
          writeCheckinState({
            lastAt: Date.now(),
            lastResult: body && body.ok ? (body.already ? 'already' : 'ok') : 'error',
            lastError: body && body.ok ? null : String((body && body.error) || '签到失败').slice(0, 200),
            lastSource: 'manual',
          });
          if (s && s.active === false) {
            writeCheckinState({ lastResult: 'no-activity', lastError: null });
          }
        }
        // 把本地运行时状态一起带上，页面据此显示开关与「上次自动尝试」
        sendJson(res, upstream.ok ? 200 : upstream.status, { ...body, checkin: readCheckinState() });
      } catch (err) {
        sendJson(res, 502, { ok: false, error: String(err.message || err), checkin: readCheckinState() });
      }
      return;
    }

    if (route === '/api/probe' && req.method === 'POST') {
      try {
        const { model } = JSON.parse(await readBody(req));
        if (typeof model !== 'string' || !model) throw new Error('缺少 model');
        sendJson(res, 200, await probeModel(model));
      } catch (err) {
        sendJson(res, 400, { model: null, ok: false, error: err.message });
      }
      return;
    }

    if (route === '/api/chat' && req.method === 'POST') {
      await proxyChat(req, res, JSON.parse(await readBody(req)));
      return;
    }

    if (route === '/api/register' && req.method === 'POST') {
      try {
        const { models } = JSON.parse(await readBody(req));
        sendJson(res, 200, writeRegistration(models));
      } catch (err) {
        sendJson(res, 400, { saved: false, error: err.message });
      }
      return;
    }

    serveStatic(res, route);
  } catch (err) {
    sendJson(res, 500, { error: String(err.message || err) });
  }
});

/** 用系统默认浏览器打开地址（仅 启动.cmd 会开启这个行为）。 */
function openBrowser(url) {
  const table = {
    win32: ['cmd', ['/c', 'start', '', url]],
    darwin: ['open', [url]],
  };
  const [file, args] = table[process.platform] || ['xdg-open', [url]];
  try {
    const child = spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => { /* 打不开浏览器不影响服务本身 */ });
    child.unref();
  } catch {
    /* 同上 */
  }
}

server.listen(config.dashboard.port, config.dashboard.host, async () => {
  console.log(`WorkBuddy 控制台  ->  ${config.dashboard.url}`);
  console.log(`登录文件          ->  ${config.workbuddy.authFile}`);

  // 地址以实际监听结果为准（.env 里的 DASHBOARD_PORT 已生效），不再由脚本猜端口
  if (config.dashboard.openBrowser) openBrowser(config.dashboard.url);

  // 每日自动签到：启动时检查一次，之后每小时一次（R11.3）。
  // 覆盖「开着控制台但没人调模型」的情况；有人调模型时桥侧也会补签。
  if (AUTO_CHECKIN_ENABLED && readCheckinState().auto) {
    setTimeout(() => { autoCheckinTick('startup').catch(() => { /* 静默：失败已落盘 */ }); }, 3000);
  }
  setInterval(() => { autoCheckinTick('hourly').catch(() => { /* 同上 */ }); }, CHECKIN_COOLDOWN_MS);

  if (!config.dashboard.autoStartBridge) {
    console.log(`桥地址            ->  ${config.bridge.url}/v1（未自动启动）`);
    console.log('仅监听回环地址，Ctrl+C 退出。');
    return;
  }

  // 桥若已在跑就直接复用，避免重复绑定端口
  const existing = await bridgeHealth();
  if (existing.running) {
    console.log(`桥地址            ->  ${config.bridge.url}/v1（已在运行，复用）`);
    console.log('仅监听回环地址，Ctrl+C 退出。');
    return;
  }

  console.log('正在启动桥服务…');
  const result = await startBridgeAndWait();
  if (result.started) {
    console.log(`桥地址            ->  ${config.bridge.url}/v1（已就绪，PID ${result.pid}）`);
  } else {
    console.log(`桥启动失败        ->  ${result.error || result.warning || '未知原因'}`);
    console.log('可在页面上点「启动桥服务」重试。');
  }
  console.log('仅监听回环地址，Ctrl+C 退出控制台（桥会继续在后台运行）。');
});
