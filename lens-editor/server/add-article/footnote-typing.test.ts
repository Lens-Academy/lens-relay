import { describe, expect, it } from "vitest";
import { classifyFootnote, retypeFootnotes } from "./footnote-typing";

describe("classifyFootnote", () => {
  // Calibration cases lifted from a real import (owid-global-health).
  it("classifies author-year journal citations as cite", () => {
    expect(
      classifyFootnote(
        'Newhouse, J.P. (1977), "Medical care expenditure: a cross-national survey", Journal of Human Resources 12:115–125.',
      ),
    ).toBe("cite");
  });

  it("classifies organization-year citations as cite", () => {
    expect(
      classifyFootnote(
        "United Nations (2008). Delivering on the Global Partnership for Achieving the Millennium Development Goals. MDG Gap Task Force Report 2008.",
      ),
    ).toBe("cite");
  });

  it("classifies explanatory prose with data links as note", () => {
    expect(
      classifyFootnote(
        "The data on life expectancy is taken from Version 7 of the [dataset published by Gapminder](http://www.gapminder.org/data/documentation/gd004/).",
      ),
    ).toBe("note");
  });

  it("classifies plain explanatory prose as note", () => {
    expect(
      classifyFootnote(
        "Interestingly, there are important institutional variables that are also significantly correlated with healthcare expenditure after controlling for income.",
      ),
    ).toBe("note");
  });

  it("classifies prose that embeds a citation as ambiguous", () => {
    expect(
      classifyFootnote(
        "The source given for the data corresponds to Figure 1 in ILO, (2011), Social Protection Floor for a Fair and Inclusive Globalization.",
      ),
    ).toBe("ambiguous");
  });

  it("classifies DOI and arXiv links as cite regardless of prose", () => {
    expect(
      classifyFootnote(
        "See the full derivation in [the paper](https://doi.org/10.1000/xyz123) for details.",
      ),
    ).toBe("cite");
    expect(
      classifyFootnote("Discussed at length in <https://arxiv.org/abs/2312.06942>."),
    ).toBe("cite");
  });

  it("classifies a bare link-only definition as cite", () => {
    expect(
      classifyFootnote("[https://example.org/report](https://example.org/report)"),
    ).toBe("cite");
  });

  it("classifies ibid-style references as cite", () => {
    expect(classifyFootnote("Ibid., p. 42.")).toBe("cite");
  });

  it("classifies short evidence-free asides as note", () => {
    expect(classifyFootnote("Emphasis added.")).toBe("note");
  });

  it("classifies a title-plus-locator citation without a year-paren as ambiguous", () => {
    expect(
      classifyFootnote('Smith, "Principles of Economics", ch. 3, pp. 12–14.'),
    ).toBe("ambiguous");
  });

  it("classifies empty content as ambiguous", () => {
    expect(classifyFootnote("")).toBe("ambiguous");
    expect(classifyFootnote("   ")).toBe("ambiguous");
  });
});

describe("retypeFootnotes", () => {
  it("renames every reference and its definition together", () => {
    const { body, changes } = retypeFootnotes(
      [
        "Alpha[^1] and beta[^2], alpha again[^1].",
        "",
        "[^1]: Newhouse, J.P. (1977), Journal of Human Resources 12:115–125.",
        "[^2]: Some helpful context the author wanted to add here.",
      ].join("\n"),
    );
    expect(body).toContain("Alpha[^cite-1] and beta[^note-2], alpha again[^cite-1].");
    expect(body).toContain("[^cite-1]: Newhouse");
    expect(body).toContain("[^note-2]: Some helpful context");
    const codes = Object.fromEntries(changes.map((c) => [c.code, c.count]));
    expect(codes).toEqual({
      "normalize.footnote-typed-cite": 1,
      "normalize.footnote-typed-note": 1,
    });
  });

  it("labels unclassifiable footnotes ambiguous-N so the reviewer must decide", () => {
    const { body, changes } = retypeFootnotes(
      [
        "Claim[^3].",
        "",
        "[^3]: The source given corresponds to Figure 1 in ILO, (2011), Social Protection Floor.",
      ].join("\n"),
    );
    expect(body).toContain("Claim[^ambiguous-3].");
    expect(body).toContain("[^ambiguous-3]: The source given");
    expect(changes[0].code).toBe("normalize.footnote-ambiguous");
  });

  it("uses indented continuation lines when classifying", () => {
    const { body } = retypeFootnotes(
      [
        "Claim[^1].",
        "",
        "[^1]: A first line of explanatory prose that says nothing bibliographic.",
        "    Newhouse, J.P. (1977), Journal of Human Resources 12:115–125.",
      ].join("\n"),
    );
    // Continuation carries citation evidence inside prose → ambiguous.
    expect(body).toContain("[^ambiguous-1]:");
  });

  it("leaves already-typed, ambiguous, and exotic ids untouched (idempotent)", () => {
    const source = [
      "A[^note-old] B[^ambiguous-2] C[^fn-x].",
      "",
      "[^note-old]: Prose.",
      "[^ambiguous-2]: Prose.",
      "[^fn-x]: Prose.",
    ].join("\n");
    const first = retypeFootnotes(source);
    expect(first.body).toBe(source);
    expect(first.changes).toEqual([]);
  });

  it("is idempotent over its own output", () => {
    const once = retypeFootnotes("X[^1].\n\n[^1]: Plain prose here for a note.");
    const twice = retypeFootnotes(once.body);
    expect(twice.body).toBe(once.body);
    expect(twice.changes).toEqual([]);
  });

  it("leaves a reference without a definition untouched", () => {
    const source = "Dangling[^7] reference.";
    expect(retypeFootnotes(source).body).toBe(source);
  });

  it("leaves an orphan definition untouched", () => {
    const source = "No references here.\n\n[^9]: Orphaned definition text.";
    expect(retypeFootnotes(source).body).toBe(source);
  });

  it("leaves duplicate definitions untouched", () => {
    const source = ["Ref[^4].", "", "[^4]: First.", "[^4]: Second."].join("\n");
    expect(retypeFootnotes(source).body).toBe(source);
  });

  it("never collides with an existing typed id", () => {
    const source = [
      "A[^1] B[^note-1].",
      "",
      "[^1]: Plain prose that would become note-1.",
      "[^note-1]: Already here.",
    ].join("\n");
    expect(retypeFootnotes(source).body).toBe(source);
  });

  it("ignores footnote syntax inside fenced code and inline code", () => {
    const source = [
      "Real[^1] and `inline [^1] code`.",
      "",
      "```",
      "[^1]: not a definition",
      "fenced [^1] reference",
      "```",
      "",
      "[^1]: Plain prose definition.",
    ].join("\n");
    const { body } = retypeFootnotes(source);
    expect(body).toContain("Real[^note-1]");
    expect(body).toContain("`inline [^1] code`");
    expect(body).toContain("[^1]: not a definition");
    expect(body).toContain("fenced [^1] reference");
    expect(body).toContain("[^note-1]: Plain prose definition.");
  });

  it("keeps out-of-order numbering intact", () => {
    const { body } = retypeFootnotes(
      [
        "First cited[^5], then[^2].",
        "",
        "[^5]: Plain prose.",
        "[^2]: More plain prose.",
      ].join("\n"),
    );
    expect(body).toContain("First cited[^note-5], then[^note-2].");
  });
});
