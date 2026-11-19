#!/usr/bin/env python3
"""Autoline collector: find, enrich, de-duplicate and auto-score UK roles.

Sources (each labelled in the source-health report)
  API            Reed jobseeker API (Basic auth: key as username, empty password; key from
                 REED_API_KEY, or injected by the cloud network proxy)
  Company board  Greenhouse / Ashby / Lever / Workday public job APIs for the watchlist
  Email alert    LinkedIn / Indeed / Totaljobs / CV-Library / CWJobs alert emails, turned into
                 inbox files by the daily session (see DAILY.md) or by ingest.py
  Manual         URLs / pasted descriptions / CSV added with ingest.py

Usage
  python3 job-hunt/hunt.py                     # daily run: new roles since the last run
  python3 job-hunt/hunt.py --days 30           # look back further
  python3 job-hunt/hunt.py --only reed         # one source (reed, boards, workday, inbox)
Outputs go to job-hunt/data/latest/ and job-hunt/data/runs/<date>/:
  results.json (every new relevant job, scored), digest.md, digest.html, health.json
Exit code 2 when every live source failed.
"""
import argparse
import base64
import datetime as dt
import hashlib
import html
import json
import os
import re
import shutil
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import fit  # noqa: E402
import digest  # noqa: E402

UA = "personal-job-digest/1.0"
TODAY = dt.date.today()


def now():
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ---------------------------------------------------------------- source health + http
class Health:
    def __init__(self):
        self.sources = {}

    def src(self, name, kind):
        return self.sources.setdefault(name, {"name": name, "kind": kind, "status": "ok", "requests": 0,
                                              "jobs_found": 0, "jobs_kept": 0, "errors": [], "note": ""})

    def fail(self, name, url, status, error):
        s = self.sources[name]
        s["errors"].append({"url": redact(url), "status": status, "error": str(error)[:200], "ts": now()})

    def finish(self, name, fatal=False):
        s = self.sources[name]
        if fatal:
            s["status"] = "failed"
        elif s["errors"]:
            s["status"] = "partial"

    def all_live_failed(self):
        live = [s for s in self.sources.values() if s["kind"] in ("API", "Company board", "Aggregator") and s["status"] != "disabled"]
        return bool(live) and all(s["status"] == "failed" for s in live)


def redact(url):
    return re.sub(r"(app_key|api_key|key)=[^&]+", r"\1=***", url)


def http(health, source, url, headers=None, body=None, retries=3):
    """GET (or POST when body is given) JSON with 3 tries; 429/5xx/network errors back off."""
    data = json.dumps(body).encode() if body is not None else None
    hdrs = {"User-Agent": UA, "Accept": "application/json", **(headers or {})}
    if data is not None:
        hdrs["Content-Type"] = "application/json"
    last = None
    for attempt in range(retries):
        health.sources[source]["requests"] += 1
        try:
            req = urllib.request.Request(url, data=data, headers=hdrs)
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.loads(r.read().decode("utf-8", "replace"))
        except urllib.error.HTTPError as e:
            last = (e.code, e.reason)
            if e.code in (400, 401, 403, 404):
                break
            time.sleep((15 if e.code == 429 else 3) * (attempt + 1))
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as e:
            last = (None, e)
            time.sleep(3 * (attempt + 1))
    health.fail(source, url, last[0], last[1])
    raise RuntimeError(f"{source}: {last[0]} {last[1]}")


def strip_html(s):
    s = re.sub(r"<(br|/p|/li|/h\d|/div)[^>]*>", "\n", s or "", flags=re.I)
    s = re.sub(r"<li[^>]*>", "\n• ", s, flags=re.I)
    s = re.sub(r"<[^>]+>", " ", s)
    s = html.unescape(s)
    s = re.sub(r"[ \t\xa0]+", " ", s)
    return re.sub(r"\n\s*\n+", "\n", s).strip()


