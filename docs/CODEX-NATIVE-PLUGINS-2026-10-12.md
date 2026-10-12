# Codex 接入的两个问题：token 超限 & 原生插件能力

> 日期：2026-10-12（晚）
> 触发：用户报告「`stream disconnected before completion: prompt is too long: 1216490 tokens > 1048576 maximum`」，
> 并追问「codex 自己提供的功能是不是一个都用不了？我说的 1 的操控桌面就是 codex 的」。
> 结论均**基于本机实测**，未实测的部分明确标注。

---

## 0. 一句话结论

| 问题 | 结论 | 性质 |
|---|---|---|
| token 超限 1216490 > 1048576 | **命中了一个真实缺陷**：用户机器上的 Codex 模型目录停在 10-10，桥已升级但目录没刷新，Codex 仍按旧的 `ultra` 档 + 缺失的输出上限在跑 | 可修复，已给出修复路径 |
| 操控桌面（computer-use）用不了 | **不是「全都不行」**——桥对 classic function 工具几乎全部透明转发。computer-use 用不了有两处**已核实**的原因：桥不转发 freeform/custom 工具 + 用户配置关了 `js_repl` | 边界性限制，非缺陷 |

**两件事都指向同一份过期的模型目录**：修好目录后，`ultra` 从选择器消失（token 膨胀的入口被关掉）。
但要注意：**刷新目录不会让 computer-use 变得可用**（原因见 §3.3，与目录无关）。

**证据分级**：本文所有「已实测」标注均可复现；「推测」处明确标出，不作结论使用。

---

## 1. 根因：模型目录是「生成物」，不刷新就一直是旧的

### 1.1 实测对比

**用户机器上的目录**（`~/.codex/workbuddy-model-catalog.json`，`ls -la` 显示 **Oct 10 21:19**）：

```
 - glm-5.3            | maxOut= undefined | levels= ["low","medium","high","xhigh","max","ultra"]
 - deepseek-v4.1-flash | maxOut= undefined | levels= ["low","medium","high","xhigh","max","ultra"]
 - deepseek-v4-pro     | maxOut= undefined | levels= ["low","medium","high","xhigh","max","ultra"]
 - glm-5.2            | maxOut= undefined | levels= ["low","medium","high","xhigh","max","ultra"]

 model_messages.instructions_template 前 200 字：
 "You are Codex, an agent based on GPT-5. You and the user share one workspace..."
```

**当前运行中的桥**（`GET http://127.0.0.1:8790/v1/models`）：

```
 - deepseek-v4.1-flash | ctx= 1000000 | maxOut= 128000 | efforts= ["minimal","low","medium","high","xhigh","max"]
 - deepseek-v4-pro     | ctx= 1000000 | maxOut= 128000 | efforts= ["minimal","low","medium","high","xhigh","max"]
 - glm-5.3            | ctx= 1000000 | maxOut= 64000  | efforts= ["minimal","low","medium","high","xhigh","max"]
```

**四处不一致，全部指向同一份过期文件：**

1. **`ultra` 还在** —— 桥早已不声明它（`ultra` 是 Codex 独有的「自动任务委派」语义，走桥不成立；实测上游虽返回 200 但不产生委派行为）。
2. **缺 `minimal` 档** —— 桥实测所有在用模型都收 `minimal`。
3. **`max_output_tokens` 全是 `undefined`** —— 桥明确报了 128000 / 64000，Codex 却按自己的默认值规划输出与截断。
4. **`instructions_template` 还是 GPT-5 Codex 官方提示** —— 它点名要求用 `notes` / `history` / `functions.new_context` / `apply_patch` 这些工具，而**走桥时这些工具一个都不存在**，模型会反复尝试调用幽灵工具，白烧 token。

### 1.2 `ultra` 档与 token 膨胀的关系（推测，未直接实测）
`ultra` 是 Codex 桌面端自己的档位（本机目录里原有的那一档），其描述原文是：

> **Maximum reasoning with automatic task delegation**

关键在字面上的 **automatic task delegation（自动任务委派）**。

