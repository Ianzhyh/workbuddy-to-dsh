# 文生视频 / 图生视频接入说明

> 结论：**可以实现**。WorkBuddy 桌面端自带的 Miora 视频能力（文生视频、首尾帧、
> 参考图）可以由本桥直接调用，不需要模拟客户端界面。桥已经暴露
> `POST /v1/videos`、`GET /v1/videos/{id}` 和 `GET /v1/videos/{id}/content`。
>
> 2026-10-25 实测：现有桌面登录态可以换到 Miora 临时 key，视频查询接口返回 200；
> 已通过桥真实生成一条 4 秒 / 768P 文生视频（`minimax-h3-iOA`，101 秒出片，
> MP4 可播放）。实测支持范围与完整结果见文末「实测记录」。

## 1. 上游链路（从客户端资源反查）

WorkBuddy 客户端内置的 Miora MCP（`resources/plugins/workbuddy-builtin/mcps/miora-mcp`）
暴露了这些工具：

| 工具 | 用途 |
|---|---|
| `miora_text_to_video` | 文生视频 |
| `miora_frame_to_video` | 首帧（可选尾帧）生视频 |
| `miora_reference_to_video` | 参考图生视频 |
| `miora_query_task` | 按 `upstreamTaskId` 查询任务 |
| `miora_text_to_image` / `miora_edit_image` | 图片生成（本轮未接入） |

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

### 提交

```http
POST /v1/videos
Authorization: Bearer <本地桥令牌>
Content-Type: application/json
```

**文生视频**：

```json
{
  "prompt": "一只橘猫从窗台跳下，镜头跟随，午后暖光",
  "duration": 5,
  "resolution": "768P",
  "aspect_ratio": "9:16"
}
```

**图生视频（首尾帧）**：

```json
{
  "mode": "frame",
  "prompt": "镜头缓慢推进，人物转头看向镜头",
  "first_frame": "C:\\Users\\me\\Pictures\\start.png",
  "last_frame": "https://example.com/end.png"
}
```

`first_frame` 也可写成 `input_reference`（OpenAI 风格别名）；`last_frame` 可省略。
图片支持：绝对本地路径、miora fileKey（`bga/…` 或 `file/…`）、公网 https URL、
`data:image/...;base64,...`。

**参考图生视频**：

```json
{
  "prompt": "同一位角色在海边挥手，镜头环绕",
  "references": ["file/abc/character.png", "https://example.com/style.png"]
}
```

模式可以显式传 `mode`（`text` / `frame` / `reference`）；不传时按是否带帧/参考图自动推断。
文生视频与参考图模式必须给 `prompt`；首尾帧模式可选。`duration` / `resolution` /
`aspect_ratio` 原样透传上游。**时长本次实测支持 4–15 秒**（3 秒会被上游拒绝）；
**分辨率本次实测支持 768P / 2K**（720p 会被拒绝）。`model` 字段不参与模型选择
（由 Miora 决定），传了会被忽略；`seconds` 可作为 `duration` 的别名。

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

### 查询

```http
GET /v1/videos/{upstreamTaskId}
Authorization: Bearer <本地桥令牌>
```

返回值形状同上。`status` 是归一化状态，`upstream_status` 保留上游原值；
`created_at` 在查询响应里是 `null`（桥不持久化任务元数据，不伪造时间）。
同理，提交时的 `mode` / `seconds` / `resolution` / `aspect_ratio` 在查询响应里也是
`null`；查询只保证任务状态与产物。请求时长是目标值，**实际成片可能略有出入**
（本次 4 秒请求得到 1344×768 / 24fps / 4.46 秒），以播放器或 `ffprobe` 为准。

`result_files` 保留上游原始字段（通常是 `signedUrl` / `mimeType` / `fileKey`）。
`output.url` 是第一个 https 产物地址；签名 URL 有时效，拿到后请尽快下载。

### 下载

```http
GET /v1/videos/{upstreamTaskId}/content
```

