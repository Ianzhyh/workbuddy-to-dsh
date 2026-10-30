/**
 * 切号失败必须**回滚并如实报告**（1.20.0）。
 *
 * 原实现无论桥起没起来都回 `switched:true`：面板显示"已切换"，实际还在旧账号，
 * 最坏情况桥是停着的。这里用注入的 deps 精确控制每一步的成败，钉住：
 *   写 state 失败 → 不动桥；停桥失败 → 回滚 state；起桥失败 / 账号不符 →
 *   回滚 state 并用旧账号恢复；原本没跑 → 失败后保持停止。
 * 顺带钉住生命周期串行：并发两次切号不能交错。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { switchDesktopAccount } = await import('../../dashboard/server.mjs');

const ACCOUNTS = [
  { name: 'a.info', path: '/auth/a.info', usable: true, userId: 'u1', account: '111' },
  { name: 'b.info', path: '/auth/b.info', usable: true, userId: 'u2', account: '222' },
];

function makeHarness(overrides = {}) {
  let state = { authFile: '/auth/a.info', authFileDesktopUid: 'u1', authFilePinnedAt: 't0' };
  const calls = [];
  const applyPatch = (patch) => {
    const next = { ...state };
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || v === null) delete next[k];
      else next[k] = v;
    }
    state = next;
  };
  const deps = {
    listAccountFiles: async () => ({ accounts: ACCOUNTS.map((a) => ({ ...a })), desktopUid: 'desktop-uid' }),
    bridgeHealth: async () => ({ running: true, ok: true, body: { auth: { userId: 'u1' } } }),
    stopBridgeAndWait: async () => { calls.push('stop'); return { stopped: true, pid: 10 }; },
    startBridgeAndWait: async (opts = {}) => {
      calls.push(`start:${opts.authFile || '(default)'}`);
      return { started: true, reused: false, pid: 11, health: { auth: { userId: 'u2' } } };
    },
    readState: () => ({ ...state }),
    writeStateStrict: (patch) => { applyPatch(patch); },
    writeState: (patch) => { applyPatch(patch); },
    clearProbeResults: () => {},
    invalidateQuotaCache: () => {},
    ...overrides,
  };
  return { deps, calls, state: () => ({ ...state }) };
}

test('切号成功：先写 state，再停旧桥、起新桥', async () => {
  const h = makeHarness();
  const out = await switchDesktopAccount('b.info', h.deps);
  assert.equal(out.switched, true, out.error);
  assert.equal(out.restarted, true);
  assert.equal(h.state().authFile, '/auth/b.info');
  assert.deepEqual(h.calls, ['stop', 'start:/auth/b.info']);
});

test('写 state 失败：桥一点都不动，并如实返回失败', async () => {
  const h = makeHarness({
    writeStateStrict: () => { throw new Error('disk full'); },
  });
  const out = await switchDesktopAccount('b.info', h.deps);
  assert.equal(out.switched, false);
  assert.match(out.error, /无法写入账号选择.*disk full/);
  assert.deepEqual(h.calls, [], '写不进状态就不该停桥');
  assert.equal(h.state().authFile, '/auth/a.info');
});

test('停桥失败：回滚 state，不起新桥', async () => {
  const h = makeHarness({
    stopBridgeAndWait: async () => ({ stopped: false, error: 'pid 10 在 8 秒内没有退出' }),
  });
  const out = await switchDesktopAccount('b.info', h.deps);
  assert.equal(out.switched, false);
  assert.match(out.error, /旧桥没能停下来/);
  assert.deepEqual(h.calls, []);
  assert.equal(h.state().authFile, '/auth/a.info', 'state 必须回到原值');
});

test('新账号起不来：回滚 state 并用旧账号恢复，结果不是成功', async () => {
  const h = makeHarness({
    startBridgeAndWait: async (opts = {}) => {
      h.calls.push(`start:${opts.authFile || '(default)'}`);
      if (opts.authFile === '/auth/b.info') {
        return { started: false, error: '新进程启动失败：EADDRINUSE' };
      }
      return { started: true, reused: true, health: { auth: { userId: 'u1' } } };
    },
  });
  const out = await switchDesktopAccount('b.info', h.deps);
  assert.equal(out.switched, false);
  assert.equal(out.rolledBack, true);
  assert.match(out.error, /EADDRINUSE/);
  assert.match(out.error, /已恢复原账号/);
  assert.deepEqual(h.calls, ['stop', 'start:/auth/b.info', 'start:/auth/a.info']);
  assert.equal(h.state().authFile, '/auth/a.info');
  assert.equal(h.state().authFileDesktopUid, 'u1');
});

test('桥起来了但登录的是别的账号（目标文件被客户端换号覆盖）：按失败回滚', async () => {
  const h = makeHarness({
    startBridgeAndWait: async (opts = {}) => {
      h.calls.push(`start:${opts.authFile || '(default)'}`);
      return { started: true, reused: false, health: { auth: { userId: opts.authFile === '/auth/b.info' ? 'u1' : 'u1' } } };
    },
  });
  const out = await switchDesktopAccount('b.info', h.deps);
  assert.equal(out.switched, false);
  assert.match(out.error, /账号与目标不一致/);
  assert.equal(h.state().authFile, '/auth/a.info');
});

test('原本桥没跑：失败后保持停止（不顺手用旧账号起一个用户没要求的桥）', async () => {
  const h = makeHarness({
    bridgeHealth: async () => ({ running: false, ok: false }),
    startBridgeAndWait: async (opts = {}) => {
      h.calls.push(`start:${opts.authFile || '(default)'}`);
      return { started: false, error: '新进程启动失败' };
    },
  });
  const out = await switchDesktopAccount('b.info', h.deps);
  assert.equal(out.switched, false);
  assert.deepEqual(h.calls, ['start:/auth/b.info'], '只尝试过新账号，没有额外拉起旧账号');
  assert.equal(h.state().authFile, '/auth/a.info');
});

test('并发两次切号必须串行（停/起不交错），最终状态与最后一次一致', async () => {
  const events = [];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let targetUid = 'u1';
  const h = makeHarness({
    stopBridgeAndWait: async () => {
      events.push('stop:begin');
      await sleep(40);
      events.push('stop:end');
      return { stopped: true };
    },
    startBridgeAndWait: async (opts = {}) => {
      events.push(`start:begin:${opts.authFile}`);
      await sleep(40);
      events.push(`start:end:${opts.authFile}`);
      targetUid = opts.authFile === '/auth/b.info' ? 'u2' : 'u1';
      return { started: true, reused: false, health: { auth: { userId: targetUid } } };
    },
  });
  const [first, second] = await Promise.all([
    switchDesktopAccount('b.info', h.deps),
    switchDesktopAccount('a.info', h.deps),
  ]);
  assert.equal(first.switched, true, first.error);
  assert.equal(second.switched, true, second.error);
  /*
   * 串行 = 每一段 begin/end 成对相邻；交错的话会出现
   *   stop:begin, stop:begin, stop:end, stop:end …
   */
  for (let i = 0; i < events.length; i += 2) {
    const [begin, end] = [events[i], events[i + 1]];
    assert.match(begin, /:begin/);
    assert.match(end, /:end/);
    assert.equal(begin.replace(':begin', ''), end.replace(':end', ''),
      `第 ${i / 2 + 1} 段操作被交错：${events.join(' | ')}`);
  }
  assert.equal(h.state().authFile, '/auth/a.info', '最终状态应是最后一次切换的账号');
});
