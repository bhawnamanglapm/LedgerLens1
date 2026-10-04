/*
 * LedgerLens storage — SQLite (better-sqlite3) for users, statements, jobs, results and review decisions;
 * uploaded files are kept on disk next to the database.
 *
 *   DATA_DIR   where ledgerlens.db and uploads/ live (default app/data)
 *
 * Tables
 *   users             one row per API user; only a SHA-256 hash of the token is stored
 *   statements        an uploaded file (name, type, size, sha256, path on disk), owned by a user
 *   jobs              one analysis request over one or more statements; the queue reads this table
 *   results           the JSON output of a job, versioned: v1 from the pipeline, v2… after each review decision
 *   snapshots         what is needed to re-score a job without re-reading its files
 *   review_decisions  every reviewer decision (who, what, when) — the audit trail
 */
const fs = require('fs'); const path = require('path'); const crypto = require('crypto');
const Database = require('better-sqlite3');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS statements (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), file_name TEXT NOT NULL, content_type TEXT,
  size INTEGER NOT NULL, sha256 TEXT NOT NULL, path TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS statements_user ON statements(user_id, sha256);
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), status TEXT NOT NULL,
  statement_ids TEXT NOT NULL, options TEXT NOT NULL, stage TEXT, progress TEXT, error TEXT, error_code TEXT,
  attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT,
  score INTEGER, band TEXT, decision TEXT, pending_review INTEGER, transactions INTEGER, pages INTEGER);
CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status, created_at);
CREATE INDEX IF NOT EXISTS jobs_user ON jobs(user_id, created_at);
CREATE TABLE IF NOT EXISTS results (
  job_id INTEGER NOT NULL REFERENCES jobs(id), version INTEGER NOT NULL, output TEXT NOT NULL, created_at TEXT NOT NULL,
  reason TEXT, PRIMARY KEY (job_id, version));
