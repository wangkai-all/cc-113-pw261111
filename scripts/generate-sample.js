// 固定人员样本：确定性生成，随程序一起提交，不随请求变化。
// 每个 mock 人员最多带多条地区来源记录，其中混有冲突、空值、与地区无关的错误行，
// 用于演示“每人先按明确规则保留一条有效地区记录”的去重与剔除过程。

const REGIONS = [
  { code: '110000', name: '北京市', region: '华北' },
  { code: '120000', name: '天津市', region: '华北' },
  { code: '130100', name: '石家庄市', region: '华北' },
  { code: '140100', name: '太原市', region: '华北' },
  { code: '150100', name: '呼和浩特市', region: '华北' },
  { code: '210100', name: '沈阳市', region: '东北' },
  { code: '220100', name: '长春市', region: '东北' },
  { code: '230100', name: '哈尔滨市', region: '东北' },
  { code: '310000', name: '上海市', region: '华东' },
  { code: '320100', name: '南京市', region: '华东' },
  { code: '330100', name: '杭州市', region: '华东' },
  { code: '340100', name: '合肥市', region: '华东' },
  { code: '350100', name: '福州市', region: '华东' },
  { code: '370100', name: '济南市', region: '华东' },
  { code: '410100', name: '郑州市', region: '华中' },
  { code: '420100', name: '武汉市', region: '华中' },
  { code: '430100', name: '长沙市', region: '华中' },
  { code: '440100', name: '广州市', region: '华南' },
  { code: '450100', name: '南宁市', region: '华南' },
  { code: '460100', name: '海口市', region: '华南' },
  { code: '500000', name: '重庆市', region: '西南' },
  { code: '510100', name: '成都市', region: '西南' },
  { code: '520100', name: '贵阳市', region: '西南' },
  { code: '530100', name: '昆明市', region: '西南' },
  { code: '610100', name: '西安市', region: '西北' },
  { code: '620100', name: '兰州市', region: '西北' },
  { code: '630100', name: '西宁市', region: '西北' },
  { code: '650100', name: '乌鲁木齐市', region: '西北' }
];

const SURNAMES = [
  '王', '李', '张', '刘', '陈', '杨', '赵', '黄', '周', '吴',
  '徐', '孙', '胡', '朱', '高', '林', '何', '郭', '马', '罗',
  '梁', '宋', '郑', '谢', '韩', '唐', '冯', '于', '董', '萧',
  '程', '曹', '袁', '邓', '许', '傅', '沈', '曾', '彭', '吕'
];

const GIVEN = [
  '伟', '芳', '娜', '敏', '静', '丽', '强', '磊', '军', '洋',
  '勇', '艳', '杰', '娟', '涛', '明', '超', '秀英', '霞', '平',
  '刚', '桂英', '文', '辉', '建华', '雪', '婷', '浩', '宁', '琳',
  '晨', '宇', '欣', '然', '嘉', '睿', '泽', '旭', '晴', '帆',
  '子涵', '一诺', '思远', '雨桐', '梓萱', '俊豪', '梦琪', '志强', '春梅', '海燕'
];

const SAMPLE_SIZE = 1200;
const RULE_VERSION = 'R-2026.11';
// 样例数据生成器的一次性固定种子。改变它会改变整份样本与真值，
// 因此连同规则、契约一起被视为需要确认后锁定的内容。
const SEED = 'SAMPLE-2026.11-REGION-V1';

function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function intBetween(rng, min, max) {
  return min + Math.floor(rng() * (max - min + 1));
}

function pad(value, width) {
  return String(value).padStart(width, '0');
}