# ---------------------------------------------------------------- classification helpers
NUM = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "1": 1, "2": 2, "3": 3, "4": 4, "5": 5}
N = r"(one|two|three|four|five|[1-5])"
DAY_PATTERNS = [
    rf"{N}(?:\s*(?:-|to|or)\s*{N})?\s*days?\s*(?:a|per|each|every)?\s*week\s*(?:in|at|from|on)\s*(?:the|our)?\s*(?:office|site|hub)",
    rf"{N}(?:\s*(?:-|to|or)\s*{N})?\s*days?\s*(?:a|per|each|every)?\s*week\s*(?:office|onsite|on-site|in-person|in person)",
    rf"{N}(?:\s*(?:-|to|or)\s*{N})?\s*days?\s*(?:in|at)\s*(?:the|our)?\s*(?:office|hub|site)",
    rf"(?:office|onsite|on-site|in-person|in person)\s*(?:for|attendance of|presence of)?\s*{N}(?:\s*(?:-|to|or)\s*{N})?\s*days",
    rf"{N}(?:\s*(?:-|to|or)\s*{N})?\s*days?\s*(?:a|per)\s*week\s*(?:hybrid|onsite|on-site)",
    rf"hybrid\s*\(?\s*{N}(?:\s*(?:-|to|or)\s*{N})?\s*days",
]


def work_pattern(text):
    """ok (<=2 days / remote), maybe (not stated), three (3 days), exclude (4-5 days)."""
    t = text.lower()
    found = []
    for p in DAY_PATTERNS:
        for m in re.finditer(p, t):
            nums = [NUM[g] for g in m.groups() if g]
            if nums:
                found.append((min(nums), max(nums)))
    if found:
        lo, hi = min(f[0] for f in found), max(f[1] for f in found)
        label = f"{lo}-{hi} days in office" if lo != hi else f"{hi} day{'s' if hi > 1 else ''} in office"
        if hi <= 2 or lo <= 2:
            return "ok", label
        return ("three", label) if lo == 3 else ("exclude", label)
    if re.search(r"fully remote|100% remote|remote[- ]first|home[- ]based role|remote \(uk\)|remote, uk|uk remote|workplace: remote", t):
        return "ok", "remote / mostly home"
    if re.search(r"once a week|one day a week|monthly|once a month|quarterly|occasional (?:office|travel)", t):
        return "ok", "occasional office"
    if re.search(r"office[- ]based|on[- ]site role|5 days a week in|five days|full[- ]time in (?:the )?office", t):
        return "exclude", "office based"
    if "hybrid" in t or "flexible working" in t:
        return "maybe", "hybrid (days not stated)"
    return "maybe", "office pattern not stated"


def title_ok(cfg, title):
    tl = title.lower()
    return not any(x in tl for x in cfg["title_exclude"]) and any(x in tl for x in cfg["title_include"])


def desc_blocked(cfg, text):
    return any(x.lower() in text.lower() for x in cfg["description_exclude"])


def salary_from_text(text):
    vals = []
    for m in re.finditer(r"(?:£|GBP)\s?(\d{2,3}),(\d{3})\s*(?:-|–|to)\s*(?:£|GBP)?\s?(\d{2,3}),(\d{3})", text or ""):
        vals += [int(m.group(1)) * 1000 + int(m.group(2)), int(m.group(3)) * 1000 + int(m.group(4))]
    for m in re.finditer(r"(?:£|GBP)\s?(\d{2,3})(?:,(\d{3})|(\.\d)?\s?[kK])", text or ""):
        v = int(m.group(1)) * 1000 + (int(m.group(2)) if m.group(2) else 0)
        if 25000 <= v <= 400000:
            vals.append(v)
    return (min(vals), max(vals)) if vals else (None, None)


NEAR = {"london", "southampton", "reading", "guildford", "winchester", "basingstoke", "portsmouth", "bournemouth",
        "hampshire", "remote", "eastleigh", "fareham", "chichester", "salisbury", "poole", "newbury", "farnborough",
        # London-Southampton corridor (M3 / South Western line)
        "woking", "surrey", "berkshire", "bracknell", "camberley", "fleet", "farnham", "aldershot", "weybridge",
        "staines", "hook", "alton", "andover", "wokingham", "leatherhead", "kingston", "richmond", "twickenham"}
FAR = {"birmingham", "manchester", "edinburgh", "glasgow", "leeds", "cardiff", "belfast", "bristol", "newcastle",
       "liverpool", "sheffield", "nottingham", "dublin"}


US = {"us", "usa", "america", "nyc", "york", "california", "illinois", "chicago", "francisco", "seattle", "texas",
      "boston", "austin", "denver", "atlanta", "toronto", "canada", "singapore", "sydney", "india", "bangalore",
      "states", "dc", "georgia", "tx", "ny", "nj", "ca", "co", "ga", "sc", "dubai", "emirates", "uae", "arab",
      "latam", "amer", "mexico", "brazil", "australia", "japan", "tokyo", "paris", "france", "germany", "berlin",
      "munich", "madrid", "spain", "milan", "italy", "amsterdam", "netherlands", "stockholm", "warsaw", "poland",
      "lisbon", "portugal", "zurich", "riyadh", "saudi", "tel", "aviv", "israel"}


