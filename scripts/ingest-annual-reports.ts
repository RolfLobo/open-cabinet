/**
 * The annual-report lane: add Part 7 rows of posted annual and termination
 * 278e reports that no 278-T OGE had posted discloses.
 *
 *   npx tsx scripts/ingest-annual-reports.ts --inputs <dir> [--only <slug>] [--dry-run]
 *
 * Then, as after any ingest:
 *   pnpm rebuild-index && pnpm asset-resolution && pnpm row-verification
 *   && pnpm generate-exports && pnpm readme-stats && pnpm test:data && pnpm validate
 *
 * Inputs are the read-only products of the Sep 11, 2026 forensic audit,
 * under one directory (default: the ANNUAL_LANE_INPUTS environment
 * variable):
 *   annuals/downloads.json             the 19 reports: slug, kind, posting date, URL
 *   audit/read-a/<stem>.json           the audit's parsed Part 7 rows
 *   audit/match/<stem>.json            per-row match against the site's 278-T rows
 *   audit/lane-pages/<stem>.json       physical page of each row (scripts/locate-part7-rows.py)
 *   audit/reconcile/overlap-pairs.txt  Trump: the 170 annual rows matched to a posted 278-T
 *   audit/reconcile/classified-annual.json  Trump: asset class per row
 *
 * Rules, in the order applied to each parsed row:
 *   1. A row the match lane called MATCHED (or MATCHED_AMT_DIFF, the same
 *      trade with the amount bracket read differently) is already on the
 *      site from a 278-T and is never added. Trump's annual was not
 *      description-matched; there the reconciliation's 170 one-to-one
 *      pairs define the matched rows.
 *   2. Every other row needs a status. Non-Trump rows take the verdict a
 *      person recorded in the adjudication notes (DECISIONS below); a row
 *      with no verdict stops the run. Trump rows are classified by rule:
 *      before Jan. 20, 2025 is pre-service; the reconciliation's fund
 *      class is exempt; everything else is on no posted 278-T. For every
 *      official, a row dated before covered service (tookOfficeDate, else
 *      confirmedDate) is pre-service even when the verdict was "exempt":
 *      the date is the stronger reason no 278-T was due
 *      (lib/source-lane.ts periodicStatusFor).
 *   3. The row is written with the values the audit read, an ISO date,
 *      the site's amount key, a null late flag (the form has no such
 *      column), the report's URL, its printed row number, its physical
 *      page from the page map, and the account heading when the report
 *      lists Part 7 per account.
 *
 * Idempotent per report URL: rows already carrying that sourceUrl are
 * replaced, so a status change re-runs cleanly. mostRecentFilingDate and
 * the lastIngested* fields are not touched: those describe 278-T ingests
 * and drive the "new filing" banners and the digest. A published summary
 * whose facts moved is marked stale, as the 278-T ingest does.
 *
 * Never invents a row. Every added row traces to one line of an audit
 * file by (stem, index).
 */
import { existsSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import { isAmountRange } from "../lib/amounts";
import { resolveTicker } from "../lib/assets";
import { periodicStatusFor } from "../lib/source-lane";
import { buildDeterministic, computeStats } from "../lib/summary-facts";
import { reconcileSummaryAfterIngest } from "../lib/summary-review";
import type { OfficialData, PeriodicStatus, SourceFiling, SourceKind, Transaction, TransactionType } from "../lib/types";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const INPUTS = flag("--inputs") ?? process.env.ANNUAL_LANE_INPUTS;
const ONLY = args.flatMap((a, i) => (a === "--only" ? [args[i + 1]] : []));
const DRY_RUN = args.includes("--dry-run");
if (!INPUTS) {
  console.error("usage: ingest-annual-reports.ts --inputs <dir> (or set ANNUAL_LANE_INPUTS)");
  process.exit(1);
}

interface Download {
  file: string;
  slug: string;
  kind: string;
  docDate: string;
  pdfUrl: string;
  pages: string;
}

interface ReadRow {
  row: number;
  account?: string | null;
  description: string;
  type: string;
  date: string; // M/D/YYYY, zero padding varies by reader
  amount: string; // "$1,001 - $15,000" as printed
  page: number | null;
}

interface MatchResult {
  row: number;
  account?: string | null;
  status: string;
}

interface PageMap {
  pageCount: number | null;
  rows: Array<{ index: number; page: number }>;
}

type Decided = Exclude<PeriodicStatus, "reported">;

/**
 * A person's verdicts, transcribed from the audit's adjudication notes
 * (audit/adjudication-bisignano.md, audit/adjudication-others.md,
 * audit/corroboration.md). Keyed by report stem, then printed row number.
 * A row listed as "matched" here is one the match lane could not pair
 * (a one-day date variance, a swap with no type or amount) that the
 * notes established is already on the site; it is skipped like MATCHED.
 */
const DECISIONS: Record<string, { rows: Record<string, Decided | "matched">; notes?: Record<string, string> }> = {
  "bisignano-frank-j__annual_2026___2026-08-26": {
    rows: {
      // 128: real property; 129-131: KKR private funds the filer marked EIF.
      ...Object.fromEntries([128, 129, 130, 131].map((r) => [r, "exempt" as const])),
      // 132: ECCO real estate development; unclear whether property or an entity interest.
      132: "unresolved",
      // 133-164: individual New Jersey municipal bonds; on no posted 278-T.
      ...Object.fromEntries(Array.from({ length: 32 }, (_, i) => [133 + i, "not-on-posted-278t" as const])),
    },
  },
  "duffy-sean__annual_2026___2026-08-26": {
    // Row 1, the HOOD sale of Jan. 29, 2025: a 278-T signed Feb. 28, 2025
    // discloses it (ProPublica's DocumentCloud 27893123) but OGE never
    // posted that report. See audit/corroboration.md, section 3.
    rows: { 1: "unposted-278t" },
  },
  "faulkender-michael-w__termination__2025-10-01": {
    // Same trade as the site's June 25, 2025 row from his 278-T; the
    // termination report prints June 24. One-day variance, no new row.
    rows: { 1: "matched" },
  },
  "bedford-bryan__annual_2026___2026-08-13": {
    rows: {
      1: "exempt",
      2: "exempt",
      // The two JPMorgan total-return-swap rows are the site's two
      // "Unstated" rows from the Nov. 3, 2025 278-T (decided Sep 6).
      83: "matched",
      84: "matched",
    },
  },
  "miran-stephen__annual_term__2026-08-26": {
    rows: Object.fromEntries(Array.from({ length: 12 }, (_, i) => [i + 1, "exempt" as const])),
    notes: {
      ...Object.fromEntries(
        [1, 2, 3, 4, 5, 6].map((r) => [
          r,
          "Filing endnote: manager-initiated redemption; the manager was winding down the strategy; not initiated by the filer.",
        ])
      ),
      7: "Filing endnote: capital call.",
    },
  },
  "ueland-eric-m__annual_2026___2026-06-25": {
    rows: Object.fromEntries(Array.from({ length: 56 }, (_, i) => [i + 1, "exempt" as const])),
  },
  "sonderling-keith__annual_2026___2026-07-01": {
    rows: Object.fromEntries([34, 35, 36, 37, 38, 39, 40, 41].map((r) => [r, "exempt" as const])),
  },
  "turner-eric-scott__annual_2026___2026-08-06": {
    rows: Object.fromEntries([9, 10, 11, 12, 13, 14, 15].map((r) => [r, "exempt" as const])),
  },
  "dixon-stacey__termination__2025-03-20": {
    rows: Object.fromEntries([45, 46, 47, 48].map((r) => [r, "exempt" as const])),
  },
  "mcmahon-linda__annual_2026___2026-09-09": {
    rows: Object.fromEntries([142, 143, 144, 145, 146, 147].map((r) => [r, "exempt" as const])),
  },
};

const TRUMP_2026 = "trump-donald-j__annual_2026___2026-07-01";

/** The text layer of Trump's scanned annual runs the page footer
 * ("Donald J. Trump 846 of 847") into the last description on a page. */
const PAGE_FOOTER = /\s*Donald J\.? Trump\s+\d+\s+of\s+\d+\s*$/i;
/** The form's endnote marker, printed inside the description cell. The
 * endnote's content goes to the row's note instead. */
const SEE_ENDNOTE = /\s*See Endnote\s*/i;

const TYPES = new Set<TransactionType>(["Sale", "Sale (Partial)", "Sale (Full)", "Purchase", "Exchange"]);

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf-8")) as T;
}

function toIso(printed: string): string {
  const m = printed.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) throw new Error(`unexpected date "${printed}"`);
  return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
}

/** "$1,001 - $15,000" as printed to the site's "$1,001-$15,000" key. */
function toAmount(printed: string): Transaction["amount"] {
  const key = printed.replace(/\s*-\s*/, "-").trim();
  if (!isAmountRange(key)) throw new Error(`amount "${printed}" is not a known range`);
  return key;
}

function toType(printed: string): TransactionType {
  if (!TYPES.has(printed as TransactionType)) throw new Error(`unexpected type "${printed}"`);
  return printed as TransactionType;
}

