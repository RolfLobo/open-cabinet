import { describe, expect, it } from "vitest";
import type { CrosscheckEntry } from "./crosscheck-log";
import type { Transaction } from "./types";
import { NOTE, applyImplausible, deriveRowVerification, implausibleValues, locateInParseRecord, makeRecordId, printedRowForIndex, recordIdsFor, type AnnualEvidence } from "./row-verification";
import { compareSecondRead, describePrimaryIndex } from "./second-read";

const URL = "https://example.gov/f.pdf";
const tx = (over: Partial<Transaction> = {}): Transaction => ({
  description: "Apple Inc. (AAPL)",
  ticker: "AAPL",
  type: "Sale",
  date: "2026-06-12",
  amount: "$1,001-$15,000",
  lateFilingFlag: true,
  sourceUrl: URL,
  ...over,
});
const entry = (over: Partial<CrosscheckEntry>): CrosscheckEntry => ({
  sourceUrl: URL, slug: "x", filingDate: "2026-06-20", pdfFile: "f.pdf", pdfSha256: "abc", candidateSha256: "def",
  checkerVersion: "t", state: "no_usable_text", comparedFields: [], rowsCompared: null, publishedRows: 1, checkedAt: "now",
  ...over,
});

describe("record ids", () => {
  it("are stable, and two identical lots get different ids without depending on order", () => {
    const a = tx(), b = tx(), c = tx({ description: "Other" });
    expect(makeRecordId(a, 0)).toBe(makeRecordId(b, 0));
    expect(recordIdsFor([a, b, c])).toEqual([makeRecordId(a, 0), makeRecordId(a, 1), makeRecordId(c, 0)]);
    expect(recordIdsFor([c, a, b]).sort()).toEqual(recordIdsFor([a, b, c]).sort());
  });
});

describe("locating a published row in the parse record", () => {
  it("pairs by description and tuple, consuming lots one to one", () => {
    const record = [tx({ description: "Other" }), tx(), tx()];
    expect(locateInParseRecord([tx(), tx(), tx()], record)).toEqual([1, 2, -1]);
  });

  it("never pairs two bonds from one issuer by a shared first word (Codex, Sep 6)", () => {
    const mud495 = tx({ description: "HARRIS CNTY TX MUD 495 AGI B/E 4.00 % Due Sep 1, 2035", date: "2025-07-09", amount: "$15,001-$50,000" });
    const mud500 = tx({ description: "HARRIS CNTY TX MUD 500 CNTRCT REV RD FACS SER A BAM B/E PTC 4.00 % Due Dec 1, 2035", date: "2025-07-09", amount: "$15,001-$50,000" });
    const hosp = tx({ description: "HARRIS CNTY TX HOSP DIST REV RFDG SER A B/E 5.00 % Due Oct 1, 2030", date: "2025-07-09", amount: "$15,001-$50,000" });
    // The site holds the 495 bond and the hospital bond; the record has
    // the 495 and 500 bonds. The hospital row must not take the 500 slot.
    expect(locateInParseRecord([mud495, hosp], [mud495, mud500])).toEqual([0, -1]);
    // Wording-only differences still locate: a ticker appended, "Duo" for "Due".
    const apple = tx({ description: "Apple Inc." });
    expect(locateInParseRecord([apple], [tx({ description: "Apple Inc. (AAPL)" })])).toEqual([0]);
    expect(locateInParseRecord([tx({ description: "Progressive Corp Oh" })], [tx({ description: "Progressive Corp On" })])).toEqual([0]);
    const duo = tx({ description: "MONROEVILLE PA FIN AUTH UPMC REV B/E 5.00 % Duo Feb 15, 2026" });
    expect(locateInParseRecord([duo], [tx({ description: "MONROEVILLE PA FIN AUTH UPMC REV B/E 5.00 % Due Feb 15, 2026" })])).toEqual([0]);
  });

  it("maps parsed indexes back to printed rows across placeholders", () => {
    // Printed rows 1, 3, 4 are transactions; 2 is "Line is intentionally left blank".
    expect([0, 1, 2].map((i) => printedRowForIndex(i, [2]))).toEqual([1, 3, 4]);
  });
});

