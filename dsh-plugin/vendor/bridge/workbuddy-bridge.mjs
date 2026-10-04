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
import { createServer } from 'node:http';
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
let memoryAuth = null; // refreshed in-process; the desktop file is never rewritten

function resolveWorkBuddyExe() {
  if (process.env.WORKBUDDY_APP_EXECUTABLE) return process.env.WORKBUDDY_APP_EXECUTABLE;
  const candidates = [
    'E:\\App\\WorkBuddy\\WorkBuddy.exe',
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs', 'WorkBuddy', 'WorkBuddy.exe'),
    process.env.ProgramFiles && join(process.env.ProgramFiles, 'WorkBuddy', 'WorkBuddy.exe'),
    process.env['ProgramFiles(x86)'] && join(process.env['ProgramFiles(x86)'], 'WorkBuddy', 'WorkBuddy.exe'),
    '/Applications/WorkBuddy.app/Contents/MacOS/WorkBuddy',
    '/Applications/WorkBuddy AI.app/Contents/MacOS/WorkBuddy',
    '/opt/WorkBuddy/workbuddy',
  ].filter(Boolean);
  return candidates.find((p) => existsSync(p)) || candidates[0];
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

/** The 32-byte field key, derived from the app's own key payload. */
function atRestKey() {
  if (!atRestKeyCache) {
    const script =
      "try{process.stdout.write(process._linkedBinding('electron_browser_workbuddy_storage').loggerGet())}"
      + 'catch(e){process.exitCode=3;process.stderr.write(String((e&&e.message)||e))}';
    const res = spawnSync(resolveWorkBuddyExe(), ['-e', script], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      // stdin MUST be ignored: the Electron binary fails with EBUSY when a
      // pipe is opened for it, so only stdout/stderr may be piped.
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 20000,
      windowsHide: true,
      maxBuffer: 1048576,
      encoding: 'utf8',
    });
    if (res.error) throw new Error(`key fetch failed: ${res.error.message}`);
    if (res.status !== 0) {
      throw new Error(`key fetch failed (exit ${res.status}): ${String(res.stderr || '').trim()}`);
    }
    const secret = JSON.parse(res.stdout).atRestSecretKey;
    if (typeof secret !== 'string' || secret === '') {
      throw new Error('at-rest key payload carries no atRestSecretKey');
    }
    // The app hashes the base64 STRING, not its decoded bytes.
    atRestKeyCache = createHash('sha256').update(secret, 'utf8').digest();
  }
  return atRestKeyCache;
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
      log('refresh failed', res.status, JSON.stringify(body)?.slice(0, 200));
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
 * The WorkBuddy gateway (copilot.tencent.com) rejects the OpenAI-spec `developer`
 * 400 code 11128 "Illegal API invocation from an unapproved channel"。
 * role outright (400 code 11128). Newer OpenAI-spec clients carry the system
 * prompt in `developer`, while the official client only ever sends `system`.
 */
function normalizePayload(payload) {
  const messages = payload.messages;
  if (!Array.isArray(messages) || messages.length === 0) return payload;

  let rewritten = 0;
  const fixed = messages.map((m) => {
    if (m && (m.role === 'developer' || m.role === 'Developer')) {
      rewritten++;
      return { ...m, role: 'system' };
    }
    return m;
  });

  // 首条必须是 system：国际版网关会以 `400 code 11128 first message is not
  // system prompt` 直接拒绝纯 user 开头的请求，而不少客户端（含自带的
  // 「对话测试」和只发单轮的 CLI）并不发 system。
  let prepended = 0;
  const first = fixed[0];
  if (!first || (first.role !== 'system' && first.role !== 'System')) {
    fixed.unshift({ role: 'system', content: 'You are a helpful assistant.' });
    prepended = 1;
  }

  if (!rewritten && !prepended) return payload;
  if (rewritten) log(`normalize: rewrote ${rewritten} developer message(s) -> system`);
  if (prepended) log('normalize: prepended a system message (upstream requires one first)');
  return { ...payload, messages: fixed };
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
  if (model) h['X-Model-ID'] = model;
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
async function callUpstream(bodyString, model, conversationId, clientSignal) {
  // API-key mode needs no login file; supply a minimal endpoint/domain instead
  let auth = API_KEY
    ? { endpoint: EXPLICIT_ENDPOINT || 'https://copilot.tencent.com', domain: (EXPLICIT_ENDPOINT || '').includes('codebuddy.ai') ? 'www.codebuddy.ai' : 'www.codebuddy.cn', access: '', refresh: '', expiresAt: 0 }
    : readStoredAuth();
  if (!API_KEY && auth.refresh && auth.expiresAt - REFRESH_SKEW_MS < Date.now()) {
    const next = await refreshAuth(auth);
    if (next) auth = next;
  }

  const send = (a) => fetch(`${a.endpoint}${CHAT_PATH}`, {
    method: 'POST',
    headers: buildHeaders(a, model, conversationId),
    body: bodyString,
    signal: clientSignal
      ? AbortSignal.any([clientSignal, ...(UPSTREAM_TIMEOUT_MS ? [AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)] : [])])
      : (UPSTREAM_TIMEOUT_MS ? AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) : undefined),
  });

  let res = await send(auth);
  if (!API_KEY && (res.status === 401 || res.status === 403) && auth.refresh) {
    const next = await refreshAuth(auth);
    if (next) { auth = next; res = await send(auth); }
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
    res = await send(auth);
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
/** 上次与账本文件同步后的字节数，用来发现「文件被外部清空 / 删除」。 */
let usageBytes = 0;

/** 账本位置：与脚本同目录（即 bridge/），可用环境变量覆盖。 */
function usageFile() {
  return process.env.WORKBUDDY_USAGE_FILE
    || join(dirname(fileURLToPath(import.meta.url)), 'usage.jsonl');
}

function loadUsageLines(file) {
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  usageLines = text.split('\n').filter(Boolean);
  usageBytes = Buffer.byteLength(text);
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

function recordRequest(entry) {
  try {
    const file = usageFile();
    if (usageLines === null) {
      loadUsageLines(file);
    } else {
      // 文件被手工删除 / 清空（或走「清空账本」）时，内存副本必须作废：
      // 否则累计到上限做整块重写时，已清掉的历史会被原样写回去。
      let size = 0;
      try { size = existsSync(file) ? statSync(file).size : 0; } catch { size = 0; }
      if (size < usageBytes) loadUsageLines(file);
    }

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
}

/** 读账本原始行（解析失败的行直接跳过）。 */
function readUsageRows() {
  const file = usageFile();
  try {
    if (!existsSync(file)) return [];
    return readFileSync(file, 'utf8').split('\n').filter(Boolean)
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
let catalogCache = { at: 0, models: [], shape: null };
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

async function fetchCatalog() {
  // 是否**真的**从上游取到了目录。下面 FEATURED 补全会让 merged 永远非空，
  // 所以不能靠「目录非空」判断这次抓取成没成功。
  let upstreamOk = false;
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
      catalogCache = {
        at: Date.now(),
        models: models
          .filter((m) => m.supportsToolCall !== false
            && !/^(codewise|hunyuan-image)/.test(m.id)
            && !isNonChatModel(m))
          .map((m) => ({
            id: m.id,
            name: m.name || m.id,
            context: m.maxInputTokens,
            maxOutput: m.maxOutputTokens,
            images: !!m.supportsImages,
            credits: m.credits,
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
// 触发点在 /v1/chat/completions 开头，**fire-and-forget**：先转发请求、
// 后台补签，绝不阻塞或拖慢这次调用。
const AUTO_CHECKIN_COOLDOWN_MS = Number(process.env.WORKBUDDY_CHECKIN_COOLDOWN_MS || 3600000); // 失败后冷却 1 小时再试
const AUTO_CHECKIN_MAX_PER_DAY = 3;       // 当天最多试 3 次，避免对上游打无效请求
let autoCheckinDay = '';                  // 「今天已尝试」的本地日期
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
      log('auto checkin', autoCheckinState.result, msg);
    } finally {
      autoCheckinInflight = null;
    }
  })();
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
const readBody = (req) => new Promise((resolve, reject) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  req.on('error', reject);
});

const json = (res, status, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (LOCAL_TOKEN && req.headers.authorization !== `Bearer ${LOCAL_TOKEN}`) {
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
      const raw = await readBody(req);
      let payload;
      try { payload = JSON.parse(raw); } catch { return json(res, 400, { error: { message: 'invalid JSON body' } }); }
      const wantStream = payload.stream === true;
      const model = payload.model || 'deepseek-v4.1-flash';
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
      const usageOf = (u) => ({
        promptTokens: Number(u?.prompt_tokens) || 0,
        completionTokens: Number(u?.completion_tokens) || 0,
        // 上游在 usage 里回报本次实际扣减的积分，一并记进本地账本（只记数字）
        ...(typeof u?.credit === 'number' ? { credit: u.credit } : {}),
      });

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
          });
          const reader = up.body.getReader();
          const decoder = new TextDecoder();
          let usageSeen = null;
          // 逐行解析，不用正则：上游的 usage 里含 completion_tokens_details /
          // prompt_tokens_details 这类**嵌套对象**，`\{[^{}]*\}` 根本匹配不上，
          // 结果是流式请求的 token 与扣分全被记成 0。
          let tail = '';
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
          } catch (e) { log('stream interrupted', e.message); }
          recordRequest({ model, stream: true, ok: true, ms: Date.now() - startedAt, ...usageOf(usageSeen) });
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

    if (url.pathname === '/' ) {
      return json(res, 200, {
        service: 'workbuddy-bridge',
        usage: 'POST /v1/chat/completions · GET /v1/models · GET /v1/usage · GET /v1/requests · GET /v1/quota · GET /v1/checkin · GET /health',
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
  console.log(`models     : ${FEATURED.map((m) => m.id).join(', ')}  (all models: /v1/models?all=1)`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { console.log('\nworkbuddy-bridge stopped'); process.exit(0); });
}
