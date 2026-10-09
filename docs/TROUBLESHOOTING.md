# 故障排查

## 先做这一步

```cmd
node tools\doctor.mjs
```

它会检查 8 件事并按严重程度排序，直接告诉你缺什么。加 `--json` 可给脚本消费
（有失败项时退出码为 1）。

---

## 按症状定位

### 模型没有出现在 dsh 的模型选择器里

三个必要条件，缺一不可 —— 逐项确认：

1. **桥在跑** → 控制台徽章应为绿色；或 `curl -H "Authorization: Bearer $WB_TOKEN" http://127.0.0.1:8790/health`
2. **`settings.yaml` 已写入** → 控制台「可用模型」里至少勾了一个模型并保存过
3. **profile bundle 完整** → doctor 的 `profile bundles` 项为绿

第 3 项最常见的失败长这样：

```
Error: dsh: cannot resolve profile bundle "@deepseek-ai/dsh-experimental-agent-team-profile"
```

含义是 `~/.dsh/profiles/desktop/package.json` 的 `bundles` 里列了一个**没装**的包，
整个 profile 因此组合不起来，用户设置文档也不会被加载。

```cmd
:: 补装
node %USERPROFILE%\DeepSeek-Harness\runtime\node_modules\@deepseek-ai\dsh\lib\bin.js plugin --profile desktop install
```

如果那个 bundle 根本不是你要的，直接从 `bundles` 数组里删掉该行即可。

### 桥起不来

| 报错 | 原因 | 处理 |
|---|---|---|
| `login file has no accessToken` | 登录文件缺失或未登录 | 在 WorkBuddy 桌面端登录后重试 |
| `key fetch failed` | 取不到 AtRest 密钥 | 客户端换目录重装后**无需配置**（自动探测：默认位置 → 扫描常见目录 → 进程路径 / 注册表记录兜底；看启动日志 `client exe` 一行）；该报错现在只在客户端确实没装时出现 |
| `key fetch failed (exit 3)` | 原生绑定调用失败 | 客户端版本不匹配；尝试重新登录客户端 |
| `EADDRINUSE` | 端口被占 | 先点「停止桥服务」，或改 `WORKBUDDY_PORT`。控制台会如实告诉你结果：桥已在运行时点「启动桥服务」显示「桥已在运行（PID N）」；新进程确实起不来时显示「新进程启动失败，仍在复用旧进程（PID N）」，并在悬停提示里给出 `EADDRINUSE` 原文 |

### 401 / 认证类错误

> **先看这条 ——「升级后突然 401」是当前最高频的 401 原因。**
>
> **症状**：昨天还能用，更新版本后所有请求都回 401 `bad or missing token`，
> 客户端配置一个字都没改过。
>
> **原因**：本地回环令牌的默认值从固定串 `wb-local-bridge` 改成了
> **首次运行随机生成**（安全修复：旧值是公开的，等于没有防护）。
> 你客户端里存的是旧值，自然对不上。
>
> **处理（三选一）**：
> 1. 打开控制台 →「客户端接入」面板 → 复制新令牌 → 填进客户端（推荐）。
> 2. 读文件：`type dsh-plugin\.bridge-token`
> 3. 想固定回自己习惯的值：在 `.env` 里写 `WORKBUDDY_LOCAL_TOKEN=你的值`，
>    重启桥。显式配置优先级最高，桥 / 控制台 / dsh 插件三处都会用它，
>    不会再自动生成。
>
> **dsh 插件用户不受影响** —— 插件与桥读同一个 `.bridge-token`，自动一致。
> 会断的只有你**手工填过密钥**的外部客户端（Claude Code、opencode、图形表单等）。
>
> 顺带一提：桥的 401 响应体现在会直接打印上面这段指引，所以你也可以
> 直接看客户端报错内容，不用回来翻文档。

| 现象 | 原因 |
|---|---|
| `401 Authorization Required`（HTML + APISIX 字样） | 鉴权头无效 —— 通常意味着凭据**没有被解开**，桥拼出了 `Bearer [object Object]` |
| `envelope belongs to key <X>, not <Y>` | 登录文件由另一个 build 写入（例如装了国际版客户端），或本机有多套客户端 |
| `refreshToken is empty` 且随后 401 | 同上，凭据字段未被正确解析 |

排查顺序：

```cmd
node tools\verify-atrest.mjs
```