describe("deriveRowVerification", () => {
  const base = { slug: "x", parseRecordByUrl: new Map(), entriesByUrl: new Map<string, CrosscheckEntry>() };

  it("scores 2 when a deterministic lane agreed and the audit has not run; 3 once the audit confirms; 0 if it disputes", () => {
    const rows = [tx({ description: "A" }), tx({ description: "B" }), tx({ description: "C" })];
    const entries = new Map([[URL, entry({ state: "checked_tuple_agreement" })]]);
    const out = deriveRowVerification({ ...base, transactions: rows, entriesByUrl: entries });
    expect(out.map((v) => [v.score, v.state])).toEqual([[2, "deterministic_agree"], [2, "deterministic_agree"], [2, "deterministic_agree"]]);
    const audited = deriveRowVerification({
      ...base,
      transactions: rows,
      entriesByUrl: entries,
      parseRecordByUrl: new Map([[URL, rows]]),
      auditByUrl: new Map([[URL, { confirmed: new Set([0]), disputed: new Set([1]), notFound: new Set([2]) }]]),
    });
    expect(audited.map((v) => [v.score, v.state])).toEqual([[3, "checked"], [0, "disputed"], [0, "disputed"]]);
    expect(audited[1].lane).toBe("audit");
  });

  it("an audit alone lifts a single read to 2, never to 3", () => {
    const rows = [tx({ description: "A" })];
    const out = deriveRowVerification({
      ...base,
      transactions: rows,
      entriesByUrl: new Map([[URL, entry({ state: "no_usable_text" })]]),
      parseRecordByUrl: new Map([[URL, rows]]),
      auditByUrl: new Map([[URL, { confirmed: new Set([0]), disputed: new Set(), notFound: new Set() }]]),
    });
    expect(out[0]).toMatchObject({ score: 2, state: "audit_only" });
  });

  it("credits a filing-level agreement only to rows the checked candidate contains", () => {
    const rows = [tx({ description: "A" }), tx({ description: "B" })];
    const out = deriveRowVerification({
      ...base,
      transactions: rows,
      entriesByUrl: new Map([[URL, entry({ state: "checked_tuple_agreement" })]]),
      parseRecordByUrl: new Map([[URL, [tx({ description: "A" })]]]),
    });
    expect(out.map((v) => v.score)).toEqual([2, 1]);
    expect(out[1].note).toMatch(/does not contain this row/);
  });

  it("scores 0 for the whole filing when the text lane disagreed", () => {
    const out = deriveRowVerification({ ...base, transactions: [tx()], entriesByUrl: new Map([[URL, entry({ state: "checked_tuple_mismatch" })]]) });
    expect(out[0]).toMatchObject({ score: 0, state: "disputed" });
  });

  it("scores 1 for a scan nobody could read, and for an unattributed row", () => {
    const out = deriveRowVerification({ ...base, transactions: [tx(), tx({ sourceUrl: undefined })], entriesByUrl: new Map([[URL, entry({ state: "no_usable_text" })]]) });
    expect(out.map((v) => v.score)).toEqual([1, 1]);
    expect(out[1].note).toMatch(/Not attributed/);
  });

  it("scores rows one by one from the OCR alignment on an OCR mismatch", () => {
    const rows = [tx({ description: "A" }), tx({ description: "B" }), tx({ description: "C" })];
    const e = entry({
      state: "ocr_tuple_mismatch",
      ocr: {
        engine: "tesseract", version: "5", dpi: 400, psm: 4, laneVersion: "v", pages: 1, textFile: "t", textSha256: "s", textLaneState: "no_usable_text",
        aligned: { compared: 2, agree: 1, differ: 1, unread: 1, differences: [], agreedPrintedRows: [1], disputedPrintedRows: [2], placeholderRows: [] },
      },
    });
    const out = deriveRowVerification({ ...base, transactions: rows, entriesByUrl: new Map([[URL, e]]), parseRecordByUrl: new Map([[URL, rows]]) });
    expect(out.map((v) => [v.score, v.state])).toEqual([[2, "deterministic_agree"], [0, "disputed"], [1, "single_read"]]);
  });

  it("lets a second model outrank an OCR dispute, and the page audit settle it", () => {
    const rows = [tx({ description: "A" }), tx({ description: "B" }), tx({ description: "C" })];
    const e = entry({
      state: "ocr_tuple_mismatch",
      ocr: {
        engine: "tesseract", version: "5", dpi: 400, psm: 4, laneVersion: "v", pages: 1, textFile: "t", textSha256: "s", textLaneState: "no_usable_text",
        aligned: { compared: 3, agree: 0, differ: 3, unread: 0, differences: [], agreedPrintedRows: [], disputedPrintedRows: [1, 2, 3], placeholderRows: [] },
      },
    });
    const out = deriveRowVerification({
      ...base,
      transactions: rows,
      entriesByUrl: new Map([[URL, e]]),
      parseRecordByUrl: new Map([[URL, rows]]),
      model2ByUrl: new Map([[URL, { agreedIndexes: new Set([0, 1]), disputedIndexes: new Set([2]) }]]),
      auditByUrl: new Map([[URL, { confirmed: new Set([0]), disputed: new Set([1]), notFound: new Set() }]]),
    });
    // Row 0: OCR disputed, second model agreed, audit confirmed -> checked;
    // the public note names the two-model route, the gates keep the OCR dispute.
    expect(out[0]).toMatchObject({ score: 3, state: "checked" });
    expect(out[0].note).toBe(NOTE.twoModelsChecked);
    expect(out[0].gates?.ocr).toBe("disagree");
    // Row 1: second model agreed but the audit disputed -> disputed.
    expect(out[1]).toMatchObject({ score: 0, state: "disputed", lane: "audit" });
    // Row 2: OCR and the second model both disputed -> disputed by OCR.
    expect(out[2]).toMatchObject({ score: 0, state: "disputed", lane: "ocr" });
  });

  it("lets a second model vouch for a row whose OCR row number was repaired", () => {
    const rows = [tx({ description: "A" }), tx({ description: "B" }), tx({ description: "C" })];
    const e = entry({
      state: "ocr_tuple_mismatch",
      ocr: { aligned: { agreedPrintedRows: [1], disputedPrintedRows: [], repairedPrintedRows: [2, 3], placeholderRows: [] } } as unknown as CrosscheckEntry["ocr"],
    });
    const out = deriveRowVerification({
      ...base,
      transactions: rows,
      entriesByUrl: new Map([[URL, e]]),
      parseRecordByUrl: new Map([[URL, rows]]),
      model2ByUrl: new Map([[URL, { agreedIndexes: new Set([1]), disputedIndexes: new Set([2]) }]]),
      auditByUrl: new Map([[URL, { confirmed: new Set([0, 1, 2]), disputed: new Set(), notFound: new Set() }]]),
    });
    expect(out.map((v) => [v.score, v.state])).toEqual([[3, "checked"], [3, "checked"], [0, "disputed"]]);
  });

  it("lets a second model outrank a filing-level text mismatch row by row", () => {
    const rows = [tx({ description: "A" }), tx({ description: "B" })];
    const e = entry({ state: "checked_tuple_mismatch" });
    const out = deriveRowVerification({
      ...base,
      transactions: rows,
      entriesByUrl: new Map([[URL, e]]),
      parseRecordByUrl: new Map([[URL, rows]]),
      model2ByUrl: new Map([[URL, { agreedIndexes: new Set([0]), disputedIndexes: new Set() }]]),
      auditByUrl: new Map([[URL, { confirmed: new Set([0, 1]), disputed: new Set(), notFound: new Set() }]]),
    });
    expect(out[0]).toMatchObject({ score: 3, state: "checked" });
    expect(out[1]).toMatchObject({ score: 0, state: "disputed", lane: "text" });
  });

  it("locates a published row in the candidate through wording-only differences", () => {
    const published = [tx({ description: "Apple Inc" }), tx({ description: "FIRST BANCORP P R F", date: "2026-03-04" })];
    const candidate = [tx({ description: "FIRST BANCORP PR F", date: "2026-03-04" }), tx({ description: "Apple Inc (AAPL)" })];
    expect(locateInParseRecord(published, candidate)).toEqual([1, 0]);
  });

  it("lets a second model lift an unread row to 2, and a human decision to 3", () => {
    const rows = [tx({ description: "A" }), tx({ description: "B" })];
    const e = entry({ state: "no_usable_text" });
    const out = deriveRowVerification({
      ...base,
      transactions: rows,
      entriesByUrl: new Map([[URL, e]]),
      parseRecordByUrl: new Map([[URL, rows]]),
      model2ByUrl: new Map([[URL, { agreedIndexes: new Set([0]), disputedIndexes: new Set([1]) }]]),
    });
    expect(out.map((v) => v.score)).toEqual([2, 0]);
    const ids = recordIdsFor(rows);
    const decided = deriveRowVerification({
      ...base,
      transactions: rows,
      entriesByUrl: new Map([[URL, e]]),
      decisionsById: new Map([[ids[1], { recordId: ids[1], slug: "x", decision: "confirmed", evidence: "page 1 row 2", decidedBy: "trevor", decidedAt: "2026-09-06T00:00:00Z" }]]),
    });
    expect(decided[1]).toMatchObject({ score: 3, state: "human_verified" });
  });

  it("a rejected row stays disputed no matter what the lanes say (Codex, Sep 6)", () => {
    const rows = [tx({ description: "A" })];
    const ids = recordIdsFor(rows);
    const out = deriveRowVerification({
      ...base,
      transactions: rows,
      entriesByUrl: new Map([[URL, entry({ state: "checked_tuple_agreement" })]]),
      parseRecordByUrl: new Map([[URL, rows]]),
      auditByUrl: new Map([[URL, { confirmed: new Set([0]), disputed: new Set(), notFound: new Set() }]]),
      decisionsById: new Map([[ids[0], { recordId: ids[0], slug: "x", decision: "rejected", evidence: "page 1 row 1 differs", decidedBy: "trevor", decidedAt: "2026-09-06T00:00:00Z" }]]),
    });
    expect(out[0]).toMatchObject({ score: 0, state: "disputed", lane: "human" });
  });

  it("a human decision on one row never shifts the parse index of the rows after it", () => {
    // Sep 6: after Trevor decided printed rows 39 and 58 of one filing,
    // the rows below them read the audit verdicts one row up, and a row
    // every reader agreed on showed as disputed.
    const rows = [tx({ description: "A" }), tx({ description: "B" }), tx({ description: "C" })];
    const ids = recordIdsFor(rows);
    const out = deriveRowVerification({
      ...base,
      transactions: rows,
      entriesByUrl: new Map([[URL, entry({ state: "checked_tuple_agreement" })]]),
      parseRecordByUrl: new Map([[URL, rows]]),
      auditByUrl: new Map([[URL, { confirmed: new Set([0, 2]), disputed: new Set([1]), notFound: new Set() }]]),
      decisionsById: new Map([[ids[1], { recordId: ids[1], slug: "x", decision: "corrected", evidence: "page 1 row 2", decidedBy: "trevor", decidedAt: "2026-09-06T00:00:00Z" }]]),
    });
    expect(out.map((v) => [v.score, v.state])).toEqual([[3, "checked"], [3, "human_verified"], [3, "checked"]]);
  });
});

