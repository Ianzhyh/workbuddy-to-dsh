# 文生图 / 图生图接入说明

> 桥新增 `POST /v1/images`（文生图）、`POST /v1/images/edits`（图生图）、
> `GET /v1/images/{id}` 与 `GET /v1/images/{id}/content`，走 WorkBuddy 桌面端同款
> Miora 网关，与视频共用临时 key / 轮询 / 错误映射。
>
> **验证状态**：请求路径、字段与限制来自客户端内置 `miora-mcp`（`dist/cli.cjs`）的
> 实现，并用桩上游做了端到端合约测试。真机提交已发生过两次（2026-10-26，图生图），
> 上游均**在提交响应里同步返回失败**，而旧实现把它当异步任务、丢掉了真实失败原因，
> 随后按 id 查询只得到 `INVALID_TASK_ID_FOR_SYNC_MODE` —— 本轮已修复这条链路
> （同步结果缓存、HTTP 200、工具直接交付/报错）。**尚未真机成功出图**；实际出图效果、
> 尺寸/质量枚举与扣费时点仍未验证。

## 1. 上游链路

```text
当前登录 token
  └─ POST <chat endpoint>/v2/api-keys        （15 分钟临时 key，与视频共用缓存）
       └─ POST https://public.miora.qq.com/api/ai/workbuddy-proxy/image/generate/submit
            body: { prompt, size?, quality? }
            → { upstreamTaskId, model, provider, mode }
       └─ POST .../image/edit/submit
            body: { prompt, images: [ {url|file_key|base64} ], size? }
       └─ POST .../image/query-task
            { upstreamTaskIds: ["<id>"] }
            → { "<id>": { status, resultFiles, errorMessage } }
```

- 临时 key 只驻桥内存，按账号 + token 指纹缓存；与视频共用一把（同一账号）。
- 提交是计费动作：401 只换 key 重试一次；429/5xx **不自动重试**。
- 图片任务可能是异步的，也可能**在提交接口里同步跑完**（实测图生图就走过
  `mode:"sync"`）。同步结果只在 submit 响应里；上游不会为它保存可按 id 查询的任务，
  查询会返回 `INVALID_TASK_ID_FOR_SYNC_MODE`。桥会把同步终态连同产物/失败原因缓存
  6 小时，提交后的查询与 `/content` 优先命中缓存。

## 2. 接口

### 2.1 文生图

```http
POST /v1/images
Authorization: Bearer <本地桥令牌>
Content-Type: application/json

{ "prompt": "雪地里的红狐，逆光", "size": "1024x1024", "quality": "hd" }
```

### 2.2 图生图

```http
POST /v1/images/edits
Authorization: Bearer <本地桥令牌>
Content-Type: application/json

{
  "prompt": "把天空改成紫色，保持构图",
  "images": ["C:\\Users\\me\\Pictures\\ref.png", "file/abc/style.png"],
  "size": "1024x768"
}
```

`images[]` 每项支持：绝对本地路径、miora fileKey（`bga/…` / `file/…`）、公网 https URL、
`data:image/...;base64,...`。**单张 ≤ 20 MB**（视频帧是 10 MB）。
内联（本地路径 / data URI）多张合计还要装得进桥的请求体：base64 膨胀 4/3，默认
32 MB 的 `WORKBUDDY_MAX_BODY_BYTES` 大约只容得下 23.8 MB 原始图片。超出时桥在**提交前**
返回 400，并建议改用 fileKey/URL，而不是等请求体长到几十 MB 再给 413。

> 路径语义是硬的：`/v1/images` 只做文生图（带 `images` 会 400，不会悄悄改成图生图）；
> `/v1/images/edits` 只做图生图（缺 `images` 会 400）。body 里显式传 `mode` 会覆盖路径默认值。
> `quality` 只对文生图有意义；图生图不发送、也不在查询响应里回显（避免看起来已生效）。

### 2.3 提交响应：异步 202 / 同步 200

- **异步**（最常见）：`202`，`sync: false`，`status` 为 `queued` / `in_progress`，
  之后用查询接口轮询。
- **同步**：上游在 submit 里直接跑完，桥返回 **`200`**、`sync: true`，`status` 已是
  `completed` / `failed` / `cancelled`，`output` / `error` / `result_files` 当场给全。
  这类任务**不能再按 id 查询**；桥会在内存里缓存 6 小时，期间查询与 `/content` 仍可用。
  缓存过期或桥重启后，查询返回 `status=failed` + `sync_result_unavailable=true`，
  `error.message` 会说明「这是同步任务、结果只在提交响应里」——**不要把它当普通生成失败
  反复重试**。

### 2.4 查询与下载

```http
GET /v1/images/{id}            # 可加 ?wait=0..60，让桥代轮询
GET /v1/images/{id}/content    # completed 且有产物 → 302 签名 URL
```

查询响应示例：

