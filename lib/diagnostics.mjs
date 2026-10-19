/**
 * 环境诊断：把「为什么用不了」拆成一组可判定的事实。
 *
 * 控制台页面与命令行 `tools/doctor.mjs` 共用本模块，保证两处结论一致。
 * 所有函数都只读凭据用于判定，绝不返回令牌明文。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  defaultExecutableCandidates,
  deriveAtRestKeyId,
  envelopeKeyId,
  fetchKeyFor,
  isEncryptedFieldWrapper,
  openEncryptedField,
} from './atrest.mjs';
import { inspectClientInstalls } from './find-workbuddy.mjs';
import config from '../config.mjs';
import { effectiveAuthFile, readAccountAliases, readAccountOrder, readHiddenAccounts } from './state.mjs';
import { readDshStatus } from './dsh.mjs';
/*
 * 与 `client-connect.mjs` 是**循环引用**（那边也 import 本模块的 bridgeHealth /
 * bridgeModels）。安全的前提是：两边都只在**函数体里**用它，且这里导入的是
 * **函数声明**（会被提升）—— 不要在模块顶层读它的值。
 */
import { connectSnapshot } from './client-connect.mjs';

// ── 通用工具 ────────────────────────────────────────────────────────────

export function decodeJwtClaims(token) {
  try {
    return JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'));
  } catch {
    return {};
  }
}

export function humanDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '已过期';
  const d = Math.floor(ms / 86400000);
  const h = Math.floor((ms % 86400000) / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  if (d > 0) return `${d} 天 ${h} 小时`;
  if (h > 0) return `${h} 小时 ${m} 分`;
  return `${m} 分`;
}

// ── 桥探测 ──────────────────────────────────────────────────────────────