describe("compareSecondRead", () => {
  it("pairs by asset and reports a tuple that differs; a trailing symbol never breaks the pairing", () => {
    const p = [tx({ description: "Apple Inc." }), tx({ description: "B" })];
    const s = [tx({ description: "APPLE INC (AAPL)" }), tx({ description: "B", amount: "$15,001-$50,000" })];
    const r = compareSecondRead(p, s);
    expect(r.agreedIndexes).toEqual([0]);
    expect(r.disputedIndexes).toEqual([1]);
    expect(r.differences[0]).toMatch(/^position 2 of the parse record: second model/);
  });

  it("pairs a unique trade tuple across differently worded names, never across different assets", () => {
    const p = [tx({ description: "ISHARES US TREASURY BOND ETF" }), tx({ description: "Apple Inc", amount: "$15,001-$50,000" })];
    const s = [tx({ description: "iShares U.S. Treasury Bond ETF (GOVT)" }), tx({ description: "Microsoft Corp", amount: "$15,001-$50,000" })];
    const r = compareSecondRead(p, s);
    expect(r.agreedIndexes).toEqual([0]);
    expect(r.unreadIndexes).toEqual([1]);
    expect(r.extraRows.map((x) => x.description)).toEqual(["Microsoft Corp"]);
  });

  it("never pairs by position: a skipped row is unread and an invented one is extra", () => {
    const p = [tx({ description: "A" }), tx({ description: "B" }), tx({ description: "C" })];
    const s = [tx({ description: "A" }), tx({ description: "C" }), tx({ description: "D" })];
    const r = compareSecondRead(p, s);
    expect(r.agreedIndexes).toEqual([0, 2]);
    expect(r.unreadIndexes).toEqual([1]);
    expect(r.extraRows.map((x) => x.description)).toEqual(["D"]);
  });
});

