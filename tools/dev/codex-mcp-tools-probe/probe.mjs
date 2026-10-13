#!/usr/bin/env node
/**
 * 决定性测量实验：MCP server 的工具在 codex.exe 发往 provider 的 `tools[]` 里是什么形状。
 *
 *   node tools/dev/codex-mcp-tools-probe/probe.mjs          # 跑全部场景
 *   ONLY=C1,L2 node tools/dev/codex-mcp-tools-probe/probe.mjs  # 只跑指定场景
 *   node tools/dev/codex-mcp-tools-probe/analyze.mjs        # 汇总矩阵
 *
 * 方法与 tools/dev/probe-codex-custom-tool.mjs 同源：
 *   临时 CODEX_HOME（E 盘）→ config.toml 里 wire_api="responses" 指向本地桩 HTTP
 *   → 跑真 codex.exe exec --ephemeral → 桩把**完整请求体**落盘。
 *
 * 与旧探针的差别（这次的变量）：
 *   · CODEX_HOME 里**真的**声明 [mcp_servers.*]，指向自写的最小 MCP server；
 *   · 一组实验矩阵：stdio vs streamable-HTTP 传输、有无 [windows] sandbox、
 *     有无第二个 MCP server、有无 bypass flag、tool_search 的 wire 形态。
 *
 * 结论（详见 .workbuddy/artifacts/capture-codex-mcp-tools.md）：
 *   · 本机 `codex exec` 起 stdio MCP server 一律失败（ERROR_PIPE_BUSY / os error 231），
 *     连真 node_repl.exe 也一样 ⇒ 必须用 url（streamable HTTP）才测得下去；
 *   · 即使 MCP server 起成功，它的工具也**不进 `tools[]` 顶层**，而是被 `tool_search`
 *     延迟；模型调 tool_search 后以 `{type:"namespace",name:"mcp__<server>",tools:[…短名 function…]}`
 *     的形式出现在 `input` 的 `tool_search_output` 项里。
 *
 * ⚠️ 不碰用户的 ~/.codex（只读它的 model catalog 作模板）；临时文件全在临时目录。
 * ⚠️ 需要本机有 codex.exe / node.exe。**路径不写死**：优先读环境变量，
 *    否则从本机已装位置自动探测（见下方 resolve*）。换机器不必改代码。
 */
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';

/**
 * 定位一个可执行文件：环境变量优先 → 候选列表里第一个存在的 → 抛错。
 *
 * 为什么不写死路径：写死等于把**开发者的机器布局**（含用户名）带进仓库 ——
 * 既泄露个人信息，换台机器又直接跑不起来。这里一律用环境变量或家目录推导。
 *
 * @param {string} envName 环境变量名
 * @param {string[]} candidates 候选绝对路径
 * @param {string} label 报错时用的名字
 */
function resolveExe(envName, candidates, label) {
  const fromEnv = process.env[envName];
  if (fromEnv) return fromEnv;
  for (const c of candidates) if (c && existsSync(c)) return c;
  throw new Error(
    `找不到 ${label}。设 ${envName} 指向它，或把它放到常见位置。`
    + `\n候选：${candidates.filter(Boolean).join(' / ') || '(无)'}`,
  );
}

/**
 * 在 `base` 下**限深**递归找一个文件。
 *
 * codex 的目录布局是「基目录 → 一层版本哈希 → 可能还有一层 → 文件」
 * （实测两种形状：
 *   `Codex\bin\2e5e00daee91c61d\codex.exe`
 *   `Codex\runtimes\cua_node\cfb32733c877621e\bin\node_repl.exe`）
 * 哈希名不可预知，所以按限深递归找，而不是把某一层的形状写死。
 *
 * @param {string} base 基目录（可能不存在）
 * @param {string} file 文件名（不含路径）
 * @param {number} [maxDepth] 最大递归层数
 * @returns {string|null}
 */
