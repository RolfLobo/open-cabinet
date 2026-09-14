import { describe, expect, it } from "vitest";
import {
  amountLead,
  controlMutations,
  dateForms,
  descMatch,
  hasTextLayer,
  inBlock,
  inPage,
  locateInPages,
  rowBlocks,
  runControls,
  seededSample,
  splitPages,
} from "./row-trace";

// A Part 7 page as pdftotext -layout prints it (Bisignano, page 28).
const PAGE = `        #    DESCRIPTION                                   TYPE       DATE         AMOUNT
      127   Humana, Inc. (HUM)                            Sale       12/24/2025   $15,001 -
                                                                                  $50,000
      128   Real Estate - 6H (NYC)                        Sale       03/04/2025   $500,001 -
                                                                                  $1,000,000
      133   Willingboro Township NJ School District       Purchase   08/06/2025   $1,000,001 -
                                                                                  $5,000,000
      134   Sea Isle City NJ Government Bond 4%           Purchase   08/17/2025   $1,000,001 -
                                                                                  $5,000,000
`;

const row133 = {
  description: "Willingboro Township NJ School District",
  type: "Purchase",
  date: "2025-08-06",
  amount: "$1,000,001-$5,000,000",
  sourceRow: 133,
  sourcePage: 28,
};

describe("matchers", () => {
  it("prints an ISO date the four ways a filing might", () => {
    expect(dateForms("2025-08-06")).toEqual(["08/06/2025", "08/6/2025", "8/06/2025", "8/6/2025"]);
    expect(dateForms(null)).toEqual([]);
  });

  it("takes the leading dollar figure of a range", () => {
    expect(amountLead("$1,000,001-$5,000,000")).toBe("$1,000,001");
    expect(amountLead("Over $1,000,000")).toBe("$1,000,000");
    expect(amountLead(null)).toBeNull();
  });

  it("finds a row's block and stops at the next numbered line", () => {
    const blocks = rowBlocks(PAGE, 133);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain("Willingboro");
    expect(blocks[0]).toContain("$5,000,000");
    expect(blocks[0]).not.toContain("Sea Isle");
  });

  it("matches a description exactly, by prefix, or fuzzily on a line", () => {
    const block = rowBlocks(PAGE, 133)[0];
    expect(descMatch("Willingboro Township NJ School District", block)).toBe(true);
    expect(descMatch("Willingboro Township NJ School Distrct", block)).toBe(true); // one slip
    expect(descMatch("ZZZ NOT A REAL ASSET QQQ", block)).toBe(false);
  });

  it("passes the spec check for a row that is on the page", () => {
    expect(inPage(PAGE, row133)).toEqual({ row: true, date: true, amount: true });
    expect(inBlock(PAGE, row133)).toEqual({ block: true, date: true, amount: true, desc: true, type: true });
  });

  it("reports what a wrong row is missing", () => {
    expect(inPage(PAGE, { ...row133, sourceRow: 5133 }).row).toBe(false);
    expect(inPage(PAGE, { ...row133, date: "2025-08-07" }).date).toBe(false);
    expect(inPage(PAGE, { ...row133, amount: "$50,001-$100,000" }).amount).toBe(false);
    // The page-level date check passes on a date another row carries; the
    // block check is what catches it.
    expect(inPage(PAGE, { ...row133, date: "2025-08-17" }).date).toBe(true);
    expect(inBlock(PAGE, { ...row133, date: "2025-08-17" })?.date).toBe(false);
    expect(inBlock(PAGE, { ...row133, sourceRow: 999 })).toEqual({ block: false });
    expect(inBlock(PAGE, { ...row133, sourceRow: null })).toBeNull();
  });
});

describe("text layer", () => {
  it("calls a document a scan when its median page is empty, cover page or not", () => {
    const typed = "x".repeat(600);
    expect(hasTextLayer([typed, typed, typed])).toBe(true);
    expect(hasTextLayer([typed, "", "", "OGE stamp", ""])).toBe(false);
    expect(hasTextLayer([])).toBe(false);
  });
});

describe("pages and location", () => {
  it("splits pdftotext output on form feeds only when the count agrees with pdfinfo", () => {
    expect(splitPages("a\fb\fc\f", 3)).toEqual(["a", "b", "c"]);
    expect(splitPages("a\fb\fc\f", 4)).toBeNull();
    expect(splitPages("a\fb", null)).toEqual(["a", "b"]);
  });

  it("locates an unpaged row by its block, or by description when it has no row number", () => {
    const pages = ["nothing here", PAGE];
    expect(locateInPages(pages, { ...row133, sourcePage: null })).toBe(2);
    expect(locateInPages(pages, { ...row133, sourceRow: null, sourcePage: null })).toBe(2);
    expect(locateInPages(pages, { ...row133, description: "Not on any page", sourceRow: null })).toBeNull();
  });
});

describe("negative controls", () => {
  it("mutates a row three ways", () => {
    const m = controlMutations(row133);
    expect(m.dateShift.date).toBe("2025-08-07");
    expect(m.rowShift.sourceRow).toBe(5133);
    expect(m.descSwap.description).toBe("ZZZ NOT A REAL ASSET QQQ");
  });

  it("catches every mutation of a row that is really on the page", () => {
    expect(runControls(PAGE, row133)).toEqual({ dateShift: "caught", rowShift: "caught", descSwap: "caught" });
  });

  it("reports a control it cannot evaluate rather than a false catch", () => {
    // The row's block does not parse (no such number), so date and
    // description controls have nothing to test against.
    const r = runControls(PAGE, { ...row133, sourceRow: 999 });
    expect(r.dateShift).toBe("not-evaluable");
    expect(r.descSwap).toBe("not-evaluable");
    expect(r.rowShift).toBe("caught");
  });

  it("draws the same seeded sample twice", () => {
    const items = Array.from({ length: 50 }, (_, i) => i);
    expect(seededSample(items, 5, 7)).toEqual(seededSample(items, 5, 7));
    expect(seededSample(items, 5, 7)).not.toEqual(seededSample(items, 5, 8));
    expect(seededSample(items, 500, 1)).toHaveLength(50);
  });
});
