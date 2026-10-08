/**
 * 客户端半边（dsh-plugin/lib/client.js）的**可见性门控**自测。
 *
 * 这一层要钉住的是 D1 那条优化：页面被切到后台时停止轮询，切回来立刻补一次。
 * 两条最关键、而且**写错就会出事**的约束：
 *
 *   1. **`document` 不存在时绝不能抛**。这段代码跑在 dsh 的 Web 客户端里，但客户端
 *      半边也会在非浏览器环境被加载/组装（SSR、纯 Node 的装配测试）。直接写
 *      `document.hidden` 在那些环境里就是 ReferenceError —— 抛在 useEffect 里等于
 *      把整个插件面板打成白屏，而且现场只能看到一句"面板没渲染出来"。
 *      所以文件里必须**同时**有 `typeof document` 判断，且 gating 取值退化成
 *      "一直可见"（少刷新比不刷新严重得多）。
 *   2. **不可见时不留定时器**。只把回调变成空转是不够的：开着的后台标签页里
 *      空转的 setInterval 会一直跑下去。正确做法是 clearInterval 掉，切回来时
 *      再挂上，并且**先补一次数据**（否则用户切回来看到的是最多一个周期前的旧数据）。
 *   3. **别把 reqPause 合并进来**。控制台的「暂停自动刷新」复选框是用户手动意图、
 *      只管请求明细；可见性是浏览器给的事实、暂停全部轮询。两者语义不同，
 *      client.js 里的 `paused ? 0 : 5000`（请求页手动暂停）必须原样保留。
 *
 * 做法：把 client.js 当**数据**读进来做结构断言（点 1、3），再用 Node 的 `vm`
 * 在一个真的能跑 client.js 的沙箱里把 `watchPageVisibility` 与 `useJson` 的行为
 * 跑一遍（点 1、2）。断言的是**真的那份实现**，不是抄来的副本。
 *
 * 为什么不端到端起浏览器：那要拉 Chrome + 起静态服务 + 装 React（见
 * tests/panel-render.mjs），跑一次几十秒且依赖网络；而这里的约束是纯源码结构
 * 与纯函数行为。端到端那层由 panel-render.mjs 负责，两者互补。
 *
 *   node --test dsh-plugin/tests/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, Script } from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT = join(HERE, '..', 'lib', 'client.js');
const source = readFileSync(CLIENT, 'utf8');

/**
 * 在 vm 沙箱里把 client.js 加载起来，返回它内部作用域里的东西。
 *
 * client.js 顶层是 `window.__ModuleLoader__.load({ factory })`，factory 里定义了
 * 我们要验的函数。沙箱提供最小可用的 window/React 桩，factory 一跑就会把
 * `module.exports` 填上 —— 但内部函数不导出。
 * 所以这里走另一条路：给沙箱注入一个"故意空"的 document，看它**跑不跑得起来**；
 * 结构断言则直接读源码。函数级行为用下面 extractFromSource 按源码切片跑。
 */
function loadClientFactory(sandbox) {
  const ctx = createContext(sandbox);
  const script = new Script(source, { filename: CLIENT });
  script.runInContext(ctx);
  return ctx;
}

/** 造一个能跑 client.js 的最小沙箱。`doc` 传 null 就模拟"没有 document"。 */
function makeSandbox({ doc = null, win = undefined } = {}) {
  const registered = [];
  const sandbox = {
    __registered: registered,
    window: win === undefined
      ? {
        __ModuleLoader__: {
          load(registration) { registered.push(registration); },
        },
      }
      : win,
    React: {
      createElement: () => null,
      useState: () => [null, () => {}],
      useEffect: () => {},
      useCallback: (fn) => fn,
      useRef: (v) => ({ current: v }),
      useMemo: (fn) => fn(),
    },
    fetch: () => Promise.resolve({ status: 200, text: () => Promise.resolve('{}') }),
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    console,
    JSON,
    Math,
    Date,
    Number,
    String,
    Boolean,
    Object,
    Array,
    Set,
    Map,
    Promise,
    Error,
    isFinite,
    isNaN,
    parseInt,
    parseFloat,
    encodeURIComponent,
    decodeURIComponent,
    URL,
    Blob: class {},
    navigator: { clipboard: { writeText: () => {} } },
    localStorage: { getItem: () => null, setItem: () => {} },
  };
  if (doc) sandbox.document = doc;
  return sandbox;
}

