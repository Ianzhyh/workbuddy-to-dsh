/**
 * CDP 交互测试：验证控制台的模型表格在 20 秒轮询后**不会冲掉用户的 UI 状态**。
 *
 * 步骤：输入搜索词 → 勾选一个未注册的模型 → 跨越一次轮询 → 复查两者是否还在。
 *
 * 用法：先启动控制台（node dashboard/server.mjs），再运行本脚本。
 *      node tools/dev/test-ui-state.mjs
 *
 * 用 Node 内置 WebSocket（22+ 自带），无需依赖。
 */
const CDP_PORT = process.env.CDP_PORT || 9222;
const PAGE = process.env.PAGE_URL || 'http://127.0.0.1:8792/';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForDevtools() {
  for (let i = 0; i < 40; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
      const targets = await res.json();
      const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      /* devtools 还没起来 */
    }
    await sleep(250);
  }
  throw new Error('无法连接 DevTools，请确认 Chromium 已用 --remote-debugging-port 启动');
}

/** 极简 CDP 客户端：只用到 Runtime.evaluate。 */
function connect(url) {
  const ws = new WebSocket(url);
  let id = 0;
  const pending = new Map();

  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });

  const ready = new Promise((ok, fail) => {
    ws.addEventListener('open', ok);
    ws.addEventListener('error', () => fail(new Error('WebSocket 连接失败')));
  });

  const send = (method, params = {}) => new Promise((ok) => {
    id += 1;
    pending.set(id, ok);
    ws.send(JSON.stringify({ id, method, params }));
  });

  const evaluate = async (expression) => {
    const res = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.result && res.result.exceptionDetails) {
      throw new Error(res.result.exceptionDetails.text);
    }
    return res.result && res.result.result ? res.result.result.value : undefined;
  };

  return { ready, evaluate, close: () => ws.close() };
}

const fail = (msg) => { console.error('✗ ' + msg); process.exitCode = 1; };
const pass = (msg) => console.log('✓ ' + msg);

const wsUrl = await waitForDevtools();
const cdp = connect(wsUrl);
await cdp.ready;

// 等页面把数据加载完
for (let i = 0; i < 40; i += 1) {
  const rows = await cdp.evaluate('document.querySelectorAll("#modelTable tbody tr").length');
  if (rows > 0) break;
  await sleep(500);
}

const totalRows = await cdp.evaluate('document.querySelectorAll("#modelTable tbody tr").length');
console.log(`模型表格已渲染 ${totalRows} 行\n`);
if (!totalRows) {
  fail('表格没有渲染任何行，后续测试无意义');
  cdp.close();
  process.exit(1);
}

// 记下轮询前的状态
const before = await cdp.evaluate(`(() => {
  const f = document.getElementById('modelFilter');
  f.value = 'glm';
  f.dispatchEvent(new Event('input', { bubbles: true }));
  const box = document.querySelector('#modelTable tbody tr input[data-id]:not(:checked)');
  if (box) { box.checked = true; box.dispatchEvent(new Event('change', { bubbles: true })); }
  return {
    filter: f.value,
    visible: [...document.querySelectorAll('#modelTable tbody tr')].filter(t => t.style.display !== 'none').length,
    picked: box ? box.dataset.id : null,
    checked: document.querySelectorAll('#modelTable tbody input[data-id]:checked').length,
  };
})()`);

console.log('轮询前：', JSON.stringify(before));

// 跨越一到两次轮询（间隔 20s）
console.log('\n等待 25 秒以跨越轮询…');
await sleep(25000);

const after = await cdp.evaluate(`(() => {
  const f = document.getElementById('modelFilter');
  const picked = ${JSON.stringify(before.picked)};
  const box = picked ? document.querySelector('#modelTable tbody input[data-id="' + picked + '"]') : null;
  return {
    filter: f ? f.value : null,
    visible: [...document.querySelectorAll('#modelTable tbody tr')].filter(t => t.style.display !== 'none').length,
    pickedStillChecked: box ? box.checked : null,
    checked: document.querySelectorAll('#modelTable tbody input[data-id]:checked').length,
  };
})()`);

console.log('轮询后：', JSON.stringify(after));
console.log('');

if (after.filter !== before.filter) fail(`搜索词被重置：${before.filter} → ${after.filter}`);
else pass('搜索词保留');

if (after.visible !== before.visible) fail(`过滤结果变了：${before.visible} → ${after.visible} 行`);
else pass(`过滤结果保持（${after.visible} 行）`);

if (before.picked && after.pickedStillChecked !== true) fail(`勾选被丢弃：${before.picked}`);
else if (before.picked) pass(`未保存的勾选保留（${before.picked}）`);

if (after.checked !== before.checked) {
  fail(`勾选总数变化：${before.checked} → ${after.checked}`);
} else {
  pass(`勾选总数一致（${after.checked}）`);
}

cdp.close();
console.log(process.exitCode ? '\n存在失败项' : '\n全部通过');
