# Autoline: submit every queued application from YOUR Windows computer (real Chrome).
# Run in PowerShell:
#   irm https://raw.githubusercontent.com/thinkhiphop12-pixel/job-aoutmation/autoline/job-hunt/apply_local.ps1 | iex
# (the repo is private, so instead run it from a local clone:  powershell -ExecutionPolicy Bypass -File job-hunt\apply_local.ps1)
# Needs: Git and Node.js (https://nodejs.org). It never solves CAPTCHAs: tick them yourself when a window pauses.
$ErrorActionPreference = "Stop"
$root = Join-Path $HOME "Autoline"
if (-not (Test-Path (Join-Path $root ".git"))) {
  git clone --branch main https://github.com/thinkhiphop12-pixel/job-aoutmation.git $root
} else {
  git -C $root pull --ff-only origin main
}
Set-Location (Join-Path $root "job-hunt")
if (-not (Test-Path "node_modules\playwright")) { npm install --no-save playwright@1.49.1 }
npx --yes playwright@1.49.1 install chromium | Out-Null
node auto_apply.mjs --headed
Set-Location $root
git add job-hunt/data/applications job-hunt/data/latest
git commit -m "Autoline: applications submitted from my computer" 2>$null
git push origin HEAD:main
Write-Host "Done. Submitted applications are recorded in the repo; the morning digest will show them."
