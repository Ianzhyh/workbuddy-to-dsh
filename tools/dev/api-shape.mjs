/**
 * 接口形状：捕获真实响应结构，并在打桩时自动校验。
 *
 *   node tools/dev/api-shape.mjs capture   # 从运行中的控制台重新捕获形状
 *   node tools/dev/api-shape.mjs check     # 对比已提交的形状与当前真实接口
 *
 * ## 为什么需要它
 *
 * 无头验收（`ui-harness.mjs`）靠**手写桩数据**喂页面。桩数据的字段名一旦与真实接口
 * 不一致，页面**不会报错**，只会静默地不渲染 —— 而页面看起来一切正常。
 *
 * 这个坑在一天里踩了三次，每次都是"自信地得出一个错误结论"：
 *   1. 把 `/api/usage` 的 `models` 写成 `byModel` → **用量表整张没渲染**，
 *      此前所有截图都漏掉了它；
 *   2. 把 `/api/diagnose` 的 `label` 写成 `name` → 诊断面板渲染出一串 `undefined`；
 *   3. 把 `/api/checkin` 的桥挂掉态写成 `{status:{active:false}}`（真实是
 *      `{ok:false,error}`）→ 页面显示"国际版网关不含积分系统"，
 *      看起来像**产品在无依据地下结论**，其实是我的桩错了。
 *
 * 三次都是"以为发现了产品 bug，其实是自己的夹具错了"。所以这里把真实形状**固化下来**，
 * 让桩数据在渲染前就被校验 —— 错了就直接失败，而不是悄悄渲染成空。
 *
 * ## 只记结构，不记值
 *
 * 形状文件里只有**键名与类型**，不含任何真实数据（账号、uid、路径都不会出现）。
 * 所以它可以安全入库，也不需要在捕获时做脱敏。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHAPE_FILE = join(HERE, 'api-shape.json');

/** 需要捕获的 GET 接口（POST 类的写接口不参与，它们的响应只在动作后才有意义）。 */
export const CAPTURED_ROUTES = [
  '/api/overview',
  '/api/models',
  '/api/clients',
  '/api/diagnose',
  '/api/usage',
  '/api/requests',
  '/api/accounts',
  '/api/checkin',
  '/api/probe-results',
];

/**
 * 把任意 JSON 压成「路径 → { type, optional }」。
 *
 * **数组必须遍历全部元素取并集，不能只看第 0 个。** 同一个数组里不同元素的键集
 * 可能不同（条件字段），只看第一个会漏掉它们 —— 实测 `/api/models` 的第 0 个是
 * 免费模型 `auto`（不带 `credits`），而 30 个模型里有 28 个带，只看第 0 个就会
 * 把 `credits` 整个漏掉，进而把写了 `credits` 的桩误判成「字段名写错」。
 *
 * 元素间**不是每个都有**的键标记为 `optional`，校验时不强制。
 */
function flatten(value, prefix, out) {
  const t = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  if (out[prefix] === undefined) out[prefix] = { type: t };
  else if (out[prefix].type !== t) out[prefix].type = 'mixed';

  if (t === 'object') {
    for (const [k, v] of Object.entries(value)) flatten(v, prefix + '.' + k, out);
    return;
  }
  if (t !== 'array') return;

  for (const item of value) flatten(item, prefix + '[]', out);

  // 再统一标 optional：某个元素缺这个键，说明它不是必有的
  const keySets = value
    .filter((it) => it && typeof it === 'object' && !Array.isArray(it))
    .map((it) => new Set(Object.keys(it)));
  if (keySets.length > 1) {
    const allKeys = new Set(keySets.flatMap((s) => [...s]));
    for (const k of allKeys) {
      if (!keySets.some((s) => !s.has(k))) continue; // 每个元素都有 → 不是条件字段
      const target = prefix + '[].' + k;
      for (const path of Object.keys(out)) {
        if (path === target || path.startsWith(target + '.')) out[path].optional = true;
      }
    }
  }
}

/** 捕获一个接口的形状。 */
export async function captureRoute(baseUrl, route) {
  const res = await fetch(baseUrl + route);
  if (!res.ok) throw new Error(`${route} → HTTP ${res.status}`);
  const body = await res.json();
  const paths = {};
  flatten(body, '$', paths);
  return paths;
}

