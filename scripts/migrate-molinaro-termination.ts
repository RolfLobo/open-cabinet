/**
 * One-off migration (Sep 13, 2026): Molinaro's three rows and his one
 * source filing come from his termination 278e, which the 278-T pipeline
 * parsed in April 2026 as if it were a periodic report. They carried no
 * sourceKind, so they defaulted to "278-T", sat in the late-share
 * denominator (the termination form has no late column), and the report
 * URL was eligible for the digest's notified-filings ledger.
 *
 *   npx tsx scripts/migrate-molinaro-termination.ts [--inputs <dir>]
 *   then pnpm rebuild-index && pnpm row-verification && pnpm generate-exports
 *
 * Sets sourceKind "termination-278e", lateFilingFlag null and the report
 * kind. The status starts as "unresolved" and is then set from the
 * decisions ledger (data/review/decisions.json): Trevor's Sep 14, 2026
 * verdicts make the two trades before his Aug. 2, 2025 confirmation
 * "pre-service" and the Nov. 25, 2025 Treasury-ETF sale "exempt". Because
 * the ledger is read on every run, a re-run cannot revert them. With
 * --inputs pointing at
 * the audit scratchpad, each row is paired with the audit's read of the
 * same report by date, type and amount and given its physical page and
 * printed row number from the page map. Values of the rows themselves
 * are not touched. Idempotent.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readReviewDecisions, recordIdsFor } from "../lib/row-verification";
import type { OfficialData } from "../lib/types";

const SLUG = "molinaro-marcus";
const STEM = "molinaro-marcus__termination__2026-04-10";
const args = process.argv.slice(2);
const inputs = args[args.indexOf("--inputs") + 1] && args.includes("--inputs") ? args[args.indexOf("--inputs") + 1] : process.env.ANNUAL_LANE_INPUTS;

const file = path.resolve("data", "officials", `${SLUG}.json`);
const official = JSON.parse(readFileSync(file, "utf-8")) as OfficialData;
const termination = (official.sourceFilings ?? []).find((f) => /278TERM/i.test(f.url ?? ""));
if (!termination?.url) throw new Error("no termination report among the source filings");

let pageMap: Map<string, { page: number; row: number }> | null = null;
if (inputs) {
  const readPath = path.join(inputs, "audit", "read-a", `${STEM}.json`);
  const mapPath = path.join(inputs, "audit", "lane-pages", `${STEM}.json`);
  if (existsSync(readPath) && existsSync(mapPath)) {
    const read = JSON.parse(readFileSync(readPath, "utf-8")) as { rows: Array<{ row: number; type: string; date: string; amount: string }> };
    const map = JSON.parse(readFileSync(mapPath, "utf-8")) as { rows: Array<{ index: number; page: number }> };
    pageMap = new Map();
    for (const m of map.rows) {
      const r = read.rows[m.index];
      const [mm, dd, yyyy] = r.date.split("/");
      const key = `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}|${r.type}|${r.amount.replace(/\s*-\s*/, "-")}`;
      pageMap.set(key, { page: m.page, row: r.row });
    }
  }
}

let migrated = 0;
for (const tx of official.transactions) {
  if (tx.sourceUrl !== termination.url) continue;
  tx.sourceKind = "termination-278e";
  tx.lateFilingFlag = null;
  tx.periodicStatus = "unresolved";
  const located = pageMap?.get(`${tx.date}|${tx.type}|${tx.amount}`);
  if (located) {
    tx.sourcePage = located.page;
    tx.sourceRow = located.row;
  }
  migrated += 1;
}
termination.kind = "termination-278e";
// Recorded human verdicts win over the migration's default. Record ids
// are computed after the migration fields are set, which is how the
// ledger keyed them.
const decisions = readReviewDecisions();
const ids = recordIdsFor(official.transactions);
let decided = 0;
official.transactions.forEach((tx, i) => {
  const d = decisions.get(ids[i]);
  if (d && d.decision !== "rejected" && d.correction?.periodicStatus) {
    tx.periodicStatus = d.correction.periodicStatus;
    decided += 1;
  }
});
writeFileSync(file, JSON.stringify(official, null, 2) + "\n");
console.log(`${decided} row(s) took a recorded verdict from data/review/decisions.json`);
console.log(`${SLUG}: ${migrated} rows now termination-278e (late flag null, status unresolved); filing kind set${pageMap ? "; pages from the audit's page map" : ""}`);
