// SPDX-License-Identifier: MIT
/**
 * workbuddy-bridge — expose the locally signed-in CodeBuddy / WorkBuddy desktop
 * session as a local OpenAI-compatible endpoint, for any client that accepts a
 * custom base URL (DeepSeek Harness, Cherry Studio, Open WebUI, ...).
 *
 * How it works (all behaviours verified against the live backend):
 *   - The upstream backend (copilot.tencent.com/v2/chat/completions) already
 *     speaks the OpenAI protocol, so this proxy does NOT translate protocols.
 *     It only injects authentication/tracing headers and guarantees streaming.
 *   - The backend rejects non-streaming requests (400 code 11101), so a
 *     non-streaming client request is converted to streaming upstream and
 *     aggregated back into a single JSON response.
 *   - Auth reuses the desktop session (OAuth access/refresh token) from the
 *     local login file, refreshing it in memory before expiry. The login file
 *     is never rewritten: it holds app-owned at-rest envelopes.
 *   - Compatibility fix: the backend only accepts the `system` role for the
 *     system prompt, while newer OpenAI-spec clients send `developer`. Those
 *     messages are rewritten in place before forwarding.
 *
 * Security boundary: binds 127.0.0.1 only; never logs or persists a token or
 * any conversation content.
 */
import { readFileSync, writeFileSync, appendFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Agent as HttpAgent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDecipheriv, createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

// ── Static constants (values match the desktop app / official extension) ──
const APP_VERSION = '4.9.29177644';
const IDE_VERSION = '1.119.0';
const IDE_NAME = 'VSCode';
const CHAT_PATH = '/v2/chat/completions';
const CONFIG_PATH = '/v3/config';
const REFRESH_SKEW_MS = 5 * 60 * 1000;
const REFRESH_COOLDOWN_MS = 15 * 1000;
const TRANSIENT_400_DELAYS = [1000, 4000, 10000, 25000];
const UPSTREAM_TIMEOUT_MS = Number(process.env.WORKBUDDY_TIMEOUT_MS || 0); // 0 = unlimited (long answers need it)

// ── Upstream keep-alive connection pool ────────────────────────────────────
// 为什么要自己管连接：Node 全局 fetch（undici）的空闲连接只保留 ~4 秒。写代码
// 的间隙一过，下一次请求就要重付一遍 DNS + TLS 握手（实测 ~150ms，温连接 ~82ms）。
// 用 http/https 的 keep-alive Agent：空闲连接保留 5 分钟，跨请求复用同一条
// TLS 会话，「首 token 延迟」稳定砍掉一大截。测试桩走纯 HTTP，所以两套都要。
const KEEPALIVE_MS = Number(process.env.WORKBUDDY_KEEPALIVE_MS || 300_000); // 5 min, 0 = off
const httpAgent = new HttpAgent({ keepAlive: KEEPALIVE_MS > 0, keepAliveMsecs: Math.max(1000, KEEPALIVE_MS), maxSockets: 8, scheduling: 'lifo' });
const httpsAgent = new HttpsAgent({
  keepAlive: KEEPALIVE_MS > 0,
  keepAliveMsecs: Math.max(1000, KEEPALIVE_MS),
  maxSockets: 8,
  scheduling: 'lifo',
  // 刻意**不设** socket timeout：LLM 流式回答中间可能有几十秒的 reasoning 停顿，
  // 空闲超时会在流中间掐断长回答。死连接靠 sendWithRetry 的 reusedSocket 重试兜底。
});
const agentFor = (endpoint) => (String(endpoint).startsWith('https:') ? httpsAgent : httpAgent);

const PORT = Number(process.env.WORKBUDDY_PORT || 8790);
const HOST = process.env.WORKBUDDY_HOST || '127.0.0.1';
const LOCAL_TOKEN = process.env.WORKBUDDY_LOCAL_TOKEN || ''; // optional: require a token on the local port
const EXPLICIT_ENDPOINT = process.env.CODEBUDDY_ENDPOINT || '';
const API_KEY = process.env.CODEBUDDY_API_KEY || '';
/**
 * 每日自动签到（R11.2）。默认**开** —— 用户的诉求就是「别让我记着」。
 * 独立启动的桥也签（不依赖控制台在不在）。`WORKBUDDY_AUTO_CHECKIN=0` 关闭。
 */
const AUTO_CHECKIN_ENABLED = process.env.WORKBUDDY_AUTO_CHECKIN !== '0';
const LOG = process.env.WORKBUDDY_LOG === '1';
/** 进程启动时刻，供 /health 汇报运行时长。 */
const STARTED_AT = Date.now();

// Curated models exposed by default; others remain reachable via /v1/models?all=1
// 兜底的精选模型定义。倍率优先取上游的 credits（形如 "x0.11"），
// 这里的数值取自上游实测，仅在上游没给时才用——注意它们会随官方调价而过时。
const FEATURED = [
  { id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash', context: 1000000, maxOutput: 128000, credits: 0.11 },
  { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', context: 1000000, maxOutput: 50000, credits: 0.51 },
  { id: 'glm-5.3', name: 'GLM-5.3', context: 1000000, maxOutput: 48000, credits: 0.79 },
];

/**
 * 取某模型的消耗倍率。
 *
 * 上游给的 `credits` 可能是**数字**，也可能是形如 `"x0.03"` 的**字符串**——
 * 只认数字会把后者静默丢掉。
 *
 * **拿不到就返回 undefined，不回退到别的区域的值**：倍率随区域与促销变化，
 * 用国内实测值去填国际版的同一个模型 id，会把免费模型标成 0.11。
 */
function creditsOf(model) {
  const raw = model?.credits;
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'string') {
    const hit = /x\s*([0-9]*\.?[0-9]+)/i.exec(raw);
    if (hit) return Number(hit[1]);
  }
  return undefined;
}

// Locate the CodeBuddy / WorkBuddy desktop login file across platforms.
// Override with WORKBUDDY_AUTH_FILE when the desktop app stores it elsewhere.
const AUTH_DIRS = [
  process.env.WORKBUDDY_AUTH_DIR,
  process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'CodeBuddyExtension', 'Data', 'Public', 'auth'),
  process.env.HOME && join(process.env.HOME, 'Library', 'Application Support', 'CodeBuddyExtension', 'Data', 'Public', 'auth'),
  process.env.HOME && join(process.env.HOME, '.local', 'share', 'CodeBuddyExtension', 'Data', 'Public', 'auth'),
  process.env.XDG_DATA_HOME && join(process.env.XDG_DATA_HOME, 'CodeBuddyExtension', 'Data', 'Public', 'auth'),
].filter(Boolean);

/**
 * Explicit override wins; otherwise the default file name, then the first
 * `*.info` in sorted order.
 *
 * Taking "the first entry the directory happens to list" is NOT safe: the
 * login directory commonly holds more than one account snapshot (e.g. the
 * international build's `workbuddy-desktop-ai.info`) and that one sorts before
 * `workbuddy-desktop.info`. Standing alone, the bridge would then silently
 * serve the wrong account. config.mjs resolves the same way, so both entry
 * points agree.
 */
function resolveAuthPath() {
  if (process.env.WORKBUDDY_AUTH_FILE) return process.env.WORKBUDDY_AUTH_FILE;
  for (const dir of AUTH_DIRS) {
    const preferred = join(dir, 'workbuddy-desktop.info');
    if (existsSync(preferred)) return preferred;
  }
  for (const dir of AUTH_DIRS) {
    try {
      const hit = readdirSync(dir).filter((f) => f.endsWith('.info')).sort()[0];
      if (hit) return join(dir, hit);
    } catch { /* directory absent on this platform */ }
  }
  return join(AUTH_DIRS[0] || '.', 'workbuddy-desktop.info');
}

const AUTH_PATH = resolveAuthPath();

const log = (...a) => { if (LOG) console.error(`[${new Date().toISOString()}]`, ...a); };

// ── At-rest credential opener (WorkBuddy desktop 5.6.0+) ─────────────────
// 5.6.0+ seals auth fields in an AES-256-GCM envelope
// ({"$wbEncrypted":1,"envelope":"<base64 of {suite,keyId,nonce,authTag,ciphertext}>"}).
// The field key is a build-time constant that the app exposes only through its
// own Electron native binding, so we ask the installed binary for it and cache
// the derived key for the process lifetime.
const ATREST_AAD_DOMAIN = Buffer.from('WB-AAD\0', 'ascii');
let atRestKeyCache;
let atRestUsedExe = ''; // 最近一次成功取到密钥的客户端 exe（供启动日志/诊断显示）
let wantedKeyId = ''; // 登录文件里信封的 keyId —— 由 readStoredAuth 每次读取时刷新
let memoryAuth = null; // refreshed in-process; the desktop file is never rewritten

// ── Locate the WorkBuddy desktop executable ──────────────────────────────
// 客户端可以装到任意目录（E:\App\WorkBuddy、E:\App\WorkbuddyInternational、
// C:\Program Files\Tencent\WorkBuddy…），exe 名也随版本不同（WorkBuddy.exe /
// WorkBuddyAI.exe / CodeBuddy.exe）。只写死几个路径在"换目录重装"后必然失效
// —— 现象正是 `key fetch failed: spawnSync … ENOENT`。
//
// 探测顺序：显式覆盖 → 默认位置 → 磁盘浅扫描 → 系统信号兜底（进程路径 +
// 注册表安装记录，见下方）。与 lib/find-workbuddy.mjs 是同一套算法（桥刻意
// 保持自包含单文件、不 import 本项目模块；改动时两边需同步）。
const WB_EXE_NAME_RE = /^(?:workbuddy(?:\s*ai)?|codebuddy(?:\s*ai)?)\.exe$/i;
const WB_DIR_KEYWORD_RE = /workbuddy|codebuddy/i;
const WB_DESCEND_RE = /^(?:app|apps|application|applications|program|programs|program files(?:\s*\(x86\))?|software|soft|tools?|tencent|portable|green|dev|develop|development|应用|软件)$/i;
const WB_SCAN_MAX_DIRS = 400;
const WB_SCAN_MIN_INTERVAL_MS = 3000;
const WB_MISS_RETRY_MS = 5000;

let wbExeCache = '';
let wbScanCache = null;
let wbScanAt = 0;
let wbMissAt = 0;

function wbListDirs(dir, budget) {
  if (budget.dirs <= 0) return [];
  budget.dirs -= 1;
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/** Direct child of `dir` that looks like the client binary (full path or ''). */
function wbExeInDir(dir) {
  try {
    const hit = readdirSync(dir, { withFileTypes: true })
      .find((e) => !e.isDirectory() && WB_EXE_NAME_RE.test(e.name));
    return hit ? join(dir, hit.name) : '';
  } catch {
    return '';
  }
}

/** 磁盘浅扫描：盘根 → {App | Program Files | Tencent | …} → {含 workbuddy 的目录} → exe。 */
function wbScan() {
  if (process.platform !== 'win32') return [];
  const found = [];
  const seen = new Set();
  const budget = { dirs: WB_SCAN_MAX_DIRS };
  const push = (p) => { if (p && !seen.has(p)) { seen.add(p); found.push(p); } };

  for (let c = 67; c <= 90; c += 1) { // C: … Z:
    const drive = `${String.fromCharCode(c)}:\\`;
    if (!existsSync(drive)) continue;
    for (const name1 of wbListDirs(drive, budget)) {
      const p1 = join(drive, name1);
      if (WB_DIR_KEYWORD_RE.test(name1)) {
        // E:\App\WorkbuddyInternational\WorkBuddy.exe
        push(wbExeInDir(p1));
        for (const name2 of wbListDirs(p1, budget)) push(wbExeInDir(join(p1, name2)));
      } else if (WB_DESCEND_RE.test(name1)) {
        for (const name2 of wbListDirs(p1, budget)) {
          const p2 = join(p1, name2);
          if (WB_DIR_KEYWORD_RE.test(name2)) {
            push(wbExeInDir(p2));
            for (const name3 of wbListDirs(p2, budget)) push(wbExeInDir(join(p2, name3)));
          } else if (WB_DESCEND_RE.test(name2)) {
            // C:\Program Files\Tencent\WorkBuddy\WorkBuddy.exe
            for (const name3 of wbListDirs(p2, budget)) {
              if (WB_DIR_KEYWORD_RE.test(name3)) push(wbExeInDir(join(p2, name3)));
            }
          }
        }
      }
    }
  }
  return found;
}

/**
 * All executable candidates, most-trusted first.
 *
 * 静态候选在前；扫描兜底（带缓存与失败防抖 —— "客户端正在重装"的窗口期内
 * 不会每次调用都全盘扫一遍）。返回**数组**而不是单个路径：机器上可能并存
 * 多个 build，由 atRestKey() 按登录文件的 keyId 挑选。
 */
function workBuddyExeCandidates() {
  if (wbExeCache && existsSync(wbExeCache)) return [wbExeCache];

  const out = [];
  if (process.env.WORKBUDDY_APP_EXECUTABLE) out.push(process.env.WORKBUDDY_APP_EXECUTABLE);
  if (process.platform === 'win32') {
    const names = ['WorkBuddy.exe', 'WorkBuddyAI.exe', 'CodeBuddy.exe'];
    for (const root of [
      process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs'),
      process.env.ProgramFiles,
      process.env['ProgramFiles(x86)'],
    ].filter(Boolean)) {
      for (const dir of ['WorkBuddy', 'WorkBuddy AI', 'WorkBuddyAI', 'CodeBuddy']) {
        for (const name of names) out.push(join(root, dir, name));
      }
    }
    out.push('E:\\App\\WorkBuddy\\WorkBuddy.exe');
    out.push('E:\\App\\WorkBuddy\\WorkBuddyAI.exe');
    out.push('D:\\App\\WorkBuddy\\WorkBuddy.exe');
  } else if (process.platform === 'darwin') {
    out.push('/Applications/WorkBuddy.app/Contents/MacOS/WorkBuddy');
    out.push('/Applications/WorkBuddy AI.app/Contents/MacOS/WorkBuddy');
  } else {
    out.push('/opt/WorkBuddy/workbuddy');
  }

  if (!wbScanCache && Date.now() - wbScanAt >= WB_SCAN_MIN_INTERVAL_MS) {
    wbScanAt = Date.now();
    const hits = wbScan();
    if (hits.length) wbScanCache = hits;
  }
  if (wbScanCache) {
    for (const p of wbScanCache) {
      if (!out.includes(p)) out.push(p); // 静态与扫描可能重叠，去重
    }
  }
  return out;
}

// ── 系统信号兜底（Windows）：进程镜像路径 + 注册表安装记录 ───────────────
// 静态候选与目录扫描本质上都在"猜路径"；客户端装进 `D:\随机名字\` 就会全部
// 落空。而下面两类信号是**客户端自己留下的、与安装位置无关**：
//   ① 运行中进程的镜像路径（客户端在用时即安装位置，最准）；
//   ② 注册表卸载记录 / 深链协议（workbuddy://…）/ App Paths —— 官方安装器
//      必写（否则"应用和功能"里看不到它），装到任何目录都有。
// PowerShell 冷启动数秒，故只在前面全部落空时执行，且带缓存与失败防抖。
// 与 lib/find-workbuddy.mjs 同款（桥保持自包含单文件；改动时两边需同步）。
const WB_SYS_PROBE_MIN_INTERVAL_MS = 120000;
let wbSysHits = null;
let wbSysProbeAt = 0;

function wbPowershellPath() {
  const full = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return existsSync(full) ? full : 'powershell';
}

/** 一次调用收集全部信号，base64 输出（免受编码/引号影响）。 */
const WB_SYS_PROBE_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$out = @{ procs = @(); reg = @() }
Get-Process | Where-Object { $_.Name -match '^(WorkBuddy|CodeBuddy)' } | ForEach-Object {
  if ($_.Path) { $out.procs += $_.Path }
}
$roots = @(
  'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
  'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
  'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
)
foreach ($r in $roots) {
  Get-ChildItem $r | ForEach-Object {
    $p = Get-ItemProperty $_.PSPath
    if ("$($p.DisplayName)" -match 'WorkBuddy|CodeBuddy') {
      $out.reg += @{ icon = "$($p.DisplayIcon)"; uninst = "$($p.UninstallString)" }
    }
  }
}
foreach ($proto in @('workbuddy', 'workbuddyai', 'codebuddy')) {
  foreach ($hive in @('HKCU:\Software\Classes', 'HKLM:\Software\Classes')) {
    $cmd = (Get-ItemProperty "$hive\$proto\shell\open\command").'(default)'
    if ($cmd) { $out.reg += @{ cmd = "$cmd" } }
  }
}
foreach ($hive in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\App Paths', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\App Paths')) {
  Get-ChildItem $hive | Where-Object { $_.PSChildName -match 'WorkBuddy|CodeBuddy' } | ForEach-Object {
    $d = (Get-ItemProperty $_.PSPath).'(default)'
    if ($d) { $out.reg += @{ cmd = "$d" } }
  }
}
[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($out | ConvertTo-Json -Depth 5 -Compress)))
`;

/** 从信号里提取客户端 exe：exe 名直接认；卸载器/图标路径取所在目录再找本体。 */
function wbExtractExePaths(signal) {
  const out = [];
  const push = (p) => {
    const v = String(p || '').trim();
    if (v && !out.includes(v)) out.push(v);
  };
  const baseOf = (p) => String(p || '').split(/[\\/]/).pop() || '';
  for (const p of signal?.procs || []) {
    if (WB_EXE_NAME_RE.test(baseOf(p))) push(p);
  }
  for (const rec of signal?.reg || []) {
    // 三个字段都要尝试（而非短路取值）：icon 可能指向无关程序甚至系统图标，
    // 此时 uninst（卸载器路径）是唯一线索。
    for (const raw of [rec.icon, rec.uninst, rec.cmd]) {
      const m = /([A-Za-z]:\\[^"]*?\.exe)/i.exec(String(raw || ''));
      if (!m) continue;
      const exe = m[1];
      if (WB_EXE_NAME_RE.test(baseOf(exe))) {
        push(exe);
        continue;
      }
      const hit = wbExeInDir(dirname(exe)); // 卸载器与客户端同目录
      if (hit) push(hit);
    }
  }
  return out;
}

/** 系统信号兜底（Windows）。成功缓存；失败 2 分钟内不重试；任何异常静默返回 []。 */
function wbProbeSystemSignals() {
  if (wbSysHits) return wbSysHits;
  if (process.platform !== 'win32') return [];
  if (Date.now() - wbSysProbeAt < WB_SYS_PROBE_MIN_INTERVAL_MS) return [];
  wbSysProbeAt = Date.now();

  let signal;
  try {
    const res = spawnSync(wbPowershellPath(), ['-NoProfile', '-NonInteractive', '-Command', WB_SYS_PROBE_SCRIPT], {
      encoding: 'utf8',
      timeout: 20000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 1048576,
    });
    if (res.error || res.status !== 0 || !res.stdout) return [];
    signal = JSON.parse(Buffer.from(String(res.stdout).replace(/\s+/g, ''), 'base64').toString('utf8'));
  } catch {
    return [];
  }
  const hits = wbExtractExePaths(signal).filter((p) => existsSync(p));
  if (hits.length) wbSysHits = hits;
  return hits;
}

/**
 * 首个存在的客户端 exe；全部落空返回 ''。成功结果缓存，缓存失效自动重探。
 * 先便宜的（静态 + 扫描），全落空才动 PowerShell 兜底。
 */
function resolveWorkBuddyExe() {
  if (wbExeCache && existsSync(wbExeCache)) return wbExeCache;
  wbExeCache = '';
  if (Date.now() - wbMissAt < WB_MISS_RETRY_MS) return '';
  let hit = workBuddyExeCandidates().find((p) => existsSync(p));
  if (!hit) hit = wbProbeSystemSignals().find((p) => existsSync(p));
  if (hit) {
    wbExeCache = hit;
    return hit;
  }
  wbMissAt = Date.now();
  return '';
}

/** Length-prefixed UTF-8 string: uint32 big-endian length then the bytes. */
function encodeLengthPrefixed(value) {
  const bytes = Buffer.from(value, 'utf8');
  const len = Buffer.allocUnsafe(4);
  len.writeUInt32BE(bytes.length);
  return Buffer.concat([len, bytes]);
}

/** Additional authenticated data for a FIELD-framed sym-v1 envelope. */
function atRestFieldAad(keyId, suite) {
  const suiteBytes = Buffer.allocUnsafe(4);
  suiteBytes.writeUInt32BE(suite);
  return Buffer.concat([
    ATREST_AAD_DOMAIN,
    Buffer.from([1]),
    encodeLengthPrefixed('WBEV1'),
    encodeLengthPrefixed('sym-v1'),
    suiteBytes,
    encodeLengthPrefixed(keyId),
    Buffer.from([2]),
    Buffer.from([0]),
    Buffer.from([0]),
  ]);
}

/** keyId of a derived field key — same truncation the envelopes use. */
function atRestKeyId(key) {
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

/** Envelope keyId carried by an encrypted field ('' for plaintext / malformed). */
function fieldKeyIdOf(value) {
  if (!isEncryptedField(value)) return '';
  try {
    return JSON.parse(Buffer.from(value.envelope, 'base64').toString('utf8')).keyId || '';
  } catch {
    return '';
  }
}

/** 从某个 exe 取一次密钥载荷；失败返回 { error }。 */
function fetchKeyPayloadFrom(exe) {
  const script =
    "try{process.stdout.write(process._linkedBinding('electron_browser_workbuddy_storage').loggerGet())}"
    + 'catch(e){process.exitCode=3;process.stderr.write(String((e&&e.message)||e))}';
  const res = spawnSync(exe, ['-e', script], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    // stdin MUST be ignored: the Electron binary fails with EBUSY when a
    // pipe is opened for it, so only stdout/stderr may be piped.
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 20000,
    windowsHide: true,
    maxBuffer: 1048576,
    encoding: 'utf8',
  });
  if (res.error) return { error: res.error.message };
  if (res.status !== 0) {
    return { error: `exit ${res.status}: ${String(res.stderr || '').trim()}` };
  }
  try {
    const secret = JSON.parse(res.stdout).atRestSecretKey;
    if (typeof secret !== 'string' || secret === '') {
      return { error: 'payload carries no atRestSecretKey' };
    }
    return { secret };
  } catch (err) {
    return { error: `unparsable payload: ${String((err && err.message) || err)}` };
  }
}

/**
 * The 32-byte field key, derived from the app's own key payload.
 *
 * 机器上可能并存多个 WorkBuddy build（如国内版 WorkBuddyAI.exe 与国际版
 * WorkBuddy.exe）——它们的 atRestSecretKey 不同，只有"写登录文件的那个"能
 * 解开信封。所以按登录文件里信封的 keyId 逐个候选试，命中即用；一个都不
 * 匹配时退回第一个能取到密钥的，让 openAuthField 给出准确的 keyId 报错。
 */
function atRestKey() {
  if (atRestKeyCache) return atRestKeyCache;
  let candidates = workBuddyExeCandidates().filter((p) => existsSync(p));
  // 廉价层全 miss 才动 PowerShell 兜底（系统信号：进程 + 注册表）
  if (candidates.length === 0) candidates = wbProbeSystemSignals().filter((p) => existsSync(p));
  if (candidates.length === 0) {
    throw new Error(
      'key fetch failed: WorkBuddy 客户端可执行文件未找到'
      + '（已探测默认安装位置并扫描常见目录）。'
      + '若客户端装在非常规目录，请在 .env 设置 WORKBUDDY_APP_EXECUTABLE 指向其 WorkBuddy.exe',
    );
  }
  const failures = [];
  let fallback;
  for (const exe of candidates) {
    const { secret, error } = fetchKeyPayloadFrom(exe);
    if (!secret) {
      failures.push(`${exe} -> ${error}`);
      continue;
    }
    // The app hashes the base64 STRING, not its decoded bytes.
    const key = createHash('sha256').update(secret, 'utf8').digest();
    if (!wantedKeyId || atRestKeyId(key) === wantedKeyId) {
      atRestKeyCache = key;
      atRestUsedExe = exe;
      return key;
    }
    if (!fallback) fallback = { key, exe }; // 可能不是写登录文件的那个 build：先留着
  }
  if (fallback) {
    atRestKeyCache = fallback.key;
    atRestUsedExe = fallback.exe;
    return fallback.key;
  }
  throw new Error(`key fetch failed from all ${candidates.length} candidate(s): ${failures.join(' | ')}`);
}

/** Whether a value is the app's encrypted-field wrapper. */
function isEncryptedField(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  return keys.length === 2 && keys[0] === '$wbEncrypted' && keys[1] === 'envelope'
    && value.$wbEncrypted === 1 && typeof value.envelope === 'string';
}

/** Plaintext of an auth field, transparently opening the 5.6+ envelope. */
function openAuthField(value, label) {
  if (typeof value === 'string') return value; // pre-5.6 plaintext, or a refreshed value
  if (!isEncryptedField(value)) return '';
  const envelope = JSON.parse(Buffer.from(value.envelope, 'base64').toString('utf8'));
  const key = atRestKey();
  const expected = createHash('sha256').update(key).digest('hex').slice(0, 16);
  if (envelope.keyId !== expected) {
    throw new Error(`${label} was sealed under key ${envelope.keyId}, not ${expected};`
      + ' is this the desktop build that wrote the login file?');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.nonce, 'base64'), { authTagLength: 16 });
  decipher.setAAD(atRestFieldAad(envelope.keyId, envelope.suite));
  decipher.setAuthTag(Buffer.from(envelope.authTag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

/**
 * 按登录域名选择上游网关。
 *
 * 国际版与国内版是**不同的网关**，用错会直接 401：
 *   workbuddy.ai / workbuddy.cc  →  https://www.workbuddy.ai
 *   国内版（默认）                →  https://copilot.tencent.com
 *
 * 原实现只判断 `codebuddy.ai`，于是 `www.workbuddy.ai` 落到了国内网关——
 * 只有存在国际版账号（多账号切换）时才会暴露。
 */
function pickUpstream(domain) {
  const d = String(domain || '');
  if (d.includes('workbuddy.ai') || d.includes('workbuddy.cc')) return 'https://www.workbuddy.ai';
  if (d.includes('codebuddy.ai')) return 'https://www.codebuddy.ai';
  return 'https://copilot.tencent.com';
}

// ── Auth: read the local desktop session ─────────────────────────────────
function readStoredAuth() {
  // A token this process refreshed outlives the file until the desktop app catches up.
  if (memoryAuth && Date.now() < memoryAuth.expiresAt - REFRESH_SKEW_MS) return memoryAuth;
  const raw = JSON.parse(readFileSync(AUTH_PATH, 'utf8'));
  const auth = raw.auth || {};
  if (!auth.accessToken) throw new Error('login file has no accessToken; sign in to the WorkBuddy desktop app first');
  // 密钥选择以本文件为基准：机器上多客户端并存时，优先用"写这份登录文件的
  // build"。文件被另一个 build 重写过 → 已缓存的密钥失效，重新挑。
  wantedKeyId = fieldKeyIdOf(auth.accessToken) || fieldKeyIdOf(auth.refreshToken) || '';
  if (wantedKeyId && atRestKeyCache && atRestKeyId(atRestKeyCache) !== wantedKeyId) {
    atRestKeyCache = undefined;
  }
  const access = openAuthField(auth.accessToken, 'accessToken');
  const refresh = openAuthField(auth.refreshToken, 'refreshToken');
  const claims = decodeJwt(access);
  const domain = auth.domain || claims.iss || '';
  const endpoint = EXPLICIT_ENDPOINT || pickUpstream(domain);
  return {
    access,
    refresh,
    expiresAt: Number(auth.expiresAt || claims.exp * 1000 || 0),
    refreshExpiresAt: Number(auth.refreshExpiresAt || 0),
    userId: claims.sub || '',
    enterpriseId: claims.enterprise_id || '',
    tenantId: claims.tenant_id || claims.tenant || '',
    endpoint,
    domain,
  };
}

function decodeJwt(token) {
  try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')); }
  catch { return {}; }
}

// ── Auth: refresh and write back the login file (cross-process lock + atomic write) ──
let lastRefreshFailedAt = 0;
async function refreshAuth(auth) {
  if (!auth.refresh) return null;
  if (Date.now() - lastRefreshFailedAt < REFRESH_COOLDOWN_MS) return null;
  try {
    const res = await fetch(`${auth.endpoint}/v2/plugin/auth/token/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${auth.refresh}` },
      signal: AbortSignal.timeout(8000),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body || body.code !== 0 || !body.data?.accessToken) {
      lastRefreshFailedAt = Date.now();
      // **绝不打印响应体全文**：失败条件里含 `!res.ok`，也就是说非 2xx 的响应体
      // 仍可能带着 `data.accessToken` —— 而这一行会落进 bridge.log（控制台的日志
      // 面板还会把它显示出来），那就直接违反了「不落盘令牌 / 凭据不落盘」的承诺。
      // 只取协议层的 code 与 msg：定位问题够用，且不含凭据。
      const reason = body && typeof body === 'object'
        ? `${body.code ?? ''} ${body.msg || body.message || ''}`.trim()
        : '';
      log('refresh failed', res.status, shortError(reason || '(no protocol message)'));
      return null;
    }
    persistRefreshed();
    const now = Date.now();
    memoryAuth = {
      access: body.data.accessToken,
      refresh: body.data.refreshToken || auth.refresh,
      expiresAt: now + Number(body.data.expiresIn || 0) * 1000,
      refreshExpiresAt: now + Number(body.data.refreshExpiresIn || 0) * 1000,
      userId: auth.userId,
      enterpriseId: auth.enterpriseId,
      tenantId: auth.tenantId,
      endpoint: auth.endpoint,
      domain: auth.domain,
    };
    log('refreshed access token (in memory; file untouched)');
    return memoryAuth;
  } catch (e) {
    lastRefreshFailedAt = Date.now();
    log('refresh error', e.message);
    return null;
  }
}

function persistRefreshed() {
  // The login file now holds AES-256-GCM envelopes and the desktop app owns its
  // own refresh cycle. Writing a decrypted token back would corrupt that store,
  // so a refreshed token is kept in memory for this process only.
  log('write-back skipped: the at-rest credential store belongs to the desktop app');
}

// ── Upstream payload normalization ───────────────────────────────────────
/**
 * 上游（copilot.tencent.com）比 OpenAI 规范更严：有几处「规范允许、上游拒绝」
 * 的写法，必须在转发前归一化，否则客户端一用就整条请求失败。目前三处：
 *
 * 1. `developer` 角色 —— 新版 OpenAI 规范用它承载 system 提示，而官方客户端
 *    只发 `system`。上游只认后者，遇到 `developer` 直接 400 code 11128。
 * 2. `tool_choice` 对象形式 —— 规范允许 `{type:'function', function:{name}}`
 *    强制调用某个具体函数，上游的 Go 结构体把它声明成了 `string`，
 *    收到对象会 400 code 11101。Cursor / Trae / opencode 这类基于 AI SDK
 *    的 Agent 客户端会发对象形式。
 * 3. 首条消息必须是 system —— 上游会以 `400 code 11128 first message is not
 *    system prompt` 拒绝纯 user 开头的请求，而不少客户端（含自带的
 *    「对话测试」和只发单轮的 CLI）并不发 system。
 */
function normalizePayload(payload) {
  let next = payload;

  // ── tool_choice：对象 → 字符串 ─────────────────────────────────────────
  // `{type:'function'}` 表达的是「必须调用工具」里最强的那档，而上游没有
  // 「指定某一个函数」的表达，取语义最接近的 `required`（必须调用工具，
  // 但不限定是哪一个）。
  //
  // 认不出来的对象**丢弃而不是原样转发**：留着必然 400，丢掉最多退化成
  // `auto`（让模型自己决定），这比整条请求失败好得多。
  const tc = next.tool_choice;
  if (tc !== null && typeof tc === 'object' && !Array.isArray(tc)) {
    const mapped = tc.type === 'function' ? 'required'
      : (tc.type === 'auto' || tc.type === 'none' || tc.type === 'required') ? tc.type
        : null;
    next = { ...next };
    if (mapped) {
      next.tool_choice = mapped;
      log(`normalize: tool_choice object -> "${mapped}"`);
    } else {
      delete next.tool_choice;
      log('normalize: dropped unrecognized tool_choice object');
    }
  }

  // ── messages：developer → system，并保证首条是 system ──────────────────
  const messages = next.messages;
  if (!Array.isArray(messages) || messages.length === 0) return next;

  let rewritten = 0;
  const fixed = messages.map((m) => {
    if (m && (m.role === 'developer' || m.role === 'Developer')) {
      rewritten++;
      return { ...m, role: 'system' };
    }
    return m;
  });

  let prepended = 0;
  const first = fixed[0];
  if (!first || (first.role !== 'system' && first.role !== 'System')) {
    fixed.unshift({ role: 'system', content: 'You are a helpful assistant.' });
    prepended = 1;
  }

  if (rewritten) log(`normalize: rewrote ${rewritten} developer message(s) -> system`);
  if (prepended) log('normalize: prepended a system message (upstream requires one first)');
  if (!rewritten && !prepended) return next;
  return { ...next, messages: fixed };
}

// ── Request header construction ──────────────────────────────────────────
const trace = () => randomUUID().replace(/-/g, '');

function buildHeaders(auth, model, conversationId) {
  const messageId = trace();
  const traceId = trace();
  const spanId = traceId.slice(0, 16);
  const parentSpanId = traceId.slice(16, 32);
  const h = {
    Accept: 'application/json, text/plain, */*',
    'Content-Type': 'application/json',
    'X-Requested-With': 'XMLHttpRequest',
    'X-Agent-Intent': 'craft',
    'X-IDE-Type': IDE_NAME,
    'X-IDE-Name': IDE_NAME,
    'X-IDE-Version': IDE_VERSION,
    'X-Product-Version': APP_VERSION,
    'X-Env-ID': 'production',
    'X-Domain': auth.domain,
    'X-Product': 'SaaS',
    'User-Agent': `${IDE_NAME}/${IDE_VERSION} CodeBuddy/${APP_VERSION}`,
    'X-Request-ID': messageId,
    'X-Conversation-ID': conversationId || trace(),
    'X-Conversation-Request-ID': messageId,
    'X-Conversation-Message-ID': messageId,
    'X-Request-Trace-Id': traceId,
    b3: `${traceId}-${spanId}-1-${parentSpanId}`,
    'X-B3-TraceId': traceId,
    'X-B3-ParentSpanId': parentSpanId,
    'X-B3-SpanId': spanId,
    'X-B3-Sampled': '1',
  };
  if (model) {
    // 兜底。入口（/v1/chat/completions）已按 HEADER_SAFE_RE 校验并回 400，这里再挡
    // 一次是为了防止**将来新增的调用方**绕过入口校验、把非法值直接送进 http.request ——
    // 那样抛出的 `Invalid character in header content` 会变成 500，而根因（谁传的）
    // 在栈里完全看不出来。Anthropic 路径的模型名会先被映射成真实 id，天然安全。
    if (!HEADER_SAFE_RE.test(model)) {
      throw new Error(`model id would produce an invalid X-Model-ID header: ${shortError(model, 60)}`);
    }
    h['X-Model-ID'] = model;
  }
  if (API_KEY) {
    h.Authorization = `Bearer ${API_KEY}`;
    h['X-API-Key'] = API_KEY;
  } else {
    h.Authorization = `Bearer ${auth.access}`;
    if (auth.userId) h['X-User-Id'] = auth.userId;
    if (auth.enterpriseId) h['X-Enterprise-Id'] = auth.enterpriseId;
    if (auth.tenantId) h['X-Tenant-Id'] = auth.tenantId;
  }
  return h;
}

// ── Upstream call (with refresh retry and transient-400 retry) ───────────
/**
 * 用 node:http/https + keep-alive Agent 发一次上游请求，返回 IncomingMessage。
 *
 * 为什么不用全局 fetch：Node 内建 fetch（undici）的连接池不开放、空闲连接只留
 * ~4 秒，达不到「跨请求复用 TLS 连接」的目的。node:http 的 Agent 可以。
 * 返回的 res 兼容 bridge 现有消费方式（res.ok / res.status / res.text() /
 * res.body.getReader() 由下面的 shim 补齐）。
 */
function upstreamRequest(endpointUrl, { headers, body, signal }) {
  const url = new URL(endpointUrl);
  const doRequest = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = doRequest(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        headers,
        agent: agentFor(url.protocol),
      },
      (res) => resolve(res),
    );
    req.on('error', reject);
    if (signal) {
      if (signal.aborted) { req.destroy(new Error('aborted')); return; }
      const onAbort = () => req.destroy(new Error(signal.reason?.message || 'aborted'));
      signal.addEventListener('abort', onAbort, { once: true });
      req.on('close', () => signal.removeEventListener('abort', onAbort));
      req.on('response', (res) => res.on('close', () => signal.removeEventListener('abort', onAbort)));
    }
    req.end(body);
  });
}

/** http.IncomingMessage → 与 fetch Response 兼容的最小面（bridge 现有消费代码不动）。 */
function shimResponse(res) {
  return {
    ok: res.statusCode >= 200 && res.statusCode < 300,
    status: res.statusCode,
    headers: res.headers,
    text: () => new Promise((resolve, reject) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    }),
    body: new ReadableStream({
      start(controller) {
        res.on('data', (c) => controller.enqueue(new Uint8Array(c)));
        res.on('end', () => controller.close());
        res.on('error', (e) => controller.error(e));
      },
      cancel() { res.destroy(); },
    }),
    // 诊断/重试逻辑用：这条连接是不是复用的（见 sendWithRetry）
    reusedSocket: res.reusedSocket === true,
  };
}

/**
 * 发送并处理「复用的空闲连接已被服务端掐断」：ECONNRESET / socket hang up
 * 发生在**复用** socket 且还没收到任何响应字节时，换新连接重试一次。
 */
async function callUpstream(bodyString, model, conversationId, clientSignal) {
  // API-key mode needs no login file; supply a minimal endpoint/domain instead
  let auth = API_KEY
    ? { endpoint: EXPLICIT_ENDPOINT || 'https://copilot.tencent.com', domain: (EXPLICIT_ENDPOINT || '').includes('codebuddy.ai') ? 'www.codebuddy.ai' : 'www.codebuddy.cn', access: '', refresh: '', expiresAt: 0 }
    : readStoredAuth();
  if (!API_KEY && auth.refresh && auth.expiresAt - REFRESH_SKEW_MS < Date.now()) {
    const next = await refreshAuth(auth);
    if (next) auth = next;
  }

  const attempt = (a) => {
    // WORKBUDDY_TIMEOUT_MS > 0 时给整个上游往返加超时（0/未设 = 不限，
    // LLM 长回答需要）；与客户端取消信号合并。
    const timeoutSignal = UPSTREAM_TIMEOUT_MS > 0 ? AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) : null;
    const signal = clientSignal && timeoutSignal ? AbortSignal.any([clientSignal, timeoutSignal])
      : (clientSignal || timeoutSignal || undefined);
    return upstreamRequest(`${a.endpoint}${CHAT_PATH}`, {
      headers: buildHeaders(a, model, conversationId),
      body: bodyString,
      signal,
    }).then(shimResponse);
  };

  const attemptWithStaleRetry = async (a) => {
    try {
      return await attempt(a);
    } catch (error) {
      // 复用的空闲连接被上游掐断（服务器先关）→ 换新连接重试一次。
      // 新连接必然不是 reused；首次连接就失败属于真故障，不重试。
      if (!clientSignal?.aborted && /ECONNRESET|socket hang up|EPIPE/i.test(String(error?.message || error?.code || ''))) {
        log('stale keep-alive socket, retrying once on a fresh connection');
        return attempt(a);
      }
      throw error;
    }
  };

  let res = await attemptWithStaleRetry(auth);
  if (!API_KEY && (res.status === 401 || res.status === 403) && auth.refresh) {
    const next = await refreshAuth(auth);
    if (next) { auth = next; res = await attemptWithStaleRetry(auth); }
  }

  // the gateway occasionally wraps a momentary upstream failure as 400 code 11133: retry idempotently
  for (let i = 0; res.status === 400 && i < TRANSIENT_400_DELAYS.length; i++) {
    const text = await res.text();
    let code;
    try { code = JSON.parse(text)?.code; } catch {}
    if (code !== 11133) return { res, bodyText: text };
    if (clientSignal?.aborted) return { res, bodyText: text };
    log(`transient 400 (11133), retry ${i + 1}`);
    await new Promise((r) => setTimeout(r, TRANSIENT_400_DELAYS[i]));
    if (clientSignal?.aborted) return { res, bodyText: text };
    res = await attemptWithStaleRetry(auth);
  }
  return { res, bodyText: null };
}

// ── SSE parsing and aggregation (non-streaming clients only) ─────────────
function mergeToolCallDelta(acc, deltas) {
  for (const d of deltas || []) {
    const idx = d.index ?? acc.length;
    acc[idx] ??= { id: undefined, type: 'function', function: { name: '', arguments: '' } };
    const slot = acc[idx];
    if (d.id) slot.id = d.id;
    if (d.type) slot.type = d.type;
    if (d.function?.name) slot.function.name += d.function.name;
    if (d.function?.arguments) slot.function.arguments += d.function.arguments;
  }
}

async function aggregateStream(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '', reasoning = '', finishReason = null, usage = null, id = null, model = null, created = null;
  const toolCalls = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let j; try { j = JSON.parse(payload); } catch { continue; }
      id ??= j.id; model ??= j.model; created ??= j.created;
      if (j.usage) usage = j.usage;
      const choice = j.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) finishReason = choice.finish_reason;
      const d = choice.delta || {};
      if (typeof d.content === 'string') content += d.content;
      if (typeof d.reasoning_content === 'string') reasoning += d.reasoning_content;
      if (d.tool_calls) mergeToolCallDelta(toolCalls, d.tool_calls);
    }
  }
  const message = { role: 'assistant', content: content || null };
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCalls.length) message.tool_calls = toolCalls.filter(Boolean);
  return {
    id: id || `chatcmpl-${trace().slice(0, 24)}`,
    object: 'chat.completion',
    created: created || Math.floor(Date.now() / 1000),
    model: model || '',
    choices: [{ index: 0, message, finish_reason: finishReason || 'stop' }],
    ...(usage ? { usage } : {}),
  };
}

/**
 * 上游 usage → 本地账本字段。
 *
 * **必须留在模块级**：OpenAI 的 `/v1/chat/completions` 与 Anthropic 的
 * `/v1/messages` 两条协议路径都要用它。原先它定义在 chat/completions 的
 * 块作用域里，Anthropic 路由根本看不到，一调就是 `ReferenceError`。
 */
const usageOf = (u) => ({
  promptTokens: Number(u?.prompt_tokens) || 0,
  completionTokens: Number(u?.completion_tokens) || 0,
  // 上游在 usage 里回报本次实际扣减的积分，一并记进本地账本（只记数字）
  ...(typeof u?.credit === 'number' ? { credit: u.credit } : {}),
});

// ── Anthropic Messages API 兼容层（POST /v1/messages）─────────────────────
/**
 * 为什么需要这一层
 * ----------------
 * Claude Code 说的是 Anthropic 的 Messages 协议，**不是** OpenAI 的
 * chat/completions。两者在请求结构、响应结构、流式事件格式上都不一样，
 * 光把 Base URL 指过来是接不上的（会直接 404，因为桥原先没有这个路由）。
 *
 * 这一层做两件事：把 Anthropic 请求翻译成上游认的 OpenAI 请求；再把上游的
 * OpenAI 流翻译回 Anthropic 的事件流。翻译是**有损但语义等价**的，下面每处
 * 不可逆的映射都单独注明了原因。
 *
 * 上游只支持流式，所以这里统一走上游流式：`stream:false` 的客户端先收完
 * 再聚合成一个完整 message。
 */

/**
 * 模型名解析。Claude Code 会发 `claude-sonnet-4-...` 这类名字，上游没有这些 id。
 *
 * 顺序：① 精确命中上游目录就原样用（允许用 `ANTHROPIC_MODEL` 指定真实模型）；
 * ② 带 haiku/flash 这类「小快」字样的走 fast 模型（Claude Code 拿它跑标题生成、
 * 文件摘要这类后台活，用大模型纯属浪费额度）；③ 其余走默认模型。
 *
 * 默认取 `glm-5.3` 而不是桥的通用默认 `deepseek-v4.1-flash`：Claude Code 是
 * Agent，全程依赖工具调用，而 `glm-5.3` 是实测 tool_calls 最稳的一个。
 */
const ANTHROPIC_MODEL = process.env.WORKBUDDY_ANTHROPIC_MODEL || 'glm-5.3';
const ANTHROPIC_FAST_MODEL = process.env.WORKBUDDY_ANTHROPIC_FAST_MODEL || 'glm-5.3-flash';

function resolveAnthropicModel(requested) {
  const name = typeof requested === 'string' ? requested : '';
  if (name && catalogCache.models.some((m) => m.id === name)) return name;
  if (name && /haiku|flash|mini|small|fast/i.test(name)) return ANTHROPIC_FAST_MODEL;
  return ANTHROPIC_MODEL;
}

/** Anthropic 的 stop_reason 与 OpenAI 的 finish_reason 不是一一对应，需显式映射。 */
function anthropicStopReason(finishReason) {
  if (finishReason === 'tool_calls') return 'tool_use';
  if (finishReason === 'length') return 'max_tokens';
  return 'end_turn';
}

/** 上游给的 arguments 是字符串形式的 JSON；模型偶尔吐半截，别让整个请求炸掉。 */
function safeJsonParse(s) {
  if (typeof s !== 'string' || !s.trim()) return {};
  try {
    const v = JSON.parse(s);
    // Anthropic 要求 tool_use.input 必须是对象
    return v && typeof v === 'object' ? v : {};
  } catch { return {}; }
}

/** Anthropic 的 `system` 可以是字符串，也可以是 `[{type:'text',text}]`。 */
function anthropicSystemText(system) {
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) {
    return system
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n');
  }
  return '';
}

/** Anthropic 的 tool_result.content 同样有字符串 / 块数组两种形态。 */
function anthropicToolResultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n');
  }
  if (content == null) return '';
  return JSON.stringify(content);
}

/** Anthropic 的 image block → OpenAI 的 image_url（base64 走 data URI）。 */
function anthropicImageToOpenAI(block) {
  const src = block && block.source;
  if (!src) return null;
  if (src.type === 'base64' && src.data) {
    return { type: 'image_url', image_url: { url: `data:${src.media_type || 'image/png'};base64,${src.data}` } };
  }
  if (src.type === 'url' && src.url) {
    return { type: 'image_url', image_url: { url: src.url } };
  }
  return null;
}

/**
 * Anthropic messages → OpenAI messages。
 *
 * 三处结构性差异必须处理，否则上游一定拒：
 * 1. Anthropic 的 system 是**顶层字段**，OpenAI 是**首条消息**；而且上游要求
 *    首条必须是 system，所以即使 system 为空也要补一条占位。
 * 2. Anthropic 把工具调用和结果**混在 content 块数组**里（`tool_use` /
 *    `tool_result`），OpenAI 拆成 assistant.tool_calls + 独立的 `role:"tool"` 消息。
 * 3. 顺序不能乱：带 tool_calls 的 assistant 消息必须排在对应 `role:"tool"`
 *    消息之前，否则上游会以「tool 消息没有前置调用」拒绝。
 */
function anthropicToOpenAIMessages(body) {
  const out = [];
  const sys = anthropicSystemText(body.system);
  out.push({ role: 'system', content: sys || 'You are a helpful assistant.' });

  for (const msg of Array.isArray(body.messages) ? body.messages : []) {
    if (!msg || typeof msg !== 'object') continue;
    const role = msg.role === 'assistant' ? 'assistant' : 'user';

    // 纯字符串是最常见的形态，直接透传
    if (typeof msg.content === 'string') {
      out.push({ role, content: msg.content });
      continue;
    }
    if (!Array.isArray(msg.content)) continue;

    const parts = [];       // OpenAI content 数组（text / image_url）
    const toolCalls = [];   // assistant 的 tool_calls
    const toolResults = []; // user 的 tool_result → 独立的 role:"tool" 消息

    for (const block of msg.content) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'text' && typeof block.text === 'string') {
        parts.push({ type: 'text', text: block.text });
      } else if (block.type === 'image') {
        const img = anthropicImageToOpenAI(block);
        if (img) parts.push(img);
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id || `call_${trace().slice(0, 20)}`,
          type: 'function',
          function: { name: block.name || '', arguments: JSON.stringify(block.input ?? {}) },
        });
      } else if (block.type === 'tool_result') {
        toolResults.push({
          role: 'tool',
          tool_call_id: block.tool_use_id || '',
          content: anthropicToolResultText(block.content),
        });
      }
    }

    if (role === 'assistant') {
      const m = { role: 'assistant' };
      const text = parts.filter((p) => p.type === 'text').map((p) => p.text).join('');
      // 有 tool_calls 时 content 允许为 null（OpenAI 语义就是如此）
      m.content = text || (toolCalls.length ? null : '');
      if (toolCalls.length) m.tool_calls = toolCalls;
      out.push(m);
    } else {
      // tool_result 逻辑上先于本轮的新内容
      for (const tr of toolResults) out.push(tr);
      if (parts.length) {
        out.push({ role: 'user', content: parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts });
      } else if (!toolResults.length) {
        out.push({ role: 'user', content: '' });
      }
    }
  }
  return out;
}

/**
 * Anthropic tools → OpenAI tools。`input_schema` 与 `parameters` 是同一份
 * JSON Schema，只是字段名不同。
 */
function anthropicToolsToOpenAIMessages(tools) {
  if (!Array.isArray(tools)) return null;
  const out = tools
    .filter((t) => t && typeof t.name === 'string' && t.name)
    .map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description || '',
        parameters: t.input_schema || { type: 'object', properties: {} },
      },
    }));
  return out.length ? out : null;
}

/**
 * Anthropic: {type:'auto'} | {type:'any'} | {type:'tool',name} | {type:'none'}
 * OpenAI:    'auto' | 'required' | {type:'function',...} | 'none'
 *
 * 这里**直接产出字符串**：上游只收字符串，虽然 normalizePayload 会兜底把对象
 * 转掉，但没必要多绕一圈。
 */
function anthropicToolChoiceToOpenAI(tc) {
  if (!tc || typeof tc !== 'object') return null;
  if (tc.type === 'any' || tc.type === 'tool') return 'required';
  if (tc.type === 'auto' || tc.type === 'none') return tc.type;
  return null;
}

/** 聚合后的 OpenAI 响应 → Anthropic message 对象（非流式）。 */
function openAIToAnthropicMessage(agg, model) {
  const choice = (agg.choices || [])[0] || {};
  const msg = choice.message || {};
  const content = [];

  if (typeof msg.content === 'string' && msg.content) {
    content.push({ type: 'text', text: msg.content });
  }
  for (const tc of msg.tool_calls || []) {
    if (!tc) continue;
    content.push({
      type: 'tool_use',
      id: tc.id || `toolu_${trace().slice(0, 24)}`,
      name: tc.function?.name || '',
      input: safeJsonParse(tc.function?.arguments),
    });
  }

  return {
    id: `msg_${String(agg.id || trace()).replace(/[^A-Za-z0-9]/g, '').slice(0, 40)}`,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: anthropicStopReason(choice.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: Number(agg.usage?.prompt_tokens) || 0,
      output_tokens: Number(agg.usage?.completion_tokens) || 0,
    },
  };
}

/**
 * 把上游的 OpenAI SSE 流翻译成 Anthropic 的 SSE 事件流，直接写进 `res`。
 *
 * Anthropic 的流比 OpenAI 严格得多：它用 `event:` 行标注事件类型，而且
 * **每个内容块必须有 start / delta… / stop 三件套配对**，块索引单调递增且
 * 不复用。少任何一对，Claude Code 会判定流损坏并中断会话。
 *
 * 文本块与工具块共用一个索引空间：文本先来就占 0、工具接着占 1，反之亦然。
 *
 * 返回 `{ finishReason, usage, streamError }` 供调用方记账。
 */
async function relayAnthropicStream(up, res, model, estInputTokens) {
  const write = (type, obj) => res.write(`event: ${type}\ndata: ${JSON.stringify(obj)}\n\n`);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    ...SECURITY_HEADERS,
  });

  write('message_start', {
    type: 'message_start',
    message: {
      id: `msg_${trace().slice(0, 32)}`,
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      // input_tokens 在流开始时上游还没给，先用字符数粗估；真实值在
      // message_delta 里补正。给 0 会让 Claude Code 的上下文占用显示失真。
      usage: { input_tokens: estInputTokens, output_tokens: 0 },
    },
  });

  let blockIndex = -1;
  let openKind = null; // null | 'text' | 'tool'
  const toolSlots = new Map(); // 上游 tool_calls 的 index -> { blockIndex, id, name }

  const closeOpen = () => {
    if (openKind !== null) {
      write('content_block_stop', { type: 'content_block_stop', index: blockIndex });
      openKind = null;
    }
  };

  let finishReason = null;
  let usage = null;
  let streamError = null;
  const reader = up.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const raw = line.slice(5).trim();
        if (!raw || raw === '[DONE]') continue;
        let j; try { j = JSON.parse(raw); } catch { continue; }
        if (j.usage) usage = j.usage;
        const choice = (j.choices || [])[0];
        if (!choice) continue;
        if (choice.finish_reason) finishReason = choice.finish_reason;
        const d = choice.delta || {};

        if (typeof d.content === 'string' && d.content) {
          if (openKind !== 'text') {
            closeOpen();
            blockIndex++;
            openKind = 'text';
            write('content_block_start', {
              type: 'content_block_start',
              index: blockIndex,
              content_block: { type: 'text', text: '' },
            });
          }
          write('content_block_delta', {
            type: 'content_block_delta',
            index: blockIndex,
            delta: { type: 'text_delta', text: d.content },
          });
        }

        for (const tc of d.tool_calls || []) {
          if (!tc) continue;
          const upIdx = typeof tc.index === 'number' ? tc.index : 0;
          let slot = toolSlots.get(upIdx);
          if (!slot) {
            // 新工具块：必须先把上一个块关掉，索引才能前进
            closeOpen();
            blockIndex++;
            slot = {
              blockIndex,
              id: tc.id || `toolu_${trace().slice(0, 24)}`,
              name: tc.function?.name || '',
            };
            toolSlots.set(upIdx, slot);
            openKind = 'tool';
            write('content_block_start', {
              type: 'content_block_start',
              index: slot.blockIndex,
              content_block: { type: 'tool_use', id: slot.id, name: slot.name, input: {} },
            });
          } else if (tc.function?.name && !slot.name) {
            slot.name += tc.function.name;
          }
          if (typeof tc.function?.arguments === 'string' && tc.function.arguments) {
            write('content_block_delta', {
              type: 'content_block_delta',
              index: slot.blockIndex,
              delta: { type: 'input_json_delta', partial_json: tc.function.arguments },
            });
          }
        }
      }
    }
  } catch (e) {
    streamError = e;
    log('anthropic stream interrupted', e.message);
  }

  closeOpen();
  write('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: anthropicStopReason(finishReason), stop_sequence: null },
    usage: {
      input_tokens: Number(usage?.prompt_tokens) || estInputTokens,
      output_tokens: Number(usage?.completion_tokens) || 0,
    },
  });
  write('message_stop', { type: 'message_stop' });
  res.end();
  return { finishReason, usage, streamError };
}

// ── Usage accounting (local only) ────────────────────────────────────────
/**
 * 本地请求账本（`bridge/usage.jsonl`）。**只记元数据，从不记对话内容**：
 * 时间、模型、是否流式、耗时、token 数、扣分；失败时记状态码与错误码。
 *
 * 成功与失败写同一个文件，靠 `ok` 区分——旧记录没有该字段，一律按成功处理。
 * 把失败也记下来是必要的：否则「某个模型调不通」在控制台上完全不可见，
 * 只能去翻原始日志。
 *
 * 上限 MAX_USAGE_LINES 条，超出后截断保留最近一半，避免文件无限增长。
 */
const MAX_USAGE_LINES = 2000;
let usageLines = null;
/**
 * 上次与账本文件同步后的**指纹**（字节数 + mtimeMs），用来发现「文件被外部改动」。
 *
 * 为什么不能只用字节数比大小：镜像可能是空的（`usageBytes === 0`，例如外部刚把
 * 文件删掉、或进程还没记过任何账），这时 `size < usageBytes` 恒为 false ——
 * 于是外部随后写进来的**任何**文件都不会触发重载，镜像会永久性地读成空。
 * 实测这条在「删除文件 → 外部写入新账本」的序列里会真实发生（D4-E7）。
 * 带上 mtime 后，"外部换了个文件" 与 "我们自己刚追加过" 就能区分开。
 */
let usageBytes = 0;
let usageMtimeMs = -1;
/** 账本位置：与脚本同目录（即 bridge/），可用环境变量覆盖。 */
function usageFile() {
  return process.env.WORKBUDDY_USAGE_FILE
    || join(dirname(fileURLToPath(import.meta.url)), 'usage.jsonl');
}

/** 读文件指纹；文件不存在时返回 { size: 0, mtimeMs: -1 }。 */
function usageStat(file) {
  try {
    const st = existsSync(file) ? statSync(file) : null;
    return st ? { size: st.size, mtimeMs: st.mtimeMs } : { size: 0, mtimeMs: -1 };
  } catch {
    return { size: 0, mtimeMs: -1 };
  }
}

function loadUsageLines(file) {
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  usageLines = text.split('\n').filter(Boolean);
  usageBytes = Buffer.byteLength(text);
  usageMtimeMs = usageStat(file).mtimeMs;
}

/**
 * 错误摘要：单行、截断。
 *
 * 上游的错误消息是协议层的（`code` + 一句说明），**不含用户输入**；这里再截一刀
 * 防止异常里夹带整段 HTML（APISIX 的 401 就是一大段 HTML）。
 */
function shortError(text, limit = 160) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > limit ? `${s.slice(0, limit)}…` : s;
}

/**
 * 确保内存镜像与文件一致，必要时重新加载。
 *
 * 抽成独立函数是因为它现在有**两个**调用方：`recordRequest`（写之前要确认
 * 镜像没被外部清空）和 `readUsageRows`（读之前同样要确认）。这段判断是语义
 * 核心，复制成两份迟早会分叉。
 *
 * **判据：文件指纹与上次同步时不一致就重载。** 指纹 = 字节数 + mtimeMs。
 *
 * 演进过程（两次都栽在"只比大小"上，记下来免得再犯）：
 *   - 最初只判 `size < usageBytes`。这能覆盖「清空账本」（0 字节）与「截断」，
 *     但**镜像为空时失效**：`usageBytes === 0` 意味着 `size < 0` 恒为 false，
 *     外部此后写的任何文件都不会被看到。实测 D4-E7 就是这样读成空账本的
 *     （外部删除文件 → 换入一个非空文件 → 桥永远读 0 条），而 HEAD 的全量
 *     重读没有这个问题。
 *   - 补 `mtimeMs < usageMtimeMs` 也没救：外部**新写**的文件 mtime 只会变大。
 *
 * 所以改成「指纹不等就重载」。这样「删除→重建」「换成另一个文件」「清空」
 * 全都能覆盖，代价只是我们自己每次 append 后要刷新一次指纹
 * （见 recordRequest 末尾），否则会把自己的写入误判成外部改动、白重载一次。
 *
 * `usageLines === null`（进程刚起，一次请求都还没记过）也走这里初始化：
 * 这正是 D4 之前缺失的路径 —— 冷启动后第一个 `/v1/usage` 请求读不到内存副本，
 * 只能回磁盘，改成镜像优先之后必须有地方把它建起来。
 */
function syncUsageMirror(file) {
  if (usageLines === null) {
    loadUsageLines(file);
    return;
  }
  const { size, mtimeMs } = usageStat(file);
  if (size !== usageBytes || mtimeMs !== usageMtimeMs) loadUsageLines(file);
}

function recordRequest(entry) {
  try {
    const file = usageFile();
    syncUsageMirror(file);

    const line = JSON.stringify({ t: Date.now(), ...entry });
    usageLines.push(line);
    if (usageLines.length > MAX_USAGE_LINES) {
      usageLines = usageLines.slice(-Math.floor(MAX_USAGE_LINES / 2));
      const text = `${usageLines.join('\n')}\n`;
      writeFileSync(file, text);
      usageBytes = Buffer.byteLength(text);
    } else {
      appendFileSync(file, `${line}\n`);
      usageBytes += Buffer.byteLength(`${line}\n`);
    }
    // 我们自己刚写过，指纹要跟上：否则下一次 syncUsageMirror 会把自己的写入
    // 当成「外部改动」而白重载一次（虽然结果正确，纯属浪费一次全文件解析）。
    usageMtimeMs = usageStat(file).mtimeMs;
  } catch (e) {
    log('usage record failed', e.message); // 记账失败绝不影响请求
  }
}

/** 清空账本：文件与进程内副本一起重置（DELETE /v1/usage）。 */
function resetUsageLedger() {
  const file = usageFile();
  writeFileSync(file, '');
  usageLines = [];
  usageBytes = 0;
  usageMtimeMs = usageStat(file).mtimeMs;
}

/**
 * 读账本原始行（解析失败的行直接跳过）。
 *
 * 优先用内存镜像（`usageLines`），不再每次 `readFileSync` 全文件 + 逐行
 * `JSON.parse`：这个函数被 `/v1/usage` 与 `/v1/requests` 调用，而控制台每 20 秒
 * 轮询一次、插件面板也按 interval 拉 —— 每次重读磁盘并解析 2000 行 JSON，
 * 纯属把事件循环堵上一段，而进程里本来就有一份同步的副本。
 *
 * 镜像里的行是**写入时的原样字符串**（`recordRequest` 只 push 不重排），所以
 * 解析结果与直接读文件**逐字节等价**；输出结构因此完全不变。
 *
 * 保留的唯一磁盘访问是 `syncUsageMirror` 里的 `statSync` —— 它撑住「外部清空
 * 账本」的语义，删掉就会让已清掉的历史被下一次整块重写带回来。
 */
function readUsageRows() {
  try {
    syncUsageMirror(usageFile());
    return usageLines
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter((r) => r && typeof r.t === 'number');
  } catch {
    return [];
  }
}

/**
 * 最近请求明细（新的在前）。
 *
 * 只回元数据白名单字段——**不回请求体、不回消息内容**，即使账本里将来多写了字段
 * 也不会泄漏出去。
 */
function recentRequests(limit = 50) {
  const rows = readUsageRows();
  return rows.slice(-limit).reverse().map((r) => ({
    t: r.t,
    model: r.model || '',
    stream: r.stream === true,
    ms: Number(r.ms) || 0,
    ok: r.ok !== false,
    ...(r.ok === false
      ? { status: Number(r.status) || 0, code: r.code ?? null, error: shortError(r.error) }
      : {}),
    ...(typeof r.promptTokens === 'number' ? { promptTokens: r.promptTokens } : {}),
    ...(typeof r.completionTokens === 'number' ? { completionTokens: r.completionTokens } : {}),
    ...(typeof r.credit === 'number' ? { credit: r.credit } : {}),
  }));
}

/**
 * 本地日期 `YYYY-MM-DD`。
 *
 * 必须与页面其它地方（「最近请求」用 getHours() 显示本地时间）同一时区口径。
 * `toISOString().slice(0,10)` 取的是 **UTC 日期**，UTC+8 下凌晨 00:00–07:59 的
 * 调用会被记进前一天，趋势图看起来「少了一天、多了一天」。
 */
function localDay(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 本地时区的小时键 `YYYY-MM-DD HH`。与 localDay() 同一套补零规则，**不用 UTC**——
 *  否则页面上的「今天 13 时」会和用户墙上时钟错位。 */
function localHour(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}`;
}

