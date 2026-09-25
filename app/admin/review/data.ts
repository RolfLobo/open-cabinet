import { existsSync, readFileSync } from "fs";
import path from "path";
import { getOfficialBySlug } from "@/lib/data";
import { overlayParseRecord } from "@/lib/corrections";
import { hashRows, readCrosscheckLog } from "@/lib/crosscheck-log";
import { readGrokAuditLog } from "@/lib/grok-audit";
import { findParseRecord, promptHash } from "@/lib/parse-cache";
import { listOpenReviews, REVIEW_QUEUE_PATH, type ReviewItem } from "@/lib/review-queue";
import {
  locateInParseRecord, readReviewDecisions, readRowVerification, recordIdsFor,
  resetRowVerificationCache, type RowVerification,
} from "@/lib/row-verification";
import { readSecondReadLog } from "@/lib/second-read";
import type { Transaction } from "@/lib/types";
import { DEFAULT_MODEL, EXTRACTION_PROMPT, PARSER_VERSION, SYSTEM_PROMPT } from "@/scripts/parse-pdf";

type LaneDetail = { audit?: string; second?: string; unavailable?: string };
/** A picture of the row as the filing prints it, with where it sits. */
type Strip = { url: string; page: number; row: string };
type CandidateRow = Parameters<typeof locateInParseRecord>[1][number];

