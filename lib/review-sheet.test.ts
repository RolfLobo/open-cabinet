import { describe, expect, it } from "vitest";
import { buildSheet, type ReaderRow } from "./review-sheet";
import type { ReadCorrection } from "./corrections";

const row = (description: string, late = false, over: Partial<ReaderRow> = {}): ReaderRow =>
  ({ description, ticker: null, type: "Sale", date: "2026-07-08", amount: "$1,001-$15,000", lateFilingFlag: late, confidence: 0.85, ...over });
const read = { sourceUrl: "https://example.org/f.pdf", pdfSha256: "abc" };
const corr = (position: number, status: ReadCorrection["status"]): ReadCorrection => ({
  id: `c${position}`, slug: "x", ...read, position, page: 1, printedRow: position + 1, field: "lateFilingFlag", original: false, corrected: true,
  evidence: "page", proposedBy: "t", proposedAt: "2026-09-23T00:00:00Z", status, ...(status === "ruled" || status === "confirmed" ? { ruledBy: "Trevor", ruledAt: "2026-09-23T01:00:00Z" } : {}),
});

describe("buildSheet", () => {
  const primary = [{ first: 1, last: 1, rows: [row("PENTAIR PLC F"), row("TRIMBLE INC"), row("VERSIGENT LTD")] }];
  const astra = [{ first: 1, last: 1, rows: [row("PENTAIR PLC F", true), row("TRIMBLE INC"), row("VERISIGN LTD")] }];
  const base = { ...read, primaryUnits: primary, astraUnits: astra, printedRowsContinuous: true,
    second: { disputedIndexes: [0], unreadIndexes: [2], extraRows: [row("VERISIGN LTD")] },
    ocr: { agreedPrintedRows: [2], disputedPrintedRows: [1], differences: ["row 1: OCR [Sale|2026-07-08|$1,001-$15,000|late] vs AI parse [Sale|2026-07-08|$1,001-$15,000|ontime]"] } };

  it("marks disputes, pairs Astra by name, and reports readiness", () => {
    const { rows, summary, ready, pending } = buildSheet({ ...base, corrections: [] });
    expect(rows.map((r) => r.status)).toEqual(["ruling", "all agree", "ruling"]);
    expect(rows[0].astraDiffers).toEqual(["lateFilingFlag"]);
    expect(rows[0].ocr).toBe("disagree");
    expect(rows[0].ocrValue).toBe("Sale|2026-07-08|$1,001-$15,000|late");
    expect(rows[2].astra).toBeNull();
    expect(rows[2].astraPairing).toBe("none");
    expect(rows[1].printedRow).toBe(2);
    expect(summary.needRuling).toBe(2);
    expect(summary.extraRows).toHaveLength(1);
    expect(ready).toBe(false);
    expect(pending).toEqual([0, 2]);
  });

  it("a proposed correction does not settle a row; ruled or confirmed does", () => {
    let out = buildSheet({ ...base, corrections: [corr(0, "proposed")] });
    expect(out.rows[0].needsRuling).toBe(true);
    out = buildSheet({ ...base, corrections: [corr(0, "ruled"), corr(2, "confirmed")] });
    expect(out.rows[0].needsRuling).toBe(false);
    expect(out.rows[2].needsRuling).toBe(false);
    expect(out.ready).toBe(true);
    expect(out.summary.ruled).toBe(2);
  });

  it("without a second read, disagreement comes from pairing alone", () => {
    const out = buildSheet({ ...base, second: null, corrections: [] });
    expect(out.rows.map((r) => r.status)).toEqual(["ruling", "all agree", "ruling"]);
  });

  it("ignores corrections for another read", () => {
    const out = buildSheet({ ...base, corrections: [{ ...corr(0, "ruled"), pdfSha256: "zzz" }] });
    expect(out.rows[0].needsRuling).toBe(true);
  });
});
