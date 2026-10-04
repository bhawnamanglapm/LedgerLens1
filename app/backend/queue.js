/*
 * Background job queue. Jobs live in the database (status queued → running → done / failed / stopped /
 * needs_password), so nothing is lost on a restart: interrupted jobs are put back in the queue.
 *
 *   WORKERS         jobs processed at the same time (default 2), each in its own child process (worker.js)
 *   JOB_TIMEOUT_MS  a job running longer than this is stopped and marked failed (default 15 minutes)
 *   JOB_ATTEMPTS    how many times a job is tried if its worker crashes (default 2)
 *
 * Scheduling is fair across users: the next job comes from the user with the fewest jobs running, oldest first.
 * Passwords for protected PDFs are held in memory only (never written to the database); after a restart such a
 * job waits as needs_password until the password is sent again.
 */
const { fork } = require('child_process'); const path = require('path');

function createQueue(store, opts) {
  const o = opts || {};
  const WORKERS = Math.max(1, Number(o.workers || process.env.WORKERS || 2));
  const TIMEOUT = Number(o.timeoutMs || process.env.JOB_TIMEOUT_MS || 15 * 60 * 1000);
  const ATTEMPTS = Math.max(1, Number(o.attempts || process.env.JOB_ATTEMPTS || 2));
  const passwords = new Map(); const running = new Map(); let stopped = false; let timer = null;
  const log = o.log || ((m) => console.log('[queue] ' + m));

  const recovered = store.recoverInterrupted(); if (recovered) log(recovered + ' interrupted job(s) put back in the queue');

  function tick() {
    if (stopped) return;
    while (running.size < WORKERS) {
      const j = store.nextJob(); if (!j) break;
      if (!store.claimJob(j.id)) continue;
      start(store.shapeJob(j));
    }
  }

  function start(job) {
    const files = job.statement_ids.map((id) => store.statement(job.user_id, id)).filter(Boolean).map((s) => ({ name: s.file_name, path: s.path }));
    if (!files.length) { store.finishJob(job.id, 'failed', { error: 'none of the statements of this job exist any more', error_code: 'NO_FILES' }); return; }
    const child = fork(path.join(__dirname, 'worker.js'), [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: process.env });
    let errTail = ''; child.stderr.on('data', (d) => { errTail = (errTail + d).slice(-2000); });
    const entry = { child, job, done: false, started: Date.now() };
    entry.timer = setTimeout(() => { if (!entry.done) { entry.done = true; child.kill('SIGKILL'); store.finishJob(job.id, 'failed', { error: 'stopped after ' + Math.round(TIMEOUT / 1000) + ' s (JOB_TIMEOUT_MS)', error_code: 'TIMEOUT' }); cleanup(job.id); } }, TIMEOUT);
    running.set(job.id, entry);
    log('job ' + job.id + ' started (user ' + job.user_id + ', ' + files.length + ' file(s), attempt ' + (job.attempts + 1) + ')');
    act(job, 'INFO', 'Job', 'Job #' + job.id + ' started: ' + files.map((f) => f.name).join(', ') + (job.attempts ? ' (attempt ' + (job.attempts + 1) + ')' : ''));
    child.on('message', (m) => {
      if (m.type === 'ready') child.send({ type: 'run', files, options: job.options, password: passwords.get(job.id) || null });
      else if (m.type === 'progress') store.setProgress(job.id, m.stage, { message: m.message, level: m.level, seconds: Math.round((Date.now() - entry.started) / 1000) });
      else if (m.type === 'done') { entry.done = true; finish(job, m.result, Date.now() - entry.started); }
    });
    child.on('exit', (code) => {
      if (!entry.done) { // crashed before reporting: retry or give up
        entry.done = true; const j = store.jobAny(job.id);
        if (j && j.attempts < ATTEMPTS) { store.requeue(job.id, 'Retrying after the worker stopped unexpectedly'); log('job ' + job.id + ' worker exited (' + code + '), retrying'); }
        else store.finishJob(job.id, 'failed', { error: 'worker stopped unexpectedly: ' + (errTail.trim().split('\n').pop() || 'exit code ' + code), error_code: 'WORKER_CRASH' });
      }
      cleanup(job.id);
    });
  }

  function act(job, level, step, msg) { try { store.logApi(job.user_id, level, step, msg, job.id); } catch (e) {} }

  function finish(job, r, ms) {
    if (r.ok) {
      const S0 = r.output.credit_risk_summary || {};
      act(job, 'INFO', 'Job', 'Job #' + job.id + ' done in ' + (ms / 1000).toFixed(1) + ' s: ' + r.output.transactions.length + ' txns · ' + S0.composite_score + '/1000 · ' + S0.rating_band + ' → ' + S0.decision + (S0.pending_review_items ? ' · ' + S0.pending_review_items + ' to review' : ''));
      store.saveSnapshot(job.id, r.snapshot); store.saveResult(job.id, r.output, 'pipeline');
      const R = r.output.credit_risk_summary || {};
      store.finishJob(job.id, 'done', { stage: 'Completed in ' + (ms / 1000).toFixed(1) + ' s', score: R.composite_score, band: R.rating_band, decision: R.decision, pending_review: R.pending_review_items, transactions: r.output.transactions.length, pages: r.output.run.pages });
      passwords.delete(job.id); log('job ' + job.id + ' done in ' + (ms / 1000).toFixed(1) + ' s · ' + R.composite_score + ' · ' + R.decision);
    } else if (r.code === 'NEED_PASSWORD' || r.code === 'WRONG_PASSWORD') {
      passwords.delete(job.id); act(job, 'WARN', 'Job', 'Job #' + job.id + ': ' + r.error);
      store.finishJob(job.id, 'needs_password', { error: r.error, error_code: r.code, stage: r.code === 'WRONG_PASSWORD' ? 'Wrong password — send the correct one' : 'Waiting for the PDF password' });
    } else if (r.code === 'STOPPED') {
      act(job, 'ERROR', 'Job', 'Job #' + job.id + ' stopped by validation: ' + r.error);
      store.finishJob(job.id, 'stopped', { error: r.error, error_code: 'VALIDATION', stage: 'Stopped by validation' });
    } else { act(job, 'ERROR', 'Job', 'Job #' + job.id + ' failed: ' + r.error); store.finishJob(job.id, 'failed', { error: r.error, error_code: r.code || 'ERROR' }); }
  }

  function cleanup(id) { const e = running.get(id); if (e) clearTimeout(e.timer); running.delete(id); setImmediate(tick); }

  return {
    workers: WORKERS,
    start() { stopped = false; timer = setInterval(tick, 500); tick(); return this; },
    kick() { setImmediate(tick); },
    setPassword(jobId, pw) { if (pw) passwords.set(jobId, pw); },
    running() { return running.size; },
    async stop() {
      stopped = true; clearInterval(timer);
      for (const [id, e] of running) { e.done = true; e.child.kill('SIGKILL'); store.requeue(id, 'Requeued after a server restart'); clearTimeout(e.timer); }
      running.clear();
    }
  };
}

module.exports = { createQueue };
