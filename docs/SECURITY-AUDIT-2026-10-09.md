# 漏洞审计报告（第三轮）— 认证边界与测试盲区

审计日期：2026-10-09
范围：`bridge/`、`dashboard/`、`lib/`、`dsh-plugin/lib/`
方法：4 路并行静态审计 + 本机最小复现（不改代码、不启动服务、不打真实上游）
前置：`.optimize/security-report.md`（2026-10-05，7 项已修）与
`docs/ALGORITHM-REVIEW.md`（算法四轮）。

**本轮定位**：前两轮把「配置注入 / XSS / 路径穿越 / 命令注入 / 凭据落盘」都扫过了，
本轮刻意换一个还没深挖的维度 —— **认证与准入的语义边界**，以及**测试覆盖的盲区**
（哪块代码体量最大、却最少被测试碰到）。

---

## 一、结论先行

| 项 | 结论 |
|---|---|
| **最该先修的地方** | **桥的认证闸门**（`bridge/workbuddy-bridge.mjs`）—— 它是唯一同时满足「体量最大 / 被测试最少 / 后果最重」三项的模块 |
| 最该补测试的地方 | **`lib/state.mjs`**（零直接单测）+ 桥的上游异常路径 |
| 凭据红线 | **成立**（`lib/atrest.mjs` 无落盘、无日志、无外传） |
| 控制台（8792） | 三道防线（Origin / 面板头 / 路径穿越）**均实测有效** |
| 前三轮的修复 | **未见回归**（SEC-01 的模型 id 校验仍在生效） |

核心问题一句话：**桥的认证闸门写成「没配令牌就放行」，而唯一会配令牌的启动路径是控制台；
直接启动桥时是公开默认口令甚至无口令。** 这使桥对「同机任意网页」的实际防护显著弱于
文档自述的强度。

---

## 二、按严重度排序的发现

### P1-1 `[高]` 认证闸门语义：未配置令牌 = 不鉴权

- **位置**：`bridge/workbuddy-bridge.mjs:2743`（闸门）+ `:2646`（无令牌返回 `null`）
- **代码**：
  ```js
  if (LOCAL_TOKEN && token === LOCAL_TOKEN) return 'local';   // :2647
  if (!token) return null;                                     // :2646
  // ...
  if ((LOCAL_TOKEN || CLIENT_KEY_HASHES.size) && identifyClientId(req) === null) return 401; // :2743
  ```
- **触发条件**：`WORKBUDDY_LOCAL_TOKEN` 为空/未设置。
- **影响**：`(LOCAL_TOKEN || CLIENT_KEY_HASHES.size)` 为假 → **401 分支整个不执行**。
  `/health`、`/v1/models`、`/v1/usage`、`/v1/checkin`、`/v1/chat/completions` 全部无鉴权可达。
  叠加 `Origin` 缺失无条件放行（见 P2-1），一条**不带 Origin 的简单请求**即可跨站触发。
- **实测证据**（本机，逻辑等价复现）：
  ```
  200 ALLOWED            <- 无令牌 + 无 Origin + 无 Authorization（恶意网页 text/plain POST）
  401 bad or missing token <- 默认令牌 wb-local-bridge + 无 Origin + 无 Authorization
  ```
- **可达性判定（重要，别高估也别低估）**：
  - 经控制台启动（`启动.cmd` → `bridgeEnv()` 注入默认 `wb-local-bridge`）→ **仍要求令牌**，
    但不是「无鉴权」而是「公开默认口令」，风险等级同为 P1。
  - 直接 `node bridge/workbuddy-bridge.mjs` 或 `npm run bridge` → **真的无鉴权**。
  - 用户显式设了强令牌、且只经控制台启动 → 当前实现是安全的。
- **文档影响**：`docs/SECURITY.md:60` 自述「作用仅是防止同机其它程序**误用**这个回环端口」
  —— 与「公开默认口令 / 无口令」的实际强度不符，属于**安全说明强于实现**。
- **修复方向**：未配置令牌时**自动生成随机令牌**（写入 `.state.json` 或启动时打印），
  而不是静默放行；把闸门改成「令牌始终必需」，并在文档里去掉「默认 wb-local-bridge」。

### P1-2 `[中高]` 客户端可控字段直接落盘 `usage.jsonl`

