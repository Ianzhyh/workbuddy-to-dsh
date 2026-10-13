# Codex 模型目录：context_window / max_context_window / effective_context_window_percent / auto_compact_token_limit

**证据基线**：本机版本 `0.162.0-alpha.17.2` 在官方仓库有精确对应 tag `rust-v0.162.0-alpha.17.2`（GitHub tags API 确认存在）。
以下所有源码行号均取自该 tag 的 `raw.githubusercontent.com`，非 main 分支。行号已逐一核对。

---

## 结论（先给答案）

| 字段 | 单位 | 默认值 | 语义 | 是否驱动压缩 |
|---|---|---|---|---|
| `context_window` | tokens | 无默认（`Option`，缺省 = `None`） | 模型**正常服务**的窗口大小。`resolved_context_window()` 优先取它 | **间接**：是 90% 压缩阈值和百分比硬线的计算基数 |
| `max_context_window` | tokens | 无默认（`Option`） | **不是**真实窗口，是「config.toml 顶层 `model_context_window` 覆盖值的上限」。源码注释原文：`Maximum context window allowed for config overrides.` | 否（除非 `context_window` 为 `None` 时充当兜底基数） |
| `effective_context_window_percent` | 百分数 0–100 | **95** | 为 system prompt / 工具开销 / 模型输出预留 headroom 后，可用于输入的窗口占比 | **是**：构成独立的硬触发线 `resolved * pct / 100` |
| `auto_compact_token_limit` | tokens | `None` | 自动压缩阈值。**永远被钳到 `resolved_context_window * 9/10` 以内** | **是**（主触发线） |

**核心结论：`effective_context_window_percent` 与 `auto_compact_token_limit` 不是二选一，是同时生效、先到先触发（OR）。** 【官方源码】

---

## 压缩阈值的确切算法

`codex-rs/core/src/session/context_window.rs:53-117`（tag 同文件 L84/L108 一致）：

```rust
// 1) scope 决定「用哪些 token 去比阈值」（默认 Total）
active_context_tokens = sess.get_total_token_usage();
match config.model_auto_compact_token_limit_scope {
    Total            => (scope_tokens = active, scope_limit = model_info.auto_compact_token_limit()),
    BodyAfterPrefix  => (scope_tokens = active - prefill, scope_limit =
                          config.model_auto_compact_token_limit
                              .or_else(|| model_info.auto_compact_token_limit())),
}
// 2) 百分比硬线（独立于 scope）
full_context_window_limit = resolved_context_window * effective_context_window_percent / 100;
// 3) fallback buffer 只加在 scope limit 上，默认 0
buffered_auto_compact_limit = scope_limit + auto_compact_fallback_buffer_tokens;
// 4) 触发（两条线取 OR）
full_context_window_limit_reached = active >= full_context_window_limit;
token_limit_reached = (scope_tokens >= buffered_auto_compact_limit) || full_context_window_limit_reached;
```

`auto_compact_token_limit` 的钳制逻辑，`codex-rs/protocol/src/openai_models.rs:527-540`（tag 同）：

```rust
pub fn auto_compact_token_limit(&self) -> Option<i64> {
    let context_limit = self.resolved_context_window().map(|w| (w * 9) / 10);
    match context_limit {
        Some(context_limit) => Some(self.auto_compact_token_limit.map_or(context_limit,
                                   |limit| std::cmp::min(limit, context_limit))),
        None => self.auto_compact_token_limit,
    }
}
pub fn resolved_context_window(&self) -> Option<i64> { self.context_window.or(self.max_context_window) }
```

**触发点**（`codex-rs/core/src/session/turn.rs`，tag 行号）：
- PreTurn：`L1322 if token_status.token_limit_reached` → `run_auto_compact(.., PreTurn, ..)`
- MidTurn（采样后仍有后续）：`L612 should_roll_over = needs_follow_up && (new_context_window_requested || token_limit_reached)`
- PostTurn：`L724` 仅当 `model_post_turn_compact_threshold_percent > 0` 且未启用 TokenBudget 且 `turn_end_compaction_threshold_reached`
  （`context_window.rs:112`：`post_turn_percent > 0 && (token_limit_reached || active*100 >= full_limit*post_turn_percent)`）

