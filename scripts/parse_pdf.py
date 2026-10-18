"""Turn the People's Association haze shelter PDF into data/shelters.csv.

Usage:
    pip install pdfplumber
    python scripts/parse_pdf.py data/source.pdf data/shelters.csv

The PDF is a 4-column table: District | Name of CC | Address of CC | Postal Code.
This script:
  * drops title, header and "<X> District" section rows
  * restores leading zeros the PDF lost (e.g. 50034 -> 050034)
  * tidies unit-number spacing ("#01 - 06" -> "#01-06")
  * applies the small list of known corrections in CORRECTIONS below
  * fails loudly if a postal code is not a valid Singapore code
"""

import csv
import re
import sys

import pdfplumber

# Known errors in the source PDF. Each fix only applies when the field still
# holds the old value, so a corrected future PDF won't be touched. Any fix that
# no longer matches is reported, so stale entries can be removed.
# Format: (shelter name, field, old value, new value, reason)
CORRECTIONS = [
    ("Sengkang West Zone 'K' RN", "address", "326C Anchorvole Road #01-280",
     "326C Anchorvale Road #01-280", "Spelling of Anchorvale"),
    # PDF postal 792451 is Blk 451B Sengkang West Way, ~500 m away. OnePA lists
    # this RN at 457A Sengkang West Road; 457A's postal code is 791457.
    # https://www.onepa.gov.sg/rc/fernvale-zone-k-rn
    ("Fernvale Zone K RN", "postal_code", "792451", "791457",
     "Postal code belonged to a different block"),
    # PDF postal 792441 is Blk 441B; the RN is at 441C (postal 793441).
    # https://www.onepa.gov.sg/rc/fernvale-zone-h-rn
    ("Fernvale Zone H RN", "postal_code", "792441", "793441",
     "Postal code belonged to the neighbouring block"),
    # OnePA lists 116 Bukit Batok West Ave 6 #01-228, Singapore 650116.
    # https://www.onepa.gov.sg/rc/bukit-batok-zone-1-rn
    ("Bukit Batok Zone 1 RN", "address", "16 Bukit Batok West Ave 6",
     "116 Bukit Batok West Ave 6 #01-228", "Block number missing a digit"),
]

VALID_DISTRICTS = {"Central", "North East", "North West", "South East", "South West"}


def clean(text):
    if text is None:
        return ""
    text = text.replace("‘", "'").replace("’", "'")
    return re.sub(r"\s+", " ", text).strip()


def tidy_address(addr):
    # "#01 -270", "# 01-43", "#01 - 1288", "#01- 20" -> "#01-270" etc.
    addr = re.sub(r"#\s*(\d+)\s*-\s*(\d)", r"#\1-\2", addr)
    return addr


def shelter_type(name):
    if re.search(r"\bCC\b", name):
        return "Community Club"
    if re.search(r"\bRC\b", name):
        return "Residents' Committee Centre"
    if re.search(r"\bRN\b|Residents' Network", name):
        return "Residents' Network Centre"
    return "Community venue"


def valid_postal(code):
    # Singapore postal sectors run 01-82 (74 is unused).
    if not re.fullmatch(r"\d{6}", code):
        return False
    sector = int(code[:2])
    return 1 <= sector <= 82 and sector != 74


def parse(pdf_path):
    rows = []
    with pdfplumber.open(pdf_path) as pdf:
        for page in pdf.pages:
            for table in page.extract_tables():
                for raw in table:
                    cells = [clean(c) for c in raw] + [""] * (4 - len(raw))
                    district, name, address, postal = cells[:4]
                    if district not in VALID_DISTRICTS:
                        continue  # title, header or section row
                    if not (name and address and postal):
                        raise SystemExit(f"Incomplete row: {cells}")
                    postal = re.sub(r"\D", "", postal).zfill(6)
                    rows.append({
                        "district": district,
                        "name": name,
                        "type": shelter_type(name),
                        "address": tidy_address(address),
                        "postal_code": postal,
                    })
    return rows


def apply_corrections(rows):
    for name, field, old, new, reason in CORRECTIONS:
        hits = [r for r in rows if r["name"] == name and r[field] == old]
        if not hits:
            print(f"NOTE: correction no longer applies, consider removing: {name} / {field}")
        for r in hits:
            r[field] = new
            print(f"Corrected {name}: {field} {old!r} -> {new!r} ({reason})")


def main():
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    pdf_path, out_path = sys.argv[1], sys.argv[2]
    rows = parse(pdf_path)
    apply_corrections(rows)

    bad = [r for r in rows if not valid_postal(r["postal_code"])]
    if bad:
        for r in bad:
            print(f"INVALID postal code: {r}")
        raise SystemExit(1)

    seen = {}
    for r in rows:
        key = (r["name"], r["postal_code"])
        if key in seen:
            print(f"WARNING: duplicate row {key}")
        seen[key] = True

    with open(out_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=["district", "name", "type", "address", "postal_code"])
        writer.writeheader()
        writer.writerows(rows)

    by_district = {}
    for r in rows:
        by_district[r["district"]] = by_district.get(r["district"], 0) + 1
    print(f"Wrote {len(rows)} shelters to {out_path}: {by_district}")


if __name__ == "__main__":
    main()
