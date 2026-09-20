import { mkdir, readdir, readFile, writeFile } from "fs/promises";
import path from "path";

export const OGE_API_BASE =
  "https://extapps2.oge.gov/201/Presiden.nsf/API.xsp/v2/rest";

export const MIN_DOC_DATE = "2025-02-01";

const NAME_ALIASES: Record<string, string> = {
  "Trump, Donald J": "Trump, Donald J.",
  "Wright, Christopher A": "Wright, Christopher",
  "McMahon, Linda E": "McMahon, Linda",
  "Sonderling, Keith": "Sonderling, Keith E",
  "Lawrence, Paul": "Lawrence, Paul R",
  "Miran, Stephen": "Miran, Stephen I",
};

export interface OGERecord {
  type: string;
  name: string;
  agency: string;
  title: string;
  level: string;
  docDate: string;
  amended?: string;
}

export interface TargetFiling {
  name: string;
  pdfUrl: string;
  docDate: string;
  agency?: string;
  title?: string;
  level?: string;
  /** OGE's "amended" field when set, or "filename" when the PDF name says
   * AMENDED. An amendment replaces line items of an earlier report; the
   * ingest holds it for a person (Trevor, Sep 6). */
  amended?: string;
}

export interface LastCheckFile {
  lastChecked: string;
  knownFilings?: Record<string, number>;
  knownFilingsByOfficial?: Record<string, number>;
  knownFilingUrls?: string[];
  newFilings?: Array<TargetFiling & { status: string }>;
  /** Annual and termination reports of tracked officials seen by the
   * monitor. Reported, never auto-ingested. */
  knownReportUrls?: string[];
  newReports?: Array<TargetFiling & { kind: string; status: string }>;
}

export function canonicalName(name: string): string {
  return NAME_ALIASES[name] ?? name;
}

export function extractPdfUrl(typeField: string): string | null {
  const match = typeField.match(/href=["']([^"']+\.pdf)["']/i);
  if (!match) return null;

  const url = match[1];
  if (url.startsWith("http")) return url;
  return new URL(url, OGE_API_BASE).toString();
}

