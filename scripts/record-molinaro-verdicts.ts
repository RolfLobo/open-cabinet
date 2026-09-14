/**
 * One-off (Sep 14, 2026): record Trevor's verdicts on Molinaro's three
 * termination-report rows in the decisions ledger, the same mechanism
 * every human-decided row uses (data/review/decisions.json, applied by
 * scripts/migrate-molinaro-termination.ts and read by the verification
 * builder). Page 5 of the report lists three ETF trades: two dated before
 * his Aug. 2, 2025 confirmation (pre-service) and a Nov. 25, 2025 Genoa
 * Treasury ETF sale (a fund, exempt from the 278-T).
 *
 *   npx tsx scripts/record-molinaro-verdicts.ts
 *
 * Idempotent: a verdict already recorded is left alone. Trevor's Sep 6
 * confirmations of the rows' values stay; the status joins them.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { REVIEW_DECISIONS_PATH, recordIdsFor, type ReviewDecision } from "../lib/row-verification";
import type { OfficialData } from "../lib/types";

const official = JSON.parse(readFileSync("data/officials/molinaro-marcus.json", "utf-8")) as OfficialData;
const ledger = JSON.parse(readFileSync(REVIEW_DECISIONS_PATH, "utf-8")) as { decisions: ReviewDecision[] };
const byId = new Map(ledger.decisions.map((d) => [d.recordId, d]));
const ids = recordIdsFor(official.transactions);
const decidedAt = "2026-09-14T12:00:00.000Z";
let recorded = 0;
official.transactions.forEach((tx, i) => {
  if (tx.sourceKind !== "termination-278e") return;
  const preService = tx.date !== null && tx.date < "2025-08-02";
  const status = preService ? "pre-service" : "exempt";
  const evidence = preService
    ? `Trevor, Sep 14, 2026: termination report page 5, row ${tx.sourceRow}: ${tx.description}, ${tx.type} ${tx.date}, an ETF traded before his Aug. 2, 2025 confirmation (pre-service).`
    : `Trevor, Sep 14, 2026: termination report page 5, row ${tx.sourceRow}: ${tx.description}, ${tx.type} ${tx.date}, a Treasury ETF, a fund (exempt).`;
  const existing = byId.get(ids[i]);
  if (existing) {
    // Trevor confirmed the row's values on Sep 6; the status verdict joins
    // that decision rather than replacing it.
    if (existing.correction?.periodicStatus === status) return;
    existing.correction = { ...(existing.correction ?? {}), periodicStatus: status };
    existing.evidence = `${existing.evidence} ${evidence}`;
  } else {
    ledger.decisions.push({ recordId: ids[i], slug: official.slug, decision: "confirmed", correction: { periodicStatus: status }, evidence, decidedBy: "Trevor", decidedAt });
  }
  recorded += 1;
});
writeFileSync(REVIEW_DECISIONS_PATH, JSON.stringify(ledger, null, 2) + "\n");
console.log(`${recorded} verdict(s) recorded in ${REVIEW_DECISIONS_PATH}`);