- **位置**：`bridge/workbuddy-bridge.mjs:1702`（写盘）+ `:2934`（来源）
- **影响**：`model` 等字段来自请求体，超过 200 字符只截断、**不拒绝**，原样进账本。
  虽然不是凭据泄露，但让「本机任意调用方」可以往磁盘写受控内容。
- **缓解**：`MAX_MODEL_ID_LEN = 200`（`:1984`）已限制单行长度，属有界写入。
- **修复方向**：不建议改（截断已有界）；仅建议在 SECURITY.md 记一句「账本含调用方原样字段」。

### P2-1 `[中]` `Origin` 缺失无条件放行 → DNS rebinding 防线失效

- **位置**：`bridge/workbuddy-bridge.mjs:2608`、`dashboard/server.mjs:74`（两处同款）
- **代码**：`if (!origin) return true; // 非浏览器调用`
- **触发条件**：跨站 `POST` + `Content-Type: text/plain`（**简单请求，不触发预检**）。
  浏览器不发 `Origin` 的场景不存在，但**自定义头缺失**时闸门也依赖 `Origin`。
- **影响**：与 P1-1 叠加时，桥所自述的「DNS rebinding 防线」在最常见的直接启动形态下
  不起作用（防线只剩 `Origin`，而它只在浏览器发该头时才有值 —— 实际上浏览器**会**发，
  所以这条单独看是低危，**与 P1-1 组合后才是有效攻击面**）。
- **修复方向**：把「无 Origin」的放行条件收紧为「无 Origin **且** 有合法令牌」。

### P2-2 `[中]` 令牌比较非常量时间

- **位置**：`bridge/workbuddy-bridge.mjs:2647`，`token === LOCAL_TOKEN`
- **实测**：全库 `grep timingSafeEqual` → **0 处**。
- **影响**：理论时序侧信道。本机场景下可被利用性低，但属于「本该做对」的一行。
- **修复方向**：`crypto.timingSafeEqual` + 长度预校验（长度不等直接 false）。

### P2-3 `[低中]` `readStoredAuth()` 有 6 处未被 try 包裹

- **位置**：调用点 `:1048`、`:2066`、`:2397`、`:2750`、`:2850`、`:2880`
  （仅 `:3306` 有 try）
- **重要更正**：`decodeJwt`（`:632`）**内部已有 try/catch**，其超长输入的失败模式是
  OOM 而非可捕获异常，且输入**来自磁盘登录文件、不是 HTTP 输入** ——
  因此**不构成远程可利用的崩溃点**。此项降级为健壮性问题：
  登录文件被损坏/被别的 build 重写时，这些路径会抛到 `handleRequest` 的 catch，
  表现为 500 而非清晰的「凭据异常」提示。
- **实测**：本机 `Buffer.from(64MB base64url).toString('utf8')` → **不抛异常**；
  接近 Node 字符串上限（~512MB）才 `RangeError`，而该规模被桥自身 32MB body 上限挡住。
- **修复方向**：把 `readStoredAuth()` 统一包一层，失败转成明确的 503 + 原因。

### P3 其余（信息/健壮性）

| 项 | 位置 | 说明 |
|---|---|---|
| `.state.json` 写入非原子 | `lib/state.mjs:40` | 缺 temp+rename；中途被杀/磁盘满会损坏，下次静默退回 `{}`（不涉凭据） |
| `upstreamShape` 侦察面 | 桥 `/health` | 泄漏上游目录治理细节（被排除的 id 等），供本机调用方解读 |
| 限流默认全关 | `config.mjs:170` | `rateLimitRpm=0` 且连接池 8 条，无限流即无限流 |
| CSV 导出无公式注入防护 | `client.js:1244` | 导出 CSV 时 `=`/`+` 开头的模型名可能被 Excel 当公式执行 |
| 插件写准入是静态头 | `routes.mjs:54` | `x-workbuddy-panel === '1'` 只防跨站预检，不防本机其它进程 |

---

## 三、测试覆盖盲区（决定「先测哪里」）

