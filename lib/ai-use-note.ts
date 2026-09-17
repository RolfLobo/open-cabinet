/**
 * The one sentence that says how rows are made, worded once and used
 * everywhere it appears: above every trade table, on the overview pages,
 * in the download page, at the top of the CSV, as a field in the JSON
 * export and in the digest email footer. Change it here and it changes
 * everywhere. app/components/ai-use-note.tsx renders it with the links.
 */
export const AI_USE_NOTE =
  "Rows are extracted from OGE filings by automated parsing (Claude PDF reading, PDF-parser and OCR cross-checks) and reviewed by a mix of software and human checks; the status on each row says which. Open the source PDF to confirm any row, and tell us if something is wrong.";

export const AI_USE_METHODOLOGY_PATH = "/methodology#verification";
export const AI_USE_FEEDBACK_PATH = "/about#feedback";

/** Plain-text form with the two links spelled out, for the CSV comment,
 * the JSON field and the email. */
export function aiUseNoteText(origin = "https://open-cabinet.org"): string {
  return `${AI_USE_NOTE} How rows are checked: ${origin}${AI_USE_METHODOLOGY_PATH}. Report an error: ${origin}${AI_USE_FEEDBACK_PATH}.`;
}

/** Wording next to a row's "Not yet checked" mark. */
export const NOT_YET_CHECKED_EXPLAINER = "extracted by software, not yet confirmed by a person; the PDF link goes to the page";