/** 从运行中的控制台捕获全部形状。 */
export async function captureAll(baseUrl = 'http://127.0.0.1:8792') {
  const out = { _note: '由 tools/dev/api-shape.mjs capture 生成。只有键名与类型，不含真实数据。', routes: {} };
  for (const route of CAPTURED_ROUTES) {
    try {
      out.routes[route] = await captureRoute(baseUrl, route);
    } catch (err) {
      out.routes[route] = { _error: String(err.message || err) };
    }
  }
  return out;
}

export function loadShape() {
  if (!existsSync(SHAPE_FILE)) return null;
  return JSON.parse(readFileSync(SHAPE_FILE, 'utf8'));
}

/**
 * 以「id / 名称」为键的动态映射：子键不参与「多余键」检查。
 *
 * 这类结构没法从一次捕获里推出它的键集（模型 id 是变的），所以显式列出。
 * 新增这类接口时把它加进来，并在注释里写清为什么。
 */
const DYNAMIC_MAP_PARENTS = new Set([
  '$.results', // /api/probe-results：{ results: { <模型 id>: {...} } }
]);

/**
 * 校验一份桩数据是否符合已记录的形状。返回 `{ missing, unknown }`。
 *
 * ## 两条规则的取舍（都来自踩过的坑）
 *
 * **缺失检查只到深度 2，且不进数组元素。**
 * 因为「页面读不读某个字段」静态推不出来：桩里少一个页面根本没读的字段
 * （如 `/api/models` 的 `owned_by`）是无害的，强制补齐只会让人写一堆噪音。
 * 而三次真事故的字段都在深度 ≤ 2 上：
 *   - `/api/usage` 少 `usage.ok` / `usage.total` / `usage.models`
 *   - `/api/checkin` 少 `ok` / `checkin`
 *
 * **多余检查（桩里有、真实接口没有的键）要连数组元素一起查。**
 * 这是「字段名写错」最可靠的信号 —— 写错名字必然同时表现为「多了个不存在的键」。
 * 第三次事故（`/api/diagnose` 把 `label` 写成 `name`）就是靠这条抓到的，
 * 而它在数组元素里，缺失检查覆盖不到。
 *
 * 另外：**条件字段记不下来**。例如 `/api/models` 的 `free` 只在模型免费时才出现，
 * 所以捕获不到、也不能要求桩里有 —— 这类字段不参与检查。
 */
/**
 * 取父路径。**数组元素路径要特殊处理**：`$.a.b[]` 的父是 `$.a.b` 而不是 `$.a`
 * —— 直接对整串取 `lastIndexOf('.')` 会退到 `$.a`，于是"兄弟键"找错一层，
 * 把合法的桩误判成字段名写错（踩过：`$.dsh.registeredModels[]` 被误报）。
 */
function parentOf(path) {
  const bare = path.endsWith('[]') ? path.slice(0, -2) : path;
  const i = bare.lastIndexOf('.');
  return i <= 0 ? '$' : bare.slice(0, i);
}

/** 该路径是否属于一个「以 id 为键」的动态映射。 */
function inDynamicMap(path) {
  return DYNAMIC_MAP_PARENTS.has(parentOf(path));
}