/** 汇总用量：总数、按模型、按天（本地日期）、按小时（可选），外加失败统计（失败不计入 token / 扣分）。 */
function summarizeUsage(days = 7, opts = {}) {
  // 小时桶只在显式要求时才算：7/30 天视图用不到，白算 24 个桶没意义。
  const wantHours = opts.hours === true;

  // 小时视图把窗口**对齐到整点**（从当前整点往前推 23 小时，共 24 个整点桶）。
  // 若沿用 `now - 24h` 的滚动窗口，最旧那个桶只会统计到半截，图上合计就和
  // 面板的 total 对不上了——「图上的每个数字都能在面板里对上」是硬要求。
  // 不用小时桶时（wantHours=false）走原来的滚动窗口，既有语义完全不变。
  const hourAnchor = (() => { const a = new Date(); a.setMinutes(0, 0, 0); return a.getTime(); })();
  const since = wantHours ? hourAnchor - 23 * 3600000 : Date.now() - days * 86400000;

  const rows = readUsageRows();

  const byModel = new Map();
  const byDay = new Map();
  const byHour = wantHours ? new Map() : null;
  const failures = [];
  // creditCalls 单独计数：上游**并非每次**都回报 credit。不区分「回报了 0」和
  // 「没回报」的话，两者在页面上只能显示成同一个「—」，看起来像统计坏了。
  // 另外上游是**两位小数**量化，几十 token 的小请求真实扣分就是 0.00——
  // 那是「这次没扣到」，不是「没数据」。
  let total = { calls: 0, promptTokens: 0, completionTokens: 0, ms: 0, credit: 0, creditCalls: 0, failed: 0 };

  for (const r of rows) {
    if (r.t < since) continue;

    // 失败的请求单独归类：它没有 token、没有扣分，混进成功率会误导
    if (r.ok === false) {
      total.failed += 1;
      failures.push({
        t: r.t,
        model: r.model || '',
        stream: r.stream === true,
        ms: Number(r.ms) || 0,
        status: Number(r.status) || 0,
        code: r.code ?? null,
        error: shortError(r.error),
      });
      continue;
    }

    const pt = Number(r.promptTokens) || 0;
    const ct = Number(r.completionTokens) || 0;
    const hasCredit = typeof r.credit === 'number';
    const cr = hasCredit ? r.credit : 0;

    total.calls += 1;
    total.promptTokens += pt;
    total.completionTokens += ct;
    total.ms += Number(r.ms) || 0;
    if (hasCredit) { total.credit += cr; total.creditCalls += 1; }

    const m = byModel.get(r.model)
      || { model: r.model, calls: 0, promptTokens: 0, completionTokens: 0, ms: 0, credit: 0, creditCalls: 0 };
    m.calls += 1; m.promptTokens += pt; m.completionTokens += ct; m.ms += Number(r.ms) || 0;
    if (hasCredit) { m.credit += cr; m.creditCalls += 1; }
    byModel.set(r.model, m);

    const day = localDay(r.t);
    const d = byDay.get(day) || { day, calls: 0, promptTokens: 0, completionTokens: 0, credit: 0, creditCalls: 0 };
    d.calls += 1; d.promptTokens += pt; d.completionTokens += ct;
    if (hasCredit) { d.credit += cr; d.creditCalls += 1; }
    byDay.set(day, d);

    if (byHour) {
      const hour = localHour(r.t);
      const h = byHour.get(hour) || { key: hour, calls: 0, promptTokens: 0, completionTokens: 0, credit: 0, creditCalls: 0 };
      h.calls += 1; h.promptTokens += pt; h.completionTokens += ct;
      if (hasCredit) { h.credit += cr; h.creditCalls += 1; }
      byHour.set(hour, h);
    }
  }

  // 浮点累加会攒出 0.6900000000000001 这种噪声，出接口前收一下
  const round4 = (n) => Math.round(n * 10000) / 10000;
  total.credit = round4(total.credit);
  for (const m of byModel.values()) m.credit = round4(m.credit);
  for (const d of byDay.values()) d.credit = round4(d.credit);

  // 补齐 24 个桶：没调用的整点也要出现（记 0），否则柱状图会跳变——
  // 空的那小时直接消失，看上去像时间轴缺了一段。
  let hours = null;
  if (byHour) {
    for (const h of byHour.values()) h.credit = round4(h.credit);
    hours = [];
    for (let i = 23; i >= 0; i -= 1) {
      const key = localHour(hourAnchor - i * 3600000);
      hours.push(byHour.get(key) || { key, calls: 0, promptTokens: 0, completionTokens: 0, credit: 0, creditCalls: 0 });
    }
  }

  return {
    windowDays: days,
    total,
    models: [...byModel.values()].sort((a, b) => b.calls - a.calls),
    days: [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)),
    // 只有 ?hours=1 才带这个字段（checklist R1.4-4：按需计算，不白算）
    ...(hours ? { hours } : {}),
    // 最近 20 条失败，新的在前；页面用它做「为什么调不通」的第一手线索
    failures: failures.slice(-20).reverse(),
  };
}

