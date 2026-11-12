/**
 * 端口分配守卫：两套用例**并行**跑时，不许有任何一个端口被两边同时 listen。
 *
 *   node --test tools/dev/test-port-bands.test.mjs
 *
 * ## 为什么需要（2026-11-13 实测踩到）
 *
 * `npm run test:ui`（`tools/dev/test-*.mjs`）与 `npm run panel:check`
 * （`dsh-plugin/tests/panel-*.mjs`）经常同时跑。两边各自都写了"与另一个区间分开"
 * 的注释，但**没人核对过实际交叠**，于是：
 *
 *   test-confirm-modal   const PORT = 8831
 *   panel-drag           const PORT = 8830  →  extra.listen(PORT + 1) = 8831
 *
 * 并行时后者先 listen，前者直接 `EADDRINUSE` 退出。表现是
 * **"某个用例莫名红、单独跑又绿"** —— 与 `test-r6-detail` 那条同族，
 * 但成因完全不同（那条是等待窗口，这条是端口）。当时排查花的时间比写这条断言多。
 *
 * ## 判据：把每个文件真实会 listen 的端口**全算出来**
 *
 * 只扫 `const PORT = N` 是不够的 —— 漏掉 `PORT + 1` 正好就是这次踩的坑。
 * 所以同时收：
 *   - `const PORT = N`（含 `PORT_XXX` 变体）
 *   - `PORT + N`（在外壳服务里 `listen(PORT + 1)` 这种）
 *   - 直接字面量 `listen(88xx)`
 *
 * ## 区间约定
 *
 *   tools/dev/test-*.mjs  共用 `87xx`（多数落在 8774–8869）
 *   tools/dev 里的隔离类   `188xx`（harness-isolation / quota-stale / visibility，
 *                          刻意离得很远，避免被"顺手挪端口"时撞进来）
 *   dsh-plugin/tests/panel-*.mjs  8870–8899
 *
 * 硬约束只有一条：**两套之间不许交叠**。组内怎么排不管（同一套是串行跑的）。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');

/**
 * 本文件自己（它是**扫别人**的守卫，源码里出现的端口都是样本字符串）。
 * 不排除的话它会把自己算成一个占端口的人，报出假冲突 —— 实测首跑就红在这里。
 */
const SELF = 'test-port-bands.test.mjs';

/** 收集一个文件里所有会 listen 的端口。 */
function portsOf(text) {
  const ports = new Set();
  for (const m of text.matchAll(/(?:const|let)\s+PORT(?:_[A-Z]+)?\s*=\s*(\d{4,5})/g)) ports.add(Number(m[1]));
  const baseMatch = text.match(/const\s+PORT\s*=\s*(\d{4,5})/);
  const base = baseMatch ? Number(baseMatch[1]) : null;
  if (base) {
    // `PORT + 1` / `PORT + 2`：外壳服务与多场景各占一个
    for (const m of text.matchAll(/PORT\s*\+\s*(\d+)/g)) ports.add(base + Number(m[1]));
  }
  // 直接写死端口的 listen（`listen(8831, ...)`）
  for (const m of text.matchAll(/listen\(\s*(\d{4,5})\b/g)) ports.add(Number(m[1]));
  return ports;
}

function collect(dir, filter, band) {
  const out = [];
  for (const f of readdirSync(dir)) {
    if (!/\.mjs$/.test(f) || !filter(f) || f === SELF) continue;
    const path = join(dir, f);
    const ports = portsOf(readFileSync(path, 'utf8'));
    if (ports.size) out.push({ file: f, band, ports });
  }
  return out;
}

const ui = collect(join(ROOT, 'tools', 'dev'), (f) => f.startsWith('test-'), 'ui');
const panel = collect(join(ROOT, 'dsh-plugin', 'tests'), (f) => f.startsWith('panel-') && f.endsWith('.mjs'), 'panel');

/**
 * 允许的端口段。
 * `8774–8869` 与控制台用例共用的主区间；`18800–18899` 是隔离类用例刻意分开的一段。
 * 面板侧独占 8870–8899（**必须**与 UI 侧不交叠 —— 那正是这条守卫要防的）。
 */
const BANDS = {
  ui: [[8774, 8869], [18800, 18899]],
  panel: [[8870, 8899]],
};

const inBands = (port, bands) => bands.some(([lo, hi]) => port >= lo && port <= hi);

test('两套用例没有任何一个端口交叠（并行跑不会互相抢）', () => {
  /*
   * 只查**跨套**交叠。
   *
   * 套内重复不算缺陷：`run-ui-tests.mjs` 与 `panel:check` 各自都是
   * **串行**（spawnSync / `&&` 串联），同一时刻只活着一个脚本，用完即退。
   * 实测套内有 4 组重复（8785 / 8788 / 8791 / 8826），一直相安无事 ——
   * 把它们一起算进来只会得到 4 条永远为真的假警报，把真问题（跨套）淹掉。
   *
   * 真正会并行的是**两套之间**：`test:ui` 与 `panel:check` 常被同时敲下去。
   */
  const uiPorts = new Set(ui.flatMap((e) => [...e.ports]));
  const panelPorts = new Map();
  for (const e of panel) for (const p of e.ports) {
    if (!panelPorts.has(p)) panelPorts.set(p, []);
    panelPorts.get(p).push(e.file);
  }
  const clashes = [...panelPorts].filter(([p]) => uiPorts.has(p));

  const detail = clashes
    .map(([p, files]) => {
      const uiOwners = ui.filter((e) => e.ports.has(p)).map((e) => e.file);
      return `  ${p}: ui/${uiOwners.join(', ui/')}  vs  panel/${files.join(', panel/')}`;
    })
    .join('\n');
  assert.equal(
    clashes.length, 0,
    `有 ${clashes.length} 个端口被两套用例同时使用（并行时必有一个 EADDRINUSE）：\n${detail}`,
  );
});

test('端口落在各自的区间里', () => {
  const bad = [];
  for (const e of ui) for (const p of e.ports) if (!inBands(p, BANDS.ui)) bad.push(`ui/${e.file} → ${p}`);
  for (const e of panel) for (const p of e.ports) if (!inBands(p, BANDS.panel)) bad.push(`panel/${e.file} → ${p}`);
  assert.equal(bad.length, 0, `这些端口不在约定区间内：\n  ${bad.join('\n  ')}`);
});

test('守卫自身有牙齿：人造的 PORT + 1 交叠必须被判出来', () => {
  // 变异自检 —— 与 test-confirm-modal 的 confirm 守卫同款纪律：
  // 正则曾经因为一个字符把整类写法放过，用例却一直绿。
  const a = portsOf('const PORT = 8830;\nawait listen(PORT + 1);');
  assert.deepEqual([...a].sort((x, y) => x - y), [8830, 8831]);
  const b = portsOf('const PORT = 8831;');
  const overlap = [...a].filter((p) => b.has(p));
  assert.deepEqual(overlap, [8831], '人造样本里的 8831 交叠必须被抓出来');
});
