/**
 * findPortPid() 的回归用例。
 *
 *   node --test dsh-plugin/tests/consolePortPid.test.mjs
 *
 * 钉两件事：
 *   1. 探测命令**必须忽略 stdin** —— 默认 `'pipe'` 时，Windows/Electron 宿主里
 *      spawnSync 可能直接返回 EBUSY（同 index.js 的 icacls 教训），而插件要靠
 *      findPortPid 找到旧控制台的监听 PID；
 *   2. 端口匹配不能被子串骗到（18792 不是 8792）。
 *
 * 用假 spawn 断言参数与解析，不启动真实进程。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { findPortPid } from '../lib/console.mjs';

/** 记录每次 spawn 的入参，并返回预设结果。 */
function recorder(result) {
  const calls = [];
  const spawn = (exe, args, opts) => {
    calls.push({ exe, args, opts });
    return result;
  };
  return { calls, spawn };
}

test('Windows：走 System32 绝对路径、忽略 stdin、只认精确端口', () => {
  const stdout = [
    '  TCP    0.0.0.0:18792        0.0.0.0:0              LISTENING       1111',
    '  TCP    127.0.0.1:8792       0.0.0.0:0              LISTENING       4321',
    '  TCP    [::]:8793             [::]:0                 LISTENING       2222',
  ].join('\r\n');
  const { calls, spawn } = recorder({ status: 0, stdout, stderr: '', error: undefined });

  const pid = findPortPid(8792, { platform: 'win32', spawn });

  assert.equal(pid, 4321, '18792 不能被当成 8792');
  assert.equal(calls.length, 1);
  assert.match(calls[0].exe, /System32[\\/]netstat\.exe$/i, '必须用绝对路径，不依赖 PATH');
  assert.deepEqual(calls[0].opts.stdio, ['ignore', 'pipe', 'pipe'], 'stdin 必须 ignore');
  assert.equal(calls[0].opts.windowsHide, true);
  assert.ok(calls[0].opts.timeout > 0, '探测必须有超时');
});

test('POSIX：走 lsof，同样忽略 stdin', () => {
  const { calls, spawn } = recorder({ status: 0, stdout: '4321\n', stderr: '', error: undefined });

  const pid = findPortPid(8792, { platform: 'linux', spawn });

  assert.equal(pid, 4321);
  assert.equal(calls[0].exe, 'lsof');
  assert.deepEqual(calls[0].opts.stdio, ['ignore', 'pipe', 'pipe']);
});

test('命令失败 / 无监听者 / 输出异常一律返回 null（不抛）', () => {
  const opts = { platform: 'linux' };
  assert.equal(findPortPid(8792, {
    ...opts, spawn: () => ({ status: 1, stdout: '', stderr: '', error: undefined }),
  }), null, '非零退出 = 没有结果');
  assert.equal(findPortPid(8792, {
    ...opts, spawn: () => ({ status: 0, stdout: '4321\n', stderr: '', error: { code: 'EBUSY' } }),
  }), null, 'spawn 失败必须如实返回 null，不能拿 stdout 猜');
  assert.equal(findPortPid(8792, {
    ...opts, spawn: () => ({ status: 0, stdout: 'not-a-pid\n', stderr: '', error: undefined }),
  }), null, '输出不是 PID');
  assert.equal(findPortPid(8792, {
    platform: 'win32',
    spawn: () => ({ status: 0, stdout: '  TCP 0.0.0.0:8792 0.0.0.0:0 LISTENING x\r\n', stderr: '', error: undefined }),
  }), null, 'LISTENING 行尾不是 PID');
});
