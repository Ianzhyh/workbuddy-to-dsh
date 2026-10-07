/**
 * 回归：模型选择器必须列出**完整目录**，且不依赖两个接口的返回顺序。
 *
 *   node tools/dev/test-model-picker-catalog.mjs
 *
 * ## 为什么必须有这条
 *
 * 选择器列的是完整目录（`/api/models`），而它与 `/api/clients` 是**并行请求**的，
 * 谁先回来不确定。clients 先回来时选择器只能用精选集兜底渲染 —— 而
 * `loadModels()` 当时不重渲染客户端面板，于是它**永远停在精选集**。
 *
 * 用户的原话：「明明我有三十个模型可以用，只出现三个」。页面看起来完全正常，
 * 没有任何报错 —— 只有断言能盯住。
 *
 * 两种顺序都要测：**目录先到**与**目录后到**。
 */
import { startStaticServer, openPage, q, sleep } from './ui-harness.mjs';
import { baseRoutes, CATALOG } from './fixtures.mjs';

const PORT = 8774;
const server = await startStaticServer(PORT);

// 造 30 个模型的目录；精选集仍是 3 个（模拟真实：/api/clients 只回精选）
const BIG = Array.from({ length: 30 }, (_, i) => ({
  id: `model-${String(i + 1).padStart(2, '0')}`,
  name: `Model ${i + 1}`,
  context_window: 128000, max_output_tokens: 8192, credits: 0.1,
}));

let failures = 0;

async function run(label, modelsDelayMs) {
  const routes = baseRoutes({ catalog: BIG });
  if (modelsDelayMs) routes['/api/models'] = { ...routes['/api/models'], delay: modelsDelayMs };
  const { cdp, close } = await openPage(`http://127.0.0.1:${PORT}/`, routes, { width: 1280, height: 900 });
  await sleep(2500);
  const r = await q(cdp, `(() => {
    const w = document.querySelector('#clientsBox .modelpick');
    if (!w) return { err: '没有选择器' };
    return {
      count: (w.querySelector('.modelpick-count') || {}).textContent || '',
      chips: [...w.querySelectorAll('.modelpick-chip')].map((c) => c.textContent.replace(/^✓\\s*/, '').trim()),
      catalogLoaded: Array.isArray(lastModels) ? lastModels.length : 0,
    };
  })()`);
  console.log(`[${label}] 目录 ${r.catalogLoaded} 个模型，选择器显示「${r.count}」`);
  console.log(`    芯片：${(r.chips || []).join(', ')}`);
  if (r.chips && r.chips.length === BIG.length) {
    console.log('    ✅ 列出完整目录');
  } else {
    failures += 1;
    console.error(`    ❌ 只有 ${(r.chips || []).length} 个，应为 ${BIG.length} 个`);
  }
  // 精选集默认勾选是刻意的（配置片段别太长），但**可选项**必须是全量
  if (r.count.includes('/ ' + BIG.length)) console.log('    ✅ 计数显示的是全量分母');
  else { failures += 1; console.error(`    ❌ 计数「${r.count}」的分母不是全量 ${BIG.length}`); }
  close();
  return r;
}

console.log('精选集（/api/clients 返回的）:', CATALOG.length, '个');
console.log('完整目录（/api/models 返回的）:', BIG.length, '个\n');

await run('目录先到（无延迟）', 0);
await run('目录后到（延迟 1200ms）', 1200);

server.close();
console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
