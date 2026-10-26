/**
 * 模型可见的工具 —— 让 agent 自己能问「桥怎么样 / 有哪些模型 / 花了多少」。
 *
 * ToolDefinition 契约（dsh tools 服务）：
 *   { name, description, parameters, output: { schema, render(args, value) }, execute(args, exec) }
 * 工具返回值必须是 JsonValue；模型看到的内容由 `output.render` 产出。
 * 这里统一用「返回格式化好的字符串 + render 成文本块」，好读也好测。
 */
import { humanDuration } from './models.mjs';
import { formatBytes, saveMediaFile } from './media-file.mjs';

/** 把一次调用包装成 TextBlock 数组。 */
const asText = (value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }];

/** 统一构造一个「返回文本报告」的工具。 */
function textTool({ name, description, parameters, execute, timeoutMs }) {
  return {
    name,
    description,
    parameters,
    output: { schema: { type: 'string' }, render: (_args, value) => asText(value) },
    execute,
    ...(timeoutMs ? { timeoutMs } : {}),
  };
}

const fmtTokens = (n) => (Number(n) >= 1000 ? `${(Number(n) / 1000).toFixed(1)}k` : String(Number(n) || 0));

/**
 * 模型给「图片输入」时可能出现的几种形状。
 *
 * 这是踩过的真实体验问题：工具层原先用
 *   `typeof item === 'string' && item.trim()`
 * 过滤参考图/首帧，非字符串**静默丢弃**。于是模型把首帧写成
 * `{ "path": "C:/x.png" }` 或 `{ "url": "https://…" }`（这在多模态协议里很常见）
 * 时，图片被悄悄扔掉 → 模式退化成文生视频 / 文生图 → **照常计费，但图根本没带上**。
 * 桥侧那条「未知字段一律 400」的防线拦不住这种情况，因为到达桥时字段已经是空数组了。
 *
 * 所以工具层现在负责**认形状**：认得出来的就取出字符串（含常见的 `path`/`url`/
 * `file_key`/`base64` 包装），认不出来的直接拒绝调用 —— 宁可让模型重发一次参数，
 * 也不能让它以为图带上了。
 *
 * @param {unknown} value
 * @param {string} field 用于错误文案的字段名
 * @returns {string} 归一化后的图片输入
 */
function imageInputString(value, field) {
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) throw new Error(`${field} 是空字符串；要么给一个有效的图片来源，要么不要传这个参数。`);
    return text;
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of ['path', 'file', 'url', 'file_key', 'fileKey', 'base64', 'data']) {
      const inner = value[key];
      if (typeof inner === 'string' && inner.trim()) {
        const text = inner.trim();
        // base64/data 裸串补成 data URI，否则桥会把它当成「相对路径」拒掉。
        // 但 `data` 这个键也可能是 URL/fileKey（多模态协议里两种写法都见过），
        // 只有既不像 URI 也不像 fileKey 时才按 base64 处理。
        const looksLikeRef = /^data:/i.test(text)
          || /^https?:\/\//i.test(text)
          || /^(?:bga|file)\//.test(text);
        if ((key === 'base64' || key === 'data') && !looksLikeRef) {
          const mime = typeof value.mime_type === 'string'
            ? value.mime_type
            : (typeof value.mimeType === 'string' ? value.mimeType : 'image/png');
          return `data:${mime};base64,${text}`;
        }
        return text;
      }
    }
    throw new Error(`${field} 是一个对象，但没有 path/url/file_key/base64/data 字段；`
      + '请直接传字符串（本地绝对路径 / 公网 https URL / data URI / miora fileKey）。');
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    throw new Error(`${field} 必须是字符串，收到的是 ${typeof value}。`);
  }
  throw new Error(`${field} 的取值无法识别；请传字符串（本地绝对路径 / 公网 https URL / data URI / miora fileKey）。`);
}

/**
 * 归一化 `images[]`（图生图）。
 *
 * 与 `imageInputString` 同一动机：任何一项认不出来都让整次调用失败，
 * 不留下「看起来成功、其实少带了图」的提交。
 */
function imageInputList(value, field) {
  if (value === undefined || value === null) return [];
  const list = Array.isArray(value) ? value : [value];
  const out = [];
  for (let index = 0; index < list.length; index += 1) {
    const item = list[index];
    if (item === undefined || item === null) continue;
    if (typeof item === 'string' && !item.trim()) continue; // 空串按「没给」处理（模型常填 ""）
    out.push(imageInputString(item, `${field}[${index}]`));
  }
  return out;
}

/**
 * 产物交付文案（视频 / 图片共用）。
 *
 * 默认只给 URL 并说明它会过期；用户传了 `save_to` 就**当场落盘**，回执给的是
 * 本地绝对路径 —— 那才是用户能双击打开、能拖进剪辑软件的东西。下载失败不抛错，
 * 而是把原因写进文案再退回 URL：产物已经生成、钱已经花了，绝不能因为
 * 「存不下来」就让这次查询看起来失败。
 *
 * @param {{ urls: string[], kind: 'video'|'image', id: string, saveTo?: unknown, mimeType?: string }} input
 */
async function describeArtifacts({ urls, kind, id, saveTo, mimeType }) {
  const noun = kind === 'image' ? '图片' : '视频';
  const list = urls.map((url) => `- ${url}`).join('\n');
  const wantSave = typeof saveTo === 'string' && saveTo.trim();
  if (!wantSave) {
    return `${noun}已生成。以下签名 URL 有时效，请尽快下载或转存：\n${list}\n`
      + '（要直接拿到不过期的文件，下次查询时传 save_to=<绝对路径>，工具会帮你下载到本地。）';
  }

  const saved = [];
  const failed = [];
  // 最多存 4 个：一次生成返回几十个产物时不该把工具调用拖成批量下载。
  // 整次落盘共享 120 秒预算：单文件也限 120 秒，4 个大视频不会把工具拖到
  // 宿主超时被杀（那会让用户只看到“查询失败”，却不知道文件已经下了一半）。
  const saveBudgetMs = 120_000;
  const saveStartedAt = Date.now();
  // 序号跟着**成功保存的个数**走：显式文件名下若第一个产物下载失败，
  // 第二个仍用用户给的原名，而不是莫名变成 -2。
  for (const url of urls.slice(0, 4)) {
    const remaining = saveBudgetMs - (Date.now() - saveStartedAt);
    if (remaining <= 0) {
      failed.push({ url, reason: '本次落盘的 120 秒预算已用完（产物较多/较大），可减少一次保存的产物再试' });
      continue;
    }
    try {
      const result = await saveMediaFile(
        { url, saveTo, id, kind, mimeType, index: saved.length },
        { timeoutMs: Math.min(120_000, remaining) },
      );
      saved.push(result);
    } catch (error) {
      failed.push({ url, reason: error?.message || String(error) });
    }
  }

  const lines = [];
  if (saved.length) {
    lines.push(`${noun}已生成，并已保存到本地（不会过期）：`);
    for (const item of saved) lines.push(`- ${item.path}（${formatBytes(item.bytes)}）`);
  }
  if (saved.length < urls.length) {
    lines.push(saved.length ? `另外 ${urls.length - saved.length} 个产物未保存：` : `${noun}已生成，但下载到本地失败：`);
    for (const item of failed) lines.push(`- ${item.reason}`);
    lines.push('以下签名 URL 仍可临时访问（有时效，请尽快处理）：');
    for (const url of urls) lines.push(`- ${url}`);
  }
  return lines.join('\n');
}

