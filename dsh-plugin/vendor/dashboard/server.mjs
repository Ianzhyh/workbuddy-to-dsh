/**
 * WorkBuddy 本地 API 桥 —— 控制台（本地管理服务）。
 *
 * 零依赖，仅绑 127.0.0.1。本身不碰凭据，只调用 lib/ 下的共享逻辑，
 * 因此页面看到的结论与 `tools/doctor.mjs` 完全一致。
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { closeSync, existsSync, openSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
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

/**
 * 所有响应的基础安全头。
 *
 * `nosniff`：不让浏览器猜 Content-Type。`frame-ancestors 'none'` + `X-Frame-Options`：
 * 控制台带「停止桥 / 切换账号 / 写 dsh 配置」这类按钮，绝不能被其它页面用 iframe
 * 嵌起来做点击劫持。`Referrer-Policy`：控制台 URL 不该出现在外链的 Referer 里。
 *
 * 刻意**不**加 `script-src`：页面是单文件、含一大段内联脚本，要上严格的
 * script-src 只能配 `'unsafe-inline'`，那等于没加（规范也明确反对这种"快修"）。
 * 真要上，得先把内联脚本抽成外部文件 —— 属于后续独立工作，不在本轮夹带。
 */
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "frame-ancestors 'none'",
};

function sendJson(res, code, body) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...SECURITY_HEADERS,
  });
  res.end(JSON.stringify(body));
}

/**
 * 这个请求的 Origin 是否可以放行。
 *
 * **绑定 127.0.0.1 挡不住浏览器**：恶意网页可把域名解析到 127.0.0.1（DNS
 * rebinding），让浏览器把请求发到本机服务。控制台的**写**操作已有面板头
 * （会触发预检、跨站发不出），但**读**接口与静态页没有这一层 —— 补上 Origin
 * 白名单后，跨站形状的请求在到达任何路由之前就被拒掉。
 *
 * 判据：本机 CLI / 脚本 / 插件（curl、dsh、内部代理）**不发 Origin**，一律放行；
 * 带 Origin 的只放行**回环来源**（用户在本机另开网页访问控制台照常可用）。
 */
function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // 非浏览器调用
  let host;
  try { host = new URL(origin).hostname; } catch { return false; } // 含 `Origin: null`
  const bare = String(host).replace(/^\[|\]$/g, '');
  return bare === '127.0.0.1' || bare === 'localhost' || bare === '::1';
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

/**
 * 读取请求体，超过 limit 立刻失败。
 *
 * **超限时不 destroy，调用方回完 413 再 resume() 把剩余字节读掉。**
 * 这是桥那边踩过两次坑才定下来的做法（详见 `bridge/workbuddy-bridge.mjs` 里
 * `readBody` 的长注释），控制台原先漏改了，后果实测可见：
 *
 *   往 `/api/chat` 发 600KB（>512KB 上限）→ 客户端拿到的是
 *   `curl: (56) Recv failure: Connection was reset`，**没有任何错误信息**。
 *   而「对话测试」的历史是**不自动裁剪**的，聊久了就会撞上。
 *
 * `destroy()` 会把 socket 直接拆掉，响应还没来得及写就 RST 了；`resume()` 之后
 * 没有任何东西被累计进内存，每条请求 512KB 的硬上限依然成立。
 *
 * 另外补了 `done` 守卫：Node 的 `data` 事件是同步派发的，`fail()` 之后仍可能有
 * 在途 chunk 被 push 进数组 —— 桥那边有这个守卫，控制台原来没有。
 */
