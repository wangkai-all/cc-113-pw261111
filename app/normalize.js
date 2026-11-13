// 查询身份与额度归一化。
// 身份只由“样本哈希 + 查询契约哈希 + 规范化地区集合 + 规范化额度”决定：
// 地区名称、勾选顺序、显示顺序、请求编号都不参与指纹，复制/改名查询不会产生新的预算身份。

import { createHash } from 'node:crypto';

export const EPSILON_MICRO = 1_000_000;
export const MAX_EPSILON = 1_000_000;
export const MAX_REGIONS_PER_QUERY = 28;

export function epsilonToMicro(value) {
  const micro = Math.round(value * EPSILON_MICRO);
  return micro / EPSILON_MICRO === value || Math.abs(micro / EPSILON_MICRO - value) < 1e-9
    ? micro
    : NaN;
}

export function microToEpsilon(micro) {
  return micro / EPSILON_MICRO;
}

export function formatEpsilon(value) {
  if (!Number.isFinite(value)) return '—';
  return Number(value.toFixed(6)).toString();
}

export function normalizeRegionCodes(regionCodes) {
  if (!Array.isArray(regionCodes)) {
    return { codes: null, error: '地区参数必须是数组' };
  }
  const deduped = Array.from(
    new Set(regionCodes.map((code) => String(code ?? '').trim()))
  ).filter((code) => code.length > 0);

  if (deduped.length === 0) {
    return { codes: null, error: '请至少选择一个地区' };
  }
  if (deduped.length > MAX_REGIONS_PER_QUERY) {
    return { codes: null, error: '单次查询选择的地区过多' };
  }
  if (deduped.some((code) => !/^\d{6}$/.test(code))) {
    return { codes: null, error: '地区代码必须是 6 位数字' };
  }
  deduped.sort();
  return { codes: deduped, error: null };
}

export function normalizeEpsilon(value) {
  if (value === null || value === undefined || String(value).trim() === '') {
    return { epsilon: null, micro: null, error: '额度不能为空' };
  }
  const number = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(number)) {
    return { epsilon: null, micro: null, error: '额度必须是数字' };
  }
  if (number <= 0) {
    return { epsilon: null, micro: null, error: '额度必须大于 0' };
  }
  if (number > MAX_EPSILON) {
    return { epsilon: null, micro: null, error: '额度超出允许范围' };
  }
  const micro = Math.round(number * EPSILON_MICRO);
  if (micro <= 0) {
    return { epsilon: null, micro: null, error: '额度小于最小精度（0.000001）' };
  }
  return { epsilon: microToEpsilon(micro), micro, error: null };
}

export function queryFingerprint({
  regionCodes,
  epsilonMicro,
  sensitivity,
  sampleHash,
  contractHash
}) {
  const canonical = JSON.stringify({
    sample: sampleHash,
    contract: contractHash,
    sensitivity,
    regions: regionCodes,
    epsilon_micro: epsilonMicro
  });
  return createHash('sha256').update(canonical).digest('hex');
}
