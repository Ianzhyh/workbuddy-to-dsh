/**
 * 环境诊断：把「为什么用不了」拆成一组可判定的事实。
 *
 * 控制台页面与命令行 `tools/doctor.mjs` 共用本模块，保证两处结论一致。
 * 所有函数都只读凭据用于判定，绝不返回令牌明文。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
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
import { effectiveAuthFile, readAccountAliases, readAccountOrder, readHiddenAccounts, readState, writeState } from './state.mjs';
import { describeConfigCheck, validateConfigEnv } from './config-schema.mjs';
import { readDshStatus, bundleHealth, isCoreBundle } from './dsh.mjs';
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

/**
 * 本地脚本的内容指纹（与桥 `/health.build` 同一算法）。
 *
 * 用途：判断「端口上正在跑的那个进程」是不是当前磁盘上的代码。升级后
 * 旧进程继续服务时，面板/诊断可以据此说清原因，而不是把旧行为当成新版本。
 */
export function fileBuildHash(path) {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 16);
  } catch {
    return '';
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

/** 路径归一化：Windows 上同一路径可能以 / 或 \ 出现，比较前统一。 */
export function normalizePath(p) {
  return String(p || '').replace(/\\/g, '/').toLowerCase();
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
 * 带方法/请求体的桥调用（控制台侧）。`bridgeFetch` 只覆盖 GET 探活，这里补写操作。
 * 非 2xx 或 `{ok:false}` 抛错，错误里带 status 方便页面区分 401/404/业务失败。
 */
/**
 * @param {string} path
 * @param {{ method?: string, body?: unknown, timeoutMs?: number }} [options]
 */
async function bridgeJsonCall(path, { method = 'GET', body, timeoutMs = 15000 } = {}) {
  const res = await fetch(config.bridge.url + path, {
    method,
    headers: {
      Authorization: `Bearer ${config.bridge.token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text().catch(() => '');
  let data = null;
  try { data = JSON.parse(text); } catch { /* 非 JSON：下面按原文/状态码报错 */ }
  if (!res.ok || data?.ok === false) {
    /** @type {Error & { status?: number }} */
    const error = new Error(String(data?.error || text || `HTTP ${res.status}`));
    error.status = res.status;
    throw error;
  }
  return data;
}

/**
 * 「桥默认返回哪些模型」的当前设置（面板「可用模型」里那一行）。
 *
 * 桥没起来 / 旧版桥没有这个端点时返回 `null` —— 页面据此**隐藏**那一行，
 * 而不是显示一个假的默认值（用户会以为保存生效了）。
 */
export async function bridgeModelsDefault() {
  try {
    const body = await bridgeJsonCall('/v1/models/default', { timeoutMs: 5000 });
    return body && typeof body === 'object' ? body : null;
  } catch {
    return null;
  }
}

/**
 * 保存「桥默认返回哪些模型」。
 *
 * **两种形状都要原样转发**，别在这里归一成 `{ value }`：
 *   - `{ value: 'curated' | 'all' | 数字 }` —— 按数量给；
 *   - `{ ids: [...] }` —— 按名字点名（面板「表格里勾选的」）。
 *   - `{ value: null }` —— 清掉面板偏好、回落到环境变量。
 *
 * 这里曾经写成 `body: { value: value ?? null }`，于是 `ids` 被**静默丢掉**、
 * 变成"清空偏好"：用户勾选后点保存，客户端清单直接跳回精选 3 个 ——
 * 看起来像"保存把我选的改成了精选"。转发层不要替调用方解释语义。
 */
export function bridgeSaveModelsDefault(payload) {
  const body = (payload && typeof payload === 'object')
    ? payload
    : { value: payload ?? null };
  return bridgeJsonCall('/v1/models/default', {
    method: 'POST',
    body,
    timeoutMs: 15000,
  });
}

/** 插件登录：来源状态 / 凭据清单（永不含令牌）。 */
export const bridgeAuthSource = () => bridgeJsonCall('/v1/auth/source');
export const bridgeAuthCredentials = () => bridgeJsonCall('/v1/auth/credentials');
export const bridgeDeviceStart = (region = 'cn', { open = false } = {}) => bridgeJsonCall('/v1/auth/device', { method: 'POST', body: { region, open: open === true }, timeoutMs: 30000 });
export const bridgeDevicePoll = (state) => bridgeJsonCall(`/v1/auth/device?state=${encodeURIComponent(state)}`, { timeoutMs: 30000 });
export const bridgeDeviceCancel = (state) => bridgeJsonCall(`/v1/auth/device?state=${encodeURIComponent(state)}`, { method: 'DELETE', timeoutMs: 8000 });
export const bridgeAuthActive = (uid) => bridgeJsonCall('/v1/auth/active', { method: 'POST', body: { uid }, timeoutMs: 8000 });
export const bridgeAuthLogout = (uid) => bridgeJsonCall(`/v1/auth/credentials?uid=${encodeURIComponent(uid)}`, { method: 'DELETE', timeoutMs: 15000 });

/*
 * 账号存档 / 恢复 / 重建 —— 「登录就应该保存」的落地口（桥侧实现，见
 * workbuddy-bridge.mjs 的「账号存档 / 重建」段）。
 *
 * 起因是一次真实事故：客户端**换号**用新账号原地覆盖了 `workbuddy-desktop.info`，
 * 于是原来那个号在登录目录里一份副本都没留下，面板里整行消失 —— 只剩它早先用
 * 浏览器登录留下的插件凭据。客户端只在「登出」时留快照，换号不留。
 *
 * 三个动作的分工：
 *   - `bridgeAccountsArchive()`        读存档清单（不含令牌）
 *   - `bridgeAccountsArchiveSweep()`   立刻扫一遍登录目录并保存
 *   - `bridgeAccountsRestore(key)`     把存档里的某份放回登录目录（新快照）
 *   - `bridgeAccountsRebuild(uid)`     用插件凭据反向重建登录快照（uid 省略 = 全部缺失的）
 */
export const bridgeAccountsArchive = () => bridgeJsonCall('/v1/accounts/archive', { timeoutMs: 8000 });
export const bridgeAccountsArchiveSweep = () => bridgeJsonCall('/v1/accounts/archive', { method: 'POST', body: {}, timeoutMs: 60000 });
export const bridgeAccountsRestore = (key, file) => bridgeJsonCall('/v1/accounts/restore', {
  method: 'POST',
  body: file ? { key, file } : { key },
  timeoutMs: 15000,
});
export const bridgeAccountsRebuild = (uid) => bridgeJsonCall('/v1/accounts/rebuild', {
  method: 'POST',
  body: uid ? { uid } : {},
  timeoutMs: 90000,
});
export const bridgeSetAuthSource = (source) => bridgeJsonCall('/v1/auth/source', { method: 'POST', body: { source }, timeoutMs: 8000 });

/**
 * 体检的输入体积档位（token，**已校准为"上游实际会算的 token"**）。
 *
 * ## 为什么体检必须发**真实体积**（这是本函数存在的全部理由）
 *
 * 上游对限流是按**请求体积**判定的，不是按"请求次数"。发 20 个 token 的探针
 * 问"这个模型能用吗"，在真实长对话里几乎必然得到相反答案 ——
 * 用户看到的是「体检通过，一用就被限」，而且找不出原因（因为确实"通过了"）。
 *
 * ## 档位是"实际 token"，不是"填充字符数"
 *
 * 本机实测（2026-11-07，`glm-5.3`，与上游 `prompt_tokens` 对照）：
 *
 * | 填充目标 | 请求体 | 上游实算 prompt_tokens | 扣积分 | 耗时 |
 * |---|---|---|---|---|
 * | 20,000 | 60 KB | **11,269** | **1.86** | 4.0s |
 * | 100,000 | 300 KB | **56,269** | **7.76** | 5.0s |
 *
 * 两个档位的实测/填充比都是 **56%** —— 说明重复中文被分词器压缩了。
 * 所以 {@link probeFiller} 会按这个比例**放大填充量**，
 * 让"选 20000 档"真的发出约 20000 token，而不是名义值。
 *
 * ## 成本必须说清楚（这是选档位的真正依据）
 *
 * 一档 20k ≈ **1.86 积分/个模型**。一次「全部体检」跑 56 个模型 ≈ **104 积分**。
 * 这不是可以随手点的操作，所以：
 *   - 默认取较低的 **10k** 档（≈0.9 积分/模型），而不是最贵的档；
 *   - 档位是**可选**的，想按自己真实流量测的人可以上调；
 *   - 界面必须显示"这次会扣多少"，详见 `estimateProbeCredits()`。
 */
export const PROBE_INPUT_TOKEN_CHOICES = [5_000, 10_000, 20_000, 30_000, 50_000];

/**
 * 默认档：10k。
 *
 * 取舍：真实长对话多在 5k–20k，10k 覆盖了**多数**请求的体积；
 * 而 20k 只多覆盖一点，成本却翻倍（1.86 vs ~0.9 积分）。默认值应当服务于
 * "经常点"的场景，想更严的人自己上调一档。
 */
export const DEFAULT_PROBE_INPUT_TOKENS = 10_000;

/**
 * 填充量与上游实算 token 的比例（实测 56%）。
 *
 * 用法：想让上游算 10000 token，就要填 `10000 / 0.56 ≈ 17857` 个汉字。
 * 这个值来自真实对照，**不是估计**；上游若换了分词器，这里会偏，
 * 所以体检结果里同时给出 `promptTokens`（上游的答案）供核对。
 */
export const PROBE_FILLER_RATIO = 0.56;

/**
 * 把一个请求的输入体积归一成合法档位。
 *
 * 非档位值**规整到不超过目标的最大档**而不是报错：体检是诊断动作，
 * 传 25000 就按 20000 跑，比让用户先去改配置更有用。
 * @param {unknown} value
 * @returns {number}
 */
export function resolveProbeInputTokens(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_PROBE_INPUT_TOKENS;
  const fit = PROBE_INPUT_TOKEN_CHOICES.filter((c) => c <= n);
  return fit.length ? Math.max(...fit) : PROBE_INPUT_TOKEN_CHOICES[0];
}

/**
 * 估一次体检大概扣多少积分（给界面提前告知用）。
 *
 * ## 为什么要查表而不是乘一个单价
 *
 * 本机 2026-11-07 对 `glm-5.3` 的**四组**实测：
 *
 * | 上游实算 token | 实扣积分 | 折算单价 |
 * |---|---|---|
 * | 11,269 | 1.86 | 1.65e-4 |
 * | 10,072 | **0.45** | **0.45e-4** |
 * | 50,248 | 8.16 | 1.62e-4 |
 * | 56,269 | 7.76 | 1.38e-4 |
 *
 * 单价在 **0.45e-4 到 1.65e-4 之间跳了 3.7 倍** —— 明显分段计价，
 * 与"输入 token 数"不是线性关系（10k 那一档特别便宜，像是踩在某个免费/优惠
 * 区间里）。所以**不能**用线性公式：那会把 10k 档高估 3.7 倍，
 * 让用户以为"随便点点就花掉一百积分"，从而不敢用这个功能。
 *
 * 做法：按**实测档位查表**，档位之间线性插值；超出表的按最高档单价外推
 * （外推取保守的较大单价，宁可说贵）。
 *
 * 这是**估算**：实际金额由上游决定，所以界面写"约"，结果里回填真实 `credit`。
 * @param {number} inputTokens
 * @returns {number} 积分（两位小数）
 */
export function estimateProbeCredits(inputTokens) {
  const n = Number(inputTokens);
  if (!Number.isFinite(n) || n <= 0) return 0;
  /*
   * 实测锚点（按 token 升序）。全部来自**真实请求**的 `usage.credit`：
   *   5,050 → 0.26 ｜ 10,072 → 0.45 ｜ 11,269 → 1.86
   *   30,160 → 4.91 ｜ 50,248 → 8.16 ｜ 56,269 → 7.76
   *
   * 注意 10,072 → 0.45 与 11,269 → 1.86 之间的**跳变**：1.2k token 差异让
   * 扣费涨 4 倍 —— 说明上游在约 10k–11k 处有一条计价分界。所以这套表必须
   * 按实测点分段，任何"统一单价"的写法都会在跨越分界时严重失真。
   *
   * 表里对同一区间内的多个读数取**偏大**的那个（宁可把成本说贵一点，
   * 也不要让用户点完才发现超预期）。
   */
  const ANCHORS = [
    [5_000, 0.26],
    [10_000, 0.45],
    [12_000, 1.86],
    [20_000, 3.30],
    [30_000, 4.91],
    [50_000, 8.16],
  ];
  if (n <= ANCHORS[0][0]) return round2((n / ANCHORS[0][0]) * ANCHORS[0][1]);
  for (let i = 1; i < ANCHORS.length; i += 1) {
    const [x1, y1] = ANCHORS[i - 1];
    const [x2, y2] = ANCHORS[i];
    if (n <= x2) {
      const t = (n - x1) / (x2 - x1);
      return round2(y1 + t * (y2 - y1));
    }
  }
  // 超出最高锚点：按最高档单价外推（保守）
  const [xMax, yMax] = ANCHORS[ANCHORS.length - 1];
  return round2((n / xMax) * yMax);
}

/** 两位小数。 */
const round2 = (v) => Math.round(v * 100) / 100;

/**
 * 造一段**上游会按约 `tokens` 个 token 计费**的填充文本。
 *
 * ## 为什么按"中文字数"而不是按字符数估
 *
 * 上游对中文的计费接近 **1 字 ≈ 1 token**，英文约 4 字符/token。用字符数估会
 * 系统性低估中文请求体积。
 *
 * ## 为什么要乘 {@link PROBE_FILLER_RATIO}
 *
 * 实测重复中文被分词器压缩到 56%（见该常量的表）。不补偿的话，
 * "选 20k 档"实际只发 11k —— 那正是旧实现"金额说一套、体积做一套"的同一种病。
 *
 * @param {number} tokens 想让上游实际计算的 token 数
 * @returns {string}
 */
export function probeFiller(tokens) {
  // 16 个汉字的固定单元：可数、内容中性、不触发任何话题过滤
  const unit = '请仔细阅读下面这段说明并记住要点';
  const chars = Math.max(unit.length, Math.ceil(tokens / PROBE_FILLER_RATIO));
  const times = Math.max(1, Math.ceil(chars / unit.length));
  return unit.repeat(times);
}

/**
 * 模型可用性探测 —— 用**真实体积**的请求判断该模型此刻能不能用。
 *
 * ## 与旧实现的关键差别
 *
 * 旧版发 `hi`（约 21 token）就宣布"可用"。那在限流按体积判定的上游上是个
 * **错误结论**：它只证明了"小请求能过"，而用户真正关心的是"我这个长对话能不能过"。
 * 现在默认发 {@link DEFAULT_PROBE_INPUT_TOKENS} 个 token 的输入。
 *
 * ## 仍然保留 `max_tokens: 64`
 *
 * 不能给 1：推理模型会拒绝过小的输出预算（400 `model_param_invalid`），
 * 把"模型还在"误判成"模型不可用"。64 是实测能过的最小安全值 ——
 * 这一点与体积无关，是**输出**预算的约束。
 *
 * ## 返回里带上实测体积
 *
 * `inputTokens`（实际发出去的估算体积）与 `promptTokens`（上游回报的真实值）
 * 都带出去：前者让用户知道这次体检"有多真"，后者是他们校准自己档位的依据。
 * 二者不一致是正常现象（估算 vs 计费口径），**都如实给出，不做归一**。
 *
 * @param {string} model
 * @param {{ timeoutMs?: number, inputTokens?: number }} [options]
 */
export async function probeModel(model, { timeoutMs = 30_000, inputTokens } = {}) {
  const started = Date.now();
  const wantTokens = resolveProbeInputTokens(inputTokens);
  const filler = probeFiller(wantTokens);
  try {
    const res = await fetch(config.bridge.chatUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.bridge.token}`,
        // 体检是**主动探测**：桥把它记进账本但不计入"最近请求失败"待办，
        // 否则点一次「全部体检」就会把模型不可用误报成用户需要处理的故障。
        'X-WorkBuddy-Probe': '1',
      },
      body: JSON.stringify({
        model,
        // 首条必须是 system：国际版网关会以 400 code 11128 拒绝纯 user 开头的请求
        messages: [
          { role: 'system', content: 'You are a helpful assistant.' },
          { role: 'user', content: filler },
        ],
        max_tokens: 64,
        stream: false,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const ms = Date.now() - started;
    /*
     * 失败时也要带出 `inputTokens`：用户需要知道"这次失败发生在多大体积上"。
     * 20 token 失败与 20k token 失败是两种完全不同的问题（前者模型没了，
     * 后者可能只是被限流），只看 `ok:false` 分不出来。
     */
    if (!res.ok) {
      const text = (await res.text().catch(() => '')).slice(0, 240);
      return { model, ok: false, ms, inputTokens: wantTokens, error: `HTTP ${res.status}${text ? ` · ${text}` : ''}` };
    }
    const body = await res.json().catch(() => null);
    const content = body?.choices?.[0]?.message?.content;
    // 上游在 usage 里回报本次实际扣减的积分，可用于实测倍率
    const credit = body?.usage?.credit;
    const tokens = body?.usage?.total_tokens;
    const promptTokens = body?.usage?.prompt_tokens;
    return {
      model,
      ok: true,
      ms,
      /*
       * `inputTokens` = 我们**打算**发多大（估算）；`promptTokens` = 上游**实际**
       * 算了多少。两者并存是刻意的：估算与计费口径本就不同（中文按字、英文按
       * 字符），只报一个都会让人误以为另一个"错了"。
       */
      inputTokens: wantTokens,
      ...(typeof promptTokens === 'number' ? { promptTokens } : {}),
      sample: String(content ?? '').slice(0, 30),
      ...(typeof credit === 'number' ? { credit } : {}),
      ...(typeof tokens === 'number' ? { tokens } : {}),
    };
  } catch (err) {
    return {
      model,
      ok: false,
      ms: Date.now() - started,
      inputTokens: wantTokens,
      error: String(err.message || err).slice(0, 240),
    };
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
  const out = { dir, active, desktopAuth: config.workbuddy.authFile, desktopUid: '', accounts: [], keyError: null };

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

      if (key || !entry.encrypted) {
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

  // 桌面端当前登录文件对应的账号（不是 `.state.json` 钉住的快照）。
  const desktopEntry = out.accounts.find((entry) => normalizePath(entry.path) === normalizePath(out.desktopAuth));
  // 另一个 build 写的加密字段解不开时，userId 会是空；`account`（uin）通常仍是明文。
  out.desktopUid = desktopEntry?.userId || desktopEntry?.account || '';

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
 * 校正 `.state.json` 里的账号钉住状态。
 *
 * 面板的「切换账号」会把桥钉到某个登录快照（`authFile`）。但用户后来在
 * WorkBuddy 客户端里换号时，客户端覆盖的是它**自己的默认登录文件**，不是
 * 我们钉住的快照 —— 于是桥和面板一直显示旧账号（issue #6）。
 *
 * 判据：
 *   - 钉住时记录了 `authFileDesktopUid`：桌面账号变了 → 解除钉住，跟随桌面；
 *   - 老状态没有该字段：钉住快照的账号与桌面当前账号不同 → 解除（迁移一次）；
 *     相同则补记，视为用户主动选的同账号快照。
 *   - 钉住文件已被删除/解不开 → 解除。
 *
 * 只写 `.state.json`，**不动任何登录文件**。返回 `{changed, previousPin, reason}`。
 */
export async function reconcileAccountPin() {
  const state = readState();
  const pinned = typeof state.authFile === 'string' ? state.authFile.trim() : '';
  const desktop = config.workbuddy.authFile;
  if (!pinned || normalizePath(pinned) === normalizePath(desktop)) {
    return { changed: false, previousPin: '', reason: '' };
  }
  const listed = await listAccountFiles();
  const desktopUid = listed.desktopUid || '';
  if (!desktopUid) return { changed: false, previousPin: pinned, reason: 'desktop-unreadable' };
  const pinnedEntry = listed.accounts.find((a) => normalizePath(a.path) === normalizePath(pinned));
  const clear = (reason) => {
    writeState({ authFile: null, authFileDesktopUid: null, authFilePinnedAt: null });
    return { changed: true, previousPin: pinned, reason };
  };
  if (!existsSync(pinned) || !pinnedEntry) return clear('pinned-file-missing');
  if (pinnedEntry.usable !== true) return clear('pinned-file-unusable');
  const recorded = typeof state.authFileDesktopUid === 'string' ? state.authFileDesktopUid.trim() : '';
  if (!recorded) {
    const pinnedUid = pinnedEntry.userId || pinnedEntry.account || '';
    if (pinnedUid && String(pinnedUid) !== String(desktopUid)) {
      return clear('legacy-pin-desktop-switched');
    }
    writeState({
      authFileDesktopUid: String(desktopUid),
      authFilePinnedAt: state.authFilePinnedAt || new Date().toISOString(),
    });
    return { changed: false, previousPin: pinned, reason: 'legacy-pin-adopted' };
  }
  if (String(recorded) !== String(desktopUid)) return clear('desktop-switched');
  return { changed: false, previousPin: pinned, reason: '' };
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
/**
 * 积分缓存。`account` = 这份余额属于哪个账号（桥的 `/v1/quota` 现在会带回）。
 *
 * 为什么要按账号记账：换号可以由**桌面客户端**发起（桥自动跟随），控制台
 * 根本收不到任何通知。只清缓存不够 —— 必须在下一次读取时知道「缓存里的
 * 余额不是当前桥账号的」，否则会继续把上一个账号的余额显示在新账号下面
 * （issue #6 的第二段现象）。
 */
let quotaCache = { at: 0, ttl: 0, value: null, account: '' };
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
  quotaCache = { at: 0, ttl: 0, value: null, account: '' };
  quotaGeneration += 1;
  quotaInflight = null;
}

/** 真正去上游取一次（带 in-flight 去重）。永不 reject，失败按 null 缓存。 */
function fetchQuota(timeoutMs, expectedAccount = '') {
  if (quotaInflight) return quotaInflight;
  const gen = quotaGeneration;
  const run = (async () => {
    let value = null;
    try {
      const res = await bridgeFetch('/v1/quota', timeoutMs);
      if (res.ok) {
        const body = await res.json();
        if (body && body.ok) {
          /*
           * 桥带回了「这份余额属于谁」。与调用方期望的账号不一致时丢弃 ——
           * 典型时序：轮询在飞 → 桌面端换号 → 响应回来时已经是新账号。
           * 不比对的话，旧账号的余额会被写成新账号的缓存。
           */
          const account = typeof body.account === 'string' ? body.account : '';
          if (expectedAccount && account && account !== expectedAccount) {
            value = null;
          } else {
            value = body;
          }
        }
      }
    } catch {
      /* 上游不可用：按失败缓存，页面显示「—」而不是卡住 */
    }
    // 只有自己这一代仍是当前代才写回：作废过的结果不许覆盖新缓存
    if (gen === quotaGeneration) {
      quotaCache = {
        at: Date.now(),
        ttl: value ? QUOTA_TTL_MS : QUOTA_FAIL_TTL_MS,
        value,
        account: value && typeof value.account === 'string' ? value.account : '',
      };
    }
    return value;
  })();
  quotaInflight = run;
  /*
   * 只清自己那一个句柄：作废（换号/签到）之后可能已经发起新一代请求，
   * 旧请求结束时不能把新句柄清掉，否则并发去重会漏。
   */
  run.finally(() => { if (quotaInflight === run) quotaInflight = null; });
  return run;
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
export async function bridgeQuota({ force = false, expectedAccount = '' } = {}) {
  const wanted = typeof expectedAccount === 'string' ? expectedAccount.trim() : '';
  /*
   * 桌面端换号不会通知控制台；如果缓存里记着 A 账号，而桥现在服务的是 B，
   * 直接返回缓存就等于把 A 的余额挂在 B 头上。这里在读取前先按账号作废，
   * 后续走「冷启动」分支取 B 的值（最多等 QUOTA_BLOCK_MS，拿不到就显示 —）。
   */
  if (!force && wanted && quotaCache.at > 0 && quotaCache.account && quotaCache.account !== wanted) {
    invalidateQuotaCache();
  }
  const age = Date.now() - quotaCache.at;
  if (!force && age < quotaCache.ttl) return quotaCache.value;

  // 有旧值就先给旧的 —— 这是「不让慢的上游拖住页面」的关键一步
  if (!force && quotaCache.at > 0 && !(wanted && quotaCache.account && quotaCache.account !== wanted)) {
    fetchQuota(20000, wanted).catch(() => {});
    return quotaCache.value;
  }

  // 冷启动 / 强制刷新：等一次，但设上限
  const limit = force ? 20000 : QUOTA_BLOCK_MS;
  const timedOut = Symbol('timeout');
  const result = await Promise.race([
    fetchQuota(20000, wanted),
    new Promise((resolve) => { setTimeout(() => resolve(timedOut), limit); }),
  ]);
  return result === timedOut ? null : result;
}

/** 桥的轻量身份快照（`/v1/identity`）：不抓目录、不打上游，供前端 2 秒轮询。 */
export async function bridgeIdentity(timeoutMs = 4000) {
  try {
    const res = await bridgeFetch('/v1/identity', timeoutMs);
    if (!res.ok) return null;
    const body = await res.json().catch(() => null);
    return body && body.ok ? body : null;
  } catch {
    return null;
  }
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
 *
 * 控制台日志抽屉每 3 秒轮询一次。整份 2MB 日志反复同步读 + 切行会占用
 * 事件循环，因此按 `size + mtimeMs` 缓存已经切好的行；追加后指纹变化，
 * 下次读取自然更新。缓存键包含文件路径，测试用临时文件不会串档。
 */
let bridgeLogCache = { file: '', key: '', lines: [] };

export function readBridgeLog(lines = 80, { currentOnly = false, file = config.paths.bridgeLog } = {}) {
  let list;
  try {
    const st = statSync(file);
    const key = `${st.size}:${st.mtimeMs}`;
    if (bridgeLogCache.file !== file || bridgeLogCache.key !== key) {
      bridgeLogCache = {
        file,
        key,
        lines: readFileSync(file, 'utf8').split('\n').filter(Boolean),
      };
    }
    list = bridgeLogCache.lines;
  } catch {
    return [];
  }
  if (currentOnly) {
    let start = -1;
    for (let i = list.length - 1; i >= 0; i -= 1) {
      if (list[i].includes('listening on http')) { start = i; break; }
    }
    list = start === -1 ? [] : list.slice(start);
  }
  return list.slice(-lines);
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

  /*
   * 先取桥的凭据来源：没装桌面端、但用插件登录时，下面的 exe / 登录文件 /
   * AtRest 检查都不该报红 —— 它们只是**桌面端凭据路径**的前置条件。
   */
  const health = await bridgeHealth();
  const credInfo = health.body?.credential;
  const pluginActive = credInfo?.source === 'plugin';
  let pluginCredentialCount = 0;
  try { pluginCredentialCount = readdirSync(config.workbuddy.credentialDir).filter((f) => f.endsWith('.cred')).length; } catch { /* 目录不存在 */ }

  const exeCandidates = defaultExecutableCandidates().filter((p) => p && existsSync(p));
  const clientInstall = describeClientInstall(exeCandidates);
  const noClient = exeCandidates.length === 0;
  push('exe', 'WorkBuddy 客户端',
    pluginActive && noClient ? 'ok' : clientInstall.status,
    pluginActive && noClient ? '未安装桌面端；当前使用插件登录' : clientInstall.detail,
    pluginActive && noClient ? '' : clientInstall.hint);

  const dir = join(effectiveAuthFile(), '..');
  let names = [];
  try {
    names = readdirSync(dir).filter((f) => f.endsWith('.info'));
  } catch { /* 目录不存在 */ }
  push('authfiles', '登录文件',
    names.length === 0 ? (pluginActive ? 'ok' : 'fail') : names.length > 1 ? 'warn' : 'ok',
    names.length ? names.join('  ·  ') : (pluginActive ? '无桌面端登录文件（当前使用插件登录）' : `目录为空：${dir}`),
    names.length > 1
      ? `存在多个账号快照，已固定使用 ${effectiveAuthFile().split(/[\\/]/).pop()}，避免选错账号`
      : (names.length === 0 && !pluginActive
        ? '安装并登录 WorkBuddy 桌面端；或在 dsh 插件里使用「插件登录」'
        : ''));

  const cred = await credentialStatus();
  if (pluginActive) {
    push('atrest', 'AtRest 密钥', 'ok', '不适用（当前使用插件登录）', '');
    push('token', '凭据解密', 'ok',
      `插件凭据 · store=${credInfo?.storeMode || 'unknown'} · 账号 ${credInfo?.pluginCount ?? pluginCredentialCount} 个`,
      '');
  } else if (cred.error) {
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

  /*
   * 配置取值：格式错误时 numEnv() 会静默退回默认值，启动不报错 ——
   * 用户只会看到「改了 .env 却没生效」。这里提前跑同一套判据并如实报出来。
   */
  const configCheck = describeConfigCheck(validateConfigEnv());
  push('configvalues', '配置取值', configCheck.status, configCheck.detail, configCheck.hint);

  push('bridge', '桥服务', health.ok ? 'ok' : health.running ? 'warn' : 'fail',
    health.running ? `${config.bridge.host}:${config.bridge.port} 已响应` : `${config.bridge.host}:${config.bridge.port} 未监听`,
    health.ok ? '' : '点「启动桥服务」');

  /*
   * 凭据来源（第二条来源上线后必须可见）：detail 用 ASCII 键值，避免动态串
   * 在英文界面里漏翻；label 本身走 i18n。
   */
  if (credInfo) {
    const src = credInfo.source || credInfo.configured || '';
    const store = credInfo.storeMode || '';
    const count = Number(credInfo.pluginCount) || 0;
    push('credsource', '凭据来源', src ? 'ok' : 'warn',
      `${src || 'none'}${store ? ` · store=${store}` : ''}${count ? ` · plugin=${count}` : ''}`,
      '');
  }

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

  /*
   * bundle 判定的三档结论（issue #26）：
   *   fail —— 确认缺失，且能指出该装在哪（第三方 bundle）
   *   warn —— 悬空链接 / 判不了（打包 asar 读不到、布局不认识）：既不能证实也
   *           不能证伪，之前这里一律报红，于是打包安装的用户被要求去 profile
   *           里 pnpm add 一个**安装自带**的核心 bundle（有破坏性）
   *   ok   —— 全部解析到了（含从 app.asar 里确认的那几个）
   */
  const bundleState = bundleHealth(dsh.bundles);
  const desktop = config.dsh.desktopVersion ? ` · DSH ${config.dsh.desktopVersion}` : '';
  const nameList = (list) => list.map((b) => b.name).join(', ');
  const optionalSeg = bundleState.missingOptional.length
    ? `（其中 ${bundleState.missingOptional.length} 个是可选实验 bundle）`
    : '';
  const packedSeg = bundleState.packed ? `（${bundleState.packed} 个随安装提供）` : '';
  // 读不到 profile ≠ 全部装好：空列表必须如实说「未找到」，而不是给绿灯
  const bundlesDetail = !dsh.bundles.length
    ? `未找到 profile${desktop}`
    : (bundleState.unverified.length
      // 判不了的项不计入「缺失」—— 说缺失就是断言我们并不知道的事
      ? `${dsh.bundles.length} 个，缺失 ${bundleState.missing.length - bundleState.unverified.length} 个，`
        + `${bundleState.unverified.length} 个无法确认${desktop}`
      : `${dsh.bundles.length} 个，缺失 ${bundleState.missing.length} 个${optionalSeg}${packedSeg}${desktop}`);

  /*
   * 建议按「谁该动手」分组：核心 bundle 的正确动作是修 DSH 安装，
   * 第三方 bundle 才是 pnpm add。混在一起给一条 pnpm 建议，
   * 对 `@deepseek-ai/dsh-base` 是**错误且有害**的指引（双实例/代次冲突）。
   */
  const bundlesHint = [];
  if (bundleState.reallyMissing.length) {
    const core = bundleState.reallyMissing.filter((b) => isCoreBundle(b.name));
    const third = bundleState.reallyMissing.filter((b) => !isCoreBundle(b.name));
    if (core.length) {
      bundlesHint.push(`缺失：${nameList(core)}。它们随 DSH 安装提供，不要往 profile 里装`
        + '（会与安装自带的那份冲突），请修复或重装 DeepSeek Harness。');
    }
    if (third.length) {
      bundlesHint.push(`缺失：${nameList(third)}；在 profile 目录执行 pnpm add <包名>@<与 DSH 一致的版本>。`
        + '注意版本必须对齐——装错代次会连 peer 依赖一起错。');
    }
  }
  if (bundleState.brokenLinks.length) {
    bundlesHint.push(`安装链接已失效：${nameList(bundleState.brokenLinks)}（指向的临时目录已被清理）。`
      + '重装该 bundle 即可；dsh 仍能正常启动就不用管。');
  }
  if (bundleState.unverified.length) {
    bundlesHint.push(`无法确认：${nameList(bundleState.unverified)}。`
      + '当前安装布局无法从磁盘确认（app.asar 不可读，或运行时里没有 node_modules）'
      + '—— 这不等于缺失，dsh 能正常启动就不用处理。');
  }
  if (bundleState.missingOptional.length) {
    bundlesHint.push(`可选实验 bundle 未安装：${nameList(bundleState.missingOptional)}。`
      + '它们各自对应一项实验功能，不装不影响基础模型路由。'
      + '若要安装：先在 profile 目录备份 package.json 与 pnpm-lock.yaml，再执行 pnpm add <包名>@<与 DSH 一致的版本>。');
  }
  push('bundles', 'profile bundles', bundleState.status, bundlesDetail, bundlesHint.join(' '));

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
