/**
 * Read corrections: a person's change to one value of one row of one
 * model read, kept beside the read instead of written into it.
 *
 * Why: on Sept. 23, 2026 the primary model read 34 late flags wrong on a
 * Trump 278-T. The fix was applied by editing two parse-cache files in
 * place, which left the read's timestamp and model claiming the corrected
 * values were the model's own. That is the wrong record. A correction is
 * a separate row: what the model said, what the page says, who decided,
 * when, and where on the page. The cache stays the model's answer.
 *
 * How it is applied: readFiling() assembles the model's rows from the
 * cache, then overlays every RULED correction whose (sourceUrl, pdfSha256,
 * position) matches and whose `original` still equals the value at that
 * position. The result is the candidate the gate compares and the merge
 * publishes. A correction whose original no longer matches is skipped and
 * reported, never applied blind.
 *
 * Lifecycle: proposed (a reader of the page images suggested it) ->
 * ruled (a person confirmed it against the page) -> withdrawn. Only ruled
 * corrections change a candidate.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

export const CORRECTIONS_PATH = path.resolve("data/review/corrections.json");

export type CorrectableField = "type" | "date" | "amount" | "lateFilingFlag" | "description" | "ticker";
/** confirmed: a person looked at the page and the model's value stands.
 * Recorded so the row counts as ruled without changing it. */
export type CorrectionStatus = "proposed" | "ruled" | "withdrawn" | "confirmed";

export interface ReadCorrection {
  /** Stable id: sha256 of sourceUrl|pdfSha256|position|field, 16 hex chars. */
  id: string;
  slug: string;
  sourceUrl: string;
  pdfSha256: string;
  /** 0-based index of the row in the parse record (document order). */
  position: number;
  /** Physical PDF page and printed row number, when known. For a person. */
  page: number | null;
  printedRow: number | null;
  field: CorrectableField;
  /** The model's value at that position when the correction was proposed. */
  original: unknown;
  /** The value the page shows. */
  corrected: unknown;
  /** What was looked at: page image, OCR line, second model, and what it showed. */
  evidence: string;
  proposedBy: string;
  proposedAt: string;
  status: CorrectionStatus;
  ruledBy?: string;
  ruledAt?: string;
  /** Free text from the person who ruled, when they add one. */
  ruling?: string;
}

export interface CorrectionsFile {
  version: 1;
  corrections: ReadCorrection[];
}

export function correctionId(input: Pick<ReadCorrection, "sourceUrl" | "pdfSha256" | "position" | "field">): string {
  return createHash("sha256")
    .update([input.sourceUrl, input.pdfSha256, String(input.position), input.field].join("|"))
    .digest("hex")
    .slice(0, 16);
}

export function readCorrections(file = CORRECTIONS_PATH): CorrectionsFile {
  if (!existsSync(file)) return { version: 1, corrections: [] };
  const parsed = JSON.parse(readFileSync(file, "utf-8")) as CorrectionsFile;
  if (parsed.version !== 1 || !Array.isArray(parsed.corrections)) throw new Error(`${file}: not a corrections file`);
  return parsed;
}

export function writeCorrections(data: CorrectionsFile, file = CORRECTIONS_PATH): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  renameSync(tmp, file);
}

/** Add a proposed correction. Replaces an earlier proposal for the same
 * (read, position, field); refuses to touch one that has been ruled. */
export function proposeCorrection(
  input: Omit<ReadCorrection, "id" | "status" | "proposedAt"> & { proposedAt?: string },
  file = CORRECTIONS_PATH
): ReadCorrection {
  const data = readCorrections(file);
  const id = correctionId(input);
  const existing = data.corrections.find((c) => c.id === id);
  if (existing && existing.status === "ruled") {
    throw new Error(`correction ${id} was ruled by ${existing.ruledBy} on ${existing.ruledAt}; withdraw it first`);
  }
  const record: ReadCorrection = {
    ...input,
    id,
    status: "proposed",
    proposedAt: input.proposedAt ?? new Date().toISOString(),
  };
  data.corrections = data.corrections.filter((c) => c.id !== id).concat(record);
  writeCorrections(data, file);
  return record;
}

/** A person rules on a proposed correction after looking at the page. */
export function ruleCorrection(id: string, ruledBy: string, ruling: string | undefined, file = CORRECTIONS_PATH): ReadCorrection {
  const data = readCorrections(file);
  const record = data.corrections.find((c) => c.id === id);
  if (!record) throw new Error(`no correction ${id}`);
  if (record.status === "withdrawn") throw new Error(`correction ${id} is withdrawn`);
  record.status = "ruled";
  record.ruledBy = ruledBy;
  record.ruledAt = new Date().toISOString();
  if (ruling) record.ruling = ruling;
  writeCorrections(data, file);
  return record;
}

