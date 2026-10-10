# 配置

## 优先级

```
进程环境变量  >  .env 文件  >  内置默认值
```

`.env` 由 `config.mjs` 在启动时读取，**不会覆盖已存在的环境变量**（便于临时用环境变量覆盖）。

```cmd
copy .env.example .env
```

`.env` 已在 `.gitignore` 中，但仍不建议在此填写任何真实凭据——本项目不需要。

---

## 全部变量

### 桥

| 变量 | 默认值 | 说明 |
|---|---|---|
| `WORKBUDDY_HOST` | `127.0.0.1` | 桥绑定地址。**不要改成 `0.0.0.0`** |
| `WORKBUDDY_PORT` | `8790` | 桥监听端口 |
| `WORKBUDDY_LOCAL_TOKEN` | 首次启动随机生成 | 本地回环令牌。仅用于阻止同机其它程序误用该端口，**不是**上游凭据。留空即自动生成并落到 `dsh-plugin/.bridge-token`（控制台与插件共用同一文件，保证一致）；需与 dsh 的 `WORKBUDDY_BRIDGE_KEY` 值一致 |
| `WORKBUDDY_TIMEOUT_MS` | `0` | 上游请求超时（毫秒）。`0` = 不限——长回答需要保持 0 |
| `WORKBUDDY_LOG` | `1` | `1` 时打印每次请求的模型、消息数、工具数（**不含对话内容**） |
| `WORKBUDDY_ANTHROPIC_MODEL` | `glm-5.3` | Claude Code 的模型名映射到哪个上游真实模型。可填任意 `/v1/models` 里的 id |
| `WORKBUDDY_ANTHROPIC_FAST_MODEL` | `glm-5.3-flash` | Claude Code 后台任务（标题生成、文件摘要）用的小快模型 |
| `WORKBUDDY_RESPONSES_MODEL` | `glm-5.3` | Codex（`/v1/responses`）的模型名映射。Codex 发的是它 config.toml 里的 `model`（如 `gpt-5.1-codex`），上游没有这些 id，必须映射到真实模型 |
| `WORKBUDDY_RESPONSES_FAST_MODEL` | `glm-5.3-flash` | Codex 的后台小快模型。**只有名字里带 mini / nano / flash 这类字样才会用到它** —— `gpt-5.1-codex` 是主力模型，刻意不匹配 "codex"，否则会把主任务降级 |

### 控制台

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DASHBOARD_PORT` | `8792` | 控制台端口 |
| `DASHBOARD_AUTO_START_BRIDGE` | `1` | 控制台启动时自动拉起桥（"双击即用"的关键）。设为 `0` 则改为手动点「启动桥服务」 |
| `WORKBUDDY_QUOTA_TTL_MS` | `60000` | 积分余额的缓存时长。总览每 20 秒轮询一次，而积分要打上游计费网关；调小可更快反映余额变化（如签到后），代价是更频繁的上游查询 |

### WorkBuddy 客户端

| 变量 | 默认值 | 说明 |
|---|---|---|
| `WORKBUDDY_APP_EXECUTABLE` | 自动探测 | 客户端可执行文件。探测顺序见下 |
| `WORKBUDDY_AUTH_FILE` | 自动定位 | 登录文件绝对路径。**多账号时务必显式指定** |
| `WORKBUDDY_AUTH_DIR` | 平台默认 | 登录文件所在目录，仅在目录被移动时需要 |

### 一键接入

「客户端接入」面板的「一键接入」与 `npm run connect` 会**写**客户端的配置文件。
这三个路径都有默认值（`~/.codex/config.toml`、`~/.claude/settings.json`、
`~/.config/opencode/opencode.json`），只在客户端装到非常规位置时才需要覆盖。
测试也是靠它们把目标挪到临时目录，**不会碰真实配置**。

**它对你的文件做了什么、不做什么**（这几条是踩过坑之后定下来的）：

| 情况 | 行为 |
|---|---|
| 别人的键 / 节 / 注释 / 顺序 | **一字不动**（TOML 走行级改写；`cc-switch` 那种 provider 节实测未动） |
| 带注释的 JSONC（opencode 官方支持） | **能接**：先试严格 JSON，再试剥注释的版本。注释会在重写后消失，界面提前提示"会重新排版" |
| 尾逗号 | **如实报错并停手**（不在 JSONC 规范里，不猜 —— 猜错就是改坏文件） |
| 字符串里的 `//`（如 URL） | 不会被当成注释（逐字符扫描 + 转义处理） |
| BOM / CRLF / 缩进风格 | 写入时会被规范化为 2 空格 + `\n`（JSON）或原样保留（TOML）；**BOM 保留** |
| 空文件 | 当成"还没有配置"，**能一键接上**（不是"格式不对"） |
| 中间层是数组 / null（如 `"env": []`） | **不覆盖你的数据**，并把没写进去的键**列出来**告诉你怎么修（把它改成对象后重试） |
| 语法确实坏了 | 报错并**绝不动文件** |

