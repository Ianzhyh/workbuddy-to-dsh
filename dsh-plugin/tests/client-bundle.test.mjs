/**
 * 客户端 bundle 的注册契约（issue #3）。
 *
 * dsh 的 web boot 用 **Loader 条目的包名** 作为客户端模块 id，加载
 * `/plugins/<包名>/client.js` 后要求 `window.__ModuleLoader__.load({id})`
 * 注册的正是这个 id，否则判定 `import failed`，整个应用起不来。
 *
 * 本插件有两种安装形态、两个包名，却共用同一份 client.js：
 *   - 单文件夹分发：dsh-plugin-workbuddy
 *   - github 直装：  workbuddy-to-dsh
 *
 * 这里直接执行真实的 client.js，模拟 dsh 的 arrive/materialize 规则，钉住：
 *   1. 两个包名都必须注册；
 *   2. 从 <script> URL 读到的实际 id 也要注册（将来改包名不用再改 bundle）；
 *   3. 两种形态同时安装时，第二次注册的重复错误不能把 boot 打断。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import { clientGraphSummary } from '../lib/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, '..', 'lib', 'client.js'), 'utf8');

/** 一个和 dsh `ClientModuleSystem` 同语义的最小注册表。 */
function makeLoader() {
  const factories = new Map();
  const registrations = [];
  return {
    factories,
    registrations,
    window: {
      __ModuleLoader__: {
        load(handoff) {
          registrations.push(handoff.id);
          if (factories.has(handoff.id)) {
            throw new Error(`client-modules: duplicate factory registration for "${handoff.id}"`);
          }
          if (typeof handoff.factory !== 'function') {
            throw new Error(`bundle registered "${handoff.id}" without a factory`);
          }
          factories.set(handoff.id, handoff.factory);
        },
      },
    },
  };
}

function runBundle(loader, { src, href } = {}) {
  const sandbox = { window: loader.window, URL };
  if (src === undefined) {
    // 默认不提供 document/location：模拟单测里直接 eval bundle 的非浏览器环境。
  } else {
    sandbox.document = { currentScript: { src } };
    sandbox.location = { href };
  }
  vm.runInNewContext(SRC, sandbox, { filename: 'client.js' });
}

/** dsh `arrive(row)` 的断言：bundle 加载完必须能用图里的 id 找到 factory。 */
function assertArrived(loader, id) {
  assert.ok(loader.factories.has(id), `加载 /plugins/${id}/client.js 后没有注册 "${id}"`);
}

test('client bundle 同时注册两种安装形态的包名', () => {
  const loader = makeLoader();
  runBundle(loader);
  assertArrived(loader, 'dsh-plugin-workbuddy');
  assertArrived(loader, 'workbuddy-to-dsh');
  // 两个 id 指向同一份 factory：行为不会因安装形态而分叉
  assert.equal(loader.factories.get('dsh-plugin-workbuddy').name, loader.factories.get('workbuddy-to-dsh').name);
});

test('client bundle 从 <script> URL 识别实际包名（别名/改包名也能启动）', () => {
  const loader = makeLoader();
  runBundle(loader, {
    src: 'dsh-app://app/plugins/my-workbuddy-fork/client.js?rev=abc123',
    href: 'dsh-app://app/',
  });
  assertArrived(loader, 'my-workbuddy-fork');
  // 固定两份仍在：旧引导图/本地壳不经过 /plugins/<id>/client.js 时也能用
  assertArrived(loader, 'dsh-plugin-workbuddy');
  assertArrived(loader, 'workbuddy-to-dsh');
});

test('旧版 dsh 的合并 URL（/plugins/??<id>/client.js&rev=）也能读出 id', () => {
  const loader = makeLoader();
  runBundle(loader, {
    src: 'dsh-app://app/plugins/??my-fork/client.js&rev=abc123',
    href: 'dsh-app://app/',
  });
  assertArrived(loader, 'my-fork');
});

test('两种安装形态同时存在：重复注册被忽略，boot 不失败', () => {
  const loader = makeLoader();
  runBundle(loader);
  assert.doesNotThrow(() => runBundle(loader), '第二份 bundle 的重复注册不应抛出');
  assert.deepEqual([...loader.factories.keys()].sort(), ['dsh-plugin-workbuddy', 'workbuddy-to-dsh']);
});

test('非重复的注册错误仍然抛出（不吞掉真实故障）', () => {
  const loader = makeLoader();
  loader.window.__ModuleLoader__.load = () => { throw new Error('client-modules: something else broke'); };
  assert.throws(() => runBundle(loader), /something else broke/);
});

test('clientGraphSummary 认两种安装形态的包名', () => {
  const summary = (id) => clientGraphSummary({ graph: () => ({ entries: [{ id }] }) });
  assert.equal(summary('dsh-plugin-workbuddy').composed, true);
  assert.equal(summary('workbuddy-to-dsh').composed, true);
  assert.equal(summary('some-other-plugin').composed, false);
});
