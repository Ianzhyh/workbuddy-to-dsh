# 文生视频 / 图生视频接入说明

> 结论：WorkBuddy 桌面端自带的 Miora 视频能力（文生视频、首帧/尾帧、参考图）可以由本桥
> 直接调用，不需要模拟客户端界面。桥暴露 `POST /v1/videos`、`GET /v1/videos/{id}` 与
> `GET /v1/videos/{id}/content`。
>
> 实测（2026-10-25）：现有桌面登录态可以换到 Miora 临时 key，已通过桥真实生成一条
> 4 秒 / 768P 文生视频（`minimax-h3-iOA`，101 秒出片，MP4 可播放）。同日的加固轮
> **没有重复发起真机出片**（避免无谓计费）；本轮改动由三套桩测试与真机桥合约测试验证，
> 上游行为沿用同日实测结论，逐项标注见文末「实测记录」。

## 1. 上游链路（从客户端资源反查）

WorkBuddy 客户端内置的 Miora MCP（`resources/plugins/workbuddy-builtin/mcps/miora-mcp`）
暴露了这些工具：

| 工具 | 对应桥的模式 |
|---|---|
| `miora_text_to_video` | `mode=text`（文生视频） |
| `miora_frame_to_video` | `mode=frame`（首帧，可选尾帧） |
| `miora_reference_to_video` | `mode=reference`（参考图） |
| `miora_query_task` | `GET /v1/videos/{id}` |
| `miora_text_to_image` / `miora_edit_image` | 未接入（同源，可按相同方式扩展） |

调用链与桥的实现一致：

```text
当前登录 token
  └─ POST <chat endpoint>/v2/api-keys
       body: { name: "workbuddy-connect-cloud-service",
               expire_in_seconds: 900, temporary: true }
       → data.key = ck_t_…（约 15 分钟有效）
            └─ POST https://public.miora.qq.com/api/ai/workbuddy-proxy/video/submit
                 Authorization: Bearer ck_t_…
                 → { upstreamTaskId, model, provider, mode }
                      └─ POST .../video/query-task
                           { upstreamTaskIds: ["<id>"] }
                           → { "<id>": { status, resultFiles, errorMessage } }
```

- 临时 key 只驻桥内存，按账号 + token 指纹缓存；不落盘、不写日志、不回显。
- 临时 key 失效（401）时只换 key 重试**一次**。提交成功后遇到 5xx/429 **不重试**，
  避免第二次计费；未完成任务请用查询接口恢复。
- 视频提交是异步的：`POST /v1/videos` 返回 `202`，状态从 `queued` → `in_progress`
  → `completed` / `failed` / `cancelled`。**客户端工具最多等待约 15 分钟**；
  超时不等于失败，用查询接口恢复，避免重复提交再次计费。

## 2. 接口

### 2.1 提交

```http
POST /v1/videos
Authorization: Bearer <本地桥令牌>
Content-Type: application/json
```

**文生视频**（`mode` 可省略）：

```json
{
  "prompt": "一只橘猫从窗台跳下，镜头跟随，午后暖光",
  "duration": 5,
  "resolution": "768P",
  "aspect_ratio": "9:16"
}
```

**图生视频 —— 首帧 / 首尾帧**：

```json
{
  "mode": "frame",
  "prompt": "镜头缓慢推进，人物转头看向镜头",
  "first_frame": "C:\\Users\\me\\Pictures\\start.png",
  "last_frame": "https://example.com/end.png"
}
```

**图生视频 —— 参考图**：

```json
{
  "prompt": "同一位角色在海边挥手，镜头环绕",
  "references": ["file/abc/character.png", "https://example.com/style.png"]
}
```

#### 字段与校验

