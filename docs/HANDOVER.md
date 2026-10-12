# 交接文档 —— WorkBuddy Local API Bridge Console

> 写于 2026-10-12。目标是让**没参与过**的人能在半天内接手并继续推进。  
> 这里只放「文档里没有、但接手必须知道」的东西；流程性内容一律给指针，避免两份各自漂移。

---

## 0. 三十秒版本

一个**本地中转桥**：把 WorkBuddy 桌面端已登录的账号暴露成 OpenAI / Anthropic 兼容的  
本地接口（`http://127.0.0.1:8790/v1`），让 opencode / Claude Code / Codex 等任意客户端能用。  
仓库里附带一个**控制台网页**（`dashboard/`）做可视化管理与排障，以及一个插件桥接层（`dsh-plugin/`）。

- 入口：`启动.cmd`（用户日常靠它）
- 控制台端口：**8792**（`config.dashboard.port`，不是 8800）
- 全仓库**零第三方依赖**：无 `npm install`；桥 `bridge/workbuddy-bridge.mjs` 单文件自包含

---

## 1. 当前状态（接手时先看这里）

```bash
git log --oneline -8
git status            # ⚠️ 2026-10-12 有一批**未提交**改动（见下），commit 等用户放行
npm run release:check # 六步发布门禁（改完必跑）
npm run test:ui       # UI 用例（无头 Chromium，真实渲染断言）
npm run test:bridge   # 桥用例
npm run test:plugin   # 插件用例
```

**2026-10-12 一天三波改动（全部**未提交**，等用户放行 commit）**：

| 波次       | 内容                                                                                                                                 | 关键文件                                                                                                                                               |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| ① 交接遗留   | 趋势图「按周」粒度；修好 `probe-clickable.mjs` 挂死（infinite 动画让 `finished` 永不 settle）；**视觉对齐**（四处写死颜色收敛到令牌）+ `DESIGN_SYSTEM.md` v2.0 + 推广图/截图重出 | `dashboard/public/*`、`docs/DESIGN_SYSTEM.md`、`tools/dev/test-trend-week.mjs`、`test-accent-icons.mjs`、`shot-promo.mjs`                              |
| ② 核心缺陷   | **DSH 里国际版模型"选不了思考强度 / 视觉被当纯文本"**——根因是桥的 FEATURED 补全项不带能力字段；补全路径三处全带上能力标记 + `regions` 区域过滤（`deepseek-v4-pro` 国际版实测 400）            | `bridge/workbuddy-bridge.mjs`、`dsh-plugin/lib/models.mjs`、`adapter.mjs`                                                                            |
| ③ 思考强度档位 | 档位从"每模型写死三档"改成**逐模型实测**：桥按实测表给 `reasoning_efforts`，插件照单声明；并修正探针 `max_tokens` 过小导致的"9 个模型不可调"误判                                     | `bridge/workbuddy-bridge.mjs`、`dsh-plugin/lib/{models,adapter}.mjs`、`tools/dev/probe-efforts-all.mjs`、`probe-capability.mjs`、`probe-dsh-chain.mjs` |

**③ 的国内版部分（CN 档位矩阵）已于 10-12 下午完成**：29 个推理模型全实测、
23 个新条目并进 `REASONING_EFFORTS_BY_MODEL`、已 re-vendor + 六步门禁全绿 +
端到端复核（CN 一次性桥看档位、重启用户桥看国际版零影响）。细节与遗留见 §2 第 0 条。

**测试基线**（本机跑过，全绿）：`test:ui` **35 / 35**、`test:bridge` **54 / 54**、  
`test:plugin` **83 / 83**、`release:check` 六步全绿；vendor 已同步（插件分发跑的是  
`dsh-plugin/vendor/` 里的桥副本，**改桥必须重新 vendor**）。

**正在跑的桥**：用户的桥由控制台管理（`POST /api/bridge/restart` 可重启，带头  
`x-workbuddy-panel: 1`），改完桥代码**重启才生效**；国际版账号（`.state.json` 选定）。

**用户的三个问题与答案**（都会再问，记在这）：

