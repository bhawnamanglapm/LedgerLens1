#!/usr/bin/env node
/*
 * LedgerLens automated tests —  npm test
 *
 *  1. Unit tests for the LLM guardrails (format check, balance check, account match, category allow-list)
 *  2. Every test statement, rules only        → must match the expected score / decision / row count
 *  3. Every test statement, mock LLM          → model rows must pass validation, agree with the rule parser, same score
 *  4. Every test statement, deliberately bad LLM → every batch must be rejected and fall back to rules, same score
 *  5. Jumbled pages                           → pipeline must stop with an error
 *
 * The "mock" LLM is a test double, not a model: it answers in the exact tool format so the plumbing and guardrails
 * can be tested offline and for free. A real run needs ANTHROPIC_API_KEY (see README).
 */
const path = require('path'); const fs = require('fs'); const os = require('os'); const { execFileSync } = require('child_process');
const loadEngine = require('../engine-node'); const llm = require('../llm');
const ROOT = path.join(__dirname, '..'); const TS = path.join(ROOT, '..', 'test-statements');
let pass = 0, fail = 0; const failures = [];
const ok = (cond, name, extra) => { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; failures.push(name); console.log('  ✗ ' + name + (extra ? ' — ' + extra : '')); } };

const EXPECTED = {
  '01_single_month_digital.pdf': { n: 32, score: 966, decision: 'APPROVE' },
  '02_multi_month_multi_account.pdf': { n: 120, score: 777, decision: 'REFER' },
  '03a_scanned_page1.png': { n: 18, score: 959, decision: 'APPROVE', ocr: true },
  '04_csv_export_jan2025.csv': { n: 32, score: 966, decision: 'APPROVE' }
};

function runCli(file, env, extra) {
  const out = path.join(os.tmpdir(), 'll_test_' + process.pid + '_' + Math.random().toString(36).slice(2) + '.json');
  try { execFileSync(process.execPath, [path.join(ROOT, 'cli.js'), path.join(TS, file), '-o', out].concat(extra || []), { env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'ignore'], timeout: 240000 }); }
  catch (e) { return { exit: e.status }; }
  const j = JSON.parse(fs.readFileSync(out, 'utf8')); fs.unlinkSync(out); return j;
}

