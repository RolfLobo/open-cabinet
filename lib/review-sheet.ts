/**
 * The ingest review sheet: one line per row of a held filing, every
 * reader's value side by side, and what a person still has to rule on.
 *
 * Pure: takes the primary read, the second model's read, the OCR lane's
 * aligned verdicts and the corrections file, returns rows and readiness.
 * Nothing here reads disk or calls a model; app/admin/review/filing loads
 * the inputs and renders. Readers are compared the way the gate compares
 * them (type, date, amount, late flag) after pairing by asset name.
 */
import type { ReadCorrection } from "./corrections";

export interface ReaderRow {
  description: string;
  ticker?: string | null;
  type: string;
  date: string | null;
  amount: string | null;
  lateFilingFlag: boolean | null;
  confidence?: number;
}

export type ComparedField = "type" | "date" | "amount" | "lateFilingFlag";
export const COMPARED_FIELDS: ComparedField[] = ["type", "date", "amount", "lateFilingFlag"];

export interface SheetUnit { first: number; last: number; rows: ReaderRow[] }

export interface SheetRow {
  position: number;
  page: number | null;
  /** Position within the page's rows, 0-based, for the strip renderer. */
  indexOnPage: number;
  rowsOnPage: number;
  printedRow: number | null;
  primary: ReaderRow;
  astra: ReaderRow | null;
  astraPairing: "name" | "position" | "none";
  /** Fields where Astra's paired row differs from the primary. */
  astraDiffers: ComparedField[];
  ocr: "agree" | "disagree" | "unread" | "none";
  ocrValue: string | null;
  status: "all agree" | "ruling" | "ocr differs" | "ocr unread" | "two of two";
  /** Latest correction record at this position, any field. */
  correction: ReadCorrection | null;
  needsRuling: boolean;
}

export interface SheetSummary {
  rows: number;
  allAgree: number;
  needRuling: number;
  ruled: number;
  ocrDiffers: number;
  ocrUnread: number;
  extraRows: ReaderRow[];
}

export interface SheetInput {
  sourceUrl: string;
  pdfSha256: string;
  primaryUnits: SheetUnit[];
  astraUnits: SheetUnit[] | null;
  /** From data/meta/second-read-log.json when present. */
  second: { disputedIndexes: number[]; unreadIndexes: number[]; extraRows: ReaderRow[] } | null;
  /** From the crosscheck log's OCR alignment, printed-row keyed. */
  ocr: { agreedPrintedRows: number[]; disputedPrintedRows: number[]; differences: string[] } | null;
  /** Whether printed rows run 1..N so printedRow = position + 1. */
  printedRowsContinuous: boolean;
  corrections: ReadCorrection[];
}

const STOP = new Set(["inc", "corp", "llc", "ltd", "plc", "class", "the", "and", "com", "new", "co", "shares", "fund"]);
export function normalizedName(s: string): string { return s.toLowerCase().replace(/[^a-z0-9]/g, ""); }
function words(s: string): Set<string> {
  return new Set((s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => w.length >= 3 && !STOP.has(w)));
}
function sharesWord(a: string, b: string): boolean {
  const wa = words(a); for (const w of words(b)) if (wa.has(w)) return true; return false;
}
export function tuple(r: ReaderRow): string {
  return `${r.type}|${r.date ?? ""}|${r.amount ?? "unknown"}|${r.lateFilingFlag ? "late" : "on time"}`;
}
function differing(a: ReaderRow, b: ReaderRow): ComparedField[] {
  return COMPARED_FIELDS.filter((f) => JSON.stringify(a[f] ?? null) !== JSON.stringify(b[f] ?? null));
}

/** Pair each primary row on a page with an Astra row on the same page:
 * exact normalized name first (preferring one whose values also agree),
 * then the same position when the names share an asset word. */