// ── Model list ───────────────────────────────────────────────────────────
/**
 * 判定「明显不能对话」的内部模型 —— 完全基于上游目录字段，不猜哪些能调通。
 *
 * 实测样本：`nes-gf` 没有上下文窗口（maxInputTokens 缺省）、最大输出仅 256、
 * 也没有倍率，选中它必然失败。规则只排除**同时**满足「未声明上下文」与
 * 「声明了输出上限但低于 1024」的条目；字段缺失无法判定的一律保留。
 */
function isNonChatModel(m) {
  const ctx = Number(m?.maxInputTokens) || 0;
  const out = Number(m?.maxOutputTokens) || 0;
  return ctx <= 0 && out > 0 && out < 1024;
}

/**
 * 模型目录端点。两个端点返回的**不是同一份目录**：
 *
 *   /v2/enterprises/personal/models  具体模型（带 credits 倍率、tags）
 *   /v3/config                       产品配置，其中 models 是**档位/内部型号**
 *                                    （default-model、enhance-1.0 这类）
 *
 * 单用任何一个都会漏。客户端界面里能看到的具体模型（Deepseek-V4.1-Flash、
 * GLM-5.3、Kimi-K3…）来自前者；所以这里**两个都请求、按 id 合并**，
 * 具体模型优先，档位补在后面。
 */
