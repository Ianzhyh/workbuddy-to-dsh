/**
 * 可访问名称守卫：**凡能被 Tab 到的元素，都要有能被读屏念出来的名字。**
 *
 *   node tools/dev/test-accessible-name.mjs
 *
 * ## 为什么需要它
 *
 * WCAG 4.1.2（Name, Role, Value）：每个可交互元素都要有 accessible name。
 * 最典型的漏网是**图标按钮**和**表格里的裸控件** —— 肉眼看着好好的，
 * 读屏只会念「按钮」「复选框」，不说这是干什么的。读代码看不出来。
 *
 * 第一次跑就抓到：模型表的行复选框 `<input type="checkbox" data-id="…">`
 * 是全表**唯一一个没有 `<label>` 的**（其余都包在 `<label class="check">` 里）——
 * 因为它的说明在右边另一列，而不是它的标签。读屏用户 Tab 过去完全不知道选的是哪个模型。
 *
 * ## 判据
 *
 * 简化版 accessible name 计算（不求完整实现 WAI-ARIA AccName，够用即可）：
 *   `aria-labelledby` → `aria-label` → 原生 `<label>` → 文本内容 → `title` → `placeholder`
 * 全空 = 没有名字。`aria-hidden="true"` 与不可见的元素跳过。
 *
 * ## 与 i18n 的交叉约束（本项目特有）
 *
 * `I18N_ATTRS` 包含 `aria-label`，所以**新加的名字会自动进翻译层**。
 * 拼接式文案（「动词 + 上游数据」）必须在 `RULES` 里加一条规则兜住，
 * 且**只翻动词、不翻数据** —— 否则英文模式会留下中文（`check:i18n` 会红）。
 * 例：`选中 <模型名>` → `[/^选中 (.+)$/, 'Select $1']`。
 */
import { startStaticServer, openPage, waitFor, q, sleep } from './ui-harness.mjs';
import { baseRoutes } from './fixtures.mjs';

let failures = 0;
const pass = (m) => console.log('✓ ' + m);
const fail = (m) => { console.error('✗ ' + m); failures += 1; };

const PORT = 8827;
const URL_ = `http://127.0.0.1:${PORT}/`;

const SCAN = `(() => {
  const SEL = 'button, a[href], input:not([type=hidden]), select, textarea, summary, [role=button], [role=checkbox], [role=switch], [role=tab], [role=link], [tabindex]:not([tabindex="-1"])';
  const textOf = (el) => (el.textContent || '').replace(/\\s+/g, ' ').trim();

  /* <svg> 里可能藏着 <title>；另外 <img alt> 也算名字 */
  const deepText = (el) => {
    const t = textOf(el);
    if (t) return t;
    const parts = [];
    for (const img of el.querySelectorAll('img[alt]')) parts.push(img.getAttribute('alt'));
    for (const ttl of el.querySelectorAll('svg > title')) parts.push(textOf(ttl));
    return parts.join(' ').replace(/\\s+/g, ' ').trim();
  };

  const labelledBy = (el) => {
    const ids = (el.getAttribute('aria-labelledby') || '').trim().split(/\\s+/).filter(Boolean);
    return ids.map((id) => { const t = document.getElementById(id); return t ? textOf(t) : ''; }).join(' ').trim();
  };

  const nativeLabel = (el) => {
    if (el.id) {
      const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (l) return textOf(l);
    }
    const p = el.closest('label');
    return p ? textOf(p) : '';
  };

  const name = (el) => {
    const by = labelledBy(el); if (by) return by;
    const al = (el.getAttribute('aria-label') || '').trim(); if (al) return al;
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName)) {
      const nl = nativeLabel(el); if (nl) return nl;
    }
    const dt = deepText(el); if (dt) return dt;
    const ti = (el.getAttribute('title') || '').trim(); if (ti) return ti;
    return (el.getAttribute('placeholder') || '').trim();
  };

  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden';
  };

  const out = [];
  const seen = new Set();
  for (const el of document.querySelectorAll(SEL)) {
    if (el.getAttribute('aria-hidden') === 'true') continue;
    if (!visible(el)) continue;
    const key = el.tagName + '.' + (el.className || '') + '#' + (el.id || '');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      tag: el.tagName.toLowerCase(),
      cls: String(el.className || '').slice(0, 40),
      id: el.id || '',
      role: el.getAttribute('role') || '',
      type: el.getAttribute('type') || '',
      name: name(el).slice(0, 30),
      html: el.outerHTML.replace(/\\s+/g, ' ').slice(0, 80),
    });
  }
  return out;
})()`;

/* 未激活的页签面板不渲染，只审一个视图会漏掉大半控件 */
const VIEWS = [
  { name: '概览', setup: `switchTab('overview')` },
  { name: '模型', setup: `switchTab('models')` },
  { name: '对话测试', setup: `switchTab('playground')` },
  { name: '客户端接入', setup: `switchTab('clients')` },
  { name: '日志抽屉', setup: `(() => { const d = document.getElementById('logDrawer'); if (d) { d.open = true; d.dispatchEvent(new Event('toggle')); } })()` },
];

const server = await startStaticServer(PORT);
const { cdp, close } = await openPage(URL_, baseRoutes(), { width: 1440, height: 900, cdpPort: 9377 });
const cleanup = () => { try { close(); } catch { /* 忽略 */ } try { server.close(); } catch { /* 忽略 */ } };
process.on('exit', cleanup);

let checked = 0;

await waitFor(cdp, `document.querySelectorAll('.nav-tab').length >= 4`, 10000, '页签就绪');

for (const view of VIEWS) {
  await q(cdp, view.setup);
  await sleep(500);
  const rows = await q(cdp, SCAN);
  const bad = rows.filter((r) => !r.name);
  checked += rows.length;

  console.log(`\n── ${view.name}：${rows.length} 个可交互元素 ──`);
  for (const r of bad) {
    const sel = `<${r.tag}${r.id ? '#' + r.id : ''}${r.cls ? '.' + r.cls.split(' ').join('.') : ''}>`;
    fail(`[${view.name}] ${sel}${r.role ? ' role=' + r.role : ''}${r.type ? ' type=' + r.type : ''} 没有可访问名称 —— 读屏只会念控件类型`);
    console.error(`    ${r.html}`);
  }
  if (bad.length === 0 && rows.length > 0) pass(`[${view.name}] ${rows.length} 个元素全部有可访问名称`);
  if (rows.length === 0) fail(`[${view.name}] 一个可交互元素都没量到 —— 视图没渲染出来？`);
}

/*
 * 防假绿：总样本太少说明桩数据或选择器坏了，
 * 「没渲染 = 0 失败」不能算通过（与对比度 / 焦点用例同款守卫）。
 */
if (checked < 40) fail(`全部视图只量到 ${checked} 个可交互元素 —— 太少（防假绿）`);
else pass(`五个视图共体检 ${checked} 个可交互元素`);

console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
cleanup();
process.exit(failures ? 1 : 0);
