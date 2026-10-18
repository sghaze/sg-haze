"""Build docs/postal-areas.json: the rough centre of each postal area.

The site uses this only as a backup when OneMap can't be reached. It maps the
first 3 digits (and, failing that, the first 2 digits) of a postal code to the
average position of all buildings sharing that prefix.

Source: a public dump of OneMap postal code search results (April 2017),
https://github.com/xkjyeah/singapore-postal-codes (buildings.json), used under
the Singapore Open Data Licence. Newer estates are missing, which is why the
2-digit fallback exists.

Usage:
    curl -LO https://raw.githubusercontent.com/xkjyeah/singapore-postal-codes/master/buildings.json
    python scripts/build_postal_areas.py buildings.json docs/postal-areas.json
"""

import json
import sys


def main():
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    with open(sys.argv[1], encoding="utf-8") as f:
        buildings = json.load(f)

    sums = {2: {}, 3: {}}
    for b in buildings:
        pc = (b.get("POSTAL") or "").strip()
        if len(pc) != 6 or not pc.isdigit():
            continue
        lat, lng = float(b["LATITUDE"]), float(b.get("LONGITUDE") or b["LONGTITUDE"])
        if not (1.1 < lat < 1.5 and 103.5 < lng < 104.1):
            continue
        for n in (2, 3):
            s = sums[n].setdefault(pc[:n], [0.0, 0.0, 0])
            s[0] += lat
            s[1] += lng
            s[2] += 1

    out = {
        "source": "OneMap postal code search dump, April 2017 (Singapore Open Data Licence)",
        "areas": {
            str(n): {k: [round(a / c, 4), round(o / c, 4)] for k, (a, o, c) in sorted(sums[n].items())}
            for n in (2, 3)
        },
    }
    with open(sys.argv[2], "w", encoding="utf-8") as f:
        json.dump(out, f, separators=(",", ":"))
        f.write("\n")
    print(f"{len(out['areas']['2'])} 2-digit areas, {len(out['areas']['3'])} 3-digit areas")


if __name__ == "__main__":
    main()
