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
 * 积分包的「临期」门槛：3 天内到期。
 *
 * 为什么是 3 天：上游的积分包有效期从几天到几个月不等（实测一个账号上同时挂着
 * 15 个「运营裂变包」，从 11-17 到 11-30 陆续到期）。留 3 天是给人「还能改主意」
 * 的余地 —— 更短就来不及用完，更长会让「临期」这个信号失去紧迫感。
 */
export const CREDITS_EXPIRING_MS = 3 * 24 * 3_600_000;

/**
 * 一个账号的「临期积分」概况。
 *
 * 输入是桥 `/v1/quota` 的 `packages[]`，每项形如
 * `{name, remain, size, monthly, expiresAt}`；`expiresAt` 是**墙钟字符串**
 * （`2026-11-17 16:44:30`，无时区），解析失败即视为「没有到期时间」。
 *
 * ⚠️ 三条口径必须钉住，否则会把用户的钱算错：
 *   1. **`remain` 才是能花的量**，不是 `size`。用 `size` 会把已花掉的算成还能花。
 *   2. **`monthly: true` 的包不参与临期**：月包是「本周期剩余」，月底归零但不
 *      叫"过期作废"（下个周期会重新给）。把它算进临期会让每个账号永远临期。
 *   3. **已过期的不计**：那部分本来就没了，算进「临期积分」会让排序去追一笔
 *      已经不存在的钱。
 *
 * @param {any[]} packages `/v1/quota` 的 `packages`
 * @param {number} [now]
 * @returns {{ expiring: number, earliestExpiry: number, total: number, known: boolean }}
 *   `known: false` 表示这份数据里没有任何可用的到期信息（不是"零积分"）
 */
export function expiringCredits(packages, now = Date.now()) {
  const list = Array.isArray(packages) ? packages : [];
  let expiring = 0;
  let earliestExpiry = 0;
  let total = 0;
  let sawExpiry = false;
  for (const p of list) {
    if (!p || typeof p !== 'object') continue;
    const remain = Number(p.remain);
    if (!Number.isFinite(remain) || remain <= 0) continue;
    total += remain;
    // 月包不算临期：它的归零是周期性的，不是"这笔钱会消失"
    if (p.monthly === true) continue;
    const at = Date.parse(String(p.expiresAt || '').replace(' ', 'T'));
    if (!Number.isFinite(at)) continue;
    sawExpiry = true;
    if (at <= now) continue;                       // 已经过期：那部分没了
    if (at - now > CREDITS_EXPIRING_MS) continue;  // 还早，不算临期
    expiring += remain;
    // 先到期的优先：记最早的那个时刻
    if (earliestExpiry === 0 || at < earliestExpiry) earliestExpiry = at;
  }
  return { expiring, earliestExpiry, total, known: sawExpiry };
}

/**
 * 按**优先级**挑一个账号（开启账号池时的语义）。
 *
 * 与 {@link pickAccountFailoverTarget} 的区别是**语义**不是实现：
 *   - 那个是「当前这个账号不能用了，换谁」，所以按列表顺序轮转，目标是**换掉**；
 *   - 这个是「这些账号里谁最该被用」，所以要排序。
 *
 * ## 排序规则（与 dsh-connect-workbuddy 实测出的顺序一致，理由见每条）
 *
 * 1. **可用优先** —— 被判为不可用的排最后，不参与选择。
 * 2. **快过期的积分先花** —— 积分用不掉就作废，所以有临期积分的账号排前面；
 *    两个都临期时，**临期积分多的优先**（同样是花钱，先把确定会损失的花掉）。
 *    ⚠️ 这条必须排在第 3 条**之前**。若按「积分总量」优先，总量几乎从不相等，
 *    「临期优先」就永远不生效 —— 那是死代码，实测过一个账号有 196 分当天作废，
 *    只因比别的账号少约 1200 分就永远排最后。
 *    代价也要说清：临期 1 分的账号会排到余额 5 万的账号前面。这不是缺陷 ——
 *    那 1 分确定会损失，而 5 万下一轮还在；真跑不完一个请求时由换号逻辑接手。
 * 3. **积分高者优先** —— 只在有**新鲜读数**（{@link expiringCredits} 的 `known`）
 *    时才参与；没读数的账号不因此被排到最后（宁可不知道，也不能把好账号埋掉）。
 * 4. **凭据更晚过期的优先**。
 * 5. 按账号 id 收尾，保证是**全序**、可复现，不因账号表顺序抖动而改变。
 *
 * @param {any[]} accounts 每项含 `name/usable/hidden/userId/account/expiresAt/quota`
 *   （`quota` = 该账号的 `/v1/quota` 结果，可选；没有就不参与积分排序）
 * @param {{ now?: number, excludeUid?: string }} [options]
 * @returns {any|null} 排在最前的可用账号；没有可用项时返回 null
 */