> **修正（重要）**：`async_compaction_threshold_percent` / `DEFAULT_ASYNC_COMPACTION_THRESHOLD_PERCENT=65` / `session/async_compaction.rs` 在 tag `rust-v0.162.0-alpha.17.2` 中**不存在**（该文件在该 tag 返回 404，config 中无任何 `async_compaction` 匹配）。它们只存在于 main 分支，属于本机版本之后的新特性，**与 0.162.0-alpha.17.2 无关，不要据此配置**。

**只给 `context_window`、不给 `auto_compact_token_limit`（本机官方 cache 的实际形态）**：
- 压缩阈值 = `272000 * 9/10` = **244800**
- 百分比硬线 = `272000 * 95/100` = **258400**
- 因为 244800 < 258400，**90% 那条先触发**。若把 `effective_context_window_percent` 设到 < 90，则百分比硬线先触发。

**配置优先级链**：`with_config_overrides()` 在 `get_model_info()` 里**每次**执行（`models-manager/src/manager.rs:917-929`），把 config.toml 顶层值套到目录条目上：
- 顶层 `model_context_window` 覆盖目录 `context_window`，并被 `min(目录 max_context_window)` 钳制（`model_info.rs:20-27`）
- 顶层 `model_auto_compact_token_limit` 覆盖目录同名字段（`model_info.rs:29-31`），之后仍被 90% 规则钳制
- 目录里的 `effective_context_window_percent` **没有任何顶层对应字段**，只能写在目录里
- 顶层 `model_post_turn_compact_threshold_percent` **目录里没有对应字段**，纯顶层；范围 0–100，0 = 关闭（`config/mod.rs:3267` 校验）

---

## 目录字段 vs config.toml 顶层字段的覆盖关系

| config.toml 顶层 | 目录同名字段 | 关系 |
|---|---|---|
| `model_context_window` | `context_window` | 顶层**覆盖**目录值，再被目录 `max_context_window` 钳到不超过它 |
| `model_auto_compact_token_limit` | `auto_compact_token_limit` | 顶层**覆盖**目录值；两者最终都被 `min(90% of resolved)` 钳制 |
| `model_auto_compact_token_limit_scope` | 无 | 纯顶层，默认 `total`（枚举 `Total` / `body_after_prefix`） |
| `model_post_turn_compact_threshold_percent` | 无 | 纯顶层，默认 0（关闭），是 `token_limit_reached` 的**补充**而非替代 |
| 无 | `max_context_window` | 纯目录字段，只作为顶层 `model_context_window` 的上限 |
| 无 | `effective_context_window_percent` | 纯目录字段，默认 95，无顶层覆盖途径 |

> `model_catalog_json` 指向的文件一旦设置，**替换整个内置目录**（`config/mod.rs:1026` 注释：`When set, this replaces the bundled catalog for the current process.`），且必须含至少一个模型，否则报错 `model_catalog_json path ... must contain at least one model`（L2173）。

**未证实但值得注意的不一致**：`context_window.rs:72-74` 的 `BodyAfterPrefix` 分支用的是 `config.model_auto_compact_token_limit` **原始未钳制值**，而 `Total` 分支用的是 `model_info.auto_compact_token_limit()`（已钳制）。默认 scope 是 `Total`，所以通常走钳制路径。

**【官方源码】`effective_context_window_percent` 没有任何范围校验**：类型是裸 `i64`（tag `openai_models.rs:469`），tag 与 main 全仓库均无 0–100 校验（对比 `model_post_turn_compact_threshold_percent` 是 `u8` 且有 `must be between 0 and 100` 校验）。因此填 `0` 会让百分比硬线恒为 0（几乎立即触发），填 `>100` 会算出超过真实窗口的线。**只填 1–100 的合理值。**

---

## 对「第三方 provider 目录该怎么填」的建议值

1. **`context_window` 填真实窗口**（tokens）。这是唯一必须准的字段。
2. **`max_context_window` 可省略或填同值**。省略时顶层 `model_context_window` 不会被钳制；填了就等于给自己设了覆盖上限。
3. **`effective_context_window_percent` 省略即可（默认 95）**。若该 provider 的 system prompt / 工具 schema 特别大，可下调到 85–90，但注意 **< 90 时它会变成先触发的那条线**。
4. **`auto_compact_token_limit` 建议省略**，让 90% 规则生效；只有想**提前**压缩（留更多余量）时才显式给更小的值。给大于 90% 的值无效，会被钳掉。
5. **未知 slug 的兜底值**（`models-manager/src/model_info.rs:98-149` `model_info_from_slug`，tag L98）：`context_window = 272000`、`max_context_window = 272000`、`effective_context_window_percent = 95`、`auto_compact_token_limit = None`，并打警告 `Unknown model {slug} is used. This will use fallback model metadata.`。即**目录里 slug 没匹配上时会静默按 272000 窗口处理**——第三方 provider 务必确认 slug 能精确匹配（`CatalogSource::ExplicitProvider` 用 `candidate.slug == model` 精确比对，`manager.rs:469-477`）。
6. 本机官方 `models_cache.json` 的 8 个模型都是 `context_window=272000 / effective=95 / auto_compact_token_limit 缺失`，即压缩点 244800 —— 可直接照抄这组作为安全默认。

