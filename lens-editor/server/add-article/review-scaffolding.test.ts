import { describe, expect, it } from "vitest";
import { normalizeReviewScaffolding } from "./review-scaffolding";

describe("normalizeReviewScaffolding", () => {
  it("keeps one blank line before a leading authoring comment", () => {
    const input = "---\ntitle: A\n---\n\n\n%%\nnote\n%%\n\nBody\n";
    const expected = "---\ntitle: A\n---\n\n%%\nnote\n%%\n\nBody\n";
    expect(normalizeReviewScaffolding(input)).toBe(expected);
    expect(normalizeReviewScaffolding(expected)).toBe(expected);
  });

  it("preserves CRLF and is idempotent", () => {
    const input = "---\r\ntitle: A\r\n---\r\n\r\n\r\n%%\r\nnote\r\n%%\r\n";
    const expected = "---\r\ntitle: A\r\n---\r\n\r\n%%\r\nnote\r\n%%\r\n";
    expect(normalizeReviewScaffolding(input)).toBe(expected);
    expect(normalizeReviewScaffolding(expected)).toBe(expected);
  });

  it.each([
    "---\ntitle: A\n---\n\n\nBody\n",
    "---\ntitle: A\n---\n\n%%\nnote\n%%\n\nBody\n\n\nLater\n",
    "No frontmatter\n\n\n%%\nnote\n%%\n",
  ])("does not rewrite unrelated spacing", (input) => {
    expect(normalizeReviewScaffolding(input)).toBe(input);
  });
});
