"""Check whether the People's Association has published a different haze shelter list.

Usage:
    python scripts/watch_pa.py <output-dir>

Reads PA's Community Haze Shelters page, finds the linked PDF, downloads it and
compares it with data/source.pdf. Writes to <output-dir>:
    new.pdf      the PDF PA currently links to
    summary.md   what changed (for the alert)
    result.json  {"changed": bool, "url": ..., "sha256": ..., ...}

Exits 0 whether or not the list changed; exits 2 if PA's page could not be
read or no list link was found (so the page layout needs a look).
Uses only the Python standard library, plus pdfplumber via parse_pdf.py.
"""

import csv
import hashlib
import html
import json
import os
import re
import subprocess
import sys
import urllib.parse
import urllib.request

PAGE_URL = "https://www.pa.gov.sg/our-network/community-clubs/shelters/"
CURRENT_PDF = "data/source.pdf"
CURRENT_CSV = "data/shelters.csv"
UA = "Mozilla/5.0 (compatible; haze-shelter-finder/1.0; +https://sghaze.github.io/sg-haze/)"


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return resp.read()


def find_list_link(page_html):
    links = re.findall(r'href="([^"]+\.pdf)"', page_html, flags=re.I)
    links = [html.unescape(link) for link in links]
    preferred = [link for link in links if re.search(r"haze|shelter", link, re.I)]
    return (preferred or links or [None])[0]


def last_updated(page_html):
    text = re.sub(r"<[^>]+>", " ", page_html)
    m = re.search(r"Last updated on\s+(\d{1,2}\s+\w+\s+\d{4})", text)
    return m.group(1) if m else ""


def encode_url(url):
    parts = urllib.parse.urlsplit(url)
    return urllib.parse.urlunsplit(parts._replace(path=urllib.parse.quote(parts.path)))


def read_rows(csv_path):
    with open(csv_path, encoding="utf-8") as f:
        return list(csv.DictReader(f))


def name_key(name):
    # "Elias View Residents' Network" and "Hougang Zone '1' RN" compare equal to
    # "Elias View RN" and "Hougang Zone 1 RN": PA often restyles names.
    name = re.sub(r"residents' network", "rn", name.lower())
    return re.sub(r"\s+", " ", re.sub(r"['\"]", "", name)).strip()


def compare(old_rows, new_rows):
    """Pair up shelters across the two lists.

    Same name and postal code -> unchanged (or address changed); same postal
    code only -> renamed; same name only -> moved. The rest are added/removed.
    """
    old, new = list(old_rows), list(new_rows)
    result = {"address": [], "renamed": [], "moved": [], "restyled": 0}

    def pair(same, record):
        for o in list(old):
            n = next((n for n in new if same(o, n)), None)
            if n is not None:
                old.remove(o)
                new.remove(n)
                record(o, n)

    def same_name(o, n):
        if o["name"] != n["name"]:
            result["restyled"] += 1
        if o["address"] != n["address"]:
            result["address"].append((o, n))

    pair(lambda o, n: o["postal_code"] == n["postal_code"] and name_key(o["name"]) == name_key(n["name"]), same_name)
    pair(lambda o, n: o["postal_code"] == n["postal_code"], lambda o, n: result["renamed"].append((o, n)))
    pair(lambda o, n: name_key(o["name"]) == name_key(n["name"]), lambda o, n: result["moved"].append((o, n)))
    result["added"], result["removed"] = new, old
    return result


def place(row):
    return f"{row['address']}, {row['postal_code']}"