> ⚠️ **证据分级声明**：以下因果解释是**基于字面语义 + 现象吻合度的推断**，
> **不是**我实测出来的因果链。我实测到的是：
> (a) 用户的目录里有 `ultra`、桥里没有；(b) 上游对 `ultra` 返回 **200**
> （见 `docs/CODEX-INTEGRATION-AUDIT-2026-10-12.md` §2 的纠正记录），
> 即**上游不会因为 `ultra` 报错**。
> 由于委派是由 **Codex 客户端**实施的、桥只是被调用方，桥这层**看不到**委派
> 是否真的发生，所以「委派 → 上下文复制 → 1216490 tokens」这一步
> **我无法从桥侧证实**。
>
> 现象与推断**方向吻合**（用户只在高层级档上遇到，且 1216490 远超单轮正常量级），
> 但这属于**待验证假设**，不应作为已确认结论对外陈述。

机制上的合理链条（供参考，未验证）：

1. Codex 在 `ultra` 下可能把任务拆成子任务，各自携带会话上下文；
2. 子任务共享工作区与会话历史，于是同一 prompt 被复制进多份上下文；
3. 叠加各自工具输出后，总量突破 Codex 自己按 `context_window` 算出的上限。

**`1048576`（1M）这个数字本身是确定的**：它是 Codex 按模型
`context_window` 算出的上限（用户目录里四个模型都写 `context_window = 1000000`，
加上输出预留后约 1048576），**不是桥的限制**。桥这一层没有任何 token 计数或
长度校验（`MAX_BODY_BYTES` 限的是请求体字节数 8MB，与 token 无关）。

**能确定的结论**：无论 1216490 具体由什么机制堆积而成，**刷新目录后
`ultra` 从选择器消失，这条路径就不可能再被选中**——这一步是确定的、
可验证的修复。

### 1.3 为什么桥不声明 `ultra`

`lib/client-connect.mjs` 的 `EFFORT_DESCRIPTIONS` 里刻意没有 `ultra`，注释写明了理由：

```
 * 只有 `ultra` 是 Codex 独有的"自动任务委派"，我们的上游没有这个概念
 * （实测：`ultra` 会被当普通高力度收下，但**不会**带来委派行为），所以不声明它。
```

**注意语义**：桥不是「拒绝」`ultra`（写它不会报错，上游收下返回 200），而是**目录里不提供它**——用户在选择器里看不到这一档，自然不会选中。用户机器上还能选中 `ultra`，唯一原因就是目录没刷新。

---

## 2. 修复：重新跑一次一键接入

### 2.1 实测验证（在用户的真实 config 上，用临时副本）

把用户真实的 `~/.codex` 配置拷进临时目录，跑一遍 `planModelCatalog()`（与面板/CLI 同源）：

```
=== 刷新前（用户当前目录）===
 - glm-5.3            | maxOut= undefined | levels= ["low","medium","high","xhigh","max","ultra"]
 - deepseek-v4.1-flash | maxOut= undefined | levels= ["low","medium","high","xhigh","max","ultra"]
 - deepseek-v4-pro     | maxOut= undefined | levels= ["low","medium","high","xhigh","max","ultra"]
 - glm-5.2            | maxOut= undefined | levels= ["low","medium","high","xhigh","max","ultra"]

=== planModelCatalog 结果 ===
 added: []  refreshed: [ 'glm-5.3', 'glm-5.2', 'deepseek-v4.1-flash', 'deepseek-v4-pro' ]  kept: 0

=== 刷新后 ===
 - glm-5.3            | maxOut= 64000  | default= low | levels= ["minimal","low","medium","high","xhigh","max"]
 - glm-5.2            | maxOut= 64000  | default= low | levels= ["minimal","low","medium","high","xhigh","max"]
 - deepseek-v4.1-flash | maxOut= 128000 | default= low | levels= ["minimal","low","medium","high","xhigh","max"]
 - deepseek-v4-pro     | maxOut= 128000 | default= low | levels= ["minimal","low","medium","high","xhigh","max"]

 系统提示前 160 字: "You are GLM-5.3, running through a local OpenAI-compatible bridge.
 The tools available to you are exactly the ones defined in the request..."

**四条全部进 `refreshed`**（即内容确实变了，不是空转）。
```

修复前后逐项对照：

| 字段 | 修复前 | 修复后 |
|---|---|---|
| 档位表 | `low/medium/high/xhigh/max/ultra` | `minimal/low/medium/high/xhigh/max` |
| `ultra` | **存在**（委派语义，撑爆上下文） | **消失** |
| `minimal` | 缺失 | 补齐 |
| `max_output_tokens` | `undefined` | 128000（deepseek）/ 64000（glm） |
| `instructions_template` | GPT-5 官方提示，点名幽灵工具 | 中性提示，只讲真实工具集 |