/** A person confirms the model's value against the page. No change is
 * applied; the record shows the row was looked at. */
export function confirmRead(
  input: Omit<ReadCorrection, "id" | "status" | "proposedAt" | "corrected" | "ruledBy" | "ruledAt"> & { ruledBy: string; ruling?: string },
  file = CORRECTIONS_PATH
): ReadCorrection {
  const data = readCorrections(file);
  const id = correctionId(input);
  const existing = data.corrections.find((c) => c.id === id);
  if (existing && existing.status === "ruled") {
    throw new Error(`correction ${id} was ruled by ${existing.ruledBy} on ${existing.ruledAt}; withdraw it first`);
  }
  const now = new Date().toISOString();
  const record: ReadCorrection = {
    ...input, id, corrected: input.original, status: "confirmed", proposedAt: now, ruledBy: input.ruledBy, ruledAt: now,
  };
  data.corrections = data.corrections.filter((c) => c.id !== id).concat(record);
  writeCorrections(data, file);
  return record;
}

export function withdrawCorrection(id: string, by: string, reason: string, file = CORRECTIONS_PATH): ReadCorrection {
  const data = readCorrections(file);
  const record = data.corrections.find((c) => c.id === id);
  if (!record) throw new Error(`no correction ${id}`);
  record.status = "withdrawn";
  record.ruling = `withdrawn by ${by}: ${reason}`;
  writeCorrections(data, file);
  return record;
}

export interface ApplyResult<T> {
  rows: T[];
  /** Ids applied, in position order. */
  applied: string[];
  /** Corrections that matched the read but could not be applied, with why. */
  skipped: Array<{ id: string; reason: string }>;
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * Overlay corrections on a read's rows. Only corrections with the given
 * status (default "ruled") are applied, and only when the row's current
 * value equals the correction's `original`; anything else is skipped and
 * reported so a stale correction can never be applied to a different read.
 * Rows are copied; the input is not mutated. Each corrected row gains a
 * `corrections` list of the ids applied to it.
 */
export function applyCorrections<T extends Record<string, unknown>>(
  rows: T[],
  read: { sourceUrl: string; pdfSha256: string },
  corrections: ReadCorrection[],
  options: { status?: CorrectionStatus } = {}
): ApplyResult<T & { corrections?: string[] }> {
  const status = options.status ?? "ruled";
  const out: Array<T & { corrections?: string[] }> = rows.map((r) => ({ ...r }));
  const applied: string[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];
  const relevant = corrections
    .filter((c) => c.sourceUrl === read.sourceUrl && c.pdfSha256 === read.pdfSha256 && c.status === status)
    .sort((a, b) => a.position - b.position || a.field.localeCompare(b.field));
  for (const c of relevant) {
    const row = out[c.position];
    if (!row) {
      skipped.push({ id: c.id, reason: `position ${c.position} is past the read's ${out.length} rows` });
      continue;
    }
    if (!sameValue(row[c.field], c.original)) {
      skipped.push({ id: c.id, reason: `row ${c.position} ${c.field} is ${JSON.stringify(row[c.field])}, not the recorded original ${JSON.stringify(c.original)}` });
      continue;
    }
    (row as Record<string, unknown>)[c.field] = c.corrected;
    row.corrections = [...(row.corrections ?? []), c.id];
    applied.push(c.id);
  }
  return { rows: out, applied, skipped };
}

/**
 * Replay check: does the original read plus its corrections reproduce an
 * expected set of rows, field for field? Used before any cache that was
 * edited by hand is restored to the model's answer. Compares only the
 * fields a correction can touch plus the ones the gate compares.
 */
export function replayMatches<T extends Record<string, unknown>>(
  original: T[],
  read: { sourceUrl: string; pdfSha256: string },
  corrections: ReadCorrection[],
  expected: T[],
  options: { status?: CorrectionStatus } = {}
): { ok: boolean; differences: string[]; applied: number; skipped: Array<{ id: string; reason: string }> } {
  const result = applyCorrections(original, read, corrections, options);
  const differences: string[] = [];
  if (result.rows.length !== expected.length) differences.push(`row count ${result.rows.length} vs expected ${expected.length}`);
  const fields: CorrectableField[] = ["description", "ticker", "type", "date", "amount", "lateFilingFlag"];
  const n = Math.min(result.rows.length, expected.length);
  for (let i = 0; i < n; i++) {
    for (const f of fields) {
      if (!sameValue(result.rows[i][f], expected[i][f])) {
        differences.push(`row ${i} ${f}: replay ${JSON.stringify(result.rows[i][f])} vs expected ${JSON.stringify(expected[i][f])}`);
      }
    }
  }
  return { ok: differences.length === 0, differences, applied: result.applied.length, skipped: result.skipped };
}
