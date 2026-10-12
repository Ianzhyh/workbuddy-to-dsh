# 其他平台接入：审计与补齐路线

审计对象：**「协议兼容」那一档客户端** —— 面板上只出现名字、没有配置片段的那批
（Cherry Studio / NextChat / LobeChat / ChatBox / Open WebUI / Cursor / Trae），
以及它们背后的通用「自定义 OpenAI 兼容提供商」表单路径。

审计日期：2026-10-12 ｜ 审计范围：`dashboard/public/index.html` 的客户端页签渲染
（`clientsChoice === 'other'` 分支、`clientsCheatSheet`）、`dashboard/server.mjs`
的 `/api/clients`、`bridge/workbuddy-bridge.mjs` 的准入与 CORS 行为。

> 本文的每条结论都带**复现或检测方式**。凡是实测过的，都写了当时的真实输出；
> 只靠代码走读得出的，明确标注「未构造复现」。判据照**实测**写，不照"看起来危险"写。
>
> 与 `CLIENT-CONNECT-AUDIT.md`（一键接入链路）的区别：那份管的是**写用户配置文件**
> 这条链路的安全；这份管的是**没被写配置文件的那批客户端能不能用、有没有被如实说明**。

---

## 0. 结论摘要

| 编号 | 问题 | 严重度 | 状态 |
|---|---|---|---|
| P1 | 桥**完全没有 CORS 支持**，浏览器发起的预检死在令牌闸门（实测 401） | 高 | ✅ 已修 |
| P2 | `originAllowed()` 注释承诺「本机网页版客户端照常可用」，代码不兑现 | 高（文档说谎） | ✅ 已修 |
| P3 | 「协议兼容」7 个客户端**只有名字 chip**，没有可复制的配置片段 | 中 | ✅ 已修 |
| P4 | 各客户端**形态未标注**（桌面 / 网页 / 服务端代理）→ 用户不知道自己属于哪一档 | 中 | ✅ 已修 |
| P5 | Open WebUI 这类**服务端代理型**需要的是环境变量，与桌面客户端的表单填法完全不同，却混在一句话里 | 中 | ✅ 已修 |
| P6 | 缺 `…/v1` 结尾的常见踩坑提示（Base URL 该不该带 `/v1`） | 低 | ✅ 已修 |
| P7 | 知识库/RAG 的 501 说明只出现在「不支持」卡片，兼容档位没有交叉引用 | 低 | ✅ 已修 |
| P8 | **`test:bridge` 不是 glob，新增的桥测试文件在 CI 里静默不执行** | 中高（测试覆盖假象） | ✅ 已修 |
| P9 | 桌面客户端卡片**只给 Base URL、不给令牌** —— 用户实测反馈「key 呢」 | 中（可用性） | ✅ 已修 |

---

## 0.1 修复落地与证据（2026-10-12）

**P1/P2 —— 桥侧 CORS**

改动 `bridge/workbuddy-bridge.mjs`：

- 新增 `corsHeaders(req)`：只对 `originAllowed()` 认可的回环 Origin 回显该 Origin，
  附 `Vary: Origin`；**永不 `*`**，**不发 `Allow-Credentials`**。
- 新增 `handlePreflight(req, res)`：`OPTIONS` 且回环 Origin → `204` + 允许的方法/头
  （含 Anthropic 客户端要用的 `anthropic-version` / `anthropic-beta`）+ `Max-Age: 600`。
  调用点在**令牌闸门之前**（预检按规范不带凭证）。
- `observeResponse()` 里统一给**所有**响应注入 CORS 头（含 401 / 403 / 404 / 上游错误）
  —— 放在 8 个响应点共用的 `writeHead` 包装里，逐个改必漏。
  错误响应也要带，否则浏览器读不到那条自诊断文案，用户只会看到「CORS 错误」。

**红先行证据**（`bridge/bridge-cors.test.mjs`，9 例）：

```
修复前（git stash 后跑新测试）：  tests 9 / pass 4 / fail 5
修复后：                          tests 9 / pass 9 / fail 0
```

修复前通过的 4 例是**安全边界**用例（非回环 Origin 不给头、无 `*`、无 `Allow-Credentials`）
—— 这些性质本来就有，改动没有放松它们。

**实测（临时桥，非 127.0.0.1 之外的来源）**：

```
OPTIONS /v1/chat/completions  Origin: http://localhost:3000  →  204
  access-control-allow-origin  = http://localhost:3000
  access-control-allow-methods = GET, POST, OPTIONS
  access-control-allow-headers = Authorization, Content-Type, x-api-key, anthropic-version, anthropic-beta
  access-control-max-age       = 600
无重复头。
```

**P8 —— 测试覆盖假象**

