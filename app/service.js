// 查询服务：把 HTTP 请求归一化为查询身份，再交给存储层的事务提交。
// 这里不做抽样：抽样函数只在存储层确认扣减成功后执行。
// 响应只含带噪值与展示值；真值不经过查询接口，只出现在独立的对照页。

import { CONTRACT } from './contract.js';
import {
  sensitivityForSingleRegionCount,
  runLaplaceForRegions,
  clampBias,
  SecureRng,
  roundForStorage
} from './laplace.js';
import {
  normalizeRegionCodes,
  normalizeEpsilon,
  queryFingerprint,
  microToEpsilon
} from './normalize.js';

const MAX_LEDGER_ROWS = 200;
const MAX_TOTAL_MICRO = 1_000_000 * 1_000_000; // 单次提交 1000 ε 上限

function trueCountMap(dataset) {
  return new Map(
    dataset.regions.map((region, index) => [region.code, dataset.counts[index]])
  );
}

export function executeRegionQuery({ dataset, regionCodes, epsilon, rng }) {
  const sampled = runLaplaceForRegions(
    { regions: regionCodes, trueCounts: trueCountMap(dataset), epsilon },
    rng
  );
  const sensitivity = sensitivityForSingleRegionCount();
  const scale = sensitivity / epsilon;

  return {
    mechanism: CONTRACT.mechanism,
    contract_version: CONTRACT.contract_version,
    epsilon_per_region: epsilon,
    epsilon_total: roundForStorage(epsilon * regionCodes.length),
    region_count: regionCodes.length,
    sensitivity,
    noise_scale: roundForStorage(scale),
    clamp_bias_expected: roundForStorage(clampBias(scale)),
    note:
      '每个地区是一次独立查询，按基本组合定理分别消耗 ε；总费用 = 地区数 × ε。' +
      'display_value = max(0, raw_noisy) 是展示变换，会改变分布（期望约偏高 ns/2）。' +
      '查询响应不包含真值；真值只出现在独立的对照页。',
    regions: sampled.map((row) => ({
      region_code: row.region_code,
      raw_noisy: roundForStorage(row.raw_noisy),
      display_value: roundForStorage(row.display_value),
      noise_scale: roundForStorage(row.noise_scale)
    }))
  };
}

export function prepareQueryRequest(body = {}, { knownCodes = null } = {}) {
  const { codes, error: regionError } = normalizeRegionCodes(body.regions);
  if (regionError) {
    return { ok: false, reason: 'invalid_request', message: regionError };
  }
  if (knownCodes) {
    const unknown = codes.filter((code) => !knownCodes.has(code));
    if (unknown.length > 0) {
      return {
        ok: false,
        reason: 'invalid_request',
        message: '样本中没有这些地区代码: ' + unknown.join(', ')
      };
    }
  }
  const { epsilon, micro, error: epsilonError } = normalizeEpsilon(body.epsilon);
  if (epsilonError) {
    return { ok: false, reason: 'invalid_request', message: epsilonError };
  }
  if (micro * codes.length > MAX_TOTAL_MICRO) {
    return {
      ok: false,
      reason: 'invalid_request',
      message: '单次提交的总费用超过 1000 ε 上限'
    };
  }
  return {
    ok: true,
    regionCodes: codes,
    epsilon,
    epsilonMicro: micro,
    regionCount: codes.length,
    totalMicro: micro * codes.length
  };
}

export function fingerprintFor({ regionCodes, epsilonMicro, lock }) {
  return queryFingerprint({
    regionCodes,
    epsilonMicro,
    sensitivity: lock.sensitivity,
    sampleHash: lock.sample_hash,
    contractHash: lock.contract_hash
  });
}

// lock 使用锁定记录中的哈希，而不是当场重新计算；
// 这样查询身份锚定在“已确认并落库”的版本上。
export function submitRegionQuery({ store, dataset, lock, request, rng = new SecureRng() }) {
  const sensitivity = sensitivityForSingleRegionCount();
  const fingerprint = fingerprintFor({
    regionCodes: request.regionCodes,
    epsilonMicro: request.epsilonMicro,
    lock
  });

  const result = store.submitQuery({
    fingerprint,
    queryKey: request.regionCodes.join(','),
    regionCodes: request.regionCodes,
    epsilonMicro: request.epsilonMicro,
    regionCount: request.regionCount,
    totalMicro: request.totalMicro,
    sensitivity,
    executeQuery: () => executeRegionQuery({
      dataset,
      regionCodes: request.regionCodes,
      epsilon: microToEpsilon(request.epsilonMicro),
      rng
    })
  });

  return { ...result, fingerprint };
}

export function regionLabelMap(dataset) {
  return new Map(dataset.regions.map((region) => [region.code, region.name]));
}

export function ledgerView(store, limit = MAX_LEDGER_ROWS) {
  return {
    budget: store.getBudget(),
    entries: store.listLedger(limit),
    summary: store.summary()
  };
}

export { SecureRng };
