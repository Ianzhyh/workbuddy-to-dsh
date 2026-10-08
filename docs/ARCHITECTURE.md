# 架构

## 整体链路

```
┌──────────────────────────────┐
│ DeepSeek Harness / 任意客户端 │
│  （OpenAI 兼容，自定义 Base URL）│
└───────────────┬──────────────┘
                │ POST /v1/chat/completions
                ▼
┌──────────────────────────────┐
│ 127.0.0.1:8790  桥            │   只绑回环
│  bridge/workbuddy-bridge.mjs  │
│                               │
│  ① 取客户端密钥 → 解开凭据      │
│  ② 注入鉴权与追踪头            │
│  ③ 非流式 → 流转式再聚合        │
│  ④ developer → system 角色    │
└───────────────┬──────────────┘
                │ POST /v2/chat/completions（原生 OpenAI 协议）
                ▼
┌──────────────────────────────┐
│ copilot.tencent.com          │
│  （APISIX 网关 + 模型服务）     │
└──────────────────────────────┘

┌──────────────────────────────┐
│ 127.0.0.1:8792  控制台         │   只读状态 + 管理桥进程
│  dashboard/server.mjs         │
└──────────────────────────────┘
```

**关键点：桥不做协议翻译。** 上游后端本来就实现 OpenAI 协议，桥只需要补上
"入口"和"鉴权"两件事。

---

## 一、凭据：AtRest 信封

### 背景

WorkBuddy 桌面端自 **5.6.0** 起强制开启 AtRest 加密，登录文件
（`%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info`）中
的敏感字段由明文改为信封结构：

```json
"accessToken": {
  "$wbEncrypted": 1,
  "envelope": "eyJzdWl0ZSI6MSwia2V5SWQiOiI5MTI3ZGVhMWI0NDAyMGE3Ii...（base64）"
}
```

其中 `envelope` 是 `base64(JSON{suite, keyId, nonce, authTag, ciphertext})`。

### 密钥从哪来

密钥**不落盘**，只通过客户端自己的 Electron 原生绑定暴露。因此本项目向
**写这个文件的那个客户端**索取：

```js
spawnSync(workbuddyExe, ['-e',
  "process.stdout.write(process._linkedBinding('electron_browser_workbuddy_storage').loggerGet())"
], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],   // ← 必须
})
```

返回 `{version, atRestSecretKey, atRestDeveloperPublicKey}`。

### 派生与解密

```
key   = SHA256(atRestSecretKey)            哈希的是 base64 字符串本身，不是解码后的字节
keyId = SHA256(key).hex()[0:16]            与信封 keyId 比对，不符即报错
plain = AES-256-GCM(key, nonce, authTag, ciphertext, AAD)
```

AAD 按固定转录拼接，写错就会 tag 校验失败：

```
"WB-AAD\0" | 0x01 | len("WBEV1") | len("sym-v1")
           | uint32BE(suite) | len(keyId) | 0x02 | 0x00 | 0x00

len(s) = uint32BE(utf8 字节长度) + utf8 字节
```

自检方式：派生出的 `keyId` 应与 `~/.workbuddy/keyblob` 中记录的
`protectorKeyId` 一致。本项目实测为 `9127dea1b44020a7`，两处吻合。

### 两个设计决策

| 决策 | 理由 |
|---|---|
| **密钥缓存** | 每次取密钥要启动一次 Electron（约 340ms）。密钥是编译期常量，进程生命周期内缓存一次即可 |
| **不写回登录文件** | 登录文件现在是加密存储。若把刷新后的明文令牌写回，会破坏客户端凭据、导致用户被迫重新登录。刷新结果只留在桥的内存里（`memoryAuth`） |

---

## 二、桥的四个适配点

上游有四条不成文约束，都会直接返回 400/401：

| 约束 | 上游响应 | 桥的处理 |
|---|---|---|
| 只接受流式请求 | `400 code 11101` | 非流式请求内部转流式，再把分片聚合成单个 `chat.completion` |
| 不识别 `developer` 角色 | `400 code 11128` | 重写为 `system`（新版 OpenAI 规范客户端会踩这条） |
| `tool_choice` 只认字符串 | `400 code 11101` | 对象形式归一化为字符串（见下） |
| 校验调用方身份 | `400 code 11128` | 请求头伪装成官方客户端 |

**关于 `tool_choice`**：OpenAI 规范允许字符串（`none`/`auto`/`required`）与对象
（`{"type":"function","function":{"name":"…"}}`）两种写法，上游的 Go 结构体把它
声明成了 `string`，收到对象会以
`cannot unmarshal object into Go struct field Request.tool_choice of type string`
拒绝。Cursor / Trae / opencode 这类基于 AI SDK 的 Agent 客户端会发对象形式。