1. "模型列表会自动更新吗？" —— **会**：桥每 5 分钟（`CATALOG_TTL_MS`）或  
   `/v1/models?refresh=1` 时重取上游目录，新模型自动出现，能力字段（视觉/推理）  
   跟着上游走；新模型的思考强度档位默认三档（未实测），用探针补。
2. "国内版也要一致" —— 桥的能力链路两端通用；**档位表按模型 id 键控**，两端共用；  
   国内版档位矩阵已于 10-12 下午跑完并并表（§2 第 0 条，29 个推理模型全实测）；  
   `deepseek-v4.1-flash` 的 CN 复测**已完成**（2026-10-12 16:05，换新账号后跑通）：
   结论与国际版**一致**（只拒 `off`，其余六档全 200），详见 §2 第 0 条。
3. "国际版 9 个模型是不是不可调？" —— **误判**（探针 `max_tokens=8` 太小，推理模型  
   拒绝过小的输出预算）。改用 1024 后全部可调，档位差异见 §2。

---

## 2. 未完成 / 待确认

按优先级排（**接着要做的是 1**；0 已于 2026-10-12 下午完成，见下）：

0. ~~**国内版（CN）的档位矩阵补齐 → 把 CN 独有模型的档位补进实测表**~~
   **已完成（2026-10-12 下午：矩阵跑完 → 并表 → vendor 同步 → 门禁全绿 → 端到端复核）**。
   CN 目录 31 个模型 / **29 个推理模型全部实测**（`probe-efforts-all.mjs`，
   矩阵落盘 `E:/tmp/effort-matrix-cn.json`，可续跑）。结论：

   - **22 个全档**（minimal…max + xhigh）；`deepseek-v4-pro` / `deepseek-v4-flash`
     只拒 `off`（照例不声明）；`deepseek-v4-pro` **国内版可用**（国际版目录里没有它，
     只在国内版补全，并表对国际版无影响）；
   - **7 个目录在列但网关不接**（对照即 400 `service info not found`）→ 显式空数组：
     `glm-4.6` / `glm-4.6v` / `glm-4.7` / `glm-5.0` / `hy4-preview-x` /
     `kimi-k2-thinking` / `minimax-m2.5`；
   - 两端共有的 5 个模型（`hy3` / `hy4-preview` / `glm-5.2` / `glm-5.3` /
     `kimi-k2.6`）复测**结论一致** → 表**不需要区域维度**（id 键控、两端共用的
     设计假设被证实）；
   - `space-bunny/minimal`、`hunyuan-2.0-thinking/xhigh` 探针各有一格**偶发 400**，
     复测 6/6 全 200 → 按全档入表。**孤立单格 400 要先复测再缩表**（确定性 400
     才是真不收，见桥代码里的教训注释与 §6.12）。

   **遗留已清（2026-10-12 16:05）**：`deepseek-v4.1-flash` 的 CN 复测原本被
   **模型级 429** 挡下（"频率限制 21:22:20 UTC+8 重置"）。**换用新加的国内版账号后
   复测成功**（那 429 是**旧账号**的限制，与档位无关）。实测：对照组 200、
   `off` 400、`none` 200、`minimal/low/medium/high/xhigh/max` 六档全 200
   （reasoning_tokens 99/147/164/49/40/123/60）→ **与国际版结论一致（只拒 `off`）**，
   原表条目无需改动，仅更新了桥里那两处"待复测"注释。
   端到端复核：新账号 `/v1/models` 给 dsh 的 `deepseek-v4.1-flash` 带齐
   `supports_reasoning`/`supports_images` 与六档 `reasoning_efforts`（无 `off`）。
   新账号国内版目录 **31 个模型**（与旧账号 32 个的差异见 §2 第 2 条旁注）。

   **怎么做**（下次复跑照这个来；桥和探针必须在**同一个后台任务**里起，否则沙箱
   会把桥回收：起桥 → 等端口 → 跑探针 → 杀桥。探针第三个参数起可只跑指定模型）：

   ```bash
   WORKBUDDY_AUTH_FILE="C:/Users/Ian/AppData/Local/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info" \
   WORKBUDDY_PORT=8799 WORKBUDDY_LOCAL_TOKEN="$(cat dsh-plugin/.bridge-token)" \
   WORKBUDDY_AUTO_CHECKIN=0 WORKBUDDY_LOG=0 node bridge/workbuddy-bridge.mjs &
   # 等端口起来后：
   PROBE_BASE=http://127.0.0.1:8799 PROBE_OUT=E:/tmp/effort-matrix-cn.json \
     node tools/dev/probe-efforts-all.mjs "$(cat dsh-plugin/.bridge-token)" [模型 id...]
   ```

   ⚠️ 429 是账号侧的**使用量频率限制**（错误里带重置时间）；探针对 429 自动退避、
   连续 3 次停下，对 **400 不重试** —— 但 400 里有偶发 flakes（见上）。
   ⚠️ 两个区域的同名模型若档位不同，表就要加区域维度 —— **已复核：两端一致，无需加**。
   ⚠️ **换个账号就能绕过模型级 429**（2026-10-12 实测）：换账号需改
   `WORKBUDDY_AUTH_FILE`，且**桥要重启**才重新读凭据。起一次性桥时
   `clientExe` 会自动探到对应版本（国内版 → `WorkBuddyAI.exe`）。

   **旁注（新账号扫码进来后顺带发现，**未深挖**）**：新加的国内版账号
   `/v1/models?all=1` 返回 **31 个**模型，旧账号（同一 uid）是 32 个。
   逐 id 比对差异**尚未做** —— 如果只是上游目录漂移（`CATALOG_TTL_MS` 内会自刷），
   无需处理；若新账号确实少了某个模型，那属于**账号档位/权限**差异，与代码无关。
   下游如果发现"某模型在新账号里不见了"，先查这里。

