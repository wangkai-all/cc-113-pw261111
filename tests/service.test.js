import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../app/store.js';
import { buildInstance, confirmDatasetLock } from '../app/instance.js';
import { prepareQueryRequest, fingerprintFor } from '../app/service.js';

test('实例不会自动锁定；确认后才有锁定记录', () => {
  const store = createStore(':memory:');
  const instance = buildInstance({ store });
  assert.equal(instance.locked, false);
  assert.equal(instance.lock, null);
  assert.equal(store.getLock(), null);

  const result = confirmDatasetLock(store, instance);
  assert.equal(result.already, false);
  assert.equal(instance.locked, true);
  assert.ok(instance.lock.sample_hash);
  assert.ok(store.getLock());
  store.close();
});

test('重复确认锁定只校验，不覆盖原记录', () => {
  const store = createStore(':memory:');
  const instance = buildInstance({ store });
  const first = confirmDatasetLock(store, instance);
  const second = confirmDatasetLock(store, instance);
  assert.equal(second.already, true);
  assert.equal(second.lock.locked_at, first.lock.locked_at);
  store.close();
});

test('请求校验拒绝样本中不存在的地区代码', () => {
  const known = new Set(['110000', '310000']);
  const bad = prepareQueryRequest({ regions: ['110000', '999999'], epsilon: 0.5 }, { knownCodes: known });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'invalid_request');
  assert.match(bad.message, /999999/);

  const good = prepareQueryRequest({ regions: ['310000', '110000'], epsilon: 0.5 }, { knownCodes: known });
  assert.equal(good.ok, true);
  assert.deepEqual(good.regionCodes, ['110000', '310000']);
  assert.equal(good.totalMicro, 1_000_000);
});

test('查询指纹锚定锁定记录中的哈希，不受请求标签影响', () => {
  const store = createStore(':memory:');
  const instance = buildInstance({ store });
  confirmDatasetLock(store, instance);

  const lock = store.getLock();
  const base = fingerprintFor({ regionCodes: ['110000', '310000'], epsilonMicro: 500000, lock });
  const same = fingerprintFor({ regionCodes: ['110000', '310000'], epsilonMicro: 500000, lock });
  assert.equal(base, same);

  const otherSample = fingerprintFor({
    regionCodes: ['110000', '310000'], epsilonMicro: 500000,
    lock: { ...lock, sample_hash: 'other' }
  });
  assert.notEqual(base, otherSample);
  store.close();
});