桥的映射规则是 `{type:'function'}` → `required`（上游没有「指定某一个函数」的
表达，取语义最接近的一档）；**认不出来的对象一律丢弃而不是原样转发**——留着必然
400，丢掉最多退化成 `auto`，后者显然更好。

这条与 `developer` → `system` 是同一类问题（上游比规范更严），所以两者都放在
`normalizePayload` 里，**在同一次改写中完成**，避免为每一条约束各写一个补丁。

外加一条本地约束：**Windows 上用 `execFileSync` 启动 Electron 必定 `EBUSY`**，
因为该 API 默认会为 stdin 打开管道。必须 `spawnSync` + `stdio: ['ignore','pipe','pipe']`。

> 这条坑在本项目中出现过两次：一次是启动 Electron 取密钥，一次是在控制台里调用
> `netstat -ano`（`execSync` 会经 `cmd.exe`，同样 EBUSY）。因此
> [`dashboard/server.mjs`](../dashboard/server.mjs) 封装了 `systemExe()` 直连绝对路径。

---

## 二·五、双上游网关

WorkBuddy 有**国内与国际两套网关**，必须按登录域名选择，选错直接 401：

| 登录域名 | 上游网关 |
|---|---|
| `copilot.tencent.com`（国内版默认） | `https://copilot.tencent.com` |
| `workbuddy.ai` / `workbuddy.cc`（国际版） | `https://www.workbuddy.ai` |
| `codebuddy.ai` | `https://www.codebuddy.ai` |

原实现只判断 `codebuddy.ai`，于是 `www.workbuddy.ai` 落到了国内网关。这个缺陷
**只有在存在国际版账号时才会暴露**——多账号切换功能正好把它翻了出来。

两边还有一条行为差异：**国际版要求首条消息必须是 `system`**，纯 `user` 开头会被
`400 code 11128 first message is not system prompt` 拒绝（国内版则容忍）。桥因此在
消息规范化阶段统一确保首条为 `system`（必要时补一条中性的），两家网关都能通过。

## 二·六、模型目录与积分

### 模型目录：两个端点必须**合并**

两个端点返回的**不是同一份目录**，单用任何一个都会漏：

| 端点 | 内容 | 国内 | 国际 |
|---|---|---|---|
| `/v2/enterprises/personal/models` | 具体模型（带倍率、标签、厂商） | 31 个 | 18 个 |
| `/v3/config` | 产品配置，`models` 是**档位/内部型号** | 21 个 | 15 个 |

因此桥**两个都请求、按 id 合并**（具体模型优先，档位补后），实测：

| 区域 | 修正前 | 修正后 |
|---|---|---|
| 国内 | 13 | **31** |
| 国际 | 13 | **26** |

> **`/v3/config` 的 `models` 是档位**（`default-model`、`enhance-1.0`、`nes-1.2` 这类），
> 不是客户端界面里看到的模型。只看它就会得出"国际版没有 Deepseek-V4.1-Flash"的错误结论。

### 促销徽章（Free now）

`/v3/config` 的 `data.modelPromotions` 是**促销标注**，不是模型：

```js
{ badge: "Free now" | {text,color}, discount, enabled,
  modelIds: ["hy3", "hy4-preview"], kind, priority, schedule }
```

它通过 `modelIds` **给已有模型挂徽章**。注意别把它当模型加进目录
（`id` 是促销 id，不是模型 id）。桥把它解析成模型的 `badge` 字段，控制台以红色标签展示。

### 目录接口**不完整**——不能当唯一真相

实测：国际版能**成功调用** `deepseek-v4.1-flash`（1128ms 返回正常结果），
但它**不出现在任何一个目录端点里**：

| 模型 ID | 上游调用 | 目录中 |
|---|---|---|
| `deepseek-v4.1-flash` | ✅ 成功 | ❌ 缺席 |
| `deepseek/deepseek-v4.1-flash` | ❌ 11102 不存在 | ❌ 缺席 |

因此桥**始终补上目录里缺失的精选模型**（`pickFeatured` 不再过滤，目录没有就用定义值），
并在 `shape.supplemented` 里记录补了哪些。修正后国际版 **28 个模型**，
`deepseek-v4.1-flash` 可用。

> 结论：**能不能用最终由上游决定，列出来才有机会被选到**。
> 不要因为目录里没有就断定不可用——先调一次试试。

### 目录的缓存语义：`/health` 绝不等上游

