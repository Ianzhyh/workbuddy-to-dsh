# WorkBuddy 本地 API 桥 —— 同类竞品调研与差距分析报告

> 调研对象：`E:\workbuddy-to-dsh`（WorkBuddy 本地 API 桥 + DeepSeek Harness 原生插件，v1.2.0）
> 报告日期：2026-10-07；**第二轮补充与全盘校准：2026-10-07 晚（复核点 HEAD `f30eee9`）**
> 数据来源：本仓库源码实测 + 各竞品官方 README / 文档站 / npm registry / GitHub API 直抓
> 第二轮新增：`gh` CLI（GitHub API，逐仓实测 Star / 最近提交 / 许可）+ 16 份 README 原文快照 + 生态搜索（WebSearch 本轮恢复可用）
> 所有「实测」结论均附可复核命令或文件行号；外部结论均附 URL。

---

## 0. 结论先行

| 维度 | 本项目水平 | 与头部竞品的差距性质 |
|---|---|---|
| 功能完整性 | 中上（协议面宽，管理面深） | **差在广度**：无多账号池化、无 embeddings、无指标端点、无 Docker；而直接竞品群已把「多账号池化 / Web 面板 / 任务自动化」做成标配（§3.1、§5.7） |
| 技术选型 | 优（零依赖 / 单文件自包含，罕见优势） | **是差异化优势，不是短板**；短板在 Windows 单平台 |
| 架构设计 | 良（进程分层清晰、单写者纪律严格） | 差在**可扩展机制**：无适配器注册表，加 provider 要改核心文件 |
| 性能表现 | 中（keep-alive + SWR + 缓存分层做得细） | 差在**可度量**：无任何指标端点，性能主张无法自证 |
| 用户体验 | 优（控制台信息密度与诚实度超过多数竞品） | 差在**安装形态**与 i18n |
| 文档质量 | 优（注释密度与「为什么」记录是顶级水准） | 差在**文档工程化**：无独立文档站、无 CHANGELOG、无 OpenAPI |

**一句话**：本项目的**工程素养与文档诚实度已经超过多数同类项目**，真正的差距不在「写得好不好」，
而在**产品化与可运营化**——它把自己定位成「个人自用工具」并在文档里反复声明，
但代码里积累的管理能力（9 标签页控制台、用量账本、积分体系）已经远超「自用」所需，
这个错位是当前最大的战略性问题。

**三处必须立即处理的事（第二轮补充后已更新）**：
1. **P0 缺陷已修复 2/4**（§6.0，当晚复核）：初稿记录的「控制台识别失效」回归缺陷与
   `vendor` 不同步已由当日提交 `f30eee9` 等修复（结构标记 + 真产物交叉校验），`release:check` 全绿；
   仍开放：`probe()` 首块读取的加固、README 注意事项重复段。
2. **参照物不仅消失，而且是连续消失**（§3、§8.6 风险 4）：copilot-api 停更约 11 个月、
   活跃度转移到 fork；而离本项目更近的原版 `Sliverkiss/workbuddy2api` 已经**删库**
   （2026-09-24 从 GitHub 消失，本报告实测 404）。维护可持续性已不是理论风险。
3. **直接同目标生态已经存在，「导出配额」不再是独特卖点**（§3.1，全部 GitHub API 实测）：
   「把 WorkBuddy / CodeBuddy 配额变成标准 API」至少有 **20+ 个活跃项目**（最高 2,136★，
   创建不到 1 个月），dsh 侧还有 **10+ 个同目的插件**（最高 313★）。
   本报告的 §3 / §5 / §7 / §9 已按这一事实重写；claude-code-router 的反向集成（§4.3.1）仍然成立，
   但它只是这个拥挤生态里的一个方向。

---

## 1. 调研方法与数据可信度

| 手段 | 说明 |
|---|---|
| 源码实测 | 通读核心源码（项目自有源码 + 前端共 31,544 行，其中测试 3,573 行）；跑 `npm run test:plugin` / `release:check`（本次复核均通过）；写临时探针脚本实测运行时行为（探针已清理） |
| 竞品一手资料（第一轮） | `raw.githubusercontent.com` 抓 README 原文、`registry.npmjs.org` 抓包元数据、`cdn.jsdelivr.net` 抓 README/LICENSE、`img.shields.io` 抓 star/license 徽章 |
| 竞品一手资料（第二轮） | **`gh` CLI（已登录，GitHub API 实测）**：38 个仓库的 star / fork / 许可 / 创建日 / 最近 push 逐仓核对；`gh api repos/<r>/readme` 直抓 16 份 README 原文存快照；`gh search repos` 做生态扫描（§3.1、§3.2 的规模数字均来自该扫描） |
| 第一轮未采用 | 初稿写明「`web_search` 全程 401 不可用」；**第二轮搜索已恢复**，用于发现候选项目——但所有入选项目仍回到 GitHub API / README 原文取证，不依赖搜索引擎摘要 |

