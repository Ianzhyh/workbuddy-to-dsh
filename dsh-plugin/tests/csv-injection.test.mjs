/**
 * CSV 公式注入回归（安全审计 2026-10-09 P3 未闭环项）。
 *
 * Excel / WPS 会把 `=`、`+`、`-`、`@`、制表符、回车开头的单元格当公式执行。
 * 引号只能防逗号/换行，防不了公式。模型名与上游错误原文都可控，
 * `=HYPERLINK("http://…")` 能通过桥的字符校验并进账本 —— 用户导出后打开即执行。
 *
 * 客户端与控制台各有一份导出实现（一个在 lazy-CJS bundle、一个在普通页面脚本，
 * 无法共享模块），所以两边都要测。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN = join(HERE, '..');
const REPO = join(PLUGIN, '..');

const CASES = [
  ['=1+1', "'=1+1"],
  ['+SUM(A1:A2)', "'+SUM(A1:A2)"],
  ['-2', "'-2"],
  ['@cmd', "'@cmd"],
  ['\t=1', "'\t=1"],
  ['\r=1', `"'\r=1"`],
  ['=a,b', `"'=a,b"`],
  ['normal', 'normal'],
  ['a,b', '"a,b"'],
  ['a"b', '"a""b"'],
  ['a\nb', '"a\nb"'],
  ['', ''],
  [null, ''],
  [undefined, ''],
];

/** 按 dsh 的 load({id,factory}) 语义取出客户端 bundle 的导出。 */
function clientExports() {
  let registration;
  const sandbox = {
    window: { __ModuleLoader__: { load: (h) => { registration = h; } } },
  };
  vm.runInNewContext(readFileSync(join(PLUGIN, 'lib', 'client.js'), 'utf8'), sandbox, { filename: 'client.js' });
  assert.ok(registration, 'client.js 没有注册模块');
  const React = {
    createElement: () => null,
    useState: (v) => [v, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
    useRef: (v) => ({ current: v }),
    useMemo: (fn) => fn(),
    Fragment: {},
  };
  return registration.factory(() => React);
}

test('客户端导出：CSV 危险前缀必须被中和，普通文本与引号规则不变', () => {
  const mod = clientExports();
  assert.equal(typeof mod.csvCell, 'function', 'client.js 应导出 csvCell 供回归测试');
  for (const [input, expected] of CASES) {
    assert.equal(mod.csvCell(input), expected, `csvCell(${JSON.stringify(input)})`);
  }
});

test('控制台导出：同一套 csvCell 规则（页面脚本无法 import，逐字节对齐）', () => {
  const html = readFileSync(join(REPO, 'dashboard', 'public', 'index.html'), 'utf8');
  const match = /function csvCell\(value\)\s*\{([\s\S]*?)\r?\n\}/.exec(html);
  assert.ok(match, '控制台页面里找不到 csvCell —— CSV 导出可能又绕过公式中和');
  const fn = new Function('value', match[1]);
  for (const [input, expected] of CASES) {
    assert.equal(fn(input), expected, `控制台 csvCell(${JSON.stringify(input)})`);
  }
});

test('两处导出路径都实际使用 csvCell（不能只定义不调用）', () => {
  const client = readFileSync(join(PLUGIN, 'lib', 'client.js'), 'utf8');
  const dashboard = readFileSync(join(REPO, 'dashboard', 'public', 'index.html'), 'utf8');
  assert.match(client, /\[header, \.\.\.rows\]\.map\(\(r\) => r\.map\(csvCell\)/,
    '插件面板的 downloadCsv 没有使用 csvCell');
  assert.match(dashboard, /rows\.map\(\(r\) => r\.map\(csvCell\)/,
    '控制台的 downloadCsv 没有使用 csvCell');
});
