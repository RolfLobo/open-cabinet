import { useState } from "react";
import type { RowTraceRun } from "@/lib/row-trace-log";

/**
 * Read-only view of the row-trace validator's log. Runs happen from the
 * command line because they need the source PDFs and poppler; the panel
 * shows the exact command instead of a button.
 */
export function RowTraceSection({
  runs,
  commands,
}: {
  runs: RowTraceRun[];
  commands: { full: string; fullTrump: string; official: string } | null;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  return (
    <section className="mb-12">
      <h2 className="text-xs uppercase tracking-wider text-neutral-500 font-medium mb-4">
        Row-trace validation
      </h2>
      <p className="text-sm text-neutral-500 mb-2">
        Checks that every row with a page appears on that page of its PDF
        (printed row number, date, amount) and that unpaged rows appear
        somewhere in the document, then proves the checks can fail with
        mutated rows. Runs happen from the CLI, not here: they need the PDFs
        on disk and poppler&rsquo;s <code>pdftotext</code>.
      </p>
      {commands && (
        <pre className="text-xs bg-neutral-50 border border-neutral-200 px-3 py-2 mb-4 overflow-x-auto">
{`${commands.full}
${commands.fullTrump}
${commands.official}`}
        </pre>
      )}
      {runs.length === 0 ? (
        <p className="text-sm text-neutral-400">No runs recorded yet.</p>
      ) : (
        <table className="w-full text-left text-xs">
          <thead>
            <tr className="border-b border-neutral-300 uppercase tracking-wider text-neutral-500">
              <th className="pb-1 pr-3 font-medium">Ran</th>
              <th className="pb-1 pr-3 font-medium">Scope</th>
              <th className="pb-1 pr-3 font-medium text-right">Pass</th>
              <th className="pb-1 pr-3 font-medium text-right">Fail</th>
              <th className="pb-1 pr-3 font-medium">Controls</th>
              <th className="pb-1 font-medium">Result</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => {
              const key = run.ranAt;
              const scope = run.options.all
                ? `all officials${run.options.fullTrump ? ", full Trump" : run.options.sampleTrump ? `, Trump sampled ${run.options.sampleTrump}` : ""}`
                : run.options.officials.join(", ");
              const c = run.controls;
              const uncaught = c.dateShift.uncaught + c.rowShift.uncaught + c.descSwap.uncaught;
              const failing = run.failures.length;
              return (
                <RowTraceRunRows
                  key={key}
                  run={run}
                  scope={scope}
                  uncaught={uncaught}
                  failing={failing}
                  open={expanded === key}
                  onToggle={() => setExpanded(expanded === key ? null : key)}
                />
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}

function RowTraceRunRows({
  run,
  scope,
  uncaught,
  failing,
  open,
  onToggle,
}: {
  run: RowTraceRun;
  scope: string;
  uncaught: number;
  failing: number;
  open: boolean;
  onToggle: () => void;
}) {
  const resultClass =
    run.result === "PASS" ? "text-emerald-700" : run.result === "LOOSE" ? "text-amber-700" : "text-red-700";
  return (
    <>
      <tr className="border-b border-neutral-100 align-top">
        <td className="py-1.5 pr-3 whitespace-nowrap text-neutral-600">
          {run.ranAt.slice(0, 16).replace("T", " ")}
          {run.gitSha && <span className="text-neutral-400 ml-1">{run.gitSha}</span>}
        </td>
        <td className="py-1.5 pr-3 text-neutral-600">{scope}</td>
        <td className="py-1.5 pr-3 text-right tabular-nums">{(run.totals.passed + run.totals.located).toLocaleString()}</td>
        <td className="py-1.5 pr-3 text-right tabular-nums">
          {failing > 0 ? (
            <button type="button" onClick={onToggle} className="underline text-red-700">
              {failing.toLocaleString()} {open ? "(hide)" : "(show)"}
            </button>
          ) : (
            "0"
          )}
        </td>
        <td className="py-1.5 pr-3 text-neutral-600">
          {run.controls.sample} rows, {uncaught === 0 ? "all mutations caught" : `${uncaught} uncaught`}
        </td>
        <td className={`py-1.5 font-medium ${resultClass}`}>{run.result}</td>
      </tr>
      {open && (
        <tr className="border-b border-neutral-100">
          <td colSpan={6} className="py-2 pr-3">
            <ul className="space-y-0.5 text-neutral-600">
              {run.failures.slice(0, 100).map((f, i) => (
                <li key={i}>
                  {f.official} · {f.sourceKind} · p.{f.page ?? "—"} #{f.row ?? "—"} · {f.date} · {f.amount} · {f.description}: {f.reason}
                </li>
              ))}
              {run.failures.length > 100 && <li>… and {run.failures.length - 100} more in data/meta/row-trace-log.json</li>}
              {run.problems.map((p, i) => (
                <li key={`p${i}`} className="text-amber-700">{p}</li>
              ))}
            </ul>
          </td>
        </tr>
      )}
    </>
  );
}
