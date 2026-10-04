# 安装与分发（给别人用）

给别人装 = **对方拿到插件 + 插件自带它需要的桥和控制台**。本文给三条分发路线、
对方机器上的前置条件、一步步的安装步骤，以及出问题时的自检与排查表。

> 一句话结论：`dsh-plugin/` 是一个**自带一切**的独立包（`vendor/` 里含桥与控制台），
> 拷过去装进 dsh 就能用，**不需要对方也 clone 整个仓库**。

---

## 一、前提条件（对方机器上）

| 需要 | 说明 | 怎么确认 |
|---|---|---|
| **Windows** | 桥要解密 WorkBuddy 桌面端的 AtRest 凭据（Windows DPAPI），目前只支持 Windows | — |
| **Node.js 18+** | 桥与控制台都是纯 Node 脚本；dsh 自带的 runtime 也行 | `node -v` |
| **WorkBuddy 桌面端，且已登录** | 模型来自它的登录态；登录文件在 `%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\*.info` | 打开 WorkBuddy 能正常对话 |
| **DeepSeek Harness（dsh）桌面版** | 插件宿主 | 能打开 dsh 界面 |

不需要：不需要 OpenAI key、不需要对方有本仓库、不需要管理员权限。
插件**只连本机回环地址**，不新增对外监听、不上传任何数据。

---

## 二、三条分发路线

### 路线 A：直接拷文件夹（最省事，推荐给同事）

1. 在开发者机器上，仓库根目录执行一次（生成自带副本；已生成过则更新）：
   ```sh
   npm run vendor
   ```
2. 把整个 **`dsh-plugin/` 文件夹**打包发过去（微信/网盘/U 盘都行）。里面应当有：
   ```
   dsh-plugin/
     package.json  cordis.patch.yml  README.md
     lib/          宿主端 + 设置页
     scripts/      vendor.mjs（同步副本）preflight.mjs（环境自检）
     vendor/       桥 + 控制台 + 共享库（自带，别人不需要仓库）
   ```
3. 对方解压到任意目录（例如 `D:\dsh-plugin-workbuddy`），然后自检：
   ```sh
   node D:\dsh-plugin-workbuddy\scripts\preflight.mjs
   ```
   ✅ 全绿再往下走；有 ❌ 按提示修（见第五节）。
4. 装进 dsh：
   - **界面**：dsh → 设置 → 插件 → 安装 → 填插件目录的绝对路径
   - **命令行**：`dsh plugin --profile <profile名> add D:\dsh-plugin-workbuddy`
5. **完全退出 dsh（托盘退出）再打开**（宿主端插件模块会被 ESM 缓存，必须重启）。
6. 验收：设置 → 最下面出现 **WorkBuddy**；模型选择器里 provider 选 **WorkBuddy** 能看到模型。

### 路线 B：打成 tarball 分发（带版本号，好回滚）

```sh
# 开发者机器
npm run pack:plugin        # = vendor + npm pack
# 产出 dsh-plugin/dsh-plugin-workbuddy-1.0.0.tgz
```
把 `.tgz` 发给对方，对方：
```sh
node <解压出来的插件目录>/scripts/preflight.mjs    # 或解压后自检
dsh plugin --profile desktop add D:\path\to\dsh-plugin-workbuddy-1.0.0.tgz
```
> `package.json` 里是 `"private": true`，这是有意的：防止误发到公共 npm。
> 本项目按非公开分发的定位维护，直接用 tgz 或文件夹拷贝即可。

---

## 三、对方装完后的验收清单

| 检查 | 期望 |
|---|---|
| `node dsh-plugin/scripts/preflight.mjs` | 关键项全 ✅（桥/控制台脚本、登录文件、端口） |
| dsh 设置 → 插件列表 | 有 `dsh-plugin-workbuddy`，且已启用 |
| 设置 → **WorkBuddy** | 出现这一页，顶部有「桥运行中 / 控制台运行中」两个状态 |
| 概览页 | 积分卡有数字、模型数量正确、原生路由显示「已注册 provider=workbuddy」 |
| 输入框旁模型选择器 | provider 选 WorkBuddy，能看到全部模型 |
| 随便发一句话 | 正常回答（说明桥 + 凭据解密 + 上游调用整条通了） |

---

## 四、对方机器上的目录与端口

