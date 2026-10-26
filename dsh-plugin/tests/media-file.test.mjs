/**
 * 产物落盘（media-file）的合约测试。
 *
 * 这块逻辑直接碰文件系统与网络，出错方式都不是「抛个异常」那么干净：
 * 半个文件被当成完整产物、失败留下 `.part` 垃圾、`../` 把文件写到目录外。
 * 所以这里的用例都对着**真实文件系统**跑，只把网络与时钟打桩。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

import {
  DEFAULT_MAX_DOWNLOAD_BYTES,
  formatBytes,
  mediaFileName,
  pickExtension,
  resolveTargetPath,
  safeIdFragment,
  saveMediaFile,
} from '../../dsh-plugin/lib/media-file.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'wb-media-file-'));

test('文件名：时间前缀 + 清洗过的 id + 扩展名', () => {
  const at = new Date(2026, 9, 26, 9, 30, 15).getTime();
  assert.equal(
    mediaFileName({ id: '1312831544-WandVideo-3a0e', kind: 'video', now: at }),
    'video-20261026-093015-1312831544-WandVideo-3a0e.mp4',
  );
  assert.equal(
    mediaFileName({ id: 'img_1', kind: 'image', mimeType: 'image/png', now: at }),
    'image-20261026-093015-img_1.png',
  );
});

test('文件名：id 里的路径分隔符与 ../ 不能逃出目标目录', () => {
  assert.equal(safeIdFragment('../../etc/passwd'), 'etc-passwd');
  assert.equal(safeIdFragment('a:b/c\\d'), 'a-b-c-d');
  assert.equal(safeIdFragment('   '), 'task');
  assert.equal(safeIdFragment(''), 'task');
  const name = mediaFileName({ id: '../../evil', kind: 'video', now: 0 });
  assert.equal(name.includes('..'), false, `文件名不能含 ..：${name}`);
  assert.equal(name.includes('/'), false);
  assert.equal(name.includes('\\'), false);
});

test('扩展名：mime 优先，其次 URL，最后按类型兜底', () => {
  assert.equal(pickExtension({ mimeType: 'video/mp4' }), '.mp4');
  assert.equal(pickExtension({ mimeType: 'image/jpeg; charset=binary' }), '.jpg');
  assert.equal(pickExtension({ url: 'https://cdn.example/a.MOV?sign=x' }), '.mov');
  assert.equal(pickExtension({ url: 'https://cdn.example/a', kind: 'image' }), '.png');
  // 绝不把 .html / .exe 之类当产物扩展名
  assert.equal(pickExtension({ url: 'https://cdn.example/a.html', kind: 'video' }), '.mp4');
  assert.equal(pickExtension({ url: 'https://cdn.example/a.exe', kind: 'image' }), '.png');
});

test('save_to：目录 / 不存在的目录 / 完整文件路径三种语义', async () => {
  const dir = tmp();
  try {
    // 已存在的目录
    const a = await resolveTargetPath({ saveTo: dir, fileName: 'x.mp4' });
    assert.equal(a.dir, dir);
    assert.equal(a.file, join(dir, 'x.mp4'));

    // 还不存在的目录：没有扩展名就当目录
    const pending = join(dir, 'out');
    const b = await resolveTargetPath({ saveTo: pending, fileName: 'x.mp4' });
    assert.equal(b.dir, pending);
    assert.equal(b.file, join(pending, 'x.mp4'));

    // 完整文件名：保留用户选的路径
    const c = await resolveTargetPath({ saveTo: join(dir, 'custom.mp4'), fileName: 'x.mp4' });
    assert.equal(c.file, join(dir, 'custom.mp4'));

    // 已存在的无扩展名文件：它是文件，不是目录（否则 mkdir 会失败）
    const extensionless = join(dir, 'README');
    writeFileSync(extensionless, 'keep');
    const d = await resolveTargetPath({ saveTo: extensionless, fileName: 'x.mp4' });
    assert.equal(d.file, extensionless);
    assert.equal(d.isDir, false);

    // 相对路径直接拒绝（工具会拿到 dsh 进程的 cwd，猜目录没有意义）
    await assert.rejects(() => resolveTargetPath({ saveTo: 'out', fileName: 'x.mp4' }), /absolute/);
    await assert.rejects(() => resolveTargetPath({ saveTo: '   ', fileName: 'x.mp4' }), /empty/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const stubFetch = (body, init = {}) => async () => new Response(body, {
  status: init.status ?? 200,
  headers: { 'content-type': init.contentType ?? 'video/mp4', ...(init.headers || {}) },
});

test('落盘：成功时内容完整、目录自动创建、不留 .part', async () => {
  const dir = tmp();
  try {
    const payload = Buffer.from('MP4'.repeat(5000));
    const target = join(dir, 'nested', 'deeper');
    const result = await saveMediaFile(
      { url: 'https://cdn.example/v.mp4', saveTo: target, id: 'task-1', kind: 'video' },
      { fetchImpl: stubFetch(payload) },
    );
    assert.equal(result.bytes, payload.length);
    assert.equal(readFileSync(result.path).length, payload.length);
    assert.equal(result.path.startsWith(target), true);
    assert.deepEqual(readdirSync(target).filter((f) => f.endsWith('.part')), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('落盘：非 https / 上游错误 / 空产物 都不留垃圾文件', async () => {
  const dir = tmp();
  try {
    await assert.rejects(
      () => saveMediaFile({ url: 'ftp://x/y.mp4', saveTo: dir }, { fetchImpl: stubFetch('x') }),
      /non-https/,
    );
    await assert.rejects(
      () => saveMediaFile({ url: 'https://x/y.mp4', saveTo: dir }, { fetchImpl: stubFetch('no', { status: 403 }) }),
      /HTTP 403/,
    );
    await assert.rejects(
      () => saveMediaFile({ url: 'https://x/y.mp4', saveTo: dir }, { fetchImpl: stubFetch(Buffer.alloc(0)) }),
      /empty/,
    );
    assert.deepEqual(readdirSync(dir), [], `失败不应留下文件：${readdirSync(dir).join(', ')}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('落盘：超过上限时中止，且不留下半截文件', async () => {
  const dir = tmp();
  try {
    // 声明的 content-length 超限 → 还没开始写就拒绝
    await assert.rejects(
      () => saveMediaFile(
        { url: 'https://x/big.mp4', saveTo: dir },
        {
          fetchImpl: stubFetch(Buffer.alloc(64), { headers: { 'content-length': String(DEFAULT_MAX_DOWNLOAD_BYTES + 1) } }),
          maxBytes: 1024,
        },
      ),
      /too large/,
    );

    // 没有 content-length：流式写入过程中发现超限，同样要清干净
    await assert.rejects(
      () => saveMediaFile(
        { url: 'https://x/big2.mp4', saveTo: dir },
        { fetchImpl: () => Promise.resolve(new Response(Buffer.alloc(8192))), maxBytes: 1024 },
      ),
      /too large/,
    );
    assert.deepEqual(readdirSync(dir), [], `失败不应留下文件：${readdirSync(dir).join(', ')}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('落盘：save_to 指向一个已存在的同名文件时会覆盖它', async () => {
  const dir = tmp();
  try {
    const target = join(dir, 'fixed.mp4');
    writeFileSync(target, 'OLD');
    const result = await saveMediaFile(
      { url: 'https://cdn.example/v.mp4', saveTo: target },
      { fetchImpl: stubFetch(Buffer.from('NEW-CONTENT')) },
    );
    assert.equal(result.path, target);
    assert.equal(readFileSync(target).toString(), 'NEW-CONTENT');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('formatBytes：B / KB / MB 三档', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2.0 KB');
  assert.equal(formatBytes(3 * 1024 * 1024), '3.0 MB');
  assert.equal(formatBytes(undefined), '0 B');
});

test('文件名里的分隔符不会让 join 产生越界路径', async () => {
  const dir = tmp();
  try {
    const result = await saveMediaFile(
      { url: 'https://cdn.example/v.mp4', saveTo: dir, id: '../../../etc/passwd' },
      { fetchImpl: stubFetch(Buffer.from('x')) },
    );
    assert.equal(result.path.startsWith(dir + sep), true, `必须落在目标目录内：${result.path}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('目录落盘：同一任务多个产物同一秒写入也不会互相覆盖', async () => {
  const dir = tmp();
  const at = new Date(2026, 9, 26, 9, 30, 15).getTime();
  try {
    const first = await saveMediaFile(
      { url: 'https://cdn.example/a.mp4', saveTo: dir, id: 'task-multi', kind: 'video', index: 0 },
      { fetchImpl: stubFetch(Buffer.from('FIRST')), now: () => at },
    );
    const second = await saveMediaFile(
      { url: 'https://cdn.example/b.mp4', saveTo: dir, id: 'task-multi', kind: 'video', index: 1 },
      { fetchImpl: stubFetch(Buffer.from('SECOND')), now: () => at },
    );
    assert.notEqual(first.path, second.path);
    assert.equal(readFileSync(first.path).toString(), 'FIRST');
    assert.equal(readFileSync(second.path).toString(), 'SECOND');
    assert.equal(readdirSync(dir).length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('目录落盘：不与已存在的同名文件争夺，序号顺延', async () => {
  const dir = tmp();
  const at = new Date(2026, 9, 26, 9, 30, 15).getTime();
  try {
    const name = mediaFileName({ id: 'task-1', kind: 'video', now: at });
    const existing = join(dir, name);
    writeFileSync(existing, 'OLD');
    const result = await saveMediaFile(
      { url: 'https://cdn.example/v.mp4', saveTo: dir, id: 'task-1', kind: 'video' },
      { fetchImpl: stubFetch(Buffer.from('NEW')), now: () => at },
    );
    assert.notEqual(result.path, existing);
    assert.match(result.path, /-2\.mp4$/);
    assert.equal(readFileSync(existing).toString(), 'OLD');
    assert.equal(readFileSync(result.path).toString(), 'NEW');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('显式文件名 + 多产物：首个覆盖、后续加序号，不丢结果', async () => {
  const dir = tmp();
  try {
    const target = join(dir, 'fixed.mp4');
    writeFileSync(target, 'OLD');
    const first = await saveMediaFile(
      { url: 'https://cdn.example/a.mp4', saveTo: target, index: 0 },
      { fetchImpl: stubFetch(Buffer.from('FIRST')) },
    );
    const second = await saveMediaFile(
      { url: 'https://cdn.example/b.mp4', saveTo: target, index: 1 },
      { fetchImpl: stubFetch(Buffer.from('SECOND')) },
    );
    assert.equal(first.path, target);
    assert.equal(second.path, join(dir, 'fixed-2.mp4'));
    assert.equal(readFileSync(target).toString(), 'FIRST');
    assert.equal(readFileSync(second.path).toString(), 'SECOND');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('下载地址：本机/内网字面量在发请求前就被拒绝', async () => {
  const dir = tmp();
  let fetched = 0;
  const neverFetch = async () => { fetched += 1; return new Response('x'); };
  try {
    for (const url of [
      'https://localhost/a.mp4',
      'https://localhost./a.mp4',
      'https://127.0.0.1/a.mp4',
      'https://127.0.0.1./a.mp4',
      'https://192.168.1.10/a.mp4',
      'https://10.0.0.2/a.mp4',
      'https://[::1]/a.mp4',
      'https://[::ffff:127.0.0.1]/a.mp4',
    ]) {
      await assert.rejects(
        () => saveMediaFile({ url, saveTo: dir }, { fetchImpl: neverFetch }),
        /private\/local host|non-https/,
      );
    }
    assert.equal(fetched, 0, '拒绝发生在 fetch 之前');
    assert.deepEqual(readdirSync(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mediaFileName：index 只影响显式文件名场景的序号', () => {
  const at = new Date(2026, 9, 26, 9, 30, 15).getTime();
  assert.equal(
    mediaFileName({ id: 'task-1', kind: 'video', now: at, index: 2 }),
    'video-20261026-093015-task-1-3.mp4',
  );
});
