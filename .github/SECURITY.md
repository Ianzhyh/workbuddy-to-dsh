# Security policy

这是一个在本机回环地址上运行的自托管互操作工具。**不要把桥、控制台或本地令牌暴露到公网/局域网。**

## 报告问题

- 优先使用 GitHub 仓库的 **Security → Report a vulnerability**（私下报告）。
- 如果该入口不可用，可以开一个 issue，但**不要**贴出令牌、Authorization 头、登录文件内容、账号 UID 或完整对话。
- 需要附带诊断时，用 `node tools/doctor.mjs --bundle` 生成脱敏 JSON；它不含令牌/密钥/对话内容。

## 明确不做的事

- 不导出上游凭据、不写回登录文件、不把 refresh token 落明文。
- 不绕过上游鉴权或风控，不伪造设备指纹。
- 不支持多账号池化、代他人调用、对外转售或公网中转。

完整边界与凭据存储说明见 [`docs/SECURITY.md`](../docs/SECURITY.md)。