const CATALOG_PATHS = ['/v2/enterprises/personal/models', '/v3/config'];

function catalogPathsFor() {
  return CATALOG_PATHS;
}

const CATALOG_TTL_MS = 5 * 60 * 1000;
// `upstreamModelCount` 初值必须是 0：冷启动时一个模型都没看过，此时任何请求都
// 该放行。它同时也是「模型预校验能不能启用」的唯一开关（见 preflightModelError）。
let catalogCache = { at: 0, models: [], shape: null, upstreamModelCount: 0 };
let catalogRefreshing = null;

/**
 * 触发一次目录刷新；同一时刻只允许一个在飞（并发调用复用同一个 Promise）。
 *
 * 返回 `{ ok, at }`：`ok` 表示这次确实把缓存更新了（失败或空目录都算 false）。
 * 手动刷新目录（`/v1/models?refresh=1`）要靠它判断「是不是白刷了一次」，
 * 以便如实告诉用户「刷新失败，仍显示旧缓存」。
 */
function refreshCatalog() {
  if (catalogRefreshing) return catalogRefreshing;
  catalogRefreshing = fetchCatalog()
    .then((r) => ({ ok: r.upstreamOk, at: catalogCache.at }))
    .catch((e) => {
      log('catalog fetch failed', e.message);
      return { ok: false, at: catalogCache.at };
    })
    .finally(() => { catalogRefreshing = null; });
  return catalogRefreshing;
}

