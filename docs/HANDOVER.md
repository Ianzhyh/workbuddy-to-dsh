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
git status            # 应为干净
npm run release:check # 六步发布门禁
npm run test:ui       # UI 用例（无头 Chromium，真实渲染断言）
npm run test:bridge   # 桥用例
```

**最近一轮的五个提交**（都在 `main` 上，远程已同步）：

| 提交 | 类型 | 内容 |
|---|---|---|
| `ba0e875` | fix | 焦点环被自己的 `box-shadow` 吃掉 + 5 处 `outline: none` 无替代；新增 `test-focus-ring` |
| `2f5ec17` | fix | 模型表每行复选框**没有可访问名称**（行内嵌 5 个可点元素）；新增 `test-accessible-name` |
| `8503fa6` | fix | 诊断状态**只有颜色一条通道**；新增 `test-status-not-color-only` |
| `d30c3ea` | feat | 趋势图**形态可选** + 积分排行**按模型配色** + **自绘确认框**替代原生 confirm；新增两个用例 |
| `18a473a` | feat | 趋势图「**按模型堆叠**」（动了桥，新增 `days[].byModel` 交叉维度） |
| `656cf6e` | fix | **包在 `<label>` 里的下拉点不开**（`#probeScope`）；新增 `test-dropdowns` + 本文档 |

接手时的状态：`git status` 干净，`test:ui` **33 / 33**，`release:check` 六步全绿。

---

## 2. 未完成 / 待确认

按优先级排：

1. **「下拉点不开」的其余部分（待用户确认）**
   已修好的是 **9 个自绘下拉里唯一一个真打不开的**（`probeScope`，因为在 `<label>` 里，
   点 label 会被额外转发一次 click，把刚开的菜单关掉）。
   用户原话是「我发的那个范围**全部**那个下拉菜单」—— 若指的是别的，需要他再指认一次。
   `test-dropdowns.mjs` 已覆盖全部 9 个（含"在 label 里"那类），可直接重跑确认。

2. **趋势图只支持到"按天 / 最近 24 小时"**
   `days[].byModel` 与 `hours[].byModel` 都有了，但图表没有「按周」之类。按需要再说。

3. **趋势图粒度只有「按天 / 最近 24 小时」**
   `#trendGran` 现在只有 `day` 与 `hour` 两档，没有「按周 / 按月」。
   `days[].byModel` 与 `hours[].byModel` 的数据都有了，加粒度主要是前端的活。
   是否要做取决于有没有人真的看 30 天以上的窗口（`usageDays` 最大 30）。

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
npm run test:ui          # 全部 UI 用例（约 10 分钟，33 个）
node tools/dev/test-dropdowns.mjs     # 单个用例，秒开
node tools/dev/shot-console.mjs       # 重出 docs/screenshot{,-en}.png
node tools/dev/probe-width-scan.mjs   # 扫 14 个宽度的横向溢出（约 4 分钟，改布局后跑）
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

---

## 7. 常见操作

```bash
# 控制台只在验证时用后台任务起（Bash 的 run_in_background），跑完就结束 ——
# 会被环境回收（实测约 2 小时后整棵进程树连同 detached 的桥一起消失）。
# 用户日常走 启动.cmd，不要替用户常驻。

node dsh-plugin/scripts/vendor.mjs && npm run vendor:check   # 同步 vendor 并校验
node tools/dev/api-shape.mjs capture                          # 重捕接口形状（需控制台跑着新代码）
git checkout -- tools/dev/api-shape.json                      # 形状文件被写空时还原
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

- [ ] `git status` 干净，`npm run release:check` 六步全绿
- [ ] `npm run test:ui` 全通过（当前 33 个）
- [ ] 读完 `CONTRIBUTING.md` 与 `dashboard/README.md`
- [ ] 知道「桥单文件自包含 + 只绑 127.0.0.1 + 令牌不回写」三条硬约束
- [ ] 知道桩数据要与 `api-shape.json` 一致（缺键和多键都会报错）
- [ ] 知道第 6 节的 8 个坑（尤其是"唯一不能用哈希""scrollIntoView 要 instant""模板字符串注释别带反引号"）
- [ ] 有疑问先看 `docs/TROUBLESHOOTING.md`（症状 → 原因）