该脚本只输出长度和 `startsWith('eyJ')`，**不会打印任何令牌内容**。正常输出：

```
derived keyId: 9127dea1b44020a7
accessToken  : envelope keyId=9127dea1b44020a7 -> DECRYPTED len=1359 jws-like=true
refreshToken : envelope keyId=9127dea1b44020a7 -> DECRYPTED len=698 jws-like=true
```

若 `keyId` 与信封里的不一致，说明登录文件不是本机这个客户端写的 → 在客户端里重新登录一次。

### 400 类错误（来自上游）

| 错误码 | 含义 | 说明 |
|---|---|---|
| `11101` | `Non-stream chat request is currently not supported` | 上游只接受流式。桥已自动转换；若仍出现，说明请求绕过了桥 |
| `11101` | `cannot unmarshal object into Go struct field Request.tool_choice of type string` | 客户端发了 **OpenAI 对象形式**的 `tool_choice`（`{"type":"function",...}`），而上游的 Go 结构体只收字符串。桥已在 `normalizePayload` 里归一化，正常不会出现；若出现，说明请求绕过了桥 |
| `11128` | `Illegal API invocation from an unapproved channel` | 请求结构或调用方身份不被认可。常见于 `system` 提示词被放在 `developer` 角色、User-Agent 不匹配，或 **Claude Code 的固定 system 模板被逐字拉黑**（2026-10-08 实测：带原文 `…official CLI for Claude.` 即被拒、按最小改写后放行 —— 桥已内置出站改写 `CLI`→`CLI tool`、`Main branch`→`Default branch`，正常不会再出现）。若再现：用 `node tools/dev/probe-audit-template.mjs` 复核（脚本内附三态判定与处置），改写表在桥内 `AUDIT_TEMPLATE_REWRITES` |
| `11133` | 网关包装的瞬时上游故障 | 桥会退避重试；频繁出现请稍后再试 |

> **`tool_choice` 为什么必须归一化**：OpenAI 规范允许两种写法 —— 字符串
> （`none` / `auto` / `required`）和对象（`{"type":"function","function":{"name":"..."}}`，
> 用于强制调用某个具体函数）。上游只认字符串，收到对象直接 400。
> Cursor / Trae / opencode 这类基于 AI SDK 的 Agent 客户端会发对象形式。
> 桥的处理是：`{type:'function'}` → `required`（语义最接近），认不出来的对象丢弃
> 而不是原样转发（留着必然 400，丢掉最多退化成 `auto`）。

### 上游版本漂移（身份指纹整体被拒）

**症状**：凭据完全正常，但**所有**请求突然 `401` 或 400 code `11128`（含 Claude Code 全量失败）。

**原因**：上游按 `User-Agent` / `X-IDE-*` / `X-Product-Version` 校验调用来源；官方客户端升级后，旧指纹可能被整体拒绝。

**处置**：在 `.env` 里把身份切到当前官方客户端版本（默认值 = 本仓库实测可用版本），重启桥生效：

```ini
WORKBUDDY_APP_VERSION=4.9.29177644
WORKBUDDY_IDE_VERSION=1.119.0
WORKBUDDY_IDE_NAME=VSCode
```

判定是否是版本漂移：控制台「对话测试」发一条最短消息 —— 若同样被拒，且 `verify-atrest` 显示凭据一切正常，即命中本症状。

### 模型名含中文 / 特殊字符 → 500 且报 `Invalid character in header content`

```
500  {"error":{"message":"Invalid character in header content [\"X-Model-ID\"]"}}
```

**原因**：桥把 `body.model` 原样放进 `X-Model-ID` 请求头发给上游。含非可见 ASCII
（中文、emoji、控制字符）时 Node 的 `http.request` 会直接抛异常，外层只能回 500 ——
客户端看到的是「未知错误」，完全不知道是模型名的问题。

**这条与「模型在不在目录里」无关**，所以不能靠 `preflightModelError` 拦：
它在目录没拿到时会直接放行（`upstreamModelCount === 0`）。而目录没拿到是常见状态 ——
冷启动、上游目录接口抖动，以及你自己按桥的提示设了 `WORKBUDDY_SKIP_MODEL_PREFLIGHT=1`。

**已修**：入口按字符集校验（可见 ASCII），不合法回 **400** 并说明原因；`buildHeaders`
再兜一道，防止将来新增的调用方绕过入口校验。

