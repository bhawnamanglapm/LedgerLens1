/*
 * LedgerLens REST API (v1) — store statements, run them in the background, keep results and review decisions.
 * Every call except POST /api/v1/users needs   Authorization: Bearer <token>   and only sees that user's data.
 *
 *   POST /api/v1/users                    {name, invite?}            → 201 {user, token}   (token is shown once)
 *   GET  /api/v1/me                                                   → the current user
 *   POST /api/v1/statements?name=a.pdf    raw file body (≤ 25 MB)     → 201 statement (200 if the same file exists)
 *   GET  /api/v1/statements                                           → your statements
 *   POST /api/v1/jobs                     {statement_ids, llm?, review_mode?, password?, taxonomy_csv?} → 202 job
 *   POST /api/v1/analyze?name=a.pdf       raw file body               → upload + job in one call (202)
 *   GET  /api/v1/jobs                                                 → your jobs, newest first
 *   GET  /api/v1/jobs/:id                                             → status, stage, progress, score
 *   POST /api/v1/jobs/:id/password        {password}                  → re-queues a job waiting for a PDF password
 *   GET  /api/v1/jobs/:id/result[?version=n]                          → the full JSON output (latest version by default)
 *   GET  /api/v1/jobs/:id/review                                      → items waiting for review + allowed categories
 *   POST /api/v1/jobs/:id/review          {txn_id, category?, counterparty?, note?} → re-scores, saves a new result version
 *   GET  /api/v1/jobs/:id/decisions                                   → the audit trail of review decisions
 *   GET  /api/v1/queue                                                → queued / running / done counts, workers
 *
 * A PDF password is passed with the job (body field "password" or header X-Statement-Password) and kept in memory
 * only. SIGNUP = open (default) | invite (needs INVITE_CODE, or APP_PASSWORD when that is set) | off.
 * API_LLM = on | off: whether API jobs may use the model (default on, but off when APP_PASSWORD is set, because
 * these calls are not covered by the /api/llm visitor limits).
 */
const path = require('path');
const pipeline = require('../pipeline');

const MAX_UPLOAD = 25 * 1024 * 1024;
const TYPES = { '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.xls': 'application/vnd.ms-excel', '.xlsm': 'application/vnd.ms-excel.sheet.macroEnabled.12', '.csv': 'text/csv', '.txt': 'text/plain', '.md': 'text/plain' };

