# Job bot: LinkedIn Easy Apply + Indeed Easily apply

Runs on **your** computer, in a Chrome window logged into **your** LinkedIn and Indeed. 4 times every weekday it reads new jobs, skips bad fits, sends Easy Apply applications (50 a day: 25 LinkedIn + 25 Indeed), highest-paying best-fit jobs first,, and puts the best jobs without Easy Apply on a hand-apply list.

**One page to look at: `data/dashboard.html`**. It shows what was sent today, the jobs to apply to by hand (rated 95%+), questions the bot couldn't answer, and anything that needs you (e.g. "please log in"). It opens by itself when there's something new.

## Setup (once, then it runs by itself)
1. Get the latest files: in `$HOME\Autoline` run `git pull` (or ask Claude on your laptop to do it).
2. Double-click **`easy-apply\SETUP.cmd`**. It installs everything, opens Chrome so you can log in to LinkedIn and Indeed, does a 2-form practice run, schedules itself and puts 3 icons on your desktop:
   - **Job bot - dashboard**: what was sent, jobs to apply to by hand, questions to answer
   - **Job bot - run now**: an extra run whenever you like
   - **Job bot - my settings**: your answers and limits

After that it runs by itself every weekday at 09:00, 12:00, 15:00 and 18:00, plus 5 minutes after you log in (so runs missed while the laptop was off catch up). It even wakes the laptop from sleep if Windows allows. Keep the laptop on and logged in; it's fine if the screen is locked.

Stop it: `Unregister-ScheduledTask -TaskName 'Job bot' -Confirm:$false`. Running SETUP.cmd again is always safe.

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
5. Easy Apply jobs go into a queue, then it applies **best first**: £74k+ (`target_salary`) best fit first, then no salary shown, then the rest. Up to 7 per site per run, 25 per site per day; leftovers wait for the next run. No Easy Apply but 95%+ → hand-apply list.
   Where the form has a cover letter or "message to the employer" box, it writes a short note to the hiring manager naming the role, the company and the skills from the advert you have.
6. Any required question it can't answer honestly → it abandons that job and lists the question on the dashboard.

## Safety
- Never invents answers; equality questions only ever get "Prefer not to say".
- Never solves CAPTCHAs: if one appears during a scheduled run it stops that site and tells you on the dashboard.
- Stops a site for the day if LinkedIn/Indeed shows its daily-limit message. LinkedIn's limit is reported at ~50/day; the bot does 25.
- LinkedIn/Indeed don't allow automation: there's a risk of an account restriction. Human pace and low caps keep it small.

Logs: `data/applied.csv` (every job and what happened), `data/hand_apply.csv`.