```json
{
  "id": "img_xxx",
  "object": "image",
  "status": "completed",
  "sync": false,
  "upstream_status": "completed",
  "created_at": 1761390000,
  "model": "…",
  "provider": "copilot-image",
  "mode": "generate",
  "size": "1024x1024",
  "quality": "hd",
  "result_files": [{ "signedUrl": "https://…", "mimeType": "image/png", "fileKey": "file/…" }],
  "output": { "url": "https://…", "urls": ["https://…"] },
  "error": null
}
```

- `status`：`queued` → `in_progress` → `completed` / `failed` / `cancelled`。
- `mode` / `size` / `quality` / `created_at` / `model` 是**提交元数据**，桥只在内存里
  回填 6 小时（不含 prompt、不落盘）；桥重启后为 `null`，不要当持久事实。
- `sync: true` 表示这个结果来自提交时的同步响应（或它的 6 小时缓存）。
- `sync_result_unavailable: true` 表示你查的是同步任务、但缓存已经没了；响应里的
  `failed` 不是上游的生成结论，别照着它重试。
- 任务与**提交时的账号**绑定。切换账号后再查同一个 id 会得到 `404 IMAGE_NOT_FOUND`，
  切回原账号（同一 endpoint + userId；无 userId 的 API key 模式按 token 指纹）才能命中缓存/上游任务。
- `/content`：未完成 → `409 IMAGE_NOT_READY`；已完成但上游没给 https 产物 →
  `502 IMAGE_NO_OUTPUT`（重查也许能拿到，**不要重提**）。

## 3. 参数与校验

| 字段 | 规则 |
|---|---|
| `prompt` | 必填，1–8000 字符；非字符串直接 400 |
| `size` | `WIDTHxHEIGHT`（如 `1024x1024`），会去掉空格并转小写；不传用模型默认 |
| `quality` | 文生图的质量档（如 `standard` / `hd`），≤ 32 字符；图生图忽略（上游 schema 没有） |
| `images` | 图生图必填，数组，每项非空字符串；`image`（单张）是它的别名，两者不能同时给 |
| 未知字段 | 一律 400（附 `Accepted` 清单与常见错写指路，如 `aspect_ratio` → 用 `size`） |

图片输入与视频共用一套归一化：只接受 https 公网地址（拒绝 localhost / 私有网段 /
带账号密码）、data URI 必须是 `image/*`、本地路径扩展名必须是 png/jpg/jpeg/gif/webp/bmp/svg。
公网判定按 IP 字面量做（不再误杀 `fc2.com` 这类域名，也能识别 `[::ffff:127.0.0.1]`），
详见 [`VIDEO-GENERATION.md`](VIDEO-GENERATION.md) 第 2.1 节的说明。

## 4. 错误码

| code | HTTP | 含义 | 处理 |
|---|---|---|---|
| `IMAGE_INVALID_INPUT` | 400 | 本地校验失败（未知字段、模式冲突、坏 size、图片不可读、inline 超预算） | 按 message 改参数，不要原样重试 |
| `IMAGE_NO_CREDENTIAL` | 401 | 读不到 WorkBuddy 登录凭据 | 重新登录 |
| `IMAGE_AUTH` | 401 | 临时 key 申请失败 / 被上游拒绝 | 确认登录态；桥已换 key 重试一次 |
| `IMAGE_SCOPE_DENIED` | 403 | 当前账号没有图片权限 | 换有权限的账号；不要重试 |
| `IMAGE_LOCAL_TOKEN_REQUIRED` | 403 | 用了普通 client key | 改用本地管理令牌 |
| `IMAGE_NOT_FOUND` | 404 | 上游没有该任务 | 用提交返回的 id；视频/图片 id 不互通 |
| `IMAGE_NOT_READY` | 409 | 任务未完成 / 无产物 | 稍后再查，不要重提 |
| `IMAGE_RATE_LIMITED` | 429 | **提交**被 Miora 限流（带 `Retry-After`） | 任务可能已创建：先查状态 |
| `IMAGE_KEY_RATE_LIMITED` | 429 | **申请临时 key** 被限流 | 任务尚未提交、不会计费；稍后直接重试 |
| `IMAGE_PAYLOAD_TOO_LARGE` | 413 | 请求体超限 | 改用 fileKey/URL，或调大 `WORKBUDDY_MAX_BODY_BYTES` |
| `IMAGE_UPSTREAM_REJECTED` | 400 | 上游业务拒绝（内容安全、尺寸不支持等） | 按上游 message / `upstream_code` 改参数 |
| `IMAGE_NO_OUTPUT` | 502 | 完成但没有 https 产物 | 稍后重查，不要重提 |
| `IMAGE_UNAVAILABLE` | 502 | 连不上网关 / Miora | 检查网络与桥；先查任务再决定 |
| `IMAGE_UPSTREAM` | 502 | 非 JSON / 缺字段 / 其它 5xx | 只重试查询，不重试提交 |
| `IMAGE_ERROR` | 5xx | 未分类错误 | 看桥日志 |
| `IMAGE_GENERATION_FAILED` | — | **账本专用**：同步失败/取消 | 看 `error`；不要原样重提 |

