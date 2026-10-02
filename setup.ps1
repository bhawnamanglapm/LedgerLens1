# LedgerLens — one-time local setup (Windows PowerShell):  powershell -ExecutionPolicy Bypass -File setup.ps1
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "app")
try { $v = [int]((node -v).TrimStart('v').Split('.')[0]) } catch { $v = 0 }
if ($v -lt 18) { Write-Host "x Node.js 18 or newer is needed - install the LTS from https://nodejs.org"; exit 1 }
Write-Host "OK Node $(node -v)"
if (-not (Get-Command pdftoppm -ErrorAction SilentlyContinue)) { Write-Host "- optional: poppler for scanned PDFs in the CLI (https://github.com/oschwartz10612/poppler-windows)" }
npm install --no-audit --no-fund
if (-not (Test-Path .env)) { Copy-Item .env.example .env; Write-Host "OK created app\.env - open it and paste your Claude API key" }
npm test
Write-Host ""
Write-Host "Next: put your key in app\.env, then:  cd app; npm start   -> http://localhost:8787"