test('可见性门控：源码必须先判 document 是否存在（硬要求）', () => {
  // 行尾无关：Windows 工作区是 CRLF，直接按字节匹配会让切片与断言随平台漂移
  const norm = source.replace(/\r\n/g, '\n');
  assert.match(norm, /typeof document\s*(?:===|!==)\s*'undefined'/,
    'client.js 里没有 document 存在性守卫 —— 非浏览器环境（SSR）会直接抛死');

  // 这道门必须在 watchPageVisibility 里，而不是别处
  const start = norm.indexOf('function watchPageVisibility');
  assert.ok(start > 0, 'client.js 里找不到 watchPageVisibility');
  const body = norm.slice(start, norm.indexOf('\n    }\n', start));
  // 守卫写法 `=== 'undefined' || !document` 与 `!== 'undefined'` 语义等价，都算数
  assert.match(body, /typeof document\s*(?:===|!==)\s*'undefined'/,
    'watchPageVisibility 自身没有做 document 存在性判断');
  assert.match(body, /return undefined/, 'document 不存在时要能"什么都没装"（返回 undefined）');
});

test('可见性门控：不可见时停掉定时器，切回来先补数据再恢复', () => {
  const effStart = source.indexOf('const startTimer = () =>');
  assert.ok(effStart > 0, '找不到 useJson 里的 startTimer —— 可见性门控没写进去？');
  const eff = source.slice(effStart, source.indexOf('}, [reload, opts.interval, opts.enabled]);', effStart));

  assert.match(eff, /clearInterval\(timer\)/, '不可见时必须 clearInterval，不能留空转的定时器');
  assert.match(eff, /setInterval\(reload, opts\.interval\)/, '恢复可见时要把定时器挂回去');

  // 恢复路径里 reload() 必须**早于** startTimer()
  const resumeStart = eff.indexOf('const onVisibilityChange');
  assert.ok(resumeStart > 0, '找不到 onVisibilityChange —— 可见性回调没写');
  const resume = eff.slice(resumeStart, eff.indexOf('// 挂载时如果页面本来就是隐藏的', resumeStart));
  const reloadAt = resume.indexOf('reload()');
  const startAt = resume.indexOf('startTimer()');
  assert.ok(reloadAt > 0 && startAt > 0, '切回可见的分支里必须同时补数据和恢复定时');
  assert.ok(reloadAt < startAt, '必须先 reload() 再 startTimer()，否则切回来要干等一个周期');

  // 挂载时页面本来就是隐藏的 → 不能起定时器；但也**不能**顺手 reload（首帧会连打两次）
  assert.match(eff, /document\.hidden === true\) stopTimer\(\);/, '挂载时页面已隐藏却仍起了定时器');
});

test('可见性门控：控制台的 reqPause 语义没有被合并进来（两件事）', () => {
  // 「暂停自动刷新」= 用户手动意图，只管请求明细；可见性 = 浏览器事实，管全部轮询。
  // client.js 里请求页的手动暂停仍然是 paused ? 0 : 5000，不该被可见性改写。
  assert.match(source, /interval: paused \? 0 : 5000/,
    '请求页的"暂停自动刷新"被改动了 —— 它与可见性暂停是两件事，不能合并');
  // 可见性门控不该去读任何"暂停"复选框状态
  const gate = source.slice(source.indexOf('function watchPageVisibility'), source.indexOf('const styleId'));
  assert.doesNotMatch(gate, /paused|reqPause/, '可见性门控里掺进了 reqPause —— 两者必须独立');
});

test('可见性门控：没有 document 时（SSR）加载 client.js 不抛，且不装任何监听', () => {
  // 这正是非浏览器环境的形状：没有 document
  const ctx = makeSandbox({ doc: null });
  assert.doesNotThrow(() => loadClientFactory(ctx), 'client.js 在没有 document 的环境里加载时抛了');
  assert.equal(ctx.__registered.length, 1, 'bundle 应该照常注册（不能因为门控而整个不注册）');
});

