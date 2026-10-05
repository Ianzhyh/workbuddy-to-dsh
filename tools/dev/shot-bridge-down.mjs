/**
 * 桥未运行时，控制台各面板呈现什么。
 *
 *   node tools/dev/shot-bridge-down.mjs
 *
 * 这是最常见的故障态，也是「新用户第一次打开」的高频场景 —— 值得定期看一眼。
 * 输出到 docs/_review/（下划线前缀已被 .gitignore 忽略，属临时审查产物）。
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { startStaticServer, openPage, q, sleep } from './ui-harness.mjs';
import { baseRoutes } from './fixtures.mjs';

const PORT = 8782;
const OUTDIR = join(process.cwd(), 'docs', '_review');
mkdirSync(OUTDIR, { recursive: true });

// 桥挂掉时的桩：桥不跑、凭据读不到、诊断里有三条 fail。
// 注意诊断条目的字段是 id / label / status / detail / hint —— 不是 level / name / fix，
// 写错的话面板会渲染出一串 undefined，而页面看起来仍然「有内容」。
const routes = baseRoutes({ bridgeRunning: false, active: false, quota: null, dshReady: false });
/*
 * 桥不跑时，这些接口也拿不到数据 —— 桩必须**自洽**，否则会看到一个现实中
 * 不存在的组合（桥挂了却显示 4 个可用模型），据此得出的结论全是错的。
 */
routes['/api/models'] = { body: { models: [] } };
routes['/api/usage'] = { body: { usage: null } };
routes['/api/requests'] = { body: { requests: [] } };
routes['/api/accounts'] = { body: { dir: 'C:\\path\\to\\auth', active: '', accounts: [], keyError: null } };
// 桥没跑时，真实接口回的是 {ok:false, error}，**不带 status**。
// 写成 {status:{active:false}} 会让页面显示「国际版网关不含积分系统」——
// 看起来像产品在无依据地下结论，其实是桩错了（这个坑真踩过）。
routes['/api/checkin'] = {
  body: { ok: false, error: 'connect ECONNREFUSED 127.0.0.1:8790', checkin: { auto: true, lastAt: null, lastResult: null, lastError: null, lastSource: null } },
};
routes['/api/diagnose'] = {
  body: {
    items: [
      { id: 'app', label: 'WorkBuddy 客户端', status: 'fail', detail: '未找到可执行文件', hint: '安装 WorkBuddy 桌面端，或在 .env 里指定 WORKBUDDY_APP_EXECUTABLE' },
      { id: 'authfile', label: '登录文件', status: 'fail', detail: '指定的文件不存在', hint: '在 WorkBuddy 桌面端登录一次' },
      { id: 'bridge', label: '桥服务', status: 'fail', detail: '127.0.0.1:8790 无响应', hint: '点上方「启动桥服务」' },
      { id: 'settings', label: 'dsh 模型路由', status: 'warn', detail: '尚未配置 workbuddy 路由', hint: '在「可用模型」里勾选后保存' },
    ],
    summary: { fail: 3, warn: 1, ok: 0 },
    bridge: { running: false, ok: false, body: null },
    credentials: { files: [], active: null, error: '无法读取登录目录：ENOENT', authFile: 'C:\\path\\to\\workbuddy-desktop.info' },
    dsh: {
      home: 'C:\\path\\to\\.dsh', settingsPath: 'C:\\path\\to\\.dsh\\settings.yaml',
      credentialsPath: 'C:\\path\\to\\.dsh\\.credentials.yaml', patchPath: 'C:\\path\\to\\.dsh\\profiles\\desktop\\cordis.patch.yml',
      settingsExists: false, settingsHasRoute: false, patchHasRoute: false,
      settingsText: '', settingsModels: [], patchModels: [],
      registeredModels: [], hasBridgeKey: false, refNames: [],
      bundles: [], bundlesOk: false, routeLive: false, routeSource: null,
    },
  },
};

const server = await startStaticServer(PORT);
const { cdp, close } = await openPage(`http://127.0.0.1:${PORT}/`, routes, { width: 1280, height: 1000 });
await sleep(1500);

const info = await q(cdp, `(() => {
  const panels = [...document.querySelectorAll('[data-section]')].filter((s) => s.style.display !== 'none');
  return panels.map((p) => ({
    sec: p.dataset.section,
    h2: (p.querySelector('h2')?.textContent || '').trim().slice(0, 24),
    text: (p.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 120),
  }));
})()`);
console.log('桥未运行时，各面板呈现：');
for (const p of info) console.log(`  [${p.sec}] ${p.h2}\n      ${p.text}\n`);

const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
writeFileSync(join(OUTDIR, 'bridge-down.png'), Buffer.from(shot.result.data, 'base64'));
console.log('wrote', join(OUTDIR, 'bridge-down.png'));

close();
server.close();
