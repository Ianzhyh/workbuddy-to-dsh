/**
 * 右栏注册契约（sidebar.right）。
 *
 * 右栏的 body 是 **keyed** 槽，派发键是「tab 类型的 id」。三者必须同时对：
 *   1. `sidebarRightTabs.register({ id, kind, title, guide })` —— 否则右栏不认这一页，
 *      既不会派发 body，空栏里的 guide 卡片也不会出现；
 *   2. `sidebar.right.pane.tab` 的 key = 同一个 id（body）；
 *   3. `sidebar.right.pane.tab.title` 的 key = 同一个 id（chip 文字）。
 *
 * 这三条任何一条断了，界面上都**不报错**，只是右栏里永远看不到 WorkBuddy ——
 * 所以必须在这里钉住。
 *
 * ## 本文件记下的两次真实事故（2026-11-13）
 *
 * 第一版用 `ctx.inject(['sidebarRightTabs'], …)` 当"等服务就绪"的钩子，结果**右栏
 * 里什么都没有**、控制台一个错都没有。两个原因叠在一起：
 *
 *   - 浏览器那半边的 `ctx` 是**受限上下文**（只有 `get / on / provide / effect`），
 *     **没有 `ctx.inject`** —— 那段 `if (typeof ctx.inject === 'function')` 走了
 *     另一支，只试一次；
 *   - `ui-sidebar-right` 是用 `ctx.reflect.provide()` 挂这个服务面的，它**不参与**
 *     cordis 的 inject 依赖追踪；两个插件谁先 apply 也不确定。
 *
 * 于是"只试一次"正好落在服务尚未发布的窗口里：body 与 chip 都注册成功（它们在
 * slots 上，永远可用），只有 tab 类型没注册 —— 静默消失。
 * 现在改成 `ctx.get()` + 有界重试，本文件的最后一个用例就钉这条。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, '..', 'lib', 'client.js'), 'utf8');

/** 极简 React 替身：这里只装配、不渲染，任何 hook 都不需要真的工作。 */
function fakeReact() {
  const noop = () => {};
  return {
    createElement: () => null,
    Fragment: 'Fragment',
    useState: (v) => [v, noop],
    useEffect: noop,
    useCallback: (fn) => fn,
    useRef: (v) => ({ current: v }),
    useMemo: (fn) => fn(),
  };
}

/**
 * 载入真实 bundle，返回它导出的模块对象。
 *
 * `timers` 收集 setTimeout 的回调（不真的等待）：测试可以手动"让时间过去"。
 */
function loadModule({ timers = [] } = {}) {
  const factories = new Map();
  const styleNodes = [];
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(handoff) { factories.set(handoff.id, handoff.factory); },
      },
    },
    // insertStyles() 在 apply 里跑：给它一个只够用的 document（真实渲染由
    // panel-render / rail-render 的无头浏览器覆盖，这里只验注册契约）。
    document: {
      getElementById: () => null,
      createElement: () => {
        const node = { id: '', textContent: '', remove() { const i = styleNodes.indexOf(node); if (i >= 0) styleNodes.splice(i, 1); } };
        return node;
      },
      head: { appendChild: (node) => { styleNodes.push(node); } },
    },
    setTimeout: (fn) => { timers.push(fn); return { unref() {} }; },
    clearTimeout: () => {},
    URL,
    console,
  };
  vm.runInNewContext(SRC, sandbox, { filename: 'client.js' });
  const factory = factories.get('dsh-plugin-workbuddy');
  assert.equal(typeof factory, 'function', 'bundle 没有注册 dsh-plugin-workbuddy');
  return factory((specifier) => {
    if (specifier === 'react') return fakeReact();
    throw new Error('unexpected module request: ' + specifier);
  });
}

/**
 * 与**真实客户端受限上下文**同形：只有 `get / on / provide / effect`。
 *
 * 特别地**没有 `ctx.inject`**，也**不能直接读未注入属性**
 * （`ctx.sidebarRightTabs` 在真实环境会抛 `cannot get property … without inject`）。
 */
function makeCtx({ withTabs = true } = {}) {
  const registrations = [];
  const injected = [];
  const tabTypes = [];
  const slots = {
    inject(name, callback) { injected.push(name); return callback(); },
    register(options, component) { registrations.push({ options, component }); return () => {}; },
  };
  const registry = { register: (def) => { tabTypes.push(def); return () => {}; } };
  let provided = withTabs;
  const ctx = {
    slots,
    get(name) {
      if (name === 'slots') return slots;
      if (name === 'sidebarRightTabs') return provided ? registry : undefined;
      return undefined;
    },
    on() { return () => {}; },
    provide() { return () => {}; },
    effect(fn) { return fn(); },
  };
  return {
    ctx,
    registrations,
    injected,
    tabTypes,
    /** 让服务"晚一步"出现。 */
    provideNow() { provided = true; },
    /** 未注入属性读一次就抛（cordis 代理陷阱的真实语义）。 */
    throwOnPropertyRead(name) {
      Object.defineProperty(ctx, name, {
        get() { throw new Error(`cannot get property "${name}" without inject`); },
        configurable: true,
      });
    },
  };
}

