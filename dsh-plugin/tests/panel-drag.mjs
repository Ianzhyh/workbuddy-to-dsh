/**
 * 面板「账号排序」拖拽验收（Pointer Events）。
 *
 *   node dsh-plugin/tests/panel-drag.mjs
 *
 * ## 断言什么
 *
 * 1. 按住手柄拖起：行脱离文档流、原位留下占位符，横向与宽度不漂移
 *    （宿主设置弹层带 transform 祖先，fixed 会被它改掉参照物）；
 * 2. 拖拽中滚动页面：拖影继续贴住指针（列表滚动后按列表当前位置重算）；
 * 3. 拖拽中按 Esc：顺序不变、不发请求、不留残余；
 * 4. 松手：提交**整表顺序**（POST /account/order 的 body.order 与最终 DOM 一致）；
 * 5. 全程 `window.__errors` 为空。
 *
 * 用 CDP 发真实鼠标/键盘事件，走的是浏览器完整的 pointer 事件链 ——
 * 合成 `dispatchEvent(new PointerEvent(...))` 测不出 `setPointerCapture`
 * 与 `touch-action` 这类真实路径上的问题。
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startStaticServer, openPage, waitFor, sleep } from '../../tools/dev/ui-harness.mjs';
import { buildRoutes, ensureVendor, harnessHtml, gather } from './_panel-fixtures.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN = join(HERE, '..');
const PORT = 8830;

async function freeCdpPort() {
  const srv = createServer();
  await new Promise((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', resolve);
  });
  const port = srv.address().port;
  await new Promise((resolve) => srv.close(resolve));
  return port;
}

const problems = [];
const check = (ok, message) => { if (!ok) problems.push(message); };

const { data } = await gather({ offline: true });
const { react, reactDom } = await ensureVendor();
const clientSource = readFileSync(join(PLUGIN, 'lib', 'client.js'), 'utf8');
const routes = buildRoutes(data);

const server = await startStaticServer(PORT);
const extra = createServer((req, res) => {
  const path = new URL(req.url, `http://127.0.0.1:${PORT}`).pathname;
  if (path === '/harness.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(harnessHtml(routes));
  }
  if (path === '/client.js') {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
    return res.end(clientSource);
  }
  if (path === '/vendor/react.js') {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
    return res.end(react);
  }
  if (path === '/vendor/react-dom.js') {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
    return res.end(reactDom);
  }
  res.writeHead(404);
  res.end('not found');
});
await new Promise((resolve) => extra.listen(PORT + 1, '127.0.0.1', resolve));

const orderOf = `[...document.querySelectorAll('.wb-account[data-account]')].map((r) => r.dataset.account)`;
const posts = `(window.__reqs || []).filter((r) => String(r.path).includes('account/order'))`;
const dragRowTop = `(() => {
  const r = document.querySelector('.wb-account-pointer-drag');
  return r ? Math.round(r.getBoundingClientRect().top) : null;
})()`;

const page = await openPage(`http://127.0.0.1:${PORT + 1}/harness.html`, {}, {
  width: 1000, height: 1400, injectStub: false, cdpPort: await freeCdpPort(),
});

async function pressAndDrag(geo, steps = 10) {
  await page.cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: geo.fx, y: geo.fy, button: 'left', buttons: 1, clickCount: 1,
  });
  for (let i = 1; i <= steps; i += 1) {
    await page.cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: geo.fx,
      y: Math.round(geo.fy + (geo.ty - geo.fy) * (i / steps)),
      buttons: 1,
    });
    await sleep(18);
  }
}

async function release(geo) {
  await page.cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: geo.fx, y: geo.ty, button: 'left', buttons: 0, clickCount: 1,
  });
}

async function escape() {
  await page.cdp.send('Input.dispatchKeyEvent', {
    type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27,
  });
  await page.cdp.send('Input.dispatchKeyEvent', {
    type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27,
  });
}

try {
  await waitFor(page.cdp, 'window.__harness && window.__harness.rendered === true', 15000, 'panel');
  await sleep(700);
  await page.cdp.evaluate(`window.__setRoute('/workbuddy/console-api/account/order', { ok: true })`);
  /*
   * 再补一个独立账号：三行列表才能把「中间行」拖在离上下边界都远的位置，
   * 滚动跟手测试不会被 rubber-band 干扰（边界阻尼是刻意设计，不是 bug）。
   */
  await page.cdp.evaluate(`(() => {
    const route = window.__routes['/workbuddy/console-api/accounts'];
    route.accounts.push({
      name: 'workbuddy-desktop-eu.info', path: 'C:\\\\auth\\\\workbuddy-desktop-eu.info',
      active: false, usable: true, account: '460000000000', userId: 'uid-fixture-0003',
      domain: 'www.workbuddy.ai', encrypted: true, expiresAt: Date.now() + 342 * 86400000,
      remainingMs: 342 * 86400000, aliasKey: '460000000000', alias: '', hidden: false, sameAccount: 1,
    });
  })()`);
  /*
   * 真实宿主把设置页放在带 transform 的弹层里；transform 会把 fixed 的
   * 参照物改成那个祖先（拖影整体偏移，用户实测"拖拽飘了"）。
   * 这里主动造一个同样的环境，钉住"相对列表定位"这条修复。
   */
  await page.cdp.evaluate(`document.getElementById('frame').style.transform = 'translate(40px, 24px)'`);
  await page.cdp.evaluate(`(() => { const b = [...document.querySelectorAll('.wb-tab')].find((x) => x.textContent === '账号'); if (b) b.click(); return !!b; })()`);
  await waitFor(page.cdp, "document.querySelectorAll('.wb-account[data-account]').length >= 3", 15000, 'accounts');
  await sleep(600);
  await page.cdp.evaluate(`document.querySelector('.wb-account[data-account]').scrollIntoView({ block: 'center', behavior: 'instant' })`);
  await sleep(150);

  /* ── 1. 中间行小幅拖动 + 滚动页面：Esc 取消，顺序不变 ── */
  const geoScroll = await page.cdp.evaluate(`(() => {
    const rows = [...document.querySelectorAll('.wb-account[data-account]')];
    const from = rows[1];
    const grip = from.querySelector('.wb-grip[data-account]');
    const g = grip.getBoundingClientRect();
    return {
      fx: Math.round(g.left + g.width / 2),
      fy: Math.round(g.top + g.height / 2),
      ty: Math.round(g.top + g.height / 2 + 14),
      order: rows.map((r) => r.dataset.account),
    };
  })()`);
  await pressAndDrag(geoScroll, 6);
  const scrollDuring = await page.cdp.evaluate(`(() => {
    const row = document.querySelector('.wb-account-pointer-drag');
    return {
      fixed: !!row,
      placeholder: !!document.querySelector('.wb-account-placeholder'),
      top: row ? Math.round(row.getBoundingClientRect().top) : null,
    };
  })()`);
  check(scrollDuring.fixed, '拖起后行没有脱离文档流（应改为列表内绝对定位）');
  check(scrollDuring.placeholder, '拖起后没有占位符（应留下空位并做 FLIP）');
  const beforeScroll = await page.cdp.evaluate(dragRowTop);
  await page.cdp.evaluate('window.scrollBy(0, 40)');
  await sleep(150);
  const afterScroll = await page.cdp.evaluate(dragRowTop);
  check(beforeScroll !== null && afterScroll !== null && Math.abs(afterScroll - beforeScroll) <= 2,
    `滚动时拖影没有跟住指针：top ${beforeScroll} → ${afterScroll}`);
  await page.cdp.evaluate('window.scrollBy(0, -40)');
  await sleep(150);
  await escape();
  await release(geoScroll);
  await sleep(1000);

  const escaped = await page.cdp.evaluate(`(() => ({
    order: ${orderOf},
    fixed: !!document.querySelector('.wb-account-pointer-drag'),
    placeholder: !!document.querySelector('.wb-account-placeholder'),
    posts: ${posts},
  }))()`);
  check(JSON.stringify(escaped.order) === JSON.stringify(geoScroll.order),
    `Esc 取消后顺序变了：${JSON.stringify(escaped.order)}（应为 ${JSON.stringify(geoScroll.order)}）`);
  check(!escaped.fixed && !escaped.placeholder, 'Esc 取消后仍有拖影/占位符残留');
  check(escaped.posts.length === 0, `Esc 取消不应发排序请求，实际 ${escaped.posts.length} 次`);

  /* ── 2. 首行拖到末尾：松手提交整表顺序 ── */
  const geo = await page.cdp.evaluate(`(() => {
    const rows = [...document.querySelectorAll('.wb-account[data-account]')];
    const first = rows[0];
    const last = rows[rows.length - 1];
    const grip = first.querySelector('.wb-grip[data-account]');
    const g = grip.getBoundingClientRect();
    const t = last.getBoundingClientRect();
    return {
      fx: Math.round(g.left + g.width / 2),
      fy: Math.round(g.top + g.height / 2),
      ty: Math.round(t.bottom - 12),
      expected: [...rows.slice(1).map((r) => r.dataset.account), first.dataset.account],
      rowLeft: Math.round(first.getBoundingClientRect().left),
      rowWidth: Math.round(first.getBoundingClientRect().width),
    };
  })()`);
  await pressAndDrag(geo);
  const during = await page.cdp.evaluate(`(() => {
    const row = document.querySelector('.wb-account-pointer-drag');
    const box = row ? row.getBoundingClientRect() : null;
    return {
      left: box ? Math.round(box.left) : null,
      width: box ? Math.round(box.width) : null,
    };
  })()`);
  check(during.left !== null && Math.abs(during.left - geo.rowLeft) <= 2,
    `拖影横向漂移：left ${during.left}，应在 ${geo.rowLeft}（带 transform 的祖先不应改变参照物）`);
  check(during.width !== null && Math.abs(during.width - geo.rowWidth) <= 2,
    `拖影宽度变了：${during.width}，应为 ${geo.rowWidth}`);
  await release(geo);
  await sleep(1200);

  const after = await page.cdp.evaluate(`(() => ({
    order: ${orderOf},
    fixed: !!document.querySelector('.wb-account-pointer-drag'),
    placeholder: !!document.querySelector('.wb-account-placeholder'),
    posts: ${posts},
  }))()`);
  check(!after.fixed && !after.placeholder, '松手后仍有拖影/占位符残留');
  check(JSON.stringify(after.order) === JSON.stringify(geo.expected),
    `松手后的顺序不对：${JSON.stringify(after.order)}（期望 ${JSON.stringify(geo.expected)}）`);
  check(after.posts.length === 1, `拖动一次应恰好提交一次排序，实际 ${after.posts.length} 次`);
  check(JSON.stringify(after.posts[0]?.body?.order) === JSON.stringify(after.order),
    `提交的顺序与界面不一致：POST ${JSON.stringify(after.posts[0]?.body?.order)} ≠ DOM ${JSON.stringify(after.order)}`);

  const errors = await page.cdp.evaluate('window.__errors || []');
  check(errors.length === 0, `运行时报错：${errors.join(' | ')}`);

  if (problems.length) {
    console.error('账号拖拽验收失败：');
    for (const p of problems) console.error(' - ' + p);
    process.exitCode = 1;
  } else {
    console.log('账号拖拽验收通过：拖影不漂、滚动跟手、Esc 回退、整表顺序提交。');
    console.log('  提交顺序：' + JSON.stringify(after.posts[0].body.order));
  }
} finally {
  try { page.close(); } catch { /* ignore */ }
  try { server.close(); } catch { /* ignore */ }
  try { extra.close(); } catch { /* ignore */ }
}
