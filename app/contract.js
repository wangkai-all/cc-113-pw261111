// 查询契约与锁定信息。契约是“本次原型覆盖什么”的机器可读声明，
// 也进入查询指纹：改动契约（例如改敏感度）不会静默沿用旧预算身份。

import { createHash } from 'node:crypto';

export const CONTRACT = {
  contract_version: 'DP-REGION-COUNT-v1',
  sample_id_expected: 'REGION-SAMPLE-2026.11',
  claim: '本项目内固定样本的“单地区人数”查询满足纯差分隐私（ε-DP）的拉普拉斯机制实现。',
  mechanism: 'laplace',
  sensitivity: 1,
  sensitivity_reason:
    '每个人员经去重与优先级规则后恰好贡献 0 或 1 条地区记录；相邻数据集最多相差一人，' +
    '任意单地区计数最多变化 1，因此 L1 敏感度为 1。',
  composition:
    '一次提交中的每个地区分别是独立查询，按基本组合定理各自消耗所填 ε；' +
    '一笔提交的费用 = 地区数 × ε。',
  noise_scale: 'ns = sensitivity / ε = 1 / ε（按每个地区单独计算）',
  display_transform:
    'display_value = max(0, raw_noisy)。非负截断改变输出分布：负噪声质量折叠到 0，' +
    '展示值的期望相对真值偏高约 ns/2，且在 ns 较大时更明显。raw_noisy 与 display_value 分开保存。',
  deduplication:
    '查询身份 = SHA-256(样本哈希, 契约哈希, 敏感度, 规范化地区代码集合, 以 1e-6 为精度的 ε)。' +
    '身份相同且已有成功结果时，返回保存的噪声结果，不重新抽样、不再次扣费；' +
    '界面标签、请求顺序、地区勾选顺序不参与身份。',
  budget_accounting:
    '所有扣费写入 ledger，spent_epsilon 是唯一余额来源；扣减在 BEGIN IMMEDIATE 事务内通过' +
    '条件 UPDATE 完成，因此并发提交不会把剩余额度扣成负数，失败请求不写 ledger。',
  persistence: 'SQLite 单文件（var/privacy.sqlite3）保存锁定、预算、查询结果、流水与尝试记录。',
  boundaries: [
    '只覆盖“单地区人数”这一种计数查询；不适用于任意查询、任意数据或任意统计量。',
    '不覆盖数据集在锁定后的修改、合并或版本迁移；锁定数据是唯一的计数对象。',
    '按地区分别消耗 ε，不做隐私预算的自适应分配、并行组合优化或高级组合。',
    '非负截断是展示变换，不保护隐私，但会引入系统性偏差；它不被包装为“更好的噪声”。',
    '预算与锁定记录以 SQLite 文件为信任锚：拥有文件删除/改写权限的人能绕过机制，这不在威胁模型内。',
    '样本真值对照页是独立的教学/验收入口，不属于查询 API，也不消耗预算；真实部署不应向查询用户暴露真值。',
    '管理员令牌只用于本原型区分“设置预算”和“提交查询”，不是完整身份认证或运维安全方案。',
    '相同查询去重依赖存储中的成功记录；删除数据库会清除记录并重置本原型状态，这属于文件级操作，不是查询路径。'
  ]
};

export const PIPELINE_IMPL_VERSION = 'pipeline-v1';

const REGION_FALLBACK_RULE = {
  version: 'R-2026.11',
  title: '每人保留一条有效地区记录的规则',
  steps: []
};

export function canonicalStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalStringify).join(',') + ']';
  }
  const keys = Object.keys(value).sort();
  return '{' + keys.map(
    (key) => JSON.stringify(key) + ':' + canonicalStringify(value[key])
  ).join(',') + '}';
}

export function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

export function sampleHash(sample) {
  return sha256(canonicalStringify({
    sample_id: sample.meta.sample_id,
    sample_size: sample.meta.sample_size,
    people: sample.people
  }));
}

export function ruleHash(sample) {
  return sha256(canonicalStringify({
    region_rule: sample.region_rule || REGION_FALLBACK_RULE,
    regions: sample.regions,
    pipeline_impl: PIPELINE_IMPL_VERSION
  }));
}

export function contractHash(contract = CONTRACT) {
  return sha256(canonicalStringify(contract));
}

export function lockPayload(sample, contract = CONTRACT) {
  return {
    sample_hash: sampleHash(sample),
    rule_hash: ruleHash(sample),
    contract_hash: contractHash(contract),
    sample_id: sample.meta.sample_id,
    sample_size: sample.meta.sample_size,
    rule_version: (sample.region_rule || REGION_FALLBACK_RULE).version,
    contract_version: contract.contract_version,
    sensitivity: contract.sensitivity
  };
}
