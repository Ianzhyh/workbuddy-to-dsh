/**
 * R4 对话测试实用化 验收（Task 16–17）。
 *
 *   node tools/dev/test-r4-chat.mjs
 *
 * 覆盖：多轮上下文（msgs 计数）、输出分段、用量显示、停止只显示时间、
 * 阈值提示不裁剪、清空对话、复制回答。
 */
import { startStaticServer, openPage, waitFor, q, sleep } from './ui-harness.mjs';
import { accountsFixture, bridgeFixture, checkinFixture, consoleFixture, credentialsFixture, diagnoseFixture, dshFixture, quotaFixture, requestsFixture } from './fixtures.mjs';

const PORT = 8788;
const URL_ = `http://127.0.0.1:${PORT}/`;

let failures = 0;
const fail = (m) => { console.error('✗ ' + m); failures += 1; };
const pass = (m) => console.log('✓ ' + m);

const now = Date.now();
const CATALOG = ['alpha', 'beta'].map((id) => ({
  id, name: id.toUpperCase(), context_window: 128000, max_output_tokens: 8192, credits: 0.11,
}));

const sse = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
const textChunk = (t) => sse({ choices: [{ index: 0, delta: { content: t } }] });
const usageChunk = (u) => sse({ choices: [{ index: 0, delta: {} }], usage: u });
const DONE = 'data: [DONE]\n\n';

const routes = {
  '/api/models': { body: { models: CATALOG } },
  '/api/overview': {
    body: {
      bridge: { ...bridgeFixture(), running: true, ok: true, host: '127.0.0.1', port: 8790, endpoint: 'http://127.0.0.1:8790/v1', pid: 1, startedAt: new Date(now - 1000).toISOString(), uptimeMs: 1000, catalogSize: 2, catalogAt: new Date(now - 60000).toISOString() },
      credentials: { ...credentialsFixture(), active: { account: 'a', userId: 'a', remainingMs: 40 * 86400000, expiresAt: now + 40 * 86400000 }, error: '' },
      quota: { ...quotaFixture(), total: 10, packages: [] },
      dsh: { ...dshFixture(), routeLive: true, hasBridgeKey: true, bundlesOk: true, bundles: [], registeredModels: ['alpha'] },
      console: { ...consoleFixture(), version: '1.0.0', node: 'v22' },
    },
  },
  '/api/probe-results': { body: { updatedAt: null, results: {}, lastRun: null } },
  '/api/diagnose': { body: diagnoseFixture({ items: [] }) },
  '/api/usage': { body: { usage: null } },
  '/api/requests': { body: requestsFixture({ requests: [] }) },
  '/api/accounts': { body: accountsFixture({ accounts: [] }) },
  '/api/checkin': { body: checkinFixture() },
  '/api/bridge/log': { body: { lines: [] } },
  '/api/chat': {
    type: 'text/event-stream',
    chunks: [
      { text: textChunk('第一轮回答') },
      { text: usageChunk({ prompt_tokens: 10, completion_tokens: 5, credit: 0.01 }) },
      { text: DONE },
    ],
  },
};

const INJECT = `(() => {
  window.__clip = null;
  try {
    if (!navigator.clipboard) Object.defineProperty(navigator, 'clipboard', { value: {}, configurable: true });
    navigator.clipboard.writeText = (t) => { window.__clip = t; return Promise.resolve(); };
  } catch (e) { /* 忽略 */ }
})();`;

const server = await startStaticServer(PORT);
const { cdp, close } = await openPage(URL_, routes, { inject: INJECT });
const cleanup = () => { try { cdp.close(); } catch { /* 忽略 */ } try { server.close(); } catch { /* 忽略 */ } };
process.on('exit', cleanup);

const txt = (sel) => q(cdp, `(document.querySelector(${JSON.stringify(sel)})||{}).textContent || ''`);
const chatPosts = () => q(cdp, `window.__posts.filter(p => p.path === '/api/chat').map(p => p.body)`);
const turnCount = (role) => q(cdp, `document.querySelectorAll('#chatOut .turn.${role}').length`);
const bodyOf = (role, i = 0) => q(cdp, `(document.querySelectorAll('#chatOut .turn.${role} .turn-body')[${i}]||{}).textContent || ''`);
const metaOf = (i = 0) => q(cdp, `(document.querySelectorAll('#chatOut .turn.assistant .turn-role')[${i}]||{}).textContent || ''`);
const sendInfo = () => q(cdp, `(document.querySelector('#chatOut .chat-sendinfo')||{}).textContent || ''`);

