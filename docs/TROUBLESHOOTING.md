# 故障排查

## 先做这一步

```cmd
node tools\doctor.mjs
```

它会检查 8 件事并按严重程度排序，直接告诉你缺什么。加 `--json` 可给脚本消费
（有失败项时退出码为 1）。

---

## 按症状定位

### 模型没有出现在 dsh 的模型选择器里

三个必要条件，缺一不可 —— 逐项确认：

1. **桥在跑** → 控制台徽章应为绿色；或 `curl -H "Authorization: Bearer wb-local-bridge" http://127.0.0.1:8790/health`
2. **`settings.yaml` 已写入** → 控制台「可用模型」里至少勾了一个模型并保存过
3. **profile bundle 完整** → doctor 的 `profile bundles` 项为绿

第 3 项最常见的失败长这样：

```
Error: dsh: cannot resolve profile bundle "@deepseek-ai/dsh-experimental-agent-team-profile"
```

含义是 `~/.dsh/profiles/desktop/package.json` 的 `bundles` 里列了一个**没装**的包，
整个 profile 因此组合不起来，用户设置文档也不会被加载。

```cmd
:: 补装
node %USERPROFILE%\DeepSeek-Harness\runtime\node_modules\@deepseek-ai\dsh\lib\bin.js plugin --profile desktop install
```

如果那个 bundle 根本不是你要的，直接从 `bundles` 数组里删掉该行即可。

### 桥起不来

| 报错 | 原因 | 处理 |
|---|---|---|
| `login file has no accessToken` | 登录文件缺失或未登录 | 在 WorkBuddy 桌面端登录后重试 |
| `key fetch failed` | 取不到 AtRest 密钥 | 确认 WorkBuddy 已安装；设 `WORKBUDDY_APP_EXECUTABLE` |
| `key fetch failed (exit 3)` | 原生绑定调用失败 | 客户端版本不匹配；尝试重新登录客户端 |
| `EADDRINUSE` | 端口被占 | 先点「停止桥服务」，或改 `WORKBUDDY_PORT`。控制台会如实告诉你结果：桥已在运行时点「启动桥服务」显示「桥已在运行（PID N）」；新进程确实起不来时显示「新进程启动失败，仍在复用旧进程（PID N）」，并在悬停提示里给出 `EADDRINUSE` 原文 |

### 401 / 认证类错误

| 现象 | 原因 |
|---|---|
| `401 Authorization Required`（HTML + APISIX 字样） | 鉴权头无效 —— 通常意味着凭据**没有被解开**，桥拼出了 `Bearer [object Object]` |
| `envelope belongs to key <X>, not <Y>` | 登录文件由另一个 build 写入（例如装了国际版客户端），或本机有多套客户端 |
| `refreshToken is empty` 且随后 401 | 同上，凭据字段未被正确解析 |

排查顺序：

```cmd
node tools\verify-atrest.mjs
```

该脚本只输出长度和 `startsWith('eyJ')`，**不会打印任何令牌内容**。正常输出：

```
derived keyId: 9127dea1b44020a7
accessToken  : envelope keyId=9127dea1b44020a7 -> DECRYPTED len=1359 jws-like=true
refreshToken : envelope keyId=9127dea1b44020a7 -> DECRYPTED len=698 jws-like=true
```

若 `keyId` 与信封里的不一致，说明登录文件不是本机这个客户端写的 → 在客户端里重新登录一次。

### 400 类错误（来自上游）

| 错误码 | 含义 | 说明 |
|---|---|---|
| `11101` | `Non-stream chat request is currently not supported` | 上游只接受流式。桥已自动转换；若仍出现，说明请求绕过了桥 |
| `11128` | `Illegal API invocation from an unapproved channel` | 请求结构或调用方身份不被认可。常见于 `system` 提示词被放在 `developer` 角色，或 User-Agent 不匹配 |
| `11133` | 网关包装的瞬时上游故障 | 桥会退避重试；频繁出现请稍后再试 |

### 启动脚本（.cmd）里不能出现中文

`cmd.exe` 在 `chcp` 生效**之前**就已经按系统 ANSI 码页解析完整个 `.cmd` 文件。
如果文件以 UTF-8 保存且含中文，多字节序列会被 GBK 误读，**连命令本身都会被截断**——
实测 `if not errorlevel 1` 被读成 `'rrorlevel'`，脚本直接崩溃。