撤销的承诺是「还原到接入之前」：逐键还原**首次写入时记录的原值**（而不是拿备份整份盖回去
—— 那会连带丢掉用户在写入之后自己做的改动），BOM 一并还原，Codex 的模型目录文件
要么按备份还原、要么（我们建的）删掉。

**多模型（每个客户端可接多个，其中一个作主模型）各写在哪：**

| 客户端 | 写什么 | 怎么切换 |
|---|---|---|
| opencode | `provider.workbuddy.models` 里声明**勾选的每一个**；`model` 指向主模型 | TUI 里直接选 |
| Claude Code | `modelPicker.options` 列出勾选的模型（`replaceBuiltInOptions: true`）+ `env.ANTHROPIC_MODEL` 指主模型 | `/model` 选择器 |
| Codex | `model` 指主模型；勾选的模型写进 `model_catalog_json` 指向的**目录文件** | `-m <模型>` 或 Codex 的模型选择器 |

> Codex 的那份目录是**第二个文件**：默认写在 `config.toml` 同目录下的
> `workbuddy-model-catalog.json`。它**合并**而不是覆盖 —— 如果 `model_catalog_json`
> 已经指向别人的目录（本机 cc-switch 就是），原来那些条目一条不动地保留，
> 只补桥这边缺的。撤销时配置文件里的键还原、我们建的目录文件删掉、
> 改过的目录文件按备份还原。
>
> 目录条目是**克隆**现成模板再改 slug/名字/上下文（模板取自现有目录，或 Codex 自己
> 抓的 `models_cache.json`）—— 条目的字段有三十来个，少一个 Codex 可能整份解析失败。
> 两处模板都没有时**不生成目录**，界面与命令行都会如实说明「只能接一个模型」，
> 不硬编造条目。

**换一台电脑也能用**：目标路径**不写死**，而是按各家官方的约定现算。
别人的机器上如果改过这些（很常见 —— 同步盘、多账号、公司策略都会改），我们跟着走：

