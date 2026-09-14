/**
 * Record the annual-lane verification evidence: which of the Sep 2026
 * audit's artifacts agree with each annual or termination row the site
 * publishes, so scripts/build-row-verification.ts can give those rows the
 * same "checked" standing as 278-T rows by the same three gates (a
 * program agreed, a model read the page and agreed, the row was found on
 * its printed page).
 *
 *   ANNUAL_LANE_INPUTS=<dir> pnpm record-annual-verification
 *   pnpm record-annual-verification --inputs <dir>
 *
 * <dir> is the audit's working directory (the same one
 * scripts/ingest-annual-reports.ts reads). Under <dir>/audit it reads:
 *
 *   read-a/<report>.json            the pdftotext column parse each lane row came from
 *   plumber-trump.json              pdfplumber coordinate extraction of Trump's Part 7
 *   model-reads/sonnet-p*.json      Claude Sonnet page read of all 687 Trump Part 7 pages
 *   model-reads/astra-p*.json       GPT-6 Astra page read of 570 of those pages
 *   trump-visual*.md                the pages a person or the session compared as images
 *   read-b/<report>.json            an independent model transcription of every other report
 *   spot-check-2026-09-14.txt       20 rows Trevor Brown hand-checked against the PDF
 *
 * and from the repo, data/meta/row-trace-log.json (the latest full
 * row-trace run must have passed) and public/evidence for the strips.
 *
 * Each lane row is matched to the artifacts by official, account (Trump),
 * printed row number, PDF page, description, type, date and amount. A row
 * whose page disagrees with the artifacts, or whose values do, is a gap:
 * it gets no evidence and stays a single read; the gaps are printed and
 * written to the log for a person.
 *
 * Writes data/meta/annual-verification-log.json (keyed by record ID, so a
 * later change to a row drops its evidence) and appends a confirmed
 * decision to data/review/decisions.json for each hand-checked row that
 * has no decision yet. Reads only otherwise; never calls a model, never
 * edits an official file.
 */
import { createHash } from "crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import { readRowTraceLog } from "../lib/row-trace-log";
import {
  ANNUAL_VERIFICATION_LOG_PATH,
  REVIEW_DECISIONS_PATH,
  readReviewDecisions,
  readRowVerification,
  recordIdsFor,
  sameAssetWording,
  type AnnualEvidence,
  type AnnualVerificationLog,
  type ReviewDecision,
} from "../lib/row-verification";
import type { OfficialData, Transaction } from "../lib/types";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const INPUTS = flag("--inputs") ?? process.env.ANNUAL_LANE_INPUTS;
if (!INPUTS) {
  console.error("usage: record-annual-verification.ts --inputs <dir> (or set ANNUAL_LANE_INPUTS)");
  process.exit(2);
}
const AUDIT = path.join(INPUTS, "audit");
const OFFICIALS_DIR = path.resolve("data/officials");
const EVIDENCE_DIR = path.resolve("public/evidence");
const TRUMP = "trump-donald-j";
const SPOT_CHECK_FILE = "spot-check-2026-09-14.txt";
const SPOT_CHECK_DECIDER = "Trevor Brown";
/** 1:34 PM EDT on Sept. 14, 2026, as the spot-check file records. */
const SPOT_CHECK_DECIDED_AT = "2026-09-14T17:34:00.000Z";

