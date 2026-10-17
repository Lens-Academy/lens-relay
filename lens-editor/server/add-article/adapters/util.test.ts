import { describe, it, expect } from "vitest";
import { JSDOM } from "jsdom";
import { isVideoEmbedUrl, LITERAL_DOLLAR_ATTR, markLiteralDollars, videoEmbedMarker, stripSiteSuffix } from "./util";

describe("markLiteralDollars", () => {
  const run = (html: string) => {
    const doc = new JSDOM(`<body><div id="r">${html}</div></body>`).window.document;
    const root = doc.getElementById("r")!;
    markLiteralDollars(root as unknown as Element);
    return root.innerHTML;
  };

  it("marks prose dollars and leaves math, code and MathJax alone", () => {
    expect(run("pay $1 or $2 <code>$x$</code><math alttext=\"y\">$</math><span class=\"mjpage\">$</span>")).toBe(
      `pay <span ${LITERAL_DOLLAR_ATTR}="">$</span>1 or <span ${LITERAL_DOLLAR_ATTR}="">$</span>2 <code>$x$</code><math alttext="y">$</math><span class="mjpage">$</span>`,
    );
  });

  it("moves a dollar glued to an inline formula into its TeX as \\textdollar", () => {
    expect(run("risked more than $<math alttext=\"t/2\"></math>")).toBe(
      'risked more than <math alttext="\\text{\\textdollar}t/2"></math>',
    );
    // The same before a forum's MathJax formula.
    expect(run('The prize is $<span class="math-tex"><span class="mjpage"><span class="mjx-math" aria-label="t/2">t</span></span></span> dollars.')).toBe(
      'The prize is <span class="math-tex"><span class="mjpage"><span class="mjx-math" aria-label="\\text{\\textdollar}t/2">t</span></span></span> dollars.',
    );
  });
});


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

  it("keeps a trailing segment that is not the site name (task examples)", () => {
    expect(
      stripSiteSuffix("AI: A Modern Approach — Part 1", { url: "https://example.com/x" }),
    ).toBe("AI: A Modern Approach — Part 1");
    expect(
      stripSiteSuffix("The Verge — Tech News", { url: "https://www.theverge.com/x" }),
    ).toBe("The Verge — Tech News");
  });

  it("names a host by its registrable label, not a subdomain", () => {
    // news.mit.edu is "mit": a "- News" tail is part of the title.
    expect(stripSiteSuffix("Interview - News", { url: "https://news.mit.edu/2024/x" })).toBe(
      "Interview - News",
    );
    expect(stripSiteSuffix("Interview - MIT", { url: "https://news.mit.edu/2024/x" })).toBe("Interview");
    expect(stripSiteSuffix("Lecture notes | CMU", { url: "https://www.cs.cmu.edu/~x/" })).toBe(
      "Lecture notes",
    );
    expect(stripSiteSuffix("Story - BBC", { url: "https://www.bbc.co.uk/news/x" })).toBe("Story");
  });

  it("matches sites named after their whole domain", () => {
    expect(stripSiteSuffix("Our research agenda | FAR.AI", { url: "https://far.ai/post/x" })).toBe(
      "Our research agenda",
    );
    expect(stripSiteSuffix("Announcing Grok | xAI", { url: "https://x.ai/news/grok" })).toBe("Announcing Grok");
    expect(stripSiteSuffix("Trends | Epoch AI", { url: "https://epoch.ai/blog/trends" })).toBe("Trends");
  });

  it("does not match one- and two-letter host labels", () => {
    expect(stripSiteSuffix("Thread - X", { url: "https://x.com/user/status/1" })).toBe("Thread - X");
    expect(stripSiteSuffix("Policy Update - AI", { url: "https://ai.gov/x" })).toBe("Policy Update - AI");
  });

  it("strips sites outside the old hard-coded list (MIRI via og:site_name)", () => {
    expect(
      stripSiteSuffix("The Rocket Alignment Problem - Machine Intelligence Research Institute", {
        url: "https://intelligence.org/2018/10/03/rocket-alignment/",
        siteName: "Machine Intelligence Research Institute",
      }),
    ).toBe("The Rocket Alignment Problem");
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

describe("videoEmbedMarker", () => {
  it("emits a marker with the normalized absolute-https URL", () => {
    expect(videoEmbedMarker("//www.youtube.com/embed/abc123")).toBe(
      "__lensvideo:https://www.youtube.com/embed/abc123__",
    );
  });

  it("normalizes hostile srcs through URL() so no raw quotes survive", () => {
    const marker = videoEmbedMarker('https://www.youtube.com/embed/x"><script>1</script>');
    expect(marker).not.toContain('"');
    expect(marker).toMatch(/^__lensvideo:https:\/\/www\.youtube\.com\/\S+__$/);
  });

  it("emits nothing for an unparseable src", () => {
    expect(videoEmbedMarker("javascript:alert(1)")).toBe("");
  });
});
