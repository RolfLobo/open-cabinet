#!/usr/bin/env python3
"""
Crop each annual-lane row's band out of its report page and save it as an
image a reader can open under the row.

    python3 scripts/render-evidence-strips.py --pdfs <dir> [--only <slug>]

For every official file under data/officials whose rows carry sourceKind
"annual-278e" or "termination-278e" with a sourcePage and sourceRow, the
row is found on that page by its printed row number (scripts/part7_pdf.py,
the same locator that produced the page), the band from the row number's
top to the next row's top is cropped at full page width and rendered at
2x (144 dpi), and written to

    public/evidence/<slug>/<sourceKind>-<page>-<row>.png

Trump's rows are skipped on purpose: 21,000 strips would be a 100 MB
commit for a report whose rows link to their page instead.

The PDFs are looked up by the last path segment of the row's sourceUrl in
<dir> (the audit's annuals/ folder names files by slug and report, so a
small alias table maps URL basenames to those names).
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from urllib.parse import unquote

import pdfplumber

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from part7_pdf import rows_on_page  # noqa: E402

LANE_KINDS = {"annual-278e", "termination-278e"}
SKIP_SLUGS = {"trump-donald-j"}
SCALE = 2  # 2x of 72 dpi


def find_pdf(pdf_dir: str, source_url: str) -> str | None:
    """The local PDF for a report URL: by exact basename, else by the
    audit's slug-and-kind naming, matched on the report's OGE file id."""
    base = unquote(source_url.split("/")[-1])
    direct = os.path.join(pdf_dir, base)
    if os.path.exists(direct):
        return direct
    manifest = os.path.join(pdf_dir, "downloads.json")
    if os.path.exists(manifest):
        for d in json.load(open(manifest)):
            if d.get("pdfUrl") == source_url:
                return os.path.join(pdf_dir, d["file"])
    return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pdfs", required=True, help="directory holding the report PDFs (the audit's annuals/ folder)")
    ap.add_argument("--only", action="append")
    ap.add_argument("--out", default=os.path.join("public", "evidence"))
    args = ap.parse_args()

    officials_dir = os.path.join("data", "officials")
    written = 0
    missing = []
    for name in sorted(os.listdir(officials_dir)):
        if not name.endswith(".json"):
            continue
        slug = name[:-5]
        if slug in SKIP_SLUGS or (args.only and slug not in args.only):
            continue
        official = json.load(open(os.path.join(officials_dir, name)))
        lane_rows = [t for t in official["transactions"] if t.get("sourceKind") in LANE_KINDS and t.get("sourcePage") and t.get("sourceRow")]
        if not lane_rows:
            continue
        by_url: dict[str, list[dict]] = {}
        for t in lane_rows:
            by_url.setdefault(t["sourceUrl"], []).append(t)
        out_dir = os.path.join(args.out, slug)
        os.makedirs(out_dir, exist_ok=True)
        for url, rows in by_url.items():
            pdf = find_pdf(args.pdfs, url)
            if not pdf:
                missing.append((slug, url))
                continue
            with pdfplumber.open(pdf) as doc:
                cache: dict[int, list] = {}
                hint = None
                for t in sorted(rows, key=lambda r: (r["sourcePage"], r["sourceRow"])):
                    pno = t["sourcePage"]
                    if pno not in cache:
                        # Rows on earlier pages may set the account hint; for
                        # the crop only the row's own band matters.
                        located, hint = rows_on_page(doc.pages[pno - 1], pno, hint)
                        cache[pno] = located
                    band = next((r for r in cache[pno] if r.row == t["sourceRow"]), None)
                    if not band:
                        missing.append((slug, f"{url}#page={pno} row {t['sourceRow']}"))
                        continue
                    page = doc.pages[pno - 1]
                    # A last row's band runs to the end of the table on the
                    # page (endnotes, a following part). Cap it at twice the
                    # median row height so the strip shows one row.
                    heights = sorted(r.bottom - r.top for r in cache[pno])
                    median = heights[len(heights) // 2] if heights else 30
                    bottom = min(band.bottom, band.top + 2 * median)
                    top = max(0, band.top - 1)
                    crop = page.crop((0, top, page.width, min(page.height, bottom + 1)))
                    img = crop.to_image(resolution=72 * SCALE)
                    file = os.path.join(out_dir, f"{t['sourceKind']}-{pno}-{t['sourceRow']}.png")
                    img.save(file, format="PNG")
                    written += 1
        print(f"{slug}: {len(lane_rows)} lane rows")
    print(f"wrote {written} strips")
    for m in missing:
        print("  missing:", m)
    return 1 if missing else 0


if __name__ == "__main__":
    sys.exit(main())
