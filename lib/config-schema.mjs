/**
 * 配置取值的可解析性校验。
 *
 * 只覆盖「写错会被静默回退」的数值 / 枚举项：`numEnv()` 对非数字、越界值
 * 一律回退默认值，启动不会报错 —— 用户看到的是「改了 .env 却没生效」。
 * 这里把同一套判据提前跑一遍，让诊断页能说清哪一项没被识别。
 *
 * 不校验令牌、路径、模型名这类自由文本；也不判断未知键（桥与插件各自还会
 * 读一些只在该进程生效的变量，列不全就会误报）。schema 与消费点**必须同步**：
 * 新增一个 `numEnv()` 时把范围抄到这里，否则这项检查会漏。
 */

/** @typedef {{ kind: 'number', min: number, max: number, integer?: boolean, fallback: number, note: string }} NumberRule */
/** @typedef {{ kind: 'enum', values: string[], fallback: string, lowercase?: boolean, note: string }} EnumRule */
/** @typedef {{ kind: 'bool', on: '1'|'not-0', fallback: boolean, note: string }} BoolRule */
/**
 * `curated` / `all` 或任意正整数。判据**必须**与桥侧 `parseModelsDefault()`
 * 一致 —— 两处说法不同就会出现「诊断页说写错了、桥其实接受了」。
 */
/** @typedef {{ kind: 'modelsDefault', values: string[], fallback: string, lowercase?: boolean, note: string }} ModelsDefaultRule */
/** @typedef {NumberRule | EnumRule | BoolRule | ModelsDefaultRule} ConfigRule */

/** @type {Record<string, ConfigRule>} */
export const CONFIG_SCHEMA = Object.freeze({
  WORKBUDDY_PORT: { kind: 'number', min: 1, max: 65535, integer: true, fallback: 8790, note: '桥端口' },
  DASHBOARD_PORT: { kind: 'number', min: 1, max: 65535, integer: true, fallback: 8792, note: '控制台端口' },
  WORKBUDDY_TIMEOUT_MS: { kind: 'number', min: 0, max: Infinity, fallback: 0, note: '上游超时（0=不限）' },
  WORKBUDDY_QUOTA_TTL_MS: { kind: 'number', min: 0, max: Infinity, fallback: 60000, note: '积分缓存' },
  WORKBUDDY_RATE_LIMIT_RPM: { kind: 'number', min: 0, max: Infinity, fallback: 0, note: '每分钟请求上限' },
  WORKBUDDY_RATE_LIMIT_MIN_INTERVAL_MS: { kind: 'number', min: 0, max: Infinity, fallback: 0, note: '请求最小间隔' },
  WORKBUDDY_ACTIVE_ALERT_MS: { kind: 'number', min: 1000, max: Infinity, fallback: 300000, note: '疑似卡死阈值' },
  WORKBUDDY_QUOTA_SNAPSHOT_MS: { kind: 'number', min: 0, max: Infinity, fallback: 3600000, note: '余额快照间隔' },
  WORKBUDDY_MEDIA_IDEMPOTENCY_MS: { kind: 'number', min: 0, max: Infinity, fallback: 600000, note: '媒体幂等窗口' },
  WORKBUDDY_IMAGE_SYNC_WAIT_S: { kind: 'number', min: 0, max: 300, fallback: 90, note: '图片同步等待秒数' },
  WORKBUDDY_IMAGE_B64_MAX_BYTES: { kind: 'number', min: 1024, max: Infinity, fallback: 20971520, note: '图片 b64 上限' },
  WORKBUDDY_MAX_BODY_BYTES: { kind: 'number', min: 1024, max: Infinity, fallback: 33554432, note: '请求体上限' },
  WORKBUDDY_KEEPALIVE_MS: { kind: 'number', min: 0, max: Infinity, fallback: 300000, note: 'SSE 心跳' },
  WORKBUDDY_FIRST_BYTE_TIMEOUT_MS: { kind: 'number', min: 0, max: Infinity, fallback: 120000, note: '首字节超时' },
  WORKBUDDY_QUEUE_TIMEOUT_MS: { kind: 'number', min: 0, max: Infinity, fallback: 120000, note: '排队超时' },
  WORKBUDDY_MAX_SOCKETS: { kind: 'number', min: 1, max: 1024, integer: true, fallback: 32, note: '上游连接数' },
  WORKBUDDY_TRANSPORT_RETRY_MS: { kind: 'number', min: 0, max: Infinity, fallback: 250, note: '传输重试延迟' },
  WORKBUDDY_CHECKIN_COOLDOWN_MS: { kind: 'number', min: 0, max: Infinity, fallback: 3600000, note: '签到失败冷却' },
  WORKBUDDY_CHECKIN_KICK_MS: { kind: 'number', min: 0, max: Infinity, fallback: 20000, note: '签到补跑间隔' },
  WORKBUDDY_SEARCH_TIMEOUT_MS: { kind: 'number', min: 1000, max: Infinity, fallback: 20000, note: '网页搜索超时' },
  WORKBUDDY_SEARCH_MAX_RESULTS: { kind: 'number', min: 1, max: 10, integer: true, fallback: 8, note: '网页搜索结果数' },
  WORKBUDDY_CONTEXT_WINDOW: { kind: 'number', min: 0, max: Infinity, integer: true, fallback: 0, note: '上下文窗口覆盖' },
  WORKBUDDY_LOGIN_STATE_TTL_MS: { kind: 'number', min: 1000, max: Infinity, fallback: 600000, note: '登录状态有效期' },
  WORKBUDDY_LOGIN_POLL_MIN_MS: { kind: 'number', min: 0, max: Infinity, fallback: 3000, note: '登录轮询间隔' },

  WORKBUDDY_RATE_LIMIT_MODE: { kind: 'enum', values: ['queue', 'reject'], fallback: 'queue', note: '限流模式' },
  WORKBUDDY_CREDENTIAL_SOURCE: { kind: 'enum', values: ['auto', 'desktop', 'plugin', 'api-key'], fallback: 'auto', lowercase: true, note: '凭据来源' },
  WORKBUDDY_CREDENTIAL_STORE: {
    kind: 'enum',
    values: ['dpapi', 'file', 'memory'],
    fallback: process.platform === 'win32' ? 'dpapi' : 'file',
    lowercase: true,
    note: '凭据存储',
  },
  WORKBUDDY_CREDENTIAL_FAILOVER: { kind: 'enum', values: ['off', 'same-account', 'any'], fallback: 'same-account', lowercase: true, note: '凭据接管策略' },
  WORKBUDDY_LOGIN_REGION: { kind: 'enum', values: ['cn', 'global'], fallback: 'cn', lowercase: true, note: '登录区域' },
  /*
   * 模型默认视图规模：`curated` / `all` / 正整数（`8`）。
   * **不是**纯枚举 —— `values` 列不全，所以单独一种 kind，判据与桥侧
   * `parseModelsDefault()` 一致，避免诊断页把合法的 `=8` 报成写错了。
   */
  WORKBUDDY_MODELS_DEFAULT: { kind: 'modelsDefault', values: ['curated', 'all', 'full'], fallback: 'curated', lowercase: true, note: '默认视图模型数（curated / all / 正整数）' },

  WORKBUDDY_LOG: { kind: 'bool', on: '1', fallback: true, note: '桥日志' },
  DASHBOARD_OPEN_BROWSER: { kind: 'bool', on: '1', fallback: false, note: '自动开浏览器' },
  DASHBOARD_AUTO_START_BRIDGE: { kind: 'bool', on: 'not-0', fallback: true, note: '自动拉起桥' },
});

