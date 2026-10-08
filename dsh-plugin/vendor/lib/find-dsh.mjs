/**
 * DeepSeek Harness（DSH Desktop）运行时目录定位 —— 「装在哪都能找到」。
 *
 * 与 find-workbuddy.mjs 同款的问题：写死路径列表在 DSH 换目录安装/移动后必然
 * 失配（config.mjs 原先硬编码了本机专属的 E:\harness）。而 dsh 集成
 * （模型注册 / profile bundles / 凭据引用）全都依赖这个 runtime 目录 ——
 * 一旦找错，诊断会红、模型不会出现在 dsh 的选择器里。
 *
 * 探测顺序（廉价 → 昂贵）：
 *   1. DSH_RUNTIME 环境变量（显式覆盖）
 *   2. 常见安装位置（默认安装 + 历史自定义路径）
 *   3. 运行中进程 —— DSH Desktop 在跑时最准：<exe 所在目录>\resources\runtime
 *      （Electron 应用的标准布局；DSH Desktop 几乎总在运行）
 *   4. 磁盘浅扫描 —— 常见父目录下"名字像 DSH"的目录（deepseek / dsh / harness）
 *      里的 resources\runtime 或 runtime
 *
 * **所有候选都必须通过 looksLikeDshRuntime() 特征校验**（primary-runtime/runtime.json
 * 或 node_modules/@deepseek-ai/dsh）—— 目录碰巧存在但结构不对 = 不是我们要的。
 * 这与 find-workbuddy 只查文件存在性的做法刻意不同：runtime 是目录，误判的
 * 代价（诊断假绿、写坏别人的目录）比多花几毫秒大得多。
 */
import { existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';

/** 目录"像 DSH 运行时"：DSH Desktop 形态 或 独立安装形态。 */
export function looksLikeDshRuntime(dir) {
  if (!dir) return false; // 防 join('') 拼出相对路径造成误判
  try {
    return (
      existsSync(join(dir, 'primary-runtime', 'runtime.json'))
      || existsSync(join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
    );
  } catch {
    return false;
  }
}

/** 目录名含这些词 → 值得当成"DSH 安装根"看一眼。 */
const DIR_KEYWORD_RE = /deepseek|dsh|harness/i;

/** 「再往下看看」的父目录白名单（与 find-workbuddy 同款）。 */
const DESCEND_RE = /^(?:app|apps|application|applications|program|programs|program files(?:\s*\(x86\))?|software|soft|tools?|portable|green|应用|软件)$/i;

const SCAN_DIR_BUDGET = 400;
const SCAN_MIN_INTERVAL_MS = 3000;
const SYS_PROBE_MIN_INTERVAL_MS = 120_000;
const MISS_RETRY_MS = 5000;

let scanCache = null;
let scanAt = 0;
let sysHitsCache = null;
let sysProbeAt = 0;
let hitCache = '';
let lastMissAt = 0;

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

/** 从一个"疑似安装根"推导 runtime 候选（两种常见布局），返回通过特征校验的。 */
function runtimeCandidatesFrom(root) {
  if (!root) return [];
  const out = [];
  for (const cand of [join(root, 'resources', 'runtime'), join(root, 'runtime')]) {
    if (looksLikeDshRuntime(cand)) out.push(cand);
  }
  return out;
}

function windowsDrives() {
  const out = [];
  for (let c = 67; c <= 90; c += 1) {
    const root = `${String.fromCharCode(c)}:\\`;
    try {
      if (existsSync(root)) out.push(root);
    } catch {
      /* 盘符不可用 */
    }
  }
  return out;
}

/** 磁盘浅扫描：盘根 → {名字像 DSH | 白名单父目录 → 名字像 DSH} → resources\runtime。 */
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
        // E:\harness\resources\runtime（盘根一级就是安装根）
        for (const c of runtimeCandidatesFrom(p1)) push(c);
        for (const name2 of listDirs(p1, budget)) {
          for (const c of runtimeCandidatesFrom(join(p1, name2))) push(c);
        }
      } else if (DESCEND_RE.test(name1)) {
        for (const name2 of listDirs(p1, budget)) {
          if (!DIR_KEYWORD_RE.test(name2)) continue;
          // E:\App\DeepSeek Harness\resources\runtime
          for (const c of runtimeCandidatesFrom(join(p1, name2))) push(c);
        }
      }
    }
  }
  return found;
}

/** 扫描（带缓存与失败防抖；缓存校验：命中的 runtime 必须仍然"像"运行时）。 */
export function scanForDshRuntime() {
  if (scanCache && scanCache.some((p) => looksLikeDshRuntime(p))) return scanCache;
  scanCache = null;
  if (Date.now() - scanAt < SCAN_MIN_INTERVAL_MS) return [];
  scanAt = Date.now();
  const hits = doScan();
  if (hits.length) scanCache = hits;
  return hits;
}

