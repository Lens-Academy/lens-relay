import { describe, it, expect } from "vitest";
import { scoreBody, structureCounts } from "./score";

describe("scoreBody", () => {
  it("recall=1 when output covers all gold lines; precision<1 when output adds lines", () => {
    const gold =
      "This is the first sentence of the document.\nHere is the second sentence of the document.\nAnd this is the third sentence of the document.";
    const output = gold + "\nThis is an extra sentence not present in the gold.";
    const s = scoreBody(output, gold);
    expect(s.recall).toBeCloseTo(1, 5);
    expect(s.precision).toBeLessThan(1);
  });
  it("recall<1 when output drops a gold line", () => {
    const gold =
      "This is the first sentence of the document.\nHere is the second sentence of the document.\nAnd this is the third sentence of the document.";
    const output =
      "This is the first sentence of the document.\nAnd this is the third sentence of the document.";
    const s = scoreBody(output, gold);
    expect(s.recall).toBeLessThan(1);
  });
});

describe("structureCounts", () => {
  it("counts headings, footnotes, code, math, images", () => {
    const md = "## H\n\ntext[^1]\n\n[^1]: def\n\n```\ncode\n```\n\n$$x$$\n\n![a](u)";
    const c = structureCounts(md);
    expect(c.headings).toBe(1);
    expect(c.footnoteRefs).toBe(1);
    expect(c.footnoteDefs).toBe(1);
    expect(c.code).toBe(1);
    expect(c.math).toBe(1);
    expect(c.images).toBe(1);
  });
});
