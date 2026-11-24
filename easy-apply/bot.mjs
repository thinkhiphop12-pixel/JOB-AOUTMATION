// Easy Apply bot: LinkedIn "Easy Apply" + Indeed "Easily apply", run on YOUR computer, in YOUR logged-in browser.
//
//   node bot.mjs --login        first time: log in to LinkedIn and Indeed in the window, then press Enter
//   node bot.mjs                one run on both sites (caps in config.json / my_settings.json)
//   node bot.mjs --linkedin     LinkedIn only        node bot.mjs --indeed     Indeed only
//   node bot.mjs --dry-run      fill forms but never press Submit        node bot.mjs --max 3    stop after 3
//
// Settings: config.json (defaults, updated automatically) + my_settings.json (YOUR changes, never overwritten).
// Rules: answers only from settings (never invents), skips jobs with a required question it can't answer and lists
// the question, never solves CAPTCHAs (it waits for you, or tells you on the dashboard), human pace, daily caps.
// Everything you need to look at is on one page: data/dashboard.html
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(HERE, 'data');
fs.mkdirSync(DATA, { recursive: true });

// ---------- settings: config.json + my_settings.json ----------
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
const merge = (a, b) => { const o = { ...a }; for (const [k, v] of Object.entries(b || {})) o[k] = isObj(v) && isObj(a[k]) ? merge(a[k], v) : v; return o; };
const MY_F = path.join(HERE, 'my_settings.json');
const base = readJson(path.join(HERE, 'config.json'));
if (!fs.existsSync(MY_F)) {
  fs.writeFileSync(MY_F, JSON.stringify({
    _read_me: 'YOUR settings. Anything here overrides config.json and is never overwritten by updates. Copy any setting from config.json here to change it.',
    years: base.years, custom_answers: base.custom_answers,
  }, null, 1));
}
const mine = readJson(MY_F);
// older versions copied these defaults into my_settings.json; drop them if unchanged so new defaults apply
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
if (same(mine.daily_cap, { linkedin: 30, indeed: 30 }) || same(mine.daily_cap, { linkedin: 20, indeed: 20 }) || same(mine.daily_cap, { linkedin: 40, indeed: 40 })) delete mine.daily_cap;
if (same(mine.hand_apply, { enabled: true, min_rating: 95, open_when_new: true })) delete mine.hand_apply;
export const cfg = merge(base, mine);

const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const DRY = flag('--dry-run') || !!cfg.dry_run_by_default;
const MAX = flag('--max') ? Number(argv[argv.indexOf('--max') + 1]) : Infinity;
const INTERACTIVE = !!process.stdin.isTTY;
const CV = ['cv.pdf', 'CV.pdf', 'resume.pdf'].map((f) => path.join(HERE, f)).find((f) => fs.existsSync(f));
const HAND = () => !!(cfg.hand_apply && cfg.hand_apply.enabled);
const KEEP_SCANNING = () => HAND() && !Number.isFinite(MAX); // after the apply cap, keep reading jobs for the hand-apply list

// ---------- helpers ----------
const rand = (a, b) => a + Math.random() * (b - a);
const nap = (p, a = 1200, b = 3000) => p.waitForTimeout(rand(a, b));
const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const today = new Date().toLocaleDateString('en-CA'); // local YYYY-MM-DD
const say = (...a) => console.log(`[${new Date().toLocaleTimeString('en-GB')}]`, ...a);
const esc = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordRe = (w) => new RegExp(`(^|[^a-z0-9])${esc(w.toLowerCase().trim())}($|[^a-z0-9])`); // whole words: "intern" never matches "international"
const hasWord = (text, list) => (list || []).find((w) => wordRe(w).test(String(text).toLowerCase()));
async function ask(q) {
  if (!INTERACTIVE) return '';
  process.stdout.write('\x07');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((r) => rl.question(q, (a) => { rl.close(); r(a); }));
}
async function firstVisible(loc) {
  const n = await loc.count().catch(() => 0);
  for (let i = 0; i < n; i++) if (await loc.nth(i).isVisible().catch(() => false)) return loc.nth(i);
  return null;
}

// ---------- logs ----------
const SEEN_F = path.join(DATA, 'seen.json');
const seen = new Set(fs.existsSync(SEEN_F) ? readJson(SEEN_F) : []);
const LOG_F = path.join(DATA, 'applied.csv');
const HAND_F = path.join(DATA, 'hand_apply.csv');
const Q_F = path.join(DATA, 'questions.json');
if (!fs.existsSync(LOG_F)) fs.writeFileSync(LOG_F, 'date,time,site,result,rating,title,company,location,url,note\n');
if (!fs.existsSync(HAND_F)) fs.writeFileSync(HAND_F, 'date,rating,site,title,company,location,salary,url,why\n');
const csv = (s) => `"${clean(s).replace(/"/g, '""')}"`;
const readCsv = (f) => fs.readFileSync(f, 'utf8').trim().split('\n').slice(1).filter(Boolean).map((l) => l.slice(1, -1).split('","').map((x) => x.replace(/""/g, '"')));
const problems = [];
let newHand = 0;
function record(site, job, result, note = '', rating = '') {
  fs.appendFileSync(LOG_F, [today, new Date().toTimeString().slice(0, 5), site, result, rating, job.title, job.company, job.location, job.url, note].map(csv).join(',') + '\n');
  if (DRY && result !== 'skipped') return; // practice runs don't mark jobs as done
  seen.add(`${site}:${job.id}`);
  fs.writeFileSync(SEEN_F, JSON.stringify([...seen]));
}
function noteQuestions(qs, job) {
  const all = fs.existsSync(Q_F) ? readJson(Q_F) : {};
  for (const q of qs) { const k = clean(q).slice(0, 200); if (!k) continue; all[k] = all[k] || { count: 0, last: '' }; all[k].count += 1; all[k].last = `${job.company}: ${job.title}`; }
  fs.writeFileSync(Q_F, JSON.stringify(all, null, 1));
}
const sentToday = (site) => readCsv(LOG_F).filter((r) => r[0] === today && r[2] === site && r[3] === 'submitted').length;
function companyCountThisWeek(company) {
  if (!company) return 0;
  const since = new Date(Date.now() - 7 * 864e5).toLocaleDateString('en-CA');
  return readCsv(LOG_F).filter((r) => r[3] === 'submitted' && r[0] >= since && r[6].toLowerCase() === company.toLowerCase()).length;
}
function addHandApply(job, r) {
  if (readCsv(HAND_F).some((x) => x[7] === job.url)) return;
  fs.appendFileSync(HAND_F, [today, `${r.pct}%`, job.site, job.title, job.company, job.location, r.salary ? `£${Math.round(r.salary / 1000)}k` : 'not shown', job.url, r.hits.slice(0, 8).join(', ')].map(csv).join(',') + '\n');
  newHand += 1;
}

