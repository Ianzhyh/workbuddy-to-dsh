# 交接文档：dsh-plugin-workbuddy（WorkBuddy → DeepSeek Harness 原生插件）

> 写给下一个接手的人（或未来的自己）。本会话把 `workbuddy-to-dsh` 从"独立桥 + 手写
> YAML 注册"升级成了一个**已装好、已验证、正在服役**的 dsh 原生插件。本文记录它
> 现在的形态、全部关键契约（都是踩过坑换来的）、验证体系、对真实系统动过的每一处，
> 以及继续开发前必须知道的事。
>
> 交接时状态：**全部绿**。27 项测试通过，渲染验证两场景通过，插件路由正被真实
> agent 轮次使用中。

---

## 0. 一句话状态

- 插件 `dsh-plugin-workbuddy`（源码目录 `dsh-plugin/`）已装入 dsh 的 `desktop` profile（`link:` 方式），原生模型路由 `workbuddy` 已注册、30 个模型可用，桥（8790）与控制台（8792）都在运行且被插件复用。
- dsh 设置里有一页 **WorkBuddy**（9 个标签页），承载控制台的全部功能；与控制台网页"两个前端、一个后端"，天然同步。
- 用户已确认的使用方式：**不要 iframe 内嵌**，功能原生做进设置页，与控制台双向同步、互不破坏。

---

## 1. 用户决策史（为什么是现在这个形态）

| 决策点 | 结论 |
|---|---|
| 插件范围 | 宿主端原生插件 + 图形界面（最初以为要做面板） |
| 桥的形态 | 保留独立桥进程，插件只管生命周期（复用/拉起/停止） |
| "没有界面做插件干嘛" | 插件的价值 = **原生模型路由**（控制台做不到的事），面板只是补充 |
| "两个结合" | 插件当引擎、控制台当界面：插件把控制台也管起来并给入口 |
| "控制台直接内嵌" | 做过（CSP 已验证允许），**后被用户否决** |
| 最终形态（现行） | **控制台全部功能原生实现进设置页**（9 个标签页），不内嵌；与控制器双向同步；原控制台一字不改 |
| 沟通语言 | 中文 |

---

## 2. 用户视角：装了什么、怎么用

- **选模型**：dsh 输入框的模型选择器 → provider `WorkBuddy`（回退名 `workbuddy-native`），模型列表动态跟随上游，不用勾选保存、不用重启。
- **设置 → WorkBuddy**（9 个标签页）：概览 / 账号 / 用量 / 请求 / 签到 / 诊断 / 模型 / 对话测试 / 日志。功能与控制台网页完全等价。
- **控制台网页**（127.0.0.1:8792）照旧可用；由插件复用/拉起/保活，不自动弹浏览器。
- **agent 工具**：`workbuddy_status` / `_models` / `_usage` / `_checkin` / `_bridge`（`action: status|start|stop|restart|console`）。
- **斜杠命令**：`/workbuddy status|models|usage|checkin|console|start|stop|restart|cleanup`。
- 装法：dsh 界面插件安装，或 `dsh plugin --profile desktop add E:\workbuddy-to-dsh\dsh-plugin`。

---

## 3. 架构（两个前端、一个后端）

```
dsh 的模型选择器 ──► provider: workbuddy ──► 插件适配器（lib/adapter.mjs）
                                              │  dsh 词汇 ↔ OpenAI 词汇，SSE → StreamChunk
                                              ▼
                                  bridge/workbuddy-bridge.mjs（独立进程 127.0.0.1:8790）
                                              │  AtRest 凭据现取现解、注入鉴权头
                                              ▼
                                        WorkBuddy 上游（copilot.tencent.com）

dsh 设置页（9 标签页）═══ 同一份状态 ════ dashboard/server.mjs（控制台 8792）
        │ 读：直接读桥的接口                     ▲
        └ 写：/workbuddy/console-api/* 白名单透传 ┘（由控制台写 .state.json）
```

**同步与互斥的核心规则**（`lib/consoleApi.mjs` 顶部注释也写了）：

| 数据 | 谁写 | 为什么 |
|---|---|---|
| 模型目录 / 用量 / 请求 / 签到状态 / 桥日志 | 桥（两边只读） | 单一事实来源 |
| 账号切换 / 自动签到开关 / 体检结论 | **只由控制台写** | 控制台的 `lib/state.mjs` 带进程内缓存；插件若另写 `.state.json`，控制台缓存过期 → 两边各说一套。透传让唯一持缓存的进程写 |
| 桥 / 控制台进程启停 | 插件 | 插件不停用户自己双击 `启动.cmd` 起的进程（控制台没有 /health 自报 pid，无法安全归属） |

