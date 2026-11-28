/**
 * **真实实例**冒烟：控制台新面板在真接口上是否真的渲染。
 *
 *   node tools/dev/probe-console-live.mjs [http://127.0.0.1:8792]
 *
 * ## 与打桩用例的分工（两者都要）
 *
 * `test-parity-console.mjs` 证明「给定这份数据，界面这样渲染」；
 * 它证明不了「真实接口的形状能让界面渲染出来」。这两件事是**两回事**，
 * 而本项目踩过的坑正是后者：桩数据全绿、真机整块空白。
 *
 * `api-shape.json` 守的是桩数据字段名；本脚本守的是**真机的渲染结果**。
 *
 * ## 它不动任何东西
 *
 * 全程只读：不写状态、不点任何会花钱的按钮（不测速、不体检、不领取）。
 * 控制台此刻是否在跑由调用方负责（插件会按需拉起），地址可传参。
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openPage, sleep, waitFor } from './ui-harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const URL_ = (process.argv[2] || 'http://127.0.0.1:8792').replace(/\/$/, '');

let failures = 0;
const fail = (m) => { console.error('✗ ' + m); failures += 1; };
const pass = (m) => console.log('✓ ' + m);

const { cdp, close } = await openPage(URL_ + '/', {}, {
  /* 不打桩：要的就是真接口 */
  injectStub: false,
  width: 1400,
  height: 1000,
  inject: `window.__ERRORS = []; window.addEventListener('error', (e) => window.__ERRORS.push(String(e.message)));`,
});

const txt = (sel) => cdp.evaluate(`(document.querySelector(${JSON.stringify(sel)})||{}).textContent || ''`);

