# dsh-plugin-workbuddy

把本机 **WorkBuddy 桌面端**已登录的模型，做成 **DeepSeek Harness 的一等公民**。

**分工是「插件当引擎，控制台当界面 —— 且界面就长在 dsh 里」**：

| | 角色 | 负责什么 |
|---|---|---|
| **插件**（dsh 内） | 引擎 + 界面 | 原生模型路由、桥与控制台的启停、工具、命令，以及 **设置 → WorkBuddy** 里的 9 个标签页：概览 / 账号 / 用量 / 请求 / 签到 / 诊断 / 模型 / 对话测试 / 日志 —— 控制台的全部功能 |
| **控制台**（本仓库原有网页） | 同一界面的网页版 | 功能与设置页**完全等价**（见下文的同步设计），想在大屏浏览器里用就开它 |

```
dsh 的模型选择器  ──►  provider: workbuddy   ──►  插件内置适配器
                                                    │  (dsh 词汇 ↔ OpenAI 词汇)
                                                    ▼
                                        bridge/workbuddy-bridge.mjs（独立进程，127.0.0.1:8790）
                                                    │  注入鉴权头 / 现取现解凭据
                                                    ▼
                                              WorkBuddy 上游

dsh 设置 → WorkBuddy（9 个标签页）═══ 同一份状态 ═══ dashboard/server.mjs（控制台网页）
```

---

## 两边如何同步、互不冲突（设计核心）

dsh 设置页与控制台网页是**两个前端、一个后端**，所以天然一致：

| 数据 | 谁写 | 为什么 |
|---|---|---|
| 模型目录 / 用量 / 最近请求 / 签到状态 / 桥日志 | **桥**（两边都只读桥的接口） | 单一事实来源，读操作无冲突 |
| 账号切换 / 自动签到开关 / 模型体检结论 | **只由控制台写**（设置页通过 `/workbuddy/console-api/*` 白名单透传） | 控制台的 `lib/state.mjs` 带进程内缓存，插件若另写这个文件，控制台的缓存就过期了 —— 让唯一持有缓存的进程写，两边立刻一致 |
| 桥 / 控制台进程的启停 | **插件** | 生命周期归引擎管；插件不会去停用户自己双击 `启动.cmd` 起的进程 |

因此：在控制台网页里切账号，设置页 30 秒内（下一次轮询）同步；在设置页体检模型，
控制台的「可用模型」面板看到的是同一份结论。控制台进程没跑时，读功能照常
（读桥），写功能给出「启动控制台」的一键提示；宿主端旧构建（未重启 dsh）时，
明确提示「重启一次 dsh」而不是空白。

透传接口是**白名单**（`consoleApi.mjs`），不是任意路径代理；写操作同样要求
`x-workbuddy-panel: 1` 头。控制台的代码与文件一个字未改。

---

## 它做了什么

| 能力 | 说明 |
|---|---|
| **原生模型路由** | `ctx.llm.registerAdapter(['workbuddy'], …)` —— 模型直接出现在 dsh 模型选择器里，**不写 settings.yaml**，也不依赖 `llm-pi-ai` |
| **动态模型目录** | 模型列表每次向桥要（带 1 分钟缓存），上游加/减模型不必改配置、不必重启 |
| **桥的生命周期** | 启动时复用已在跑的桥，没跑就按配置拉起；桥仍是**独立进程**，控制台、`start-bridge.cmd`、其它 OpenAI 客户端照旧可用 |
| **控制台的生命周期** | 同样复用/拉起 `dashboard/server.mjs`，让它常驻；dsh 里一个链接就进完整控制台（不会自动弹浏览器窗口） |
| **5 个工具** | `workbuddy_status` / `workbuddy_models` / `workbuddy_usage` / `workbuddy_checkin` / `workbuddy_bridge`（后者 `action=console` 可确保控制台在跑） |
| **斜杠命令** | `/workbuddy status\|models\|usage\|checkin\|console\|start\|stop\|restart\|cleanup` |
| **dsh 里的设置页** | 设置 → **WorkBuddy**，9 个标签页 = 控制台的全部功能：概览（含待办提醒与诊断报告）/ 账号（切换）/ 用量（趋势图 + 积分排行 + CSV）/ 请求（筛选 + CSV）/ 签到（领取 + 自动开关）/ 诊断 / 模型（体检 + 详情）/ 对话测试（多轮流式）/ 日志（过滤 + 清空） |
| **旧路由迁移** | 首次加载自动清掉 `llm-pi-ai.providers.workbuddy` 手写路由（**先备份**），否则两条同名路由会撞名 |

