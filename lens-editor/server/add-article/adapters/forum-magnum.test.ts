import { describe, it, expect } from "vitest";
import { JSDOM } from "jsdom";
import {
  canonicalizeMirrorLinks,
  greaterWrongCanonicalSourceUrl,
  greaterWrongCanonicalUrl,
} from "./forum-magnum";

// Learner reports #238/#242: comment imports kept the greaterwrong.com mirror
// (down at the time) as source_url instead of the LessWrong comment permalink.
describe("greaterWrongCanonicalSourceUrl", () => {
  it("maps a GreaterWrong post URL to LessWrong", () => {
    expect(
      greaterWrongCanonicalSourceUrl("https://www.greaterwrong.com/posts/AyNHoTWWAJ5eb99ji/another-story"),
    ).toBe("https://www.lesswrong.com/posts/AyNHoTWWAJ5eb99ji/another-story");
    expect(greaterWrongCanonicalSourceUrl("https://ea.greaterwrong.com/posts/abc123/ea-post")).toBe(
      "https://forum.effectivealtruism.org/posts/abc123/ea-post",
    );
  });

  it("maps a GreaterWrong comment URL to ?commentId=", () => {
    expect(
      greaterWrongCanonicalSourceUrl(
        "https://www.greaterwrong.com/posts/AyNHoTWWAJ5eb99ji/another-story/comment/CmtId123",
      ),
    ).toBe("https://www.lesswrong.com/posts/AyNHoTWWAJ5eb99ji/another-story?commentId=CmtId123");
    expect(greaterWrongCanonicalSourceUrl("https://greaterwrong.com/posts/AyNHoTWWAJ5eb99ji/comment/CmtId123/")).toBe(
      "https://www.lesswrong.com/posts/AyNHoTWWAJ5eb99ji?commentId=CmtId123",
    );
    expect(
      greaterWrongCanonicalSourceUrl("https://www.greaterwrong.com/posts/AyNHoTWWAJ5eb99ji/another-story#comment-CmtId123"),
    ).toBe("https://www.lesswrong.com/posts/AyNHoTWWAJ5eb99ji/another-story?commentId=CmtId123");
  });

  it("drops mirror view parameters and fragments from the identity", () => {
    expect(
      greaterWrongCanonicalSourceUrl("https://www.greaterwrong.com/posts/AyNHoTWWAJ5eb99ji/another-story?format=preview#top"),
    ).toBe("https://www.lesswrong.com/posts/AyNHoTWWAJ5eb99ji/another-story");
  });

  it("leaves non-GreaterWrong URLs (and arbital's mirror) alone", () => {
    expect(greaterWrongCanonicalSourceUrl("https://www.lesswrong.com/posts/abc/x?commentId=c1")).toBe("");
    expect(greaterWrongCanonicalSourceUrl("https://example.com/posts/abc/x/comment/c1")).toBe("");
    expect(greaterWrongCanonicalSourceUrl("https://arbital.greaterwrong.com/p/consequentialist")).toBe("");
    expect(greaterWrongCanonicalSourceUrl("not a url")).toBe("");
  });

  it("treats only well-formed ids as comments", () => {
    expect(greaterWrongCanonicalSourceUrl("https://www.greaterwrong.com/posts/AyNHoTWWAJ5eb99ji/x/comment/abc_12")).toBe(
      "https://www.lesswrong.com/posts/AyNHoTWWAJ5eb99ji/x/comment/abc_12",
    );
  });
});

describe("canonicalizeMirrorLinks", () => {
  it("rewrites body links, comment anchors and comment paths alike", () => {
    const base = "https://www.greaterwrong.com/posts/AyNHoTWWAJ5eb99ji/another-story/comment/CmtId123";
    const dom = new JSDOM(`<body>
      <a id="a" href="https://www.greaterwrong.com/posts/p1/slug#comment-CmtId0001">anchor</a>
      <a id="b" href="/posts/p2/slug/comment/CmtId0002">path</a>
      <a id="c" href="https://www.greaterwrong.com/posts/p3/slug#section">section</a>
      <a id="d" href="#comment-C4">in-page</a>
      <a id="e" href="https://example.org/posts/p5/comment/C5">external</a>
    </body>`);
    const doc = dom.window.document;
    canonicalizeMirrorLinks(doc.body as unknown as Element, base);
    const href = (id: string) => doc.getElementById(id)!.getAttribute("href");
    expect(href("a")).toBe("https://www.lesswrong.com/posts/p1/slug?commentId=CmtId0001");
    expect(href("b")).toBe("https://www.lesswrong.com/posts/p2/slug?commentId=CmtId0002");
    expect(href("c")).toBe("https://www.lesswrong.com/posts/p3/slug#section");
    expect(href("d")).toBe("#comment-C4");
    expect(href("e")).toBe("https://example.org/posts/p5/comment/C5");
  });

  it("greaterWrongCanonicalUrl keeps non-comment fragments for in-body links", () => {
    expect(greaterWrongCanonicalUrl("https://www.greaterwrong.com/posts/p3/slug#section")).toBe(
      "https://www.lesswrong.com/posts/p3/slug#section",
    );
  });
});
