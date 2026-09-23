"use server";

import path from "path";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { applyCorrections, confirmRead, proposeCorrection, readCorrections, ruleCorrection, withdrawCorrection, type CorrectableField } from "@/lib/corrections";
import { hashRows } from "@/lib/crosscheck-log";
import { findParseRecord, promptHash, sha256File } from "@/lib/parse-cache";
import { decideReview, mergeDecisionMarker, listOpenReviews } from "@/lib/review-queue";
import { DEFAULT_MODEL, EXTRACTION_PROMPT, PARSER_VERSION, SYSTEM_PROMPT } from "@/scripts/parse-pdf";
import { requireLocalReview } from "../../local-only";

const WHO = "Trevor Brown";
const FIELDS: CorrectableField[] = ["type", "date", "amount", "lateFilingFlag", "description", "ticker"];

function back(id: string, key: "message" | "error", text: string, show?: string): never {
  const params = new URLSearchParams({ [key]: text });
  if (show) params.set("show", show);
  redirect(`/admin/review/filing/${encodeURIComponent(id)}?${params}`);
}
function text(form: FormData, name: string): string {
  const v = form.get(name);
  return typeof v === "string" ? v.trim() : "";
}
function parseValue(field: CorrectableField, raw: string): unknown {
  if (field === "lateFilingFlag") return raw === "true";
  if (field === "ticker" && raw === "") return null;
  if (field === "amount" && (raw === "" || raw === "null")) return null;
  return raw;
}

/** Rule on one row: apply a proposal, confirm the read, or record a typed value. */
export async function ruleRow(form: FormData): Promise<void> {
  await requireLocalReview();
  const id = text(form, "id"), show = text(form, "show") || undefined;
  const action = text(form, "action");
  const note = text(form, "note");
  try {
    if (action === "rule") {
      const c = ruleCorrection(text(form, "correctionId"), WHO, note || undefined);
      revalidatePath(`/admin/review/filing/${id}`);
      back(id, "message", `Ruled: row ${c.printedRow ?? c.position} ${c.field} is now ${JSON.stringify(c.corrected)}.`, show);
    }
    const base = {
      slug: text(form, "slug"), sourceUrl: text(form, "sourceUrl"), pdfSha256: text(form, "pdfSha256"),
      position: Number(text(form, "position")), page: text(form, "page") ? Number(text(form, "page")) : null,
      printedRow: text(form, "printedRow") ? Number(text(form, "printedRow")) : null,
    };
    const field = text(form, "field") as CorrectableField;
    if (!FIELDS.includes(field) || !Number.isInteger(base.position)) back(id, "error", "Bad row or field.", show);
    const original = JSON.parse(text(form, "original") || "null");
    if (action === "confirm") {
      confirmRead({ ...base, field, original, evidence: note || "Confirmed against the page strip in the review sheet.", proposedBy: WHO, ruledBy: WHO });
      revalidatePath(`/admin/review/filing/${id}`);
      back(id, "message", `Confirmed: row ${base.printedRow ?? base.position} ${field} stands as read.`, show);
    }
    if (action === "correct") {
      const corrected = parseValue(field, text(form, "corrected"));
      const c = proposeCorrection({ ...base, field, original, corrected, evidence: note || "Set from the page strip in the review sheet.", proposedBy: WHO });
      ruleCorrection(c.id, WHO, note || undefined);
      revalidatePath(`/admin/review/filing/${id}`);
      back(id, "message", `Corrected: row ${base.printedRow ?? base.position} ${field} ${JSON.stringify(original)} -> ${JSON.stringify(corrected)}.`, show);
    }
    if (action === "withdraw") {
      withdrawCorrection(text(form, "correctionId"), WHO, note || "withdrawn in the review sheet");
      revalidatePath(`/admin/review/filing/${id}`);
      back(id, "message", "Withdrawn.", show);
    }
  } catch (e) {
    if ((e as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) throw e;
    back(id, "error", (e as Error).message, show);
  }
  back(id, "error", "Unknown action.", show);
}

/** Every dispute has a ruling: record the filing decision the gate honours.
 * The marker ties the decision to the exact candidate rows (the read plus
 * the rulings), computed the same way the ingest computes them. */
export async function decideFiling(form: FormData): Promise<void> {
  await requireLocalReview();
  const id = text(form, "id");
  const note = text(form, "note");
  try {
    const item = listOpenReviews().find((i) => i.id === id);
    if (!item?.filing.url || !item.filing.pdfFile) back(id, "error", "This item is not open.");
    const pdfPath = path.join(process.cwd(), "data", "pdfs", path.basename(item.filing.pdfFile));
    const sha = sha256File(pdfPath);
    // The same candidate the ingest builds: the cached read plus ruled
    // corrections (lib/ingest-stages readFiling). No model is called here;
    // a missing cache is an error, never a paid parse.
    const record = findParseRecord(pdfPath, { pdfSha256: sha, sourceUrl: item.filing.url, parserVersion: PARSER_VERSION, promptSha256: promptHash(SYSTEM_PROMPT, EXTRACTION_PROMPT), model: DEFAULT_MODEL });
    if (!record) back(id, "error", "No parse record on disk for this filing; run the ingest first.");
    const overlay = applyCorrections(record.transactions as Array<Record<string, unknown>>, { sourceUrl: item.filing.url, pdfSha256: sha }, readCorrections().corrections);
    if (overlay.skipped.length) back(id, "error", `Corrections could not be applied: ${overlay.skipped.map((s) => s.reason).join("; ")}`);
    const rows = overlay.rows;
    const marker = mergeDecisionMarker(hashRows(rows));
    const decision = `${note || "Every disputed row ruled in the review sheet; publish the read plus the rulings."} (${rows.length} rows; ${new Date().toISOString().slice(0, 10)}) ${marker}`;
    if (!decideReview(id, decision, WHO)) back(id, "error", "This item is no longer open.");
    revalidatePath("/admin/review");
    back(id, "message", `Decision recorded for ${rows.length} rows. Run: pnpm ingest-filings`);
  } catch (e) {
    if ((e as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) throw e;
    back(id, "error", (e as Error).message);
  }
}
