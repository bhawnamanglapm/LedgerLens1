# Changelog

Built from the git history. Dates are commit dates. The project has no version numbers or releases, so entries are
grouped by date.

## 2026-10-19

- Added a decision eval set: 20 cases in `evals/cases.json` and a runner (`node evals/run_evals.mjs`). Rules mode:
  19 of 19 passed, 1 not run (needs poppler). AI mode not run yet.
- Rewrote the README as a product case study; the full technical reference moved to `docs/TECHNICAL.md`.
- Added `docs/PRD.md` (markdown copy of blueprint section 14), `docs/decisions.md`, this changelog and two screenshots.
- `docs/PRODUCT_STATUS.md`: dependency advisories marked fixed; test count updated to 110.

## 2026-10-17

- Fixed the document-parser dependency advisories (`pdfjs-dist`, `xlsx`, `tar`) while keeping Node 18 support (#2).
- Made the prototype status clear: risk labels are not lending recommendations, and warnings appear at upload and
  next to results (#1).

## 2026-10-04

- Added the product blueprint and MVP PRD (PDF), with the original brief as an appendix.
- Explained the risk score in plain language: ⓘ panels and a score guide.
- API v1: storage, background queue and review decisions. Activity log on the server, shared across the team.
- Knowledge sharing tab: CIBIL compared with this analyzer, and a plain-language FAQ.
- Phone layout: activity log rows stack into cards; hamburger menu instead of a sideways-scrolling tab strip.

## 2026-10-03

- Added a synthetic statement for every decision path, and one-click example statements in the app.
- Kept "&" in payee names.
- README: live demo link, corrected counts, section order and working examples.

## 2026-10-02

- First version: web app, LLM backend, CLI, tests and CI.
- Fixed: foreign-currency rows and cheque parsing; tested cheques and statements over 100 pages.
- Fixed: rows with no counterparty are always reviewed.
- Fixed: fallback classifications labelled RULE instead of LLM; taxonomy CSV option for the CLI.
- Fixed: "EMI" matched inside "REMITTANCE" and "PREMIUM".
- Fixed: an applicant with no income was declined for "FOIR above 65%" instead of "No verifiable income".
- Fixed: overlapping uploads left a duplicate row (966 APPROVE became 853 REFER); unsupported files are rejected.
