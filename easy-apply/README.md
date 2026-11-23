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
| Run itself 4x every weekday (09:00, 12:00, 15:00, 18:00) | `powershell -ExecutionPolicy Bypass -File run.ps1 --schedule` |

Leave the window alone while it runs. If a CAPTCHA or login check appears it beeps and waits: sort it out, press Enter.

## What it will and won't do
- **40 applications a day**: 20 LinkedIn + 20 Indeed, 5 per site in each of the 4 daily runs (`per_run_cap`, `daily_cap`).
- **Hand-apply list**: every job it reads gets a 0–100% rating (title 25, your skills in the advert 35, salary 15, location/office days 15, sector such as payments/NHS/university/AI 10). Jobs **without** Easy Apply rated **95%+** go on `data/hand_apply.html`, which opens in your browser after a run that found new ones (`hand_apply.min_rating`).
- It updates itself from GitHub at the start of each run.
- Older note on caps: LinkedIn has its own daily Easy Apply limit (reported ~50, resets midnight UTC): if it shows its limit message the bot stops LinkedIn for the day. Higher caps raise the chance of an account restriction.
- Max 2 applications per company per week (`max_per_company_per_week`).
- Skips: titles outside your target roles; salary shown under £60k (£65k London); 4–5 office days or Mon–Fri on site; existing security clearance required; a second language required (not "nice to have"); contract day-rate roles; adverts asking for more than 8 years' experience; weak matches (fewer than 3 of your skills mentioned: `min_fit_score`); your current employer. Optional: skip recruitment agencies (`skip_recruitment_agencies`), skip jobs with too many applicants (`max_applicants`).
- Never makes things up: a required question it can't answer → it abandons that job and writes the question to `data/questions_to_answer.txt`. Add the answer to `custom_answers` in `config.json` (part of the question in lower case → your answer) and it will use it next time.
- Equality-monitoring questions: only ever "Prefer not to say".
- Log of everything: `data/applied.csv` (open in Excel).
