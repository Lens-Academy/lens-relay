import { describe, it, expect } from "vitest";
import { applyVerdictMeta } from "./claude";
import type { ArticleMeta } from "./types";

const base: ArticleMeta = {
  title: "Old Title",
  author: ["Harvard Business Review"],
  source_url: "https://hbr.org/x",
  published: "2026-06-16",
  description: "",
};

describe("applyVerdictMeta", () => {
  it("replaces a publisher-as-author with the real author names", () => {
    const out = applyVerdictMeta(base, {
      status: "ok",
      author: ["Herminia Ibarra", "Claudius Hildebrand"],
    });
    expect(out.author).toEqual(["Herminia Ibarra", "Claudius Hildebrand"]);
  });

  it("keeps the deterministic author when the verdict author is empty/missing", () => {
    expect(applyVerdictMeta(base, { status: "ok", author: [] }).author).toEqual([
      "Harvard Business Review",
    ]);
    expect(applyVerdictMeta(base, { status: "ok" }).author).toEqual([
      "Harvard Business Review",
    ]);
  });

  it("accepts a well-formed date and rejects a malformed one", () => {
    expect(applyVerdictMeta(base, { status: "ok", published: "2023-05-01" }).published).toBe("2023-05-01");
    expect(applyVerdictMeta(base, { status: "ok", published: "May 2023" }).published).toBe("2026-06-16");
  });

  it("overrides the title only when a non-blank value is given", () => {
    expect(applyVerdictMeta(base, { status: "ok", title: "Real Title" }).title).toBe("Real Title");
    expect(applyVerdictMeta(base, { status: "ok", title: "   " }).title).toBe("Old Title");
  });
});
