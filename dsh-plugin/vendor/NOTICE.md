# 来源与第三方组件

本项目的部分内容派生自或参考了以下公开项目。所有来源均为 MIT 许可。

## bridge/workbuddy-bridge.mjs

**来源**：<https://github.com/lg22-long/workbuddy-bridge> （MIT，Copyright (c) 2026 lg22-long）

本项目对其做了以下改造：

| 改动 | 原因 |
|---|---|
| 新增 AtRest 信封解密层（密钥获取 + 缓存 + AES-256-GCM 解开凭据） | 原版只支持明文凭据，WorkBuddy 5.6.0+ 起凭据改为加密信封，原版会拼出 `Bearer [object Object]` 并被上游 401 拒绝 |
| 凭据读取透明兼容明文与信封两种格式 | 保持对旧版本客户端的向后兼容 |
| **禁用登录文件写回**，刷新结果只留内存 | 登录文件现为加密存储，写入明文会破坏客户端凭据、导致用户被迫重新登录 |
| 子进程调用改用 `spawnSync` 且 `stdio: ['ignore','pipe','pipe']` | `execFileSync` 默认给 stdin 开管道，会启动 Electron 二进制失败（`EBUSY`） |
| 客户端可执行文件改为多候选自动探测 | 原版硬编码单一路径 |

原项目本身不做协议翻译（上游后端即讲 OpenAI 协议），只注入鉴权头并保证流式。

## AtRest 解密算法

**参考**：<https://github.com/XDTrees/dsh-workbuddy-xdpool> （MIT）

`lib/atrest.mjs` 按该项目公开的实现重写了密钥派生与信封解密（`src/at-rest.ts`）。核心事实：

- 字段密钥是编译进客户端原生模块的常量，通过 `loggerGet()` 暴露
- 派生规则：`key = SHA256(atRestSecretKey)`，`keyId = SHA256(key).hex()[0:16]`
- 信封为 `base64(JSON{suite,keyId,nonce,authTag,ciphertext})`，字段级 AAD 需按固定转录拼接

本项目没有内置任何密钥副本，每次运行都向写这个文件的客户端现取。

## 插件登录（OAuth 设备码）

**参考**：<https://github.com/molly-ovo/dsh-workbuddy-oauth>（MIT）

设备码登录的**流程形状**（`state → authUrl → token → account`）、登录端点与请求头
（`Origin` / `Referer` / `User-Agent`）、轮询节流，以及刷新时的来源头
（`X-Refresh-Token` / `X-Auth-Refresh-Source`），参考了该公开实现（其自身亦以官方 CLI
的登录流程为参照）。本项目独立实现，未复制其源代码；额外做了：

- 凭据加密落盘（DPAPI 保护字段密钥 + AES-256-GCM 信封，DPAPI 不可用时仅内存）；
- 凭据来源优先级（api-key / 桌面端 / 插件）与运行时切换；
- 换号后的模型目录失效、诊断、面板/控制台双侧入口与测试。

密码不经过本插件：授权在浏览器完成，插件只接收令牌。

## 相关上游事实

- WorkBuddy 桌面端自 **5.6.0** 起强制开启 AtRest 加密，登录文件中的
  `accessToken` / `refreshToken` / `nickname` 由明文改为 AES-256-GCM 信封。
  上游仓库亦有 issue 记录该变更导致所有进程外工具失效。
- dsh 侧的 `llm-pi-ai` 适配器属于 DeepSeek Harness，本项目只写入其用户设置文档，
  不修改其任何代码。

## 使用边界

- 仅用于**自己账号**的本地互操作，不提供多账号池化、代他人调用、转售或托管服务。
- 不包含、不分发腾讯 / WorkBuddy 的客户端二进制、商标素材或私有密钥；凭据只在本机读取。
- 请勿将其用于绕过付费、风控或访问控制；上游接口不可用时请使用官方 API。
- 请自行确认并遵守 WorkBuddy / 腾讯的服务条款；若条款不允许，请停止使用。

## 与被引用项目的关系

本项目与腾讯、WorkBuddy、CodeBuddy、DeepSeek 均无关联，也未获其背书或支持。
