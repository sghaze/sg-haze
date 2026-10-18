"""Look up map coordinates for every shelter using OneMap (Singapore Land Authority).

Usage:
    python scripts/geocode.py data/shelters.csv docs/shelters.json data/geocode-report.md

Reads data/geocode-cache.json (if present) so only new postal codes are looked
up. Uses only the Python standard library.

Each shelter is looked up by its postal code. The block/street number OneMap
returns is compared with the one in the PDF address; disagreements are listed
in the report so a person can decide which is right (fixes go in
scripts/parse_pdf.py CORRECTIONS).
"""

import csv
import datetime
import json
import math
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

SEARCH_URL = os.environ.get("ONEMAP_SEARCH_URL", "https://www.onemap.gov.sg/api/common/elastic/search")
CACHE_PATH = os.environ.get("GEOCODE_CACHE", "data/geocode-cache.json")
REQUEST_GAP_SECONDS = float(os.environ.get("GEOCODE_GAP", "0.3"))  # OneMap allows roughly 250 requests a minute
SOURCE_NOTE = ("List of Community Haze Shelters at Community Clubs, Integrated Community Hubs, "
               "Residents' Centres and Residents' Network, People's Association")
META_PATH = "data/source-meta.json"  # written by parse_pdf.py


def onemap_search(query):
    params = urllib.parse.urlencode({
        "searchVal": query, "returnGeom": "Y", "getAddrDetails": "Y", "pageNum": 1,
    })
    url = f"{SEARCH_URL}?{params}"
    for attempt in range(5):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "haze-shelter-finder/1.0"})
            with urllib.request.urlopen(req, timeout=20) as resp:
                data = json.load(resp)
            return [slim(r) for r in data.get("results", [])]
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
            wait = 2 ** (attempt + 1)
            print(f"  retry in {wait}s ({exc})")
            time.sleep(wait)
    raise RuntimeError(f"OneMap search failed for {query!r}")


def slim(r):
    lng = r.get("LONGITUDE") or r.get("LONGTITUDE")
    return {
        "blk_no": (r.get("BLK_NO") or "").strip(),
        "road_name": (r.get("ROAD_NAME") or "").strip(),
        "building": (r.get("BUILDING") or "").strip(),
        "address": (r.get("ADDRESS") or "").strip(),
        "postal": (r.get("POSTAL") or "").strip(),
        "lat": float(r["LATITUDE"]),
        "lng": float(lng),
    }


def block_from_address(address):
    m = re.match(r"^(?:Blk\s+|No\.\s+)?(\d+)\s*([A-Za-z])?\b", address)
    if not m:
        return ""
    return (m.group(1) + (m.group(2) or "")).upper()


def distance_m(a, b):
    r = 6371000
    p1, p2 = math.radians(a["lat"]), math.radians(b["lat"])
    dp = p2 - p1
    dl = math.radians(b["lng"] - a["lng"])
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


def load_cache():
    if os.path.exists(CACHE_PATH):
        with open(CACHE_PATH, encoding="utf-8") as f:
            return json.load(f)
    return {}


def save_cache(cache):
    with open(CACHE_PATH, "w", encoding="utf-8") as f:
        json.dump(dict(sorted(cache.items())), f, indent=1, ensure_ascii=False)
        f.write("\n")


def cached_search(cache, key, query):
    if key not in cache:
        print(f"OneMap lookup: {query}")
        cache[key] = onemap_search(query)
        time.sleep(REQUEST_GAP_SECONDS)
    return cache[key]