describe("compareSecondRead pairing", () => {
  it("pairs row for row when a repeated name appears many times", () => {
    const w = (date: string, amount: Transaction["amount"]) => tx({ description: "WORKDAY INC CL A", date, amount, type: "Purchase" });
    const primary = [w("2026-02-10", "$1,000,001-$5,000,000"), tx({ description: "OTHER CO" }), w("2026-01-23", "$1,001-$15,000"), w("2026-02-19", "$1,001-$15,000")];
    // The second read has the same rows in the same order; every one agrees.
    const r = compareSecondRead(primary, primary.map((p) => ({ ...p })));
    expect(r.agreedIndexes).toEqual([0, 1, 2, 3]);
    expect(r.disputedIndexes).toEqual([]);
    expect(r.extraRows).toEqual([]);
  });

  it("treats a same-position row with a differently spaced name as the same row", () => {
    const primary = [tx({ description: "FIRST BANCORP PR F", date: "2026-03-04" }), tx({ description: "RLICORP", date: "2026-01-12" })];
    const second = [tx({ description: "FIRST BANCORP P R F", date: "2026-03-04" }), tx({ description: "RLI CORP", date: "2026-01-14" })];
    const r = compareSecondRead(primary, second);
    expect(r.agreedIndexes).toEqual([0]);
    expect(r.disputedIndexes).toEqual([1]);
    expect(r.unreadIndexes).toEqual([]);
    expect(r.extraRows).toEqual([]);
  });
});

