export type TransactionType =
  | "Sale"
  | "Sale (Partial)"
  | "Sale (Full)"
  | "Purchase"
  | "Exchange"
  /** The filing's type column did not state a type (for example "See
   * Endnote"). Allowed only with typeNote carrying the filing's wording.
   * Counted as neither a sale nor a purchase. */
  | "Unstated";

import type { AmountRange } from "./amounts";
export type { AmountRange } from "./amounts";

export type GovernmentLevel = "Cabinet" | "Sub-Cabinet" | "Senior Staff";

export type DataStatus = "parsed" | "metadata-only";

/**
 * Which OGE form disclosed a row. Absent means "278-T": every row on the
 * site before the annual-report lane (Sep 2026) came from a Periodic
 * Transaction Report. The annual 278e and the termination 278e carry a
 * Part 7 transaction table too, and a trade can appear there without ever
 * having been on a 278-T. See lib/source-lane.ts for the helpers.
 */
export type SourceKind = "278-T" | "annual-278e" | "termination-278e";

/**
 * How a row relates to the STOCK Act's periodic-report requirement.
 * - reported: on a 278-T (the default for every 278-T row)
 * - not-on-posted-278t: in an annual or termination report; no 278-T OGE
 *   had posted discloses it (as of the audit date on the methodology page)
 * - exempt: the asset class needs no 278-T (excepted funds, real property)
 * - pre-service: traded before the official's covered service began
 * - unposted-278t: a 278-T disclosing it exists but OGE never posted it
 *   (Duffy's Feb. 28, 2025 report, held by ProPublica)
 * - unresolved: a person could not decide which of the above applies
 */
export type PeriodicStatus =
  | "reported"
  | "not-on-posted-278t"
  | "exempt"
  | "pre-service"
  | "unposted-278t"
  | "unresolved";

export interface Transaction {
  /** Prior-administration report retained as history, excluded from current totals.
   * Do not set merely because a new report discloses an older trade. */
  historical?: boolean;
  /** Form that disclosed this row. Omitted on 278-T rows (the default). */
  sourceKind?: SourceKind;
  /** Relation to the periodic-report requirement. Omitted means "reported". */
  periodicStatus?: PeriodicStatus;
  /** Physical page of the source PDF the row prints on (1-based, the
   * number a viewer's #page= fragment uses), or null when not derivable. */
  sourcePage?: number | null;
  /** Printed row number in the source form's transaction table, or null
   * when not derivable. Row numbers restart per account on Trump's annual. */
  sourceRow?: number | null;
  /** The account heading the row sat under, as printed ("Investment
   * Account #7"). Trump's annual lists Part 7 per brokerage account. */
  accountLabel?: string;
  description: string;
  ticker: string | null;
  type: TransactionType;
  /** ISO date YYYY-MM-DD, or null when the filing prints no date for the
   * row. A null date is allowed only with dateNote, on a person's
   * decision; the row stays in the table with the note and is left out of
   * date-based charts and ranges. */
  date: string | null; // ISO date string YYYY-MM-DD
  /** The disclosed dollar range, or null when the filing states the value
   * could not be determined ("Value not readily ascertainable"). Unknown
   * rows are excluded from every dollar total and counted separately. */
  amount: AmountRange | null;
  /** The filing's own wording when amount is null. */
  amountNote?: string;
  /** The filing's own wording when type is "Unstated". */
  typeNote?: string;
  /** A person's note when the date is published as printed on the filing
   * although it cannot be right (a filing that prints the year 2225). */
  dateNote?: string;
  /** The 278-T's "notification received over 30 days ago" column. Null
   * on annual and termination rows: that form has no such column, so the
   * row is neither late nor on time. Late shares count only 278-T rows. */
  lateFilingFlag: boolean | null;
  notes?: string;
  /** URL of the filing that actually disclosed this row (stamped at ingest
   * or by backfill-tx-source.ts). When absent the UI falls back to the
   * date heuristic in getSourceFilingForTransaction. */
  sourceUrl?: string;
}