---

## 安装

插件就在本仓库的 `dsh-plugin/` 里，安装到某个 dsh profile：

```sh
# 方式一：用 dsh 自带的插件管理（推荐）
dsh plugin --profile desktop add <本仓库路径>/dsh-plugin

# 方式二：在 dsh 界面里装 —— 设置 → 插件 → 安装，填 dsh-plugin 目录的绝对路径
```

装完 **重启一次 DeepSeek Harness**。原因：插件模块会被 ESM 缓存，客户端半个
插件的引导行也只在应用启动时组装一次 —— 热更新看不到新面板。

> 本机（Windows + DSH Desktop）已装好并验证通过，见文末「验证记录」。

### 给别人用 / 分发

插件是**自带一切**的独立包：`npm run vendor` 会把桥、控制台与共享库复制进
`dsh-plugin/vendor/`（16 个文件、约 366 KB），于是对方**不需要仓库**，只要有：

- Windows + Node 18+
- WorkBuddy 桌面端**已登录**
- dsh 桌面版

拷 `dsh-plugin/` 文件夹（或 `npm run pack:plugin` 出的 tgz）过去 → 对方跑一次
`node <插件>/scripts/preflight.mjs` 自检 → 用 dsh 的插件安装指向它 → 重启 dsh。

完整的路线（拷文件夹 / tarball / 发 npm）、验收清单、端口与目录说明、九条常见
故障排查，见 **[docs/INSTALL.md](../docs/INSTALL.md)**；
关于"能不能上架到 DeepSeek 官方插件"以及 npm 发布的实际步骤与合规提醒，见
**[docs/PUBLISH.md](../docs/PUBLISH.md)**。

```sh
npm run vendor             # 生成/更新插件自带的 vendor/（分发前必做）
npm run vendor:check       # 校验 vendor/ 与仓库是否同步（CI / 发版前）
npm run preflight          # 环境自检：Node、脚本、登录文件、端口、模型、安装情况
npm run pack:plugin        # vendor + npm pack → dsh-plugin-workbuddy-<版本>.tgz
npm run verify:standalone  # 把插件拷到没有仓库的临时目录，真起一遍桥与控制台
npm run release:check      # = vendor:check + 单测 + 独立分发演练（发版前一键）
```

> 仓库在旁边时插件**优先用仓库**（本机改 bridge/dashboard 立刻生效），
> `vendor/` 只在找不到仓库时兜底 —— 这条顺序有单测守着。
> `vendor/` 只含运行必需的 15 个文件（约 347 KB）；日志、用量账本、`.state.json`、
> `*.bak`、`.env` 一律不打包（脚本还会主动清理遗留的这类文件）。

### 依赖

- Node.js 18+
- 桥与控制台脚本：仓库里的 `bridge/workbuddy-bridge.mjs`、`dashboard/server.mjs`，
  或插件自带的 `vendor/` 副本（插件通过 `projectRoot` 找它们）
- WorkBuddy 桌面端已安装并登录

插件**只连本机回环地址**，不新增任何对外监听、不上报任何数据。

---

## 配置

配置写在 profile 的 `cordis.patch.yml` 里，按 id 覆盖插件条目：