`package.json` 的 `test:bridge` 与 `test:lib` **都是逐个列文件名，都不是 glob**
（旧笔记把它记成 glob，是错的）。新写的 `bridge-cors.test.mjs` 因此**没有进 CI**：
`test:bridge` 仍只报 61 例。已把新文件加进清单，现在报 **70 例**。
`test:plugin` 才是真 glob。**这类缺陷完全静默** —— 本地单独跑全绿，门禁也全绿，
只是那一批用例从来没执行过。

---

## 一、审计方法

1. **对真实桥的 HTTP 探测**（桥在 8790 上真实运行），逐端点、逐方法、带/不带 Origin、
   带/不带令牌，四种组合都跑，看**响应头**而不只看状态码。
2. **代码走读**：准入顺序（`originAllowed` → 令牌 → 路由）、`SECURITY_HEADERS`、
   `§ 端点清单` 全部读完。
3. **对面板渲染的分支走读**：确认「协议兼容」那一档究竟给用户展示了什么。
4. **对官方客户端形态的判断**取明出处（见第三节表格），不凭印象。

---

## 二、核心发现：CORS 缺口（P1 / P2）

### 2.1 实测复现

桥在 8790 上运行，令牌文件 `dsh-plugin/.bridge-token` 存在。

**（a）无凭证的浏览器预检（这是浏览器的真实行为 —— 预检不带 Authorization）**

```
$ curl -s -i -X OPTIONS http://127.0.0.1:8790/v1/chat/completions \
    -H "Origin: http://localhost:3000" \
    -H "Access-Control-Request-Method: POST" \
    -H "Access-Control-Request-Headers: authorization,content-type"

HTTP/1.1 401 Unauthorized
Content-Type: application/json
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
Content-Security-Policy: frame-ancestors 'none'
```

**结论**：预检死在令牌闸门。`Access-Control-Allow-*` 一个都没有。

**（b）带合法令牌的预检（证明 401 确实是闸门造成的，不是唯一障碍）**

```
$ curl -s -i -X OPTIONS http://127.0.0.1:8790/v1/chat/completions \
    -H "Origin: http://localhost:3000" -H "Authorization: Bearer $TOKEN"

HTTP/1.1 404 Not Found
```

**结论**：闸门过了也没用 —— **没有任何 OPTIONS 路由**，落到 404 兜底。预检永远不会成功。

**（c）带合法令牌 + 回环 Origin 的真实 POST（证明请求能到达处理器，但响应会被浏览器丢弃）**

```
$ curl -s -i -X POST http://127.0.0.1:8790/v1/chat/completions \
    -H "Origin: http://localhost:3000" -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" -d '{"model":"x","messages":[]}'

HTTP/1.1 400 Bad Request
Content-Type: application/json
```

**结论**：400 说明请求**确实路由到了处理器**（`originAllowed()` 放行了回环 Origin），
但响应里没有 `Access-Control-Allow-Origin`。浏览器会把这条 400（原本该是 200）
判为 CORS 错误并抛给调用方 —— **桥明明答了，用户看到的是网络错误**。

**（d）全端点扫描：CORS 头数量**

```
$ for m in GET OPTIONS; do for p in /v1/models /v1/chat/completions; do
    echo "$m $p -> $(curl -s -o /dev/null -w '%{http_code}' -X $m http://127.0.0.1:8790$p -H 'Origin: http://localhost:5173')  ACAO=$(curl -s -D - -o /dev/null -X $m http://127.0.0.1:8790$p -H 'Origin: http://localhost:5173' | grep -ci access-control)"
  done; done

GET /v1/models -> 401  ACAO=0
GET /v1/chat/completions -> 401  ACAO=0
OPTIONS /v1/models -> 401  ACAO=0
OPTIONS /v1/chat/completions -> 401  ACAO=0
```

**代码侧佐证**（不是"我没找到"，是"确实没有"）：

```
$ grep -n "Access-Control|ACCESS_CONTROL|OPTIONS" bridge/workbuddy-bridge.mjs
（无匹配）
```

### 2.2 为什么这是**文档说谎**而不只是缺功能（P2）

`bridge/workbuddy-bridge.mjs:3916`，`originAllowed()` 的注释原文：

> 带 Origin 的只放行**回环来源**（**本机网页版客户端照常可用**），其余一律拒绝。

「本机网页版客户端」= 浏览器里跑的页面要去 fetch 桥。而浏览器做这种跨源请求
**必须先过预检**，预检必被 401/404 拦下。也就是说：注释承诺的这条路径
**从来没有可用过**，而它是把 `originAllowed` 写成"放行回环 Origin"的**唯一理由**
—— 若不打算支持浏览器，这个分支根本不需要存在（CLI 和 Electron 主进程都不发 Origin）。