describe("describePrimaryIndex", () => {
  it("names a page and a record position, never a printed row", () => {
    // Sep 6: an amendment's Exhibit A put four rows in the record ahead
    // of the trades; "row 101" was sent to a person as a printed row.
    const units = [
      { first: 3, last: 3, transactions: [1, 2, 3, 4] },
      { first: 5, last: 5, transactions: [1, 2, 3] },
      { first: 6, last: 8, transactions: [1, 2] },
    ];
    expect(describePrimaryIndex(0, units)).toBe("page 3, position 1 of the parse record");
    expect(describePrimaryIndex(4, units)).toBe("page 5, position 5 of the parse record");
    expect(describePrimaryIndex(8, units)).toBe("pages 6-8, position 9 of the parse record");
    expect(describePrimaryIndex(8)).toBe("position 9 of the parse record");
    expect(describePrimaryIndex(99, units)).toBe("position 100 of the parse record");
  });

  it("is what a difference line carries", () => {
    const a = tx({ description: "A", type: "Sale", date: "2026-01-01", amount: "$1,001-$15,000", lateFilingFlag: false });
    const out = compareSecondRead([a], [{ ...a, date: "2026-01-02" }], (i) => describePrimaryIndex(i, [{ first: 2, last: 2, transactions: [1] }]));
    expect(out.differences[0]).toMatch(/^page 2, position 1 of the parse record: /);
    expect(out.differences[0]).not.toMatch(/^row /);
  });
});