(async () => {
  console.log('\n1 · LLM guardrails (unit)');
  const C = loadEngine(); const c = new C({});
  const pages = c.genSample('clean').slice(0, 3); const ex = c.extract(pages);
  const acc = ex.accounts[0]; const prev = {}; ex.accounts.forEach((a) => { prev[a.key] = a.opening; });
  const good = ex.raw.filter((r) => r.batch === 1).map((r) => ({ page: r.page, date: r.date, value_date: r.vdate, narration: r.narr, debit: r.dr || null, credit: r.cr || null, balance: r.bal, account_number: acc.key }));
  let r = c.llmCheckBatch({ accounts: [], transactions: good }, pages, ex, prev, null);
  ok(r.errors.length === 0 && r.rows.length === good.length, 'correct answer is accepted (' + good.length + ' rows)', r.errors[0]);
  r = c.llmCheckBatch({ transactions: good.map((t, i) => (i === 3 ? { ...t, balance: t.balance + 500 } : t)) }, pages, ex, prev, null);
  ok(r.errors.some((e) => /balance/.test(e)), 'invented / misread amount is caught by the balance check');
  r = c.llmCheckBatch({ transactions: good.map((t, i) => (i === 0 ? { ...t, credit: 10, debit: 10 } : t)) }, pages, ex, prev, null);
  ok(r.errors.some((e) => /exactly one of debit or credit/.test(e)), 'row with both debit and credit is rejected');
  r = c.llmCheckBatch({ transactions: good.map((t, i) => (i === 0 ? { ...t, date: '31/02/2025x' } : t)) }, pages, ex, prev, null);
  ok(r.errors.some((e) => /date/.test(e)), 'bad date format is rejected');
  r = c.llmCheckBatch({ transactions: good.map((t, i) => (i === 0 ? { ...t, account_number: '99998888' } : t)) }, pages, ex, prev, null);
  ok(r.errors.some((e) => /does not match any account/.test(e)), 'unknown account number is rejected');
  r = c.llmCheckBatch({ transactions: good.map((t) => ({ ...t, account_number: null })) }, pages, ex, prev, null);
  ok(r.errors.length === 0 && r.rows.every((x) => x.account === acc.key), 'missing account number is inherited from the page header');
  r = c.llmCheckBatch({ transactions: good.map((t, i) => (i === 0 ? { ...t, page: 99 } : t)) }, pages, ex, prev, null);
  ok(r.errors.some((e) => /not in this batch/.test(e)), 'row from a page outside the batch is rejected');
  r = c.llmCheckBatch({ foo: 1 }, pages, ex, prev, null);
  ok(r.errors.length === 1, 'malformed response is rejected');
  // classification allow-list
  const c2 = new C({}); c2._llmStats = { calls: 0, clsCalls: 0, fallbacks: 0, clsDone: 0, inTok: 0, outTok: 0, ms: 0 };
  c2.callLLM = async (req) => ({ ok: true, input: { items: [{ id: 'c0', category: 'SALARY', confidence: 0.99, reason: 'x' }, { id: 'c1', category: 'SHOPPING', confidence: 0.99, reason: 'y' }] }, usage: {} });
  const T = [{ method: 'LLM', l1: 'DEBIT', narr: 'POS SOMETHING', amount: 10, cp: 'X', channel: 'CARD' }, { method: 'LLM', l1: 'DEBIT', narr: 'UPI OTHER', amount: 5, cp: 'Y', channel: 'UPI' }];
  const map = await c2.llmClassify(T);
  const vals = Object.values(map);
  ok(vals.length === 1 && vals[0].l2 === 'SHOPPING', 'category outside the allowed list for the direction is rejected (SALARY on a debit)');
  ok(vals[0] && vals[0].conf <= 0.92, 'model confidence is capped below rule confidence');

  for (const [mode, env, extra] of [['2 · rules only', { LLM_PROVIDER: '' , ANTHROPIC_API_KEY: '' }, []], ['3 · mock LLM', { LLM_PROVIDER: 'mock' }, ['--llm']], ['4 · deliberately wrong LLM', { LLM_PROVIDER: 'mock-bad' }, ['--llm']]]) {
    console.log('\n' + mode);
    for (const [file, exp] of Object.entries(EXPECTED)) {
      const j = runCli(file, env, extra);
      if (j.exit !== undefined) { ok(false, file + ' runs', 'exit code ' + j.exit); continue; }
      const R = j.credit_risk_summary; const ai = j.run.ai;
      ok(j.transactions.length === exp.n && R.composite_score === exp.score && R.decision === exp.decision, file + ' → ' + j.transactions.length + ' txns · ' + R.composite_score + ' · ' + R.decision, 'expected ' + exp.n + ' · ' + exp.score + ' · ' + exp.decision);
      if (mode.startsWith('2')) ok(ai.mode === 'rules', file + ' reports rules mode');
      if (mode.startsWith('3')) ok(ai.mode === 'llm' && ai.fallbacks_to_rules === 0 && ai.rows_from_model === exp.n && ai.rows_matching_rule_parser === exp.n && j.transactions.every((t) => t.extracted_by === 'LLM'), file + ' · all ' + ai.rows_from_model + ' rows from the model, 0 fallbacks, ' + ai.rows_matching_rule_parser + ' agree with rules', JSON.stringify(ai));
      if (mode.startsWith('4')) ok(ai.fallbacks_to_rules >= j.run.batches.length && ai.rows_from_model === 0 && j.transactions.every((t) => t.extracted_by !== 'LLM'), file + ' · every bad batch rejected → ' + ai.fallbacks_to_rules + ' fallback(s) to rules', JSON.stringify(ai));
    }
  }

  console.log('\n5 · page order');
  const out = path.join(os.tmpdir(), 'll_j.json'); let code = 0;
  try { execFileSync(process.execPath, [path.join(ROOT, 'cli.js'), '--sample', 'jumbled', '-o', out], { stdio: 'ignore' }); } catch (e) { code = e.status; }
  ok(code === 3, 'jumbled pages stop the pipeline (exit code 3)');

  console.log('\n' + pass + ' passed · ' + fail + ' failed');
  if (fail) { console.log('Failed: ' + failures.join(' | ')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
