#!/usr/bin/env node
// Browser-assisted application. Run on YOUR computer, not in the cloud:
//
//   npm install playwright@1.49.1          (once, inside job-hunt/)
//   node job-hunt/assist_apply.mjs JOB_ID
//
// It opens the job's application form in a visible Chrome window using a dedicated profile
// (job-hunt/.browser-profile, so logins you do there persist), fills ONLY fields backed by
// answers.json entries marked approved, uploads the package's CV and cover letter, takes a
// screenshot, writes field_map.json, and STOPS. You review, answer anything left blank and click
// Submit yourself. It never clicks Submit, never solves CAPTCHAs, never guesses visa, salary,
// background-check or eligibility questions, and never uses proxies or other accounts.
//
// Options: --headless --no-wait (used for tests), --url URL (override the form URL)

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { chromium } = createRequire(import.meta.url)('playwright');
const args = process.argv.slice(2);
const jobId = args.find((a) => !a.startsWith('--'));
const flag = (f) => args.includes(f);
const urlArg = args.includes('--url') ? args[args.indexOf('--url') + 1] : null;
const DATA = process.env.AUTOLINE_DATA || path.join(HERE, 'data');
if (!jobId) { console.error('usage: node job-hunt/assist_apply.mjs JOB_ID [--url URL]'); process.exit(1); }

const appDir = path.join(DATA, 'applications', jobId);
const statusPath = path.join(appDir, 'status.json');
if (!fs.existsSync(statusPath)) { console.error(`No package for ${jobId}. Build it first (package.py).`); process.exit(1); }
const status = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
if (status.status === 'draft') { console.error('Package failed validation; fix it before applying:', status.validation_errors); process.exit(1); }
const answers = JSON.parse(fs.readFileSync(path.join(HERE, 'answers.json'), 'utf8'));
const approved = Object.fromEntries(Object.entries(answers).filter(([k, v]) => !k.startsWith('_') && v.approved && v.answer).map(([k, v]) => [k, v.answer]));

// label pattern -> answers key. Anything that looks like eligibility/salary/visa is never auto-filled.
const MAP = [
  [/first\s*name|given name|forename/i, 'first_name'], [/last\s*name|surname|family name/i, 'last_name'],
  [/^(full\s*)?name\b|your name/i, 'full_name'], [/e-?mail/i, 'email'], [/phone|mobile|telephone/i, 'phone'],
  [/linkedin/i, 'linkedin'], [/^city|town|location|where are you based/i, 'city'], [/country of residence|^country/i, 'country'],
  [/current (company|employer)|employer/i, 'current_company'], [/current (job )?title|job title/i, 'current_title'],
  [/how did you hear|source/i, 'how_did_you_hear'],
];
const NEVER = /visa|sponsor|right to work|work permit|authori[sz]ed to work|salary|compensation|pay expectation|criminal|convict|background check|disabilit|gender|ethnic|race|veteran|sexual|religio|date of birth|national insurance|passport|bank|notice period|age\b/i;

const profileDir = path.join(HERE, '.browser-profile');
const launch = { headless: flag('--headless'), viewport: { width: 1280, height: 900 } };
if (!flag('--headless')) launch.channel = 'chrome';
let ctx;
try { ctx = await chromium.launchPersistentContext(profileDir, launch); }
catch { delete launch.channel; ctx = await chromium.launchPersistentContext(profileDir, launch); }
const page = ctx.pages()[0] || (await ctx.newPage());
const target = urlArg || status.url;
console.log(`Opening ${target}`);
await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(2500);

// Greenhouse/Lever/Ashby show an "Apply" button before the form. Open it, but never a submit button.
const applyBtn = page.locator('a,button').filter({ hasText: /^\s*apply( for this job| now)?\s*$/i }).first();
if (await applyBtn.count() && !(await page.locator('input[type=file]').count())) {
  const t = (await applyBtn.innerText()).trim();
  if (!/submit/i.test(t)) { await applyBtn.click().catch(() => {}); await page.waitForTimeout(2500); }
}

