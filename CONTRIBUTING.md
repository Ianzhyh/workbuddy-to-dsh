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
4. 桥侧测试**不触真上游**：用 `CODEBUDDY_ENDPOINT` 指向打桩上游
   （见 `bridge.test.mjs` 的 `startStubUpstream`）。

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

## 发版三步

1. `npm run release:check` 全绿；
2. 在 `CHANGELOG.md` 的 `[Unreleased]` 落本次变化，转成版本条目（Keep a Changelog），
   版本号写进 `package.json`；
3. `git tag vX.Y.Z` 并推送。

只支持最近 2 个 minor 版本。

## 提交信息

用中文 + conventional 风格（`feat:` / `fix:` / `docs:` / `refactor:` / `test:`），
标题一句话说清"动了什么"；正文写**为什么**（坑与取舍），评审者最需要的是后者。

## 上游观察

上游协议是未公开接口。遇到新的错误码 / 请求头 / 黑名单行为：
**监控、记录、不猜测、不预先改**——先写进 `docs/TROUBLESHOOTING.md` 与
CHANGELOG 的「上游观察」，拿不准的用 `tools/dev/` 下的探针脚本实测后再动手。
