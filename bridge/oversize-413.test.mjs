/**
 * 413 的文案必须能被 **dsh 的上下文溢出识别** 命中。
 *
 * ## 用户遇到的真实现象
 *
 *   `本轮运行失败上游 413：workbuddy-bridge: request body too large
 *    (limit 33554432 bytes); raise WORKBUDDY_MAX_BODY_BYTES ...`
 *
 * ——整轮直接失败，而不是"压缩上下文后重试"。
 *
 * ## 为什么（读 dsh 源码得到的因果链）
 *
 * dsh 的自动压缩只在 `code === 'CONTEXT_WINDOW_EXCEEDED'` 时触发：
 *
 *   dsh-compaction-basic/lib/index.js
 *     ctx.on('agent/request-error', ...) {
 *       if (failure.code !== CONTEXT_WINDOW_EXCEEDED_CODE) return next();
 *       await this.compactIfNeeded(agent, 'context-overflow', signal);
 *     }
 *
 * 而这个 code 由 dsh-llm-deepseek 从**错误文案**用三条正则判断：
 *   · STRUCTURED_CONTEXT_OVERFLOW  —— 需要 context + (length|window) + exceed/overflow
 *   · TOO_LARGE_FOR_CONTEXT       —— 需要 "<request> too large for ... context"
 *   · EXCEEDS_MODEL_CONTEXT       —— 需要 "<request> ... exceed ... context"
 * 三条都要求出现 "context" 这个词。旧文案一个都没有 → 落到 413 的兜底分支
 * `INVALID_REQUEST` → **不压缩** → 整轮失败。
 *
 * 本机实测印证：prompt 47.5 万 tokens，而压缩阈值只有
 *   min(contextWindow*0.8, contextWindow-reservedCompletion-headroom)
 *   = min(300000*0.8, 300000-128000-65536) = 106464
 * 早就该压缩，却因为文案对不上而从未触发。
 *
 * 所以这条用例钉的是：**413 的 message 必须包含 dsh 能识别的措辞**。
 * 正则直接抄自 dsh 源码，dsh 升级改措辞时这里会红，提醒我们同步。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, 'workbuddy-bridge.mjs'), 'utf8');

/* ── 三条正则逐字抄自 dsh-llm/lib/index.js（改 dsh 版本时要回来对） ── */
const STRUCTURED_CONTEXT_OVERFLOW = new RegExp(
  String.raw`(?:^|[^a-z0-9])context[\s_-](?:length|window)[\s_-]`
  + String.raw`(?:exceed(?:ed|s)?|overflow(?:ed)?|limit[\s_-]exceeded)(?:$|[^a-z0-9])`,
  'i',
);
const TOO_LARGE_FOR_CONTEXT = new RegExp(
  String.raw`\b(?:request|prompt|input|messages?)\s+(?:is\s+|are\s+)?`
  + String.raw`too\s+(?:large|long)\s+for\s+(?:(?:this|the)\s+)?`
  + String.raw`(?:model(?:'s)?\s+)?context(?:\s+window)?\b`,
  'i',
);
const EXCEEDS_MODEL_CONTEXT = new RegExp(
  String.raw`\b(?:input|prompt|request|messages?)\b.{0,40}`
  + String.raw`\b(?:exceed(?:s|ed)?|overflows?|is\s+larger\s+than)\b.{0,40}`
  + String.raw`\b(?:the\s+)?(?:model(?:'s)?\s+)?context(?:\s+(?:length|window))?\b`,
  'i',
);

/** dsh 的判据：任一条命中即视为"上下文超限"。 */
const recognizedByDsh = (detail) => STRUCTURED_CONTEXT_OVERFLOW.test(detail)
  || TOO_LARGE_FOR_CONTEXT.test(detail)
  || EXCEEDS_MODEL_CONTEXT.test(detail);

