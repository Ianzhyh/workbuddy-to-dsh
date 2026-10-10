/**
 * 一键接入的用例。
 *
 *   node --test lib/client-connect.test.mjs
 *
 * 这个模块会**改用户的配置文件**，所以用例的重点不是"能写对"，而是
 * **"写错的时候不会把人家原来的东西弄坏"**：
 *   - 只动自己的键 / 节，别人的节与注释原样保留；
 *   - 非法 JSON 一律停手，绝不"反正重写一份"；
 *   - 撤销之后与**原始内容逐字节相同**（往返可逆）；
 *   - 重复写入幂等，且不会把撤销要用的原始值覆盖成中间态。
 *
 * ## 绝不碰真实配置
 *
 * 三个客户端路径都能用 env 覆盖（`WORKBUDDY_CODEX_CONFIG` 等），
 * 用例全部走临时目录 + 临时 backupRoot。**没有这层覆盖就只能拿使用者的
 * `~/.codex/config.toml` 当试验场** —— 那正是这个功能最不能出的错。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** 仓库根（子进程用例要拿它当 cwd 基准）。 */
const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

import {
  applyClient, undoClient, planClient, verifyWritten, findClient, tomlTopLevel, tomlUpsertSection, tomlRemoveSection,
  assertModelKnown, assertModelsKnown, contextForClient, defaultModelFor, modelOptions,
  currentModelFor, currentModelsFor, resolveModelChoice, resolveSelection,
  planModelCatalog, clientPath, listClients, resolveBackupRoot,
} from './client-connect.mjs';