const captcha = await page.locator('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="turnstile"], .g-recaptcha, [data-sitekey]').count();
const fields = await page.evaluate(() => {
  const out = [];
  const els = document.querySelectorAll('input:not([type=hidden]):not([type=submit]):not([type=button]), textarea, select');
  els.forEach((el, i) => {
    let label = '';
    if (el.id) { const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`); if (l) label = l.innerText; }
    if (!label) { const l = el.closest('label'); if (l) label = l.innerText; }
    if (!label) label = el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.name || '';
    if (!label) { const p = el.closest('div,fieldset'); if (p) label = (p.querySelector('label,legend,span')?.innerText) || ''; }
    el.setAttribute('data-autoline', String(i));
    out.push({ idx: i, tag: el.tagName.toLowerCase(), type: el.type || '', label: label.trim().replace(/\s+/g, ' ').slice(0, 160),
      required: el.required || /\*/.test(label), value: el.value || '' });
  });
  return out;
});

const fieldMap = { url: target, ats: status.url, captcha_present: Boolean(captcha), filled: [], uploaded: [], skipped: [], needs_you: [] };
const cv = path.join(appDir, 'cv.pdf');
const letter = path.join(appDir, 'cover_letter.pdf');
for (const f of fields) {
  const sel = `[data-autoline="${f.idx}"]`;
  if (f.type === 'file') {
    const file = /cover/i.test(f.label) ? letter : /resume|cv|curriculum/i.test(f.label) || !fieldMap.uploaded.length ? cv : null;
    if (file && fs.existsSync(file)) {
      await page.setInputFiles(sel, file).catch((e) => fieldMap.skipped.push({ label: f.label, reason: `upload failed: ${e.message}` }));
      fieldMap.uploaded.push({ label: f.label, file: path.basename(file) });
    } else fieldMap.needs_you.push({ label: f.label, reason: 'which file to upload' });
    continue;
  }
  if (NEVER.test(f.label)) { fieldMap.needs_you.push({ label: f.label, reason: 'eligibility/salary/personal: answer yourself' }); continue; }
  if (f.value) { fieldMap.skipped.push({ label: f.label, reason: 'already filled' }); continue; }
  const hit = MAP.find(([re]) => re.test(f.label));
  const key = hit?.[1];
  if (key && approved[key] && (f.tag === 'input' || f.tag === 'textarea') && !['checkbox', 'radio'].includes(f.type)) {
    await page.fill(sel, approved[key]).catch((e) => fieldMap.skipped.push({ label: f.label, reason: e.message }));
    fieldMap.filled.push({ label: f.label, from: key, value: approved[key] });
  } else if (f.required || f.tag === 'select' || f.tag === 'textarea') {
    fieldMap.needs_you.push({ label: f.label, reason: key ? `answers.json "${key}" not approved` : 'no approved answer' });
  } else fieldMap.skipped.push({ label: f.label, reason: 'optional, no approved answer' });
}

await page.screenshot({ path: path.join(appDir, 'form.png'), fullPage: true });
fs.writeFileSync(path.join(appDir, 'field_map.json'), JSON.stringify(fieldMap, null, 1));
status.status = 'filled';
status.history = [...(status.history || []), { status: 'filled', at: new Date().toISOString() }];
fs.writeFileSync(statusPath, JSON.stringify(status, null, 1));

console.log(`\nFilled ${fieldMap.filled.length} field(s), uploaded ${fieldMap.uploaded.length} file(s).`);
if (fieldMap.needs_you.length) console.log('Needs you:\n' + fieldMap.needs_you.map((f) => `  - ${f.label || '(unlabelled)'}: ${f.reason}`).join('\n'));
if (captcha) console.log('CAPTCHA on the page: complete it yourself.');
console.log(`Screenshot: ${path.join(appDir, 'form.png')}\nField map: ${path.join(appDir, 'field_map.json')}`);
console.log('\nNothing has been submitted. Review the form in the browser, fix anything, and click Submit yourself.');

if (!flag('--no-wait')) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question('Did you submit it? (y = record as submitted / n = leave as filled) ')).trim().toLowerCase();
  rl.close();
  if (a === 'y') {
    status.status = 'submitted';
    status.followup_due = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);
    status.history.push({ status: 'submitted', at: new Date().toISOString(), note: 'confirmed by you' });
    fs.writeFileSync(statusPath, JSON.stringify(status, null, 1));
    console.log(`Recorded. Follow-up due ${status.followup_due}.`);
  }
}
await ctx.close();
