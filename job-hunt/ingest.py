#!/usr/bin/env python3
"""Add jobs you found yourself (LinkedIn, Indeed, Totaljobs, CV-Library, CWJobs, anywhere).

Nothing here scrapes those sites. It only reads what you hand it:

  python3 job-hunt/ingest.py url  <URL> [--text-file jd.txt] [--title .. --company .. --location .. --salary ..]
  python3 job-hunt/ingest.py text --text-file jd.txt --title .. --company .. --location .. [--url ..] [--salary ..]
  python3 job-hunt/ingest.py email --file alert.eml|alert.html|alert.txt   # a forwarded/saved job-alert email
  python3 job-hunt/ingest.py pdf  --file posting.pdf [--title .. --company .. --location .. --url ..]
  python3 job-hunt/ingest.py csv  --file export.csv   # columns: title,company,location,salary,url,description
  python3 job-hunt/ingest.py firecrawl --file resp.json  # saved Firecrawl jobs_search responses (one or a list)
  python3 job-hunt/ingest.py apify --file items.json      # Apify LinkedIn jobs dataset items (valig/linkedin-jobs-scraper)

URLs on Greenhouse / Ashby / Lever / Workday are read through their public job APIs. Other company
career pages are fetched once if robots.txt allows. LinkedIn / Indeed / Totaljobs / CV-Library /
CWJobs pages are never fetched (their terms forbid bots): paste the description with --text-file.

Each job is scored straight away (same fit model as the daily run) and queued in data/inbox/ so
it also appears in the next daily digest.
"""
import argparse
import csv
import datetime as dt
import email
import email.policy
import html as htmllib
import json
import os
import re
import sys
import urllib.parse
import urllib.request
import urllib.robotparser

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import hunt  # noqa: E402
import digest  # noqa: E402

NO_FETCH = ("linkedin.", "indeed.", "totaljobs.", "cv-library.", "cwjobs.", "glassdoor.", "reed.co.uk/jobs")
BOARD_LABEL = [("linkedin", "LinkedIn"), ("indeed", "Indeed"), ("totaljobs", "Totaljobs"), ("cv-library", "CV-Library"),
               ("cwjobs", "CWJobs"), ("reed.co.uk", "Reed"), ("glassdoor", "Glassdoor")]


def label_for(url_or_sender):
    u = (url_or_sender or "").lower()
    for key, name in BOARD_LABEL:
        if key in u:
            return name
    return "Company site"


