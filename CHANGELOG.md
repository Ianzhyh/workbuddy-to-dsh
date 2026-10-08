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

## [Unreleased]

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
