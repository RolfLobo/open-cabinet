/**
 * Page strips: the printed row, cropped from the PDF page image, for the
 * review sheet. A person rules on what the page shows, so the page has to
 * be in front of them next to the readers' values.
 *
 * Rendering: pdftoppm at 120 dpi, greyscale, one PNG per page, cached under
 * data/cache/pages/<pdf basename>/. Cropping: the form's table rules are
 * found by scanning each image row for dark pixels across the table width;
 * when the count of bands matches the page's row count the strip is the
 * band, otherwise an even split is used and the strip is marked inexact.
 * Local tooling only (pdftoppm, sharp); the admin review pages are local.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";

export const PAGE_CACHE_DIR = path.resolve("data/cache/pages");
const DPI = 120;

export function pagePngPath(pdfPath: string, page: number): string {
  const dir = path.join(PAGE_CACHE_DIR, path.basename(pdfPath, ".pdf"));
  return path.join(dir, `p${String(page).padStart(3, "0")}.png`);
}

export function renderPage(pdfPath: string, page: number): string {
  const out = pagePngPath(pdfPath, page);
  if (existsSync(out)) return out;
  mkdirSync(path.dirname(out), { recursive: true });
  const prefix = out.replace(/\.png$/, "");
  execFileSync("pdftoppm", ["-singlefile", "-r", String(DPI), "-gray", "-f", String(page), "-l", String(page), "-png", pdfPath, prefix], { timeout: 60_000 });
  if (!existsSync(out)) throw new Error(`pdftoppm produced no ${out}`);
  return out;
}

/** Row bands (y0, y1) between horizontal table rules, top to bottom. */
export async function detectBands(pngPath: string): Promise<Array<[number, number]>> {
  const { data, info } = await sharp(pngPath).greyscale().raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height, x0 = Math.floor(W * 0.08), x1 = Math.floor(W * 0.92);
  const dark = new Float32Array(H);
  for (let y = 0; y < H; y++) {
    let n = 0, t = 0;
    for (let x = x0; x < x1; x += 3) { t++; if (data[y * W + x] < 200) n++; }
    dark[y] = n / t;
  }
  let mx = 0; for (let y = 150; y < H; y++) if (dark[y] > mx) mx = dark[y];
  const thr = Math.max(0.25, 0.6 * mx);
  const clusters: number[][] = [];
  for (let y = 150; y < H; y++) {
    if (dark[y] <= thr) continue;
    const last = clusters[clusters.length - 1];
    if (last && y - last[last.length - 1] <= 2) last.push(y); else clusters.push([y]);
  }
  const ys = clusters.map((c) => Math.floor((c[0] + c[c.length - 1]) / 2));
  const bands: Array<[number, number]> = [];
  for (let i = 0; i + 1 < ys.length; i++) { const h = ys[i + 1] - ys[i]; if (h >= 14 && h <= 40) bands.push([ys[i], ys[i + 1]]); }
  return bands;
}

const bandCache = new Map<string, Array<[number, number]>>();

/** PNG bytes for one printed row on a page. `index` is 0-based within the
 * page's rows; `count` is how many rows the page holds. */
export async function rowStrip(pdfPath: string, page: number, index: number, count: number): Promise<{ png: Buffer; exact: boolean }> {
  const png = renderPage(pdfPath, page);
  let bands = bandCache.get(png);
  if (!bands) { bands = await detectBands(png); bandCache.set(png, bands); }
  const meta = await sharp(png).metadata();
  const W = meta.width ?? 1320, H = meta.height ?? 1020;
  const exact = bands.length === count && index < bands.length;
  let top: number, height: number;
  if (exact) { [top, height] = [bands[index][0] + 1, bands[index][1] - bands[index][0] - 1]; }
  else { const step = (H - 260) / count; top = Math.floor(200 + index * step); height = Math.ceil(step); }
  const left = Math.floor(W * 0.08), width = Math.floor(W * 0.84);
  const buf = await sharp(png).extract({ left, top: Math.max(0, top), width, height: Math.max(8, Math.min(height, H - top)) }).resize({ width: 900 }).png().toBuffer();
  return { png: buf, exact };
}

/** For tests and scripts: write a strip to disk and return its path. */
export async function writeStrip(pdfPath: string, page: number, index: number, count: number, outPath: string): Promise<boolean> {
  const { png, exact } = await rowStrip(pdfPath, page, index, count);
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, png);
  return exact;
}

export function readPageDimensions(pdfPath: string, page: number): { width: number; height: number } | null {
  const png = pagePngPath(pdfPath, page);
  if (!existsSync(png)) return null;
  const buf = readFileSync(png);
  // PNG IHDR: width at bytes 16..19, height 20..23
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}