test('可见性门控：watchPageVisibility 真跑一遍（有 document / 无 document）', () => {
  const impl = extractWatchPageVisibility();

  // (a) 无 document：返回 undefined，不抛 —— SSR 那条硬要求
  assert.equal(impl({}, () => { throw new Error('不该被调用'); }), undefined);

  // (b) 有 document：只在状态真的翻转时回调，注销后不再回调
  const docListeners = [];
  const winListeners = [];
  const doc = {
    hidden: true,
    addEventListener: (type, cb) => { docListeners.push({ type, cb }); },
    removeEventListener: () => {},
  };
  const win = {
    addEventListener: (type, cb) => { winListeners.push({ type, cb }); },
    removeEventListener: () => {},
  };
  const calls = [];
  const unwatch = impl({ document: doc, window: win }, (hidden) => calls.push(hidden));

  assert.equal(typeof unwatch, 'function', '有 document 时要返回注销函数');
  assert.ok(docListeners.some((l) => l.type === 'visibilitychange'), '必须听 visibilitychange');
  assert.ok(winListeners.some((l) => l.type === 'focus'), 'focus 是兜底（部分宿主不派发 visibilitychange）');
  assert.ok(winListeners.some((l) => l.type === 'pageshow'), 'pageshow 是 bfcache 恢复的兜底');

  const fireVis = () => docListeners.filter((l) => l.type === 'visibilitychange').forEach((l) => l.cb());
  const fireFocus = () => winListeners.filter((l) => l.type === 'focus').forEach((l) => l.cb());

  fireVis();
  assert.deepEqual(calls, [], '状态没变（一直 hidden）不该回调');

  doc.hidden = false;
  fireVis();
  assert.deepEqual(calls, [false], '变回可见要回调 hidden=false');

  fireFocus();
  assert.deepEqual(calls, [false], '重复事件不应重复回调（状态机去重，避免多打请求）');

  doc.hidden = true;
  fireVis();
  assert.deepEqual(calls, [false, true], '再次隐藏要回调 hidden=true');
});

/**
 * 把 client.js 里的 watchPageVisibility 抠出来单独跑。
 *
 * 为什么要切片：factory 内部函数不导出，而整个 client.js 又依赖 React。
 * 这个函数**不依赖 React**（纯事件订阅），所以按源码切片 + vm 跑是最贴近真实的
 * 验法 —— 断言的是真的那份实现，不是抄来的副本。
 *
 * 切法用**配对计数**而不是找第一个 `\n    }\n`：函数体里嵌着 `onChange` 这个
 * 闭包，它的收尾大括号也是 4 空格缩进，朴素查找会提前切断（切出半个函数，
 * vm 报 "Unexpected token"）。这里显式配对大括号，并且跳过字符串/模板串/注释 ——
 * 函数里有 `'visibilitychange'` 这种字面量，不跳的话引号里的括号会算错。
 */
function extractWatchPageVisibility() {
  const start = source.indexOf('    function watchPageVisibility');
  assert.ok(start > 0, 'client.js 里找不到 watchPageVisibility');
  const open = source.indexOf('{', start);
  assert.ok(open > start, 'watchPageVisibility 没有函数体');

  let depth = 0;
  let quote = null;       // 当前所处的引号类型（' " `）
  let lineComment = false;
  let blockComment = false;
  let end = -1;

  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    const next = source[i + 1];

    if (lineComment) { if (ch === '\n') lineComment = false; continue; }
    if (blockComment) { if (ch === '*' && next === '/') { blockComment = false; i += 1; } continue; }
    if (quote) {
      if (ch === '\\') { i += 1; continue; }
      // 模板串里可能嵌 ${}，这个函数里没有；遇到同类引号即结束
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '/' && next === '/') { lineComment = true; i += 1; continue; }
    if (ch === '/' && next === '*') { blockComment = true; i += 1; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }

    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) { end = i; break; }
    }
  }
  assert.ok(end > open, 'watchPageVisibility 的收尾大括号配对失败');

  const snippet = source.slice(start, end + 1);
  const script = new Script(`(${snippet.replace(/^\s+/, '')})`);
  return (sandbox, onChange) => {
    // onStateChange 必须**同时**挂在沙箱对象与该对象的副本上：
    // 注入 context 的是 `{ ...sandbox, onStateChange }`，而函数体引用的是
    // context 里的名字 —— 只改沙箱原对象（或只改副本）都会让它是 undefined。
    const ctx = createContext({ ...sandbox, onStateChange: onChange });
    const fn = script.runInContext(ctx);
    return fn(ctx.onStateChange);
  };
}