const ctx = () => ({
  token: 'tok-abc-1234567890',
  baseUrlOpenAI: 'http://127.0.0.1:8790/v1',
  baseUrlAnthropic: 'http://127.0.0.1:8790',
  model: 'deepseek-v4.1-flash',
  models: [
    { id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash', context: 1000000, maxOutput: 128000 },
    { id: 'glm-5.3', name: 'GLM-5.3', context: 1000000, maxOutput: 48000 },
  ],
});

/**
 * 造一个隔离环境：临时目录当"用户家目录"，把三个路径都指过去。
 * 返回 `{ dir, home, backupRoot, paths }`。
 *
 * `clientHome` 用来模拟**客户端自己的重定位环境变量**（`CODEX_HOME` /
 * `CLAUDE_CONFIG_DIR`）——那是各家官方支持的做法，别人的机器上可能就设着。
 */
function sandbox({ files = {}, clientHome = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wb-connect-'));
  const home = join(dir, 'home');
  const backupRoot = join(dir, 'backups');
  // 模拟家目录：Windows 上 os.homedir() 认 USERPROFILE，POSIX 认 HOME
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  const paths = {
    codex: join(clientHome.codex || join(home, '.codex'), 'config.toml'),
    claude: join(clientHome.claude || join(home, '.claude'), 'settings.json'),
    opencode: join(home, '.config', 'opencode', 'opencode.json'),
  };
  // 用例显式指定路径时优先用它（与控制台同一套覆盖语义）
  if (files.__explicitPaths !== false) {
    process.env.WORKBUDDY_CODEX_CONFIG = paths.codex;
    process.env.WORKBUDDY_CLAUDE_SETTINGS = paths.claude;
    process.env.WORKBUDDY_OPENCODE_CONFIG = paths.opencode;
  }
  // 「装没装」看所在目录在不在
  for (const [id, p] of Object.entries(paths)) {
    mkdirSync(join(p, '..'), { recursive: true });
    const body = files[id];
    if (body !== undefined) writeFileSync(p, body);
  }
  return { dir, home, backupRoot, paths, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const CODEX_ORIGINAL = [
  '# 我的 Codex 配置 —— 这行注释必须活下来',
  'model_provider = "custom"',
  'model = "glm-5.2"',
  'service_tier = "default"',
  '',
  '[model_providers.custom]',
  'name = "opencode_go"',
  'base_url = "https://opencode.ai/zen/go/v1"',
  'wire_api = "responses"',
  '',
  '[features]',
  'js_repl = false',
  '',
].join('\n');

// ── 路径解析：别人电脑上的不同环境 ────────────────────────────────────────
//
// 「我的开发机是那样，就一定是那样」是这类功能最容易犯的错。各家的官方约定：
//   Codex       —— `CODEX_HOME` 指到别处（本机用 `codex doctor` 实测：设了它，
//                  它自述的 config 路径就跟着变）
//   Claude Code —— `CLAUDE_CONFIG_DIR`（官方文档：To keep the home-directory files
//                  somewhere else, set CLAUDE_CONFIG_DIR）
//   opencode    —— 全局固定在 `~/.config/opencode/`；`OPENCODE_CONFIG` 是**另一层**
//                  （优先级更高），不是同一件事，所以只按 XDG 处理
test('路径解析：CODEX_HOME / CLAUDE_CONFIG_DIR 要认，别往家目录乱写', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-home-'));
  const codexHome = join(dir, 'custom-codex');
  const claudeDir = join(dir, 'custom-claude');
  const box = sandbox({ clientHome: { codex: codexHome, claude: claudeDir } });
  const saved = {
    codex: process.env.WORKBUDDY_CODEX_CONFIG,
    claude: process.env.WORKBUDDY_CLAUDE_SETTINGS,
    opencode: process.env.WORKBUDDY_OPENCODE_CONFIG,
    CODEX_HOME: process.env.CODEX_HOME,
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  };
  try {
    /*
     * 关键一步：**清掉本产品的显式覆盖**。清理之后真正考验的是「默认路径怎么算」——
     * 带着 `WORKBUDDY_CODEX_CONFIG` 的话，永远是那个显式值在生效，
     * 默认路径算错也看不出来（这正是原来那批用例的盲区）。
     */
    delete process.env.WORKBUDDY_CODEX_CONFIG;
    delete process.env.WORKBUDDY_CLAUDE_SETTINGS;
    delete process.env.WORKBUDDY_OPENCODE_CONFIG;
    process.env.CODEX_HOME = codexHome;
    process.env.CLAUDE_CONFIG_DIR = claudeDir;

    assert.equal(clientPath(findClient('codex')), join(codexHome, 'config.toml'));
    assert.equal(clientPath(findClient('claude')), join(claudeDir, 'settings.json'));
    // opencode 没有"整目录重定位"的官方变量，按 XDG 处理
    assert.equal(clientPath(findClient('opencode')), join(box.home, '.config', 'opencode', 'opencode.json'));

    // 显式覆盖（本控制台自己的变量）**优先级仍然最高**：测试与运维要靠它
    process.env.WORKBUDDY_CODEX_CONFIG = join(dir, 'explicit.toml');
    assert.equal(clientPath(findClient('codex')), join(dir, 'explicit.toml'));
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
    box.cleanup();
  }
});

test('路径解析：XDG_CONFIG_HOME 决定 opencode 的全局配置目录', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-xdg-'));
  const box = sandbox({});
  const saved = {
    opencode: process.env.WORKBUDDY_OPENCODE_CONFIG,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  };
  try {
    delete process.env.WORKBUDDY_OPENCODE_CONFIG;
    delete process.env.XDG_CONFIG_HOME;
    assert.equal(clientPath(findClient('opencode')), join(box.home, '.config', 'opencode', 'opencode.json'));

    process.env.XDG_CONFIG_HOME = join(dir, 'xdg');
    assert.equal(clientPath(findClient('opencode')), join(dir, 'xdg', 'opencode', 'opencode.json'));
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
    box.cleanup();
  }
});

test('路径解析：显式路径不存在时如实报错，不静默写到别处', () => {
  const box = sandbox({});
  const saved = process.env.WORKBUDDY_CODEX_CONFIG;
  try {
    // 指到一个**不存在**的目录：installed=false、plan 要给出可读结论
    process.env.WORKBUDDY_CODEX_CONFIG = join(box.dir, 'nope', 'deep', 'config.toml');
    const plan = planClient('codex', ctx());
    assert.equal(plan.installed, false, '目录不存在时应如实报"没检测到"');
    assert.equal(plan.path, process.env.WORKBUDDY_CODEX_CONFIG, '路径照实回显，用户才知道该建在哪');
  } finally {
    if (saved === undefined) delete process.env.WORKBUDDY_CODEX_CONFIG; else process.env.WORKBUDDY_CODEX_CONFIG = saved;
    box.cleanup();
  }
});

test('备份根：跟着**代码位置**走，不跟着启动目录走', () => {
  /*
   * 现场（子进程实测）：`REPO_BACKUP_ROOT` 原先用 `process.cwd()`，于是
   * 「从仓库根起控制台」与「从别处起」算出来是两个不同的备份目录 ——
   * 用户换个启动方式就会发现**上次的备份/撤销记录不见了**；
   * 而 `planClient`（读 manifest 判"已接入"）与 `applyClient`（写 manifest）
   * 若落在不同根下，还会出现「刚写入成功、界面却显示还没接入」。
   *
   * ⚠️ 这条**必须用子进程**验：同一个进程里 `process.chdir()` 是假绿 ——
   * `process.cwd()` 在模块加载时就被读走了，chdir 改变不了它。
   * 真问题只在"进程从别的 cwd 启动"时暴露。
   */
  const elsewhere = mkdtempSync(join(tmpdir(), 'wb-cwd-'));
  const fakeHome = mkdtempSync(join(tmpdir(), 'wb-ch-'));
  const savedBackup = process.env.WORKBUDDY_CONNECT_BACKUP;
  const savedProfile = process.env.USERPROFILE;
  try {
    delete process.env.WORKBUDDY_CONNECT_BACKUP;   // 别让 env 覆盖把结论遮掉
    process.env.USERPROFILE = fakeHome;            // 假装是"别人的家目录"
    const url = new URL('./client-connect.mjs', import.meta.url).href;
    const script = `import { resolveBackupRoot } from ${JSON.stringify(url)};`
      + 'console.log(resolveBackupRoot());';
    const run = (cwd) => execFileSync(process.execPath, ['-e', script], {
      cwd, encoding: 'utf8', env: { ...process.env },
    }).trim();

    const fromRepo = run(ROOT_DIR);
    const fromElsewhere = run(elsewhere);
    assert.equal(fromElsewhere, fromRepo,
      '换一个启动目录不该换一个备份目录 —— 否则用户会以为备份/撤销记录丢了');
    assert.match(fromRepo, /\.backup[\\/]client-configs$/,
      `备份根应落在仓库的 .backup 下（已在 .gitignore）：${fromRepo}`);
    assert.equal(fromRepo.startsWith(ROOT_DIR), true,
      `备份根应在仓库内，实际 ${fromRepo}`);
  } finally {
    if (savedBackup === undefined) delete process.env.WORKBUDDY_CONNECT_BACKUP; else process.env.WORKBUDDY_CONNECT_BACKUP = savedBackup;
    if (savedProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = savedProfile;
    rmSync(elsewhere, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test('备份根：显式覆盖优先，仓库不可写时退回用户目录', () => {
  const savedBackup = process.env.WORKBUDDY_CONNECT_BACKUP;
  const dir = mkdtempSync(join(tmpdir(), 'wb-bk-'));
  try {
    process.env.WORKBUDDY_CONNECT_BACKUP = dir;
    assert.equal(resolveBackupRoot(), dir, '显式覆盖（env）优先');
    assert.equal(resolveBackupRoot(join(dir, 'explicit')), join(dir, 'explicit'), '入参优先于 env');
  } finally {
    if (savedBackup === undefined) delete process.env.WORKBUDDY_CONNECT_BACKUP; else process.env.WORKBUDDY_CONNECT_BACKUP = savedBackup;
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 对抗用例：真实机器上会遇到的畸形输入 ─────────────────────────────────
//
// 这批是**用对抗式往返撞出来的**（拿一批刁钻的原始配置逐个跑 apply→undo，
// 看撤销后是否还把用户的数据还原对了）。三个真 bug 的共同特征是
// **静默丢数据**：apply 报 ok、undo 报 ok，但文件已经不是原来那份了。

test('【回归】中间层是数组 / null 时，撤销必须还原原样，不能换成 {}', () => {
  /*
   * 现场：`settings.json` 里 `"env": []`（用户或别的工具写坏了，但文件是好的），
   * 或 `opencode.json` 里 `"provider": null`。`setPath` 遇到"中间层不是对象"
   * 会**静默替换成 `{}`** —— 于是撤销之后 `env: []` 变成 `env: {}`：
   * 数组是空、对象是"我配过但没字段"，语义不同；而用户根本没动过那里。
   */
  const cases = [
    ['claude', '{\n  "env": []\n}\n'],
    ['claude', '{\n  "env": "not-an-object"\n}\n'],
    ['opencode', '{\n  "provider": null\n}\n'],
    ['opencode', '{\n  "provider": []\n}\n'],
  ];
  for (const [id, original] of cases) {
    const sb = sandbox({ files: { [id]: original } });
    try {
      const c = ctx();
      const a = applyClient(id, c, { backupRoot: sb.backupRoot });
      assert.equal(a.ok, true, `${id} 应能写入：${a.error}`);
      const u = undoClient(id, { backupRoot: sb.backupRoot });
      assert.equal(u.ok, true);
      const after = readFileSync(sb.paths[id], 'utf8');
      assert.deepEqual(
        JSON.parse(after), JSON.parse(original),
        `${id}：撤销后语义被改了\n  原始: ${original}\n  之后: ${after}`,
      );
    } finally { sb.cleanup(); }
  }
});

test('【回归】空配置文件应当被当成"还没有配置"，而不是"格式不对"', () => {
  /*
   * 现场：`{}` 能写，但**长度为 0 的文件**（客户端自己建了个空文件、或用户
   * `touch` 出来的）`plan` 直接报"不是合法 JSON（Unexpected end of JSON input）"
   * —— 提示还把用户往"你是不是写了注释"上引，而文件其实是空的。
   * 空文件 = 没有配置，是**最该能一键接上**的一种状态。
   */
  for (const id of ['claude', 'opencode']) {
    const sb = sandbox({ files: { [id]: '' } });
    try {
      const a = applyClient(id, ctx(), { backupRoot: sb.backupRoot });
      assert.equal(a.ok, true, `${id} 空文件应当能写入，实际：${a.error}`);
      const obj = JSON.parse(readFileSync(sb.paths[id], 'utf8'));
      if (id === 'claude') assert.equal(obj.env.ANTHROPIC_BASE_URL, ctx().baseUrlAnthropic);
      else assert.equal(obj.model, 'workbuddy/deepseek-v4.1-flash');

      /*
       * 撤销：原本是**空文件**。还原成 `{}` 是等价的（都是"没有配置"），
       * 而且与"文件原本不存在 → 撤销后删掉"那条既有语义一致：
       * 只有真的什么都不剩时才删文件，否则留空对象。这里断言的是**语义回到空配置**，
       * 不苛求"长度必须为 0 字节"。
       */
      const u = undoClient(id, { backupRoot: sb.backupRoot });
      assert.equal(u.ok, true);
      const left = readFileSync(sb.paths[id], 'utf8').trim();
      assert.equal(left === '' || left === '{}', true,
        `空文件撤销后应当回到"没有配置"的状态，实际：${JSON.stringify(left)}`);
    } finally { sb.cleanup(); }
  }
});

test('【回归】撤销后不应丢掉 BOM（用户的文件长什么样，还原成什么样）', () => {
  /*
   * `stripBom` 是为了能解析（Windows 记事本另存会带 BOM），但撤销时把 BOM 一并
   * 丢了 —— 撤销的承诺是"还原到接入之前"，那就该连这三个字节一起还。
   */
  const original = '\uFEFF{\n  "a": 1\n}\n';
  const sb = sandbox({ files: { claude: original } });
  try {
    assert.equal(applyClient('claude', ctx(), { backupRoot: sb.backupRoot }).ok, true);
    assert.equal(undoClient('claude', { backupRoot: sb.backupRoot }).ok, true);
    const after = readFileSync(sb.paths.claude, 'utf8');
    assert.equal(after.charCodeAt(0), 0xfeff, `撤销后 BOM 丢了：${JSON.stringify(after.slice(0, 12))}`);
    assert.deepEqual(parseJson(after), parseJson(original));
  } finally { sb.cleanup(); }
});

/** 测试侧的 JSON 解析：带 BOM 的文本要先剥掉（`JSON.parse` 不认 BOM）。 */
const parseJson = (s) => JSON.parse(String(s).replace(/^\uFEFF/, ''));

test('【回归】中间层是用户数据而写不进去时，必须如实报出是哪几个键', () => {
  /*
   * 上面那条用例保证"不覆盖用户数据"，这条保证"不装作写成功"。
   * `"env": []` 这种畸形（但真实存在）的中间层，我们既不该覆盖它、也不该
   * 安静地跳过 —— 用户点一次"写入"、界面报成功，可 `ANTHROPIC_*` 根本没进去，
   * 下次请求失败时根本想不到是这里。
   */
  const sb = sandbox({ files: { claude: '{\n  "env": []\n}\n' } });
  try {
    const plan = planClient('claude', ctx(), { backupRoot: sb.backupRoot });
    assert.deepEqual(plan.skippedKeys, ['env.ANTHROPIC_BASE_URL', 'env.ANTHROPIC_API_KEY', 'env.ANTHROPIC_MODEL'],
      '计划里要列出被跳过的键');
    const r = applyClient('claude', ctx(), { backupRoot: sb.backupRoot });
    assert.equal(r.ok, true);
    assert.deepEqual(r.skippedKeys, plan.skippedKeys, '写入结果也要带上被跳过的键');
  } finally { sb.cleanup(); }
});

test('【回归】中间层是普通对象时不算跳过（不能把正常情况也报成跳过）', () => {
  const sb = sandbox({ files: { claude: '{\n  "env": {}\n}\n' } });
  try {
    const plan = planClient('claude', ctx(), { backupRoot: sb.backupRoot });
    assert.deepEqual(plan.skippedKeys, [], '正常的 env 对象不该被报成跳过');
    assert.equal(plan.changed, true);
  } finally { sb.cleanup(); }
});

// ── TOML 行级操作 ───────────────────────────────────────────────────────

test('TOML：顶层键就地替换，不动任何其它内容', () => {
  const lines = CODEX_ORIGINAL.split('\n');
  tomlTopLevel(lines, 'model', '"new-model"');
  const out = lines.join('\n');
  assert.match(out, /^# 我的 Codex 配置 —— 这行注释必须活下来$/m, '注释被弄丢了');
  assert.match(out, /^model = "new-model"$/m);
  assert.match(out, /^service_tier = "default"$/m, '无关的顶层键被动过');
  // 原地替换：行号不变
  assert.equal(lines.indexOf('model = "new-model"'), 2);
});

test('TOML：只认顶层键 —— 别的节里有同名键时不能被误改', () => {
  const text = [
    'name = "top"',
    '[model_providers.custom]',
    'name = "inner"',
    '',
  ].join('\n');
  const lines = text.split('\n');
  const r = tomlTopLevel(lines, 'name', '"patched"');
  assert.equal(r.from, '"top"');
  assert.equal(lines.filter((l) => l === 'name = "inner"').length, 1, '节里的同名键被改了');
  assert.match(lines.join('\n'), /^name = "patched"$/m);

  /*
   * 更狠的一种：顶层**没有**这个键，只有节里有。这时如果实现忘了「只看顶层」，
   * 就会把节里的那行当成顶层键改掉 —— 那是实打实地改坏了用户的配置。
   */
  const onlyInSection = ['[model_providers.custom]', 'name = "inner"', ''].join('\n');
  const l2 = onlyInSection.split('\n');
  const r2 = tomlTopLevel(l2, 'name', '"added"');
  assert.equal(r2.from, null, '把节里的键当成顶层键了');
  assert.equal(l2.filter((l) => l === 'name = "inner"').length, 1, '把节里的键改掉了');
  assert.equal(l2[0], 'name = "added"', '新顶层键没插在节之前');
  assert.ok(l2.indexOf('name = "added"') < l2.indexOf('[model_providers.custom]'));
});

test('往返可逆：节在文件中**中间**时也逐字节还原', () => {
  // 节后面还有别的节 —— 还原时要连"这个节占的那一段"一起收拾干净，不留空洞
  const original = [
    'model = "glm-5.2"',
    '',
    '[model_providers.workbuddy]',
    'name = "旧的"',
    '',
    '[features]',
    'js_repl = false',
    '',
  ].join('\n');
  const sb = sandbox({ files: { codex: original } });
  try {
    assert.equal(applyClient('codex', ctx(), { backupRoot: sb.backupRoot }).changed, true);
    const u = undoClient('codex', { backupRoot: sb.backupRoot });
    assert.equal(u.ok, true, u.error);
    assert.equal(readFileSync(sb.paths.codex, 'utf8'), original, '中途节撤销后内容不一致');
  } finally { sb.cleanup(); }
});

test('TOML：节已存在时替换而不是再追加一份', () => {
  const lines = ['[a]', 'x = 1', '', '[model_providers.workbuddy]', 'old = true', '', '[b]', 'y = 2', ''];
  tomlUpsertSection(lines, 'model_providers.workbuddy', ['new = true']);
  const out = lines.join('\n');
  assert.equal(out.match(/\[model_providers\.workbuddy\]/g).length, 1, '出现了两个同名节');
  assert.ok(!out.includes('old = true'), '旧内容没被替换');
  assert.match(out, /\[b\]\ny = 2/, '后面的节被吞掉了');
});

test('TOML：删节时连带吃掉它后面拖着的空行，不留空洞', () => {
  const lines = ['[a]', 'x = 1', '', '[gone]', 'y = 2', '', '', '[b]', 'z = 3', ''];
  tomlRemoveSection(lines, 'gone');
  const out = lines.join('\n');
  assert.ok(!out.includes('[gone]'));
  assert.deepEqual(out.split(String.fromCharCode(10)).slice(0, 5), ['[a]', 'x = 1', '', '[b]', 'z = 3'], '删完留下了多余空行或吞了邻居：' + out);
});

// ── 计划（不落盘）───────────────────────────────────────────────────────

test('Codex：计划里如实报出「哪个键从什么变成什么」，供二次确认', () => {
  const sb = sandbox({ files: { codex: CODEX_ORIGINAL } });
  try {
    const plan = planClient('codex', ctx(), { backupRoot: sb.backupRoot });
    const paths = plan.changes.map((c) => c.path).sort();
    assert.deepEqual(paths, ['model', 'model_provider', 'model_providers.workbuddy']);
    assert.equal(plan.changes.find((c) => c.path === 'model').from, 'glm-5.2');
    assert.equal(plan.changes.find((c) => c.path === 'model_provider').from, 'custom');
    assert.equal(plan.exists, true);
    assert.equal(plan.installed, true);
    assert.equal(plan.applied, false);
  } finally { sb.cleanup(); }
});

test('Codex：cc-switch 的 provider 节一字未动', () => {
  const sb = sandbox({ files: { codex: CODEX_ORIGINAL } });
  try {
    const { preview } = planClient('codex', ctx(), { backupRoot: sb.backupRoot });
    assert.match(preview, /\[model_providers\.custom\]\nname = "opencode_go"\nbase_url = "https:\/\/opencode\.ai\/zen\/go\/v1"\nwire_api = "responses"/,
      '别人的 provider 节被改动了');
    assert.match(preview, /^service_tier = "default"$/m);
  } finally { sb.cleanup(); }
});

test('opencode：limit 必须带上，否则客户端显示「上下文 0」', () => {
  const sb = sandbox({ files: { opencode: '{}\n' } });
  try {
    const { preview } = planClient('opencode', ctx(), { backupRoot: sb.backupRoot });
    const obj = JSON.parse(preview);
    const p = obj.provider.workbuddy;
    assert.equal(p.npm, '@ai-sdk/openai-compatible');
    assert.equal(p.options.baseURL, 'http://127.0.0.1:8790/v1');
    assert.equal(p.options.apiKey, ctx().token);
    assert.deepEqual(p.models['deepseek-v4.1-flash'].limit, { context: 1000000, output: 128000 });
    // 不设默认模型的话，接入完还得在 TUI 里手动挑一次 —— 那就不是「无脑」了
    assert.equal(obj.model, 'workbuddy/deepseek-v4.1-flash');
    assert.equal(obj.$schema, 'https://opencode.ai/config.json');
  } finally { sb.cleanup(); }
});

test('JSON：别人的键保留；BOM 保留（用户文件长什么样就是什么样）', () => {
  const sb = sandbox({ files: { claude: '\ufeff' + JSON.stringify({ env: { KEEP: 'x' }, permissions: { allow: ['Bash'] } }, null, 2) + '\n' } });
  try {
    const { preview, reformats } = planClient('claude', ctx(), { backupRoot: sb.backupRoot });
    /*
     * BOM 要**写回去**。早先这里断言的是"不能带 BOM"，把"丢字节"当成了正确行为 ——
     * 但用户的文件原本带 BOM（Windows 记事本另存就会带），我们写一遍不该把它抹掉：
     * 那属于"看起来对、其实改了用户的东西"。解析时照旧剥掉（`stripBom`）。
     */
    assert.equal(preview.charCodeAt(0), 0xfeff, 'BOM 没保留（用户文件原本带 BOM）');
    const obj = parseJson(preview);
    assert.equal(obj.env.KEEP, 'x', '别的 env 键被吞了');
    assert.deepEqual(obj.permissions, { allow: ['Bash'] });
    assert.equal(obj.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:8790');
    assert.equal(obj.env.ANTHROPIC_API_KEY, ctx().token);
    assert.equal(reformats, false, '本来就是 2 空格缩进，不该报「会重排」');
  } finally { sb.cleanup(); }
});

test('JSON：排版会被统一 —— 必须**如实报出** reformats，不能装作一字未动', () => {
  // 行内对象的写法（用户手写 JSON 很常见），序列化后一定会被摊开
  const sb = sandbox({ files: { claude: '{ "env": { "KEEP": "x" } }\n' } });
  try {
    const plan = planClient('claude', ctx(), { backupRoot: sb.backupRoot });
    assert.equal(plan.reformats, true, '没报「会重排」，用户会以为只动了两个键');
    const r = applyClient('claude', ctx(), { backupRoot: sb.backupRoot });
    assert.equal(r.reformats, true);
    // 语义上仍然保留
    assert.equal(JSON.parse(readFileSync(sb.paths.claude, 'utf8')).env.KEEP, 'x');
  } finally { sb.cleanup(); }
});

test('非法 JSON：只报错、绝不动文件', () => {
  const broken = '{ "env": { 断了 }\n';
  const sb = sandbox({ files: { claude: broken } });
  try {
    const plan = planClient('claude', ctx(), { backupRoot: sb.backupRoot });
    assert.ok(plan.error, '居然没报错');
    assert.match(plan.error, /不是合法 JSON/);
    const r = applyClient('claude', ctx(), { backupRoot: sb.backupRoot });
    assert.equal(r.ok, false);
    assert.equal(readFileSync(sb.paths.claude, 'utf8'), broken, '**文件被改坏了** —— 这是最不能接受的失败');
  } finally { sb.cleanup(); }
});

test('带注释的 JSONC（opencode 官方支持）不能被当成"格式不对"拒掉', () => {
  /*
   * 官方文档原话：*OpenCode supports both JSON and JSONC (JSON with Comments) formats.*
   * 而用户手写 `opencode.jsonc` / 带注释的配置极常见（注释就是给自己看的）。
   * 原先我们直接 `JSON.parse` → 报"不是合法 JSON"，还提示"请手工编辑或先用复制片段"
   * —— 用户明明把文件放在官方支持的位置，得到的却是一句"你格式不对"，
   * 而且**本来能一键接上的场景变成了手工活**。
   *
   * 做法：写之前用「剥注释」的方式解析（不支持尾逗号 —— 那不在 JSONC 里，
   * 真遇到了要如实报错，不能猜）。
   */
  const withComments = [
    '{',
    '  // 我的 opencode 配置',
    '  "theme": "dark",',
    '  /* 块注释也算 */',
    '  "autoupdate": true',
    '}',
    '',
  ].join('\n');
  const sb = sandbox({ files: { opencode: withComments } });
  try {
    const plan = planClient('opencode', ctx(), { backupRoot: sb.backupRoot });
    assert.equal(plan.error, undefined, `带注释的配置被拒了：${plan.error}`);
    const obj = parseJson(plan.preview);
    assert.equal(obj.theme, 'dark', '用户原有的键被吞了');
    assert.equal(obj.autoupdate, true);
    assert.equal(obj.model, 'workbuddy/deepseek-v4.1-flash');

    const r = applyClient('opencode', ctx(), { backupRoot: sb.backupRoot });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.verify.ok, true);

    /*
     * 撤销：注释**回不来**（我们是重新序列化的）。这一点必须如实告知，
     * 不能假装"还原到接入之前" —— 所以 reformats 要为 true，
     * 界面在二次确认时就会说"该文件会被重新排版"。
     */
    assert.equal(plan.reformats, true, '带注释的文件被重写会丢注释，必须报 reformats');
  } finally { sb.cleanup(); }
});

test('JSONC 剥注释：字符串里的 // 和 /* 不能被当注释吃掉', () => {
  /*
   * 剥注释最容易踩的坑：把**字符串内部**的 `//`（URL 里到处都是）当注释。
   * `baseURL: "http://127.0.0.1:8790/v1"` 被截断的话，写进去的地址就废了 ——
   * 而且写入还会报成功（JSON 解析得通，只是值变了）。这条专门钉住它。
   */
  const src = [
    '{',
    '  "note": "see http://example.com/a // not a comment",',
    '  "glob": "a/*/b",',
    '  "url": "http://127.0.0.1:8790/v1"',
    '}',
    '',
  ].join('\n');
  const sb = sandbox({ files: { opencode: src } });
  try {
    const plan = planClient('opencode', ctx(), { backupRoot: sb.backupRoot });
    assert.equal(plan.error, undefined, plan.error);
    const obj = parseJson(plan.preview);
    assert.equal(obj.note, 'see http://example.com/a // not a comment', '字符串里的 // 被当成注释吃了');
    assert.equal(obj.glob, 'a/*/b', '字符串里的 /* 被当成注释吃了');
    assert.equal(obj.url, 'http://127.0.0.1:8790/v1', 'URL 被截断了');
  } finally { sb.cleanup(); }
});

test('JSONC：尾逗号不在 JSONC 里，遇到要如实报错而不是猜', () => {
  const src = '{\n  "a": 1,\n}\n';
  const sb = sandbox({ files: { opencode: src } });
  try {
    const plan = planClient('opencode', ctx(), { backupRoot: sb.backupRoot });
    assert.ok(plan.error, '尾逗号应当如实报错（不能猜着修）');
    assert.equal(readFileSync(sb.paths.opencode, 'utf8'), src, '报错时绝不能动文件');
  } finally { sb.cleanup(); }
});

// ── 写入 / 撤销 ─────────────────────────────────────────────────────────

test('往返可逆：写入后撤销，内容与原始逐字节相同', () => {
  for (const [id, original] of [
    ['codex', CODEX_ORIGINAL],
    ['claude', JSON.stringify({ env: { KEEP: 'x' }, model: 'sonnet' }, null, 2) + '\n'],
    ['opencode', JSON.stringify({ theme: 'dark' }, null, 2) + '\n'],
  ]) {
    const sb = sandbox({ files: { [id]: original } });
    try {
      const a = applyClient(id, ctx(), { backupRoot: sb.backupRoot });
      assert.equal(a.ok, true, `${id} 写入失败：${a.error}`);
      assert.equal(a.changed, true);
      assert.notEqual(readFileSync(sb.paths[id], 'utf8'), original, `${id} 写入后内容没变`);

      const u = undoClient(id, { backupRoot: sb.backupRoot });
      assert.equal(u.ok, true, `${id} 撤销失败：${u.error}`);
      assert.equal(readFileSync(sb.paths[id], 'utf8'), original, `${id} 撤销后与原始内容不一致`);
    } finally { sb.cleanup(); }
  }
});

test('往返可逆：文件原本**不存在**时，撤销把它删回不存在', () => {
  const sb = sandbox();
  try {
    const a = applyClient('claude', ctx(), { backupRoot: sb.backupRoot });
    assert.equal(a.ok, true);
    assert.equal(existsSync(sb.paths.claude), true);
    assert.equal(a.backup, null, '本来就没有文件，不该有备份');

    const u = undoClient('claude', { backupRoot: sb.backupRoot });
    assert.equal(u.ok, true);
    /*
     * 这里刻意**要求文件回到不存在**，而不是留一个 `{}`。
     * 留 `{}` 看着无害，但有些客户端会因此认为"用户显式配了个空配置"，
     * 行为与"没有这个文件"不同。撤销就该完全回到动手之前。
     */
    assert.equal(existsSync(sb.paths.claude), false, '撤销后留下了空壳文件');
  } finally { sb.cleanup(); }
});

test('幂等：重复写入不重复改，也不覆盖撤销要用的原值', () => {
  const sb = sandbox({ files: { codex: CODEX_ORIGINAL } });
  try {
    const first = applyClient('codex', ctx(), { backupRoot: sb.backupRoot });
    assert.equal(first.changed, true);
    const afterFirst = readFileSync(sb.paths.codex, 'utf8');

    const second = applyClient('codex', ctx(), { backupRoot: sb.backupRoot });
    assert.equal(second.ok, true);
    assert.equal(second.changed, false, '第二次还报有改动');
    assert.equal(readFileSync(sb.paths.codex, 'utf8'), afterFirst, '第二次写入动了文件');

    // 第二次**不能**覆盖 manifest 里的原值，否则撤销会把文件还原成中间态
    const u = undoClient('codex', { backupRoot: sb.backupRoot });
    assert.equal(u.ok, true);
    assert.equal(readFileSync(sb.paths.codex, 'utf8'), CODEX_ORIGINAL, '撤销还原到了中间态');
  } finally { sb.cleanup(); }
});

test('撤销后再接入一次仍然可用（记录被归档、不残留）', () => {
  const sb = sandbox({ files: { codex: CODEX_ORIGINAL } });
  try {
    applyClient('codex', ctx(), { backupRoot: sb.backupRoot });
    undoClient('codex', { backupRoot: sb.backupRoot });
    const again = applyClient('codex', ctx(), { backupRoot: sb.backupRoot });
    assert.equal(again.changed, true);
    assert.equal(again.verify.ok, true);
    const u = undoClient('codex', { backupRoot: sb.backupRoot });
    assert.equal(u.ok, true);
    assert.equal(readFileSync(sb.paths.codex, 'utf8'), CODEX_ORIGINAL);
  } finally { sb.cleanup(); }
});

test('没有写入记录时撤销要拒掉，而不是瞎删', () => {
  const sb = sandbox({ files: { codex: CODEX_ORIGINAL } });
  try {
    const u = undoClient('codex', { backupRoot: sb.backupRoot });
    assert.equal(u.ok, false);
    assert.equal(readFileSync(sb.paths.codex, 'utf8'), CODEX_ORIGINAL);
  } finally { sb.cleanup(); }
});

/**
 * 这条钉的是一个**真出现过的 bug**：`planClient` 与 `applyClient` 各自算默认
 * 备份根，结果一个用仓库 `.backup/`、一个用用户目录 —— 写进去的 manifest
 * 另一边读不到，界面就永远显示「未接入」，而文件其实已经改了。
 *
 * 所以这里**故意不传 backupRoot**，让两边都走默认路径解析。
 */
test('不传 backupRoot 时，读（plan）与写（apply）必须认定同一个根', () => {
  const sb = sandbox({ files: { codex: CODEX_ORIGINAL } });
  process.env.WORKBUDDY_CONNECT_BACKUP = sb.backupRoot;
  try {
    assert.equal(planClient('codex', ctx()).applied, false);
    applyClient('codex', ctx());
    const after = planClient('codex', ctx());
    assert.equal(after.applied, true, '写入成功但 plan 看不到记录 —— 读写用了不同的备份根');
    assert.equal(after.changed, false, '已经接入过，不该再报有改动');
    assert.ok(after.appliedAt, '没有记录写入时间');
  } finally {
    delete process.env.WORKBUDDY_CONNECT_BACKUP;
    sb.cleanup();
  }
});

test('写入前会整份备份', () => {
  const sb = sandbox({ files: { codex: CODEX_ORIGINAL } });
  try {
    const r = applyClient('codex', ctx(), { backupRoot: sb.backupRoot });
    assert.ok(r.backup, '没有备份');
    assert.equal(readFileSync(r.backup, 'utf8'), CODEX_ORIGINAL, '备份内容与原文件不一致');
    // 备份落在客户端自己的子目录里，便于用户翻
    assert.equal(readdirSync(join(sb.backupRoot, 'codex')).some((f) => f.endsWith('config.toml')), true);
  } finally { sb.cleanup(); }
});

test('写回自检：令牌被改成别的值时必须报失败', () => {
  const sb = sandbox({ files: { codex: CODEX_ORIGINAL } });
  try {
    applyClient('codex', ctx(), { backupRoot: sb.backupRoot });
    const c = findClient('codex');
    assert.equal(verifyWritten(c, ctx()).ok, true);

    // 模拟"写进去了但内容不对"——把令牌改掉
    const text = readFileSync(sb.paths.codex, 'utf8').replace(ctx().token, 'wrong-token');
    writeFileSync(sb.paths.codex, text);
    const bad = verifyWritten(c, ctx());
    assert.equal(bad.ok, false, '令牌不对却通过了自检');
    assert.match(bad.reason, /experimental_bearer_token/);
    assert.ok(!bad.reason.includes(ctx().token), '自检报错把预期的令牌值打出来了');
  } finally { sb.cleanup(); }
});

// ── 显式选择接入模型 ─────────────────────────────────────────

test('Codex：显式选择的模型写进顶层 model，撤销逐字节还原', () => {
  const sb = sandbox({ files: { codex: CODEX_ORIGINAL } });
  try {
    const c = { ...ctx(), model: 'glm-5.3' };
    const r = applyClient('codex', c, { backupRoot: sb.backupRoot });
    assert.equal(r.ok, true, r.error);
    assert.match(readFileSync(sb.paths.codex, 'utf8'), /^model = "glm-5\.3"$/m);
    assert.equal(verifyWritten(findClient('codex'), c).ok, true);
    const u = undoClient('codex', { backupRoot: sb.backupRoot });
    assert.equal(u.ok, true);
    assert.equal(readFileSync(sb.paths.codex, 'utf8'), CODEX_ORIGINAL, '撤销后与原始不一致');
  } finally { sb.cleanup(); }
});

test('opencode：选了精选集之外的模型时，默认模型与声明列表都带上它', () => {
  const sb = sandbox({ files: { opencode: '{}\n' } });
  try {
    // kimi-k3 不在 ctx().models 里，模拟“从完整目录里挑了个非精选模型”（contextForClient 已补元数据）
    const c = { ...ctx(), model: 'kimi-k3', models: [...ctx().models, { id: 'kimi-k3', name: 'Kimi-K3', context: 960000, maxOutput: 32000 }] };
    const obj = JSON.parse(planClient('opencode', c, { backupRoot: sb.backupRoot }).preview);
    assert.equal(obj.model, 'workbuddy/kimi-k3');
    assert.deepEqual(obj.provider.workbuddy.models['kimi-k3'].limit, { context: 960000, output: 32000 });
  } finally { sb.cleanup(); }
});

test('opencode：即便 ctx.models 漏了默认模型，mergeOpencode 也会兜底补进声明列表', () => {
  const sb = sandbox({ files: { opencode: '{}\n' } });
  try {
    const c = { ...ctx(), model: 'kimi-k3' }; // models 里没有 kimi-k3
    const obj = JSON.parse(planClient('opencode', c, { backupRoot: sb.backupRoot }).preview);
    assert.equal(obj.model, 'workbuddy/kimi-k3');
    assert.ok(obj.provider.workbuddy.models['kimi-k3'], '兜底没补上所选模型，TUI 里会选不到');
  } finally { sb.cleanup(); }
});

test('Claude：写入 env.ANTHROPIC_MODEL，保留别的键，撤销后逐字节还原', () => {
  const original = JSON.stringify({ env: { KEEP: 'x' } }, null, 2) + '\n';
  const sb = sandbox({ files: { claude: original } });
  try {
    const c = { ...ctx(), model: 'glm-5.3' };
    const r = applyClient('claude', c, { backupRoot: sb.backupRoot });
    assert.equal(r.ok, true, r.error);
    const obj = JSON.parse(readFileSync(sb.paths.claude, 'utf8'));
    assert.equal(obj.env.ANTHROPIC_MODEL, 'glm-5.3');
    assert.equal(obj.env.KEEP, 'x', '别的 env 键被吞了');
    assert.equal(verifyWritten(findClient('claude'), c).ok, true);
    const u = undoClient('claude', { backupRoot: sb.backupRoot });
    assert.equal(u.ok, true);
    assert.equal(readFileSync(sb.paths.claude, 'utf8'), original, '撤销后与原始不一致');
  } finally { sb.cleanup(); }
});

test('幂等：同一模型重复写入，第二次不报改动', () => {
  const sb = sandbox({ files: { codex: CODEX_ORIGINAL } });
  try {
    const c = { ...ctx(), model: 'glm-5.3' };
    assert.equal(applyClient('codex', c, { backupRoot: sb.backupRoot }).changed, true);
    assert.equal(applyClient('codex', c, { backupRoot: sb.backupRoot }).changed, false, '同一模型第二次还报有改动');
  } finally { sb.cleanup(); }
});

// ── 上下文派生 / 校验（纯函数，不需桥）──────────────────────────

/** 一份假 base：精选集只有 deepseek，完整目录额外有 kimi-k3。 */
const fakeBase = () => ({
  token: 't', baseUrlOpenAI: 'o', baseUrlAnthropic: 'a',
  models: [{ id: 'deepseek-v4.1-flash', name: 'D', context: 1, maxOutput: 2 }],
  catalogById: new Map([
    ['deepseek-v4.1-flash', { id: 'deepseek-v4.1-flash', name: 'D', context: 1, maxOutput: 2 }],
    ['kimi-k3', { id: 'kimi-k3', name: 'Kimi-K3', context: 960000, maxOutput: 32000 }],
  ]),
  catalogIds: new Set(['deepseek-v4.1-flash', 'kimi-k3']),
  defaultModel: 'deepseek-v4.1-flash',
  responsesModel: 'glm-5.3',
  anthropicModel: 'glm-5.3',
  running: true,
});

test('defaultModelFor：三层协议各自的默认与桥的映射对齐', () => {
  const base = fakeBase();
  assert.equal(defaultModelFor(base, 'codex'), 'glm-5.3');
  assert.equal(defaultModelFor(base, 'claude'), 'glm-5.3');
  assert.equal(defaultModelFor(base, 'opencode'), 'deepseek-v4.1-flash');
});

test('assertModelKnown：目录里没有的模型被拦；未选/桥未起（目录空）时放行', () => {
  const base = fakeBase();
  assert.equal(assertModelKnown('kimi-k3', base), null);
  assert.equal(assertModelKnown(null, base), null, '没显式选 → 用默认，永远合法');
  assert.match(assertModelKnown('nope-1', base), /未知的模型/);
  assert.equal(assertModelKnown('anything', { catalogIds: new Set() }), null, '桥未起、无目录可校时应放行');
});

test('contextForClient：未选用默认，选非精选模型时从完整目录补元数据', () => {
  const base = fakeBase();
  // codex 默认 glm-5.3：既不在精选 models、也不在 catalogById → 回退裸元数据，但要补进 models
  const codexCtx = contextForClient(base, 'codex', null);
  assert.equal(codexCtx.model, 'glm-5.3');
  assert.ok(codexCtx.models.some((m) => m.id === 'glm-5.3'), '默认模型未被补进 models');
  // 选非精选模型 kimi-k3 → 从完整目录拿到真实上下文
  const oc = contextForClient(base, 'opencode', 'kimi-k3');
  assert.equal(oc.model, 'kimi-k3');
  const kimi = oc.models.find((m) => m.id === 'kimi-k3');
  assert.ok(kimi, '所选模型没被补进 models');
  assert.equal(kimi.context, 960000);
});

test('modelOptions：有完整目录时给全量，桥没起时退回精选集', () => {
  assert.deepEqual(modelOptions(fakeBase()).map((o) => o.id), ['deepseek-v4.1-flash', 'kimi-k3']);
  const noCatalog = { catalogById: new Map(), models: [{ id: 'a', name: 'A' }] };
  assert.deepEqual(modelOptions(noCatalog).map((o) => o.id), ['a']);
});

// ── 模型是用户的选择，不能被"默认值"覆盖 ────────────────────────────────

test('currentModelFor：从配置文件里读回当前写着的接入模型', () => {
  const box = sandbox({
    files: {
      codex: 'model = "glm-5.3"\nmodel_provider = "workbuddy"\n',
      claude: JSON.stringify({ env: { ANTHROPIC_MODEL: 'deepseek-v4.1-flash' } }),
      opencode: JSON.stringify({ model: 'workbuddy/kimi-k3' }),
    },
  });
  try {
    assert.equal(currentModelFor(findClient('codex')), 'glm-5.3');
    assert.equal(currentModelFor(findClient('claude')), 'deepseek-v4.1-flash');
    // opencode 的 model 带 provider 前缀 —— 只有我们自己写进去的那种才算
    assert.equal(currentModelFor(findClient('opencode')), 'kimi-k3');
  } finally { box.cleanup(); }
});

test('currentModelFor：读不到 / 不是我们的写法时一律返回 null（交给默认值）', () => {
  const box = sandbox({
    files: {
      codex: 'model_provider = "custom"\n',                       // 没有 model 键
      claude: '{}',
      opencode: JSON.stringify({ model: 'anthropic/claude-sonnet-4' }),  // 别的 provider
    },
  });
  try {
    assert.equal(currentModelFor(findClient('codex')), null);
    assert.equal(currentModelFor(findClient('claude')), null);
    assert.equal(currentModelFor(findClient('opencode')), null);
    // 文件都不存在时也不能抛
    rmSync(box.paths.opencode, { force: true });
    assert.equal(currentModelFor(findClient('opencode')), null);
  } finally { box.cleanup(); }
});

test('resolveModelChoice：显式选择 > 文件里的现状（且在当前目录里）> 默认', () => {
  const box = sandbox({ files: { codex: 'model = "kimi-k3"\n' } });
  try {
    const base = fakeBase();
    const codex = findClient('codex');
    assert.equal(resolveModelChoice(base, codex, 'deepseek-v4.1-flash'), 'deepseek-v4.1-flash', '显式选择优先');
    assert.equal(resolveModelChoice(base, codex, null), 'kimi-k3', '没显式选时认文件里那个');
    // 文件里是个目录里没有的模型（比如 Codex 原生名）→ 不认，回落默认
    writeFileSync(box.paths.codex, 'model = "gpt-5.1-codex"\n');
    assert.equal(resolveModelChoice(base, codex, null), null);
  } finally { box.cleanup(); }
});

test('【回归】用户自己选的模型不能被当成"配置漂移"', () => {
  /*
   * 现场：用户上次把 Codex 选成 deepseek-v4.1-flash 写进去了，重新打开面板时
   * 若不认这个值，面板会按桥的默认（glm-5.3）重算 → 明明刚写好的配置被报成
   * 「已接入，需重新写入」；用户照着点一次「重新写入」，反而把他自己的选择改掉。
   * 界面在制造一件不存在的事，还顺手覆盖了用户的偏好。
   */
  const box = sandbox({ files: { codex: '' } });
  try {
    const codex = findClient('codex');
    const base = fakeBase();
    const ctx1 = contextForClient(base, 'codex', 'deepseek-v4.1-flash');
    assert.equal(applyClient('codex', ctx1, { backupRoot: box.backupRoot }).ok, true);

    // 重新打开面板：没有显式选择 → 认文件里那个
    const chosen = resolveModelChoice(base, codex, null);
    assert.equal(chosen, 'deepseek-v4.1-flash');
    const plan = planClient('codex', contextForClient(base, 'codex', chosen), { backupRoot: box.backupRoot });
    assert.equal(plan.changed, false, '刚写好的配置不该被报成需要重新写入');
    assert.deepEqual(plan.changes, []);
  } finally { box.cleanup(); }
});

// ── 多模型接入 ──────────────────────────────────────────────────────────
//
// 一个客户端能"接几个模型"，三个客户端各不相同：
//   opencode  —— provider 下就是一张模型表，写几个就有几个；
//   Claude Code —— `modelPicker` 把任意多个模型列进 /model 选择器；
//   Codex     —— 认 `model_catalog_json` 指向的目录文件，目录里列全才有得选。
// 共同点：**默认/主模型只有一个**，其余的是"可切换"。

const MULTI = [
  { id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash', context: 1000000, maxOutput: 128000 },
  { id: 'glm-5.3', name: 'GLM-5.3', context: 1000000, maxOutput: 48000 },
  { id: 'kimi-k3', name: 'Kimi-K3', context: 960000, maxOutput: 32000 },
];
const baseWith = () => ({ ...fakeBase(), models: MULTI, catalogById: new Map(MULTI.map((m) => [m.id, m])), catalogIds: new Set(MULTI.map((m) => m.id)) });

test('多模型：勾选几个就写几个，主模型一定在集合里', () => {
  const base = baseWith();
  const ctx = contextForClient(base, 'opencode', 'glm-5.3', ['deepseek-v4.1-flash', 'glm-5.3', 'kimi-k3']);
  assert.deepEqual(ctx.models.map((m) => m.id), ['deepseek-v4.1-flash', 'glm-5.3', 'kimi-k3']);
  assert.equal(ctx.model, 'glm-5.3');
  // 主模型不在勾选里 → 仍要补进去，否则客户端里选不到它
  const ctx2 = contextForClient(base, 'opencode', 'glm-5.3', ['kimi-k3']);
  assert.deepEqual(ctx2.models.map((m) => m.id), ['kimi-k3', 'glm-5.3']);
  // 没给集合 → 精选集（老行为不变）
  const ctx3 = contextForClient(base, 'opencode', null, null);
  assert.deepEqual(ctx3.models.map((m) => m.id), MULTI.map((m) => m.id));
});

test('多模型：重复 id 只写一次（Codex 目录里重复 slug 会让它不知道用哪条）', () => {
  const ctx = contextForClient(baseWith(), 'opencode', 'glm-5.3', ['glm-5.3', 'glm-5.3', 'kimi-k3']);
  assert.deepEqual(ctx.models.map((m) => m.id), ['glm-5.3', 'kimi-k3']);
});

test('assertModelsKnown：一批里哪怕只有一个不认识也要拦下，并一次报全', () => {
  const base = baseWith();
  assert.equal(assertModelsKnown(['glm-5.3', 'kimi-k3'], base), null);
  const err = assertModelsKnown(['glm-5.3', 'nope-1', 'nope-2'], base);
  assert.match(err, /nope-1/);
  assert.match(err, /nope-2/);
});

test('Claude Code：≥2 个模型时写 modelPicker，且替换掉内置列表', () => {
  const box = sandbox({ files: { claude: '{}' } });
  try {
    const base = baseWith();
    const ctx = contextForClient(base, 'claude', 'glm-5.3', ['deepseek-v4.1-flash', 'glm-5.3']);
    const r = applyClient('claude', ctx, { backupRoot: box.backupRoot });
    assert.equal(r.ok, true);
    const cfg = JSON.parse(readFileSync(box.paths.claude, 'utf8'));
    assert.equal(cfg.env.ANTHROPIC_MODEL, 'glm-5.3');
    assert.deepEqual(cfg.modelPicker.options.map((o) => o.model), ['deepseek-v4.1-flash', 'glm-5.3']);
    /*
     * 必须替换内置列表：Base URL 指向桥之后，内置的 Sonnet/Opus/Haiku 会被桥映射到
     * **别的**模型 —— 留着它们就是"选了 Sonnet 实际跑 glm-5.3"。
     */
    assert.equal(cfg.modelPicker.replaceBuiltInOptions, true);
    assert.equal(r.verify.ok, true, '静态自检要认得多模型');

    // 撤销：modelPicker 与 env 一起逐键还原（文件本来没有这些键 → 回到 {}）
    const undone = undoClient('claude', { backupRoot: box.backupRoot });
    assert.equal(undone.ok, true);
    assert.deepEqual(JSON.parse(readFileSync(box.paths.claude, 'utf8')), {});
  } finally { box.cleanup(); }
});

test('Claude Code：只有一个模型时不写 modelPicker（不动内置列表）', () => {
  const box = sandbox({ files: { claude: '{}' } });
  try {
    const ctx = contextForClient(baseWith(), 'claude', 'glm-5.3', ['glm-5.3']);
    applyClient('claude', ctx, { backupRoot: box.backupRoot });
    const cfg = JSON.parse(readFileSync(box.paths.claude, 'utf8'));
    assert.equal(cfg.modelPicker, undefined);
  } finally { box.cleanup(); }
});

test('opencode：声明的模型表就是勾选的那批，默认模型指向主模型', () => {
  const box = sandbox({ files: { opencode: '{}' } });
  try {
    const ctx = contextForClient(baseWith(), 'opencode', 'kimi-k3', ['deepseek-v4.1-flash', 'kimi-k3']);
    const r = applyClient('opencode', ctx, { backupRoot: box.backupRoot });
    assert.equal(r.ok, true);
    const cfg = JSON.parse(readFileSync(box.paths.opencode, 'utf8'));
    assert.deepEqual(Object.keys(cfg.provider.workbuddy.models), ['deepseek-v4.1-flash', 'kimi-k3']);
    assert.equal(cfg.model, 'workbuddy/kimi-k3');
    assert.equal(r.verify.ok, true);
  } finally { box.cleanup(); }
});

test('Codex：生成模型目录并接管 model_catalog_json，撤销连目录一起还原', () => {
  const box = sandbox({ files: { codex: 'model = "glm-5.2"\n' } });
  try {
    // 造一份"用户已有的、别人的"目录（模拟 cc-switch）
    const tpl = { slug: 'x', display_name: 'X', context_window: 1000, model_messages: { instructions_template: 'keep me' } };
    writeFileSync(join(box.paths.codex, '..', 'other-catalog.json'),
      JSON.stringify({ models: [tpl, { ...tpl, slug: 'glm-5.3', display_name: '别人的 GLM' }] }, null, 2));
    writeFileSync(box.paths.codex, 'model = "glm-5.2"\nmodel_catalog_json = "other-catalog.json"\n');

    const base = baseWith();
    const ctx = contextForClient(base, 'codex', 'glm-5.3', ['glm-5.3', 'kimi-k3']);
    const plan = planClient('codex', ctx, { backupRoot: box.backupRoot });
    assert.ok(plan.catalog, '应当计划写一份模型目录');
    assert.deepEqual(plan.catalog.added, ['kimi-k3'], '已有的 glm-5.3 不重复加');
    assert.equal(plan.catalog.kept, 2, '别人原有的条目一律保留');

    const r = applyClient('codex', ctx, { backupRoot: box.backupRoot });
    assert.equal(r.ok, true);
    assert.equal(r.verify.ok, true, '静态自检要核到目录里真的列了这些模型');

    const cfg = readFileSync(box.paths.codex, 'utf8');
    assert.match(cfg, /model_catalog_json = "workbuddy-model-catalog\.json"/);
    const catalog = JSON.parse(readFileSync(join(box.paths.codex, '..', 'workbuddy-model-catalog.json'), 'utf8'));
    assert.deepEqual(catalog.models.map((m) => m.slug), ['x', 'glm-5.3', 'kimi-k3']);
    assert.equal(catalog.models[1].display_name, '别人的 GLM', '同名条目保留用户原有的那条，不覆盖');
    assert.equal(catalog.models[2].model_messages.instructions_template, 'keep me', '模板字段要成组继承');

    // 撤销：key 还原成 cc-switch 那份，我们建的文件删掉
    const undone = undoClient('codex', { backupRoot: box.backupRoot });
    assert.equal(undone.ok, true);
    assert.match(readFileSync(box.paths.codex, 'utf8'), /model_catalog_json = "other-catalog\.json"/);
    assert.equal(existsSync(join(box.paths.codex, '..', 'workbuddy-model-catalog.json')), false, '我们建的目录文件要删掉');
    assert.equal(existsSync(join(box.paths.codex, '..', 'other-catalog.json')), true, '别人的目录文件不能动');
  } finally { box.cleanup(); }
});

test('Codex：撤销要把"我们改过的"目录文件还原成原样', () => {
  const box = sandbox({ files: { codex: '' } });
  try {
    /*
     * 真实场景：上一次也是我们接的 —— 配置里的键指向我们的目录文件，
     * 文件里已经有几条模型。这次勾了新的模型，会把那份文件改大；
     * 撤销就必须把它还原成改动前的内容，而不是删掉或留着改大的版本。
     */
    const catPath = join(box.paths.codex, '..', 'workbuddy-model-catalog.json');
    const tpl = { slug: 'glm-5.3', display_name: 'GLM', context_window: 1000 };
    writeFileSync(catPath, JSON.stringify({ models: [tpl] }, null, 2));
    const before = readFileSync(catPath, 'utf8');
    writeFileSync(box.paths.codex, 'model_catalog_json = "workbuddy-model-catalog.json"\n');

    const ctx = contextForClient(baseWith(), 'codex', 'glm-5.3', ['glm-5.3', 'kimi-k3']);
    assert.equal(applyClient('codex', ctx, { backupRoot: box.backupRoot }).ok, true);
    assert.notEqual(readFileSync(catPath, 'utf8'), before, '这次写入应当改了目录');

    const undone = undoClient('codex', { backupRoot: box.backupRoot });
    assert.equal(undone.ok, true);
    assert.equal(readFileSync(catPath, 'utf8'), before, '撤销后应当逐字节还原成原样');
    assert.equal(undone.catalog.restored, true);
  } finally { box.cleanup(); }
});

test('Codex：本机没有任何目录模板时如实降级，不硬编造条目', () => {
  const box = sandbox({ files: { codex: '' } });
  try {
    const plan = planModelCatalog(findClient('codex'), { models: MULTI });
    assert.match(plan.skipped, /模板/);
  } finally { box.cleanup(); }
});

test('Codex：配置没变、但目录需要纠正时，也必须真的写下去', () => {
  /*
   * 现场（修 code mode 时踩到的）：`model_catalog_json` 已经写对了，
   * 所以 config.toml 层面"无需改动" —— applyClient 于是**提前返回**，
   * 那份写坏的目录文件根本没被重写，面板还显示「已接入」，
   * 用户没有任何入口触发纠正。判断"要不要动手"必须**连目录一起看**。
   */
  const box = sandbox({ files: { codex: '' } });
  try {
    const base = baseWith();
    const ctx = contextForClient(base, 'codex', 'glm-5.3', ['glm-5.3', 'kimi-k3']);

    // 给一份模板（否则沙箱里既没有现成目录、也没有 models_cache，压根不会生成目录）
    writeFileSync(join(box.paths.codex, '..', 'models_cache.json'), JSON.stringify({
      models: [{ slug: 'gpt-5.6-sol', display_name: 'Sol', context_window: 400000, use_responses_lite: true, tool_mode: 'code_mode_only' }],
    }, null, 2));

    // 先正常接一次，得到"配置已就绪"的状态
    assert.equal(applyClient('codex', ctx, { backupRoot: box.backupRoot }).ok, true);

    // 手工把目录改回旧版本写坏的样子（code mode 开关）
    const catPath = join(box.paths.codex, '..', 'workbuddy-model-catalog.json');
    const broken = JSON.parse(readFileSync(catPath, 'utf8'));
    for (const m of broken.models) { m.use_responses_lite = true; m.tool_mode = 'code_mode_only'; }
    writeFileSync(catPath, JSON.stringify(broken, null, 2));

    // 此时 config.toml 一个字都不用改，但目录必须被纠正
    const plan = planClient('codex', ctx, { backupRoot: box.backupRoot });
    assert.deepEqual(plan.changes, [], '配置层面确实没有改动');
    assert.equal(plan.changed, true, '目录要纠正 → 计划必须显示"有改动"，否则界面不会提示重新写入');
    assert.deepEqual(plan.catalog.refreshed, ['glm-5.3', 'kimi-k3'], '我们自己写的条目要重算');

    const r = applyClient('codex', ctx, { backupRoot: box.backupRoot });
    assert.equal(r.changed, true, '不能因为配置没变就跳过目录写入');
    const fixed = JSON.parse(readFileSync(catPath, 'utf8'));
    assert.equal(fixed.models.every((m) => m.use_responses_lite === false && m.tool_mode === undefined), true,
      '写完之后每条都该回到经典 function tools');
    assert.equal(r.verify.ok, true);
  } finally { box.cleanup(); }
});

test('Codex：勾选的模型现有目录里都有 → 不接管那个键', () => {
  const box = sandbox({ files: { codex: '' } });
  try {
    const tpl = { slug: 'glm-5.3', display_name: 'GLM', context_window: 1000 };
    writeFileSync(join(box.paths.codex, '..', 'other.json'), JSON.stringify({ models: [tpl] }, null, 2));
    writeFileSync(box.paths.codex, 'model_catalog_json = "other.json"\n');
    const plan = planModelCatalog(findClient('codex'), { models: [{ id: 'glm-5.3', name: 'GLM', context: 1000 }] });
    assert.match(plan.skipped, /都已经有/);
  } finally { box.cleanup(); }
});

/*
 * 目录条目里的**行为开关**必须由我们定死，不能随模板漂。
 *
 * 现场：cc-switch 切走时删掉了 `model_catalog_json`，重新接入时没有现成目录可当模板，
 * 于是退回用 Codex 自己的 `models_cache.json`（gpt-5.6-sol）当模板 ——
 * 把它的 `use_responses_lite: true` + `tool_mode: "code_mode_only"` 一起抄给了桥的模型。
 * 结果 Codex 改用 **code mode 的工具协议**（工具塞在 `input[].additional_tools`，
 * shell / apply_patch 全收进一个 freeform 的 `exec`），而桥的上游是 chat/completions，
 * 不认这套 → 上游一个工具都收不到 → 模型只好把工具调用写进正文
 * （用户截图里那串 `<||DSML||invoke name="exec_command">`），一个回合就此结束。
 */
test('Codex：目录条目不能继承模板的 code mode 行为开关', () => {
  const box = sandbox({ files: { codex: '' } });
  try {
    // 模拟"模板来自 Codex 官方模型缓存"：带 code mode 字段
    const codeModeTemplate = {
      slug: 'gpt-5.6-sol', display_name: 'GPT-5.6-Sol', context_window: 400000,
      model_messages: { instructions_template: 'KEEP' },
      use_responses_lite: true, tool_mode: 'code_mode_only', multi_agent_version: 'v2',
      truncation_policy: { mode: 'tokens', limit: 10000 },
    };
    writeFileSync(join(box.paths.codex, '..', 'models_cache.json'),
      JSON.stringify({ models: [codeModeTemplate] }, null, 2));

    const plan = planModelCatalog(findClient('codex'), { models: MULTI });
    const entry = JSON.parse(plan.text).models[0];
    assert.equal(entry.use_responses_lite, false, '必须是经典 function tools（use_responses_lite: false）');
    assert.equal(entry.tool_mode, undefined, '不能带 tool_mode（code_mode_only 会让 Codex 换协议）');
    assert.equal(entry.multi_agent_version, undefined);
    assert.equal(entry.model_messages.instructions_template, 'KEEP', '结构字段照旧从模板继承');
    assert.equal(entry.context_window, MULTI[0].context);
  } finally { box.cleanup(); }
});

test('Codex：我们自己写过的旧条目按新规则重算，别人的条目一字不动', () => {
  const box = sandbox({ files: { codex: '' } });
  try {
    const stale = {
      slug: 'glm-5.3', display_name: 'GLM-5.3',
      description: 'GLM-5.3 — via WorkBuddy local bridge',      // “我们写的”标记
      use_responses_lite: true, tool_mode: 'code_mode_only', context_window: 1,
      model_messages: { instructions_template: 'X' },
    };
    const foreign = {
      slug: 'kimi-k3', display_name: '别人的 Kimi', description: '别人的隧道模型',
      use_responses_lite: false, context_window: 999, model_messages: { instructions_template: 'FOREIGN' },
    };
    writeFileSync(join(box.paths.codex, '..', 'catalog.json'),
      JSON.stringify({ models: [stale, foreign] }, null, 2));
    writeFileSync(box.paths.codex, 'model_catalog_json = "catalog.json"\n');

    const plan = planModelCatalog(findClient('codex'), { models: MULTI });
    assert.deepEqual(plan.refreshed, ['glm-5.3'], '我们自己写过的条目要重算');
    assert.equal(plan.kept, 1, '别人的条目保留');

    const models = JSON.parse(plan.text).models;
    const ours = models.find((m) => m.slug === 'glm-5.3');
    const theirs = models.find((m) => m.slug === 'kimi-k3');
    assert.equal(ours.use_responses_lite, false, '旧条目也要被纠正回经典工具协议');
    assert.equal(ours.tool_mode, undefined);
    assert.equal(ours.context_window, MULTI[1].context, '上下文按我们目录里的真实值');
    assert.equal(theirs.model_messages.instructions_template, 'FOREIGN', '别人的条目一字不动');
    assert.equal(theirs.context_window, 999);
  } finally { box.cleanup(); }
});

test('currentModelsFor / resolveSelection：从文件读回"接了几个、是哪些"', () => {
  const box = sandbox({
    files: {
      claude: JSON.stringify({ modelPicker: { options: [{ model: 'glm-5.3' }, { model: 'kimi-k3' }, { model: '别人的' }] } }),
      opencode: JSON.stringify({ provider: { workbuddy: { models: { 'glm-5.3': {}, 'kimi-k3': {} } } }, model: 'workbuddy/kimi-k3' }),
      codex: '',
    },
  });
  try {
    const base = baseWith();
    // 目录里"别人的模型"不算（桥不认识的不能当成我们的接入集合）
    assert.deepEqual(currentModelsFor(findClient('claude'), base), ['glm-5.3', 'kimi-k3']);
    assert.deepEqual(currentModelsFor(findClient('opencode'), base), ['glm-5.3', 'kimi-k3']);
    assert.deepEqual(currentModelsFor(findClient('codex'), base), []);
    assert.deepEqual(resolveSelection(base, findClient('claude'), ['kimi-k3']), ['kimi-k3'], '显式勾选优先');
    assert.deepEqual(resolveSelection(base, findClient('claude'), null), ['glm-5.3', 'kimi-k3']);
  } finally { box.cleanup(); }
});
