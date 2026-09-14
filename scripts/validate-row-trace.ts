/**
 * Row-trace validation: does every published row appear on the PDF page it
 * claims? Free, deterministic, no model.
 *
 *   pnpm validate:trace -- --all                     every official; Trump sampled (500)
 *   pnpm validate:trace -- --all --full-trump        every row, Trump included
 *   pnpm validate:trace -- --official bisignano-frank-j [--official duffy-sean]
 *   options: --sample-trump N   --seed N   --controls N (default 200)
 *
 * For each row with a sourcePage, the page's text (pdftotext -layout,
 * split on form feeds, checked against pdfinfo's page count) must carry
 * the printed row number at a line start (annual and termination rows),
 * the trade date in one of its M/D/YYYY spellings, and the amount range's
 * leading dollar figure. An annual or termination row without a page must
 * be found somewhere in the document by date, amount and description
 * (lib/row-trace.ts). Scanned filings, and 278-T rows without a page
 * (their filing's text layer is OCR the lanes did not confirm), are
 * outside this check and are reported as skipped, with a note.
 *
 * Then the negative controls: a seeded sample of rows that passed is
 * mutated three ways (date shifted a day, row number +5000, description
 * replaced) and every mutation must be rejected. If one is not, the run
 * reports the validator as too loose and exits 1, whatever the rows said.
 *
 * PDFs: 278-T filings are in data/pdfs. An annual or termination report is
 * fetched from its sourceUrl into data/pdfs (file named as OGE names it)
 * when missing, two seconds apart, so a clean checkout can run this. Those
 * cached reports are not committed (.gitignore).
 *
 * Every run appends a record to data/meta/row-trace-log.json (last 50
 * kept): options, counts per official, failing rows, control results, git
 * SHA. The admin panel renders that log; it has no run button because the
 * run needs the PDFs and poppler on the machine.
 *
 * Ported from the Sep 2026 audit's verifier (checks 1, 2 and the negative
 * controls). Requires poppler's pdftotext and pdfinfo on PATH.
 */
import { execFileSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import https from "node:https";
import path from "node:path";
import { hasTextLayer, inBlock, inPage, locateInPages, runControls, seededSample, splitPages, type TraceRow } from "../lib/row-trace";
import { appendRowTraceRun, type RowTraceControls, type RowTraceFailure, type RowTraceOfficialCounts, type RowTraceRun } from "../lib/row-trace-log";
import type { OfficialData, Transaction } from "../lib/types";

const PDF_DIR = path.resolve("data/pdfs");
const OFFICIALS_DIR = path.resolve("data/officials");
const TRUMP = "trump-donald-j";

// ---------------------------------------------------------------- options
const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(name);
const value = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const values = (name: string): string[] => argv.flatMap((a, i) => (a === name ? [argv[i + 1]] : []));

const ALL = flag("--all");
const OFFICIALS = values("--official");
const FULL_TRUMP = flag("--full-trump");
const SEED = Number(value("--seed") ?? 20260913);
const CONTROLS = Number(value("--controls") ?? 200);
const SAMPLE_TRUMP = FULL_TRUMP ? null : Number(value("--sample-trump") ?? (ALL ? 500 : 500));

if (!ALL && OFFICIALS.length === 0) {
  console.error("usage: validate-row-trace.ts --all | --official <slug> [--official <slug>] [--sample-trump N] [--full-trump] [--seed N] [--controls N]");
  process.exit(2);
}

// ---------------------------------------------------------------- tools
function requireTool(name: string): void {
  try {
    execFileSync(name, ["-v"], { stdio: "ignore" });
  } catch {
    console.error(`${name} is not on PATH. Install poppler (brew install poppler / apt install poppler-utils) and rerun.`);
    process.exit(2);
  }
}
requireTool("pdftotext");
requireTool("pdfinfo");

function gitSha(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf-8" }).trim();
  } catch {
    return null;
  }
}

