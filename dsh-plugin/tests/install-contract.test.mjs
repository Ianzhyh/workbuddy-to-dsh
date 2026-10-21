/**
 * 安装形态契约（issue #3 的防复发门禁）。
 *
 * dsh 的 Loader 条目名、客户端模块 id、profile 依赖名是同一个字符串。仓库里
 * 同时存在两种安装形态：
 *   - 子包 / tgz：包名 dsh-plugin-workbuddy
 *   - 仓库根 / github 直装：包名 workbuddy-to-dsh
 *
 * 这条契约只要有一处漂移，web boot 就会把插件判成 `import failed` 并中止
 * 整个应用。本用例把「manifest → cordis.patch.yml → client.js 注册 id →
 * 诊断清单」全部对一遍；新增第三种安装形态或改包名时，漏改会直接红。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import { PLUGIN_PACKAGE_NAMES } from '../lib/packageNames.mjs';
import { clientGraphSummary } from '../lib/index.js';
import { NATIVE_PLUGIN_BUNDLES } from '../../lib/dsh.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN = join(HERE, '..');
const ROOT = join(PLUGIN, '..');
const CLIENT_SRC = readFileSync(join(PLUGIN, 'lib', 'client.js'), 'utf8');

const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
const PATCH_ENTRY_RE = /-\s*insert:\s*\r?\n\s*-\s*id:\s*([^\s#]+)\s*\r?\n\s*name:\s*([^\s#]+)/;

/** 两个安装形态的"事实"：包名、patch 里的 Loader 名、客户端导出文件。 */
const FORMS = [
  {
    label: '仓库根 / github 直装',
    dir: ROOT,
    pkg: read(join(ROOT, 'package.json')),
    patch: readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8'),
  },
  {
    label: '子包 / tgz',
    dir: PLUGIN,
    pkg: read(join(PLUGIN, 'package.json')),
    patch: readFileSync(join(PLUGIN, 'cordis.patch.yml'), 'utf8'),
  },
].map((form) => {
  const m = PATCH_ENTRY_RE.exec(form.patch);
  assert.ok(m, `${form.label}：cordis.patch.yml 里找不到 insert 条目`);
  const clientRel = form.pkg.exports?.['./client'];
  assert.equal(typeof clientRel, 'string', `${form.label}：exports["./client"] 必须是字符串`);
  return { ...form, entryId: m[1], entryName: m[2], clientPath: resolve(form.dir, clientRel) };
});

/** 按 dsh 的 load({id, factory}) 语义执行真实 client.js，返回注册的 id。 */
function registeredIds({ scriptSrc } = {}) {
  const ids = [];
  const sandbox = { window: { __ModuleLoader__: { load: (handoff) => ids.push(handoff.id) } } };
  if (scriptSrc) sandbox.document = { currentScript: { src: scriptSrc } };
  vm.runInNewContext(CLIENT_SRC, sandbox, { filename: 'client.js' });
  return ids;
}

test('两种安装形态：manifest 包名 = patch 的 Loader 名 = 客户端导出文件存在', () => {
  const names = FORMS.map((f) => f.pkg.name).sort();
  assert.deepEqual(names, [...PLUGIN_PACKAGE_NAMES].sort(),
    `manifest 包名（${names}）与 packageNames.mjs（${PLUGIN_PACKAGE_NAMES}）不一致`);

  for (const form of FORMS) {
    assert.equal(form.entryName, form.pkg.name,
      `${form.label}：cordis.patch.yml 的 name=${form.entryName} 与 package name=${form.pkg.name} 不一致`);
    assert.equal(form.entryId, 'workbuddy', `${form.label}：Loader 条目 id 应保持 workbuddy`);
    assert.equal(form.pkg.dsh?.client?.platform, 'web', `${form.label}：dsh.client.platform 必须是 web`);
    assert.equal(typeof form.pkg.dsh?.bundle?.patch, 'string', `${form.label}：缺少 dsh.bundle.patch`);
    assert.ok(existsSync(form.clientPath), `${form.label}：客户端 bundle 不存在 ${form.clientPath}`);
  }
});

test('client.js 的固定注册列表必须覆盖且只覆盖两种包名', () => {
  const registered = registeredIds();
  assert.deepEqual([...new Set(registered)].sort(), [...PLUGIN_PACKAGE_NAMES].sort(),
    'client.js 没有按 packageNames.mjs 注册（issue #3 的直接复现）');
});

test('client.js 按真实的 /plugins/<entry>/client.js 加载时注册 Loader 条目名', () => {
  for (const form of FORMS) {
    const registered = registeredIds({
      scriptSrc: `dsh-app://app/plugins/${form.entryName}/client.js?rev=contract`,
    });
    assert.ok(registered.includes(form.entryName),
      `${form.label}：加载 /plugins/${form.entryName}/client.js 后没有注册 "${form.entryName}"（${registered}）`);
  }
});

test('版本号在 manifest / lockfile / OpenAPI / README 之间同步', () => {
  const rootPkg = read(join(ROOT, 'package.json'));
  const subPkg = read(join(PLUGIN, 'package.json'));
  assert.equal(subPkg.version, rootPkg.version, '根包与子包版本必须同步');

  const lock = read(join(ROOT, 'package-lock.json'));
  assert.equal(lock.version, rootPkg.version, 'package-lock.json 根版本不同步');
  assert.equal(lock.packages?.['']?.version, rootPkg.version, 'package-lock.json packages[""].version 不同步');

  const escaped = rootPkg.version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  assert.match(readFileSync(join(ROOT, 'docs', 'openapi.yaml'), 'utf8'),
    new RegExp(`version:\\s*${escaped}\\b`), 'docs/openapi.yaml 的 info.version 不同步');
  assert.ok(readFileSync(join(ROOT, 'README.md'), 'utf8').includes(`dsh-plugin-workbuddy-${rootPkg.version}.tgz`),
    'README 里的 tgz 文件名不是当前版本');
});

test('诊断与预检的包名清单没有各自漂移', () => {
  assert.deepEqual([...NATIVE_PLUGIN_BUNDLES].sort(), [...PLUGIN_PACKAGE_NAMES].sort(),
    'lib/dsh.mjs 的 NATIVE_PLUGIN_BUNDLES 与 packageNames.mjs 不一致');
  for (const name of PLUGIN_PACKAGE_NAMES) {
    const summary = clientGraphSummary({ graph: () => ({ entries: [{ id: name }] }) });
    assert.equal(summary.composed, true, `clientGraphSummary 默认不认 ${name}`);
  }
});
