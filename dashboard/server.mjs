/**
 * WorkBuddy 本地 API 桥 —— 控制台（本地管理服务）。
 *
 * 零依赖，仅绑 127.0.0.1。本身不碰凭据，只调用 lib/ 下的共享逻辑，
 * 因此页面看到的结论与 `tools/doctor.mjs` 完全一致。
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { closeSync, existsSync, openSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import config, { bridgeEnv } from '../config.mjs';
import {
  bridgeHealth,
  bridgeIdentity,
  bridgeModels,
  bridgeModelsDefault,
  bridgeSaveModelsDefault,
  bridgeQuota,
  bridgeRequests,
  bridgeUsage,
  bridgeAuthSource,
  bridgeAuthCredentials,
  bridgeDeviceStart,
  bridgeDevicePoll,
  bridgeDeviceCancel,
  bridgeAuthActive,
  bridgeAuthLogout,
  bridgeSetAuthSource,
  credentialStatus,
  diagnose,
  fileBuildHash,
  invalidateQuotaCache,
  listAccountFiles,
  listAccounts,
  probeModel,
  readBridgeLog,
  reconcileAccountPin,
} from '../lib/diagnostics.mjs';
import { readDshStatus, writeRegistration } from '../lib/dsh.mjs';
import {
  CONNECT_CLIENTS,
  applyClient,
  assertModelKnown,
  buildConnectBase,
  contextForClient,
  findClient,
  modelOptions,
  planClient,
  recordedConnect,
  resolveBackupRoot,
  resolveModelChoice,
  resolveSelection,
  assertModelsKnown,
  switchClientMode,
  undoClient,
  verifyAgainstBridge,
  verifyWritten,
} from '../lib/client-connect.mjs';
import { effectiveAuthFile, readState, writeAccountAlias, writeAccountHidden, writeAccountOrder, writeState, writeStateStrict } from '../lib/state.mjs';
import { failoverSignal, pickAccountFailoverTarget } from '../lib/failover.mjs';

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
const STARTED_AT = Date.now();
/**
 * 上一次看到的桥 PID。桥重启（换号/升级/手动重启）后积分可能已经换了钱包，
 * 即便账号相同也重取一次，避免「刚重启，页面还是重启前的余额」。
 */
let lastBridgePid = 0;
/**
 * 上次尝试校正账号钉住的键（桌面账号|生效文件账号）。只在校正失败/用户
 * 主动钉住不同快照时避免每 20 秒重复启动客户端取密钥。
 */
let lastPinReconcileKey = '';
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
 * 控制台自身的构建指纹（服务端 + 页面 + 样式）。
 *
 * 与桥同理：插件升级后，旧的 8792 进程会继续提供旧页面/旧接口。页面里
 * 嵌这个指纹，插件探活时就能判断「端口上的控制台是不是当前磁盘代码」，
 * 不一致时自动重启（issue #5 的保存回退 / #6 的账号卡片都可能因旧页面而复现）。
 */