describe("implausible values", () => {
  it("names each value that cannot be right, and nothing else", () => {
    expect(implausibleValues({ description: "MONROEVILLE PA FIN AUTH UPMC REV B/E 5.00 % Duo Feb 15, 2026", date: "2025-07-22", ticker: null })).toEqual(['the name reads "Duo" before a month; the filing prints "Due"']);
    // 2026-02-28 is a Saturday.
    expect(implausibleValues({ description: "SPS COMM INC", date: "2026-02-28", ticker: null })).toEqual(["the trade is dated a Saturday (2026-02-28); markets are closed"]);
    expect(implausibleValues({ description: "iShares Bitcoin Trust (IBIT)", date: "2026-02-28", ticker: "IBIT" })).toEqual([]);
    expect(implausibleValues({ description: "ALLEGHENY CNTY PA 5.00 % Due Aug 1, 2024", date: "2025-03-03", ticker: null })).toEqual(["the bond matures in 2024, before the 2025 trade"]);
    expect(implausibleValues({ description: "ILLINOIS ST 5% DUE ON 05/01/24", date: "2025-03-03", ticker: null })).toEqual(["the bond matures in 2024, before the 2025 trade"]);
    expect(implausibleValues({ description: "ALLEGHENY CNTY PA 5.00 % Due Aug 1, 2025", date: "2025-03-03", ticker: null })).toEqual([]);
    expect(implausibleValues({ description: "NIKE, Inc. (NKE)", date: "2225-04-04", ticker: "NKE" }, "2025-05-09")).toEqual(["the trade is dated 2225-04-04, after the filing was posted on 2025-05-09"]);
    expect(implausibleValues({ description: "Apple Inc. (AAPL)", date: "2026-06-12", ticker: "AAPL" }, "2026-06-20")).toEqual([]);
    expect(implausibleValues({ description: "Apple Inc. (AAPL)", date: null as unknown as string, ticker: "AAPL" })).toEqual([]);
  });

  it("caps an agreed row at 2 with the reason, leaves a decided row and a disputed score alone", () => {
    const rows = [tx({ description: "A", date: "2026-02-28" }), tx({ description: "B", date: "2026-02-28" }), tx({ description: "C" })];
    const ids = recordIdsFor(rows);
    const out = deriveRowVerification({
      slug: "x",
      transactions: rows,
      entriesByUrl: new Map([[URL, entry({ state: "checked_tuple_agreement" })]]),
      parseRecordByUrl: new Map([[URL, rows]]),
      auditByUrl: new Map([[URL, { confirmed: new Set([0, 1, 2]), disputed: new Set(), notFound: new Set() }]]),
      decisionsById: new Map([[ids[1], { recordId: ids[1], slug: "x", decision: "confirmed", evidence: "page 1 row 2", decidedBy: "trevor", decidedAt: "2026-09-06T00:00:00Z" }]]),
    });
    expect(out.map((v) => [v.score, v.state])).toEqual([[2, "implausible"], [3, "human_verified"], [3, "checked"]]);
    expect(out[0].note).toMatch(/^Date falls on a weekend \(Saturday \(2026-02-28\)\); shown as printed in the filing\. A person decides\. Before this check:/);
    const disputed = applyImplausible({ id: "i", slug: "x", sourceUrl: URL, score: 0, state: "disputed", lane: "audit", note: "x" }, ["r"]);
    expect(disputed.score).toBe(0);
    expect(disputed.state).toBe("disputed");
  });
});

describe("gates per row", () => {
  it("records what each gate said, a person's decision, and the first read's confidence", () => {
    const rows = [tx({ description: "A" }), tx({ description: "B" })];
    const record = rows.map((r, i) => ({ ...r, confidence: i === 0 ? 0.91 : 0.55 }));
    const ids = recordIdsFor(rows);
    const out = deriveRowVerification({
      slug: "x",
      transactions: rows,
      entriesByUrl: new Map([[URL, entry({ state: "checked_tuple_agreement" })]]),
      parseRecordByUrl: new Map([[URL, record]]),
      model2OnlyByUrl: new Map([[URL, { agreedIndexes: new Set([0]), disputedIndexes: new Set([1]), unreadIndexes: new Set() }]]),
      auditByUrl: new Map([[URL, { confirmed: new Set([0]), disputed: new Set([1]), notFound: new Set() }]]),
      nameReadsByUrl: new Map([[URL, [new Map([[0, "A"]])]]]),
      decisionsById: new Map([[ids[1], { recordId: ids[1], slug: "x", decision: "confirmed", evidence: "page 1 row 2", decidedBy: "trevor", decidedAt: "2026-09-06T00:00:00Z" }]]),
    });
    expect(out[0].gates).toEqual({ read1Confidence: 0.91, text: "agree", ocr: "none", model2: "agree", session: "none", audit: "confirm", human: null, implausible: [], name: "agree" });
    expect(out[1].gates).toEqual({ read1Confidence: 0.55, text: "agree", ocr: "none", model2: "disagree", session: "none", audit: "dispute", human: "confirmed", implausible: [], name: "agree" });
    expect(out[1].state).toBe("human_verified");
  });
});

