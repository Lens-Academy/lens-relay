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

  // Prevents: Datalab PDF output `- 2** IAEA Safeguards` rendering literal asterisks.
  it("restores a list item's missing bold opener in PDF bodies", () => {
    const input = [
      "- 2** IAEA Safeguards: serving nuclear non-proliferation  ",
      "- Prover Side:**",
      "  - Inputs** and **Plaintext transcripts** are provided.",
      "1. Step** one",
      "- **Fine** already",
      "- a ** b",
      "- x**y** stays",
      "- Item _em_ and text** more",
      "Not a list 2** item",
      "```",
      "- code** stays",
      "```",
    ].join("\n");
    const pdf = { pdf: true };
    expect(normalizeArticleBody(input, "https://example.com/a").body).toBe(input);
    const { body, changes } = normalizeArticleBody(input, "https://example.com/a.pdf", pdf);
    expect(body.split("\n")).toEqual([
      "- **2** IAEA Safeguards: serving nuclear non-proliferation  ",
      "- **Prover Side:**",
      "  - **Inputs** and **Plaintext transcripts** are provided.",
      "1. **Step** one",
      "- **Fine** already",
      "- a ** b",
      "- x**y** stays",
      "- Item _em_ and text** more",
      "Not a list 2** item",
      "```",
      "- code** stays",
      "```",
    ]);
    expect(changes.find((c) => c.code === "normalize.list-item-bold-opener")?.count).toBe(4);
    expect(normalizeArticleBody(body, "https://example.com/a.pdf", pdf).body).toBe(body);
  });

  it("handles CRLF lines, and never treats text after inline code as a line start", () => {
    const pdf = { pdf: true };
    expect(normalizeArticleBody("- 7** Why?\r\n", "https://example.com", pdf).body).toBe("- **7** Why?\r\n");
    const afterCode = "Use `x`\n- y** z";
    expect(normalizeArticleBody(afterCode, "https://example.com", pdf).body).toBe("Use `x`\n- **y** z");
    const midLine = "`x`- y** z";
    expect(normalizeArticleBody(midLine, "https://example.com", pdf).body).toBe(midLine);
    for (const untouched of ["- a** b `c` d** e", "Example:\n\n    - x** y", "- ~~x~~ y** z"]) {
      expect(normalizeArticleBody(untouched, "https://example.com", pdf).body).toBe(untouched);
    }
  });

  it("trims Datalab's padding around inline math in PDF bodies only", () => {
    // From "Compact Proofs of Model Performance via Mechanistic
    // Interpretability" (arXiv 2406.11779), imported through the PDF path.
    const input = [
      "A small transformer trained on Max-of- $K$ , validating proof transfer.",
      "Let  $\\mathcal{M} : X \\rightarrow Y$  be a model, ( $l, t$ ) a pair, and  $a$  $b$  two values.",
      "Keep x - $y$ and $z$ -dimensional, `code  $x$  here`, $$a$$  then.",
    ].join("\n");
    expect(normalizeArticleBody(input, "https://example.com/a").body).toBe(input);
    const pdf = { pdf: true };
    const { body, changes } = normalizeArticleBody(input, "https://example.com/a.pdf", pdf);
    expect(body.split("\n")).toEqual([
      "A small transformer trained on Max-of-$K$, validating proof transfer.",
      "Let $\\mathcal{M} : X \\rightarrow Y$ be a model, ($l, t$) a pair, and $a$ $b$ two values.",
      "Keep x - $y$ and $z$ -dimensional, `code  $x$  here`, $$a$$  then.",
    ]);
    expect(changes.find((c) => c.code === "normalize.pdf-inline-math-padding")?.count).toBeGreaterThan(0);
    expect(normalizeArticleBody(body, "https://example.com/a.pdf", pdf).body).toBe(body);
    for (const untouched of [
      "See value $x$ ![figure](_page_3_Picture_1.jpeg) here.",
      "between $0$ .5 and $1$",
      "between $0$ ,5 and $1$ ,000",
      ">     a = f( $x$ );",
      "-     $K$",
      "We need $x$ != 0.",
      "Code:\n\n  \tf( $x$ ) = 1;",
      "1.     a = f( $x$ );",
      "Code:\n\n    foo( $x$ );\n    bar( $y$ );",
    ]) {
      expect(normalizeArticleBody(untouched, "https://example.com/a.pdf", pdf).body).toBe(untouched);
    }
  });

  describe("display math fences", () => {
    const fence = (body: string) => normalizeArticleBody(body, "https://example.com").body;

    it("fences a one-line display formula that is a block of its own", () => {
      expect(fence("Text.\n\n$$x^2 + y^2$$\n\nMore.")).toBe("Text.\n\n$$\nx^2 + y^2\n$$\n\nMore.");
    });

    it("keeps the container prefix in a blockquote and on multi-line TeX in a list", () => {
      expect(fence("> Quote.\n>\n> $$a = b$$\n")).toContain("> $$\n> a = b\n> $$");
      // Idempotent: already fenced math, quoted or not, is left as it is.
      for (const body of ["> Quote.\n>\n> $$a = b$$\n", "Text.\n\n$$x$$\n", "-   Item.\n\n    $$\\liminf_n a_n =\n        b$$\n"]) {
        expect(fence(fence(body))).toBe(fence(body));
      }
      expect(fence("> Quote.\n>\n> $$\n> a = b\n> $$\n")).toBe("> Quote.\n>\n> $$\n> a = b\n> $$\n");
      // A continuation line without the list indentation: leave it alone.
      expect(fence("-   Item.\n\n    $$a =\nb$$\n\nAfter.")).toBe("-   Item.\n\n    $$a =\nb$$\n\nAfter.");
      expect(fence("-   Item.\n\n    $$\\liminf_n a_n =\n        b$$\n")).toContain("    $$\n    \\liminf_n a_n =\n        b\n    $$");
    });

    it("leaves display math inside a paragraph, and a literal dollar before inline math, alone", () => {
      expect(fence("We get $$x$$ here.")).toBe("We get $$x$$ here.");
      expect(fence("Text\n$$x$$\n")).toBe("Text\n$$x$$\n");
      expect(fence("Bet \\$$t$ now.")).toBe("Bet \\$$t$ now.");
    });
  });
});
