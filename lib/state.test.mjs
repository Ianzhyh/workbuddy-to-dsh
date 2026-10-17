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
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearState, effectiveAuthFile, readAccountAliases, readAccountOrder, readHiddenAccounts, readState, statePath, writeAccountAlias, writeAccountHidden, writeAccountOrder, writeState } from './state.mjs';

/*
 * **指向临时文件，不要碰仓库根那份真实状态。**
 *
 * 默认路径是 `config.paths.root/.state.json`，也就是运行时真实状态 —— 而控制台 /
 * 插件在跑的时候会**周期性写它**，于是「删掉再断言不存在」的用例会被 live 进程
 * 重新创建出来而偶发失败（实测：单独跑 test:lib 全过，放进 release:check 链里偶发红，
 * 失败时连重试删除都删不掉 —— 因为不是锁，是有人在写）。
 *
 * `statePath()` 每次调用都读环境变量，所以在这里设就生效（ESM 的 import 会被提升，
 * 没法在导入前设）。
 */
process.env.WORKBUDDY_STATE_FILE = join(tmpdir(), `wb-state-test-${process.pid}.json`);

/** 备份现有状态文件，用完恢复。 */
function withStateBackup(body) {
  const existed = existsSync(statePath());
  const backup = existed ? readFileSync(statePath(), 'utf8') : null;
  try {
    clearState(); // 每个用例从干净状态开始
    body();
  } finally {
    if (backup !== null) writeFileSync(statePath(), backup, 'utf8');
    else clearState();
  }
}

test('writeState → readState 往返，且落盘内容与内存一致', () => {
  withStateBackup(() => {
    writeState({ authFile: '/tmp/a.info', checkin: { auto: true } });
    const read = readState();
    assert.equal(read.authFile, '/tmp/a.info');
    assert.deepEqual(read.checkin, { auto: true }, '嵌套对象必须完整保留');

    const onDisk = JSON.parse(readFileSync(statePath(), 'utf8'));
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
    writeFileSync(statePath(), '{"authFile": "/tmp/a.info", "check');
    clearState();
    writeFileSync(statePath(), '{"authFile": "/tmp/a.info", "check');
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
      writeFileSync(statePath(), bad);
      clearState();
      writeFileSync(statePath(), bad);
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
    assert.equal(existsSync(`${statePath()}.tmp`), false, '临时文件必须在 rename 后消失');
    assert.doesNotThrow(() => JSON.parse(readFileSync(statePath(), 'utf8')),
      '落盘内容必须始终是完整 JSON（这正是原子写要保证的）');
  });
});