/**
 * 媒体接口错误 → 模型能直接转述给用户的话。
 * 提交失败最怕 agent 自动重试：那可能重复计费，所以文案必须明确“不要重提”。
 */
function mediaFailureText(error, { action = 'submit', label = '视频' } = {}) {
  const status = Number(error?.status) || 0;
  const code = String(error?.payload?.error?.code || error?.code || '');
  const upstreamCode = error?.payload?.error?.upstream_code;
  const retryAfter = Number(error?.retryAfter) || 0;
  const retryHint = retryAfter > 0 ? `约 ${retryAfter} 秒后` : '稍后';
  const message = String(error?.message || error || '').slice(0, 300);
  const noun = label;
  const statusTool = noun === '图片' ? 'workbuddy_image_status' : 'workbuddy_video_status';
  const actionText = action === 'submit' ? '提交' : '查询';
  if (code.endsWith('_NO_OUTPUT')) {
    return `任务已标记完成，但上游没有返回可下载的 https 产物。稍后再调用 ${statusTool} 查一次；`
      + '不要重新提交（会再扣一次积分）。';
  }
  if (code.endsWith('_KEY_RATE_LIMITED')) {
    return `申请临时 key 被 Miora 限流（${message || 'HTTP 429'}），生成任务尚未提交、不会计费。`
      + `${retryHint}直接重试即可，不需要查任务。`;
  }
  if (status === 413 || code.endsWith('_PAYLOAD_TOO_LARGE')) {
    return `${noun}请求体太大（图片 base64 内联会膨胀 1/3）：${message || 'HTTP 413'}。`
      + '改用 miora fileKey / 公网 https URL，或少带/压缩图片；不要原样重试。';
  }
  if (status === 409) {
    return '任务还没完成，所以没有可下载的产物。稍后再查一次；不要重新提交。';
  }
  if (status === 403) {
    if (code.endsWith('_LOCAL_TOKEN_REQUIRED') || /local token/i.test(message)) {
      return `${noun}接口只接受本地管理令牌（client key 仅聊天）。检查插件是否用 WORKBUDDY_LOCAL_TOKEN 连桥，或重启桥。`;
    }
    if (code.endsWith('_SCOPE_DENIED') || /scope|permission|not authorized/i.test(message)) {
      return `当前 WorkBuddy 账号没有${noun}生成权限（${message || '403'}）。换有权限的账号；不要重试。`;
    }
    return `${noun}请求被上游拒绝（${message || '403'}）。先确认账号权限与登录态，不要原样重试。`;
  }
  if (status === 401) {
    if (code.endsWith('_NO_CREDENTIAL')) {
      return `读不到 WorkBuddy 登录凭据：在 WorkBuddy 桌面端或插件里重新登录后重试。`;
    }
    return `${noun}请求失败：本地桥令牌或 WorkBuddy 登录态不可用。先确认桥在运行且已登录，再重试。`;
  }
  if (status === 429) {
    if (action === 'status') {
      return `${noun}查询被 Miora 限流：${message || 'HTTP 429'}。任务本身不受影响，`
        + `${retryHint}重试查询即可；不要重新提交。`;
    }
    return `${noun}提交被 Miora 限流：${message || 'HTTP 429'}。`
      + `任务可能已经创建：${retryHint}先调用 ${statusTool} 查已有任务，不要重复提交。`;
  }
  if (status === 400) {
    return `${noun}请求被拒绝${upstreamCode ? `（上游码 ${upstreamCode}）` : ''}：${message || '参数不合法'}。`
      + '按提示修改参数或内容，不要原样重试。';
  }
  if (status === 404) {
    return `没有找到这个${noun}任务：${message || 'unknown id'}。确认 id 来自${noun}提交工具的返回；`
      + '视频和图片的查询接口不互通（不要拿图片 id 查视频，反之亦然）；'
      + '如果中途切换过 WorkBuddy 账号，任务在提交时的账号下，切回原账号再查。';
  }
  if (/ECONNREFUSED|fetch failed|socket hang up/i.test(message)) {
    return `${noun}请求失败：本地桥未运行。先调用 workbuddy_bridge（action=start），再重试。`;
  }
  return `${noun}${actionText}失败：${message || '未知错误'}`
    + (action === 'submit'
      ? ' 如果这是超时/断线，任务可能已在上游创建：不要直接重提，先到 WorkBuddy 客户端确认本次任务。'
      : '');
}

/**
 * 状态查询的等待预算。
 *
 * 桥单次 `?wait` 上限 60 秒；视频实测 ~101 秒出片，一次 20 秒的查询通常不够。
 * 工具层把用户给的预算按 60 秒一段拆开（段间状态仍是 pending 就继续），
 * 默认 20 秒不变，最多 120 秒 —— 大多数视频能在一个工具调用里等到终态。
 */
const MAX_STATUS_WAIT_SECONDS = 120;
const STATUS_WAIT_CHUNK_SECONDS = 60;

function clampWaitSeconds(raw, fallback = 20) {
  // null / 空串在“模型没填”的语义下按默认值处理，不能因为 Number(null)=0
  // 变成立即返回（那会让“默认代等 20 秒”在模型传 null 时失效）。
  if (raw === undefined || raw === null || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), 0), MAX_STATUS_WAIT_SECONDS);
}

/**
 * 按用户预算查询状态；桥每段最多代等 60 秒。
 * 终态 / 预算用完就停止；每段使用固定的 chunk，不会无限追加。
 */
async function waitForMediaStatus(statusFn, id, waitSeconds, signal) {
  let remaining = waitSeconds;
  for (;;) {
    const chunk = Math.min(remaining, STATUS_WAIT_CHUNK_SECONDS);
    const media = await statusFn(id, { waitMs: chunk * 1000, signal });
    if (!media || media.status === 'completed' || media.status === 'failed' || media.status === 'cancelled') {
      return media;
    }
    if (remaining <= chunk) return media;
    remaining -= chunk;
  }
}

/**
 * 上游产物里的 miora fileKey。拿到它可以**直接**作为下一次图生图/图生视频的输入，
 * 不必再走 URL 下载 + base64 回传（更快，也不会被签名 URL 的时效卡住）。
 */
