/**
 * 一次性探针：**完整链路**上，dsh 到底会看到什么模型元数据。
 *
 * 链路：上游目录 → 桥 `/v1/models` → 插件 `toAdapterModel/resolveModel` → （dsh）。
 * 2026-10-12 的故障就在这条链的"补全项没有能力标记"那一环，本探针直接跑通整条链
 * 并打印 dsh 会拿到的字段（多模态 / 推理等级），用来验收"选不了思考强度"是否真修好。
 *
 *   node tools/dev/probe-dsh-chain.mjs [国际版登录文件路径]
 *
 * 需要能起一个**一次性桥**（默认端口 8798，用完即杀）。不消耗额度：只读目录。
 */
import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { WorkBuddyAdapter } from '../../dsh-plugin/lib/adapter.mjs';
import { BridgeClient } from '../../dsh-plugin/lib/bridge.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = Number(process.env.PROBE_PORT || 8798);
const AUTH_FILE = process.argv[2]
  || join(process.env.LOCALAPPDATA || '', 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop-ai.info');
const TOKEN = readFileSync(join(ROOT, 'dsh-plugin', '.bridge-token'), 'utf8').trim();

if (!existsSync(AUTH_FILE)) {
  console.error('登录文件不存在：' + AUTH_FILE);
  process.exit(2);
}

const bridge = spawn(process.execPath, [join(ROOT, 'bridge', 'workbuddy-bridge.mjs')], {
  cwd: ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    WORKBUDDY_PORT: String(PORT),
    WORKBUDDY_LOCAL_TOKEN: TOKEN,
    WORKBUDDY_AUTH_FILE: AUTH_FILE,
    WORKBUDDY_AUTO_CHECKIN: '0',
    WORKBUDDY_LOG: '0',
    WORKBUDDY_USAGE_FILE: join(process.env.TEMP || '.', 'wb-probe-usage.jsonl'),
  },
});

const baseUrl = `http://127.0.0.1:${PORT}`;
const deadline = Date.now() + 20000;
let up = false;
while (Date.now() < deadline) {
  try {
    const r = await fetch(baseUrl + '/health', { headers: { Authorization: 'Bearer ' + TOKEN }, signal: AbortSignal.timeout(1500) });
    if (r.ok) { up = true; break; }
  } catch { /* 还没起来 */ }
  await new Promise((r) => setTimeout(r, 250));
}
if (!up) { bridge.kill(); console.error('桥未就绪'); process.exit(2); }

try {
  const client = new BridgeClient({ baseUrl, token: TOKEN, timeoutMs: 8000 });
  const adapter = new WorkBuddyAdapter({
    provider: 'workbuddy', displayName: 'WorkBuddy', client,
    ensureReady: async () => client, resolveImage: async () => '', log: () => {},
    filter: { allow: [], deny: [] }, catalogTtlMs: 0,
  });

  const health = await (await fetch(baseUrl + '/health', { headers: { Authorization: 'Bearer ' + TOKEN } })).json();
  console.log('端点:', health.auth?.endpoint, '| 登录文件:', String(health.authFile || '').split(/[\\/]/).pop());
  console.log('补全（上游漏列、桥兜底）:', JSON.stringify(health.upstreamShape?.supplemented));
  console.log();

  const models = await adapter.listModels();
  console.log('listModels →', models.length, '个模型');
  for (const id of ['deepseek-v4.1-flash', 'glm-5.3', 'hy4-preview']) {
    const m = models.find((x) => x.id === id);
    console.log('  ', id.padEnd(22), m ? JSON.stringify(m.inputModalities) : '（目录里没有）');
  }
  console.log();
  for (const id of ['deepseek-v4.1-flash', 'glm-5.3']) {
    const r = await adapter.resolveModel('workbuddy', id);
    console.log('resolveModel(' + id + ') →');
    console.log('   context:', JSON.stringify(r.context), '| maxTokens:', r.defaultMaxTokens);
    console.log('   inputModalities:', JSON.stringify(r.inputModalities));
    console.log('   reasoning:', JSON.stringify(r.reasoning));
  }
} finally {
  bridge.kill();
}