1. **把未提交的改动落成 commit（等用户放行，别自己动）**
   `git status` 约 35 个文件，分三个波次（见 §1 的表）。建议按波次分三个 commit；
   commit 前重跑 `npm run release:check` + `npm run test:ui`（改了界面）；
   发版/tag 走 `CONTRIBUTING.md` 的发版四步。

2. **claude-haiku-4.5 / claude-opus-4.8 在国际版网关不接**（实测对照请求 400
   `service info not found`，与 `deepseek-v4-pro` 同类）。档位表里已显式空数组
   （dsh 不显示思考强度）。**深挖方向**：确认网关是否对 claude 走 anthropic 协议、
   或只对某些账号/区域开放；若网关真提供，复跑探针把档位填回来。

3. **「下拉点不开」的其余部分（待用户确认）**
   9 个自绘下拉里唯一真打不开的（`probeScope`，包在 `<label>` 里）已修；
   `probe-clickable.mjs` 全量复核过：六个视图 **0 个元素点不到**，
   `test-dropdowns.mjs` 9/9。若用户还有症状，需要截图或复现步骤。

4. ~~趋势图只有「按天 / 最近 24 小时」~~ —— **已完成**（按周粒度 + 按模型堆叠，
   守它的是 `test-trend-week.mjs`）。「按月」不做：取数上限 90 天，只出 3 根柱。
5. ~~国际版 9 个模型不可调~~ —— **误判**（探针 `max_tokens=8` 太小；推理模型拒绝
   过小的输出预算）。已改 1024 并重测；档位差异见 `REASONING_EFFORTS_BY_MODEL` 注释。

### 模型列表会自动更新（用户问过，答案记在这）

桥每 5 分钟（`CATALOG_TTL_MS`）或 `/v1/models?refresh=1` 重取上游目录；
**新模型自动出现**，能力字段（视觉 / 推理）跟着上游走；上游漏列的知名模型由
`FEATURED` 兜底（带实测能力标记，见该常量的注释）。新模型的思考强度档位默认三档
（未实测），用 `probe-efforts-all.mjs` 测完填表即可。

### 已经复核过、**不用再查**的两条

（这两条先前被写进待办，复核后发现是错的，留在这是为了别有人再查一遍）：

- ~~1024px 视口横溢 82px~~ —— **不存在**。用 `tools/dev/probe-width-scan.mjs`  
  扫了 380–1440 共 **14 个宽度**，横向溢出**全部为 0**。  
  改布局后重跑这个探针（约 4 分钟）比只跑 `test-viewports`（4 个宽度）更保险。
