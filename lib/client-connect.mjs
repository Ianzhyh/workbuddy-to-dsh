/**
 * 一键接入：把桥的 Base URL 与本地令牌**写进**常见客户端的配置文件。
 *
 * ## 为什么要有这个模块
 *
 * 控制台原先只给「复制片段」，用户仍要自己去 `~/.codex/config.toml`、
 * `~/.claude/settings.json`、`opencode.json` 里对准格式手改 —— JSON 少个逗号、
 * TOML 放错节、令牌抄错一位，都会变成"配了但连不上"，而排查成本全在用户那边。
 *
 * ## 安全网（用户明确要求「允许改，但要有安全网」）
 *
 * 改别人的配置文件是高危操作，所以四条铁律：
 *
 * 1. **只动自己的键 / 节**，其余内容一字不改（原样保留注释、顺序、缩进）。
 * 2. **每次先整份备份**到 `.backup/client-configs/<客户端>/<时间戳>-<原名>`。
 * 3. **可撤销**：撤销按 `applied.json` 里记录的**原始值**逐键还原，
 *    而不是拿备份整份盖回去 —— 用户可能在写入后又手改过别的地方，
 *    整份还原会连带丢掉他自己的改动。
 * 4. **幂等**：重复写入结果一致且不覆盖首次记录的原值（否则撤销会还原成中间态）。
 *
 * ## 一个容易被忽略的点：写进去的东西是**凭据**
 *
 * 令牌会落进这些配置文件。所以写完后要用与令牌文件同一套 `hardenTokenFile()`
 * 收紧权限 —— 否则「令牌文件本身收紧了、但顺手把它抄进了三个世界可读的配置文件」
 * 等于白做。加固结果如实回报，不静默。
 */
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, renameSync, rmSync, statSync,
  openSync, closeSync, writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';

import config, { hardenTokenFile } from '../config.mjs';
import { bridgeHealth, bridgeModels } from './diagnostics.mjs';

/**
 * 模块加载时记下的家目录。**只作为兜底** —— 真正算路径时要用调用那一刻的
 * `USERPROFILE` / `HOME`（见 `homeDir()`）。
 *
 * 为什么不能拿它当主来源：它在 `import` 那一刻就定死了，而"先 import 再设 env"
 * 是最自然的写法（本项目的测试与 `启动.cmd` 都可能这么做）。原先三处路径都读它，
 * 于是设了 `CODEX_HOME` 也照样能工作、但设了 `USERPROFILE` 就不行 —— 不一致得莫名其妙。
 */
const HOME_FALLBACK = homedir();

/** 备份 + 撤销记录都放这里。`.backup/` 已在 .gitignore 里。 */
const DEFAULT_BACKUP_ROOT = () => join(homeDir(), '.workbuddy-bridge', 'client-configs');
/**
 * 仓库内的备份根。**必须跟着代码位置（`config.ROOT`）走，不能跟着 `process.cwd()`**。
 *
 * 实测（子进程，从别的目录启动）：用 cwd 时备份根会变成
 * `<那个目录>\.backup\client-configs` ——
 *   · 用户换个启动方式（快捷方式、计划任务、从别处 `node dashboard/server.mjs`）
 *     就会发现**上次的备份与撤销记录不见了**；
 *   · 更糟的是 `planClient`（读 manifest 判"已接入"）与 `applyClient`（写 manifest）
 *     若落在不同根下，会出现「刚写入成功、界面却显示还没接入」这种自相矛盾的状态。
 * 备份是本产品自己产生的东西，位置只该由**代码在哪**决定。
 */
const REPO_BACKUP_ROOT = () => join(config.paths.root, '.backup', 'client-configs');

/**
 * 三处路径都要**在调用时**算（别在模块加载时定死成常量）。
 *
 * 理由：`CODEX_HOME` / `CLAUDE_CONFIG_DIR` / `XDG_CONFIG_HOME` 都是各家官方支持的
 * 重定位手段，而它们可能在进程运行期间才被设置（测试就是这么做的，`启动.cmd`
 * 里也可能现设）。模块加载时取值会让"先 import 再设 env"这种最自然的写法失效。
 */
const homeDir = () => process.env.USERPROFILE || process.env.HOME || HOME_FALLBACK;

/**
 * Codex 的配置目录。
 *
 * `CODEX_HOME` 是官方约定 —— 本机用 `codex doctor` 实测过：设了它之后，
 * doctor 自述的 config 路径就变成 `<CODEX_HOME>/config.toml`
 * （它自己也报 `codex_home: AbsolutePathBuf(...)`）。不认这个变量的话，
 * 别人机器上会把配置写到 `~/.codex/` —— 一个 Codex 根本不会读的地方。
 */
function codexDir() {
  const env = process.env.CODEX_HOME;
  return env && env.trim() ? env.trim() : join(homeDir(), '.codex');
}

/**
 * Claude Code 的配置目录。
 *
 * `CLAUDE_CONFIG_DIR` 是官方约定（文档原话：To keep the home-directory files
 * somewhere else, set `CLAUDE_CONFIG_DIR`；Claude Code then stores your settings,
 * session history, and plugins there instead）。
 */
function claudeDir() {
  const env = process.env.CLAUDE_CONFIG_DIR;
  return env && env.trim() ? env.trim() : join(homeDir(), '.claude');
}

/**
 * opencode 的全局配置目录。
 *
 * 官方只把 `~/.config/opencode/opencode.json` 定为全局层（Windows 也走
 * `%USERPROFILE%\.config\`，不是 `%APPDATA%`）。`OPENCODE_CONFIG` 是**另一层**
 * —— 它指定的是"另一个配置文件"，优先级高于全局；那是另一件事，不在这里冒充。
 * 所以这里只按 XDG 约定处理：有 `XDG_CONFIG_HOME` 就跟它走。
 */
function opencodeGlobalDir() {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.trim() ? xdg.trim() : join(homeDir(), '.config');
  return join(base, 'opencode');
}

/**
 * 支持的客户端。`format` 决定用哪套合并逻辑；`e2e` 是**本机真实跑通**的标注：
 *   `true`  —— 在本机装了、写过、验过往返（Codex）
 *   `false` —— 按官方 schema 实现，并有临时目录往返单测，但本机没装该客户端，
 *              "客户端是否真的认这份配置"没实测过。**必须如实标注**，
 *              把没验过的写成验过，用户装完发现不对会连带怀疑整个项目。
 *
 * ## 路径为什么是**函数**而不是字符串
 *
 * 三个理由：
 *   1. 用户可能把客户端装到非常规位置，得有覆盖手段（与
 *      `WORKBUDDY_STATE_FILE` / `WORKBUDDY_AUTH_FILE` 同一套做法）；
 *   2. **单测绝不能碰用户真实的配置文件** —— 没有覆盖手段就只能拿真文件测，
 *      那是拿使用者的 `~/.codex/config.toml` 当试验场；
 *   3. 各家都有自己的重定位环境变量（见上面三个 dir 函数），而它们随时可能被设置。
 *
 * 读 env 的时机放在调用时（而不是模块加载时），否则「先 import 再设 env」的
 * 测试写法会失效，而那种写法是最自然的。
 */
export const CONNECT_CLIENTS = [
  {
    id: 'codex',
    label: 'Codex',
    format: 'toml',
    overrideEnv: 'WORKBUDDY_CODEX_CONFIG',
    clientEnv: 'CODEX_HOME',
    defaultPath: () => join(codexDir(), 'config.toml'),
    e2e: true,
  },
  {
    id: 'claude',
    label: 'Claude Code',
    format: 'json',
    overrideEnv: 'WORKBUDDY_CLAUDE_SETTINGS',
    clientEnv: 'CLAUDE_CONFIG_DIR',
    defaultPath: () => join(claudeDir(), 'settings.json'),
    e2e: false,
  },
  {
    id: 'opencode',
    label: 'opencode',
    format: 'json',
    overrideEnv: 'WORKBUDDY_OPENCODE_CONFIG',
    clientEnv: 'XDG_CONFIG_HOME',
    /**
     * **全局**配置。项目级 `opencode.json` 不走一键接入 —— 它属于用户的具体项目，
     * 位置只有用户知道；那种场景仍然用「复制片段」。
     * Windows 上也是 `%USERPROFILE%\.config\opencode\`（不是 %APPDATA%）。
     *
     * ## 为什么是"挑一个已存在的"而不是写死 `opencode.json`
     *
     * opencode **两种文件名都认**（官方配置文档：*OpenCode supports both JSON and
     * JSONC (JSON with Comments) formats*，且示例大量使用 `opencode.jsonc`；
     * 源码走读里全局层按 `config.json → opencode.json → opencode.jsonc` 的顺序尝试）。
     *
     * 原先这里写死 `opencode.json`，实测后果（本机真实环境）：
     * 用户的配置叫 `opencode.jsonc`、里面**已经有 workbuddy 的 provider 块**，
     * 而面板显示「已安装，尚未接入」—— 因为 `exists` 查的是 `.json`。
     * 界面在说假话，而且点「写入」会在旁边**多造一个 `opencode.json`**：
     * 按文档的优先级它会**盖住**用户那个 `.jsonc`，用户自己写在里面的设置
     * （`disabled_providers` 之类）就不再生效了。
     *
     * 所以规则是：**已存在的那个就是用户的配置**，改它就对了；
     * 两个都存在时用 `.json`（文档里的全局名，也是优先级更高的那个）。
     * 都不存在才默认 `.json`。
     *
     * 注：走读里提到的 `config.json` 是**更老的名字**，官方文档里没有，
     * 因此不纳入（宁可不认，也不要写到一个新版本根本不读的文件里）。
     */
    defaultPath: () => {
      const dir = opencodeGlobalDir();
      for (const name of ['opencode.json', 'opencode.jsonc']) {
        const p = join(dir, name);
        if (existsSync(p)) return p;
      }
      return join(dir, 'opencode.json');
    },
    e2e: false,
  },
  {
    /**
     * **Codex 的 profile 通道**：写 `$CODEX_HOME/workbuddy.config.toml`，用
     * `codex -p workbuddy` 启动 —— 用户的基础配置 `config.toml` **一个字节都不动**。
     *
     * 依据（`codex --help`，本机 0.162.0-alpha.17.2）：
     *   `-p, --profile <CONFIG_PROFILE_V2>  Layer $CODEX_HOME/<name>.config.toml
     *    on top of the base user config`
     * 也就是说 profile 文件与基础配置**同构**（同样的键、同样的节），只是叠加上去 ——
     * 所以这里的合并逻辑与 codex 完全共用，不需要第二套写法。
     *
     * 它是"便捷性与安全性同时更好"的那一档：不需要备份/撤销/权限加固那一整套，
     * 因为**基础配置根本没被碰过**；不想要了就不带 `-p` 启动。
     * 代价：**桌面应用不接受命令行开关**，所以只有 CLI 用得上（这一点必须如实标注）。
     *
     * `profileFor` 让控制台把它**挂在 Codex 那一行的详情里**，而不是单开一行 ——
     * 它和"改基础配置"是同一个决策的两个选项，不是第四个客户端。
     */
    id: 'codex-profile',
    label: 'Codex · profile',
    format: 'toml',
    overrideEnv: 'WORKBUDDY_CODEX_PROFILE',
    clientEnv: 'CODEX_HOME',
    defaultPath: () => join(codexDir(), 'workbuddy.config.toml'),
    e2e: false,
    profileFor: 'codex',
    profileName: 'workbuddy',
    /**
     * **目录文件名必须与基础配置那份分开**：两份配置各自记着自己的备份与"是否我们建的"，
     * 共用一份文件的话，撤销其中一个会把另一个正在引用的目录删掉。
     */
    catalogName: 'workbuddy-profile-catalog.json',
  },
];

export const findClient = (id) => CONNECT_CLIENTS.find((c) => c.id === id) || null;

/**
 * 写入 / 撤销的可选项。
 *
 * `backupRoot` 既可测也可运维：用例必须能把备份写进临时目录（否则会往用户仓库里
 * 堆一大堆测试残留），运维也可能想把备份放别处。
 *
 * @typedef {{ backupRoot?: string }} ConnectOpts
 */

/** 该客户端配置文件的实际路径（env 覆盖优先）。 */
export function clientPath(client) {
  const override = process.env[client.overrideEnv];
  return override ? override : client.defaultPath();
}

