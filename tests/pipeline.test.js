import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSample } from '../scripts/generate-sample.js';
import { buildDataset, evaluatePerson, pipelinePreview } from '../app/pipeline.js';
import { buildRegionIndex } from '../app/pipeline.js';

test('样本生成是确定性的', () => {
  const a = buildSample();
  const b = buildSample();
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.equal(a.people.length, a.meta.sample_size);
});

test('每人至多保留一条有效记录，且保留条数等于计数总和', () => {
  const sample = buildSample();
  const dataset = buildDataset(sample);
  assert.equal(dataset.stats.people_kept, dataset.counts.reduce((a, b) => a + b, 0));
  for (const person of dataset.people) {
    const keptRows = person.outcomes.filter((outcome) => outcome === 'kept').length;
    assert.ok(keptRows <= 1 || !person.kept, `${person.person_id} 保留行数异常`);
    if (person.kept) assert.equal(person.outcomes[person.kept.rawIndex], 'kept');
  }
});

test('每条原始记录都被分到唯一去向，且去向数守恒', () => {
  const sample = buildSample();
  const dataset = buildDataset(sample);
  const stats = dataset.stats;
  assert.equal(
    stats.raw_records,
    stats.removed_invalid + stats.removed_duplicates + stats.valid_candidates
  );
  for (const person of dataset.people) {
    assert.equal(person.outcomes.length, person.raw.length);
    assert.ok(person.outcomes.every((outcome) => typeof outcome === 'string'));
  }
});

test('无效地区行被剔除，不会产生地区贡献', () => {
  const sample = buildSample();
  const dataset = buildDataset(sample);
  for (const person of dataset.people) {
    person.outcomes.forEach((outcome, index) => {
      if (outcome === 'invalid_missing' || outcome === 'invalid_unknown') {
        const raw = person.raw[index];
        const code = typeof raw.region_code === 'string' ? raw.region_code.trim() : '';
        assert.ok(!code || !dataset.regionIndex.byCode.has(code));
      }
    });
  }
});

test('重复行仅保留最新一条，且同组最多一条进入候选', () => {
  const sample = buildSample();
  const dataset = buildDataset(sample);
  for (const person of dataset.people) {
    const groups = new Map();
    person.raw.forEach((raw, index) => {
      const code = typeof raw.region_code === 'string' ? raw.region_code.trim() : '';
      if (!code || !dataset.regionIndex.byCode.has(code)) return;
      const key = raw.source + '|' + code;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(index);
    });
    for (const indices of groups.values()) {
      const keptInGroup = indices.filter((index) => person.outcomes[index] === 'kept');
      const discardedInGroup = indices.filter((index) => person.outcomes[index] === 'discarded');
      const duplicateInGroup = indices.filter((index) => person.outcomes[index] === 'duplicate');
      if (indices.length > 1) {
        // 重复组内至多一条候选（kept 或 discarded），其余全部标记 duplicate。
        assert.ok(keptInGroup.length + discardedInGroup.length <= 1);
        assert.equal(duplicateInGroup.length, indices.length - 1);
      }
    }
  }
});

test('来源优先级高的记录胜出；同优先级取更新时间更新的', () => {
  const regions = [
    { code: '110000', name: '北京市', region: '华北' },
    { code: '310000', name: '上海市', region: '华东' }
  ];
  const regionIndex = buildRegionIndex(regions);
  const person = {
    person_id: 'T1',
    name: '测试',
    raw: [
      { source: 'carrier', source_rank: 2, updated_days_ago: 1, region_code: '110000', region_name: '北京市', note: '' },
      { source: 'residence', source_rank: 4, updated_days_ago: 30, region_code: '310000', region_name: '上海市', note: '' },
      { source: 'registry', source_rank: 3, updated_days_ago: 2, region_code: '110000', region_name: '北京市', note: '' }
    ]
  };
  const decision = evaluatePerson(person, regionIndex);
  assert.equal(decision.kept.source, 'residence');
  assert.equal(decision.kept.region_code, '310000');
  assert.equal(decision.discarded, 2);

  const sameRank = {
    person_id: 'T2',
    name: '测试',
    raw: [
      { source: 'residence', source_rank: 4, updated_days_ago: 90, region_code: '110000', region_name: '北京市', note: '' },
      { source: 'residence', source_rank: 4, updated_days_ago: 5, region_code: '310000', region_name: '上海市', note: '' }
    ]
  };
  assert.equal(evaluatePerson(sameRank, regionIndex).kept.region_code, '310000');
});

test('没有任何有效记录的人员被整体剔除', () => {
  const regions = [{ code: '110000', name: '北京市', region: '华北' }];
  const decision = evaluatePerson({
    person_id: 'T3',
    name: '测试',
    raw: [
      { source: 'registry', source_rank: 3, updated_days_ago: 10, region_code: null, region_name: null, note: '' },
      { source: 'carrier', source_rank: 2, updated_days_ago: 3, region_code: '   ', region_name: '', note: '' }
    ]
  }, buildRegionIndex(regions));
  assert.equal(decision.kept, null);
  assert.equal(decision.invalid, 2);
});

test('预览样本覆盖冲突、重复、无效、剔除与普通分支', () => {
  const dataset = buildDataset(buildSample());
  const preview = pipelinePreview(dataset, 8);
  const reasons = new Set(preview.map((person) => person.reason));
  for (const wanted of ['conflict', 'duplicate', 'invalid', 'excluded', 'plain']) {
    assert.ok(reasons.has(wanted), '缺少预览分支: ' + wanted);
  }
  for (const person of preview) {
    for (const record of person.records) {
      assert.ok(record.outcome_label);
    }
  }
});
