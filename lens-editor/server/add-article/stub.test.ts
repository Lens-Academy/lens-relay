import { describe, expect, it } from "vitest";
import { parsePromotableArticleStub } from "./stub";

const frontmatter = `---
title: "An article"
source_url: "https://example.com/article"
created: 2026-06-27
tags:
  - "article-stub"
  - "validator-ignore"
  - "curated"
---`;

describe("parsePromotableArticleStub", () => {
  it("preserves multiple complete discussion blocks and custom tags", () => {
    const content = `${frontmatter}

%%
Luc:
Initial note.
%%

%%
Elias:
Second note.
%%
`;
    expect(parsePromotableArticleStub(content, "Lens Edu/articles/a.md")).toEqual({
      created: "2026-06-27",
      discussionBlocks:
        "%%\nLuc:\nInitial note.\n%%\n\n%%\nElias:\nSecond note.\n%%",
      extraTags: ["curated"],
    });
  });

  it("accepts an otherwise empty stub", () => {
    expect(
      parsePromotableArticleStub(frontmatter + "\n", "Lens Edu/articles/a.md")
        .discussionBlocks,
    ).toBe("");
  });

  it("rejects ordinary Markdown outside comment blocks descriptively", () => {
    expect(() =>
      parsePromotableArticleStub(
        `${frontmatter}\n\n%%\nA note.\n%%\n\n## Existing article text\n`,
        "Lens Edu/articles/a.md",
      ),
    ).toThrow(
      /found non-comment content outside frontmatter at line .*Existing article text.*move that text into a complete %% comment block/i,
    );
  });

  it("rejects an unclosed discussion block descriptively", () => {
    expect(() =>
      parsePromotableArticleStub(
        `${frontmatter}\n\n%%\nUnfinished note\n`,
        "Lens Edu/articles/a.md",
      ),
    ).toThrow(/%% comment beginning at line .* is not closed/i);
  });

  it("does not treat validator-ignore alone as a promotable stub", () => {
    expect(() =>
      parsePromotableArticleStub(
        frontmatter.replace('  - "article-stub"\n', ""),
        "Lens Edu/articles/a.md",
      ),
    ).toThrow(/not tagged article-stub/i);
  });
});