| 被测文件 | 行数 | 覆盖印象 | 关键缺口 |
|---|---|---|---|
| `lib/state.mjs` | 64 | **~5%，零直接单测** | 并发写、被篡改、损坏回退 —— 全无 |
| `bridge/workbuddy-bridge.mjs` | 3344 | 主路径很好（21 用例 / 10 路由全打到） | **上游超时、上游非 JSON、SSE 中间切断、`shortError` 截断、usage/credit 的 NaN** |
| `dashboard/server.mjs` | 1290 | 中 | `killPid` 失败、端口占用、桥起不来/停不掉 |
| `dsh-plugin/lib/client.js` | 3272 | 打桩型 UI 用例覆盖 | 无真实交互路径 |
| `config.mjs` | 268 | 低 | 路径兜底、env 非法值 |
| `lib/atrest.mjs` | 210 | 低 | 多候选 keyId 匹配、解密失败分支 |

**已核实「桥主路径覆盖良好」**（避免重复排查）：401/403、413 超限、Origin 拒绝、
客户端 abort、流中断记失败、账本隔离、限流两种模式、畸形 Host 回 400 —— 均有对应用例。

### 测试方法论上的两个真实缺陷

1. **夹具永远注入了令牌**（`bridge/bridge.test.mjs:88` 固定传 `WORKBUDDY_LOCAL_TOKEN: TOKEN`）。
   因此「没配令牌」这条**默认路径从未被测过** —— 这正是 P1-1 能长期存在的原因。
   **补测方式**：加一条 `WORKBUDDY_LOCAL_TOKEN: ''` 的用例，断言「未配置令牌时行为明确」
   （无论定为拒绝还是随机生成，都要有用例钉住）。
2. **两套高价值边界用例不在发版链里**：`tools/dev/test-console-edges.mjs` 与
   `tools/dev/probe-bridge-edges.mjs` 未进 `package.json` 的 `release:check`
   （`scripts:47-57`），CI 不会跑。

### 补测优先级（体量 × 无测试分支 × 后果）

1. **`lib/state.mjs`** —— 64 行零单测，且是账号/签到/体检三类状态的落盘点。
2. **桥的上游异常路径** —— 3344 行里最厚的一块无覆盖区（超时/非 JSON/半截 SSE）。
3. **`shortError` + usage/credit 的数值边界** —— 直接影响诊断可信度与账本正确性。
4. **`killPid` / 启停失败** —— 控制台「停不掉桥」是用户可感知的最糟体验之一。
5. **`config.mjs` 兜底 + `atrest` 多候选派生** —— 换机器/换 build 时的第一道坎。

---

## 四、已核实「无问题」的项（避免重复劳动）

| 方向 | 结论与证据 |
|---|---|
| 凭据红线（不落盘/不日志/不外传） | `lib/atrest.mjs` 全文无写文件、无 console 输出；密钥与明文仅驻内存 Map/Buffer；解密错误只含派生 keyId，不含密钥材料；`execFile` 参数数组无 shell |
| 路径穿越 | **实测 10 组 payload**：`/../`、`%2e%2e`、`..%5c`、双编码、`//` 全部 403/404；`resolve` 在前缀比较之前，`.bak`/点文件另拒 |
| 命令注入 | 所有 `spawn/spawnSync` 用参数数组、无 `shell:true`；`taskkill -F -PID <int>`；无可注入点 |
| 原型污染 | **实测** `{"__proto__":{...}}` 经 `merged["__proto__"]=raw` 赋值 → `Object.prototype` **未被污染**（括号赋值走 defineOwnProperty，不触发 setter） |
| SSRF | 出站 URL 全部来自配置或令牌自身域名声明，无「由请求参数决定目标」的接口 |
| XSS（控制台前端） | 唯一转义助手 `escapeAttr`（`:2459`）覆盖 `& " ' < >`；61 处调用；日志面板用 `textContent` |
| SEC-01 回归 | `lib/dsh.mjs:260` `writeRegistration` 仍先卡 `invalidModelIds` 再写 YAML —— 已修项未回归 |
| 请求体上限 | 桥 32MB、控制台 512KB、插件 64KB；超限走明确的 413 JSON（非 RST） |
| 跨站防护（控制台） | 三道防线顺序正确：Origin → 面板头 → 路由，均在三类副作用之前 |
| 安全响应头 | `nosniff` / `frame-ancestors 'none'` / `no-referrer` 覆盖 JSON 与静态资源 |

---

## 五、建议的动作顺序

