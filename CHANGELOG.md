# Changelog

本项目所有值得注意的变化都记录在这里。格式参考
[Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## 维护约定（发版三步）

1. `npm run release:check` 全绿（vendor 同步 + lib 单测 + 插件测试 + 独立分发演练）；
2. 把本次变化落进本文档的 `[Unreleased]` 段 → 转成版本条目；版本号写进 `package.json`；
3. `git tag vX.Y.Z` 并推送。

只支持最近 2 个 minor 版本。

## [Unreleased]

（无）

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