**你要做的**：模型 id 用 `/v1/models` 里的真实 id（都是 ASCII）。中文的「显示名」
只在界面上用，不要填进客户端配置的 model 字段。

### 「对话测试」发长对话 → `Connection was reset`（没有任何错误信息）

```
curl: (56) Recv failure: Connection was reset
```

**原因**：控制台的 `readBody` 在请求体超限时是「`fail()` + `req.destroy()`」。
`destroy()` 会把 socket 直接拆掉，**413 还没来得及写就 RST 了**，所以客户端拿不到
任何解释。而「对话测试」的历史是**不自动裁剪**的（只提示清空），聊久了就会撞上
512KB 上限。

**已修**：改成「暂停读取 → 回明确的 413（带 `code: BODY_TOO_LARGE` 与可操作文案）
→ 再 `resume()` 把剩余字节读掉丢弃」。桥那边一直就是这么做的，控制台原先漏改 ——
两边现在一致。

**你要做的**：看到 413 就点「清空对话」再试。桥侧的请求体上限是 32MB（多模态
对话需要），控制台内部管理请求是 512KB，两者用途不同、刻意不一致。

### 429 / 频率限制

```
429  code 6004  您的使用量已超出频率限制，将在 <时刻> 重置
```

**按模型计**，不是按账号总量计。实测连续发 3 个请求就可能撞上，但报错文案本身
提示了绕开方式：

> 「您也可以切换其他模型继续使用」

所以同一个时刻，`deepseek-v4.1-flash` 被限流了，换 `glm-5.3` 往往还能正常调。
报错里带的重置时刻就是该模型配额恢复的时间。

**这不是桥的问题，也不是 bug**——是上游对单模型的并发/频率约束。排查时不要
反复重试同一个模型（只会一直 429），换模型或等重置。

### Claude Code 接不上 / 报协议错误

Claude Code 说的是 **Anthropic 的 Messages 协议**，不是 OpenAI 的 chat/completions。
桥从 v1.2.0 起内置了 `/v1/messages` 兼容层，配置如下：

```sh
# macOS / Linux
export ANTHROPIC_BASE_URL=http://127.0.0.1:8790   # 注意：不带 /v1
export ANTHROPIC_API_KEY=$WB_TOKEN           # 本地回环令牌
claude
```

```powershell
# Windows PowerShell
$env:ANTHROPIC_BASE_URL="http://127.0.0.1:8790"
$env$env:ANTHROPIC_API_KEY="$WB_TOKEN"
claude
```

| 现象 | 原因 |
|---|---|
| `404 no route for POST /v1/messages` | 桥版本太旧（早于 Anthropic 兼容层），或地址填成了别的服务 |
| `404` 且地址里带了 `/v1` | `ANTHROPIC_BASE_URL` **不能**带 `/v1`，Claude Code 会自己拼 `/v1/messages` |
| `401` | 令牌不对。桥同时接受 `Authorization: Bearer <token>` 和 `x-api-key: <token>` 两种写法 |
| 模型名被「换掉」了 | **这是设计行为**：Claude Code 发的 `claude-sonnet-4-…` 在上游不存在，桥会映射到真实模型。默认 `glm-5.3`（小快模型走 `glm-5.3-flash`）。想指定就用 `WORKBUDDY_ANTHROPIC_MODEL=<上游真实模型 id>`，桥会优先精确匹配 |

### 客户端里模型显示「上下文 0」

**这不是桥的问题，也不是你填错了。**

桥返回的模型元数据里上下文长度是有的（`context_window`），但**客户端不会去问**——
尤其对「自定义 provider」，多数客户端只认自己内置的模型表（models.dev 之类），
自定义模型的上下文一律按 0 处理。

所以它必须在**客户端侧**声明：

| 客户端 | 在哪里声明 |
|---|---|
| opencode | `opencode.json` 里每个模型的 `limit: { context, output }`。**界面表单里没有这两格**，只能写文件 |
| 其他 GUI 表单 | 表单里若有「上下文长度 / 输出上限」就填；没有就找该客户端的配置文件 |

控制台「客户端接入」页签给出的 opencode 片段**已按上游真实值填好 `limit`**，
直接复制即可。想自己核对真实值：

```cmd
curl -H "Authorization: Bearer $WB_TOKEN" "http://127.0.0.1:8790/v1/models?all=1"
```

每个模型都带 `context_window` 与 `max_output_tokens`。

