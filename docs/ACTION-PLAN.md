# 执行计划 —— 从竞品调研到落地（WorkBuddy 本地 API 桥）

> 来源：`docs/COMPETITIVE-RESEARCH.md`（§6 差距清单、§7 优先级、§8.7 借鉴、§9 研判）
> 基准状态：HEAD `f30eee9`；`package.json` 1.2.0；`release:check` 全绿；tags 到 v1.1.0
> 结构：**批次一 / 二无条件执行**（两种定位下都值得做）→ **决策门**（定位）→ **批次三按分支** → **批次四可选**。
> 定位假设：本计划按「定位后置」的两段式编写。若你已确定方向，直接采用对应分支即可，批次一 / 二不变。

---

## 0. 执行纪律（先定规矩）

1. **每项以验收为准**：没跑过验收命令、没有可观察结果 = 未完成。
2. **先红后绿**：涉及代码的条目，先加一条会失败的测试再实现（插件 `npm run test:plugin`、桥 `node --test bridge/bridge.test.mjs`）。
3. **默认行为向后兼容**：新增能力一律默认关闭（限流、告警阈值等）；如确需改变默认行为，单独说明并写入 CHANGELOG 的「破坏性变更」。
4. **不做清单（红线）**：不加默认上游超时；不伪造能力（embeddings 保持 501）；凭据不落盘；不做多账号共享池 / 批量注册 / 付费分发；不追生态功能竞赛。
5. **流程**：不开新分支 / worktree；每批次完成 → 跑 `npm run release:check` → 报告结果，**提交动作等你确认**；每条在 CHANGELOG 留一行。
6. **命名沿用现有约定**（`WORKBUDDY_*` / `DASHBOARD_*`，见 `.env.example`）。

> 参考：初稿 P0 中「标题漂移」「vendor 同步」已由 `f30eee9` 修复（见报告 §6.0），批次一只收剩余项。

---

## 1. 批次一：收尾与风险核实（无条件，先做）

**目标**：把已确认的缺陷清零、把两个「待实测的风险」变成结论、版本一致性到位。
起手顺序：1.2 → 1.1 → 1.3 → 1.4 → 1.5 → 1.6（先摘低风险果子，再进核查）。

| # | 任务 | 动哪里 | 做什么（要点） | 验收 | 大小 |
|---|---|---|---|---|---|
| 1.1 | **probe() 有界读取**（§7 P0-2） | `dsh-plugin/lib/console.mjs:79-113` | 把「只读首个 chunk」改为逐块读、命中 `CONSOLE_MARKER` 即停（或读到上限如 512KB）；先加桩测试（标记前塞 110KB 填充） | ① 新测试在旧实现下**红**、修后绿；② `npm run test:plugin` 全绿；③ `release:check` 绿 | 小 |
| 1.2 | **README 注意事项去重**（§7 P0-4） | `README.md`（第 2–7 条各出现两次） | 删掉重复块 | `Select-String README.md -Pattern '^\d\. \*\*'` 每条各一次 | 小 |
| 1.3 | **交叉校验纪律落地**（§7 P0-5） | `dsh-plugin/tests/plugin.test.mjs` | 加一条直读 `dashboard/public/index.html` 的测试：断言 `CONSOLE_MARKER` 出现在前 N KB（把真产物断言从 verify-standalone 演练层下沉到单测层） | ① 测试通过；② 临时改 `index.html` 标记 → 测试**红**，还原 → 绿 | 小 |
| 1.4 | **上游内容审核核查**（§7 P1-10，可能是真缺陷） | 新探针脚本（放 `tools/dev/`，用完决定去留）→ 视结果改桥的 Anthropic→上游转换层 | 向桥发一条带 Claude Code 两句固定 system 模板（`You are Claude Code, Anthropic's official CLI for Claude.` / `Main branch (you will usually use this for PRs)`）的 `/v1/messages` 请求（最短消息，少量积分）。**命中** → 按 §3.1 W4 做法最小改写（`CLI`→`CLI tool`、`Main branch`→`Default branch`）+ 测试「出站 system 不含黑名单原文」；**未命中** → 结论（日期 + 复现命令）写入 `docs/TROUBLESHOOTING.md` | 结论落文档；若命中，改写层 + 测试齐备。**两种情况都不留悬案** | 中 |
| 1.5 | **版本 / 身份核查 + 版本号可配置**（§7 P1-11） | `bridge/workbuddy-bridge.mjs:35-37,430-437`、`config.mjs`、`.env.example` | ① 用现固定身份发一次请求确认仍被上游接受；② `APP_VERSION/IDE_VERSION/IDE_NAME` 改为可配（`WORKBUDDY_APP_VERSION` 等，默认值不变）；③ 排错表补「上游版本漂移」症状与处置 | ① 新 env 能覆盖出站 UA（测试断言）；② 排错文档更新；③ release:check 绿 | 小 |
| 1.6 | **CHANGELOG + v1.2.0 tag**（§7 P1-6） | 新 `CHANGELOG.md`；git tag | Keep a Changelog 风格：v1.2.0 条目（对照报告 §2.3 与 git log 回溯）+ 顶部「维护约定」（发版三步：release:check → CHANGELOG → tag）；补 v1.2.0 tag | `git tag` 含 v1.2.0；CHANGELOG 条目与实际功能一致 | 小 |