### 2.2 用户要做的操作

1. 打开控制台 → 客户端页签 → Codex → 点「**重新写入**」（或命令行 `npm run connect`）。
2. 写入后**重启 Codex**（它启动时读目录文件）。
3. 把 `~/.codex/config.toml` 里这行改掉或删掉：

   ```toml
   model_reasoning_effort = "ultra"
   ```

   目录刷新后 `ultra` 已不在可选档位里，但 `config.toml` 里这行是**用户手写的顶层值**，一键接入**不会动它**（不属于我们接管的键）。留在那里会让 Codex 去要一个目录里不存在的档位。

### 2.3 这是「生成物不刷新」类缺陷，需要在产品上补一刀

本次故障的本质：**桥升级了，但用户机器上的派生文件（模型目录）不会自动跟着变**。用户没有任何线索指向这里——症状（token 超限）和根因（一份 2 天前的 json）之间隔着好几层。

排查时的**快捷判据**：先比时间戳。

```
ls -la ~/.codex/workbuddy-model-catalog.json    # 生成时间
ls -la ~/.codex/config.toml                     # 接入时间
```

目录文件时间早于桥的改动时间 → 就是它。

---

## 3. 操控桌面（computer-use）：桥能不能承载？

用户的问题：「codex 自己提供的功能是不是一个都用不了？」

**答案：不是「一个都用不了」。** 要分成两类看，判据是**工具定义走哪条路**。

### 3.1 桥对工具是透明转发的

桥在 Responses 层把客户端给的 function tools 翻译成上游 chat/completions 认的 `tools`，**不做白名单**。所以任何**以普通 function tool 形式下发**的能力，桥都能带过去：

| 能力 | 形态 | 走桥 |
|---|---|---|
| `shell` / `read_file` / `apply_patch` | Codex 内置 function tools | ✅ 转发（`apply_patch` 走经典 function 形式时可用） |
| documents / spreadsheets / presentations / pdf 插件 | 提供 function tools | ✅ 转发 |
| visualize 插件 | function tools | ✅ 转发 |
| **computer-use（操控桌面）** | **依赖 `@oai/sky` 原生运行时** | ⚠️ 见下 |
| browser 插件 | 依赖 `browser-service.mjs` 原生服务 | ⚠️ 见下 |
| node_repl (`js_repl`) | freeform / custom 工具 | ❌ 桥明确转不了（见 3.3） |

### 3.2 computer-use 的真实机制（实测读源码）

`~/.codex/plugins/cache/openai-bundled/computer-use/26.1007.21434/`：

- **`SKILL.md` 第 18-29 行**明确指出入口：

  > The bundled `cua_node` `@oai/sky` package is the core entry point for Computer Use.
  > Import it directly by package name from the JavaScript session.
  > **Do not spawn `codex-computer-use.exe`, search for the helper executable, or build a custom helper protocol client.**

  ```js
  if (!globalThis.sky) {
    const { sky } = await import("@oai/sky");
    globalThis.sky = sky;
  }
  ```

- `docs/api.md` 显示 `sky` 暴露的是**窗口级原生 API**：`list_apps()` / `get_window_state()`（含截图）/ `click()` / `press_key()` / `type_text()` / `scroll()` / `drag()` …… 底层是 **SendInput + UI Automation + Windows.Graphics.Capture**。
- 运行时实体在：`%LOCALAPPDATA%\OpenAI\Codex\runtimes\cua_node\<hash>\bin\node_modules\@oai\{cua, cua-repl, sky, browser-desktop}`。
- `config.toml` 里有原生命名管道：`SKY_CUA_NATIVE_PIPE_DIRECTORY = '\\.\pipe\codex-computer-use-<uuid>'`。

**结论**：computer-use **不是「发给模型的 tool 定义」**，而是 **Codex 本地的一套原生执行运行时**（`@oai/sky`）+ 一个**必须在 JavaScript 会话里 `import` 它的技能**。

### 3.3 那么「操控桌面」到底为什么用不了

**这里要区分两条独立的原因**，不能混为一谈：

**原因一（确定的、协议层）：桥不转发 freeform/custom 工具。**