1. **修 P1-1**（认证闸门）：未配置令牌 → 随机生成而非静默放行；同步更新
   `docs/SECURITY.md` 与 README 的「默认 `wb-local-bridge`」措辞。
2. **配 P1-1 的测试**：`WORKBUDDY_LOCAL_TOKEN: ''` 用例，先红后绿。
3. **修 P2-2**（`timingSafeEqual`），一行改动。
4. **补 `lib/state.mjs` 单测**（并发写 / 篡改 / 损坏），并考虑 temp+rename 原子写。
5. **把两套边界用例接进 `release:check`**。

> 未修改任何生产代码；`.backup/` 下已留 9 份审计前快照（`*.pre-audit-20261009`）。

---

## 六、修复记录（同日完成，与本文档同批）

> 本节由修复实现者补写。第 1–5 节保持审计当时的原始观察不改，
> 以便对照「审计结论 → 实际修复」的差异。

### P1-1 认证闸门 —— 已修

- **改法**：`WORKBUDDY_LOCAL_TOKEN` 未配置时 `randomBytes(24).toString('base64url')`
  自动生成，并把值打印到启动日志（前缀 `WORKBUDDY_LOCAL_TOKEN=`）。
  闸门简化为**无条件要求令牌**，删掉了「未配即放行」这条分支。
- **落地范围（三处，缺一不可）**：
  | 位置 | 作用 |
  |---|---|
  | `bridge/workbuddy-bridge.mjs` | 桥自身：生成 + 始终校验 |
  | `config.mjs` | 控制台拉起桥时注入的值；首次随机生成 → 落盘 `dsh-plugin/.bridge-token` |
  | `dsh-plugin/lib/index.js` | 插件拉起桥时注入的值；读同一个落盘文件 |
- **为什么必须三处联动**：控制台与插件都可能拉起桥。任一处各生成各的，
  就会出现「插件起的桥用令牌 A、控制台拿 B 去调 → 401」这种两边都自认正常的故障。
  已实测：仓库检出与 vendor 分发两种形态、控制台与插件两个入口，
  **四路取到同一个令牌**。
- **路径坑（本次踩到并修掉）**：`config.mjs` 被 vendor 脚本拷进
  `dsh-plugin/vendor/`，`ROOT` 随之变成 vendor 目录。若按 `ROOT/dsh-plugin/…`
  拼路径会落到 `vendor/dsh-plugin/…`，与插件的令牌文件**不是同一个**。
  按「父目录是否有 `lib/index.js`」判形态，两种布局都归到同一个文件。
- **`.gitignore` 补漏**：`.bridge-token` 初版漏了排除（已补）。
  它是本机凭据，提交上去等于把所有人的口令公开。

### P2-2 令牌比较改常数时间 —— 已修

`safeEqual()` 包 `timingSafeEqual`（先比长度，长度不同直接 false）。
`identifyClientId` 与客户端 key 哈希比较均改用它，消除按字节短路带来的前缀时序侧信道。

### 新增：上游 401 导致请求永久挂死（审计未发现，写测试时挖出）

- **现象**：上游返回非 2xx（实测 401 + 一段 HTML）时，桥**永不响应**，
  客户端只看到自己的超时。
- **根因**：`shimResponse.text()` 是事件式的（`res.on('data'|'end')`）。真实调用链里
  响应回到 `callUpstream` 后，还要先等 `refreshAuth`（失败路径有 8 秒超时）
  才轮到读体；这期间无人监听，`IncomingMessage` 是**热**流、不缓存，
  等轮到读时已 `complete && destroyed`，事件**永远不会再触发** →
  `text()` 永久 pending。
- **定位证据**（临时插桩，已移除）：
  ```
  [TRACE shim] text() attaching; readable= false complete= true destroyed= true
  ```
- **改法**：`shimResponse` 在响应到达的那一刻就挂监听并攒缓冲，
  `text()` 与 `body` 都基于缓冲 + `finished` promise；补 `close` 兜底
  （未等到 `end` 就 close = 连接被掐，立即以错误结束，不再永久 pending）。
- **效果**：同一复现场景从「30 秒超时无响应」变为 **33ms 返回 401**。

### 账本错误原文在写入侧截断 —— 已修