```yaml
- id: workbuddy
  config:
    projectRoot: E:\workbuddy-to-dsh   # 可选：桥脚本所在仓库；默认自动探测
    bridgePort: 8790
    localToken: wb-local-bridge
    autoStart: true
    consoleAutoStart: true             # 控制台（数据界面）也由插件复用/拉起
    consolePort: 8792                  # 默认跟 .env 的 DASHBOARD_PORT 对齐
    displayName: WorkBuddy
    modelAllow: []                     # 只放行这些模型 id（空 = 全部）
    modelDeny: []
    migrateLegacy: true                # 首次加载清理 llm-pi-ai 里的旧 workbuddy 路由
    tools: true
    commands: true
    routes: true
```

完整默认值见 [`lib/index.js`](lib/index.js) 的 `DEFAULTS`。

`projectRoot` 的探测顺序：配置 → `WORKBUDDY_ROOT` 环境变量 → 插件目录的上一级
（插件放在仓库里时）→ `node_modules` 上溯三级 → `~/workbuddy-to-dsh` → `E:\workbuddy-to-dsh`。

**`.env` 也会被尊重**：桥进程只认环境变量，而你可能把端口 / 登录文件写在仓库的
`.env` 里（`config.mjs` 的"统一配置真源"）。插件会读它并补齐默认值，优先级为

```
插件 config（显式写的） > .env > 进程环境变量 > 内置默认值
```

认的键：`WORKBUDDY_HOST`、`WORKBUDDY_PORT`、`WORKBUDDY_LOCAL_TOKEN`、
`WORKBUDDY_AUTH_FILE`、`WORKBUDDY_AUTO_CHECKIN`、`DASHBOARD_PORT`。

---

## 和旧流程的关系

在插件之前，模型靠**两处手写 YAML** 注册：`$DSH_HOME/settings.yaml` 与 profile 的
`cordis.patch.yml`。两条路都指向同一个桥，但用**同一个 provider 名**，因此不能共存。

插件加载时会：

1. 探测这两个文件里是否存在 `llm-pi-ai.providers.workbuddy`；
2. 存在就按行删掉那一段（**只动这一段**，其它行一个字符不改），并写
   `<文件>.bak-<时间戳>` 备份；
3. 在入口页/工具里如实报告删了什么、备份在哪。

关掉这个行为：`migrateLegacy: false`，此时插件只提示、不改文件（但两条路由撞名，
插件会退到 `fallbackProvider`，默认 `workbuddy-native`，入口页里会显示"兜底"）。

手工清理也可以在入口页点「清理旧路由」，或执行 `/workbuddy cleanup`。

---

## dsh 里的设置页（控制台的全部功能）

**设置 → WorkBuddy**（`settings.section` 槽，注册 id `workbuddy`），9 个标签页：

| 标签页 | 内容 |
|---|---|
| **概览** | 待办提醒（桥停了 / 令牌临期 / 路由未注册 / 有旧路由）、状态卡（账号 / 令牌 / 积分 / 原生路由）、操作条（启停桥与控制台、复制诊断报告与桥地址） |
| **账号** | 登录目录下全部账号快照与可用性，一键切换（等价于控制台的切换：自动重启桥、清体检与余额缓存） |
| **用量** | 1/7/30 天（24 小时粒度）、趋势图（次数 / tokens / 积分，内联 SVG）、指标卡、按模型积分排行、失败列表、导出 CSV、清空账本 |
| **请求** | 逐条请求（模型筛选 / 仅看失败 / 条数 / 暂停自动刷新）、失败标红、点失败复制详情、导出当前筛选 CSV |
| **签到** | 今日状态 / 连续天数 / 上次尝试 / 自动签到开关 / 一键领取 |
| **诊断** | 8 项环境诊断（与控制台同一套 `lib/diagnostics.mjs`），按状态着色、带建议 |
| **模型** | 动态目录全表（上下文 / 输出 / 倍率 / 多模态）、全部体检 / 重测不可用 / 单个重测（带进度）、清除结论、详情 ⓘ、导出 CSV |
| **对话测试** | 多轮流式对话、按模型选择、停止、本轮耗时 / tokens / 扣分（会消耗你的额度，与控制台同一行为） |
| **日志** | 关键字过滤 / 只看错误 / 只看本次启动 / 暂停刷新 / 行数选择 / 清空 |

