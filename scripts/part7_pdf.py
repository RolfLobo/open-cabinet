"""
Shared helpers for reading Part 7 (Transactions) of an OGE Form 278e with
pdfplumber: where each printed row sits on which physical page.

Two scripts import this: scripts/locate-part7-rows.py, which writes a page
map the annual-report ingest reads, and scripts/render-evidence-strips.py,
which crops each row's band from the page image. They share one locator so
the page a row links to and the strip a reader sees come from the same
coordinates.

Why locate from the PDF instead of trusting the audit's `page` field: the
audit's row readers recorded pages under two different conventions (the
text-layer reader's number is one below the physical page; the paper
reader's equals it). A `#page=` link needs the physical page, so it is
read from the document, and a row that cannot be located gets null, never
a guess.

Layout facts this relies on, checked on the 19 reports of Sep 2026:
- A Part 7 page prints the column header "# DESCRIPTION TYPE DATE AMOUNT".
  Part 6 (assets) also numbers its rows, so pages without that header
  are ignored.
- Row numbers print in the leftmost column (x0 under 70 points).
- A row's band runs from its number's top to the next number's top, or to
  the last word of the table on the page.
- The trade date (m/d/yyyy) and the type word print in the same band, so
  (row number, date, type) identifies a row within a filing except on
  Trump's annual, where row numbers restart per investment account; the
  account heading printed on the page breaks that tie.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

import pdfplumber

HEADER = re.compile(r"#\s+DESCRIPTION\s+TYPE\s+DATE\s+AMOUNT", re.I)
ACCOUNT = re.compile(r"INVESTMENT ACCOUNT #\d+")
DATE = re.compile(r"\b(\d{1,2})/(\d{1,2})/(\d{4})\b")
TYPE = re.compile(r"\b(Sale \(Partial\)|Sale \(Full\)|Purchase|Sale|Exchange)\b", re.I)
ROW_NUMBER_MAX_X0 = 70


@dataclass
class LocatedRow:
    row: int
    page: int  # physical, 1-based
    top: float
    bottom: float
    iso_date: str | None
    type: str | None
    text: str
    account: str | None


@dataclass
class PageIndex:
    rows: list[LocatedRow] = field(default_factory=list)
    accounts_by_page: dict[int, str | None] = field(default_factory=dict)


def iso(m: re.Match[str]) -> str:
    return f"{m.group(3)}-{int(m.group(1)):02d}-{int(m.group(2)):02d}"


def rows_on_page(page, page_number: int, account_hint: str | None) -> tuple[list[LocatedRow], str | None]:
    """Rows of one Part 7 page, with the account heading in force on it.

    `account_hint` is the last heading seen on an earlier page; a page whose
    heading did not extract (or that continues an account) inherits it.
    Returns ([], hint) for a page that is not a Part 7 table page.
    """
    text = page.extract_text() or ""
    if not HEADER.search(re.sub(r"\s+", " ", text)):
        return [], account_hint
    headings = ACCOUNT.findall(text)
    account = headings[0] if headings else account_hint
    words = page.extract_words(use_text_flow=False, keep_blank_chars=False)
    header_word = next((w for w in words if w["text"] == "#" and w["x0"] < ROW_NUMBER_MAX_X0), None)
    table_top = header_word["bottom"] if header_word else 0
    # Row numbers sit in the "#" column. Anchoring on the header's own x
    # keeps a number inside a description ("PHILLIPS 66 COM" starts at
    # x=38 on Trump's scan, under the 70-point margin) from being read as
    # a row start and collapsing its neighbour's band to nothing.
    number_x0 = header_word["x0"] if header_word else 0
    numbers = sorted(
        (
            w for w in words
            if re.fullmatch(r"\d{1,4}", w["text"]) and w["top"] > table_top
            and (abs(w["x0"] - number_x0) < 12 if header_word else w["x0"] < ROW_NUMBER_MAX_X0)
        ),
        key=lambda w: w["top"],
    )
    # The last word of the table on the page bounds the final band; the
    # footer ("Donald J. Trump 846 of 847") sits below the table and is not
    # part of it, so stop at the lowest word that is not footer text.
    body_words = [w for w in words if w["top"] > table_top and not re.fullmatch(r"(of|\d+|Trump|Donald|J\.)", w["text"]) or w["top"] <= table_top]
    table_bottom = max((w["bottom"] for w in body_words if w["top"] > table_top), default=page.height)
    located: list[LocatedRow] = []
    for i, w in enumerate(numbers):
        top = w["top"] - 3
        bottom = (numbers[i + 1]["top"] - 3) if i + 1 < len(numbers) else min(table_bottom + 3, page.height)
        band = [x for x in words if x["top"] >= top and x["top"] < bottom]
        band_text = " ".join(x["text"] for x in sorted(band, key=lambda x: (round(x["top"]), x["x0"])))
        d = DATE.search(band_text)
        # The type column sits between the description and the date; a
        # type word inside a name ("INTERCONTINENTAL EXCHANGE INC") comes
        # first, so take the last type token before the date.
        types_before = [m for m in TYPE.finditer(band_text) if not d or m.start() < d.start()]
        t = types_before[-1] if types_before else None
        located.append(
            LocatedRow(
                row=int(w["text"]), page=page_number, top=top, bottom=bottom,
                iso_date=iso(d) if d else None, type=t.group(1).title() if t else None,
                text=band_text, account=account,
            )
        )
    # The heading in force at the end of the page carries to the next one.
    return located, (headings[-1] if headings else account)


def index_pdf(pdf_path: str, pages: range | None = None, log=None) -> PageIndex:
    """Every located row of every Part 7 page in the file."""
    out = PageIndex()
    with pdfplumber.open(pdf_path) as doc:
        hint: str | None = None
        rng = pages if pages is not None else range(len(doc.pages))
        for i in rng:
            rows, hint = rows_on_page(doc.pages[i], i + 1, hint)
            out.accounts_by_page[i + 1] = hint
            out.rows.extend(rows)
            if log and (i + 1) % 100 == 0:
                log(f"  page {i + 1}/{len(doc.pages)}: {len(out.rows)} rows so far")
    return out


def normalize_account(printed: str | None) -> str | None:
    return re.sub(r"\s+", " ", printed).strip().upper() if printed else None


def match_row(index: PageIndex, row: int, iso_date: str, type_: str, account: str | None, description: str) -> LocatedRow | None:
    """The located row for one audit row, or None when it cannot be pinned.

    Match on (row number, date, base type). If several pages carry that
    tuple (Trump's per-account numbering), keep the ones under the same
    account heading, then the ones whose band text starts with the
    description's first word. Anything still ambiguous is None: a wrong
    page link is worse than no link.
    """
    # Trump's scan prints types in lower case ("purchase"); compare base
    # types case-insensitively, and every Sale variant as Sale.
    base = "sale" if type_.lower().startswith("sale") else type_.lower()
    cands = [r for r in index.rows if r.row == row and r.iso_date == iso_date and r.type and (r.type.lower().startswith("sale") if base == "sale" else r.type.lower() == base)]
    if len(cands) > 1 and account:
        acct = normalize_account(account)
        cands = [r for r in cands if normalize_account(r.account) == acct]
    if len(cands) > 1:
        first = re.sub(r"[^A-Za-z0-9]", "", description.split()[0]).upper() if description.split() else ""
        cands = [r for r in cands if first and first in re.sub(r"[^A-Za-z0-9]", "", r.text).upper()]
    return cands[0] if len(cands) == 1 else None