function buildPerson(index) {
  const rng = mulberry32(hash32(SEED + '|person|' + index));
  const personId = 'P' + pad(index + 1, 5);
  const name = SURNAMES[intBetween(rng, 0, SURNAMES.length - 1)] +
    GIVEN[intBetween(rng, 0, GIVEN.length - 1)];

  // 主记录：约 4% 的样本此人没有任何可得地区，用以展示“无可保留记录”剔除。
  const hasPrimary = rng() > 0.04;
  const primaryRegion = REGIONS[intBetween(rng, 0, REGIONS.length - 1)];

  const raw = [];
  if (hasPrimary) {
    raw.push({
      source: 'registry',
      source_rank: 3,
      updated_days_ago: intBetween(rng, 1, 400),
      region_code: primaryRegion.code,
      region_name: primaryRegion.name,
      note: '户籍登记'
    });
  } else {
    // 档案缺失：登记记录地区为空，但仍保留一条结构化记录，
    // 用于展示“字段缺失被剔除、且无其他可用来源”。
    raw.push({
      source: 'registry',
      source_rank: 3,
      updated_days_ago: intBetween(rng, 1, 400),
      region_code: null,
      region_name: null,
      note: '户籍登记（地区字段缺失）'
    });
  }

  // 手机归属地记录：较旧、优先级较低，有时与主记录冲突。
  if (rng() < 0.62) {
    const conflict = hasPrimary && rng() < 0.17;
    const picked = conflict ? REGIONS[intBetween(rng, 0, REGIONS.length - 1)] : primaryRegion;
    raw.push({
      source: 'carrier',
      source_rank: 2,
      updated_days_ago: intBetween(rng, 120, 900),
      region_code: picked.code,
      region_name: picked.name,
      note: '手机号归属地'
    });
  }

  // 居住申报：较新、优先级高，偶尔与主记录冲突；部分记录地区字段为空白字符串。
  if (rng() < 0.48) {
    const conflict = hasPrimary && rng() < 0.12;
    const picked = conflict ? REGIONS[intBetween(rng, 0, REGIONS.length - 1)] : primaryRegion;
    const blank = rng() < 0.05;
    raw.push({
      source: 'residence',
      source_rank: 4,
      updated_days_ago: intBetween(rng, 0, 120),
      region_code: blank ? '' : picked.code,
      region_name: blank ? '' : picked.name,
      note: blank ? '居住申报（地区为空字符串）' : '居住申报'
    });
  }

  // 无关的日志行：没有地区信息，来源优先级最低，用于展示“无法定位地区的行”剔除。
  if (rng() < 0.33) {
    raw.push({
      source: 'activity',
      source_rank: 1,
      updated_days_ago: intBetween(rng, 0, 30),
      region_code: null,
      region_name: null,
      note: '登录日志（无地区字段）'
    });
  }

  // 完全重复的行：同一来源同一地区重复上报，用于展示内容重复剔除。
  if (raw.length && rng() < 0.18) {
    const pick = raw[intBetween(rng, 0, raw.length - 1)];
    raw.push({ ...pick, note: pick.note + '（重复上报）', source_rank: pick.source_rank });
  }

  return { person_id: personId, name, raw };
}

export function buildSample() {
  const people = [];
  for (let i = 0; i < SAMPLE_SIZE; i += 1) people.push(buildPerson(i));
  return {
    meta: {
      sample_id: 'REGION-SAMPLE-2026.11',
      sample_name: '项目内固定人员样本（2026 年 11 月）',
      sample_size: SAMPLE_SIZE,
      seed: SEED,
      generator: 'scripts/generate-sample.js',
      note: '确定性生成的模拟人员样本，仅用于本项目原型演示；不是真实人口数据。'
    },
    region_rule: {
      version: RULE_VERSION,
      title: '每人保留一条有效地区记录的规则',
      steps: [
        '只接受带 6 位地区代码、且该代码能在固定地区表中命中的记录；地区名称一律以固定地区表为准。空值、空字符串与无地区字段的日志行剔除。',
        '同一人员、同一来源、同一地区代码的重复行视为内容重复，仅保留更新时间最新的一条。',
        '有效的候选按优先级排序：居住申报(4) > 户籍登记(3) > 手机归属地(2) > 登录日志(1)；同优先级取更新时间最新（updated_days_ago 更小）。',
        '每人最终只保留排序后的第一条；排序仅用于选出保留记录，不把被替换的冲突记录当作额外计数。',
        '没有任何有效记录的人员整体剔除，不产生地区贡献。'
      ],
      priority: [
        { source: 'residence', source_rank: 4, label: '居住申报' },
        { source: 'registry', source_rank: 3, label: '户籍登记' },
        { source: 'carrier', source_rank: 2, label: '手机号归属地' },
        { source: 'activity', source_rank: 1, label: '登录日志' }
      ]
    },
    regions: REGIONS,
    people
  };
}

// 直接运行（npm run generate:sample）时只打印确定性样本的摘要，方便核对；
// 不写文件，样本永远由 buildSample 在内存中重建。
if (import.meta.url === `file://${process.argv[1]}`) {
  const { buildDataset } = await import('../app/pipeline.js');
  const { truthSummary } = await import('../app/truth.js');
  const sample = buildSample();
  const dataset = buildDataset(sample);
  const summary = truthSummary(dataset);
  console.log(`样本 ${sample.meta.sample_id} · 种子 ${sample.meta.seed} · 规则 ${sample.region_rule.version}`);
  console.log(`  人员 ${sample.meta.sample_size} 人 · 原始记录 ${dataset.stats.raw_records} 条 · 地区 ${sample.regions.length} 个`);
  console.log(`  剔除无效行 ${dataset.stats.removed_invalid} · 合并重复 ${dataset.stats.removed_duplicates} · 按优先级替换 ${dataset.stats.discarded_by_priority}`);
  console.log(`  保留记录 ${dataset.stats.people_kept} 人 · 整人剔除 ${dataset.stats.people_excluded} 人`);
  console.log(`  地区人数范围 ${summary.min_nonzero_region}–${summary.max_region}，合计 ${summary.total}`);
}
