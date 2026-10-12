# Codex 接入完善审计（2026-10-12）

> 依据：**Codex 官方源码**（`openai/codex`，本机二进制 `0.162.0-alpha.17.2` 实测对齐），
> 不是猜的。每条结论都给了权威出处（文件 + 行号）与本地探针证据。

## 0. 结论先行：用户报的「0s」不是桥的锅

用户症状：「不管什么时候结束都说我 0s」。

**根因定位（权威）**：Codex TUI 有**两个**不同的时间显示，别混淆：

| 显示 | 位置 | 数据来源 | 谁决定 |
|---|---|---|---|
| `Working (0s • esc to interrupt)` | 运行中状态行 | **Codex 自己的本地 `Instant` 时钟** | **Codex 内部，桥无法干预** |
| `Worked for 2m 03s • 14:32` | 回合结束后的分隔行 | 协议里的 `turn.duration_ms` | 也是 Codex 自测的墙钟 |

- **状态行的 `0s`**：`codex-rs/tui/src/status_indicator_widget.rs:76` 的
  `fmt_elapsed_compact(0) == "0s"`；值来自
  `codex-rs/tui/src/status_indicator_widget/timer.rs` 的 `StatusTimer`
  （`elapsed_at()` = `elapsed_running + (now - last_resume_at)`，纯本地时钟）。
  **桥改了也没用** —— 这是 Codex 的 UI 计时器，它只反映「用户按下回车到现在」。
  状态行显示 `0s` 通常意味着**回合刚开始**或**刚被 pause/resume 重置**。
- **结束行的 `Worked for`**：`codex-rs/tui/src/history_cell/separators.rs:59-74`。
  注意 `seconds == 0` 时它渲染的是 **`<1s`**，**永远不会是 `0s`** ——
  所以用户看到 `0s` 一定是**状态行**，不是结束行。
  `Worked for` 的值来自 `turn.duration_ms`
  （`core/src/turn_timing.rs:121` `complete_profile_and_duration_ms`，
  用 `Instant::now() - started_at` 算），**同样是 Codex 自测**。

**给用户的话**：`0s` 是 Codex 状态行的本地计时器，与桥/上游无关；
回合真正结束后那行 `Worked for …` 用的是 Codex 自测的墙钟，也不会是 `0s`。
我们能改进的是**周边**（下面这些真缺口），而不是去改它的计时器。

## 1. 真缺口（已按官方解析器逐条核对）

### 【P0】`response.incomplete` 的 reason 写错 → 整轮被 Codex 判为流错误

- **现状**：桥在 `finish_reason === 'length'` 时发
  `event: response.incomplete`，`incomplete_details.reason = "max_output_tokens"`。
- **官方判据**：`codex-rs/codex-api/src/sse/responses.rs:418-434`：
  ```rust
  let interrupted = event.kind == "response.incomplete";
  if interrupted {
      let reason = ...get("incomplete_details")...get("reason")...;
      let reason = reason.unwrap_or("unknown");
      if reason == "content_filter" { return Err(ApiError::ContentFilter); }
      if reason != "interrupted" {
          return Err(ResponsesEventError::Api(ApiError::Stream(
              format!("Incomplete response returned, reason: {reason}"))));
      }
  }
  ```
  → **只有 `"interrupted"` 是被接受的正常截断**（`content_filter` 走另一支）。
  我们发的 `max_output_tokens` **会命中 `Err(...)`**，把一次正常截断变成
  「流错误」，Codex 中断整轮。
- **探针证据**（本机，`glm-5.3`，`max_output_tokens:16`）：
  ```
  事件序列: … → response.output_item.done → response.incomplete
  incomplete_details: {"reason":"max_output_tokens"}
  end_turn: undefined
  >>> Codex 判定: FAIL — 会抛 "Incomplete response returned, reason: max_output_tokens"
  ```
- **修法**：`response.incomplete` 一律发 `reason: "interrupted"`；
  同时补 `end_turn: false`（官方 `ResponseCompleted.end_turn: Option<bool>`，
  `responses.rs:450` 在 interrupted 时强制 `Some(false)`）。

### 【P1】`response.completed` 缺 `end_turn`

- 官方 `ResponseCompleted.end_turn: Option<bool>`（`responses.rs:114`），
  且该字段会喂给会话状态机。我们发的 `response.completed` 没有它。