因此 `启动.cmd` **刻意保持纯 ASCII**，面向用户的中文提示全部由 Node 进程输出
（那部分发生在 `chcp 65001` 之后，是安全的）。

**结论**：`.cmd` 保持 ASCII，中文交给被调用的程序打印。

### Node 子进程相关

```
spawnSync C:\WINDOWS\system32\cmd.exe EBUSY
```

**根因**：`execSync` / `execFileSync` 默认会为子进程的 stdin 打开管道，在这台机器上
启动 Electron 或 `cmd.exe` 会直接失败。

**修复**：任何同步子进程调用都必须显式忽略 stdin，并直连绝对路径：

```js
spawnSync(systemExe('netstat'), ['-ano'], {
  stdio: ['ignore', 'pipe', 'pipe'],   // ← 关键
  encoding: 'utf8',
  windowsHide: true,
});
```

### 某个模型调不通 / 报错但不知道原因

先看控制台的**「最近请求」**面板：逐条列出时间、模型、方式、耗时、token、积分与结果，
**失败的行整行标红**，鼠标悬停结果标签可以看到上游返回的错误原文。面板上方的提示条
直接给出**失败率**与出现最多的「错误码 · 模型」组合——想定位「哪个模型调不通」，
打开「仅看失败」开关即可只看失败行。

常见的错误码：

| 错误码 | 含义 |
|---|---|
| `11102` | 模型不存在或未接入 —— 该 id 在上游没有配置 |
| `11101` | 上游不接受非流式请求（桥已自动转流式，出现说明请求绕过了桥） |
| `11128` | 请求结构或调用方身份不被认可（`system` 提示词放错角色、UA 不匹配） |
| `11133` | 网关包装的瞬时上游故障，桥会退避重试 |

面板为空说明桥没在跑，或还没有任何请求经过桥。原始日志（含更完整的堆栈）在
`bridge/bridge.log`。

### 选错账号

登录目录里有多个 `.info` 时，**自动探测按固定优先级取**：

1. `WORKBUDDY_AUTH_FILE`（显式指定，最高优先级）
2. `WORKBUDDY_AUTH_DIR` 或默认登录目录下的 `workbuddy-desktop.info`
3. 该目录下按文件名排序的第一个 `.info`

第 2 步很关键：国际版的 `workbuddy-desktop-ai.info` 恰好排在
`workbuddy-desktop.info` **前面**，若只取"目录里第一个"，独立启动的桥会静默
切到另一个账号。`config.mjs` 与桥用的是同一套优先级，两处结论一致。

需要强制指定时：

```ini
WORKBUDDY_AUTH_FILE=C:\Users\<you>\AppData\Local\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info
```

用「最近修改时间」判断哪个是当前活跃的：在客户端里登录一次，看哪个文件的 `mtime` 变了。

### 桥在跑，页面却说「桥未运行」

**先确认是页面误报还是桥真的没起来：**

```cmd
curl -H "Authorization: Bearer wb-local-bridge" http://127.0.0.1:8790/health
```

- 有 JSON 返回、`"ok":true` → 桥是好的，是探测超时
- 连接被拒 → 桥确实没起来，看下面的「桥起不来」

探测超时只出现在**旧版**：旧 `/health` 会同步等一次上游模型目录抓取，而目录要
串行打两个上游端点，冷缓存时超过控制台的 4 秒探测超时，于是被误判成未运行。
现在的 `/health` 只读内存缓存、过期只在后台刷新，因此**恒为毫秒级**，且额外汇报
`pid` / `uptimeMs` / `catalogSize`。页面「桥进程」卡片就是这几个字段。

### 桥日志无限增长

`bridge/bridge.log` 在**每次启动桥时**检查大小，超过 2MB 就滚动为
`bridge.log.1`（覆盖上一份）。长期挂着不用管它。

### 清空账本 / 清空日志

| 动作 | 入口 | 说明 |
|---|---|---|
| 清空用量账本 | 「用量统计」表头的**清空账本**（二次确认） | 桥侧 `DELETE /v1/usage`：截断 `bridge/usage.jsonl` **并**重置进程内副本。手工删除该文件同样有效——桥每次写入前比对文件大小，发现被清空就以文件为准，不会再「复活」旧记录 |
| 清空桥日志 | 日志面板里的**清空日志**（二次确认） | 截断 `bridge.log`；桥持有的是追加 fd，会继续往新文件写 |
| 只看本次启动 | 日志面板里的**只看本次启动** | 按最后一次启动横幅切分，避免看到上上次启动的输出 |