function pdfPageCount(file: string): number | null {
  const out = execFileSync("pdfinfo", [file], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
  const m = out.match(/^Pages:\s+(\d+)/m);
  return m ? Number(m[1]) : null;
}

/** Whole document text, split into pages; per-page fallback when the
 * form-feed split disagrees with pdfinfo. Cached per file. */
const pageCache = new Map<string, string[]>();
function pagesOf(file: string): string[] {
  const hit = pageCache.get(file);
  if (hit) return hit;
  const count = pdfPageCount(file);
  const whole = execFileSync("pdftotext", ["-layout", file, "-"], { encoding: "utf-8", maxBuffer: 256 * 1024 * 1024 });
  let pages = splitPages(whole, count);
  if (!pages) {
    pages = [];
    for (let p = 1; p <= (count ?? 0); p++) {
      pages.push(execFileSync("pdftotext", ["-f", String(p), "-l", String(p), "-layout", file, "-"], { encoding: "utf-8" }));
    }
  }
  pageCache.set(file, pages);
  return pages;
}

// ---------------------------------------------------------------- pdf fetch and cache
function fileNameFromUrl(url: string): string {
  return decodeURIComponent(url.split("/").pop() || "filing.pdf");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function download(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(dest);
    https
      .get(url, { headers: { "User-Agent": "OpenCabinet/1.0 (row-trace validator)" } }, (res) => {
        if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
          file.close();
          download(res.headers.location, dest).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          file.close();
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        res.pipe(file);
        file.on("finish", () => { file.close(); resolve(); });
      })
      .on("error", (err) => {
        try { unlinkSync(dest); } catch { /* nothing to remove */ }
        reject(err);
      });
  });
}

let fetched = 0;
let lastFetchAt = 0;
const scansNoted = new Set<string>();
const unpagedNoted = new Set<string>();
const problems: string[] = [];
/** The local PDF for a source URL: on disk, else fetched (two seconds
 * between fetches), else null with the reason recorded. */
async function localPdf(url: string): Promise<string | null> {
  const file = path.join(PDF_DIR, fileNameFromUrl(url));
  if (existsSync(file) && statSync(file).size > 0) return file;
  mkdirSync(PDF_DIR, { recursive: true });
  const wait = 2000 - (Date.now() - lastFetchAt);
  if (wait > 0) await sleep(wait);
  try {
    console.log(`  fetching ${fileNameFromUrl(url)}`);
    await download(url, file);
    lastFetchAt = Date.now();
    fetched += 1;
    return file;
  } catch (err) {
    problems.push(`${fileNameFromUrl(url)}: fetch failed (${(err as Error).message})`);
    return null;
  }
}

// ---------------------------------------------------------------- run
interface Job { slug: string; tx: Transaction; file: string; pages: string[] }

function emptyCounts(): RowTraceOfficialCounts {
  return { paged: 0, passed: 0, failed: 0, unpaged: 0, located: 0, unlocated: 0, skipped: 0 };
}

function describe(slug: string, tx: Transaction, reason: string): RowTraceFailure {
  return {
    official: slug,
    sourceKind: tx.sourceKind ?? "278-T",
    page: tx.sourcePage ?? null,
    row: tx.sourceRow ?? null,
    date: tx.date,
    amount: tx.amount,
    description: tx.description.slice(0, 80),
    reason,
  };
}