function readBody(req, limit = 1024 * 512) {
  return new Promise((ok, fail) => {
    let size = 0;
    let done = false;
    const chunks = [];
    req.on('data', (c) => {
      if (done) return; // 已判定超限：后续在途 chunk 一律丢弃，不再累计
      size += c.length;
      if (size > limit) {
        done = true;
        req.pause(); // 只是暂停；真正丢弃剩余字节要等 413 写完之后
        const err = new Error(`请求体过大（${size} > ${limit} 字节）`);
        err.code = 'BODY_TOO_LARGE';
        fail(err);
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => { if (!done) { done = true; ok(Buffer.concat(chunks).toString('utf8')); } });
    req.on('error', (e) => { if (!done) { done = true; fail(e); } });
  });
}

/**
 * 请求体过大时的统一收尾：回**明确的 413**，再把剩余字节读掉丢弃。
 *
 * 见 `readBody` 的注释 —— 不 resume 的话连接会被客户端判成异常断开。
 */
function bodyTooLarge(req, res) {
  sendJson(res, 413, {
    ok: false,
    code: 'BODY_TOO_LARGE',
    error: '请求体过大，已被拒绝。若是「对话测试」的历史太长，请点「清空对话」后重试。',
  });
  req.resume();
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

/** 异步 spawn 的公共选项：语义同上，但只收集 stdout（探测命令的 stderr 没有用）。 */
const ASYNC_OPTS = {
  stdio: ['ignore', 'pipe', 'ignore'],
  windowsHide: true,
};

/**
 * Windows 的 netstat 参数。
 *
 * `-p TCP` 是**必须**的：不带它时输出里混着 UDP（本机 DNS/DHCP/发现协议几百行），
 * 而我们只关心 TCP 监听端口。缩小输出面既省了解析，也让每次调用的内存与时间
 * 都可预期 —— 这个命令会被"停桥等待"的轮询反复调用。
 *
 * `-n` 关掉反向域名解析：否则每个外部地址都要去查一次 DNS，在断网或 DNS 慢的
 * 机器上单次 netstat 能卡到秒级（我们只需要端口号，主机名毫无用处）。
 */
const NETSTAT_ARGS = ['-ano', '-p', 'TCP', '-n'];

/**
 * 把一份 `netstat -ano` 风格的输出解析成该端口的监听 PID。
 *
 * 只认 LISTENING 行：否则会把「连到该端口的客户端」当成监听者，进而去 kill
 * 一个无辜的进程。端口匹配用 `:PORT` 结尾而不是 includes —— 否则找 790 会命中
 * `:8790`（前缀相同但完全是另一个端口）。
 */
function parsePortPid(stdout, port) {
  if (!stdout) return null;
  const suffix = `:${port}`;
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim();
    // 快路径：绝大多数行不含目标端口，先做一次廉价子串判断
    if (!line.includes(suffix) || !/LISTENING/i.test(line)) continue;
    const cols = line.split(/\s+/);
    if (!cols[1].endsWith(suffix)) continue;
    const pid = Number(cols[cols.length - 1]);
    if (Number.isInteger(pid) && pid > 0) return pid;
  }
  return null;
}

/**
 * 异步版的「按端口找监听进程」。
 *
 * 为什么要单独有一份异步实现：`stopBridgeAndWait` 要轮询"端口释放了没"
 * （最多 20 次，POSIX 升级 SIGKILL 后还有 12 次）。用同步版意味着每次轮询都
 * spawnSync 一个 netstat **把事件循环整个卡住** —— 停桥期间控制台连一个
 * `/api/overview` 都答不上来，页面表现为"点了停止，整个控制台卡死几秒"。
 * 异步版把等待时间还给事件循环，代价只是多一个 Promise。
 *
 * 只用于"等待端口释放"这条快路径；真正要 kill 的 PID 仍由同步版
 * {@link findPortPid} 给出（那条路径有 taskkill / process.kill 兜底，见 stopBridge）。
 *
 * 任何异常（命令不存在、超时、输出为空）都返回 null：对调用方来说
 * "探测不出来" 与 "没找到" 在轮询里是同一件事 —— 都表示还没释放/还不能关。
 */
function probePortPid(port) {
  return new Promise((ok) => {
    let child;
    try {
      child = process.platform === 'win32'
        ? spawn(systemExe('netstat'), NETSTAT_ARGS, ASYNC_OPTS)
        : spawn('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], ASYNC_OPTS);
    } catch {
      ok(null);
      return;
    }
    let out = '';
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(killer);
      ok(value);
    };
    // 探测命令本身卡住时必须能放弃：否则"停桥"会挂在一个永远不返回的 netstat 上
    const killer = setTimeout(() => { try { child.kill(); } catch { /* 已经退了 */ } finish(null); }, 5000);
    child.stdout.on('data', (c) => {
      out += c;
      // 输出量兜底：真出问题时别把整个 stdout 攒进内存
      if (out.length > 4 * 1024 * 1024) { try { child.kill(); } catch { /* 同上 */ } finish(null); }
    });
    child.on('error', () => finish(null));
    child.on('close', () => {
      if (process.platform === 'win32') { finish(parsePortPid(out, port)); return; }
      const pid = Number(out.split('\n').map((s) => s.trim()).filter(Boolean)[0]);
      finish(Number.isInteger(pid) && pid > 0 ? pid : null);
    });
  });
}

/**
 * 按端口找监听进程，跨平台（同步版）。
 *
 * 不要用 execSync：它经 cmd.exe 执行且默认给 stdin 开管道，在 Windows 上必定
 * 抛 EBUSY。spawnSync + stdio:['ignore',...] 直连 exe 才是可靠路径。
 *
 * Windows 用 `netstat`，macOS / Linux 用 `lsof`（缺 lsof 时退回 `ss`）。
 */
function findPortPid(port) {
  if (process.platform === 'win32') {
    const r = spawnSync(systemExe('netstat'), NETSTAT_ARGS, SYNC_OPTS);
    if (r.error || !r.stdout) return null;
    return parsePortPid(r.stdout, port);
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

function stopBridge(port = config.bridge.port) {
  const pid = findPortPid(port);
  if (!pid) return { stopped: false, error: `端口 ${port} 上没有监听进程` };
  // 明确带上 stopped:true —— 下面 stopBridgeAndWait 要靠它短路（"本来就没在跑"
  // 时不该再白等 5 秒端口轮询）
  return killPid(pid);
}

/**
 * 真正结束一个进程，跨平台。
 * Windows 必须 taskkill /F（process.kill 对非本进程树的老进程不一定可靠），
 * POSIX 走 SIGTERM（SIGKILL 的升级逻辑在 stopBridgeAndWait 里）。
 */
function killPid(pid) {
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

// 'auto' = 桥侧自动（定时器或顺带补签）；'manual' = 面板上点的手动签到。
// 旧版本写过 'startup' / 'hourly'，读取时仍要能认（历史 .state.json），但不新写。
const CHECKIN_SOURCES = new Set(['auto', 'startup', 'hourly', 'manual']);

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

/**
 * 把桥上报的自动签到结果合并进控制台的状态视图。
 *
 * ## 为什么控制台不再自己定时签到
 *
 * 原先控制台有一条 hourly tick：先 GET 签到状态、再决定要不要 POST。
 * 但**每日签到已经由桥独占**（桥才是常驻的那一方），那条 tick 完全重复 ——
 * 而且它每轮都要打一次上游 GET，**一天 24 次纯浪费**，签完之后也照打不误。
 *
 * 现在只剩两条触发路径，都是「直接签、不预检」：
 *   ① 桥自己的定时器（常驻，覆盖「不开控制台也不调模型」）
 *   ② 有人调模型时顺带补签
 * 两者的 POST 都是幂等的：上游「已签到」按成功处理，重复调用不会出问题。
 * 而且各自都有「当天签成功就不再试」的闸门，签完就停。
 *
 * ## 但面板仍要显示「上次尝试 · 自动（HH:MM）」
 *
 * 这份数据原先只有控制台那条 tick 在写。现在改从桥的 `/health.autoCheckin`
 * （`{at, result, credit}`）投影出来 —— 桥本来就在上报，不必再问一次。
 *
 * 取**较新的那个**：用户手动签过之后，`.state.json` 里的 'manual' 记录比桥的更近，
 * 这时不该被桥的旧记录盖掉。
 */
function checkinViewWithBridge(bridgeAuto) {
  const local = readCheckinState();
  const at = bridgeAuto && bridgeAuto.at ? Date.parse(bridgeAuto.at) : NaN;
  if (!Number.isFinite(at) || (local.lastAt && local.lastAt >= at)) return local;
  return {
    ...local,
    lastAt: at,
    lastResult: typeof bridgeAuto.result === 'string' ? bridgeAuto.result.slice(0, 40) : local.lastResult,
    lastError: typeof bridgeAuto.error === 'string' ? bridgeAuto.error.slice(0, 200) : null,
    // 'auto' = 桥的定时器/顺带补签；'manual' 由 /api/checkin 的 POST 分支写入
    lastSource: 'auto',
  };
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

/**
 * 停桥并等端口真正释放，避免重启时撞上 TIME_WAIT。
 *
 * 等待循环走**异步探测**（{@link probePortPid}）：早期版本在这里调同步的
 * findPortPid，于是一次"重启桥"最坏会 spawnSync 几十次 netstat，每次都把事件
 * 循环卡住 —— 控制台在停桥期间整段无响应。异步探测不影响正确性，只是把等待
 * 时间还给了事件循环。
 *
 * 返回值结构保持不变（`{stopped, ...}`，失败时补 `warning`）：前端与测试都在用。
 *
 * 导出（而不是只在本文件里用）是为了让自测能真的把桥停一遍：`/api/bridge/*`
 * 是破坏性接口，能直接调到的测试比"起个控制台进程再打 HTTP"稳得多。
 *
 * @param {string} [target] 只停**这一个** `host:port` 上的监听者。
 *   路由都走默认的 `config.bridge.port`；显式传值只给自测用 —— 否则测试要拿
 *   真实端口做断言就只能去改 `.env`（会连带把控制台自己也换到别的端口）。
 */
export async function stopBridgeAndWait(target) {
  const port = target || config.bridge.port;
  const result = stopBridge(port);
  // stopBridge 已经确认过"端口上没有监听进程"（`stopped:false`）：此时再去
  // 轮询端口纯属浪费 —— 直接原样返回。这条短路同时保证了"桥本来就没跑"时
  // 停止按钮是**立刻**返回的，不会先白等 5 秒。
  if (!result.stopped) return result;

  let freed = false;
  for (let i = 0; i < 20; i += 1) {
    await sleep(250);
    if (!(await probePortPid(port))) { freed = true; break; }
  }
  // POSIX 下 SIGTERM 被忽略时升级为 SIGKILL，否则重启会一直撞在旧进程上
  if (!freed && process.platform !== 'win32') {
    try { process.kill(result.pid, 'SIGKILL'); } catch { /* 已经退出了 */ }
    for (let i = 0; i < 12; i += 1) {
      await sleep(250);
      if (!(await probePortPid(port))) { freed = true; break; }
    }
  }
  return freed ? result : { ...result, warning: `进程未在超时内退出，端口 ${port} 可能仍被占用` };
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
      ...SECURITY_HEADERS,
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
  // 只服务页面真正需要的文件：**拒绝点文件与备份/临时文件**。
  // 实测 `GET /index.html.bak` 会 200 返回整份旧页面 —— 这不是密钥泄漏，但它把
  // 工作副本（历史版本、编辑器残留）暴露给任何能打到本机端口的人。静态目录属于
  // "发布物"，不该连带把工作区状态一起发出去。
  const denied = rel.split(/[\\/]/).some((seg) => seg.startsWith('.'))
    || /\.(bak|orig|tmp|swp|rej|save)(\.|$)/i.test(rel);
  if (denied) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404');
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
    ...SECURITY_HEADERS,
  });
  res.end(readFileSync(full));
}

// ── 路由 ────────────────────────────────────────────────────────────────

const server = createServer(async (req, res) => {
  const url = new URL(req.url, config.dashboard.url);
  const route = url.pathname;

  try {
    // 跨站来源一律拒（DNS rebinding 的防线，见 originAllowed 的说明）。
    // 放在最前面：无论读还是写、无论路由存不存在，跨站形状的请求都进不来。
    if (!originAllowed(req)) {
      return sendJson(res, 403, { ok: false, error: 'cross-origin request rejected (this console serves local clients only)' });
    }

    /**
     * 写操作的准入检查：必须带 `x-workbuddy-panel: 1`。
     *
     * 为什么需要：控制台是"浏览器里任何网页都打得通的本地 HTTP 服务"。跨站的
     * **简单请求**（POST + 简单 Content-Type）浏览器不做预检、直接发出，恶意页面
     * 可以在用户不知情的情况下触发停桥 / 切账号 / 写 dsh 配置 / 消耗额度 ——
     * 响应它读不到，但副作用已经发生（实测：外部页面 POST /api/checkin/settings
     * 真的改动了 .state.json）。要求一个自定义头会强制 CORS 预检，而本服务不解答
     * 预检 → 跨站请求根本发不出来。与插件侧数据面（lib/routes.mjs）同一套做法。
     *
     * 读操作（GET/HEAD）不拦：只暴露非敏感元数据，且插件/脚本要能直接读。
     */
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers['x-workbuddy-panel'] !== '1') {
      return sendJson(res, 403, { ok: false, error: 'missing x-workbuddy-panel header' });
    }

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
          /**
           * 桥侧的**自动签到**内存态：`{ at, result, credit? }`，桥重启后清空。
           *
           * 为什么必须透出来：自动签到有两条后台路径（桥的定时器、有人调模型时
           * 顺带补签），它们发生时**没有任何东西通知页面**。页面若不
           * 刷新，就会一直显示「今日尚未签到」—— 而积分其实早已到账。实测证据：
           * 桥日志记录 `auto checkin ok 100`，同一时刻页面仍显示「今日尚未签到」。
           * 这属于"结论在说谎"，比不显示更糟。
           *
           * 为什么放在 /api/overview 而不是新增一次 /api/checkin 轮询：overview
           * 本来就在每 20 秒轮询，这里只是顺带带上，**零额外上游请求**；而
           * /api/checkin 每次都打上游计费端点，拿它去轮询纯属浪费。页面据 `at`
           * 的变化判断"有新一次自动签到发生了"，再按需刷新签到面板。
           */
          autoCheckin: health.body?.autoCheckin || null,
          /** 桥侧是否启用自动签到（启动时由 env 注入，改开关需重启桥才生效）。 */
          autoCheckinEnabled: health.body?.autoCheckinEnabled === true,
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

    /**
     * 客户端接入信息。
     *
     * 为什么不塞进 `/api/overview`：overview 每 20 秒轮询一次，而这里返回的
     * 东西**全是静态的**（地址、令牌、模型映射），没必要跟着轮询反复下发；
     * 面板也只在打开时取一次。
     *
     * 关于返回本地令牌：它是 `WORKBUDDY_LOCAL_TOKEN`，作用是防止同机其它程序
     * 误用这个回环端口，**不是上游凭据**（上游凭据全程不出桥、也从不落日志）。
     * 面板存在的意义就是让人把这个值填进客户端，不给值面板就没用了。
     * 接口与整个控制台一样只绑 127.0.0.1。
     */
    if (route === '/api/clients') {
      const [health, catalog] = await Promise.all([bridgeHealth(), bridgeModels(8000)]);
      /**
       * 只取桥默认精选的那几个，口径与 `/v1/models` 保持一致，但**带上完整元数据**。
       *
       * 为什么必须带 `context` / `maxOutput`：GUI 客户端的「自定义提供商」表单里有
       * 「上下文长度」「输出上限」两格，填 0 或留空会让客户端把上下文显示成 **0**，
       * 用户以为桥坏了。桥明明知道真实值（`context_window` / `max_output_tokens`），
       * 没理由让用户自己猜。
       */
      const featured = new Set(health.body?.models || []);
      const details = (catalog.models || [])
        .filter((m) => featured.has(m.id))
        .map((m) => ({
          id: m.id,
          name: m.name || m.id,
          context: Number(m.context_window) || 0,
          maxOutput: Number(m.max_output_tokens) || 0,
          supportsReasoning: m.supports_reasoning === true,
          supportsImages: m.supports_images === true,
        }));
      sendJson(res, 200, {
        running: health.running,
        host: config.bridge.host,
        port: config.bridge.port,
        /** OpenAI 系客户端填这个（opencode / Cherry Studio / Cursor / Trae …） */
        baseUrlOpenAI: `${config.bridge.url}/v1`,
        /** Anthropic 系客户端填这个（Claude Code 走 ANTHROPIC_BASE_URL） */
        baseUrlAnthropic: config.bridge.url,
        token: config.bridge.token,
        /**
         * Anthropic 层的模型映射。必须如实展示：用户在 Claude Code 里选的是
         * sonnet、实际跑的是 glm-5.3——不说清楚，他会以为桥把模型选错了。
         */
        anthropicModel: config.bridge.anthropicModel,
        anthropicFastModel: config.bridge.anthropicFastModel,
        models: details.map((m) => m.id),
        modelDetails: details,
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
      // 端点是 POST：浏览器把「页面/请求断开」和「用户点了停止」都报在这里。
      // 客户端已经断开时没人收响应，但**停桥必须照做**（用户取消/关页不该让桥
      // 留着）；而且要对齐 proxyChat 的做法——断了就取消后续的等待，别为一个
      // 没人要的响应白等 5 秒端口轮询。
      const ac = new AbortController();
      const onClientClose = () => { if (!res.writableEnded) ac.abort(); };
      res.on('close', onClientClose);
      try {
        const result = await stopBridgeAndWait();
        if (!ac.signal.aborted) sendJson(res, 200, result);
      } finally {
        res.off('close', onClientClose);
      }
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
      // lines 必须做数值校验：`Number('abc')` 是 NaN，而 `list.slice(-NaN)` 等价于
      // `slice(0)` —— 会把**整份日志**返回。实测 lines=abc / 0 / 999999 都返回了全部
      // 1919 行（而不是 80 行）。这里与插件侧 /workbuddy/log 用同一套 clamp，
      // 非法值回落到本接口的默认 80，有效值上限 2000。
      const rawLines = Number(url.searchParams.get('lines'));
      const lineCount = Number.isFinite(rawLines) && rawLines > 0 ? Math.min(Math.floor(rawLines), 2000) : 80;
      sendJson(res, 200, {
        lines: readBridgeLog(lineCount, {
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
      // 形状：{ requests, active, activeAlertMs }（桥不可用时 requests=null、
      // active 为空数组 —— 前端按同一形状渲染，不必分叉）。
      const data = await bridgeRequests(limit);
      sendJson(res, 200, data || { requests: null, active: [], activeAlertMs: null });
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
          if (err.code === 'BODY_TOO_LARGE') return bodyTooLarge(req, res);
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
        if (err.code === 'BODY_TOO_LARGE') return bodyTooLarge(req, res);
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
        if (err.code === 'BODY_TOO_LARGE') return bodyTooLarge(req, res);
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
        // 把本地运行时状态一起带上，页面据此显示开关与「上次自动尝试」。
        // 「上次自动尝试」的**真实来源是桥**（签到由桥独占），所以要把桥上报的
        // autoCheckin 合并进来 —— 否则面板永远显示不出桥做过的事。
        // 这是本地 /health 调用（不打上游），代价可忽略。
        const health = await bridgeHealth(2000);
        sendJson(res, upstream.ok ? 200 : upstream.status, {
          ...body,
          checkin: checkinViewWithBridge(health.body?.autoCheckin),
        });
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
        if (err.code === 'BODY_TOO_LARGE') return bodyTooLarge(req, res);
        sendJson(res, 400, { model: null, ok: false, error: err.message });
      }
      return;
    }

    if (route === '/api/chat' && req.method === 'POST') {
      // 「对话测试」的历史**不自动裁剪**，聊久了请求体就会超 512KB 上限。
      // 这条路径原来是直接 `readBody` 往外抛、由外层 catch 成 500 —— 而那时
      // socket 已经被 destroy，客户端只看到 `Connection was reset`，
      // 完全不知道发生了什么（实测 curl: (56)）。这里单独接住，回明确的 413。
      let raw;
      try {
        raw = await readBody(req);
      } catch (e) {
        if (e.code === 'BODY_TOO_LARGE') return bodyTooLarge(req, res);
        throw e;
      }
      await proxyChat(req, res, JSON.parse(raw));
      return;
    }

    if (route === '/api/register' && req.method === 'POST') {
      try {
        const { models } = JSON.parse(await readBody(req));
        sendJson(res, 200, writeRegistration(models));
      } catch (err) {
        if (err.code === 'BODY_TOO_LARGE') return bodyTooLarge(req, res);
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

/**
 * 这个文件**被当作程序运行时**才起服务（`node dashboard/server.mjs`）。
 *
 * 为什么要这道门：`stopBridgeAndWait` 是导出给自测用的，而"import 就跑
 * `server.listen`"会让测试进程多出一个永不关闭的监听 socket —— `node --test`
 * 的子进程因此**永远不会退出**，runner 只能把它判成失败（现场看不到任何断言
 * 报错，只有一个笼统的 "test failed"，极难排查）。副作用不该在 import 时发生。
 *
 * 用 `import.meta.url` 与 `process.argv[1]` 比对是零依赖的判据；`.cmd`/快捷方式
 * 直接 `node dashboard/server.mjs` 时 argv[1] 就是它自己的路径。
 * 路径在 Windows 上大小写与分隔符都可能不一致，因此先 resolve 再比对。
 */
function isMainModule() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return resolve(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

/** 启动控制台服务（进程入口调用；测试 import 时不执行）。 */
function startConsoleServer() {
  server.listen(config.dashboard.port, config.dashboard.host, async () => {
    console.log(`WorkBuddy 控制台  ->  ${config.dashboard.url}`);
    console.log(`登录文件          ->  ${config.workbuddy.authFile}`);

    // 地址以实际监听结果为准（.env 里的 DASHBOARD_PORT 已生效），不再由脚本猜端口
    if (config.dashboard.openBrowser) openBrowser(config.dashboard.url);

    // 每日自动签到**不在这里做**：它由桥独占（桥是常驻的那一方）。
    // 控制台原先那条 hourly tick 每轮都要打一次上游 GET，一天 24 次纯浪费，
    // 且与桥的定时器完全重复 —— 详见 checkinViewWithBridge 的说明。

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
}

if (isMainModule()) startConsoleServer();
