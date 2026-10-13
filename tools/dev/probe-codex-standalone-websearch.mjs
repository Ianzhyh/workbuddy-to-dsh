import { readFileSync } from 'node:fs';
/**
 * 探针：`supports_standalone_web_search`（**provider 级**字段）是不是 web_search 的真正开关？
 *
 * 背景：目录级 `supports_search_tool` 已证明无效（A/B 对照两次都发）。
 * 二进制里 provider 配置字段清单含 `supports_standalone_web_search`：
 *
 *   base_url model_catalog_url env_key env_key_instructions experimental_bearer_token
 *   gateway_oauth aws wire_api capabilities query_params request_max_retries
 *   stream_max_retries stream_idle_timeout_ms websocket_connect_timeout_ms
 *   requires_openai_auth supports_websockets supports_standalone_web_search …
 *
 * 本探针用临时 CODEX_HOME 跑真 codex.exe，对照组：加 / 不加这一行。
 *
 * 用法: node tools/dev/probe-codex-standalone-websearch.mjs
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function findCodex() {
  const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['codex'], { stdio: ['ignore', 'pipe', 'ignore'] });
  const p = String(which.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
  if (p && existsSync(p)) return p;
  const binRoot = join(process.env.LOCALAPPDATA || '', 'OpenAI', 'Codex', 'bin');
  if (!existsSync(binRoot)) return null;
  for (const v of readdirSync(binRoot)) {
    const exe = join(binRoot, v, 'codex.exe');
    if (existsSync(exe)) return exe;
  }
  return null;
}

const exe = findCodex();
if (!exe) { console.log('SKIP: 本机找不到 codex.exe'); process.exit(0); }

const catalog = join(process.env.USERPROFILE || '', '.codex', 'workbuddy-model-catalog.json');
if (!existsSync(catalog)) { console.log(`SKIP: 找不到目录模板 ${catalog}`); process.exit(0); }

/**
 * 本地桥令牌：**从 .bridge-token 读，不写进代码**。
 * 换令牌时设 WB_TOKEN 覆盖即可。
 */
function readBridgeToken() {
  const p = new URL('../../dsh-plugin/.bridge-token', import.meta.url);
  try {
    return readFileSync(p, 'utf8').trim();
  } catch {
    throw new Error('WB_TOKEN 未设置，且读不到 dsh-plugin/.bridge-token。'
      + '先启动桥（首次运行会生成它），或显式设 WB_TOKEN=...');
  }
}

const TOKEN = process.env.WB_TOKEN || readBridgeToken();
const BRIDGE = process.env.WB_BRIDGE || 'http://127.0.0.1:8790/v1';

function run(label, extraProviderLines) {
  const work = mkdtempSync(join(tmpdir(), 'wb-sws-'));
  const home = join(work, 'home');
  mkdirSync(home, { recursive: true });
  copyFileSync(catalog, join(home, 'workbuddy-model-catalog.json'));
  const lines = [
    'model_provider = "workbuddy"',
    'model = "deepseek-v4.1-flash"',
    'model_catalog_json = "workbuddy-model-catalog.json"',
    '',
    '[model_providers.workbuddy]',
    'name = "WB probe"',
    `base_url = "${BRIDGE}"`,
    'wire_api = "responses"',
    `experimental_bearer_token = "${TOKEN}"`,
    ...extraProviderLines,
    '',
  ];
  writeFileSync(join(home, 'config.toml'), lines.join('\n'), 'utf8');
  const r = spawnSync(exe, ['exec', '--skip-git-repo-check', '-C', work, 'Say OK'], {
    env: { ...process.env, CODEX_HOME: home },
    encoding: 'utf8',
    timeout: 120_000,
  });
  const err = String(r.stderr || '');
  // 若该字段不合法，codex 会报 unknown field / 解析错误 —— 这本身就是有价值的证据
  const parseErr = /unknown field|invalid type|expected|failed to parse/i.test(err);
  console.log(`${label}: exit=${r.status}${parseErr ? '  ⚠️ 配置被拒（见下）' : ''}`);
  if (parseErr) {
    console.log('   ' + err.split('\n').filter((l) => /unknown field|invalid|expected|parse/i.test(l)).slice(0, 2).join(' | '));
  }
  return r.status;
}

console.log(`codex: ${exe}`);
console.log('（看桥日志的 dropped= 有没有变化 —— 这是判据）\n');
run('A 基线（不加该字段）', []);
run('B supports_standalone_web_search = false', ['supports_standalone_web_search = false']);
console.log('');
console.log('判据：B 之后桥日志若**不再**出现 dropped=web_search → 这个字段就是开关。');