透传是**白名单**（`/overview`、`/diagnose`、`/accounts`、`/account/switch`、`/probe`、`/probe-results`、`/checkin`、`/checkin/settings`、`/chat`），不是任意路径代理；写操作一律要求 `x-workbuddy-panel: 1` 头（防跨站简单请求）。

**诊断误报改判**（设置页专用逻辑）：控制台诊断库的「dsh 模型路由」一项用迁移前口径（只认 settings.yaml），对原生路由永远误报 fail。设置页在 `status.route.registered` 为真时把该项改判为 ok，注明"插件运行时注册，无需 settings.yaml"，并隐藏过时建议。概览页的 `overview.dsh.routeLive` 同口径误报已忽略。

---

## 4. 关键契约（改代码前必读，全是踩坑实录）

### 宿主端（cordis 插件）

1. **`llm.registerAdapter` 没有 instanceof 检查** —— 适配器是普通对象即可（只调用 `providerInfo()` 与 `providerRetryPolicy()`，同步、无 I/O）。所以 `lib/` **不 import 任何 `@deepseek-ai/*` 包**（profile 的 node_modules 也解析不到）。
2. **必须走 `ctx.llm` 属性**，不能先 `ctx.get('llm')` 再调用 —— cordis 服务代理把 `this.ctx` 绑到**调用方**的 fiber。
3. **注册撞名**（DUPLICATE_ADAPTER）：`apply()` 里同步 try/catch + 异步退避重试 6 次，仍失败退到 `fallbackProvider`（`workbuddy-native`）。
4. **派发失败必须以 `finish` 块收尾**（`kind:'error'`/`'aborted'`），绝不向调用方抛。流协议：`block-start → *-delta → block-end`（按出现顺序分配 index），末尾 `usage → finish`。空回复（stop 且无任何块）= `EMPTY_RESPONSE` 错误，不是成功。
5. **可选服务**（tools/commands/webServer）用 `ctx.inject([name], cb)` 等就绪；`ctx.inject` 不存在时退回 `ctx.get`（装配测试需要）。
6. **`.env` 要尊重**：插件自己解析项目根 `.env`（键：`WORKBUDDY_HOST/PORT/LOCAL_TOKEN/AUTH_FILE/AUTO_CHECKIN`、`DASHBOARD_PORT`），优先级：插件 config 显式 > .env > 进程环境 > 内置默认。
7. **projectRoot 探测**：配置 → `WORKBUDDY_ROOT` → 插件目录上一级 → node_modules 上溯三级 → `~/workbuddy-to-dsh` → `E:\workbuddy-to-dsh`。
8. **停用/卸载**：只摘路由/工具/路由表，**不杀桥**；控制台也只停自己 spawn 的（`spawnedPid` 归属判断）。
9. 插件拉起的控制台实例带 `DASHBOARD_AUTO_START_BRIDGE=0` + `DASHBOARD_OPEN_BROWSER=0`（否则与插件抢拉桥 → EADDRINUSE、且每次启动弹浏览器）。

### 控制台对接

10. **靠首页标题识别控制台**（`<title>WorkBuddy 中转控制台</title>`），不是"端口能连上就算"——占端口的外来服务报 `foreign` 并拒绝动手。探测有 20 秒缓存。
11. 透传 handler 对 `req`/`res` 的成员要求极少（`method/url/headers/asyncIterable` + `writeHead/write/end/on/off`），测试里用假对象即可。

### 客户端半边（dsh web 设置页）—— 上次爆红的根源，逐字对齐核心插件

12. **包格式**：`window.__ModuleLoader__.load({ id, factory })` 的 lazy-CJS 包；`react` 来自平台模块表（`require('react')`）。`dsh.client` 只需 `{ platform: "web" }`。
13. **`dsh.client.inject` 是引导图上的"行依赖"（写包名）**，不是 cordis 服务名——声明了不存在的东西会让整行不激活。本插件**不声明**它。
14. **cordis 服务依赖写成模块级导出**：`exports.inject = ['slots']`（核心插件都这么写）。
15. **注册三件套**（缺一就是"注册了未声明的槽"→ 纤维失败 → 面板静默消失）：
    - 槽位键是 **`name`**（不是 `key`，`key` 是 keyed 槽的派发键）；
    - 包在 `ctx.slots.inject('settings.section', () => slots.register({...}, Component))` 里；
    - `apply` 从 `ctx.slots` 取服务。
