import { test } from 'node:test';
import assert from 'node:assert/strict';

import { toAdapterModel, toDirectory, pickDefaultModel } from '../lib/models.mjs';

const base = {
  id: 'hy4-preview',
  name: 'Hy4 preview',
  context_window: 300000,
  max_output_tokens: 64000,
  supports_images: true,
  supports_reasoning: true,
  reasoning_efforts: ['high'],
  reasoning_efforts_source: 'upstream',
};

test('夜间免费生效：dsh 模型名显示免费，目录带上活动状态', () => {
  const model = {
    ...base,
    credits: 0,
    free: true,
    badge: '夜间免费',
    promotion_active: true,
    promotion_text: '9月11日–10月31日，每晚 23:00—次日 8:00 享免费额度。',
    promotion_text_en: 'Free every night 23:00–08:00',
    promotion_until: '2026-11-01T00:00:00+08:00',
    promotion_factor: 0,
  };

  const adapterModel = toAdapterModel(model);
  assert.equal(adapterModel.name, 'Hy4 preview · 免费');
  assert.match(adapterModel.description, /促销 夜间免费/);

  const directory = toDirectory([model])[0];
  assert.equal(directory.credits, 0);
  assert.equal(directory.free, true);
  assert.equal(directory.promotionActive, true);
  assert.match(directory.promotionText, /23:00/);
  assert.equal(directory.promotionUntil, '2026-11-01T00:00:00+08:00');
  assert.equal(directory.promotionFactor, 0);
  assert.equal(pickDefaultModel([model]), 'hy4-preview');
});

test('夜间免费未生效：dsh 显示原价，活动名保留但不再声称免费', () => {
  const model = {
    ...base,
    credits: 0.29,
    badge: '夜间免费',
    promotion_active: false,
    promotion_text: '每晚 23:00—次日 8:00 享免费额度。',
  };
  const adapterModel = toAdapterModel(model);
  assert.equal(adapterModel.name, 'Hy4 preview · ×0.29');
  assert.doesNotMatch(adapterModel.description, /促销/);

  const directory = toDirectory([model])[0];
  assert.equal(directory.credits, 0.29);
  assert.equal(directory.free, false);
  assert.equal(directory.promotionActive, false);
  assert.equal(directory.badge, '夜间免费');
});

test('夜间折扣生效：显示折后倍率，并标注促销进行中', () => {
  const model = {
    ...base,
    id: 'glm-5.2',
    name: 'GLM-5.2',
    credits: 0.395,
    badge: '夜间折扣',
    promotion_active: true,
    promotion_factor: 0.5,
  };
  assert.equal(toAdapterModel(model).name, 'GLM-5.2 · ×0.395');
  assert.match(toAdapterModel(model).description, /促销 夜间折扣/);
});

test('过期活动：桥不再下发 badge/free，面板回原价', () => {
  const model = {
    ...base,
    id: 'step-5-preview',
    name: 'Step-5-Preview',
    credits: 0.43,
  };
  const directory = toDirectory([model])[0];
  assert.equal(directory.credits, 0.43);
  assert.equal(directory.free, false);
  assert.equal(directory.badge, null);
  assert.equal(directory.promotionActive, false);
  assert.equal(toAdapterModel(model).name, 'Step-5-Preview · ×0.43');
});

/*
 * 回归（2026-11-06）：`Number(null) === 0` 把「上游没给倍率」显示成「免费」。
 *
 * 桥在 credits 缺失时**不发**该字段，`toDirectory` 于是给 `credits: null`
 * （语义 = 未知）。而 dsh 选择器里的模型名、面板的对话下拉都曾用
 * `Number(credits) === 0` 判免费 → 一个照价扣费的模型被标成「免费」。
 */
test('credits 缺失（null）不等于免费', () => {
  const unknown = { ...base, id: 'glm-5.3', name: 'GLM-5.3' };
  assert.equal(toAdapterModel(unknown).name, 'GLM-5.3', '未知倍率不能加「免费」后缀');
  assert.doesNotMatch(toAdapterModel(unknown).description || '', /免费/);
  const directory = toDirectory([unknown])[0];
  assert.equal(directory.credits, null, '目录层把「没给」表示成 null');
  assert.equal(directory.free, false);

  // 显式免费仍然要标
  assert.equal(toAdapterModel({ ...base, id: 'hy3', name: 'HY3', credits: 0, free: true }).name, 'HY3 · 免费');
  // 数值 0 但没 free 标记：倍率确实是 0，按免费显示是对的
  assert.equal(toAdapterModel({ ...base, id: 'z', name: 'Z', credits: 0 }).name, 'Z · 免费');
});