def main():
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    out = sys.argv[1]
    os.makedirs(out, exist_ok=True)

    try:
        page = fetch(PAGE_URL).decode("utf-8", "replace")
    except Exception as exc:  # noqa: BLE001 - report any network failure
        print(f"Could not read PA's page: {exc}")
        sys.exit(2)
    link = find_list_link(page)
    if not link:
        print("No PDF link found on PA's page. The page layout may have changed.")
        sys.exit(2)
    url = urllib.parse.urljoin(PAGE_URL, link)
    updated = last_updated(page)

    try:
        pdf = fetch(encode_url(url))
    except Exception as exc:  # noqa: BLE001 - report any network failure
        print(f"Could not download the list from {url}: {exc}")
        sys.exit(2)
    if not pdf.startswith(b"%PDF"):
        print(f"The list link returned something that isn't a PDF ({len(pdf)} bytes). PA's site may be blocking the check.")
        sys.exit(2)
    new_sha = hashlib.sha256(pdf).hexdigest()
    with open(CURRENT_PDF, "rb") as f:
        current_sha = hashlib.sha256(f.read()).hexdigest()
    new_path = os.path.join(out, "new.pdf")
    with open(new_path, "wb") as f:
        f.write(pdf)

    result = {
        "changed": new_sha != current_sha,
        "url": url,
        "page": PAGE_URL,
        "page_last_updated": updated,
        "sha256": new_sha,
        "size_kb": round(len(pdf) / 1024, 1),
    }
    lines = [
        f"PA's page: {PAGE_URL}" + (f" (last updated {updated})" if updated else ""),
        f"List PDF: {url} ({result['size_kb']} KB)",
        "",
    ]

    if result["changed"]:
        # Read the new list with the same parser the site uses and compare.
        new_csv = os.path.join(out, "new.csv")
        parsed = subprocess.run(
            [sys.executable, "scripts/parse_pdf.py", new_path, new_csv],
            capture_output=True, text=True, check=False,
        )
        if parsed.returncode != 0:
            result["readable"] = False
            lines += ["**The new PDF could not be read automatically**; its layout may have changed.",
                      "", "```", (parsed.stdout + parsed.stderr)[-1500:], "```"]
        else:
            result["readable"] = True
            old, new = read_rows(CURRENT_CSV), read_rows(new_csv)
            diff = compare(old, new)
            with open(os.path.join(out, "source-meta.json"), encoding="utf-8") as f:
                as_at = json.load(f)["as_at"]
            result.update({"as_at": as_at, "count": len(new), "previous_count": len(old),
                           **{k: len(diff[k]) for k in ("added", "removed", "moved", "renamed", "address")}})
            lines += [f"New list: **{len(new)} shelters**, as at {as_at} (site currently has {len(old)}).", ""]
            sections = (
                ("Added", diff["added"], lambda r: f"{r['name']}, {place(r)}"),
                ("Removed", diff["removed"], lambda r: f"{r['name']}, {place(r)}"),
                ("Moved", diff["moved"], lambda p: f"{p[1]['name']}: {place(p[0])} → {place(p[1])}"),
                ("Renamed", diff["renamed"], lambda p: f"{p[0]['name']} → {p[1]['name']} ({place(p[1])})"),
                ("Address changed", diff["address"], lambda p: f"{p[1]['name']}: {p[0]['address']} → {p[1]['address']}"),
            )
            for title, items, fmt in sections:
                if not items and title not in ("Added", "Removed"):
                    continue
                lines.append(f"**{title} ({len(items)})**")
                lines += [f"- {fmt(item)}" for item in items[:60]] or ["- none"]
                if len(items) > 60:
                    lines.append(f"- … and {len(items) - 60} more")
                lines.append("")
            if diff["restyled"]:
                lines += [f"{diff['restyled']} other names changed only in style "
                          "(quotes, \"Residents' Network\" → \"RN\").", ""]
            if parsed.stdout.strip():
                lines += ["Parser notes:", "```", parsed.stdout.strip()[-1500:], "```"]
    else:
        lines.append("The site already uses this list. No change.")

    with open(os.path.join(out, "summary.md"), "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    with open(os.path.join(out, "result.json"), "w", encoding="utf-8") as f:
        json.dump(result, f, indent=1)
    print("\n".join(lines))


if __name__ == "__main__":
    main()
