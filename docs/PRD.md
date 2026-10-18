# LedgerLens MVP PRD

> **Draft for the owner to edit.** This is a markdown copy of section 14 of the
> [product blueprint](LedgerLens_Product_Blueprint.pdf) (dated 4 Oct 2026), so it can be read and edited on GitHub. The
> wording follows the PDF; tables were reformatted. Tags such as **[Assumption]**, **[Approx.]** and **[Reg/Legal]** are
> the blueprint's own. **Every target below is a target, not a result.** No pilot has run.

## Summary

Take the LedgerLens prototype to a production pilot with one NBFC for salaried and self-employed personal loans. The
pilot runs in parallel with the lender's current process for 8 weeks; success is a measured accuracy baseline and a
50% cut in officer time per file.

## Problem statement

Credit officers at NBFCs spend 20–45 minutes per file **[Approx.]** re-checking bank-statement reports they do not
trust: salary, EMIs, bounces and possible tampering. Reports are long, unexplained and vendor-scored, so decisions vary
between officers and are hard to defend in audits. Lenders need a statement analysis they can trust, explain and tune
themselves.

## Goals (pilot, 8 weeks)

| # | Goal | Measure | Target [Assumption] |
|---|---|---|---|
| G1 | Officers decide faster | Median officer handling time per case (open → accept) | ≤ 5 minutes (from baseline 20+) |
| G2 | Data is right | Rows with correct date, amount and balance on the labelled set | ≥ 97% |
| G3 | Categories are right where it matters | Accuracy on income, EMI and transfer categories | ≥ 95% |
| G4 | Review stays small | Median review items per case | ≤ 3 |
| G5 | Recommendations agree with good judgement | Agreement between LedgerLens decision and lender's final decision | ≥ 85%, with every disagreement explained |
| G6 | Reliable | API availability; p90 time to recommendation | 99.5%; ≤ 10 minutes |

## Non-goals (MVP)

