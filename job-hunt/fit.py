"""Deterministic ambitious-fit scorer (first pass for every job).

Implements the gates and thresholds of fit_policy.md with keyword evidence. The daily
Claude session then re-grades the top roles in full (requirement by requirement, quoting
profile.md). Scores here are labelled "auto" so the digest never passes them off as that.
"""
import re

# Evidence the profile holds for each capability group (0-4 anchored scale) and the words
# that signal a JD asks for it. Levels come from profile.md; change them there and here together.
GROUPS = {
    "Project delivery": (4, ["project manag", "programme manag", "program manag", "delivery manag", "deliver projects",
                              "project delivery", "pmo", "raid", "milestone", "dependenc", "project plan", "agile",
                              "scrum", "waterfall", "governance", "roadmap", "workstream"]),
    "Regulatory change": (4, ["regulat", "compliance", "mandate", "legislation", "vat", "tax", "e-invoic", "einvoic",
                              "legal deadline", "audit"]),
    "Stakeholder management": (4, ["stakeholder", "cross-functional", "cross functional", "senior leader",                                    "c-suite", "international", "multi-country", "emea", "influenc", "senior stakeholder"]),
    "Customer / account management": (3, ["customer success", "account manag", "client relationship", "client service",
                                          "onboarding", "adoption", "retention", "renewal", "qbr", "business review",
                                          "customer experience", "implementation", "enablement", "churn"]),
    "Data and reporting": (3, ["reporting", "dashboard", "kpi", "data analys", "analytics", "insight", "excel",
                               "data quality", "root cause", "metrics", "mi ", "management information"]),
    "CRM and automation": (3, ["salesforce", "crm", "automation", "power automate", "sharepoint", "macro", "workflow",
                               "ai tool", "generative ai", "llm", "claude"]),
    "Payments / fintech": (4, ["payments", "payment processing", "fintech", "merchant", "acquir", "invoic", "billing",
                               "commission", "pricing model", "financial services", "regulated"]),
    "Training and process": (4, ["training", "playbook", "process improvement", "documentation", "sop", "best practice",
                                 "change management", "upskill"]),
}
# Things the profile lacks: (level, learnable?, terms)
GAPS = {
    "SQL": (1, True, [" sql", "sql "]),
    "Power BI / Tableau": (1, True, ["power bi", "tableau", "looker"]),
    "Jira / Confluence": (1, True, ["jira", "confluence", "asana", "monday.com"]),
    "PRINCE2 / PMP / MSP": (1, True, ["prince2", "pmp", "msp ", "apm pmq"]),
    "Line management": (1, True, ["line manag", "direct reports", "manage a team", "people manag", "lead a team of"]),
    "Sales quota / new business": (1, True, ["quota", "new business", "hunter", "pipeline generation", "cold call"]),
    "Software engineering": (0, False, ["software engineer", "write code", "java ", "typescript", "golang", "c++", "react"]),
    "Accounting qualification": (0, False, ["aca ", "acca", "cima", "chartered accountant", "qualified accountant"]),
}
TITLE_CORE = ["project", "delivery", "programme", "program", "customer success", "client success", "implementation",
              "onboarding", "account manager", "account director", "client director", "client manager", "pmo",
              "change manager", "transformation", "deployment"]
TITLE_ADJ = ["operations", "analyst", "strategy", "partner", "solutions", "relationship", "engagement", "enablement",
             "governance", "commercial", "chief of staff", "product owner", "revenue", "customer", "client", "regulatory"]
SECTOR = ["payment", "fintech", "saas", "artificial intelligence", " ai ", "ai-", "machine learning", "financial technology"]
STRONG_COMPANIES = {"anthropic", "openai", "stripe", "adyen", "wise", "monzo", "gocardless", "truelayer", "intercom",
                    "airwallex", "pleo", "mastercard", "salesforce", "barclays", "nasdaq", "s&p global", "trainline",
                    "deel", "multiverse", "zopa", "paddle", "mollie", "primer"}