| 字段 | 别名 | 规则 |
|---|---|---|
| `mode` | — | `text` / `frame` / `reference`；不传时按输入推断（见下表） |
| `prompt` | — | 文生视频与参考图**必填**；首尾帧可选；≤ 8000 字符；非字符串直接 400 |
| `duration` | `seconds` | **正整数**秒；两个都传且不一致 → 400。档位由上游判定（实测 4–15） |
| `resolution` | — | 字符串；`768p`/`2k` 归一成 `768P`/`2K`；未知值原样透传，由上游判定（实测 768P / 2K） |
| `aspect_ratio` | `aspectRatio` | 正整数比，如 `16:9`、`9:16`、`1:1`；空格会被去掉；`0:0` 这类直接 400 |
| `first_frame` | `first_frame_path`、`firstFrame`、`input_reference` | 起始帧；同一请求只能给一个 |
| `last_frame` | `last_frame_path`、`lastFrame` | 结束帧（可选，不能单独使用） |
| `references` | `reference_paths` | 参考图数组（每项非空字符串）；同一请求只能给一个 |
| `model` | — | 接受但**忽略**（选模型由 Miora 决定） |

**未知字段一律 400**（带 `Accepted:` 清单）。这一条是刻意的：拼错 `firstFrameImage`
或传 OpenAI 风格的 `size` 如果被静默忽略，请求会退化成文生视频 —— 图片没带上，但提交
照常计费。常见错写会附指路（`size` → 用 `resolution` + `aspect_ratio`）。

模式推断与冲突：

| 输入 | 推断结果 | 说明 |
|---|---|---|
| 只有 `prompt` | `text` | 文生视频 |
| `first_frame`（可带 `last_frame`） | `frame` | 图生视频；`last_frame` 单独出现 → 400 |
| 只有 `references` | `reference` | 图生视频 |
| 显式 `mode` 与输入冲突 | — | 400（`text` 不收帧/参考图；`frame` 与 `reference` 互斥） |
| 什么都不给 | — | 400（文生视频缺 prompt） |

图片输入（`first_frame` / `last_frame` / `references[]`）支持四种来源：

1. **绝对本地路径**：扩展名必须是 png/jpg/jpeg/gif/webp/bmp/svg，≤ 10 MB；
2. **miora fileKey**：以 `bga/` 或 `file/` 开头，拒绝 `..` 等路径穿越段；
3. **公网 https URL**：拒绝 http、localhost、私有/保留地址、带账号密码的 URL；
4. **base64 data URI**：必须 `;base64`，mime 必须是 `image/*`，解码后 ≤ 10 MB。

> 本地路径只对**本地管理令牌**开放（见第 5 节），因为它能读本机文件。

成功返回 `202`：

```json
{
  "id": "a1b2c3",
  "object": "video",
  "status": "queued",
  "upstream_status": "pending",
  "created_at": 1761390000,
  "model": "…",
  "provider": "copilot-video",
  "mode": "text",
  "seconds": 5,
  "resolution": "768P",
  "aspect_ratio": "9:16",
  "result_files": [],
  "output": null,
  "error": null
}
```

### 2.2 查询（可长轮询）

```http
GET /v1/videos/{upstreamTaskId}
GET /v1/videos/{upstreamTaskId}?wait=30
Authorization: Bearer <本地桥令牌>
```

- `wait=N`（0–60，整数秒）：**桥代客户端轮询**，每 2 秒查一次，直到终态或预算用完。
  查询不计费，重复查询安全；超时返回最后一次状态（不是失败）。`wait=abc` 直接 400，
  不会静默当成 0。
- 建议交互：提交后用 `wait=20` 查一次；仍是 `in_progress` 再隔一会儿查，别重提。
- `status` 是归一化状态（`pending`→`queued`、`processing`→`in_progress`），
  `upstream_status` 保留上游原值。

**提交元数据是 best-effort 回填**：`mode` / `seconds` / `resolution` / `aspect_ratio` /
`created_at` / `model` 只有提交时才知道，上游查询接口不返回。桥在内存里记 6 小时
（最多 500 条、不含 prompt、不落盘），同一桥进程内查询会把它们补回去；桥重启后这些字段
为 `null`。**不要把它们当持久事实**，需要长期保存就自己在提交时存档。

`created_at` 是提交时间（秒）；没有本地记录时为 `null`（桥不伪造时间）。

`result_files` 保留上游原始字段（通常是 `signedUrl` / `mimeType` / `fileKey`）。
`output.url` 是第一个 https 产物地址；签名 URL 有时效，拿到后请尽快下载。

### 2.3 下载

```http
GET /v1/videos/{upstreamTaskId}/content
```