`recordRequest` 入口统一 `shortError(entry.error)`（压平换行 + 截到 160 字符）。
原先只在**读取**侧截断，写入侧原样落盘 —— 上游一段 4KB 的 HTML 错误页会整段
灌进 `usage.jsonl`，撑爆控制台列表与 CSV 导出，且真正有用的信息被淹没。
放在入口而非各调用点：调用点有十来处，漏一处就是一个新漏口。

### `lib/state.mjs` 原子写 —— 已修

`writeState` 改为先写 `.tmp` 再 `rename`（同目录 rename 在 Windows 上也是原子的），
失败时清掉残留 `.tmp`。配合新增的 `lib/state.test.mjs`（7 例）覆盖
往返 / 合并语义 / 损坏回退 / 非对象回退 / 原子性 / `clearState` / `effectiveAuthFile`。

### 测试补齐

| 文件 | 变化 |
|---|---|
| `bridge/bridge.test.mjs` | +3 例：未配令牌不得放行、自动生成令牌必须打印、脏 usage 不落 NaN；+1 例上游超长错误原文截断（**就是它挖出了挂死 bug**）；改 1 例（拒绝外来 Origin，原用例依赖旧的无凭证 200 契约） |
| `lib/state.test.mjs` | 新建，7 例 |
| `package.json` | `test:lib` 纳入 `lib/state.test.mjs` |

### 回归结果（`release:check` 等价命令全跑）

```
vendor:check   ✅ 17 个文件一致
check:types    ✅ exit 0
lint           ✅ exit 0
test:lib       ✅ 21/21
test:plugin    ✅ 79/79
bridge 合约     ✅ 27/27
verify:standalone ✅ 独立分发包演练全部通过
```

### 仍未做（如实记录）

- `tools/dev/test-console-edges.mjs` / `tools/dev/probe-bridge-edges.mjs` 尚未接进
  `release:check` —— 两者是开发期脚本，接进去要先确认运行时长与幂等性。
- P2-1（`Origin` 缺失无条件放行）**故意保留**：非浏览器客户端不带 `Origin`，
  一律拒绝会破坏所有 CLI 工具。真正的准入由 P1-1 的令牌承担，
  这条只防浏览器，已在 `docs/SECURITY.md` 写明「三条同时成立才算安全」。
- P2-3（未加保护的 `readStoredAuth()`）未动：其输入来自磁盘而非 HTTP，
  改动收益低于风险。

---

## 七、第四轮：按「补测优先级」继续下钻（同日）

第三轮末尾列了 5 条补测优先级。第 1 条（`lib/state.mjs`）与第 2/3 条
（上游异常路径、`shortError`）已在第六节修完。**第 4 条「`killPid` / 启停失败」
本轮下钻，挖出一个 P1。**

### P1-3 `[高]` 控制台可强杀端口上的**任意**进程（无归属校验）

- **位置**：`dashboard/server.mjs` 的 `stopBridge()` → `killPid()`
- **原代码**：
  ```js
  function stopBridge(port = config.bridge.port) {
    const pid = findPortPid(port);          // 只是"谁在监听这个端口"
    if (!pid) return { stopped: false, error: `端口 ${port} 上没有监听进程` };
    return killPid(pid);                    // → taskkill /F /PID <那个 pid>
  }
  ```
- **问题**：`findPortPid` 回答的是「谁在监听 8790」，**不等于「谁是我们的桥」**。
  8790 被用户自己另起的服务（另一个 node、开发服务器、别的工具）占用是常见情况，
  此时点「停止桥服务」= **强杀一个与 workbuddy 毫无关系的进程**，且无任何确认。
- **实测证据**（本机起一个无关 HTTP 服务占住 18790）：
  ```
  无辜进程 pid = 6780 监听 127.0.0.1:18790
  parsePortPid 找到的 pid = 6780
  ❌ 控制台会把这个无关进程当成桥并 taskkill /F 杀掉 —— 无任何归属校验
  ```
- **为什么长期没被发现（关键）**：`dsh-plugin/tests/consoleStop.test.mjs` 里有一条用例
  **把这个错误行为当成了期望**——它用 `_holder.mjs` 起一个非桥进程，
  然后断言"必须把它停掉"。测试固化了缺陷。
  该用例写于「防误杀」这件事还没被提出来的时期，且文件头部的长注释
  专门讲了"监听者必须是独立子进程，别改回去"，**却没人问过那个监听者是不是桥**。