HARD_PATTERNS = [
    (r"\b(sc|dv|security|government) clear(ance|ed)\b|\bdv[- ]cleared\b|\bactive sc\b", "Security clearance required"),
    (r"\b(aca|acca|cima)[- ]qualified\b|\bqualified (chartered )?accountant\b", "Accounting qualification required"),
    (r"\b(solicitor|barrister|rics|chartered surveyor)\b", "Professional licence required"),
    (r"(open|available) (only )?to (current )?(employees|staff) of|internal (applicants|candidates) only|only open to (current |existing )?(staff|employees)|"
     r"restricted to (current )?(staff|employees)|for (current )?\w+ (nhs )?(trust )?staff only|internal vacancy", "Internal candidates only"),
    (r"\b(fluen\w*|native)[- ](?:level )?(?:in |speaker of )?(german|french|spanish|italian|dutch|danish|swedish|norwegian|"
     r"finnish|portuguese|japanese|mandarin|cantonese|arabic|polish|korean|turkish)|\b(german|french|spanish|italian|dutch|"
     r"danish|swedish|norwegian|portuguese|japanese|mandarin|arabic|polish)[- ]speaking\b", "Second-language fluency required"),
]


def _has(text, terms):
    """Terms match at a word start, so 'vat' does not hit 'innovative'."""
    return [t for t in terms if re.search(r"(?<![a-z])" + re.escape(t.strip()), text)]


def years_required(text):
    yrs = [int(m.group(1)) for m in re.finditer(r"(\d{1,2})\s*\+?\s*(?:-\s*\d+\s*)?years?(?:'|’)?\s*(?:of\s+)?(?:\w+\s+){0,3}experience", text)]
    return max(yrs) if yrs else None


def work_rights(text):
    if re.search(r"(no|not able to|unable to|cannot|can't|do not) (offer |provide )?(visa )?sponsor", text):
        return "No sponsorship offered: fine if you have UK right to work"
    if "right to work in the uk" in text or "eligible to work in the uk" in text:
        return "UK right to work required"
    if "sponsor" in text:
        return "Mentions visa sponsorship"
    return "Not stated"


PUBLIC = re.compile(r"\bnhs\b|nhs (foundation )?trust|\btrust\b|universit|college|council|borough|county|government|ministry|\bagency\b|"
                    r"authority|police|fire (and|&) rescue|\bhm\b|hmrc|ordnance survey|coastguard|environment agency|national statistics|"
                    r"civil service|\.gov\.uk|\.ac\.uk|\.nhs\.uk|public sector|charity|housing association", re.I)
NEAR_SOTON = re.compile(r"southampton|eastleigh|winchester|portsmouth|fareham|hampshire|chandler|romsey|totton|havant|"
                        r"basingstoke|andover|salisbury|bournemouth|poole|chichester|petersfield|whiteley|isle of wight|newbury|reading|guildford|"
                        r"hursley|chilworth|ringwood|lymington|new forest|bracknell|wokingham|farnborough|aldershot|fleet|camberley|woking|leatherhead|surrey|berkshire|crawley|horsham", re.I)
LONDON_PC = re.compile(r"\blondon\b|\b(E|EC|N|NW|SE|SW|W|WC)\d{1,2}[A-Z]?\s|\b(UB|HA|TW|KT|CR|BR|IG|RM|DA|EN|SM)\d{1,2}\s", re.I)


def commutable(location):
    return bool(NEAR_SOTON.search(location or "") or LONDON_PC.search(location or "") or re.search(r"remote", location or "", re.I))


