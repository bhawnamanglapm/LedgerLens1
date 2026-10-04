#!/usr/bin/env node
/*
 * LedgerLens BSA — command-line runner.
 * Uses the exact same engine as the web PoC (engine.js = the page's logic) through pipeline.js, which adds Node
 * adapters for PDF text (pdfjs-dist), OCR (tesseract.js) and scanned-PDF rendering (poppler's pdftoppm, if installed).
 *
 *   node cli.js <file> [more files…] [-o output.json] [--password <pw>] [--sample flags|clean|jumbled] [--review all] [--llm] [--taxonomy rules.csv]
 *
 *   --llm   use the LLM for batch extraction and unclear-row classification (needs ANTHROPIC_API_KEY;
 *           LLM_MODEL to override the model). Rules stay as cross-check and fallback.
 *   --taxonomy  CSV that overrides or extends the default categories (same format as the web app's
 *           Taxonomy upload: category,level1[,group,keywords]; see taxonomy-example.csv).
 */
const fs = require('fs'); const path = require('path');
const args = process.argv.slice(2);
const opt = { out: null, pw: null, sample: null, review: 'smart', llm: false, files: [] };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '-o' || a === '--out') opt.out = args[++i];
  else if (a === '--password') opt.pw = args[++i];
  else if (a === '--sample') opt.sample = args[++i];
  else if (a === '--review') opt.review = args[++i];
  else if (a === '--llm') opt.llm = true;
  else if (a === '--taxonomy') opt.taxonomy = args[++i];
  else if (a === '-h' || a === '--help') { console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]); process.exit(0); }
  else opt.files.push(a);
}
if (!opt.files.length && !opt.sample) { console.error('Usage: node cli.js <statement.pdf|.png|.jpg|.xlsx|.csv|.txt> [...] [-o out.json] [--password pw] | --sample flags|clean|jumbled'); process.exit(1); }

const { analyze } = require('./pipeline');
const llm = require('./llm');

(async () => {
  let customRules = null;
  if (opt.taxonomy) {
    try { customRules = new (require('./pipeline').Component)({}).parseCsv(fs.readFileSync(opt.taxonomy, 'utf8')); } catch (e) { console.error('✗ --taxonomy: ' + e.message); process.exit(1); }
    console.error('  Taxonomy: ' + customRules.length + ' custom rule(s) from ' + path.basename(opt.taxonomy));
  }
  if (opt.llm) {
    const i = llm.info();
    if (!i.llm) { console.error('✗ --llm needs ANTHROPIC_API_KEY (or LLM_PROVIDER=mock for the offline test double)'); process.exit(4); }
    console.error('  LLM: ' + i.provider + ' · ' + i.model);
  }
  const t0 = Date.now();
  const onLog = (level, step, msg) => { if (level !== 'INFO' || /Run (started|completed)|Decision|OCR/.test(step + msg)) console.error('  [' + level + '] ' + step + ': ' + msg); };
  const r = await analyze({ sample: opt.sample, files: opt.files.map((p) => ({ name: path.basename(p), path: p })), password: opt.pw, llm: opt.llm, reviewMode: opt.review, customRules, onLog, waitTicks: 1200 });
  if (r.code === 'NEED_PASSWORD') { console.error('✗ ' + r.file + ' is password-protected — re-run with --password <pw>'); process.exit(2); }
  if (r.code === 'WRONG_PASSWORD') { console.error('✗ Wrong password for ' + r.file); process.exit(2); }
  if (r.code === 'STOPPED') { console.error('✗ Pipeline stopped: ' + r.error); process.exit(3); }
  const out = r.output;
  const file = opt.out || 'ledgerlens_output.json';
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  const v = out.data_validation.summary; const rr = out.credit_risk_summary;
  console.log('✓ ' + out.transactions.length + ' transactions · ' + out.accounts.length + ' account(s) · ' + out.run.pages + ' page(s) in ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s');
  console.log('  Validation: ' + v.passed + ' passed · ' + v.warnings + ' warnings · ' + v.failed + ' failed · ' + v.not_applicable + ' n/a');
  const ai = out.run.ai;
  if (ai.mode === 'llm') console.log('  LLM: ' + ai.model + ' · ' + ai.calls + ' calls (' + ai.extraction_calls + ' extraction, ' + ai.classification_calls + ' classification) · ' + ai.retries + ' retries · ' + ai.fallbacks_to_rules + ' fallback(s) · ' + ai.rows_from_model + ' rows from model, ' + ai.rows_matching_rule_parser + ' match the rule parser · ' + ai.input_tokens + ' in / ' + ai.output_tokens + ' out tokens');
  else console.log('  LLM: off (rules only)');
  if (rr) console.log('  Score: ' + rr.composite_score + '/1000 · ' + rr.rating_band + ' · ' + rr.decision + (rr.provisional ? ' (provisional — ' + rr.pending_review_items + ' item(s) to review)' : ''));
  console.log('  JSON written to ' + file);
  process.exit(0);
})().catch((e) => { console.error('✗ ' + (e && e.stack || e)); process.exit(1); });