/**
 * 模型目录。
 *
 * 冷启动（还没有任何缓存）才同步抓一次；已有缓存一律**立刻返回**，过期只在
 * 后台刷新。控制台的健康探测超时是 4 秒，而抓目录要串行打两个上游端点——
 * 把这段延迟转嫁给调用方，会让「桥在跑」被误判成「桥没起」。
 */
async function upstreamCatalog() {
  if (!catalogCache.models.length) await refreshCatalog();
  else if (Date.now() - catalogCache.at > CATALOG_TTL_MS) refreshCatalog();
  return catalogCache.models;
}

/**
 * 是否对请求里的 model 做目录预校验。`WORKBUDDY_SKIP_MODEL_PREFLIGHT=1` 关闭。
 *
 * 为什么必须留这个开关：上游目录**已知是不完整的** —— 上面 fetchCatalog 里
 * 「FEATURED 补全」那段注释记着同一件事（国际版能调 deepseek-v4.1-flash，
 * 目录端点里却没有它）。目录滞后于实际上线模型时，预校验会**误杀一个本来
 * 能用的模型**，这比「省一次上游往返」严重得多。所以：默认开（它能挡住的
 * 是绝大多数拼错 id 的调用），但必须给用户一个立刻能关掉它的出口。
 */
const MODEL_PREFLIGHT_ENABLED = process.env.WORKBUDDY_SKIP_MODEL_PREFLIGHT !== '1';

/**
 * 客户端送来的模型 id 长度上限。
 *
 * 为什么必须有：model 是**客户端可控**且会被**存进账本、写进日志、原样回显**
 * 的字段（400 响应体、/v1/requests、/v1/usage 的分组键）。实测：一个 30 万字符
 * 的 model 会让账本单行变成 30 万字符（文件 600KB/次）、让 400 响应体也是
 * 30 万字符、让 /v1/requests 回显 30 万字符 —— 反复打就能把磁盘/内存灌爆。
 * 真实模型 id 都很短（`deepseek-v4.1-flash` 19 字符），200 是极宽松的上限。
 */
const MAX_MODEL_ID_LEN = 200;

/**
 * 模型 id 会被当作 `X-Model-ID` 请求头发给上游，所以**必须只含 HTTP 头能承载的字符**。
 *
 * 这条约束与「模型在不在目录里」无关，因此**不能交给 `preflightModelError`** ——
 * 后者在目录没拿到时会直接放行（`upstreamModelCount === 0`）。而目录没拿到是常见状态：
 * 冷启动、上游目录接口抖动，以及用户按桥自己的提示设了
 * `WORKBUDDY_SKIP_MODEL_PREFLIGHT=1`。
 *
 * 不校验的后果（实测）：传 `模型-中文名` → Node 的 `http.request` 抛
 * `Invalid character in header content ["X-Model-ID"]` → 外层 catch 把它当未知故障，
 * 客户端收到 **500** 与一段内部报错。含 CR/LF 同理（Node 会拒绝，所以**不存在注入**，
 * 但用户拿到的仍是一个无法理解的 500）。
 *
 * 真实模型 id 都是可见 ASCII（见 `/v1/models`），所以这个约束挡不掉任何合法请求。
 */
const HEADER_SAFE_RE = /^[\x20-\x7e]*$/;

/**
 * chat 前的本地模型预校验。返回错误文本表示「该拒」，返回 null 表示「放行」。
 *
 * **启用条件只有一个：`catalogCache.upstreamModelCount > 0`** —— 即这一轮缓存里
 * 确实有模型是从上游目录端点拿到并留下的。
 *
 * 这里踩过一个真实的坑，记下来免得再犯：最初的判据是 `catalogCache.models.length
 * > 0`，看起来等价，其实完全不等价 —— `fetchCatalog` 末尾会用 FEATURED **无条件**
 * 补全，所以只要两个目录端点都**不返回 5xx**（404 / 字段改名 / 返回空数组 /
 * 模型全被 isNonChatModel 过滤掉…），缓存里也至少躺着 3 个精选模型。
 * 于是「桥对真实目录一无所知」被误判成「目录已知」，任何不在 FEATURED 里的
 * 真实可用模型都会被本地 400 拦下、一次上游都不打 —— 正是这条预校验本该
 * 避免的伤害。FEATURED 是**给客户端兜底的展示数据**，不是目录已知的证据。
 * 实测这条误杀在 404 / 空数组 / 字段改名 / 全被 supportsToolCall:false 挡掉
 * 四种常见故障下**全部可达**（只有 500 硬失败那条路径是对的）。
 *
 * 计数为 0（目录未知）时一律放行：我们不知道有哪些模型，就不该猜。
 *
 * 判定用 `catalogCache` 而不是 `upstreamCatalog()`：后者是 async 且可能触发一次
 * 抓取，放在请求路径上会把「校验」变成「多等几秒」。预校验的卖点就是省一次
 * 上游往返，不能自己先花掉一次。
 *
 * **FEATURED 仍然要在放行名单里**：`/v1/models` 在缓存为空时会退回 FEATURED
 * 定义（见那个端点的 `if (!catalog.length)` 分支），也就是桥刚刚才把这些 id
 * 告诉过客户端。若预校验只认缓存，就会出现「桥让你选 deepseek-v4.1-flash，
 * 转头又说这个模型不在目录里」的自相矛盾。所以放行判断是「在目录里 **或**
 * 在精选定义里」—— 桥对外承诺过的 id 一律不能自己否掉。
 * 注意这两件事是分开的：FEATURED 参与**放行**，但不参与**激活**预校验。
 */
function preflightModelError(model) {
  if (!MODEL_PREFLIGHT_ENABLED) return null;
  // 只在「真的从上游拿到过模型」时才敢拒。404 / 空数组 / 字段改名 / 全被过滤
  // 以及 5xx 硬失败，全都落在这个 0 上。
  if (!catalogCache.upstreamModelCount) return null;
  const catalog = catalogCache.models;
  if (!catalog.length) return null; // 理论上计数 > 0 时不会为空，兜一手
  if (typeof model !== 'string' || !model) return null; // 交给后面的默认值逻辑
  if (catalog.some((m) => m.id === model)) return null;
  if (FEATURED.some((f) => f.id === model)) return null;

  // 提示要**可操作**：光说「模型不存在」，用户下一步只能去猜。这里给出三个
  // 真实出口 —— 看完整目录（默认只回精选，具体模型在 ?all=1 里）、刷新目录
  // （缓存可能过期）、关掉预校验（目录可能漏了这个模型）。
  return `workbuddy-bridge: model "${model}" is not in the current catalog`
    + ` (${catalog.length} models). Check GET /v1/models?all=1 for the full list`
    + ' or GET /v1/models?refresh=1 if the catalog may be stale;'
    + ' set WORKBUDDY_SKIP_MODEL_PREFLIGHT=1 to forward unknown model ids anyway.';
}