目录抓取要串行打两个上游端点（各 8 秒超时），而控制台与 `tools/doctor.mjs`
对 `/health` 的探测超时只有 4 秒。**如果健康检查去等目录，冷缓存时就会把
「桥在跑」误判成「桥没起」**——表现为页面徽章间歇性变红，而进程其实好好的。

因此缓存分成两条路径：

| 端点 | 语义 |
|---|---|
| `/health` | **只读内存缓存**，毫秒级返回；缓存缺失或过期只**触发后台刷新**（同一时刻只允许一个在飞） |
| `/v1/models` | 冷启动（无任何缓存）时同步抓一次；已有缓存则立刻返回，过期仍只在后台刷新 |

`/health` 另外汇报 `pid` / `startedAt` / `uptimeMs` / `catalogSize` / `catalogRefreshing`
与 `clientExe`（客户端定位结果，**只读内存缓存、不触发探测**——与目录同理，健康检查
不能变成慢路径），控制台据此显示「桥进程」卡片，用来确认当前应答的确实是刚启动的
那个实例；`clientExe` 与启动日志的 `client exe` 一行同源，让"桥在驱使哪个客户端
可执行文件"能通过 API 直接核对。

### 目录过滤：只排「能判定」的非对话模型

上游目录里混着不能对话的内部模型。桥在**目录层**（与既有的 `codewise*` /
`hunyuan-image` 判定同层）排掉同时满足下面两条的条目：

```js
maxInputTokens 缺失或 <= 0   // 未声明上下文窗口
且 maxOutputTokens > 0 且 < 1024   // 声明了输出上限，但小到无法容纳一次回复
```

实测样本 `nes-gf`（无上下文、输出上限 256、无倍率）。规则**只用目录字段**、
不做「猜哪些能调通」；字段缺失判断不了一律保留。被排掉的 id 记在
`/health` 的 `upstreamShape.droppedNonChat` 里，可追溯，前端不做隐藏。

### 积分余额

计费网关与 chat 网关**不是同一个主机**：

| 区域 | chat | 计费 |
|---|---|---|
| 国内 | `copilot.tencent.com` | `www.codebuddy.cn` |
| 国际 | `www.workbuddy.ai` | `www.workbuddy.ai` |

端点 `POST /v2/billing/meter/get-user-resource`（**只读，不消耗积分**），
按套餐聚合：月度包看 `CycleCapacityRemain`，一次性包看 `CapacityRemain`。
桥把它包装成 `GET /v1/quota`，控制台展示总额与套餐明细。

### 积分活动（签到）

| 端点 | 作用 |
|---|---|
| `POST /v2/billing/meter/get-user-resource` | 积分余额（按套餐聚合） |
| `POST /v2/billing/meter/checkin-activity-status` | 签到状态（**只读**） |
| `POST /v2/billing/meter/daily-checkin` | 领取当天签到积分 |

均在计费网关上（见上表）。桥把它们包装成 `GET /v1/quota` 与
`GET|POST /v1/checkin`，控制台据此展示。

**幂等**：重复签到上游会返回非零业务码（含「已签到」），那是**幂等成功**而非失败——
今天的奖励已经在账上。桥据此把它当作成功返回，否则会误导用户以为出了问题。

**两个区域的差异**：国际版**没有签到活动**（`active: false`，该网关不含积分系统），
国内版正常。这不是故障。

### 消耗倍率

上游**确实下发倍率**，但格式有个坑：`credits` 是**字符串**（形如 `"x0.11"`），
不是数字。只判断 `typeof === 'number'` 会把它们**全部静默丢掉**——这正是
早期版本里"只有三个模型有倍率"的原因（那三个是硬编码的兜底值，而且值还是错的）。

正确做法是两种形式都解析：

```js
const hit = /x\s*([0-9]*\.?[0-9]+)/i.exec(raw);   // "x0.11" → 0.11
```

修正后国内版 **30 个模型里 28 个**都能拿到倍率：

| 模型 | 倍率 | 模型 | 倍率 |
|---|---|---|---|
| `space-bunny` | x0.03 | `deepseek-v4.1-flash` | x0.11 |
| `hunyuan-2.0-thinking` | x0.04 | `deepseek-v4-flash` | x0.17 |
| `glm-5.3-flash` | x0.06 | `minimax-m2.5` | x0.18 |
| `deepseek-v4-pro` | x0.51 | `kimi-k3-1` | x1.62 |
| `glm-5.3` | x0.79 | `default` | x2.2 |

### 倍率**不跨区域猜**

