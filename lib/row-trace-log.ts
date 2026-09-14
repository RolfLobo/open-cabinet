/**
 * The row-trace validator's run log (data/meta/row-trace-log.json): what
 * scripts/validate-row-trace.ts checked, what failed, and whether the
 * negative controls proved the checks can fail. Read by the admin panel;
 * written by the script. Capped to the last 50 runs.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export const ROW_TRACE_LOG_PATH = path.join(process.cwd(), "data", "meta", "row-trace-log.json");
export const ROW_TRACE_LOG_CAP = 50;

export interface RowTraceFailure {
  official: string;
  sourceKind: string;
  page: number | null;
  row: number | null;
  date: string | null;
  amount: string | null;
  description: string;
  reason: string;
}

export interface RowTraceOfficialCounts {
  /** Rows with a page, checked against that page. */
  paged: number;
  passed: number;
  failed: number;
  /** Rows without a page, searched for in the whole document. */
  unpaged: number;
  located: number;
  unlocated: number;
  /** Rows skipped because the PDF could not be read or fetched. */
  skipped: number;
}

export interface RowTraceControls {
  sample: number;
  dateShift: { caught: number; uncaught: number; notEvaluable: number };
  rowShift: { caught: number; uncaught: number; notEvaluable: number };
  descSwap: { caught: number; uncaught: number; notEvaluable: number };
}

export interface RowTraceRun {
  ranAt: string;
  gitSha: string | null;
  options: {
    all: boolean;
    officials: string[];
    sampleTrump: number | null;
    fullTrump: boolean;
    seed: number;
    controls: number;
  };
  /** "PASS": every row traced and every control caught. "FAIL": a row did
   * not trace. "LOOSE": every row traced but a control went uncaught, so
   * the checks cannot be trusted to fail. */
  result: "PASS" | "FAIL" | "LOOSE";
  totals: RowTraceOfficialCounts & { officials: number; pdfsFetched: number };
  perOfficial: Record<string, RowTraceOfficialCounts>;
  failures: RowTraceFailure[];
  controls: RowTraceControls;
  /** PDFs that could not be read or fetched, with the reason. */
  problems: string[];
  durationSeconds: number;
}

export interface RowTraceLog {
  version: 1;
  runs: RowTraceRun[];
}

export function readRowTraceLog(file = ROW_TRACE_LOG_PATH): RowTraceLog | null {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf-8")) as RowTraceLog;
  } catch {
    return null;
  }
}

/** Newest first, capped; atomic replacement so a crash never leaves half a log. */
export function appendRowTraceRun(run: RowTraceRun, file = ROW_TRACE_LOG_PATH): RowTraceLog {
  const log = readRowTraceLog(file) ?? { version: 1 as const, runs: [] };
  const next: RowTraceLog = { version: 1, runs: [run, ...log.runs].slice(0, ROW_TRACE_LOG_CAP) };
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n");
  renameSync(tmp, file);
  return next;
}

/** The commands a person runs; shown on the admin panel and in docs. */
export const ROW_TRACE_COMMANDS = {
  full: "pnpm validate:trace -- --all",
  fullTrump: "pnpm validate:trace -- --all --full-trump",
  official: "pnpm validate:trace -- --official bisignano-frank-j",
};
