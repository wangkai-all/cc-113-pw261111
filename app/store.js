// 持久化状态机：SQLite（node:sqlite）单文件，重开程序后预算与查询历史保持一致。
//
// 关键设计：
// - 预算以整数 micro-ε（1e-6）记账，避免浮点累计误差让“刚好用完”的查询被误判。
// - 数据、贡献规则与查询契约确认后写入 dataset_lock；之后任何改名/替换都会被校验拒绝，
//   且锁定记录永远不能删除或覆盖，预算不会因数据集改名而重置。
// - 每次提交都走 BEGIN IMMEDIATE 事务；扣减只有一个入口，使用带条件的 UPDATE
//   (spent + ? <= total)。SQLite 写锁把并发提交串行化，因此剩余额度不会被扣成负数。
// - 同一 normalized 查询指纹在 queries 表唯一：命中成功行直接返回已保存的噪声结果，
//   不再抽样、不再扣费，deduplicated 计数递增。
// - 预算不足或校验失败只写 attempts 审计，不写 queries / ledger，也不扣费。
// - 执行中抛出异常 → 整个事务回滚，查询行、ledger、扣减一并撤销。
// - raw_noisy 与 display_value 作为结果的两个字段同时写入，分开保存、永不复用。

import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA_VERSION = 2;

function nowIso() {
  return new Date().toISOString();
}

export class StoreError extends Error {
  constructor(code, message, detail = null) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
    this.detail = detail;
  }
}

const microToEpsilon = (micro) => micro / 1_000_000;