/**
 * 这个路径是**怎么定下来的** —— 界面/命令行要如实说出来，用户才能确认没认错。
 *
 * 三种来源：`env`（我们自己的显式覆盖 `WORKBUDDY_*`）、
 * `client`（客户端自己的官方重定位变量，如 `CODEX_HOME`）、`default`（家目录默认）。
 *
 * @returns {{ source: 'env'|'client'|'default', envName: string|null }}
 */
export function clientPathSource(client) {
  if (process.env[client.overrideEnv]) return { source: 'env', envName: client.overrideEnv };
  if (client.clientEnv && process.env[client.clientEnv] && String(process.env[client.clientEnv]).trim()) {
    return { source: 'client', envName: client.clientEnv };
  }
  return { source: 'default', envName: null };
}

/**
 * 「装没装」看**目录**在不在，而不是配置文件在不在 ——
 * 多数客户端第一次运行才建配置文件，而用户往往是「先装客户端、后接入」。
 */
export const clientInstalled = (client) => existsSync(dirname(clientPath(client)));

// ── 通用小工具 ──────────────────────────────────────────────────────────

/** 原子写：先写临时文件再 rename，避免进程中断留下半截 JSON/TOML。 */
function writeAtomic(path, text) {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = `${path}.wb-tmp`;
  writeFileSync(tmp, text, 'utf8');
  renameSync(tmp, path);
}

/**
 * 整份备份一个文件，返回备份路径。**调用方保证该文件存在。**
 *
 * 抽出来是因为"动用户配置"现在有两个入口（接入 / 切模式），两处都得先备份；
 * 各写一份迟早会漏掉其中一条路。
 */
function backupFile(path, root, clientId) {
  mkdirSync(join(root, clientId), { recursive: true });
  const dest = join(root, clientId, `${stamp()}-${basename(path)}`);
  copyFileSync(path, dest);
  return dest;
}

/**
 * 收紧**备份目录**的权限。
 *
 * 为什么必须单独做一遍：`hardenTokenFile(客户端配置)` 只覆盖配置文件本身，
 * 而备份是它**写之前的整份拷贝** —— 从第二次写入起里面必然有令牌；撤销记录
 * （`applied.json`）的 `restore.section` 也可能带着上一把令牌。
 *
 * 实测（2026-10-10，本机真实 ACL）：
 *   客户端配置 `.codex/config.toml`        → `Ian:(F)`（已收紧）
 *   `.backup/client-configs/codex/*-config.toml` → 继承来的
 *   `Authenticated Users:(M)` + `Users:(RX)`
 * 也就是：**同机任何用户都能读到那把令牌**，而令牌能直接调桥、消耗账号额度。
 * 收紧令牌文件却把它的副本留在世界可读的目录里，等于白做。
 *
 * 失败**不阻断**接入（备份内容本身是好的），但必须如实回报 ——
 * 与 `hardenTokenFile` 同一套口径：不静默。
 */
function hardenBackupDir(root, clientId) {
  try {
    const r = hardenTokenFile(join(root, clientId), { recursive: true });
    return r && r.ok === false ? r : { ok: true };
  } catch (e) {
    return { ok: false, reason: e?.message || String(e) };
  }
}

