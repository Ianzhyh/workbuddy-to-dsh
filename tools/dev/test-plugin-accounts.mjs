/**
 * 账号列表「插件凭据并进桌面账号」验收（控制台侧）。
 *
 *   node tools/dev/test-plugin-accounts.mjs
 *
 * 盯四件事：
 *   1. 同账号的桌面行与插件凭据合并成一行（不重复渲染），并标「双凭据」。
 *   2. 桌面端没有的插件账号追加到同一个列表，标「插件」，且不参与桌面排序。
 *   3. 「用插件凭据 / 使用」都先设 active、再把来源切到 plugin（一步到位）。
 *   4. 英文模式下合并行与插件独有行的文案都翻掉。
 */
import { startStaticServer, openPage, waitFor, q, sleep } from './ui-harness.mjs';
import { baseRoutes } from './fixtures.mjs';

const PORT = 8841;
const URL_ = `http://127.0.0.1:${PORT}/`;

let failures = 0;
const fail = (m) => { console.error('✗ ' + m); failures += 1; };
const pass = (m) => console.log('✓ ' + m);

const now = Date.now();
const SHARED = 'uid-shared';
const mk = (name, account, active, extra = {}) => ({
  name, path: `C:\\auth\\${name}`, active, usable: true, account,
  domain: 'copilot.tencent.com', encrypted: true, aliasKey: account,
  expiresAt: now + 30 * 86400000, remainingMs: 30 * 86400000,
  modifiedAt: now - 3600000, alias: '', hidden: false, ...extra,
});
const D1 = mk('desktop-a.info', '330000000001', true, { userId: SHARED });
const D2 = mk('desktop-b.info', '450000000002', false, { userId: 'uid-desktop-only' });

const pluginLogin = {
  ok: true,
  configured: 'auto',
  envPinned: false,
  storeMode: 'dpapi',
  failover: 'same-account',
  fallbackReason: '',
  desktop: { available: true, error: '', userId: SHARED },
  plugin: { available: true, count: 2, activeUid: SHARED, uids: [SHARED, 'uid-plugin-only'], error: '' },
  sameAccount: true,
  effective: { source: 'desktop', uid: '', region: 'cn', endpoint: '', expiresAt: '' },
  credentials: [
    {
      uid: SHARED, region: 'cn', nickname: 'SharedPlugin', enterpriseId: '',
      domain: 'example.invalid', expiresAt: new Date(now + 86400000).toISOString(),
      updatedAt: new Date(now).toISOString(), active: true,
    },
    {
      uid: 'uid-plugin-only', region: 'global', nickname: 'StandalonePlugin', enterpriseId: '',
      domain: 'example.invalid', expiresAt: new Date(now + 86400000).toISOString(),
      updatedAt: new Date(now).toISOString(), active: false,
    },
  ],
};

const routes = {
  ...baseRoutes({ accounts: [D1, D2] }),
  '/api/login': { body: pluginLogin },
  '/api/login/active': { body: { ok: true } },
  '/api/login/source': { body: { ok: true, configured: 'plugin', envPinned: false, storeMode: 'dpapi', credentials: pluginLogin.credentials } },
};

const server = await startStaticServer(PORT);
const { cdp, close } = await openPage(URL_, routes);
const cleanup = () => { try { cdp.close(); } catch { /* 忽略 */ } try { server.close(); } catch { /* 忽略 */ } };
process.on('exit', cleanup);

const posts = (path) => q(cdp, `window.__reqs.filter((r) => r.path === ${JSON.stringify(path)})`);
const resetReqs = () => q(cdp, `(window.__reqs = [], true)`);
const rows = () => q(cdp, `Array.from(document.querySelectorAll('#accountList .acct')).map((r) => ({
  file: r.getAttribute('data-acct'),
  pluginUid: r.getAttribute('data-plugin-acct'),
  text: r.textContent,
  grip: !!r.querySelector('[data-grip]'),
  usePlugin: r.querySelector('[data-use-plugin]') ? r.querySelector('[data-use-plugin]').dataset.usePlugin : null,
  logout: r.querySelector('[data-plugin-logout]') ? r.querySelector('[data-plugin-logout]').dataset.pluginLogout : null,
}))`);

