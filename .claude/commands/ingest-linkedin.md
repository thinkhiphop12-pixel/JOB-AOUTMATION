---
description: Bring LinkedIn jobs into Autoline from saved jobs, alert emails or pasted listings (no scraping)
argument-hint: [job URLs, pasted listings, or "from email"]
---
Bring LinkedIn jobs into Autoline without scraping LinkedIn: $ARGUMENTS

LinkedIn forbids bots, so never fetch linkedin.com pages and never drive my LinkedIn session.

- If I pasted job descriptions or listings: for each one, follow /ingest-job (text mode, --source LinkedIn).
- If I pasted only links: list them back and ask me to paste each description (LinkedIn "About the job" text), then ingest each.
- If I said "from email" and a Gmail tool is available: search Gmail for `from:jobalerts-noreply@linkedin.com newer_than:7d` (and `from:jobs-listings@linkedin.com`), save each message's HTML body to a temp .html file, and run `python3 job-hunt/ingest.py email --file FILE` on each.
- If I attached a CSV (e.g. from a saved-jobs export or a spreadsheet I keep): `python3 job-hunt/ingest.py csv --file FILE --source LinkedIn`.
- On my own computer, a browser-assisted path works too: I open my saved jobs in my normal browser and copy each job's text in; you never automate the LinkedIn tab.

Finish with a ranked list of what was added (fit-policy grade, salary, office days, link). Commit the inbox files under job-hunt/data/inbox/ and push so the next daily digest includes them.