/** 读文本；不存在返回 `null`（区分「文件不存在」与「文件是空的」）。 */
function readText(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * 剥掉 UTF-8 BOM。
 *
 * 必须剥：Windows 上用记事本另存过的 JSON 会带 BOM，`JSON.parse` 遇到 BOM 直接抛
 * —— 用户会看到"你的配置文件格式不对"，而文件其实只是多了三个不可见字节。
 */
const stripBom = (s) => (s && s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

/** 时间戳：`20261009-204512`，用于备份文件名。 */
function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * 剥掉 JSONC 的注释（`//` 行注释与 `/* *\/` 块注释），字符串内部一律不动。
 *
 * 为什么要支持：官方文档明确写着 *OpenCode supports both JSON and JSONC
 * (JSON with Comments) formats*，而用户手写配置时加注释极常见。原先直接
 * `JSON.parse` → 报"不是合法 JSON"，还提示"请手工编辑"——**本可以一键接上**的场景
 * 变成了手工活，而且提示方向是错的（用户没写错，那就是官方支持的格式）。
 *
 * 实现上最容易踩的坑是**把字符串里的 `//` 当注释**：
 * `"baseURL": "http://127.0.0.1:8790/v1"` 一截断，写进去的地址就废了，
 * 而写入还会报成功（JSON 照样解析得通，只是值变了）。所以这里逐字符扫，
 * 遇到 `"` 就进"字符串态"、正确处理 `\\` 转义，只在字符串外识别注释。
 *
 * **尾逗号不处理**（`{"a":1,}`）：那不在 JSONC 规范里，真遇到了要如实报错，
 * 不能猜 —— 猜错就是把用户的文件改坏。
 */
function stripJsonComments(src) {
  let out = '';
  let inStr = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    const next = src[i + 1];
    if (inLine) {
      if (c === '\n') { inLine = false; out += c; }
      continue;
    }
    if (inBlock) {
      if (c === '*' && next === '/') { inBlock = false; i += 1; }
      continue;
    }
    if (inStr) {
      out += c;
      if (c === '\\') { out += next ?? ''; i += 1; continue; }   // 转义：下一个字符原样带走
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === '/' && next === '/') { inLine = true; i += 1; continue; }
    if (c === '/' && next === '*') { inBlock = true; i += 1; continue; }
    out += c;
  }
  return out;
}

function jsonParseSmart(text, path) {
  const raw = String(text ?? '');
  /*
   * **空文件 = "还没有配置"**，不是"格式不对"。
   *
   * 客户端自己建了个空文件、或用户 `touch` 出来的，都很常见 —— 那是**最该能一键接上**
   * 的状态。原先直接交给 `JSON.parse('')` 去抛，用户看到"不是合法 JSON
   * （Unexpected end of JSON input）"以及"你是不是写了注释"的提示，方向全错。
   */
  if (raw.trim() === '') return { ok: true, value: {}, empty: true };
  const body = stripBom(raw);
  const bom = raw.charCodeAt(0) === 0xfeff;
  try {
    return { ok: true, value: JSON.parse(body), bom };
  } catch (strictErr) {
    /*
     * 严格 JSON 不通时再试一次**剥掉注释**的版本（JSONC）。
     * 仍然不通才报错 —— 而且报的是**剥注释后**的那个错误，
     * 否则用户会看到"注释处语法错误"这种自相矛盾的话（注释本来是合法的）。
     */
    try {
      return { ok: true, value: JSON.parse(stripJsonComments(body)), bom, hadComments: true };
    } catch {
      /*
       * 解析失败**必须停手**，不能"反正重写一份"。
       * 用户的配置文件里可能有我们没见过的字段 —— 直接覆盖等于把他攒的东西一次清空。
       */
      return { ok: false, error: `${path} 不是合法 JSON（${strictErr.message}）；没有改动它。若是带注释的 JSONC，请手工编辑或先用「复制片段」。` };
    }
  }
}

// ── TOML：按行处理，只碰自己的键与节 ────────────────────────────────────

/**
 * TOML 用**行级**处理而不是通用解析器。
 *
 * 理由：通用解析器要完整实现 TOML（日期、多行字符串、行内表…），写不全就会在
 * 用户写了奇怪语法时崩掉；而行级只做"找顶层键 / 找节边界"这两件确定的事，
 * 其余内容**原样保留**（注释、空行、缩进、键的顺序都不会动）。
 *
 * 局限（明确写出来，不假装支持）：不支持顶层**多行**值（`key = """…"""`）里
 * 恰好出现 `[section]` 形状的行。真实客户端配置里不会这么写。
 */

/** 第一个 `[section]` 出现的行号；没有节就返回行数。 */
function firstSectionIndex(lines) {
  for (let i = 0; i < lines.length; i += 1) {
    if (/^\s*\[/.test(lines[i])) return i;
  }
  return lines.length;
}

/** 键名匹配：`key = ...` / `key=...`，只认裸键（不带引号、不带点）。 */
const keyRe = (key) => new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=`);

/**
 * 设 / 删一个**顶层**键（第一个节之前）。返回 `{ lines, from, changed }`。
 * `value === null` 表示删除。
 *
 * **值没变就不重写那一行**。看似多余的讲究，其实是不让"格式规范化"变成隐形写入：
 * 用户写的是 `model="x"`（无空格），我们若照自己的格式重写，文件就动了，
 * 但报出来的改动是「`x` → `x`」——用户会以为工具在乱改他的文件。
 * 只在**值真的不同**时才接管这一行。
 */
export function tomlTopLevel(lines, key, value) {
  const limit = firstSectionIndex(lines);
  const re = keyRe(key);
  const parse = (line) => {
    const raw = String(line).split('=').slice(1).join('=').trim();
    return raw.replace(/^['"]|['"]$/g, '');
  };
  for (let i = 0; i < limit; i += 1) {
    if (!re.test(lines[i])) continue;
    const from = String(lines[i]).split('=').slice(1).join('=').trim();
    if (value === null) {
      lines.splice(i, 1);
      return { lines, from, changed: true };
    }
    const same = parse(lines[i]) === parse(`${key} = ${value}`);
    if (!same) lines[i] = `${key} = ${value}`;
    return { lines, from, changed: !same };
  }
  if (value === null) return { lines, from: null, changed: false }; // 本来就没有 → 删除是空操作
  // 插到「节之前的最后一个非空行」后面；不插在紧贴 `[section]` 的位置，读起来清楚
  let at = limit;
  while (at > 0 && lines[at - 1].trim() === '') at -= 1;
  lines.splice(at, 0, `${key} = ${value}`);
  return { lines, from: null, changed: true };
}

/**
 * 读一个**顶层**键的字符串值（`model_catalog_json = "x.json"` → `"x.json"`）。
 * 只在第一个节之前找；找不到 / 值是空的就返回 `null`。
 */
function tomlTopLevelValue(lines, key) {
  const limit = firstSectionIndex(lines);
  const re = keyRe(key);
  for (let i = 0; i < limit; i += 1) {
    if (!re.test(lines[i])) continue;
    const raw = String(lines[i]).split('=').slice(1).join('=').trim().replace(/^['"]|['"]$/g, '');
    return raw || null;
  }
  return null;
}

/** 取一个节的内容范围（不含节标题行）。找不到返回 `null`。 */
function tomlSectionRange(lines, name) {
  const header = `[${name}]`;
  const start = lines.findIndex((l) => l.trim() === header);
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end])) end += 1;
  return { start, end };
}

/**
 * 写入 / 替换一个节。返回 `{ lines, from, changed }`；`from` 是**原节内容**
 * （不存在则 `null`），撤销时要还原成它。
 *
 * `from` 刻意**不带尾部空行**：文件末尾的 `split('\n')` 会多出一个空元素，
 * 不裁掉的话同一份内容两次算出来的 `from` 不同 —— 幂等判据会永远为"有改动"，
 * 于是每次开控制台都报一次"要写入"，而实际上什么都没变。
 */
export function tomlUpsertSection(lines, name, bodyLines) {
  // 节与上一个节之间留一个空行，避免黏在一起
  const block = [`[${name}]`, ...bodyLines];
  const range = tomlSectionRange(lines, name);
  if (!range) {
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
    if (lines.length) lines.push('');
    lines.push(...block);
    return { lines, from: null, changed: true };
  }
  let end = range.end;
  while (end > range.start + 1 && lines[end - 1].trim() === '') end -= 1;
  const from = lines.slice(range.start + 1, end).join('\n');
  const same = from === bodyLines.join('\n');
  if (same) return { lines, from, changed: false };
  lines.splice(range.start, end - range.start, ...block);
  return { lines, from, changed: true };
}

/** 删除一个节。返回 `{ lines, from, changed }`。 */
export function tomlRemoveSection(lines, name) {
  const range = tomlSectionRange(lines, name);
  if (!range) return { lines, from: null, changed: false };
  let end = range.end;
  while (end > range.start + 1 && lines[end - 1].trim() === '') end -= 1;
  const from = lines.slice(range.start + 1, end).join('\n');
  let after = range.end;
  while (after < lines.length && lines[after].trim() === '') after += 1;
  lines.splice(range.start, after - range.start);
  return { lines, from, changed: true };
}

/**
 * TOML 基本字符串字面量。
 *
 * ⚠️ **控制字符必须转义**（尤其是换行）。值可能来自接口入参（`--model`、
 * POST 里的 `model`），带一个换行写出去就**多出一行** —— 而我们的 TOML 处理是
 * 行级的，那一行会被当成配置内容，于是可以凭空插入
 * `[model_providers.evil]` 这样的节。
 *
 * 实测复现：桥没起时目录为空 → `assertModelKnown` 放行 → 传
 * `model = "x\n[model_providers.evil]\nbase_url = 'http://attacker/v1'"`
 * 就能把任意节写进用户的 `config.toml`。
 *
 * TOML 基本字符串本来就支持 `\uXXXX` 转义，转义后**语义不变**（值还是那个值），
 * 只是不可能再变成"多出来的一行"。
 */
const tomlStr = (v) => `"${String(v)
  .replace(/\\/g, '\\\\')
  .replace(/"/g, '\\"')
  // 控制字符（含换行）一律转成 TOML 转义：不可能再变成"多出来的一行"
  .replace(/[\u0000-\u001f\u007f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)}"`;

/** 段落合并：Codex 的 `~/.codex/config.toml`。 */
function mergeCodex(text, ctx) {
  const lines = (text ?? '').split('\n');
  const changes = [];
  const restore = { topLevel: {}, section: null };

  const topLevel = [['model', tomlStr(ctx.model)], ['model_provider', tomlStr('workbuddy')]];
  /*
   * 多模型：Codex 认的模型清单来自 `model_catalog_json` 指向的目录文件。
   * **只在真的要写那份目录时才接管这个键**（`ctx.catalogFile` 有值）——
   * 它是全局键，用户可能已经指向别的东西（本机就是 cc-switch 的目录），
   * 没内容要写却把它换掉，等于白动别人的配置。
   */
  if (ctx.catalogFile) topLevel.push(['model_catalog_json', tomlStr(ctx.catalogFile)]);

  for (const [key, value] of topLevel) {
    const r = tomlTopLevel(lines, key, value);
    restore.topLevel[key] = r.from;
    if (!r.changed) continue;
    const next = value.replace(/^"|"$/g, '');
    const prev = r.from ? r.from.replace(/^"|"$/g, '') : null;
    changes.push({ path: key, kind: 'value', from: prev, to: next });
  }

  const body = [
    'name = "WorkBuddy (local bridge)"',
    `base_url = ${tomlStr(ctx.baseUrlOpenAI)}`,
    /*
     * 注释**写英文**。它会落进用户的配置文件，而配置文件的那段内容在控制台上
     * 是以原文展示的（`<pre>` 上带 `data-i18n-skip`，因为是"数据而非界面文案"）——
     * 写中文的话，英文界面下用户看到的就是一段翻不动的中文。
     * 与既有片段同一约定（见 `codexConfigText` 里那句 `# macOS / Linux`）。
     */
    '# "chat" wire_api was removed upstream; "responses" is the only value Codex still accepts',
    'wire_api = "responses"',
    `experimental_bearer_token = ${tomlStr(ctx.token)}`,
  ];
  // `from` 就是原节内容（不存在则 null）——撤销要还原成它
  const r = tomlUpsertSection(lines, 'model_providers.workbuddy', body);
  if (r.changed) {
    /*
     * 节级改动单独标 `kind: 'section'`，**不在这里拼人话**。
     * 界面要把它显示成「新增节 / 替换已有的节」，而界面是双语的 ——
     * 描述文案必须在词条表里，不能由这一层拼出中文字符串
     * （那样英文模式下这一句永远翻不动，是这套 i18n 最容易踩的坑）。
     */
    changes.push({ path: 'model_providers.workbuddy', kind: 'section', from: r.from === null ? null : 'existing', to: 'written' });
  }
  restore.section = r.from;

  return { text: normalize(lines), changes, restore };
}

function unmergeCodex(text, restore) {
  const lines = (text ?? '').split('\n');
  for (const [key, from] of Object.entries(restore.topLevel || {})) {
    tomlTopLevel(lines, key, from === null ? null : from);
  }
  const section = restore.section;
  if (section === null || section === undefined) tomlRemoveSection(lines, 'model_providers.workbuddy');
  else tomlUpsertSection(lines, 'model_providers.workbuddy', section.split('\n'));
  return normalize(lines);
}

/** 收尾：保证文件以单个换行结束；原来是空的就保持空。 */
function normalize(lines) {
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  if (!lines.length) return '';
  return lines.join('\n') + '\n';
}

// ── JSON：按记录下来的键路径改 ──────────────────────────────────────────

/** 读一条键路径（`a.b.c`），不存在返回 `undefined`。 */
const getPath = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);

/**
 * 写一条键路径；`value === null` 表示删除该键。
 *
 * ⚠️ 沿途遇到**不是普通对象**的中间层（数组 / 字符串 / 数字 / null）时，**停下来
 * 返回 false**，绝不"顺手覆盖成 `{}`"。
 *
 * 为什么：`settings.json` 里 `"env": []`、`opencode.json` 里 `"provider": null`
 * 这类内容是**用户（或别的工具）自己的状态**。原先 `setPath` 直接把它替换成 `{}`
 * 再往里写 —— 撤销时那条 `provider` 只会被还原成**它写入时的值**（此时已是 `{}`），
 * 于是用户的东西被**静默换掉**且回不来：apply 报 ok、undo 也报 ok，文件却变了。
 * 实测撞到过（对抗式往返）。
 */
function setPath(obj, path, value) {
  const keys = path.split('.');
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i += 1) {
    const k = keys[i];
    const next = cur[k];
    if (next === undefined) {
      cur[k] = {};
    } else if (next === null || typeof next !== 'object' || Array.isArray(next)) {
      return false;   // 中间层是用户的数据，不覆盖
    }
    cur = cur[k];
  }
  const last = keys[keys.length - 1];
  if (value === null) delete cur[last];
  else cur[last] = value;
  return true;
}

/** 段落合并：Claude Code 的 `~/.claude/settings.json`。 */
function mergeClaude(text, ctx) {
  const patch = {
    'env.ANTHROPIC_BASE_URL': ctx.baseUrlAnthropic,
    'env.ANTHROPIC_API_KEY': ctx.token,
    /*
     * 显式写入默认模型。Claude Code 会把它当作请求里的 model 发出来，桥的
     * Anthropic 层精确命中目录就原样使用 —— 于是「用户选的」== 「实际跑的」。
     * 不写这行也能用（Claude Code 发 claude-* 别名，桥同样映射到默认模型），
     * 但那样用户在客户端里既看不到实际模型、也无从显式指定，与本次改进的目标相悖。
     */
    'env.ANTHROPIC_MODEL': ctx.model,
  };
  /*
   * 多模型：Claude Code 的 `/model` 选择器可以用 `modelPicker` 自定义。
   * 键的作用域是 **user / managed**，而 `~/.claude/settings.json` 正是 user 文件 ✓。
   *
   * `replaceBuiltInOptions: true` 是刻意的：把 Base URL 指到桥之后，内置那几条
   * Claude 模型（Sonnet / Opus / Haiku）在桥上会被映射到**别的**模型
   * （桥的 Anthropic 层对不认识的 claude-* 一律回默认模型）。留着它们 =
   * 用户选「Sonnet」实际跑的是 glm-5.3 —— 界面在说假话。宁可只列出真实可用的那些。
   * 需要内置列表时点一次「撤销」，这行的原值会逐键还原。
   */
  if (Array.isArray(ctx.models) && ctx.models.length >= 2) {
    patch.modelPicker = {
      options: ctx.models.map((m) => ({
        model: m.id,
        label: m.name || m.id,
        description: 'via WorkBuddy local bridge',
      })),
      replaceBuiltInOptions: true,
    };
  }
  return mergeByPaths(text, patch);
}

/** 段落合并：opencode 的 `opencode.json`。 */
function mergeOpencode(text, ctx) {
  const models = {};
  for (const m of ctx.models || []) {
    models[m.id] = {
      name: m.name || m.id,
      // opencode 只对内置 provider 自动拉上下文；自定义 provider 不写 limit 就是「上下文 0」
      limit: { context: m.context || 128000, output: m.maxOutput || 8192 },
    };
  }
  // 默认模型必须在声明列表里，否则 opencode TUI 的 /models 里选不到 workbuddy/<model>。
  // contextForClient 通常已补过；这里再兜一手，直接调 mergeOpencode 的场景也成立。
  if (ctx.model && !models[ctx.model]) {
    models[ctx.model] = { name: ctx.model, limit: { context: 128000, output: 8192 } };
  }
  return mergeByPaths(text, {
    $schema: 'https://opencode.ai/config.json',
    'provider.workbuddy': {
      npm: '@ai-sdk/openai-compatible',
      name: 'WorkBuddy (local bridge)',
      options: { baseURL: ctx.baseUrlOpenAI, apiKey: ctx.token },
      models,
    },
    // 设默认模型，否则接入完还得在 TUI 里手动挑一次 provider —— 那就不是「无脑」了
    model: `workbuddy/${ctx.model}`,
  });
}

/**
 * 通用 JSON 合并：给一组键路径 → 值，改完重新序列化。
 *
 * `restore` 记录**每条的原始值**（`null` = 原来没有该键），撤销时逐条还原。
 *
 * ⚠️ **序列化会统一成全 2 空格缩进** —— 用户原来的排版（行内对象、4 空格、
 * 制表符）会被重排。这是 JSON 这条路线的固有代价：不做格式保真就要引入一个
 * 保格式的解析器，成本远大于收益。但**不能假装没这回事**：这里把
 * `reformats` 报上去，界面在二次确认时明说，用户看得见再决定。
 * （TOML 那条路是行级的，格式原样保留，没有这个问题。）
 */
function mergeByPaths(text, patch) {
  const parsed = jsonParseSmart(text ?? '{}', '配置文件');
  if (!parsed.ok) return { error: parsed.error };

  const original = stripBom(String(text ?? ''));
  // 空文件 / `null` / 数组都当空对象处理（原始内容靠 restore 能还原）
  const root = (parsed.value && typeof parsed.value === 'object' && !Array.isArray(parsed.value))
    ? parsed.value
    : {};
  const reformats = original.trim() !== ''
    && original !== `${JSON.stringify(parsed.value, null, 2)}\n`;

  const changes = [];
  const restore = { jsonPaths: {} };
  /** 这次写入**凭空造出来**的中间容器（形如 `provider`），撤销时要一并清掉。 */
  const created = new Set();
  /** 因为中间层是用户数据（数组 / null 等）而**跳过**的键 —— 要如实报上去。 */
  const skipped = [];
  for (const [path, value] of Object.entries(patch)) {
    const before = getPath(root, path);
    restore.jsonPaths[path] = before === undefined ? null : before;
    if (JSON.stringify(before) === JSON.stringify(value)) continue; // 幂等：没变就不报改动
    /*
     * 记下沿途缺失的容器。不记的话撤销只能删叶子（`provider.workbuddy`），
     * 而我们造出来的空壳 `"provider": {}` 会留下来 —— 看着无害，
     * 但用户会看到"撤销之后文件里多了个空对象"，而且它不等于"没接入过"。
     */
    const keys = path.split('.');
    let probe = root;
    for (let i = 0; i < keys.length - 1; i += 1) {
      if (probe == null || typeof probe !== 'object') break;
      if (probe[keys[i]] === undefined) created.add(keys.slice(0, i + 1).join('.'));
      probe = probe[keys[i]];
    }
    if (!setPath(root, path, value)) {
      // 中间层是用户自己的数据（数组 / null / 字符串…）：不覆盖，但也别装作写成功了
      skipped.push(path);
      delete restore.jsonPaths[path];
      continue;
    }
    changes.push({ path, kind: 'value', from: before === undefined ? null : before, to: value });
  }
  restore.created = [...created];
  return {
    text: (parsed.bom ? '\uFEFF' : '') + JSON.stringify(root, null, 2) + '\n',
    changes,
    restore,
    reformats,
    skipped,
  };
}

function unmergeJson(text, restore) {
  const parsed = jsonParseSmart(text ?? '{}', '配置文件');
  if (!parsed.ok) return { error: parsed.error };
  const root = parsed.value;
  if (!root || typeof root !== 'object') return { text: text ?? '' };
  for (const [path, value] of Object.entries(restore.jsonPaths || {})) {
    setPath(root, path, value === null ? null : value);
  }
  // 空容器要**深的先删**（先删 `a.b` 才轮得到 `a`）
  const empties = (restore.created || []).slice().sort((a, b) => b.split('.').length - a.split('.').length);
  for (const c of empties) {
    const v = getPath(root, c);
    if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0) setPath(root, c, null);
  }
  /*
   * **BOM 要还回去**。`stripBom` 是为了能解析（Windows 记事本另存会带 BOM），
   * 但撤销的承诺是"还原到接入之前" —— 那就该连那三个字节一起还原。
   * 用户的文件原本带 BOM，撤销后不带，是"看起来对、其实变了"的那一类。
   */
  return { text: (parsed.bom ? '\uFEFF' : '') + JSON.stringify(root, null, 2) + '\n' };
}

