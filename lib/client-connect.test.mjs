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
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** 仓库根（子进程用例要拿它当 cwd 基准）。 */
const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

/*
 * 隔离：Claude Code 接入会读 dsh 面板的按模型偏好（`<DSH_HOME>/workbuddy-model-prefs.json`）。
 * 指向使用者的真实 `~/.dsh` 会让用例随本机状态漂移 —— 这里换成临时目录。
 */
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'wb-dsh-home-test-'));

import {
  applyClient, undoClient, planClient, verifyWritten, findClient, tomlTopLevel, tomlUpsertSection, tomlRemoveSection,
  assertModelKnown, assertModelsKnown, contextForClient, defaultModelFor, modelOptions,
  currentModelFor, currentModelsFor, resolveModelChoice, resolveSelection,
  planModelCatalog, clientPath, listClients, resolveBackupRoot,
  buildConnectBase, catalogCachePath,
  clientMode, connectSnapshot, recordedConnect, switchClientMode, verifyAgainstBridge,
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
  /*
   * 模拟家目录，并把**所有会影响路径解析的环境变量**都锁进沙箱。
   *
   * 1. 家目录：Windows 上 `os.homedir()` 认 `USERPROFILE`，POSIX 认 `HOME` —— 两个都要设。
   * 2. `XDG_CONFIG_HOME` **必须显式清掉**：opencode 的全局目录优先跟它走
   *    （见 `opencodeGlobalDir()`），而 CI 环境里**可能就设着它**（本地 Windows 没有）。
   *    不清的后果实测过：同一个用例在本地绿、在 CI（ubuntu）红，报错是
   *    「期望 /tmp/wb-connect-xxx/home/.config/... 实际 /home/runner/.config/...」——
   *    看起来像"家目录算错了"，完全指不到真凶是 XDG。
   *
   * 改过的变量在 `cleanup()` 里逐个还原，避免泄漏给同文件内的后续用例。
   */
  const savedEnv = {
    USERPROFILE: process.env.USERPROFILE,
    HOME: process.env.HOME,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  };
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  delete process.env.XDG_CONFIG_HOME;
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
  return {
    dir, home, backupRoot, paths,
    cleanup: () => {
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
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
    // key 必须是**环境变量名**：下面 finally 用它来还原，写成 'codex' 之类
    // 会变成 `delete process.env.codex`（no-op），本产品的三个覆盖变量就漏还原了。
    WORKBUDDY_CODEX_CONFIG: process.env.WORKBUDDY_CODEX_CONFIG,
    WORKBUDDY_CLAUDE_SETTINGS: process.env.WORKBUDDY_CLAUDE_SETTINGS,
    WORKBUDDY_OPENCODE_CONFIG: process.env.WORKBUDDY_OPENCODE_CONFIG,
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
    /*
     * 用 `spawnSync` + `stdio: ['ignore','pipe','pipe']`，**不用 `execFileSync`**。
     *
     * 后者默认给 stdin 也开管道，在这台机器上必抛 `EBUSY`
     * （`spawnSync C:\...\node.exe EBUSY`，本项目在子进程一节记过这条）。
     * 它是否触发取决于**本进程的 stdio 形态** —— 前台跑碰巧过、把输出重定向到
     * 文件（后台任务）时必红，正是这种"看运行环境脸色"的假红把发布门禁的
     * 可信度搅浑的（2026-10-12 实测：`release:check` 后台重定向运行时，
     * 124 例里就它 1 例红，报的却是环境错误）。
     * 显式忽略 stdin 之后，两种跑法结果一致。
     *
     * 另外：`spawnSync` **失败不抛异常**，只把错误塞进 `error` / `status` ——
     * 必须显式检查返回值，否则拿到的 stdout 是 null，断言会红在一个不相干的地方。
     */
    const run = (cwd) => {
      const r = spawnSync(process.execPath, ['-e', script], {
        cwd, encoding: 'utf8', env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      assert.equal(r.status, 0, `子进程未正常退出（${r.error || r.status}）：${(r.stderr || '').slice(0, 200)}`);
      return (r.stdout || '').trim();
    };

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
    assert.deepEqual(plan.skippedKeys, [
      'env.ANTHROPIC_BASE_URL', 'env.ANTHROPIC_API_KEY', 'env.ANTHROPIC_MODEL',
    ], '计划里要列出被跳过的键（modelPicker 是顶层键，不受 env 形状影响）');
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

/*
 * Claude Code 的上下文窗口（issue #18）：
 * 它对**不认识的模型 id** 一律按 200K 假设窗口（不读 /v1/models），
 * v2.1.193+ 用 `CLAUDE_CODE_MAX_CONTEXT_TOKENS` 覆盖那个假设值。
 * 不写这一行 = 用户在面板里把模型调到 1M，Claude Code 仍按 200K 规划。
 */
test('Claude Code：写入 CLAUDE_CODE_MAX_CONTEXT_TOKENS（按模型上限）与后台任务模型', () => {
  const sb = sandbox({ files: { claude: '{}' } });
  const prevHome = process.env.DSH_HOME;
  const home = mkdtempSync(join(tmpdir(), 'wb-dsh-home-'));
  try {
    // 隔离：不能读到使用者真实的 ~/.dsh/workbuddy-model-prefs.json
    process.env.DSH_HOME = home;
    const base = { ...baseWith(), anthropicFastModel: 'glm-5.3-flash' };
    const c = contextForClient(base, 'claude', 'glm-5.3', ['deepseek-v4.1-flash', 'glm-5.3']);
    const r = applyClient('claude', c, { backupRoot: sb.backupRoot });
    assert.equal(r.ok, true, r.error);
    const obj = JSON.parse(readFileSync(sb.paths.claude, 'utf8'));
    assert.equal(obj.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '1000000',
      '要写**模型上限**，不是桥报的默认档（300K 那种）');
    assert.equal(obj.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'glm-5.3-flash',
      '后台任务（标题生成、文件摘要）用的模型要写进配置，用户看得见也能改');
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
    sb.cleanup();
  }
});

test('Claude Code：dsh 面板里按模型设的上下文窗口会落到客户端，且被模型上限收敛', () => {
  const sb = sandbox({ files: { claude: '{}' } });
  const prevHome = process.env.DSH_HOME;
  const home = mkdtempSync(join(tmpdir(), 'wb-dsh-home-'));
  try {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'workbuddy-model-prefs.json'), JSON.stringify({
      contextWindowByModel: { 'glm-5.3': 600000, 'kimi-k3': 5000000 },
    }));
    process.env.DSH_HOME = home;
    const c = contextForClient(baseWith(), 'claude', 'glm-5.3', ['glm-5.3']);
    applyClient('claude', c, { backupRoot: sb.backupRoot });
    const obj = JSON.parse(readFileSync(sb.paths.claude, 'utf8'));
    assert.equal(obj.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '600000',
      '面板里设的值要生效（此前只作用于 dsh，外部客户端完全看不到）');

    // 超过模型上限的值要收敛（上游吃不下）
    const c2 = contextForClient(baseWith(), 'claude', 'kimi-k3', ['kimi-k3']);
    applyClient('claude', c2, { backupRoot: sb.backupRoot });
    const obj2 = JSON.parse(readFileSync(sb.paths.claude, 'utf8'));
    assert.equal(obj2.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '960000', '不得超过模型上限');
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
    sb.cleanup();
  }
});

/*
 * 「验证接入」对 Claude Code 必须验**它真正要走的那条路**（Anthropic
 * `/v1/messages`）。只验 `/v1/models` 等于没验 —— 面板说"验证通过"，
 * 用户进客户端才发现 400（issue #18）。
 */
test('验证接入：Claude Code 额外验 Anthropic 路径（count_tokens，不打上游、不耗额度）', async () => {
  const { createServer } = await import('node:http');
  const hits = [];
  let anthropicStatus = 200;
  const server = createServer((req, res) => {
    hits.push(req.url);
    if (req.url.endsWith('/v1/messages/count_tokens')) {
      res.writeHead(anthropicStatus, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(anthropicStatus === 200 ? { input_tokens: 7 } : { error: 'nope' }));
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'glm-5.3' }] }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const client = findClient('claude');
    const baseUrl = `http://127.0.0.1:${port}/v1`;
    let ok = await verifyAgainstBridge(client, { baseUrl, tokenOverride: 'tok' });
    /*
     * 连接失败重试一次：undici 的连接池按 origin 复用，前面的用例若用过同一个
     * 端口，池里那条 socket 可能已被对端关闭 → 首次 fetch 报 'fetch failed'。
     * 环境抖动重试一次即可，协议错误不会被吞（重试后仍失败）。
     */
    if (!ok.ok && /连不上桥/.test(String(ok.reason || ''))) {
      await new Promise((r) => setTimeout(r, 120));
      ok = await verifyAgainstBridge(client, { baseUrl, tokenOverride: 'tok' });
    }
    assert.equal(ok.ok, true, JSON.stringify(ok));
    assert.ok(hits.some((u) => u.endsWith('/v1/messages/count_tokens')), '必须打一次 Anthropic 路径');

    // Anthropic 路径坏了 → 如实报失败（不能还说"验证通过"）
    anthropicStatus = 404;
    const bad = await verifyAgainstBridge(client, { baseUrl: `http://127.0.0.1:${port}/v1`, tokenOverride: 'tok' });
    assert.equal(bad.ok, false);
    assert.match(String(bad.reason), /Anthropic/);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('幂等：同一模型重复写入，第二次不报改动', () => {  const sb = sandbox({ files: { codex: CODEX_ORIGINAL } });
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
  {
    id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash', context: 1000000, maxOutput: 128000,
    efforts: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'], onlyReasoning: true,
  },
  {
    id: 'glm-5.3', name: 'GLM-5.3', context: 1000000, maxOutput: 48000,
    efforts: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'], onlyReasoning: true,
  },
  {
    id: 'kimi-k3', name: 'Kimi-K3', context: 960000, maxOutput: 32000,
    efforts: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'], onlyReasoning: true,
  },
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

test('Claude Code：≥2 个模型时写 modelPicker，且替换掉内置列表', () => {  const box = sandbox({ files: { claude: '{}' } });
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

test('Claude Code：只有一个模型也写 modelPicker（内置列表会被映射到别的模型）', () => {
  const box = sandbox({ files: { claude: '{}' } });
  try {
    const ctx = contextForClient(baseWith(), 'claude', 'glm-5.3', ['glm-5.3']);
    applyClient('claude', ctx, { backupRoot: box.backupRoot });
    const cfg = JSON.parse(readFileSync(box.paths.claude, 'utf8'));
    assert.deepEqual(cfg.modelPicker, {
      options: [{ model: 'glm-5.3', label: 'GLM-5.3', description: 'via WorkBuddy local bridge' }],
      replaceBuiltInOptions: true,
    }, '单模型也要替换内置列表，否则用户选 Sonnet 实际跑的是 glm-5.3');
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
    assert.equal(typeof r.backupHardened?.ok, 'boolean',
      '备份目录的权限收紧结果要如实回报（备份是"写之前的整份配置"，里面也有令牌）');

    const cfg = readFileSync(box.paths.codex, 'utf8');
    assert.match(cfg, /model_catalog_json = "workbuddy-model-catalog\.json"/);
    const catalog = JSON.parse(readFileSync(join(box.paths.codex, '..', 'workbuddy-model-catalog.json'), 'utf8'));
    assert.deepEqual(catalog.models.map((m) => m.slug), ['x', 'glm-5.3', 'kimi-k3']);
    assert.equal(catalog.models[1].display_name, '别人的 GLM', '同名条目保留用户原有的那条，不覆盖');
    /*
     * 系统提示 = **来源模板正文原样保留 + 末尾追加桥补充说明**（2026-10-13 改版）。
     *
     * 抓包（真实 codex.exe，临时 CODEX_HOME + 桩上游）证明：模板就是 Codex 的
     * **全量系统提示** —— 请求里没有 `instructions` 字段，`input[0]` 那条 developer
     * 消息逐字等于模板。所以整段替换等于把行为规范（工具纪律、文件编辑规矩、
     * 自主性那几节）一起删掉；而模板点名的 `apply_patch` / `exec_command` /
     * `write_stdin` / `view_image` 走桥时都成立。
     * 要补的是三件"这条链路上真的会错"的事：`tools` 之外还有一层要先 `tool_search`
     * 检索的 MCP 工具、freeform 的参数形状、回合纪律（"话说一半就断了"）。
     */
    const t = catalog.models[2].model_messages.instructions_template;
    assert.match(t, /^keep me/, '模板正文要原样保留（它不是什么工具清单，就是 Codex 的系统提示）');
    assert.equal(t.split('[workbuddy-bridge-notes]').length - 1, 1,
      '桥补充说明必须有且只有一段（哨兵行用来做幂等剥离）');
    assert.match(t, /The request's `tools` list is the complete set/,
      '要说清"请求里 tools 才是可直接调的完整集"这条事实（模板缺的就是这句）');
    /*
     * MCP 工具是**延迟下发**的：`tools[]` 里没有它们，只有一个 `tool_search`。
     * 这段必须把链路讲全（检索 → 命中 → 以 `mcp__<server>__<tool>` 可调），
     * 否则模型会像旧版那样直接断言"这能力不存在"，而不是先去检索。
     * 旧文案里那句"computer use 在这里不存在"就是被这条取代的过时断言。
     */
    assert.match(t, /search first with `tool_search`/, '要讲清 MCP 工具必须先经 `tool_search` 检索');
    assert.match(t, /`mcp__<server>__<tool>`/, '检索命中后的调用名要讲对（`mcp__<server>__<tool>`）');
    /*
     * sky 的幂等挂载写法必须教全 —— 不教的话模型每段代码都可能裸用 `sky`，
     * 内核 reset 之后就报 "Cannot read properties of undefined (reading 'get_window_state')"
     * （2026-10-13 16:4x 用户实测踩了三次）。
     */
    assert.match(t, /globalThis\.sky = \(await import\('@oai\/sky'\)\)\.sky/,
      'sky 的幂等挂载写法要写进提示（每段代码开头都执行一次）');
    assert.match(t, /state\.accessibility/,
      '要引导优先用无障碍树读界面 —— 截图是 base64 进历史，每一轮都重复发，贵一个数量级');
    assert.doesNotMatch(t, /computer use/,
      '"computer use 不存在"这类断言会随桥的进度变成假话，已删');
    assert.match(t, /pass the whole\s+payload as the string argument `input`/,
      'freeform 工具（apply_patch）的参数形状要讲对，否则模型会照 freeform 的写法蒙');
    assert.match(t, /[Ii]ssue the tool call in the same/,
      '回合纪律：宣布要做的事必须同一回合发工具调用，别说完就结束（"跑一半断联"的根因）');
    /*
     * 这段逐字进每一次请求，是要花 token 的 —— 立个上限防它悄悄膨胀。
     */
    assert.ok([...t.slice(t.indexOf('[workbuddy-bridge-notes]'))].length <= 1400,
      '桥补充说明要控制在 1400 字符以内（一段截图的 token 是它的几十倍，教对写法优先）');

    // 撤销：key 还原成 cc-switch 那份，我们建的文件删掉
    const undone = undoClient('codex', { backupRoot: box.backupRoot });
    assert.equal(undone.ok, true);
    assert.match(readFileSync(box.paths.codex, 'utf8'), /model_catalog_json = "other-catalog\.json"/);
    assert.equal(existsSync(join(box.paths.codex, '..', 'workbuddy-model-catalog.json')), false, '我们建的目录文件要删掉');
    assert.equal(existsSync(join(box.paths.codex, '..', 'other-catalog.json')), true, '别人的目录文件不能动');
  } finally { box.cleanup(); }
});

test('Codex：模型目录写失败时必须回滚 config.toml（不能留下半截接入）', () => {
  const box = sandbox({ files: { codex: 'model = "glm-5.2"\n' } });
  try {
    /*
     * 让目录写入必然失败：目标路径已经是一个**目录**。
     * 旧实现此时已经写完了 config.toml，却回报"配置文件未改动"——用户拿到的
     * 是一个指向不存在目录的配置，而且没有 manifest，连撤销入口都没有。
     */
    mkdirSync(join(box.paths.codex, '..', 'workbuddy-model-catalog.json'));
    // 模板来自 Codex 自己抓的 models_cache.json（否则 plan 会"没有模板"直接跳过）
    writeFileSync(join(box.paths.codex, '..', 'models_cache.json'), JSON.stringify({
      models: [{ slug: 'base', display_name: 'Base', context_window: 128000, model_messages: { instructions_template: 'tpl' } }],
    }));
    const before = readFileSync(box.paths.codex, 'utf8');
    const ctx = contextForClient(baseWith(), 'codex', 'glm-5.3', ['glm-5.3', 'kimi-k3']);
    const r = applyClient('codex', ctx, { backupRoot: box.backupRoot });
    assert.equal(r.ok, false);
    assert.match(String(r.error), /已恢复原配置|已删除本次新建的配置/);
    assert.equal(readFileSync(box.paths.codex, 'utf8'), before,
      '目录写失败后配置文件必须逐字节还原，不能留下半截接入');
  } finally { box.cleanup(); }
});

test('备份目录不可用时返回结构化错误（不能让 CLI/控制台看到裸异常）', () => {
  const box = sandbox({ files: { codex: 'model = "x"\n' } });
  try {
    const notDir = join(box.paths.codex, '..', 'not-a-dir');
    writeFileSync(notDir, 'x'); // 把"目录"位置占成普通文件
    const ctx = contextForClient(baseWith(), 'codex', 'glm-5.3', ['glm-5.3']);
    const r = applyClient('codex', ctx, { backupRoot: join(notDir, 'sub') });
    assert.equal(r.ok, false);
    assert.match(String(r.error), /接入失败|备份目录不可用/);
    assert.doesNotThrow(() => undoClient('codex', { backupRoot: join(notDir, 'sub') }),
      '撤销同样不能抛裸异常');
  } finally { box.cleanup(); }
});

test('Codex：目录冷启动重写时不能拿 128K/8K 占位值覆盖已有的真实上限', () => {
  const box = sandbox({ files: { codex: 'model_catalog_json = "workbuddy-model-catalog.json"\n' } });
  try {
    const catPath = join(box.paths.codex, '..', 'workbuddy-model-catalog.json');
    const own = {
      slug: 'glm-5.3',
      display_name: 'GLM-5.3',
      description: 'via WorkBuddy local bridge',
      context_window: 1000000,
      max_context_window: 1000000,
      max_output_tokens: 48000,
      truncation_policy: { mode: 'tokens', limit: 48000 },
      model_messages: { instructions_template: 'keep me' },
    };
    writeFileSync(catPath, JSON.stringify({ models: [own] }, null, 2));

    // 桥没起 / 目录为空：contextForClient 只能给出占位元数据
    const base = { ...fakeBase(), models: [], catalogById: new Map(), catalogIds: new Set() };
    const ctx = contextForClient(base, 'codex', 'glm-5.3', ['glm-5.3']);
    assert.equal(ctx.models[0].metadataUnknown, true, '占位元数据必须可识别（不能当事实）');

    const r = applyClient('codex', ctx, { backupRoot: box.backupRoot });
    assert.equal(r.ok, true, r.error);
    const catalog = JSON.parse(readFileSync(catPath, 'utf8'));
    const entry = catalog.models.find((m) => m.slug === 'glm-5.3');
    assert.equal(entry.context_window, 1000000, '冷目录不得把 1M 降级成 128K');
    assert.equal(entry.max_context_window, 1000000);
    assert.equal(entry.max_output_tokens, 48000, '冷目录不得把 48K 输出降级成 8K');
    assert.equal(entry.truncation_policy.limit, 48000);
  } finally { box.cleanup(); }
});

/*
 * 系统提示的「模板 + 补充」必须**幂等**。
 *
 * 现场：目录里的"来源模板"往往就是我们上一次写进去的成品（`readCatalogSource`
 * 拿现有目录里我们自己那条当模板）。不做剥离的话，每接一次就在上一版后面再叠
 * 一层补充说明 —— 提示越来越长，旧那层还带着过时的事实（比如"computer use 在这里
 * 不存在"这种被桥的进度推翻的断言）。
 * 做法：先算一版并落盘，再在同一现状下多勾一个模型强制重算，
 * 断言原本那条模型的系统提示**逐字节不变**、哨兵行仍只有一处。
 */
/*
 * 模板优先级：**别人的** > 官方 `models_cache.json` > 我们自己的条目。
 *
 * 为什么自己的条目必须垫底：那里面装着**上一版写进去的系统提示**，
 * 拿它当模板会让下一次生成在上一版的基础上继续退化。真实翻车：Oct-12 那版
 * 把 17KB 的官方提示换成了 5 行中性文案，之后无论怎么刷新都回不到官方提示
 * （它已经是"模板"了）。2026-10-13 实测发现并改掉。
 */
test('Codex：模板优先级 —— 别人的 > 官方 models_cache > 我们自己的条目', () => {
  const box = sandbox({ files: { codex: 'model = "glm-5.3"\n' } });
  try {
    // 官方那份（Codex 自己抓的目录，形状与系统提示都是"原厂"）
    writeFileSync(join(box.paths.codex, '..', 'models_cache.json'), JSON.stringify({
      models: [{ slug: 'gpt-5.6-sol', display_name: 'S', context_window: 1000, model_messages: { instructions_template: 'OFFICIAL PROMPT' } }],
    }, null, 2));
    // 现有的、我们自己写过的目录：带着"上一版写进去的"系统提示
    writeFileSync(join(box.paths.codex, '..', 'workbuddy-model-catalog.json'), JSON.stringify({
      models: [{
        slug: 'glm-5.3',
        display_name: 'GLM-5.3',
        context_window: 1000,
        use_responses_lite: false,
        description: 'GLM-5.3 — via WorkBuddy local bridge',
        model_messages: { instructions_template: 'OUR OLD NEUTRAL TEXT' },
      }],
    }, null, 2));
    writeFileSync(box.paths.codex, 'model = "glm-5.3"\nmodel_catalog_json = "workbuddy-model-catalog.json"\n');

    const plan = planModelCatalog(findClient('codex'), { models: MULTI.slice(1, 2) });
    assert.ok(plan.text, '要能生成');
    const entry = JSON.parse(plan.text).models.find((m) => m.slug === 'glm-5.3');
    assert.match(entry.model_messages.instructions_template, /^OFFICIAL PROMPT/,
      '模板要取自官方那份 —— 拿我们自己的成品当模板会让系统提示一代代退化');
    assert.doesNotMatch(entry.model_messages.instructions_template, /OUR OLD NEUTRAL TEXT/);
  } finally { box.cleanup(); }
});

test('Codex：反复生成目录时，桥补充说明不叠层（幂等）', () => {
  const box = sandbox({ files: { codex: 'model = "glm-5.3"\n' } });
  try {
    writeFileSync(join(box.paths.codex, '..', 'models_cache.json'),
      JSON.stringify({ models: [{ slug: 'gpt-5.6-sol', display_name: 'S', context_window: 1000, model_messages: { instructions_template: 'FAKE PROMPT' } }] }, null, 2));

    const first = planModelCatalog(findClient('codex'), { models: MULTI.slice(1, 3) });
    assert.ok(first.text, '第一版要能生成');
    writeFileSync(first.path, first.text);
    writeFileSync(box.paths.codex, 'model = "glm-5.3"\nmodel_catalog_json = "workbuddy-model-catalog.json"\n');

    const second = planModelCatalog(findClient('codex'), { models: MULTI });
    assert.ok(second.text, '第二版要能生成（新勾了一个模型）');
    assert.deepEqual(second.added, ['deepseek-v4.1-flash'], '新勾的那个进 added');
    assert.deepEqual(second.refreshed, [], '原有两条重算结果与现有一致 → 不算改动（这正是幂等的判据）');

    const before = JSON.parse(first.text).models.find((m) => m.slug === 'kimi-k3').model_messages.instructions_template;
    const after = JSON.parse(second.text).models.find((m) => m.slug === 'kimi-k3').model_messages.instructions_template;
    assert.equal(after, before, '同一模板 + 同一补充说明 → 逐字节相同');
    assert.equal((after.match(/\[workbuddy-bridge-notes\]/g) || []).length, 1, '哨兵行只有一处');
    assert.match(after, /^FAKE PROMPT/, '模板正文在剥离后原样保留（没被叠层吃掉）');
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
    assert.ok(entry.model_messages, 'model_messages 这个结构照旧从模板继承');
    assert.match(entry.model_messages.instructions_template, /^KEEP/,
      '模板正文原样保留（我们只在末尾追加桥补充说明）');
    assert.equal(entry.model_messages.instructions_template.split('[workbuddy-bridge-notes]').length - 1, 1,
      '补充说明只追加一段');
    assert.equal(entry.context_window, MULTI[0].context);
    // 输出上限与截断策略要跟着桥的实测值走（模板那个 10000 会把长回答提前砍断）
    assert.equal(entry.max_output_tokens, MULTI[0].maxOutput, '要采用桥报的单次输出上限');
    assert.equal(entry.truncation_policy.limit, MULTI[0].maxOutput, '截断策略要跟输出上限对齐');
  } finally { box.cleanup(); }
});

/**
 * `supports_search_tool` 声明 false —— 但**它的作用边界必须写在测试里**，
 * 免得后人以为"改这个字段就关掉了 web_search"。
 *
 * ## 实测结论（2026-10-13，`tools/dev/probe-codex-websearch-source.mjs`）
 *
 * A/B 对照：同一份目录只改这个字段（true / false 各跑一次真 `codex exec`），
 * 桥日志**两次都是** `dropped=web_search`。另外试过
 * `web_search_mode = "disabled"` 与 `[tools] web_search = false`，**都没用**。
 * → `web_search` 是 Codex 的**内置工具**，不由目录字段或这几个配置开关控制。
 *
 * 所以声明 false 的定位是「**事实陈述** + 万一将来 Codex 开始读它」，
 * **不是**"已经关掉了"。真正让模型不去撞墙的是系统提示里的桥补充说明
 * （`bridgeNotes` 明写 "web search … does not exist — do not call it"），
 * 真机实测模型会正确回答 `NO_WEB_SEARCH` 而不是去调用它。
 */
test('Codex：目录声明 supports_search_tool=false（但别指望它关掉 web_search）', () => {
  const box = sandbox({ files: { codex: '' } });
  try {
    // 模板带着搜索能力声明（cc-switch / 官方缓存都可能有）
    const tpl = {
      slug: 'tpl', display_name: 'T', context_window: 1000,
      supports_search_tool: true,
      web_search_tool_type: 'text_and_image',
      model_messages: { instructions_template: 'KEEP' },
    };
    writeFileSync(join(box.paths.codex, '..', 'models_cache.json'),
      JSON.stringify({ models: [tpl] }, null, 2));

    const plan = planModelCatalog(findClient('codex'), { models: MULTI });
    const entry = JSON.parse(plan.text).models[0];
    assert.equal(entry.supports_search_tool, false,
      '声明 false —— 这是事实陈述（桥的上游确实没有服务端检索）');
    assert.equal(entry.web_search_tool_type, undefined,
      'web_search_tool_type 要删掉（留着等于仍然声明搜索能力）');
    // 其余字段照旧继承，别把这条修过头
    assert.equal(entry.context_window, MULTI[0].context);
    assert.ok(entry.model_messages, 'model_messages 照旧继承');

    /*
     * 真正有效的那一手：系统提示里必须**明说没有联网检索**。
     * 模型据此不去调用 `web_search`（真机实测回答 NO_WEB_SEARCH）。
     * 这条断言防的是"以后有人把这段说明删了"。
     */
    assert.match(entry.model_messages.instructions_template, /web search[\s\S]{0,40}does not exist/i,
      '补充说明必须明说 web search 不存在 —— 这是让模型不去撞墙的唯一手段');
  } finally { box.cleanup(); }
});

/*
 * 档位必须与**桥实测的表**对齐，不能继承模板。
 *
 * 模板是 cc-switch 给"别的隧道"写的，它那份 `supported_reasoning_levels` 里带了
 * Codex 独有的 `ultra`（"自动任务委派"）。照抄的问题不是"会 400"（实测 `ultra`
 * 被上游当普通高力度收下），而是它**语义误导**：用户以为选了会触发委派，
 * 实际不会。桥的 `/v1/models` 有逐模型实测的 `reasoning_efforts`，以它为准。
 *
 * 另外两个边界：
 *   - 桥给**空数组** = 实测一档都不收（如网关不接的 claude-*）→ 照实声明空表，
 *     选择器里没有可选项（比列一串必然失败的强）。
 *   - 桥**没给**这个字段（旧版桥 / 缓存兜底）→ 继承模板，不猜。
 */
test('Codex：档位以桥的实测表为准，不继承模板的 ultra', () => {
  const box = sandbox({ files: { codex: '' } });
  try {
    const tpl = {
      slug: 'tpl', display_name: 'T', context_window: 1000,
      default_reasoning_level: 'low',
      supported_reasoning_levels: [
        { effort: 'low', description: 'l' }, { effort: 'medium', description: 'm' },
        { effort: 'high', description: 'h' }, { effort: 'xhigh', description: 'xh' },
        { effort: 'max', description: 'mx' }, { effort: 'ultra', description: 'u' },
      ],
    };
    writeFileSync(join(box.paths.codex, '..', 'models_cache.json'),
      JSON.stringify({ models: [tpl] }, null, 2));

    const plan = planModelCatalog(findClient('codex'), { models: MULTI });
    const entry = JSON.parse(plan.text).models[0];
    assert.deepEqual(entry.supported_reasoning_levels.map((l) => l.effort),
      ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
      '档位表要照桥的实测值（含 minimal，不含 Codex 独有的 ultra）');
    assert.ok(entry.supported_reasoning_levels.every((l) => typeof l.description === 'string' && l.description),
      '每一档都要有描述（选择器里要显示）');
    assert.equal(entry.default_reasoning_level, 'low',
      '默认档在实测表里 → 原样保留（不无谓地改动模板给的默认值）');

    // 模板的默认档不在我们的表里 → 落到表内的 medium
    const tpl2 = { ...tpl, default_reasoning_level: 'ultra' };
    writeFileSync(join(box.paths.codex, '..', 'models_cache.json'),
      JSON.stringify({ models: [tpl2] }, null, 2));
    const plan2 = planModelCatalog(findClient('codex'), { models: MULTI });
    const entry2 = JSON.parse(plan2.text).models[0];
    assert.equal(entry2.default_reasoning_level, 'medium',
      '模板的默认档（ultra）不在桥的实测表里 → 必须换成一个表内的档');

    // 桥给空数组 → 照实声明空表，且不留默认档
    writeFileSync(join(box.paths.codex, '..', 'models_cache.json'),
      JSON.stringify({ models: [tpl] }, null, 2));
    const plan3 = planModelCatalog(findClient('codex'), {
      models: [{ id: 'claude-opus-4.8', name: 'Claude Opus 4.8', context: 200000, maxOutput: 32000, efforts: [], onlyReasoning: false }],
    });
    const entry3 = JSON.parse(plan3.text).models[0];
    assert.deepEqual(entry3.supported_reasoning_levels, [],
      '实测一档都不收 → 照实声明空表（选择器里就没有可选项）');
    assert.equal(entry3.default_reasoning_level, undefined, '空表时不该留默认档');

    // 桥没给这个字段（旧版桥 / 缓存兜底）→ 继承模板，不猜
    writeFileSync(join(box.paths.codex, '..', 'models_cache.json'),
      JSON.stringify({ models: [tpl] }, null, 2));
    const plan4 = planModelCatalog(findClient('codex'), {
      models: [{ id: 'x', name: 'X', context: 1000, maxOutput: 1000 }],
    });
    const entry4 = JSON.parse(plan4.text).models[0];
    assert.deepEqual(entry4.supported_reasoning_levels.map((l) => l.effort),
      ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      '桥没报档位时继承模板原值（不猜、不删）');
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

/*
 * 稳态：目录里已经一字不差地列着勾选的这批 → **不许报"有改动"**。
 *
 * 现场（用户实际遇到的那次）：面板一直挂着「已接入，需重新写入」，用户勾了 5 个、
 * 面板显示 5 个，客户端里却始终只有 4 个。而那行提示**平时也一直亮着** ——
 * 于是"这次真的少写了一个"和"例行刷新"看起来一模一样，无从分辨。
 *
 * 判据必须是**内容**（重算结果与现有条目一字不差就不算改动），而不是
 * "这条是我们写的"。原先按后者算，每次打开面板都会把 90 多 KB 的目录重写一遍，
 * 还顺手把「需重新写入」变成了一句没有信息量的话。
 */
test('Codex：目录与勾选完全一致时不报改动，也不重写文件', () => {
  const box = sandbox({ files: { codex: '' } });
  try {
    const base = baseWith();
    // 给一份模板（否则沙箱里既没有现成目录、也没有 models_cache，压根不会生成目录）
    writeFileSync(join(box.paths.codex, '..', 'models_cache.json'), JSON.stringify({
      models: [{
        slug: 'gpt-5.6-sol', display_name: 'Sol', context_window: 400000,
        model_messages: { instructions_template: 'KEEP' },
      }],
    }, null, 2));
    const ctx = contextForClient(base, 'codex', 'glm-5.3', ['glm-5.3', 'kimi-k3']);
    assert.equal(applyClient('codex', ctx, { backupRoot: box.backupRoot }).ok, true);
    const catPath = join(box.paths.codex, '..', 'workbuddy-model-catalog.json');
    const before = readFileSync(catPath, 'utf8');

    const plan = planClient('codex', ctx, { backupRoot: box.backupRoot });
    assert.equal(plan.changed, false, '一模一样的两份内容不该被报成"需重新写入"');
    assert.deepEqual(plan.changes, [], '配置层面确实没有改动');
    assert.match(plan.catalogSkipped || '', /都已经有/, '并如实说明目录不接管的原因');

    // 再"重新写入"一次：文件必须逐字节不变（否则每次接入都白写 90 多 KB）
    const again = applyClient('codex', ctx, { backupRoot: box.backupRoot });
    assert.equal(again.ok, true);
    assert.equal(again.changed, false, '没有改动就要如实报 changed: false');
    assert.equal(readFileSync(catPath, 'utf8'), before, '目录文件不该被重写');

    // 补上一个漏写的模型 → 这时**必须**报改动，并且真的写进去
    const ctx3 = contextForClient(baseWith(), 'codex', 'glm-5.3', ['glm-5.3', 'kimi-k3', 'deepseek-v4.1-flash']);
    const plan2 = planClient('codex', ctx3, { backupRoot: box.backupRoot });
    assert.equal(plan2.changed, true, '少一个模型时必须提示重新写入');
    assert.deepEqual(plan2.catalog.added, ['deepseek-v4.1-flash']);
    const r3 = applyClient('codex', ctx3, { backupRoot: box.backupRoot });
    assert.equal(r3.ok, true);
    assert.equal(r3.verify.ok, true);
    const slugs = JSON.parse(readFileSync(catPath, 'utf8')).models.map((m) => m.slug);
    assert.deepEqual(slugs, ['glm-5.3', 'kimi-k3', 'deepseek-v4.1-flash']);

    // 写完再算一次：又回到"无需改动"
    assert.equal(planClient('codex', ctx3, { backupRoot: box.backupRoot }).changed, false,
      '写完就该收敛 —— 否则面板会永远停在「需重新写入」');
  } finally { box.cleanup(); }
});

/*
 * 模式切换：走桥 ↔ 客户端自己的模型。
 *
 * 这是「撤销」之外的另一条路，也是用户真正会问的那个问题：
 * "我这两天想用 Codex 自己的模型，回头还想接着用桥" ——
 * 撤销会把记录归档、把我们建的目录文件删掉，再想用桥就得从头接入一遍；
 * 切模式只是换挡，记录与目录都留着。
 */
test('模式切换：native 逐字节还原，bridge 一键切回（沿用记录里那批模型）', () => {
  const box = sandbox({ files: { codex: '' } });
  try {
    const original = [
      '# 我的配置 —— 这行注释必须活下来',
      'model = "gpt-5.1-codex"',
      'model_provider = "custom"',
      '',
      '[model_providers.custom]',
      'name = "my-own"',
      'base_url = "https://example.invalid/v1"',
      '',
    ].join('\n');
    writeFileSync(box.paths.codex, original);
    // 给一份模板（否则沙箱里既没有现成目录、也没有 models_cache，压根不会生成目录）
    writeFileSync(join(box.paths.codex, '..', 'models_cache.json'), JSON.stringify({
      models: [{ slug: 'tpl', display_name: 'T', context_window: 1000, model_messages: { instructions_template: 'KEEP' } }],
    }, null, 2));

    const base = baseWith();
    assert.equal(clientMode(findClient('codex')), 'native', '还没接入 → native');

    const ctx = contextForClient(base, 'codex', 'glm-5.3', ['glm-5.3', 'kimi-k3']);
    assert.equal(applyClient('codex', ctx, { backupRoot: box.backupRoot }).ok, true);
    assert.equal(clientMode(findClient('codex')), 'bridge', '接入之后 → bridge');
    assert.equal(planClient('codex', ctx, { backupRoot: box.backupRoot }).applied, true);

    // 切回原始模型
    const back = switchClientMode('codex', 'native', null, { backupRoot: box.backupRoot });
    assert.equal(back.ok, true);
    assert.equal(back.changed, true);
    assert.equal(readFileSync(box.paths.codex, 'utf8'), original,
      '要还原成接入之前那一份（逐字节相同，连注释与空行都在）');
    assert.equal(clientMode(findClient('codex')), 'native');
    assert.equal(back.verify.ok, true, '写完要读回自检');
    assert.equal(existsSync(join(box.paths.codex, '..', 'workbuddy-model-catalog.json')), true,
      '目录文件要留着（切回桥时复用），不是删掉');
    assert.equal(back.catalog.kept, true);
    // 切回原始模型之后，界面不能再显示「已接入」
    assert.equal(planClient('codex', ctx, { backupRoot: box.backupRoot }).applied, false);

    // 切回桥：沿用记录里那批模型
    const rec = recordedConnect('codex', { backupRoot: box.backupRoot });
    assert.deepEqual(rec.models, ['glm-5.3', 'kimi-k3'], '记录里记着上次接的那批');
    assert.equal(rec.model, 'glm-5.3');
    const again = switchClientMode('codex', 'bridge',
      contextForClient(baseWith(), 'codex', rec.model, rec.models), { backupRoot: box.backupRoot });
    assert.equal(again.ok, true);
    const cfg = readFileSync(box.paths.codex, 'utf8');
    assert.match(cfg, /model_provider = "workbuddy"/);
    assert.match(cfg, /model_catalog_json = "workbuddy-model-catalog\.json"/);
    assert.equal(clientMode(findClient('codex')), 'bridge');

    // 再切回去：仍然逐字节等于最初那份（来回切不累积改动）
    assert.equal(switchClientMode('codex', 'native', null, { backupRoot: box.backupRoot }).ok, true);
    assert.equal(readFileSync(box.paths.codex, 'utf8'), original);
  } finally { box.cleanup(); }
});

test('模式切换：没有记录时如实拒绝，绝不猜', () => {
  const box = sandbox({ files: { codex: 'model = "gpt-5.1-codex"\nmodel_provider = "workbuddy"\n' } });
  try {
    const r = switchClientMode('codex', 'native', null, { backupRoot: box.backupRoot });
    assert.equal(r.ok, false);
    assert.match(r.error, /没有找到本控制台的接入记录/);
    assert.match(readFileSync(box.paths.codex, 'utf8'), /model_provider = "workbuddy"/,
      '拒绝时必须一个字节都不动');
  } finally { box.cleanup(); }
});

/*
 * `model_catalog_json` 的兜底还原 —— 这条是**本机真实记录里踩到的**：
 * 老版本写下的 `restore.topLevel` 里没有这个键（那时它只在"真的要写目录"时才入账），
 * 照那份记录还原，这个键会留在文件里继续指向我们的目录 ——
 * 客户端用回了自己的 provider，模型选择器里却还列着桥的模型。
 */
test('模式切换：老记录缺 model_catalog_json 时也要把它去掉', () => {
  const box = sandbox({ files: { codex: '' } });
  try {
    writeFileSync(box.paths.codex, [
      'model = "glm-5.3"',
      'model_provider = "workbuddy"',
      'model_catalog_json = "workbuddy-model-catalog.json"',
      '',
      '[model_providers.workbuddy]',
      'name = "WorkBuddy (local bridge)"',
      'base_url = "http://127.0.0.1:8790/v1"',
      'wire_api = "responses"',
      'experimental_bearer_token = "tok"',
      '',
    ].join('\n'));
    mkdirSync(join(box.backupRoot, 'codex'), { recursive: true });
    writeFileSync(join(box.backupRoot, 'codex', 'applied.json'), JSON.stringify({
      client: 'codex', path: box.paths.codex, at: '2026-01-01T00:00:00.000Z', backup: null,
      restore: { topLevel: { model: '"gpt-5.1-codex"', model_provider: '"custom"' }, section: null },
      format: 'toml', model: 'glm-5.3', models: ['glm-5.3'], catalog: null,
    }, null, 2));

    const r = switchClientMode('codex', 'native', null, { backupRoot: box.backupRoot });
    assert.equal(r.ok, true);
    const after = readFileSync(box.paths.codex, 'utf8');
    assert.match(after, /model_provider = "custom"/);
    assert.equal(/model_catalog_json/.test(after), false, '指向我们目录的那个键必须去掉');
    assert.equal(/model_providers\.workbuddy/.test(after), false, '我们那个节也要去掉');
    assert.equal(clientMode(findClient('codex')), 'native');
  } finally { box.cleanup(); }
});

/*
 * TOML 值里的控制字符必须被转义 —— 否则能往 config.toml 里**注入任意行**。
 *
 * 审计实测：桥没起时目录为空，`assertModelKnown` 会放行（那是"先写配置再启桥"
 * 的合理顺序），于是 `model` 里带一个换行就能把 `[model_providers.evil]`
 * 连 base_url 一起写进用户的配置。修法是把控制字符转义成 `\uXXXX`
 * （TOML 基本字符串本来就支持，语义不变）。
 */
test('Codex：model 里的换行不能变成"多出来的一行"', () => {
  const box = sandbox({ files: { codex: 'model = "glm-5.2"\n' } });
  try {
    const evil = "x\n[model_providers.evil]\nbase_url = 'http://attacker.example/v1'";
    const plan = planClient('codex', {
      token: 'tok', baseUrlOpenAI: 'http://127.0.0.1:8790/v1', baseUrlAnthropic: 'http://127.0.0.1:8790',
      model: evil, models: [{ id: evil, name: evil, context: 1, maxOutput: 1 }],
    }, { backupRoot: box.backupRoot });
    const lines = plan.preview.split('\n');
    assert.equal(lines.some((l) => l.trim() === '[model_providers.evil]'), false, '不许凭空多出一个节');
    assert.equal(lines.some((l) => l.includes('attacker.example')), true, '值本身还在，只是被转义了');
    const modelLines = lines.filter((l) => l.startsWith('model = '));
    assert.equal(modelLines.length, 1, '仍然只有一个 model 键');
    assert.match(modelLines[0], /\\u000a/, '换行转义成 \\u000a');
  } finally { box.cleanup(); }
});

/*
 * 跨进程互斥（审计 R6）。
 *
 * 接入是「读 → 算 → 备份 → 写 → 记」这一串，两个入口同时做同一个客户端会交叉：
 * 备份互相覆盖、记录里"保留首次 restore"的逻辑可能丢掉最早那份原值，
 * 于是「撤销」还原到一个中间态。锁用**锁文件**而不是进程内变量 ——
 * 真正会撞的是控制台进程与命令行进程。
 */
test('并发保护：另一个接入操作在进行时挡下第二个，陈旧锁不该把用户锁在门外', () => {
  const box = sandbox({ files: { codex: 'model = "glm-5.2"\n' } });
  try {
    const ctx = contextForClient(baseWith(), 'codex', 'glm-5.3', ['glm-5.3']);
    const lock = join(box.backupRoot, 'codex', '.lock');
    mkdirSync(join(box.backupRoot, 'codex'), { recursive: true });
    writeFileSync(lock, '99999 2026-01-01T00:00:00.000Z\n');   // 模拟"另一个进程正在写"

    const blocked = applyClient('codex', ctx, { backupRoot: box.backupRoot });
    assert.equal(blocked.ok, false);
    assert.match(blocked.error, /正在进行/);
    assert.equal(readFileSync(box.paths.codex, 'utf8'), 'model = "glm-5.2"\n', '被挡下时一个字节都不许动');

    // 进程被强杀会留下陈旧锁：必须能夺过来，否则用户永远接不上了
    const old = new Date(Date.now() - 120000);
    utimesSync(lock, old, old);
    assert.equal(applyClient('codex', ctx, { backupRoot: box.backupRoot }).ok, true, '陈旧锁不该锁死用户');
    assert.equal(existsSync(lock), false, '做完要释放锁');

    // 切模式与撤销同样受这把锁保护
    writeFileSync(lock, '99999\n');
    assert.equal(switchClientMode('codex', 'native', null, { backupRoot: box.backupRoot }).ok, false);
    assert.equal(undoClient('codex', { backupRoot: box.backupRoot }).ok, false);
  } finally { box.cleanup(); }
});

/*
 * 诊断快照（审计 R7）：客户端**会自己重写配置文件**，万一它开始丢掉不认识的键，
 * 接入就会静默失效 —— 而面板还显示「已接入」。这一项让那种失效在一次自检里就暴露。
 * 关键是**区分两种文件里没有桥了**：被动过（drifted）vs 用户主动切回原始模型。
 */
test('诊断快照：客户端把我们写的键弄丢了要能看出来，主动切回不算故障', () => {
  const box = sandbox({ files: { codex: '' } });
  try {
    writeFileSync(box.paths.codex, 'model = "gpt-5.1-codex"\n');
    writeFileSync(join(box.paths.codex, '..', 'models_cache.json'), JSON.stringify({
      models: [{ slug: 'tpl', display_name: 'T', context_window: 1000, model_messages: { instructions_template: 'KEEP' } }],
    }, null, 2));
    const ctx = contextForClient(baseWith(), 'codex', 'glm-5.3', ['glm-5.3']);
    assert.equal(applyClient('codex', ctx, { backupRoot: box.backupRoot }).ok, true);

    const okSnap = connectSnapshot({ backupRoot: box.backupRoot }).find((c) => c.id === 'codex');
    assert.equal(okSnap.applied, true);
    assert.equal(okSnap.drifted, false);

    // 模拟客户端重写配置时把我们的键丢掉了
    writeFileSync(box.paths.codex, 'model = "gpt-5.1-codex"\n');
    const bad = connectSnapshot({ backupRoot: box.backupRoot }).find((c) => c.id === 'codex');
    assert.equal(bad.drifted, true, '记录说桥模式、文件里却不是 → 必须报 drifted');
    assert.equal(bad.applied, false);

    // 主动切回原始模型：记录里的 mode 已经是 native → 不算故障
    assert.equal(switchClientMode('codex', 'native', null, { backupRoot: box.backupRoot }).ok, true);
    const byChoice = connectSnapshot({ backupRoot: box.backupRoot }).find((c) => c.id === 'codex');
    assert.equal(byChoice.nativeByChoice, true);
    assert.equal(byChoice.drifted, false, '主动切回原始模型不是配置被动过');
  } finally { box.cleanup(); }
});

/*
 * 桥没起时的模型校验兜底（审计 R5）。
 *
 * 桥没起 → `/v1/models` 拿不到 → "这个模型存不存在"无从校验，`assertModelKnown`
 * 只能放行（"先写配置再启桥"是合理顺序），代价是可能写进一个根本不存在的模型，
 * 而界面还显示"已接入 + 静态自检通过"。
 * 现在用**上次成功抓到的目录**兜底，并标注它已过期 —— 校验过了 ≠ 校验可信。
 */
test('桥没起时用上次抓到的目录兜底校验，并如实标注已过期', async () => {
  const box = sandbox({ files: {} });
  const realFetch = globalThis.fetch;
  const savedBackupEnv = process.env.WORKBUDDY_CONNECT_BACKUP;
  process.env.WORKBUDDY_CONNECT_BACKUP = join(box.dir, 'backups');
  try {
    // 1) 桥"在跑"：抓到目录 → 落缓存
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes('/health')) {
        return new Response(JSON.stringify({ ok: true, models: ['glm-5.3'] }), { status: 200 });
      }
      if (u.includes('/models')) {
        return new Response(JSON.stringify({
          data: [{ id: 'glm-5.3', name: 'GLM-5.3', maxInputTokens: 1000, maxOutputTokens: 100 }],
        }), { status: 200 });
      }
      throw new Error('unexpected url ' + u);
    };
    const up = await buildConnectBase();
    assert.equal(up.catalogStale, false, '桥在跑时不算"用的是上次的目录"');
    assert.equal(up.catalogIds.has('glm-5.3'), true);
    assert.equal(existsSync(catalogCachePath()), true, '抓到目录要落缓存');

    // 2) 桥"挂了"：目录为空 → 用缓存兜底，并标注已过期
    globalThis.fetch = async () => { throw new Error('ECONNREFUSED'); };
    const down = await buildConnectBase();
    assert.equal(down.running, false);
    assert.equal(down.catalogStale, true, '桥没起时必须标注"用的是上次的目录"');
    assert.equal(typeof down.catalogAt, 'string', '并给出这份目录的时间');
    assert.equal(down.catalogIds.has('glm-5.3'), true, '兜底之后仍然拦得住不存在的模型');
    assert.notEqual(assertModelKnown('definitely-not-real', down), null, '不存在的模型要被拦下');
    assert.equal(assertModelKnown('glm-5.3', down), null, '缓存里有的模型照旧放行');
  } finally {
    globalThis.fetch = realFetch;
    if (savedBackupEnv === undefined) delete process.env.WORKBUDDY_CONNECT_BACKUP;
    else process.env.WORKBUDDY_CONNECT_BACKUP = savedBackupEnv;
    box.cleanup();
  }
});

/*
 * Codex 的 profile 通道（**零写入接入**）。
 *
 * `codex -p <name>` 会叠加 `$CODEX_HOME/<name>.config.toml`（依据 `codex --help`），
 * 所以这条路**不碰用户的基础配置** —— 那正是它存在的理由：不需要备份/撤销/权限加固
 * 那一整套，不想要了就不带 `-p` 启动。
 *
 * 这里钉住三件事：基础配置**逐字节不变**、profile 文件里键齐全、
 * 目录文件与基础配置那份**分开**（共用一份的话，撤销其中一个会把另一个正在引用的删掉）。
 */
test('profile 通道：写自己的文件，基础配置逐字节不变', () => {
  const box = sandbox({ files: { codex: '' } });
  try {
    const original = [
      '# 我的配置 —— 这行注释必须活下来',
      'model = "gpt-5.1-codex"',
      'model_provider = "custom"',
      '',
    ].join('\n');
    writeFileSync(box.paths.codex, original);
    writeFileSync(join(box.paths.codex, '..', 'models_cache.json'), JSON.stringify({
      models: [{ slug: 'tpl', display_name: 'T', context_window: 1000, model_messages: { instructions_template: 'KEEP' } }],
    }, null, 2));

    const prof = findClient('codex-profile');
    assert.ok(prof, 'profile 通道要注册进 CONNECT_CLIENTS');
    assert.equal(prof.profileFor, 'codex');
    const profPath = clientPath(prof);
    assert.equal(profPath, join(box.paths.codex, '..', 'workbuddy.config.toml'), 'profile 与基础配置同目录');

    // 先把基础配置也接上：用来证明两份**目录文件互不干扰**
    assert.equal(applyClient('codex', contextForClient(baseWith(), 'codex', 'glm-5.3', ['glm-5.3']),
      { backupRoot: box.backupRoot }).ok, true);
    const baseCatalog = join(box.paths.codex, '..', 'workbuddy-model-catalog.json');
    assert.equal(existsSync(baseCatalog), true);
    // 基准取"基础配置接入之后"那一份 —— 接下来它**一个字节都不该再动**
    const baseAfterApply = readFileSync(box.paths.codex, 'utf8');
    assert.notEqual(baseAfterApply, original, '基础配置接入之后确实变了（这条断言才有意义）');

    // 写 profile
    const pctx = contextForClient(baseWith(), 'codex-profile', 'glm-5.3', ['glm-5.3', 'kimi-k3']);
    const r = applyClient('codex-profile', pctx, { backupRoot: box.backupRoot });
    assert.equal(r.ok, true);
    assert.equal(readFileSync(box.paths.codex, 'utf8'), baseAfterApply, '基础配置必须逐字节不变');
    const profText = readFileSync(profPath, 'utf8');
    assert.match(profText, /model_provider = "workbuddy"/);
    assert.match(profText, /model_catalog_json = "workbuddy-profile-catalog\.json"/, '用独立的目录文件');
    assert.equal(existsSync(join(box.paths.codex, '..', 'workbuddy-profile-catalog.json')), true);
    assert.equal(existsSync(baseCatalog), true, '基础配置那份目录不受影响');

    // 撤销 profile：只删它自己的文件，基础配置与它的目录都留着
    const u = undoClient('codex-profile', { backupRoot: box.backupRoot });
    assert.equal(u.ok, true);
    assert.equal(existsSync(profPath), false, 'profile 文件要删掉（原本不存在）');
    assert.equal(existsSync(join(box.paths.codex, '..', 'workbuddy-profile-catalog.json')), false);
    assert.equal(existsSync(baseCatalog), true, '基础配置那份目录不能被连带删掉');
    assert.equal(readFileSync(box.paths.codex, 'utf8'), baseAfterApply, '基础配置仍然逐字节不变');
  } finally { box.cleanup(); }
});

/*
 * opencode 的配置文件名：**两种官方都认**，不能只认 `.json`。
 *
 * 现场（本机真实环境）：用户的配置叫 `opencode.jsonc`、里面已经有 workbuddy 的
 * provider 块，而面板显示「已安装，尚未接入」—— 因为路径写死成 `.json`。
 * 更糟的是点「写入」会在旁边多造一个 `opencode.json`，按文档优先级它会**盖住**
 * 用户那个 `.jsonc`（用户自己写在里面的设置就不再生效了）。
 */
test('opencode：配置叫 opencode.jsonc 时也要认（两种文件名官方都支持）', () => {
  const box = sandbox({ files: {} });
  /*
   * 必须显式清掉路径覆盖：`clientPath` 的优先级是「env 覆盖 > 默认路径」，
   * 而沙箱（以及真实用户的 `.env`）都可能设着 `WORKBUDDY_OPENCODE_CONFIG` ——
   * 留着它，这条用例测的就成了覆盖逻辑，而不是"挑哪个文件名"。
   */
  const savedOverride = process.env.WORKBUDDY_OPENCODE_CONFIG;
  delete process.env.WORKBUDDY_OPENCODE_CONFIG;
  try {
    const client = findClient('opencode');
    const dir = join(box.home, '.config', 'opencode');

    assert.equal(clientPath(client), join(dir, 'opencode.json'), '两个都不存在时默认 .json');

    writeFileSync(join(dir, 'opencode.jsonc'), '{\n  "provider": {}\n}\n');
    assert.equal(clientPath(client), join(dir, 'opencode.jsonc'), '.jsonc 存在就用它');

    writeFileSync(join(dir, 'opencode.json'), '{}\n');
    assert.equal(clientPath(client), join(dir, 'opencode.json'), '两个都在时用 .json（优先级更高的那个）');

    // 写到 .jsonc 上时，读回也必须是同一个文件（否则"已接入"永远判不出来）
    rmSync(join(dir, 'opencode.json'));
    const base = { ...fakeBase(), models: MULTI, catalogById: new Map(MULTI.map((m) => [m.id, m])), catalogIds: new Set(MULTI.map((m) => m.id)) };
    const ctx = contextForClient(base, 'opencode', 'glm-5.3', ['glm-5.3']);
    assert.equal(applyClient('opencode', ctx, { backupRoot: box.backupRoot }).ok, true);
    assert.match(readFileSync(join(dir, 'opencode.jsonc'), 'utf8'), /"workbuddy"/, '要写进用户那个 .jsonc');
    assert.equal(existsSync(join(dir, 'opencode.json')), false, '不该在旁边多造一个 .json');
    assert.deepEqual(currentModelsFor(client, base), ['glm-5.3'], '读回也认这个文件（否则永远显示未接入）');
  } finally {
    if (savedOverride !== undefined) process.env.WORKBUDDY_OPENCODE_CONFIG = savedOverride;
    box.cleanup();
  }
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

// ── Claude Code：冷目录 / 多模型窗口 / 旧记录升级（1.20.0）──────────────

/** 桥没起 / 目录冷启动：catalogById 为空，但 `models` 里有一条 128000 的兜底占位。 */
const coldBase = () => ({
  token: 't',
  baseUrlOpenAI: 'o',
  baseUrlAnthropic: 'a',
  models: [{ id: 'deepseek-v4.1-flash', name: 'D', context: 128000, maxOutput: 8192 }],
  catalogById: new Map(),
  catalogIds: new Set(),
  defaultModel: 'deepseek-v4.1-flash',
  responsesModel: 'glm-5.3',
  anthropicModel: 'glm-5.3',
  anthropicFastModel: 'glm-5.3-flash',
  running: false,
});

test('Claude Code：冷目录不写假窗口（兜底占位不是模型上限）', () => {
  const box = sandbox({ files: { claude: '{}' } });
  try {
    const c = contextForClient(coldBase(), 'claude', 'deepseek-v4.1-flash', ['deepseek-v4.1-flash']);
    assert.equal(c.contextWindow, 0, '目录里没有这个模型 → 窗口未知');
    applyClient('claude', c, { backupRoot: box.backupRoot });
    const cfg = JSON.parse(readFileSync(box.paths.claude, 'utf8'));
    assert.equal(cfg.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, undefined,
      '窗口未知时不能把 128000 兜底当事实写进配置');
    assert.equal(cfg.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'glm-5.3-flash', '后台任务模型照常写');
  } finally { box.cleanup(); }
});

test('Claude Code：多模型窗口取所选模型的**最小**已知上限；任一未知则不写', () => {
  const models = [
    { id: 'big', name: 'Big', context: 1000000, maxOutput: 10000 },
    { id: 'small', name: 'Small', context: 200000, maxOutput: 10000 },
  ];
  const base = {
    ...fakeBase(),
    models,
    catalogById: new Map(models.map((m) => [m.id, { ...m, contextMax: m.context }])),
    catalogIds: new Set(models.map((m) => m.id)),
  };
  const both = contextForClient(base, 'claude', 'big', ['big', 'small']);
  assert.equal(both.contextWindow, 200000, '全局单值必须取最小，否则切到 small 会爆上下文');

  const withUnknown = {
    ...base,
    models: [...models, { id: 'unknown', name: 'Unknown', context: 128000, maxOutput: 8192 }],
  };
  const mixed = contextForClient(withUnknown, 'claude', 'big', ['big', 'unknown']);
  assert.equal(mixed.contextWindow, 0, '任一模型上限未知时不能猜一个值');

  const box = sandbox({ files: { claude: '{}' } });
  try {
    applyClient('claude', mixed, { backupRoot: box.backupRoot });
    const cfg = JSON.parse(readFileSync(box.paths.claude, 'utf8'));
    assert.equal(cfg.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, undefined);
  } finally { box.cleanup(); }
});

test('Claude Code：旧记录缺新键时重新接入会补记录，撤销后文件逐字节还原', () => {
  const original = '{}\n';
  const box = sandbox({ files: { claude: original } });
  try {
    const c = contextForClient({ ...baseWith(), anthropicFastModel: 'glm-5.3-flash' }, 'claude', 'glm-5.3', ['glm-5.3']);
    const first = applyClient('claude', c, { backupRoot: box.backupRoot });
    assert.equal(first.ok, true, first.error);
    assert.equal(first.changed, true);

    // 模拟旧版本写下的 manifest：只有最早那三个键，新键（窗口 / haiku / picker）没记
    const manifestFile = join(box.backupRoot, 'claude', 'applied.json');
    const oldManifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
    oldManifest.restore = {
      jsonPaths: {
        'env.ANTHROPIC_BASE_URL': null,
        'env.ANTHROPIC_API_KEY': null,
        'env.ANTHROPIC_MODEL': null,
      },
      created: ['env'],
    };
    writeFileSync(manifestFile, JSON.stringify(oldManifest, null, 2) + '\n', 'utf8');

    // 再接入一次：文件已经是目标状态（无改动），但记录要补齐
    const second = applyClient('claude', c, { backupRoot: box.backupRoot });
    assert.equal(second.ok, true, second.error);
    assert.equal(second.changed, false, '文件已经对了，不该报改动');
    const merged = JSON.parse(readFileSync(manifestFile, 'utf8'));
    for (const key of [
      'env.ANTHROPIC_BASE_URL', 'env.ANTHROPIC_API_KEY', 'env.ANTHROPIC_MODEL',
      'env.CLAUDE_CODE_MAX_CONTEXT_TOKENS', 'env.ANTHROPIC_DEFAULT_HAIKU_MODEL', 'modelPicker',
    ]) {
      assert.ok(key in merged.restore.jsonPaths, `restore 缺 ${key} —— 撤销会把旧版本写的值留下`);
    }
    assert.equal(merged.restore.jsonPaths['env.CLAUDE_CODE_MAX_CONTEXT_TOKENS'], null,
      '当前值正好是我们要写的值 → 那是旧版本写的，撤销应删除');

    const undone = undoClient('claude', { backupRoot: box.backupRoot });
    assert.equal(undone.ok, true, undone.error);
    assert.equal(readFileSync(box.paths.claude, 'utf8'), original,
      '撤销必须回到最初的 {}，不能留下 env.CLAUDE_CODE_MAX_CONTEXT_TOKENS / modelPicker');
  } finally { box.cleanup(); }
});

test('Claude Code：同名键是用户自己设的（值与我们不同）→ 撤销要还原用户的值', () => {
  const box = sandbox({
    files: { claude: '{\n  "env": {\n    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "user-haiku"\n  }\n}\n' },
  });
  try {
    const c = contextForClient({ ...baseWith(), anthropicFastModel: 'glm-5.3-flash' }, 'claude', 'glm-5.3', ['glm-5.3']);
    applyClient('claude', c, { backupRoot: box.backupRoot });
    const manifestFile = join(box.backupRoot, 'claude', 'applied.json');
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
    assert.equal(manifest.restore.jsonPaths['env.ANTHROPIC_DEFAULT_HAIKU_MODEL'], 'user-haiku',
      '当前值与我们要写的不一样 → 那是用户的值，撤销必须还回去');
    undoClient('claude', { backupRoot: box.backupRoot });
    const cfg = JSON.parse(readFileSync(box.paths.claude, 'utf8'));
    assert.equal(cfg.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'user-haiku');
  } finally { box.cleanup(); }
});

test('Claude Code：从 2 个模型缩到 1 个，modelPicker 跟着缩（不能粘住旧列表）', () => {
  const box = sandbox({ files: { claude: '{}' } });
  try {
    const two = contextForClient(baseWith(), 'claude', 'glm-5.3', ['glm-5.3', 'kimi-k3']);
    applyClient('claude', two, { backupRoot: box.backupRoot });
    let cfg = JSON.parse(readFileSync(box.paths.claude, 'utf8'));
    assert.equal(cfg.modelPicker.options.length, 2);

    const one = contextForClient(baseWith(), 'claude', 'glm-5.3', ['glm-5.3']);
    applyClient('claude', one, { backupRoot: box.backupRoot });
    cfg = JSON.parse(readFileSync(box.paths.claude, 'utf8'));
    assert.deepEqual(cfg.modelPicker.options.map((o) => o.model), ['glm-5.3']);
  } finally { box.cleanup(); }
});

test('验证接入：Anthropic 路径发送**配置里的真实模型**（不能硬编码别名）', async () => {
  const { createServer } = await import('node:http');
  const seen = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ data: [] }));
      }
      if (req.url === '/v1/messages/count_tokens') {
        seen.push(JSON.parse(body || '{}'));
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ input_tokens: 3 }));
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const box = sandbox({ files: { claude: '{}' } });
  try {
    const r = await verifyAgainstBridge(findClient('claude'), {
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
      tokenOverride: 'tok',
      model: 'glm-5.3',
    });
    assert.equal(r.ok, true, r.reason);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].model, 'glm-5.3', '必须发配置里的模型，否则未知模型永远验不出来');
  } finally {
    box.cleanup();
    await new Promise((r) => server.close(r));
  }
});
