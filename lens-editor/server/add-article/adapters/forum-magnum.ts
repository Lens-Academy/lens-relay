import type { AdapterContext, AdapterExtract, SiteAdapter } from "./types";
import { cleanAuthorName, stripSiteSuffix } from "./util";

/**
 * ForumMagnum platform: LessWrong, the AI Alignment Forum, the EA Forum, and
 * GreaterWrong mirrors. All share the same React app and DOM classes, so one
 * adapter covers the family. We select the post body, scope the byline to the
 * post header (never commenters), and read the publish date from the header
 * <time>. MathJax + footnote recovery happens in the shared converter.
 */
export const forumMagnumAdapter: SiteAdapter = {
  id: "forum-adapter",

  matches({ host, html }: AdapterContext): boolean {
    return (
      /(^|\.)(lesswrong\.com|alignmentforum\.org|greaterwrong\.com)$/.test(host) ||
      host === "forum.effectivealtruism.org" ||
      html.includes("PostsPage-postContent")
    );
  },

  extract(doc: Document): AdapterExtract | null {
    const bodyEl =
      doc.querySelector(".PostsPage-postContent") ||
      doc.querySelector(".ContentStyles-postBody");
    if (!bodyEl || !bodyEl.innerHTML.trim()) return null;

    const title = stripSiteSuffix(
      doc.querySelector(".PostsPageTitle-link")?.textContent ||
        doc.querySelector("title")?.textContent ||
        "",
    );

    // Author links live ONLY in the post header (?from=post_header), never in
    // the comment thread — scope to those so commenters aren't picked up.
    const authors = Array.from(
      doc.querySelectorAll(
        '.PostsAuthors-root a[href*="/users/"], a[href*="from=post_header"]',
      ),
    )
      .map((a) => cleanAuthorName(a.textContent || ""))
      .filter(Boolean);

    const dateEl = doc.querySelector(".PostsPageDate time, time[datetime]");
    const published = (dateEl?.getAttribute("datetime") || "").slice(0, 10);

    return {
      bodyHtml: bodyEl.innerHTML,
      title,
      author: Array.from(new Set(authors)),
      published,
    };
  },
};
