/**
 * 环境诊断：把「为什么用不了」拆成 8 项可判定的事实。
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
import config from '../config.mjs';
import { effectiveAuthFile } from './state.mjs';
import { readDshStatus } from './dsh.mjs';

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
 * 列出登录目录下的**全部**账号快照及其可用性。
 *
 * 与 {@link credentialStatus} 的区别：后者只看当前生效的那一个，这里会逐个
 * 尝试解开，因此能直接看出"另一个账号能不能用、还剩多少天"。
 */
export async function listAccounts() {
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

  // 生效中的排最前，其次可用的
  out.accounts.sort((a, b) => Number(b.active) - Number(a.active) || Number(b.usable) - Number(a.usable));
  return out;
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

    out.active = {
      keyId,
      envelopeKeyId: encrypted ? fileKeyId : keyId,
      keyIdMatches: encrypted ? fileKeyId === keyId : true,
      encrypted,
      account: raw.account?.uin ? String(raw.account.uin) : (claims.sub || ''),
      userId: claims.sub || '',
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
 * 9 项诊断，按 fail > warn > ok 排序。
 * 返回 { items, summary, bridge, credentials, dsh }，供页面与 CLI 各自渲染。
 */
export async function diagnose() {
  const items = [];
  const push = (id, label, status, detail, hint = '') =>
    items.push({ id, label, status, detail, hint });

  const exe = defaultExecutableCandidates().find((p) => p && existsSync(p));
  push('exe', 'WorkBuddy 客户端', exe ? 'ok' : 'fail',
    exe || '未找到 WorkBuddy 客户端（已探测默认位置并扫描常见安装目录）',
    exe ? '' : '客户端似乎未安装；若装在非常规目录，设置 WORKBUDDY_APP_EXECUTABLE 指向其 WorkBuddy.exe');

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
  const dsh = readDshStatus();
  push('settings', 'dsh 模型路由', dsh.routeLive ? 'ok' : 'fail',
    dsh.routeLive
      ? `workbuddy 路由已生效（${dsh.routeSource}）· 已注册 ${dsh.registeredModels.length} 个模型`
      : (dsh.settingsExists ? 'settings.yaml 存在，但缺少 workbuddy 路由' : '尚未配置 workbuddy 路由'),
    dsh.routeLive
      ? ''
      : '在「可用模型」里勾选后保存。DSH Desktop 0.2.0 会在下次启动时把 settings.yaml 导入 profile 的 patch 层');

  push('credref', '凭据引用', dsh.hasBridgeKey ? 'ok' : 'fail',
    dsh.hasBridgeKey ? '.credentials.yaml 已含 WORKBUDDY_BRIDGE_KEY' : '缺少占位凭据',
    dsh.hasBridgeKey ? '' : 'pi-ai 的 OpenAI 实现要求必须提供 API key 引用');

  const missing = dsh.bundles.filter((b) => !b.installed);
  const desktop = config.dsh.desktopVersion ? ` · DSH ${config.dsh.desktopVersion}` : '';
  push('bundles', 'profile bundles', missing.length ? 'fail' : 'ok',
    dsh.bundles.length
      ? `${dsh.bundles.length} 个，缺失 ${missing.length} 个${desktop}`
      : `未找到 profile${desktop}`,
    missing.length
      ? `缺失：${missing.map((b) => b.name).join(', ')}；在 profile 目录执行 pnpm add <包名>@<与 DSH 一致的版本>。`
        + '注意版本必须对齐——装错代次会连 peer 依赖一起错'
      : '');

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
