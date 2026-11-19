"""Render the decision-ready digest (markdown for the phone notification, HTML for email).

Also merges the daily session's full grades back in:
  python3 job-hunt/digest.py --grades grades.json [--data job-hunt/data]
grades.json: [{"job_id": ..., "tier": "A|B|C|D|SKIP", "core_fit": .., "ambition": .., "matched": [..],
               "transferable": [..], "learnable_gaps": [..], "hard_gaps": [..], "why_worth_it": "..",
               "cv_variant": "..", "cover_letter_angle": "..", "risk": ".."}]
"""
import argparse
import datetime as dt
import html
import json
import os

DECISION = {"A": "APPLY NOW", "B": "APPLY - STRONG", "C": "APPLY - STRETCH", "D": "WATCH", "SKIP": "SKIP"}
ORDER = {"A": 0, "B": 1, "C": 2, "D": 3, "SKIP": 4}


def money(n):
    return f"£{round(n / 1000)}k" if n else ""


def sal(j):
    lo, hi = j.get("salary_min"), j.get("salary_max")
    if not lo and not hi:
        return "not stated"
    return f"{money(lo)}–{money(hi)}" if lo and hi and lo != hi else money(hi or lo)


def urgent(j):
    c = j.get("closing")
    if not c:
        return False
    try:
        return (dt.date.fromisoformat(c) - dt.date.today()).days <= 5
    except ValueError:
        return False


def counts(jobs):
    c = {t: 0 for t in ORDER}
    for j in jobs:
        c[j["fit"]["tier"]] += 1
    return c


def health_lines(report):
    out = []
    for s in report["sources"]:
        icon = {"ok": "OK", "partial": "PARTIAL", "failed": "FAILED", "disabled": "OFF"}.get(s["status"], s["status"])
        line = f"{icon} · {s['name']} ({s['kind']}): {s['jobs_found']} seen, {s['requests']} requests"
        if s.get("note"):
            line += f" · {s['note']}"
        if s["errors"]:
            e = s["errors"][-1]
            line += f" · {len(s['errors'])} error(s), last: {e['status']} {e['error']} at {e['ts']} [{e['url'][:90]}]"
        out.append(line)
    return out


def summary(jobs, report):
    c = counts(jobs)
    worth = c["A"] + c["B"] + c["C"]
    failed = [s["name"] for s in report["sources"] if s["status"] in ("failed", "partial")]
    lines = [f"**{len(jobs)} new roles · {worth} worth applying to** (A {c['A']} · B {c['B']} · C {c['C']} · watch {c['D']} · skip {c['SKIP']})"]
    top = [j for j in jobs if j["fit"]["tier"] in ("A", "B", "C")][:5]
    if top:
        lines.append("")
        lines.append("Top picks:")
        for i, j in enumerate(top, 1):
            f = j["fit"]
            lines.append(f"{i}. **{j['title']}**, {j['company']} · {sal(j)} · {j['location'][:40]} · "
                         f"{f['tier']} {f['core_fit']}/{f['ambition']} · {j.get('apply_url') or j['url']}")
    urg = [j for j in jobs if urgent(j) and j["fit"]["tier"] != "SKIP"]
    if urg:
        lines.append("")
        lines.append("Closing soon: " + "; ".join(f"{j['title']} ({j['company']}) closes {j['closing']}" for j in urg))
    lines.append("")
    lines.append("Source problems: " + (", ".join(failed) if failed else "none"))
    if report.get("all_live_sources_failed"):
        lines.append("**SYSTEM FAILURE: every live source failed. See source health.**")
    return "\n".join(lines)


