// SPDX-License-Identifier: MIT
/**
 * 面板 i18n 的数据边界回归。
 *
 * 这里验的是**结构性约束**（哪些位置必须绕过自动翻译、哪些组件必须订阅语言），
 * 实际渲染行为由 `panel-i18n.mjs` 在浏览器里覆盖。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const CLIENT = readFileSync(join(ROOT, 'dsh-plugin', 'lib', 'client.js'), 'utf8').replace(/\r\n/g, '\n');
const CONSOLE = readFileSync(join(ROOT, 'dashboard', 'public', 'index.html'), 'utf8').replace(/\r\n/g, '\n');

test('插件：数据展示位必须绕过 h() 的自动翻译', () => {
  // 请求表模型列（空模型显示 —；title 也是数据，整格标 raw 跳过翻译）
  assert.match(CLIENT, /h\('td', \{ title: r\.model \|\| '', 'data-wb-raw': '' \}, r\.model \? h\(Raw, \{ text: String\(r\.model\) \}\) : '—'\)/);
  // 桥日志 <pre>
  assert.match(CLIENT, /h\('pre', \{ className: 'wb-log' \}, all\.length \? h\(Raw, \{ text: all\.join\('\\n'\) \}\)/);
  // 对话正文与思考正文
  assert.match(CLIENT, /m\.content \? h\(Raw, \{ text: String\(m\.content\) \}\)/);
  assert.match(CLIENT, /h\(Raw, \{ text: t\('思考：'\) \+ m\.reasoning \}\)/);
  // 模型名 / 账号名
  assert.match(CLIENT, /h\('td', null, m\.name \? h\(Raw, \{ text: String\(m\.name\) \}\) : ''/);
  assert.match(CLIENT, /h\('b', \{ title: a\.path \|\| a\.name, 'data-wb-raw': '' \}, h\(Raw, \{ text: a\.alias \|\| a\.name \}\)\)/);
  // 模型筛选下拉：选项文本也必须原样渲染（含隐藏 select 的 option）
  assert.match(CLIENT, /\.\.\.models\.map\(\(m\) => \(\{ value: m, label: m, raw: true \}\)\)/);
  assert.match(CLIENT, /opt\.raw[\s\S]{0,200}\? h0\('option', \{ key: String\(opt\.value\), value: String\(opt\.value\), 'data-wb-raw': '' \}, label\)/);
});

test('插件：三个对话页槽位必须用 useLang() 订阅语言，不能读宿主页面的 lang', () => {
  assert.doesNotMatch(CLIENT, /documentElement\.lang/, '插件不能依赖宿主页面的 <html lang>');
  for (const name of ['ChatQuotaPill', 'ChatTurnCost', 'ChatLoginButton']) {
    const start = CLIENT.indexOf(`function ${name}(`);
    assert.notEqual(start, -1, `找不到 ${name}`);
    const body = CLIENT.slice(start, start + 8000);
    assert.match(body, /const en = useLang\(\) === 'en';/, `${name} 必须订阅 useLang()`);
  }
});

test('控制台：请求表模型名 / 模型表名称 / 账号名不进翻译', () => {
  assert.match(CONSOLE, /'<td class="mono" data-i18n-skip>' \+ escapeAttr\(r\.model\)/);
  assert.match(CONSOLE, /'<td class="name" data-i18n-skip>' \+ escapeAttr\(m\.name \|\| '—'\)/);
  assert.match(CONSOLE, /'<div class="acct-name"><span data-i18n-skip>' \+ escapeAttr\(label\)/);
});
