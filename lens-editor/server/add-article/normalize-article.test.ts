import { describe, expect, it } from "vitest";
import { normalizeArticleBody } from "./normalize-article";

describe("normalizeArticleBody", () => {
  it("applies safe repairs without globally rewriting whitespace", () => {
    const input = "See [paper](/paper.pdf). \\( \\)  \r\n\r\nPosted in: , ,\r\n\r\n\r\n";
    const once = normalizeArticleBody(input, "https://example.com/post");
    expect(once.body).toBe("See [paper](https://example.com/paper.pdf).   \r\n\r\n\r\n\r\n\r\n");
    expect(once.body).toContain("  \r\n");
    expect(normalizeArticleBody(once.body, "https://example.com/post").body).toBe(once.body);
  });

  it("never inserts collapse directives", () => {
    const input = [
      "Intro.",
      "",
      "## Acknowledgements",
      "",
      "Thanks.",
      "",
      "## References",
      "",
      "- Citation",
      "",
      "**Next in series:** [The sequel](/next)",
    ].join("\n");
    const normalized = normalizeArticleBody(input, "https://example.com/post");
    expect(normalized.body).not.toContain(":::collapse");
    expect(normalized.body).toContain("## Acknowledgements");
    expect(normalized.body).toContain("## References");
    expect(normalized.body).toContain("[The sequel](https://example.com/next)");
    expect(normalized.changes.map((change) => change.code)).not.toContain("normalize.collapse-backmatter");
  });

  it("protects backtick and tilde fenced code", () => {
    const input = [
      "[outside](/outside)",
      "```md",
      "[inside](/inside) \\( \\)",
      "Posted in: , ,",
      "```",
      "~~~markdown",
      "[tilde](/tilde)",
      "~~~",
    ].join("\n");
    const out = normalizeArticleBody(input, "https://example.com/base").body;
    expect(out).toContain("[outside](https://example.com/outside)");
    expect(out).toContain("[inside](/inside) \\( \\)");
    expect(out).toContain("Posted in: , ,");
    expect(out).toContain("[tilde](/tilde)");
  });

  it("protects inline code, paired comments, CriticMarkup, and valid math", () => {
    const protectedSource = [
      "`[code](/code) \\( \\)`",
      "%% [comment](/comment) \\( \\) %%",
      "{++[addition](/addition)++}",
      "{--[deletion](/deletion)--}",
      "{~~[old](/old)~>[new](/new)~~}",
      "{==[highlight](/highlight)==}",
      "{>>[comment](/critic)<<}",
      "$x + [math](/math)$",
      "$$[display](/display)$$",
      "\\([latex](/latex)\\)",
      "\\[[block](/block)\\]",
    ].join("\n");
    expect(normalizeArticleBody(protectedSource, "https://example.com").body).toBe(protectedSource);
  });

  it("does not rewrite fragments or ambiguous math", () => {
    const input = "[section](#part) and $pi_(x)$";
    expect(normalizeArticleBody(input, "https://example.com").body).toBe(input);
  });

  it("records bounded samples for each normalization code", () => {
    const input = `[one](/one) and [two](/two) and [long](/${"x".repeat(700)})`;
    const result = normalizeArticleBody(input, "https://example.com");
    const links = result.changes.find((change) => change.code === "normalize.root-relative-destination");
    expect(links).toMatchObject({ count: 3 });
    expect(links?.samples).toHaveLength(3);
    expect(Math.max(...(links?.samples.map((sample) => sample.after.length) ?? []))).toBeLessThanOrEqual(512);
  });

  it("retypes numeric footnotes as a second pass and reports the changes", () => {
    const input = [
      "Claim[^1] and aside[^2].",
      "",
      "[^1]: Newhouse, J.P. (1977), Journal of Human Resources 12:115–125.",
      "[^2]: Additional explanatory context from the author.",
    ].join("\n");
    const result = normalizeArticleBody(input, "https://example.com/article");
    expect(result.body).toContain("Claim[^cite-1] and aside[^note-2].");
    expect(result.changes.map((change) => change.code).sort()).toEqual([
      "normalize.footnote-typed-cite",
      "normalize.footnote-typed-note",
    ]);
  });

  it("anchors headings and rewrites their fragment links before review", () => {
    const input = "See [the risks](#the-risks).\n\n## The risks\n";
    const { body, changes } = normalizeArticleBody(input, "https://example.com/article");
    expect(body).toBe("See [[#^the-risks|the risks]].\n\n## The risks ^the-risks\n");
    expect(changes.map((c) => c.code)).toEqual(
      expect.arrayContaining(["normalize.heading-block-id", "normalize.heading-fragment-link"]),
    );
    expect(normalizeArticleBody(body, "https://example.com/article").body).toBe(body);
  });

  it("is idempotent with CRLF input and exact residue lines", () => {
    const input = "Before\r\nPosted in: , ,\r\nAfter [link](/path)\r\n";
    const once = normalizeArticleBody(input, "https://example.com/article");
    expect(once.body).toBe("Before\r\n\r\nAfter [link](https://example.com/path)\r\n");
    expect(normalizeArticleBody(once.body, "https://example.com/article").body).toBe(once.body);
  });
});
