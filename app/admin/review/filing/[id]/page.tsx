import type { Metadata } from "next";
import Link from "next/link";
import { Fragment } from "react";
import { decideFiling, ruleRow } from "./actions";
import { loadFilingSheet } from "./data";
import { requireLocalReview } from "../../local-only";
import type { SheetRow } from "@/lib/review-sheet";
import { COMPARED_FIELDS } from "@/lib/review-sheet";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const metadata: Metadata = { title: "Ingest review sheet", robots: { index: false, follow: false } };

const button = "rounded border border-neutral-400 px-3 py-1.5 text-sm font-medium hover:bg-neutral-100 focus-visible:outline-2 focus-visible:outline-offset-2";
const pill = (tone: "ok" | "warn" | "muted") =>
  `inline-block rounded px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${tone === "ok" ? "bg-emerald-50 text-emerald-800" : tone === "warn" ? "bg-amber-50 text-amber-900" : "bg-neutral-100 text-neutral-600"}`;

function fmt(v: unknown): string { return v === null || v === undefined ? "" : typeof v === "boolean" ? (v ? "late" : "on time") : String(v); }
function Values({ row, other }: { row: SheetRow["primary"]; other?: SheetRow["primary"] | null }) {
  return (
    <span className="font-mono text-xs">
      {COMPARED_FIELDS.map((f, i) => {
        const differs = other ? JSON.stringify(row[f] ?? null) !== JSON.stringify(other[f] ?? null) : false;
        return <span key={f}>{i > 0 && " | "}<span className={differs ? "font-semibold text-amber-900" : ""}>{fmt(row[f])}</span></span>;
      })}
      {typeof row.confidence === "number" && <span className="ml-2 text-neutral-500">{row.confidence.toFixed(2)}</span>}
    </span>
  );
}