16. **客户端半边改动 = 刷新页面即生效**（bundle 按文件 rev 热取，实测过）；**宿主端改动 = 必须完全重启 dsh**（ESM 缓存）。设置页对"宿主旧构建"（透传 404）有专门的"重启一次 dsh"提示，不会空白。

### 版本错配容错（客户端读取）

17. `/workbuddy/usage` 兼容两种形状：摊平的 `{ok,total,models,days,…}`（现行）与旧的 `{usage:{…}}`；`/workbuddy/checkin` 同理兼容 `{status:{…}}` 与旧扁平形。
18. **启动窗口 404 必须自愈**：dsh 的 Web 兜底处理器在插件路由挂上之前对任何未命中路径回 **404**。刷新页面的瞬间正好撞上这个窗口，早期实现会把红字 `HTTP 404` 挂在面板上直到下一个轮询（用量 60s / 模型 120s）。现在：`getJson` 对 404 快速重试 3 次（0.5/1/1.5s，文案"插件还没就绪（HTTP 404），正在自动重试…"），`useJson` 对**任何**失败再额外排一次 4 秒重试。
19. **原生 `<select>` 在暗色主题下必须显式给 `option` 底色/字色**（`.wb-select option{background:light-dark(#fff,#3a3b3d);color:…}`）——否则弹出的选项是"浅字落白底"，用户会以为控件坏了/不能选（真实反馈过）。按钮本体也要有实底与描边。
20. **可用性未知即禁用**：体检/自动签到开关等控制台域动作，用 `availability.state === 'ok'` 判定可操作性，而不是"状态码不是 503/404"——加载中或判定未完成时一律禁用，避免对不存在的接口空点。
21. **对话测试的模型与消息由容器持有**（`WorkBuddyPanel` 的 `chatModel`/`chatMessages` 传给 `ChatPanel`）：切标签页回来不重置，避免"模型像是写死的"的误解。要改 agent 本身的模型，用 dsh 输入框旁的模型选择器（provider 选 WorkBuddy），设置页里的下拉只作用于本页测试。
22. **表格布局：窄列优先。** dsh 设置是窄列（常见 600~700px），`table-layout:fixed` 会把列均分到几十 px，配 `overflow-wrap:anywhere` 就变成逐字折断；`nowrap` 的胶囊又会溢出单元格压住邻居。现行规则：
    - 数据表用 `table-layout:auto`（列宽由内容决定）+ 普通单元格 `overflow-wrap:break-word`（只在词/连字符处断，实在放不下才断词）；
    - 数字/时间列 `nowrap`；胶囊 `nowrap`（auto 布局下列宽不会小于胶囊宽度，所以既不会被拆行也不会压邻居）；
    - 确实很长的文本单元格用 `td.wrap`（`anywhere` + `min/max-width`）；
    - **不要用表格展示"每项只有 2~3 条"的列表**：账号页就是改成"每账号一行"的卡片式（`lib/client.js` 的 `.wb-account`），窄列宽列都好看、长域名不用折断。
    - 改完必须跑 `panel-render.mjs` 的场景 3（620px 盒子级检查），它专门守这条。