**批次一门**：`npm run release:check` 退出码 0；新增测试 ≥3 条；1.4 / 1.5 结论已写入文档；CHANGELOG 与 tag 就位。

---

## 2. 批次二：账号保护与可观测（无条件）

**目标**：补齐报告 §6 的 F2（无限流）、F5（无指标）、卡死可见、计费信任缺口——全部「只增不改」。

| # | 任务 | 动哪里 | 做什么（要点） | 验收 | 大小 |
|---|---|---|---|---|---|
| 2.1 | **本地限流**（§7 P1-1） | 桥请求入口 + `config.mjs` + 账本 + 控制台 | 两个旋钮：`WORKBUDDY_RATE_LIMIT_RPM`（每分钟上限，默认 0 = 关）、`WORKBUDDY_RATE_LIMIT_MIN_INTERVAL_MS`（最小间隔）；超限默认**排队等待**（对齐 copilot-api `--wait`），可配改为拒绝（429 + Retry-After）；账本增加 `rate_limited` 归因 | ① stub 上游测试：上限 N 时上游恰好收到 N 条，第 N+1 条被排队 / 拒绝；② 默认关闭时旧测试全部不变；③ 控制台可见触发次数 | 中 |
| 2.2 | **开销可度量**（§7 P1-2） | 桥响应写出处 + `/health` + `ARCHITECTURE.md` | ① 所有响应加 `X-WorkBuddy-Overhead-Ms`（桥自身处理耗时）；② `/health` 扩展进程计数（本进程请求数 / 错误分类）；③ ARCHITECTURE 的性能主张旁附可复现命令（`curl -w` 或 `tools/dev/` 下最小压测脚本） | curl 可见新头；性能主张有可执行复现命令 | 中 |
| 2.3 | **卡死请求可见**（§7 P1-8；**红线：不加默认超时**） | 桥 in-flight 注册表 + `/v1/requests` + 控制台「最近请求」 | 桥维护进行中请求（id / 开始时间 / 模型），`/v1/requests` 增加 `active[]`；控制台显示进行中区块与已运行时长，超阈值（`WORKBUDDY_ACTIVE_ALERT_MS`，默认 300000）标黄提示。**成功 / 失败 / 客户端断开三种释放路径都要测** | ① stub 慢上游时控制台出现进行中时长与提示；② 三种释放路径测试；③ 无任何默认超时 | 中 |
| 2.4 | **计费口径核对指引**（§7 P1-7） | `README.md` + `docs/SECURITY.md` | 加一段：经桥调用与客户端内直接使用的计费口径需自行核对 + 核对方法（控制台「用量统计」积分合计 vs 客户端内用量）+ 异常处置 | 文档段存在；报告 §8.6 风险 2 建议闭环 | 小 |
| 2.5 | **count_tokens 端点**（§7 P1-4） | 桥 Anthropic 路径 | 新增 `POST /v1/messages/count_tokens`（Anthropic 规范同形）；计数沿用零依赖启发式并改进（区分 ASCII / 多字节），文档如实标注「估算」 | ① stub 测试断言结构符合规范；② Claude Code 会调用该端点显示上下文占用 | 小-中 |

**批次二门**：release:check 绿；限流 / 在途 / 新端点各有测试；README、SECURITY、ARCHITECTURE 更新合并；确认「默认行为零变化」。

---

## 3. 决策门：定位（做完批次一 / 二再拍）

**为什么放这**：批次一 / 二两种定位都要做；定位本身，用这轮实际结果判断比拍脑袋靠谱。

拍板前回答三个问题（答案来自批次一 / 二的产出）：

1. **上游稳定性**：1.4 / 1.5 核查结果如何？若已出现需要持续打补丁的迹象 → 降低对外承诺，倾向「自用」；若稳定 → 「分发」窗口更宽。
2. **竞争位置**：直接同类 ≥20 个（报告 §3.1）；「分发」时你靠什么被选择？可防守的只有：凭据不落盘、零依赖、诚实度、单文件、控制台深度。
3. **物料一致性**：`.promo/`（8 平台文案）与 README 措辞必须与选择一致；「自用」→ 收敛清单，「分发」→ 承诺清单。

**产出**：① README 顶部一句定位声明（二选一，不含糊）；② CHANGELOG 记录决策日期与理由；③ 进入批次三对应分支。

---

## 4. 批次三（按定位分支）

### A 线：「个人自用」——收敛清单

