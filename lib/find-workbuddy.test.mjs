/**
 * find-workbuddy 的单元测试。
 *
 *   node --test lib/find-workbuddy.test.mjs
 *
 * 全部用例**自包含**：不依赖测试机是否真的装了 WorkBuddy。用到真实文件系统的
 * 用例都在临时目录里构造"假安装现场"；env 注入（WORKBUDDY_APP_EXECUTABLE）
 * 让探测在最优先层就收敛，不触碰真实磁盘与注册表。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  extractExePathsFromSignals,
  findWorkBuddyExe,
  staticWorkBuddyExeCandidates,
} from './find-workbuddy.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'wb-find-'));
const setEnv = (value) => {
  const prev = process.env.WORKBUDDY_APP_EXECUTABLE;
  if (value === undefined) delete process.env.WORKBUDDY_APP_EXECUTABLE;
  else process.env.WORKBUDDY_APP_EXECUTABLE = value;
  return () => {
    if (prev === undefined) delete process.env.WORKBUDDY_APP_EXECUTABLE;
    else process.env.WORKBUDDY_APP_EXECUTABLE = prev;
  };
};

test('信号提取：进程/图标/协议直认 + 卸载器目录回退 + 无关项忽略', () => {
  const dir = tmp();
  try {
    const exe = join(dir, 'WorkBuddy.exe');
    const uninst = join(dir, 'Uninstall WorkBuddy.exe');
    writeFileSync(exe, '');
    writeFileSync(uninst, '');
    const noDir = join(tmpdir(), 'wb-no-such-dir-xyz');

    const got = extractExePathsFromSignals({
      procs: [exe],
      reg: [
        { icon: `${exe},0` }, // 图标形态：尾部带 ",0"
        { uninst: `"${uninst}" /currentuser` }, // 卸载器：目录回退
        { cmd: `"${exe}" "%1"` }, // 深链协议形态
        { uninst: `"${join(noDir, 'Uninstall.exe')}" /currentuser` }, // 目录不存在 → 忽略
      ],
    });
    assert.deepEqual(got, [exe]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('信号提取：单元素（标量）形态不退化 —— ConvertTo-Json 单元素坑', () => {
  // PowerShell 5.1 会把 ["a"] 序列化成 "a"。单客户端机器上 procs / reg
  // 恰好可能只有一个元素——两个字段都用标量输入验证归一化。
  const dir = tmp();
  try {
    const exe = join(dir, 'WorkBuddyAI.exe');
    writeFileSync(exe, '');
    const got = extractExePathsFromSignals({
      procs: exe, // 字符串而非数组
      reg: { icon: `${exe},0` }, // 对象而非数组
    });
    assert.deepEqual(got, [exe]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('信号提取：空 / 缺字段 / 空数组输入均安全', () => {
  assert.deepEqual(extractExePathsFromSignals(undefined), []);
  assert.deepEqual(extractExePathsFromSignals({}), []);
  assert.deepEqual(extractExePathsFromSignals({ procs: [], reg: [] }), []);
});

test('信号提取：多客户端并存时全部提取（供 keyId 挑选 build）', () => {
  const a = tmp();
  const b = tmp();
  try {
    const intl = join(a, 'WorkBuddy.exe'); // 国际版
    const cn = join(b, 'WorkBuddyAI.exe'); // 国内版
    writeFileSync(intl, '');
    writeFileSync(cn, '');
    const got = extractExePathsFromSignals({ procs: [intl, cn] });
    assert.deepEqual(got, [intl, cn], '两个 build 都要保留，顺序不变');
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

test('静态候选：env 覆盖最优先，且 Win 下含 exe 名变体', () => {
  const restore = setEnv('X:\\custom-place\\WorkBuddy.exe');
  try {
    const list = staticWorkBuddyExeCandidates();
    assert.equal(list[0], 'X:\\custom-place\\WorkBuddy.exe');
    if (process.platform === 'win32') {
      assert.ok(list.some((p) => /WorkBuddyAI\.exe$/i.test(p)), '应含国内版 exe 名变体');
      assert.ok(list.some((p) => /CodeBuddy\.exe$/i.test(p)), '应含旧名变体');
    }
  } finally {
    restore();
  }
});

test('findWorkBuddyExe：env 命中最优先；文件被删后不复用陈旧缓存', () => {
  const dir = tmp();
  const fake = join(dir, 'WorkBuddy.exe');
  writeFileSync(fake, '');
  const restore = setEnv(fake);
  try {
    assert.equal(findWorkBuddyExe(), fake, 'env 覆盖应命中');
    // 模拟"客户端被卸载/移走"：删掉文件。此后不得再返回这个陈旧路径。
    // （后续可能命中测试机真实客户端、也可能全落空——两种都算通过。）
    rmSync(fake, { force: true });
    assert.notEqual(findWorkBuddyExe(), fake, '陈旧命中不得复用');
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});