### 客户端报「知识库 / RAG 不可用」

`POST /v1/embeddings` 会返回 **501**，这是**有意的**。

上游 30 个模型全是对话类，目录里**没有任何 embedding 模型**。桥宁可明确报
「不支持」，也不返回一堆无意义的向量——后者会让知识库看起来建成了、实际全是
噪声，用户要等检索结果离谱时才发现问题。

需要 RAG 的客户端（Cherry Studio / LobeChat / Open WebUI）请**另配一个
embedding 提供方**，对话部分照常走本桥。

### 启动脚本（.cmd）里不能出现中文

`cmd.exe` 在 `chcp` 生效**之前**就已经按系统 ANSI 码页解析完整个 `.cmd` 文件。
如果文件以 UTF-8 保存且含中文，多字节序列会被 GBK 误读，**连命令本身都会被截断**——
实测 `if not errorlevel 1` 被读成 `'rrorlevel'`，脚本直接崩溃。

因此 `启动.cmd` **刻意保持纯 ASCII**，面向用户的中文提示全部由 Node 进程输出
（那部分发生在 `chcp 65001` 之后，是安全的）。

**结论**：`.cmd` 保持 ASCII，中文交给被调用的程序打印。

### Node 子进程相关

```
spawnSync C:\WINDOWS\system32\cmd.exe EBUSY
```

**根因**：`execSync` / `execFileSync` 默认会为子进程的 stdin 打开管道，在这台机器上
启动 Electron 或 `cmd.exe` 会直接失败。

**修复**：任何同步子进程调用都必须显式忽略 stdin，并直连绝对路径：

```js
spawnSync(systemExe('netstat'), ['-ano'], {
  stdio: ['ignore', 'pipe', 'pipe'],   // ← 关键
  encoding: 'utf8',
  windowsHide: true,
});
```

### 某个模型调不通 / 报错但不知道原因

先看控制台的**「最近请求」**面板：逐条列出时间、模型、方式、耗时、token、积分与结果，
**失败的行整行标红**，鼠标悬停结果标签可以看到上游返回的错误原文。面板上方的提示条
直接给出**失败率**与出现最多的「错误码 · 模型」组合——想定位「哪个模型调不通」，
打开「仅看失败」开关即可只看失败行。

常见的错误码：

| 错误码 | 含义 |
|---|---|
| `11102` | 模型不存在或未接入 —— 该 id 在上游没有配置 |
| `11101` | 上游不接受非流式请求（桥已自动转流式，出现说明请求绕过了桥） |
| `11128` | 请求结构或调用方身份不被认可（`system` 提示词放错角色、UA 不匹配） |
| `11133` | 网关包装的瞬时上游故障，桥会退避重试 |

面板为空说明桥没在跑，或还没有任何请求经过桥。原始日志（含更完整的堆栈）在
`bridge/bridge.log`。

### 选错账号

登录目录里有多个 `.info` 时，**自动探测按固定优先级取**：

1. `WORKBUDDY_AUTH_FILE`（显式指定，最高优先级）
2. `WORKBUDDY_AUTH_DIR` 或默认登录目录下的 `workbuddy-desktop.info`
3. 该目录下按文件名排序的第一个 `.info`

第 2 步很关键：国际版的 `workbuddy-desktop-ai.info` 恰好排在
`workbuddy-desktop.info` **前面**，若只取"目录里第一个"，独立启动的桥会静默
切到另一个账号。`config.mjs` 与桥用的是同一套优先级，两处结论一致。

需要强制指定时：

```ini
WORKBUDDY_AUTH_FILE=C:\Users\<you>\AppData\Local\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info
```

用「最近修改时间」判断哪个是当前活跃的：在客户端里登录一次，看哪个文件的 `mtime` 变了。

### 桥在跑，页面却说「桥未运行」

**先确认是页面误报还是桥真的没起来：**

```cmd
curl -H "Authorization: Bearer $WB_TOKEN" http://127.0.0.1:8790/health
```

- 有 JSON 返回、`"ok":true` → 桥是好的，是探测超时
- 连接被拒 → 桥确实没起来，看下面的「桥起不来」

探测超时只出现在**旧版**：旧 `/health` 会同步等一次上游模型目录抓取，而目录要
串行打两个上游端点，冷缓存时超过控制台的 4 秒探测超时，于是被误判成未运行。
现在的 `/health` 只读内存缓存、过期只在后台刷新，因此**恒为毫秒级**，且额外汇报
`pid` / `uptimeMs` / `catalogSize`。页面「桥进程」卡片就是这几个字段。