try {
  await waitFor(
    cdp,
    `!!document.querySelector('#limitsBox') && !!document.querySelector('#acctCheckinBox')`,
    20000,
    '新面板存在（控制台页面是否已是当前构建？）',
  );
  /* 首屏数据要跑完两轮：/api/models 冷缓存时桥要抓一次上游目录 */
  await waitFor(cdp, `document.querySelectorAll('#modelTable tbody tr').length > 0`, 40000, '模型表渲染');
  await sleep(2000);

  /* ① 用量上限：真实桥此刻可能真的没触顶 —— 两种结论都接受，但不能是空白 */
  const limits = (await txt('#limitsBox')).replace(/\s+/g, ' ').trim();
  if (/读取失败|undefined|NaN/.test(limits)) fail(`用量上限渲染异常：${limits.slice(0, 200)}`);
  else if (/没有账号触顶|额度已恢复|额度已用尽|积分不足|账号被风控|触发了限流/.test(limits)) {
    pass(`用量上限真实渲染：${limits.slice(0, 100)}`);
  } else fail(`用量上限是空白（既没有结论也没有说明）：「${limits.slice(0, 120)}」`);

  /* ② 账号签到：真实本机账号；分母必须与可见行数一致 */
  const acct = (await txt('#acctCheckinBox')).replace(/\s+/g, ' ').trim();
  if (/读取失败|undefined/.test(acct)) fail(`账号签到渲染异常：${acct.slice(0, 200)}`);
  else if (/今日已签|没有找到本机已登录的账号|本机账号都没有签到活动/.test(acct)) {
    pass(`账号签到真实渲染：${acct.slice(0, 100)}`);
  } else fail(`账号签到是空白：「${acct.slice(0, 120)}」`);

  /* ③ 分母一致性：`N/M` 的 M 必须等于「有活动」的行数（无活动的是折叠摘要，不算行） */
  const denom = await cdp.evaluate(`(() => {
    const box = document.querySelector('#acctCheckinBox');
    const m = (box.textContent.match(/今日已签\\s*(\\d+)\\/(\\d+)/) || []);
    /*
     * 折叠摘要本身也是一个 .acct（含 .acct-name 与展开按钮），
     * 数行时必须排掉它 —— 否则分母 2 而"行"3，看着像缺陷。
     */
    const rows = [...box.querySelectorAll('.acct')]
      .filter((el) => el.querySelector('.acct-name'))
      .filter((el) => !el.querySelector('#acctCheckinToggle'));
    return { shown: m[2] || '', rows: rows.length };
  })()`);
  if (!denom.shown || Number(denom.shown) === denom.rows) {
    pass(`账号签到分母与可见行一致（N/${denom.shown || '?'} vs ${denom.rows} 行）`);
  } else fail(`账号签到分母不一致：分母 ${denom.shown}，可见 ${denom.rows} 行`);

  /* ④ 速度列：每个数据行都要有 */
  const tpsCells = await cdp.evaluate(`document.querySelectorAll('#modelTable td[data-tps]').length`);
  const rows = await cdp.evaluate(`document.querySelectorAll('#modelTable tbody tr').length`);
  if (tpsCells === rows && rows > 0) pass(`模型表：${rows} 行都有「速度」单元格`);
  else fail(`模型表：速度格 ${tpsCells} 个 / 数据行 ${rows} 行`);

  /* ⑤ 「未列出」徽标与 data-official 必须一一对应（真实目录里数量不固定） */
  const tag = await cdp.evaluate(`(() => {
    const list = [...document.querySelectorAll('#modelTable tbody tr')];
    const bad = [];
    for (const tr of list) {
      const hasTag = !!tr.querySelector('.tag.unlisted');
      if (hasTag !== (tr.dataset.official === '0')) bad.push(tr.dataset.modelId);
    }
    return { rows: list.length, unlisted: list.filter((t) => t.dataset.official === '0').length, bad };
  })()`);
  if (!tag.bad.length) {
    pass(`未列出标记一致：${tag.rows} 行里 ${tag.unlisted} 个未列出，徽标与标记一一对应`);
  } else fail(`未列出标记不一致：${JSON.stringify(tag.bad.slice(0, 5))}`);

  /* ⑥ 模型详情：官方档位那几行在真实目录上也要有（字段确实存在时才出现） */
  const detail = await cdp.evaluate(`(() => {
    const b = document.querySelector('#modelTable button.infobtn');
    if (!b) return null;
    b.click();
    const tr = document.querySelector('#modelTable tr.detail-row');
    return tr ? tr.textContent : null;
  })()`);
  if (detail === null) fail('模型详情：找不到 ⓘ 按钮');
  else if (/中文描述|英文描述|厂商|上下文（精确）|dsh 注册/.test(detail)) {
    pass(`模型详情真实渲染：${detail.replace(/\s+/g, ' ').slice(0, 80)}`);
  } else fail(`模型详情内容异常：「${String(detail).slice(0, 120)}」`);

  /* ⑦ 对话测试的采样参数：三项都在，且思考档位跟随真实目录里的推理模型 */
  const chat = await cdp.evaluate(`(() => {
    const maxEl = document.querySelector('#chatMaxTokens');
    const tempEl = document.querySelector('#chatTemperature');
    const effortEl = document.querySelector('#chatEffort');
    if (!maxEl || !tempEl || !effortEl) return { missing: true };
    /*
     * 找一个**支持推理**的真实模型，看档位是否来自目录（而不是写死的三档）：
     * 页面自己的目录缓存 currentModels 最准。
     */
    const withEffort = (currentModels || []).find((m) => Array.isArray(m.reasoning_efforts) && m.reasoning_efforts.length);
    if (withEffort) {
      const sel = document.querySelector('#modelSel');
      sel.value = withEffort.id;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return {
      missing: false,
      model: withEffort ? withEffort.id : null,
      expected: withEffort ? withEffort.reasoning_efforts : null,
      options: [...effortEl.options].map((o) => o.value),
      disabled: effortEl.disabled,
      hint: (document.querySelector('#chatParamsHint') || {}).textContent || '',
    };
  })()`);
  if (chat.missing) fail('对话采样参数：三项控件没有全部渲染');
  else if (!chat.model) pass('对话采样参数：控制台已就位（真实目录里当前没有支持推理的模型，跳过档位比对）');
  else if (chat.options.slice(1).join(',') === chat.expected.join(',')) {
    pass(`对话采样参数：档位来自目录（${chat.model} → ${chat.expected.join('/')}），提示「${chat.hint.trim()}」`);
  } else fail(`对话采样参数：档位与目录不一致 ${JSON.stringify(chat.options)} vs ${JSON.stringify(chat.expected)}`);

  const errs = await cdp.evaluate('window.__ERRORS || []');
  if (!errs.length) pass('无页面运行时报错');
  else fail(`页面报错：${JSON.stringify(errs.slice(0, 3))}`);
} catch (err) {
  fail(String((err && err.message) || err));
} finally {
  try { close(); } catch { /* 忽略 */ }
}

console.log('');
if (failures) {
  console.error(`✗ 真实实例冒烟失败 ${failures} 项（控制台：${URL_}，仓库：${ROOT}）`);
  process.exit(1);
}
console.log(`✓ 真实实例冒烟通过（${URL_}）`);