/**
 * `.state.json` 账号钉住的校正逻辑（issue #6）。
 *
 * 纯文件 + 纯文本登录文件（不调 Electron / 不碰真实凭据），验证：
 *   - 桌面账号没变 → 保留用户钉住的快照；
 *   - 桌面账号变了 → 解除钉住，跟随桌面；
 *   - 旧状态没有 uid → 按"快照账号 ≠ 桌面账号"迁移一次；
 *   - 旧状态同账号 → 补记元数据，不解除。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'wb-account-pin-'));
const desktopPath = join(dir, 'workbuddy-desktop.info');
const snapshotPath = join(dir, 'workbuddy-desktop.2026-01-01T00-00-00-000Z.1.abc.info');
process.env.WORKBUDDY_AUTH_FILE = desktopPath;
process.env.WORKBUDDY_STATE_FILE = join(dir, '.state.json');

const { reconcileAccountPin } = await import('./diagnostics.mjs');
const { writeState, clearState } = await import('./state.mjs');

function fakeJwt(sub) {
  const body = Buffer.from(JSON.stringify({ sub, exp: Math.floor(Date.now() / 1000) + 86_400 }), 'utf8').toString('base64url');
  return `e30.${body}.sig`;
}

function writeAuth(path, sub) {
  writeFileSync(path, JSON.stringify({
    auth: {
      accessToken: fakeJwt(sub),
      refreshToken: 'refresh',
      domain: 'example.invalid',
      expiresAt: Date.now() + 30 * 86_400_000,
    },
  }));
}

function reset({ pinnedUid, desktopUid, recordedUid }) {
  clearState();
  writeAuth(desktopPath, desktopUid);
  writeAuth(snapshotPath, pinnedUid);
  const state = { authFile: snapshotPath };
  if (recordedUid !== undefined) state.authFileDesktopUid = recordedUid;
  writeState(state);
}

test('桌面账号未变：保留钉住的快照', async () => {
  reset({ pinnedUid: 'account-a', desktopUid: 'account-a', recordedUid: 'account-a' });
  const result = await reconcileAccountPin();
  assert.equal(result.changed, false);
  assert.equal(result.reason, '');
});

test('桌面端换号：解除钉住并返回旧快照路径', async () => {
  reset({ pinnedUid: 'account-a', desktopUid: 'account-b', recordedUid: 'account-a' });
  const result = await reconcileAccountPin();
  assert.equal(result.changed, true);
  assert.equal(result.reason, 'desktop-switched');
  assert.equal(result.previousPin, snapshotPath);
});

test('旧状态（没有 uid 元数据）且账号不同：迁移一次并跟随桌面', async () => {
  reset({ pinnedUid: 'account-a', desktopUid: 'account-b' });
  const result = await reconcileAccountPin();
  assert.equal(result.changed, true);
  assert.equal(result.reason, 'legacy-pin-desktop-switched');
});

test('旧状态（没有 uid 元数据）但同账号：补记元数据，不解除', async () => {
  reset({ pinnedUid: 'account-a', desktopUid: 'account-a' });
  const result = await reconcileAccountPin();
  assert.equal(result.changed, false);
  assert.equal(result.reason, 'legacy-pin-adopted');
});

test('钉住的快照已不存在：解除钉住', async () => {
  reset({ pinnedUid: 'account-a', desktopUid: 'account-a', recordedUid: 'account-a' });
  rmSync(snapshotPath);
  const result = await reconcileAccountPin();
  assert.equal(result.changed, true);
  assert.equal(result.reason, 'pinned-file-missing');
});