function pairAstra(primary: ReaderRow[], astra: ReaderRow[]): Array<{ row: ReaderRow | null; how: SheetRow["astraPairing"] }> {
  const used = new Set<number>();
  return primary.map((p, i) => {
    const key = normalizedName(p.description);
    const cands = astra.map((a, j) => ({ a, j })).filter(({ a, j }) => !used.has(j) && normalizedName(a.description) === key);
    if (cands.length) {
      const pick = cands.find(({ a }) => tuple(a) === tuple(p)) ?? cands[0];
      used.add(pick.j); return { row: pick.a, how: "name" as const };
    }
    if (i < astra.length && !used.has(i) && sharesWord(p.description, astra[i].description)) {
      used.add(i); return { row: astra[i], how: "position" as const };
    }
    return { row: null, how: "none" as const };
  });
}

export function buildSheet(input: SheetInput): { rows: SheetRow[]; summary: SheetSummary; ready: boolean; pending: number[] } {
  const corrByPos = new Map<number, ReadCorrection>();
  for (const c of input.corrections) {
    if (c.sourceUrl !== input.sourceUrl || c.pdfSha256 !== input.pdfSha256) continue;
    const prev = corrByPos.get(c.position);
    if (!prev || (c.ruledAt ?? c.proposedAt) >= (prev.ruledAt ?? prev.proposedAt)) corrByPos.set(c.position, c);
  }
  const agreed = new Set(input.ocr?.agreedPrintedRows ?? []);
  const disputed = new Set(input.ocr?.disputedPrintedRows ?? []);
  const ocrValues = new Map<number, string>();
  for (const d of input.ocr?.differences ?? []) {
    const m = /^row (\d+): OCR \[(.*?)\] vs/.exec(d);
    if (m) ocrValues.set(Number(m[1]), m[2]);
  }
  const secondDisputed = new Set([...(input.second?.disputedIndexes ?? []), ...(input.second?.unreadIndexes ?? [])]);
  const astraByPage = new Map<number, ReaderRow[]>();
  for (const u of input.astraUnits ?? []) astraByPage.set(u.first, u.rows);

  const rows: SheetRow[] = [];
  let position = 0;
  for (const unit of input.primaryUnits) {
    const astraRows = astraByPage.get(unit.first) ?? null;
    const pairs = astraRows ? pairAstra(unit.rows, astraRows) : null;
    unit.rows.forEach((primary, i) => {
      const printedRow = input.printedRowsContinuous ? position + 1 : null;
      const pair = pairs?.[i] ?? { row: null, how: "none" as const };
      const astraDiffers = pair.row ? differing(primary, pair.row) : [];
      const ocr: SheetRow["ocr"] = !input.ocr ? "none" : printedRow === null ? "none" : agreed.has(printedRow) ? "agree" : disputed.has(printedRow) ? "disagree" : "unread";
      const modelsDisagree = secondDisputed.has(position) || (input.second === null && (pair.row === null || astraDiffers.length > 0));
      const status: SheetRow["status"] = modelsDisagree ? "ruling"
        : ocr === "agree" ? "all agree" : ocr === "disagree" ? "ocr differs" : ocr === "unread" ? "ocr unread" : "two of two";
      const correction = corrByPos.get(position) ?? null;
      const settled = correction !== null && (correction.status === "ruled" || correction.status === "confirmed");
      rows.push({
        position, page: unit.first === unit.last ? unit.first : null, indexOnPage: i, rowsOnPage: unit.rows.length, printedRow,
        primary, astra: pair.row, astraPairing: pair.how, astraDiffers, ocr, ocrValue: printedRow !== null ? ocrValues.get(printedRow) ?? null : null,
        status, correction, needsRuling: status === "ruling" && !settled,
      });
      position++;
    });
  }
  const pending = rows.filter((r) => r.needsRuling).map((r) => r.position);
  const summary: SheetSummary = {
    rows: rows.length,
    allAgree: rows.filter((r) => r.status === "all agree").length,
    needRuling: rows.filter((r) => r.status === "ruling").length,
    ruled: rows.filter((r) => r.status === "ruling" && !r.needsRuling).length,
    ocrDiffers: rows.filter((r) => r.status === "ocr differs").length,
    ocrUnread: rows.filter((r) => r.status === "ocr unread").length,
    extraRows: input.second?.extraRows ?? [],
  };
  return { rows, summary, ready: pending.length === 0 && rows.length > 0, pending };
}
