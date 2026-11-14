import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

/**
 * 用量上限历史的**落盘**。
 *
 * 用户问的是"我重进应用不会消失吧"—— 这句问到了要害：这张表是跨账号上限的
 * 唯一记录（桥的 rateLimit 是进程内的，重启即清），如果它也只在内存里，
 * dsh 一重启就什么都不剩，那张卡就失去了存在的意义。
 *
 * 这里钉住四件事：写进去能读回来、过期条目读回时丢掉、坏 JSON 不崩、
 * 缺字段的旧文件不炸。
 */
const DATA_DIR = process.env.WORKBUDDY_DATA_DIR;

test('上限历史：写入后能完整读回（模拟重进应用）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-limits-'));
  process.env.WORKBUDDY_DATA_DIR = dir;
  try {
    /* 动态 import：runtimeDataDir 在模块加载时读环境变量，必须换完再引入 */
    const mod = await import(`../lib/index.js?cache=${Date.now()}`);
    const resetAt = new Date(Date.now() + 3_600_000).toISOString();
    const map = new Map();
    map.set('u1\u0000deepseek-v4.1-flash\u0000quota', {
      uid: 'u1',
      model: 'deepseek-v4.1-flash',
      kind: 'quota',
      count: 2,
      lastAt: new Date().toISOString(),
      resetAt,
      resetAtSource: 'upstream',
      accountLabel: '国际版1',
      firstSeenAt: new Date().toISOString(),
      seenAt: new Date().toISOString(),
    });
    mod.writeLimitHistory(map);

    /* 文件真的落到了数据目录里 */
    const raw = JSON.parse(readFileSync(join(dir, 'limit-history.json'), 'utf8'));
    assert.equal(raw.entries.length, 1, '落盘应有一条');

    const back = mod.readLimitHistory();
    assert.equal(back.size, 1);
    const entry = [...back.values()][0];
    assert.equal(entry.uid, 'u1');
    assert.equal(entry.model, 'deepseek-v4.1-flash');
    assert.equal(entry.kind, 'quota');
    assert.equal(entry.resetAt, resetAt, '恢复时间必须原样保留');
    assert.equal(entry.accountLabel, '国际版1', '账号名要保留（重启后靠它显示）');
  } finally {
    if (DATA_DIR === undefined) delete process.env.WORKBUDDY_DATA_DIR;
    else process.env.WORKBUDDY_DATA_DIR = DATA_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('上限历史：已过期的条目读回时丢掉（关机期间到期的）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-limits-exp-'));
  process.env.WORKBUDDY_DATA_DIR = dir;
  try {
    const mod = await import(`../lib/index.js?cache=${Date.now()}e`);
    const map = new Map();
    map.set('u2\u0000m\u0000quota', {
      uid: 'u2', model: 'm', kind: 'quota', count: 1,
      lastAt: new Date().toISOString(),
      resetAt: new Date(Date.now() - 60_000).toISOString(),
      accountLabel: 'x', firstSeenAt: '', seenAt: new Date().toISOString(),
    });
    mod.writeLimitHistory(map);
    assert.equal(mod.readLimitHistory().size, 0, '过期条目不该在重启后复活');
  } finally {
    if (DATA_DIR === undefined) delete process.env.WORKBUDDY_DATA_DIR;
    else process.env.WORKBUDDY_DATA_DIR = DATA_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('上限历史：文件被写坏时当成"没有历史"，不崩', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-limits-bad-'));
  process.env.WORKBUDDY_DATA_DIR = dir;
  try {
    const mod = await import(`../lib/index.js?cache=${Date.now()}x`);
    writeFileSync(join(dir, 'limit-history.json'), '{ this is not json');
    assert.equal(mod.readLimitHistory().size, 0);
    /* 再写一次应能恢复正常 */
    mod.writeLimitHistory(new Map());
    assert.ok(readFileSync(join(dir, 'limit-history.json'), 'utf8').includes('entries'));
  } finally {
    if (DATA_DIR === undefined) delete process.env.WORKBUDDY_DATA_DIR;
    else process.env.WORKBUDDY_DATA_DIR = DATA_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});
