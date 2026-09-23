import { existsSync } from "fs";
import path from "path";
import { readCorrections } from "@/lib/corrections";
import { readCrosscheckLog } from "@/lib/crosscheck-log";
import { findParseRecord, promptHash, readParseCache } from "@/lib/parse-cache";
import { buildSheet, type ReaderRow, type SheetUnit } from "@/lib/review-sheet";
import { REVIEW_QUEUE_PATH, type ReviewItem } from "@/lib/review-queue";
import { readSecondReadLog, SECOND_READ_INPUT, SECOND_READ_MODEL } from "@/lib/second-read";
import { DEFAULT_MODEL, EXTRACTION_PROMPT, PARSER_VERSION, SYSTEM_PROMPT } from "@/scripts/parse-pdf";
import { readFileSync } from "fs";

function toUnits(record: { transactions: unknown[]; units?: Array<{ first: number; last: number; transactions: unknown[] }> } | null): SheetUnit[] | null {
  if (!record) return null;
  if (record.units?.length) return record.units.map((u) => ({ first: u.first, last: u.last, rows: u.transactions as ReaderRow[] }));
  return [{ first: 1, last: 1, rows: record.transactions as ReaderRow[] }];
}

export async function loadFilingSheet(id: string) {
  const queue: ReviewItem[] = existsSync(REVIEW_QUEUE_PATH) ? JSON.parse(readFileSync(REVIEW_QUEUE_PATH, "utf-8")) : [];
  const item = queue.find((i) => i.id === id) ?? null;
  if (!item || !item.filing.url || !item.filing.pdfFile) return { item, sheet: null, reason: "Review item not found or has no filing." as string | null, pdfFile: null as string | null };
  const pdfFile = item.filing.pdfFile;
  const pdfPath = path.join(process.cwd(), "data", "pdfs", pdfFile);
  const crosscheck = readCrosscheckLog();
  const entry = crosscheck?.entries.findLast((e) => e.slug === item.slug && e.sourceUrl === item.filing.url) ?? null;
  if (!entry?.pdfSha256 || !existsSync(pdfPath)) return { item, sheet: null, reason: "No cross-check record or PDF on disk for this filing.", pdfFile };
  const prompt = promptHash(SYSTEM_PROMPT, EXTRACTION_PROMPT);
  const primary = toUnits(findParseRecord(pdfPath, { pdfSha256: entry.pdfSha256, sourceUrl: item.filing.url, parserVersion: PARSER_VERSION, promptSha256: prompt, model: DEFAULT_MODEL }));
  if (!primary) return { item, sheet: null, reason: "The primary parse record is not on disk.", pdfFile };
  // The second model's reads are cached per page unit under their own key
  // and have no chunk manifest, so assemble them along the primary's units.
  const astraKey = { pdfSha256: entry.pdfSha256, sourceUrl: item.filing.url, parserVersion: `${PARSER_VERSION}+${SECOND_READ_INPUT}`, promptSha256: prompt, model: SECOND_READ_MODEL };
  let astra = toUnits(findParseRecord(pdfPath, astraKey));
  if (!astra) {
    const base = pdfPath.replace(/\.pdf$/i, "");
    const units: SheetUnit[] = [];
    for (const u of primary) {
      const unitPath = u.first === 1 && u.last === 1 && primary.length === 1 ? pdfPath : `${base}.pages${u.first}-${u.last}.pdf`;
      const cached = readParseCache(unitPath, { ...astraKey, chunk: primary.length === 1 && !existsSync(unitPath) ? null : { first: u.first, last: u.last } });
      if (cached) units.push({ first: u.first, last: u.last, rows: cached.transactions as ReaderRow[] });
    }
    astra = units.length ? units : null;
  }
  const secondLog = readSecondReadLog();
  const secondEntry = secondLog?.filings?.[item.filing.url] ?? null;
  const second = secondEntry ? { disputedIndexes: secondEntry.disputedIndexes, unreadIndexes: secondEntry.unreadIndexes, extraRows: secondEntry.extraRows as ReaderRow[] } : null;
  const aligned = (entry as { ocr?: { aligned?: { agreedPrintedRows?: number[]; disputedPrintedRows?: number[]; differences?: string[] } } }).ocr?.aligned;
  const ocr = aligned ? { agreedPrintedRows: aligned.agreedPrintedRows ?? [], disputedPrintedRows: aligned.disputedPrintedRows ?? [], differences: aligned.differences ?? [] } : null;
  const continuous = entry.comparedFields?.includes("printedRowContinuity") ?? false;
  const sheet = buildSheet({
    sourceUrl: item.filing.url, pdfSha256: entry.pdfSha256, primaryUnits: primary, astraUnits: astra, second, ocr,
    printedRowsContinuous: continuous, corrections: readCorrections().corrections,
  });
  return { item, sheet, reason: null, pdfFile, pdfSha256: entry.pdfSha256, secondEntry, astraAvailable: astra !== null };
}