def _uk_signal(loc):
    l = (loc or "").lower()
    return bool(re.search(r"united kingdom|\buk\b|\bu\.k\.|england|britain|\bgb\b|\bemea\b|\beurope\b", l))


def loc_ok(cfg, loc):
    """London / Southampton commuting belt / remote-UK. 'Remote' alone only counts with a UK or EMEA signal."""
    # Multi-location strings ("Atlanta; Remote - SC", "London; New York") count if ANY part is in the area.
    parts = [p for p in re.split(r"[;|/]|\bor\b", (loc or "").lower()) if p.strip()] or [""]
    for part in parts:
        words = set(re.findall(r"[a-z]+", part))
        if words & (NEAR - {"remote"}):
            return True
        if _uk_signal(part) and not (words & FAR):
            return True
    return False


def salary_floor(cfg, loc):
    l = (loc or "").lower()
    near_home = any(x in l for x in NEAR - {"london"}) or "home" in l
    if "london" in l and not near_home:
        return cfg.get("min_salary_london", cfg["min_salary"])
    return cfg["min_salary"]


def ats_platform(url):
    u = (url or "").lower()
    for key, name in [("greenhouse", "Greenhouse"), ("ashbyhq", "Ashby"), ("lever.co", "Lever"),
                      ("myworkdayjobs", "Workday"), ("smartrecruiters", "SmartRecruiters"), ("workable", "Workable"),
                      ("teamtailor", "Teamtailor"), ("reed.co.uk", "Reed"), ("linkedin", "LinkedIn"),
                      ("indeed", "Indeed"), ("totaljobs", "Totaljobs"), ("cv-library", "CV-Library"),
                      ("cwjobs", "CWJobs"), ("icims", "iCIMS"), ("successfactors", "SuccessFactors")]:
        if key in u:
            return name
    return "Company site" if u else "Unknown"


def norm(s):
    s = (s or "").lower()
    s = re.sub(r"\b(ltd|limited|plc|inc|llc|group|uk|the)\b", " ", s)
    s = re.sub(r"\(.*?\)|[-–—|/,]+.*$", " ", s) if len(s) > 60 else s
    return re.sub(r"[^a-z0-9]+", " ", s).strip()


def canonical_key(company, title, location):
    loc = "london" if "london" in (location or "").lower() else norm(location).split(" ")[0] if location else ""
    return f"{norm(company)}::{norm(title)}::{loc}"


# ---------------------------------------------------------------- sources
def reed_headers():
    key = os.environ.get("REED_API_KEY", "proxy-injected")
    return {"Authorization": "Basic " + base64.b64encode(f"{key}:".encode()).decode()}


