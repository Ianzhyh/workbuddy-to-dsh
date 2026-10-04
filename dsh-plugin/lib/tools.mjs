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
      if (!list.length) return needle ? `没有匹配 "${needle}" 的模型。` : '桥没有返回任何可用模型（先确认桥在运行、且 WorkBuddy 桌面端已登录）。';
      const lines = [`共 ${list.length} 个可用模型：`];
      for (const m of list) {
        const bits = [];
        if (m.context_window) bits.push(`上下文 ${fmtTokens(m.context_window)}`);
        if (m.max_output_tokens) bits.push(`输出上限 ${fmtTokens(m.max_output_tokens)}`);
        if (typeof m.credits === 'number') bits.push(m.credits === 0 ? '免费' : `倍率 ${m.credits}`);
        if (m.supports_images) bits.push('支持图片');
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
      const lines = [`最近 ${days} 天：调用 ${total.calls || 0} 次，失败 ${total.failed || 0} 次，`
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
      // 桥凭据异常（degraded）时 checkin 接口会回 502 —— 把它转成可读的
      // 修法提示，而不是向 agent 抛裸异常（那只会显示一个无上下文的错误码）。
      let result;
      try {
        result = await client.checkin({ claim, signal: exec?.signal });
      } catch (error) {
        if (error?.status === 502 || /login|sign in|accessToken|凭据|登录/i.test(String(error?.message))) {
          return `签到不可用：读不出 WorkBuddy 登录凭据（${error.message || 'HTTP ' + error.status}）。\n修法：打开 WorkBuddy 桌面端重新登录一次，然后重试。`;
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

  return [statusTool, modelsTool, usageTool, checkinTool, bridgeTool];
}
