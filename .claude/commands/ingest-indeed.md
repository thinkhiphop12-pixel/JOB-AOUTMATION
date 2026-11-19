---
description: Bring Indeed jobs into Autoline from saved jobs, alert emails or pasted listings (no scraping)
argument-hint: [job URLs, pasted listings, or "from email"]
---
Bring Indeed jobs into Autoline without scraping Indeed: $ARGUMENTS

Indeed forbids bots, so never fetch indeed.co.uk pages and never drive my Indeed session.

- If I pasted job descriptions or listings: for each one, follow /ingest-job (text mode, --source Indeed).
- If I pasted only links: list them back and ask me to paste each description (Indeed "Full job description" text), then ingest each.
- If I said "from email" and a Gmail tool is available: search Gmail for `from:(alert@indeed.com OR donotreply@jobalert.indeed.com) newer_than:7d`, save each message's HTML body to a temp .html file, and run `python3 job-hunt/ingest.py email --file FILE` on each.
- If I attached a CSV (e.g. from a saved-jobs export or a spreadsheet I keep): `python3 job-hunt/ingest.py csv --file FILE --source Indeed`.
- On my own computer, a browser-assisted path works too: I open my saved jobs in my normal browser and copy each job's text in; you never automate the Indeed tab.

Finish with a ranked list of what was added (fit-policy grade, salary, office days, link). Commit the inbox files under job-hunt/data/inbox/ and push so the next daily digest includes them.