def priority(job, fit_block, floor, cfg):
    """Higher = act first: public sector and near-Southampton first, then money with best fit."""
    pc = cfg.get("priority", {})
    public = bool(PUBLIC.search(f"{job.get('company', '')} {job.get('apply_url', '')} {job.get('url', '')}"))
    near = bool(NEAR_SOTON.search(job.get("location", ""))) and "london" not in job.get("location", "").lower()
    hi = job.get("salary_max") or job.get("salary_min") or 0
    sal = min(pc.get("salary_boost_cap", 15), max(0, (hi - floor) // 5000 * pc.get("salary_boost_per_5k_over_floor", 3))) if hi else 0
    score = fit_block["core_fit"] + fit_block["ambition"] / 2 + (pc.get("public_sector_boost", 12) if public else 0) \
        + (pc.get("near_southampton_boost", 12) if near else 0) + sal
    return round(score), public, near


def requirements(desc, limit=10):
    lines = [l.strip(" •-*\t") for l in re.split(r"[\n•]|(?<=[.;])\s+(?=[A-Z])", desc) if l.strip()]
    keys = re.compile(r"experience|ability to|able to|knowledge of|proficien|familiar|degree|years|skills|you have|"
                      r"you'll have|you will have|track record|understanding of|comfortable|expertise", re.I)
    out = []
    for l in lines:
        if keys.search(l) and 25 <= len(l) <= 260 and l not in out:
            out.append(l)
        if len(out) >= limit:
            break
    return out


def score(job, salary_floor, office_pattern):
    """Return the auto fit block for one job."""
    title = job["title"].lower()
    text = f" {job['title']} {job.get('description', '')} ".lower()
    gates = []
    for pat, label in HARD_PATTERNS:
        for m in re.finditer(pat, text):
            before = text[max(0, m.start() - 40):m.start()]
            if not re.search(r"bonus|nice to have|nice-to-have|plus|desirable|preferred|advantage|ideally|beneficial", before):
                gates.append(label)
                break
    if office_pattern == "exclude":
        gates.append("4-5 office days")
    hi = job.get("salary_max") or job.get("salary_min")
    if hi and hi < salary_floor:
        gates.append(f"Salary below £{salary_floor // 1000}k floor")
    yrs = years_required(text)
    if yrs and yrs >= 12:
        gates.append(f"Asks for {yrs}+ years")

    matched, gaps, learnable, hard = [], [], [], []
    num = den = 0.0
    for name, (level, terms) in GROUPS.items():
        hits = _has(text, terms)
        if hits:
            w = 2 if len(hits) >= 2 else 1
            num += w * level / 4
            den += w
            matched.append(f"{name} (level {level}): JD mentions {', '.join(sorted(set(h.strip() for h in hits))[:3])}")
    for name, (level, can_learn, terms) in GAPS.items():
        if _has(text, terms):
            num += level / 4
            den += 1
            gaps.append(name)
            (learnable if can_learn else hard).append(name)
    evidence = (num / den * 100) if den else 50.0
    title_align = 100 if any(t in title for t in TITLE_CORE) else 70 if any(t in title for t in TITLE_ADJ) else 40
    core = 0.30 * title_align + 0.70 * evidence
    if yrs and 8 <= yrs < 12:
        core -= 5
    core = round(max(0, min(100, core)))

    amb = 50
    if hi and hi >= salary_floor + 10000:
        amb += 15
    elif hi and hi >= salary_floor:
        amb += 8
    if any(s in text for s in SECTOR) or job.get("company", "").lower() in STRONG_COMPANIES:
        amb += 10
    if job.get("company", "").lower() in STRONG_COMPANIES:
        amb += 5
    if office_pattern == "ok":
        amb += 10
    elif office_pattern == "three":
        amb -= 15
    if re.search(r"\b(senior|lead|head|principal|manager|director)\b", title):
        amb += 5
    if gaps and not hard:
        amb += 5
    if hard:
        amb -= 15
    amb = max(0, min(100, amb))

    if gates:
        tier, decision = "SKIP", "SKIP"
    elif core >= 85:
        tier, decision = "A", "APPLY NOW"
    elif core >= 75 and amb >= 60:
        tier, decision = "B", "APPLY - STRONG"
    elif (70 <= core < 80 and amb >= 50) or (65 <= core < 75 and amb >= 70):
        tier, decision = "C", "APPLY - STRETCH"
    elif core >= 65 or (core >= 55 and amb >= 80):
        tier, decision = "D", "WATCH"
    else:
        tier, decision = "SKIP", "SKIP"

    lead = matched[0].split(" (")[0] if matched else "your multi-country delivery record"
    return {
        "eligibility": "FAIL" if gates else "PASS", "hard_gate_failures": gates,
        "core_fit": core, "ambition": amb, "tier": tier, "decision": decision, "graded_by": "auto",
        "matched": matched, "learnable_gaps": learnable, "hard_gaps": hard,
        "years_required": yrs, "work_rights": work_rights(text),
        "cv_variant": cv_variant(title, text),
        "cover_letter_angle": f"Lead with {lead.lower()}; " + (
            f"say you are building {', '.join(learnable[:2])}." if learnable else "show the payments/regulated-change record."),
    }


def cv_variant(title, text):
    if any(t in title for t in ["customer success", "client success", "account", "client", "onboarding", "implementation",
                                "relationship", "partner", "adoption"]):
        return "customer-success"
    if any(t in title for t in ["analyst", "insight", "reporting", "data", "analytics"]):
        return "analyst"
    return "project-delivery"
