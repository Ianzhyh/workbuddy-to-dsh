/**
 * 对话测试的**采样参数**（与 dsh 面板同三项）验收。
 *
 *   node tools/dev/test-chat-params.mjs
 *
 * ## 守什么
 *
 * dsh 面板的「对话测试」早就有 max_tokens / temperature / 思考强度三项，控制台
 * 一项都没有 —— 而控制台正是"对比不同档位下模型表现"的地方。补齐之后必须守住
 * 四条纪律，否则补出来的东西比没有更糟：
 *
 *   1. **留空 = 不发该字段**。绝不替用户猜默认值：不同上游模型对未知参数容忍度
 *      不同，乱发会 400，而 400 看起来像"桥坏了"。
 *   2. **非法值不许静默丢弃**。填了 `temperature: 9` 却仍照发、还当没设过，
 *      用户会以为设了生效了。必须当场拦住并说清是哪一项。
 *   3. **思考档位跟着模型变**。档位是模型自身属性（桥目录 `reasoning_efforts`），
 *      给不支持推理的模型发 `reasoning_effort` 要么 400、要么静默忽略。
 *   4. **换模型不继承上一个模型的档位**。A 有 `max`、B 没有 —— 切到 B 必须回到
 *      「默认」，不能把 `max` 发过去。
 *
 * 全程打桩，不打上游、不花钱。
 */
import { startStaticServer, openPage, waitFor, q, sleep } from './ui-harness.mjs';
import { baseRoutes, CATALOG } from './fixtures.mjs';

const PORT = process.env.CHAT_PARAMS_PORT ? Number(process.env.CHAT_PARAMS_PORT) : 8789;
const URL_ = `http://127.0.0.1:${PORT}/`;

let failures = 0;
const fail = (m) => { console.error('✗ ' + m); failures += 1; };
const pass = (m) => console.log('✓ ' + m);

/* 两个模型：一个有三档思考强度，一个完全没有 —— 「跟着模型变」才测得出来 */
const CATALOG2 = [
  {
    ...CATALOG[0], id: 'with-effort', name: 'WITH-EFFORT',
    supports_reasoning: true,
    reasoning_efforts: ['low', 'medium', 'high'],
    default_reasoning_effort: 'medium',
  },
  { ...CATALOG[1], id: 'no-effort', name: 'NO-EFFORT', supports_reasoning: false },
];

