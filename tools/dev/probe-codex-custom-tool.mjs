#!/usr/bin/env node
/**
 * 真机探针：**真实 codex.exe + 真实桥** 跑一遍 freeform（custom）工具的往返。
 *
 *   node tools/dev/probe-codex-custom-tool.mjs
 *
 * 为什么必须真机跑：这条链路的正确性全在"字节对得上"——
 *   客户端（codex.exe）按 `apply_patch` 声明 freeform 工具
 *     → 桥把它翻成上游认的 `input: string` 函数（请求侧）
 *     → 上游按函数接口回调用（桩：确定性）
 *     → 桥按 `custom_tool_call` 回给客户端（回包侧）
 *     → 客户端**真的执行补丁**，并把 `custom_tool_call` / `custom_tool_call_output`
 *       放进下一轮 `input`（历史双向映射）
 * 任何一环形状不对，客户端要么判 `incompatible payload`、要么静默不执行 ——
 * 单测（bridge-responses.test.mjs）只能验桥发出的字节，验不了客户端收不收。
 *
 * 桩上游让它**不花额度**、也不看模型当天心情；断言有三条：
 *   1. 桩收到的**请求**里，apply_patch 是普通函数且参数是唯一必需的 `input`；
 *   2. 第二轮的 `messages` 里能同时看到 assistant.tool_calls 与 role:"tool" 结果
 *      （说明 custom 调用记录被双向映射了）；
 *   3. **目标文件被真的创建出来**、内容一字不差。
 *
 * ⚠️ 不碰用户的 `~/.codex`：临时 `CODEX_HOME` + 临时 bridge 端口 + 假登录文件。
 * ⚠️ 需要本机有 codex.exe；找不到就如实跳过（不假绿）。
 */
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const BRIDGE = join(REPO, 'bridge', 'workbuddy-bridge.mjs');
const SOURCE_CATALOG = process.env.CODEX_CATALOG || join(process.env.USERPROFILE || '', '.codex', 'workbuddy-model-catalog.json');

/** 找 codex.exe：PATH → Codex 自己的 bin 目录。找不到返回 null（探针如实跳过）。 */
function findCodex() {
  const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['codex'], { stdio: ['ignore', 'pipe', 'ignore'] });
  const fromPath = String(which.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
  if (fromPath && existsSync(fromPath)) return fromPath;
  const binRoot = join(process.env.LOCALAPPDATA || '', 'OpenAI', 'Codex', 'bin');
  if (!existsSync(binRoot)) return null;
  for (const version of readdirSync(binRoot)) {
    const exe = join(binRoot, version, 'codex.exe');
    if (existsSync(exe)) return exe;
  }
  return null;
}

const codexExe = findCodex();
if (!codexExe) {
  console.log('SKIP: 本机找不到 codex.exe —— 这条探针需要在装了 Codex 的机器上跑');
  process.exit(0);
}
if (!existsSync(SOURCE_CATALOG)) {
  console.log(`SKIP: 找不到目录模板 ${SOURCE_CATALOG}（先用一键接入生成一份，或设 CODEX_CATALOG）`);
  process.exit(0);
}

const work = mkdtempSync(join(tmpdir(), 'wb-codex-probe-'));
const home = join(work, 'codex-home');
const proj = join(work, 'proj');
mkdirSync(home, { recursive: true });
mkdirSync(proj, { recursive: true });
copyFileSync(SOURCE_CATALOG, join(home, 'workbuddy-model-catalog.json'));

const bridgeToken = 'probe-local-token';
const bridgePort = 20000 + Math.floor(Math.random() * 20000);
const TARGET = join(proj, 'probe-custom-tool.txt');
const EXPECTED = 'written through custom_tool_call\n';

// ── 桩上游（chat/completions）────────────────────────────────────────────
const requests = [];
const PATCH = `*** Begin Patch\n*** Add File: ${join(proj, 'probe-custom-tool.txt')}\n+${EXPECTED.trimEnd()}\n*** End Patch\n`;

const sse = (o) => `data: ${JSON.stringify(o)}\n\n`;
const upstream = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    if (!String(req.url).startsWith('/v2/chat/completions')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 0, data: { models: [] } }));
      return;
    }
    let body = null;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* ignore */ }
    requests.push(body);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (requests.length === 1) {
      // 第一轮：模型"决定"编辑文件 → 按上游函数接口回 JSON 参数（分两片）
      res.write(sse({ id: 'c1', model: 'm', choices: [{ index: 0, delta: { content: 'Writing the file.' } }] }));
      res.write(sse({ id: 'c1', model: 'm', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_probe_patch', type: 'function', function: { name: 'apply_patch' } }] } }] }));
      const args = JSON.stringify({ input: PATCH });
      const mid = Math.floor(args.length / 2);
      res.write(sse({ id: 'c1', model: 'm', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(0, mid) } }] } }] }));
      res.write(sse({ id: 'c1', model: 'm', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(mid) } }] } }] }));
    } else {
      // 第二轮：工具结果已在上下文里 → 正常收尾
      res.write(sse({ id: 'c1', model: 'm', choices: [{ index: 0, delta: { content: 'done.' } }] }));
    }
    res.write(sse({ id: 'c1', model: 'm', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 } }));
    res.write('data: [DONE]\n\n');
    res.end();
  });
});
await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
const upPort = upstream.address().port;