def main():
    if len(sys.argv) != 4:
        raise SystemExit(__doc__)
    csv_path, json_path, report_path = sys.argv[1:]
    with open(csv_path, encoding="utf-8") as f:
        shelters = list(csv.DictReader(f))

    with open(META_PATH, encoding="utf-8") as f:
        as_at = json.load(f)["as_at"]

    cache = load_cache()
    out, problems = [], []
    try:
        for s in shelters:
            pc = s["postal_code"]
            hits = [r for r in cached_search(cache, f"postal:{pc}", pc) if r["postal"] == pc]
            want_blk = block_from_address(s["address"])
            match = next((r for r in hits if r["blk_no"].upper() == want_blk), None)
            chosen = match or (hits[0] if hits else None)

            if chosen is None:
                status = "not_found"
            elif match or s["type"] == "Community Club":
                # Community clubs often have a street number that differs from
                # the OneMap block field; the postal code alone is reliable.
                status = "ok"
            elif re.sub(r"\D", "", chosen["blk_no"]) == re.sub(r"\D", "", want_blk):
                status = "minor: block letter differs"  # e.g. 185 vs 185B, next door
            else:
                status = "block_mismatch"

            if status != "ok":
                # Second opinion: search the written address instead.
                street = re.sub(r"#.*$", "", s["address"]).replace("Blk ", "").strip(" ,")
                alt = cached_search(cache, f"address:{street}", street)
                alt_best = alt[0] if alt else None
                problems.append({
                    "shelter": s,
                    "status": status,
                    "postal_result": chosen,
                    "address_result": alt_best,
                    "gap_m": round(distance_m(chosen, alt_best)) if chosen and alt_best else None,
                })
                if chosen is None and alt_best is not None:
                    chosen = alt_best  # better an address-based pin than none
                    problems[-1]["status"] = "postal_not_found_used_address"

            out.append({
                "name": s["name"],
                "type": s["type"],
                "district": s["district"],
                "address": s["address"],
                "postal": pc,
                "lat": round(chosen["lat"], 6) if chosen else None,
                "lng": round(chosen["lng"], 6) if chosen else None,
            })
    finally:
        save_cache(cache)

    found = sum(1 for o in out if o["lat"] is not None)
    write_report(report_path, out, problems)
    print(f"Located {found}/{len(out)} shelters; {len(problems)} need review. See {report_path}")
    if found < 0.9 * len(out):
        raise SystemExit("Fewer than 90% of shelters located: OneMap may have changed. Not publishing.")

    # Keep the old "generated" date when nothing changed, so re-runs don't
    # create a new commit every day.
    generated = datetime.date.today().isoformat()
    if os.path.exists(json_path):
        with open(json_path, encoding="utf-8") as f:
            old = json.load(f)
        if old.get("shelters") == out and old.get("as_at") == as_at:
            generated = old.get("generated", generated)

    os.makedirs(os.path.dirname(json_path) or ".", exist_ok=True)
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump({
            "source": SOURCE_NOTE,
            "as_at": as_at,
            "generated": generated,
            "count": len(out),
            "shelters": out,
        }, f, ensure_ascii=False, separators=(",", ":"))
        f.write("\n")


def write_report(path, out, problems):
    lines = [
        "# Geocoding report",
        "",
        "Written by `scripts/geocode.py` each time the data is rebuilt.",
        "",
        f"- Shelters: {len(out)}",
        f"- Located: {sum(1 for o in out if o['lat'] is not None)}",
        f"- Need review: {len(problems)}",
        "",
    ]
    if problems:
        lines += [
            "Each row below is a shelter whose PDF address and postal code disagree, or that OneMap could not find.",
            "The site currently uses the **postal code** location. If the address is right instead, add a fix to",
            "`CORRECTIONS` in `scripts/parse_pdf.py`.",
            "",
            "| Shelter | Address | Postal code | Status | OneMap for postal code | OneMap for address | Gap |",
            "|---|---|---|---|---|---|---|",
        ]
        for p in problems:
            s, pr, ar = p["shelter"], p["postal_result"], p["address_result"]
            fmt = lambda r: f"{r['address']}" if r else "not found"
            gap = f"{p['gap_m']} m" if p["gap_m"] is not None else "-"
            lines.append(f"| {s['name']} | {s['address']} | {s['postal_code']} | {p['status']} | "
                         f"{fmt(pr)} | {fmt(ar)} | {gap} |")
    else:
        lines.append("No problems found.")
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")


if __name__ == "__main__":
    main()
