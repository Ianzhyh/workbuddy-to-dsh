/**
 * 本插件的两种安装形态包名（单一来源）。
 *
 * 为什么必须集中：dsh 的 Loader 条目名、客户端模块 id、profile 依赖名三者
 * 是同一个字符串。只要有一处对不上，web boot 就会把插件判成
 * `import failed` 并中止整个应用（issue #3）。
 *
 * 新增 / 修改安装形态时，除了这里，还要同步：
 *   - `lib/client.js` 的固定注册列表（浏览器 bundle 不能 import 本模块）；
 *   - `lib/index.js` 的 `clientGraphSummary`（已引用本模块）；
 *   - `scripts/preflight.mjs`（已引用本模块）；
 *   - 仓库根 `lib/dsh.mjs` 的 `NATIVE_PLUGIN_BUNDLES`；
 *   - 根包 / 子包的 `package.json` name 与各自 `cordis.patch.yml` 的 `name`。
 *
 * `tests/install-contract.test.mjs` 会把这些点全部对一遍，漏改会直接红。
 */
export const PLUGIN_PACKAGE_NAMES = ['dsh-plugin-workbuddy', 'workbuddy-to-dsh'];