| 客户端 | 认哪个变量 | 依据 |
|---|---|---|
| Codex | `CODEX_HOME` | Codex 官方约定（本机用 `codex doctor` 实测：设了它，它自述的 config 路径就变成 `<CODEX_HOME>/config.toml`） |
| Claude Code | `CLAUDE_CONFIG_DIR` | [官方文档](https://code.claude.com/docs/en/settings)：*To keep the home-directory files somewhere else, set `CLAUDE_CONFIG_DIR`* |
| opencode | `XDG_CONFIG_HOME` | 全局层固定在 `~/.config/opencode/`（[官方文档](https://opencode.ai/docs/config/)，Windows 也走 `%USERPROFILE%\.config\`）。`OPENCODE_CONFIG` 是**另一层**（指定别的配置文件、优先级更高），不是同一件事，故不冒充 |

> 路径是怎么定下来的会**显示出来**（面板上标「按客户端的设置写入：CODEX_HOME」、
> 命令行标「路径来源: 跟随客户端的 CODEX_HOME」）—— 只给一个最终路径，
> 用户没法确认"它认没认对地方"，而认错的后果是把配置写进客户端根本不读的位置。

| 变量 | 默认值 | 说明 |
|---|---|---|
| `WORKBUDDY_CODEX_CONFIG` | `$CODEX_HOME/config.toml`，未设则 `~/.codex/config.toml` | Codex 的配置文件路径（目录文件写在它旁边）。**优先级高于** `CODEX_HOME` |
| `WORKBUDDY_CLAUDE_SETTINGS` | `$CLAUDE_CONFIG_DIR/settings.json`，未设则 `~/.claude/settings.json` | Claude Code 的设置文件路径。**优先级高于** `CLAUDE_CONFIG_DIR` |
| `WORKBUDDY_OPENCODE_CONFIG` | `$XDG_CONFIG_HOME/opencode/opencode.json`，未设则 `~/.config/opencode/opencode.json` | opencode 的**全局**配置路径 |
| `WORKBUDDY_CONNECT_BACKUP` | `<仓库>\.backup\client-configs\` | 写入前的备份与撤销记录放哪。仓库只读（如 vendor 分发）时退回 `~/.workbuddy-bridge\client-configs\` |

`WORKBUDDY_*` 三个是**本产品自己的**覆盖（测试、运维、非常规安装用），
优先级最高；没设时才看客户端自己的变量。

### 路径类配置都是「读取那一刻生效」

`DSH_HOME`、`CODEX_HOME`、`CLAUDE_CONFIG_DIR`、`XDG_CONFIG_HOME` 以及本产品的
`WORKBUDDY_*` 覆盖变量，全部**在读到它们的那一刻求值**，不是进程启动时就定死。
所以这几种写法都成立：

```js
import { config } from './config.mjs';
process.env.DSH_HOME = 'X:\\my-dsh';     // 之后再设，一样生效
config.dsh.settingsPath;                  // → X:\my-dsh\settings.yaml
```

> 为什么值得一提：`config.dsh` 的四个路径是 getter（不是普通属性）。
> 早期版本在 `import` 那一刻就把它们算成常量了，于是"先 import 再设 `DSH_HOME`"
> 这种最自然的写法会**静默失效** —— 用户以为 dsh 配置改到了别处，实际还在 `~/.dsh`，
> 而写 dsh 配置是会**动用户文件**的（往里加模型路由）。有单测钉住这条。
>
> 空白值（`DSH_HOME="   "`）不会被当成路径，会回落家目录 —— 否则会拼出一个
> 名字是空格的目录。

**备份目录**（`WORKBUDDY_CONNECT_BACKUP`，默认 `<仓库>\.backup\client-configs\`）
跟着**代码位置**走，不跟启动目录走 —— 换个启动方式（快捷方式、计划任务、
从别处 `node dashboard/server.mjs`）不会让上次的备份与撤销记录"消失"。

**可执行文件探测顺序**（客户端重装到任意目录后都会自动重新定位，无需配置）：

1. `WORKBUDDY_APP_EXECUTABLE`（显式覆盖，最高优先）
2. 默认安装位置：`%LOCALAPPDATA%\Programs`、`%ProgramFiles%`、`%ProgramFiles(x86)%` 下的
   `WorkBuddy` / `WorkBuddy AI` / `WorkBuddyAI` / `CodeBuddy` 目录（exe 名兼容
   `WorkBuddy.exe` / `WorkBuddyAI.exe` / `CodeBuddy.exe`），以及 `E:\App\WorkBuddy\` 等历史自定义位置
3. 磁盘浅扫描：每个盘符下常见父目录（`App` / `Program Files` / `Tencent` / `Software` / `Tools` 等）
   中名字含 `workbuddy` / `codebuddy` 的目录（深度最多 3 层）——覆盖
   `E:\App\WorkbuddyInternational\`、`C:\Program Files\Tencent\WorkBuddy\` 这类自定义安装
4. **系统信号兜底**（仅当前三层全部落空时执行，PowerShell 冷启动数秒）：
   - 运行中进程的镜像路径（客户端在用时即安装位置）；
   - 注册表安装记录：卸载项（`DisplayIcon` / `UninstallString`）、深链协议
     （`workbuddy://…`）、App Paths —— 官方安装器必写，**装到任何目录都有**。
5. macOS：`/Applications/WorkBuddy.app/Contents/MacOS/WorkBuddy`；Linux：`/opt/WorkBuddy/workbuddy`

前两层零成本；扫描只在前面落空时执行一次（带目录预算与缓存）；系统信号兜底最贵
（且失败后 2 分钟内不重试）。exe 被卸载或移动后会自动重探（重探有 5 秒防抖，避免在
"客户端正在重装"的窗口期内反复扫描）。桥的启动日志里 `client exe` 一行显示实际
使用的可执行文件。

> 机器上同时装着多个客户端（如国内版 + 国际版）时，以**登录文件里信封的 keyId**
> 为准挑选能解开它的那个 build —— 而不是盲取第一个找到的 exe。

**登录文件定位规则**：先找 `<auth 目录>/workbuddy-desktop.info`；不存在则取目录下第一个
`.info`。auth 目录按平台为：

| 平台 | 路径 |
|---|---|
| Windows | `%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth` |
| macOS | `~/Library/Application Support/CodeBuddyExtension/Data/Public/auth` |
| Linux | `~/.local/share/CodeBuddyExtension/Data/Public/auth` |

> ⚠️ 该目录下可能同时存在多个账号快照（例如另一账号或国际版的
> `workbuddy-desktop-ai.info`）。仅按目录顺序取第一个会**选错账号**，
> 因此本项目的默认值是固定的 `workbuddy-desktop.info`。

### DeepSeek Harness

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DSH_HOME` | `%USERPROFILE%\.dsh` | dsh 配置根目录 |
| `DSH_RUNTIME` | 自动探测 | dsh 运行时。优先 DSH Desktop 的 bundled 运行时（`<安装目录>\resources\runtime`），回退到独立安装 `%USERPROFILE%\DeepSeek-Harness\runtime` |

> **本机可能同时存在多套 dsh，版本不同**（实测 0.2.0-rc.2 与 0.1.0-rc.6）。
> 采用哪一套会直接改变结论，因此自动探测优先取 DSH Desktop 的那一套，
> 并由 `tools/doctor.mjs` 打印出来。详见
> [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md#本机有两套-dsh-运行时)。

---

## 派生值

`config.mjs` 由上述变量派生出，供代码引用：

```js
config.bridge.url             // http://127.0.0.1:8790
config.bridge.chatUrl         // .../v1/chat/completions
config.bridge.modelsUrl       // .../v1/models
config.bridge.healthUrl       // .../health
config.dashboard.url          // http://127.0.0.1:8792
config.workbuddy.exe
config.workbuddy.authFile
config.dsh.settingsPath       // <DSH_HOME>/settings.yaml
config.dsh.credentialsPath    // <DSH_HOME>/.credentials.yaml
config.dsh.profileDir         // <DSH_HOME>/profiles/desktop
config.paths.bridgeScript
config.paths.bridgeLog
```

---

## 改端口

控制台通过 `config.bridgeEnv()` 把配置注入桥进程，因此**只需改一处**：

```ini
WORKBUDDY_PORT=18890
DASHBOARD_PORT=18892
```

- 桥、控制台、诊断都会跟着变
- dsh 侧需同步：`settings.yaml` 里的 `baseURL` 会在下次「保存到 dsh 设置」时自动更新，
  或手工改这一行

**注意**：`WORKBUDDY_LOCAL_TOKEN` 改动后，dsh 的 `.credentials.yaml` 里的
`WORKBUDDY_BRIDGE_KEY` 也必须同步改成同样的值。

---

## 查看当前生效配置

```cmd
node tools\doctor.mjs
```

输出顶部会打印配置根、桥地址、控制台地址、登录文件与客户端路径。
