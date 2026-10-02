# LedgerLens — Demo walkthrough script (≈4 minutes)

Record the screen at 1440 px wide. Run the **local app** with your API key (`cd app && ANTHROPIC_API_KEY=… npm start`, open http://localhost:8787) so the LLM is live. Have the `test-statements/` folder open beside the browser.

| # | Time | What to click | What to say |
|---|------|---------------|-------------|
| 1 | 0:00–0:20 | Open the app on **Home**, then click **Upload a statement**. | "This is LedgerLens, a bank statement analyzer. The homepage explains the three stages and where to find things. It runs three stages: extraction, classification and credit risk. Every stage is validated before it moves on." |
| 2 | 0:20–0:50 | Point at **AI step: LLM (Claude)**, then upload `01_single_month_digital.pdf`. Point at the pipeline as each step completes. | "The model reads each batch of three pages and returns the rows as JSON. Code then checks every row against the running balance; if a batch fails, it retries once and otherwise falls back to the rule parser. Page order is checked first, and account details carry from one batch to the next." |
| 3 | 0:50–1:10 | Scroll to **Data validation** and click **Show**. | "There are 22 checks, such as the balance chain, the opening and closing balance against the statement summary, duplicates and date gaps. A step only shows ✓ Done when its checks pass. Otherwise it shows ⚠ Needs attention." |
| 4 | 1:10–1:40 | Click **Transactions** (click **Show** on the explainer if you want to walk through it), then hover over a row's method. | "Each row has date, value date, narration, debit or credit, balance, account, month, counterparty, channel and attributes such as UPI ID, IFSC and UTR. Classification runs RULE first, then LLM, then MANUAL, and stores a confidence on every row. Refunds are kept out of income, and so are person-to-person transfers." |
| 5 | 1:40–2:10 | Upload `02_multi_month_multi_account.pdf`. Mention that the old output is cleared and moved to the Activity log. | "This file covers three months and three accounts in one upload. Each new run starts on a clean screen." |
| 6 | 2:10–2:35 | Click **Review queue** and point at the smart mode toggle. Accept one item. | "Without smart mode, a reviewer would face around 50 items. Smart mode keeps only the ones that can move the decision: large amounts, recurring payments, loan-related items, possible bounces and any row with no counterparty. Here that leaves 6. Accepting an item also saves a counterparty rule, so the same item isn't asked about next time." |
| 7 | 2:35–3:10 | Click **Risk**. Walk through the score, the six components, the EMIs and the fraud flags. | "There are six weighted components, combined into a score from 0 to 1000 with a rating band and a decision. This applicant scores 777, rated Good, and is referred for review because of the flags shown here." |
| 8 | 3:10–3:25 | Click **Download JSON**. | "The export uses schema `ledgerlens.bsa.v1` and holds the transactions, the risk summary and the validation report." |
| 9 | 3:25–3:45 | Upload `03a_scanned_page1.png`.. | "Scans and images go through OCR first, which runs in the browser, and the confidence of the reading is recorded." |
| 10 | 3:45–4:00 | Click **Show samples**, then **Jumbled pages**. | "If pages are out of order, the pipeline stops with a clear error instead of producing a wrong score. The Activity log keeps every run. That's LedgerLens." |

**Optional clips.** Ingest → Batch log → Show details: the *Extraction* column shows each batch's model rows and agreement with the rule parser. Terminal: `npm test` (60 checks, including a deliberately wrong model being rejected).

**CLI clip (20 s).** Run `node cli.js ../test-statements/02_multi_month_multi_account.pdf --llm -o out.json`. It produces the same numbers as the web app.
