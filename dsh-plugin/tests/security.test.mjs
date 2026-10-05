/**
 * 安全回归：本轮审计修掉的几条，钉在这里防止回退。
 *
 *   node --test dsh-plugin/tests/
 *
 * 覆盖：
 *   1. **YAML 注入**：模型 id 会被拼进 dsh 的 settings.yaml / cordis.patch.yml，
 *      含换行的 id 能注入顶层 YAML 键（cordis patch 的顶层条目 = 插件/适配器条目
 *      → 配置注入 → 潜在任意代码执行）。实测确认过，这里钉死"必须拒绝"。
 *   2. **读取回环**：id 现在带引号写入，读回时必须剥掉引号，否则「已注册模型」
 *      会全部错位（失效检测全误判）。
 *   3. **跨站来源**：控制台必须拒绝外来 Origin（DNS rebinding 防线），且不能
 *      误伤本机调用；静态备份文件不得可下载；基础安全响应头必须到位。
 *
 * DSH_HOME 指向临时目录：`config.mjs` 在 import 时求值，所以必须在**动态 import
 * 之前**设好，绝不能碰使用者真实的 ~/.dsh。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = dirname(HERE);
const REPO = dirname(PLUGIN_DIR);

const home = mkdtempSync(join(tmpdir(), 'wb-sec-home-'));
process.env.DSH_HOME = home;
process.env.WORKBUDDY_PORT = '0';

// patch 文件先建好：writeRegistration 只在它存在时才同步 patch 层
mkdirSync(join(home, 'profiles', 'desktop'), { recursive: true });
writeFileSync(join(home, 'profiles', 'desktop', 'cordis.patch.yml'), '# 用户自己的 patch 文件\n', 'utf8');

const dsh = await import('../../lib/dsh.mjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 1. YAML 注入 ────────────────────────────────────────────────────────

test('安全：模型 id 含换行/引号等必须被拒绝，绝不写进 YAML', async () => {
  const settingsPath = join(home, 'settings.yaml');
  const patchPath = join(home, 'profiles', 'desktop', 'cordis.patch.yml');
  const before = {
    settings: existsSync(settingsPath) ? readFileSync(settingsPath, 'utf8') : null,
    patch: readFileSync(patchPath, 'utf8'),
  };

  const hostile = [
    'evil\nmaliciousTopLevel:\n  enabled: true', // 顶层键
    'evil\n- id: injected-adapter\n  name: x',    // 顶层列表项（cordis 的插件条目）
    'evil" injected: 1',                          // 引号逃逸
    'evil model',                                 // 含空格
    '  leadingSpace',
    '',
  ];
  for (const id of hostile) {
    assert.throws(
      () => dsh.writeRegistration([{ id, name: 'n' }]),
      /不合法/,
      `hostile id 必须被拒绝：${JSON.stringify(id)}`,
    );
  }
  assert.equal(dsh.invalidModelIds(hostile).length, hostile.length);

  // "拒绝"意味着**一个字节都不写**（不是"写一半"）：settings 与 patch 都要原样
  const afterSettings = existsSync(settingsPath) ? readFileSync(settingsPath, 'utf8') : null;
  assert.equal(afterSettings, before.settings, '被拒绝时不得创建/改动 settings.yaml');
  assert.equal(readFileSync(patchPath, 'utf8'), before.patch, '被拒绝时不得改动 patch 文件');
});

test('安全：合法 id 正常写入，且生成物里没有顶层越权键', async () => {
  const ok = [{ id: 'deepseek-v4.1-flash', name: 'Flash' }, { id: 'glm-5.3', name: 'GLM' }];
  assert.deepEqual(dsh.invalidModelIds(ok), []);
  const out = dsh.writeRegistration(ok);
  assert.equal(out.saved, true);

  const text = readFileSync(join(home, 'settings.yaml'), 'utf8');
  // 顶层（0 缩进）只应有注释头与 llm-pi-ai: —— 任何其它顶层键都说明被注入
  const topLevel = text.split('\n').filter((l) => l.length > 0 && !/^\s/.test(l) && !l.startsWith('#'));
  assert.deepEqual(topLevel, ['llm-pi-ai:'], `出现了意外的顶层键：${JSON.stringify(topLevel)}`);

  // 纵深防御：即使有人绕过校验直接调 buildSettings，引号也要保证结构不被撑破
  const built = dsh.buildSettings([{ id: 'evil\nmaliciousTopLevel:\n  x: 1', name: 'n' }]);
  const builtTop = built.split('\n').filter((l) => l.length > 0 && !/^\s/.test(l) && !l.startsWith('#'));
  assert.deepEqual(builtTop, ['llm-pi-ai:'], 'buildSettings 也必须撑不破 YAML 结构');
});

// ── 2. 读取回环（id 带引号写入后必须能读回）────────────────────────────

test('安全/回归：带引号写入的 id 能原样读回（否则已注册模型会全部错位）', async () => {
  const ids = ['deepseek-v4.1-flash', 'glm-5.3', 'hy4-preview'];
  dsh.writeRegistration(ids.map((id) => ({ id, name: id })));

  const status = dsh.readDshStatus();
  assert.deepEqual(
    [...status.registeredModels].sort(),
    [...ids].sort(),
    '读回的 id 不得带引号（modelsUnder 必须容忍两种形式）',
  );
  assert.equal(status.routeLive, true);
});

// ── 3. 控制台：跨站来源 / 静态备份 / 安全头 ──────────────────────────────

test('安全：控制台拒绝外来 Origin、拒绝备份文件、带基础安全头（起真进程打真 HTTP）', { timeout: 60_000 }, async () => {
  const port = 23000 + Math.floor(Math.random() * 5000);
  const child = spawn(process.execPath, [join(REPO, 'dashboard', 'server.mjs')], {
    cwd: REPO,
    env: {
      ...process.env,
      DASHBOARD_PORT: String(port),
      WORKBUDDY_PORT: '0',
      // 别在测试里动本机真实的桥 / 触发签到 / 改使用者的 .state.json
      DASHBOARD_AUTO_START_BRIDGE: '0',
      DASHBOARD_OPEN_BROWSER: '0',
      WORKBUDDY_AUTO_CHECKIN: '0',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    let ready = false;
    for (let i = 0; i < 60 && !ready; i += 1) {
      await sleep(250);
      try { ready = (await fetch(`${base}/api/overview`)).ok; } catch { /* 还没起来 */ }
    }
    assert.equal(ready, true, '控制台未能在 15 秒内就绪');

    // ① 外来 Origin 的写操作：在到达路由之前就被拒（连面板头都轮不到检查）
    const crossOrigin = await fetch(`${base}/api/checkin/settings`, {
      method: 'POST',
      headers: { Origin: 'https://evil.example', 'Content-Type': 'text/plain' },
      body: JSON.stringify({ auto: true }),
    });
    assert.equal(crossOrigin.status, 403, '外来 Origin 必须 403（DNS rebinding 防线）');
    await crossOrigin.text();

    // ② 回环 Origin 但缺面板头：仍要 403（面板头这道防线不能被 Origin 顶替）
    const noHeader = await fetch(`${base}/api/checkin/settings`, {
      method: 'POST',
      headers: { Origin: `http://127.0.0.1:${port}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ auto: true }),
    });
    assert.equal(noHeader.status, 403, '缺面板头的写操作必须 403');
    await noHeader.text();

    // ③ 本机 CLI（无 Origin）的读操作不受影响
    const readOk = await fetch(`${base}/api/overview`);
    assert.equal(readOk.status, 200, '无 Origin 的读操作必须照常');

    // ④ 静态备份文件不得可下载
    const bak = await fetch(`${base}/index.html.bak`);
    assert.equal(bak.status, 404, '备份文件必须 404（不要把工作副本当发布物发出去）');
    await bak.text();

    // ⑤ 正常静态资源不受影响 + 安全头到位
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(page.headers.get('x-frame-options'), 'DENY');
    assert.match(page.headers.get('content-security-policy') || '', /frame-ancestors 'none'/);
    await page.text();
  } finally {
    child.kill();
    await sleep(200);
  }
});

after(() => {
  try { rmSync(home, { recursive: true, force: true }); } catch { /* 已清理 */ }
});