> 可信度声明：**Star / 最近提交 / 许可已在第二轮由 GitHub API 逐仓实测（2026-10-07；头部项目 2026-10-08 二次复核，数值已更新），不再是徽章缓存约数**；
> 外部结论仍以各项目官方 README 自述为主，凡属推断均已标注（如「生态滥用 → 上游收紧」的因果部分）。
> 竞品 README 快照保存在本机临时目录（`%TEMP%\wb-research\`，16 份），复核命令见附录。

---

## 2. 本项目画像（基线）

### 2.1 定位与目标用户

- **定位**：把本机 WorkBuddy 桌面端已登录的模型配额，经本地回环桥暴露为
  OpenAI 兼容 + Anthropic 兼容双协议，供任意客户端调用；另提供 dsh 原生插件。
- **目标用户**：已订阅 WorkBuddy、同时使用 Claude Code / opencode / Cursor 等
  多种客户端的**个人开发者**。
- **许可**：MIT。

### 2.2 实测规模

| 项 | 数值 | 取证方式 |
|---|---|---|
| 源码 + 前端行数 | **31,544** 行 / 79 文件（不含 vendor 快照与工具缓存目录） | 换行符计数，与 read 工具口径一致（见文末附注命令）；2026-10-07 晚复核值，初稿的 31,531 为当日更早状态 |
| 测试代码 | **3,573** 行 / 10 个 `*.test.mjs` | 同上 |
| 控制台前端 | `dashboard/public/index.html` 4,275 行（单文件） | 同上 |
| 桥本体 | `bridge/workbuddy-bridge.mjs` 2,618 行（单文件自包含） | 同上 |
| 测试用例 | 74 用例（插件）+ 12 用例（桥合约），共 **86** | `npm run test:plugin`、`node --test bridge/bridge.test.mjs` |
| npm 依赖 | **0**（`dependencies` 与 `devDependencies` 均为空） | `package.json` |
| CI | 1 个 workflow（Windows runner） | `.github/workflows/release-check.yml` |

**文档规模**（换行符计数）：`ARCHITECTURE.md` 587 · `dsh-llm-adapter-contract.md` 1,643 ·
`dashboard/README.md` 529 · `TROUBLESHOOTING.md` 386 · `dsh-plugin/README.md` 366 ·
`HANDOFF-dsh-plugin.md` 332 · `DESIGN_SYSTEM.md` 264 · `IMPLEMENTATION-NOTES.md` 160 ·
`INSTALL.md` 131 · `CONFIGURATION.md` 131 · `SECURITY.md` 99 · 根 `README.md` 395 ·
`.env.example` 54。

### 2.3 功能范围（实测）

**协议端点**（`bridge/workbuddy-bridge.mjs:2082-2550`）：

| 端点 | 状态 |
|---|---|
| `POST /v1/chat/completions` | ✅ 完整（含流式聚合、tools、多模态） |
| `POST /v1/messages` | ✅ Anthropic 双向翻译层 |
| `GET /v1/models` | ✅ 双端点合并目录 |
| `GET /health` | ✅ 只读缓存，毫秒级 |
| `GET /v1/quota`、`/v1/usage`、`/v1/requests`、`/v1/checkin` | ✅ 管理面 |
| `POST /v1/embeddings` | ⛔ **有意 501**（上游无 embedding 模型） |
| `/metrics`、OTel | ❌ 不存在 |

**管理面**：控制台 13 个 API 路由 + 9 个标签页设置界面 + 5 个 agent 工具 + 斜杠命令。

**关键工程能力**（这部分超出多数竞品）：
- AtRest AES-256-GCM 信封解密（密钥**不落盘**，向客户端进程现取）
- 双上游网关（国内 / 国际）自动路由
- 双目录端点合并 + 精选模型补齐 + 促销徽章解析
- 积分余额 / 每日签到（幂等 + 自动 + 冷却）
- 本地用量账本（只记元数据，含失败归因）
- 8 项环境诊断，页面与 CLI 共用同一 `lib/diagnostics.mjs`

---

## 3. 案例概览

选取标准：**同样解决「把某个订阅/账号的模型配额，经本地或自建网关变成标准协议接口」**，
且目标用户（个人开发者 / 小团队）与核心功能（协议兼容层 + 账号管理 + 用量可视）高度重合。

第一轮按此标准只在「通用网关 + copilot-api」里选了 5 个；第二轮把范围扩到**同形项目全谱系**
（见 §3.1 / §3.2），发现初稿漏掉了最大的一类：**与本项目目标完全相同的直接竞争者**。

| # | 项目 | Star（API 实测） | 语言 | 许可 | 最近提交（API 实测） | 一句话定位 | 与本项目的关键差异 |
|---|---|---|---|---|---|---|---|
| 1 | [ericc-ch/copilot-api](https://github.com/ericc-ch/copilot-api) | 4,142 | TypeScript / Bun | MIT | ⚠️ **2025-11-10（停更约 11 个月）** | 把 GitHub Copilot 反向工程成 OpenAI + Anthropic 兼容服务 | **形态最接近的同类**：同为「订阅额度→本地协议兼容层」。活跃 fork：[caozhiyuan/copilot-api](https://github.com/caozhiyuan/copilot-api)（1,073★，2026-10-07 有提交） |
| 2 | [router-for-me/CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) | 54,405 | Go | MIT | ✅ 当天 | 为 CLI 提供 OpenAI/Gemini/Claude/Grok 兼容接口的多账号代理 | 多账号轮询 + OAuth + Management API + Go SDK + 插件体系；**直接竞争生态里的 `workbuddy-cliproxy` 就是它的插件（§3.1 W4）** |
| 3 | [musistudio/claude-code-router](https://github.com/musistudio/claude-code-router) | 37,582 | TypeScript / Node 22 | MIT | 2026-09-26 | Claude Code 本地路由网关 + Web 管理 UI | 有 Web UI 与 client key 体系、SQLite 持久化；**⚠️ 已把 WorkBuddy 作为一等 Agent 支持（反向集成，见 §4.3.1）** |
| 4 | [QuantumNous/new-api](https://github.com/QuantumNous/new-api) | 49,355 | Go + React 19 | AGPLv3 | ✅ 当天 | 面向团队的自托管 AI 网关 | 完整用户/额度/计费体系、7 语言 i18n、Docker 全家桶 |
| 5 | [BerriAI/litellm](https://github.com/BerriAI/litellm) | 60,286 | Python（新 Rust 核） | MIT + 企业目录 | ✅ 当天 | 100+ LLM 的 OpenAI 格式网关 | 文档工程、可观测性、provider 扩展机制的行业标杆 |

> 「Star / 最近提交」第一轮用的是徽章实测，**第二轮已全部改为 GitHub API（`gh` CLI）逐仓核对（2026-10-07~08）**。
> **copilot-api 已停更**是初稿最意外的发现：仓库内有多条 issue 标题直接写着
> 「THIS REPOSITORY IS NO LONGER MAINTAINED — PLEASE USE THE ACTIVE FORK INSTEAD」，
> 指向 `caozhiyuan/copilot-api`（实测 1,073★，2026-10-07 当天有提交；原仓停更 ≈11 个月）。
> **因此本项目应当「抄它的交互设计」，但不应把它的工程实现当作可依赖的底座。**
>
> 反面对照：`xtekky/gpt4free`（66,766★，GPL-3.0，仍在日更）—— 同为「多 provider 适配 + OpenAI 兼容壳」，
> 但依赖浏览器 Cookie/HAR 反向工程，无虚拟 key / 预算 / 限流 / 成本追踪，
> 上游改版即失效。**它的存在说明本项目刻意不做的事（不逆向密钥、不伪造能力）是对的。**

### 3.1 第二轮补充：直接同目标集群（WorkBuddy / CodeBuddy → API / dsh）——初稿遗漏的最大一类

**发现方式与规模**（2026-10-07，`gh search repos` 实测）：`workbuddy2api` 关键词命中 **≥100 个仓库**；
`workbuddy` 排序前 40 名里约一半与「账号 / 额度 / 自动化」相关；`dsh workbuddy` 命中 **≥40 个仓库**
（均触搜索上限截断）。这些项目与本项目是**逐字意义上的同类**：相同的上游（腾讯 WorkBuddy / CodeBuddy 云：
国内 `copilot.tencent.com`、国际 `workbuddy.ai` ——与本项目桥处理的正是同两个网关域，
`bridge/workbuddy-bridge.mjs:255-265` 可对照）、相同的动作（读取本机登录态 → 转发 → 转成标准协议）、
相同的用户（想把订阅复用到别的客户端）。

**筛选口径**：下表只保留**提供独特机制**或**与风险 / 决策直接相关**的项目；
同质且无新增信息的一律合并为一行（名单附在表下）——本报告的目标是决策参考，不是项目普查。

#### A. 网关 / API 型（初稿完全遗漏）

| # | 项目 | Star | 语言 | 许可 | 最近提交 | 一句话定位 | 为什么值得单列（筛选理由） |
|---|---|---|---|---|---|---|---|
| W1 | [linguo2625469/workbuddy2api-panel](https://github.com/linguo2625469/workbuddy2api-panel) | **2,136** | Go | MIT | 2026-10-06 | 多账号网关 + Web 面板 + 积分任务自动化 | **深度分析见 §4.6**；上游删库后的增强分支，创建 27 天即 2,100+★ |
| W2 | [ithtelab/workbuddy-manager](https://github.com/ithtelab/workbuddy-manager) | 822 | Python | MIT（README 标注） | 2026-10-05 | 账号池管理控制台（打包上游网关） | 「面板不侵入上游、只负责呈现」的分层架构；扫码批量纳管、分组、密钥分发、IP / 模型白名单 |
| W3 | [ardeyouxipianyi/workbuddy2api-hub](https://github.com/ardeyouxipianyi/workbuddy2api-hub) | 689 | Python | MIT | 2026-10-07 | 国际 + 国内双版本多账号网关 | 原生 Responses 协议（Codex / Claude Code）；四条限流护栏 + 429 模型级冷却；按 API Key 归属看板；任务自动化全家桶 |
| W4 | [lovingfish/workbuddy-cliproxy](https://github.com/lovingfish/workbuddy-cliproxy) | 194 | Go | MIT | 2026-07-08 | CLIProxyAPI 插件形态 | 记录了上游内容审核的逐字黑名单（§8.6 风险 1）；clean-room 重建二进制插件的做法 |
| W5 | [HanawaBanana/workbuddy2api](https://github.com/HanawaBanana/workbuddy2api) | 64 | Go | MIT | 2026-10-06 | 删库原版的延续副本 | 生态事件的第一手样本（§8.6 风险 4） |
| W6 | [xiaofan6ya/workbuddy2api](https://github.com/xiaofan6ya/workbuddy2api) | 57 | Python | MIT | 2026-09-29 | 桌面登录态 + 风控头 → 三协议 | 复用官方 Turing Shield SDK 生成 `X-Device-Token`（§8.6 风险 5）；按 Key 配额硬拒绝；长上下文压缩投影 |

> **合并项（同质、未提供新增机制）**：[codebuddy2api](https://github.com/ShouZhuo0413/codebuddy2api)（335★，双协议）·
> [cli2api](https://github.com/caigee-cmd/cli2api)（330★，SQLite 多账号路由）· [agent2api](https://github.com/aimod-cc/agent2api)（305★，十产品合一）·
> [TraeWorkAssistant](https://github.com/smart-open/TraeWorkAssistant)（225★，五应用桌面工具）· [CangShui/workbuddy-gateway](https://github.com/CangShui/workbuddy-gateway)（216★，无许可文件）·
> [workbuddy2api-gui](https://github.com/linbeize/workbuddy2api-gui)（52★，可视化壳）。它们的形态与上表同构（读登录态 → 反代），读者无需逐个细读。

#### B. dsh 插件型（与本项目 dsh 侧直接竞争；宿主平台 DSH 官方仓库 245,033★）

| # | 项目 | Star | 语言 | 最近提交 | 一句话定位 | 与本项目的关键差异 |
|---|---|---|---|---|---|---|
| D1 | [corrinehu/dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect) | 313 | TS | 2026-10-07 | WorkBuddy 双版本模型零配置接入 dsh | **深度分析见 §4.7**；版本矩阵 ↔ 宿主内核的维护负担有完整公开记录 |
| D2 | [XDTrees/dsh-workbuddy-xdpool](https://github.com/XDTrees/dsh-workbuddy-xdpool) | 49 | TS | 2026-10-02 | 多账号池 + 积分自动化 | 自动发现全部历史登录账号、429 冷却换号、4 种分配模式（含 sticky——因上游缓存按账号隔离） |
| D3 | [molly-ovo/dsh-workbuddy-oauth](https://github.com/molly-ovo/dsh-workbuddy-oauth) | 1 | TS | MIT（README 标注） | 2026-10-02 | OAuth 设备码直登 | **不读桌面端凭据、不需要安装 App** —— 凭据获取的第二条路径 |

> B 类还有 tearslee（插件托管网关进程，与本项目「插件把桥管起来」同构）、masknull（侧栏额度常显）、
> zz991、zlZayn、iceloon、pbwheel、seettm、Vithur 等更小的同目的插件（合计 ≥10 个），
> 形态与上表同构，不再单列。
> **本项目的 dsh 插件不是「少数派」，而是在一个已经拥挤的细分市场里**；社区维护的插件市场
> （[imsai-sh 精选列表](https://github.com/imsai-sh/awesome-deepseek-harness-plugins)）宣称收录 11,000+ 插件。
>
> 生态里还有大量不做 API、只做客户端辅助的同类工具，可见度同样高于本项目：
> [babygoton/WorkDaddy](https://github.com/babygoton/WorkDaddy)（1,724★，桌面增强）、
> [changexbc/workbuddy-switch](https://github.com/changexbc/workbuddy-switch)（1,043★，账号切换 + 积分监控）、
> [88lin/workbuddy-auto-signin](https://github.com/88lin/workbuddy-auto-signin)（1,010★，签到自动化）。
> **这个产品的周边需求是真实且庞大的**——既是机会的证明，也是拥挤的证明。

### 3.2 第二轮补充：同形但不同目标（其他编辑器 / 终端的额度导出）

同一件事——**把另一个闭源客户端的订阅额度，变成标准协议接口**——在别的产品上也在发生：

| # | 项目 | Star | 语言 | 许可 | 最近提交 | 一句话定位 | 对本项目的参考价值 |
|---|---|---|---|---|---|---|---|
| S1 | [justlovemaki/AIClient2API](https://github.com/justlovemaki/AIClient2API) | **8,849** | JS | GPL-3.0 | 2026-10-06 | Antigravity / Codex / Grok / Kiro 等多客户端统一代理 | 账号池 + 智能路由 + 自动降级的产品化上限；Docker 拉取 >10 万；TLS 指纹 sidecar（uTLS）绕 Cloudflare；README 内嵌按日期的更新日志 |
| S2 | [jwadow/kiro-gateway](https://github.com/jwadow/kiro-gateway) | 2,304 | Python | AGPL-3.0 | 2026-05-18（停滞 ≈5 个月） | Kiro IDE / CLI 额度 → OpenAI + Anthropic | **深度分析见 §4.8**；与本项目形态最像（单上游 + 双协议 + 多账号 failover） |
| S3 | [ankitcharolia/kiro-gateway](https://github.com/ankitcharolia/kiro-gateway) | 82 | Python | AGPL-3.0 | 2026-10-07 | 「合规优先」变体：驱动官方 kiro-cli 二进制 | 对照路线：不逆向协议、只驱动官方程序 |

> **这批数据里藏着一条尖锐的规律（§8.6 风险 4 展开）**：单目标、单作者、依赖某个闭源客户端私有协议的
> 导出项目，**绝大多数在 3–12 个月内停更**（copilot-api 2025-11 停、Zed2API 2026-02 停、Warp2Api 2025-09 停、
> Cursor-To-OpenAI 2026-03 停、主 Kiro-gateway 2026-05 后停滞）；活下来并持续扩张的是
> **多目标聚合型**（AIClient2API、CLIProxyAPI）与**深度绑定宿主生态的插件型**（WorkBuddy 集群的 panel / hub / manager）。
> 本项目属于「单目标导出」这一档——这是需要正视的结构性位置，也是 §9 战略判断的核心输入。

---

## 4. 逐案例深度分析

### 4.1 copilot-api（形态最接近的同类）

**核心功能范围**
暴露 `POST /v1/chat/completions`、`GET /v1/models`、`POST /v1/embeddings`
（**真的实现了 embeddings**）、`POST /v1/messages`、`POST /v1/messages/count_tokens`，
以及 `GET /usage`、`GET /token`。提供 Web 用量仪表盘（托管在 GitHub Pages，
通过 `?endpoint=` 指向本地服务）。**限流控制是显式产品功能**：
`--rate-limit <秒>` + `--wait`（限流时等待而非报错）+ `--manual`（逐请求人工审批）。
四种命令：`start` / `auth` / `check-usage` / `debug`（`debug --json` 输出诊断）。
（[README](https://cdn.jsdelivr.net/npm/copilot-api@0.7.0/README.md)）

**技术方案**
Bun + TypeScript，Hono 框架 + srvx，`citty` 做 CLI，`undici` 做 HTTP，`zod` 做校验，
`gpt-tokenizer` 做 token 计数。依赖约 11 个（[npm 元数据](https://registry.npmjs.org/copilot-api/0.7.0)）。
构建用 `tsdown`，发布走 `bumpp`；**工程化配置齐全**：eslint（含自定义 config 包）、
knip（未用代码检测）、prettier-plugin-packagejson、simple-git-hooks + lint-staged 预提交。
分发形态三套：`npx` 直跑、Docker（多阶段构建 + 非 root 用户 + healthcheck + 固定基础镜像版本）、
源码运行。

**产品设计**
`--claude-code` 标志是**体验亮点**：交互式选主模型与小快模型，然后把配好的环境变量命令
**自动复制到剪贴板**，用户粘贴即用。同时也支持手写 `.claude/settings.json`。
认证支持交互式 OAuth，也支持直接传 GitHub Token（面向 CI/CD）。
`check-usage` 不需要起服务就能在终端看配额。

**文档质量**
README 结构清晰（Overview / Features / Prerequisites / Installation / 
Command Line Options 表格 / API Endpoints 表格 / Example Usage / Troubleshooting）。
**两处 `[!WARNING]` 前置声明**做得比本项目更醒目：明确写了「反向工程、GitHub 不支持、可能突然失效」，
还专门引用 GitHub 可接受使用政策与 Copilot 条款，警告自动化批量请求会触发滥用检测、可能导致封号。

**值得本项目注意的**：这是与本项目**风险画像几乎相同**的项目，但它的免责声明
比本项目更靠前、更具体、带上游条款链接；而它的 `--rate-limit` 是**产品级功能**
（本项目只在文档里「建议不要高频调用」，代码里没有任何限流）。

---

### 4.2 CLIProxyAPI（多账号与生态的标杆）

**核心功能范围**
为 CLI 提供 OpenAI（含 Responses）/ Gemini（含 Interactions）/ Claude / Codex / Grok
兼容接口。支持 OAuth 登录 Claude Code、Codex、Grok Build、Gemini 等；
**多账号 + round-robin 负载均衡**（Gemini / OpenAI / Claude / Grok 各自独立池）；
流式、非流式、WebSocket（视上游支持）；function calling；多模态输入。
提供 **Management API** 与**可复用的 Go SDK**（`docs/sdk-usage.md` / `sdk-advanced.md` /
`sdk-access.md` / `sdk-watcher.md`，还有 `examples/custom-provider` 示例）。
（[README](https://raw.githubusercontent.com/router-for-me/CLIProxyAPI/master/README.md)）

**技术方案**
Go，单二进制分发（`cliproxy-rs` 甚至是 Rust 重写版，读同一份 `config.yaml`、
暴露同样的路由与 v8 Management API，可双向切换）。配置走 `config.yaml` + auth 文件。

**产品设计与生态**（本项目最该学的一节）
- 有专门的桌面客户端 [EasyCLIProxyAPI](https://github.com/router-for-me/EasyCLIProxyAPI)
  （图形化配置 + 自动更新 + 系统托盘 + 一键启停），说明它清楚「CLI 用户也想要 GUI」。
- 独立文档站 <https://help.router-for.me/>。
- **衍生生态列表长达 30+ 个项目**（vibeproxy、Quotio、ProxyPilot、ZeroLimit、All API Hub…），
  覆盖 macOS 菜单栏、Windows 托盘、VSCode 扩展、浏览器扩展、Tauri 桌面端。
- **v6.10.0 起主动移除内置用量统计**，改为推荐三个第三方统计项目
  （CPA Usage Keeper / CPA-Manager-Plus / Oh-My-CPA）——**把非核心能力让给生态**，
  这是一个成熟项目的边界判断，本项目的控制台 9 标签页正走在相反方向（什么都自己做）。

**文档质量**
README 含 Providers 表格（每行带厂商 logo 与说明）、Overview 能力清单、
Getting Started 指引到独立文档站、Management API 单独文档、SDK 四篇文档、
Contributing 流程、以及两个生态清单（"Who is with us?" / "More choices"）。
**三语言**（EN / 中文 / 日本語）。缺点是 README 里赞助商区块占比过大（约 60% 篇幅），
有效信息密度被稀释——这是本项目值得庆幸没有踩的坑。

---

### 4.3 claude-code-router（Web 管理 UI 与持久化）

**核心功能范围**
本地模型网关 + 浏览器管理 UI + Agent Profiles 启动器。
默认网关 `127.0.0.1:3456`，管理 UI `127.0.0.1:3458`。
**双凭据体系**：management token（保护 UI 与 RPC）与 **CCR client API key**
（认证发往网关的模型请求）——这是本项目完全没有的一层。
支持 provider + model 管理、路由规则、profile 隔离（每个 profile 独立的 config / history / port）。
（[README](https://cdn.jsdelivr.net/npm/@musistudio/claude-code-router@3.1.1/README.md)）

**技术方案**
Node.js ≥ 22，`fastify` 5 + `@fastify/static`，**`better-sqlite3` 做配置与运行时持久化**
（`config.sqlite` + `app-data/` 存 API key、用量、请求日志、证书），
`tiktoken` 做 token 计数，`undici` 做 HTTP，`pino-rotating-file-stream` 做日志轮转，
`node-forge` 暗示有证书处理。子系统拆成 `@the-next-ai/ai-gateway`、
`@the-next-ai/bot-gateway-sdk` 等独立包。发布物 34.8 MB（63 文件）。

**产品设计**
- 命令面清晰：`ccr start`（后台服务）/ `ccr ui`（起服务+开 UI）/ `ccr stop` / `ccr serve`
  （前台，处理 SIGINT/SIGTERM，适合进程管理器）/ **`ccr <profile>`（启动某个 agent profile）**。
- 端口被占用时**自动试下一个可用端口并打印实际 URL**。
- `--open` / `--no-open` 区分图形环境与 SSH 无头环境。
- **危险操作与凭据安全提示很到位**：明确「含 `ccr_web_token` 的管理 URL 要当密码对待，
  不要复制进日志/ticket/shell history」「不要在未创建 client key 时暴露网关」
  「不要在 CCR 写入时编辑或复制 SQLite 文件」。
- Troubleshooting 5 条，每条对应一个具体症状。

**文档质量**
README 有中文版与独立文档站 <https://ccrdesk.top/>。
结构是「Requirements → Quick Start（5 步编号）→ Service Commands 表 → Agent Profiles →
Config And Runtime Files 表 → Environment And Security 表 → Troubleshooting → Docker」。
**安全与环境变量单独立表**这一点比本项目做得好（本项目的环境变量散在 `.env.example` 与 `config.mjs`）。

#### ⚠️ 4.3.1 对本项目最重要的外部发现：WorkBuddy 已是一等支持对象（已实测确认）

这是本轮调研中**最具战略相关性**的一条，必须单列。

在该项目的官方文档里，**WorkBuddy 与 Claude Code、Codex、Grok CLI、Kimi CLI、ZCode、
OpenCode 并列，是一个内置的 Agent 类型**（实测：

- <https://ccrdesk.top/en/guides/agent-profile/> —— 章节列表含 `WorkBuddy`
- <https://ccrdesk.top/en/configuration/agents/workbuddy/> —— 一整页 WorkBuddy 配置文档）

要点（均为实测页面内容）：

| 项 | 内容 |
|---|---|
| 入口模式 | **App-only**（固定，不可改）——与 ZCode 同类 |
| 检测方式 | 自动探测 WorkBuddy 可执行文件；探测不到时用 **`APP_PATH`** 覆盖 |
| 配置内容 | Provider ID / Provider name / **WorkBuddy model** / Allowed model list / Config file 路径 / 环境变量键值对 |
| 生效范围 | `Only opened from CCR` 或 `System default`；**系统默认只允许一个启用的 WorkBuddy profile** |
| 模型列表行为 | Allowed model list 为空 ⇒ 全部 CCR 模型可用；改完需**重开 WorkBuddy 设置窗口**才刷新 |
| 常见问题 | 只出现一个模型 / 请求绕过 CCR / App 内模型不对 / 找不到 WorkBuddy —— 四条都给了具体处置 |
| 启动命令 | `ccr-app "WorkBuddy - Work" app`（桌面）或 `ccr "WorkBuddy - Work" app`（CLI） |

**必须准确理解方向**：CCR 做的是**反向**的事 —— 它把 WorkBuddy 当作**消费方**（agent/client），
把 CCR 自己的模型注入 WorkBuddy 使用。而本项目是把 WorkBuddy 的配额**导出**给别的客户端。
**两者不冲突，甚至可以互补。**

**但这对本项目有三个明确影响**：

1. **方向相反的竞争已经存在，且来自一个 38k star 的项目。**
   如果用户的真实需求是「让 WorkBuddy 用上别的模型」，CCR 是成熟答案；
   本项目的不可替代性**只在「导出 WorkBuddy 配额」这个方向**上。
   这反过来强化了 P3-3 的定位判断：**本项目的独特价值就是「导出」这件事本身**，
   而它在 README 里的措辞（个人自用、演示工程做法）把这份价值说小了。

2. **WorkBuddy 的配置注入方式已被外部项目摸清并文档化。**
   CCR 明确描述了「写 profile（provider / model / model list / config 文件路径）」这套做法，
   与本项目 `lib/dsh.mjs` 写 dsh 配置、`dsh-plugin` 注册原生路由属于**同一类工程动作**。
   说明这类做法在生态里是成立的、可被接受的。

3. **本项目在「WorkBuddy + 客户端接入」这个交叉点上具备 CCR 没有的能力。**
   CCR 不掌握 WorkBuddy 的凭据解密、Anthropic 协议翻译、积分/签到/账本。
   本项目 `ARCHITECTURE.md` 里那些「为什么」的工程积累（AtRest 信封解密、
   双网关选择、目录合并、Anthropic 事件流配对）**是真正的门槛**，值得被更清楚地讲出来。

> 建议：在 README 的定位段落里补一句「与 claude-code-router 的 WorkBuddy 集成方向相反、
> 可组合使用」，并给出组合用法（先用本项目导出配额，或按需选 CCR 注入模型）。
> 这既是诚实披露，也能避免用户混淆两个项目的价值。
>
> **第二轮补充（2026-10-07）**：CCR 只是「反向」方向上的一个既有事实；WorkBuddy 生态本身
> 已经形成完整的直接竞争格局（§3.1）。本节的方向辨析依然成立，但 README 需要披露的对象
> 应从「CCR 一个项目」扩展为「整个直接生态」（§7 P3-4）。

---

### 4.4 new-api（团队级网关的完整度上限）

**核心功能范围**
自托管 AI 网关，上游含 OpenAI / Anthropic / Gemini / Azure / Bedrock / Vertex / DeepSeek / Qwen 等。
协议面：OpenAI Chat + Responses、Anthropic Messages、**Gemini 原生**
（`/v1beta/models/{model}:generateContent`）、**Realtime / WebSocket**、
images / audio（speech、transcriptions、translations）、embeddings、**rerank**、
以及**任务插件**（`/v1/tasks/{pluginKey}`，用 JavaScript 插件扩展图像/视频等异步任务）。
能力面：模型映射、渠道优先级与权重、重试、渠道亲和性、多上游 key、
配额、订阅、用量日志、**缓存计费**、**基于表达式的分档定价**、
用户/分组/细粒度权限、OAuth/OIDC、**passkey**、**双因素认证**、登录会话管理。
（[README](https://raw.githubusercontent.com/Calcium-Ion/new-api/main/README.md)）

**技术方案**
后端 Go + Gin，前端 **React 19 + TypeScript + Rsbuild + TanStack + Tailwind CSS 4**，Bun 管前端依赖。
存储可选 SQLite / MySQL ≥5.7.8 / PostgreSQL ≥9.6，**日志库可独立**（`LOG_SQL_DSN`，支持 ClickHouse），
Redis 可选（多节点共享限流必须）。**协议转换抽成独立可构建 Go module `relaykit/`**，
单独有自己的 README 与构建要求（`GOWORK=off go build ./...`）——这是本项目最该学的架构手法。
代码分层明确：`router/` `middleware/` `controller/` / `relay/` / `service/` `model/` / `web/`。

**产品设计**
- Docker 一条命令起 SQLite 单实例（绑 `127.0.0.1`），打开 `localhost:3000` 走
  **setup wizard 创建管理员账号**。
- Quick Start 是**编号的可执行流程**：加渠道（带渠道测试）→ 配价格与额度 → 建 API key → 
  配客户端 base URL → curl 验证。这段「Make your first request」写得很实。
- Docker Compose 默认 **New API + PostgreSQL + Redis** 三件套，并额外给 MySQL / ClickHouse 示例。
- **部署安全清单直接写进 README**：改默认密码、`openssl rand -hex 32` 生成 `SESSION_SECRET`、
  HTTPS 时设 `SESSION_COOKIE_SECURE=true` + `SESSION_COOKIE_TRUSTED_URL`、
  `TRUSTED_PROXIES` 显式配置、生产要反向代理支持 streaming 与 WebSocket 升级。
- **7 语言 UI**（EN / 简中 / 繁中 / 法 / 日 / 俄 / 越），README 有 5 语言版本。

**文档质量**
有独立文档站 <https://docs.newapi.ai/>（Guides / Installation / API / FAQ / Community），
DeepWiki 索引，`.github/SECURITY.md` 私密报告流程，`.env.example` 环境变量参考，
`docs/plugin-api/v1.md` 插件 API 文档，`AGENTS.md` 贡献前必读，
`web/AGENTS.md` 前端约定，`relaykit/README.md`，`docker/README.md`，
`NOTICE` + `THIRD-PARTY-LICENSES.md` 法务文件，**明确的许可附加条款**
（AGPLv3 §7：修改版必须保留作者署名与原始项目可见链接）。

> 注意其商业模式：AGPLv3 + 「若组织政策不允许 AGPLv3，请联系 support@quantumnous.com」，
> 即**用 AGPL 做商业化的双许可**。本项目 MIT 更适合「个人自用」的定位，但也就没有这条路。

---

### 4.5 LiteLLM（文档工程与可观测性的行业标杆）

**核心功能范围**
100+ provider；端点极宽：chat/completions、completions、responses、v1/messages、
embeddings、images、audio、batches、rerank、moderations、realtime（含 WebRTC）、
a2a、mcp、videos、ocr、vector_stores、files、fine_tuning、evals、search、skills、
memory、containers，外加 24 项 pass-through。
虚拟 key / 团队 / 用户体系（需 Postgres），key 支持 models 白名单、别名、`max_budget`、
`tpm_limit`/`rpm_limit`、`budget_duration`，**多预算窗口可叠加**。
缓存 8 类（redis / redis-semantic / valkey-semantic / qdrant-semantic / s3 / gcs / local / disk）。
guardrails 支持 `pre_call`/`post_call`/`during_call`/`logging_only`。
路由策略 5 种（simple-shuffle 默认、rate-limit aware、latency-based、least-busy、cost-based）。
自带 Admin UI + Playground + Swagger。
（[repo API](https://api.github.com/repos/BerriAI/litellm)、[docs](https://docs.litellm.ai/)）

**技术方案**
Python ≥3.10 <3.15，`litellm[proxy]` 引入 FastAPI + uvicorn/gunicorn + Prisma + PyJWT +
cryptography + APScheduler；依赖用 **uv** 管理（`uv.lock`、`uv sync --frozen`）。
**Rust 核已落地**：build-backend 为 maturin，模块 `litellm.rust_bridge._native`。
配置三层（config.yaml + 环境变量 + DB），开启 `store_model_in_db` 后 **DB 深合并覆盖 YAML**。
部署支持 pip / Docker / compose / **Helm 双 chart（单体 + gateway/backend/ui 微服务）** /
AWS·GCP 官方 Terraform。

**架构设计（最值得学的一节）**
- **请求链路**：Auth（先 Redis 缓存，miss 才查 DB）→ 四级限流（server/key/user/team）→
  Router → SDK 做 provider 翻译；**响应返回后的记账、计数、日志回调全在异步后台任务，
  请求路径中不写 DB**。
- **渐进式 provider 扩展机制**：纯 OpenAI 兼容的 provider
  **只改一个 JSON**（`litellm/llms/openai_like/providers.json`：base_url / api_key_env /
  param_mappings / constraints / supported_endpoints）；需要自定义鉴权或复杂转换时，
  才写 `litellm/llms/<provider>/chat/transformation.py` 继承 `OpenAIGPTConfig`，
  **只实现 `transform_request()` / `transform_response()`，HTTP handler 无需改动**。
- 重试分两层：`function_with_retries` 在**同一 model_group 内**换部署，
  `function_with_fallbacks` 才**跨组**降级。
- 虚拟 key 以 **sha256 哈希**存储；master key 明文只在内存比较、不进 DB。
- 进程无状态，状态放 Postgres + Redis，schema 迁移由独立 job 执行。

**性能策略**
文档给出**可复现基准**：8ms P95 @1k RPS（4 实例）；高吞吐档位（Rust 计数 + PgBouncer +
sidecar + 按 RPS 扩缩）在 5–10 万 token 长 prompt 下 3,000 RPS / p95 54ms。
自研 `x-litellm-overhead-duration-ms` 响应头**专门量化网关自身开销**；
提供 `network_mock: true` 在 httpx 层拦截出站请求做纯开销压测。
生产建议精确到数字（每 worker 1 vCPU/4Gi、K8s 每 pod 1 worker、HPA 只按 CPU 60%
而非内存、`proxy_batch_write_at: 60`、≥1000 RPS 走 Redis 事务缓冲）。
**同一页自曝缺点**：high memory usage during initialization and per request。

**产品设计与用户体验**
安装到可用有两条路：`curl … quickstart.sh | sh`，或下载 compose 起 gateway + Postgres；
之后**全程在浏览器完成**：登录 `/ui`（用户名 admin、密码即 master key）→
Add Model（带 **Test Connect** 连通性测试）→ Playground 发消息 → 创建虚拟 key →
**Get Code 自动生成调用代码**。无 DB 模式只保留 OpenAI 兼容 API。
SDK 侧 DX：异常类型映射为 `litellm.AuthenticationError` / `RateLimitError` 等，
一行接入 Langfuse / MLflow / Helicone；响应头回传 cost / call-id / model-api-base 便于排障。
**危险操作保护做得实在（文档级护栏）**：显式标注「预算必须有 DB，否则 fail open」、
`LITELLM_SALT_KEY` **不可轮换**（改了已存凭证全废）、
**master key 即 Admin UI 密码且绕过全部检查**、`trusted_proxy_ranges` 不设会导致登录限流失效。
（[docker_quick_start](https://docs.litellm.ai/docs/proxy/docker_quick_start)、
[prod](https://docs.litellm.ai/docs/proxy/prod)、[users](https://docs.litellm.ai/docs/proxy/users)）

**文档质量**
含架构专文（Life of a Request、多租户架构、key auth 架构、DB 里存什么）、
根 `ARCHITECTURE.md`（mermaid 时序图 + 「加 provider 只需 3 步」+ 测试清单）、
贡献指南（CLA + Conventional Commits 由 CI 把关）、Code Quality 页（ruff + basedpyright +
循环导入检查），并提供 **Swagger API reference 与 `llms.txt`**。
测试策略：`tests/test_litellm/` 与源码 **1:1 镜像且只允许 mock**，
dev 依赖含 respx / pytest-recording / fake-redis 做录制回放，CI 50+ workflow
（含 **mutation-test**、codeql、osv-scan、image-scan、schema 同步、价格自动同步）。
发布节奏公开：周二/周四 nightly → 周六 rc → 约一周 stable，每周一 minor，
只支持最近 4 条 minor 线，镜像 cosign 签名。

**痛点（同样是警示）**
5,241 open issues；仓库约 1.99 GB；成本表单文件 3.07 MB；
2026-03 发生 PyPI 供应链投毒（`litellm_init.pth` 启动即执行窃取凭证），
说明**大依赖树的攻击面**；社区已出现「去膨胀」复刻 `kennethwolters/litelm`。

> **对本项目的直接启示**：本项目的「零依赖」不是省事，而是**规避了 LiteLLM 最大的短板**。
> 这条优势应当在 README 里被更有力地论证，而不是只写成「零依赖 Node.js」。

---

### 4.6 workbuddy2api-panel（直接竞品的运营化上限）

**背景**：`Sliverkiss/workbuddy2api` 的增强分支。原版 2026-09-24 删库后，本分支声明已同步至删库前最后提交（`ea8b1e5`），此后独立维护；仓库创建于 **2026-09-12，不到一个月 2,136★**（GitHub API 实测，MIT，Go）。

**核心功能范围**
把腾讯 CodeBuddy 账号包装成统一的 `/v1/chat/completions`（默认端口 7863）。与本项目最大的不同是**它把「多账号运维」做成了产品**：

- **账号池**：快过期积分加权 + 成本分层 + 加权随机选号，Top-5 候选 + 防惊群；账号经 OAuth 设备授权登录，凭证落盘 `auths/*.json`（**明文 accessToken / refreshToken，0600**），面板可热加载进池（免重启）。
- **熔断与冷却**：429 软冷却 600s 起指数退避（有封顶）、404 固定 60s 短冷却、402 硬冷却至次日 04:00、连续失败熔断、在途租约限流。
- **会话粘性**：同一 `conversation_id` 绑定同一账号（TTL 滚动续期、失败自动解绑、可镜像 Redis）；客户端不带 `conversation_id` 时用 `system + 首条 user` 哈希派生会话键——通用 OpenAI 客户端也能吃到粘性。
- **定时任务四件套**（独立开关）：签到（09/21 点，末尾自动跑连登兑换 + 抽奖）、活跃上报、猫猫旅行、token 保活。
- **成长任务一键完成（17/18）**：纯 API 构造判据事件链——不同任务认不同客户端指纹（CLI `www.codebuddy.cn` / 桌面 `copilot.tencent.com` + `WorkBuddy/5.5.6` UA / web `www.workbuddy.cn`），推进进度、轮询计分落定后自动领奖；新号一轮 ≈ +1,950 credits +78 能量（唯一做不了的是需真实捐款的任务）。行为事件按天幂等。
- **出站改写管线**（`internal/upstream/payload.go`）：强制 `stream:true`、`developer` 角色归一、`tool_choice` 归一、`image_url` 兼容、DeepSeek 思维链注入（`thinking.type=enabled` + 档位降级）、`reasoning_content` 回填、指纹脱敏；另有**系统提示词替换**（从源头规避内容审核误报，`passthrough` 遇拦截自动降级重试）。
- **Web 管理面板**（7 视图）：账号运维、用量与积分分析、模型档位查询、在线改配置（热生效）、运行日志（含调用来源 IP / UA）、积分任务中心。
- **可观测**：每请求一行表格日志（TTFB / token 速率 / uid）、`/healthz` 带 `service` 身份标识可接负载均衡探活。

**技术方案**：Go 1.22.5，单二进制自包含（前端 `go:embed`；分发含 GHCR 多架构镜像 / Docker Compose / Windows 单 exe / 源码四路）；状态本地原子落盘 + 可选 Upstash Redis 镜像；常量时间密钥比较、CSP、UID 白名单。CI 自动构建多架构镜像。

**值得本项目注意的**：
1. **它面对的是与本项目完全相同的墙**：内容审核（指纹判据、提示词替换）、思维链格式、错误码语义（6004 模型级限额、11101、11128、413 等）、版本化 UA（`WorkBuddy/5.5.x`）——这证明本项目 `ARCHITECTURE.md` 里的容错层不是过度设计，而是这类项目的**必要基建**。
2. **它把「多账号 + 熔断 + 粘性 + 可观测」做成了标配**——正对本项目 F1 / F2 缺口；熔断分级、防惊群选号、粘性键哈希派生都是将来 P3-1 的现成参照（§8.7 #38–#40）。
3. **凭证明文落盘是它的自认风险**（使用声明原文警告：「此类分发无法审计，存在被植入后门、窃取你 CodeBuddy 凭证的风险（`auths/` 中保存的是明文 accessToken / refreshToken）」）。本项目的「密钥不落盘、向客户端进程现取现解」在这张对照表里是**更优解**——此前没有对照样本，现在有了（§5.7）。
4. 它的**使用声明**是生态合规焦虑的样本：强烈反对批量小号 / 付费转发 / 卡密售卖，并声明「作者保留止损的权利……上游的今天可能就是本项目的明天」（§8.6 风险 5）。

---

### 4.7 corrinehu/dsh-workbuddy-connect（同宿主、同位竞争）

**背景**：313★ / MIT / TypeScript，2026-10-07 仍在更新；与本项目 `dsh-plugin/` 争夺同一批用户——「把 WorkBuddy 的模型接进 dsh」。

**核心功能范围**
把 WorkBuddy（国内）与 WorkBuddy AI（国际）两版的模型接入 dsh，零配置；两版共存、各自账号与积分、退出某版则对应分组消失；图片输入；推理档位「有声明直接显示、无声明可手动探测（会消耗少量积分，有二次确认）」；设置卡片展示账号、令牌有效期、剩余积分、企业额度（走企业计费接口）、促销徽章、模型积分倍率；模型显隐**按登录账号分别持久化**；上下文窗口可选「上游声明的最大值」。CLI 提供 `exec status / doctor / logout`（带 `--json`）。Web / Desktop / TUI 三代界面自适应。

**凭据与工程细节**（本项目最该读的部分）：
- 复用桌面 App 登录态；**加密凭据通过定位并执行 App 自带的解密程序**获取（Windows 查安装路径与卸载注册表、macOS 路径发现、WSL 读挂载目录），失败时给环境变量兜底与 Agent 引导。它甚至记录了「两个 App 恰好共用同一把静态保护密钥，但插件不依赖它，密钥分叉后会如实报诊断而不是误读」——**证伪式设计**的样本。
- **插件 ↔ dsh 内核 ↔ 桌面 App 三方版本矩阵**（0.1.5 / 0.1.6 / 0.1.7 / 0.2.0-rc.1 / rc.2 逐行对照），并明确「只跟最新一代」或「多代兼容」的取舍；相关 issue（#41 / #63 / #69 / #74）是版本耦合的完整代价记录。
- 模型目录降级链：实时 → 上次成功 → 内置，并在卡片**标注来源（实时 / 已保存 / 内置）与失败原因**。
- README 内置「**把安装交给 Agent**」引导提示词：把一段 markdown 直接发给 AI 助手，由它判定内核版本、选对安装方式（Web / TUI / Desktop 三 profile 路径各不相同，desktop 由 Electron 独占管理）、装完验证。

**值得本项目注意的**：
1. **同宿主、同位竞争**：它做 provider + 状态卡（不拉起独立进程）；本项目把「桥 + 控制台 + 插件写设置」整套搬进 dsh——功能覆盖更全，但架构更重。两边目标用户高度重叠，**差异目前是「轻」对「全」**。
2. **它的版本矩阵反证本项目「自建桥、不依赖 dsh 版本」的策略价值**——本项目 README 应把这条对比写出来（§8.7 #43）。
3. 「把安装交给 Agent」值得照抄（本项目用户全是 AI 客户端用户，§7 P2-9）。
4. 它对国际版目录「按 UA 分流、属私有实现、可能失效」的如实披露，与本项目「兼容性分三档」是同一种诚实度——**这个品类里诚实度不是差异点，但保持诚实是底线**。

---

### 4.8 jwadow/kiro-gateway（形态最像的镜像项目）

**背景**：2,304★ / AGPL-3.0 / Python；2026-05-18 后停滞（≈5 个月），102 open issues；README 有 8 种语言；Docker + 原生两种部署。

**核心功能范围**：读取 Kiro IDE（AWS CodeWhisperer）的登录态 → 暴露 OpenAI + Anthropic 双协议；多账号 failover（Account System，官方计划用它替代 `.env` 配置）；403 / 429 / 5xx 自动重试；token 自动刷新；Extended Thinking（自称独家）；vision；web search；tool calling；**智能模型名解析**（`claude-sonnet-4-5` / `claude-sonnet-4.5` / 带日期版本号三种写法自动归一）；模型列表随订阅档位变化并如实标注（free tier 的 Opus 4.5 已被移除）。

**凭据**：读 `~/.aws/sso/cache/kiro-auth-token.json`（或 refresh token 环境变量），也支持企业 SSO（`clientIdHash`）——**与本项目「读另一个 App 的登录态」完全同构**。

**值得本项目注意的**：
1. 它是「单目标导出」形态在另一个产品上的完整先例（私密凭据读取 + 双协议翻译 + 多账号 + 重试），但它**已停更 5 个月**——是 §8.6 风险 4 的又一个样本，也是「做完这些功能不足以活下来」的直观注脚。
2. 它的多账号 failover 设计简洁有效：**单账号时直接透传原始错误、多账号才启用切换**——若做 P3-1，这是比全量引入池化更温和的第一步。
3. 模型名归一（3 种写法）对本项目 Anthropic 路径的模型名映射有直接参考（本项目已做 `claude-sonnet-4-*` → 上游模型的映射，可再核对宽容度）。
4. AGPL-3.0 + 8 语言 README 与它的停更形成对照：**国际化的收益没能兑现成维护动力**——本项目 MIT + 中文单语的取舍在「自用」定位下成立；若走分发，EN 是必需但不是护城河。

---

## 5. 对比分析矩阵

图例：✅ 完整 · 🟡 部分 / 有条件 · ❌ 无 · ➖ 不适用

### 5.1 功能完整性

| 能力 | 本项目 | copilot-api | CLIProxyAPI | claude-code-router | new-api | LiteLLM |
|---|---|---|---|---|---|---|
| OpenAI 兼容 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Anthropic 兼容 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `count_tokens` 端点 | ❌ | ✅ | 🟡 | 🟡 | 🟡 | ✅ |
| embeddings | ❌（有意 501） | ✅ | ❌ | ❌ | ✅ | ✅ |
| images / audio | ❌ | ❌ | 🟡 | ❌ | ✅ | ✅ |
| rerank | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ |
| 多模态**输入** | ✅ | 🟡 | ✅ | 🟡 | ✅ | ✅ |
| 流式 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| WebSocket | ❌ | ❌ | ✅ | ❌ | ✅ | ✅ |
| 多账号 | 🟡 仅切换 | ❌ | ✅ **round-robin 池** | 🟡 profile 隔离 | ✅ 渠道池 | ✅ 部署池 |
| 账号/客户端凭据体系 | ❌（仅回环 token） | 🟡 Token | ✅ OAuth + API key | ✅ management + client key | ✅ 用户/分组/key | ✅ 虚拟 key |
| 限流 | ❌ | ✅ `--rate-limit`/`--wait` | ✅ | ✅ | ✅ TPM/RPM | ✅ 四级 |
| 预算 / 配额 | 🟡 只读展示积分 | 🟡 只读展示 | ✅ | 🟡 | ✅ | ✅ |
| 用量统计 | ✅ 本地账本 | ✅ 仪表盘 | ➖ 让给生态 | ✅ SQLite | ✅ 多库 | ✅ 多后端 |
| 成本 / 计费 | 🟡 实测折算 | 🟡 | 🟡 | 🟡 | ✅ 表达式定价 | ✅ |
| Web 管理界面 | ✅ **9 标签页** | 🟡 只读仪表盘 | 🟡 需第三方 | ✅ | ✅ 7 语言 | ✅ Admin UI |
| agent 工具 / 命令 | ✅ 5 工具 + 命令 | ❌ | ❌ | ✅ profile 启动 | ❌ | ❌ |
| Docker | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 指标端点 | ❌ | ❌ | 🟡 | ❌ | 🟡 | ✅ |
| 插件机制 | ❌ | ❌ | 🟡 | ❌ | ✅ JS 任务插件 | ✅ guardrail/callback |

### 5.2 技术方案

| 项 | 本项目 | copilot-api | CLIProxyAPI | claude-code-router | new-api | LiteLLM |
|---|---|---|---|---|---|---|
| 语言 | JS (ESM) | TS / Bun | Go | TS / Node 22 | Go + React | Python (+Rust) |
| 运行时门槛 | Node ≥18 | Bun ≥1.2 | Go 编译 | Node ≥22 | Go + Bun | Python 3.10–3.14 |
| 框架 | **无**（`node:http`） | Hono + srvx | 标准库/自研 | Fastify | Gin | FastAPI |
| 运行时依赖 | **0** | ~11 | Go modules | ~12 | 多 | 多（+Prisma） |
| 配置方式 | env / `.env` + `config.mjs` | CLI flags + env | `config.yaml` | SQLite + UI | env + DB | yaml + env + DB |
| 持久化 | JSONL + JSON | 文件 | 文件 | **SQLite** | SQLite/MySQL/PG | Postgres |
| 分发 | 拷文件夹 / tgz / npm | npx / Docker | 单二进制 | npm / Docker | Docker | pip / Docker / Helm |
| 跨平台 | **Windows 实测**，mac/Linux 未实测 | 全平台 | 全平台 | 全平台 | Linux amd64/arm64 | 全平台 |
| 静态检查 | ❌ 无 lint 配置 | ✅ eslint + knip + tsc | ✅ Go vet 生态 | ✅ typecheck | ✅ 前后端各自 | ✅ ruff + basedpyright |
| 类型 | 纯 JS，无 `.d.ts` | TS 全量 | Go 静态类型 | TS 全量 | Go + TS | 类型提示 |
| CI | 1 workflow（Windows） | 有 | 有 | 有 | 有 | **50+ workflow** |

### 5.3 架构设计

| 维度 | 本项目 | 竞品普遍做法 | 差距判定 |
|---|---|---|---|
| 进程模型 | 桥（独立）/ 控制台（独立）/ 插件（宿主） 三层，生命周期归口清晰 | 单进程或单体 | ✅ **本项目更清晰** |
| 协议翻译 | `anthropicToOpenAIMessages` 等**硬编码函数** | LiteLLM 的 JSON 注册表 + Config 类继承；new-api 的 `relaykit` 独立 module | ❌ **差在可扩展性** |
| 单写者纪律 | ✅ 严格（`.state.json` 只由控制台写，插件白名单透传） | 多数项目不处理 | ✅ **超出竞品** |
| 凭据处理 | 密钥不落盘、登录文件只读、现取现解 | 落盘 token / Keychain / OAuth refresh | ✅ **思路更安全** |
| 账号调度 | 单一账号切换 | round-robin / 权重 / 亲和 / 降级 | ❌ **差一整代** |
| 失败重试 | 1 次 stale-socket 重试 + 11133 退避 4 档 | 分层重试 + 跨组 fallback + 冷却 | 🟡 有但无 fallback 链 |
| 鉴权 | 单一回环 token（默认值硬编码） | 虚拟 key 体系 / OAuth / 多凭据分离 | ❌ **差一整代** |
| 无状态化 | 单实例 | 无状态 + 共享 DB/Redis | ❌ 无法横向扩展 |
| 可观测性 | 本地账本 + 日志文件 | 回调总线 / OTel / Prometheus / 成本头 | ❌ **完全缺失** |
| 缓存 | 目录 5min TTL + 积分 SWR + 凭据进程内 | 响应缓存 / 语义缓存 / 共享缓存 | 🟡 缓存有，无响应缓存 |

### 5.4 性能表现

| 项 | 本项目 | 竞品 | 说明 |
|---|---|---|---|
| 上游连接复用 | ✅ keep-alive 5min，`maxSockets: 8`，`scheduling: lifo` | 普遍有 | ✅ 对齐 |
| 上游网关开销延迟 | ❓ **无度量** | LiteLLM：`x-litellm-overhead-duration-ms` 头 + 基准页 | ❌ **无自证能力** |
| 慢上游隔离 | ✅ **积分 SWR**（stale-while-revalidate + in-flight 去重 + 3s 冷启动上限） | 少见 | ✅ **本项目亮点** |
| 健康检查不阻塞 | ✅ `/health` 只读缓存、后台刷新 | 少见 | ✅ **本项目亮点** |
| 内存有界 | ✅ body 上限 32MB + 账本 2000 行 + 日志滚动 2MB | 不一 | ✅ 对齐 |
| 事件循环阻塞 | ✅ 已修（异步 `probePortPid`、账本内存镜像） | 不一 | ✅ 对齐 |
| 并发控制 / 队列 | ❌ 仅 `maxSockets: 8`，**无排队、无背压、无限流** | 竞品普遍有 TPM/RPM | ❌ **缺失** |
| 基准数据 | ❌ 无 | LiteLLM 有完整基准页 | ❌ **缺失** |

### 5.5 用户体验

| 项 | 本项目 | copilot-api | CLIProxyAPI | claude-code-router | new-api | LiteLLM |
|---|---|---|---|---|---|---|
| 安装到可用 | ✅ **双击 `启动.cmd`**（零 npm install） | `npx` 一行 | 下二进制 + yaml | `npm i -g` + `ccr ui` | Docker 一行 + wizard | pip/Docker + UI |
| 首配引导 | ✅ 自动探测，`node tools/doctor.mjs` 8 项诊断 | 交互式 OAuth | CLI 认证流 | **Web UI 5 步** | **setup wizard** | **浏览器全流程** |
| 客户端接入 | ✅ **配置片段 + 一键复制 + 兼容性分档** | ✅ `--claude-code` 复制剪贴板 | 文档指引 | UI 展示网关 URL | 文档 + curl | **Get Code 生成代码** |
| 危险操作保护 | ✅ 二次确认（且当次取明细） | 🟡 `--manual` | 🟡 | ✅ 文档反复叮嘱 | ✅ 部署安全清单 | ✅ 文档级护栏 |
| 错误可读性 | ✅ 失败标红 + 错误码 + 一键复制详情 | 🟡 verbose | 🟡 | ✅ Troubleshooting 5 条 | ✅ | ✅ 异常类型映射 |
| 界面 i18n | ❌ **仅中文** | ❌ 英文 | ✅ 3 语言 | ✅ 中英 | ✅ **7 语言** | ✅ |
| 终端诊断命令 | ✅ `doctor.mjs`（含 `--json`） | ✅ `debug --json` + `check-usage` | ✅ | ✅ | ➖ | ➖ |
| 系统托盘 / 桌面端 | ❌ | 🟡 `start.bat` 自动开页 | ✅ EasyCLIProxyAPI + 30 衍生 | ✅ 桌面版 | ✅ electron 目录 | ➖ |
| **WorkBuddy 生态位** | ✅ 导出配额，**但已不独有**：直接同目标项目 ≥20 个、dsh 插件 ≥10 个（§3.1，最高 2,136★） | ❌ | ❌ | 🟡 反向：把自身模型注入 WorkBuddy（§4.3.1） | ❌ | ❌ |

### 5.6 文档质量

| 项 | 本项目 | copilot-api | CLIProxyAPI | claude-code-router | new-api | LiteLLM |
|---|---|---|---|---|---|---|
| README 行数 | 395（+ 关键词表） | 中长 | 长（赞助占 60%） | 中 | 长 | 长 |
| 独立文档站 | ❌ | ❌ | ✅ help.router-for.me | ✅ ccrdesk.top | ✅ docs.newapi.ai | ✅ docs.litellm.ai |
| 架构文档 | ✅ `ARCHITECTURE.md` 587 行（**质量极高**） | ❌ | 🟡 | 🟡 | 🟡 | ✅ 专文 + mermaid |
| API 参考 | 🟡 `dashboard/README.md` 529 行手写 | ✅ README 表格 | ✅ 独立 | ✅ | ✅ | ✅ **Swagger + llms.txt** |
| 排错文档 | ✅ `TROUBLESHOOTING.md` 386 行（症状表） | ✅ 一节 | ✅ | ✅ 5 条 | ✅ FAQ | ✅ |
| 配置参考 | ✅ `.env.example` 54 行注释详尽 + `CONFIGURATION.md` 131 行 | ✅ 选项表 | ✅ | ✅ 环境变量表 | ✅ | ✅ |
| 安全文档 | ✅ `SECURITY.md` 99 行 | ✅ 2 处 WARNING | 🟡 | ✅ Security 一节 | ✅ SECURITY.md | ✅ |
| 接口契约文档 | ✅ `dsh-llm-adapter-contract.md` **1,643 行** | ❌ | 🟡 | ❌ | 🟡 | ✅ |
| 贡献指南 | ❌ | 🟡 | ✅ | ❌ | ✅ **AGENTS.md** | ✅ **CLA + 规范** |
| CHANGELOG | ❌ | ❌ | ✅ | 🟡 | ✅ release notes | ✅ **严格节奏** |
| 多语言 | ❌ | ❌ | ✅ 3 | ✅ 2 | ✅ 5 | ✅ |
| 设计系统文档 | ✅ `DESIGN_SYSTEM.md` 264 行（**罕见**） | ❌ | ❌ | ❌ | 🟡 | ❌ |
| 截图 / 演示 | ✅ 12 张 + 深浅色 | ✅ 视频 demo | ✅ | ✅ | ✅ | ✅ |
| Release 标签 | 🟡 v1.0.0 / v1.1.0，**package.json 已 1.2.0 未打 tag** | 持续 | 持续 | 持续 | 持续 | 严格节奏 |

### 5.7 第二轮新增：直接同目标集群横向对比（WorkBuddy / CodeBuddy → API）

图例同 §5.1；「？」= 该项目 README 未提及且本轮未实测。为控制宽度只列与决策直接相关的 8 个维度；
数据来源为各项目 README（§3.1）与本轮 GitHub API 实测。

| 能力 | 本项目 | wb2api-panel | wb2api-hub | wb-manager | xiaofan | xdpool（dsh） | dsh-wb-connect | molly-oauth |
|---|---|---|---|---|---|---|---|---|
| 多账号池 | ❌ 仅手动切换 | ✅ 加权 + 防惊群 | ✅ 双版本池 | ✅ 扫码批量 + 分组 | ✅ 自动切换 | ✅ 4 模式 | ❌ | ✅ 跳过限流号 |
| 限流 / 冷却 | ❌ | ✅ 分级熔断 | ✅ 四条护栏 + 模型级 429 冷却 | ✅ 上游熔断（打包上游） | ✅ 按 Key 配额硬拒绝 | ✅ 429 冷却换号 | ？ | 🟡 耗尽即停用该号 |
| 会话粘性 | ❌ | ✅（含哈希派生） | ？ | ？ | ？ | ✅ sticky | ✅ | ✅ 不粘坏号 |
| 凭据落盘 | ✅ **不落盘**（现取现解） | ❌ auths/ 明文 token | ？ | ？ | 🟡 读登录态 + 复用官方 SDK | 🟡 读 App 登录快照 | ❌ 插件自留副本 | ❌ 插件目录落盘 |
| 签到 / 任务自动化 | 🟡 仅签到（幂等 / 自动 / 冷却） | ✅ 17/18 + 四类排程 | ✅ 签到/任务/旅行/保活全自动 | ✅ 定时签到保活 | ❌ | ✅ 五项自动化 | 🟡 每日签到 | ❌ |
| Web 管理面板 | ✅ 9 标签页 | ✅ 7 视图 | ✅ 用量看板 | ✅ 控制台 | ✅ sub2 风格大屏 | —（dsh 卡片） | —（dsh 卡片） | —（dsh 卡片） |
| dsh 原生插件 | ✅ 桥 + 控制台整套 | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ | ✅ |
| 协议 / 形态 | chat + messages + models + 管理面 | chat | chat + **responses** | chat | chat + responses + messages | 宿主内 | 宿主内 | 宿主内 |

> 对照结论：**在「协议翻译 + 凭据读取」上本项目仍是第一梯队，但在「多账号、限流、自动化」上
> 直接竞品已整体领先一代**；而「凭据不落盘」是本项目在这张表里唯一一骑绝尘的单元格。

---

## 6. 差距清单

### 6.0 【复核更新】控制台识别机制失效——初稿 P0 的当前状态

> 本节初稿写于 2026-10-07 早，把「控制台识别失效」记为必须立即修的活缺陷。
> **当晚复核（HEAD `f30eee9`）：该缺陷已按初稿建议的方式修复**（结构标记 + 真产物交叉校验），
> `release:check` 全绿。原始分析与教训保留在下方，作为方法论复盘。

| 初稿项 | 初稿结论 | 复核后状态（2026-10-07 晚，HEAD `f30eee9`） | 复核证据 |
|---|---|---|---|
| P0-1 标题漂移 | 真控制台被判 `foreign` | ✅ **已修复**：识别改用结构标记 `CONSOLE_MARKER = 'id="navTabs"'`，代码注释里完整记录了这次事故（「品牌名会变，结构标记不会」） | commit `f30eee9`；`Select-String dsh-plugin/lib/console.mjs -Pattern 'CONSOLE_MARKER'` |
| P0-2 首块读取 | 标题必须落在首个 chunk | ⏳ **仍开放（已缓解）**：`probe()` 仍只读首个 chunk；标记位于 `index.html:45`（远早于 146KB 正文），当前无实际风险；建议改「有界读取至匹配或上限」 | `console.mjs:92-97`；下方实测表仍成立 |
| P0-3 vendor 不同步 | `release:check` 红 | ✅ **已修复**：本次实测 **EXIT=0**（vendor:check + 74 用例 + 独立分发演练 14 项全过） | 附录命令 3 |
| P0-4 README 重复段 | 注意事项 2–7 条重复 | ⏳ **仍开放** | `Select-String README.md -Pattern '^\d\. \*\*'` |
| 测试自证 | 单测用被测常量造夹具 | 🟡 **部分修复**：单测仍用 `CONSOLE_MARKER` 构造夹具；但**真产物交叉校验已补上**（`verify-standalone.mjs:134-143` 对真实服务出的页面断言 `id="navTabs"`）。教训的最终解法是「把校验放到真产物那层」，不是删掉单测 | 两处文件行号 |

**历史现象（初稿记录）**：控制台品牌改名后，插件的「靠首页标题识别控制台」机制完全失效。

```
控制台页面的真实 <title> : WorkBuddy 本地 API 桥 · 控制台   ← dashboard/public/index.html（工作区已改）
插件写死的 CONSOLE_TITLE : WorkBuddy 中转控制台            ← dsh-plugin/lib/console.mjs:20（初稿时行号）

probe() 判定            : foreign
ensure() 结果           : ok=false state=foreign

—— 复核注（2026-10-07 晚）：以上为初稿时状态；当前 console.mjs 已不存在 CONSOLE_TITLE，
识别改用结构标记 id="navTabs"（CONSOLE_MARKER），本组取证自此为历史记录。
```

**取证**（临时探针，已清理）：

```js
new ConsoleSupervisor({ projectRoot: 'unused', port, cacheTtlMs: 0 })
  .probe({ cached: false })
// => { state: 'foreign',
//      error: '端口 11189 上有 HTTP 服务，但不是 WorkBuddy 控制台（换个 DASHBOARD_PORT）' }
```

**影响面**：
1. `probe()` 把在跑的真控制台判成 `foreign`（`console.mjs:94`）→ 插件不复用、不管理它；
2. `ensure()` 返回 `ok:false` → 设置页「打开控制台」入口与生命周期管理失效；
3. `stop()` 走错分支，给出「这个控制台不是插件启动的」误导文案（`console.mjs:194-204`）；
4. `dsh-plugin/scripts/verify-standalone.mjs:134` **同时也写死了旧标题字符串**
   （`/WorkBuddy 中转控制台/`），所以这条验收脚本也失去了校验能力。

**为什么既有测试完全没发现**（这是比 bug 本身更重要的教训）：

```js
// dsh-plugin/tests/plugin.test.mjs:607,613（初稿时；现已改用 CONSOLE_MARKER 造夹具，自证模式未变）
const { ConsoleSupervisor, CONSOLE_TITLE } = await import('../lib/console.mjs');
res.end(`<title>${CONSOLE_TITLE}</title>`);   // ← 夹具用被测常量自己构造
assert.equal(probe.state, 'running');          // ← 恒真，除非常量与自身不一致
```

这是**自证式（tautological）断言**：测试构造夹具时用的是被测代码里的同一个常量，
因此它能证明「代码读得到自己写的常量」，**永远无法证明「这个常量与真实页面对得上」**。
项目里也没有任何测试把 `CONSOLE_TITLE` 与 `dashboard/public/index.html` 做交叉校验。

**复核注（2026-10-07 晚）**：`verify-standalone` 现已对**真实服务出的页面**断言结构标记，
等于在演练层补上了「真产物交叉校验」；但单测层面的自证模式仍在（夹具由常量构造）。
本教训的普适版本应固化为纪律：**凡「读外部资源做判断」的常量，必须有一条对真实产物的断言**。

**当前版本号状态（初稿时）与复核**：初稿记录「`index.html` 已是新标题、`vendor/` 快照仍是旧标题，
`release:check` 因此失败」。**复核（2026-10-07 晚）：vendor 已随仓库同步，`release:check` 全绿。**
以下为初稿当时的失败输出（历史记录）：

```
✖ vendor/ 与仓库不同步，共 3 个文件需要更新：
   dashboard\public\index.html
   dashboard\public\style.css
   dashboard\server.mjs
```

**建议修法**（三步，缺一不可）——**复核注：实际修复采用了比第 1 步更好的方案（结构标记），
三项已全部或部分落地**：
1. ~~把 `CONSOLE_TITLE` 改为单一真源~~ → **已落地为结构标记方案**：不用标题（品牌会变），
   改用 `id="navTabs"`（结构不会变）——比「统一标题真源」更抗改名；
2. `verify-standalone` 里的标题字面量 → **已落地**：改为对真实页面断言结构标记；
3. 补一条**交叉校验测试** → **部分落地**：真产物校验已在 `verify-standalone` 演练层；
   单测层仍是「常量造夹具」，保留为开放项（§7 P0-5）。

**附带发现（同类脆弱点，建议一并加固）**：`probe()` 只读 HTTP 响应的**第一个 chunk**
就判断标题（`console.mjs:82-94`，注释写着「只看开头即可判断」）。实测该设计依赖
「标题落在首块内」这一未经保证的前提：

| 场景 | 首块识别失败率 |
|---|---|
| 一次性 `res.end()` 整页 | 0/30 ✅ |
| 分两次 `write` | 0/30 ✅ |
| **标题前有 110KB 填充** | **30/30 ❌** |

当前 `index.html` 共 146KB，识别标记 `id="navTabs"` 位于第 45 行 —— **所以现在能工作**；
但只要有人把标记下移、或页面走 gzip / 反向代理 / 流式渲染，就会立刻复发。
建议改为**有界读取至匹配或上限（如逐块读到 512KB 即停）**——环回读取成本可忽略。

> 复核注（2026-10-07 晚）：该加固仍未实施（§7 P0-2 仍开放）；标记位置远离块边界，暂无实际风险。

---

### 6.1 功能完整性差距

| # | 差距 | 现状 | 竞品基准 | 影响 |
|---|---|---|---|---|
| F1 | **无多账号池化** | 只能手动切换账号（`/api/account/switch`） | CLIProxyAPI 四类账号各带 round-robin；LiteLLM 部署池 + 权重/延迟/成本路由；**直接竞品**：wb2api-panel 加权池 + 防惊群、xdpool 4 模式（含 sticky）、AIClient2API 池 + 自动降级（§3.1、§5.7） | 单账号打满或失效即全停 |
| F2 | **无任何限流** | 文档建议「不要高频」，代码零实现 | copilot-api `--rate-limit` + `--wait`；LiteLLM 四级 TPM/RPM；**直接竞品**：wb2api-panel 429/404/402 分级熔断 + 在途租约、xiaofan 按 Key 配额硬拒绝（§5.7） | 单个失控客户端可打爆账号配额 |
| F3 | **无客户端凭据分层** | 单一回环 token，默认值 `wb-local-bridge` 硬编码 | claude-code-router management token 与 client key **分离**；LiteLLM 虚拟 key 哈希存储 | 无法区分调用方、无法单独吊销 |
| F4 | **无 `count_tokens`** | 只有 Anthropic 路径内部用 `字节数/4` 粗估 | copilot-api 有 `/v1/messages/count_tokens` | Claude Code 上下文占用显示失真 |
| F5 | **无指标 / 可观测性** | 本地 JSONL 账本 + 日志文件 | LiteLLM 回调总线 + OTel + cost header + 基准页 | 无法回答「桥本身慢不慢」 |
| F6 | **无 Docker** | 拷文件夹 / tgz / npm | 其余 5 个案例全部有 | 换机/CI 场景门槛高 |
| F7 | **无响应缓存** | 只有目录 TTL 与积分 SWR | LiteLLM 8 类缓存；new-api 缓存计费 | 重复请求全量打上游 |
| F8 | **无任何跨组 fallback** | 仅 stale-socket 重试 1 次 + 11133 退避 | LiteLLM 重试（组内）/ fallback（跨组）分层；new-api 渠道重试 | 主模型故障即失败，不降级 |

### 6.2 技术选型差距

| # | 差距 | 说明 |
|---|---|---|
| T1 | **纯 JS 无类型** | 0 个 `.d.ts`，3.2 万行核心逻辑靠 JSDoc 注释。copilot-api / claude-code-router 全量 TS，new-api / CLIProxyAPI 静态类型 |
| T2 | **无静态检查** | 无 eslint / prettier / tsconfig 配置。竞品普遍有（copilot-api 甚至上了 knip 检测死代码） |
| T3 | **Windows 单平台** | `dsh-plugin/package.json` 声明 `os: ["win32"]`；README 承认 macOS/Linux 「已实现但未实测」，CI 也只有 Windows runner |
| T4 | **版本发布不一致** | `package.json` 1.2.0，但 git tag 只到 `v1.1.0`；README 里同时出现 1.2.0 与 1.1.0 |

> **注意**：本项目「零依赖 + 单文件自包含」是**真实且罕见的优势**（规避了 LiteLLM 的
> 依赖树攻击面与 1.99GB 仓库）。T1/T2 的补法不应引入运行时依赖，
> 可以用 `tsc --checkJs` + `eslint` 作为 **devDependency**（不影响零运行时依赖的卖点）。

### 6.3 架构设计差距

| # | 差距 | 说明 |
|---|---|---|
| A1 | **协议翻译无扩展点** | Claude Code 之外再加一个客户端协议，必须改 `workbuddy-bridge.mjs` 核心文件。对比：LiteLLM 纯兼容 provider **改一个 JSON**；new-api 把转换抽成独立 Go module `relaykit/` |
| A2 | **无插件/中间件链** | 无法在不改核心的前提下加统计、脱敏、重写规则。对比：new-api JS 任务插件、LiteLLM guardrail/callback 回调 |
| A3 | **单写者纪律优秀但成文于代码** | `.state.json` 只由控制台写、插件白名单透传——这个设计**比竞品严谨**，但只散落在注释与 README，没有单独的架构决策记录（ADR） |
| A4 | **桥与控制台职责边界可再收紧** | 桥 2,618 行单文件同时承担：协议翻译 + 目录抓取 + 计费 + 签到 + 账本 + 诊断数据源。LiteLLM 的分层（Auth → 限流 → Router → SDK）值得参照拆分 |
| A5 | **无状态化缺失** | 单实例、内存态（凭据缓存、签到闸门、账本镜像）不可横向扩展 |

### 6.4 性能表现差距

| # | 差距 | 说明 |
|---|---|---|
| P1 | **性能主张无法自证** | 项目在 ARCHITECTURE.md 里声称「keep-alive 免去每次 ~150ms 握手」「账本 2000 行 ~2.1ms/次」，但这些数字**没有任何可复现的基准脚本或响应头支撑**。LiteLLM 有专门的开销头 + `network_mock` 压测模式 + 公开基准页并**在同一页自曝高内存** |
| P2 | **无并发控制与背压** | 仅 `maxSockets: 8`（`workbuddy-bridge.mjs:51,55`）。第 9 个并发请求由 Node 默认排队，**没有超时、没有拒绝、没有可观测的队列深度** |
| P3 | **无超时兜底默认值** | `WORKBUDDY_TIMEOUT_MS` 默认 **0 = 不限**（`config.mjs:144`）。长回答需要，但「客户端断开后上游连接是否及时释放」没有独立的兜底 |
| P4 | **日志为同步追加** | `bridge.log` 超 2MB 滚动，但写入路径未见批量/异步 |

### 6.5 用户体验差距

| # | 差距 | 说明 |
|---|---|---|
| U1 | **无 i18n** | 控制台 `<html lang="zh-CN">`，全中文。new-api 7 语言、CLIProxyAPI 3 语言、claude-code-router 2 语言。这直接限制了国际版 WorkBuddy 用户（项目**已支持国际版网关**，却只提供中文界面） |
| U2 | **无桌面端 / 托盘** | CLIProxyAPI 有官方 EasyCLIProxyAPI + 30 个衍生（含 Windows 托盘）；claude-code-router 有桌面版。本项目需开浏览器看控制台 |
| U3 | **无 Docker** | 同 F6。copilot-api 的 Docker 还做了非 root 用户 + healthcheck + 固定基础镜像，值得照抄 |
| U4 | **README 注意事项段落重复** | `README.md:347-353` 与 `354-359` 内容完全重复（2–7 条出现两次） |
| U5 | **首次接入仍有两个手动步骤** | 需去控制台拿 Base URL/令牌再填客户端；copilot-api 的 `--claude-code` 是**选完模型直接复制可用命令**，new-api 有 setup wizard。本项目的「客户端接入」面板已很接近，但缺「直接生成可粘贴命令」这一步 |

### 6.6 文档质量差距

| # | 差距 | 说明 |
|---|---|---|
| D1 | **无独立文档站** | 全部 Markdown 放在仓库 `docs/`。竞品 4/5 有独立站点。对本项目而言**可能不值得**（单页站成本 vs 收益），但至少可以加 GitHub Pages |
| D2 | **无 OpenAPI / Swagger** | 13 个控制台 API + 8 个桥 API 全靠手写文档。LiteLLM 有 Swagger + `llms.txt`（面向 coding agent 读文档）；`docs/dsh-llm-adapter-contract.md` 1,643 行说明本项目**有能力写好契约文档**，只是没覆盖自己的 HTTP API |
| D3 | **无 CHANGELOG** | release notes 散落在 `.optimize/` 与 `.promo/`（非发布路径）。new-api 与 LiteLLM 都有规范 CHANGELOG |
| D4 | **无 CONTRIBUTING / CODE_OF_CONDUCT** | new-api 有 `AGENTS.md`（贡献前必读），LiteLLM 有 CLA + Conventional Commits CI 把关 |
| D5 | **`.github/` 缺模板** | 只有 1 个 workflow，缺 issue/PR 模板、SECURITY policy、依赖更新配置 |
| D6 | **截图产物污染工作区** | `.optimize/findings.md:109-126` 自己记录过：`npm run panel:shot` 产物**非确定性**（含时间戳与实时数据），跑一次就得到脏工作区，且 CI 无法验证。**至今未修**（建议输出到 gitignore 路径或加「跑完请还原」提示） |
| D7 | **内部研发文档混入发布物** | `.optimize/`、`.trae/`、`.promo/`、`.backup/`、`.workbuddy-ai/` 均在仓库内。对「个人自用」无妨，但稀释了仓库的专业观感 |

---

## 7. 优先级建议

排序依据：**影响面 × 修复成本 × 是否阻塞其他改进**。

> 本表的可执行细化（批次、验收命令、定位决策门、不做清单）见 [ACTION-PLAN.md](./ACTION-PLAN.md)。

### P0 —— 复核更新（2026-10-07 晚，HEAD `f30eee9`）

| # | 动作 | 状态 / 验收标准 |
|---|---|---|
| P0-1 | 修复 `CONSOLE_TITLE` 漂移（§6.0） | ✅ **已修复**（`f30eee9`：结构标记 + 真产物断言）。验收达成：`release:check` 全绿、`probe()` 对真实控制台返回 `running` |
| P0-2 | 加固 `probe()` 首块读取：改「有界读取至匹配或上限」 | ⏳ 仍开放。验收：构造「标记在 100KB 之后」的桩，`probe()` 仍返回 `running` |
| P0-3 | 修复 `vendor/` 不同步 | ✅ **已修复**：`npm run release:check` 退出码 0（本次实测） |
| P0-4 | 修复 README 重复段落（第 2–7 条重复出现） | ⏳ 仍开放 |
| P0-5 | 纪律固化：凡「读外部资源做判断」的常量，必须有一条对真实产物的交叉校验（§6.0 教训） | 🟡 部分落地（真产物校验在 `verify-standalone` 演练层）；保留此条防止回潮 |

### P1 —— 高价值（补齐与竞品的代际差距）

| # | 动作 | 参考对象 | 理由 |
|---|---|---|---|
| P1-1 | **加本地限流**（`WORKBUDDY_RATE_LIMIT_MS` / 每分钟上限 + 队列深度可见） | copilot-api `--rate-limit` + `--wait` | 唯一的「保护用户账号」机制，成本极低 |
| P1-2 | **加 `/metrics` 或至少网关开销响应头** | LiteLLM `x-litellm-overhead-duration-ms` | 让 P1 里的性能主张可自证；也是排障刚需 |
| P1-3 | **补交叉校验类测试范式**，消灭所有自证式断言 | — | §6.0 揭示的是**系统性测试缺陷**，不止一处 |
| P1-4 | **加 `POST /v1/messages/count_tokens`** | copilot-api | Claude Code 上下文显示准确性的直接改善 |
| P1-5 | **客户端凭据分层**：回环 token 之外给每个客户端独立 key | claude-code-router（management vs client key） | 为限流、计费、吊销打基础 |
| P1-6 | **加 CHANGELOG.md + 补 v1.2.0 tag** | new-api / LiteLLM | 版本一致性是最低成本的信任信号 |
| P1-7 | **补「计费口径核对」指引**（控制台积分合计 vs 客户端内用量） | §8.6 风险 2 | 数据能力已具备，只差一句指引；直接回应品类级信任缺口 |
| P1-8 | **卡死请求的可见性**：为进行中的请求显示时长 + 超阈值提示（**不加默认超时**） | §8.6 风险 3；反面案例 CLIProxyAPI #3530 | 小代价做出差异化；注意不要破坏长回答 |
| P1-9 | **硬编码版本号的降级路径**：上游版本探测失败时给明确报错，并在排错表补该症状 | §8.6 风险 1；反面案例 copilot-api #191 | `APP_VERSION`/`IDE_VERSION` 硬编码是本项目与 copilot-api 共有的脆弱点 |
| P1-10 | **实测核实上游内容审核黑名单**：`wb-cliproxy` 实测上游把 Claude Code 的两句固定 system 模板**逐字**拉黑；本项目桥未见对应改写层 | §3.1 W4（wb-cliproxy README）、§8.6 风险 1 | 一条带该模板的请求即可验证；若命中，按竞品做法做最小改写并加测试 |
| P1-11 | **客户端身份与版本号对齐核对**：桥固定 `VSCode/1.119.0 CodeBuddy/4.9.x`（`bridge/workbuddy-bridge.mjs:35-37`）；同类项目已按 `WorkBuddy/5.5.x` 校准并支持 WB / VSC / CLI 三套身份 | §3.1 W1/W3/W6、§8.6 风险 1 | 确认当前身份仍被上游接受；把版本号做成可配置项，把「上游版本漂移」列进排错表 |

### P2 —— 中等价值（架构与分发）

| # | 动作 | 参考对象 | 理由 |
|---|---|---|---|
| P2-1 | **协议翻译抽成注册表/适配器**：新增客户端协议不改核心文件 | LiteLLM（JSON 注册表 + Config 类）、new-api（`relaykit` module） | 当前每次加协议都要动 2,618 行的核心文件，风险随文件增长而放大 |
| P2-2 | **加容器化**：Dockerfile（非 root + healthcheck + 固定基础镜像） | copilot-api | 换机、CI、Linux 验证三件事一次解决 |
| P2-3 | **CI 矩阵扩到 macOS / Linux** | CLIProxyAPI（跨平台单二进制） | 项目自称「mac/Linux 已实现未实测」，矩阵 CI 是唯一低成本的兑现方式 |
| P2-4 | **加 `tsc --checkJs` + eslint（devDependency）** | copilot-api（eslint + knip + tsc） | 不破坏「零运行时依赖」卖点，但能挡住一整类错误 |
| P2-5 | **加 OpenAPI 描述**（哪怕手写 YAML） | LiteLLM（Swagger + `llms.txt`） | 21 个端点目前只有散文文档；`dsh-llm-adapter-contract.md` 证明有能力 |
| P2-6 | **修截图产物污染**：输出到 gitignore 路径 | 项目自己的 `.optimize/findings.md:109-126` 已提出 | 已记录未修 |
| P2-7 | **加 CONTRIBUTING.md** | new-api `AGENTS.md` | 极低成本 |
| P2-8 | **OAuth 设备码登录作为第二凭据路径**（不依赖桌面端在场） | molly-ovo/dsh-workbuddy-oauth、wb2api-panel 浏览器 OAuth（§3.1） | 覆盖「桌面端不在 / 未登录」与服务器场景；仍可保持「凭据不落盘」 |
| P2-9 | **README 内置「把安装交给 Agent」引导提示词**（版本判定 → 安装 → 验证一套全给） | corrinehu/dsh-workbuddy-connect（§4.7） | 本项目用户全是 AI 客户端用户，这条几乎零成本 |
| P2-10 | **评估 npm 发布形态**（`dsh-workbuddy-connect`、`xdpool` 都是一个包名一行装） | corrinehu / XDTrees（§3.1 B） | 降低 dsh 侧安装门槛；注意与 vendor 分发的一致性 |

### P3 —— 战略级（取决于定位决策）

| # | 动作 | 前置决策 |
|---|---|---|
| P3-1 | **多账号池化 + round-robin + 健康降级** | 本项目最大的功能缺口；直接竞品已有三种现成范式：wb2api-panel 加权池 + 熔断、xdpool 4 模式（含 sticky）、kiro-gateway 温和式 failover（§3.1 / §4.6 / §4.8） |
| P3-2 | **界面 i18n（至少 EN）** | 项目已支持国际版网关，中文界面与之矛盾 |
| P3-3 | **重新定位：继续「个人自用工具」还是走向「可分发产品」** | **这是最重要的一条**——见下 |
| P3-4 | **在 README 披露与直接生态的关系**：与 CCR 的方向关系（导出 vs 注入）+ 与 WorkBuddy2API 集群的定位差异（单账号 / 不落盘 / 零依赖 / 自用） | §3.1、§4.3.1；不写清楚，用户会拿本项目与多账号网关直接比功能表 |

> **关于 P3-3**：README 反复强调「这是个人自用工具的源码，不是产品，也不面向分发推广」，
> 但代码里已经有 9 标签页控制台、用量账本、积分体系、签到、体检、CSV 导出、
> vendor 分发包、CI、release tag、`.promo/` 下 8 个平台的推广文案。
> **文档定位与工程投入严重错位**。
> 两条路都成立，但必须选一条：
> - **选「个人自用」** ⇒ 停止投入控制台功能，删掉 `.promo/`，把精力收回到桥的稳定性与协议正确性（P0/P1）。
> - **选「可分发」** ⇒ 按 P1–P3 补齐，尤其是限流、凭据分层、Docker、EN 文档、CONTRIBUTING，
>   并把免责声明按 copilot-api 的方式前置（带上游条款链接）。
>
> **第二轮补充后的紧迫性（2026-10-07）**：直接生态以「月」为单位迭代，多账号池、Web 面板、
> 任务自动化、dsh 集成正在被快速标准化（§3.1）。「选可分发」的入场难度已显著上升——
> 差异化只能押在别人不做的维度上（凭据不落盘、零依赖、诚实分度、单文件自包含）；
> 「选个人自用」的清单则基本不变（P0 开放项 + P1）。

---

## 8. 值得借鉴的具体做法

按「可立即落地」排序，每条都注明来源与本项目该怎么做。

### 8.1 测试与质量

| # | 借鉴做法 | 来源 | 本项目怎么做 |
|---|---|---|---|
| 1 | **测试夹具必须来自真实产物，不能来自被测常量** | 本项目 §6.0 的反面教训 | 所有「读外部资源做判断」的常量都加一条「常量 vs 真实文件」交叉校验测试 |
| 2 | **目录 1:1 镜像 + 只允许 mock** | LiteLLM `tests/test_litellm/` | 本项目测试已在 `dsh-plugin/tests/`，可加规则：测试不得打真实上游 |
| 3 | **录制回放 + 假端点** | LiteLLM（respx / pytest-recording / `_vcr_conftest_common.py`） | 本项目已有打桩上游的测试（`adapter.test.mjs`），可固化成可复用的 stub 库 |
| 4 | **变异测试验证测试有效性** | LiteLLM CI `mutation-test`；本项目 `.optimize/SUMMARY.md` 已手工做过 | 把手工变异验证固化成脚本 |
| 5 | **PR 强制带测试** | LiteLLM CONTRIBUTING | 写进 CONTRIBUTING.md |

### 8.2 架构与扩展性

| # | 借鉴做法 | 来源 | 本项目怎么做 |
|---|---|---|---|
| 6 | **渐进式扩展机制：先给纯兼容的 provider 一个 JSON 注册表，复杂者才写代码** | LiteLLM `providers.json` + Config 类 | 把「协议适配」抽成 `adapters/` 目录 + 注册表；新增客户端协议只加一个文件 |
| 7 | **协议转换抽成独立可构建单元** | new-api `relaykit/` 独立 Go module | 把 Anthropic ↔ OpenAI 翻译抽成 `bridge/protocol/` 独立模块，带自己的 README 与测试 |
| 8 | **重试分层：组内换部署 vs 跨组降级** | LiteLLM `function_with_retries` / `function_with_fallbacks` | 桥侧加「同模型重试 → 换等价模型」两级 |
| 9 | **虚拟 key 哈希存储 + master key 明文仅内存** | LiteLLM key auth 架构 | 为 P1-5 的凭据分层做准备 |
| 10 | **架构文档用 mermaid 画请求链路 + 「加 provider 三步走」表** | LiteLLM `ARCHITECTURE.md` | 本项目 `ARCHITECTURE.md` 已有 ASCII 图，升级为 mermaid + 加「加一个客户端协议」操作表 |
| 11 | **状态与进程解耦（无状态 + 共享存储）** | LiteLLM、new-api | 短期不必要；若走 P3 需规划 |

### 8.3 可观测性与性能

| # | 借鉴做法 | 来源 | 本项目怎么做 |
|---|---|---|---|
| 12 | **网关自身开销做成响应头** | LiteLLM `x-litellm-overhead-duration-ms` | 加 `X-WorkBuddy-Overhead-Ms`；同时把「keep-alive 省 150ms」变成可测数字 |
| 13 | **提供 `network_mock` 式纯开销压测模式** | LiteLLM | 加 `WORKBUDDY_BENCH=1` 打桩上游，只量桥开销 |
| 14 | **公开基准并把缺点写在同一页** | LiteLLM benchmarks（自曝高内存） | 本项目 `ARCHITECTURE.md` 的量化结论应配可复现脚本 |
| 15 | **回调总线 + 稳定日志契约** | LiteLLM StandardLoggingPayload | 账本已有稳定 schema，可补一个「导出为通用格式」的钩子 |

### 8.4 产品与体验

| # | 借鉴做法 | 来源 | 本项目怎么做 |
|---|---|---|---|
| 16 | **一条命令生成可粘贴的客户端配置（选完模型自动进剪贴板）** | copilot-api `--claude-code` | 控制台「客户端接入」面板加「生成并复制启动命令」按钮 |
| 17 | **限流做成产品功能而不是文档建议** | copilot-api `--rate-limit` / `--wait` | 见 P1-1 |
| 18 | **管理模式与客户端模式用两套凭据** | claude-code-router | 见 P1-5 |
| 19 | **端口被占用时自动试下一个并打印实际 URL** | claude-code-router | 桥/控制台启动时同样处理，省掉一类「起了但连不上」 |
| 20 | **管理 URL 含 token 时，文档明确「当密码对待」** | claude-code-router | 本项目控制台无 token，但 `WORKBUDDY_LOCAL_TOKEN` 的说明可参照此措辞 |
| 21 | **无头/SSH 环境用 `--no-open` 区分** | claude-code-router | 本项目已有 `DASHBOARD_OPEN_BROWSER`，语义可对齐 |
| 22 | **不编辑正在写入的 SQLite** 这类「数据安全叮嘱」写进文档 | claude-code-router | 本项目对应的是 `.state.json` / `usage.jsonl`，值得写一句 |
| 23 | **README 里放编号的「Make your first request」可执行流程** | new-api | 本项目「快速开始」偏概念，可补「5 步跑通第一次对话」 |
| 24 | **部署安全清单直接写进 README**（改默认密码、生成 secret、HTTPS、TRUSTED_PROXIES） | new-api | 本项目对应：改 `WORKBUDDY_LOCAL_TOKEN`、不要绑 0.0.0.0、端口冲突处理 |
| 25 | **Docker 做非 root + healthcheck + 固定基础镜像版本** | copilot-api | 见 P2-2 |
| 26 | **setup wizard 替代手改配置** | new-api | 本项目已有「双击即用」+ 自动探测，基本达标；可补首启的一次性引导 |
| 27 | **明确的能力边界声明 + 上游条款链接，放在最前** | copilot-api 两处 `[!WARNING]` | 本项目声明已很充分，但**没引用 WorkBuddy 的服务条款链接**，建议补 |
| 27b | **把「与本项目方向相反的同类集成」显式写清** | claude-code-router 的 WorkBuddy 文档页（§4.3.1） | 在本项目 README 补一句「方向相反、可组合」，避免用户混淆两者价值 |
| 27c | **每个 Agent 一节独立文档页 + 四条常见问题** | claude-code-router `configuration/agents/*` | 本项目「客户端接入」已分档，可升级为「每个客户端一节 + 该客户端专属常见问题」 |
| 28 | **把非核心能力让给生态，而不是什么都自己做** | CLIProxyAPI v6.10.0 移除内置用量统计、推荐第三方 | 与 P3-3 的定位决策直接相关：控制台该收敛还是扩张 |
| 28b | **逐请求人工批准开关**（`--manual`） | copilot-api | 本项目已有「对话测试」，但缺「拦截并逐条放行」；对排查异常流量有用 |
| 28c | **凭据文件化 + 多存储后端抽象**（本地文件 → Postgres/Git/S3） | CLIProxyAPI `PGSTORE_*`/`GITSTORE_*`/`OBJECTSTORE_*` | 本项目单机自用无需；若走 P3 需此抽象 |
| 28d | **模型目录远程热更新 + 失败保留上一版** | CLIProxyAPI `models.catalog`（3h TTL） | **本项目已实现**（5min TTL + 硬失败不动缓存 + `staleMs`），属于对齐甚至更细 |
| 28e | **会话粘性（session-affinity）提升 Prompt/KV Cache 命中** | CLIProxyAPI `session-affinity` | 本项目单账号用不上；若做 P3-1 多账号池则**必须**配套，否则缓存命中率暴跌 |

### 8.5 文档工程

| # | 借鉴做法 | 来源 | 本项目怎么做 |
|---|---|---|---|
| 29 | **独立文档站**（Docusaurus 或 GitHub Pages） | LiteLLM / new-api / CLIProxyAPI / claude-code-router | 见 D1；单页站即可 |
| 30 | **`llms.txt` + Swagger 让 coding agent 能读文档** | LiteLLM | 本项目用户全是 AI 客户端用户，这条**收益尤其高** |
| 31 | **文档拆到独立仓库** | LiteLLM `litellm-docs` | 视 P3-3 决定 |
| 32 | **多语言 README** | new-api 5 语言 / CLIProxyAPI 3 语言 | 至少补 EN（与「支持国际版网关」呼应） |
| 33 | **严格发布节奏 + 明确支持窗口**（nightly→rc→stable，只支持最近 4 条 minor） | LiteLLM release cycle | 本项目可简化为「tag + CHANGELOG + 支持最近 2 条」 |
| 34 | **质量预算棘轮（budget JSON 只许下调）** | LiteLLM Code Quality | 若引入 eslint，可用 `--max-warnings` 做棘轮 |
| 35 | **AGENTS.md 作为贡献前必读** | new-api / copilot-api | 本项目已有 `.trae/specs/` 工作流痕迹，可固化成 `AGENTS.md` |
| 36 | **设计系统文档** | **本项目独有优势**（`DESIGN_SYSTEM.md` 264 行，竞品全无） | 保持；这是本项目的差异化资产 |
| 37 | **架构文档解释「为什么这么选」而非「这行做什么」** | **本项目独有优势**（`ARCHITECTURE.md` 587 行，质量超过全部 5 个竞品） | 保持；补 mermaid 与决策记录即可 |

---

### 8.6 品类级风险（对本项目最重要的一节）

这两个「订阅额度 → 兼容 API」类项目暴露了三条**与本项目同源**的品类级风险。
它们不是「竞品的缺点」，而是**本项目迟早会遇到（或已经遇到）的结构性问题**。

### 风险 1：上游协议漂移会让项目周期性整体失效

copilot-api 硬编码 `API_VERSION = "2025-04-01"`、`COPILOT_VERSION = "0.26.7"`，
上游一改版本就直接整体报错（`the specified API version is no longer supported`）。

**本项目的对应情况**：桥同样硬编码了 `APP_VERSION = '4.9.29177644'`、
`IDE_VERSION = '1.119.0'`、`IDE_NAME = 'VSCode'`（`bridge/workbuddy-bridge.mjs:35-38`），
并且要伪装成官方客户端（README 「请求头伪装成官方客户端」）。
**区别是**：本项目把「目录端点合并不完整」「上游比规范更严」等约束都用
归一化与容错层兜住了（见 `ARCHITECTURE.md` 第二节），这比 copilot-api 的单点硬编码**更抗漂移**。
但版本号本身仍是硬编码 —— 建议增加一条**版本探测失败时的降级路径与明确报错**，
并在 README 的排错表里补「上游改了版本号」这一症状。

**第二轮补充的证据（2026-10-07）**：
- 直接竞品的 UA 已按 **`WorkBuddy/5.5.4` + `CLI/2.137.1`** 三段式校准，并支持 **WB / VSC / CLI 三套客户端身份**切换
  （§3.1 W1、W3、W6）；本项目桥固定 `VSCode/1.119.0 CodeBuddy/4.9.x`（`bridge/workbuddy-bridge.mjs:35-37`，本次复核）——
  **同一后端、不同客户端身份的版本漂移已经发生**。
- 上游内容审核按**逐字匹配**拉黑 Claude Code 的固定 system 模板句，竞品的对策是最小改写 + 明确承认这是 cat-and-mouse
  （§3.1 W4）。本项目桥目前**没有对应层**（grep 无 sanitize / 模板改写），是否命中需实测（§7 P1-10）。
- 本项目桥**已经处理了上游特有语义**（非流式被 400 code 11101 拒绝 → 内部转流式；瞬时 400 code 11133 → 幂等重试，
  `workbuddy-bridge.mjs:8-11,580-587`），与竞品记录的同类怪癖一致——**协议容错层是这类项目的必要基建，方向正确**。

### 风险 2：代理使用可能被上游判定为「API 计费」而非「套餐额度」

CLIProxyAPI 有一条高热度 issue：同一个 Claude Max 账号，
原生桌面端走 included plan usage，而经代理走 **extra usage**，
直接把用户的 spending cap 打爆 —— 这**直接摧毁了项目的核心价值主张**。

**本项目的对应风险**：桥消耗的是登录账号的配额，而**积分/签到体系的存在恰恰说明上游是按量计费的**。
项目已经做了两件正确的事：① 控制台如实展示积分余额与消耗；
② 用量账本记录每次调用的实际扣分（`credit` 字段）。
**建议补一条**：在 README 与 `SECURITY.md` 里明确写「经桥调用与在 WorkBuddy 客户端内直接使用的
计费口径是否一致，需要用户自行核对」，并给出**核对方法**
（控制台「用量统计」的积分合计 vs 客户端内的用量显示）。
这是本项目已有数据能力、只差一句指引就能补上的信任缺口。

### 风险 3：「连上上游后不设超时」会让静默 hang 无法自愈

CLIProxyAPI 的 AGENTS.md 明确规定「超时只允许出现在凭据获取阶段，上游连接建立后不得设置超时」，
理由是支持超长流式生成。代价是出现了一条 150 条评论、37 🚀 的 issue：
请求不报错、不超时、不断线，客户端无限等待，**只能靠用户手动中断**。

**本项目的对应情况**：**完全相同的取舍**。
`config.mjs:144` 的 `upstreamTimeoutMs` 默认 **0 = 不限**，
`.env.example` 的注释写明「0 = 不限；长回答需要保持 0」。
`ARCHITECTURE.md` 也解释了为什么健康检查不等上游。

**本项目目前比 CLIProxyAPI 好的地方**：账本会记录失败（含 `ok:false` 与错误码），
「最近请求」面板能看出哪次调用卡住了。**但仍缺**：
① 卡死请求的**主动可见性**（目前只有「耗时很长」这一隐式信号，没有「超过 N 分钟仍未结束」的告警）；
② 客户端断开后上游连接是否及时释放的验证。

**建议**：这是本项目可以用很小代价做出差异化的地方 ——
在「最近请求」里为进行中的请求显示时长，并对超过阈值的活跃请求给出提示
（注意：**不要**因此给上游加默认超时，那会破坏长回答，这正是 CLIProxyAPI 拒绝做的事）。

### 风险 4：维护可持续性（copilot-api 与 Sliverkiss 两个已发生案例）

copilot-api 曾有 4.1k star，2025-11 后停更（≈11 个月），活跃度转移到 fork `caozhiyuan/copilot-api`（1,073★）。
**更近的案例**：本项目生态的原版 `Sliverkiss/workbuddy2api` 于 **2026-09-24 从 GitHub 消失**
（本次实测 `gh api repos/Sliverkiss/workbuddy2api` 返回 404，删除或转私有）。
生态的反应有三种，都值得本项目预先想好：
1. **延续副本**：`HanawaBanana/workbuddy2api`（§3.1 W5）承接完整历史（最后公开提交 `9a26ae7`）继续维护；
2. **增强分支接管**：`linguo2625469/workbuddy2api-panel`（§4.6）声明已同步至上游删库前最后提交（`ea8b1e5`），此后独立演进；
3. **clean-room 重建**：`lovingfish/workbuddy-cliproxy`（§3.1 W4）针对上游只发布二进制的插件做重写。
再叠加 §3.2 的统计规律——**单目标导出项目普遍 3–12 个月停更**（Zed / Warp / Cursor / 主 Kiro-gateway / copilot-api 全部符合），
聚合型与宿主绑定型更长寿——本项目的结构性位置需要正视。

**对本项目的映射**：本项目是**单人维护、依赖一个未公开协议的桌面端**，
且已在 README 里承认「上游随时可能改动协议或封禁这种方式，可用性无任何保证」。
这不是可以「优化」掉的问题，而是应当被明确管理的问题。可落地的四件事：
1. **把 fork/接手的成本降到最低** —— 这正是 `ARCHITECTURE.md` 的价值；保持它。
2. **加 CHANGELOG 与迁移说明**，让接手者知道每个版本改了什么、为什么。
3. **在 README 顶部给出「上游失效时的第一排查步骤」**，而不是只在排错表里列症状。
4. **明确源码许可与「接手须知」**——这个生态里，MIT + 完整注释 + 单一真源的数据文件就是最好的"遗产"
   （对比：原版删库后，接手者只能从副本快照续命）。

### 风险 5：生态滥用会加速上游收紧（第二轮新增）

`linguo2625469/workbuddy2api-panel` 的使用声明（必读）公开指控三类滥用：
批量注册小号 / 收购账号后对外提供付费 API 与共享池；二次加壳、捆绑卡密售卖；
以「公益服」「低价中转」名义变相收费分发。作者原文写道：
**「上游仓库已删除、停止公开维护——我们无法断定具体原因，但此类滥用行为正在毁掉所有正常使用者的环境。」**
（因果部分属其推断，本报告如实转述并标注。）

同期技术证据：`xiaofan6ya/workbuddy2api`（§3.1 W6）实测发现上游已接入**设备风控头 `X-Device-Token`**
（由桌面端 Turing Shield SDK 生成，签到 / 对话等敏感请求需要携带，否则被识别为「非真实客户端」）。
本项目的桥**目前不注入该头**（`bridge/workbuddy-bridge.mjs` 全文检索 0 命中，本次复核）——
当前可行，但属于应监控的信号。

合起来看：**上游对「非真实客户端」的识别能力在增强，而生态里的滥用正在提供动机。**
本项目的暴露面比多账号共享类项目小得多（单账号、仅回环、不做分发、凭据不落盘），
但它与滥用者**共用同一后端和同一类协议做法**——若上游做整体收紧（更强的设备指纹、
更大的模板黑名单、计费口径切换），本项目无法完全置身事外。可落地动作：
1. 保持「不伪造能力、不落盘凭据、不做共享」的立场，并在 README 里写成对上游的承诺（与 §7 P1-7 合并）；
2. 监控上游是否开始要求新头 / 新字段（`X-Device-Token` 是第一个信号，桥的归一化层可为其预留兜底）；
3. 把「上游收紧」写进 README 的已知风险，而不是只写「协议可能变」。

### 8.7 第二轮补充的借鉴清单（#38–#45）

与 §8.1–§8.5 编号连续。**只保留可直接落地、或与具体风险绑定的条目**；
纯观察类或与已有条目重复的内容（TLS 指纹 sidecar、provider 三步走、自发现 API、目录来源标注、clean-room 说明）已剔除或并入相应章节。

| # | 借鉴做法 | 来源 | 本项目怎么做 |
|---|---|---|---|
| 38 | **账号池的「加权选号 + 防惊群」**：按积分过期加权、成本分层、Top-5 候选、在途租约 | wb2api-panel（§4.6） | P3-1 若启动，选号算法有现成参照；**必须与粘性一起做**，否则上游缓存命中率崩 |
| 39 | **分级熔断与冷却**：429 软冷却指数退避 / 404 短冷却 / 402 硬冷却到次日 / 连续失败熔断 | wb2api-panel、wb2api-hub（§3.1） | 与 P1-1 限流合并设计：限流不是「拒绝」而是「冷却 +（未来）换号」 |
| 40 | **会话粘性键的兜底派生**：无 `conversation_id` 时用 `system + 首条 user` 哈希派生 | wb2api-panel | 若做粘性，任何 OpenAI 客户端都要能吃到，不能只认 `conversation_id` |
| 41 | **设备风控头复用官方 SDK、不伪造**：调用桌面端 Turing Shield SDK 生成 `X-Device-Token`，不可用时降级并注明 | xiaofan（§3.1 W6） | 与本项目「现取现解」同思路；**先核实上游当前是否已对对话请求要求该头**（§8.6 风险 5） |
| 42 | **「把安装交给 Agent」引导提示词**：README 内置可直接粘贴给 AI 助手的安装流程 | dsh-workbuddy-connect（§4.7） | 本项目用户全是 AI 客户端用户，几乎零成本（§7 P2-9） |
| 43 | **版本对照矩阵 + 「只跟最新一代」的取舍** | dsh-workbuddy-connect / dsh-workbuddy-oauth | 反向证据：本项目「不依赖 dsh 版本」的策略被验证更省心，应在 README 明说（§4.7） |
| 44 | **上游内容审核的「最小改写」对策**：模板句被逐字拉黑 → `CLI`→`CLI tool`、`Main branch`→`Default branch`，并承认 cat-and-mouse | workbuddy-cliproxy（§3.1 W4） | **优先实测核实本项目是否命中**（§7 P1-10）；若命中，做同类改写并加测试 |
| 45 | **npm 一行安装 + 内置预构建产物** | dsh-workbuddy-connect / xdpool | 降低 dsh 侧门槛（§7 P2-10）；注意 `lib/` 必须随包 |

---

## 9. 总体研判

### 9.1 本项目真正的优势（应当保持，不要为了「对齐竞品」而丢掉）

1. **零运行时依赖 + 单文件自包含桥** —— 5 个竞品全部依赖框架与依赖树。
   LiteLLM 的供应链投毒事件（`litellm_init.pth`）与 1.99GB 仓库正是这条优势的反面证明。
2. **架构文档与注释的「为什么」密度** —— `ARCHITECTURE.md` 587 行解释每条设计取舍，
   质量**高于全部 5 个竞品**。竞品文档多写「怎么用」，本项目写「为什么这么做」。
3. **单写者纪律与状态同步设计** —— `.state.json` 只由持有缓存的进程写、
   插件走白名单透传。这种严谨度在竞品里没有对应物。
4. **凭证安全的思路** —— 不逆向密钥派生、不硬编码、不写回登录文件，
   密钥由客户端进程现取。这是比「落盘 token」更干净的互操作实现。
5. **诚实度** —— 兼容性分三档如实标注、embedding 明确 501 而非伪造、
   倍率不跨区域猜、数据不足显示「—」并给原因。**这是最难得的品质**，
   也是本报告敢以高标准提建议的前提。
6. **慢上游隔离（SWR）+ 健康检查不阻塞** —— 属于罕见的好设计，竞品少有。
7. **在直接竞品群里仍然罕见的凭据纪律**：§5.7 横向对比里，「凭据不落盘」是本项目唯一一骑绝尘的单元格
   （集群里明文落盘是常态：panel 的 `auths/` 明文 token、connect 的自留副本、molly 的插件目录落盘）。
   **这一条现在有对照样本了，应该更响亮地讲。**
8. **零依赖单文件 vs 集群的技术栈（Go / Python / TS + Docker）**：本项目仍是唯一「双击即用、零安装」的形态之一
   （panel 的 Windows 单 exe 是最接近的对照）。

### 9.2 真正的差距集中在三处

| 差距簇 | 表现 | 本质 |
|---|---|---|
| **可运营化** | 无指标、无限流、无凭据分层、无跨组降级、性能主张无自证 | 项目停留在「能跑通」，没进入「可长期运行并可回答『它现在好不好』」 |
| **可扩展性** | 协议翻译硬编码在 2,618 行核心文件；无适配器注册表 | 每加一个能力都在放大同一个文件的复杂度 |
| **产品化错位** | 文档说「个人自用、不分发」，代码有 9 标签页 + vendor 包 + CI + 8 平台推广文案 | 定位与投入不一致，导致两条路都没走到位 |

### 9.3 四条不应被忽略的品类级判断

1. **本项目处于一个「参照物会消失、且空位会立刻被填」的品类里。** copilot-api 停更 ≈11 个月、
   `Sliverkiss/workbuddy2api` 删库、单目标项目普遍 3–12 个月生命周期（§3.2）；而 WorkBuddy 方向一旦
   被证明有需求，新项目以「月」为单位长出来（panel 创建 27 天即 2,136★）。**不是「没人做」，
   是「做的人在快速换」。** 本项目的应对方式（自建桥 + 不依赖 dsh 版本 + 归一化容错层 + 单文件自包含）
   在同类里仍属较稳，但「稳」只解决生存，不解决可见度。
2. **本项目在三个关键取舍上做对了，且与头部竞品一致或更好**：
   - 不设上游默认超时（与 CLIProxyAPI 同判断），且**多了失败记账**——本项目可以在此基础上做「卡死可见」；
   - 模型目录远程刷新且失败保留上一版（比 CLIProxyAPI 的 3h 盲刷更细，有 `staleMs` 语义）；
   - 凭证现取现解、不落盘（比 copilot-api / CLIProxyAPI 的凭据文件更安全）。
3. **最值得补的不是功能，而是「可回答问题的能力」：**
   本项目已积累足够数据（账本、积分、体检、诊断），
   但缺少把这些数据变成「性能主张 / 计费核对 / 卡死可见」的出口（对应 P1-2、P1-7、P1-8）。
4. **「导出配额」本身的稀缺性已被清零（第二轮补充的核心结论）。** 9–10 月间，同目标集群从数个项目
   扩张到 ≥20 个活跃项目、10+ 个 dsh 插件，覆盖多账号池化、Web 面板、任务自动化、按 Key 计费——
   初稿「本项目独有 ✅」的判断已不成立（§5.5 已改）。**可防守的差异只剩工程质量与信任维度**：
   凭据不落盘、零依赖、单文件、诚实分档、控制台深度、一手工程记录。

### 9.4 建议的唯一决策点

**先回答「个人自用」还是「可分发」，再决定投入方向。**
所有 P3 级建议、以及 P1/P2 里一半的工作量，都取决于这个答案。
P0 的开放项（P0-2 / P0-4 / P0-5）应当先收掉 —— 它们是缺陷与纪律，不是取舍。

**第二轮补充让这个决策更紧迫**：直接生态以「月」为单位迭代（多账号池、Web 面板、任务自动化、
dsh 集成正在被快速标准化，§3.1）。若选「可分发」，入场时你在追赶而不是补空白——差异化只能押在
别人不做的维度上（凭据不落盘、零依赖、诚实度、单文件）。若选「个人自用」，P0/P1 清单依然值得做完，
只是不必追生态动态。**两个选项都成立；唯一不成立的是继续用「个人自用」的措辞包装「可分发」的投入。**

---

## 附：本报告核心结论的复核方式

```powershell
# 1. P0-1 复核：识别已改用结构标记（初稿的标题漂移取证已成历史）
Select-String -Path dsh-plugin/lib/console.mjs -Pattern 'CONSOLE_MARKER'
Select-String -Path dsh-plugin/scripts/verify-standalone.mjs -Pattern 'navTabs'
Select-String -Path dashboard/public/index.html -Pattern 'id="navTabs"'   # 真实页面里必须存在

# 2. 测试夹具的自证模式（构造夹具的常量来自被测代码；真产物校验在 verify-standalone 演练层）
Select-String -Path dsh-plugin/tests/plugin.test.mjs -Pattern 'CONSOLE_MARKER'

# 3. release:check（vendor:check + 74 用例 + 独立分发演练）
npm run release:check
# 复核（2026-10-07 晚）：全绿，退出码 0（初稿时曾因 vendor 不同步失败，已修复）

# 4. README 注意事项段落重复（第 348 行与第 354 行同文）
Select-String -Path README.md -Pattern '^\d\. \*\*'

# 5. 测试与规模基线
npm run test:plugin                                    # 74 用例
node --test bridge/bridge.test.mjs                     # 12 用例

# 6. 行数统计（换行符计数 = read 工具口径；Get-Content 的 Measure-Object -Line 会偏大）
#    排除 vendor 快照与工具缓存目录后：源码 + 前端 31,544 行 / 79 文件（含测试 3,573 行 / 10 文件）
node -e "const fs=require('fs'),p=require('path');const EX=new Set(['vendor','node_modules','.git','.backup','.tmp-research','.trae','.promo','.optimize','.workbuddy-ai']);let t=0,n=0;(function w(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){const q=p.join(d,e.name);if(e.isDirectory()){if(!EX.has(e.name))w(q);}else if(/\.(mjs|js|html|css)$/.test(e.name)){t+=(fs.readFileSync(q,'utf8').match(/\n/g)||[]).length;n++;}}})('.');console.log(t,'行 /',n,'文件');"

# 7. 第二轮竞品数据复核（gh CLI，已登录；2026-10-07~08）
gh api repos/linguo2625469/workbuddy2api-panel --jq '.stargazers_count, .pushed_at, .license.spdx_id'  # 2,136 / MIT
gh api repos/Sliverkiss/workbuddy2api                       # 预期 404 —— 原版删库实测
gh search repos workbuddy2api --limit 100 --json fullName | ConvertFrom-Json | Measure-Object   # 生态规模 ≥100（触上限）
gh search repos "dsh workbuddy" --limit 100 --json fullName | ConvertFrom-Json | Measure-Object # ≥40（触上限）
gh api repos/corrinehu/dsh-workbuddy-connect/readme -H 'Accept: application/vnd.github.raw'     # README 原文直抓（快照做法）
gh api repos/deepseek-ai/deepseek-harness --jq '.stargazers_count'                             # 245,033（宿主平台 DSH）
```

**外部资料 URL**：
[copilot-api README](https://cdn.jsdelivr.net/npm/copilot-api@0.7.0/README.md) ·
[copilot-api npm 元数据](https://registry.npmjs.org/copilot-api/0.7.0) ·
[CLIProxyAPI README](https://raw.githubusercontent.com/router-for-me/CLIProxyAPI/master/README.md) ·
[CLIProxyAPI star 徽章](https://img.shields.io/github/stars/router-for-me/CLIProxyAPI.json) ·
[claude-code-router README](https://cdn.jsdelivr.net/npm/@musistudio/claude-code-router@3.1.1/README.md) ·
[claude-code-router npm latest](https://registry.npmjs.org/@musistudio/claude-code-router/latest) ·
[new-api README](https://raw.githubusercontent.com/Calcium-Ion/new-api/main/README.md) ·
[new-api star 徽章](https://img.shields.io/github/stars/QuantumNous/new-api.json) ·
[LiteLLM repo API](https://api.github.com/repos/BerriAI/litellm) ·
[LiteLLM 文档站](https://docs.litellm.ai/) ·
**第二轮新增**：[workbuddy2api-panel](https://github.com/linguo2625469/workbuddy2api-panel) ·
[workbuddy2api-hub](https://github.com/ardeyouxipianyi/workbuddy2api-hub) ·
[workbuddy-manager](https://github.com/ithtelab/workbuddy-manager) ·
[dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect) ·
[dsh-workbuddy-xdpool](https://github.com/XDTrees/dsh-workbuddy-xdpool) ·
[dsh-workbuddy-oauth](https://github.com/molly-ovo/dsh-workbuddy-oauth) ·
[workbuddy-cliproxy](https://github.com/lovingfish/workbuddy-cliproxy) ·
[xiaofan6ya/workbuddy2api](https://github.com/xiaofan6ya/workbuddy2api) ·
[kiro-gateway](https://github.com/jwadow/kiro-gateway) ·
[AIClient2API](https://github.com/justlovemaki/AIClient2API) ·
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) ·
[dsh 插件市场](https://github.com/imsai-sh/awesome-deepseek-harness-plugins)
