// 只读、与预算无关的样本真值对照入口。
// 独立于查询路径：显示每个地区的“保留后真值”，用于理解拉普拉斯误差，
// 不消耗预算、不写查询历史。它不能被当作查询系统的输出，也不能用于校验噪声结果。
export function truthTable(dataset) {
  return dataset.regions.map((region, index) => ({
    code: region.code,
    name: region.name,
    group: region.region,
    count: dataset.counts[index]
  }));
}

// 用于误差对照的汇总：按地区分组与整体。
export function truthSummary(dataset) {
  let total = 0;
  for (const value of dataset.counts) total += value;
  const groups = new Map();
  for (let i = 0; i < dataset.regions.length; i += 1) {
    const group = dataset.regions[i].region;
    groups.set(group, (groups.get(group) || 0) + dataset.counts[i]);
  }
  return {
    total,
    max_region: Math.max(...dataset.counts),
    min_nonzero_region: Math.min(...dataset.counts.filter((n) => n > 0)),
    groups: Array.from(groups.entries()).map(([group, count]) => ({ group, count }))
  };
}
