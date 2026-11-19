#!/usr/bin/env python3
"""Build and validate an apply-ready package for one job.

  python3 job-hunt/package.py --job JOB_ID --spec spec.json

spec.json (written by Claude for this job, see DAILY.md step 4):
{
  "variant": "project-delivery | customer-success | analyst",
  "summary": "3-4 sentences, role-specific. Only facts from master_cv.json.",
  "skills": ["ordered subset of master_cv.json skills"],
  "bullets": {"gb-dapm": ["japan-vat", "governance-25", ...], "gb-ssm": [...], "gb-ss": ["ss-summary"]},
  "cover_letter": ["paragraph 1", "paragraph 2", ...],
  "answers": {"why this company": "...", "why this role": "..."}   # optional draft answers
}

Output: data/applications/<job_id>/ with cv.docx, cv.pdf, cover_letter.docx, cover_letter.pdf,
checklist.md and status.json. Validation failures leave status "draft" and list what to fix.
"""
import argparse
import datetime as dt
import html
import json
import os
import re
import subprocess
import sys
import tempfile

from docx import Document
from docx.shared import Pt, Cm
from pypdf import PdfReader

HERE = os.path.dirname(os.path.abspath(__file__))
CHROME = os.environ.get("CHROME_BIN", "/opt/pw-browsers/chromium")


def load_job(data, job_id):
    for name in ("latest/results.json",):
        p = os.path.join(data, name)
        if os.path.exists(p):
            for j in json.load(open(p)):
                if j["job_id"] == job_id:
                    return j
    p = os.path.join(data, "jobs.jsonl")
    if os.path.exists(p):
        found = None
        for line in open(p):
            j = json.loads(line)
            if j.get("job_id") == job_id:
                found = j
        if found:
            return found
    sys.exit(f"job {job_id} not found in {data}")


# ---------------------------------------------------------------- fact checks
def facts_text(cv):
    parts = [cv["contact"]["location"]] + cv["education"] + cv["skills"]
    for r in cv["roles"]:
        parts += [r["title"], r["company"], r["dates"]] + list(r["bullets"].values())
    return " ".join(parts)


def numbers(text):
    return set(re.findall(r"\d[\d,]*\+?", text.replace("~", "")))


def check_spec(cv, spec, job):
    errors = []
    allowed = {r["id"]: r["bullets"] for r in cv["roles"]}
    for rid, ids in spec.get("bullets", {}).items():
        if rid not in allowed:
            errors.append(f"unknown role id {rid}")
            continue
        for b in ids:
            if b not in allowed[rid]:
                errors.append(f"bullet '{b}' is not in master_cv.json ({rid}); only existing bullets can be used")
    for s in spec.get("skills", []):
        if s not in cv["skills"]:
            errors.append(f"skill '{s}' is not in master_cv.json skills")
    facts = facts_text(cv)
    fact_nums = numbers(facts) | {"1", "2", "3", "5"}
    free = spec.get("summary", "") + " " + " ".join(spec.get("cover_letter", [])) + " " + " ".join(spec.get("answers", {}).values())
    for n in numbers(free):
        if n.rstrip("+").replace(",", "") not in {x.rstrip("+").replace(",", "") for x in fact_nums} and not re.fullmatch(r"20\d\d", n):
            errors.append(f"number '{n}' in summary/letter is not in the CV facts")
    low = free.lower()
    for tool in cv["not_claimable"]:
        for m in re.finditer(r"(?<![a-z])" + re.escape(tool.lower()) + r"(?![a-z])", low):
            ctx = low[max(0, m.start() - 60):m.end() + 20]
            if not re.search(r"learn|building|currently|working towards|training in|new to|developing|pick up|studying", ctx):
                errors.append(f"'{tool}' is claimed but is not in the CV (say it is being learnt, or drop it)")
                break
    letter = " ".join(spec.get("cover_letter", [])).lower()
    if job["company"] and job["company"].lower().split()[0] not in letter:
        errors.append("cover letter does not name the company")
    key_title = re.sub(r"[^a-z ]", " ", job["title"].lower()).split()
    if key_title and not any(w in letter for w in key_title if len(w) > 3):
        errors.append("cover letter does not reference the role")
    words = len(letter.split())
    if words and not 150 <= words <= 420:
        errors.append(f"cover letter is {words} words (aim for 150-400)")
    if len(spec.get("summary", "").split()) < 25:
        errors.append("summary is too short to be role-specific")
    return errors