- ~~无障碍审计还剩 1 项~~ —— **没有这回事**。`tools/dev/audit-a11y.mjs`  
  这个文件根本不存在；无障碍靠 `test-accessible-name.mjs`，它**没有任何豁免清单**，  
  任何无名元素都会失败，当前全过。

> **教训（写在交接文档里的反例）**：交接文档**不要写没复核过的结论**。  
> 上面这两条都来自更早的印象而非实测，差点把人引到不存在的 bug 上。  
> 写进待办前先跑一遍确认。

---
## 3. 项目约定（改代码前必读）

**流程性内容**在 `CONTRIBUTING.md`（测试纪律、`panel:check`、vendor 同步、发版四步、本机网络命令），  
**界面行为与视觉规范**在 `dashboard/README.md`，**设计决策与原因**在 `docs/ARCHITECTURE.md`，  
**症状 → 原因**在 `docs/TROUBLESHOOTING.md`，**配色与降级策略**在 `docs/DESIGN_SYSTEM.md`。

这里只列**硬约束**（违反了会静默坏掉，不是"风格问题"）：

- **桥 `bridge/workbuddy-bridge.mjs` 单文件自包含**：不 import 项目内任何模块，  
  配置靠 `config.bridgeEnv()` 注入环境变量。别让它反向依赖 `lib/`。
- **只绑 `127.0.0.1`**，绝不改 `0.0.0.0`。
- **登录文件只读**：桥刷出的令牌只留内存，**绝不回写**（会破坏客户端的 AtRest 信封存储）。
- 同步子进程一律 `spawnSync` + `stdio:['ignore','pipe','pipe']`；  
  `execSync`/`execFileSync` 在这台机器上必抛 `EBUSY`。
- `.cmd` 脚本**保持纯 ASCII**（`chcp` 生效前已按 ANSI 码页解析，中文会截断命令本身）。
- 凭据相关代码/日志**不得出现令牌明文**，只允许长度、账号、有效期、keyId。
- 账本/日志**只记元数据**（时间、模型、流式、耗时、token、扣分、状态码、错误码）；  
  不回请求体、不回消息内容；错误原文压成单行并截断（上游 401 会返回整段 HTML）。
- `.state.json` 写入是**合并语义**：删键要传 `null`。它**程序可写**，  
  任何来自 HTTP 的内容必须先清洗再落盘。
- 新增「失败」记录要覆盖三条路径：上游非 2xx、正常结束、处理块抛异常。  
  漏掉抛异常那条，登录文件损坏这类故障是**隐形**的。

---

## 4. 文件地图

```
bridge/workbuddy-bridge.mjs        桥（单文件自包含，含 /v1/* 与 /api/* 两套端点）
dashboard/public/index.html        控制台**全部** JS/HTML（单文件，约 7000 行）
dashboard/public/style.css         全部样式
dashboard/server.mjs               控制台服务端
lib/                               服务端逻辑（面板接口、连接、体检等）
dsh-plugin/                        DeepSeek Harness 插件桥接层
  vendor/dashboard/public/*        ← 由 scripts/vendor.mjs 从 dashboard/ 复制，**手改无效**
tools/dev/ui-harness.mjs           无头 Chromium 测试骨架（静态服务 + CDP + /api/* 打桩）
tools/dev/fixtures.mjs             共享桩数据（形状由 tools/dev/api-shape.json 校验）
tools/dev/test-*.mjs              UI 用例（run-ui-tests.mjs 自动发现）
tools/dev/api-shape.mjs           capture（从跑着的控制台取形状）/ check（比对漂移）
```

---

## 5. 测试怎么用

```bash
npm run test:ui          # 全部 UI 用例（约 10 分钟，35 个）
node tools/dev/test-dropdowns.mjs     # 单个用例，秒开
node tools/dev/shot-console.mjs       # 重出 docs/screenshot{,-en}.png
node tools/dev/probe-width-scan.mjs   # 扫 14 个宽度的横向溢出（约 4 分钟，改布局后跑）
node tools/dev/probe-clickable.mjs    # 六视图全量"每个元素点得到吗"（改交互后跑）
```

