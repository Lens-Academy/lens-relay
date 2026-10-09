import { describe, it, expect } from "vitest";
import { acceptsFetchedHtml, acceptsFetchedUrl, findAdapter, adapterContext, resolveFetchUrls } from "./index";

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
  it("redirects arXiv abstract/pdf URLs to the e-print LaTeX, then full-text HTML (arxiv.org/html, then ar5iv), then the PDF", () => {
    expect(fetchUrls("https://arxiv.org/abs/1805.00899v2")).toEqual([
      "https://arxiv.org/e-print/1805.00899",
      "https://arxiv.org/html/1805.00899",
      "https://ar5iv.labs.arxiv.org/html/1805.00899",
      "https://arxiv.org/pdf/1805.00899",
    ]);
    expect(fetchUrls("https://arxiv.org/pdf/0706.3639.pdf")).toEqual([
      "https://arxiv.org/e-print/0706.3639",
      "https://arxiv.org/html/0706.3639",
      "https://ar5iv.labs.arxiv.org/html/0706.3639",
      "https://arxiv.org/pdf/0706.3639",
    ]);
  });

  it("vetoes LaTeXML pages that died part-way or never converted", () => {
    const ctx = adapterContext("https://arxiv.org/abs/1710.05060", "");
    // FDT on ar5iv: the paper up to section 5, then this banner.
    const truncated = `<html><body><article><p>${"text ".repeat(500)}</p></article><div class="ltx_page_logo">Conversion to HTML had a Fatal error and exited abruptly. This document may be truncated or damaged.</div></body></html>`;
    // Compact Proofs on ar5iv: HTTP 200, no paper.
    const empty = `<html><body>\n    <div class="ltx_page_main">\n No content available \n</div></body></html>`;
    expect(acceptsFetchedHtml(ctx, truncated)).toBe(false);
    expect(acceptsFetchedHtml(ctx, empty)).toBe(false);
    expect(acceptsFetchedHtml(ctx, `<html><body><article>${"whole paper ".repeat(100)}</article></body></html>`)).toBe(true);
    expect(acceptsFetchedHtml(adapterContext("https://example.org/post", ""), truncated)).toBe(true);
  });

  it("reads LessWrong and Alignment Forum posts and wiki pages through the GraphQL API first", () => {
    const post = "https://www.lesswrong.com/posts/TTFsKxQThrqgWeXYJ/how-might-we-safely-pass-the-buck-to-ai";
    const urls = fetchUrls(post);
    expect(urls).toHaveLength(3);
    expect(urls[0]).toMatch(/^https:\/\/www\.lesswrong\.com\/graphql\?query=/);
    expect(decodeURIComponent(urls[0])).toContain('post(selector: {_id: "TTFsKxQThrqgWeXYJ"})');
    expect(urls.slice(1)).toEqual([post, "https://www.greaterwrong.com/posts/TTFsKxQThrqgWeXYJ/how-might-we-safely-pass-the-buck-to-ai"]);
    const wiki = fetchUrls("https://www.lesswrong.com/w/updateless-decision-theory");
    expect(decodeURIComponent(wiki[0])).toContain('tagBySlug: {slug: "updateless-decision-theory"}');
    expect(wiki[1]).toBe("https://www.lesswrong.com/w/updateless-decision-theory");
    expect(fetchUrls("https://www.alignmentforum.org/posts/abcdEFGH12345678/x")[0]).toMatch(
      /^https:\/\/www\.alignmentforum\.org\/graphql\?query=/,
    );
    // The EA Forum's API has another schema: page fetch and mirror only.
    expect(fetchUrls("https://forum.effectivealtruism.org/posts/abcdEFGH12345678/x")[0]).toBe(
      "https://forum.effectivealtruism.org/posts/abcdEFGH12345678/x",
    );
  });

  it("vetoes an arXiv HTML candidate that redirected to the abstract landing page", () => {
    const ctx = adapterContext("https://arxiv.org/abs/1805.00899", "");
    expect(acceptsFetchedUrl(ctx, "https://arxiv.org/abs/1805.00899v2")).toBe(false);
    expect(acceptsFetchedUrl(ctx, "https://ar5iv.labs.arxiv.org/html/1805.00899")).toBe(true);
    expect(acceptsFetchedUrl(ctx, "https://arxiv.org/pdf/1805.00899v2")).toBe(true);
    expect(acceptsFetchedUrl(adapterContext("https://example.org/post", ""), "https://example.org/final")).toBe(true);
  });

  it("does not redirect AI Safety Atlas chapters (the .md body is fetched during extraction, not here)", () => {
    expect(fetchUrls("https://ai-safety-atlas.com/chapters/v1/evaluations/benchmarks")).toEqual([
      "https://ai-safety-atlas.com/chapters/v1/evaluations/benchmarks",
    ]);
  });

  it("normalizes a section-level Atlas .md submission to its companion HTML page", () => {
    expect(fetchUrls("https://ai-safety-atlas.com/chapters/v1/evaluations/benchmarks.md")).toEqual([
      "https://ai-safety-atlas.com/chapters/v1/evaluations/benchmarks/",
    ]);
  });

  it("rejects a whole-chapter Atlas Markdown download as an article", () => {
    expect(() =>
      fetchUrls("https://ai-safety-atlas.com/chapters/v1/evaluations.md"),
    ).toThrow(/specific.*section/i);
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
