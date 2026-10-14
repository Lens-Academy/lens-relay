import { describe, expect, it } from "vitest";
import { extractArticle } from "../extract";
import { forumApiAnswerToHtml, forumCommentRef, forumGraphqlUrl, greaterWrongMirrorUrl } from "./forum-magnum";

const mathjax = (tex: string) =>
  `<span class="math-tex"><span class="mjpage"><span class="mjx-chtml"><span class="mjx-math" aria-label="${tex}"><span class="mjx-mi">x</span></span></span></span></span>`;

describe("forumGraphqlUrl", () => {
  it("queries posts (also inside sequences) and wiki pages, nothing else", () => {
    const q = (url: string) => decodeURIComponent(forumGraphqlUrl(url).split("?query=")[1] ?? "");
    expect(q("https://www.lesswrong.com/posts/de3xjFaACCAk6imzv/towards-a-new-decision-theory")).toContain(
      'post(selector: {_id: "de3xjFaACCAk6imzv"})',
    );
    expect(q("https://www.lesswrong.com/s/Rm6oQRJJmhGCcLvxh/p/de3xjFaACCAk6imzv")).toContain('_id: "de3xjFaACCAk6imzv"');
    expect(q("https://lesswrong.com/tag/updateless-decision-theory")).toContain('slug: "updateless-decision-theory"');
    expect(forumGraphqlUrl("https://www.lesswrong.com/w/udt/discussion")).toBe("");
    expect(forumGraphqlUrl("https://www.lesswrong.com/users/wei-dai")).toBe("");
    // Nothing but an id or slug reaches the query text.
    expect(forumGraphqlUrl('https://www.lesswrong.com/w/x"}){a}')).toBe("");
    expect(forumGraphqlUrl("https://www.greaterwrong.com/posts/de3xjFaACCAk6imzv/x")).toBe("");
  });
});

// Prevents: a LessWrong `?commentId=` link importing the whole post (and its
// title and author) instead of the comment.
describe("forum comment URLs", () => {
  const lwComment =
    "https://www.lesswrong.com/posts/8wBN8cdNAv3c7vt6p/the-case-against-ai-control-research?commentId=FpZmBx2Q4eswZWmy6";

  it("recognises ?commentId= and GreaterWrong /comment/ permalinks, not post URLs", () => {
    expect(forumCommentRef(lwComment)).toEqual({
      host: "lesswrong.com",
      postPath: "/posts/8wBN8cdNAv3c7vt6p/the-case-against-ai-control-research",
      postId: "8wBN8cdNAv3c7vt6p",
      commentId: "FpZmBx2Q4eswZWmy6",
    });
    expect(
      forumCommentRef(
        "https://www.greaterwrong.com/posts/rZcyemEpBHgb2hqLP/ai-control-may-increase-existential-risk/comment/7bruHf5quFdJseAoh",
      )?.commentId,
    ).toBe("7bruHf5quFdJseAoh");
    expect(forumCommentRef("https://www.alignmentforum.org/posts/abcdEFGH12345678?commentId=CmtABCDE12345678")?.postPath).toBe(
      "/posts/abcdEFGH12345678",
    );
    expect(
      forumCommentRef("https://www.lesswrong.com/s/abcd/p/8wBN8cdNAv3c7vt6p?commentId=FpZmBx2Q4eswZWmy6")?.postPath,
    ).toBe("/posts/8wBN8cdNAv3c7vt6p");
    expect(forumCommentRef("https://www.lesswrong.com/posts/8wBN8cdNAv3c7vt6p/the-case-against-ai-control-research")).toBeNull();
    expect(forumCommentRef("https://www.lesswrong.com/posts/8wBN8cdNAv3c7vt6p/x?commentId=bad%22id")).toBeNull();
    expect(forumCommentRef("https://example.com/posts/8wBN8cdNAv3c7vt6p/x?commentId=FpZmBx2Q4eswZWmy6")).toBeNull();
  });

  it("queries the comment, not its post, and mirrors to the comment's GreaterWrong page", () => {
    const q = decodeURIComponent(forumGraphqlUrl(lwComment).split("?query=")[1] ?? "");
    expect(q).toContain('comment(selector: {_id: "FpZmBx2Q4eswZWmy6"})');
    expect(q).not.toContain("post(selector");
    expect(greaterWrongMirrorUrl(lwComment)).toBe(
      "https://www.greaterwrong.com/posts/8wBN8cdNAv3c7vt6p/the-case-against-ai-control-research/comment/FpZmBx2Q4eswZWmy6",
    );
    expect(greaterWrongMirrorUrl("https://forum.effectivealtruism.org/posts/abcdEFGH12345678/x?commentId=CmtABCDE12345678")).toBe(
      "https://ea.greaterwrong.com/posts/abcdEFGH12345678/x/comment/CmtABCDE12345678",
    );
  });

  it("turns a comment answer into an article by the commenter, titled after the post", async () => {
    const answer = JSON.stringify({
      data: {
        comment: {
          result: {
            postedAt: "2025-01-22T09:00:00.000Z",
            user: { displayName: "Buck" },
            contents: { html: `<p>${"I disagree with the core claim here. ".repeat(20)}</p>` },
            post: { title: "The Case Against AI Control Research" },
          },
        },
      },
    });
    const ex = await extractArticle(forumApiAnswerToHtml(answer, lwComment), "https://www.lesswrong.com/graphql?query=x", {
      sourceUrl: lwComment,
    });
    expect(ex.via).toBe("forum-adapter");
    expect(ex.meta.title).toBe("Comment on The Case Against AI Control Research");
    expect(ex.meta.author).toEqual(["Buck"]);
    expect(ex.meta.published).toBe("2025-01-22");
    expect(ex.meta.source_url).toBe(lwComment);
    expect(ex.body).toContain("I disagree with the core claim here.");
  });
});