// ── 真桥 ────────────────────────────────────────────────────────────────
const authFile = join(work, 'fake-auth.info');
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
writeFileSync(authFile, JSON.stringify({
  auth: {
    accessToken: `${b64({ alg: 'none' })}.${b64({ sub: 'probe', exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`,
    refreshToken: 'fake', expiresAt: Date.now() + 3600_000, domain: 'copilot.tencent.com',
  },
}));

const bridge = spawn(process.execPath, [BRIDGE], {
  cwd: work,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    WORKBUDDY_HOST: '127.0.0.1',
    WORKBUDDY_PORT: String(bridgePort),
    WORKBUDDY_LOCAL_TOKEN: bridgeToken,
    WORKBUDDY_AUTH_FILE: authFile,
    CODEBUDDY_ENDPOINT: `http://127.0.0.1:${upPort}`,
    CODEBUDDY_API_KEY: 'stub-key',
    WORKBUDDY_AUTO_CHECKIN: '0',
    WORKBUDDY_LOG: '1',
    WORKBUDDY_RESPONSES_MODEL: 'deepseek-v4.1-flash',
  },
});
let bridgeOut = '';
bridge.stdout.on('data', (d) => { bridgeOut += d; });
bridge.stderr.on('data', (d) => { bridgeOut += d; });

const bridgeBase = `http://127.0.0.1:${bridgePort}`;
for (let i = 0; i < 100; i += 1) {
  try {
    const r = await fetch(`${bridgeBase}/health`, { headers: { Authorization: `Bearer ${bridgeToken}` } });
    if (r.status === 200) break;
  } catch { /* not up yet */ }
  await new Promise((r) => setTimeout(r, 100));
}

// ── 临时 CODEX_HOME（不碰用户的 ~/.codex）───────────────────────────────
writeFileSync(join(home, 'config.toml'), [
  'model_provider = "bridge"',
  'model = "deepseek-v4.1-flash"',
  'model_catalog_json = "workbuddy-model-catalog.json"',
  'approval_policy = "never"',
  'sandbox_mode = "danger-full-access"',
  '',
  '[model_providers.bridge]',
  'name = "probe bridge"',
  `base_url = "${bridgeBase}/v1"`,
  'wire_api = "responses"',
  `experimental_bearer_token = "${bridgeToken}"`,
  '',
].join('\n'));

console.log(`codex : ${codexExe}`);
console.log(`bridge: ${bridgeBase} → stub ${upPort}`);
console.log(`target: ${TARGET}`);

const codex = spawn(codexExe, ['exec', '--skip-git-repo-check', '--ephemeral', '-C', proj, 'Create the probe file with apply_patch.'], {
  env: { ...process.env, CODEX_HOME: home, RUST_LOG: 'warn' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let codexOut = '';
codex.stdout.on('data', (d) => { codexOut += d; });
codex.stderr.on('data', (d) => { codexOut += d; });
const killer = setTimeout(() => { try { codex.kill(); } catch { /* ignore */ } }, 180000);

codex.on('exit', (code, sig) => {
  clearTimeout(killer);
  const fails = [];
  const ok = (cond, msg) => { console.log(`${cond ? '✅' : '❌'} ${msg}`); if (!cond) fails.push(msg); };

  console.log(`\ncodex exited code=${code} sig=${sig}`);
  console.log('---- codex 输出（尾 1200 字）----');
  console.log(codexOut.slice(-1200));

  const first = requests[0];
  const patchTool = (first?.tools || []).find((t) => t?.function?.name === 'apply_patch');
  ok(!!patchTool, '请求侧：apply_patch 被翻成上游函数（原先静默丢弃）');
  ok(patchTool?.type === 'function' && JSON.stringify(patchTool?.function?.parameters?.required) === '["input"]',
    '请求侧：freeform 正文走唯一必需的 `input` 字符串参数');
  ok(!/do not wrap the patch in JSON/i.test(patchTool?.function?.description || ''),
    '请求侧：模板里"别包 JSON"那句已被改写（否则与函数接口打架）');

  const second = requests[1];
  const assistant = (second?.messages || []).find((m) => Array.isArray(m.tool_calls));
  const toolMsg = (second?.messages || []).find((m) => m.role === 'tool');
  ok(!!assistant, '历史映射：custom_tool_call → assistant.tool_calls');
  ok(!!toolMsg, '历史映射：custom_tool_call_output → role:"tool" 结果');

  ok(existsSync(TARGET), '回包侧：客户端**真的执行了** custom_tool_call（目标文件被创建）');
  if (existsSync(TARGET)) {
    ok(readFileSync(TARGET, 'utf8').replace(/\r\n/g, '\n') === EXPECTED, '文件内容一字不差');
  }
  ok(/freeform=apply_patch/.test(bridgeOut), '桥日志里有 freeform 声明（排查时按这行找）');
  ok(!/incompatible payload/i.test(codexOut), 'codex 没有报 incompatible payload');

  try { bridge.kill(); } catch { /* ignore */ }
  upstream.close();
  rmSync(work, { recursive: true, force: true });

  console.log(`\n${fails.length ? `❌ ${fails.length} 条断言失败` : '✅ 全部通过'}`);
  process.exit(fails.length ? 1 : 0);
});