| 任务状态 | 返回 |
|---|---|
| `completed` 且有 https 产物 | `302` 跳转到上游签名 URL |
| `queued` / `in_progress` | `409 VIDEO_NOT_READY` |
| `completed` 但没有 https 产物 | `502 VIDEO_NO_OUTPUT`（重查也许能拿到，**不要重提**） |
| `failed` / `cancelled` | `409 VIDEO_NOT_READY`（先查状态拿 `error.message`） |

`/content` 也接受 `?wait=N`（先等再跳转）。

## 3. 计费、幂等与超时

| 项 | 规则 |
|---|---|
| 计费 | **提交成功即按账号积分计费**；查询与 `/content` 不计费 |
| 幂等 | **提交不是幂等的**：不要因为超时/断线自动重试，否则可能重复扣费 |
| 提交超时 | 桥给提交预留 390 秒（异步接口正常几秒返回）；客户端超时先断开时任务可能已创建 —— 先查，不要重提 |
| 查询超时 | 单次 30 秒；`wait=N` 的总预算最多 60 秒（客户端把超时设得比它长） |
| 请求体 | 沿用 `WORKBUDDY_MAX_BODY_BYTES`（默认 32 MB）；base64 图片会快速放大，注意 413 |
| 账本 | 视频提交按 `kind=video` 单独计数（控制台用量页显示「视频提交/视频失败」），不计入模型调用与 tokens；上游不回报视频积分 |

> 视频是高积分工具（客户端里单独审批，和图片分组），桥不会替你估算成本。
> 需要控制消耗时先用短时长/低分辨率，或先在 WorkBuddy 客户端里确认当前账号额度。

## 4. 错误码与处理策略

| code | HTTP | 含义 | 客户端该怎么做 |
|---|---|---|---|
| `VIDEO_INVALID_INPUT` | 400 | 本地校验失败（模式冲突、未知字段、图片不可读、参数形状不对） | 按 message 改参数；**不要原样重试** |
| `VIDEO_NO_CREDENTIAL` | 401 | 读不到 WorkBuddy 登录凭据 | 重新登录（桌面端或插件），再试 |
| `VIDEO_AUTH` | 401 | 临时 key 申请失败 / 上游拒绝临时 key | 确认登录态有效；桥已换 key 重试过一次 |
| `VIDEO_SCOPE_DENIED` | 403 | 当前凭据没有视频权限 | 换有权限的账号；不要重试 |
| `VIDEO_LOCAL_TOKEN_REQUIRED` | 403 | 用了普通 client key 调视频接口 | 改用本地管理令牌（插件会自己带） |
| `VIDEO_NOT_FOUND` | 404 | 上游没有这个任务 id | 确认 id 来自提交响应；不要自己拼 |
| `VIDEO_NOT_READY` | 409 | 任务未完成 / 无产物可下载 | 稍后再查；不要重提 |
| `VIDEO_RATE_LIMITED` | 429 | Miora 限流（带 `Retry-After`） | 等到 `Retry-After` 后再查；提交是否已受理以查询为准 |
| `VIDEO_UPSTREAM_REJECTED` | 400 | 上游业务拒绝（时长/分辨率/内容安全等） | 按上游 message 改参数；**不要原样重试** |
| `VIDEO_NO_OUTPUT` | 502 | 上游标记完成但没有 https 产物 | 稍后重查；不要重提 |
| `VIDEO_UNAVAILABLE` | 502 | 连不上 WorkBuddy 网关 / Miora | 检查网络与桥状态；提交是否成功未知，先查询 |
| `VIDEO_UPSTREAM` | 502 | 上游返回非 JSON、缺字段、其它 5xx | 稍后重试**查询**；不要重试提交 |
| `VIDEO_ERROR` | 5xx | 未分类错误 | 看桥日志 |

自动重试边界（桥自己只做这些）：

- **401 → 换临时 key 重试一次**（请求未被受理，不会重复计费）；
- **429 / 5xx → 不自动重试**（提交可能已被受理，重试会重复计费）；
- **查询**永远可以重复（只读、不计费）。

上游拒绝的还原：Miora 代理有时用外层 2xx/5xx 包住业务错误，真正的状态只写在
`message` 里（`upstream video-submit failed: status=400 ...`）。桥会把它还原成 400
`VIDEO_UPSTREAM_REJECTED`，而不是笼统的 502。