23. **积分（额度余额）要走"强制刷新"路由。** 快照里的积分有 120 秒缓存，所以面板上的刷新按钮必须打 `POST /workbuddy/quota`（宿主端 `snapshot({quota:true})`）才能真正重读上游；`GET /workbuddy/status?quota=1` 是同一能力的另一入口。面板对"宿主旧构建（404）"要降级成状态刷新并说明原因，不能只报错。
24. **同名套餐要合并计数**：上游会把同一档权益拆成多条（实测 4 条同名 `100/100`），逐条列出来只是噪音；合并后显示 `名称 ×4` 并累加 remain/size。
25. **行内详情不要挂到表尾。** 表格里的"详情/展开"必须是 `tbody` 内**紧跟该行**的一个 `<tr class="wb-detail-row">`（`flatMap` 返回 [行, 详情行]）；挂到 `<table>` 之后会让人分不清是哪个模型的。被展开的行要高亮、按钮文案要变成「收起」，详情里再给一个"用这个模型去做 X"的直达动作。
26. **模型目录的两个字段有坑**：`vendor` 是上游单字母代码（`f/j/v/e`，不是厂商名，界面标为"厂商标识"）；促销徽章藏在 `tags` 里形如 `badge:限时免费:#FF0000`，**颜色在里面**，要在 `toDirectory` 里拆成 `badges: [{label,color}]` 并把 `tags` 洗干净。客户端还要能自己解析（旧宿主没有 `badges`），否则重启前看不到徽章。
27. **`/health` 503 ≠ 端口被占。** 桥活着但**登录凭据读不出来**（WorkBuddy 登录过期，最常见的真实故障）时，`/health` 会回 503，body 里带 `{ok:false, error, authFile}`。早期实现把它归类成 `foreign`（"端口上是别人的服务"），后果有两个：用户去找不存在的端口冲突；`ensure()` 拒绝复用又去拉新的（撞端口）。现在 `probe()` 按 body 形状认领成 **`degraded`**，`ensure()` **复用**它并把原因带上去，面板顶部显示「桥凭据异常」+ 桥给的原因 + 「重新登录 WorkBuddy」的修法（场景 4 有断言）。preflight 脚本用同一套判定。
28. **分发形态：`vendor/`。** `dsh-plugin/` 是自带一切的包 —— `npm run vendor` 把 `bridge/ dashboard/ config.mjs lib/ LICENSE NOTICE .env.example` 复制成 `<插件>/vendor/`（15 个文件，~347 KB），`config.mjs` 以自身位置为根，所以 `.env`/`.state.json`/日志全落在 vendor 里，一个文件夹就能跑。`detectProjectRoot` 的顺序是 **仓库检出 → vendor → node_modules → …**（有单测守着"仓库优先"，免得本机开发被快照盖住）。`scripts/vendor.mjs` 同时负责**清理**运行期数据（账本/日志/状态/备份/.env 绝不进分发包 —— 那属于使用者本人的数据）。

---

## 5. 文件地图

```
dsh-plugin/
  package.json          dsh.bundle.patch + dsh.client{platform:web}；exports ./、./client
  cordis.patch.yml      只做一件事：- insert: - id: workbuddy, name: dsh-plugin-workbuddy
  lib/
    index.js            插件入口：DEFAULTS/resolveConfig、projectRoot/.env 探测、
                        BridgeSupervisor+ConsoleSupervisor+adapter 装配、llm 注册与
                        撞名退避、tools/commands/routes 挂载、旧路由迁移、后台拉起桥与控制台、
                        snapshot()（status 的全部字段）、clientGraphSummary（诊断用）
    adapter.mjs         WorkBuddyAdapter：wire 转换（developer→system、图片→data URL、
                        tools/toolHistory 合并、max_tokens）、StreamTranslator（SSE→StreamChunk）、
                        错误分类/usage 映射/finish_reason 映射；catalog TTL 缓存
    bridge.mjs          BridgeClient（超时语义：0=不限时，流式必需）+ BridgeSupervisor
                        （probe/ensure/start/stop/readLog；stop 只停 /health 自报的 pid）
    console.mjs         ConsoleSupervisor：标题识别（CONSOLE_TITLE）、probe 带 20s 缓存、
                        ensure/start/stop；spawn 环境注入 DASHBOARD_AUTO_START_BRIDGE=0
    consoleApi.mjs      CONSOLE_API_ALLOWLIST + createConsoleApiHandler（前缀透传、
                        面板头校验、SSE 逐块转发、503/502 可行动提示）
    models.mjs          桥目录 → 归一化模型（toDirectory/toAdapterModels/pickDefaultModel）
    tools.mjs           5 个工具（统一 textTool 形态：execute 返回字符串 + render 成文本块）
    routes.mjs          /workbuddy/* 路由表（9 条 exact + 1 条 prefix）+ mountRoutes；
                        usage/log 支持 DELETE（清账本走桥、清日志截断 bridge.log）
    legacy.mjs          旧路由文本手术：locate/stripProviderBlock（缩进级删除、
                        providers 清空时写 providers: {}）、cleanFile（先备份）、
                        detectLegacyRoutes/cleanLegacyRoutes
    client.js           客户端半边（~980 行）：样式（box-sizing 三件套防溢出）、
                        useJson/useConsoleApi（503/404 分流）、ConsoleGate、
                        9 个面板 + LineChart + CSV 导出、注册三件套
  tests/
    adapter.test.mjs    打桩上游 9 项：目录/文本流/工具调用/wire/推理流/错误/空回复/取消/过滤
    plugin.test.mjs     旧路由手术、装配、DUPLICATE_ADAPTER 兜底、models 归一化、
                        面板头、.env 优先级、ConsoleSupervisor、快照与 console 路由
    consoleApi.test.mjs 白名单/方法/面板头/透传忠实性/503/502
    panel-render.mjs    无头浏览器渲染验证（下述"验证体系"）
  README.md             插件文档（用户向 + 实现要点 + 验证记录）

项目其它改动：
  README.md             "作为 dsh 插件使用"一节（现行形态描述）
  package.json          scripts += test:plugin / panel:shot
  .gitignore            += .tmp-*
  tools/dev/ui-harness.mjs  openPage 增加 injectStub:false 选项（iframe 场景需要）
  docs/plugin-panel*.png    渲染验证截图（概览/用量/诊断/对话测试）
```

