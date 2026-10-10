/**
 * Harness 契约用例：`openPage` 的**页面隔离**。
 *
 * ## 现场（这是 `npm run test:ui` 随机红的真凶，已实测复现）
 *
 * 串跑 21 个脚本时，`test-r6-detail` / `test-r7-safety` / `test-r10-charts`
 * 会**随机**失败，而且每次失败项都不同；单独跑这些脚本却 6/6 全过。
 *
 * 复现拿到的状态是 `{"second":2, "stale":1}` —— 新脚本接管了**上一张页面**，
 * 两轮的 `addScriptToEvaluateOnNewDocument` 叠加生效。因为 `openPage` 复用端口上的
 * 浏览器实例时，取的是「该端口上任意一张 page」，并且从不清理上一轮注册的注入。
 *
 * 后果分两种，都很难查：
 *   · 桩数据、localStorage、对话框处理器都是**上一轮的** —— 断言以脏状态开跑
 *     （实测：r7 的确认弹窗断言读到了 r6 的"确定重启桥服务？"）；
 *   · 两个脚本的注入脚本同时作用，`window.__X` 这类标记互相覆盖。
 *
 * 契约：**一次 openPage 对应一张干净的页面**（自己的 URL、只有自己的注入）。
 * 上一个脚本遗留的页面必须被关掉，不能被继承。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startStaticServer, openPage, q } from './ui-harness.mjs';

const PORT = 18813;
const CDP = 9353;

test('openPage：不得继承上一个脚本的页面与注入脚本（串跑随机红的真凶）', { timeout: 90_000 }, async () => {
  const srv = await startStaticServer(PORT);
  const url = `http://127.0.0.1:${PORT}/`;
  try {
    // 模拟"上一个脚本"：起了页面但**没有** close（脚本异常退出就是这样）
    const stale = await openPage(url, {}, { cdpPort: CDP, skipShapeCheck: true, inject: 'window.__STALE = 1;' });
    assert.equal(await q(stale.cdp, 'window.__STALE'), 1, '上一个脚本的页面应当就绪');

    const next = await openPage(`${url}?second=1`, {}, {
      cdpPort: CDP, skipShapeCheck: true, inject: 'window.__SECOND = 2;',
    });
    try {
      const seen = await q(next.cdp, '({ second: window.__SECOND || null, stale: window.__STALE || null, href: location.href })');
      assert.equal(
        seen.stale, null,
        `新脚本继承了上一个脚本的注入（__STALE=${seen.stale}）—— 两轮的桩/标记会同时生效，断言于是在脏状态下跑`,
      );
      assert.equal(seen.second, 2, '新脚本自己的注入没生效');
      assert.equal(seen.href, `${url}?second=1`, `新脚本被带到别的地址：${seen.href}`);
    } finally {
      next.close();
    }
    stale.close();
  } finally {
    srv.close();
  }
});
