import { describe, expect, it, vi } from "vitest";
import { assertArticleValid, isArticleValidationOutage, validateArticleDraft } from "./platform-validation";

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

  it("retries gateway errors and reports the outage when they persist", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn(async () => new Response("<html>bad gateway</html>", { status: 502 }));
      const pending = validateArticleDraft("articles/x.md", "# x", {
        platformUrl: "https://p", secret: "s", fetchImpl,
      }).catch((error: unknown) => error);
      await vi.runAllTimersAsync();
      const error = await pending;
      expect(fetchImpl).toHaveBeenCalledTimes(3);
      expect(String(error)).toMatch(/returned 502/);
      expect(isArticleValidationOutage(error)).toBe(true);
      expect(isArticleValidationOutage(new Error("Article validation service returned 400: nope"))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("recovers when a gateway error clears on retry", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(new Response("gateway", { status: 503 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ valid: true, issues: [], truncated: false, counts: { errors: 0, warnings: 0 } })));
      const pending = validateArticleDraft("articles/x.md", "# x", { platformUrl: "https://p", secret: "s", fetchImpl });
      await vi.runAllTimersAsync();
      expect((await pending).valid).toBe(true);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
