/**
 * `.state.json` 读写测试。
 *
 * 这个文件此前是**零直接单测**（64 行，触碰率 ~5%），但它承载账号选择、
 * 签到开关、体检结论三类状态 —— 写坏一次，用户的选择会被静默丢掉。
 *
 * 隔离方式：`config.paths.root` 由 `import.meta.url` 推导（= 仓库根），**不跟随 cwd**，
 * 所以没法用临时目录骗过它。这里改为「每个用例前备份、后恢复真实 `.state.json`」——
 * 该文件是运行时产物且已在 `.gitignore` 里，但仍然不能留下副作用。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { clearState, effectiveAuthFile, readState, statePath, writeState } from './state.mjs';

/** 备份现有状态文件，用完恢复。 */
function withStateBackup(body) {
  const existed = existsSync(statePath);
  const backup = existed ? readFileSync(statePath, 'utf8') : null;
  try {
    clearState(); // 每个用例从干净状态开始
    body();
  } finally {
    if (backup !== null) writeFileSync(statePath, backup, 'utf8');
    else clearState();
  }
}

test('writeState → readState 往返，且落盘内容与内存一致', () => {
  withStateBackup(() => {
    writeState({ authFile: '/tmp/a.info', checkin: { auto: true } });
    const read = readState();
    assert.equal(read.authFile, '/tmp/a.info');
    assert.deepEqual(read.checkin, { auto: true }, '嵌套对象必须完整保留');

    const onDisk = JSON.parse(readFileSync(statePath, 'utf8'));
    assert.deepEqual(onDisk, read, '盘上内容必须与内存一致');
  });
});

test('writeState 是合并语义：未 patch 的键保留，null 的键被删除', () => {
  withStateBackup(() => {
    writeState({ authFile: '/tmp/a.info', probe: { x: 1 } });
    writeState({ authFile: null });

    const read = readState();
    assert.ok(!('authFile' in read), 'null 的键必须被移除，不能留下 "authFile": null');
    assert.deepEqual(read.probe, { x: 1 }, '未被 patch 的键必须保留');
  });
});

test('文件被外部写坏（半截 JSON）时静默退回空状态，不抛异常', () => {
  withStateBackup(() => {
    // 模拟「进程写到一半被杀」留下的残缺文件；顺序同上一用例（先清 cache 再写坏）
    writeFileSync(statePath, '{"authFile": "/tmp/a.info", "check');
    clearState();
    writeFileSync(statePath, '{"authFile": "/tmp/a.info", "check');
    let threw = false;
    let s;
    try { s = readState(); } catch { threw = true; }
    assert.equal(threw, false, '损坏的状态文件不能让调用方抛异常（否则控制台整个起不来）');
    assert.deepEqual(s, {}, '损坏时应退回空状态');
  });
});

test('文件内容是非对象（数组 / 数字 / null / 字符串）时也退回空状态', () => {
  /*
   * `load()` 有模块级 cache，所以坏内容必须在**cache 为空**时被读到。
   * 手法：先写坏盘上的文件 → 用 clearState() 把 cache 置空并删除文件 →
   * 再把坏内容写回去 → 此时 readState() 必然走磁盘分支。
   */
  for (const bad of ['[1,2,3]', '42', 'null', '"str"']) {
    withStateBackup(() => {
      writeFileSync(statePath, bad);
      clearState();
      writeFileSync(statePath, bad);
      const s = readState();
      assert.equal(typeof s, 'object');
      assert.ok(!Array.isArray(s), `${bad} 不应被当成合法状态`);
      assert.deepEqual(s, {}, `${bad} 应退回空对象`);
    });
  }
});

test('连续写入始终落盘为完整 JSON，且不残留临时文件', () => {
  withStateBackup(() => {
    for (let i = 0; i < 20; i++) writeState({ n: i, pad: 'x'.repeat(500) });
    assert.equal(readState().n, 19, '最后一次写入必须生效');
    assert.equal(existsSync(`${statePath}.tmp`), false, '临时文件必须在 rename 后消失');
    assert.doesNotThrow(() => JSON.parse(readFileSync(statePath, 'utf8')),
      '落盘内容必须始终是完整 JSON（这正是原子写要保证的）');
  });
});

test('clearState 删掉文件后，读回是空对象', () => {
  withStateBackup(() => {
    writeState({ authFile: '/tmp/a.info' });
    assert.equal(existsSync(statePath), true);
    clearState();
    assert.equal(existsSync(statePath), false, 'clearState 必须真的删掉文件');
    assert.deepEqual(readState(), {});
  });
});

test('effectiveAuthFile：运行时选择优先，未选时回落到配置探测值', () => {
  withStateBackup(() => {
    assert.equal(typeof effectiveAuthFile(), 'string', '没有选择时必须回落到配置值（字符串）');
    writeState({ authFile: '/tmp/chosen.info' });
    assert.equal(effectiveAuthFile(), '/tmp/chosen.info', '写过选择后必须用选择值');
  });
});
