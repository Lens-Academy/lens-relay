import { describe, expect, it } from "vitest";
import { articleReviewDigest, canonicalArticleForReview } from "./review-digest";

describe("article review digest", () => {
  it("ignores provenance, CRLF, comments, and trailing whitespace", () => {
    const a = "---\r\ntitle: A\r\nllm_reviewed: 2026-08-19\r\nllm_review_digest: x\r\n---\r\n\r\n%%\r\nnote\r\n%%\r\n\r\nBody  \r\n";
    const b = "---\ntitle: A\n---\n\nBody\n";
    expect(canonicalArticleForReview(a)).toBe(canonicalArticleForReview(b));
    expect(articleReviewDigest(a)).toBe(articleReviewDigest(b));
    expect(articleReviewDigest(b)).toBe("sha256:f4bcd7583fd58f1942b6579720542e38979e0e7b8855c3c9d1de338fe3260420");
  });

  it("ignores nested review provenance without removing following metadata", () => {
    const stamped = `---
title: A
llm-review:
  content-sha: "sha256:article"
  date: 2026-08-24
  model: "sonnet"
  version: "article-qc-v1"
  source:
    content-sha: "sha256:source"
    fetched: 2026-08-24
    kind: "live"
description: Kept
---

Body
`;
    const unstamped = "---\ntitle: A\ndescription: Kept\n---\n\nBody\n";
    expect(canonicalArticleForReview(stamped)).toBe(canonicalArticleForReview(unstamped));
    expect(articleReviewDigest(stamped)).toBe(articleReviewDigest(unstamped));
  });

  it("hashes the accepted CriticMarkup view", () => {
    expect(canonicalArticleForReview("Old {--bad--}{++good++}.\n")).toBe("Old good.\n");
  });
});
