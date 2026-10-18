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


def shelters_by_key(csv_path):
    with open(csv_path, encoding="utf-8") as f:
        return {(r["name"], r["postal_code"]): r for r in csv.DictReader(f)}


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
            old, new = shelters_by_key(CURRENT_CSV), shelters_by_key(new_csv)
            added = sorted(set(new) - set(old))
            removed = sorted(set(old) - set(new))
            changed = sorted(k for k in set(old) & set(new) if old[k]["address"] != new[k]["address"])
            with open(os.path.join(out, "source-meta.json"), encoding="utf-8") as f:
                as_at = json.load(f)["as_at"]
            result.update({"as_at": as_at, "count": len(new), "added": len(added), "removed": len(removed)})
            lines += [f"New list: **{len(new)} shelters**, as at {as_at} (site currently has {len(old)}).", ""]
            for title, keys, source in (("Added", added, new), ("Removed", removed, old)):
                lines.append(f"**{title} ({len(keys)})**")
                lines += [f"- {source[k]['name']}, {source[k]['address']}, {k[1]}" for k in keys[:60]] or ["- none"]
                if len(keys) > 60:
                    lines.append(f"- … and {len(keys) - 60} more")
                lines.append("")
            if changed:
                lines.append(f"**Address changed ({len(changed)})**")
                lines += [f"- {old[k]['name']}: {old[k]['address']} → {new[k]['address']}" for k in changed[:30]]
                lines.append("")
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
