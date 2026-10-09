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

  it("refuses an answer with no article, so the next candidate is tried", () => {
    expect(() => forumApiAnswerToHtml(JSON.stringify({ data: { post: { result: null } } }))).toThrow(/no article/);
    expect(() => forumApiAnswerToHtml(JSON.stringify({ data: { tags: { results: [] } } }))).toThrow(/no article/);
    expect(() => forumApiAnswerToHtml(JSON.stringify({ errors: [{ message: "bad" }] }))).toThrow(/no article/);
    expect(() => forumApiAnswerToHtml("<!DOCTYPE html><html>playground</html>")).toThrow();
  });
});
