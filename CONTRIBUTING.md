# 参与贡献

欢迎 PR 与 issue。这个仓库有一些**刻意养成的工程纪律**——提交前请花两分钟读完，
它们都是踩过坑之后固化下来的（出处见各条链接）。

## 快速上手

```cmd
git clone https://github.com/Ianzhyh/workbuddy-to-dsh && cd workbuddy-to-dsh
启动.cmd                 :: 双击：自动定位 Node、起服务、开控制台
node tools\doctor.mjs    :: 命令行自检
npm run release:check    :: 完整门禁（vendor:check + 单测 + 插件测试 + 独立分发演练）
```

零运行时依赖：**不要**给 `dependencies` 加东西（devDependency 可以）；桥与控制台
保持**单文件自包含**（桥 = `bridge/workbuddy-bridge.mjs` 一个文件）。

**lint 范围**：`npm run lint`（`eslint .`）覆盖仓库自有源码，**包括 `tools/dev/`**。
那里原先被当作「一次性探针脚本」排除在外，但后来它成了常驻门禁的所在地
（`run-ui-tests.mjs` / `test-i18n.mjs` / `verify-release.mjs` / `check-i18n-coverage.mjs`），
排除它等于让门禁自己不被检查。实际开启时全目录只有 1 个问题，成本远低于预期。
`.tmp-*` / `.backup/` / `.optimize/` / `dsh-plugin/vendor/` 仍排除在外。

## 测试纪律（先红后绿）

1. **涉及代码的改动，先加一条会失败的测试，再修实现**（插件 `npm run test:plugin`、
   桥 `node --test bridge/bridge.test.mjs`）。没有"红"的过程，测试证明不了任何事。
2. **凡「读外部资源做判断」的常量，必须有一条对真实产物的断言。**
   只用被测常量造夹具是自证式断言（tautology）——它能证明"代码读得到自己写的
   常量"，永远证明不了"常量与真实产物对得上"。参考 `plugin.test.mjs` 里对
   `dashboard/public/index.html` 的交叉校验用例。
3. **桩数据不许骗人**：给无头验收（`ui-harness.mjs`）喂的桩要过形状校验
   （`tools/dev/api-shape.json`，重取：`node tools/dev/api-shape.mjs capture`）；
   值不重要的接口直接用 `shapeStub('/api/...')` 生成。
   共享夹具在 `tools/dev/fixtures.mjs` —— **优先用 `baseRoutes()` 而不是自己手写整组桩**。
4. 桥侧测试**不触真上游**：用 `CODEBUDDY_ENDPOINT` 指向打桩上游
   （见 `bridge.test.mjs` 的 `startStubUpstream`）。

### 跑无头 UI 用例：`npm run test:ui`

```cmd
npm run test:ui              :: 跑全部（判据：import ./ui-harness.mjs 的 test-*.mjs）
npm run test:ui i18n r9      :: 只跑名字含 i18n / r9 的
```

需要**本机有 Chrome/Edge**（`CHROME_PATH` 可指定）；不启真控制台、不消耗上游额度。
失败时会把每个脚本的尾部输出打出来，不用一个个手工复现。

**为什么必须有这个入口**：这批脚本原先各跑各的、没有统一入口，于是"没人跑"
就没人知道它们坏了 —— 实测发现 11 个早期脚本因为形状表变严，在 `openPage` 的
桩校验处就抛错，**根本没跑到断言**，而且很久无人察觉。验收面悄悄烂掉一大块，
比某个用例失败危险得多。**改完前端先跑它。**

> 不 import `ui-harness.mjs` 的脚本（`test-bridge-*`、`test-console-ui`、
> `test-probe-lastrun` 等）需要真的起桥或控制台，属于人工/集成走查，不在
> `test:ui` 里跑（跑了会占端口、消耗上游额度）。

### 怀疑还有漏翻：`npm run check:i18n`

```cmd
npm run check:i18n                                  :: 控制台
npm run check:i18n dsh-plugin/lib/client.js          :: 插件面板
node tools/dev/check-i18n-coverage.mjs --check "某串" :: 直接问「这一串翻不翻」
```

`--check` 是排查时最常用的动作：名单里挑出可疑的一条，想知道它到底是真漏还是片段
（片段永远不会单独渲染，拼起来才有规则）。

「英文模式下扫可见中文 = 0」那套验收只能发现**已经渲染出来**的漏翻：没被桩数据走到、
或者藏在错误分支里的文案它扫不到（本会话就连着踩了三轮：签到胶囊、`· 多模态`、整页诊断）。
这个工具换个角度，**从源码侧**查：把源码里所有含中文的字符串字面量抽出来，
逐条过一遍词条表与规则，翻不动的进嫌疑名单。

它是**分诊工具，不是门禁** —— 名单里必然混着大量「永远不会单独渲染的拼接片段」
（`'保存到 dsh 设置（' + n + '）'` 的前半段），要人工判断哪条才是真的漏。
工具已经尽量压掉这类噪音（同一行的字面量拼起来再判、含 HTML 的按文本片段判、
模板串的 `${…}` 换成占位值、源码字面量反转义成运行时字符串），但压不干净。

**修完一处，顺手把它变成「渲染扫描能覆盖的分支」** —— 加桩、或让验收多点一下
（下拉 / 分段控件 / 详情抽屉都是这么补进去的）。那才是能防回归的那一层。

### i18n 表的两条硬约束（有测试守着）

`dsh-plugin/tests/i18n-terms.test.mjs` 钉两件事，改词条时会立刻告诉你：

1. **插件与控制台的 `I18N_TERMS_EN` 必须逐条一致**。本项目零构建，两个文件没法共享
   代码，表只能各带一份 —— 上游新增一个促销词/套餐类型时，**两边都要补**；
