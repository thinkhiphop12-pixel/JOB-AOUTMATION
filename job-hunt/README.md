# Autoline

Daily UK job pipeline: find, score, package and **auto-apply** (`auto_apply.mjs`, no approval step), then track.

Targets: £60k+ near Southampton (about an hour's drive) or remote-UK, £65k+ in London, 2 office days ideally (3 at most, never 4–5). Ambitious stretch-fit grading (see `fit_policy.md`).

## Sources

| Source | Type | Status |
|---|---|---|
| Reed | API | Switched off at your request (`reed.enabled: false` in config.json). Code kept; set it to true to turn it back on |
| Greenhouse / Ashby / Lever (fintech and AI companies) | Company board API | Live |
| Workday (Barclays, FIS/Worldpay, Mastercard, Deutsche Bank, Nasdaq, S&P Global, Salesforce) | Company board API | Live (rate-limited, one request at a time) |
| Indeed, Workable, SmartRecruiters, Workday, Greenhouse (any employer) | Aggregator (Firecrawl `jobs_search`, ~30 credits per search) | Live: 12 role searches × London / Southampton / Reading / remote-UK, 900-credit daily budget |
| LinkedIn job listings | Aggregator (Apify `valig/linkedin-jobs-scraper`, ~$0.02 per search, 10 searches a day) | Live |
| LinkedIn, Indeed alerts | Email alert + manual + browser-assisted | `/ingest-linkedin`, `/ingest-indeed`, `/ingest-alerts`; never scraped |
| Totaljobs, CV-Library, CWJobs | Email alert + manual | `/ingest-alerts`, `/ingest-job`; never scraped |
| Any other job page / PDF / screenshot / CSV | Manual | `/ingest-job` |

## Daily run (scheduled, weekdays 07:45 Europe/London)

`DAILY.md` is the routine the scheduled Claude session follows:
1. Pull alert emails (when Gmail is connected).
2. `hunt.py`: collect, de-duplicate (company + title + location), enrich, auto-score.
3. Full grading against `profile.md`.
4. `package.py` builds an apply-ready package for each A/B/C role.
5. Commit `job-hunt/data/`.
6. Push notification and Gmail digest.

Outputs: `data/latest/` (today) and `data/runs/<date>/`: `results.json`, `digest.md`, `digest.html`, `summary.md`, `health.json`. All jobs: `data/jobs.jsonl`. Seen-before keys: `data/seen.json`.

## Files

| File | What it does |
|---|---|
| `hunt.py` | Collector: sources, retries (3), source health (source, URL, status, timestamp), de-duplication, enrichment, auto-score, seen store |
| `fit.py` | Deterministic first-pass scoring: hard gates, evidence groups (0–4), learnable vs hard gaps, ambition, tier |
| `fit_policy.md` | The full grading policy Claude applies to the top roles |
| `digest.py` | Renders the digest; `--grades` merges Claude's full grades |
| `ingest.py` | Adds jobs from URLs (public ATS APIs / robots-allowed pages), pasted text, alert emails, PDFs and CSVs |
| `package.py` | Tailored CV + cover letter (PDF + DOCX) from `master_cv.json` bullet ids only; checks numbers, unclaimable skills, page count and ATS text |
| `assist_apply.mjs` | Run on your own computer: opens the form, fills approved fields, uploads the package, screenshots, stops before Submit |
| `track.py` | Application status (`submitted` is recorded only by you), follow-ups, `today` |
| `profile.md`, `master_cv.json`, `answers.json` | Candidate facts (source of truth), CV bullets, approved form answers |

## Commands (Claude Code, in this repo)

`/apply-today` · `/ingest-job <url or text>` · `/ingest-linkedin` · `/ingest-indeed` · `/ingest-alerts` · `/package-job <job_id>` · `/assist-apply <job_id>`

## Rules built in

Never auto-submit. Never solve CAPTCHAs. Never guess visa, salary, background-check or eligibility answers. No proxies or multiple accounts. Never fetch LinkedIn, Indeed, Totaljobs, CV-Library, CWJobs or Glassdoor pages. Never claim experience that is not in `master_cv.json`. This lives on its own `autoline` branch, separate from the ballknw.com website code.