def src_reed(cfg, since, health, cache_dir):
    name = "Reed"
    health.src(name, "API")
    if not cfg["reed"].get("enabled", True):
        health.sources[name].update(status="disabled", note="disabled in config.json")
        return []
    found = {}
    # one probe first so a bad key fails fast instead of 50 times
    try:
        http(health, name, "https://www.reed.co.uk/api/1.0/search?keywords=manager&resultsToTake=1", reed_headers(),
             retries=1)
    except RuntimeError as e:
        health.sources[name]["note"] = ("401: Reed rejected the API key (Basic auth, key as username, empty password)"
                                        if "401" in str(e) else str(e))
        health.finish(name, fatal=True)
        return []
    for loc in cfg["reed"]["locations"]:
        for kw in cfg["reed"]["keywords"]:
            skip = 0
            while skip < 200:
                q = urllib.parse.urlencode({"keywords": kw, "locationName": loc["name"],
                                            "distanceFromLocation": loc["miles"],
                                            "minimumSalary": loc.get("min_salary", cfg["min_salary"]),
                                            "resultsToTake": 100, "resultsToSkip": skip})
                try:
                    data = http(health, name, f"https://www.reed.co.uk/api/1.0/search?{q}", reed_headers())
                except RuntimeError:
                    break
                results = data.get("results", [])
                for r in results:
                    try:
                        posted = dt.datetime.strptime(r["date"], "%d/%m/%Y").date()
                    except (KeyError, ValueError):
                        posted = TODAY
                    if posted >= since:
                        found.setdefault(r["jobId"], {**r, "_posted": posted})
                skip += len(results)
                if not results or skip >= data.get("totalResults", 0):
                    break
                time.sleep(0.4)
            time.sleep(0.4)
    health.sources[name]["jobs_found"] = len(found)
    out = []
    for jid, r in found.items():
        title = r.get("jobTitle", "")
        if not title_ok(cfg, title):
            continue
        if any(x in (r.get("locationName") or "").lower() for x in cfg["isle_of_wight"]):
            continue
        cpath = os.path.join(cache_dir, f"reed-{jid}.json") if cache_dir else None
        d = {}
        if cpath and os.path.exists(cpath):
            d = json.load(open(cpath))
        else:
            try:
                d = http(health, name, f"https://www.reed.co.uk/api/1.0/jobs/{jid}", reed_headers())
                if cpath:
                    json.dump(d, open(cpath, "w"))
                time.sleep(0.3)
            except RuntimeError:
                pass
        contract = d.get("contractType") or ""
        out.append({
            "source": "Reed", "source_kind": "API", "company": r.get("employerName", ""), "title": title,
            "location": r.get("locationName", ""), "salary_min": r.get("minimumSalary"),
            "salary_max": r.get("maximumSalary"), "posted": r["_posted"].isoformat(),
            "url": d.get("jobUrl") or r.get("jobUrl"), "apply_url": d.get("externalUrl") or d.get("jobUrl") or r.get("jobUrl"),
            "description": strip_html(d.get("jobDescription") or r.get("jobDescription", "")),
            "agency": bool(d.get("isAgency") if "isAgency" in d else r.get("employerName", "").lower().endswith("recruitment")),
            "contract": "" if contract.lower() in ("", "permanent") else contract,
            "applications": r.get("applications"), "closing": (r.get("expirationDate") or "")[:10],
        })
    health.finish(name)
    return out


def src_boards(cfg, since, health):
    wl = cfg["watchlist"]
    out = []

    def keep(row):
        if loc_ok(cfg, row["location"]) and title_ok(cfg, row["title"]):
            out.append(row)

    name = "Greenhouse boards"
    health.src(name, "Company board")
    for slug in wl.get("greenhouse", []):
        try:
            data = http(health, name, f"https://boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true")
        except RuntimeError:
            continue
        for j in data.get("jobs", []):
            posted = dt.date.fromisoformat((j.get("first_published") or j.get("updated_at"))[:10])
            if posted < since:
                continue
            health.sources[name]["jobs_found"] += 1
            text = strip_html(html.unescape(j.get("content", "")))
            lo, hi = salary_from_text(text)
            keep({"source": f"Greenhouse ({slug})", "source_kind": "Company board", "company": slug.title(),
                  "title": j["title"], "location": (j.get("location") or {}).get("name", ""), "salary_min": lo,
                  "salary_max": hi, "posted": posted.isoformat(), "url": j["absolute_url"],
                  "apply_url": j["absolute_url"], "description": text})
    health.finish(name, fatal=health.sources[name]["requests"] > 0 and len(health.sources[name]["errors"]) >= len(wl.get("greenhouse", [])))

    name = "Ashby boards"
    health.src(name, "Company board")
    for slug in wl.get("ashby", []):
        try:
            data = http(health, name, f"https://api.ashbyhq.com/posting-api/job-board/{slug}?includeCompensation=true")
        except RuntimeError:
            continue
        for j in data.get("jobs", []):
            posted = dt.date.fromisoformat(j["publishedAt"][:10])
            if posted < since:
                continue
            health.sources[name]["jobs_found"] += 1
            locs = ", ".join([j.get("location", "")] + [s.get("location", "") for s in j.get("secondaryLocations", [])])
            comp = (j.get("compensation") or {}).get("compensationTierSummary") or ""
            text = (j.get("descriptionPlain") or "") + f"\nworkplace: {(j.get('workplaceType') or '').lower()}"
            lo, hi = salary_from_text(comp if "£" in comp else text)
            keep({"source": f"Ashby ({slug})", "source_kind": "Company board", "company": slug.title(),
                  "title": j["title"], "location": locs, "salary_min": lo, "salary_max": hi,
                  "posted": posted.isoformat(), "url": j["jobUrl"], "apply_url": j.get("applyUrl") or j["jobUrl"],
                  "description": text})
    health.finish(name, fatal=len(health.sources[name]["errors"]) >= len(wl.get("ashby", [])))

    name = "Lever boards"
    health.src(name, "Company board")
    for slug in wl.get("lever", []):
        try:
            data = http(health, name, f"https://api.lever.co/v0/postings/{slug}?mode=json")
        except RuntimeError:
            continue
        for j in data:
            posted = dt.datetime.fromtimestamp(j["createdAt"] / 1000).date()
            if posted < since:
                continue
            health.sources[name]["jobs_found"] += 1
            text = (j.get("descriptionPlain") or "") + "\n" + "\n".join(
                strip_html(l.get("content", "")) for l in j.get("lists", [])) + f"\nworkplace: {(j.get('workplaceType') or '').lower()}"
            lo, hi = salary_from_text(text)
            keep({"source": f"Lever ({slug})", "source_kind": "Company board", "company": slug.title(),
                  "title": j["text"], "location": j.get("categories", {}).get("location", ""), "salary_min": lo,
                  "salary_max": hi, "posted": posted.isoformat(), "url": j["hostedUrl"],
                  "apply_url": j.get("applyUrl") or j["hostedUrl"], "description": text})
    health.finish(name, fatal=len(health.sources[name]["errors"]) >= len(wl.get("lever", [])))
    return out


