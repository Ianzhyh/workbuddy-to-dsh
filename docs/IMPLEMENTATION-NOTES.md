# 实现记录（初版）

> **说明**：本文是项目落地当天的实现记录，保留下来作为决策依据与踩坑档案。
> 文中出现的路径（如 `workbuddy-bridge/`、`tools/wb-atrest.mjs`）是重组前的旧结构，
> **当前结构以 [`README.md`](../README.md) 为准**：
>
> | 旧路径 | 现路径 |
> |---|---|
> | `workbuddy-bridge/workbuddy-bridge.mjs` | `bridge/workbuddy-bridge.mjs` |
> | `workbuddy-bridge/start-bridge.cmd` | `bridge/start-bridge.cmd` |
> | `tools/wb-atrest.mjs` | `lib/atrest.mjs` |
> | 旧版的控制台启动脚本（dashboard 目录下） | `启动.cmd`（macOS / Linux 为 `scripts/start.sh`） |
> | `workbuddy-to-dsh.md` | `docs/IMPLEMENTATION-NOTES.md`（本文件） |
>
> 面向使用的说明请看 [`README.md`](../README.md) 与
> [`docs/ARCHITECTURE.md`](ARCHITECTURE.md)。

---

# 把 WorkBuddy 的模型中转给 DeepSeek Harness

**结论**：可以，已在本机跑通。WorkBuddy 的上游后端本身即讲 OpenAI 协议，本机 `dsh-llm-pi-ai` 插件支持手工声明 OpenAI 兼容路由，中间只缺一个"解密 + 转发"的本地桥。

---

## 1. 为什么不能直接用现成方案

调研了三个现成项目，两个都栽在同一个原因上：

| 方案 | 结论 | 原因 |
|---|---|---|
| `lg22-long/workbuddy-bridge` | 可直接用，但需改造 | 与 WorkBuddy 5.6+ 的加密凭据**不兼容**（见下） |
| `XDTrees/dsh-workbuddy-xdpool` | **装不上** | 要求 `dsh-llm >= 0.1.1-rc.2`，本机是 `0.1.0-rc.6`；且本机 dsh 由 DSH Desktop 管理，不宜手改 |
| `owenisas/workbuddy-openai` | 未采用 | 需独立浏览器 OAuth，且面向 Hermes/OpenCode |

### 根本障碍：AtRest 加密

WorkBuddy 桌面端自 **5.6.0 起强制开启 AtRest 加密**，把登录文件里的 `accessToken` / `refreshToken` 从明文 JWT 改成 AES-256-GCM 信封：

```json
"accessToken": { "$wbEncrypted": 1, "envelope": "<base64>" }
```

而解密密钥**不落盘**，只通过客户端自己的 Electron 原生绑定暴露。所有进程外的旧工具因此全线失效——`workbuddy-bridge` 会拼出 `Bearer [object Object]`，被上游 APISIX 网关以 401 拒绝。上游官方仓库也记录了该"功能回归"。

---

## 2. 实际链路

```
任意 OpenAI 客户端 / dsh
   │  POST http://127.0.0.1:8790/v1/chat/completions
   ▼
workbuddy-bridge.mjs            ← 已改造，新增 at-rest 解密层
   │  1. 问 WorkBuddy.exe 要字段密钥（缓存）
   │  2. AES-256-GCM 解开 accessToken / refreshToken
   │  3. developer → system 角色重写 + 非流式转流式聚合
   ▼
copilot.tencent.com/v2/chat/completions
```

### 密钥是怎么拿到的

以 `ELECTRON_RUN_AS_NODE=1` 启动 `WorkBuddy.exe`，调用它自己的原生绑定：

```js
process._linkedBinding('electron_browser_workbuddy_storage').loggerGet()
```

返回 `{version, atRestSecretKey, atRestDeveloperPublicKey}`。随后：

- `key   = SHA256(atRestSecretKey)`            （哈希的是 base64 字符串本身，不是解码后的字节）
- `keyId = SHA256(key).hex()[0:16]`            （必须与信封里的 `keyId` 一致，否则报错而不是解出垃圾）
- 解密   = `AES-256-GCM`，AAD 转录格式为
  `"WB-AAD\0" | 0x01 | "WBEV1" | "sym-v1" | uint32(suite) | lenPrefixed(keyId) | 0x02 | 0x00 | 0x00`

实测派生出的 `keyId = 9127dea1b44020a7`，与本机 `~/.workbuddy/keyblob` 里记录的 `protectorKeyId` 完全一致，交叉验证通过。

**没有任何密钥被写进代码或磁盘**，每次都是从写这个文件的那个客户端现取的。

---

## 3. 本机已完成的改动

