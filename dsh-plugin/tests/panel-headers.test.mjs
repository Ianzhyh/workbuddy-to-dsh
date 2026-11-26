/**
 * 读路由也必须带面板头 —— 但**只带该带的那一个**。
 *
 * ## 用户报的现象
 *
 * 「设置 → WorkBuddy → 日志」页报红条 `missing x-workbuddy-panel header`，
 * 并且「显示 0 / 0 行」。
 *
 * ## 根因
 *
 * `GET /workbuddy/log` 是有意要求 `x-workbuddy-panel` 的：它读 `bridge.log`，
 * 而桥在未显式配置令牌时会把 `WORKBUDDY_LOCAL_TOKEN=<值>` 打进启动 banner ——
 * banner 正落在那个日志里。放宽它等于让"同机任意进程、任意网页"都能
 * `fetch('http://127.0.0.1:PORT/workbuddy/log')` 拿到桥令牌
 * （简单请求，不触发 CORS 预检）。
 *
 * 所以服务端那道闸门是对的，**错的是客户端**：`PANEL_HEADERS` 只被
 * `postJson` 用上，`getJson` 一直是裸 `fetch`。日志页于是被自己的防护挡在外面。
 *
 * ## 这条用例钉什么
 *
 *   1. `getJson` 必须带 `x-workbuddy-panel`（否则日志页永远 0 行）；
 *   2. 但**不要**带 `content-type`：GET 没有请求体，声明它是无意义的，
 *      还会把一个简单请求变成需要 CORS 预检的请求；
 *   3. 服务端那道闸门**不许**被顺手放宽（有人为了"修好日志页"会把 GET 的
 *      guard 删掉 —— 那就是把桥令牌公开）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT = readFileSync(join(HERE, '..', 'lib', 'client.js'), 'utf8');
const ROUTES = readFileSync(join(HERE, '..', 'lib', 'routes.mjs'), 'utf8');

test('getJson 带上 x-workbuddy-panel（否则日志页被自己的防护挡住）', () => {
  const at = CLIENT.indexOf('async function getJson(');
  assert.ok(at > 0, '找不到 getJson');
  // 取这个函数到下一次顶层函数声明之间
  const end = CLIENT.indexOf('\n    async function ', at + 10);
  const body = CLIENT.slice(at, end > 0 ? end : at + 4000);

  assert.match(body, /headers:\s*PANEL_GET_HEADERS/,
    'getJson 必须带面板头 —— 否则 GET /workbuddy/log 回 403，日志页显示 0 行（用户报的就是这个）');

  /*
   * 且必须是**不含 content-type** 的那一份。
   *
   * 直接复用 PANEL_HEADERS 也能通过上面那条，但它带 `content-type:
   * application/json`：GET 没有请求体，声明它是无意义的，还会把一个简单请求
   * 变成需要 CORS 预检的请求。
   */
  const def = /const PANEL_GET_HEADERS = \{([^}]*)\}/.exec(CLIENT);
  assert.ok(def, '应有独立的 PANEL_GET_HEADERS 常量');
  assert.match(def[1], /x-workbuddy-panel/);
  assert.doesNotMatch(def[1], /content-type/i,
    'GET 用的头不该包含 content-type（无请求体，且会触发 CORS 预检）');
});

test('服务端 GET /workbuddy/log 的闸门不许被放宽（桥令牌在日志里）', () => {
  /*
   * 这条是防回归的**安全边界**：修日志页最省事的做法是删掉 GET 的 guard，
   * 那等于把 `WORKBUDDY_LOCAL_TOKEN=` 公开给同机任意进程与任意网页。
   */
  const at = ROUTES.indexOf("path: '/workbuddy/log'");
  assert.ok(at > 0, '找不到 /workbuddy/log 路由');
  const end = ROUTES.indexOf('\n    {\n      kind:', at);
  const block = ROUTES.slice(at, end > 0 ? end : at + 3000);

  assert.match(block, /guard\(req\)/,
    'GET /workbuddy/log 必须仍然要求面板头 —— 桥的启动 banner 含本地令牌');
  assert.match(block, /WORKBUDDY_LOCAL_TOKEN|bridge\.log/,
    '注释里应保留"为什么这条需要闸门"的说明，避免后人顺手删掉');
});

test('postJson 仍带完整头（含 content-type）', () => {
  const at = CLIENT.indexOf('async function postJson(');
  assert.ok(at > 0, '找不到 postJson');
  const end = CLIENT.indexOf('\n    async function ', at + 10);
  const body = CLIENT.slice(at, end > 0 ? end : at + 3000);
  assert.match(body, /headers:\s*\{[^}]*PANEL_HEADERS|headers:\s*PANEL_HEADERS/,
    'postJson 必须继续带 PANEL_HEADERS（写请求需要 content-type）');
});