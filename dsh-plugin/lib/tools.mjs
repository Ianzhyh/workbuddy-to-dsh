/**
 * 模型可见的工具 —— 让 agent 自己能问「桥怎么样 / 有哪些模型 / 花了多少」。
 *
 * ToolDefinition 契约（dsh tools 服务）：
 *   { name, description, parameters, output: { schema, render(args, value) }, execute(args, exec) }
 * 工具返回值必须是 JsonValue；模型看到的内容由 `output.render` 产出。
 * 这里统一用「返回格式化好的字符串 + render 成文本块」，好读也好测。
 */
import { humanDuration } from './models.mjs';

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
 * 视频接口错误 → 模型能直接转述给用户的话。
 * 提交失败最怕 agent 自动重试：那可能重复计费，所以文案必须明确“不要重提”。
 */
function videoFailureText(error, action) {
  const status = Number(error?.status) || 0;
  const message = String(error?.message || error || '').slice(0, 300);
  if (status === 403) {
    return '视频接口只接受本地管理令牌（client key 仅聊天）。检查插件是否用 WORKBUDDY_LOCAL_TOKEN 连桥，或重启桥。';
  }
  if (status === 401) {
    return '视频请求失败：本地桥令牌或 WorkBuddy 登录态不可用。先确认桥在运行且已登录，再重试。';
  }
  if (status === 429) {
    return `视频${action === 'submit' ? '提交' : '查询'}被 Miora 限流：${message || 'HTTP 429'}。`
      + '不要重复提交（任务可能已经创建）；稍后先调用 workbuddy_video_status 查已有任务。';
  }
  if (status === 400) {
    return `视频请求被拒绝：${message || '参数不合法'}。按提示修改参数或内容，不要原样重试。`;
  }
  if (status === 404) {
    return `没有找到这个视频任务：${message || 'unknown id'}。确认 id 来自 workbuddy_generate_video 的返回。`;
  }
  if (/ECONNREFUSED|fetch failed|socket hang up/i.test(message)) {
    return '视频请求失败：本地桥未运行。先调用 workbuddy_bridge（action=start），再重试。';
  }
  return `视频${action === 'submit' ? '提交' : '查询'}失败：${message || '未知错误'}`;
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
      const videoText = (videos || videoFailed)
        ? `，视频提交 ${videos} 次${videoFailed ? `（失败 ${videoFailed}）` : ''}`
        : '';
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
      + '不要因为等待时间长就重复提交（会重复扣费）。',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '视频描述；文生视频/参考图必填，首尾帧模式可选（描述运动与镜头）' },
        mode: { type: 'string', enum: ['text', 'frame', 'reference'], description: '不传时按输入自动推断' },
        first_frame: { type: 'string', description: '起始帧：绝对本地路径 / 公网 https URL / data URI / miora fileKey' },
        last_frame: { type: 'string', description: '结束帧（可选），格式同 first_frame' },
        references: { type: 'array', items: { type: 'string' }, description: '参考图（一张或多张），格式同 first_frame' },
        duration: { type: 'number', description: '目标时长（秒）。本次实测支持 4–15 秒，3 秒会被上游拒绝' },
        resolution: { type: 'string', description: '分辨率。本次实测支持 768P / 2K，720p 会被上游拒绝' },
        aspect_ratio: { type: 'string', description: '画幅，如 16:9 / 9:16 / 1:1' },
      },
      additionalProperties: false,
    },
    timeoutMs: 410_000,
    async execute(args, exec) {
      const references = Array.isArray(args?.references)
        ? args.references.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim())
        : [];
      let video;
      try {
        video = await client.videoSubmit({
          prompt: typeof args?.prompt === 'string' ? args.prompt : '',
          mode: typeof args?.mode === 'string' ? args.mode : '',
          firstFrame: typeof args?.first_frame === 'string' ? args.first_frame : '',
          lastFrame: typeof args?.last_frame === 'string' ? args.last_frame : '',
          references,
          duration: args?.duration,
          resolution: typeof args?.resolution === 'string' ? args.resolution : '',
          aspectRatio: typeof args?.aspect_ratio === 'string' ? args.aspect_ratio : '',
          signal: exec?.signal,
        });
      } catch (error) {
        return videoFailureText(error, 'submit');
      }
      const lines = [
        `已提交视频任务：${video.id}`,
        `状态：${video.status}；模式：${video.mode || '-'}${video.model ? `；模型：${video.model}` : ''}`,
        '提交成功即按 WorkBuddy 账号积分计费。同一需求不要再提交一次。',
        `生成是异步的，稍后用 workbuddy_video_status 查询（id=${video.id}）；completed 后把返回的 URL 交给用户。`,
      ];
      return lines.join('\n');
    },
  });

  const videoStatusTool = textTool({
    name: 'workbuddy_video_status',
    description:
      '查询 workbuddy_generate_video 提交的视频任务状态。'
      + 'queued/in_progress 时告诉用户还在生成，稍后再查，**不要重新提交**；'
      + 'completed 时返回有时效的下载 URL；failed/cancelled 时返回失败原因。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '提交视频时返回的任务 id（upstreamTaskId）' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    timeoutMs: 50_000,
    async execute(args, exec) {
      const id = typeof args?.id === 'string' ? args.id.trim() : '';
      if (!id) throw new Error('id 不能为空：请传 workbuddy_generate_video 返回的任务 id');
      let video;
      try {
        video = await client.videoStatus(id, exec?.signal);
      } catch (error) {
        return videoFailureText(error, 'status');
      }
      const lines = [
        `任务 ${id}：${video.status}（上游：${video.upstream_status || '-'}）`,
        `模式：${video.mode || '-'}${video.seconds ? `；时长：${video.seconds}s` : ''}`
          + `${video.resolution ? `；分辨率：${video.resolution}` : ''}`
          + `${video.aspect_ratio ? `；画幅：${video.aspect_ratio}` : ''}`,
      ];
      if (video.status === 'completed') {
        const urls = Array.isArray(video.output?.urls) ? video.output.urls : [];
        if (urls.length) {
          lines.push('视频已生成。以下签名 URL 有时效，请尽快下载或转存：');
          for (const url of urls) lines.push(`- ${url}`);
        } else {
          lines.push('上游标记完成，但没有返回 https 产物 URL。稍后再查一次，或到 WorkBuddy 客户端查看该任务。');
        }
      } else if (video.status === 'failed' || video.status === 'cancelled') {
        lines.push(`任务未成功：${video.error?.message || '上游未给失败原因'}`);
        lines.push('不要直接重复提交；先确认失败原因，必要时再生成。');
      } else {
        lines.push('仍在生成。稍后再调用本工具查询；不要重新提交，否则会重复计费。');
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

  return [statusTool, modelsTool, usageTool, checkinTool, webSearchTool, videoSubmitTool, videoStatusTool, bridgeTool];
}