def card_md(j):
    f = j["fit"]
    g = "full review" if f.get("graded_by") == "claude" else "auto score"
    tags = (" · PUBLIC SECTOR" if j.get("public_sector") else "") + (" · NEAR SOUTHAMPTON" if j.get("near_southampton") else "")
    out = [f"### {f['tier']} · {DECISION[f['tier']]}: {j['title']}, {j['company']}{tags}",
           f"{sal(j)} · {j['location']} · {j.get('office_note', '')} · core fit {f['core_fit']} / ambition {f['ambition']} ({g})",
           f"Work rights: {f.get('work_rights', 'Not stated')} · via {', '.join(j.get('sources', [j['source']]))} · ATS: {j.get('ats_platform', '')}"]
    if f.get("why_worth_it"):
        out.append(f"Why: {f['why_worth_it']}")
    if f.get("matched"):
        out.append("Matched: " + "; ".join(f["matched"][:4]))
    if f.get("transferable"):
        out.append("Transferable: " + "; ".join(f["transferable"][:3]))
    out.append("Learnable gaps: " + (", ".join(f.get("learnable_gaps") or []) or "none found"))
    if f.get("hard_gaps"):
        out.append("Hard gaps: " + ", ".join(f["hard_gaps"]))
    if f.get("hard_gate_failures"):
        out.append("Gate failures: " + ", ".join(f["hard_gate_failures"]))
    out.append(f"CV: {f.get('cv_variant', '')} · Cover letter: {f.get('cover_letter_angle', '')}")
    if f.get("risk"):
        out.append(f"Risk: {f['risk']}")
    if j.get("package"):
        out.append(f"Package: {j['package']}")
    if j.get("missing_fields"):
        out.append(f"Missing: {', '.join(j['missing_fields'])}")
    out.append(f"Apply: {j.get('apply_url') or j['url']}")
    return "\n".join(out)


def to_markdown(jobs, report):
    date_s = dt.date.today().strftime("%a %d %b %Y")
    md = [f"# Autoline digest: {date_s}", "", summary(jobs, report), ""]
    for tier in ("A", "B", "C"):
        group = [j for j in jobs if j["fit"]["tier"] == tier]
        if group:
            md += [f"## {tier}: {DECISION[tier]} ({len(group)})", ""]
            for j in group:
                md += [card_md(j), ""]
    watch = [j for j in jobs if j["fit"]["tier"] == "D"]
    if watch:
        md += [f"## D: WATCH ({len(watch)})", ""]
        md += [f"- {j['title']}, {j['company']} · {sal(j)} · {j['location'][:40]} · {j['fit']['core_fit']}/{j['fit']['ambition']} · "
               f"gaps: {', '.join(j['fit'].get('learnable_gaps') or []) or '-'} · {j.get('apply_url') or j['url']}" for j in watch]
        md.append("")
    skip = [j for j in jobs if j["fit"]["tier"] == "SKIP"]
    if skip:
        md += [f"## Skipped ({len(skip)})", ""]
        md += [f"- {j['title']}, {j['company']}: {', '.join(j['fit'].get('hard_gate_failures') or ['low fit'])}" for j in skip]
        md.append("")
    md += ["## Source health", ""] + [f"- {l}" for l in health_lines(report)]
    return "\n".join(md)