这是本项目反复出现的那类缺陷：**不崩溃、不报错，只是行为和文档不一样**。

### 2.3 但要注意：`CLIENT-CONNECT-AUDIT.md` 曾**依赖**「没有 CORS 头」

同一份文档（第 186 行附近）把"跨站页面读不到响应"当作一条**浏览器侧的安全性质**。
所以加 CORS **改变了威胁模型**，不能顺手加。必须满足：

- 只在**回环 Origin**（`originAllowed` 已有的谓词）上发 `Access-Control-Allow-Origin`，
  **回显该 Origin**（不回显就没用，因为预检是逐 Origin 的）；
- **绝不发 `*`**（那会让任意网页读响应）；
- 绝不加 `Access-Control-Allow-Credentials`（我们不靠 Cookie，不需要，加了徒增风险）；
- 预检处理必须放在**令牌闸门之前**（预检按设计不带凭证，放后面等于没加）。

净效果：非回环来源的跨站页面仍然读不到响应（安全性质保留），
本机网页版客户端变得可用（文档承诺兑现）。这是**收窄而非放宽**。

---

## 三、其他发现（P3–P7）

### P3 「协议兼容」只有名字，没有片段

`index.html:7762`：

```js
for (const n of ['Cherry Studio', 'NextChat', 'LobeChat', 'ChatBox', 'Open WebUI', 'Cursor', 'Trae']) {
  chips.append(clientEl('span', 'clientchip', n));
}
```

对比**已接入**的三档（Codex / Claude Code / opencode）各自有：可复制的真实配置文本、
"写哪个文件/填哪一格"的逐步说明、令牌放哪、改完要不要重启。协议兼容档**一条都没有**。

用户看到 7 个名字之后的下一步是什么？只能去猜「Base URL 填什么、要不要带 /v1、
令牌填哪一格」。而通用表单卡片（`clientsChoice === 'form'`）虽然逐格可复制，
但它**没有说这 7 个客户端各自的下一步**（比如 Open WebUI 根本不是填表单）。

### P4/P5 形态未标注 —— 混了三种完全不同的接法

这是最实际的一个问题。这 7 个客户端按**请求从哪发出**分成三类，接法完全不同：

| 客户端 | 形态 | 请求从哪发 | 会不会碰 CORS | 正确接法 |
|---|---|---|---|---|
| Cherry Studio | Electron 桌面 | 主进程 | 否 | 图形表单：Base URL + 令牌 |
| ChatBox | Electron 桌面（另有 Web 版） | 主进程（桌面）/ 浏览器（Web） | Web 版**会** | 桌面填表单；Web 版需 P1 修好 |
| Cursor | Electron 桌面 | 主进程 | 否 | 表单 + 注意 Agent 模式要工具调用 |
| Trae | Electron 桌面 | 主进程 | 否 | 同上 |
| NextChat | Web 应用（官方亦有桌面版） | 浏览器 / 服务端 | 自部署走服务端则不碰；官方在线版**会** | 自部署改服务端环境变量 |
| LobeChat | Web 应用（可自部署） | 浏览器 / 服务端 | 本地自部署**会** | 环境变量（服务端代理） |
| Open WebUI | **纯 Python 服务端** | **服务端** | **否** | **环境变量**，不是表单 |

结论：**Open WebUI / LobeChat / NextChat 的正确接法是环境变量 + 重启，
根本不该教用户去填图形表单**；而表单卡片现在和它们混在同一句话里。
这一条不修，用户会照表单填、填完不通、然后认为是桥的问题。

### P6 `/v1` 结尾踩坑未提示

`/api/clients` 同时给 `baseUrlOpenAI`（结尾带 `/v1`）和 `baseUrlAnthropic`（不带）。
OpenAI 兼容客户端普遍要求 Base URL **带** `/v1`，但部分客户端（及部分版本）
会自己补 `/v1` —— 用户把带 `/v1` 的粘进去就变成 `/v1/v1/chat/completions`。
现在没有任何提示（走读确认：`index.html` 中无 `/v1/v1` 相关文案）。

### P7 RAG 说明没有交叉引用

501 的解释（写得很好）只挂在「不支持」卡片里；而「协议兼容」档恰恰是**最可能**
去点知识库的一档（Cherry Studio / LobeChat / Open WebUI 都带 RAG）。
两边应该互相指一下。

---

## 四、预期输出成果

按已接入平台同一标准（可复制、如实标注、带复现、红先行），本次交付：

**1. 桥侧：CORS 支持（P1/P2）** —— `bridge/workbuddy-bridge.mjs`

- 新增 OPTIONS 预检处理，置于令牌闸门**之前**；
- 仅对**回环 Origin** 回显 `Access-Control-Allow-Origin`，永不 `*`，不带
  `Allow-Credentials`；
