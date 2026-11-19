---
description: Build a tailored CV + cover letter package for a job (validated, never fabricated)
argument-hint: <job_id> [more job_ids]
---
Build application packages for: $ARGUMENTS

For each job_id (find it in job-hunt/data/latest/results.json or job-hunt/data/jobs.jsonl):
1. Read the job description, job-hunt/fit_policy.md, job-hunt/profile.md and job-hunt/master_cv.json.
2. Write spec.json as documented at the top of job-hunt/package.py:
   - variant: project-delivery / customer-success / analyst
   - summary: 3-4 sentences aimed at this role, using only facts in master_cv.json
   - skills: ordered subset of master_cv.json skills, most relevant first
   - bullets: choose and order existing bullet ids per role (most relevant first; 6-9 for the current role)
   - cover_letter: 4 paragraphs, 250-380 words; names the company and role; leads with the strongest evidence; names one learnable gap honestly ("I am building my SQL")
   - answers: draft answers to likely form questions ("Why X?"), facts only
   Never claim anything in master_cv.json "not_claimable", never invent numbers, never change dates.
3. Run `python3 job-hunt/package.py --job JOB_ID --spec spec.json`. If validation fails, fix the spec and re-run until status is ready_for_review.
4. Commit job-hunt/data/applications/JOB_ID/ and push. Show me the checklist.md and where the PDFs are.
