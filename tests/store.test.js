import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore, StoreError } from '../app/store.js';
import { openInstance } from '../app/instance.js';
import { prepareQueryRequest, submitRegionQuery } from '../app/service.js';

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), 'region-dp-'));
  return { dir, path: join(dir, 'test.sqlite3') };
}

let counter = 0;
function fingerprintFor(regions, epsilonMicro, tag = '') {
  counter += 1;
  return `fp-${regions.join('-')}-${epsilonMicro}-${counter}-${tag}`;
}

function submit(store, { regions = ['110000'], epsilonMicro = 100000, fingerprint, execute } = {}) {
  return store.submitQuery({
    fingerprint: fingerprint || fingerprintFor(regions, epsilonMicro),
    queryKey: regions.join(','),
    regionCodes: regions,
    epsilonMicro,
    regionCount: regions.length,
    totalMicro: epsilonMicro * regions.length,
    sensitivity: 1,
    executeQuery: execute || (() => ({ fake: true }))
  });
}

test('未设置预算时查询被拒绝且不扣费', () => {
  const store = createStore(':memory:');
  const result = submit(store);
  assert.equal(result.outcome, 'rejected');
  assert.equal(result.reason, 'budget_missing');
  assert.equal(store.getBudget(), null);
  assert.equal(store.listLedger(10).length, 0);
  assert.equal(store.listAttempts(10).length, 1);
  store.close();
});

test('成功提交扣减整笔费用，流水记录扣前/扣后', () => {
  const store = createStore(':memory:');
  store.setTotalEpsilonMicro(1_000_000);
  const result = submit(store, { regions: ['110000', '310000'], epsilonMicro: 200000 });
  assert.equal(result.outcome, 'executed');
  assert.equal(store.getBudget().spent_micro, 400000);
  const ledger = store.listLedger(10);
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].delta_epsilon, 0.4);
  assert.equal(ledger[0].spent_before_epsilon, 0);
  assert.equal(ledger[0].spent_after_epsilon, 0.4);
  assert.equal(result.query.total_cost, 0.4);
  store.close();
});

test('相同指纹重放：返回保存结果、不扣费、deduplicated 递增', () => {
  const store = createStore(':memory:');
  store.setTotalEpsilonMicro(1_000_000);
  const fp = 'same-fingerprint';
  const first = submit(store, { fingerprint: fp, execute: () => ({ value: 'first' }) });
  const second = submit(store, { fingerprint: fp, execute: () => ({ value: 'second' }) });
  assert.equal(first.outcome, 'executed');
  assert.equal(second.outcome, 'replayed');
  assert.deepEqual(second.query.results, { value: 'first' });
  assert.equal(store.getBudget().spent_micro, 100000);
  assert.equal(store.listLedger(10).length, 1);
  assert.equal(store.listQueries(10).length, 1);
  assert.equal(second.query.deduplicated, 1);
  store.close();
});

test('预算不足时拒绝且不留下任何扣减', () => {
  const store = createStore(':memory:');
  store.setTotalEpsilonMicro(1_000_000);
  submit(store, { epsilonMicro: 600000 });
  const before = store.getBudget().spent_micro;
  const rejected = submit(store, { epsilonMicro: 500000 });
  assert.equal(rejected.outcome, 'rejected');
  assert.equal(rejected.reason, 'insufficient_budget');
  assert.equal(store.getBudget().spent_micro, before);
  assert.equal(store.listLedger(10).length, 1);
  const attempt = store.listAttempts(10)[0];
  assert.equal(attempt.reason, 'insufficient_budget');
  assert.equal(attempt.detail.remaining_epsilon, 0.4);
  store.close();
});

test('执行中抛错 → 事务回滚，扣减、查询行与流水全部撤销', () => {
  const store = createStore(':memory:');
  store.setTotalEpsilonMicro(1_000_000);
  assert.throws(() => submit(store, { execute: () => { throw new Error('boom'); } }), /boom/);
  assert.equal(store.getBudget().spent_micro, 0);
  assert.equal(store.listLedger(10).length, 0);
  assert.equal(store.listQueries(10).length, 0);
  store.close();
});

