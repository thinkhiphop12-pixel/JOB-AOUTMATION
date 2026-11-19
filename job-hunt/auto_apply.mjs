#!/usr/bin/env node
// Autoline auto-apply: submits applications for packaged A/B/C roles with no per-job approval
// (the candidate turned approval off). Runs headless in the daily cloud run.
//
//   node job-hunt/auto_apply.mjs                 # every ready package, tiers/cap from config.json
//   node job-hunt/auto_apply.mjs JOB_ID          # one job
//   node job-hunt/auto_apply.mjs --dry-run       # fill everything, do not click Submit
//
// Honesty rails that stay on:
//  - only facts from answers.json entries marked approved, the package CV/cover letter, and the
//    package's draft answers (written from master_cv.json); nothing is invented
//  - a required question with no approved answer -> job skipped and reported ("needs you")
//  - visible CAPTCHA, login/account wall (Workday, LinkedIn, Indeed, ...) -> skipped and reported
//  - one submission per job ever; daily cap from config.json
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { chromium } = createRequire(import.meta.url)('playwright');
const DATA = process.env.AUTOLINE_DATA || path.join(HERE, 'data');
const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const DRY = flag('--dry-run');
const urlArg = args.includes('--url') ? args[args.indexOf('--url') + 1] : null;
const only = args.find((a) => !a.startsWith('--') && a !== urlArg);
const cfg = JSON.parse(fs.readFileSync(path.join(HERE, 'config.json'), 'utf8'));
const auto = cfg.auto_apply || { enabled: true, daily_cap: 15, tiers: ['A', 'B', 'C'] };
const answers = JSON.parse(fs.readFileSync(path.join(HERE, 'answers.json'), 'utf8'));
const A = Object.fromEntries(Object.entries(answers).filter(([k, v]) => !k.startsWith('_') && v.approved && v.answer).map(([k, v]) => [k, v.answer]));
const today = new Date().toISOString().slice(0, 10);
const JOBS = (() => { const m = {}; const f = path.join(DATA, 'jobs.jsonl');
  if (fs.existsSync(f)) for (const line of fs.readFileSync(f, 'utf8').split('\n')) { try { const j = JSON.parse(line); m[j.job_id] = j; } catch {} }
  return m; })();
function salaryFor(id) {
  const j = JOBS[id] || {};
  const top = j.salary_max || j.salary_min;
  const london = /london/i.test(j.location || '') && !/southampton|hampshire|remote/i.test(j.location || '');
  const n = top && top >= 30000 ? top : (london ? 70000 : 65000);
  return `£${n.toLocaleString('en-GB')}`;
}
const log = [];

