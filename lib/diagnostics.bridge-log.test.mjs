/**
 * 桥日志尾部读取：内容正确性与缓存失效。
 *
 * 控制台每 3 秒轮询一次；缓存必须按 size + mtime 失效，否则日志面板会停在
 * 第一次读到的内容。这里用临时文件驱动，不碰真实 bridge.log。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readBridgeLog } from './diagnostics.mjs';

test('readBridgeLog 读取尾部，并在追加/截断后更新', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-bridgelog-'));
  const file = join(dir, 'bridge.log');
  try {
    writeFileSync(file, 'one\ntwo\n');
    assert.deepEqual(readBridgeLog(10, { file }), ['one', 'two']);
    // 相同内容再次读取（命中缓存）仍返回同样结果
    assert.deepEqual(readBridgeLog(10, { file }), ['one', 'two']);

    appendFileSync(file, 'three\n');
    // 强制推进 mtime，避免同一毫秒内写入导致指纹不变
    const future = new Date(Date.now() + 1000);
    utimesSync(file, future, future);
    assert.deepEqual(readBridgeLog(2, { file }), ['two', 'three']);

    writeFileSync(file, '');
    assert.deepEqual(readBridgeLog(10, { file }), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readBridgeLog currentOnly 只保留最后一次启动横幅之后的内容', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-bridgelog-'));
  const file = join(dir, 'bridge.log');
  try {
    writeFileSync(file, [
      'old',
      'listening on http://127.0.0.1:8790',
      'old request',
      'listening on http://127.0.0.1:8791',
      'new request',
    ].join('\n'));
    assert.deepEqual(readBridgeLog(10, { file, currentOnly: true }), [
      'listening on http://127.0.0.1:8791',
      'new request',
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
