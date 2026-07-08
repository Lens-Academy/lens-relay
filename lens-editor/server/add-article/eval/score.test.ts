import { describe, it, expect } from "vitest";
import { scoreBody, structureCounts, scoreArticle } from "./score";

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

describe("scoreArticle (x/10, dialect-blind)", () => {
  const GOLD = `## Introduction

Some opening prose that describes the argument in enough words to shingle.

1. first numbered item with words
2. second numbered item with words

- a bullet item here
- another bullet item here

Closing paragraph with a final thought about the whole matter at hand.`;

  // Prevents: the false positives the old line-exact scorer screamed about.
  it("gives 10/10 for render-equivalent dialect differences", () => {
    const out = GOLD
      .replace(/^1\. /m, "1.  ") // extra space before numbered item
      .replace(/^2\. /m, "2.   ")
      .replace(/^- a bullet/m, "*   a bullet")
      .replace(/"/g, "”")
      .replace(/Some opening prose that describes the argument in enough words to shingle./,
        "Some opening prose that describes\nthe argument in enough words to shingle.") // re-wrapped line
      .replace(/first/, "first"); // no-op
    const s = scoreArticle(out, GOLD);
    expect(s.score10).toBe(10);
  });

  it("ignores the frontmatter metadata block on both sides", () => {
    const withFm = `---\ntitle: "X"\nauthor:\n  - "Y"\n---\n\n${GOLD}`;
    expect(scoreArticle(withFm, GOLD).score10).toBe(10);
    expect(scoreArticle(GOLD, withFm).score10).toBe(10);
  });

  it("drops meaningfully when a section is missing (and flags incompleteness when it is the ending)", () => {
    const truncated = GOLD.split("Closing paragraph")[0];
    const s = scoreArticle(truncated, GOLD);
    expect(s.score10).toBeLessThan(9);
    expect(s.completeness).toBeLessThan(0.9);
  });

  it("drops when large junk is added (precision side)", () => {
    const noisy =
      GOLD +
      "\n\n" +
      Array.from({ length: 40 }, (_, i) => `Related post teaser number ${i} promoting shard${i} content with crumb${i} labels.`).join("\n");
    const s = scoreArticle(noisy, GOLD);
    expect(s.score10).toBeLessThan(8.8); // F2 tolerates junk more than loss — by design
  });

  it("penalizes lost structure (headings/lists flattened away)", () => {
    const flattened = GOLD.replace(/^## /m, "").replace(/^\d+\. /gm, "").replace(/^- /gm, "");
    const s = scoreArticle(flattened, GOLD);
    expect(s.structure).toBeLessThan(1);
  });
});

describe("scoreArticle — missing-chunk and inline-formatting sensitivity", () => {
  const para = (i: number) =>
    `Topic ${i} alpha${i} discusses beta${i} matters and gamma${i} evidence with delta${i} details across epsilon${i} findings today.`;
  const GOLD10 = Array.from({ length: 10 }, (_, i) => para(i)).join("\n\n");

  // Prevents: a large missing MIDDLE hiding behind intact endpoints — the
  // exact concern raised in review of the first scorer design.
  it("a ~30% missing middle scores well below 9", () => {
    const out = [0, 1, 2, 6, 7, 8, 9].map(para).join("\n\n"); // paras 3-5 gone
    const s = scoreArticle(out, GOLD10);
    expect(s.score10).toBeLessThan(8.2);
    expect(s.completeness).toBeLessThan(0.8); // gap detector fired
  });

  it("punishes missing text harder than the same amount of extra text", () => {
    const missing = scoreArticle([0, 1, 2, 3, 4, 5, 6].map(para).join("\n\n"), GOLD10);
    const extra = scoreArticle(
      GOLD10 + "\n\n" + [10, 11, 12].map(para).join("\n\n"),
      GOLD10,
    );
    expect(extra.score10).toBeGreaterThan(missing.score10);
  });

  // Prevents: lost bold/italic/blockquotes being invisible to the score.
  it("penalizes stripped inline formatting and flattened lists", () => {
    const gold =
      "Some **bold words** and _italic words_ here.\n\n> a quoted line of text\n\n- item one here\n- item two here\n\n" +
      para(1);
    const stripped = gold
      .replace(/\*\*/g, "")
      .replace(/_/g, "")
      .replace(/^> /m, "")
      .replace(/^- /gm, "");
    const s = scoreArticle(stripped, gold);
    expect(s.structure).toBeLessThan(0.75);
    expect(s.score10).toBeLessThan(9.5);
    // identical formatting still scores 10
    expect(scoreArticle(gold, gold).score10).toBe(10);
  });
});