// ── Codex 的模型目录（多模型的唯一途径）────────────────────────────────
//
// Codex 认哪些模型，来自 `model_catalog_json` 指向的那份 `{models:[…]}` 目录文件。
// 一个 provider 配置只能有一个「当前模型」（`model`），所以「多模型」在 Codex 里
// 就等于「目录里列全 + 用 -m / 选择器切换」。
//
// 这里最要紧的两条：
//   1. **别人的条目一条都不动**：用户可能已经有个目录（本机就是 cc-switch 的，
//      里面是他别的隧道模型）。我们读进来、原样保留，只补自己缺的那些；
//   2. **模板必须来自已知可用的条目**：目录条目的字段有三十来个（含 19KB 的
//      `model_messages.instructions_template`），少一个字段 Codex 可能整份解析失败。
//      所以从不"凭字段名拼一条"，而是**克隆**现成条目再改 slug/名字/上下文。
//      模板来源按可靠性排序：现有目录 → Codex 自己抓的 `models_cache.json`。
//      两者都没有时**不生成目录**，如实告诉用户"Codex 只能接一个模型"，不硬编。

const CATALOG_FILENAME = 'workbuddy-model-catalog.json';

/**
 * 该客户端用哪个目录文件名。
 *
 * Codex 有两条通道（基础配置 / profile 文件），**必须各用各的目录文件**：
 * 两份配置各自记着自己的备份与"这个文件是不是我们建的"，共用一份的话，
 * 撤销其中一个会把另一个正在引用的目录删掉。
 */
const catalogFileName = (client) => client?.catalogName || CATALOG_FILENAME;

/** 读 JSON 文件；不存在 / 解析失败一律返回 `null`（调用方只关心"能不能用"）。 */
function readJsonFile(path) {
  const text = readText(path);
  if (text === null) return null;
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

/**
 * 我们写进目录条目的标记。用来认出「这条是我们写的」——
 * 只有自己写的条目才允许被重算，别人的（cc-switch 之类）一律不动。
 */
const CATALOG_OWN_MARK = 'via WorkBuddy local bridge';

/** 这条目录条目是我们写的吗（按 description 里的标记认）。 */
const isOwnCatalogEntry = (m) => typeof m?.description === 'string' && m.description.includes(CATALOG_OWN_MARK);

/**
 * 找一份**可克隆的模板条目**，以及现有目录里已经有的模型。
 * 返回 `{ template, models, from, fromKey }` 或 `null`。
 */
function readCatalogSource(client) {
  const cfgPath = clientPath(client);
  const dir = dirname(cfgPath);
  const ref = tomlTopLevelValue((readText(cfgPath) ?? '').split('\n'), 'model_catalog_json');
  if (ref) {
    const refPath = isAbsolute(ref) ? ref : join(dir, ref);
    const parsed = readJsonFile(refPath);
    if (Array.isArray(parsed?.models) && parsed.models.length) {
      /*
       * 模板优先取**别人的**条目：cc-switch 那种面向"第三方 chat/completions 上游"
       * 写出来的条目，比 Codex 官方模型（code mode）更接近我们要的形状。
       */
      const foreign = parsed.models.find((m) => m && !isOwnCatalogEntry(m));
      return { template: foreign || parsed.models[0], models: parsed.models, from: refPath, fromKey: true };
    }
  }
  // Codex 自己抓下来的上游目录（登录过就有）：只借它的**模板形状**，不抄它的模型 ——
  // 抄进来等于宣称"这些模型也能通过桥用"，而它们只能走官方账号。
  const cache = readJsonFile(join(dir, 'models_cache.json'));
  if (Array.isArray(cache?.models) && cache.models.length) {
    return { template: cache.models[0], models: [], from: join(dir, 'models_cache.json'), fromKey: false };
  }
  return null;
}

/**
 * 按模板克隆一条目录条目。只改归属、上下文与**行为开关** —— 其余字段原样继承。
 *
 * ⚠️ 那几行开关必须**显式定死**，不能让它们随模板漂：
 *   - `use_responses_lite` / `tool_mode`：Codex 官方模型是 **code mode**
 *     （工具塞在 `input[].additional_tools`，shell / apply_patch 全收进一个
 *     freeform 的 `exec`，让模型写 JavaScript 去编排工具）。桥的上游是
 *     chat/completions，**不认这套协议**。一旦写成 code mode，上游一个工具都收不到，
 *     模型只能把工具调用写进正文（实测：正文里出现
 *     `<||DSML||invoke name="exec_command">` 这种标记），Codex 无工具可执行 →
 *     一个回合就此结束 —— 用户看到的就是"话说一半断了"。
 *   - `multi_agent_version`：Codex 多智能体的版本号，与我们的上游无关。
 */
function makeCatalogEntry(template, model) {
  const window = Number(model.context) || 128000;
  const entry = {
    ...template,
    slug: model.id,
    display_name: model.name || model.id,
    description: `${model.name || model.id} — ${CATALOG_OWN_MARK}`,
    context_window: window,
    max_context_window: window,
    use_responses_lite: false,
  };
  delete entry.tool_mode;
  delete entry.multi_agent_version;
  return entry;
}

/**
 * 算一份「要写成什么样的模型目录」。不落盘。
 *
 * 规则：**别人的条目一条不动**；我们自己写过的条目按当前规则重算
 * （否则旧版本写坏的字段永远纠正不过来）；没勾选的不写。
 *
 * `refreshed` 只在**重算结果与现有条目真的不同**时才算改动 —— 判据是内容，
 * 不是"这条是我们写的"。详见下面循环里的说明。
 *
 * 返回 `{ path, name, text, added, refreshed, kept, from }` 或 `{ skipped: 原因 }`。
 * `skipped` 是**正常结果**（不是错误）：比如现有目录里已经把这些模型都列全了，
 * 那就没必要接管那个键。
 */
export function planModelCatalog(client, ctx = {}) {
  const picked = Array.isArray(ctx.models) ? ctx.models : [];
  if (!picked.length) return { skipped: '没有勾选任何模型' };
  const src = readCatalogSource(client);
  if (!src) return { skipped: '本机找不到可用的目录模板（既没有现成的模型目录，也没有 models_cache.json）' };

  const foreign = src.models.filter((m) => m && !isOwnCatalogEntry(m));   // 别人的：原样带走
  const out = [...foreign];
  const added = [];
  const refreshed = [];
  for (const m of picked) {
    if (!m || !m.id) continue;
    if (foreign.some((x) => x.slug === m.id)) continue;                    // 同名条目是别人的 → 不抢
    const entry = makeCatalogEntry(src.template, m);
    const prev = src.models.find((x) => isOwnCatalogEntry(x) && x.slug === m.id);
    /*
     * **重算结果与现有条目一字不差 → 什么都不用动。**
     *
     * 原先的判据是"这条是我们写的就算 `refreshed`"，于是**每次打开面板都报"有改动"**：
     * 明明什么都没变，标签却一直挂着「已接入，需重新写入」；用户点一次「重新写入」，
     * 文件内容不变、标签也不变 —— 那句话彻底失去信息量。真正需要重写的时候
     * （比如刚补上一个漏写的模型），用户反而看不出来，因为**平时也一直是这句**。
     *
     * 实测现场：用户勾了 5 个模型，面板显示 5 个 / 「需重新写入」，客户端里始终只有 4 个。
     * 那行提示既可能是"真有 1 个没写进去"、也可能只是例行刷新 —— 无从分辨。
     *
     * 该重算的场景依然覆盖：旧版本写进去的条目带着 code mode 开关（`use_responses_lite`
     * / `tool_mode`），重算结果与它**内容不同**，照旧进 `refreshed` 并被重写。
     * 判据从"是不是我们写的"换成"内容一不一样"，只去掉假改动，不去掉真纠正。
     */
    if (prev && JSON.stringify(prev) === JSON.stringify(entry)) {
      out.push(prev);
      continue;
    }
    out.push(entry);
    (prev ? refreshed : added).push(m.id);
  }
  /*
   * 什么都不用动、而且键本来就指向一份能读的目录 → 不接管这个键。
   *
   * `refreshed` 也算"要动"：旧版本写进去的条目带着 code mode 开关，
   * 必须重写才能纠正（那正是本次修复的核心场景）。
   *
   * 而**稳态**（目录里已经一字不差地列着勾选的这批）会走到这里 —— 这是有意的：
   * 不再每次接入都把那 90 多 KB 的目录重写一遍，也不让面板显示"有改动"。
   */
  if (!added.length && !refreshed.length && src.fromKey) {
    return { skipped: '勾选的模型在现有目录里都已经有了，不需要改 model_catalog_json' };
  }

  const name = catalogFileName(client);
  const path = join(dirname(clientPath(client)), name);
  return {
    path,
    name,
    text: JSON.stringify({ models: out }, null, 2) + '\n',
    added,
    refreshed,
    kept: foreign.length,
    from: src.from,
  };
}

/**
 * 「先定目录、再算配置文本」——计划与写入**共用这一条路**。
 *
 * 为什么必须共用：目录文件名要写进 config.toml（`model_catalog_json`），
 * 而"这次到底写不写目录"依赖现有目录的状态。两边各算一次，就可能出现
 * 「预览里写了这个键、真写时又没写」的漂移。
 */
function planWithCatalog(client, text, ctx) {
  const catalog = (client.format === 'toml' && Array.isArray(ctx.models) && ctx.models.length)
    ? planModelCatalog(client, ctx)
    : null;
  const active = catalog && !catalog.skipped ? catalog : null;
  const ctx2 = active ? { ...ctx, catalogFile: active.name } : ctx;
  const merged = planMerge(client, text, ctx2);
  /**
   * 目录文件要不要写。
   *
   * **必须和 config.toml 分开看**：`model_catalog_json` 早写对了的时候，
   * 配置层面"无需改动"，但那份目录可能正是旧版本写坏的（code mode 开关）。
   * 只看 config 的 `changes` 就会提前返回、目录永远纠正不过来，
   * 而界面还显示「已接入」—— 用户没有任何入口触发修复。
   */
  const catalogNeedsWrite = Boolean(active && (active.added.length || active.refreshed.length));
  return {
    ...merged,
    ctx: ctx2,
    catalog: active,
    catalogNeedsWrite,
    catalogSkipped: catalog && catalog.skipped ? catalog.skipped : null,
  };
}

// ── 对外：计划 / 状态 ───────────────────────────────────────────────────

/**
 * 按格式分派。返回 `{ text, changes, restore }` 或 `{ error }`。
 *
 * `@returns` 显式写出来（而不是让 TS 从各分支的字面量去推联合类型）：
 * 推出来的联合类型里没有 `error` / `reformats` 这两个**可选**字段，
 * 调用方一判 `r.error` 就是一片 TS2339（`npm run check:types` 会红）。
 *
 * @returns {{ error?: string, text?: string, changes?: any[], restore?: any, reformats?: boolean, skipped?: string[], hadComments?: boolean }}
 */
function planMerge(client, text, ctx) {
  if (client.format === 'toml') return mergeCodex(text, ctx);
  if (client.id === 'claude') return mergeClaude(text, ctx);
  if (client.id === 'opencode') return mergeOpencode(text, ctx);
  return { error: `未知客户端格式：${client.id}` };
}

function planUnmerge(client, text, restore) {
  if (client.format === 'toml') return { text: unmergeCodex(text, restore) };
  return unmergeJson(text, restore);
}

/**
 * 算一份「要改成什么样」的计划，**不落盘**。
 *
 * 返回：`{ id, label, path, exists, installed, changes, preview, applied, error? }`
 * 控制台拿 `changes` 做二次确认、拿 `preview` 展示写入后的完整内容
 * —— 「所见即所写」，展示的和写进去的必须是同一次计算结果。
 *
 * @param {ConnectOpts} [opts]
 */
export function planClient(id, ctx, opts = {}) {
  const root = resolveBackupRoot(opts.backupRoot);
  const client = findClient(id);
  if (!client) return { error: `不认识的客户端：${id}` };
  const path = clientPath(client);
  const exists = existsSync(path);
  const text = readText(path);
  const r = planWithCatalog(client, text, ctx);
  if (r.error) return { id, label: client.label, path, exists, error: r.error };

  const applied = readManifest(client.id, root);
  const hasRecord = Boolean(applied && applied.path === path);
  /*
   * 模式以**文件本身**为准，不以我们记的账为准 —— 用户可能手工把配置改回去了，
   * 也可能在别的机器上接入过。记的账只用来判断"能不能一键切回来"。
   */
  const mode = clientMode(client);
  return {
    id: client.id,
    label: client.label,
    path,
    e2e: client.e2e,
    installed: clientInstalled(client),
    exists,
    /** 「有没有要动的」= 配置文件改动 **或** 目录文件要补/要纠正。 */
    changed: r.changes.length > 0 || r.catalogNeedsWrite === true,
    changes: r.changes,
    preview: r.text,
    /** 写入会重排该文件的排版（只可能出现在 JSON 那条路上），界面要明说 */
    reformats: r.reformats === true,
    /**
     * 「已接入」= 有记录 **且** 文件现在确实指向桥。切回原始模型之后
     * 文件不再指向桥，这时不该再显示「已接入」（那会让用户以为还在走桥）。
     */
    applied: hasRecord && mode === 'bridge',
    appliedAt: hasRecord ? applied.at || null : null,
    /** 文件现在的模式：`bridge`（走桥）或 `native`（走客户端自己的模型）。 */
    mode,
    /** 记录里记的模式（老记录没有这个字段 → 那时只可能是桥模式）。 */
    recordedMode: hasRecord ? (applied.mode || 'bridge') : null,
    /** 有记录才能一键切回桥（切回原始模型只需要文件，不需要记录）。 */
    canSwitchBack: hasRecord,
    /** 这个路径怎么定下来的（`env` / `client` / `default`）——界面据此如实标注。 */
    pathSource: clientPathSource(client),
    /**
     * 这次要写的模型集合与目录情况（界面用来显示"接入 N 个模型"与目录是否被接管）。
     * `catalogSkipped` 有值时是**正常结果**：说明这次不接管 `model_catalog_json`，
     * 界面要把原因说出来，而不是让用户以为"多模型没生效"。
     */
    models: (Array.isArray(ctx.models) ? ctx.models : []).map((m) => m.id),
    catalog: r.catalog
      ? { path: r.catalog.path, name: r.catalog.name, added: r.catalog.added, refreshed: r.catalog.refreshed, kept: r.catalog.kept, from: r.catalog.from }
      : null,
    catalogSkipped: r.catalogSkipped || null,
    /**
     * 因为**中间层是用户自己的数据**（数组 / null / 字符串）而没能写入的键。
     *
     * 这类键不能装作写成功：用户点了写入、界面报"已接入"，可那几个键其实没进去 ——
     * 下一次请求就会以"客户端没生效"的形式出现，而且极难归因。
     * 界面与命令行据此给出**可操作**的结论：哪几个键、为什么、该怎么办。
     */
    skippedKeys: r.skipped || [],
  };
}

export const listClients = () => CONNECT_CLIENTS.map((c) => {
  const path = clientPath(c);
  return {
    id: c.id, label: c.label, path, e2e: c.e2e, installed: clientInstalled(c), exists: existsSync(path),
    pathSource: clientPathSource(c),
  };
});

// ── 对外：接入上下文（选模型）──────────────────────────────────────────
//
// 「一键接入」要写进客户端的模型，早先是**写死**的（取精选集第一个），用户无从
// 选择。现在把上下文构造收口到这里，控制台与命令行共用同一份口径：
//   buildConnectBase()   —— 抓一次桥健康 + 完整目录，得到候选与各类默认值；
//   contextForClient()   —— 按客户端 + 用户所选，派生出真正写进配置的 ctx；
//   assertModelKnown()   —— 写入前校验所选 id 确实在目录里（杜绝静默回退）。

/**
 * 最近一次成功抓到的目录（审计 R5）。
 *
 * 为什么需要：桥没起来时 `/v1/models` 拿不到，于是"模型 id 是否真实存在"就**无从校验**
 * —— `assertModelKnown` 只能放行（那是"先写配置再启桥"的合理顺序），
 * 代价是用户可能写进去一个根本不存在的模型，而界面还显示"已接入 + 静态自检通过"。
 *
 * 有了这份缓存，桥没起时至少能拿**上次的目录**挡一道，并且如实告诉用户
 * "这是上次抓到的，可能已经过期" —— 而不是装作校验过了。
 *
 * 存的是"键名与少量元数据"，不含任何凭据。
 */
const CATALOG_CACHE_NAME = 'catalog-cache.json';

export function catalogCachePath(opts = {}) {
  return join(resolveBackupRoot(opts.backupRoot), CATALOG_CACHE_NAME);
}

/** 读缓存。返回 `{ at, models }` 或 `null`。 */
export function readCatalogCache(opts = {}) {
  const j = readJsonFile(catalogCachePath(opts));
  return Array.isArray(j?.models) && j.models.length ? { at: j.at || null, models: j.models } : null;
}

/** 写缓存（失败无所谓：它只是"有更好"的东西，不能影响接入本身）。 */
function writeCatalogCache(models, opts = {}) {
  try {
    const p = catalogCachePath(opts);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify({ at: new Date().toISOString(), models }, null, 2) + '\n', 'utf8');
  } catch { /* 缓存写不进去不该影响任何事 */ }
}

