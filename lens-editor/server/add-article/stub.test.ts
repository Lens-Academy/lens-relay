import { describe, expect, it } from "vitest";
import {
  isStub,
  parsePromotableArticleStub,
  parsePromotableStub,
  splitImportedDoc,
  ARTICLE_STUB,
  VIDEO_STUB,
} from "./stub";

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

describe("video stubs", () => {
  const videoStub = `---
title: "A talk"
url: "https://www.youtube.com/watch?v=abc"
tags:
  - "video-stub"
  - "validator-ignore"
---

%%
A note.
%%
`;

  it("are told apart from article stubs and ordinary files", () => {
    expect(isStub(videoStub, VIDEO_STUB)).toBe(true);
    expect(isStub(videoStub, ARTICLE_STUB)).toBe(false);
    expect(isStub(frontmatter, ARTICLE_STUB)).toBe(true);
    expect(isStub("Some text\n---\ntags:\n  - video-stub\n---\n", VIDEO_STUB)).toBe(false);
  });

  it("speak of the transcript in their errors", () => {
    expect(() =>
      parsePromotableStub(`${videoStub}\nStray text\n`, "v.md", VIDEO_STUB),
    ).toThrow(/Cannot promote video stub v\.md: .*before importing the transcript/);
    expect(parsePromotableStub(videoStub, "v.md", VIDEO_STUB)).toEqual({
      created: undefined,
      discussionBlocks: "%%\nA note.\n%%",
      extraTags: [],
    });
  });
});

describe("splitImportedDoc", () => {
  it("puts the frontmatter and the leading notes in the head, the imported text in the body", () => {
    expect(
      splitImportedDoc("---\ntitle: x\n---\n\n%%\nOne\n%%\n\n%%\nTwo\n%%\n\nThe text.\n\n%%\nlater\n%%\n"),
    ).toEqual({
      head: "---\ntitle: x\n---\n\n%%\nOne\n%%\n\n%%\nTwo\n%%",
      body: "The text.\n\n%%\nlater\n%%",
      hasComments: true,
    });
  });

  it("has an empty head of notes for an old transcript, and no answer without frontmatter", () => {
    expect(splitImportedDoc("---\ntitle: x\n---\n\nThe text.\n")).toEqual({
      head: "---\ntitle: x\n---",
      body: "The text.",
      hasComments: false,
    });
    expect(splitImportedDoc("# No frontmatter")).toBeNull();
  });

  it("leaves an unclosed note in the body", () => {
    expect(splitImportedDoc("---\nt: x\n---\n\n%%\nunfinished\n")?.body).toBe("%%\nunfinished");
  });
});
