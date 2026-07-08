import { describe, it, expect } from "vitest";
import { normalizeUrlForDedup, dedupUrlVariants } from "./url-normalize";

describe("normalizeUrlForDedup", () => {
  // Prevents: the same article queued twice via a utm-tagged share link.
  it("strips tracking parameters but keeps meaningful ones", () => {
    expect(
      normalizeUrlForDedup(
        "https://example.com/post?utm_source=x&utm_medium=y&id=42&fbclid=abc",
      ),
    ).toBe("https://example.com/post?id=42");
  });

  it("folds scheme/host/trailing-slash variants onto one key", () => {
    const key = normalizeUrlForDedup("https://example.com/post");
    expect(normalizeUrlForDedup("http://example.com/post")).toBe(key);
    expect(normalizeUrlForDedup("https://www.example.com/post/")).toBe(key);
    expect(normalizeUrlForDedup("https://EXAMPLE.com/post#section")).toBe(key);
  });

  // Prevents: a GreaterWrong link and its LessWrong original making two jobs.
  it("maps GreaterWrong mirror hosts to their canonical hosts", () => {
    expect(
      normalizeUrlForDedup("https://www.greaterwrong.com/posts/abc/slug"),
    ).toBe("https://lesswrong.com/posts/abc/slug");
    expect(
      normalizeUrlForDedup("https://ea.greaterwrong.com/posts/abc/slug"),
    ).toBe("https://forum.effectivealtruism.org/posts/abc/slug");
  });

  it("passes through non-http(s) and malformed input unchanged", () => {
    expect(normalizeUrlForDedup("not a url")).toBe("not a url");
    expect(normalizeUrlForDedup("ftp://example.com/x")).toBe("ftp://example.com/x");
  });
});

describe("dedupUrlVariants", () => {
  it("returns each URL plus its normalized form, de-duplicated", () => {
    const variants = dedupUrlVariants(
      "https://www.greaterwrong.com/posts/abc/slug",
      "https://www.lesswrong.com/posts/abc/slug",
      undefined,
    );
    expect(variants).toContain("https://www.greaterwrong.com/posts/abc/slug");
    expect(variants).toContain("https://www.lesswrong.com/posts/abc/slug");
    expect(variants).toContain("https://lesswrong.com/posts/abc/slug");
    expect(new Set(variants).size).toBe(variants.length);
  });
});

describe("dedupUrlVariants — www-spelling coverage (reviewer M2)", () => {
  // Prevents: a GreaterWrong submit missing a STORED "https://www.lesswrong…"
  // spelling (the relay compares stored values near-verbatim).
  it("includes www and non-www spellings of each variant", () => {
    const v = dedupUrlVariants("https://www.greaterwrong.com/posts/abc/slug");
    expect(v).toContain("https://lesswrong.com/posts/abc/slug");
    expect(v).toContain("https://www.lesswrong.com/posts/abc/slug");
    expect(v).toContain("https://greaterwrong.com/posts/abc/slug");
  });
});