`completed` 且有产物时返回 `302` 跳转到上游签名 URL；未完成返回 `409`。

## 3. 参数与限制

| 项 | 规则 |
|---|---|
| 图片大小 | 每张 ≤ 10 MB；支持 png/jpg/jpeg/gif/webp/bmp/svg |
| 图片来源 | 本地绝对路径 / `bga/…`、`file/…` fileKey / 公网 https / base64 data URI |
| 网络图片 | 只接受 https，拒绝 localhost、私有地址与带账号密码的 URL |
| prompt | 文生视频/参考图必填，最长 8000 字符 |
| 时长 | 本次实测 4–15 秒；3 秒会被上游以 `status=400` 拒绝（不创建任务） |
| 分辨率 | 本次实测 768P / 2K；720p 会被上游以 `status=400` 拒绝 |
| 请求体 | 沿用桥的 `WORKBUDDY_MAX_BODY_BYTES`（默认 32 MB） |
| 计费 | **提交成功即按账号积分计费**；查询不计费 |
| 幂等 | **提交不是幂等的**：不要因为超时/断线自动重试，否则可能重复扣费 |
| 账本 | 视频提交按 `kind=video` 单独计数（控制台用量页显示「视频提交/视频失败」），不计入模型调用与 tokens；上游不回报视频积分，积分余额仍以 WorkBuddy 账号为准 |

> 视频是高积分工具（客户端里单独审批，和图片分组），桥不会替你估算成本。
> 需要控制消耗时先用短时长/低分辨率，或先在 WorkBuddy 客户端里确认当前账号额度。

**超时与恢复**：

- 提交接口正常几秒返回；桥给提交预留约 6.5 分钟（与官方客户端一致）。
  若客户端先超时/断开，任务可能已经创建 —— 先到 WorkBuddy 客户端或桥日志确认，
  **不要直接重提**。
- Miora 对不存在的任务 id 也可能返回 `pending`，桥无法区分“真排队”与“id 写错”。
  因此查询时务必使用提交响应里的 `id`，不要自己拼。
- 查询只读、不计费；生成中重复查询是安全的。

## 4. 认证来源与调用方

视频接口**只接受本地管理令牌**（`WORKBUDDY_LOCAL_TOKEN`，也就是控制台/dsh 插件用的
那把），`WORKBUDDY_CLIENT_KEYS` 里的普通 client key 只能聊天，调用视频会得到
`403 VIDEO_LOCAL_TOKEN_REQUIRED`。原因是视频接口可以读本机绝对路径图片，并且提交会
消耗账号积分，不能把这两项能力扩大给“仅聊天”的客户端 key。

- 桌面端已登录：直接用桌面登录文件，桥每次现取现解。
- 插件登录：用插件保管的账号凭据，同样能申请 Miora 临时 key。
- `CODEBUDDY_API_KEY` 模式：视频需要 `/v2/api-keys` 的临时 key 权限；若该 key 没有
  对应 scope，接口会返回 `401 VIDEO_NO_CREDENTIAL` 或上游 403，不会静默降级。

## 5. 边界与后续

- 只服务**当前登录的本人账号**，不做多账号池化、代调用或转售；临时 key 不导出。
- 本轮只接视频。图片生成（`miora_text_to_image` / `miora_edit_image`）同源，
  后续可按相同方式扩展。
- 上游是未公开接口，路径与字段可能变化；桥把上游错误原样映射成
  `VIDEO_UPSTREAM` / `VIDEO_UPSTREAM_REJECTED` 等明确 code，便于失效时定位。
- 配置项：`WORKBUDDY_MIORA_BASE`（默认 `https://public.miora.qq.com`，一般不用改）。

## 6. 实测记录（2026-10-25）

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
- 查询响应不返回提交时的 mode/model/seconds；若客户端需要这些元数据，请自行在
  提交时保存（桥不持久化任务元数据，避免把用户提示词写进磁盘）。
