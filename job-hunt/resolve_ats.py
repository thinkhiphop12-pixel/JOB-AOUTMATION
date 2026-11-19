#!/usr/bin/env python3
"""Find a LinkedIn-listed role on the employer's own Greenhouse / Ashby / Lever board (free public APIs),
so auto_apply can use the real application form.   python3 job-hunt/resolve_ats.py [JOB_ID ...]"""
import json, os, re, sys, urllib.request, glob
HERE = os.path.dirname(os.path.abspath(__file__)); DATA = os.path.join(HERE, "data")
UA = {"User-Agent": "personal-job-digest/1.0"}
KNOWN = {"truelayer": ("ashby", "truelayer"), "risk ledger": ("greenhouse-eu", "riskledger"), "sigma": ("greenhouse", "sigmacomputing")}

def get(url):
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=20) as r: return json.loads(r.read())
    except Exception: return None

def words(s): return set(re.findall(r"[a-z]{3,}", s.lower())) - {"the", "and", "for", "uk", "emea", "london", "hybrid", "based"}

def candidates(company):
    base = re.sub(r"\b(ltd|limited|plc|inc|group|global|technologies|uk|cic|the)\b", "", company.lower())
    s = re.sub(r"[^a-z0-9]", "", base)
    return list(dict.fromkeys([s, s + "hq", s + "inc", s + "careers", re.sub(r"[^a-z0-9]", "-", base.strip()).strip("-")]))

def boards(company):
    k = company.lower().strip()
    if k in KNOWN: yield KNOWN[k]
    for slug in candidates(company):
        for kind in ("greenhouse", "greenhouse-eu", "ashby", "lever"): yield (kind, slug)

def jobs_on(kind, slug):
    if kind == "greenhouse": d = get(f"https://boards-api.greenhouse.io/v1/boards/{slug}/jobs"); return [(j["title"], j["absolute_url"], (j.get("location") or {}).get("name", "")) for j in (d or {}).get("jobs", [])]
    if kind == "greenhouse-eu": d = get(f"https://boards-api.eu.greenhouse.io/v1/boards/{slug}/jobs"); return [(j["title"], j["absolute_url"], (j.get("location") or {}).get("name", "")) for j in (d or {}).get("jobs", [])]
    if kind == "ashby": d = get(f"https://api.ashbyhq.com/posting-api/job-board/{slug}"); return [(j["title"], j["jobUrl"], j.get("location", "")) for j in (d or {}).get("jobs", [])]
    if kind == "lever": d = get(f"https://api.lever.co/v0/postings/{slug}?mode=json"); return [(j["text"], j["hostedUrl"], j.get("categories", {}).get("location", "")) for j in (d or [])] if isinstance(d, list) else []
    return []

def resolve(company, title):
    tw = words(title)
    for kind, slug in boards(company):
        js = jobs_on(kind, slug)
        if not js: continue
        best = max(js, key=lambda x: (len(tw & words(x[0])) / max(1, len(tw)), "london" in x[2].lower() or "uk" in x[2].lower()))
        score = len(tw & words(best[0])) / max(1, len(tw))
        return (kind, slug, best, score) if score >= 0.6 else (kind, slug, None, score)
    return None

if __name__ == "__main__":
    ids = sys.argv[1:]
    out = {}
    for p in glob.glob(os.path.join(DATA, "applications", "*", "status.json")):
        st = json.load(open(p))
        if ids and st["job_id"] not in ids: continue
        if "linkedin.com" not in st["url"] or st["tier"] not in "ABC": continue
        r = resolve(st["company"], st["title"])
        if r and r[2]:
            st["linkedin_url"], st["url"] = st["url"], r[2][1]
            st["status"] = "ready_for_review"; st["note"] = f"employer board found: {r[0]}/{r[1]}"
            json.dump(st, open(p, "w"), indent=1)
            print(f"FOUND  {st['company'][:28]:28} {st['title'][:40]:40} -> {r[2][1]}")
        else:
            print(f"none   {st['company'][:28]:28} {st['title'][:40]:40} {'(board ' + r[0] + '/' + r[1] + ', no matching role)' if r else ''}")
