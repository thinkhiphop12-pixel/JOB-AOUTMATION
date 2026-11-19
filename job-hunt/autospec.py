#!/usr/bin/env python3
"""Write a package spec for a job from templates (facts only from master_cv.json), then build it.

  python3 job-hunt/autospec.py JOB_ID [JOB_ID ...]      # specific jobs
  python3 job-hunt/autospec.py --all-abc                # every A/B/C job in data/latest without a package

Used for volume. For a top-priority role the daily session can still write a hand-tailored spec
(see .claude/commands/package-job.md); package.py validates both the same way.
"""
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")


def family(title):
    t = title.lower()
    if any(k in t for k in ["customer success", "client success", "account manager", "client onboarding", "onboarding",
                            "relationship", "client service", "partner", "enablement", "adoption"]):
        return "customer"
    if any(k in t for k in ["change", "implementation", "transformation"]):
        return "change"
    if any(k in t for k in ["analyst", "reporting", "insight", "data"]):
        return "analyst"
    if any(k in t for k in ["programme", "program ", "director", "strategy", "head of", "pmo"]):
        return "programme"
    return "project"


def spec_for(job):
    title, co = job["title"].strip(), job["company"].strip()
    fam = family(title)
    public = job.get("public_sector")
    gaps = (job.get("fit", {}).get("learnable_gaps") or [])
    gap = gaps[0] if gaps else ("the sector" if public else "your tools and ways of working")
    hooks = {
        "customer": "This role is about helping customers adopt and get value from what they have bought",
        "change": "This role is about leading change that people actually adopt",
        "analyst": "This role needs someone who turns messy data into clear decisions",
        "programme": "This role needs someone who can run complex programmes with clear governance across many teams",
        "project": "This role needs a project manager who keeps many teams working to one plan and delivers to fixed deadlines",
    }
    p1 = (f"I am applying for the {title} role at {co}. {hooks[fam]}. For 5 years at Global Blue, part of Shift4, a regulated, "
          "multi-country payments business, I have done exactly that, and I have been promoted three times in four years.")
    if fam == "customer":
        p2 = ("For six months I was interim account manager for three global brands: Dyson, Fred Perry and UGG. I wrote the client onboarding "
              "playbook and country checklists that two global account teams adopted as standard and extended to new markets such as Peru, "
              "and I got account managers onto new Salesforce reporting by fixing their problems one by one.")
        p3 = ("I work inside account teams with sales and technical colleagues across ~40 countries. I fixed a five-month invoice reporting "
              "failure for a major retail client by tracing the fault across three systems and coordinating four system owners, and I run "
              "training and briefings for account managers, country teams and new starters.")
    elif fam == "analyst":
        p2 = ("I cut a monthly 350,000-row report build from hours to minutes by automating it and documented the seven-source data chain. "
              "I built issue-ratio and eligibility monitoring reports in Salesforce that are now used in every monthly business review, and "
              "50+ commercial pricing models across 40 brands.")
        p3 = ("I produce monthly business reviews and Town Hall packs for senior leadership, including the Shift4 executive team, and I keep "
              "a ~600-account international master list accurate for account managers in ~40 countries.")
    else:
        p2 = ("I prepared 38 international brands, managed from 10 countries, for Japan's 2026 VAT reform, with new contracts agreed before the "
              "legal deadline, by setting scope, milestones and dependencies. For France's mandatory e-invoicing I tracked the readiness of "
              "100+ merchants and ran the risk log, and I delivered a 671-store account update inside a fixed system release window.")
        p3 = (("Most of my work is about getting people to change how they work: I got account managers onto new Salesforce reporting by "
               "fixing their problems one by one, I run training for account managers, country teams and new starters, and I wrote the "
               "onboarding playbook that two global account teams adopted as standard.") if fam == "change" else
              ("I run a 25-country governance review cycle with every review held on schedule, produce the monthly business reviews and Town "
               "Hall packs for senior leadership, including the Shift4 executive team, and escalate risks to accountable owners with clear "
               "decision packs."))
    p4 = ("I hold the AgilePM® v3 Practitioner certificate and an MA from the University of Sheffield, and I live in Southampton. "
          + ("I want to bring this experience to an organisation that serves the public; at university I sat on the board of a homeless "
             "outreach society. " if public else "")
          + f"I would put early effort into learning {gap}, while bringing delivery discipline from a regulated environment.")
    p5 = "I would welcome the chance to discuss the role."
    bullets = {
        "customer": ["adoption", "training", "invoice-fix", "subs-1000", "mbr-exec", "japan-vat", "pricing-50", "claude-system"],
        "change": ["adoption", "training", "japan-vat", "france-einv", "governance-25", "stores-671", "mbr-exec", "invoice-fix"],
        "analyst": ["report-350k", "pricing-50", "master-600", "mbr-exec", "invoice-fix", "claude-system", "governance-25", "subs-1000"],
        "programme": ["japan-vat", "france-einv", "governance-25", "stores-671", "mbr-exec", "invoice-fix", "report-350k", "training"],
        "project": ["japan-vat", "france-einv", "stores-671", "governance-25", "invoice-fix", "report-350k", "mbr-exec", "training"],
    }[fam]
    ssm = ["interim-am", "playbook", "monitoring", "commission-fix"] if fam == "customer" else ["playbook", "mass-updates", "remapping", "monitoring"]
    variant = {"customer": "customer-success", "analyst": "analyst"}.get(fam, "project-delivery")
    summary = {
        "customer": ("Account and adoption professional with 5 years in a regulated, multi-country payments business (Global Blue, part of Shift4), "
                     "promoted three times in four years. Interim account manager for three global brands, author of the onboarding playbook two "
                     "global account teams adopted, and the person who gets busy teams and clients to adopt new tools. Works across sales, product "
                     "and technical teams in ~40 countries."),
        "analyst": ("Data analyst and project manager with 5 years in a regulated, multi-country payments business (Global Blue, part of Shift4), "
                    "promoted three times in four years. Automates reporting, keeps master data accurate across ~40 countries and turns messy data "
                    "into clear decisions for senior leadership."),
    }.get(fam, ("AgilePM® Practitioner with 5 years in a regulated, multi-country payments business (Global Blue, part of Shift4), promoted three "
                "times in four years. Delivers change to fixed legal deadlines, including Japan's 2026 VAT reform and France's mandatory "
                "e-invoicing, by setting clear scope, managing risk and keeping teams in many countries working to one plan. "
                + ("Now wants to bring this to an organisation that serves the public." if public else "")))
    skills = (["Account management", "Customer onboarding", "Adoption and change", "Training and enablement", "Playbooks", "Stakeholders in ~40 countries",
               "Salesforce", "Project delivery", "Excel (macros)", "Power Automate", "Claude and Claude Code"] if fam == "customer" else
              ["Project delivery", "RAID and dependencies", "Governance", "Regulatory change", "Stakeholders in ~40 countries", "Adoption and change",
               "Training and enablement", "AgilePM", "Salesforce", "MicroStrategy", "Excel (macros)", "Power Automate", "Claude and Claude Code"])
    letter = [p1, p2, p3, p4, p5]
    return {"variant": variant, "summary": summary.strip(), "skills": skills,
            "bullets": {"gb-dapm": bullets, "gb-ssm": ssm, "gb-ss": ["ss-summary"]}, "cover_letter": letter,
            "answers": {"Supporting information": " ".join(letter[:4]),
                        f"Why {co}?": ("I want to use my delivery experience in an organisation that serves the public." if public else
                                       f"The role at {co} builds directly on the delivery and adoption work I do now, in a place where I can grow.")}}


