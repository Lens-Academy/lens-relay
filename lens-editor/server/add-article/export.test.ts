import { describe, it, expect } from "vitest";
import {
  generateArticleMarkdown,
  generateArticleFilenameBase,
  articleFilenameCandidates,
} from "./export";

describe("generateArticleMarkdown", () => {
  it("collapses control whitespace so a multi-line title can't break the YAML", () => {
    const md = generateArticleMarkdown(
      {
        title: "Line one\nLine two",
        author: ["A"],
        source_url: "https://x.com",
        published: "",
        description: "",
      },
      "Body.",
      "2026-06-10",
    );
    const titleLine = md.split("\n").find((l) => l.startsWith("title:"));
    expect(titleLine).toBe('title: "Line one Line two"'); // single line, no raw newline
  });

  it("generates frontmatter matching the Lens Edu articles convention", () => {
    const md = generateArticleMarkdown(
      {
        title: "Meditations On Moloch",
        author: ["Scott Alexander"],
        source_url:
          "https://slatestarcodex.com/2014/07/30/meditations-on-moloch/",
        published: "2014-07-30",
        description: "An essay on coordination failures.",
      },
      "Body text.",
      "2026-06-10",
    );

    expect(md).toBe(`---
title: "Meditations On Moloch"
author:
  - "Scott Alexander"
source_url: "https://slatestarcodex.com/2014/07/30/meditations-on-moloch/"
published: 2014-07-30
created: 2026-06-10
accessed: 2026-06-10
description: "An essay on coordination failures."
tags:
  - "article-importer"
---

Body text.
`);
  });

  // Prevents: invalid YAML when title/description contain quotes
  it("escapes double quotes in quoted fields", () => {
    const md = generateArticleMarkdown(
      {
        title: 'The "Best" Article',
        author: [],
        source_url: "https://example.com",
        published: "",
        description: "",
      },
      "Body.",
      "2026-06-10",
    );
    expect(md).toContain('title: "The \\"Best\\" Article"');
  });

  // Prevents: frontmatter omitting required-by-schema keys when values unknown
  it("emits empty author/published/description keys when unknown", () => {
    const md = generateArticleMarkdown(
      {
        title: "T",
        author: [],
        source_url: "https://example.com",
        published: "",
        description: "",
      },
      "Body.",
      "2026-06-10",
    );
    expect(md).toContain("author:\nsource_url:");
    expect(md).toContain("published:\n");
    expect(md).toContain("description:\n");
  });

  it("supports multiple authors", () => {
    const md = generateArticleMarkdown(
      {
        title: "T",
        author: ["Alice Smith", "Bob Jones"],
        source_url: "https://example.com",
        published: "",
        description: "",
      },
      "Body.",
      "2026-06-10",
    );
    expect(md).toContain('author:\n  - "Alice Smith"\n  - "Bob Jones"');
  });
});

describe("generateArticleFilenameBase", () => {
  it("uses author surname + title, lowercased and hyphenated", () => {
    expect(
      generateArticleFilenameBase(["Scott Alexander"], "Meditations On Moloch"),
    ).toBe("alexander-meditations-on-moloch");
  });

  it("falls back to title only when no author", () => {
    expect(generateArticleFilenameBase([], "Takeoff Speeds!")).toBe(
      "takeoff-speeds",
    );
  });

  // Prevents: filenames with apostrophe-induced double hyphens ("don-t")
  it("strips apostrophes instead of hyphenating them", () => {
    expect(generateArticleFilenameBase([], "This Can't Go On")).toBe(
      "this-cant-go-on",
    );
  });

  it("collapses special characters into single hyphens", () => {
    expect(
      generateArticleFilenameBase(
        ["Eliezer Yudkowsky"],
        "Cascades, Cycles, Insight...",
      ),
    ).toBe("yudkowsky-cascades-cycles-insight");
  });
});

describe("articleFilenameCandidates", () => {
  const atlas = (section: string) =>
    `https://ai-safety-atlas.com/chapters/v1/${section}/introduction`;

  it("starts with the bare base, then folds in distinguishing URL path segments", () => {
    const c = articleFilenameCandidates("grey-introduction", atlas("risks"));
    expect(c[0]).toBe("grey-introduction");
    expect(c[1]).toBe("grey-introduction-risks");
    expect(c[2]).toBe("grey-introduction-v1-risks");
  });

  it("disambiguates the collision the bug hit: same author+title, different chapters", () => {
    const caps = articleFilenameCandidates("grey-introduction", atlas("capabilities"));
    const risks = articleFilenameCandidates("grey-introduction", atlas("risks"));
    expect(caps[0]).toBe(risks[0]); // identical base (the collision)
    expect(caps[1]).toBe("grey-introduction-capabilities");
    expect(risks[1]).toBe("grey-introduction-risks");
    expect(caps[1]).not.toBe(risks[1]); // ...steered to distinct names
  });

  it("is deterministic — re-importing the same URL yields the same candidate list", () => {
    expect(articleFilenameCandidates("grey-introduction", atlas("risks"))).toEqual(
      articleFilenameCandidates("grey-introduction", atlas("risks")),
    );
  });

  it("ignores a trailing slash (no empty segment leaks into the suffix)", () => {
    const c = articleFilenameCandidates("grey-introduction", `${atlas("risks")}/`);
    expect(c[1]).toBe("grey-introduction-risks");
  });

  it("falls back to just the base when the URL has no usable path or is malformed", () => {
    expect(articleFilenameCandidates("foo", "https://example.com")).toEqual(["foo"]);
    expect(articleFilenameCandidates("foo", "not a url")).toEqual(["foo"]);
  });

  it("falls back to base when a path segment has a malformed %-escape", () => {
    // decodeURIComponent throws on "%E0%A4%A"; the catch returns [base].
    expect(articleFilenameCandidates("foo", "https://x.org/a/%E0%A4%A/b")).toEqual([
      "foo",
    ]);
  });

  it("bounds candidate count and length on a deep URL", () => {
    const deep =
      "https://x.org/" +
      Array.from({ length: 12 }, (_, i) => `seg${i}aaaaaaaaaa`).join("/") +
      "/title";
    const c = articleFilenameCandidates("author-title", deep);
    expect(c.length).toBeLessThanOrEqual(4); // base + up to 3 URL-context levels
    for (const name of c) expect(name.length).toBeLessThanOrEqual(160);
  });
});
