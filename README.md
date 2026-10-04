# WorkBuddy → DeepSeek Harness 中转

把本机 **WorkBuddy 桌面端**已登录的模型能力（DeepSeek / GLM / Kimi / MiniMax 等），
经一个本地桥暴露成 **OpenAI 兼容接口**，供 **DeepSeek Harness** 或任意支持自定义
Base URL 的客户端使用。附带一个网页控制台，把状态、启停、诊断、模型注册集中到一屏。

**本仓库还提供一个 dsh 原生插件**（[`dsh-plugin/`](dsh-plugin/README.md)）：装进 dsh 后，
模型选择器里直接多出 provider `WorkBuddy`，设置里多一页 9 个标签页的数据面板；
插件自带桥与控制台，拷一个文件夹就能用。

只在本机回环地址上工作，不对外暴露，不内置任何密钥。

```sh
# 从源码安装（推荐；插件在 dsh-plugin/ 子目录）
git clone https://github.com/Ianzhyh/workbuddy-to-dsh.git
dsh plugin --profile desktop add workbuddy-to-dsh/dsh-plugin
# 装完重启一次 dsh；之后：设置 → WorkBuddy
```

> 插件是**自带一切**的独立包（`npm run vendor` 生成的 `vendor/` 里含桥与控制台），
> 可以直接把 `dsh-plugin/` 文件夹拷给别人，对方不需要本仓库。
> 安装路线、验收清单与九条故障排查见 [docs/INSTALL.md](docs/INSTALL.md)。

---

## 它解决什么问题

WorkBuddy 的上游后端本身就讲 OpenAI 协议，官方只是没有开放公开入口，鉴权依赖桌面端
的登录会话。所以理论上只需要一个薄薄的转发层。

真正的问题是**从 WorkBuddy 5.6.0 起，官方强制开启了 AtRest 加密**：登录文件里的
`accessToken` / `refreshToken` 从明文 JWT 变成了 AES-256-GCM 信封，而解密密钥不落盘、
只存在于客户端进程内。这让所有进程外的既有工具全部失效。

本项目通过**让写这个文件的客户端自己交出密钥**来解开它——以
`ELECTRON_RUN_AS_NODE=1` 运行 `WorkBuddy.exe`，调用它自己的原生绑定 `loggerGet()`。
没有任何密钥被写进代码或磁盘。

---

## 前置条件

| 条件 | 说明 |
|---|---|
| Node.js | **18 或更高**（开发验证于 22.22.2）。无 npm 依赖，无需 `npm install` |
| WorkBuddy 桌面端 | **已安装且已登录**，进程可用（模型由它铸造的令牌驱动） |
| DeepSeek Harness | 可选。只有要接入 dsh 时才需要；桥本身对任意 OpenAI 客户端都可用 |
| 操作系统 | Windows 已验证；macOS / Linux 的路径与调用逻辑已实现但未实测 |

> 桥只驱动**本机已登录**的账号，不绕过任何鉴权，也不提供任何绕过方式。

---

## 快速开始

**双击根目录的 `启动.cmd`。就这一步。**

它会自动定位 Node.js、启动服务、并在浏览器里打开控制台——桥也会被自动拉起，
不需要任何手工操作。打开后即可看到桥已就绪和完整的模型列表。

> 首次使用建议在「可用模型」里勾选所需模型并点「保存到 dsh 设置」，
> 然后重启一次 DeepSeek Harness，模型就会出现在它的选择器里。

三个"不需要"：

- **不需要 `npm install`** —— 本项目零依赖
- **不需要改配置** —— 所有项都有合理默认值，`.env` 是可选的
- **不需要手工启动桥** —— 控制台会自动启动它（并复用已在运行的实例）

> 窗口保持打开即可。关掉窗口会停止控制台；桥在后台继续驻留，下次启动直接复用。

不想开控制台也可以（用的是同一套配置）：

```cmd
bridge\start-bridge.cmd     :: 只起桥
node tools\doctor.mjs       :: 命令行自检，输出缺失项与修法
```

---

## 作为 dsh 插件使用（推荐）

本仓库同时提供 **DeepSeek Harness 原生插件**（[`dsh-plugin/`](dsh-plugin/README.md)）。
**两者是一套，不是二选一**：

> **插件当引擎，控制台的全部功能搬进 dsh 设置页 —— 两个前端、一个后端。**
> 插件在 dsh 里注册原生模型路由、把**桥和控制台都管起来**（已在跑就复用，没跑就拉起）；
> **设置 → WorkBuddy** 里有 9 个标签页：概览 / 账号 / 用量 / 请求 / 签到 / 诊断 / 模型 / 对话测试 / 日志，
> 功能与控制台网页**完全等价**：读同一个桥、写同一份 `.state.json`（账号切换等写操作由
> 插件透传给控制台执行，保证只有它写），在任意一边改，另一边同步变化。原控制台照常可用。

