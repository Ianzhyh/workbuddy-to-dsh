/**
 * 面板渲染验证：把客户端半边（lib/client.js）放进一个最小外壳里真跑一遍。
 *
 * 为什么要单独搭这个外壳：客户端半边要由 dsh 的 Web 引导图加载，而引导图只在
 * 应用启动时组装、模块也会被 ESM 缓存住；改完代码后不重启 dsh 就看不到新面板。
 * 这个脚本用**真实抓取的数据**（跑不通时退回内置样例）在无头浏览器里渲染，
 * 于是「面板会不会崩 / 注册进哪个槽 / 数据对不对」这类问题不必重启应用就能验。
 *
 *   node dsh-plugin/tests/panel-render.mjs           # 内置样例数据（默认，安全）
 *   node dsh-plugin/tests/panel-render.mjs --live    # 抓运行中的真实数据
 *
 * 产物：`docs/plugin-panel*.png`（离线）或 `docs/_review/plugin-panel*.png`（--live）
 *
 * ## ⚠️ 默认必须是离线，且 --live 绝不写进 docs/
 *
 * 这些截图**会被提交进仓库**。`--live` 抓的是运行中的真实数据，里面有登录账号
 * （形如 `1df8ca6b-…` 的 UUID）、真实用量、真实路径 —— 曾经因为默认是 live，
 * 把用户的账号 UUID 直接写进了 `docs/plugin-panel.png` 并推到了 GitHub。
 *
 * 所以：默认离线；要真实数据得显式 `--live`，而且产物只落到 `.gitignore` 掉的
 * `docs/_review/`，人工确认用、不会被提交。
 */
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startStaticServer, openPage, waitFor, sleep } from '../../tools/dev/ui-harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const PLUGIN = join(HERE, '..');
const VENDOR = join(ROOT, '.tmp-research', 'vendor');
// 默认离线。真实数据必须显式要 —— 见文件头的说明（默认 live 曾把账号 UUID 写进仓库）
const offline = !process.argv.includes('--live');

/**
 * 产物目录：离线数据进 `docs/`（会被提交），真实数据进 `docs/_review/`（已 gitignore）。
 * 这样 `--live` 无论怎么跑都不可能把真实账号写进仓库。
 */
const OUT_DIR = offline ? join(ROOT, 'docs') : join(ROOT, 'docs', '_review');
const OUT = join(OUT_DIR, 'plugin-panel.png');
const PORT = 8810; // 与控制台用例（8774~8798）分开，避免同时跑时抢端口
const LIVE = 'http://127.0.0.1:19387';

// 桩数据与渲染骨架在 _panel-fixtures.mjs 里，与 panel-i18n.test.mjs 共用一份
import { FIXTURES, buildRoutes, ensureVendor, harnessHtml, gather } from './_panel-fixtures.mjs';

const now = Date.now(); // 本文件自己的路由覆盖里要用（FIXTURES 那份在 _panel-fixtures.mjs）
/** 断言 + 截图。 */
async function inspect(cdp) {
  const harness = await cdp.evaluate('JSON.stringify(window.__harness)');
  const errors = await cdp.evaluate('JSON.stringify(window.__errors)');
  const calls = await cdp.evaluate('JSON.stringify(window.__calls || [])');
  const cards = await cdp.evaluate("document.querySelectorAll('.wb-card').length");
  const link = await cdp.evaluate("(() => { const a=document.querySelector('a.wb-btn[href]'); return a ? a.getAttribute('href') : ''; })()");
  const frames = await cdp.evaluate("JSON.stringify([...document.querySelectorAll('iframe.wb-frame')].map(f => f.getAttribute('src')))");
  const text = await cdp.evaluate("document.querySelector('.wb-root') ? document.querySelector('.wb-root').innerText : ''");
  return {
    harness: JSON.parse(harness || '{}'),
    errors: JSON.parse(errors || '[]'),
    calls: JSON.parse(calls || '[]'),
    cards,
    link,
    frames: JSON.parse(frames || '[]'),
    text,
  };
}

const { data, source, liveStatus } = await gather({ offline });
const { react, reactDom } = await ensureVendor();
const clientSource = readFileSync(join(PLUGIN, 'lib', 'client.js'), 'utf8');

// 路由桩在 _panel-fixtures.mjs 里，与 panel-i18n.test.mjs 共用一份
const routes = buildRoutes(data);

const server = await startStaticServer(PORT);
const extra = createServer((req, res) => {
  const path = new URL(req.url, `http://127.0.0.1:${PORT}`).pathname;
  if (path === '/harness.html') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(harnessHtml(routes)); }
  if (path === '/client.js') { res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }); return res.end(clientSource); }
  if (path === '/vendor/react.js') { res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }); return res.end(react); }
  if (path === '/vendor/react-dom.js') { res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }); return res.end(reactDom); }
  res.writeHead(404); res.end('not found');
});
await new Promise((resolve) => extra.listen(PORT + 1, '127.0.0.1', resolve));
// startStaticServer 已经占了 PORT；这里让 /harness.html 走它自己的壳不方便，
// 因此直接把 harness 页面挂到 extra 上，导航时用 PORT+1。
// injectStub:false —— 打桩改由外壳页面自己做（见 harnessHtml）。CDP 的注入会连
// iframe 一起打桩，内嵌的真控制台就再也拿不到自己的 /api/*。
const page = await openPage(`http://127.0.0.1:${PORT + 1}/harness.html`, {}, { width: 900, height: 1400, injectStub: false });

