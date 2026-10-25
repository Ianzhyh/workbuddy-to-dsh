import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createTools } from '../lib/tools.mjs';

function makeTools(webSearch) {
  return createTools({
    snapshot: async () => ({}),
    supervisor: { probe: async () => ({ state: 'stopped' }) },
    consoleSupervisor: {},
    adapter: {},
    client: { webSearch },
  });
}

const tool = (name, webSearch) => makeTools(webSearch).find((item) => item.name === name);

test('兜底搜索工具：直接走桥，返回标题/链接/摘要', async () => {
  let seen;
  const search = tool('workbuddy_web_search', async (args) => {
    seen = args;
    return {
      provider: 'stub-search',
      results: [
        { title: 'Alpha', url: 'https://alpha.example/a', snippet: 'alpha snippet' },
        { title: 'Beta', url: 'https://beta.example/b', snippet: '' },
      ],
    };
  });
  assert.ok(search, '必须注册 workbuddy_web_search');
  assert.deepEqual(search.parameters.required, ['query']);
  const output = await search.execute({ query: '  WorkBuddy 夜间免费  ', max_results: 2 });
  assert.deepEqual(seen, { query: 'WorkBuddy 夜间免费', maxResults: 2, signal: undefined });
  assert.match(output, /stub-search/);
  assert.match(output, /1\. Alpha/);
  assert.match(output, /https:\/\/alpha\.example\/a/);
  assert.match(output, /alpha snippet/);
  assert.match(output, /2\. Beta/);
});

test('兜底搜索工具：空结果/限流/桥未运行都给人话，不抛裸错误', async () => {
  const empty = tool('workbuddy_web_search', async () => ({ results: [] }));
  assert.match(await empty.execute({ query: 'nothing' }), /没有搜到/);

  const limited = tool('workbuddy_web_search', async () => {
    const error = new Error('too many searches');
    error.status = 429;
    throw error;
  });
  assert.match(await limited.execute({ query: 'x y' }), /限流/);

  const down = tool('workbuddy_web_search', async () => {
    throw new Error('fetch failed');
  });
  assert.match(await down.execute({ query: 'x y' }), /本地桥未运行/);

  const unauthorized = tool('workbuddy_web_search', async () => {
    const error = new Error('invalid token');
    error.status = 401;
    throw error;
  });
  await assert.rejects(unauthorized.execute({ query: 'x y' }), /令牌与插件不一致/);
});

test('兜底搜索工具：query 太短在本地就拒绝，不打上游', async () => {
  let called = false;
  const search = tool('workbuddy_web_search', async () => { called = true; return { results: [] }; });
  await assert.rejects(search.execute({ query: 'a' }), /至少需要 2 个字符/);
  assert.equal(called, false);
});