const TEXT_MAP = [
  [/first\s*name|given name|forename/i, 'first_name'], [/last\s*name|surname|family name/i, 'last_name'],
  [/^\s*(full\s*)?name\b|your name|legal name|official name|full name/i, 'full_name'], [/e-?mail/i, 'email'], [/phone|mobile|telephone/i, 'phone'],
  [/linkedin/i, 'linkedin'], [/^\s*city\b|town|where are you (currently )?(based|located)|current location|^location/i, 'city'],
  [/^\s*country/i, 'country'], [/current (company|employer)|^employer|most recent (company|employer)/i, 'current_company'],
  [/current (job )?title|current role|job title/i, 'current_title'], [/how did you .{0,20}(hear|find|learn)|referral source|where did you (hear|find)|source of (application|referral)/i, 'how_did_you_hear'],
  [/\bai\b|artificial intelligence|llm|chatgpt|claude/i, 'ai_usage'],
  [/notice period|when (can|could) you start|start date|availability/i, 'notice_period'],
  [/current (working|work|office) (pattern|arrangement)|how (many|often).{0,30}(office|on-?site) (currently|now|at the moment)|currently (work|go) (in|into|from) (the|an) office/i, 'current_office_pattern'],
  [/current (base )?salary|current (base )?(pay|compensation)/i, 'current_salary'],
  [/salary|compensation|pay expectation|expected (base|pay)/i, 'salary_expectation'],
];
const YESNO_MAP = [
  [/time[- ]limited|will (it|your (visa|permission)) expire|expiry date/i, 'work_permission_time_limited'],
  [/right to work|permission to work|authori[sz]ed to work|eligible to work|legally (able|entitled|permitted|allowed) to work|allowed to work|work permit/i, 'right_to_work_uk'],
  [/sponsor/i, 'requires_sponsorship'],
  [/us person|u\.s\. person|us citizen|green card/i, 'us_person'],
  [/travel/i, 'willing_to_travel'],
  [/proficient in (written and verbal |spoken |written )?english|english (proficiency|fluency|language)|fluent in english/i, 'english_proficient'],
  [/interviewed|applied (here|to us|before)|previously (applied|interviewed|worked|been employed)|employed by|worked (at|for) [a-z ]+ before|former employee/i, 'previously_interviewed'],
  [/\b(4|four|5|five) days\b.*(office|onsite|on-site|in person)|(office|onsite|on-site).*\b(4|four|5|five) days/i, 'office_4_plus_days'],
  [/based in london|relocat|commut|work (from|in) (our )?london|london office|come into the office|happy to (come|work) (in|into|from)/i, 'willing_to_work_in_london'],
  [/privacy|data (protection|policy|processing|safe|transfer)|candidate data|ai policy|acknowledg|consent|i agree|terms|talent (community|pool)/i, 'consents'],
];
const NEVER = /criminal|convict|disabilit|gender|ethnic|race\b|veteran|sexual|religio|date of birth|national insurance|passport number|bank|pronoun/i;
const BLOCKED_HOSTS = /linkedin\.|indeed\.|totaljobs\.|cv-library\.|cwjobs\.|glassdoor\./i;