function createApi(store, queue, opts) {
  const o = opts || {};
  const signup = (process.env.SIGNUP || (process.env.APP_PASSWORD ? 'invite' : 'open')).toLowerCase();
  const invite = process.env.INVITE_CODE || process.env.APP_PASSWORD || '';
  const maxQueued = Number(process.env.MAX_QUEUED_PER_USER || 20);
  // model calls from API jobs bypass /api/llm's per-visitor limits, so on a password-protected (public) server they are opt-in
  const apiLlm = process.env.API_LLM ? /^(1|on|true|yes)$/i.test(process.env.API_LLM) : !process.env.APP_PASSWORD;

  const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(JSON.stringify(obj, null, 2)); };
  const fail = (res, code, error, extra) => json(res, code, { ok: false, error, ...(extra || {}) });
  const body = (req, limit) => new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(Object.assign(new Error('request body larger than ' + Math.round(limit / 1048576) + ' MB'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks))); req.on('error', reject);
  });
  const jsonBody = async (req) => { const b = await body(req, 1e6); if (!b.length) return {}; try { return JSON.parse(b.toString('utf8')); } catch (e) { throw Object.assign(new Error('body is not valid JSON'), { status: 400 }); } };
  const links = (id) => ({ self: '/api/v1/jobs/' + id, result: '/api/v1/jobs/' + id + '/result', review: '/api/v1/jobs/' + id + '/review', decisions: '/api/v1/jobs/' + id + '/decisions' });
  const jobView = (j) => ({
    id: j.id, status: j.status, stage: j.stage, progress: j.progress, error: j.error, error_code: j.error_code,
    statement_ids: j.statement_ids, options: { llm: !!j.options.llm, review_mode: j.options.review_mode || 'smart', custom_taxonomy: !!j.options.custom_rules },
    created_at: j.created_at, started_at: j.started_at, finished_at: j.finished_at, attempts: j.attempts,
    queue_position: j.status === 'queued' ? store.queuePosition(j.id) : null,
    summary: j.score !== null && j.score !== undefined ? { score: j.score, band: j.band, decision: j.decision, pending_review: j.pending_review, transactions: j.transactions, pages: j.pages } : null,
    links: links(j.id)
  });
  const statementView = (s) => ({ id: s.id, file_name: s.file_name, content_type: s.content_type, size: s.size, sha256: s.sha256, created_at: s.created_at });

  function saveUpload(user, name, ctype, buf) {
    const base = path.basename(String(name || '')).replace(/[^\w.\- ()]/g, '_').slice(0, 120);
    const ext = path.extname(base).toLowerCase();
    if (!base || !TYPES[ext]) throw Object.assign(new Error('file name with a supported extension is required (?name=statement.pdf): ' + Object.keys(TYPES).join(', ')), { status: 400 });
    if (!buf.length) throw Object.assign(new Error(base + ' is empty'), { status: 400 });
    return store.saveStatement(user.id, base, ctype && ctype !== 'application/octet-stream' ? ctype : TYPES[ext], buf);
  }
  function makeJob(user, statementIds, opt, password) {
    const counts = store.db.prepare("SELECT COUNT(*) n FROM jobs WHERE user_id = ? AND status IN ('queued','running')").get(user.id).n;
    if (counts >= maxQueued) throw Object.assign(new Error('you already have ' + counts + ' jobs waiting or running (limit ' + maxQueued + ')'), { status: 429 });
    const ids = (Array.isArray(statementIds) ? statementIds : [statementIds]).map(Number).filter((x) => x > 0);
    if (!ids.length) throw Object.assign(new Error('statement_ids is required'), { status: 400 });
    const missing = ids.filter((id) => !store.statement(user.id, id)); if (missing.length) throw Object.assign(new Error('unknown statement id(s): ' + missing.join(', ')), { status: 404 });
    if (opt.llm) {
      if (!apiLlm) throw Object.assign(new Error('llm: true is turned off for API jobs on this server (set API_LLM=on to allow it)'), { status: 403 });
      const i = require('../llm').info(); if (!i.llm) throw Object.assign(new Error('llm: true needs a model on the server (ANTHROPIC_API_KEY)'), { status: 400 });
    }
    const options = { llm: !!opt.llm, review_mode: opt.review_mode === 'all' ? 'all' : 'smart' };
    if (opt.taxonomy_csv) { try { options.custom_rules = new pipeline.Component({}).parseCsv(String(opt.taxonomy_csv)); } catch (e) { throw Object.assign(new Error('taxonomy_csv: ' + e.message), { status: 400 }); } }
    const job = store.createJob(user.id, ids, options); queue.setPassword(job.id, password); queue.kick();
    return job;
  }

  // review: rebuild overrides from the decision log, re-score from the snapshot, save a new result version
  function applyReview(user, job, d) {
    const snap = store.snapshot(job.id); const cur = store.result(job.id);
    if (!snap || !cur) throw Object.assign(new Error('this job has no result yet'), { status: 409 });
    const t = cur.output.transactions.find((x) => x.id === d.txn_id);
    if (!t) throw Object.assign(new Error('unknown txn_id ' + d.txn_id), { status: 404 });
    if (!d.category && !d.counterparty) throw Object.assign(new Error('send category and/or counterparty'), { status: 400 });
    if (d.category) {
      const tax = pipeline.taxonomy(snap.state.customRules);
      if (!tax.some((x) => x.code === d.category && x.l1 === t.level1)) throw Object.assign(new Error(d.category + ' is not a ' + t.level1 + ' category; allowed: ' + tax.filter((x) => x.l1 === t.level1).map((x) => x.code).join(', ')), { status: 400 });
    }
    const version = (cur.version || 0) + 1;
    const tx = store.db.transaction(() => {
      if (d.category) store.addDecision({ job_id: job.id, user_id: user.id, txn_id: t.id, field: 'category', old_value: t.level2, new_value: d.category, note: d.note, result_version: version });
      if (d.counterparty) store.addDecision({ job_id: job.id, user_id: user.id, txn_id: t.id, field: 'counterparty', old_value: t.counterparty, new_value: String(d.counterparty).trim().slice(0, 120), note: d.note, result_version: version });
      const overrides = {}, cpOverrides = {};
      store.decisions(job.id).forEach((x) => { (x.field === 'category' ? overrides : cpOverrides)[x.txn_id] = x.new_value; });
      const out = pipeline.rescore(snap, { overrides, cpOverrides });
      store.saveResult(job.id, out, 'review decision on ' + t.id);
      return out;
    });
    return { out: tx(), version };
  }
  const reviewItems = (out) => out.transactions.filter((t) => t.review.flagged).map((t) => ({ txn_id: t.id, date: t.date, account_number: t.account_number, narration: t.narration, debit: t.debit, credit: t.credit, level1: t.level1, category: t.level2, counterparty: t.counterparty, classification_confidence: t.classification_confidence, counterparty_confidence: t.counterparty_confidence, reasons: t.review.reasons, impact: t.review.impact }));

  async function handle(req, res, url, query) {
    try {
      const m = req.method;
      if (m === 'POST' && url === '/api/v1/users') {
        if (signup === 'off') return fail(res, 403, 'sign-up is disabled on this server');
        const b = await jsonBody(req); const name = String(b.name || '').trim().slice(0, 80);
        if (!name) return fail(res, 400, 'name is required');
        if (signup === 'invite' && b.invite !== invite) return fail(res, 403, 'a valid invite code is required');
        const u = store.createUser(name);
        return json(res, 201, { ok: true, user: { id: u.id, name: u.name }, token: u.token, note: 'Keep this token: it is shown only once. Send it as  Authorization: Bearer <token>' });
      }
      const auth = req.headers.authorization || ''; const user = auth.startsWith('Bearer ') ? store.userByToken(auth.slice(7).trim()) : null;
      if (!user) { res.setHeader('www-authenticate', 'Bearer'); return fail(res, 401, 'missing or invalid token (Authorization: Bearer <token>)'); }
      let mm;
      if (m === 'GET' && url === '/api/v1/me') return json(res, 200, { ok: true, user });
      if (m === 'GET' && url === '/api/v1/queue') return json(res, 200, { ok: true, workers: queue.workers, running_now: queue.running(), jobs: store.counts() });
      if (m === 'POST' && url === '/api/v1/statements') {
        const buf = await body(req, MAX_UPLOAD); const s = saveUpload(user, query.get('name') || req.headers['x-file-name'], req.headers['content-type'], buf);
        return json(res, s.duplicate ? 200 : 201, { ok: true, statement: statementView(s), duplicate: !!s.duplicate });
      }
      if (m === 'GET' && url === '/api/v1/statements') return json(res, 200, { ok: true, statements: store.statements(user.id) });
      if (m === 'POST' && url === '/api/v1/jobs') {
        const b = await jsonBody(req); const job = makeJob(user, b.statement_ids, b, b.password || req.headers['x-statement-password']);
        return json(res, 202, { ok: true, job: jobView(job) });
      }
      if (m === 'POST' && url === '/api/v1/analyze') {
        const buf = await body(req, MAX_UPLOAD); const s = saveUpload(user, query.get('name') || req.headers['x-file-name'], req.headers['content-type'], buf);
        const job = makeJob(user, [s.id], { llm: query.get('llm') === '1' || query.get('llm') === 'true', review_mode: query.get('review_mode') }, req.headers['x-statement-password']);
        return json(res, 202, { ok: true, statement: statementView(s), job: jobView(job) });
      }
      if (m === 'GET' && url === '/api/v1/jobs') return json(res, 200, { ok: true, jobs: store.jobs(user.id, Math.min(200, Number(query.get('limit') || 50))).map(jobView) });
      if ((mm = /^\/api\/v1\/jobs\/(\d+)(\/[a-z]+)?$/.exec(url))) {
        const job = store.job(user.id, Number(mm[1])); if (!job) return fail(res, 404, 'job not found');
        const sub = mm[2] || '';
        if (m === 'GET' && sub === '') return json(res, 200, { ok: true, job: jobView(job) });
        if (m === 'POST' && sub === '/password') {
          if (job.status !== 'needs_password') return fail(res, 409, 'job is ' + job.status + ', not waiting for a password');
          const b = await jsonBody(req); if (!b.password) return fail(res, 400, 'password is required');
          queue.setPassword(job.id, String(b.password)); store.requeue(job.id, 'Waiting in queue'); queue.kick();
          return json(res, 202, { ok: true, job: jobView(store.job(user.id, job.id)) });
        }
        if (m === 'GET' && sub === '/result') {
          const r = store.result(job.id, query.get('version') ? Number(query.get('version')) : null);
          if (!r) return fail(res, job.status === 'done' ? 404 : 409, job.status === 'done' ? 'version not found' : 'job is ' + job.status + ' — no result yet', { job: jobView(job) });
          return json(res, 200, { ok: true, job_id: job.id, version: r.version, created_at: r.created_at, reason: r.reason, versions: store.resultVersions(job.id), output: r.output });
        }
        if (m === 'GET' && sub === '/review') {
          const r = store.result(job.id); if (!r) return fail(res, 409, 'job is ' + job.status + ' — no result yet');
          const tax = pipeline.taxonomy(store.snapshot(job.id).state.customRules);
          return json(res, 200, { ok: true, job_id: job.id, result_version: r.version, provisional: r.output.credit_risk_summary.provisional, items: reviewItems(r.output), categories: { CREDIT: tax.filter((x) => x.l1 === 'CREDIT').map((x) => x.code), DEBIT: tax.filter((x) => x.l1 === 'DEBIT').map((x) => x.code) } });
        }
        if (m === 'POST' && sub === '/review') {
          const b = await jsonBody(req); const { out, version } = applyReview(user, job, b);
          const R = out.credit_risk_summary; const t = out.transactions.find((x) => x.id === b.txn_id);
          return json(res, 200, { ok: true, job_id: job.id, result_version: version, transaction: { txn_id: t.id, category: t.level2, counterparty: t.counterparty, method: t.method, flagged: t.review.flagged }, summary: { score: R.composite_score, band: R.rating_band, decision: R.decision, provisional: R.provisional, pending_review: R.pending_review_items }, remaining: reviewItems(out).length });
        }
        if (m === 'GET' && sub === '/decisions') return json(res, 200, { ok: true, job_id: job.id, decisions: store.decisions(job.id) });
      }
      return fail(res, 404, 'unknown endpoint ' + m + ' ' + url);
    } catch (e) {
      if (!res.headersSent) fail(res, e.status || 500, e.status ? e.message : 'internal error: ' + e.message);
      if (!e.status) console.error('[api] ' + (e.stack || e));
    }
  }
  return { handle };
}

module.exports = { createApi };
