import { describe, it, expect } from "vitest";
import { extractHtmlMeta, dateFromUrl, looksLikePdf } from "./fetch";

const buf = (s: string): ArrayBuffer => new TextEncoder().encode(s).buffer;

describe("dateFromUrl", () => {
  it("extracts a real date embedded in the URL path", () => {
    expect(dateFromUrl("https://site.com/2017/02/14/post")).toBe("2017-02-14");
    expect(dateFromUrl("https://site.com/2016/09/post")).toBe("2016-09-01");
  });

  it("rejects path segments that aren't valid months/days (issue/volume numbers)", () => {
    expect(dateFromUrl("https://site.com/2020/45/thing")).toBe("");
    expect(dateFromUrl("https://site.com/2020/13/article")).toBe("");
    expect(dateFromUrl("https://site.com/no/date/here")).toBe("");
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

  it("reads repeated citation_author tags in either attribute order", () => {
    const html = `<head>
      <meta name="citation_author" content="Doe, Jane">
      <meta content="Smith, John" name="citation_author">
    </head>`;
    // "Last, First" is flipped; content-first attribute order must not be dropped.
    expect(extractHtmlMeta(html).author).toEqual(["Jane Doe", "John Smith"]);
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

  // Prevents: empty author on org pages — grab publication name for fallback
  it("extracts site name from og:site_name and JSON-LD publisher", () => {
    expect(
      extractHtmlMeta('<meta property="og:site_name" content="BlueDot Impact">')
        .siteName,
    ).toBe("BlueDot Impact");
    const ld = `<script type="application/ld+json">{"@type":"NewsArticle","publisher":{"@type":"Organization","name":"The Verge"}}</script>`;
    expect(extractHtmlMeta(ld).siteName).toBe("The Verge");
  });

  // Prevents: dateless pages — fall back to modified time so published isn't empty
  it("falls back to modified time when no published date", () => {
    expect(
      extractHtmlMeta(
        '<meta property="article:modified_time" content="2022-05-09T10:00:00Z">',
      ).published,
    ).toBe("2022-05-09");
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

describe("looksLikePdf", () => {
  it("detects via content-type", () => {
    expect(looksLikePdf("application/pdf", buf("anything"))).toBe(true);
    expect(looksLikePdf("application/pdf; charset=binary", buf("x"))).toBe(true);
  });
  it("detects the %PDF- header, including a few junk bytes before it", () => {
    expect(looksLikePdf("", buf("%PDF-1.7\n…"))).toBe(true);
    expect(looksLikePdf("application/octet-stream", buf("\n\n %PDF-1.4"))).toBe(true);
  });
  it("is false for HTML / non-PDF content", () => {
    expect(looksLikePdf("text/html", buf("<!doctype html><html>…"))).toBe(false);
    expect(looksLikePdf("", buf("Just some text"))).toBe(false);
  });
});
