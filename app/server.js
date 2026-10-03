#!/usr/bin/env node
/*
 * LedgerLens backend.
 *   npm start                      → http://localhost:8787
 *   ANTHROPIC_API_KEY=sk-... npm start   → the "LLM" mode in the app calls Claude through this server
 *
 * Endpoints
 *   GET  /api/health   { ok, llm, provider, model }
 *   POST /api/llm      { task, system, user, tool, max_tokens } → { ok, input, usage, model, ms }
 *   GET  /             the web app (same markup + engine as the claude.ai page)
 *
 * The API key never leaves this process. Only the two extraction/classification tools are allowed,
 * request bodies are capped at 2 MB, and the server listens on 127.0.0.1 unless HOST is set.
 *
 * For a cloud deployment (see DEPLOY.md) also set:
 *   APP_PASSWORD      every page and API call needs this password (browser login prompt, any user name)
 *   DEMO_MODE=1       shows "demo — synthetic statements only" in the app
 *   LLM_DAILY_LIMIT   max model calls per day for the whole server (e.g. 300); LLM_IP_LIMIT per visitor per hour (default 120)
 */
const http = require('http'); const fs = require('fs'); const path = require('path');
const llm = require('./llm');
if (llm.info().provider && llm.info().provider.startsWith('mock')) { const E = require('./engine-node')(); llm.setMockEngine(new E({})); }
const PORT = Number(process.env.PORT || 8787); const HOST = process.env.HOST || '127.0.0.1';
const PASSWORD = process.env.APP_PASSWORD || ''; const DEMO = process.env.DEMO_MODE === '1';
const DAILY = Number(process.env.LLM_DAILY_LIMIT || 0); const PER_IP = Number(process.env.LLM_IP_LIMIT || 120);
const usage = { day: '', n: 0, ip: {} };
function allowCall(ip) {
  const day = new Date().toISOString().slice(0, 10); if (usage.day !== day) { usage.day = day; usage.n = 0; }
  const hr = Math.floor(Date.now() / 3600000); const u = usage.ip[ip] && usage.ip[ip].hr === hr ? usage.ip[ip] : (usage.ip[ip] = { hr, n: 0 });
  if (DAILY && usage.n >= DAILY) return 'daily model-call limit reached (' + DAILY + ') — the app falls back to rules until tomorrow';
  if (PER_IP && u.n >= PER_IP) return 'too many model calls from this visitor this hour — try again later';
  usage.n++; u.n++; return null;
}
function authorised(req) {
  if (!PASSWORD) return true;
  const h = req.headers.authorization || ''; if (!h.startsWith('Basic ')) return false;
  const pw = Buffer.from(h.slice(6), 'base64').toString('utf8').split(':').slice(1).join(':');
  const a = Buffer.from(pw); const b = Buffer.from(PASSWORD);
  return a.length === b.length && require('crypto').timingSafeEqual(a, b);
}
const nm = (p) => path.join(path.dirname(require.resolve(p.split('/').slice(0, p.startsWith('@') ? 2 : 1).join('/') + '/package.json')), p.split('/').slice(p.startsWith('@') ? 2 : 1).join('/'));

// asset ids used by the page → files from node_modules (same versions as the claude.ai build)
const BLOBS = {
  e7450d4a01f4982d04f09e647968f2c2: () => nm('pdfjs-dist/build/pdf.worker.min.js'),
  '4a0f482804d6ee61720dc1a0e38619bd': () => nm('pdfjs-dist/build/pdf.min.js'),
  '38856ac12876fc133e6a5e7e2a3e65ac': () => nm('tesseract.js/dist/tesseract.min.js'),
  '0087241456d1e94727651e9f8590019f': () => nm('tesseract.js/dist/worker.min.js'),
  '832811907f63931b00f56362d65c0d26': () => nm('tesseract.js-core/tesseract-core-lstm.wasm.js'),
  e3a702a471db7b12836b4cbef9be0a45: () => nm('tesseract.js-core/tesseract-core-simd-lstm.wasm.js'),
  '293a34e08997121e4ecd7b38825d3e7e': () => nm('xlsx/dist/xlsx.full.min.js'),
  '028b2e7e80ab2afb0d561411fbeed0e6': () => ({ b64: nm('@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz') })
};
// example statements offered under Ingest → Show samples (only files in test-statements/ and its scenarios/ folder)
const SAMPLES = {}; const SAMPLE_TYPES = { '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.csv': 'text/csv' };
for (const dir of ['../test-statements', '../test-statements/scenarios']) {
  try { fs.readdirSync(path.join(__dirname, dir)).forEach((f) => { if (SAMPLE_TYPES[path.extname(f).toLowerCase()]) SAMPLES[f] = path.join(__dirname, dir, f); }); } catch (e) {}
}
const b64cache = {};
const types = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.json': 'application/json' };