/**
 * 抓桥健康与完整目录，派生出「接入上下文」的公共底座。
 *
 * 模型清单取**桥的精选集**（`/health.models`）与完整目录的交集（口径同 `/v1/models`）；
 * 同时保留**完整目录**（`catalogById` / `catalogIds`）—— 用户显式指定的模型可能
 * 不在精选集里，校验与补元数据都要靠完整目录。
 *
 * 桥没起来时精选集为空，退回配置默认，保证「先写配置、再启桥」这条路仍然可用。
 *
 * @returns {Promise<{
 *   token: string, baseUrlOpenAI: string, baseUrlAnthropic: string,
 *   models: Array<{id:string,name:string,context:number,maxOutput:number}>,
 *   catalogById: Map<string,{id:string,name:string,context:number,maxOutput:number}>,
 *   catalogIds: Set<string>, defaultModel: string,
 *   catalogStale: boolean, catalogAt: string|null,
 *   responsesModel: string, anthropicModel: string, running: boolean,
 *   bridge: { up: boolean, authRejected: boolean } }>}
 */
export async function buildConnectBase() {
  const [health, catalog] = await Promise.all([bridgeHealth(), bridgeModels(8000)]);
  const featured = new Set(health.body?.models || []);
  const all = catalog.models || [];
  const catalogById = new Map();
  for (const m of all) {
    if (!m || typeof m.id !== 'string') continue;
    catalogById.set(m.id, {
      id: m.id,
      name: m.name || m.id,
      context: Number(m.context_window) || 0,
      maxOutput: Number(m.max_output_tokens) || 0,
    });
  }
  const models = all
    .filter((m) => m && featured.has(m.id))
    .map((m) => catalogById.get(m.id))
    .filter(Boolean);
  const list = models.length
    ? models
    : [{ id: config.bridge.responsesModel, name: config.bridge.responsesModel, context: 128000, maxOutput: 8192 }];
  /*
   * 目录为空（桥没起 / 上游挂了）→ 用**上次成功抓到的**兜底校验，并标注它已过期。
   * 只补 `catalogIds`（校验用），**不动** `catalogById` / `models` ——
   * 那两者决定界面上能选什么，拿过期数据填进去会让用户以为桥在跑。
   */
  let catalogStale = false;
  let catalogAt = null;
  if (catalogById.size) {
    writeCatalogCache([...catalogById.values()]);
  } else {
    const cached = readCatalogCache();
    if (cached) {
      for (const m of cached.models) {
        if (m && typeof m.id === 'string' && !catalogById.has(m.id)) {
          catalogById.set(m.id, {
            id: m.id,
            name: m.name || m.id,
            context: Number(m.context) || 0,
            maxOutput: Number(m.maxOutput) || 0,
          });
        }
      }
      catalogStale = true;
      catalogAt = cached.at;
    }
  }
  return {
    token: config.bridge.token,
    baseUrlOpenAI: `${config.bridge.url}/v1`,
    baseUrlAnthropic: config.bridge.url,
    models: list,
    catalogById,
    catalogIds: new Set(catalogById.keys()),
    /**
     * 目录是不是"上次抓到的"（桥没起时）。界面与命令行据此说明
     * 「未能确认这些模型现在是否还存在」—— 校验过了不等于校验可信。
     */
    catalogStale,
    catalogAt,
    defaultModel: list[0].id,
    responsesModel: config.bridge.responsesModel,
    anthropicModel: config.bridge.anthropicModel,
    /** 「能不能用」：令牌被拒时就是 false（写进去的配置会连不上）。 */
    running: health.ok === true,
    /**
     * 桥的**进程级**状态，与"我们能不能用它"分开报。
     *
     * `authRejected` 是实测踩到的那种：桥独立启动时自己生成了一把随机令牌，
     * 与控制台读的 `.bridge-token` 不是同一把 → 桥在跑、端口有人应答，
     * 但对控制台每次请求都回 401。界面若只说「桥未运行」，用户会去点
     * 「启动桥服务」并得到"已经在跑了"—— 真正该做的是「重启桥」（让它按控制台
     * 这份令牌重启）。一键接入尤其需要这个区分：否则它会照常把令牌写进客户端
     * 配置，写完才在验证里报一句 401。
     */
    bridge: {
      up: health.running === true,
      authRejected: health.authRejected === true,
    },
  };
}

/**
 * 某客户端在**用户未显式选择**时该写哪个模型。
 *
 * 三层协议的默认各不相同，刻意与桥的映射对齐 —— 写进去的就是桥会跑的：
 *   codex（Responses）→ responsesModel；claude（Anthropic）→ anthropicModel；
 *   opencode（OpenAI，直接透传不重映射）→ 精选集第一个。
 */
export function defaultModelFor(base, clientId) {
  if (clientId === 'codex') return base.responsesModel;
  if (clientId === 'claude') return base.anthropicModel;
  return base.defaultModel;
}

/**
 * 校验用户显式指定的模型 id 是否在**当前目录**里。
 *
 * 为什么要拦：桥对不认识的 id 会**静默回退**到默认 / fast 模型（Responses / Anthropic
 * 层），用户以为选的是 A、实际跑的是 B。写之前先对齐目录，就把这类「配了但不对」
 * 挡在门外。返回 `null` 表示通过；否则返回可直接展示的错误串。
 *
 * 桥没起来（目录为空）时**放行**：那时本就退回配置默认，且「先写配置再启桥」是合理顺序。
 */
export function assertModelKnown(model, base) {
  if (!model) return null;                                        // 没显式选 → 用默认，永远合法
  if (!base || !base.catalogIds || base.catalogIds.size === 0) return null; // 无目录可校
  if (base.catalogIds.has(model)) return null;
  return `未知的模型：${model}（不在当前目录里）；请在控制台确认可用模型，或启动桥后重试`;
}

/**
 * 校验一**批**模型 id（多模型接入用）。
 *
 * 与单个版本同样的判据，但把**所有**不认识的 id 一次报全 —— 一次只报一个，
 * 用户要来回试好几遍。返回 `null` 或可直接展示的错误串。
 */
export function assertModelsKnown(models, base) {
  if (!Array.isArray(models) || models.length === 0) return null;
  if (!base || !base.catalogIds || base.catalogIds.size === 0) return null;
  const bad = models.filter((m) => m && !base.catalogIds.has(m));
  if (!bad.length) return null;
  return `未知的模型：${bad.join(' / ')}（不在当前目录里）；请在控制台确认可用模型，或启动桥后重试`;
}