拿不到就显示"未知"，**不回退到别的区域的值**。教训：`deepseek-v4.1-flash` 是补充项
（国际版目录里没有），早前用 FEATURED 里的**国内实测值 0.11** 去填，把国际版的
免费模型标成了 0.11。倍率随区域与促销变化，跨区域套用等于编造数据。

### 免费模型与促销

`modelPromotions` 命中且 `discount.factor === 0`（或 `discountedCredits === "0x"`）时，
该模型**当前免费**。桥据此输出 `free: true` + `badge: "Free now"`，控制台以红色标签展示，
倍率位显示"免费"而不是 `0`。

**促销是动态的**：同一模型在不同时间可能免费/收费（实测国际版当前只有
`hy3`、`hy4-preview` 在促销列表里）。所以别缓存倍率，也别指望它与截图永远一致。

国际版的档位模型（`default-model` 等）没有该字段，显示为空。
**倍率会随官方调价变化**，以客户端界面为准。

### 手动刷新目录与 `staleMs`

`/v1/models?refresh=1` 强制重取上游目录。这里有两个容易踩的点：

- **成功判定不能用「缓存变没变」**。`fetchCatalog()` 末尾会把精选模型补进目录
  （因为目录接口并不完整），所以 `models` **永远非空**——「目录非空」不等于「抓到了」。
  桥改成用内部的 `upstreamOk` 标记「这次真的从上游取到了列表」。
- **部分失败不能顶掉完整缓存**。上游两个目录端点里只要有一个返 5xx，就**不动缓存**，
  否则用户会看到模型列表凭空少几个。这里区分「硬失败」（5xx / 网络异常 / 解析异常）
  与「软失败」（404 或端点没有 `models` 字段 —— 那只是「这个区域没有这个端点」，
  不能因此让目录永远不更新）。
- 失败时响应带 `staleMs`（距上次成功抓取的毫秒数），成功时**不带**；页面据此如实提示
  「刷新失败：…仍显示 HH:MM 的缓存」。只有当缓存确实比本次刷新更旧时才给 `staleMs`，
  否则会出现误导性的「0 秒前的缓存」。

### 每日自动签到：触发与幂等边界

签到是确定性的每日动作，忘了就是白丢积分，所以默认自动做：

- **桥侧**：`/v1/chat/completions` 处理开始时 fire-and-forget 补签 —— 「有人调模型」
  就是「在用」的最强信号。**不 await**，绝不拖慢这次调用。内存里按本地日期记
  「今天已尝试」，失败后冷却 1 小时、当天最多 3 次，避免对上游打无效请求。
- **控制台侧**：启动时 + 每小时检查，覆盖「开着控制台但没人调模型」。
  **先问「签了没」再决定要不要打上游** —— 少了这一步，每小时都会打一次无意义的签到请求。
- **幂等**：上游「已签到」按**成功**处理（`already`），绝不记成失败。桥重启后内存态清空、
  重新判定，靠上游幂等兜底。
- **不进账本**：`usage.jsonl` 只统计模型调用，`model` 字段语义不被签到污染；
  签到结果只进 `.state.json` 的 `checkin` 与桥 `/health` 的内存态。
- **桥没起来不算失败**：控制台侧直接跳过本轮，不写 `error` —— 那是「没法签」，不是「签失败」。
- **开关的生效时机如实说**：控制台侧立即生效；桥侧读的是启动时的 env，**需重启桥**。
  页面写清楚，不偷偷重启。

### 可测性：两个显式开关

- `WORKBUDDY_BILLING_BASE`：覆盖计费网关。`billingBase()` 原本按域名硬编码
  `www.codebuddy.cn`，离线环境根本拦不到签到请求 —— 这个功能会变成「只能靠读代码相信」。
- `WORKBUDDY_CHECKIN_COOLDOWN_MS`：覆盖冷却时长，让「当天最多 3 次」能在一次测试里观察到。

## 二·七、Anthropic 兼容层（`POST /v1/messages`）

### 为什么必须有这一层

Claude Code 说的是 **Anthropic 的 Messages 协议**，不是 OpenAI 的
chat/completions。两者在**请求结构、响应结构、流式事件格式**三处都不一样：

| | OpenAI | Anthropic |
|---|---|---|
| system 提示 | 首条消息 | 顶层 `system` 字段 |
| 工具调用 | `assistant.tool_calls` + 独立的 `role:"tool"` 消息 | 混在 `content` 块数组里的 `tool_use` / `tool_result` |
| 工具定义 | `tools[].function.parameters` | `tools[].input_schema` |
| 流式格式 | 扁平的 `choices[0].delta`，无事件名 | `event:` 行 + 块必须 start/delta/stop 配对 |
| 结束原因 | `stop` / `tool_calls` / `length` | `end_turn` / `tool_use` / `max_tokens` |

