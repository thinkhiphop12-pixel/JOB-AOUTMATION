---
description: Open a job's application form in my browser, pre-fill approved fields, upload the package, stop before Submit
argument-hint: <job_id>
---
This needs my own computer (it opens a real browser window). If this session runs in the cloud, tell me to run it locally instead:

```bash
cd job-hunt && npm install playwright@1.49.1 && node assist_apply.mjs $ARGUMENTS
```

When run locally: check job-hunt/data/applications/$ARGUMENTS/status.json is ready_for_review (build it with /package-job if not), then run the command above. It fills only answers.json entries marked approved, uploads cv.pdf and cover_letter.pdf, writes form.png and field_map.json, and stops. Show me the "Needs you" list. I click Submit myself. Never click Submit, never solve a CAPTCHA, never answer visa, salary, background-check or eligibility questions.