async function main() {
  const started = Date.now();
  const slugs = readdirSync(OFFICIALS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -5))
    .filter((s) => ALL || OFFICIALS.includes(s));
  const missing = OFFICIALS.filter((s) => !slugs.includes(s));
  if (missing.length) {
    console.error(`unknown official(s): ${missing.join(", ")}`);
    process.exit(2);
  }

  const perOfficial: Record<string, RowTraceOfficialCounts> = {};
  const failures: RowTraceFailure[] = [];
  const passedJobs: Job[] = [];
  const totals = { ...emptyCounts(), officials: slugs.length, pdfsFetched: 0 };

  for (const slug of slugs) {
    const official = JSON.parse(readFileSync(path.join(OFFICIALS_DIR, `${slug}.json`), "utf-8")) as OfficialData;
    const counts = emptyCounts();
    perOfficial[slug] = counts;
    // Rows to check: everything with a source URL. Trump is sampled unless
    // --full-trump, because his 30,000 rows take minutes and the sample,
    // seeded, is the same rows every run.
    let rows = official.transactions.filter((tx) => tx.sourceUrl);
    if (slug === TRUMP && SAMPLE_TRUMP !== null && rows.length > SAMPLE_TRUMP) {
      rows = seededSample(rows, SAMPLE_TRUMP, SEED);
    }
    console.log(`${slug}: ${rows.length.toLocaleString()} rows${slug === TRUMP && SAMPLE_TRUMP !== null ? " (seeded sample)" : ""}`);
    const fileByUrl = new Map<string, string | null>();
    for (const tx of rows) {
      const url = tx.sourceUrl as string;
      if (!fileByUrl.has(url)) fileByUrl.set(url, await localPdf(url));
      const file = fileByUrl.get(url);
      if (!file) { counts.skipped += 1; continue; }
      let pages: string[];
      try {
        pages = pagesOf(file);
      } catch (err) {
        problems.push(`${path.basename(file)}: could not read (${(err as Error).message})`);
        counts.skipped += 1;
        continue;
      }
      const row: TraceRow = tx;
      // A scanned filing (most 278-Ts) has no text layer to trace against;
      // its rows are the OCR and page-image lanes' business
      // (lib/row-verification.ts), not this validator's. Say so once per
      // file and count the rows as skipped, never as failures.
      if (!hasTextLayer(pages)) {
        if (!scansNoted.has(file)) {
          scansNoted.add(file);
          problems.push(`${path.basename(file)}: no usable text layer (scan); its rows are not traceable here`);
        }
        counts.skipped += 1;
        continue;
      }
      if (tx.sourcePage != null) {
        counts.paged += 1;
        const text = pages[tx.sourcePage - 1];
        if (text === undefined) {
          counts.failed += 1;
          failures.push(describe(slug, tx, `page ${tx.sourcePage} out of range (${pages.length} pages)`));
          continue;
        }
        const v = inPage(text, row);
        const annualLane = (tx.sourceKind ?? "278-T") !== "278-T";
        const bad: string[] = [];
        // The printed row number is a spec criterion for annual and
        // termination rows; a 278-T's number is provenance the text lane
        // derived, and a page whose token is not at a line start is an
        // extra item, not a failure, as the audit treated it.
        if (annualLane && v.row === false) bad.push("row number");
        if (v.date === false) bad.push("date");
        if (v.amount === false) bad.push("amount");
        if (bad.length) {
          counts.failed += 1;
          failures.push(describe(slug, tx, `page lacks ${bad.join(", ")}`));
        } else {
          counts.passed += 1;
          if (v.row === true) passedJobs.push({ slug, tx, file, pages });
        }
      } else if ((tx.sourceKind ?? "278-T") === "278-T") {
        // A 278-T row has a page only where the text lane agreed with the
        // read row for row (scripts/backfill-278t-provenance.ts). A 278-T
        // row without one comes from a filing whose text layer is OCR the
        // lanes did not trust ("ourchaso" for "purchase"); searching that
        // text proves nothing, so the row is outside this check and the
        // OCR and page-image lanes' verdict stands (lib/row-verification.ts).
        if (!unpagedNoted.has(file)) {
          unpagedNoted.add(file);
          problems.push(`${path.basename(file)}: 278-T rows without a page are outside this check (text layer not lane-confirmed)`);
        }
        counts.skipped += 1;
      } else {
        counts.unpaged += 1;
        const found = locateInPages(pages, row);
        if (found) counts.located += 1;
        else {
          counts.unlocated += 1;
          failures.push(describe(slug, tx, "not located anywhere in the document by date, amount and description"));
        }
      }
    }
    for (const k of Object.keys(counts) as Array<keyof RowTraceOfficialCounts>) totals[k] += counts[k];
    console.log(`  paged ${counts.paged}: ${counts.passed} pass, ${counts.failed} fail; unpaged ${counts.unpaged}: ${counts.located} located, ${counts.unlocated} not; skipped ${counts.skipped}`);
  }
  totals.pdfsFetched = fetched;

  // Negative controls over a seeded sample of rows that passed with a row token.
  const controls: RowTraceControls = {
    sample: 0,
    dateShift: { caught: 0, uncaught: 0, notEvaluable: 0 },
    rowShift: { caught: 0, uncaught: 0, notEvaluable: 0 },
    descSwap: { caught: 0, uncaught: 0, notEvaluable: 0 },
  };
  const uncaughtExamples: string[] = [];
  for (const job of seededSample(passedJobs, CONTROLS, SEED)) {
    controls.sample += 1;
    const text = job.pages[(job.tx.sourcePage as number) - 1];
    const r = runControls(text, job.tx);
    for (const k of ["dateShift", "rowShift", "descSwap"] as const) {
      const outcome = r[k];
      if (outcome === "caught") controls[k].caught += 1;
      else if (outcome === "uncaught") {
        controls[k].uncaught += 1;
        if (uncaughtExamples.length < 10) uncaughtExamples.push(`${k}: ${job.slug} p.${job.tx.sourcePage} #${job.tx.sourceRow} ${job.tx.description.slice(0, 50)}`);
      } else controls[k].notEvaluable += 1;
    }
    // Sanity: the unmutated row must still pass its own block check.
    const own = inBlock(text, job.tx);
    if (own && own.block && own.date === false) uncaughtExamples.push(`baseline: ${job.slug} p.${job.tx.sourcePage} #${job.tx.sourceRow} block lacks its own date`);
  }
  const loose = controls.dateShift.uncaught + controls.rowShift.uncaught + controls.descSwap.uncaught > 0;
  const failed = totals.failed + totals.unlocated > 0;
  const result: RowTraceRun["result"] = failed ? "FAIL" : loose ? "LOOSE" : "PASS";

  const run: RowTraceRun = {
    ranAt: new Date().toISOString(),
    gitSha: gitSha(),
    options: { all: ALL, officials: OFFICIALS, sampleTrump: SAMPLE_TRUMP, fullTrump: FULL_TRUMP, seed: SEED, controls: CONTROLS },
    result,
    totals,
    perOfficial,
    failures,
    controls,
    problems,
    durationSeconds: Math.round((Date.now() - started) / 1000),
  };
  appendRowTraceRun(run);

  console.log(`\n=== Row trace: ${result} ===`);
  console.log(`${totals.officials} officials; paged rows ${totals.paged.toLocaleString()}: ${totals.passed.toLocaleString()} pass, ${totals.failed} fail; unpaged ${totals.unpaged}: ${totals.located} located, ${totals.unlocated} not; skipped ${totals.skipped}; PDFs fetched ${fetched}`);
  console.log(
    `controls on ${controls.sample} rows: date shift caught ${controls.dateShift.caught} (uncaught ${controls.dateShift.uncaught}, n/a ${controls.dateShift.notEvaluable}); ` +
      `row +5000 caught ${controls.rowShift.caught} (uncaught ${controls.rowShift.uncaught}); description swap caught ${controls.descSwap.caught} (uncaught ${controls.descSwap.uncaught}, n/a ${controls.descSwap.notEvaluable})`
  );
  if (loose) {
    console.log("The validator is TOO LOOSE: a mutated row passed. Examples:");
    for (const e of uncaughtExamples) console.log(`  ${e}`);
  }
  for (const f of failures.slice(0, 40)) console.log(`  FAIL ${f.official} ${f.sourceKind} p.${f.page} #${f.row} ${f.date} ${f.amount} ${f.description}: ${f.reason}`);
  if (failures.length > 40) console.log(`  ... and ${failures.length - 40} more (see data/meta/row-trace-log.json)`);
  for (const p of problems.slice(0, 30)) console.log(`  note: ${p}`);
  if (problems.length > 30) console.log(`  ... and ${problems.length - 30} more notes in the log`);
  console.log(`logged to data/meta/row-trace-log.json (${run.durationSeconds}s)`);
  process.exit(result === "PASS" ? 0 : 1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(2);
});
