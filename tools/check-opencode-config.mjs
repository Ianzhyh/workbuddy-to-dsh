#!/usr/bin/env node
/**
 * 用 **opencode 官方 schema** 校验"我们打算写进它配置里的东西"。
 *
 *   node tools/check-opencode-config.mjs
 *
 * ## 为什么需要它
 *
 * 三个客户端里，Codex 与 Claude Code 本机都**跑通过**（`e2e: true`），
 * opencode 没有 —— 本机装的是**桌面版**（`%LOCALAPPDATA%\Programs\@opencode-aidesktop`），
 * 无头环境里驱动不了 GUI，所以"它是否真的接受这份配置"没法端到端验。
 *
 * 但这件事里**能被机械验证的那一半**是"我们写的键是否合法"：
 * opencode 把配置 schema 公开在 <https://opencode.ai/config.json>（JSON Schema 2020-12），
 * 拿它逐键比对，比"我看了一遍觉得没问题"强得多，而且以后改了 `mergeOpencode`
 * 再跑一次就知道有没有写歪。
 *
 * **不能验证的那一半如实标注**：桌面版启动后是否真把这份配置读进去、
 * provider 是否真能调通 —— 那需要人点一次。别把"schema 过了"说成"接入可用"。
 *
 * ## 依赖
 *
 * - 控制台要在跑（取"将要写入的内容"，即 `/api/connect` 的 `preview`）；
 * - 要能访问 opencode.ai（取 schema）。两者缺一就明确报错，不静默跳过。
 */
import config from '../config.mjs';

const HEAD = { 'x-workbuddy-panel': '1' };
const SCHEMA_URL = 'https://opencode.ai/config.json';

const die = (msg) => { console.error(msg); process.exit(1); };

// ── 取"将要写入的内容"（不落盘：这是 plan，不是 apply）──────────────────────
let plan;
try {
  const r = await fetch(`${config.dashboard.url}/api/connect`, { headers: HEAD });
  if (!r.ok) die(`读不到接入状态：HTTP ${r.status}（控制台在跑吗？它需要 ${config.dashboard.url}）`);
  plan = await r.json();
} catch (e) {
  die(`连不上控制台（${config.dashboard.url}）：${e.message}\n先启动控制台（启动.cmd），或直接用 npm run connect 看命令行输出。`);
}
const oc = plan.clients.find((c) => c.id === 'opencode');
if (!oc) die('接入状态里没有 opencode —— 版本对不上？');

console.log(`opencode 配置：${oc.path}`);
console.log(`  现状 exists=${oc.exists} applied=${oc.applied} changed=${oc.changed}`);

let preview;
try {
  preview = JSON.parse(oc.preview);
} catch (e) {
  die(`opencode 的配置预览不是合法 JSON：${e.message}`);
}

// ── 取官方 schema ─────────────────────────────────────────────────────────
let schema;
try {
  const r = await fetch(SCHEMA_URL);
  if (!r.ok) die(`取不到官方 schema：HTTP ${r.status}（${SCHEMA_URL}）`);
  schema = await r.json();
} catch (e) {
  die(`取不到官方 schema（${SCHEMA_URL}）：${e.message}\n这一步需要联网；离线时请人工核对文档。`);
}
if (!schema.$defs) die(`官方 schema 的形状变了（没有 $defs）：${SCHEMA_URL}`);

/**
 * 解开 `$ref`，**只解本地 `#/$defs/...`**。
 *
 * 实测踩到：`Config.properties.model` 的 `$ref` 指向**另一个文件**
 * （`https://models.dev/model-schema.json#/$defs/Model`）—— 当成本地去找会返回
 * undefined，于是那条完全合法的 `model` 被误报成"schema 里没有这个键"。
 * 这种键的 `type` 通常就写在旁边（这里是 `"type": "string"`），按内联的判即可。
 */
const deref = (node) => {
  let cur = node;
  let guard = 0;
  while (cur && cur.$ref && String(cur.$ref).startsWith('#') && guard < 10) {
    cur = schema.$defs[String(cur.$ref).split('/').pop()];
    guard += 1;
  }
  return cur;
};

/** 走一层：properties → additionalProperties → anyOf/oneOf/allOf。 */
function step(node, seg) {
  const cur = deref(node);
  if (!cur) return null;
  if (cur.properties && cur.properties[seg]) return deref(cur.properties[seg]);
  if (cur.additionalProperties && typeof cur.additionalProperties === 'object') return deref(cur.additionalProperties);
  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    for (const sub of cur[key] || []) {
      const hit = step(sub, seg);
      if (hit) return hit;
    }
  }
  return null;
}

const typeOf = (v) => (Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v);

/** 收集所有叶子路径（值不是普通对象的那些）。 */
function leaves(obj, prefix = []) {
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) out.push(...leaves(v, [...prefix, k]));
    else out.push({ path: [...prefix, k], value: v });
  }
  return out;
}

let cur = deref(schema);
let ok = 0;
const bad = [];
for (const leaf of leaves(preview)) {
  for (const seg of leaf.path) cur = step(cur, seg) || null;   // 逐段下降
  const got = typeOf(leaf.value);
  if (!cur) {
    bad.push(`${leaf.path.join('.')}（schema 里没有这个键）`);
    cur = deref(schema);   // 复位，下一条从头走
    continue;
  }
  const want = cur.type || (cur.anyOf ? cur.anyOf.map((a) => deref(a)?.type).join('|') : '?');
  const match = !cur.type || cur.type === got
    || (Array.isArray(cur.type) && cur.type.includes(got))
    || (cur.anyOf || []).some((a) => deref(a)?.type === got);
  if (match) ok += 1;
  else bad.push(`${leaf.path.join('.')}：schema 说 ${want}，我们写的是 ${got}`);
  cur = deref(schema);
}

console.log(`\n逐键校验（对着 ${SCHEMA_URL}）：${ok} 条通过，${bad.length} 条有问题`);
for (const b of bad) console.log('  ✗ ' + b);
if (!bad.length) console.log('  ✓ 我们写的每个键都在官方 schema 里、类型都对');
console.log('\n注意：这**只**证明"配置合法"。桌面版是否真的读进去并调通，需要人点一次。');
process.exit(bad.length ? 1 : 0);
