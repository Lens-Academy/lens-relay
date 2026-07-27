import { describe, it, expect } from "vitest";
import {
  isVideoEmbedUrl,
  videoEmbedIframe,
  decodeTextEntities,
  stripSiteSuffix,
} from "./util";

describe("decodeTextEntities", () => {
  it("decodes residual entities Readability leaves in h1-derived titles", () => {
    expect(
      decodeTextEntities("How AI could create the world’s biggest&nbsp;problems"),
    ).toBe("How AI could create the world’s biggest problems");
    expect(decodeTextEntities("Tom&nbsp;&amp;&nbsp;Jerry")).toBe("Tom & Jerry");
    expect(decodeTextEntities("A&#8217;s &#x2019;quoted&quot; bit")).toBe(
      "A’s ’quoted\" bit",
    );
  });

  it("decodes double-escaped input one level and leaves clean text alone", () => {
    // "&amp;nbsp;" is one escaping level up — a single pass yields the entity
    // text, not a surprise double-decode to whitespace.
    expect(decodeTextEntities("a&amp;nbsp;b")).toBe("a&nbsp;b");
    expect(decodeTextEntities("Q&A at AT&T")).toBe("Q&A at AT&T");
    expect(decodeTextEntities("unknown &zzz; stays")).toBe("unknown &zzz; stays");
  });

  it("decodes the numeric ampersand exactly like the named one (single pass)", () => {
    expect(decodeTextEntities("a&#38;nbsp;b")).toBe("a&nbsp;b");
  });

  it("refuses control characters and lone surrogates from numeric references", () => {
    expect(decodeTextEntities("Bad&#0;title&#8;x")).toBe("Badtitlex");
    expect(decodeTextEntities("A&#xD800;B")).toBe("AB");
    expect(decodeTextEntities("big&#99999999999;end")).toBe("bigend");
  });

  it("strips zero-width and bidi-control characters", () => {
    expect(decodeTextEntities("evil\u202etxt.gpj\u202c name\u200b")).toBe(
      "eviltxt.gpj name",
    );
  });

  it("turns NBSP characters into plain spaces and collapses whitespace", () => {
    expect(decodeTextEntities("a\u00a0b\n  c")).toBe("a b c");
  });
});

describe("stripSiteSuffix — entity decode and separator shape", () => {
  it("decodes entities and strips the site suffix", () => {
    expect(stripSiteSuffix("Big&nbsp;title — LessWrong")).toBe("Big title");
  });

  it("decodes BEFORE stripping so an entity-encoded separator can't smuggle the suffix", () => {
    expect(stripSiteSuffix("My Post &mdash; LessWrong")).toBe("My Post");
    expect(stripSiteSuffix("My Post &#8212; LessWrong")).toBe("My Post");
  });

  it("does not eat hyphenated compounds ending in a site name", () => {
    expect(stripSiteSuffix("E-LessWrong")).toBe("E-LessWrong");
    expect(stripSiteSuffix("Anti-EA Forum")).toBe("Anti-EA Forum");
    expect(stripSiteSuffix("A Post - LessWrong")).toBe("A Post");
    expect(stripSiteSuffix("A Post—LessWrong")).toBe("A Post");
  });
});

describe("isVideoEmbedUrl — exact hostname allow-list", () => {
  it("accepts real YouTube / Vimeo embeds", () => {
    for (const ok of [
      "https://www.youtube-nocookie.com/embed/kK3NmQT241w",
      "https://www.youtube.com/embed/abc123",
      "https://youtube.com/embed/abc123",
      "https://youtu.be/abc123",
      "https://player.vimeo.com/video/123456",
      "https://vimeo.com/123456",
      "//www.youtube.com/embed/x", // protocol-relative resolves to https
    ]) {
      expect(isVideoEmbedUrl(ok)).toBe(true);
    }
  });

  it("rejects look-alike hosts and injection vectors that a substring match would pass", () => {
    const bad: (string | null | undefined)[] = [
      "https://vimeo.com.evil.com/pwn", // allow-listed string as a label prefix
      "https://youtube.com.attacker.net/x",
      "https://notyoutube.com/embed/x", // "youtube.com" is a substring
      "https://evil.com/x?youtube.com", // in the query string
      "https://attacker.net/youtu.be/x", // in the path
      "javascript:alert(1)//youtube.com", // non-http scheme
      "data:text/html,<b>youtube.com</b>",
      "embed/x", // relative → throwaway base host
      "",
      null,
      undefined,
    ];
    for (const b of bad) {
      expect(isVideoEmbedUrl(b)).toBe(false);
    }
  });
});

describe("videoEmbedIframe", () => {
  it("emits a normalized absolute-https iframe for a valid embed", () => {
    const html = videoEmbedIframe("//www.youtube.com/embed/abc123");
    expect(html).toContain('src="https://www.youtube.com/embed/abc123"');
    expect(html).toContain("allowfullscreen");
  });

  it("strips quotes / can't break out of the src attribute", () => {
    // A would-be breakout src is normalized through URL(); the emitted href
    // is %-encoded so no raw quote survives to break the attribute.
    const html = videoEmbedIframe('https://www.youtube.com/embed/x"></iframe><script>1</script>');
    expect(html).not.toContain('"></iframe><script>');
    expect(html.match(/<iframe/g)?.length).toBe(1);
  });
});