// ---------------------------------------------------------------- helpers
function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf-8")) as T;
}
function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}
/** "9/26/2025" or "09/26/2025" to "2025-09-26". */
function isoDate(us: string | null | undefined): string | null {
  const m = (us ?? "").match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return m ? `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}` : null;
}
function normAmount(a: string | null | undefined): string {
  return (a ?? "").replace(/\s+/g, "").toLowerCase();
}
function normType(t: string | null | undefined): string {
  return (t ?? "").toLowerCase().replace(/[^a-z]/g, "");
}
function normDesc(d: string | null | undefined): string {
  return (d ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}
/** One asset, allowing a footer bleed or a truncated tail on either side. */
function descAgree(a: string, b: string): boolean {
  const da = normDesc(a);
  const db = normDesc(b);
  if (!da || !db) return false;
  if (da === db) return true;
  const n = Math.min(12, da.length, db.length);
  return da.startsWith(db.slice(0, n)) || db.startsWith(da.slice(0, n));
}

interface ArtifactRow {
  page: number | null;
  description: string;
  type: string;
  date: string;
  amount: string;
}

/** Why an artifact row disagrees with a published row, or null when it agrees. */
function disagreement(tx: Transaction, r: ArtifactRow, checkPage: boolean): string | null {
  const out: string[] = [];
  if (normType(r.type) !== normType(tx.type)) {
    // A row the form prints with no type is published as "Unstated".
    if (!(tx.type === "Unstated" && normType(r.type) === "")) out.push(`type ${r.type || "(blank)"} vs ${tx.type}`);
  }
  if (isoDate(r.date) !== tx.date) out.push(`date ${r.date} vs ${tx.date}`);
  if (tx.amount === null) {
    if (!/not\s*readily\s*ascertainable/i.test(r.amount ?? "")) out.push(`amount ${r.amount || "(blank)"} vs (not readily ascertainable)`);
  } else if (normAmount(r.amount) !== normAmount(tx.amount)) out.push(`amount ${r.amount} vs ${tx.amount}`);
  if (!descAgree(tx.description, r.description)) out.push(`description "${r.description}" vs "${tx.description}"`);
  if (checkPage && tx.sourcePage != null && r.page != null && r.page !== tx.sourcePage) out.push(`page ${r.page} vs ${tx.sourcePage}`);
  return out.length ? out.join("; ") : null;
}

const accountNumber = (label: string | null | undefined): string => (label ?? "").replace(/\D/g, "");
const trumpKey = (account: string | null | undefined, row: number | null | undefined) => `${accountNumber(account)}|${row}`;

// ---------------------------------------------------------------- Trump artifacts
interface TrumpReadRow { page: number | null; account: string | number | null; row: number; description: string; type: string; date: string; amount: string }

function loadTrumpArtifacts() {
  const plumber = readJson<{ rows: TrumpReadRow[] }>(path.join(AUDIT, "plumber-trump.json")).rows;
  const byKey = (rows: TrumpReadRow[]) => {
    const m = new Map<string, ArtifactRow>();
    for (const r of rows) m.set(trumpKey(String(r.account ?? ""), r.row), { page: r.page ?? null, description: r.description, type: r.type, date: r.date, amount: r.amount });
    return m;
  };
  const chunks = (model: "sonnet" | "astra") => {
    const dir = path.join(AUDIT, "model-reads");
    const files = readdirSync(dir).filter((f) => f.startsWith(`${model}-p`) && f.endsWith(".json")).sort();
    const rows: TrumpReadRow[] = [];
    for (const f of files) {
      const j = readJson<{ rows: TrumpReadRow[]; truncated?: boolean }>(path.join(dir, f));
      if (j.truncated) continue;
      rows.push(...j.rows);
    }
    return { files: files.length, rows: byKey(rows) };
  };
  const sonnet = chunks("sonnet");
  const astra = chunks("astra");
  // Pages compared as images: the per-page tables of trump-visual.md and
  // trump-visual-2.md, and the "Pages checked" line of trump-visual-3.md.
  const imagePages = new Set<number>();
  for (const f of ["trump-visual.md", "trump-visual-2.md"]) {
    const text = readFileSync(path.join(AUDIT, f), "utf-8");
    for (const m of text.matchAll(/^\| (\d{3}) /gm)) imagePages.add(Number(m[1]));
  }
  const v3 = readFileSync(path.join(AUDIT, "trump-visual-3.md"), "utf-8").match(/Pages checked: \d+ \(([^)]*)\)/);
  if (v3) for (const m of v3[1].matchAll(/\b(\d{3})\b/g)) imagePages.add(Number(m[1]));
  return { plumber: byKey(plumber), plumberRows: plumber.length, sonnet, astra, imagePages };
}

// ---------------------------------------------------------------- non-Trump artifacts
interface ReadBRow { rowNumber: number; description: string; type: string; date: string; amount: string; pdfPage: number | null }

function loadReadB(slug: string): { file: string; rows: Map<number, ArtifactRow> } | null {
  const dir = path.join(AUDIT, "read-b");
  const file = readdirSync(dir).find((f) => f.startsWith(`${slug}__`) && f.endsWith(".json"));
  if (!file) return null;
  const j = readJson<{ rows?: ReadBRow[] }>(path.join(dir, file));
  const rows = new Map<number, ArtifactRow>();
  for (const r of j.rows ?? []) rows.set(Number(r.rowNumber), { page: r.pdfPage ?? null, description: r.description, type: r.type, date: r.date, amount: r.amount });
  return { file, rows };
}

