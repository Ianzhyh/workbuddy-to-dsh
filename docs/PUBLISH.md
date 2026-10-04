# 发布与"官方插件"：核实过的结论

> 本文结论全部来自一手来源（官方仓库 README、GitHub API、pnpm 文档与真实站点），
> 链接在文末。早先我说过"没有官方分发渠道"——**那是错的**，我只查了 dsh 客户端本地
> 实现，没查官方仓库文档。下面是更正后的准确版本。

## 一、官方认可的机制：GitHub 仓库 + `dsh-plugin` topic

官方 `deepseek-ai/deepseek-harness` 的 README 在「Community and support」里明确写了：

> Add the [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic to your plugin repository for discoverability.

也就是说 **"上传 GitHub + 打 `dsh-plugin` 标签"就是官方给的分发/被发现方式** —— 你的记忆是对的。
补充几个核实到的数字：

- GitHub topic `dsh-plugin` 下目前有 **17,486** 个仓库（GitHub Search API 实测）。
- **官方仓库自己就带着这个 topic**：`deepseek-ai/deepseek-harness` 的 topics 是
  `["ai-agents", "cordis", "dsh", "dsh-plugin"]`。
- 头部插件普遍同时打 `dsh-plugin` 与 `deepseek-harness` 两个 topic（如 `nexu-io/open-design`、`tt-a1i/archify`）。

**没有"官方审核/收录后台"**：dsh 客户端仍然是「填入 npm 包名或 spec」来安装，官方只提供
topic 作为发现约定；被谁收录取决于各社区市场**爬 topic**。

## 二、谁会"收录"你（都是社区站，非官方）

| 站点 | 性质 | 怎么进去 |
|---|---|---|
| [dsh-plugin.org](https://dsh-plugin.org/zh/submit) | 社区插件市场（自称非官方、与 DeepSeek 无隶属） | 爬 `dsh-plugin` topic 自动发现；也可按其模板在 `dshplugin/dsh-plugin-hub` 提 Issue 加速 |
| [dsh-market/dsh-market](https://github.com/dsh-market/dsh-market) | 另一个社区市场（issues 里有 git `#path:` 相关的 bug 记录） | 同上，靠 topic |
| GitHub 自身 | [topic 页](https://github.com/topics/dsh-plugin) 就是最直接的目录 | 打上 topic 即可 |

它们的收录要求高度一致（dsh-plugin.org 的原文）：

1. **公开仓库**（私有仓库或只发二进制的不行）
2. 仓库 Topics 加 **`dsh-plugin`**
3. **README 里有安装命令**，形如 `dsh plugin --profile web add <包名>`
4. 插件导出 `apply(ctx)`，符合 dsh 插件规范
5. 不冒充官方

> 收录分 `unconfirmed` → `verified` 两档；初始自动收录是 `unconfirmed`，人工核实兼容性后才 `verified`。

## 三、别人怎么装（三种来源，按可靠度排序）

### 1. npm 包名（最稳，推荐）

```sh
cd E:\workbuddy-to-dsh
npm run release:check          # vendor 同步 + 单测 + 独立分发演练

# dsh-plugin/package.json 里去掉 "private": true（有意的安全闸）
cd dsh-plugin
npm login --registry https://registry.npmjs.org/
npm publish                    # publishConfig 已把目标固定为官方 npm
```
> ⚠️ 本机 `~/.npmrc` 的 registry 是 `registry.npmmirror.com`（**只读镜像，不能发布**）。
> `publishConfig.registry` 已经写死官方 npm，所以不加 `--registry` 也不会打错地方。

对方：`dsh plugin --profile desktop add dsh-plugin-workbuddy`

### 2. GitHub 源码

- **插件独占一个仓库**（生态里的常规形态）：仓库根就是插件包 →
  `dsh plugin --profile desktop add github:Ianzhyh/workbuddy-to-dsh`
- **本仓库这种 monorepo**：git spec 可以带子目录，写作
  `github:Ianzhyh/workbuddy-to-dsh#path:/dsh-plugin`；但社区市场里有 [issue #281](https://github.com/dsh-market/dsh-market/issues/281)
  记录过"更新路由会把 `#path:` 丢掉、装成仓库根"的问题 —— 也就是**这条路径不稳**。
  更保险的 monorepo 用法：clone 后指向子目录（本机就是这么装的）：
  ```sh
  git clone https://github.com/Ianzhyh/workbuddy-to-dsh.git
  dsh plugin --profile desktop add workbuddy-to-dsh/dsh-plugin
  ```

### 3. tarball / 直接发文件夹

`npm run pack:plugin` 出 `dsh-plugin-workbuddy-1.0.0.tgz`（约 207 KB，含自带 vendor），
对方安装该 tgz；或直接把 `dsh-plugin/` 文件夹拷过去。最离线、最可控。

---

## 四、把本仓库推上去的完整步骤（你本人执行）

我已经把仓库整理成可推送的形态（`git init` 已做、`.gitignore` 已覆盖凭据/账本/日志、
CI 工作流已加）。你只需要：

```sh
# 1) 建一个空仓库后（网页上点 New repository），把地址填进来
git remote add origin https://github.com/Ianzhyh/workbuddy-to-dsh.git

# 2) 推送
git push -u origin main

# 3) 到仓库页面 → 右上 About 齿轮 → Topics 填：dsh-plugin, deepseek-harness, dsh, workbuddy, codebuddy
#    （About 描述建议：把 WorkBuddy 桌面端已登录的模型原生接进 DeepSeek Harness）
```

推送前自查（对应各市场的收录要求）：

- [x] 仓库可公开（无凭据：`.gitignore` 已排除 `*.info` / `.env` / `usage.jsonl` / `.state.json` / `*.log`）
- [x] README 里有可复制的安装命令（见 README「安装」与「给别人用」两节）
- [x] 插件导出 `apply(ctx)`（宿主端 `lib/index.js`）
- [x] 有 LICENSE（MIT）
- [x] 有截图（`docs/plugin-panel*.png` 七张）
- [x] 有 CI（`.github/workflows/release-check.yml`：vendor 同步 + 34 项单测 + 独立分发演练）
- [ ] 版本与 release 规范（想标版本就打个 tag：`git tag v1.0.0 && git push --tags`）

---

## 五、公开前必须知道的风险（这条比技术重要，仍然成立）

插件的核心能力是**解密本机 WorkBuddy（腾讯 CodeBuddy 桌面端）的登录凭据**（AtRest 信封），
再转成 OpenAI 兼容接口：

1. 公开分发前请**自行确认不违反腾讯/WorkBuddy 的使用条款**；有疑问就走私有渠道（见下）。
2. 它只支持 Windows（`package.json` 已声明 `"os": ["win32"]`），且对方必须自己安装并登录 WorkBuddy。
3. 不要携带任何使用者数据 —— `npm run vendor` 已排除并主动清理账本/日志/`.state.json`/`.env`。
4. 若只想给同事用：私有 registry（Verdaccio / GitHub Packages）或直接发文件夹，别公开。

---

## 六、上架文案（提交模板用）

**标题**：`[插件提交] Ianzhyh/workbuddy-to-dsh — 把本机 WorkBuddy 已登录模型原生接进 dsh`

```markdown
### 仓库地址
https://github.com/Ianzhyh/workbuddy-to-dsh

### 一句话价值
装完 dsh 的模型选择器里直接多出 provider「WorkBuddy」，本机 WorkBuddy 桌面端已登录的
全部模型（30 个）原生可用，无需改 settings.yaml；设置里还多一页完整的数据面板。

### 能力分类
模型与推理

### 安装命令
dsh plugin --profile desktop add dsh-plugin-workbuddy
# 或从源码：git clone https://github.com/Ianzhyh/workbuddy-to-dsh.git && dsh plugin --profile desktop add workbuddy-to-dsh/dsh-plugin

### 兼容与运行要求
Windows 10/11；Node 18+；WorkBuddy 桌面端已登录；DeepSeek Harness 桌面版（已验证 0.2.0-rc.2）

### 许可证
MIT

### 截图 / 演示
docs/plugin-panel.png（概览：积分卡 + 状态）、docs/plugin-panel-usage.png 等 7 张

### 补充说明
只连本机回环地址（127.0.0.1:8790/8792），不新增对外监听、不上报数据；凭据现取现解不落盘复制。
注意：依赖本机 WorkBuddy 的登录态，仅 Windows。
```

**关键词**：`deepseek-harness`、`dsh-plugin`、`dsh-bundle`、`workbuddy`、`codebuddy`、`llm-provider`

---

## 来源

- [deepseek-ai/deepseek-harness README（官方：`dsh-plugin` topic 用于 discoverability）](https://github.com/deepseek-ai/deepseek-harness)
- [GitHub topic: dsh-plugin（17,486 个仓库）](https://github.com/topics/dsh-plugin)
- [dsh-plugin.org 提交页（社区市场，非官方）](https://dsh-plugin.org/zh/submit)
- [dsh-market/dsh-market issue #281（git `#path:` 的 monorepo 子目录问题）](https://github.com/dsh-market/dsh-market/issues/281)
- [pnpm 文档](https://pnpm.io/)