---

## 证据

1. **【官方源码】字段定义与默认值** — `https://raw.githubusercontent.com/openai/codex/rust-v0.162.0-alpha.17.2/codex-rs/protocol/src/openai_models.rs`
   ```
   L391: const fn default_effective_context_window_percent() -> i64 { 95 }
   L455: /// Maximum context window allowed for config overrides.
   L457: pub max_context_window: Option<i64>,
   L458: /// Token threshold for automatic compaction. When omitted, core derives it
   L459: /// from `context_window` (90%). When provided, core clamps it to 90% of the
   L460: /// context window when available.
   L462: pub auto_compact_token_limit: Option<i64>,
   L466: /// Percentage of the context window considered usable for inputs, after
   L467: /// reserving headroom for system prompts, tool overhead, and model output.
   L468: #[serde(default = "default_effective_context_window_percent")]
   ```
2. **【官方源码】三个方法体** — 同文件 `L516-540`（`resolved_context_window` / `usable_context_window` / `auto_compact_token_limit`），原文见上文引用块。
3. **【官方源码】官方单测锁定语义** — 同文件 `L1851-1882`：
   ```
   context_window=None, max_context_window=400000            => (400_000, 380_000, 360_000)
   context_window=272000, max_context_window=400000, auto_compact_token_limit=250000, effective=95
   => (resolved, usable, auto_compact) == (Some(272_000), Some(258_400), Some(244_800))   // L1879
   ```
   注意第二条：给了 `auto_compact_token_limit=250000`，结果被钳到 **244800** —— 直接证明「给大值无效」。
4. **【官方源码】触发算法** — `.../rust-v0.162.0-alpha.17.2/codex-rs/core/src/session/context_window.rs` L84-110。
5. **【官方源码】三处触发点** — `.../codex-rs/core/src/session/turn.rs` L612 / L724 / L1322。
6. **【官方源码】顶层字段语义与校验** — `.../codex-rs/core/src/config/mod.rs` L638（`model_context_window`）、L640-641（`model_auto_compact_token_limit`，注释 `Token usage threshold triggering auto-compaction of conversation history.`）、L647-649（`model_post_turn_compact_threshold_percent`，注释 `Percentage of the usable context window that triggers turn-end compaction. Zero disables turn-end compaction.`）、L3264-3267（`must be between 0 and 100`）、L1026 / L2182（`model_catalog_json`）。
7. **【官方源码】覆盖链** — `.../codex-rs/models-manager/src/model_info.rs` L19-31（`with_config_overrides`）+ `.../codex-rs/models-manager/src/manager.rs` L917-929（每次 `get_model_info` 都套用）+ `.../codex-rs/core/src/config/mod.rs` L1684-1698（`to_models_manager_config`）。
8. **【官方源码】scope 枚举** — `.../codex-rs/protocol/src/config_types.rs` L43-55（`Total` 为 `#[default]`）。
9. **【本机二进制】** 目录条目 JSON 中 `"context_window": 272000, "max_context_window": 872000, "auto_compact_token_limit": null, "comp_hash": "3000"` 与 `effective_context_window_percent: 95` 兜底值 —— `_codexstrings.txt` L2399999 附近、L2403602（`session_telemetry.rs` 上报字段 `context_window` / `auto_compact_token_limit`）。
10. **【未证实】** `BodyAfterPrefix` 分支未钳制 config 值这一不一致（见上文），源码可读但官方无注释说明是否有意为之。

**未找到**：官方 config 参考文档页中关于 `model_catalog_json` 字段级说明（本次 web_search 端点返回 401、`github.com` / `raw.githubusercontent.com` 对 `web_fetch` 工具不可达，仅能经 PowerShell 直连 raw 文件；未检索到文档页，故不引用）。