async function bridgeFetch(path, timeoutMs = 5000) {
  return fetch(config.bridge.url + path, {
    headers: { Authorization: `Bearer ${config.bridge.token}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
}

/**
 * 桥是否在跑，以及它的自述状态。
 *
 * **`running` 与 `ok` 是两个问题，不能互相顶替**：
 *   - `running`：端口有人应答吗（进程级事实）；
 *   - `ok`：这个桥**认我们这把令牌**并且自述健康吗（可用性）。
 *
 * 实测踩到：桥独立启动时（没配 `WORKBUDDY_LOCAL_TOKEN`）会自己生成一把随机令牌，
 * 与控制台读的 `.bridge-token` 不是同一把 —— 于是桥对控制台**每次请求都回 401**。
 * 只看 `ok` 的调用方（「一键接入」原先就是）会把这种状态说成「桥未运行」，
 * 而用户按提示点「启动桥服务」只会得到"已经在跑了"：一句假话，且无从下手。
 * 所以 401 必须单独标出来（`authRejected`），让界面能说「两边令牌不一致，
 * 点「重启桥」让桥按控制台这份令牌重启」。
 */
export async function bridgeHealth(timeoutMs = 4000) {
  try {
    const res = await bridgeFetch('/health', timeoutMs);
    const body = await res.json();
    return {
      running: true,
      ok: res.ok && body.ok === true,
      authRejected: res.status === 401,
      status: res.status,
      body,
    };
  } catch (err) {
    return { running: false, ok: false, authRejected: false, status: 0, error: String(err.message || err) };
  }
}

/** 桥返回的全部可用模型。冷缓存时桥要抓一次上游目录，超时给足。 */
/**
 * 模型目录。`refresh=true` 时要求桥强制重取上游。
 *
 * 返回 `{ models, staleMs, error }`：
 *   - `staleMs` 只在「刷新失败、桥退回了过期缓存」时有值（成功时为 null）；
 *   - `error` 在桥不可达 / 请求超时时有值，供页面如实提示「刷新失败」。
 */
export async function bridgeModels(timeoutMs = 25000, refresh = false) {
  try {
    const res = await bridgeFetch(`/v1/models?all=1${refresh ? '&refresh=1' : ''}`, timeoutMs);
    const body = await res.json();
    return {
      models: body?.data || [],
      staleMs: typeof body?.staleMs === 'number' ? body.staleMs : null,
      error: null,
    };
  } catch (err) {
    return { models: [], staleMs: null, error: String(err?.message || err) };
  }
}

/**
 * 模型可用性探测 —— 发一个最小请求，判断该模型是否真的能调通。
 *
 * 用于回答"哪些模型能用"。请求极小（`max_tokens: 1`），但**仍会消耗
 * 少量额度**，因此不做自动轮询，只在用户主动点击时执行。
 *
 * 超时 20 秒：全量体检要打几十个模型，单项 90 秒会把整体拖成几十分钟；
 * 20 秒内没有任何响应的模型，对用户而言等同不可用。
 */
export async function probeModel(model, timeoutMs = 20000) {
  const started = Date.now();
  try {
    const res = await fetch(config.bridge.chatUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.bridge.token}`,
      },
      body: JSON.stringify({
        model,
        // 首条必须是 system：国际版网关会以 400 code 11128 拒绝纯 user 开头的请求
        messages: [
          { role: 'system', content: 'You are a helpful assistant.' },
          { role: 'user', content: 'hi' },
        ],
        max_tokens: 1,
        stream: false,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const ms = Date.now() - started;
    if (!res.ok) {
      const text = (await res.text().catch(() => '')).slice(0, 240);
      return { model, ok: false, ms, error: `HTTP ${res.status}${text ? ` · ${text}` : ''}` };
    }
    const body = await res.json().catch(() => null);
    const content = body?.choices?.[0]?.message?.content;
    // 上游在 usage 里回报本次实际扣减的积分，可用于实测倍率
    const credit = body?.usage?.credit;
    const tokens = body?.usage?.total_tokens;
    return {
      model,
      ok: true,
      ms,
      sample: String(content ?? '').slice(0, 30),
      ...(typeof credit === 'number' ? { credit } : {}),
      ...(typeof tokens === 'number' ? { tokens } : {}),
    };
  } catch (err) {
    return { model, ok: false, ms: Date.now() - started, error: String(err.message || err).slice(0, 240) };
  }
}

/**
 * 列出登录目录下的**全部登录文件**及其可用性（**不折叠**：同一账号可能有多份）。
 *
 * 与 {@link credentialStatus} 的区别：后者只看当前生效的那一个，这里会逐个
 * 尝试解开，因此能直接看出"另一个账号能不能用、还剩多少天"。
 *
 * 为什么单独导出：账号列表要折叠成"一个账号一行"（见 {@link listAccounts}），
 * 但**隐藏/恢复**是按登录文件名写 `.state.json` 的，必须拿到同一账号名下的全部
 * 文件一起写（否则恢复后另一份快照仍标着隐藏、整行还是隐藏状态）。
 */
export async function listAccountFiles() {
  const active = effectiveAuthFile();
  const dir = join(active, '..');
  const out = { dir, active, accounts: [], keyError: null };

  let names = [];
  try {
    names = readdirSync(dir).filter((f) => f.endsWith('.info'));
  } catch (err) {
    out.error = `无法读取登录目录：${err.message}`;
    return out;
  }

  let key = null;
  try {
    const candidates = defaultExecutableCandidates().filter((p) => p && existsSync(p));
    if (candidates.length === 0) {
      throw new Error('未找到 WorkBuddy 可执行文件（已探测默认位置并扫描常见安装目录）');
    }
    // 以当前生效文件信封的 keyId 为基准挑 build；文件读不动时退回"第一个成功的"
    let targetKeyId = '';
    try {
      const activeField = JSON.parse(readFileSync(active, 'utf8')).auth?.accessToken;
      if (isEncryptedFieldWrapper(activeField)) targetKeyId = envelopeKeyId(activeField) || '';
    } catch {
      /* 读不动就不设基准 */
    }
    key = (await fetchKeyFor(candidates, targetKeyId)).key;
  } catch (err) {
    out.keyError = String(err.message || err);
  }

  for (const name of names) {
    const full = join(dir, name);
    const entry = { name, path: full, active: full === active, usable: false };
    try {
      const raw = JSON.parse(readFileSync(full, 'utf8'));
      const auth = raw.auth || {};
      entry.account = raw.account?.uin ? String(raw.account.uin) : '';
      entry.domain = auth.domain || '';
      entry.encrypted = isEncryptedFieldWrapper(auth.accessToken);
      entry.expiresAt = Number(auth.expiresAt || 0);
      entry.remainingMs = entry.expiresAt - Date.now();
      entry.modifiedAt = statSync(full).mtimeMs;

      if (key) {
        const field = auth.accessToken;
        const token = entry.encrypted ? openEncryptedField(field, key) : String(field || '');
        const claims = decodeJwtClaims(token);
        entry.usable = true;
        if (!entry.account) entry.account = claims.sub || '';
        entry.userId = claims.sub || '';
      } else {
        entry.error = out.keyError || '未能取得 AtRest 密钥';
      }
    } catch (err) {
      entry.error = /belongs to key|not the available key/.test(String(err.message))
        ? '由另一个客户端 build 写入，本机密钥解不开'
        : String(err.message || err);
    }
    out.accounts.push(entry);
  }

  /*
   * 自定义名字（`.state.json` 的 `accountAliases`）。
   *
   * 键取 uin（读不出退回 `claims.sub`，再退回文件名）—— **不能用文件名当主键**：
   * 客户端换账号时会把同名登录文件原地覆盖，按文件名记的名字会贴到另一个账号上。
   * 同一个账号的多份快照因此共用一个名字（那正是用户想要的）。
   */
  const aliases = readAccountAliases();
  const hidden = new Set(readHiddenAccounts());
  for (const entry of out.accounts) {
    entry.aliasKey = entry.account || entry.userId || entry.name;
    entry.alias = aliases[entry.aliasKey] || '';
    entry.hidden = hidden.has(entry.name);
  }
  return out;
}

/**
 * 账号列表（**一个账号一行**）。
 *
 * 同一个账号的多份登录文件（客户端每次「登出」留一份快照）在这里合并成一行 ——
 * 用户明确要求"只展示一个账号"：既然能识别出它们属于同一个号，就不要再让人自己
 * 面对重复项，也不要折叠/展开那套额外交互。
 *
 * 合并只发生在**列表展示**上：登录目录里的文件一个都不动，切换仍按文件走，
 * 代表行选中的就是"这个号最该被使用的那份文件"（见 {@link foldAccountSnapshots}）。
 */
export async function listAccounts() {
  const out = await listAccountFiles();
  const rank = new Map(readAccountOrder().map((name, i) => [name, i]));
  out.accounts = foldAccountSnapshots(out.accounts, rank);
  return out;
}

/**
 * 把同一账号的多份登录文件折叠成一行 —— `listAccounts()` 的最后一步。
 *
 * 纯函数（不读文件、不写状态），单测直接喂造好的条目。
 *
 * **代表行怎么挑**：生效中 > 可用 > 最近 > 文件名。同一个账号的几份文件凭据是
 * 同一个号，切换时哪份都行；但坏掉的那份（换客户端 build 后写的老快照，本机密钥
 * 解不开）摆在第一行会让人以为这个号废了 —— 所以"能用"要排在"更新"前面。
 *
 * **排序**：自定义顺序（`.state.json` 的 `accountOrder`）优先；组的 rank 取该账号
 * **任意一份**文件的 rank —— 早先每份快照都是独立一行、用户能逐行排序，存下来的
 * 可能是快照文件名，按代表行名查会查不到、整组掉到末尾。
 *
 * @param {any[]} accounts 每项至少含 name / active / usable / modifiedAt / hidden
 * @param {Map<string, number>} [rank] 登录文件名 → 自定义顺序（没排过的缺省）
 * @returns {any[]} 每个账号一行（代表行），`sameAccount` = 该账号的文件数
 */
export function foldAccountSnapshots(accounts, rank = new Map()) {
  const groups = new Map();
  for (const entry of accounts) {
    const key = entry.aliasKey || entry.account || entry.userId || entry.name;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  const ordered = [];
  for (const list of groups.values()) {
    list.sort((x, y) => Number(y.active) - Number(x.active)
      || Number(y.usable) - Number(x.usable)
      || (Number(y.modifiedAt) || 0) - (Number(x.modifiedAt) || 0)
      || String(x.name).localeCompare(String(y.name)));
    const rep = list[0];
    // 折叠后一行 = 一个账号：这个号只要有**任何一份**文件被隐藏，整行就算隐藏
    // （服务端的隐藏/恢复接口按账号整组写，见 dashboard/server.mjs 的 /api/account/hidden）
    rep.hidden = list.some((e) => e.hidden);
    rep.sameAccount = list.length;
    let groupRank = Number.MAX_SAFE_INTEGER;
    for (const e of list) if (rank.has(e.name)) groupRank = Math.min(groupRank, rank.get(e.name));
    ordered.push({ rep, groupRank });
  }
  ordered.sort((a, b) => a.groupRank - b.groupRank
    || Number(b.rep.active) - Number(a.rep.active)
    || Number(b.rep.usable) - Number(a.rep.usable)
    || (Number(b.rep.modifiedAt) || 0) - (Number(a.rep.modifiedAt) || 0)
    || String(a.rep.name).localeCompare(String(b.rep.name)));
  return ordered.map((g) => g.rep);
}

const QUOTA_TTL_MS = config.bridge.quotaTtlMs;
const QUOTA_FAIL_TTL_MS = 15 * 1000;
/**
 * 冷启动时最多**同步**等上游多久。
 *
 * 为什么必须有这个上限：`/api/overview` 每 20 秒轮询一次，而积分要打上游计费
 * 网关。上游正常时 0.3 秒就回，但抖动时**实测见过 14 秒** —— 同步等它会把整份
 * overview 拖住，包括 2ms 就能拿到的桥状态与凭据，页面看起来像卡死。
 * 超过这个时间就先回 null（页面显示「—」），请求继续在后台跑，下次轮询就能拿到。
 */
const QUOTA_BLOCK_MS = 3000;
let quotaCache = { at: 0, ttl: 0, value: null };
/** 同一时刻只允许一个上游请求在跑：多次轮询不会叠加成 N 个并发计费查询。 */
let quotaInflight = null;
/**
 * 「当前是哪一代」的计数。**只在 `invalidateQuotaCache()` 里自增。**
 *
 * 为什么需要它：`invalidateQuotaCache()` 原先只清缓存、**没管在途请求**，
 * 而在途请求完成时会**无条件**把结果写回缓存。于是这个时序会出错：
 * 轮询发起查询（在途）→ 用户切账号（作废缓存）→ 在途请求完成、把**上一个账号**
 * 的余额写回 → 控制台最多 60 秒显示的是旧账号的余额。签到成功后同理。
 *
 * 有了代次：在途请求只在「自己那一代仍是当前代」时才写回，作废之后就丢掉。
 */
let quotaGeneration = 0;

/**
 * 清空积分缓存 —— 签到成功或切换账号后余额会变，必须重新取。
 *
 * **同时作废在途请求**：只清缓存不够（见 `quotaGeneration` 的注释）。
 * 这里把句柄也置空，让下一次调用立刻发起新查询，而不是复用那个已经属于
 * 「上一代」的 promise。
 */
export function invalidateQuotaCache() {
  quotaCache = { at: 0, ttl: 0, value: null };
  quotaGeneration += 1;
  quotaInflight = null;
}

/** 真正去上游取一次（带 in-flight 去重）。永不 reject，失败按 null 缓存。 */
function fetchQuota(timeoutMs) {
  if (quotaInflight) return quotaInflight;
  const gen = quotaGeneration;
  quotaInflight = (async () => {
    let value = null;
    try {
      const res = await bridgeFetch('/v1/quota', timeoutMs);
      if (res.ok) {
        const body = await res.json();
        if (body && body.ok) value = body;
      }
    } catch {
      /* 上游不可用：按失败缓存，页面显示「—」而不是卡住 */
    }
    // 只有自己这一代仍是当前代才写回：作废过的结果不许覆盖新缓存
    if (gen === quotaGeneration) {
      quotaCache = { at: Date.now(), ttl: value ? QUOTA_TTL_MS : QUOTA_FAIL_TTL_MS, value };
    }
    return value;
  })();
  // finally 里清空句柄，但**返回的是同一个 promise**，所以等待方仍能拿到结果
  quotaInflight = quotaInflight.finally(() => { quotaInflight = null; });
  return quotaInflight;
}

/**
 * 桥返回的积分余额（只读查询，不消耗积分）。失败时返回 null，不阻断总览。
 *
 * **stale-while-revalidate**。控制台每 20 秒轮询总览，积分却要打上游计费网关；
 * 同步等它会让整份 overview（含 2ms 就能拿到的本地数据）陪跑，上游一抖动页面
 * 就像卡死。所以分三种情况：
 *
 *   1. 缓存新鲜      → 直接返回，不打上游
 *   2. 有缓存但过期  → **立刻返回旧值**，后台刷新（下一次轮询拿到新值）
 *   3. 完全没有缓存  → 等一次，但最多 `QUOTA_BLOCK_MS`；超时先回 null，
 *                      请求继续在后台跑，不浪费这一次查询
 *
 * 失败只缓存 15 秒（成功 60 秒）：上游故障时既不会每次轮询都卡满超时，
 * 恢复后也能很快反映出来。
 */
export async function bridgeQuota({ force = false } = {}) {
  const age = Date.now() - quotaCache.at;
  if (!force && age < quotaCache.ttl) return quotaCache.value;

  // 有旧值就先给旧的 —— 这是「不让慢的上游拖住页面」的关键一步
  if (!force && quotaCache.at > 0) {
    fetchQuota(20000).catch(() => {});
    return quotaCache.value;
  }

  // 冷启动 / 强制刷新：等一次，但设上限
  const limit = force ? 20000 : QUOTA_BLOCK_MS;
  const timedOut = Symbol('timeout');
  const result = await Promise.race([
    fetchQuota(20000),
    new Promise((resolve) => { setTimeout(() => resolve(timedOut), limit); }),
  ]);
  return result === timedOut ? null : result;
}

/** 桥的本地用量账本（只含元数据：模型、耗时、token 数）。 */
export async function bridgeUsage(days = 7, hours = false) {
  try {
    const res = await bridgeFetch(`/v1/usage?days=${days}${hours ? '&hours=1' : ''}`, 8000);
    if (!res.ok) return null;
    const body = await res.json();
    return body && body.ok ? body : null;
  } catch {
    return null;
  }
}

/** 最近请求明细（含失败），只含元数据，不含对话内容。 */
export async function bridgeRequests(limit = 50) {
  try {
    const res = await bridgeFetch(`/v1/requests?limit=${limit}`, 8000);
    if (!res.ok) return null;
    const body = await res.json();
    if (!body || !body.ok) return null;
    // 除历史列表外，还带回进行中的请求（卡死可见性）与告警阈值：
    //   active        —— 桥内现在正跑着的请求（id/开始时刻/模型/已运行时长）
    //   activeAlertMs —— 超过该时长在 UI 标「疑似卡死」（只影响显示，不干预）
    return {
      requests: body.requests,
      active: Array.isArray(body.active) ? body.active : [],
      activeAlertMs: typeof body.activeAlertMs === 'number' ? body.activeAlertMs : null,
    };
  } catch {
    return null;
  }
}

/**
 * 读取桥日志尾部。
 *
 * `currentOnly` 只保留**本次桥进程**的输出：按最后一次启动横幅
 * （`listening on http`，每次启动必打一行）切分。日志文件是跨多次启动
 * 追加的，不切分就会出现「面板前几行是上上次启动的输出」。
 */
export function readBridgeLog(lines = 80, { currentOnly = false } = {}) {
  const p = config.paths.bridgeLog;
  if (!existsSync(p)) return [];
  try {
    let list = readFileSync(p, 'utf8').split('\n').filter(Boolean);
    if (currentOnly) {
      let start = -1;
      for (let i = list.length - 1; i >= 0; i -= 1) {
        if (list[i].includes('listening on http')) { start = i; break; }
      }
      list = start === -1 ? [] : list.slice(start);
    }
    return list.slice(-lines);
  } catch {
    return [];
  }
}

// ── 凭据状态 ────────────────────────────────────────────────────────────

/**
 * 登录文件清单与活跃账号的凭据状态。
 *
 * 返回结构里不含令牌本身，只有长度、账号、有效期与 keyId 是否吻合。
 */
export async function credentialStatus() {
  const out = { files: [], active: null, error: null, authFile: effectiveAuthFile() };

  const dir = join(effectiveAuthFile(), '..');
  let names = [];
  try {
    names = readdirSync(dir).filter((f) => f.endsWith('.info'));
  } catch (err) {
    out.error = `无法读取登录目录：${err.message}`;
    return out;
  }

  for (const name of names) {
    const full = join(dir, name);
    try {
      const raw = JSON.parse(readFileSync(full, 'utf8'));
      const auth = raw.auth || {};
      out.files.push({
        name,
        isActiveTarget: full === effectiveAuthFile(),
        account: raw.account?.uin ? String(raw.account.uin) : '',
        domain: auth.domain || '',
        encrypted: isEncryptedFieldWrapper(auth.accessToken),
        expiresAt: Number(auth.expiresAt || 0),
        modifiedAt: statSync(full).mtimeMs,
      });
    } catch {
      /* 跳过无法解析的文件 */
    }
  }

  try {
    const raw = JSON.parse(readFileSync(effectiveAuthFile(), 'utf8'));
    const field = raw.auth?.accessToken;
    const encrypted = isEncryptedFieldWrapper(field);
    // 信封声明的 keyId（明文旧格式则无基准）
    const fileKeyId = encrypted ? envelopeKeyId(field) || '' : '';

    const candidates = defaultExecutableCandidates().filter((p) => p && existsSync(p));
    if (candidates.length === 0) {
      throw new Error('未找到 WorkBuddy 可执行文件（已探测默认位置并扫描常见安装目录）');
    }
    // 以本文件信封的 keyId 为基准挑 build —— 机器上多客户端并存时必需
    const { key } = await fetchKeyFor(candidates, fileKeyId);
    const keyId = deriveAtRestKeyId(key);

    const token = encrypted ? openEncryptedField(field, key) : String(field || '');
    const claims = decodeJwtClaims(token);
    const expiresAt = Number(raw.auth?.expiresAt || claims.exp * 1000 || 0);
    const accountId = raw.account?.uin ? String(raw.account.uin) : (claims.sub || '');

    out.active = {
      keyId,
      envelopeKeyId: encrypted ? fileKeyId : keyId,
      keyIdMatches: encrypted ? fileKeyId === keyId : true,
      encrypted,
      account: accountId,
      userId: claims.sub || '',
      // 自定义名字：键与 listAccounts 同一套（uin → userId → 文件名）
      alias: readAccountAliases()[accountId || String(effectiveAuthFile()).split(/[\\/]/).pop()] || '',
      domain: raw.auth?.domain || '',
      tokenLen: token.length,
      expiresAt,
      remainingMs: expiresAt - Date.now(),
    };
  } catch (err) {
    out.error = String(err.message || err);
  }

  return out;
}

// ── 汇总诊断 ────────────────────────────────────────────────────────────

/**
 * 「WorkBuddy 客户端」诊断项的判据（纯函数，便于单测三种分支）。
 *
 * 除了"找不找得到 exe"，还要看「两个产品是不是被装进了同一目录」——这不是
 * 理论问题：WorkBuddy 国内版 / WorkBuddy AI 国际版是两个独立 Electron 应用，
 * 却共用同一份 `resources/app.asar`。自动更新会跑完整安装器（静默卸载 + 重装），
 * 目标目录记在共享的更新器状态里，于是更新一个可能把另一个装进同一目录 ——
 * 后装的覆盖前一套的 resources，前一套的 exe 就变成"跑错版本的壳"，
 * 表现为客户端行为诡异 / AtRest 取密钥对不上，而界面上完全看不出原因。
 * 这一项把它变成一次自检就能看见的结论（真实案例与修法见 docs/TROUBLESHOOTING.md）。
 *
 * @param {string[]} exeCandidates 已确认存在的客户端 exe 路径
 * @returns {{ status: 'ok'|'fail', detail: string, hint: string }}
 */
export function describeClientInstall(exeCandidates) {
  const exe = exeCandidates[0];
  const mergedInstall = inspectClientInstalls(exeCandidates).merged[0];
  if (!exe) {
    return {
      status: 'fail',
      detail: '未找到 WorkBuddy 客户端（已探测默认位置并扫描常见安装目录）',
      hint: '客户端似乎未安装；若装在非常规目录，设置 WORKBUDDY_APP_EXECUTABLE 指向其 WorkBuddy.exe',
    };
  }
  if (mergedInstall) {
    return {
      status: 'fail',
      detail: `两个客户端被装进了同一个目录：${mergedInstall.dir}（后装的会覆盖前一套的 resources，客户端会跑错版本）`,
      hint: '把国内版与国际版分别重装到两个不同目录，并清掉共用的更新缓存'
        + '（%TEMP%\\workbuddy-update-x64*、%LOCALAPPDATA%\\@genieworkbuddy-desktop-updater）'
        + '—— 残留着对方的安装包时，客户端会把它当成自己的更新装进当前目录；'
        + '卸载重装不会丢账号（登录态在共享数据目录）；'
        + '详见 docs/TROUBLESHOOTING.md 的「两个客户端被装进同一目录」',
    };
  }
  return { status: 'ok', detail: exe, hint: '' };
}

/**
 * 环境诊断，按 fail > warn > ok 排序。
 * 返回 { items, summary, bridge, credentials, dsh }，供页面与 CLI 各自渲染。
 */
export async function diagnose() {
  const items = [];
  const push = (id, label, status, detail, hint = '') =>
    items.push({ id, label, status, detail, hint });

  const exeCandidates = defaultExecutableCandidates().filter((p) => p && existsSync(p));
  const clientInstall = describeClientInstall(exeCandidates);
  push('exe', 'WorkBuddy 客户端', clientInstall.status, clientInstall.detail, clientInstall.hint);

  const dir = join(effectiveAuthFile(), '..');
  let names = [];
  try {
    names = readdirSync(dir).filter((f) => f.endsWith('.info'));
  } catch { /* 目录不存在 */ }
  push('authfiles', '登录文件', names.length === 0 ? 'fail' : names.length > 1 ? 'warn' : 'ok',
    names.length ? names.join('  ·  ') : `目录为空：${dir}`,
    names.length > 1
      ? `存在多个账号快照，已固定使用 ${effectiveAuthFile().split(/[\\/]/).pop()}，避免选错账号`
      : '');

  const cred = await credentialStatus();
  if (cred.error) {
    push('atrest', 'AtRest 密钥', 'fail', cred.error, '确认 WorkBuddy 客户端已安装且本机可执行');
    push('token', '凭据解密', 'fail', '未取得密钥，跳过', '');
  } else {
    const a = cred.active;
    push('atrest', 'AtRest 密钥', a.keyIdMatches ? 'ok' : 'fail',
      `keyId=${a.keyId}${a.keyIdMatches ? '（与信封一致）' : '（与信封不一致）'}`,
      a.keyIdMatches ? '' : '登录文件可能由另一个 build 写入（如国际版客户端）');
    const expired = a.remainingMs <= 0;
    push('token', '凭据解密', expired ? 'warn' : 'ok',
      `账号 ${a.account || '—'} · 剩余 ${humanDuration(a.remainingMs)}`,
      expired ? '令牌已过期，请在桌面端重新登录' : '');
  }

  /*
   * 令牌文件权限。**这一项存在的理由就是「静默失效」**：加固是尽力而为的
   * （拿不到就保持默认，不阻断启动），但如果没人把它讲出来，用户看到的就是
   * 一个「随机令牌、很安全」的表象 —— 而文件在 Windows 上其实继承了目录权限，
   * 同机任何用户都能读到那个令牌。`hardenTokenFile()` 现在会如实返回结果，
   * 这里负责把它讲给用户。
   */
  const th = config.bridge.tokenHarden;
  const thOk = th?.ok === true;
  const thPath = String(config.paths.bridgeToken).replace(config.paths.root, '.');
  push('tokenfile', '令牌文件权限', thOk ? 'ok' : 'warn',
    thOk
      ? (th.code === 'skipped' ? `${thPath}（令牌未落盘，无需收紧）` : `${thPath}（已收紧为仅本人可读）`)
      : `${thPath} 未能收紧：${th.reason || '原因未知'}`,
    thOk
      ? ''
      : '同机其它用户可能读到本地令牌并调用桥、消耗账号额度。常见原因：组策略禁用 icacls、受限沙箱、或 USERNAME 环境变量缺失。手动修复：icacls "<令牌文件>" /inheritance:r /grant:r "%USERNAME%:F"');

  const health = await bridgeHealth();
  push('bridge', '桥服务', health.ok ? 'ok' : health.running ? 'warn' : 'fail',
    health.running ? `${config.bridge.host}:${config.bridge.port} 已响应` : `${config.bridge.host}:${config.bridge.port} 未监听`,
    health.ok ? '' : '点「启动桥服务」');

  /*
   * 一键接入的现状（审计 R7）。
   *
   * 为什么值得单独一项：客户端**会自己重写配置文件**（实测 Codex 每次运行都会改
   * 里面别的键）。万一某个版本开始丢掉"不认识的键"，接入就会**静默失效** ——
   * 配置里没有桥了，而面板还显示「已接入」，用户只会看到"请求没走桥"。
   * 这一项把那种失效变成一次自检就能看见的结论。
   *
   * 判据只看**文件与记录**，不需要桥在跑：记录说桥模式、文件里却不是 → 被动过；
   * 记录说 native → 是用户主动切回原始模型，不算故障。
   */
  const snap = connectSnapshot();
  const drifted = snap.filter((c) => c.drifted);
  const onBridge = snap.filter((c) => c.applied);
  const byChoice = snap.filter((c) => c.nativeByChoice);
  if (drifted.length) {
    push('connect', '客户端接入', 'warn',
      `这些客户端的配置里找不到我们写的键：${drifted.map((c) => c.label).join(' / ')}`,
      '可能是客户端重写配置时丢掉了，也可能是手工改过。在「客户端接入」页签里点那一行的「写入」重新写一遍即可；'
      + '想彻底不用桥就点「切回原始模型」。');
  } else if (onBridge.length) {
    push('connect', '客户端接入', 'ok',
      `${onBridge.map((c) => c.label).join(' / ')} 在走桥`
      + (byChoice.length ? `；${byChoice.map((c) => c.label).join(' / ')} 已切回原始模型` : ''),
      '');
  } else if (byChoice.length) {
    push('connect', '客户端接入', 'ok',
      `${byChoice.map((c) => c.label).join(' / ')} 已切回原始模型（随时可切回桥）`, '');
  } else {
    push('connect', '客户端接入', 'ok', '尚未接入任何客户端', '在「客户端接入」页签里一键接入');
  }
  const dsh = readDshStatus();
  /*
   * 路由有三条合法路径：settings.yaml（手写）、profile patch（手写）、
   * 插件原生路由（运行时 registerAdapter）。控制台进程不在 dsh 里，拿不到
   * `route.registered`，所以原生路由只能按 profile 配置判定：
   * 插件 bundle 已安装且没有被 patch 关掉。
   */
  push('settings', 'dsh 模型路由', dsh.routeLive ? 'ok' : 'fail',
    dsh.routeLive
      ? (dsh.routeMode === 'native'
        ? `插件原生路由已启用（provider=${dsh.nativePlugin.provider}，运行时注册，无需 settings.yaml）· 模型跟随桥目录`
        : `workbuddy 路由已生效（${dsh.routeSource}）· 已注册 ${dsh.registeredModels.length} 个模型`)
      : (dsh.settingsExists ? 'settings.yaml 存在，但缺少 workbuddy 路由' : '尚未配置 workbuddy 路由'),
    dsh.routeLive
      ? ''
      : '在「可用模型」里勾选后保存。若使用 dsh 插件，请确认插件已启用 —— '
        + '原生路由在运行时注册，不需要 settings.yaml');

  /*
   * 原生路由不经过 llm-pi-ai，凭据走插件自己的本地令牌（.bridge-token），
   * 因此 WORKBUDDY_BRIDGE_KEY 不是必需的。旧口径把这种情况也报成「缺少占位凭据」，
   * 与同一页「令牌文件权限」的绿灯自相矛盾（issue #1）。
   */
  const nativeRoute = dsh.routeMode === 'native';
  push('credref', '凭据引用', (dsh.hasBridgeKey || nativeRoute) ? 'ok' : 'fail',
    dsh.hasBridgeKey
      ? '.credentials.yaml 已含 WORKBUDDY_BRIDGE_KEY'
      : nativeRoute
        ? '原生插件路由不需要 WORKBUDDY_BRIDGE_KEY（桥使用插件自己的本地令牌）'
        : '缺少占位凭据',
    (dsh.hasBridgeKey || nativeRoute) ? '' : 'pi-ai 的 OpenAI 实现要求必须提供 API key 引用');

  const missing = dsh.bundles.filter((b) => !b.installed);
  const missingRequired = missing.filter((b) => b.optional !== true);
  const missingOptional = missing.filter((b) => b.optional === true);
  const desktop = config.dsh.desktopVersion ? ` · DSH ${config.dsh.desktopVersion}` : '';
  // 读不到 profile ≠ 全部装好：空列表必须如实说「未找到」，而不是给绿灯
  const bundlesStatus = !dsh.bundles.length
    ? 'warn'
    : (missingRequired.length ? 'fail' : (missingOptional.length ? 'warn' : 'ok'));
  push('bundles', 'profile bundles', bundlesStatus,
    dsh.bundles.length
      ? `${dsh.bundles.length} 个，缺失 ${missing.length} 个`
        + (missingOptional.length
          ? `（其中 ${missingOptional.length} 个是可选实验 bundle）`
          : '')
        + desktop
      : `未找到 profile${desktop}`,
    missingRequired.length
      ? `缺失：${missingRequired.map((b) => b.name).join(', ')}；在 profile 目录执行 pnpm add <包名>@<与 DSH 一致的版本>。`
        + '注意版本必须对齐——装错代次会连 peer 依赖一起错'
      : (missingOptional.length
        ? `可选实验 bundle 未安装：${missingOptional.map((b) => b.name).join(', ')}。`
          + '它们各自对应一项实验功能，不装不影响基础模型路由。'
          + '若要安装：先在 profile 目录备份 package.json 与 pnpm-lock.yaml，再执行 pnpm add <包名>@<与 DSH 一致的版本>。'
        : ''));

  const order = { fail: 0, warn: 1, ok: 2 };
  items.sort((a, b) => order[a.status] - order[b.status]);

  return {
    items,
    summary: {
      fail: items.filter((i) => i.status === 'fail').length,
      warn: items.filter((i) => i.status === 'warn').length,
      ok: items.filter((i) => i.status === 'ok').length,
    },
    bridge: health,
    credentials: cred,
    dsh,
  };
}

// 诊断结论由调用方渲染：控制台页面见 dashboard/，命令行见 tools/doctor.mjs。