describe("annual-lane rows", () => {
  const ANNUAL = "https://example.gov/Some-Official-2026-278ANNU.pdf";
  const lane = (over: Partial<Transaction> = {}): Transaction =>
    tx({ sourceUrl: ANNUAL, sourceKind: "annual-278e", lateFilingFlag: null, sourcePage: 12, sourceRow: 3, ...over });
  const evidence = (over: Partial<AnnualEvidence> = {}): AnnualEvidence => ({
    slug: "x", sourceUrl: ANNUAL, sourcePage: 12, sourceRow: 3,
    evidence: ["model-transcription-agree", "row-trace-pass"],
    programAgree: true, modelPageReadAgree: true, secondCompanyAgree: false, rowTracePass: true, imageChecked: false, nameAgree: true,
    ...over,
  });
  const base = { slug: "x", parseRecordByUrl: new Map(), entriesByUrl: new Map<string, CrosscheckEntry>() };

  it("is a single read with no recorded evidence, and says so in plain words", () => {
    const out = deriveRowVerification({ ...base, transactions: [lane()] });
    expect(out[0]).toMatchObject({ score: 1, state: "single_read", note: NOTE.annualSingleRead });
    expect(out[0].note).not.toMatch(/text layer/i);
  });

  it("is checked when a program, a model page read and the row trace all agree; the evidence tags ride along", () => {
    const rows = [lane()];
    const [id] = recordIdsFor(rows);
    const out = deriveRowVerification({ ...base, transactions: rows, annualEvidenceById: new Map([[id, evidence()]]) });
    expect(out[0]).toMatchObject({ score: 3, state: "checked", lane: "text", note: NOTE.annualChecked, evidence: ["model-transcription-agree", "row-trace-pass"] });
    // The name gate stays "none" on lane rows by decision (Sep 14, 2026):
    // no ticker publishes from name matching on annual rows yet.
    expect(out[0].gates).toMatchObject({ text: "agree", session: "agree", audit: "confirm", model2: "none", name: "none" });
  });

  it("names the second company's model only where it covered the page", () => {
    const rows = [lane()];
    const [id] = recordIdsFor(rows);
    const out = deriveRowVerification({ ...base, transactions: rows, annualEvidenceById: new Map([[id, evidence({ secondCompanyAgree: true, evidence: ["pdfplumber-agree", "sonnet-page-read-agree", "astra-page-read-agree", "row-trace-pass"] })]]) });
    expect(out[0].note).toBe(NOTE.annualChecked + NOTE.annualSecondCompany);
    expect(out[0].gates?.model2).toBe("agree");
  });

  it("stays a single read when any of the three gates is missing", () => {
    const rows = [lane()];
    const [id] = recordIdsFor(rows);
    for (const partial of [{ programAgree: false }, { modelPageReadAgree: false }, { rowTracePass: false }]) {
      const out = deriveRowVerification({ ...base, transactions: rows, annualEvidenceById: new Map([[id, evidence(partial)]]) });
      expect(out[0]).toMatchObject({ score: 1, state: "single_read" });
    }
  });

  it("loses its evidence when the row changes, because the record ID changes", () => {
    const rows = [lane()];
    const [id] = recordIdsFor(rows);
    const changed = [lane({ amount: "$15,001-$50,000" })];
    const out = deriveRowVerification({ ...base, transactions: changed, annualEvidenceById: new Map([[id, evidence()]]) });
    expect(out[0].state).toBe("single_read");
  });

  it("still needs a person when a value cannot be right, and a person's decision outranks the lanes", () => {
    const rows = [lane({ date: "2025-08-17" })]; // a Sunday
    const [id] = recordIdsFor(rows);
    const out = deriveRowVerification({ ...base, transactions: rows, annualEvidenceById: new Map([[id, evidence()]]) });
    expect(out[0]).toMatchObject({ score: 2, state: "implausible" });
    const decided = deriveRowVerification({
      ...base, transactions: rows, annualEvidenceById: new Map([[id, evidence()]]),
      decisionsById: new Map([[id, { recordId: id, slug: "x", decision: "confirmed", evidence: "page 12 row 3", decidedBy: "Trevor Brown", decidedAt: "2026-09-14T17:34:00.000Z" }]]),
    });
    expect(decided[0]).toMatchObject({ score: 3, state: "human_verified", note: "Checked by a person against the PDF on 2026-09-14." });
  });
});
