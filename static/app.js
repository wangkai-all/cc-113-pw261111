// 页面逻辑：所有数值都来自后端的锁定快照、预算事务结果与查询历史。
// 图表为原生 HTML/CSS，不引入外部依赖；颜色走 CSS 变量（浅/深两套已选步进）。

const state = {
  bootstrap: null,
  selectedRegions: new Set(),
  history: null,
  lastQueryFingerprint: null,
  loadingHistory: false
};

const el = (id) => document.getElementById(id);

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function fmtEpsilon(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
  const number = Number(value);
  if (number === 0) return '0';
  const fixed = number.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
  return fixed;
}

function fmtNumber(value, digits = 2) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
  return Number(value).toLocaleString('zh-CN', {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits
  });
}

function fmtTime(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('zh-CN', { hour12: false });
}

function shortHash(hash, head = 10, tail = 6) {
  if (!hash) return '—';
  return hash.slice(0, head) + '…' + hash.slice(-tail);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    ...options
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const error = new Error(payload?.message || `请求失败（${response.status}）`);
    error.code = payload?.code;
    error.payload = payload;
    error.status = response.status;
    throw error;
  }
  return payload;
}

// ---------- 主题 ----------
function initTheme() {
  const stored = localStorage.getItem('region-dp-theme');
  if (stored === 'light' || stored === 'dark') {
    document.documentElement.dataset.theme = stored;
  }
  const button = el('theme-toggle');
  const sync = () => {
    const effective = document.documentElement.dataset.theme ||
      (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    button.textContent = effective === 'dark' ? '浅色' : '深色';
  };
  sync();
  button.addEventListener('click', () => {
    const current = document.documentElement.dataset.theme ||
      (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('region-dp-theme', next);
    sync();
  });
}

// ---------- 标签页 ----------
function initTabs() {
  const tabs = Array.from(document.querySelectorAll('.tab'));
  const activate = (tab, { focus = false } = {}) => {
    tabs.forEach((item) => {
      const selected = item === tab;
      item.setAttribute('aria-selected', String(selected));
      const panel = el(item.getAttribute('aria-controls'));
      if (panel) panel.classList.toggle('active', selected);
    });
    if (focus) tab.focus();
    const panel = el(tab.getAttribute('aria-controls'));
    if (panel && (tab.id === 'tab-budget' || tab.id === 'tab-history')) {
      loadHistory();
    }
    if (panel && tab.id === 'tab-truth') {
      loadTruth();
    }
  };
  tabs.forEach((tab) => {
    tab.addEventListener('click', () => activate(tab));
    tab.addEventListener('keydown', (event) => {
      const index = tabs.indexOf(tab);
      if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
        event.preventDefault();
        const next = event.key === 'ArrowRight'
          ? tabs[(index + 1) % tabs.length]
          : tabs[(index - 1 + tabs.length) % tabs.length];
        activate(next, { focus: true });
      }
      if (event.key === 'Home') { event.preventDefault(); activate(tabs[0], { focus: true }); }
      if (event.key === 'End') { event.preventDefault(); activate(tabs[tabs.length - 1], { focus: true }); }
    });
  });
}

// ---------- 顶栏与 KPI ----------
function renderBootstrap(data) {
  state.bootstrap = data;
  el('brand-sub').textContent = data.sample.sample_id;
  renderLockState();

  el('kpi-people').innerHTML = fmtNumber(data.sample.sample_size) + '<span class="unit">人</span>';
  el('kpi-people-note').textContent = data.sample.note;
  el('kpi-kept').innerHTML = fmtNumber(data.stats.people_kept) + '<span class="unit">人</span>';
  el('kpi-kept-note').textContent =
    `${data.stats.people_excluded} 人无可保留记录；保留记录分布在 ` +
    `${data.stats.regions_with_data} 个地区（具体人数需通过扣费查询获得）`;

  renderRegionGroups(data.regions);
  renderPipeline(data);
  renderAbout(data);
  renderBudget(data.budget, data);
  updateCost();
}

function lockConflict() {
  return state.bootstrap?.lock_error || null;
}

function renderLockState() {
  const data = state.bootstrap;
  if (!data) return;
  const conflict = data.lock_error;
  const locked = data.locked;
  const badge = el('lock-badge');
  const badgeText = el('lock-badge-text');
  const dot = el('lock-badge-dot');
  const stripText = el('lock-strip-text');
  const stripHash = el('lock-strip-hash');
  const stripDot = el('lock-strip-dot');
  const action = el('lock-strip-action');

  badge.className = 'badge ' + (locked ? 'good' : 'warn');
  dot.style.background = locked ? 'var(--status-good)' : 'var(--status-warning)';
  badgeText.textContent = locked ? '已锁定 · ' + data.lock.rule_version : '未锁定';

  if (conflict) {
    badge.className = 'badge critical';
    dot.style.background = 'var(--status-critical)';
    badgeText.textContent = '锁定冲突';
    stripDot.style.background = 'var(--status-critical)';
    const mismatched = Array.isArray(conflict.mismatched) && conflict.mismatched.length
      ? '（不一致字段：' + conflict.mismatched.join('、') + '）'
      : '';
    stripText.textContent =
      '当前文件与已锁定版本不一致，查询已停用' + mismatched +
      '；改名、复制或替换数据都不能重置原有预算。';
    stripHash.hidden = true;
    action.hidden = true;
  } else if (locked) {
    stripDot.style.background = 'var(--series-1)';
    stripText.textContent =
      `样本 ${data.lock.sample_id}、贡献规则 ${data.lock.rule_version}、查询契约 ` +
      `${data.lock.contract_version} 已锁定；锁定于 ${fmtTime(data.lock.locked_at)}。`;
    stripHash.hidden = false;
    stripHash.textContent = 'sample ' + shortHash(data.lock.sample_hash);
    stripHash.title =
      'sample_hash=' + data.lock.sample_hash + '\nrule_hash=' + data.lock.rule_hash +
      '\ncontract_hash=' + data.lock.contract_hash;
    action.hidden = true;
  } else {
    stripDot.style.background = 'var(--status-warning)';
    stripText.textContent =
      '数据与贡献规则尚未确认锁定；锁定前不能提交查询，预算暂不产生扣减。';
    stripHash.hidden = true;
    action.hidden = false;
  }

  const lockCardBadge = el('lock-card-badge');
  lockCardBadge.className = 'badge ' + (conflict ? 'critical' : (locked ? 'good' : 'warn'));
  lockCardBadge.innerHTML = conflict
    ? '锁定冲突'
    : (locked ? '<span class="dot"></span>已锁定' : '等待确认');

  const fields = [
    ['sample_hash', 'sample_hash'],
    ['rule_hash', 'rule_hash'],
    ['contract_hash', 'contract_hash'],
    ['sample_id', 'sample_id'],
    ['sample_size', 'sample_size'],
    ['rule_version', 'rule_version'],
    ['contract_version', 'contract_version'],
    ['sensitivity', 'sensitivity']
  ];
  const hashRows = (record, mismatched = []) => fields.map(([key, field]) =>
    `<div class="hash-row${mismatched.includes(field) ? ' mismatch' : ''}">` +
    `<span class="k">${escapeHtml(key)}</span>` +
    `<span class="v">${escapeHtml(record[field])}</span></div>`
  ).join('');

  if (conflict) {
    // 冲突时同时展示“已锁定记录”和“当前文件”，让不一致字段一眼可见。
    const mismatched = Array.isArray(conflict.mismatched) ? conflict.mismatched : [];
    el('lock-pending-rows').innerHTML =
      '<div class="hint" style="margin-bottom:6px">已写入的锁定记录（预算与流水保持有效）</div>' +
      hashRows(data.lock || {}, mismatched) +
      '<div class="hint" style="margin:10px 0 6px">当前文件计算出的内容（不会写入）</div>' +
      hashRows(data.pending_lock || {}, mismatched);
  } else {
    const pendingLabel = data.locked ? '已写入的锁定记录' : '即将锁定的内容（尚未写入）';
    el('lock-pending-rows').innerHTML =
      `<div class="hint" style="margin-bottom:6px">${pendingLabel}</div>` +
      hashRows(data.locked ? data.lock : data.pending_lock);
  }

  el('confirm-lock').disabled = locked || !!conflict;
  el('lock-admin-token').disabled = locked || !!conflict;
  el('confirm-lock').textContent = conflict ? '锁定冲突' : (locked ? '已锁定' : '确认并锁定');
}

function renderBudgetKpis(budget, summary) {
  const remaining = budget ? budget.remaining_epsilon : null;
  el('kpi-remaining').innerHTML = budget
    ? fmtEpsilon(remaining) + '<span class="unit">ε</span>'
    : '—<span class="unit">ε</span>';
  const ratio = budget && budget.total_epsilon > 0
    ? Math.min(100, Math.max(0, (budget.spent_epsilon / budget.total_epsilon) * 100))
    : 0;
  el('budget-meter-fill').style.width = ratio + '%';
  el('budget-meter-fill-2').style.width = ratio + '%';
  el('kpi-spent').textContent = budget
    ? `已用 ${fmtEpsilon(budget.spent_epsilon)} ε`
    : '尚未设置总额';
  el('kpi-total').textContent = budget
    ? `总额 ${fmtEpsilon(budget.total_epsilon)} ε`
    : '需管理员设置';
  const queryCount = summary ? summary.query_count : (state.bootstrap?.stats ? 0 : 0);
  el('kpi-queries').innerHTML = fmtNumber(queryCount || 0) + '<span class="unit">行</span>';
  el('kpi-queries-note').textContent = summary
    ? `流水 ${summary.ledger_count} 条 · 失败尝试 ${summary.failed_count} 次`
    : '成功执行与重放共用同一查询行';

  const meterColor = !budget
    ? 'var(--status-warning)'
    : remaining <= 0
      ? 'var(--status-critical)'
      : remaining < budget.total_epsilon * 0.25
        ? 'var(--status-serious)'
        : 'var(--series-1)';
  el('budget-meter').style.setProperty('--meter-fill', meterColor);
  el('budget-meter-fill').style.background = meterColor;
  el('budget-meter-fill-2').style.background = meterColor;
}

// ---------- 查询表单 ----------
function renderRegionGroups(regions) {
  const container = el('region-groups');
  const groups = new Map();
  for (const region of regions) {
    if (!groups.has(region.region)) groups.set(region.region, []);
    groups.get(region.region).push(region);
  }
  const parts = [];
  for (const [group, items] of groups) {
    parts.push('<div class="region-group">');
    parts.push(
      `<div class="region-group-title"><span>${escapeHtml(group)}</span>` +
      `<span>${items.length} 个地区</span></div>`
    );
    parts.push('<div class="region-grid">');
    for (const region of items) {
      parts.push(
        '<label class="region-check">' +
        `<input type="checkbox" value="${region.code}" data-region="${region.code}" />` +
        `<span>${escapeHtml(region.name)}</span>` +
        '</label>'
      );
    }
    parts.push('</div></div>');
  }
  container.innerHTML = parts.join('');
  container.addEventListener('change', (event) => {
    const input = event.target.closest('input[type="checkbox"]');
    if (!input) return;
    if (input.checked) state.selectedRegions.add(input.value);
    else state.selectedRegions.delete(input.value);
    updateCost();
  });

  el('region-select-some').addEventListener('click', () => {
    // 示例按钮只按固定顺序取前 3 个地区，不依赖人数，不泄露哪个地区人多人少。
    const picks = (state.bootstrap?.regions || []).slice(0, 3);
    state.selectedRegions = new Set(picks.map((region) => region.code));
    syncRegionCheckboxes();
    updateCost();
  });
  el('region-clear').addEventListener('click', () => {
    state.selectedRegions.clear();
    syncRegionCheckboxes();
    updateCost();
  });
}

function syncRegionCheckboxes() {
  document.querySelectorAll('input[data-region]').forEach((input) => {
    input.checked = state.selectedRegions.has(input.value);
  });
}

function budgetForGate() {
  return state.bootstrap?.budget || null;
}

function updateCost() {
  const epsilonRaw = el('epsilon-input').value.trim();
  const epsilon = Number(epsilonRaw);
  const count = state.selectedRegions.size;
  const epsilonValid = epsilonRaw !== '' && Number.isFinite(epsilon) && epsilon > 0;
  const budget = budgetForGate();

  el('region-count-hint').textContent = count === 0 ? '未选择' : `已选 ${count} 个地区`;

  if (!epsilonValid || count === 0) {
    el('cost-value').textContent = '— ε';
    el('cost-formula').textContent = count === 0
      ? '费用 = 地区数 × 额度'
      : `费用 = ${count} × 额度`;
  } else {
    const total = Math.round(epsilon * count * 1e6) / 1e6;
    el('cost-formula').textContent = `费用 = ${count} × ${fmtEpsilon(epsilon)} ε`;
    el('cost-value').textContent = `${fmtEpsilon(total)} ε`;
  }

  const submit = el('submit-query');
  const conflict = lockConflict();
  const unlocked = state.bootstrap && !state.bootstrap.locked;
  let gateMessage = '';
  // 页面用当前预算快照提前阻止明显会失败的提交；最终裁决仍以后端事务为准，
  // 因此并发场景下页面快照过期时，服务端仍会拒绝并显示具体原因。
  let blocked = false;
  if (conflict) {
    gateMessage = '当前文件与已锁定版本冲突，查询会被服务端拒绝';
    blocked = true;
  } else if (unlocked) {
    gateMessage = '需先确认锁定数据与贡献规则，才能提交查询';
    blocked = true;
  } else if (!budget) {
    gateMessage = '管理员尚未设置总预算，提交会被服务端拒绝且不扣费';
    blocked = true;
  } else if (epsilonValid && count > 0) {
    const total = Math.round(epsilon * count * 1e6) / 1e6;
    if (total > budget.remaining_epsilon + 1e-9) {
      gateMessage =
        `预计 ${fmtEpsilon(total)} ε 超过剩余 ${fmtEpsilon(budget.remaining_epsilon)} ε，` +
        '已阻止提交；失败请求不扣费';
      blocked = true;
    } else {
      gateMessage = `剩余 ${fmtEpsilon(budget.remaining_epsilon)} ε，提交后剩 ` +
        `${fmtEpsilon(Math.max(0, budget.remaining_epsilon - total))} ε`;
    }
  } else {
    gateMessage = `剩余 ${fmtEpsilon(budget.remaining_epsilon)} ε`;
  }
  el('budget-gate-hint').textContent = gateMessage;
  submit.disabled = blocked || !epsilonValid || count === 0;
}

function showNotice(id, kind, html) {
  const node = el(id);
  node.className = 'notice show ' + (kind || '');
  node.innerHTML = html;
}

function hideNotice(id) {
  const node = el(id);
  node.className = 'notice';
  node.innerHTML = '';
}

function initLockForm() {
  el('lock-strip-action').addEventListener('click', () => {
    document.getElementById('tab-pipeline').click();
    el('lock-admin-token').focus();
  });
  el('confirm-lock').addEventListener('click', async () => {
    hideNotice('lock-notice');
    const token = el('lock-admin-token').value.trim();
    if (!token) {
      showNotice('lock-notice', 'error', '请输入管理员令牌后再确认锁定。');
      return;
    }
    const button = el('confirm-lock');
    button.disabled = true;
    try {
      const payload = await api('/api/admin/lock', {
        method: 'POST',
        headers: { 'x-admin-token': token },
        body: JSON.stringify({ confirm: true })
      });
      state.bootstrap.lock = payload.lock;
      state.bootstrap.locked = true;
      state.bootstrap.lock_error = null;
      showNotice('lock-notice', 'ok', escapeHtml(payload.message));
      renderLockState();
      renderAbout(state.bootstrap);
      updateCost();
    } catch (error) {
      showNotice('lock-notice', 'error', escapeHtml(error.message));
      button.disabled = false;
    }
  });
}

function initQueryForm() {
  el('epsilon-input').addEventListener('input', updateCost);
  el('submit-query').addEventListener('click', submitQuery);
}

async function submitQuery() {
  const epsilon = Number(el('epsilon-input').value);
  const regions = Array.from(state.selectedRegions);
  const submit = el('submit-query');
  hideNotice('query-notice');

  if (!regions.length) {
    showNotice('query-notice', 'error', '请至少选择一个地区。');
    return;
  }
  if (!Number.isFinite(epsilon) || epsilon <= 0) {
    showNotice('query-notice', 'error', '额度必须是大于 0 的数字。');
    return;
  }

  submit.disabled = true;
  submit.textContent = '提交中…';
  try {
    const payload = await api('/api/query', {
      method: 'POST',
      body: JSON.stringify({ regions, epsilon })
    });
    state.lastQueryFingerprint = payload.fingerprint;
    showNotice(
      'query-notice',
      'ok',
      payload.replayed
        ? '<strong>已返回保存的噪声结果。</strong>相同规范化查询与相同额度此前已成功执行；' +
          '本次没有重新抽样，也没有再次扣费。'
        : '<strong>扣费成功并已返回噪声结果。</strong>本次从预算中扣减 ' +
          `${fmtEpsilon(payload.query.total_cost)} ε（${payload.query.region_count} 个地区 × ` +
          `${fmtEpsilon(payload.query.epsilon)} ε）。`
    );
    renderResult(payload);
    applyBudgetPayload(payload.budget);
    await loadHistory();
  } catch (error) {
    const detail = error.payload?.detail;
    let html = escapeHtml(error.message);
    if (detail && error.code === 'insufficient_budget') {
      html += `<br><span class="hint">所需 ${fmtEpsilon(detail.requested_total_epsilon)} ε，` +
        `剩余 ${fmtEpsilon(detail.remaining_epsilon)} ε。失败请求不写流水、不扣费。</span>`;
    }
    showNotice('query-notice', 'error', html);
    if (error.payload?.budget) applyBudgetPayload(error.payload.budget);
  } finally {
    submit.textContent = '提交并扣减预算';
    updateCost();
  }
}

function applyBudgetPayload(budget) {
  if (!state.bootstrap) return;
  state.bootstrap.budget = budget;
  state.bootstrap.budget_set = !!budget;
  renderBudget(budget, state.bootstrap);
  if (state.history?.summary) state.history.budget = budget;
}

function renderResult(payload) {
  const query = payload.query;
  const results = query.results;
  const nameOf = new Map(
    (state.bootstrap?.regions || []).map((region) => [region.code, region.name])
  );
  el('result-placeholder').hidden = true;
  el('result-body').hidden = false;

  const badge = el('result-origin-badge');
  badge.style.display = '';
  badge.className = 'badge ' + (payload.replayed ? 'warn' : 'good');
  badge.textContent = payload.replayed ? '保存结果重放' : '本次新执行';

  el('result-title').textContent =
    `${query.region_count} 个地区 · 每次 ε=${fmtEpsilon(query.epsilon)} · ` +
    (payload.replayed
      ? `保存结果，本次未扣费（原扣费 ${fmtEpsilon(query.total_cost)} ε）`
      : `本次扣费 ${fmtEpsilon(query.total_cost)} ε`);
  el('result-meta').textContent =
    `ns = ${fmtEpsilon(results.noise_scale)} · 指纹 ${shortHash(payload.fingerprint, 8, 4)}`;

  const rows = results.regions.map((row) => {
    const lift = row.display_value - row.raw_noisy;
    const rawClass = row.raw_noisy < 0 ? 'value-zero' : '';
    return '<tr>' +
      `<td class="lead">${escapeHtml(nameOf.get(row.region_code) || row.region_code)}</td>` +
      `<td class="num"><span class="value-raw ${rawClass}">${fmtNumber(row.raw_noisy, 2)}</span></td>` +
      `<td class="num"><span class="value-display">${fmtNumber(row.display_value, 2)}</span></td>` +
      `<td class="num">${lift > 0
        ? `<span class="delta-neg">+${fmtNumber(lift, 2)}</span>`
        : '<span class="value-zero">0</span>'}</td>` +
      '</tr>';
  });
  el('result-tbody').innerHTML = rows.join('');
  el('result-caption').textContent =
    `总费用 ${fmtEpsilon(query.total_cost)} ε = ${query.region_count} 个地区 × ` +
    `${fmtEpsilon(query.epsilon)} ε，ns = ${fmtEpsilon(results.noise_scale)}。` +
    '“非负处理抬升”列 = 展示值 − 原始带噪值，只会出现在 raw 为负的行；' +
    '想对照误差请到独立的真值对照页。重放不会产生新的噪声。';
}

// ---------- 数据处理 ----------
function renderPipeline(data) {
  const stats = data.stats;
  // 规则版本来自样本本身；锁定前展示待锁定版本，锁定后展示已写入版本。
  const ruleVersion = (data.lock || data.pending_lock).rule_version;
  el('rule-version-badge').textContent = '规则 ' + ruleVersion;
  el('rule-lede').textContent =
    '锁定版本 ' + ruleVersion +
    '：先剔除无地区/空地区/未知代码的行，再合并同来源同地区重复行，' +
    '最后按来源优先级与更新时间只保留一条。';
  el('rule-steps').innerHTML = data.rule_steps.map(
    (step) => `<li>${escapeHtml(step)}</li>`
  ).join('');
  el('priority-list').innerHTML = data.rule_priority.map(
    (item) => `<span class="badge blue">${escapeHtml(item.label)} · 优先级 ${item.source_rank}</span>`
  ).join('');

  el('removal-stats').innerHTML = [
    ['原始记录', fmtNumber(stats.raw_records)],
    ['剔除无效地区行', fmtNumber(stats.removed_invalid)],
    ['合并重复行', fmtNumber(stats.removed_duplicates)],
    ['按优先级替换', fmtNumber(stats.discarded_by_priority)],
    ['保留记录的人', fmtNumber(stats.people_kept)],
    ['整人剔除（无有效记录）', fmtNumber(stats.people_excluded)]
  ].map(([k, v]) => `<div class="mini-stat"><div class="k">${k}</div><div class="v">${v}</div></div>`)
    .join('');

  renderFunnel(stats);

  el('preview-list').innerHTML = data.preview.map((person) => {
    const keptText = person.kept
      ? `保留：${escapeHtml(person.kept.region_name)}（${escapeHtml(sourceLabel(person.kept.source))}）`
      : '无保留记录 · 整人剔除';
    const records = person.records.map((record) => {
      const outcomeKind = record.outcome === 'kept'
        ? 'kept'
        : record.outcome === 'duplicate'
          ? 'duplicate'
          : record.outcome === 'discarded'
            ? 'discarded'
            : 'invalid';
      const region = record.region_name
        ? escapeHtml(record.region_name)
        : '（无地区）';
      return '<div class="person-record' + (record.outcome === 'kept' ? ' kept-row' : '') + '">' +
        `<span class="rec-source">${escapeHtml(record.source_label)}</span>` +
        `<span class="rec-detail"><strong>${region}</strong> · 更新于 ${record.updated_days_ago} 天前` +
        ` · ${escapeHtml(record.note)}</span>` +
        `<span class="outcome-chip ${outcomeKind}">${escapeHtml(record.outcome_label)}</span>` +
        '</div>';
    }).join('');
    return '<div class="person-card">' +
      `<div class="person-head"><span class="person-id">${person.person_id}` +
      `<span class="person-name">${escapeHtml(person.name || '')}</span></span>` +
      `<span class="person-kept">${keptText}</span></div>` +
      records + '</div>';
  }).join('');
}

function sourceLabel(source) {
  const map = { residence: '居住申报', registry: '户籍登记', carrier: '手机号归属地', activity: '登录日志' };
  return map[source] || source;
}

function renderFunnel(stats) {
  const stages = [
    { label: '原始记录', value: stats.raw_records, sub: '人 × 多条来源' },
    { label: '剔除无效地区行', value: stats.raw_records - stats.removed_invalid, sub: '空值 / 无地区' },
    { label: '合并重复行', value: stats.valid_candidates, sub: '同来源同地区' },
    { label: '收敛到每人一条', value: stats.people_kept, sub: '按优先级替换' }
  ];
  const max = stages[0].value || 1;
  el('funnel-chart').innerHTML = stages.map((stage) => {
    const pct = Math.max(1.2, (stage.value / max) * 100);
    const sub = stage.sub ? ` <small>· ${escapeHtml(stage.sub)}</small>` : '';
    return '<div class="funnel-row">' +
      `<span class="funnel-label">${stage.label}${sub}</span>` +
      `<span class="funnel-track"><span class="funnel-bar" style="width:${pct}%"></span></span>` +
      `<span class="funnel-value">${fmtNumber(stage.value)}</span>` +
      '</div>';
  }).join('') +
    '<div class="axis-row"><span></span><span class="axis-ticks">' +
    `<span>0</span><span>${fmtNumber(Math.round(max / 2))}</span><span>${fmtNumber(max)}</span>` +
    '</span><span></span></div>' +
    '<p class="table-caption">漏斗按“记录条”递减到收敛阶段；' +
    `最终保留 ${fmtNumber(stats.people_kept)} 人，另有 ${fmtNumber(stats.people_excluded)} ` +
    '人因没有任何可保留记录被整体剔除。</p>';
}

// ---------- 真值 ----------
// 真值来自独立的只读接口，不由查询响应携带；启动时读取一次后复用缓存，
// 与预算、流水、查询历史完全分离。
async function loadTruth() {
  if (state.truth) {
    renderTruth(state.truth);
    return;
  }
  const placeholder = el('truth-note');
  placeholder.textContent = '读取中…';
  try {
    const payload = await api('/api/truth');
    state.truth = payload.truth;
    renderTruth(payload.truth);
  } catch (error) {
    placeholder.textContent = '真值对照读取失败：' + error.message;
  }
}

function renderTruth(truth) {
  el('truth-note').textContent =
    `${truth.table.length} 个地区 · 最大 ${fmtNumber(truth.summary.max_region)} 人`;
  el('truth-chart-caption').textContent =
    '横轴为人数；每个地区一根条，按人数排序。数值是每人保留一条记录后的真值，不含噪声。';

  const ranked = [...truth.table].sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
  const max = Math.max(1, ...ranked.map((row) => row.count));
  const barRows = ranked.map((row) => {
    const pct = Math.max(1.5, (row.count / max) * 100);
    return `<div class="bar-row" tabindex="0" role="img" ` +
      `aria-label="${escapeHtml(row.name)}：${row.count} 人" ` +
      `data-tip="${escapeHtml(row.name)}|${row.count}|${escapeHtml(row.group)}">` +
      `<span class="bar-label">${escapeHtml(row.name)}</span>` +
      `<span class="bar-track"><span class="bar-fill" style="width:${pct}%"></span></span>` +
      `<span class="bar-value">${fmtNumber(row.count)}</span>` +
      '</div>';
  }).join('');
  el('truth-chart').innerHTML = barRows +
    '<div class="bar-axis"><span></span><span class="ticks">' +
    `<span>0</span><span>${fmtNumber(Math.round(max / 2))}</span><span>${fmtNumber(max)}</span>` +
    '</span><span></span></div>';

  const grid = el('truth-chart');
  grid.querySelectorAll('.bar-row').forEach((node) => {
    const [name, count, group] = node.dataset.tip.split('|');
    attachTooltip(node, () => `<strong>${escapeHtml(name)}</strong><br>` +
      `<span class="tt-sub">${escapeHtml(group)} · 保留后真值 ${fmtNumber(count)} 人</span>`);
  });

  const summary = truth.summary;
  el('truth-summary').innerHTML = [
    ['保留总人数', fmtNumber(summary.total) + ' 人'],
    ['地区最大值', fmtNumber(summary.max_region) + ' 人'],
    ['非零最小值', fmtNumber(summary.min_nonzero_region) + ' 人'],
    ['大区数', fmtNumber(summary.groups.length)]
  ].map(([k, v]) => `<span>${k} <b>${v}</b></span>`).join('') +
    summary.groups.map((group) =>
      `<span>${escapeHtml(group.group)} <b>${fmtNumber(group.count)} 人</b></span>`
    ).join('');

  el('truth-tbody').innerHTML = truth.table.map((row) => (
    '<tr>' +
    `<td class="value-true">${escapeHtml(row.code)}</td>` +
    `<td class="lead">${escapeHtml(row.name)}</td>` +
    `<td>${escapeHtml(row.group)}</td>` +
    `<td class="num">${fmtNumber(row.count)}</td>` +
    '</tr>'
  )).join('');
}

// ---------- 机制与边界 ----------
function renderAbout(data) {
  const contract = data.contract;
  el('about-contract-version').textContent = contract.contract_version;
  el('about-claim').textContent = contract.claim;

  const items = [
    ['机制', '拉普拉斯机制 · 单地区计数'],
    ['敏感度', `Δ = ${fmtNumber(contract.sensitivity, 0)}（每人至多一条保留记录）`],
    ['噪声尺度', contract.noise_scale],
    ['组合方式', contract.composition],
    ['去重身份', contract.deduplication],
    ['预算记账', contract.budget_accounting],
    ['持久化', contract.persistence],
    ['展示变换', contract.display_transform]
  ];
  el('about-mech-grid').innerHTML = items.map(([k, v]) =>
    `<div class="mech-item"><div class="mech-k">${escapeHtml(k)}</div>` +
    `<div class="mech-v">${escapeHtml(v)}</div></div>`
  ).join('');

  el('transform-mech').innerHTML = [
    ['原始带噪值 raw_noisy', '机制直接输出，保留完整（含负值），是审计与理解误差的参照。'],
    ['展示值 display_value', 'max(0, raw_noisy)。非负截断改变分布：负值质量折叠到 0，期望偏高约 ns/2。'],
    ['不混用', '展示值只用于界面；任何统计、再次计算或导出都以 raw_noisy 为准，且两者分开字段保存。'],
    ['重放', '重放返回同一条已保存记录，因此 raw 与 display 同时复用，不会重新抽样。']
  ].map(([k, v]) =>
    `<div class="mech-item"><div class="mech-k">${escapeHtml(k)}</div>` +
    `<div class="mech-v">${escapeHtml(v)}</div></div>`
  ).join('');

  const lockRows = data.locked && data.lock
    ? [
        ['sample_hash', data.lock.sample_hash],
        ['rule_hash', data.lock.rule_hash],
        ['contract_hash', data.lock.contract_hash],
        ['sample_id', data.lock.sample_id],
        ['rule_version', data.lock.rule_version],
        ['contract_version', data.lock.contract_version],
        ['sensitivity', String(data.lock.sensitivity)],
        ['locked_at', fmtTime(data.lock.locked_at)]
      ]
    : [
        ['状态', data.lock_error ? '锁定的版本与当前文件冲突' : '尚未锁定'],
        ['说明', data.lock_error
          ? data.lock_error.message
          : '确认锁定后会在此显示已写入的锁定记录']
      ];
  el('about-lock-rows').innerHTML = lockRows.map(([k, v]) =>
    `<div class="hash-row"><span class="k">${escapeHtml(k)}</span>` +
    `<span class="v">${escapeHtml(v)}</span></div>`
  ).join('');

  el('boundary-list').innerHTML = contract.boundaries.map(
    (item) => `<li>${escapeHtml(item)}</li>`
  ).join('');
}

// ---------- 预算 ----------
function renderBudget(budget, data) {
  const badge = el('budget-state-badge');
  badge.className = 'badge ' + (budget ? 'good' : 'warn');
  badge.innerHTML = budget
    ? '<span class="dot"></span>已设置'
    : '未设置';
  el('budget-version-note').textContent = budget ? `版本 ${budget.version}` : '等待管理员';

  el('budget-summary').innerHTML = budget
    ? [
        ['总预算', fmtEpsilon(budget.total_epsilon) + ' ε'],
        ['已用', fmtEpsilon(budget.spent_epsilon) + ' ε'],
        ['剩余', fmtEpsilon(budget.remaining_epsilon) + ' ε']
      ].map(([k, v]) => `<span>${k} <b>${v}</b></span>`).join('')
    : '<span>尚未设置总预算；任何查询都会被拒绝且不扣费。</span>';

  el('budget-used-label').textContent = budget
    ? `已用 ${fmtEpsilon(budget.spent_epsilon)} ε`
    : '已用 —';
  el('budget-total-label').textContent = budget
    ? `总额 ${fmtEpsilon(budget.total_epsilon)} ε`
    : '总额 —';

  el('total-epsilon').disabled = !!budget;
  el('save-total').disabled = !!budget;
  if (budget) {
    el('total-epsilon').value = fmtEpsilon(budget.total_epsilon);
    el('total-epsilon').placeholder = '已封存';
  }
}

function initBudgetForm() {
  el('save-total').addEventListener('click', async () => {
    hideNotice('budget-notice');
    const token = el('admin-token').value.trim();
    const total = Number(el('total-epsilon').value);
    if (!token) {
      showNotice('budget-notice', 'error', '请输入管理员令牌。');
      return;
    }
    if (!Number.isFinite(total) || total <= 0) {
      showNotice('budget-notice', 'error', '总预算必须是大于 0 的数字。');
      return;
    }
    const button = el('save-total');
    button.disabled = true;
    try {
      const payload = await api('/api/admin/budget', {
        method: 'POST',
        headers: { 'x-admin-token': token },
        body: JSON.stringify({ total_epsilon: total })
      });
      showNotice('budget-notice', 'ok', escapeHtml(payload.message));
      state.bootstrap.budget = payload.budget;
      state.bootstrap.budget_set = true;
      renderBudget(payload.budget, state.bootstrap);
      await loadHistory();
      updateCost();
    } catch (error) {
      showNotice('budget-notice', 'error', escapeHtml(error.message));
      button.disabled = !!state.bootstrap?.budget;
    } finally {
      if (!state.bootstrap?.budget) button.disabled = false;
    }
  });
}

// ---------- 历史与流水 ----------
async function loadHistory() {
  if (state.loadingHistory) return;
  state.loadingHistory = true;
  try {
    const payload = await api('/api/history');
    state.history = payload;
    state.bootstrap.budget = payload.budget;
    state.bootstrap.budget_set = !!payload.budget;
    renderBudgetKpis(payload.budget, payload.summary || historySummary(payload));
    renderBudget(payload.budget, state.bootstrap);
    renderLedger(payload.ledger);
    renderHistory(payload.queries);
    renderAttempts(payload.attempts);
    el('history-meta').textContent =
      `${payload.queries.length} 条查询记录 · ${payload.ledger.length} 条流水 · ` +
      `${payload.attempts.length} 条失败尝试`;
    updateCost();
  } catch (error) {
    console.error(error);
  } finally {
    state.loadingHistory = false;
  }
}

function historySummary(payload) {
  return {
    query_count: payload.queries.length,
    ledger_count: payload.ledger.length,
    failed_count: payload.attempts.length
  };
}

function renderLedger(entries) {
  const tbody = el('ledger-tbody');
  if (!entries.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty">还没有成功扣费记录。</td></tr>';
    return;
  }
  tbody.innerHTML = entries.map((entry, index) => {
    const names = entry.region_codes.map((code) => {
      const region = state.bootstrap.regions.find((item) => item.code === code);
      return region ? region.name : code;
    });
    return '<tr>' +
      `<td class="value-true">${entries.length - index}</td>` +
      `<td>${fmtTime(entry.created_at)}</td>` +
      `<td class="lead">${escapeHtml(names.join('、'))}</td>` +
      `<td class="num">${fmtEpsilon(entry.per_region_epsilon)}</td>` +
      `<td class="num">${fmtEpsilon(entry.delta_epsilon)}</td>` +
      `<td class="num">${fmtEpsilon(entry.spent_before_epsilon)}</td>` +
      `<td class="num">${fmtEpsilon(entry.spent_after_epsilon)}</td>` +
      `<td class="num">${entry.deduplicated}</td>` +
      '</tr>';
  }).join('');
}

function renderHistory(queries) {
  const tbody = el('history-tbody');
  if (!queries.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty">还没有保存的查询。</td></tr>';
    return;
  }
  tbody.innerHTML = queries.map((query) => {
    const names = query.region_codes.map((code) => {
      const region = state.bootstrap.regions.find((item) => item.code === code);
      return region ? region.name : code;
    });
    const isLast = query.fingerprint === state.lastQueryFingerprint;
    return '<tr>' +
      `<td class="value-true">${query.request_seq}</td>` +
      `<td>${fmtTime(query.created_at)}</td>` +
      `<td class="lead">${escapeHtml(names.join('、'))}` +
      (isLast ? ' <span class="badge blue">本次</span>' : '') + '</td>' +
      `<td class="num">${fmtEpsilon(query.epsilon)}</td>` +
      `<td class="num">${fmtEpsilon(query.total_cost)}</td>` +
      `<td class="num">${query.deduplicated}</td>` +
      `<td><span class="mono" title="${query.fingerprint}">${shortHash(query.fingerprint, 12, 8)}</span></td>` +
      '</tr>';
  }).join('');
}

function renderAttempts(attempts) {
  const budgetTbody = el('attempt-list');
  const tbody = el('attempts-tbody');
  if (!attempts.length) {
    budgetTbody.innerHTML = '<div class="empty">没有失败请求。</div>';
    tbody.innerHTML = '<tr><td colspan="6" class="empty">没有失败请求。</td></tr>';
    return;
  }
  const reasonLabels = {
    insufficient_budget: '预算不足',
    budget_missing: '未设置预算',
    invalid_request: '参数不合法'
  };
  budgetTbody.innerHTML = attempts.slice(0, 5).map((attempt) => {
    const reason = reasonLabels[attempt.reason] || attempt.reason;
    return `<div class="person-record" style="grid-template-columns:150px minmax(0,1fr);">` +
      `<span class="rec-source">${fmtTime(attempt.created_at)}</span>` +
      `<span class="rec-detail"><strong>${escapeHtml(reason)}</strong> · ` +
      `请求 ${fmtEpsilon(attempt.total_cost)} ε · ` +
      `${escapeHtml(attempt.detail?.message || '未扣费')}</span></div>`;
  }).join('');

  tbody.innerHTML = attempts.map((attempt) => {
    const reason = reasonLabels[attempt.reason] || attempt.reason;
    const detail = attempt.detail
      ? (attempt.reason === 'insufficient_budget'
          ? `所需 ${fmtEpsilon(attempt.detail.requested_total_epsilon)} ε，` +
            `剩余 ${fmtEpsilon(attempt.detail.remaining_epsilon)} ε`
          : (attempt.detail.message || '—'))
      : '—';
    return '<tr>' +
      `<td>${fmtTime(attempt.created_at)}</td>` +
      `<td class="lead">${escapeHtml(reason)}</td>` +
      `<td class="num">${attempt.region_count}</td>` +
      `<td class="num">${fmtEpsilon(attempt.epsilon)}</td>` +
      `<td class="num">${fmtEpsilon(attempt.total_cost)}</td>` +
      `<td>${escapeHtml(detail)}</td>` +
      '</tr>';
  }).join('');
}

// ---------- Tooltip ----------
const tooltip = {
  node: null,
  init() {
    this.node = el('tooltip');
  },
  show(event, html) {
    if (!this.node) return;
    this.node.innerHTML = html;
    this.node.classList.add('show');
    this.node.setAttribute('aria-hidden', 'false');
    this.position(event);
  },
  position(event) {
    if (!this.node) return;
    const pad = 14;
    let x = event.clientX + pad;
    let y = event.clientY + pad;
    const rect = this.node.getBoundingClientRect();
    if (x + rect.width > window.innerWidth - 8) x = event.clientX - rect.width - pad;
    if (y + rect.height > window.innerHeight - 8) y = event.clientY - rect.height - pad;
    this.node.style.left = Math.max(8, x) + 'px';
    this.node.style.top = Math.max(8, y) + 'px';
  },
  hide() {
    if (!this.node) return;
    this.node.classList.remove('show');
    this.node.setAttribute('aria-hidden', 'true');
  }
};

function attachTooltip(node, htmlFactory) {
  node.addEventListener('mousemove', (event) => tooltip.show(event, htmlFactory()));
  node.addEventListener('mouseleave', () => tooltip.hide());
  node.addEventListener('focus', () => {
    const rect = node.getBoundingClientRect();
    tooltip.show({ clientX: rect.left + rect.width / 2, clientY: rect.top }, htmlFactory());
  });
  node.addEventListener('blur', () => tooltip.hide());
}

// ---------- 启动 ----------
async function main() {
  initTheme();
  initTabs();
  initQueryForm();
  initLockForm();
  initBudgetForm();
  tooltip.init();

  try {
    const bootstrap = await api('/api/bootstrap');
    renderBootstrap(bootstrap);
    await Promise.all([loadHistory(), loadTruth()]);
  } catch (error) {
    console.error(error);
    document.querySelector('.wrap').insertAdjacentHTML('afterbegin',
      `<div class="notice error show">初始化失败：${escapeHtml(error.message)}</div>`);
  }
}

main();