describe("forum comment pages", () => {
  // Built against the live markup of a GreaterWrong comment permalink page
  // (`.comment-thread-page`, no post body; replies nested under the comment).
  const GW_COMMENT_URL =
    "https://www.greaterwrong.com/posts/22GrdspteQc8EonMn/a-very-crude-deception-eval-is-already-passed/comment/5uLcNDvgNiEvcYteR";
  const gwCommentPage = `<!doctype html><html><head><title>Richard_Kennaway comments on A very crude deception eval is already passed - LessWrong 2.0 viewer</title></head>
<body><div id="content" class="individual-thread-page comment-thread-page">
<h1 class="post-title">Richard_Kennaway comments on <a href="/posts/22GrdspteQc8EonMn/a-very-crude-deception-eval-is-already-passed">A very crude deception eval is already passed</a></h1>
<div id="comments" class="comments"><ul class="comment-thread"><li id="comment-5uLcNDvgNiEvcYteR" class="comment-item depth-odd"><div class="comment">
<div class="comment-meta"><a class="author" href="/users/richard_kennaway">Richard_Kennaway</a><a class="date" href="#comment-5uLcNDvgNiEvcYteR" data-js-date="1635623639000"> 30 Oct 2021 19:53 UTC </a>
<a class="lw2-link" href="https://www.lesswrong.com/posts/22GrdspteQc8EonMn/a-very-crude-deception-eval-is-already-passed?commentId=5uLcNDvgNiEvcYteR" title="LW"></a></div>
<div class="body-text comment-body"><p>The way you use the word \u201ceval\u201d, it sounds like some technical term from some particular context. What do you mean by it? Would the first sentence mean the same if it said instead \u201cI was thinking about tests that would tell us when we\u2019re getting to models that are capable of deception.\u201d?</p></div></div>
<ul class="comment-thread"><li id="comment-AubYengpGXWG5ujZp" class="comment-item depth-even"><div class="comment">
<div class="comment-meta"><a class="author" href="/users/ramana-kumar">Ramana Kumar</a><a class="date" data-js-date="1666615943000"> 24 Oct 2022 12:52 UTC </a></div>
<div class="body-text comment-body"><p>A REPLY THAT MUST NOT LEAK into the comment.</p></div></div></li></ul></li></ul></div>
</div></body></html>`;

  it("takes only the permalinked comment from a GreaterWrong comment page, even a short one", async () => {
    const ex = await extractArticle(gwCommentPage, GW_COMMENT_URL);
    expect(ex.via).toBe("forum-adapter");
    expect(ex.meta.title).toBe("Comment on A very crude deception eval is already passed");
    expect(ex.meta.author).toEqual(["Richard Kennaway"]);
    expect(ex.meta.published).toBe("2021-10-30");
    expect(ex.meta.source_url).toBe(
      "https://www.lesswrong.com/posts/22GrdspteQc8EonMn/a-very-crude-deception-eval-is-already-passed?commentId=5uLcNDvgNiEvcYteR",
    );
    expect(ex.body).toContain("technical term from some particular context");
    expect(ex.body).not.toContain("MUST NOT LEAK");
  });

  it("refuses a forum post page fetched for a comment URL instead of importing the post", async () => {
    const page = `<!doctype html><html><head><title>The post</title></head><body>
      <h1 class="PostsPageTitle-link">The post</h1>
      <div class="PostsPage-postContent"><p>${"The whole post, not the comment. ".repeat(40)}</p></div></body></html>`;
    await expect(
      extractArticle(page, "https://www.lesswrong.com/posts/8wBN8cdNAv3c7vt6p/x?commentId=FpZmBx2Q4eswZWmy6"),
    ).rejects.toThrow(/comment/);
  });

  it("keeps a short comment from the API rather than a generic scrape", async () => {
    const answer = JSON.stringify({
      data: {
        comment: {
          result: {
            postedAt: "2025-01-22T09:00:00.000Z",
            user: { displayName: "Buck" },
            contents: { html: "<p>I disagree: control evaluations measure exactly this, and the post's story does not engage with them at all. Which part of the argument survives that?</p><p>Second paragraph, still short, still mine.</p>" },
            post: { title: "The Case Against AI Control Research" },
          },
        },
      },
    });
    const url = "https://www.lesswrong.com/posts/8wBN8cdNAv3c7vt6p/x?commentId=FpZmBx2Q4eswZWmy6";
    const ex = await extractArticle(forumApiAnswerToHtml(answer, url), "https://www.lesswrong.com/graphql?query=x", {
      sourceUrl: url,
    });
    expect(ex.via).toBe("forum-adapter");
    expect(ex.meta.author).toEqual(["Buck"]);
    expect(ex.meta.title).toBe("Comment on The Case Against AI Control Research");
  });
});