| 文件 | 改动 |
|---|---|
| `workbuddy-bridge/workbuddy-bridge.mjs` | ① 新增 at-rest 解密模块（含密钥缓存）<br>② 凭据读取透明支持信封格式<br>③ **阻止明文回写**，避免破坏客户端的加密凭据存储<br>④ 刷新后的令牌留在内存，不回写文件<br>⑤ 密钥获取用 `spawnSync` + `stdin: ignore` |
| `workbuddy-bridge/start-bridge.cmd` | 新增启动脚本（已固定 auth 文件路径） |
| `~/.dsh/settings.yaml` | **新建**，定义 `llm-pi-ai` 的 `workbuddy` 路由 |
| `~/.dsh/.credentials.yaml` | 追加 `WORKBUDDY_BRIDGE_KEY`（已备份为 `.bak-20261003-201424`） |

### 五个必须绕过的坑

1. **登录文件有两个**，`workbuddy-desktop-ai.info`（另一账号，9-28）会因目录顺序被优先选中 → 必须显式指定 `WORKBUDDY_AUTH_FILE`。
2. **上游拒绝非流式请求**（`400 code 11101`）→ 桥内部转流式再聚合。
3. **`developer` 角色不被识别**（`400 code 11128`）→ 重写为 `system`，已实测生效。
4. **UA 必须伪装成官方客户端** → 桥已内置，这是最易随上游更新失效的一环。
5. **`execFileSync` 会 EBUSY** → 必须用 `spawnSync` 且 `stdio: ['ignore','pipe','pipe']`；为 stdin 开管道会让 Electron 二进制直接失败。

---

## 4. 使用

```cmd
:: 1. 先起桥（保持窗口开着，或设为开机自启）
E:\workbuddy\2026-10-03-20-02-25\workbuddy-bridge\start-bridge.cmd

:: 2. 自检
curl -H "Authorization: Bearer $WB_TOKEN" http://127.0.0.1:8790/health
```

然后在 DSH 的设置 → 模型 页面里，`WorkBuddy` 分组下会出现三个模型：

| 模型 id | 上下文 | 最大输出 |
|---|---|---|
| `deepseek-v4.1-flash` | 1,000,000 | 128,000 |
| `deepseek-v4-pro` | 1,000,000 | 50,000 |
| `glm-5.3` | 1,000,000 | 48,000 |

`settings.yaml` 是热重载的。桥必须先起来，否则请求会以连接失败告终。

---

## 5. 待处理：desktop profile 缺少一个 bundle

`~/.dsh/profiles/desktop/package.json` 的 `bundles` 里列了 `@deepseek-ai/dsh-experimental-agent-team-profile`，但**该包未安装**，导致 profile 组合失败：

```
Error: dsh: cannot resolve profile bundle "@deepseek-ai/dsh-experimental-agent-team-profile"
```

该包在 npm 上存在（latest `0.1.5-alpha.2`），补装即可：

```cmd
node C:\Users\demo\DeepSeek-Harness\runtime\node_modules\@deepseek-ai\dsh\lib\bin.js plugin --profile desktop install
```

注意该 `package.json` 在 20:10 被外部修改过（推测是 DSH Desktop 或专家团队功能写入的），如非本意也可直接从 `bundles` 数组里删掉这一行。

---

## 6. 风险与限制

- **非官方路径**。WorkBuddy 随时可能改协议或封禁，可用性无保证。团队或商用场景应申请官方 API。
- **凭据归属**：桥只驱动**你自己已登录**的账号，不绕过任何鉴权，也不内置密钥。
- **不要绑 `0.0.0.0`**——那等于把订阅暴露给整个局域网。当前仅绑 `127.0.0.1`。
- **令牌有效期 45 天**（`expiresIn = 3888000`）。桌面端自己会续期，桥每次请求都重读并解密文件，所以只要客户端在正常使用就不需要额外维护。桥自身的刷新结果只留内存，不写盘。
- **改动了 WorkBuddy 的登录文件目录吗？** 没有。桥对它只读。

---

## 7. 排查

| 现象 | 原因 |
|---|---|
| `ok:false` + `key fetch failed` | WorkBuddy 未安装/路径变了 → 设 `WORKBUDDY_APP_EXECUTABLE` |
| `envelope belongs to key ...` | 登录文件不是本机这个 build 写的，或装了国际版/国内版两个客户端 |
| `401 Authorization Required` | 令牌失效 → 在桌面端重新登录 |
| `spawnSync ... EBUSY` | 误把 `stdio` 改回了默认值 |
| 模型列表里没有 WorkBuddy | 桥没起，或 `settings.yaml` 未被加载（检查 YAML 缩进） |
