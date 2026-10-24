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
  '401038', // moved in PA's 16 October 2026 list: Eunos Village RN
  '650116', // Bukit Batok Zone '1' RN (block number was wrong in the September list)
  '690119', // Tengah, newest estate
  '828629', // One Punggol
  '529204', // North East, Tampines
  '760413', // North West, Yishun
  '390087', // South East, Mountbatten
  '129605', // South West, West Coast
];

// Address and building-name searches, with the shelter that should come first.
const SAMPLE_ADDRESSES = [
  ['507 Ang Mo Kio Ave 8', 'Cheng San Diamond RN'],
  ['Our Tampines Hub', 'Tampines Central CC'],
];

let failures = 0;
let warnings = 0;
const results = [];
function warn(label, detail = '') {
  console.log(`WARN  ${label}${detail ? `  (${detail})` : ''}`);
  warnings += 1;
}
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
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${m.text()} @ ${m.location()?.url || ''}`); });
  page.on('requestfailed', (r) => errors.push(`request failed: ${r.url()} ${r.failure()?.errorText}`));
  const counted = [];
  page.on('request', (r) => { if (r.url().includes('goatcounter.com')) counted.push(r.url()); });

  // Record what OneMap actually sent back, so CORS failures can be diagnosed.
  const onemap = new Map();
  page.on('response', async (r) => {
    if (!r.url().includes('onemap.gov.sg')) return;
    const h = await r.allHeaders().catch(() => ({}));
    const code = new URL(r.url()).searchParams.get('searchVal');
    onemap.set(code, `OneMap HTTP ${r.status()}, allow-origin=${h['access-control-allow-origin'] || 'MISSING'}`
      + `${h['x-cache'] ? `, x-cache=${h['x-cache']}` : ''}${h.server ? `, server=${h.server}` : ''}`);
  });
  // Same for data.gov.sg air quality requests.
  const airResponses = [];
  page.on('response', async (r) => {
    if (!r.url().includes('data.gov.sg')) return;
    const h = await r.allHeaders().catch(() => ({}));
    airResponses.push(`${new URL(r.url()).pathname} HTTP ${r.status()} allow-origin=${h['access-control-allow-origin'] || 'MISSING'}`);
  });

  const res = await page.goto(SITE, { waitUntil: 'networkidle' });
  check(res && res.ok(), 'home page loads', `HTTP ${res && res.status()}`);
  check((await page.title()).startsWith('Haze Shelter Finder'), 'page title', await page.title());

  const data = await page.evaluate(async () => (await fetch('shelters.json', { cache: 'no-store' })).json());
  const mapped = data.shelters.filter((s) => typeof s.lat === 'number');
  check(data.count >= 300 && mapped.length === data.count, 'shelter data loads with coordinates',
    `${mapped.length}/${data.count} shelters, as at ${data.as_at}`);
  check((await page.textContent('footer .as-at')) === data.as_at, 'footer shows the list date', data.as_at);
  check(((await page.textContent('#disclaimer')) || '').includes('personal project'), 'full disclaimer is on the page');

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
    await page.fill('#query', pc);
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

  // ---- Address and building-name searches ----
  for (const [text, expectedName] of SAMPLE_ADDRESSES) {
    await page.waitForTimeout(SEARCH_GAP_MS);
    await page.fill('#query', text);
    await page.click('#search button[type=submit]');
    await page.waitForFunction(() => document.querySelector('#search').getAttribute('aria-busy') === 'false', null, { timeout: 20000 }).catch(() => {});
    let picked = '';
    if (await page.isVisible('#choices')) {
      picked = (await page.textContent('#choices .choice')) || '';
      await page.click('#choices .choice >> nth=0');
    }
    const first = (await page.textContent('#results-list .card h3').catch(() => '')) || '';
    const note = (await page.textContent('#results-note')) || '';
    const status = (await page.textContent('#status')) || '';
    check(first.includes(expectedName), `address "${text}" finds ${expectedName}`,
      `${picked ? `picked first of ${await page.$$eval('#choices .choice', (b) => b.length)} matches; ` : ''}${note || status}`.slice(0, 220));
  }

  // Directions start from the searched place (not Google's guess of where the
  // device is) and use walking for a nearby shelter.
  const href = (await page.getAttribute('#results-list .card a[href*="google.com/maps"]', 'href').catch(() => '')) || '';
  const params = new URL(href || 'https://x/').searchParams;
  check(/^1\.\d+,103\.\d+$/.test(params.get('origin') || '') && params.get('travelmode') === 'walking',
    'directions start from the searched place', href.slice(0, 160));

  // A real visitor's input that used to fail: OneMap doesn't understand "block".
  await page.waitForTimeout(SEARCH_GAP_MS);
  await page.fill('#query', 'block 91 Tanglin halt road');
  await page.click('#search button[type=submit]');
  await page.waitForFunction(() => document.querySelector('#search').getAttribute('aria-busy') === 'false', null, { timeout: 20000 }).catch(() => {});
  const tanglin = (await page.textContent('#results-note')) || (await page.textContent('#status')) || '';
  check(await page.isVisible('#results') && tanglin.startsWith('From 91 Tanglin Halt'), '"block 91 Tanglin halt road" finds the block', tanglin.slice(0, 120));

  // Suggestions while typing.
  await page.waitForTimeout(SEARCH_GAP_MS);
  await page.fill('#query', '');
  await page.click('#query');
  await page.keyboard.type('507 ang mo', { delay: 60 });
  const shown = await page.waitForSelector('#suggestions:not([hidden]) li', { timeout: 10000 }).then(() => true).catch(() => false);
  const firstSuggestion = shown ? await page.textContent('#suggestions li') : '';
  check(shown && firstSuggestion.includes('Ang Mo Kio'), 'suggestions appear while typing', firstSuggestion);
  if (shown) {
    await page.click('#suggestions li');
    await page.waitForSelector('#results:not([hidden]) .card', { timeout: 20000 }).catch(() => {});
    check(((await page.textContent('#results-list .card h3')) || '').length > 0, 'choosing a suggestion shows shelters');
  }
  await page.screenshot({ path: `${outDir}/desktop.png`, fullPage: true });

  // ---- Shareable link ----
  await page.goto(`${SITE}?postal=560507`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#results:not([hidden]) .card', { timeout: 20000 }).catch(() => {});
  check(((await page.textContent('#results-list .card h3')) || '').includes('Cheng San Diamond RN'),
    'shareable ?postal= link runs the search');
  check(await page.isVisible('#results-disclaimer'), 'disclaimer is shown with the results');

  // ---- Air quality panel (NEA readings via data.gov.sg) ----
  await page.waitForFunction(() => {
    const a = document.querySelector('#air');
    return a && !a.hidden && (a.querySelector('.tile') || a.textContent.includes('unavailable'));
  }, null, { timeout: 20000 }).catch(() => {});
  const airText = ((await page.textContent('#air')) || '').replace(/\s+/g, ' ').trim();
  if (await page.$('#air .tile')) {
    check(/region/.test(airText) && /PSI\s*\d/.test(airText), 'air quality readings shown for the searched area', airText.slice(0, 200));
  } else {
    // data.gov.sg limits requests from shared addresses such as GitHub's
    // servers, so an outage here is reported but doesn't fail the check.
    warn('air quality readings unavailable', `${airResponses.join('; ') || 'no data.gov.sg response seen'}; panel="${airText}"`);
  }

  // ---- Invalid input ----
  await page.fill('#query', '12345');
  await page.click('#search button[type=submit]');
  check(((await page.textContent('#status')) || '').includes('6 digits'), 'rejects a 5-digit postal code');

  const airErrors = errors.filter((e) => e.includes('data.gov.sg'));
  const siteErrors = errors.filter((e) => !e.includes('data.gov.sg'));
  if (airErrors.length) warn('browser errors from data.gov.sg', airErrors.slice(0, 3).join(' | '));
  // This check is an automated browser, so the site must not count its visits.
  check(counted.length === 0, 'automated checks are not counted as visitors', counted[0] || '');
  check(siteErrors.length === 0, 'no browser errors (CSP, scripts, failed requests)',
    siteErrors.length ? `${siteErrors.length} errors, first: ${siteErrors[0]}` : '');
  await context.close();

  // ---- Phone: layout and "use my location" ----
  const phone = await browser.newContext({
    viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2,
    geolocation: { latitude: 1.3530, longitude: 103.9450 }, permissions: ['geolocation'],
  });
  const mobile = await phone.newPage();
  await mobile.goto(SITE, { waitUntil: 'networkidle' });
  const inputVisible = await mobile.evaluate(() => {
    const r = document.querySelector('#query').getBoundingClientRect();
    return r.bottom <= window.innerHeight;
  });
  check(inputVisible, 'search box visible without scrolling on a 360px phone');
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

console.log(`\n${results.length - failures}/${results.length} checks passed, ${warnings} warnings, for ${SITE}`);
process.exit(failures ? 1 : 0);
