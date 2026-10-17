# LedgerLens product status

## Classification and current status

**Classification: working proof-of-concept**, not a shipped lending product. The repository contains a browser UI, a Node.js app/backend, a CLI, an API with SQLite persistence, synthetic statement fixtures and an automated test runner. The Claude artifact is a separate deployment; this repository does not verify or automatically update it.

**Documented problem and value hypothesis:** statement review can involve extracting and categorizing transactions manually. LedgerLens explores whether a traceable workflow can make that analysis easier to inspect. The repository describes credit analysts/reviewers as the intended users. Neither the problem frequency nor the value hypothesis has been validated with users.

**Contribution:** the repository documents project artifacts, but does not establish the owner's role or which work was personally completed. Owner input is needed before publishing a personal-contribution claim.

**Intended next outcome:** make the prototype safe and credible to demonstrate with synthetic data, then decide whether to validate the workflow further. This is a proposal, not a commitment to production lending use.

## Evidence and confidence

| Type | Finding | Source |
|---|---|---|
| Verified in repository | Node.js app, browser UI, CLI, backend/API and SQLite storage exist. | `app/package.json`, `app/server.js`, `app/backend/`, `app/cli.js` |
| Verified in repository | The API stores uploaded statement files unencrypted under `DATA_DIR`; no statement deletion operation was found in `app/backend/`. | `app/backend/db.js`, search of `app/backend/` |
| Verified in repository | `DEMO_MODE=1` is reported as a health flag and displayed by the UI; it does not reject uploads. | `app/server.js`, `app/public/markup.html` |
| Verified in repository | The server binds to `127.0.0.1` by default; browser password protection is bypassed when `APP_PASSWORD` is unset. | `app/server.js` |
| Verified in repository | Local LLM mode sends extracted page text through the app backend; the API v1 also has a separate file-upload/storage path. | `app/llm.js`, `app/server.js`, `app/backend/api.js` |
| Validation finding | `npm audit --omit=dev` reported four advisories (three high, one critical), including `pdfjs-dist`, `xlsx` and transitive `tar`; no dependency remediation was made. | Command run from `app/` after dependency install |
| Documented claim | Offline tests cover synthetic/mock scenarios; README and CI describe 109 checks. | `app/test/run.js`, `.github/workflows/test.yml`, `README.md` |
| Documented claim | Weights, cut-offs and scenario outcomes are examples, not calibrated lending evidence. | `README.md`, `app/engine.js` |
| Unknown | The linked PDF blueprint exists, but its market, persona and KPI claims were not independently validated in this review. | `docs/LedgerLens_Product_Blueprint.pdf` |
| Unknown | Accuracy, bias/fairness, false-positive/negative rates, real-world user value, privacy compliance, deployed artifact behavior and production security. | No independent validation evidence was found in the reviewed repository files. |
| Owner input required | Personal contribution, whether the desired outcome is a portfolio demo or a validated product, and whether any future validation dataset can be used with consent. | Not established by repository evidence. |

## Prioritized backlog

Completion conditions are intentionally evidence-based; passing synthetic tests alone does not establish lending suitability.

| Priority | Item | Reason | Completion condition | Status |
|---|---|---|---|---|
| P0 | Correct claims about authenticity, score meaning, recommendations and human review; show prototype/synthetic-data warnings at upload and risk output. | Existing copy could imply verified authenticity or an actionable lending decision. | README, demo script, FAQ, artifact source and local UI consistently say checks cannot prove authenticity and labels are unvalidated; warnings are visible before upload and beside results. | Implemented; offline suite passed (109/109). |
| P0 | Decide and enforce a data-handling boundary before any public/shared deployment. | `DEMO_MODE=1` is only a banner; the API stores unencrypted uploads, and no statement deletion operation or retention policy is documented. | Owner chooses an access/data policy; deployment blocks unintended access, defines retention/deletion and documents model processing. Synthetic-only wording alone is not a technical control. | Open; owner decision needed before changing runtime policy. |
| P0 | Resolve or explicitly contain dependency advisories before using the upload surface with untrusted files. | The installed production dependency tree has three high and one critical advisory; `pdfjs-dist` and `xlsx` are direct document parsers, while `tar` is transitive and its runtime reachability was not established. | Upgrade or replace affected packages where compatible, add regression coverage for supported formats, and document any remaining accepted risk before allowing non-synthetic uploads. | Open; compatibility review required. |
| P1 | Evaluate extraction/classification and the scoring rules separately. | Mock tests and synthetic scenarios do not measure performance on representative statements or loan outcomes. | With appropriate consent and independent review, publish dataset scope, labeling method, extraction/classification error rates, false-positive/negative analysis, subgroup limitations and calibration results; do not expose personal data. | Not started. |
| P1 | Define human review and model failure handling. | Resolving a review queue is not the same as verifying correctness; OCR/LLM errors can remain. | Specify reviewer responsibilities, overrides/escalation, uncertainty thresholds, failure recovery and an audit trail; test those flows without representing them as lending approval. | Not started. |
| P2 | Verify and maintain the separately hosted artifact and demo instructions. | Repository edits do not deploy to the linked Claude artifact. | Publish the updated artifact intentionally, verify its displayed warnings and data flows, and record a dated verification link/result. | Not verified. |

## Decisions needed from the owner

1. Should this remain a synthetic-data portfolio prototype, or is there an intended, separately governed validation path?
2. What was your personal contribution and what can be truthfully claimed in a portfolio case study?
3. Before any shared deployment, who owns access control, data retention/deletion and review of model-provider terms?

**Recommendation:** keep the public-facing story as a synthetic-data proof of concept until these decisions and independent validation are complete. Do not use the score or labels for real lending.