let failed = false;
try {
  await waitFor(page.cdp, 'window.__harness && window.__harness.rendered === true', 15000, '面板挂载');
  await waitFor(page.cdp, "document.querySelectorAll('.wb-card').length >= 2", 15000, '卡片渲染');
  await sleep(600); // 等首次 fetch 回来
  const result = await inspect(page.cdp);

  console.log(`数据来源：${source}`);
  console.log(`bundle id：${result.harness.bundleId}  导出名：${result.harness.exportsName}  apply：${result.harness.hasApply}`);
  console.log(`槽注册：${JSON.stringify(result.harness.registrations)}`);
  console.log(`卡片数：${result.cards}  新标签链接：${result.link}`);
  console.log(`内嵌 iframe：${JSON.stringify(result.frames)}`);
  console.log(`页面错误：${result.errors.length ? result.errors.join(' | ') : '无'}`);

  const problems = [];
  if (result.harness.bundleId !== 'dsh-plugin-workbuddy') problems.push(`bundle id 不对：${result.harness.bundleId}`);
  if (result.harness.hasApply !== true) problems.push('没有导出 apply');
  if (!Array.isArray(result.harness.moduleInject) || !result.harness.moduleInject.includes('slots')) {
    problems.push(`模块级 inject 导出必须包含 slots（现在是 ${JSON.stringify(result.harness.moduleInject)}）`);
  }
  if (result.harness.injectSlot !== 'settings.section') problems.push(`没有先 slots.inject('settings.section')（实际 ${result.harness.injectSlot}）`);
  const reg = (result.harness.registrations || [])[0] || {};
  if (reg.name !== 'settings.section') problems.push(`注册项的槽位键必须是 name='settings.section'（实际 ${reg.name}）`);
  if (reg.id !== 'workbuddy') problems.push(`注册的 id 不对：${reg.id}`);
  if (result.harness.applyError) problems.push(`apply 抛错：${result.harness.applyError}`);
  if (result.errors.length) problems.push(`页面有错误：${result.errors.join(' | ')}`);

  // 逐个标签页走一遍：每个面板都要真的渲染出内容（不是只挂个空壳）
  const EXPECT = {
    概览: ['本地桥', 'dsh 原生路由', '积分余额', '启动桥', '复制诊断报告'],
    账号: ['workbuddy-desktop.info', '330000000000', '使用中', '切换', 'CodeBuddyExtension'],
    用量: ['消耗积分', '积分花在哪些模型上', '导出 CSV', 'deepseek-v4.1-flash'],
    请求: ['最近请求', '仅看失败', '导出当前筛选 CSV'],
    签到: ['每日签到', '连续天数', '自动签到', '上次尝试'],
    诊断: ['环境诊断', 'AtRest 密钥', '登录文件', 'profile bundles', '运行时注册，无需 settings.yaml'],
    模型: ['可用模型', '全部体检', '清除体检结论', '可用 · 1180ms'],
    对话测试: ['对话测试', '清空对话', '会消耗你账号的额度'],
    日志: ['桥日志', '只看错误', '只看本次启动'],
  };
  const tabs = await page.cdp.evaluate("JSON.stringify([...document.querySelectorAll('.wb-tab')].map(b => b.textContent))");
  const tabList = JSON.parse(tabs || '[]');
  for (const label of Object.keys(EXPECT)) {
    if (!tabList.includes(label)) { problems.push(`缺少标签页「${label}」`); continue; }
    await page.cdp.evaluate(`(() => { const b=[...document.querySelectorAll('.wb-tab')].find(x=>x.textContent===${JSON.stringify(label)}); if(b) b.click(); return !!b; })()`);
    await sleep(650);
    const text = await page.cdp.evaluate("document.querySelector('.wb-root') ? document.querySelector('.wb-root').innerText : ''");
    for (const needle of EXPECT[label]) {
      if (!text.includes(needle)) problems.push(`「${label}」页缺少「${needle}」`);
    }
    // 诊断页专断：旧口径的 fail 必须被运行时事实改判为 ok，且不再显示旧建议
    if (label === '诊断') {
      if (/尚未配置 workbuddy 路由/.test(text)) problems.push('诊断页仍显示迁移前口径的误报（fail）');
      if (/勾选后保存/.test(text)) problems.push('诊断页仍显示旧口径的过时建议');
    }
    // 日志页专断：必须渲染出**真实的日志正文**（而不是空壳）。
    // 不用具体字符串断言 —— 桥连续运行久了，启动横幅会滚出最后 N 行，
    // 按内容断言会随运行时长误报；这里按"有无日志行"判断。
    if (label === '日志') {
      const logBody = await page.cdp.evaluate(`(() => { const pre=document.querySelector('.wb-log'); return pre ? pre.innerText : ''; })()`);
      if (!logBody || /没有匹配的日志行/.test(logBody)) {
        problems.push(`日志页没有渲染出日志正文（${logBody ? logBody.slice(0, 40) : '空的 wb-log'}）`);
      } else if (!/[\d:]{4,}|→|listening/.test(logBody)) {
        problems.push('日志页的正文看起来不是日志行');
      }
    }
    // 请求页专断：它被故意造成「首帧 404」（模拟刷新时宿主还没挂路由），
    // 面板必须自己重试恢复 —— 不许把 HTTP 404 挂在那儿。给它最多 4 秒。
    if (label === '请求') {
      let recovered = false;
      let last = '';
      for (let i = 0; i < 10 && !recovered; i += 1) {
        await sleep(400);
        const state = await page.cdp.evaluate(`(() => ({
          text: document.querySelector('.wb-root') ? document.querySelector('.wb-root').innerText : '',
          rows: document.querySelectorAll('.wb-table tbody tr').length,
        }))()`);
        last = state.text;
        if (state.rows > 0 && !/HTTP 404|插件还没就绪/.test(state.text)) recovered = true;
      }
      if (!recovered) {
        problems.push(`请求页没有从首帧 404 恢复（${/插件还没就绪/.test(last) ? '仍显示"插件还没就绪"' : /HTTP 404/.test(last) ? '仍显示 HTTP 404' : '没有渲染出请求行'}）`);
      } else if (/HTTP 404/.test(last)) {
        problems.push('请求页把首帧 404 当成终态显示（应当自动重试）');
      }
    }
    // 溢出检查（每个标签页都做）：.wb-root 的内容横向超出视口 = 溢出回归
    const overflow = await page.cdp.evaluate(`(() => {
      const root = document.querySelector('.wb-root');
      if (!root) return null;
      const doc = document.documentElement;
      const pageOverflow = doc.scrollWidth - doc.clientWidth;
      let widest = '';
      for (const el of root.querySelectorAll('*')) {
        const over = el.scrollWidth - el.clientWidth;
        if (over > 2 && el.clientWidth > 0) {
          if (!widest || over > widest.over) widest = { over, tag: el.tagName, cls: String(el.className).slice(0, 40) };
        }
      }
      return { pageOverflow, widest };
    })()`);
    if (overflow && overflow.pageOverflow > 2) {
      problems.push(`「${label}」页横向溢出 ${overflow.pageOverflow}px${overflow.widest ? `（最宽：${overflow.widest.cls || overflow.widest.tag}，超出 ${overflow.widest.over}px）` : ''}`);
    }
    // 邻列重叠检查（每个标签页的每张表）：单元格盒子互相压住 = 布局崩了。
    // 这正是"账号页 7 列被均分挤压 + 胶囊压住邻居"那张截图的机器可判定形式。
    const tableIssues = await page.cdp.evaluate(`(() => {
      const bad = [];
      for (const table of document.querySelectorAll('.wb-table')) {
        const card = table.closest('.wb-card');
        const title = (card && card.querySelector('h3') ? card.querySelector('h3').textContent : '(无标题表)');
        for (const row of table.querySelectorAll('tr')) {
          const cells = [...row.children];
          for (let i = 1; i < cells.length; i += 1) {
            const prev = cells[i - 1].getBoundingClientRect();
            const cur = cells[i].getBoundingClientRect();
            if (cur.width === 0) continue;
            if (cur.left < prev.right - 1) {
              bad.push(title + '：第 ' + (i + 1) + ' 列压住第 ' + i + ' 列（重叠 ' + Math.round(prev.right - cur.left) + 'px）');
            }
          }
          for (const cell of cells) {
            const text = (cell.textContent || '').trim();
            if (cell.scrollWidth > cell.clientWidth + 2 && cell.clientWidth > 0) {
              bad.push(title + '：单元格内容宽于格子（' + text.slice(0, 14) + ' 超出 ' + (cell.scrollWidth - cell.clientWidth) + 'px）');
            }
            // 逐字折行：单元格被压到很窄却还有不少字
            const box = cell.getBoundingClientRect();
            if (text.length >= 6 && box.width > 0 && box.width < 34) {
              bad.push(title + '：单元格被压到 ' + Math.round(box.width) + 'px（内容 ' + text.slice(0, 12) + '）');
            }
          }
        }
      }
      return [...new Set(bad)].slice(0, 4);
    })()`);
    if (tableIssues && tableIssues.length) {
      for (const item of tableIssues) problems.push(`「${label}」页表格布局异常：${item}`);
    }
  }
  console.log(`标签页：${tabList.join(' / ')}`);

  // 用量页要有真的图表（内联 SVG），模型页要有表格行；再各截一页做人工确认
  await page.cdp.evaluate(`(() => { const b=[...document.querySelectorAll('.wb-tab')].find(x=>x.textContent==='用量'); b && b.click(); })()`);
  await sleep(500);
  const svgCount = await page.cdp.evaluate("document.querySelectorAll('.wb-root svg').length");
  if (!svgCount) problems.push('用量页没有渲染趋势图（内联 SVG）');
  let shot = await page.cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  writeFileSync(join(OUT_DIR, 'plugin-panel-usage.png'), Buffer.from(shot.result.data, 'base64'));
  await page.cdp.evaluate(`(() => { const b=[...document.querySelectorAll('.wb-tab')].find(x=>x.textContent==='模型'); b && b.click(); })()`);
  await sleep(500);
  const modelRows = await page.cdp.evaluate("document.querySelectorAll('.wb-table tbody tr').length");
  if (modelRows < 4) problems.push(`模型页表格行太少：${modelRows}`);
  await page.cdp.evaluate(`(() => { const b=[...document.querySelectorAll('.wb-tab')].find(x=>x.textContent==='诊断'); b && b.click(); })()`);
  await sleep(500);
  shot = await page.cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  writeFileSync(join(OUT_DIR, 'plugin-panel-diagnose.png'), Buffer.from(shot.result.data, 'base64'));
  await page.cdp.evaluate(`(() => { const b=[...document.querySelectorAll('.wb-tab')].find(x=>x.textContent==='对话测试'); b && b.click(); })()`);
  await sleep(500);
  const taWidth = await page.cdp.evaluate(`(() => { const t=document.querySelector('.wb-textarea'); const card=t ? t.closest('.wb-card') : null; return { tw: t ? t.offsetWidth : 0, cw: card ? card.clientWidth : 0 }; })()`);
  if (!(taWidth.tw > 0 && taWidth.tw <= taWidth.cw)) problems.push(`对话输入框超出卡片（textarea=${taWidth.tw}px > card=${taWidth.cw}px）`);

  // 真跑一轮对话：往输入框塞字、触发 Enter（走 React 的 onChange 链），
  // 断言流式回答渲染出来、且逐轮元数据（耗时/tokens/扣分）贴在回答下方。
  const chatRun = await page.cdp.evaluate(`(async () => {
    const ta = document.querySelector('.wb-textarea');
    if (!ta) return { error: '找不到输入框' };
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, '说一句话');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 150));
    const sendBtn = [...document.querySelectorAll('.wb-btn')].find((b) => b.textContent === '发送');
    if (!sendBtn) return { error: '找不到发送按钮' };
    sendBtn.click();
    await new Promise((r) => setTimeout(r, 900));
    const bubbles = [...document.querySelectorAll('.wb-msg')].map((el) => el.innerText);
    const metas = [...document.querySelectorAll('.wb-msg-meta')].map((el) => el.innerText);
    return { bubbles, metas, calls: window.__calls.filter((c) => String(c[0]).includes('/chat')).length };
  })()`);
  if (chatRun.error) problems.push(`对话测试无法运行：${chatRun.error}`);
  else {
    const joined = (chatRun.bubbles || []).join(' | ');
    if (!joined.includes('桥已接通。')) problems.push(`流式回答没渲染出来（实际：${joined.slice(0, 120)}）`);
    if (!joined.includes('说一句话')) problems.push('用户消息没渲染');
    if (!chatRun.metas.length) problems.push('回答下方没有逐轮元数据（耗时/tokens/扣分）');
    else if (!/tokens 12 → 5/.test(chatRun.metas[0]) || !/扣分 0.004/.test(chatRun.metas[0])) {
      problems.push(`逐轮元数据不对：${chatRun.metas[0]}`);
    }
    if (!chatRun.calls) problems.push('对话没有发出 POST /workbuddy/console-api/chat');
    console.log(`对话测试：${chatRun.metas[0] || '(无元数据)'}`);
  }
  await page.cdp.evaluate(`(() => { const b=[...document.querySelectorAll('.wb-btn')].find(x=>x.textContent==='清空对话'); b && b.click(); })()`);
  await sleep(300);

  // 模型可选性：下拉必须有多个选项，且能真的改（改完切标签页回来仍然保留）
  const chatSelect = await page.cdp.evaluate(`(() => {
    const sels = [...document.querySelectorAll('select.wb-select')];
    const sel = sels.find((s) => [...s.options].some((o) => /flash|glm|kimi|hy/i.test(o.value))) || sels[0];
    if (!sel) return null;
    const before = sel.value;
    const target = [...sel.options].map((o) => o.value).find((v) => v && v !== before);
    sel.value = target;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    window.__chatTarget = target;
    return { count: sel.options.length, before, target };
  })()`);
  if (!chatSelect) problems.push('对话测试页找不到模型下拉框');
  else {
    if (chatSelect.count < 5) problems.push(`对话测试模型下拉只有 ${chatSelect.count} 个选项（应当跟目录一致）`);
    await sleep(400);
    const valueAfter = await page.cdp.evaluate(`(() => { const sel=[...document.querySelectorAll('select.wb-select')].find((s)=>[...s.options].some((o)=>o.value===window.__chatTarget)); return sel ? sel.value : ''; })()`);
    if (valueAfter !== chatSelect.target) problems.push(`选了模型却没生效（期望 ${chatSelect.target}，实际 ${valueAfter}）`);
    // 切走再回来，选择应当保留（容器持有状态）
    await page.cdp.evaluate(`(() => { const b=[...document.querySelectorAll('.wb-tab')].find(x=>x.textContent==='概览'); b && b.click(); })()`);
    await sleep(300);
    await page.cdp.evaluate(`(() => { const b=[...document.querySelectorAll('.wb-tab')].find(x=>x.textContent==='对话测试'); b && b.click(); })()`);
    await sleep(400);
    const valueAfterRoundTrip = await page.cdp.evaluate(`(() => { const sel=[...document.querySelectorAll('select.wb-select')].find((s)=>[...s.options].some((o)=>o.value===window.__chatTarget)); return sel ? sel.value : ''; })()`);
    if (valueAfterRoundTrip !== chatSelect.target) problems.push(`切标签页后模型选择被重置（期望 ${chatSelect.target}，实际 ${valueAfterRoundTrip}）`);
    console.log(`对话模型下拉：${chatSelect.count} 个选项，选择 ${chatSelect.target} 生效并保持`);
  }
  shot = await page.cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  writeFileSync(join(OUT_DIR, 'plugin-panel-chat.png'), Buffer.from(shot.result.data, 'base64'));

  // 交互：概览页「启动控制台」必须真的发出带面板头的 POST
  await page.cdp.evaluate(`(() => { const b=[...document.querySelectorAll('.wb-tab')].find(x=>x.textContent==='概览'); b && b.click(); })()`);
  await sleep(400);
  await page.cdp.evaluate(`(() => { const b=[...document.querySelectorAll('.wb-btn')].find(x=>x.textContent.includes('启动控制台')); if(b) b.click(); return !!b; })()`);
  await sleep(800);
  const after = await inspect(page.cdp);
  if (!after.calls.find((c) => String(c[0]).includes('/workbuddy/console') && c[1] === 'POST')) {
    problems.push('点击「启动控制台」没有发出 POST /workbuddy/console');
  }
  if (after.text.includes('启动失败')) problems.push('控制台启动返回被当成失败');
  console.log(`交互后的请求数：${after.calls.length}`);

  // 积分卡：概览页的头条指标 —— 单独一张卡、大号数字、套餐进度、"刷新积分"发 POST
  const quotaCard = await page.cdp.evaluate(`(() => {
    const card = document.querySelector('.wb-quota');
    if (!card) return null;
    const totalEl = card.querySelector('.wb-quota-total');
    const totalBox = totalEl ? totalEl.getBoundingClientRect() : null;
    const barCount = card.querySelectorAll('.wb-bar i').length;
    const pkgNames = [...card.querySelectorAll('.wb-quota-pkg-name')].map((el) => el.textContent);
    return {
      text: card.innerText,
      totalFontSize: totalEl ? parseFloat(getComputedStyle(totalEl).fontSize) : 0,
      totalWidth: totalBox ? Math.round(totalBox.width) : 0,
      bars: barCount,
      packages: pkgNames.length,
      merged: pkgNames.some((n) => /×\\d+/.test(n)),
    };
  })()`);
  if (!quotaCard) problems.push('概览页没有独立的积分卡');
  else {
    if (!/积分余额/.test(quotaCard.text)) problems.push('积分卡没写「积分余额」');
    if (quotaCard.totalFontSize < 26) problems.push(`积分数字不够"大"（${quotaCard.totalFontSize}px，期望 ≥26px）`);
    if (!quotaCard.packages) problems.push('积分卡没有列出套餐');
    if (quotaCard.bars !== quotaCard.packages) problems.push(`套餐进度条数量（${quotaCard.bars}）与套餐数（${quotaCard.packages}）不一致`);
    console.log(`积分卡：数字 ${quotaCard.totalFontSize}px，${quotaCard.packages} 种套餐，${quotaCard.bars} 条进度条${quotaCard.merged ? '（同名套餐已合并）' : ''}`);
  }
  const beforeQuota = await inspect(page.cdp);
  await page.cdp.evaluate(`(() => { const b=[...document.querySelectorAll('.wb-btn')].find(x=>x.textContent.includes('刷新积分')); if(b) b.click(); return !!b; })()`);
  await sleep(900);
  const afterQuota = await inspect(page.cdp);
  if (!afterQuota.calls.find((c) => String(c[0]).includes('/workbuddy/quota') && c[1] === 'POST')) {
    problems.push('点「刷新积分」没有发出 POST /workbuddy/quota');
  }
  const quotaMsg = await page.cdp.evaluate(`(() => { const c=document.querySelector('.wb-quota'); return c ? c.innerText : ''; })()`);
  if (!/已刷新|刷新失败/.test(quotaMsg)) problems.push('刷新积分后没有给出结果提示');
  console.log(`积分刷新：POST /workbuddy/quota → ${/已刷新/.test(quotaMsg) ? '成功提示' : /旧构建/.test(quotaMsg) ? '旧构建降级提示' : /刷新失败/.test(quotaMsg) ? '失败提示' : '（无提示）'}`);

  // 破坏性操作必须二次确认，且确认后才真的发请求：
  //   清空账本（用量）/ 清空日志（日志）/ 清除体检结论（模型）
  await page.cdp.evaluate("window.__dialogs = []; window.__confirmAnswer = false;");
  await page.cdp.evaluate(`(() => { const b=[...document.querySelectorAll('.wb-tab')].find(x=>x.textContent==='用量'); b && b.click(); })()`);
  await sleep(500);
  const beforeClear = await inspect(page.cdp);
  await page.cdp.evaluate(`(() => { const b=[...document.querySelectorAll('.wb-btn')].find(x=>x.textContent.includes('清空账本')); b && b.click(); })()`);
  await sleep(400);
  const declined = await page.cdp.evaluate("JSON.stringify(window.__dialogs)");
  const declinedDialogs = JSON.parse(declined || '[]');
  if (!declinedDialogs.length) problems.push('「清空账本」没有二次确认');
  const afterDecline = await inspect(page.cdp);
  if (afterDecline.calls.length !== beforeClear.calls.length) problems.push('在确认框里点了「取消」，却仍然发出了请求');
  // 这次点「确定」，应当真的发出 DELETE
  await page.cdp.evaluate("window.__confirmAnswer = true;");
  await page.cdp.evaluate(`(() => { const b=[...document.querySelectorAll('.wb-btn')].find(x=>x.textContent.includes('清空账本')); b && b.click(); })()`);
  await sleep(600);
  const afterAccept = await inspect(page.cdp);
  if (!afterAccept.calls.find((c) => String(c[0]).includes('/workbuddy/usage') && c[1] === 'DELETE')) {
    problems.push('确认后没有发出 DELETE /workbuddy/usage');
  }
  console.log(`二次确认：取消时不发请求，确认后发 DELETE（确认框文案：${(declinedDialogs[0] || '').split('\n')[0]}）`);

  // 概览页的待办提醒：这里 status.checkin 说"今日未签到"、请求里有失败 → 两条都要出现
  await page.cdp.evaluate(`(() => { const b=[...document.querySelectorAll('.wb-tab')].find(x=>x.textContent==='概览'); b && b.click(); })()`);
  await sleep(600);
  const overviewText = await page.cdp.evaluate("document.querySelector('.wb-root') ? document.querySelector('.wb-root').innerText : ''");
  if (!/今日还没签到/.test(overviewText)) problems.push('概览没有提示「今日还没签到」');
  // 失败提醒的期望取决于数据源：离线/旧宿主模式（桩覆盖 requests 通道）必须出现；
  // 实时模式走真宿主快照的 recentFailed（真实账本），没有失败就没有提醒 —— 正确行为。
  // 失败提醒的期望取决于数据源：离线/旧宿主模式（桩覆盖 requests 通道）必须出现；
  // 实时模式走真宿主快照的 recentFailed（真实账本），没有失败就没有提醒 —— 正确行为。
  const failedRecentExpectation = offline
    ? 'present'
    : (Array.isArray(liveStatus?.recentFailed) && liveStatus.recentFailed.length ? 'present' : 'conditional');
  // 「最近失败请求」提醒**不能**在这里无条件断言：概览的失败数据有两条来源 ——
  //   新宿主走快照 status.recentFailed（来自真实账本），旧宿主才回落拉
  //   /workbuddy/requests（桩里注入的 syntheticFailure 只覆盖这一条路）。
  // 本场景跑的是真宿主 + 实时账本：若最近 20 条恰好没有失败，提醒**本就不该出现**
  // —— 那是正确行为，不是缺陷（曾经因此误报失败，把桩打在了已不再使用的通道上）。
  // 断言改为：有失败数据时必须出现提醒；并单独验证桩覆盖的 fallback 路径
  // （旧宿主场景 2 里 requests 面板用的是同一套桩数据）。
  if (failedRecentExpectation === 'present' && !/条失败|失败请求/.test(overviewText)) {
    problems.push('概览没有提示最近有失败请求');
  }
  if (/重新诊断/.test(overviewText)) problems.push('概览还留着一个点了不动的「重新诊断」按钮（应改成刷新状态 + 去诊断）');

  // 请求页的模型筛选必须来自完整目录（不是只列当前页出现过的模型）
  await page.cdp.evaluate(`(() => { const b=[...document.querySelectorAll('.wb-tab')].find(x=>x.textContent==='请求'); b && b.click(); })()`);
  await sleep(900);
  const filterOptions = await page.cdp.evaluate(`(() => {
    const sel = [...document.querySelectorAll('select.wb-select')].find((s) => /全部模型/.test(s.options[0] ? s.options[0].textContent : ''));
    return sel ? sel.options.length : 0;
  })()`);
  if (filterOptions < 5) problems.push(`请求页模型筛选只有 ${filterOptions} 项（应来自完整目录）`);
  else console.log(`请求页模型筛选：${filterOptions} 项`);

  // 账号页落一张图：7 列的数据表最容易出"挤在一起/胶囊压邻居"，值得人工看
  await page.cdp.evaluate(`(() => { const b=[...document.querySelectorAll('.wb-tab')].find(x=>x.textContent==='账号'); b && b.click(); })()`);
  await sleep(700);
  shot = await page.cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  writeFileSync(join(OUT_DIR, 'plugin-panel-accounts.png'), Buffer.from(shot.result.data, 'base64'));

  // 模型页的可用性筛选（全部 / 只看不可用 / 只看未测）
  await page.cdp.evaluate(`(() => { const b=[...document.querySelectorAll('.wb-tab')].find(x=>x.textContent==='模型'); b && b.click(); })()`);
  await sleep(700);
  const probeFilter = await page.cdp.evaluate(`(() => {
    const sel = [...document.querySelectorAll('select.wb-select')].find((s) => [...s.options].some((o) => /只看不可用/.test(o.textContent)));
    if (!sel) return null;
    const rowsBefore = document.querySelectorAll('.wb-table tbody tr').length;
    sel.value = [...sel.options].find((o) => /只看未测/.test(o.textContent)).value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return { rowsBefore, options: sel.options.length };
  })()`);
  if (!probeFilter || probeFilter.options < 3) problems.push('模型页没有可用性筛选项');

  // "太紧凑"的机器判据：模型表在标准宽度下**不该需要横向滚动**，
  // 操作列的按钮也不该竖着堆（那正是上一版被挤扁的样子）
  const modelFit = await page.cdp.evaluate(`(() => {
    const table = document.querySelector('.wb-table');
    if (!table) return null;
    const wrap = table.closest('.wb-scroll') || table.parentElement;
    const rows = [...table.querySelectorAll('tbody tr')].filter((r) => !r.classList.contains('wb-detail-row'));
    let stacked = 0;
    let tallest = 0;
    for (const row of rows) {
      const cell = row.querySelector('td.wb-actions-col');
      if (!cell) continue;
      const btns = [...cell.querySelectorAll('.wb-btn')];
      if (btns.length > 1 && new Set(btns.map((b) => Math.round(b.getBoundingClientRect().top))).size > 1) stacked += 1;
      tallest = Math.max(tallest, Math.round(row.getBoundingClientRect().height));
    }
    return { tableWidth: Math.round(table.getBoundingClientRect().width), wrapClient: wrap.clientWidth, wrapScroll: wrap.scrollWidth, rows: rows.length, stacked, tallest };
  })()`);
  if (!modelFit) problems.push('模型页找不到表格');
  else {
    if (modelFit.wrapScroll > modelFit.wrapClient + 2) {
      problems.push(`模型表在标准宽度下需要横向滚动（表 ${modelFit.wrapScroll}px > 容器 ${modelFit.wrapClient}px）`);
    }
    if (modelFit.stacked) problems.push(`模型表有 ${modelFit.stacked} 行的按钮竖着堆（列被挤窄了）`);
    if (modelFit.tallest > 80) problems.push(`模型表行高异常（最高 ${modelFit.tallest}px，说明内容被挤压）`);
    console.log(`模型表：${modelFit.rows} 行，宽 ${modelFit.tableWidth}px / 容器 ${modelFit.wrapClient}px，最高行 ${modelFit.tallest}px；无横向滚动、按钮不堆叠`);
  }

  // 模型详情必须**紧跟被点的那一行**展开（不是挂到整张表下面）
  const detailTarget = await page.cdp.evaluate(`(() => {
    const rows = [...document.querySelectorAll('.wb-table tbody tr')];
    const row = rows.find((r) => [...r.querySelectorAll('.wb-btn')].some((b) => /详情|ⓘ/.test(b.textContent)));
    if (!row) return null;
    const id = (row.children[0].textContent || '').replace(' ★', '').trim();
    const btn = [...row.querySelectorAll('.wb-btn')].find((b) => /详情|ⓘ/.test(b.textContent));
    btn.click();
    return { id };
  })()`);
  if (!detailTarget) problems.push('模型表里找不到「详情」按钮');
  else {
    await sleep(600);
    const inline = await page.cdp.evaluate(`(() => {
      const rows = [...document.querySelectorAll('.wb-table tbody tr')];
      const idx = rows.findIndex((r) => r.classList.contains('wb-detail-row'));
      if (idx < 0) return { found: false };
      const prev = rows[idx - 1];
      const box = rows[idx].querySelector('.wb-detail');
      return {
        found: true,
        prevId: prev ? (prev.children[0].textContent || '').replace(' ★', '').trim() : null,
        isLast: idx === rows.length - 1,
        text: box ? box.innerText : '',
        width: box ? Math.round(box.getBoundingClientRect().width) : 0,
      };
    })()`);
    if (!inline.found) problems.push('点「详情」没有展开任何内容');
    else {
      if (inline.prevId !== detailTarget.id) {
        problems.push(`详情没有紧跟被点的模型行（点了 ${detailTarget.id}，详情却在 ${inline.prevId} 下面）`);
      }
      for (const needle of ['模型 ID', '上下文 / 输出', '多模态', '计费倍率']) {
        if (!inline.text.includes(needle)) problems.push(`模型详情缺少「${needle}」`);
      }
      if (inline.width < 200) problems.push(`模型详情宽度异常（${inline.width}px）`);
      console.log(`模型详情：点 ${detailTarget.id} → 紧跟其下展开（${inline.width}px 宽${inline.isLast ? '，位于表尾' : ''}）`);
      // 留一张"详情紧跟行"的证据图
      const detailShot = await page.cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      writeFileSync(join(OUT_DIR, 'plugin-panel-models-detail.png'), Buffer.from(detailShot.result.data, 'base64'));
    }
    // 样式：上游促销徽章要渲染成带色小标记，且 tags 里不许再出现 badge: 原始规格
    const badgeState = await page.cdp.evaluate(`(() => {
      const table = document.querySelector('.wb-table');
      const badges = [...document.querySelectorAll('.wb-badge')];
      const raw = document.body.innerText.includes('badge:');
      return { count: badges.length, sample: badges[0] ? badges[0].textContent : '', hasRawSpec: raw };
    })()`);
    if (badgeState.hasRawSpec) problems.push('模型列表里出现了 badge: 原始规格（应当已结构化成徽章）');
    if (!badgeState.count) problems.push('模型列表没有渲染促销徽章');
    else console.log(`模型徽章：${badgeState.count} 个（例：${badgeState.sample}）`);
    // 多模态标记必须是看得懂的文字，不许再用 🖼 这类字符
    const imageMark = await page.cdp.evaluate(`(() => {
      const table = document.querySelector('.wb-table');
      const text = table ? table.innerText : '';
      const tags = [...(table ? table.querySelectorAll('.wb-badge') : [])].map((el) => el.textContent);
      return { hasEmoji: /[\\u{1F300}-\\u{1FAFF}\\u{1F5BC}]/u.test(text), imageTags: tags.filter((t) => t === '图片').length, summary: /个支持图片输入/.test(document.body.innerText) };
    })()`);
    if (imageMark.hasEmoji) problems.push('模型列表里还有 emoji 字符（🖼 这类看不懂的标记应当换成文字）');
    if (!imageMark.summary) problems.push('模型页没有说明有多少模型支持图片');
    console.log(`多模态标记：「图片」文字标记 ${imageMark.imageTags} 个，统计行已给出`);
    // 详情里的「用这个模型对话 →」应当切到对话测试并选中该模型
    await page.cdp.evaluate(`(() => { const b=[...document.querySelectorAll('.wb-btn')].find(x=>x.textContent.includes('用这个模型对话')); if(b) b.click(); return !!b; })()`);
    await sleep(600);
    const chatState = await page.cdp.evaluate(`(() => {
      const active = [...document.querySelectorAll('.wb-tab')].find((t) => t.classList.contains('on'));
      const sel = [...document.querySelectorAll('select.wb-select')].find((s) => [...s.options].some((o) => o.value === ${JSON.stringify(detailTarget.id)}));
      return { tab: active ? active.textContent : '', model: sel ? sel.value : '' };
    })()`);
    if (chatState.tab !== '对话测试') problems.push(`「用这个模型对话」没有切到对话测试（当前 ${chatState.tab}）`);
    if (chatState.model !== detailTarget.id) problems.push(`「用这个模型对话」没有选中 ${detailTarget.id}（实际 ${chatState.model}）`);
  }
  await page.cdp.evaluate(`(() => { const b=[...document.querySelectorAll('.wb-tab')].find(x=>x.textContent==='模型'); b && b.click(); })()`);
  await sleep(400);
  if (result.cards < 1) problems.push(`卡片太少（${result.cards}），概览没渲染`);
  if (!result.text.includes('WorkBuddy')) problems.push('页面标题缺失');
  if (!result.text.includes('保留 .state.json 只有一个写者') && !result.text.includes('共用同一个桥')) {
    problems.push('页面没有说明「与控制台共用状态」的定位');
  }

  // 主截图落在概览页：积分卡（头条指标）+ 待办提醒 + 状态 + 操作
  await page.cdp.evaluate(`(() => { const b=[...document.querySelectorAll('.wb-tab')].find(x=>x.textContent==='概览'); b && b.click(); })()`);
  await sleep(600);
  /*
   * **按内容高度裁剪**，不要整页拍。
   *
   * 外壳有 `#frame{min-height:100vh}` —— 容器被撑到视口高（1400px），而概览
   * 内容只有 ~750px。`captureBeyondViewport` 于是拍出 885×1484 的图，
   * **下半张全空白**；放进 README 像没渲染完。
   *
   * **不能直接量 `#frame` 的高度** —— 它本身就是被 `min-height:100vh` 撑出来的
   * （实测 1400 + 上下内边距 84 = 1484），拿它当裁剪框等于没裁。
   * 要量的是**内容底边**：`#root` 的 bottom 减容器 top，再加回容器下内边距。
   */
  const frameBox = await page.cdp.evaluate(`(() => {
    const f = document.getElementById('frame');
    const root = document.getElementById('root');
    const fr = f.getBoundingClientRect();
    const rr = root.getBoundingClientRect();
    const padBottom = parseFloat(getComputedStyle(f).paddingBottom) || 0;
    return { w: Math.ceil(fr.width), h: Math.ceil(rr.bottom - fr.top + padBottom) };
  })()`);
  shot = await page.cdp.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
    clip: { x: 0, y: 0, width: frameBox.w, height: frameBox.h, scale: 1 },
  });
  console.log(`主截图裁剪到内容高度：${frameBox.w}×${frameBox.h}`);
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, Buffer.from(shot.result.data, 'base64'));
  console.log(`截图：${OUT}（${(Buffer.from(shot.result.data, 'base64').length / 1024).toFixed(0)} KB）`);

  /*
   * 英文版：同一份桩数据切到 EN 再拍一张（README.en.md 用）。
   * 刻意走**真实**的语言开关而不是改源码 —— 这样截图也顺带验收了一次切换。
   * 高度要重新量：英文比中文长，面板会变高。
   */
  {
    const toggled = await page.cdp.evaluate(`(() => { const b = document.querySelector('.wb-lang'); if (!b) return false; b.click(); return true; })()`);
    if (toggled) {
      await sleep(800);
      const box = await page.cdp.evaluate(`(() => {
        const f = document.querySelector('#frame');
        const root = document.querySelector('.wb-root');
        if (!f || !root) return null;
        const fr = f.getBoundingClientRect();
        const rr = root.getBoundingClientRect();
        const padBottom = parseFloat(getComputedStyle(f).paddingBottom) || 0;
        return { w: Math.ceil(fr.width), h: Math.ceil(rr.bottom - fr.top + padBottom) };
      })()`);
      if (box) {
        const enShot = await page.cdp.send('Page.captureScreenshot', {
          format: 'png',
          captureBeyondViewport: true,
          clip: { x: 0, y: 0, width: box.w, height: box.h, scale: 1 },
        });
        const OUT_EN = join(OUT_DIR, 'plugin-panel-en.png');
        writeFileSync(OUT_EN, Buffer.from(enShot.result.data, 'base64'));
        console.log(`英文截图：${OUT_EN}（${box.w}×${box.h}）`);
      }
      // 切回中文，免得影响后面几个场景的断言
      await page.cdp.evaluate(`(() => { const b = document.querySelector('.wb-lang'); if (b) b.click(); })()`);
      await sleep(500);
    } else {
      console.warn('找不到语言开关 .wb-lang，跳过英文截图');
    }
  }

  if (problems.length) {
    console.error('\n发现问题：');
    for (const p of problems) console.error(` - ${p}`);
    failed = true;
  } else {
    console.log('\n面板渲染验证通过（注册契约 / 9 个标签页都有内容 / 图表与表格 / 交互 / 无页面错误）。');
  }
} catch (error) {
  console.error(`渲染验证失败：${error.message}`);
  failed = true;
} finally {
  page.close();
  await new Promise((r) => extra.close(r));
  server.close();
}

