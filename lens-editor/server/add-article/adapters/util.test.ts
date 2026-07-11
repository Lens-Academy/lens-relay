import { describe, it, expect } from "vitest";
import { isVideoEmbedUrl, videoEmbedIframe, stripSiteSuffix } from "./util";

describe("stripSiteSuffix", () => {
  it("strips known community-site suffixes with no context (tier 1)", () => {
    expect(stripSiteSuffix("Pythia — LessWrong")).toBe("Pythia");
    expect(stripSiteSuffix("Foo - AI Alignment Forum")).toBe("Foo");
    expect(stripSiteSuffix("Bar | EA Forum")).toBe("Bar");
  });

  it("strips a suffix matching the URL host base (LessWrong sets no og:site_name)", () => {
    expect(
      stripSiteSuffix("Pythia — LessWrong", {
        url: "https://www.lesswrong.com/posts/abc/pythia",
      }),
    ).toBe("Pythia");
    expect(
      stripSiteSuffix("My Post — Substack Blog", {
        url: "https://substackblog.com/p/my-post",
      }),
    ).toBe("My Post");
  });

  it("strips a suffix matching og:site_name (hyphen and pipe separators)", () => {
    expect(
      stripSiteSuffix("The Coming Wave - The Atlantic", {
        url: "https://theatlantic.com/x",
        siteName: "The Atlantic",
      }),
    ).toBe("The Coming Wave");
    expect(
      stripSiteSuffix("AI Progress Report | The Verge", {
        siteName: "The Verge",
      }),
    ).toBe("AI Progress Report");
  });

  it("leaves a legit trailing em-dash/hyphen segment untouched", () => {
    expect(
      stripSiteSuffix("War — and Peace", {
        url: "https://theatlantic.com/x",
        siteName: "The Atlantic",
      }),
    ).toBe("War — and Peace");
    expect(
      stripSiteSuffix("Attention Is All You Need - A Retrospective", {
        url: "https://example.com/x",
        siteName: "Example",
      }),
    ).toBe("Attention Is All You Need - A Retrospective");
  });

  it("never treats an unspaced hyphen as a separator (Spider-Man)", () => {
    expect(
      stripSiteSuffix("Spider-Man", {
        url: "https://man.com/x",
        siteName: "Man",
      }),
    ).toBe("Spider-Man");
  });

  it("is a no-op with an empty or unparseable URL and no site name", () => {
    expect(stripSiteSuffix("Foo — Bar", {})).toBe("Foo — Bar");
    expect(stripSiteSuffix("Foo — Bar", { url: "not a url" })).toBe(
      "Foo — Bar",
    );
  });

  it("splits on the LAST separator only", () => {
    expect(
      stripSiteSuffix("Alpha — Beta — The Verge", { siteName: "The Verge" }),
    ).toBe("Alpha — Beta");
    expect(
      stripSiteSuffix("Alpha — The Verge — Beta", { siteName: "The Verge" }),
    ).toBe("Alpha — The Verge — Beta");
  });

  it("does not strip when the whole title IS the site name", () => {
    expect(stripSiteSuffix("The Verge", { siteName: "The Verge" })).toBe(
      "The Verge",
    );
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