test('右栏：tab 类型 + body + chip 三处用同一个 id 注册', () => {
  const mod = loadModule();
  const { ctx, registrations, injected, tabTypes } = makeCtx();
  mod.apply(ctx);

  assert.equal(tabTypes.length, 1, '应当注册且只注册一个右栏 tab 类型');
  const type = tabTypes[0];
  assert.equal(typeof type.id, 'string');
  assert.ok(type.id.includes('workbuddy'), `tab 类型 id 应能认出属于本插件：${type.id}`);
  assert.equal(typeof type.kind, 'string');
  assert.ok(type.kind.length > 0, 'tab 类型必须有 kind');
  assert.equal(type.priority, 'extension', '优先级用 extension：不抢占内置类型');
  assert.equal(typeof type.title, 'function');
  assert.equal(type.title(), 'WorkBuddy');
  assert.ok(Array.isArray(type.guide) && type.guide.length === 1, 'guide 必须给一张入口卡片');
  assert.equal(type.guide[0].kind, type.kind, 'guide 卡片的 kind 必须指向本类型');
  // 排序键必须是数字：guide 的排序是 `left.order - right.order`，缺省即 NaN，
  // 卡片位置就不确定了（不会报错，只是顺序随实现细节变）。
  assert.equal(typeof type.guide[0].order, 'number', 'guide 卡片必须显式给 order');
  assert.equal(typeof type.guide[0].title, 'function');
  assert.equal(type.guide[0].title(), 'WorkBuddy');
  assert.equal(typeof type.guide[0].description, 'function');
  // 不给图标时右栏画的是默认方块占位（在一排真图标里像"加载失败"），必须自带。
  assert.equal(typeof type.guide[0].icon, 'function', 'guide 卡片必须自带 icon');

  const body = registrations.find((r) => r.options.name === 'sidebar.right.pane.tab');
  const title = registrations.find((r) => r.options.name === 'sidebar.right.pane.tab.title');
  assert.ok(body, '没有注册 sidebar.right.pane.tab');
  assert.ok(title, '没有注册 sidebar.right.pane.tab.title');
  assert.equal(body.options.key, type.id, 'body 的 key 必须等于 tab 类型的 id');
  assert.equal(title.options.key, type.id, 'chip 标题的 key 必须等于 tab 类型的 id');
  assert.equal(typeof body.component, 'function');
  assert.equal(typeof title.component, 'function');

  for (const name of ['sidebar.right.pane.tab', 'sidebar.right.pane.tab.title']) {
    assert.ok(injected.includes(name), `注册没有包在 slots.inject('${name}', …) 里`);
  }
  // 右栏是软依赖，不能写进模块级 inject（否则旧 dsh 上永远等不到）。
  // 注意 `mod.inject` 来自 vm 上下文，数组原型与测试进程不同 —— 用长度 + 逐项比。
  assert.equal(mod.inject.length, 1, '模块级 inject 只应有 slots');
  assert.equal(mod.inject[0], 'slots');
});

test('右栏：设置页与对话页那几处照常注册（互不牵连）', () => {
  const mod = loadModule();
  const { ctx, registrations } = makeCtx();
  mod.apply(ctx);
  const names = registrations.map((r) => r.options.name);
  for (const name of [
    'settings.section',
    'conversation.session.header.utilities',
    'conversation.hero.options',
    'conversation.chat.turnTail',
  ]) {
    assert.ok(names.includes(name), `缺少 ${name} 的注册`);
  }
  const settings = registrations.find((r) => r.options.name === 'settings.section');
  assert.equal(settings.options.id, 'workbuddy');
});

test('旧 dsh（没有 sidebarRightTabs）：右栏静默跳过，其余注册不受影响', () => {
  const mod = loadModule();
  const { ctx, registrations, tabTypes } = makeCtx({ withTabs: false });
  assert.doesNotThrow(() => mod.apply(ctx), '缺少右栏声明表时不能抛错');
  assert.equal(tabTypes.length, 0);
  const names = registrations.map((r) => r.options.name);
  assert.ok(names.includes('settings.section'), '设置页必须仍然注册');
  assert.ok(names.includes('conversation.hero.options'), '对话页那几处必须仍然注册');
});

test('服务晚一步出现：靠有界重试补上 tab 类型（第一次事故的回归）', () => {
  const timers = [];
  const mod = loadModule({ timers });
  const { ctx, tabTypes, provideNow } = makeCtx({ withTabs: false });
  mod.apply(ctx);

  assert.equal(tabTypes.length, 0, 'apply 那一刻服务还没发布，先不注册');
  assert.ok(timers.length >= 1, '必须排一次重试 —— 只试一次就会静默消失');

  provideNow();
  // 让"时间过去"：把排队的回调都跑掉（重试成功后会自己停）
  let guard = 0;
  while (timers.length && guard < 100) {
    const fn = timers.shift();
    guard += 1;
    fn();
  }
  assert.equal(tabTypes.length, 1, '服务出现后必须补上 tab 类型，否则右栏里看不到这一页');
  assert.equal(timers.length, 0, '注册成功后不要继续轮询');
});

test('读未注入的 ctx 属性不会打断 apply（真实受限上下文的抛错语义）', () => {
  const mod = loadModule();
  const { ctx, registrations, tabTypes, throwOnPropertyRead } = makeCtx({ withTabs: false });
  throwOnPropertyRead('sidebarRightTabs');
  assert.doesNotThrow(() => mod.apply(ctx), '属性读取抛错不能连带把设置页一起弄没');
  const names = registrations.map((r) => r.options.name);
  assert.ok(names.includes('settings.section'), '设置页必须仍然注册');
  assert.equal(tabTypes.length, 0, '读不到服务时先不注册（之后由重试补）');
});

test('右栏导出可用于回归：WorkBuddyRail / RAIL_TAB_ID', () => {
  const mod = loadModule();
  assert.equal(typeof mod.WorkBuddyRail, 'function');
  assert.equal(typeof mod.WorkBuddyRailTitle, 'function');
  assert.equal(typeof mod.RAIL_TAB_ID, 'string');
  assert.equal(typeof mod.RAIL_KIND, 'string');
  // 类型 id 与 kind 不同名：id 是「实现身份」，kind 是「页面种类」
  assert.notEqual(mod.RAIL_TAB_ID, mod.RAIL_KIND);
});