function findFileUnder(base, file, maxDepth = 4) {
  if (!base || !existsSync(base)) return null;
  const seen = [];
  const walk = (dir, depth) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return null; }
    // 先看本层的文件（同层目录一起收着，下一轮再下探）
    for (const e of entries) {
      if (!e.isDirectory() && e.name === file) return join(dir, e.name);
    }
    if (depth >= maxDepth) return null;
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const found = walk(join(dir, e.name), depth + 1);
      if (found) return found;
    }
    return null;
  };
  return walk(base, 0);
}

/** codex 的安装根：`%LOCALAPPDATA%\OpenAI\Codex`（Windows）。 */
const CODEX_HOME_DIR = join(
  process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'),
  'OpenAI',
  'Codex',
);

const CODEX = resolveExe('CODEX_EXE', [
  findFileUnder(join(CODEX_HOME_DIR, 'bin'), 'codex.exe'),
  findFileUnder(CODEX_HOME_DIR, 'codex.exe'),
], 'codex.exe');
const NODE = process.env.PROBE_NODE || process.execPath; // 默认就用跑本脚本的这个 node
// 临时目录走系统 tmpdir：不假设盘符（原实现写死 E 盘，只是作者本机的习惯）
const ROOT = process.env.PROBE_ROOT || join(tmpdir(), 'codex-mcp-probe');
const CATALOG = process.env.PROBE_CATALOG
  || join(homedir(), '.codex', 'workbuddy-model-catalog.json');
const SERVER = join(ROOT, 'demo-mcp-server.mjs');
const PATHLIKE = join(ROOT, 'pathlike-mcp-server.mjs');
const HTTP_MCP = join(ROOT, 'http-mcp-server.mjs');
const TARGET = join(ROOT, 'captures');
const MODEL = 'deepseek-v4.1-flash';

