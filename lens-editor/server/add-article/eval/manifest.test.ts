import { describe, it, expect } from "vitest";
import { classifyVia, stratifiedSelect, type ManifestEntry } from "./manifest";

describe("classifyVia", () => {
  it("maps hosts to expected extraction path", () => {
    expect(classifyVia("https://www.lesswrong.com/posts/x")).toBe("forum-adapter");
    expect(classifyVia("https://en.wikipedia.org/wiki/X")).toBe("wikipedia");
    expect(classifyVia("https://ai-safety-atlas.com/chapters/v1/x")).toBe("ai-safety-atlas");
    expect(classifyVia("https://arxiv.org/abs/1805.00899")).toBe("arxiv");
    expect(classifyVia("https://cold-takes.com/x")).toBe("generic");
  });
});

describe("stratifiedSelect", () => {
  it("spreads selection across vias and caps at target", () => {
    const mk = (i: number, via: string): ManifestEntry => ({
      slug: `s${i}`, relay_path: `p${i}`, source_url: `u${i}`, resolved_fetch_url: `u${i}`,
      host: "h", expected_via: via, needs_body_markdown: false, status: "ok",
    });
    const entries = [
      ...Array.from({ length: 10 }, (_, i) => mk(i, "forum-adapter")),
      ...Array.from({ length: 2 }, (_, i) => mk(100 + i, "wikipedia")),
    ];
    const picked = stratifiedSelect(entries, 6);
    expect(picked.length).toBe(6);
    // both wikipedia entries kept (scarce class not starved)
    expect(picked.filter((e) => e.expected_via === "wikipedia").length).toBe(2);
  });
});