**光把 Base URL 指过来是接不上的**（原先直接 404，因为桥根本没有这个路由）。
所以这一层做双向翻译：Anthropic 请求 → 上游认的 OpenAI 请求 → 再把 OpenAI 流
翻译回 Anthropic 事件流。

### 三处不可逆的映射，以及为什么这么选

1. **`tool_choice`**：Anthropic 的 `{type:'any'}` 与 `{type:'tool',name}` 都映射成
   OpenAI 的 `'required'`——上游只认字符串，而且没有「指定某一个函数」的表达。
   语义上略有损失（不再限定是哪个函数），但保留了「必须调用工具」这个关键约束。
2. **模型名**：Claude Code 发 `claude-sonnet-4-…`，上游没有这些 id。解析顺序是
   ① 精确命中上游目录就原样用（允许用 `WORKBUDDY_ANTHROPIC_MODEL` 指定真实模型）；
   ② 含 `haiku`/`flash` 等「小快」字样的走 fast 模型；③ 其余走默认模型。
   默认取 `glm-5.3` 而非桥的通用默认 `deepseek-v4.1-flash`，因为 Claude Code 是
   Agent、全程依赖工具调用，而 `glm-5.3` 是实测 tool_calls 最稳的一个。
3. **`input_tokens`**：Anthropic 在 `message_start` 里就报 input_tokens，而上游只在
   流的**最后一帧**给 usage。所以开头先用 `请求字节数 / 4` 粗估，真实值在
   `message_delta` 里补正。给 0 会让 Claude Code 的上下文占用显示失真。

### 流式事件为什么必须严格配对

Anthropic 的流比 OpenAI 严格得多：每个内容块必须有
`content_block_start` / `content_block_delta…` / `content_block_stop` 三件套，
且块索引单调递增、**一旦关闭不再复用**。少任何一对，Claude Code 会判定流损坏
并中断会话。

实现上文本块与工具块**共用一个索引空间**：文本先来就占 0、工具接着占 1，反之
亦然；开新块前必须先 `closeOpen()` 把上一个关掉。

### 上游没有的能力：明确 501

`POST /v1/embeddings` 直接返回 **501**，这是**有意的设计**，不是没做完。

上游 30 个模型全是对话类，目录里没有任何 embedding 模型。返回一堆无意义的向量
会让客户端的知识库「看起来建成了、实际全是噪声」，用户要等检索结果离谱时才发现
问题——**错误的成功比明确的失败代价大得多**。

### 鉴权：两种写法都收

桥原先只认 `Authorization: Bearer <token>`（OpenAI 系客户端惯例）。Claude Code
用 `x-api-key: <token>`（Anthropic 系惯例）。两者承载的是同一个「本机回环令牌」，
用途完全一致，没有理由让用户为了换一个客户端就记两套写法，所以 `hasLocalToken()`
同时接受两者。**只影响本机回环端口上的这一个校验点**，与上游凭据无关。

---

## 三、dsh 侧集成

DeepSeek Harness 的配置是 **cordis patch 分层**结构：

```
dsh 安装的 bundle          →  @deepseek-ai/dsh-base 已内置 id: llm-pi-ai 条目
   ↓ 叠加
profile 补丁               →  ~/.dsh/profiles/desktop/cordis.patch.yml
   ↓ 叠加
用户设置文档               →  ~/.dsh/settings.yaml      ← 本项目只写这一层
```

因此**不需要新增插件条目**，只在用户设置文档里提供 `llm-pi-ai:` 分节即可：

```yaml
llm-pi-ai:
  providers:
    workbuddy:
      displayName: WorkBuddy
      apiKeyEnv: WORKBUDDY_BRIDGE_KEY     # 引用，不写明文
      api: openai-completions             # 手工声明路由必须点名协议
      baseURL: http://127.0.0.1:8790/v1
      models:
        - id: deepseek-v4.1-flash
          ...
```

凭据放在 `~/.dsh/.credentials.yaml` 的 `refs:` 下，由 `apiKeyEnv` **按请求解析**。

> `pi-ai` 的 OpenAI 兼容实现要求请求必须带 API key 头，即使本地桥并不校验。
> 所以这个占位凭据不可省略——它的值只要与桥的 `WORKBUDDY_LOCAL_TOKEN` 一致即可。

`settings.yaml` 是**热重载**的：保存后模型立刻出现在选择器里，无需重启 dsh。

---