const SCENARIOS = [
  { id: 'A1', label: 'demo MCP only / 无 [windows] / 无 bypass', servers: ['demo'], windows: false, args: [], rustLog: 'info' },
  { id: 'A2', label: 'demo MCP only / [windows] sandbox=elevated / 无 bypass', servers: ['demo'], windows: true, args: [], rustLog: 'info' },
  { id: 'A3', label: 'demo + pathlike 路径型 MCP / [windows] elevated / 无 bypass', servers: ['demo', 'pathlike'], windows: true, args: [], rustLog: 'info' },
  { id: 'A4', label: 'demo + pathlike / [windows] elevated / --dangerously-bypass-approvals-and-sandbox', servers: ['demo', 'pathlike'], windows: true, args: ['--dangerously-bypass-approvals-and-sandbox'], rustLog: 'info' },
  { id: 'A5', label: 'demo MCP only / 无 [windows] / RUST_LOG=debug', servers: ['demo'], windows: false, args: [], rustLog: 'debug' },
  // ---- 定向实验：把 MCP 启动失败（os error 231）修掉 ----
  { id: 'B1', label: 'demo 经 cmd.exe /c 启动 / 无 [windows]', servers: ['demo'], windows: false, args: [], rustLog: 'debug', cmd: 'cmd' },
  { id: 'B2', label: '真 node_repl.exe 作 MCP server / 无 [windows]', servers: ['noderepl'], windows: false, args: [], rustLog: 'debug' },
  { id: 'B3', label: 'demo MCP only / [windows] sandbox=unelevated / trace', servers: ['demo'], windows: 'unelevated', args: [], rustLog: 'trace' },
  { id: 'B4', label: 'demo MCP only / 无 [windows] / RUST_LOG=trace', servers: ['demo'], windows: false, args: [], rustLog: 'trace' },
  // ---- 改走 Streamable HTTP 传输（绕开坏掉的 stdio 管道）----
  { id: 'C1', label: 'HTTP MCP ×1 / 无 [windows]', servers: [], http: true, windows: false, args: [], rustLog: 'debug' },
  { id: 'C2', label: 'HTTP MCP ×1 / [windows] sandbox=elevated', servers: [], http: true, windows: 'elevated', args: [], rustLog: 'debug' },
  { id: 'C3', label: 'HTTP MCP ×2（两个 server）/ 无 [windows]', servers: [], http: 2, windows: false, args: [], rustLog: 'debug' },
  // ---- 让模型先调 tool_search，把被延迟的 MCP 工具暴露出来，再看第二轮 tools[] ----
  { id: 'D1', label: 'HTTP MCP ×1 + 首轮 tool_search("demo")', servers: [], http: true, windows: false, args: [], rustLog: 'debug', searchQuery: 'demo' },
  { id: 'D2', label: 'HTTP MCP ×2 + 首轮 tool_search("demo")', servers: [], http: 2, windows: false, args: [], rustLog: 'debug', searchQuery: 'demo' },
  { id: 'D3', label: 'HTTP MCP ×1 + 首轮 tool_search("multi agent sub-agent spawn")', servers: [], http: true, windows: false, args: [], rustLog: 'debug', searchQuery: 'multi agent sub-agent spawn' },
  // ---- 关掉「MCP 工具延迟下发」，看 MCP 工具是否直接内联进 tools[] ----
  { id: 'E1', label: 'HTTP MCP ×1 + features.tool_search_always_defer_mcp_tools=false', servers: [], http: true, windows: false, args: ['-c', 'features.tool_search_always_defer_mcp_tools=false'], rustLog: 'debug' },
  { id: 'E2', label: 'HTTP MCP ×1 + --disable tool_search', servers: [], http: true, windows: false, args: ['--disable', 'tool_search'], rustLog: 'debug' },
  { id: 'E3', label: 'HTTP MCP ×1 + features.tool_search=false', servers: [], http: true, windows: false, args: ['-c', 'features.tool_search=false'], rustLog: 'debug' },
  { id: 'E4', label: 'HTTP MCP ×2 + defer_mcp_tools=false', servers: [], http: 2, windows: false, args: ['-c', 'features.tool_search_always_defer_mcp_tools=false'], rustLog: 'debug' },
  // ---- 用 codex 自己的 debug 面板观测（不经过模型）----
  { id: 'G1', label: 'HTTP MCP ×1 + codex debug prompt-input', servers: [], http: true, windows: false, args: [], rustLog: 'debug', debugPrompt: 'hi' },
  // ---- 因果对照 ----
  { id: 'F1', label: '完全不配 MCP server（基线）', servers: [], windows: false, args: [], rustLog: 'debug' },
  { id: 'F2', label: 'HTTP MCP ×1 + -c features.tool_search/…defer 覆盖（验证 flag 是否生效）', servers: [], http: true, windows: false, args: ['-c', 'features.tool_search_always_defer_mcp_tools=false', '-c', 'features.tool_search=false'], rustLog: 'debug' },
  // ---- 暴力试探 tool_search 的 wire 形态 ----
  { id: 'H1', label: 'tool_search_call {query}', servers: [], http: true, windows: false, args: [], rustLog: 'debug',
    searchItem: { type: 'tool_search_call', id: 'ts_1', call_id: 'call_ts_1', status: 'completed', query: 'demo' } },
  { id: 'H2', label: 'tool_search_call {queries:[…], execution:client}', servers: [], http: true, windows: false, args: [], rustLog: 'debug',
    searchItem: { type: 'tool_search_call', id: 'ts_1', call_id: 'call_ts_1', status: 'completed', execution: 'client', queries: ['demo'] } },
  { id: 'H3', label: 'function_call + namespace:"functions"', servers: [], http: true, windows: false, args: [], rustLog: 'debug',
    searchItem: { type: 'function_call', id: 'fc_1', call_id: 'call_ts_1', status: 'completed', namespace: 'functions', name: 'tool_search', arguments: JSON.stringify({ query: 'demo' }) } },
  // ---- 诊断：-c features.* 覆盖到底生不生效（用 sleep_tool 当对照） ----
  { id: 'I1', label: 'HTTP MCP ×1 + -c features.sleep_tool=false（对照）', servers: [], http: true, windows: false, args: ['-c', 'features.sleep_tool=false'], rustLog: 'debug' },
  // ---- 试着复现 multi_agent_v1（namespace 形态） ----
  { id: 'J1', label: 'HTTP MCP ×1 + features.multi_agent_v2=true', servers: [], http: true, windows: false, args: ['-c', 'features.multi_agent_v2=true'], rustLog: 'debug' },
  { id: 'J2', label: 'HTTP MCP ×1 + features.multi_agent_mode=true', servers: [], http: true, windows: false, args: ['-c', 'features.multi_agent_mode=true', '-c', 'features.multi_agent_v2=true', '-c', 'features.multi_agent_v2_dynamic_tools=true'], rustLog: 'debug' },
  // ---- 按 generate-json-schema 的权威形状重试 tool_search ----
  { id: 'K1', label: 'tool_search_call {arguments,execution:"client"} 权威形状', servers: [], http: true, windows: false, args: [], rustLog: 'debug',
    searchItem: { type: 'tool_search_call', id: 'ts_1', call_id: 'call_ts_1', status: 'completed', execution: 'client', arguments: { query: 'demo' } } },
  { id: 'K2', label: 'tool_search_call 同上 + arguments 为 JSON 字符串', servers: [], http: true, windows: false, args: [], rustLog: 'debug',
    searchItem: { type: 'tool_search_call', id: 'ts_1', call_id: 'call_ts_1', status: 'completed', execution: 'client', arguments: JSON.stringify({ query: 'demo' }) } },
  ...[
    ['L1', 'demo_echo'],
    ['L2', 'echo shout uppercase text'],
    ['L3', 'mcp tool demo'],
    ['L4', '*'],
  ].map(([id, q]) => ({
    id, label: `tool_search query="${q}"`, servers: [], http: true, windows: false, args: [], rustLog: 'debug',
    searchItem: { type: 'tool_search_call', id: 'ts_1', call_id: 'call_ts_1', status: 'completed', execution: 'client', arguments: { query: q } },
  })),
  // ---- 两轮脚本：tool_search 之后按短名 / 全名调用 MCP 工具 ----
  {
    id: 'M1', label: '两轮脚本：search → function_call name="demo_echo"（短名）', servers: [], http: true, windows: false, args: [], rustLog: 'debug',
    items: [
      { type: 'tool_search_call', id: 'ts_1', call_id: 'call_ts_1', status: 'completed', execution: 'client', arguments: { query: 'echo shout uppercase' } },
      { type: 'function_call', id: 'fc_2', call_id: 'call_mcp_1', status: 'completed', name: 'demo_echo', arguments: '{}' },
    ],
  },
  {
    id: 'M2', label: '两轮脚本：search → function_call name="mcp__httpdemo__demo_echo"（全名）', servers: [], http: true, windows: false, args: [], rustLog: 'debug',
    items: [
      { type: 'tool_search_call', id: 'ts_1', call_id: 'call_ts_1', status: 'completed', execution: 'client', arguments: { query: 'echo shout uppercase' } },
      { type: 'function_call', id: 'fc_2', call_id: 'call_mcp_1', status: 'completed', name: 'mcp__httpdemo__demo_echo', arguments: '{}' },
    ],
  },
  // ---- 双 MCP server：看两个 namespace 并列 ----
  {
    id: 'N1', label: 'HTTP MCP ×2 + tool_search（两个 namespace 并列）', servers: [], http: 2, windows: false, args: [], rustLog: 'debug',
    searchItem: { type: 'tool_search_call', id: 'ts_1', call_id: 'call_ts_1', status: 'completed', execution: 'client', arguments: { query: 'echo shout uppercase' } },
  },
  // ---- 带 [windows] elevated 的 HTTP 版（确认结论与沙箱无关）----
  {
    id: 'N2', label: 'HTTP MCP ×1 + [windows] elevated + tool_search', servers: [], http: true, windows: 'elevated', args: [], rustLog: 'debug',
    searchItem: { type: 'tool_search_call', id: 'ts_1', call_id: 'call_ts_1', status: 'completed', execution: 'client', arguments: { query: 'echo shout uppercase' } },
  },
];
const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null;

