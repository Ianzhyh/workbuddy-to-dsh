/**
 * 可访问性标记回归：标签语义、读屏播报、错误全文、焦点可见。
 *
 * 这些是纯标记/样式约束，不需要浏览器；行为级断言在 panel-render.mjs
 * （role=tablist、ArrowRight 切换、tabpanel labelledby）。两处互补。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN = join(HERE, '..');
const REPO = join(PLUGIN, '..');
const CLIENT = readFileSync(join(PLUGIN, 'lib', 'client.js'), 'utf8');
const DASHBOARD = readFileSync(join(REPO, 'dashboard', 'public', 'index.html'), 'utf8');
const STYLE = readFileSync(join(REPO, 'dashboard', 'public', 'style.css'), 'utf8');

test('插件标签栏：tablist/tab/tabpanel + aria 关联 + 键盘导航', () => {
  assert.match(CLIENT, /role: 'tablist'/);
  assert.match(CLIENT, /role: 'tab'/);
  assert.match(CLIENT, /'aria-selected': tab === t\.id/);
  assert.match(CLIENT, /'aria-controls': 'wb-panel-' \+ t\.id/);
  assert.match(CLIENT, /role: 'tabpanel'/);
  assert.match(CLIENT, /'aria-labelledby': 'wb-tab-' \+ tab/);
  assert.match(CLIENT, /onKeyDown: onTabsKeyDown/);
  assert.match(CLIENT, /event\.key === 'ArrowRight'/);
  assert.match(CLIENT, /\.wb-tab:focus-visible/);
});

test('插件提示与登录错误：读屏可播报、全文可换行、语义色用 token', () => {
  assert.match(CLIENT, /role: props\.bad \? 'alert' : 'status'/);
  assert.match(CLIENT, /'aria-live': props\.bad \? 'assertive' : 'polite'/);
  assert.doesNotMatch(CLIENT, /error\.length > 48 \? error\.slice\(0, 48\)/,
    '登录错误不能先截断再交给 CSS，全文只留在 title 里');
  assert.match(CLIENT, /role: 'alert',[\s\S]{0,120}wb-chat-login-error|className: 'wb-chat-login-error',[\s\S]{0,120}role: 'alert'/);
  assert.match(CLIENT, /\.wb-chat-login-error\{[^}]*overflow-wrap:anywhere/);
  assert.match(CLIENT, /\.wb-input:focus-visible,\.wb-select:focus-visible,\.wb-textarea:focus-visible/);
});

test('控制台：导航状态可被读屏识别、操作反馈进 liveRegion、错误可换行', () => {
  assert.match(DASHBOARD, /class="nav-tab active" data-tab="all" aria-pressed="true"/);
  assert.match(DASHBOARD, /setAttribute\('aria-pressed', active \? 'true' : 'false'\)/);
  assert.match(DASHBOARD, /if \(text\) announce\(text\);/);
  assert.match(STYLE, /\.msg\.err \{[^}]*white-space: normal;[^}]*overflow-wrap: anywhere;/);
  assert.match(STYLE, /\.nav-tab:focus-visible \{/);
});