## 5. 认证来源与调用方

视频接口**只接受本地管理令牌**（`WORKBUDDY_LOCAL_TOKEN`，也就是控制台/dsh 插件用的
那把），`WORKBUDDY_CLIENT_KEYS` 里的普通 client key 只能聊天，调用视频会得到
`403 VIDEO_LOCAL_TOKEN_REQUIRED`。原因是视频接口可以读本机绝对路径图片，并且提交会
消耗账号积分，不能把这两项能力扩大给“仅聊天”的客户端 key。

- 桌面端已登录：直接用桌面登录文件，桥每次现取现解。
- 插件登录：用插件保管的账号凭据，同样能申请 Miora 临时 key。
- `CODEBUDDY_API_KEY` 模式：视频需要 `/v2/api-keys` 的临时 key 权限；若该 key 没有
  对应 scope，接口会返回 `401 VIDEO_NO_CREDENTIAL` 或上游 403，不会静默降级。

## 6. 客户端示例

```bash
TOKEN="$(cat dsh-plugin/.bridge-token)"   # 或在 .env 里看 WORKBUDDY_LOCAL_TOKEN

# 文生视频
curl -sS http://127.0.0.1:8790/v1/videos \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"prompt":"海边日落，镜头缓慢推进","duration":5,"resolution":"768P","aspect_ratio":"16:9"}'

# 图生视频（首帧）
curl -sS http://127.0.0.1:8790/v1/videos \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"mode":"frame","prompt":"镜头推进","first_frame":"C:/Users/me/Pictures/start.png"}'

# 查询：最多让桥等 30 秒
curl -sS "http://127.0.0.1:8790/v1/videos/<id>?wait=30" -H "Authorization: Bearer $TOKEN"
```

## 7. 边界与后续

- 只服务**当前登录的本人账号**，不做多账号池化、代调用或转售；临时 key 不导出。
- 只接视频。图片生成（`miora_text_to_image` / `miora_edit_image`）同源，
  可按相同方式扩展。
- 上游是未公开接口，路径与字段可能变化；桥把上游错误映射成明确 code，便于失效时定位。
- 配置项：`WORKBUDDY_MIORA_BASE`（默认 `https://public.miora.qq.com`，一般不用改）。

## 8. 实测记录（2026-10-25）

**真机出片（同日早些时候）**

- 模型：`minimax-h3-iOA`（`provider=copilot-video`）。
- 提交：4 秒 / 768P / 16:9 文生视频，桥返回 `202`，7 秒后进入 `processing`，
  101 秒后 `completed`。
- 产物：1.13 MB MP4，H.264 + AAC，1344×768，24fps，实际 4.46 秒
  （请求 4 秒是目标值）；抽帧画面与提示词一致（橘猫、窗台、暖光）。
- 实测约束：时长 **4–15 秒**（3 秒被拒）；分辨率 **768P / 2K**（720p 被拒）。
- 上游拒绝以 `status=400` 返回，但可能被代理包在 2xx/5xx 外层；桥会从
  `message` 里的 `status=` 还原成 400，返回 `VIDEO_UPSTREAM_REJECTED`。
- 下载地址是 COS 签名 URL，带 `expiresAt`；本次产物的签名有效期约 12 小时。
- 冒烟脚本会下载并校验 MP4 `ftyp` 文件头；本次校验通过。

**本轮加固（2026-10-25，未重新出片）**

- 参数校验/归一：`miora-video.test.mjs` 覆盖未知字段、空帧、非字符串参考图、
  非整数时长、非法画幅、非图片 data URI、分辨率大小写归一。
- 长轮询与元数据回填：`miora-video.test.mjs`（注入 sleep）与
  `bridge-video.test.mjs`（真起桥 + 桩上游，`task-slow` 两次查询后 completed）。
- `VIDEO_NO_OUTPUT`：`bridge-video.test.mjs` 的 `task-empty`（completed + 空产物）
  断言 `/content` 返回 502，而不是 409。
- 打包完整性：`npm run check:pack` 递归校验根包入口的本地 import 都在 `files` 里。
