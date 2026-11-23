// Easy Apply bot: LinkedIn "Easy Apply" + Indeed "Easily apply", run on YOUR computer, in YOUR logged-in browser.
//
//   node bot.mjs --login        first time: log in to LinkedIn and Indeed in the window, then press Enter
//   node bot.mjs                apply on both sites (daily caps in config.json)
//   node bot.mjs --linkedin     LinkedIn only        node bot.mjs --indeed     Indeed only
//   node bot.mjs --dry-run      fill every form but never press Submit (to check it works)
//   node bot.mjs --max 5        stop after 5 applications this run
//
// Rules it follows: answers only from config.json (never invents), skips any job with a required question it
// cannot answer (and lists that question in data/questions_to_answer.txt), never solves CAPTCHAs (it waits for you),
// human pace, daily caps. Results: data/applied.csv
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(HERE, 'data');
fs.mkdirSync(DATA, { recursive: true });
export const cfg = JSON.parse(fs.readFileSync(path.join(HERE, 'config.json'), 'utf8'));
const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const DRY = flag('--dry-run') || cfg.dry_run_by_default;
const MAX = argv.includes('--max') ? Number(argv[argv.indexOf('--max') + 1]) : Infinity;
const INTERACTIVE = process.stdin.isTTY;
const CV = ['cv.pdf', 'CV.pdf', 'resume.pdf'].map((f) => path.join(HERE, f)).find((f) => fs.existsSync(f));

// ---------- small helpers ----------
const rand = (a, b) => a + Math.random() * (b - a);
const nap = (p, a = 1200, b = 3000) => p.waitForTimeout(rand(a, b));
const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const today = new Date().toISOString().slice(0, 10);
const say = (...a) => console.log(`[${new Date().toLocaleTimeString()}]`, ...a);
async function ask(q) {
  if (!INTERACTIVE) return '';
  process.stdout.write('\x07'); // beep
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((r) => rl.question(q, (a) => { rl.close(); r(a); }));
}

// ---------- log + memory ----------
const SEEN_F = path.join(DATA, 'seen.json');
const seen = new Set(fs.existsSync(SEEN_F) ? JSON.parse(fs.readFileSync(SEEN_F, 'utf8')) : []);
const LOG_F = path.join(DATA, 'applied.csv');
if (!fs.existsSync(LOG_F)) fs.writeFileSync(LOG_F, 'date,time,site,result,title,company,location,url,note\n');
const Q_F = path.join(DATA, 'questions_to_answer.txt');
const csv = (s) => `"${clean(s).replace(/"/g, '""')}"`;
function record(site, job, result, note = '') {
  const t = new Date();
  fs.appendFileSync(LOG_F, [today, t.toTimeString().slice(0, 5), site, result, job.title, job.company, job.location, job.url, note].map(csv).join(',') + '\n');
  if (DRY && result !== 'skipped') return; // practice runs don't mark jobs as done
  seen.add(`${site}:${job.id}`);
  fs.writeFileSync(SEEN_F, JSON.stringify([...seen]));
}
function noteQuestions(qs, job) {
  if (!qs.length) return;
  fs.appendFileSync(Q_F, qs.map((q) => `${today}\t${clean(q).slice(0, 200)}\t(${job.company}: ${job.title})`).join('\n') + '\n');
}
function sentToday(site) {
  return fs.readFileSync(LOG_F, 'utf8').split('\n').filter((l) => l.startsWith(`"${today}"`) && l.includes(`"${site}","submitted"`)).length;
}

async function firstVisible(loc) {
  const n = await loc.count();
  for (let i = 0; i < n; i++) if (await loc.nth(i).isVisible().catch(() => false)) return loc.nth(i);
  return null;
}