- 非 interrupted 时官方取 `resp.end_turn`（可为 `None`，故非致命），
  但真实 OpenAI 会带；补上更接近原生。

### 【P1】usage 明细恒为 0（`cached_tokens` / `reasoning_tokens` 丢失）

- 官方 `ResponseCompletedUsage`（`responses.rs:118-126`）会读
  `input_tokens_details.cached_tokens`（还有 `cache_write_tokens`）与
  `output_tokens_details.reasoning_tokens`，并转进 `TokenUsage`（`:128-144`）。
- 现状：`responsesUsage()` **硬编码** `cached_tokens: 0` / `reasoning_tokens: 0`，
  上游给了也丢。用户看不到缓存命中与思考 token 的账。
- 修法：透传上游 usage 里对应字段（上游 chat 协议用
  `prompt_tokens_details.cached_tokens` / `completion_tokens_details.reasoning_tokens`）。

### 【P1】`response.failed` 的 error.code 是 HTTP 数字串，不在官方错误码表里

- 官方 `responses_error.rs:47-101` 按 `error.code` 分派：
  `context_length_exceeded`→ContextWindowExceeded、`rate_limit_exceeded`/`slow_down`
  →RateLimitExceeded（**带 retry_after，可自动重试**）、`server_is_overloaded`→
  ServerOverloaded、`insufficient_quota` 等→QuotaExceeded，其余 →`Retryable`。
- 现状：我们发 `error.code = String(up.status)`（`"429"` / `"500"` …），
  **全部落到 `_ => Retryable`**。后果：
  - 上游 429（模型级限流）不会走 RateLimitExceeded，**拿不到 retry_after** →
    Codex 不会按官方节奏退避；
  - 上下文超限不会走 ContextWindowExceeded → 用户看到的是泛化「可重试」而不是
    「上下文超了」的准确提示。
- 修法：把上游状态码/错误码映射成官方认识的字串
  （429→`rate_limit_exceeded`、400 且上下文相关→`context_length_exceeded`、
  5xx→`server_is_overloaded`），并把上游的 `Retry-After` 放进
  `error.headers`（官方从 `error.headers` 里取 retry-after，
  `responses_error.rs:31-35` + `:107`）。

### 【P2】`response.created` 缺 `response.headers`（`openai-model` 回显）

- 官方 `ResponsesStreamEvent::response_model()`（`responses.rs:189-200`）
  优先从 `response.headers` 里读 `openai-model`，用于「实际生效的模型」显示。
- 现状：我们的 envelope 没有 `headers`。补上可让 Codex 显示真实模型名。

### 【P2】`x-request-id` / `x-codex-turn-state` 不回显

- 官方 SSE 解析器读 `openai-model` / `x-reasoning-included` / `x-request-id` /
  `x-codex-turn-state`（见本机二进制字符串，`responses.rs`）。
- 我们目前只发 `x-workbuddy-overhead-ms`。至少回显 `x-request-id` 便于排查。

### 【P2】工具参数 delta 逐片转发（碎裂）

- 探针显示上游把 `{"command":["echo hi"]}` 拆成 **7 片**（`{`、`"command`、`":"`…）
  原样转发。Codex 能处理，但事件噪声大。可合并（不影响正确性，属体验优化）。

## 2. 模型目录（`lib/client-connect.mjs`）缺口

官方条目 schema（本机二进制字符串，`ConfigToml`/目录条目结构）字段多达 50 个。
我们**克隆模板**这条思路是对的，但有几处必须显式定死或纠正的没做。

> ⚠️ **本节第 1 稿写错过一条，已实测纠正**（2026-10-12）：
> 初稿断言"模板的 `ultra` 会让上游 400"。实测（本机桥 + 四个在用模型
> 打 `reasoning_effort: "ultra"`）**全部 200**，且 `reasoning_tokens`
> 与 `max`/`xhigh` 同量级 —— 上游把 `ultra` 当普通高力度收下，**不报错**。
> 所以这条的问题性质是**语义误导**（用户以为能触发 Codex 的自动任务委派，
> 实际不能），不是"会失败"。判据要照实测写，不能照"看起来危险"写。

实际缺口（按修好的顺序）：

1. **档位表沿用模板、不按桥的实测值**：`supported_reasoning_levels` 里带着
   Codex 独有的 `ultra`；桥 `/v1/models` 早有逐模型实测的 `reasoning_efforts`
   （含 `minimal`——模板里**没有**这一档），但接入时没喂进目录。
   后果是**双向失真**：多一个语义误导的档，少一个真实可用的档。
