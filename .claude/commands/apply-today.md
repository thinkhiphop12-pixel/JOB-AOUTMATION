---
description: What should I apply to today? Ranked, decision-ready list from the latest Autoline run
---
1. `git fetch origin main && git merge --ff-only FETCH_HEAD` (pick up the latest daily run).
2. Run `python3 job-hunt/track.py today` and read job-hunt/data/latest/results.json.
3. Give me a ranked list of the A/B/C roles I have not applied to yet: tier, decision, title, company, salary, location, office days, core fit / ambition, one line on why, the main learnable gap, package status, and the apply link. Put A first.
4. Then list follow-ups due and anything closing soon.
5. Offer: build packages for the top ones (/package-job) and, on my computer, open them with the browser assistant (/assist-apply).