const routes = {
  ...baseRoutes({ catalog: CATALOG2 }),
  /* 一次最简单的 SSE 回复：只为让 sendChat 走完并留下 POST 记录 */
  '/api/chat': {
    chunks: [{ text: 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n' }, { text: 'data: [DONE]\n\n' }],
    type: 'text/event-stream',
  },
};

const server = await startStaticServer(PORT);
const { cdp, close } = await openPage(URL_, routes);
const cleanup = () => { try { cdp.close(); } catch { /* 忽略 */ } try { server.close(); } catch { /* 忽略 */ } };
process.on('exit', cleanup);

const chatPosts = () => q(cdp, `window.__posts.filter((p) => p.path === '/api/chat').map((p) => p.body)`);
const setVal = (sel, value) => q(cdp, `(() => {
  const el = document.querySelector(${JSON.stringify(sel)});
  if (!el) return false;
  el.value = ${JSON.stringify(String(value))};
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
})()`);
const pickModel = (id) => q(cdp, `(() => {
  const s = document.querySelector('#modelSel');
  s.value = ${JSON.stringify(id)};
  s.dispatchEvent(new Event('change', { bubbles: true }));
  return s.value;
})()`);

try {
  await waitFor(cdp, `!!document.querySelector('#chatMaxTokens') && !!document.querySelector('#chatEffort')`, 12000, '采样参数控件存在');
  await waitFor(cdp, `document.querySelector('#modelSel').options.length > 0`, 12000, '模型下拉就绪');
  await sleep(300);

  /* ── 1. 留空 = 不发 ────────────────────────────────────────────── */
  {
    await pickModel('with-effort');
    await setVal('#promptInput', '你好');
    await q(cdp, `document.querySelector('#sendBtn').click()`);
    await waitFor(cdp, `window.__posts.filter((p) => p.path === '/api/chat').length === 1`, 8000, '第一次发送');
    const [body] = await chatPosts();
    const extra = ['max_tokens', 'temperature', 'reasoning_effort'].filter((k) => k in body);
    if (!extra.length) pass('参数全留空时**一个都不发**（交给上游默认，不替用户猜）');
    else fail(`留空却发了：${extra.join(', ')}`);
  }

  /* ── 2. 填了就发，且按数值发（不是字符串） ─────────────────────── */
  {
    await setVal('#chatMaxTokens', '2048');
    await setVal('#chatTemperature', '0.3');
    await pickModel('with-effort');
    await q(cdp, `(() => { const s = document.querySelector('#chatEffort'); s.value = 'high'; s.dispatchEvent(new Event('change')); return s.value; })()`);
    await sleep(120);
    await setVal('#promptInput', '再来一句');
    await q(cdp, `document.querySelector('#sendBtn').click()`);
    await waitFor(cdp, `window.__posts.filter((p) => p.path === '/api/chat').length === 2`, 8000, '第二次发送');
    const [, body] = await chatPosts();
    if (body.max_tokens === 2048) pass('max_tokens 按**数字**发出（2048，不是 "2048"）');
    else fail(`max_tokens 异常：${JSON.stringify(body.max_tokens)}`);
    if (body.temperature === 0.3) pass('temperature 按数字发出（0.3）');
    else fail(`temperature 异常：${JSON.stringify(body.temperature)}`);
    if (body.reasoning_effort === 'high') pass('思考强度按所选档位发出（high）');
    else fail(`reasoning_effort 异常：${JSON.stringify(body.reasoning_effort)}`);
  }

  /* ── 3. 非法值：当场拦住，不发请求 ─────────────────────────────── */
  {
    const before = (await chatPosts()).length;
    await setVal('#chatTemperature', '9');
    await setVal('#promptInput', '这句不该发出去');
    await q(cdp, `document.querySelector('#sendBtn').click()`);
    await sleep(500);
    const after = (await chatPosts()).length;
    const out = await q(cdp, `(document.querySelector('#chatOut')||{}).textContent || ''`);
    if (after === before) pass('temperature=9 → **不发请求**（在本地拦住）');
    else fail(`temperature=9 仍然发了请求（${before} → ${after}）`);
    if (/temperature 需要是 0–2 之间的数字/.test(out)) pass('非法值说清是哪一项、该是什么范围');
    else fail(`非法值没有可读原因：「${out.slice(0, 120)}」`);

    await setVal('#chatTemperature', '0.3');
    await setVal('#chatMaxTokens', '0');
    const before2 = (await chatPosts()).length;
    await q(cdp, `document.querySelector('#sendBtn').click()`);
    await sleep(400);
    const after2 = (await chatPosts()).length;
    const out2 = await q(cdp, `(document.querySelector('#chatOut')||{}).textContent || ''`);
    if (after2 === before2 && /max_tokens 需要是正整数/.test(out2)) {
      pass('max_tokens=0 → 也不发，并说明「需要是正整数」');
    } else fail(`max_tokens=0 处理异常：发了 ${after2 - before2} 次，「${out2.slice(0, 100)}」`);
    await setVal('#chatMaxTokens', '');
  }

  /* ── 4. 思考档位跟着模型变；换模型不继承 ───────────────────────── */
  {
    await pickModel('with-effort');
    await sleep(120);
    const opts = await q(cdp, `[...document.querySelectorAll('#chatEffort option')].map((o) => o.value)`);
    if (opts.join(',') === ',low,medium,high') pass(`思考档位来自目录：${JSON.stringify(opts)}`);
    else fail(`档位列表异常：${JSON.stringify(opts)}`);

    const hint = await q(cdp, `(document.querySelector('#chatParamsHint')||{}).textContent || ''`);
    if (/模型默认档位/.test(hint) && /中/.test(hint)) pass(`提示写明默认档位（${hint.trim()}）`);
    else fail(`默认档位提示异常：「${hint}」`);

    /* 选 high 之后切到不支持推理的模型：必须回到「默认」且禁用 */
    await q(cdp, `(() => { const s = document.querySelector('#chatEffort'); s.value = 'high'; s.dispatchEvent(new Event('change')); return s.value; })()`);
    await pickModel('no-effort');
    await sleep(160);
    const state = await q(cdp, `(() => {
      const s = document.querySelector('#chatEffort');
      return { disabled: s.disabled, value: s.value, options: s.options.length, hint: (document.querySelector('#chatParamsHint')||{}).textContent || '' };
    })()`);
    if (state.disabled) pass('不支持推理的模型：思考强度**禁用**（不是隐藏，避免这一行跳变）');
    else fail('不支持推理的模型仍可点思考强度');
    if (state.value === '') pass('换模型不继承上一个模型的档位（回到「默认」）');
    else fail(`换模型后仍带着档位「${state.value}」`);
    if (/没有思考档位/.test(state.hint)) pass(`禁用时说明了原因（${state.hint.trim()}）`);
    else fail(`禁用却没有说明：「${state.hint}」`);
  }
} finally {
  cleanup();
}

console.log('');
if (failures) {
  console.error(`✗ 对话采样参数验收失败 ${failures} 项`);
  process.exit(1);
}
console.log('✓ 对话采样参数验收全部通过');