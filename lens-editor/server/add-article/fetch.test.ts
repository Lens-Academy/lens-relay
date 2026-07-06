import { describe, it, expect } from "vitest";
import {
  extractHtmlMeta,
  dateFromUrl,
  yearFromUrl,
  looksLikePdf,
} from "./fetch";

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

describe("yearFromUrl", () => {
  it("extracts a standalone year path segment (proceedings-style URLs)", () => {
    expect(
      yearFromUrl(
        "https://proceedings.neurips.cc/paper_files/paper/2017/file/abc-Paper.pdf",
      ),
    ).toBe("2017-01-01");
    expect(yearFromUrl("https://x.org/reports/2021")).toBe("2021-01-01");
  });

  it("does not match year-like substrings that aren't standalone segments", () => {
    expect(yearFromUrl("https://x.org/files/v2017final.pdf")).toBe("");
    expect(yearFromUrl("https://x.org/paper/12345/file.pdf")).toBe("");
    expect(yearFromUrl("https://x.org/no/year/here")).toBe("");
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

  // Prevents: wrong publication YEAR from edit timestamps — a 2021 post edited
  // in 2023 was imported as published 2023-05-31. Modified time is a
  // modification date, not a publication date; leave published empty instead
  // (the pipeline falls back to the import date, which a curator can correct).
  it("does NOT use modified time as the published date", () => {
    expect(
      extractHtmlMeta(
        '<meta property="article:modified_time" content="2022-05-09T10:00:00Z">',
      ).published,
    ).toBe("");
  });

  // Prevents: comment timestamps read as the publish date — a bare <time> is
  // only trusted when it's the page's single time element.
  it("uses a lone <time datetime> but not one among many", () => {
    expect(
      extractHtmlMeta('<time datetime="2021-04-07T20:12:00Z">7 Apr</time>')
        .published,
    ).toBe("2021-04-07");
    expect(
      extractHtmlMeta(
        '<time datetime="2021-04-07T20:12:00Z">post</time>' +
          '<time datetime="2023-05-31T00:00:00Z">comment</time>',
      ).published,
    ).toBe("");
  });

  // Prevents: mirror/AMP/tracking URLs cited as source_url — the page's own
  // canonical link is recovered for citation + duplicate detection.
  it("extracts the canonical URL when absolute", () => {
    expect(
      extractHtmlMeta(
        '<link rel="canonical" href="https://example.com/posts/abc" />',
      ).canonicalUrl,
    ).toBe("https://example.com/posts/abc");
    expect(
      extractHtmlMeta('<link href="https://example.com/x" rel="canonical">')
        .canonicalUrl,
    ).toBe("https://example.com/x");
    // relative canonicals are ignored (can't be trusted without a base URL)
    expect(
      extractHtmlMeta('<link rel="canonical" href="/posts/abc">').canonicalUrl,
    ).toBe("");
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

describe("normalizeDate hardening", () => {
  // Prevents: junk meta values fabricating plausible dates ("7" → 2001-06-30).
  it("rejects values without an explicit 4-digit year", () => {
    expect(extractHtmlMeta('<meta name="date" content="7">').published).toBe("");
    expect(extractHtmlMeta('<meta name="date" content="99">').published).toBe("");
    expect(extractHtmlMeta('<meta name="date" content="0">').published).toBe("");
  });

  it("still parses textual dates with a real year", () => {
    expect(
      extractHtmlMeta('<meta name="date" content="January 5, 2024">').published,
    ).toBe("2024-01-05");
  });

  // Prevents: JSON-LD dateModified reintroducing the wrong-year bug the
  // meta-tag chain already guards against.
  it("ignores JSON-LD dateModified as a published date", () => {
    const ld = `<script type="application/ld+json">{"@type":"BlogPosting","dateModified":"2023-05-31"}</script>`;
    expect(extractHtmlMeta(ld).published).toBe("");
    const ld2 = `<script type="application/ld+json">{"@type":"BlogPosting","datePublished":"2021-04-07"}</script>`;
    expect(extractHtmlMeta(ld2).published).toBe("2021-04-07");
  });
});