test('413 文案必须被 dsh 识别成 CONTEXT_WINDOW_EXCEEDED（否则压缩永不触发）', () => {
  /*
   * 直接取出 oversizeMessage 的实现并**真的调用**它，而不是断言源码里有某个字符串
   * —— 后者会放过"写了但拼错/顺序反了"的情况，而这里要的是"实际输出能被匹配"。
   */
  const fnStart = SRC.indexOf('function oversizeMessage(');
  assert.ok(fnStart > 0, '找不到 oversizeMessage');

  // 依赖的 fmtBytes / oversizeHint 也一并取出来求值（纯函数，无副作用）
  const grab = (name) => {
    const at = SRC.indexOf(`function ${name}(`);
    assert.ok(at > 0, `找不到 ${name}`);
    // 从函数头扫到匹配的右花括号
    let i = SRC.indexOf('{', at);
    let depth = 0;
    for (; i < SRC.length; i += 1) {
      if (SRC[i] === '{') depth += 1;
      else if (SRC[i] === '}') { depth -= 1; if (depth === 0) return SRC.slice(at, i + 1); }
    }
    throw new Error(`${name} 括号不配对`);
  };

  const MAX_BODY_BYTES = 32 * 1024 * 1024;
  const code = `${grab('fmtBytes')}\n${grab('oversizeHint')}\n${grab('oversizeMessage')}\nreturn oversizeMessage;`;
  const oversizeMessage = new Function('MAX_BODY_BYTES', code)(MAX_BODY_BYTES);

  /* 场景：用户遇到的那次 —— 上限 32MB，实际至少 34.8MB */
  const msg = oversizeMessage({ actualBytes: Math.round(34.8 * 1024 * 1024), limitBytes: MAX_BODY_BYTES });
  assert.equal(recognizedByDsh(msg), true,
    `413 文案没有被 dsh 的溢出识别命中，压缩不会触发。实际文案：${msg}`);

  /* 而且这句话在语义上也必须站得住（不是靠拼词凑出来的假匹配） */
  assert.match(msg, /exceeds the model context window/i,
    '文案应明确说"超出模型上下文窗口"——这既是 dsh 的判据，也是事实');

  /*
   * 同时**不能丢掉 "too large"**：413 的既有契约（bridge-input-guard 用例）
   * 与人的直觉都靠这个词。两类读者都要照顾，缺一个就有一边看不懂。
   */
  assert.match(msg, /too large/i, '413 仍要说明"太大"（既有契约与人的直觉）');

  /* 体积信息仍要在：用户才知道自己多大、要不要调上限 */
  assert.match(msg, /at least/i, '要说明"至少多大"（超限即停，真实体积只会更大）');
  assert.match(msg, /MB/, '体积要用 MB 说，不要只给字节数');
  assert.match(msg, /WORKBUDDY_MAX_BODY_BYTES/, '要给出可复制的环境变量名');
});

test('旧文案（只有 request body too large）确实识别不了 —— 这就是 bug 本身', () => {
  const oldMsg = 'workbuddy-bridge: request body too large (limit 33554432 bytes); '
    + 'raise WORKBUDDY_MAX_BODY_BYTES if this is a legitimate multi-modal request';
  assert.equal(recognizedByDsh(oldMsg), false,
    '如果旧文案居然能识别，那本轮的修法就站不住脚，需要重新分析');
});

test('所有 413 出口都带上了可识别的文案（没有裸 rejectTooLarge）', () => {
  /*
   * 一个端点漏掉，那条路径下的超限就仍然只回 INVALID_REQUEST、整轮失败。
   * 所以这里做**源码级**审计：每个 rejectTooLarge 调用都必须有第四个参数。
   */
  const bare = [];
  const re = /rejectTooLarge\(\s*req,\s*res,\s*[^,)]+\)/g;
  let m;
  while ((m = re.exec(SRC))) bare.push(m[0]);
  assert.deepEqual(bare, [],
    `这些 413 出口缺 message，超限时不会触发 dsh 压缩：\n${bare.join('\n')}`);
});