// ─────────────────── 控制台 index.html 的轮询调度器 ───────────────────
//
// `createPollScheduler` 跑在 dashboard/public/index.html 的内联脚本里，页面本身
// 没有测试入口。做法：把那段**纯函数**切片 → 在 vm 里配假定时器跑一遍。
//
// 为什么非测不可：这段逻辑的难点全在**状态机**，而不是"有没有调 setInterval"。
// 它已经出过一次真事故 —— `resumePollsNow()` 里那个 `if (wasRunning)` 守卫，
// 让「页面一开始就是隐藏的 → 用户切到该标签页」这条路径**永久停更**：
// 补了一次数据，但定时器再也没起来，而且用户看不到任何报错。
// 所以下面的用例专门盯着边界，而不是只验证"正常路径能跑"。

test('控制台调度器：初始可见时起手就把三个定时器挂上，周期正确', () => {
  const h = makeSchedulerHarness();
  assert.equal(h.scheduler.isRunning(), true);
  assert.equal(h.live(), 3, '三个轮询项应各有一个定时器');
  // 周期写错等于把轮询节奏改了：20s / 30s / 60s
  assert.deepEqual(h.created.map((t) => t.ms).sort((a, b) => a - b), [20000, 30000, 60000]);
});

test('控制台调度器【回归】初始隐藏 → 切到可见：定时器必须真的起来（曾经永久停更）', () => {
  const h = makeSchedulerHarness({ startHidden: true });

  assert.equal(h.live(), 0, '初始隐藏时不该起定时器（那是纯空转）');
  assert.equal(h.scheduler.isRunning(), false);

  // 用户切到这个标签页
  h.setHidden(false);

  // 这两条就是事故本身：数据补了，定时器也必须**同时**起来
  assert.equal(h.scheduler.isRunning(), true, '切回可见后定时器没启动 —— 页面会静默停更');
  assert.equal(h.live(), 3, '切回可见后应当有 3 个活着的定时器');
  assert.deepEqual(h.created.map((t) => t.ms).sort((a, b) => a - b), [20000, 30000, 60000]);
  assert.equal(h.runs(), 3, '切回可见要先补一次数据（三个轮询项各一次）');
});

test('控制台调度器：切回可见必须"先补数据、再恢复定时"（顺序反了要干等一个周期）', () => {
  const order = [];
  const created = []; let id = 1;
  const st = { hidden: false };
  const sch = createConsoleScheduler({
    isHidden: () => st.hidden,
    setTimer: (fn, ms) => { const t = { fn, ms, id: id += 1, cleared: false }; created.push(t); order.push('setTimer'); return t; },
    clearTimer: (t) => { if (t) t.cleared = true; },
    pollers: [{ every: 1000, run: () => order.push('run') }],
  });

  sch.sync();                       // 初始可见：sync 是 no-op（起手已经起了定时器）
  st.hidden = true; sch.sync();     // 隐藏：停
  order.length = 0;                 // 只观察"切回来"那一次的顺序
  st.hidden = false; sch.sync();

  assert.deepEqual(order, ['run', 'setTimer'],
    `期望"先补数据再起定时器"，实际 ${JSON.stringify(order)}`);
  assert.equal(sch.isRunning(), true);
  assert.equal(created.filter((t) => !t.cleared).length, 1);
});

test('控制台调度器：隐藏时清掉全部定时器，反复切换不泄漏', () => {
  const h = makeSchedulerHarness();
  assert.equal(h.live(), 3);

  h.setHidden(true);
  assert.equal(h.live(), 0, '隐藏时必须 clearInterval，不能留空转的定时器');
  assert.equal(h.scheduler.isRunning(), false);

  // 反复切换若干轮：活着的定时器数必须回到 3，而不是越滚越多
  for (let i = 0; i < 5; i += 1) { h.setHidden(false); h.setHidden(true); }
  h.setHidden(false);
  assert.equal(h.live(), 3, `反复切换后活着 ${h.live()} 个定时器 —— 有泄漏或没恢复`);

  h.scheduler.dispose();
  assert.equal(h.live(), 0, 'dispose 必须清干净');
});

test('控制台调度器：已可见时的重复事件不会重复补数据', () => {
  const h = makeSchedulerHarness();
  h.setHidden(true);
  h.setHidden(false);
  assert.equal(h.runs(), 3, '第一次切回来补一轮（三项各一次）');

  // 浏览器切一次标签页常一次派发多个事件（visibilitychange + focus + pageshow）。
  // 已经可见时再来几个，不该再补数据（否则每切一次就多打一轮全量请求）。
  h.pokeEvent();
  h.pokeEvent();
  assert.equal(h.runs(), 3, `状态没变的重复事件补了数据（共 ${h.runs()} 次）`);

  // 隐藏状态下收到重复事件同样不该有任何动作
  h.setHidden(true);
  const afterHide = h.runs();
  h.pokeEvent();
  assert.equal(h.runs(), afterHide, '隐藏时重复事件不该补数据');
});