async function fetchCatalog() {
  // 是否**真的**从上游取到了目录。下面 FEATURED 补全会让 merged 永远非空，
  // 所以不能靠「目录非空」判断这次抓取成没成功。
  let upstreamOk = false;
  // 上游目录里**真正进了缓存的**模型条数（即通过了下面那套过滤、且不是
  // FEATURED 补出来的）。这才是「桥认识哪些模型」的唯一硬证据：
  // upstreamOk 只说明「端点回了 models 数组」，一个空数组也算 true，
  // 而全被过滤掉的情况（非对话模型 / supportsToolCall:false）同样算 true。
  // 模型预校验只有在这个计数 > 0 时才敢启用（见 preflightModelError）。
  let upstreamModelCount = 0;
  // 是否遇到**硬失败**（上游 5xx / 网络异常 / 解析异常）。硬失败时绝不用半份
  // 目录顶掉完整缓存——否则用户的模型列表会凭空少几个，还看不出原因。
  let hardError = false;
  try {
    const auth = readStoredAuth();
    const shape = { paths: catalogPathsFor(), sources: {}, model: [] };
    const merged = new Map();
    const promotions = new Map(); // modelId → 徽章文案（如「Free now」）

    for (const path of catalogPathsFor()) {
      try {
        const res = await fetch(`${auth.endpoint}${path}`, {
          headers: buildHeaders(auth, '', ''),
          signal: AbortSignal.timeout(8000),
        });
        // 5xx 是上游临时故障 → 硬失败；4xx / 端点没有 models 字段只算「这个
        // 区域没有这个端点」，不能因此让目录永远不更新。
        if (res.status >= 500) {
          hardError = true;
          shape.sources[path] = `HTTP ${res.status}`;
          continue;
        }
        const body = await res.json();
        // 包裹层级随端点而异，都试一遍
        const list = body?.data?.models
          ?? body?.data?.data?.models
          ?? body?.data?.Data?.models;
        if (!Array.isArray(list)) {
          shape.sources[path] = `no models (HTTP ${res.status})`;
          continue;
        }
        upstreamOk = true;
        shape.sources[path] = list.length;
        for (const m of list) {
          if (!m || typeof m.id !== 'string') continue;
          if (!merged.has(m.id)) merged.set(m.id, m);
        }
        if (!shape.model.length && list[0]) shape.model = Object.keys(list[0]);

        // 诊断：客户端界面里的模型可能有别的来源，把这些候选字段的类型记下来
        const d = body?.data || {};
        shape.dataKeys = Object.keys(d);
        // agents[].models 可能是另一个模型来源，值得单独看
        const ag = d.agents;
        if (Array.isArray(ag)) {
          const holders = ag.filter((a) => a && Array.isArray(a.models) && a.models.length);
          shape.agentsWithModels = holders.length;
          if (holders[0]) {
            shape.agentModelsSample = JSON.stringify(holders[0].models.slice(0, 4));
            shape.agentName = holders[0].name;
          }
        }
        const wl = d.fillToolCallContentModelWhitelist;
        if (Array.isArray(wl)) shape.whitelistSample = JSON.stringify(wl.slice(0, 6));

        for (const key of ['agents', 'fillToolCallContentModelWhitelist', 'productFeatures']) {
          const v = d[key];
          if (Array.isArray(v)) {
            const first = v.find((x) => x && typeof x === 'object');
            shape[key] = `array(${v.length})${first ? ` keys=${Object.keys(first).join('/')}` : ''}`;
          } else if (v && typeof v === 'object') {
            shape[key] = `object keys=${Object.keys(v).slice(0, 8).join('/')}`;
          } else {
            shape[key] = typeof v;
          }
        }

        // modelPromotions 是**促销标注**（badge/discount + modelIds），不是模型本身：
        // 它给已有模型挂上「Free now」这类徽章，别把它当模型加进目录。
        const promos = body?.data?.modelPromotions;
        if (Array.isArray(promos) && promos.length) {
          shape.sources[`${path}#modelPromotions`] = promos.length;
          if (!shape.promotionFields) shape.promotionFields = Object.keys(promos[0] || {});
          shape.promotionDetail = promos.map((p) => ({
            badge: typeof p.badge === 'object' ? JSON.stringify(p.badge) : p.badge,
            discount: p.discount,
            enabled: p.enabled,
            kind: p.kind,
            models: p.modelIds,
          }));
          for (const p of promos) {
            if (!p || typeof p !== 'object' || p.enabled === false) continue;
            // badge 可能是字符串，也可能是 {text,color} 这类对象
            let label = p.badge;
            if (label && typeof label === 'object') {
              label = label.text || label.label || label.name || label.value || '';
            }
            if (!label && typeof p.discount === 'number' && p.discount > 0) {
              label = `-${p.discount}%`;
            }
            if (typeof label !== 'string' || !label) continue;
            // discount.factor === 0（或 discountedCredits 为 "0x"）表示该模型当前免费
            const free = p.discount?.factor === 0
              || /^0x$/i.test(String(p.discount?.discountedCredits || ''));
            for (const mid of (Array.isArray(p.modelIds) ? p.modelIds : [])) {
              if (typeof mid === 'string') promotions.set(mid, { label, free });
            }
          }
        }
      } catch (e) {
        hardError = true;
        shape.sources[path] = `error: ${e.message}`;
      }
    }

    // 在这里定格「上游给了几个模型」：**必须**在下面 FEATURED 补全之前取，
    // 因为补全之后 merged 至少会有 3 条，那个数字就不再代表上游了。
    // 用 merged.size 而不是各端点 list 长度之和：merged 是去重后的 Map，
    // 重复 id 不会把计数灌水，正好等于「桥实际认识多少个上游模型」。
    upstreamModelCount = merged.size;

    // 目录接口**并不完整**：国际版能成功调用 deepseek-v4.1-flash，
    // 但它不出现在任何一个目录端点里。因此把已知可用、目录却漏掉的模型补进来
    // ——能不能用最终由上游决定，列出来才有机会被选到。
    for (const f of FEATURED) {
      if (merged.has(f.id)) continue;
      // 倍率**不猜**：本区域目录没给这个模型，就说明不知道该区域的定价。
      // 早前直接套用 FEATURED 的值（那是国内实测），会把国际版的免费模型
      // 标成 0.11——除非促销明确说它免费（factor 0），否则一律留空。
      const promo = promotions.get(f.id);
      merged.set(f.id, {
        id: f.id,
        name: f.name,
        maxInputTokens: f.context,
        maxOutputTokens: f.maxOutput,
        ...(promo?.free ? { credits: 0 } : {}),
        _supplemented: true,
      });
      shape.supplemented = [...(shape.supplemented || []), f.id];
    }

    const models = [...merged.values()];
    if (models.length && !hardError) {
      // 目录里排掉的东西登记下来，便于在 /health 的 upstreamShape 里追溯
      shape.droppedNonChat = models.filter((m) => isNonChatModel(m)).map((m) => m.id);
      // 与写进缓存的 models 用**同一套过滤**，保证这个计数就是"桥认识几个模型"，
      // 不会因为过滤规则前后不一致而虚高。
      const kept = models.filter((m) => m.supportsToolCall !== false
        && !/^(codewise|hunyuan-image)/.test(m.id)
        && !isNonChatModel(m));
      // 过滤后还剩几个是**真的来自上游**的（FEATURED 补全项带 _supplemented 标记，
      // 要排除掉——否则补全又会把计数顶上去，等于没修）。
      const upstreamKept = kept.filter((m) => !m._supplemented).length;
      catalogCache = {
        at: Date.now(),
        models: kept.map((m) => ({
          id: m.id,
          name: m.name || m.id,
          context: m.maxInputTokens,
          maxOutput: m.maxOutputTokens,
          images: !!m.supportsImages,
          credits: m.credits,
          // 上游的推理能力标记：supportsReasoning=true 表示该模型接受推理强度控制
          //（选择器要据此显示"推理等级"下拉）；onlyReasoning 表示该模型只能以
          // 推理模式使用。不上报数据里的这两个字段，插件就无法给模型声明
          // reasoning 元数据 —— dsh 的选择器会少一个有用的控件。
          supportsReasoning: m.supportsReasoning === true,
          onlyReasoning: m.onlyReasoning === true,
          // 保留上游的说明与标签：国际版把具体型号写在 description 里，
          // 光看 id（default-model 这类档位名）无法判断它其实是哪个模型
          vendor: m.vendor,
          tags: m.tags,
          descriptionZh: m.descriptionZh,
          descriptionEn: m.descriptionEn,
          isDefault: m.isDefault,
          badge: promotions.get(m.id)?.label,
          free: promotions.get(m.id)?.free === true,
        })),
        // 诊断用：各端点的命中数量与模型字段名
        shape,
        /**
         * 缓存里**真正来自上游目录**、且能对话的模型条数。模型预校验的启用
         * 依据（见 preflightModelError），0 表示放行一切。
         *
         * 为什么不能用 `models.length > 0`：上面的 FEATURED 补全会**无条件**
         * 把 3 个精选模型塞进来，所以哪怕两个目录端点一个模型都没给出
         * （404 / 字段改名 / 空数组 / 全被 isNonChatModel 过滤），`models`
         * 照样非空。**非空 ≠ 已知**，差的就是这个 `_supplemented` 的排除。
         *
         * 也不要拿 upstreamOk 顶替：那个变量的语义是「端点回了一个 models
         * 数组」，空数组同样算 true，它服务于 /v1/models?refresh=1 的
         * "这次刷新算不算成功"提示，与本处的「桥认识几个模型」不是一回事。
         */
        upstreamModelCount: upstreamOk && !hardError ? upstreamKept : 0,
        // 原始计数留在诊断口径里，/health 的 upstreamShape 能直接看到
        upstreamModelsSeen: upstreamModelCount,
      };
    } else if (hardError) {
      log('catalog refresh failed; keeping cached catalog');
    }
  } catch (e) { log('catalog fetch failed', e.message); hardError = true; }
  return { models: catalogCache.models, upstreamOk: upstreamOk && !hardError };
}

/**
 * 精选模型：优先取 FEATURED 里**上游确实存在**的那些。
 *
 * 上游模型目录随地区而异——国际版（www.workbuddy.ai）就没有
 * deepseek-v4.1-flash，只有 default-model / fast-model 这类档位名。
 * 若一律照搬 FEATURED，就会报出上游根本没有的模型。
 */
function pickFeatured(catalog) {
  const byId = new Map(catalog.map((m) => [m.id, m]));
  // 精选模型始终保留：目录里没有的用定义值补上（上游目录并不完整，
  // 例如国际版能调 deepseek-v4.1-flash，但目录里没有它）。
  return FEATURED.map((f) => byId.get(f.id)
    ?? { id: f.id, name: f.name, context: f.context, maxOutput: f.maxOutput, credits: f.credits });
}

// ── Billing / credits ────────────────────────────────────────────────────
/**
 * 计费网关与 chat 网关**不是同一个主机**：
 *   国内 chat = copilot.tencent.com，计费 = www.codebuddy.cn
 *   国际 = www.workbuddy.ai（chat 与计费同域；codebuddy.ai 登录则用 www.codebuddy.ai）
 */
/**
 * 显式覆盖计费网关。正常部署下不设，按域名推断；
 * 自建网关或验收脚本可以指到本地 stub，否则签到这条路径没法在离线环境验证。
 */
const EXPLICIT_BILLING_BASE = process.env.WORKBUDDY_BILLING_BASE || '';

function billingBase(endpoint) {
  if (EXPLICIT_BILLING_BASE) return EXPLICIT_BILLING_BASE;
  const e = String(endpoint || '');
  if (e.includes('codebuddy.ai')) return 'https://www.codebuddy.ai';
  if (e.includes('workbuddy.ai')) return 'https://www.workbuddy.ai';
  return 'https://www.codebuddy.cn';
}

/** 计费类请求共用的请求头。 */
function billingHeaders(auth) {
  return {
    Authorization: `Bearer ${auth.access}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    ...(auth.userId ? { 'X-User-Id': auth.userId } : {}),
    ...(auth.enterpriseId ? { 'X-Enterprise-Id': auth.enterpriseId } : {}),
  };
}

/** 向计费网关发一次 POST，返回解包后的 data。 */
async function billingPost(auth, path, body = {}) {
  const res = await fetch(`${billingBase(auth.endpoint)}${path}`, {
    method: 'POST',
    headers: billingHeaders(auth),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const envelope = await res.json().catch(() => null);
  if (!res.ok || !envelope || envelope.code !== 0) {
    throw new Error((envelope && (envelope.msg || envelope.message)) || `HTTP ${res.status}`);
  }
  return typeof envelope.data === 'object' && envelope.data !== null ? envelope.data : {};
}

/** 今日签到状态（只读，不改状态）。 */
async function fetchCheckinStatus(auth) {
  const d = await billingPost(auth, '/v2/billing/meter/checkin-activity-status');
  const num = (k) => (typeof d[k] === 'number' ? d[k] : 0);
  return {
    active: d.active === true,
    todayCheckedIn: d.today_checked_in === true,
    streakDays: num('streak_days'),
    dailyCredit: num('daily_credit'),
    todayCredit: num('today_credit'),
    isStreakDay: d.is_streak_day === true,
    nextStreakDay: num('next_streak_day'),
    streakBonusDays: num('streak_bonus_days'),
    streakBonusCredit: num('streak_bonus_credit'),
  };
}

/**
 * 领取今日签到奖励。
 *
 * 重复签到上游会返回非零业务码（含「已签到」），那是**幂等成功**而非失败——
 * 今天的奖励已经在账上，报成失败反而会误导用户。
 */
async function claimDailyCheckin(auth) {
  try {
    const d = await billingPost(auth, '/v2/billing/meter/daily-checkin');
    const num = (k) => (typeof d[k] === 'number' ? d[k] : 0);
    return {
      ok: true,
      already: false,
      credit: num('credit'),
      streakDays: num('streak_days'),
      isStreakDay: d.is_streak_day === true,
    };
  } catch (e) {
    const msg = String(e.message || e);
    if (/已签到|already/i.test(msg)) {
      return { ok: true, already: true, credit: 0, message: msg };
    }
    throw e;
  }
}

// ── 每日自动签到（R11.2）────────────────────────────────────────────────
// 内存态：桥重启后重新判定（上游幂等兜底，重复签也只是「已签到」）。
// 触发点有两个：/v1/chat/completions 开头（fire-and-forget，绝不阻塞这次调用）
// 与**桥自己的定时器**（见 startAutoCheckinTimer 的说明）。
const AUTO_CHECKIN_COOLDOWN_MS = Number(process.env.WORKBUDDY_CHECKIN_COOLDOWN_MS || 3600000); // 失败后冷却 1 小时再试
const AUTO_CHECKIN_MAX_PER_DAY = 3;       // 当天最多试 3 次，避免对上游打无效请求
let autoCheckinDay = '';                  // 「今天已尝试」的本地日期
let autoCheckinDoneDay = '';              // 「今天已签成功」的本地日期 —— 当天不再重试
let autoCheckinTries = 0;
let autoCheckinLastAt = 0;
let autoCheckinInflight = null;
let autoCheckinState = null;              // { at, result, error?, credit? }

/**
 * 触发一次自动签到（不 await）。失败策略写死，避免对上游打无效请求：
 * 失败后冷却 1 小时、当天最多 3 次；上游「已签到」按**成功**处理。
 */
function maybeAutoCheckin() {
  if (!AUTO_CHECKIN_ENABLED) return;

  const today = localDay(Date.now());
  if (today !== autoCheckinDay) {
    autoCheckinDay = today;
    autoCheckinTries = 0;
    autoCheckinLastAt = 0;
  }
  // 今天已经签成功了就别再打上游 —— 没有这条的话，定时器每小时都会问一次
  // 「签了没」，而答案永远是「签了」。
  if (autoCheckinDoneDay === today) return;
  if (autoCheckinTries >= AUTO_CHECKIN_MAX_PER_DAY) return;
  if (autoCheckinLastAt && Date.now() - autoCheckinLastAt < AUTO_CHECKIN_COOLDOWN_MS) return;
  if (autoCheckinInflight) return;

  autoCheckinLastAt = Date.now();
  autoCheckinTries += 1;
  autoCheckinInflight = (async () => {
    try {
      const claim = await claimDailyCheckin(readStoredAuth());
      autoCheckinState = {
        at: new Date().toISOString(),
        // 上游「已签到」是成功，不是失败（复用 claimDailyCheckin 的幂等语义）
        result: claim.already ? 'already' : 'ok',
        credit: typeof claim.credit === 'number' ? claim.credit : 0,
      };
      // 「已签到」也算今天不用再管了
      autoCheckinDoneDay = localDay(Date.now());
      log('auto checkin', autoCheckinState.result, autoCheckinState.credit);
    } catch (e) {
      const msg = shortError(e);
      // 国际版网关没有积分系统：这不是「失败」，如实区分开
      const noActivity = /no.?activity|not.?support|无.?签到|不存在|not.?found/i.test(msg);
      autoCheckinState = {
        at: new Date().toISOString(),
        result: noActivity ? 'no-activity' : 'error',
        error: msg,
      };
      // 没有签到活动的地方永远不会「成功」，再试也是白试 —— 当天收工
      if (noActivity) autoCheckinDoneDay = localDay(Date.now());
      log('auto checkin', autoCheckinState.result, msg);
    } finally {
      autoCheckinInflight = null;
    }
  })();
}

/**
 * 桥自己的每日签到定时器。
 *
 * **为什么必须有这个**：签到原先只挂在 `/v1/chat/completions` 开头 ——
 * 也就是说「有人调模型」才顺带签一次。但**桥才是常驻后台的那个进程**，
 * 而用户完全可能一整天不调模型（刚装好还没接客户端、周末没写代码、
 * 只用网页版而没走这个桥……）。
 *
 * 实测就撞上了：桥从 13:03 一直跑着，10-07 一整天**没有一条模型请求**，
 * 于是**一次签到都没发生**，用户晚上打开控制台才发现还得手动签。
 *
 * 控制台侧的 hourly 定时覆盖不了这种情况 —— 它要求控制台开着，而控制台
 * 恰恰是用户平时会关掉的那个（关掉后桥会留下，这是刻意的）。
 * 所以「按天自动」这件事必须由常驻的那一方负责。
 *
 * 间隔取 1 小时与失败冷却同频：`maybeAutoCheckin` 自己会挡掉重复调用
 * （当天成功过、超次数、冷却中都会直接返回），这里不需要再判。
 */
function startAutoCheckinTimer() {
  if (!AUTO_CHECKIN_ENABLED) return;
  // 启动后先等一会儿再试：上游连接预热与目录抓取都在开头，别挤在一起。
  // 可调是为了让测试不必真等 20 秒（生产环境没有理由改它）。
  const kickMs = Number(process.env.WORKBUDDY_CHECKIN_KICK_MS || 20000);
  const kick = () => maybeAutoCheckin();
  setTimeout(kick, kickMs).unref?.();
  setInterval(kick, AUTO_CHECKIN_COOLDOWN_MS).unref?.();
}


/**
 * 只读查询积分余额（按套餐聚合）。
 *
 * 该端点不会消耗积分，可安全地按需调用。月度套餐（CapacityType=4）看
 * CycleCapacityRemain，一次性套餐看 CapacityRemain。
 */
async function fetchQuota(auth) {
  const pad = (n) => String(n).padStart(2, '0');
  const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    + ` ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const now = new Date();

  const res = await fetch(`${billingBase(auth.endpoint)}/v2/billing/meter/get-user-resource`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${auth.access}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(auth.userId ? { 'X-User-Id': auth.userId } : {}),
      ...(auth.enterpriseId ? { 'X-Enterprise-Id': auth.enterpriseId } : {}),
    },
    body: JSON.stringify({
      PageNumber: 1,
      PageSize: 100,
      ProductCode: 'p_tcaca',
      Status: [0, 3],
      PackageEndTimeRangeBegin: fmt(now),
      PackageEndTimeRangeEnd: fmt(new Date(now.getTime() + 3185136e6)),
    }),
    signal: AbortSignal.timeout(15000),
  });

  const body = await res.json().catch(() => null);
  if (!res.ok || !body || body.code !== 0) {
    throw new Error((body && (body.msg || body.message)) || `HTTP ${res.status}`);
  }

  const accounts = body?.data?.Response?.Data?.Accounts;
  const list = Array.isArray(accounts) ? accounts : [];
  let total = 0;
  const packages = [];
  for (const a of list) {
    if (!a || typeof a !== 'object') continue;
    const num = (k) => (typeof a[k] === 'number' ? a[k] : 0);
    const monthly = num('CapacityType') === 4;
    const size = monthly ? num('CycleCapacitySize') : num('CapacitySize');
    const remainRaw = monthly ? num('CycleCapacityRemain') : num('CapacityRemain');
    const remain = remainRaw < 0 ? 0 : remainRaw;
    if (!monthly && remain <= 0) continue;
    total += remain;
    packages.push({
      name: a.PackageName || '(unnamed)',
      remain,
      size,
      monthly,
      expiresAt: a.ExpiredTime || (monthly ? a.CycleEndTime : undefined) || undefined,
    });
  }
  return { total, packages, productCode: 'p_tcaca' };
}

