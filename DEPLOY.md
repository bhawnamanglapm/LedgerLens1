# Running, sharing and deploying LedgerLens

Three ways to use this package, from simplest to most work. Do them in this order.

---

## 1 · Run locally (for the demo recording and for reviewers)

**Needs:** Node.js 18 or newer ([nodejs.org](https://nodejs.org), LTS). Optional: poppler, only for scanned PDFs from the command line.

```bash
./setup.sh                      # macOS / Linux
# Windows PowerShell:  powershell -ExecutionPolicy Bypass -File setup.ps1
```
The setup script checks Node, installs the dependencies, creates `app/.env` and runs the 89 tests.

Then:
1. Open `app/.env` and paste your Claude API key: `ANTHROPIC_API_KEY=sk-ant-...`
   (Claude Console → Settings → API keys → **Continue with an API key** → Create key.)
2. `cd app && npm start`, then open http://localhost:8787
3. On **Ingest**, check that the AI step shows *Backend connected · claude-…*.

**Before recording:** close `.env` and any terminal showing the key. Record from the browser window only.

**Sending the zip to reviewers:** the zip never contains `app/.env` or `node_modules`. Reviewers run the same three steps with their own key. Without a key the app still runs in *Rules only* mode and says so.

---

## 2 · GitHub repository with automatic tests

The package is already a git repository with one commit, and it includes `.github/workflows/test.yml`. On every push, GitHub runs `npm test` (89 checks) using the offline test double. **No API key, no cost.**

1. On github.com → **New repository** → name it `ledgerlens` → keep it **Private** if you prefer (Actions still runs) → **don't** add a README, .gitignore or licence (the package has them).
2. In the unzipped folder:
   ```bash
   git remote add origin https://github.com/<your-username>/ledgerlens.git
   git push -u origin main
   ```
3. Open the repo's **Actions** tab: the *tests* run should turn green in about 2 minutes.
4. In `README.md`, replace `<your-username>` in the badge line at the top with your GitHub user name, then commit and push. The badge then shows *tests: passing*.

To give reviewers access to a private repo: Settings → Collaborators → add their GitHub user names.

Never commit `app/.env`. `.gitignore` already excludes it. If a key is ever pushed by mistake, delete it in the Claude Console immediately and create a new one.

---

## 3 · Cloud link (only if the reviewers ask for one)

A public URL means anyone with the link could use your API credits, and statements would pass through a server. So the deployment is locked down:

| Protection | How |
|---|---|
| Password on every page and API call | `APP_PASSWORD` — the browser asks for it (any user name) |
| Banner: "Demo environment — synthetic statements only" | `DEMO_MODE=1` |
| Cap on model calls | `LLM_DAILY_LIMIT` (whole server, per day) and `LLM_IP_LIMIT` (per visitor, per hour). Over the cap, the app falls back to rules instead of failing |
| Spending cap at the source | Claude Console → **Settings → Billing → Spend limits → Set limit**: set a low monthly limit. Better: create a separate workspace for the demo (workspace limits are set under **Settings → Rate limits**; the default workspace can't have its own limit) and a separate key in it, with a short expiry |
| Key never in the code | Entered as a secret in the hosting dashboard only |

### Option A — Render (simplest; uses `render.yaml`)
1. Push the repo to GitHub (step 2).
2. render.com → **New → Blueprint** → pick the repo. Render reads `render.yaml` and builds the `Dockerfile`.
3. When asked, enter `ANTHROPIC_API_KEY` (a separate demo key) and `APP_PASSWORD`.
4. Open the URL Render gives you, sign in with the password, and run a sample.
5. Send reviewers the URL and the password in separate messages, saying it's for demo data only.

Free instances sleep when idle, so the first load can take about a minute.

### Option B — any container host (Railway, Fly.io, Google Cloud Run, Azure Container Apps)
```bash
docker build -t ledgerlens .
docker run -p 8787:8787 -e ANTHROPIC_API_KEY=sk-ant-... -e APP_PASSWORD=choose-one -e DEMO_MODE=1 -e LLM_DAILY_LIMIT=300 ledgerlens
```
Set the same variables as secrets in the host's dashboard. Health check path: `/healthz`.

On **Google Cloud, AWS or Azure** you can avoid storing a static API key by using the Claude Console's *identity federation* option. That isn't needed for this demo.

### After the review
Turn the service off and delete the demo API key in the Claude Console.