`tools/dev/` 下的 `probe-*.mjs` 是**一次性排查脚本**（不改代码、只输出结论），  
`test-*.mjs` 才是常驻用例（`run-ui-tests.mjs` 自动发现前者之外的 `test-*`）。  
排查脚本**不在** `npm run test:ui` 里，需要时手动跑。

**骨架要点**（`ui-harness.mjs`）：

- `openPage(url, routes, { inject })` 返回 `{ cdp, close, lastDialog, setDialogHandler, setDialogAuto }`。
- `routes[path].body` 可以是对象 / 字符串 / **函数**（收完整 URL，用于按查询串分流）。
- `openPage(url, {}, { injectStub: false })` = **真实端到端**，直接打真 `/api/*`。
- 桩数据**必须**与 `tools/dev/api-shape.json` 一致 —— 校验器同时抓**缺键**和**多键**。  
  新增字段时：**形状表和夹具要同时改**。

### 三个必踩的坑

1. **不能用 `JSON.stringify(routes)` 注入** —— 会丢掉函数值。
2. **路由函数体在页面里执行，闭包变量不存在** —— 共享数据要注入 `window.__FIX`。
3. **模板字符串里的注释不能带反引号**（会提前闭合）。这条我这两天踩了 **3 次**。

---
## 6. 踩坑清单（本轮新踩的，最有复用价值）

### 6.1 「唯一」不能用哈希，要用分配

给模型分配颜色时，第一版用**名字哈希取模**，实测 **3 个模型里 2 个撞色**。  
调色板 8 个槽位、排行最多 9 行 → **哈希必然碰撞**，而碰撞在页面上**看不出来是 bug**  
（两根柱颜色一样，用户只会觉得"这俩模型真像"）。

改成**按首次出现顺序分配 + 持久映射**。后来又发现两处排序依据不同（排行按扣分、  
图表按当前指标）会导致同一模型两个颜色，于是改成加载时按 `usage.models`  
（与图表无关的稳定顺序）**预分配**（`seedModelColors`）。

### 6.2 运行时新建的 DOM，i18n 的 DOM 扫描够不着

自绘确认框的按钮文案若写死中文字面量，英文模式会留中文 —— **必须过 `t()`**。  
（和原生 `confirm` 同一个坑：它也不在 DOM 里。）

### 6.3 `addScriptToEvaluateOnNewDocument` 在**文档解析之前**跑

那时 `document.documentElement` 还是 `null`，`observe(null)` 直接抛错。  
而如果"置标记"写在前面，就会**看着像装好了、实际没观察**。  
→ 观察 `document`（它在注入脚本里一定存在）。

### 6.4 `scrollIntoView` 会跟着 `scroll-behavior: smooth` 动画走

滚到一半取 `getBoundingClientRect()` 得到的是**过时坐标**，点击落空。  
表现为「单跑通过、整套里首次点击失败」。→ 一律 `behavior: 'instant'`。

### 6.5 量完坐标别 sleep 再点击

首批数据（overview / models / usage / clients）陆续到达会让页面继续位移。  
量完坐标睡 150ms 再点，那一下点到别处 —— 日志里只有 `closeAll`、`ddOpen` 从没被调用，  
**看起来像产品坏了**。→ 先等布局稳定（高度 + 触发器纵坐标连续 3 次一致），  
且测量与点击之间不留间隔。

### 6.6 点 `<label>` 内部，浏览器会额外转发一次 click 给它的控件

那次是**独立事件**，`stopPropagation` 拦不住。这是「`probeScope` 点不开」的根因。  
详见 CHANGELOG。

### 6.7 断言要有牙齿

新写的断言**必须撤掉修复跑一次、确认它变红**。而且要能**分辨对错** ——  
只把"正确情形"跑一遍等于没验。

### 6.8 报红时先怀疑断言，再怀疑被测对象

（实测：断言把两个卡片网格拍平成一个序列导致假失败。）  
另外**判"卡住"前先确认输出没被缓冲**：`npm run panel:check 2>&1 | tail -20`  
会把输出全缓冲，看着像卡住。

### 6.9 `getAnimations().finished` 对 `infinite` 动画**永不 settle**（2026-10-12）

