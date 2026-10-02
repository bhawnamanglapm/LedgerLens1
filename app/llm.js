/*
 * LedgerLens — LLM transport used by the backend (server.js) and the CLI (cli.js).
 *
 *   ANTHROPIC_API_KEY   required for real calls
 *   LLM_MODEL           default claude-sonnet-5-5
 *   LLM_API_URL         default https://api.anthropic.com/v1/messages
 *   LLM_PROVIDER=mock   offline test double (NOT a model) — used by the automated tests
 *
 * Every call uses tool use with a forced tool, so the answer is always JSON in the schema the engine defines,
 * and temperature 0 so the same statement gives the same answer.
 */
// optional app/.env file (KEY=value per line) — environment variables already set take priority
try {
  const fs = require('fs'); const p = require('path').join(__dirname, '.env');
  if (fs.existsSync(p)) fs.readFileSync(p, 'utf8').split(/\r?\n/).forEach((l) => { const m = l.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/); if (m && !l.trim().startsWith('#') && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, ''); });
} catch (e) {}
const MODEL = process.env.LLM_MODEL || 'claude-sonnet-5-5';
const API = process.env.LLM_API_URL || 'https://api.anthropic.com/v1/messages';
const ALLOWED_TOOLS = ['record_transactions', 'classify_transactions'];

function provider() {
  if (process.env.LLM_PROVIDER === 'mock' || process.env.LLM_PROVIDER === 'mock-bad') return process.env.LLM_PROVIDER;
  const k = process.env.ANTHROPIC_API_KEY || '';
  return k && !/paste-your-key/.test(k) ? 'anthropic' : null; // the .env.example placeholder counts as no key
}
function info() { const p = provider(); return { llm: !!p, provider: p, model: p && p.startsWith('mock') ? 'mock-llm (test double)' : MODEL }; }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function anthropic(req) {
  const body = {
    model: MODEL, max_tokens: Math.min(req.max_tokens || 8000, 32000), temperature: 0,
    system: req.system, tools: [req.tool], tool_choice: { type: 'tool', name: req.tool.name },
    messages: [{ role: 'user', content: req.user }]
  };
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    const t0 = Date.now();
    const r = await fetch(API, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (r.ok) {
      const block = (j.content || []).find((b) => b.type === 'tool_use' && b.name === req.tool.name);
      if (!block) throw new Error('model did not call the ' + req.tool.name + ' tool' + (j.stop_reason ? ' (stop_reason ' + j.stop_reason + ')' : ''));
      if (j.stop_reason === 'max_tokens') throw new Error('answer was cut off at max_tokens — batch too large');
      return { ok: true, input: block.input, usage: j.usage || {}, model: j.model || MODEL, ms: Date.now() - t0 };
    }
    last = new Error('model API HTTP ' + r.status + ': ' + ((j.error && j.error.message) || 'error'));
    if (r.status === 429 || r.status >= 500) { await sleep(1500 * (attempt + 1)); continue; } // rate limit / overload → back off and retry
    throw last;
  }
  throw last;
}

// ---------- offline test double: reads the page text with the deterministic parser and answers in the tool schema ----------
let mockEngine = null;
function setMockEngine(e) { mockEngine = e; }
async function mock(req, bad) {
  const t0 = Date.now();
  if (req.tool.name === 'record_transactions') {
    let ctx = null; try { ctx = JSON.parse(req.user.split('\n\n')[0].replace(/^[^:]*:\s*/, '')); } catch (e) {}
    let prev = ctx ? ctx.last_balance : null; let card = ctx ? /card/i.test(ctx.account_type || '') : false;
    const parts = req.user.split(/=== PAGE (\d+) ===\n/).slice(1); const transactions = []; const accounts = [];
    for (let i = 0; i < parts.length; i += 2) {
      const page = Number(parts[i]); const text = (parts[i + 1] || '').split('\n\nYour previous answer')[0].split('\n\nPrevious batch')[0];
      const meta = mockEngine.readMeta(text);
      if (meta.account) { card = /card/i.test((meta.type || '') + ' ' + meta.account); if (meta.opening != null) prev = meta.opening; }
      if (meta.account) accounts.push({ page, account_number: meta.account, bank: meta.bank || null, currency: meta.currency || null, holder: meta.holder || null, account_type: meta.type || null, opening_balance: meta.opening == null ? null : meta.opening, closing_balance: meta.closing == null ? null : meta.closing });
      mockEngine.parseRows(text).forEach((r) => {
        let dr = r.dr || null, cr = r.cr || null;
        if (r.loose) {
          const sg = card ? 1 : -1;
          if (prev != null && r.bal != null && Math.abs(prev + sg * r.amt - r.bal) < 0.02) dr = r.amt;
          else if (prev != null && r.bal != null && Math.abs(prev - sg * r.amt - r.bal) < 0.02) cr = r.amt;
          else if (r.hint === 'C' || /\bCR\b|CREDIT|REFUND|SALARY/i.test(r.narr)) cr = r.amt; else dr = r.amt;
        }
        if (r.bal != null) prev = r.bal;
        transactions.push({ page, date: r.date, value_date: r.vdate, narration: r.narr, debit: dr, credit: cr, balance: r.bal == null ? null : r.bal, account_number: meta.account || null });
      });
    }
    if (bad) transactions.forEach((t) => { if (t.balance != null) t.balance += 1000; }); // deliberately wrong → must be caught by the balance check
    return { ok: true, input: { accounts, transactions }, usage: { input_tokens: Math.round(req.user.length / 4), output_tokens: transactions.length * 60 }, model: 'mock-llm (test double)', ms: Date.now() - t0 };
  }
  if (req.tool.name === 'classify_transactions') {
    const items = JSON.parse(req.user.split('Transactions:\n')[1]);
    const guess = (it) => {
      const u = it.narration.toUpperCase();
      if (it.direction === 'DEBIT') { if (/AMZN|FLIPKART|MYNTRA|BAZAAR|MART/.test(u)) return ['SHOPPING', 0.8]; if (/UBER|OLA|IRCTC|FLIGHT/.test(u)) return ['TRAVEL', 0.8]; if (/CLOUD|SUBSCR|NETFLIX|SPOTIFY/.test(u)) return ['SUBSCRIPTION', 0.74]; return ['OTHER_DEBIT', 0.4]; }
      if (/ADVANCE/.test(u)) return ['OTHER_CREDIT', 0.55]; return ['OTHER_CREDIT', 0.4];
    };
    const allowed = req.tool.input_schema.properties.items.items.properties.category.enum;
    return { ok: true, input: { items: items.map((it) => { const [c, conf] = guess(it); return { id: it.id, category: allowed.indexOf(c) >= 0 ? c : (it.direction === 'CREDIT' ? 'OTHER_CREDIT' : 'OTHER_DEBIT'), confidence: conf, reason: 'mock answer' }; }) }, usage: { input_tokens: Math.round(req.user.length / 4), output_tokens: items.length * 25 }, model: 'mock-llm (test double)', ms: Date.now() - t0 };
  }
  throw new Error('unknown tool');
}

async function call(req) {
  if (!req || !req.tool || ALLOWED_TOOLS.indexOf(req.tool.name) < 0) throw new Error('tool not allowed');
  if (typeof req.user !== 'string' || req.user.length > 400000) throw new Error('request too large');
  const p = provider();
  if (!p) throw new Error('no ANTHROPIC_API_KEY set on the backend');
  if (p === 'mock') return mock(req, false);
  if (p === 'mock-bad') return mock(req, true);
  return anthropic(req);
}

module.exports = { call, info, setMockEngine, MODEL };
