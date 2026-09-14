/**
 * The annual-report lane: which form a row came from, and what that means
 * for the late-filing arithmetic.
 *
 * Until September 2026 every row on the site came from a 278-T, so "late"
 * could be counted over every row. Part 7 of an annual or termination 278e
 * lists trades too, and it has no "notification received over 30 days ago"
 * column: a row that exists only there can be neither late nor on time.
 * Every late count and late share on the site therefore takes both its
 * numerator and its denominator from 278-T rows, through `lateStats`.
 * A page that filters `tx.lateFilingFlag` on its own would silently mix
 * the two forms, which is the bug this module exists to prevent.
 *
 * Pure functions, no I/O, so the rules are unit-testable
 * (lib/source-lane.test.ts).
 */
import type { PeriodicStatus, SourceKind, Transaction } from "./types";

type SourceKindRow = Pick<Transaction, "sourceKind">;
type LateRow = Pick<Transaction, "sourceKind" | "lateFilingFlag">;

/** The form a row came from. Rows written before the lane carry no field. */
export function sourceKindOf(tx: SourceKindRow): SourceKind {
  return tx.sourceKind ?? "278-T";
}

/** A row disclosed on a Periodic Transaction Report. */
export function isPeriodicRow(tx: SourceKindRow): boolean {
  return sourceKindOf(tx) === "278-T";
}

/** A row read from Part 7 of an annual or termination 278e. */
export function isAnnualLaneRow(tx: SourceKindRow): boolean {
  return !isPeriodicRow(tx);
}

/** Short form names for tables, chips and the Source column. */
export const SOURCE_KIND_SHORT: Record<SourceKind, string> = {
  "278-T": "278-T",
  "annual-278e": "Annual",
  "termination-278e": "Termination",
};

/** Full form names for document lists and prose. */
export const SOURCE_KIND_TITLE: Record<SourceKind, string> = {
  "278-T": "278-T Periodic Transaction Report",
  "annual-278e": "Annual Financial Disclosure (OGE Form 278e)",
  "termination-278e": "Termination Financial Disclosure (OGE Form 278e)",
};

/**
 * Reader-facing sub-label under the description of an annual-lane row.
 * Labels state document facts only, never what was required (Trevor's
 * policy, Sep 14, 2026): the data keeps the finer periodicStatus for
 * filtering and analysis, and three of its values collapse to one label.
 * The methodology page explains, once, which trades OGE's rules leave
 * off the 278-T and that the site does not decide which rows those are.
 */
export const PERIODIC_STATUS_LABEL: Record<PeriodicStatus, string> = {
  reported: "Also on a 278-T",
  "not-on-posted-278t": "Not found on any posted 278-T",
  exempt: "Not found on any posted 278-T",
  unresolved: "Not found on any posted 278-T",
  "pre-service": "Dated before taking office",
  "unposted-278t": "On a 278-T OGE did not post",
};

/** Longer wording for a title attribute: the same fact, spelled out. */
export const PERIODIC_STATUS_EXPLANATION: Record<PeriodicStatus, string> = {
  reported: "This trade also appears on a 278-T periodic transaction report",
  "not-on-posted-278t": "Listed in this report's Part 7 transaction table; no 278-T that OGE had posted lists it",
  exempt: "Listed in this report's Part 7 transaction table; no 278-T that OGE had posted lists it",
  unresolved: "Listed in this report's Part 7 transaction table; no 278-T that OGE had posted lists it",
  "pre-service": "The trade date is before the official took office",
  "unposted-278t": "A 278-T listing this trade exists but OGE did not post it to its public index",
};

export function periodicStatusOf(tx: Pick<Transaction, "periodicStatus">): PeriodicStatus {
  return tx.periodicStatus ?? "reported";
}

export interface LateStats {
  /** 278-T rows, the only population a late flag can describe. */
  periodic: number;
  /** 278-T rows the filer certified as late. */
  late: number;
  /** Rows from annual and termination reports, excluded from the share. */
  annualLane: number;
  /** late / periodic, rounded to a whole percent; 0 when there are no 278-T rows. */
  latePct: number;
}

/**
 * Late counts over 278-T rows only, numerator and denominator alike.
 *
 * The share is rounded the way the homepage has always rounded it
 * (Math.round to a whole percent) so the two agree to the digit.
 */
export function lateStats(rows: LateRow[]): LateStats {
  let periodic = 0;
  let late = 0;
  let annualLane = 0;
  for (const tx of rows) {
    if (isPeriodicRow(tx)) {
      periodic += 1;
      if (tx.lateFilingFlag) late += 1;
    } else {
      annualLane += 1;
    }
  }
  return {
    periodic,
    late,
    annualLane,
    latePct: periodic > 0 ? Math.round((100 * late) / periodic) : 0,
  };
}

/** The 278-T rows of a list, for any late-filing arithmetic. */
export function periodicRows<T extends SourceKindRow>(rows: T[]): T[] {
  return rows.filter(isPeriodicRow);
}

/** The annual-lane rows of a list. */
export function annualLaneRows<T extends SourceKindRow>(rows: T[]): T[] {
  return rows.filter(isAnnualLaneRow);
}

/** The 278-T source filings of an official: what the digest, the filing
 * monitor and the date heuristic may consider. */
export function periodicFilings<T extends { kind?: SourceKind | string }>(filings: T[]): T[] {
  return filings.filter((f) => (f.kind ?? "278-T") === "278-T");
}

/**
 * The status an annual-lane row gets under the lane's rules, given what
 * the audit established about it. The order matters and is the order the
 * reconciliation subtracted rows in (scratchpad audit, Sep 11, 2026):
 *
 *   1. a person's verdict on the row wins (Bisignano's row 132
 *      "unresolved", Duffy's row 1 "on an unposted 278-T"), except that
 *      a verdict of "exempt" yields to the date rule below: a fund trade
 *      made before covered service is labeled for the stronger reason
 *      (Ueland's 54 rows of Feb.-March 2025, confirmed May 14, 2025);
 *   2. a trade dated before covered service needed no 278-T, whatever
 *      the asset class (Trump's 83 rows before Jan. 20, 2025);
 *   3. an excepted-fund row is exempt;
 *   4. everything else is on no posted 278-T.
 *
 * "Matched" rows (already on the site from a 278-T) never reach this
 * function: the ingest refuses them before it builds a row.
 */
export function periodicStatusFor(input: {
  /** ISO trade date. */
  date: string;
  /** ISO date covered service began, or null when unknown. */
  coveredFrom: string | null;
  /** The reconciliation's asset class, when it classified the row. */
  assetClass?: "fund_eif" | "common_stock" | "reit" | "bond_pref" | null;
  /** A person's verdict for this row, when one was recorded. */
  decided?: Exclude<PeriodicStatus, "reported"> | null;
}): Exclude<PeriodicStatus, "reported"> {
  const preService = Boolean(input.coveredFrom && input.date < input.coveredFrom);
  if (input.decided && !(input.decided === "exempt" && preService)) return input.decided;
  if (preService) return "pre-service";
  if (input.assetClass === "fund_eif") return "exempt";
  return "not-on-posted-278t";
}