def to_html(jobs, report):
    e = html.escape
    c = counts(jobs)
    rows = []
    for j in jobs:
        f = j["fit"]
        rows.append(
            "<tr>" + "".join(f"<td style='padding:6px;border-bottom:1px solid #eee;vertical-align:top'>{x}</td>" for x in [
                f"<b>{e(f['tier'])}</b><br><span style='color:#666'>{e(DECISION[f['tier']])}</span>",
                f"<a href='{e(j.get('apply_url') or j['url'])}'>{e(j['title'])}</a><br>{e(j['company'])}",
                e(sal(j)), e(j['location'][:50]) + "<br><span style='color:#666'>" + e(j.get('office_note', '')) + "</span>",
                f"{f['core_fit']} / {f['ambition']}",
                e("; ".join(f.get('matched', [])[:3])),
                e(", ".join(f.get('learnable_gaps') or []) or "-") + ("<br><b>Hard:</b> " + e(", ".join(f['hard_gaps'])) if f.get('hard_gaps') else ""),
                e(f.get('work_rights', '')), e(f.get('cv_variant', '')) + "<br>" + e(f.get('cover_letter_angle', '')),
                e(f.get('why_worth_it', '') or ", ".join(f.get('hard_gate_failures') or [])),
            ]) + "</tr>")
    top = [j for j in jobs if j["fit"]["tier"] in ("A", "B", "C")][:10]
    cards = "".join(
        f"<div style='margin:0 0 14px;padding:10px;border:1px solid #ddd;border-radius:8px'>"
        f"<div style='font-size:12px;color:#666'>{e(j['fit']['tier'])} · {e(DECISION[j['fit']['tier']])} · core {j['fit']['core_fit']} / ambition {j['fit']['ambition']}</div>"
        f"<a href='{e(j.get('apply_url') or j['url'])}' style='font-size:16px;font-weight:600'>{e(j['title'])}</a> · {e(j['company'])}<br>"
        f"{e(sal(j))} · {e(j['location'][:50])} · {e(j.get('office_note', ''))}<br>"
        + (f"<div>{e(j['fit']['why_worth_it'])}</div>" if j['fit'].get('why_worth_it') else "")
        + f"<div style='color:#444;font-size:13px'>Matched: {e('; '.join(j['fit'].get('matched', [])[:3]))}<br>"
          f"Learnable gaps: {e(', '.join(j['fit'].get('learnable_gaps') or []) or 'none found')}<br>"
          f"CV: {e(j['fit'].get('cv_variant', ''))} · Letter: {e(j['fit'].get('cover_letter_angle', ''))}</div></div>"
        for j in top)
    urg = [j for j in jobs if urgent(j) and j["fit"]["tier"] != "SKIP"]
    urg_html = ("<h3>Closing soon</h3><ul>" + "".join(f"<li>{e(j['title'])}, {e(j['company'])}: closes {e(j['closing'])}</li>" for j in urg) + "</ul>") if urg else ""
    fail = "<p style='color:#b00'><b>SYSTEM FAILURE: every live source failed.</b></p>" if report.get("all_live_sources_failed") else ""
    head = ("<th style='text-align:left;padding:6px;border-bottom:2px solid #333'>" + "</th><th style='text-align:left;padding:6px;border-bottom:2px solid #333'>".join(
        ["Tier", "Role", "Salary", "Location", "Fit / Amb", "Matched", "Gaps", "Work rights", "CV / letter", "Why"]) + "</th>")
    return (f"<div style='font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#1a1a1a;max-width:1100px'>"
            f"<h2>Autoline: {dt.date.today():%a %d %b %Y}</h2>{fail}"
            f"<p><b>{len(jobs)} new roles · {c['A'] + c['B'] + c['C']} worth applying to</b> (A {c['A']} · B {c['B']} · C {c['C']} · watch {c['D']} · skip {c['SKIP']})</p>"
            f"{urg_html}<h3>Top {len(top)}</h3>{cards}"
            f"<h3>All new roles</h3><table style='border-collapse:collapse;font-size:13px'><tr>{head}</tr>{''.join(rows)}</table>"
            f"<h3>Source health</h3><ul>" + "".join(f"<li>{e(l)}</li>" for l in health_lines(report)) + "</ul></div>")


def write_all(d, jobs, report):
    open(os.path.join(d, "digest.md"), "w").write(to_markdown(jobs, report))
    open(os.path.join(d, "digest.html"), "w").write(to_html(jobs, report))
    open(os.path.join(d, "summary.md"), "w").write(summary(jobs, report))


def apply_grades(data, grades_path):
    latest = os.path.join(data, "latest")
    jobs = json.load(open(os.path.join(latest, "results.json")))
    report = json.load(open(os.path.join(latest, "health.json")))
    grades = {g["job_id"]: g for g in json.load(open(grades_path))}
    for j in jobs:
        g = grades.get(j["job_id"])
        if not g:
            continue
        tier = g.get("tier", j["fit"]["tier"])
        j["fit"].update({k: v for k, v in g.items() if k != "job_id"})
        j["fit"]["tier"], j["fit"]["decision"], j["fit"]["graded_by"] = tier, DECISION[tier], "claude"
    for j in jobs:
        sp = os.path.join(data, "applications", j["job_id"], "status.json")
        if os.path.exists(sp):
            st = json.load(open(sp))
            j["package"] = f"{st['status']} · job-hunt/data/applications/{j['job_id']}/ (cv.pdf, cover_letter.pdf, checklist.md)"
    jobs.sort(key=lambda j: (ORDER[j["fit"]["tier"]], -j.get("priority", 0)))
    run_dir = os.path.join(data, "runs", report["run_started"][:10])
    for d in (latest, run_dir):
        os.makedirs(d, exist_ok=True)
        json.dump(jobs, open(os.path.join(d, "results.json"), "w"), indent=1, default=str)
        write_all(d, jobs, report)
    c = counts(jobs)
    print(json.dumps({"graded": len(grades), "tiers": c}))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--grades", required=True)
    ap.add_argument("--data", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "data"))
    a = ap.parse_args()
    apply_grades(a.data, a.grades)