页面数据来自插件挂的同源 HTTP 路由：

| 路由 | 用途 |
|---|---|
| `GET /workbuddy/status[?quota=1]` | 桥 + 控制台 + 路由 + 模型目录 + 旧路由 + 积分（`quota=1` 强制重读上游） |
| `GET/POST /workbuddy/quota` | 积分缓存 / **强制重读上游**（积分卡上的「刷新积分」按钮） |
| `GET /workbuddy/models[?refresh=1]` | 归一化后的模型目录 |
| `GET/DELETE /workbuddy/usage?days=N[&hours=1]` | 本地账本汇总 / 清空（删必须面板头） |
| `GET /workbuddy/requests?limit=N` | 最近请求明细 |
| `GET/DELETE /workbuddy/log?lines=N` | 桥日志尾部 / 清空 |
| `GET/POST /workbuddy/checkin[?claim=1]` | 签到状态 / 领取 |
| `GET/POST /workbuddy/console` | 控制台状态 / `{action: start\|stop}` |
| `POST /workbuddy/bridge` | `{action: start\|stop\|restart\|status}` |
| `GET/POST /workbuddy/migrate` | 探测 / 清理旧路由（POST 带 `{dryRun:true}` 可预演） |
| `*  /workbuddy/console-api/<白名单>` | 控制台域功能的受控透传（见「两边如何同步」） |

**写操作必须带 `x-workbuddy-panel: 1` 头**：这会让跨站表单/简单请求直接打不进来
（带自定义头会触发 CORS 预检，而预检不会被放行），等于用最小代价挡掉 CSRF。
读接口只返回非敏感元数据，**绝不含任何令牌或对话内容**。

> 版本错配的兜底：控制台域的面板遇到「控制台没跑」给一键启动，遇到「宿主端旧构建
> （未重启 dsh，透传 404）」给明确的重启提示 —— 不会出现空白表格或对 404 空转。

---

## 工具与命令

| 工具 | 用途 |
|---|---|
| `workbuddy_status` | 桥 / 账号 / 令牌 / 积分 / 路由 / 模型数 / 控制台地址，排查「模型没出现」的第一步 |
| `workbuddy_models` | 列出当前真正可用的模型（可过滤、可强制刷新） |
| `workbuddy_usage` | 最近 N 天调用次数、tokens、积分、失败数 |
| `workbuddy_checkin` | 签到状态；`claim=true` 立即领取 |
| `workbuddy_bridge` | `status` / `start` / `stop` / `restart` 桥；`console` 确保控制台在跑并返回地址 |

```
/workbuddy status      桥与路由总览
/workbuddy models      可用模型
/workbuddy usage       最近 7 天用量
/workbuddy checkin     签到状态
/workbuddy start|stop|restart
/workbuddy cleanup     清理旧的 llm-pi-ai 路由
```

---

## 实现要点（给要改代码的人）

- **宿主端不 import 任何 `@deepseek-ai/*` 包**。`llm.registerAdapter()` 只调用
  `adapter.providerInfo()` 与 `adapter.providerRetryPolicy()`，**没有 instanceof
  检查**，所以适配器是普通对象即可；profile 的 `node_modules` 里本来也解析不到
  那些包。可选服务（`tools` / `commands` / `webServer`）统一走 `ctx.inject` 等就绪。
- **适配器必须走 `ctx.llm` 属性**而不是 `ctx.get('llm')`：cordis 的服务代理会把
  `this.ctx` 绑到**调用方**的 fiber，注册才不会挂到别人的生命周期上。