CREATE TABLE IF NOT EXISTS snapshots (job_id INTEGER PRIMARY KEY REFERENCES jobs(id), data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS review_decisions (
  id INTEGER PRIMARY KEY, job_id INTEGER NOT NULL REFERENCES jobs(id), user_id INTEGER NOT NULL REFERENCES users(id),
  txn_id TEXT NOT NULL, field TEXT NOT NULL, old_value TEXT, new_value TEXT NOT NULL, note TEXT, created_at TEXT NOT NULL,
  result_version INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS decisions_job ON review_decisions(job_id, id);
`;

const now = () => new Date().toISOString();
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

function open(dataDir) {
  const dir = path.resolve(dataDir || process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
  fs.mkdirSync(path.join(dir, 'uploads'), { recursive: true });
  const db = new Database(path.join(dir, 'ledgerlens.db'));
  db.pragma('journal_mode = WAL'); db.pragma('foreign_keys = ON'); db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA);
  const q = (sql) => db.prepare(sql);
  const S = {
    dir, db, now,
    // ---- users ----
    createUser(name) {
      const token = 'll_' + crypto.randomBytes(24).toString('base64url');
      const r = q('INSERT INTO users (name, token_hash, created_at) VALUES (?, ?, ?)').run(name, sha256(token), now());
      return { id: Number(r.lastInsertRowid), name, token };
    },
    userByToken(token) { return token ? q('SELECT id, name, created_at FROM users WHERE token_hash = ?').get(sha256(token)) : null; },
    // ---- statements ----
    saveStatement(userId, fileName, contentType, buf) {
      const hash = sha256(buf);
      const dup = q('SELECT * FROM statements WHERE user_id = ? AND sha256 = ? AND file_name = ?').get(userId, hash, fileName);
      if (dup) return { ...dup, duplicate: true };
      const ud = path.join(dir, 'uploads', String(userId)); fs.mkdirSync(ud, { recursive: true });
      const r = q('INSERT INTO statements (user_id, file_name, content_type, size, sha256, path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(userId, fileName, contentType || '', buf.length, hash, '', now());
      const id = Number(r.lastInsertRowid); const p = path.join(ud, id + path.extname(fileName).toLowerCase());
      fs.writeFileSync(p, buf); q('UPDATE statements SET path = ? WHERE id = ?').run(p, id);
      return S.statement(userId, id);
    },
    statement(userId, id) { return q('SELECT * FROM statements WHERE id = ? AND user_id = ?').get(id, userId); },
    statements(userId) { return q('SELECT id, file_name, content_type, size, sha256, created_at FROM statements WHERE user_id = ? ORDER BY id DESC').all(userId); },
    // ---- jobs ----
    createJob(userId, statementIds, options) {
      const r = q("INSERT INTO jobs (user_id, status, statement_ids, options, stage, created_at) VALUES (?, 'queued', ?, ?, 'Waiting in queue', ?)").run(userId, JSON.stringify(statementIds), JSON.stringify(options || {}), now());
      return S.job(userId, Number(r.lastInsertRowid));
    },
    job(userId, id) { const j = q('SELECT * FROM jobs WHERE id = ? AND user_id = ?').get(id, userId); return j ? S.shapeJob(j) : null; },
    jobAny(id) { const j = q('SELECT * FROM jobs WHERE id = ?').get(id); return j ? S.shapeJob(j) : null; },
    jobs(userId, limit) { return q('SELECT * FROM jobs WHERE user_id = ? ORDER BY id DESC LIMIT ?').all(userId, limit || 50).map(S.shapeJob); },
    shapeJob(j) { return { ...j, statement_ids: JSON.parse(j.statement_ids), options: JSON.parse(j.options), progress: j.progress ? JSON.parse(j.progress) : null }; },
    queuePosition(id) { return q("SELECT COUNT(*) n FROM jobs WHERE status = 'queued' AND id < ?").get(id).n + 1; },
    // fair scheduling: oldest queued job of the user with the fewest running jobs
    nextJob() {
      return q(`SELECT j.* FROM jobs j WHERE j.status = 'queued'
        ORDER BY (SELECT COUNT(*) FROM jobs r WHERE r.user_id = j.user_id AND r.status = 'running'), j.id LIMIT 1`).get();
    },
    claimJob(id) { return q("UPDATE jobs SET status = 'running', started_at = ?, attempts = attempts + 1, stage = 'Starting', error = NULL, error_code = NULL WHERE id = ? AND status = 'queued'").run(now(), id).changes === 1; },
    setProgress(id, stage, progress) { q('UPDATE jobs SET stage = ?, progress = ? WHERE id = ?').run(stage, JSON.stringify(progress || null), id); },
    finishJob(id, status, fields) {
      const f = fields || {};
      q('UPDATE jobs SET status = ?, finished_at = ?, stage = ?, error = ?, error_code = ?, score = ?, band = ?, decision = ?, pending_review = ?, transactions = ?, pages = ? WHERE id = ?')
        .run(status, now(), f.stage || status, f.error || null, f.error_code || null, f.score ?? null, f.band || null, f.decision || null, f.pending_review ?? null, f.transactions ?? null, f.pages ?? null, id);
    },
    requeue(id, stage) { q("UPDATE jobs SET status = 'queued', stage = ?, started_at = NULL WHERE id = ?").run(stage || 'Waiting in queue', id); },
    // after a restart nothing is running any more: put interrupted jobs back in the queue
    recoverInterrupted() { return q("UPDATE jobs SET status = 'queued', stage = 'Requeued after a server restart', started_at = NULL WHERE status = 'running'").run().changes; },
    counts() {
      const rows = q('SELECT status, COUNT(*) n FROM jobs GROUP BY status').all(); const o = { queued: 0, running: 0, done: 0, failed: 0, needs_password: 0, stopped: 0 };
      rows.forEach((r) => { o[r.status] = r.n; }); return o;
    },
    // ---- results, snapshots, decisions ----
    saveResult(jobId, output, reason) {
      const v = (q('SELECT MAX(version) v FROM results WHERE job_id = ?').get(jobId).v || 0) + 1;
      q('INSERT INTO results (job_id, version, output, created_at, reason) VALUES (?, ?, ?, ?, ?)').run(jobId, v, JSON.stringify(output), now(), reason || null);
      const R = output.credit_risk_summary || {};
      q('UPDATE jobs SET score = ?, band = ?, decision = ?, pending_review = ?, transactions = ? WHERE id = ?').run(R.composite_score ?? null, R.rating_band || null, R.decision || null, R.pending_review_items ?? null, (output.transactions || []).length, jobId);
      return v;
    },
    result(jobId, version) {
      const r = version ? q('SELECT * FROM results WHERE job_id = ? AND version = ?').get(jobId, version) : q('SELECT * FROM results WHERE job_id = ? ORDER BY version DESC LIMIT 1').get(jobId);
      return r ? { version: r.version, created_at: r.created_at, reason: r.reason, output: JSON.parse(r.output) } : null;
    },
    resultVersions(jobId) { return q('SELECT version, created_at, reason FROM results WHERE job_id = ? ORDER BY version').all(jobId); },
    saveSnapshot(jobId, snap) { q('INSERT OR REPLACE INTO snapshots (job_id, data) VALUES (?, ?)').run(jobId, JSON.stringify(snap)); },
    snapshot(jobId) { const r = q('SELECT data FROM snapshots WHERE job_id = ?').get(jobId); return r ? JSON.parse(r.data) : null; },
    addDecision(d) {
      return Number(q('INSERT INTO review_decisions (job_id, user_id, txn_id, field, old_value, new_value, note, created_at, result_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(d.job_id, d.user_id, d.txn_id, d.field, d.old_value ?? null, d.new_value, d.note || null, now(), d.result_version).lastInsertRowid);
    },
    decisions(jobId) { return q('SELECT d.id, d.txn_id, d.field, d.old_value, d.new_value, d.note, d.created_at, d.result_version, u.name AS decided_by FROM review_decisions d JOIN users u ON u.id = d.user_id WHERE d.job_id = ? ORDER BY d.id').all(jobId); },
    close() { db.close(); }
  };
  return S;
}

module.exports = { open, sha256 };