if (!existsSync(CODEX)) { console.log(`SKIP: 找不到 ${CODEX}`); process.exit(0); }
if (!existsSync(CATALOG)) { console.log(`SKIP: 找不到 catalog ${CATALOG}`); process.exit(0); }
mkdirSync(TARGET, { recursive: true });

/** 桩上游：Responses API 的 SSE。把完整请求体落盘。 */
function startStub(dir, sc = {}) {
  const reqs = [];
  let n = 0;
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body = null;
      try { body = JSON.parse(raw); } catch { /* ignore */ }
      n += 1;
      reqs.push({ url: req.url, headers: req.headers, body });
      writeFileSync(join(dir, `request-${String(n).padStart(2, '0')}.json`), JSON.stringify(body, null, 2));
      const ev = (type, payload) => `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
      let output;
      const scripted = sc.items?.[n - 1];
      if (scripted) {
        output = [scripted];
      } else if (n === 1 && sc.searchItem) {
        output = [sc.searchItem];
      } else if (n === 1 && sc.searchQuery) {
        // 第一轮：模型"调用" client 侧的 tool_search，让 codex 去暴露被延迟的 MCP 工具
        output = [{
          id: 'fc_probe_1', type: 'function_call', status: 'completed',
          call_id: 'call_probe_search_1', name: 'tool_search',
          arguments: JSON.stringify({ query: sc.searchQuery }),
        }];
      } else {
        output = [{
          id: 'msg_probe_1', type: 'message', status: 'completed', role: 'assistant',
          content: [{ type: 'output_text', text: 'ok', annotations: [] }],
        }];
      }
      const response = {
        id: `resp_probe_${n}`, object: 'response', created_at: Math.floor(Date.now() / 1000),
        status: 'completed', model: MODEL, output,
        usage: {
          input_tokens: 10, input_tokens_details: { cached_tokens: 0 },
          output_tokens: 3, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 13,
        },
      };
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(ev('response.created', { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } }));
      output.forEach((item, i) => {
        res.write(ev('response.output_item.done', { type: 'response.output_item.done', output_index: i, item }));
      });
      res.write(ev('response.completed', { type: 'response.completed', response }));
      res.end();
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, reqs, port: server.address().port })));
}

function toml(sc, port, dir, httpPorts = []) {
  const L = [
    'model_provider = "stub"',
    `model = "${MODEL}"`,
    'model_catalog_json = "workbuddy-model-catalog.json"',
    'approval_policy = "never"',
    'sandbox_mode = "danger-full-access"',
    '',
    '[model_providers.stub]',
    'name = "probe stub"',
    `base_url = "http://127.0.0.1:${port}/v1"`,
    'wire_api = "responses"',
    'experimental_bearer_token = "probe-local-token"',
    '',
  ];
  const mk = (name, script, opts = {}) => {
    L.push(
      `[mcp_servers.${name}]`,
      `command = '${opts.command || NODE}'`,
      `args = [${(opts.args || [script]).map((a) => `'${a}'`).join(', ')}]`,
      'startup_timeout_sec = 30',
      '',
      `[mcp_servers.${name}.env]`,
      `DEMO_MCP_LOG = '${join(dir, `${name}-mcp.log`)}'`,
      `DEMO_MCP_NAME = "${name}"`,
      '',
    );
  };
  /*
   * node_repl.exe 在 codex 的 runtimes 目录下，**哈希目录名不可预知**，
   * 所以按前缀扫一层找。找不到就置 null —— 只有 B2 场景会用到它，
   * 缺了不该让整个探针跑不起来（下面的场景各自判空）。
   */
  const NODE_REPL = process.env.PROBE_NODE_REPL
    || findFileUnder(join(CODEX_HOME_DIR, 'runtimes'), 'node_repl.exe');
  if (sc.servers.includes('demo')) {
    if (sc.cmd === 'cmd') mk('demo', null, { command: 'cmd.exe', args: ['/c', NODE, SERVER] });
    else mk('demo', SERVER);
  }
  if (sc.servers.includes('pathlike')) mk('pathlike', PATHLIKE);
  if (sc.servers.includes('noderepl')) {
    mk('noderepl', null, { command: NODE_REPL, args: [] });
  }
  httpPorts.forEach((p, i) => {
    const n = i === 0 ? 'httpdemo' : `httpdemo${i + 1}`;
    L.push(`[mcp_servers.${n}]`, `url = "http://127.0.0.1:${p}/mcp"`, '');
  });
  if (sc.windows) L.push('[windows]', `sandbox = "${sc.windows}"`, '');
  return L.join('\n');
}

/** 异步跑一个进程。spawnSync 在本机会对 codex.exe 报 EBUSY，必须用异步 spawn。 */
function run(cmd, args, opts) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    const t = setTimeout(() => { try { p.kill(); } catch { /* ignore */ } }, opts.timeout || 150000);
    p.on('error', (e) => { clearTimeout(t); resolve({ code: null, out, err, error: String(e.message) }); });
    p.on('exit', (code, sig) => { clearTimeout(t); resolve({ code, sig, out, err, error: '' }); });
  });
}

/** 自己拉起一个 Streamable-HTTP MCP server（不由 codex spawn），返回它的端口。 */
function startHttpMcp(dir, name) {
  return new Promise((resolve) => {
    const child = spawn(NODE, [HTTP_MCP, '0'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, DEMO_MCP_LOG: join(dir, `${name}-mcp.log`), DEMO_MCP_NAME: name },
    });
    let out = '';
    const onData = (d) => {
      out += d;
      const m = /listening (\d+)/.exec(out);
      if (m) resolve({ child, port: Number(m[1]), name });
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    setTimeout(() => resolve({ child, port: 0, name }), 5000);
  });
}

const results = [];
for (const sc of SCENARIOS) {
  if (ONLY && !ONLY.includes(sc.id)) continue;
  const dir = join(TARGET, sc.id);
  // 本机 WorkBuddy sandbox 的 safe-delete shim 会在单轮累计删除超阈值时抛错，
  // 于是这里不能把清理当致命步骤：删不掉就直接覆盖写。
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略：沿用旧目录、覆盖文件 */ }
  mkdirSync(dir, { recursive: true });
  const home = join(dir, 'codex-home');
  const proj = join(dir, 'proj');
  mkdirSync(home, { recursive: true });
  mkdirSync(proj, { recursive: true });
  copyFileSync(CATALOG, join(home, 'workbuddy-model-catalog.json'));

  const { server, reqs, port } = await startStub(dir, sc);
  const httpServers = [];
  const nHttp = sc.http ? (sc.http === true ? 1 : sc.http) : 0;
  for (let i = 0; i < nHttp; i += 1) {
    httpServers.push(await startHttpMcp(dir, i === 0 ? 'httpdemo' : `httpdemo${i + 1}`));
  }
  writeFileSync(join(home, 'config.toml'), toml(sc, port, dir, httpServers.map((s) => s.port)));

  const env = { ...process.env, CODEX_HOME: home, RUST_LOG: sc.rustLog, NO_COLOR: '1' };
  // 让 demo server 自己也能被直接看到：清掉可能继承的串扰
  delete env.DEMO_MCP_LOG;

  const mcpList = await run(CODEX, ['mcp', 'list', '--json'], { env, timeout: 30000 });

  const args = sc.debugPrompt
    ? ['debug', 'prompt-input', sc.debugPrompt]
    : ['exec', '--skip-git-repo-check', '--ephemeral', '-C', proj, ...sc.args, 'Reply with the single word ok.'];
  const t0 = Date.now();
  const exec = await run(CODEX, args, { env, timeout: 150000 });
  const ms = Date.now() - t0;

  writeFileSync(join(dir, 'codex-exec.stdout.txt'), exec.out);
  if (sc.debugPrompt) writeFileSync(join(dir, 'debug-prompt-input.json'), exec.out);
  writeFileSync(join(dir, 'codex-exec.stderr.txt'), exec.err);
  writeFileSync(join(dir, 'mcp-list.json'), mcpList.out);

  const demoLog = join(dir, 'demo-mcp.log');
  const pathlikeLog = join(dir, 'pathlike-mcp.log');
  const httpLogs = httpServers.map((h) => join(dir, `${h.name}-mcp.log`));
  const first = reqs[0]?.body || null;
  const tools = first?.tools || [];

  const stderrText = exec.err || '';
  const mcpLines = stderrText.split(/\r?\n/)
    .filter((l) => /rmcp|mcp_manager|MCP server|tool_catalog|tool_search|program_resolver/i.test(l))
    .map((l) => l.replace(/^.*?:\s*(?=\S)/, (m) => m).slice(-360));

  results.push({
    id: sc.id, label: sc.label, dir, ms,
    exit: exec.code, execErr: exec.error,
    reqCount: reqs.length,
    perRequest: reqs.map((r, i) => ({
      n: i + 1,
      tools: (r.body?.tools || []).length,
      names: (r.body?.tools || []).map((t) => t?.name || t?.type),
    })),
    model: first?.model,
    toolCount: tools.length,
    toolNames: tools.map((t) => t?.name || t?.function?.name || t?.type),
    hasDemo: tools.some((t) => JSON.stringify(t).includes('demo')),
    demoServerStarted: existsSync(demoLog),
    demoLog: existsSync(demoLog) ? readFileSync(demoLog, 'utf8') : '',
    pathlikeServerStarted: existsSync(pathlikeLog),
    httpServerStarted: httpLogs.some((p) => existsSync(p)),
    httpLog: httpLogs.filter((p) => existsSync(p)).map((p) => readFileSync(p, 'utf8')).join('').slice(0, 1500),
    mcpLines: mcpLines.slice(0, 12),
    mcpList: mcpList.out.slice(0, 800),
    codexTail: (exec.err || exec.out).slice(-1500),
  });

  for (const h of httpServers) { try { h.child.kill(); } catch { /* ignore */ } }
  server.close();
}

writeFileSync(join(TARGET, 'summary.json'), JSON.stringify(results, null, 2));
for (const r of results) {
  console.log(`\n===== ${r.id} — ${r.label} =====`);
  console.log(`exit=${r.exit} ${r.execErr} 耗时=${r.ms}ms 请求数=${r.reqCount} model=${r.model}`);
  console.log(`tools=${r.toolCount} 含"demo"字符串=${r.hasDemo} demo-mcp 被拉起=${r.demoServerStarted} pathlike 被拉起=${r.pathlikeServerStarted} http-mcp 有日志=${r.httpServerStarted}`);
  console.log(`names: ${JSON.stringify(r.toolNames)}`);
  if (r.perRequest) for (const p of r.perRequest) console.log(`  第${p.n}轮: tools=${p.tools} ${JSON.stringify(p.names)}`);
  if (r.mcpLines.length) console.log(`mcp 相关日志行:\n  ${r.mcpLines.join('\n  ')}`);
  if (r.demoLog) console.log(`demo-mcp 日志:\n${r.demoLog.trim().slice(0, 600)}`);
  if (r.httpLog) console.log(`http-mcp 日志:\n${r.httpLog.trim().slice(0, 900)}`);
  if (r.codexTail.trim()) console.log(`codex 尾部输出:\n${r.codexTail.trim().slice(0, 800)}`);
}
console.log('\n捕获目录:', TARGET);