export function rankAccounts(accounts, { now = Date.now(), excludeUid = '' } = {}) {
  const list = (Array.isArray(accounts) ? accounts : []).filter((a) => {
    if (!a || a.usable !== true || a.hidden === true) return false;
    if (excludeUid && String(a.userId ?? a.account ?? '') === String(excludeUid)) return false;
    return true;
  });
  if (!list.length) return null;

  /** 预计算每个账号的排序键，避免比较函数里反复解析时间。 */
  const keyed = list.map((a) => {
    const q = a.quota && typeof a.quota === 'object' ? a.quota : null;
    const credits = q ? expiringCredits(q.packages, now) : { expiring: 0, earliestExpiry: 0, total: 0, known: false };
    return {
      account: a,
      expiring: credits.expiring,
      earliestExpiry: credits.earliestExpiry || Infinity,
      creditsKnown: credits.known,
      total: credits.total,
      expiresAt: Number(a.expiresAt) || 0,
      id: String(a.userId ?? a.account ?? a.name ?? ''),
    };
  });

  keyed.sort((x, y) => {
    // ① 临期积分：越多越优先（0 的排后面）
    if (x.expiring !== y.expiring) return y.expiring - x.expiring;
    // ② 都临期时，先到期的优先
    if (x.expiring > 0 && x.earliestExpiry !== y.earliestExpiry) {
      return x.earliestExpiry - y.earliestExpiry;
    }
    // ③ 积分总量高的优先 —— 只比"双方都有读数"的那部分，
    //    一边有读数一边没有时不比（见函数注释第 3 条）
    if (x.creditsKnown && y.creditsKnown && x.total !== y.total) return y.total - x.total;
    // ④ 凭据更晚过期的优先
    if (x.expiresAt !== y.expiresAt) return y.expiresAt - x.expiresAt;
    // ⑤ 全序收尾：保证顺序可复现
    return x.id < y.id ? -1 : (x.id > y.id ? 1 : 0);
  });

  return keyed[0].account;
}

/**
 * 切号时挑目标 —— **带降级**的入口，切号路径应当调它而不是 {@link rankAccounts}。
 *
 * ## 为什么不能直接用 rankAccounts
 *
 * `rankAccounts` 只在"有积分读数"时才能算临期。而账号的积分必须**逐个起桥去问**
 * （`/v1/quota` 走的是当前登录凭据），N 个账号就是 N 次停/起桥 ——
 * 这个代价远超"省下几笔临期积分"，而且切号本身就在故障路径上，不能更慢。
 *
 * 现实里只有**正在服务的那个账号**有新鲜读数。所以这里的策略是：
 *
 *   1. 若池里有账号带着**临期积分**读数（`quota.packages` 有 3 天内到期的非月包），
 *      按 `rankAccounts` 选它 —— 这是"钱要过期了，先花"的收益；
 *   2. 否则退回 {@link pickAccountFailoverTarget}（列表轮转）。
 *      **不**因为"没有读数"就把某个账号排到最后：那会让刚发现的账号永远轮不到。
 *
 * 这样既拿到主要收益（临期积分不会烂掉），又保持既有切号语义完全不变 ——
 * 降级路径与改动前的行为**逐字等价**，有测试钉住。
 *
 * @param {any[]} accounts
 * @param {string} [currentUid]
 * @param {{ now?: number }} [options]
 * @returns {any|null}
 */
export function pickFailoverTarget(accounts, currentUid = '', { now = Date.now() } = {}) {
  const list = Array.isArray(accounts) ? accounts : [];
  const uid = currentUid === undefined || currentUid === null ? '' : String(currentUid);
  /*
   * 有没有**任何**账号带可用的临期读数？
   * 注意判据是 `expiring > 0` 而不是 `known`：`known` 只表示"有到期时间字段"，
   * 而绝大多数账号的积分都在 3 天窗口之外 —— 那样每条路径都会进排序分支，
   * 等于放弃了"和改动前逐字等价"这个保证。
   */
  const hasExpiring = list.some((a) => {
    if (!a || a.usable !== true || a.hidden === true) return false;
    if (!a.quota || !Array.isArray(a.quota.packages)) return false;
    return expiringCredits(a.quota.packages, now).expiring > 0;
  });
  if (hasExpiring) {
    const best = rankAccounts(list, { now, excludeUid: uid });
    if (best) return best;
  }
  return pickAccountFailoverTarget(list, uid);
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
  /*
   * 账号级额度上限（6004 / 14018）**一次就切**，不等 N 次。
   *
   * 同类项目的共同结论：6004 的重置在数小时后，把重试/计数预算花在一个
   * 不可能在窗口内恢复的账号上没有意义。`after > 0` 已经是用户显式开启
   * 自动切号（默认 0 = 关），所以这里不需要再要一个开关；瞬时的 14003/429
   * 仍走下面的 N 次阈值，避免偶发限流就换钱包。
   */
  const quota = limit?.quota;
  if (quota && Number(quota.count) >= 1) {
    return {
      count: Number(quota.count),
      model: typeof quota.model === 'string' ? quota.model : '',
      lastAt: typeof quota.lastAt === 'string' ? quota.lastAt : '',
      resetAt: typeof quota.resetAt === 'string' ? quota.resetAt : '',
      reason: 'quota',
    };
  }
  /*
   * 11140「账号存在异常行为」是账号级风控：重新登录/刷新 token 都无效，换号
   * 才是出路（与内容审核的 11140 分开，后者不会进这个字段）。同样一次即切。
   */
  const restricted = limit?.accountRestricted;
  if (restricted && typeof restricted === 'object') {
    return {
      count: 1,
      model: typeof restricted.model === 'string' ? restricted.model : '',
      lastAt: typeof restricted.lastAt === 'string' ? restricted.lastAt : '',
      resetAt: typeof restricted.resetAt === 'string' ? restricted.resetAt : '',
      reason: 'account_restricted',
    };
  }
  const count = Number(limit?.count);
  if (!Number.isFinite(count) || count < threshold) return null;
  return {
    count,
    model: typeof limit?.model === 'string' ? limit.model : '',
    lastAt: typeof limit?.lastAt === 'string' ? limit.lastAt : '',
    reason: 'rate_limit',
  };
}
