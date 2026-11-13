// 数据准备流水线：把原始记录收敛为“每人至多一条”可计数记录。
// 这一步在锁定前固定；结果只用于计数查询与真值对照页，查询响应本身不返回明细。

const SOURCE_LABELS = {
  residence: '居住申报',
  registry: '户籍登记',
  carrier: '手机号归属地',
  activity: '登录日志'
};

export const RECORD_OUTCOME_LABELS = {
  kept: '保留为最终记录',
  discarded: '有效但被更高优先级替换',
  duplicate: '同来源同地区重复，已合并',
  invalid_missing: '地区字段缺失，剔除',
  invalid_unknown: '地区代码不在固定表，剔除'
};

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function buildRegionIndex(regions) {
  const byCode = new Map();
  for (const region of regions) byCode.set(region.code, region);
  return { byCode };
}

// 返回 kept 与每条原始记录的去向 outcomes（与 person.raw 一一对应）。
// 规则（版本见 sample.region_rule，锁定后不可改）：
// 1. 地区代码必须能在固定地区表命中；空值/未知代码/无地区字段的行剔除。
// 2. 同人同来源同地区代码视为内容重复，仅留更新时间最新的一行。
// 3. 按来源优先级（数字大者优先）与更新时间（越新越优先）排序，取第一条。
// 4. 无有效候选者整人剔除。
export function evaluatePerson(person, regionIndex) {
  const outcomes = new Array(person.raw.length).fill(null);
  const groups = new Map();
  let invalidMissing = 0;
  let invalidUnknown = 0;
  let duplicates = 0;

  person.raw.forEach((raw, rawIndex) => {
    const code = cleanString(raw.region_code);
    if (!code) {
      outcomes[rawIndex] = 'invalid_missing';
      invalidMissing += 1;
      return;
    }
    if (!regionIndex.byCode.has(code)) {
      outcomes[rawIndex] = 'invalid_unknown';
      invalidUnknown += 1;
      return;
    }

    const key = raw.source + '|' + code;
    const group = groups.get(key);
    if (!group) {
      groups.set(key, {
        source: raw.source,
        source_rank: raw.source_rank,
        updated_days_ago: raw.updated_days_ago,
        region_code: code,
        region_name: regionIndex.byCode.get(code).name,
        region_group: regionIndex.byCode.get(code).region,
        note: raw.note,
        rawIndex,
        duplicateIndices: []
      });
      return;
    }

    // 同一人员、同一来源、同一地区：保留更新时间最新（days_ago 最小）的一行。
    if (raw.updated_days_ago < group.updated_days_ago) {
      group.duplicateIndices.push(group.rawIndex);
      group.updated_days_ago = raw.updated_days_ago;
      group.note = raw.note;
      group.rawIndex = rawIndex;
    } else {
      group.duplicateIndices.push(rawIndex);
    }
  });

  const candidates = Array.from(groups.values());
  for (const candidate of candidates) {
    for (const dupIndex of candidate.duplicateIndices) {
      outcomes[dupIndex] = 'duplicate';
      duplicates += 1;
    }
  }

  candidates.sort((a, b) => {
    if (b.source_rank !== a.source_rank) return b.source_rank - a.source_rank;
    if (a.updated_days_ago !== b.updated_days_ago) {
      return a.updated_days_ago - b.updated_days_ago;
    }
    return a.source.localeCompare(b.source);
  });

  const kept = candidates[0] || null;
  for (const candidate of candidates) {
    outcomes[candidate.rawIndex] = candidate === kept ? 'kept' : 'discarded';
  }

  const invalid = invalidMissing + invalidUnknown;
  const discarded = kept ? candidates.length - 1 : 0;

  return {
    kept,
    outcomes,
    invalid,
    duplicates,
    invalidMissing,
    invalidUnknown,
    candidateCount: candidates.length,
    discarded,
    keptSource: kept ? kept.source : null
  };
}