def main():
    jobs = {j["job_id"]: j for j in json.load(open(os.path.join(DATA, "latest", "results.json")))}
    args = sys.argv[1:]
    if args == ["--all-abc"]:
        ids = [i for i, j in jobs.items() if j["fit"]["tier"] in "ABC" and not os.path.exists(os.path.join(DATA, "applications", i, "status.json"))]
    else:
        ids = args
    ok = bad = 0
    for i in ids:
        if i not in jobs:
            print(f"{i}: not in data/latest/results.json"); continue
        sp = f"/tmp/autospec-{i}.json"
        json.dump(spec_for(jobs[i]), open(sp, "w"), indent=1)
        r = subprocess.run([sys.executable, os.path.join(HERE, "package.py"), "--job", i, "--spec", sp], capture_output=True, text=True)
        try:
            res = json.loads(r.stdout.strip().splitlines()[-1])
        except Exception:
            res = {"status": "error", "errors": [r.stderr[-200:]]}
        ok += res.get("status") == "ready_for_review"
        bad += res.get("status") != "ready_for_review"
        print(f"{i} {res.get('status')} {jobs[i]['title'][:50]} | {jobs[i]['company'][:30]} {res.get('errors', [])[:2]}")
    print(json.dumps({"built": ok, "failed": bad}))


if __name__ == "__main__":
    main()
