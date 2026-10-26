import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG_SCHEMA, describeConfigCheck, validateConfigEnv } from './config-schema.mjs';

test('合法取值不报警', () => {
  const { checked, issues } = validateConfigEnv({
    WORKBUDDY_PORT: '9000',
    WORKBUDDY_TIMEOUT_MS: '0',
    WORKBUDDY_SEARCH_MAX_RESULTS: '5',
    WORKBUDDY_RATE_LIMIT_MODE: 'reject',
    WORKBUDDY_CREDENTIAL_SOURCE: 'PLUGIN',
    WORKBUDDY_LOGIN_REGION: 'global',
    WORKBUDDY_LOG: '1',
  });
  assert.equal(checked, 7);
  assert.deepEqual(issues, []);
});

test('非数字 / 越界数值会被诊断出来（消费点实际回退默认）', () => {
  const { issues } = validateConfigEnv({
    WORKBUDDY_PORT: '879O',
    DASHBOARD_PORT: '99999',
    WORKBUDDY_SEARCH_MAX_RESULTS: '50',
  });
  const byKey = new Map(issues.map((i) => [i.key, i]));
  assert.equal(byKey.get('WORKBUDDY_PORT').fallback, '8790');
  assert.match(byKey.get('WORKBUDDY_PORT').reason, /不是数字/);
  assert.match(byKey.get('DASHBOARD_PORT').reason, /1 ~ 65535/);
  assert.match(byKey.get('WORKBUDDY_SEARCH_MAX_RESULTS').reason, /1 ~ 10/);
});

test('整数项的小数按消费点语义截断，不算错误', () => {
  const { issues } = validateConfigEnv({ WORKBUDDY_PORT: '8790.7', WORKBUDDY_MAX_SOCKETS: '32.9' });
  assert.deepEqual(issues, []);
});

test('枚举大小写按各消费点的真实语义判定', () => {
  const { issues } = validateConfigEnv({
    WORKBUDDY_CREDENTIAL_SOURCE: 'Plugin',
    WORKBUDDY_RATE_LIMIT_MODE: 'REJECT',
  });
  assert.deepEqual(issues.map((i) => i.key), ['WORKBUDDY_RATE_LIMIT_MODE']);
});

test('布尔项只认 0 / 1，并说明实际会被当成什么', () => {
  const { issues } = validateConfigEnv({
    WORKBUDDY_LOG: 'true',
    DASHBOARD_AUTO_START_BRIDGE: 'false',
  });
  const byKey = new Map(issues.map((i) => [i.key, i]));
  assert.equal(byKey.get('WORKBUDDY_LOG').fallback, '关闭');
  assert.equal(byKey.get('DASHBOARD_AUTO_START_BRIDGE').fallback, '开启');
});

test('空值视为未设置，不参与检查', () => {
  const { checked, issues } = validateConfigEnv({ WORKBUDDY_PORT: '   ', WORKBUDDY_TIMEOUT_MS: '' });
  assert.equal(checked, 0);
  assert.deepEqual(issues, []);
});

test('describeConfigCheck 最多列 3 项，并区分有无自定义配置', () => {
  const result = validateConfigEnv({
    WORKBUDDY_PORT: 'x',
    DASHBOARD_PORT: 'y',
    WORKBUDDY_MAX_SOCKETS: '0',
    WORKBUDDY_SEARCH_TIMEOUT_MS: '1',
  });
  const described = describeConfigCheck(result);
  assert.equal(described.status, 'warn');
  assert.match(described.detail, /另有 1 项/);
  assert.equal(describeConfigCheck({ checked: 0, issues: [] }).status, 'ok');
  assert.match(describeConfigCheck({ checked: 3, issues: [] }).detail, /已检查 3 项/);
});

test('schema 范围与默认值自洽', () => {
  for (const [key, rule] of Object.entries(CONFIG_SCHEMA)) {
    assert.ok(rule.note, `${key} 缺少说明`);
    if (rule.kind !== 'number') continue;
    assert.ok(rule.min <= rule.max, `${key} 范围反了`);
    assert.ok(
      rule.fallback >= rule.min && rule.fallback <= rule.max,
      `${key} 默认值 ${rule.fallback} 不在 ${rule.min} ~ ${rule.max} 内`,
    );
  }
});
