'use strict';

(() => {
  const ONEMAP_URL = 'https://www.onemap.gov.sg/api/common/elastic/search';
  const ONEMAP_TIMEOUT_MS = 8000;
  const ONEMAP_RETRY_DELAY_MS = 1500;
  const PAGE_SIZE = 5;
  const SG_BOUNDS = { minLat: 1.15, maxLat: 1.48, minLng: 103.59, maxLng: 104.1 };

  const $ = (id) => document.getElementById(id);
  const els = {
    form: $('search'),
    postal: $('postal'),
    locate: $('locate'),
    submit: document.querySelector('#search button[type="submit"]'),
    status: $('status'),
    results: $('results'),
    title: $('results-title'),
    note: $('results-note'),
    list: $('results-list'),
    more: $('more'),
    browse: $('browse'),
    filter: $('filter'),
    browseList: $('browse-list'),
    asAt: $('as-at'),
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
      if (data.as_at) els.asAt.textContent = data.as_at;
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

  function validPostal(pc) {
    if (!/^\d{6}$/.test(pc)) return false;
    const sector = Number(pc.slice(0, 2));
    return sector >= 1 && sector <= 82 && sector !== 74;
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

  // ---------- location lookups ----------

  // Returns {lat, lng, label}, or null if OneMap doesn't know the postal code.
  // Throws if OneMap can't be reached.
  async function geocodePostal(pc) {
    const started = Date.now();
    try {
      return await onemapSearch(pc);
    } catch (err) {
      // OneMap answers bursts of requests from one network with HTTP 429 and
      // no CORS header, which the browser reports as a network error. That
      // fails fast, so wait a moment and try once more. Don't retry slow
      // failures (timeouts): the visitor has already waited long enough.
      if (Date.now() - started > 3000) throw err;
      await new Promise((resolve) => setTimeout(resolve, ONEMAP_RETRY_DELAY_MS));
      return onemapSearch(pc);
    }
  }

  async function onemapSearch(pc) {
    const params = new URLSearchParams({ searchVal: pc, returnGeom: 'Y', getAddrDetails: 'Y', pageNum: '1' });
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ONEMAP_TIMEOUT_MS);
    try {
      const res = await fetch(`${ONEMAP_URL}?${params}`, { signal: ctrl.signal, referrerPolicy: 'no-referrer' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const hit = (data.results || []).find((r) => r.POSTAL === pc);
      if (!hit) return null;
      const lat = parseFloat(hit.LATITUDE);
      const lng = parseFloat(hit.LONGITUDE ?? hit.LONGTITUDE);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
      const street = [hit.BLK_NO, hit.ROAD_NAME].filter((x) => x && x !== 'NIL').join(' ');
      return { lat, lng, label: street ? `${titleCase(street)}, Singapore ${pc}` : `Singapore ${pc}` };
    } finally {
      clearTimeout(timer);
    }
  }

  // Rough centre of the postal area, from a bundled table. Used as a backup.
  async function approximatePostal(pc) {
    const areas = await loadAreas();
    const p = areas['3'][pc.slice(0, 3)] || areas['2'][pc.slice(0, 2)];
    return p ? { lat: p[0], lng: p[1] } : null;
  }

  // ---------- search flows ----------

  async function searchPostal(pc) {
    els.postal.removeAttribute('aria-invalid');
    if (!validPostal(pc)) {
      els.postal.setAttribute('aria-invalid', 'true');
      setStatus('Please enter a 6-digit Singapore postal code, for example 560507.', true);
      els.postal.focus();
      return;
    }

    setBusy(true);
    setStatus(`Looking up ${pc}…`);
    try {
      await dataReady;
    } catch {
      setBusy(false);
      setStatus("Sorry, the shelter list couldn't be loaded. Please refresh the page.", true);
      return;
    }

    let place = null;
    let problem = '';
    try {
      place = await geocodePostal(pc);
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
      showResults(place, 'Nearest shelters',
        `From ${place.label}. Distances are straight-line; walking routes will be longer.`);
    }
  }

  function searchLocation() {
    if (!('geolocation' in navigator)) {
      setStatus("Your browser can't share your location. Please enter your postal code.", true);
      return;
    }
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
        setStatus('Your location appears to be outside Singapore. Please enter a Singapore postal code instead.', true);
        return;
      }
      history.replaceState(null, '', location.pathname);
      setStatus('');
      showResults({ lat, lng }, 'Nearest shelters',
        'From your current location. Distances are straight-line; walking routes will be longer.');
    }, (err) => {
      setBusy(false);
      setStatus(err.code === err.PERMISSION_DENIED
        ? 'Location access is blocked. Allow it in your browser settings, or enter your postal code.'
        : "We couldn't get your location. Please enter your postal code instead.", true);
    }, { enableHighAccuracy: false, timeout: 15000, maximumAge: 60000 });
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
  }

  function renderMore() {
    const next = current.sorted.slice(current.shown, current.shown + PAGE_SIZE);
    const frag = document.createDocumentFragment();
    next.forEach(({ s, d }, i) => frag.appendChild(card(s, d, current.shown + i)));
    els.list.appendChild(frag);
    current.shown += next.length;
    els.more.hidden = current.shown >= current.sorted.length;
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
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
    const pc = els.postal.value.replace(/\D/g, '');
    els.postal.value = pc;
    searchPostal(pc);
  });

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
    els.postal.value = fromUrl.replace(/\D/g, '').slice(0, 6);
    searchPostal(els.postal.value);
  }
})();
