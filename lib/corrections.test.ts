import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  applyCorrections,
  correctionId,
  proposeCorrection,
  readCorrections,
  replayMatches,
  ruleCorrection,
  withdrawCorrection,
} from "./corrections";

const file = () => path.join(mkdtempSync(path.join(tmpdir(), "oc-corrections-")), "corrections.json");
const read = { sourceUrl: "https://example.org/filing.pdf", pdfSha256: "abc" };
const rows = () => [
  { description: "PENTAIR PLC F", ticker: null, type: "Sale", date: "2026-07-08", amount: "$1,001-$15,000", lateFilingFlag: false },
  { description: "TRIMBLE INC", ticker: null, type: "Sale", date: "2026-07-08", amount: "$1,001-$15,000", lateFilingFlag: false },
];
const base = { slug: "x", ...read, page: 28, printedRow: 860, field: "lateFilingFlag" as const, original: false, corrected: true, evidence: "page image shows yes", proposedBy: "tester" };

describe("corrections lifecycle", () => {
  it("proposes, rules, and only ruled corrections apply", () => {
    const f = file();
    const c = proposeCorrection({ ...base, position: 0 }, f);
    expect(c.status).toBe("proposed");
    expect(c.id).toBe(correctionId({ ...read, position: 0, field: "lateFilingFlag" }));
    let r = applyCorrections(rows(), read, readCorrections(f).corrections);
    expect(r.applied).toEqual([]);
    expect(r.rows[0].lateFilingFlag).toBe(false);
    ruleCorrection(c.id, "Trevor Brown", "checked page 28", f);
    r = applyCorrections(rows(), read, readCorrections(f).corrections);
    expect(r.applied).toEqual([c.id]);
    expect(r.rows[0].lateFilingFlag).toBe(true);
    expect(r.rows[0].corrections).toEqual([c.id]);
    expect(r.rows[1].lateFilingFlag).toBe(false);
  });

  it("refuses to re-propose over a ruling and allows withdrawal", () => {
    const f = file();
    const c = proposeCorrection({ ...base, position: 0 }, f);
    ruleCorrection(c.id, "Trevor Brown", undefined, f);
    expect(() => proposeCorrection({ ...base, position: 0, corrected: false }, f)).toThrow(/ruled/);
    withdrawCorrection(c.id, "Trevor Brown", "misread", f);
    expect(applyCorrections(rows(), read, readCorrections(f).corrections).applied).toEqual([]);
  });

  it("skips a correction whose original no longer matches or whose read differs", () => {
    const f = file();
    const c = proposeCorrection({ ...base, position: 1, original: true }, f);
    ruleCorrection(c.id, "Trevor Brown", undefined, f);
    const r = applyCorrections(rows(), read, readCorrections(f).corrections);
    expect(r.applied).toEqual([]);
    expect(r.skipped[0].reason).toMatch(/not the recorded original/);
    const other = applyCorrections(rows(), { ...read, pdfSha256: "zzz" }, readCorrections(f).corrections);
    expect(other.applied).toEqual([]);
    expect(other.skipped).toEqual([]);
  });

  it("does not mutate the input rows", () => {
    const f = file();
    const c = proposeCorrection({ ...base, position: 0 }, f);
    ruleCorrection(c.id, "Trevor Brown", undefined, f);
    const input = rows();
    applyCorrections(input, read, readCorrections(f).corrections);
    expect(input[0].lateFilingFlag).toBe(false);
  });
});

describe("replayMatches", () => {
  it("reports exact reproduction and names every difference", () => {
    const f = file();
    const c = proposeCorrection({ ...base, position: 0 }, f);
    const expected = rows();
    expected[0].lateFilingFlag = true;
    const notYet = replayMatches(rows(), read, readCorrections(f).corrections, expected);
    expect(notYet.ok).toBe(false);
    expect(notYet.differences).toEqual(["row 0 lateFilingFlag: replay false vs expected true"]);
    const asIfRuled = replayMatches(rows(), read, readCorrections(f).corrections, expected, { status: "proposed" });
    expect(asIfRuled.ok).toBe(true);
    ruleCorrection(c.id, "Trevor Brown", undefined, f);
    expect(replayMatches(rows(), read, readCorrections(f).corrections, expected).ok).toBe(true);
  });
});
