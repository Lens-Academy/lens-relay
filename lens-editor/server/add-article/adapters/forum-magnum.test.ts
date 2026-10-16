import { describe, it, expect } from "vitest";
import { JSDOM } from "jsdom";
import { canonicalizeMirrorLinks, greaterWrongCanonicalSourceUrl } from "./forum-magnum";

describe("greaterWrongCanonicalSourceUrl", () => {
  it("maps GreaterWrong posts and comments to the forum's own URL", () => {
    const post = "https://www.lesswrong.com/posts/AyNHoTWWAJ5eb99ji/another-story";
    const comment = `${post}?commentId=CmtId123`;
    expect(greaterWrongCanonicalSourceUrl("https://www.greaterwrong.com/posts/AyNHoTWWAJ5eb99ji/another-story?format=preview#top")).toBe(post);
    expect(greaterWrongCanonicalSourceUrl("https://www.greaterwrong.com/posts/AyNHoTWWAJ5eb99ji/another-story/comment/CmtId123")).toBe(comment);
    expect(greaterWrongCanonicalSourceUrl("https://www.greaterwrong.com/posts/AyNHoTWWAJ5eb99ji/another-story#comment-CmtId123")).toBe(comment);
    expect(greaterWrongCanonicalSourceUrl("https://ea.greaterwrong.com/posts/abcdEFGH1234/ea-post")).toBe(
      "https://forum.effectivealtruism.org/posts/abcdEFGH1234/ea-post",
    );
  });

  it("leaves other URLs (and arbital's mirror) alone", () => {
    expect(greaterWrongCanonicalSourceUrl("https://www.lesswrong.com/posts/abc/x?commentId=c1")).toBe("");
    expect(greaterWrongCanonicalSourceUrl("https://arbital.greaterwrong.com/p/consequentialist")).toBe("");
    expect(greaterWrongCanonicalSourceUrl("not a url")).toBe("");
  });
});

describe("canonicalizeMirrorLinks", () => {
  it("rewrites mirror links, comment anchors and comment paths alike", () => {
    const dom = new JSDOM(`<body>
      <a id="a" href="https://www.greaterwrong.com/posts/postId00001/slug#comment-CmtId0001">anchor</a>
      <a id="b" href="/posts/postId00002/slug/comment/CmtId0002">path</a>
      <a id="c" href="https://www.greaterwrong.com/posts/postId00003/slug#section">section</a>
      <a id="d" href="#comment-CmtId0004">in-page</a>
      <a id="e" href="https://example.org/posts/postId00005/comment/CmtId0005">external</a>
    </body>`);
    const doc = dom.window.document;
    canonicalizeMirrorLinks(doc.body as unknown as Element, "https://www.greaterwrong.com/posts/postId00000/x");
    const href = (id: string) => doc.getElementById(id)!.getAttribute("href");
    expect(href("a")).toBe("https://www.lesswrong.com/posts/postId00001/slug?commentId=CmtId0001");
    expect(href("b")).toBe("https://www.lesswrong.com/posts/postId00002/slug?commentId=CmtId0002");
    expect(href("c")).toBe("https://www.lesswrong.com/posts/postId00003/slug#section");
    expect(href("d")).toBe("#comment-CmtId0004");
    expect(href("e")).toBe("https://example.org/posts/postId00005/comment/CmtId0005");
  });
});
