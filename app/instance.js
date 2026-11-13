// 会话与实例装配：加载样本、执行数据准备流水线、装配查询服务。
// 锁定不在这里自动发生：必须在管理员确认“数据与贡献规则”之后，
// 通过 confirmDatasetLock 显式写入。重启时若已有锁定记录，只做校验、不重复写入。

import { buildSample } from '../scripts/generate-sample.js';
import { buildDataset, pipelinePreview, sourceLabel, RECORD_OUTCOME_LABELS } from './pipeline.js';
import { truthTable, truthSummary } from './truth.js';
import { CONTRACT, lockPayload } from './contract.js';
import { createStore, StoreError } from './store.js';

export function loadDataset() {
  const sample = buildSample();
  const dataset = buildDataset(sample);
  return { sample, dataset };
}

export function buildInstance({ store }) {
  const { sample, dataset } = loadDataset();
  const payload = lockPayload(sample, CONTRACT);

  const existing = store.getLock();
  let lock = existing;
  let lockError = null;
  if (existing) {
    // 已有锁定：校验当前文件是否与锁定版本一致；不一致则不提供查询。
    try {
      store.lockDataset(payload);
    } catch (error) {
      if (error instanceof StoreError) lockError = error;
      else throw error;
    }
  }

  return {
    sample,
    dataset,
    contract: CONTRACT,
    lock,
    lockError,
    lockPayload: payload,
    locked: !!lock && !lockError,
    budget: store.getBudget(),
    preview: pipelinePreview(dataset, 8),
    stats: dataset.stats,
    truth: {
      table: truthTable(dataset),
      summary: truthSummary(dataset)
    },
    sourceLabel,
    outcomeLabels: RECORD_OUTCOME_LABELS
  };
}

// 管理员确认后写入锁定。已锁定时只校验，不覆盖。
export function confirmDatasetLock(store, instance, { by = 'admin' } = {}) {
  if (instance.lockError) throw instance.lockError;
  const result = store.lockDataset(instance.lockPayload, by);
  instance.lock = result.lock;
  instance.locked = true;
  instance.budget = store.getBudget();
  return result;
}

export function openInstance({ dbPath }) {
  const store = createStore(dbPath);
  const instance = buildInstance({ store });
  return { store, instance };
}

export { StoreError };