export function is278T(typeField: string): boolean {
  return (
    /278\s+Transaction/i.test(typeField) ||
    /278[\s-]*T(?!ERM)(?:\b|\()/i.test(typeField)
  );
}

/** The President and Vice President carry level "n/a" in OGE's index
 * (they sit outside the Executive Schedule), so they are named here. */
const NAMED_FILERS = new Set(["Trump, Donald J", "Trump, Donald J.", "Vance, JD", "Vance, J.D."]);

export function isTargetLevel(record: OGERecord): boolean {
  if (record.level === "Level I" || record.level === "Level II") return true;
  return NAMED_FILERS.has(record.name);
}

/**
 * An annual or termination 278e with a downloadable PDF. The index labels
 * them "Annual (2026)", "Termination" and "Annual Term"; request-only
 * entries carry "(Request this Document)" and no PDF, and are excluded by
 * the PDF check in getTargetReports.
 */
export function isAnnualOrTermination(typeField: string): "annual-278e" | "termination-278e" | null {
  const label = typeField.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  if (/^Termination\b/i.test(label) || /^Annual Term\b/i.test(label)) return "termination-278e";
  if (/^Annual \(\d{4}\)/i.test(label)) return "annual-278e";
  return null;
}

export interface TargetReport extends TargetFiling {
  kind: "annual-278e" | "termination-278e";
}

/**
 * Posted annual and termination reports of tracked officials, for the
 * monitor to report separately from 278-Ts. Nothing here is ingested by
 * the weekly job: the annual-report lane (scripts/ingest-annual-reports.ts)
 * runs on a person's decision, after the audit steps that lane documents.
 */
export function getTargetReports(records: OGERecord[], trackedNames: Set<string>): TargetReport[] {
  const byUrl = new Map<string, TargetReport>();
  for (const record of records) {
    const name = canonicalName(record.name);
    if (!trackedNames.has(name)) continue;
    const kind = isAnnualOrTermination(record.type);
    if (!kind) continue;
    if (!isInScope(record.docDate)) continue;
    const pdfUrl = extractPdfUrl(record.type);
    if (!pdfUrl) continue;
    byUrl.set(pdfUrl, {
      name,
      pdfUrl,
      docDate: record.docDate,
      agency: record.agency,
      title: record.title,
      level: record.level,
      amended: amendedFlag(record, pdfUrl),
      kind,
    });
  }
  return Array.from(byUrl.values()).sort((a, b) => b.docDate.localeCompare(a.docDate) || a.name.localeCompare(b.name));
}

function isInScope(docDate: string): boolean {
  return docDate.slice(0, 10) >= MIN_DOC_DATE;
}

async function fetchJsonWithTimeout(url: string, timeoutMs: number) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      cache: "no-store",
      signal: controller.signal,
      headers: { "User-Agent": "OpenCabinet/1.0" },
    });
    if (!res.ok) {
      throw new Error(`OGE API returned HTTP ${res.status}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJsonWithRetries(url: string, timeoutMs: number) {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      return await fetchJsonWithTimeout(url, timeoutMs);
    } catch (err) {
      lastError = err as Error;
      if (attempt === 4) break;
      await new Promise((resolve) => setTimeout(resolve, attempt * 3000));
    }
  }

  throw lastError || new Error(`Failed to fetch ${url}`);
}

export async function fetchOgeRecords({
  pageSize = 1000,
  delayMs = 2000,
  timeoutMs = 30000,
  log,
}: {
  pageSize?: number;
  delayMs?: number;
  timeoutMs?: number;
  log?: (message: string) => void;
} = {}): Promise<{ records: OGERecord[]; totalRecords: number }> {
  let allRecords: OGERecord[] = [];
  let start = 0;
  let totalRecords: number | null = null;

  while (true) {
    const url = `${OGE_API_BASE}?start=${start}&length=${pageSize}`;
    log?.(`Fetching OGE records ${start}...`);
    const data = await fetchJsonWithRetries(url, timeoutMs);

    if (!Array.isArray(data.data)) {
      throw new Error("OGE API response did not include a data array");
    }

    const pageTotal = Number(data.recordsTotal ?? 0);
    if (start === 0) {
      if (pageTotal <= 0) {
        throw new Error("OGE API returned zero records");
      }
      totalRecords = pageTotal;
    }

    if (data.data.length === 0) {
      if (start === 0 || (totalRecords !== null && start < totalRecords)) {
        throw new Error(
          `OGE API returned an empty page before all records were fetched (start=${start})`
        );
      }
      break;
    }

    allRecords = allRecords.concat(data.data as OGERecord[]);
    start += pageSize;

    if (totalRecords !== null && start >= totalRecords) break;
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  if (allRecords.length === 0) {
    throw new Error("OGE API returned no usable records");
  }

  return { records: allRecords, totalRecords: totalRecords ?? allRecords.length };
}

/**
 * Every filing in the index with a PDF, no level, date or form filter:
 * the set to reconcile our published filings against. A former
 * official's 2023 report is out of scope for ingest but still published,
 * and "gone from OGE" must mean gone, not filtered.
 */
export function getAllIndexedFilings(records: OGERecord[]): TargetFiling[] {
  const byUrl = new Map<string, TargetFiling>();
  for (const record of records) {
    const pdfUrl = extractPdfUrl(record.type);
    if (!pdfUrl) continue;
    byUrl.set(pdfUrl, { name: canonicalName(record.name), pdfUrl, docDate: record.docDate, agency: record.agency, title: record.title, level: record.level, amended: amendedFlag(record, pdfUrl) });
  }
  return Array.from(byUrl.values());
}

/** The amendment signal for a record: OGE's field, or the file name. */
export function amendedFlag(record: Pick<OGERecord, "amended">, pdfUrl: string): string | undefined {
  const flag = (record.amended ?? "").trim();
  if (flag) return flag;
  if (/amend/i.test(decodeURIComponent(pdfUrl.split("/").pop() ?? ""))) return "filename";
  return undefined;
}

export function getTargetFilings(records: OGERecord[]): TargetFiling[] {
  const byUrl = new Map<string, TargetFiling>();

  for (const record of records) {
    if (!isTargetLevel(record)) continue;
    if (!is278T(record.type)) continue;
    if (!isInScope(record.docDate)) continue;

    const pdfUrl = extractPdfUrl(record.type);
    if (!pdfUrl) continue;

    byUrl.set(pdfUrl, {
      name: canonicalName(record.name),
      pdfUrl,
      docDate: record.docDate,
      agency: record.agency,
      title: record.title,
      level: record.level,
      amended: amendedFlag(record, pdfUrl),
    });
  }

  return Array.from(byUrl.values()).sort((a, b) => {
    const dateOrder = b.docDate.localeCompare(a.docDate);
    if (dateOrder !== 0) return dateOrder;
    return a.name.localeCompare(b.name);
  });
}

export function countByOfficial(filings: TargetFiling[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const filing of filings) {
    counts[filing.name] = (counts[filing.name] || 0) + 1;
  }
  return counts;
}

export function diffNewFilings<T extends TargetFiling>(
  filings: T[],
  knownUrls: Set<string>
): T[] {
  // URL serialization encodes literal spaces. OGE and saved source entries
  // sometimes spell the same PDF URL differently (" " versus "%20").
  const known = new Set(Array.from(knownUrls, (url) => new URL(url).href));
  return filings.filter((filing) => !known.has(new URL(filing.pdfUrl).href));
}

/** Successfully saved filings, including accepted filings with zero new rows.
 * Discovery/download state is deliberately excluded. Missing or malformed
 * official data must stop ingestion rather than make every URL look new. */
export async function loadImportedFilingUrls(root = process.cwd()): Promise<Set<string>> {
  const filings = await loadKnownFilingsFromData(root);
  return new Set(filings.map((filing) => filing.url));
}

/** Monitor baseline: URLs previously discovered or already in official data.
 * This suppresses repeated discovery notices, not ingestion attempts. */
export async function loadDiscoveredFilingUrls(
  root = process.cwd()
): Promise<Set<string>> {
  const urls = new Set<string>();

  const officialsDir = path.join(root, "data", "officials");
  try {
    const files = await readdir(officialsDir);
    for (const file of files.filter((name) => name.endsWith(".json"))) {
      const raw = await readFile(path.join(officialsDir, file), "utf-8");
      const official = JSON.parse(raw) as {
        sourceFilings?: Array<{ url?: string }>;
      };
      for (const filing of official.sourceFilings || []) {
        if (filing.url) urls.add(filing.url);
      }
    }
  } catch {
    // Production cron can still rely on last-check state if data files are absent.
  }

  const lastCheckPath = path.join(root, "data", "meta", "last-check.json");
  try {
    const lastCheck = JSON.parse(
      await readFile(lastCheckPath, "utf-8")
    ) as LastCheckFile;

    for (const url of lastCheck.knownFilingUrls || []) {
      urls.add(url);
    }

    for (const key of Object.keys(lastCheck.knownFilings || {})) {
      if (key.startsWith("http")) urls.add(key);
    }

    for (const filing of lastCheck.newFilings || []) {
      if (filing.pdfUrl) urls.add(filing.pdfUrl);
    }
    for (const url of lastCheck.knownReportUrls || []) urls.add(url);
    for (const report of lastCheck.newReports || []) {
      if (report.pdfUrl) urls.add(report.pdfUrl);
    }
  } catch {
    // First run or missing local state.
  }

  return urls;
}

export async function writeLastCheckState({
  root = process.cwd(),
  filings,
  newFilings,
  reports,
  newReports,
}: {
  root?: string;
  filings: TargetFiling[];
  newFilings: Array<TargetFiling & { status: string }>;
  /** Annual and termination reports of tracked officials (the monitor's
   * separate list). Omitted by callers that do not look for them. */
  reports?: TargetReport[];
  newReports?: Array<TargetFiling & { kind: string; status: string }>;
}) {
  const lastCheckPath = path.join(root, "data", "meta", "last-check.json");
  await mkdir(path.dirname(lastCheckPath), { recursive: true });
  // A caller that did not look for reports keeps the previous list, so a
  // cron run cannot make every annual report look new to the next weekly check.
  let previousReports: Pick<LastCheckFile, "knownReportUrls" | "newReports"> = {};
  if (!reports) {
    try {
      const prev = JSON.parse(await readFile(lastCheckPath, "utf-8")) as LastCheckFile;
      previousReports = { knownReportUrls: prev.knownReportUrls, newReports: prev.newReports };
    } catch {
      // First run.
    }
  }
  const state: LastCheckFile = {
    lastChecked: new Date().toISOString(),
    knownFilingUrls: filings.map((filing) => filing.pdfUrl).sort(),
    knownFilingsByOfficial: countByOfficial(filings),
    newFilings,
    ...(reports
      ? { knownReportUrls: reports.map((r) => r.pdfUrl).sort(), newReports: newReports ?? [] }
      : previousReports),
  };

  await writeFile(lastCheckPath, JSON.stringify(state, null, 2) + "\n");
}

/**
 * Filings we publish that OGE's index no longer lists, or lists under a
 * different posting date. diffNewFilings only ever sees additions; a
 * filing OGE deletes (MacGregor's 2020 reports, found by hand Sep 6, 2026)
 * or re-posts simply stops matching and nobody hears. Compare by decoded
 * URL, the same way the addition check does. Read-only: the caller decides
 * what to do; this never removes a row.
 */
export function reconcileKnownFilings(
  index: TargetFiling[],
  known: Array<{ url: string; date: string }>
): { missing: Array<{ url: string; date: string }>; redated: Array<{ url: string; date: string; indexDate: string }> } {
  const decode = (u: string) => { try { return decodeURIComponent(u); } catch { return u; } };
  const byUrl = new Map(index.map((f) => [decode(f.pdfUrl), f] as const));
  const missing: Array<{ url: string; date: string }> = [];
  const redated: Array<{ url: string; date: string; indexDate: string }> = [];
  for (const k of known) {
    const f = byUrl.get(decode(k.url));
    if (!f) { missing.push(k); continue; }
    const indexDate = f.docDate.slice(0, 10);
    if (k.date && k.date.slice(0, 10) !== indexDate) redated.push({ ...k, indexDate });
  }
  return { missing, redated };
}

/** Every published filing with its stored posting date, for reconciliation. */
export async function loadKnownFilingsFromData(root = process.cwd()): Promise<Array<{ url: string; date: string; slug: string }>> {
  const out: Array<{ url: string; date: string; slug: string }> = [];
  const officialsDir = path.join(root, "data", "officials");
  const files = await readdir(officialsDir);
  for (const file of files.filter((name) => name.endsWith(".json"))) {
    const official = JSON.parse(await readFile(path.join(officialsDir, file), "utf-8")) as { slug: string; sourceFilings?: Array<{ url?: string; date?: string }> };
    for (const f of official.sourceFilings || []) if (f.url) out.push({ url: f.url, date: f.date ?? "", slug: official.slug });
  }
  return out;
}

// ── Monitor resilience ──────────────────────────────────────────────────
// OGE's portal has two known bad moods: it refuses connections outright for a
// while (Sept 14 and Sept 20, 2026, both at the 10:00 UTC slot), and it
// sometimes returns the full record count with some rows' type/level fields
// blanked (Aug 11, Aug 13 and Sept 19, 2026). The helpers below let the cron
// route tell those apart from real news.

/** Node's fetch reports network failures as a bare "fetch failed" TypeError
 * with the real reason (ECONNRESET, ETIMEDOUT, ENOTFOUND, a TLS error) hidden
 * on `cause`. Surface the whole chain so a failure email is diagnosable. */
export function describeFetchError(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;
  for (let depth = 0; current && depth < 5; depth++) {
    const e = current as { message?: string; code?: string; name?: string; cause?: unknown };
    const label = [e.name && e.name !== "Error" ? e.name : "", e.code ? `[${e.code}]` : "", e.message ?? String(current)]
      .filter(Boolean)
      .join(" ");
    if (label && !parts.includes(label)) parts.push(label);
    current = e.cause;
  }
  return parts.join(" <- ") || "Unknown error";
}

/** A tracked count that drops sharply between two consecutive runs means the
 * index came back with rows stripped, not that filings were removed. OGE does
 * not un-post dozens of 278-Ts in four hours; it did return 92 targets at
 * 10:00 UTC and 124 at 14:00 UTC on Sept 19, 2026. */
export function indexLooksIncomplete(currentTargets: number, previousTargets: number | null | undefined): boolean {
  if (typeof previousTargets !== "number" || !Number.isFinite(previousTargets) || previousTargets <= 0) return false;
  return currentTargets < previousTargets * 0.95;
}

/** The last cron slot of the day (vercel.json). A failure before it has a
 * retry coming; a failure at or after it does not. */
export const LAST_CRON_SLOT_UTC_HOUR = 14;

export function retrySlotPending(now: Date = new Date()): boolean {
  return now.getUTCHours() < LAST_CRON_SLOT_UTC_HOUR;
}