test('总预算在扣费后封存，重开实例也不能改', () => {
  const { dir, path } = tempDb();
  try {
    let store = createStore(path);
    store.setTotalEpsilonMicro(1_000_000);
    submit(store, { epsilonMicro: 100000, fingerprint: 'sealed' });
    assert.throws(() => store.setTotalEpsilonMicro(2_000_000), StoreError);
    store.close();

    store = createStore(path);
    assert.equal(store.getBudget().spent_micro, 100000);
    assert.throws(() => store.setTotalEpsilonMicro(2_000_000), StoreError);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('重开数据库后预算、流水、查询与重放状态保持一致', () => {
  const { dir, path } = tempDb();
  try {
    let store = createStore(path);
    store.setTotalEpsilonMicro(3_000_000);
    const first = submit(store, {
      fingerprint: 'persist-me', regions: ['110000'], epsilonMicro: 250000,
      execute: () => ({ stored: 42 })
    });
    assert.equal(first.outcome, 'executed');
    const snapBudget = store.getBudget();
    store.close();

    store = createStore(path);
    assert.equal(store.getBudget().spent_micro, snapBudget.spent_micro);
    const replay = submit(store, { fingerprint: 'persist-me', execute: () => ({ stored: 99 }) });
    assert.equal(replay.outcome, 'replayed');
    assert.deepEqual(replay.query.results, { stored: 42 });
    assert.equal(store.getBudget().spent_micro, 250000);
    assert.equal(store.listLedger(10).length, 1);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('并发提交不会把余额扣成负数（同一连接串行化）', async () => {
  const { dir, path } = tempDb();
  try {
    const store = createStore(path);
    store.setTotalEpsilonMicro(1_000_000);
    const calls = Array.from({ length: 12 }, (_, index) =>
      store.submitQuery({
        fingerprint: 'concurrent-' + index,
        queryKey: '110000',
        regionCodes: ['110000'],
        epsilonMicro: 100000,
        regionCount: 1,
        totalMicro: 100000,
        sensitivity: 1,
        executeQuery: () => ({ index })
      })
    );
    const executed = calls.filter((call) => call.outcome === 'executed').length;
    const rejected = calls.filter((call) => call.outcome === 'rejected').length;
    assert.equal(executed, 10);
    assert.equal(rejected, 2);
    assert.equal(store.getBudget().spent_micro, 1_000_000);
    assert.equal(store.getBudget().remaining_micro, 0);
    assert.ok(store.getBudget().spent_micro <= store.getBudget().total_micro);
    assert.equal(store.listLedger(20).length, 10);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('并发多连接提交：总量不超支，余额永不为负', async () => {
  const { dir, path } = tempDb();
  try {
    const setup = createStore(path);
    setup.setTotalEpsilonMicro(1_000_000);
    setup.close();

    const workers = Array.from({ length: 10 }, () => createStore(path));
    const results = await Promise.all(workers.map((worker, index) => new Promise((resolve) => {
      setImmediate(() => {
        try {
          const result = worker.submitQuery({
            fingerprint: 'multi-' + index,
            queryKey: '110000',
            regionCodes: ['110000'],
            epsilonMicro: 150000,
            regionCount: 1,
            totalMicro: 150000,
            sensitivity: 1,
            executeQuery: () => ({ index })
          });
          resolve(result.outcome);
        } catch (error) {
          resolve('error:' + error.message);
        }
      });
    })));
    const executed = results.filter((value) => value === 'executed').length;
    assert.equal(executed, 6);
    for (const worker of workers) worker.close();

    const check = createStore(path);
    const budget = check.getBudget();
    assert.ok(budget.spent_micro <= budget.total_micro);
    assert.ok(budget.spent_micro >= 0);
    assert.equal(budget.spent_micro, 900000);
    assert.equal(check.listLedger(20).length, 6);
    check.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('锁定哈希不一致时拒绝启动，且既有预算不受影响', () => {
  const store = createStore(':memory:');
  const payload = {
    sample_hash: 'a', rule_hash: 'b', contract_hash: 'c',
    sample_id: 'S', sample_size: 10, rule_version: 'R', contract_version: 'C',
    sensitivity: 1
  };
  store.lockDataset(payload);
  store.setTotalEpsilonMicro(1_000_000);
  assert.throws(
    () => store.lockDataset({ ...payload, sample_hash: 'changed' }),
    /改名、复制或替换数据都不能重置预算/
  );
  assert.equal(store.getBudget().total_micro, 1_000_000);
  assert.throws(
    () => store.lockDataset({ ...payload, sample_id: 'RENAMED' }),
    StoreError
  );
  store.close();
});

test('端到端：查询返回 raw 与 display，且不含真值', () => {
  const store = createStore(':memory:');
  const { instance } = openInstanceWith(store);
  store.setTotalEpsilonMicro(2_000_000);
  const request = prepareQueryRequest({ regions: ['110000'], epsilon: 0.5 });
  assert.equal(request.ok, true);
  const result = submitRegionQuery({
    store,
    dataset: instance.dataset,
    lock: instance.lock,
    request
  });
  assert.equal(result.outcome, 'executed');
  const row = result.query.results.regions[0];
  assert.ok('raw_noisy' in row);
  assert.ok('display_value' in row);
  assert.equal(row.display_value, Math.max(0, row.raw_noisy));
  assert.ok(!('true_value' in row), '查询响应不应包含真值');
  store.close();
});

test('端到端：同一查询重放不扣费，换额度则扣费', () => {
  const store = createStore(':memory:');
  const { instance } = openInstanceWith(store);
  store.setTotalEpsilonMicro(2_000_000);
  const a = submitRegionQuery({
    store, dataset: instance.dataset, lock: instance.lock,
    request: prepareQueryRequest({ regions: ['110000', '310000'], epsilon: 0.4 })
  });
  const b = submitRegionQuery({
    store, dataset: instance.dataset, lock: instance.lock,
    request: prepareQueryRequest({ regions: ['310000', '110000'], epsilon: '0.4' })
  });
  assert.equal(a.outcome, 'executed');
  assert.equal(b.outcome, 'replayed');
  assert.equal(store.getBudget().spent_micro, 800000);
  const c = submitRegionQuery({
    store, dataset: instance.dataset, lock: instance.lock,
    request: prepareQueryRequest({ regions: ['110000', '310000'], epsilon: 0.5 })
  });
  assert.equal(c.outcome, 'executed');
  assert.equal(store.getBudget().spent_micro, 1800000);
  store.close();
});

function openInstanceWith(store) {
  const { buildInstance, confirmDatasetLock } = instanceInternals;
  const instance = buildInstance({ store });
  confirmDatasetLock(store, instance);
  return { instance };
}

import * as instanceInternals from '../app/instance.js';
