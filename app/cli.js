#!/usr/bin/env node
/*
 * LedgerLens BSA — command-line runner.
 * Uses the exact same engine as the web PoC (engine.js = the page's logic) and adds Node adapters for
 * PDF text (pdfjs-dist), OCR (tesseract.js) and scanned-PDF rendering (poppler's pdftoppm, if installed).
 *
 *   node cli.js <file> [more files…] [-o output.json] [--password <pw>] [--sample flags|clean|jumbled] [--review all] [--llm] [--taxonomy rules.csv]
 *
 *   --llm   use the LLM for batch extraction and unclear-row classification (needs ANTHROPIC_API_KEY;
 *           LLM_MODEL to override the model). Rules stay as cross-check and fallback.
 *   --taxonomy  CSV that overrides or extends the default categories (same format as the web app's
 *           Taxonomy upload: category,level1[,group,keywords]; see taxonomy-example.csv).
 */
const fs = require('fs'); const path = require('path'); const os = require('os'); const { execFileSync } = require('child_process');
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

const Component = require('./engine-node')();
const llm = require('./llm');

class CliEngine extends Component {
  async callLLM(req) { return llm.call(req); }
  log(level, step, msg, push, meta) { super.log(level, step, msg, push, meta); if (level !== 'INFO' || /Run (started|completed)|Decision|OCR/.test(step + msg)) console.error('  [' + level + '] ' + step + ': ' + msg); }
  ocrEngine() {
    if (this._twP) return this._twP;
    this._twP = this._makeOcr(); this._twP.then((w) => { this._tw = w; });
    return this._twP;
  }
  async _makeOcr() {
    const T = require('tesseract.js');
    // language model ships with the @tesseract.js-data/eng package, so OCR works offline
    const langPath = path.join(path.dirname(require.resolve('@tesseract.js-data/eng/package.json')), '4.0.0_best_int');
    this._tw = await T.createWorker('eng', 1, { langPath, gzip: true, cacheMethod: 'none' });
    await this._tw.setParameters({ preserve_interword_spaces: '1' });
    return this._tw;
  }
  async ocrRun(src, label) {
    const w = await this.ocrEngine(); const t0 = Date.now();
    const input = src && src.__png ? src.__png : (src && src.arrayBuffer ? Buffer.from(await src.arrayBuffer()) : src);
    const { data } = await w.recognize(input);
    const conf = Math.round(data.confidence || 0);
    this.log(conf < 60 ? 'WARN' : 'INFO', 'OCR', label + ' → confidence ' + conf + '% (' + ((Date.now() - t0) / 1000).toFixed(1) + ' s)');
    return { text: data.text || '', conf };
  }
  async renderPdfPage(pg, pageNo) {
    // scanned PDFs: render the page with poppler's pdftoppm (apt install poppler-utils / brew install poppler)
    if (!this._cliPdf) throw new Error('scanned PDF page found but no file path for rendering');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'll-'));
    try { execFileSync('pdftoppm', ['-r', '200', '-png', '-f', String(pageNo), '-l', String(pageNo), this._cliPdf, path.join(tmp, 'p')]); }
    catch (e) { throw new Error('this PDF has scanned pages; install poppler (pdftoppm) to OCR them from the CLI, or use the web app'); }
    const f = fs.readdirSync(tmp).find((x) => x.endsWith('.png'));
    return { __png: fs.readFileSync(path.join(tmp, f)) };
  }
  async pdfToPages(buf, password, ocrName) { this._cliPdf = this._cliPaths[ocrName]; return super.pdfToPages(buf, password, ocrName); }
}

(async () => {
  const c = new CliEngine({}); c.state.reviewMode = opt.review === 'all' ? 'all' : 'smart'; c._cliPaths = {};
  if (opt.taxonomy) {
    try { c.state.customRules = c.parseCsv(fs.readFileSync(opt.taxonomy, 'utf8')); } catch (e) { console.error('✗ --taxonomy: ' + e.message); process.exit(1); }
    console.error('  Taxonomy: ' + c.state.customRules.length + ' custom rule(s) from ' + path.basename(opt.taxonomy));
  }
  if (opt.llm) {
    const i = llm.info();
    if (!i.llm) { console.error('✗ --llm needs ANTHROPIC_API_KEY (or LLM_PROVIDER=mock for the offline test double)'); process.exit(4); }
    if (i.provider.startsWith('mock')) llm.setMockEngine(new Component({}));
    c.state.llmStatus = { st: 'ready', model: i.model, provider: i.provider, msg: '' }; c.state.aiMode = 'llm';
    console.error('  LLM: ' + i.provider + ' · ' + i.model);
  }
  const t0 = Date.now();
  if (opt.sample) { await c.runPipeline(c.genSample(opt.sample), 'built-in sample: ' + opt.sample); }
  else {
    const files = opt.files.map((p) => { const buf = fs.readFileSync(p); const name = path.basename(p); c._cliPaths[name] = path.resolve(p); return new File([buf], name); });
    await c.handleFiles(files);
    if (c.state.needPw) {
      if (!opt.pw) { console.error('✗ ' + c.state.needPw.name + ' is password-protected — re-run with --password <pw>'); process.exit(2); }
      c._pwInput = opt.pw; await c.submitPassword();
      if (c.state.needPw) { console.error('✗ Wrong password for ' + c.state.needPw.name); process.exit(2); }
    }
  }
  for (let i = 0; i < 1200 && c.state.busy; i++) await new Promise((r) => setTimeout(r, 100));
  if (c._twP) { try { (await c._twP).terminate(); } catch (e) {} }
  if (c.state.error) { console.error('✗ Pipeline stopped: ' + c.state.error); process.exit(3); }
  const T = c.buildTxns(); const R = c.score(T); const out = c.exportData(T, R);
  const file = opt.out || 'ledgerlens_output.json';
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  const v = out.data_validation.summary; const r = out.credit_risk_summary;
  console.log('✓ ' + T.length + ' transactions · ' + out.accounts.length + ' account(s) · ' + out.run.pages + ' page(s) in ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s');
  console.log('  Validation: ' + v.passed + ' passed · ' + v.warnings + ' warnings · ' + v.failed + ' failed · ' + v.not_applicable + ' n/a');
  const ai = out.run.ai;
  if (ai.mode === 'llm') console.log('  LLM: ' + ai.model + ' · ' + ai.calls + ' calls (' + ai.extraction_calls + ' extraction, ' + ai.classification_calls + ' classification) · ' + ai.retries + ' retries · ' + ai.fallbacks_to_rules + ' fallback(s) · ' + ai.rows_from_model + ' rows from model, ' + ai.rows_matching_rule_parser + ' match the rule parser · ' + ai.input_tokens + ' in / ' + ai.output_tokens + ' out tokens');
  else console.log('  LLM: off (rules only)');
  if (r) console.log('  Score: ' + r.composite_score + '/1000 · ' + r.rating_band + ' · ' + r.decision + (r.provisional ? ' (provisional — ' + r.pending_review_items + ' item(s) to review)' : ''));
  console.log('  JSON written to ' + file);
  process.exit(0);
})().catch((e) => { console.error('✗ ' + (e && e.stack || e)); process.exit(1); });