function send(res, code, body, type) { res.writeHead(code, { 'content-type': type || 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(body); }
function file(res, p, type) { fs.readFile(p, (e, buf) => (e ? send(res, 404, 'not found', 'text/plain') : send(res, 200, buf, type || types[path.extname(p)] || 'application/octet-stream'))); }

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/healthz') return send(res, 200, 'ok', 'text/plain'); // for the hosting platform's health check
  if (!authorised(req)) { res.writeHead(401, { 'www-authenticate': 'Basic realm="LedgerLens demo", charset="UTF-8"', 'content-type': 'text/plain' }); return res.end('Password required'); }
  if (req.method === 'GET' && url === '/api/health') return send(res, 200, JSON.stringify({ ok: true, demo: DEMO, ...llm.info() }));
  if (req.method === 'POST' && url === '/api/llm') {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 2e6) { send(res, 413, JSON.stringify({ ok: false, error: 'request too large' })); req.destroy(); } else chunks.push(c); });
    req.on('end', async () => {
      if (res.writableEnded) return;
      const t0 = Date.now();
      const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
      const blocked = allowCall(ip); if (blocked) { console.log('[llm] blocked: ' + blocked); return send(res, 429, JSON.stringify({ ok: false, error: blocked })); }
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const out = await llm.call(body);
        console.log('[llm] ' + body.task + ' · ' + out.model + ' · ' + ((out.usage && out.usage.input_tokens) || 0) + ' in / ' + ((out.usage && out.usage.output_tokens) || 0) + ' out · ' + (Date.now() - t0) + ' ms');
        send(res, 200, JSON.stringify(out));
      } catch (e) { console.log('[llm] error: ' + e.message); send(res, 502, JSON.stringify({ ok: false, error: e.message })); }
    });
    return;
  }
  if (req.method !== 'GET') return send(res, 405, 'method not allowed', 'text/plain');
  if (url === '/' || url === '/index.html') return file(res, path.join(__dirname, 'public/index.html'));
  if (url === '/dc.js') return file(res, path.join(__dirname, 'public/dc.js'));
  if (url === '/markup.html') return file(res, path.join(__dirname, 'public/markup.html'));
  if (url === '/engine.js') return file(res, path.join(__dirname, 'engine.js'));
  const sm = /^\/samples\/([\w.\-]+)$/.exec(url);
  if (sm && SAMPLES[sm[1]]) return file(res, SAMPLES[sm[1]], SAMPLE_TYPES[path.extname(sm[1]).toLowerCase()]);
  const m = /^\/_blob\/([0-9a-f]{32})$/.exec(url);
  if (m && BLOBS[m[1]]) {
    const t = BLOBS[m[1]]();
    if (t.b64) { if (!b64cache[m[1]]) b64cache[m[1]] = fs.readFileSync(t.b64).toString('base64'); return send(res, 200, b64cache[m[1]], 'text/plain'); }
    return file(res, t, 'application/javascript; charset=utf-8');
  }
  send(res, 404, 'not found', 'text/plain');
});
server.listen(PORT, HOST, () => {
  const i = llm.info();
  console.log('LedgerLens running at http://' + (HOST === '0.0.0.0' ? 'localhost' : HOST) + ':' + PORT);
  console.log(i.llm ? 'LLM: ' + i.provider + ' · ' + i.model : 'LLM: off — set ANTHROPIC_API_KEY to enable (the app falls back to rules)');
  console.log('Password: ' + (PASSWORD ? 'on' : 'off') + ' · demo notice: ' + (DEMO ? 'on' : 'off') + ' · model-call limits: ' + (DAILY ? DAILY + '/day, ' : 'no daily cap, ') + PER_IP + '/visitor/hour');
  if (HOST !== '127.0.0.1' && HOST !== 'localhost' && !PASSWORD) console.log('WARNING: listening on ' + HOST + ' without APP_PASSWORD — anyone who can reach this server can use your API key.');
});