## 四、控制台

控制台是薄薄的一层 HTTP 包装，不含探测逻辑——所有判断都来自 `lib/`，
因此页面结论与 `node tools/doctor.mjs` 必然一致。

```
dashboard/public/index.html   ← 单文件前端（内联 CSS/JS）
        │ fetch
dashboard/server.mjs          ← 路由、桥进程管理、静态资源
        │ import
lib/diagnostics.mjs           ← 8 项诊断、桥探测、凭据状态
lib/dsh.mjs                   ← dsh 状态、settings.yaml 生成与写入
lib/atrest.mjs                ← 密钥获取、信封解密
        │ import
config.mjs                    ← 唯一配置真源
```

**桥进程由控制台管理**：控制台用 `config.bridgeEnv()` 生成环境变量后 `spawn` 桥，
所以桥保持单文件自包含（不 import 项目内模块），配置却仍然统一。

桥的停止按端口找 PID，因此也能停掉手工启动的桥。查找方式**分平台**：

| 平台 | 找 PID | 结束进程 |
|---|---|---|
| Windows | `netstat -ano` 里的 `LISTENING` 行 | `taskkill /F /PID` |
| macOS / Linux | `lsof -iTCP:<port> -sTCP:LISTEN -t`，缺 `lsof` 时退回 `ss` | 先 `SIGTERM`，超时未退再 `SIGKILL` |

> 只认 LISTENING / LISTEN 的行，否则会把「连到该端口的客户端」当成监听者。

启动时若 `bridge/bridge.log` 超过 2MB 会滚动为 `bridge.log.1`，避免长期运行后无限增长。

### 双语（中 / 英）：为什么不做逐点 `t()`

控制台要出英文，最「正统」的做法是给每个渲染点加 `t('key')`。**这里没这么做。**

理由是这个页面的形态：**单文件、无构建、4000 行内联脚本**，文案大量是拼出来的
（`'完成 ' + done + ' / ' + total`）。逐点改造要动几百处渲染代码，而这些地方
**一条测试都没有**——风险全部落在「把已经稳定的页面改坏」这一侧，
换来的只是英文措辞更整齐一点。

所以选了 gettext 风格：**中文原文即词条 key**，配一次 DOM 翻译遍。

| 关注点 | 做法 |
|---|---|
| 完整文案 | `I18N_EN`（中文 → 英文） |
| 拼接出来的文案 | `I18N_RULES_EN` 正则规则表（具体规则必须排在通用规则前） |
| 静态 HTML 与 JS 渲染 | **同一条** DOM 翻译路径，避免两套口径 |
| 可逆 | 翻译前把原文记在节点上（`__i18nSrc` / `__i18nAttr`），切语言 = 拿原文重算 |
| 新渲染的节点 | 英文模式下挂 `MutationObserver` 增量翻；自己写回时 `takeRecords()` 防自激 |
| 数据不进翻译 | 对话正文、桥日志、`value` 属性标 `data-i18n-skip` 或直接排除 |

**这个选择的代价**（写在文档里，不藏着）：整句被 `<b>` / `<code>` 拆开的段落，
要按**文本片段**分别写词条，并保证拼起来读得通；译文质量因此依赖词条表的质量，
而不是模板结构。

**验收方式决定了它不会烂掉**：`tools/dev/test-i18n.mjs` 的断言不是「某句话等于某个英文」，
而是「英文模式下可见的中文文本节点数 = 0」——新增界面会被自动纳入检查，
漏翻会以「残留中文清单」的形式直接打印出来。

### 结论可信性：几条硬规则

控制台是这条链路唯一的操作面，因此「页面上出现的每个结论都必须可追溯」：

