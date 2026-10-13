# Codex 自带 computer-use 走桥：根因与修复（2026-10-13）

> 触发：用户要求「接入 Codex 能用 computer-use，先找开源实现学习」。
> 结论均基于本机实测；未实测处明确标注。本文**修正** `CODEX-NATIVE-PLUGINS-2026-10-12.md` §3.3 的一个归因。

---

## 0. 一句话结论

**computer-use 走桥用不了，不是"协议本来不通"，而是桥把这条链路唯一的入口静默丢掉了。**

Codex 把 MCP server 的工具（含 computer-use 的唯一入口 `mcp__node_repl.js`）**延迟下发**：
模型必须先调 `tool_search` 检索，命中结果下一轮才出现在 `input[]` 里。桥原先把
`tool_search` 当"上游没有的内置工具"丢掉、把 `input[]` 里的 `tool_search_output` 当
reasoning 一起丢掉 → 模型永远发现不了那个工具，而且**全程不报错**。

---

## 1. 证据链（全部可复现）

| # | 证据 | 来源 |
|---|---|---|
| 1 | Codex 向自定义 provider 发的 `tools[]` 只有**内置工具** + `tool_search` + `web_search`；MCP 工具一个都不在里面 | 真机抓包：`codex.exe 0.162` + 桩上游 + streamable HTTP MCP，27 个场景矩阵（`.workbuddy/artifacts/capture-codex-mcp-tools.md`） |
| 2 | 检索命中的工具以 `tool_search_output` 出现在**下一轮 `input[]`**，形状是 `{type:"namespace", name:"mcp__<server>", tools:[{type:"function", name:"<短名>", defer_loading:true, parameters:{…}}]}` | 同上 + `codex app-server generate-json-schema` 的 `DynamicToolSpec` 逐字一致 |
| 3 | **跑通过的** computer-use 会话（2026-08-09，provider=openai）里：2 次 `tool_search_call` → `tool_search_output`（含 `mcp__node_repl` 的 `js` / `js_reset` / `js_add_node_module_dir`）→ **135 条** `function_call{name:"js", namespace:"mcp__node_repl"}` → 179 次 `mcp_tool_call_end`；首条调用正文正是 `await import('@oai/sky')` | `~/.codex/sessions/2026/08/09/rollout-…019fe426….jsonl` 逐条解析 |
| 4 | Desktop + workbuddy 的会话（10-12 / 10-13 共 6 份 rollout）里上述项**一个都没有**；桥日志 `tools=10`（修复前）/`11`（修复后）恰好等于"内置 11 个 function"，`tool_search` 与 `web_search` 被丢后不可见 | rollout 直方图对比 + `bridge/bridge.log` |
| 5 | 修正：`mcp__node_repl.js` **不是** freeform/`custom` 工具，是带 `{code,title,timeout_ms}` 的普通 MCP 工具 | 证据 3 的 135 条调用形状 + node_repl 的 MCP instructions 原文 |

**为什么 10-12 的归因错了**：当时只看到"桥不转发 freeform"，就推断"`@oai/sky` 要在 JS 会话里
import，而 JS 会话是 freeform，所以不通"。实际链路是 **`js`（普通 MCP 工具）→ JS 内核里
import `@oai/sky`** —— `js` 本身从来不依赖 freeform 通道。freeform 修复（同日另一提交）解决的是
`apply_patch`，与 computer-use 无关。

---

## 2. 桥的修复（三处静默丢弃 → 一张路由表）

`bridge/workbuddy-bridge.mjs` 新增 `buildToolRoutes(body)`：一次请求建一张路由表，
请求侧拍平、回包侧还原。

| 方向 | 处理 |
|---|---|
| 请求：`tools[]` 里的 `type:"tool_search"` | 翻成同名普通函数（参数 `{query, limit?}` 原样） |
| 请求：`tools[]` 里的 `type:"namespace"` 分组 | 内层拍平成 `mcp__<server>__<tool>` |
| 请求：`input[]` 里的 `tool_search_output` | 里面的工具**补进上游 `tools[]`**（去重；`deferred` 名单记进路由表） |
| 请求：历史里的 `tool_search_call` | 回放成 assistant.tool_calls（名字 `tool_search`，参数 JSON） |
| 请求：历史里的 `function_call{namespace}` | 拍平成出站声明过的同一个名字 |
| 回包：模型调 `tool_search` | `tool_search_call`（`execution:"client"`，`arguments` 是**对象**） |
| 回包：模型调分组工具 | `function_call`，**短名 + 独立 `namespace` 字段** |
| 回包：`tool_search_output`（历史） | 转成 `role:"tool"` 消息，列出命中工具名（只列名字，描述随 `tools[]` 走，不抄两遍） |

日志：`→ [responses] … tools=N freeform=… deferred=… tool_search=1 names=[…]`。
**名字是这次能定位问题的唯一钥匙** —— 只记个数时，"少了什么"完全不可见。

---

## 3. 客户端侧还需要什么（桥管不到的）

