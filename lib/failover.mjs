/**
 * 账号限流自动切号的共享判定 —— **纯函数，无 IO**。
 *
 * 为什么单独抽一层：Web 控制台（`dashboard/server.mjs`）与 dsh 插件
 * （`dsh-plugin/lib/index.js`）各写过一份「挑下一个账号 + 判断要不要切」的
 * 副本，规则已经漂移过：插件那份不校验凭据来源，插件登录的账号被 429 时
 * 也会去切桌面账号（切了也不生效，还把钱包换走）。
 *
 * 现在两边都从这里取判定；插件分发时用 `vendor/lib/failover.mjs` 的副本
 * （见 `dsh-plugin/scripts/vendor.mjs`）。
 */

/**
 * 从控制台账号列表挑下一个可切换账号。
 *
 * 跳过不可用 / 隐藏 / 当前账号；按列表顺序循环。
 *
 * 定位「当前账号」时 **`currentUid` 优先**：它来自桥的 `/health.auth.userId`，
 * 是**真正在服务**的那个账号；`active` 只是控制台 `.state.json` 里的钉住项，
 * 桌面端换号或桥跟随到别的文件后可能与实际服务账号不一致 —— 以它为准会
 * 挑到「自己」，切完等于没切。
 *
 * @param {any[]} accounts 控制台 `/api/accounts` 的账号列表
 * @param {string} [currentUid] 桥当前登录账号的 userId
 * @returns {any|null} 目标账号；没有可切换项时为 null
 */
export function pickAccountFailoverTarget(accounts, currentUid = '') {
  const usable = (Array.isArray(accounts) ? accounts : [])
    .filter((a) => a && a.usable === true && a.hidden !== true);
  if (usable.length < 2) return null;
  const uid = currentUid === undefined || currentUid === null ? '' : String(currentUid);
  const idOf = (a) => String(a.userId ?? a.account ?? '');
  let current = uid ? usable.find((a) => idOf(a) === uid) : null;
  if (!current) current = usable.find((a) => a.active === true) || null;
  /*
   * 「当前账号」按**账号身份**判定，不只是文件名：同一账号常有几份登录快照
   * （桌面端换号会留 `.info` 快照），切过去还是同一个钱包 —— 限流不会因此
   * 缓解，反而白停一次桥。所以同 `userId` / 同 `account` 的候选一并跳过。
   */
  const isCurrent = (a) => {
    if (!current) return false;
    if (a.name === current.name) return true;
    if (uid && idOf(a) === uid) return true;
    return Boolean(current.account) && String(a.account || '') === String(current.account);
  };
  const start = current ? usable.indexOf(current) : -1;
  for (let i = 1; i <= usable.length; i += 1) {
    const cand = usable[(start + i + usable.length) % usable.length];
    if (!isCurrent(cand)) return cand;
  }
  return null;
}

/**
 * 桥的 `/health` 是否已经达到「该自动切号」的门槛。
 *
 * 返回命中的限流摘要（`{count, model, lastAt}`），不需要切号时返回 null。
 *
 * 三条门槛缺一不可：
 *   1. 阈值显式开启（> 0）—— 默认关，切号会换钱包；
 *   2. **凭据来源必须是 desktop** —— 插件 / api-key 来源下切桌面账号不会生效，
 *      只会在用户不知情时把钱包换掉；
 *   3. 同一账号同一模型在统计窗口内的 429 次数达到阈值。
 *
 * @param {any} health 桥 `/health` 响应体（不是 `{running, body}` 包装）
 * @param {number} after 阈值（N 次 429）
 */
export function failoverSignal(health, after) {
  const threshold = Math.max(0, Math.floor(Number(after) || 0));
  if (!threshold) return null;
  if (!health || typeof health !== 'object' || health.ok === false) return null;
  if (health.auth?.source !== 'desktop') return null;
  const limit = health.rateLimit;
  const count = Number(limit?.count);
  if (!Number.isFinite(count) || count < threshold) return null;
  return {
    count,
    model: typeof limit?.model === 'string' ? limit.model : '',
    lastAt: typeof limit?.lastAt === 'string' ? limit.lastAt : '',
  };
}