| 场景 | 规则 |
|---|---|
| 点「启动桥服务」时桥已在运行 | 先探测：有健康应答且账号一致就直接复用（不 spawn），返回 `reused:true` 与**实际在服务**的 PID。此时新起的进程必然 `EADDRINUSE` 退出；若确实 spawn 过并把错误回传，页面显示「新进程启动失败，仍在复用旧进程（PID N）」，绝不把死进程报成「已启动」 |
| 端口被非桥进程占用且无应答 | 10 秒内如实失败，响应带 `EADDRINUSE` 原文（子进程 stderr 已落进 `bridge.log`，按 spawn 前的偏移量取回） |
| 体检结果 | 服务端**按模型合并**写入（未提及的保留原条目与时间戳）；「清除体检」才做整体删除 |
| 切换账号 | 清空体检存档——结论只对被测时的账号成立，而两个账号的模型 id 往往重合 |
| 用量按天分桶 | 本地日期（与「最近请求」的时分秒同一口径） |
| 前端拼 HTML | 所有动态字段统一过一个转义函数（不做关键字黑名单） |
| 数据刷新 | 每个面板显示「更新于 HH:MM:SS」；加载器走 in-flight 去重，轮询与手动刷新不会并发叠加 |
| 桥状态与模型目录 | 两个接口：徽章不等目录（冷启动抓目录要串行打两个上游端点），目录到达后再填表格 |
| 小时桶 | 与按天同一套**本地时区**规则；`hours=1` 时把窗口**对齐到整点**（当前整点往前 23 小时，共 24 桶），否则最旧那个桶只统计到半截、图上合计与面板对不上 |
| 实测成本 | 账本窗口内「扣分合计 ÷ token 合计 × 1000」，**只含成功且回报了扣分的调用**；数据不足一律「—」并说明原因，绝不用目录倍率顶替 |
| 图表 | 零依赖内联 SVG；y 轴 4 条网格、30 天 x 轴抽稀、hover 用原生 `<title>`；不用 `preserveAspectRatio="none"`（会把文字拉变形）；异常态**清掉上一次的图** |
| 体检归档 | 结果按模型合并保留；另存 `probe.lastRun:{scope,count}`（本轮测了什么范围、共几个），非法值整条丢弃不落盘 |
| 危险动作 | 停桥 / 重启 / 切账号 / 写 dsh 一律二次确认；「最近 60 秒有 N 条请求」**当场取**明细，不依赖最长 20 秒前的轮询缓存 |

### 慢的上游不许拖住快的本地数据

总览（`/api/overview`）每 20 秒轮询一次，它同时要三类数据：

| 数据 | 来源 | 正常耗时 |
|---|---|---|
| 桥状态 / 模型目录 | 本机桥 | 2 ms |
| 凭据状态 | 本机登录文件（同步读） | 几 ms |
| **积分余额** | **上游计费网关** | 0.3 s（**抖动时实测见过 14 s**） |

原先的实现是一起 `Promise.all` 等 —— 于是上游一抖动，**整份总览**（包括 2ms 就能拿到
的桥状态）全被拖住；而它每 20 秒才轮询一次，页面看起来就像长期卡在「加载中」。

修法是给积分单独做 **stale-while-revalidate**：

| 情况 | 行为 |
|---|---|
| 缓存新鲜（默认 60s） | 直接返回，不打上游 |
| **有缓存但已过期** | **立刻返回旧值**，刷新放到后台 |
| 完全没有缓存（冷启动） | 等一次，但最多 3 秒；超时先回 `null`（页面显示「—」），请求继续在后台跑，下次轮询就能拿到 |

关键是**放弃等待 ≠ 放弃这次查询**：超时只是不再阻塞响应，那次上游请求照跑完并落缓存，
否则这一次查询就白打了。另外用 in-flight 去重保证多次轮询不会叠加成 N 个并发计费查询。

`tools/dev/test-quota-stale.mjs` 用**可控延迟的假桥**钉住这三条 —— 真桥的延迟取决于上游，
测不出确定性结论。为此 `WORKBUDDY_QUOTA_TTL_MS` 被提成配置项：它既是一个合理的旋钮
（余额刷新频率），也让测试不必真等 60 秒就能构造出「缓存过期」这条分支。

### 本地用量账本

`bridge/usage.jsonl` 由桥自己维护，**只记元数据，从不记对话内容**：

```json
{"t":1791035034979,"model":"glm-5.3","stream":false,"ms":1419,"ok":true,"promptTokens":20,"completionTokens":1,"credit":0.06}
```

`credit` 取自上游 `usage.credit`（本次实际扣减的积分），**没有回报时该字段直接缺席**
——不是写 0。这样消费方能区分「回报了 0」和「没回报」：

| 记录 | 含义 |
|---|---|
| `"credit":0` | 上游明确回报本次没扣到分（两位小数量化，小请求常态） |
| 无 `credit` 字段 | 上游没有回报扣分（升级前的旧记录也属此类） |

`/v1/usage` 因此额外给出 `creditCalls`（有多少次调用带了 `credit`）。页面用
`credit + creditCalls` 两个值决定显示数字还是「—」。**只累加 credit 是看不出这个
区别的**，早期版本就是这样，结果整列都渲染成「—」。

上游按**两位小数**回报，所以几十 token 的单次请求扣分就是 0.00。实测 `glm-5.3`
（目录倍率 0.79）335 tokens → 0.17、935 tokens → 0.51，与 token 数线性相关。

### 失败也要记账

