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
  '03c_scanned_page1.jpg': { n: 18, score: 959, decision: 'APPROVE', ocr: true },
  '04_csv_export_jan2025.csv': { n: 32, score: 966, decision: 'APPROVE' },
  '05_remittances_feb2025.csv': { n: 9, score: 937, decision: 'APPROVE' }
};

function runCli(file, env, extra) {
  const out = path.join(os.tmpdir(), 'll_test_' + process.pid + '_' + Math.random().toString(36).slice(2) + '.json');
  try { execFileSync(process.execPath, [path.join(ROOT, 'cli.js'), path.resolve(TS, file), '-o', out].concat(extra || []), { env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'ignore'], timeout: 240000 }); }
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

  console.log('\n6 · cheques, foreign currency, long statements');
  const ce = new C({});
  for (const [n, cp, no] of [['CHQ PAID-000451-SHARMA TRADERS', 'SHARMA TRADERS', '000451'], ['TO CLG CHQ NO 000452 SHARMA TRADERS', 'SHARMA TRADERS', '000452'], ['CHEQUE NO 112233 ISSUED TO MEHTA & SONS', 'MEHTA & SONS', '112233'], ['BY CLG/ICIC/000123/VIKRAM TRADERS', 'VIKRAM TRADERS', '000123'], ['CHQ NO. 000453/SELF/CASH WDL', 'Self (cheque cash withdrawal)', '000453']]) {
    const ch = ce.channelOf(n); const got = ce.counterpartyOf(n, ch, '').cp; const chq = (ce.attrsOf(n).find((a) => a.k === 'Cheque no') || {}).v;
    ok(ch === 'CHEQUE' && got === cp && chq === no, 'cheque "' + n + '" → ' + ch + ' · ' + got + ' · no. ' + chq, 'expected CHEQUE · ' + cp + ' · no. ' + no);
  }
  const fx = runCli('02_multi_month_multi_account.pdf', { LLM_PROVIDER: '', ANTHROPIC_API_KEY: '' }, []);
  const accCur = {}; (fx.accounts || []).forEach((a) => { accCur[a.account_number] = a.currency; });
  const fxRows = (fx.transactions || []).filter((t) => t.original_currency);
  ok(fx.transactions && fx.transactions.every((t) => t.currency === accCur[t.account_number]), 'every row\'s currency is the currency its amounts are in (the account currency)');
  const noCp = (fx.transactions || []).filter((t) => t.counterparty === 'UNIDENTIFIED');
  ok(noCp.length === 1 && noCp.every((t) => t.review.flagged && !t.review.auto_accepted_low_impact), 'a row with no counterparty in the narration (' + (noCp[0] || {}).narration + ') goes to the Review queue, even when the amount is small');
  // classification engine
  const T2 = fx.transactions || []; const tax = C.prototype.defaultTaxonomy.call({});
  ok(T2.length && T2.every((t) => /^(CREDIT|DEBIT)$/.test(t.level1) && tax.some((x) => x.code === t.level2 && x.l1 === t.level1) && typeof t.classification_confidence === 'number' && /^(RULE|LLM|MANUAL)$/.test(t.method)), 'every row has level 1, a level 2 from the taxonomy for that direction, a confidence and a method');
  ok(T2.every((t) => t.method !== 'LLM'), 'rules-only run labels no row LLM (fallback keywords are RULE)');
  const by = (re) => T2.filter((t) => re.test(t.narration));
  ok(by(/NEHA GUPTA|ANKIT SHARMA\/ankit\.s@okicici\/(Split|Trip)/).every((t) => t.level1 === 'CREDIT' && t.level2 === 'P2P' && t.category_group !== 'income'), 'P2P receipts are P2P, not income');
  ok(by(/REFUND/).length >= 2 && by(/REFUND/).every((t) => t.level2 === 'REFUND' && t.category_group === 'credit_others'), 'merchant refunds are REFUND (credit_others), not income');
  ok(by(/Tuition fee/i).length >= 2 && by(/Tuition fee/i).every((t) => t.level2 === 'EDUCATION'), '"Tuition fee" in the narration → EDUCATION');
  ok(T2.filter((t) => t.counterparty_confidence < 0.7 || t.classification_confidence < 0.7).every((t) => t.review.flagged || t.review.auto_accepted_low_impact) && T2.filter((t) => t.review.flagged).every((t) => t.review.reasons.length), 'every row under the 70% threshold is flagged (or auto-accepted as low impact, with its reasons kept)');
  const tx = runCli('02_multi_month_multi_account.pdf', { LLM_PROVIDER: '', ANTHROPIC_API_KEY: '' }, ['--taxonomy', path.join(ROOT, 'taxonomy-example.csv')]);
  const cat = (re) => ((tx.transactions || []).find((t) => re.test(t.narration)) || {});
  ok(cat(/CLOUDNOTE/).level2 === 'SUBSCRIPTION' && cat(/LITTLE STARS/).level2 === 'CHILDCARE' && cat(/PLAYARENA/).level2 === 'ENTERTAINMENT' && /Custom CSV/.test(cat(/PLAYARENA/).method_reason || ''), 'taxonomy CSV adds categories (SUBSCRIPTION, CHILDCARE) and overrides one (ENTERTAINMENT keywords)');
  const cm = new C({}); await cm.runPipeline(cm.genSample('flags'), 'manual override test');
  const tm = cm.buildTxns().find((t) => /CLOUDNOTE/.test(t.narr)); cm.state.overrides = { ...cm.state.overrides, [tm.id]: 'ENTERTAINMENT' }; cm._txCache = null;
  const tm2 = cm.buildTxns().find((t) => t.id === tm.id);
  ok(tm.flagged && tm2.l2 === 'ENTERTAINMENT' && tm2.method === 'MANUAL' && tm2.conf === 1 && !tm2.flagged, 'a reviewer\'s category is stored as MANUAL (100%) and clears the flag');
  const rm = runCli('05_remittances_feb2025.csv', { LLM_PROVIDER: '', ANTHROPIC_API_KEY: '' }, []);
  const rr = (re) => ((rm.transactions || []).find((t) => re.test(t.narration)) || {});
  const remits = [[/INWARD REMITTANCE\/SWIFT/, 'CREDIT', 'RAVI MEHTA'], [/INW REMIT-USD/, 'CREDIT', 'ANITA RAO'], [/^FIRC/, 'CREDIT', 'ACME CORP USA'], [/OUTWARD REMITTANCE\/SWIFT/, 'DEBIT', 'PRIYA SHARMA'], [/FOREIGN OUTWARD TT/, 'DEBIT', 'NIKHIL RAO']];
  ok(remits.every(([re, l1, cp]) => { const t = rr(re); return t.level1 === l1 && t.level2 === 'REMITTANCE' && t.counterparty === cp && t.channel === 'REMITTANCE' && t.category_group !== 'income'; }), 'inward and outward remittances (SWIFT, INW REMIT, FIRC, outward TT) → REMITTANCE, channel REMITTANCE, sender / payee as counterparty, not income');
  ok(rr(/UNIVERSITY OF TORONTO/).level2 === 'EDUCATION' && rr(/PREMIUM POLICY/).level2 === 'INSURANCE' && !ce.kwHit('OUTWARD REMITTANCE', 'EMI') && ce.kwHit('LN0045821936-EMI JAN', 'EMI'), 'keywords must start a word: "EMI" no longer matches inside REMITTANCE or PREMIUM; tuition sent abroad → EDUCATION');
  const mk = runCli('02_multi_month_multi_account.pdf', { LLM_PROVIDER: 'mock' }, ['--llm']);
  const ml = (mk.transactions || []).filter((t) => t.method === 'LLM');
  ok(ml.length > 0 && mk.run.ai.classification_calls >= 1 && ml.every((t) => /^Model:/.test(t.method_reason)), 'with the LLM on, unclear rows are classified by the model and labelled LLM (' + ml.length + ' rows)');
  ok(fxRows.length === 3 && fxRows.every((t) => t.original_currency === 'USD' && t.original_amount === 24.99 && t.currency === 'INR'), 'foreign card spends keep the original amount separately (' + fxRows.length + ' × USD 24.99, billed in INR)');

  // a 102-page statement (34 batches), header on page 1 only — the batching must scale and every page must inherit the account
  const PAGES = 102, PER = 10; let bal = 250000; const big = [];
  const fmt = (x) => x.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const NARR = ['UPI/5%s1234567/FRESHBASKET MART/freshbasket@okaxis/Groceries', 'NEFT CR-CITI0000002-ACME TECHNOLOGIES PVT LTD-SALARY', 'BBPS/ELECTRICITY/NORTHGRID POWER/CA 1029384', 'POS/XX8832/CITY FUELS SECTOR 29', 'IMPS/P2A/5%s1234567/SUNIL KAPOOR/House rent', 'CHQ PAID-0%s-SHARMA TRADERS'];
  for (let p = 0; p < PAGES; p++) {
    const rows = [];
    for (let i = 0; i < PER; i++) {
      const k = p * PER + i, dt = String(1 + Math.floor((p % 10) * 2.8 + i * 0.25)).padStart(2, '0') + '/' + String(1 + Math.floor(p / 10)).padStart(2, '0') + '/2025';
      const kind = k % NARR.length, cr = kind === 1, amt = cr ? 9000 + (k % 7) * 100 : 500 + (k % 13) * 37.5;
      bal = Math.round((cr ? bal + amt : bal - amt) * 100) / 100;
      rows.push('| ' + dt + ' | ' + dt + ' | ' + NARR[kind].replace('%s', String(100000 + k).slice(-5)) + ' | ' + (cr ? '' : fmt(amt)) + ' | ' + (cr ? fmt(amt) : '') + ' | ' + fmt(bal) + ' |');
    }
    const head = p === 0 ? 'MERIDIAN BANK | Statement of Account\nAccount Holder: ROHAN MEHTA\nAccount Number: 50100234567812\nAccount Type: Savings - Individual\nCurrency: INR\nStatement Period: 01/01/2025 to 30/11/2025\nOpening Balance: 2,50,000.00\n\n' : '';
    big.push(head + '| Date | Value Date | Narration | Debit | Credit | Balance |\n|---|---|---|---|---|---|\n' + rows.join('\n') + '\n\nPage ' + (p + 1) + ' of ' + PAGES);
  }
  const bigFile = path.join(os.tmpdir(), 'll_big_' + process.pid + '.txt'); fs.writeFileSync(bigFile, big.join('\f'));
  const bj = runCli(bigFile, { LLM_PROVIDER: 'mock' }, ['--llm']); fs.unlinkSync(bigFile);
  const bai = (bj.run || {}).ai || {};
  ok(bj.transactions && bj.transactions.length === PAGES * PER && bj.run.batches.length === 34 && bai.extraction_calls === 34 && bai.fallbacks_to_rules === 0 && bj.data_validation.summary.failed === 0, PAGES + '-page statement → ' + (bj.run ? bj.run.batches.length : 0) + ' batches of 3 pages · ' + (bj.transactions || []).length + ' txns · ' + bai.extraction_calls + ' model calls · 0 failed checks', JSON.stringify({ exit: bj.exit, ai: bai }));
  ok(bj.transactions && bj.transactions.every((t) => t.account_number === '50100234567812' && t.currency === 'INR' && t.counterparty && t.counterparty !== 'UNIDENTIFIED'), 'pages 2–' + PAGES + ' inherit account and currency; every row has a counterparty');

  console.log('\n7 · credit risk scoring');
  const R2 = fx.credit_risk_summary || {}; const M2 = R2.metrics || {};
  const W = { 'Income Stability': 25, 'Debt Service': 20, 'Liquidity': 15, 'Banking Behaviour': 10, 'Fraud Indicators': 15, 'Expense Management': 15 };
  ok((R2.components || []).length === 6 && R2.components.every((c) => W[c.component] === c.weight_pct) && Math.abs(R2.components.reduce((a, c) => a + c.points, 0) - R2.composite_score) <= 3 && R2.scale === '0-1000', 'six components with weights 25/20/15/10/15/15 add up to the 0–1000 composite');
  const has = (o, ks) => o && ks.every((k) => o[k] !== undefined);
  ok(has(M2.income_stability, ['income_by_category', 'regularity_cv_pct', 'source_count', 'growth_first_to_last_pct']) && has(M2.debt_service, ['emi_obligations', 'foir_pct', 'emi_bounce_rate_pct', 'on_time_payment_rate_pct']) && has(M2.liquidity, ['avg_eod_balance', 'min_eod_balance', 'negative_balance_days']) && has(M2.banking_behaviour, ['bounces', 'bounce_charges', 'penalty_fees', 'overdraft_days']) && has(M2.fraud_indicators, ['balance_arithmetic_breaks', 'circular_transactions', 'overnight_pass_through', 'structuring']) && has(M2.expense_management, ['essential_share_pct', 'discretionary_share_pct', 'fixed_share_pct', 'variable_share_pct', 'spend_trend_first_to_last_pct']), 'every metric in the brief is reported (income, debt, liquidity, banking, fraud, expense)');
  ok(M2.debt_service.emi_obligations.length === 3 && M2.debt_service.foir_pct === 37 && M2.debt_service.emi_bounce_rate_pct === 12.5 && M2.fraud_indicators.circular_transactions.length === 1 && M2.fraud_indicators.structuring.length === 1, 'sample 02: 3 EMIs, FOIR 37%, EMI bounce rate 12.5%, 1 circular flow, 1 structuring pattern');
  const scen = async (name, months, tamper) => {
    const c = new C({}); let bal = 60000; const rows = [];
    months.forEach((list, mi) => list.forEach(([d, n, t, a]) => { bal = Math.round((t === 'C' ? bal + a : bal - a) * 100) / 100; const dt = String(d).padStart(2, '0') + '/0' + (mi + 1) + '/2025'; rows.push('| ' + dt + ' | ' + dt + ' | ' + n + ' | ' + (t === 'D' ? c.fmt(a) : '') + ' | ' + (t === 'C' ? c.fmt(a) : '') + ' | ' + c.fmt(bal + (tamper && rows.length === 4 ? 1000 : 0)) + ' |'); }));
    const text = 'MERIDIAN BANK | Statement of Account\nAccount Holder: TEST CUSTOMER\nAccount Number: 50100111122223\nAccount Type: Savings - Individual\nCurrency: INR\nStatement Period: 01/01/2025 to 31/03/2025\nOpening Balance: 60,000.00\n\n| Date | Value Date | Narration | Debit | Credit | Balance |\n|---|---|---|---|---|---|\n' + rows.join('\n') + '\n\nPage 1 of 1';
    await c.runPipeline([{ index: 1, text, chars: text.length }], name); return c.score(c.buildTxns(), c.state);
  };
  const M3 = (f) => [1, 2, 3].map(f);
  const SAL = [1, 'NEFT CR-CITI0000002-ACME TECHNOLOGIES PVT LTD-SALARY', 'C', 150000], GRO = [9, 'UPI/5091234567/FRESHBASKET MART/freshbasket@okaxis/Groceries', 'D', 8000], PWR = [15, 'BBPS/ELECTRICITY/NORTHGRID POWER/CA 1029384', 'D', 3000];
  let sc = await scen('clean', M3(() => [SAL, [3, 'ACH D-HOMEFIN LTD-LN0045821936-EMI', 'D', 30000], GRO, PWR]));
  ok(sc.decision === 'APPROVE' && sc.total >= 800 && sc.band === 'Excellent', 'clean salaried customer → ' + sc.total + ' · ' + sc.band + ' · APPROVE');
  sc = await scen('bounce', M3((m) => [SAL, [3, 'ACH D-HOMEFIN LTD-LN0045821936-EMI', 'D', 30000]].concat(m === 2 ? [[4, 'ACH RTN-HOMEFIN LTD-LN0045821936-INSUFFICIENT FUNDS', 'C', 30000], [5, 'NACH RTN CHGS-LN0045821936 INCL GST', 'D', 590], [8, 'ACH D-HOMEFIN LTD-LN0045821936-EMI REPRESENT', 'D', 30000]] : []).concat([GRO, PWR])));
  ok(sc.decision === 'APPROVE WITH CONDITIONS' && sc.why.some((w) => /EMI bounce/.test(w)), 'one EMI bounce → APPROVE WITH CONDITIONS (NACH mandate)');
  sc = await scen('foir', M3(() => [[1, 'NEFT CR-CITI0000002-ACME TECHNOLOGIES PVT LTD-SALARY', 'C', 50000], [3, 'ACH D-HOMEFIN LTD-LN0045821936-EMI', 'D', 30000], [5, 'ACH D-AUTOFIN BANK-LN7781200453-CAR LOAN EMI', 'D', 10000], GRO]));
  ok(sc.decision === 'DECLINE' && sc.foir > 0.65 && sc.why.some((w) => /FOIR above 65%/.test(w)), 'FOIR ' + Math.round(sc.foir * 100) + '% (> 65%) → DECLINE, whatever the band');
  sc = await scen('noinc', M3((m) => [[2, 'UPI/5021234567/RAHUL VERMA/rahulv@oksbi/loan', 'C', [0, 20000, 5000, 30000][m]], [6, 'POS/XX8832/SHOPKART ONLINE', 'D', 25000], [12, 'UPI/5121234567/SPICE ROUTE CAFE/spiceroute@ybl/Dinner', 'D', 9000], [25, 'LATE PAYMENT FEE', 'D', 750]]));
  ok(sc.decision === 'DECLINE' && sc.total < 600 && sc.why.some((w) => /No verifiable income/.test(w)) && !sc.why.some((w) => /FOIR above|credit card/.test(w)), 'P2P money only (no verifiable income) → ' + sc.total + ' · ' + sc.band + ' · DECLINE, reason "no verifiable income" (not FOIR, not credit card)');
  sc = await scen('tamper', M3(() => [SAL, [3, 'ACH D-HOMEFIN LTD-LN0045821936-EMI', 'D', 30000], GRO, PWR]), true);
  ok(sc.decision === 'REFER' && sc.integrity.length >= 1 && sc.why.some((w) => /tampering/.test(w)), 'one edited balance → arithmetic check fails → REFER (possible tampering)');

  console.log('\n' + pass + ' passed · ' + fail + ' failed');
  if (fail) { console.log('Failed: ' + failures.join(' | ')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
