# 安装与分发（给别人用）

给别人装 = **对方拿到插件 + 插件自带它需要的桥和控制台**。本文给三条分发路线、
对方机器上的前置条件、一步步的安装步骤，以及出问题时的自检与排查表。

> 一句话结论：`dsh-plugin/` 是一个**自带一切**的独立包（`vendor/` 里含桥与控制台），
> 拷过去装进 dsh 就能用，**不需要对方也 clone 整个仓库**。

---

## 一、前提条件（对方机器上）

| 需要 | 说明 | 怎么确认 |
|---|---|---|
| **Windows** | 复用桌面端登录态时，解密密钥**不在本包里**：每次由客户端自己的 Electron 原生绑定现取。插件登录在 Windows 用 DPAPI 落盘；macOS / Linux 用文件密钥 + AES-GCM 落盘（未实机验证，按实验对待） | — |
| **Node.js 18+** | 桥与控制台都是纯 Node 脚本；dsh 自带的 runtime 也行 | `node -v` |
| **WorkBuddy 桌面端，且已登录**（或改用插件登录） | 二选一：① 复用桌面端登录态；② **不装桌面端**，在插件的「账号」页用「插件登录」完成浏览器授权（需要一个 WorkBuddy / CodeBuddy 账号） | ① 打开 WorkBuddy 能正常对话；② 账号列表里能看到标「插件」的账号 |
| **DeepSeek Harness（dsh）桌面版** | 插件宿主 | 能打开 dsh 界面 |

不需要：不需要 OpenAI key、不需要对方有本仓库、不需要管理员权限；
改用插件登录时**不需要安装 WorkBuddy 桌面端**（凭据由插件保管：Windows DPAPI，其他平台文件密钥 + AES-GCM 落盘）。
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
# 产出 dsh-plugin/dsh-plugin-workbuddy-<版本>.tgz
```
把 `.tgz` 发给对方，对方：
```sh
node <解压出来的插件目录>/scripts/preflight.mjs    # 或解压后自检
dsh plugin --profile desktop add D:\path\to\dsh-plugin-workbuddy-<版本>.tgz
```
> `package.json` 里是 `"private": true`，这是有意的：防止误发到公共 npm。
> 本项目按非公开分发的定位维护，直接用 tgz 或文件夹拷贝即可。

### 路线 C：从 GitHub 直装（推荐，仓库根已声明 `dsh.bundle`）

**界面安装（就是「添加插件」对话框）**：dsh → 设置 → 插件 → 添加插件，填

```text
github:Ianzhyh/workbuddy-to-dsh
```

安装源保持默认即可；GitHub 地址由 pnpm 直接拉取，国内镜像只影响 npm 依赖。
或走命令行：

```sh
dsh plugin --profile desktop add github:Ianzhyh/workbuddy-to-dsh
```

> 路线 C / D 装的是**仓库根包**：桥、控制台、共享库在根目录各有一份，
> `dsh-plugin/vendor/` 不整目录重复打包（省约 1.7MB）；只有插件宿主入口静态
> import 的 `vendor/lib/failover.mjs`（共享的限流切号判定）会随根包带上。
> 完整 vendor 只用于路线 A / B 的单文件夹分发。

### 路线 D：npm 包名（发布后可用）

根包 `workbuddy-to-dsh` 已按可发布形态准备好（`private: false` + `publishConfig`）。
维护者发布一次后，对方在「添加插件」里直接填 `workbuddy-to-dsh`，或：

```sh
dsh plugin --profile desktop add workbuddy-to-dsh
```

> `dsh-plugin-workbuddy` 这个 npm 名**已被他人占用**（0.0.1，非本项目），不要填它；
> npm 分发请使用根包名 `workbuddy-to-dsh`。

> ⚠️ **关于 `os` 字段（实测结论）**：只有 `dsh-plugin/package.json` 声明了
> `"os": ["win32"]`；根包**不能**声明它 —— 否则 Linux / macOS 上的 `npm ci` 会直接
> 失败（CI 实测）。这个字段**只对 npm 生效**；而 **dsh 的插件安装走它自带的 pnpm**，
> pnpm 不检查 `os`。所以 macOS / Linux 上三条路线都装得上；真正拦住非 Windows 的
> 不是安装，而是**凭据解密没有实测**（见第一节）：装上去大概率卡在「读不出登录凭据」。
> 要试请按实验对待。

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
| 桥 | `127.0.0.1:8790`，脚本 `<插件>/vendor/bridge/workbuddy-bridge.mjs` | 本地 token 首次启动随机生成，落在 `%USERPROFILE%\.workbuddy-bridge\bridge-token`（`WORKBUDDY_DATA_DIR` 可覆盖） |
| 控制台网页 | `127.0.0.1:8792`，脚本 `<插件>/vendor/dashboard/server.mjs` | 插件默认按需拉起、闲置 10 分钟退出；不自动弹浏览器 |
| 运行期状态 | `%USERPROFILE%\.workbuddy-bridge\{state.json,usage.jsonl,credentials/}`；日志在 `<插件>/vendor/bridge/bridge.log`、`dashboard/console.log` | 状态与账本**不放安装目录**，换 tgz/重装不丢；日志仍在插件目录 |
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
| 想彻底卸载 | — | 设置 → 插件里停用/卸载；桥与控制台进程可留着（也可手动结束）；运行期状态在 `%USERPROFILE%\.workbuddy-bridge\`，**删插件目录不会清它**，需要时手动删这个数据目录 |
| 想换机 / 重装前留一份运行期数据 | — | 在**仓库检出目录**停桥与控制台后运行 `node tools\backup.mjs --out D:\wb-backup`；恢复用 `node tools\backup.mjs --restore D:\wb-backup --yes`。备份含令牌与插件加密凭据，按敏感文件保管，详见 `docs/TROUBLESHOOTING.md` |

---

## 六、给分发者的注意

- **改完仓库里的 `bridge/`、`dashboard/`、`config.mjs`、`lib/` 之后，一定要重跑 `npm run vendor`**，
  否则发出去的 `vendor/` 还是旧快照。CI / 发版前用 `npm run vendor:check` 校验（不同步会失败）。
- 发版前一键三连：`npm run release:check`（= vendor 同步校验 + lib/桥/插件单测 + 独立分发演练）。
- `vendor/` 只复制运行必需的 19 个文件（约 1.5 MB），**日志、`usage.jsonl` 用量账本、
  `.state.json`、`*.bak`、`.env` 一律不打包**（这些属于使用者本人的数据，绝不能进分发包）；
  脚本还会**清理** vendor 里遗留的这类文件。
- `npm run verify:standalone` 会把插件拷到一个没有仓库的临时目录，真起一遍桥与控制台
  （临时端口 18890/18892），验证"别人拿到的那份"确实能独立工作 —— 这一步能抓出
  "忘了 vendor""路径写死""vendor 里混进敏感文件"这类只在分发时才暴露的问题。
- 对方**同时有仓库和 vendor** 时，插件优先用仓库（本机开发改 bridge 立刻生效）；
  只有仓库不在旁边时才用 vendor —— 这条顺序有单测守着。
- 版本升级：按 `CONTRIBUTING.md` 发版四步同步 5 处版本号（根/子包、lock、OpenAPI、README/tgz）→ `npm run release:check` → 重新打包/发布。对方覆盖安装即可，运行期状态在 `%USERPROFILE%\.workbuddy-bridge\`，与安装目录无关；`.env` 仍由使用者自己保管。