- Account Aggregator fetch, document forensics, MSME scorecard (Phase 2).
- Automated final decisions without an officer.
- Net-banking credential fetch (never).
- A calibrated statistical model (needs repayment data).
- Mobile app for borrowers (the lender's app handles capture).

## Personas in scope

Credit officer (primary), senior underwriter (overrides), ops/QC (exceptions), risk head (policy v1 and reports),
lender developer (API). Details in section 2 of the blueprint.

## User stories

| ID | As a… | I want to… | So that… | Priority |
|---|---|---|---|---|
| US1 | Lender developer | create a case and upload statements by API and get a webhook when done | our LOS gets results without polling | Must |
| US2 | DSA / ops | be told within 30 seconds if a statement is unusable (password, missing pages, wrong file) | I fix it while the borrower is still with me | Must |
| US3 | Credit officer | see a trust summary, score, decision and top reasons on one screen | I decide in minutes | Must |
| US4 | Credit officer | open ⓘ on any number and see how it was calculated from this statement | I can trust and defend it | Must |
| US5 | Credit officer | review only the transactions that can change the decision, sorted by impact | I don't re-check 300 rows | Must |
| US6 | Credit officer | save a fix as a rule for this counterparty | the same item is right next time | Should |
| US7 | Senior underwriter | approve or reject decision overrides with a reason | exceptions are controlled and auditable | Must |
| US8 | Risk head | set our cut-offs and knock-outs per product in a versioned config | policy matches our credit policy, not the vendor's | Must |
| US9 | Ops | fix a failed extraction with the page image beside the rows | cases don't get stuck | Must |
| US10 | Auditor | replay any past decision exactly as it was | audits and complaints are answered with evidence | Must |
| US11 | Credit officer | download a PDF/Excel case report | the credit committee file is complete | Must |
| US12 | Risk head | see accuracy, review load and decision mix by week | I know whether the tool is working | Should |

## Functional requirements

| ID | Requirement | Stories |
|---|---|---|
| FR1 | Cases API: create, get, list; case holds applicant reference, product, segment, LOS id | US1 |
| FR2 | Document upload via pre-signed URL; PDF (digital, scanned, encrypted), JPG/PNG, CSV, XLSX; ≤ 25 MB, ≤ 300 pages | US1, US2 |
| FR3 | Pre-check within 30 s: file type, password needed, page order, period, readable text; result shown to uploader and sent by webhook | US2 |
| FR4 | Extraction: rule parsers + LLM fallback; header and rows; per-row source (rule / LLM / OCR) and confidence | US3 |
| FR5 | All 22 existing validation checks plus fuzzy holder-name match; trust summary with severity | US2, US3 |
| FR6 | Categorisation rules → LLM → review with confidence, method and reason per row | US3, US5 |
| FR7 | Review queue: only items below threshold and able to move income, FOIR or a hard rule; sorted by ₹ impact; assignment and SLA timer | US5 |
| FR8 | Counterparty rule from a review fix, scoped to the tenant, with an undo | US6 |
| FR9 | Scoring: six components, 1000 points, bands, hard overrides; results versioned with parser, taxonomy, scorecard and policy versions | US3, US10 |
| FR10 | Policy v1: per-tenant, per-product config (cut-offs, knock-outs, band mapping, amount rule), versioned, maker-checker publish | US8 |
| FR11 | Explanations: ⓘ for score, decision and each component; 1–4 reason codes per decision | US4 |
| FR12 | Overrides: category (officer), decision (officer proposes, checker approves); reason list + free text | US7 |
| FR13 | Exceptions queue for STOP cases with page image, highlighted rows, re-run options | US9 |
| FR14 | Audit: append-only event log per case; replay by version; export | US10 |
| FR15 | Case report: PDF and Excel with summary, trust, components, reasons, transactions, review and override history | US11 |
| FR16 | Webhooks (signed, retried 24 h) for needs_input, stopped, in_review, completed, result_updated | US1 |
| FR17 | Roles: officer, senior underwriter, ops, risk head, admin, auditor; tenant isolation | US7, US8 |
| FR18 | Pilot dashboard: volume, auto-decision rate, review backlog, decision mix, first-pass extraction rate | US12 |

## Non-functional requirements

| Area | Requirement |
|---|---|
| Performance | p90 time to recommendation ≤ 10 min for ≤ 50 pages; pre-check ≤ 30 s; API p95 ≤ 500 ms for reads |
| Scale | 5,000 cases a day per tenant at pilot; workers scale horizontally |
| Availability | 99.5% monthly in pilot, 99.9% target at GA; no data loss on restart (jobs re-queued) |
| Security | TLS 1.2+; encryption at rest with per-tenant keys; MFA for console; OWASP ASVS L2; annual penetration test before bank customers |
| Privacy | PII masked in UI lists, logs and LLM prompts; raw files deleted after the configured period; no data used to train shared models without written consent |
| Residency | All storage and processing in India regions [Reg/Legal] |
| Auditability | Every result reproducible from stored versions; audit log append-only and hash-chained |
| Accessibility | WCAG 2.1 AA for the console; works on a 1366 px laptop and a phone for DSAs |

## Acceptance criteria (key examples)

- **AC-US2:** Given a password-protected PDF, when it is uploaded without a password, then within 30 s the case shows
  "Needs input: password" and a `case.needs_input` webhook is sent; the password is never written to disk or logs.
- **AC-US3:** Given a completed case, when the officer opens it, then score, band, decision, top 3 reasons and trust
  status are visible without scrolling on a 1366 × 768 screen.
- **AC-US5:** Given 7 low-confidence rows of which 2 can move FOIR or income, then the review queue shows exactly those
  2, highest ₹ impact first, and the other 5 are auto-accepted and labelled.
- **AC-US7:** Given an officer proposes a decision override above her authority, then it is not applied until a senior
  underwriter approves; both actions, reasons and times are in the audit log.
- **AC-US8:** Given the risk head publishes policy v2, then cases analysed before publication keep v1 results, new
  cases use v2, and the case shows which version decided it.
- **AC-US10:** Given any past case and version, when "Replay" is run, then the score and decision are identical to the
  stored ones.

## Success metrics

Primary: G1 officer handling time and G2 row accuracy. Secondary: G4 review items, G5 agreement, override rate < 10%,
pilot lender NPS from officers ≥ 30.

## Dependencies

| Dependency | Owner | Needed by |
|---|---|---|
| Pilot lender with 300+ historical statements and their final decisions (for the labelled set) | Lender | Week 0 |
| Lender's credit policy for personal loans (cut-offs, knock-outs) | Lender risk team | Week 2 |
| LOS webhook endpoint and test environment | Lender IT | Week 6 |
| LLM provider contract with no-training, India or approved-region processing | LedgerLens + legal | Week 2 |
| Cloud account in an India region; KMS; managed Postgres | LedgerLens | Week 1 |
| Security review / vendor assessment by the lender | Lender InfoSec | Before go-live |

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Accuracy on real statements lower than on test data | Medium | High | Labelled set first; per-bank accuracy tracking; LLM fallback; ops exception queue |
| Lender's InfoSec review delays pilot | High | Medium | Start the security questionnaire in week 1; SOC 2 / ISO 27001 roadmap |

## Assumptions

1. One pilot NBFC, personal loans ₹50,000 to ₹5 lakh, salaried and self-employed. [Assumption]
2. Statements arrive as PDFs or scans from the lender's DSA flow. [Assumption]
3. The lender keeps the final decision; LedgerLens provides a recommendation. [Assumption, Reg/Legal]
4. Prototype code is the starting point; storage moves from SQLite to Postgres. [Confirmed prototype, Assumption for plan]

---

## Where the prototype stands against this PRD

Not part of the blueprint. Added on 19 Oct 2026 from a read of the code and the [eval run](../evals/results-rules.md).
"Not found" means the feature was not found in the code, not that it was ruled out.

| Requirement | Prototype today |
|---|---|
| FR3 pre-check | Partly. Password-protected files, wrong passwords and jumbled pages stop with a message (evals E08–E10, E16, E18). The 30-second limit was not measured and there are no webhooks. |
| FR4, FR6 extraction and categorisation | Built. Every row carries `method` (RULE / LLM / MANUAL) and a confidence. AI-mode accuracy has not been measured. |
| FR7 review queue | Built, without assignment or SLA timers. Eval E17 checks that the 4 cheque rows are queued. |
| FR8 save a fix as a rule | "Save as rule" exists in the app; not scoped to a tenant. |
| FR9 scoring | Six components, 1000 points, bands and hard overrides are built. The API saves a new result version after review decisions. |
| FR11 explanations | Built (ⓘ panels; a test checks them against the real calculation). |
| FR15 case report | JSON download (transactions and risk summary); no PDF or Excel report. |
| FR10 policy config, FR13 exceptions queue, FR14 replay and audit export, FR16 webhooks, FR17 roles, FR18 dashboard | Not found. |
| G1–G6 | Not measured. They need a pilot lender and a labelled set of real statements. |

> **OWNER INPUT NEEDED:** confirm the table above, and say whether you still plan the pilot described here or would
> change the scope.
