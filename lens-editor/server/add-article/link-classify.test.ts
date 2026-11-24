import { describe, expect, it } from "vitest";
import cases from "../../shared/external-link-cases.json";
import { classifySourceLink } from "./link-classify";

describe("classifySourceLink", () => {
  it.each(cases.classify)("$url is $kind", ({ url, kind }) => {
    expect(classifySourceLink(url)).toBe(kind);
  });

  it("skips a subdomain of a skipped host, and ignores a trailing dot on a host", () => {
    expect(classifySourceLink("https://gist.github.com/a/b")).toBeNull();
    expect(classifySourceLink("https://github.com./a/b")).toBeNull();
  });

  it("settles the YouTube rule before the extension and home-page rules", () => {
    expect(classifySourceLink("https://youtu.be/abcdefghijk")).toBe("video");
    expect(classifySourceLink("https://www.youtube.com/embed/abcdefghijk")).toBe("video");
    expect(classifySourceLink("https://www.youtube.com/live/abcdefghijk")).toBe("video");
    expect(classifySourceLink("https://www.youtube.com/")).toBeNull();
  });

  it("counts a fragment as neither path nor query", () => {
    expect(classifySourceLink("https://example.com/#section")).toBeNull();
  });

  it("takes something that isn't a URL as not a source", () => {
    expect(classifySourceLink("not a url")).toBeNull();
    expect(classifySourceLink("")).toBeNull();
  });
});
