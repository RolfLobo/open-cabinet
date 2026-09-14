/**
 * Row-trace matching: does a published row appear on the PDF page it says
 * it came from?
 *
 * Pure text functions over pdftotext -layout output, ported from the Sep
 * 2026 audit's verifier (scratchpad audit/lane-verify/verify.py) so the
 * same checks run for free, forever, from scripts/validate-row-trace.ts.
 * No model, no network here; the script does the shelling out.
 *
 * Two levels of evidence, as the audit defined them:
 * - page level (the spec): the printed row number at a line start, the
 *   trade date in one of its four M/D/YYYY spellings, and the amount
 *   range's leading dollar figure all appear on the page;
 * - block level (stricter): date, amount, description and type sit inside
 *   the row's own lines, from the line that starts with its number to the
 *   next numbered line. A page-level date check can pass on a shifted date
 *   when another row on the page carries it; the block check is what the
 *   negative controls rely on.
 */

export interface TraceRow {
  description: string;
  type: string;
  date: string | null;
  amount: string | null;
  sourceRow?: number | null;
  sourcePage?: number | null;
}

/** The four ways a filing prints an ISO date: zero-padded or not, per part. */
export function dateForms(iso: string | null | undefined): string[] {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return [];
  const [y, m, d] = iso.split("-");
  const mi = Number(m);
  const di = Number(d);
  const pad = (n: number) => String(n).padStart(2, "0");
  return [...new Set([`${pad(mi)}/${pad(di)}/${y}`, `${mi}/${di}/${y}`, `${pad(mi)}/${di}/${y}`, `${mi}/${pad(di)}/${y}`])].sort();
}

/** "$1,001-$15,000" -> "$1,001": the figure a page must print for the range. */
export function amountLead(amount: string | null | undefined): string | null {
  if (!amount) return null;
  const m = amount.match(/\$[\d,]+/);
  return m ? m[0] : null;
}

/** A line that starts with the printed row number, then a space, then content. */
export function rowTokenRe(row: number): RegExp {
  return new RegExp(`^\\s*${row}\\s+\\S`, "m");
}

const ROW_START = /^\s*(\d+)\s+\S/;
const BLOCK_BREAK = /^\s*(INVESTMENT ACCOUNT|#\s+DESCRIPTION|#\s+Description|OGE Form|Filer)/;

/**
 * Every candidate block for a printed row: the lines from a line that
 * starts with the row number up to the next line that starts with a
 * different number or a table heading. A page can hold the token more than
 * once (a 278-T header wraps to a line beginning "30 DAYS AGO"; a 278e page
 * can print Part 6 row 9 above Part 7 row 9), so all candidates are
 * returned and the caller scores them.
 */
export function rowBlocks(text: string, row: number): string[] {
  const lines = text.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(ROW_START);
    if (!m || Number(m[1]) !== row) continue;
    const block = [lines[i]];
    for (const ln of lines.slice(i + 1)) {
      const m2 = ln.match(ROW_START);
      if (m2 && Number(m2[1]) !== row) break;
      if (BLOCK_BREAK.test(ln)) break;
      block.push(ln);
    }
    out.push(block.join("\n"));
  }
  return out;
}

/** Upper-case, every non-alphanumeric run to one space. */
export function norm(s: string | null | undefined): string {
  return (s ?? "").toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
}

/**
 * Python's difflib ratio, 2*matches/total, over the longest common
 * subsequence. Good enough for "is this line the same asset name with a
 * wrap or an OCR slip", which is all it is used for.
 */
export function similarity(a: string, b: string): number {
  if (!a.length && !b.length) return 1;
  if (!a.length || !b.length) return 0;
  const prev = new Array<number>(b.length + 1).fill(0);
  const cur = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j];
  }
  return (2 * prev[b.length]) / (a.length + b.length);
}

/** The description, or its first 24 characters, inside the block; else a
 * line of the block at 0.8 similarity or better. */
export function descMatch(desc: string, block: string): boolean {
  const a = norm(desc);
  const b = norm(block);
  if (!a) return false;
  if (b.includes(a) || b.replace(/ /g, "").includes(a.replace(/ /g, ""))) return true;
  if (b.includes(a.slice(0, 24))) return true;
  let best = 0;
  for (const ln of block.split("\n")) best = Math.max(best, similarity(a, norm(ln)));
  return best >= 0.8;
}

export interface PageVerdict {
  /** null when the row carries no printed row number to look for. */
  row: boolean | null;
  date: boolean | null;
  amount: boolean | null;
}

/** The spec check: row token at a line start, a date form, the amount lead. */
export function inPage(text: string, tx: TraceRow): PageVerdict {
  const row = tx.sourceRow == null ? null : rowTokenRe(tx.sourceRow).test(text);
  const forms = dateForms(tx.date);
  const date = tx.date ? forms.some((f) => text.includes(f)) : null;
  const lead = amountLead(tx.amount);
  const amount = lead ? text.includes(lead) : null;
  return { row, date, amount };
}