// ── HTTP server ──────────────────────────────────────────────────────────
/**
 * chat 请求体上限。
 *
 * 32MB 这个数是**从最大合法请求倒推**的，不是随手取的：dsh / 控制台的「图片
 * 转 base64 内联」会把整张图塞进 messages，1MB 的 PNG 编码后约 1.37MB，一条
 * 多轮带图对话叠到十几 MB 是正常现象。控制台自己那条 readBody 只给 512KB ——
 * 那是**控制台内部**的管理类小请求，桥这边不能照抄，否则一张稍大的图就被拒。
 * 反过来，无上限就等于「一个坏客户端能把这个零依赖的本地进程内存吃干」。
 * 32MB 足够覆盖真实的多模态对话，又能在单个请求层面兜住内存。
 *
 * 可用 `WORKBUDDY_MAX_BODY_BYTES` 覆盖：上限是随用法变的（比如有人专门灌长
 * 上下文做压测），写死会让那种场景没有任何出口。
 */
const MAX_BODY_BYTES = Number(process.env.WORKBUDDY_MAX_BODY_BYTES || 32 * 1024 * 1024);

/**
 * 读取请求体，超过 MAX_BODY_BYTES 立刻失败。
 *
 * **超限时既不在这里 destroy，调用方也不 destroy** —— 这是两次实测才定下来的：
 *
 *   1. 控制台那份 readBody 是「fail() + req.destroy()」，桥这边不能照抄：destroy
 *      会把 socket 直接拆掉，413 还没写出去，客户端只收到 ECONNRESET。
 *   2. 于是改成「这里 pause()、调用方写完 413 再 destroy」—— **仍然不行**。
 *      实测（1MB~16MB）：pause() 之后客户端**还在继续发**，此时 destroy 让内核
 *      回 RST，客户端在读到 413 之前就被复位，丢失率最高到 10/10（8MB）。
 *      对照实验：把 destroy 换成 resume()、其余一字不改 → 0/50 丢失。
 *
 * 所以最终做法是：超限时 `req.pause()` 停止为它累计内存，调用方回完 413 后
 * 用 `req.resume()` 把剩余字节**读掉并丢弃**，让这条连接自然收尾。
 *
 * 代价是确实还会从网络上读走那部分字节 —— 但这不违背 D2 的目标：D2 要挡的是
 * 「无上限地往内存里 Buffer.concat」，而 resume() 之后没有任何东西被累计，
 * 每条请求仍有 MAX_BODY_BYTES 的硬上限兜底。
 *
 * 抛出的错误带上 `code = 'BODY_TOO_LARGE'`：调用方要据此回**明确的 413**，
 * 而不是和「JSON 解析失败」共用同一个 400。
 */
const readBody = (req, limit = MAX_BODY_BYTES) => new Promise((resolve, reject) => {
  let size = 0;
  let done = false;
  const chunks = [];
  req.on('data', (c) => {
    if (done) return; // 已经判定超限：后续在途 chunk 一律丢弃，不再累计
    size += c.length;
    if (size > limit) {
      done = true;
      const err = new Error(`request body exceeds ${limit} bytes`);
      err.code = 'BODY_TOO_LARGE';
      // 先停住继续灌数据，再 reject —— 顺序反过来的话，pause 之前可能又塞进来
      // 几个 chunk（Node 的 data 事件是同步派发的），白占内存。
      // 注意这里**只是暂停**：真正丢弃剩余字节要等 413 写完之后（见调用方）。
      req.pause();
      reject(err);
      return;
    }
    chunks.push(c);
  });
  req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks).toString('utf8')); } });
  // 连接被对端提前掐断等情况：已经 settle 过就别再 reject 一次
  req.on('error', (e) => { if (!done) { done = true; reject(e); } });
});

/**
 * 所有响应的基础安全头。
 *
 * `nosniff`：不让浏览器去猜 Content-Type（响应里既有 JSON 又有 SSE，猜错会
 * 把数据当可执行内容处理）。`frame-ancestors 'none'`：本服务不该被任何页面嵌。
 */
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "frame-ancestors 'none'",
};

const json = (res, status, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...SECURITY_HEADERS });
  res.end(body);
};

/**
 * 这个请求的 Origin 是否可以放行。
 *
 * **为什么必须校验：绑定 127.0.0.1 挡不住浏览器。** 恶意网页可以把域名解析到
 * 127.0.0.1（DNS rebinding），让浏览器把请求发到本机服务；响应被 CORS 挡住读不到，
 * 但**副作用已经发生** —— 桥会照常转发、消耗账号配额。实测：带
 * `Origin: https://evil.example` 的跨站形状请求（text/plain、无鉴权）得到 200，
 * 打桩上游确实被调用。桥自身的本地令牌默认是**空**，所以不能只靠令牌兜底。
 *
 * 判据：本机 CLI / SDK（curl、dsh 插件、控制台）**不发 Origin**，一律放行；
 * 带 Origin 的只放行**回环来源**（本机网页版客户端照常可用），其余一律拒绝。
 */
function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // 非浏览器调用（CLI / SDK / 内部代理）
  let host;
  try { host = new URL(origin).hostname; } catch { return false; } // 含 `Origin: null`
  const bare = String(host).replace(/^\[|\]$/g, '');
  return bare === '127.0.0.1' || bare === 'localhost' || bare === '::1';
}

/**
 * 本地令牌校验。两种写法都收：
 *   - `Authorization: Bearer <token>` —— OpenAI 系客户端的惯例
 *   - `x-api-key: <token>`            —— Anthropic 系客户端的惯例（Claude Code 用这个）
 *
 * 两者承载的是同一个「本机回环令牌」，用途完全一致，没有理由让用户为了换一个
 * 客户端就记两套写法。**只影响本机回环端口上的这一个校验点**，与上游凭据无关。
 */
