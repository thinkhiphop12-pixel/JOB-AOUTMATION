#!/usr/bin/env python3
"""Application tracker.

  python3 job-hunt/track.py list                      # every application and its status
  python3 job-hunt/track.py submitted JOB_ID          # after YOU clicked Submit
  python3 job-hunt/track.py response JOB_ID "note"    # recruiter replied
  python3 job-hunt/track.py interview JOB_ID "stage"
  python3 job-hunt/track.py offer|rejected|no_response|withdrawn JOB_ID ["note"]
  python3 job-hunt/track.py today                     # what to apply to today (ranked)

Status flow: draft -> ready_for_review -> filled (browser assistant) -> submitted (by you)
-> response -> interview -> offer / rejected / no_response / withdrawn.
Nothing in this system submits an application. "submitted" is only ever recorded by you.
"""
import datetime as dt
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.environ.get("AUTOLINE_DATA", os.path.join(HERE, "data"))
APPS = os.path.join(DATA, "applications")
FLOW = ["draft", "ready_for_review", "filled", "submitted", "response", "interview", "offer", "rejected",
        "no_response", "withdrawn"]


def load(job_id):
    p = os.path.join(APPS, job_id, "status.json")
    if not os.path.exists(p):
        sys.exit(f"No application for {job_id}. Build one with package.py first.")
    return p, json.load(open(p))


def set_status(job_id, status, note=""):
    p, st = load(job_id)
    st["status"] = status
    st.setdefault("history", []).append({"status": status, "at": dt.datetime.now().isoformat(timespec="seconds"), "note": note})
    if status == "submitted":
        st["followup_due"] = (dt.date.today() + dt.timedelta(days=7)).isoformat()
    json.dump(st, open(p, "w"), indent=1)
    print(f"{st['title']}, {st['company']}: {status}" + (f" (follow up on {st['followup_due']})" if status == "submitted" else ""))


def all_apps():
    if not os.path.isdir(APPS):
        return []
    out = []
    for d in sorted(os.listdir(APPS)):
        p = os.path.join(APPS, d, "status.json")
        if os.path.exists(p):
            out.append(json.load(open(p)))
    return out


def today(minimum=10):
    """Top roles to act on: today's new A/B/C first, topped up to `minimum` from the unapplied backlog."""
    latest = os.path.join(DATA, "latest", "results.json")
    new = json.load(open(latest)) if os.path.exists(latest) else []
    pool = {}
    jl = os.path.join(DATA, "jobs.jsonl")
    if os.path.exists(jl):
        for line in open(jl):
            try:
                j = json.loads(line)
                pool[j["job_id"]] = j
            except Exception:
                pass
    for j in new:
        pool[j["job_id"]] = j
    apps = {a["job_id"]: a for a in all_apps()}
    done = ("submitted", "response", "interview", "offer", "rejected", "withdrawn", "closed")
    new_ids = {j["job_id"] for j in new}
    cands = [j for j in pool.values() if j.get("fit", {}).get("tier") in ("A", "B", "C")
             and apps.get(j["job_id"], {}).get("status") not in done]
    cands.sort(key=lambda j: (j["job_id"] not in new_ids, "ABC".index(j["fit"]["tier"]), -j.get("priority", 0)))
    pick = cands[:max(minimum, sum(1 for j in cands if j["job_id"] in new_ids))]
    print(f"# Your top {len(pick)} jobs today ({dt.date.today():%a %d %b})\n")
    for n, j in enumerate(pick, 1):
        f = j["fit"]
        a = apps.get(j["job_id"], {})
        tag = "NEW " if j["job_id"] in new_ids else ""
        flags = (" · public sector" if j.get("public_sector") else "") + (" · near Southampton" if j.get("near_southampton") else "")
        sal = (f"£{round((j.get('salary_max') or j.get('salary_min'))/1000)}k" if (j.get("salary_max") or j.get("salary_min")) else "salary not stated")
        state = {"you_apply": "apply yourself: package ready", "local_ready": "ready to submit from your computer", "ready_for_review": "package ready",
                 "needs_you": "needs you: " + (a.get("note") or "see checklist")[:60], "filled": "form filled"}.get(a.get("status"), "no package yet")
        print(f"{n}. {tag}[{f['tier']}] {j['title'].strip()}, {j['company']} · {sal} · {j['location'][:35]}{flags}\n"
              f"   {f.get('why_worth_it') or ', '.join(f.get('matched', [])[:1])[:120]}\n   Status: {state} · {j.get('apply_url') or j['url']}")
    due = [a for a in apps.values() if a.get("status") == "submitted" and a.get("followup_due", "9") <= dt.date.today().isoformat()]
    if due:
        print("\nFollow-ups due:")
        for a in due:
            print(f"- {a['title']}, {a['company']} (submitted, no reply yet)")


def main():
    if len(sys.argv) < 2 or sys.argv[1] == "list":
        for a in all_apps():
            print(f"{a['status']:<16} {a['tier']}  {a['title']}, {a['company']}  [{a['job_id']}]  {a['url']}")
        return
    cmd = sys.argv[1]
    if cmd == "today":
        return today(int(sys.argv[2]) if len(sys.argv) > 2 else 10)
    if cmd in FLOW and len(sys.argv) >= 3:
        return set_status(sys.argv[2], cmd, " ".join(sys.argv[3:]))
    sys.exit(__doc__)


if __name__ == "__main__":
    main()
