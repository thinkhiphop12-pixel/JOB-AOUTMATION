#!/usr/bin/env bash
# Run on YOUR computer: submits every queued Autoline application in a real Chrome window.
# Usage (from the repo root):  bash job-hunt/apply_local.sh
set -e
cd "$(dirname "$0")/.."
git pull --ff-only origin autoline || true
cd job-hunt
[ -d node_modules/playwright ] || npm install --no-save playwright@1.49.1
npx --yes playwright@1.49.1 install chromium >/dev/null 2>&1 || true
node auto_apply.mjs --headed "$@"
cd .. && git add job-hunt/data/applications job-hunt/data/latest && git commit -qm "Autoline: applications submitted from my computer" && git push -q origin HEAD:autoline || true
