import { describe, it, expect } from "vitest";
import { findAdapter, adapterContext, resolveFetchUrls } from "./index";

const route = (url: string, html = "") =>
  findAdapter(adapterContext(url, html))?.id ?? null;
const fetchUrls = (url: string) => resolveFetchUrls(adapterContext(url, ""));

describe("adapter registry — findAdapter routing", () => {
  it("routes ForumMagnum sites by host (and by DOM marker)", () => {
    expect(route("https://www.lesswrong.com/posts/x/y")).toBe("forum-adapter");
    expect(route("https://www.alignmentforum.org/posts/x/y")).toBe("forum-adapter");
    expect(route("https://forum.effectivealtruism.org/posts/x/y")).toBe("forum-adapter");
    // A self-hosted ForumMagnum instance, detected by the body class.
    expect(route("https://example.org/p", '<div class="PostsPage-postContent">')).toBe("forum-adapter");
  });

  it("routes Wikipedia by host", () => {
    expect(route("https://en.wikipedia.org/wiki/Foo")).toBe("wikipedia");
    expect(route("https://de.wikipedia.org/wiki/Foo")).toBe("wikipedia");
  });

  it("routes AI Safety Atlas chapter pages only", () => {
    expect(route("https://ai-safety-atlas.com/chapters/v1/governance/compute-governance")).toBe("ai-safety-atlas");
    // The /read/ landing index is not a chapter — no adapter (falls to generic).
    expect(route("https://ai-safety-atlas.com/read/")).toBeNull();
    expect(route("https://ai-safety-atlas.com/brand")).toBeNull();
  });

  it("routes arXiv and ar5iv hosts", () => {
    expect(route("https://arxiv.org/abs/1805.00899")).toBe("arxiv");
    expect(route("https://arxiv.org/pdf/0706.3639.pdf")).toBe("arxiv");
    expect(route("https://ar5iv.labs.arxiv.org/html/1805.00899")).toBe("arxiv");
  });

  it("returns null for unknown sites", () => {
    expect(route("https://example.com/some-article")).toBeNull();
    expect(route("not a url")).toBeNull();
  });
});

describe("adapter registry — resolveFetchUrls", () => {
  it("redirects arXiv abstract/pdf URLs to full-text HTML (arxiv.org/html, then ar5iv)", () => {
    expect(fetchUrls("https://arxiv.org/abs/1805.00899v2")).toEqual([
      "https://arxiv.org/html/1805.00899",
      "https://ar5iv.labs.arxiv.org/html/1805.00899",
    ]);
    expect(fetchUrls("https://arxiv.org/pdf/0706.3639.pdf")).toEqual([
      "https://arxiv.org/html/0706.3639",
      "https://ar5iv.labs.arxiv.org/html/0706.3639",
    ]);
  });

  it("does not redirect AI Safety Atlas chapters (the .md body is fetched during extraction, not here)", () => {
    expect(fetchUrls("https://ai-safety-atlas.com/chapters/v1/evaluations/benchmarks")).toEqual([
      "https://ai-safety-atlas.com/chapters/v1/evaluations/benchmarks",
    ]);
  });

  it("does not redirect an already-ar5iv URL or a non-arXiv URL", () => {
    expect(fetchUrls("https://ar5iv.labs.arxiv.org/html/1805.00899")).toEqual([
      "https://ar5iv.labs.arxiv.org/html/1805.00899",
    ]);
    expect(fetchUrls("https://example.com/post")).toEqual([
      "https://example.com/post",
    ]);
  });
});
