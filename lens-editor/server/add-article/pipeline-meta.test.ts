import { describe, it, expect } from "vitest";
import { ensureRequiredMeta, publisherFromUrl } from "./pipeline";
import type { ArticleMeta } from "./types";

const base: ArticleMeta = {
  title: "T",
  author: [],
  source_url: "https://bluedot.org/join-us/role",
  published: "",
  description: "",
};

describe("publisherFromUrl", () => {
  it("derives a readable publisher from the host", () => {
    expect(publisherFromUrl("https://bluedot.org/x")).toBe("Bluedot");
    expect(publisherFromUrl("https://www.lesswrong.com/posts/abc")).toBe(
      "Lesswrong",
    );
  });

  it("returns empty string for an unparseable url", () => {
    expect(publisherFromUrl("not a url")).toBe("");
  });
});

describe("ensureRequiredMeta", () => {
  // Prevents: empty author/published failing the Lens Edu content validator
  it("fills empty author with the site name", () => {
    const out = ensureRequiredMeta(base, "BlueDot Impact", "2026-06-11");
    expect(out.author).toEqual(["BlueDot Impact"]);
  });

  it("falls back author to the publisher from the URL when no site name", () => {
    const out = ensureRequiredMeta(base, "", "2026-06-11");
    expect(out.author).toEqual(["Bluedot"]);
  });

  it("falls back empty published to the import date", () => {
    const out = ensureRequiredMeta(base, "Site", "2026-06-11");
    expect(out.published).toBe("2026-06-11");
  });

  it("keeps a real author and published untouched", () => {
    const out = ensureRequiredMeta(
      { ...base, author: ["Jane Doe"], published: "2020-01-02" },
      "Site",
      "2026-06-11",
    );
    expect(out.author).toEqual(["Jane Doe"]);
    expect(out.published).toBe("2020-01-02");
  });
});
