#!/usr/bin/env bash
# LedgerLens — one-time local setup (macOS / Linux)
set -e
cd "$(dirname "$0")/app"
v=$(node -v 2>/dev/null | sed 's/v//' | cut -d. -f1)
if [ -z "$v" ] || [ "$v" -lt 18 ]; then echo "✗ Node.js 18 or newer is needed — install from https://nodejs.org (LTS)"; exit 1; fi
echo "✓ Node $(node -v)"
command -v pdftoppm >/dev/null && echo "✓ poppler (scanned PDFs from the command line)" || echo "• optional: poppler for scanned PDFs in the CLI (brew install poppler / sudo apt install poppler-utils)"
npm install --no-audit --no-fund
[ -f .env ] || { cp .env.example .env; echo "✓ created app/.env — open it and paste your Claude API key"; }
npm test
echo ""
echo "Next: put your key in app/.env, then:  cd app && npm start   → http://localhost:8787"
