import { describe, it, expect } from "vitest";
import { atlasMarkdownUrl } from "./atlas-md-url";

describe("atlasMarkdownUrl", () => {
  it("mirrors the adapter: strip query/hash/trailing slash, append .md", () => {
    expect(atlasMarkdownUrl("https://ai-safety-atlas.com/chapters/v1/x/")).toBe(
      "https://ai-safety-atlas.com/chapters/v1/x.md",
    );
    expect(atlasMarkdownUrl("https://ai-safety-atlas.com/chapters/v1/x?a=1#h")).toBe(
      "https://ai-safety-atlas.com/chapters/v1/x.md",
    );
  });
});
