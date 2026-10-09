import { describe, expect, it } from "vitest";
import { extractArticle } from "../extract";
import { forumApiAnswerToHtml, forumGraphqlUrl } from "./forum-magnum";

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