def fetch_text(url):
    """Public ATS APIs first, then a robots-respecting single fetch. Returns (fields, note)."""
    u = urllib.parse.urlparse(url)
    host, path = u.netloc.lower(), u.path
    get = lambda api: json.loads(urllib.request.urlopen(urllib.request.Request(api, headers={"User-Agent": hunt.UA}), timeout=30).read())
    m = re.search(r"greenhouse\.io/(?:embed/job_app\?for=)?([\w-]+)/jobs/(\d+)", url) or re.search(r"[?&]gh_jid=(\d+)", url)
    if m and "greenhouse" in host and len(m.groups()) == 2:
        j = get(f"https://boards-api.greenhouse.io/v1/boards/{m.group(1)}/jobs/{m.group(2)}")
        return {"title": j["title"], "location": (j.get("location") or {}).get("name", ""), "company": m.group(1).title(),
                "description": hunt.strip_html(htmllib.unescape(j.get("content", "")))}, "Greenhouse API"
    m = re.search(r"jobs\.ashbyhq\.com/([\w.-]+)/([0-9a-f-]{36})", url)
    if m:
        board = get(f"https://api.ashbyhq.com/posting-api/job-board/{m.group(1)}?includeCompensation=true")
        for j in board.get("jobs", []):
            if m.group(2) in j.get("jobUrl", "") or j.get("id") == m.group(2):
                comp = (j.get("compensation") or {}).get("compensationTierSummary") or ""
                return {"title": j["title"], "location": j.get("location", ""), "company": m.group(1).title(),
                        "description": (j.get("descriptionPlain") or "") + f"\n{comp}"}, "Ashby API"
    m = re.search(r"jobs\.lever\.co/([\w.-]+)/([0-9a-f-]{36})", url)
    if m:
        j = get(f"https://api.lever.co/v0/postings/{m.group(1)}/{m.group(2)}?mode=json")
        text = (j.get("descriptionPlain") or "") + "\n" + "\n".join(hunt.strip_html(l.get("content", "")) for l in j.get("lists", []))
        return {"title": j["text"], "location": j.get("categories", {}).get("location", ""), "company": m.group(1).title(),
                "description": text}, "Lever API"
    m = re.search(r"https://([\w-]+)\.(wd\d+)\.myworkdayjobs\.com/(?:[a-z]{2}-[A-Z]{2}/)?([\w-]+)(/job/.+)", url)
    if m:
        t, wd, site, p = m.groups()
        info = get(f"https://{t}.{wd}.myworkdayjobs.com/wday/cxs/{t}/{site}{p}").get("jobPostingInfo", {})
        return {"title": info.get("title", ""), "location": info.get("location", ""), "company": t.title(),
                "description": hunt.strip_html(info.get("jobDescription", ""))}, "Workday API"
    if any(k in url.lower() for k in NO_FETCH):
        return {}, f"{label_for(url)} pages are not fetched (their terms forbid bots). Paste the description with --text-file."
    rp = urllib.robotparser.RobotFileParser(f"{u.scheme}://{u.netloc}/robots.txt")
    try:
        rp.read()
        if not rp.can_fetch(hunt.UA, url) or not rp.can_fetch("*", url):
            return {}, "robots.txt disallows fetching this page. Paste the description with --text-file."
    except Exception:
        pass
    raw = urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": hunt.UA}), timeout=30).read().decode("utf-8", "replace")
    title = re.search(r"<title[^>]*>(.*?)</title>", raw, re.S | re.I)
    body = re.sub(r"<(script|style|nav|footer|header)[^>]*>.*?</\1>", " ", raw, flags=re.S | re.I)
    return {"title": hunt.strip_html(title.group(1)) if title else "", "description": hunt.strip_html(body)[:8000]}, "page fetch"


def parse_alert_email(path):
    """Pull jobs out of a job-alert email (LinkedIn, Indeed, Totaljobs, CV-Library, CWJobs, Reed, ...)."""
    raw = open(path, "rb").read()
    sender, body = "", raw.decode("utf-8", "replace")
    if path.endswith(".eml") or raw[:200].lower().find(b"from:") >= 0:
        msg = email.message_from_bytes(raw, policy=email.policy.default)
        sender = str(msg.get("From", ""))
        part = msg.get_body(preferencelist=("html", "plain"))
        if part:
            payload = part.get_payload(decode=True) or b""
            body = payload.decode(part.get_content_charset() or "utf-8", "replace")
    source = label_for(sender) if sender else "Email alert"
    jobs, seen = [], set()
    job_link = re.compile(r"(linkedin\.com/(?:comm/)?jobs/view|indeed\.[\w.]+/(?:rc/clk|viewjob|pagead)|totaljobs\.com/job|"
                          r"cv-library\.co\.uk/job|cwjobs\.co\.uk/job|reed\.co\.uk/jobs/|greenhouse\.io|lever\.co|ashbyhq|"
                          r"myworkdayjobs|/jobs?/|/vacanc|/careers?/)", re.I)
    for m in re.finditer(r"<a[^>]+href=[\"']([^\"']+)[\"'][^>]*>(.*?)</a>(?=(.{0,600}))", body, re.S | re.I):
        after_raw = re.split(r"<a\s", m.group(3), maxsplit=1, flags=re.I)[0]
        href, text, after = m.group(1), hunt.strip_html(m.group(2)), hunt.strip_html(after_raw)
        if not job_link.search(href) or len(text) < 4 or len(text) > 140:
            continue
        if re.search(r"^(unsubscribe|view all|see all|see more|manage (job )?alerts?|settings|privacy|help|search jobs)\b|"
                     r"\bunsubscribe\b|\bjob alert settings\b", text, re.I):
            continue
        clean = re.sub(r"[?&](trk|tracking|utm_\w+|refId|trackingId)=[^&]*", "", htmllib.unescape(href))
        key = re.sub(r"[?#].*$", "", clean)
        if key in seen:
            continue
        seen.add(key)
        bits = [b.strip() for b in re.split(r"\n|·|\|", after) if b.strip()][:4]
        sal = next((b for b in bits if "£" in b), "")
        loc = next((b for b in bits if re.search(r"london|southampton|hampshire|remote|hybrid|uk|england|reading|winchester|"
                                                  r"portsmouth|basingstoke|bournemouth|guildford", b, re.I)), "")
        company = next((b for b in bits if b not in (sal, loc) and len(b) < 60), "")
        jobs.append({"title": text, "company": company, "location": loc, "salary": sal, "url": clean,
                     "source": f"{source} (email alert)" if source != "Email alert" else "Email alert",
                     "source_kind": "Email alert", "description": ""})
    if not jobs:  # plain-text alerts: one URL per job, title on the line before
        lines = [l.strip() for l in hunt.strip_html(body).splitlines() if l.strip()]
        for i, l in enumerate(lines):
            for url in re.findall(r"https?://\S+", l):
                if job_link.search(url) and url not in seen and i > 0:
                    seen.add(url)
                    jobs.append({"title": lines[i - 1][:140], "company": "", "location": "", "url": url,
                                 "source": f"{source} (email alert)", "source_kind": "Email alert", "description": ""})
    return jobs


