import { describe, it, expect } from "vitest";
import {
  applyNormalizedMeta,
  parseMetaResponse,
  normalizeMetaWithLlm,
  type MetaNormalizeInput,
} from "./meta-normalize";

function input(over: Partial<MetaNormalizeInput> = {}): MetaNormalizeInput {
  return {
    meta: {
      title: "Coherent Extrapolated Volition",
      author: ["Intelligence"],
      source_url: "https://intelligence.org/files/CEV.pdf",
      published: "2013-02-20",
      description: "",
    },
    siteName: "",
    createdDate: "2026-07-02",
    authorIsFallback: true,
    dateIsFallback: false,
    dateFromPdfInfo: true,
    bodyStart:
      "Coherent Extrapolated Volition\n\nEliezer Yudkowsky\nMachine Intelligence Research Institute\n\nThe information is current as of May 2004.",
    bodyEnd: "Yudkowsky, Eliezer. 2004. Coherent Extrapolated Volition.",
    ...over,
  };
}

describe("applyNormalizedMeta — anti-fabrication merge rules", () => {
  // Prevents: CEV-class defects — publisher-as-author + re-save date, the
  // worst-scored item of the 50-article blind eval.
  it("replaces a fallback author and overrides a PDF-info date when evidenced", () => {
    const { meta, changed } = applyNormalizedMeta(input(), {
      title: "Coherent Extrapolated Volition",
      authors: ["Eliezer Yudkowsky"],
      published: "2004-05-01",
    });
    expect(meta.author).toEqual(["Eliezer Yudkowsky"]);
    expect(meta.published).toBe("2004-05-01");
    expect(changed).toContain("author");
    expect(changed).toContain("published");
  });

  it("rejects author names that are not literally in the excerpt", () => {
    const { meta } = applyNormalizedMeta(input(), {
      authors: ["John Fabricated"],
    });
    expect(meta.author).toEqual(["Intelligence"]); // unchanged
  });

  it("never replaces a real (non-fallback) byline", () => {
    const { meta } = applyNormalizedMeta(
      input({
        authorIsFallback: false,
        meta: {
          title: "T",
          author: ["Jane Real"],
          source_url: "u",
          published: "2020-01-02",
          description: "",
        },
        bodyStart: "T by Eliezer Yudkowsky",
      }),
      { authors: ["Eliezer Yudkowsky"] },
    );
    expect(meta.author).toEqual(["Jane Real"]);
  });

  it("fills a fallback date only when its year appears in the excerpt", () => {
    const base = input({
      dateIsFallback: true,
      dateFromPdfInfo: false,
      meta: {
        title: "T",
        author: ["A B"],
        source_url: "u",
        published: "2026-07-02",
        description: "",
      },
      bodyStart: "Posted on Aug. 20, 2024 by A B",
      bodyEnd: "",
    });
    expect(applyNormalizedMeta(base, { published: "2024-08-20" }).meta.published).toBe(
      "2024-08-20",
    );
    // year not in excerpt → rejected
    expect(applyNormalizedMeta(base, { published: "1999-08-20" }).meta.published).toBe(
      "2026-07-02",
    );
  });

  it("does not override a real web meta date", () => {
    const { meta } = applyNormalizedMeta(
      input({ dateFromPdfInfo: false, dateIsFallback: false }),
      { published: "2004-05-01" },
    );
    expect(meta.published).toBe("2013-02-20");
  });

  it("accepts title repairs only when they overlap the current title", () => {
    const fix = applyNormalizedMeta(input(), {
      title: "Coherent Extrapolated Volition (2004)",
    });
    expect(fix.meta.title).toBe("Coherent Extrapolated Volition (2004)");
    const reject = applyNormalizedMeta(input(), {
      title: "A Completely Different Document",
    });
    expect(reject.meta.title).toBe("Coherent Extrapolated Volition");
  });
});

