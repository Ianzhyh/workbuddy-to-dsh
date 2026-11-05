/**
 * `bundlesAllInstalled()` 的用例 —— 「空 = 未知，未知不等于健康」。
 *
 *   node --test lib/dsh.test.mjs
 *
 * 为什么要单独钉这一条：`[].every(...)` 在 JS 里返回 `true`，所以只要
 * 「插件列表读不出来」这条路径一旦走到（profile 目录缺失、解析异常被 catch 吞掉），
 * 原来的写法就会把「什么都没检查」报成「健康」。这类 bug 不会报错、也不会崩，
 * 只会让用户看着一个绿点以为一切正常 —— 只有用例能拦住。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  bundleHealth, bundlesAllInstalled, collectBundles, detectNativeRoute,
  dshInstallLayout, isCoreBundle, isOptionalBundle, readAsarHeader, resolveBundle,
} from './dsh.mjs';

test('bundlesAllInstalled：空列表不算健康（读不到 ≠ 都装好了）', () => {
  assert.equal(bundlesAllInstalled([]), false, '空数组必须判为 false —— 这是本用例存在的唯一理由');
});

test('bundlesAllInstalled：非数组输入一律 false', () => {
  for (const bad of [null, undefined, 'x', 0, {}]) {
    assert.equal(bundlesAllInstalled(bad), false, `${JSON.stringify(bad)} 应当判为 false`);
  }
});

test('bundlesAllInstalled：全装好为 true，缺一个为 false', () => {
  assert.equal(bundlesAllInstalled([{ installed: true }, { installed: true }]), true);
  assert.equal(bundlesAllInstalled([{ installed: true }, { installed: false }]), false);
});

test('bundlesAllInstalled：可选实验 bundle 缺失不算不健康（issue #1）', () => {
  assert.equal(bundlesAllInstalled([
    { name: '@deepseek-ai/dsh-base', installed: true },
    { name: '@deepseek-ai/dsh-experimental-agent-team-profile', installed: false, optional: true },
  ]), true, '只有可选 bundle 缺失时不能把整体判成不健康');
  assert.equal(bundlesAllInstalled([
    { name: '@deepseek-ai/dsh-base', installed: false },
    { name: '@deepseek-ai/dsh-experimental-agent-team-profile', installed: false, optional: true },
  ]), false, '必需 bundle 缺失仍然必须判为不健康');
  assert.equal(isOptionalBundle('@deepseek-ai/dsh-experimental-voice-input-bundle'), true);
  assert.equal(isOptionalBundle('@deepseek-ai/dsh-base'), false);
});

test('detectNativeRoute：插件 bundle 已装且未被 patch 关闭 → 原生路由生效', () => {
  const bundles = [
    { name: '@deepseek-ai/dsh-base', installed: true },
    { name: 'dsh-plugin-workbuddy', installed: true },
  ];
  const off = detectNativeRoute('', bundles);
  assert.deepEqual(off, {
    installed: true,
    enabled: true,
    disabledByPatch: false,
    provider: 'workbuddy',
    bundle: 'dsh-plugin-workbuddy',
  });
});

test('detectNativeRoute：patch 里 disabled: true 必须判为未启用', () => {
  const bundles = [{ name: 'workbuddy-to-dsh', installed: true }];
  const patch = [
    '- id: workbuddy',
    '  disabled: true',
    '- id: subagent',
  ].join('\n');
  const r = detectNativeRoute(patch, bundles);
  assert.equal(r.installed, true);
  assert.equal(r.disabledByPatch, true);
  assert.equal(r.enabled, false);
});

test('detectNativeRoute：bundle 没装 / 不在 bundles 列表 → 不构成原生路由', () => {
  assert.equal(detectNativeRoute('', []).enabled, false);
  assert.equal(detectNativeRoute('', [{ name: 'dsh-plugin-workbuddy', installed: false }]).enabled, false);
  assert.equal(detectNativeRoute('', [{ name: 'some-other-plugin', installed: true }]).enabled, false);
});

test('detectNativeRoute：config 里同名字段 / 注释行不能误判成关闭', () => {
  const bundles = [{ name: 'dsh-plugin-workbuddy', installed: true }];
  const patch = [
    '- id: workbuddy',
    '  config:',
    '    disabled: true',
    '    items:',
    '      - a',
    '  # disabled: true',
  ].join('\n');
  assert.equal(detectNativeRoute(patch, bundles).enabled, true, '只有条目级 disabled 才生效');

  const real = [
    '- id: workbuddy',
    '  config:',
    '    items:',
    '      - a',
    '  disabled: true',
  ].join('\n');
  assert.equal(detectNativeRoute(real, bundles).enabled, false, 'config 里的缩进列表不能提前结束条目');
});

// ── issue #26：打包安装（app.asar）与悬空安装链接 ──────────────────────────
//
// 这两条原先都把「看得见的 bundle」判成不存在：`existsSync` 穿不透 asar 归档，
// 也不解析悬空 junction。后果不是崩溃，而是**诊断报红 + 给出有害的修法**
// （让用户往 profile 里 pnpm add 一个安装自带的核心 bundle）。用例钉的就是这个。

/** 造一个只含索引头的 asar —— 本项目只读头部，不需要真的写入文件内容。 */
function writeFakeAsar(file, tree) {
  const json = Buffer.from(JSON.stringify({ files: tree }), 'utf8');
  const pad = (4 - (json.length % 4)) % 4;
  const headerSize = 8 + json.length + pad;
  const buf = Buffer.alloc(8 + headerSize);
  buf.writeUInt32LE(4, 0); // pickle 头自身长度
  buf.writeUInt32LE(headerSize, 4);
  buf.writeUInt32LE(headerSize - 4, 8);
  buf.writeUInt32LE(json.length, 12);
  json.copy(buf, 16);
  writeFileSync(file, buf);
}

