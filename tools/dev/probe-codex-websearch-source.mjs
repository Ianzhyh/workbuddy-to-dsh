/**
 * 实验：`web_search` 这个工具到底由什么控制？
 *
 * 已知：
 *   - 目录里 `supports_search_tool: false` 已生效（实测），但 Codex **仍然**发 web_search；
 *   - `config.toml` 里没有 `[tools]` 段；
 *   - 二进制里存在 `ToolsToml { web_search, experimental_request_user_input, update_plan }`
 *     与 `web_search_mode`。
 *
 * 本脚本用**临时 CODEX_HOME**（不碰用户的 ~/.codex）跑真 codex.exe + 桩上游，
 * 逐组对照，看哪个开关能真的把 web_search 拿掉：
 *
 *   A 基线（只有目录）
 *   B `[tools] web_search = false`
 *   C 目录里 supports_search_tool=false（已经是当前状态）
 *   D 两者都上
 *
 * 用法: node tools/dev/probe-codex-websearch-source.mjs
 */
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const BRIDGE = join(REPO, 'bridge', 'workbuddy-bridge.mjs');
const SOURCE_CATALOG = process.env.CODEX_CATALOG
  || join(process.env.USERPROFILE || '', '.codex', 'workbuddy-model-catalog.json');

function findCodex() {
  const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['codex'], { stdio: ['ignore', 'pipe', 'ignore'] });
  const fromPath = String(which.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
  if (fromPath && existsSync(fromPath)) return fromPath;
  const binRoot = join(process.env.LOCALAPPDATA || '', 'OpenAI', 'Codex', 'bin');
  if (!existsSync(binRoot)) return null;
  for (const v of readdirSync(binRoot)) {
    const exe = join(binRoot, v, 'codex.exe');
    if (existsSync(exe)) return exe;
  }
  return null;
}

const codexExe = findCodex();
if (!codexExe) { console.log('SKIP: 本机找不到 codex.exe'); process.exit(0); }
if (!existsSync(SOURCE_CATALOG)) { console.log(`SKIP: 找不到目录模板 ${SOURCE_CATALOG}`); process.exit(0); }

const work = mkdtempSync(join(tmpdir(), 'wb-ws-src-'));
const bridgePort = 26000 + Math.floor(Math.random() * 8000);
const upstreamPort = bridgePort + 1;
const token = 'ws-probe-token';

/** 桩上游：只关心 `tools[]` 里有没有 web_search。 */
let lastTools = null;
let requestCount = 0;
const sse = (o) => `data: ${JSON.stringify(o)}\n\n`;
const upstream = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    let body = null; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* ignore */ }
    if (req.url.startsWith('/v2/chat/completions') && body) {
      lastTools = body.tools || [];
      requestCount += 1;
      if (process.env.PROBE_VERBOSE) {
        console.log(`    [上游] #${requestCount} model=${body.model} tools=${(body.tools || []).length} `
          + `names=[${(body.tools || []).map((t) => t.function?.name || t.type).join(',')}]`);
      }
    }
    if (req.url.startsWith('/v2/chat/completions')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(sse({ id: 'c1', model: 'm', choices: [{ index: 0, delta: { content: 'ok' } }] }));
      res.write(sse({ id: 'c1', model: 'm', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } }));
      res.end('data: [DONE]\n\n');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: 0, data: { models: [] } }));
  });
});
await new Promise((r) => upstream.listen(upstreamPort, '127.0.0.1', r));

const authDir = join(work, 'auth');
mkdirSync(authDir, { recursive: true });
const authFile = join(authDir, 'wb.info');
const b64 = (o) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64');
writeFileSync(authFile, JSON.stringify({
  data: b64({ auth: { accessToken: 'a', refreshToken: 'r', domain: 'https://www.workbuddy.ai', expiresAt: Date.now() + 3600_000 } }),
}), 'utf8');

