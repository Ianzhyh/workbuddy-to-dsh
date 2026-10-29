# Changelog

本项目所有值得注意的变化都记录在这里。格式参考
[Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## 维护约定（发版四步）

1. `npm run release:check` 全绿（vendor 同步 + lib 单测 + 插件测试 + 独立分发演练）；
   改了界面还要 `npm run test:ui` / `npm run panel:check`（它们需要本机 Chrome，
   不塞进 CI 矩阵）；
2. 把本次变化落进本文档的 `[Unreleased]` 段 → 转成版本条目；版本号同步 5 处
   （见 `CONTRIBUTING.md` 的发版四步）；改了界面还要重出截图；
3. `git tag vX.Y.Z` 并推送，`gh release create` 带上 tgz；
4. `npm run verify:release` —— 把**已发布**的 tgz 下下来验一遍
   （`release:check` 验的是本地 `vendor/`，验不到 `npm pack` 到底打进去了什么）。

只支持最近 2 个 minor 版本。

## [1.19.2] - 2026-10-29

### Fixed

- **Claude Code 加 `[1m]` 后缀被静默路由到别的模型**（[#18](https://github.com/Ianzhyh/workbuddy-to-dsh/issues/18)）：
  桥的 Anthropic 层此前只有「精确命中目录」与「名字带 flash/haiku 就走小快模型」两档，
  `deepseek-v4.1-flash[1m]` 落进第二档被换成 `glm-5.3-flash`。现在先剥客户端后缀
  再匹配目录；客户端原生别名（`claude-*` / `gpt-*` / `codex-*`）照旧映射（兼容不变）。
- **目录里没有的模型名被静默换成默认模型**：Anthropic / Responses 路径默认**明确报
  404**（`not_found_error`），不再"以为在用 A、实际在用 B"；逃生门沿用
  `WORKBUDDY_SKIP_MODEL_PREFLIGHT=1`（放行给上游裁决）。目录冷启动时不再静默改写：
  未知 id 原样转发给上游，由上游裁决。
- **Claude Code 按 200K 规划上下文**（[#18](https://github.com/Ianzhyh/workbuddy-to-dsh/issues/18)）：
  它对不认识的模型 id 一律按 200K 假设窗口（不读 `/v1/models`）。「一键接入」现在写
  `env.CLAUDE_CODE_MAX_CONTEXT_TOKENS`（= 模型上限），dsh 面板里按模型设的上下文窗口
  也会落到这一行（按模型上限收敛）。
- **工具失败被当成成功**：`tool_result.is_error` 现在透传给模型（原先工具报错被
  当成功结果，模型会以为文件已经改好）。
- **MCP / 服务端工具块静默消失**：`mcp_tool_use`、`web_search_tool_result` 这类块
  降级成带标签的文本，不再让模型凭空失忆。
- **`thinking` 开关被整段丢弃**：Claude Code 的扩展思考现在按 `budget_tokens` 折算成
  上游 `reasoning_effort`（只对实测过档位的模型生效）。
- **`max_tokens` 不按模型上限收敛**：超上限时收敛到该模型的输出上限。
- **「验证接入」对 Claude Code 只验 OpenAI 路径**：现在额外验一次 Anthropic 路径
  （`/v1/messages/count_tokens`，本地估算、不打上游、不耗额度）。

### Changed

- Claude Code 接入额外写 `env.ANTHROPIC_DEFAULT_HAIKU_MODEL`（后台任务模型），
  手动接入片段补 `ANTHROPIC_MODEL` 与 `CLAUDE_CODE_MAX_CONTEXT_TOKENS`。

## [1.19.1] - 2026-10-29

### Added

- **Web 控制台也支持限流自动切号**（[#17](https://github.com/Ianzhyh/workbuddy-to-dsh/issues/17)）：
  在 `.env` 设 `WORKBUDDY_ACCOUNT_FAILOVER_AFTER=N`（默认 `0` = 关），控制台会按
  「账号」页顺序切到下一个可用桌面账号（写 `.state.json` 并重启桥）。只处理桌面来源，
  会切换钱包、默认关闭；dsh 插件用户继续用插件配置 `accountFailoverAfter`，两边不要同时开。
  「切换账号」路由与自动切号共用同一条 `switchDesktopAccount()` 实现，避免两套规则漂移。

## [1.19.0] - 2026-10-28

### Added

- **限流自动切号（opt-in，默认关闭）**（[#17](https://github.com/Ianzhyh/workbuddy-to-dsh/issues/17)）：
  桥的 `/health.rateLimit` 按「账号 + 模型」统计最近 10 分钟最终返回给客户端的 429；
  插件配置 `accountFailoverAfter: N`（默认 `0`）后，同一模型达到 N 次会经控制台切到
  下一个本机可用账号（控制台按需拉起、切换后照常闲置退出）。会切换钱包，只在本机
  自有账号间切换，不导出凭据、不做公网中转；默认关闭，可能触发上游风控，请自行评估。

### Changed

- **非 Windows 插件登录凭据持久化**（[#16](https://github.com/Ianzhyh/workbuddy-to-dsh/issues/16)）：
  存储默认从 `memory` 改为 `file`（Windows 仍是 `dpapi`）。file 模式用 32 字节文件密钥 +
  AES-256-GCM 落盘，桥重启、更新插件不再需要重新登录。密钥优先取
  `WORKBUDDY_CREDENTIAL_KEY`（推荐 Docker/NAS：64 位 hex / base64 / 口令经 scrypt，
  不落盘）；未设置时自动生成 0600 的 `store.key`。密钥不可用时仍自动退回仅内存，
  面板显示「文件加密 / 仅内存」与密钥来源。容器部署请把 `WORKBUDDY_CREDENTIAL_DIR`
  挂到持久卷。

## [1.18.0] - 2026-10-28

### Changed

- **控制台改为按需启动 + 闲置自动退出**（[#14](https://github.com/Ianzhyh/workbuddy-to-dsh/issues/14)）：
  控制台常驻约 80MB，而多数时间没人看数据。插件默认 `consoleAutoStart: false`
  （不随 dsh 启动）：面板第一次取数时由 `console-api` 透传前 `ensure` 透明拉起，
  `workbuddy console` / 工具入口也照旧；使用完闲置 `consoleIdleExitMs`（默认
  `600000`，`0` = 常驻）后自动退出。计活动只看页面/数据请求，插件每 20 秒的探活
  （`/`、`/api/version`）不算，页面打开时每 2 秒的 `/api/identity` 轮询会保活。
  手动 `node dashboard/server.mjs` 不设 `DASHBOARD_IDLE_EXIT_MS` 就保持常驻。
  面板状态从「未运行（黄）」改为「按需启动（中性）」。`ConsoleSupervisor.stop()`
  同步加固：先确认端口上仍是自己拉起的那个实例再 kill，避免闲置退出后 PID 被
  系统回收导致误杀。
- **GitHub / npm 直装包不再重复携带 `dsh-plugin/vendor/`**：根包形态下
  `projectRoot` 永远解析到安装根（那里已有 `bridge/`、`dashboard/`、`lib/`），
  vendor 是 1.7MB 的逐字节副本、永远轮不到。子包 tgz（单文件夹分发）仍保留
  vendor；`verify-github-install` 增加「根包不含 vendor、子包仍有 vendor」断言。

### Fixed

- **控制台卡片不再每次轮询都重播入场动画**：`renderCards()` 每 20 秒重设
  `innerHTML`，整屏卡片会跟着重新浮现；现在首屏播一次后加 `settled` 落回静止态
  （`test-card-motion` 回归）。
- **登录来源面板重复渲染导致下拉偶发点不开**：`/api/login` 首屏可能加载两次，
  数据相同也会重设 `innerHTML`，把刚打开的下拉换掉。现在按渲染指纹跳过重复重绘
  （`test-dropdowns` 第 0 个下拉回归）。
- **英文模式残留「桌面端凭据 / 桌面端」两处中文**：账号卡与令牌卡副行是拼接串，
  补规则拆开翻译；同时补齐「桌面文件未生效」的英文。
- **390px 窄屏「客户端一键拉取给 ___」横向溢出 50px**：允许该行收缩并换行，
  `test-i18n` 的 390px 视口断言恢复全绿。
- **macOS 探测不到 WorkBuddy 可执行文件**（[#13](https://github.com/Ianzhyh/workbuddy-to-dsh/issues/13)）：
  腾讯 WorkBuddy 5.8.x 是未改名的 Electron 壳，`Contents/MacOS/` 下的可执行文件叫
  `Electron` 而不是 `WorkBuddy`，写死产品名的候选全部落空 → `key fetch failed`，
  控制台账号页显示不可用（模型调用走其它凭据，所以不易察觉）。现在按
  `Info.plist` 的 `CFBundleExecutable` 生成候选并兜底 `Electron`、覆盖
  `~/Applications`，并扫描两个应用目录里名字含 `workbuddy` / `codebuddy` 的任意
  `.app`（改过包名也能找到）；`WORKBUDDY_APP_EXECUTABLE` 也补进插件→桥的环境
  透传白名单。回归用例：`darwin 下按 Info.plist 的 CFBundleExecutable 列出可执行文件`、
  `darwin 下二进制/缺失 plist 时仍有 Electron 兜底`、`任意 WorkBuddy*.app 目录名`。
- **发版门禁不再被测试端口撞车挂死**：`release-check` 的 `cross-platform (ubuntu-latest)`
  在 v1.17.0 上跑了 20 分钟后被 cancel，唯一失败的用例报
  `listen EADDRINUSE: address already in use 127.0.0.1:39846`。两个独立问题叠在一起：

  1. **端口区间横跨临时端口段**。测试给桥指定端口时用的是
     `20000 + Math.floor(Math.random() * 20000)`，而打桩上游一律 `listen(0)`
     （内核分配，Linux 默认落在 32768–60999）—— 随机挑的固定端口迟早等于
     内核刚分给另一个 stub 的端口。现在统一走 `tools/dev/bridge-ports.mjs`
     取 **12000–19999**，严格低于三大平台的临时端口下界，并避开默认的 8790/8792。
  2. **一次失败被放大成 20 分钟**。`startBridge()` 抛错时用例的 `finally`
     根本没轮到执行，打桩上游的 listen socket 留在测试进程上，
     `node --test` 跑完全部用例后**不退出**，CI 只能按 `timeout-minutes` 取消 job。
     现在 `startBridge()` 撞端口会换端口重试（最多 5 次，非端口错误不重试），
     并且各测试文件都补了文件级 `test.after` 兜底关掉泄漏的 stub / 子进程。
     顺带修掉 `bridge-anthropic.test.mjs` 的 `19100 + pid % 300`：同一台机器上
     并行跑两份测试时，两个 pid 相差 300 的倍数就会算出同一个端口。

  回归用例（撤掉修复即红）：`起桥的测试必须用 bridge-ports.mjs 取端口`、
  `起桥的测试必须有 test.after 收尾`、`测试端口段必须整体低于临时端口下界`。

## [1.17.0] - 2026-10-27

### Added

- **多账号签到面板**：桥端新增 `GET /v1/checkin/accounts`（只读枚举本机登录态）与
  `POST /v1/checkin/all`（逐个账号领取）。只读登录文件、令牌只在内存中解出、
  不参与模型路由；返回行只含 uid / 昵称 / 区域 / 过期时间 / 状态，不回传令牌。
  单账号失败不影响其它账号；没有签到活动按“跳过”归档，不再把国际版账号报成失败。
- **插件面板多账号签到**：签到页可查看本机各登录账号的状态并逐账号领取；
  领取入口要求面板令牌，避免同机客户端 key 被拿去枚举账号或批量操作。
- **用量页图表增强**：新增 Token 构成环图、每日成功/失败柱状图、模型占比环图；
  趋势图增加合计 / 峰值 / 日均 / 活跃节点摘要、双序列对比与主题内悬停明细。
- **模型页重构**：选择与保存提升为主操作；模型卡按宽窄容器自适应；详情拆成
  「常用参数」「能力与来源」等独立模块；支持按当前筛选结果批量选择、排序与空态。

### Changed

- **用量页信息分层**：统计范围与操作、六项 KPI、趋势、按模型、搜索与生成、
  最近失败分段展示；统计口径与账实核对折叠到次级区域。
- **用量时间轴补齐空日期**：桥只返回有请求的日期；前端按 24 小时 / 7 天 / 30 天
  补齐空桶，切换范围后时间轴与活跃节点变化可见。
- **诊断页模块化**：插件版本、汇总结论、逐项诊断与建议区改为统一卡片模块；
  版本检查改为主题内按钮，不再使用默认下划线链接。

### Fixed

- **统计范围切换不再被在途请求吞掉**：快速切换 24 小时 / 7 天 / 30 天时，
  `useJson` 在旧请求未结束前会把新范围请求直接丢掉，导致选中态变了但数据等到
  下一次轮询才变。现在新重载会排队，旧请求结束后立即补发。
- **reasoning 不再无限期扣到正文帧才发**（客户端 TTFT/TPS 失真）：SSE 归一为修
  Cherry Studio issue #9 把逐字符 `reasoning_content` 攒进 `reasoningBuf`，原先只在
  正文/工具/终止帧到来时一次性 flush —— 于是「首个非空 delta」的时间等于**整段思考
  时长**。任何按首 token 计时的客户端都会被算坏：实测 dsh `sessionStats` 把一轮
  15.8 秒思考记成 `ttftMs=15755`、`decodeMs=1701`，2045 个输出 token 因此显示成
  **1202 tok/s**（真实端到端约 130）。现在攒满 **64 字符**就先发一帧：Cherry 拿到
  的是较大块（原问题仍修复），首帧最多晚约 0.4 秒，TTFT 回到真实量级；正文/工具/
  终止帧前的强制 flush 与顺序不变，短于阈值的思考仍合并成一帧。回归用例：
  `桥：逐字符 reasoning 分片下发（不能攒到正文帧才发，否则客户端 TTFT 失真）`
  （撤掉阈值即红）。

- **UI 测试夹具跟上接口形状**：`tools/dev/fixtures.mjs` 补齐 `/api/overview`、
  `/api/models`、`/api/diagnose`、`/api/usage`、`/api/accounts` 一直缺的字段
  （`bridge.auth` / `build` / `staleBuild`、`dsh.routeMode` / `nativeRoute` /
  `nativePlugin`、`quota.history`、`usage.failureByModel`、`accounts.pin` 等）。
  这些缺失会让 `openPage` 的形状校验直接抛错，**整批 UI 用例根本跑不到断言**。
  `ui-harness` 同时为 `/api/models` 与 `/api/usage` 补上与用例无关的附加字段，
  免得每个用例都要记得带上它们。

## [1.16.0] - 2026-10-26

### Added

- **默认视图可选规模 / 具体模型**（2026-10-26 反馈「为什么只出现三个」）：
  客户端的「获取模型列表 / 一键同步」按钮打的是**不带参数**的 `GET /v1/models`，
  原先那里固定只回 3 个精选，于是用户以为桥只认三个模型（完整目录在 `?all=1`）。
  现在默认视图可控：
  - 面板「可用模型」新增一行「客户端一键拉取给」，可选**精选 / 全部 / 表格里勾选的**；
    勾选模型时下拉自动跟随并提示「点保存才生效」，保存后**立即生效**（无需重启桥）。
  - 新增 `GET|POST /v1/models/default`（桥）与 `/api/models/default`（控制台）；
    支持 `{ value: 'curated' | 'all' | N }`、`{ ids: [...] }`（点名具体模型）与
    `{ value: null }`（清除偏好）。
  - 新增 `WORKBUDDY_MODELS_DEFAULT`（`curated` / `all` / 正整数）作为部署级默认；
    面板保存的值优先，请求级 `GET /v1/models?limit=N` 再覆盖两者。
    校验规则同步进 `lib/config-schema.mjs`（正整数不算写错）。
  - `ids` 与当前目录**求交集**：已下架的 id 不下发；顺序按用户提交顺序，
    即客户端列表里的显示顺序。`/health.models` 与 `/v1/models` 走同一函数，
    面板说的数量和客户端真拿到的一致。
- **失败归因**：账本失败记录统一带 `failureKind` / `retryable` / `failureAction`
  （channel / account / auth / rate_limit / quota / tool_history / stream /
  upstream / request / unknown）；请求页显示归因标签，概览对账号/通道/额度类失败
  直接给“先看请求页、不要连续重试”的风险提示；CSV/OpenAPI 同步。
- **账实核对与失败统计**：`/v1/quota` 返回最近 30 天余额快照（按
  `WORKBUDDY_QUOTA_SNAPSHOT_MS` 节流），用量页用首尾快照对比本地账本并显示
  「账实差额」（差额注明可能是客户端内使用/其他工具/估算）；`total.failureKinds`
  与按模型/按天的 `failed` 进入用量 API 和 CSV。
- **诊断包与安装指纹**：`node tools/doctor.mjs --bundle` 输出可分享 JSON
  （版本/路径/PID/端口/构建/vendor 指纹/账号前 8 位/最近失败），家目录替换为
  `~`，不含令牌或对话内容；插件「诊断」页新增「复制诊断包」。插件侧同时上报
  自身版本，便于区分宿主/插件/桥三代版本。
- **OpenAI Images 兼容端点**：新增 `POST /v1/images/generations`（JSON），
  支持 `url` / `b64_json`、同步等待与 202 + job id 降级；`n` 只允许 1，
  `stream` 明确拒绝；复用现有图片提交/查询与本地令牌闸门。
- **媒体幂等与任务持久化**：带 `Idempotency-Key` 的同账号重复提交在
  `WORKBUDDY_MEDIA_IDEMPOTENCY_MS` 窗口内只提交一次（并发重复共享同一个
  pending 提交，命中回 `X-WorkBuddy-Idempotent-Replay: 1`）；任务元数据/同步
  结果落盘到 `media-tasks.json`，桥重启后仍能查询，`WORKBUDDY_MEDIA_STORE=0`
  可关闭。自定义图片/视频与 OpenAI Images 端点共用。

- **插件操作安全与来源标注**：插件里的停桥/重启/切号都加二次确认（会中断在途
  请求）；模型页显示「目录来源：上游目录/旧缓存 + 更新时间」，模型详情显示促销
  数据来自 `modelPromotions`，并说明浏览器登录会用桌面身份补抓促销。
- **协议兼容补强**：`/v1/models` 增加 `context_length` / `max_input_tokens` /
  `max_tokens` / `capabilities` / `architecture.input_modalities` 别名；Responses
  带 `previous_response_id` 时明确回 400 `previous_response_not_found`，不再静默
  丢上下文。
- **安全与运维文档**：新增 `.github/SECURITY.md`、Bug/Feature issue 表单、PR 模板、
  [`docs/COMPATIBILITY.md`](docs/COMPATIBILITY.md) 与 [`docs/SUNSET.md`](docs/SUNSET.md)；
  明确平台/客户端分档、上游失效处置、数据位置与不支持范围。
- **社区入口**：启用 GitHub Discussions（Q&A / Ideas / Show and tell / Announcements
  / Polls），欢迎帖说明提问模板、脱敏诊断包与安全边界；issue 模板页把使用求助
  引导到 Discussions，issue 区保留给可复现缺陷。
- **配置取值校验与备份恢复**：诊断页新增「配置取值」——用与 `numEnv()` 相同的
  判据检查数值 / 枚举 / 开关项，格式错误（如端口 `879O`、搜索条数 `50`）会明确
  指出「值不会被采用、实际按什么运行」，不再静默回退。新增
  `tools/backup.mjs`：备份 state / usage / quota-history / media-tasks / token /
  credentials，`manifest.json` 带 SHA-256；恢复前逐文件校验并先把当前数据目录
  复制到 `.pre-restore-<时间>`。插件概览与诊断页显示「插件版本 vX.Y.Z · 检查更新」
  （只链接到 Release 页，不联网检查、不自动升级）。

## [1.15.0] - 2026-10-26

### Added

- **缓存命中可见 + 稳定会话 ID**：桥会优先用客户端给的 `X-Conversation-ID` /
  body `conversation_id`，缺省时按「首条 system + 首条 user + 模型」算稳定指纹，
  header 与 body 双写（`WORKBUDDY_CONVERSATION_ID_BODY=0` 可关；上游把该字段当
  未知字段拒绝时自动去掉并关闭本进程注入）。`/v1/requests` 与 `/v1/usage` 增加
  `cachedTokens` / `cacheMissTokens` / `cacheHitRate`，插件与控制台显示命中率
  （上游回报口径，缺报显示「—」）。
- **运行期数据外置**：state / usage / 本地令牌迁到 `%USERPROFILE%\.workbuddy-bridge\`
  （`WORKBUDDY_DATA_DIR` 可覆盖），旧安装目录的文件首次启动复制迁移，换 tgz /
  重装不再丢账号钉住、用量与令牌。插件与桥读同一份；旧令牌路径只读兜底。
- **CI 门禁**：主门禁增加 `check:pack`、`panel:render`、Windows 中文/空格路径
  独立演练；新增 `docker-build` job。Docker healthcheck 要求显式
  `WORKBUDDY_LOCAL_TOKEN`，数据落 `/data` 卷。

### Fixed

- **11128 清洗范围不够**（同类项目实证）：system 首句之外的 `DeepSeek Harness`
  品牌行、assistant 历史里的身份句也会让整条会话持续 400。现在 system 做全文
  品牌词中和，assistant 做两句精确身份模板中和；新增 `remove-brand-lines-assistant`
  兜底级；全部降级失败回 `CHANNEL_REJECTED`，明确提示不要原样重试。
- **工具调用历史一处坏、整会话 503**：新增 `repairToolHistory`——重复/空
  `tool_call_id` 改名并同步 result，缺 result 合成 `is_error` 结果，孤儿 result
  丢弃，只有 reasoning 的空 assistant 剔除；账本记 `toolRepair`，合法历史不改写。
- **非视觉模型收到图片直接 400**：目录明确 `images=false` 时把图片块降级成
  `[image omitted: ...]` 文本并记 `imageOmitted`，不再让历史里的一张图毒死整条会话。
- **Responses 的 reasoning summary 事件发给所有客户端**：即使打开
  `WORKBUDDY_FORWARD_REASONING=1`，也只对 Codex UA、显式请求 reasoning 或带
  `x-workbuddy-forward-reasoning: 1` 的请求转发；Cherry Studio 等严格解析器
  不会再被未知事件 abort。
- **chat 流式帧不合法/思考逐字符**：上游的 SSE 先按 block 归一——缺失
  `choices[0].delta` 时补 `{}`（Cline #939），剔掉空 `tool_calls: []` /
  空 `content` / `null` 占位（Cherry issue #9：空数组也会被当成 reasoning 段
  结束），逐字符的 `reasoning_content` 聚合成一段。正文/工具顺序与 `[DONE]`
  保持；设置 `WORKBUDDY_SSE_NORMALIZE=0` 可退回原始字节透传。
- **浏览器登录看不到夜间免费/促销**（issue #10）：插件来源的 `/v3/config`
  能拿到更全模型但不返回 `modelPromotions`，而桌面身份才返回。现在插件来源会
  **额外用桌面身份抓一份 `/v3/config`，只合并促销规则**，模型清单仍用插件
  身份那份（不丢 v2 独有模型）。诊断字段：`upstreamShape.sources['/v3/config#desktopPromotions']`。
- **自动签到双真源**：插件没显式配 `autoCheckin` 时跟随 `.state.json` 的
  `checkin.auto`；面板显示桥的实际开关，并提示“已保存、重启桥后生效”；签到缓存
  按自然日失效，跨午夜不再误报“今日已签到”。
- **未知模型状态码**：本地预校验从 400 改为 **404** `model_not_found`
  （OpenAI/Anthropic 客户端据此切模型），账本同步记录。

### Changed

- 面板请求明细的输入列附带缓存命中百分比；用量页新增「缓存命中率」卡片；
  请求/用量 CSV 增加缓存列。
- Docker 文档要求显式本地令牌并挂载 `/data`；healthcheck 不再用空 Bearer 假健康。

### Fixed（媒体生成）

- **上游同步完成（`mode:"sync"`）的图片/视频被当成异步任务**（真机复现）：
  2026-10-26 两次图生图提交都在 submit 里同步返回 `failed`，桥却回 `202`、
  工具照着模板说「已提交，稍后查询」，把真实失败原因丢掉；再去查只会得到
  `INVALID_TASK_ID_FOR_SYNC_MODE` 的伪失败，看起来像任务坏了。现在：
  - 同步终态返回 **HTTP 200 + `sync: true`**，`completed` 直接交付产物，
    `failed` / `cancelled` 直接给真实原因，不再劝用户按 id 重查；
  - 同步结果（含 `resultFiles` / `errorMessage`）进 6 小时提交缓存，
    `GET /v1/{videos,images}/{id}` 与 `/content` 优先命中，桥重启/过期后才落到上游；
  - 缓存失效时查询返回 `sync_result_unavailable: true` + 人话，明确「这不是普通生成失败」。
- **本地参数错误也要先等一次余额请求**：`quotaBalance` 原先在 `submit()` 之前执行，
  未知字段/坏路径这类纯本地 400 会先等最长 5 秒的余额接口。改为构建通过、
  真要发上游时才读余额（`onBeforeRequest`），同步失败也不再读 after。
- **多产物落盘互相覆盖**：同一任务同一秒的多个产物文件名完全相同，`rename` 会静默
  覆盖前一个；显式 `save_to` 文件路径时两个产物更是直接写同一个文件。现在目录模式
  按磁盘去重（`-2`/`-3`），显式文件名从第二个产物开始加序号，首个仍按用户意图覆盖。
- **同步失败的账本记成成功**：`recordRequest` 固定 `ok:true/status:202`；现在同步
  `failed`/`cancelled` 记 `ok:false`、`code=*_GENERATION_FAILED` 并带错误原因。
- **图生图回显未生效的 `quality`**：上游 edit schema 不接收 quality，工具层也丢掉了它，
  但查询响应还显示「质量：hd」。现在 edit 模式的 quality 为 `null`，不再假装生效。
- **失败原因/产物字段的兼容面**：`error.message` 是对象时不再变成 `[object Object]`；
  `result_files` 的 snake_case 变体也认；`success` / `done` / `timeout` / `expired`
  等状态有明确归一。
- **同步结果缓存未按账号隔离**：同一台机器切换账号后，新账号拿到旧账号的任务 id
  仍可能从桥内存里读到旧账号的产物 URL/失败原因。现在缓存作用域是
  `endpoint + userId`（无 userId 时回退 token 指纹），查询只命中当前账号；
  token 刷新不受影响，切号后查询会重新走上游并得到 404。
- **`mode:"sync"` 但状态非终态会被缓存成永远 in_progress**：现在只有终态
  （completed/failed/cancelled）才进同步缓存；非终态按异步任务去查上游。
- **413 请求体超限没有进账本**：此前用量页只能看到成功和参数错误；现在记
  `*_PAYLOAD_TOO_LARGE` 失败行。
- **429 的 Retry-After 被客户端丢掉**：桥客户端现在把响应头里的秒数附到错误上，
  工具会直接说“约 N 秒后重试”，不再只写“稍后”。
- **私有地址判定漏到下载器**：`save_to` 下载产物时只校验了 https，没挡住
  `https://127.0.0.1/…`、`[::1]`、内网段等本机/私有**字面量**地址；现在在 fetch 之前拒绝，
  并复核 fetch 跟随重定向后的**最终 URL**（公网签名地址 302 到 `http://127.0.0.1` 也会被拒）。
  输入 URL 也补上了末尾根点归一（`https://localhost./` 不再绕过 localhost 判定）、
  `localhost.localdomain` / `ip6-localhost` 等回环别名，以及 IPv4/IPv6 组播段。
- **视频/图片输入的私有地址判定既误杀又漏判**（真机可复现）：
  - 旧规则用 `/^(?:fc|fd|fe8|fe9|fea|feb)/` 同时匹配域名与 IPv6 字面量，结果把
    `fc2.com`、`fcdn.cloudflare.net`、`fd.example.com`、`fe8.images.xyz` 这类**公网域名**
    一并拒掉 —— 用户拿公网图做首帧只会看到「private/reserved hosts are rejected」；
  - 反过来 `https://[::ffff:127.0.0.1]/`（IPv4-mapped）能**绕过**检查并被真实提交到上游。
    第一版修法把 `::ffff:` 判在第 3 段，可它真实结构是「前 5 段 0 + 第 6 段 ffff + 末两段 IPv4」，
    段位错则整条判据失效；`::ffff:127.0.0.1` 与 `::ffff:7f00:1` 是同一地址的两种写法。
  - 现在域名只按 `localhost` / `*.local` 判；含 `:` 的主机先**严格展开成 8 个 16 位段**
    （末尾点分 IPv4 占两段，段数不足即视为不可信），再判 ULA `fc00::/7`、link-local
    `fe80::/10`、站点本地 `fec0::/10`、文档段 `2001:db8::/32`，IPv4-mapped/compatible
    取内嵌 IPv4 走同一套规则（并补上 CGNAT `100.64/10`）。
- **超大图片先读进内存再拒绝**：本地路径原先是 `readFile()` 拿到 Buffer 之后才比上限，
  传一个 2 GB 文件会先占用 2 GB（base64 再涨 1/3）才回 400。改为**先 stat 后读**，
  超限/空文件在读盘之前就拒绝；读完后仍按真实长度复核一次（防 stat 与读取之间被替换）。
- **失败任务拿不到失败原因**：状态归一是大小写不敏感的，但「是否失败」却写成
  `entry.status === 'failed'`。上游回 `FAILED` / `Failed` / ` failed ` 时对外 `status`
  是 `failed`、`error` 却是 `null`，用户只能看到「上游未给失败原因」。
- **产物地址只认 `signedUrl`/`url`**：上游改给 `downloadUrl` / `signed_url` / 裸字符串 /
  嵌套 `{file:{url}}` 时，「已完成且有产物」会被误报成 `*_NO_OUTPUT`。改为统一收集
  （去重、只收 https），视频与图片共用一份实现。
- **工具层静默丢图片参数**（会直接导致重复计费）：`workbuddy_generate_video` /
  `workbuddy_generate_image` 原先用 `typeof item === 'string'` 过滤首帧与参考图，
  模型把首帧写成 `{path}` / `{url}` / `{base64}`（多模态协议里很常见）时图片被丢掉，
  请求**退化成文生视频/文生图却照常计费**。现在认得出包装就取出字符串（`base64` 自动补
  `data:` 前缀），认不出就**拒绝提交**并说明原因；桥侧「未知字段 400」拦不住这种情况，
  因为到达桥时字段已经是空数组了。

### Added

- **同步完成的提交也能当场落盘**：`workbuddy_generate_video` / `workbuddy_generate_image`
  新增 `save_to`（只对提交时已同步完成的产物生效；异步任务完成后再查状态时再传一次）。
- **图片状态回执展示可复用 fileKey**：图片完成时把 `result_files[].fileKey` 一并列出，
  后续改图/图生视频可以直接把它当输入，不必重新下载 + base64 上传。视频产物的
  fileKey 不是图片，不宣称可当首帧复用。
- **状态工具最长代等 120 秒**：视频实测 ~101 秒出片；工具把预算按桥的 60 秒一段拆开，
  一次调用通常就能等到终态，减少反复“稍后再查”的回合。
- **更可执行的错误**：新增 `*_KEY_RATE_LIMITED`（临时 key 限流，任务未提交、不会计费）、
  `*_PAYLOAD_TOO_LARGE`（413 请求体超限），并在 400 响应里带 `upstream_code`；
  403 区分「本地令牌用错」与「账号没有权限」。
- **inline 图片预算**：本地路径/data URI 多张图在提交前按 `WORKBUDDY_MAX_BODY_BYTES`
  折算（base64 膨胀 4/3），超预算直接 400 并建议改用 fileKey/URL，不再读完几十 MB 才 413。
- **用量页不再铺全 0 的生成卡**：没有视频/图片记录时隐藏「生成消耗」块，避免被误认为
  统计坏了；有数据时不变。用量 CSV 增加视频/图片列（面板按天）和独立生成段（控制台汇总）。
- **媒体能力文案补齐**：插件工具注册日志、入口注释、`/workbuddy` 命令说明和架构文档
  都不再漏掉图片生成；`.env.example` 同步写上图片接口与请求体预算。
- **生成产物可落盘**：`workbuddy_video_status` / `workbuddy_image_status` 新增 `save_to`
  参数（绝对路径，目录或完整文件名）。给定时把签名 URL **流式下载**到本地并回传真实
  文件路径 —— 上游签名 URL 有时效（视频实测约 12 小时），过期后想再要只能重新提交
  （等于再扣一次积分）。下载失败**不让整次查询看起来失败**：照常回报状态并退回 URL。
  下载器只接受 https、有 256 MB 上限与 120 秒超时、先写 `.part` 再原子改名，
  失败不留半截文件；文件名由时间戳 + 清洗过的 taskId 生成，`../` 无法逃出目标目录。

## [1.14.0] - 2026-10-25

### Added

- **文生图 / 图生图接口**：桥新增 `POST /v1/images`（文生图）、`POST /v1/images/edits`
  （图生图）、`GET /v1/images/{id}`、`GET /v1/images/{id}/content`：
  - 与视频同源（Miora `image/generate/submit`、`image/edit/submit`、`image/query-task`），
    共用临时 key、401 一次性换 key、429/5xx 不自动重试；
  - 图片输入支持绝对本地路径 / miora fileKey / 公网 https / base64 data URI，
    单张 **≤ 20 MB**（视频帧 10 MB）；
  - 路径语义固定：`/v1/images` 只做文生图（带 `images` 会 400），
    `/v1/images/edits` 只做图生图；`size`（`WIDTHxHEIGHT`）与 `quality` 透传上游；
  - 异步任务 + `?wait=N` 长轮询 + 提交元数据内存回填（6 小时，不含 prompt）；
  - 错误码统一 `IMAGE_*`（`IMAGE_NOT_FOUND` / `IMAGE_NOT_READY` / `IMAGE_NO_OUTPUT` 等），
    与视频的 `VIDEO_*` 区分。
- **dsh 图片工具**：`workbuddy_generate_image`（提交，给 `images` 即图生图）与
  `workbuddy_image_status`（查询，`wait_seconds` 默认代等 20 秒）。
- **用量页支持生成类计数与消耗**：插件「用量」与控制台用量页新增
  「视频提交 / 视频失败 / 图片提交 / 图片失败」四张卡，以及**单独**的
  「视频消耗积分 / 图片消耗积分」两张卡；`/v1/usage` 新增
  `images` / `imageFailed` / `videoCredit` / `imageCredit`（含 `*Known` 计数）。
  上游不回报单次积分，桥用**提交前后账号余额差**记录 `creditEstimate`（估算；
  并发生成或模型调用会混入；读不到时显示「—」而不是 0）。
- `docs/IMAGE-GENERATION.md`（接口、参数、错误码、与视频差异、未实测声明）；
  OpenAPI 新增 `ImageRequest` / `Image` 与四条图片路径。

### Changed

- **抽出 `bridge/miora-media-core.mjs`**：临时 key、`mioraRequest`、图片归一化、
  长轮询、提交元数据缓存都只保留一份；错误码前缀由 `prefix` 参数决定
  （视频 `VIDEO_` / 图片 `IMAGE_`），视频行为与既有契约不变（`miora-video.mjs`
  仍按原名字导出）。
- 视频与图片共享同一条临时 key 缓存（同一账号只申请一次），减少上游 `/v2/api-keys` 调用。

### Notes

- 图片接口的路径、字段与限制来自客户端内置 `miora-mcp` 的实现，并用桩上游做了端到端
  合约测试；**本轮没有真机出图**（避免计费），实际出图效果与扣费时点未实测。

## [1.13.1] - 2026-10-25

### Fixed

- **`wait` 预算按真实时间计**：原先只按轮询次数（`ceil(wait/2)+1`）限制，单次查询很慢时
  实际等待会超过 `wait` 的秒数；现在同时用截止时间兜底，慢查询也会按时返回最后一次状态
  （不是失败）。回归：`miora-video.test.mjs` 的 `task-deadline` 用例 —— 两次 10 秒查询
  用尽 20 秒预算即停止。

## [1.13.0] - 2026-10-25

### Added

- **文生视频 / 图生视频接口**：桥新增 `POST /v1/videos`、`GET /v1/videos/{id}`、
  `GET /v1/videos/{id}/content`，走 WorkBuddy 桌面端同款 Miora 网关：
  - 支持文生视频（`text`）、首帧（可选尾帧）生视频（`frame`）、参考图生视频（`reference`）三种模式；
  - 图片输入支持绝对本地路径、miora fileKey、公网 https URL、base64 data URI；
  - 实测约束：时长 4–15 秒、分辨率 768P / 2K（3 秒 / 720p 会被上游拒绝，桥原样映射为 400）；
  - 真机验证：`minimax-h3-iOA` 生成 4 秒 / 768P 视频，101 秒出片，MP4（H.264+AAC，1344×768）可播放；
  - 异步提交（202）+ 状态查询；临时 key 只驻内存，401 换 key 重试一次，
    429/5xx 不自动重试以避免重复计费；
  - 视频提交进本地账本（`kind=video`），控制台用量页单列「视频提交/视频失败」，
    不污染模型调用与 tokens；
  - 配额与安全边界见 [`docs/VIDEO-GENERATION.md`](docs/VIDEO-GENERATION.md)。
- **视频查询长轮询**：`GET /v1/videos/{id}?wait=N`（0–60 秒，整数）由桥代客户端每 2 秒
  轮询到终态，返回最后一次状态；查询不计费，超时不是失败。`/content` 同样支持 `wait`。
- **提交元数据回填**：`mode` / `seconds` / `resolution` / `aspect_ratio` / `created_at` /
  `model` 这些“只有提交时才知道”的字段，在同一桥进程内查询时补回（内存 6 小时、最多 500 条、
  不含 prompt、不落盘；桥重启后为 `null`，不伪造）。
- **dsh 视频工具**：新增 `workbuddy_generate_video`（提交，异步返回任务 id）与
  `workbuddy_video_status`（查询/取下载 URL，新增 `wait_seconds`，默认代等 20 秒），
  工具文案明确高积分计费且禁止重复提交。
- **打包完整性门禁**：新增 `npm run check:pack`，递归校验根包入口的本地 import 都在
  `package.json files` 里，已接进 `release:check`。
- OpenAPI 契约新增 `VideoRequest` / `Video` 与三条视频路径；`.env.example`
  新增可选的 `WORKBUDDY_MIORA_BASE`。

### Fixed

- **根包漏打包 `bridge/miora-video.mjs`**（发布阻断）：`files` 白名单里没有它，从 npm
  安装后 `detectProjectRoot()` 仍会选中根目录 `bridge/`（因为 `workbuddy-bridge.mjs` 在），
  桥一启动就 `ERR_MODULE_NOT_FOUND`；本地跑仓库永远不红。现已补进 `files`，并用
  `check:pack` 防复发；`verify:release` 的关键文件清单与逐字节比对也补上了
  `vendor/bridge/miora-video.mjs`。
- **视频参数被静默忽略，可能按错误模式计费**：未知字段（`size` / `image` /
  `firstFrameImage` 等）、空字符串帧、非字符串参考图原先会被跳过 —— 请求退化成文生视频，
  图片没带上却照常提交。现在一律本地 400，并附 `Accepted` 清单与常见错写指路。
- **completed 但无产物误报 409**：`/content` 对“已完成却没有 https 产物”返回
  `502 VIDEO_NO_OUTPUT`，与“还没生成完”的 `409 VIDEO_NOT_READY` 区分开，客户端不会再
  以为继续等就行。
- **非法 `wait` 静默当 0**：`?wait=abc` 现在返回 400，不再悄悄退化成一次性查询。

### Changed

- **视频参数归一**：`duration` 必须正整数（拒绝 `4.5`）；`768p`/`2k` 归一成 `768P`/`2K`；
  `aspect_ratio` 只接受正整数比（去空格，拒绝 `0:0`）；data URI 必须是 `image/*`；
  `firstFrame` / `lastFrame` / `aspectRatio` 等 camelCase 别名可用，同一字段给多次会 400。
- **工具文案**：`workbuddy_video_status` 展示提交时间与提交元数据；新增 409 /
  `VIDEO_NO_OUTPUT` 的「别重提」结论；`workbuddy_generate_video` 注明严格校验与正整数时长。
- **文档与契约**：`docs/VIDEO-GENERATION.md` 重写为字段/别名/校验表、模式推断表、错误码表、
  `wait` 与元数据边界、curl 示例；`docs/openapi.yaml` 补 `additionalProperties: false`、
  别名、`wait` 参数与 `created_at` 语义。

## [1.12.0] - 2026-10-25

### Added

- **活动倍率按时间窗实时计算**：解析上游 `modelPromotions.schedule` 的
  `daily` / `timezone` / `validFrom` / `validUntil`，不再只看 `discount.factor`：
  - 夜间免费（`hy4-preview`）每天 23:00–08:00 显示「免费」/倍率 0，08:00 恢复原价；
  - 夜间折扣（`glm-5.2`）23:00–7:50 显示折后倍率（0.395），白天回原价；
  - 过期活动（`step-5-preview` / `space-bunny`）自动隐藏徽章，不再误标免费；
  - 支持跨午夜、多时段、日期范围（如 `hy3` 限免到 11/1）和自定义时区。
- 模型对象新增 `promotion_active` / `promotion_text` / `promotion_until` /
  `promotion_factor`；dsh 选择器、插件面板、控制台和 `workbuddy_models`
  工具统一显示「进行中/未生效」与活动说明。

### Fixed

- **静态 `free` 误报**：旧实现把 `discount.factor === 0` 当成“当前免费”，导致
  夜间免费模型白天也显示免费、夜间折扣从不打折、过期活动仍挂徽章。
- **过期 tags 漏回**：桥输出模型时重建促销 `badge:` tags，过期活动不会从上游
  `tags` 里再次露出来；`dsh` 模型名也会按当前有效倍率显示 `免费` / `×0.395`。

## [1.11.0] - 2026-10-25

### Added

- **网页搜索开箱自动接入（issue #7）**：插件启动、桥就绪后自动把 dsh 的
  `web-search-deepseek` 指向本地桥，并用 dsh 自己的 web 服务自检。默认行为有边界：
  用户显式选过后端（`baseURL` / API key / `searchProvider`）就完全不碰；桥没启动/
  没登录时先等待，不写半套配置；桥换端口或本地令牌轮换时在启动时自愈。可用
  `WORKBUDDY_AUTO_WEB_SEARCH=0` 关闭。
- **`workbuddy_web_search` 工具**：直接调用桥的 `/v1/web_search`，不依赖 dsh 的搜索
  配置。dsh 内置搜索仍指向 DeepSeek、key 401 或配置被改坏时，agent 仍可用 WorkBuddy
  原生搜索兜底；`workbuddy_status` 也会报告内置搜索是否已接桥。
- **恢复不再依赖内存快照**：自动接入后重启 dsh 也能「恢复接入前配置」——只摘掉插件
  写进去的桥地址/独立凭据引用，保留用户的其它搜索字段；恢复后会留下显式选择标记，
  下次启动不会又自动接回去。
- **「网页搜索」提升为概览最上方的独立卡片**：不再把「一键接入」埋在「操作」按钮堆里；
  旧宿主还没上报搜索状态时也显示这张卡，并给出「重启 dsh 后自动接入」的说明与手动入口。

### Fixed

- **真实 dsh 的 settings 服务没有 `get(ns)`**：它只提供 `describe()/update()/replace()`。
  旧代码用 `settings.get` 判断搜索配置，导致配置明明存在也显示“不可用”、自动接入被跳过，
  面板只能退化成操作区里的一个按钮。现在统一用 `describe()` 读取生效值 + 用户层；
  首次启动时 settings 服务尚未挂载的话会等待并重试，不再永久卡在 waiting。
- 恢复接入前配置时，如果没有内存快照（自动接入后重启 dsh），按钮改为「恢复默认搜索配置」，
  只摘掉插件写入的桥地址/独立凭据引用并退出自动接入，不会假装恢复一份已经丢失的自定义配置。

## [1.10.1] - 2026-10-24

### Fixed

- **上下文预算的生效时机说清楚**（仅文案/文档修正，行为不变）：dsh 的
  `request/context` 是**每轮 `prepareCall()` 解析**、仅 contextWindow/模型变化
  时追加；面板保存 600K 后，**下一轮请求**就按 600K 解析（同一会话也生效）。
  用量弹层的分母是上一轮请求的快照，保存后没发新消息时仍显示 1M 是正常的，
  发一条消息即可刷新；切换模型后按该模型自己的预算解析。面板状态改为
  「当前配置」，保存提示不再声称“已保存并即时生效”，而是明确“下一轮请求生效 /
  发消息刷新”。

## [1.10.0] - 2026-10-24

### Changed

- **模型详情的 Token 设置合并为一张「上下文窗口（Token）」表单**：输入（dsh
  上下文预算）与输出（发给上游的 `max_tokens`）并排，两行都支持滑块粗选 +
  数值框精确输入（`128K` / `1M` / `131072`），留空 = 自动。Token 两行改完
  自动保存；temperature / 思考强度在同一张表单里点「保存修改」提交。服务端
  原子写入 `contextWindowByModel` 与 `paramsByModel`；新增 `≤ 模型上限`、
  `≥ 1K` 的即时校验；输入/输出共享窗口只做**非阻断提示**（官方模型本身
  就可能给“默认输入 300K + 输出上限 384K”的组合，不能把官方默认判成
  错误）。另加「恢复默认 / 放弃修改」。
- **Token 改完自动保存**：滑块松开、输入框失焦/回车即落盘，不再依赖
  统一保存按钮（窄面板里它可能落在折叠线以下，用户改完切页会丢失）；
  采样参数（temperature / 思考强度）仍点「保存修改」一起提交。131072 等
  非整千值在输入框里原样回填，避免显示成 128K 后再次保存变成 128000。
- 上下文/输出与自动值重复的滑块档位被折叠；官方抽象档位不再出现
  「自动(300K)」和「300K」两个等效项；覆盖值会在模型行标「自定义」，筛选
  行新增「已自定义（N）」。
- `128000` 显示为 `128K`（十进制优先、1024 进制兜底），同时保留精确
  tokens 的悬停提示。
- 上下文/输出保存后按 `applied` 区分「已即时生效」与「重启 dsh 后生效」，
  不再在旧宿主上假装即时生效。

- **模型偏好改存稳定位置**：`.model-prefs.json` 从插件安装目录（node_modules
  内，重装/清 pnpm 缓存会被抹掉）迁移到
  `<DSH_HOME>/workbuddy-model-prefs.json`；读到旧位置更新的偏好时自动
  复制一份过去。用户把模型调到 1M 等设置不会再在重装后静默回到默认值。

## [1.9.8] - 2026-10-24

### Added

- **上下文长度按模型单独调（#5）**：模型详情里新增「上下文长度」滑块，
  档位取该模型官方目录的 300K / 600K / 1M（以及官方默认/上限），拖动后
  即时预览、停顿自动保存；「自动」= 跟随官方默认 / 桥配置。每个模型有
  自己的值和上限，不再全局一刀切。偏好存进 `.model-prefs.json` 的
  `contextWindowByModel`（插件目录只读时回退到
  `<DSH_HOME>/workbuddy-model-prefs.json`）。`WORKBUDDY_CONTEXT_WINDOW`
  仍可用，但只作为面板「自动」时的桥端默认值/其它 OpenAI 客户端的设置。
- **官方默认 temperature 直接显示**：桥之前把上游模型对象里的 `temperature`
  整个丢掉，面板只能写“官方未公开”。现在 `/v1/models` 会返回
  `default_temperature`，模型详情显示该模型的官方默认温度；留空时插件不
  下发该字段，由上游使用这个默认值（补全模型拿不到时如实显示“未公开”）。
- **思考强度来源可分辨**：模型行对“官方目录未列、按实测补全”的模型标
  「实测补全」，对只有本地实测档位的模型标「实测档位」；详情里写明
  `upstream / measured / fallback` 三种来源。这样国际版补全模型显示 6 档、
  国内版官方目录显示 3 档时，用户能一眼看出差异来自目录而不是漏抓。
- **每模型默认参数的填写引导与反馈**：模型详情新增常用温度一键值、参数
  作用说明、合法范围提示；temperature / max_tokens 输入即时校验，非法值
  禁用保存；有改动时明确显示“未保存”，保存后按钮变“已保存”并显示当前
  生效值。`max_tokens` 上限跟着当前模型走（超过官方输出上限直接拦下）。

### Fixed

- **面板保存的每模型默认参数在 dsh 里不生效**：dsh 的 `resolveCall` 会把
  `defaultMaxTokens` / `reasoning.defaultEffort` 物化进请求，而适配器的
  `resolveModel` 仍只返回上游默认，导致面板里保存的 max_tokens / 思考强度
  被 dsh 的物化值覆盖（界面显示已保存，实际请求没变）。现在 `resolveModel`
  返回**每模型默认 > 插件全局默认 > 上游默认**，并对 max_tokens 按模型官方
  上限收敛；`stream()` 直调时也会按目录上限兜底。
- **思考强度选 Max 后详情仍显示官方默认**：把“官方默认档位”明确标成官方
  默认值（不会随选择变化），另加“当前思考强度”实时显示；下拉选项改为
  「跟随官方默认（…）」，用户能分清“不覆盖”和“选了 Max”。

## [1.9.7] - 2026-10-24

### Fixed

- **账号切换即时生效**：桥新增极轻的 `GET /v1/identity`（只解析凭据，不抓
  目录、不打上游），带 `auth.changedAt` / `pid` / `build`。插件宿主每 2 秒
  轮询并在身份变化时立刻作废目录/积分/签到、通知 dsh 选择器；插件面板与
  控制台也按同一端点刷新所有已挂载面板，不再等 8/20/60/120 秒的整页轮询。
- **同文件换号后模型目录仍属于上一个账号**：`syncAuthPathFollow` 只在“跟随
  路径变化”时作废目录；客户端原地覆盖同一个登录文件、或来源自动回退到另一条
  凭据时，`/v1/models` 会继续返回上一个账号的模型/倍率/思考档位。现在
  `readStoredAuth` 发现身份或区域变化会作废目录；目录缓存也记录抓取账号，
  取用前再核对一次。
- **多客户端并存时默认读错登录文件**：原逻辑写死优先国内版
  `workbuddy-desktop.info`；只用国际版、或两个客户端都装但当前用国际版时，
  桥/控制台一直读国内版的旧账号（客户端换号自然看不到变化）。现在启动时在
  两个活动文件里按**最近写入**选择，登出留下的 `workbuddy-desktop.<时间>.info`
  快照只在没有活动文件时兜底。控制台与桥同一判据；同一文件内换号实时跟随。
- **换号瞬间并发请求读到不同来源**：来源=plugin 时，一个请求刚完成「跟随
  桌面」并把来源改成 desktop，另一个已经读到 plugin 的请求随后仍走
  `readPluginAuth()` —— 同一时刻有的请求用新号、有的用旧号（启动时的目录
  刷新与 /health 并发就会撞上）。现在插件分支会重新读取来源，不再拿开头
  的旧值继续。
- **独立启动的桥不认面板账号选择**：`npm run bridge` / `启动.cmd` 直接
  `bridgeEnv()`，既不读 `.state.json` 的钉住快照，也不注入换号跟随信息。
  现在与控制器、dsh 插件走同一套账号选择与 follow=auto。
- **升级后旧桥/旧控制台仍在服务（#5 六档位、#6 换号不生效的根因）**：插件升级
  只换磁盘脚本，后台的桥和 8792 控制台是独立进程，不会自己退出 —— 用户看到的
  仍是旧代码的行为，而版本号已经是最新。现在桥 `/health` 与控制台首页都带
  **构建指纹**，插件启动/重启时发现端口上的进程与当前脚本不一致，会自动停掉
  旧进程并按当前代码重新拉起（控制台按已校验的监听 PID 停，查不到 PID 时
  如实报错、不瞎杀）。
- **账号与余额各读一份数据（#6「账号是新的、积分是旧的」）**：`/v1/quota` 现在
  带回 `account` / `source`；控制台积分缓存按账号记账，发现缓存属于另一个账号
  就作废重取。概览的「账号 / 令牌」卡片改为展示**桥实际生效的身份与凭据来源**，
  桌面登录文件只作为对照；两者不一致时明确标出「未生效」，不再把桌面账号
  挂在插件账号的余额上。
- **来源=插件账号时桌面换号不跟随（#6 残留）**：桥每次解析凭据前都会检查
  桌面登录文件；客户端换号（UID 变化）时把来源跟随回桌面，并记住这次切换；
  用户随后在面板主动选回「仅插件登录」不会被反复抢走，桌面下一次换号再跟随。
  环境变量锁定来源时保持锁定。账号页在「已选（未生效）」状态下补了
  「改用桌面端」入口，不再是一个无处可点的死胡同。旧 `source.json` 没有
  换号基线时，会按桌面文件与插件来源的选择时间判断一次；如果本来就打算继续
  用插件账号，在账号页选回「仅插件登录」即可固定，不会再被抢走。
- **插件拉起的桥不认面板账号选择**：插件启动桥时读取与控制台同一份
  `.state.json`（`authFile` + `authFileDesktopUid`），注入
  `WORKBUDDY_AUTH_FILE_FOLLOW=auto` 与桌面 UID；桥复用前还会核对当前生效的
  登录文件，不一致就重启，避免控制台与 dsh 各服务一个账号。
- **模型显示设置写盘失败被静默吞掉**：插件目录在部分安装形态下只读，旧实现
  写失败仍然返回成功，重开面板就回到默认值。现在优先写插件目录，失败回退到
  `<DSH_HOME>/workbuddy-model-prefs.json`；两处都写不了会如实报错，不再假装
  已保存。
- **目录抓取被单端点 401 拖死**：`/v2/enterprises/personal/models` 对部分
  `workbuddy.cn` 账号会单独 401，而权威的 `/v3/config` 正常。旧逻辑每轮都把它
  当令牌过期去刷新、再接管到插件凭据，目录永远建不起来（面板模型列表为空 /
  反复刷新）。现在 `/v3/config` 优先，且已有目录端点成功时不再因另一端点
  401 刷新/换号；诊断里会标注 `HTTP 401 (ignored: another catalog endpoint
  already succeeded)`。
- **配额 / 签到 401**：计费网关改为跟随登录域名选择（`workbuddy.cn` 账号走
  `www.workbuddy.cn`，不再一律发到 `codebuddy.cn`）。该账号当时还叠加了旧令牌
  问题，桌面端重新登录刷新令牌后 `/v1/quota` 与 `/v1/checkin` 均恢复；两处都
  已按“域名选择 + 令牌状态如实报错”处理。
- **体检误报与噪音**：体检请求的 `max_tokens` 从 1 提到 64（推理模型会拒绝
  过小的输出预算，旧的 1 会把可用模型误判成不可用）；体检请求在账本里标
  `probe: true`，不再计入面板「最近请求失败」待办。
- **模型页窄屏适配**：dsh 设置弹窗宽度是官方固定的（内容区约 400px），7 列
  模型表会被裁掉右侧。现在按面板容器宽度自动切成三行卡片（模型 / 名称与徽章 /
  上下文·体检·倍率），详情改为单列；体检状态只显示「可用 / 不可用」，毫秒、
  错误与扣分放进悬停提示和详情，不再因为文案变长把表格撑宽。
- **保存模型显示设置被新分支吞掉**：面板保存会同时带 `includeUnofficial`，
  旧实现先命中“只改开关”的捷径并直接返回，`visible`/`hideAll` 全部丢失。
  现在只有单独提交该开关时才走捷径，组合保存按完整状态处理。
- **换号期间的刷新竞态**：刷新请求在飞时桌面端换了账号，旧实现会把旧账号
  令牌与新文件指纹一起写进 `memoryAuth`；现在刷新前记录文件指纹，文件变化
  就丢弃这次刷新。跟随换号时同时作废模型目录，避免继续拿上一个账号的模型。
- **目录端点部分失败**：一个端点 5xx/HTML 不再吞掉另一个端点已成功的目录；
  reasoning/contextWindow 子字段按字段合并（v3 档位 + v2 默认值不再互相覆盖）；
  v2 单独带 `chat` 标签的模型也计入官方清单。
- **当前默认模型的可见性**：勾选白名单或「全不选」后，当前 dsh 默认模型仍保留
  在选择器里，不会出现“正在用的模型凭空消失”。
- 模型表补充 `aria-label`、复选框/操作按钮的模型名、详情 `aria-expanded`；
  体检失败的错误原因进入详情；展开最后一行时自动滚入视口。

## [1.9.6] - 2026-10-23

### Fixed

- **账号切换后插件仍显示旧账号（#6）**：在 WorkBuddy 客户端里换号时，客户端覆盖
  的是它自己的默认登录文件，而面板的「切换账号」把桥钉在了某个历史快照上，于是桥
  和面板一直用旧账号，重启 dsh 也不恢复。现在记录「钉住那一刻桌面端的账号」，
  桌面端换号后桥自动跟随桌面登录文件（换回原账号则恢复钉住）；旧的 `.state.json`
  没有该元数据时按「快照账号 ≠ 桌面账号」迁移一次。控制台启动与账号页也会校正
  过期钉住，并只重启确实按旧快照启动的桥。
- **模型清单与思考档位对齐官方目录（#5）**：桥现在以 `/v3/config` 的 models +
  agents[] 判定「官方模型选择器是否列出」，`/v2/.../models` 独有的模型标
  `official:false`；dsh 选择器默认只显示官方清单，面板保留全部并标「官方未上架」，
  可在「显示官方目录外的模型」里手动开启（建议先体检 —— 实测部分扩展模型
  `glm-4.6` / `glm-5.0` / `minimax-m2.5` / `hy4-preview-x` 上游直接 400，
  `kimi-k2.5` / `deepseek-v3-2-volc` / `hunyuan-chat` 可正常调用）。
- **思考档位改为直取上游 `reasoning.supportedEfforts`**（官方 GUI 的低/高/极致 =
  low/high/max），不再用本地六档表覆盖官方声明；上游没给时才退回实测表。
  已保存的旧档位（如 `hy3` 的 `medium`）会临时保留，避免升级后 dsh 直接
  `UNSUPPORTED_REASONING_EFFORT`，用户重选后自动消失。
- **上下文默认值对齐官方**：`/v1/models` 的 `context_window` 改为官方
  `contextWindow.defaultLength`（多为 300K，不再一律报模型上限 1M），并新增
  `context_window_default` / `context_window_options` / `context_window_max`；
  dsh 没有上下文档位选择器时，可用 `WORKBUDDY_CONTEXT_WINDOW=600000|1000000`
  钉住（不超过模型上限）。
- 用量统计把网页搜索与接入自检从模型调用中分离：新增 `searches` /
  `searchFailed`，模型 calls / tokens / credit / 平均耗时不再混入搜索调用。
- 面板用量页补上「已回报 X/Y 次扣分」、搜索次数/搜索失败，以及
  「本地账本只覆盖本桥流量，与上游余额/其它客户端不是同一口径」的说明，
  与控制台对齐；旧桥没有 `searches` 字段时明确提示重启桥，不假装已拆分。
- 用量页 UI 收尾：指标改 4 列布局、空账本显示空状态而不是一屏 0、搜索失败
  在失败列表里标注「（搜索）」、图表指标名统一为「模型调用」。

## [1.9.5] - 2026-10-22

### Added

- 一键接入前快照 dsh 的搜索分节和独立凭据；新增「恢复接入前配置」，可还原
  接入前的 `web-search-deepseek` / `web` 设置与凭据引用，不触碰 `DEEPSEEK_API_KEY`。
- `/v1/messages` 的搜索响应补上 `server_tool_use` 与
  `usage.server_tool_use.web_search_requests`，修复 `tool_use_id` 悬空；不伪造
  Anthropic 的 opaque `encrypted_content`（dsh provider 不需要）。
- `npm run preflight` 增加只读的网页搜索配置层检查。

### Fixed

- 网页搜索状态卡改为「配置 + 桥存活 + 令牌匹配」判定：桥停止、令牌轮换、
  地址指向旧端口时不再显示绿色；新增「重新检测」与最近一次自检的来源数/失败原因。
  一键接入的前端超时放宽到 90s，并在服务端复用同一个在途任务，避免冷启动桥时
  “前端已超时、配置其实已写好”的撕裂状态。
- 上游返回非 JSON 200 不再被当成 0 结果成功；搜索的 401 刷新、换凭据与 5xx
  重试共享同一个 20s 总预算；限流错误统一映射成 429 / `rate_limit_error`。
- 兼容 Node 18：搜索/聊天取消信号不再无条件使用 Node 20.3 才有的
  `AbortSignal.any`；超大请求体回 413 后主动排空剩余字节。

### Docs

- 移除不存在的 `DEEPSEEK_SEARCH_BASE_URL` 建议，补充搜索错误码与限流排查；
  在 `NOTICE.md` 补充使用边界（仅自己账号本地互操作、不做多账号池化/转售）。

## [1.9.4] - 2026-10-22

### Added

- **WorkBuddy 原生网页搜索（不消耗 DeepSeek 钱包）**：新增 `POST /v1/web_search`
  直连 WorkBuddy `/agenttool/v1/search`（结构化标题/URL/snippet、限流映射 429），
  并让 `/v1/messages` 识别 `web_search_20250305`，直接返回 dsh provider 需要的
  Anthropic `web_search_tool_result` + text citations。dsh 内置的 Web search
  provider 只需把接口地址指到桥（`http://127.0.0.1:8790/v1`）、API key 填桥令牌，
  搜索就不再发往 DeepSeek。支持 `WORKBUDDY_SEARCH_BASE` /
  `WORKBUDDY_SEARCH_VERSION` / `WORKBUDDY_SEARCH_TIMEOUT_MS`。插件面板「概览 →
  操作」与 `/workbuddy websearch` 提供**一键接入 WorkBuddy 搜索**：自动把 dsh 的
  web-search-deepseek 接口地址指向本地桥，把桥令牌写进独立凭据引用（不覆盖用户的
  DeepSeek key），再用 dsh 自己的 web 服务真搜一次做自检并回报结果。dsh 未注册
  `web` settings 分节（rc.6 的 provider 选择在 bundle patch 里）时会跳过该步而不是
  报错。概览顶部新增独立的「网页搜索」状态卡；未接入或缺少桥令牌时在「需要你动手」
  里高亮提醒，并直接给出「接入搜索」按钮。状态检查只读配置，不消耗搜索额度。

- **dsh「添加插件」直装**：根包 `workbuddy-to-dsh` 改为可发布形态
  （`private: false` + `publishConfig`），在 dsh 设置 → 插件 → 添加插件里填
  `github:Ianzhyh/workbuddy-to-dsh` 即可安装（已用真实 `dsh plugin add` 实测）；
  发布到 npm 后也可直接填裸包名 `workbuddy-to-dsh`。npm 名
  `dsh-plugin-workbuddy` 已被他人占用，子包因此改为 `private`，npm 分发统一走根包。

- **GitHub 直装形态的发布门禁**：新增 `npm run verify:github`（已接入
  `release:check`），真实执行根包 `npm pack` → 安装到临时 profile 的
  `node_modules/workbuddy-to-dsh` → 校验 Loader 名、客户端注册 id、运行时文件与
  `projectRoot`，并实际启动安装后的桥与控制台。issue #3 这类「根包形态没验证」
  的漏洞会在发版前被拦下。
- **安装契约测试**：新增 `install-contract.test.mjs` 与
  `lib/packageNames.mjs` 单一来源，把两种安装形态的 manifest、`cordis.patch.yml`、
  `client.js` 注册列表、`NATIVE_PLUGIN_BUNDLES` 互相对照；任何一处漏改直接红。
- 故障排查文档补充 `workbuddy-to-dsh: import failed` 的根因、恢复命令与日志位置；
  `CONTRIBUTING.md` 增加新增/修改安装形态的检查清单。
- `install-contract` 一并校验发版版本号的 5 处同步（根包 / 子包 / lockfile 两处 /
  OpenAPI / README 的 tgz 文件名），漏 bump 会直接红。
- 新增 `csv-injection`（两处导出行为）、`log-rotation`（2MB 滚动）与桥的
  「换来源后旧目录晚到」竞态回归用例。
- 根包 `files` 收紧为运行时白名单：本地 `npm pack` 不再带入 `bridge.log` /
  `usage.jsonl` / `*.bak` / 测试文件；`verify:github` 会把「发布物里混入日志或备份」
  直接判失败。

### Fixed

- **dsh 系统身份句被上游 11128 拦截（2026-10-21 上游变更，issue #4）**：system 开头是
  `You are an AI agent powered by DeepSeek Harness.` 时，上游对**所有模型**直接回
  400 code 11128；同一凭据发最小消息（中性 system）是 200。桥现在只对 **system**
  做最小改写，把这一句换成中性身份句；用户消息、工具定义/结果与 system 其余内容
  原样保留。新增桥端回归用例。
- **11128 未知模板兜底（三条协议统一）**：upstream 再新增 system 黑名单时，桥按
  “删品牌行 → 删首段（保留后续 instructions）→ 整段中性 system”渐进重试；
  `/v1/chat/completions`、`/v1/messages`、`/v1/responses` 共用同一套逻辑。
  user、tools 与工具结果不动；成功时回 `X-WorkBuddy-11128-Fallback` 响应头，
  账本记 `fallback` / `fallbackOk`。可用 `WORKBUDDY_11128_FALLBACK=0` 关闭。
- **Anthropic/Responses 的鉴权错误不再误导**：上游 401/403 统一回 502 +
  `upstream_auth_error`（Anthropic 为 `authentication_error`），并保留上游原文；
  不再让 Claude Code/Codex 以为是本地令牌错误。
- **非法/重复 tool name 本地拦截**：上游对含 `.` / `/` / 空格或重名的工具名回
  确定性 400（11152 / `invalid_request_error`），整轮失败。桥现在在打上游前
  校验并返回可读 400，明确指出是哪个工具。
- **首字节/排队超时**：新增 `WORKBUDDY_FIRST_BYTE_TIMEOUT_MS`（默认 120s）与
  `WORKBUDDY_QUEUE_TIMEOUT_MS`（默认 120s）、`WORKBUDDY_MAX_SOCKETS`（默认 32）；
  上游只回响应头不说话或连接池排队过久时不再永久 loading。插件空闲看门狗默认
  开到 5 分钟（显式 0 可关）。
- **`.env` 逃生门真正到桥**：插件自动拉起桥时现在会透传版本指纹、11128 开关、
  跳过预校验、超时/连接池/重试/诊断等非机密变量；`npm run bridge` 改走
  `bridge/launch.mjs`，同样加载 `.env`。
- `probe-audit-template` 增加 dsh 形状的 `/v1/chat/completions` 探针，失败时退出码为 1；
  `preflight` 改用 `/v1/requests` 区分“11128 已兜底恢复”和“仍失败”。
- **桌面换号后仍用旧内存令牌**：`memoryAuth` 现在绑定登录文件指纹；文件被
  桌面端替换（换号/刷新）后立即丢弃，不再用旧账号令牌直到过期。跨账号
  failover 时同时失效模型目录，避免旧目录误杀新账号模型。
- **换号 / 换凭据来源时的模型目录竞态**：换号前已经在飞的目录请求无法取消，
  晚到的**旧账号**结果会写进新缓存，最长 5 分钟内模型选择器仍显示旧目录。
  现在目录带代次：`invalidateCatalogCache()` 立即开启新一代并作废旧结果；
  旧请求的 `finally` 也不会再误清新一代的在飞标记。
- **CSV 公式注入**：插件面板与控制台的导出都只转义了逗号/引号，Excel / WPS
  会把 `=`、`+`、`-`、`@`、制表符或回车开头的单元格当公式执行。模型名与上游
  错误原文都可控，`=HYPERLINK(...)` 能一路进账本。现在两处统一用 `csvCell`
  给危险前缀加单引号，并加了行为回归用例。
- **插件拉起桥时日志不滚动**：文档承诺每次启动检查 2MB 并滚成 `bridge.log.1`，
  实际只有控制台路径做了，dsh 插件长期运行会让 `bridge.log` 无限增长。现在
  插件 supervisor 在 spawn 前走同一套滚动逻辑。
- **Windows CI 偶发红**：消费方提前 break 的“连接被立刻收掉”用例原先要求帧数严格
  相等，门禁并行负载下会把已在途的 1 帧误判成泄漏；现在与 signal 取消用例同口径，
  允许 ≤2 帧在途，仍能钉死“继续写完整条流”的真实泄漏。

- **面板请求可能永久卡住**：`getJson` / `postJson` 没有超时，宿主半死时
  `useJson` 的重试等不到第一次失败，按钮也永远 busy；轮询还没有在途锁，
  桥慢时请求会叠着飞、晚到响应可能盖掉新数据。现在统一 20 秒超时、轮询与
  登录 poll 单飞，并丢弃取消/换号后的晚到响应。
- **客户端 key 不能碰管理面**：`/v1/auth/*`、清空账本、手动签到这些管理操作
  现在只接受本机 `LOCAL_TOKEN`；client key 仍可正常聊天、列模型，但不能再
  切号、删凭据或清历史。

- **账本明细只解析尾部**：`/v1/requests` 以前每次 `JSON.parse` 整本账（上万行），
  聊天页 15 秒、请求页 5 秒各来一次。现在从尾部凑够 `limit` 就停，坏行跳过，
  返回顺序与过滤语义不变。

### Changed

- `test:lib` / `test:bridge` 改用 glob，新增测试文件不会再因为忘记加入脚本而漏跑。
- 新增 `request-guard`、client-key 管理面 403、`a11y-markup` 与账本尾部解析的回归断言。
- **可访问性**：插件 9 个标签补 `tablist/tab/tabpanel`、`aria-selected/controls/labelledby`
  与左右/Home/End 键盘导航；Alert 与登录错误可被读屏播报；错误全文不再只藏在
  `title` 里；输入框与标签补 `focus-visible` 轮廓；控制台导航补 `aria-pressed`，
  操作反馈同步进 liveRegion。
- **`verify:release` 改为 fail-closed**：本地没有 tgz 不再「跳过即绿」；mirrors
  增加 `package.json` / README / patch，包内缺文件直接失败。
- Windows CI 补 `concurrency`、任务超时与 npm 缓存；`panel:check` 仍留在本地
  （runner 的浏览器/CDP 组合会挂起，需要单独修，先把门禁让给稳定步骤）。

## [1.9.3] - 2026-10-21

### Fixed

- **GitHub 直装时 dsh 无法启动（issue #3）**：dsh 用 Loader 条目的**包名**当
  客户端模块 id，而 `client.js` 原先只注册 `dsh-plugin-workbuddy`。仓库根直装
  的包名是 `workbuddy-to-dsh`，web boot 找不到对应 factory，直接报
  `workbuddy-to-dsh: import failed` 并中止启动。现在同一份 bundle 会按
  「两个已知包名 + `<script src>` 里的实际 id」注册；两种安装形态同时存在时
  重复注册会被忽略，不再连累 boot。
- 面板诊断里的「客户端半边是否组装」同时认两种包名，GitHub 直装不再误报
  「未组装」；`preflight` 的「插件装进了哪个 profile」也同时认
  `dsh-plugin-workbuddy` 与 `workbuddy-to-dsh`。
- **11128 的错误提示不再误导**：上游的来源/模板校验拦截
  （`Illegal API invocation from an unapproved channel`）以前会提示用户
  「换思考档位 / 调输出上限」，实际是另一类问题。现在单独提示「先原样重试，
  仍失败看桥日志」，参数类 400 的提示保持不变。

### Tests

- 新增 `client-bundle.test.mjs`：真实执行 `client.js`，按 dsh 的
  `arrive → 查找 factory` 语义验证两种包名、别名、旧版合并 URL 与重复注册。
- `panel-render` 断言 bundle 同时注册两个 id；`visibility` 用例同步更新；
  `preflight` 新增 GitHub 直装包名识别用例。

## [1.9.2] - 2026-10-21

### Fixed

- **插件热重载后不再沿用旧样式**：同 id 的 `<style>` 会被新 CSS 替换；对话页
  组件不在 `.wb-root` 内，补齐了动画变量，避免 `transition` 引用未定义变量整条失效。
- **聊天页按钮补 `type="button"`**：宿主把 hero/header 包在 form 里时不会触发提交。
- **旧宿主嵌套 `{usage:{…}}` 形状**下积分胶囊也能读到「今日已用」的当天桶。
- 设置面板登录 / 切号 / 退出成功后通知聊天页积分胶囊立即刷新，不必等 60 秒轮询。
- 对话测试的流式状态、错误与 AbortController 提到容器：切标签页时请求继续、回来仍显示
  「生成中…」/失败原因并能停止；关闭整个面板时自动中止，避免后台偷偷消耗额度。
- 一轮多请求的积分匹配在 routes 晚到时也会重新匹配，不再被首次渲染的依赖 key 卡住。

### Tests

- `panel-render` 新增：插件重载样式替换、登录按钮 `type`、旧宿主嵌套 usage、
  620px 窄列下的对话测试页溢出检查。

## [1.9.1] - 2026-10-21

### Fixed

- **设置面板异步操作不再卡死**：`postJson` 把网络层 reject 统一转成失败响应；
  刷新积分、登录、切号、体检等按钮在断网 / 桥刚退出后都会恢复可点，并给出失败原因；
  模型页「刷新目录」断网时也不再留下未处理 rejection。
- **「今日已用」改为本地当天**：不再读滚动 24h 的 `total`，改为按 `usage.days`
  的当天桶计算，跨午夜不会把昨天算进今天；旧宿主没有日桶时改标「最近24小时已用」。
- **估算积分在可见文案标 ≈**：不用悬停也能区分账本核对值与估算值。
- 每轮积分的账本匹配窗口从最近 20 条扩大到 100 条，历史会话或并发窗口下
  更容易命中实际扣费，减少退回估算。

### Tests

- `panel-render` 新增：503 / 空回答 / 快速重复回车的对话失败路径、一轮多请求
  按 routes 求和、网络 reject 后刷新按钮恢复、「今日已用」取当天桶、估算 ≈ 标记。

## [1.9.0] - 2026-10-21

### Added

- **已有对话里的登录入口**：未登录 / 凭据异常时，顶部积分胶囊位直接变成登录入口；
  空会话仍由 hero 承担，二者不重复。`/workbuddy/quota` 现在一并返回 `bridgeState`
  与账号归属，旧缓存余额不会再盖住登录入口；登录成功后立即刷新余额，不必等 60 秒轮询。
- **每轮积分改为账本核对**：利用宿主 `useChat` 标准 prop 读取本轮
  `tokenUsage` / `turnTimings`，与本地请求账本按 tokens 匹配（一轮多次请求按
  routes 求和），拿到**实际扣费**；旧宿主或核对不上时才退回最近请求估算。
- 登录等待支持取消与 10 分钟超时；轮询连续失败两次才退出，不再一次抖动就中断。
- 积分胶囊刷新失败不再卡死：保留上次余额并标红，最近一次请求失败也会在悬停中说明。
  首次读取就失败时显示可重试的「积分 —」，不会凭空消失；换号过渡期会标注
  「积分还是上一个账号的」并自动重读。
- 对话模型下拉与 dsh 选择器同口径显示 `×0.11` /「免费」。

### Fixed

- **对话测试：中文/日文输入法确认候选词的 Enter 不再误发送**；快速重复回车也不会重复请求。
- 对话测试：流式输出只在用户贴着底部时自动跟随，往上翻看不再被拽回底部。
- 对话测试：切到别的标签页再回来，输入框里打了一半的草稿不再丢失。
- 对话测试：请求在拿到任何内容前失败时，不再残留一个空白助手气泡；用户原文会还回
  输入框（已经在重新输入则不覆盖）。上游返回空回答（无正文/思考）也按失败处理。
- **每轮积分只出现在最后一个回合**：新回合出现后旧标签不会再残留；分栏/多会话时
  按同一会话的 tail 判断，不会把另一栏的回合误当成“最后一条”。
- 每轮积分在账本落盘稍晚时会自动重试三次，不再偶发不显示。

### Tests

- `panel-render` 新增断言：IME 回车不发送、积分刷新失败可恢复且保留余额、
  首次读取失败显示可重试占位、换号过渡标注旧账号、最近一次请求失败标红、
  登录可取消、顶部登录入口只在“已有对话”出现、每轮积分按 tokens 核对、
  非最后一轮不渲染、旧宿主追加回合后旧标签消失、输入草稿跨标签保留。

## [1.8.2] - 2026-10-20

### Added（首次打开体验）

- **对话页顶部常驻积分余额**：注册到 `conversation.session.header.utilities`，
  聊天时不用开设置页就能看到「积分 N」；点一下强制刷新。悬停可看套餐余量、
  今日已用和最近一次调用积分；套餐余量 ≤30% 变黄、≤10% 变红。
- **空会话 hero 直接登录**：未登录时 `conversation.hero.options` 出现
  「连接 WorkBuddy」，点一下发起设备码并自动打开浏览器，不用先进设置页。
- **每轮回复末尾显示积分**：`conversation.chat.turnTail` 在最新一轮回复后显示
  「本轮 x.xxx 积分 / 免费」；按最近一次已完成的模型请求估算（title 已注明）。
- **模型名直接标积分倍率**：dsh 选择器与聊天顶部显示
  `DeepSeek-V4.1-Flash · ×0.11`，免费模型显示 `· 免费`；描述里不再重复倍率。
- **未登录首屏改成欢迎卡**：只保留「连接 WorkBuddy → 浏览器授权 → 回 dsh 选模型」
  三步和一个「去登录」主按钮；空积分卡、桥状态、高级操作在登录前不展示，
  第一次打开不会再先看到一堆技术指标。保持现有卡片/按钮样式，不引入新的视觉语言。
- **首次安装账号页**：插件登录卡排在最前，未登录时隐藏「仅桌面端」选项。

### Fixed

- 未登录时误报「桥没有在运行」：桥其实活着，只是还没登录；现在由欢迎卡接管引导。
- 诊断页长路径 / 文件列表不再把「登录文件」标签挤成竖排；值改为左对齐自然折行，
  并加了布局回归断言。

## [1.8.1] - 2026-10-20

### Added（一键即用细化）

- **首次安装显示「未登录」，不再报「凭据异常」**：桥 503 body 里带
  `credential`（桌面端不可用、插件账号 0 个）时，插件把它认成正常的未登录态，
  概览直接给「未登录 / 去登录 / 登录后显示积分余额」；启动也不再为“没凭据”
  白等 30 秒就绪超时。
- **登录区域自动跟随环境**：面板/控制台不再写死国内版；桥按
  `WORKBUDDY_LOGIN_REGION` → 现有插件账号区域 → 桌面账号域名（`.ai`）给出建议，
  国际版用户不用每次手动切。用户手动选过之后，不再被建议覆盖。
- **登录自动打开浏览器**：面板/控制台/`/workbuddy login` 发起设备码时显式传
  `open:true`，由桥在用户桌面打开授权页（仅接受 https；不走 shell 拼接）。默认
  不打开，脚本/远程环境行为不变。
- **首次安装引导**：桥 503 时按 `credential.desktop.available` / `plugin.count`
  分流提示 —— 没桌面端也没插件账号时，概览直接给「去登录」，并说明不需要安装
  WorkBuddy 桌面端；有桌面端时才提示重新登录桌面端。
- 新增面板场景 5：首次安装（无桌面端/无插件账号）的渲染与「去登录」跳转用例，
  并输出 `docs/plugin-panel-first-run.png`。

### Fixed

- 未登录 / 凭据异常时点「重启桥」不再尝试再起一个实例撞端口；桥的 503 body
  现在带 `pid`，「停止桥」能正常停掉它。操作结果也会说“桥已经在运行，只是还没登录”，
  不再显示成“桥操作失败”。
- 概览在 503 health 没有 `pid` / `uptimeMs` 时不再显示 `pid undefined` / `0 分`。
- 旧桥 503 body 没有 `credential` 段时，保留「桌面端重新登录」的保守修法，并原样
  带出桥侧原因。
- **模型调用更像原生接入**：`resolveModel` 在目录短暂不可用时退回最小元数据，
  不再让已选模型“消失/无法调用”；鉴权失败、模型为空、签到失败的提示不再只让
  用户去开桌面端，改为桌面端或插件登录二选一。
- **登录 / 切号 / 重启桥后广播 `llm/adapters-updated`**：dsh 的模型选择器
  不再等到下次打开才刷新 —— 登录完成就能看到新账号的模型。
- 「实际使用 / 凭据来源」显示为「自动 / 桌面端 / 插件登录」，不再直接显示
  `auto` / `plugin` 内部值。

## [1.8.0] - 2026-10-20

### Added（插件内登录：不装桌面端也能用）

- **OAuth 设备码登录**：桥新增 `/v1/auth/device*`、`/v1/auth/credentials`、`/v1/auth/source`；
  插件面板的「账号」页与控制台的「账号」块提供同一套入口 —— 浏览器完成授权，密码不经过插件。
- **凭据来源**：`auto`（API key → 桌面端 → 插件；桌面端**本地**不可用时才回退）、
  `desktop`、`plugin`、`api-key`。`auto` 是软默认（不锁定，登录成功照常切到插件）；
  `desktop`/`plugin`/`api-key` 才锁定来源。上游 401 不会在请求中途偷偷换号。
  账号页只把**实际生效**的那一行标为「使用中」，另一侧标「已选（未生效）」，不再出现两个"使用中"。
- **加密落盘**：`~/.workbuddy-bridge/credentials` 下 `store.key`（DPAPI 保护）
  + `<hash>.cred`（AES-256-GCM，AAD 绑定 uid）。换机器 / 换 Windows 用户解不开；
  DPAPI 不可用时**自动退回仅内存**，绝不静默写明文。刷新轮换后的 refresh token
  会原子回写（跨进程锁 + 单飞）。
- **插件命令**：`/workbuddy login`（发起 / 再次运行检查）、`/workbuddy logout [uid前缀]`；
  `/workbuddy status` 增加「凭据来源」。
- **同账号识别与互通**：桌面 JWT `sub` 与插件 `uid` 匹配即判定同一账号；同账号在
  账号页**合并成一行**（桌面账号 + 「双凭据」+「用插件凭据」），401/403 时自动接管
  （`WORKBUDDY_CREDENTIAL_FAILOVER=same-account`，默认，钱包不变）；不同账号默认
  不自动切换。`any` 模式可让不同账号也接管（显式 opt-in，会切换账号/钱包）。
- **测试**：设备码端到端（pending → ready、刷新轮换持久化、auto 桌面优先、重启后
  继续使用新令牌、密文不含明文令牌、同账号桌面→插件自动接管）；**把
  `WORKBUDDY_APP_EXECUTABLE` 指向不存在的路径（模拟没装桌面端）也能完成登录并对话**；
  面板/控制台 i18n 与 UI 全绿。
- **配置**：`WORKBUDDY_CREDENTIAL_SOURCE` / `_STORE` / `_DIR`、`WORKBUDDY_LOGIN_REGION`
  （见 `.env.example` 与 `docs/CONFIGURATION.md`）。
- **插件来源身份**：chat/目录请求使用 WorkBuddy 形状的 UA / `X-IDE-*` / Origin
  （参考实现实测），桌面来源保持 CodeBuddy 扩展头；`WORKBUDDY_PLUGIN_IDENTITY=vscode`
  可退回旧头，版本可用 `WORKBUDDY_PLUGIN_APP_VERSION_*` 覆盖。

### Changed

- 桥的凭据读取从“只读桌面端登录文件”扩展为统一来源解析；**桌面端路径行为不变**。
- **账号列表统一**：桌面账号与插件凭据并进同一个列表 —— 同账号合并成一行
  （「双凭据」+「用插件凭据」），桌面端没有的插件账号标「插件」追加在列表末尾；
  插件登录卡片只保留登录/来源控制，不再单独列一份账号。控制台与插件面板一致。
- `/health` 增加 `credential` 段（来源 / 存储模式 / 插件账号数），不含任何令牌。
- 换号或换来源后模型目录自动失效并在后台重取（避免用上一个账号的目录做预校验）。

## [1.7.0] - 2026-10-19

### Fixed（诊断口径：原生插件路由不再误报 —— issue #1）

- **「dsh 模型路由」误报**：诊断库只认 settings.yaml / patch 里的 `llm-pi-ai` 路由，
  而插件的路由是运行时 `registerAdapter()` 注册的，配置里本来就没有那一节 → 功能完全正常
  也会报红。`lib/dsh.mjs` 新增 `detectNativeRoute()`：按 profile 的插件 bundle
  （`dsh-plugin-workbuddy` / `workbuddy-to-dsh`）是否安装、patch 是否 `disabled` 来判定；
  命中即判 ok，并注明「运行时注册，无需 settings.yaml」。控制台页面与插件面板现在同一结论。
- **「凭据引用」误报**：原生路由不经过 `llm-pi-ai`，凭据走插件自己的本地令牌，
  `WORKBUDDY_BRIDGE_KEY` 不是必需的。有原生路由时不再报「缺少占位凭据」，
  与同一页「令牌文件权限」的绿灯不再自相矛盾。
- **控制台总览的「DSH 配置」卡**同步识别原生路由：不再要求 `WORKBUDDY_BRIDGE_KEY`，
  正常状态显示「已就绪」而不是「未就绪」。
- **可选实验 bundle 不再报红**：`@deepseek-ai/dsh-experimental-*` 缺失改为黄色警告，
  并说明「不装不影响基础模型路由」；仍保留真缺失（必需 bundle）的红色结论。
  修复建议也不再直接让人跑 `pnpm add` —— 先提示备份 `package.json` / `pnpm-lock.yaml`
  （对 DSH profile 跑 pnpm 有已知破坏史）。
- 插件面板保留一层按运行时事实的改判，仅用于兼容「控制台进程还是旧代码」的窗口期；
  旧控制台把路由 / 凭据报红时，面板仍会显示真实结论。

### Added（桥：上游 5xx 单次重试）

- 上游网关 / 模型服务短时中断（`500` / `502` / `503` / `504`）时，桥等待 500ms 后
  **原样重发一次**（请求体与头都不重组）。依据是 2026-10-15 的真实故障：当天多数
  5xx 在 1 秒后重发即成功，而桥当时直接把失败甩给客户端，白丢一整轮上下文。
  只重试这四个状态码（501/505 重发也不会变）；`WORKBUDDY_5XX_RETRY=0` 可关闭，
  `WORKBUDDY_5XX_RETRY_DELAY_MS` 可调等待。响应体尚未交给调用方，不存在半流重发。

### Fixed（启动日志与测试稳定性）

- 桥的 listen 回调**先打印监听地址与 `auth file` 路径，再读取凭据**。读凭据要跑客户端
  取 AtRest 密钥，慢盘 / 高负载时可能卡几秒；旧顺序让启动日志看起来像「桥没起来」，
  并行跑整套测试时也会 10 秒等不到 `auth file` 而假红。

### Fixed（面板：非法默认参数不再静默清空）

- 模型详情的「保存为该模型默认」：`temperature` 超出 0–2 或 `max_tokens` 不是正整数时，
  旧实现直接丢掉非法字段后照常保存 —— 若这是该模型唯一一组参数，实际效果是清空默认值，
  界面却显示「已保存」。现在明确提示「未保存：…」并保留草稿。

### Changed（工程）

- `numEnv()` 的桥内联副本补上 `integer` 选项（与 `config.mjs` 同口径），顺带修掉两处
  粘在同一行的声明。
- 新增用例：原生路由判定 / 可选 bundle 健康度 / 5xx 重试与关闭开关 / 501 不重试；
  面板桩补「旧控制台凭据误报」并断言被改判。

## [1.6.2] - 2026-10-18

### Fixed（模型体验：断流伪装成功、显示偏好语义、目录过期、错误可读性）

这一批全部来自「按模型使用链路逐段审计 + 实测」，每条都先加会失败的测试再修：

- **断流被伪装成正常结束（两端各漏一半）**
  - 适配器不认流内 `data: {"error":…}` 帧：这一帧没有 `choices`，旧 `pushLine` 直接忽略，
    于是有内容时 `mapFinishReason(undefined, …)` 返回 `stop` —— 用户看到半截回答、
    dsh 认为成功、不重试。现在识别 error 帧并以 `error` finish 收尾（流中断归 `TRANSPORT`）。
  - 桥的 chat 流式只跟踪 `usage`：上游**干净半关**（有内容、无 `finish_reason`/`[DONE]`）
    时记 `ok:true` 且一个错误信号都不发。现在与非流式路径用同一判据
    （`finish_reason` / `[DONE]` / 工具调用），缺失时补 error 帧并记失败。
- **模型显示偏好**：`visible: []` 同时表示"全显示"与"全隐藏"，所以面板点「全不选」后
  dsh 里反而全部还在，而「恢复全部」又把这份空清单当显式清单、显示"已勾选 0/N"。
  现在拆成三种状态（未设置 / 全隐藏 / 勾选清单），空清单单独落 `hideAll`；
  保存显示设置不再清掉配置里的 `modelDeny`（面板会标出「配置排除」）。
- **刷新目录**：`?refresh=1` 被拼进轮询 path，点一次之后每 120 秒的轮询都绕过 TTL
  真打上游；同一次点击还会发两个请求。现在刷新是一次性 override，轮询 path 不变；
  刷新失败（桥退回旧缓存）会在面板里如实提示，不再看起来像成功。
- **上游目录 401/403**：旧实现当成"这个区域没有这个端点"，FEATURED 补 2-3 个精选模型后
  仍写进 5 分钟缓存（用户以为"模型只剩几个"）。现在与聊天路径一致：`refreshAuth` 后
  重试；一条上游模型都没拿到时保留旧目录，30 秒后再试。
- **模型选择器的信息量**：`listModels` / `resolveModel` 补 `description`
  （上下文 / 输出 / 倍率 / 图片 / 推理），选择器不再只显示名字。
- **错误可读性**：桥的 chat 错误体统一包成 OpenAI 的 `{error:{message,type,code}}`
  （上游 `extError.code` 透出）；上游 401/403 不再原样回 401（那会被误认为本地令牌错），
  改回 502 + `upstream_auth_error`；适配器按错误码补一句"下一步做什么"。
- **思考档位在请求侧按实测表校验**：目录声明了 `reasoning_efforts`，请求侧却从不检查，
  表外值（老客户端三档、curl 传 `off`）必然吃确定性 400。现在命中实测表的模型会剥掉
  表外档位并记日志；不在表里的模型保持原样（没有实测不擅自删参数）。
- **每模型默认参数**：新增 `{temperature, maxTokens, reasoningEffort}` 按 model id 保存
  （面板模型详情里编辑），优先级：调用方显式 > 该模型默认 > 全局默认 > 不发。
  `defaultReasoningEffort` 也从三档放宽到六档（minimal…max）。
- **面板对话测试**：思考强度从当前模型实测的 `efforts` 派生（旧实现写死低/中/高三档，
  6 档模型只能选 3 档、"暂无可选档位"的模型仍能选三档）；展示 `reasoning_content`；
  识别流内 error 帧（半截回答不再显示成"正常结束"）；参数切标签页不再重置，
  换模型时清掉不适用的档位并把超限 `max_tokens` 夹到该模型上限。
- **模型体检**：控制台 502/503 时不再把"没测通"写成"不可用"（旧实现会让「只留可用的」
  把这些模型从选择器里删掉）；中断时保留中止提示、不写库；单次体检补 `finally`，
  失败不会再把按钮永久卡在"测…"。
- **接口失败重试**：面板 4 秒无限重试改为最多 3 次、指数退避（4/8/16 秒），成功清零。
- **`workbuddy_models` 工具**补推理能力与实测档位（与面板 / CSV 口径一致）。
- **空闲看门狗（默认关）**：`streamIdleTimeoutMs` 只对"多久没收到数据"计时，
  不限制总时长；上游卡住不吐字时按 `TIMEOUT` 收尾，而不是永远转圈。

### Fixed（compact 崩溃：适配器缺 `imageRequestPricing` / `imageRequestTarget`）

**用户看到的现象**：压缩上下文（compact）时整条命令失败，报

```
command.execute failed: gateway/internal:
this.adapters.get(...)?.adapter.imageRequestPricing is not a function
```

普通对话完全正常 —— 因为只有 compact 会去重算历史（含图片）的计价。

**根因**：`WorkBuddyAdapter` 是**普通对象**，不继承 dsh 的 `LlmAdapter` 抽象类，于是拿不到
基础类那两个方法的默认实现。而 dsh 的注册表只对**适配器**做可选链、**对方法不做**：

```js
return this.adapters.get(provider)?.adapter.imageRequestPricing(provider, model);
//                                  ^ 只到这里，方法不存在就是 TypeError
```

0.2.1-rc.2 的三处调用点均未加 `?.`。

**`docs/dsh-llm-adapter-contract.md` §6 原本写的是「纯文本端点省略它即可」—— 正是这句把人带沟里了。**
已按运行时事实改写为「必须存在，返回 `undefined` 表示不声明计价」，并补充了
`imageRequestTarget`（同样必填、同样无判空）的说明。

**改法**（各一行，均同步、无 I/O）：

```js
imageRequestPricing() { return undefined }
imageRequestTarget(_p, _m, image) {
  return { width: image.width, height: image.height, maxBytes: image.bytes }  // 原样透传
}
```

`imageRequestTarget` 照抄基础类的默认实现（不预缩放），桥把图片按 `image_url` 原样转发，
语义一致。

**验证**：`dsh-plugin/tests/adapter.test.mjs` 新增「compact 回归」用例，按 dsh 的真实调用式
（对方法不判空）调用这两个方法；**反证**：去掉方法后该用例立刻变红，报错文案与用户截图一致。
全套插件测试 91 项全绿。

## [1.6.1] - 2026-10-17

### Added（环境诊断新增「客户端安装布局体检」—— 两个 WorkBuddy 客户端被装进同一目录会被点名）

**真实案例（2026-10-17，本机）**：WorkBuddy 国内版 5.8.3（`WorkBuddy.exe`）与国际版
WorkBuddy AI 5.8.4（`WorkBuddyAI.exe`）被自动更新装进了同一个目录
`E:\App\WB\WorkBuddy`。两个产品共用同一份 `resources/app.asar`，后装的国际版把前一套
覆盖掉 → 国内版只剩一个"跑错版本"的壳，客户端行为诡异，而界面上完全看不出原因。

**第二层根因（修好一次、下次启动又合并）**：两个产品还**共用更新缓存**
（`%TEMP%\workbuddy-update-x64*`、`%LOCALAPPDATA%\@genieworkbuddy-desktop-updater`）。
旧版更新器留下的安装包没有产品标识校验，客户端恢复缓存时只看版本号 —— 于是国内版会把
缓存里国际版的 5.8.4 安装包当成自己的更新，启动时静默装进当前目录（日志里是
`Restored downloaded update from cache: version=5.8.4.41366630` → `installerPath=…Setup-5.8.4…`）。
症状就是"两个快捷方式打开都是 WorkBuddy AI"。**所以修复必须包含"清掉共用更新缓存"这一步**。

- **环境诊断的「WorkBuddy 客户端」一项现在会检查安装布局**：同一目录里出现两个不同产品的
  exe（国内版 / 国际版 / 旧版 CodeBuddy）→ 判 `fail`，detail 给出目录与后果，
  hint 给出修法（分别重装到两个目录 + 清掉共用更新缓存；卸载重装不丢账号）+ 文档指路。
  **不能靠目录名猜**（那次目录名完全正常），判据是「同目录多产品」；纯函数
  `inspectClientInstalls()` 抽出来直接单测。
- **`tools/doctor.mjs` 同享结论**（它调用的就是同一个 `diagnose()`），两处口径一致。
- 控制台与 dsh 面板的 i18n 都补了这条文案（detail 是带路径的拼接串 → 走规则；hint 是整段
  → 走词条表）；面板 i18n 验收**主动注入**这一条 —— 真实机器不撞到就永远扫不到它的翻译。
- **文档**：`docs/TROUBLESHOOTING.md` 新增「两个客户端被装进同一目录（国内版 + 国际版"合并"了）」
  —— 症状、两层根因（更新器跑完整安装包 + 目标目录记忆；共用更新缓存导致反复合并）、
  六步修法（先清共用更新缓存，再分别静默装到两个目录；含 NSIS `/S /D=`、
  `WORKBUDDY_APP_EXECUTABLE` 兜底、以及"启动后看更新日志域名对不对"的复验法）、
  以及客户端自己的 `installer.log` 在哪看。
  README / dashboard README / 插件 README 的「环境诊断」描述同步（去掉过时的"8 项"字样）。

**验证**：`lib/diagnostics.install.test.mjs` 4 条（找不到 / 同目录两个产品 / 两个独立目录 /
单套安装）+ `lib/find-workbuddy.test.mjs` 新增 5 条布局判据（大小写、去重、旧版 CodeBuddy、
无关 exe）；`panel:check` 双语无残留；控制台与面板的"合并"文案在中文 + 英文下都实测渲染
（detail 规则 / hint 词条都翻）。
**真机复验（本机）**：清掉共用更新缓存 → 两个客户端分别重装到 `E:\App\WB\CN`（5.8.3）与
`E:\App\WB\AI`（5.8.4）→ 各启动一次：国内版查 `www.workbuddy.cn`（version=5.8.3）、
国际版查 `www.workbuddy.ai`（version=5.8.4），都回 `No update available`；
目录里没再出现对方的 exe，诊断项回到 `ok`、账号/桥/AtRest 密钥全部正常。

## [1.6.0] - 2026-10-17

### Fixed（同一个账号只显示一行 —— 不会再看到"两个一样的账号"；顺手修掉拖拽抓不住 / 卡片布局乱）

**用户反馈**（原话）：*"那个账号被多次记录的bug彻底修复不要让我看到两个一样的账号出现"*，
并明确否掉了"折叠 + 点开抽屉"的方案：**既然能识别出是同一个号，就直接只显示一个账号。**

- **根因**：WorkBuddy 客户端每次「登出」会把旧的登录文件改名成快照留在登录目录里，
  同一个 uin 常有两三份 `.info`；控制台/面板按**文件**列行，于是显示成两三行 ——
  看着就像"账号被记重了"。
- **修法（列表层合并，一个账号一行）**：`listAccounts()` 按 uin（读不出时退 `userId`、
  再退文件名）分组，每组只回**一个代表行**；代表行按 **生效中 > 可用 > 最近 > 文件名** 挑
  —— 坏掉的老快照（换客户端 build 后本机密钥解不开）不会占第一行，免得让人以为这个号废了。
  **登录目录里的文件一个都不动**（`docs/SECURITY.md` 的硬约束），切换仍按文件走。
- **前端也兜一道**：`lib/` 的改动要**重启控制台**才进内存，而 `dashboard/public/` 刷新即生效
  —— 控制台与面板各自再按同一个键去一次重（保留规则与上面一致）。这样旧控制台还在跑时，
  刷新后的界面也不会出现重复账号。
- **隐藏改成"整账号"语义**：`.state.json` 仍按登录文件名记，但 `/api/account/hidden`
  会把该账号名下的**全部文件**一起隐藏/恢复 —— 只写代表行的话，另一份快照仍算可见，
  整行就藏不住。

**同一提交里修掉的两处实拍缺陷**：

- **拖拽全程静默失效**：面板里用 `useState` 存"当前被拖的是哪个文件"，React 18 的批处理让
  `onDragOver` 读到**初始值** `''` → 判定"没东西在拖" → 直接 return。改用 `useRef` 立即写立即读。
  > 教训：**"写在 A 节点、读在 B 节点"的状态（拖拽项、落点）必须用 ref / 模块级变量，不能用 state。**
- **账号卡片布局乱、390px 横向溢出 21px**：一行塞了状态 + 改名 + 切换 + ↑↓ + 隐藏 5 个控件 +
  拖拽手柄，窄屏互相挤、按钮折行位置随机。重排成 **head / sub / toolbar 三段**（与用量、
  请求面板同一套），次要操作独占一行右对齐。

**验证**：

- 新增 `lib/diagnostics.fold.test.mjs`（9 条）：合并成一行、代表行挑选三档优先级、
  `sameAccount` 计数、隐藏的整行语义、键兜底、自定义顺序按组生效。
- `tools/dev/test-account-order.mjs` 扩到 30 条：**旧服务端仍回两行时界面也只渲染一行**、
  留下"更该被看到"的那份（含 `active` 优先）、合并后的整表顺序里不出现同账号两行、
  排序 / 拖拽 / 隐藏 / 恢复、英文无残留中文。**反向验证**：把前端兜底去掉 → 4 条红；
  把代表行挑选里的 `active` 去掉 → 单测红。断言都有牙齿。
- `panel-render` 窄列场景用「3 个登录文件 / 2 个账号」的夹具断言只渲染 2 行、
  同一个 uin 只出现一次、**没有折叠 / 展开开关**；截图重出。
- `release:check` / `check:i18n` / `panel:check` 全绿；控制台 37 个 UI 用例全过。

### Added（账号列表可自定义排序、可隐藏 —— 两边同步，鼠标键盘都有路）

**用户反馈**：*"加个可以自定义排序和删除账号的功能"*，并指出 *"已知bug是有的账号重复记录"*。

- **排序**：**上移 / 下移**按钮 + **拖动**（握每行最左的 `⋮⋮` 手柄；落点看指针在目标行的
  上/下半 → 插到它前/后）。两条路都保留：拖拽满足鼠标，按钮满足键盘与读屏。
  提交的是**整个顺序数组**，不是"把 A 挪到 B 前面" —— 两边手里都是同一份列表，
  直接给结果才不会各算一套插入规则对不上。`.state.json` 新增 `accountOrder`（按登录文件名记；
  同一账号的多份快照已合并成一行，组的顺序按组内任意一份文件的 rank 算）。
- **隐藏**：把账号从默认列表排掉（`.state.json` 的 `hiddenAccounts`），勾「显示已隐藏」可见、
  随时可恢复；**当前生效中的那个不能隐藏**（它正被桥读着，服务端也会拒）。
- ⚠️ **没有做"删文件"**：那份 `.info` 是 WorkBuddy 客户端自己的登录态，本项目只是它的读者
  （`docs/SECURITY.md` 的硬约束）—— 删掉等于把用户的客户端登出，不可逆，不该由一个
  "整理列表"的按钮触发。真要删请到 WorkBuddy 自己的登录目录里删。
- **"有的账号重复记录"**：同一个账号的多份登录文件已合并成一行（见上面的 Fixed 段）；
  **没有任何折叠 / 展开的交互**，列表里就是"一个账号一行"。

控制台与 dsh 插件面板**同步实现**（排序/隐藏是两边都承载得了的通用功能；
`/account/order`、`/account/hidden` 已进 `consoleApi.mjs` 白名单）。

**验证**：新增 `tools/dev/test-account-order.mjs`（排序 / 隐藏的断言：整表顺序契约、
落点上半/下半、拖到自己身上不发请求、隐藏请求体、隐藏后行立刻不见 + 计数徽标、恢复、
合并后排序只含"每账号一行"、英文无残留中文）。**反向验证**：只提交第一个文件名 / 落点恒为"之后" / 给生效行渲染隐藏按钮
—— 各自报且只报一条红。`lib/state.test.mjs` 补 3 条（顺序去重、隐藏/恢复、坏数据兜底）。
### Added（账号自定义名字：多账号终于能分清谁是谁）

**用户反馈**：*"帮我加个账号自定义名字不然很难分清。"*

登录目录里几个账号的显示名都是 uin（`330126184144` 这种十几位数字），谁是谁全靠猜；
同一账号还常有多份快照，列表里更像一串重复项。现在可以给账号起名字（「工作号 / 个人号」）：

- **控制台**：账号卡片上多了「改名」（自绘输入框：Enter 保存 / Esc 取消 / 留空 = 恢复默认）。
  起了名字后**名字当主标题、uin 挪到副行**；**没起名字时渲染逐字不变**（旧截图与旧用例不受影响）。
- **dsh 设置页**：账号页同样显示名字，并且**可就地改名**（输入框 + 保存/取消）。
  写操作照旧走控制台（`/workbuddy/console-api/account/alias`，白名单新增这一条）——
  `.state.json` 有且只有一个写者，插件自己写会让控制台那份带进程内缓存的副本过期。
- **存储**：`.state.json` 的 `accountAliases`，`{ 账号标识: 名字 }`。键取 **uin**
  （读不出时退 `claims.sub`、再退登录文件名），**不是文件名** —— 客户端换账号会把
  **同名**登录文件原地覆盖（只有「登出」那条路才备份，见 `docs/TROUBLESHOOTING.md`），
  按文件名记名字会在换号后贴到另一个账号上。全删光时整个键被移除，不留一个 `{}`；
  空白折叠 + 截断 24 字。
- 名字**只影响显示**：不碰任何凭据文件，也不改变桥用哪个账号。

**验证**：新增 `tools/dev/test-account-alias.mjs`（24 条断言）—— 显示、请求体、取消零请求、
**按钮顺序契约**（harness 自动接管自绘弹窗时 `b[0]` 当取消、`b[last]` 当确定，顺序反了
不会报错、只会让所有依赖自动接管的用例**静默点错按钮**）、英文模式无残留中文。
**反向验证**：分别去掉 alias 显示、把请求体里的 `file` 换成 uin，各报且只报一条红。

**顺带**：重捕 `tools/dev/api-shape.json`（`/api/accounts` 多出 `alias`/`aliasKey`，
`/api/overview` 的 `credentials.active` 多出 `alias`；无键消失）；面板窄列截图的账号夹具
里加了一个带名字的账号，顺带让「窄列下账号卡片不溢出」那条守卫覆盖到新增的「改名」按钮。

## [1.5.0] - 2026-10-16

### Docs（README 首屏新增「DSH 用户：一个插件装下全部能力」——把 dsh 接入场景的能力清单提到最前）

README 在关键词表之后、免责声明之前新增能力总览表（零配置接入 / 原生模型路由 / 模型管理 /
账号切换 / 积分与用量 / 请求明细 / 环境诊断 / 对话测试 / 每日签到 / 三套协议 / 中英双语），
并附一条命令的安装示例与 `docs/INSTALL.md` 指路；关键词表补上「在 DSH 里用 WorkBuddy」
等检索词。README.en.md 同步补一段 DSH 用户摘要，`dsh-plugin/README.md` 增加「能力一览」
速览。只动文档，没有代码与行为变化。

### Fixed（读不了图：插件把附件引用拆开传，dsh 每次读图都抛错后被静默吞掉）

**用户看到的现象**：在 dsh 里发图片，模型像没看见一样 —— 要么答非所问，
要么直接说看不到图。**全程不报错**，界面上也没有任何异常。

**根因**（从 dsh 的 asar 里核出的权威契约，不是猜的）：
dsh 的 `ImageAttachmentRef` 是

```ts
interface ImageAttachmentRef {
  attachmentId: string; mediaType: ImageMediaType;
  bytes: number; width: number; height: number;   // ← 必填
  name?: string;
}
```

而 `readImage(ref)` 内部会用它做**元数据核对**：

```js
const metadata = await probeImage(data);
if (metadata.mediaType !== ref.mediaType || data.byteLength !== ref.bytes
 || metadata.width !== ref.width || metadata.height !== ref.height)
  throw new AttachmentError('...', 'ATTACHMENT_CORRUPT');
```

插件却把完整 ref **拆成两个字段**再传：

```js
attachments.readImage({ attachmentId: ref.attachmentId, mediaType: ref.mediaType })
```

→ `ref.bytes / width / height` 全变 `undefined` → 核对必然失败 →
抛 `ATTACHMENT_CORRUPT` → 被 `.catch(() => null)` 吞掉 →
adapter 把图替换成文字占位 `[图片：无法读取该附件]` → **模型看不到图**。

**改法**：把 ref **原样**传下去（它本来就是那个接口要的形状）。
顺带修两处让问题更难查的地方：

- `stored.mediaType` 不存在（返回值是 `{ ref, data }`）→ 改读 `stored.ref.mediaType`；
- 失败**不再静默**：原先一律 `return null`，日志里一个字都没有；
  现在把失败原因打出来（只打错误信息，不含图片内容）。

**同族的第二个洞（助手历史里的图被整条丢掉）**：修完 user 侧后复测发现，
助手消息带图时有两处会把它弄丢：

1. `toWireMessage` 的 assistant 分支只处理 `text` 与 `tool-call`，
   `image` 块被静默丢弃；
2. 更隐蔽：`sanitizeWire` 判"这条助手轮有没有内容"时只认
   `typeof content === 'string'`。带图的助手消息 content 是**数组**，
   于是被判成"空助手轮"→ **整条消息（连文字一起）被删掉**。
   实测表现：助手轮从历史里直接消失，模型"忘了自己刚说过什么"。

**验证**（每一层都单独证明，最后串起来打真上游）：

| 层次 | 证据 |
|---|---|
| 桥 + 上游能读图吗 | 64×64 纯红图 → 模型答 `"红色"`，prompt 15→205 tokens |
| 拆 ref 是否必然失败 | 复刻 dsh 核对逻辑 → 抛 `ATTACHMENT_CORRUPT`，图变文字占位 |
| 真实 `apply()` 修后行为 | `readImage` 收到**完整** ref（`bytes:73,width:4,height:4`），payload 里出现 `image_url` |
| 助手历史 | 修前助手轮**整条消失**；修后 `[text, IMAGE]` 都在 |
| **全链路** | 真实 apply → 真实桥 → 真实上游：8×8 纯蓝图 → 模型答 `"蓝色"` ✅ |

新增 2 条回归用例（`plugin.test.mjs` 一条走真实 `apply()`、`adapter.test.mjs`
一条盯 wire 形态），都做了**反证**：把代码改回旧写法，用例立刻变红。

**另**：`inject` 声明无需改动 —— `ctx.get('attachments')` 是 dsh 自己的惯用写法
（asar 里 4 处在用），不是"没声明就取不到"。

### Fixed（测试在写坏使用者的真实账本 —— 每跑一次挤掉几十行用量历史）

**现象**：`bridge/usage.jsonl`（使用者的真实账本）里 57% 是测试记录 ——
914 条 `resolved-default` + 58 条 `resolved-fast` + 14 条 `stub-model`，
模型名一眼可辨、`ms` 恒为 0-1ms、token 数固定。

**根因**：`usageFile()` 解析的是 `WORKBUDDY_USAGE_FILE`，否则退回
**桥脚本所在目录**（`dirname(fileURLToPath(import.meta.url))`）下的 `usage.jsonl`
—— 也就是仓库里那份真实账本，**与 `cwd` 无关**。测试里惯用的
`cwd: <临时目录>` 根本挡不住。

而账本涨到 `MAX_USAGE_LINES`(2000) 会**截断保留最近一半** ——
所以每跑一次测试都在把用户自己的用量历史往外挤。
`bridge.test.mjs` / `bridge-startup.test.mjs` 早就设了这一项，
`bridge-responses.test.mjs` 与 `bridge-cors.test.mjs` 是漏的。

**实测**：跑一次 `bridge-responses.test.mjs`（32 用例）就往真实账本写进 **36 行**。

**改法**：两处补上 `WORKBUDDY_USAGE_FILE: join(dir, 'usage.jsonl')`。
并加了源码级守卫用例（照 `numEnv` 那条的思路扫源码，能覆盖**未来**新增的测试文件）：
凡是 `spawn(process.execPath` 起桥的文件都必须有该赋值。

实测修后：跑全套 4 个文件 **0 字节增量**。
反证也做了 —— 把赋值删掉、注释留着时守卫**变红**
（第一版守卫只搜 `WORKBUDDY_USAGE_FILE` 这个字符串，会被注释骗过、测不出东西，
已改成要求真正的赋值形状 `WORKBUDDY_USAGE_FILE\s*[:=]`）。

### Feat（账本记下提示缓存命中量 —— 一处 26 倍的隐藏成本）

提示缓存是这条链路上**最大的单因素**，但原先在账本里**完全不可见**。

实测同一批 `promptTokens >= 40k` 的请求（93 条）：

| | 条数 | 平均 credit / 1k tokens | 合计 |
|---|---|---|---|
| 未命中缓存 | 6 | **0.0142** | **10.00 积分** |
| 已命中缓存 | 87 | 0.0005 | 10.20 积分 |

**6 条未命中就花掉 10 个积分**，与 87 条命中的花费相当 —— 单价差 **26 倍**。
延迟侧的差同理：实测冷缓存 TTFT 14.8s → 命中后 5.9s（2.5 倍）。

账本现在带 `cachedTokens` / `cacheMissTokens`，控制台能把"贵且慢"的那几条标出来。

口径要点（已钉进用例）：
- 上游对同一件事给多个别名，且常与**恒 0 的占位**并存
  （实测 `prompt_tokens_details.cached_tokens` 与顶层 `cached_tokens`、
  `prompt_cache_hit_tokens` 同时存在）→ 取**最大值**，不是 `??` 链；
- 上游**没报**时不写 0 —— "没报"与"确实未命中"是两件事，
  混起来会把命中率统计系统性压低。

### 调查记录（结论：不改代码）

两个看似可优化、实测**无收益**的方向，记下来免得后人重做：

1. **给 tools 按名字稳定排序**（想救提示缓存）。实测只把工具**顺序**颠倒，
   命中率从 99.7% 掉到 0.6% —— 看起来该排序。但扫真实日志的 98 条
   `names=[…]`：**8 种工具集合、0 个"同集合不同顺序"** ——
   顺序差异全部来自集合本身变化（工具增删），而集合变了缓存本来就该失效。
   排序收益为 0，故**不做**（避免为想象中的问题加代码）。
2. **桥自身的处理开销**。用 `X-WorkBuddy-Overhead-Ms` 口径实测：
   328k tokens / 606KB payload 下 `overhead` 仍只有 1-3ms
   （纯 `JSON.stringify` 同尺寸 payload = 2.6ms）。这条链路不需要优化。

### Fixed（接入速度：确定性 400 白等 40 秒 + 瞬时 DNS 抖动直接 500）

**用户看到的现象**：问一句，**卡 40 秒**，然后报错。不是偶发 —— 日志取证
（`bridge/bridge.log`，2026-10-12）显示 467 条 `transient 400 (11133), retry N`
聚成 117 簇，其中 **109 簇跑满 4 档退避**，最后**仍然**落 `upstream error 400`。

**根因**：`code 11133` 只是网关的**包装码**，真因在响应体的 `extError.code` 里。
桥原先对所有 11133 一视同仁地跑 `TRANSIENT_400_DELAYS`（1s+4s+10s+25s = 40 秒），
而实测这一族里 **122/122 全是确定性的**
（`model_param_invalid` 116 + `invalid_reasoning_effort` 6）——
参数被模型提供方拒了，同样的参数原样重发一万次也不会变。
纯等待累计 **2460 秒（41 分钟）**，平均每簇白等 **37.3 秒**。

**改法**：按 `extError.code` 分流。
- **确定性**（`model_param_invalid` / `invalid_reasoning_effort` / `invalid_request_error`
  / `model_not_found` / `context_length_exceeded` …）→ **立刻**返回，不退避；
- **认不出来**的 → 仍按原退避表重试（保守：不认识的不擅自放弃）；
- `WORKBUDDY_TRANSIENT_400_RETRY=0` → 连瞬时的也不重试（速度绝对优先的出口）；
- `WORKBUDDY_TRANSIENT_400_DELAYS` 可覆盖退避表（主要给测试用，让"仍会重试"
  这条路径能在毫秒级被验证，而不是真等 40 秒）。

**实测对比**（同一条确定性 400 请求，打桩上游）：

| | 修前 | 修后 |
|---|---|---|
| 桥返回耗时 | **40.07 s** | **0.02 s** |
| 打到上游的次数 | 6 | 1 |

### Fixed（瞬时 DNS 抖动被当成硬故障，直接 500）

**用户看到的现象**：`本地桥连接失败：... getaddrinfo ENOTFOUND www.workbuddy.ai`。

**根因**：账本里 20 条 ENOTFOUND，其中 **17 条挤在同一个小时** —— 典型的解析器抖动
（VPN/代理切换、DNS 缓存过期），不是域名不存在：同一台机器随后连测 12 次解析
全部成功、中位 0.2ms。而桥的重试只认 `ECONNRESET|socket hang up|EPIPE`
（keep-alive 复用被掐），对 DNS 这一族**一次都不重试**。

**改法**：把 `ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNREFUSED|EADDRNOTAVAIL|getaddrinfo`
一并纳入瞬时重试，重试前隔 `WORKBUDDY_TRANSPORT_RETRY_MS`（默认 250ms，只在失败
路径上花这个时间）—— 立刻重查很可能撞上同一个坏状态。

### Fixed（测试脆弱性：账本用例会因并发流量误报）

`桥：账本是本地文件，且不写使用者的那份` 原先断言"仓库账本字节数前后相等"。
但那份账本属于**正在运行的真实桥**：本机跑用例时任何并发请求（控制台轮询、
另一个终端里的对话、实测脚本）都会追加一行，于是它**误报**成"测试改到了使用者
的账本"（实测报 `223443 !== 222905`，差的 538 字节正好是一条真实请求的账本行）。
改用对**本用例动作**真正敏感、且对并发追加免疫的判据：DELETE 会把文件**清空**
（"非空→空"是它造成的铁证），而追加**永远不会改首行** —— 所以拿首行当指纹。
已反证：故意让测试桥写仓库账本时，用例照旧变红。

### Fixed（Codex 接入：截图把上下文烧穿导致整轮崩掉 —— 单图 18 万 tokens 降到 1 千）

**用户看到的现象**：Codex 里用 computer-use / 截图时，**干到一半整个回合突然崩掉**，
界面上是 `stream disconnected before completion: prompt is too long: 1252936 tokens > 1048576 maximum`，
前面已经说了半句话（"我先把窗口激活…"），然后卡死约 4 分钟后失败。

**不是偶发**：扫近 3 天 14 个 rollout，**两次**撞上同一个崩溃，且第二次更极端 ——

| rollout | 图片 | base64 字符 | Codex 自报 input | 上游实际 | 倍差 |
|---|---|---|---|---|---|
| 10-13 15:58 | 4 张 | 685,540 | 585,007 | 1,252,936 | 2.1× |
| **10-12 21:11** | **1 张** | **1,539,602** | **14,705** | **1,216,490** | **82.7×** |

10-12 那次**单张图**就把上下文烧穿了：Codex 认为才用了 14,705 tokens
（离压缩线 90 万差得远），上游却收到 1,216,490 —— **差 82.7 倍**，
`last_agent_message: null`（连半句话都没说出口就整轮崩了）。

**根因**（2026-10-13 用真实 rollout + 桥日志 + 真实网关三路对账，不是猜的）：

1. **工具输出里的图片被降级成了纯文本。** Codex 把截图回在
   `function_call_output.output` 的 `{type:"input_image", image_url:"data:image/jpeg;base64,…"}`
   块里；桥的 `responsesOutputText()` 对没有 `text` 字段的块走 `JSON.stringify(p)`
   → **整段 26 万字符的 base64 变成 `role:"tool"` 消息里的纯文本**。
   真实网关实测同一张图：走视觉通道 **987** tokens，降级成文本 **184,718** tokens
   （**187 倍**）；该会话 4 张图复刻：视觉通道 7,668 vs 降级 476,483（**62 倍**）。
2. **于是账实不符，压缩线形同虚设。** Codex 按视觉通道的 ~1K 记帐，上游按 18 万记帐 ——
   Codex 认为只用了 58.5 万（压缩线 90 万），上游实际已收到 125.3 万 → 直接 400 拒绝。
   桥账本与 Codex rollout 的 `input_tokens` **逐条完全一致**，证明不是记错账，
   而是**送出去的东西和记的东西不是一回事**。
3. **顺带暴露两处相关缺陷**：
   - 上游超限原文是 `prompt is too long: N tokens > M maximum`，而桥的
     `responsesErrorCode()` 正则**认不出来**（只认 `context length` / `too many tokens` /
     `maximum context`）→ 落到兜底 `upstream_error` → Codex 归到 `Retryable` →
     **原样重发 6 次、白烧 249 秒**才失败（bridge.log 08:50:33→08:52:16 连 6 条同样的 400）。
   - **上游在流中途断掉时，桥仍发 `response.completed` + `end_turn:true`** →
     Codex 以为回合正常结束 → 用户看到"说话说一半突然停下"，不报错也不重试。

**改法**：

- 桥新增 `responsesOutputContent()`：`function_call_output` 的 `content` 保留**内容块数组**
  （`[{type:'text'},{type:'image_url'}]`），实测上游认这条路并走视觉计费；
  只有纯文本时才降成字符串（保持既有形状）。`file_id` 引用式图片仍换成一句明确说明，不静默丢。
- 新增 `responsesOutputText()`（薄包装）供**必须**是字符串的字段用（`custom_tool_call.input`），
  那些地方图片降级成占位文本 —— 不再有"把 26 万字符塞进字符串参数"的灾难。
- `responsesErrorCode()` 补上真实措辞：`…too long` / `exceeds the maximum` / `maximum (number of) tokens`
  → 命中 `context_length_exceeded`，Codex 立刻走 `ContextWindowExceeded` 而不再白重试。
- `relayResponsesStream()`：`streamError` 非空时改发 **`response.failed`**（带 error 与已收到的半截 output），
  不再伪装成成功收尾。
- Anthropic 路径同源的坑一并修：`anthropicToolResultText()` 原来**只挑 `type:"text"` 的块**，
  `tool_result` 里的图片被**静默丢掉**（Claude Code 的截图工具就是这么回的）→
  改成 `anthropicToolResultContent()` 保留 image 块。
- **请求日志新增 `dropped=` 字段**：把「被丢掉、没转发给上游」的工具名打出来。
  原先只记**翻译后**的 `tools=N names=[…]`，两者必然自洽 —— 于是"某个工具被静默丢掉"
  在日志里**完全看不出来**，`apply_patch` 与 `tool_search` 两次翻车都栽在这个盲区上。

**用例**：桥 +6（图片走视觉通道 / 纯文本仍降成字符串 / `prompt is too long` 认出来 /
流中途断开必须发 failed / Anthropic tool_result 保留图片 / dropped 可见且不误报），
lib +1（`supports_search_tool` 声明与提示词），**每一条都做过突变验证
（撤掉对应修复即红、还原即绿）**。`release:check` 全绿（vendor 同步 + 类型 + lint +
lib 128 + bridge 85 + plugin 84 + 独立分发演练）。

**真机验证**（2026-10-13 18:2x，真 `codex.exe` + 真桥 + 真上游）：

- 走 **Codex 真实路径 `/v1/responses`** 发带图的工具输出：`prompt_tokens=1281`（视觉量级），
  不再是 18 万 —— 日志 `[responses] … msgs=4 tools=1 names=[js]`。
- 真机触发上游超限（2.6M 字符随机文本）：上游回
  `prompt is too long: 1257825 tokens > 1048576 maximum`，桥**正确映射成
  `context_length_exceeded`**。
- `codex exec` 端到端：`provider: workbuddy` / `model: deepseek-v4.1-flash` 正常出话；
  `apply_patch`（freeform）真机落盘成功（日志 `freeform=apply_patch`），无 `incompatible payload`。

**新增探针**（`tools/dev/`，都不花额度或只花极少）：
`probe-codex-tool-image-cost.mjs`（单图两种通道的真实代价）、
`probe-codex-image-crash-repro.mjs`（用会话真图复刻崩溃）、
`probe-codex-responses-image.mjs`（走真实 Responses 路径验证视觉通道）、
`probe-codex-ctxlen-mapping.mjs`（超限错误码映射）、
`probe-codex-rollout-analyze.mjs`（rollout 取证）。

> **一并纠正一条先前的猜测**：曾怀疑"目录把 `context_window` 声明成 100 万导致 Codex 不压缩"。
> 核对官方源码（tag `rust-v0.162.0-alpha.17.2`，与本机版本精确对应）后**这条不成立**：
> 压缩有两条线取先到 —— `auto_compact_token_limit`（缺省 = `context_window × 9/10` = **900,000**）
> 与 `effective_context_window_percent`（95% = 950,000）。**900,000 < 上游硬上限 1,048,576，是安全的。**
> 崩溃的唯一原因是账实不符（图片通道），**本轮不动窗口与压缩字段**。
> 详见 [`docs/CODEX-COMPACT-FIELDS.md`](docs/CODEX-COMPACT-FIELDS.md)。
>
> **另一条排查出来但不成立的**：日志里出现 `dropped=web_search`，一度按"目录声明了
> 桥做不到的能力"去改 `supports_search_tool`。三次对照实验（真 `codex.exe` + 临时
> `CODEX_HOME`）证明**改目录关不掉它** —— `web_search` 是 Codex 的内置工具，
> `web_search_mode = "disabled"` 与 `[tools] web_search = false` 也都不生效。
> 而它**实际无害**：桥补充说明已明写"web search 不存在、别调用"，真机实测模型会正确
> 回答 `NO_WEB_SEARCH` 而不是去撞它。所以保留 `supports_search_tool: false`（事实陈述）
> 并让桥侧照旧丢掉 + 记日志，**不再当成缺陷**。探针见
> `tools/dev/probe-codex-websearch-source.mjs`。

### Fixed（Codex 接入：freeform 工具 `apply_patch` 全链路打通 + 系统提示不再一代代退化）

**用户看到的现象**：Codex 里做长任务时"跑一半就断了" —— 模型说一句"我来验证一下"这一轮就结束
（rollout 里是 `task_complete` + `model_needs_follow_up=false`，output token 极少），用户以为掉线；
同时 `apply_patch` 全程不可用，模型反复试、反复被拒，只能退化成 shell here-string 写文件。

**根因**（2026-10-13 用真实 `codex.exe` 抓包 + 桩上游对照实验逐条确认，不是猜的）：

1. **freeform 工具被静默丢掉**：Codex 把 `apply_patch` 声明成 `type:"custom"`（lark 语法的
   freeform 工具；本机 0.162 **只认** `apply_patch_tool_type:"freeform"`，写别的值直接
   `unknown variant` 起不来，不写则完全不提供该工具）。桥的请求侧原先只翻 `function` 类型，
   于是"系统提示让用 apply_patch、工具表里却没有它"——模型靠提示蒙调用，Codex 的工具路由器
   再判 `tool apply_patch invoked with incompatible payload`，整轮白烧。
2. **回包项类型**：freeform 调用在 Responses 里的项类型是 `custom_tool_call`（正文放 `input`），
   配 `response.custom_tool_call_input.delta/.done`；发成 `function_call` 客户端不收。
3. **生成物过期 + 模板退化**：`model_messages.instructions_template` **就是** Codex 的全量系统
   提示（抓包：请求里没有 `instructions` 字段，`input[0]` 那条 developer 消息逐字等于模板）。
   上一版把它整段替换成 5 行中性文案，而"模板来源"又常常是**我们自己写过的条目** —— 刷新一次
   就把官方提示永久换掉了；用户机器上那份目录还停在 Oct-10（17KB 官方提示 + 10000 截断上限）。

**改法**：

- 桥：请求侧把 `custom` 工具翻成上游认的函数（唯一必需的 `input` 字符串参数；并就地改写
  模板里"do not wrap the patch in JSON"那句与函数接口打架的说明）；回包侧按 `custom_tool_call`
  回（流式 / 非流式同形）；历史里的 `custom_tool_call` / `custom_tool_call_output` 双向映射成
  `assistant.tool_calls` / `role:"tool"`。请求日志多一栏 `freeform=…`（排查按它找）。
- 目录生成：系统提示改成「**来源模板原样保留 + 末尾追加桥补充说明**」（工具集边界 /
  freeform 的 `input` 参数 / 回合纪律："宣布要做的事必须同一回合发工具调用"）；补充说明带哨兵
  行、**幂等**（先剥旧再追加）；模板优先级改为「别人的 > 官方 `models_cache.json` >
  我们自己的条目」，不让自己的成品当模板。
- 新增真机探针 `tools/dev/probe-codex-custom-tool.mjs`（真 `codex.exe` + 真桥 + 桩上游，
  **不花额度**）：9 条断言覆盖请求翻译 / 历史双向映射 / 客户端**真的执行**了补丁 / 无
  `incompatible payload`。
- 用例：桥 +3（流式形状 / 请求翻译+历史 / 非流式形状，撤掉修复即红）、lib +2（补充说明幂等 /
  模板优先级，撤掉修复即红）。`release:check` 全绿（lib 127、bridge 73、plugin 84）。
- 本机已重新生成 `~/.codex/workbuddy-model-catalog.json` 并重启桥与控制台，真机复跑确认：
  日志 `freeform=apply_patch`、rollout 里有 `custom_tool_call` + `custom_tool_call_output`、
  补丁真的落盘。

> 相邻但不在接管范围的一件事：`config.toml` 顶层的 `model_reasoning_effort` 是用户手写的，
> 目录里已不声明 `ultra`，需要用户自己决定改不改（不改也不报错，只是语义与 Codex 官方不同）。

### Fixed（Codex 接入：computer-use（操控桌面）走桥不可达 —— `tool_search` 与 MCP 工具被静默丢弃）

**用户看到的现象**：Codex 接桥后，它自带的 computer-use（`computer-use@openai-bundled` 插件）
完全用不上 —— 模型"说要用但用不上"，而且**全程不报错**。2026-10-12 的诊断
（`docs/CODEX-NATIVE-PLUGINS-2026-10-12.md` §3.3）曾把原因归为「桥不转发 freeform 工具」，
本次查明**那个归因不成立**，真正的原因在别处（详见 `docs/COMPUTER-USE-2026-10-13.md`）。

**根因**（全部有实测证据）：

1. **MCP 工具是「延迟下发」的，而桥把唯一的入口丢了。** Codex 不把 MCP server 的工具放进
   `tools[]`，只给一个 `type:"tool_search"` 的检索工具；模型检索之后，命中结果才以
   `tool_search_output`（`{type:"namespace", name:"mcp__node_repl", tools:[…]}`）的形式出现在
   **下一轮请求的 `input[]`** 里。桥原先把 `tool_search` 与 `web_search` 一起在
   `responsesToolsToOpenAI` 里**静默丢弃**、把 `input[]` 里的 `tool_search_output` 与
   `reasoning` 一起**静默丢弃** → 模型永远发现不了 `mcp__node_repl.js`
   （computer-use 的唯一入口：在里面 `await import("@oai/sky")`）。
2. **修正一个旧结论**：`mcp__node_repl.js` **不是** freeform/`custom` 工具 —— 它是带
   `{code, title, timeout_ms}` 参数的普通 MCP 工具。本机 2026-08-09 那次真正跑通
   computer-use 的会话里，**135/135** 条调用都是 `name:"js"` + `namespace:"mcp__node_repl"`
   （短名 + 独立的 namespace 字段）。所以「freeform 不转发」从来不是它走不通的原因；
   同日那份 freeform 修复（上一条）是另一个独立问题。
3. 顺带修掉同类的**第三处静默丢弃**：`tools[]` 里的 `type:"namespace"` 分组
   （Codex 的 multi-agent / `collaboration` 用这个形状）原先**整组**被丢。

**改法**（桥的 Responses 层：一张路由表贯通两侧）：

- 请求侧：`tool_search` 翻成同名普通函数；`namespace` 分组的内层拍平成
  `mcp__<server>__<tool>`；`tool_search_output` 里的工具**补进上游 `tools[]`**（去重）。
- 回包侧：模型调 `tool_search` → 回 `tool_search_call`（`execution:"client"`，
  `arguments` 是**对象**而不是 JSON 字符串）；模型调分组工具 → 回**短名 + 独立
  `namespace` 字段**。历史回灌同样双向还原；`tool_search_output` 转成一条工具结果消息，
  把"检索命中了哪些工具"讲清楚（只列名字不抄描述，那些描述紧接着随 `tools[]` 发过去）。
- 请求日志从只记**个数**改为也记**工具名**（`names=[…]`）—— 这次缺陷在日志里完全不可见，
  就是因为只看 `tools=10` 根本看不出少了什么。
- `lib/client-connect.mjs`：系统提示补充说明里 MCP 工具那段改为"先 `tool_search` 检索，
  命中后以 `mcp__<server>__<tool>` 可调"，并删掉"computer use 在这里不存在"这类
  会随桥的进度变成假话的断言（新增 1200 字符上限断言防它悄悄膨胀）。

**用例**：桥 +5（tool_search 转发与回包形状 / 延迟工具补进 tools[] / 分组短名 + namespace
的流式与非流式 / 历史拍平），**撤掉任一处修复即红**；lib 补充说明断言同步更新。
`release:check` 全绿。

**真机验证（2026-10-13 15:01，Codex Desktop 实跑，第三方模型 deepseek-v4.1-flash）**：

- 上面两条原本标注「未实测」（真机对照实验因上游限流没跑成），当天下午**在真机跑通了**。
  rollout 里的完整链路：1 次 `tool_search_call` → 1 次 `tool_search_output`（命中
  `mcp__node_repl` 的三个工具）→ 桥补进上游 `tools[]`（日志
  `deferred=mcp__node_repl__js_reset,mcp__node_repl__js,mcp__node_repl__js_add_node_module_dir`，
  tools 41→44）→ 模型发出 `function_call{name:"js", namespace:"mcp__node_repl"}` →
  node_repl 的 JS 内核真的执行并列出了全部打开的应用窗口与标题。
- 排障中还抓到一个同类坑：**改了 `lib/client-connect.mjs` 之后必须重新
  `npm run connect apply codex`**，否则模型目录还是旧的（里面 0 处提到 tool_search，
  模型根本不知道要先检索）—— 与「改了桥必须重启」同属"生成物不刷新"。
- 经验：BM25 检索吃关键词。让模型用「node_repl js execute javascript persistent kernel」
  这类具体词去搜；模糊的"操控电脑"搜不中（实测会搜到 `codex_app` 那批去）。

### Added（桥：上游 429 在桥这层等待重试，客户端无感 —— 治"说话说一半"）

**用户看到的现象**：Codex 干活干到一半，回合突然断在半句话上，界面显示
`rate limit exceeded: too many requests` / "正在重连 N/5"。

**根因**（2026-10-13 16:0x 实测）：上游按账号限流回 429（code 14003，官方提示
"等约 1 分钟再试"），桥原先原样转发失败 → Codex 1–30s 一条地重试（实测 5 连 429），
越撞越限；重试配额耗尽后，回合就带着已说出的半截话结束。桥日志里 2 秒一条的
ok/失败交替就是重试风暴。

**改法**：桥在共用的发送层（与瞬态 400-11133 重试同一处）按 `WORKBUDDY_429_WAITS`
计划（默认 `20000,45000,60000`，总约 2 分钟）本地等待并**原样重发**；上游带
`retry-after` 时取较小者，单次等待上限 90s；客户端断开（abort）立刻放弃。
上游 429 到达时流还没开始，重发没有副作用。三条协议（chat / Anthropic / Responses）
同一处生效。

**用例**：桥 +1（第一次 429 → 重试 200，断言"上游恰好被命中 2 次且两次请求体逐字节
一致"），禁用重试即红；`.env.example` 补说明。

**⚠️ 默认关闭（上线 40 分钟后改，2026-10-13 16:5x）**：默认 20s/45s/60s 实测翻车——
上游拥塞时段等了也多半还是 429（等待 20s → 依旧 429），白白把每条请求拖慢 20–65s，
用户直接感知为"反应好慢"。**速度优先：默认快速返回**，重试交给客户端退避；要
"桥替你等"的显式配 `WORKBUDDY_429_WAITS=30000,60000`。教训：给"等待"类行为做
默认值之前，先确认等待真的能等到成功。

### Changed（思考强度档位：从"每模型写死三档"改成**逐模型实测**）

dsh 的「推理等级」下拉原先对所有模型都只给**低 / 中 / 高**三档（adapter 里写死）。
而上游对支持推理的模型其实收 `minimal / low / medium / high`，多数模型还收
`xhigh / max` —— 用户反馈"每个模型也就只有三个档"。

目录里**没有任何字段**说"接受哪几档"（`supportsReasoning` 只说这个模型会推理），
所以档位是**实测**出来的（不猜）：

- 新增 `tools/dev/probe-efforts-all.mjs`：对真实网关逐模型 × 逐档打一遍
  （每格 `max_tokens:8`，判据 = HTTP 200；**另打一个不带档位的对照组**，
  用来把"模型不可用"和"这个档位不支持"分开）。可续跑、429 自动退避。
  2026-10-12 国际版账号实测 20 个模型，结论：
  - 档位全集 = 国际版桌面端产物里的 `EXTENDED_THINKING_LEVELS`
    （off / minimal / low / medium / high / xhigh / max，另加 none）；
  - **可调通的 10 个模型里 9 个连 `xhigh` 都收**；唯一例外 `gemini-3.5-flash`
    （`xhigh` / `none` / `off` 全部 400）—— 正好落在默认档位上；
  - **`off` / `none` 一律不声明**：对一部分模型 400、对另一部分模型虽然 200
    但照样思考（实测 `reasoning_tokens > 0`）—— 暴露出来只会误导或报错；
  - 另有 **8 个模型连"不带档位"的对照请求都 400**（gpt-5.x 全家 / gpt-6-luna /
    primary-model / claude-haiku-4.5 / claude-opus-4.8）—— 那是**可用性**问题，
    与档位无关，照常给默认档位（修好后大概率仍成立）。
- 桥 `/v1/models` 新增每模型的 `reasoning_efforts`（默认五档 + 实测覆盖表
  `REASONING_EFFORTS_BY_MODEL`，注释里写了探针与日期）；
- 插件 `toAdapterModel` 透传该表、`resolveModel` 照单声明：
  `efforts` 每项带可读名字（含 `xhigh → Extra High`），`defaultEffort`
  优先 `medium`、退 `high`、再退化到最强档（**保证在 efforts 里** —— dsh 会校验）；
  老桥没这个字段时退回低/中/高三档，目录没说支持推理则一个档位都不给。

新增用例：桥 1 条（默认五档 / 覆盖表 / 不给非推理模型 / 补全模型也要带）、
插件 1 条（照单声明 / 老桥兜底 / 无推理不给 / defaultEffort 必须在列表内）。
**撤掉映射即变红**。已重启用户那个桥并端到端复核：
`deepseek-v4.1-flash` 与 `glm-5.3` 现在给出 **6 档**（minimal…xhigh、max），
`gemini-3.5-flash` 给出 **5 档**（与实测一致，不含 xhigh）。

### Changed（国内版档位矩阵：29 个推理模型实测并表）

`REASONING_EFFORTS_BY_MODEL` 补齐**国内版**一侧（用户要求"国内版账号也要功能一致"）。
用 `probe-efforts-all.mjs` 对 CN 目录 31 个模型里的 **29 个推理模型**做了同样的
逐模型 × 逐档实测（含对照组），矩阵落盘可续跑：

- **22 个全档**（minimal…max + xhigh）；`deepseek-v4-pro` / `deepseek-v4-flash`
  只拒 `off`（照例不声明）；`deepseek-v4-pro` **国内版可用**（国际版目录里没有它，
  只在国内版补全，并表对国际版无影响）；
- **7 个目录在列但网关不接**（对照即 400 `service info not found`）→ 显式空数组、
  dsh 不显示思考强度：`glm-4.6` / `glm-4.6v` / `glm-4.7` / `glm-5.0` /
  `hy4-preview-x` / `kimi-k2-thinking` / `minimax-m2.5`；
- 两端共有的 5 个模型复测**结论一致** → 档位表**不需要区域维度**（id 键控的设计被证实）；
- `space-bunny/minimal`、`hunyuan-2.0-thinking/xhigh` 探针各有一格**偶发 400**，
  复测 6/6 全 200 → 按全档入表。**孤立单格 400 先复测再缩表**（确定性 400 才是真不收）；
- 遗留：`deepseek-v4.1-flash` 的 CN 复测被**模型级 429** 挡下（频率限制
  2026-10-12 21:22 UTC+8 重置、可按模型切换），先按国际版实测结论，到点复跑补确认。

桥用例扩了 2 条断言（CN 全档模型给 6 档 / 网关不接给空数组，撤掉即红）。
已 re-vendor、`release:check` 六步全绿，端到端复核：CN 一次性桥看新表生效、
重启用户桥后国际版可见行为逐条不变。

### Fixed（核心功能：国际版下补全模型的**能力元数据**丢了 —— 视觉模型被当成纯文本、选不了思考强度）

**用户反馈（2026-10-12）**：DSH 里选 WorkBuddy 国际版账号的 `deepseek-v4.1-flash` 时
「选不了思考强度」，报
`session/model-unavailable: provider "workbuddy" model "deepseek-v4.1-flash" does not support reasoning effort "high"`；
而且它明明是**视觉模型**，却被显示成纯文本。

**根因**（全链路已实测确认）：国际版网关的目录端点里**根本没有这个模型**
（`/health.upstreamShape.supplemented` 里能看到它靠 FEATURED 兜底补全），
而补全项**原先不带任何能力字段** → `dsh` 适配器拿到的就是「纯文本、不支持推理」：

```
上游目录(18+14 个模型) ──缺 v4.1-flash──▶ FEATURED 补全(只有 id/name/ctx/out)
   ──▶ toAdapterModel: inputModalities=['text']、无 reasoning ──▶ dsh：没有推理等级
```

**这个模型到底支不支持？—— 实测，不猜**（新增两个探针，可复跑）：

- `tools/dev/probe-capability.mjs`：塞一张 1×1 红点图 → 上游 **200，答出「粉色」**（视觉可用）；
- `tools/dev/probe-effort.mjs`：`reasoning_effort` 五档（minimal/low/medium/high/max）
  **全部 200 且都返回 `reasoning_content`**（推理可用）。

**修法**（bridge 三处 + 区域过滤）：

1. `FEATURED` 的 `deepseek-v4.1-flash` 带上 `images: true` / `supportsReasoning: true`
   （值都有上面的实测出处，注释里写明探针）；
2. 补全路径（`fetchCatalog`）与默认视图兜底（`pickFeatured`）、空目录兜底三处
   **都要把能力标记带上**（原先三处全丢，只在其中一处修会漏）；
3. 新增 `regions` 过滤：`deepseek-v4-pro` 在国际版实测 **400 `service info not found`**
   （该区域不提供），标 `['cn']` 只在国内版补全 —— 否则选择器里多一个一调就报错的死条目。
   区域按**登录域名**判（`upstreamRegion()`），不看 `CODEBUDDY_ENDPOINT`（那是验收用的出站覆盖）。

**验收**：

- 桥新增 2 条用例（国际版补全带标记 + 国内版照旧补 v4-pro），插件新增 1 条
  （`supports_reasoning` → 必须给出 `reasoning{efforts,defaultEffort}`；没标则**不许**给）。
  **撤掉修复跑一次 = 变红**（有牙齿）。桥 53/53、插件 83/83。
- 真机验证（用国际版登录文件起的一次性桥）：26 个模型、
  `deepseek-v4.1-flash { supports_images: true, supports_reasoning: true, ctx:1000000 }`、
  `supplemented: ["deepseek-v4.1-flash"]`、**v4-pro 不再出现**。

> **改完已重启用户的桥**（控制台 `POST /api/bridge/restart`，带上 `.state.json` 里
> 选定的国际版登录文件 —— 实测重启**不会**换账号）；插件分发跑的是 `vendor/` 里的
> 桥副本，已同步。
> 附一条排障知识：**控制台起的桥**会带上 `.state.json` 的账号选择、且发现端口上的桥
> 账号不一致会主动纠正；**插件起的桥**不读 `.state.json`，默认自探测（本机自探测会落到
> 国内版文件）。要固定账号就在插件配置里显式写 `authFile`。

### Added（趋势图「按周」粒度）

`#trendGran` 从「按天 / 最近 24 小时」扩到三档：**按天 / 按周 / 最近 24 小时**。

- **取数固定 84 天（12 周）**，按**自然周（周一为一周之首）**在**前端**聚合 ——
  `days[].byModel` 桥侧早就有，加粒度不必再动桥；小时视图才是桥侧分桶的。
- 桶的起点锚在**数据**上（最早一天所在的那一周画到本周）、中间空周补 0。
  为什么不是固定画 12 个桶：取数窗口是**滚动 84 天**，与周一对不齐 ——
  固定 12 桶会把窗口最早那几天的数据漏在桶外，而它们仍计入面板 total，
  违反「图上的数字必须能在面板里对上」这条硬要求。
- 标签为 `MM-DD 周`；`byModel` 逐周合并，「按模型堆叠」在周视图照常可用；
  aria 为「最近 N 周…」。
- 顺带：`buildTrendChart` 对 **0 / 1 个桶**不再静默返回空（一块空白看起来像图坏了），
  改为给文案（0 桶：「这段时间没有调用」；1 桶：「换个粒度能看到更多」）。
- i18n：新增 `按周` / 单桶提示词条；图表 aria 规则扩展到 `周`；
  **图表 tooltip 的前缀也过一遍 translateText**（否则英文模式下会留「09-29 周: 2 calls」），
  并补了「输入·输出 / 积分·累计」两条多序列规则（原先贪婪匹配会把尾巴留在中文）。

新增 `tools/dev/test-trend-week.mjs`（15 条断言：选项存在 / `days=84` 请求 /
周一起算的分桶 / 空周补 0 / 同周多天合并 / 合计与面板一致 / 切回按天走缓存 /
单桶文案 / 英文模式无残留中文 / 英文 aria 规则）。**第一版全红**（9 项失败）。

### Fixed（视觉对齐：把还写着旧配色值的四处收敛到令牌）

同一类缺陷的四个实例 —— **颜色写死在组件里、不跟随主题与五套配色方案**。
这类问题读代码看不出来（值混在 URL 编码 / 注释旁边），页面上也不报错，
只有把"当前方案的主色"和"实际渲染色"对起来量才发现：

| 位置 | 原先 | 现在 |
|---|---|---|
| 下拉箭头（`.dd-arrow`） | SVG data-URI 写死皇家蓝 `#2563eb`（深色 `#3b82f6`）与冷灰 `#64748b`/`#94a3b8` | `mask-image`（取 alpha）+ `background-color: var(--muted/--primary)` |
| 原生 `select` 箭头 | 同上一套（**永远不可见**：select 一律被 `.dd-native` 透明化） | 直接删除；`padding` 保留（它决定 `.dd` 宽度） |
| 表格行 悬停 / 勾选 | 写死蓝色 rgba（注释还写着"陶土色"）；勾选行在深色下几乎看不见 | 悬停 → `--panel-hover`；勾选 → `--primary-subtle` |
| 桥日志终端块 `pre.log` | GitHub 冷蓝黑 `#0d1117` + 冷灰 `#c9d1d9`（暖纸底上"发蓝"） | 新增 `--log-bg` / `--log-fg`（浅色 Sooty、深色再暗一档） |
| 危险按钮悬停光晕 | 写死上一套红 `rgba(220,38,38,.25)` | `--shadow-danger`（两套主题各一份） |
| 失败行悬停 | 写死上一套红 `rgba(239,68,68,.18)` | `--fail-border`（fail 家族的深一档） |

新增 `tools/dev/test-accent-icons.mjs`：静态扫描（样式里不许有**写死颜色的图标
data-URI**，mask 例外）+ 运行时 5 配色 × 2 主题**实测箭头渲染色**。
**撤掉修复跑一次 = 40 项失败**（有牙齿）。另用一次性像素探针确认 mask 渲染出的
确实是"箭头形状"而不是实心方块（撤掉修复时 `mask=none`）。

顺带把 stale 值留在注释里的地方一次清掉（`--faint (#94a3b8)`、`--primary-soft`
这个**根本不存在**的令牌 fallback、"默认陶土 5.40:1"等），并同步
`docs/DESIGN_SYSTEM.md`（**它整篇还写着皇家蓝 `#2563eb` 体系**，与实现完全对不上）
与 `dashboard/README.md` 的视觉规范段。

### Changed（推广图对齐新配色）

`docs/promo/social-preview.html`（GitHub 社交预览图源文件）整页还是更早的
"皇家蓝 + 冷灰蓝"体系，与控制台"不是同一个产品"。已按暖色体系重做：
暖纸底 + 土色水洗、衬线大标题（与品牌名同一条 Georgia 栈）、Sooty 实底按钮/终端块、
ok 家族对勾。`docs/promo/social-preview.png` 用新增的
`tools/dev/shot-promo.mjs` 重渲染（1280×640 @2x，脚本会断言页面尺寸防裁切）。
界面截图同批重出（`shot-hero` 四张 + `shot-console` 两张，像素差分核对变化范围）。

### Fixed（两处"看运行环境脸色"的假红）

1. **`lib/client-connect.test.mjs` 用了 `execFileSync`** —— 违反本项目"同步子进程一律
   `spawnSync` + `stdio: ['ignore','pipe','pipe']`"的硬规矩。它是否触发 `EBUSY`
   取决于**本进程的 stdio 形态**：前台跑碰巧过，把输出**重定向到文件（后台任务）**
   跑就必红。改成 `spawnSync` + 显式查 `status`（失败时把 `error`/`stderr` 带进断言，
   不再是一个裸的异常）。修后同样的后台重定向环境 `test:lib` 124/124 全过。
2. **`tools/dev/test-transitions.mjs` 的伪元素采样**从固定 `sleep(90)` 改**轮询**
   （上限 900ms）：View Transition 的伪元素是**下一帧**才建的，机器忙时固定等待会
   取到空数组 —— 整套连跑偶发红一次、单跑必过。改后 3 连过。

### Fixed（`probe-clickable.mjs` 静默挂死）

上一轮新增的可点击性全量探针**跑不完**：它等 `document.getAnimations()` 的
`finished` 全部 settle，而页面上有三处 `infinite` 动画（状态点呼吸光晕 / 骨架屏
shimmer / 请求活动指示器）——**对它们 `finished` 永远不会 settle**，探针挂在第一次
等待处、零输出，端口还占着（上一轮遗留的两个孤儿进程就是这么来的）。
修法：只等**有限次数**的动画 + 3 秒硬上限兜底。
修好后重跑：**六个视图、0 个元素点不到**。

### Fixed（自绘下拉：包在 `<label>` 里的那个**点不开**）

9 个自绘下拉里，`#probeScope`（体检范围）**点了打不开** —— 这就是反馈里说的
「下拉菜单点不开」。

**根因**：它被包在 `<label class="check">范围<select>…</select></label>` 里。
点 `<label>` 内部的任何地方，浏览器都会**额外给 label 的控件转发一次 click**。
那次是**独立事件**，触发器上的 `stopPropagation` 拦不住 —— 它冒泡到 document
触发了「点外面就关」，于是菜单**刚开就被关**，用户看到的就是"这个下拉点不开"。

9 个下拉里只有它一个在 label 里，所以只有它坏。

**修法**（两条，互相独立）：
1. 触发器点击加 `e.preventDefault()` —— 取消 label 的转发行为；
2. `document` 的「点外面就关」改为**忽略落 `.dd` 内部的点击**（点在下拉内部本来
   就不算"点外面"），兜住来自别的路径的转发。

> 为什么之前没发现：早先的检查只做「点第一个下拉，DOM 里有没有 `.dd-menu`」——
> 只测一个 + 只看"存在"，恰好两条都绕开了这个 bug。

**新增 `test-dropdowns.mjs`**：9 个下拉**逐个**用**真实鼠标点击**（不是 `el.click()`，
label 转发这条路径只有真点击才会走到）打开，并断言菜单在视口内、没被祖先裁掉、
没被别的层盖住。另有一条防假绿：断言**覆盖到了「包在 label 里」的那类** ——
那正是出过 bug 的那一类，没有它这个用例会退化成"全都是不在 label 里的"。

> 这个用例自己先踩了两个坑，都写进注释了：
> - **不把触发器滚进视口就量几何** → 菜单必然在视口外，9 个里 5 个报"有问题"，
>   其实只有 1 个是真的。而且要用 `behavior:'instant'`（页面有 `scroll-behavior:smooth`，
>   滚到一半取的矩形是过时的）。
> - **量完坐标先 sleep 再点击** → 首批数据陆续到达会让页面继续位移，那一下点到了
>   别处（日志里只有 `closeAll`、`ddOpen` 从没被调用），看起来像产品坏了。
>   现在是先等布局稳定（高度 + 触发器纵坐标连续 3 次一致），且测量与点击之间不留间隔。

### Added（趋势图「按模型堆叠」：颜色区分哪些模型花掉了积分）

趋势图新增第四种形态「按模型堆叠」：每天一根柱，**按模型分段上色** ——
回答「这些积分是**谁**在哪天花掉的」。

**这需要动桥。** `/api/usage` 原先只有两个聚合视角，各自缺一半：

| 字段 | 维度 | 缺口 |
|---|---|---|
| `models[]` | 模型 | 只有整窗口合计，没有时间轴 |
| `days[]` | 天 | 只有不分模型的每天合计 |
| **`days[].byModel[]`** | **天 × 模型** | ← 本次新增 |

把 `models[]` 按比例摊到每天是**编数据**，而这张图的价值恰恰在于"哪一天是谁花的"。
聚合就在 `summarizeUsage()` 的同一次遍历里顺手做（多一个 Map，不额外扫账本）；
小时粒度（`?hours=1`）同样带 `byModel`，否则切到「最近 24 小时」这个功能就没了。
`byModel` 也带 `promptTokens` / `completionTokens`，所以三种指标都能画。

> **不变量**：`byModel` 各项小计之和必须等于当天的合计。图上一根柱子的各段之和
> 就是那天的高度，对不上就等于"图上的数字在面板里对不上"（项目的硬要求）。
> 夹具里手写这些数很容易改一边忘另一边 —— 用例里有一条**纯数据断言**钉它。

**配色与「积分排行」共用一张表。** 顺带修掉一个会再犯的错：`modelColor` 按
"首次出现顺序"分配，而两处排序依据不同（排行按扣分、图表按当前指标），
谁先渲染谁就定顺序 —— 切一下指标，同一个模型在两个地方就是两个颜色。
改成加载时按 `usage.models`（与图表无关的稳定顺序）**预分配**（`seedModelColors`），
之后两处都只是查表。用例里断言两处配色完全一致。

### Added（趋势图形态可选 + 积分排行按模型配色 + 自绘确认框）

三件事都来自同一轮反馈，都做成了常驻用例。

**一、趋势图加「形态」选项。** 原先图形是**按指标写死**的（次数=柱、tokens=堆叠柱、
积分=折线）—— 那几个默认是有理由的，但用户有时就是想看同一份数据的另一种画法。
新增 `#trendKind`（形态自动 / 柱状图 / 折线图），默认「形态自动」= 原行为。

其中一条**语义规则**值得单记：`dashed` 的系列（「累计」）**任何形态下都画成线**。
累计值画成柱子会被读成"当天消耗"，而它其实是"到那天为止的总和" ——
这是语义差异，不是画法偏好。所以「积分 + 柱状图」得到的是**柱子 + 累计虚线**的混合形态。

**二、积分排行按模型配色。** 原先 8 根条全是一个蓝。调色板在 OKLCH 里推导
（L=0.58、C=0.10，色相均分 8 档），这个 L 是实测选的：对浅色面板 `#f0eee6` 与
深色面板 `#1e1d1a` 都能过 3:1（实测 3.52–3.89:1 / 3.73–4.12:1），更亮或更暗都会有一头掉下去。

> **踩坑**：第一版按名字**哈希取色**，实测 3 个模型里就有 2 个撞成同一个颜色
> （`glm-5.3` 与 `deepseek-v4.1-flash` 都是 `#ad6067`）—— 调色板只有 8 个槽位、
> 排行最多 9 行，哈希必然碰撞，而碰撞正好违背了「不同模型不同颜色」的初衷。
> 改成**按首次出现顺序分配**（映射表持久，不随渲染重算）：会话内每个模型拿到唯一色，
> 换排序、来回切指标都不变色。「其它（N 个）」是聚合行，给中性色、不占模型色。

**三、自绘确认框替代原生 `confirm`。** 原生 confirm 的样式完全由浏览器决定
（与页面两套观感，深色主题下弹出来是**一片亮白**），而且它**阻塞主线程**、
**不在 DOM 里**（i18n 的 DOM 翻译层够不着）。换成 `.modal-scrim` + `.modal`：
遮罩压暗、标题加粗、危险动作的确定键是红色、**Esc / 点遮罩 = 取消**、
焦点落在确定键上并在关闭后归还。

> 换掉之后有个**新陷阱**：弹窗是运行时新建的，而 i18n 的 DOM 扫描早就跑完了 ——
> 按钮文案若写死中文字面量，英文模式下会留中文。所以按钮必须过 `t()`。
> 用例专门钉住这条（英文模式断言按钮与标题都没有中文）。

层级用 `--z-overlay`（500）：比下拉（300）高 —— 确认框要盖住它底下那个被操作的下拉；
比 toast（600）低 —— 「已复制」这类提示仍能浮在它上面。遮罩**不用 `backdrop-filter`**
（全屏模糊在这台机器上实测会拖慢主线程），纯色压暗足够。

> **换掉之后测试骨架也得跟着改**（这一轮踩了）：3 个用例（`test-connect-panel` /
> `test-r7-safety` / `test-r8-details`）靠 harness 的**原生对话框接管**
> （`lastDialog` / `setDialogHandler`，走 CDP `Page.javascriptDialogOpening`）读确认文案
> 并自动回答；弹窗进了 DOM 之后那条路再也收不到东西 → 文案读到 `null`、弹窗没人点
> → 后续请求根本不发（表现为「请求没发出去」，**看起来像产品坏了**）。
>
> 修法是让 harness **也接管 DOM 弹窗**：页面侧装 `MutationObserver`，一出现
> `.modal-scrim` 就把文案经 CDP binding（`Runtime.addBinding`）回传，由 harness
> 按 `setDialogHandler` 的决定点掉它。**「接受」是默认行为**，与原生框一致 ——
> 用例侧只改了 7 处 `lastDialog()` → `await lastDialog()`。
> 要检查弹窗本身的用例用 `setDialogAuto(false)` 关掉自动接管。

**新增两个用例**：`test-usage-chart-modes.mjs`（9 种指标×形态组合 + 配色两两不同 +
切换后不换色）、`test-confirm-modal.mjs`（弹窗行为 + 英文翻译 + **源码里不许再有裸的
`confirm(`** 这条静态守卫）。

> 那条静态守卫自己先红了一次：它把**注释里**提到的 `` `confirm(` `` 也算命中。
> 修法是先剥注释再扫 —— 且只剥「整行注释」，不能用通用的 `//.*`
> （会把 `http://127.0.0.1` 这类字符串一起吃掉）。

### Fixed（文本间距：加字距后接入值标签被裁掉一截）

新增常驻用例 `tools/dev/test-text-spacing.mjs`（WCAG 1.4.12：用户把行高提到 1.5×、
字距 0.12em、词距 0.16em 之后，**内容不能丢**）。

实测抓到：`.valuerow-k` / `.formrow-k`（「Anthropic Base URL」这类标签）写的是
`white-space: nowrap` + `overflow: hidden` + `text-overflow: ellipsis` ——
**加字距后被裁掉 10px**，文字丢了一截。

列宽写死 124px 是**刻意的**（`.valuerow` 的注释里记着：内容自适应会让说明列错位，
实测修过），所以不能靠加宽解决。改成**允许换行**（`white-space: normal` +
`overflow-wrap: anywhere`）：

- **正常字距下所有标签都装得下，视觉零变化** —— 重出截图后像素差分验证过
  （平均差 0.007–0.016/255，差异 >6 的像素 ≤0.023%）；
- 字距变大时换行而不是丢字。

**用例的判定方式是"报变差，不报存在"**：只报新出现的裁切与裁得更多的元素。
页面本来就有裁切的地方（长令牌）是既有设计取舍，全报一遍会把真问题淹掉。

> **已知的既有裁切**（非失败项，记录在用例文件头）：`.valuerow-v` / `.formrow-v`
> 的长令牌在**正常字距下就裁 16px**，加字距后到 67px。这是刻意的 —— 该行列宽写死
> （内容自适应会让说明列错位）、值是**点击即复制**的芯片且 `user-select: all`、
> 全值也在 DOM 里（读屏拿到的是完整值）。换成换行或横向滚动会破坏"一行一个值"的
> 扫读性。**功能没丢，只是视觉截断**；要严格达标需产品决策改这一行的布局。

断言已验证有牙齿：撤掉换行修复 → 1 项失败、退出码 1。

### Fixed（诊断状态只有颜色一条通道 + 两个排版检查目标一直在空跑）

两处都在同一轮排查里发现，都是"读代码看不出来"的那类。

**一、状态只靠颜色传达（WCAG 1.4.1）。** 环境诊断面板的全部意义是
「**哪一项红了**，不解决模型就不会出现」，而它的状态通道原先**只有颜色**：
一枚 8px 纯色圆点 + 整行染色（`.diag-row:has(.s-fail)`）。两处都是颜色。

用 Machado 2009 色觉缺陷模拟（严重度 1.0）量三色两两的 CIEDE2000 色差：

| 主题 | 缺陷 | 最差一对 | ΔE00 |
|---|---|---|---|
| 浅色 | 绿色盲 | `--warn` vs `--fail` | **0.4** ← 就是同一个颜色 |
| 浅色 | 红色盲 | ok/warn/fail 两两 | 6.9 – 7.1 |
| 深色 | 绿色盲 | `--ok` vs `--fail` | **4.4** |

绿色盲在男性里约占 6% —— 对这部分用户**「哪行是失败」完全读不出来**。
窄屏更糟：`.diag-row .s-dot { display: none }` 连圆点都藏了，只剩底色浓淡。

修法：状态指示器改成 **16px 圆徽章 + 字形**，字形沿用项目**已有的**
`DIAG_MARK`（`{ ok:'✓', warn:'!', fail:'✗' }`）—— 它本来只用在 Markdown 诊断报告里，
现在 UI 与报告**共用同一份符号**。字形色走 `--on-solid`（深色主题自动反转），
实测浅色 4.99–5.37:1、深色 6.07–7.75:1。窄屏不再隐藏指示器，
改成两行布局（圆点 + 标签 / 说明占满整宽）。

**二、排版用例的两个目标一直在空跑。** `test-data-typography.mjs` 里：

- `.diag-row .s-text` —— **类名写错**，真实类名是 `.detail`；
- `.filterchip` —— 只在**筛选激活时**才渲染，用例没准备那个状态。

两者都表现为「元素不存在，跳过」——**写错类名和"条件渲染没触发"长得一模一样**，
于是 12 个目标里有 2 个静默空跑了很久没人发现。

修法：修正类名、补上筛选激活的准备，并且**把「元素不存在」从"跳过"改成"失败"**——
目标不存在就说明这一项什么都没测，必须让作者要么改选择器、要么补状态准备。
改完 11 个目标全过（排版本身没问题，是覆盖现在才是真的）。

### Fixed（模型表的行复选框没有可访问名称）

新增常驻用例 `tools/dev/test-accessible-name.mjs`（逐视图审计 WCAG 4.1.2），
第一次跑就抓到：模型表每行的 `<input type="checkbox" data-id="…">`
是**全表唯一一个没有 `<label>` 的** —— 其余复选框都包在 `<label class="check">` 里，
只有它的说明在右边另一列。于是读屏用户 Tab 到它只会听到「复选框」，
**完全不知道选的是哪个模型**（那张表最多 30 行）。

补 `aria-label="选中 <显示名>"`（显示名缺失时退回 id）。

> **交叉约束**：`I18N_ATTRS` 包含 `aria-label`，所以新加的名字会自动进翻译层。
> 拼接式文案必须在 `RULES` 里加规则兜住，且**只翻动词、不翻数据**：
> `[/^选中 (.+)$/, 'Select $1']`。已实测英文模式渲染为 `Select DeepSeek-V4.1-Flash`
> —— 动词翻了、模型名作为上游数据保留。`check:i18n` 会把源码片段
> （`' aria-label="选中 '`）报成「片段翻不动」，那是静态扫描的假阳性
> （同 `搜索模型` 那条），已补进检查器里那份人工清单。

断言已验证有牙齿：撤掉 `aria-label` → 1 项失败、退出码 1。

### Fixed（焦点环被自己的 box-shadow 吃掉 + 一处 `outline: none` 没有替代）

新增常驻用例 `tools/dev/test-focus-ring.mjs`（逐视图审计键盘焦点可见性），
**第一次跑就抓到两个真缺陷** —— 两个都是"读代码看不出来、必须真聚焦一次才知道"的：

- **所有主按钮聚焦时屏幕上什么都不变。** 根因是个**同特异性陷阱**：
  `button:focus-visible`（0,1,1）设 `box-shadow: var(--ring)`，而 `button.primary`
  （0,1,1）设 `box-shadow: var(--shadow-primary-sm)` —— 同特异性下靠后的胜出，
  焦点环被按钮自己的投影吃掉了。受影响的是「保存到 dsh 设置」「发送」「写入」等
  **全部主按钮**。修法是**把环与投影叠起来**（只补环会让按钮看着"掉"下来）：
  `box-shadow: var(--ring), var(--shadow-primary-sm)`。
  讽刺的是同一个文件在 `button.primary:disabled` 那条注释里**已经记录过这个陷阱**，
  焦点环这条漏了。
- **「查看桥日志（最近 80 行）」聚焦时零反馈。** `#logDrawer > summary` 写着
  `outline: none` 却**没有任何替代**。补 `summary:focus-visible`；抽屉那条必须用
  **`inset`** —— `#logDrawer` 是 `overflow: hidden`，向外扩的环会被左右与上方裁掉。
  顺带把另外三个行内折叠开关（`.manualconnect` / `.connecthow` / `.connectpre`）
  从**浏览器默认轮廓**统一到本项目的 `--ring` 语言。

**为什么人肉 Tab 没发现**：两个都藏在标签页内部（模型页 / 对话测试页 / 客户端页 /
日志抽屉），只 Tab 当前页看不到。用例因此**逐视图**审计，5 个视图共 105 个可聚焦元素。

> 用例头注释记了三条纪律：**必须先发一次真实 Tab 键**建立键盘模态（否则
> `focus()` 不命中 `:focus-visible`，会把所有元素误判成没有焦点环）；
> **测量期间关掉过渡**（焦点环本身是过渡属性）；**禁用态 / 未渲染要单独归类**
> （实测 13 个"无焦点环"里只有 3 个是真缺陷，假阳性会把真问题淹掉）。
> 断言已验证有牙齿：撤掉修复 → 5 项失败、退出码 1。

### Fixed（模型选择芯片：五套配色在浅色下文字都不达标）

`tools/dev/test-accent-schemes.mjs`（五套强调色 × 两主题的对比度体检）红着 7 项。
逐一查完，其中**只有一项是真缺陷**，且读代码看不出来：

- **真缺陷**：`.modelpick-chip.on` 的文字写的是 `color: var(--primary)`。项目里
  `--primary` 的角色是「边框 / 图标 / 1px 描边」（浅色下只保证压面板 ≥3.4:1），
  承载文字该用 `--primary-text`（压自己的底 ≥4.9:1）。芯片是 **11.5px / weight 600**，
  属正文档要 4.5:1 —— 于是**五套配色在浅色主题下全部不达标**（实测 3.39–3.56:1，
  肉眼就是"字发虚"）。改用 `--primary-text` 后十种组合全过：
  浅色 4.88–5.05、深色 7.78–8.92（深色档还从 ~5.9 提到 ~7.8，更稳）。
- **另外 6 项是测量方式的假象**，不是产品缺陷（详见 `tools/dev/contrast-scan.mjs`
  文件头，那边把三种坑和两个错解都写全了）：
  - `getComputedStyle` 对**视口外**元素永远返回**过渡起始帧** —— Chrome 不为视口外
    元素启动合成，过渡 `startTime` 恒为 `null`。芯片在 y≈4182（视口 1100），
    于是永远读到上一套配色的底色。**滚进视口后截图像素逐套与令牌完全吻合**
    （light/blue `#edf1f7`、light/terracotta `#f7ece5`），证明屏幕是对的。
  - 过渡**中途**采样会把 `bg` / `fg` 取到不同相位，量出"深色底 + 浅色字"这种
    屏幕上不存在的组合（`button.mini.danger` 报 2.83:1，真实终值 5.26:1，本已达标）。

修法与沉淀：

- 新增 `withTransitionsOff()`（`tools/dev/contrast-scan.mjs`）—— 测量期间临时注入
  `transition:none` 的样式，拿到**静态终值**，与视口位置、采样时机都无关。
  两个用例（`test-solid-contrast` / `test-accent-schemes`）共用同一份扫描源码，
  不复制第二份，避免判据漂移。
- `--transition-fast` / `--transition-normal` 从 `all` 收窄成显式属性列表。
  这条**不是上面那个 bug 的修复**（曾误以为是，后来推翻了）——它本身是对的：
  `all` 会把布局属性也纳入监听，且新增属性变化时会"悄悄地也做了个动画"。

### Changed（控制台视觉重做：调色板、深色表面阶梯、读数排版）

基调定为**精密仪器**：数字是主角、其余一律压低、**不用渐变**。

- **调色板重建**：皇家蓝 → 靛蓝（色相 277）。整套色阶在 **OKLCH** 里按明度等步长
  推导（感知均匀），但**样式里落地成十六进制** —— 实测 Chrome 会把 `oklch()` 原样
  回传成 computed value，而 WCAG 门禁用 `/rgba?\(/` 解析颜色，直接写 `oklch()`
  会让那个门禁**整个量不到颜色**。
- **深色模式改用表面阶梯**：深度靠"越高的表面越亮"（#07070b → #0f0f14 → #17181e），
  卡片与面板在深色下**取消投影**（黑压黑看不见，越加重越脏）。下拉/抽屉仍保留
  一圈环境影，因为它们要分开的是"下面的内容"而不只是底色。
- **修掉一个真 bug**：`--primary` 原先同时承担"实心按钮填充"与"文字色"两个反向角色，
  深色下白字压 `#3b82f6` 只有 **3.68:1**（AA 要 4.5）—— 而它是最显眼的控件。
  现拆成 `--primary`（文字/边框侧）与 `--primary-solid`（填充侧），两边都过 AA。
- **中性色带品牌色相**（chroma 0.002–0.010），面板 #fcfdfe 而非纯白、深色底 #07070b
  而非纯黑。
- **读数走等宽字形**：`.card .v` 用 `--font-mono`。该字体栈没有中文字形，浏览器对中文
  逐字回退到系统 CJK 字体 —— 数字落在等宽字形上、中文仍是正常中文字。没有改 DOM
  拆 span（那会打断 i18n 的整串匹配）。
- **移除全部渐变**：品牌标/页签的 152° 品牌色渐变、按钮的纵向受光渐变、
  表头的白色薄雾、排行条的横向渐变，全部删掉；受光面改成一条 `inset 0 1px 0`
  发丝高光。全文件只剩骨架屏 shimmer 一处渐变（那是加载指示器，渐变就是它的动画）。
- **圆角从外到内递减**：新增 `--radius-xl`(20) 给最外层容器，面板 12、小元件 8。
- **入场动效**：八张状态卡按 `nth-child` 依次延迟 45ms 升起（一次编排，不是八个各自为政）。

### Fixed（控制台「跟随系统」主题）

`initTheme()` 原先无条件写 `localStorage` —— 方向是对的（`saved || 系统偏好`），
但**第一次访问就把"跟随系统"固化成"记住这一次"**：用户在系统里切深色页面不会跟，
且再也回不到跟随状态。现在初始化**不落盘**，只有用户亲手点切换才落盘；
另挂 `matchMedia` 监听，未表态时系统主题一变就跟着变。

### Added（两条与视觉相关的无头用例）

- `tools/dev/test-theme-follow.mjs` —— 用 `Emulation.setEmulatedMedia` 真改系统配色
  偏好，验"未表态跟随 / 表态后以用户为准 / 系统变化当场跟随"。
- `tools/dev/test-card-motion.mjs` —— 用 CDP 发**真实鼠标事件**验悬停抬升。
  入场动画的 `fill-mode` 若写成 `both`，会把 `:hover` 的 `translateY(-2px)`
  **静默压死**（动画优先级高于普通声明），代码读起来完全正常。

两条用例都按纪律**撤掉修复验证过会变红**。

### Added（`npm run check:opencode`：拿官方 schema 验 opencode 配置）

三个客户端里 Codex 与 Claude Code 本机跑通过（`e2e: true`），opencode 没有 ——
本机装的是**桌面版**（`%LOCALAPPDATA%\Programs\@opencode-aidesktop`），
无头环境驱动不了 GUI。于是把这件事里**能被机械验证的那一半**做成工具：
拉 opencode 的官方配置 schema（<https://opencode.ai/config.json>，JSON Schema 2020-12），
对我们"将要写入的内容"逐键校验（键是否存在、类型是否对）。当前 **16 条键全部通过**。

**它证明什么、不证明什么，工具自己会说**：只证明"配置合法"，
不证明"桌面版真的读进去并调通" —— 后者需要人点一次。**别把"schema 过了"说成"接入可用"**。

> 写这个工具时先修了自己两次：官方 schema 是 `$ref: #/$defs/Config` 的结构（第一版看顶层
> `properties` → 0 个键 → 把 16 条全误报成"没这个键"），而 `model` 的 `$ref` 指向
> **外部文件**（models.dev）→ 当成本地找又误报一次。**工具失真时，人会去怀疑被测对象**。



### Fixed（opencode：配置叫 `opencode.jsonc` 时不认）

官方文档写明 *OpenCode supports both JSON and JSONC (JSON with Comments) formats*，
且示例大量使用 `opencode.jsonc`；源码走读里全局层按 `config.json → opencode.json →
opencode.jsonc` 的顺序尝试。而我们把路径**写死成 `opencode.json`**，于是（本机真实环境）：

- 用户的配置叫 `opencode.jsonc`、里面**已经有 workbuddy 的 provider 块**，
  面板却显示「已安装，尚未接入」—— 因为 `exists` 查的是 `.json`：**界面在说假话**；
- 点「写入」会在旁边**多造一个 `opencode.json`**。按文档优先级它会**盖住**用户那个
  `.jsonc`，用户自己写在里面的设置（`disabled_providers` 之类）就不再生效了 ——
  一次"帮忙"变成了替他改配置。

现在**挑已存在的那个改**（两个都在时用 `.json`，那是文档里的全局名、也是优先级更高的那个；
都不存在才默认 `.json`）。真机验证：路径已变成 `…\opencode.jsonc`，
改动预览是"合并进他那个文件"（`provider.workbuddy` + `model`），不再新造文件。
`WORKBUDDY_OPENCODE_CONFIG` 覆盖仍然优先。

> 顺带在 README 里写清代价：JSON 这条路写入会重排为 2 空格缩进，**`.jsonc` 里的注释会丢**
> （写入前整份备份、可撤销，界面也会提示"该文件会被重新排版"）。

### Docs / 界面（借鉴另一个项目后落地的两条 + 一份界面规范）

2026-10-10 评审了本机另一个前端项目（`D:\IANMUSICD\melodix`，React+Tauri 音乐播放器）的
界面设计，写出 `D:\IANMUSICD\DESIGN-REVIEW.md`，并把其中**能落地**的两条直接做进控制台：

- **z 轴分层令牌**：`--z-table-head / float / sticky / dropdown / tooltip / overlay / toast`，
  5 处裸数字全部换成令牌。这不是洁癖 —— 那 5 处里**顺序本来就是错的**
  （下拉菜单 80 低于吸顶工具条 100），现在恰好没有"从顶栏里展开的下拉"所以没暴露，
  但顶栏里加一个下拉就会中招，而且这种覆盖错读代码看不出来。
- **加载态骨架屏**：5 处「正在读取…」/「加载中…」换成 `.skeleton` 结构预览
  （几根长短不一的条 = "这里会出现一张表"）。原先那行静态文字既看不出将要出现什么，
  也分不出"在读"和"卡住"。骨架屏保留 `role="status"` + 可翻译的 `aria-label`，
  动画走 `background-position`（不触发重排），并**尊重 `prefers-reduced-motion`**。
- **新增 [`docs/UI-GUIDELINES.md`](docs/UI-GUIDELINES.md)**：把借来的方法与纪律写成
  可执行的检查清单（90/5/5 配比、字阶封闭集合、z 阶梯、三种状态、动效边界、
  每个可交互元素的 6 个状态、双语与数据边界、提交前自查），并注明**哪些没有照搬、为什么**
  （控制台是工具不是氛围：主色要承担状态语义，所以不跟它做封面驱动的动态主色）。

### Docs（README 效果图全部重出：三张图与界面已经对不上）

README 里 6 张效果图，只有 2 张是这一轮重出的，其余全是旧界面 —— 而且**旧的不是"略旧"，
是文字与图完全对不上**。逐一查完，四类问题：

- **配色整套漂移**：`console-hero-*.png` 还是改暖色系**之前**的底色（`#fcfdfe` / `#0f0f14`），
  而控制台早已是 Lotion `#faf9f5` / `#1e1d1a`。同一份 README 里，头图与下面的图
  色调互不相干。
- **内容残缺**：`clients-panel-*.png` 停在视觉升级那次提交，之后 `style.css` 又改了
  **1060 行**。更要命的是它拍的是**折叠状态** —— 「手动接入」是个 `<details>`，默认收起，
  于是图里只有两行检测结果 + 一大片空白，而 `alt` 文案描述的「客户端选择器 + 配置片段」
  一个都没露出来。**图与 alt 说的是两回事。**
- **插件面板过期**：`plugin-panel*.png` 停在 10-08，之后 `dsh-plugin/lib/index.js`
  改了 142 行。
- **英文 README 用错图型**：中文版早就把头部换成**视口图**（`shot-hero.mjs` 文件头写了
  为什么：整页长图在 README 的 800px 宽下会缩到 54%、2466px 高，字全糊），
  英文版却还在用 `screenshot-en.png` 那张整页长图。

**修的是脚本，不只是重拍**（否则下次照样过期）：

- `shot-clients.mjs`：展开折叠区后再截，并**断言 `details.open` 真的为真** ——
  面板每 20 秒重渲染一次，点击可能被下一次渲染覆盖、又收回去，只点不验会静默失败。
- `shot-hero.mjs`：出四张（中/英 × 浅/深），英文走**真实的 `langToggle` 开关**
  （顺带验收一次切换）；`data-accent` 显式钉死 —— 不钉就会跟着"当前默认值"漂移，
  而默认值 10-10 刚从蓝改成陶土。
- `shot-clients.mjs` 同样钉死 `data-accent`。

**新增**：`docs/console-hero-en-light.png` / `console-hero-en-dark.png`，
`README.en.md` 的头部改用它们。

> **踩坑**：`npm run panel:shot` 第一次跑卡住不动，日志一个字没有 —— 是 `| tail` 把输出
> 全缓冲了。第二次报 `EADDRINUSE: 8810`，才发现第一次那个进程**还活着占着端口**。
> 用 `taskkill /F /PID` 清掉孤儿绑定后，1 分 56 秒跑完、四个场景全过。
> **判"卡住"前先确认端口和进程，别只看日志。**

### Added（Codex 的 profile 通道：零写入接入）

审计报告第四节对比了各种接入方式，其中 `-p/--profile`（依据 `codex --help`：
*Layer `$CODEX_HOME/<name>.config.toml` on top of the base user config*）是唯一
**便捷性与安全性同时更好**的那一档 —— 现在它成了一个可用的功能：

- 面板：Codex 那一行 →「详情」→ **不改我的配置（可选）** →「写入 profile 文件」/「删除 profile 文件」；
  命令行 `npm run connect profile codex`（撤销是 `undo codex-profile`）。
- **基础配置一个字节都不动**（真机端到端断言了逐字节相等）。正因为如此，这条路
  **不需要**备份/撤销/权限收紧那一整套安全网 —— 那份配置根本没被碰过。
- profile 文件用**独立的目录文件**（`workbuddy-profile-catalog.json`）：两份配置
  各自记着自己的备份与"这个文件是不是我们建的"，共用一份的话，撤销其中一个会把
  另一个正在引用的目录删掉。
- 界面把两件事写在脸上：要照着敲的启动命令（`codex -p workbuddy`），
  以及**桌面应用不接受命令行开关**这条限制（不写的话用户会白试）。
- 它**不是面板上的第四行**：挂在 Codex 行的详情里 —— 和"改基础配置"是同一个决策的
  两个选项，不是第四个客户端。
- 顺带修掉一个静默失效：撤销时目录文件若删不掉（Windows 上会被杀毒实时扫描短暂占用，
  `rmSync` 抛 EBUSY），原先那个空 `catch` 让撤销照样报成功、文件却留在磁盘上 ——
  只能靠手工 `ls` 才能发现。现在如实回报（CLI 与面板都会说"这个文件没能删掉，手动处理"）。
- **面板里"还没写入的勾选"不再因刷新丢失**：面板的勾选状态原本只在内存里，刷新一下
  就回到配置文件里那批 —— 而用户往往正是在"勾好了、还没点写入"这个中间态里刷新页面。
  现在把**选择**（客户端 → 模型 id 列表 + 主模型）存进 `localStorage`，刷新后恢复，
  并且**真的发给服务端**（只在本地显示没用：预览与写入都得按它算）。
  只存选择，不存任何凭据。
- **上游的思维链可以转给 Codex 了**（`WORKBUDDY_FORWARD_REASONING=1`，**默认关**）。
  以前桥一律丢弃并只记一条日志：Codex 要求 `response.reasoning_summary_text.delta`
  到达时已有 active output item，而上游的 `reasoning_content` 总在最前面。
  现在开了开关会先把一个 `type: "reasoning"` 的 item 打开、发完 delta 再关掉，
  顺序由单测钉住（delta 晚于 item 的 added、文本块排在 reasoning 之后、
  收尾进 `completed.output`）。事件名是在 `codex.exe` 里搜出来确认的；
  **默认关**是因为"这个顺序它是否全盘接受"与目录里 `default_reasoning_summary`
  的取值都要一次真机对照实验才能定论 —— 试法见 `docs/TROUBLESHOOTING.md`。

### Added（一键切回客户端原始模型：接入从"拆掉"变成"换挡"）

原来只有「撤销接入」——它是**拆掉**：记录改名归档、我们建的目录文件删掉，
再想用桥就得从头接入一遍。而用户的真实需求往往是**换挡**：
"这两天想用 Codex 自己的模型，回头还想接着用桥"。

- 面板的客户端详情里多了**模式**区块：「走桥」↔「客户端自己的模型」；
  命令行 `npm run connect native|bridge <客户端>`；HTTP `POST /api/connect/mode`。
  `mode` 是必填的显式参数，接口不靠猜用户想干什么。
- **切回原始模型不需要网络也不需要令牌**：它只按记录把我们接管过的键逐键还原
  （连注释、空行都在），`model_catalog_json` 一并还原 —— 客户端打开时用的就是
  它自己原来那个模型。桥没起、令牌已失效照样能切，而那恰恰是最需要它的时刻。
- **切回桥**时才重新取令牌（可能已轮换），并沿用记录里上次接的那批模型，
  用户不必重新勾一遍。
- 当前模式**以文件为准**，不以我们记的账为准（用户可能手工改回去过）。
  判据取"只有我们会写成这样"的形状：Codex 看 `model_provider = "workbuddy"`、
  opencode 看 `provider.workbuddy`、Claude Code 看 `ANTHROPIC_BASE_URL` 是否指向回环。
- 记录里只多一个 `mode` 字段，`restore` 原样保留 —— 来回切多少次，
  「撤销」要用的原始值始终是最初那一份。
- 目录文件留在磁盘上（不再被引用），面板与命令行都如实说明；想连文件一起清掉就用撤销。

### Fixed（审计发现的三个真问题 + 一类界面说假话）

起因是一次完整的接入链路安全审计（报告：[`docs/CLIENT-CONNECT-AUDIT.md`](docs/CLIENT-CONNECT-AUDIT.md)，
每条都带复现或检测方式）：

- **回令牌的读接口没有门槛**（审计 R2，控制台是无认证的令牌发放点）。
  控制台本身没有身份认证，而 Windows 上 127.0.0.1 **不按用户隔离** ——
  同机任何进程/用户一句 `curl http://127.0.0.1:8792/api/connect` 就能拿到桥的令牌，
  再拿去调桥、消耗账号额度；原有的两道防线（`Origin` 白名单、写操作要面板头）
  都只防浏览器。现在 `/api/connect`、`/api/clients` 也要求
  `x-workbuddy-panel: 1`。**代价**：命令行/脚本调这两个接口要自己加这个头
  （控制台页面每个请求都带，界面不受影响）。
- **会真的干活的 GET 同样纳入门槛**（审计 R4）：`/api/diagnose`、
  `/api/models?refresh=1`。浏览器发 `<img src="http://127.0.0.1:8792/…">` 时
  **不带 Origin**，而 Origin 白名单对无 Origin 的请求是放行的 ——
  于是任意网页都能反复触发它们（放大 / 资源消耗）。
- **写入没有跨进程互斥**（审计 R6）：控制台点「重新写入」的同时另一个窗口跑
  `npm run connect apply`，两个写入会交叉，`restore` 的"保留首次"逻辑可能丢掉
  最早那份原值，撤销就还原到中间态。现在三个写接口都走锁文件
  （`<backupRoot>/<客户端>/.lock`，`wx` 原子创建；陈旧锁超过 30 秒可夺回，
  免得进程被强杀之后用户永远接不上）。
- **备份与撤销记录里的令牌没有加固权限**（审计 R1，最高危）。
  `hardenTokenFile()` 只收紧客户端配置本身，而备份是"写之前的整份拷贝" ——
  从第二次写入起里面必然有令牌；撤销记录的 `restore.section` 也可能带着旧令牌。
  实测本机 ACL：客户端配置已是 `Ian:(F)`，而备份仍是继承来的
  `Authenticated Users:(M)` + `Users:(RX)` —— **同机任何用户都能读到那把令牌**。
  现在写入后会连同备份目录一起收紧（Windows `icacls /T`、POSIX 0700/0600），
  结果通过 `backupHardened` 如实回报。
- **TOML 值没转义控制字符 → 可以向 `config.toml` 注入任意节**（审计 R3）。
  `tomlStr()` 只转义 `\` 与 `"`，值里带一个换行就是"多出来的一行"，
  而 TOML 处理是行级的。可达路径：桥没起时目录为空、模型 id 不校验，
  于是 `model` 里塞 `\n[model_providers.evil]` 就能改写用户的 provider 配置。
  现在控制字符一律转义成 `\uXXXX`（TOML 基本字符串本来就支持，**语义不变**）。
- **动态值拼进整句后翻译层认不出来**：`原文件已备份到：C:\…` 这种一行在英文模式下
  永远留着中文。改成「前缀（可翻）+ 服务端原文（不翻）」两个节点渲染，
  与验证结论同一套做法。顺带修掉 `connectSkippedLines` 里从未翻译过的两句。
- **写入结论里明说「重启该客户端后生效」**。实测有用户写完发现客户端里没变、
  于是反复点「重新写入」—— 客户端是启动时读一次配置，这句话比任何"写入成功"
  都更能解释他眼下的处境。
- 顺带补上夹具一直缺的三个字段（`responsesModel` / `responsesFastModel` /
  `diagnose.bridge.authRejected`）—— 重捕形状表时暴露的，属于"夹具落后于真实接口"
  那类静默缺口。
- **桥没起来时的模型校验有了兜底**（审计 R5）：以前目录为空就"放行一切"，
  写进去一个不存在的模型也不会有人说什么（界面还显示"已接入 + 静态自检通过"）。
  现在每次成功抓到目录都会缓存一份，桥没起时用它兜底校验，并如实标注
  「模型候选用的是上次抓到的目录，可能已经过期 —— 所以也无法保证这些模型现在还存在」。
  **校验过了 ≠ 校验可信**，这句话必须说出来。
- **新增「客户端接入」自检项**（审计 R7）：客户端会自己重写配置文件，
  万一某个版本开始丢掉"不认识的键"，接入就**静默失效**（面板还显示「已接入」）。
  现在 `connectSnapshot()` + 诊断项会把"记录说桥模式、文件里却不是"报出来，
  同时**区分**"用户主动切回原始模型"（记录里的 mode 已是 native）—— 后者不是故障，
  不报的话每次切回原始模型都会吃一条假警告。这一项同时出现在控制台诊断页签、
  `npm run doctor` 与 dsh 插件的诊断里（三处共用一份实现）。
- **点 ★ 的后果当场说出来**：实测用户点了 ★ 之后 `config.toml` 的 `model` 就变了
  （也就是**客户端下次打开时用的模型**变了），而面板上只是一颗星号，用户没有任何
  地方能看到这个后果。现在点 ★ 会在那一行给结论：「已设为主模型：<id>」+
  「它就是客户端打开时用的那个模型；点「重新写入」后生效」。
- **形状表捕获改成合并式**（工具本身的两个真问题）：  1. 覆盖式捕获的结果取决于**捕获那一刻控制台的状态** —— 这次在稳态下捕
     `/api/connect`，几个客户端正好都没有 `catalog` 子树，那几条路径就从形状表里
     消失了，而夹具里有它，下一次跑 UI 用例会被判成"真实接口没有这个键"。
     现在这次没出现、上次记过的路径会标 `optional` 保留下来；
  2. 捕获失败时**保留上一次的形状**而不是写成空 —— 实测过一次：控制台没在跑，
     10 条接口全 `fetch failed`，形状文件从 1333 行缩成 34 行，
     看起来像"接口全变了"，其实只是没连上。

### Fixed（一键接入：勾选的模型写不进客户端，面板却一直说"需重新写入"）

**用户现场**：在「一键接入」里勾了 5 个模型，点「重新写入」后客户端的选择器里
始终只有 4 个；重启客户端、重开控制台都没用，面板那行还一直挂着
「已接入，需重新写入」。两个缺陷叠在同一个现场里：

- **控制台点「重新写入」时没把勾选的模型发出去。** 请求体里只有主模型（`model`），
  没有那一批（`models`）；服务端在没收到 `models` 时会回落到"沿用配置文件里现在
  那批"（那是给命令行 `connect apply` 不带 `--models` 用的兜底），于是把**旧的 4 个
  又写了一遍** —— 新勾的第 5 个从来没进过请求体。而面板显示的个数来自它自己的
  勾选状态，界面于是永远显示 5 个。命令行 `npm run connect apply` 一直是好的
  （它带 `--models`），所以只有走控制台才会撞上。
- **模型目录的"需重算"判据太宽。** 只要条目是"我们写的"就算改动，于是**每次打开
  面板都报"有改动"** ——「需重新写入」平时也一直亮着，用户分不出"这次真的少写了
  一个"和"例行刷新"。判据改成**内容**：重算结果与现有条目一字不差就不算改动，
  顺带不再每次接入都白写一遍 90 多 KB 的目录（真正要纠正的场景 —— 旧版本写坏的
  code mode 开关 —— 内容不同，照旧会被重写）。

顺带加了一道"界面不许说假话"的保险：写入成功后，面板显示的模型集合以**服务端
真正写进去的那批**为准，不再念自己那份勾选状态。

用例：`lib/client-connect.test.mjs` 新增「目录与勾选完全一致时不报改动，也不重写
文件」；`tools/dev/test-connect-panel.mjs` 新增「点重新写入时请求体必须带 `models`」
与「写入后面板跟着真实结果走」（把修复撤掉会立刻变红，已实测）。

### Changed（控制台视觉升级：语义色 + 分层阴影 + 图表质感）

只动 `dashboard/public/style.css` 与 `index.html` 的**渲染层**，不动任何业务逻辑、
不改任何 DOM 契约（`.dd-*` / `.tip` / `.card` / `.num` 等类名与结构原样保留），
因此既有用例与自动化脚本一条都不用改。

- **状态卡图标开始承载语义**。原先 8 张卡的图标全是同一个皇家蓝，一眼扫过去分不出
  「桥进程」（本机进程）和「上游端点」（远端网络）—— 而这两件事出问题时的排查方向
  完全不同。现在按语义上色（`tone-ok/warn/fail/info/primary/muted`），并配一枚 26px
  的淡色底衬；令牌剩余还会**按剩余时长变色**（< 7 天红、< 30 天琥珀）。
  底衬顺带修掉一个配重问题：右上角 16px 的细线图标与左下角 20px 的大数字不配重，
  整张卡左重右空。
- **阴影从「单层淡影」改成分层投影**。原值 `0 1px 3px rgba(15,23,42,.04)` 在 1x 屏上
  几乎看不见，整页层次全靠 1px 边框在撑 —— 卡片看起来是**画在纸上的方框**，而不是
  **浮在背景上的一层**，这才是界面显平的根本原因。现在每个浮层用「接触影 + 环境影」
  两层（负 spread 压住四角），并新增 `--shadow-lift` 给可点卡片的悬停抬升。
  浅色纯投影、深色投影 + 亮环，两种主题做法相反是刻意的（黑底吃影）。
- **新增第四种语义色 `--info`（青）**，专给「远端 / 网络」类指标，与 ok 绿、warn 琥珀、
  fail 红都不撞。
- **极克制的单色系微渐变**（`--sheen-top` / `--grad-primary`）：只用于品牌块、主按钮、
  激活 Tab 与图表柱体，且只有**同一色相内的明度变化**，职责是给材质一个受光方向。
  设计规范里的「Anti-Gradient」据此改写为「纯实色打底 + 实心块上的单色微渐变」，
  边界写进了 `docs/DESIGN_SYSTEM.md` 第 1、2.5 节。
- **图表**：柱体改为纵向渐变 + 圆角（圆角随柱高收缩，矮柱不会圆成胶囊），宽度上限
  34px → 48px（7 天视图只有 3~7 根柱时，34px 在 200px 的槽里显得又瘦又空）；
  折线节点描一圈背景色，让它从线上「浮」出来。**仍然零依赖、仍是纯 SVG 字符串。**
- **表格**：表头加一层极淡纵向渐变（sticky 滚动时更容易分清表头与表体）；行悬停从
  `--panel-hover`（浅色下与白底几乎无差）改为一抹极淡主色。
- **告警条加左侧 3px 实色条**：原先四条边同宽同色，看起来只是「一个带底色的面板」，
  而它其实是要立刻处理的东西。
- **焦点环统一**为 `--ring` / `--ring-tight` 令牌（原先按钮、select 各写各的 rgba）。
- 空态留白从 12px 提到 20px（原先夹在面板里像一行被压扁的注释）。

验收：`npm run test:ui`（等宽数字 / 数值列对齐 / 多视口零溢出 / 对比度 4.5:1）
+ `node tools\dev\check-inline-js.mjs` + `npm run vendor`（改了 `dashboard/` 必须同步）。

> 顺带修掉一个**验收面的坑**：`tools/dev/ui-harness.mjs` 的静态服务原先不发缓存头，
> 而 `openPage` 会复用常驻的 headless 实例 —— Chrome 的启发式缓存会把**上一次**的
> `style.css` / `index.html` 喂给页面。表现是「改动明明落盘了，测试和截图却完全看不到」，
> 而且不报任何错。现在统一发 `Cache-Control: no-store`。

### Added

- **一键接入：把 Base URL 与令牌直接写进客户端的配置文件。** 控制台的「客户端接入」
  面板最上面多了一块：检测本机装了哪些客户端（Codex / Claude Code / opencode），
  点「写入」就把配置写进去，不用再手工对着 JSON / TOML 抄。
  命令行同款：`npm run connect status | apply <客户端> | verify <客户端> | undo <客户端>`。

  改别人的配置文件是高危操作，安全网是四条铁律：

  1. **只动自己的键 / 节**，其余内容原样保留（注释、顺序、缩进、别的工具写的节）。
     实测对本机那份带 **cc-switch** 痕迹的 `~/.codex/config.toml`：
     `[model_providers.custom]` 一字未动。
  2. **每次先整份备份**，备份目录会显示给用户。
  3. **可撤销**，且按记录的**原始值逐键还原**，不是拿备份整份盖回去 ——
     用户可能在写入后又手改过别的地方，整份还原会连带丢掉他自己的改动。
  4. **幂等**：重复写入结果一致，也不会把撤销要用的原值覆盖成中间态。

  写完做两层验证：静态读回（键都在）+ **端到端**（拿刚写进文件里的令牌真打一次桥）。
  后者能抓到"文件写对了但令牌已过期"这种静态读回发现不了的情况，
  报错是「桥可能重启后换了令牌，重新点一次写入」而不是含糊的失败。

  如实标注：Codex 在本机做了真实读写验证；Claude Code / opencode 按官方 schema
  实现并有往返单测，但本机没装，界面上标「本机未实测」—— 不写成"支持"。

  配置 schema 全部查自官方文档（Claude Code 的 `settings.json` `env` 块、
  opencode 的全局配置路径与 provider 结构），Codex 对照的是本机真实文件。

### Fixed（对抗式排查：静默丢数据的三个真 bug + JSONC 能力缺口）

这轮换了打法：不再看代码顺不顺眼，而是**构造刁钻输入主动撞** —— 拿一批真实的
畸形/边角配置（CRLF、无末尾换行、tab 缩进、行内注释、BOM、空文件、数组/null
中间层、JSONC……），逐个跑 `apply → verify → undo`，断言"撤销后语义与原始一致"。
39 个用例撞出 23 个不一致，按"语义变化 vs 仅排版"分类后，**3 个是真丢数据**：

- **`setPath` 会把用户的中间层静默替换成 `{}`。**
  `settings.json` 里 `"env": []`、`opencode.json` 里 `"provider": null`（用户或别的
  工具写坏了，但文件本身合法），写入时中间层被替换成 `{}`，撤销也只还原成 `{}` ——
  **apply 报 ok、undo 报 ok，文件却不是原来那份了**。这是最难发现的一类：
  两次操作都"成功"。
  现在 `setPath` 遇到非对象中间层**停下返回 false**，不覆盖用户数据。
- **空配置文件被当成"格式不对"拒掉。**
  长度为 0 的文件（客户端自己建的空文件、或 `touch` 出来的）走到
  `JSON.parse('')` 直接抛，用户看到"不是合法 JSON（Unexpected end of JSON input）"
  以及"你是不是写了注释"的提示 —— 方向全错，而空文件恰恰是**最该能一键接上**的状态。
- **撤销会丢掉 BOM。** `stripBom` 是为了能解析，但撤销的承诺是"还原到接入之前"，
  那三个字节也该还原。附带把一条**把丢字节当正确行为**的老断言改了过来
  （原断言写着"BOM 被写回去了"，等于把 bug 固化成预期）。

以及一个**能力缺口**（官方文档实证，不是猜）：

- **带注释的 JSONC 被拒**。官方文档原话：*OpenCode supports both JSON and JSONC
  (JSON with Comments) formats.* 而用户手写配置加注释极常见。原先直接 `JSON.parse`
  → 报"不是合法 JSON"并提示"请手工编辑" —— 把**本可一键接上**的场景变成手工活。
  现在会先试严格 JSON、再试**剥掉注释**的版本；
  剥注释是逐字符扫的（处理字符串态与 `\\` 转义），**字符串里的 `//` 不会被当注释**
  （`"baseURL": "http://127.0.0.1:8790/v1"` 被截断的话，写进去的地址就是废的，
  而且解析照样通过、写入还报成功）。
  **尾逗号不处理**（不在 JSONC 规范里）：真遇到了如实报错，不猜 —— 猜错就是改坏文件。

还有一条"不能装作写成功"：

- **被跳过的键要如实报出来。** 中间层是用户数据而没写进去时，只说"已写入"等于骗人：
  `ANTHROPIC_*` 根本没进去，下次请求失败时用户完全想不到是这里。
  现在 `plan`/`apply` 都带 `skippedKeys`，命令行逐条打印并给出修法
  （"把 `env` 改成对象后重试"），面板也在结果里说清楚。

修完重跑同一套 harness：**23 → 0**，所有 JSON 用例都变成"等价（仅排版）"。
Codex 那几个"文本有差异"是行级重写的固有取舍（注释、顺序、别人的节都保住，
但等号空格/缩进会被规范化），已在文档里写明。

### Fixed（`DSH_HOME` 在 import 之后改也生效）

上一条排查的收尾：`config.dsh` 的四个路径（`home` / `settingsPath` / `credentialsPath` /
`profileDir`）原先在 **`import` 那一刻**就算成常量，于是「先 import 再设 `DSH_HOME`」
（最自然的写法 —— 测试就是这么写的，`启动.cmd` 这类脚本也可能先加载再补环境）
会**静默失效**：用户以为 dsh 配置改到了别处，实际还在 `~/.dsh`。
而写 dsh 配置是**会动用户文件**的（往里加模型路由），认错地方就可能往真实 profile 里写东西。

- 改成 **getter**（而不是把 44 处消费点全改成函数调用）：消费点都是普通属性读取，
  getter 让它们一行都不用动，也不会漏掉某一处。
- 顺带修一个边界：`DSH_HOME="   "`（空白值）原先会被当成路径，
  拼出一个**名字是空格的目录**；现在回落家目录。
- 用例：新增 2 条（子进程里 import 之后再设 `DSH_HOME`，断言四个路径全跟着变；
  空 / 纯空白 / 未设三种值都回落到绝对路径 `~/.dsh`）。

### Fixed（把"只在我这台机器上成立"的假设清一遍）

顺着上一问（路径能不能自动识别）把**同类问题**系统查了一遍 —— 结论：生产代码里没有
写死的用户名/绝对路径，但有三处"环境一变就出问题"的地方，都实测复现并修了：

- **备份根跟着启动目录跑。** `REPO_BACKUP_ROOT` 用 `process.cwd()` 且在模块加载时算。
  子进程实测：从仓库根起 = `E:\...\workbuddy-to-dsh\.backup\client-configs`，
  从别处起 = `<那个目录>\.backup\client-configs`。后果是用户换个启动方式
  （快捷方式、计划任务、从别处 `node dashboard/server.mjs`）就**找不到上次的备份与撤销记录**；
  更糟的是 `planClient`（读 manifest 判"已接入"）与 `applyClient`（写 manifest）
  落在不同根下时，会出现「刚写入成功、界面却显示还没接入」。改成跟 `config.ROOT`
  （代码位置）走 —— 备份是本产品自己产生的东西，位置只该由代码在哪决定。
- **桥在环境变量缺失时把登录文件定位成相对路径。** 桥的 `AUTH_DIRS` 只认
  `LOCALAPPDATA` / `HOME` / `XDG_DATA_HOME`，而 Windows **默认只有 `USERPROFILE`、
  没有 `HOME`**；三者全空时最后一行拼出 `workbuddy-desktop.info`（相对路径，按 cwd 解析）。
  于是"桥找不到登录文件"表现成"用户没登录"，真凶（环境变量缺失）完全看不出来。
  现在与 `config.mjs` 的 `authDir()` 同口径：加 `USERPROFILE` 兜底、
  Windows 上 `LOCALAPPDATA` 缺失就退回 `<home>/AppData/Local`。四种环境实测都落到同一个绝对路径。
- **`HOME` 在模块加载时读走。** `lib/client-connect.mjs` 里 `HOME` / `DEFAULT_BACKUP_ROOT`
  都是 import 那一刻定死的常量，"先 import 再设 env"（测试与 `启动.cmd` 都可能这么做）
  会静默失效。全部改成调用时求值。

两处**看着像问题、其实不是**（记下来免得以后重复怀疑）：`dsh-plugin/scripts/preflight.mjs`
已经做过 `LOCALAPPDATA` 兜底（注释里记着同一个坑）；`find-dsh.mjs` / `find-workbuddy.mjs`
里的 `E:\App\WorkBuddy` 等是**候选列表**而非唯一路径，且外面还有扫描与注册表兜底。

用例：新增子进程级用例 3 条（**必须用子进程** —— 同进程 `process.chdir()` 是假绿，
`process.cwd()` 在模块加载时已被读走）、桥启动用例 1 条（真起桥，断言 auth 路径是绝对路径）、
面板断言 1 条（重定位的行要标出来、默认路径的行不啰嗦）、搜索展示名匹配 1 条。

### Fixed（换台电脑也能用：路径按各家官方约定现算）

用户问「你改的文件位置是不是可以自动识别用在别人电脑的话」——查下来：**路径没有写死**
（`grep` 过，生产代码里没有任何用户名/绝对路径，三个路径都从家目录推），
但**只认自己的覆盖变量**，别人的机器上如果改过客户端自己的重定位变量就会写错地方。

- **认各家的官方约定**（都有出处，不是猜的）：

  | 客户端 | 变量 | 依据 |
  |---|---|---|
  | Codex | `CODEX_HOME` | 本机 `codex doctor` 实测：设了它，它自述的 config 路径就变成 `<CODEX_HOME>/config.toml` |
  | Claude Code | `CLAUDE_CONFIG_DIR` | [官方文档](https://code.claude.com/docs/en/settings)：*To keep the home-directory files somewhere else, set `CLAUDE_CONFIG_DIR`* |
  | opencode | `XDG_CONFIG_HOME` | [官方文档](https://opencode.ai/docs/config/)；`OPENCODE_CONFIG` 是**另一层**（优先级更高的另一份配置），不冒充 |

  优先级：`WORKBUDDY_*`（本产品自己的覆盖，测试/运维用）> 客户端自己的变量 > 家目录默认。

- **路径来源会显示出来**：面板标「按客户端的设置写入：`CODEX_HOME`」，命令行标
  「路径来源: 跟随客户端的 `CODEX_HOME`」。只给最终路径的话，用户没法确认"它认没认对地方"
  —— 而认错的后果是把配置写进客户端根本不读的位置。
- 三处路径全部改成**调用时求值**（原先 `HOME` 是模块加载时的常量）：否则
  "先 import 再设 env" 这种最自然的写法会失效。

用例：新增 3 条路径解析用例（含"清掉自己的覆盖变量再断言"，那是原来那批用例的盲区 ——
带着 `WORKBUDDY_CODEX_CONFIG` 测，默认路径算错也看不出来）、
1 条面板断言（重定位的行要标出来、默认路径的行不许啰嗦）。

### Fixed（Codex 的工具调用被写成正文：code mode 踩坑）

用户反馈「Codex 接入后一个对话没说完就截断了」——查下来不是上下文/输出没配，
是**工具协议选错了**，而且错在目录生成那一层。

**现场证据**：Codex 的回答里出现 `<||DSML||invoke name="exec_command">` 这种
**文本标记**。用一个桩上游截下 Codex 真正发出的请求，形状是：

```
顶层字段: model, stream, input, tool_choice, parallel_tool_calls,
          reasoning, store, include, prompt_cache_key, text, client_metadata
          → 没有 tools（工具在 input[] 的 additional_tools 里）
input[0]: type=additional_tools  →  namespace functions → custom exec (freeform/Lark)
```

**根因链**（三步，缺一不成立）：

1. 新版 Codex 的工具协议由模型目录里的 **`use_responses_lite` / `tool_mode`** 决定。
   官方模型（gpt-5.6-*）都是 `use_responses_lite: true` + `tool_mode: "code_mode_only"`
   —— 也就是 **code mode**：shell / apply_patch 全收进一个 freeform 的 `exec`，
   让模型写 JavaScript 去编排工具。
2. cc-switch 切走时删掉了 `model_catalog_json`，我重新接入时**没有现成目录可当模板**，
   于是退回用 Codex 自己的 `models_cache.json` 当模板 —— 把这两个行为开关一起抄了过来。
3. 桥的上游是 chat/completions，**接不了 freeform 那套** → 上游一个工具都收不到 →
   模型只能把工具调用写进正文（那串 DSML），Codex 无工具可执行 → 回合结束。
   用户看到的正是"话说一半断了"。

**修复**（三层，都有用例）：

- `lib/client-connect.mjs`：目录条目**显式定死**行为开关
  （`use_responses_lite: false`、删掉 `tool_mode` / `multi_agent_version`），
  模板只用来继承结构字段；模板优先取**别人的**条目（cc-switch 那种面向第三方
  chat/completions 上游写的，比官方模型更接近我们要的形状）。
- 我们自己写过的旧条目会**被重算**（按 `description` 里的标记识别），
  别人的条目一字不动 —— 否则已经写坏的那些永远纠正不过来。
- `bridge/workbuddy-bridge.mjs`：`input[].additional_tools` 里的 **function 工具要救回来**
  （code mode 下顶层确实没有 `tools`），freeform 的 `exec` 翻不了但**必须写进日志**，
  否则用户只看到一串 DSML 标记、完全不知道问题在哪。

**一个自己踩出来的坑**：`model_catalog_json` 早就写对时，config.toml 一个字都不用改，
`applyClient` 于是按 `changes.length === 0` 提前返回 —— **那份写坏的目录根本没被重写**，
面板还显示「已接入」，用户没有任何入口触发纠正。判断"要不要动手"必须**连目录一起看**
（CLI 那条路也漏了同一处，一起补上）。

**验证**：用真实机器的 `~/.codex` 目录（纠正后）让 Codex 打桩上游，请求回到
`顶层 tools: 10 个`、`input 里没有 additional_tools`（经典模式）。
回答"是不是没配输出/上下文"也一并查了：Codex 的请求里**根本没有 `max_output_tokens`**
（上游按默认走），本地账本近期最大输出 85 token、无 `response.incomplete` 痕迹；
那次真正的失败是上游 `429 code 6004`（"使用量已超出频率限制…也可以切换其他模型"）
与 `400 code 11128`（"Illegal API invocation from an unapproved channel"）。

顺带把 `bridge-responses.test.mjs` 收尾时的 **EPERM 假红**修了：Windows 上桥进程刚被
kill、文件句柄未释放就 `rmSync`，导致**全部断言通过、整个文件仍报错**并卡住
`release:check`；现在先等进程退出、带重试地删，仍失败只警告。

### Added（多模型接入 + 面板改版）

用户反馈「只接入一个模型很奇怪吧，多模型接入不行吗？面板很杂没有美感」——
两件事都做了，做法按**每个客户端自己的能力**来，不搞统一的假接口：

- **多模型**：勾选几个就接几个，其中一个作为主模型。三家的机制不同、写法也不同：

  | 客户端 | 写什么 | 在客户端里怎么切 |
  |---|---|---|
  | opencode | provider 下的模型表（`models`） | TUI 里直接选 |
  | Claude Code | `modelPicker.options`（并 `replaceBuiltInOptions: true`） | `/model` 选择器 |
  | Codex | `model_catalog_json` 指向的**目录文件** | `-m <模型>` 或模型选择器 |

  两处刻意设计：

  1. **Claude Code 替换内置列表**。Base URL 指向桥之后，内置的 Sonnet/Opus/Haiku
     会被桥的 Anthropic 层映射到**别的**模型 —— 留着它们就是"选了 Sonnet 实际跑
     glm-5.3"。宁可只列真实可用的那些，撤销即还原。
  2. **Codex 的目录是合并的**。`model_catalog_json` 是全局键，本机已被 cc-switch
     占用（里面是用户别的隧道模型）：读进来**一条不动**，只补桥这边缺的 slug，
     条目则**克隆**现成模板再改 slug/名字/上下文（字段有三十来个，少一个 Codex 可能
     整份解析失败）。目录是**第二个被写的文件**，所以备份/撤销同样覆盖它：
     键还原、我们建的删掉、改过的按备份还原。实测（隔离目录）：6 条原有 + 2 条新增，
     撤销后 `model_catalog_json` 回到 cc-switch 那份、我们的文件消失。
     本机两处模板都没有时**不生成目录**，界面如实说"只能接一个模型"。

  命令行同款：`npm run connect apply codex --models glm-5.3,kimi-k3-1`。

- **面板改版：一行一个客户端 + 一个详情展开器 + 可搜索的模型清单。**
  改版前的实测数据（就是"没有美感"的来源）：

  | 症状 | 实测 | 现在 |
  |---|---|---|
  | 三行客户端高矮不一 | 已接入那行 **113px**（挂着绿色验证框），另两行 41px | 三行**都是 41px** |
  | 每行按钮数不一 | 5 个 vs 3 个，右边缘参差 | 默认态**只有 2 个**：写入 / 详情 |
  | 30 个候选模型铺成 chip 云 | **269px、4 行**，目录越长越长 | 两列**可滚动窗口 224px** + 搜索框（纯前端过滤） |
  | 展开详情撑爆页面宽度 | 详情 **1588px**（面板只有 1050px），整页横向溢出 365px | 0 溢出（`min-width: 0` 那条） |
  | 展开详情一开就 895px | 里面塞着一整份配置 `<pre>` | 配置预览**默认折叠**，详情 595px |

  细节：模型清单每行一个复选框 + 一颗 ★（设为主模型，不用再单独给个下拉）；
  「验证 / 将改动什么 / 撤销接入」都收进那个客户端的详情里；说明、
  三个接入值、各家片段、兼容性清单收进「手动接入」折叠区，**折叠状态归用户**
  （`manualOpen`），20 秒轮询重渲染不会把它收回去。

### Fixed（一键接入的"半成品"部分）

用户反馈「这块很不行、一直是那个界面」——复现出来的根因不是一个 bug，是**三类界面在说假话**：

- **读不到状态时永远转圈。** 控制台进程还在跑改动前的旧代码，`/api/connect` 回
  404；前端把失败吞掉（`lastConnect = null`）后只渲染「正在读取接入状态…」这一句
  —— 没有原因、没有重试入口，用户无从判断是"慢"还是"坏了"。现在读失败会给出
  HTTP 状态与原因（404 那条直接说「多半是控制台进程还在跑旧代码，重启控制台后刷新」），
  带「重试」，并**保留上次读到的行**；读取加了 15 秒超时（原先没有超时，
  接口挂住就是永远转圈）。验证方式：新增 `tools/dev/test-connect-panel.mjs`
  （打桩型 UI 用例，31 条断言）对 404 / 恢复 / 从未读到 三条路逐条断言。
- **「已接入」只是 manifest 文件在不在。** 配置被手改过、桥换过端口或令牌，它照样
  挂绿色的「已接入」。现在配置与当前值不一致 → 「已接入，需重新写入」；
  用户自己照「复制片段」抄进配置文件的（没有 manifest）→ 「已接入（非本控制台写入）」
  —— 不再诱导他多点一次写入。
- **服务端有 `/api/connect/verify`（静态读回 + 端到端），命令行也在用，控制台却没有入口。**
  现在每行已接入的客户端都有「验证接入」，并且**打开面板时自动验一遍**（只验"配置
  与当前值一致"的行：已经漂移的行必然报失败，那是已知状态，不该再刷一条红字）。
  验证没过时状态标签从绿色的「已接入」变成「已接入，验证未通过」。

顺带修掉的三处（都是"界面在说假话"的同类）：

- **用户自己选的模型被当成"配置漂移"。** 上次把 Codex 选成 `deepseek-v4.1-flash`
  写进去，重新打开面板时按桥的默认（glm-5.3）重算 → 明明刚写好的配置被报成
  「已接入，需重新写入」；用户照着点一次「重新写入」，反而把他自己的选择改掉。
  现在控制台三个接口与命令行共用一个 `resolveModelChoice()`：**显式选择 > 配置文件里
  现在那个模型（且确实在当前目录里）> 桥的默认**。模型是用户的偏好，不是我们的默认值。
  （本机实测就是这个状态，是修好之后才敢说"已接入"。）
- **「桥在跑但拒绝本控制台的令牌」被说成「桥未运行」。** 桥独立启动时会自己生成一把
  随机令牌（只打印在启动日志里），与控制台读的 `.bridge-token` 不是同一把 ——
  桥对控制台每次请求都回 401。此时页面写「桥未运行」，用户去点「启动桥服务」得到的是
  "已经在跑了"。现在 `bridgeHealth()` 明确给出 `authRejected`，`/api/connect` 透出
  `bridge: { up, authRejected }`，界面直说「两边令牌不一致，点上方「重启桥」」。
  用例：`lib/diagnostics.auth.test.mjs`（桩一个永远 401 的桥）。
- **320px 视口下接入模型下拉撑破整行（实测溢出 18px）。** 根因是宽度封顶封在了原生
  `select` 上（`max-width: 220px`），而它决定外层 `.dd` 的宽度 → 溢出。封顶移到
  可收缩的 `.dd` 上。这个缺陷长期没被发现，是因为**桩数据里缺 `modelOptions`**：
  下拉是空的、宽度接近 0，撑不破任何东西（`test-ui-kit` 的「所有触发器都有文案」
  一直在红，就是同一个夹具缺口）。夹具已按真实响应补齐 `modelOptions` /
  `effectiveModel`，并把 `/api/connect` 纳入了 `api-shape.json` 的形状校验
  —— 下次再漏字段，桩会在渲染前就被拦下。

### Added（上一轮：Codex 协议层）

- **支持 Codex（`POST /v1/responses`）。** Codex 说的是 OpenAI 的 **Responses 协议**，
  而桥原先只讲 chat/completions 与 Anthropic Messages 两套 —— 也就是说「把 Base URL
  指过来」接不上，必须真的做一层协议转换。这正是 CC Switch 靠一个本地路由进程做的事，
  区别是这层转换**内置在桥里**，用户不用再装一个中间人。

  做法上有一处不能想当然：网上（以及不少整合包）仍在教
  `wire_api = "chat"`，但上游已经把它**删掉**了 —— 见
  `codex-rs/model-provider-info/src/lib.rs`（tag `rust-v0.162.0`）里 `WireApi` 只剩
  `Responses`，写 `"chat"` 会反序列化成 `CHAT_WIRE_API_REMOVED_ERROR` 直接报错。
  所以 `/v1/responses` 是唯一可行的一条路。

  协议转换按要求对齐 Codex 的解析器（`codex-rs/codex-api/src/sse/responses.rs`、
  `codex-rs/core/src/session/turn.rs`），四条硬约束：

  1. 正文**只从 `response.output_item.done` 取**；`response.function_call_arguments.done`
     被显式忽略。所以每个条目必须发完整的收尾事件，不能只发 delta。
  2. 任何 `*.delta` 之前必须已有 `response.output_item.added` ——
     否则 Codex 走 `error_or_panic` 直接中断（`active_item` 还不存在）。
  3. `response.completed` 里的 `usage` 必须是**三个总数都有**
     （`input_tokens` / `output_tokens` / `total_tokens`，`ResponseCompletedUsage` 里没有 `Option`）。
  4. 不认识的事件与任何 `*.delta` 会被安全忽略 —— 所以可以只发必要的那几种。

  另外两处与 Anthropic 那层同源、但更容易写错的：

  - 请求里**没有 `instructions` 字段**。Codex 把系统提示作为 `input` 里一条
    `role: "developer"` 的 message 发过来，得并进 system。
  - 连续的 `function_call` 必须**合成同一条** assistant 消息，否则上游会看到多条
    只带 `tool_calls` 的 assistant 消息，与随后的 `function_call_output` 对不上号。

  控制台的「客户端接入」面板新增 **Codex 页签**：`~/.codex/config.toml` 片段、
  模型映射说明、以及「令牌写 `experimental_bearer_token`，不要去动 `auth.json`」
  的提醒（后者是官方登录缓存，改它会影响 Codex 自己的插件与远程控制）。
  模型映射与 Anthropic 那条同源（`WORKBUDDY_RESPONSES_MODEL` /
  `WORKBUDDY_RESPONSES_FAST_MODEL`，默认 `glm-5.3` / `glm-5.3-flash`）；
  fast 档**刻意不匹配 `codex` 字样** —— `gpt-5.1-codex` 是主力模型，当 fast 用会把主任务降级。

### Fixed

- **控制台切到英文时，顶部副标题被横腰切断**（实测溢出 11px，且没有省略号，
  看起来像渲染坏了）。根因是 `.sub` 写死 `max-height: 48px` ——
  按 13px / 1.5 行高算那只够 **2.46 行**：中文译文恰好 2 行没事，英文译文 3 行
  共 59px 就被切掉。现在 `max-height` 按行数算（`calc(var(--fs-body) * 1.5 * 3 + 2px)`），
  **真正的上限交给 `-webkit-line-clamp`** —— 将来文案再变长，截断处会有省略号。

- **诊断报告的整行翻译在 detail 含全角冒号时失效**（潜伏已久的规则 bug）。
  报告行的规则写的是 `^- \[(.)\] (.+)：(.+)（建议：(.+)）$`，label 那一组用了
  **贪婪**的 `(.+)`。平时 detail 里没有 `：`，所以它一直是隐性的；
  一旦有（本次新增的「令牌文件权限」detail 就带 `未能收紧：`），贪婪匹配会把
  label 吃成「令牌文件权限：…未能收紧」，查表当然查不到 —— 结果是**标签留在中文、
  detail 只剩尾巴被当成 hint 翻**，半句中文半句英文，比不翻还糟。
  标签里本来不可能有 `：`，改成 `([^：]+)` 即可。

- **令牌文件加固失败不再静默。** `spawnSync` 失败**不抛异常** —— 它把失败放进
  `r.error` / `r.status` 返回；而原先的写法是 `try { spawnSync(...) } catch {}`，
  **没看返回值**。于是「icacls 没跑成」和「跑成了」在调用方看来一模一样：
  文件权限其实没收紧（同机任何用户仍能读到本地令牌），而整条链路上没有任何地方会提到它。

  现在 `hardenTokenFile()`（`config.mjs`）与 `hardenBridgeTokenFile()`
  （`dsh-plugin/lib/index.js`，两份实现）都返回
  `{ ok, code, reason }`，`code` 让调用方能**区分**「本机压根起不来 icacls」
  （环境问题，验证可跳过）与「icacls 跑起来了但配置失败」（真实故障，必须报错）；
  `config.bridge.tokenHarden` / `resolveConfig().localTokenHarden` 把结果带出来，
  `doctor` 与环境诊断多了一项「令牌文件权限」（失败时给出手动修复命令）。

### Changed

- **`tools/dev/check-i18n-coverage.mjs`：拼接片段改为按 `+` 链判（可跨行），
  并支持 `--why`。** 原先只在**同一行**内拼接，于是
  `'…前半句'` 换行 `+ '后半句…'` 这种最常见的断行写法永远拼不上，
  控制台里 6 条 Codex 文案全部被报成「片段翻不动」。现在按源码位置切 `+` 链，
  并做括号深度跟踪 —— 否则 `('已切换到 ' + file) : ('切换失败：' + err)`
  这两个**三元不同分支**上的字面量会被错误地拼成一句。

  名单从 71 条降到 36 条（消除 35、新增 0），漏报没变多。`--why <行号|字面量>`
  用来回答「这一条为什么在/不在名单里」——`--check` 只能问「这串翻不翻」。

### Docs

- `README.md` / `README.en.md` 的客户端列表补上 Codex。
- `docs/DESIGN_SYSTEM.md` 补第 4·6 节「字体与字号」（三层字体栈 + 六级字号阶梯 +
  400/600/700 三档字重），并记录「字重 500 与 600 落在同一个字体文件」这条实测结论。

## [1.4.9] - 2026-10-09

### Security

- **补齐 v1.4.8 漏掉的一处：插件侧的令牌文件同样没收紧权限**（`dsh-plugin/lib/index.js`）。
  令牌文件（`dsh-plugin/.bridge-token`）有**两份**解析代码：仓库根的 `config.mjs`
  和插件自己的 `lib/index.js`，两处都用 `writeFileSync(..., { mode: 0o600 })`。
  v1.4.8 只修了前者 —— 也就是说**由插件创建**的那个文件权限仍然是继承来的
  （`Authenticated Users:(M)` + `Users:(RX)`），同机任何用户都能读。

  现在插件侧也加了 `hardenBridgeTokenFile()`（同一套做法：POSIX `chmod 0600`、
  Windows `icacls /inheritance:r /grant:r <当前用户>:F`），读已存在文件时也补一次。
  顺手把那段注释里「权限：0600（仅本人可读）」改准 —— 在 Windows 上那句话不成立，
  真正起作用的是这个函数。

  > 插件包不引用仓库根的 `config.mjs`，所以这个 helper 是**两份实现**。
  > 已在两处注释里互相标注「改动时两处一起看」。

## [1.4.8] - 2026-10-09

### Security

- **令牌文件在 Windows 上其实是「任何用户可读」**（`config.mjs`）。
  v1.4.6 把本地令牌改成随机生成，文档里写「文件权限 0600」—— 但
  `writeFileSync({ mode: 0o600 })` 的 `mode` **只在 POSIX 上有意义**；
  Windows 走 NTFS ACL，`mode` 基本被忽略。实测新建出来的文件继承目录权限：

  ```
  NT AUTHORITY\Authenticated Users:(I)(M)   ← 任何已认证用户可改
  BUILTIN\Users:(I)(RX)                     ← 任何用户可读
  ```

  也就是**同机任何用户都能读到令牌**。而令牌改成随机的**理由**恰恰是
  「旧默认值是公开口令，本机任何程序都能拿它调用桥」—— 权限不收，
  这个理由就被抵消掉一半。

  修法：新增 `hardenTokenFile()` —— POSIX 上 `chmod 0600`，Windows 上用
  `icacls /inheritance:r /grant:r <当前用户>:F` 去掉继承、只留当前用户。
  对**已存在**的令牌文件也会补一次（旧版本创建的都带着继承来的权限）。
  用 `spawnSync` 而不是 `execSync`（后者经 cmd.exe，在这台机器上必抛 EBUSY）。

  实测：加固前 5 条 ACE（`CodexSandboxUsers` + 裸 SID + SYSTEM +
  Administrators + 当前用户）→ 加固后**只剩当前用户一条**。
  用例 `lib/config.token-perm.test.mjs`（仅 Windows 跑）钉住这一点。

  > 用例第一版是**假绿**：写的是「不该有 Authenticated Users / Users」，
  > 而实际继承到的主体根本没有这两个名字，不加修复也会通过。
  > 改成「数 ACE 条目数必须为 1」才真的能区分。

## [1.4.7] - 2026-10-09

### Fixed

- **`release:check` 会偶发红：`lib/state.test.mjs` 拿真实状态文件做测试**（`lib/state.mjs` + 该测试）。
  这条用例断言「`clearState()` 之后文件必须不存在」，而它操作的默认路径是
  **仓库根的 `.state.json`，也就是运行时真实状态** —— 控制台 / 插件在跑的时候会
  **周期性写它**，于是删掉之后立刻被 live 进程重新创建出来，断言偶发失败。
  （实测：单独跑 `npm run test:lib` 50/50 全过；放进 `release:check` 链里偶发红，
  失败时连重试删除都删不掉 —— 因为不是文件锁，是**有人在写**。）

  修法：给 `state.mjs` 加 `WORKBUDDY_STATE_FILE` 环境变量覆盖（与桥的
  `WORKBUDDY_USAGE_FILE` 同款做法），测试指向自己的临时文件，**真正隔离**，
  不再依赖「备份 + 恢复真实文件」。`statePath` 由常量改成**函数**（每次调用重读
  环境变量）—— 因为 ESM 的 import 会被提升，测试没法在导入前设环境变量。

  > 中途我一度想用「`clearState` 失败重试」来解决，**验证发现没用**（重试 5 次
  > 文件照样在），已撤回。定位到真因是 live 进程在写之后才做对 ——
  > **没验证过的修复不该留着**。

- **401 排查指引漏了一种情况，会让人转不出来**（`bridge`）。
  指引原先假定「客户端里填的是旧值」，但还有另一种：**填的就是文件里的新令牌、
  却仍然 401** —— 那不是客户端的问题，而是**在跑的桥**内存里还是升级前的旧令牌。

  为什么会出现：`config.mjs` 的 `resolveLocalToken()` 在**模块求值时**就会
  生成并落盘令牌，所以**跑测试、跑工具也会创建它**。「首次运行」于是变成了
  「第一个 import 这个模块的进程」，可能早于桥的启动，两者就对不上了
  （本机实测到了这个状态：令牌文件比桥的启动晚，桥拒绝文件里的令牌）。

  现在指引里加了这一种，并给出处置：**把桥和控制台一起重启**（走 `启动.cmd`），
  两边会收敛到文件里的同一个值；只重启一边会继续 401。
  用例补了一条断言钉住「必须提到重启」。

### 测试

- **补上积分缓存竞态的用例**（`lib/diagnostics.quota.test.mjs`）。
  v1.4.5 修 `quotaGeneration` 时**没有用例**（`fetchQuota` 是模块私有的，
  构造那个时序需要能替换 `bridgeFetch`）。现在改用「起一个假桥 + 动态 import」：
  `config.bridge` 的 host/port 来自环境变量，import 之前设好即可。

  桩故意**慢 500ms**，让「作废缓存」落在在途窗口里 —— 快桩会让请求在作废之前
  就结束，竞态根本触发不到，用例就白写了。**实测有牙**：还原旧逻辑后取到的
  是上一个账号的余额（`实际 A`）。

## [1.4.6] - 2026-10-09

### Fixed

- **Anthropic 流式：工具名分片被丢掉，客户端拿到截断的名字**（`bridge`）。
  上游把 `function.name` 拆成多帧下发时（`get_` + `weather`），代码里
  `slot.name` 在**建槽时就写入了首片**，而追加的守卫却是 `!slot.name` ——
  首片非空，于是除首片外的分片全被丢弃，`tool_use.name` 变成 `get_`，工具调用必然失败。
  `+=` 本身就说明这里预期分片到达，两者自相矛盾。

  修法分两步（只改守卫不够）：
  1. `name` 初值改成空串、每片都追加；
  2. `content_block_start` **推迟到名字收齐**再发 —— 它原先在建槽时就发出去了，
     里面带着当时那个半截名字。现在改为「参数分片开始到达时」发出
     （OpenAI 协议里名字总在 arguments 之前到齐），并在 `closeOpen()` 收尾时
     补发没有参数的工具块；`closeOpen()` 会**先补发再关块**，保证块索引顺序不乱。

  用例用 `chatRaw` 手写一段分片 SSE，断言输出里出现 `"name":"get_weather"`
  且不出现 `"name":"get_"`。**验证过这条用例有牙**：把旧逻辑还原回去即变红。
  桥全套 30/30。

  > 这条修复原先停在**工作区**（它所在的 `bridge/workbuddy-bridge.mjs` 同时带着
  > 另一处未提交的改动，拆不开）；现已随 `bf9767f` 一并提交。

- **令牌过期瞬间的并发请求会各刷一次令牌**（`bridge`）。
  响应里可能带**轮换后的 refreshToken**，后到的请求拿的是已作废的旧令牌 ——
  必然失败，于是写 `lastRefreshFailedAt`，把接下来 15 秒内**所有**刷新都挡住
  （包括本该成功的）。限流**不**会替这里串行化（两个阈值默认都是 0，直接返回），
  所以并发是真的并行。

  修法：`refreshAuth` 包成单飞（模块级 `refreshInFlight`，同飞的调用方拿到同一个
  promise）。**用例实测过**：桩的刷新端点故意慢 200ms，5 个并发请求在修之前
  **真的刷了 5 次**；修完是 1 次。桥全套 31/31。

- **流式转发没有背压**（`bridge`）。`res.write()` 的返回值原先被完全忽略：
  客户端读得慢、或者干脆停顿但不 disconnect 时，数据会堆在 Node 的发送缓冲里
  （内存随「停顿时长 × 上游速度」增长）。停顿这种情况 `res.on('close')` 覆盖不到
  （它只处理断开）。现在写不动就等 `drain` 再继续从上游拉数据，
  OpenAI 与 Anthropic 两条流式路径都加上了。

  `waitDrain` 同时监听 `close` —— 客户端中途断开时 `drain` 永远不会来，
  只等 drain 会把转发协程挂住，那正是「客户端关了页面、桥却卡住」的成因。

- **`persistRefreshed()` 名字与行为相反**（`bridge`）。它叫「持久化」，实现却是
  只打一行「write-back skipped」的空操作，而且原先在 `memoryAuth` 赋值**之前**
  调用 —— 读代码的人很容易以为令牌已经落盘。改名为 `logWriteBackSkipped()`
  并移到赋值之后。这条「绝不回写登录文件」是项目的硬约束，代码不该长得像在回写。

- **导出 CSV 的文件名用本地日期**（`dashboard/public/index.html`）。
  页面里原先有**两个「今天」**：`localDateStr()`（本地，注释写明与桥的 `localDay`
  同规则）与 `today()`（`new Date().toISOString().slice(0, 10)` —— 那是 **UTC**）。
  导出文件名用的是后者，于是在 UTC+8 的 00:00–08:00 导出，文件名会比墙上时钟早一天。
  现在删掉 `today()`，三处导出统一用 `localDateStr()`：**同一个概念只留一个实现**。
  验收（`tools/dev/test-r5-observability.mjs`）补两条 —— 一条断言文件名带本地日期，
  另一条断言页面里不再存在 UTC 版的「今天」。**后者是必需的**：前者在 UTC 与本地
  同一天时有 2/3 的时间区分不出两种实现。


### ⚠️ 升级须知：客户端里的旧令牌会失效

**本地回环令牌的默认值从固定串 `wb-local-bridge` 改为「首次运行随机生成」。**

- **为什么改**：`wb-local-bridge` 是印在 README 里的公开值，本机任何程序
  （乃至能绕开 Origin 检查的网页脚本）都能拿它调用桥、消耗你的账号配额 ——
  这让认证形同虚设。随机值才真正实现「只有你授权的本机客户端能用」。
- **影响谁**：**手工填过 API Key 的外部客户端**（Claude Code、opencode、
  图形表单等）升级后会回 401。**dsh 插件用户不受影响** ——
  插件与桥读同一个 `<插件>/.bridge-token`，自动一致。
- **怎么修**：控制台 →「客户端接入」面板 → 复制新令牌 → 填回客户端。
  或直接读 `dsh-plugin/.bridge-token`。
- **想保持客户端配置不变**：在 `.env` 里设 `WORKBUDDY_LOCAL_TOKEN=<你原来的值>`，
  显式配置优先级最高，三处都会用它。
- 令牌文件已加入 `.gitignore`；权限 0600。

### Added

- **401 响应自带排查指引**（`unauthorizedBody()`）。401 是升级后最高频的故障，
  原先只回一句 `bad or missing token`，用户既不知道"为什么昨天还行"、
  也不知道"去哪找新值"。现在响应体直接列出三种取值途径与固定值的方法。
  **不含真实令牌** —— 桥绑回环端口，同机进程都能读到响应体，
  把值写在错误里等于给攻击者送答案（已作用例锁死这条）。
- 401 失败也会落账（原先这条路径不进账本，"客户端为什么连不上"在控制台上不可见）。

### Fixed

- **CI 三个 job 全红**：`vendor:check` 报 `bridge/workbuddy-bridge.mjs` 未同步 ——
  上一个 commit 改了桥源码但漏跑 `npm run vendor`，于是**插件用户装到的
  vendor 桥仍是旧版本**（缺上游非 2xx 的挂死修复）。已重新同步。
  这正是 CI 注释里写的那个风险，门禁按设计生效了。
- **CI 从来没跑过 `lib/` 单测**（`.github/workflows/release-check.yml`）。
  unit 那步只跑 `dsh-plugin/tests/*.test.mjs`，桥那步手写
  `node --test bridge/bridge.test.mjs` —— 于是本仓库积攒的 49 例 lib 单测
  （含凭据信封 / 配置解析）在 CI 里**一例都不执行**，新加的
  `bridge-startup.test.mjs` 同样跑不到。现在两个 job 都改为调用 npm 脚本
  （`test:plugin` / `test:lib` / `test:bridge`），以后加测试文件只需改
  `package.json` 一处，不会再有「加了测试但 CI 没跑到」的盲区。
- **控制台的「停止桥服务」会强杀端口上的任意进程**（`dashboard/server.mjs`）。
  `stopBridge()` 拿到的是 `findPortPid()` 的结果——那只是"**谁在监听 8790**"，
  不等于"谁是我们的桥"。8790 被用户自己的其它服务占用时（另一个 node、
  开发服务器、别的工具），点一下停止 = 强杀一个与 workbuddy 无关的进程，
  且没有任何确认。实测（起一个无关 HTTP 服务占住端口）确认可复现。
  现在 kill 之前先打 `/health` 做**归属校验**（判据与 dsh 插件的
  `probe()` 对齐）：确认不是桥 → 拒绝并报出占用者 pid；探测不出来 →
  拒绝并如实说"无法确认"；桥回 401（令牌不一致）→ **仍判为自己人，照常可停**，
  否则用户会看到"端口上那个不是 bridge"这种**假诊断**。
- **上游返回非 2xx 时请求永久挂死**（`bridge/workbuddy-bridge.mjs`）。
  `shimResponse.text()` 走事件式监听，而真实链路里响应回来后还要先等
  `refreshAuth` 失败（8 秒超时）才轮到读体；这期间无人监听，`IncomingMessage`
  是**热流、不缓存**，等轮到读时已 `complete && destroyed` —— 事件永不再触发，
  `text()` 永久 pending，客户端只看到自己的超时。实测证据：
  `readable=false complete=true destroyed=true`。
  改为响应到达即挂监听攒缓冲，`text()`/`body` 基于缓冲 + `finished` promise，
  并补 `close` 兜底。同一场景从「30 秒超时无响应」变为 **33ms 返回 401**。
- **账本的错误原文未在写入侧截断**（`recordRequest`）。原先只在读取侧截断，
  写入侧原样落盘 —— 上游一段 4KB 的 HTML 错误页会整段灌进 `usage.jsonl`，
  撑爆控制台列表与 CSV 导出，且真正有用的信息被淹没。
  现在在入口统一 `shortError()`（压平换行 + 截到 160 字符）。
- **令牌比较改为常数时间**（`safeEqual()` 包 `timingSafeEqual`），
  消除按字节短路带来的前缀时序侧信道。
- **`lib/state.mjs` 改为原子写**（`.tmp` + `rename`），
  避免进程在写盘中途被杀导致的状态文件半损。
- **`.env` 里的写错值不再静默变成 `NaN`**（`config.mjs` **与桥**）。`WORKBUDDY_PORT=879O`
  （字母 O）、`WORKBUDDY_TIMEOUT_MS=8790ms` 这类手滑原先会让 `Number()` 得 `NaN`
  并原样进配置。控制台侧的症状是 `listen(NaN)` 报 errno、URL 变成
  `http://127.0.0.1:NaN`；**桥侧更严重 —— 直接整个起不来**（`RangeError:
  ERR_SOCKET_BAD_PORT`），而报错里看不出是自己配置写错了。
  现在两侧统一走 `numEnv()`（桥内联副本，约定与 exe 探测那对副本相同：**改一处要改两处**）：
  非有限数 / 越界一律回退默认，端口限 1..65535。
- **`WORKBUDDY_MAX_BODY_BYTES` 写错会让请求体上限静默消失**（`bridge`，**安全相关**）。
  `MAX_BODY_BYTES = NaN` 时 `readBody` 里的 `size > limit` **恒为 false** ——
  32MB 的硬上限完全失效，同机任何进程都能灌爆内存。已并入上述 `numEnv()` 收口。
- **`.env` 的 `export KEY=VALUE` 行不再被忽略**（`config.mjs`）。`.env` 与 shell
  脚本写法相近，从别处粘一行 `export WORKBUDDY_PORT=8901` 进来时，旧解析器把键名
  读成 `"export WORKBUDDY_PORT"` —— 配置**完全不生效且无任何提示**。
- **坏信封不再把 `JSON.parse` 原文漏进「为什么不工作」面板**（`lib/atrest.mjs`）。
  登录文件被改坏时，错误信息会把解码出的乱码字节一并带上
  （`Unexpected token '\ufffd', "\ufffd\ufffd~m…" is not valid JSON`），
  这行字会被 `lib/diagnostics.mjs` 原样展示给用户。现在统一收口为
  `envelope is not valid base64` / `envelope is not a JSON record`。

### Changed

- **`fetchKeyFor()` 拆出纯函数 `pickKeyCandidate()`**（`lib/atrest.mjs`）。
  多客户端 build 并存时「按信封 keyId 挑钥」的规则此前与 `execFile` 取载荷揉在一起，
  无法直接单测。行为不变（含「全不匹配时退回第一个成功的、让上层报
  `envelope belongs to key X, not Y`」这条刻意设计），现在选择规则有 8 个直接用例。

### Security

- **桥的认证闸门不再有「未配令牌即放行」这条路径**。原写法
  `if ((LOCAL_TOKEN || ...) && identifyClientId(req) === null)` 在未配置令牌时
  整条 401 分支不执行，`/health`、`/v1/models`、`/v1/chat/completions` 全部无鉴权可达。
  现在令牌**始终必需**，未配置则自动生成。
- **三处联动**（缺一必出「插件与桥令牌不一致 → 401」）：
  `bridge/workbuddy-bridge.mjs`、`config.mjs`、`dsh-plugin/lib/index.js`，
  统一读写同一个 `<插件>/.bridge-token`。已实测仓库检出与 vendor 分发两种形态、
  控制台与插件两个入口**四路取到同一令牌**。
- 该文件在 vendor 布局下曾算错路径（`vendor/dsh-plugin/…`），会导致两边各生成
  各的令牌 —— 已按目录形态归一。

### 测试

- 桥合约 27 → **29** 例（新增 401 自诊断 2 例）。
- **新建 `bridge/bridge-startup.test.mjs`（7 例）并把桥测试接进 CI**。
  原先 CI 链**根本没跑桥测试**（只跑 plugin / standalone），也**没跑任何
  `lib/` 单测**。新文件专测「启动参数写错」这条 `bridge.test.mjs` 永远走不到的
  路径（它的 `startBridge()` 总注入合法端口）：
  - 5 例纯逻辑（照规则写第二实现，逐条对照边界，跨平台确定）
  - 1 例进程级 smoke（真起桥，确认不再抛 `ERR_SOCKET_BAD_PORT`）
  - 1 例**源码守卫**：扫描桥里是否还有裸 `Number(process.env.*)` 数值读取。
    这条专防「规则写对了但某处忘了改」—— 本轮正是这么复发的
    （`config.mjs` 修了、桥没修）。已验证插入一处漏改后会红，并报出具体行号。
  其中 `MAX_BODY_BYTES` 那条用例已验证会先变红（旧实现下 `pass 0 / fail 1`）。
- 停桥用例 3 → **6** 例：新增「不是桥时必须拒绝 kill」（并断言无关进程仍活着）、
  「是真桥时仍能停掉」、「401 不等于不是桥」。新增夹具
  `_bridgeHolder.mjs` / `_auth401Holder.mjs`。
- 新建 `lib/state.test.mjs`（7 例），纳入 `npm run test:lib`（17 → 21 例）。
- 新建 `lib/atrest.test.mjs`（17 例）与 `lib/config.test.mjs`（11 例），
  一并纳入 `npm run test:lib`（21 → **49** 例）。`lib/atrest.mjs` 是凭据红线的
  核心（信封解密 + keyId 校验的全部逻辑），此前零直接单测；`config.mjs` 是全项目
  唯一配置真源，同样零单测。加密夹具按算法**独立重实现**一份（不复用被测代码），
  否则「同错同对」测不出问题。


## [1.4.5] - 2026-10-09

### Fixed

**六条缺陷，来自一次「读代码 + 上真机灌输入」的排查（记录见 `docs/ALGORITHM-REVIEW.md`）。
每条修复都配了会先变红的用例。**

- **畸形 `Host` 头能把桥打死**（`bridge/workbuddy-bridge.mjs`）。
  `handleRequest` 里 `new URL(req.url, 'http://' + req.headers.host)` 原先在 `try`
  **之外**，而 `Host` 是客户端可控的 —— `Host: bad host with spaces` 让它抛
  `ERR_INVALID_URL`，未捕获异常让 Node 直接退出进程（实测 `exitCode=1`）。
  也就是说**任何能访问本机端口的进程，一条请求就能把桥打死**。
  现在挪进 try/catch 按 400 挡下；`Host` 缺失时用 `127.0.0.1` 兜底。
- **上游回 HTTP 200 但不是 SSE 时，桥报「空回答成功」**。
  非流式路径在 `aggregateStream()` 之后**无条件**记 `ok: true` 并回 200 ——
  上游给一坨 HTML（网关把错误包成 200）时，客户端拿到「结构完整但 content 为空」
  的成功响应，账本记 `{"ok":true,"promptTokens":0,"completionTokens":0}`：
  用户以为模型没说话，控制台的成功率还把它算作成功。
  现在 `aggregateStream()` 返回 `parsed`（成功解析的 SSE 块数），
  OpenAI 与 Anthropic 两条路径在 `parsed === 0` 时记失败并回 502。
- **空插件列表被判「健康」**（`lib/dsh.mjs`）。`[].every(...)` 返回 `true`，
  于是 profile 目录缺失、插件列表读不出来时反而报健康 —— 读不到任何东西却是绿点。
  抽出 `bundlesAllInstalled()`：**空 = 未知 ≠ 健康**。
- **「探测不出来」与「确认没有监听者」混为一谈**（`dashboard/server.mjs`）。
  `probePortPid` 把命令缺失 / 超时 / 输出为空**都**返回 `null`，而调用方把 `null`
  读作「端口已释放」→ 没有 `lsof` 的机器上停桥**从不真正校验**就报成功，
  还让「SIGTERM 被忽略时升级 SIGKILL」那段永远不执行。
  改成三态：`number`（有监听者）/ `null`（确认没有）/ `undefined`（未知）。
- **账本截断不是原子写**（`bridge`）。超过 2000 条时重写整份文件用的是
  `writeFileSync` 直接覆盖 —— 正好在这时被杀 / 断电就丢整份本地用量历史
  （没有第二份副本）。改成「写临时文件 + `renameSync`」，与项目里
  `lib/dsh.mjs` 写配置「先备份再写」的标准对齐。这条路径**此前从未被测试执行过**，
  现在有用例覆盖。
- **切账号后积分缓存会被在途请求覆盖**（`lib/diagnostics.mjs`）。
  `invalidateQuotaCache()` 只清缓存、没管在途请求，而在途完成时**无条件**写回 ——
  于是「轮询发起查询 → 用户切账号 → 在途完成」会把**上一个账号**的余额写回缓存，
  控制台最多 60 秒显示旧账号的余额。加 `quotaGeneration` 代次解决。

### 验收

- 桥：**22 条用例全过**（新增 3 条：畸形 Host、上游非 SSE、账本截断）
- `release:check` 六步全绿
- 顺带发现并记录了一条**假绿**：用例第一版用默认假凭据，请求压根没走到 chat 路径，
  `assert.ok(status >= 400)` 因为「凭据异常」的 500 而成立。教训写进了文档 ——
  断言宽条件时必须确认失败来自被测路径。

## [1.4.4] - 2026-10-09

### Changed（重写，不是修补）

- **主题切换与语言切换的动效改成 View Transitions API**。旧实现是三层 hack 叠起来的：
  1. `<html>` 挂 `.theming` 临时类 + `html.theming *` 全局过渡 —— 必须「先挂 class →
     强制一次回流 → 再改值」，漏一步动画**静默失效**，读 CSS 看不出来；
  2. 那条全局规则一旦加上 `box-shadow`，每帧要为 1200+ 个元素插值阴影，
     样式重算暴涨 → 200ms 补间被压成**一帧**，比不加还糟（实测踩过）；
  3. 语言切换的两段式靠 JS 计时器（130ms）与 CSS 时长对齐，还要自己防重入。

  现在由 `withViewTransition(cb)` 包住状态变更，浏览器把「旧的一帧」「新的一帧」
  各自快照后**自己交叉淡化**：没有全局过渡规则、没有计时器、没有顺序陷阱，
  而且整页一致（按钮、图标、SVG 这些不好逐属性补间的部分也一起淡）。

  实测（5324px 高、697 个元素的页面）：过渡期间 34 帧 / 712ms，中位帧间隔 17ms，
  快照那一下有一次 83ms 尖峰 —— 与旧的逐属性补间持平。

- **顺带删掉的**：`langIn` / `langOut` 两个关键帧、`.wrap.lang-*` 类、`langFadeIn()`、
  `.theming` 相关的全部 CSS 与计时器、主题图标自己的 opacity/transform 补间
  （整页淡化已经覆盖它，再补一层等于把「点下去到看见变化」拆成两段）。
  主题图标的 `hover` / `active` 变换保留（那是交互反馈，与主题无关）。

- **降级路径**：不支持 `startViewTransition` 的浏览器**直接改状态** ——
  动画是装饰，状态不能因为动画而丢。这条有专门断言。

### 验收

`tools/dev/test-transitions.mjs` 整条重写（12 条断言），断言对象从「逐属性补间」
换成「机制本身」：

- `startViewTransition` **真的被调用**（用 spy，不是查 class）；
- 过渡期间存在 `::view-transition-old/new(root)` 伪元素动画，**且 `currentTime` 在推进**
  （只有动画对象、不推进等于没动）；
- 状态落点正确（主题属性、图标显隐、语言文案）；
- **降级路径**：把 API 置空后，主题与语言仍然能切；
- reduce 下交叉淡化保留但压短到 120ms（颜色/透明度不是 motion，
  不该被 blanket 规则一起关掉 —— 对关掉系统动画的人，「瞬间翻转」会被读成「坏了重绘」）。

> 取样有个坑：View Transition 的伪元素动画是浏览器**下一帧**才建的，
> 点击后立刻读会拿到空数组（第一版就这么误报的）。

### Changed

- **控制台排版优化**（只调排版与交互，**品牌色、品牌标、整套组件语言一律未动**）：
  - **用量面板的标题行拆分**：原先「最近 [7] 天 · 只记元数据…」两个下拉、时间戳和
    两个按钮全塞在 `<h2>` 里，一行放不下就乱换行，标题与控件抢同一条基线。
    现在标题行只有「用量统计 + 更新时间」，控件与提示单独一行（新增 `.panel-tools`），
    与其它面板同一套结构。
  - **状态读数卡按「第一眼要回答的问题」重排**：在跑吗 → 有多少能用 → 还能用多久 →
    还剩多少额度 → dsh 接好了没 → 再是标识信息。原先最不需要盯的「账号 UID」排在最前
    且字号最大，而「桥进程」排在第 5 张。**只换顺序，字号与样式不动。**
  - **模型表列宽**：9 列的表用全局 14px 横向内边距太费宽度（约 250px 花在 padding 上），
    挤得模型 id 与「实测成本」折行、行高在 53～89px 之间跳。短内容列改为不许折行 +
    这张表内边距收到 9px 后：1280px 下**行高完全一致（53px）**，1100px 只剩一行折行，
    窄屏的表内横向溢出也从 59/163px 降到 16/120px。
  - **切页签后回到内容顶部**：这是个 7000px 量级的长页面，滚到「可用模型」再点
    「客户端接入」时视口停在原处、文档突然变短，画面落在半空像页面坏了。
- **`tools/dev/` 纳入 lint 范围**。它原先被当作「一次性探针脚本」排除在外，
  但后来成了常驻门禁的所在地（`run-ui-tests.mjs` / `test-i18n.mjs` /
  `verify-release.mjs` / `check-i18n-coverage.mjs`）—— 排除它等于**让门禁自己不被检查**。
  实际开启时全目录只有 1 个问题，成本远低于预期。
  `.tmp-*` / `.backup/` / `.optimize/` / `dsh-plugin/vendor/` 仍排除在外。

### Fixed

- **控制台的动效与反馈缺口**（配合上面的排版优化，同样不动视觉语言）：
  - **主题切换时面板底色「啪」地跳**：`body` 有 0.2s 过渡，而面板 / 卡片 / 表格 /
    标签只过渡了 border 与阴影 —— 同一张页面上「慢的」和「瞬间的」并存，看着像坏了。
    改成切换时给 `<html>` 挂 240ms 的 `.theming` 做配色补间（**不常驻**：
    面板底色平时不变，常驻只会让轮询重绘凭空多出补间）。
    **踩到的坑**：第一版把 `.theming` 和 `data-theme` 写在同一段同步代码里，
    实测**完全没有动画** —— 过渡只在「变化之前的样式里已经有这条 transition」时才启动，
    同帧改两处浏览器只算一次样式，变化前没有 transition，颜色就直接跳过去了。
    现在顺序是：挂 class → `void offsetWidth` 强制一次样式计算 → 再改 `data-theme`。
    验证方式是在页面里用 rAF 逐帧采样 `.panel` 的计算样式：300ms 窗口内采到
    **6 个不同的 background-color**（`rgb(17,22,34)` → 中间值 → `rgb(255,255,255)`），
    这才叫在插值 —— 读 CSS 源码是看不出来这件事的。
  - **中英文切换没有任何动画**：语言切换是把全页文字**整批瞬间替换**的，
    换得太干脆，看起来像页面闪了一下或坏了重绘，不像「我按的那个键起了作用」。
    现在文字换完后给内容区一次 200ms 淡入（`langFadeIn()` + `.wrap.lang-in`）；
    刻意只淡入不位移 —— 这是 7000px 量级的长页面，位移会让滚动位置看着跳动。
    启动时 `initI18n` 落地已保存的语言走 `silent: true`，不淡（那时页面还没画完）。
    同样用逐帧采样验证：切一次语言 opacity 落到 **0.45** 再回到 1。
  - **按钮可用/禁用是硬切**：禁用态靠 `opacity` 表达，但 `button` 的 transition
    列表里没有 `opacity`。启停桥后那一跳现在有了 0.16s 过渡。
  - **告警条与「下一步」引导条收起无动画**：只有出现的 `slideDown`，点「知道了」
    整条瞬间消失、下面的内容跟着上跳，分不清是自己关掉的还是页面刷了。
    新增 `collapseAway()`：高度 + 淡出 180ms，收完再落状态（时长刻意压短，
    不挤掉 `test-r3-alerts` 点完 250ms 的断言窗口）。
  - **面板从「正在读取…」换成真内容时没有任何过渡**：用一处 `MutationObserver`
    统一处理（`initPanelFadeIn`），只在**占位符 → 内容**那一次淡入；
    每 20 秒的轮询重绘不触发 —— 页面周期性自己闪一下是噪声不是反馈。
  - **点模型 id 复制「像没反应」**：反馈只写在页面**顶部**的提示条，而模型表在
    页面约 60% 处，滚到那里点复制时提示条完全在视口外。现在走 `runCopy()`：
    就地闪一下（`.copied` / `.copyfail`）+ aria-live 播报，失败才升级到顶部提示条
    —— 与「客户端接入」面板同一套做法。相应地 `test-console-ui` 的 O8-2 断言
    从「顶部出现已复制」改成「点击处有就地反馈」。
  - **模型 id 复制键盘不可达**：原先是 `<td onclick>`，Tab 走不到也没有焦点环。
    格子里现在有一个真 `<button class="idcopy">`（外观仍是一格文本），
    Enter/Space 冒泡到同一条 handler，鼠标点整格照旧有效。
  - **aria-live 播报区藏在会被 `display:none` 的面板里**：`#clientsLive` 原先挂在
    「客户端接入」面板内，而切到别的页签时那个面板是隐藏的 —— 不可见子树里的
    aria-live **不会播报**，等于在其它页签上复制全都哑了。已提到文档顶层并改名
    `#liveRegion`，`test-clients-panel` 顺带新增断言：播报区不得在被隐藏的祖先里。
  - **轮询刷新数字变化无痕迹**：积分余额、模型数、令牌剩余每 20 秒静默换掉，
    用户分不清看到的是新数据还是自己看错了。变化的读数现在有一次 0.6s 底色脉冲
    （首帧无基线不脉冲，否则进页面整排卡都在闪）。
- **`tools/dev/test-clients-panel.mjs` 里被注入到页面的那段表达式其实是有问题的**：
  它是**模板串**，而模板串里简写的空白转义会被 JS 吃掉反斜杠 ——
  实际注入的正则是「`✓` + 若干 `s`」而不是「`✓` + 空白」，只是靠后面的 `.trim()`
  侥幸没出错。改成字符类并**把反斜杠写两层**，语义才真正正确。
  （顺带：这类注入串里写注释**不能带反引号**，会直接闭合模板串 —— 这个坑我踩了第二次。）

### Added

- **`tools/dev/test-transitions.mjs`：把「整页级切换到底有没有在动」钉成用例**。
  主题切换与语言切换都出现过「代码写了、动画没跑」而**读 CSS 看不出来**的情况，
  所以这条用例不看样式写了什么，而是在页面里用 rAF **逐帧采计算样式**：
  中间帧只要出现过既不等于起点也不等于终点的值才算通过
  （实测一次切换能采到 5–6 个不同的 `background-color`）。
  覆盖：主题双向补间、`.theming` 用完必须摘掉（常驻会让轮询重绘凭空多出补间）、
  `html.theming` 规则还在、语言切换 opacity 必须落到 0.45 再回 1。
  本机开了「减少动态效果」时整条跳过 —— 那是 `prefers-reduced-motion` 的预期行为，不是失败。
  `npm run test:ui` 现在 20 项。
- **`dsh-plugin/tests/i18n-terms.test.mjs`：把「两张 i18n 表不能漂移」钉成测试**。
  本项目零构建（控制台是直接给浏览器加载的 HTML），插件与控制台没法共享代码 ——
  i18n 表只能各带一份，于是「同一份东西存在两处」必然漂移：本会话就踩过一次
  （徽章词条在两张表里各有一份，改了一处忘了另一处）。
  现在断言两件事：两边 `I18N_TERMS_EN` **逐条一致**（不一致时报出「谁独有哪几条」）、
  以及**表的译文里不能有中文**（半翻 `'X': 'English（中文）'` 渲染扫描扫不到 ——
  它只查「有没有中文」，不查「比例」）。
  放在 `dsh-plugin/tests/` 是有意的：`npm run test:plugin` 是唯一会跑
  「仓库级纯 Node 测试」的入口，不用改任何脚本就能进 CI。

  新测试已**验证过它真的会失败**：手动只在控制台侧加一条，它立刻报
  「控制台独有：仅限新用户」；恢复后回到 2/2 通过。

## [1.4.3] - 2026-10-08

### Fixed

- **控制台：`输入 … / 输出 … tokens · 扣分 … · 用时 …` 那行只翻了前后**。
  规则里 `$3` 直接拼进去没再过一层 —— 而它可能是数字，也可能是
  `—（上游未回报）` 这个占位串，于是中间那段留在中文。
- **控制台**：`没有可导出的模型` 漏翻（导出模型清单的提示）。

### 验收

- **控制台 i18n 用例现在逐个打开下拉菜单再扫**：`.dd-item` 是**每次打开时重建**的
  （见 `initDropdowns` 的注释），不打开就不在 DOM 里 —— 只扫默认状态等于把
  菜单里的文案漏掉。实测这一遍打开并扫描了 7 个菜单。
  插件面板那边就是靠同一遍才抓到 `· 多模态` 的。
- `tools/dev/check-i18n-coverage.mjs` 补上**专有名词表**（`I18N_TERMS_EN`）的加载与
  `applyTerms` 复刻 —— 否则它会把名词表里的条目**本身**报成漏翻
  （它们是 key，整串查表当然查不到，而运行时会走子串替换翻掉）。

## [1.4.2] - 2026-10-08

### Added

- **`tools/dev/check-i18n-coverage.mjs`：从源码侧查漏翻**。
  「英文模式下扫可见中文 = 0」那套验收只能发现**已经渲染出来**的漏翻；没被桩数据
  走到、或者藏在错误分支里的文案它扫不到 —— 而用户迟早会碰上。这个工具换个角度：
  把源码里所有含中文的字符串字面量抽出来，逐条过一遍词条表与规则，翻不动的进嫌疑名单。
  它自己踩过三个坑（都写在文件里）：模板串的 `${…}` 必须换成占位值再判、
  源码字面量要反转义成运行时字符串、**整串能翻就不该再拆行判**。

### Fixed

- **权益包名与促销标签：新增「专有名词」层**。它们本属上游数据，但**用户直接看得到**，
  命名有规律且集合不封闭（上游换个促销词就多一个）。之前我只把它们当数据不翻 ——
  用户连着两次实拍指出来，说明判断错了。现在新增 `I18N_TERMS_EN`
  做**子串替换**（不是整串查表）：
  - 权益包名 `CodeBuddy个人体验版` / `CodeBuddy个人版拉新权益包` /
    `CodeBuddy个人版国内运营裂变包`，外加 `个人版` / `个人体验版` 的通用兜底；
  - 促销标签 `限时免费` / `限时折扣` / `夜间免费` / `夜间折扣` / `错峰使用`。

  **为什么要单独一层**：这些词会出现在**拼接串中间** —— 控制台的积分卡是
  `名称 余额/总量 · 名称 余额/总量 等 N 个套餐` 一整条文本节点，
  插件那边是 `月度 · 到期 2026-10-31 23:59:59` 两段 join 出来的，
  整串查表与整串规则都够不着。规则产物之后还会再过一遍这一层。
  徽章词条原先在两张表里各有一份，现在**归并到名词表**，避免两处漂移。
- **插件：权益包的计费周期行** `月度 · 到期 2026-10-31 23:59:59` 漏翻
  （桩里没给 `monthly` / `expiresAt`，这行从来没渲染过）。
- **控制台：积分卡的 `等 N 个套餐`** 漏翻（桩只给了一个包，
  `包数 > 2` 那条分支永远不渲染）。
- **控制台：`t()` 不折叠空白，导致按折叠文本写的规则对不上**。DOM 文本节点在
  `i18nTranslateNode` 里折叠过空白，而 `t()`（原生 confirm / alert 与代码里主动
  拼接用的）没有 —— 于是「写入 dsh 设置」那个二次确认弹窗**整段还是中文**。
  `translateText` 现在会**折叠空白后再试一次**（表与规则都试），换行结构由规则产物保留。
- **控制台：16 条确认弹窗 / toast / 异常态文案漏翻**（`最近 60 秒没有请求。`、
  `体检进行中，停止桥会中断本轮体检。`、`⚠ 桥有响应但异常`、
  `控制台还没取到桥的状态。`、`桥未运行，模型调用会失败。`、导出结果提示…）——
  这些分支平时走不到（要停在体检中途、要桥异常），DOM 扫描那套验收一直没发现。
  另补 `令牌将于 N 天后到期；…` 的规则（只在令牌临期时渲染）。
- **又修掉 8 处插件漏翻**（前 6 处由上面那个工具查出，后 2 处由扩展后的验收查出）：
  - 「可用模型」那一行只有数字没有推荐模型时的 `6 个`；
  - 图表 x 轴的小时刻度 `10时`；
  - **SVG 柱状图的悬停提示**（`模型名 + 调用 / tokens / 积分` 三行，整串一条）；
  - **疑似卡死的进行中请求**（` · 疑似卡死（超过 4 分 32 秒）—— …`，只有超阈值才出现）；
  - 体检结论的 `可用 · 1180ms · 实测扣分 0.02`（两段拼成一条）；
  - 对话每轮元数据末尾的 ` · 扣分 0.004`（前面还有耗时 / tokens，整串一条）；
  - 图表里的「值 + 单位 + 百分比」（`0.62 积分 (56.4%)`、`10时 · 1 次`）——
    单位嵌在**模板串内部**，不会单独过一次翻译；
  - 插件还没就绪的提示、以及待办里未知动作的兜底标签 `处理`。
- **规则顺序**：`^(.+) 次$` 的 `.+` 贪婪，会把 `10时：1 次` 整串抢走只翻尾巴
  （实测 `10时：1 calls`）。正确顺序是**专属规则 → 冒号规则 → 通用单位规则**，
  三条都不能换位（冒号规则排太前会把「登录目录：C:\…」切成两半）。

### 验收

- **逐页点开所有交互再扫**：下拉菜单（`.dd-item` 只在打开时存在）、
  **分段控件的每个选项**（切换会换掉整块内容 —— 图表的「时间趋势 / 各模型对比」、
  用量粒度、模型页筛选）、**模型详情抽屉**（一整组 DetailItem 文案）；
- 桩里补了一条 **runningMs 超阈值的进行中请求**，让「疑似卡死」那条分支进检查；
- 桩与控制台用例**抢端口**的问题一并修掉（面板脚本挪到 8810 / 8820 号段）。

## [1.4.1] - 2026-10-08

### Fixed

- **插件面板：切语言后标签指示框没有重新测量**（用户实拍：白框只包住 "Overvie"，
  `w` 掉在框外）。标签文字宽度随语言变，而计算指示框的 `useEffect` 依赖里没有语言 →
  框停在旧宽度上。`Segmented` 的指示框同理。另补了 `ResizeObserver`：英文更长会把
  标签行挤成两行，此时窗口尺寸没变、`resize` 不触发，`offsetTop` 也变了。
  （控制台没有这类滑动指示框，不受影响。）
- **插件面板漏翻一大片**：
  - **诊断页整页** —— `登录文件` / `凭据解密` / `桥服务` / `凭据引用` / `AtRest 密钥` /
    `WorkBuddy 客户端` 以及全部 detail 与 hint。这些由共用的 `lib/diagnostics.mjs`
    生成，是**我们自己库产出的界面文案**（控制台词条表里早就翻了那一整组），插件漏了；
  - 签到胶囊 `已签到（+100）`、对话页模型下拉的 `· 多模态` 后缀、
    概览的 `3 种套餐 · 更新于 …` 与 `归属账号 …（与桥一致）`、`（auto）` 这类全角括号；
  - 上游促销徽章补 `夜间折扣`（`限时免费` / `夜间免费` 上一版已补，控制台同步补上）。
- **面板脚本与控制台用例抢同一个端口**：`panel-render.mjs` / `panel-i18n.mjs` 原来用
  8795/8796，而 `tools/dev/test-r9-scope.mjs` 也用 8796 —— 两边**同时跑**时后者会
  `EADDRINUSE` 挂掉（实测踩到一次）。面板脚本现在挪到 8810 / 8820 号段，
  与控制台用例（8774~8798）彻底分开。
- 模型页那句说明里的字面 `**` 去掉 —— JS 字符串不是 markdown，会原样显示成星号。
- **`preflight.test.mjs` 的一条用例依赖「本机装了 WorkBuddy」**：它只清空
  `WORKBUDDY_AUTH_DIR`，指望 preflight 的候选列表回落到**本机真实的**登录目录 ——
  装了才走「指定的文件不存在」分支，没装就落到「找不到登录目录」分支，
  断言里没有 `不存在` 于是失败。实测表现是最难查的那种：**单独跑是绿的、
  跑全套是红的**（沙箱里读不到用户目录）。现在测试自己造一个真实存在的登录目录，
  结论不再取决于运行环境 —— 这正是该文件注释里本来就写着的要求。

### 验收（这一版的重点是「为什么第一版会漏」）

- **面板 i18n 验收跑两遍**（今日已签到 / 未签到）：面板里大量文案是「有值 / 无值」
  两支，只跑一套桩另一支永远扫不到 —— `已签到（+N）` 就是这么漏的；
- **新增「指示框必须包住当前项」的几何断言**（±2px），切英文与切回中文两个方向都查，
  而且**逐页查** —— 分段胶囊（`.wb-segmented-indicator`）只在部分页面存在，
  只在概览页量一次等于没验到它；
- **下拉菜单项只有打开时才存在**，现在逐个点开再扫；
- **修了桩的两处硬伤**：
  1. `/workbuddy/models` 原来写的是桥的**原始字段名**（`supports_images`），
     而归一化器（`lib/models.mjs`）输出的是 `images` → 对话页下拉读不到 `m.images`，
     `· 多模态` 根本没渲染，验收在**错误的地方**变绿；
  2. 「桩里的中文一律换成 ASCII」这条**一刀切**把诊断项也换掉了，而那是我们自己库
     产出的文案。现在按字段判：**上游 / 用户数据**才 ASCII 化（模型名、权益包名、
     账号、路径、对话正文、日志行），**我们自己库的输出**留着参与验收。

### Added

- **`npm run verify:release`**：把**已发布**的 tgz 下下来验一遍 ——
  与本地打包产物逐字节比对、列出包内文件、核对关键文件在不在、并把几个关键文件
  取出内容与仓库当前版本逐字节比对（防止「改了代码但打的是旧快照」）。
  `release:check` 里的 `verify:standalone` 验的是**本地** `vendor/`，
  验不到「`npm pack` 到底打进去了什么」——少打包一个文件本地门禁不会红。
  实测 v1.4.0 的发布产物与本地打包产物逐字节一致（sha256 `f94c4260…`）。

## [1.4.0] - 2026-10-08

### Added

- **dsh 插件面板中 / 英双语**：面板右上角新增语言开关（选择记进 localStorage，重开保持），
  覆盖 9 个标签页的**全部界面文案**。实现与控制台同思路（中文原文当词条 key + 一次翻译遍），
  但翻译遍落在**创建 React 元素那一层** —— 包住 `h` 之后，字符串子节点与
  `title` / `placeholder` / `aria-label` 自动过一遍 `translateText`，
  380+ 处渲染点一行都没动。数据（对话正文、日志行、上游原文、语言代码）用
  `h(Raw, { text })` 包一层绕过翻译。
  配套：`dsh-plugin/tests/panel-i18n.mjs`（断言「英文模式下 9 个标签页可见中文 = 0」，
  并同时要求每页内容够厚，防「没渲染 = 0 残留」的假绿）、`docs/plugin-panel-en.png`。
- **控制台自绘下拉**：原生 `<select>` 展开后的候选项列表由操作系统绘制（圆角改不了），
  现在换成本地绘制浮层（`.dd-menu` 圆角 12px、条目 6px、向上弹翻转、键盘可达），
  与插件面板里那份同构。原生 `<select>` 保留在常规流里（宽度仍由它决定、
  `.value` / `change` / 盒模型照旧），所以自动化用例一条都没改。
- **控制台自绘提示气泡**：替代浏览器自带的 `title` 提示框。浏览器没有禁用 `title`
  提示的开关，做法是**悬停时把 `title` 摘下来存内存、离开时装回** ——
  原生框永远不弹，而 `.title` 在任何非悬停时刻读到的都还是原值。
  聚焦时不摘（原生框本来就不在聚焦时弹，而 `title` 是屏幕阅读器读的描述）。
- `npm run panel:i18n` / `npm run panel:check`：面板 i18n 验收 / 面板全套检查。
- `tools/dev/test-ui-kit.mjs`：控制台自绘控件（下拉 + 提示气泡）的回归用例。
  钉住两件事：用户看到的是自绘那层，**且原生控件仍是真值来源**
  （`.value` / `change` / 盒模型照旧）—— 后者尤其容易在后续改动里被顺手破坏，
  而一旦破坏，所有自动化用例都会失效。
- **`npm run test:ui`**：无头用例的统一入口（判据：是否 import `./ui-harness.mjs`），
  失败时打印每个脚本的尾部输出。这次的教训就是「没有统一入口 → 没人跑 → 烂了也没人知道」。
- `tools/dev/fixtures.mjs` 新增 `consoleFixture` / `quotaFixture` / `dshFixture` /
  `checkinFailFixture`；`probeResultsFixture` 改为按 catalog 生成非空结果。
- `api-shape.mjs` 支持按路由声明 `allowExtra: true`：放行**故意**多出来的键
  （如用假令牌验「凭据绝不渲染」），但**缺失检查照旧**。
- `docs/plugin-panel-en.png`：英文面板截图（README.en.md 用）。

### Changed

- **按钮圆角统一**：`button.mini`（24px 高却只有 4px）、`.infobtn` 与 `button.tag`
  （都是 32px 高只有 4px）一律改成 8px；标签 `.tag` 用 6px（与按钮同比例、紧一档）。
  `select` / `input` 的高度从 30 / 31px 对齐到 32px，与按钮同排不再参差。
- `tools/dev/extract-ui-strings.mjs` 支持传文件路径（原先写死控制台），插件面板的
  文案清单也用它抽。
- `dsh-plugin/tests/panel-render.mjs` 的桩数据与渲染骨架抽到
  `dsh-plugin/tests/_panel-fixtures.mjs`，与 `panel-i18n.mjs` 共用一份
  （两份各写必然漂移，而桩一漂移，两边验的就不是同一个东西了）。

### Fixed

- **11 个早期无头用例长期失效**（`tools/dev/test-r1..r11`）。它们在「接口形状固化」
  那次改动之后就在 `openPage` 的桩校验处抛错，**根本没跑到断言** —— 而当时没有统一
  入口，所以没人发现。现已全部修复并通过。
- `tools/dev/api-shape.mjs` 的 `inDynamicMap` 只看直接父层 → `$.results.hy3.error`
  这类二级键被误报成「字段名写错」。已改为一路往上找根，整棵子树豁免。
- `tools/dev/test-bridge-checkin.mjs` 两处脚手架问题：`restart()` 在 Windows 上
  `kill()` 后只 sleep(300) 就起新实例（旧进程还在监听时新实例会 EADDRINUSE 退出，
  而 `waitReady()` 探到的是**旧桥**，后续断言全跑在旧实例状态上）；
  「当天上限」那一段把计数清零放在 `restart()` 之后，而
  `WORKBUDDY_CHECKIN_COOLDOWN_MS` 同时是定时器间隔、设 0 等于启动即触发，
  于是启动那几次被记漏。

### Docs

- `CONTRIBUTING.md`：`test:ui` / `panel:check` 门禁、桩数据的两条反直觉规则
  （桩不能太"干净"、故意多余键怎么放行）、面板 i18n 的 `data-wb-raw` 约定、
  以及「验收全绿但产品有问题时先查运行时报错」。
- `dashboard/README.md`：i18n 验收的扫描范围（文本节点 + 属性 + 预填 `value`）；
  新增「自绘控件：下拉与提示气泡」一节（为什么原生控件必须仍是真值来源）。
- `dsh-plugin/README.md`：语言开关与 `panel:i18n` / `panel:check`。
- `README.md` / `README.en.md`：插件双语说明 + 英文面板截图。
- `docs/ARCHITECTURE.md`：补「三类漏翻的真实成因」与「桩数据不能太干净」。

## [1.3.1] - 2026-10-08

1.3.0 的「中 / 英双语」在发布后被真实界面证伪：切到英文后**仍有成片中文**。
本版修掉全部已知漏翻，并把「验收为什么没抓到」的根因一并补上。

### Fixed

- **切到英文后整屏仍为中文**（最主要的一条）。`applyI18n` 调用了当时并不存在的
  `i18nTranslateValue`，属性翻译阶段直接抛错中断；`MutationObserver` 的回调每次
  也抛错 —— 于是**首帧之后新渲染的内容全都不翻**。这是一处运行时报错，不是词条缺失，
  所以「补词条」永远补不好。
- **悬停可见的 `title` / `aria-label` 全是中文**（复制按钮、Base URL、API Key、
  成本口径说明、模型选择器徽章、体检失败项的上游错误原文 …共 21 处）。
  这些是**属性**而不是文本节点，原先的验收只走 `TreeWalker` 扫文本节点，
  所以一条都没抓到。
- **规则优先级反了**：通用规则 `^(.+) 次$` 排在图表专用规则前面，把
  `最近 3 天调用次数图，合计 24 次` 整串抢走，翻成「…合计 24 calls」这种半英半中。
  具体规则现在统一集中在规则表**最前面**，并在注释里写明这条约束。
- **`#promptInput` 的预填文案**：`value` 既不是文本节点、也不在可翻属性集里，
  单独标 `data-i18n-value` 处理。`value` 与属性不同 —— 用户随时会改它，所以
  只在「当前值仍等于页面自己写进去的那个」时才翻，用户编辑过就绝不动。
- 拼接串的尾空格：`桥已就绪。下一步：` 的译文缺尾空格，拼出来是 `Next:Fill …`。
- 词条表里重复的 `测得时间` 规则（同一行写了两遍）。

### Changed

- **`tools/dev/test-i18n.mjs` 不再会"假绿"**：
  - 扫描范围加上 `title` / `placeholder` / `aria-label` / `alt` / `data-prompt`
    与 `data-i18n-value`（上面 21 处就是这么被找出来的）；
  - 桩数据改成**故意「脏」**：打开「桥已就绪」提示条、给模型挂促销标签、
    体检结果不再为空 —— 这三处原先整块不渲染，扫描扫到 0 个中文就"通过"了；
  - 新增断言钉住提示条、促销标签、体检结果标签、表头时间线、`实测成本` 列。
- **`tools/dev/fixtures.mjs`**：`probeResultsFixture` 默认**按 catalog 生成**非空
  体检结果（含一个失败样本），不再返回空对象。写死几个 id 会让换了目录的截图脚本
  出现「表里 4 个模型、结论却是另外几个 id」的错位。
- **`tools/dev/api-shape.mjs`**：动态映射（`results.<模型 id>`）的豁免范围从
  「直接父层」扩到**整棵子树**。原先 `$.results.hy3.error` 这类二级键会被误报成
  「字段名写错」——因为捕获那次 `hy3` 恰好是成功的，`error` 没被记进形状表。
- `docs/ARCHITECTURE.md`：补上「三类漏翻的真实成因」与「桩数据不能太干净」，
  并说明验收的盲区是怎么形成的。
- `docs/screenshot.png` / `docs/screenshot-en.png` 重出（体检列现在有真实内容）。

## [1.3.0] - 2026-10-08

### Added

- **控制台中 / 英双语**：右上角 `EN` / `中` 开关（选择记进 localStorage，刷新保持），
  覆盖外壳、全部面板、表头、按钮、下拉选项、空态、提示，以及**复制到剪贴板的文本**
  （诊断报告 / 接入信息）。实现是「中文原文当词条 key + 一次 DOM 翻译遍 + 拼接串正则
  规则表」，**渲染代码零改动**（取舍见 `docs/ARCHITECTURE.md` §四）；对话正文与桥日志
  是数据，明确排除。配套：`tools/dev/test-i18n.mjs`（断言「英文模式下可见中文文本节点
  = 0」，并打印残留清单）、`tools/dev/extract-ui-strings.mjs`（找该翻哪句）、
  `docs/screenshot-en.png`（英文界面截图）。
- **客户端凭据分层**：`WORKBUDDY_CLIENT_KEYS` 支持每客户端独立 key（内存只存
  SHA-256 哈希）：独立记账（账本 `client` 字段 = 哈希前 8 位，明文不落账）、
  独立限流桶、删除某把即单独吊销（重启生效）；`LOCAL_TOKEN` 仍是管理面万能
  钥匙。默认空 = 功能关，行为与之前完全一致。
- **`docs/openapi.yaml`**：21 个端点的机器可读描述（OpenAPI 3.1，人工维护）。
- **`CONTRIBUTING.md`**：先红后绿 / 真产物交叉校验 / vendor 约定 / 发版三步 /
  不做清单，以及「上游观察」纪律。
- **Docker + 跨平台 CI**：非 root 容器（API key 网关模式，带 /health 健康检查）；
  CI 增 ubuntu/macos 矩阵（跑除独立演练外的门禁子集）。
- **npm 发布形态**：插件包解除发布锁（`private: false`），发布动作需 npm 账号，
  步骤见 `dsh-plugin/README.md`；GitHub 直装始终可用。
- **`README.en.md`**：英文概览（完整文档仍为中文）。
- **README「把安装交给 Agent」**：一段可粘贴的安装提示词（判定 → 安装 → 验证）。

### Changed

- **定位决策（2026-10-08）：走「可分发产品」线** —— README 免责与生态披露前置、
  接受社区分享；同时红线不变（单账号、不转售 / 托管、凭据不落盘）。
  本条目下的批次三 B 线动作随之落地（见上）。
- **决策记录：多账号池不做（批次四关闭，2026-10-08）** —— 池化与「单账号」
  红线和可分发定位直接冲突，且会加速上游收紧、殃及所有用户；差异化立场保持
  **单账号 · 凭据不落盘 · 零运行时依赖 · 单文件自包含**。
- **静态检查入门禁**：`tsc --checkJs`（生产代码 0 错误）+ ESLint（minimal 配置，
  抓到并修复 `tools.mjs` 一处潜在 ReferenceError 等 12 项）；`release:check`
  现包含 `check:types` 与 `lint`。devDependency 新增 typescript / eslint /
  @types/node / globals —— **零运行时依赖的承诺不变**。
- **控制台窄屏头部允许换行**：英文文案更长，390px 下 `状态戳 + 徽章 + 语言 / 主题 /
  刷新` 会顶破一行（实测横向溢出 7px，整页出现滚动条）；`.head-right` 加 `flex-wrap`
  兜住。中文布局本来就不满行，视觉零变化。
- **`tools/dev/api-shape.mjs`：捕获为 `null` 的父层不再报「多余键」** ——
  例如捕获时没开自动签到，`bridge.autoCheckin` 记成 `null`，这不构成
  「它不该有子键」的证据。缺失方向与多余方向现在用同一条判据。
- **`tools/dev/fixtures.mjs`**：`/api/requests` 桩补上批次二新增的
  `active` / `activeAlertMs`，否则打桩会被形状校验拦下。

## [1.2.0] - 2026-10-08

### Added

- **Anthropic Messages 兼容层**：`POST /v1/messages`（流式事件序列、`tool_use`、
  多轮 `tool_result` 往返均按 Anthropic 规范翻译）—— Claude Code 可直连使用；
  控制台新增「客户端接入」面板（两套协议的 Base URL / 令牌、各客户端配置片段与
  **如实的兼容性分档**）。
- **上游连接池**：keep-alive 复用 TLS 会话，首 token 延迟显著降低
  （实测热连接 ~82ms vs 每次重建 ~150ms）。
- **客户端定位多级探测**（修「换目录重装就不识别」）：显式覆盖 → 默认安装位置 →
  磁盘浅扫描 → 系统信号兜底（运行中进程路径 / 注册表安装记录）；多客户端并存时
  按登录文件信封的 keyId 挑对 build。DSH Desktop 运行时同款探测；两处各有
  自包含单测（共 11 用例）。
- **出站审计模板最小改写**：上游逐字拉黑 Claude Code 的固定 system 模板
  （实测 `400 Illegal API invocation from an unapproved channel`），桥在出站层
  做最小改写（`CLI`→`CLI tool`、`Main branch`→`Default branch`）后恢复可用；
  打桩上游回归测试钉死「出站不含黑名单原文」。
- **出站身份可配置**：`WORKBUDDY_APP_VERSION` / `WORKBUDDY_IDE_VERSION` /
  `WORKBUDDY_IDE_NAME`（上游版本漂移时改 `.env` 即可，不必改源码）。
- **本地限流（opt-in，默认全关）**：`WORKBUDDY_RATE_LIMIT_RPM`（每分钟上限）与
  `WORKBUDDY_RATE_LIMIT_MIN_INTERVAL_MS`（最小间隔）两个旋钮；超限默认排队等待，
  `WORKBUDDY_RATE_LIMIT_MODE=reject` 改为 429 + `Retry-After`；被限流的请求只进
  账本（`rate_limited` 归因），不打上游。这是「保护账号配额」的唯一机制。
- **开销可度量**：对话响应带 `X-WorkBuddy-Overhead-Ms`（上游请求发出前的桥前置
  处理耗时）；`/health` 新增 `process` 段（真实请求数 / 错误数 / 状态码分布 /
  限流触发数，健康探活不入账）；`tools/dev/bench-overhead.mjs` 可复现耗时分布。
- **卡死请求可见**：`/v1/requests` 新增 `active[]`（进行中请求的 id/模型/已运行
  时长），控制台「最近请求」顶部显示「进行中」区块、超 `WORKBUDDY_ACTIVE_ALERT_MS`
  （默认 5 分钟）标黄提醒「疑似卡死」。**不加任何默认超时**——只显示、不干预。
- **`POST /v1/messages/count_tokens`**（Anthropic 规范同形）：本地估算、不打上游；
  估算区分 ASCII 与非 ASCII（CJK 按字计），如实标注"估算"。
- `/health` 新增 `clientExe`（桥在驱使哪个客户端可执行文件，只读缓存不触发探测）。
- 控制台：动效与紧凑吸顶 / 一键回顶部、客户端接入「先选后展开」、模型自选、
  数据排版（等宽数字、数值列右对齐）、可访问性与降级（`prefers-reduced-motion`）。

### Fixed

- 控制台识别改用**结构标记**（`id="navTabs"`，品牌改名不再误判 `foreign`），
  并补真产物交叉校验测试（纪律：读外部资源的常量必须有对真实产物的断言）。
- `probe()` 有界读取：不再依赖「识别标记落在首个网络 chunk 内」这一未经保证的前提。
- 探测缓存不再「假死」（客户端卸载 / 移动后旧缓存自动失效重探）；
  注册表单元素记录不再丢失（PowerShell 单元素数组退化归一化）。
- 自动签到不生效 + dsh 模型选择器只列 3 个模型。
- 两个「客户端只看到 500 / 连接重置」的后端 bug；`/api/overview` 不再被慢上游
  拖住（曾整页卡 14 秒，本地数据与上游查询解耦）。
- 安全类：模型 id 注入 dsh 配置、本地服务 Origin 校验、日志行数上限、
  刷新失败不落盘令牌等 8 项（两轮审计，见 git 历史）。

### Changed

- 每日签到改为「直接签、签完即停」（去掉每小时探测，签完不做多余检测）。
- 项目定位重述：从「dsh 中转」改为「WorkBuddy 本地 API 桥」——功能不变，
  README 与文案对齐（dsh 插件仍是可选层）。
- 测试基建：桩数据的接口形状固化 + 打桩前自动校验（「桩数据不再骗人」）。

### Docs

- README 配图与措辞整理；注意事项新增「计费口径自行核对」（含核对方法）。
- TROUBLESHOOTING 补「上游版本漂移」「审计模板拉黑」条目与处置；
  SECURITY 新增「计费与用量核对」一节；CONFIGURATION 更新多级探测说明；
  ARCHITECTURE 新增「性能主张与复现方式」（可执行命令）。

## [1.1.0] - 2026-10-05

- dsh 模型选择器：显示推理等级并下发给上游；模型显示偏好（控制选择器出现哪些模型）。
- 仓库根声明 `dsh.bundle`：`dsh plugin add github:…` 一条命令直装。
- 自动签到发生后界面可感知（事件驱动，替代轮询）；控制台停止桥不再阻塞事件循环。
- 控制台折线图/长度过渡动效、截图与文档整理；安全与稳定性修复若干。

## [1.0.0] - 2026-10-04

- 首次发布：把 WorkBuddy 桌面端已登录的模型配额，经本地回环桥暴露为
  OpenAI 兼容接口（`/v1/chat/completions`、`/v1/models`），附网页控制台
  （状态 / 启停 / 诊断 / 模型注册 / 用量 / 体检 / 对话测试）与 DeepSeek Harness 原生插件。
- AtRest 凭据解密：以 `ELECTRON_RUN_AS_NODE=1` 调用客户端原生绑定取密钥，
  无任何密钥落盘。