/**
 * 第三个场景：**窄列**（620px，比设置页常见宽度还窄）。
 * dsh 设置是窄列布局，表格最容易在这里"挤在一起"：列被压到几十 px、
 * 单元格逐字折行、nowrap 的胶囊压住邻居。这里对每张表做盒子级检查。
 */
async function verifyNarrow() {
  console.log('\n—— 场景 3：窄列 620px（表格挤压回归）——');
  const narrowRoutes = {
    ...routes,
    // 让账号表出现"长名字 + 长域名 + 长剩余时间"的最坏组合
    '/workbuddy/console-api/accounts': {
      dir: 'C:\\Users\\demo\\AppData\\Local\\CodeBuddyExtension\\Data\\Public\\auth',
      active: 'C:\\Users\\demo\\AppData\\Local\\CodeBuddyExtension\\Data\\Public\\auth\\workbuddy-desktop.info',
      accounts: [
        { name: 'workbuddy-desktop-ai.info', path: 'C:\\auth\\workbuddy-desktop-ai.info', active: false, usable: true, account: '450000000000', domain: 'www.workbuddy.ai', encrypted: true, expiresAt: Date.now() + 342 * 86400000, remainingMs: 342 * 86400000 },
        { name: 'workbuddy-desktop.info', path: 'C:\\auth\\workbuddy-desktop.info', active: true, usable: true, account: '330000000000', domain: 'copilot.tencent.com', encrypted: true, expiresAt: Date.now() + 44 * 86400000, remainingMs: 44 * 86400000 },
      ],
    },
  };
  const page3 = await openPage(`http://127.0.0.1:${PORT + 3}/harness.html`, {}, { width: 620, height: 1200, injectStub: false, cdpPort: 9335 });
  const extra3 = createServer((req, res) => {
    const path = new URL(req.url, `http://127.0.0.1:${PORT + 3}`).pathname;
    if (path === '/harness.html') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(harnessHtml(narrowRoutes)); }
    if (path === '/client.js') { res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }); return res.end(clientSource); }
    if (path === '/vendor/react.js') { res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }); return res.end(react); }
    if (path === '/vendor/react-dom.js') { res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }); return res.end(reactDom); }
    res.writeHead(404); res.end('not found');
  });
  await new Promise((resolve) => extra3.listen(PORT + 3, '127.0.0.1', resolve));
  const problems = [];
  try {
    await waitFor(page3.cdp, 'window.__harness && window.__harness.rendered === true', 15000, '面板挂载');
    await sleep(900);
    for (const label of ['账号', '用量', '请求', '模型', '诊断', '概览']) {
      await page3.cdp.evaluate(`(() => { const b=[...document.querySelectorAll('.wb-tab')].find(x=>x.textContent===${JSON.stringify(label)}); if(b) b.click(); return !!b; })()`);
      await sleep(700);
      const issues = await page3.cdp.evaluate(`(() => {
        const bad = [];
        const doc = document.documentElement;
        if (doc.scrollWidth - doc.clientWidth > 2) bad.push('视口横向溢出 ' + (doc.scrollWidth - doc.clientWidth) + 'px');
        for (const table of document.querySelectorAll('.wb-table')) {
          const card = table.closest('.wb-card');
          const title = (card && card.querySelector('h3') ? card.querySelector('h3').textContent : '(无标题表)');
          for (const row of table.querySelectorAll('tr')) {
            const cells = [...row.children];
            for (let i = 1; i < cells.length; i += 1) {
              const prev = cells[i - 1].getBoundingClientRect();
              const cur = cells[i].getBoundingClientRect();
              if (cur.width > 0 && cur.left < prev.right - 1) bad.push(title + '：第 ' + (i + 1) + ' 列压住第 ' + i + ' 列（重叠 ' + Math.round(prev.right - cur.left) + 'px）');
            }
            for (const cell of cells) {
              const text = (cell.textContent || '').trim();
              const box = cell.getBoundingClientRect();
              if (cell.scrollWidth > cell.clientWidth + 2 && cell.clientWidth > 0) bad.push(title + '：内容宽于格子（' + text.slice(0, 14) + ' 超出 ' + (cell.scrollWidth - cell.clientWidth) + 'px）');
              if (text.length >= 6 && box.width > 0 && box.width < 34) bad.push(title + '：单元格只有 ' + Math.round(box.width) + 'px 宽（内容 ' + text.slice(0, 12) + '）');
            }
          }
        }
        return [...new Set(bad)].slice(0, 5);
      })()`);
      if (issues && issues.length) for (const item of issues) problems.push(`窄列「${label}」页：${item}`);
    }
    // 截图落在账号页：这里曾经 7 列挤成一团 + 胶囊压邻居，留一张窄列证据
    await page3.cdp.evaluate(`(() => { const b=[...document.querySelectorAll('.wb-tab')].find(x=>x.textContent==='账号'); if(b) b.click(); return !!b; })()`);
    await sleep(700);
    // 账号页（现在是"每账号一行"的列表）：卡片内不许有任何内容溢出/被裁
    const accountsFit = await page3.cdp.evaluate(`(() => {
      const card = [...document.querySelectorAll('.wb-card')].find((c) => /账号/.test(c.querySelector('h3') ? c.querySelector('h3').textContent : ''));
      if (!card) return null;
      let widest = null;
      for (const el of card.querySelectorAll('*')) {
        const box = el.getBoundingClientRect();
        const cbox = card.getBoundingClientRect();
        if (box.width > 0 && box.right > cbox.right + 1) {
          const over = Math.round(box.right - cbox.right);
          if (!widest || over > widest.over) widest = { over, text: (el.textContent || '').slice(0, 20), cls: String(el.className).slice(0, 30) };
        }
        if (el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0 && !el.classList.contains('wb-scroll')) {
          const over = el.scrollWidth - el.clientWidth;
          if (!widest || over > widest.over) widest = { over, text: (el.textContent || '').slice(0, 20), cls: String(el.className).slice(0, 30) };
        }
      }
      return { rows: card.querySelectorAll('.wb-account').length, widest };
    })()`);
    if (!accountsFit) problems.push('窄列下找不到账号卡片');
    else {
      if (!accountsFit.rows) problems.push('账号页没有渲染出账号条目');
      if (accountsFit.widest) {
        problems.push(`账号卡片内有元素溢出/被裁 ${accountsFit.widest.over}px（${accountsFit.widest.cls || '元素'}：${accountsFit.widest.text}）`);
      }
      console.log(`窄列账号列表：${accountsFit.rows} 个账号，卡片内无溢出，无需横向滚动`);
    }
    const shot = await page3.cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    writeFileSync(join(OUT_DIR, 'plugin-panel-narrow-accounts.png'), Buffer.from(shot.result.data, 'base64'));
  } catch (error) {
    problems.push(`场景 3 失败：${error.message}`);
  } finally {
    page3.close();
    await new Promise((r) => extra3.close(r));
  }
  if (problems.length) {
    console.error('场景 3 问题：');
    for (const p of problems) console.error(` - ${p}`);
    failed = true;
  } else {
    console.log('场景 3 通过：620px 窄列下表格不挤压、不重叠、不逐字折行，视口无横向溢出。');
  }
}