let consoleBuildCache = null;
function consoleBuild() {
  if (consoleBuildCache !== null) return consoleBuildCache;
  try {
    const hash = createHash('sha256');
    for (const file of [
      fileURLToPath(import.meta.url),
      join(config.paths.dashboardPublic, 'index.html'),
      join(config.paths.dashboardPublic, 'style.css'),
    ]) {
      hash.update(readFileSync(file));
    }
    consoleBuildCache = hash.digest('hex').slice(0, 16);
  } catch {
    consoleBuildCache = '';
  }
  return consoleBuildCache;
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
/**
 * 探测端口上还有没有监听者。**三种结果必须分开**：
 *
 *   `number`    —— 有监听者，这是它的 PID
 *   `null`      —— **确认**没有监听者（端口已释放）
 *   `undefined` —— **探测不出来**（命令缺失 / 超时 / 输出为空 / 子进程报错）
 *
 * 早先这三者都返回 `null`，而调用方把 `null` 读作「已释放」——
 * 于是在没有 `lsof` 的 Linux 上（`spawn` 直接抛），停桥**从不真正校验**就报成功；
 * 而且 `freed` 提前变 true 会让下面「SIGTERM 被忽略时升级 SIGKILL」那段
 * **永远不执行**，可它存在的理由正是防止重启撞在旧进程上。
 * 「探测不出来」和「确认没有」不是一回事，合并它们就会把未知当成好消息。
 */
function probePortPid(port) {
  return new Promise((ok) => {
    let child;
    try {
      child = process.platform === 'win32'
        ? spawn(systemExe('netstat'), NETSTAT_ARGS, ASYNC_OPTS)
        : spawn('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], ASYNC_OPTS);
    } catch {
      ok(undefined); // 探测命令都起不来：未知，不是「已释放」
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
    const killer = setTimeout(() => { try { child.kill(); } catch { /* 已经退了 */ } finish(undefined); }, 5000);
    child.stdout.on('data', (c) => {
      out += c;
      // 输出量兜底：真出问题时别把整个 stdout 攒进内存
      if (out.length > 4 * 1024 * 1024) { try { child.kill(); } catch { /* 同上 */ } finish(undefined); }
    });
    child.on('error', () => finish(undefined));
    child.on('close', () => {
      if (process.platform === 'win32') { finish(parsePortPid(out, port)); return; }
      const pid = Number(out.split('\n').map((s) => s.trim()).filter(Boolean)[0]);
      // 命令正常退出、输出解析不出 PID → 这是「确认没有监听者」，返回 null
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

  /*
   * 钉住的是账号快照时，同时把「跟随桌面活动登录文件」告诉桥：用户在客户端
   * 换号（或改用另一个客户端）后桥会自动跟随。传 `auto` 而不是固定路径，
   * 让桥在每次检查时按当前活动文件（国内版/国际版）重新判断。
   * `followUid` 是钉住那一刻桌面文件里的账号；没有它（旧状态）由桥按
   * "快照账号 ≠ 桌面账号"迁移一次。
   */
  const desktopAuth = config.workbuddy.authFile;
  const statePinned = Boolean(String(readState().authFile || '').trim());
  const followAuthFile = opts.followAuthFile
    || ((statePinned && normPath(authFile) !== normPath(desktopAuth)) ? 'auto' : '');
  const followUid = opts.followUid !== undefined
    ? String(opts.followUid || '')
    : String(readState().authFileDesktopUid || '');

  rotateLogIfNeeded(config.paths.bridgeLog);
  const logPath = config.paths.bridgeLog;
  const logOffset = existsSync(logPath) ? statSync(logPath).size : 0;
  const logFd = openSync(logPath, 'a');
  const child = spawn(process.execPath, [script], {
    cwd: config.paths.root,
    // 自动签到的开关随启动注入一次 —— 桥侧读 env，改了要重启桥才生效
    env: bridgeEnv({ authFile, autoCheckin: readCheckinState().auto, followAuthFile, followUid }),
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

/**
 * 端口上那个监听进程，**是不是我们的桥**？
 *
 * 为什么必须问这一句：`stopBridge` 拿到的 pid 来自 `netstat`/`lsof` 的
 * 「谁在监听这个端口」——那可以是**任何**进程。8790 被用户自己另起的服务
 * （另一个 node、某个开发服务器、别的工具）占着是常见情况，此时
 * "停止桥服务"会变成"强杀别人的进程"，且没有任何确认。
 *
 * 判据与 dsh 插件的 `BridgeSupervisor.probe()` 保持一致（`health.ok === true`
 * 且 `pid` 是数字）：两边对"这是不是桥"必须给出同一个答案，否则会出现
 * 「插件说 foreign、控制台照杀」这种自相矛盾的行为。
 *
 * 三态返回（与 probePortPid 同一套语义）：
 *   true      —— 确认是桥
 *   false     —— 确认不是（有响应但不是桥的形状 / 明确 401、403 等）
 *   undefined —— 探测不出来（超时 / 连不上 / 网络错），**不能当作"是"**
 *
 * 连不上返回 undefined 而不是 false，是因为"探测失败"与"确认不是桥"
 * 的处置完全不同：前者不该贸然 kill，也不该断言"不是桥"误导用户。
 */
async function isOurBridge(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { Authorization: `Bearer ${config.bridge.token}` },
      signal: AbortSignal.timeout(3000),
    });
    /*
     * 401 必须单独处理：那说明**这确实是我们的桥**，只是我们手里的令牌跟它不一致
     * （典型场景：桥是用另一套配置/更早的令牌起来的，或用户改过 .env）。
     *
     * 若在这里一律 `return false`（"不是桥"），会同时造成两个错误后果：
     *   ① 用户看到「端口上的进程不是 workbuddy-bridge」——**这条诊断是假的**，
     *      他会去找一个不存在的进程冲突，而真正的问题（令牌不一致）被掩盖；
     *   ② 想停掉这个自己人反而停不了，只能去开任务管理器。
     * 所以 401 → 仍判为"是自己的桥，可以停"。
     */
    if (res.status === 401) return true;
    if (!res.ok) return false;
    const body = await res.json().catch(() => null);
    // 注意：必须显式 `=== true` 再转布尔。写成 `return body && body.ok === true && ...`
    // 会在 body 为 null 时返回 **null**（`&&` 返回操作数本身），而调用方的
    // `owner === false` 判定不成立 → 直接掉进 killPid，等于校验失效。
    return body !== null && body.ok === true && typeof body.pid === 'number';
  } catch {
    return undefined;
  }
}

async function stopBridge(port = config.bridge.port) {
  const pid = findPortPid(port);
  if (!pid) return { stopped: false, error: `端口 ${port} 上没有监听进程` };

  /*
   * 归属校验：**杀之前先确认这是我们的桥**。
   *
   * 早先这里直接 `killPid(pid)` —— 那个 pid 只是"谁在监听 8790"，
   * 完全可能是用户的其它服务。实测（本机起一个无关 HTTP 服务占住端口）：
   * 控制台会把它当成桥并 `taskkill /F` 杀掉，用户毫无察觉。
   * 插件侧一直有这道校验（`probe()` 的 foreign 判定），控制台漏了。
   */
  const owner = await isOurBridge(port);
  /*
   * 只放行「确认是桥」这一种情况。
   *
   * 早先写的是 `if (owner === false) reject; if (owner === undefined) reject;`
   * —— 两个否定条件都过完才 kill。那依赖 isOurBridge **严格**只返回三态值；
   * 它一旦因为任何写法原因返回了别的假值（null / 0 / ''），两个分支都不进，
   * 直接掉进 killPid —— 校验静默失效。正向放行是这类"守卫"唯一稳妥的写法。
   */
  if (owner !== true) {
    const why = owner === false
      ? `端口 ${port} 上的进程（PID ${pid}）不是 workbuddy-bridge，已拒绝结束它。`
        + '如果桥本应在这里，请检查它是否已经退出、或改 WORKBUDDY_PORT；'
        + '若该端口被你自己的其它程序占用，请自行处理。'
      : `无法确认端口 ${port} 上的进程（PID ${pid}）是不是 workbuddy-bridge`
        + '（/health 探测超时或连不上），为避免误杀无关进程，已放弃结束它。'
        + '请稍后重试，或手动确认该进程后再处理。';
    return { stopped: false, pid, error: why };
  }

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
 * 桥健康响应是否符合"我们期望的登录文件"。
 *
 * 钉住快照 + 自动跟随时，桥可能已经跟随桌面端登录文件：`authFile` 是当前
 * 生效文件，`authFilePinned` 才是启动时钉住的那个。两者任一匹配都算——
 * 否则控制台会误判"端口被另一个账号的桥占用"。
 */
function authFileMatches(healthBody, expected) {
  const want = normPath(expected);
  return normPath(healthBody?.authFile) === want || normPath(healthBody?.authFilePinned) === want;
}

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
  const expectedBuild = fileBuildHash(config.paths.bridgeScript);
  if (before.running && authFileMatches(before.body, expected)) {
    /*
     * 升级只换磁盘脚本，后台的桥仍是旧进程。构建不一致时必须重启一次，
     * 否则用户升级后继续被旧逻辑服务（思考档位/换号跟随/目录判定全是旧的）。
     */
    const runningBuild = before.body?.build || '';
    if (!expectedBuild || runningBuild === expectedBuild) {
      return { started: true, reused: true, pid: before.body?.pid ?? null, health: before.body, authFile: expected };
    }
    console.log(`桥构建已变化（${runningBuild || '旧版本'} -> ${expectedBuild}），重启桥以加载新代码`);
    await stopBridgeAndWait();
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
    if (authFileMatches(now.body, expected)) {
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
 * 解除账号钉住后，把还在用旧快照的桥重启到桌面端当前账号。
 *
 * 只重启「确实是按 `previousPin` 启动」的桥：插件自己拉起、跟随默认文件的
 * 桥不该被控制台顺手重启。
 */
async function applyAccountPinCorrection(pin) {
  if (!pin?.changed) return { applied: false, restarted: false, error: null };
  /*
   * 这条路径也会停/起桥 —— 必须与切号排同一队列，否则 GET /api/accounts 触发的
   * 校正会和用户手动切号交错（一个停桥、另一个起桥，端口撞车）。
   */
  return runBridgeLifecycle(async () => {
    /*
     * 钉住状态变了 = 桥可能换了账号。无论这次是否真的重启桥，积分缓存都必须
     * 作废：否则页面会把上一个账号的余额继续显示在新账号下（issue #6）。
     */
    invalidateQuotaCache();
    const health = await bridgeHealth();
    if (!health.running) return { applied: false, restarted: false, error: null };
    /*
     * 看**当前生效文件**：桥可能已经跟随桌面换号（authFile=桌面文件），
     * 此时 authFilePinned 还是旧快照但桥早就不读它了。拿 pinned 判断会误重启
     * 一个已经正确的桥；只有当前生效文件仍是旧钉住文件时才需要重启。
     */
    const running = health.body?.authFile || health.body?.authFilePinned;
    if (pin.previousPin && normPath(running) !== normPath(pin.previousPin)) {
      return { applied: false, restarted: false, error: null };
    }
    await stopBridgeAndWait();
    const started = await startBridgeAndWait();
    return { applied: true, restarted: started.started === true, error: started.error || started.warning || null };
  });
}

/**
 * 切换桌面账号：写 `.state.json` → 停桥 → 用目标文件起桥 → 校验账号。
 *
 * 面板「切换账号」、限流自动切号、插件 failover 共用这一条路径，避免多套规则漂移。
 *
 * **失败必须如实报告，并回到原状态**（issue #17 的后续审计）：
 *   1. **先写期望态再停桥**：写不进去就根本不动桥。反过来的话，桥停了、状态
 *      没落盘，重启后账号跳回去，而调用方以为切换成功了。
 *   2. 停桥失败 → 回滚 state，返回 `switched:false`。
 *   3. 新账号起不来 / 起来的账号与目标不一致 → 回滚 state，并按旧账号把桥恢复。
 *      原先无论结果如何都回 `switched:true`，面板会显示"已切换"，实际还在旧账号
 *      （甚至桥停着）。
 *   4. 原本桥就没跑：失败后保持停止（不"顺手"用旧账号起一个用户没要求的桥）。
 *
 * `deps` 仅给单测注入用（真实调用一律用默认实现）。
 */
export async function switchDesktopAccount(file, deps = {}) {
  const api = {
    listAccountFiles,
    bridgeHealth,
    stopBridgeAndWait,
    startBridgeAndWait,
    readState,
    writeState,
    writeStateStrict,
    clearProbeResults,
    invalidateQuotaCache,
    ...deps,
  };
  return runBridgeLifecycle(async () => {
    const listed = await api.listAccountFiles();
    const hit = listed.accounts.find((a) => a.name === file);
    if (!hit) throw new Error(`未知账号：${file}`);
    if (!hit.usable) throw new Error(`该账号当前不可用：${hit.error || '无法解开凭据'}`);
    const account = { name: hit.name, account: hit.account, domain: hit.domain };
    const wasRunning = (await api.bridgeHealth()).running;

    /* 回滚快照：三个键都要精确还原；原来没有的键用 null 删除。 */
    const prev = api.readState();
    const snapshot = {
      authFile: prev.authFile ?? null,
      authFileDesktopUid: prev.authFileDesktopUid ?? null,
      authFilePinnedAt: prev.authFilePinnedAt ?? null,
    };
    const rollbackState = () => {
      try { api.writeState(snapshot); } catch { /* 回滚写失败：保留旧缓存，尽力而为 */ }
    };

    try {
      api.writeStateStrict({
        authFile: hit.path,
        authFileDesktopUid: listed.desktopUid || null,
        authFilePinnedAt: new Date().toISOString(),
      });
    } catch (error) {
      return {
        switched: false,
        restarted: false,
        account,
        error: `无法写入账号选择（${error?.message || error}），桥未改动`,
      };
    }

    if (wasRunning) {
      const stopped = await api.stopBridgeAndWait();
      if (stopped.stopped !== true) {
        rollbackState();
        return {
          switched: false,
          restarted: false,
          account,
          error: `旧桥没能停下来：${stopped.warning || stopped.error || '未知原因'}`,
        };
      }
    }
    api.clearProbeResults();
    api.invalidateQuotaCache();

    const started = await api.startBridgeAndWait({ authFile: hit.path, followUid: listed.desktopUid || '' });
    /*
     * 只有**真的起来了**才去核对登录账号。启动失败时端口上可能还有旧桥在答
     * （停桥没彻底生效），拿它的 userId 去比会得到"账号不一致"，把真正的
     * 启动错误掩盖掉。
     */
    const health = started.health
      || (started.started === true ? (await api.bridgeHealth()).body : null)
      || null;
    const actualUid = health?.auth?.userId ? String(health.auth.userId) : '';
    const uidMismatch = started.started === true
      && Boolean(hit.userId && actualUid && String(hit.userId) !== actualUid);
    if (started.started !== true || uidMismatch) {
      rollbackState();
      let rollbackNote = '';
      if (wasRunning) {
        const restored = await api.startBridgeAndWait(snapshot.authFile
          ? { authFile: snapshot.authFile, followUid: snapshot.authFileDesktopUid || '' }
          : {});
        rollbackNote = restored.started === true
          ? '；已恢复原账号'
          : `；原账号也未能恢复：${restored.error || restored.warning || '未知原因'}`;
      }
      return {
        switched: false,
        restarted: false,
        rolledBack: true,
        account,
        error: `${uidMismatch
          ? `桥登录的账号与目标不一致（目标 ${hit.userId}，实际 ${actualUid}）`
          : (started.error || started.warning || '桥未能以新账号启动')}${rollbackNote}`,
      };
    }
    return {
      switched: true,
      account,
      restarted: true,
      health,
      warning: started.warning || null,
    };
  });
}

/**
 * 从账号列表挑下一个可切换账号 —— 实现见 `lib/failover.mjs`（与 dsh 插件共用，
 * 避免两份副本规则漂移）。这里重新导出是给自测用的。
 */
export { pickAccountFailoverTarget };

/**
 * Web 控制台的限流自动切号（`.env` 显式开启，默认关闭）。
 *
 * 只处理桌面来源：桥的 `/health.rateLimit` 给出当前账号同一模型最近 10 分钟
 * 的最终 429 次数；达到阈值后按「账号」页顺序切到下一个可用账号。插件来源
 * 不在本功能范围（dsh 插件侧有自己的同名 opt-in）。
 */
const ACCOUNT_FAILOVER_AFTER = config.dashboard.accountFailoverAfter;
let accountFailoverBusy = false;
let lastAccountFailoverAt = 0;

async function maybeAutoSwitchAccount() {
  if (!ACCOUNT_FAILOVER_AFTER || accountFailoverBusy || Date.now() - lastAccountFailoverAt < 60_000) return;
  accountFailoverBusy = true;
  try {
    const health = await bridgeHealth();
    if (!health.running || !health.ok) return;
    const signal = failoverSignal(health.body, ACCOUNT_FAILOVER_AFTER);
    if (!signal) return;
    lastAccountFailoverAt = Date.now();
    const listed = await listAccounts();
    const target = pickAccountFailoverTarget(listed.accounts, health.body?.auth?.userId || '');
    if (!target) {
      console.warn(`账号自动切换跳过：没有其它可用账号（${signal.model || '?'} 已限流 ${signal.count} 次）`);
      return;
    }
    const result = await switchDesktopAccount(target.name);
    if (!result.switched) {
      console.warn(`账号自动切换失败：${result.error || '未知原因'}`);
      return;
    }
    console.log(`上游限流 ${signal.count} 次（${signal.model || '?'}），已自动切换账号 -> ${target.name}`);
  } catch (error) {
    console.warn(`账号自动切换失败：${error?.message || error}`);
  } finally {
    accountFailoverBusy = false;
  }
}

function startAccountFailoverWatchdog() {
  if (!ACCOUNT_FAILOVER_AFTER) return;
  const timer = setInterval(() => { void maybeAutoSwitchAccount(); }, 10_000);
  timer.unref?.();
  console.log(`限流自动切号已开启：同一模型 10 分钟内 ${ACCOUNT_FAILOVER_AFTER} 次 429 后切换桌面账号`);
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
  // stopBridge 现在会先做归属校验（发一次 /health），所以是异步的。
  const result = await stopBridge(port);
  // stopBridge 已经确认过"端口上没有监听进程"（`stopped:false`）：此时再去
  // 轮询端口纯属浪费 —— 直接原样返回。这条短路同时保证了"桥本来就没跑"时
  // 停止按钮是**立刻**返回的，不会先白等 5 秒。
  if (!result.stopped) return result;

  let freed = false;
  for (let i = 0; i < 20; i += 1) {
    await sleep(250);
    // 三态：null = 确认没监听者（已释放）；undefined = 探测不出来（不能当已释放）
    const pid = await probePortPid(port);
    if (pid === null) { freed = true; break; }
    if (pid === undefined) break; // 未知就别在这儿空等 5 秒，交给下面的兜底与告警
  }
  // POSIX 下 SIGTERM 被忽略时升级为 SIGKILL，否则重启会一直撞在旧进程上
  if (!freed && process.platform !== 'win32') {
    try { process.kill(result.pid, 'SIGKILL'); } catch { /* 已经退出了 */ }
    for (let i = 0; i < 12; i += 1) {
      await sleep(250);
      // 三态：null = 确认没监听者（已释放）；undefined = 探测不出来（不能当已释放）
    const pid = await probePortPid(port);
    if (pid === null) { freed = true; break; }
    if (pid === undefined) break; // 未知就别在这儿空等 5 秒，交给下面的兜底与告警
    }
  }
  return freed ? result : { ...result, warning: `进程未在超时内退出，端口 ${port} 可能仍被占用` };
}

/**
 * 桥生命周期单锁（进程内 Promise 队列）。
 *
 * 停桥 / 起桥是**多步、非原子**的操作（停旧 → 起新 → 等就绪），两个并发调用
 * 会交错：A 停、B 停、A 起、B 起 —— 端口撞车、状态错乱，最坏是"报告成功但
 * 服务的是旧账号"。所有会改变桥进程的入口都必须排队：
 *   /api/account/switch、/api/bridge/start|stop|restart、账号钉住校正、
 *   限流自动切号。
 *
 * 锁只包住 stop/start/写 state，不在这里递归调用自己；任务抛错不影响后续任务
 * （前一个失败时下一个照常执行，否则一次失败会把队列永久卡死）。
 */
let bridgeLifecycleTail = Promise.resolve();
let bridgeLifecycleBusy = 0;
function runBridgeLifecycle(task) {
  bridgeLifecycleBusy += 1;
  // 切号/重启期间算「有活动」：闲置看门狗不能在多步操作中途把控制台关掉。
  if (IDLE_EXIT_MS) lastActivityAt = Date.now();
  const run = bridgeLifecycleTail.then(task, task);
  bridgeLifecycleTail = run
    .finally(() => {
      bridgeLifecycleBusy -= 1;
      if (IDLE_EXIT_MS) lastActivityAt = Date.now();
    })
    .catch(() => {});
  return run;
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
  let body = readFileSync(full);
  /*
   * 首页注入构建指纹。旧进程的页面没有这个标记（或标记不同），插件据此
   * 判断 8792 上的是不是当前代码，并在升级后自动重启控制台。
   */
  if (rel === 'index.html') {
    const build = consoleBuild();
    if (build) {
      body = Buffer.from(body.toString('utf8').replace('__WB_BUILD__', build), 'utf8');
    }
  }
  res.end(body);
}

// ── 路由 ────────────────────────────────────────────────────────────────

/**
 * 归一化「要接入哪些模型」这个入参：数组或逗号分隔串都收。
 *
 * 查询串里用逗号串（少一层序列化）、POST 体里用数组，两种都得认 ——
 * 各写一套解析必然漂移，而"少勾了一个模型"这种错用户很难发现。
 */
function normalizeModelList(value) {
  if (Array.isArray(value)) return value.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim());
  if (typeof value === 'string' && value.trim()) return value.split(',').map((s) => s.trim()).filter(Boolean);
  return null;
}

// 「一键接入」的上下文构造（桥地址、令牌、模型清单、各客户端默认模型）已收口到
// `lib/client-connect.mjs` 的 buildConnectBase / contextForClient —— 命令行
// `tools/connect.mjs` 与本控制台共用同一份口径，两边不会各写一套而漂移。

/**
 * 闲置自动退出：控制台常驻 80+MB，但多数时间没人看数据。
 *
 * 只对**插件拉起**的控制台开启（插件注入 `DASHBOARD_IDLE_EXIT_MS`；手动
 * `node dashboard/server.mjs` 不设就不退出，行为与以前一致）。计活动只看
 * 页面/数据请求：插件每 20 秒探活打的 `/` 与 `/api/version` 不算，否则永远
 * 等不到闲置。页面打开后每 2 秒的 `/api/identity` 轮询会持续保活；SSE
 * 长连接在途时也不退出（activeRequests > 0）。
 */
const IDLE_EXIT_MS = config.dashboard.idleExitMs;
const IDLE_PROBE_ROUTES = new Set(['/', '/api/version']);
let lastActivityAt = Date.now();
let activeRequests = 0;

function touchConsoleActivity(route) {
  if (!IDLE_EXIT_MS || IDLE_PROBE_ROUTES.has(route)) return;
  lastActivityAt = Date.now();
}

function shutdownForIdle(idleForMs) {
  console.log(`控制台已闲置 ${Math.max(1, Math.round(idleForMs / 60_000))} 分钟，自动退出（下次由插件按需拉起）`);
  try { server.close(() => process.exit(0)); } catch { process.exit(0); }
  // 没有在途请求（activeRequests === 0）才会走到这里：keep-alive 连接可直接断开
  server.closeIdleConnections?.();
  server.closeAllConnections?.();
  // 兜底：个别平台 close 回调仍可能不触发
  const force = setTimeout(() => process.exit(0), 3000);
  force.unref?.();
}

function startIdleExitWatchdog() {
  if (!IDLE_EXIT_MS) return;
  const tick = Math.min(60_000, Math.max(1000, Math.floor(IDLE_EXIT_MS / 4)));
  const timer = setInterval(() => {
    if (activeRequests > 0) return;
    // 切号 / 重启桥是多步操作：中途退出会让桥停在半路（甚至停着不再拉起）。
    if (bridgeLifecycleBusy > 0) return;
    const idleFor = Date.now() - lastActivityAt;
    if (idleFor < IDLE_EXIT_MS) return;
    clearInterval(timer);
    shutdownForIdle(idleFor);
  }, tick);
  timer.unref?.();
}

const server = createServer(async (req, res) => {
  activeRequests += 1;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    activeRequests -= 1;
  };
  res.once('close', release);
  const url = new URL(req.url, config.dashboard.url);
  const route = url.pathname;

  try {
    // 跨站来源一律拒（DNS rebinding 的防线，见 originAllowed 的说明）。
    // 放在最前面：无论读还是写、无论路由存不存在，跨站形状的请求都进不来。
    if (!originAllowed(req)) {
      return sendJson(res, 403, { ok: false, error: 'cross-origin request rejected (this console serves local clients only)' });
    }
    /*
     * 只有**通过来源校验**的请求才算活动。原先放在 origin 检查之前：任意网页
     * 只要能让浏览器发几个被 403 的跨站请求，就能无限延后闲置退出
     * （控制台白白常驻 80+MB，而用户根本没在用）。
     */
    touchConsoleActivity(route);

    /**
     * 写操作的准入检查：必须带 `x-workbuddy-panel: 1`。
     *
     * 为什么需要：控制台是"浏览器里任何网页都打得通的本地 HTTP 服务"。跨站的
     * **简单请求**（POST + 简单 Content-Type）浏览器不做预检、直接发出，恶意页面
     * 可以在用户不知情的情况下触发停桥 / 切账号 / 写 dsh 配置 / 消耗额度 ——
     * 响应它读不到，但副作用已经发生（实测：外部页面 POST /api/checkin/settings
     * 真的改动了 .state.json）。要求一个自定义头会强制 CORS 预检，而本服务不解答
     * 预检 → 跨站请求根本发不出来。与插件侧数据面（lib/routes.mjs）同一套做法。
     */
    const panelHeader = req.headers['x-workbuddy-panel'] === '1';
    const isRead = req.method === 'GET' || req.method === 'HEAD';
    /**
     * 读接口里也有需要这道门槛的（审计 R2 / R4，2026-10-10）：
     *
     *   1. **会回令牌的** —— `/api/connect`（面板要显示与复制令牌）、
     *      `/api/clients`（复制片段那一页）。控制台本身没有身份认证，而 Windows 上
     *      127.0.0.1 **不按用户隔离**：同机任何用户/进程一句 curl 就能拿到令牌，
     *      再拿去调桥、消耗账号额度。`Origin` 白名单挡的是浏览器，挡不住本机进程。
     *   2. **会真的干活的** —— `/api/diagnose`（跑一轮诊断）、
     *      `/api/models?refresh=1`（强制桥去上游重取目录）。浏览器发
     *      `<img src="http://127.0.0.1:8792/…">` 时**不带 Origin**，而
     *      `originAllowed` 对无 Origin 的请求是放行的 → 任意网页都能反复触发它们。
     *
     * 代价（写出来，别让人踩）：命令行/脚本调这几个接口要自己加
     * `-H "x-workbuddy-panel: 1"`。控制台页面走 `api()` 封装，**每个请求都带**这个头，
     * 所以界面不受影响。
     */
    /*
     * `/api/accounts` 读的是本机账号列表（uid/路径），且钉住状态过期时会
     * **写 .state.json 并重启桥** —— 属于"会真的干活"的读接口。无 Origin 的
     * 浏览器请求（`<img>`）带不上自定义头，必须和 diagnose 一样挡在这里。
     */
    const PANEL_ONLY_GET = new Set(['/api/connect', '/api/clients', '/api/diagnose', '/api/accounts']);
    const needsPanel = !isRead
      || PANEL_ONLY_GET.has(route)
      || (route === '/api/models' && url.searchParams.get('refresh') === '1');
    if (needsPanel && !panelHeader) {
      return sendJson(res, 403, {
        ok: false,
        error: 'missing x-workbuddy-panel header',
        hint: '这个接口会回令牌或触发真实动作，需要带自定义头 x-workbuddy-panel: 1（控制台页面会自动带）。',
      });
    }

    /*
     * 控制台自述版本/构建 —— 插件用它判断 8792 上的进程是不是当前代码。
     * 只读且不含任何凭据；旧版本没有这个路由（404），插件按“旧构建”处理。
     */
    if (route === '/api/version' && (req.method === 'GET' || req.method === 'HEAD')) {
      return sendJson(res, 200, {
        ok: true,
        version: consoleVersion(),
        build: consoleBuild(),
        pid: process.pid,
        startedAt: new Date(STARTED_AT).toISOString(),
      });
    }

    /*
     * 轻量身份端点：浏览器每 2 秒问一次「桥现在服务谁」，账号/构建一变就
     * 立刻重拉概览、账号与模型目录。不能等 20/60/120 秒的整页轮询 ——
     * 切号后页面必须当场换成新账号，而不是把上一个账号的余额继续摆着。
     */
    if (route === '/api/identity' && (req.method === 'GET' || req.method === 'HEAD')) {
      const identity = await bridgeIdentity(4000);
      return sendJson(res, 200, identity
        ? { ok: true, ...identity }
        : { ok: false, error: 'bridge identity unavailable' });
    }

    if (route === '/api/overview') {      // 只包含页面真正使用的字段：**不带** model 目录（另有 /api/models），
      // 桥冷启动时抓目录要串行打两个上游端点，不能让徽章陪着一起等。
      /*
       * 先取 /health（本地、毫秒级），再让积分按**桥当前账号**取。
       * 顺序不能反过来：桌面端换号后，桥的账号是唯一权威；拿 `effectiveAuthFile`
       * （.state.json 里的钉住文件）去配积分会出现「账号新、余额旧」（issue #6）。
       */
      const health = await bridgeHealth();
      const bridgeAccount = health.body?.auth?.userId || '';
      const bridgePid = Number(health.body?.pid) || 0;
      if (bridgePid && bridgePid !== lastBridgePid) {
        if (lastBridgePid) invalidateQuotaCache();
        lastBridgePid = bridgePid;
      }
      let creds = await credentialStatus();
      /*
       * 钉住状态过期：桥已经跟随桌面换号（来源=desktop），或来源是插件
       * 但桌面登录文件已经换了人 —— 两种情况下 `.state.json` 里的旧快照
       * 都不该继续当作“当前桌面账号”展示。按「桌面 UID|生效文件 UID」做
       * 一次性校正，避免用户主动钉住不同快照时每轮都启动客户端取密钥。
       */
      const desktopUid = health.body?.credential?.desktopUserId || '';
      const pinReconcileKey = `${desktopUid}|${creds.active?.userId || ''}`;
      const pinLooksStale = Boolean(health.running && creds.active?.userId && (
        (health.body?.auth?.source === 'desktop'
          && bridgeAccount && creds.active.userId !== bridgeAccount)
        || (health.body?.auth?.source === 'plugin'
          && desktopUid && desktopUid !== creds.active.userId)
      ));
      if (pinLooksStale && pinReconcileKey !== lastPinReconcileKey) {
        lastPinReconcileKey = pinReconcileKey;
        try {
          const pin = await reconcileAccountPin();
          if (pin.changed) {
            await applyAccountPinCorrection(pin);
            creds = await credentialStatus();
          }
        } catch (err) {
          console.warn(`概览校正账号钉住失败：${err.message}`);
        }
      }
      // 积分在账号校正之后再取：即使桥刚被重启，也拿当前这个账号的余额。
      const quota = await bridgeQuota({ expectedAccount: bridgeAccount });
      const expectedBuild = fileBuildHash(config.paths.bridgeScript);
      const runningBuild = health.body?.build || '';
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
          // 桥**实际生效**的账号与来源。页面必须用它来显示「账号」，
          // 不能拿桌面登录文件代替（来源可能是 plugin，二者会不同）。
          auth: health.body?.auth || null,
          credentialSource: health.body?.credential?.source || health.body?.auth?.source || '',
          desktopUserId: health.body?.credential?.desktopUserId || '',
          build: runningBuild,
          expectedBuild,
          // 空 build = 旧桥（没有这个字段）；与本地脚本不一致 = 升级后旧进程还在跑
          staleBuild: !!(expectedBuild && runningBuild !== expectedBuild),
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
        console: { version: consoleVersion(), build: consoleBuild(), pid: process.pid, node: process.version },
        credentials: creds,
        quota,
        dsh: {
          settingsExists: dsh.settingsExists,
          settingsHasRoute: dsh.settingsHasRoute,
          patchHasRoute: dsh.patchHasRoute,
          routeLive: dsh.routeLive,
          routeSource: dsh.routeSource,
          // native = 插件在 dsh 运行时注册的 provider；控制台拿不到运行时信号，
          // 只能按 profile 配置判定（见 lib/dsh.mjs 的 detectNativeRoute）
          routeMode: dsh.routeMode,
          nativeRoute: dsh.nativeRoute,
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
          // 模型**上限**（与默认档 context_window 是两回事）：Claude Code 不读
          // /v1/models，它的窗口只能靠 CLAUDE_CODE_MAX_CONTEXT_TOKENS 告诉，
          // 给默认档就等于告诉它"你只有 300K"。
          contextMax: Math.max(
            Number(m.context_window_max) || 0,
            ...(Array.isArray(m.context_window_options) ? m.context_window_options.map(Number) : []),
            Number(m.context_window) || 0,
          ),
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
        /**
         * Responses 层（Codex）的模型映射，同样如实展示 —— 用户在 Codex 里配的是
         * `gpt-5.1-codex`、实际跑的是 glm-5.3，不说清楚他会以为桥选错了模型。
         */
        responsesModel: config.bridge.responsesModel,
        responsesFastModel: config.bridge.responsesFastModel,
        models: details.map((m) => m.id),
        modelDetails: details,
      });
      return;
    }

    if (route === '/api/diagnose') {
      sendJson(res, 200, await diagnose());
      return;
    }

    /*
     * ── 一键接入 ────────────────────────────────────────────────────────
     *
     * 把 Base URL 与令牌**写进**客户端的配置文件（`lib/client-connect.mjs`）。
     * 这是控制台里少见的"会动到仓库之外的文件"的接口，所以：
     *   - 全部走 POST（写操作准入检查已经要求 `x-workbuddy-panel: 1`）；
     *   - 真正动手之前，界面会先用 GET 拿到「将要改成什么样」给用户确认；
     *   - 每次写入都先整份备份，撤销按记录逐键还原（不是拿备份整份盖回去）。
     */
    if (route === '/api/connect' && req.method === 'GET') {
      const base = await buildConnectBase();
      /*
       * 每个客户端可带 `?model.<id>=<模型>` 覆盖默认；预览与写入用同一次派生，
       * 守住 planClient 注释里的「所见即所写」。非法 id 只让该项报错，不牵连其余。
       *
       * 没带参数时**不是**直接用桥的默认，而是先认配置文件里现在写着的那个模型
       * （`resolveModelChoice`）：模型是用户的选择，重新打开页面就把它当漂移、
       * 报一句「需重新写入」，等于界面在制造一件不存在的事，还会顺手覆盖掉它。
       */
      const planOne = (c) => {
        const raw = url.searchParams.get(`model.${c.id}`);
        const explicit = typeof raw === 'string' && raw.trim() ? raw.trim() : null;
        const chosen = resolveModelChoice(base, c, explicit);
        /**
         * 模型**集合**：`?models.<id>=a,b,c`。没给就认配置文件里现在声明的那批
         * （`resolveSelection`），同样是为了不把用户自己的选择当成"漂移"。
         */
        const rawList = url.searchParams.get(`models.${c.id}`);
        const explicitList = normalizeModelList(rawList);
        const selection = resolveSelection(base, c, explicitList);
        const bad = assertModelKnown(chosen, base) || assertModelsKnown(selection, base);
        const ctx = contextForClient(base, c.id, bad ? null : chosen, bad ? null : selection);
        const plan = planClient(c.id, ctx);
        return bad
          ? { ...plan, error: bad, changes: [], effectiveModel: null }
          : { ...plan, effectiveModel: ctx.model, effectiveModels: ctx.models.map((m) => m.id) };
      };
      /*
       * 行 = 真正的客户端。**Codex 的 profile 通道不作为独立一行** ——
       * 它和"改基础配置"是同一个决策的两个选项，所以挂在 Codex 那一行的详情里。
       * 状态要单独算一次：它有自己的文件、自己的记录（见 CONNECT_CLIENTS 的说明）。
       */
      const clients = CONNECT_CLIENTS.filter((c) => !c.profileFor).map(planOne);
      const codexRow = clients.find((c) => c.id === 'codex');
      const profileDef = CONNECT_CLIENTS.find((c) => c.profileFor === 'codex');
      if (codexRow && profileDef) {
        const p = planOne(profileDef);
        codexRow.profile = {
          id: profileDef.id,
          label: profileDef.label,
          path: p.path,
          exists: p.exists,
          applied: p.applied,
          changed: p.changed,
          canSwitchBack: p.canSwitchBack,
          error: p.error || null,
          catalogSkipped: p.catalogSkipped || null,
          /** 用户要照着敲的那一句 —— 界面直接显示它，别让他自己拼 */
          launch: `codex -p ${profileDef.profileName}`,
          /**
           * **桌面应用不接受命令行开关**（`-p` / `-c` 都是 CLI 的参数），
           * 这条必须让用户知道，否则他会以为 profile 对 app 也生效。
           */
          appSupported: false,
        };
      }
      sendJson(res, 200, {
        clients,
        /** 配置里该出现的值，供界面在出错时对照 */
        token: base.token,
        baseUrlOpenAI: base.baseUrlOpenAI,
        baseUrlAnthropic: base.baseUrlAnthropic,
        model: base.defaultModel,
        /** 界面模型下拉的候选（完整目录，桥没起时退回精选集） */
        modelOptions: modelOptions(base),
        /**
         * 目录是不是"上次抓到的"（桥没起时的兜底校验用，审计 R5）。
         * 界面据此把话说全：候选可能已过期，**不能**保证那些模型现在还存在。
         */
        catalogStale: base.catalogStale === true,
        catalogAt: base.catalogAt || null,
        running: base.running,
        /**
         * 桥的进程级状态：`up` 有人应答、`authRejected` 回的是 401（两边令牌不一致）。
         * 界面据此把「桥未运行」与「桥在跑但令牌被拒」分开说 —— 这两种情况的处置
         * 完全不同（启动桥 / 重启桥），含糊成一句会让用户按错的按钮。
         */
        bridge: base.bridge,
        /** 备份落在哪个目录（界面要如实告诉用户去哪找） */
        backupDir: resolveBackupRoot(),
      });
      return;
    }

    if (route === '/api/connect/apply' && req.method === 'POST') {
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch (err) {
        if (err.code === 'BODY_TOO_LARGE') return bodyTooLarge(req, res);
        return sendJson(res, 400, { ok: false, error: `请求体不是合法 JSON：${err.message}` });
      }
      const id = String(body?.client || '');
      if (!findClient(id)) return sendJson(res, 400, { ok: false, error: `不认识的客户端：${id}` });
      const rawModel = typeof body?.model === 'string' && body.model.trim() ? body.model.trim() : null;
      const base = await buildConnectBase();
      const client = findClient(id);
      // 没显式选就沿用文件里那个模型 / 那批模型：否则「重新写入」会把用户自己的选择改掉
      const chosen = resolveModelChoice(base, client, rawModel);
      const selection = resolveSelection(base, client, normalizeModelList(body?.models));
      const bad = assertModelKnown(chosen, base) || assertModelsKnown(selection, base);
      if (bad) return sendJson(res, 400, { ok: false, error: bad });
      const context = contextForClient(base, id, chosen, selection);
      const result = applyClient(id, context);
      /**
       * 端到端验证：拿**刚写进文件里**的令牌真的打一次桥。
       *
       * 静态读回只能证明"文件里写对了"；这一步才能证明"这个令牌真的能用"
       * ——比如桥重启后换了新令牌而旧文件没更新，静态读回是发现不了的。
       * 失败不影响写入结果，如实回报即可。
       */
      if (result.changed) {
        result.auth = await verifyAgainstBridge(findClient(id), {
          baseUrl: context.baseUrlOpenAI, tokenOverride: context.token, model: context.model,
        });
      }
      sendJson(res, result.ok ? 200 : 400, result);
      return;
    }

    /*
     * ── 模式切换：走桥 / 走客户端自己的模型 ──────────────────────────────
     *
     * 与「撤销」的区别（用户最容易问的一点）：
     *   - 撤销 = **拆掉**：记录改名归档、我们建的目录文件删掉，再想用桥得重新接入；
     *   - 切模式 = **换挡**：记录与目录都留着（只是不再被引用），随时一键切回来。
     *
     * 切回原始模型**不需要网络也不需要令牌** —— 它只把我们接管过的键按记录还原；
     * 切回桥则一定要重新取令牌（可能已轮换），所以走 `buildConnectBase()`。
     */
    if (route === '/api/connect/mode' && req.method === 'POST') {
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch (err) {
        if (err.code === 'BODY_TOO_LARGE') return bodyTooLarge(req, res);
        return sendJson(res, 400, { ok: false, error: `请求体不是合法 JSON：${err.message}` });
      }
      const id = String(body?.client || '');
      if (!findClient(id)) return sendJson(res, 400, { ok: false, error: `不认识的客户端：${id}` });
      const raw = body?.mode;
      const target = raw === 'native' || raw === 'bridge' ? raw : null;
      if (!target) return sendJson(res, 400, { ok: false, error: `不认识的目标模式：${String(raw)}（只能是 native / bridge）` });

      if (target === 'native') {
        const result = switchClientMode(id, 'native');
        sendJson(res, result.ok ? 200 : 400, result);
        return;
      }

      /*
       * 切回桥：模型集合优先用**记录里上次接的那批**（用户不必重新勾一遍），
       * 显式传了就以显式为准。令牌一律重新取。
       */
      const base = await buildConnectBase();
      const client = findClient(id);
      const rec = recordedConnect(id);
      const rawModel = typeof body?.model === 'string' && body.model.trim() ? body.model.trim() : null;
      const explicitModels = normalizeModelList(body?.models);
      const chosen = resolveModelChoice(base, client, rawModel || rec.model);
      const selection = resolveSelection(base, client, explicitModels || rec.models);
      const bad = assertModelKnown(chosen, base) || assertModelsKnown(selection, base);
      if (bad) return sendJson(res, 400, { ok: false, error: bad });
      const context = contextForClient(base, id, chosen, selection);
      const result = switchClientMode(id, 'bridge', context);
      if (result.ok && result.changed) {
        result.auth = await verifyAgainstBridge(findClient(id), {
          baseUrl: context.baseUrlOpenAI, tokenOverride: context.token, model: context.model,
        });
      }
      sendJson(res, result.ok ? 200 : 400, result);
      return;
    }

    if (route === '/api/connect/undo' && req.method === 'POST') {
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch (err) {
        if (err.code === 'BODY_TOO_LARGE') return bodyTooLarge(req, res);
        return sendJson(res, 400, { ok: false, error: `请求体不是合法 JSON：${err.message}` });
      }
      const id = String(body?.client || '');
      if (!findClient(id)) return sendJson(res, 400, { ok: false, error: `不认识的客户端：${id}` });
      const result = undoClient(id);
      sendJson(res, result.ok ? 200 : 400, result);
      return;
    }

    if (route === '/api/connect/verify' && req.method === 'POST') {
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch (err) {
        if (err.code === 'BODY_TOO_LARGE') return bodyTooLarge(req, res);
        return sendJson(res, 400, { ok: false, error: `请求体不是合法 JSON：${err.message}` });
      }
      const id = String(body?.client || '');
      const client = findClient(id);
      if (!client) return sendJson(res, 400, { ok: false, error: `不认识的客户端：${id}` });
      const rawModel = typeof body?.model === 'string' && body.model.trim() ? body.model.trim() : null;
      const base = await buildConnectBase();
      // 验证要用与写入同一个模型 / 同一批模型：否则静态读回会拿别的集合去比，报出假的"未通过"
      const chosen = resolveModelChoice(base, client, rawModel);
      const selection = resolveSelection(base, client, normalizeModelList(body?.models));
      const bad = assertModelKnown(chosen, base) || assertModelsKnown(selection, base);
      if (bad) return sendJson(res, 400, { ok: false, error: bad });
      const context = contextForClient(base, id, chosen, selection);
      const written = verifyWritten(client, context);
      const auth = written.ok
        ? await verifyAgainstBridge(client, { baseUrl: context.baseUrlOpenAI, tokenOverride: context.token, model: context.model })
        : null;
      sendJson(res, 200, { ok: written.ok && (auth?.ok ?? false), written, auth });
      return;
    }

    if (route === '/api/bridge/start' && req.method === 'POST') {
      const result = await runBridgeLifecycle(() => startBridgeAndWait());
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
        const result = await runBridgeLifecycle(() => stopBridgeAndWait());
        if (!ac.signal.aborted) sendJson(res, 200, result);
      } finally {
        res.off('close', onClientClose);
      }
      return;
    }

    if (route === '/api/bridge/restart' && req.method === 'POST') {
      const result = await runBridgeLifecycle(async () => {
        const wasRunning = (await bridgeHealth()).running;
        if (wasRunning) await stopBridgeAndWait();
        const started = await startBridgeAndWait();
        return { ...started, wasRunning };
      });
      sendJson(res, result.started ? 200 : 400, result);
      return;
    }

    // 模型目录单独成接口（与 /api/overview 解耦）：冷启动时桥要串行抓两个
    // 上游端点，这里可以慢慢等，页面先用占位。
    if (route === '/api/models') {
      // refresh=1 透传给桥（强制重取上游）；失败时桥会带回 staleMs，
      // 页面据此提示「仍显示 HH:MM 的缓存」，而不是假装刷新成功。
      const refresh = url.searchParams.get('refresh') === '1';
      const [result, modelsDefault] = await Promise.all([
        bridgeModels(25000, refresh),
        bridgeModelsDefault(),
      ]);
      sendJson(res, 200, {
        models: result.models,
        // 「客户端一键拉取会看到几个」的当前设置：面板顶部那一行据此渲染。
        // 桥没起来时它是 null（页面据此隐藏那一行，而不是显示一个假的默认值）。
        modelsDefault,
        ...(result.staleMs !== null ? { staleMs: result.staleMs } : {}),
        ...(result.error ? { error: result.error } : {}),
      });
      return;
    }

    /*
     * 「桥默认返回几个模型」的读写。
     *
     * 为什么不是写 `.env`：`.env` 是**部署级**配置、改了要重启桥；而这是
     * 「我现在想让客户端都看到全量」这种随手调整，放在桥的数据目录里能立刻
     * 生效。桥侧是唯一真源（它自己解析、自己校验），这里只做转发 + 超时兜底。
     */
    if (route === '/api/models/default' && req.method === 'GET') {
      sendJson(res, 200, { ok: true, modelsDefault: await bridgeModelsDefault() });
      return;
    }

    if (route === '/api/models/default' && req.method === 'POST') {
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch (err) {
        if (err.code === 'BODY_TOO_LARGE') return bodyTooLarge(req, res);
        return sendJson(res, 400, { ok: false, error: `请求体不是合法 JSON：${err.message}` });
      }
      try {
        /*
         * 原样转发两种形状（`{ value }` / `{ ids }`），**不要在这里挑字段**。
         *
         * 踩过的坑：这里曾写成 `body?.value ?? null`，于是面板提交的
         * `{ ids: [...] }` 被丢掉变成 `{ value: null }` —— 效果是"清空偏好"，
         * 用户勾选完点保存，客户端清单直接跳回精选 3 个。
         * 语义由桥侧判定，转发层只负责透传。
         */
        const payload = {};
        if (Array.isArray(body?.ids)) payload.ids = body.ids;
        if (body?.value !== undefined) payload.value = body.value;
        if (!payload.ids && payload.value === undefined) payload.value = null;
        const saved = await bridgeSaveModelsDefault(payload);
        sendJson(res, 200, saved);
      } catch (err) {
        // 桥的 400（不认识的取值）要原样带回，页面据此提示；500 同理。
        sendJson(res, err.status || 502, { ok: false, error: String(err.message || err) });
      }
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
      /*
       * 先校正"钉住的快照 vs 桌面端当前账号"：用户在 WorkBuddy 客户端里换号后，
       * 这里解除旧钉住并让桥跟着桌面走（issue #6）。列表随后再读，active 标记
       * 才是当前真实生效的那份文件。
       */
      const pin = await reconcileAccountPin();
      const correction = await applyAccountPinCorrection(pin);
      sendJson(res, 200, {
        ...(await listAccounts()),
        pin: {
          followedDesktop: pin.changed === true,
          reason: pin.reason || '',
          restarted: correction.restarted === true,
          error: correction.error || null,
        },
      });
      return;
    }

    // ── 插件登录（第二条凭据来源）─────────────────────────────────────
    // 与插件面板走同一套桥端点；响应里不含任何令牌。
    if (route === '/api/login' && req.method === 'GET') {
      try {
        const [source, creds] = await Promise.all([bridgeAuthSource(), bridgeAuthCredentials()]);
        sendJson(res, 200, {
          ok: true,
          ...source,
          configuredSource: creds.configuredSource,
          credentials: Array.isArray(creds.credentials) ? creds.credentials : [],
        });
      } catch (err) {
        sendJson(res, 200, { ok: false, error: String(err?.message || err), credentials: [] });
      }
      return;
    }

    if (route === '/api/login/start' && req.method === 'POST') {
      try {
        const body = JSON.parse(await readBody(req));
        const started = await bridgeDeviceStart(
          body?.region === 'global' ? 'global' : 'cn',
          { open: body?.open === true },
        );
        sendJson(res, 200, { ok: true, ...started });
      } catch (err) {
        sendJson(res, 200, { ok: false, error: String(err?.message || err) });
      }
      return;
    }

    if (route === '/api/login/poll' && req.method === 'POST') {
      try {
        const body = JSON.parse(await readBody(req));
        if (!body?.state) return sendJson(res, 400, { ok: false, error: 'state is required' });
        const result = await bridgeDevicePoll(String(body.state));
        if (result?.status === 'ready') invalidateQuotaCache();
        sendJson(res, 200, result);
      } catch (err) {
        sendJson(res, 200, { ok: false, error: String(err?.message || err) });
      }
      return;
    }

    if (route === '/api/login/cancel' && req.method === 'POST') {
      try {
        const body = JSON.parse(await readBody(req));
        sendJson(res, 200, { ok: true, ...(await bridgeDeviceCancel(String(body?.state || ''))) });
      } catch (err) {
        sendJson(res, 200, { ok: false, error: String(err?.message || err) });
      }
      return;
    }

    if (route === '/api/login/active' && req.method === 'POST') {
      try {
        const body = JSON.parse(await readBody(req));
        if (!body?.uid) return sendJson(res, 400, { ok: false, error: 'uid is required' });
        const result = await bridgeAuthActive(String(body.uid));
        invalidateQuotaCache();
        sendJson(res, 200, { ok: true, ...result });
      } catch (err) {
        sendJson(res, 200, { ok: false, error: String(err?.message || err) });
      }
      return;
    }

    if (route === '/api/login/logout' && req.method === 'POST') {
      try {
        const body = JSON.parse(await readBody(req));
        if (!body?.uid) return sendJson(res, 400, { ok: false, error: 'uid is required' });
        const result = await bridgeAuthLogout(String(body.uid));
        invalidateQuotaCache();
        sendJson(res, 200, { ok: true, ...result });
      } catch (err) {
        sendJson(res, 200, { ok: false, error: String(err?.message || err) });
      }
      return;
    }

    if (route === '/api/login/source' && req.method === 'POST') {
      try {
        const body = JSON.parse(await readBody(req));
        const result = await bridgeSetAuthSource(String(body?.source || 'auto'));
        invalidateQuotaCache();
        sendJson(res, 200, { ok: true, ...result });
      } catch (err) {
        sendJson(res, 200, { ok: false, error: String(err?.message || err) });
      }
      return;
    }

    if (route === '/api/account/switch' && req.method === 'POST') {
      try {
        const { file } = JSON.parse(await readBody(req));
        if (typeof file !== 'string' || !file) throw new Error('缺少 file');

        /*
         * 用**未折叠**的登录文件列表校验：列表页已经一个账号一行，但版本错配时
         * （旧插件/旧页面还在跑）它可能传来同一账号里被合并掉的那份快照文件名 ——
         * 那也是一份真实存在的登录文件，切过去同样有效，不该报"未知账号"。
         *
         * 状态码跟着真实结果走：失败回 500 且 `switched:false`。原先无条件
         * `switched:true` + 200，面板与插件都会把失败当成功（issue #17 审计）。
         */
        const result = await switchDesktopAccount(file);
        sendJson(res, result.switched ? 200 : 500, result);
      } catch (err) {
        if (err.code === 'BODY_TOO_LARGE') return bodyTooLarge(req, res);
        sendJson(res, 400, { switched: false, error: err.message });
      }
      return;
    }

    /*
     * 给账号起个自定义名字（**只影响显示**，不碰任何凭据文件）。
     *
     * `file` 用登录文件名，与 `/api/account/switch` 同一套校验：必须是列举结果里的
     * 那一个，避免构造任意路径。**键由服务端现读文件决定**（uin → userId → 文件名）——
     * 让客户端传键，就等于让它决定"这个名字属于哪个账号"，换号后会贴错。
     */
    if (route === '/api/account/alias' && req.method === 'POST') {
      try {
        const { file, alias } = JSON.parse(await readBody(req));
        if (typeof file !== 'string' || !file) throw new Error('缺少 file');
        if (alias !== undefined && alias !== null && typeof alias !== 'string') {
          throw new Error('alias 必须是字符串（留空 = 恢复默认显示）');
        }
        // alias 也按**未折叠**列表校验：旧页面可能拿着被合并掉的那份快照文件名来改名，
        // 键由服务端现读该文件决定（同一账号自然得到同一个键），结果是对的。
        const listed = await listAccountFiles();
        const hit = listed.accounts.find((a) => a.name === file);
        if (!hit) throw new Error(`未知账号：${file}`);
        if (!hit.aliasKey) throw new Error('这个账号读不出标识（uin），无法命名');
        const accountAliases = writeAccountAlias(hit.aliasKey, alias ?? '');
        sendJson(res, 200, {
          ok: true,
          key: hit.aliasKey,
          alias: accountAliases[hit.aliasKey] || '',
          accountAliases,
        });
      } catch (err) {
        if (err.code === 'BODY_TOO_LARGE') return bodyTooLarge(req, res);
        sendJson(res, 400, { ok: false, error: err.message });
      }
      return;
    }

    /*
     * 账号列表的自定义顺序（**只影响显示顺序**）。
     *
     * 收的是**整个顺序数组**，不是"把 A 移到 B 前面"这种指令：前端手里就有完整列表，
     * 直接给结果，两边不会因为各算一套插入规则而对不上。服务端只接受**列举结果里
     * 真实存在**的文件名，其余丢弃 —— 不让这个接口变成往 `.state.json` 里塞任意字符串的口子。
     */
    if (route === '/api/account/order' && req.method === 'POST') {
      try {
        const { order } = JSON.parse(await readBody(req));
        if (!Array.isArray(order)) throw new Error('order 必须是数组');
        const listed = await listAccounts();
        const known = new Set(listed.accounts.map((a) => a.name));
        const clean = order.filter((f) => typeof f === 'string' && known.has(f));
        sendJson(res, 200, { ok: true, order: writeAccountOrder(clean) });
      } catch (err) {
        if (err.code === 'BODY_TOO_LARGE') return bodyTooLarge(req, res);
        sendJson(res, 400, { ok: false, error: err.message });
      }
      return;
    }

    /*
     * 隐藏 / 恢复一个账号 —— **只写我们自己的 `.state.json`，不碰登录目录里的文件**。
     *
     * 为什么不删文件：那份 `.info` 就是 WorkBuddy 客户端的登录态，我们只是它的读者
     * （见 `docs/SECURITY.md` 的硬约束）。删掉等于把人家的客户端登出，不可逆 ——
     * 不该由一个"整理列表"的按钮触发。隐藏随时可恢复。
     */
    if (route === '/api/account/hidden' && req.method === 'POST') {
      try {
        const { file, hidden } = JSON.parse(await readBody(req));
        if (typeof file !== 'string' || !file) throw new Error('缺少 file');
        if (typeof hidden !== 'boolean') throw new Error('hidden 必须是布尔值');
        const listed = await listAccountFiles();
        const hit = listed.accounts.find((a) => a.name === file);
        if (!hit) throw new Error(`未知账号：${file}`);
        /*
         * **当前生效中的那个不允许隐藏**：它正被桥用来读凭据，藏起来只会让用户在列表里
         * 找不到自己正在用的账号。要停用它得先切到别的账号。
         */
        if (hidden && hit.active) throw new Error('当前生效中的账号不能隐藏，请先切换到别的账号');
        /*
         * 列表是"一个账号一行"（同一号的几份登录文件由 lib/diagnostics.mjs 合并），
         * 但 `.state.json` 里的隐藏清单仍按**登录文件名**记。所以这里把这个账号名下的
         * **全部文件**一起写：否则隐藏后另一份快照仍算"可见"，整行就藏不住。
         */
        const group = listed.accounts
          .filter((a) => (a.aliasKey || a.name) === (hit.aliasKey || hit.name))
          .map((a) => a.name);
        let list = writeAccountHidden(file, hidden);
        for (const name of group) if (name !== file) list = writeAccountHidden(name, hidden);
        sendJson(res, 200, { ok: true, hidden: list, files: group });
      } catch (err) {
        if (err.code === 'BODY_TOO_LARGE') return bodyTooLarge(req, res);
        sendJson(res, 400, { ok: false, error: err.message });
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
  startIdleExitWatchdog();
  startAccountFailoverWatchdog();
  server.listen(config.dashboard.port, config.dashboard.host, async () => {
    console.log(`WorkBuddy 控制台  ->  ${config.dashboard.url}`);
    console.log(`登录文件          ->  ${effectiveAuthFile()}`);

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

    /*
     * 上次钉住的账号快照可能已经过期（用户之后在 WorkBuddy 客户端里换了号）。
     * 先校正，再判断桥是否可复用 —— 否则会 happily 复用旧快照的桥，
     * 表现就是"重启了 dsh Web 还是旧账号"（issue #6）。
     */
    try {
      const pin = await reconcileAccountPin();
      if (pin.changed) {
        await applyAccountPinCorrection(pin);
        console.log(`账号钉住状态已校正（${pin.reason}）-> 跟随桌面端当前账号`);
      }
    } catch (err) {
      console.warn(`账号钉住状态校正失败（不影响启动）：${err.message}`);
    }

    /*
     * 桥若已在跑就直接复用；但从上一个版本升级后，端口上的进程是**旧代码**，
     * 必须按构建指纹重启一次（startBridgeAndWait 内部处理）。
     * 走同一个生命周期队列：启动期间的 HTTP 请求（页面自动刷新）可能也触发
     * 重启，两条路径不能交错。
     */
    const result = await runBridgeLifecycle(() => startBridgeAndWait());
    if (result.started) {
      console.log(`桥地址            ->  ${config.bridge.url}/v1（${result.reused ? '已在运行，复用' : '已就绪'}，PID ${result.pid}）`);
    } else {
      console.log(`桥启动失败        ->  ${result.error || result.warning || '未知原因'}`);
      console.log('可在页面上点「启动桥服务」重试。');
    }
    console.log('仅监听回环地址，Ctrl+C 退出控制台（桥会继续在后台运行）。');
  });
}

if (isMainModule()) startConsoleServer();
