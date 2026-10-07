/**
 * WorkBuddy 客户端定位 —— 「装在哪都能找到」。
 *
 * 客户端可以安装到任意目录（默认安装、自定义盘符、绿色版……），exe 文件名
 * 也随版本变化（WorkBuddy.exe / WorkBuddyAI.exe / CodeBuddy.exe）。只写死
 * 几个路径的探测在用户"换目录重装"后必然失效 —— 表现为桥取不出 AtRest
 * 密钥：`key fetch failed: spawnSync … ENOENT`。
 *
 * 因此按可靠性从高到低探测：
 *   1. WORKBUDDY_APP_EXECUTABLE —— 显式覆盖，最高优先；
 *   2. 已知默认安装位置 —— 覆盖常规安装，零成本；
 *   3. 磁盘浅扫描 —— 在常见父目录（App / Program Files / Tencent / …）
 *      下找 `WorkBuddy*.exe` 一类的文件，覆盖自定义目录；
 *   4. 系统信号兜底 —— 运行中进程的镜像路径 + 注册表安装记录（卸载项 /
 *      深链协议 / App Paths），与安装位置无关，覆盖"目录名纯随机"的极端情况。
 * 廉价层（2/3）只在 1 落空时执行，兜底层（4）只在 1/2/3 全部落空时执行；
 * 各层带缓存与失败防抖，避免"客户端正在重装"的窗口期内反复重扫。
 *
 * 与 bridge/workbuddy-bridge.mjs 的 resolveWorkBuddyExe() 是同一套算法
 * （桥刻意保持自包含单文件、不 import 本项目其它模块，改动时两边需同步）。
 */
import { existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, dirname, join } from 'node:path';

/** 客户端 exe 的可能名字：国际版 / 国内版（WorkBuddyAI.exe）/ 旧名 CodeBuddy。 */
const EXE_NAME_RE = /^(?:workbuddy(?:\s*ai)?|codebuddy(?:\s*ai)?)\.exe$/i;

/** 目录名含这些词 → 该目录就是客户端安装目录（如 WorkbuddyInternational）。 */
const DIR_KEYWORD_RE = /workbuddy|codebuddy/i;

/**
 * 「再往下看看」的父目录白名单。
 *
 * 只对应用通常会被装进去的目录继续下探，避免在有海量目录的盘上乱扫。
 * 深度最多 3 层，覆盖两类常见布局：
 *   E:\App\WorkbuddyInternational\WorkBuddy.exe     （App → 关键词目录）
 *   C:\Program Files\Tencent\WorkBuddy\WorkBuddy.exe（Program Files → Tencent → 关键词目录）
 */
const DESCEND_RE = /^(?:app|apps|application|applications|program|programs|program files(?:\s*\(x86\))?|software|soft|tools?|tencent|portable|green|dev|develop|development|应用|软件)$/i;

/** 扫描预算：一次扫描最多列这么多目录，防止在超大目录树上失控。 */
const SCAN_DIR_BUDGET = 400;

/** 扫描结果为准的缓存；空数组不缓存（允许客户端装好后重扫）。 */
let scanCache = null;
/** 上次扫描时刻 —— 对"连续失败"做防抖。 */
let scanAt = 0;
const SCAN_MIN_INTERVAL_MS = 3000;

/** 探测成功后的稳定缓存（exe 被卸载则自动失效重探）。 */
let hitCache = '';
/** 上次"全部落空"的时刻，用于失败防抖。 */
let lastMissAt = 0;
const MISS_RETRY_MS = 5000;