def workday_age(posted_on):
    t = (posted_on or "").lower()
    if "today" in t:
        return 0
    if "yesterday" in t:
        return 1
    m = re.search(r"(\d+)", t)
    return int(m.group(1)) if m else 99


def src_workday(cfg, since, health):
    name = "Workday boards"
    health.src(name, "Company board")
    wl = cfg["watchlist"]
    out, failed_boards = [], 0
    deadline = time.time() + wl.get("workday_budget_seconds", 480)
    max_age = min((TODAY - since).days, 7)
    boards = wl.get("workday", [])
    k = TODAY.toordinal() % len(boards) if boards else 0
    boards = boards[k:] + boards[:k]  # rotate the starting board daily so every employer gets covered
    for board in boards:
        board_deadline = time.time() + wl.get("workday_board_seconds", 90)
        if time.time() > deadline:
            health.sources[name]["note"] = f"time budget hit before {board['name']} (Workday rate-limits); partial results"
            health.sources[name]["errors"].append({"url": board["tenant"], "status": None, "error": "time budget", "ts": now()})
            break
        tenant, n, site = board["tenant"], board["wd"], board["site"]
        base = f"https://{tenant}.wd{n}.myworkdayjobs.com/wday/cxs/{tenant}/{site}"
        seen, ok = set(), False
        for kw in wl.get("workday_keywords", []):
            if time.time() > board_deadline or time.time() > deadline:
                health.sources[name]["errors"].append({"url": board["tenant"], "status": 429, "error": "per-board time cap (rate-limited)", "ts": now()})
                break
            try:
                data = http(health, name, f"{base}/jobs", body={"appliedFacets": {}, "limit": 20, "offset": 0, "searchText": kw}, retries=2)
                ok = True
            except RuntimeError:
                continue
            for j in data.get("jobPostings", []):
                path = j.get("externalPath", "")
                age = workday_age(j.get("postedOn", ""))
                if path in seen or age > max_age or time.time() > min(deadline, board_deadline):
                    continue
                seen.add(path)
                health.sources[name]["jobs_found"] += 1
                loc = j.get("locationsText", "")
                if not title_ok(cfg, j.get("title", "")):
                    continue
                if not re.search(r"\d+ locations", loc.lower()) and not loc_ok(cfg, loc):
                    continue
                try:
                    info = http(health, name, base + path, retries=2).get("jobPostingInfo", {})
                except RuntimeError:
                    continue
                locs = ", ".join([info.get("location", loc)] + info.get("additionalLocations", []))
                text = strip_html(info.get("jobDescription", ""))
                lo, hi = salary_from_text(text)
                url = info.get("externalUrl") or f"https://{tenant}.wd{n}.myworkdayjobs.com/{site}{path}"
                row = {"source": f"Workday ({board['name']})", "source_kind": "Company board", "company": board["name"],
                       "title": info.get("title", j["title"]), "location": locs, "salary_min": lo, "salary_max": hi,
                       "posted": (TODAY - dt.timedelta(days=age)).isoformat(), "url": url, "apply_url": url,
                       "description": text}
                if loc_ok(cfg, locs):
                    out.append(row)
                time.sleep(1)
            time.sleep(1.5)
        failed_boards += 0 if ok else 1
    health.finish(name, fatal=failed_boards == len(wl.get("workday", [])) and failed_boards > 0)
    return out