// ---------- judging a job ----------
const NEAR = /southampton|hampshire|winchester|eastleigh|portsmouth|fareham|basingstoke|romsey|chandler|totton|bournemouth|salisbury|poole|andover|remote/i;
const isLondon = (loc) => /london/i.test(loc || '') && !NEAR.test(loc || '');
export function money(text) {
  // biggest £ figure that looks like an annual salary (£65,000 / £65k / £65K/yr); day and hourly rates are ignored
  const nums = [...String(text).matchAll(/£\s?(\d{2,3})(?:,(\d{3})|(k)\b|(\d{3}))?/gi)].map((m) => m[3] ? +m[1] * 1000 : m[2] ? +(m[1] + m[2]) : m[4] ? +(m[1] + m[4]) : +m[1])
    .filter((n) => n >= 15000 && n <= 400000);
  return nums.length ? Math.max(...nums) : null;
}
export function fitScore(job) {
  const d = `${job.title} ${job.description || ''}`.toLowerCase();
  const hits = (cfg.filters.fit_keywords || []).filter((w) => wordRe(w).test(d));
  return { score: hits.length, hits };
}
// cheap check on the title/company from the search results, before opening the job page
export function titleSkip(title, company = '') {
  const f = cfg.filters;
  if ((f.company_exclude || []).some((c) => company.toLowerCase().includes(c.toLowerCase()))) return 'excluded company';
  if (f.skip_recruitment_agencies && (f.recruitment_agencies || []).some((a) => company.toLowerCase().includes(a.toLowerCase()))) return 'recruitment agency';
  const bad = hasWord(title, f.title_exclude);
  if (bad) return `title has "${bad.trim()}"`;
  if (!hasWord(title, f.title_must_contain_one_of)) return 'title not in your target roles';
  return null;
}
export function whySkip(job) {
  const f = cfg.filters, d = (job.description || '').toLowerCase();
  const t = titleSkip(job.title, job.company);
  if (t) return t;
  const s = (f.skip_if_description_says || []).find((p) => d.includes(p.toLowerCase()));
  if (s) return `advert says "${s}"`;
  if (/\b(4|5|four|five)\s*(days?|x)\b[^.]{0,40}\b(office|on-?site|in person|in-person)\b|\b(office|on-?site)[^.]{0,25}\b(4|5|four|five)\s*days\b|fully (office|on-?site)[- ]based|no (remote|hybrid)|monday (to|-|–) friday[^.]{0,30}(office|on-?site)/.test(d)) return 'needs 4-5 office days';
  if (/\b(active|current|existing|hold|holding|must have|must hold)\b[^.]{0,30}\b(sc|dv|security|ctc|nppv)\b[^.]{0,5}clearance|\b(sc|dv)\s+cleared\b/.test(d)) return 'needs existing security clearance';
  const lang = d.match(/[^.]{0,60}\b(fluent|fluency|native|business[- ]level|professional working proficiency)\b[^.]{0,20}\b(german|french|spanish|italian|dutch|portuguese|arabic|mandarin|japanese|polish|nordic|swedish|danish|norwegian|hebrew|turkish)\b[^.]{0,60}/);
  if (lang && !/desirable|nice to have|bonus|plus|advantage|preferred/.test(lang[0])) return `needs ${lang[2]}`;
  if (f.skip_contract_day_rate && /(£\s?\d{3,4}\s*(-|to|–)?\s*(£\s?\d{3,4})?\s*(per day|a day|\/day|p\/d|pd\b)|day rate|inside ir35|outside ir35)/.test(`${job.salary || ''} ${d}`.toLowerCase())) return 'contract day-rate role';
  const yrs = [...d.matchAll(/\b(\d{1,2})\s*\+?\s*(?:-|to|–)?\s*(?:\d{1,2}\s*)?\+?\s*years?(?:'|’)?\s*(?:of\s+)?(?:[a-z/&-]+\s+){0,4}experience/g)].map((m) => +m[1]).filter((n) => n > 0 && n < 30);
  if (yrs.length && Math.min(...yrs) > (f.max_years_required ?? 99)) return `asks for ${Math.min(...yrs)}+ years`;
  if (f.max_applicants && job.applicants && job.applicants > f.max_applicants) return `${job.applicants}+ applicants already`;
  const top = money(`${job.salary || ''} ${job.description || ''}`);
  const floor = isLondon(job.location) ? f.min_salary_london : f.min_salary;
  if (top && top < floor) return `salary £${Math.round(top / 1000)}k is under £${floor / 1000}k`;
  const fit = fitScore(job);
  if (job.description && fit.score < (f.min_fit_score ?? 0)) return `weak match (${fit.score} of your skills mentioned)`;
  if (cfg.max_per_company_per_week && companyCountThisWeek(job.company) >= cfg.max_per_company_per_week) return `already applied to ${job.company} ${cfg.max_per_company_per_week}x this week`;
  return null;
}
// 0-100% rating: title 25 + your skills in the advert 35 + salary 15 + place/office days 15 + sector 10
const CORE_TITLE = /project|programme|program manager|delivery|implementation|onboarding|customer success|client success|account manager|change|transformation|pmo/;
export function rate(job) {
  const t = job.title.toLowerCase(), d = (job.description || '').toLowerCase(), loc = job.location || '';
  const fit = fitScore(job);
  const top = money(`${job.salary || ''} ${job.description || ''}`);
  const floor = isLondon(loc) ? cfg.filters.min_salary_london : cfg.filters.min_salary;
  const parts = {
    title: CORE_TITLE.test(t) ? 25 : 15,
    skills: Math.round(Math.min(fit.score / 8, 1) * 35),
    salary: !top ? 10 : top >= (cfg.target_salary || floor + 5000) ? 15 : 12,
    place: NEAR.test(loc) || /fully remote|remote[- ]first/.test(d) ? 15 : /\b(1|2|one|two)\s*days?\b[^.]{0,40}\b(office|on-?site|in person)\b/.test(d) ? 13 : 8,
    sector: /payment|fintech|\bnhs\b|universit|public sector|council|government|charity|\bai\b|saas/.test(`${job.company} ${d}`.toLowerCase()) ? 10 : 0,
  };
  return { pct: Object.values(parts).reduce((a, b) => a + b, 0), parts, hits: fit.hits, salary: top };
}

// short tailored note for cover letter / "message to the employer" boxes
const SKILL_WORDS = { stakeholder: 'stakeholder management', salesforce: 'Salesforce', crm: 'CRM', payments: 'payments', fintech: 'fintech', onboarding: 'client onboarding', implementation: 'implementation', project: 'project delivery', programme: 'programme delivery', delivery: 'delivery', governance: 'governance', regulatory: 'regulatory change', compliance: 'compliance', change: 'change management', reporting: 'reporting', excel: 'Excel', 'customer success': 'customer success', adoption: 'adoption', training: 'training', risk: 'risk management', roadmap: 'roadmaps', 'process improvement': 'process improvement', agile: 'Agile delivery', migration: 'migrations', rollout: 'rollouts', international: 'international work', 'cross-functional': 'cross-functional teams', automation: 'automation', ai: 'AI tools' };
export function coverNote(job) {
  const hits = [...new Set(fitScore(job).hits.map((h) => SKILL_WORDS[h]).filter(Boolean))].filter((x, i, a) => !(x === 'delivery' && a.some((y) => /delivery/.test(y) && y !== x))).slice(0, 4);
  const skills_line = hits.length >= 2 ? ` The role's focus on ${hits.slice(0, -1).join(', ')} and ${hits[hits.length - 1]} is exactly the work I do now.` : '';
  return cfg.cover_letter.replaceAll('{title}', job.title || 'this').replaceAll('{company}', job.company || 'your company').replaceAll('{skills_line}', skills_line);
}

// apply order: £target+ first, then salary not shown, then the rest; best fit first within each
export function priority(rt) {
  const group = rt.salary && rt.salary >= (cfg.target_salary || 0) ? 2 : !rt.salary ? 1 : 0;
  return group * 1000 + rt.pct;
}
const PENDING_F = path.join(DATA, 'pending.json');
const loadPending = () => (fs.existsSync(PENDING_F) ? readJson(PENDING_F) : {});
const savePending = (p) => fs.writeFileSync(PENDING_F, JSON.stringify(p));
const k74 = (sal) => (sal && sal >= (cfg.target_salary || Infinity) ? ` £${Math.round(sal / 1000)}k` : '');

// ---------- answering questions ----------
const YES = 'Yes', NO = 'No';
function yearsFor(L) {
  let best = null, len = 0;
  for (const [k, v] of Object.entries(cfg.years || {})) if (!k.startsWith('_') && L.includes(k) && k.length > len) { best = v; len = k.length; }
  if (best !== null) return best;
  if (/\b(total|overall|professional|work) experience\b|years of experience\??$|relevant experience/.test(L)) return cfg.years.total;
  return 0; // a skill you haven't listed: never overclaim
}
export function answerFor(label, kind, job = {}) {
  const L = clean(label).toLowerCase();
  const me = cfg.me;
  if (!L) return null;
  for (const [k, v] of Object.entries(cfg.custom_answers || {})) if (!k.startsWith('_') && L.includes(k.toLowerCase())) return String(v);
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
  if (/street|address line|home address/.test(L)) return null;
  if (/^(city|town|location)\b|current location|where (are you|do you) (currently )?(based|live|located)|city, state/.test(L)) return me.city;
  if (/^country\b|country of residence/.test(L)) return me.country;
  if (/current (company|employer)|most recent (company|employer)/.test(L)) return me.current_company;
  if (/current (job )?title|current role|current position|headline/.test(L)) return me.current_title;
  // equality monitoring: only ever "prefer not to say"; personal checks: never answered
  if (/gender|\bsex\b|ethnic|\brace\b|sexual orientation|religio|disab|veteran|pronoun|marital/.test(L)) return '__PREFER_NOT__';
  if (/criminal|convict|date of birth|national insurance|passport number/.test(L)) return null;
  if (/relative|family member|know anyone|referred|referral/.test(L)) return null;
  if (/driv(ing|er'?s) licen[cs]e|own (a )?(car|vehicle)|access to a (car|vehicle)/.test(L)) return null;
  // consents (before salary, so "accurate" never reads as "rate")
  if (/privacy|consent|i agree|agree to|terms and|acknowledg|i confirm|confirm that|accurate|true and complete|data protection/.test(L)) return YES;
  // money + notice
  if (/current (base )?(salary|pay|compensation)/.test(L)) return String(me.current_salary);
  if (/salary|compensation|pay (expectation|range|requirement)|desired pay|expected pay|day rate|hourly rate/.test(L)) return String(isLondon(job.location) ? me.expected_salary_london : me.expected_salary);
  if (/notice period|when (can|could) you start|start date|available to start|earliest (start|date)/.test(L)) {
    if (kind === 'number') return /week/.test(L) ? String(me.notice_weeks) : String(me.notice_days);
    return me.notice_text;
  }
  // experience
  if (/(how many|number of) years|years of (work |relevant |professional )?experience|years.{0,30}experience|how long have you/.test(L)) return String(yearsFor(L));
  // work rights
  if (/sponsor/.test(L)) return NO;
  if (/require (a )?visa|need (a )?visa|visa (status|requirement)/.test(L)) return NO;
  if (/right to work|authori[sz]ed to work|work authori[sz]ation|legally (able|entitled|allowed|permitted) to work|eligible to work|permission to work|work permit/.test(L)) return /\b(us|u\.s\.|united states|usa|canada|eu|european union)\b/.test(L) ? NO : YES;
  if (/citizen|nationality/.test(L)) {
    if (/\b(us|u\.s\.|united states|american|eu|european union|canad)/.test(L)) return NO;
    if (/british|\buk\b|united kingdom|irish/.test(L)) return YES;
    return kind === 'text' ? 'British' : null;
  }
  if (/(eligible|able) (for|to obtain|to gain|to get).{0,20}(clearance|\bsc\b|bpss|vetting)|undergo.{0,20}(vetting|clearance|check)/.test(L)) return YES;
  if (/(hold|have|possess).{0,25}(security clearance|\bsc\b|\bdv\b)|active clearance/.test(L)) return NO;
  if (/background check|\bdbs\b|reference check|credit check/.test(L)) return YES;
  if (/18 (years|or older)|over (the age of )?18|at least 18|legal age/.test(L)) return YES;
  // work pattern
  if (/\b(4|5|four|five) days\b/.test(L) && /office|on-?site|in person/.test(L)) return NO;
  if (/hybrid|commut|relocat|on-?site|in the office|office (based|location)|travel|work from (our|the) (office|london)|able to work in london|willing to work in|in-person/.test(L)) return YES;
  if (/remote/.test(L)) return YES;
  if (/full[- ]time/.test(L)) return YES;
  if (/fixed[- ]term|contract role|temporary/.test(L)) return YES;
  // education + languages + certificates
  if (/master'?s|postgraduate/.test(L)) return YES;
  if (/bachelor|degree|undergraduate|university/.test(L)) return kind === 'text' ? me.highest_degree : YES;
  if (/highest (level of )?education|education level/.test(L)) return me.highest_degree;
  if (/english/.test(L)) return kind === 'text' ? 'Native / bilingual' : YES;
  if (/french|german|spanish|italian|dutch|portuguese|arabic|mandarin|japanese|polish|hebrew|swedish|danish|norwegian/.test(L)) return NO;
  if (/agilepm|agile pm/.test(L)) return YES;
  if (/prince ?2|\bpmp\b|\bmsp\b|\bapm\b|scrum master|csm certif|itil/.test(L)) return NO;
  // misc
  if (/how did you (hear|find|learn)|where did you (hear|find|see)|^source\b|referral source|application source/.test(L)) return job.site === 'indeed' ? 'Indeed' : 'LinkedIn';
  if (/previously (worked|been employed|applied)|worked (for|at) .{0,30} before|former employee|current employee/.test(L)) return NO;
  if (kind === 'textarea' && /cover letter|covering letter|why (are you|do you want|this role|us)|tell us (about|why)|additional information|message (to|for) (the )?(hiring|employer|recruiter|team)|note (to|for) (the )?(employer|hiring)|anything else|introduce yourself/.test(L))
    return coverNote(job);
  const exp = L.match(/(?:do you have|have you (?:got|had)?|are you (?:experienced|familiar|proficient)|experience (?:with|in|of|using)|worked with|knowledge of|familiar with|proficient (?:in|with))\s+(.{2,80})/);
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
  if (/^\d+$/.test(a)) { // a number against ranges like "3-5 years", "5+", "Less than 1"
    const n = +a;
    for (const o of opts) {
      const s = o.toLowerCase().replace(/,/g, '');
      const r = s.match(/(\d+)\s*(?:-|–|to)\s*(\d+)/); if (r && n >= +r[1] && n <= +r[2]) return o;
      const p = s.match(/(\d+)\s*\+|(\d+) or more|more than (\d+)|over (\d+)/); if (p && n >= +(p[1] || p[2] || p[3] || p[4])) return o;
      const l = s.match(/less than (\d+)|under (\d+)/); if (l && n < +(l[1] || l[2])) return o;
      if (/\d/.test(s) && +s.replace(/[^\d]/g, '') === n) return o;
    }
    return null;
  }
  return opts.find((o) => clean(o).toLowerCase().startsWith(a)) || opts.find((o) => clean(o).toLowerCase().includes(a)) || opts.find((o) => a.includes(clean(o).toLowerCase()) && clean(o).length > 3) || null;
}

// ---------- filling forms (LinkedIn's pop-up and Indeed's apply pages) ----------
async function scanFields(scope) {
  return scope.evaluate((root) => {
    const vis = (e) => !!(e && (e.offsetWidth || e.offsetHeight || e.getClientRects().length));
    const txt = (e) => (e ? (e.innerText || e.textContent || '') : '').replace(/\s+/g, ' ').trim();
    const doc = root.ownerDocument || document;
    let n = Number(root.getAttribute('data-eab-n') || 0);
    const tag = (el) => { const id = `f${n++}`; el.setAttribute('data-eab', id); return id; };
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
      if (el.tagName === 'SELECT') { d.kind = 'select'; d.options = [...el.options].map((o) => o.text.trim()); const s = el.options[el.selectedIndex]; d.filled = el.selectedIndex > 0 || !!(s && s.value && !/select|choose/i.test(s.text)); }
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
    const el = page.locator(`[data-eab="${f.id}"]`);
    try {
      if (f.kind === 'radio' || f.kind === 'checkbox') {
        const pick = ans === null ? null : f.opts.find((o) => o.label === pickOption(f.opts.map((x) => x.label), ans));
        if (!pick) { if (f.required || f.kind === 'radio') unanswered.push(f.label || '(unlabelled choice)'); continue; }
        await page.locator(`[data-eab="${pick.id}"]`).evaluate((x) => { const l = x.id && document.querySelector(`label[for="${CSS.escape(x.id)}"]`); (l || x).click(); });
      } else if (f.kind === 'single-checkbox') {
        if (ans === YES || /agree|consent|confirm|acknowledg|terms|privacy/i.test(f.label)) await el.check({ force: true });
        else if (f.required) unanswered.push(f.label);
      } else if (f.kind === 'select') {
        const pick = ans === null ? null : pickOption(f.options, ans);
        if (!pick) { if (f.required || ans !== null) unanswered.push(f.label); continue; }
        await el.selectOption({ label: pick });
      } else {
        if (ans === null || ans === '__PREFER_NOT__') { if (f.required) unanswered.push(f.label); continue; }
        const v = f.kind === 'number' ? String(ans).replace(/[^\d.]/g, '') : String(ans);
        if (!v) { if (f.required) unanswered.push(f.label); continue; }
        await el.click({ timeout: 5000 }).catch(() => {});
        await el.fill('');
        if (v.length > 120) await el.fill(v); else await el.pressSequentially(v, { delay: rand(20, 60) });
        if (f.kind === 'combobox' || /city|location/i.test(f.label)) {
          await page.waitForTimeout(1500);
          const opt = await firstVisible(page.locator('[role=option], [role=listbox] li'));
          if (opt) await opt.click().catch(() => {}); else await el.press('Enter').catch(() => {});
        }
      }
      await page.waitForTimeout(rand(250, 700));
    } catch {
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

// ---------- CAPTCHAs, logins, site limits ----------
async function challenge(page) {
  if (/checkpoint|captcha|authwall|uas\/login|linkedin\.com\/login|secure\.indeed\.com\/auth/i.test(page.url())) return true;
  const t = (await page.title().catch(() => '')).toLowerCase();
  if (/^just a moment|security check|verify you are human|attention required|are you a robot/.test(t)) return true;
  return (await page.locator('iframe[src*="captcha" i], iframe[title*="challenge" i], iframe[src*="challenges.cloudflare"]').count().catch(() => 0)) > 0;
}
async function waitForHuman(page, why) {
  if (!INTERACTIVE) { problems.push(why); say(`>>> ${why}. Not in a terminal, so stopping this site for now (it's on the dashboard).`); return false; }
  say(`>>> ${why}. Sort it out in the browser window, then press Enter here.`);
  await ask('    Press Enter to carry on... ');
  if (await challenge(page)) { problems.push(why); return false; }
  return true;
}
const LIMIT_RE = /reached (today'?s|the daily|your daily)? ?(easy apply )?(application )?limit|continue applying tomorrow|too many applications|applied to too many|try again tomorrow/i;

// Walk a multi-step apply form: fill, Next ... Submit.
export async function walkForm(page, scopeFn, job, site, isDone) {
  let lastSig = '', same = 0;
  const unanswered = new Set();
  for (let step = 0; step < 14; step++) {
    await nap(page, 900, 1800);
    if (await isDone()) return { result: 'submitted' };
    const scope = await scopeFn();
    if (LIMIT_RE.test(await scope.innerText().catch(() => ''))) return { result: 'stopped', note: 'site daily limit reached' };
    if (await challenge(page) && !(await waitForHuman(page, `${site === 'linkedin' ? 'LinkedIn' : 'Indeed'} CAPTCHA / login check`))) return { result: 'stopped', note: 'CAPTCHA' };
    const write = await firstVisible(scope.locator('button, label, [role=radio], a').filter({ hasText: /^\s*(write|type|add) (a |your )?(cover letter|message|note)/i }));
    if (write && !(await scope.locator('textarea').count())) { await write.click().catch(() => {}); await page.waitForTimeout(800); }
    (await fillFields(page, scope, job)).forEach((q) => unanswered.add(q));
    if (unanswered.size) return { result: 'needs_you', questions: [...unanswered] };
    const fileIn = scope.locator('input[type=file]');
    if (CV && (await fileIn.count()) && /upload (your )?(resume|cv)|resume is required|please upload/i.test(await scope.innerText().catch(() => ''))) await fileIn.first().setInputFiles(CV).catch(() => {});
    const btn = (re) => firstVisible(scope.getByRole('button', { name: re }));
    const submit = await btn(/^\s*submit( your)?( application)?\s*$/i);
    if (submit) {
      if (DRY) return { result: 'dry_run_ok' };
      if (site === 'linkedin') { const cb = scope.locator('#follow-company-checkbox'); if (await cb.isChecked().catch(() => false)) await scope.locator('label[for="follow-company-checkbox"]').click().catch(() => {}); }
      await submit.click();
      await nap(page, 2500, 4500);
      if (await isDone()) return { result: 'submitted' };
      const errs = await visibleErrors(await scopeFn());
      return errs.length ? { result: 'needs_you', questions: errs } : { result: 'submitted', note: 'no confirmation text seen' };
    }
    const next = await btn(/^\s*(continue|next|review|review your application|continue to next step|save and continue)\s*$/i);
    if (!next) return { result: 'stuck', note: 'no Next / Submit button' };
    const sig = clean(await scope.innerText().catch(() => '')).slice(0, 400) + page.url();
    await next.click();
    await nap(page, 1200, 2200);
    const after = await scopeFn();
    const errs = await visibleErrors(after);
    const sig2 = clean(await after.innerText().catch(() => '')).slice(0, 400) + page.url();
    if (sig2 === sig || sig2 === lastSig) { same += 1; if (errs.length || same >= 2) return { result: 'needs_you', questions: errs.length ? errs : ['page would not move on'] }; }
    lastSig = sig;
  }
  return { result: 'stuck', note: 'too many steps' };
}

// ---------- one site, one run (shared by LinkedIn and Indeed) ----------
export const SITES = {
  linkedin: {
    name: 'LinkedIn',
    async start(page) {
      await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded' });
      await nap(page, 2000, 3500);
      return !(/login|authwall|checkpoint/.test(page.url())) || waitForHuman(page, 'LinkedIn: please log in (run.ps1 --login)');
    },
    searchUrl(s, pg) {
      const q = new URLSearchParams({ keywords: s.keywords, location: s.location === 'Remote' ? 'United Kingdom' : s.location, f_TPR: cfg.linkedin.posted, sortBy: 'DD', start: String(pg * 25) });
      if (cfg.linkedin.easy_apply_only) q.set('f_AL', 'true');
      if (s.location === 'Remote') q.set('f_WT', '2'); else if (cfg.linkedin.workplace) q.set('f_WT', cfg.linkedin.workplace);
      return `https://www.linkedin.com/jobs/search/?${q}`;
    },
    async cards(page) {
      for (let i = 0; i < 10; i++) { await page.evaluate(() => { const l = document.querySelector('.jobs-search-results-list, .scaffold-layout__list > div, .scaffold-layout__list'); (l || document.scrollingElement).scrollBy(0, 700); }); await page.waitForTimeout(rand(300, 600)); }
      return page.$$eval('[data-occludable-job-id], [data-job-id]', (els) => {
        const out = new Map();
        for (const e of els) {
          const id = e.getAttribute('data-occludable-job-id') || e.getAttribute('data-job-id');
          if (!/^\d+$/.test(id || '') || out.has(id)) continue;
          const lines = (e.innerText || '').split('\n').map((x) => x.trim()).filter(Boolean);
          out.set(id, { id, title: lines[0] || '', company: lines.find((x, i) => i > 0 && x !== lines[0]) || '', text: lines.join(' '), applied: lines.some((x) => /^applied\b/i.test(x)) });
        }
        return [...out.values()];
      });
    },
    jobUrl: (id) => `https://www.linkedin.com/jobs/view/${id}/`,
    async read(page, job) {
      const top = (sel) => page.locator(sel).first().innerText({ timeout: 3000 }).catch(() => '');
      job.title = clean(await top('h1')) || job.title;
      job.company = clean(await top('.job-details-jobs-unified-top-card__company-name, .jobs-unified-top-card__company-name, [data-test-employer-name]')) || job.company;
      job.location = clean(await top('.job-details-jobs-unified-top-card__primary-description-container, .job-details-jobs-unified-top-card__tertiary-description-container, .jobs-unified-top-card__bullet'));
      job.salary = clean(await top('.job-details-jobs-unified-top-card__job-insight, .job-details-preferences-and-skills'));
      job.description = clean(await top('#job-details, .jobs-description__content, .jobs-box__html-content'));
      const appl = job.location.match(/(?:over\s+)?(\d[\d,]*)\s+(?:applicants|people clicked apply)/i);
      job.applicants = appl ? +appl[1].replace(/,/g, '') : null;
    },
    async applyButton(page) {
      const b = await firstVisible(page.locator('button.jobs-apply-button, button[aria-label*="Easy Apply" i]').filter({ hasText: /easy apply/i }));
      if (b) return { easy: b };
      const applied = /\bapplied\b/i.test(await page.locator('.jobs-s-apply, .jobs-apply-button--top-card').first().innerText().catch(() => ''));
      return { applied };
    },
    async apply(page, ctx, job, btn) {
      await btn.click();
      await nap(page, 1500, 2500);
      const dialog = async () => (await firstVisible(page.locator('[role=dialog]'))) || page.locator('body');
      const done = async () => /application (was )?sent|your application was sent/i.test(await (await dialog()).innerText().catch(() => ''));
      const r = await walkForm(page, dialog, job, 'linkedin', done);
      if (r.result === 'submitted') await page.getByRole('button', { name: /^(done|dismiss|close)$/i }).first().click().catch(() => {});
      else { // close and discard the half-filled application
        await page.locator('[role=dialog] button[aria-label="Dismiss"], [role=dialog] button[aria-label*="close" i]').first().click().catch(() => {});
        await nap(page, 600, 1200);
        await page.getByRole('button', { name: /^discard$/i }).first().click().catch(() => {});
      }
      return r;
    },
  },
  indeed: {
    name: 'Indeed',
    start: async () => true,
    searchUrl(s, pg) {
      const q = new URLSearchParams({ q: s.keywords, l: s.location, radius: String(cfg.indeed.radius), fromage: String(cfg.indeed.days), sort: 'date', start: String(pg * 10) });
      return `https://uk.indeed.com/jobs?${q}${cfg.indeed.easy_apply_only ? '&sc=0kf%3Aattr%28DSQF7%29%3B' : ''}`;
    },
    cards: (page) => page.$$eval('a[data-jk]', (els) => {
      const out = new Map();
      for (const a of els) {
        const id = a.getAttribute('data-jk');
        if (!id || out.has(id)) continue;
        const card = a.closest('.job_seen_beacon, .cardOutline, li, td') || a;
        const co = card.querySelector('[data-testid="company-name"], .companyName');
        out.set(id, { id, title: (a.innerText || '').trim(), company: co ? co.innerText.trim() : '', text: (card.innerText || '').replace(/\s+/g, ' '), applied: /\bapplied\b/i.test(card.innerText || '') });
      }
      return [...out.values()];
    }),
    jobUrl: (id) => `https://uk.indeed.com/viewjob?jk=${id}`,
    async read(page, job) {
      const top = (sel) => page.locator(sel).first().innerText({ timeout: 3000 }).catch(() => '');
      job.title = clean(await top('h1, [data-testid="jobsearch-JobInfoHeader-title"]')).replace(/ - job post$/i, '') || job.title;
      job.company = clean(await top('[data-testid="inlineHeader-companyName"], [data-company-name]')) || job.company;
      job.location = clean(await top('[data-testid="inlineHeader-companyLocation"], [data-testid="job-location"]'));
      job.salary = clean(await top('#salaryInfoAndJobType, [data-testid="jobsearch-OtherJobDetailsContainer"]'));
      job.description = clean(await top('#jobDescriptionText'));
    },
    async applyButton(page) {
      const b = await firstVisible(page.locator('#indeedApplyButton, button[aria-label*="Apply now" i], button:has-text("Apply now")'));
      if (b && !/company site/i.test(await b.innerText().catch(() => ''))) return { easy: b };
      return { applied: /you applied|applied on/i.test(await page.locator('body').innerText().catch(() => '')) };
    },
    async apply(page, ctx, job, btn) {
      const [pop] = await Promise.all([ctx.waitForEvent('page', { timeout: 8000 }).catch(() => null), btn.click()]);
      const ap = pop || page;
      await ap.waitForLoadState('domcontentloaded').catch(() => {});
      await nap(ap, 2500, 4000);
      const done = async () => /application has been submitted|your application has been submitted|you('ve| have) applied|application submitted/i.test(await ap.locator('body').innerText().catch(() => ''));
      const r = await walkForm(ap, async () => ap.locator('body'), job, 'indeed', done);
      if (pop) await pop.close().catch(() => {});
      return r;
    },
  },
};

export async function runSite(key, page, ctx, budget) {
  const site = SITES[key];
  let sent = 0, viewed = 0;
  const viewMax = cfg.max_jobs_viewed_per_run || 40;
  const pending = loadPending();
  for (const [k, p] of Object.entries(pending)) if (seen.has(k) || Date.now() - p.at > 4 * 864e5) delete pending[k];
  const queued = () => Object.values(pending).filter((p) => p.site === key).length;
  const scanDone = () => viewed >= viewMax || (Number.isFinite(MAX) && queued() >= MAX) || (!KEEP_SCANNING() && budget <= 0);
  if (!(await site.start(page))) return 0;

  // PHASE 1: read new jobs. Skip bad fits, put 95%+ non-Easy-Apply jobs on the hand-apply list, queue Easy Apply jobs.
  scan: for (const s of cfg.searches) {
    for (let pg = 0; pg < (cfg[key].max_pages || 1); pg++) {
      if (scanDone()) break scan;
      await page.goto(site.searchUrl(s, pg), { waitUntil: 'domcontentloaded' }).catch(() => {});
      await nap(page, 2500, 4500);
      if (await challenge(page) && !(await waitForHuman(page, `${site.name}: CAPTCHA or login check`))) return sent;
      const cards = (await site.cards(page).catch(() => [])).filter((c) => !seen.has(`${key}:${c.id}`) && !pending[`${key}:${c.id}`]);
      say(`${site.name} "${s.keywords}" / ${s.location} p${pg + 1}: ${cards.length} new`);
      if (!cards.length) break;
      for (const c of cards) {
        if (scanDone()) break scan;
        const job = { id: c.id, site: key, url: site.jobUrl(c.id), title: c.title, company: c.company, location: s.location };
        if (c.applied) { record(key, job, 'skipped', 'already applied'); continue; }
        const quick = titleSkip(c.title, `${c.company} ${c.text || ''}`);
        if (quick) { record(key, job, 'skipped', quick); continue; }
        try {
          viewed += 1;
          await page.goto(job.url, { waitUntil: 'domcontentloaded' });
          await nap(page, 2000, 3500);
          if (await challenge(page) && !(await waitForHuman(page, `${site.name}: CAPTCHA or login check`))) return sent;
          await site.read(page, job);
          job.location = job.location || s.location;
          const why = whySkip(job);
          if (why) { say(`  - skip: ${job.title} (${job.company}): ${why}`); record(key, job, 'skipped', why); continue; }
          const rt = rate(job);
          const b = await site.applyButton(page);
          if (!b.easy) {
            if (!b.applied && HAND() && rt.pct >= cfg.hand_apply.min_rating) { addHandApply(job, rt); say(`  * HAND-APPLY LIST (${rt.pct}%${k74(rt.salary)}): ${job.title} (${job.company})`); record(key, job, 'hand_apply', '', `${rt.pct}%`); }
            else record(key, job, 'skipped', b.applied ? 'already applied' : 'no Easy Apply', `${rt.pct}%`);
            continue;
          }
          pending[`${key}:${job.id}`] = { site: key, at: Date.now(), pct: rt.pct, salary: rt.salary, prio: priority(rt), job: { ...job, description: (job.description || '').slice(0, 4000) } };
          savePending(pending);
          say(`  + queued (${rt.pct}%${k74(rt.salary)}): ${job.title} (${job.company})`);
        } catch (e) {
          say(`  ! error on ${job.title || job.id}: ${String(e.message).split('\n')[0].slice(0, 120)}`);
          record(key, job, 'error', String(e.message).split('\n')[0].slice(0, 150));
        }
      }
    }
  }

  // PHASE 2: apply, best first (£target+ and best fit at the top). Leftovers wait for the next run.
  const order = Object.entries(pending).filter(([, p]) => p.site === key).sort((a, b) => b[1].prio - a[1].prio);
  if (order.length) say(`${site.name}: ${order.length} Easy Apply jobs queued; applying to the best ${Math.min(budget, order.length)}.`);
  for (const [k, p] of order) {
    if (sent >= budget || sent >= MAX) break;
    const job = p.job;
    try {
      await page.goto(job.url, { waitUntil: 'domcontentloaded' });
      await nap(page, 2000, 3500);
      if (await challenge(page) && !(await waitForHuman(page, `${site.name}: CAPTCHA or login check`))) break;
      const b = await site.applyButton(page);
      if (!b.easy) { record(key, job, 'skipped', b.applied ? 'already applied' : 'Easy Apply no longer available', `${p.pct}%`); delete pending[k]; savePending(pending); continue; }
      say(`  > applying (${p.pct}%${k74(p.salary)}): ${job.title} (${job.company})`);
      const r = await site.apply(page, ctx, job, b.easy);
      if (r.result === 'submitted' || r.result === 'dry_run_ok') { sent += 1; say(`  ${DRY ? 'FILLED (dry run)' : 'SENT'} ${sent}/${budget}`); }
      else if (r.questions) { noteQuestions(r.questions, job); say(`  ? needs an answer: ${r.questions.slice(0, 2).join(' | ').slice(0, 160)}`); }
      else say(`  ${r.result}${r.note ? ': ' + r.note : ''}`);
      record(key, job, r.result, r.questions ? r.questions.join(' | ') : r.note || '', `${p.pct}%`);
      delete pending[k]; savePending(pending);
      if (r.result === 'stopped') { problems.push(`${site.name} stopped: ${r.note}`); break; }
      await nap(page, 4000, 9000);
    } catch (e) {
      say(`  ! error on ${job.title}: ${String(e.message).split('\n')[0].slice(0, 120)}`);
      record(key, job, 'error', String(e.message).split('\n')[0].slice(0, 150), `${p.pct}%`);
      delete pending[k]; savePending(pending);
    }
  }
  return sent;
}

// ---------- the one page to look at ----------
function writeDashboard() {
  const h = (x) => String(x ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const log = readCsv(LOG_F);
  const sent = log.filter((r) => r[0] === today && r[3] === 'submitted');
  const since = new Date(Date.now() - 14 * 864e5).toLocaleDateString('en-CA');
  const hand = readCsv(HAND_F).filter((r) => r[0] >= since).reverse();
  const qs = Object.entries(fs.existsSync(Q_F) ? readJson(Q_F) : {}).sort((a, b) => b[1].count - a[1].count).slice(0, 25);
  const week = log.filter((r) => r[0] >= new Date(Date.now() - 7 * 864e5).toLocaleDateString('en-CA') && r[3] === 'submitted').length;
  const html = `<!doctype html><meta charset="utf-8"><title>Job bot</title><style>body{font:15px system-ui;margin:24px auto;max-width:900px;padding:0 16px}h2{margin-top:28px}li{margin:8px 0}.m{color:#555;font-size:13px}.r{background:#0a7;color:#fff;border-radius:6px;padding:1px 6px}.p{background:#fde8e8;border-left:4px solid #c00;padding:8px 12px}</style>
<h1>Job bot · ${h(today)}</h1>
<p><b>${sent.length}</b> sent today · <b>${week}</b> in the last 7 days · last run ${h(new Date().toLocaleTimeString('en-GB'))}</p>
${problems.length ? `<div class="p"><b>Needs you:</b><ul>${[...new Set(problems)].map((p) => `<li>${h(p)}</li>`).join('')}</ul>If it says log in, run <code>run.ps1 --login</code>.</div>` : ''}
<h2>Apply by hand (rated ${h(cfg.hand_apply.min_rating)}%+, last 14 days)</h2>${hand.length ? `<ol>${hand.map((r) => `<li><span class="r">${h(r[1])}</span> <b><a href="${h(r[7])}">${h(r[3])}</a></b> · ${h(r[4])}<br><span class="m">${h(r[5])} · salary ${h(r[6])} · ${h(r[0])} on ${h(r[2])} · matches: ${h(r[8])}</span></li>`).join('')}</ol>` : '<p class="m">None yet.</p>'}
<h2>Next up (applied in this order)</h2>${(() => { const q = Object.values(fs.existsSync(PENDING_F) ? readJson(PENDING_F) : {}).sort((a, b) => b.prio - a.prio).slice(0, 15); return q.length ? `<ol>${q.map((p) => `<li><span class="r">${h(p.pct)}%</span> <a href="${h(p.job.url)}">${h(p.job.title)}</a> · ${h(p.job.company)} <span class="m">${h(p.job.location)} · ${p.salary ? '£' + Math.round(p.salary / 1000) + 'k' : 'salary not shown'} · ${h(p.site)}</span></li>`).join('')}</ol>` : '<p class="m">Queue empty.</p>'; })()}
<h2>Sent today</h2>${sent.length ? `<ol>${sent.map((r) => `<li><a href="${h(r[8])}">${h(r[5])}</a> · ${h(r[6])} <span class="m">${h(r[2])} ${h(r[1])} ${h(r[4])}</span></li>`).join('')}</ol>` : '<p class="m">None yet today.</p>'}
<h2>Questions the bot couldn't answer</h2><p class="m">Answer the common ones once in <code>my_settings.json</code> → <code>custom_answers</code> (a few words from the question, in lower case → your answer) and the bot can apply to those jobs next time.</p>${qs.length ? `<ol>${qs.map(([q, v]) => `<li>${h(q)} <span class="m">(${v.count}x, e.g. ${h(v.last)})</span></li>`).join('')}</ol>` : '<p class="m">None.</p>'}`;
  const f = path.join(DATA, 'dashboard.html');
  fs.writeFileSync(f, html);
  return f;
}

// ---------- main ----------
async function main() {
  const prof = path.join(HERE, '.browser-profile');
  const opts = { headless: false, viewport: null, args: ['--start-maximized'] };
  const ctx = await chromium.launchPersistentContext(prof, { ...opts, channel: 'chrome' }).catch(() => chromium.launchPersistentContext(prof, opts));
  const page = ctx.pages()[0] || await ctx.newPage();
  try {
    if (flag('--login')) {
      await page.goto('https://www.linkedin.com/login');
      await ask('Log in to LinkedIn in the browser window, then press Enter here... ');
      await page.goto('https://secure.indeed.com/auth?hl=en_GB&co=GB');
      await ask('Now log in to Indeed (the account with your CV on it), then press Enter here... ');
      say('Logged in. From now on just run the bot without --login.');
      return;
    }
    const keys = flag('--linkedin') && !flag('--indeed') ? ['linkedin'] : flag('--indeed') && !flag('--linkedin') ? ['indeed'] : ['linkedin', 'indeed'];
    say(DRY ? 'PRACTICE RUN: filling forms but NOT submitting.' : 'Applying for real.');
    let total = 0;
    for (const k of keys) {
      const left = Math.min(cfg.daily_cap[k] - sentToday(k), cfg.per_run_cap?.[k] ?? Infinity, MAX - total);
      if (left <= 0 && !KEEP_SCANNING()) { say(`${SITES[k].name}: cap reached.`); continue; }
      if (left <= 0) say(`${SITES[k].name}: application cap reached; only looking for hand-apply jobs.`);
      total += await runSite(k, page, ctx, Math.max(0, left));
    }
    say(`Done: ${total} ${DRY ? 'forms filled (practice)' : 'applications sent'} this run.`);
  } finally {
    const dash = writeDashboard();
    say(`Dashboard: ${dash}`);
    if ((newHand || problems.length || flag('--open')) && cfg.hand_apply.open_when_new !== false && process.platform === 'win32')
      (await import('node:child_process')).spawn('cmd', ['/c', 'start', '', dash], { detached: true, stdio: 'ignore' }).unref();
    await ctx.close().catch(() => {});
  }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main().catch((e) => { console.error('Error:', e.message); process.exit(1); });
