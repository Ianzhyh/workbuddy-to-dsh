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
| `WORKBUDDY_LOCAL_TOKEN` | `wb-local-bridge` | 本地回环令牌。仅用于阻止同机其它程序误用该端口，**不是**上游凭据。需与 dsh 的 `WORKBUDDY_BRIDGE_KEY` 值一致 |
| `WORKBUDDY_TIMEOUT_MS` | `0` | 上游请求超时（毫秒）。`0` = 不限——长回答需要保持 0 |
| `WORKBUDDY_LOG` | `1` | `1` 时打印每次请求的模型、消息数、工具数（**不含对话内容**） |
| `WORKBUDDY_ANTHROPIC_MODEL` | `glm-5.3` | Claude Code 的模型名映射到哪个上游真实模型。可填任意 `/v1/models` 里的 id |
| `WORKBUDDY_ANTHROPIC_FAST_MODEL` | `glm-5.3-flash` | Claude Code 后台任务（标题生成、文件摘要）用的小快模型 |

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

**可执行文件探测顺序**：

1. `WORKBUDDY_APP_EXECUTABLE`
2. `E:\App\WorkBuddy\WorkBuddy.exe`
3. `%LOCALAPPDATA%\Programs\WorkBuddy\WorkBuddy.exe`
4. `%ProgramFiles%\WorkBuddy\WorkBuddy.exe`
5. `%ProgramFiles(x86)%\WorkBuddy\WorkBuddy.exe`
6. macOS：`/Applications/WorkBuddy.app/Contents/MacOS/WorkBuddy`
7. Linux：`/opt/WorkBuddy/workbuddy`

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
