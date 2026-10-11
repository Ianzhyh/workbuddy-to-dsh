/**
 * 给「客户端接入」面板截图（浅色 + 深色 + 窄屏）。
 *
 *   node tools/dev/shot-clients.mjs
 *
 * 不启真控制台、不消耗上游额度：静态服务 + 无头 Chromium，`/api/*` 全打桩。
 *
 * ── 两个必须显式处理的状态（否则截出来的图没有信息量） ──────────────────
 *
 * 1. **展开「手动接入」折叠区**。面板是「先选后展开」：一键接入常驻，
 *    三个接入值 + 客户端选择器 + 配置片段全在 `<details class="manualconnect">` 里，
 *    默认折叠。不展开的话 README 里那张图只有两行检测结果 + 大片空白，
 *    而 alt 文案描述的「选择器 + 配置片段」一个都看不见。
 *
 * 2. **固定强调色**。`data-accent` 不设时读的是**当前默认值**，而默认值会变
 *    （10-10 这轮从蓝改成陶土）。截图跟着漂移会让 README 里的整套图的色系
 *    对不上。这里显式钉死 `blue`，与 README 的其它配图统一。
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { startStaticServer, openPage, waitFor, q, sleep } from './ui-harness.mjs';
import { baseRoutes } from './fixtures.mjs';

const PORT = 8787;
const URL_ = `http://127.0.0.1:${PORT}/`;
const OUTDIR = join(process.cwd(), 'docs');

/**
 * 目录给足 30 个，而**精选集仍是 4 个** —— 与线上一致（`/api/clients` 只回精选，
 * 选择器列完整目录）。截图里会显示「已选 4 / 30」。
 *
 * 用默认夹具的话两边都是 4 个，会显示成「已选 4 / 4」—— 恰好是用户报过的那个
 * bug（选择器只列精选集）的样子，放进 README 会让人误以为还没修。
 */
const CATALOG_30 = Array.from({ length: 30 }, (_, i) => ({
  id: i < 4
    ? ['deepseek-v4.1-flash', 'glm-5.3', 'glm-5.3-flash', 'kimi-k3-1'][i]
    : `model-${String(i + 1).padStart(2, '0')}`,
  name: i < 4 ? ['DeepSeek-V4.1-Flash', 'GLM-5.3', 'GLM-5.3-Flash', 'Kimi-K3.1'][i] : `Model ${i + 1}`,
  context_window: 128000 + i * 1000,
  max_output_tokens: 8192 + i * 100,
  credits: 0.1 + i * 0.01,
}));

// 桩数据来自共享夹具（tools/dev/fixtures.mjs）—— 形状由 ui-harness 自动校验
const routes = baseRoutes({ catalog: CATALOG_30 });

const INJECT = '';

mkdirSync(OUTDIR, { recursive: true });
const server = await startStaticServer(PORT);
const { cdp, close } = await openPage(URL_, routes, { inject: INJECT, width: 1280, height: 1200 });

await q(cdp, `document.querySelector('.nav-tab[data-tab="clients"]').click()`);
await waitFor(cdp, `document.querySelectorAll('#clientsBox .clientpicker button').length >= 4`, 8000, '面板渲染');

/*
 * 展开折叠区，并用**默认选中项**（opencode）之外的判断确认内容真的在。
 * `details[open]` 是折叠状态的真值来源；只点 summary 不改 open 会静默失败
 * （面板每 20 秒重渲染一次，点击后可能被下一次渲染覆盖 → 又收回去）。
 */
const opened = await q(cdp, `(() => {
  const d = document.querySelector('#clientsBox details.manualconnect');
  if (!d) return 'no-details';
  d.open = true;
  d.dispatchEvent(new Event('toggle'));
  return d.open ? 'ok' : 'still-closed';
})()`);
if (opened !== 'ok') throw new Error(`手动接入折叠区展开失败：${opened}`);

// 折叠区展开后，配置片段才出现在 DOM 里 —— 等它渲染完再截，别截到半途
await waitFor(cdp, `!!document.querySelector('#clientsBox .manualbody .codeblock-body pre')`, 8000, '配置片段');
await sleep(400);

for (const [name, theme] of [['clients-panel-light.png', 'light'], ['clients-panel-dark.png', 'dark']]) {
  // 钉死强调色与主题：两个都显式设，截图才不随默认值漂移
  await q(cdp, `document.documentElement.setAttribute('data-theme', '${theme}');
               document.documentElement.setAttribute('data-accent', 'blue')`);
  await sleep(300);
  const res = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  const out = join(OUTDIR, name);
  writeFileSync(out, Buffer.from(res.result.data, 'base64'));
  console.log('wrote', out);
}

// 窄屏：四列会挤成一团，靠媒体查询折成「字段名 / 值+按钮 / 说明」三行
await q(cdp, `document.documentElement.setAttribute('data-theme', 'light');
             document.documentElement.setAttribute('data-accent', 'blue')`);
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 430, height: 1400, deviceScaleFactor: 1, mobile: false });
await sleep(400);
const narrow = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
writeFileSync(join(OUTDIR, 'clients-panel-narrow.png'), Buffer.from(narrow.result.data, 'base64'));
console.log('wrote', join(OUTDIR, 'clients-panel-narrow.png'));

close();
server.close();