export function createStore(dbPath) {
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 15000;');
  db.exec('PRAGMA synchronous = NORMAL;');

  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS dataset_lock (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      sample_hash TEXT NOT NULL,
      rule_hash TEXT NOT NULL,
      contract_hash TEXT NOT NULL,
      sample_id TEXT NOT NULL,
      sample_size INTEGER NOT NULL,
      rule_version TEXT NOT NULL,
      contract_version TEXT NOT NULL,
      sensitivity REAL NOT NULL,
      locked_at TEXT NOT NULL,
      locked_by TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS budget (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      total_micro INTEGER NOT NULL CHECK (total_micro > 0),
      spent_micro INTEGER NOT NULL DEFAULT 0 CHECK (spent_micro >= 0),
      updated_at TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1
    ) STRICT;

    CREATE TABLE IF NOT EXISTS queries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fingerprint TEXT NOT NULL UNIQUE,
      region_codes_json TEXT NOT NULL,
      epsilon_micro INTEGER NOT NULL CHECK (epsilon_micro > 0),
      region_count INTEGER NOT NULL,
      total_micro INTEGER NOT NULL,
      sensitivity REAL NOT NULL,
      results_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      deduplicated INTEGER NOT NULL DEFAULT 0,
      request_seq INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      query_id INTEGER NOT NULL UNIQUE REFERENCES queries(id),
      fingerprint TEXT NOT NULL,
      delta_micro INTEGER NOT NULL,
      spent_before_micro INTEGER NOT NULL,
      spent_after_micro INTEGER NOT NULL,
      total_micro INTEGER NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fingerprint TEXT NOT NULL,
      region_codes_json TEXT NOT NULL,
      epsilon_micro INTEGER NOT NULL,
      region_count INTEGER NOT NULL,
      total_micro INTEGER NOT NULL,
      reason TEXT NOT NULL,
      detail_json TEXT,
      created_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;

    CREATE INDEX IF NOT EXISTS idx_queries_created ON queries(created_at);
    CREATE INDEX IF NOT EXISTS idx_ledger_created ON ledger(created_at);
    CREATE INDEX IF NOT EXISTS idx_attempts_created ON attempts(created_at);
  `);

  const q = {
    getMeta: db.prepare('SELECT value FROM meta WHERE key = ?'),
    setMeta: db.prepare(`
      INSERT INTO meta (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `),
    lock: db.prepare('SELECT * FROM dataset_lock WHERE id = 1'),
    insertLock: db.prepare(`
      INSERT INTO dataset_lock
        (id, sample_hash, rule_hash, contract_hash, sample_id, sample_size,
         rule_version, contract_version, sensitivity, locked_at, locked_by)
      VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    budget: db.prepare('SELECT * FROM budget WHERE id = 1'),
    insertBudget: db.prepare(`
      INSERT INTO budget (id, total_micro, spent_micro, updated_at, version)
      VALUES (1, ?, 0, ?, 1)
    `),
    updateSpent: db.prepare(`
      UPDATE budget
         SET spent_micro = spent_micro + ?,
             updated_at = ?,
             version = version + 1
       WHERE id = 1
         AND spent_micro + ? <= total_micro
    `),
    queryByFingerprint: db.prepare('SELECT * FROM queries WHERE fingerprint = ?'),
    queryById: db.prepare('SELECT * FROM queries WHERE id = ?'),
    insertSucceeded: db.prepare(`
      INSERT INTO queries
        (fingerprint, region_codes_json, epsilon_micro, region_count, total_micro,
         sensitivity, results_json, created_at, deduplicated, request_seq)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
    `),
    markDedup: db.prepare('UPDATE queries SET deduplicated = deduplicated + 1 WHERE id = ?'),
    insertLedger: db.prepare(`
      INSERT INTO ledger (query_id, fingerprint, delta_micro, spent_before_micro,
                          spent_after_micro, total_micro, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `),
    insertAttempt: db.prepare(`
      INSERT INTO attempts (fingerprint, region_codes_json, epsilon_micro, region_count,
                            total_micro, reason, detail_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `),
    nextSeq: db.prepare('SELECT COALESCE(MAX(request_seq), 0) + 1 AS next FROM queries'),
    recentQueries: db.prepare('SELECT * FROM queries ORDER BY id DESC LIMIT ?'),
    recentLedger: db.prepare(`
      SELECT l.*, q.region_codes_json, q.region_count, q.epsilon_micro, q.deduplicated
        FROM ledger l JOIN queries q ON q.id = l.query_id
       ORDER BY l.id DESC LIMIT ?
    `),
    ledgerFor: db.prepare('SELECT * FROM ledger WHERE query_id = ?'),
    recentAttempts: db.prepare('SELECT * FROM attempts ORDER BY id DESC LIMIT ?'),
    configGet: db.prepare('SELECT * FROM config WHERE key = ?'),
    configSet: db.prepare(`
      INSERT INTO config (key, value_json, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json,
          updated_at = excluded.updated_at
    `),
    countQueries: db.prepare('SELECT COUNT(*) AS n FROM queries'),
    ledgerSum: db.prepare(
      'SELECT COALESCE(SUM(delta_micro), 0) AS s, COUNT(*) AS n FROM ledger'
    ),
    attemptsCount: db.prepare('SELECT COUNT(*) AS n FROM attempts')
  };

  if (!q.getMeta.get('schema_version')) {
    q.setMeta.run('schema_version', String(SCHEMA_VERSION));
    q.setMeta.run('instance_id', randomUUID());
  } else if (Number(q.getMeta.get('schema_version').value) > SCHEMA_VERSION) {
    throw new Error('数据库版本高于当前程序版本，拒绝打开');
  }

  function inTransaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {}
      throw error;
    }
  }

  function getBudget() {
    const row = q.budget.get();
    if (!row) return null;
    return {
      total_epsilon: microToEpsilon(row.total_micro),
      spent_epsilon: microToEpsilon(row.spent_micro),
      remaining_epsilon: microToEpsilon(row.total_micro - row.spent_micro),
      total_micro: row.total_micro,
      spent_micro: row.spent_micro,
      remaining_micro: row.total_micro - row.spent_micro,
      updated_at: row.updated_at,
      version: row.version
    };
  }

  function setTotalEpsilonMicro(totalMicro, { by = 'admin' } = {}) {
    if (!Number.isSafeInteger(totalMicro) || totalMicro <= 0) {
      throw new StoreError('invalid_total', '总预算必须是大于 0 的 micro-ε 整数');
    }
    return inTransaction(() => {
      const existing = q.budget.get();
      if (existing) {
        if (existing.total_micro === totalMicro) {
          return { changed: false, budget: getBudget() };
        }
        throw new StoreError(
          'budget_sealed',
          existing.spent_micro > 0
            ? '已有成功查询扣费，总预算不能再修改'
            : '总预算已设置过；本原型的预算身份不可重置'
        );
      }
      q.insertBudget.run(totalMicro, nowIso());
      q.configSet.run('budget_set_by', JSON.stringify(by), nowIso());
      return { changed: true, budget: getBudget() };
    });
  }

  function lockDataset(payload, lockedBy = 'admin') {
    const fields = [
      'sample_hash', 'rule_hash', 'contract_hash', 'sample_id',
      'sample_size', 'rule_version', 'contract_version', 'sensitivity'
    ];
    for (const field of fields) {
      if (payload[field] === undefined || payload[field] === null) {
        throw new StoreError('lock_incomplete', '锁定信息缺少字段: ' + field);
      }
    }
    return inTransaction(() => {
      const existing = q.lock.get();
      if (existing) {
        const mismatched = fields.filter((field) => existing[field] !== payload[field]);
        if (mismatched.length > 0) {
          throw new StoreError(
            'dataset_changed',
            '当前样本、贡献规则或查询契约与已锁定版本不一致；改名、复制或替换数据都不能重置预算。',
            { mismatched }
          );
        }
        return { already: true, lock: existing };
      }
      q.insertLock.run(
        payload.sample_hash, payload.rule_hash, payload.contract_hash,
        payload.sample_id, payload.sample_size, payload.rule_version,
        payload.contract_version, payload.sensitivity, nowIso(), lockedBy
      );
      return { already: false, lock: q.lock.get() };
    });
  }

  function getLock() {
    return q.lock.get() || null;
  }

  function hydrateQuery(row) {
    if (!row) return null;
    return {
      id: row.id,
      fingerprint: row.fingerprint,
      region_codes: JSON.parse(row.region_codes_json),
      epsilon: microToEpsilon(row.epsilon_micro),
      epsilon_micro: row.epsilon_micro,
      region_count: row.region_count,
      total_cost: microToEpsilon(row.total_micro),
      total_micro: row.total_micro,
      sensitivity: row.sensitivity,
      results: JSON.parse(row.results_json),
      created_at: row.created_at,
      deduplicated: row.deduplicated,
      request_seq: row.request_seq
    };
  }

  function hydrateAttempt(row) {
    return {
      id: row.id,
      fingerprint: row.fingerprint,
      region_codes: JSON.parse(row.region_codes_json),
      epsilon: microToEpsilon(row.epsilon_micro),
      epsilon_micro: row.epsilon_micro,
      region_count: row.region_count,
      total_cost: microToEpsilon(row.total_micro),
      total_micro: row.total_micro,
      reason: row.reason,
      detail: row.detail_json ? JSON.parse(row.detail_json) : null,
      created_at: row.created_at
    };
  }

  function recordAttempt({ fingerprint, regionCodes, epsilonMicro, regionCount, totalMicro, reason, detail }) {
    q.insertAttempt.run(
      fingerprint, JSON.stringify(regionCodes), epsilonMicro, regionCount, totalMicro,
      reason, detail ? JSON.stringify(detail) : null, nowIso()
    );
  }

  // 提交一次规范化查询。executeQuery(queryKey) 只在需要真正执行时调用，
  // 且调用时扣减已发生、但尚未提交：若执行抛错，事务回滚，扣减不会留下。
  // 返回 outcome: 'executed' | 'replayed' | 'rejected'。
  function submitQuery({
    fingerprint,
    queryKey,
    regionCodes,
    epsilonMicro,
    regionCount,
    totalMicro,
    sensitivity,
    executeQuery
  }) {
    if (!Number.isSafeInteger(epsilonMicro) || epsilonMicro <= 0) {
      throw new StoreError('invalid_epsilon', '额度必须是大于 0 的 micro-ε 整数');
    }
    if (!Number.isSafeInteger(totalMicro) || totalMicro <= 0) {
      throw new StoreError('invalid_cost', '查询总费用必须是大于 0 的 micro-ε 整数');
    }
    return inTransaction(() => {
      const prior = q.queryByFingerprint.get(fingerprint);
      if (prior) {
        q.markDedup.run(prior.id);
        return {
          outcome: 'replayed',
          query: hydrateQuery(q.queryById.get(prior.id)),
          budget: getBudget()
        };
      }

      const budget = q.budget.get();
      if (!budget) {
        const detail = { message: '管理员尚未设置总预算' };
        recordAttempt({
          fingerprint, regionCodes, epsilonMicro, regionCount, totalMicro,
          reason: 'budget_missing', detail
        });
        return { outcome: 'rejected', reason: 'budget_missing', detail, budget: null };
      }

      const spentBefore = budget.spent_micro;
      const updated = q.updateSpent.run(totalMicro, nowIso(), totalMicro);
      if (updated.changes !== 1) {
        const detail = {
          requested_total_epsilon: microToEpsilon(totalMicro),
          per_region_epsilon: microToEpsilon(epsilonMicro),
          region_count: regionCount,
          spent_before_epsilon: microToEpsilon(spentBefore),
          total_epsilon: microToEpsilon(budget.total_micro),
          remaining_epsilon: microToEpsilon(budget.total_micro - spentBefore)
        };
        recordAttempt({
          fingerprint, regionCodes, epsilonMicro, regionCount, totalMicro,
          reason: 'insufficient_budget', detail
        });
        return {
          outcome: 'rejected',
          reason: 'insufficient_budget',
          detail,
          budget: getBudget()
        };
      }

      // 扣减已发生。以下任何异常都会让事务回滚，扣减不会留下。
      const results = executeQuery(queryKey);
      const spentAfter = q.budget.get().spent_micro;
      const seq = q.nextSeq.get().next;
      const inserted = q.insertSucceeded.run(
        fingerprint, JSON.stringify(regionCodes), epsilonMicro, regionCount,
        totalMicro, sensitivity, JSON.stringify(results), nowIso(), seq
      );
      const queryId = Number(inserted.lastInsertRowid);
      q.insertLedger.run(
        queryId, fingerprint, totalMicro, spentBefore, spentAfter,
        budget.total_micro, nowIso()
      );
      return {
        outcome: 'executed',
        query: hydrateQuery(q.queryById.get(queryId)),
        budget: getBudget()
      };
    });
  }

  function listQueries(limit = 50) {
    return q.recentQueries.all(limit).map(hydrateQuery);
  }

  function listLedger(limit = 50) {
    return q.recentLedger.all(limit).map((row) => ({
      id: row.id,
      query_id: row.query_id,
      fingerprint: row.fingerprint,
      delta_epsilon: microToEpsilon(row.delta_micro),
      delta_micro: row.delta_micro,
      spent_before_epsilon: microToEpsilon(row.spent_before_micro),
      spent_after_epsilon: microToEpsilon(row.spent_after_micro),
      total_epsilon: microToEpsilon(row.total_micro),
      created_at: row.created_at,
      region_codes: JSON.parse(row.region_codes_json),
      region_count: row.region_count,
      per_region_epsilon: microToEpsilon(row.epsilon_micro),
      deduplicated: row.deduplicated
    }));
  }

  function queryDetail(id) {
    const query = hydrateQuery(q.queryById.get(id));
    if (!query) return null;
    const ledger = q.ledgerFor.get(id);
    return {
      query,
      ledger: ledger
        ? {
            ...ledger,
            delta_epsilon: microToEpsilon(ledger.delta_micro),
            spent_before_epsilon: microToEpsilon(ledger.spent_before_micro),
            spent_after_epsilon: microToEpsilon(ledger.spent_after_micro),
            total_epsilon: microToEpsilon(ledger.total_micro)
          }
        : null
    };
  }

  function listAttempts(limit = 50) {
    return q.recentAttempts.all(limit).map(hydrateAttempt);
  }

  function summary() {
    const ledger = q.ledgerSum.get();
    return {
      budget: getBudget(),
      ledger_count: ledger.n,
      ledger_epsilon: microToEpsilon(ledger.s),
      failed_count: q.attemptsCount.get().n,
      query_count: q.countQueries.get().n,
      instance_id: q.getMeta.get('instance_id')?.value || null,
      schema_version: Number(q.getMeta.get('schema_version')?.value || 0)
    };
  }

  function getConfig(key, fallback = null) {
    const row = q.configGet.get(key);
    return row ? JSON.parse(row.value_json) : fallback;
  }

  function setConfig(key, value) {
    q.configSet.run(key, JSON.stringify(value), nowIso());
    return value;
  }

  function close() {
    db.close();
  }

  return {
    db,
    getBudget,
    getLock,
    setTotalEpsilonMicro,
    lockDataset,
    submitQuery,
    recordAttempt,
    listQueries,
    listLedger,
    queryDetail,
    listAttempts,
    summary,
    getConfig,
    setConfig,
    close
  };
}