## 5. 认证、计费与积分

- 只接受**本地管理令牌**（`WORKBUDDY_LOCAL_TOKEN`）；`WORKBUDDY_CLIENT_KEYS` 里的
  client key 只能聊天，调用图片会得到 `403 IMAGE_LOCAL_TOKEN_REQUIRED`。
- **提交成功即按账号积分计费**；查询与下载不计费。图片不是幂等操作，不要因超时自动重提交。
- 上游**不回报**单次图片的积分/token：本地账本只记「图片提交 / 失败」次数
  （`kind=image`，不计入模型调用与 tokens）。同步失败/取消记 `imageFailed`，
  `code=IMAGE_GENERATION_FAILED`，不会再算一次“成功提交”。**异步任务提交后
  在上游失败，查询是只读的，不会回写账本**，以查询结果为准。
  用量页单列「图片消耗积分」，值是
  **提交前后账号余额差**（`creditEstimate`，估算；并发生成或模型调用会混入）。
  读不到余额或差值 ≤ 0 时显示「—」，不会写成 0。
  需要精确值请自己用 `/v1/quota` 前后做差。

## 6. 客户端示例

```bash
TOKEN="$(cat "${WORKBUDDY_DATA_DIR:-$HOME/.workbuddy-bridge}/bridge-token")"

# 文生图
curl -sS http://127.0.0.1:8790/v1/images \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"prompt":"雪地里的红狐，逆光","size":"1024x1024"}'

# 图生图（等出图最多 30 秒）
curl -sS http://127.0.0.1:8790/v1/images/edits \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"prompt":"把天空改成紫色","images":["C:/Users/me/Pictures/ref.png"]}'

curl -sS "http://127.0.0.1:8790/v1/images/<id>?wait=30" -H "Authorization: Bearer $TOKEN"
```

## 6.5 OpenAI Images 兼容端点（标准客户端）

标准客户端（Cherry Studio / Open WebUI / LobeChat 等）只认同步语义：

```http
POST /v1/images/generations
Authorization: Bearer <本地桥令牌>
Content-Type: application/json

{
  "model": "gpt-image-1",
  "prompt": "雪地里的红狐，逆光",
  "n": 1,
  "size": "1024x1024",
  "response_format": "url"
}
```

- `n` 只支持 1（多张会成倍扣积分，>1 直接 400）。
- `model` / `style` / `user` 等标准字段接受但忽略；真正用哪个模型由上游决定。
- `response_format=url` 返回 `{created,data:[{url}]}`；`b64_json` 会把产物下载后内联
  （单张上限 `WORKBUDDY_IMAGE_B64_MAX_BYTES`，默认 20MB）。
- 提交后最多等 `WORKBUDDY_IMAGE_SYNC_WAIT_S`（默认 90 秒）；同步完成直接 200；
  仍未完成回 **202** + `X-WorkBuddy-Job-Id` / `Location: /v1/images/{id}`。
  标准客户端可能不认 202，这是非标准降级；自定义 `/v1/images` 仍是完整的异步接口。
- `stream=true` 不支持，返回 400（避免客户端误以为有 SSE）。
- 只接受本地管理令牌；client key 仍只能聊天。

## 7. 与视频的差异

| 项 | 视频 | 图片 |
|---|---|---|
| 路径 | `POST /v1/videos` | `POST /v1/images` / `POST /v1/images/edits` |
| 模式 | `text` / `frame` / `reference` | `generate` / `edit`（按路径与 images 推断） |
| 参数 | `duration` / `resolution` / `aspect_ratio` | `size` / `quality` |
| 图片上限 | 帧 10 MB | 20 MB |
| 产物 | `object: "video"` | `object: "image"` |
| 查询/下载 | 同一套 `?wait` + `/content` | 同左 |

> 两者共用同一套**状态归一与产物识别**：`status` 的大小写/首尾空白不影响归一结果
> （`FAILED` 也会正确给出 `error.message`），产物地址除 `signedUrl` 外也认
> `downloadUrl` / `signed_url` / 裸字符串 / 嵌套 `{file:{url}}` —— 否则「已完成且有产物」
> 会被误报成 `*_NO_OUTPUT`。

## 8. 验证与后续

- 合约测试：`bridge/miora-image.test.mjs`（请求体 / 校验 / 错误前缀 / 长轮询 / 元数据 /
  同步完成与同步失败 / inline 预算）、`bridge/bridge-image.test.mjs`（真起桥 + 桩上游：
  两条路径、同步 200 与缓存、413、下载、闸门、账本）。
- 真机：2026-10-26 两次图生图提交均走 `mode:"sync"` 且返回 `failed`；旧实现丢失了
  失败原因，本轮补上了「同步终态当场返回 + 6 小时缓存 + 伪失败翻译」。
- **未做**：真机成功出图、真实扣费时点、上游对 size/quality 的实际枚举范围。
  需要时先跑一条最小尺寸、再对比余额；同步成功/失败的真实 `resultFiles` 形态也值得再验一次。