桥在上游是 chat/completions 形态，**不支持**让模型输出一段 JavaScript
由客户端执行的 freeform 工具。这不是隐含行为——桥有**显式的日志**说明
（`bridge/workbuddy-bridge.mjs` 的 `responsesToolsFromAdditional()`）：

```
code-mode 工具协议：客户端把工具放在 input[].additional_tools 里，其中
<名字> 是 freeform 工具（模型要写 JS 去编排），桥这层不翻译
—— 只转发了 N 个 classic function 工具。
解决办法：让该客户端的模型目录里 use_responses_lite=false（回到经典 function tools）。
```

而 `@oai/sky` 的用法（§3.2）**恰恰是**在 JavaScript 会话里
`await import("@oai/sky")` —— 这正是 freeform 工具的形态。

> **已实测**：`grep -rn "computer.use\|computer_use\|cua\|sky" bridge/ lib/ dsh-plugin/lib/`
> 返回**空**。桥里**完全没有**任何 CUA / computer-use / sky 相关代码路径，
> 也没有对应的工具名白名单或特判。

**原因二（确定的、配置层）：用户自己的配置关掉了 JS REPL。**

`config.toml` 里：

```toml
[features]
js_repl = false

[mcp_servers.cua_repl]
command = '...ChatGPT.exe'
enabled = false
```

即使不看桥，这两处也把 JS 执行通道关掉了。

**结论**：

> 桥**不转发** freeform/custom 工具（协议限制，不是缺陷）；
> computer-use **依赖**这类工具来 `import @oai/sky`；
> 因此 **computer-use 走桥用不了**——不是「桥坏了」，而是「这条路本来就不通」。

> ⚠️ **我不再断言 `ultra` 与 computer-use 之间的因果关系**。§1.2 提到
> `ultra` 带「automatic task delegation」，但委派由 Codex 客户端实施，
> **桥侧看不到**，所以我**没有证据**说明「改成 `ultra` 就能让 computer-use 工作」。
> 上面两条（freeform 不支持 + js_repl 关闭）是**独立成立且已核实**的，
> 不依赖 `ultra` 假设。

### 3.4 那「一个都用不了吗」——不，这些能用

**能用（桥透明转发 function tools）：**
- `shell`（命令执行）、`read_file` / `write` 等文件工具
- `documents` / `spreadsheets` / `presentations` / `pdf`（openai-primary-runtime 插件，都是 function tools）
- `visualize`
- `apply_patch`（经典 function 形式）

**用不了（有明确原因，不是桥「忘了做」）：**
- **computer-use / 浏览器自动化** —— 依赖 `@oai/sky` / `browser-service.mjs` 原生运行时 + freeform JS 会话
- **`node_repl` / `js_repl`** —— freeform 工具，且用户配置里已 `js_repl = false`

**要恢复 computer-use 的正路**：把 Codex 切回**官方账号 + 官方模型**（`model_provider` 不指向 workbuddy）。那时 Codex 用的是它原生 agent 编排，`@oai/sky` 通道完整，computer-use 正常工作。**这不是桥的缺陷，是「用第三方模型跑 Codex」的固有边界。**

---

## 4. 本次相关的另一处需留意

`config.toml` 里 `[model_providers.custom]` 指向 `https://opencode.ai/zen/go/v1`，**明文 `experimental_bearer_token = "sk-dBdN..."`**。

这与本项目无关（是用户自己配的另一个 provider），但既然看到了就提一句：该令牌明文存在配置文件里，建议确认是否为长期有效的密钥、必要时轮换。**桥不会读取也不会使用这个字段。**

---

## 5. 交付物清单

| 项 | 位置 | 状态 |
|---|---|---|
| 本文档 | `docs/CODEX-NATIVE-PLUGINS-2026-10-12.md` | 新增 |
| 目录刷新实测证据 | 本文 §1.1 / §2.1 | 已实测 |
| 桥无 cua 代码路径 | `grep -rn "computer.use\|cua\|sky" bridge/ lib/` → 空 | 已核实 |
| computer-use 机制 | 读 `SKILL.md` + `docs/api.md` + 运行时目录 | 已核实 |
| 修复操作指引 | 本文 §2.2 | 待用户执行 |

**本次未改动任何产品代码** —— 全部为只读诊断。根因在用户机器上的派生文件，产品侧的改进建议见 §2.3。