- **派发失败必须以 `finish` 块收尾**（`kind: 'error'`），不能向调用方抛；
  dsh 的流协议是 block-start → *-delta → block-end，末尾 usage → finish。
- **客户端半边是 lazy-CJS 包**（`window.__ModuleLoader__.load({id, factory})`），
  由 dsh 的引导图加载，`react` 来自平台模块表。`dsh.client.inject` 是**引导图上的
  行依赖**（写包名），不是 cordis 服务名 —— 写错会让整行不激活；本插件因此不声明它，
  改在运行时用 `ctx.inject(['slots'], …)` 等槽服务。
- **桥与控制台都是独立进程**：插件停用/卸载只会摘掉路由、工具与入口页，
  **不会杀掉桥**，也不会去停别人（双击 `启动.cmd`）起的控制台 ——
  只停自己拉起来的那个。
- **不会和插件抢着拉桥**：插件拉起的控制台实例带 `DASHBOARD_AUTO_START_BRIDGE=0`
  （桥归插件管），避免两个进程同时探测→同时 spawn 打出 `EADDRINUSE`。
  想让控制台照旧自己拉桥，就在环境里显式设成 `1`。
- **控制台靠首页标题识别**（`<title>WorkBuddy 中转控制台</title>`），不是"端口能连上就算数"：
  端口被别的服务占着时会报 `foreign` 并拒绝动手，不会误连一个陌生 HTTP 服务。
  探测结果有 20 秒缓存（面板每 10 秒问一次状态，没必要每次都拉首页）。

### 目录

```
lib/index.js       插件入口：配置、路由注册、工具/命令/设置页装配、旧路由迁移
lib/adapter.mjs    dsh 词汇 ↔ OpenAI 词汇；SSE → StreamChunk
lib/bridge.mjs     桥进程管理 + HTTP 客户端
lib/console.mjs    控制台进程管理（识别 / 复用 / 拉起）
lib/consoleApi.mjs 控制台 API 的白名单透传（同步设计的关键）
lib/models.mjs     模型目录归一化
lib/tools.mjs      5 个模型可见工具
lib/routes.mjs     HTTP 数据面（同源）
lib/legacy.mjs     旧路由探测与文本级清理（带备份）
lib/client.js      客户端半边：dsh 设置里的 9 标签页
tests/             协议/装配/旧路由/控制台/透传测试 + 设置页渲染验证
```

### 自测

```sh
# 协议与装配（打桩上游，不碰真实额度）
node --test dsh-plugin/tests/          # 或：npm run test:plugin

# 入口页渲染验证（无头浏览器 + **真实数据**，产出 docs/plugin-panel.png）
node dsh-plugin/tests/panel-render.mjs # 或：npm run panel:shot
node dsh-plugin/tests/panel-render.mjs --offline   # 只用内置样例数据
```

`panel-render.mjs` 需要无头 Chrome/Edge（项目自带的 [`tools/dev/ui-harness.mjs`](../tools/dev/ui-harness.mjs)
会去找），首次运行会把 React UMD 下到 `.tmp-research/vendor/` 供离线渲染使用。

---

## 验证记录

在 **Windows + DSH Desktop 0.2.0-rc.2 / profile `desktop`** 上：

