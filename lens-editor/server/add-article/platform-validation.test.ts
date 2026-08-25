import { describe, expect, it, vi } from "vitest";
import { assertArticleValid, validateArticleDraft } from "./platform-validation";

describe("validateArticleDraft", () => {
  it("sends a complete cross-machine draft with authentication", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      valid: true, issues: [], truncated: false, counts: { errors: 0, warnings: 0 },
    })));
    const result = await validateArticleDraft("articles/a.md", "---\n---\n", {
      platformUrl: "https://platform.test/", secret: "secret", fetchImpl,
    });
    expect(result.valid).toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://platform.test/api/content/validate-article",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "X-Validation-Key": "secret" }),
        body: JSON.stringify({ path: "articles/a.md", content: "---\n---\n" }),
      }),
    );
  });

  it("fails closed on malformed responses and invalid drafts", async () => {
    await expect(validateArticleDraft("articles/a.md", "x", {
      platformUrl: "https://p", secret: "s", fetchImpl: vi.fn(async () => new Response("{}")),
    })).rejects.toThrow("invalid response shape");
    expect(() => assertArticleValid({
      valid: false, truncated: false, counts: { errors: 1, warnings: 0 },
      issues: [{ code: "article.bad", severity: "error", path: "articles/a.md", line: 2, message: "bad" }],
    })).toThrow("article.bad at line 2");
  });
});
