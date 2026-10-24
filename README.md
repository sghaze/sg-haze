# Haze Shelter Finder (Singapore)

A one-page website: type a Singapore postal code, address or building name (or tap **Use my
current location**) and see the nearest community haze shelters, with straight-line distance and a
Google Maps directions link, plus NEA's latest PSI and PM2.5 readings for that part of Singapore.

- 372 shelters from the People's Association list, *as of 16 October 2026*
- Works on phones, light and dark mode, no cookies, anonymous visit counts
  ([GoatCounter](https://sg-haze.goatcounter.com), sent without loading any outside script), no
  external libraries
- **Not an official government website**

Live site: **https://sghaze.github.io/**. This works because the repository is named
`sghaze.github.io`; renaming it would move the site to `https://sghaze.github.io/<new-name>/`.
The old address, `https://sghaze.github.io/sg-haze/`, no longer works.

## Publishing settings

1. In this repository on GitHub, open **Settings → Pages**.
2. Under **Build and deployment → Source**, choose **GitHub Actions**.
3. Open the **Actions** tab, pick **Update data and publish site**, and click **Run workflow**
   (or push any commit).

The site is only published from the repository's **default branch**. Every later push to that
branch republishes it automatically.

## How it works

```
data/source.pdf ──parse_pdf.py──▶ data/shelters.csv ──geocode.py (OneMap)──▶ docs/shelters.json
                                                                           └─▶ data/geocode-report.md
docs/  (index.html, app.js, style.css, shelters.json, postal-areas.json) ──▶ GitHub Pages
```

1. **`scripts/parse_pdf.py`** reads the PDF table and writes `data/shelters.csv`, plus the list's
   "as at" date in `data/source-meta.json`.
2. **`scripts/geocode.py`** looks up each shelter's postal code on
   [OneMap](https://www.onemap.gov.sg/) (Singapore Land Authority) and writes `docs/shelters.json`.
   Results are cached in `data/geocode-cache.json`, so only new postal codes are looked up.
   It refuses to publish if fewer than 90% of shelters are found.
3. The GitHub Action (`.github/workflows/site.yml`) runs both scripts on every push, commits any
   data changes, and publishes `docs/` to GitHub Pages.
4. In the browser, `docs/app.js` asks OneMap for the location of the visitor's postal code or
   address, then sorts shelters by distance. Suggestions appear while typing; words OneMap doesn't
   understand ("Block", "Blk", unit numbers like "#01-23") are removed first, and an address that
   contains a postal code is searched by that code. If an address matches several places, the visitor
   picks one from a list.
5. It also fetches NEA's latest 24-hour PSI and 1-hour PM2.5 readings for all five regions from
   [data.gov.sg](https://data.gov.sg/) and shows the region nearest the searched location, with
   NEA's band names and advice. Only the request for all regions goes to data.gov.sg; the visitor's
   location never leaves the browser. If data.gov.sg is unavailable, the shelters still show.
6. **`Check live site`** (`.github/workflows/check-site.yml`) opens the published site in a real
   browser after every publish and every morning at 07:17 Singapore time. It runs live postal code,
   address and building searches and checks the air quality panel (`scripts/check_live_site.mjs`). If OneMap changes or the site breaks, the run fails
   and GitHub emails you. Screenshots are saved with each run.

**Backup if OneMap is down:** `docs/postal-areas.json` holds the rough centre of every postal area
(the first 2–3 digits), built by `scripts/build_postal_areas.py`. If OneMap doesn't answer within
8 seconds, the site shows shelters near that area and labels the result as approximate.

## Updating when a new list comes out

**New lists are published automatically.** Every 3 hours, `Watch for a new PA shelter list`
(`.github/workflows/watch-pa.yml`, `scripts/watch_pa.py`) compares the PDF linked on PA's
[Community Haze Shelters page](https://www.pa.gov.sg/our-network/community-clubs/shelters/) with
`data/source.pdf`. When PA's list changes:

- If it reads cleanly and has at least 80% as many shelters as the site, it goes on the site
  straight away. An issue (label `pa-list`) mentions you and lists shelters added, removed, moved,
  renamed or with a changed address, so you can check `data/geocode-report.md`.
- Otherwise nothing is published, the issue says why, and the run fails so GitHub emails you. To
  publish it anyway: **Actions → Watch for a new PA shelter list → Run workflow**, tick **Use PA's
  latest list**, and run it.

If PA's page can't be read, you get an issue and email about that instead.

GitHub switches off scheduled workflows in a public repository after 60 days with no activity, so
`Keep scheduled checks running` (`.github/workflows/keepalive.yml`) commits the date and time to
`.github/last-keepalive` on the 1st of each month.

To update by hand instead:

1. On GitHub, go to the `data` folder, choose **Add file → Upload files**, and upload the new PDF
   named exactly **`source.pdf`** (it replaces the old one). Commit.
2. Wait for the **Actions** run to finish (about 5 minutes when many postal codes are new).
3. Open **`data/geocode-report.md`** and review any flagged shelters. The usual problem is a postal
   code that doesn't match the address. Fixes go in the `CORRECTIONS` list at the top of
   `scripts/parse_pdf.py`, each with a reason and a source.

If the Action fails at "Read the shelter PDF", the new PDF's layout has changed and the parser
needs updating.

## Corrections made to PA's list

Checked against PA's own [OnePA](https://www.onepa.gov.sg/) pages. These still apply to the
16 October 2026 list:

| Shelter | In the PDF | Corrected to | Why |
|---|---|---|---|
| Fernvale Zone K RN | postal 792451 | 791457 | 792451 is Blk 451B Sengkang West Way, ~500 m away. OnePA lists the RN at 457A Sengkang West Rd. |
| Sengkang West Zone 'K' RN | Anchorvole Road | Anchorvale Road | Spelling. |
| Any shelter | 5-digit postal codes, e.g. 88995 | 088995 | The September 2026 PDF dropped leading zeros (8 shelters); the parser restores them. |

## Disclaimer

The site states that it is a free, non-commercial personal project, not an official service, and
that its information is provided "as is" with no liability accepted, to the fullest extent permitted
by law. A short version appears above every set of results; the full text is in the page footer
(`#disclaimer` in `docs/index.html`). Visitors report errors through a Google Form (https://forms.gle/EGpRxE4Sg7hduxv97); responses go to
the owner's Google Sheet, so no email address is shown on the site.

Keep the project non-commercial (no ads, donations or sponsorship) if you want the "personal project"
statement to stay accurate. This wording is not legal advice.

## Known limits

- **Distances are straight-line**, not walking routes. Rivers, expressways and MRT lines can make
  the true walk longer. The site shows 5 options (more on request) so people can choose.
- **Opening hours and activation aren't in the data.** Shelters open only when activated, and
  hours differ by venue. The site says so and points to [haze.gov.sg](https://www.haze.gov.sg/)
  and [onepa.gov.sg](https://www.onepa.gov.sg/).
- **OneMap limits rapid requests from one internet address.** It answers with HTTP 429 and no
  CORS header, which browsers report as a network error. The site waits 1.5 s and retries once. If
  many people on one shared network (office, school, some mobile carriers) search at the same
  moment, some may still get the approximate postal-area result.
- **Air quality is regional.** NEA publishes readings for five regions (north, south, east, west,
  central), updated hourly. The site shows the region nearest the searched location, which can
  differ from conditions on a particular street. Readings more than 3 hours old are flagged.
  data.gov.sg limits how often one internet address can ask without an API key; if it refuses, the
  panel says readings are unavailable and points to haze.gov.sg.
- **English only.**
- Two shelters are pinned to the next-door block (32–51 m away) because their address omits the
  block letter. See `data/geocode-report.md`.

## Run it locally

```
cd docs
python3 -m http.server 8000
# open http://localhost:8000
```

To rebuild the data yourself: `pip install -r requirements.txt`, then run the two scripts with the
arguments shown at the top of each file.

## Sources and credits

- Shelter list: People's Association, *List of Community Haze Shelters at Community Clubs,
  Integrated Community Hubs, Residents' Centres and Residents' Network* (as of 16 October 2026),
  kept here as `data/source.pdf`.
- Location search: OneMap © Singapore Land Authority.
- Air quality: contains information from NEA's PSI and PM2.5 readings, accessed live from
  data.gov.sg (`api-open.data.gov.sg/v2/real-time/api/psi` and `/pm25`) and made available under the
  terms of the Singapore Open Data Licence version 1.0.
- Postal area backup table: derived from a 2017 dump of OneMap postal code results
  ([xkjyeah/singapore-postal-codes](https://github.com/xkjyeah/singapore-postal-codes)), under the
  Singapore Open Data Licence.
