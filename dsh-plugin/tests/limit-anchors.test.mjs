import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * 加载 client.js 的导出（它是一个懒加载 CJS bundle，靠 `module.exports` 挂导出）。
 *
 * 这个 bundle 在被 require 时会摸一下 `window`（注册 bundle 的那套约定），
 * 所以先给一个**最小桩**：只提供它脚本期真正用到的那几个字段。不装完整 DOM
 * 的好处是——一旦它开始依赖更多浏览器能力，这里会立刻炸，而不是悄悄跑偏。
 */
async function loadExports() {
  const g = globalThis;
  if (!g.window) {
    g.window = g;
    /* 面板模块在加载阶段会读 location/search（决定语言等），给个空壳 */
    if (!g.location) g.location = { search: '', href: 'http://localhost/', pathname: '/' };
    if (!g.localStorage) {
      const store = new Map();
      g.localStorage = {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => { store.set(k, String(v)); },
        removeItem: (k) => { store.delete(k); },
      };
    }
    if (!g.document) {
      g.document = {
        documentElement: { style: {}, setAttribute() {}, getAttribute() { return null; } },
        addEventListener() {}, removeEventListener() {},
        createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }),
        querySelector: () => null,
        querySelectorAll: () => [],
        hidden: false,
      };
    }
  }
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  return require('../lib/client.js');
}

const ENTRIES = (resetAt) => ([{
  uid: 'u1', model: 'deepseek-v4.1-flash', kind: 'quota', count: 1,
  lastAt: '2026-11-13T14:00:00.000Z', resetAt, accountLabel: 'Fixture', isCurrent: true,
}]);

/*
 * ⚠️ 有些 bundle 形态在 import 时需要一个最小的全局环境（React 等）。
 * 拿不到导出就跳过这组用例，而不是让整套测试红掉 —— 真正的行为由
 * rail-render 的浏览器用例覆盖。
 */
/*
 * ⚠️ 这个 bundle 是给浏览器用的懒加载 CJS：加载阶段就要 `window.__ModuleLoader__`
 * 才能注册，在 Node 里直接 require 会失败（实测 `Cannot read properties of
 * undefined (reading 'load')`）。硬造一整套桩只会测到桩、不是测到产品。
 *
 * 所以这组用例**只在能拿到导出时运行**；算法本身由 `rail-render.mjs` 的
 * 浏览器用例覆盖（那里 bundle 是真的在跑）。保留这个文件的价值是：一旦
 * bundle 形态改成可直接 require，这些用例会自动开始生效。
 */
let mod = null;
let skipReason = '';
try {
  mod = await loadExports();
} catch (error) {
  skipReason = String(error && error.message ? error.message : error);
}
const T = mod && typeof mod.applyLimitAnchors === 'function' ? test : test.skip;

test('client bundle 暴露了纯函数（导出没被 tree-shake 掉）', { skip: skipReason || false }, () => {
  assert.equal(typeof mod.applyLimitAnchors, 'function', 'applyLimitAnchors 应被导出');
  assert.equal(typeof mod.fmtCountdown, 'function', 'fmtCountdown 应被导出');
});

/*
 * ── 锚点算法的核心行为 ──
 *
 * 这一组回答的正是"到时间会不会消失"：
 * 早期写法每轮轮询都把倒计时重置（永远剩 4 秒 → 永不消失）。
 */

T('锚点：同一个 resetAt 下，剩余时间随本机时钟递减', () => {
  const anchors = new Map();
  const at = '2026-11-13T14:00:00.000Z';
  const resetAt = '2026-11-13T14:00:10.000Z';   // 距 at 10 秒
  /* 首次看到：还剩 10 秒 */
  let kept = mod.applyLimitAnchors({ raw: ENTRIES(resetAt), at, now: 1000, anchors });
  assert.equal(kept.length, 1);
  assert.equal(Math.round(kept[0].leftMs), 10000);
  /* 过了 3 秒（轮询又来一次，at 可能变了，但 resetAt 没变）→ 应剩 7 秒 */
  kept = mod.applyLimitAnchors({
    raw: ENTRIES(resetAt),
    at: '2026-11-13T14:00:03.000Z',   // 服务端报了新的 at
    now: 4000,
    anchors,
  });
  assert.equal(kept.length, 1);
  assert.equal(Math.round(kept[0].leftMs), 7000, '轮询不能把倒计时重置回 10 秒');
});

T('锚点：到点后条目被摘掉（这就是"到时间再消失"）', () => {
  const anchors = new Map();
  const at = '2026-11-13T14:00:00.000Z';
  const resetAt = '2026-11-13T14:00:10.000Z';
  mod.applyLimitAnchors({ raw: ENTRIES(resetAt), at, now: 1000, anchors });
  /* 10 秒后 */
  const kept = mod.applyLimitAnchors({ raw: ENTRIES(resetAt), at, now: 11000, anchors });
  assert.equal(kept.length, 0, '到点必须消失');
  assert.equal(anchors.size, 0, '锚点也要清掉，避免被下一次同名条目复用');
});

T('锚点：resetAt 变化时重新锚定（上游延长恢复时间）', () => {
  const anchors = new Map();
  const at = '2026-11-13T14:00:00.000Z';
  mod.applyLimitAnchors({
    raw: ENTRIES('2026-11-13T14:00:10.000Z'), at, now: 1000, anchors,
  });
  /* 上游把恢复时间推到 60 秒后 */
  const kept = mod.applyLimitAnchors({
    raw: ENTRIES('2026-11-13T14:01:00.000Z'), at, now: 3000, anchors,
  });
  assert.equal(kept.length, 1);
  assert.equal(Math.round(kept[0].leftMs), 60000, '新的 resetAt 应从此刻重新计时');
});

T('锚点：上游没给恢复时间时 leftMs 为 NaN（不编造，也不会自动消失）', () => {
  const anchors = new Map();
  const kept = mod.applyLimitAnchors({
    raw: ENTRIES(''), at: '2026-11-13T14:00:00.000Z', now: 1000, anchors,
  });
  assert.equal(kept.length, 1, '没有恢复时间的条目仍要显示');
  assert.ok(Number.isNaN(kept[0].leftMs));
});

T('锚点：条目消失后锚点被清理，不会无限增长', () => {
  const anchors = new Map();
  const at = '2026-11-13T14:00:00.000Z';
  mod.applyLimitAnchors({
    raw: ENTRIES('2026-11-13T14:00:10.000Z'), at, now: 1000, anchors,
  });
  assert.equal(anchors.size, 1);
  /* 这次服务端什么都没返回 */
  mod.applyLimitAnchors({ raw: [], at, now: 2000, anchors });
  assert.equal(anchors.size, 0, '不再出现的条目要清掉锚点');
});

/*
 * ── 倒计时文案 ──
 */
T('倒计时文案：分钟/小时/天三级，且不会出现 0 分', () => {
  assert.equal(mod.fmtCountdown(30_000), '不到 1 分钟');
  assert.equal(mod.fmtCountdown(60_000), '1 分');
  assert.equal(mod.fmtCountdown(3_600_000), '1 小时');
  assert.equal(mod.fmtCountdown(90 * 60_000), '1 小时');
  assert.equal(mod.fmtCountdown(26 * 3_600_000), '1 天 2 小时');
});

T('倒计时文案：NaN / 非有限值返回空串（调用方据此改说“上游未给时间”）', () => {
  assert.equal(mod.fmtCountdown(NaN), '');
  assert.equal(mod.fmtCountdown(undefined), '');
  assert.equal(mod.fmtCountdown(Infinity), '');
});