用量统计只统计**成功**的调用——失败既没有 token 也没有扣分，混在一起会把
成功率算错。但这样一来「某个模型调不通」在控制台上就完全不可见了，只能去翻原始日志。

所以成功与失败写**同一个账本**，靠 `ok` 字段区分（旧记录没有该字段，一律按成功处理）：

```json
{"t":...,"model":"x","stream":false,"ms":418,"ok":false,"status":400,"code":11102,"error":"model [x] service info not found"}
```

`summarizeUsage` 把失败单独归到 `total.failed` 与 `failures[]`（最近 20 条），
不计入 token / 积分 / 按天统计；`/v1/requests` 给出逐条明细。

落账点覆盖三条路径，**任何一个都不能漏**，否则那一类故障就是隐形的：

| 路径 | 触发场景 |
|---|---|
| 上游返回非 2xx | 模型不存在（11102）、请求结构不被认可（11128）等 |
| 流式/非流式正常结束 | 记 `ok:true` 与 usage |
| 整个处理块抛异常 | 登录文件损坏、取 AtRest 密钥失败等——这些以前只会变成客户端的一个 500 |

**隐私边界**：只回元数据白名单字段（时间、模型、流式、耗时、token、扣分、状态码、错误码），
**不回请求体、不回消息内容**；错误原文压成单行并截断到 160 字符——上游的 401 会返回
一整段 HTML，不截会污染账本。

上限 2000 行，超出后截断保留最近一半，文件不会无限增长。

**重置语义**：进程内会缓存账本行，若只删文件不清内存，累计到 2000 行做整块重写时
会把已删除的历史写回来。因此：

| 动作 | 行为 |
|---|---|
| 每次写入前 | 比对文件字节数与内存记录；文件被外部清空/删除时**以文件为准**重新加载 |
| `DELETE /v1/usage`（桥） | 截断文件 **并**重置内存副本，控制台「清空账本」走这条路 |
| `DELETE /api/usage`（控制台） | 转发到桥的同名接口；桥未运行则如实报错，不做「删文件」这类半吊子兜底 |

账本是**桥侧**写的，控制台只通过 `/v1/usage` 与 `/v1/requests` 读聚合结果；
因此换控制台不影响历史数据。按天分桶用**本地日期**（与页面「最近请求」的
`HH:MM:SS` 同一时区口径），不是 UTC——否则 UTC+8 下凌晨 0–8 点的调用会被记到前一天。

---

## 五、为什么不用现成的 dsh 插件

调研过 `dsh-workbuddy-xdpool`（专为 dsh 编写的多账号池插件，已实现同样的 AtRest 解密），
但其全部版本都要求 `dsh-llm >= 0.1.1-rc.2`；而 dsh 由 DSH Desktop 管理，不宜手改其
`node_modules` 去凑版本。因此选择了自建桥 + 原生 `llm-pi-ai` 路由这条不依赖 dsh 版本的路径。

如果你的 dsh 版本满足该插件的 `engines` 要求，直接用插件会更省事——它额外提供多账号
轮换与限流自动降级。（桥自身现在也带一套 **opt-in 的本地限流**，见 `.env.example`
的 `WORKBUDDY_RATE_LIMIT_*`——那是"保护单个账号不被失控客户端打爆"的闸门，
与多账号轮换是两码事。）

---

## 六、性能主张与复现方式

代码注释里记着几组实测数字（keep-alive 免去的 DNS+TLS 握手 ~150ms、温连接
~82ms……）。它们都能当场复现 —— 不用信任何人，跑一遍就知道：

```cmd
:: ① 桥自身处理开销（响应头）。口径：上游请求发出之前的桥前置处理
::    （鉴权 / 读凭据 / payload 归一化 / 协议翻译），不含限流排队与上游等待。
curl -s -D - -o NUL -X POST http://127.0.0.1:8790/v1/chat/completions ^
  -H "Authorization: Bearer wb-local-bridge" -H "Content-Type: application/json" ^
  -d "{\"model\":\"deepseek-v4.1-flash\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"max_tokens\":8}" | findstr /i overhead

:: ② 连续 N 条最短请求：总耗时分布 + 桥开销中位数
node tools\dev\bench-overhead.mjs 5

:: ③ 进程级计数与状态码分布（真实请求入账，/health 探活不入账）
curl -s http://127.0.0.1:8790/health -H "Authorization: Bearer wb-local-bridge"
```

> 数字依赖网络环境与上游负载，**只用于同机前后对比**，不作为跨机器基准。
> ② 会消耗极少量账号积分（每条输出 `max_tokens=8`）。
