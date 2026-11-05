/**
 * DeepSeek Harness 侧：配置读取、模型注册写入。
 *
 * dsh 的配置体系是 cordis patch 分层：`dsh-base` bundle 已内置 `llm-pi-ai`
 * 适配器条目，用户只需在 `$DSH_HOME/settings.yaml` 提供 `llm-pi-ai:` 分节，
 * 该分节热重载，无需重启。凭据走 `$DSH_HOME/.credentials.yaml` 的 `refs:`，
 * 由 `apiKeyEnv` 按请求解析。
 */
import {
  closeSync, copyFileSync, existsSync, lstatSync, openSync, readFileSync, readSync,
  readlinkSync, renameSync, statSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import config from '../config.mjs';

/**
 * 本插件的两种安装包名 —— 根包（github 直装）与单文件夹分发。
 *
 * 它们出现在 profile 的 `dsh.profile.bundles` 里，就意味着 dsh 会加载插件；
 * 插件加载时会用 `ctx.llm.registerAdapter()` 在**运行时**注册 provider ——
 * 这条路由不存在于 settings.yaml / patch 的 `llm-pi-ai` 分节里。
 */
export const NATIVE_PLUGIN_BUNDLES = ['dsh-plugin-workbuddy', 'workbuddy-to-dsh'];

/** 实验性 bundle：声明了但没装只影响对应实验功能，不该和核心 bundle 同色。 */
export function isOptionalBundle(name) {
  return /^@deepseek-ai\/dsh-experimental-/.test(String(name || ''));
}

/**
 * 「随 DSH 安装提供」的核心 bundle（`@deepseek-ai/dsh-base`、`-web-app` 等）。
 *
 * 这一类**永远不该往 profile 里装**：DSH 会从自己的安装里解析它们，往 profile
 * 再落一份等于双实例 + 代次冲突（issue #1 有破坏史，issue #26 又踩到一次）。
 * 实验性 `@deepseek-ai/dsh-experimental-*` 除外 —— 它们要用户显式安装。
 */
export function isCoreBundle(name) {
  return /^@deepseek-ai\/dsh-(?!experimental-)/.test(String(name || ''));
}

/**
 * patch 层里某个 Loader 条目是否被 `disabled: true` 关掉。
 *
 * 只认**顶层列表项**（行首 `- id:`）与它下面 2 空格缩进的 `disabled` ——
 * `config:` 里恰好也叫 disabled 的字段不能误判。找不到条目 = 未关闭（bundle 默认加载）。
 */
export function patchEntryDisabled(text, id = 'workbuddy') {
  const escaped = String(id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const entryRe = new RegExp(`^-\\s*id:\\s*["']?${escaped}["']?\\s*(?:#.*)?$`);
  const lines = String(text || '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    if (!entryRe.test(lines[i])) continue;
    for (let j = i + 1; j < lines.length; j += 1) {
      // 下一个**顶层**列表项（行首 `- `）表示本条目结束；config 里的缩进列表不算
      if (/^-\s/.test(lines[j])) break;
      if (/^ {2}disabled:\s*true\s*(?:#.*)?$/i.test(lines[j])) return true;
    }
  }
  return false;
}

/**
 * profile 是否以「插件原生路由」方式接入。
 *
 * 判据是**配置层的事实**，不需要 dsh 正在运行：
 *   1. `dsh.profile.bundles` 里有本插件（且依赖确实装上了）；
 *   2. patch 层没有把 `id: workbuddy` 这个 Loader 条目 `disabled: true`。
 *
 * 满足这两条，dsh 下次组合 profile 时就会加载插件、注册 provider。控制台与
 * 插件面板因此不必再对「settings.yaml 里没有 llm-pi-ai」报红灯 —— 那是
 * 迁移前的旧口径（见 issue #1）。
 *
 * @param {string} patchText profile 的 cordis.patch.yml 原文
 * @param {{name: string, installed: boolean}[]} bundles readDshStatus 读到的 bundle 状态
 */
export function detectNativeRoute(patchText, bundles) {
  const list = Array.isArray(bundles) ? bundles : [];
  const hit = list.find((b) => NATIVE_PLUGIN_BUNDLES.includes(String(b?.name || '')));
  if (!hit || hit.installed !== true) {
    return { installed: false, enabled: false, disabledByPatch: false, provider: 'workbuddy', bundle: '' };
  }
  const disabledByPatch = patchEntryDisabled(patchText, 'workbuddy');
  return {
    installed: true,
    enabled: !disabledByPatch,
    disabledByPatch,
    provider: 'workbuddy',
    bundle: hit.name,
  };
}

// ── profile bundle 解析：磁盘 / 打包安装（asar）/ 悬空链接 ────────────────

/**
 * 一个 bundle 的解析结果。`source` 就是**证据**，比布尔值有用得多：
 *
 *   runtime      —— `<runtime>/node_modules/<name>`，独立或自带运行时里的普通目录
 *   asar         —— 打包安装的 `resources/app.asar` **内**（issue #26）
 *   profile      —— `~/.dsh/profiles[/desktop]/node_modules/<name>`，用户自己装的
 *   broken-link  —— 只找到一个**悬空链接**（临时目录被清理）。**不是已安装**
 *   missing      —— 以上都没有
 *
 * `unverified` 表示「判不了」：核心 bundle 在插件进程看不懂的安装布局下，
 * 既不能证实也不能证伪（打包 asar 读不到、或 runtime 里连 node_modules 都没有）。
 * 这时**不许**报「缺失」—— 那正是 issue #26 的误报。
 *
 * @typedef {{
 *   name: string,
 *   installed: boolean,
 *   optional: boolean,
 *   source: 'runtime'|'asar'|'profile'|'broken-link'|'missing',
 *   path?: string,
 *   linkTarget?: string,
 *   unverified?: boolean,
 * }} BundleResolution
 */

/** asar 索引头的合理上限：DSH 那份只有几 MB，读到 GB 说明文件根本不是 asar。 */
const ASAR_MAX_HEADER = 64 * 1024 * 1024;

/**
 * 临时关掉 Electron 的 asar fs 补丁。
 *
 * dsh 宿主、以及它用 `ELECTRON_RUN_AS_NODE=1` 拉起的桥/控制台都带着这层补丁：
 * `.asar` 被当成**虚拟目录** —— `statSync` 报 size 0，`openSync` 抛 ENOENT。
 * 于是归档头明明可读，进程内却读不出来，核心 bundle 又被判成「无法确认」
 * （issue #26 的补充报告）。普通 node 里 `process.noAsar` 只是普通属性，赋值无害。
 *
 * 这个开关是**进程级**的：这里同步执行，结束后恢复原值（含原本没有该属性的情况）。
 */
export function withoutAsarPatch(fn) {
  // Electron 专有开关，@types/node 里没有声明；普通 node 里它只是普通属性
  const proc = /** @type {{ noAsar?: boolean }} */ (process);
  const had = Object.prototype.hasOwnProperty.call(proc, 'noAsar');
  const prev = proc.noAsar;
  proc.noAsar = true;
  try {
    return fn();
  } finally {
    if (had) proc.noAsar = prev;
    else delete proc.noAsar;
  }
}

/**
 * 读 Electron asar 归档的索引头（只读 8 + headerSize 字节，不解包任何文件）。
 *
 * 格式（实测 `%LOCALAPPDATA%\Programs\WorkBuddy\resources\app.asar` 对照验证）：
 *   [0,4)   uint32 = 4                    —— pickle 头自身长度
 *   [4,8)   uint32 = headerSize           —— 紧随其后的头部字节数
 *   [8,12)  uint32 = headerSize - 4
 *   [12,16) uint32 = jsonLen              —— 索引 JSON 的字节数
 *   [16,…)  jsonLen 字节的 JSON（按 4 字节对齐补齐）
 *
 * 为什么不用 `@electron/asar`：本项目的依赖只有 devDependencies，运行时零依赖；
 * 为了判一个目录存在与否引入 300KB 的打包工具不划算，而这段解析只有二十行。
 *
 * @returns {{ ok: true, files: Record<string, any> } | { ok: false, reason: string }}
 */
export function readAsarHeader(asarPath) {
  return withoutAsarPatch(() => {
    let fd;
    try {
      fd = openSync(asarPath, 'r');
      const head = Buffer.alloc(8);
      if (readSync(fd, head, 0, 8, 0) !== 8) return { ok: false, reason: '头部不足 8 字节' };
      const headerSize = head.readUInt32LE(4);
      if (headerSize <= 8 || headerSize > ASAR_MAX_HEADER) {
        return { ok: false, reason: `头部长度异常（${headerSize}）` };
      }
      const buf = Buffer.alloc(headerSize);
      if (readSync(fd, buf, 0, headerSize, 8) !== headerSize) return { ok: false, reason: '头部读取不完整' };
      const jsonLen = buf.readUInt32LE(4);
      if (jsonLen <= 0 || jsonLen > headerSize - 8) {
        return { ok: false, reason: `索引长度异常（${jsonLen}）` };
      }
      const files = JSON.parse(buf.toString('utf8', 8, 8 + jsonLen))?.files;
      if (!files || typeof files !== 'object') return { ok: false, reason: '索引里没有 files' };
      return { ok: true, files };
    } catch (err) {
      return { ok: false, reason: String(err?.message || err) };
    } finally {
      if (fd !== undefined) {
        try { closeSync(fd); } catch { /* 已经关掉/从未打开 */ }
      }
    }
  });
}

/**
 * asar 索引缓存（按 path + mtime + size 失效）。
 *
 * `/api/overview` 每 20 秒轮询一次诊断，每次都重读几 MB 的索引头纯属浪费；
 * 但索引会随 DSH 升级而变，所以用 mtime/size 做失效判据，不做无条件缓存。
 */
const asarCache = new Map();

function asarFiles(asarPath) {
  let st;
  // stat 也要绕开补丁：Electron 里 `.asar` 是虚拟目录，size 恒为 0，缓存键会失真
  try { st = withoutAsarPatch(() => statSync(asarPath)); } catch { return null; }
  const hit = asarCache.get(asarPath);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.result;
  const result = readAsarHeader(asarPath);
  asarCache.set(asarPath, { mtimeMs: st.mtimeMs, size: st.size, result });
  return result;
}

/** 索引里的键名匹配：先精确，再忽略大小写（Windows 文件系统不区分）。 */
function asarChild(files, seg) {
  if (!files || typeof files !== 'object') return '';
  if (Object.prototype.hasOwnProperty.call(files, seg)) return seg;
  const lower = String(seg).toLowerCase();
  for (const key of Object.keys(files)) {
    if (key.toLowerCase() === lower) return key;
  }
  return '';
}

function asarLookup(files, segs) {
  let node = { files };
  for (const seg of segs) {
    const key = asarChild(node.files, seg);
    if (!key) return null;
    node = node.files[key];
  }
  return node;
}

/**
 * 兜底：在**任意层级**的 `node_modules` 下找这个包。
 *
 * 主路径只试 `dsh/node_modules/…`、`node_modules/…` 两个前缀（当前打包布局），
 * 但布局是上游的自由 —— 换一版就可能挪位置。找不到时扫一遍索引，代价是
 * 几万次对象遍历，只在"疑似缺失"时才付。
 */
function asarScanFor(files, segs) {
  const queue = [{ files, depth: 0 }];
  let budget = 20000;
  for (let i = 0; i < queue.length && budget > 0; i += 1) {
    const { files: node, depth } = queue[i];
    for (const [key, child] of Object.entries(node)) {
      if (!child || typeof child !== 'object' || !child.files) continue;
      budget -= 1;
      if (key === 'node_modules') {
        const hit = asarLookup(child.files, segs);
        if (hit && hit.files) return true;
        continue;
      }
      if (depth < 8) queue.push({ files: child.files, depth: depth + 1 });
    }
  }
  return false;
}

/**
 * 打包安装里有没有这个 bundle。
 *
 * @returns {{ found: boolean, readable: boolean, via?: string }}
 */
function asarBundle(asarPath, name) {
  const res = asarFiles(asarPath);
  if (!res || res.ok !== true) return { found: false, readable: false };
  const segs = String(name).split('/').filter(Boolean);
  for (const prefix of [['dsh', 'node_modules'], ['node_modules'], []]) {
    const node = asarLookup(res.files, [...prefix, ...segs]);
    if (node && node.files) return { found: true, readable: true, via: [...prefix, ...segs].join('/') };
  }
  if (asarScanFor(res.files, segs)) return { found: true, readable: true, via: 'node_modules（扫描命中）' };
  return { found: false, readable: true };
}

/**
 * 一个候选路径是什么。
 *
 * **悬空 junction 必须单独认出来**（issue #26）：`existsSync` 对悬空链接返回
 * false，于是 `readdir` 里看得见、判定却说不存在；用户按"缺失"去重装，而真相
 * 是链接指向的临时目录被系统清理了。`lstat` 能看见链接本身，`stat` 才能解析目标。
 */
function inspectPath(p) {
  let st;
  try { st = lstatSync(p); } catch { return { kind: 'none' }; }
  if (st.isSymbolicLink()) {
    let linkTarget = '';
    try { linkTarget = readlinkSync(p); } catch { /* 读不到目标就当空串 */ }
    try {
      const real = statSync(p);
      return real.isDirectory() ? { kind: 'dir', linkTarget } : { kind: 'file', linkTarget };
    } catch {
      return { kind: 'broken-link', linkTarget };
    }
  }
  return st.isDirectory() ? { kind: 'dir' } : { kind: 'file' };
}

/**
 * 安装布局：`standalone`（有 node_modules）、`packed`（有 app.asar）、`unknown`。
 *
 * 判据只用于一件事：**看不懂布局时不许断言"缺失"**。DSH 的两种发行形态在
 * 磁盘上的样子完全不同，任何第三种形态都该被当成"未知"而不是"没装"。
 *
 * @returns {{ runtime: string, asarPath: string, layout: 'standalone'|'packed'|'unknown' }}
 */
export function dshInstallLayout(runtime = '') {
  if (!runtime) return { runtime: '', asarPath: '', layout: 'unknown' };
  const asarPath = join(dirname(runtime), 'app.asar');
  // 同上：宿主进程里 `.asar` 会被 fs 补丁认成目录，必须按真实文件判断
  const packedAsar = withoutAsarPatch(() => existsSync(asarPath)) ? asarPath : '';
  const layout = existsSync(join(runtime, 'node_modules'))
    ? 'standalone'
    : (packedAsar ? 'packed' : 'unknown');
  return { runtime, asarPath: packedAsar, layout };
}

/**
 * 解析一个 bundle 装在哪。
 *
 * 顺序 = 从"最确定"到"最不确定"：运行时自带 → 打包 asar → profile（含用户的
 * 符号链接）。任何一处确认存在就返回 `installed: true` —— DSH 的解析顺序也是
 * 「安装自带优先，profile 兜底」，与这里一致。
 *
 * @param {string} name
 * @param {{ runtime?: string, home?: string, profileDir?: string, asarPath?: string, layout?: string }} ctx
 * @returns {BundleResolution}
 */
export function resolveBundle(name, ctx = {}) {
  const install = ctx.layout && ctx.asarPath !== undefined
    ? { runtime: ctx.runtime || '', asarPath: ctx.asarPath, layout: ctx.layout }
    : dshInstallLayout(ctx.runtime || '');
  const { layout, asarPath } = install;
  /** @type {BundleResolution} */
  const base = { name, installed: false, optional: isOptionalBundle(name), source: 'missing' };

  /** @type {{ path: string, source: 'runtime'|'profile' }[]} */
  const candidates = [];
  // runtime 探测不到时**不要给空串候选**：join('') 会拼出相对路径，相对 cwd
  // 判断可能误命中别人的目录。
  if (ctx.runtime) candidates.push({ path: join(ctx.runtime, 'node_modules', name), source: 'runtime' });
  if (ctx.home) candidates.push({ path: join(ctx.home, 'profiles', 'node_modules', name), source: 'profile' });
  if (ctx.profileDir) candidates.push({ path: join(ctx.profileDir, 'node_modules', name), source: 'profile' });

  let broken = null;
  for (const c of candidates) {
    const hit = inspectPath(c.path);
    if (hit.kind === 'dir') {
      return { ...base, installed: true, source: c.source, path: c.path, ...(hit.linkTarget ? { linkTarget: hit.linkTarget } : {}) };
    }
    if (hit.kind === 'broken-link' && !broken) broken = { path: c.path, linkTarget: hit.linkTarget };
  }

  if (asarPath) {
    const packed = asarBundle(asarPath, name);
    if (packed.found) return { ...base, installed: true, source: 'asar', path: asarPath };
    // asar.unpacked 是解到磁盘上的那一半（含原生模块的包会走这里）
    for (const prefix of [['dsh', 'node_modules'], ['node_modules']]) {
      const unpacked = join(`${asarPath}.unpacked`, ...prefix, name);
      if (inspectPath(unpacked).kind === 'dir') {
        return { ...base, installed: true, source: 'asar', path: unpacked };
      }
    }
    if (broken) {
      return { ...base, installed: false, source: 'broken-link', path: broken.path, linkTarget: broken.linkTarget };
    }
    if (!packed.readable && isCoreBundle(name)) return { ...base, unverified: true };
    return base;
  }

  if (broken) {
    return { ...base, installed: false, source: 'broken-link', path: broken.path, linkTarget: broken.linkTarget };
  }
  // 布局看不懂 + 核心 bundle → 判不了。宁可说"无法确认"，也不能说"缺失"。
  if (isCoreBundle(name) && layout === 'unknown') return { ...base, unverified: true };
  return base;
}

/**
 * 解析一批 bundle（`readDshStatus` 与用例共用）。
 *
 * @param {string[]} names
 * @param {{ runtime?: string, home?: string, profileDir?: string, asarPath?: string, layout?: string }} [ctx]
 * @returns {BundleResolution[]}
 */
export function collectBundles(names, ctx = {}) {
  const install = ctx.layout && ctx.asarPath !== undefined
    ? { runtime: ctx.runtime || '', asarPath: ctx.asarPath, layout: ctx.layout }
    : dshInstallLayout(ctx.runtime || '');
  return (Array.isArray(names) ? names : []).map((name) => resolveBundle(name, { ...ctx, ...install }));
}

/**
 * 把 bundle 列表压成「能不能工作」的判断 + 分类好的缺失项。
 *
 * 关键约定：**`unverified` 不算缺失**。它表示插件进程判不了（打包 asar 读不到），
 * 此时报红会重现 issue #26 的误报；诊断项会以 warn + 说明文字代替。
 *
 * @param {BundleResolution[]} bundles
 */
export function bundleHealth(bundles) {
  const list = Array.isArray(bundles) ? bundles : [];
  const missing = list.filter((b) => !b?.installed);
  const missingRequired = missing.filter((b) => b?.optional !== true);
  const missingOptional = missing.filter((b) => b?.optional === true);
  const unverified = missingRequired.filter((b) => b?.unverified === true);
  const confirmedMissing = missingRequired.filter((b) => b?.unverified !== true);
  const brokenLinks = confirmedMissing.filter((b) => b?.source === 'broken-link');
  const reallyMissing = confirmedMissing.filter((b) => b?.source !== 'broken-link');
  const packed = list.filter((b) => b?.installed === true && b?.source === 'asar').length;
  const status = !list.length
    ? 'warn'
    : reallyMissing.length
      ? 'fail'
      : (missingRequired.length || missingOptional.length ? 'warn' : 'ok');
  return {
    missing, missingRequired, missingOptional,
    /** 确认缺失（能指出应该装在哪）—— 只有这一类该报红。 */
    reallyMissing,
    /** 只找到悬空链接：链接坏了，但不代表 dsh 解析不到。 */
    brokenLinks,
    /** 判不了（打包布局看不懂）。 */
    unverified,
    /** 从 app.asar 里确认存在的个数，用来在界面说明"随安装提供"。 */
    packed,
    status,
  };
}

/**
 * 读取 dsh 侧全部相关状态。不返回任何凭据值。
 *
 * 路由可能出现在两个位置，二者都算生效：
 *
 *   1. `$DSH_HOME/settings.yaml` —— 官方「用户设置文档」，热重载。
 *   2. `$DSH_HOME/profiles/<name>/cordis.patch.yml` —— profile 的 patch 层。
 *
 * DSH Desktop 0.2.0 会把 (1) 合并进 (2) 并把原文件归档为
 * `settings.yaml.imported`，因此 (1) 消失属正常流程，不能据此判失败。
 */
export function readDshStatus() {
  const out = {
    home: config.dsh.home,
    settingsPath: config.dsh.settingsPath,
    credentialsPath: config.dsh.credentialsPath,
    patchPath: join(config.dsh.profileDir, 'cordis.patch.yml'),
    settingsExists: false,
    settingsHasRoute: false,
    patchHasRoute: false,
    settingsText: '',
    settingsModels: [],
    patchModels: [],
    registeredModels: [],
    hasBridgeKey: false,
    refNames: [],
    /** 每个 bundle 的解析结果（含 source 证据，见 BundleResolution）。 */
    bundles: [],
    bundlesOk: true,
    /**
     * 安装布局：standalone（runtime 里有 node_modules）/ packed（核心 bundle 在
     * `resources/app.asar` 内）/ unknown（都看不到，判不了）。
     */
    bundlesLayout: 'unknown',
    /** 打包安装时那份 asar 的绝对路径（诊断用它决定是否允许说"缺失"）。 */
    bundlesAsar: '',
    /** 手写 llm-pi-ai 路由（迁移前形态）是否存在且生效。 */
    manualRoute: false,
    /** 插件原生路由（运行时注册）是否会被加载 —— 由 profile 配置判定。 */
    nativeRoute: false,
    /** nativePlugin = 原生插件的安装/启用状态；routeMode ∈ manual / native / none。 */
    nativePlugin: { installed: false, enabled: false, disabledByPatch: false, provider: 'workbuddy', bundle: '' },
    routeMode: 'none',
  };

  // settings.yaml 写作 `llm-pi-ai:`，patch 层写作 `- id: llm-pi-ai`，两者都要认
  const hasRoute = (text) => /llm-pi-ai/.test(text) && /workbuddy:/.test(text);
  // 缩进随所在文件而变（settings.yaml 是 4 空格，patch 层是 6 空格）。
  // id 允许带引号（新版写入时会加引号做纵深防御），这里两种形式都要认 ——
  // 匹配到引号会让「已注册模型」显示成带引号的 id，进而让失效检测全部误判。
  const modelsUnder = (text) => {
    const seg = text.split(/\r?\n\s*workbuddy:\s*\r?\n/)[1] || '';
    return [...seg.matchAll(/^\s*-\s*id:\s*"?([A-Za-z0-9._:-]+)"?\s*$/gm)].map((m) => m[1]);
  };

  if (existsSync(config.dsh.settingsPath)) {
    const text = readFileSync(config.dsh.settingsPath, 'utf8');
    out.settingsExists = true;
    out.settingsText = text;
    out.settingsHasRoute = hasRoute(text);
    out.settingsModels = modelsUnder(text);
  }

  let patchText = '';
  if (existsSync(out.patchPath)) {
    patchText = readFileSync(out.patchPath, 'utf8');
    out.patchHasRoute = hasRoute(patchText);
    if (out.patchHasRoute) out.patchModels = modelsUnder(patchText);
  }

  // settings.yaml 是**用户最新的意图**，patch 层是 DSH Desktop 导入过的历史快照。
  // 两者取并集会把「以前注册过、现在已取消」的模型也算进去，表现为"勾 2 个却显示一堆"。
  // 因此有 settings.yaml 路由时以它为准，否则才退回 patch。
  out.registeredModels = out.settingsHasRoute
    ? [...new Set(out.settingsModels)]
    : [...new Set(out.patchModels)];
  out.manualRoute = out.settingsHasRoute || out.patchHasRoute;

  if (existsSync(config.dsh.credentialsPath)) {
    const text = readFileSync(config.dsh.credentialsPath, 'utf8');
    out.hasBridgeKey = text.includes('WORKBUDDY_BRIDGE_KEY');
    // 只回传键名，绝不回传值
    out.refNames = (text.match(/^\s{2}([A-Z][A-Z0-9_]*):/gm) || [])
      .map((l) => l.trim().replace(':', ''));
  }

  /*
   * profile 的 bundles 是否都能解析；缺一个整个 profile 就起不来。
   *
   * 判定不能只看 `existsSync`（issue #26）：
   *   - 打包安装（Electron）把核心 bundle 放在 `resources/app.asar` **里面**：
   *     普通 node 的 `existsSync` 穿不透归档；而宿主进程里的 asar fs 补丁又把
   *     `.asar` 当成虚拟目录（连归档头都读不到）—— 所以读取必须走
   *     `withoutAsarPatch()`；
   *   - `profiles/node_modules` 下的 junction 可能指向已被系统清理的临时目录，
   *     `existsSync` 也是 false，但"不存在"和"链接坏了"是两回事。
   * 两种误判都会让诊断报红并给出"去 profile 里 pnpm add"的错误建议 ——
   * 对 `@deepseek-ai/dsh-*` 这类随安装提供的包，那条建议本身就有破坏性。
   */
  const install = dshInstallLayout(config.dsh.runtime);
  out.bundlesLayout = install.layout;
  out.bundlesAsar = install.asarPath;
  const pkgPath = join(config.dsh.profileDir, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      const list = pkg.dsh?.profile?.bundles || [];
      out.bundles = collectBundles(list.map((n) => String(n)), {
        runtime: config.dsh.runtime,
        home: config.dsh.home,
        profileDir: config.dsh.profileDir,
        asarPath: install.asarPath,
        layout: install.layout,
      });
    } catch (err) {
      out.bundlesError = err.message;
    }
  }
  out.bundlesOk = bundlesAllInstalled(out.bundles);

  // 原生路由：插件 bundle 已安装且没有被 patch 关掉，dsh 启动时就会注册 provider。
  // 这是**控制台进程唯一能看到的运行时事实**（它不在 dsh 进程里，拿不到 route.registered）。
  out.nativePlugin = detectNativeRoute(patchText, out.bundles);
  out.nativeRoute = out.nativePlugin.enabled;
  out.routeLive = out.manualRoute || out.nativeRoute;
  out.routeMode = out.manualRoute ? 'manual' : (out.nativeRoute ? 'native' : 'none');
  out.routeSource = out.settingsHasRoute
    ? 'settings.yaml'
    : out.patchHasRoute
      ? 'cordis.patch.yml'
      : out.nativeRoute ? '插件原生路由（运行时注册）' : '';

  return out;
}

/**
 * 「dsh 必需的 bundle 都装好了吗」。
 *
 * **空列表不算健康。** `[].every(...)` 返回 `true`，所以当 profile 目录缺失、
 * 插件列表读不出来、或上面那段 catch 吞掉异常之后 `bundles` 为空时，
 * 这个函数原先会返回 `true` —— **读不到任何东西却被判成「健康」**，
 * 是最糟的一类失败（用户看到绿点，实际什么都没检查）。
 *
 * 实验 bundle（`@deepseek-ai/dsh-experimental-*`）属于可选功能，声明了但没装
 * 时不把整体判成不健康 —— 诊断侧会单独给 warn，而不是 fail。
 *
 * **`unverified` 也不算不健康**：它表示插件进程判不了（打包 asar 读不到、
 * 或安装布局不认识），既不能证实也不能证伪。把它算成"缺失"就是 issue #26 的
 * 误报 —— 概览会给一个"待修复"，而用户根本没有可修的东西。诊断项会以
 * warn + 说明文字交代清楚。
 *
 * 空 = 未知；未知不等于健康。抽成独立函数是为了能直接对它写用例
 * （`readDshStatus` 要读真实环境，不好单测）。
 */
export function bundlesAllInstalled(bundles) {
  return Array.isArray(bundles)
    && bundles.length > 0
    && bundles.filter((b) => b?.optional !== true).every((b) => b.installed || b?.unverified === true);
}

/**
 * YAML 双引号标量转义。
 *
 * **只转义反斜杠与引号是不够的**：YAML 双引号标量里的真实换行是"续行折叠"，
 * 而后续行只要缩进回到块层级就会**结束这个标量** —— 于是 `id: "a\n注入: x"`
 * 会变成 `maliciousTopLevel:` 这样的**顶层键**。实测被 security.test.mjs 抓住。
 * 所以换行/回车/制表符与其余 C0 控制字符都必须转成 YAML 的 `\n`/`\xNN` 转义形式。
 */
function yamlStr(value) {
  const escaped = String(value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
    // 其余 C0 控制字符（含 DEL）：不转义同样可能撑破 YAML 结构
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,
      (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
  return `"${escaped}"`;
}

/**
 * 模型 id 的**合法形态**（安全白名单）。
 *
 * 为什么必须卡死：id 会被拼进 YAML（settings.yaml 与 cordis.patch.yml），而它
 * 来自网络（上游目录）且 `/api/register` 接受任意请求体。一个含换行的 id 能往
 * 配置里塞进**顶层** YAML 键 —— 而 cordis patch 的顶层列表项就是插件/适配器
 * 条目，下次 dsh 启动时会加载它。实测确认（见本轮取证脚本）可以注入
 * `maliciousTopLevel:` 甚至 `- id: injected-adapter`，即配置注入 → 潜在任意代码执行。
 *
 * 用白名单而不是黑名单：任何「识别危险字符再过滤」的做法都会漏掉编码变体，
 * 而真实 id 的形态很窄（`deepseek-v4.1-flash`、`glm-5.3`、`hy4-preview`…）。
 */
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

/** 挑出不合法的模型 id（调用方据此**报错拒绝**，绝不静默丢弃）。 */
export function invalidModelIds(models) {
  return (Array.isArray(models) ? models : [])
    .map((m) => String(m?.id ?? ''))
    .filter((id) => !MODEL_ID_RE.test(id));
}

/**
 * 组装 settings.yaml 全文。
 *
 * 只生成 workbuddy 这一条路由，不改动用户的其它分节——因此写入会覆盖整个
 * 文件，调用方必须先备份（见 writeRegistration）。
 */
export function buildSettings(models) {
  const lines = [
    '# DeepSeek Harness 用户设置文档（$DSH_HOME/settings.yaml，热重载）。',
    '#',
    '# 由 WorkBuddy 中转控制台生成：llm-pi-ai 分节把本地桥注册为一条 OpenAI 兼容路由。',
    '# 使用前需先启动桥：项目根目录 启动.cmd（macOS/Linux：scripts/start.sh）→「启动桥服务」。',
    'llm-pi-ai:',
    '  providers:',
    '    workbuddy:',
    '      displayName: WorkBuddy',
    '      # 按请求解析的凭据引用；实际值在 $DSH_HOME/.credentials.yaml。',
    '      apiKeyEnv: WORKBUDDY_BRIDGE_KEY',
    '      api: openai-completions',
    `      baseURL: ${config.bridge.url}/v1`,
    '      models:',
  ];
  for (const m of models) {
    // id 走 yamlStr：即使上游目录将来给出白名单外的 id（当前已在
    // writeRegistration 拦下），引号也能保证 YAML 结构不被撑破 —— 纵深防御。
    lines.push(`        - id: ${yamlStr(m.id)}`);
    lines.push(`          name: ${yamlStr(m.name || m.id)}`);
    if (m.contextWindow) lines.push(`          contextWindow: ${m.contextWindow}`);
    if (m.maxTokens) lines.push(`          maxTokens: ${m.maxTokens}`);
    lines.push('          input:');
    lines.push('            - text');
  }
  return `${lines.join('\n')}\n`;
}

/** 生成 cordis.patch.yml 中 llm-pi-ai 条目的文本（缩进对齐 patch 层）。 */
function buildPatchEntry(models) {
  const lines = [
    '- id: llm-pi-ai',
    '  name: "@deepseek-ai/dsh-llm-pi-ai"',
    '  config:',
    '    providers:',
    '      workbuddy:',
    '        displayName: WorkBuddy',
    '        apiKeyEnv: WORKBUDDY_BRIDGE_KEY',
    '        api: openai-completions',
    `        baseURL: ${config.bridge.url}/v1`,
    '        models:',
  ];
  for (const m of models) {
    lines.push(`          - id: ${yamlStr(m.id)}`);
    lines.push(`            name: ${yamlStr(m.name || m.id)}`);
    if (m.contextWindow) lines.push(`            contextWindow: ${m.contextWindow}`);
    if (m.maxTokens) lines.push(`            maxTokens: ${m.maxTokens}`);
    lines.push('            input:');
    lines.push('              - text');
  }
  return lines.join('\n');
}

/** 就地替换 patch 文本里的 llm-pi-ai 条目；不存在则追加到数组末尾。 */
function upsertPatchEntry(text, entryText) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.trim() === '- id: llm-pi-ai');

  if (start === -1) {
    const sep = text.endsWith('\n') ? '' : '\n';
    return `${text}${sep}${entryText}\n`;
  }

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^- id: /.test(lines[i])) { end = i; break; }
  }
  return [
    ...lines.slice(0, start),
    ...entryText.split('\n'),
    ...lines.slice(end),
  ].join('\n');
}

/**
 * 写入模型注册，返回结果。写入前自动备份。
 *
 * 同时写两处，各自的原因不同：
 *   settings.yaml      —— 官方「用户设置文档」，DSH Desktop 会把它导入 patch 层
 *   cordis.patch.yml   —— DSH **实际生效**的位置，立即生效、不必等重启
 *
 * 只写前者会留下「patch 里还是旧列表」的不一致：界面读到的已注册模型与实际
 * 生效的不符（表现为勾 2 个却显示一堆）。
 */
export function writeRegistration(models) {
  if (!Array.isArray(models) || models.length === 0) {
    throw new Error('models 不能为空');
  }
  // 先卡 id（唯一会被拼进 YAML 的字段）：非法值**当场拒绝**，绝不写进配置。
  // 静默丢弃是不行的 —— 用户会看到「保存成功」但少了一批模型，且不知道原因；
  // 报出具体 id 才能让他去查目录。见 MODEL_ID_RE 的说明。
  const bad = invalidModelIds(models);
  if (bad.length) {
    throw new Error('模型 id 不合法，已拒绝写入（含换行等字符的 id 会破坏 dsh 的 YAML 配置）：'
      + bad.slice(0, 5).map((s) => JSON.stringify(s)).join('、')
      + (bad.length > 5 ? ` 等 ${bad.length} 个` : ''));
  }
  const clean = models.map((m) => ({
    id: String(m.id),
    name: m.name ? String(m.name) : String(m.id),
    contextWindow: Number(m.contextWindow) || 0,
    maxTokens: Number(m.maxTokens) || 0,
  }));

  let backup = null;
  if (existsSync(config.dsh.settingsPath)) {
    const stamp = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
    backup = `${config.dsh.settingsPath}.bak-${stamp}`;
    copyFileSync(config.dsh.settingsPath, backup);
  }
  /*
   * **原子替换**：先写临时文件再 rename。
   *
   * 这份文件是 dsh 的配置，写坏它等于把用户的模型列表弄丢。上面已经做了
   * `.bak-<stamp>` 备份（比不备份强得多），但直接覆盖仍有一个窗口：正好在这时
   * 被杀 / 断电会留下**半份** YAML，而用户多半不会知道要去翻 `.bak-`。
   * 同目录内 rename 是原子的（Windows 上也是），崩在任何一步都不会破坏原文件。
   *
   * 与桥写账本（`bridge/workbuddy-bridge.mjs` 的截断）用同一套做法。
   */
  const tmpPath = `${config.dsh.settingsPath}.tmp`;
  writeFileSync(tmpPath, buildSettings(clean), 'utf8');
  renameSync(tmpPath, config.dsh.settingsPath);

  // 同步 patch 层：否则那里仍是旧列表，界面读到的与实际生效的不一致
  const patchPath = join(config.dsh.profileDir, 'cordis.patch.yml');
  let patchBackup = null;
  try {
    if (existsSync(patchPath)) {
      const stamp = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
      patchBackup = `${patchPath}.bak-${stamp}`;
      copyFileSync(patchPath, patchBackup);
      const next = upsertPatchEntry(readFileSync(patchPath, 'utf8'), buildPatchEntry(clean));
      writeFileSync(patchPath, next, 'utf8');
    }
  } catch (err) {
    // patch 写失败不影响 settings.yaml 已落盘的结果，但要让调用方知道
    return {
      saved: true,
      path: config.dsh.settingsPath,
      backup,
      count: clean.length,
      patchError: String(err.message || err),
    };
  }

  return {
    saved: true,
    path: config.dsh.settingsPath,
    backup,
    patchPath,
    patchBackup,
    count: clean.length,
  };
}
