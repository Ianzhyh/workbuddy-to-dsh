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
