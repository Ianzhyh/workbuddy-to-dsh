/**
 * find-dsh 的单元测试。
 *
 *   node --test lib/find-dsh.test.mjs
 *
 * 全部用例自包含：在临时目录里构造"假 DSH 安装现场"（两种布局各一种），
 * 不依赖测试机是否真的装了 DeepSeek Harness。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  extractDshRuntimeFromSignals,
  findDshRuntime,
  looksLikeDshRuntime,
  staticDshRuntimeCandidates,
} from './find-dsh.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'dsh-find-'));

/** 造一个 DSH Desktop 形态的假安装根，返回其 resources/runtime 路径。 */
function makeDesktopLayout(root) {
  const runtime = join(root, 'resources', 'runtime');
  mkdirSync(join(runtime, 'primary-runtime'), { recursive: true });
  writeFileSync(join(runtime, 'primary-runtime', 'runtime.json'), '{"desktopVersion":"0.0.0-test"}');
  return runtime;
}

/** 造一个独立安装形态的假 runtime。 */
function makeStandaloneLayout(root) {
  const runtime = join(root, 'runtime');
  mkdirSync(join(runtime, 'node_modules', '@deepseek-ai', 'dsh'), { recursive: true });
  writeFileSync(join(runtime, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), '{"version":"0.0.0-test"}');
  return runtime;
}

const setEnv = (value) => {
  const prev = process.env.DSH_RUNTIME;
  if (value === undefined) delete process.env.DSH_RUNTIME;
  else process.env.DSH_RUNTIME = value;
  return () => {
    if (prev === undefined) delete process.env.DSH_RUNTIME;
    else process.env.DSH_RUNTIME = prev;
  };
};

test('特征校验：两种布局都认，杂目录与空值都不认', () => {
  const a = tmp();
  const b = tmp();
  const c = tmp();
  try {
    const desktop = makeDesktopLayout(a); // DSH Desktop 形态
    const standalone = makeStandaloneLayout(b); // 独立安装形态
    assert.equal(looksLikeDshRuntime(desktop), true);
    assert.equal(looksLikeDshRuntime(standalone), true);
    assert.equal(looksLikeDshRuntime(c), false, '空目录不是 runtime');
    assert.equal(looksLikeDshRuntime(''), false, '空串不能拼出相对路径去误判');
    assert.equal(looksLikeDshRuntime(undefined), false);
    assert.equal(looksLikeDshRuntime(join(a, 'resources')), false, '父目录不是 runtime');
  } finally {
    for (const d of [a, b, c]) rmSync(d, { recursive: true, force: true });
  }
});

test('信号提取：进程 exe / 图标 / 卸载器 / InstallLocation 都推导到 runtime', () => {
  const root = tmp();
  try {
    const runtime = makeDesktopLayout(root);
    const exe = join(root, 'DeepSeek Harness.exe');
    writeFileSync(exe, '');

    // 进程镜像路径 → 取目录 → resources\runtime
    assert.deepEqual(extractDshRuntimeFromSignals({ procs: [exe] }), [runtime]);

    // 注册表三形态：图标（带 ,0）/ 卸载器（同目录）/ InstallLocation（裸目录）
    const got = extractDshRuntimeFromSignals({
      reg: [
        { icon: `${exe},0` },
        { uninst: `"${join(root, 'Uninstall DeepSeek Harness.exe')}" /currentuser` },
        { loc: root },
      ],
    });
    assert.deepEqual(got, [runtime], '三种形态推导出同一个 runtime，且去重');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('信号提取：单元素（标量）形态不退化；无关目录被忽略', () => {
  const root = tmp();
  const other = tmp();
  try {
    const runtime = makeStandaloneLayout(root);
    const exe = join(root, 'DeepSeek Harness.exe');
    writeFileSync(exe, '');
    // procs 是字符串而非数组（ConvertTo-Json 单元素退化的真实形态）
    assert.deepEqual(extractDshRuntimeFromSignals({ procs: exe }), [runtime]);
    // 指向一个普通目录（没有 runtime 结构）→ 不产出候选
    assert.deepEqual(extractDshRuntimeFromSignals({ procs: [join(other, 'random.exe')] }), []);
    assert.deepEqual(extractDshRuntimeFromSignals(undefined), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  }
});

test('静态候选：DSH_RUNTIME 最优先', () => {
  const restore = setEnv('X:\\custom-dsh\\resources\\runtime');
  try {
    assert.equal(staticDshRuntimeCandidates()[0], 'X:\\custom-dsh\\resources\\runtime');
  } finally {
    restore();
  }
});

test('findDshRuntime：env 命中最优先；结构被破坏后不复用陈旧缓存', () => {
  const root = tmp();
  try {
    const runtime = makeDesktopLayout(root);
    const restore = setEnv(runtime);
    try {
      assert.equal(findDshRuntime(), runtime, 'env 覆盖应命中');
      // 模拟"DSH 被卸载/移动"：破坏特征（删运行时清单）
      rmSync(join(runtime, 'primary-runtime', 'runtime.json'), { force: true });
      // 此后不得再返回这个已失效的路径（可能命中测试机真实 DSH，也可能落空）
      assert.notEqual(findDshRuntime(), runtime, '陈旧命中不得复用');
    } finally {
      restore();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