| # | 动作 | 验收 |
|---|---|---|
| A1 | 控制台功能冻结：只修 bug，不加新页签 / 新能力 | 后续版本 CHANGELOG 只含「修复」类条目 |
| A2 | 清理发布物料：`.promo/` 删除或归档；核查 `.optimize / .trae / .backup` 是否被 git 跟踪（`git ls-files`），被跟踪的移出仓库并加进 `.gitignore` | `git ls-files` 不再命中这些目录；仓库根目录只剩产品文件 |
| A3 | 发布线收窄：只发缺陷修复版；每月一次「上游漂移观察」（见 §6） | 连续两个版本只有修复类条目 |

### B 线：「可分发产品」——承诺清单（顺序即依赖）

| # | 动作 | 参考 | 验收 |
|---|---|---|---|
| B1 | **README「把安装交给 Agent」引导提示词**（§8.7 #42） | dsh-workbuddy-connect | 一段可粘贴的安装 prompt（版本判定 → 安装 → 验证） |
| B2 | **客户端凭据分层**（§7 P1-5） | claude-code-router | 回环 token 之外支持每客户端独立 key（哈希存储）；限流 / 吊销可按 key |
| B3 | **npm 发布形态**（§7 P2-10） | dsh-workbuddy-connect / xdpool | dsh 插件可一行安装；`lib/` 随包；与 vendor 一致性有测试 |
| B4 | **Docker + CI 矩阵**（§7 P2-2 / 2-3） | copilot-api（非 root / healthcheck / 固定基础镜像） | 容器可起且 healthcheck 通过；CI 增 macOS / Linux 矩阵且绿 |
| B5 | **静态检查**（§7 P2-4） | copilot-api | `tsc --checkJs` + eslint 全绿（devDependency，不破坏零运行时依赖） |
| B6 | **EN 界面与文档**（§7 P3-2） | new-api / CLIProxyAPI | README.en + 控制台 i18n 骨架（至少 EN） |
| B7 | **OpenAPI**（§7 P2-5） | LiteLLM | 21 个端点有机器可读描述 |
| B8 | **CONTRIBUTING + 纪律文档**（§7 P2-7） | new-api `AGENTS.md` | 含真产物校验纪律（§1.3）与「先红后绿」约定 |
| B9 | **README 定位重写 + 免责与生态披露**（§7 P3-4） | copilot-api 免责前置 | 与 CCR 的方向关系 + 与 WorkBuddy2API 集群的差异（单账号 / 不落盘 / 零依赖 / 自用） |

---

## 5. 批次四（可选，战略）：多账号池（§7 P3-1）—— **已决策：不做（2026-10-08）**

> **决策记录**：定位拍板「可分发产品」后，多账号池与 README 写死的红线
> （**单账号、不转售 / 托管**）直接冲突；且分发背景下池化会加速上游收紧、
> 殃及所有用户（报告 §8.6 风险 5）。差异化立场保持
> **单账号 · 凭据不落盘 · 零运行时依赖 · 单文件自包含**。本节保留作为决策
> 依据存档，**不再执行**；同类需求请用社区里更对口的工具。

**前置**：决策门已过 + 你明确确认要做（架构级改动，涉及桥核心文件；按纪律不擅自动手）。
参照：报告 §4.6（熔断 / 粘性 / 防惊群）、§4.8（温和 failover）、§8.7 #38-40。

分三步，每步独立可用、单账号行为零变化：

1. **在途租约 + 单号冷却骨架**（单账号即可测）——先有「限流 / 冷却 / 失败分类」的地基（与 2.1 / 2.3 合并设计，不重复造）。
2. **多凭证来源发现 + 手动多账号**——来源设计二选一或都支持：桌面端多登录态快照（§3.1 D2 做法）/ OAuth 设备码直登（§7 P2-8，不依赖桌面端）。
3. **加权选号 + 会话粘性 + 冷却换号**——**粘性必须同做**，否则上游缓存命中率崩（§3.1 D2 的实际代价）。

每步验收：旧单账号行为零变化；新增测试覆盖切换 / 冷却 / 粘性。

---

## 6. 长期卫生（持续项）

1. **上游漂移观察**：新错误码、新请求头（如 `X-Device-Token`）、黑名单变化 → 记入 CHANGELOG「上游观察」节；异常症状进排错表。**监控，不猜测、不预先改。**
2. **生态观察（低频）**：每月一次 `gh search repos workbuddy` 快照（数量与头部项目），只记录不应对。
3. **发版三步走**：`npm run release:check` → CHANGELOG → tag；只支持最近 2 个 minor。

---

## 附：验收命令速查

```powershell
npm run release:check                 # 批次门禁（vendor:check + 74 用例 + 独立分发演练）
npm run test:plugin                   # 插件测试（74 用例基线）
node --test bridge/bridge.test.mjs    # 桥测试（12 用例基线）
Select-String README.md -Pattern '^\d\. \*\*'   # 注意事项去重检查（1.2）
# 其余各项的验收命令见对应表格行
```