export function buildDataset(sample) {
  const regionIndex = buildRegionIndex(sample.regions);
  const people = [];
  const stats = {
    people_total: sample.people.length,
    raw_records: 0,
    removed_invalid: 0,
    removed_missing_region: 0,
    removed_unknown_region: 0,
    removed_duplicates: 0,
    valid_candidates: 0,
    discarded_by_priority: 0,
    people_kept: 0,
    people_excluded: 0,
    people_with_conflict: 0,
    kept_by_source: {
      residence: 0,
      registry: 0,
      carrier: 0,
      activity: 0
    },
    regions_with_data: 0
  };

  const counts = new Array(sample.regions.length).fill(0);
  const regionIndexByCode = new Map(
    sample.regions.map((region, index) => [region.code, index])
  );

  for (const person of sample.people) {
    stats.raw_records += person.raw.length;
    const decision = evaluatePerson(person, regionIndex);
    stats.removed_invalid += decision.invalid;
    stats.removed_missing_region += decision.invalidMissing;
    stats.removed_unknown_region += decision.invalidUnknown;
    stats.removed_duplicates += decision.duplicates;
    stats.valid_candidates += decision.candidateCount;
    stats.discarded_by_priority += decision.discarded;

    if (decision.kept) {
      stats.people_kept += 1;
      stats.kept_by_source[decision.keptSource] += 1;
      if (decision.candidateCount > 1) stats.people_with_conflict += 1;
      const idx = regionIndexByCode.get(decision.kept.region_code);
      counts[idx] += 1;
    } else {
      stats.people_excluded += 1;
    }

    people.push({
      person_id: person.person_id,
      name: person.name,
      raw: person.raw,
      outcomes: decision.outcomes,
      kept: decision.kept,
      discarded: decision.discarded,
      invalid: decision.invalid,
      duplicates: decision.duplicates
    });
  }

  stats.regions_with_data = counts.filter((count) => count > 0).length;

  // 锁定时必须区分的口径：每个有效人员恰好贡献 0 或 1 条记录 → 敏感度 1。
  if (stats.people_kept !== counts.reduce((sum, count) => sum + count, 0)) {
    throw new Error('内部不一致：保留人数与地区计数总和不相等');
  }
  if (stats.raw_records !==
    stats.removed_invalid + stats.removed_duplicates + stats.valid_candidates) {
    throw new Error('内部不一致：原始记录去向之和不等于原始记录数');
  }

  return {
    sample,
    regions: sample.regions,
    regionIndex,
    people,
    stats,
    counts
  };
}

export function sourceLabel(source) {
  return SOURCE_LABELS[source] || source;
}

export function trueCountForRegion(dataset, regionCode) {
  const index = dataset.regions.findIndex((region) => region.code === regionCode);
  if (index < 0) return null;
  return dataset.counts[index];
}

// 选取能代表各类处理分支的人员，供页面展示去重与剔除过程。
// 每个分支尽量使用不同的人，避免一张卡同时承担多个标签。
export function pipelinePreview(dataset, limit = 8) {
  const wanted = ['conflict', 'duplicate', 'invalid', 'excluded', 'plain'];
  const candidatesByKey = {
    conflict: [],
    duplicate: [],
    invalid: [],
    excluded: [],
    plain: []
  };

  for (const person of dataset.people) {
    const duplicate = person.outcomes.filter(
      (outcome) => outcome === 'duplicate'
    ).length;
    if (person.discarded > 0) candidatesByKey.conflict.push(person);
    if (duplicate > 0) candidatesByKey.duplicate.push(person);
    if (person.invalid > 0 && person.kept) candidatesByKey.invalid.push(person);
    if (!person.kept) candidatesByKey.excluded.push(person);
    if (
      person.kept && person.discarded === 0 && duplicate === 0 && person.invalid === 0
    ) {
      candidatesByKey.plain.push(person);
    }
  }

  const chosen = [];
  const seen = new Set();
  for (const key of wanted) {
    const list = candidatesByKey[key];
    // 优先选择只命中该分支的人，其次是尚未被占用的人。
    const best = list.find((person) => !seen.has(person.person_id) &&
      branchLabels(person).size === 1) ||
      list.find((person) => !seen.has(person.person_id)) ||
      list[0];
    if (!best) continue;
    seen.add(best.person_id);
    chosen.push({ person: best, reason: key });
  }

  return chosen.slice(0, limit).map(({ person, reason }) => ({
    person_id: person.person_id,
    reason,
    kept: person.kept,
    records: person.raw.map((raw, index) => ({
      source: raw.source,
      source_label: sourceLabel(raw.source),
      source_rank: raw.source_rank,
      updated_days_ago: raw.updated_days_ago,
      region_name: raw.region_name,
      region_code: raw.region_code,
      note: raw.note,
      outcome: person.outcomes[index],
      outcome_label: RECORD_OUTCOME_LABELS[person.outcomes[index]]
    }))
  }));
}

function branchLabels(person) {
  const labels = new Set();
  const duplicate = person.outcomes.filter((outcome) => outcome === 'duplicate').length;
  if (person.discarded > 0) labels.add('conflict');
  if (duplicate > 0) labels.add('duplicate');
  if (person.invalid > 0 && person.kept) labels.add('invalid');
  if (!person.kept) labels.add('excluded');
  if (person.kept && person.discarded === 0 && duplicate === 0 && person.invalid === 0) {
    labels.add('plain');
  }
  return labels;
}
