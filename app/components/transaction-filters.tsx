"use client";

/**
 * TransactionFilters, pill row above an official's chart/table for
 * narrowing the visible set without leaving the page. Each pill writes
 * to a URL param (?type=, ?month=, ?source=) so a journalist can link
 * directly to a filtered view like
 * /officials/trump-donald-j?range=12mo&type=sale&month=2026-03&source=annual.
 *
 * The parent server component reads the same params and filters its
 * transactions accordingly, see the official detail page.
 */
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";

export type TxTypeFilter = "all" | "sale" | "purchase" | "late";

/**
 * Which form the rows came from. Shown only for officials with rows from
 * an annual or termination report (the annual-report lane, Sep 2026), so
 * the control is not an unexplained extra on the other 25 pages.
 */
export type TxSourceFilter = "all" | "278t" | "annual";

const FILTER_PILLS: { label: string; value: TxTypeFilter }[] = [
  { label: "All", value: "all" },
  { label: "Sales", value: "sale" },
  { label: "Purchases", value: "purchase" },
  { label: "Late-filed", value: "late" },
];

const SOURCE_PILLS: { label: string; value: TxSourceFilter; title: string }[] = [
  { label: "All", value: "all", title: "Every row, whichever form disclosed it" },
  { label: "278-T", value: "278t", title: "Rows from Periodic Transaction Reports" },
  { label: "Annual", value: "annual", title: "Rows read from Part 7 of an annual or termination report" },
];

interface Props {
  type: TxTypeFilter;
  monthKey: string | null; // "YYYY-MM" or null for full range
  monthLabel: string | null; // pretty form, e.g. "March 2026"
  totalCount: number;
  filteredCount: number;
  /** Current source filter; the pills render only when set. */
  source?: TxSourceFilter;
  /** Render the source pills. Off for officials with 278-T rows only. */
  showSource?: boolean;
}

export default function TransactionFilters(props: Props) {
  return (
    <Suspense fallback={null}>
      <TransactionFiltersContent {...props} />
    </Suspense>
  );
}

function TransactionFiltersContent({
  type,
  monthKey,
  monthLabel,
  totalCount,
  filteredCount,
  source = "all",
  showSource = false,
}: Props) {
  const router = useRouter();
  const search = useSearchParams();

  function setParam(key: string, value: string | null) {
    const params = new URLSearchParams(search.toString());
    if (value === null || value === "" || value === "all") params.delete(key);
    else params.set(key, value);
    // A new filter starts the table at page 1; a stale ?page= past the
    // end of a narrower set showed an empty table.
    params.delete("page");
    const qs = params.toString();
    router.replace(qs ? `?${qs}` : "?", { scroll: false });
  }

  function clearMonth() {
    setParam("month", null);
  }

  return (
    <div className="flex flex-wrap items-center gap-2 mb-3">
      <span className="text-[10px] uppercase tracking-wider text-neutral-500 mr-1">
        Filter
      </span>
      <div className="inline-flex border border-neutral-200 text-xs">
        {FILTER_PILLS.map((p) => {
          const active = type === p.value;
          return (
            <button
              key={p.value}
              type="button"
              onClick={() => setParam("type", p.value)}
              className={`px-2.5 py-1 transition-colors ${
                active
                  ? "bg-neutral-900 text-white"
                  : "bg-white text-neutral-600 hover:text-neutral-900"
              }`}
            >
              {p.label}
            </button>
          );
        })}
      </div>

      {showSource && (
        // One flex item, so a narrow screen wraps the label with its
        // chips instead of leaving "Source" alone on a line.
        <div className="inline-flex items-center gap-2 md:ml-2">
          <span className="text-[10px] uppercase tracking-wider text-neutral-500">
            Source
          </span>
          <div className="inline-flex border border-neutral-200 text-xs">
            {SOURCE_PILLS.map((p) => {
              const active = source === p.value;
              return (
                <button
                  key={p.value}
                  type="button"
                  title={p.title}
                  onClick={() => setParam("source", p.value)}
                  className={`px-2.5 py-1 transition-colors ${
                    active
                      ? "bg-neutral-900 text-white"
                      : "bg-white text-neutral-600 hover:text-neutral-900"
                  }`}
                >
                  {p.label}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {monthKey && monthLabel && (
        <button
          type="button"
          onClick={clearMonth}
          className="inline-flex items-center gap-1.5 border border-neutral-900 bg-neutral-900 text-white text-xs px-2 py-1 hover:bg-neutral-800 transition-colors"
          title="Clear month filter"
        >
          <span>{monthLabel}</span>
          <span aria-hidden="true">×</span>
        </button>
      )}

      <span className="text-xs text-neutral-400 ml-auto">
        {filteredCount.toLocaleString()}
        {filteredCount !== totalCount &&
          ` of ${totalCount.toLocaleString()}`}{" "}
        trade{filteredCount === 1 ? "" : "s"}
      </span>
    </div>
  );
}
