import { describe, it, expect } from "vitest";
import { generateArticleMarkdown, generateArticleFilenameBase } from "./export";

describe("generateArticleMarkdown", () => {
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
