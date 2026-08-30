import { describe, expect, it } from "vitest";
import {
  BASE_SELECTOR_TOOL,
  baseSelectorMcpConfig,
  buildVerifyArgs,
  buildVerifyPrompt,
  parsePlainReviewStatus,
  parseReviewStatus,
  resolveArticleReviewerConfig,
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
  it("enforces local Read/Edit tools without repeating capability restrictions in the prompt", () => {
    const args = buildVerifyArgs("/tmp/review");
    expect(args[args.indexOf("--allowedTools") + 1]).toBe("Read,Edit");
    expect(args[args.indexOf("--tools") + 1]).toBe("Read,Edit");
    expect(args[args.indexOf("--disallowedTools") + 1]).toBe("Agent,Bash,Write");
    expect(args).toContain("--restricted");
    expect(args).not.toContain("Write");
    expect(args).not.toContain("--max-turns");
    expect(buildVerifyPrompt("/tmp/review")).toContain("edit article.md in place");
    expect(buildVerifyPrompt("/tmp/review")).not.toContain("Do not spawn sub-agents");
    expect(buildVerifyPrompt("/tmp/review")).not.toContain("Do not use WebFetch");
    expect(buildVerifyPrompt("/tmp/review")).toContain("evidence/source-rendered.html");
    expect(buildVerifyPrompt("/tmp/review")).toContain("evidence/source-unrendered.html");
    expect(buildVerifyPrompt("/tmp/review")).not.toContain("source.txt");
    expect(buildVerifyPrompt("/tmp/review")).toContain("HTML-escaped article content inside JSON-LD or hydration scripts");
    expect(buildVerifyPrompt("/tmp/review", 2)).toContain("review pass 3 of 3");
    expect(buildVerifyPrompt("/tmp/review", 2)).toContain("base has already been chosen");
    expect(buildVerifyPrompt("/tmp/review", 2)).toContain("current article's remaining syntax problems");
    expect(buildVerifyPrompt("/tmp/review", 2)).toContain("their initial syntax findings, revealed after base selection");
    expect(buildVerifyPrompt("/tmp/review")).toContain(
      "Remove Creative Commons and other licensing notices from imported articles.",
    );
    expect(buildVerifyPrompt("/tmp/review")).toContain("Do not copy obvious typos or grammatical errors from the source.");
    expect(buildVerifyPrompt("/tmp/review")).toContain("Do not make whitespace-only edits");
    expect(buildVerifyPrompt("/tmp/review")).toContain("There is no edit-size limit");
    expect(buildVerifyPrompt("/tmp/review")).toContain("Do not create or run scripts");
    expect(buildVerifyPrompt("/tmp/review")).toContain(
      "Include only the article itself; remove reader comments, reactions, navigation, related content, widgets, and other page chrome.",
    );
    expect(buildVerifyPrompt("/tmp/review")).toContain("Large or extensive repairs are never a reason to reject");
    expect(buildVerifyPrompt("/tmp/review")).toContain("article boundaries cannot be reasonably determined");
    expect(buildVerifyPrompt("/tmp/review")).toContain(
      "Use typed kebab-case footnote IDs: `[^cite-id]` for citations and `[^note-id]` for explanatory notes; rename every reference and definition together.",
    );
    expect(buildVerifyPrompt("/tmp/review")).toContain("Never hide a substantive section, an appendix, footnotes, or prose");
  });

  it("gives first-pass dual-candidate reviews only the constrained base selector", () => {
    const args = buildVerifyArgs("/tmp/review", 0, "sonnet", 1.5, true);
    expect(args[args.indexOf("--tools") + 1]).toBe(`Read,Edit,${BASE_SELECTOR_TOOL}`);
    const allowedTools = args[args.indexOf("--allowedTools") + 1];
    expect(allowedTools).toBe(`Read,Edit,${BASE_SELECTOR_TOOL}`);
    expect(allowedTools).not.toContain("Bash");
    expect(args).toContain("--strict-mcp-config");
    const config = JSON.parse(args[args.indexOf("--mcp-config") + 1]);
    expect(config).toEqual(JSON.parse(baseSelectorMcpConfig()));
    expect(config.mcpServers.article_review.args[0]).toMatch(/select-review-base\.mjs$/);
    const prompt = buildVerifyPrompt("/tmp/review", 0, true);
    expect(prompt).toContain("candidate-unrendered.md");
    expect(prompt).toContain("candidate-rendered.md");
    expect(prompt).toContain("Both Markdown files will likely contain mistakes");
    expect(prompt).toContain("an image of the corrected Markdown file should form in your head");
    expect(prompt).toContain("allowed and regularly needed");
    expect(prompt).toContain("validator does not catch completeness issues");
    expect(prompt).toContain("validation-rendered.json");
    expect(prompt).toContain("validation-unrendered.json");
    expect(prompt).toContain("available only after selecting the base");
    expect(prompt).toContain("call the select_review_base tool exactly once");
    expect(prompt).not.toContain("node ");
    expect(prompt).not.toContain("Compare article.md directly against the source evidence");
    expect(prompt).not.toContain("Edit article.md in place to make source-faithful repairs");
  });

  it("allows the retro CLI to override Claude's production-default budget", () => {
    const defaultArgs = buildVerifyArgs("/tmp/review");
    expect(defaultArgs[defaultArgs.indexOf("--max-budget-usd") + 1]).toBe("10");
    const localArgs = buildVerifyArgs("/tmp/review", 0, "sonnet", 5);
    expect(localArgs[localArgs.indexOf("--max-budget-usd") + 1]).toBe("5");
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

  it("selects provider defaults and accepts local Codex status output", () => {
    expect(resolveArticleReviewerConfig()).toEqual({ provider: "claude", model: "sonnet" });
    expect(resolveArticleReviewerConfig("codex")).toEqual({ provider: "codex", model: "gpt-5.6-terra" });
    expect(resolveArticleReviewerConfig("codex", "gpt-5.6-sol")).toEqual({
      provider: "codex",
      model: "gpt-5.6-sol",
    });
    expect(parsePlainReviewStatus("work complete\nPASS\n")).toEqual({ decision: "pass", reason: "" });
    expect(parsePlainReviewStatus("REJECT: evidence is incomplete")).toEqual({
      decision: "reject",
      reason: "evidence is incomplete",
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
    const withExtraNote = `${article}\n%%\nEditor-authored note.\n%%\n`;
    expect(() => validateEditedArticle(withExtraNote, withExtraNote.replace("Editor-authored", "Tampered")))
      .toThrow("authoring comment");
    expect(() => validateEditedArticle(article, `${article}\n%%\nNew block.\n%%\n`)).toThrow("authoring comment");
  });

  it("treats validator-suppression pragmas as reviewer-owned", () => {
    const pragma = "%% validator-ignore-next-line --code article.block-repeated-nearby --reason intentional-repeat %%";
    const withPragma = article.replace("Original body text.", `${pragma}\nOriginal body text.`);
    // add
    expect(validateEditedArticle(article, withPragma).markdown).toBe(withPragma);
    // edit an existing pragma (a later review round retargeting the code)
    const retargeted = withPragma.replace("article.block-repeated-nearby", "article.image-repeated-nearby");
    expect(validateEditedArticle(withPragma, retargeted).markdown).toBe(retargeted);
    // remove
    expect(validateEditedArticle(withPragma, article).markdown).toBe(article);
    // near-pragma text is still rejected
    const fake = article.replace("Original body text.", "%% validator-ignore-next-line free-form excuse %%\nOriginal body text.");
    expect(() => validateEditedArticle(article, fake)).toThrow("authoring comment");
    // deleting the placeholder is rejected
    const deleted = article.replace("%%\nAdd discussion note here:\n\n...\n\n%%\n", "");
    expect(() => validateEditedArticle(article, deleted)).toThrow("authoring comment");
  });

  it("allows filling in the importer's discussion-note placeholder, keeping its header", () => {
    const filled = article.replace(
      "%%\nAdd discussion note here:\n\n...\n\n%%",
      "%%\nAdd discussion note here:\n\nWhat would change your mind about longtermism?\n%%",
    );
    expect(validateEditedArticle(article, filled).markdown).toBe(filled);
    // later rounds may refine the already-filled note
    const refined = filled.replace("change your mind", "update your view");
    expect(validateEditedArticle(filled, refined).markdown).toBe(refined);
    // dropping the recognizable header is rejected
    const headerless = article.replace(
      "%%\nAdd discussion note here:\n\n...\n\n%%",
      "%%\nDiscussion note:\n\nA note.\n%%",
    );
    expect(() => validateEditedArticle(article, headerless)).toThrow("authoring comment");
    // other authored notes stay protected
    const twoBlocks = `${article}\n%%\nEditor-authored note.\n%%\n`;
    expect(() => validateEditedArticle(twoBlocks, twoBlocks.replace("Editor-authored", "Tampered")))
      .toThrow("authoring comment");
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