CFG = json.load(open(os.path.join(HERE, "config.json")))


def nhs_detail(url, cache_dir):
    """Full NHS Jobs advert text (robots allow it), cached."""
    key = os.path.join(cache_dir, "nhs-" + hashlib.sha1(url.encode()).hexdigest()[:12] + ".txt") if cache_dir else None
    if key and os.path.exists(key):
        return open(key).read()
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (personal job digest)"}), timeout=30) as r:
            h = r.read().decode("utf-8", "replace")
    except Exception:
        return ""
    h = re.sub(r"<(script|style)[^>]*>.*?</\1>", " ", h, flags=re.S)
    t = re.sub(r"\n\s*\n+", "\n", html.unescape(re.sub(r"<[^>]+>", "\n", h)))
    i = t.find("Job summary")
    t = t[i:i + 9000] if i >= 0 else t[:9000]
    if key:
        open(key, "w").write(t)
    time.sleep(0.3)
    return t


def src_nhs(cfg, since, health, cache_dir=None):
    """NHS Jobs official XML search API (no key)."""
    name = "NHS Jobs"
    health.src(name, "API")
    nc = cfg.get("nhs", {})
    if not nc.get("enabled"):
        health.sources[name].update(status="disabled")
        return []
    out, seen = [], set()
    for loc in nc.get("locations", []):
        for kw in nc.get("keywords", []):
            for pg in (1, 2, 3):
                q = urllib.parse.urlencode({"keyword": kw, "location": loc["name"], "distance": loc["miles"], "page": pg})
                url = f"https://www.jobs.nhs.uk/api/v1/search_xml?{q}"
                health.sources[name]["requests"] += 1
                try:
                    with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA}), timeout=30) as r:
                        x = r.read().decode("utf-8", "replace")
                except Exception as e:
                    health.fail(name, url, getattr(e, "code", None), e)
                    break
                items = re.findall(r"<vacancyDetails>(.*?)</vacancyDetails>", x, re.S)
                stop = False
                for it in items:
                    g = lambda t: html.unescape((re.search(rf"<{t}>(.*?)</{t}>", it, re.S) or [None, ""])[1]).strip()
                    jid = g("id")
                    if jid in seen:
                        continue
                    seen.add(jid)
                    posted = g("postDate")[:10]
                    try:
                        if dt.date.fromisoformat(posted) < since:
                            continue
                    except ValueError:
                        pass
                    health.sources[name]["jobs_found"] += 1
                    title, place = g("title"), re.sub(r"<[^>]+>", " ", g("locations") or g("location"))
                    nums = [float(n) for n in re.findall(r"£\s?([\d,]+(?:\.\d+)?)", g("salary").replace(",", ""))]
                    lo, hi = (min(nums), max(nums)) if nums else (None, None)
                    if not title_ok(cfg, title) or not fit.commutable(place):
                        continue
                    if lo is not None and (hi or lo) < salary_floor(cfg, place):
                        continue
                    full = nhs_detail(g("url"), cache_dir)
                    out.append({"source": "NHS Jobs", "source_kind": "API", "company": g("employer"), "title": title,
                                "location": re.sub(r"\s+", " ", place).strip() or loc["name"],
                                "salary_min": int(lo) if lo else None, "salary_max": int(hi) if hi else None, "posted": posted,
                                "url": g("url"), "apply_url": g("url"), "description": (full or g("description")) + f"\n{g('type')}",
                                "closing": g("closeDate")[:10], "contract": "" if g("type").lower().startswith("perm") else g("type")})
                if len(items) < 10 or stop:
                    break
                time.sleep(0.3)
    health.finish(name, fatal=health.sources[name]["requests"] > 0 and not health.sources[name]["jobs_found"] and bool(health.sources[name]["errors"]))
    return out