等"所有动画结束"再量坐标时，若页面上有任何 `animation-iteration-count: infinite`  
（本项目有三处：状态点呼吸光晕 / 骨架屏 shimmer / 请求活动指示器），  
`animation.finished` 这个 Promise **永远不会 resolve** ——  
页侧的等待挂在 CDP `evaluate` 里，整个脚本**零输出静默挂死**，端口还被占着  
（上一轮就是这么留下两个孤儿进程的）。  
判据：挂了 10 分钟一个字都没有。  
修法：只等**有限次数**的动画（`effect.getTiming().iterations !== Infinity`），  
外加 `Promise.race` 的秒级硬上限兜底。

### 6.10 `Page.captureScreenshot` 的 `clip` 用的是**页面坐标**（2026-10-12）

不是视口坐标。页面滚到下方后拿 `getBoundingClientRect()` 的 `y` 直接当 `clip.y`，  
截到的是文档里那个位置 —— **一张纯空白图**，不报错。  
必须 `r.y + window.scrollY`。元素恰好在首屏时两者相等，所以只看首屏会误以为没事。

### 6.11 颜色写死在组件里 = 切配色方案时不跟随（2026-10-12）

同一个坑在一轮里出现了**四处**（下拉/select 箭头、表格行底色、日志终端块、  
危险按钮光晕）：值写死在组件规则或 SVG data-URI 里，切到陶土/苔绿/雾紫/青绿时  
全站都变了、只有它还停在旧色。**新增/改样式一律走令牌**；  
带颜色图形的图标用 `mask-image` + `background-color`（mask 取 alpha，颜色走令牌）。  
守这条的是 `tools/dev/test-accent-icons.mjs`（静态 + 10 组合实测渲染色）。

### 6.12 孤立单格 400 要复测再缩表；探针输出格会骗人（2026-10-12 CN）

CN 档位矩阵里 `space-bunny/minimal` 与 `hunyuan-2.0-thinking/xhigh` 各出现过
**一次** 400，直接信就会把这两个模型误判成"不收某档"。复测 **6/6 全 200** →  
判定为网关在 16 分钟持续高压下的**偶发拒绝**。区分依据：真不支持的档位是
**确定性** 400（7 个死模型 9/9 格全 400、gpt-5.6 不收 minimal、gemini 不收 xhigh），
偶发拒绝是孤立单格。探针**只对 429 退避、对 400 不重试** —— 看到孤立 400，手动复测再决定。

顺带：读探针输出别数错列。它的 200 格打印的是 **reasoning_tokens 数值**、
非 200 才打印状态码 —— `ctl=0` 是"200 但不上报 reasoning_tokens"（glm-5.1 手动
一打就 200），不是网络错误；我曾把它误读成"全网吧 ERR"去查了一圈。
**判断前先看落盘 JSON 的 status 字段，别看那行对齐的数字。**

### 6.13 同一文件的多轮编辑会互相覆盖；外部写入会静默冲掉你的改动（2026-10-12）

本轮真实事故：对 `docs/HANDOVER.md` 先做了一次段落级替换（成功），随后**文件被
外部写回**成一个更旧的混合版本（还带 `&#x4EA7;` 这种 HTML 实体转义损坏、§7 代码
栅栏翻倍），我紧接着的第二次段落替换在旧版本上应用成功 —— 结果第一次的改动
**无声消失**，文档变成两个版本的混合体。**同一种坑昨天也踩过**（段级 python
重写互相覆盖）。

纪律：

- 同一文件的多轮编辑，**每轮结束立刻重读全文核对**（`git diff` + 关键段落抽样）；
- 长文档要改多处时，**整段重写（Write 全文）比多次段级补丁安全**；
- 动手前先 `ls -la` 看 mtime、改完再看一次 —— **发现文件在你眼皮底下被外部改动，
  先备份现场（`cp` 到 /e/tmp）再重写**，并在最后告诉用户"有东西在动这个文件"；
- 段级补丁报"字符串不匹配"时，**别怀疑自己记错了就放弃** —— 先重读，很可能文件
  已经变了。

---

## 7. 常见操作