function hasLocalToken(req) {
  if (req.headers.authorization === `Bearer ${LOCAL_TOKEN}`) return true;
  const key = req.headers['x-api-key'];
  return typeof key === 'string' && key === LOCAL_TOKEN;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (!originAllowed(req)) {
      return json(res, 403, { error: { message: 'workbuddy-bridge: cross-origin request rejected (this bridge serves local clients only)' } });
    }
    if (LOCAL_TOKEN && !hasLocalToken(req)) {
      return json(res, 401, { error: { message: 'workbuddy-bridge: bad or missing local token' } });
    }

    if (url.pathname === '/health') {
      let auth = null;
      try {
        const a = readStoredAuth();
        auth = { userId: a.userId, endpoint: a.endpoint, expiresAt: new Date(a.expiresAt).toISOString(), expired: a.expiresAt < Date.now() };
      } catch (e) { return json(res, 503, { ok: false, error: e.message, authFile: AUTH_PATH }); }
      // 这里**绝不能等上游**：控制台的探测超时是 4 秒，冷缓存时抓目录要好几秒，
      // 一旦超时就会被误判成「桥未运行」。有缓存立刻答，没有或过期都只触发后台刷新。
      if (!catalogCache.models.length || Date.now() - catalogCache.at > CATALOG_TTL_MS) refreshCatalog();
      const catalog = catalogCache.models;
      return json(res, 200, {
        ok: true,
        pid: process.pid,
        startedAt: new Date(STARTED_AT).toISOString(),
        uptimeMs: Date.now() - STARTED_AT,
        auth,
        authFile: AUTH_PATH,
        models: (catalog.length ? pickFeatured(catalog) : FEATURED).map((m) => m.id),
        catalogSize: catalog.length,
        catalogAt: catalogCache.at ? new Date(catalogCache.at).toISOString() : null,
        catalogRefreshing: !!catalogRefreshing,
        upstreamShape: catalogCache.shape || null,
        // 自动签到的内存态：桥重启后清空、重新判定（上游幂等兜底）
        autoCheckinEnabled: AUTO_CHECKIN_ENABLED,
        autoCheckin: autoCheckinState,
      });
    }

    if (url.pathname === '/v1/models') {
      const all = url.searchParams.get('all') === '1';
      // refresh=1：强制重取上游目录。失败**不清空旧缓存**——宁可给一份标了
      // 年纪的目录，也别让页面突然空白；staleMs 就是那个「年纪」。
      const wantRefresh = url.searchParams.get('refresh') === '1';
      let staleMs = null;
      if (wantRefresh) {
        const startedAt = Date.now();
        const r = await refreshCatalog();
        if (!r.ok) {
          // 只有缓存**确实比本次刷新更旧**才叫「旧缓存」。若本次刷新已经更新过
          // 缓存（例如冷启动只拿到部分目录），说「0 秒前的缓存」是误导。
          staleMs = catalogCache.at && catalogCache.at < startedAt ? Date.now() - catalogCache.at : null;
          log('models refresh failed; serving cached catalog',
            staleMs === null ? 'no usable cache' : `${Math.round(staleMs / 1000)}s old`);
        }
      }
      // 刚刷过就别再走 upstreamCatalog()（它在缓存为空时会再触发一次刷新，等于白打一轮上游）
      const catalog = wantRefresh ? catalogCache.models : await upstreamCatalog();

      let models;
      if (!catalog.length) {
        // 上游目录取不到：退回精选定义，至少让客户端能用
        models = FEATURED.map((f) => ({
          id: f.id, name: f.name, context: f.context, maxOutput: f.maxOutput, images: true,
        }));
      } else if (all) {
        models = catalog;
      } else {
        models = pickFeatured(catalog).map((u) => ({
          ...u,
          name: FEATURED.find((f) => f.id === u.id)?.name || u.name,
        }));
      }

      const list = models.map((m) => {
        const credits = creditsOf(m);
        return {
          id: m.id,
          object: 'model',
          created: Math.floor(Date.now() / 1000),
          owned_by: 'workbuddy',
          ...(m.name ? { name: m.name } : {}),
          ...(m.context ? { context_window: m.context } : {}),
          ...(m.maxOutput ? { max_output_tokens: m.maxOutput } : {}),
          ...(typeof credits === 'number' ? { credits } : {}),
          ...(m.images ? { supports_images: true } : {}),
          ...(m.supportsReasoning ? { supports_reasoning: true } : {}),
          ...(m.onlyReasoning ? { only_reasoning: true } : {}),
          ...(m.vendor ? { vendor: m.vendor } : {}),
          ...(Array.isArray(m.tags) && m.tags.length ? { tags: m.tags } : {}),
          ...(m.descriptionZh ? { description_zh: m.descriptionZh } : {}),
          ...(m.descriptionEn ? { description_en: m.descriptionEn } : {}),
          ...(m.badge ? { badge: m.badge } : {}),
          ...(m.free ? { free: true } : {}),
        };
      });
      // staleMs 只在「刷新失败、退回过期缓存」时出现；成功时不带这个字段
      return json(res, 200, { object: 'list', data: list, ...(staleMs !== null ? { staleMs } : {}) });
    }

    if (url.pathname === '/v1/quota') {
      try {
        const quota = await fetchQuota(readStoredAuth());
        return json(res, 200, { ok: true, ...quota });
      } catch (e) {
        return json(res, 502, { ok: false, error: e.message });
      }
    }

    if (url.pathname === '/v1/usage') {
      if (req.method === 'DELETE') {
        try {
          resetUsageLedger();
          return json(res, 200, { ok: true, cleared: true });
        } catch (e) {
          return json(res, 500, { ok: false, error: e.message });
        }
      }
      const days = Math.min(Math.max(Number(url.searchParams.get('days')) || 7, 1), 90);
      const hours = url.searchParams.get('hours') === '1';
      return json(res, 200, { ok: true, ...summarizeUsage(days, { hours }) });
    }

    if (url.pathname === '/v1/requests') {
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 500);
      return json(res, 200, { ok: true, requests: recentRequests(limit) });
    }

    if (url.pathname === '/v1/checkin') {
      try {
        const auth = readStoredAuth();
        if (req.method === 'POST') {
          const claim = await claimDailyCheckin(auth);
          const status = await fetchCheckinStatus(auth).catch(() => null);
          return json(res, 200, { ...claim, status });
        }
        return json(res, 200, { ok: true, status: await fetchCheckinStatus(auth) });
      } catch (e) {
        return json(res, 502, { ok: false, error: e.message });
      }
    }

    if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
      let raw;
      try {
        raw = await readBody(req);
      } catch (e) {
        if (e.code === 'BODY_TOO_LARGE') {
          // 明确的 413 + JSON：客户端要能一眼分清「请求太大」和「JSON 写错了」，
          // 这两种 400 类失败的处置方式完全不同。这里**不记账**是对的 ——
          // 连 body 都没读全，没有 model / 耗时可言，记一条全是 0 的账只会污染
          // 控制台的失败列表。
          log('rejected oversized body', e.message);
          const body = JSON.stringify({
            error: {
              message: `workbuddy-bridge: request body too large (limit ${MAX_BODY_BYTES} bytes);`
                + ' raise WORKBUDDY_MAX_BODY_BYTES if this is a legitimate multi-modal request',
              type: 'payload_too_large',
            },
          });
          res.writeHead(413, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...SECURITY_HEADERS });
          // 413 写完后 `resume()` 把剩余字节读掉丢弃。
          //
          // **不要改成 destroy()**：实测这样会让客户端在读到 413 之前就吃 RST
          // （8MB 下丢失率可达 10/10，详见 readBody 的注释）。resume() 之后
          // 没有任何东西被累计进内存，D2 的内存上限目标依然成立，而契约
          // （"明确的 413 JSON"）才真的兑现了。
          res.end(body);
          req.resume();
          return;
        }
        throw e;
      }
      let payload;
      try { payload = JSON.parse(raw); } catch { return json(res, 400, { error: { message: 'invalid JSON body' } }); }
      const wantStream = payload.stream === true;
      // model 的类型与长度必须**先收敛**：它是客户端可控字段，会进账本、进日志、
      // 还会被原样回显（见 MAX_MODEL_ID_LEN 的说明）。数组/对象/数字/布尔一律拒绝
      // —— 否则类型混淆会让"长度"判断失效（如数组的 length 是元素个数），而且
      // 静默换成默认模型等于"替用户换了个要计费的模型"，比直接报错更糟。
      // `null` 与缺省视同"没给"（沿用原有的回落行为），不当成类型错误。
      if (payload.model != null && typeof payload.model !== 'string') {
        return json(res, 400, { error: { message: 'workbuddy-bridge: "model" must be a string', type: 'invalid_request' } });
      }
      const model = payload.model || 'deepseek-v4.1-flash';
      if (model.length > MAX_MODEL_ID_LEN) {
        const message = `workbuddy-bridge: model id too long (${model.length} chars, max ${MAX_MODEL_ID_LEN})`;
        // 落账与日志都只留**截断版**：账本行必须有界，也绝不把这段垃圾原样回显
        const trimmed = shortError(model, MAX_MODEL_ID_LEN);
        log('rejected oversized model id', trimmed);
        recordRequest({
          model: trimmed, stream: wantStream, ms: 0, ok: false, status: 400, code: null, error: message,
        });
        return json(res, 400, { error: { message, type: 'invalid_request' } });
      }

      // 字符集校验：模型 id 会进 `X-Model-ID` 请求头，非可见 ASCII 会让
      // Node 的 http.request 直接抛异常（外层只能回 500）。见 HEADER_SAFE_RE 的说明。
      // **放在 preflightModelError 之前**：这是格式错误，与目录无关，任何时候都该拦。
      if (!HEADER_SAFE_RE.test(model)) {
        const message = 'workbuddy-bridge: model id must be printable ASCII'
          + ' (it is forwarded as the X-Model-ID header)';
        const trimmed = shortError(model, MAX_MODEL_ID_LEN);
        log('rejected non-ascii model id', trimmed);
        // 与其它拒绝路径一致地落账：否则这次拒绝在控制台「最近请求」里不可见
        recordRequest({
          model: trimmed, stream: wantStream, ms: 0, ok: false, status: 400, code: null, error: message,
        });
        return json(res, 400, { error: { message, type: 'invalid_request' } });
      }

      // 模型预校验：桥手里就有目录，拼错的 id 不该花一次上游往返（详见
      // preflightModelError 的注释）。放在 maybeAutoCheckin 之前是刻意的 ——
      // 一次注定失败的调用不该顺带触发签到。
      const modelError = preflightModelError(model);
      if (modelError) {
        log('rejected unknown model', model);
        // **必须落账**：否则这次拒绝在控制台「最近请求」里完全不可见，用户
        // 看到的是一个客户端报错、而账本上什么都没有，只能去翻原始日志 ——
        // 这正是 D3 想解决的场景，不记等于白改。
        recordRequest({
          model,
          stream: wantStream,
          ms: 0,
          ok: false,
          status: 400,
          code: null,
          error: modelError,
        });
        return json(res, 400, { error: { message: modelError, type: 'model_not_found' } });
      }

      // 每日自动签到：**先转发、后台补签**。放在这里是因为「有人调模型」
      // 就是「在用」的最强信号；不 await，绝不拖慢这次请求。
      maybeAutoCheckin();
      // diagnostics: log request shape only, never conversation content
      if (process.env.WORKBUDDY_SHAPE === '1') {
        const roles = {};
        let chars = 0;
        for (const m of payload.messages || []) {
          roles[m.role] = (roles[m.role] || 0) + 1;
          chars += JSON.stringify(m.content ?? '').length;
        }
        const sys = (payload.messages || []).find((m) => m.role === 'system' || m.role === 'developer');
        const hdrs = Object.keys(req.headers).sort();
        log('SHAPE ' + JSON.stringify({
          bodyKeys: Object.keys(payload).sort(),
          model, stream: payload.stream,
          roles, chars,
          sysChars: typeof sys?.content === 'string' ? sys.content.length : null,
          toolCount: payload.tools?.length ?? 0,
          toolNames: (payload.tools || []).map((t) => t?.function?.name).slice(0, 40),
          headers: hdrs,
          ua: req.headers['user-agent'],
        }));
      }
      log(`→ ${model} stream=${wantStream} msgs=${payload.messages?.length ?? 0} tools=${payload.tools?.length ?? 0}`);
      const startedAt = Date.now();

      // the backend is streaming-only: always stream upstream, aggregate for non-streaming clients
      const upstream = normalizePayload({ ...payload, stream: true, stream_options: { include_usage: true } });
      delete upstream.max_completion_tokens; // avoid conflicting with max_tokens semantics
      const conversationId = req.headers['x-conversation-id'] || trace();

      const ac = new AbortController();
      req.on('aborted', () => ac.abort());
      res.on('close', () => { if (!res.writableEnded) ac.abort(); });

      // 从这一刻起的任何异常都要落账：否则「登录文件坏了 / 取密钥失败」这类故障
      // 在控制台上完全不可见（只有原始日志里有），用户只能看到一个 500。
      try {
        const { res: up, bodyText } = await callUpstream(JSON.stringify(upstream), model, conversationId, ac.signal);
        if (!up.ok) {
          const text = bodyText ?? await up.text().catch(() => '');
          let parsed; try { parsed = JSON.parse(text); } catch {}
          log('upstream error', up.status, text.slice(0, 300));
          recordRequest({
            model,
            stream: wantStream,
            ms: Date.now() - startedAt,
            ok: false,
            status: up.status,
            code: typeof parsed?.code === 'number' ? parsed.code : null,
            error: parsed?.msg || parsed?.message || parsed?.error?.message || text,
          });
          return json(res, up.status === 200 ? 502 : up.status, parsed || { error: { message: text || `upstream HTTP ${up.status}` } });
        }

        if (wantStream) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
            ...SECURITY_HEADERS,
          });
          const reader = up.body.getReader();
          const decoder = new TextDecoder();
          let usageSeen = null;
          // 逐行解析，不用正则：上游的 usage 里含 completion_tokens_details /
          // prompt_tokens_details 这类**嵌套对象**，`\{[^{}]*\}` 根本匹配不上，
          // 结果是流式请求的 token 与扣分全被记成 0。
          let tail = '';
          let streamError = null;
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              res.write(Buffer.from(value));
              tail += decoder.decode(value, { stream: true });
              const lines = tail.split('\n');
              tail = lines.pop() ?? '';
              for (const line of lines) {
                if (!line.startsWith('data:')) continue;
                const chunk = line.slice(5).trim();
                if (!chunk || chunk === '[DONE]' || !chunk.includes('"usage"')) continue;
                try {
                  const u = JSON.parse(chunk).usage;
                  if (u) usageSeen = u; // 最后一帧的 usage 胜出
                } catch { /* 半个包，忽略 */ }
              }
              // 兜底：上游若不按行收尾，别让 tail 无限增长
              if (tail.length > 100000) tail = tail.slice(-4096);
            }
          } catch (e) {
            streamError = e;
            log('stream interrupted', e.message);
          }
          // 上游在流中途断了（连接被掐 / 网络故障）**不是成功**：客户端的回答
          // 已被截断，账本要如实记一笔失败，否则「回答为什么少了一半」在控制台上
          // 完全不可见 —— 与非流式路径的处理保持一致（那里同样记 ok:false）。
          //
          // 客户端自己断开（用户点了停止 / 关了页面）不是失败的另一种：请求已经
          // 服务过了，照旧记成功。用 ac.signal.aborted 区分这两者。
          if (streamError && !ac.signal.aborted) {
            recordRequest({
              model,
              stream: true,
              ms: Date.now() - startedAt,
              ok: false,
              status: 0,
              code: null,
              error: streamError.message,
            });
          } else {
            recordRequest({ model, stream: true, ok: true, ms: Date.now() - startedAt, ...usageOf(usageSeen) });
          }
          return res.end();
        }

        const aggregated = await aggregateStream(up);
        recordRequest({ model, stream: false, ok: true, ms: Date.now() - startedAt, ...usageOf(aggregated.usage) });
        return json(res, 200, aggregated);
      } catch (e) {
        recordRequest({
          model,
          stream: wantStream,
          ms: Date.now() - startedAt,
          ok: false,
          status: 0,
          code: null,
          error: e.message,
        });
        throw e; // 交给外层统一回 500
      }
    }

    // ── Anthropic Messages API（Claude Code 等）────────────────────────────
    if (url.pathname === '/v1/messages' && req.method === 'POST') {
      let raw;
      try {
        raw = await readBody(req);
      } catch (e) {
        if (e.code === 'BODY_TOO_LARGE') {
          return json(res, 413, {
            type: 'error',
            error: { type: 'request_too_large', message: `request body too large (limit ${MAX_BODY_BYTES} bytes)` },
          });
        }
        throw e;
      }
      let body;
      try { body = JSON.parse(raw); }
      catch { return json(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'invalid JSON body' } }); }

      // Anthropic 的 `stream` 缺省是 false（与 OpenAI 相反）
      const wantStream = body.stream === true;
      const model = resolveAnthropicModel(body.model);
      const messages = anthropicToOpenAIMessages(body);
      const tools = anthropicToolsToOpenAIMessages(body.tools);
      const toolChoice = anthropicToolChoiceToOpenAI(body.tool_choice);

      const oai = { model, messages, stream: true, stream_options: { include_usage: true } };
      if (tools) oai.tools = tools;
      if (toolChoice) oai.tool_choice = toolChoice;
      if (typeof body.max_tokens === 'number') oai.max_tokens = body.max_tokens;
      if (typeof body.temperature === 'number') oai.temperature = body.temperature;
      if (typeof body.top_p === 'number') oai.top_p = body.top_p;
      if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) oai.stop = body.stop_sequences;

      maybeAutoCheckin();
      log(`→ [anthropic] ${body.model || '(no model)'} => ${model} stream=${wantStream} msgs=${messages.length} tools=${tools?.length ?? 0}`);

      const startedAt = Date.now();
      const ac = new AbortController();
      req.on('aborted', () => ac.abort());
      res.on('close', () => { if (!res.writableEnded) ac.abort(); });

      try {
        const { res: up, bodyText } = await callUpstream(
          JSON.stringify(normalizePayload(oai)),
          model,
          req.headers['x-conversation-id'] || trace(),
          ac.signal,
        );
        if (!up.ok) {
          const text = bodyText ?? await up.text().catch(() => '');
          let parsed; try { parsed = JSON.parse(text); } catch {}
          log('upstream error (anthropic)', up.status, text.slice(0, 300));
          recordRequest({
            model,
            stream: wantStream,
            ms: Date.now() - startedAt,
            ok: false,
            status: up.status,
            code: typeof parsed?.code === 'number' ? parsed.code : null,
            error: parsed?.msg || parsed?.message || text,
          });
          // 错误体也必须是 Anthropic 的形状，否则客户端只会显示「未知错误」
          return json(res, up.status === 200 ? 502 : up.status, {
            type: 'error',
            error: {
              type: 'api_error',
              message: parsed?.msg || parsed?.message || text || `upstream HTTP ${up.status}`,
            },
          });
        }

        if (wantStream) {
          const r = await relayAnthropicStream(up, res, model, Math.max(1, Math.round(raw.length / 4)));
          if (r.streamError && !ac.signal.aborted) {
            recordRequest({ model, stream: true, ms: Date.now() - startedAt, ok: false, status: 0, code: null, error: r.streamError.message });
          } else {
            recordRequest({ model, stream: true, ok: true, ms: Date.now() - startedAt, ...usageOf(r.usage) });
          }
          return;
        }

        const aggregated = await aggregateStream(up);
        recordRequest({ model, stream: false, ok: true, ms: Date.now() - startedAt, ...usageOf(aggregated.usage) });
        return json(res, 200, openAIToAnthropicMessage(aggregated, model));
      } catch (e) {
        recordRequest({ model, stream: wantStream, ms: Date.now() - startedAt, ok: false, status: 0, code: null, error: e.message });
        throw e;
      }
    }

    // ── 上游没有的能力：明确 501，不做假的 ────────────────────────────────
    // 上游 30 个模型全是对话类，**没有任何 embedding 模型**。这里若返回一堆
    // 无意义的向量，客户端的知识库会"看起来建成了、实际全是噪声"，用户要等
    // 检索结果离谱时才发现。宁可现在就讲清楚。
    if (url.pathname === '/v1/embeddings' && req.method === 'POST') {
      return json(res, 501, {
        error: {
          message: 'workbuddy-bridge: /v1/embeddings is not available — the upstream gateway serves chat models only '
            + '(its catalog contains no embedding model). Clients that need embeddings for a knowledge base / RAG '
            + 'should configure a separate embedding provider.',
          type: 'not_implemented',
        },
      });
    }

    if (url.pathname === '/' ) {
      return json(res, 200, {
        service: 'workbuddy-bridge',
        usage: 'POST /v1/chat/completions · POST /v1/messages (Anthropic) · GET /v1/models · GET /v1/usage · GET /v1/requests · GET /v1/quota · GET /v1/checkin · GET /health',
        featured: FEATURED.map((m) => m.id),
      });
    }
    return json(res, 404, { error: { message: `no route for ${req.method} ${url.pathname}` } });
  } catch (e) {
    log('handler error', e.stack || e.message);
    if (!res.headersSent) return json(res, 500, { error: { message: e.message } });
    try { res.end(); } catch {}
  }
});

// ── Preflight (--check): report prerequisites without starting the server ──
if (process.argv.includes('--check')) {
  const lines = [];
  const major = Number(process.versions.node.split('.')[0]);
  lines.push(`node            ${process.version}${major >= 18 ? '' : '  [FAIL] Node 18+ required'}`);
  lines.push(`auth file       ${AUTH_PATH}`);
  let authOk = false;
  try {
    const a = readStoredAuth();
    authOk = true;
    lines.push(`account         ${a.userId || '(no sub claim)'}`);
    lines.push(`endpoint        ${a.endpoint}`);
    lines.push(`token expires   ${new Date(a.expiresAt).toISOString()}${a.expiresAt < Date.now() ? '  (expired: the bridge refreshes on first request)' : ''}`);
  } catch (e) {
    lines.push(`auth            [FAIL] ${e.message}`);
  }
  lines.push(`client exe      ${atRestUsedExe || resolveWorkBuddyExe() || '未找到（设置 WORKBUDDY_APP_EXECUTABLE 指向 WorkBuddy.exe）'}`);
  lines.push(`models          ${FEATURED.map((m) => m.id).join(', ')}`);
  console.log(lines.join('\n'));
  process.exit(authOk || API_KEY ? 0 : 1);
}

server.listen(PORT, HOST, () => {
  let who = '(no desktop session read)';
  try { const a = readStoredAuth(); who = `${a.userId} @ ${a.endpoint}`; } catch (e) { who = `ERROR: ${e.message}`; }
  console.log(`workbuddy-bridge listening on http://${HOST}:${PORT}/v1`);
  console.log(`auth       : ${API_KEY ? 'API key (CODEBUDDY_API_KEY)' : `desktop session ${who}`}`);
  console.log(`auth file  : ${AUTH_PATH}`);
  console.log(`client exe : ${atRestUsedExe || resolveWorkBuddyExe() || '未找到（设置 WORKBUDDY_APP_EXECUTABLE 指向 WorkBuddy.exe）'}`);
  console.log(`models     : ${FEATURED.map((m) => m.id).join(', ')}  (all models: /v1/models?all=1)`);
  console.log(`keep-alive : ${KEEPALIVE_MS > 0 ? `${Math.round(KEEPALIVE_MS / 1000)}s idle pool` : 'off'}`);

  // ── 连接预热：listen 后立刻向上游开一条 TLS 连接放进池子 ─────────────────
  // 首次对话请求就免去 DNS + TCP + TLS 握手（实测 ~150ms）。只预热、不发请求体；
  // 失败完全无害 —— Agent 会在真正请求时重连。
  try {
    const endpoint = API_KEY ? (EXPLICIT_ENDPOINT || 'https://copilot.tencent.com') : pickUpstream(JSON.parse(readFileSync(AUTH_PATH, 'utf8'))?.auth?.domain || '');
    const url = new URL(endpoint);
    const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: '/',
      method: 'GET',
      agent: agentFor(url.protocol),
      timeout: 8000,
    });
    // 拿到响应就算预热完成（连接已进池）；上游 4xx/5xx 都无所谓，我们要的只是连接
    req.on('response', (res) => { res.resume(); log(`warmed upstream connection to ${url.hostname}`); });
    req.on('error', () => {});   // 预热失败不吵不闹
    req.on('timeout', () => req.destroy());
    req.end();
  } catch { /* 登录文件读不出来等：真正请求时自会报错 */ }

  // ── 每日自动签到的定时器 ─────────────────────────────────────────────
  // 必须由**常驻的那一方**负责：桥会在后台一直活着，控制台不会。
  // 详见 startAutoCheckinTimer 的注释（实测：桥跑了一整天、零模型请求，
  // 结果一次签到都没发生）。
  startAutoCheckinTimer();
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { console.log('\nworkbuddy-bridge stopped'); process.exit(0); });
}
