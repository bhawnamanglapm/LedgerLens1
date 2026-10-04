/*
 * LedgerLens headless pipeline — the engine (engine.js, the same logic the web page runs) with Node adapters for
 * PDF text (pdfjs-dist), OCR (tesseract.js) and scanned-PDF rendering (poppler's pdftoppm). Used by the CLI and by
 * the background workers of the API.
 *
 *   const { analyze, rescore } = require('./pipeline');
 *   const r = await analyze({ files: [{ name, path }], password, llm, reviewMode, customRules, onLog });
 *   // r.ok → r.output (the JSON export) + r.snapshot (what is needed to re-score without re-reading the files)
 *   // r.code: 'NEED_PASSWORD' | 'WRONG_PASSWORD' | 'STOPPED' (pipeline stopped by validation, r.error says why)
 *   const out = rescore(r.snapshot, { overrides: { t12: 'P2P' }, cpOverrides: { t40: 'UNKNOWN TRANSFER' } });
 */
const fs = require('fs'); const path = require('path'); const os = require('os'); const { execFileSync } = require('child_process');
const Component = require('./engine-node')();
const llm = require('./llm');

class NodeEngine extends Component {
  async callLLM(req) { return llm.call(req); }
  log(level, step, msg, push, meta) { super.log(level, step, msg, push, meta); if (this.onLog) this.onLog(level, step, msg); }
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
    try {
      try { execFileSync('pdftoppm', ['-r', '200', '-png', '-f', String(pageNo), '-l', String(pageNo), this._cliPdf, path.join(tmp, 'p')]); }
      catch (e) { throw new Error('this PDF has scanned pages; install poppler (pdftoppm) to OCR them on the server, or use the web app'); }
      const f = fs.readdirSync(tmp).find((x) => x.endsWith('.png'));
      return { __png: fs.readFileSync(path.join(tmp, f)) };
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  }
  async pdfToPages(buf, password, ocrName) { this._cliPdf = this._cliPaths[ocrName]; return super.pdfToPages(buf, password, ocrName); }
  async close() { if (this._twP) { try { (await this._twP).terminate(); } catch (e) {} } }
}

// engine state that buildTxns / score / exportData read, so a stored run can be re-scored after review decisions
const SNAP_STATE = ['raw', 'accounts', 'batches', 'pages', 'source', 'llmStats', 'llmCls', 'runStatus', 'orderCheck', 'acctSkipped', 'customRules', 'reviewMode', 'threshold'];
const SNAP_SELF = ['_fileVal', '_cleanStats', '_llmStats', '_runId'];

function makeEngine(o) {
  const c = new NodeEngine({}); c._cliPaths = {}; c.onLog = o.onLog || null;
  c.state.reviewMode = o.reviewMode === 'all' ? 'all' : 'smart';
  if (o.customRules) c.state.customRules = o.customRules;
  if (o.llm) {
    const i = llm.info();
    if (!i.llm) { const e = new Error('LLM requested but no model is configured (set ANTHROPIC_API_KEY, or LLM_PROVIDER=mock for the test double)'); e.code = 'NO_LLM'; throw e; }
    if (i.provider.startsWith('mock')) llm.setMockEngine(new Component({}));
    c.state.llmStatus = { st: 'ready', model: i.model, provider: i.provider, msg: '' }; c.state.aiMode = 'llm';
  }
  return c;
}

async function analyze(o) {
  const c = makeEngine(o); const t0 = Date.now();
  try {
    if (o.sample) await c.runPipeline(c.genSample(o.sample), 'built-in sample: ' + o.sample);
    else {
      const files = o.files.map((f) => { c._cliPaths[f.name] = path.resolve(f.path); return new File([fs.readFileSync(f.path)], f.name); });
      await c.handleFiles(files);
      if (c.state.needPw) {
        const name = c.state.needPw.name;
        if (!o.password) return { ok: false, code: 'NEED_PASSWORD', error: name + ' is password-protected', file: name };
        c._pwInput = o.password; await c.submitPassword();
        if (c.state.needPw) return { ok: false, code: 'WRONG_PASSWORD', error: 'Wrong password for ' + name, file: name };
      }
    }
    for (let i = 0; i < (o.waitTicks || 3000) && c.state.busy; i++) await new Promise((r) => setTimeout(r, 100));
    if (c.state.error) return { ok: false, code: 'STOPPED', error: c.state.error };
    const T = c.buildTxns(); const R = c.score(T); const output = c.exportData(T, R);
    const snapshot = { state: {}, self: {} };
    SNAP_STATE.forEach((k) => { snapshot.state[k] = c.state[k]; });
    SNAP_SELF.forEach((k) => { snapshot.self[k] = c[k]; });
    return { ok: true, output, snapshot, ms: Date.now() - t0 };
  } finally { await c.close(); }
}

// rebuild the result from a stored snapshot plus reviewer decisions (no file reading, no OCR, no model calls)
function rescore(snapshot, decisions) {
  const c = new NodeEngine({});
  Object.assign(c.state, snapshot.state, { overrides: (decisions && decisions.overrides) || {}, cpOverrides: (decisions && decisions.cpOverrides) || {} });
  Object.assign(c, snapshot.self);
  const T = c.buildTxns(); const R = c.score(T);
  return c.exportData(T, R);
}

function taxonomy(customRules) { const c = new NodeEngine({}); if (customRules) c.state.customRules = customRules; return c.taxonomy(); }

module.exports = { NodeEngine, Component, analyze, rescore, taxonomy, makeEngine };
