import { describe, it, expect } from "vitest";
import { scoreBody, structureCounts } from "./score";

describe("scoreBody", () => {
  it("recall=1 when output covers all gold lines; precision<1 when output adds lines", () => {
    const gold = "Line one.\nLine two.\nLine three.";
    const output = "Line one.\nLine two.\nLine three.\nExtra added line.";
    const s = scoreBody(output, gold);
    expect(s.recall).toBeCloseTo(1, 5);
    expect(s.precision).toBeLessThan(1);
  });
  it("recall<1 when output drops a gold line", () => {
    const s = scoreBody("Line one.\nLine three.", "Line one.\nLine two.\nLine three.");
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
