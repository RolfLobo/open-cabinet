import { readFile } from "fs/promises";
import path from "path";

interface ParsedTransactionsFile {
  count: number;
  transactions: unknown[];
}

interface OfficialData {
  slug: string;
  transactions: unknown[];
}

async function readJson<T>(relativePath: string): Promise<T> {
  const raw = await readFile(path.join(process.cwd(), relativePath), "utf-8");
  return JSON.parse(raw) as T;
}

function assertEqual(actual: number, expected: number, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected.toLocaleString()}, got ${actual.toLocaleString()}`);
  }
  console.log(`PASS ${label}: ${actual.toLocaleString()}`);
}

async function main() {
  const trump = await readJson<OfficialData>("data/officials/trump-donald-j.json");
  const may8Part2 = await readJson<ParsedTransactionsFile>(
    "data/pdfs/Trump, Donald J.-05.08.2026-278T(2).text-parsed.json"
  );
  const fullDataset = await readJson<{
    officialCount: number;
    transactionCount: number;
    historicalCount: number;
    officials: OfficialData[];
  }>("public/data/full-dataset.json");

  assertEqual(may8Part2.count, 3642, "Trump May 8, 2026 part-two parsed count");
  assertEqual(
    may8Part2.transactions.length,
    3642,
    "Trump May 8, 2026 part-two transaction rows"
  );
  // Sep 12, 2026, annual-report lane: Trump's 2026 annual 278e Part 7 adds
  // 21,115 rows (21,285 read, minus the 170 matched one-to-one to a posted
  // 278-T): 8,940 -> 30,055. His 278-T rows are unchanged.
  assertEqual(trump.transactions.length, 30055, "Trump aggregate profile transaction count");
  assertEqual(
    trump.transactions.filter((tx) => (tx as { sourceKind?: string }).sourceKind === undefined).length,
    8940,
    "Trump 278-T transaction count"
  );
  // Aug 22, 2026 ingest: Trump 08.12.2026 filing (+1,051, rows 1-1051 visually
  // reconciled against printed row numbers), Kupor 07.15 + 07.20 (+5)
  assertEqual(fullDataset.officialCount, 40, "Full dataset official count");
  // Sep 6, 2026: re-read applied (Trump 8,940 -> 8,944), Landau/Bisignano and others +10,
  // Chavez-DeRemer name-wrap -1, Dixon duplicate -1, four superseded rows of the
  // Aug 12, 2025 amendment removed (Trump 8,944 -> 8,940): 11,509.
  // Sep 8: three MacGregor rows remain in the export as history; no rows removed.
  // Sep 11: Warsh 08.06 (+5), Ueland 08.06 (+37, new official), McMaster 06.11(1) (+4): 11,555.
  // Sep 12: annual-report lane, +21,248 rows read from 19 annual and
  // termination reports (Trump 21,115; Ueland 56; Bisignano 37; Miran 12;
  // Sonderling 8; Turner 7; McMahon 6; Dixon 4; Bedford 2; Duffy 1): 32,803.
  assertEqual(fullDataset.transactionCount, 32800, "Full dataset counted transaction count");
  assertEqual(fullDataset.historicalCount, 3, "Full dataset historical transaction count");
  assertEqual(fullDataset.officials.reduce((n, o) => n + o.transactions.length, 0), 32803, "Full dataset preserved rows");
  assertEqual(
    fullDataset.officials.reduce(
      (n, o) => n + o.transactions.filter((tx) => (tx as { sourceKind?: string }).sourceKind === undefined).length,
      0
    ),
    // Sep 13: Molinaro's three termination-report rows, parsed by the
    // 278-T pipeline in April, are termination-278e rows now: 11,555 -> 11,552.
    11552,
    "Full dataset 278-T rows"
  );

  const exportedTrump = fullDataset.officials.find((official) => official.slug === "trump-donald-j");
  if (!exportedTrump) {
    throw new Error("Full dataset is missing trump-donald-j");
  }
  assertEqual(
    exportedTrump.transactions.length,
    30055,
    "Full dataset Trump aggregate transaction count"
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