const bridge = spawn(process.execPath, [BRIDGE], {
  env: {
    ...process.env,
    WORKBUDDY_PORT: String(bridgePort),
    WORKBUDDY_HOST: '127.0.0.1',
    WORKBUDDY_LOCAL_TOKEN: token,
    CODEBUDDY_ENDPOINT: `http://127.0.0.1:${upstreamPort}`,
    CODEBUDDY_API_KEY: 'k',
    WORKBUDDY_AUTH_FILE: authFile,
    WORKBUDDY_LOG: '1',
    WORKBUDDY_AUTO_CHECKIN: '0',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
bridge.stdout.on('data', () => {});
bridge.stderr.on('data', () => {});

async function waitBridge() {
  for (let i = 0; i < 100; i += 1) {
    try {
      /*
       * 判据：端口上应答的是**我们这个桥**（认 `authFile` 字段）。
       *
       * 注意两点：
       *   1. 不能要求 200 —— 探针用假登录文件，`/health` 如实回 **503**
       *      （凭据读不出），那是正常状态；
       *   2. 503 时响应体里**没有 `pid`**（只有 ok/error/authFile），
       *      所以身份要认 `authFile` 而不是 `pid` —— 第一版写 `j.pid` 导致
       *      探针永远 FAIL，而桥其实好好地在跑。
       */
      const r = await fetch(`http://127.0.0.1:${bridgePort}/health`, { headers: { Authorization: `Bearer ${token}` } });
      const j = await r.json().catch(() => null);
      if (j && j.authFile === authFile) return true;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

/** 造一份临时 CODEX_HOME（可选改目录的 supports_search_tool、可选加 [tools] 段）。 */
function makeHome(name, { catalogSearch, toolsSection }) {
  const home = join(work, name);
  const proj = join(home, 'proj');
  mkdirSync(proj, { recursive: true });
  const cat = JSON.parse(readFileSync(SOURCE_CATALOG, 'utf8'));
  if (catalogSearch !== undefined) {
    for (const m of cat.models) {
      m.supports_search_tool = catalogSearch;
      if (!catalogSearch) delete m.web_search_tool_type;
    }
  }
  writeFileSync(join(home, 'workbuddy-model-catalog.json'), JSON.stringify(cat, null, 2), 'utf8');
  const lines = [
    'model_provider = "workbuddy"',
    'model = "deepseek-v4.1-flash"',
    'model_catalog_json = "workbuddy-model-catalog.json"',
    'approval_policy = "never"',
    'sandbox_mode = "read-only"',
    '',
    '[model_providers.workbuddy]',
    'name = "WB probe"',
    `base_url = "http://127.0.0.1:${bridgePort}/v1"`,
    'wire_api = "responses"',
    `experimental_bearer_token = "${token}"`,
    '',
  ];
  if (toolsSection) lines.push(toolsSection, '');
  writeFileSync(join(home, 'config.toml'), lines.join('\n'), 'utf8');
  return { home, proj };
}

let exitCode = 0;
try {
  if (!await waitBridge()) { console.log('FAIL: 桥没起来'); cleanup(); process.exit(1); }

  const groups = [
    ['A 基线（目录 true，无 [tools]）', { catalogSearch: true, toolsSection: null }],
    ['B 只加 [tools] web_search=false', { catalogSearch: true, toolsSection: '[tools]\nweb_search = false' }],
    ['C 只改目录 supports_search_tool=false', { catalogSearch: false, toolsSection: null }],
    ['D 两者都上', { catalogSearch: false, toolsSection: '[tools]\nweb_search = false' }],
  ];

  console.log(`codex: ${codexExe}`);
  console.log('（每组跑一次真 codex exec，看桥转发出去的 tools[] 里有没有 web_search）\n');

  for (const [label, opts] of groups) {
    const { home, proj } = makeHome(label.slice(0, 1), opts);
    lastTools = null;
    requestCount = 0;
    const run = spawnSync(codexExe, ['exec', '--skip-git-repo-check', '-C', proj, 'Say OK'], {
      env: { ...process.env, CODEX_HOME: home },
      encoding: 'utf8',
      timeout: 120_000,
    });
    const names = (lastTools || []).map((t) => t.function?.name || t.type).filter(Boolean);
    const has = names.includes('web_search');
    console.log(`${label}`);
    console.log(`   桥收到 ${requestCount} 次上游请求；转发的工具数=${names.length}  含 web_search=${has ? '是' : '否'}`);
    if (!requestCount) {
      const err = String(run.stderr || '').split('\n').filter((l) => l.trim()).slice(-6).join(' | ');
      console.log(`   （桥一次请求都没收到；codex 输出尾：${err.slice(0, 400)}）`);
    }
    console.log('');
  }
} finally {
  cleanup();
}
function cleanup() {
  try { bridge.kill(); } catch { /* ignore */ }
  try { upstream.close(); } catch { /* ignore */ }
  try { rmSync(work, { recursive: true, force: true }); } catch { /* Windows EPERM */ }
}
process.exit(exitCode);
