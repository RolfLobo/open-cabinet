#!/usr/bin/env python3
"""
Write a page map for each audited annual or termination report: the
physical PDF page (and band coordinates) of every Part 7 row the audit
read, located from the PDF itself.

    python3 scripts/locate-part7-rows.py --inputs <scratchpad> [--only <file-stem>]

Reads  <inputs>/audit/read-a/<stem>.json   (the audit's parsed rows)
       <inputs>/annuals/<stem>.pdf          (the report)
Writes <inputs>/audit/lane-pages/<stem>.json

The ingest (scripts/ingest-annual-reports.ts) reads the page map and sets
sourcePage from it; a row the locator could not pin gets null. Nothing here
changes a row's values; the map carries only where the row was found.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from part7_pdf import index_pdf, match_row  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--inputs", required=True, help="scratchpad root holding audit/read-a and annuals/")
    ap.add_argument("--only", action="append", help="file stem(s) to process; default all")
    args = ap.parse_args()

    read_dir = os.path.join(args.inputs, "audit", "read-a")
    pdf_dir = os.path.join(args.inputs, "annuals")
    out_dir = os.path.join(args.inputs, "audit", "lane-pages")
    os.makedirs(out_dir, exist_ok=True)

    stems = args.only or sorted(f[:-5] for f in os.listdir(read_dir) if f.endswith(".json"))
    for stem in stems:
        read = json.load(open(os.path.join(read_dir, f"{stem}.json")))
        rows = read["rows"] if isinstance(read, dict) else read
        pdf = os.path.join(pdf_dir, f"{stem}.pdf")
        if not rows:
            json.dump({"file": stem, "rows": [], "unresolved": [], "pageCount": None}, open(os.path.join(out_dir, f"{stem}.json"), "w"), indent=1)
            print(f"{stem}: no Part 7 rows")
            continue
        t0 = time.time()
        index = index_pdf(pdf, log=print)
        import pdfplumber
        with pdfplumber.open(pdf) as doc:
            page_count = len(doc.pages)
        located = []
        unresolved = []
        for i, r in enumerate(rows):
            m, d, y = r["date"].split("/")
            iso_date = f"{y}-{int(m):02d}-{int(d):02d}"
            hit = match_row(index, r["row"], iso_date, r["type"], r.get("account"), r["description"])
            if hit:
                located.append({"index": i, "row": r["row"], "account": r.get("account"), "page": hit.page, "top": round(hit.top, 1), "bottom": round(hit.bottom, 1)})
            else:
                unresolved.append({"index": i, "row": r["row"], "account": r.get("account"), "date": iso_date, "type": r["type"], "description": r["description"][:60]})
        out = {"file": stem, "pageCount": page_count, "rows": located, "unresolved": unresolved, "located": len(located), "total": len(rows)}
        json.dump(out, open(os.path.join(out_dir, f"{stem}.json"), "w"), indent=1)
        print(f"{stem}: {len(located)}/{len(rows)} rows located, {len(unresolved)} unresolved, {page_count} pages, {time.time() - t0:.0f}s")
        for u in unresolved[:10]:
            print("   unresolved:", u)
    return 0


if __name__ == "__main__":
    sys.exit(main())