- **对照**：dsh 插件的 `BridgeSupervisor.probe()` 一直有 `state:'foreign'` 判定，
  认不出是自己人就绝不 kill。控制台这条路径缺了同一道校验 —— 两边行为不一致。
- **修复**：
  1. 新增 `isOurBridge(port)`：打 `/health`，判据与插件的 `probe()` 对齐
     （`ok === true` 且 `pid` 是数字），返回**三态** true/false/undefined。
  2. `stopBridge` 改为异步，只放行 `owner === true` 一种情况。
  3. **401 单独判为「是自己的桥」**：那说明桥活着、只是令牌不一致，
     若一律当"不是桥"，用户会看到**假的**诊断（"端口上那个不是 bridge"），
     且想停掉自己人反而停不了。
  4. `undefined`（探测超时/连不上）拒绝 kill 但**不说"不是桥"**，
     而是如实说"无法确认"——两者对用户是不同的事。
- **修的过程中自己踩的坑（值得记下来）**：第一版判据写成
  `return body && body.ok === true && typeof body.pid === 'number'`，
  `body` 为 `null` 时 `&&` **返回 null 本身**，而调用方用 `owner === false` 判定，
  不成立 → 直接掉进 `killPid`，**校验静默失效**（测试如实变红抓到了）。
  已改为显式布尔，并把调用方改成**正向放行**（`if (owner !== true) reject`）——
  依赖"否定条件都过完才放行"的守卫，一旦返回值出现第四种形态就静默失效。

### 测试

`dsh-plugin/tests/consoleStop.test.mjs` 3 → **6** 例：

| 用例 | 作用 |
|---|---|
| 拒绝 kill 无关进程时返回结构仍稳定 | 原用例改写（语义随校验引入而变），钉住返回形状 |
| 失败路径的返回必须干净 | 断言无多余字段 |
| **端口上不是桥时必须拒绝 kill** | 新增，红→绿；并断言无关进程**仍活着** |
| **端口上是真桥时仍能停掉** | 新增，防"为安全把功能一起砍掉" |
| **401 不等于"不是桥"** | 新增，防令牌不一致时误报 |

新增两个夹具：`_bridgeHolder.mjs`（像桥的进程）、`_auth401Holder.mjs`
（一律 401 的进程）。原 `_holder.mjs` 继续扮演"无关进程"。

### 回归

```
vendor:check ✅   check:types ✅   lint ✅
bridge 29/29 ✅   test:plugin 82/82 ✅   test:lib 21/21 ✅
verify:standalone ✅
```

### 仍未下钻

补测优先级第 5 条（`config.mjs` 兜底 + `atrest` 多候选派生）已在第五轮完成，见下节。

---

## 八、第五轮：凭据红线核心 + 配置真源（同日）

对象是「补测优先级」里排最后、但**后果最重**的两块：`lib/atrest.mjs`
（211 行，凭据解密的全部逻辑，此前**零直接单测**）与 `config.mjs`
（全项目唯一配置真源，同样零单测）。二者都不面向外部输入，因此不是「可被攻击的
入口」，而是**出错时用户最看不出来**的地方 —— 这一轮找到的四个缺陷全部属于
「静默失效」类：不报错、不崩溃，只是行为和用户以为的不一样。

### P2-4 `[中]` 非法数值型环境变量静默变成 `NaN`

**症状**：`.env` 里写 `WORKBUDDY_PORT=879O`（字母 O）、`WORKBUDDY_TIMEOUT_MS=8790ms`、
`DASHBOARD_PORT=8792 `（多一个空格）这类手滑，`Number()` 得到 `NaN` 并被**原样**
放进配置对象。后果是一串看不出根因的现象：

| 变量 | `=abc` 时旧行为 | 实际后果 |
| --- | --- | --- |
| `WORKBUDDY_PORT` | `NaN` | `listen(NaN)` 报 errno；派生 URL 变成 `http://127.0.0.1:NaN` |
| `DASHBOARD_PORT` | `NaN` | 同上，控制台打不开 |
| `WORKBUDDY_TIMEOUT_MS` | `NaN` | **比不设更糟**：`setTimeout(NaN)` 立即触发 → 每个请求秒失败 |
| `WORKBUDDY_QUOTA_TTL_MS` | `NaN` | 缓存永不命中（或永不过期，取决于比较方向） |

