import { describe, it, expect } from "vitest";
import { normalizeUrlForDedup, dedupUrlVariants, sameSource } from "./url-normalize";

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

  // Prevents: a comment queued twice, once per spelling, or folded onto its post.
  it("folds both spellings of a forum comment onto one key, distinct from the post", () => {
    const key = normalizeUrlForDedup(
      "https://www.lesswrong.com/posts/8wBN8cdNAv3c7vt6p/the-case?commentId=FpZmBx2Q4eswZWmy6",
    );
    expect(key).toBe("https://lesswrong.com/posts/8wBN8cdNAv3c7vt6p/the-case?commentId=FpZmBx2Q4eswZWmy6");
    expect(
      normalizeUrlForDedup("https://www.greaterwrong.com/posts/8wBN8cdNAv3c7vt6p/the-case/comment/FpZmBx2Q4eswZWmy6"),
    ).toBe(key);
    expect(normalizeUrlForDedup("https://www.lesswrong.com/posts/8wBN8cdNAv3c7vt6p/the-case")).not.toBe(key);
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
  // Prevents: re-importing a comment already stored under its other spelling.
  it("checks a forum comment under its ?commentId= and GreaterWrong spellings", () => {
    const v = dedupUrlVariants(
      "https://www.lesswrong.com/posts/8wBN8cdNAv3c7vt6p/the-case?commentId=FpZmBx2Q4eswZWmy6",
    );
    expect(v).toContain("https://www.greaterwrong.com/posts/8wBN8cdNAv3c7vt6p/the-case/comment/FpZmBx2Q4eswZWmy6");
    expect(v).not.toContain("https://www.lesswrong.com/posts/8wBN8cdNAv3c7vt6p/the-case");
    expect(
      dedupUrlVariants("https://www.greaterwrong.com/posts/8wBN8cdNAv3c7vt6p/the-case/comment/FpZmBx2Q4eswZWmy6"),
    ).toContain("https://www.lesswrong.com/posts/8wBN8cdNAv3c7vt6p/the-case?commentId=FpZmBx2Q4eswZWmy6");
  });

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

describe("sameSource", () => {
  const base = "https://example.com/view";

  it.each([
    ["itself", base, base],
    ["utm tags", `${base}?utm_source=x`, base],
    ["a trailing slash, www and http", "http://www.example.com/view/", base],
    ["an ordinary fragment", `${base}#section-2`, base],
    ["the GreaterWrong mirror", "https://www.greaterwrong.com/posts/abc/t", "https://www.lesswrong.com/posts/abc/t"],
    ["a ref only the link has", `${base}?ref=hn`, base],
    ["a ref only the stored URL has", base, `${base}?ref=hn`],
    ["the same ref", `${base}?ref=111`, `${base}?ref=111`],
    ["the same port", "https://example.com:8443/view", "https://example.com:8443/view"],
    ["the same route", `${base}#/a`, `${base}#/a`],
    ["the same hashbang route", `${base}#!/a`, `${base}#!/a`],
    ["a default port written out", "https://example.com:443/view", base],
  ])("matches %s", (_name, url, stored) => {
    expect(sameSource(url, stored)).toBe(true);
  });

  it.each([
    ["different pages", `${base}/other`, base],
    ["different ports", "https://example.com:8443/view", "https://example.com:9443/view"],
    ["a port only one has", "https://example.com:8443/view", base],
    ["different refs", `${base}?ref=111`, `${base}?ref=222`],
    ["different routes", `${base}#/a`, `${base}#/b`],
    ["different hashbang routes", `${base}#!a`, `${base}#!b`],
    ["a route only the link has", `${base}#/a`, base],
    ["a route only the stored URL has", base, `${base}#/a`],
    ["a forum comment and its post", "https://www.lesswrong.com/posts/abc/t?commentId=c1", "https://www.lesswrong.com/posts/abc/t"],
  ])("refuses %s", (_name, url, stored) => {
    expect(sameSource(url, stored)).toBe(false);
  });

  it("leaves YouTube to the video id", () => {
    const stored = "https://www.youtube.com/watch?v=abcdefghijk";
    expect(sameSource("https://youtu.be/abcdefghijk?si=x", stored)).toBe(true);
    expect(sameSource("https://www.youtube.com/watch?v=abcdefghijk&t=30#/x", stored)).toBe(true);
    expect(sameSource("https://www.youtube.com/watch?v=abcdefghijk&ref=1", `${stored}&ref=2`)).toBe(true);
    expect(sameSource("https://youtu.be/zzzzzzzzzzz", stored)).toBe(false);
  });

  it("compares text that isn't a URL as text", () => {
    expect(sameSource("not a url", "not a url")).toBe(true);
    expect(sameSource("not a url", "something else")).toBe(false);
  });
});
