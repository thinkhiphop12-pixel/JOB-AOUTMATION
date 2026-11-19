#!/usr/bin/env node
// Calm local mode: ONE application at a time. Opens the form, fills it from your package and approved
// answers, then STOPS. You check it and click Submit yourself. Never clicks Submit, never opens a second tab.
//   node job-hunt/one_by_one.mjs            (the fully-filled "local_ready" ones first)
//   node job-hunt/one_by_one.mjs --all      (also other forms that are not account-only sites)
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const { chromium } = createRequire(import.meta.url)('playwright');
const DATA = path.join(HERE, 'data', 'applications');
const all = process.argv.includes('--all');
const skipHosts = /linkedin\.|indeed\.|myworkdayjobs|jobs\.nhs\.uk|successfactors|icims|taleo|civilservicejobs/i;
const items = fs.readdirSync(DATA).map((id) => ({ id, p: path.join(DATA, id, 'status.json') }))
  .filter((x) => fs.existsSync(x.p)).map((x) => ({ ...x, st: JSON.parse(fs.readFileSync(x.p, 'utf8')) }))
  .filter((x) => x.st.status === 'local_ready' || (all && x.st.status === 'needs_you' && !skipHosts.test(x.st.url)))
  .sort((a, b) => (a.st.status === 'local_ready' ? 0 : 1) - (b.st.status === 'local_ready' ? 0 : 1) || 'ABCD'.indexOf(a.st.tier) - 'ABCD'.indexOf(b.st.tier));
console.log(`${items.length} application(s) to go through, one at a time.\n`);
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ctx = await chromium.launchPersistentContext(path.join(HERE, '.browser-profile'), { headless: false, channel: 'chrome', viewport: null })
  .catch(() => chromium.launchPersistentContext(path.join(HERE, '.browser-profile'), { headless: false, viewport: null }));
const page = ctx.pages()[0] || await ctx.newPage();
let n = 0, sent = 0;
for (const it of items) {
  n++;
  const st = it.st, dir = path.join(DATA, it.id);
  console.log(`\n[${n}/${items.length}] ${st.title.trim()} — ${st.company}`);
  console.log(`  Link: ${st.url}`);
  await page.goto(st.url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(2500);
  // upload CV / cover letter where the form has upload boxes; everything else you can type or the checklist has
  const files = await page.locator('input[type=file]').all();
  for (const [i, f] of files.entries()) {
    const label = (await f.evaluate((el) => (el.id && document.querySelector(`label[for="${el.id}"]`)?.innerText) || el.name || '').catch(() => '')) || '';
    const file = /cover/i.test(label) || i === 1 ? path.join(dir, 'cover_letter.pdf') : path.join(dir, 'cv.pdf');
    await f.setInputFiles(file).catch(() => {});
  }
  console.log(`  CV and cover letter: ${dir}`);
  console.log(`  Answers to copy if needed: ${path.join(dir, 'checklist.md')}`);
  const a = (await rl.question('  Check the form, click Submit in Chrome yourself. Then type  y = submitted,  s = skip,  q = quit : ')).trim().toLowerCase();
  if (a === 'q') break;
  if (a === 'y') {
    st.status = 'submitted'; st.submitted_at = new Date().toISOString();
    st.followup_due = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);
    st.history = [...(st.history || []), { status: 'submitted', at: st.submitted_at, note: 'submitted by you' }];
    fs.writeFileSync(it.p, JSON.stringify(st, null, 1)); sent++;
    console.log('  Recorded as submitted.');
  }
}
rl.close(); await ctx.close();
console.log(`\nDone. Submitted ${sent}. Now run:  git add job-hunt/data && git commit -m "applications submitted" && git push`);
