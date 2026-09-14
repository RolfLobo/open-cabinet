import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  getTargetReports,
  isAnnualOrTermination,
  isTargetLevel,
  loadDiscoveredFilingUrls,
  writeLastCheckState,
} from "./oge-filings";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("annual and termination reports for tracked officials", () => {
  const link = (file: string) => `<a href='https://extapps2.oge.gov/201/Presiden.nsf/PAS+Index/X/$FILE/${file}'>`;
  const records = [
    { type: `${link("Frank-J-Bisignano-2026-278ANNU.pdf")}Annual (2026)</a>`, name: "Bisignano, Frank J", agency: "SSA", title: "Commissioner", level: "Level I", docDate: "2026-08-26T04:18:08" },
    { type: `${link("Stephen-Miran-2026-278ANNUTERM.pdf")}Annual Term</a>`, name: "Miran, Stephen", agency: "Fed", title: "Governor", level: "Level II", docDate: "2026-08-26T04:18:08" },
    { type: `${link("Deanne-Criswell-2025-278TERM.pdf")}Termination</a>`, name: "Criswell, Deanne", agency: "FEMA", title: "Administrator", level: "Level II", docDate: "2025-03-05T04:05:33" },
    // Request-only: no PDF, never listed.
    { type: "Annual (2026) (<a href='https://extapps2.oge.gov/201/Presiden.nsf/201%20Request?OpenForm&Filer=Duffy'>Request this Document</a>)", name: "Duffy, Sean", agency: "DOT", title: "Secretary", level: "Level I", docDate: "2026-08-26T04:18:44" },
    // A 278-T is not a report for this list.
    { type: `${link("Frank-J-Bisignano-07.07.2026-278T.pdf")}278 Transaction</a>`, name: "Bisignano, Frank J", agency: "SSA", title: "Commissioner", level: "Level I", docDate: "2026-08-08T04:18:08" },
    // Not tracked.
    { type: `${link("JD-Vance-2026-278ANNUAL.pdf")}Annual (2026)</a>`, name: "Vance, JD", agency: "OVP", title: "Vice President", level: "n/a", docDate: "2026-07-01T04:21:03" },
  ];

  it("classifies the index labels", () => {
    expect(isAnnualOrTermination(records[0].type)).toBe("annual-278e");
    expect(isAnnualOrTermination(records[1].type)).toBe("termination-278e");
    expect(isAnnualOrTermination(records[2].type)).toBe("termination-278e");
    expect(isAnnualOrTermination(records[4].type)).toBeNull();
    expect(isAnnualOrTermination("Nominee 278")).toBeNull();
  });

  it("lists posted reports of tracked officials only, with the alias applied", () => {
    // "Miran, Stephen" is aliased to the site's "Miran, Stephen I".
    const tracked = new Set(["Bisignano, Frank J", "Miran, Stephen I", "Criswell, Deanne", "Duffy, Sean"]);
    const reports = getTargetReports(records, tracked);
    expect(reports.map((r) => [r.name, r.kind])).toEqual([
      ["Bisignano, Frank J", "annual-278e"],
      ["Miran, Stephen I", "termination-278e"],
      ["Criswell, Deanne", "termination-278e"],
    ]);
  });

  it("names the Vice President as a target filer, like the President", () => {
    expect(isTargetLevel({ type: "", name: "Vance, JD", agency: "", title: "", level: "n/a", docDate: "" })).toBe(true);
    expect(isTargetLevel({ type: "", name: "Vance, Michael J", agency: "", title: "", level: "n/a", docDate: "" })).toBe(false);
  });

  it("keeps the previous report list when a caller does not look for reports", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "oc-reports-"));
    roots.push(root);
    const filing = { name: "Example", pdfUrl: "https://example.org/a.pdf", docDate: "2026-08-01" };
    const report = { ...filing, pdfUrl: "https://example.org/annual.pdf", kind: "annual-278e" as const };
    await writeLastCheckState({ root, filings: [filing], newFilings: [], reports: [report], newReports: [{ ...report, status: "reported" }] });
    expect(await loadDiscoveredFilingUrls(root)).toContain(report.pdfUrl);
    // The cron's write carries no reports; the list survives it.
    await writeLastCheckState({ root, filings: [filing], newFilings: [] });
    expect(await loadDiscoveredFilingUrls(root)).toContain(report.pdfUrl);
  });
});