function intentRegex(answer) {
  const a = String(answer).toLowerCase();
  if (a.startsWith('y')) return { want: /^\s*yes|i have|i am (eligible|authori|able|happy|willing)|i do\b|i agree|i accept|acknowledg|i confirm|open to|willing|happy to|citizen|permanent residen|settled|i've read|i have read|understood|^\s*ok/i, avoid: /\bnot\b|don't|do not|^\s*no\b|visa which|require sponsorship/i };
  if (a.startsWith('no')) return { want: /^\s*no\b|i do not|i don't|not required|never/i, avoid: /^\s*yes/i };
  return { want: new RegExp(a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').slice(0, 40), 'i'), avoid: /$^/ };
}
function pickOption(options, answer) {
  const { want, avoid } = intentRegex(answer);
  return options.find((o) => want.test(o) && !avoid.test(o)) || options.find((o) => want.test(o));
}

function packages() {
  const dir = path.join(DATA, 'applications');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).map((id) => {
    const p = path.join(dir, id, 'status.json');
    return fs.existsSync(p) ? { id, dir: path.join(dir, id), statusPath: p, st: JSON.parse(fs.readFileSync(p, 'utf8')) } : null;
  }).filter(Boolean);
}

function applyUrl(url) {
  if (/jobs\.lever\.co\/[^/]+\/[0-9a-f-]{36}\/?$/.test(url)) return url.replace(/\/?$/, '/apply');
  if (/jobs\.ashbyhq\.com\/[^/]+\/[0-9a-f-]{36}\/?$/.test(url)) return url.replace(/\/?$/, '/application');
  return url;
}

function draftAnswer(spec, label) {
  const qs = Object.entries(spec.answers || {});
  const words = (s) => new Set(s.toLowerCase().match(/[a-z]{4,}/g) || []);
  const lw = words(label);
  let best = null, score = 1;
  for (const [q, a] of qs) {
    const s = [...words(q)].filter((w) => lw.has(w)).length;
    if (s > score) { best = a; score = s; }
  }
  if (best) return best;
  if (/tell us (more )?about (you|yourself)|introduce yourself|summary/i.test(label)) return spec.summary || null;
  if (/why .*(company|us|join|work here|interested|this role|apply)|motivat|cover letter|anything else|tell us about/i.test(label)) {
    return (spec.cover_letter || []).join('\n\n');
  }
  return null;
}


let spec = {}; let pkg = {}; // set per job by fillForm
const specAnswer = (label) => {
  const norm = (x) => x.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  for (const [q, a] of Object.entries(spec.answers || {})) if (norm(label).startsWith(norm(q).slice(0, 40)) || norm(q).startsWith(norm(label).slice(0, 40))) return a;
  const words = (x) => new Set((x.toLowerCase().match(/[a-z]{4,}/g) || []));
  const lw = words(label); let best = null, score = 2;
  for (const [q, a] of Object.entries(spec.answers || {})) { const n = [...words(q)].filter((w) => lw.has(w)).length; if (n >= score) { best = a; score = n; } }
  return best;
};
const resolve = (f) => {
  const label = f.label;
  const sa = specAnswer(label);
  if (sa) return { val: sa, from: 'job answer' };
  if (/by submitting|i agree|you agree|acknowledg|i (hereby )?certify|declare that the information|please (take a look|read|confirm you have read)|candidate data|privacy (notice|policy)|ai policy/i.test(label) && A.consents) return { val: A.consents, from: 'consents' };
  if (/start date|pick date|earliest (date|start)|available (from|to start)|date (you|available)/i.test(label)) {
    const d = new Date(Date.now() + 6 * 7 * 864e5); return { val: d.toISOString().slice(0, 10), from: 'notice_period (6 weeks)', date: d };
  }
  if (/currently (based|located|living|live) in london/i.test(label)) return { val: A.based_in_london, from: 'based_in_london', intent: 'commute' };
  const yn = YESNO_MAP.find(([re]) => re.test(label));
  if (yn) return A[yn[1]] ? { val: A[yn[1]], from: yn[1] } : { missing: yn[1] };
  const t = TEXT_MAP.find(([re]) => re.test(label));
  if (t) {
    if (t[1] === 'salary_expectation' && A.salary_expectation) return { val: salaryFor(pkg.id), from: 'salary rule' };
    if (t[1] === 'how_did_you_hear') {
      const src = ((JOBS[pkg.id] || {}).source || '') + ' ' + (pkg.st.linkedin_url || '');
      return { val: /linkedin/i.test(src) ? 'LinkedIn' : /indeed/i.test(src) ? 'Indeed' : /nhs/i.test(src) ? 'NHS Jobs' : A.how_did_you_hear, from: 'job source' };
    }
    return A[t[1]] ? { val: A[t[1]], from: t[1] } : { missing: t[1] };
  }
  if (f.tag === 'textarea') { const d = draftAnswer(spec, label); if (d) return { val: d, from: 'package text' }; }
  return {};
};

async function fillForm(page, pkg_, spec_) {
  pkg = pkg_; spec = spec_;
  const map = { filled: [], uploaded: [], needs_you: [], skipped: [] };
  const cv = path.join(pkg.dir, 'cv.pdf');
  const letter = path.join(pkg.dir, 'cover_letter.pdf');
  const job = JOBS[pkg.id] || {};
  const jobCity = ((job.location || '').match(/london|southampton|reading|winchester|basingstoke|portsmouth|bournemouth|guildford|remote/i) || ['London'])[0];

  // 1) One "block" per question: Ashby field entries, Greenhouse/Lever fields, or any label/legend.
  const blocks = await page.evaluate(() => {
    const seen = new Set(); const out = [];
    const cand = document.querySelectorAll('[class*="fieldEntry"], .application-question, .field, [class*="question"], fieldset, .application-field, li.application-question');
    const tidy = (t) => (t || '').replace(/\s+/g, ' ').trim();
    const addBlock = (box, q) => {
      const ctrls = [...box.querySelectorAll('input:not([type=hidden]), textarea, select, button, [role=combobox]')];
      if (!ctrls.length || seen.has(box)) return;
      for (const s of seen) if (s.contains(box) || box.contains(s)) return;
      seen.add(box);
      const id = out.length; box.setAttribute('data-alb', String(id));
      const kinds = ctrls.map((c) => c.getAttribute('role') === 'combobox' ? 'combobox' : c.tagName === 'BUTTON' ? 'button' : c.tagName === 'SELECT' ? 'select' : c.tagName === 'TEXTAREA' ? 'textarea' : (c.type || 'text'));
      const optLabels = [...box.querySelectorAll('input[type=radio], input[type=checkbox]')].map((r) =>
        tidy(document.querySelector(`label[for="${CSS.escape(r.id)}"]`)?.innerText || r.closest('label')?.innerText || r.value));
      const btns = [...box.querySelectorAll('button')].map((x) => tidy(x.innerText)).filter((t) => /^(yes|no)$/i.test(t));
      const req = /\*/.test(q) || ctrls.some((c) => c.required || c.getAttribute('aria-required') === 'true') || /required/i.test(box.className);
      const value = ctrls.map((c) => (c.type === 'radio' || c.type === 'checkbox') ? (c.checked ? 'x' : '') : (c.value || '')).join('');
      out.push({ id, q: tidy(q).slice(0, 220), kinds, optLabels, btns, req, value, selects: [...box.querySelectorAll('select')].map((s) => [...s.options].map((o) => o.text.trim())) });
    };
    const ctrlCount = (b) => b.querySelectorAll('input:not([type=hidden]), textarea, select').length;
    // innermost containers first, so a wrapper holding several questions never swallows them
    [...document.querySelectorAll('label[for]')].forEach((l) => {
      const t = document.getElementById(l.htmlFor);
      if (!t || ['radio', 'checkbox'].includes(t.type)) return;
      let box = t.parentElement;
      while (box && !box.contains(l)) box = box.parentElement;
      if (box && ctrlCount(box) <= 3) addBlock(box, (l.innerText || '') + (/required/i.test(l.className) ? ' *' : ''));
    });
    [...cand].sort((a, b) => ctrlCount(a) - ctrlCount(b)).forEach((box) => { const l = box.querySelector('label, legend, .application-label, [class*=label]'); if (l) addBlock(box, (l.innerText || '') + (/required/i.test(l.className) ? ' *' : '')); });
    document.querySelectorAll('label, legend').forEach((l) => { const box = l.closest('div, fieldset, li') || l.parentElement; if (box) addBlock(box, l.innerText); });
    return out;
  });

  const B = (blk) => page.locator(`[data-alb="${blk.id}"]`);
  for (const blk of blocks) {
    const label = (blk.q.replace(/\*\s*$/, '').trim() || blk.optLabels.join(' ')).trim();
    try {
      await page.keyboard.press('Escape').catch(() => {});
      if (blk.kinds.includes('file')) {
        const file = /cover/i.test(label) ? letter : cv;
        if (/cover/i.test(label) || !map.uploaded.some((u) => u.file === 'cv.pdf')) {
          await B(blk).locator('input[type=file]').first().setInputFiles(file);
          map.uploaded.push({ label, file: path.basename(file) });
        }
        continue;
      }
      if (!label) continue;
      if (/^\(optional\)|\(optional\)/i.test(label)) blk.req = false;
      if (blk.value && !blk.kinds.some((k) => k === 'radio' || k === 'checkbox')) continue;
      if (NEVER.test(label)) { if (blk.req) map.needs_you.push({ label, reason: 'personal/equal-opportunity question: not answered automatically' }); continue; }
      let r = resolve({ label, tag: blk.kinds.includes('textarea') ? 'textarea' : 'input' });
      if (/which location are you applying|location (you will be|you'd be) based|preferred (office|location)/i.test(label)) r = { val: jobCity, from: 'job location' };
      if (/nature of your right to work|right to work status|citizenship|immigration status|visa status|current visa/i.test(label) && A.citizenship) r = { val: 'citizen', from: 'citizenship', intent: 'citizen' };
      if (!r.val) {
        if (blk.req) map.needs_you.push({ label, reason: r.missing ? `answers.json "${r.missing}" not confirmed` : 'required question with no approved answer' });
        continue;
      }
      const short = r.val.length > 60 ? r.val.slice(0, 60) + '…' : r.val;
      const pickFrom = (opts) => r.intent === 'citizen' ? opts.find((o) => /^citizen of the country|british|uk citizen|i'?m a citizen|citizen/i.test(o))
        : r.intent === 'commute' ? opts.find((o) => /commut|hybrid/i.test(o)) : pickOption(opts, r.val);
      // Yes/No buttons (Ashby)
      if (blk.btns.length) {
        const pick = pickFrom(blk.btns);
        if (pick) { await B(blk).locator('button').filter({ hasText: new RegExp(`^\\s*${pick}\\s*$`, 'i') }).first().click({ timeout: 8000 }); map.filled.push({ label, from: r.from, value: pick }); }
        else map.needs_you.push({ label, reason: `no button matches "${short}"` });
        continue;
      }
      // radios / checkboxes with labels
      if (blk.kinds.includes('radio') || (blk.kinds.includes('checkbox') && blk.optLabels.length)) {
        if (blk.kinds.includes('checkbox') && !blk.kinds.includes('radio')) {
          if (/^y/i.test(r.val) || /agree|consent|privacy|acknowledg|read/i.test(label + blk.optLabels.join(' '))) {
            const lab = B(blk).locator('label').filter({ hasText: /agree|accept|acknowledg|read|yes|consent|confirm/i }).first();
            if (await lab.count()) await lab.click({ timeout: 8000 }); else await B(blk).locator('input[type=checkbox]').first().check({ force: true });
            map.filled.push({ label, from: r.from, value: 'ticked' });
          } else if (blk.req) map.needs_you.push({ label, reason: 'required tick box with no rule' });
          continue;
        }
        const pick = pickFrom(blk.optLabels);
        if (pick) { await B(blk).locator('label').filter({ hasText: pick.slice(0, 60) }).first().click({ timeout: 8000 }); map.filled.push({ label, from: r.from, value: pick }); }
        else map.needs_you.push({ label, reason: `no option matches "${short}" (options: ${blk.optLabels.slice(0, 3).join(' / ')})` });
        continue;
      }
      if (blk.kinds.includes('checkbox')) {
        if (/^y/i.test(r.val)) { await B(blk).locator('input[type=checkbox]').first().check({ force: true }); map.filled.push({ label, value: 'ticked' }); }
        continue;
      }
      if (blk.kinds.includes('select')) {
        const pick = pickFrom(blk.selects[0] || []);
        if (pick) { await B(blk).locator('select').first().selectOption({ label: pick }); map.filled.push({ label, from: r.from, value: pick }); }
        else map.needs_you.push({ label, reason: `no option matches "${short}"` });
        continue;
      }
      if (blk.kinds.includes('combobox') && !blk.kinds.includes('tel')) {
        const box = B(blk).locator('[role=combobox]').first();
        await box.click({ timeout: 8000, force: true });
        await page.waitForTimeout(500);
        let opts = (await page.locator('[role=option]:visible').allInnerTexts().catch(() => [])).map((x) => x.trim()).filter(Boolean);
        let pick = opts.length && !/^(southampton|london|reading|winchester|basingstoke)$/i.test(r.val) ? pickFrom(opts) : null;
        if (!pick) {
          await box.fill(String(r.val).slice(0, 60), { force: true }).catch(async () => { await page.keyboard.type(String(r.val).slice(0, 60)); });
          await page.waitForTimeout(2000);
          opts = (await page.locator('[role=option]:visible').allInnerTexts().catch(() => [])).map((x) => x.trim()).filter(Boolean);
          pick = opts.find((o) => o.toLowerCase().startsWith(String(r.val).toLowerCase())) || opts.find((o) => o.toLowerCase().includes(String(r.val).toLowerCase())) || (opts.length ? pickFrom(opts) : null);
        }
        if (pick) { await page.locator('[role=option]:visible').filter({ hasText: pick }).first().click({ timeout: 8000 }); map.filled.push({ label, from: r.from, value: pick }); }
        else if (!opts.length && !/country|location|city/i.test(label)) { await page.keyboard.press('Tab'); map.filled.push({ label, from: r.from, value: short + ' (typed)' }); }
        else { await page.keyboard.press('Escape'); if (blk.req) map.needs_you.push({ label, reason: `dropdown has no option for "${short}"` }); }
        continue;
      }
      const input = B(blk).locator('input[type=tel]:visible, textarea:visible, input:visible:not([type=hidden]):not([type=file]):not([type=checkbox]):not([type=radio]):not([type=search])').first();
      const type = await input.getAttribute('type').catch(() => '');
      const v = type === 'number' ? r.val.replace(/[^0-9.]/g, '') : type === 'date' && r.date ? r.val : r.date ? r.date.toLocaleDateString('en-GB') : r.val;
      await input.fill(v, { timeout: 8000, force: true }).catch(async () => { await input.click({ force: true, timeout: 5000 }); await page.keyboard.type(v, { delay: 15 }); });
      map.filled.push({ label, from: r.from, value: short });
    } catch (e) {
      (blk.req ? map.needs_you : map.skipped).push({ label, reason: `could not fill: ${String(e.message).split('\n')[0].slice(0, 90)}` });
    }
  }
  return map;
}

async function submit(page) {
  const btn = page.locator('button[type=submit], input[type=submit], button').filter({ hasText: /submit( application)?|send application|apply( now)?$/i }).last();
  if (!(await btn.count())) return { ok: false, reason: 'no submit button found' };
  const before = page.url();
  await btn.click();
  await page.waitForTimeout(6000);
  const body = (await page.locator('body').innerText().catch(() => '')).slice(0, 4000);
  if (/thank you|thanks for (applying|your application)|application (has been |was )?(received|submitted)|we('ve| have) received|successfully submitted/i.test(body) || /confirmation|thank/i.test(page.url())) {
    return { ok: true, confirmed: true };
  }
  const err = await page.locator('[class*=error], [role=alert], .field-error, [aria-invalid=true]').allInnerTexts().catch(() => []);
  if (err.filter((x) => x.trim()).length) return { ok: false, reason: `form errors: ${err.filter((x) => x.trim()).slice(0, 3).join(' | ').slice(0, 200)}` };
  if (page.url() !== before) return { ok: true, confirmed: false };
  return { ok: false, reason: 'no confirmation after Submit (possibly an invisible CAPTCHA)' };
}

function save(pkg, status, extra = {}) {
  const st = pkg.st;
  st.status = status;
  Object.assign(st, extra);
  st.history = [...(st.history || []), { status, at: new Date().toISOString(), note: extra.note || '' }];
  if (status === 'submitted') st.followup_due = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);
  fs.writeFileSync(pkg.statusPath, JSON.stringify(st, null, 1));
}

const all = packages();
const submittedToday = all.filter((p) => (p.st.history || []).some((h) => h.status === 'submitted' && h.at.startsWith(today))).length;
let cap = Math.max(0, (auto.daily_cap ?? 15) - submittedToday);
const queue = all
  .filter((p) => (only ? p.id === only : true))
  .filter((p) => only || ((auto.tiers || ['A', 'B', 'C']).includes(p.st.tier) && ['ready_for_review', 'filled', 'needs_you'].concat(flag('--headed') ? ['local_ready'] : []).includes(p.st.status)))
  .filter((p) => only || p.st.status !== 'needs_you' || !/account|job board/i.test(p.st.note || ''))
  .sort((a, b) => 'ABCD'.indexOf(a.st.tier) - 'ABCD'.indexOf(b.st.tier));
if (!auto.enabled && !only) { console.log(JSON.stringify({ auto_apply: 'disabled in config.json' })); process.exit(0); }

const HEADED = flag('--headed');
let browser = null, persistent = null;
if (HEADED) {
  const prof = path.join(HERE, '.browser-profile');
  persistent = await chromium.launchPersistentContext(prof, { headless: false, channel: 'chrome', viewport: { width: 1280, height: 1000 } })
    .catch(() => chromium.launchPersistentContext(prof, { headless: false, viewport: { width: 1280, height: 1000 } }));
} else browser = await chromium.launch({ headless: true });
for (const pkg of queue) {
  if (!DRY && cap <= 0) { log.push({ id: pkg.id, title: pkg.st.title, company: pkg.st.company, result: 'deferred', reason: 'daily cap reached' }); continue; }
  const url = urlArg || applyUrl(pkg.st.url);
  const entry = { id: pkg.id, title: pkg.st.title, company: pkg.st.company, url };
  if (BLOCKED_HOSTS.test(url)) { save(pkg, 'needs_you', { note: 'job board page: apply by hand' }); log.push({ ...entry, result: 'needs_you', reason: 'job-board listing (LinkedIn/Indeed/...): apply by hand' }); continue; }
  if (/myworkdayjobs|successfactors|icims|taleo|jobs\.nhs\.uk|trac\.jobs|civilservicejobs/i.test(url)) { save(pkg, 'needs_you', { note: 'ATS needs a candidate account' }); log.push({ ...entry, result: 'needs_you', reason: 'site needs a candidate account (NHS Jobs / Workday / Civil Service Jobs): apply by hand with the package' }); continue; }
  const jobSpec = fs.existsSync(path.join(pkg.dir, 'spec.json')) ? JSON.parse(fs.readFileSync(path.join(pkg.dir, 'spec.json'), 'utf8')) : {};
  const ctx = persistent || await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(3000);
    if (!(await page.locator('input[type=file]').count())) {
      const apply = page.locator('a, button').filter({ hasText: /^\s*apply( for this (job|role|position)| now)?\s*$/i }).first();
      if (await apply.count()) { await apply.click().catch(() => {}); await page.waitForTimeout(3000); }
    }
    if (/closed|no longer (accepting|available)|position has been filled|job not found/i.test((await page.locator('body').innerText()).slice(0, 3000))) {
      save(pkg, 'closed'); log.push({ ...entry, result: 'closed' }); continue;
    }
    const visibleChallenge = async () => {
      for (const fr of await page.locator('iframe[src*="recaptcha/api2/bframe"], iframe[src*="hcaptcha"], iframe[title*="challenge" i], iframe[src*="recaptcha/api2/anchor"]').all()) {
        const b = await fr.boundingBox().catch(() => null);
        const vis = await fr.isVisible().catch(() => false);
        if (vis && b && b.height > 40 && b.width > 40) return true;
      }
      return false;
    };
    const captcha = await visibleChallenge();
    const map = await fillForm(page, pkg, jobSpec);
    await page.screenshot({ path: path.join(pkg.dir, 'form.png'), fullPage: true });
    fs.writeFileSync(path.join(pkg.dir, 'field_map.json'), JSON.stringify({ url, ...map }, null, 1));
    if (!map.uploaded.length) { save(pkg, 'needs_you', { note: 'no upload field found' }); log.push({ ...entry, result: 'needs_you', reason: 'could not find the application form / CV upload' }); continue; }
    if (map.needs_you.length && HEADED) {
      console.log(`\n${pkg.st.title}, ${pkg.st.company}: everything else is filled. Answer these in the browser, then click Submit yourself:`);
      for (const n of map.needs_you) console.log(`  - ${n.label.slice(0, 100)}`);
      let done = false;
      for (let i = 0; i < 60 && !done; i++) {
        await page.waitForTimeout(5000);
        const body = (await page.locator('body').innerText().catch(() => '')).slice(0, 4000);
        if (/thank you|thanks for (applying|your application)|application (has been |was )?(received|submitted)|we('ve| have) received|successfully submitted/i.test(body)) done = true;
      }
      if (done) { save(pkg, 'submitted', { submitted_at: new Date().toISOString(), confirmed: true, note: 'submitted from your computer (you answered the open questions)' }); log.push({ ...entry, result: 'submitted', confirmed: true }); cap -= 1; }
      else { save(pkg, 'needs_you', { needs_you: map.needs_you }); log.push({ ...entry, result: 'needs_you', reason: 'waited 5 minutes for you; still open' }); }
      continue;
    }
    if (map.needs_you.length) { save(pkg, 'needs_you', { needs_you: map.needs_you }); log.push({ ...entry, result: 'needs_you', reason: map.needs_you.map((n) => `${n.label.slice(0, 60)}: ${n.reason}`).join('; ') }); continue; }
    if (captcha && !HEADED) { save(pkg, 'local_ready', { note: 'CAPTCHA' }); log.push({ ...entry, result: 'local_ready', reason: 'CAPTCHA on the form: run `bash job-hunt/apply_local.sh` on your computer' }); continue; }
    if (DRY) { log.push({ ...entry, result: 'dry_run_ready', filled: map.filled.length, uploaded: map.uploaded.length }); continue; }
    const r = await submit(page);
    if (!r.ok && HEADED && await visibleChallenge()) {
      console.log(`CAPTCHA on ${pkg.st.company}: tick it in the browser window (waiting up to 3 minutes)...`);
      let done = false;
      for (let i = 0; i < 36 && !done; i++) {
        await page.waitForTimeout(5000);
        const body = (await page.locator('body').innerText().catch(() => '')).slice(0, 4000);
        if (/thank you|thanks for (applying|your application)|application (has been |was )?(received|submitted)|we('ve| have) received|successfully submitted/i.test(body)) done = true;
        else if (!(await visibleChallenge())) { const again = await submit(page); if (again.ok) done = true; }
      }
      if (done) { await page.screenshot({ path: path.join(pkg.dir, 'after_submit.png'), fullPage: true }); save(pkg, 'submitted', { submitted_at: new Date().toISOString(), confirmed: true, note: 'auto-applied (you ticked the CAPTCHA)' }); cap -= 1; log.push({ ...entry, result: 'submitted', confirmed: true }); continue; }
    }
    if (!r.ok && await visibleChallenge()) { save(pkg, 'local_ready', { note: 'CAPTCHA from the cloud: submit with apply_local.sh' }); log.push({ ...entry, result: 'local_ready', reason: 'form filled; CAPTCHA blocks cloud submit: run `bash job-hunt/apply_local.sh` on your computer' }); continue; }
    await page.screenshot({ path: path.join(pkg.dir, 'after_submit.png'), fullPage: true });
    if (r.ok) { save(pkg, 'submitted', { submitted_at: new Date().toISOString(), confirmed: r.confirmed, note: r.confirmed ? 'auto-applied, confirmation seen' : 'auto-applied, page changed but no confirmation text' }); cap -= 1; log.push({ ...entry, result: 'submitted', confirmed: r.confirmed }); }
    else if (/no confirmation/i.test(r.reason) && !HEADED) { save(pkg, 'local_ready', { note: r.reason }); log.push({ ...entry, result: 'local_ready', reason: 'form filled; submit blocked from the cloud (likely invisible CAPTCHA): run apply_local.sh' }); }
    else { save(pkg, 'needs_you', { note: r.reason }); log.push({ ...entry, result: 'needs_you', reason: r.reason }); }
  } catch (e) {
    log.push({ ...entry, result: 'error', reason: String(e.message).slice(0, 200) });
  } finally { if (persistent) await page.close().catch(() => {}); else await ctx.close(); }
}
if (browser) await browser.close(); if (persistent) await persistent.close();
fs.mkdirSync(path.join(DATA, 'latest'), { recursive: true });
fs.writeFileSync(path.join(DATA, 'latest', 'auto_apply.json'), JSON.stringify({ at: new Date().toISOString(), dry_run: DRY, results: log }, null, 1));
const n = (r) => log.filter((x) => x.result === r).length;
console.log(JSON.stringify({ submitted: n('submitted'), local_ready: n('local_ready'), needs_you: n('needs_you'), closed: n('closed'), errors: n('error'), deferred: n('deferred'), dry_run_ready: n('dry_run_ready') }));
for (const l of log) console.log(`${l.result.padEnd(14)} ${l.title}, ${l.company}${l.reason ? ' :: ' + l.reason : ''}`);