# ---------------------------------------------------------------- rendering
CSS = """body{font-family:Arial,Helvetica,sans-serif;font-size:10.5pt;color:#111;margin:0}
h1{font-size:18pt;margin:0}.hl{font-size:11pt;margin:2px 0 4px}.contact{font-size:9.5pt;color:#333;margin-bottom:8px}
h2{font-size:10.5pt;text-transform:uppercase;letter-spacing:.5px;border-bottom:1px solid #999;margin:10px 0 4px;padding-bottom:2px}
.role{margin:6px 0 2px;font-weight:bold}.meta{font-weight:normal;color:#333}ul{margin:2px 0 4px 16px;padding:0}li{margin:0 0 2px}
p{margin:0 0 8px}@page{size:A4;margin:16mm 16mm}"""


def cv_html(cv, spec):
    c, e = cv["contact"], html.escape
    out = [f"<h1>{e(c['name'])}</h1><div class=hl>{e(cv['headlines'].get(spec.get('variant'), cv['headlines']['project-delivery']))}</div>",
           f"<div class=contact>{e(c['phone'])} | {e(c['email'])} | {e(c['linkedin'])} | {e(c['location'])}</div>",
           f"<h2>Professional overview</h2><p>{e(spec['summary'])}</p><h2>Work experience</h2>"]
    for r in cv["roles"]:
        ids = spec.get("bullets", {}).get(r["id"], list(r["bullets"])[:3])
        out.append(f"<div class=role>{e(r['title'].upper())} | {e(r['company'])}, {e(r['location'])} <span class=meta>{e(r['dates'])}</span></div><ul>")
        out += [f"<li>{e(r['bullets'][b])}</li>" for b in ids]
        out.append("</ul>")
    out.append("<h2>Education, certification and volunteering</h2><ul>" + "".join(f"<li>{e(x)}</li>" for x in cv["education"]) + "</ul>")
    out.append(f"<h2>Skills</h2><p>{e(' | '.join(spec.get('skills') or cv['skills']))}</p>")
    return f"<!doctype html><html><head><meta charset=utf-8><style>{CSS}</style></head><body>{''.join(out)}</body></html>"


def letter_html(cv, spec, job):
    c, e = cv["contact"], html.escape
    paras = "".join(f"<p>{e(p)}</p>" for p in spec["cover_letter"])
    return (f"<!doctype html><html><head><meta charset=utf-8><style>{CSS}</style></head><body>"
            f"<h1>{e(c['name'])}</h1><div class=contact>{e(c['phone'])} | {e(c['email'])} | {e(c['linkedin'])} | {e(c['location'])}</div>"
            f"<p>{dt.date.today():%d %B %Y}</p><p>Re: {e(job['title'])}, {e(job['company'])}</p>{paras}"
            f"<p>Kind regards,<br>{e(c['name'])}</p></body></html>")


def to_pdf(html_text, pdf_path):
    with tempfile.NamedTemporaryFile("w", suffix=".html", delete=False) as fh:
        fh.write(html_text)
        src = fh.name
    subprocess.run([CHROME, "--headless", "--no-sandbox", "--disable-gpu", "--no-pdf-header-footer",
                    f"--print-to-pdf={pdf_path}", f"file://{src}"], check=True, capture_output=True, timeout=90)
    os.unlink(src)


def to_docx_cv(cv, spec, path):
    d = Document()
    for s in d.sections:
        s.left_margin = s.right_margin = Cm(1.8)
        s.top_margin = s.bottom_margin = Cm(1.5)
    st = d.styles["Normal"]
    st.font.name, st.font.size = "Arial", Pt(10.5)
    c = cv["contact"]
    d.add_heading(c["name"], level=0)
    d.add_paragraph(cv["headlines"].get(spec.get("variant"), cv["headlines"]["project-delivery"]))
    d.add_paragraph(f"{c['phone']} | {c['email']} | {c['linkedin']} | {c['location']}")
    d.add_heading("Professional overview", level=1)
    d.add_paragraph(spec["summary"])
    d.add_heading("Work experience", level=1)
    for r in cv["roles"]:
        p = d.add_paragraph()
        p.add_run(f"{r['title']} | {r['company']}, {r['location']}").bold = True
        p.add_run(f"   {r['dates']}")
        for b in spec.get("bullets", {}).get(r["id"], list(r["bullets"])[:3]):
            d.add_paragraph(r["bullets"][b], style="List Bullet")
    d.add_heading("Education, certification and volunteering", level=1)
    for x in cv["education"]:
        d.add_paragraph(x, style="List Bullet")
    d.add_heading("Skills", level=1)
    d.add_paragraph(" | ".join(spec.get("skills") or cv["skills"]))
    d.save(path)


def to_docx_letter(cv, spec, job, path):
    d = Document()
    st = d.styles["Normal"]
    st.font.name, st.font.size = "Arial", Pt(11)
    c = cv["contact"]
    d.add_paragraph(c["name"]).runs[0].bold = True
    d.add_paragraph(f"{c['phone']} | {c['email']} | {c['linkedin']}")
    d.add_paragraph(f"{dt.date.today():%d %B %Y}")
    d.add_paragraph(f"Re: {job['title']}, {job['company']}")
    for p in spec["cover_letter"]:
        d.add_paragraph(p)
    d.add_paragraph(f"Kind regards,\n{c['name']}")
    d.save(path)


