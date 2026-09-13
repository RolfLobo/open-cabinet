import { describe, expect, it } from "vitest";
import {
  annualLaneRows,
  isPeriodicRow,
  lateStats,
  periodicFilings,
  periodicRows,
  periodicStatusFor,
  sourceKindOf,
} from "./source-lane";
import type { Transaction } from "./types";

const row = (over: Partial<Transaction>): Transaction => ({
  description: "Example",
  ticker: null,
  type: "Purchase",
  date: "2025-06-01",
  amount: "$1,001-$15,000",
  lateFilingFlag: false,
  ...over,
});

describe("source kind", () => {
  it("treats a row written before the lane as a 278-T row", () => {
    expect(sourceKindOf(row({}))).toBe("278-T");
    expect(isPeriodicRow(row({}))).toBe(true);
  });

  it("recognises annual and termination rows", () => {
    expect(isPeriodicRow(row({ sourceKind: "annual-278e" }))).toBe(false);
    expect(isPeriodicRow(row({ sourceKind: "termination-278e" }))).toBe(false);
    expect(annualLaneRows([row({}), row({ sourceKind: "annual-278e" })])).toHaveLength(1);
    expect(periodicRows([row({}), row({ sourceKind: "annual-278e" })])).toHaveLength(1);
  });

  it("keeps only 278-T filings for the digest and the monitor", () => {
    const filings = [
      { date: "2026-08-08", url: "a", label: "278-T" },
      { date: "2026-08-26", url: "b", label: "annual", kind: "annual-278e" as const },
      { date: "2026-08-26", url: "c", label: "term", kind: "termination-278e" as const },
    ];
    expect(periodicFilings(filings).map((f) => f.url)).toEqual(["a"]);
  });
});

describe("late share scoping", () => {
  it("counts late rows and the denominator over 278-T rows only", () => {
    const rows = [
      row({ lateFilingFlag: true }),
      row({ lateFilingFlag: false }),
      // Annual rows carry a null flag and must move neither number.
      row({ sourceKind: "annual-278e", lateFilingFlag: null }),
      row({ sourceKind: "annual-278e", lateFilingFlag: null }),
      row({ sourceKind: "termination-278e", lateFilingFlag: null }),
    ];
    expect(lateStats(rows)).toEqual({ periodic: 2, late: 1, annualLane: 3, latePct: 50 });
  });

  it("would not count a stray true flag on an annual row", () => {
    // Defensive: the ingest writes null, but the share must not depend on it.
    const rows = [row({ lateFilingFlag: true }), row({ sourceKind: "annual-278e", lateFilingFlag: true })];
    expect(lateStats(rows)).toEqual({ periodic: 1, late: 1, annualLane: 1, latePct: 100 });
  });

  it("reports zero, not NaN, with no 278-T rows", () => {
    expect(lateStats([row({ sourceKind: "annual-278e", lateFilingFlag: null })]).latePct).toBe(0);
    expect(lateStats([]).latePct).toBe(0);
  });

  it("rounds the way the homepage always has", () => {
    const rows = [row({ lateFilingFlag: true }), row({}), row({})];
    expect(lateStats(rows).latePct).toBe(33);
  });
});

describe("periodic status rules", () => {
  it("lets a person's verdict win over every rule", () => {
    expect(periodicStatusFor({ date: "2025-01-29", coveredFrom: "2025-01-28", decided: "unposted-278t" })).toBe("unposted-278t");
    expect(periodicStatusFor({ date: "2025-10-10", coveredFrom: "2025-05-06", decided: "unresolved" })).toBe("unresolved");
    // "unresolved" and "unposted-278t" are never overridden by the date rule.
    expect(periodicStatusFor({ date: "2024-12-01", coveredFrom: "2025-01-20", decided: "unresolved" })).toBe("unresolved");
  });

  it("lets the date rule win over an exempt verdict, never the reverse", () => {
    // Ueland's fund trades of Feb.-March 2025 predate his May 14, 2025 confirmation.
    expect(periodicStatusFor({ date: "2025-02-26", coveredFrom: "2025-05-14", decided: "exempt" })).toBe("pre-service");
    expect(periodicStatusFor({ date: "2025-12-15", coveredFrom: "2025-05-14", decided: "exempt" })).toBe("exempt");
    // A former official with no covered-service date keeps the verdict.
    expect(periodicStatusFor({ date: "2024-05-23", coveredFrom: null, decided: "exempt" })).toBe("exempt");
  });

  it("labels a trade before covered service pre-service, fund or not", () => {
    expect(periodicStatusFor({ date: "2025-01-15", coveredFrom: "2025-01-20", assetClass: "fund_eif" })).toBe("pre-service");
    expect(periodicStatusFor({ date: "2025-01-15", coveredFrom: "2025-01-20", assetClass: "common_stock" })).toBe("pre-service");
    expect(periodicStatusFor({ date: "2025-01-20", coveredFrom: "2025-01-20", assetClass: "common_stock" })).toBe("not-on-posted-278t");
  });

  it("labels an excepted fund exempt and everything else as on no posted 278-T", () => {
    expect(periodicStatusFor({ date: "2025-09-18", coveredFrom: "2025-01-20", assetClass: "fund_eif" })).toBe("exempt");
    expect(periodicStatusFor({ date: "2025-09-18", coveredFrom: "2025-01-20", assetClass: "reit" })).toBe("not-on-posted-278t");
    expect(periodicStatusFor({ date: "2025-09-18", coveredFrom: "2025-01-20", assetClass: "bond_pref" })).toBe("not-on-posted-278t");
    expect(periodicStatusFor({ date: "2025-09-18", coveredFrom: null })).toBe("not-on-posted-278t");
  });
});
