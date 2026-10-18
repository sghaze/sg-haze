'use strict';

(() => {
  const ONEMAP_URL = 'https://www.onemap.gov.sg/api/common/elastic/search';
  const ONEMAP_TIMEOUT_MS = 8000;
  const ONEMAP_RETRY_DELAY_MS = 1500;
  const AIR_URLS = {
    psi: 'https://api-open.data.gov.sg/v2/real-time/api/psi',
    pm25: 'https://api-open.data.gov.sg/v2/real-time/api/pm25',
  };
  const AIR_TIMEOUT_MS = 8000;
  const AIR_CACHE_MS = 10 * 60 * 1000;
  const AIR_STALE_MS = 3 * 60 * 60 * 1000;
  const PAGE_SIZE = 5;
  const MAX_CHOICES = 8;
  const SG_BOUNDS = { minLat: 1.15, maxLat: 1.48, minLng: 103.59, maxLng: 104.1 };

  const $ = (id) => document.getElementById(id);
  const els = {
    form: $('search'),
    query: $('query'),
    locate: $('locate'),
    submit: document.querySelector('#search button[type="submit"]'),
    status: $('status'),
    choices: $('choices'),
    choicesTitle: $('choices-title'),
    choicesList: $('choices-list'),
    results: $('results'),
    title: $('results-title'),
    note: $('results-note'),
    air: $('air'),
    list: $('results-list'),
    more: $('more'),
    browse: $('browse'),
    filter: $('filter'),
    browseList: $('browse-list'),
  };

  let allShelters = [];
  let mappedShelters = [];
  let current = null;

  const dataReady = fetch('shelters.json', { cache: 'no-cache' })
    .then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    })
    .then((data) => {
      allShelters = data.shelters;
      mappedShelters = allShelters.filter((s) => typeof s.lat === 'number' && typeof s.lng === 'number');
      if (data.as_at) document.querySelectorAll('.as-at').forEach((node) => { node.textContent = data.as_at; });
    });
  dataReady.catch(() => setStatus("Sorry, the shelter list couldn't be loaded. Please refresh the page.", true));

  let areasPromise = null;
  function loadAreas() {
    if (!areasPromise) {
      areasPromise = fetch('postal-areas.json')
        .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
        .then((d) => d.areas)
        .catch((err) => {
          areasPromise = null;
          throw err;
        });
    }
    return areasPromise;
  }

  // ---------- helpers ----------

  function setStatus(message, isError = false) {
    els.status.textContent = message;
    els.status.classList.toggle('error', isError);
  }

  function setBusy(busy) {
    els.submit.disabled = busy;
    els.locate.disabled = busy;
    els.form.setAttribute('aria-busy', String(busy));
  }

  function markInvalid(message) {
    els.query.setAttribute('aria-invalid', 'true');
    setStatus(message, true);
    els.query.focus();
  }

  const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

  function validPostal(pc) {
    if (!/^\d{6}$/.test(pc)) return false;
    const sector = Number(pc.slice(0, 2));
    return sector >= 1 && sector <= 82 && sector !== 74;
  }

  // "560507", "S560507", "Singapore 560507" are postal codes; anything with
  // letters is treated as an address or building name.
  function parseQuery(raw) {
    const text = raw.trim().replace(/\s+/g, ' ');
    const withoutPrefix = text.replace(/^(singapore|s)\s*\(?\s*/i, '').replace(/\)\s*$/, '');
    if (/^[\d\s-]+$/.test(withoutPrefix)) return { kind: 'postal', value: withoutPrefix.replace(/\D/g, '') };
    return { kind: 'address', value: text };
  }

  function distanceKm(aLat, aLng, bLat, bLng) {
    const rad = Math.PI / 180;
    const dLat = (bLat - aLat) * rad;
    const dLng = (bLng - aLng) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLng / 2) ** 2;
    return 2 * 6371 * Math.asin(Math.sqrt(h));
  }

  function formatDistance(km, approx) {
    if (km < 0.05) return approx ? 'nearby' : 'under 50 m';
    const text = km < 1 ? `${Math.round(km * 100) * 10} m` : `${km.toFixed(1)} km`;
    return approx ? `about ${text}` : text;
  }

  function titleCase(text) {
    return text.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase());
  }

  function inSingapore(lat, lng) {
    return lat >= SG_BOUNDS.minLat && lat <= SG_BOUNDS.maxLat && lng >= SG_BOUNDS.minLng && lng <= SG_BOUNDS.maxLng;
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function link(text, href) {
    const a = el('a', '', text);
    a.href = href;
    a.rel = 'noopener';
    return a;
  }

  async function fetchJson(url, timeoutMs) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ctrl.signal, referrerPolicy: 'no-referrer' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  // ---------- location lookups (OneMap) ----------

  // OneMap answers bursts of requests from one network with HTTP 429 and no
  // CORS header, which the browser reports as a network error. That fails
  // fast, so wait a moment and try once more. Slow failures (timeouts) are not
  // retried: the visitor has already waited long enough.
  async function withRetry(fn) {
    const started = Date.now();
    try {
      return await fn();
    } catch (err) {
      if (Date.now() - started > 3000) throw err;
      await sleep(ONEMAP_RETRY_DELAY_MS);
      return fn();
    }
  }

  // Returns a list of places ({lat, lng, postal, label}). Throws if OneMap
  // can't be reached.
  async function onemapSearch(query) {
    const params = new URLSearchParams({ searchVal: query, returnGeom: 'Y', getAddrDetails: 'Y', pageNum: '1' });
    const data = await fetchJson(`${ONEMAP_URL}?${params}`, ONEMAP_TIMEOUT_MS);
    return (data.results || []).map(toPlace).filter(Boolean);
  }

  function toPlace(r) {
    const lat = parseFloat(r.LATITUDE);
    const lng = parseFloat(r.LONGITUDE ?? r.LONGTITUDE);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    const clean = (v) => (v && v !== 'NIL' ? String(v).trim() : '');
    const street = [clean(r.BLK_NO), clean(r.ROAD_NAME)].filter(Boolean).join(' ');
    const building = clean(r.BUILDING);
    const postal = clean(r.POSTAL);
    // Street first so a list of matches is easy to scan, e.g.
    // "507 Ang Mo Kio Avenue 8 (Cheng San Crest), Singapore 560507".
    let label = titleCase(street || building || clean(r.SEARCHVAL) || 'Selected place');
    if (street && building) label += ` (${titleCase(building)})`;
    if (postal) label += `, Singapore ${postal}`;
    return { lat, lng, postal, label };
  }

  // One entry per postal code (a postal code can come back several times).
  function uniquePlaces(places) {
    const seen = new Set();
    return places.filter((p) => {
      const key = p.postal || p.label;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  // Rough centre of the postal area, from a bundled table. Used as a backup.
  async function approximatePostal(pc) {
    const areas = await loadAreas();
    const p = areas['3'][pc.slice(0, 3)] || areas['2'][pc.slice(0, 2)];
    return p ? { lat: p[0], lng: p[1] } : null;
  }

  // ---------- search flows ----------

  async function startSearch(message) {
    els.query.removeAttribute('aria-invalid');
    els.choices.hidden = true;
    setBusy(true);
    setStatus(message);
    try {
      await dataReady;
      return true;
    } catch {
      setBusy(false);
      setStatus("Sorry, the shelter list couldn't be loaded. Please refresh the page.", true);
      return false;
    }
  }

  function search(raw) {
    const q = parseQuery(raw);
    if (!q.value) {
      markInvalid('Please enter a postal code or an address.');
      return;
    }
    if (q.kind === 'postal') {
      if (validPostal(q.value)) {
        searchPostal(q.value);
      } else if (q.value.length === 6) {
        markInvalid(`${q.value} isn't a valid Singapore postal code. Please check the number.`);
      } else {
        markInvalid('Postal codes have 6 digits, for example 560507. To search by block number, add the street name, for example 507 Ang Mo Kio Ave 8.');
      }
      return;
    }
    if (q.value.length < 3) {
      markInvalid('Please type at least 3 characters of the address or building name.');
      return;
    }
    searchAddress(q.value);
  }

  async function searchPostal(pc) {
    if (!await startSearch(`Looking up ${pc}…`)) return;

    let place = null;
    let problem = '';
    try {
      const places = await withRetry(() => onemapSearch(pc));
      place = places.find((p) => p.postal === pc) || null;
      if (!place) problem = 'not-found';
    } catch {
      problem = 'unreachable';
    }

    if (!place) {
      try {
        const approx = await approximatePostal(pc);
        if (approx) place = { ...approx, approx: true };
      } catch {
        /* fall through to the error message below */
      }
    }
    setBusy(false);

    if (!place) {
      setStatus(problem === 'not-found'
        ? `We couldn't find postal code ${pc}. Please check the number.`
        : "We couldn't reach the location service. Check your internet connection, or use your current location.", true);
      return;
    }

    history.replaceState(null, '', `?postal=${pc}`);
    setStatus('');
    if (place.approx) {
      const why = problem === 'not-found'
        ? `We couldn't find ${pc} exactly, so these are near the ${pc.slice(0, 3)}xxx postal area. Check the number for a more accurate result.`
        : `The location service didn't respond, so these are near the ${pc.slice(0, 3)}xxx postal area, not your exact address.`;
      showResults(place, `Shelters near postal area ${pc.slice(0, 3)}xxx`, `Approximate. ${why}`);
    } else {
      showPlace(place);
    }
  }

  async function searchAddress(text) {
    if (!await startSearch(`Searching for “${text}”…`)) return;

    let places;
    try {
      places = uniquePlaces(await withRetry(() => onemapSearch(text)));
    } catch {
      setBusy(false);
      setStatus("We couldn't reach the location service. Check your internet connection, try your postal code, or use your current location.", true);
      return;
    }
    setBusy(false);

    if (!places.length) {
      els.results.hidden = true;
      setStatus(`No match for “${text}”. Try a postal code, a block and street (for example 507 Ang Mo Kio Ave 8), or a building name.`, true);
      return;
    }
    setStatus('');
    if (places.length === 1) {
      showPlace(places[0]);
    } else {
      showChoices(places.slice(0, MAX_CHOICES));
    }
  }

  function showPlace(place) {
    els.choices.hidden = true;
    if (validPostal(place.postal)) history.replaceState(null, '', `?postal=${place.postal}`);
    showResults(place, 'Nearest shelters',
      `From ${place.label}. Distances are straight-line; walking routes will be longer.`);
  }

  function showChoices(places) {
    els.results.hidden = true;
    const frag = document.createDocumentFragment();
    places.forEach((place) => {
      const li = el('li');
      const button = el('button', 'choice', place.label);
      button.type = 'button';
      button.addEventListener('click', () => showPlace(place));
      li.appendChild(button);
      frag.appendChild(li);
    });
    els.choicesList.replaceChildren(frag);
    els.choices.hidden = false;
    els.choicesTitle.focus();
  }

  function searchLocation() {
    if (!('geolocation' in navigator)) {
      setStatus("Your browser can't share your location. Please enter your postal code or address.", true);
      return;
    }
    els.choices.hidden = true;
    setBusy(true);
    setStatus('Finding your location…');
    navigator.geolocation.getCurrentPosition(async (pos) => {
      const { latitude: lat, longitude: lng } = pos.coords;
      try {
        await dataReady;
      } catch {
        setBusy(false);
        setStatus("Sorry, the shelter list couldn't be loaded. Please refresh the page.", true);
        return;
      }
      setBusy(false);
      if (!inSingapore(lat, lng)) {
        setStatus('Your location appears to be outside Singapore. Please enter a Singapore postal code or address instead.', true);
        return;
      }
      history.replaceState(null, '', location.pathname);
      setStatus('');
      showResults({ lat, lng }, 'Nearest shelters',
        'From your current location. Distances are straight-line; walking routes will be longer.');
    }, (err) => {
      setBusy(false);
      setStatus(err.code === err.PERMISSION_DENIED
        ? 'Location access is blocked. Allow it in your browser settings, or enter your postal code or address.'
        : "We couldn't get your location. Please enter your postal code or address instead.", true);
    }, { enableHighAccuracy: false, timeout: 15000, maximumAge: 60000 });
  }

  // ---------- air quality (NEA readings via data.gov.sg) ----------

  // Reads either the v2 ("regionMetadata"/"labelLocation") or v1
  // ("region_metadata"/"label_location") response shape.
  function parseNea(json, key) {
    const d = json && (json.data || json);
    if (!d) return null;
    const meta = d.regionMetadata || d.region_metadata || [];
    const item = Array.isArray(d.items) ? d.items[0] : null;
    const values = item && item.readings && item.readings[key];
    if (!values) return null;
    const regions = meta.map((m) => {
      const loc = m.labelLocation || m.label_location || {};
      return { name: String(m.name), lat: Number(loc.latitude), lng: Number(loc.longitude), value: Number(values[m.name]) };
    }).filter((r) => r.name !== 'national' && Number.isFinite(r.value) && inSingapore(r.lat, r.lng));
    if (!regions.length) return null;
    return { time: item.timestamp || item.updatedTimestamp || item.update_timestamp || null, regions };
  }

  let airCache = null;
  function loadAir() {
    if (airCache && Date.now() - airCache.at < AIR_CACHE_MS) return airCache.promise;
    const promise = Promise.allSettled([
      fetchJson(AIR_URLS.psi, AIR_TIMEOUT_MS),
      fetchJson(AIR_URLS.pm25, AIR_TIMEOUT_MS),
    ]).then(([psi, pm25]) => {
      const air = {
        psi: psi.status === 'fulfilled' ? parseNea(psi.value, 'psi_twenty_four_hourly') : null,
        pm25: pm25.status === 'fulfilled' ? parseNea(pm25.value, 'pm25_one_hourly') : null,
      };
      if (!air.psi && !air.pm25) throw new Error('No air quality readings');
      return air;
    });
    airCache = { at: Date.now(), promise };
    promise.catch(() => { airCache = null; });
    return promise;
  }

  function nearest(set, origin) {
    if (!set) return null;
    let best = null;
    set.regions.forEach((r) => {
      const d = distanceKm(origin.lat, origin.lng, r.lat, r.lng);
      if (!best || d < best.d) best = { ...r, d, time: set.time };
    });
    return best;
  }

  // NEA's 24-hour PSI bands.
  function psiBand(v) {
    if (v <= 50) return { label: 'Good', level: 'good' };
    if (v <= 100) return { label: 'Moderate', level: 'warning' };
    if (v <= 200) return { label: 'Unhealthy', level: 'serious' };
    if (v <= 300) return { label: 'Very unhealthy', level: 'critical' };
    return { label: 'Hazardous', level: 'critical' };
  }

  // NEA's 1-hour PM2.5 bands and its advice for each.
  function pm25Band(v) {
    if (v <= 55) return { label: 'Normal', level: 'good', advice: 'Usual activities are fine.' };
    if (v <= 150) return { label: 'Elevated', level: 'warning', advice: 'Reduce strenuous outdoor activity. Vulnerable people should avoid it.' };
    if (v <= 250) return { label: 'High', level: 'serious', advice: 'Avoid strenuous outdoor activity. Vulnerable people should avoid outdoor activity.' };
    return { label: 'Very high', level: 'critical', advice: 'Minimise outdoor activity. Vulnerable people should avoid it.' };
  }

  function formatTime(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleString('en-SG', {
      timeZone: 'Asia/Singapore', hour: 'numeric', minute: '2-digit', day: 'numeric', month: 'short',
    });
  }

  function tile(label, value, band) {
    const t = el('div', 'tile');
    const bandLine = el('span', 'band');
    bandLine.append(el('span', `dot ${band.level}`), document.createTextNode(band.label));
    bandLine.firstChild.setAttribute('aria-hidden', 'true');
    t.append(el('span', 'tile-label', label), el('span', 'tile-value', String(Math.round(value))), bandLine);
    return t;
  }

  let airToken = 0;
  async function renderAir(origin) {
    const token = ++airToken;
    els.air.hidden = false;
    els.air.replaceChildren(el('p', 'help', 'Loading air quality readings…'));

    let air = null;
    try {
      air = await loadAir();
    } catch {
      air = null;
    }
    if (token !== airToken) return; // a newer search has started

    const psi = nearest(air && air.psi, origin);
    const pm = nearest(air && air.pm25, origin);
    if (!psi && !pm) {
      const p = el('p', 'help');
      p.append('Air quality readings are unavailable right now. See ', link('haze.gov.sg', 'https://www.haze.gov.sg/'), ' for the latest readings.');
      els.air.replaceChildren(p);
      return;
    }

    const region = (psi || pm).name;
    const regionName = titleCase(region);
    const frag = document.createDocumentFragment();
    frag.appendChild(el('h3', '', `Air quality · ${regionName} region`));

    const tiles = el('div', 'air-tiles');
    if (psi) tiles.appendChild(tile('24-hr PSI', psi.value, psiBand(psi.value)));
    if (pm) tiles.appendChild(tile('1-hr PM2.5 (µg/m³)', pm.value, pm25Band(pm.value)));
    frag.appendChild(tiles);

    if (pm) {
      const pmBand = pm25Band(pm.value);
      const advice = el('p', 'air-advice');
      advice.append(el('strong', '', 'NEA advice for the next few hours (from 1-hr PM2.5): '), pmBand.advice);
      // NEA bases activity advice on the 1-hr PM2.5 reading. The 24-hr PSI is
      // an average over the past day, so the two can disagree; say why.
      if (psi && psi.value > 100 && pmBand.level === 'good') {
        advice.append(' The 24-hr PSI is an average over the past day, so it can stay high after the air has improved.');
      }
      frag.appendChild(advice);
    }

    const time = (psi && psi.time) || (pm && pm.time);
    const meta = el('p', 'help');
    const when = time ? ` at ${formatTime(time)}` : '';
    meta.append(`NEA readings for the whole ${regionName} region${when}, via data.gov.sg. Vulnerable people: the elderly, pregnant women, children and people with heart or lung disease. Official readings and advice: `,
      link('haze.gov.sg', 'https://www.haze.gov.sg/'), '.');
    frag.appendChild(meta);

    if (time && Date.now() - new Date(time).getTime() > AIR_STALE_MS) {
      frag.appendChild(el('p', 'status error', 'These readings are more than 3 hours old. Check haze.gov.sg for current readings.'));
    }
    els.air.replaceChildren(frag);
  }

  // ---------- rendering ----------

  function showResults(origin, title, note) {
    current = {
      approx: Boolean(origin.approx),
      shown: 0,
      sorted: mappedShelters
        .map((s) => ({ s, d: distanceKm(origin.lat, origin.lng, s.lat, s.lng) }))
        .sort((a, b) => a.d - b.d),
    };
    els.title.textContent = title;
    els.note.textContent = note;
    els.list.replaceChildren();
    renderMore();
    els.results.hidden = false;
    els.title.focus();
    renderAir(origin);
  }

  function renderMore() {
    const next = current.sorted.slice(current.shown, current.shown + PAGE_SIZE);
    const frag = document.createDocumentFragment();
    next.forEach(({ s, d }, i) => frag.appendChild(card(s, d, current.shown + i)));
    els.list.appendChild(frag);
    current.shown += next.length;
    els.more.hidden = current.shown >= current.sorted.length;
  }

  function card(s, km, index) {
    const li = el('li', index === 0 && !current.approx ? 'card nearest' : 'card');

    const top = el('div', 'card-top');
    const h3 = el('h3');
    if (index === 0 && !current.approx) h3.appendChild(el('span', 'badge', 'Nearest'));
    h3.appendChild(document.createTextNode(s.name));
    top.append(h3, el('span', 'distance', formatDistance(km, current.approx)));

    const actions = el('div', 'card-actions');
    const directions = el('a', '', 'Directions');
    directions.href = `https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lng}`;
    directions.target = '_blank';
    directions.rel = 'noopener';
    directions.setAttribute('aria-label', `Directions to ${s.name} (opens Google Maps)`);
    actions.appendChild(directions);

    li.append(top, el('p', 'tag', s.type), el('p', 'address', `${s.address}, Singapore ${s.postal}`), actions);
    return li;
  }

  let browseRendered = false;
  function renderBrowse(query = '') {
    const q = query.trim().toLowerCase();
    const matches = allShelters.filter((s) => !q
      || s.name.toLowerCase().includes(q)
      || s.address.toLowerCase().includes(q)
      || s.postal.includes(q));
    const byDistrict = new Map();
    matches
      .slice()
      .sort((a, b) => a.district.localeCompare(b.district) || a.name.localeCompare(b.name))
      .forEach((s) => {
        if (!byDistrict.has(s.district)) byDistrict.set(s.district, []);
        byDistrict.get(s.district).push(s);
      });

    const frag = document.createDocumentFragment();
    if (!matches.length) frag.appendChild(el('p', 'help', 'No shelters match.'));
    byDistrict.forEach((list, district) => {
      frag.appendChild(el('h3', '', `${district} (${list.length})`));
      const ul = el('ul');
      list.forEach((s) => {
        const li = el('li');
        li.append(el('strong', '', s.name), document.createTextNode(`${s.address}, Singapore ${s.postal}`));
        ul.appendChild(li);
      });
      frag.appendChild(ul);
    });
    els.browseList.replaceChildren(frag);
  }

  // ---------- events ----------

  els.form.addEventListener('submit', (e) => {
    e.preventDefault();
    search(els.query.value);
  });

  // The full disclaimer is folded away in the footer; open it when linked to.
  function openDisclaimer() {
    const d = document.getElementById('disclaimer');
    if (d && !d.open) d.open = true;
  }
  document.addEventListener('click', (e) => {
    if (e.target.closest && e.target.closest('a[href="#disclaimer"]')) openDisclaimer();
  });
  window.addEventListener('hashchange', () => { if (location.hash === '#disclaimer') openDisclaimer(); });
  if (location.hash === '#disclaimer') openDisclaimer();

  els.locate.addEventListener('click', searchLocation);
  els.more.addEventListener('click', renderMore);

  els.browse.addEventListener('toggle', async () => {
    if (!els.browse.open || browseRendered) return;
    try {
      await dataReady;
    } catch {
      return;
    }
    browseRendered = true;
    renderBrowse(els.filter.value);
  });

  let filterTimer;
  els.filter.addEventListener('input', () => {
    clearTimeout(filterTimer);
    filterTimer = setTimeout(() => renderBrowse(els.filter.value), 150);
  });

  // Support shareable links like ?postal=560507
  const fromUrl = new URLSearchParams(location.search).get('postal');
  if (fromUrl) {
    els.query.value = fromUrl.replace(/\D/g, '').slice(0, 6);
    search(els.query.value);
  }
})();
