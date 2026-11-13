import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openInstance, confirmDatasetLock } from './app/instance.js';
import {
  prepareQueryRequest,
  submitRegionQuery,
  ledgerView,
  SecureRng
} from './app/service.js';
import { formatEpsilon, microToEpsilon } from './app/normalize.js';
import { StoreError } from './app/store.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const STATIC_DIR = join(ROOT, 'static');
const DB_PATH = process.env.PRIVACY_DB_PATH || join(ROOT, 'var', 'privacy.sqlite3');
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const ADMIN_TOKEN = process.env.PRIVACY_ADMIN_TOKEN || 'demo-admin-token';
const MAX_BODY_BYTES = 64 * 1024;

const { store, instance } = openInstance({ dbPath: DB_PATH });
const KNOWN_REGION_CODES = new Set(instance.dataset.regions.map((region) => region.code));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8'
};

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body)
  });
  res.end(body);
}

function fail(res, status, code, message, extra = {}) {
  json(res, status, { ok: false, code, message, ...extra });
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('请求体过大'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          reject(Object.assign(new Error('请求体必须是 JSON 对象'), { status: 400 }));
          return;
        }
        resolve(parsed);
      } catch {
        reject(Object.assign(new Error('请求体不是合法 JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function requireAdmin(req, res) {
  const token = req.headers['x-admin-token'];
  if (typeof token !== 'string' || token !== ADMIN_TOKEN) {
    fail(res, 401, 'admin_required', '需要管理员令牌才能修改预算设置');
    return false;
  }
  return true;
}

function lockView(lock) {
  if (!lock) return null;
  return {
    sample_hash: lock.sample_hash,
    rule_hash: lock.rule_hash,
    contract_hash: lock.contract_hash,
    sample_id: lock.sample_id,
    sample_size: lock.sample_size,
    rule_version: lock.rule_version,
    contract_version: lock.contract_version,
    sensitivity: lock.sensitivity,
    locked_at: lock.locked_at
  };
}

function bootstrapPayload() {
  const budget = store.getBudget();
  return {
    ok: true,
    sample: {
      sample_id: instance.sample.meta.sample_id,
      sample_name: instance.sample.meta.sample_name,
      sample_size: instance.sample.meta.sample_size,
      note: instance.sample.meta.note
    },
    locked: instance.locked,
    lock_error: instance.lockError
      ? {
          code: instance.lockError.code,
          message: instance.lockError.message,
          mismatched: instance.lockError.detail?.mismatched || null
        }
      : null,
    // 锁定前展示“将锁定什么”，锁定后展示实际锁定的记录；两者都只含哈希与版本。
    lock: lockView(instance.lock),
    pending_lock: lockView(instance.lockPayload),
    rule_steps: instance.sample.region_rule.steps,
    rule_priority: instance.sample.region_rule.priority,
    budget,
    budget_set: !!budget,
    // 只返回地区元数据，不返回任何人数字段：地区人数必须走扣费查询，
    // 否则页面/bootstrap 就成了不消耗预算的真值旁路。
    regions: instance.dataset.regions,
    contract: instance.contract,
    stats: instance.stats,
    preview: instance.preview,
    outcome_labels: instance.outcomeLabels
  };
}

async function serveStatic(req, res, pathname) {
  let filePath;
  if (pathname === '/' || pathname === '') {
    filePath = join(STATIC_DIR, 'index.html');
  } else if (pathname.startsWith('/api/')) {
    fail(res, 404, 'not_found', '接口不存在');
    return;
  } else {
    const relative = normalize(pathname).replace(/^(\.\.[/\\])+/, '');
    filePath = join(STATIC_DIR, relative);
  }
  if (!filePath.startsWith(STATIC_DIR)) {
    fail(res, 403, 'forbidden', '拒绝访问');
    return;
  }
  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error('not a file');
    const data = await readFile(filePath);
    res.writeHead(200, {
      'content-type': MIME[extname(filePath)] || 'application/octet-stream',
      'cache-control': 'no-cache',
      'content-length': data.length
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('未找到页面');
  }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
    const pathname = decodeURIComponent(url.pathname);

    if (req.method === 'GET' && pathname === '/api/bootstrap') {
      return json(res, 200, bootstrapPayload());
    }
    if (req.method === 'GET' && pathname === '/api/history') {
      return json(res, 200, {
        ok: true,
        budget: store.getBudget(),
        queries: store.listQueries(100),
        ledger: store.listLedger(100),
        attempts: store.listAttempts(100)
      });
    }
    if (req.method === 'GET' && pathname === '/api/ledger') {
      return json(res, 200, { ok: true, ...ledgerView(store) });
    }
    if (req.method === 'GET' && pathname === '/api/truth') {
      return json(res, 200, { ok: true, truth: instance.truth, stats: instance.stats });
    }
    if (req.method === 'POST' && pathname === '/api/admin/lock') {
      if (!requireAdmin(req, res)) return undefined;
      const body = await readBody(req);
      if (body.confirm !== true) {
        return fail(res, 400, 'confirm_required',
          '需要在请求中明确确认后才能锁定数据与贡献规则');
      }
      try {
        const result = confirmDatasetLock(store, instance, { by: 'admin' });
        return json(res, 200, {
          ok: true,
          already: result.already,
          lock: lockView(result.lock),
          message: result.already
            ? '数据与贡献规则已处于锁定状态，本次仅做校验'
            : '数据、贡献规则与查询契约已锁定；改名或替换数据不能重置预算'
        });
      } catch (storeError) {
        if (storeError instanceof StoreError) {
          return fail(res, 409, storeError.code, storeError.message, {
            mismatched: storeError.detail?.mismatched || null
          });
        }
        throw storeError;
      }
    }
    if (req.method === 'POST' && pathname === '/api/admin/budget') {
      if (!requireAdmin(req, res)) return undefined;
      const body = await readBody(req);
      const { epsilon: normalized, micro, error } = prepareTotal(body.total_epsilon);
      if (error) return fail(res, 400, 'invalid_total', error);
      try {
        const result = store.setTotalEpsilonMicro(micro);
        return json(res, 200, {
          ok: true,
          changed: result.changed,
          budget: result.budget,
          message: result.changed
            ? '总预算已设置；一旦产生成功查询，总量即封存'
            : '总预算与当前设置一致，未做修改'
        });
      } catch (storeError) {
        if (storeError instanceof StoreError) {
          return fail(res, 409, storeError.code, storeError.message);
        }
        throw storeError;
      }
    }
    if (req.method === 'POST' && pathname === '/api/query') {
      if (instance.lockError) {
        return fail(res, 409, instance.lockError.code, instance.lockError.message, {
          mismatched: instance.lockError.detail?.mismatched || null
        });
      }
      if (!instance.locked) {
        return fail(res, 409, 'not_locked',
          '数据与贡献规则尚未确认锁定；确认锁定后才能提交查询');
      }
      const body = await readBody(req);
      const request = prepareQueryRequest(body, { knownCodes: KNOWN_REGION_CODES });
      if (!request.ok) {
        // 失败请求只进 attempts 审计：不扣费、不写 queries/ledger。
        // 无效请求本身没有可用的规范化额度/费用，按 0 记录，避免误导为“花了 0.000001 ε”。
        store.recordAttempt({
          fingerprint: 'invalid|' + Date.now(),
          regionCodes: Array.isArray(body.regions) ? body.regions.map(String) : [],
          epsilonMicro: 0,
          regionCount: Array.isArray(body.regions) ? body.regions.length : 0,
          totalMicro: 0,
          reason: request.reason,
          detail: { message: request.message }
        });
        return fail(res, 400, request.reason, request.message);
      }

      const result = submitRegionQuery({
        store,
        dataset: instance.dataset,
        lock: instance.lock,
        request,
        rng: new SecureRng()
      });

      if (result.outcome === 'rejected') {
        const status = result.reason === 'insufficient_budget' ? 409 : 400;
        return fail(
          res, status, result.reason,
          result.reason === 'insufficient_budget'
            ? '剩余预算不足以支付本次查询，未扣费、未返回噪声结果'
            : (result.detail?.message || '预算尚未设置，未扣费'),
          { detail: result.detail, budget: result.budget, fingerprint: result.fingerprint }
        );
      }

      return json(res, 200, {
        ok: true,
        outcome: result.outcome,
        replayed: result.outcome === 'replayed',
        fingerprint: result.fingerprint,
        query: result.query,
        budget: result.budget,
        hints: {
          replay:
            result.outcome === 'replayed'
              ? '该规范化查询此前已成功执行；本次返回的是当时保存的噪声结果，未重新抽样、未再次扣费。'
              : null,
          epsilon_display: formatEpsilon(microToEpsilon(result.query.epsilon_micro)),
          total_cost_display: formatEpsilon(microToEpsilon(result.query.total_micro))
        }
      });
    }

    if (req.method === 'GET') return serveStatic(req, res, pathname);
    return fail(res, 405, 'method_not_allowed', '不支持的方法');
  } catch (error) {
    const status = error.status || 500;
    if (status >= 500) console.error('[server]', error);
    fail(res, status, status >= 500 ? 'internal_error' : 'bad_request',
      status >= 500 ? '服务端处理失败' : error.message);
  }
});

function prepareTotal(value) {
  if (value === null || value === undefined || String(value).trim() === '') {
    return { error: '总预算不能为空' };
  }
  const number = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(number)) return { error: '总预算必须是数字' };
  if (number <= 0) return { error: '总预算必须大于 0' };
  if (number > 1000) return { error: '总预算不能超过 1000 ε' };
  const micro = Math.round(number * 1_000_000);
  if (micro <= 0) return { error: '总预算小于最小精度（0.000001 ε）' };
  return { epsilon: micro / 1_000_000, micro, error: null };
}

server.listen(PORT, HOST, () => {
  console.log('地区人数隐私预算统计原型已启动');
  console.log(`  页面:   http://${HOST}:${PORT}/`);
  console.log(`  数据库: ${DB_PATH}`);
  console.log(`  锁定:   ${
    instance.lockError
      ? '冲突：当前文件与已锁定版本不一致，查询已停用'
      : instance.locked
        ? '已锁定'
        : '未锁定（需管理员在页面确认）'
  }` +
    (instance.lock
      ? `  sample=${instance.lock.sample_id} rule=${instance.lock.rule_version}`
      : ''));
  const budget = store.getBudget();
  console.log(`  预算:   ${budget ? formatEpsilon(budget.total_epsilon) + ' ε 总额，已用 ' +
    formatEpsilon(budget.spent_epsilon) + ' ε' : '未设置（需管理员设置后查询才可用）'}`);
  if (!process.env.PRIVACY_ADMIN_TOKEN) {
    console.log(`  管理员令牌: ${ADMIN_TOKEN}（演示默认值，可用 PRIVACY_ADMIN_TOKEN 覆盖）`);
  }
});

function shutdown(signal) {
  console.log(`[server] 收到 ${signal}，关闭数据库连接`);
  server.close(() => {
    store.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

export { server, store, instance };