### 桥日志无限增长

`bridge/bridge.log` 在**每次启动桥时**检查大小，超过 2MB 就滚动为
`bridge.log.1`（覆盖上一份）。长期挂着不用管它。

### 清空账本 / 清空日志

| 动作 | 入口 | 说明 |
|---|---|---|
| 清空用量账本 | 「用量统计」表头的**清空账本**（二次确认） | 桥侧 `DELETE /v1/usage`：截断 `bridge/usage.jsonl` **并**重置进程内副本。手工删除该文件同样有效——桥每次写入前比对文件大小，发现被清空就以文件为准，不会再「复活」旧记录 |
| 清空桥日志 | 日志面板里的**清空日志**（二次确认） | 截断 `bridge.log`；桥持有的是追加 fd，会继续往新文件写 |
| 只看本次启动 | 日志面板里的**只看本次启动** | 按最后一次启动横幅切分，避免看到上上次启动的输出 |

> 账本与日志都**不含任何令牌明文与对话内容**：账本只有时间/模型/耗时/token/扣分/错误码，
> 日志只有模型名、消息数与工具数。

---

## 日志

| 日志 | 位置 |
|---|---|
| 桥运行日志 | `bridge/bridge.log` |
| 控制台输出 | 运行 `启动.cmd`（macOS / Linux：`scripts/start.sh`）的那个窗口 |
| dsh 自身日志 | `~/.workbuddy/logs/`、dsh 应用内的日志面板 |

桥设置 `WORKBUDDY_LOG=1`（默认）后，每次请求都会记一行：

```
[2026-10-03T12:08:12.917Z] → deepseek-v4.1-flash stream=true msgs=2 tools=0
```

**只记录模型名、消息数与工具数，不记录对话内容。**

---

## DSH Desktop 0.2.0 的配置导入机制

**`settings.yaml` 突然消失、变成 `settings.yaml.imported`，这不是故障。**

DSH Desktop 0.2.0 启动时会把 `$DSH_HOME/settings.yaml` **合并进**
`$DSH_HOME/profiles/<name>/cordis.patch.yml`，然后把原文件归档为 `.imported`。
所以：

- 判断"路由是否生效"要看 **`cordis.patch.yml`**，而不是 `settings.yaml` 是否存在
  （`tools/doctor.mjs` 已按此判定，会打印实际生效位置）
- 保存模型注册后，需要**重启 DSH Desktop** 才会完成导入
- **不要手工编辑 `cordis.patch.yml`**——DSH Desktop 会重写它

## 本机有两套 dsh 运行时

| 路径 | 版本 | 说明 |
|---|---|---|
| `E:\harness\resources\runtime` | 0.2.0-rc.2 | DSH Desktop 自带的 bundled 运行时，**实际在使用** |
| `C:\Users\demo\DeepSeek-Harness\runtime` | 0.1.0-rc.6 | 独立的旧安装 |

**用错那一套排查会得出完全相反的结论。** 实例：`@deepseek-ai/dsh-experimental-agent-team-profile`
在 0.1.0 上装不上（版本断层），在 0.2.0 上则完全正常。

`config.mjs` 已按优先级自动探测（可用 `DSH_RUNTIME` 覆盖），
`tools/doctor.mjs` 会打印当前采用的是哪一套及其版本。

⚠️ **profile 的依赖版本必须与 DSH 对齐**（例如 DSH `0.2.0-rc.2` 对应
`@deepseek-ai/dsh-experimental-agent-team-profile@0.2.0-rc.2`）。装错代次会连
peer 依赖一起错位。

## 判断某个 profile bundle 该怎么装

`bundles` 数组声明 ≠ 依赖已安装，二者是分开的：

- `dsh.profile.bundles` —— 告诉 dsh 要加载哪些 bundle
- `dependencies` —— 决定 pnpm 实际会装什么

因此 `pnpm install` **装不到只在 bundles 里出现的包**，必须显式 `add`：

```cmd
cd /d %USERPROFILE%\.dsh\profiles\desktop
pnpm add <包名>@<与 DSH 版本对齐的版本>
```

装完用 `pnpm peers check` 看 peer 是否满足。注意 **peer 警告不一定是真问题**——
DSH Desktop 的部分 peer（如 `@deepseek-ai/cordis`）由它的 app.asar 在运行时提供，
pnpm 从文件系统看不到，会报 missing。

