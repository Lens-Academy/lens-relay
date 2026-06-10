import { describe, it, expect } from "vitest";
import { parseJinaResponse, extractHtmlMeta } from "./fetch";

describe("parseJinaResponse", () => {
  it("parses title, published date, and markdown content", () => {
    const resp = [
      "Title: Takeoff Speeds",
      "URL Source: https://sideways-view.com/2018/02/24/takeoff-speeds/",
      "Published Time: 2018-02-24T12:00:00.000Z",
      "Markdown Content:",
      "# Heading",
      "",
      "Some text.",
    ].join("\n");

    const result = parseJinaResponse(resp);
    expect(result.title).toBe("Takeoff Speeds");
    expect(result.published).toBe("2018-02-24");
    expect(result.markdown).toBe("# Heading\n\nSome text.");
  });

  it("handles missing published time", () => {
    const result = parseJinaResponse("Title: X\nMarkdown Content:\nbody");
    expect(result.published).toBe("");
    expect(result.markdown).toBe("body");
  });

  // Prevents: treating an error page / empty response as a successful extraction
  it("returns empty markdown when no content marker present", () => {
    const result = parseJinaResponse("Some random error text");
    expect(result.markdown).toBe("");
    expect(result.title).toBe("");
  });
});

describe("extractHtmlMeta", () => {
  it("extracts og:title, author, published date, and description", () => {
    const html = `<html><head>
      <title>Fallback Title - Site</title>
      <meta property="og:title" content="Real Title" />
      <meta name="author" content="Jane Doe" />
      <meta property="article:published_time" content="2020-01-15T08:00:00Z" />
      <meta property="og:description" content="A description." />
    </head><body></body></html>`;

    const meta = extractHtmlMeta(html);
    expect(meta.title).toBe("Real Title");
    expect(meta.author).toEqual(["Jane Doe"]);
    expect(meta.published).toBe("2020-01-15");
    expect(meta.description).toBe("A description.");
  });

  it("falls back to <title> tag and handles reversed attribute order", () => {
    const html = `<head>
      <title>Only Title</title>
      <meta content="2021-03-01" property="article:published_time">
    </head>`;
    const meta = extractHtmlMeta(html);
    expect(meta.title).toBe("Only Title");
    expect(meta.published).toBe("2021-03-01");
  });

  it("reads author and date from JSON-LD", () => {
    const html = `<head><script type="application/ld+json">
      {"@type": "BlogPosting", "headline": "LD Title",
       "author": [{"@type": "Person", "name": "Alice"}, {"@type": "Person", "name": "Bob"}],
       "datePublished": "2019-06-01T00:00:00Z"}
    </script></head>`;
    const meta = extractHtmlMeta(html);
    expect(meta.title).toBe("LD Title");
    expect(meta.author).toEqual(["Alice", "Bob"]);
    expect(meta.published).toBe("2019-06-01");
  });

  // Prevents: author field set to a URL (common with article:author pointing at a profile)
  it("ignores author values that are URLs", () => {
    const html = `<meta property="article:author" content="https://facebook.com/someone">`;
    expect(extractHtmlMeta(html).author).toEqual([]);
  });

  // Prevents: crash on malformed JSON-LD blocks
  it("survives malformed JSON-LD", () => {
    const html = `<script type="application/ld+json">{not json</script><title>T</title>`;
    expect(extractHtmlMeta(html).title).toBe("T");
  });

  it("decodes HTML entities in extracted values", () => {
    const html = `<meta property="og:title" content="Tom &amp; Jerry&#39;s Guide" />`;
    expect(extractHtmlMeta(html).title).toBe("Tom & Jerry's Guide");
  });
});
