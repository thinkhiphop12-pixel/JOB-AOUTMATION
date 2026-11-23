# Easy Apply bot (LinkedIn + Indeed)

Runs on **your** computer, in a Chrome window logged into **your** LinkedIn and Indeed.
It searches (last 24 hours), filters out bad fits, fills each Easy Apply / Easily apply form from `config.json`, and submits.

## Setup (once, ~5 minutes)
1. Install Node.js LTS from https://nodejs.org
2. Get this folder: `git clone https://github.com/thinkhiphop12-pixel/JOB-AOUTMATION.git` (or `git pull` in your existing copy), then open PowerShell in `easy-apply`.
3. Log in once: `powershell -ExecutionPolicy Bypass -File run.ps1 --login`
   (a Chrome window opens: log in to LinkedIn, press Enter; log in to Indeed, press Enter.)
4. **Check the numbers in `config.json` → `years`** (your years of experience per skill). Anything not listed is answered 0 / No.
5. Optional: put your general CV in this folder as `cv.pdf` (used only if a form demands an upload and none is on file).

## Use
| What | Command |
|---|---|
| Practice (fills forms, never submits) | `powershell -ExecutionPolicy Bypass -File run.ps1 --dry-run --max 3` |
| Apply for real | `powershell -ExecutionPolicy Bypass -File run.ps1` |
| Only LinkedIn / only Indeed | add `--linkedin` or `--indeed` |
| Run itself every weekday 09:15 | `powershell -ExecutionPolicy Bypass -File run.ps1 --schedule` |

Leave the window alone while it runs. If a CAPTCHA or login check appears it beeps and waits: sort it out, press Enter.

## What it will and won't do
- Daily caps: 30 LinkedIn + 30 Indeed (change in `config.json` → `daily_cap`). Higher caps raise the chance LinkedIn/Indeed restrict your account for automation.
- Skips: titles outside your target roles, salary shown under £60k (£65k London), 4–5 office days, clearance or a second language required, your current employer.
- Never makes things up: a required question it can't answer → it abandons that job and writes the question to `data/questions_to_answer.txt`. Add the answer to `custom_answers` in `config.json` (part of the question in lower case → your answer) and it will use it next time.
- Equality-monitoring questions: only ever "Prefer not to say".
- Log of everything: `data/applied.csv` (open in Excel).