def queue_and_score(rows):
    rows = [r for r in rows if r.get("title") or r.get("description")]
    if not rows:
        print("Nothing queued: no title or description. For LinkedIn/Indeed/Totaljobs/CV-Library/CWJobs links, "
              "paste the job description into a file and add --text-file FILE --title .. --company .. --location ..")
        return
    cfg = json.load(open(os.path.join(HERE, "config.json")))
    inbox = os.path.join(HERE, "data", "inbox")
    os.makedirs(inbox, exist_ok=True)
    stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S-%f") + f"-{os.getpid()}"
    path = os.path.join(inbox, f"{stamp}.json")
    json.dump(rows, open(path, "w"), indent=1)
    for r in rows:
        lo, hi = hunt.salary_from_text(f"{r.get('salary', '')} {r.get('description', '')}")
        j = hunt.enrich(cfg, {"source": r["source"], "source_kind": r["source_kind"], "company": r.get("company", ""),
                              "title": r.get("title", ""), "location": r.get("location", ""), "salary_min": lo,
                              "salary_max": hi, "url": r.get("url", ""), "apply_url": r.get("url", ""),
                              "description": r.get("description", ""), "manual": True})
        j["sources"] = [r["source"]]
        print(digest.card_md(j))
        if not r.get("description"):
            print("(No description yet: the score is a title-only estimate. Paste the description with "
                  "`ingest.py text` for a real grade.)")
        print()
    print(f"Queued {len(rows)} job(s) for the next daily digest: {path}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=["url", "text", "email", "pdf", "csv", "firecrawl", "apify"])
    ap.add_argument("url", nargs="?")
    ap.add_argument("--file")
    ap.add_argument("--text-file")
    ap.add_argument("--title", default="")
    ap.add_argument("--company", default="")
    ap.add_argument("--location", default="")
    ap.add_argument("--salary", default="")
    ap.add_argument("--source", default="")
    a = ap.parse_args()
    rows = []
    base = {"title": a.title, "company": a.company, "location": a.location, "salary": a.salary}
    if a.mode == "url":
        url = a.url or ""
        fields, note = ({}, "")
        if a.text_file:
            fields = {"description": open(a.text_file).read()}
        else:
            try:
                fields, note = fetch_text(url)
            except Exception as e:
                note = f"could not read the page ({e}); paste the description with --text-file"
        if note:
            print(f"[{note}]")
        src = a.source or label_for(url)
        rows.append({**base, **{k: v for k, v in fields.items() if v and not base.get(k)}, "url": url,
                     "source": f"{src} (manual)", "source_kind": "Manual"})
    elif a.mode == "text":
        rows.append({**base, "description": open(a.text_file or a.file).read(), "url": a.url or "",
                     "source": f"{a.source or 'Pasted'} (manual)", "source_kind": "Manual"})
    elif a.mode == "pdf":
        from pypdf import PdfReader
        text = "\n".join(p.extract_text() or "" for p in PdfReader(a.file).pages)
        rows.append({**base, "description": text, "url": a.url or "", "source": f"{a.source or 'PDF'} (manual)",
                     "source_kind": "Manual"})
    elif a.mode == "email":
        rows = parse_alert_email(a.file)
        if not rows:
            print("No job links found in that email.")
            return
    elif a.mode in ("firecrawl", "apify"):
        pass
    elif a.mode == "csv":
        for r in csv.DictReader(open(a.file, newline="", encoding="utf-8-sig")):
            r = {k.strip().lower(): (v or "").strip() for k, v in r.items() if k}
            rows.append({"title": r.get("title") or r.get("job title", ""), "company": r.get("company", ""),
                         "location": r.get("location", ""), "salary": r.get("salary", ""), "url": r.get("url") or r.get("link", ""),
                         "description": r.get("description", ""), "source": f"{a.source or label_for(r.get('url', ''))} (CSV)",
                         "source_kind": "Manual"})
    if a.mode == "apify":
        files = a.file.split(",")
        for f in files:
            data = json.load(open(f))
            items = data.get("items", data) if isinstance(data, dict) else data
            for r in items:
                if not r.get("title") or not r.get("companyName"):
                    continue
                desc = (r.get("description") or "") + f"\nworkplace: {(r.get('workType') or '').lower()}"
                easy = "easy" in (r.get("applyType") or "").lower()
                rows.append({"title": r["title"], "company": r["companyName"], "location": r.get("location", ""),
                             "salary": r.get("salary") or "", "url": r.get("url", ""),
                             "apply_url": (r.get("applyUrl") if not easy else r.get("url")) or r.get("url", ""),
                             "posted": (r.get("postedDate") or "")[:10], "description": desc,
                             "contract": r.get("contractType") or "", "linkedin_easy_apply": easy,
                             "source": "LinkedIn (via Apify)", "source_kind": "Aggregator"})
        inbox = os.path.join(HERE, "data", "inbox")
        os.makedirs(inbox, exist_ok=True)
        path = os.path.join(inbox, f"apify-linkedin-{dt.datetime.now():%Y%m%d-%H%M%S}.json")
        json.dump(rows, open(path, "w"), indent=1)
        print(f"Queued {len(rows)} LinkedIn job(s): {path}")
        return
    if a.mode == "firecrawl":
        data = json.load(open(a.file))
        resps = data if isinstance(data, list) else [data]
        names = {"indeed-com": "Indeed", "workable": "Workable", "myworkdayjobs-com": "Workday", "greenhouse-io": "Greenhouse",
                 "smartrecruiters-com": "SmartRecruiters", "jobleads-com": "JobLeads", "ashbyhq-com": "Ashby", "firecrawl": "Web index"}
        for resp in resps:
            for r in resp.get("results", []):
                if not r.get("company") or not r.get("title"):
                    continue
                desc = (r.get("description") or "") + "\n" + (r.get("requirements") or "")
                if r.get("remote"):
                    desc += "\nworkplace: remote"
                rows.append({"title": r["title"], "company": r["company"], "location": r.get("location", ""),
                             "salary": r.get("salary", ""), "url": r.get("url", ""), "apply_url": r.get("apply_url") or r.get("url", ""),
                             "posted": (r.get("posted_at") or "")[:10], "description": desc,
                             "source": f"{names.get(r.get('source'), r.get('source', 'Firecrawl'))} (via Firecrawl)", "source_kind": "Aggregator"})
        inbox = os.path.join(HERE, "data", "inbox")
        os.makedirs(inbox, exist_ok=True)
        path = os.path.join(inbox, f"firecrawl-{dt.datetime.now():%Y%m%d-%H%M%S}.json")
        json.dump(rows, open(path, "w"), indent=1)
        print(f"Queued {len(rows)} aggregator job(s): {path}")
        return
    queue_and_score(rows)


if __name__ == "__main__":
    main()