def src_inbox(data_dir, health):
    """Jobs added by ingest.py or the daily session's email-alert step (data/inbox/*.json)."""
    inbox = os.path.join(data_dir, "inbox")
    os.makedirs(os.path.join(inbox, "processed"), exist_ok=True)
    out = []
    for f in sorted(os.listdir(inbox)):
        if not f.endswith(".json"):
            continue
        path = os.path.join(inbox, f)
        try:
            rows = json.load(open(path))
        except Exception as e:
            health.src("Inbox", "Manual")
            health.fail("Inbox", path, None, e)
            continue
        for r in rows if isinstance(rows, list) else [rows]:
            kind = r.get("source_kind", "Manual")
            label = r.get("source", "Manual")
            health.src(label, kind)
            health.sources[label]["jobs_found"] += 1
            if kind == "Aggregator" and not (title_ok(CFG, r.get("title", "")) and loc_ok(CFG, r.get("location", ""))):
                continue
            lo, hi = r.get("salary_min"), r.get("salary_max")
            if not (lo or hi):
                lo, hi = salary_from_text(f"{r.get('salary', '')} {r.get('description', '')}")
            out.append({"source": label, "source_kind": kind, "company": r.get("company", ""),
                        "title": r.get("title", ""), "location": r.get("location", ""), "salary_min": lo,
                        "salary_max": hi, "posted": r.get("posted") or TODAY.isoformat(), "url": r.get("url", ""),
                        "apply_url": r.get("apply_url") or r.get("url", ""),
                        "description": r.get("description", ""), "manual": kind != "Aggregator",
                        "needs_description": not r.get("description")})
        shutil.move(path, os.path.join(inbox, "processed", f"{TODAY}-{f}"))
    return out


# ---------------------------------------------------------------- pipeline
def enrich(cfg, j):
    text = j.get("description", "")
    pattern, note = work_pattern(f"{j['title']} {text}")
    floor = salary_floor(cfg, j["location"])
    j["office_pattern"], j["office_note"] = pattern, note
    j["salary_floor"] = floor
    j["ats_platform"] = ats_platform(j.get("apply_url") or j.get("url"))
    j["requirements"] = fit.requirements(text)
    j["key"] = canonical_key(j["company"], j["title"], j["location"])
    j["job_id"] = hashlib.sha1(j["key"].encode()).hexdigest()[:10]
    j["fit"] = fit.score(j, floor, pattern)
    j["priority"], j["public_sector"], j["near_southampton"] = fit.priority(j, j["fit"], floor, cfg)
    if j["public_sector"]:
        j["fit"]["ambition"] = min(100, j["fit"]["ambition"] + 5)
    if not j.get("manual") and desc_blocked(cfg, text):
        j["fit"].update(tier="SKIP", decision="SKIP", eligibility="FAIL",
                        hard_gate_failures=j["fit"]["hard_gate_failures"] + ["Construction/clearance role"])
    missing = [k for k in ("company", "location", "description", "url") if not j.get(k)]
    if not (j.get("salary_min") or j.get("salary_max")):
        missing.append("salary")
    j["missing_fields"] = missing
    j["description"] = text[:6000]
    return j


def rescore(data):
    cfg = json.load(open(os.path.join(HERE, "config.json")))
    latest = os.path.join(data, "latest")
    jobs = json.load(open(os.path.join(latest, "results.json")))
    report = json.load(open(os.path.join(latest, "health.json")))
    cache = os.path.join(data, "cache")
    for j in jobs:
        srcs = j.get("sources")
        if "jobs.nhs.uk" in (j.get("url") or "") and len(j.get("description", "")) < 1500:
            j["description"] = nhs_detail(j["url"], cache) or j["description"]
        enrich(cfg, j)
        j["sources"] = srcs or [j["source"]]
        if not j.get("manual") and (not title_ok(cfg, j["title"]) or desc_blocked(cfg, j.get("description", ""))):
            j["fit"].update(tier="SKIP", decision="SKIP", eligibility="FAIL", hard_gate_failures=j["fit"]["hard_gate_failures"] + ["Off-target title or engineering/construction role"])
    order = {"A": 0, "B": 1, "C": 2, "D": 3, "SKIP": 4}
    jobs.sort(key=lambda j: (order[j["fit"]["tier"]], -j.get("priority", 0)))
    for d in (latest, os.path.join(data, "runs", report["run_started"][:10])):
        os.makedirs(d, exist_ok=True)
        json.dump(jobs, open(os.path.join(d, "results.json"), "w"), indent=1, default=str)
        digest.write_all(d, jobs, report)
    print(json.dumps({"rescored": len(jobs), "tiers": {t: sum(1 for j in jobs if j["fit"]["tier"] == t) for t in order}}))


