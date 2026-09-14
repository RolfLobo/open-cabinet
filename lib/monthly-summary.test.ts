import { describe, expect, it } from "vitest";
import { monthTotals, summarizeByMonth } from "./monthly-summary";
import type { Transaction } from "./types";

const row = (over: Partial<Transaction>): Transaction => ({
  description: "Example",
  ticker: null,
  type: "Purchase",
  date: "2025-06-10",
  amount: "$1,001-$15,000",
  lateFilingFlag: false,
  ...over,
});

const today = new Date("2026-09-12T12:00:00");

describe("monthly summary", () => {
  it("buckets by month and source kind with counts, late flags and estimates", () => {
    const rows = [
      row({ type: "Sale", lateFilingFlag: true, amount: "$15,001-$50,000" }),
      row({ type: "Purchase" }),
      row({ type: "Exchange" }),
      row({ sourceKind: "annual-278e", lateFilingFlag: null, type: "Sale" }),
      row({ sourceKind: "annual-278e", lateFilingFlag: null, date: "2025-07-01" }),
    ];
    const summary = summarizeByMonth(rows, today);
    expect(summary).toEqual([
      { monthKey: "2025-06", sourceKind: "278-T", sales: 1, purchases: 1, other: 1, late: 1, salesEstimate: 32500, purchasesEstimate: 8000 },
      { monthKey: "2025-06", sourceKind: "annual-278e", sales: 1, purchases: 0, other: 0, late: 0, salesEstimate: 8000, purchasesEstimate: 0 },
      { monthKey: "2025-07", sourceKind: "annual-278e", sales: 0, purchases: 1, other: 0, late: 0, salesEstimate: 0, purchasesEstimate: 8000 },
    ]);
  });

  it("never attributes a late flag to an annual bucket", () => {
    const summary = summarizeByMonth([row({ sourceKind: "annual-278e", lateFilingFlag: true })], today);
    expect(summary[0].late).toBe(0);
  });

  it("skips undated rows and dates a chart may not draw", () => {
    const rows = [row({ date: null, dateNote: "no date printed" }), row({ date: "2225-04-04", dateNote: "as printed" }), row({})];
    expect(summarizeByMonth(rows, today)).toHaveLength(1);
  });

  it("counts unascertainable amounts without adding to the estimate", () => {
    const summary = summarizeByMonth([row({ amount: null, amountNote: "not readily ascertainable" })], today);
    expect(summary[0].purchases).toBe(1);
    expect(summary[0].purchasesEstimate).toBe(0);
  });

  it("totals across source kinds per month for the bars", () => {
    const rows = [
      row({ type: "Sale", lateFilingFlag: true }),
      row({ sourceKind: "annual-278e", lateFilingFlag: null, type: "Sale" }),
      row({ sourceKind: "termination-278e", lateFilingFlag: null }),
    ];
    expect(monthTotals(summarizeByMonth(rows, today))).toEqual([
      { monthKey: "2025-06", sales: 2, purchases: 1, late: 1, total: 3, annualLane: 2 },
    ]);
  });
});
