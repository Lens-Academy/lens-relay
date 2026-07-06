import type { AdapterContext, AdapterExtract, SiteAdapter } from "./types";
import { cleanAuthorName, stripSiteSuffix } from "./util";

/**
 * ForumMagnum platform: LessWrong, the AI Alignment Forum, the EA Forum — and
 * the GreaterWrong mirror, which serves the same posts from its own,
 * server-rendered, differently-structured HTML. One adapter covers the family:
 * `extract` branches on which DOM it is looking at. For ForumMagnum we select
 * the post body, scope the byline to the post header (never commenters), and
 * read the publish date from the header <time>. For GreaterWrong we use its
 * own classes and also recover the canonical ForumMagnum URL from the page's
 * "LW link", so a mirror import cites (and dedups against) the real post.
 * MathJax + footnote recovery happens in the shared converter.
 */

const FORUM_HOST_RE =
  /(^|\.)(lesswrong\.com|alignmentforum\.org|greaterwrong\.com)$/;

/** greaterwrong.com mirror URL for a ForumMagnum post URL ("" if not one).
 *  GreaterWrong serves LW/AF at its apex host and the EA Forum at `ea.`,
 *  with identical /posts/... paths. */
export function greaterWrongMirrorUrl(url: string): string {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "").toLowerCase();
    if (!u.pathname.startsWith("/posts/")) return "";
    if (host === "lesswrong.com" || host === "alignmentforum.org") {
      return `https://www.greaterwrong.com${u.pathname}`;
    }
    if (host === "forum.effectivealtruism.org") {
      return `https://ea.greaterwrong.com${u.pathname}`;
    }
  } catch {
    /* invalid URL */
  }
  return "";
}

/** GreaterWrong branch: mirror pages are server-rendered with their own DOM. */
function extractGreaterWrong(
  doc: Document,
  ctx: AdapterContext,
): AdapterExtract | null {
  const bodyEl = doc.querySelector(".body-text.post-body");
  if (!bodyEl || !bodyEl.innerHTML.trim()) return null;

  const title = stripSiteSuffix(
    doc.querySelector("h1.post-title")?.textContent ||
      doc.querySelector("title")?.textContent ||
      "",
  );

  // Byline lives in the post-meta bars; `.author` also appears on every
  // comment, so scope strictly to the top meta bar.
  const authors = Array.from(
    doc.querySelectorAll(".top-post-meta a.author, .post-meta a.author"),
  )
    .map((a) => cleanAuthorName(a.textContent || ""))
    .filter(Boolean);

  // The post date carries the epoch in data-js-date; the text ("7 Apr 2021
  // 20:12 UTC") is the fallback. Comments have dates too — scope to post-meta.
  let published = "";
  const dateEl =
    doc.querySelector(".top-post-meta .date") ||
    doc.querySelector(".post-meta .date");
  const epochMs = Number(dateEl?.getAttribute("data-js-date"));
  if (Number.isFinite(epochMs) && epochMs > 0) {
    published = new Date(epochMs).toISOString().slice(0, 10);
  } else if (dateEl?.textContent) {
    const t = Date.parse(dateEl.textContent.replace(/\s+UTC\s*$/i, ""));
    if (!Number.isNaN(t)) published = new Date(t).toISOString().slice(0, 10);
  }

  // "LW link" → the canonical ForumMagnum URL. Fallback: map the mirror host
  // (paths are identical on both sides), so a mirror import is never cited as
  // greaterwrong.com even if the link element is missing.
  // Scoped to the meta bars so post CONTENT can never smuggle a fake canonical.
  let canonical =
    doc
      .querySelector(".top-post-meta a.lw2-link, .post-meta a.lw2-link")
      ?.getAttribute("href")
      ?.trim() || "";
  if (!/^https?:\/\//.test(canonical)) {
    try {
      const u = new URL(ctx.url);
      const host = u.hostname.replace(/^www\./, "").toLowerCase();
      if (host === "ea.greaterwrong.com") {
        canonical = `https://forum.effectivealtruism.org${u.pathname}`;
      } else if (host.endsWith("greaterwrong.com")) {
        canonical = `https://www.lesswrong.com${u.pathname}`;
      }
    } catch {
      canonical = "";
    }
  }

  return {
    bodyHtml: bodyEl.innerHTML,
    title,
    author: Array.from(new Set(authors)),
    published,
    canonicalUrl: /^https?:\/\//.test(canonical) ? canonical : undefined,
  };
}

export const forumMagnumAdapter: SiteAdapter = {
  id: "forum-adapter",

  matches({ host, html }: AdapterContext): boolean {
    return (
      FORUM_HOST_RE.test(host) ||
      host === "forum.effectivealtruism.org" ||
      html.includes("PostsPage-postContent")
    );
  },

  /**
   * ForumMagnum sites rate-limit datacenter IPs (LessWrong 429s from the
   * production VPS), so list the GreaterWrong mirror as an automatic fallback
   * fetch. The canonical URL still gets cited: either the submitted URL (for a
   * direct LW/AF/EAF import) or the mirror page's own "LW link".
   */
  resolveFetchUrls(ctx: AdapterContext): string[] {
    const mirror = greaterWrongMirrorUrl(ctx.url);
    return mirror ? [ctx.url, mirror] : [ctx.url];
  },

  extract(doc: Document, ctx: AdapterContext): AdapterExtract | null {
    // GreaterWrong first — its host can also be reached via the ForumMagnum
    // fallback path below when a LW fetch fell back to the mirror.
    if (/(^|\.)greaterwrong\.com$/.test(ctx.host) || doc.querySelector(".body-text.post-body")) {
      const gw = extractGreaterWrong(doc, ctx);
      if (gw) return gw;
    }

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