export async function loadReviewData() {
  // The exported loader caches within a process; a local CLI rebuild can
  // happen between requests, so read fresh states for this review page.
  resetRowVerificationCache();
  const verification = readRowVerification();
  // Rows a person decides: disputed by a lane (score 0) or held as
  // implausible by a plausibility rule (a weekend trade date, say), which
  // sits at score 2 until someone confirms the filing really prints it.
  const disputed = Object.values(verification?.rows ?? {}).filter((row) => row.score === 0 || row.state === "implausible");
  const held = listOpenReviews();
  const decisions = readReviewDecisions();
  const queue: ReviewItem[] = existsSync(REVIEW_QUEUE_PATH)
    ? JSON.parse(readFileSync(REVIEW_QUEUE_PATH, "utf-8")) : [];
  const crosscheck = readCrosscheckLog();
  const audit = readGrokAuditLog();
  const second = readSecondReadLog();
  const bySlug = new Map<string, RowVerification[]>();
  for (const row of disputed) {
    const rows = bySlug.get(row.slug) ?? [];
    rows.push(row);
    bySlug.set(row.slug, rows);
  }

  const groups = await Promise.all([...bySlug].map(async ([slug, rows]) => {
    const official = await getOfficialBySlug(slug);
    const transactions = official?.transactions ?? [];
    const ids = recordIdsFor(transactions);
    const byId = new Map(ids.map((id, i) => [id, transactions[i]]));
    const details = new Map<Transaction, LaneDetail>();
    const strips = new Map<Transaction, Strip>();
    const urls = new Set(rows.map((row) => byId.get(row.id)?.sourceUrl).filter((url): url is string => !!url));
    for (const url of urls) {
      const filingRows = transactions.filter((row) => row.sourceUrl === url);
      const entry = crosscheck?.entries.findLast((item) => item.slug === slug && item.sourceUrl === url);
      const pdfPath = path.join(process.cwd(), "data", "pdfs", decodeURIComponent(url.split("/").pop() || "filing.pdf"));
      const pdfSha256 = entry?.pdfSha256 ?? null;
      const record = pdfSha256 && existsSync(pdfPath) ? findParseRecord(pdfPath, {
        pdfSha256, sourceUrl: url, parserVersion: PARSER_VERSION,
        promptSha256: promptHash(SYSTEM_PROMPT, EXTRACTION_PROMPT), model: DEFAULT_MODEL,
      }) : null;
      if (!record || !pdfSha256) {
        filingRows.forEach((row) => details.set(row, { unavailable: "Parse record unavailable; lane detail cannot be matched to this published row." }));
        continue;
      }
      // The candidate the lanes were keyed on is the read plus a person's
      // ruled corrections (lib/corrections), not the raw read.
      const candidate = overlayParseRecord(record as Parameters<typeof overlayParseRecord>[0], { sourceUrl: url, pdfSha256 }).transactions;
      const candidateHash = hashRows(candidate);
      const positions = locateInParseRecord(filingRows, candidate as unknown as CandidateRow[]);
      // A filing read page by page can show the row cropped from its page
      // (app/admin/strip, as the ingest review sheet does): the unit that
      // holds the candidate index gives the page and the row's place on it.
      const pageOf = (index: number): { page: number; at: number; of: number } | null => {
        let start = 0;
        for (const unit of record.units ?? []) {
          const end = start + unit.transactions.length;
          if (index < end) return unit.first === unit.last ? { page: unit.first, at: index - start, of: unit.transactions.length } : null;
          start = end;
        }
        return null;
      };
      filingRows.forEach((row, i) => {
        const index = positions[i];
        if (index < 0) {
          details.set(row, { unavailable: "Published row not found in the parse record; lane detail is unavailable." });
          return;
        }
        const place = pageOf(index);
        if (place) {
          strips.set(row, {
            url: `/admin/strip?file=${encodeURIComponent(path.basename(pdfPath))}&page=${place.page}&i=${place.at}&n=${place.of}`,
            page: place.page, row: `${place.at + 1} of ${place.of} on the page`,
          });
        }
        const audited = audit?.filings[url];
        const reread = second?.filings[url];
        const detail: LaneDetail = {};
        const sameCandidate = (lane: { candidateSha256: string; pdfSha256: string; slug: string }) =>
          lane.slug === slug && lane.pdfSha256 === entry?.pdfSha256 &&
          lane.candidateSha256 === entry?.candidateSha256 && lane.candidateSha256 === candidateHash;
        const lineForRow = (lines: string[]) => lines.find((line) => line.startsWith(`row ${index + 1}:`));
        if (audited && sameCandidate(audited)) {
          if (audited.disputedIndexes.includes(index)) detail.audit = lineForRow(audited.differences) ?? "Audit disputed this row; no pageShows detail was saved.";
          else if (audited.notFoundIndexes.includes(index)) detail.audit = "Audit could not find this row on the filing pages.";
          else if (audited.confirmedIndexes.includes(index)) detail.audit = "Audit confirmed this row against the page image.";
        }
        if (reread && sameCandidate(reread)) {
          if (reread.disputedIndexes.includes(index)) detail.second = lineForRow(reread.differences) ?? "Second model disputed this row; no difference line was saved.";
          else if (reread.unreadIndexes.includes(index)) detail.second = "Second model produced no counterpart for this row.";
          else if (reread.agreedIndexes.includes(index)) detail.second = "Second model agreed with this row.";
        }
        if ((audited && !sameCandidate(audited)) || (reread && !sameCandidate(reread))) {
          detail.unavailable = "Some lane detail belongs to a different candidate or PDF and is not shown.";
        }
        details.set(row, detail);
      });
    }
    return {
      slug, name: official?.name ?? slug,
      rows: rows.map((verification) => {
        const transaction = byId.get(verification.id);
        // An annual-lane row has a cropped strip of its printed row under
        // public/evidence; a page-by-page 278-T row is cropped on request.
        // Either way the person compares without opening the whole report.
        const evidence = transaction && transaction.sourcePage && transaction.sourceRow &&
          (transaction.sourceKind === "annual-278e" || transaction.sourceKind === "termination-278e")
          ? `${transaction.sourceKind}-${transaction.sourcePage}-${transaction.sourceRow}.png` : null;
        const strip: Strip | null = transaction && evidence && existsSync(path.join(process.cwd(), "public", "evidence", slug, evidence))
          ? { url: `/evidence/${slug}/${evidence}`, page: transaction.sourcePage!, row: String(transaction.sourceRow) }
          : (transaction && strips.get(transaction)) ?? null;
        return {
          verification, transaction, decision: decisions.get(verification.id), strip,
          detail: transaction ? details.get(transaction) ?? { unavailable: "Parse record unavailable; no source filing is attached to this row." } : null,
        };
      }),
    };
  }));
  return {
    held, groups, disputedCount: disputed.length, verificationAvailable: !!verification,
    decisionCount: decisions.size + queue.filter((item) => item.status === "decided").length,
  };
}