**设置页数据面**（都挂在 dsh 自己的 Web 源 19387 上）：
`GET /workbuddy/status|models|usage|requests|log|checkin|console|migrate`、
`POST /workbuddy/bridge|console|migrate`、`DELETE /workbuddy/usage|log`、
`*  /workbuddy/console-api/<白名单>`。

**status 快照字段**（消费方参考）：`bridge{state,health,error}`、`console{state,url,error,managed,autoStart}`、`config{provider,bridgeUrl,consoleUrl,projectRoot,…}`、`route{registered,provider,error,fallback}`、`directory[]`、`legacy{found,files,cleaned}`、`quota`、`checkin`、`dsh`、`client{available,composed,ids}`、`sampleModel`、`runtime`。

---

## 6. 验证体系

```sh
# 1) 纯逻辑 27 项（打桩上游，不碰真实额度）
npm run test:plugin          # = node --test "dsh-plugin/tests/*.test.mjs"
# 预期：tests 27 / pass 27 / fail 0

# 2) 设置页渲染验证（无头 Chrome/Edge + 真实数据）
npm run panel:shot           # = node dsh-plugin/tests/panel-render.mjs
node dsh-plugin/tests/panel-render.mjs --offline   # 只用内置样例
# 预期：场景 1（9 标签页逐个点开、内容断言、逐页横向溢出检查、图表/表格/交互、无页面错误）
#       场景 2（宿主旧构建 404：控制台域面板给出"重启一次 dsh"，桥域功能不受影响）
# 产物：docs/plugin-panel.png / -usage.png / -diagnose.png / -chat.png
```

渲染验证的环境细节：`tools/dev/ui-harness.mjs` 找 Chrome/Edge；React UMD 首次运行下载到 `.tmp-research/vendor/`（删了会重下）；打桩装在**外壳页面里**（`harnessHtml(routes)`）而不是 CDP——`openPage(..., { injectStub: false })`，因为 CDP 注入会连子框架一起打桩。端口：8795 静态壳、8796 场景 1、8797 场景 2；CDP 9333/9334。

已做过的一次性真实验证（结论可复用）：`provider: workbuddy` + `model: deepseek-v4.1-flash` 跑通真实 agent 轮次（返回"桥已接通。"）；禁用 bundle 后路由 404、工具消失、桥仍在跑。

渲染验证里几条**专项回归断言**（都是被用户实际踩到的问题，别删）：

| 断言 | 防的是什么 |
|---|---|
| 每个标签页的横向溢出检查 | 输入框/表格把内容顶出卡片（`box-sizing` / 表格布局 / 长路径） |
| **场景 3（620px 窄列）**：逐表检查单元格盒子互不重叠、内容不宽于格子、格子不被压到 34px 以下、视口无横向溢出；账号页额外要求卡片内无元素溢出 | 窄列下表格被均分挤压、文字逐字折断、nowrap 胶囊压住邻居（用户截图里就是这个症状） |
| 请求页桩**首帧 404** → 必须自行恢复出数据行 | 刷新页面撞上"宿主还没挂路由"窗口，红字 404 挂一分钟 |
| 诊断页不许出现 `尚未配置 workbuddy 路由` / `勾选后保存` | 控制台诊断库的迁移前口径误报 |
| 对话测试模型下拉 ≥5 选项、改值生效、**切标签页回来仍保持** | "模型像是写死的"/下拉不可选 |
| 对话输入框宽度 ≤ 卡片宽度 | 文本框溢出 |
| 对话跑一轮（SSE 桩）：回答渲染 + 逐轮元数据 + 真的 POST 到 `/chat` | 流式解析、元数据丢失、面板没接上代理 |
| 破坏性操作：点"取消"不发请求、点"确定"才发 DELETE | 清空类操作缺二次确认/点了没反应 |
| 概览出现「今日还没签到」「最近请求里有 N 条失败」且按钮可跳页 | 待办提醒（控制台顶部提示条的对齐项） |
| 场景 2（console-api 全 404）：控制台域面板给"重启一次 dsh"、桥域功能照常、体检按钮禁用 | 版本错配时的空白与空点 |
| 场景 3（620px 窄列）：见上一条表格布局 | 窄列挤压 |
| 场景 4（`bridge.state='degraded'`）：顶部必须写「桥凭据异常」、带上桥给的原因、给出"重新登录 WorkBuddy"；**不许**出现「桥未运行」或"别人的服务" | `/health` 503 被误诊成端口冲突（真实世界最常见的故障） |

