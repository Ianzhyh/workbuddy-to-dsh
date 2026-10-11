/**
 * 像素验证：焦点环真的画出来了吗？
 *
 * 上面的焦点探针只能证明"聚焦后计算样式变了" —— 但计算样式变了不等于**屏幕上看得见**
 * （环色可能与背景太接近、可能被祖先裁掉）。这里截"聚焦前 / 聚焦后"两张图做差分，
 * 并算出环色与相邻背景的对比度。
 *
 *   node tools/dev/probe-focus-pixel.mjs
 */
import { writeFileSync } from 'node:fs';
import { startStaticServer, openPage, waitFor, q, sleep } from './ui-harness.mjs';
import { baseRoutes } from './fixtures.mjs';

const PORT = 8797;
const server = await startStaticServer(PORT);
const { cdp, close } = await openPage(`http://127.0.0.1:${PORT}/`, baseRoutes(), { width: 1440, height: 900 });

/** 截指定矩形（比目标大一圈，好把外扩的环一起框进来）。 */
async function shot(cdp, box, pad = 10) {
  const res = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    clip: { x: box.x - pad, y: box.y - pad, width: box.w + pad * 2, height: box.h + pad * 2, scale: 2 },
  });
  return Buffer.from(res.result.data, 'base64');
}

try {
  await waitFor(cdp, `document.querySelectorAll('.nav-tab').length >= 4`, 10000, '页签就绪');
  await q(cdp, `switchTab('overview')`);
  await sleep(600);

  // 关过渡：否则截到的是过渡中间帧
  await q(cdp, `(() => {
    const st = document.createElement('style');
    st.textContent = '*,*::before,*::after{transition:none!important;animation:none!important}';
    document.head.appendChild(st); void document.body.offsetWidth;
  })()`);

  // 进键盘模态，让 .focus() 命中 :focus-visible
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 9, key: 'Tab', code: 'Tab' });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 9, key: 'Tab', code: 'Tab' });
  await sleep(150);

  // 找遍所有视图，挑一个**可聚焦的主按钮**（禁用态聚焦不了；不同页签下的面板不同）
  let target = null;
  for (const view of ['overview', 'models', 'playground', 'clients']) {
    await q(cdp, `switchTab('${view}')`);
    await sleep(450);
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 9, key: 'Tab', code: 'Tab' });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 9, key: 'Tab', code: 'Tab' });
    await sleep(120);

    target = await q(cdp, `(() => {
      for (const b of document.querySelectorAll('button.primary')) {
        const r = b.getBoundingClientRect();
        if (b.disabled || r.width < 4 || r.height < 4) continue;
        if (r.y < 0 || r.y > window.innerHeight - r.height) continue;   // 要能在当前视口里截到
        b.focus();
        const ok = document.activeElement === b;
        const ring = getComputedStyle(b).boxShadow;
        b.blur();
        if (ok) return { view: '${view}', sel: '#' + (b.id || '') + '.' + b.className,
                         text: (b.textContent||'').trim(), x: r.x, y: r.y, w: r.width, h: r.height, ring };
      }
      return null;
    })()`);
    if (target) break;
  }

  if (!target) { console.log('找遍四个页签都没找到可聚焦的主按钮'); }
  else {
    console.log(`目标：<${target.sel}> 「${target.text}」（${target.view} 页）`);
    console.log(`  聚焦后 box-shadow = ${target.ring}`);

    /*
     * **两个主题都要测**。项目「浅色为主」，但无头 Chromium 默认走深色 ——
     * 只测一遍会把深色结论当通用结论（实测两者差得远）。
     */
    for (const theme of ['light', 'dark']) {
      await q(cdp, `document.documentElement.setAttribute('data-theme', '${theme}')`);
      await sleep(300);

      // 未聚焦
      await q(cdp, `document.activeElement && document.activeElement.blur(); 1`);
      await sleep(200);
      const before = await shot(cdp, target);
      writeFileSync(`E:/tmp/focus-${theme}-before.png`, before);

      // 聚焦
      const focused = await q(cdp, `(() => {
        const b = [...document.querySelectorAll('button.primary')].find(x => (x.textContent||'').trim() === ${JSON.stringify(target.text)});
        if (!b) return false; b.focus(); return document.activeElement === b;
      })()`);
      await sleep(250);
      const after = await shot(cdp, target);
      writeFileSync(`E:/tmp/focus-${theme}-after.png`, after);

      const res = await cdp.send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(`E:/tmp/focus-${theme}-full.png`, Buffer.from(res.result.data, 'base64'));
      console.log(`  [${theme}] 聚焦成功=${focused} → E:/tmp/focus-${theme}-after.png`);
    }
  }
} finally {
  close();
  server.close();
}
