/*
 * API v1 tests: a real server (node server.js) with a temporary database, two background workers and no model.
 * Covers users and isolation, uploads, the queue (worker limit, fair scheduling, statuses), passwords, review
 * decisions and their audit trail, and survival across restarts (results kept, interrupted jobs re-run).
 */
const path = require('path'); const fs = require('fs'); const os = require('os'); const { spawn } = require('child_process');
const ROOT = path.join(__dirname, '..'); const TS = path.join(ROOT, '..', 'test-statements');

module.exports = async function apiTests(ok) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'll_api_')); const port = 18000 + (process.pid % 1000);
  const B = 'http://127.0.0.1:' + port; let srv = null;
  const start = async () => {
    srv = spawn(process.execPath, [path.join(ROOT, 'server.js')], { env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, WORKERS: '2', ANTHROPIC_API_KEY: '', LLM_PROVIDER: '', APP_PASSWORD: '', SIGNUP: 'open' }, stdio: 'ignore' });
    for (let i = 0; i < 100; i++) { try { if ((await fetch(B + '/api/health')).ok) return; } catch (e) {} await sleep(100); }
    throw new Error('server did not start');
  };
  const stop = () => new Promise((r) => { if (!srv || srv.exitCode !== null) return r(); srv.on('exit', r); srv.kill('SIGTERM'); });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const call = async (method, url, token, body, headers) => {
    const h = { ...(headers || {}) }; if (token) h.authorization = 'Bearer ' + token;
    let b = body; if (body && !Buffer.isBuffer(body)) { b = JSON.stringify(body); h['content-type'] = 'application/json'; }
    const r = await fetch(B + url, { method, headers: h, body: b }); let j = null; try { j = await r.json(); } catch (e) {}
    return { status: r.status, j };
  };
  const file = (f) => fs.readFileSync(fs.existsSync(path.join(TS, f)) ? path.join(TS, f) : path.join(TS, 'scenarios', f));
  const analyze = async (tok, f, headers) => (await call('POST', '/api/v1/analyze?name=' + encodeURIComponent(f), tok, file(f), headers)).j.job.id;
  const waitDone = async (tok, ids, watch) => {
    const end = Date.now() + 240000; let maxRunning = 0;
    for (;;) {
      if (watch) { const q = (await call('GET', '/api/v1/queue', tok)).j; maxRunning = Math.max(maxRunning, q.running_now, q.jobs.running); }
      const js = await Promise.all(ids.map(async (id) => (await call('GET', '/api/v1/jobs/' + id, tok)).j.job));
      if (js.every((j) => !['queued', 'running'].includes(j.status)) || Date.now() > end) return { jobs: js, maxRunning };
      await sleep(150);
    }
  };

  try {
    await start();
    // ---- users and access ----
    const ua = await call('POST', '/api/v1/users', null, { name: 'Analyst A' }); const ub = await call('POST', '/api/v1/users', null, { name: 'Analyst B' });
    const A = ua.j.token, Bt = ub.j.token;
    ok(ua.status === 201 && /^ll_/.test(A) && (await call('GET', '/api/v1/me', A)).j.user.name === 'Analyst A' && (await call('GET', '/api/v1/jobs')).status === 401 && (await call('GET', '/api/v1/jobs', 'll_wrong')).status === 401, 'API: sign-up returns a token; calls without a valid token get 401');

    // ---- uploads ----
    const up = await call('POST', '/api/v1/statements?name=02_multi_month_multi_account.pdf', A, file('02_multi_month_multi_account.pdf'));
    const dup = await call('POST', '/api/v1/statements?name=02_multi_month_multi_account.pdf', A, file('02_multi_month_multi_account.pdf'));
    const bad = await call('POST', '/api/v1/statements?name=notes.docx', A, Buffer.from('not a statement'));
    const empty = await call('POST', '/api/v1/statements?name=e.pdf', A, Buffer.alloc(0));
    ok(up.status === 201 && dup.status === 200 && dup.j.duplicate && dup.j.statement.id === up.j.statement.id && bad.status === 400 && empty.status === 400, 'API: upload stores the file once (same file again → same id), rejects unsupported types and empty files');

    // ---- queue: many jobs, two users, two workers, fair scheduling ----
    const j02 = (await call('POST', '/api/v1/jobs', A, { statement_ids: [up.j.statement.id] })).j.job.id;
    const aIds = [j02]; for (const f of ['07_clean_salaried_approve.pdf', '08_emi_bounce_conditions.pdf', '09_high_foir_decline.pdf']) aIds.push(await analyze(A, f));
    const bIds = []; for (const f of ['10_no_income_decline.pdf', '11_tampered_balance_refer.pdf']) bIds.push(await analyze(Bt, f));
    const wa = await waitDone(A, aIds, true); const wb = await waitDone(Bt, bIds);
    const want = { [aIds[0]]: [777, 'REFER'], [aIds[1]]: [970, 'APPROVE'], [aIds[2]]: [888, 'APPROVE WITH CONDITIONS'], [aIds[3]]: [853, 'DECLINE'], [bIds[0]]: [538, 'DECLINE'], [bIds[1]]: [910, 'REFER'] };
    const all = wa.jobs.concat(wb.jobs);
    ok(all.every((j) => j.status === 'done' && j.summary.score === want[j.id][0] && j.summary.decision === want[j.id][1]), 'API: 6 background jobs from 2 users all finish with the same scores as the CLI (777 REFER, 970, 888, 853, 538, 910)', JSON.stringify(all.map((j) => [j.id, j.status, j.summary && j.summary.score, j.error])));
    ok(wa.maxRunning <= 2 && wa.maxRunning >= 1, 'API: never more than WORKERS=2 jobs run at once (max seen ' + wa.maxRunning + ')');
    const firstB = wb.jobs[0].started_at; const lateA = wa.jobs.slice(2).map((j) => j.started_at);
    ok(lateA.some((t) => t > firstB), 'API: fair scheduling — user B\'s first job starts before all of user A\'s earlier-queued jobs');
    ok((await call('GET', '/api/v1/jobs/' + aIds[0], Bt)).status === 404 && (await call('GET', '/api/v1/jobs/' + aIds[0] + '/result', Bt)).status === 404 && (await call('GET', '/api/v1/jobs', Bt)).j.jobs.length === 2, 'API: users only see their own jobs (another user\'s job → 404)');

    // ---- other outcomes: validation stop, password ----
    const jj = await analyze(A, '12_jumbled_pages_error.pdf'); const pj = await analyze(A, '06_password_protected.pdf');
    let w = await waitDone(A, [jj, pj]);
    ok(w.jobs[0].status === 'stopped' && w.jobs[0].error_code === 'VALIDATION' && /Pages appear jumbled/.test(w.jobs[0].error), 'API: jumbled pages → job status "stopped" with the page-order error');
    const p1 = w.jobs[1].status; await call('POST', '/api/v1/jobs/' + pj + '/password', A, { password: 'wrong' }); w = await waitDone(A, [pj]); const p2 = w.jobs[0];
    await call('POST', '/api/v1/jobs/' + pj + '/password', A, { password: 'ledger2025' }); w = await waitDone(A, [pj]); const p3 = w.jobs[0];
    const pinf = await analyze(A, '06_password_protected.pdf', { 'x-statement-password': 'ledger2025' }); const p4 = (await waitDone(A, [pinf])).jobs[0];
    const dbText = fs.readdirSync(dataDir).filter((f) => f.startsWith('ledgerlens.db')).map((f) => fs.readFileSync(path.join(dataDir, f)).toString('latin1')).join('');
    ok(p1 === 'needs_password' && p2.status === 'needs_password' && p2.error_code === 'WRONG_PASSWORD' && p3.status === 'done' && p3.summary.score === 966 && p4.status === 'done' && dbText.indexOf('ledger2025') < 0, 'API: password-protected PDF waits as needs_password, wrong password is reported, the right one (later or up front) gives 966; the password is never written to the database');

    // ---- review decisions ----
    const rv = (await call('GET', '/api/v1/jobs/' + aIds[0] + '/review', A)).j; const it = rv.items.find((x) => /VIKRAM TRADERS\/Advance/.test(x.narration));
    const wrong = await call('POST', '/api/v1/jobs/' + aIds[0] + '/review', A, { txn_id: it.txn_id, category: 'GROCERY' });
    const good = await call('POST', '/api/v1/jobs/' + aIds[0] + '/review', A, { txn_id: it.txn_id, category: 'P2P', note: 'advance from a friend, repaid next day' });
    const misc = rv.items.find((x) => /MISC/.test(x.narration));
    const cpd = await call('POST', '/api/v1/jobs/' + aIds[0] + '/review', A, { txn_id: misc.txn_id, counterparty: 'Unknown transfer' });
    const res = (await call('GET', '/api/v1/jobs/' + aIds[0] + '/result', A)).j; const v1 = (await call('GET', '/api/v1/jobs/' + aIds[0] + '/result?version=1', A)).j;
    const dec = (await call('GET', '/api/v1/jobs/' + aIds[0] + '/decisions', A)).j.decisions;
    const tt = res.output.transactions.find((x) => x.id === it.txn_id);
    ok(rv.items.length === 6 && rv.categories.CREDIT.includes('P2P') && wrong.status === 400 && good.status === 200 && good.j.transaction.method === 'MANUAL' && good.j.summary.pending_review === 5 && cpd.j.summary.pending_review === 4, 'API: review — 6 items listed; a DEBIT-only category on a credit is rejected; each decision re-scores (pending 6 → 5 → 4) and marks the row MANUAL');
    ok(res.version === 3 && res.versions.length === 3 && v1.output.transactions.find((x) => x.id === it.txn_id).level2 === 'OTHER_CREDIT' && tt.level2 === 'P2P' && dec.length === 2 && dec[0].decided_by === 'Analyst A' && dec[0].old_value === 'OTHER_CREDIT' && dec[0].note && dec[1].field === 'counterparty', 'API: every decision is kept (who, old → new, note) and every result version stays readable (v1 original, v3 latest)');

    // ---- shared activity log (web app browsers + API jobs) ----
    const act = (method, qs, body) => call(method, '/api/activity' + (qs || ''), null, body);
    const ent = [1, 2, 3].map((n) => ({ seq: n, run: 1, ts: '10:00:0' + n, day: '2026-10-04', level: n === 2 ? 'WARN' : 'INFO', step: 'Extract', msg: 'event ' + n }));
    const ap1 = await act('POST', '', { client_id: 'browserAsha01', client_name: 'Asha (credit team)', entries: ent });
    const ap2 = await act('POST', '', { client_id: 'browserAsha01', entries: ent.concat([{ seq: 4, level: 'USER', step: 'Review', msg: 'event 4' }]) });
    const badc = await act('POST', '', { client_id: 'x', entries: ent });
    const g = (await act('GET', '?client=browserAsha01')).j; const gw = (await act('GET', '?client=browserAsha01&level=WARN')).j; const gall = (await act('GET', '')).j;
    const apiRows = gall.entries.filter((e) => e.client_id === 'api-user-1');
    ok(ap1.j.stored === 3 && ap2.j.stored === 1 && badc.status === 400 && g.total === 4 && gw.total === 1 && g.entries[0].msg === 'event 4' && gall.clients.find((c) => c.client_id === 'browserAsha01').name === 'Asha (credit team)', 'activity log: a browser\'s entries are saved on the server (re-sent entries stored once), filter by person and level, newest first, with the display name');
    ok(apiRows.some((e) => /Job #\d+ queued/.test(e.msg)) && apiRows.some((e) => /Job #\d+ done in .* 777\/1000/.test(e.msg)) && apiRows.some((e) => /Review/.test(e.step) && /OTHER_CREDIT → P2P/.test(e.msg)) && gall.clients.find((c) => c.client_id === 'api-user-1').name === 'Analyst A (API)', 'activity log: API jobs and review decisions are written to the same shared log under the API user\'s name');
    const del = await act('DELETE', '?client_id=browserAsha01');
    ok(del.j.deleted === 4 && (await act('GET', '?client=browserAsha01')).j.total === 0 && (await act('POST', '', { client_id: 'browserAsha01', entries: [{ seq: 5, level: 'INFO', step: 'Ingest', msg: 'after clear' }] })).j.stored === 1, 'activity log: "Clear my history" deletes only that browser\'s entries; new entries are saved again afterwards');

    // ---- restarts ----
    await stop(); await start();
    const after = (await call('GET', '/api/v1/jobs/' + aIds[0] + '/result', A)).j;
    ok(after && after.version === 3 && (await call('GET', '/api/v1/jobs', A)).j.jobs.length === 7 && (await call('GET', '/api/activity?client=browserAsha01')).j.total === 1, 'API: after a server restart, tokens, jobs, results, review versions and the shared activity log are all still there');
    const slow = await analyze(A, '03c_scanned_page1.jpg'); // OCR takes a few seconds
    for (let i = 0; i < 100; i++) { if ((await call('GET', '/api/v1/jobs/' + slow, A)).j.job.status === 'running') break; await sleep(50); }
    await stop(); await start();
    const rec = (await waitDone(A, [slow])).jobs[0];
    ok(rec.status === 'done' && rec.summary.score === 959 && rec.attempts === 2, 'API: a job interrupted by a restart goes back to the queue and finishes afterwards (959 · APPROVE)');
  } catch (e) {
    ok(false, 'API tests ran without errors', e.stack || String(e));
  } finally { await stop(); fs.rmSync(dataDir, { recursive: true, force: true }); }
};