export interface SourceFiling {
  /** OGE posting date, YYYY-MM-DD. For an annual or termination report
   * this is the date OGE put the PDF up, not the date the filer signed. */
  date: string;
  url: string | null;
  label: string;
  /** Omitted on 278-T filings. An annual or termination 278e is listed so
   * its rows can link to the PDF; the digest, the filing monitor and the
   * date heuristic that attributes unstamped rows consider 278-Ts only. */
  kind?: SourceKind;
  /** Physical page count of the PDF, when known. */
  pageCount?: number;
}

export interface OfficialData {
  name: string;
  slug: string;
  title: string;
  agency: string;
  level: GovernmentLevel;
  filingType: string;
  mostRecentFilingDate: string;
  // When Open Cabinet's pipeline last added or updated this official's data.
  // Independent of mostRecentFilingDate, which is the OGE filing/posting date
  // for the latest tracked report and can differ from the date in the PDF
  // filename, so backfills of older filings still surface as "new on the site."
  lastIngestedDate?: string;
  // Number of transactions added in the most recent ingest (0 if no
  // additions this round — surfaces a per-filing delta on the page banner).
  lastIngestedNewCount?: number;
  // The rows the most recent ingest actually added, date-descending. The
  // digest previews these instead of guessing by transaction date — a late
  // filing can disclose an old-dated trade, so "newest rows" is not "new rows"
  // (Duffy's Feb 2025 Rumble sale surfaced in a June 2026 filing).
  lastIngestedTrades?: Transaction[];
  party?: "R" | "D" | "I";
  photoUrl?: string;
  ogeProfileUrl?: string;
  summary?: string;
  /** Who wrote the summary: the deterministic template, or a model whose
   * candidate a person approved (see lib/summary-review.ts). */
  summarySource?: "template" | "model";
  summaryModel?: string;
  /** Hash of the fact block the summary was written from. */
  summaryFactSha256?: string;
  summaryPublishedAt?: string;
  /** Set by the ingest when new rows changed the facts under a published
   * summary. The prose is behind the data until a new candidate is approved. */
  summaryStaleSince?: string;
  confirmedDate?: string;
  /** Start of covered service for an official who was not Senate-confirmed
   * into this post (the President, inaugurated; a career appointee). */
  tookOfficeDate?: string;
  /** "month" when the source gives only a month (an OGE report's "Date of
   * Appointment 08/2021"); the stored day is the first of that month. */
  tookOfficeDatePrecision?: "month";
  ethicsAgreementDate?: string;
  departedDate?: string | null;
  // True for prior-administration holdovers whose disclosure records are
  // retained for reference but excluded from current-roster views and the
  // site's headline totals. Their detail pages remain accessible.
  formerOfficial?: boolean;
  transactions: Transaction[];
  sourceFilings?: SourceFiling[];
}

export interface OfficialIndexEntry {
  name: string;
  slug: string;
  title: string;
  agency: string;
  level: GovernmentLevel;
  party?: "R" | "D" | "I";
  transactionCount: number;
  mostRecentFilingDate: string;
  lastIngestedDate?: string;
  // Number of new transactions added in the most recent ingest, for badge
  // copy like "+3,627 trades just added." Optional; may be 0.
  lastIngestedNewCount?: number;
  departedDate?: string | null;
  formerOfficial?: boolean;
  dataStatus: DataStatus;
}

export interface OfficialsIndex {
  lastUpdated: string;
  officials: OfficialIndexEntry[];
}

/** A transaction the filing dated. Charts, ranges and sorting by date use
 * these; an undated row (date null, with dateNote) stays in tables. */
export type DatedTransaction = Transaction & { date: string };

export function isDated(tx: Transaction): tx is DatedTransaction {
  return typeof tx.date === "string" && tx.date.length > 0;
}

export function datedRows<T extends Transaction>(rows: T[]): Array<T & { date: string }> {
  return rows.filter((t): t is T & { date: string } => typeof t.date === "string" && t.date.length > 0);
}
