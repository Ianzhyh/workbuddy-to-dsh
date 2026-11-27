/**
 * 输出速度测速（tokens/second）—— 纯函数，无 IO。
 *
 * 为什么需要它：用户选模型时只能看积分倍率与上下文窗口，但输出速度才是
 * 决定总耗时的那一项。dsh 把模型当子代理并发跑、每个还要多轮往返，于是
 * 「便宜的慢模型」可能比「贵的快模型」更费总时间。实测（同类项目 issue #92）：
 * 同样 0.08 倍率的四个模型，中位输出速度差 3.8 倍 —— 只看倍率会选错。
 *
 * 为什么和可用性探测分开：可用性探测灌 25k 输入、只让模型吐 1 个 token，
 * 它量的是输入侧限流，那个 elapsedMs 是首字节延迟，跟吞吐是两回事。
 * 测速需要相反的形态：极小输入 + 长输出。
 *
 * 为什么取三次的中位数而不是一次：实测 deepseek-v4.1-flash 五次
 * 406/405/419/423/411 tok/s，只差 4%；而 glm-5.3-flash 五次
 * 110/105/177/103/109，离群值高达 72%。单次测量会把那个离群值当成事实；
 * 三次取中位数能把它丢掉，成本仍只有约三分之一分。
 *
 * 绝不外推：结果里带实际样本数。三次里只成功两次就报 samples=2、
 * complete=false，而不是把两次的结果伪装成完整测量。
 */

/** 每次测速请求的输出上限。256 足够摊薄首字节开销，又把花费压到很低。 */
export const TPS_PROBE_MAX_TOKENS = 256;
/** 默认测速轮数：三次取中位数（见文件头注释里的实测离散度）。 */
export const TPS_PROBE_RUNS = 3;
/**
 * 生成阶段最短时长（毫秒）。
 *
 * 太短的样本算出来是噪声：generationMs=3、outputTokens=1 会得到 333 tok/s，
 * 而真实吞吐可能只有 50。这种样本直接丢弃，宁可少一个样本也不要一个错数字。
 */
export const MIN_GENERATION_MS = 40;

/**
 * 中位数。偶数个取中间两个的均值；无有效值时返回 undefined。
 * @param {number[]} values
 * @returns {number | undefined}
 */
export function median(values) {
  const list = (Array.isArray(values) ? values : [])
    .filter((v) => Number.isFinite(v))
    .sort((a, b) => a - b);
  if (!list.length) return undefined;
  const mid = Math.floor(list.length / 2);
  return list.length % 2 === 1 ? list[mid] : (list[mid - 1] + list[mid]) / 2;
}

/**
 * 从多次测量归纳成一个样本。
 *
 * @param {string} modelId
 * @param {Array<{firstContentMs?: number, generationMs?: number, outputTokens?: number, credit?: number}>} runs
 *   成功的轮次（失败的轮次不要放进来，用 attempted 表达"试了几次"）
 * @param {number} attempted 实际发起的轮数
 */
export function summarizeTps(modelId, runs, attempted) {
  const list = Array.isArray(runs) ? runs : [];
  const complete = list.length === attempted && attempted > 0;
  const speeds = [];
  const firsts = [];
  let outputTokens;
  let credit;
  for (const run of list) {
    if (Number.isFinite(run?.firstContentMs)) firsts.push(run.firstContentMs);
    // 只有"生成阶段够长 + 确实有输出"的样本才参与速度计算（见 MIN_GENERATION_MS）
    if (Number.isFinite(run?.generationMs) && run.generationMs >= MIN_GENERATION_MS
      && Number.isFinite(run?.outputTokens) && run.outputTokens > 0) {
      speeds.push(run.outputTokens / (run.generationMs / 1000));
    }
    if (Number.isFinite(run?.outputTokens)) outputTokens = run.outputTokens;
    if (Number.isFinite(run?.credit)) credit = (credit ?? 0) + run.credit;
  }
  const tokensPerSecond = median(speeds.map((s) => Math.round(s)));
  /*
   * 拿不到速度时必须说明是哪一种：否则面板只能显示破折号，
   * 用户无从判断"这个模型慢"还是"这次测量没成"。
   */
  const reason = tokensPerSecond !== undefined
    ? undefined
    : (list.length === 0
      ? 'all-failed'
      : (outputTokens === undefined ? 'no-usage' : 'few-chunks'));
  const firstMedian = median(firsts);
  return {
    modelId,
    ...(tokensPerSecond === undefined ? {} : { tokensPerSecond }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(firstMedian === undefined ? {} : { timeToFirstTokenMs: firstMedian }),
    samples: list.length,
    ...(credit === undefined ? {} : { credit: Math.round(credit * 100) / 100 }),
    complete,
    ...(reason === undefined ? {} : { reason }),
  };
}

/**
 * 把 finish 原因翻译成"这次测速能不能用"。
 *
 * stop：正常说完，可用；length：撞到 max_tokens，同样可用（我们本来就只要
 * 256 token，这是最常见的情况）。其它（内容过滤 / 工具调用 / 中途取消）
 * 不可用，因为输出 token 数不代表模型写得多快。
 *
 * @param {{kind?: string}} [reason]
 * @returns {boolean}
 */
export function tpsSampleUsable(reason) {
  const kind = String(reason?.kind || '');
  return kind === 'stop' || kind === 'length';
}

/**
 * 这个模型值不值得测速。
 *
 * 只跳过明确不可用的情形，不用"倍率高"之类的主观理由去筛：
 * 贵的模型也可能快到值得选。
 *
 * @param {{id?: string}} [model]
 * @returns {boolean}
 */
export function tpsProbeable(model) {
  return Boolean(model && typeof model.id === 'string' && model.id);
}