## 完全重置

桥侧无状态。要回到干净状态：

```cmd
:: 1. 停掉桥与控制台
:: 2. 删除 dsh 侧本项目的配置（会同时删掉你自己加的其它分节，注意备份）
del %USERPROFILE%\.dsh\settings.yaml

:: 3. 从 .credentials.yaml 里删掉 WORKBUDDY_BRIDGE_KEY（该文件还有其它凭据，建议手工编辑）
```

登录文件由 WorkBuddy 客户端管理，**不要手工改动它**——桥对它只读。

---

## v1.4.6 修掉的那一类「静默出错」

这一类的共同点是：**不崩溃、不报错**，只是行为和用户以为的不一样，所以最难自查。
下面按症状列出。若你还在旧版本，可以照这些特征认出来。

### 回答是空的，但客户端显示成功

- **症状**：内容为空；控制台里调用次数 +1，token 却是 0。
- **原因**（v1.4.5 修）：上游偶尔会把错误包成 **HTTP 200 的 HTML** 返回（网关层），
  而桥的非流式路径原先**无条件**记成功 —— 「一个 SSE 块都解析不出来」被当成了
  「模型没说话」。
- **现在**：这种情况记失败并回 502，控制台的失败数会 +1。
- **旧版本上怎么认**：看「最近请求」里 `ok:true` 但 token 为 0 的记录，
  它的上游返回其实根本不是 SSE。

### 工具调用失败 / 工具名看起来被截断了

- **症状**：Claude Code 一类客户端报工具调用失败；工具名像是少了后半截
  （`get_` 而不是 `get_weather`）。
- **原因**（v1.4.6 修）：上游把 `function.name` **拆成多帧**下发时，
  Anthropic 流式路径上除第一片外的分片被静默丢弃。
- **范围**：只影响 `/v1/messages` 的**流式**请求（即 Claude Code 这类），
  OpenAI 协议的客户端不受影响。

### 额度显示的是上一个账号的余额

- **症状**：切账号或签到成功之后，控制台里的余额还是旧的，**过一会儿自己好了**。
- **原因**（v1.4.5 修）：作废缓存时没管**在途**的那次查询，它完成时又把旧账号的
  余额写了回去 —— 最长 60 秒后才自愈。

### 桥突然不在了（控制台说「桥未运行」）

- **症状**：桥没有任何征兆地退出；日志里可能有 `ERR_INVALID_URL`。
- **原因**（v1.4.5 修）：旧版本上，一条 **`Host` 头畸形**（例如含空格）的请求会让
  `new URL()` 抛未捕获异常，**直接把桥进程带走** —— 同机任何程序都能触发。
- **现在**：这类请求回 400，进程不受影响。

### 令牌过期时偶发一串 401，过一会儿又好了

- **症状**：令牌刚过期的那几秒里连续 401，之后自愈。
- **原因**（v1.4.6 修）：并发请求各自发现过期、各自去刷新；而刷新响应里带**轮换后**
  的 refreshToken，后到的请求拿已作废的旧令牌必然失败，于是写了失败冷却，
  把接下来 15 秒内**所有**刷新都挡住。现在刷新是单飞的。

### 令牌填对了却还是 401

- **症状**：按提示从 `.bridge-token` 复制了新令牌填进客户端，**仍然 401**；
  但控制台里桥的状态是「运行中、正常」。
- **原因**：那不是客户端的问题，是**在跑的桥**内存里还是升级前的旧令牌。
  令牌文件可能是**别的进程**先创建的 —— `config.mjs` 在**模块求值时**就会
  生成并落盘令牌，所以跑测试、跑工具也会创建它。「首次运行」于是变成了
  「第一个 import 这个模块的进程」，它可能早于桥的启动，两者就对不上。
- **怎么确认**：看 `dsh-plugin/.bridge-token` 的修改时间 —— 若**晚于**桥的启动时间，
  就是这个情况。
- **处置**：把**桥和控制台一起重启**（走 `启动.cmd`），两边会收敛到文件里的同一个
  值。**只重启一边会继续 401。**
- **想彻底避免**：在 `.env` 里设 `WORKBUDDY_LOCAL_TOKEN=<你自己的值>`，
  显式配置优先级最高，三处都用它，就不存在「谁先生成」的问题。
