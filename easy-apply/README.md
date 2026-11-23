# Job bot: LinkedIn Easy Apply + Indeed Easily apply

Runs on **your** computer, in a Chrome window logged into **your** LinkedIn and Indeed. 4 times every weekday it reads new jobs, skips bad fits, sends Easy Apply applications (40 a day), and puts the best jobs without Easy Apply on a hand-apply list.

**One page to look at: `data/dashboard.html`**. It shows what was sent today, the jobs to apply to by hand (rated 95%+), questions the bot couldn't answer, and anything that needs you (e.g. "please log in"). It opens by itself when there's something new.

## Setup (once)
1. Install Node.js LTS from https://nodejs.org
2. In PowerShell: `cd $HOME\Autoline; git pull; cd easy-apply`
3. Log in: `powershell -ExecutionPolicy Bypass -File run.ps1 --login`
4. Practice (fills 3 forms, sends nothing): `powershell -ExecutionPolicy Bypass -File run.ps1 --dry-run --max 3`
5. Switch on the 4 daily runs (09:00, 12:00, 15:00, 18:00): `powershell -ExecutionPolicy Bypass -File run.ps1 --schedule`

## Your settings: `my_settings.json`
Created on the first run. Change things **here**, not in `config.json` (that one updates itself; yours is never overwritten).
- `years`: your years of experience per skill (check these). Unlisted skills are answered 0 / No.
- `custom_answers`: teach it answers. `"words from the question": "your answer"`, e.g. `"driving licence": "Yes"`.
- `daily_cap`, `hand_apply.min_rating`: copy any other setting from `config.json` to override it.

## How each run works
1. Searches your 9 searches on each site (last 24 hours).
2. Skips straight from the search results: titles outside your roles, junior/coordinator/etc., your current employer, jobs you already applied to.
3. Opens the rest and skips: salary shown under £60k (£65k London), 4–5 office days, existing security clearance needed, a second language required, contract day rates, 9+ years asked, weak matches (under 3 of your skills mentioned), a company you already applied to twice this week.
4. Rates what's left 0–100% (title 25, your skills 35, salary 15, location/office days 15, sector 10).
5. Easy Apply → fills and submits (5 per site per run). No Easy Apply but 95%+ → hand-apply list.
6. Any required question it can't answer honestly → it abandons that job and lists the question on the dashboard.

## Safety
- Never invents answers; equality questions only ever get "Prefer not to say".
- Never solves CAPTCHAs: if one appears during a scheduled run it stops that site and tells you on the dashboard.
- Stops a site for the day if LinkedIn/Indeed shows its daily-limit message. LinkedIn's limit is reported at ~50/day; the bot does 20.
- LinkedIn/Indeed don't allow automation: there's a risk of an account restriction. Human pace and low caps keep it small.

Logs: `data/applied.csv` (every job and what happened), `data/hand_apply.csv`.