function listDirs(dir, budget) {
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

/** 直接位于 dir 下的客户端 exe（有则返回完整路径）。 */
function exeInDir(dir) {
  try {
    const hit = readdirSync(dir, { withFileTypes: true })
      .find((e) => !e.isDirectory() && EXE_NAME_RE.test(e.name));
    return hit ? join(dir, hit.name) : '';
  } catch {
    return '';
  }
}

/** 存在盘符列表（C:–Z:）。跳过的盘符如未挂载，existsSync 立即返回 false。 */
function windowsDrives() {
  const out = [];
  for (let c = 67; c <= 90; c += 1) {
    const root = `${String.fromCharCode(c)}:\\`;
    try {
      if (existsSync(root)) out.push(root);
    } catch {
      /* 盘符不可用（如未插入的读卡器） */
    }
  }
  return out;
}

/**
 * 磁盘浅扫描（仅 Windows）：
 *   盘根 → {App | Program Files | Tencent | …} → {含 workbuddy 的目录} → exe
 * 收集**所有**命中（可能同时装着国内版与国际版），交给调用方按 keyId 挑。
 */
function doScan() {
  if (process.platform !== 'win32') return [];
  const found = [];
  const seen = new Set();
  const budget = { dirs: SCAN_DIR_BUDGET };
  const push = (p) => {
    if (p && !seen.has(p)) {
      seen.add(p);
      found.push(p);
    }
  };

  for (const drive of windowsDrives()) {
    for (const name1 of listDirs(drive, budget)) {
      const p1 = join(drive, name1);
      if (DIR_KEYWORD_RE.test(name1)) {
        // E:\App\WorkbuddyInternational\WorkBuddy.exe（盘根一级就是安装目录）
        push(exeInDir(p1));
        // 再看一层：WorkBuddy\app\WorkBuddy.exe 这类"外壳目录"
        for (const name2 of listDirs(p1, budget)) push(exeInDir(join(p1, name2)));
      } else if (DESCEND_RE.test(name1)) {
        for (const name2 of listDirs(p1, budget)) {
          const p2 = join(p1, name2);
          if (DIR_KEYWORD_RE.test(name2)) {
            // E:\App\WorkbuddyInternational\WorkBuddy.exe
            push(exeInDir(p2));
            for (const name3 of listDirs(p2, budget)) push(exeInDir(join(p2, name3)));
          } else if (DESCEND_RE.test(name2)) {
            // C:\Program Files\Tencent\WorkBuddy\WorkBuddy.exe
            for (const name3 of listDirs(p2, budget)) {
              if (DIR_KEYWORD_RE.test(name3)) push(exeInDir(join(p2, name3)));
            }
          }
        }
      }
    }
  }
  return found;
}

/** 扫描（带缓存与失败防抖）。返回命中的 exe 列表，可能为空。 */
export function scanForWorkBuddyExe() {
  if (scanCache) return scanCache;
  if (Date.now() - scanAt < SCAN_MIN_INTERVAL_MS) return [];
  scanAt = Date.now();
  const hits = doScan();
  if (hits.length) scanCache = hits;
  return hits;
}

/**
 * 静态候选：显式覆盖 + 各平台默认安装位置。
 * 长尾的自定义目录靠 scanForWorkBuddyExe()，不往这里堆。
 */
export function staticWorkBuddyExeCandidates() {
  const out = [];
  const explicit = process.env.WORKBUDDY_APP_EXECUTABLE;
  if (explicit) out.push(explicit);

  if (process.platform === 'win32') {
    const names = ['WorkBuddy.exe', 'WorkBuddyAI.exe', 'CodeBuddy.exe'];
    const roots = [
      process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs'),
      process.env.ProgramFiles,
      process.env['ProgramFiles(x86)'],
    ].filter(Boolean);
    for (const root of roots) {
      for (const dir of ['WorkBuddy', 'WorkBuddy AI', 'WorkBuddyAI', 'CodeBuddy']) {
        for (const name of names) out.push(join(root, dir, name));
      }
    }
    // 已知的自定义安装历史（本项目用户群常见于非默认盘）
    out.push('E:\\App\\WorkBuddy\\WorkBuddy.exe');
    out.push('E:\\App\\WorkBuddy\\WorkBuddyAI.exe');
    out.push('D:\\App\\WorkBuddy\\WorkBuddy.exe');
  } else if (process.platform === 'darwin') {
    out.push('/Applications/WorkBuddy.app/Contents/MacOS/WorkBuddy');
    out.push('/Applications/WorkBuddy AI.app/Contents/MacOS/WorkBuddy');
  } else {
    out.push('/opt/WorkBuddy/workbuddy');
  }
  return out;
}

/**
 * 完整候选列表：静态在前（用户显式设置的最优先），扫描在后，去重。
 * 调用方通常用 find(existsSync) 选第一个存在的。
 */
export function workBuddyExeCandidates() {
  return [...new Set([...staticWorkBuddyExeCandidates(), ...scanForWorkBuddyExe()])];
}

// ── 系统信号兜底（Windows）：进程镜像路径 + 注册表安装记录 ───────────────

/**
 * 为什么还需要这一层：静态候选与目录扫描本质上都在"猜路径" —— 客户端要是
 * 装进 `D:\随便起的名字\`（目录名不含 workbuddy、父目录也不在白名单），
 * 前两层都会落空。而下面这两类信号是**客户端自己留下的、与安装位置无关**：
 *
 *   ① 运行中进程的镜像路径 —— 客户端在用时，它就是安装位置，最准；
 *   ② 注册表 —— 官方安装器必写卸载记录（否则"应用和功能"里看不到它），
 *      深链协议（workbuddy://…）与 App Paths 同样带完整 exe 路径。
 *
 * 代价是 PowerShell 冷启动需要数秒，所以**只在前面全部落空时执行**，且带
 * 成功缓存与失败防抖（见 probeSystemSignalsExe）。任何一步失败都静默返回
 * 空数组 —— 兜底层永远不能让整体探测变差。
 */
const SYS_PROBE_MIN_INTERVAL_MS = 120_000;
let sysHitsCache = null;
let sysProbeAt = 0;

/** PowerShell 全路径（PATH 异常时也稳）。 */
function powershellPath() {
  const full = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return existsSync(full) ? full : 'powershell';
}

/** PowerShell 侧脚本：一次调用同时收集进程与注册表信号，base64 输出（免受编码/引号影响）。 */
const SYS_PROBE_SCRIPT = String.raw`
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

/**
 * 从进程/注册表信号里提取客户端 exe（导出以便开发期测试）。
 *
 * 注册表记录里的 exe 可能是卸载器（`Uninstall WorkBuddy.exe`）或图标路径
 * （`…\WorkBuddy.exe,0`）—— 前者取其所在目录再找客户端本体，后者剥离后缀直接用。
 */
export function extractExePathsFromSignals(signal) {
  const out = [];
  const push = (p) => {
    const v = String(p || '').trim();
    if (v && !out.includes(v)) out.push(v);
  };
  for (const p of signal?.procs || []) {
    const base = basename(String(p || ''));
    if (EXE_NAME_RE.test(base)) push(p);
  }
  for (const rec of signal?.reg || []) {
    // 三个字段都要尝试（而非短路取值）：icon 可能指向无关程序甚至系统图标，
    // 此时 uninst（卸载器路径）是唯一线索。形态示例：
    //   icon   "…\WorkBuddy.exe,0"
    //   uninst "…\Uninstall WorkBuddy.exe" /currentuser
    //   cmd    "…\WorkBuddy.exe" "%1"
    for (const raw of [rec.icon, rec.uninst, rec.cmd]) {
      const m = /([A-Za-z]:\\[^"]*?\.exe)/i.exec(String(raw || ''));
      if (!m) continue;
      const exe = m[1];
      if (EXE_NAME_RE.test(basename(exe))) {
        push(exe);
        continue;
      }
      // 卸载器/图标与客户端同目录：从目录里找本体
      const hit = exeInDir(dirname(exe));
      if (hit) push(hit);
    }
  }
  return out;
}

/**
 * 系统信号兜底（Windows）。带成功缓存 + 失败防抖（PowerShell 贵，勿频繁跑）。
 * 返回命中的 exe 列表；任何失败都返回 []（不影响上层已有结论）。
 */
export function probeSystemSignalsExe() {
  if (sysHitsCache) return sysHitsCache;
  if (process.platform !== 'win32') return [];
  if (Date.now() - sysProbeAt < SYS_PROBE_MIN_INTERVAL_MS) return [];
  sysProbeAt = Date.now();

  let signal;
  try {
    const res = spawnSync(powershellPath(), ['-NoProfile', '-NonInteractive', '-Command', SYS_PROBE_SCRIPT], {
      encoding: 'utf8',
      timeout: 20_000,
      windowsHide: true,
      // stdin 必须 ignore：与 Electron 二进制的 EBUSY 教训同理，且 PowerShell 不需要输入
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 1024 * 1024,
    });
    if (res.error || res.status !== 0 || !res.stdout) return [];
    signal = JSON.parse(Buffer.from(String(res.stdout).replace(/\s+/g, ''), 'base64').toString('utf8'));
  } catch {
    return [];
  }
  const hits = extractExePathsFromSignals(signal).filter((p) => existsSync(p));
  if (hits.length) sysHitsCache = hits;
  return hits;
}

/**
 * 探测到一个存在的客户端 exe；全部落空返回 ''。
 *
 * 分两层：先便宜的（静态候选 + 磁盘扫描），全落空才动贵的系统信号兜底
 * （PowerShell 冷启动数秒）。结果缓存；缓存失效（文件被删）或上次落空超过
 * 防抖窗口后自动重探 —— 用户"重装到新目录"后无需重启控制台/桥。
 */
export function findWorkBuddyExe() {
  if (hitCache && existsSync(hitCache)) return hitCache;
  hitCache = '';
  if (Date.now() - lastMissAt < MISS_RETRY_MS) return '';
  let hit = workBuddyExeCandidates().find((p) => existsSync(p));
  if (!hit) hit = probeSystemSignalsExe().find((p) => existsSync(p));
  if (hit) {
    hitCache = hit;
    return hit;
  }
  lastMissAt = Date.now();
  return '';
}
