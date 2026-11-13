import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeRegionCodes,
  normalizeEpsilon,
  queryFingerprint,
  formatEpsilon
} from '../app/normalize.js';

test('地区集合去重并排序，勾选顺序不改变结果', () => {
  const a = normalizeRegionCodes(['310000', '110000', '310000']);
  const b = normalizeRegionCodes(['110000', '310000']);
  assert.deepEqual(a.codes, b.codes);
  assert.deepEqual(a.codes, ['110000', '310000']);
});

test('空白地区的处理：空串被丢弃，非法代码被拒绝', () => {
  assert.deepEqual(normalizeRegionCodes(['110000', '  ']).codes, ['110000']);
  assert.ok(normalizeRegionCodes([]).error);
  assert.ok(normalizeRegionCodes(['abc123']).error);
  assert.ok(normalizeRegionCodes(['11000']).error);
  assert.ok(normalizeRegionCodes('110000').error);
});

test('额度归一化拒绝非正数、NaN、空值与超限', () => {
  assert.ok(normalizeEpsilon('').error);
  assert.ok(normalizeEpsilon(null).error);
  assert.ok(normalizeEpsilon('abc').error);
  assert.ok(normalizeEpsilon(0).error);
  assert.ok(normalizeEpsilon(-1).error);
  assert.ok(normalizeEpsilon(1000001).error);
  assert.equal(normalizeEpsilon('0.5').epsilon, 0.5);
  assert.equal(normalizeEpsilon(0.5).micro, 500000);
});

test('浮点尾巴不会产生新的查询身份', () => {
  const microA = normalizeEpsilon(0.1 + 0.2).micro;
  const microB = normalizeEpsilon(0.3).micro;
  assert.equal(microA, microB);
  const a = queryFingerprint({
    regionCodes: ['110000'],
    epsilonMicro: microA,
    sensitivity: 1,
    sampleHash: 's',
    contractHash: 'c'
  });
  const b = queryFingerprint({
    regionCodes: ['110000'],
    epsilonMicro: microB,
    sensitivity: 1,
    sampleHash: 's',
    contractHash: 'c'
  });
  assert.equal(a, b);
});

test('相同规范化输入 → 相同指纹；任一实质字段变化 → 不同指纹', () => {
  const base = {
    regionCodes: ['110000', '310000'],
    epsilonMicro: 500000,
    sensitivity: 1,
    sampleHash: 'sample-a',
    contractHash: 'contract-a'
  };
  const baseFp = queryFingerprint(base);
  assert.equal(queryFingerprint({ ...base, regionCodes: ['110000', '310000'] }), baseFp);
  assert.notEqual(queryFingerprint({ ...base, epsilonMicro: 500001 }), baseFp);
  assert.notEqual(queryFingerprint({ ...base, regionCodes: ['110000'] }), baseFp);
  assert.notEqual(queryFingerprint({ ...base, sampleHash: 'sample-b' }), baseFp);
  assert.notEqual(queryFingerprint({ ...base, contractHash: 'contract-b' }), baseFp);
  assert.notEqual(queryFingerprint({ ...base, sensitivity: 2 }), baseFp);
});

test('formatEpsilon 去掉多余小数位', () => {
  assert.equal(formatEpsilon(1), '1');
  assert.equal(formatEpsilon(0.25), '0.25');
  assert.equal(formatEpsilon(0.000001), '0.000001');
  assert.equal(formatEpsilon(2.500000), '2.5');
});