def default_since():
    return TODAY - dt.timedelta(days=3 if TODAY.weekday() == 0 else 1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, help="look back this many days (default: since the last weekday run)")
    ap.add_argument("--data", default=os.path.join(HERE, "data"))
    ap.add_argument("--only", choices=["reed", "nhs", "boards", "workday", "inbox"])
    ap.add_argument("--all", action="store_true", help="ignore the seen-jobs store (re-report everything in the window)")
    ap.add_argument("--rescore", action="store_true", help="re-score data/latest with the current rules (no network)")
    a = ap.parse_args()
    if a.rescore:
        return rescore(a.data)
    cfg = json.load(open(os.path.join(HERE, "config.json")))
    since = TODAY - dt.timedelta(days=a.days) if a.days else default_since()
    data = a.data
    cache = os.path.join(data, "cache")
    os.makedirs(cache, exist_ok=True)
    health = Health()
    started = now()

    jobs = []
    steps = {"reed": lambda: src_reed(cfg, since, health, cache), "nhs": lambda: src_nhs(cfg, since, health, cache),
             "boards": lambda: src_boards(cfg, since, health),
             "workday": lambda: src_workday(cfg, since, health), "inbox": lambda: src_inbox(data, health)}
    for key, fn in steps.items():
        if a.only and a.only != key:
            continue
        try:
            jobs += fn()
        except Exception as e:  # a crashed source never stops the others
            name = {"reed": "Reed", "nhs": "NHS Jobs", "boards": "Greenhouse boards", "workday": "Workday boards", "inbox": "Inbox"}[key]
            health.src(name, "API")
            health.fail(name, "-", None, f"crash: {e!r}")
            health.finish(name, fatal=True)
        print(f"{key}: {len(jobs)} candidate rows so far", file=sys.stderr)

    # enrich, de-duplicate on company + title + location, merge sources
    merged = {}
    for j in jobs:
        j = enrich(cfg, j)
        if j["key"] in merged:
            m = merged[j["key"]]
            m["sources"] = sorted(set(m["sources"] + [j["source"]]))
            for f in ("salary_min", "salary_max", "closing"):
                m[f] = m.get(f) or j.get(f)
            if len(j.get("description", "")) > len(m.get("description", "")):
                m["description"] = j["description"]
        else:
            j["sources"] = [j["source"]]
            merged[j["key"]] = j
    for j in merged.values():
        for s in health.sources.values():
            if j["source"] == s["name"] or j["source"].split(" ")[0] == s["name"].split(" ")[0]:
                s["jobs_kept"] += 1
                break

    # new = not reported before
    seen_path = os.path.join(data, "seen.json")
    seen = json.load(open(seen_path)) if os.path.exists(seen_path) else {}
    new = [j for j in merged.values() if a.all or j["key"] not in seen]
    for j in new:
        seen.setdefault(j["key"], TODAY.isoformat())
        j["first_seen"] = seen[j["key"]]
    json.dump(seen, open(seen_path, "w"), indent=0, sort_keys=True)

    order = {"A": 0, "B": 1, "C": 2, "D": 3, "SKIP": 4}
    new.sort(key=lambda j: (order[j["fit"]["tier"]], -j.get("priority", 0)))

    # job database (one JSON per line, newest version wins)
    with open(os.path.join(data, "jobs.jsonl"), "a") as fh:
        for j in new:
            fh.write(json.dumps({k: v for k, v in j.items()}, default=str) + "\n")

    report = {"run_started": started, "run_finished": now(), "since": since.isoformat(),
              "sources": list(health.sources.values()), "all_live_sources_failed": health.all_live_failed(),
              "new_jobs": len(new), "candidates_seen": len(merged)}
    run_dir = os.path.join(data, "runs", TODAY.isoformat())
    latest = os.path.join(data, "latest")
    for d in (run_dir, latest):
        os.makedirs(d, exist_ok=True)
        json.dump(new, open(os.path.join(d, "results.json"), "w"), indent=1, default=str)
        json.dump(report, open(os.path.join(d, "health.json"), "w"), indent=1)
        digest.write_all(d, new, report)
    counts = {t: sum(1 for j in new if j["fit"]["tier"] == t) for t in order}
    print(json.dumps({"new_jobs": len(new), "tiers": counts, "since": since.isoformat(), "out": latest,
                      "sources": {s["name"]: s["status"] for s in health.sources.values()}}))
    if report["all_live_sources_failed"]:
        print("ALL LIVE SOURCES FAILED", file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    main()
