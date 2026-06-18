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
  it("treats leading '* ' and '- ' list bullets as equivalent (incl. extra spaces)", () => {
    const gold =
      "* The first bullet point of the list.\n* The second bullet point of the list.";
    const output =
      "-   The first bullet point of the list.\n-   The second bullet point of the list.";
    const s = scoreBody(output, gold);
    expect(s.recall).toBe(1);
    expect(s.precision).toBe(1);
  });
  it("does NOT equate inline '*' and '-' (only the leading bullet marker)", () => {
    // inline emphasis/hyphen must stay distinct — bullets are line-leading only
    const gold = "This is the sentence with *emphasis* in the middle.";
    const output = "This is the sentence with -emphasis- in the middle.";
    const s = scoreBody(output, gold);
    expect(s.recall).toBeLessThan(1);
  });
  it("treats curly and straight quotes/apostrophes as equivalent", () => {
    const gold =
      'She said "hello there everyone" to the room.\nThat is everyone\'s favorite kind of day.';
    const output =
      'She said “hello there everyone” to the room.\nThat is everyone’s favorite kind of day.';
    const s = scoreBody(output, gold);
    expect(s.recall).toBe(1);
    expect(s.precision).toBe(1);
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
