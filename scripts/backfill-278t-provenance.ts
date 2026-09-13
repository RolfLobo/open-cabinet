/**
 * Stamp sourcePage and sourceRow on 278-T rows where the checking lanes
 * already established them; leave null everywhere else.
 *
 *   npx tsx scripts/backfill-278t-provenance.ts [--dry-run]
 *   then pnpm generate-exports
 *
 * The annual-report lane gave every annual row a page and a printed row
 * number. A 278-T row can carry the same provenance only where it is
 * derivable without guessing:
 *
 * - sourceRow: the filing's text-layer cross-check agreed row for row
 *   (state checked_tuple_agreement, which compares printed-row
 *   continuity 1..N). The published row is located in the parse record
 *   the check ran against, and its printed row number follows from its
 *   position plus the numbered placeholder rows the form prints
 *   (lib/row-verification.ts printedRowForIndex, the OCR lane's inverse).
 * - sourcePage: the page of pdftotext's output on which that printed
 *   row starts (form feeds separate pages), from the same text layer.
 *
 * Scanned filings (no usable text) get neither: their parse caches are
 * page chunks that span several pages, and a chunk range is not a page.
 * A row the parse record does not contain as published, a filing whose
 * check did not agree, and any row a person has decided are all left as
 * they are. Reads the same caches and logs as build-row-verification;
 * never calls a model. Idempotent: rerunning stamps the same values.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readCrosscheckLog } from "../lib/crosscheck-log";
import { findParseRecord, promptHash } from "../lib/parse-cache";
import { locateInParseRecord, printedRowForIndex } from "../lib/row-verification";
import type { OfficialData, Transaction } from "../lib/types";
import { extractTextLayerRows } from "./text-layer-crosscheck";
import { DEFAULT_MODEL, EXTRACTION_PROMPT, PARSER_VERSION, SYSTEM_PROMPT } from "./parse-pdf.js";

const DRY_RUN = process.argv.includes("--dry-run");
const OFFICIALS_DIR = path.resolve("data/officials");
const PDF_DIR = path.resolve("data/pdfs");
const PROMPT_SHA256 = promptHash(SYSTEM_PROMPT, EXTRACTION_PROMPT);

function pdfFilenameFromUrl(url: string): string {
  return decodeURIComponent(url.split("/").pop() || "filing.pdf");
}

/** Printed row number to the 1-based page it starts on, from pdftotext's
 * page-separated layout output. The row-start pattern is the cross-check's. */
function pageByPrintedRow(pdfPath: string): Map<number, number> | null {
  let text: string;
  try {
    text = execFileSync("pdftotext", ["-layout", pdfPath, "-"], { encoding: "utf-8", timeout: 30_000, maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return null;
  }
  const rowStart = /^\s{0,4}(\d{1,4})\s{2,}\S/;
  const out = new Map<number, number>();
  text.split("\f").forEach((page, i) => {
    for (const line of page.split("\n")) {
      const m = line.match(rowStart);
      if (m) {
        const n = Number(m[1]);
        if (!out.has(n)) out.set(n, i + 1);
      }
    }
  });
  return out;
}

function main() {
  const log = readCrosscheckLog();
  if (!log) throw new Error("no cross-check log");
  let stampedRows = 0;
  let stampedPages = 0;
  let filingsDone = 0;
  const skipped: Record<string, number> = {};
  const skip = (why: string) => { skipped[why] = (skipped[why] ?? 0) + 1; };

  for (const file of readdirSync(OFFICIALS_DIR).filter((f) => f.endsWith(".json")).sort()) {
    const filePath = path.join(OFFICIALS_DIR, file);
    const official = JSON.parse(readFileSync(filePath, "utf-8")) as OfficialData;
    const urls = new Set(official.transactions.map((t) => t.sourceUrl).filter((u): u is string => Boolean(u)));
    let changed = false;
    for (const url of urls) {
      const entry = log.entries.find((e) => e.slug === official.slug && e.sourceUrl === url);
      if (!entry) { skip("no cross-check entry"); continue; }
      if (entry.state !== "checked_tuple_agreement") { skip(`state ${entry.state}`); continue; }
      const pdfPath = path.join(PDF_DIR, pdfFilenameFromUrl(url));
      if (!existsSync(pdfPath) || !entry.pdfSha256) { skip("pdf not on disk"); continue; }
      const record = findParseRecord(pdfPath, { pdfSha256: entry.pdfSha256, sourceUrl: url, parserVersion: PARSER_VERSION, promptSha256: PROMPT_SHA256, model: DEFAULT_MODEL });
      if (!record) { skip("no parse record"); continue; }
      const ext = extractTextLayerRows(pdfPath);
      if (ext.kind !== "rows") { skip("text layer unreadable"); continue; }
      const pages = pageByPrintedRow(pdfPath);
      // 278-T rows of this filing only; an annual-lane row never shares a URL with one.
      const rows = official.transactions.filter((t) => t.sourceUrl === url && (t.sourceKind ?? "278-T") === "278-T");
      const positions = locateInParseRecord(rows, record.transactions as Array<{ description: string; type: string; date: string | null; amount: string | null; lateFilingFlag?: boolean | null }>);
      rows.forEach((tx, k) => {
        const idx = positions[k];
        if (idx < 0) { skip("row not in parse record"); return; }
        const printed = printedRowForIndex(idx, ext.placeholderRows);
        const page = pages?.get(printed) ?? null;
        const row = tx as Transaction;
        if (row.sourceRow !== printed || (row.sourcePage ?? null) !== page) changed = true;
        row.sourceRow = printed;
        row.sourcePage = page;
        stampedRows += 1;
        if (page !== null) stampedPages += 1;
      });
      filingsDone += 1;
    }
    if (changed && !DRY_RUN) writeFileSync(filePath, JSON.stringify(official, null, 2) + "\n");
    if (changed) console.log(`${official.slug}: stamped`);
  }
  console.log(`\n${filingsDone} text-checked filings; ${stampedRows} rows given a printed row number, ${stampedPages} of them a page.`);
  console.log("Skipped:", skipped);
  if (DRY_RUN) console.log("Dry run, nothing written.");
  else console.log("Next: pnpm generate-exports && pnpm test:data");
}

main();