export function validateBody(route, body, shape = loadShape()) {
  const real = shape && shape.routes && shape.routes[route];
  if (!real || real._error) return { missing: [], unknown: [] };

  const stubPaths = {};
  flatten(body, '$', stubPaths);

  /*
   * 失败态例外：真实接口在失败时只回 `{ ok: false, error }`，**不带成功载荷**
   * （例如桥没跑时的 `/api/checkin` 就没有 `status`）。
   * 形状是从**成功**响应捕获的，所以这里不能拿成功态的字段去要求失败态的桩。
   * 判据是桩自己声明了 `ok: false` —— 由写桩的人显式表达"我在模拟失败"。
   */
  if (body && typeof body === 'object' && body.ok === false) return { missing: [], unknown: [] };

  // ── 缺失：真实形状里 depth ≤ 2 且**必有**的路径必须存在 ──
  const missing = [];
  for (const [path, meta] of Object.entries(real)) {
    if (path === '$' || path.includes('[]')) continue; // 数组元素字段不强制
    if (path.split('.').length - 1 > 2) continue;
    if (meta.optional) continue;                       // 条件字段（不是每个样本都有）
    if (path in stubPaths) continue;
    if (inDynamicMap(path)) continue;                  // 动态映射的键不可枚举
    const parent = parentOf(path);
    if (parent !== '$' && stubPaths[parent] === undefined) continue; // 父层没写，别重复报
    if (stubPaths[parent] && stubPaths[parent].type === 'null') continue; // 真实接口此处可为 null
    missing.push(`${path}（真实是 ${meta.type}）`);
  }

  // ── 多余：桩里出现真实形状没有的键（含数组元素层）──
  const unknown = [];
  for (const path of Object.keys(stubPaths)) {
    if (path === '$' || real[path] !== undefined) continue;
    if (inDynamicMap(path)) continue;
    if (path.endsWith('[]')) {
      // 真实形状里这个数组是空的，就没有元素样板可比 —— 无从判断，跳过
      const siblings = Object.keys(real).filter((k) => k.startsWith(path + '.'));
      if (siblings.length === 0) continue;
    } else {
      const parent = parentOf(path);
      if (parent !== '$' && real[parent] === undefined) continue; // 父层本身就不对，已在父层报过
      // 真实接口在父层捕获到的是 `null`（例如当时没开自动签到时的
      // `bridge.autoCheckin`）——**没有证据**说子键不该存在，不能据此报「多余」。
      // 与上面 missing 方向的同一条判断对齐。
      if (parent !== '$' && real[parent] && real[parent].type === 'null') continue;
    }
    unknown.push(path);
  }

  return { missing, unknown };
}

/** 校验整组路由；返回人类可读的问题列表。 */
export function validateRoutes(routes, shape = loadShape()) {
  const problems = [];
  for (const [route, spec] of Object.entries(routes)) {
    const body = spec && spec.body;
    if (typeof body === 'function') continue; // 函数体在页面里执行，无法静态校验
    if (!body || typeof body !== 'object') continue;
    const { missing, unknown } = validateBody(route, body, shape);
    if (missing.length || unknown.length) problems.push({ route, missing, unknown });
  }
  return problems;
}

// ── CLI ─────────────────────────────────────────────────────────────────
if (process.argv[1] && process.argv[1].endsWith('api-shape.mjs')) {
  const cmd = process.argv[2] || 'check';

  if (cmd === 'capture') {
    const base = process.argv[3] || 'http://127.0.0.1:8792';
    const shape = await captureAll(base);
    writeFileSync(SHAPE_FILE, JSON.stringify(shape, null, 2) + '\n');
    const n = Object.keys(shape.routes).length;
    console.log(`已捕获 ${n} 个接口的形状 → ${SHAPE_FILE}`);
    for (const [r, p] of Object.entries(shape.routes)) {
      console.log('  ' + r.padEnd(22) + (p._error ? '❌ ' + p._error : Object.keys(p).length + ' 条路径'));
    }
  } else if (cmd === 'check') {
    const saved = loadShape();
    if (!saved) { console.error('还没有形状文件，先跑：node tools/dev/api-shape.mjs capture'); process.exit(1); }
    const live = await captureAll(process.argv[3] || 'http://127.0.0.1:8792');
    let drift = 0;
    for (const route of CAPTURED_ROUTES) {
      const a = saved.routes[route] || {};
      const b = live.routes[route] || {};
      if (b._error) { console.log(`  ⚠️  ${route} 当前不可用：${b._error}`); continue; }
      const added = Object.keys(b).filter((k) => !(k in a));
      const removed = Object.keys(a).filter((k) => !(k in b) && !k.startsWith('_'));
      if (added.length || removed.length) {
        drift += 1;
        console.log(`  ✗ ${route}`);
        if (added.length) console.log('      新增：' + added.join(', '));
        if (removed.length) console.log('      消失：' + removed.join(', '));
      }
    }
    console.log(drift === 0 ? '\n接口形状与记录一致。' : `\n${drift} 个接口形状有变化 —— 若确认无误，重跑 capture 更新。`);
    process.exit(drift === 0 ? 0 : 1);
  } else {
    console.log('用法：node tools/dev/api-shape.mjs [capture|check] [baseUrl]');
  }
}