// ---------------------------------------------------------------- spot check
interface SpotRow { slug: string; page: number; row: number; description: string; type: string; date: string; amount: string }

function loadSpotCheck(): { rows: SpotRow[]; result: string } {
  const text = readFileSync(path.join(AUDIT, SPOT_CHECK_FILE), "utf-8");
  const rows: SpotRow[] = [];
  let slug = "";
  for (const line of text.split("\n")) {
    const h = line.match(/^== (\S+)/);
    if (h) { slug = h[1]; continue; }
    const m = line.match(/^\d+\. PDF page (\d+), row #(\d+)(?: \([^)]*\))?: (.+?) \| (\S+) \| (\d{4}-\d{2}-\d{2}) \| (\S+)\s*$/);
    if (m && slug) rows.push({ slug, page: Number(m[1]), row: Number(m[2]), description: m[3].trim(), type: m[4], date: m[5], amount: m[6] });
  }
  const result = (text.match(/^RESULT: (.*)$/m) ?? [, ""])[1] as string;
  if (!/20 of 20 rows match/.test(result)) throw new Error(`${SPOT_CHECK_FILE}: RESULT line does not say 20 of 20 rows match`);
  if (rows.length !== 20) throw new Error(`${SPOT_CHECK_FILE}: parsed ${rows.length} rows, expected 20`);
  return { rows, result };
}

// ---------------------------------------------------------------- main
function main() {
  const trace = readRowTraceLog();
  const fullRun = trace?.runs.find((r) => r.options.all && r.options.fullTrump);
  if (!fullRun || fullRun.result !== "PASS" || fullRun.totals.failed || fullRun.totals.unlocated) {
    throw new Error("no passing full row-trace run in data/meta/row-trace-log.json; run: pnpm validate:trace -- --all --full-trump");
  }
  const trump = loadTrumpArtifacts();
  const spot = loadSpotCheck();
  const before = readRowVerification();
  const decisions = readReviewDecisions();

  const rows: Record<string, AnnualEvidence> = {};
  const gaps: AnnualVerificationLog["gaps"] = [];
  const tagCounts = new Map<string, number>();
  const perOfficial = new Map<string, { lane: number; recorded: number }>();
  const spotMatched = new Map<SpotRow, string>();
  let laneRows = 0;
  const newDecisions: ReviewDecision[] = [];

  for (const file of readdirSync(OFFICIALS_DIR).filter((f) => f.endsWith(".json")).sort()) {
    const official = readJson<OfficialData>(path.join(OFFICIALS_DIR, file));
    const ids = recordIdsFor(official.transactions);
    const readB = official.slug === TRUMP ? null : loadReadB(official.slug);
    const traced = fullRun.perOfficial[official.slug];
    official.transactions.forEach((tx, i) => {
      if (tx.sourceKind !== "annual-278e" && tx.sourceKind !== "termination-278e") return;
      laneRows += 1;
      const po = perOfficial.get(official.slug) ?? { lane: 0, recorded: 0 };
      po.lane += 1;
      perOfficial.set(official.slug, po);
      const id = ids[i];
      const evidence: string[] = [];
      const problems: string[] = [];
      let programAgree = false;
      let modelPageReadAgree = false;
      let secondCompanyAgree = false;
      let imageChecked = false;
      // The name gate is its own check, held to the site's strict wording
      // test (one asset, different wording) against the model page read.
      let nameAgree = false;

      if (official.slug === TRUMP) {
        const sonnetRow = trump.sonnet.rows.get(trumpKey(tx.accountLabel, tx.sourceRow));
        nameAgree = !!sonnetRow && sameAssetWording(tx.description, sonnetRow.description);
        const key = trumpKey(tx.accountLabel, tx.sourceRow);
        const check = (name: string, tag: string, r: ArtifactRow | undefined) => {
          if (!r) return false;
          const why = disagreement(tx, r, true);
          if (why) { problems.push(`${name}: ${why}`); return false; }
          evidence.push(tag);
          return true;
        };
        programAgree = check("pdfplumber", "pdfplumber-agree", trump.plumber.get(key));
        modelPageReadAgree = check("Sonnet page read", "sonnet-page-read-agree", trump.sonnet.rows.get(key));
        secondCompanyAgree = check("GPT-6 Astra page read", "astra-page-read-agree", trump.astra.rows.get(key));
        if (tx.sourcePage != null && trump.imagePages.has(tx.sourcePage)) { imageChecked = true; evidence.push("image-check"); }
      } else {
        const r = readB ? readB.rows.get(tx.sourceRow ?? -1) : undefined;
        if (!readB) problems.push("no read-b transcription for this official");
        else if (!r) problems.push(`read-b has no printed row ${tx.sourceRow}`);
        else {
          const why = disagreement(tx, r, true);
          if (why) problems.push(`model transcription: ${why}`);
          else { modelPageReadAgree = true; evidence.push("model-transcription-agree"); }
          nameAgree = sameAssetWording(tx.description, r.description);
        }
        if (tx.sourcePage != null && tx.sourceRow != null && existsSync(path.join(EVIDENCE_DIR, official.slug, `${tx.sourceKind}-${tx.sourcePage}-${tx.sourceRow}.png`))) evidence.push("evidence-strip");
      }

      // The row-trace validator (pdftotext, no model) found the printed
      // row number, date, amount, description and type in the row's own
      // block on its page, or located a page-less row in the document.
      // That is the program gate for every lane row; pdfplumber is a
      // second program on Trump's report.
      const rowTracePass = !!traced && traced.failed === 0 && traced.unlocated === 0 && (tx.sourcePage != null ? traced.paged > 0 : traced.located > 0);
      if (rowTracePass) { evidence.push("row-trace-pass"); programAgree = true; }
      else problems.push("no passing row-trace record for this official");

      const spotRow = spot.rows.find((s) => s.slug === official.slug && s.page === tx.sourcePage && s.row === tx.sourceRow && !spotMatched.has(s));
      if (spotRow) {
        const why = spotRow.description !== tx.description.trim() ? `description "${spotRow.description}" vs "${tx.description}"`
          : spotRow.type !== tx.type ? `type ${spotRow.type} vs ${tx.type}`
          : spotRow.date !== tx.date ? `date ${spotRow.date} vs ${tx.date}`
          : normAmount(spotRow.amount) !== normAmount(tx.amount) ? `amount ${spotRow.amount} vs ${tx.amount}` : null;
        if (why) problems.push(`spot check: ${why}`);
        else {
          spotMatched.set(spotRow, id);
          evidence.push("hand-checked-2026-09-14");
          if (!decisions.has(id)) {
            newDecisions.push({
              recordId: id,
              slug: official.slug,
              decision: "confirmed",
              evidence: `${SPOT_CHECK_DECIDER}, Sept. 14, 2026, hand-checked against the PDF (${SPOT_CHECK_FILE}, seed 20260914): page ${spotRow.page}, printed row ${spotRow.row}, ${spotRow.description} | ${spotRow.type} | ${spotRow.date} | ${spotRow.amount} match the page`,
              decidedBy: SPOT_CHECK_DECIDER,
              decidedAt: SPOT_CHECK_DECIDED_AT,
            });
          }
        }
      }

      const complete = programAgree && modelPageReadAgree && rowTracePass && problems.length === 0;
      if (!complete) {
        gaps.push({ slug: official.slug, sourcePage: tx.sourcePage ?? null, sourceRow: tx.sourceRow ?? null, description: tx.description, reason: problems.join(" | ") || "artifacts do not cover this row" });
      }
      if (nameAgree) evidence.push("name-agree");
      if (evidence.length) {
        rows[id] = {
          slug: official.slug,
          sourceUrl: tx.sourceUrl ?? "",
          sourcePage: tx.sourcePage ?? null,
          sourceRow: tx.sourceRow ?? null,
          evidence,
          programAgree: complete && programAgree,
          modelPageReadAgree: complete && modelPageReadAgree,
          secondCompanyAgree: complete && secondCompanyAgree,
          rowTracePass: complete && rowTracePass,
          imageChecked,
          nameAgree,
        };
        if (complete) po.recorded += 1;
        for (const t of evidence) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
      }
    });
  }

  const unmatchedSpot = spot.rows.filter((s) => !spotMatched.has(s));
  if (unmatchedSpot.length) {
    for (const s of unmatchedSpot) console.log(`spot-check row not found as published: ${s.slug} page ${s.page} row ${s.row} ${s.description}`);
    throw new Error(`${unmatchedSpot.length} spot-check rows match no published row`);
  }

  const inputs: Record<string, string> = {
    "audit/plumber-trump.json": `sha256:${sha256(path.join(AUDIT, "plumber-trump.json"))} (${trump.plumberRows} rows)`,
    "audit/model-reads/sonnet-p*.json": `${trump.sonnet.files} chunks, ${trump.sonnet.rows.size} rows`,
    "audit/model-reads/astra-p*.json": `${trump.astra.files} chunks, ${trump.astra.rows.size} rows`,
    "audit/compare-model-reads.json": `sha256:${sha256(path.join(AUDIT, "compare-model-reads.json"))}`,
    "audit/compare-reads.json": `sha256:${sha256(path.join(AUDIT, "compare-reads.json"))}`,
    "audit/trump-visual*.md": `${trump.imagePages.size} pages compared as images`,
    "audit/lane-verify/report.md": `sha256:${sha256(path.join(AUDIT, "lane-verify", "report.md"))}`,
    [`audit/${SPOT_CHECK_FILE}`]: `sha256:${sha256(path.join(AUDIT, SPOT_CHECK_FILE))}; ${spot.result}`,
    "data/meta/row-trace-log.json": `full run ${fullRun.ranAt} at ${fullRun.gitSha ?? "?"}: ${fullRun.result}, ${fullRun.totals.passed} paged rows passed, ${fullRun.totals.located} located`,
  };
  const recorded = Object.values(rows).filter((r) => r.programAgree && r.modelPageReadAgree && r.rowTracePass).length;
  const out: AnnualVerificationLog = {
    version: 1,
    generatedAt: new Date().toISOString(),
    generatedBy: "scripts/record-annual-verification.ts",
    inputs,
    summary: { laneRows, recorded, gaps: gaps.length },
    rows,
    gaps,
  };
  mkdirSync(path.dirname(ANNUAL_VERIFICATION_LOG_PATH), { recursive: true });
  writeFileSync(ANNUAL_VERIFICATION_LOG_PATH, JSON.stringify(out, null, 2) + "\n");

  if (newDecisions.length) {
    const current: { decisions: ReviewDecision[] } = existsSync(REVIEW_DECISIONS_PATH) ? readJson(REVIEW_DECISIONS_PATH) : { decisions: [] };
    current.decisions = [...current.decisions, ...newDecisions];
    writeFileSync(REVIEW_DECISIONS_PATH, JSON.stringify(current, null, 2) + "\n");
  }

  // Report.
  if (before) {
    const laneStates = new Map<string, number>();
    for (const v of Object.values(before.rows)) {
      if (!/278ANNU|278TERM|278ANNTERM/.test(v.sourceUrl ?? "")) continue;
      laneStates.set(v.state, (laneStates.get(v.state) ?? 0) + 1);
    }
    console.log(`before (lane rows in row-verification.json): ${[...laneStates].map(([k, n]) => `${k} ${n}`).join(", ")}`);
  }
  console.log(`lane rows ${laneRows}; evidence complete on ${recorded}; gaps ${gaps.length}`);
  for (const [slug, c] of [...perOfficial].sort()) console.log(`  ${slug.padEnd(22)} ${String(c.recorded).padStart(6)} of ${String(c.lane).padStart(6)}`);
  console.log("evidence tags:");
  for (const [t, n] of [...tagCounts].sort((a, b) => b[1] - a[1])) console.log(`  ${t.padEnd(28)} ${String(n).padStart(6)}`);
  console.log(`spot-check rows matched ${spotMatched.size} of ${spot.rows.length}; new decisions written ${newDecisions.length} (${spot.rows.length - newDecisions.length} already decided)`);
  if (gaps.length) {
    console.log(`gaps (stay single_read):`);
    for (const g of gaps.slice(0, 50)) console.log(`  ${g.slug} p.${g.sourcePage ?? "?"} #${g.sourceRow ?? "?"} ${g.description.slice(0, 50)}: ${g.reason}`);
    if (gaps.length > 50) console.log(`  ... ${gaps.length - 50} more in ${path.relative(process.cwd(), ANNUAL_VERIFICATION_LOG_PATH)}`);
  }
  console.log(`wrote ${path.relative(process.cwd(), ANNUAL_VERIFICATION_LOG_PATH)}. Run pnpm row-verification to apply.`);
}

main();