def check_pdf(path, cv, max_pages):
    errors = []
    r = PdfReader(path)
    if len(r.pages) > max_pages:
        errors.append(f"{os.path.basename(path)} is {len(r.pages)} pages (max {max_pages})")
    text = "\n".join(p.extract_text() or "" for p in r.pages)
    flat = re.sub(r"\s+", " ", text)
    for k in ("name", "email", "phone"):
        if cv["contact"][k] not in flat:
            errors.append(f"{os.path.basename(path)}: {k} is not extractable as text")
    if "�" in text or re.search(r"[-]", text):
        errors.append(f"{os.path.basename(path)}: broken glyphs in extracted text")
    if len(flat) < 300:
        errors.append(f"{os.path.basename(path)}: almost no extractable text")
    return errors, len(r.pages)


def checklist(job, spec, answers, status):
    f = job["fit"]
    lines = [f"# {job['title']}, {job['company']}", "",
             f"- Apply: {job.get('apply_url') or job['url']} ({job.get('ats_platform', '')})",
             f"- Salary: {job.get('salary_min') or ''}–{job.get('salary_max') or ''} · Location: {job['location']} · {job.get('office_note', '')}",
             f"- Tier {f['tier']} · core fit {f['core_fit']} · ambition {f['ambition']}", "",
             "## Steps", "",
             "- [ ] Read the posting once more; check it is still open",
             "- [ ] Upload cv.pdf (or cv.docx if the form asks for Word) and cover_letter.pdf",
             "- [ ] Fill the fields below; answer anything marked CONFIRM yourself",
             "- [ ] Review everything, then click Submit yourself",
             "- [ ] Record it: `python3 job-hunt/track.py submitted " + job["job_id"] + "`", "",
             "## Pre-filled answers", ""]
    for k, v in answers.items():
        if k.startswith("_"):
            continue
        lines.append(f"- {k.replace('_', ' ')}: " + (v["answer"] if v.get("approved") and v.get("answer") else f"CONFIRM ({v.get('help', 'not approved')})"))
    for q, a in (spec.get("answers") or {}).items():
        lines.append(f"- {q}: (draft, edit before using) {a}")
    if f.get("learnable_gaps"):
        lines += ["", "## Gaps to address honestly", ""] + [f"- {g}: say you are learning it; do not claim it" for g in f["learnable_gaps"]]
    lines += ["", f"Status: {status}"]
    return "\n".join(lines)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--job", required=True)
    ap.add_argument("--spec", required=True)
    ap.add_argument("--data", default=os.path.join(HERE, "data"))
    a = ap.parse_args()
    cv = json.load(open(os.path.join(HERE, "master_cv.json")))
    answers = json.load(open(os.path.join(HERE, "answers.json")))
    job = load_job(a.data, a.job)
    spec = json.load(open(a.spec))
    out = os.path.join(a.data, "applications", a.job)
    os.makedirs(out, exist_ok=True)
    json.dump(spec, open(os.path.join(out, "spec.json"), "w"), indent=1)

    errors = check_spec(cv, spec, job)
    pages = {}
    if not any("not in master_cv" in e or "unknown role" in e for e in errors):
        to_pdf(cv_html(cv, spec), os.path.join(out, "cv.pdf"))
        to_pdf(letter_html(cv, spec, job), os.path.join(out, "cover_letter.pdf"))
        to_docx_cv(cv, spec, os.path.join(out, "cv.docx"))
        to_docx_letter(cv, spec, job, os.path.join(out, "cover_letter.docx"))
        for name, mx in (("cv.pdf", 2), ("cover_letter.pdf", 1)):
            errs, n = check_pdf(os.path.join(out, name), cv, mx)
            errors += errs
            pages[name] = n
    status = "draft" if errors else "ready_for_review"
    st = {"job_id": a.job, "title": job["title"], "company": job["company"], "url": job.get("apply_url") or job["url"],
          "tier": job["fit"]["tier"], "status": status, "validation_errors": errors, "pages": pages,
          "history": [{"status": status, "at": dt.datetime.now().isoformat(timespec="seconds")}]}
    prev = os.path.join(out, "status.json")
    if os.path.exists(prev):
        st["history"] = json.load(open(prev)).get("history", []) + st["history"]
    json.dump(st, open(prev, "w"), indent=1)
    open(os.path.join(out, "checklist.md"), "w").write(checklist(job, spec, answers, status))
    print(json.dumps({"job_id": a.job, "status": status, "errors": errors, "pages": pages, "dir": out}))
    sys.exit(0 if status == "ready_for_review" else 1)


if __name__ == "__main__":
    main()
