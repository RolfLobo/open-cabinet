import { existsSync } from "fs";
import path from "path";
import { notFound } from "next/navigation";
import { rowStrip } from "@/lib/page-strips";
import { requireLocalReview } from "../review/local-only";

/** One printed row, cropped from a filing page, for the review sheet.
 * Local only; the file name is confined to data/pdfs. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  await requireLocalReview();
  const q = new URL(req.url).searchParams;
  const file = path.basename(q.get("file") ?? "");
  const page = Number(q.get("page")), index = Number(q.get("i")), count = Number(q.get("n"));
  if (!file.toLowerCase().endsWith(".pdf") || !Number.isInteger(page) || page < 1 || !Number.isInteger(index) || index < 0 || !Number.isInteger(count) || count < 1) notFound();
  const full = path.join(process.cwd(), "data", "pdfs", file);
  if (!existsSync(full)) notFound();
  const { png, exact } = await rowStrip(full, page, index, count);
  return new Response(new Uint8Array(png), { headers: { "content-type": "image/png", "cache-control": "private, max-age=3600", "x-strip-exact": exact ? "1" : "0" } });
}
