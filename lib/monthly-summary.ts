/**
 * A server-computed monthly rollup for an official's charts.
 *
 * The monthly bars used to receive every dated row of the official and
 * bucket them in the browser. That was tolerable at 8,940 rows and is not
 * at 30,000: with the annual-report lane, the largest official page
 * would serialise every row into the HTML twice (once for the chart
 * props, once for the table). The chart needs about twelve numbers per month, so the
 * server computes those and the rows stay on the server, where only the
 * paginated table reads them.
 *
 * One bucket per month, per source kind, with counts and the estimated
 * dollar volume per side. Sale-side classification follows
 * lib/monthly-activity.ts (Exchange and Unstated fall to "other").
 */
import { transactionEstimate } from "./amounts";
import { isChartableDate } from "./chart-dates";
import { isSaleType, monthKeyOf } from "./monthly-activity";
import { sourceKindOf } from "./source-lane";
import type { SourceKind, Transaction } from "./types";

export interface MonthlySummaryBucket {
  /** YYYY-MM */
  monthKey: string;
  sourceKind: SourceKind;
  sales: number;
  purchases: number;
  other: number;
  /** 278-T rows the filer certified late; always 0 on an annual bucket. */
  late: number;
  /** Estimated dollar volume (range midpoints) per side. */
  salesEstimate: number;
  purchasesEstimate: number;
}

export type MonthlySummary = MonthlySummaryBucket[];

type Row = Pick<Transaction, "date" | "type" | "amount" | "lateFilingFlag" | "sourceKind">;

/**
 * Buckets the rows by month and source kind. Undated rows and dates a
 * chart may not draw (lib/chart-dates.ts) are skipped, exactly as the
 * client-side bucketing skipped them. Sorted by month, then source kind,
 * so the output is stable for tests and for React keys.
 */
export function summarizeByMonth(rows: Row[], today: Date = new Date()): MonthlySummary {
  const index = new Map<string, MonthlySummaryBucket>();
  for (const tx of rows) {
    if (!isChartableDate(tx.date, today)) continue;
    const monthKey = monthKeyOf(tx.date as string);
    if (!monthKey) continue;
    const sourceKind = sourceKindOf(tx);
    const key = `${monthKey}|${sourceKind}`;
    let bucket = index.get(key);
    if (!bucket) {
      bucket = { monthKey, sourceKind, sales: 0, purchases: 0, other: 0, late: 0, salesEstimate: 0, purchasesEstimate: 0 };
      index.set(key, bucket);
    }
    const estimate = tx.amount === null ? 0 : (transactionEstimate(tx as Transaction) ?? 0);
    if (isSaleType(tx.type)) {
      bucket.sales += 1;
      bucket.salesEstimate += estimate;
    } else if (tx.type === "Purchase") {
      bucket.purchases += 1;
      bucket.purchasesEstimate += estimate;
    } else {
      bucket.other += 1;
    }
    // A late flag is a 278-T column. An annual row's flag is null; a
    // stray true on one would still not count, so the tick under the
    // bars can only ever mean "a 278-T row in this month was late".
    if (sourceKind === "278-T" && tx.lateFilingFlag) bucket.late += 1;
  }
  return [...index.values()].sort(
    (a, b) => a.monthKey.localeCompare(b.monthKey) || a.sourceKind.localeCompare(b.sourceKind)
  );
}

/** Totals across every source kind for one month, the shape the bars draw. */
export interface MonthTotals {
  monthKey: string;
  sales: number;
  purchases: number;
  late: number;
  total: number;
  /** Rows in this month that came from an annual or termination report. */
  annualLane: number;
}

export function monthTotals(summary: MonthlySummary): MonthTotals[] {
  const byMonth = new Map<string, MonthTotals>();
  for (const b of summary) {
    let t = byMonth.get(b.monthKey);
    if (!t) {
      t = { monthKey: b.monthKey, sales: 0, purchases: 0, late: 0, total: 0, annualLane: 0 };
      byMonth.set(b.monthKey, t);
    }
    t.sales += b.sales;
    t.purchases += b.purchases;
    t.late += b.late;
    t.total += b.sales + b.purchases + b.other;
    if (b.sourceKind !== "278-T") t.annualLane += b.sales + b.purchases + b.other;
  }
  return [...byMonth.values()].sort((a, b) => a.monthKey.localeCompare(b.monthKey));
}