| | 装插件后 | 不装插件 |
|---|---|---|
| 模型注册 | 运行时注册 provider `workbuddy`，**不写任何配置文件** | 控制台写 `settings.yaml` + profile patch |
| 模型增删 | 动态跟随上游目录，改完即生效 | 需要重新勾选并保存 |
| 桥的启停 | 插件自动复用/拉起 | 控制台按钮，或 `启动.cmd` |
| 数据界面 | **dsh 设置页（9 个标签页）** + 控制台网页，两边同步 | 只有控制台网页 |
| agent 侧 | 5 个工具 + `/workbuddy` 命令 | 无 |

```sh
dsh plugin --profile desktop add <本仓库路径>/dsh-plugin
```

装完**重启一次 dsh**（插件模块与客户端引导行只在启动时组装）。
两种方式可以共存：控制台照旧能开，桥是同一个进程；但**不要同时保留旧的手写
`llm-pi-ai.providers.workbuddy` 路由**——插件首次加载会自动把它清掉（先备份）。

细节、配置项与验证记录见 [`dsh-plugin/README.md`](dsh-plugin/README.md)。

---

## 控制台

打开 <http://127.0.0.1:8792> 后：

| 区域 | 能做什么 |
|---|---|
| 顶部提示条 | 只显示**需要处理**的事：桥不可用 > 令牌临期 > 新失败 > 未签到；桥不可用不可关闭，其余可静默。标签页标题同步反映状态（含「新失败 N」） |
| 操作条 | 启动桥、重启桥、停止桥、重新诊断、复制桥地址（供其它 OpenAI 客户端填 Base URL）、**复制诊断报告**；危险动作都有二次确认（会提示将打断几条请求）；「刷新」一次覆盖全部面板 |
| 状态卡 | 账号、令牌剩余有效期、凭据加密方式、上游端点、**桥进程（PID / 运行时长 / 目录模型数）**、模型数、**积分余额**、dsh 就绪度 |
| 账号 | 登录目录下存在多个账号快照时，可在此切换桥使用哪一个（自动重启桥、记住选择，并清空上一个账号的体检结论） |
| 用量统计 | 最近 1 / 7 / 30 天的调用次数、token 数、平均耗时、**消耗积分**、失败数；**趋势图**可切指标（次数 / tokens / 积分）与粒度（按天 / 最近 24 小时），**积分排行**看「这段时间积分花在哪了」；可导出 CSV，也可**清空账本** |
| 最近请求 | 逐条请求明细（时间 / 模型 / 流式与否 / 耗时 / token / 积分 / 结果），**失败标红**并显示上游错误码，**点失败标签可一键复制错误详情**；支持**模型筛选** +「仅看失败」+ 40 / 100 / 200 条叠加，可**暂停自动刷新**、**导出当前筛选的 CSV**；只含元数据，不含对话内容 |
| 每日签到 | 查看今日签到状态与连续天数，一键领取；**每日自动签到**默认开启（桥在跑就随首次模型请求自动签，控制台开着就启动时与每小时检查一次），失败会留痕、可关闭 |
| 环境诊断 | 8 项检查，**按优先级排序**——红色项不解决，模型就不会出现 |
| 可用模型 | 实际可用的全部模型（不能对话的内部模型已在桥的目录层过滤），含上下文、输出上限、**消耗倍率**与**实测成本**；**体检范围可选**（勾选的 / 已注册的 / 全部），可**一键取消勾选不可用的**、**同步可用模型到 dsh**、**手动刷新目录**；点 **ⓘ** 看模型详情（中文描述 / 厂商 / 标签 / 精确上下文与输出）；导出 CSV |
| 对话测试 | **多轮对话**（带上下文）、按轮次分段、显示本轮 token / 扣分 / 耗时、回答可复制；流式输出可随时停止；附带桥日志（可按关键字过滤 / 只看错误 / 只看本次启动 / 清空） |

每个面板的表头都显示「数据更新于 HH:MM:SS」，页面上出现的结论都能对得上时间。
所有图表都是自己画的**零依赖内联 SVG**（没有引入任何图表库）。

控制台的所有接口见 [`dashboard/README.md`](dashboard/README.md#api)。

---

## 工作原理

```
任意 OpenAI 客户端 / DeepSeek Harness
   │  POST http://127.0.0.1:8790/v1/chat/completions
   ▼
bridge/workbuddy-bridge.mjs          ← 只做三件事
   │  1. 注入鉴权头（凭据现取现解，不落盘）
   │  2. 保证流式（上游不接受非流式请求）
   │  3. 角色名适配（developer → system）
   ▼
copilot.tencent.com/v2/chat/completions
```

桥**不做协议翻译**——上游本来就说 OpenAI 协议。详见
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)。

---

## 配置

统一配置真源是 [`config.mjs`](config.mjs)，优先级：
**进程环境变量 > `.env` > 内置默认值**。

```cmd
copy .env.example .env
```

常用项：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `WORKBUDDY_PORT` | `8790` | 桥监听端口 |
| `WORKBUDDY_LOCAL_TOKEN` | `wb-local-bridge` | 本地回环令牌，仅防同机误用，**不是**上游凭据 |
| `DASHBOARD_PORT` | `8792` | 控制台端口 |
| `WORKBUDDY_APP_EXECUTABLE` | 自动探测 | WorkBuddy 客户端路径 |
| `WORKBUDDY_AUTH_FILE` | 自动定位 | 登录文件；多账号时务必显式指定 |

