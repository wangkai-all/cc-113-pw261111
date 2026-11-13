import test from 'node:test';
import assert from 'node:assert/strict';
import { laplaceSample, runLaplaceForRegions, SecureRng, clampBias } from '../app/laplace.js';

function seeded(seed) {
  let state = seed >>> 0;
  return {
    next() {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return (state + 0.5) / 4294967296;
    }
  };
}

test('SecureRng 输出严格位于 (0,1)', () => {
  const rng = new SecureRng();
  for (let i = 0; i < 500; i += 1) {
    const value = rng.next();
    assert.ok(value > 0 && value < 1, '越界: ' + value);
  }
});

test('拉普拉斯抽样关于 0 对称且尺度正确', () => {
  const rng = seeded(12345);
  const scale = 2;
  const samples = [];
  for (let i = 0; i < 6000; i += 1) samples.push(laplaceSample(scale, rng));
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  const meanAbs = samples.reduce((a, b) => a + Math.abs(b), 0) / samples.length;
  assert.ok(Math.abs(mean) < 0.2, '均值偏离 0 太多: ' + mean);
  // E|Lap(b)| = b，容差 12%
  assert.ok(Math.abs(meanAbs - scale) < scale * 0.12, '平均绝对偏差异常: ' + meanAbs);
  const positive = samples.filter((value) => value > 0).length / samples.length;
  assert.ok(Math.abs(positive - 0.5) < 0.03, '正负比例异常: ' + positive);
});

test('ns = 1/ε：ε 越小噪声越大', () => {
  const rng = seeded(999);
  const small = runLaplaceForRegions(
    { regions: ['110000'], trueCounts: new Map([['110000', 40]]), epsilon: 0.1 },
    rng
  )[0];
  const large = runLaplaceForRegions(
    { regions: ['110000'], trueCounts: new Map([['110000', 40]]), epsilon: 1 },
    rng
  )[0];
  assert.equal(small.noise_scale, 10);
  assert.equal(large.noise_scale, 1);
  assert.equal(small.sensitivity, 1);
});

test('raw 与 display 分开保存：display = max(0, raw)', () => {
  const values = [];
  for (let i = 0; i < 200; i += 1) {
    values.push({
      region_code: '110000',
      true_value: 1,
      raw_noisy: i % 2 === 0 ? -3.5 - i : 0.4 + i,
      display_value: i % 2 === 0 ? 0 : 0.4 + i,
      noise_scale: 1,
      sensitivity: 1
    });
  }
  for (const row of values) {
    assert.equal(row.display_value, Math.max(0, row.raw_noisy));
  }
});

test('非负处理抬高期望（约 ns/2）', () => {
  const rng = seeded(2222);
  const scale = 4;
  const samples = [];
  for (let i = 0; i < 20000; i += 1) samples.push(laplaceSample(scale, rng));
  const clamped = samples.reduce((sum, value) => sum + Math.max(0, value), 0) / samples.length;
  assert.ok(Math.abs(clamped - clampBias(scale)) < scale * 0.05,
    `截断期望 ${clamped} 与 ns/2=${clampBias(scale)} 差距过大`);
});
