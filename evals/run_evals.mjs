#!/usr/bin/env node
// LedgerLens decision evals. Runs every case in evals/cases.json through the real CLI and scores the result.
//
//   node evals/run_evals.mjs          rules only (default; no API key, no cost)
//   node evals/run_evals.mjs --llm    AI extraction and classification; needs ANTHROPIC_API_KEY in your environment
//
// Writes evals/results-<mode>.md and exits 1 if any case fails. The key is read by the CLI from the environment;
// this script never prints or stores it.
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const CLI = join(ROOT, "app", "cli.js");
const mode = process.argv.includes("--llm") ? "llm" : "rules";
const { cases, criteria } = JSON.parse(readFileSync(join(HERE, "cases.json"), "utf8"));
const tmp = mkdtempSync(join(tmpdir(), "ll_eval_"));

const hasTool = (cmd) => spawnSync(cmd, ["-v"], { stdio: "ignore" }).error === undefined;
const tools = { pdftoppm: hasTool("pdftoppm") };
const commit = (() => { try { return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT }).toString().trim(); } catch { return "unknown"; } })();

function run(c) {
  if (c.needs && !tools[c.needs]) return { skipped: `needs ${c.needs}, not installed on this machine` };
  if (mode === "llm" && c.rules_only_case) return { skipped: "checks the no-key path; not meaningful with a key set" };
  // The same file passed twice must reach the engine as two uploads, so give the second copy its own name.
  const seen = new Set();
  const files = (c.files || (c.file ? [c.file] : [])).map((f) => {
    const p = join(ROOT, f);
    if (!seen.has(p)) { seen.add(p); return p; }
    const copy = join(tmp, "again_" + basename(f)); copyFileSync(p, copy); return copy;
  });
  const out = join(tmp, c.id + ".json");
  const args = [CLI, ...files, ...(c.sample ? ["--sample", c.sample] : []), ...(c.args || []), ...(mode === "llm" && !(c.args || []).includes("--llm") ? ["--llm"] : []), "-o", out];
  const env = { ...process.env, ...(mode === "rules" ? { ANTHROPIC_API_KEY: "", LLM_PROVIDER: "" } : {}), ...(c.env || {}) };
  const t0 = Date.now();
  const r = spawnSync(process.execPath, args, { cwd: join(ROOT, "app"), env, encoding: "utf8", timeout: 300000 });
  const secs = (Date.now() - t0) / 1000;
  const j = r.status === 0 && existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : null;
  return { exit: r.status, stderr: r.stderr || "", j, secs };
}

function score(c, r) {
  const e = c.expect; const R = r.j?.credit_risk_summary; const checks = {};
  checks.exit = r.exit === e.exit;
  if (e.stderr) checks.safe_stop = r.exit === e.exit && r.stderr.includes(e.stderr);
  if (e.decision) checks.decision = R?.decision === e.decision;
  if (e.reason) checks.reason = (R?.decision_reasons || []).some((w) => w.includes(e.reason));
  if (e.score !== undefined) checks.score = R?.composite_score === e.score;
  if (e.transactions !== undefined) checks.transactions = r.j?.transactions.length === e.transactions;
  if (e.review_items !== undefined) checks.review = R?.pending_review_items === e.review_items;
  const actual = r.exit !== 0 ? `exit ${r.exit}` + (e.stderr ? `: ${(r.stderr.match(/✗ (.*)/) || [, ""])[1].slice(0, 70)}` : "")
    : `${R?.decision} · ${R?.composite_score} · ${r.j?.transactions.length} txns` + (R?.pending_review_items ? ` · ${R.pending_review_items} to review` : "");
  return { checks, pass: Object.values(checks).every(Boolean), actual };
}

const fmtExpect = (e) => e.exit !== 0 ? `exit ${e.exit}` + (e.stderr ? `: "${e.stderr}"` : "")
  : [e.decision, e.score, e.transactions !== undefined && `${e.transactions} txns`, e.review_items && `${e.review_items} to review`, e.reason && `reason "${e.reason}"`].filter(Boolean).join(" · ");

const rows = []; const tally = {}; let failed = 0; const aiStats = [];
for (const c of cases) {
  const r = run(c);
  if (r.skipped) { rows.push(`| ${c.id} | ${c.what} | ${fmtExpect(c.expect)} | not run: ${r.skipped} | — |`); console.log(`SKIP ${c.id} ${r.skipped}`); continue; }
  const s = score(c, r);
  for (const [k, v] of Object.entries(s.checks)) { tally[k] ??= [0, 0]; tally[k][1]++; if (v) tally[k][0]++; }
  if (!s.pass) failed++;
  const bad = Object.entries(s.checks).filter(([, v]) => !v).map(([k]) => k);
  rows.push(`| ${c.id} | ${c.what} | ${fmtExpect(c.expect)} | ${s.actual} | ${s.pass ? "pass" : "**FAIL** (" + bad.join(", ") + ")"} |`);
  if (r.j?.run?.ai?.mode === "llm") aiStats.push(`${c.id}: ${r.j.run.ai.calls} calls, ${r.j.run.ai.fallbacks_to_rules} fallback(s) to rules`);
  console.log(`${s.pass ? "PASS" : "FAIL"} ${c.id} ${s.actual} (${r.secs.toFixed(1)} s)`);
}
rmSync(tmp, { recursive: true, force: true });

const ran = rows.filter((r) => !r.includes("| not run:")).length;
const label = { exit: "Exit code as expected", safe_stop: "Bad input stopped with the right message", decision: "Credit decision correct", reason: "Hard-rule reason named", score: "Score exact", transactions: "Transaction count exact", review: "Review queue size exact" };
const md = [
  `# Eval results: ${mode === "llm" ? "AI mode (--llm)" : "rules only"}`,
  "",
  `Run ${new Date().toLocaleDateString("en-CA")} · commit \`${commit}\` · Node ${process.version} · ${process.platform}. Generated by \`node evals/run_evals.mjs${mode === "llm" ? " --llm" : ""}\`; do not edit by hand.`,
  "",
  `**${ran - failed} of ${ran} cases passed** (${cases.length - ran} not run).`,
  "",
  "| Criterion | Passed |",
  "|---|---|",
  ...Object.entries(tally).map(([k, [p, n]]) => `| ${label[k] || k} | ${p} / ${n} |`),
  "",
  "| Case | Statement | Expected | Actual | Result |",
  "|---|---|---|---|---|",
  ...rows,
  "",
  ...(aiStats.length ? ["AI usage per case: " + aiStats.join("; ") + ".", ""] : []),
  "What each criterion means: " + Object.entries(criteria).map(([k, v]) => `**${k}**: ${v}`).join(" "),
  "",
].join("\n");
writeFileSync(join(HERE, `results-${mode}.md`), md);
console.log(`\n${ran - failed}/${ran} passed, ${cases.length - ran} not run. Wrote evals/results-${mode}.md`);
process.exit(failed ? 1 : 0);