test('clearState 删掉文件后，读回是空对象', () => {
  withStateBackup(() => {
    writeState({ authFile: '/tmp/a.info' });
    assert.equal(existsSync(statePath()), true);
    clearState();
    assert.equal(existsSync(statePath()), false, 'clearState 必须真的删掉文件');
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

// ── 账号自定义名字 ──────────────────────────────────────────────────────

test('账号名字：写入 / 覆盖 / 读回', () => {
  withStateBackup(() => {
    assert.deepEqual(readAccountAliases(), {}, '初始为空表');
    assert.deepEqual(writeAccountAlias('330000000001', '工作号'), { '330000000001': '工作号' });
    assert.deepEqual(readAccountAliases(), { '330000000001': '工作号' }, '必须落盘并能读回');
    writeAccountAlias('330000000002', '个人号');
    writeAccountAlias('330000000001', '公司号'); // 覆盖
    assert.deepEqual(readAccountAliases(), { '330000000001': '公司号', '330000000002': '个人号' });
  });
});

test('账号名字：传空 = 删掉这个名字，且不靠"文件名"当键', () => {
  withStateBackup(() => {
    writeAccountAlias('330000000001', '工作号');
    writeAccountAlias('330000000001', '');
    assert.deepEqual(readAccountAliases(), {}, '空名字必须把这一项删掉');
    // 键是账号标识（uin），与登录文件名无关 —— 客户端换账号会原地覆盖同名文件，
    // 按文件名记账会把名字贴到另一个账号上
    writeAccountAlias('workbuddy-desktop.info', 'A');
    writeAccountAlias('330000000009', 'B');
    assert.deepEqual(Object.keys(readAccountAliases()).sort(), ['330000000009', 'workbuddy-desktop.info'],
      '两者都是合法的键（前者是 uin 读不出时的兜底），互不覆盖');
  });
});

test('账号名字：全删光时不留一个空的 accountAliases 键', () => {
  withStateBackup(() => {
    writeState({ authFile: '/tmp/keep.info' });
    writeAccountAlias('330000000001', '工作号');
    writeAccountAlias('330000000001', '');
    const raw = JSON.parse(readFileSync(statePath(), 'utf8'));
    assert.equal('accountAliases' in raw, false, '.state.json 里不该留下空对象');
    assert.equal(raw.authFile, '/tmp/keep.info', '删名字不能动别的键');
  });
});

test('账号名字：空白折叠 + 截断 24 字，空键直接忽略', () => {
  withStateBackup(() => {
    writeAccountAlias('k', '  工\t作\n号  ');
    assert.equal(readAccountAliases().k, '工 作 号', '内部空白要折叠成一个空格');
    writeAccountAlias('k', 'x'.repeat(50));
    assert.equal(readAccountAliases().k.length, 24, '过长要截断（列表里放不下）');
    const before = readAccountAliases();
    assert.deepEqual(writeAccountAlias('', '无主'), before, '空键不写任何东西（表原样返回）');
    writeAccountAlias('k', null);
    assert.deepEqual(readAccountAliases(), {}, 'null 与空串同义（都算删除）');
  });
});

// ── 账号顺序 / 隐藏 ────────────────────────────────────────────────────

test('账号顺序：写入去重、传空 = 清掉回到默认排序', () => {
  withStateBackup(() => {
    assert.deepEqual(readAccountOrder(), []);
    assert.deepEqual(writeAccountOrder(['b.info', 'a.info', 'b.info']), ['b.info', 'a.info'],
      '同一个文件重复出现只保留第一次（顺序由行决定，重复项没有意义）');
    writeAccountOrder(['a.info']);
    assert.deepEqual(readAccountOrder(), ['a.info'], '再次写入整体替换，不是追加');
    assert.deepEqual(writeAccountOrder([]), [], '空数组 = 清掉');
    const raw = JSON.parse(readFileSync(statePath(), 'utf8'));
    assert.equal('accountOrder' in raw, false, '清掉后不该在 .state.json 里留空数组');
  });
});

test('账号隐藏：写入 / 恢复 / 全恢复后不留空键', () => {
  withStateBackup(() => {
    writeState({ authFile: '/tmp/keep.info' });
    assert.deepEqual(readHiddenAccounts(), []);
    writeAccountHidden('a.info', true);
    writeAccountHidden('b.info', true);
    assert.deepEqual(readHiddenAccounts(), ['a.info', 'b.info']);
    writeAccountHidden('a.info', false);
    assert.deepEqual(readHiddenAccounts(), ['b.info'], '恢复 = 从表里删掉这一项');
    writeAccountHidden('b.info', false);
    const raw = JSON.parse(readFileSync(statePath(), 'utf8'));
    assert.equal('hiddenAccounts' in raw, false, '全部恢复后不该留一个空数组');
    assert.equal(raw.authFile, '/tmp/keep.info', '隐藏/恢复不能动别的键');
    assert.deepEqual(writeAccountHidden('', true), [], '空文件名不写任何东西');
  });
});

test('账号顺序/隐藏：文件里被写成非数组时当空处理，不抛异常', () => {
  withStateBackup(() => {
    writeState({ accountOrder: '坏了', hiddenAccounts: { a: 1 } });
    assert.deepEqual(readAccountOrder(), []);
    assert.deepEqual(readHiddenAccounts(), []);
  });
});
test('账号名字：文件里被写成非对象（数组 / 数字 / 字符串）时不抛异常', () => {
  withStateBackup(() => {
    writeState({ accountAliases: ['坏数据'] });
    assert.deepEqual(readAccountAliases(), {}, '非对象一律当空表，不能让页面 500');
    writeState({ accountAliases: { a: 1, b: 'ok', c: '' } });
    assert.deepEqual(readAccountAliases(), { b: 'ok' }, '只保留非空的字符串值');
  });
});
