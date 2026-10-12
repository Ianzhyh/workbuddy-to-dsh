/**
 * 探针：**全量实测**每个模型对各个 `reasoning_effort` 档位的接受度（可续跑）。
 *
 * 为什么必须实测：插件给 dsh 声明的档位原先**写死**成低/中/高三档，而上游到底收
 * 哪些值没有任何目录字段可查（`supportsReasoning` 只说"支持推理"，不说支持哪几档）。
 * 声明了却不接受 → 用户一选就报错：`does not support reasoning effort "xxx"`。
 *
 * 档位集合取自**国际版桌面端产物**里的定义（`EXTENDED_THINKING_LEVELS`）：
 *   off / minimal / low / medium / high / xhigh / max
 * 另加 `none`（部分 provider 用 `none` 表示关闭思考）。
 *
 *   node tools/dev/probe-efforts-all.mjs <bridge-token> [模型 id...]
 *
 * - 结果逐格**增量落盘** `E:/tmp/effort-matrix.json`，被限流/中断后**复跑会跳过已测格子**
 *   （要推倒重来：`PROBE_FORCE=1`）；
 * - 网关有限流：默认 3s 一格 + 429 退避重试；连续 3 次 429 就停下（别硬打）。
 *
 * ⚠️ `max_tokens` 不能给太小：**推理模型会拒绝过小的输出预算** —— 实测
 * `gpt-5.6-sol` 在 `max_tokens=8` 时稳定 400（`model_param_invalid`），
 * ≥64 就正常。第一批矩阵就是这么把 9 个模型误判成"完全不可调"的。
 */
import { writeFileSync, existsSync, readFileSync } from 'node:fs';

const TOKEN = process.argv[2];
const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:8790';
const ONLY = process.argv.slice(3);
const LEVELS = ['off', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const PACE_MS = Number(process.env.PROBE_PACE_MS || 3000);
const BACKOFF_MS = Number(process.env.PROBE_BACKOFF_MS || 15000);
const OUT = process.env.PROBE_OUT || 'E:/tmp/effort-matrix.json';
/** 输出预算：够推理模型思考，又不至于让每格变贵（实测每格总用量 ~50-100 token）。 */
const MAX_TOKENS = Number(process.env.PROBE_MAX_TOKENS || 1024);

const h = { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const cat = await (await fetch(BASE + '/v1/models?all=1', { headers: h })).json();
const models = (cat.data || [])
  .filter((m) => (ONLY.length ? ONLY.includes(m.id) : m.supports_reasoning === true))
  .map((m) => m.id);

const prev = (existsSync(OUT) && process.env.PROBE_FORCE !== '1')
  ? JSON.parse(readFileSync(OUT, 'utf8'))
  : { at: null, levels: LEVELS, matrix: {} };
prev.levels = LEVELS;
prev.at = new Date().toISOString();
const matrix = prev.matrix;

/**
 * 对照组：**不带任何档位**发一次。
 *
 * 为什么必须有它：有些模型（实测 gpt-5.6-sol/terra/luna、gpt-5.5/5.4）对**所有**
 * 参数都 400 —— 那是模型本身不可用，不是"不支持这个档位"。
 * 没有对照组就会把"模型调不通"误读成"这个档位不支持"，得出完全错误的结论。
 */
async function probeControl(model) {
  const body = { model, max_tokens: MAX_TOKENS, stream: false, messages: [{ role: 'user', content: '2' }] };
  const res = await fetch(BASE + '/v1/chat/completions', { method: 'POST', headers: h, body: JSON.stringify(body) });
  const json = await res.json().catch(() => null);
  return {
    status: res.status,
    reasoningTokens: json?.usage?.completion_tokens_details?.reasoning_tokens ?? null,
    err: res.status === 200 ? undefined : String(json?.error?.message || json?.msg || '').slice(0, 90),
  };
}

console.log(`模型 ${models.length} 个 × 档位 ${LEVELS.length} 档，节奏 ${PACE_MS}ms，续跑自 ${OUT}`);
console.log('模型'.padEnd(22) + 'ctl'.padStart(8) + LEVELS.map((l) => l.padStart(8)).join(''));

let consecutive429 = 0;
outer:
for (const model of models) {
  const row = matrix[model] || (matrix[model] = {});
  if (!row.control) {
    let c = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      c = await probeControl(model);
      if (c.status !== 429) break;
      process.stdout.write(`\n  [429] ${model}/control 退避 ${BACKOFF_MS / 1000}s 重试`);
      await sleep(BACKOFF_MS);
    }
    row.control = c;
    writeFileSync(OUT, JSON.stringify(prev, null, 1));
    consecutive429 = c.status === 429 ? consecutive429 + 1 : 0;
    if (consecutive429 >= 3) {
      console.log('\n\n连续 3 次 429 —— 停下（已测格子都在 JSON 里，过一会儿复跑会接着测）');
      break outer;
    }
    await sleep(PACE_MS);
  }
  for (const level of LEVELS) {
    if (row[level] && row[level].status !== undefined && row[level].status !== 429) continue; // 已测
    const body = {
      model, max_tokens: MAX_TOKENS, stream: false, reasoning_effort: level,
      messages: [{ role: 'user', content: '2' }],
    };
    let cell = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const res = await fetch(BASE + '/v1/chat/completions', { method: 'POST', headers: h, body: JSON.stringify(body) });
        const json = await res.json().catch(() => null);
        const rt = json?.usage?.completion_tokens_details?.reasoning_tokens ?? null;
        cell = {
          status: res.status,
          reasoningTokens: rt,
          err: res.status === 200 ? undefined : String(json?.error?.message || '').slice(0, 90),
        };
      } catch (e) {
        cell = { status: 0, err: e.message };
      }
      if (cell.status !== 429) break;
      process.stdout.write(`\n  [429] ${model}/${level} 退避 ${BACKOFF_MS / 1000}s 重试`);
      await sleep(BACKOFF_MS);
    }
    row[level] = cell;
    writeFileSync(OUT, JSON.stringify(prev, null, 1));
    consecutive429 = cell.status === 429 ? consecutive429 + 1 : 0;
    if (consecutive429 >= 3) {
      console.log('\n\n连续 3 次 429 —— 停下（已测格子都在 JSON 里，过一会儿复跑会接着测）');
      break outer;
    }
    await sleep(PACE_MS);
  }
  const fmt = (c) => (!c ? '—' : c.status === 200 ? String(c.reasoningTokens ?? 'ok') : c.status === 0 ? 'ERR' : String(c.status));
  console.log('\r' + model.padEnd(22)
    + ('ctl=' + fmt(row.control)).padStart(8)
    + LEVELS.map((l) => fmt(row[l]).padStart(8)).join(''));
}

console.log('\n已写 ' + OUT + '（数字 = 该档返回的 reasoning_tokens；ok = 200 但没报 reasoning_tokens；4xx = 该档不接受）');
