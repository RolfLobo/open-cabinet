/**
 * Admin API: the row-trace validator's run log, read-only.
 *
 * GET /api/admin/row-trace — the last runs recorded by
 * scripts/validate-row-trace.ts in data/meta/row-trace-log.json. There is
 * no POST: a run needs the PDFs and poppler on the machine, so it is a
 * CLI command, and the panel says which.
 */
import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { readRowTraceLog, ROW_TRACE_COMMANDS } from "@/lib/row-trace-log";

export async function GET() {
  if (!(await requireAdmin())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const log = readRowTraceLog();
  return NextResponse.json({ runs: (log?.runs ?? []).slice(0, 10), commands: ROW_TRACE_COMMANDS });
}