export interface BlockVerdict {
  block: boolean;
  date?: boolean | null;
  amount?: boolean | null;
  desc?: boolean;
  type?: boolean;
}

/** Stricter: date, amount lead, description and type inside the row's own
 * block. Null when the row has no printed row number. */
export function inBlock(text: string, tx: TraceRow): BlockVerdict | null {
  if (tx.sourceRow == null) return null;
  const blocks = rowBlocks(text, tx.sourceRow);
  if (blocks.length === 0) return { block: false };
  let best: { score: number; v: BlockVerdict } | null = null;
  for (const blk of blocks) {
    const lead = amountLead(tx.amount);
    const v: BlockVerdict = {
      block: true,
      date: tx.date ? dateForms(tx.date).some((f) => blk.includes(f)) : null,
      amount: lead ? blk.includes(lead) : null,
      desc: descMatch(tx.description, blk),
      type: blk.toLowerCase().includes((tx.type ?? "").split(" ")[0].toLowerCase()),
    };
    const score = ["date", "amount", "desc", "type"].filter((k) => v[k as keyof BlockVerdict]).length;
    if (!best || score > best.score) best = { score, v };
  }
  return best!.v;
}

/**
 * Whether a document has a text layer to search: the median page carries
 * real text. A scanned filing yields OGE's stamp text or nothing (median
 * page 0 characters; a typed cover page does not move the median), and a
 * search in it proves nothing either way.
 */
export function hasTextLayer(pages: string[]): boolean {
  if (pages.length === 0) return false;
  const lengths = pages.map((t) => t.trim().length).sort((a, b) => a - b);
  return lengths[Math.floor(lengths.length / 2)] >= 500;
}

/** pdftotext puts a form feed between pages; the split is trusted only
 * when it yields the page count pdfinfo reports. */
export function splitPages(text: string, pageCount: number | null): string[] | null {
  const parts = text.split("\f");
  if (parts.length && parts[parts.length - 1] === "") parts.pop();
  if (pageCount !== null && parts.length !== pageCount) return null;
  return parts;
}

/**
 * For a row with no page: the first page whose row block carries the date,
 * the amount and the description. Null when none does.
 */
export function locateInPages(pages: string[], tx: TraceRow): number | null {
  const lead = amountLead(tx.amount);
  const forms = dateForms(tx.date);
  for (let i = 0; i < pages.length; i++) {
    const t = pages[i];
    if (lead && !t.includes(lead)) continue;
    if (forms.length && !forms.some((f) => t.includes(f))) continue;
    if (tx.sourceRow == null) {
      // No printed row number to anchor on: the description must be on the
      // page with the date and amount.
      if (descMatch(tx.description, t)) return i + 1;
      continue;
    }
    const b = inBlock(t, tx);
    if (b && b.block && b.date && b.amount && b.desc) return i + 1;
  }
  return null;
}

/** The three mutations the negative controls apply to a real row. */
export function controlMutations(tx: TraceRow): { dateShift: TraceRow; rowShift: TraceRow; descSwap: TraceRow } {
  const [y, m, d] = (tx.date ?? "2025-01-01").split("-");
  const shifted = `${y}-${m}-${String((Number(d) % 28) + 1).padStart(2, "0")}`;
  return {
    dateShift: { ...tx, date: shifted },
    rowShift: { ...tx, sourceRow: (tx.sourceRow ?? 0) + 5000 },
    descSwap: { ...tx, description: "ZZZ NOT A REAL ASSET QQQ" },
  };
}

export type ControlOutcome = "caught" | "uncaught" | "not-evaluable";

/** Whether the checks reject each mutation of a row that itself passed. */
export function runControls(text: string, tx: TraceRow): { dateShift: ControlOutcome; rowShift: ControlOutcome; descSwap: ControlOutcome } {
  const m = controlMutations(tx);
  const b1 = inBlock(text, m.dateShift);
  const dateShift: ControlOutcome = !b1 || !b1.block ? "not-evaluable" : b1.date === false ? "caught" : "uncaught";
  const rowShift: ControlOutcome = tx.sourceRow == null ? "not-evaluable" : inPage(text, m.rowShift).row === false ? "caught" : "uncaught";
  const b3 = inBlock(text, m.descSwap);
  const descSwap: ControlOutcome = !b3 || !b3.block ? "not-evaluable" : b3.desc === false ? "caught" : "uncaught";
  return { dateShift, rowShift, descSwap };
}

/** Deterministic PRNG (mulberry32) so a seeded sample is the same sample. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates over a copy, with the seeded generator. */
export function seededSample<T>(items: T[], n: number, seed: number): T[] {
  const rnd = seededRandom(seed);
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, Math.min(n, copy.length));
}