/** 临时目录 + 自动清理。 */
function withTmp(prefix, fn) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const pkgNode = { files: { 'package.json': { size: 2, offset: '0' } } };
const asarTreeWith = (...names) => {
  const nodeModules = { files: {} };
  for (const name of names) {
    const segs = name.split('/');
    let cursor = nodeModules;
    for (const seg of segs.slice(0, -1)) {
      cursor.files[seg] = cursor.files[seg] || { files: {} };
      cursor = cursor.files[seg];
    }
    cursor.files[segs[segs.length - 1]] = pkgNode;
  }
  return { dsh: { files: { node_modules: nodeModules } } };
};

test('readAsarHeader：按真实 asar 的头部格式读出索引', () => {
  withTmp('wb-asar-', (dir) => {
    const asar = join(dir, 'app.asar');
    writeFakeAsar(asar, asarTreeWith('@deepseek-ai/dsh-base'));
    const r = readAsarHeader(asar);
    assert.equal(r.ok, true, '索引必须读得出来');
    assert.ok(r.files.dsh.files.node_modules.files['@deepseek-ai'], '作用域目录要在索引里');
  });
});

test('readAsarHeader：不是 asar 的文件必须如实失败（不能当成"里面没有"）', () => {
  withTmp('wb-asar-bad-', (dir) => {
    const bad = join(dir, 'app.asar');
    writeFileSync(bad, Buffer.alloc(64, 0xff));
    const r = readAsarHeader(bad);
    assert.equal(r.ok, false);
    assert.ok(r.reason, '失败必须带原因，调用方要据此判「无法确认」');
  });
});

test('dshInstallLayout：打包安装（有 app.asar、没 node_modules）要认出来', () => {
  withTmp('wb-layout-', (dir) => {
    const runtime = join(dir, 'resources', 'runtime');
    mkdirSync(join(runtime, 'primary-runtime'), { recursive: true });
    writeFileSync(join(runtime, 'primary-runtime', 'runtime.json'), '{"desktopVersion":"0.2.1-rc.5"}');
    writeFakeAsar(join(dir, 'resources', 'app.asar'), asarTreeWith('@deepseek-ai/dsh-base'));
    const install = dshInstallLayout(runtime);
    assert.equal(install.layout, 'packed');
    assert.equal(install.asarPath, join(dir, 'resources', 'app.asar'));
  });
});

test('resolveBundle：打包安装的 app.asar 内的核心 bundle 判为已安装（issue #26 主因）', () => {
  withTmp('wb-packed-', (dir) => {
    const runtime = join(dir, 'resources', 'runtime');
    mkdirSync(join(runtime, 'primary-runtime'), { recursive: true });
    writeFileSync(join(runtime, 'primary-runtime', 'runtime.json'), '{}');
    writeFakeAsar(join(dir, 'resources', 'app.asar'),
      asarTreeWith('@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'));

    const bundles = collectBundles(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'], {
      runtime, home: join(dir, 'home'), profileDir: join(dir, 'profile'),
    });
    assert.deepEqual(bundles.map((b) => [b.name, b.installed, b.source]), [
      ['@deepseek-ai/dsh-base', true, 'asar'],
      ['@deepseek-ai/dsh-web-app', true, 'asar'],
    ]);
    assert.equal(bundleHealth(bundles).status, 'ok', '确认在 asar 里就是 ok，不许报红');
    assert.equal(bundleHealth(bundles).packed, 2, '要在界面说明「随安装提供」的来源');
  });
});

test('resolveBundle：asar 里确实没有 → 仍然报缺失（别把修复变成"永远绿"）', () => {
  withTmp('wb-packed-miss-', (dir) => {
    const runtime = join(dir, 'resources', 'runtime');
    mkdirSync(join(runtime, 'primary-runtime'), { recursive: true });
    writeFakeAsar(join(dir, 'resources', 'app.asar'), asarTreeWith('@deepseek-ai/dsh-base'));
    const r = resolveBundle('@deepseek-ai/dsh-web-app', {
      runtime, home: join(dir, 'home'), profileDir: join(dir, 'profile'),
    });
    assert.equal(r.installed, false);
    assert.equal(r.source, 'missing');
    assert.notEqual(r.unverified, true, 'asar 读得出来 = 能证实缺失');
  });
});