完整列表见 [`.env.example`](.env.example) 与 [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md)。

> 改端口后需同步：控制台会按新配置启动桥，无需手工对齐。

---

## 目录结构

```
启动.cmd                   一键启动（Windows，双击即可）
config.mjs                 统一配置（唯一真源）
.env.example               配置样例
bridge/
  workbuddy-bridge.mjs     桥本体（含 AtRest 解密层）
  launch.mjs               按统一配置独立启动桥
  start-bridge.cmd         Windows 独立启动入口
dsh-plugin/                DeepSeek Harness 原生插件（宿主端 + dsh 设置页）
  lib/index.js            插件入口：桥/控制台生命周期、原生模型路由、工具、命令
  lib/adapter.mjs         dsh 词汇 ↔ OpenAI 词汇（SSE → StreamChunk）
  lib/console.mjs         控制台进程管理（识别 / 复用 / 拉起）
  lib/consoleApi.mjs      控制台 API 白名单透传（设置页与控制台同步的关键）
  lib/client.js           客户端半边：dsh 设置里的 9 标签页（控制台全部功能）
  README.md               插件文档（安装、配置、验证记录）
dashboard/
  server.mjs               控制台后端（仅绑 127.0.0.1）
  public/index.html        控制台前端（单文件）
lib/
  atrest.mjs               AtRest 密钥获取与信封解密
  diagnostics.mjs          8 项环境诊断（页面与 CLI 共用）
  dsh.mjs                  dsh 配置读取与模型注册写入
tools/
  doctor.mjs               命令行自检（doctor --json 可选）
  verify-atrest.mjs        凭据解密自检
  dev/                     开发期探查脚本，日常无需使用
scripts/
  start.sh                 一键启动（macOS / Linux）
docs/                      架构、配置、排错、安全
```

---

## 注意事项

**务必了解的风险与边界：**

1. **非官方路径。** 上游随时可能修改协议或封禁该方式，可用性无保证。团队或商用场景应申请官方 API 访问权限。
2. **不要绑 `0.0.0.0`。** 那等于把订阅额度暴露给整个局域网。项目全程只绑 `127.0.0.1`，请勿修改。
3. **登录文件只读。** 桥不会写回登录文件——这是有意为之，写入明文会破坏客户端的加密凭据存储。令牌刷新结果只留在桥的内存里。
4. **凭据不落盘。** 项目不内置、不缓存、不记录任何令牌明文；诊断只读取长度、账号与有效期。
5. **令牌有效期约 45 天。** 桌面端会自行续期；桥每次请求都重新读取并解密登录文件，因此只要客户端在正常使用就无需额外维护。
6. **额度归属登录账号。** 桥只转发登录账号的请求，消耗的是该账号自身的配额；控制台的「对话测试」也会消耗少量额度。
7. **合规。** 使用前请确认符合 WorkBuddy 的服务条款。详见 [`docs/SECURITY.md`](docs/SECURITY.md)。

---

## 故障排查

| 现象 | 常见原因 |
|---|---|
| 模型没出现在 dsh 里 | 桥没启动 / 路由未生效 / profile bundle 缺失 |
| `settings.yaml` 不见了 | **正常**——DSH Desktop 0.2.0 已把它导入 profile 的 patch 层并归档为 `.imported` |
| `401 Authorization Required` | 令牌失效（重新登录）或凭据未解开 |
| `key fetch failed` | WorkBuddy 未安装或路径变了 |
| `envelope belongs to key ...` | 登录文件由另一个 build 写入（如国际版客户端），或装了多套客户端 |
| `spawnSync ... EBUSY` | 同步子进程调用没设置 `stdio: ['ignore','pipe','pipe']` |
| 选了错的账号 | 登录目录里有多个 `.info`，需显式指定 `WORKBUDDY_AUTH_FILE` |
| 页面显示「桥未运行」但进程还在 | 旧版本的 `/health` 会等上游目录抓取，冷缓存时超过控制台的 4 秒探测超时；新版已改为只读缓存 + 后台刷新 |
| 某个模型调不通 | 看控制台的「最近请求」——失败行标红并带上游错误码（如 `11102` 模型不可用、`11128` 请求结构不被认可），比翻原始日志快 |

> 「可用模型」上方若出现黄色提示条，说明有模型**已注册进 dsh 但已不在上游目录里**
> ——它们会留在 dsh 的模型列表里但调用必然失败，点提示条里的「清理并保存」一步清掉（自动备份），
> 「全选 / 加选免费」也会自动跳过体检结论为「不可用」的模型。

**先跑诊断，缺失项与修法会直接列出来：**

```cmd
node tools\doctor.mjs
```

完整排查表见 [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md)。

---

## 许可

MIT。本项目派生自若干公开项目，完整的来源与改动说明见 [`NOTICE.md`](NOTICE.md)。

与腾讯、WorkBuddy、CodeBuddy、DeepSeek 均无关联，未获其背书或支持。