单测里的两条新增防线：
- **方法/权限矩阵**：只读路由非 GET/HEAD 一律 405；写路由（bridge/console/migrate/usage DELETE/log DELETE/checkin claim）缺 `x-workbuddy-panel: 1` 一律 403（含"值写成 true 也不行"）。
- **readLog 尾部读取**：大文件只读尾部、截断的半行被丢弃、文件不存在给空结果。

另有一份**对运行实例**的只读矩阵探测脚本（会话中临时使用后已删，需要时按 `tests/plugin.test.mjs` 里的矩阵测试重写）：实际结果显示 14 项全部符合预期。

---

## 7. 本会话对真实系统的改动清单（透明起见）

| 位置 | 改动 | 备注 |
|---|---|---|
| `C:\Users\demo\.dsh\profiles\desktop\package.json` | 依赖 + `dsh.profile.bundles` 各加一项 `dsh-plugin-workbuddy`（link: 源码目录） | 插件管理器自动写入 |
| `C:\Users\demo\.dsh\settings.yaml` | 删除 `llm-pi-ai.providers.workbuddy` 段，现为 `providers: {}` | 备份：`settings.yaml.bak-20261004051152` |
| `C:\Users\demo\.dsh\profiles\desktop\cordis.patch.yml` | 同上（patch 层里的同一段） | 备份：`cordis.patch.yml.bak-20261004051042` |
| dsh 进程 | 无持久改动；期间重启过一次（13:43），宿主端构建自此含插件 | |
| 额度 | 用插件路由跑过少量真实请求（e2e 一轮 + 日常使用） | 用户自己的账号 |
| 运行中的进程 | 桥 pid 31840、控制台 8792 均为**复用**（非插件拉起） | 插件因此不会去停它们 |

**回退方式**：还原上面两个备份文件 → 设置 → 插件里停用/卸载 `dsh-plugin-workbuddy`。注意还原后若同时保留插件，两条同名路由会撞名（插件会退到 `workbuddy-native` 兜底并在面板标明）。

---

## 8. 已知限制与未决事项

- **生效时机**：宿主端改动必须完全重启 dsh；客户端半边改动刷新页面即可（未重启时设置页自己会提示"宿主旧构建"）。
- **跨界面同步有轮询延迟**：状态 8s、请求 5s、账号 30s、体检 30s、用量 60s。数据是同一份，只是显示最多滞后一个周期。
- 适配器目录缓存 60s；控制台探测缓存 20s；status 的积分缓存 120s。
- 对话测试的"本轮扣分"依赖上游 usage 里的 `credit` 字段，上游不回就显示 `—`。
- 控制台诊断库的旧口径只在**设置页**做了改判显示；控制台网页本身仍会显示那条误报（没改控制台代码是设计约束）。若要根治，需要给 `lib/diagnostics.mjs` 增加"原生路由已注册"的识别——这是唯一值得做的后续项。
- `.tmp-models.json` / `.tmp-usage.json` 在本会话开始前就存在，未动。
- 测试注意：`空回复`用例在多文件并行 + CPU 抢占下可能因对端提前关闭变成 `TRANSPORT`（适配器行为正确），用例里已允许重试一次；若再见到请先单跑该文件确认。

---

## 9. 常用操作速查

