// Opens the published site in a real browser and checks it works end to end,
// including live postal code lookups on OneMap.
//
// Usage: node scripts/check_live_site.mjs <site-url> <output-dir>
// Needs the `playwright` npm package and Chrome or Playwright's Chromium.

import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const [siteArg, outDir = 'check-output'] = process.argv.slice(2);
// Pause between searches, like a person typing. Real visitors search once
// or twice; firing searches back to back can trip OneMap's rate limits.
const SEARCH_GAP_MS = Number(process.env.SEARCH_GAP_MS || 2000);
if (!siteArg) {
  console.error('Usage: node scripts/check_live_site.mjs <site-url> <output-dir>');
  process.exit(2);
}
const SITE = siteArg.endsWith('/') ? siteArg : `${siteArg}/`;
mkdirSync(outDir, { recursive: true });

// Postal codes of real shelters. Searching each one should put that shelter
// first. Chosen to cover every district, a leading-zero code, the three
// corrected entries, and estates newer than older postal code datasets.
const SAMPLE_POSTAL_CODES = [
  '560507', // Central, Ang Mo Kio
  '050034', // leading zero
  '791457', // corrected: Fernvale Zone K RN
  '793441', // corrected: Fernvale Zone H RN
  '650116', // corrected: Bukit Batok Zone 1 RN
  '690119', // Tengah, newest estate
  '828629', // One Punggol
  '529204', // North East, Tampines
  '760413', // North West, Yishun
  '390087', // South East, Mountbatten
  '129605', // South West, West Coast
];

let failures = 0;
const results = [];
function check(ok, label, detail = '') {
  results.push({ ok, label, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures += 1;
}

async function launch() {
  try {
    return await chromium.launch({ channel: 'chrome' });
  } catch {
    return chromium.launch();
  }
}

const browser = await launch();
try {
  // ---- Page loads cleanly ----
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('requestfailed', (r) => errors.push(`request failed: ${r.url()} ${r.failure()?.errorText}`));

  // Record what OneMap actually sent back, so CORS failures can be diagnosed.
  const onemap = new Map();
  page.on('response', async (r) => {
    if (!r.url().includes('onemap.gov.sg')) return;
    const h = await r.allHeaders().catch(() => ({}));
    const code = new URL(r.url()).searchParams.get('searchVal');
    onemap.set(code, `OneMap HTTP ${r.status()}, allow-origin=${h['access-control-allow-origin'] || 'MISSING'}`
      + `${h['x-cache'] ? `, x-cache=${h['x-cache']}` : ''}${h.server ? `, server=${h.server}` : ''}`);
  });

  const res = await page.goto(SITE, { waitUntil: 'networkidle' });
  check(res && res.ok(), 'home page loads', `HTTP ${res && res.status()}`);
  check((await page.title()) === 'Haze Shelter Finder', 'page title', await page.title());

  const data = await page.evaluate(async () => (await fetch('shelters.json', { cache: 'no-store' })).json());
  const mapped = data.shelters.filter((s) => typeof s.lat === 'number');
  check(data.count >= 300 && mapped.length === data.count, 'shelter data loads with coordinates',
    `${mapped.length}/${data.count} shelters, as at ${data.as_at}`);
  check((await page.textContent('#as-at')) === data.as_at, 'footer shows the list date', data.as_at);

  const byPostal = new Map(data.shelters.map((s) => [s.postal, s]));

  // ---- Live OneMap searches ----
  for (const pc of SAMPLE_POSTAL_CODES) {
    const expected = byPostal.get(pc);
    if (!expected) {
      check(false, `search ${pc}`, 'no shelter with this postal code in the data any more');
      continue;
    }
    await page.waitForTimeout(SEARCH_GAP_MS);
    const started = Date.now();
    await page.fill('#postal', pc);
    await page.click('#search button[type=submit]');
    await page.waitForFunction(
      (code) => document.querySelector('#results-note')?.textContent.includes(code)
        || document.querySelector('#results-title')?.textContent.includes(code.slice(0, 3))
        || document.querySelector('#status.error'),
      pc,
      { timeout: 20000 },
    ).catch(() => {});
    const ms = Date.now() - started;
    const status = (await page.textContent('#status')) || '';
    const note = (await page.textContent('#results-note')) || '';
    const first = (await page.textContent('#results-list .card h3')) || '';
    const dist = (await page.textContent('#results-list .card .distance')) || '';
    const exact = note.startsWith('From ');
    check(exact && first.includes(expected.name),
      `search ${pc} finds ${expected.name}`,
      exact ? `first result: ${first.replace(/^Nearest/, '').trim()}, ${dist}, ${ms} ms`
        : `not an exact OneMap match. ${onemap.get(pc) || 'no OneMap response seen'}. note="${note}"`);
  }
  await page.screenshot({ path: `${outDir}/desktop.png`, fullPage: true });

  // ---- Shareable link ----
  await page.goto(`${SITE}?postal=560507`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#results:not([hidden]) .card', { timeout: 20000 }).catch(() => {});
  check(((await page.textContent('#results-list .card h3')) || '').includes('Cheng San Diamond RN'),
    'shareable ?postal= link runs the search');

  // ---- Invalid input ----
  await page.fill('#postal', '12345');
  await page.click('#search button[type=submit]');
  check(((await page.textContent('#status')) || '').includes('6-digit'), 'rejects a 5-digit postal code');

  check(errors.length === 0, 'no browser errors (CSP, scripts, failed requests)',
    errors.length ? `${errors.length} errors, first: ${errors[0]}` : '');
  await context.close();

  // ---- Phone: layout and "use my location" ----
  const phone = await browser.newContext({
    viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2,
    geolocation: { latitude: 1.3530, longitude: 103.9450 }, permissions: ['geolocation'],
  });
  const mobile = await phone.newPage();
  await mobile.goto(SITE, { waitUntil: 'networkidle' });
  const inputVisible = await mobile.evaluate(() => {
    const r = document.querySelector('#postal').getBoundingClientRect();
    return r.bottom <= window.innerHeight;
  });
  check(inputVisible, 'postal code box visible without scrolling on a 360px phone');
  await mobile.screenshot({ path: `${outDir}/phone-home.png` });
  await mobile.click('#locate');
  await mobile.waitForSelector('#results:not([hidden]) .card', { timeout: 20000 }).catch(() => {});
  check(((await mobile.textContent('#results-note')) || '').includes('current location'), '"Use my current location" works');
  const overflow = await mobile.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(overflow <= 0, 'no sideways scrolling on a 360px phone', `${overflow}px`);
  await mobile.screenshot({ path: `${outDir}/phone-results.png`, fullPage: true });
  await phone.close();
} finally {
  await browser.close();
}

console.log(`\n${results.length - failures}/${results.length} checks passed for ${SITE}`);
process.exit(failures ? 1 : 0);