function mediaFileKeys(resultFiles) {
  if (!Array.isArray(resultFiles)) return [];
  const keys = [];
  for (const item of resultFiles) {
    const value = typeof item === 'string'
      ? item
      : (item?.fileKey || item?.file_key || item?.file?.fileKey || item?.file?.file_key);
    if (typeof value === 'string') {
      const key = value.trim();
      if (/^(?:bga|file)\//.test(key) && !keys.includes(key)) keys.push(key);
    }
  }
  return keys;
}

/**
 * 只有**图片**产物的 fileKey 能直接回流到 images[] / first_frame[]；
 * 视频产物的 fileKey 不是图片，别把它说成“可以当首帧”。
 */
function fileKeyLine(resultFiles, kind) {
  if (kind !== 'image') return '';
  const keys = mediaFileKeys(resultFiles);
  return keys.length ? `可复用的 miora fileKey（下次改图/图生视频直接作为输入，不用重新上传）：\n${keys.map((key) => `- ${key}`).join('\n')}` : '';
}

/** 上游的 mime 可能在顶层或 `{file:{…}}` 里；取第一个可用的。 */
function mediaMimeType(resultFiles) {
  if (!Array.isArray(resultFiles)) return '';
  for (const item of resultFiles) {
    const value = typeof item === 'string'
      ? ''
      : (item?.mimeType || item?.mime_type || item?.file?.mimeType || item?.file?.mime_type);
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

/**
 * 构造这套工具。
 *
 * @param {object} deps
 * @param {() => object} deps.snapshot 取运行态快照（桥状态 / 目录 / 配置）
 * @param {() => object} deps.supervisor 桥管理器
 * @param {() => object} deps.client 桥客户端
 * @param {() => object} deps.adapter 适配器（读目录缓存）
 * @param {(line: string) => void} deps.log
 */
export function createTools(deps) {
  const { snapshot, supervisor, consoleSupervisor, client, adapter } = deps;

  const statusTool = textTool({
    name: 'workbuddy_status',
    description:
      '查看本机 WorkBuddy 中转的当前状态：本地桥是否在运行、登录账号与令牌剩余有效期、积分余额、可用模型数量、dsh 侧模型路由是否注册成功、控制台地址。'
      + '排查「WorkBuddy 模型不出现在模型选择器里」时先调用它。'
      + '需要看逐条请求、趋势图、CSV、账号切换这类明细时，把控制台地址给用户。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute(_args, exec) {
      const state = await snapshot({ signal: exec?.signal });
      const lines = [];
      lines.push(`桥：${state.bridge.state === 'running' ? '运行中' : state.bridge.state === 'stopped' ? '未运行' : state.bridge.state}`);
      if (state.bridge.health) {
        const h = state.bridge.health;
        lines.push(`  地址：${state.config.bridgeUrl}/v1`);
        lines.push(`  PID：${h.pid}    已运行：${humanDuration(h.uptimeMs)}`);
        if (h.auth) {
          lines.push(`  账号：${h.auth.userId || '(未知)'}`);
          lines.push(`  令牌：${h.auth.expired ? '已过期（桥会在下次请求时续期）' : `剩余约 ${humanDuration(new Date(h.auth.expiresAt).getTime() - Date.now())}`}`);
        }
        lines.push(`  目录：${h.catalogSize ?? 0} 个模型${h.catalogAt ? `（更新于 ${h.catalogAt}）` : ''}`);
      } else if (state.bridge.error) {
        lines.push(`  说明：${state.bridge.error}`);
      }
      if (state.quota?.ok) {
        const q = state.quota;
        const bits = [];
        if (typeof q.total === 'number') bits.push(`总计 ${q.total}`);
        for (const p of q.packages || []) bits.push(`${p.name} ${p.remain}/${p.size}`);
        if (bits.length) {
          // 归属核对：积分的账号与桥当前账号不一致时必须提醒（换号后缓存尚未换新），
          // 否则 agent 会把 A 账号的余额当成 B 账号的报给用户
          if (state.quotaAccount && state.bridgeAccount && state.quotaAccount !== state.bridgeAccount) {
            lines.push(`积分：⚠ 以下积分属于上一个账号（缓存 ${String(state.quotaAccount).slice(0, 8)}…，桥当前 ${String(state.bridgeAccount).slice(0, 8)}…），正在自动重读`);
          } else {
            lines.push(`积分：${bits.join('，')}${state.quotaAccount ? `（账号 ${String(state.quotaAccount).slice(0, 8)}…）` : ''}`);
          }
        }
      } else if (state.quotaError) {
        lines.push(`积分：读取失败（${state.quotaError}）`);
      }
      lines.push(`模型：dsh 侧路由 ${state.route.registered ? '已注册' : '未注册'}（provider=${state.config.provider}），桥目录 ${state.directory.length} 个可用模型`);
      if (state.route.error) lines.push(`  注册失败：${state.route.error}`);
      /*
       * 搜索接入状态要在状态工具里可见：用户报「搜不到 / 401」时，agent 先看这里
       * 就能分清是 dsh 内置搜索没接桥，还是桥本身没登录，而不是盲猜。
       */
      const ws = state.webSearch;
      if (ws) {
        const ready = ws.ready === true || (ws.ready === undefined && ws.configured === true);
        lines.push(ready
          ? `网页搜索：已接入 WorkBuddy（dsh 内置搜索走桥${ws.lastVerifyFailed ? `；上次自检失败：${ws.lastVerifyError || '未知错误'}` : ''}）`
          : `网页搜索：dsh 内置搜索未接入 WorkBuddy（${ws.reason || 'unknown'}）${ws.auto?.status ? `；自动接入：${ws.auto.status}${ws.auto.reason ? `/${ws.auto.reason}` : ''}` : ''}`);
        if (!ready) {
          lines.push('  修法：插件概览的「网页搜索」卡点「一键接入」，或运行 /workbuddy websearch；');
          lines.push('  临时兜底：直接调用 `workbuddy_web_search` 工具，它不依赖 dsh 内置搜索配置。');
        }
      }
      const con = state.console || {};
      lines.push(`控制台：${con.state === 'running' ? `${con.url}（数据界面在这里：逐条请求 / 趋势图 / CSV / 账号切换 / 签到 / 诊断）` : `未运行${con.error ? `（${con.error}）` : ''}`}`);
      if (state.legacy?.found) lines.push(`注意：检测到旧的 llm-pi-ai workbuddy 路由（${state.legacy.files.join('、')}），与插件重复，建议清理。`);
      if (state.checkin?.status) {
        const c = state.checkin.status;
        lines.push(`签到：${c.todayCheckedIn ? '今日已签' : '今日未签'}${typeof c.streakDays === 'number' ? `，连续 ${c.streakDays} 天` : ''}`);
      }
      return lines.join('\n');
    },
  });

  const modelsTool = textTool({
    name: 'workbuddy_models',
    description:
      '列出本机 WorkBuddy 中转当前可用的对话模型（本机已登录账号能真正调用的那些），含上下文长度、单次输出上限与消耗倍率。'
      + '需要给用户推荐模型、或确认某个模型 ID 是否可用时调用。',
    parameters: {
      type: 'object',
      properties: {
        refresh: { type: 'boolean', description: 'true 时强制重新向上游拉取目录（默认用缓存，约 1 分钟内有效）' },
        filter: { type: 'string', description: '可选的模型 ID 子串过滤，例如 "glm" 或 "deepseek"' },
      },
      additionalProperties: false,
    },
    async execute(args, exec) {
      const refresh = args?.refresh === true;
      const needle = typeof args?.filter === 'string' ? args.filter.toLowerCase() : '';
      const catalog = await adapter.catalog({ refresh }).catch((error) => { throw new Error(`读取模型目录失败：${error?.message || error}`); });
      void exec;
      const list = catalog
        .filter((m) => m && typeof m.id === 'string')
        .filter((m) => !needle || m.id.toLowerCase().includes(needle) || String(m.name || '').toLowerCase().includes(needle));
      if (!list.length) return needle ? `没有匹配 "${needle}" 的模型。` : '桥没有返回任何可用模型（先确认桥在运行，且已在「账号」页完成桌面端或插件登录）。';
      const lines = [`共 ${list.length} 个可用模型：`];
      for (const m of list) {
        const bits = [];
        if (m.context_window) bits.push(`上下文 ${fmtTokens(m.context_window)}`);
        if (m.max_output_tokens) bits.push(`输出上限 ${fmtTokens(m.max_output_tokens)}`);
        if (typeof m.credits === 'number') bits.push(m.credits === 0 ? '免费' : `倍率 ${m.credits}`);
        if (m.supports_images) bits.push('支持图片');
        // 推理能力与实测档位：面板与 CSV 都有，工具原先没有 —— 同一份目录两处口径
        if (m.supports_reasoning) {
          const efforts = Array.isArray(m.reasoning_efforts) ? m.reasoning_efforts : null;
          bits.push(efforts === null
            ? '推理（档位未实测）'
            : (efforts.length ? `推理（${efforts.length} 档：${efforts.join('/')}）` : '推理（网关暂未接）'));
        }
        // 当前正在生效的促销（夜间免费 / 夜间折扣）：倍率已经是折后值，
        // 这行让 agent 能解释“为什么现在是免费/0.395”。
        if (m.promotion_active === true && m.badge) bits.push(`促销 ${m.badge}（进行中）`);
        // 上游的 vendor 是单字母内部代号（f/e），对用户没有意义，不显示
        lines.push(`- ${m.id}（${m.name || m.id}）：${bits.join('，')}`);
      }
      lines.push('', '在 dsh 里选择模型时，provider 选 “WorkBuddy” 即可看到这些模型。');
      return lines.join('\n');
    },
  });

  const usageTool = textTool({
    name: 'workbuddy_usage',
    description: '查看本机 WorkBuddy 中转的本地调用账本：最近若干天的调用次数、token 数、消耗积分与失败数，以及积分花在哪些模型上。',
    parameters: {
      type: 'object',
      properties: {
        days: { type: 'integer', description: '统计最近多少天，1–90，默认 7' },
      },
      additionalProperties: false,
    },
    async execute(args) {
      const days = Math.min(Math.max(Number(args?.days) || 7, 1), 90);
      const usage = await client.usage({ days });
      const total = usage?.total || {};
      const videos = Number(total.videos) || 0;
      const videoFailed = Number(total.videoFailed) || 0;
      const images = Number(total.images) || 0;
      const imageFailed = Number(total.imageFailed) || 0;
      const videoCredit = Number(total.videoCredit) || 0;
      const videoCreditKnown = Number(total.videoCreditKnown) || 0;
      const imageCredit = Number(total.imageCredit) || 0;
      const imageCreditKnown = Number(total.imageCreditKnown) || 0;
      const genBits = [];
      if (videos || videoFailed) {
        genBits.push(`视频提交 ${videos} 次${videoFailed ? `（失败 ${videoFailed}）` : ''}`
          + `${videoCreditKnown ? `，估算消耗 ${videoCredit.toFixed(2)} 积分` : ''}`);
      }
      if (images || imageFailed) {
        genBits.push(`图片提交 ${images} 次${imageFailed ? `（失败 ${imageFailed}）` : ''}`
          + `${imageCreditKnown ? `，估算消耗 ${imageCredit.toFixed(2)} 积分` : ''}`);
      }
      const videoText = genBits.length ? `，${genBits.join('，')}` : '';
      const lines = [`最近 ${days} 天：调用 ${total.calls || 0} 次，失败 ${total.failed || 0} 次${videoText}，`
        + `输入 ${fmtTokens(total.promptTokens)} / 输出 ${fmtTokens(total.completionTokens)} tokens，`
        + `消耗积分 ${typeof total.credit === 'number' ? total.credit.toFixed(2) : '0'}，平均耗时 ${total.calls ? Math.round((total.ms || 0) / total.calls) : 0} ms`];
      const models = (usage?.models || []).slice(0, 12);
      if (models.length) {
        lines.push('', '按模型：');
        for (const m of models) {
          lines.push(`- ${m.model}：${m.calls} 次，积分 ${typeof m.credit === 'number' ? m.credit.toFixed(2) : '0'}，tokens ${fmtTokens((m.promptTokens || 0) + (m.completionTokens || 0))}`);
        }
      }
      return lines.join('\n');
    },
  });

  const checkinTool = textTool({
    name: 'workbuddy_checkin',
    description: '查看 WorkBuddy 每日签到状态与连续天数；claim=true 时立即领取当日签到积分。',
    parameters: {
      type: 'object',
      properties: {
        claim: { type: 'boolean', description: 'true = 立即领取今日签到（会消耗一次上游请求）' },
      },
      additionalProperties: false,
    },
    async execute(args, exec) {
      const claim = args?.claim === true;
      // 桥当前账号（用于归属标注）。**容错取**：快照失败不应炸掉签到主流程，
      // 那样归属提示最多缺席一行。
      const state = await snapshot({ signal: exec?.signal }).catch(() => ({}));
      // 桥凭据异常（degraded）时 checkin 接口会回 502 —— 把它转成可读的
      // 修法提示，而不是向 agent 抛裸异常（那只会显示一个无上下文的错误码）。
      let result;
      try {
        result = await client.checkin({ claim, signal: exec?.signal });
      } catch (error) {
        if (error?.status === 502 || /login|sign in|accessToken|凭据|登录/i.test(String(error?.message))) {
          return `签到不可用：读不出 WorkBuddy 登录凭据（${error.message || 'HTTP ' + error.status}）。\n修法：到插件「账号」页重新登录（桌面端或插件登录均可），然后重试。`;
        }
        if (error?.status === 401) {
          return '签到不可用：本地令牌与桥不一致（检查 .env 的 WORKBUDDY_LOCAL_TOKEN，或重启桥）。';
        }
        throw error;
      }
      const status = result?.status || {};
      const lines = [];
      if (claim) {
        lines.push(result?.ok === false ? `签到失败：${result.error || '未知原因'}` : '已尝试领取今日签到。');
      }
      lines.push(`今日：${status.todayCheckedIn ? '已签到' : '未签到'}${typeof status.todayCredit === 'number' ? `（今日获得 ${status.todayCredit}）` : ''}`);
      if (typeof status.streakDays === 'number') lines.push(`连续签到：${status.streakDays} 天`);
      if (result?.auto) lines.push(`自动签到：${result.auto.auto ? '开启' : '关闭'}${result.auto.lastError ? `，上次失败：${result.auto.lastError}` : ''}`);
      // 归属标注：签到状态与积分一样是账号视角的数据 —— 与桥当前账号不一致时说明
      if (result?.account && state.bridgeAccount && result.account !== state.bridgeAccount) {
        lines.push(`⚠ 以上签到状态属于上一个账号（缓存 ${String(result.account).slice(0, 8)}…，桥当前 ${String(state.bridgeAccount).slice(0, 8)}…），正在自动重读`);
      }
      return lines.join('\n');
    },
  });

  /*
   * 兜底搜索工具（issue #7）。
   *
   * dsh 的内置网页搜索是**宿主配置**：它可能仍指向 DeepSeek、key 失效、或者
   * 被用户换成了别的后端。用户问的是「插件为什么不能像 WorkBuddy 一样搜」——
   * 除了自动把宿主配置接过来，还必须给 agent 一条不依赖宿主配置的路：
   * 直接打桥的 `/v1/web_search`，用 WorkBuddy 自己的搜索额度。
   */
  const webSearchTool = textTool({
    name: 'workbuddy_web_search',
    description:
      '用 WorkBuddy 原生网页搜索查资料（不经过 DeepSeek，不需要 DeepSeek key）。'
      + '当 dsh 内置网页搜索报错（例如 401 / api key invalid）、提示未接入，或你想确保搜索走 WorkBuddy 额度时，用这个工具兜底。'
      + '返回标题、链接与摘要；需要正文时再对结果 URL 做抓取。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索词，至少 2 个字符' },
        max_results: { type: 'integer', minimum: 1, maximum: 10, description: '返回条数，默认 5' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    timeoutMs: 60_000,
    async execute(args, exec) {
      const query = typeof args?.query === 'string' ? args.query.trim() : '';
      if (query.length < 2) throw new Error('query 至少需要 2 个字符');
      const rawMax = Number(args?.max_results);
      const maxResults = Number.isFinite(rawMax) ? Math.min(Math.max(Math.trunc(rawMax), 1), 10) : 5;
      let result;
      try {
        result = await client.webSearch({ query, maxResults, signal: exec?.signal });
      } catch (error) {
        if (error?.status === 401) {
          throw new Error('网页搜索失败：本地桥令牌与插件不一致。先重启桥；仍失败就检查 WORKBUDDY_LOCAL_TOKEN。', { cause: error });
        }
        if (error?.status === 429) {
          return `WorkBuddy 搜索被限流了（${error.message || 'HTTP 429'}）。等一会儿再试，或减少搜索次数。`;
        }
        if (/ECONNREFUSED|fetch failed|socket hang up/i.test(String(error?.message || ''))) {
          return '网页搜索失败：本地桥未运行。先调用 workbuddy_bridge（action=start），再重试。';
        }
        throw new Error(`网页搜索失败：${error?.message || error}`, { cause: error });
      }
      const results = Array.isArray(result?.results) ? result.results : [];
      if (!results.length) return `WorkBuddy 没有搜到与「${query}」相关的结果。换个关键词或英文关键词再试。`;
      const lines = [`WorkBuddy 网页搜索（${result.provider || 'workbuddy'}）：${results.length} 条`];
      results.forEach((item, index) => {
        lines.push(`${index + 1}. ${item.title || item.url}`);
        lines.push(`   ${item.url}`);
        if (item.snippet) lines.push(`   ${item.snippet}`);
      });
      return lines.join('\n');
    },
  });

  /*
   * 视频生成工具（Miora）。
   *
   * 视频是**高积分计费**能力，而且上游是异步任务：提交只返回任务 id，
   * 生成可能持续几分钟。所以拆成 submit / status 两个工具，避免一次工具调用
   * 阻塞十几分钟；同时用文案明确“同一需求不要重复提交”，防止 agent 自动重试
   * 造成重复扣费。
   */
  const videoSubmitTool = textTool({
    name: 'workbuddy_generate_video',
    description:
      '用 WorkBuddy 的 Miora 生成视频：支持文生视频、首帧（可选尾帧）生视频、参考图生视频。'
      + '这是高积分计费操作，**只在用户明确要求生成视频时调用**；同一需求只提交一次。'
      + '提交是异步的：本工具返回任务 id，之后用 workbuddy_video_status 查询；'
      + '不要因为等待时间长就重复提交（会重复扣费）。'
      + '图片输入（first_frame / last_frame / references[]）请**传字符串**：'
      + '本地绝对路径、公网 https URL、data URI 或 miora fileKey。'
      + '如果上游返回了 fileKey，后续图生视频优先复用它（不必重新上传）。'
      + '多张图以 base64 内联时合计受桥请求体限制（默认 32 MB）；超了会提示改用 fileKey/URL。'
      + '参数会严格校验：拼错的键（如 size / image）会直接返回 400，而不是被忽略后按文生视频计费。',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '视频描述；文生视频/参考图必填，首尾帧模式可选（描述运动与镜头）' },
        mode: { type: 'string', enum: ['text', 'frame', 'reference'], description: '不传时按输入自动推断' },
        first_frame: {
          type: 'string',
          description: '起始帧（字符串）：绝对本地路径 / 公网 https URL / data URI / miora fileKey',
        },
        last_frame: { type: 'string', description: '结束帧（可选，字符串），格式同 first_frame' },
        references: {
          type: 'array',
          items: { type: 'string' },
          description: '参考图（字符串数组，一张或多张），格式同 first_frame',
        },
        duration: { type: 'integer', minimum: 1, description: '目标时长（正整数秒）。本次实测支持 4–15 秒，3 秒会被上游拒绝' },
        resolution: { type: 'string', description: '分辨率。本次实测支持 768P / 2K（大小写不敏感），720p 会被上游拒绝' },
        aspect_ratio: { type: 'string', description: '画幅，如 16:9 / 9:16 / 1:1' },
        save_to: {
          type: 'string',
          description: '可选：绝对路径（目录或完整文件名）。上游同步完成时直接落盘并返回文件路径；'
            + '异步任务仍用 workbuddy_video_status 的 save_to 下载',
        },
      },
      additionalProperties: false,
    },
    timeoutMs: 410_000,
    async execute(args, exec) {
      /*
       * 先把图片输入归一化。这一步**在调用桥之前**做，且失败就直接返回说明：
       * 原先用 `typeof === 'string'` 静默过滤，模型把 first_frame 写成
       * `{path: …}` 时图片被丢掉，请求退化成文生视频却照样计费。
       */
      let firstFrame;
      let lastFrame;
      let references;
      try {
        firstFrame = args?.first_frame === undefined || args.first_frame === null
          ? ''
          : imageInputString(args.first_frame, 'first_frame');
        lastFrame = args?.last_frame === undefined || args.last_frame === null
          ? ''
          : imageInputString(args.last_frame, 'last_frame');
        references = imageInputList(args?.references, 'references');
      } catch (error) {
        return `视频参数无法识别，没有提交（未计费）：${error.message}
修法：图片输入统一用字符串（本地绝对路径 / 公网 https URL / data URI / miora fileKey），然后原样重试本次提交。`;
      }
      if (args?.prompt !== undefined && args?.prompt !== null && typeof args.prompt !== 'string') {
        return '视频 prompt 必须是字符串；这次没有提交（未计费）。';
      }
      let video;
      try {
        video = await client.videoSubmit({
          prompt: typeof args?.prompt === 'string' ? args.prompt : '',
          // 显式给了但类型不对时**透传给桥**，让桥的严格校验报 400；
          // 这里如果按 typeof 过滤，会把“resolution: 1080”静默变成默认分辨率。
          mode: args?.mode ?? '',
          firstFrame,
          lastFrame,
          references,
          duration: args?.duration,
          resolution: args?.resolution ?? '',
          aspectRatio: args?.aspect_ratio ?? '',
          signal: exec?.signal,
        });
      } catch (error) {
        return mediaFailureText(error, { action: 'submit', label: '视频' });
      }
      const summary = `任务：${video.id}；状态：${video.status}（上游：${video.upstream_status || '-'}）；`
        + `模式：${video.mode || '-'}`
        + `${video.seconds ? `；时长：${video.seconds}s` : ''}`
        + `${video.resolution ? `；分辨率：${video.resolution}` : ''}`
        + `${video.aspect_ratio ? `；画幅：${video.aspect_ratio}` : ''}`
        + `${video.model ? `；模型：${video.model}` : ''}`;
      /*
       * 上游可能同步完成（mode=sync）：结果/失败原因就在这次响应里，按 id 再查
       * 只会得到 INVALID_TASK_ID_FOR_SYNC_MODE。这类终态必须在这里讲清楚，
       * 不能再说“已提交，稍后查询”。
       */
      if (video.status === 'completed') {
        const urls = Array.isArray(video.output?.urls) ? video.output.urls : [];
        const lines = [
          video.sync ? '视频已生成（上游同步返回完成）。' : '视频已生成（上游返回完成）。',
          summary,
          '本次提交按 WorkBuddy 账号积分计费（以余额为准）。',
        ];
        if (urls.length) {
          lines.push(await describeArtifacts({
            urls, kind: 'video', id: video.id, saveTo: args?.save_to, mimeType: mediaMimeType(video.result_files),
          }));
        } else if (video.sync) {
          lines.push('上游同步标记完成，但没有返回可下载的 https 产物；这个任务按 id 查不到更多信息。'
            + '不要再按 id 重查；需要产物请向用户确认后重新生成（会再次计费）。');
        } else {
          lines.push('上游标记完成，但这次响应没有可下载的 https 产物。稍后可用 workbuddy_video_status 再查一次（查询不计费）。');
        }
        lines.push('同一需求不要重复生成（会再次计费）。');
        return lines.join('\n');
      }
      if (video.status === 'failed' || video.status === 'cancelled') {
        const lines = [
          video.status === 'cancelled'
            ? (video.sync ? '视频任务已取消（上游同步返回）。' : '视频任务已取消。')
            : (video.sync ? '视频生成失败（上游同步返回失败）。' : '视频生成失败。'),
          summary,
          `原因：${video.error?.message || '上游未给失败原因'}`,
          '本次没有可交付产物。不要原样重提；先和用户确认是否调整参数/内容，再决定是否重新生成（会再次计费）。',
        ];
        return lines.join('\n');
      }
      const lines = [
        `已提交视频任务：${video.id}`,
        summary,
        '提交成功即按 WorkBuddy 账号积分计费。同一需求不要再提交一次。',
        `生成是异步的，稍后用 workbuddy_video_status 查询（id=${video.id}，可一次代等最多 120 秒）；completed 后把返回的 URL 交给用户。`,
      ];
      if (args?.save_to) {
        lines.push('本次 save_to 只对“提交时已同步完成”的产物生效；异步任务完成后再查状态时请再传一次 save_to。');
      }
      return lines.join('\n');
    },
  });

  const videoStatusTool = textTool({
    name: 'workbuddy_video_status',
    description:
      '查询 workbuddy_generate_video 提交的视频任务状态。'
      + '默认会在本工具里等待最多 20 秒、可用 wait_seconds 最高 120 秒（桥代轮询），通常能直接拿到 completed；'
      + 'queued/in_progress 时告诉用户还在生成，稍后再查，**不要重新提交**；'
      + 'completed 时返回有时效的下载 URL；failed/cancelled 时返回失败原因。'
      + '产物是**会过期**的签名 URL：要交付给用户时请传 save_to（绝对路径，目录或文件），'
      + '工具会把视频下载到本地并返回真实文件路径 —— 否则链接过期后只能重新生成（再扣一次积分）。'
      + '一次调用最多保存前 4 个产物，其余仍返回 URL。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '提交视频时返回的任务 id（upstreamTaskId）' },
        wait_seconds: {
          type: 'integer',
          minimum: 0,
          maximum: 120,
          description: '在本工具内等待多少秒再返回（0 = 立即返回；默认 20，最大 120；'
            + '内部按桥的 60 秒一段轮询，视频通常一次就能等到终态）',
        },
        save_to: {
          type: 'string',
          description: '可选：绝对路径（目录或完整文件名）。给定时把产物下载到本地并返回文件路径，'
            + '目录会自动创建；不给则只返回签名 URL',
        },
      },
      required: ['id'],
      additionalProperties: false,
    },
    // 查询最多等 180 秒（60+60 两段 + 查询余量），落盘再预留 120 秒。
    timeoutMs: 330_000,
    async execute(args, exec) {
      const id = typeof args?.id === 'string' ? args.id.trim() : '';
      if (!id) throw new Error('id 不能为空：请传 workbuddy_generate_video 返回的任务 id');
      const waitSeconds = clampWaitSeconds(args?.wait_seconds);
      let video;
      try {
        video = await waitForMediaStatus(
          (taskId, options) => client.videoStatus(taskId, options),
          id,
          waitSeconds,
          exec?.signal,
        );
      } catch (error) {
        return mediaFailureText(error, { action: 'status', label: '视频' });
      }
      const lines = [
        `任务 ${id}：${video.status}（上游：${video.upstream_status || '-'}）`,
        `模式：${video.mode || '-'}${video.seconds ? `；时长：${video.seconds}s` : ''}`
          + `${video.resolution ? `；分辨率：${video.resolution}` : ''}`
          + `${video.aspect_ratio ? `；画幅：${video.aspect_ratio}` : ''}`,
      ];
      if (video.created_at) {
        lines.push(`提交时间：${new Date(video.created_at * 1000).toISOString()}`);
      }
      if (video.status === 'completed') {
        const urls = Array.isArray(video.output?.urls) ? video.output.urls : [];
        if (urls.length) {
          lines.push(await describeArtifacts({
            urls, kind: 'video', id, saveTo: args?.save_to, mimeType: mediaMimeType(video.result_files),
          }));
        } else if (video.sync) {
          lines.push('上游同步标记完成，但没有返回 https 产物。同步任务按 id 查不到更多信息；'
            + '不要再重查，需要产物请向用户确认后重新生成（会再次计费）。');
        } else {
          lines.push('上游标记完成，但没有返回 https 产物 URL。稍后再查一次，或到 WorkBuddy 客户端查看该任务。');
        }
      } else if (video.sync_result_unavailable
        || /INVALID_TASK_ID_FOR_SYNC_MODE/i.test(video.error?.message || '')) {
        lines.push('这次查询没有拿到结果：该任务在上游是**同步完成**的，结果只出现在提交响应里，'
          + '桥的短期缓存已不包含它（过期、重启，或当前不是提交时的账号）。'
          + '如果刚切换过账号，切回提交时的账号再查；不要把它当成普通失败反复重提，'
          + '需要产物时请向用户确认后重新生成（会再次计费）。');
      } else if (video.status === 'failed' || video.status === 'cancelled') {
        lines.push(video.status === 'cancelled'
          ? '任务已取消（不是生成失败）：没有产物。'
          : `任务未成功：${video.error?.message || '上游未给失败原因'}`);
        if (video.sync) lines.push('（该任务是上游同步完成的，结果来自提交缓存。）');
        lines.push('不要直接重复提交；先确认失败原因/用户意愿，必要时再生成。');
      } else {
        lines.push(waitSeconds > 0
          ? `仍在生成（本次最多等待约 ${waitSeconds} 秒）。稍后再调用本工具查询；不要重新提交，否则会重复计费。`
          : '仍在生成。稍后再调用本工具查询；不要重新提交，否则会重复计费。');
      }
      return lines.join('\n');
    },
  });

  /*
   * 图片生成工具（Miora）。
   *
   * 与视频同一套纪律：提交只拿任务 id、不阻塞等出图；文案明确高积分计费且
   * 禁止同一需求重复提交（会重复扣费）。
   */
  const imageSubmitTool = textTool({
    name: 'workbuddy_generate_image',
    description:
      '用 WorkBuddy 的 Miora 生成图片：只给 prompt 是文生图；同时给 images[] 就是图生图（按指令改图）。'
      + '这是高积分计费操作，**只在用户明确要求生成/修改图片时调用**；同一需求只提交一次。'
      + '提交是异步的：本工具返回任务 id，之后用 workbuddy_image_status 查询；'
      + '不要因为等待时间长就重复提交（会重复扣费）。'
      + '图片输入请**传字符串**：本地绝对路径、公网 https URL、data URI 或 miora fileKey。'
      + '如果上游返回了 fileKey，后续改图优先复用它（不必重新上传）。'
      + '多张图以 base64 内联时合计受桥请求体限制（默认 32 MB）；超了会提示改用 fileKey/URL。'
      + '参数会严格校验：拼错的键（如 aspect_ratio / width）会直接返回 400，而不是被忽略。',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '图片描述（文生图）或修改指令（图生图）。必填' },
        images: {
          type: 'array',
          items: { type: 'string' },
          description: '参考图字符串数组（给了就是图生图）：绝对本地路径 / 公网 https URL / data URI / miora fileKey，每张 ≤ 20 MB',
        },
        size: { type: 'string', description: '输出尺寸 WIDTHxHEIGHT，如 1024x1024；不传用模型默认' },
        quality: { type: 'string', description: '文生图的质量档（如 standard / hd），图生图忽略' },
        save_to: {
          type: 'string',
          description: '可选：绝对路径（目录或完整文件名）。上游同步完成时直接落盘并返回文件路径；'
            + '异步任务仍用 workbuddy_image_status 的 save_to 下载',
        },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
    timeoutMs: 410_000,
    async execute(args, exec) {
      /*
       * 与视频同一道防线：图片输入认不出来时**不要提交**。
       * 原先非字符串项被静默过滤，模型传 `images: [{url: …}]` 时会变成
       * `images: []` → 请求退化成文生图 → 图没带上但照常计费。
       */
      let images;
      try {
        images = imageInputList(args?.images, 'images');
      } catch (error) {
        return `图片参数无法识别，没有提交（未计费）：${error.message}
修法：images[] 每项都用字符串（本地绝对路径 / 公网 https URL / data URI / miora fileKey），然后原样重试本次提交。`;
      }
      if (args?.prompt !== undefined && args?.prompt !== null && typeof args.prompt !== 'string') {
        return '图片 prompt 必须是字符串；这次没有提交（未计费）。';
      }
      const mode = images.length ? 'edit' : 'generate';
      let image;
      try {
        image = await client.imageSubmit({
          prompt: typeof args?.prompt === 'string' ? args.prompt : '',
          images,
          // 同视频：类型不对的值交给桥报 400，不能静默忽略后按默认尺寸生成。
          size: args?.size ?? '',
          quality: args?.quality ?? '',
          mode,
          signal: exec?.signal,
        });
      } catch (error) {
        return mediaFailureText(error, { action: 'submit', label: '图片' });
      }
      const summary = `任务：${image.id}；状态：${image.status}（上游：${image.upstream_status || '-'}）；`
        + `模式：${image.mode || mode}`
        + `${image.size ? `；尺寸：${image.size}` : ''}${image.model ? `；模型：${image.model}` : ''}`;
      /*
       * 图片实测经常走 `mode:"sync"`：结果（或失败原因）就在这次提交响应里，
       * 按 id 再查只会得到 INVALID_TASK_ID_FOR_SYNC_MODE。终态必须当场讲清楚。
       */
      if (image.status === 'completed') {
        const urls = Array.isArray(image.output?.urls) ? image.output.urls : [];
        const lines = [
          image.sync ? '图片已生成（上游同步返回完成）。' : '图片已生成（上游返回完成）。',
          summary,
          '本次提交按 WorkBuddy 账号积分计费（以余额为准）。',
        ];
        if (urls.length) {
          lines.push(await describeArtifacts({
            urls, kind: 'image', id: image.id, saveTo: args?.save_to, mimeType: mediaMimeType(image.result_files),
          }));
        } else if (image.sync) {
          lines.push('上游同步标记完成，但没有返回可下载的 https 产物；这个任务按 id 查不到更多信息。'
            + '不要再按 id 重查；需要产物请向用户确认后重新生成（会再次计费）。');
        } else {
          lines.push('上游标记完成，但这次响应没有可下载的 https 产物。稍后可用 workbuddy_image_status 再查一次（查询不计费）。');
        }
        const keys = fileKeyLine(image.result_files, 'image');
        if (keys) lines.push(keys);
        lines.push('同一需求不要重复生成（会再次计费）。');
        return lines.join('\n');
      }
      if (image.status === 'failed' || image.status === 'cancelled') {
        const lines = [
          image.status === 'cancelled'
            ? (image.sync ? '图片任务已取消（上游同步返回）。' : '图片任务已取消。')
            : (image.sync ? '图片生成失败（上游同步返回失败）。' : '图片生成失败。'),
          summary,
          `原因：${image.error?.message || '上游未给失败原因'}`,
          '本次没有可交付产物。不要原样重提；先和用户确认是否调整提示词/参考图，再决定是否重新生成（会再次计费）。',
        ];
        const keys = fileKeyLine(image.result_files, 'image');
        if (keys) lines.push(keys);
        return lines.join('\n');
      }
      const lines = [
        `已提交图片任务：${image.id}`,
        summary,
        '提交成功即按 WorkBuddy 账号积分计费。同一需求不要再提交一次。',
        `生成是异步的，稍后用 workbuddy_image_status 查询（id=${image.id}，可一次代等最多 120 秒）；completed 后把返回的 URL 交给用户。`,
      ];
      if (args?.save_to) {
        lines.push('本次 save_to 只对“提交时已同步完成”的产物生效；异步任务完成后再查状态时请再传一次 save_to。');
      }
      return lines.join('\n');
    },
  });

  const imageStatusTool = textTool({
    name: 'workbuddy_image_status',
    description:
      '查询 workbuddy_generate_image 提交的图片任务状态。'
      + '默认会在本工具里等待最多 20 秒、可用 wait_seconds 最高 120 秒（桥代轮询），通常能直接拿到 completed；'
      + 'queued/in_progress 时告诉用户还在生成，稍后再查，**不要重新提交**；'
      + 'completed 时返回有时效的下载 URL；failed/cancelled 时返回失败原因。'
      + '产物是**会过期**的签名 URL：要交付给用户时请传 save_to（绝对路径，目录或文件），'
      + '工具会把图片下载到本地并返回真实文件路径 —— 否则链接过期后只能重新生成（再扣一次积分）。'
      + '一次调用最多保存前 4 个产物，其余仍返回 URL。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '提交图片时返回的任务 id（upstreamTaskId）' },
        wait_seconds: {
          type: 'integer',
          minimum: 0,
          maximum: 120,
          description: '在本工具内等待多少秒再返回（0 = 立即返回；默认 20，最大 120；'
            + '内部按桥的 60 秒一段轮询）',
        },
        save_to: {
          type: 'string',
          description: '可选：绝对路径（目录或完整文件名）。给定时把产物下载到本地并返回文件路径，'
            + '目录会自动创建；不给则只返回签名 URL',
        },
      },
      required: ['id'],
      additionalProperties: false,
    },
    // 查询最多等 180 秒（60+60 两段 + 查询余量），落盘再预留 120 秒。
    timeoutMs: 330_000,
    async execute(args, exec) {
      const id = typeof args?.id === 'string' ? args.id.trim() : '';
      if (!id) throw new Error('id 不能为空：请传 workbuddy_generate_image 返回的任务 id');
      const waitSeconds = clampWaitSeconds(args?.wait_seconds);
      let image;
      try {
        image = await waitForMediaStatus(
          (taskId, options) => client.imageStatus(taskId, options),
          id,
          waitSeconds,
          exec?.signal,
        );
      } catch (error) {
        return mediaFailureText(error, { action: 'status', label: '图片' });
      }
      const lines = [
        `任务 ${id}：${image.status}（上游：${image.upstream_status || '-'}）`,
        `模式：${image.mode || '-'}${image.size ? `；尺寸：${image.size}` : ''}`
          + `${image.quality ? `；质量：${image.quality}` : ''}`,
      ];
      if (image.created_at) lines.push(`提交时间：${new Date(image.created_at * 1000).toISOString()}`);
      if (image.status === 'completed') {
        const urls = Array.isArray(image.output?.urls) ? image.output.urls : [];
        if (urls.length) {
          lines.push(await describeArtifacts({
            urls, kind: 'image', id, saveTo: args?.save_to, mimeType: mediaMimeType(image.result_files),
          }));
        } else if (image.sync) {
          lines.push('上游同步标记完成，但没有返回 https 产物。同步任务按 id 查不到更多信息；'
            + '不要再重查，需要产物请向用户确认后重新生成（会再次计费）。');
        } else {
          lines.push('上游标记完成，但没有返回 https 产物 URL。稍后再查一次，或到 WorkBuddy 客户端查看该任务。');
        }
        const keys = fileKeyLine(image.result_files, 'image');
        if (keys) lines.push(keys);
      } else if (image.sync_result_unavailable
        || /INVALID_TASK_ID_FOR_SYNC_MODE/i.test(image.error?.message || '')) {
        lines.push('这次查询没有拿到结果：该任务在上游是**同步完成**的，结果只出现在提交响应里，'
          + '桥的短期缓存已不包含它（过期、重启，或当前不是提交时的账号）。'
          + '如果刚切换过账号，切回提交时的账号再查；不要把它当成普通失败反复重提，'
          + '需要产物时请向用户确认后重新生成（会再次计费）。');
      } else if (image.status === 'failed' || image.status === 'cancelled') {
        lines.push(image.status === 'cancelled'
          ? '任务已取消（不是生成失败）：没有产物。'
          : `任务未成功：${image.error?.message || '上游未给失败原因'}`);
        if (image.sync) lines.push('（该任务是上游同步完成的，结果来自提交缓存。）');
        lines.push('不要直接重复提交；先确认失败原因/用户意愿，必要时再生成。');
      } else {
        lines.push(waitSeconds > 0
          ? `仍在生成（本次最多等待约 ${waitSeconds} 秒）。稍后再调用本工具查询；不要重新提交，否则会重复计费。`
          : '仍在生成。稍后再调用本工具查询；不要重新提交，否则会重复计费。');
      }
      return lines.join('\n');
    },
  });

  const bridgeTool = textTool({
    name: 'workbuddy_bridge',
    description:
      '管理本机 WorkBuddy 的本地桥进程：status 查看、start 拉起（已运行则复用）、stop 停止、restart 重启。'
      + '模型报「本地桥不可用 / ECONNREFUSED」时用 restart。'
      + 'action=console 则确保数据控制台在运行并返回它的地址（看逐条请求 / 趋势图 / CSV 用那个页面）。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'start', 'stop', 'restart', 'console'], description: '要执行的动作，默认 status' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    timeoutMs: 60_000,
    async execute(args, exec) {
      const action = String(args?.action || 'status');
      if (action === 'console') {
        const result = await consoleSupervisor.ensure({ signal: exec?.signal });
        if (!result.ok) return `控制台启动失败：${result.error}`;
        const probe = await consoleSupervisor.probe({ cached: false });
        return `控制台已就绪：${consoleSupervisor.url}${result.reused ? '（复用已在运行的实例）' : '（本次新拉起）'}\n状态：${probe.state}`
          + '\n逐条请求、趋势图、CSV 导出、账号切换、签到与诊断都在这个页面上。';
      }
      if (action === 'status') {
        const probe = await supervisor.probe(exec?.signal);
        if (probe.state === 'running') {
          return `桥运行中：pid ${probe.health.pid}，已运行 ${humanDuration(probe.health.uptimeMs)}，地址 ${supervisor.baseUrl}/v1`;
        }
        return `桥未运行（${probe.state}）：${probe.error || ''}`;
      }
      if (action === 'stop') {
        const result = await supervisor.stop(exec?.signal);
        return result.ok ? (result.stopped ? '已停止桥。' : '桥本来就没在运行。') : `停止失败：${result.error}`;
      }
      if (action === 'restart') {
        const result = await supervisor.ensure({ restart: true, signal: exec?.signal });
        adapter.invalidate();
        return result.ok ? `桥已重启：pid ${result.health?.pid}，地址 ${supervisor.baseUrl}/v1` : `重启失败：${result.error}`;
      }
      const result = await supervisor.ensure({ signal: exec?.signal });
      adapter.invalidate();
      return result.ok
        ? `桥已就绪${result.reused ? '（复用已在运行的实例）' : '（新拉起）'}：pid ${result.health?.pid}，地址 ${supervisor.baseUrl}/v1`
        : `启动失败：${result.error}`;
    },
  });

  return [
    statusTool, modelsTool, usageTool, checkinTool, webSearchTool,
    videoSubmitTool, videoStatusTool, imageSubmitTool, imageStatusTool, bridgeTool,
  ];
}