值得记一笔的是：`activeAlertMs` 与两个 `rateLimit*` **原本就有** `Math.max(...) || 默认`
保护，而**真正影响请求处理的 `upstreamTimeoutMs` 反而没有** —— 防御写在了看起来
危险的地方，而不是真正危险的地方。

**修复**：`config.mjs` 新增 `numEnv(name, fallback, {min, max, integer})` 与
`portEnv()`，所有数值型变量统一收口。规则：非有限数 → 默认；越界 → 默认
（**不截断到边界** —— 端口写 99999 显然是写错了，静默改成 65535 会让用户以为生效了）；
`integer: true` 时截断小数。

**验证**（红→绿）：`lib/config.test.mjs` 10 个用例，覆盖 NaN / 空白 / `8790ms` /
负数 / 小数 / 越界 / 边界值（1 与 65535 必须原样保留）。

### P2-5 `[中]` `.env` 里的 `export KEY=VALUE` 被静默忽略

**症状**：`.env` 与 shell 脚本写法相近，用户从 README 或别处粘一行
`export WORKBUDDY_PORT=8901` 进来，旧解析器 `line.indexOf('=')` 得到的键名是
`"export WORKBUDDY_PORT"` —— 配置**完全不生效**，且没有任何提示。用户以为端口改了，
实际还在 8790。这类「配置不生效」是最难自查的问题之一。

**修复**：解析前 `line.replace(/^export\s+/u, '')`。

**验证**：新增用例造一个「迷你仓库」（拷 `config.mjs` + `lib/` + `.env`），
因为 `config.mjs` 从**自身所在目录**读 `.env`，无法用环境变量重定向 ——
这本身也是它的一个可测性限制，但改为可配置的 `.env` 路径属于功能变更，不动。

### P2-6 `[低]` 坏信封把 `JSON.parse` 原文（含文件乱码字节）漏进用户界面

**症状**：`envelopeKeyId()` 与 `openEncryptedField()` 各自直接
`JSON.parse(Buffer.from(envelope,'base64').toString('utf8'))`。登录文件被外部改坏时，
抛出的信息长这样：

```
Unexpected token '\ufffd', "\ufffd\ufffd~m\u2026" is not valid JSON
```

这行字会被 `lib/diagnostics.mjs` **原样**放进「为什么不工作」面板 —— 用户看不懂，
而且把其文件里的字节贴到了界面上。两处调用点都有 `try/catch`，所以不是崩溃问题，
是**可诊断性**问题（本轮反复出现的主题：曾定下「改用户已填进客户端的东西时必须
给自诊断路径」）。

**修复**：抽出 `decodeEnvelope()` 统一收口，两类失败分别给
`envelope is not valid base64` / `envelope is not a JSON record`，
并顺带挡住 `null` / 数组这类合法 JSON 但不是记录的情况。

### P2-7 `[低]` 多 build 选钥逻辑不可单测（重构）

`fetchKeyFor()` 把「遍历候选取载荷」与「按 keyId 挑选」揉在一个函数里，
而取载荷要 `execFile` 真客户端，导致选择规则**无法直接测**。
机器上并存两个客户端 build 时选错钥的症状是 `envelope belongs to key X, not Y` ——
正是最该被测试钉住的分支。

**修复**：拆出纯函数 `pickKeyCandidate(entries, targetKeyId)`（连同
`KeyCandidate` / `FailedCandidate` 类型定义），`fetchKeyFor` 只负责收集 entries。
行为**不变**，含那条刻意的设计：有基准但全不匹配时**退回第一个成功的**而不抛错 ——
这样上层 `openEncryptedField` 才能报出 `envelope belongs to key X, not Y`，
用户看得出是「装了两个客户端」；在这里改报「没有匹配的客户端」会吞掉这个信号。

**验证**：8 个纯函数用例 + 1 个集成用例（候选 exe 不存在时错误信息必须含真实原因）。

> 过程中试过用 `.cmd` 垫片冒充客户端可执行文件，实测在 Node ≥18 下
> `execFile` 对 `.cmd`/`.bat` 直接抛 `spawn EINVAL`（CVE-2024-27980 的修法），
> 该路线不通 —— 这也是最终选择「拆纯函数」而非「造假可执行文件」的直接原因。