async function send(prompt) {
  await q(cdp, `(document.querySelector('#promptInput').value = ${JSON.stringify(prompt)}, true)`);
  await q(cdp, `(document.querySelector('#sendBtn').click(), true)`);
  await waitFor(cdp, `!document.querySelector('#sendBtn').disabled`, 10000, '发送结束');
  await sleep(250);
}

try {
  await waitFor(cdp, `!!document.querySelector('#modelSel') && document.querySelector('#modelSel').options.length > 0`, 10000, '模型下拉就绪');
  await sleep(200);
  const model = await q(cdp, `document.querySelector('#modelSel').value`);
  if (!model) { fail('模型下拉没有选中项，后续断言无法进行'); throw new Error('无选中模型'); }

  // ── R4.1-1 多轮上下文 ───────────────────────────────────────────────
  {
    await send('第一轮问题');
    if (await turnCount('user') === 1 && await turnCount('assistant') === 1) pass('R4.1-2 输出区按轮次分段（1 用户 + 1 助手）');
    else fail(`R4.1-2 轮次分段异常：user=${await turnCount('user')} assistant=${await turnCount('assistant')}`);
    if (/第一轮回答/.test(await bodyOf('assistant'))) pass('R4.1-1 助手回答正确渲染');
    else fail(`R4.1-1 助手内容异常：「${await bodyOf('assistant')}」`);

    await send('第二轮问题');
    const posts = await chatPosts();
    const last = posts[posts.length - 1];
    const roles = (last.messages || []).map((m) => m.role);
    if (last.messages && last.messages.length === 4) pass('R4.1-1 第二次请求带 4 条消息（system+user+assistant+user）');
    else fail(`R4.1-1 第二次请求消息数应为 4，实际 ${last.messages ? last.messages.length : 'n/a'}`);
    if (JSON.stringify(roles) === JSON.stringify(['system', 'user', 'assistant', 'user'])) {
      pass(`R4.1-1 角色顺序正确：${roles.join(' → ')}`);
    } else {
      fail(`R4.1-1 角色顺序异常：${JSON.stringify(roles)}`);
    }
    if (last.messages[1].content === '第一轮问题' && last.messages[2].content === '第一轮回答') {
      pass('R4.1-1 上一轮的问题与回答都进了上下文（回答能引用上一轮）');
    } else {
      fail('R4.1-1 上下文内容不对');
    }
  }

  // ── R4.1-2 末行「本轮发送 N 条消息 · 约 X 字符」 ─────────────────────
  {
    const info = await sendInfo();
    if (/本轮发送 4 条消息 · 约 \d+ 字符/.test(info)) pass(`R4.1-2 末行显示发送规模：${info}`);
    else fail(`R4.1-2 末行文案异常：「${info}」`);
  }

  // ── R4.2-1 用量显示 ─────────────────────────────────────────────────
  {
    const meta = await metaOf(0);
    if (/输入 10 \/ 输出 5 tokens · 扣分 0\.01 · \d+\.\d+s/.test(meta)) {
      pass(`R4.2-1 显示「输入 x / 输出 y tokens · 扣分 z · Ns」：${meta}`);
    } else {
      fail(`R4.2-1 用量文案异常：「${meta}」`);
    }
  }

  // ── R4.2-1（续）未回报扣分 → —（上游未回报）────────────────────────
  {
    await q(cdp, `window.__setRoute('/api/chat', { type: 'text/event-stream', chunks: [
      { text: ${JSON.stringify(textChunk('没有扣分的回答'))} },
      { text: ${JSON.stringify(usageChunk({ prompt_tokens: 7, completion_tokens: 3 }))} },
      { text: ${JSON.stringify(DONE)} }
    ] })`);
    await send('第三轮问题');
    const meta = await metaOf(2);
    if (/扣分 —（上游未回报）/.test(meta)) pass(`R4.2-1 未回报扣分显示「—（上游未回报）」：${meta}`);
    else fail(`R4.2-1 未回报扣分文案异常：「${meta}」`);
  }

  // ── R4.2-2 / R4.1-1 停止但已有内容 ──────────────────────────────────
  {
    await q(cdp, `window.__setRoute('/api/chat', { type: 'text/event-stream', chunks: [
      { text: ${JSON.stringify(textChunk('部分内容'))} },
      { delay: 2500, text: ${JSON.stringify(DONE)} }
    ] })`);
    await q(cdp, `(document.querySelector('#promptInput').value = '第四轮问题', true)`);
    await q(cdp, `(document.querySelector('#sendBtn').click(), true)`);
    await sleep(500); // 第一块已到、第二块还在等
    await q(cdp, `(document.querySelector('#chatStopBtn').click(), true)`);
    await waitFor(cdp, `!document.querySelector('#sendBtn').disabled`, 8000, '停止结束');
    await sleep(250);

    const meta = await metaOf(3);
    if (/已手动停止 · 用时 \d+\.\d+s/.test(meta)) pass(`R4.2-2 停止只显示已用时间：${meta}`);
    else fail(`R4.2-2 停止文案异常：「${meta}」`);
    if (!/tokens|扣分/.test(meta)) pass('R4.2-2 停止时**不猜** token / 扣分');
    else fail(`R4.2-2 停止时出现了猜测的数值：「${meta}」`);
    if (/部分内容/.test(await bodyOf('assistant', 3))) pass('R4.1-1 停止时已输出的内容保留');
    else fail(`R4.1-1 停止时内容丢失：「${await bodyOf('assistant', 3)}」`);

    // 「停止且已有内容」也要入历史
    await send('第五轮问题');
    const posts = await chatPosts();
    const last = posts[posts.length - 1];
    if (last.messages.some((m) => m.role === 'assistant' && m.content === '部分内容')) {
      pass('R4.1-1 停止但已有内容 → 助手回复已入历史');
    } else {
      fail(`R4.1-1 停止后的部分内容未入历史：${JSON.stringify(last.messages.map((m) => m.role))}`);
    }
  }

  // ── R4.1-3 阈值提示且不裁剪 ─────────────────────────────────────────
  {
    await q(cdp, `window.__setRoute('/api/chat', { type: 'text/event-stream', chunks: [
      { text: ${JSON.stringify(textChunk('ok'))} },
      { text: ${JSON.stringify(DONE)} }
    ] })`);
    // 构造一段超阈值的历史（20 条消息）
    await q(cdp, `(chatHistory = [{ role: 'system', content: 'You are a concise assistant.' },
      ...Array.from({ length: 19 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'x'.repeat(50) }))], true)`);
    await q(cdp, `(chatRounds = [], chatLastSend = null, renderChat(), true)`);
    await send('触发阈值');
    const info = await sendInfo();
    if (/建议清空对话/.test(info)) pass(`R4.1-3 达到阈值提示「建议清空对话」：${info}`);
    else fail(`R4.1-3 未出现阈值提示：「${info}」`);

    const posts = await chatPosts();
    const last = posts[posts.length - 1];
    if (last.messages.length === 21) pass(`R4.1-3 实际发送内容**未裁剪**（${last.messages.length} 条 = 历史 20 + 新 1）`);
    else fail(`R4.1-3 发送内容被裁剪：${last.messages.length} 条（应为 21）`);
  }

  // ── R4.3-1 复制回答 ─────────────────────────────────────────────────
  {
    await q(cdp, `(window.__clip = null, true)`);
    await q(cdp, `(() => { const b = document.querySelectorAll('#chatOut [data-copy-turn]'); if (b.length) b[b.length - 1].click(); return true; })()`);
    await sleep(200);
    const clip = await q(cdp, `window.__clip || ''`);
    if (clip === 'ok') pass('R4.3-1 复制得到纯文本回答（不含角色标签 / 用量文字）');
    else fail(`R4.3-1 剪贴板内容不符：「${clip}」`);
  }

  // ── R4.1-4 清空对话 ─────────────────────────────────────────────────
  {
    await q(cdp, `(document.querySelector('#modelSearch').value = 'alp', true)`);
    const selBefore = await q(cdp, `document.querySelector('#modelSel').value`);
    await q(cdp, `(document.querySelector('#chatClearBtn').click(), true)`);
    await sleep(250);
    const hist = await q(cdp, `chatHistory.length`);
    const out = await txt('#chatOut');
    const search = await q(cdp, `document.querySelector('#modelSearch').value`);
    const selAfter = await q(cdp, `document.querySelector('#modelSel').value`);
    if (hist === 1 && /等待发送/.test(out)) pass('R4.1-4 清空后历史只剩 system，输出区重置');
    else fail(`R4.1-4 清空异常：history=${hist} out=「${out.slice(0, 40)}」`);
    if (search === 'alp' && selAfter === selBefore) pass('R4.1-4 清空**不影响**模型选择与搜索词');
    else fail(`R4.1-4 清空影响了模型选择/搜索词：search=「${search}」sel=${selAfter} vs ${selBefore}`);
  }
} catch (err) {
  fail(`异常中断：${err.message}`);
} finally {
  cleanup();
}

console.log(failures ? `\n存在 ${failures} 项失败` : '\n全部通过');
process.exit(failures ? 1 : 0);
