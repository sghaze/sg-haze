# Haze Shelter Finder (Singapore)

A one-page website: type a Singapore postal code (or tap **Use my current location**) and see the
nearest community haze shelters, with straight-line distance and a Google Maps directions link.

- 341 shelters from the People's Association list, *as at September 2026*
- Works on phones, light and dark mode, no cookies or tracking, no external libraries
- **Not an official government website**

Once GitHub Pages is switched on (below), the site lives at
**https://iamnuthin84-coder.github.io/Haze-Shelters/**

## Switch the site on (one time)

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
4. In the browser, `docs/app.js` asks OneMap for the visitor's postal code location, then sorts
   shelters by distance. Nothing is sent to any other server.

**Backup if OneMap is down:** `docs/postal-areas.json` holds the rough centre of every postal area
(the first 2–3 digits), built by `scripts/build_postal_areas.py`. If OneMap doesn't answer within
8 seconds, the site shows shelters near that area and labels the result as approximate.

## Updating when a new list comes out

1. On GitHub, go to the `data` folder, choose **Add file → Upload files**, and upload the new PDF
   named exactly **`source.pdf`** (it replaces the old one). Commit.
2. Wait for the **Actions** run to finish (about 5 minutes when many postal codes are new).
3. Open **`data/geocode-report.md`** and review any flagged shelters. The usual problem is a postal
   code that doesn't match the address. Fixes go in the `CORRECTIONS` list at the top of
   `scripts/parse_pdf.py`, each with a reason and a source.

If the Action fails at "Read the shelter PDF", the new PDF's layout has changed and the parser
needs updating.

## Corrections made to the September 2026 PDF

Checked against PA's own [OnePA](https://www.onepa.gov.sg/) pages:

| Shelter | In the PDF | Corrected to | Why |
|---|---|---|---|
| Fernvale Zone K RN | postal 792451 | 791457 | 792451 is Blk 451B Sengkang West Way, ~500 m away. OnePA lists the RN at 457A Sengkang West Rd. |
| Fernvale Zone H RN | postal 792441 | 793441 | 792441 is Blk 441B; the RN is at 441C. |
| Bukit Batok Zone 1 RN | 16 Bukit Batok West Ave 6 | 116 Bukit Batok West Ave 6 #01-228 | Missing digit; OnePA and the postal code (650116) both say Blk 116. |
| Sengkang West Zone 'K' RN | Anchorvole Road | Anchorvale Road | Spelling. |
| 8 shelters (e.g. Kreta Ayer CC) | 5-digit postal codes, e.g. 88995 | 088995 | The PDF dropped leading zeros. |

## Known limits

- **Distances are straight-line**, not walking routes. Rivers, expressways and MRT lines can make
  the true walk longer. The site shows 5 options (more on request) so people can choose.
- **Opening hours and activation aren't in the data.** Shelters open only when activated, and
  hours differ by venue. The site says so and points to [haze.gov.sg](https://www.haze.gov.sg/)
  and [onepa.gov.sg](https://www.onepa.gov.sg/).
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
  Integrated Community Hubs, Residents' Centres and Residents' Network* (as at September 2026),
  kept here as `data/source.pdf`.
- Location search: OneMap © Singapore Land Authority.
- Postal area backup table: derived from a 2017 dump of OneMap postal code results
  ([xkjyeah/singapore-postal-codes](https://github.com/xkjyeah/singapore-postal-codes)), under the
  Singapore Open Data Licence.