test('resolveBundle：悬空 junction 判为「链接失效」，不是「已安装」也不是「缺失」', () => {
  withTmp('wb-link-', (dir) => {
    const target = join(dir, 'gone');
    const link = join(dir, 'home', 'profiles', 'node_modules', '@deepseek-ai', 'dsh-base');
    mkdirSync(target, { recursive: true });
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    rmSync(target, { recursive: true, force: true }); // 临时目录被系统清理 → 悬空

    const r = resolveBundle('@deepseek-ai/dsh-base', { home: join(dir, 'home') });
    assert.equal(r.installed, false);
    assert.equal(r.source, 'broken-link');
    assert.ok(String(r.linkTarget).includes('gone'), '要把失效目标带出来，用户才知道该删哪条');

    const health = bundleHealth([r]);
    assert.equal(health.status, 'warn', '悬空链接不证明 dsh 起不来，不能报 fail');
    assert.equal(health.brokenLinks.length, 1);
    assert.equal(health.reallyMissing.length, 0);
  });
});

test('resolveBundle：有效的符号链接算已安装（用户的 pnpm 布局就是这么来的）', () => {
  withTmp('wb-link-ok-', (dir) => {
    const target = join(dir, 'store', 'dsh-whale-widget');
    const link = join(dir, 'profile', 'node_modules', 'dsh-whale-widget');
    mkdirSync(target, { recursive: true });
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');

    const r = resolveBundle('dsh-whale-widget', { profileDir: join(dir, 'profile') });
    assert.equal(r.installed, true);
    assert.equal(r.source, 'profile');
    assert.ok(r.linkTarget, '链接要记下目标（排查"指向别处"时有用）');
  });
});

test('resolveBundle：安装布局看不懂时，核心 bundle 判「无法确认」而不是「缺失」', () => {
  withTmp('wb-unknown-', (dir) => {
    // runtime 认得出（有 runtime.json），但既没有 node_modules 也没有 app.asar
    const runtime = join(dir, 'resources', 'runtime');
    mkdirSync(join(runtime, 'primary-runtime'), { recursive: true });
    writeFileSync(join(runtime, 'primary-runtime', 'runtime.json'), '{}');

    const core = resolveBundle('@deepseek-ai/dsh-base', {
      runtime, home: join(dir, 'home'), profileDir: join(dir, 'profile'),
    });
    assert.equal(core.installed, false);
    assert.equal(core.unverified, true, '判不了就说判不了 —— 这是本 issue 的核心诉求');
    assert.equal(bundleHealth([core]).status, 'warn', '无法确认不能报红');

    const third = resolveBundle('dsh-whale-widget', {
      runtime, home: join(dir, 'home'), profileDir: join(dir, 'profile'),
    });
    assert.equal(third.unverified, undefined, '第三方 bundle 由用户自己装，缺失就是缺失');
    assert.equal(bundleHealth([third]).status, 'fail');
  });
});

test('bundleHealth / bundlesAllInstalled：三档结论与「未知不算健康、也不算不健康」', () => {
  assert.equal(bundleHealth([]).status, 'warn', '读不到 profile 不等于健康');
  assert.equal(bundlesAllInstalled([]), false);

  const ok = [{ name: 'a', installed: true, optional: false, source: 'runtime' }];
  assert.equal(bundleHealth(ok).status, 'ok');

  const optionalOnly = [...ok, { name: '@deepseek-ai/dsh-experimental-x', installed: false, optional: true, source: 'missing' }];
  assert.equal(bundleHealth(optionalOnly).status, 'warn');
  assert.equal(bundlesAllInstalled(optionalOnly), true, '可选实验 bundle 不影响就绪度');

  const hardMissing = [...ok, { name: 'b', installed: false, optional: false, source: 'missing' }];
  assert.equal(bundleHealth(hardMissing).status, 'fail');

  const unverified = [...ok, { name: '@deepseek-ai/dsh-base', installed: false, optional: false, source: 'missing', unverified: true }];
  assert.equal(bundleHealth(unverified).status, 'warn', '无法确认 = 黄，不是红');
  assert.equal(bundleHealth(unverified).reallyMissing.length, 0);
  assert.equal(bundlesAllInstalled(unverified), true, '概览不能显示「待修复」—— 用户没有可修的东西');
  assert.equal(bundlesAllInstalled(hardMissing), false, '确认缺失仍然必须判为不健康');
});

test('isCoreBundle：只有随安装提供的 @deepseek-ai/dsh-* 算核心，实验包不算', () => {
  assert.equal(isCoreBundle('@deepseek-ai/dsh-base'), true);
  assert.equal(isCoreBundle('@deepseek-ai/dsh-web-app'), true);
  assert.equal(isCoreBundle('@deepseek-ai/dsh-experimental-voice-input-bundle'), false);
  assert.equal(isCoreBundle('dsh-plugin-workbuddy'), false);
  assert.equal(isCoreBundle(''), false);
});
