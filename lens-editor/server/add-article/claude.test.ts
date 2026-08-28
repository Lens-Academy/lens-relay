import { describe, expect, it } from "vitest";
import {
  buildVerifyArgs,
  buildVerifyPrompt,
  parseReviewStatus,
  validateEditedArticle,
} from "./claude";

const article = `---
title: "Old Title"
author:
  - "Old Author"
source_url: "https://example.com/source"
published: 2026-06-16
created: 2026-08-25
accessed: 2026-08-25
description: "Old description"
tags:
  - "article-importer"
---

%%
Add discussion note here:

...

%%

Original body text.
`;

describe("direct source review", () => {
  it("exposes only local Read/Edit tools and prohibits delegation", () => {
    const args = buildVerifyArgs("/tmp/review");
    expect(args[args.indexOf("--allowedTools") + 1]).toBe("Read,Edit");
    expect(args[args.indexOf("--tools") + 1]).toBe("Read,Edit");
    expect(args[args.indexOf("--disallowedTools") + 1]).toBe("Agent");
    expect(args).not.toContain("Write");
    expect(args).not.toContain("--max-turns");
    expect(buildVerifyPrompt("/tmp/review")).toContain("edit this file directly");
    expect(buildVerifyPrompt("/tmp/review")).toContain("Do not create any file");
    expect(buildVerifyPrompt("/tmp/review")).toContain("Do not spawn sub-agents");
    expect(buildVerifyPrompt("/tmp/review")).toContain("evidence/source-rendered.html");
    expect(buildVerifyPrompt("/tmp/review")).toContain("evidence/source-unrendered.html");
    expect(buildVerifyPrompt("/tmp/review")).not.toContain("source.txt");
    expect(buildVerifyPrompt("/tmp/review")).toContain("Inspect source-rendered.html for every HTML review");
    expect(buildVerifyPrompt("/tmp/review")).toContain("HTML-escaped article content inside JSON-LD or hydration scripts");
    expect(buildVerifyPrompt("/tmp/review", 2)).toContain("review pass 3 of 3");
    expect(buildVerifyPrompt("/tmp/review")).toContain(
      "Remove Creative Commons and other licensing notices from imported articles.",
    );
    expect(buildVerifyPrompt("/tmp/review")).toContain("Do not copy obvious typos or grammatical errors from the source.");
    expect(buildVerifyPrompt("/tmp/review")).toContain("Do not make whitespace-only edits");
    expect(buildVerifyPrompt("/tmp/review")).toContain("Never collapse a substantive section, an appendix, footnotes, or prose");
  });

  it("accepts exact PASS and a reasoned REJECT from Claude CLI JSON", () => {
    expect(parseReviewStatus(JSON.stringify({ result: "PASS" }))).toEqual({ decision: "pass", reason: "" });
    expect(parseReviewStatus(JSON.stringify({ result: "Review complete.\n\nPASS" }))).toEqual({
      decision: "pass",
      reason: "",
    });
    expect(parseReviewStatus(JSON.stringify({ result: "REJECT: source is truncated" }))).toEqual({
      decision: "reject",
      reason: "source is truncated",
    });
  });

  it.each([
    "not json",
    JSON.stringify({}),
    JSON.stringify({ result: "PASS with trailing commentary" }),
    JSON.stringify({ result: "REJECT:" }),
  ])("fails closed on malformed final status", (stdout) => {
    expect(() => parseReviewStatus(stdout)).toThrow();
  });

  it("accepts body and source-derived metadata edits", () => {
    const edited = article
      .replace('title: "Old Title"', 'title: "Correct Title"')
      .replace('  - "Old Author"', '  - "Correct Author"')
      .replace("published: 2026-06-16", "published: 2024-01-02")
      .replace('description: "Old description"', 'description: "Correct description"')
      .replace("Original body text.", "Corrected body text.");
    const result = validateEditedArticle(article, edited);
    expect(result.markdown).toBe(edited);
    expect(result.meta).toEqual({
      title: "Correct Title",
      author: ["Correct Author"],
      source_url: "https://example.com/source",
      published: "2024-01-02",
      description: "Correct description",
    });
  });

  it.each([
    ["source_url", 'source_url: "https://example.com/source"', 'source_url: "https://evil.example/"'],
    ["created", "created: 2026-08-25", "created: 2020-01-01"],
    ["accessed", "accessed: 2026-08-25", "accessed: 2020-01-01"],
    ["tags", '  - "article-importer"', '  - "validator-ignore"'],
  ])("rejects changes to protected %s frontmatter", (_field, before, after) => {
    expect(() => validateEditedArticle(article, article.replace(before, after))).toThrow("protected frontmatter");
  });

  it("rejects added frontmatter fields and changed authoring comments", () => {
    expect(() => validateEditedArticle(article, article.replace("created:", "extra: value\ncreated:"))).toThrow("added or removed");
    expect(() => validateEditedArticle(article, article.replace("Add discussion note here", "Changed note"))).toThrow("authoring comment");
  });

  it("rejects changed CriticMarkup comments", () => {
    const commented = `${article}\n{>>Keep this note<<}\n`;
    expect(() => validateEditedArticle(commented, commented.replace("Keep this note", "Changed note")))
      .toThrow("CriticMarkup comment");
  });

  it("rejects malformed required metadata and an empty body", () => {
    expect(() => validateEditedArticle(article, article.replace("published: 2026-06-16", "published: sometime"))).toThrow("invalid date");
    expect(() => validateEditedArticle(article, article.replace("Original body text.\n", ""))).toThrow("body empty");
  });

  it("preserves an intentionally absent source_url during retroactive review", () => {
    const withoutSourceUrl = article.replace('source_url: "https://example.com/source"\n', "");
    const result = validateEditedArticle(withoutSourceUrl, withoutSourceUrl);
    expect(result.meta.source_url).toBe("");
  });
});