/**
 * 把「用户勾选的模型 id」解析成带元数据的数组。
 *
 * 空 / 没给 → 用桥的精选集（开箱即用的默认）。**保序去重**：用户在界面里排的顺序
 * 就是写进客户端的顺序，而同一个 id 不能被写两遍（Codex 的目录里重复 slug 会让它
 * 认不出该用哪条）。
 */
export function resolveModelSelection(base, ids) {
  const wanted = Array.isArray(ids)
    ? ids.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim())
    : [];
  const list = wanted.length ? wanted : (base.models || []).map((m) => m.id);
  const seen = new Set();
  const out = [];
  for (const id of list) {
    if (seen.has(id)) continue;
    seen.add(id);
    const meta = base.catalogById?.get(id)
      || (base.models || []).find((m) => m.id === id)
      || { id, name: id, context: 128000, maxOutput: 8192 };
    out.push(meta);
  }
  return out;
}

/**
 * 按「客户端 + 用户所选 + 勾选的模型集合」派生出真正写进配置的 ctx。
 *
 * `chosen` 为空则用该客户端的默认模型；`selection` 为空则用精选集。
 * 主模型**一定**在 `models` 里 —— 否则 opencode 的 `/models` 选不到它、
 * Claude Code 的选择器也指不到它，用户会看到"配了却用不上"。
 */
export function contextForClient(base, clientId, chosen, selection) {
  let models = resolveModelSelection(base, selection);
  const model = chosen || defaultModelFor(base, clientId);
  if (!models.some((m) => m.id === model)) {
    const meta = base.catalogById?.get(model)
      || { id: model, name: model, context: 128000, maxOutput: 8192 };
    models = [...models, meta];
  }
  return {
    token: base.token,
    baseUrlOpenAI: base.baseUrlOpenAI,
    baseUrlAnthropic: base.baseUrlAnthropic,
    model,
    models,
    running: base.running,
  };
}

/**
 * 供界面下拉用的模型候选：优先**完整目录**（用户可选精选集之外的模型），
 * 桥没起来时退回精选 `models`。
 */
export function modelOptions(base) {
  const src = base.catalogById.size ? [...base.catalogById.values()] : base.models;
  return src.map((m) => ({ id: m.id, name: m.name || m.id }));
}

// ── 对外：备份 / manifest ───────────────────────────────────────────────

const manifestPath = (id, backupRoot) => join(backupRoot, id, 'applied.json');

function readManifest(id, backupRoot) {
  const text = readText(manifestPath(id, backupRoot));
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null; // 记录坏了只影响撤销，不影响写入；下面会当作"没有记录"
  }
}

/**
 * 选备份目录。
 *
 * 优先仓库内的 `.backup/`（已在 .gitignore 里，且与项目既有备份习惯一致）；
 * 仓库不可写（比如插件走 vendor 分发、只读安装）时退回用户目录。
 *
 * ⚠️ **读和写必须用同一个根**。`planClient`（读 manifest 判断"已接入"）与
 * `applyClient`（写 manifest）各自算一次根的话，只要两边算出来的不一样，
 * 就会出现「刚写入成功、界面却显示还没接入」这种自相矛盾的状态。
 */
export function resolveBackupRoot(explicit) {
  if (explicit) return explicit;
  // 与 WORKBUDDY_STATE_FILE 一类同样的覆盖手段：让用例可以完全隔离，
  // 而不用往仓库的 .backup/ 里堆测试残留。
  const fromEnv = process.env.WORKBUDDY_CONNECT_BACKUP;
  if (fromEnv) return fromEnv;
  const repoRoot = REPO_BACKUP_ROOT();
  try {
    if (!existsSync(repoRoot)) mkdirSync(repoRoot, { recursive: true });
    return repoRoot;
  } catch {
    return DEFAULT_BACKUP_ROOT();
  }
}

// ── 对外：写入 / 撤销 ───────────────────────────────────────────────────

/**
 * 跨进程互斥锁（审计 R6）。
 *
 * 接入是「读文件 → 算 → 备份 → 原子写 → 记」这一串。两个入口同时做同一个客户端
 * （控制台点「重新写入」+ 另一个窗口跑 `npm run connect apply`）会交叉：备份互相覆盖，
 * 记录里"保留首次 `restore`"的逻辑可能因此丢掉最早那份原值 —— 于是「撤销」还原到
 * 一个中间态，而那正是最不该出错的地方。
 *
 * 为什么用**锁文件**而不是进程内变量：真正会撞的是**两个进程**（控制台 / 命令行），
 * 进程内加锁一点用都没有。`openSync(..., 'wx')` 是原子创建，跨进程可靠。
 *
 * 陈旧锁直接夺过来：进程被强杀时锁文件会留下，而"永远锁不上"比"偶尔并发"更糟。
 * 判据是 mtime 超过 30 秒 —— 正常写入是毫秒级的。
 */
const LOCK_STALE_MS = 30_000;

function acquireLock(root, clientId) {
  const dir = join(root, clientId);
  mkdirSync(dir, { recursive: true });
  const lock = join(dir, '.lock');
  try {
    if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) rmSync(lock, { force: true });
  } catch { /* 没有锁文件 = 正常情况 */ }
  try {
    const fd = openSync(lock, 'wx');
    writeSync(fd, `${process.pid} ${new Date().toISOString()}\n`);
    closeSync(fd);
    return { ok: true, path: lock };
  } catch (e) {
    if (e.code === 'EEXIST') {
      return {
        ok: false,
        reason: '另一个接入操作正在进行（控制台或另一个命令行窗口），等它结束再试；'
          + '若确认没有别的操作在跑，删掉 .lock 文件即可',
      };
    }
    return { ok: false, reason: `创建锁文件失败：${e.message}` };
  }
}

/** 拿锁 → 跑 → 一定释放。失败时返回 `{ ok: false, error }`，与各接口的错误形状一致。 */
function withClientLock(root, clientId, fn) {
  const lock = acquireLock(root, clientId);
  if (!lock.ok) return { ok: false, error: lock.reason };
  try {
    return fn();
  } finally {
    try { rmSync(lock.path, { force: true }); } catch { /* 删不掉就靠陈旧超时兜底 */ }
  }
}

/**
 * 写入配置。步骤：读原文件 → 算计划 → 备份 → 原子写 → 收紧权限 → 读回校验。
 *
 * **带跨进程锁**（见 `withClientLock`）：真正的写逻辑在 `applyClientLocked` 里。
 *
 * @param {ConnectOpts} [opts]
 */
export function applyClient(id, ctx, opts = {}) {
  const client = findClient(id);
  if (!client) return { ok: false, error: `不认识的客户端：${id}` };
  return withClientLock(resolveBackupRoot(opts.backupRoot), client.id,
    () => applyClientLocked(id, ctx, opts));
}

/**
 * `restore` 只在**首次**写入时记录：第二次写入时若已有 manifest 且指向同一路径，
 * 保留它 —— 否则撤销会把文件还原成"第一次写入之后"的状态，而不是用户原来的样子。
 *
 * @param {ConnectOpts} [opts]
 */