| 条件 | 本机状态 |
|---|---|
| `[plugins."computer-use@openai-bundled"] enabled = true` | ✔ 已开 |
| `[mcp_servers.node_repl]` 指向 `node_repl.exe` + `NODE_REPL_TRUSTED_SERVICES` 含 `"sky":"@oai/sky/service"` + `NODE_REPL_NODE_MODULE_DIRS` 指向 cua_node | ✔ 已配（config.toml:97-119） |
| 原生通道：`SKY_CUA_NATIVE_PIPE=1` + 当次 Desktop 生成的管道目录（**每次启动都变，不要写死**） | ✔ Desktop 在跑时会注入 |
| `[features] js_repl = false` | ✗ **no-op**：0.162 里该 flag 已 `removed`，不影响 |
| Desktop 生成目录后**重启 / 新开对话**才重读 | 需要用户操作 |
| 模型侧：真去调 `tool_search` 并正确写 JS | 取决于上游模型；系统提示补充说明已给出可直接照抄的检索示例 |

---

## 4. 验证记录

**已验证（2026-10-13 15:01，Codex Desktop 真机，第三方模型 deepseek-v4.1-flash）**：

完整链路一次跑通，rollout 与桥日志双重证据：

1. `tool_search_call` ×1 → 桥回 `tool_search_call` → **Codex 照常执行了检索**
   （此前唯一的未验证项，已闭环）；
2. `tool_search_output` 命中 `mcp__node_repl` 的三个工具 → 桥日志
   `deferred=mcp__node_repl__js_reset,mcp__node_repl__js,mcp__node_repl__js_add_node_module_dir`，
   发往上游的 tools 从 41 → 44；
3. 模型发出 `function_call{name:"js", namespace:"mcp__node_repl"}`（短名 + namespace 字段）→
   Codex 路由到 node_repl → JS 内核真的执行（模型在里面 `execSync` 跑 PowerShell 拿到
   全部可见窗口的 PID/进程/标题）。

**经验**：

- **`@oai/sky` 层已实测（2026-10-13 15:5x，用户真机）**：`import` 成功（导出 `sky`）、
  `list_apps` / `activate_window` / `get_window_state({include_screenshot:true})` 全通，
  截图经 `nodeRepl.emitImage` 真的回到了对话里。**computer-use 至此全链路可用。**
- sky 的实战行为与类型定义有出入（模型实测发现的，排错时先对这几条）：
  1. 最小化的窗口 `get_window_state` 报 `window is minimized`，先 `activate_window` 再截；
  2. `get_window` 拒绝 `{app, id, title}` 对象（`id must be an integer >= 0`），
     但同样的对象直接传给 `get_window_state` 反而成功；
  3. 返回结构是 `{accessibility, screenshots, window}` —— 图片在 **`screenshots` 数组**里，
     每项 `{type:"input_image", image_url:"data:image/jpeg;base64,…"}`，没有顶层的
     `screenshot` 字段。
- BM25 检索吃关键词：要让模型用「node_repl js execute javascript persistent kernel」这类
  具体词搜；模糊的"操控电脑"会搜到 `codex_app` 那批（实测踩过）。
- **改了 `lib/client-connect.mjs` 后必须重新 `npm run connect apply codex`**，否则模型目录
  还是旧的（0 处提到 tool_search，模型不知道要先检索）——"生成物不刷新"这类坑的又一例。
- 本机 `codex exec` 的 **stdio MCP 起不来**（`ERROR_PIPE_BUSY`，连官方 `node_repl.exe` 也一样），
  任何 MCP 相关的本机实验都用 `codex mcp add --url`（streamable HTTP）。

---

## 5. 开源实现调研的结论（为什么选"修桥"而不是引第三方）

调研报告：`.workbuddy/artifacts/research-oss-computer-use.md`（27 项，含链接）。
判据：**A 形（模型侧工具定义）桥能转发；B 形（客户端原生运行时）桥够不着。**

- Anthropic 官方 `computer_20251124` 有 name 无 `input_schema`（转发后参数退化成空壳）、
  新 `computer_toolset_20260801` 无 name（被过滤）→ 都接不进来，只能借鉴 action 划分。
- 第三方 Windows MCP server（`CursorTouch/Windows-MCP` 8.8★、`cua-computer-server` MIT 40+ 工具）
  属 A 形，桥零改动可转发 —— **是备选路线**，但要引入 Python/uv 依赖，且与本仓
  "零依赖、单账号、自包含"的定位冲突。
- Codex 自带的 `@oai/sky` 路线零额外依赖、审批走 Codex 自己的弹窗、截图进模型上下文，
  唯一的缺口就是本文修的那三处丢弃 → **优先修桥**。
- 澄清：star 最高的 DesktopCommanderMCP（~10k★）只有终端/文件能力，无 GUI，不相关。

---

## 6. 交付物

| 项 | 位置 |
|---|---|
| 桥修复 + 头部契约第 7/8 条 | `bridge/workbuddy-bridge.mjs`（`buildToolRoutes` / `flattenToolName` / `withDeferredTools` / `TOOL_SEARCH_NAME`） |
| 用例 +5（撤掉任一处修复即红） | `bridge/bridge-responses.test.mjs` |
| 系统提示补充说明更新 | `lib/client-connect.mjs` / `lib/client-connect.test.mjs` |
| MCP 抓包矩阵（27 场景） | `.workbuddy/artifacts/capture-codex-mcp-tools.md` + `tools/dev/codex-mcp-tools-probe/` |
| 开源调研 / Codex 原生机制调研 | `.workbuddy/artifacts/research-oss-computer-use.md` / `research-codex-native-computer-use.md` |
| vendor 同步 | `dsh-plugin/vendor/`（`vendor:check` 过） |