// ---------- job filters ----------
export function money(text) {
  // biggest £ amount that looks like an annual salary (handles £65,000 / £65k / 65000)
  const nums = [...String(text).matchAll(/£\s?(\d{2,3})(?:,(\d{3})|(k)\b|(\d{3}))?/gi)].map((m) => m[3] ? +m[1] * 1000 : m[2] ? +(m[1] + m[2]) : m[4] ? +(m[1] + m[4]) : +m[1])
    .filter((n) => n >= 15000 && n <= 400000);
  return nums.length ? Math.max(...nums) : null;
}
const esc = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function fitScore(job) {
  const d = `${job.title} ${job.description || ''}`.toLowerCase();
  const hits = (cfg.filters.fit_keywords || []).filter((w) => new RegExp(`\\b${esc(w.toLowerCase())}\\b`).test(d));
  return { score: hits.length, hits };
}
// 0-100% rating of how well a job suits you (used for the hand-apply list)
const CORE_TITLE = /project|programme|program manager|delivery|implementation|onboarding|customer success|client success|account manager|change|transformation|pmo/;
const NEAR = /southampton|hampshire|winchester|eastleigh|portsmouth|fareham|basingstoke|romsey|chandler|totton|bournemouth|salisbury|poole|andover|remote/;
export function rate(job) {
  const t = job.title.toLowerCase(), d = (job.description || '').toLowerCase(), loc = (job.location || '').toLowerCase();
  const fit = fitScore(job);
  const top = money(`${job.salary || ''} ${job.description || ''}`);
  const london = /london/.test(loc) && !NEAR.test(loc);
  const floor = london ? cfg.filters.min_salary_london : cfg.filters.min_salary;
  const parts = {
    title: CORE_TITLE.test(t) ? 25 : 15,
    skills: Math.round(Math.min(fit.score / 8, 1) * 35),
    salary: !top ? 10 : top >= floor + 5000 ? 15 : 12,
    place: NEAR.test(loc) || /fully remote|remote[- ]first/.test(d) ? 15 : /\b(1|2|one|two)\s*days?\b[^.]{0,40}\b(office|on-?site|in person)\b/.test(d) ? 13 : 8,
    sector: /payment|fintech|\bnhs\b|universit|public sector|council|government|charity|\bai\b|saas/.test(`${job.company} ${d}`.toLowerCase()) ? 10 : 0,
  };
  return { pct: Object.values(parts).reduce((a, b) => a + b, 0), parts, hits: fit.hits, salary: top };
}
const HAND_F = path.join(DATA, 'hand_apply.csv');
let newHand = 0;
function addHandApply(job, r) {
  if (!fs.existsSync(HAND_F)) fs.writeFileSync(HAND_F, 'date,rating,site,title,company,location,salary,url,why\n');
  fs.appendFileSync(HAND_F, [today, `${r.pct}%`, job.site, job.title, job.company, job.location, r.salary ? `£${Math.round(r.salary / 1000)}k` : 'not shown', job.url, r.hits.slice(0, 8).join(', ')].map(csv).join(',') + '\n');
  newHand += 1;
  writeHandHtml();
}
function writeHandHtml() {
  const rows = fs.readFileSync(HAND_F, 'utf8').trim().split('\n').slice(1).map((l) => l.slice(1, -1).split('","')).reverse();
  const h = (x) => String(x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const html = `<!doctype html><meta charset="utf-8"><title>Hand-apply list</title><style>body{font:15px system-ui;margin:24px;max-width:900px}li{margin:10px 0}b{font-size:16px}.m{color:#555}.r{background:#0a7;color:#fff;border-radius:6px;padding:1px 6px}</style>
<h2>Jobs worth applying to by hand (rated ${cfg.hand_apply.min_rating}%+)</h2><p class="m">Newest first. These don't have Easy Apply, so open the link and apply on the employer's site.</p><ol>${rows.map((r) => `<li><span class="r">${h(r[1])}</span> <b><a href="${h(r[7])}">${h(r[3])}</a></b> · ${h(r[4])}<br><span class="m">${h(r[5])} · salary ${h(r[6])} · found ${h(r[0])} on ${h(r[2])} · matches: ${h(r[8])}</span></li>`).join('')}</ol>`;
  fs.writeFileSync(path.join(DATA, 'hand_apply.html'), html);
}

function companyCountThisWeek(company) {
  if (!company) return 0;
  const since = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
  return fs.readFileSync(LOG_F, 'utf8').split('\n').filter((l) => l.includes('"submitted"') && l.slice(1, 11) >= since && l.toLowerCase().includes(`"${company.toLowerCase().replace(/"/g, '""')}"`)).length;
}
export function whySkip(job) {
  const f = cfg.filters, t = job.title.toLowerCase(), d = (job.description || '').toLowerCase();
  const co = (job.company || '').toLowerCase();
  if (f.company_exclude.some((c) => co.includes(c.toLowerCase()))) return 'excluded company';
  if (f.skip_recruitment_agencies && (f.recruitment_agencies || []).some((a) => co.includes(a.toLowerCase()))) return 'recruitment agency';
  const bad = f.title_exclude.find((w) => t.includes(w));
  if (bad) return `title has "${bad.trim()}"`;
  if (!f.title_must_contain_one_of.some((w) => t.includes(w))) return 'title not in your target roles';
  const s = f.skip_if_description_says.find((p) => d.includes(p));
  if (s) return `advert says "${s}"`;
  // office days: 4-5 days a week on site
  if (/\b(4|5|four|five)\s*(days?|x)\b[^.]{0,40}\b(office|on-?site|in person|in-person)\b|\b(office|on-?site)[^.]{0,25}\b(4|5|four|five)\s*days\b|fully (office|on-?site)[- ]based|no (remote|hybrid)|monday (to|-|–) friday[^.]{0,30}(office|on-?site)/.test(d)) return 'needs 4-5 office days';
  // security clearance that must already be held
  if (/\b(active|current|existing|hold|holding|must have|must hold)\b[^.]{0,30}\b(sc|dv|security|ctc|nppv)\b[^.]{0,5}clearance|\b(sc|dv)\s+cleared\b/.test(d)) return 'needs existing security clearance';
  // a second language that is required (not "nice to have")
  const lang = d.match(/[^.]{0,60}\b(fluent|fluency|native|business[- ]level|professional working proficiency)\b[^.]{0,20}\b(german|french|spanish|italian|dutch|portuguese|arabic|mandarin|japanese|polish|nordic|swedish|danish|norwegian|hebrew|turkish)\b[^.]{0,60}/);
  if (lang && !/desirable|nice to have|bonus|plus|advantage|preferred/.test(lang[0])) return `needs ${lang[2]}`;
  // contract day-rate roles
  if (f.skip_contract_day_rate && /(£\s?\d{3,4}\s*(-|to|–)?\s*(£\s?\d{3,4})?\s*(per day|a day|\/day|p\/d|pd\b)|day rate|inside ir35|outside ir35)/.test(`${job.salary || ''} ${d}`.toLowerCase())) return 'contract day-rate role';
  // years required way above yours
  const yrs = [...d.matchAll(/\b(\d{1,2})\s*\+?\s*(?:-|to|–)?\s*(?:\d{1,2}\s*)?\+?\s*years?(?:'|’)?\s*(?:of\s+)?(?:[a-z/&-]+\s+){0,4}experience/g)].map((m) => +m[1]).filter((n) => n > 0 && n < 30);
  if (yrs.length && Math.min(...yrs) > (f.max_years_required ?? 99)) return `asks for ${Math.min(...yrs)}+ years`;
  // too many applicants already (LinkedIn)
  if (f.max_applicants && job.applicants && job.applicants > f.max_applicants) return `${job.applicants}+ applicants already`;
  // salary floor (only when a salary is shown)
  const top = money(`${job.salary || ''} ${job.description || ''}`);
  const london = /london/i.test(job.location) && !/southampton|hampshire|remote/i.test(job.location);
  const floor = london ? f.min_salary_london : f.min_salary;
  if (top && top < floor) return `salary £${Math.round(top / 1000)}k is under £${floor / 1000}k`;
  // skills match
  const fit = fitScore(job);
  if (job.description && fit.score < (f.min_fit_score ?? 0)) return `weak match (${fit.score} of your skills mentioned)`;
  // don't spam one employer
  if (cfg.max_per_company_per_week && companyCountThisWeek(job.company) >= cfg.max_per_company_per_week) return `already applied to ${job.company} ${cfg.max_per_company_per_week}x this week`;
  return null;
}

// ---------- answering ----------
const YES = 'Yes', NO = 'No';
function yearsFor(L) {
  let best = null, len = 0;
  for (const [k, v] of Object.entries(cfg.years)) if (L.includes(k) && k.length > len) { best = v; len = k.length; }
  if (best !== null) return best;
  if (/\b(total|overall|professional|work) experience\b|years of experience\??$|relevant experience/.test(L)) return cfg.years.total;
  return 0; // a skill you have not listed: never overclaim
}
export function answerFor(label, kind, job = {}) {
  const L = clean(label).toLowerCase();
  const me = cfg.me;
  if (!L) return null;
  for (const [k, v] of Object.entries(cfg.custom_answers || {})) if (!k.startsWith('_') && L.includes(k.toLowerCase())) return String(v);
  const london = /london/i.test(job.location || '') && !/southampton|hampshire|remote/i.test(job.location || '');
  // identity
  if (/first name|given name|forename/.test(L)) return me.first_name;
  if (/last name|surname|family name/.test(L)) return me.last_name;
  if (/^(full )?name\b|your name|legal name/.test(L)) return `${me.first_name} ${me.last_name}`;
  if (/e-?mail/.test(L)) return me.email;
  if (/country code|phone country/.test(L)) return 'United Kingdom (+44)';
  if (/phone|mobile|telephone/.test(L)) return kind === 'number' ? me.phone_national : me.phone;
  if (/linkedin/.test(L)) return me.linkedin;
  if (/website|portfolio|github/.test(L)) return me.linkedin;
  if (/post ?code|zip/.test(L)) return me.postcode || null;
  if (/^(city|town|location)\b|current location|where (are you|do you) (currently )?(based|live|located)|city, state|address/.test(L)) return me.city;
  if (/^country\b|country of residence/.test(L)) return me.country;
  if (/current (company|employer)|most recent (company|employer)/.test(L)) return me.current_company;
  if (/current (job )?title|current role|current position/.test(L)) return me.current_title;
  if (/headline/.test(L)) return me.current_title;
  // never answered automatically (equality monitoring gets "prefer not to say" only)
  if (/gender|sex\b|ethnic|race\b|sexual orientation|religio|disab|veteran|pronoun|marital/.test(L)) return '__PREFER_NOT__';
  if (/criminal|convict|date of birth|national insurance|passport number/.test(L)) return null;
  // money + notice
  if (/current (base )?(salary|pay|compensation)/.test(L)) return String(me.current_salary);
  if (/salary|compensation|pay (expectation|range|requirement)|desired pay|expected pay|rate/.test(L)) return String(london ? me.expected_salary_london : me.expected_salary);
  if (/notice period|when (can|could) you start|start date|available to start|availability/.test(L)) {
    if (kind === 'number') return /week/.test(L) ? String(me.notice_weeks) : String(me.notice_days);
    return me.notice_text;
  }
  // experience
  if (/(how many|number of) years|years of (work |relevant |professional )?experience|years.{0,30}experience|how long have you/.test(L)) return String(yearsFor(L));
  const exp = L.match(/(?:do you have|have you (?:got|had)?|are you (?:experienced|familiar|proficient)|experience (?:with|in|of|using)|worked with|knowledge of|familiar with|proficient (?:in|with))\s+(.{2,80})/);
  // work rights
  if (/sponsor/.test(L)) return NO;
  if (/require (a )?visa|need (a )?visa|visa (status|requirement)/.test(L)) return NO;
  if (/right to work|authori[sz]ed to work|work authori[sz]ation|legally (able|entitled|allowed|permitted) to work|eligible to work|permission to work|work permit/.test(L)) return YES;
  if (/citizen|nationality/.test(L)) return kind === 'text' ? 'British' : YES;
  if (/(eligible|able) (for|to obtain|to gain|to get).{0,20}(clearance|\bsc\b|bpss|vetting)|undergo.{0,20}(vetting|clearance|check)/.test(L)) return YES;
  if (/(hold|have|possess).{0,25}(security clearance|\bsc\b|\bdv\b)|active clearance/.test(L)) return NO;
  if (/background check|dbs|reference check|credit check/.test(L)) return YES;
  if (/18 (years|or older)|over (the age of )?18|at least 18|legal age/.test(L)) return YES;
  // work pattern
  if (/\b(4|5|four|five) days\b/.test(L) && /office|on-?site|in person/.test(L)) return NO;
  if (/hybrid|commut|relocat|on-?site|in the office|office (based|location)|travel|work from (our|the) (office|london)|able to work in london|willing to work in|in-person/.test(L)) return YES;
  if (/remote/.test(L)) return YES;
  if (/full[- ]time/.test(L)) return YES;
  if (/fixed[- ]term|contract role|temporary/.test(L)) return YES;
  // education + languages
  if (/master'?s|postgraduate/.test(L)) return YES;
  if (/bachelor|degree|undergraduate|university/.test(L)) return kind === 'text' ? me.highest_degree : YES;
  if (/highest (level of )?education|education level/.test(L)) return me.highest_degree;
  if (/english/.test(L)) return kind === 'text' ? 'Native / bilingual' : YES;
  if (/french|german|spanish|italian|dutch|portuguese|arabic|mandarin|japanese|polish|hebrew|swedish|danish|norwegian/.test(L)) return NO;
  if (/agilepm|agile pm/.test(L)) return YES;
  if (/prince ?2|\bpmp\b|\bmsp\b|\bapm\b|scrum master|csm certif|itil/.test(L)) return NO;
  if (/driv(ing|er'?s) licen[cs]e|own (a )?(car|vehicle)|access to a (car|vehicle)/.test(L)) return null;
  // consents + misc
  if (/privacy|consent|i agree|agree to|terms|acknowledg|i confirm|confirm that|accurate|true and complete|data protection/.test(L)) return YES;
  if (/how did you (hear|find|learn)|where did you (hear|find|see)|source/.test(L)) return job.site === 'indeed' ? 'Indeed' : 'LinkedIn';
  if (/previously (worked|been employed|applied)|worked (for|at) .{0,30} before|former employee|current employee/.test(L)) return NO;
  if (/relative|family member|know anyone|referred|referral/.test(L)) return null;
  if (/cover letter|why (are you|do you want|this role|us)|tell us (about|why)|additional information|message to the hiring/.test(L) && kind === 'textarea')
    return cfg.cover_letter.replaceAll('{title}', job.title || 'this').replaceAll('{company}', job.company || 'your company');
  if (exp) return yearsFor(exp[1]) > 0 ? YES : NO;
  return null;
}
const PREFER = /prefer not|decline|don'?t wish|do not wish|rather not|not to (say|disclose|answer)|choose not/i;
export function pickOption(options, ans) {
  const opts = options.filter((o) => clean(o) && !/^(select|select an option|please select|choose|--)/i.test(clean(o)));
  if (ans === '__PREFER_NOT__') return opts.find((o) => PREFER.test(o)) || null;
  const a = clean(ans).toLowerCase();
  const exact = opts.find((o) => clean(o).toLowerCase() === a);
  if (exact) return exact;
  if (a === 'yes') return opts.find((o) => /^\s*yes\b/i.test(o)) || null;
  if (a === 'no') return opts.find((o) => /^\s*no\b/i.test(o)) || null;
  if (/^\d+$/.test(a)) { // numeric answer against ranges like "3-5 years", "5+", "Less than 1"
    const n = +a;
    for (const o of opts) {
      const s = o.toLowerCase().replace(/,/g, '');
      const r = s.match(/(\d+)\s*(?:-|–|to)\s*(\d+)/); if (r && n >= +r[1] && n <= +r[2]) return o;
      const p = s.match(/(\d+)\s*\+|(\d+) or more|more than (\d+)|over (\d+)/); if (p && n >= +(p[1] || p[2] || p[3] || p[4])) return o;
      const l = s.match(/less than (\d+)|under (\d+)/); if (l && n < +(l[1] || l[2])) return o;
      if (+s.replace(/[^\d]/g, '') === n && /\d/.test(s)) return o;
    }
    return null;
  }
  return opts.find((o) => clean(o).toLowerCase().startsWith(a)) || opts.find((o) => clean(o).toLowerCase().includes(a)) || opts.find((o) => a.includes(clean(o).toLowerCase()) && clean(o).length > 3) || null;
}

// ---------- generic form filling (works on LinkedIn's modal and Indeed's apply pages) ----------
async function scanFields(scope) {
  return scope.evaluate((root) => {
    const vis = (e) => !!(e && (e.offsetWidth || e.offsetHeight || e.getClientRects().length));
    const txt = (e) => (e ? (e.innerText || e.textContent || '') : '').replace(/\s+/g, ' ').trim();
    const doc = root.ownerDocument || document;
    let n = Number(root.getAttribute('data-eab-n') || 0);
    const tag = (el) => { const id = `f${Date.now() % 100000}_${n++}`; el.setAttribute('data-eab', id); return id; };
    const labelOf = (el) => {
      if (el.id) { const l = doc.querySelector(`label[for="${CSS.escape(el.id)}"]`); if (l && txt(l)) return txt(l); }
      const lb = el.getAttribute('aria-labelledby'); if (lb) { const t = lb.split(/\s+/).map((i) => txt(doc.getElementById(i))).join(' ').trim(); if (t) return t; }
      const al = el.getAttribute('aria-label'); if (al) return al;
      const wrap = el.closest('label'); if (wrap && txt(wrap)) return txt(wrap);
      let p = el.parentElement;
      for (let i = 0; i < 5 && p; i++, p = p.parentElement) { const l = p.querySelector('label, legend, [class*="label" i], [class*="question" i]'); if (l && txt(l)) return txt(l); }
      return el.placeholder || el.name || '';
    };
    const out = [], inGroup = new Set();
    for (const g of root.querySelectorAll('fieldset, [role=radiogroup], [role=group]')) {
      const ins = [...g.querySelectorAll('input[type=radio], input[type=checkbox]')];
      if (!ins.length || !vis(g)) continue;
      ins.forEach((i) => inGroup.add(i));
      let q = txt(g.querySelector('legend')) || (g.getAttribute('aria-labelledby') ? txt(doc.getElementById(g.getAttribute('aria-labelledby').split(' ')[0])) : '') || g.getAttribute('aria-label') || '';
      if (!q) { let p = g.parentElement; for (let i = 0; i < 3 && p && !q; i++, p = p.parentElement) { const l = p.querySelector('label:not(fieldset label), [class*="label" i]'); if (l && !g.contains(l)) q = txt(l); } }
      out.push({ kind: ins[0].type === 'radio' ? 'radio' : 'checkbox', label: q, required: !!g.querySelector('[required],[aria-required="true"]') || /\*|required/i.test(q),
        filled: ins.some((i) => i.checked), opts: ins.map((i) => ({ id: tag(i), label: labelOf(i) })) });
    }
    for (const el of root.querySelectorAll('input, select, textarea')) {
      if (inGroup.has(el)) continue;
      const t = (el.type || '').toLowerCase();
      if (t === 'checkbox' && vis(el.closest('label') || el)) { out.push({ kind: 'single-checkbox', id: tag(el), label: labelOf(el), filled: el.checked, required: el.required || el.getAttribute('aria-required') === 'true' }); continue; }
      if (['hidden', 'submit', 'button', 'radio', 'checkbox', 'file', 'search', 'image', 'reset'].includes(t) || !vis(el) || el.disabled || el.readOnly) continue;
      const d = { id: tag(el), label: labelOf(el), required: el.required || el.getAttribute('aria-required') === 'true' };
      if (el.tagName === 'SELECT') { d.kind = 'select'; d.options = [...el.options].map((o) => o.text.trim()); const s = el.options[el.selectedIndex]; d.filled = el.selectedIndex > 0 || (s && s.value && !/select|choose/i.test(s.text)); }
      else { d.kind = el.tagName === 'TEXTAREA' ? 'textarea' : el.getAttribute('role') === 'combobox' ? 'combobox' : t === 'number' ? 'number' : 'text'; d.filled = !!el.value.trim(); }
      out.push(d);
    }
    root.setAttribute('data-eab-n', String(n));
    return out;
  });
}

async function fillFields(page, scope, job) {
  const unanswered = [];
  for (const f of await scanFields(scope)) {
    if (f.filled) continue;
    const ans = answerFor(f.label, f.kind, job);
    try {
      if (f.kind === 'radio' || f.kind === 'checkbox') {
        const pick = ans === null ? null : f.opts.find((o) => o.label === pickOption(f.opts.map((x) => x.label), ans));
        if (!pick) { if (f.required || f.kind === 'radio') unanswered.push(f.label || '(unlabelled choice)'); continue; }
        await page.locator(`[data-eab="${pick.id}"]`).evaluate((el) => { const l = el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`); (l || el).click(); });
      } else if (f.kind === 'single-checkbox') {
        if (ans === YES || /agree|consent|confirm|acknowledg|terms|privacy/i.test(f.label)) await page.locator(`[data-eab="${f.id}"]`).check({ force: true });
        else if (f.required) unanswered.push(f.label);
      } else if (f.kind === 'select') {
        const pick = ans === null ? null : pickOption(f.options, ans);
        if (!pick) { if (f.required || ans !== null) unanswered.push(f.label); continue; }
        await page.locator(`[data-eab="${f.id}"]`).selectOption({ label: pick });
      } else {
        if (ans === null || ans === '__PREFER_NOT__') { if (f.required) unanswered.push(f.label); continue; }
        const box = page.locator(`[data-eab="${f.id}"]`);
        const v = f.kind === 'number' ? String(ans).replace(/[^\d.]/g, '') : String(ans);
        if (f.kind === 'number' && !v) { if (f.required) unanswered.push(f.label); continue; }
        await box.click({ timeout: 5000 }).catch(() => {});
        await box.fill('');
        await box.pressSequentially(v.length > 120 ? v.slice(0, 1) : v, { delay: rand(20, 60) });
        if (v.length > 120) await box.fill(v);
        if (f.kind === 'combobox' || /city|location/i.test(f.label)) {
          await page.waitForTimeout(1500);
          const opt = page.locator('[role=option]:visible, [role=listbox] li:visible').first();
          if (await opt.count()) await opt.click().catch(() => {}); else await box.press('Enter').catch(() => {});
        }
      }
      await page.waitForTimeout(rand(250, 700));
    } catch (e) {
      if (f.required) unanswered.push(`${f.label} (could not fill)`);
    }
  }
  return unanswered;
}

async function visibleErrors(scope) {
  return scope.evaluate((root) => [...root.querySelectorAll('[role=alert], .artdeco-inline-feedback--error, [class*="error" i], [id*="error" i]')]
    .filter((e) => (e.offsetWidth || e.offsetHeight) && (e.innerText || '').trim().length > 2 && (e.innerText || '').trim().length < 200)
    .map((e) => e.innerText.replace(/\s+/g, ' ').trim())).catch(() => []);
}

async function challenge(page) {
  const u = page.url();
  if (/checkpoint|challenge|captcha|authwall|uas\/login|\/login|secure\.indeed\.com\/auth/i.test(u)) return true;
  const t = (await page.title().catch(() => '')).toLowerCase();
  if (/just a moment|security check|verify|attention required/.test(t)) return true;
  return (await page.locator('iframe[src*="captcha" i], iframe[title*="challenge" i], iframe[src*="challenges.cloudflare"]').count().catch(() => 0)) > 0;
}
async function waitForHuman(page, why) {
  say(`>>> ${why}. Sort it out in the browser window (log in / tick the box), then press Enter here.`);
  if (!INTERACTIVE) { say('    Not running in a terminal, so stopping this site for today.'); return false; }
  await ask('    Press Enter to carry on... ');
  return !(await challenge(page));
}

const LIMIT_RE = /reached (today'?s|the daily|your daily)? ?(easy apply )?(application )?limit|continue applying tomorrow|too many applications|applied to too many|try again tomorrow/i;
async function hitLimit(scope) { return LIMIT_RE.test(await scope.innerText().catch(() => '')); }

// Walk the multi-step apply form. kinds: next / submit buttons found by name.
export async function walkForm(page, scopeFn, job, site, isDone) {
  let lastSig = '', same = 0;
  const unanswered = new Set();
  for (let step = 0; step < 14; step++) {
    await nap(page, 900, 1800);
    if (await isDone()) return { result: 'submitted' };
    if (await hitLimit(await scopeFn())) return { result: 'stopped', note: 'site daily limit reached' };
    if (await challenge(page)) { if (!(await waitForHuman(page, 'CAPTCHA / login check'))) return { result: 'stopped', note: 'CAPTCHA' }; }
    const scope = await scopeFn();
    (await fillFields(page, scope, job)).forEach((q) => unanswered.add(q));
    // resume upload if a step asks for one and none is chosen
    const fileIn = scope.locator('input[type=file]');
    if (CV && (await fileIn.count()) && /upload (your )?(resume|cv)|resume is required|please upload/i.test(await scope.innerText().catch(() => ''))) {
      await fileIn.first().setInputFiles(CV).catch(() => {});
    }
    const btn = async (re) => firstVisible(scope.getByRole('button', { name: re }));
    const submit = await btn(/^\s*submit( your)?( application)?\s*$/i);
    const next = await btn(/^\s*(continue|next|review|review your application|continue to next step|save and continue)\s*$/i);
    if (unanswered.size) return { result: 'needs_you', questions: [...unanswered] };
    if (submit) {
      if (DRY) return { result: 'dry_run_ok' };
      if (site === 'linkedin') { const fol = scope.locator('label[for="follow-company-checkbox"]'); if (await fol.count()) { const cb = scope.locator('#follow-company-checkbox'); if (await cb.isChecked().catch(() => false)) await fol.click().catch(() => {}); } }
      await submit.click();
      await nap(page, 2500, 4500);
      if (await isDone()) return { result: 'submitted' };
      const errs = await visibleErrors(await scopeFn());
      return errs.length ? { result: 'needs_you', questions: errs } : { result: 'submitted', note: 'no confirmation text seen' };
    }
    if (!next) return { result: 'stuck', note: 'no Next / Submit button' };
    const sig = clean(await scope.innerText().catch(() => '')).slice(0, 400) + page.url();
    await next.click();
    await nap(page, 1200, 2200);
    const errs = await visibleErrors(await scopeFn());
    const sig2 = clean(await (await scopeFn()).innerText().catch(() => '')).slice(0, 400) + page.url();
    if (sig2 === sig || sig2 === lastSig) { same += 1; if (errs.length || same >= 2) return { result: 'needs_you', questions: errs.length ? errs : ['page would not move on'] }; }
    lastSig = sig;
  }
  return { result: 'stuck', note: 'too many steps' };
}

// ---------- LinkedIn ----------
const HAND = () => cfg.hand_apply && cfg.hand_apply.enabled;
const VIEW_MAX = () => cfg.max_jobs_viewed_per_run || 60;
async function linkedin(page, budget) {
  let sent = 0, viewed = 0;
  await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded' });
  await nap(page, 2000, 3500);
  if (/login|authwall|checkpoint/.test(page.url())) { if (!(await waitForHuman(page, 'Log in to LinkedIn'))) return 0; }
  for (const s of cfg.searches) {
    for (let pg = 0; pg < cfg.linkedin.max_pages; pg++) {
      if ((sent >= budget && !HAND()) || viewed >= VIEW_MAX()) return sent;
      const q = new URLSearchParams({ keywords: s.keywords, location: s.location === 'Remote' ? 'United Kingdom' : s.location, f_TPR: cfg.linkedin.posted, sortBy: 'DD', start: String(pg * 25) });
      if (cfg.linkedin.easy_apply_only) q.set('f_AL', 'true');
      if (s.location === 'Remote') q.set('f_WT', '2'); else if (cfg.linkedin.workplace) q.set('f_WT', cfg.linkedin.workplace);
      await page.goto(`https://www.linkedin.com/jobs/search/?${q}`, { waitUntil: 'domcontentloaded' });
      await nap(page, 2500, 4500);
      if (await challenge(page)) { if (!(await waitForHuman(page, 'LinkedIn check'))) return sent; }
      for (let i = 0; i < 10; i++) { await page.evaluate(() => { const l = document.querySelector('.jobs-search-results-list, .scaffold-layout__list > div, .scaffold-layout__list'); (l || document.scrollingElement).scrollBy(0, 700); }); await page.waitForTimeout(rand(300, 600)); }
      const ids = await page.$$eval('[data-occludable-job-id], [data-job-id]', (els) => [...new Set(els.map((e) => e.getAttribute('data-occludable-job-id') || e.getAttribute('data-job-id')).filter((x) => /^\d+$/.test(x || '')))]);
      say(`LinkedIn "${s.keywords}" / ${s.location} page ${pg + 1}: ${ids.length} jobs`);
      if (!ids.length) break;
      for (const id of ids) {
        if ((sent >= budget && !HAND()) || viewed >= VIEW_MAX()) return sent;
        if (seen.has(`linkedin:${id}`)) continue;
        viewed += 1;
        const job = { id, site: 'linkedin', url: `https://www.linkedin.com/jobs/view/${id}/` };
        await page.goto(job.url, { waitUntil: 'domcontentloaded' });
        await nap(page, 2000, 3500);
        const top = (sel) => page.locator(sel).first().innerText({ timeout: 3000 }).catch(() => '');
        job.title = clean(await top('h1'));
        job.company = clean(await top('.job-details-jobs-unified-top-card__company-name, .jobs-unified-top-card__company-name, [data-test-employer-name]'));
        job.location = clean(await top('.job-details-jobs-unified-top-card__primary-description-container, .job-details-jobs-unified-top-card__tertiary-description-container, .jobs-unified-top-card__bullet')) || s.location;
        job.salary = clean(await top('.job-details-jobs-unified-top-card__job-insight, .job-details-preferences-and-skills'));
        job.description = clean(await top('#job-details, .jobs-description__content, .jobs-box__html-content'));
        const appl = (await page.locator('body').innerText().catch(() => '')).match(/(?:over\s+)?(\d[\d,]*)\s+(?:applicants|people clicked apply)/i);
        job.applicants = appl ? +appl[1].replace(/,/g, '') : null;
        if (!job.title) { record('linkedin', job, 'skipped', 'could not read the job page'); continue; }
        const why = whySkip(job);
        if (why) { say(`  – skip: ${job.title} (${job.company}): ${why}`); record('linkedin', job, 'skipped', why); continue; }
        const rt = rate(job);
        const ea = await firstVisible(page.locator('button.jobs-apply-button, button[aria-label*="Easy Apply" i]').filter({ hasText: /easy apply/i }));
        if (!ea) {
          const applied = /\bapplied\b/i.test(await page.locator('.jobs-s-apply, .jobs-apply-button--top-card').first().innerText().catch(() => ''));
          if (!applied && HAND() && rt.pct >= cfg.hand_apply.min_rating) { addHandApply(job, rt); say(`  ★ HAND-APPLY LIST (${rt.pct}%): ${job.title} (${job.company})`); record('linkedin', job, 'hand_apply', `rated ${rt.pct}%`); }
          else record('linkedin', job, 'skipped', applied ? 'already applied' : `no Easy Apply; rated ${rt.pct}%`);
          continue;
        }
        if (sent >= budget) continue; // Easy Apply job but this run's cap is used: leave it for the next run
        say(`  > applying: ${job.title} (${job.company}) · rated ${rt.pct}%`);
        await ea.click();
        await nap(page, 1500, 2500);
        const dialog = async () => (await firstVisible(page.locator('[role=dialog]'))) || page.locator('body');
        const done = async () => /application (was )?sent|your application was sent|applied to/i.test(await (await dialog()).innerText().catch(() => ''));
        const r = await walkForm(page, dialog, job, 'linkedin', done);
        if (r.result === 'submitted') {
          sent += 1; say(`  ✓ SENT (${sent}/${budget})`);
          await page.getByRole('button', { name: /^(done|dismiss|close)$/i }).first().click().catch(() => {});
        } else {
          // close and discard the half-filled application
          await page.locator('[role=dialog] button[aria-label="Dismiss"], [role=dialog] button[aria-label*="close" i]').first().click().catch(() => {});
          await nap(page, 600, 1200);
          await page.getByRole('button', { name: /^discard$/i }).first().click().catch(() => {});
          if (r.questions) { noteQuestions(r.questions, job); say(`  ? needs you: ${r.questions.slice(0, 2).join(' | ').slice(0, 160)}`); }
          else say(`  ${r.result}${r.note ? ': ' + r.note : ''}`);
        }
        record('linkedin', job, r.result, r.questions ? r.questions.join(' | ') : r.note || '');
        if (r.result === 'stopped') { say(`  LinkedIn stopped: ${r.note}`); return sent; }
        await nap(page, 4000, 9000);
        if (sent >= MAX) return sent;
      }
    }
  }
  return sent;
}

// ---------- Indeed ----------
async function indeed(page, ctx, budget) {
  let sent = 0, viewed = 0;
  for (const s of cfg.searches) {
    for (let pg = 0; pg < cfg.indeed.max_pages; pg++) {
      if ((sent >= budget && !HAND()) || viewed >= VIEW_MAX()) return sent;
      const q = new URLSearchParams({ q: s.keywords, l: s.location === 'Remote' ? 'Remote' : s.location, radius: String(cfg.indeed.radius), fromage: String(cfg.indeed.days), sort: 'date', start: String(pg * 10) });
      await page.goto(`https://uk.indeed.com/jobs?${q}${cfg.indeed.easy_apply_only ? '&sc=0kf%3Aattr%28DSQF7%29%3B' : ''}`, { waitUntil: 'domcontentloaded' });
      await nap(page, 2500, 4500);
      if (await challenge(page)) { if (!(await waitForHuman(page, 'Indeed check'))) return sent; }
      const jks = await page.$$eval('a[data-jk], [data-jk]', (els) => [...new Set(els.map((e) => e.getAttribute('data-jk')).filter(Boolean))]);
      say(`Indeed "${s.keywords}" / ${s.location} page ${pg + 1}: ${jks.length} jobs`);
      if (!jks.length) break;
      for (const jk of jks) {
        if ((sent >= budget && !HAND()) || viewed >= VIEW_MAX()) return sent;
        if (seen.has(`indeed:${jk}`)) continue;
        viewed += 1;
        const job = { id: jk, site: 'indeed', url: `https://uk.indeed.com/viewjob?jk=${jk}` };
        await page.goto(job.url, { waitUntil: 'domcontentloaded' });
        await nap(page, 2000, 3500);
        if (await challenge(page)) { if (!(await waitForHuman(page, 'Indeed check'))) return sent; }
        const top = (sel) => page.locator(sel).first().innerText({ timeout: 3000 }).catch(() => '');
        job.title = clean(await top('h1, [data-testid="jobsearch-JobInfoHeader-title"]')).replace(/ - job post$/i, '');
        job.company = clean(await top('[data-testid="inlineHeader-companyName"], [data-company-name]'));
        job.location = clean(await top('[data-testid="inlineHeader-companyLocation"], [data-testid="job-location"]')) || s.location;
        job.salary = clean(await top('#salaryInfoAndJobType, [data-testid="jobsearch-OtherJobDetailsContainer"]'));
        job.description = clean(await top('#jobDescriptionText'));
        if (!job.title) { record('indeed', job, 'skipped', 'could not read the job page'); continue; }
        const why = whySkip(job);
        if (why) { say(`  – skip: ${job.title} (${job.company}): ${why}`); record('indeed', job, 'skipped', why); continue; }
        const btn = await firstVisible(page.locator('#indeedApplyButton, button[aria-label*="Apply now" i], button:has-text("Apply now")'));
        const rt = rate(job);
        if (!btn || /company site/i.test(await btn.innerText().catch(() => ''))) {
          if (HAND() && rt.pct >= cfg.hand_apply.min_rating) { addHandApply(job, rt); say(`  ★ HAND-APPLY LIST (${rt.pct}%): ${job.title} (${job.company})`); record('indeed', job, 'hand_apply', `rated ${rt.pct}%`); }
          else record('indeed', job, 'skipped', `not Easily apply; rated ${rt.pct}%`);
          continue;
        }
        if (sent >= budget) continue;
        say(`  > applying: ${job.title} (${job.company}) · rated ${rt.pct}%`);
        const [pop] = await Promise.all([ctx.waitForEvent('page', { timeout: 8000 }).catch(() => null), btn.click()]);
        const ap = pop || page;
        await ap.waitForLoadState('domcontentloaded').catch(() => {});
        await nap(ap, 2500, 4000);
        const body = async () => ap.locator('body');
        const done = async () => /application has been submitted|your application has been submitted|you('ve| have) applied|application submitted/i.test(await ap.locator('body').innerText().catch(() => ''));
        const r = await walkForm(ap, body, job, 'indeed', done);
        if (r.result === 'submitted') { sent += 1; say(`  ✓ SENT (${sent}/${budget})`); }
        else if (r.questions) { noteQuestions(r.questions, job); say(`  ? needs you: ${r.questions.slice(0, 2).join(' | ').slice(0, 160)}`); }
        else say(`  ${r.result}${r.note ? ': ' + r.note : ''}`);
        record('indeed', job, r.result, r.questions ? r.questions.join(' | ') : r.note || '');
        if (pop) await pop.close().catch(() => {});
        if (r.result === 'stopped') { say(`  Indeed stopped: ${r.note}`); return sent; }
        await nap(page, 4000, 9000);
        if (sent >= MAX) return sent;
      }
    }
  }
  return sent;
}

// ---------- main ----------
async function main() {
  const prof = path.join(HERE, '.browser-profile');
  const opts = { headless: false, viewport: null, args: ['--start-maximized'] };
  const ctx = await chromium.launchPersistentContext(prof, { ...opts, channel: 'chrome' }).catch(() => chromium.launchPersistentContext(prof, opts));
  const page = ctx.pages()[0] || await ctx.newPage();
  if (flag('--login')) {
    await page.goto('https://www.linkedin.com/login');
    await ask('Log in to LinkedIn in the browser window, then press Enter here... ');
    await page.goto('https://secure.indeed.com/auth?hl=en_GB&co=GB');
    await ask('Now log in to Indeed (use the account that has your CV on it), then press Enter here... ');
    say('Logged in. From now on just run the bot without --login.');
    await ctx.close(); return;
  }
  const doLI = !flag('--indeed') || flag('--linkedin'), doIN = !flag('--linkedin') || flag('--indeed');
  say(DRY ? 'DRY RUN: filling forms but NOT submitting.' : 'Applying for real.');
  let total = 0;
  if (doLI) { const left = Math.min(cfg.daily_cap.linkedin - sentToday('linkedin'), cfg.per_run_cap?.linkedin ?? Infinity, MAX); if (left <= 0) say('LinkedIn: application cap reached; only looking for hand-apply jobs.'); if (left > 0 || HAND()) total += await linkedin(page, Math.max(0, left)); }
  if (doIN) { const left = Math.min(cfg.daily_cap.indeed - sentToday('indeed'), cfg.per_run_cap?.indeed ?? Infinity, MAX - total); if (left <= 0) say('Indeed: application cap reached; only looking for hand-apply jobs.'); if (left > 0 || HAND()) total += await indeed(page, ctx, Math.max(0, left)); }
  say(`Done. ${DRY ? 'Dry-run forms completed' : 'Applications sent'} this run: ${total}. Full log: ${LOG_F}`);
  if (newHand) {
    const hf = path.join(DATA, 'hand_apply.html');
    say(`★ ${newHand} new job(s) on your hand-apply list: ${hf}`);
    if (cfg.hand_apply.open_when_new && process.platform === 'win32') (await import('node:child_process')).spawn('cmd', ['/c', 'start', '', hf], { detached: true, stdio: 'ignore' });
  }
  if (fs.existsSync(Q_F)) say(`Questions it could not answer (add answers to config.json custom_answers): ${Q_F}`);
  await ctx.close();
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main().catch((e) => { console.error('Error:', e.message); process.exit(1); });