> 账本与日志都**不含任何令牌明文与对话内容**：账本只有时间/模型/耗时/token/扣分/错误码，
> 日志只有模型名、消息数与工具数。

---

## 日志

| 日志 | 位置 |
|---|---|
| 桥运行日志 | `bridge/bridge.log` |
| 控制台输出 | 运行 `启动.cmd`（macOS / Linux：`scripts/start.sh`）的那个窗口 |
| dsh 自身日志 | `~/.workbuddy/logs/`、dsh 应用内的日志面板 |

桥设置 `WORKBUDDY_LOG=1`（默认）后，每次请求都会记一行：

```
[2026-10-03T12:08:12.917Z] → deepseek-v4.1-flash stream=true msgs=2 tools=0
```

**只记录模型名、消息数与工具数，不记录对话内容。**

---

## DSH Desktop 0.2.0 的配置导入机制

**`settings.yaml` 突然消失、变成 `settings.yaml.imported`，这不是故障。**

DSH Desktop 0.2.0 启动时会把 `$DSH_HOME/settings.yaml` **合并进**
`$DSH_HOME/profiles/<name>/cordis.patch.yml`，然后把原文件归档为 `.imported`。
所以：

- 判断"路由是否生效"要看 **`cordis.patch.yml`**，而不是 `settings.yaml` 是否存在
  （`tools/doctor.mjs` 已按此判定，会打印实际生效位置）
- 保存模型注册后，需要**重启 DSH Desktop** 才会完成导入
- **不要手工编辑 `cordis.patch.yml`**——DSH Desktop 会重写它

## 本机有两套 dsh 运行时

| 路径 | 版本 | 说明 |
|---|---|---|
| `E:\harness\resources\runtime` | 0.2.0-rc.2 | DSH Desktop 自带的 bundled 运行时，**实际在使用** |
| `C:\Users\demo\DeepSeek-Harness\runtime` | 0.1.0-rc.6 | 独立的旧安装 |

**用错那一套排查会得出完全相反的结论。** 实例：`@deepseek-ai/dsh-experimental-agent-team-profile`
在 0.1.0 上装不上（版本断层），在 0.2.0 上则完全正常。

`config.mjs` 已按优先级自动探测（可用 `DSH_RUNTIME` 覆盖），
`tools/doctor.mjs` 会打印当前采用的是哪一套及其版本。

⚠️ **profile 的依赖版本必须与 DSH 对齐**（例如 DSH `0.2.0-rc.2` 对应
`@deepseek-ai/dsh-experimental-agent-team-profile@0.2.0-rc.2`）。装错代次会连
peer 依赖一起错位。

## 判断某个 profile bundle 该怎么装

`bundles` 数组声明 ≠ 依赖已安装，二者是分开的：

- `dsh.profile.bundles` —— 告诉 dsh 要加载哪些 bundle
- `dependencies` —— 决定 pnpm 实际会装什么

因此 `pnpm install` **装不到只在 bundles 里出现的包**，必须显式 `add`：

```cmd
cd /d %USERPROFILE%\.dsh\profiles\desktop
pnpm add <包名>@<与 DSH 版本对齐的版本>
```

装完用 `pnpm peers check` 看 peer 是否满足。注意 **peer 警告不一定是真问题**——
DSH Desktop 的部分 peer（如 `@deepseek-ai/cordis`）由它的 app.asar 在运行时提供，
pnpm 从文件系统看不到，会报 missing。

## 完全重置

桥侧无状态。要回到干净状态：

```cmd
:: 1. 停掉桥与控制台
:: 2. 删除 dsh 侧本项目的配置（会同时删掉你自己加的其它分节，注意备份）
del %USERPROFILE%\.dsh\settings.yaml

:: 3. 从 .credentials.yaml 里删掉 WORKBUDDY_BRIDGE_KEY（该文件还有其它凭据，建议手工编辑）
```

登录文件由 WorkBuddy 客户端管理，**不要手工改动它**——桥对它只读。
