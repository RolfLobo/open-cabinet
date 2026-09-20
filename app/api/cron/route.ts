/**
 * Vercel Cron endpoint — daily OGE filing monitor.
 *
 * Vercel Pro: 300s (5 min) function timeout.
 * Typical run: fetch OGE API, diff PDF URLs, record and email the result.
 *
 * Protected by CRON_SECRET to prevent unauthorized triggers.
 * Vercel Cron sends this automatically in the Authorization header.
 *
 * Config in vercel.json: two slots, 10:00 and 14:00 UTC. A failure at the first
 * slot is recorded but not emailed; the 14:00 run is the retry.
 */
import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { getDb } from "@/lib/db";
import { notify } from "@/lib/notify";
import {
  describeFetchError,
  diffNewFilings,
  fetchOgeRecords,
  indexLooksIncomplete,
  LAST_CRON_SLOT_UTC_HOUR,
  retrySlotPending,
  getTargetFilings,
  loadDiscoveredFilingUrls,
  loadKnownFilingsFromData,
  getAllIndexedFilings,
  reconcileKnownFilings,
} from "@/lib/oge-filings";
import { readSourceAvailability, sourceKey } from "@/lib/source-availability";

export const maxDuration = 300; // 5 minutes (Vercel Pro)

export async function GET(request: NextRequest) {
  // Verify the request is from Vercel Cron
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json(
      { error: "CRON_SECRET not configured" },
      { status: 500 }
    );
  }
  // Constant-time comparison so an attacker can't recover the secret byte by
  // byte from response-timing differences. The length guard is required because
  // timingSafeEqual throws on mismatched buffer lengths.
  const expected = Buffer.from(`Bearer ${cronSecret}`);
  const provided = Buffer.from(authHeader ?? "");
  if (
    provided.length !== expected.length ||
    !timingSafeEqual(provided, expected)
  ) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startTime = Date.now();
  let runId: number | null = null;
  let db: ReturnType<typeof getDb> | null = null;

  try {
    const connectionString =
      process.env.DATABASE_URL || process.env.DATABASE_URL_UNPOOLED;
    if (!connectionString) {
      return NextResponse.json(
        { error: "DATABASE_URL not configured" },
        { status: 500 }
      );
    }

    db = getDb();

    // Import schema
    const { pipelineRuns } = await import("@/lib/schema");

    // Create pipeline run record
    const [run] = await db
      .insert(pipelineRuns)
      .values({ trigger: "cron", status: "running" })
      .returning({ id: pipelineRuns.id });
    runId = run.id;

    const { records, totalRecords } = await fetchOgeRecords();
    const targetFilings = getTargetFilings(records);
    // A healthy OGE portal always carries ~100+ in-scope 278-Ts. Zero from a
    // full record list means the response was malformed (the API intermittently
    // returns records with empty type/level fields — the Aug 11 and Aug 13,
    // 2026 runs), and diffing against it would report "no news" on a broken
    // fetch. Fail loudly so the admin gets a pipeline_error email instead of
    // silence.
    if (targetFilings.length === 0) {
      const sample = JSON.stringify(records[0] ?? null).slice(0, 400);
      throw new Error(
        `OGE response had ${records.length} records but zero target 278-T filings — response likely malformed. First record: ${sample}`
      );
    }
    const knownUrls = await loadDiscoveredFilingUrls();
    const newFilings = diffNewFilings(targetFilings, knownUrls);
    if (records.length !== totalRecords) throw new Error("Incomplete OGE index; source comparison skipped");

    const { and, desc, eq, ne } = await import("drizzle-orm");

    // OGE sometimes returns every record but with some rows' type/level fields
    // blanked (Sept 19, 2026: 92 target 278-Ts at 10:00 UTC, 124 at 14:00).
    // Diffing known filings against such a list would report dozens of real
    // reports as "no longer listed." Compare the target count with the last
    // completed run and skip the source comparison when it drops sharply.
    const [previousRun] = await db
      .select({ tokenUsage: pipelineRuns.tokenUsage })
      .from(pipelineRuns)
      .where(and(eq(pipelineRuns.status, "completed"), ne(pipelineRuns.id, run.id)))
      .orderBy(desc(pipelineRuns.id))
      .limit(1);
    const previousTargets =
      (previousRun?.tokenUsage as { target278TFilings?: number } | null)?.target278TFilings ?? null;
    const indexIncomplete = indexLooksIncomplete(targetFilings.length, previousTargets);

    const sourceChanges = indexIncomplete
      ? { missing: [], redated: [] }
      : reconcileKnownFilings(getAllIndexedFilings(records), await loadKnownFilingsFromData());
    const previousSources = readSourceAvailability();
    const newlyMissing = sourceChanges.missing.filter((f) =>
      previousSources?.filings[sourceKey(f.url)]?.indexListed !== false);
    const sourceNote = indexIncomplete
      ? `\n\nOGE's list looked incomplete this run: ${targetFilings.length} tracked 278-Ts came back, against ${previousTargets} on the last check. This usually means OGE sent some rows with blank fields, not that filings were removed. The source-listing comparison was skipped and will run again on the next check.`
      : newlyMissing.length
      ? `\n\n${newlyMissing.length} tracked report(s) are no longer listed in OGE's index. This does not establish that the PDFs were deleted. Review their original links:\n${newlyMissing.map((f) => f.url).join("\n")}`
      : "";

    await db
      .update(pipelineRuns)
      .set({
        status: "completed",
        newFilingsFound: newFilings.length,
        duration: Date.now() - startTime,
        completedAt: new Date(),
        errors: null,
        tokenUsage: {
          note: "OGE new-filing and source-listing monitor",
          totalOgeRecords: totalRecords,
          target278TFilings: targetFilings.length,
          missingSourceListings: indexIncomplete ? null : sourceChanges.missing.length,
          indexIncomplete,
          previousTarget278TFilings: previousTargets,
        },
      })
      .where(eq(pipelineRuns.id, run.id));

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const filingList = newFilings
      .slice(0, 10)
      .map((filing) => `${filing.name} — ${filing.docDate.slice(0, 10)}`)
      .join("\n");

    // Nudge: is there a subscriber digest ready to send? (Built from parsed JSON
    // + the notifiedFilings ledger — sends nothing here, just reports.)
    let digestNote = "";
    try {
      const { buildDigest } = await import("@/lib/digest");
      // Scope the draft exactly like /admin's send path (newest published
      // /filings entry), so this nudge can never claim a digest is ready
      // for filings the admin panel would not actually offer.
      const { getSendScope } = await import("@/lib/updates");
      const since = await getSendScope();
      const draft = await buildDigest(since ? { ingestedOnOrAfter: since } : {});
      if (!draft.empty) {
        digestNote = `\n\n${draft.items.length} official${draft.items.length === 1 ? "" : "s"} with new trades are ready to send to subscribers — review and send at /admin.`;
      }
    } catch (e) {
      console.warn("[cron] digest draft check failed:", (e as Error).message);
    }
    // Quiet on all-clear runs: the pipelineRuns row is the record. Email only
    // for new filings, newly missing source listings, or a waiting digest.
    if (newFilings.length > 0 || digestNote || sourceNote) {
      await notify({
        type: "new_filings",
        headline:
          indexIncomplete
            ? `OGE check: ${newFilings.length} new filings, OGE's list looked incomplete`
            : newlyMissing.length > 0
            ? `OGE check: ${newFilings.length} new filings, ${newlyMissing.length} missing source listings`
            : newFilings.length === 0
            ? "OGE check OK · subscriber digest ready"
            : `OGE check found ${newFilings.length} new filing${newFilings.length === 1 ? "" : "s"}`,
        summary:
          (newFilings.length === 0
            ? `Polled the OGE public portal and found no new downloadable 278-T PDFs beyond the URLs already tracked by Open Cabinet.`
            : `Polled the OGE public portal and found ${newFilings.length} downloadable 278-T PDF${newFilings.length === 1 ? "" : "s"} not yet tracked by Open Cabinet.\n\n${filingList}`) +
          digestNote + sourceNote,
        metadata: {
          "Total OGE records": totalRecords.toLocaleString(),
          "Tracked 278-T PDFs": targetFilings.length,
          "New filing URLs": newFilings.length,
          "Run duration": `${elapsed}s`,
          "Pipeline run #": run.id,
        },
      });
    }

    return NextResponse.json({
      status: "completed",
      runId: run.id,
      totalOgeRecords: totalRecords,
      target278TFilings: targetFilings.length,
      newFilingsFound: newFilings.length,
      missingSourceListings: indexIncomplete ? null : sourceChanges.missing.length,
      indexIncomplete,
      duration: `${((Date.now() - startTime) / 1000).toFixed(1)}s`,
      message:
        newFilings.length === 0
          ? "OGE URL-diff check complete."
          : "New OGE filings found. Run the GitHub Actions pipeline or pnpm ingest-filings for JSON ingestion.",
    });
  } catch (err) {
    // "fetch failed" alone says nothing; the cause chain (ETIMEDOUT, ECONNRESET,
    // ENOTFOUND, a TLS error) says whether OGE was down or DNS broke.
    const message = describeFetchError(err);
    // vercel.json runs this route at 10:00 and 14:00 UTC. A failure at the
    // first slot has a retry coming; the pipelineRuns row records it and the
    // email waits. Both Sept 2026 failures were 10:00 UTC outages at OGE that
    // the 14:00 retry cleared.
    const retryPending = retrySlotPending();
    let earlierFailureNote = "";
    if (runId && db) {
      try {
        const { desc, eq, ne, and } = await import("drizzle-orm");
        const { pipelineRuns } = await import("@/lib/schema");
        await db
          .update(pipelineRuns)
          .set({
            status: "failed",
            duration: Date.now() - startTime,
            completedAt: new Date(),
            errors: [{ step: "cron", error: message, retryPending }],
          })
          .where(eq(pipelineRuns.id, runId));
        if (!retryPending) {
          const [thisRun] = await db
            .select({ ranAt: pipelineRuns.ranAt })
            .from(pipelineRuns)
            .where(eq(pipelineRuns.id, runId));
          const [previous] = await db
            .select({ status: pipelineRuns.status, ranAt: pipelineRuns.ranAt, errors: pipelineRuns.errors })
            .from(pipelineRuns)
            .where(and(eq(pipelineRuns.trigger, "cron"), ne(pipelineRuns.id, runId)))
            .orderBy(desc(pipelineRuns.id))
            .limit(1);
          const sixHours = 6 * 60 * 60 * 1000;
          if (
            previous?.status === "failed" &&
            thisRun?.ranAt &&
            previous.ranAt &&
            thisRun.ranAt.getTime() - previous.ranAt.getTime() < sixHours
          ) {
            const prevError = (previous.errors as Array<{ error?: string }> | null)?.[0]?.error ?? "unknown";
            earlierFailureNote = `\n\nThe earlier check today also failed (${prevError}). No successful OGE check today.`;
          }
        }
      } catch {
        // The notification below is the durable failure signal.
      }
    }

    if (retryPending) {
      console.warn(`[cron] OGE check failed, retry pending at ${LAST_CRON_SLOT_UTC_HOUR}:00 UTC: ${message}`);
    } else {
      await notify({
        type: "pipeline_error",
        details: `Cron job failed: ${message}${earlierFailureNote}`,
        metadata: {
          duration: `${((Date.now() - startTime) / 1000).toFixed(1)}s`,
          environment: process.env.VERCEL_ENV || "local",
        },
      });
    }

    return NextResponse.json(
      {
        error: message,
        retryPending,
        duration: `${((Date.now() - startTime) / 1000).toFixed(1)}s`,
      },
      { status: 500 }
    );
  }
}