function applyClientLocked(id, ctx, opts = {}) {
  const { backupRoot } = opts;
  const client = findClient(id);
  if (!client) return { ok: false, error: `不认识的客户端：${id}` };
  const root = resolveBackupRoot(backupRoot);
  const path = clientPath(client);

  const text = readText(path);
  const r = planWithCatalog(client, text, ctx);
  if (r.error) return { ok: false, error: r.error };
  const ctx2 = r.ctx;

  const existing = readManifest(client.id, root);
  const keepRestore = existing && existing.path === path;

  /*
   * 「无需改动」要**连目录一起看**：`model_catalog_json` 早就写对时，
   * config.toml 一个字都不用改，但那份目录可能正是旧版本写坏的（code mode 开关）。
   * 只看配置文件就提前返回，目录永远纠正不过来 —— 实测踩到过。
   */
  if (r.changes.length === 0 && !r.catalogNeedsWrite) {
    return {
      ok: true, changed: false, id: client.id, label: client.label, path,
      changes: [], message: '已经是接入状态，无需改动',
      models: (ctx2.models || []).map((m) => m.id),
      catalog: r.catalog ? { path: r.catalog.path, added: r.catalog.added, refreshed: r.catalog.refreshed, kept: r.catalog.kept } : null,
      catalogSkipped: r.catalogSkipped || null,
      skippedKeys: r.skipped || [],
    };
  }

  // 1) 备份（文件不存在就跳过 —— 没有东西可备份）
  const backup = text !== null ? backupFile(path, root, client.id) : null;

  // 2) 写（只改目录时，这一步写回的是**同一份内容**，幂等且无害）
  try {
    writeAtomic(path, r.text);
  } catch (e) {
    return { ok: false, error: `写入失败：${e.message}` };
  }

  /*
   * 2.5) Codex 的模型目录：配置文件里刚写进去的那个键指向它，所以要一起落盘。
   *
   * 它是**用户目录以外的第二个文件**，安全网必须同样覆盖：写之前整份备份，
   * 撤销时恢复（我们新建的就删掉）。否则「撤销」会把 config.toml 还原成一个
   * 指向不存在文件的键 —— 那比不撤销更糟。
   */
  let catalogWritten = null;
  if (r.catalog) {
    const catPath = r.catalog.path;
    const existed = existsSync(catPath);
    let catBackup = null;
    try {
      if (existed) {
        mkdirSync(join(root, client.id), { recursive: true });
        catBackup = join(root, client.id, `${stamp()}-${basename(catPath)}`);
        copyFileSync(catPath, catBackup);
      }
      writeAtomic(catPath, r.catalog.text);
    } catch (e) {
      return { ok: false, error: `模型目录写入失败：${e.message}（配置文件未改动，可直接重试）` };
    }
    catalogWritten = {
      path: catPath, existed, backup: catBackup,
      added: r.catalog.added, kept: r.catalog.kept, from: r.catalog.from,
    };
  }

  // 3) 收紧权限（文件里现在有令牌了）
  const hardened = hardenTokenFile(path);

  // 4) 撤销记录（保留首次的 restore）
  const manifest = {
    client: client.id,
    path,
    at: new Date().toISOString(),
    backup,
    restore: keepRestore ? existing.restore : r.restore,
    format: client.format,
    /**
     * 这次写进去的**模型**。记下来是为了下一轮能认出"这就是用户选的"
     * （`currentModelFor` 主要看文件本身，这条是给诊断与人工排查用的）。
     */
    model: ctx2.model || null,
    /** 这次声明的模型集合（多模型）。 */
    models: (ctx2.models || []).map((m) => m.id),
    /** 这次写的模型目录（Codex）——撤销要连它一起还原。 */
    catalog: keepRestore && existing.catalog ? existing.catalog : catalogWritten,
  };
  try {
    mkdirSync(join(root, client.id), { recursive: true });
    writeFileSync(manifestPath(client.id, root), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  } catch (e) {
    // 记录写不进去不影响本次接入生效，但必须说出来 —— 否则用户以为能撤销
    return {
      ok: true, changed: true, id: client.id, label: client.label, path,
      changes: r.changes, hardened, backup, catalog: catalogWritten,
      backupHardened: hardenBackupDir(root, client.id),
      warning: `已写入，但撤销记录写入失败（${e.message}）；撤销将不可用，请手动恢复备份：${backup}`,
    };
  }

  // 5) 读回自检：确认写进去的确实能被解析出来
  const check = verifyWritten(client, ctx2);
  return {
    ok: true, changed: true, id: client.id, label: client.label, path,
    changes: r.changes, hardened, backup, verify: check, reformats: r.reformats === true,
    models: (ctx2.models || []).map((m) => m.id),
    catalog: catalogWritten,
    catalogSkipped: r.catalogSkipped || null,
    skippedKeys: r.skipped || [],
    /** 备份目录的权限收紧结果（备份里也有令牌，见 hardenBackupDir）。 */
    backupHardened: hardenBackupDir(root, client.id),
  };
}

// ── 对外：模式切换（走桥 / 走客户端自己的模型）────────────────────────────

/**
 * 只改记录里的 `mode` 一个字段，**其余（尤其是 `restore`）原样保留**。
 *
 * 保留是关键：切回原始模型、再切回桥、再切回原始模型…… 撤销要用的原始值
 * 必须始终是最初那一份，否则"撤销"会还原成一个中间态。
 */
function markMode(id, root, mode) {
  const p = manifestPath(id, root);
  const m = readManifest(id, root);
  if (!m) return false;
  try {
    writeFileSync(p, JSON.stringify({ ...m, mode }, null, 2) + '\n', 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * 记录里"上次接的是哪批模型" —— 切回桥时拿它打底，用户不用重新勾一遍。
 * 返回 `{ model, models }`；没有记录时是 `{ model: null, models: [] }`。
 */
export function recordedConnect(id, opts = {}) {
  const m = readManifest(id, resolveBackupRoot(opts.backupRoot));
  if (!m) return { model: null, models: [] };
  return {
    model: typeof m.model === 'string' && m.model ? m.model : null,
    models: Array.isArray(m.models) ? m.models.filter((x) => typeof x === 'string' && x) : [],
  };
}

/**
 * 切模式。`target`：
 *   - `'native'` —— 还原成接入之前的样子（客户端用回自己的模型）。不需要网络、
 *     也不需要令牌：它只是把我们接管过的那几个键按记录还原。
 *   - `'bridge'` —— 切回走桥。**需要 `ctx`**（令牌 + 模型集合），因为令牌可能已经
 *     轮换过，拿旧值写回去会写进一把失效的令牌。
 *
 * ## 与「撤销」的区别（这就是这个功能存在的理由）
 *
 * 撤销是**拆掉**：记录被改名归档、我们建的目录文件被删掉，再想用桥就得从头接入一遍。
 * 切模式是**换挡**：记录留着、目录文件留着（只是不再被引用），随时一键切回去。
 * 用户的实际需求多半是后者 —— "这两天想用 Codex 自己的模型，回头还想接着用桥"。
 *
 * ## 切回原始模型之后会怎样（这就是它的"默认行为"）
 *
 * - 客户端打开时用的是**它自己原来那个模型**（`restore` 记着原值；原来没有这个键
 *   就仍然没有，由客户端自己决定默认）—— 不是我们猜的，是记录里那一份；
 * - `model_catalog_json` 一并还原 → 客户端的模型选择器回到它自己的模型清单；
 * - 我们那份目录文件**留在磁盘上但不被引用**（切回桥时可直接复用）。界面会如实
 *   说明；想连文件一起清掉就用「撤销」。
 *
 * @param {ConnectOpts} [opts]
 */
export function switchClientMode(id, target, ctx = null, opts = {}) {
  const client = findClient(id);
  if (!client) return { ok: false, error: `不认识的客户端：${id}` };
  return withClientLock(resolveBackupRoot(opts.backupRoot), client.id,
    () => switchClientModeLocked(client, target, ctx, opts));
}

function switchClientModeLocked(client, target, ctx = null, opts = {}) {
  const id = client.id;
  const root = resolveBackupRoot(opts.backupRoot);
  const path = clientPath(client);

  if (target === 'bridge') {
    if (!ctx) {
      return { ok: false, error: '切回桥模式需要令牌与模型集合（控制台会自动带上；命令行请用 connect apply）' };
    }
    // 直接调**已持锁**的那一层：再走一次 applyClient 会撞自己的锁
    const r = applyClientLocked(id, ctx, opts);
    if (r.ok) {
      markMode(client.id, root, 'bridge');
      r.mode = 'bridge';
    }
    return r;
  }
  if (target !== 'native') return { ok: false, error: `不认识的目标模式：${target}` };

  const text = readText(path);
  if (text === null) return { ok: false, error: '配置文件不存在，没有可还原的内容' };
  const rec = readManifest(client.id, root);
  if (!rec || rec.path !== path) {
    /*
     * 没有记录就**不猜**：我们不知道用户原来的 model_provider / model 是什么，
     * 硬猜（比如干脆删掉 provider 那一行）等于替用户改配置 —— 而这个功能的前提
     * 恰恰是"精确还原"。如实告诉他手动怎么改，别装作能做。
     */
    return {
      ok: false,
      error: '没有找到本控制台的接入记录，无法精确还原。可手动把 model_provider 改回原来的值，或先接入一次再切。',
    };
  }
  if (clientMode(client) === 'native') {
    markMode(client.id, root, 'native');
    return {
      ok: true, changed: false, mode: 'native', id: client.id, label: client.label, path,
      message: '已经是原始模型模式，无需改动',
    };
  }

  /*
   * `model_catalog_json` 的兜底还原。
   *
   * 实测踩到（就在本机的真实记录里）：老版本写下的 `restore.topLevel` 里**没有**这个键
   * —— 那时它只在"真的要写目录"时才进 topLevel，于是记录漏了它。照这份记录还原，
   * 这个键会**留在文件里继续指向我们的目录**：客户端用回了自己的 provider，模型选择器
   * 里却还列着桥的模型 —— 一个自相矛盾的状态，而且用户完全看不出哪里不对。
   *
   * 判据取"文件名只有我们用"（`workbuddy-model-catalog.json`）：当前值正好是它，
   * 就说明这个键是我们加的，还原时删掉；别的值一律不碰（那是别人的目录）。
   */
  const restore = { ...(rec.restore || {}) };
  if (client.format === 'toml') {
    const top = { ...(restore.topLevel || {}) };
    if (!('model_catalog_json' in top)) {
      const cur = tomlTopLevelValue(text.split('\n'), 'model_catalog_json');
      if (cur === catalogFileName(client)) top.model_catalog_json = null;
    }
    restore.topLevel = top;
  }

  const r = planUnmerge(client, text, restore);
  if (r.error) return { ok: false, error: r.error };

  const backup = backupFile(path, root, client.id);
  try {
    writeAtomic(path, r.text);
  } catch (e) {
    return { ok: false, error: `切回原始模型时写入失败：${e.message}` };
  }
  markMode(client.id, root, 'native');
  /** 读回自检：写完必须真的不再是桥模式，否则界面会显示一个假的"已切回"。 */
  const check = clientMode(client) === 'native'
    ? { ok: true }
    : { ok: false, reason: '还原后配置里仍能看到桥的设置，请打开文件核对' };
  return {
    ok: true, changed: true, mode: 'native', id: client.id, label: client.label, path,
    backup, verify: check,
    backupHardened: hardenBackupDir(root, client.id),
    catalog: rec.catalog && rec.catalog.path ? { path: rec.catalog.path, kept: true } : null,
  };
}

/**
 * 读回写入后的文件，确认自己的键都在。不依赖客户端本身，纯静态核对。
 *
 * 报错只说**哪些键**不对，绝不说出预期的值 —— 那是令牌，
 * 打进终端滚动缓冲区等于把它留在那里。
 */
export function verifyWritten(client, ctx) {
  const path = clientPath(client);
  const text = readText(path);
  if (text === null) return { ok: false, reason: '写入后读不到文件' };
  const fail = (names) => ({ ok: false, reason: `这些键缺失或与预期不符：${names.join(' / ')}` });
  const ids = (Array.isArray(ctx.models) ? ctx.models : []).map((m) => m.id);

  if (client.format === 'toml') {
    const lines = text.split('\n');
    const want = [
      ['model_provider', '"workbuddy"'],
      ['experimental_bearer_token', `"${ctx.token}"`],
      // 模型是用户的选择，写没写对必须核对（原先漏了这一条）
      ['model', tomlStr(ctx.model)],
    ];
    if (ctx.catalogFile) want.push(['model_catalog_json', tomlStr(ctx.catalogFile)]);
    const bad = want.filter(([k, v]) => !lines.some((l) => l.trim() === `${k} = ${v}`)).map(([k]) => k);
    /*
     * 目录文件本身也要核：键写对了但文件没落盘（或少了模型），用户在选择器里
     * 就是看不到那些模型 —— 只看 config.toml 会得出"一切正常"的错误结论。
     */
    if (ctx.catalogFile) {
      const cat = readJsonFile(join(dirname(path), ctx.catalogFile));
      if (!cat || !Array.isArray(cat.models)) bad.push('模型目录文件');
      else {
        const slugs = new Set(cat.models.map((m) => m?.slug).filter(Boolean));
        const missing = ids.filter((i) => !slugs.has(i));
        if (missing.length) bad.push(`模型目录里的 ${missing.join(' / ')}`);
      }
    }
    return bad.length ? fail(bad) : { ok: true };
  }

  const parsed = jsonParseSmart(text, path);
  if (!parsed.ok) return { ok: false, reason: parsed.error };
  const root = parsed.value || {};
  const need = client.id === 'claude'
    ? [['env.ANTHROPIC_BASE_URL', ctx.baseUrlAnthropic], ['env.ANTHROPIC_API_KEY', ctx.token], ['env.ANTHROPIC_MODEL', ctx.model]]
    : [
      ['provider.workbuddy.options.baseURL', ctx.baseUrlOpenAI],
      ['provider.workbuddy.options.apiKey', ctx.token],
      ['model', `workbuddy/${ctx.model}`],
    ];
  const bad = need.filter(([p, v]) => getPath(root, p) !== v).map(([p]) => p);

  // 多模型：声明的模型一个都不能少（少一个 = TUI/选择器里选不到它）
  if (client.id === 'claude') {
    if (ids.length >= 2) {
      const listed = new Set((getPath(root, 'modelPicker.options') || []).map((o) => o?.model).filter(Boolean));
      const missing = ids.filter((i) => !listed.has(i));
      if (missing.length) bad.push(`modelPicker 里的 ${missing.join(' / ')}`);
    }
  } else {
    const declared = new Set(Object.keys(getPath(root, 'provider.workbuddy.models') || {}));
    const missing = ids.filter((i) => !declared.has(i));
    if (missing.length) bad.push(`provider.workbuddy.models 里的 ${missing.join(' / ')}`);
  }
  return bad.length ? fail(bad) : { ok: true };
}

/**
 * 撤销：按 manifest 里的原始值逐键还原。
 *
 * @param {ConnectOpts} [opts]
 */
export function undoClient(id, opts = {}) {
  const client = findClient(id);
  if (!client) return { ok: false, error: `不认识的客户端：${id}` };
  return withClientLock(resolveBackupRoot(opts.backupRoot), client.id,
    () => undoClientLocked(client, opts));
}

function undoClientLocked(client, opts = {}) {
  const { backupRoot } = opts;
  const root = resolveBackupRoot(backupRoot);
  const path = clientPath(client);
  const manifest = readManifest(client.id, root);
  if (!manifest) return { ok: false, error: '没有找到本次写入的记录，无法撤销（可手动恢复备份）' };
  if (manifest.path !== path) return { ok: false, error: '记录指向的路径与当前配置路径不一致，已跳过' };

  const text = readText(path);
  if (text === null) return { ok: false, error: '配置文件不存在，无法撤销' };

  const r = planUnmerge(client, text, manifest.restore || {});
  if (r.error) return { ok: false, error: r.error };
  try {
    writeAtomic(path, r.text);
  } catch (e) {
    return { ok: false, error: `撤销写入失败：${e.message}` };
  }

  /*
   * 文件原本**不存在**（没有备份）：撤销就该回到"没有这个文件"，
   * 而不是留一个 `{}` —— 有些客户端会把空配置对象当成"用户显式配了个空的"，
   * 行为与"文件不存在"不同。
   *
   * 只在还原后确实什么都不剩时才删：用户若在我们创建之后又自己往里加过东西，
   * 那些内容必须留着。
   */
  let removed = false;
  if (!manifest.backup) {
    const left = (readText(path) ?? '').trim();
    if (left === '' || left === '{}') {
      try { rmSync(path, { force: true }); removed = true; } catch { /* 删不掉就留着空文件，不影响正确性 */ }
    }
  }

  /*
   * 模型目录（Codex 的第二个文件）：配置里的键已经还原了，这份文件也得跟着回退
   * —— 否则会留下一个没人引用的文件（我们建的），或者一份被我们改过的内容（原有的）。
   * 同样只碰**这次写入动过的那一份**（manifest 里记着路径与是否原本存在）。
   */
  let catalogRemoved = false;
  let catalogRestored = false;
  /** 目录文件没处理成功时的原因 —— **必须报出去**，见下面注释。 */
  let catalogError = null;
  const cat = manifest.catalog;
  if (cat && cat.path) {
    try {
      if (cat.existed && cat.backup && existsSync(cat.backup)) {
        copyFileSync(cat.backup, cat.path);
        catalogRestored = true;
      } else if (!cat.existed) {
        rmSync(cat.path, { force: true });
        catalogRemoved = true;
      }
    } catch (e) {
      /*
       * 这里原先是一个空 `catch`（注释写着"下一行的返回值里会带上"，其实没带）。
       * 实测踩到：Windows 上 `rmSync` 会因为文件被杀毒实时扫描短暂占用而抛
       * EBUSY/EPERM，于是**目录文件留在了磁盘上**，而撤销照样报 `ok` ——
       * 排查时只能靠手工 `ls`，因为没有任何地方说过它失败了。
       * 如实回报，让 CLI/界面能说一句"这个文件没能删掉，请手动处理"。
       */
      catalogError = e?.message || String(e);
    }
  }

  try {
    renameSync(manifestPath(client.id, root), join(root, client.id, `applied.undone-${stamp()}.json`));
  } catch { /* 重命名失败不影响已还原的文件 */ }
  return {
    ok: true, id: client.id, label: client.label, path, backup: manifest.backup, removed,
    catalog: cat
      ? { path: cat.path, removed: catalogRemoved, restored: catalogRestored, error: catalogError }
      : null,
  };
}

/** 文件大小（给界面显示"原来多大"），失败返回 null。 */
export function fileSize(path) {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}

/** 从**配置文件里**把令牌读回来（不是用内存里的值）。 */
function readTokenFromConfig(client) {
  const text = readText(clientPath(client));
  if (text === null) return null;
  if (client.format === 'toml') {
    const line = text.split('\n').find((l) => /^\s*experimental_bearer_token\s*=/.test(l));
    if (!line) return null;
    return line.split('=').slice(1).join('=').trim().replace(/^["']|["']$/g, '');
  }
  const parsed = jsonParseSmart(text, clientPath(client));
  if (!parsed.ok) return null;
  return client.id === 'claude'
    ? getPath(parsed.value, 'env.ANTHROPIC_API_KEY') || null
    : getPath(parsed.value, 'provider.workbuddy.options.apiKey') || null;
}

/**
 * 每个客户端的接入现状 —— **不需要桥、不需要网络**（只读文件与记录）。
 *
 * 给诊断面板 / `tools/doctor.mjs` 用。存在它的理由是审计 R7：
 * 客户端**会自己重写配置文件**（实测 Codex 每次运行都会改里面别的键），
 * 万一某个版本开始丢掉"不认识的键"，接入就会**静默失效** ——
 * 而面板还显示「已接入」。这一项让那种失效在下一次自检时暴露出来，
 * 而不是等用户发现请求走错了地方。
 *
 * @param {ConnectOpts} [opts]
 */
export function connectSnapshot(opts = {}) {
  const root = resolveBackupRoot(opts.backupRoot);
  return CONNECT_CLIENTS.map((c) => {
    const path = clientPath(c);
    const rec = readManifest(c.id, root);
    const hasRecord = Boolean(rec && rec.path === path);
    const mode = clientMode(c);
    const recordedMode = hasRecord ? (rec.mode || 'bridge') : null;
    return {
      id: c.id,
      label: c.label,
      path,
      exists: existsSync(path),
      mode,
      hasRecord,
      recordedMode,
      applied: hasRecord && mode === 'bridge',
      /**
       * 记录说是桥模式、文件里却不是 → 配置被动过（客户端重写时丢掉，或手工改过）。
       * 与「主动切回原始模型」区分开：后者记录里的 mode 已经是 `native`。
       */
      drifted: hasRecord && recordedMode === 'bridge' && mode !== 'bridge',
      /** 主动切回了客户端自己的模型（不是故障）。 */
      nativeByChoice: hasRecord && recordedMode === 'native' && mode !== 'bridge',
      at: rec?.at || null,
    };
  });
}

/**
 * 这份配置现在走哪条路：`bridge`（走本地桥）还是 `native`（走客户端自己的模型）。
 *
 * **判据只看文件**，不看我们记的账 —— 用户可能手工改回去、也可能在别的机器上接入过，
 * 而界面显示的必须是文件里的事实。
 *
 * 每个客户端的判据都取"**只有我们会写成这样**"的形状，避免把用户自己的配置
 * 误判成桥模式：
 *   - codex    `model_provider = "workbuddy"`（这个值只有我们写）
 *   - opencode `provider.workbuddy` 这个键存在（同上）
 *   - claude   `env.ANTHROPIC_BASE_URL` 指向**回环地址**（桥永远在回环上；
 *              用户自己的公司网关是非回环的，那本来就该算"原生"）
 */
export function clientMode(client) {
  const text = readText(clientPath(client));
  if (text === null) return 'native';
  if (client.format === 'toml') {
    const line = text.split('\n').find((l) => /^\s*model_provider\s*=/.test(l));
    const value = line ? line.split('=').slice(1).join('=').trim().replace(/^['"]|['"]$/g, '') : '';
    return value === 'workbuddy' ? 'bridge' : 'native';
  }
  const parsed = jsonParseSmart(text, clientPath(client));
  if (!parsed.ok) return 'native';
  const root = parsed.value || {};
  if (client.id === 'claude') {
    const url = getPath(root, 'env.ANTHROPIC_BASE_URL');
    if (typeof url !== 'string' || !url) return 'native';
    try {
      const host = String(new URL(url).hostname).replace(/^\[|\]$/g, '');
      return host === '127.0.0.1' || host === 'localhost' || host === '::1' ? 'bridge' : 'native';
    } catch {
      return 'native';
    }
  }
  return getPath(root, 'provider.workbuddy') ? 'bridge' : 'native';
}

/**
 * 从**配置文件里**读回当前写着的接入模型（不是内存里的默认值）。
 *
 * 为什么必须读它：模型是**用户的选择**。用户上次把 Codex 选成 `deepseek-v4-flash`
 * 写进去了，重新打开面板时若不认这个值，面板会按桥的默认（glm-5.3）重算 ——
 * 明明刚写好的配置被报成「已接入，需重新写入」，用户照着点一次「重新写入」，
 * 反而把他自己的选择改掉了。界面在制造一件不存在的事，还顺手覆盖用户的偏好。
 * （本机实测就是这个状态：`model = "deepseek-v4-flash"` + 面板写着"需重新写入"。）
 *
 * 读不到 / 认不出（比如 Codex 原生模型名 `gpt-5.1-codex` 不在我们目录里、
 * 或 opencode 的 `model` 指向别的 provider）一律返回 `null`，由调用方回落默认。
 */
export function currentModelFor(client) {
  const text = readText(clientPath(client));
  if (text === null) return null;
  if (client.format === 'toml') {
    // 只认顶层裸键 `model = …`；`model_provider = …` 不会命中（`model` 后面是 `_`）
    const line = text.split('\n').find((l) => /^\s*model\s*=/.test(l));
    if (!line) return null;
    const value = line.split('=').slice(1).join('=').trim().replace(/^["']|["']$/g, '');
    return value || null;
  }
  const parsed = jsonParseSmart(text, clientPath(client));
  if (!parsed.ok) return null;
  const raw = client.id === 'claude'
    ? getPath(parsed.value, 'env.ANTHROPIC_MODEL')
    : getPath(parsed.value, 'model');
  if (typeof raw !== 'string' || !raw) return null;
  if (client.id === 'opencode') {
    // opencode 的 model 形如 `workbuddy/<id>`：只有这一段是我们写的，别家 provider 不动
    const prefix = 'workbuddy/';
    return raw.startsWith(prefix) ? raw.slice(prefix.length) : null;
  }
  return raw;
}

/**
 * 「这次该用哪个模型」的**唯一入口**（控制台三个接口与命令行共用）。
 *
 * 优先级：显式选择 > 配置文件里的现状（且确实在当前目录里）> 桥的默认（返回 `null`）。
 * 收口在这里是为了"所见即所写"：预览、写入、验证三处必须用同一个模型，
 * 各算各的必然漂移。
 */
export function resolveModelChoice(base, client, explicit) {
  if (explicit) return explicit;
  const fromFile = currentModelFor(client);
  if (fromFile && assertModelKnown(fromFile, base) === null) return fromFile;
  return null;
}

/**
 * 「这次该用哪些模型」的**唯一入口**（与 `resolveModelChoice` 同一套优先级）。
 *
 * 显式勾选 > 配置文件里现在声明的那批（且确实在当前目录里）> 空（交给精选集）。
 *
 * 为什么要读文件：模型集合同样是**用户的选择**。重新打开面板时若不认它，
 * 界面会按精选集重算 —— 用户勾过的 5 个变回 3 个，一点「重新写入」就被改掉。
 */
export function currentModelsFor(client, base) {
  const path = clientPath(client);
  const text = readText(path);
  if (text === null) return [];
  const known = (id) => !base || !base.catalogIds || base.catalogIds.size === 0 || base.catalogIds.has(id);
  let ids = [];

  if (client.format === 'toml') {
    const ref = tomlTopLevelValue(text.split('\n'), 'model_catalog_json');
    if (!ref) return [];
    const cat = readJsonFile(isAbsolute(ref) ? ref : join(dirname(path), ref));
    // 目录里可能有**别人的**模型（本机是 cc-switch 那条隧道）：只认桥也认识的那些
    ids = Array.isArray(cat?.models) ? cat.models.map((m) => m?.slug).filter(Boolean) : [];
  } else {
    const parsed = jsonParseSmart(text, path);
    if (!parsed.ok) return [];
    const root = parsed.value || {};
    if (client.id === 'claude') {
      ids = (getPath(root, 'modelPicker.options') || []).map((o) => o?.model).filter(Boolean);
      if (!ids.length && getPath(root, 'env.ANTHROPIC_MODEL')) ids = [getPath(root, 'env.ANTHROPIC_MODEL')];
    } else {
      ids = Object.keys(getPath(root, 'provider.workbuddy.models') || {});
      if (!ids.length && getPath(root, 'model')) ids = [String(getPath(root, 'model')).replace(/^workbuddy\//, '')];
    }
  }
  return [...new Set(ids)].filter(known);
}

/**
 * 解析「这次接入哪些模型」：显式勾选优先，其次文件里现有那批。
 * 返回 id 数组；空数组 = 让 `contextForClient` 用精选集。
 */
export function resolveSelection(base, client, explicit) {
  const list = Array.isArray(explicit) ? explicit.filter((x) => typeof x === 'string' && x.trim()) : [];
  if (list.length) return list.map((x) => x.trim());
  return currentModelsFor(client, base);
}

/**
 * 端到端验证：拿**配置文件里那个令牌**真的打一次桥。
 *
 * 为什么必须做这一步（而不是只静态读回）：静态读回只能证明"文件里写对了"，
 * 证明不了"这个令牌真的能用"。最容易踩的一种是 —— 桥重启后重新生成了令牌
 * （比如配置文件在只读介质上没落盘），而客户端的配置文件里还是旧的，
 * 静态读回一切正常，用户一用却是 401。
 *
 * `baseUrl` 用 OpenAI 那条（`…/v1`）：三条协议里 `/v1/models` 都在这条路径下，
 * Anthropic 的 base 只是不带 `/v1` 而已，模型列表端点两者是同一条。
 *
 * @param {{ baseUrl?: string, tokenOverride?: string|null, timeoutMs?: number }} [opts]
 */
export async function verifyAgainstBridge(client, opts = {}) {
  const { baseUrl, tokenOverride = null, timeoutMs = 5000 } = opts;
  const token = tokenOverride || readTokenFromConfig(client);
  if (!token) return { ok: false, reason: '配置文件里读不到令牌' };
  if (!baseUrl) return { ok: false, reason: '没有给出桥的地址' };
  if (typeof fetch !== 'function') return { ok: false, reason: '当前 Node 没有 fetch（需要 Node 18+）' };

  const url = `${String(baseUrl).replace(/\/+$/, '')}/models`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: ac.signal });
    if (res.status === 401) {
      return { ok: false, reason: '桥拒绝了配置里的令牌（401）—— 桥可能重启后换了令牌，重新点一次「写入」即可' };
    }
    if (!res.ok) return { ok: false, reason: `桥返回 HTTP ${res.status}` };
    const body = await res.json().catch(() => null);
    const n = Array.isArray(body?.data) ? body.data.length : null;
    return { ok: true, models: n };
  } catch (e) {
    const why = e?.name === 'AbortError' ? `超过 ${timeoutMs}ms 没响应` : e.message;
    return { ok: false, reason: `连不上桥（${why}）—— 先在控制台把桥启动起来` };
  } finally {
    clearTimeout(timer);
  }
}