/** 造一套假定时器 + 可控可见性，用于跑 createPollScheduler。 */
function makeSchedulerHarness({ startHidden = false } = {}) {
  const created = [];   // setInterval 起来的定时器：{ms, cleared}
  let nextId = 1;
  const state = { hidden: startHidden };
  let runCount = 0;

  const scheduler = createConsoleScheduler({
    isHidden: () => state.hidden,
    setTimer: (fn, ms) => { const t = { fn, ms, id: nextId += 1, cleared: false }; created.push(t); return t; },
    clearTimer: (t) => { if (t) t.cleared = true; },
    // 三个假轮询项：周期与真实页面一致，好顺带断言周期没被改错
    pollers: [
      { every: 20000, run: () => { runCount += 1; } },
      { every: 30000, run: () => { runCount += 1; } },
      { every: 60000, run: () => { runCount += 1; } },
    ],
  });

  return {
    scheduler,
    created,
    /** 当前**活着**的定时器数量。 */
    live: () => created.filter((t) => !t.cleared).length,
    /** 定时器回调（= 补数据）被调用的累计次数。 */
    runs: () => runCount,
    /** 模拟"可见性变了"：改状态再 sync（等价于浏览器派发 visibilitychange）。 */
    setHidden(h) { state.hidden = h; scheduler.sync(); },
    /**
     * 模拟"又收到一个可见性事件，但状态没变"（浏览器切标签页常一次派发多个：
     * visibilitychange + focus + pageshow）。sync() 自己会按状态去重。
     */
    pokeEvent() { scheduler.sync(); },
  };
}

/**
 * 从 index.html 切片 `createPollScheduler` 并在 vm 里求值。
 *
 * 只取这一个**纯函数**：它不引用页面里任何 DOM/全局（依赖全部由参数注入），
 * 所以能干净地在 vm 里跑。切法与上面同一个配对计数逻辑 —— 这段函数体里也有
 * 字符串字面量（'hidden' 之类没有，但注释里含括号），必须跳过引号与注释。
 */
function createConsoleScheduler(deps) {
  const html = readFileSync(join(HERE, '..', '..', 'dashboard', 'public', 'index.html'), 'utf8');
  const start = html.indexOf('function createPollScheduler(');
  assert.ok(start > 0, 'index.html 里找不到 createPollScheduler —— 调度器被改名/删了？');
  // 注意：不能取"签名后的第一个 `{`" —— 那是**解构参数**的括号
  // （`createPollScheduler({ pollers: ... })`），配对的 `}` 正好在参数表末尾，
  // 计数会在那里就归零，切出一个 60 字符的残片（vm 报 "Unexpected end of input"）。
  // 正确的函数体起点是参数表的 `)` 之后的第一个 `{`。
  const paramOpen = html.indexOf('{', start);
  const paramClose = html.indexOf(')', paramOpen);
  assert.ok(paramClose > paramOpen, 'createPollScheduler 的参数表没有收尾');
  const open = html.indexOf('{', paramClose);
  assert.ok(open > paramClose, 'createPollScheduler 没有函数体');

  let depth = 0; let quote = null; let lineComment = false; let blockComment = false; let end = -1;
  for (let i = open; i < html.length; i += 1) {
    const ch = html[i]; const next = html[i + 1];
    if (lineComment) { if (ch === '\n') lineComment = false; continue; }
    if (blockComment) { if (ch === '*' && next === '/') { blockComment = false; i += 1; } continue; }
    if (quote) { if (ch === '\\') { i += 1; continue; } if (ch === quote) quote = null; continue; }
    if (ch === '/' && next === '/') { lineComment = true; i += 1; continue; }
    if (ch === '/' && next === '*') { blockComment = true; i += 1; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth += 1;
    else if (ch === '}') { depth -= 1; if (depth === 0) { end = i; break; } }
  }
  assert.ok(end > open, 'createPollScheduler 的大括号配对失败');

  const snippet = html.slice(start, end + 1);
  const ctx = createContext({});
  const fn = new Script(`(${snippet})`).runInContext(ctx);
  return fn({
    pollers: deps.pollers,
    isHidden: deps.isHidden,
    setTimer: deps.setTimer,
    clearTimer: deps.clearTimer,
    subscribe: undefined,
  });
}