2. **表的译文里不能有中文**。半翻（`'X': 'English（中文）'`）渲染扫描扫不到
   （它只查「有没有中文」，不查「比例」），只能在这里拦。

### dsh 插件面板：`npm run panel:check`

```cmd
npm run panel:check    :: 截图脚本（4 个场景）+ i18n 验收（9 个标签页 0 残留中文）
npm run panel:i18n     :: 只跑 i18n
```

同样需要本机 Chrome。桩数据与渲染骨架在 `dsh-plugin/tests/_panel-fixtures.mjs`，
**两个脚本共用一份** —— 各写一份必然漂移，而桩一漂移，两边验的就不是同一个东西了。

面板的 i18n 与控制台同思路，但翻译遍落在**创建 React 元素那一层**（包住 `h`）：
整棵 UI 是元素树，翻 DOM 会被下一次 render 冲掉。数据（对话正文、日志行、上游原文、
语言代码）用 `h(Raw, { text })` 包一层绕过翻译 —— 那层会打上 `data-wb-raw`，
i18n 验收据此跳过整棵子树（否则「上游返回的中文」会被当成「漏翻的界面文案」）。

### 桩数据的两条反直觉规则

- **桩不能太"干净"**。空数组 / `null` 会让整块 UI 静默地不渲染，于是断言扫到
  「0 个问题」而"通过" —— 这比桩写错更危险，因为**写错会被形状校验拦下，太干净不会**。
  真实案例：体检结果桩为空 → 表头时间线不渲染 → i18n 漏翻检查假绿。
  所以 `fixtures.mjs` 的 `probeResultsFixture` **默认按 catalog 生成非空结果**。
- **故意塞真实接口没有的键**（如用假令牌验「凭据绝不渲染」）时，给那条路由加
  `allowExtra: true` —— 只关掉「多余键」检查，**缺失检查照旧**。

### 排查「验收全绿但产品有问题」

先查**运行时报错**。控制台是"一次 DOM 翻译遍 + MutationObserver 增量翻"的结构，
一个未定义函数就能让整条链路静默中断，表现是「成片中文」，而补词条永远补不好。
`test-i18n.mjs` 里那条「无运行时报错」断言就是为这类故障准备的。

## 行为纪律

- **默认行为向后兼容**：新能力一律默认关闭（限流、告警阈值等都是 0/queue 起步）；
  确需改变默认行为时单独说明，并写进 CHANGELOG 的「破坏性变更」。
- **不做清单（红线）**：不加默认上游超时；不伪造能力（embeddings 保持 501）；
  凭据不落盘、不写日志；不做多账号共享池 / 批量注册 / 付费分发。
- **命名沿用现有约定**：环境变量 `WORKBUDDY_*` / `DASHBOARD_*` / `CODEBUDDY_*`，
  见 `.env.example`。

## vendor 同步

`dsh-plugin/vendor/` 是分发给别人的**桥与控制台快照**，改了
`bridge/`、`dashboard/`、`config.mjs`、`lib/` 后必须重新生成：

```cmd
node dsh-plugin\scripts\vendor.mjs          :: 重新生成
node dsh-plugin\scripts\vendor.mjs --check  :: CI 与门禁会自动校验
```

## 发版四步

1. `npm run release:check` 全绿；改了 `dashboard/` 或 `tools/dev/` 还要 `npm run test:ui` 全绿
   （它不在 `release:check` 里：需要本机 Chrome，且要几分钟，不适合塞进 CI 矩阵）；
   改了面板或 `dsh-plugin/` 还要 `npm run panel:check`；
2. 在 `CHANGELOG.md` 的 `[Unreleased]` 落本次变化，转成版本条目（Keep a Changelog），
   版本号同步 **5 处**：`package.json`、`dsh-plugin/package.json`、
   `docs/openapi.yaml` 的 `info.version`、README 里的 tgz 文件名、
   以及 `package-lock.json` 的根版本（`version` 与 `packages[""].version`）；
   改了 UI 还要重出截图（`docs/screenshot*.png`、`docs/plugin-panel*.png`）——
   **截图不在任何门禁里**，最容易漏；
3. `npm run pack:plugin` → `git tag vX.Y.Z` → 推送 → `gh release create` 带上 tgz
   （说明里引用图片要用**绝对 URL**：release notes 不在仓库树里，相对路径解析不了）；
4. `npm run verify:release` —— 把**已发布**的那个 tgz 下下来验一遍
   （`release:check` 验的是本地 `vendor/`，验不到「`npm pack` 到底打进去了什么」）。
   本机要带合并 CA 跑，见下。

只支持最近 2 个 minor 版本。

### 本机跑网络相关的命令

这台机器上有中间证书，且 GitHub 直连不稳定：

```sh
NODE_EXTRA_CA_CERTS=E:/tmp/combined-ca.pem npm run verify:release
```

（与 `git push` 用的是同一个 `combined-ca.pem`；不用 `curl` —— 它的 schannel
后端会报 `CRYPT_E_NO_REVOCATION_CHECK`。`verify:release` 会把下载缓存在
`.tmp-research/release/`，重跑不必再下；`--refresh` 强制重下。）

## 提交信息

用中文 + conventional 风格（`feat:` / `fix:` / `docs:` / `refactor:` / `test:`），
标题一句话说清"动了什么"；正文写**为什么**（坑与取舍），评审者最需要的是后者。

## 上游观察

上游协议是未公开接口。遇到新的错误码 / 请求头 / 黑名单行为：
**监控、记录、不猜测、不预先改**——先写进 `docs/TROUBLESHOOTING.md` 与
CHANGELOG 的「上游观察」，拿不准的用 `tools/dev/` 下的探针脚本实测后再动手。