try {
  await waitFor(cdp, `document.querySelectorAll('#accountList .acct').length === 3`, 10000, '合并后的账号列表');
  await sleep(300);

  // ── 1. 同账号合并 + 插件独有账号并进同一列表 ───────────────────────
  {
    const list = await rows();
    if (list.length === 3) pass('2 个桌面账号 + 1 个插件独有账号 = 3 行');
    else fail(`应有 3 行，实际 ${list.length}`);

    const sharedRows = list.filter(r => r.text.includes('SharedPlugin') || r.file === D1.name);
    if (sharedRows.length === 1) pass('同账号的插件凭据并进桌面行，没有重复行');
    else fail(`同账号出现 ${sharedRows.length} 行`);

    const desktopA = list.find(r => r.file === D1.name);
    if (desktopA && desktopA.text.includes('双凭据') && desktopA.text.includes('SharedPlugin')) {
      pass('桌面行标「双凭据」并带插件凭据副行');
    } else fail(`桌面行缺双凭据标记：${desktopA && desktopA.text}`);

    if (desktopA && desktopA.usePlugin === SHARED) pass('桌面行有「用插件凭据」并指向同账号凭据');
    else fail(`桌面行的插件凭据按钮不对：${desktopA && desktopA.usePlugin}`);

    const standalone = list.find(r => r.pluginUid === 'uid-plugin-only');
    if (standalone && standalone.text.includes('插件') && standalone.text.includes('StandalonePlugin')) {
      pass('插件独有账号在同一列表里，标「插件」');
    } else fail(`插件独有账号没有并进列表：${standalone && standalone.text}`);
    if (standalone && standalone.logout === 'uid-plugin-only' && !standalone.grip && standalone.file === null) {
      pass('插件独有行有「退出」、没有拖拽手柄、不参与桌面排序');
    } else fail(`插件独有行结构不对：${JSON.stringify(standalone)}`);
  }

  // ── 2. 插件独有行「使用」：先 active 再切来源 ───────────────────────
  {
    await resetReqs();
    const ok = await q(cdp, `(() => {
      const row = document.querySelector('#accountList .acct[data-plugin-acct="uid-plugin-only"]');
      const btn = row && row.querySelector('[data-use-plugin]');
      if (!btn) return false;
      btn.click();
      return true;
    })()`);
    if (!ok) fail('点不到插件独有行的「使用」');
    await sleep(600);
    const active = (await posts('/api/login/active'))[0];
    const source = (await posts('/api/login/source'))[0];
    if (active && active.body.uid === 'uid-plugin-only') pass('「使用」先把该插件凭据设为 active');
    else fail(`active 请求不对：${JSON.stringify(active && active.body)}`);
    if (source && source.body.source === 'plugin') pass('「使用」随后把来源切到 plugin');
    else fail(`source 请求不对：${JSON.stringify(source && source.body)}`);
  }

  // ── 3. 桌面行「用插件凭据」走同一条路径 ─────────────────────────────
  {
    await resetReqs();
    const ok = await q(cdp, `(() => {
      const row = document.querySelector('#accountList .acct[data-acct="${D1.name}"]');
      const btn = row && row.querySelector('[data-use-plugin]');
      if (!btn) return false;
      btn.click();
      return true;
    })()`);
    if (!ok) fail('点不到桌面行的「用插件凭据」');
    await sleep(600);
    const active = (await posts('/api/login/active'))[0];
    const source = (await posts('/api/login/source'))[0];
    if (active && active.body.uid === SHARED) pass('桌面行切插件凭据：active = 同账号 uid');
    else fail(`active 请求不对：${JSON.stringify(active && active.body)}`);
    if (source && source.body.source === 'plugin') pass('桌面行切插件凭据：来源切到 plugin');
    else fail(`source 请求不对：${JSON.stringify(source && source.body)}`);
  }

  // ── 4. 英文：合并行与插件独有行都不残留中文 ─────────────────────────
  {
    await q(cdp, `document.getElementById('langToggle').click()`);
    await sleep(500);
    const cjk = await q(cdp, `(() => {
      const m = document.querySelector('#accountList').textContent.match(/[\\u4e00-\\u9fff]/g);
      return m ? [...new Set(m)].join('') : '';
    })()`);
    if (!cjk) pass('英文模式下账号列表无残留中文');
    else fail(`英文模式仍有中文：${cjk}`);
  }
} catch (err) {
  fail(`异常中断：${err.message}`);
} finally {
  cleanup();
}

console.log(failures ? `\n存在 ${failures} 项失败` : '\n全部通过');
process.exit(failures ? 1 : 0);