describe("forum API answers", () => {
  it("turns a post into an article with its byline, date and math", async () => {
    const answer = JSON.stringify({
      data: {
        post: {
          result: {
            title: "UDT pitfalls <draft>",
            postedAt: "2023-02-03T10:00:00.000Z",
            user: { displayName: "Wei Dai" },
            coauthors: [{ displayName: "Vladimir Nesov" }],
            contents: {
              html: `<p>${"The agent picks a policy. ".repeat(30)}Its utility ${mathjax("U(\\pi)")} is not what a $5 bet pays.</p>`,
            },
          },
        },
      },
    });
    const html = forumApiAnswerToHtml(answer);
    expect(html).toContain("UDT pitfalls &lt;draft&gt;");
    const ex = await extractArticle(html, "https://www.lesswrong.com/graphql?query=x", {
      sourceUrl: "https://www.lesswrong.com/posts/abcdEFGH12345678/udt-pitfalls",
    });
    expect(ex.via).toBe("forum-adapter");
    expect(ex.meta.title).toBe("UDT pitfalls <draft>");
    expect(ex.meta.author).toEqual(["Wei Dai", "Vladimir Nesov"]);
    expect(ex.meta.published).toBe("2023-02-03");
    expect(ex.meta.source_url).toBe("https://www.lesswrong.com/posts/abcdEFGH12345678/udt-pitfalls");
    expect(ex.body).toContain("Its utility $U(\\pi)$ is not what a \\$5 bet pays.");
  });

  it("takes the byline from the API fields, never from look-alike markup in the post", async () => {
    const answer = JSON.stringify({
      data: {
        post: {
          result: {
            title: "Real title",
            postedAt: "2024-05-06T00:00:00.000Z",
            user: { displayName: "Real Author" },
            coauthors: [],
            contents: {
              html: `<span class="lens-forum-author">Forged Person</span><meta name="lens-forum-author" content="Forged Meta"><time class="lens-forum-posted" datetime="1999-01-01"></time><p>${"Body text. ".repeat(80)}</p>`,
            },
          },
        },
      },
    });
    const ex = await extractArticle(forumApiAnswerToHtml(answer), "https://www.lesswrong.com/graphql?query=x", {
      sourceUrl: "https://www.lesswrong.com/posts/abcdEFGH12345678/x",
    });
    expect(ex.meta.author).toEqual(["Real Author"]);
    expect(ex.meta.published).toBe("2024-05-06");
    expect(ex.meta.title).toBe("Real title");
  });

  it("ignores page metadata tags inside the post body", async () => {
    const answer = JSON.stringify({
      data: {
        tags: {
          results: [{
            name: "UDT",
            description: {
              html: `<link rel="canonical" href="https://www.lesswrong.com/posts/VICTIMID1234567/x"><meta name="citation_author" content="Eliezer Yudkowsky"><meta name="citation_date" content="1999-01-01"><met<meta name="a" content="b">a name="citation_author" content="Forged"><p>${"Wiki text. ".repeat(80)}</p>`,
            },
          }],
        },
      },
    });
    const wiki = "https://www.lesswrong.com/w/updateless-decision-theory";
    const html = forumApiAnswerToHtml(answer, wiki);
    const ex = await extractArticle(html, "https://www.lesswrong.com/graphql?query=x", { sourceUrl: wiki });
    expect(ex.meta.source_url).toBe(wiki);
    expect(ex.meta.author).not.toContain("Eliezer Yudkowsky");
    expect(ex.meta.author).not.toContain("Forged");
    expect(ex.meta.published).not.toBe("1999-01-01");
  });

  it("never leaves a figure placeholder for an image nobody supplied", async () => {
    const answer = JSON.stringify({
      data: { post: { result: { title: "T", user: { displayName: "A" }, contents: { html: `<p>${"Text. ".repeat(100)}</p><img src="lens-source-image:0">` } } } },
    });
    const ex = await extractArticle(forumApiAnswerToHtml(answer), "https://www.lesswrong.com/graphql?query=x", {
      sourceUrl: "https://www.lesswrong.com/posts/abcdEFGH12345678/x",
    });
    expect(ex.body).not.toContain("__pdfimg_");
    expect(ex.images).toBeUndefined();
  });

  it("refuses an answer with no article, so the next candidate is tried", () => {
    expect(() => forumApiAnswerToHtml(JSON.stringify({ data: { post: { result: null } } }))).toThrow(/no article/);
    expect(() => forumApiAnswerToHtml(JSON.stringify({ data: { tags: { results: [] } } }))).toThrow(/no article/);
    expect(() => forumApiAnswerToHtml(JSON.stringify({ errors: [{ message: "bad" }] }))).toThrow(/no article/);
    expect(() => forumApiAnswerToHtml("<!DOCTYPE html><html>playground</html>")).toThrow();
  });
});