2. **`max_output_tokens` 整个缺失**、`truncation_policy.limit` 停在模板的
   `10000`：桥的 `/v1/models` 明确报了单次输出预算（glm-5.3 = 64000，
   deepseek = 128000），目录却不带。Codex 于是按它自己的默认值规划输出与截断
   —— 长回答远早于上游上限就被砍断。
3. **`model_messages.instructions_template` 照抄模板**：那是 **GPT-5 Codex 的
   官方系统提示**（"You are Codex, an agent based on GPT-5"），点名要求用
   `notes` / `history` / `functions.new_context` / `apply_patch`。走我们的桥时
   **这些工具一个都不存在**（上游是 chat/completions，freeform/custom 工具
   桥翻不了）。照抄等于教模型去调幽灵工具，白烧 token 且污染输出。
4. `supports_reasoning_summary_parameter` / `default_reasoning_summary`：
   模板给 `"none"`，与桥的思维链转发能力（`WORKBUDDY_FORWARD_REASONING`）
   没对齐（**本轮未动**，见下）。
5. 桥 `/v1/models` 已有 `supports_reasoning` / `reasoning_efforts`，
   但**接入时没喂进目录条目的档位字段** —— 两份能力信息各自为政（=第 1 条）。

**本轮修掉 1 / 2 / 3**（`buildConnectBase` 把 `reasoning_efforts` /
`only_reasoning` 带下去，`makeCatalogEntry` 按实测值覆盖档位与输出预算、
换掉系统提示）。**第 4 条留着**：思维链转发是默认关的实验性开关，
目录里声明 summary 能力会让 Codex 去要一段我们默认不发的 summary，
在开关语义定论前不动它。

## 3. 待办（本轮实施）

见 HANDOVER / 提交信息。优先级：P0 截断语义 → P1 usage 明细 + failed 错误码 →
P2 头部回显 + 目录档位对齐。

### 实施结果（2026-10-12 收盘）

**桥侧（P0/P1/P2）全部落地**，`bridge/bridge-responses.test.mjs` 从 10 例扩到 19 例，
新增用例全部**先红后绿**：

| 问题 | 修法 | 用例 |
|---|---|---|
| 截断发 `reason: max_output_tokens` → Codex 抛流错误、**整轮中断** | 改 `interrupted` + `end_turn: false`（流式与非流式两处） | 13 / 14 |
| 正常收尾没带 `end_turn` | 显式 `end_turn: true` | 15 |
| usage 明细丢失 | 透传 `cached_tokens` / `reasoning_tokens` | 16 |
| 429 / 5xx / 上下文超限都是笼统 `upstream_error` → Codex 不重试、不裁剪 | `responsesErrorCode()` 映射 + `error.headers['retry-after']` | 17 / 18 / 19 |

**顺手抓到一个静默失效（测试写出来才现形）**：
`up.headers?.get?.('retry-after')` —— `up` 是 node 的 `http.IncomingMessage`，
`headers` 是普通对象、**没有 `.get()`**，可选链把 `undefined` 吞掉，
于是上游给的 retry-after 永远读不到、一律落到兜底 `'1'`。
改成 `up.headers?.['retry-after']`。这类缺陷不报错、只是行为与预期不符，
正是最该优先修的那一类。

**目录侧**：`buildConnectBase` → `makeCatalogEntry` 链路打通，实测生成结果：

```
glm-5.3              efforts=minimal/low/medium/high/xhigh/max  maxOut=64000   trunc=64000
deepseek-v4.1-flash  efforts=minimal/low/medium/high/xhigh/max  maxOut=128000  trunc=128000
deepseek-v4-pro      efforts=minimal/low/medium/high/xhigh/max  maxOut=128000  trunc=128000
```

注：`default_reasoning_level` 保持模板的 `low` —— 因为 `low` **确实在**实测表里，
不做无谓改动；只有默认档不在表内时才换成表内的 `medium`。

**顺带纠正两条既有用例**（它们把旧行为固化成了期望）：
`lib/client-connect.test.mjs` 里两处断言"系统提示照旧从模板继承（`'KEEP'` /
`'keep me'`）"—— 那正是本条要修的行为，改断言并补上新意图的说明。