/** "INVESTMENT ACCOUNT #7" as printed to "Investment Account #7". */
function accountLabel(printed: string | null | undefined): string | undefined {
  if (!printed) return undefined;
  return printed.trim().toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

function sourceKindOfReport(kind: string): SourceKind {
  return /term/i.test(kind) ? "termination-278e" : "annual-278e";
}

/** The 170 annual rows the reconciliation paired with a posted 278-T,
 * keyed "account|row" the way the read file numbers them. */
function trumpMatchedRows(dir: string): Set<string> {
  const text = readFileSync(path.join(dir, "audit", "reconcile", "overlap-pairs.txt"), "utf-8");
  const out = new Set<string>();
  for (const line of text.split("\n")) {
    const m = line.match(/^A\d{3} \| ann row=(\d+) (INVESTMENT ACCOUNT #\d+)/);
    if (m) out.add(`${m[2]}|${m[1]}`);
  }
  if (out.size !== 170) throw new Error(`expected 170 accepted overlap pairs, read ${out.size}`);
  return out;
}

function main() {
  const inputs = INPUTS as string;
  const downloads = readJson<Download[]>(path.join(inputs, "annuals", "downloads.json"));
  const summary: string[] = [];

  for (const dl of downloads) {
    if (ONLY.length && !ONLY.includes(dl.slug)) continue;
    const stem = dl.file.replace(/\.pdf$/i, "");
    const officialPath = path.resolve("data", "officials", `${dl.slug}.json`);
    if (!existsSync(officialPath)) throw new Error(`${stem}: no official file at ${officialPath}`);
    const official = readJson<OfficialData>(officialPath);
    const read = readJson<{ rows: ReadRow[] }>(path.join(inputs, "audit", "read-a", `${stem}.json`));
    const pageMapPath = path.join(inputs, "audit", "lane-pages", `${stem}.json`);
    const pageMap = existsSync(pageMapPath) ? readJson<PageMap>(pageMapPath) : null;
    const pageByIndex = new Map((pageMap?.rows ?? []).map((r) => [r.index, r.page]));
    const sourceKind = sourceKindOfReport(dl.kind);

    // Which parsed rows are already on the site from a 278-T.
    const matched = new Set<string>();
    let amountDiffMatched = 0;
    const isTrump2026 = stem === TRUMP_2026;
    if (isTrump2026) {
      for (const k of trumpMatchedRows(inputs)) matched.add(k);
    } else {
      const matchPath = path.join(inputs, "audit", "match", `${stem}.json`);
      if (existsSync(matchPath)) {
        for (const r of readJson<{ results: MatchResult[] }>(matchPath).results) {
          if (r.status === "MATCHED" || r.status === "MATCHED_AMT_DIFF") {
            matched.add(`${r.account ?? ""}|${r.row}`);
            if (r.status === "MATCHED_AMT_DIFF") amountDiffMatched += 1;
          }
        }
      }
    }
    const decisions = DECISIONS[stem];
    const classes = isTrump2026
      ? readJson<Array<{ row: number; account: string; final_class: string }>>(
          path.join(inputs, "audit", "reconcile", "classified-annual.json")
        )
      : null;
    if (classes && classes.length !== read.rows.length) {
      throw new Error(`${stem}: classified-annual.json has ${classes.length} rows, read file has ${read.rows.length}`);
    }
    // Covered service: inauguration for the President, else confirmation.
    const coveredFrom = official.tookOfficeDate ?? official.confirmedDate ?? null;

    const added: Transaction[] = [];
    const byStatus: Record<string, number> = {};
    let footersStripped = 0;
    let endnoteMarkers = 0;
    let pagesMissing = 0;
    read.rows.forEach((row, index) => {
      const key = `${row.account ?? ""}|${row.row}`;
      if (matched.has(key)) return;
      const decided = decisions?.rows[String(row.row)] ?? null;
      if (decided === "matched") return;
      if (!isTrump2026 && !decided) {
        throw new Error(
          `${stem}: row ${row.row} (${row.description.slice(0, 40)}) is not matched and has no recorded verdict; a person decides before it is published`
        );
      }
      if (classes) {
        const c = classes[index];
        if (c.row !== row.row || c.account !== row.account) throw new Error(`${stem}: classified row ${index} does not align with the read file`);
      }
      const date = toIso(row.date);
      const periodicStatus = periodicStatusFor({
        date,
        coveredFrom,
        assetClass: classes ? (classes[index].final_class as "fund_eif" | "common_stock" | "reit" | "bond_pref") : null,
        decided: decided as Decided | null,
      });

      let description = row.description.replace(/\s+/g, " ").trim();
      if (PAGE_FOOTER.test(description)) {
        description = description.replace(PAGE_FOOTER, "").trim();
        footersStripped += 1;
      }
      if (SEE_ENDNOTE.test(description)) {
        description = description.replace(SEE_ENDNOTE, " ").replace(/\s+/g, " ").trim();
        endnoteMarkers += 1;
      }
      const page = pageByIndex.get(index) ?? null;
      if (page === null) pagesMissing += 1;
      const note = decisions?.notes?.[String(row.row)];

      const tx: Transaction = {
        description,
        ticker: resolveTicker(description, null, { fillFromParenthetical: true }).ticker,
        type: toType(row.type),
        date,
        amount: toAmount(row.amount),
        // The annual's Part 7 has no "notification received over 30 days
        // ago" column. Null, not false: the row is neither late nor on time.
        lateFilingFlag: null,
        sourceKind,
        periodicStatus,
        sourceUrl: dl.pdfUrl,
        sourcePage: page,
        sourceRow: row.row,
        ...(row.account ? { accountLabel: accountLabel(row.account) } : {}),
        ...(note ? { notes: note } : {}),
      };
      added.push(tx);
      byStatus[periodicStatus] = (byStatus[periodicStatus] ?? 0) + 1;
    });

    // Replace any earlier run's rows for this report, then merge and sort
    // the way the 278-T ingest does (date descending, description).
    // Only this lane's own rows are replaced. Molinaro's three rows were
    // parsed from his termination report by the 278-T pipeline before this
    // lane existed; they are matched rows here and stay as they are.
    const kept = official.transactions.filter(
      (tx) => !(tx.sourceUrl === dl.pdfUrl && (tx.sourceKind === "annual-278e" || tx.sourceKind === "termination-278e"))
    );
    const replaced = official.transactions.length - kept.length;
    const byDateDesc = (a: Transaction, b: Transaction) => {
      const d = (b.date || "").localeCompare(a.date || "");
      if (d !== 0) return d;
      return (a.description || "").localeCompare(b.description || "");
    };
    const merged = [...kept, ...added].sort(byDateDesc);

    const pageCount = pageMap?.pageCount ?? (dl.pages ? Number(dl.pages) : undefined);
    const existingFiling = (official.sourceFilings ?? []).find((f) => f.url === dl.pdfUrl);
    // A report the 278-T pipeline already lists (Molinaro's termination
    // report) keeps its entry; this lane only records the page count.
    const filing: SourceFiling = existingFiling
      ? { ...existingFiling, ...(pageCount ? { pageCount } : {}) }
      : {
          date: dl.docDate.slice(0, 10),
          url: dl.pdfUrl,
          label: decodeURIComponent(dl.pdfUrl.split("/").pop() ?? "").replace(/\.pdf$/i, ""),
          kind: sourceKind,
          ...(pageCount ? { pageCount } : {}),
        };
    const sourceFilings = [filing, ...(official.sourceFilings ?? []).filter((f) => f.url !== dl.pdfUrl)].sort((a, b) =>
      b.date.localeCompare(a.date)
    );

    const updated: OfficialData = { ...official, transactions: merged, sourceFilings };
    // The deterministic template is used only when the official has no
    // summary at all; an existing summary is never overwritten, and one
    // whose facts moved is marked stale for a person to refresh.
    const template = buildDeterministic(computeStats(updated as Parameters<typeof computeStats>[0]));
    const reconciled = reconcileSummaryAfterIngest(
      updated as unknown as Parameters<typeof reconcileSummaryAfterIngest>[0],
      template,
      { rowsAdded: added.length }
    ) as unknown as OfficialData;

    const line =
      `${dl.slug}: ${stem}: +${added.length} rows ${JSON.stringify(byStatus)}; ` +
      `${matched.size} matched skipped${amountDiffMatched ? ` (${amountDiffMatched} with an amount difference)` : ""}; ` +
      `${replaced} earlier lane rows replaced; total ${merged.length}` +
      (footersStripped ? `; ${footersStripped} page footer(s) stripped` : "") +
      (endnoteMarkers ? `; ${endnoteMarkers} endnote marker(s) moved to notes` : "") +
      (pagesMissing ? `; ${pagesMissing} row(s) without a located page` : "") +
      (reconciled.summaryStaleSince && !official.summaryStaleSince ? "; summary now STALE" : "");
    summary.push(line);
    console.log(line);
    if (!DRY_RUN) writeFileSync(officialPath, JSON.stringify(reconciled, null, 2) + "\n");
  }

  console.log(`\n${DRY_RUN ? "Dry run, nothing written." : "Written."} ${summary.length} report(s).`);
  console.log("Next: pnpm rebuild-index && pnpm asset-resolution && pnpm row-verification && pnpm generate-exports && pnpm readme-stats && pnpm test:data && pnpm validate");
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