| 项 | 结果 |
|---|---|
| 纯逻辑测试 | `node --test dsh-plugin/tests/` **30 项全绿**（流协议、工具调用、错误/取消、wire 转换与净化、日志尾部读取、**方法/权限矩阵**、旧路由手术、装配、路由鉴权、.env 优先级、控制台识别与复用、console-api 白名单透传） |
| 安装 | `plugin_manager install_bundle` 成功，profile 依赖为 `link:E:/workbuddy-to-dsh/dsh-plugin`（源码改动直接可见） |
| 桥复用 | 复用已在运行的桥（pid 31840，已运行 12h+），未重复拉起 |
| 控制台复用 | 控制台已在 8792 运行（首页标题匹配）→ 插件判定 `running` 并复用，不再拉起第二个 |
| 原生路由 | `route.registered=true provider=workbuddy`，目录 30 个模型 |
| **真实模型调用** | 以 `provider: workbuddy` + `model: deepseek-v4.1-flash` 跑通一次真实 agent 轮次，返回「桥已接通。」；桥日志同时出现该请求 |
| 工具 | 5 个工具注册进当前会话并返回真实数据（状态/模型/用量/签到/桥） |
| 设置页渲染（场景 1：全部可用） | 无头浏览器加载真实客户端半边：注册契约（`name`/`slots.inject`/模块级 `inject`）逐项断言；**9 个标签页逐个点开**且都有预期内容；趋势图 SVG、模型表行数、「启动控制台」确实发出 POST；无页面错误（截图 `docs/plugin-panel*.png`） |
| **溢出防护** | 每个标签页都跑横向溢出检查（`scrollWidth > clientWidth` 即失败）；夹具故意塞进真实机器出现的长路径 / 多账号 / 长域名。靠 `box-sizing:border-box` + 内容驱动列宽 + 分层 `overflow-wrap` 策略钉死 |
| **表格布局（窄列场景 3）** | 在 **620px**（比设置页常见宽度还窄）跑一遍：逐表检查**单元格盒子互不重叠**、内容不宽于格子、单元格不被压到 34px 以下、视口无横向溢出；账号页另外要求卡片内无任何元素溢出/被裁。这套断言正是"7 列挤成一团 + 胶囊压住邻居"那张截图的机器可判定形式 |
| **启动窗口 404 自愈** | 请求页的桩**故意首帧回 404**（模拟刷新页面时宿主还没挂上路由），断言面板必须自己重试恢复并渲染出行 —— 不许把 `HTTP 404` 挂在那儿等下一个轮询周期 |
| **下拉可读 + 模型可选** | 原生 `<select>`/`<option>` 显式给底色与字色（暗色主题下曾是"浅字落白底"几乎看不见）；断言对话测试的模型下拉 ≥5 个选项、改值生效、且**切标签页回来仍保持** |
| **对话端到端** | 桩提供 text/event-stream 的对话流：断言流式回答渲染、**逐轮元数据**（耗时/tokens/扣分贴在每条回答下方）、且确实发出 POST `/workbuddy/console-api/chat` |
| **破坏性操作二次确认** | 清空账本 / 清空日志 / 清除体检结论都必须先确认：断言"点取消不发请求、点确定才发 DELETE" |
| **待办提醒** | 概览页要出现「今日还没签到」「最近请求里有 N 条失败」，并且按钮能跳到对应标签页（跨页跳转由容器提供） |
| **积分卡** | 概览第一张卡就是积分：断言数字字号 ≥26px（实际 38px）、套餐数与进度条数量一致、**同名套餐已合并**（上游会把同一档权益拆成多条）、点「刷新积分」确实发出 `POST /workbuddy/quota` 且给出结果提示 |
| **模型详情紧跟该行** | 点「详情」后断言详情块是一个 `<tr class="wb-detail-row">`，且它的**上一行就是被点的那个模型**（不是挂到整张表下面）；内容含模型 ID / 上下文·输出 / 多模态 / 计费倍率；点「用这个模型对话 →」要切到对话测试并选中该模型 |
| **促销徽章 / 多模态标记** | 断言模型列表渲染出带色徽章（`限时免费` 等）与**文字版**多模态标记「图片」，页面上**不出现 `badge:…:#颜色` 原始规格、也不出现 emoji 字符**（🖼 这类没人看得懂、字体会渲染成怪块）；同时要有"共 N 个模型，其中 M 个支持图片输入"的统计行 |
| **表格不紧凑** | 断言模型表在标准宽度下**不需要横向滚动**、操作列按钮**不竖着堆**、行高 ≤80px（被挤扁时按钮会堆起来、行高会暴涨）；列数也做了收敛：上下文与输出合并成一列（拆分信息在详情里） |
| **诊断误报改判** | 诊断库「dsh 模型路由」用迁移前口径（只认 settings.yaml），对插件的原生路由永远误报 fail —— 设置页按运行时事实改判为 ok（注明"插件运行时注册，无需 settings.yaml"），过时的「勾选后保存」建议一并隐藏 |
| 设置页渲染（场景 2：宿主旧构建 404） | 控制台域面板都给出「重启一次 dsh」提示；签到页「立即领取」照常；模型页主表照常而「全部体检」禁用（可用性未知即禁用，避免对不存在的接口空点）—— 桥域功能不受影响 |
| 停用清理 | 禁用 bundle 后路由 404、工具消失，**桥仍在运行** |