| 东西 | 位置 / 端口 | 备注 |
|---|---|---|
| 桥 | `127.0.0.1:8790`，脚本 `<插件>/vendor/bridge/workbuddy-bridge.mjs` | 本地 token 默认 `wb-local-bridge` |
| 控制台网页 | `127.0.0.1:8792`，脚本 `<插件>/vendor/dashboard/server.mjs` | 插件会复用/拉起，不自动弹浏览器 |
| 运行期状态 | `<插件>/vendor/.state.json`、`.env`、`bridge/bridge.log`、`dashboard/console.log` | 全在插件目录内，不污染系统 |
| 凭据 | 只读 WorkBuddy 自己的登录文件，现取现解，不复制不外传 | — |

改端口 / 指定登录文件：在 `<插件>/vendor/.env` 里写（见 `.env.example`）：
```ini
WORKBUDDY_PORT=8790
DASHBOARD_PORT=8792
WORKBUDDY_AUTH_FILE=C:\Users\you\AppData\Local\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info
```

---

## 五、出问题怎么办（按症状查）

| 症状 | 原因 | 处理 |
|---|---|---|
| 设置里**没有 WorkBuddy 这一页** | 插件没装成 / 没重启 | 确认 profile 的 `package.json` 依赖里有它；**完全退出 dsh 再打开**（不是关窗口） |
| 页面上方提示「宿主端还是旧构建」/ 面板里一片 `HTTP 404` | 宿主端 plugin 代码是旧的（客户端半边刷新即新，宿主端必须重启） | 托盘退出 dsh 再打开 |
| 顶部显示「桥凭据异常」+「读不出登录凭据」 | **桥在跑，但 WorkBuddy 登录态失效**（最常见：登录过期、换过账号、登录文件被清） | 打开 WorkBuddy 桌面端重新登录；还不行就去看诊断页的「登录文件 / 凭据解密」两项 |
| 「桥未运行」且点了启动桥也没起来 | 桥脚本缺失 / 端口被占 | `preflight` 看是哪一项；桥日志：`<插件>/vendor/bridge/bridge.log` |
| 提示「登录文件」找不到 | WorkBuddy 没登录，或绿色版装在别处 | 登录 WorkBuddy；或在 `<插件>/vendor/.env` 里设 `WORKBUDDY_AUTH_DIR` / `WORKBUDDY_AUTH_FILE` |
| 端口 8790/8792 被别的软件占了 | 冲突 | 在 `<插件>/vendor/.env` 里换 `WORKBUDDY_PORT` / `DASHBOARD_PORT`（插件与控制台都读这个文件；**桥只吃环境变量**，手动跑桥时要自己带上） |
| 模型列表为空 | 登录过期，或上游改了接口 | 重新登录 WorkBuddy；`node <插件>/vendor/bridge/workbuddy-bridge.mjs` 前台跑，看报错 |
| 提示检测到**旧的 llm-pi-ai 路由**并撞名 | 对方之前手写过 `providers.workbuddy` | 用设置页概览的「清理旧路由」（会先备份），或 `/workbuddy cleanup` |
| 体检 / 账号切换按钮点了没反应或提示需要控制台 | 控制台没跑（结论只由它写，保证两边一致） | 概览页点「启动控制台」 |
| 想彻底卸载 | — | 设置 → 插件里停用/卸载；桥与控制台进程可留着（也可手动结束）；`<插件>/vendor/.state.json` 记录状态，删插件目录即清 |

---

## 六、给分发者的注意

- **改完仓库里的 `bridge/`、`dashboard/`、`config.mjs`、`lib/` 之后，一定要重跑 `npm run vendor`**，
  否则发出去的 `vendor/` 还是旧快照。CI / 发版前用 `npm run vendor:check` 校验（不同步会失败）。
- 发版前一键三连：`npm run release:check`（= vendor 同步校验 + 34 项单测 + 独立分发演练）。
- `vendor/` 只复制运行必需的 15 个文件（约 347 KB），**日志、`usage.jsonl` 用量账本、
  `.state.json`、`*.bak`、`.env` 一律不打包**（这些属于使用者本人的数据，绝不能进分发包）；
  脚本还会**清理** vendor 里遗留的这类文件。
- `npm run verify:standalone` 会把插件拷到一个没有仓库的临时目录，真起一遍桥与控制台
  （临时端口 18890/18892），验证"别人拿到的那份"确实能独立工作 —— 这一步能抓出
  "忘了 vendor""路径写死""vendor 里混进敏感文件"这类只在分发时才暴露的问题。
- 对方**同时有仓库和 vendor** 时，插件优先用仓库（本机开发改 bridge 立刻生效）；
  只有仓库不在旁边时才用 vendor —— 这条顺序有单测守着。
- 版本升级：改 `dsh-plugin/package.json` 的 `version` → `npm run vendor && npm run test:plugin` →
  重新打包/发布。对方覆盖安装即可，`vendor/.state.json` 与 `.env` 会保留。