/** 静态候选：显式覆盖 + 常见安装位置（含历史自定义路径）。 */
export function staticDshRuntimeCandidates() {
  const out = [];
  const explicit = process.env.DSH_RUNTIME;
  if (explicit) out.push(explicit);

  if (process.platform === 'win32') {
    const roots = [
      'E:\\harness', // 历史自定义位置（本机实测）
      process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness'),
      process.env.ProgramFiles && join(process.env.ProgramFiles, 'DeepSeek Harness'),
      process.env['ProgramFiles(x86)'] && join(process.env['ProgramFiles(x86)'], 'DeepSeek Harness'),
    ].filter(Boolean);
    for (const root of roots) {
      out.push(join(root, 'resources', 'runtime'));
      out.push(join(root, 'runtime'));
    }
  } else if (process.platform === 'darwin') {
    out.push('/Applications/DeepSeek Harness.app/Contents/Resources/runtime');
  }
  // 独立安装的默认位置（HOME 缺失时不要拼出相对路径 —— 相对路径会相对
  // cwd 产生误判）
  const home = process.env.HOME || process.env.USERPROFILE;
  if (home) out.push(join(home, 'DeepSeek-Harness', 'runtime'));
  return out.filter(Boolean);
}

// ── 系统信号兜底（Windows）：运行中进程 + 注册表安装记录 ────────────────

/** PowerShell 5.1 的 ConvertTo-Json 会把单元素数组退化成标量 —— 一律先过数组。 */
const asArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);

function powershellPath() {
  const full = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return existsSync(full) ? full : 'powershell';
}

const SYS_PROBE_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$out = @{ procs = @(); reg = @() }
Get-Process | Where-Object { $_.Name -match 'DeepSeek|dsh' } | ForEach-Object {
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
    if ("$($p.DisplayName)" -match 'DeepSeek|Harness|dsh') {
      $out.reg += @{ icon = "$($p.DisplayIcon)"; uninst = "$($p.UninstallString)"; loc = "$($p.InstallLocation)" }
    }
  }
}
[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($out | ConvertTo-Json -Depth 5 -Compress)))
`;

/**
 * 从进程/注册表信号推导 runtime 候选（导出以便开发期测试）。
 * 进程/图标/卸载器都给 exe 路径 → 取其所在目录；InstallLocation 可能直接
 * 是安装根目录。每个候选都要通过 looksLikeDshRuntime()。
 */
export function extractDshRuntimeFromSignals(signal) {
  const out = [];
  const pushRoot = (root) => {
    for (const c of runtimeCandidatesFrom(root)) {
      if (!out.includes(c)) out.push(c);
    }
  };
  for (const p of asArray(signal?.procs)) {
    pushRoot(dirname(String(p || '')));
  }
  for (const rec of asArray(signal?.reg)) {
    for (const raw of [rec.icon, rec.uninst, rec.loc, rec.cmd]) {
      const text = String(raw || '');
      const m = /([A-Za-z]:\\[^"]*?\.exe)/i.exec(text);
      if (m) {
        pushRoot(dirname(m[1]));
        continue;
      }
      // InstallLocation 常是裸目录（无 .exe）
      const bare = text.trim().replace(/^"|"$/g, '');
      if (/^[A-Za-z]:\\/.test(bare)) pushRoot(bare);
    }
  }
  return out;
}

/** 系统信号兜底（Windows）。成功缓存 + 失败防抖；任何异常静默返回 []。 */
export function probeDshFromSystemSignals() {
  if (sysHitsCache && sysHitsCache.some((p) => looksLikeDshRuntime(p))) return sysHitsCache;
  sysHitsCache = null;
  if (process.platform !== 'win32') return [];
  if (Date.now() - sysProbeAt < SYS_PROBE_MIN_INTERVAL_MS) return [];
  sysProbeAt = Date.now();

  let signal;
  try {
    const res = spawnSync(powershellPath(), ['-NoProfile', '-NonInteractive', '-Command', SYS_PROBE_SCRIPT], {
      encoding: 'utf8',
      timeout: 20_000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'], // Windows：忽略 stdin，否则 EBUSY
      maxBuffer: 1024 * 1024,
    });
    if (res.error || res.status !== 0 || !res.stdout) return [];
    signal = JSON.parse(Buffer.from(String(res.stdout).replace(/\s+/g, ''), 'base64').toString('utf8'));
  } catch {
    return [];
  }
  const hits = extractDshRuntimeFromSignals(signal).filter((p) => looksLikeDshRuntime(p));
  if (hits.length) sysHitsCache = hits;
  return hits;
}

/** 全部候选（静态 + 扫描），供诊断展示。 */
export function dshRuntimeCandidates() {
  return [...new Set([...staticDshRuntimeCandidates(), ...scanForDshRuntime()])];
}

/**
 * 探测一个有效（通过特征校验）的 runtime 目录；全部落空返回 ''。
 * 先便宜的（静态 + 扫描），全落空才动 PowerShell 兜底（进程 + 注册表）。
 */
export function findDshRuntime() {
  if (hitCache && looksLikeDshRuntime(hitCache)) return hitCache;
  hitCache = '';
  if (Date.now() - lastMissAt < MISS_RETRY_MS) return '';
  let hit = dshRuntimeCandidates().find((p) => looksLikeDshRuntime(p));
  if (!hit) hit = probeDshFromSystemSignals().find((p) => looksLikeDshRuntime(p));
  if (hit) {
    hitCache = hit;
    return hit;
  }
  lastMissAt = Date.now();
  return '';
}