/**
 * 第二个场景：**宿主端还是旧构建**（透传接口 404）。
 * 控制台域的每个面板都必须给出「重启 dsh」的可行动提示，而不是空白或对 404 空转。
 */
async function verifyStaleHost() {
  console.log('\n—— 场景 2：宿主端旧构建（console-api 404）——');
  const staleRoutes = {
    '/workbuddy/status': data.status,
    '/workbuddy/models': data.models,
    '/workbuddy/usage': (data.usage && data.usage.usage) ? { ok: true, ...data.usage.usage } : data.usage,
    '/workbuddy/checkin': data.checkin,
    '/workbuddy/log': data.log,
    // 故意**不提供** /workbuddy/console-api/* —— 外壳对未命中路径回 404，正好模拟旧宿主
  };
  const page2 = await openPage(`http://127.0.0.1:${PORT + 2}/harness.html`, {}, { width: 900, height: 1400, injectStub: false, cdpPort: 9334 });
  const extra2 = createServer((req, res) => {
    const path = new URL(req.url, `http://127.0.0.1:${PORT + 2}`).pathname;
    if (path === '/harness.html') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(harnessHtml(staleRoutes)); }
    if (path === '/client.js') { res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }); return res.end(clientSource); }
    if (path === '/vendor/react.js') { res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }); return res.end(react); }
    if (path === '/vendor/react-dom.js') { res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }); return res.end(reactDom); }
    res.writeHead(404); res.end('not found');
  });
  await new Promise((resolve) => extra2.listen(PORT + 2, '127.0.0.1', resolve));
  const problems = [];
  /** 点击标签页，然后**有界等待**某个文本出现（404 有 3 秒重试窗口，不能只看 650ms）。 */
  const clickAndWaitFor = async (label, needle, timeoutMs = 8000) => {
    await page2.cdp.evaluate(`(() => { const b=[...document.querySelectorAll('.wb-tab')].find(x=>x.textContent===${JSON.stringify(label)}); if(b) b.click(); return !!b; })()`);
    const deadline = Date.now() + timeoutMs;
    let text = '';
    for (;;) {
      await sleep(400);
      text = await page2.cdp.evaluate("document.querySelector('.wb-root') ? document.querySelector('.wb-root').innerText : ''");
      if (!needle || text.includes(needle)) return text;
      if (Date.now() > deadline) return text;
    }
  };
  try {
    await waitFor(page2.cdp, 'window.__harness && window.__harness.rendered === true', 15000, '面板挂载');
    await sleep(900);
    for (const label of ['账号', '诊断']) {
      const text = await clickAndWaitFor(label, '重启一次');
      if (!text.includes('重启一次')) problems.push(`「${label}」页没有提示重启 dsh`);
      if (text.includes('正在检测控制台')) problems.push(`「${label}」页停在检测态（404 判定失败）`);
    }
    // 签到页：主卡还能用（领取走桥），但要有"宿主旧构建"的显式提示
    const checkin = await clickAndWaitFor('签到', '重启一次');
    if (!checkin.includes('重启一次')) problems.push('签到页没有提示宿主旧构建');
    if (!checkin.includes('立即领取')) problems.push('签到页丢了「立即领取」（它不依赖控制台）');
    // 模型页：主表还能用，体检按钮应当禁用（等控制台可用性判定完：404 有 3 秒重试窗口）
    const modelsText = await clickAndWaitFor('模型', '可用模型');
    if (!modelsText.includes('可用模型')) problems.push('模型页主表没渲染');
    let probeDisabled = null;
    for (let i = 0; i < 20; i += 1) {
      probeDisabled = await page2.cdp.evaluate(`(() => { const b=[...document.querySelectorAll('.wb-btn')].find(x=>x.textContent.includes('全部体检')); return b ? b.disabled : null; })()`);
      if (probeDisabled === true) break;
      await sleep(400);
    }
    if (probeDisabled !== true) problems.push('宿主旧构建时「全部体检」应禁用');

    // 概览页「刷新积分」在旧宿主上的降级：不许报错，必须给出"按缓存刷新+重启提示"
    await page2.cdp.evaluate(`(() => { const b=[...document.querySelectorAll('.wb-tab')].find(x=>x.textContent==='概览'); b && b.click(); })()`);
    await sleep(600);
    await page2.cdp.evaluate(`(() => { const b=[...document.querySelectorAll('.wb-btn')].find(x=>x.textContent.includes('刷新积分')); b && b.click(); })()`);
    await sleep(900);
    const quotaText = await page2.cdp.evaluate(`(() => { const c=document.querySelector('.wb-quota'); return c ? c.innerText : ''; })()`);
    if (/刷新失败/.test(quotaText)) problems.push('旧宿主上「刷新积分」报错（应当降级为"按缓存刷新+重启提示"）');
    if (!/旧构建|按缓存刷新/.test(quotaText)) problems.push('旧宿主上「刷新积分」没有给出降级说明');
    if (/已刷新/.test(quotaText)) problems.push('旧宿主上不该显示"已刷新"（并没有真的重读上游）');
    console.log('旧宿主刷新积分：降级提示正常（按缓存刷新 + 重启提示）');
  } catch (error) {
    problems.push(`场景 2 失败：${error.message}`);
  } finally {
    page2.close();
    await new Promise((r) => extra2.close(r));
  }
  if (problems.length) {
    console.error('场景 2 问题：');
    for (const p of problems) console.error(` - ${p}`);
    failed = true;
  } else {
    console.log('场景 2 通过：旧宿主下每个控制台域面板都给出可行动提示，桥域功能不受影响。');
  }
}