describe("parseMetaResponse", () => {
  it("parses the CLI json wrapper and extracts the JSON object", () => {
    const cli = JSON.stringify({
      type: "result",
      result: 'Here you go:\n{"title":"T","authors":["A B"],"published":"2020-01-01"}',
    });
    expect(parseMetaResponse(cli)).toEqual({
      title: "T",
      authors: ["A B"],
      published: "2020-01-01",
    });
  });

  it("returns null on garbage", () => {
    expect(parseMetaResponse("not json at all")).toBe(null);
  });
});

describe("normalizeMetaWithLlm", () => {
  it("returns input meta unchanged when the runner fails", async () => {
    const meta = await normalizeMetaWithLlm(input(), async () => {
      throw new Error("cli down");
    });
    expect(meta.author).toEqual(["Intelligence"]);
  });

  it("applies a valid runner response end-to-end", async () => {
    const meta = await normalizeMetaWithLlm(input(), async () =>
      JSON.stringify({
        type: "result",
        result: '{"title":"Coherent Extrapolated Volition","authors":["Eliezer Yudkowsky"],"published":"2004-05-01"}',
      }),
    );
    expect(meta.author).toEqual(["Eliezer Yudkowsky"]);
    expect(meta.published).toBe("2004-05-01");
  });
});

describe("review-hardening: date validity and title exfiltration guards", () => {
  // Prevents: "2024-13-45" passing the shape regex and landing unquoted in YAML.
  it("rejects calendar-invalid dates even when the year is evidenced", () => {
    const base = input({ dateIsFallback: true, bodyStart: "Published in 2024." });
    expect(applyNormalizedMeta(base, { published: "2024-13-45" }).changed).toEqual([]);
    expect(applyNormalizedMeta(base, { published: "2024-08-20" }).meta.published).toBe(
      "2024-08-20",
    );
  });

  // Prevents: exfiltration via title — appending a token that keeps overlap ≥ 0.5.
  it("rejects titles that add words not present in the excerpt", () => {
    const r = applyNormalizedMeta(input(), {
      title: "Coherent Extrapolated Volition sk-ant-secret-token",
    });
    expect(r.meta.title).toBe("Coherent Extrapolated Volition");
    // words present in the excerpt are still allowed (real repairs)
    const ok = applyNormalizedMeta(input(), {
      title: "Coherent Extrapolated Volition Yudkowsky",
    });
    expect(ok.meta.title).toBe("Coherent Extrapolated Volition Yudkowsky");
  });
});

describe("nameInText contiguity (adversarial probe: fabricated bylines)", () => {
  // Prevents: "Mark Page" fabricated from "mark your calendars…" +
  // "…page of the appendix" — scattered word hits must not count.
  it("rejects names assembled from scattered common words", () => {
    const base = input({
      bodyStart: "Please mark your calendars for the workshop next week.",
      bodyEnd: "For details see page of the appendix.",
    });
    const r = applyNormalizedMeta(base, { authors: ["Mark Page"] });
    expect(r.meta.author).toEqual(["Intelligence"]); // unchanged
    const split = applyNormalizedMeta(
      input({ bodyStart: "John Deere tractors were discussed.", bodyEnd: "Regards, Smith." }),
      { authors: ["John Smith"] },
    );
    expect(split.meta.author).toEqual(["Intelligence"]);
  });

  it("accepts contiguous names and citation-order names", () => {
    const contiguous = applyNormalizedMeta(input(), { authors: ["Eliezer Yudkowsky"] });
    expect(contiguous.meta.author).toEqual(["Eliezer Yudkowsky"]);
    const citation = applyNormalizedMeta(
      input({ bodyStart: "A paper about volition.", bodyEnd: "Yudkowsky, Eliezer. 2004." }),
      { authors: ["Eliezer Yudkowsky"] }, // reversed in the citation line
    );
    expect(citation.meta.author).toEqual(["Eliezer Yudkowsky"]);
  });
});