export default async function FilingSheetPage({ params, searchParams }: {
  params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireLocalReview();
  const { id } = await params;
  const q = await searchParams;
  const show = typeof q.show === "string" ? q.show : "ruling";
  const data = await loadFilingSheet(id);
  if (!data.item) return <main className="mx-auto max-w-5xl px-4 py-8"><p>No review item {id}.</p></main>;
  const { item, sheet, reason, pdfFile } = data;
  const rows = sheet?.rows ?? [];
  const visible = rows.filter((r) => show === "all" ? true : show === "ruling" ? r.status === "ruling" : show === "ocr" ? r.status === "ocr differs" || r.status === "ocr unread" : show === "low" ? (r.primary.confidence ?? 1) < 0.9 : true);
  const hidden = { id, show, slug: item.slug, sourceUrl: item.filing.url ?? "", pdfSha256: data.pdfSha256 ?? "" };
  return (
    <main className="mx-auto max-w-7xl space-y-6 px-4 py-8">
      <header className="space-y-2">
        <p className="text-xs uppercase tracking-wide text-neutral-500"><Link href="/admin/review" className="underline">Local review</Link> · ingest review sheet</p>
        <h1 className="text-3xl font-semibold">{item.officialName}</h1>
        <p className="text-sm">{pdfFile} · posted {item.filing.date ?? "?"} · {item.status} · {item.filing.url && <a className="underline" href={`/admin/pdf?name=${encodeURIComponent(pdfFile ?? "")}`} target="_blank" rel="noreferrer">open PDF</a>}</p>
        {typeof q.message === "string" && <p role="status" className="rounded border border-emerald-300 bg-emerald-50 p-3 text-sm">{q.message}</p>}
        {typeof q.error === "string" && <p role="alert" className="rounded border border-red-300 bg-red-50 p-3 text-sm whitespace-pre-wrap">{q.error}</p>}
        {reason && <p className="text-sm text-neutral-700">{reason}</p>}
      </header>

      {sheet && (
        <>
          <section className="grid gap-px border border-neutral-300 bg-neutral-300 sm:grid-cols-4">
            {[
              ["Rows", sheet.summary.rows, "numbered in the read"],
              ["All readers agree", sheet.summary.allAgree, "Claude, OCR and Astra match"],
              ["Need your ruling", `${sheet.summary.needRuling - sheet.summary.ruled} of ${sheet.summary.needRuling}`, `${sheet.summary.ruled} ruled so far`],
              ["Models agree, OCR did not", sheet.summary.ocrDiffers + sheet.summary.ocrUnread, `${sheet.summary.ocrDiffers} misread, ${sheet.summary.ocrUnread} unread`],
            ].map(([k, v, s]) => (
              <div key={String(k)} className="bg-white p-3"><div className="text-[11px] uppercase tracking-wide text-neutral-500">{k}</div><div className="text-2xl tabular-nums">{v}</div><div className="text-xs text-neutral-600">{s}</div></div>
            ))}
          </section>

          {sheet.summary.extraRows.length > 0 && (
            <p className="text-sm">Astra also read {sheet.summary.extraRows.length} row(s) with no match in Claude&apos;s read: {sheet.summary.extraRows.map((r) => `${r.description} (${fmt(r.type)} ${fmt(r.date)} ${fmt(r.amount)})`).join("; ")}. These pair with the unread rows below.</p>
          )}

          <nav className="flex flex-wrap gap-2 text-sm" aria-label="Filter rows">
            {[["ruling", "Need your ruling"], ["ocr", "OCR could not confirm"], ["low", "Claude under 0.90"], ["all", "All rows"]].map(([k, label]) => (
              <Link key={k} href={`/admin/review/filing/${encodeURIComponent(id)}?show=${k}`} className={`${button} ${show === k ? "bg-neutral-900 text-white hover:bg-neutral-900" : ""}`}>{label}</Link>
            ))}
            <span className="ml-auto self-center text-neutral-600">{visible.length} of {rows.length} rows shown</span>
          </nav>

          <div className="overflow-x-auto border border-neutral-300">
            <table className="w-full min-w-[1100px] text-sm">
              <thead className="bg-neutral-50 text-left text-[11px] uppercase tracking-wide text-neutral-600">
                <tr><th className="p-2">Page · row</th><th className="p-2">Description (Claude)</th><th className="p-2">Claude</th><th className="p-2">OCR</th><th className="p-2">Astra</th><th className="p-2">Status</th></tr>
              </thead>
              <tbody>
                {visible.map((r) => {
                  const c = r.correction;
                  const settled = c && (c.status === "ruled" || c.status === "confirmed");
                  const disputedField = r.astraDiffers[0] ?? "lateFilingFlag";
                  return (
                    <Fragment key={r.position}>
                      <tr className={`border-t border-neutral-200 align-top ${r.status === "ruling" ? "bg-amber-50/40" : ""}`}>
                        <td className="p-2 tabular-nums text-neutral-600">{r.page ?? "?"} · {r.printedRow ?? r.position + 1}</td>
                        <td className="p-2 font-medium">{r.primary.description}</td>
                        <td className="p-2"><Values row={r.primary} other={r.astra} /></td>
                        <td className="p-2">{r.ocr === "agree" ? <span className={pill("ok")}>agrees</span> : r.ocr === "disagree" ? <><span className={pill("warn")}>differs</span><div className="font-mono text-xs">{r.ocrValue}</div></> : r.ocr === "unread" ? <span className={pill("muted")}>unread</span> : <span className={pill("muted")}>none</span>}</td>
                        <td className="p-2">{r.astra ? <>{r.astraDiffers.length ? <span className={pill("warn")}>differs</span> : <span className={pill("ok")}>agrees</span>}<div><Values row={r.astra} other={r.primary} /></div>{r.astraPairing === "position" && <div className="text-xs text-neutral-500">read as “{r.astra.description}”</div>}</> : <span className={pill("muted")}>no matching row</span>}</td>
                        <td className="p-2">{r.status === "ruling" ? (settled ? <span className={pill("ok")}>{c!.status} by {c!.ruledBy}</span> : <span className={pill("warn")}>your ruling</span>) : r.status === "all agree" ? <span className={pill("ok")}>all agree</span> : <span className={pill("muted")}>{r.status}</span>}</td>
                      </tr>
                      {(r.status !== "all agree") && (
                        <tr className={`border-t border-neutral-100 ${r.status === "ruling" ? "bg-amber-50/40" : ""}`}>
                          <td colSpan={6} className="p-2 pb-4">
                            <div className="grid items-start gap-4 md:grid-cols-[1fr_300px]">
                              <figure className="m-0 border border-neutral-200 bg-white p-1">
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                {r.page ? <img src={`/admin/strip?file=${encodeURIComponent(pdfFile ?? "")}&page=${r.page}&i=${r.indexOnPage}&n=${r.rowsOnPage}`} alt={`Printed row ${r.printedRow ?? r.position + 1} from page ${r.page}`} className="block h-auto max-w-full" loading="lazy" /> : <p className="text-xs">No single page for this row.</p>}
                                <figcaption className="text-[11px] text-neutral-500">Page {r.page}, printed row {r.printedRow ?? "?"}: #, description, type, date, late, amount.</figcaption>
                              </figure>
                              <div className="space-y-2 text-sm">
                                {c && <p className="text-xs text-neutral-700"><strong>{c.status}</strong> {c.field}: {fmt(c.original)} → {fmt(c.corrected)} · {c.status === "proposed" ? `proposed by ${c.proposedBy}` : `${c.ruledBy}, ${c.ruledAt?.slice(0, 10)}`}<br />{c.evidence}</p>}
                                {r.status === "ruling" && !settled && (
                                  <form action={ruleRow} className="space-y-2">
                                    {Object.entries(hidden).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
                                    <input type="hidden" name="position" value={r.position} />
                                    <input type="hidden" name="page" value={r.page ?? ""} />
                                    <input type="hidden" name="printedRow" value={r.printedRow ?? ""} />
                                    <input type="hidden" name="field" value={disputedField} />
                                    <input type="hidden" name="original" value={JSON.stringify(r.primary[disputedField] ?? null)} />
                                    {c?.status === "proposed" && <input type="hidden" name="correctionId" value={c.id} />}
                                    <p className="text-xs text-neutral-600">What does the page print for <strong>{disputedField}</strong>?</p>
                                    <input name="note" placeholder="what you saw (optional)" className="block w-full rounded border border-neutral-300 p-1 text-xs" />
                                    <div className="flex flex-wrap gap-2">
                                      {c?.status === "proposed" ? <button className={button} name="action" value="rule">Page says {fmt(c.corrected)} (proposed)</button>
                                        : r.astra && r.astraDiffers.length > 0 ? <>
                                          <button className={button} name="action" value="correct" formAction={ruleRow}>Page says Astra: {fmt(r.astra[disputedField])}</button>
                                          <input type="hidden" name="corrected" value={disputedField === "lateFilingFlag" ? String(!!r.astra.lateFilingFlag) : String(r.astra[disputedField] ?? "")} />
                                        </> : null}
                                      <button className={button} name="action" value="confirm">Page says Claude: {fmt(r.primary[disputedField])}</button>
                                    </div>
                                    <details className="text-xs"><summary className="cursor-pointer">Neither, type it</summary>
                                      <div className="mt-1 flex gap-2"><input name="corrected" placeholder={disputedField === "lateFilingFlag" ? "true or false" : "value as printed"} className="flex-1 rounded border border-neutral-300 p-1" /><button className={button} name="action" value="correct">Record</button></div>
                                    </details>
                                  </form>
                                )}
                                {r.status === "ruling" && settled && c?.status === "ruled" && (
                                  <form action={ruleRow}>
                                    {Object.entries(hidden).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
                                    <input type="hidden" name="correctionId" value={c.id} /><input type="hidden" name="field" value={c.field} /><input type="hidden" name="position" value={r.position} /><input type="hidden" name="original" value={JSON.stringify(c.original)} />
                                    <button className={button} name="action" value="withdraw">Withdraw ruling</button>
                                  </form>
                                )}
                                {r.status !== "ruling" && <p className="text-xs text-neutral-600">Both models agree. Strip shown for a spot check; no ruling needed.</p>}
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>

          <section className="space-y-2 border-t border-neutral-300 pt-4">
            <h2 className="text-xl font-semibold">Filing decision</h2>
            {item.status !== "open" ? <p className="text-sm">Decided: {item.decision}</p>
              : sheet.ready ? (
                <form action={decideFiling} className="space-y-2">
                  <input type="hidden" name="id" value={id} />
                  <p className="text-sm">Every disputed row has a ruling. Recording the decision ties it to these exact rows (the read plus your rulings); the next <code>pnpm ingest-filings</code> merges them.</p>
                  <input name="note" placeholder="note for the record (optional)" className="block w-full max-w-xl rounded border border-neutral-300 p-2 text-sm" />
                  <button className={button}>Record decision: publish the read plus the rulings</button>
                </form>
              ) : <p className="text-sm">{sheet.pending.length} disputed row(s) still need a ruling before this filing can be decided.</p>}
          </section>
        </>
      )}
    </main>
  );
}