```sh
# 测试与截图
npm run test:plugin
npm run panel:shot

# 重新安装/更新插件（改完 package.json 结构类的东西后）
#   用 dsh 会话里的 plugin_manager: install_bundle target=E:\workbuddy-to-dsh\dsh-plugin
#   或 CLI: dsh plugin --profile desktop add E:\workbuddy-to-dsh\dsh-plugin

# 手动起停（插件不在时的等价物）
node bridge/workbuddy-bridge.mjs          # 桥
node dashboard/server.mjs                 # 控制台
node tools/doctor.mjs                     # 环境自检

# 看运行状态（在 dsh 网页源上）
#   http://127.0.0.1:19387/workbuddy/status
#   http://127.0.0.1:8790/health   （需 Authorization: Bearer wb-local-bridge）
```

配置覆盖示例（profile 的 `cordis.patch.yml`，按 id `workbuddy` 覆盖）：

```yaml
- id: workbuddy
  config:
    bridgePort: 8790
    consoleAutoStart: true
    modelDeny: [某模型id]
    migrateLegacy: true
```

---

## 10. 环境备忘

- Node：`E:\nodejs\node.exe`（v24.8.0）。dsh CLI：`E:\harness\resources\runtime\cli\bin\dsh.cmd`（ELECTRON_RUN_AS_NODE 包装）。
- dsh 版本 0.2.0-rc.2；profile `desktop`；`DSH_HOME=C:\Users\demo\.dsh`。
- **读 app.asar**（`E:\harness\resources\app.asar`，dsh 在 `/dsh/...` 前缀下）：会话里用的临时脚本已清理，需要时用下面这段（保存为 `.tmp-asar.mjs`，已 gitignore）：

```js
// 用法：node .tmp-asar.mjs list <asar> <regex> [out]
//       node .tmp-asar.mjs extract <asar> /dsh/node_modules/<pkg>/lib/x.js [dest]
import { openSync, readSync, closeSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
const [mode, asar, a, b] = process.argv.slice(2);
const fd = openSync(asar, 'r');
const sb = Buffer.alloc(8); readSync(fd, sb, 0, 8, 0);
const hSize = sb.readUInt32LE(4);
const hb = Buffer.alloc(hSize); readSync(fd, hb, 0, hSize, 8);
const header = JSON.parse(hb.subarray(8, 8 + hb.readUInt32LE(4)).toString('utf8'));
const base = 8 + hSize;
const files = [];
(function walk(n, p) { for (const [k, e] of Object.entries(n.files || {})) {
  const f = `${p}/${k}`; if (e.files) walk(e, f);
  else files.push({ path: f, size: e.size, offset: base + Number(e.offset) }); } })(header, '');
if (mode === 'list') {
  const hits = files.filter((f) => new RegExp(a, 'i').test(f.path));
  console.log(hits.map((f) => `${f.size}\t${f.path}`).join('\n'));
} else {
  const n = files.find((f) => f.path === a); if (!n) process.exit(2);
  const buf = Buffer.alloc(n.size); readSync(fd, buf, 0, n.size, n.offset);
  if (b) { mkdirSync(dirname(b), { recursive: true }); writeFileSync(b, buf); } else process.stdout.write(buf);
}
closeSync(fd);
```

- **权威资料在 asar 里**：每个 `@deepseek-ai/dsh-*` 包都有完整 `README.md`；查契约优先读它，其次是 `lib/*.js`（未混淆）。本会话最常用：`dsh-llm`、`dsh-llm-pi-ai`、`dsh-client-modules`、`dsh-client-ui-slots`、`dsh-client-ui-settings-models`（settings.section 注册的范本）。
- 活体探针：`cordis_inspect_query`（host/client 的 Service、Event、Config、Tool、Slots、Builtin）——客户端槽台账能直接看到 `settings.section` 的 occupants（确认注册是否生效的最快路径）。

---

## 11. 沟通与协作偏好（从本会话观察）

- 用户用中文沟通；回复要直给结论 + 证据，不喜欢绕。
- 用户会实际点界面验收：UI 问题（溢出、爆红、控件出格）要当 bug 修，且最好配上"为什么会出现"的解释。
- 改动真实系统（dsh home 文件、装插件）要如实报告改了什么、备份在哪。
- 权限：会话是 danger-full-access、审批禁用；但涉及用户真实数据文件时仍先备份再动手。
- 两个子代理研究任务失败过——直接从 asar 里的 README 与参考实现（whale-pet、ark-plan-api、核心 settings 插件）自行验证反而更快更准。