**已知限制**

- 客户端半边与宿主端的改动都需要**重启一次 dsh** 才生效（模块被 ESM 缓存、
  客户端引导行只在应用启动时组装）；未重启时设置页自己会提示。
- 设置页与控制台网页是同一后端的两个前端：轮询有间隔（状态 8 秒、请求 5 秒、
  账号 30 秒、签到 5 分钟），所以"另一边刚改完"最多延迟一个轮询周期才显示 ——
  数据本身是同一份，不存在两份各说各话。
- 签到状态会打到上游计费端点：宿主快照里那份**后台刷新、30 分钟 TTL、绝不阻塞
  状态查询**；设置页概览自己也会问一次（5 分钟一次）。
- 控制台诊断库的「dsh 模型路由」一项仍是迁移前口径，**只在设置页被改判**为运行时
  事实（控制台网页本身照旧显示，因为它没被改过一行）。

---

## 这一轮修掉的 bug（都补了回归测试）

| 症状 | 根因 | 修法 |
|---|---|---|
| 刷新页面后满屏 `HTTP 404`，要等一两分钟才恢复 | dsh 的 Web 兜底处理器在插件路由挂上之前一律回 404，而面板把这一帧当终态，下一个轮询要 5~120 秒 | `getJson` 对 404 快速重试 3 次；`useJson` 对任何失败再排一次 4 秒重试；文案改为"插件还没就绪，正在自动重试" |
| 概览页「重新诊断」点了没反应 | 它调用了一个**根本不存在分支**的 action（`refresh`） | 拆成「刷新状态」+「去诊断 →」，「需要你动手」的每条待办也有对应按钮 |
| `status.checkin` 永远是 `null`（工具里看不到签到） | `state.checkinCache` 从来没有人写（实现遗漏的死字段） | 宿主后台刷新（TTL 30 分钟、在途去重、不阻塞 status），快照同时给出 `checkinError` |
| 桥日志轮询会把整个文件读进内存 | `readLog` 先 `readFileSync` 全量再切片，而日志是无限增长的、面板每 5 秒问一次 | 改用 fd 只读尾部 `size - maxBytes`，丢掉被截断的半行 |
| 请求页的模型筛选越用越少 | 下拉只列**当前这一页**出现过的模型 | 改成来自完整模型目录，再并入历史里出现过的旧模型（并显示数量） |
| 失败请求显示「失败 HTTP 0」 | 用 `r.status \|\| 0` 兜底 | 有状态码才显示，并带上 `code`，hover 显示错误原文、点击复制完整详情 |
| 清空账本 / 清空日志点了没反应、也不报错 | 破坏性操作既不确认也不检查响应 | 都要二次确认；成功后提示，失败显示 `错误/HTTP 码` |
| 对话测试只有"最后一轮"的 tokens/扣分 | 元数据存在面板级 `meta`，逐轮丢失 | 元数据贴到**每条回答**下方；本地 `meta` 只作"最近一轮"小结 |
| 上一轮失败留下的空助手消息会被回灌给上游 | 历史原样下发，`content:null` 且无 tool_calls 的助手轮 + 孤儿 tool 结果都可能被上游 400 | adapter 增加 `sanitizeWire()`：剔空助手轮、剔孤儿 tool 结果、成对的工具调用保留（含测试） |
| 只读路由对 `PUT` 也照常返回数据 | 读路由没有方法守门（无副作用，但不严谨） | 只读路由非 GET/HEAD 一律 405；`/workbuddy/checkin` 只允许 GET 与带面板头的 POST `?claim=1` |
| **账号页 7 列挤成一团**：文字逐字折断（`workbudd/y-/desktop.inf/o`）、`使用中` 胶囊压住「令牌剩余」 | 上一轮为"防溢出"把表格设成 `table-layout:fixed` + `overflow-wrap:anywhere`：列被均分到 ~95px，逐字折行；胶囊 `nowrap` 则溢出单元格盖住邻居 | 数据表改回**内容驱动列宽**（`table-layout:auto`）+ 只在词/连字符处换行 + 数字列 nowrap + 胶囊 nowrap（auto 布局下列宽不会小于胶囊）；**账号页改成"每账号一行"的列表**（设置页是窄列，5~7 列表格在那里必然被挤压；账号通常 2~3 个，列表宽窄都好看） |
| 窄列下胶囊被拆成"使/用/中"三行、域名被折成 `copilot.tencent.co`/`m` | 允许任意断行会让该列的 min-content 只剩一个汉字宽；域名在硬撑的窄列里只能逐字断 | 胶囊恢复 nowrap；账号列表让长域名整行展示（有整行宽度，不再和 5 个列抢地方） |
| **模型详情跑到列表最下面**，点完不知道是哪个模型的 | 详情块渲染在 `<tbody>` **之外**（挂在整张表下面） | 改成展开行：`tbody` 里紧跟该行插入 `<tr class="wb-detail-row">`，被点的行高亮、按钮变「收起」，详情里再给「用这个模型对话 →」（直接切到对话测试并选中它） |
| 模型详情里「厂商 j」看不懂；标签里混着 `badge:限时免费:#FF0000` | `vendor` 是上游的单字母代码（不是厂商名）；上游把促销徽章塞在 `tags` 里且**颜色信息被当字符串丢掉** | 目录层把 `badge:标签:颜色` 拆成结构化的 `badges: [{label, color}]`、`tags` 只留干净标签；界面把徽章渲染成**带色小标记**，「厂商」改标为「厂商标识」并加说明 tooltip。客户端同时兼容旧宿主（自己从 tags 解析），所以不重启也能看到徽章 |
| 模型名后面每行都有个看不懂的 🖼（字体还渲染成怪块） | 我用 emoji 标了"支持图片输入"，但没人看得懂、字形不稳，而且塞在名字后当噪音 | 换成文字标记「图片」（带 tooltip），并在表头上方给统计行「共 30 个模型，其中 20 个支持图片输入」；加断言禁止 emoji 再出现在列表里 |
| 模型表被挤得很紧凑：出现横向滚动条、`测`/`详情` 按钮竖着堆、行高暴涨 | 列太多（上下文与输出各占一列、体检列还塞了实测扣分），表宽超出卡片；被压窄的操作列里按钮换行了 | 收敛成 6 列（上下文/输出合并、体检列去掉扣分）、操作列 `white-space:nowrap;width:1%` + 右对齐；加断言：标准宽度下不许横向滚动、按钮不许堆、行高 ≤80px |

**新增（对齐控制台的能力）**：概览待办提醒（未签到 / 最近失败 / 令牌临期 / 路由未注册 / 旧路由）+ 就地处理按钮；
账号页新增凭据列（AtRest 信封 / 明文）与**不可用原因内联**；模型页新增「全部 / 只看不可用 / 只看未测」筛选；
日志页新增行数统计与「复制当前视图」；对话测试新增模型筛选输入与逐轮元数据。

---

## 许可

MIT，与本仓库其余部分一致。与腾讯、WorkBuddy、CodeBuddy、DeepSeek 均无关联。
