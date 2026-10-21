/**
 * 桥日志滚动（文档承诺：每次启动桥时检查，超过 2MB 滚动为 bridge.log.1）。
 *
 * 回归背景：控制台拉起桥时会滚动，但**插件**拉起桥的路径只 append、从不滚动，
 * dsh 用户长期运行后 bridge.log 会无限增长（本机实测已 1.27MB）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BRIDGE_LOG_MAX_BYTES, rotateLogIfNeeded } from '../lib/bridge.mjs';

test('超过上限：滚到 .1，原文件让位', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-logrot-'));
  try {
    const file = join(dir, 'bridge.log');
    writeFileSync(file, 'x'.repeat(BRIDGE_LOG_MAX_BYTES + 1));
    rotateLogIfNeeded(file);
    assert.equal(existsSync(file), false, '超过上限后原日志应被改名');
    assert.equal(existsSync(`${file}.1`), true, '应留下 bridge.log.1');
    assert.equal(statSync(`${file}.1`).size, BRIDGE_LOG_MAX_BYTES + 1, '滚动后内容不能丢');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('未超上限 / 文件不存在：不动文件也不抛', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-logrot-'));
  try {
    const file = join(dir, 'bridge.log');
    writeFileSync(file, 'small');
    rotateLogIfNeeded(file);
    assert.equal(existsSync(file), true, '未超上限不应滚动');
    assert.equal(existsSync(`${file}.1`), false);
    assert.doesNotThrow(() => rotateLogIfNeeded(join(dir, 'missing.log')), '文件不存在时不应抛');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('已有 .1：新一轮滚动覆盖旧快照（只保留一份）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-logrot-'));
  try {
    const file = join(dir, 'bridge.log');
    writeFileSync(`${file}.1`, 'old');
    writeFileSync(file, 'y'.repeat(BRIDGE_LOG_MAX_BYTES + 2));
    rotateLogIfNeeded(file);
    assert.equal(statSync(`${file}.1`).size, BRIDGE_LOG_MAX_BYTES + 2, '.1 应被新快照覆盖');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