### P2-8 `[高]` 同一类缺陷在**桥本身**更严重：`MAX_BODY_BYTES=NaN` 让请求体上限静默消失

修完 `config.mjs` 后做端到端验证（`WORKBUDDY_PORT=879O node bridge/workbuddy-bridge.mjs`），
发现桥**仍然崩**：

```
RangeError [ERR_SOCKET_BAD_PORT]: options.port should be >= 0 and < 65536.
    at Server.listen (node:net:2091:5)
```

原因是桥刻意保持**单文件自包含**，不 import `config.mjs`，自己读 `process.env`：

```js
const PORT = Number(process.env.WORKBUDDY_PORT || 8790);   // 旧
```

顺藤摸瓜把桥里**所有**同类读法都查了一遍，共 9 处。其中一处是**安全相关**的：

```js
const MAX_BODY_BYTES = Number(process.env.WORKBUDDY_MAX_BODY_BYTES || 32*1024*1024);
```

一旦被写成非数值，`MAX_BODY_BYTES = NaN`，而 `readBody` 里是

```js
if (size > limit) { /* 413 */ }
```

`size > NaN` **恒为 false** → 请求体大小限制**完全消失**，同机任何进程都能灌爆内存。
这比端口那条要紧得多：端口写错是"起不来"（明显故障），这个写错是"看起来一切正常"。

**修复**：桥内联一份 `numEnv()`（与 `config.mjs` 同款，注释里写明两处要同步 ——
和 exe 探测那对副本同一约定），9 处数值读取全部收口。

**回归测试**：新建 `bridge/bridge-startup.test.mjs`（4 例）。为什么单开文件：
`bridge.test.mjs` 的 `startBridge()` 总是注入**合法**端口，所以「参数写错」这条路径
在该文件里永远走不到 —— 正是当年「未配令牌即放行」能长期潜伏的同一类盲区
（夹具把输入都摆成正的，负路径没人走）。

其中 `MAX_BODY_BYTES` 那条用例**验证过会先变红**：把实现换回旧写法后
`# pass 0 / # fail 1`，恢复后转绿 —— 不是"写来陪跑"的断言。

已接入 `npm run release:check`（新增 `test:bridge` 步骤，29+4 = 33 例）。

> **踩坑记录（第二次）**：这个测试文件的第一版是**假绿**。`waitReady()` 只判
> `status > 0`，而本机 8790 上正好跑着一个真桥（用户的控制台起的），它回 401 ——
> 于是"被测进程崩了"也照样判定就绪。改成必须 `200` + 自己的令牌后才变红。
> 与第四轮 `consoleStop.test.mjs` 把误杀写成期望是同一类错误：
> **断言必须描述我们自己那个对象的行为，不能描述"端口上有人应答"。**

### 回归结果

```
vendor:check ✅   check:types ✅   lint ✅
test:lib 49/49 ✅ (+28)   test:bridge 33/33 ✅（29+4）   test:plugin 82/82 ✅
verify:standalone ✅（14 项独立分发演练全过）
```

`test:lib` 从 21 涨到 49：新增 `lib/atrest.test.mjs`（17）、`lib/config.test.mjs`（11），
两个文件均已接入 `npm run test:lib`。
`test:bridge` 是**新增的 release:check 步骤**（原先桥测试没被 CI 链覆盖到）：
`bridge/bridge.test.mjs`（29）+ `bridge/bridge-startup.test.mjs`（4）。

### 仍未下钻（如实记录）

- `fetchKeyPayload` 的**超时**分支（`KEY_FETCH_TIMEOUT_MS = 20000`）没有直接用例 ——
  测它需要真等 20 秒或有办法覆盖常量，代价不成比例；目前的保护是
  `execFile` 的 `timeout` 选项本身 + 失败不写缓存（后者已测）。
- `defaultExecutableCandidates()` 的 PowerShell 兜底分支未测（冷启动数秒，
  且依赖本机装的客户端）。
- 第四轮的 P2-1（`originAllowed` 放行无 Origin 请求）与 P2-3（`readStoredAuth` 无守卫）
  仍**刻意保留**，理由见各自条目。
- `tools/dev/test-console-edges.mjs` 与 `tools/dev/probe-bridge-edges.mjs`
  仍未接入 `release:check`。
