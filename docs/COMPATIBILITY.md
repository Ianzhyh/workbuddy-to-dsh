# 兼容性矩阵

> 只承诺**最近 2 个 minor** 版本。上游协议与客户端版本都会漂移；未实测的组合按「协议兼容」而非「已支持」标注。

## 平台

| 平台 | 状态 | 说明 |
|---|---|---|
| Windows 10/11 + WorkBuddy 桌面端 | ✅ 实测 | AtRest 解密、桥、控制台、插件登录、媒体、CI 主门禁 |
| Windows + 仅插件登录（无桌面端） | ✅ 实测 | 浏览器设备码授权；凭据 DPAPI + AES-GCM |
| macOS / Linux | ⚪ 单测与 CI 矩阵 | 路径与调用逻辑已实现；**桌面凭据解密未实测**；插件登录用文件密钥 + AES-GCM 落盘 |
| Docker | ⚪ API key / 插件登录 | 不能复用桌面凭据；必须显式 `WORKBUDDY_LOCAL_TOKEN`，数据挂 `/data`；插件登录建议设 `WORKBUDDY_CREDENTIAL_KEY` |

## 客户端与协议

| 客户端 | 协议 | 状态 |
|---|---|---|
| Claude Code | Anthropic Messages | ✅ 流式 / tool_use / 多轮 tool_result 实测 |
| opencode | OpenAI Chat | ✅ 用底层 AI SDK 实测生成 / 工具 / 流式；桌面版接入需人工点一次 |
| Codex | OpenAI Responses | ⚪ 协议层按解析器源码对齐 + 单测；未在 Codex 内实跑 |
| Cherry Studio | OpenAI Chat / Responses | ⚪ 协议兼容；思考分片问题已在 1.15.0 做桥侧清洗，待客户端复测 |
| Open WebUI / LobeChat / LibreChat / NextChat / Chatbox | OpenAI Chat | ⚪ 协议兼容，未逐个客户端实测；图片生成用 `/v1/images/generations` |
| Cursor / Trae | OpenAI Chat | ⚪ 协议兼容，未在客户端内实测 |

## dsh 宿主

| dsh | 状态 | 说明 |
|---|---|---|
| 0.2.0-rc.2（实测环境） | ✅ | 原生 provider + 9 标签页 |
| 最近 2 个 minor | 🟡 尽力兼容 | 宿主内部服务变更可能让插件降级；插件会尽量懒解析服务并给出原因 |
| 更旧版本 | ❌ 不承诺 | 插件登录需要 v1.8.0+；旧宿主可能缺面板能力 |

## 明确不支持

- 多账号池化、自动换号、任务中心自动化。
- 公网 / 局域网监听、反向代理暴露控制台。
- 凭据导出、客户端身份伪造、绕过上游风控。
- embedding / RAG（上游无 embedding 模型，桥明确回 501）。
- Responses 的服务端 `store` / `previous_response_id`（桥无状态，明确 400）。
- OpenAI Realtime / Assistants / audio 端点。

## 出问题时的第一手证据

```cmd
node tools\doctor.mjs
node tools\doctor.mjs --bundle
```

再读 [TROUBLESHOOTING.md](TROUBLESHOOTING.md)；不要贴令牌、账号 UID 或完整对话。