/**
 * 按消费点的真实语义校验一组环境变量。
 *
 * 返回 `issues` 只包含「值不会被采用」的项；空值视为未设置。
 * `fallback` 是消费点实际会退回的值，用来告诉用户当前真正生效的是什么。
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ checked: number, issues: Array<{ key: string, value: string, reason: string, fallback: string, note: string }> }}
 */
export function validateConfigEnv(env = process.env) {
  const issues = [];
  let checked = 0;
  for (const [key, rule] of Object.entries(CONFIG_SCHEMA)) {
    const raw = env[key];
    if (raw === undefined || String(raw).trim() === '') continue;
    checked += 1;
    const text = String(raw).trim();
    if (rule.kind === 'enum') {
      const value = rule.lowercase ? text.toLowerCase() : text;
      if (!rule.values.includes(value)) {
        issues.push({
          key,
          value: text,
          reason: `只接受 ${rule.values.join(' / ')}`,
          fallback: rule.fallback,
          note: rule.note,
        });
      }
      continue;
    }
    if (rule.kind === 'modelsDefault') {
      const value = rule.lowercase ? text.toLowerCase() : text;
      const positive = /^[1-9]\d*$/.test(value);
      if (!rule.values.includes(value) && !positive) {
        issues.push({
          key,
          value: text,
          reason: `只接受 ${rule.values.join(' / ')} 或正整数`,
          fallback: rule.fallback,
          note: rule.note,
        });
      }
      continue;
    }
    if (rule.kind === 'bool') {
      const on = rule.on === 'not-0' ? text !== '0' : text === '1';
      const expected = rule.on === 'not-0' ? '0 关闭，其它值均视为开启' : '1 开启，其它值均视为关闭';
      if (!(text === '0' || text === '1')) {
        issues.push({
          key,
          value: text,
          reason: `只认 0 / 1（${expected}）`,
          fallback: on ? '开启' : '关闭',
          note: rule.note,
        });
      }
      continue;
    }
    const value = Number(raw);
    const min = rule.min;
    const max = rule.max;
    if (!Number.isFinite(value)) {
      issues.push({ key, value: text, reason: '不是数字', fallback: String(rule.fallback), note: rule.note });
      continue;
    }
    const used = rule.integer ? Math.trunc(value) : value;
    if (used < min || used > max) {
      const range = max === Infinity ? `>= ${min}` : `${min} ~ ${max}`;
      issues.push({
        key,
        value: text,
        reason: `超出范围（${range}）`,
        fallback: String(rule.fallback),
        note: rule.note,
      });
    }
  }
  return { checked, issues };
}

/**
 * 把校验结果压成一行给诊断页。
 *
 * 最多列 3 项：诊断详情是一行文本，问题多时全列会糊成一片；`checked`
 * 仍能让用户知道这次到底看了多少项。
 *
 * @param {{ checked: number, issues: Array<{ key: string, value: string, reason: string, fallback: string, note: string }> }} result
 * @returns {{ status: 'ok'|'warn', detail: string, hint: string }}
 */
export function describeConfigCheck(result) {
  if (!result.issues.length) {
    return {
      status: 'ok',
      detail: result.checked
        ? `已检查 ${result.checked} 项数值 / 枚举配置，格式正确`
        : '使用默认值（未自定义数值 / 枚举配置）',
      hint: '',
    };
  }
  const shown = result.issues.slice(0, 3)
    .map((i) => `${i.key}=${i.value}（${i.reason}，实际按 ${i.fallback}）`)
    .join('；');
  const rest = result.issues.length > 3 ? `；另有 ${result.issues.length - 3} 项` : '';
  return {
    status: 'warn',
    detail: `${result.issues.length} 项配置值不会被采用：${shown}${rest}`,
    hint: '按提示修正 .env（或系统环境变量）后重启桥与控制台。格式错误的值不会生效，也不会阻止启动。',
  };
}