```bash
# 控制台只在验证时用后台任务起（Bash 的 run_in_background），跑完就结束 ——
# 会被环境回收（实测约 2 小时后整棵进程树连同 detached 的桥一起消失）。
# 用户日常走 启动.cmd，不要替用户常驻。

node dsh-plugin/scripts/vendor.mjs && npm run vendor:check   # 同步 vendor 并校验
node tools/dev/api-shape.mjs capture                          # 重捕接口形状（需控制台跑着新代码）
git checkout -- tools/dev/api-shape.json                      # 形状文件被写空时还原
node tools/dev/shot-hero.mjs && node tools/dev/shot-console.mjs  # 重出 README 截图（改了界面就要重出）
node tools/dev/shot-promo.mjs                                 # 重渲染社交预览图（docs/promo/）

# 上游能力实测（会真的打上游，成本几 token；**先确认桥在跑**）
node tools/dev/probe-capability.mjs "$(cat dsh-plugin/.bridge-token)"   # 视觉：塞 1×1 红点图看答不答得出
node tools/dev/probe-effort.mjs "$(cat dsh-plugin/.bridge-token)"       # 推理：reasoning_effort 五档逐个试
node tools/dev/probe-efforts-all.mjs "$(cat dsh-plugin/.bridge-token)"  # 全量：每模型×每档矩阵（可续跑、429 退避）
node tools/dev/probe-dsh-chain.mjs [登录文件路径]                        # 起一次性桥 + 插件适配器，看 dsh 拿到什么元数据
```

**改动生效范围不一样**：`dashboard/public/index.html` 每次请求从磁盘读 → 改完刷新即生效；  
`lib/`、`dashboard/server.mjs` 进程启动时加载 → **必须重启**。  
所以"前端修好了但面板标签还不对"是正常的，别误判成没修上。

**Git**：`git commit -F` 的路径必须写 **Windows 格式**（`E:/tmp/msg.txt`）；  
`git push` 用 `-c credential.interactive=false`（凭据失效直接失败，不弹 GUI 挂住）。

**跑 UI 用例后 `git status` 看一眼**：`panel:shot` 会重写 `docs/plugin-panel*.png`  
（只差时间戳）；`docs/clients-panel-*.png` 只有 `tools/dev/shot-clients.mjs` 会写。  
不清的二进制噪声**别混进提交**。

---

## 8. 交接检查清单

给下一个人：

- [ ] `git status`：**接手时不是干净状态** —— 约 35 个文件未提交（§1 的三个波次，  
      含 10-12 下午的 CN 矩阵合并），先把 §2 第 1 条的 commit 做掉，再开始自己的改动
- [ ] `npm run release:check` 六步全绿（vendor / types / lint / lib / 桥 / 插件 / 独立分发演练）
- [ ] `npm run test:ui` 全通过（当前 35 个）、`test:bridge` 54 个、`test:plugin` 83 个
- [ ] 读完 `CONTRIBUTING.md` 与 `dashboard/README.md`
- [ ] 知道「桥单文件自包含 + 只绑 127.0.0.1 + 令牌不回写」三条硬约束
- [ ] 知道桩数据要与 `api-shape.json` 一致（缺键和多键都会报错）
- [ ] 知道第 6 节的 13 个坑（尤其是"唯一不能用哈希""scrollIntoView 要 instant"  
      "模板字符串注释别带反引号""infinite 动画会让等待永不 settle"  
      "**探针的 max_tokens 不能给太小，对照组要真的能对照**"  
      "**孤立单格 400 要复测；探针输出的 200 格打印的是 reasoning_tokens 不是状态码**"  
      "**同一文件多轮编辑要每轮重读核对，外部写入会静默冲掉改动**"）
- [ ] 知道**颜色一律走令牌**（写死的颜色不跟随五套配色方案；`test-accent-icons.mjs` 在守）
- [ ] 知道模型能力/档位是**实测表**（`FEATURED` / `REASONING_EFFORTS_BY_MODEL`），  
      改动前先看注释里的探针与日期；上游变了就复跑探针更新表
- [ ] 知道 429 是**按模型计**的频率限制（带重置时间，可换模型继续）；  
      CN 矩阵可续跑、已测格子跳过
- [ ] 有疑问先看 `docs/TROUBLESHOOTING.md`（症状 → 原因）
