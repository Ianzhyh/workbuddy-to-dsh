/**
 * 「同一个账号的多份登录文件只显示一行」——`foldAccountSnapshots()` 的单测。
 *
 *   node --test lib/diagnostics.fold.test.mjs
 *
 * ## 缺陷现场
 *
 * WorkBuddy 客户端每次「登出」会把旧的 `.info` 改名成快照留在登录目录里。
 * 桥/控制台按文件列账号，于是同一个 uin 会显示成两三行 —— 用户原话是
 * "有的账号重复记录"、"不要让我看到两个一样的账号出现"。
 *
 * 这个函数是**列表展示的最后一层**：把同一账号的多份文件合并成一行，
 * 代表行挑选规则是 生效中 > 可用 > 最近 > 文件名。合并只影响展示，
 * 登录目录里的文件一个都不动（切换仍按代表行选中的那份文件走）。
 *
 * 单测直接喂造好的条目 —— 不读登录目录、不碰 WorkBuddy 客户端。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { foldAccountSnapshots } from './diagnostics.mjs';

const T0 = 1_760_000_000_000;

/** 造一个登录文件条目（字段与 listAccountFiles() 的产出一致）。 */
function entry(name, account, extra = {}) {
  return {
    name,
    path: `C:\\auth\\${name}`,
    active: false,
    usable: true,
    account,
    domain: 'www.workbuddy.cn',
    encrypted: true,
    expiresAt: T0 + 30 * 86400000,
    remainingMs: 30 * 86400000,
    modifiedAt: T0,
    aliasKey: account,
    alias: '',
    hidden: false,
    ...extra,
  };
}

const names = (list) => list.map((a) => a.name);

test('同一个账号的两份登录文件合并成一行，并记下文件数', () => {
  const out = foldAccountSnapshots([
    entry('a.info', '330'),
    entry('a.2026-10-12.info', '330'),
    entry('b.info', '450'),
  ]);
  assert.equal(out.length, 2, '两个账号 → 两行');
  const a = out.find((x) => x.aliasKey === '330');
  assert.ok(a, '330 那一行还在');
  assert.equal(a.sameAccount, 2, 'sameAccount 记的是同一账号的文件数');
  assert.equal(out.filter((x) => x.aliasKey === '330').length, 1, '同一账号不能出现两行');
  assert.deepEqual(names(out.filter((x) => x.aliasKey === '450')), ['b.info'], '另一个账号不受影响');
});

test('代表行挑选：生效中 > 可用 > 最近', () => {
  // 生效中的那份即使更旧也留下 —— 它才是桥正在读的文件
  const activeOld = foldAccountSnapshots([
    entry('old-active.info', '330', { active: true, modifiedAt: T0 - 5000 }),
    entry('new.info', '330', { modifiedAt: T0 }),
  ]);
  assert.equal(activeOld[0].name, 'old-active.info', '生效中的那份必须是代表行');

  // 没有生效中时"能用"优先于"更新"：坏掉的新快照占第一行会让人以为账号废了
  const usableOld = foldAccountSnapshots([
    entry('broken-new.info', '330', { usable: false, modifiedAt: T0, error: '另一个 build 写入' }),
    entry('usable-old.info', '330', { modifiedAt: T0 - 5000 }),
  ]);
  assert.equal(usableOld[0].name, 'usable-old.info', '可用的旧快照要排在不可用的新快照前面');

  // 都可用：最近修改的优先；完全同时间用文件名兜底（结果可复现）
  const newest = foldAccountSnapshots([
    entry('a-1.info', '330', { modifiedAt: T0 - 5000 }),
    entry('a-2.info', '330', { modifiedAt: T0 }),
  ]);
  assert.equal(newest[0].name, 'a-2.info', '两份都快照时选最近修改的');
});

test('一个账号只有一份文件时 sameAccount = 1', () => {
  const out = foldAccountSnapshots([entry('only.info', '330')]);
  assert.equal(out.length, 1);
  assert.equal(out[0].sameAccount, 1);
});

test('隐藏是"整行"的语义：任意一份快照被隐藏，这一行就算隐藏', () => {
  const out = foldAccountSnapshots([
    entry('a-new.info', '330', { modifiedAt: T0 }),
    entry('a-old.info', '330', { hidden: true, modifiedAt: T0 - 5000 }),
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].hidden, true, '同一账号的另一份文件被隐藏时，整行显示为隐藏（服务端恢复时会把整组一起恢复）');
});

test('不同账号不会被合并（uin 相同也不行时按 aliasKey 分）', () => {
  const out = foldAccountSnapshots([
    entry('a.info', '330', { aliasKey: 'uin-330' }),
    entry('b.info', '330', { aliasKey: 'uin-450' }), // 极端情况：两个键不同
  ]);
  assert.equal(out.length, 2, '键不同就是两个账号');
});

test('aliasKey 缺失时的兜底键：account → userId → 文件名', () => {
  const out = foldAccountSnapshots([
    { name: 'x.info', account: '330', active: false, usable: true, modifiedAt: T0 },
    { name: 'y.info', account: '330', active: true, usable: true, modifiedAt: T0 - 1 },
    { name: 'u1.info', userId: 'uid-1', account: '', active: false, usable: true, modifiedAt: T0 },
    { name: 'u2.info', userId: 'uid-1', account: '', active: false, usable: true, modifiedAt: T0 },
  ]);
  assert.equal(out.length, 2, 'account 相同 → 一行；userId 相同 → 一行');
  assert.equal(out.find((x) => x.account === '330').name, 'y.info', '生效中的那份是代表行');
});

test('自定义顺序按组生效：rank 可能是组里任意一份文件的名字（老数据）', () => {
  const accounts = [
    entry('a.info', '330'),
    entry('b.info', '450'),
    entry('c.info', '660'),
  ];
  // 老版本每份快照都能单独排：这里 rank 落在同组但非代表行的文件上
  const dup = entry('a.old.info', '330', { modifiedAt: T0 - 1000 });
  const list = [...accounts, dup];
  const rank = new Map([['a.old.info', 2], ['c.info', 0], ['b.info', 1]]);
  const out = foldAccountSnapshots(list, rank);
  assert.deepEqual(names(out), ['c.info', 'b.info', 'a.info'], '组顺序按 rank；rank 落在被合并的那份文件上也认');
});

test('没排过序时按 生效中 → 可用 → 最近 排组', () => {
  const out = foldAccountSnapshots([
    entry('idle.info', '330', { modifiedAt: T0 }),
    entry('active.info', '450', { active: true, modifiedAt: T0 - 9000 }),
    entry('usable.info', '660', { modifiedAt: T0 + 1000 }),
  ]);
  assert.deepEqual(names(out), ['active.info', 'usable.info', 'idle.info']);
});

test('默认参数：不传 rank 也能跑（listAccounts 之外没有状态可读的场景）', () => {
  const out = foldAccountSnapshots([entry('a.info', '330'), entry('b.info', '450')]);
  assert.equal(out.length, 2);
});