- 实际响应（200/400/…）在回环 Origin 下同样带 CORS 头，否则浏览器仍读不到。

**2. 面板侧：兼容档从「7 个名字」升级为「按形态分档的真指引」（P3–P7）** ——
`dashboard/public/index.html`

- 7 个客户端各自给出**可复制的下一步**，而不是名字；
- 明确标注**形态**（桌面 / 网页 / 服务端）与**该用表单还是环境变量**；
- Open WebUI / LobeChat / NextChat 给**环境变量**片段并说明要重启服务；
- 补 `/v1` 结尾与 RAG 的交叉提示。

**3. 契约与文档同步**

- `tools/dev/api-shape.json`（若 `/api/clients` 形状有变）；
- `docs/CLIENT-PLATFORMS-AUDIT-2026-10-12.md`（本文）落盘，结论带复现；
- `docs/CLIENT-CONNECT-AUDIT.md` 第 186 行附近补一句：CORS 性质已按本节收窄，
  不再是"靠没有头"，而是"靠只回显回环 Origin"。

**4. 测试（红先行）**

- `bridge/bridge-cors.test.mjs`（新）：预检 204/200 且带 ACAO；非回环 Origin 无 ACAO；
  预检**不需要令牌**；真实请求在回环 Origin 下带 ACAO；带 `Allow-Credentials` 为**不存在**。
- 面板：兼容档渲染出 7 条指引（不是 7 个裸名字），含环境变量片段。
- i18n：新增文案的词条 + 规则 + **夹具同步**（`tools/dev/fixtures.mjs`），
  否则 `test-i18n` 的「英文模式无残留中文」扫不到 —— 这是栽过两次的坑。

**5. 全门禁**

`test:lib` / `test:bridge` / `test:plugin` / `test:ui` / `release:check`，
然后 `node dsh-plugin/scripts/vendor.mjs` 同步（桥是双份实现，改一处必须改两处）。

**6. 如实标注的边界**

NextChat / LobeChat / Open WebUI / Cherry Studio / ChatBox / Cursor / Trae
**本机都没装**，所以仍然是「未实测」。本次提升的是**指引起点与正确性**，
不是"已跑通"的结论 —— 标注保持 `未实测`，不含糊。

---

## 五、P9：卡片只给 Base URL，不给令牌（用户实测反馈）

**反馈原话**：「你这不详细啊，key 呢」（附 Trae 卡片截图 —— 卡片里只有一格
`Base URL`，步骤里写着"token 照填"，但**页面上没有任何地方给出这个 token**）。

**根因**：这些卡片是**独立渲染**的，而页面顶部的「API Key / 令牌」值行在
**折叠区**里（`<details>`）。用户在卡片上看不到它，等于让他自己去别处找。
Base URL 与令牌是**一起填进客户端的一对值**，只给一半就是在制造一趟往返。

**修法**：`clientCard()` 增加 `valueRows` 参数（渲染成紧凑的 `clientValueRow`，
而不是代码块 —— 一两行的值套代码块外壳太笨重，且与顶部「三个接入值」的观感不一致）。
每张需要填表单的卡片现在自带**三格**：

| 格 | 值 | 为什么要给 |
|---|---|---|
| Base URL（API 地址） | `d.baseUrlOpenAI` | 客户端的第一栏 |
| API Key / 令牌 | `d.token` | **本次反馈缺的就是这格** |
| 模型名（Model ID） | `d.models[0]` | 客户端第三栏同样要填，不该让用户去别处找 |

覆盖：Cherry Studio / ChatBox / Cursor / Trae / 本地网页版 —— **共 5 张卡片**，
每格都有独立复制按钮。服务端型（Open WebUI 等）走 `openAIEnvText()`，
那段环境变量里本来就含 `OPENAI_API_KEY`。

**红先行证据**（`test-clients-panel.mjs` 新增 12 条断言）：
临时把 `valueRows` 退回「只给 Base URL」，测试报 **8 条红**（每个客户端
「没有令牌」+「没有模型名」各一条）；装回后全绿。

**中途踩的坑（值得记）**：加 `valueRows` 时把网页卡片那次 `clientCard` 调用
**少传了一个 `blocks` 参数**，于是对象落进了 `blockOpts`、值数组落进了
`blocks`，运行时抛 `(blocks || []) is not iterable` —— **整块面板从网页卡片起
整个不渲染**（连带服务端分组、"不支持"档全没了）。
症状很像"环境问题"（缺了一堆元素），实际是一处实参错位。
**记住：位置参数超过 4 个就该考虑改传对象**，这类错误编译器抓不到
（`clientCard` 没有类型标注），只能靠测试渲染出来才发现。