/**
 * 第四个场景：**桥活着但登录凭据读不出来**（`/health` 回 503 的那种真实故障）。
 * 这是最容易误诊的一种：早先插件把它当成"端口上是别人的服务"，用户会去找
 * 根本不存在的端口冲突。这里钉住面板文案必须说实话 + 给出可执行的修法。
 */
async function verifyDegradedBridge() {
  console.log('\n—— 场景 4：桥在跑但凭据异常（/health 503）——');
  const degradedRoutes = {
    ...routes,
    '/workbuddy/status': {
      ...data.status,
      // 同时模拟「积分缓存的归属账号 ≠ 桥的账号」：积分卡必须显示黄色警告
      // （这是换号 bug 的可见化 —— 缓存还没换新时用户一眼能看出来）
      quotaAccount: 'account-AAAAAAAA',
      bridgeAccount: 'account-BBBBBBBB',
      quota: { ok: true, total: 999, packages: [{ name: 'CodeBuddy个人体验版', remain: 426, size: 500 }] },
      bridge: {
        state: 'degraded',
        health: { ok: false, error: 'login file has no accessToken; sign in to the WorkBuddy desktop app first', authFile: 'C:\\auth\\workbuddy-desktop.info' },
        error: 'login file has no accessToken; sign in to the WorkBuddy desktop app first',
      },
    },
  };
  const port = PORT + 4;
  const page4 = await openPage(`http://127.0.0.1:${port}/harness.html`, {}, { width: 900, height: 1100, injectStub: false, cdpPort: 9336 });
  const extra4 = createServer((req, res) => {
    const path = new URL(req.url, `http://127.0.0.1:${port}`).pathname;
    if (path === '/harness.html') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(harnessHtml(degradedRoutes)); }
    if (path === '/client.js') { res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }); return res.end(clientSource); }
    if (path === '/vendor/react.js') { res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }); return res.end(react); }
    if (path === '/vendor/react-dom.js') { res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }); return res.end(reactDom); }
    res.writeHead(404); res.end('not found');
  });
  await new Promise((resolve) => extra4.listen(port, '127.0.0.1', resolve));
  const problems = [];
  try {
    await waitFor(page4.cdp, 'window.__harness && window.__harness.rendered === true', 15000, '面板挂载');
    await sleep(1000);
    const text = await page4.cdp.evaluate("document.querySelector('.wb-root') ? document.querySelector('.wb-root').innerText : ''");
    if (!/桥凭据异常/.test(text)) problems.push('顶部没有把桥标成「凭据异常」');
    if (/桥未运行/.test(text)) problems.push('把"桥在跑但凭据坏了"说成了「桥未运行」（误导）');
    if (!/读不出登录凭据|登录凭据/.test(text)) problems.push('没有说明是登录凭据的问题');
    if (!/重新登录/.test(text)) problems.push('没有给出「重新登录 WorkBuddy」这条修法');
    if (!/sign in to the WorkBuddy|accessToken/.test(text)) problems.push('没有把桥给的原因原样带出来');
    if (/foreign|不是 workbuddy-bridge/.test(text)) problems.push('仍然误判成"端口上是别人的服务"');
    // 积分归属警告：夹具故意造成 quotaAccount(A) ≠ bridgeAccount(B)，
    // 积分卡必须警告"积分还是上一个账号的"，而不是若无其事地显示数字
    if (!/积分还是上一个账号的/.test(text)) problems.push('积分归属不一致时没有显示警告（换号 bug 的可见化缺失）');
    if (!/正在自动重读/.test(text)) problems.push('归属警告没有说明系统正在自动恢复');
    const shot = await page4.cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    writeFileSync(join(OUT_DIR, 'plugin-panel-degraded.png'), Buffer.from(shot.result.data, 'base64'));
  } catch (error) {
    problems.push(`场景 4 失败：${error.message}`);
  } finally {
    page4.close();
    await new Promise((r) => extra4.close(r));
  }
  if (problems.length) {
    console.error('场景 4 问题：');
    for (const p of problems) console.error(` - ${p}`);
    failed = true;
  } else {
    console.log('场景 4 通过：桥凭据异常时面板说实话（凭据异常 + 原因 + 重新登录的修法），不误诊成端口冲突。');
  }
}

await verifyStaleHost();
await verifyNarrow();
await verifyDegradedBridge();

process.exit(failed ? 1 : 0);
