import type { AdapterContext, AdapterExtract, SiteAdapter } from "./types";
import { cleanAuthorName, markLiteralDollars, stripSiteSuffix } from "./util";

/**
 * ForumMagnum platform: LessWrong, the AI Alignment Forum, the EA Forum — and
 * the GreaterWrong mirror, which serves the same posts from its own,
 * server-rendered, differently-structured HTML. One adapter covers the family:
 * `extract` branches on which DOM it is looking at. For ForumMagnum we select
 * the post body, scope the byline to the post header (never commenters), and
 * read the publish date from the header <time>. For GreaterWrong we use its
 * own classes and also recover the canonical ForumMagnum URL from the page's
 * "LW link", so a mirror import cites (and dedups against) the real post.
 * LessWrong and Alignment Forum posts and wiki pages are read through the
 * forum's GraphQL API first (see `forumGraphqlUrl`), which keeps their math.
 * MathJax + footnote recovery happens in the shared converter.
 */

const FORUM_HOST_RE =
  /(^|\.)(lesswrong\.com|alignmentforum\.org|greaterwrong\.com)$/;

/** greaterwrong.com mirror URL for a ForumMagnum post URL ("" if not one).
 *  GreaterWrong serves LW/AF at its apex host and the EA Forum at `ea.`,
 *  with identical /posts/... paths; a `?commentId=` permalink becomes the
 *  mirror's `/comment/<cid>` page (the post page would be the wrong text). */
export function greaterWrongMirrorUrl(url: string): string {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "").toLowerCase();
    if (!u.pathname.startsWith("/posts/")) return "";
    const commentId = forumCommentId(u);
    const path = commentId
      ? `${u.pathname.replace(/\/+$/, "")}/comment/${commentId}`
      : u.pathname;
    if (host === "lesswrong.com" || host === "alignmentforum.org") {
      return `https://www.greaterwrong.com${path}`;
    }
    if (host === "forum.effectivealtruism.org") {
      return `https://ea.greaterwrong.com${path}`;
    }
  } catch {
    /* invalid URL */
  }
  return "";
}

/** The `?commentId=` of a ForumMagnum comment permalink ("" if none, or not an id). */
function forumCommentId(u: URL): string {
  const id = u.searchParams.get("commentId") || "";
  return /^[A-Za-z0-9]{8,32}$/.test(id) ? id : "";
}

/**
 * The canonical ForumMagnum form of a GreaterWrong mirror URL, or "" when
 * `url` is not one. The mirror host maps to its canonical host (paths are
 * identical on both sides), and GreaterWrong's comment permalinks — the
 * `/posts/<id>/<slug>/comment/<cid>` path and the `#comment-<cid>` fragment —
 * become ForumMagnum's `?commentId=<cid>`, which the canonical sites resolve.
 * `arbital.greaterwrong.com` is not mapped — it is the readable mirror of a
 * defunct site, so it IS the best available destination.
 */
export function greaterWrongCanonicalUrl(url: string, baseUrl?: string): string {
  return canonicalForumUrl(url, baseUrl, false);
}

/**
 * `greaterWrongCanonicalUrl` for a document's identity (its source_url): only
 * the post path and the comment id survive — mirror view parameters and
 * fragments do not name a different document.
 */
export function greaterWrongCanonicalSourceUrl(url: string): string {
  return canonicalForumUrl(url, undefined, true);
}

function canonicalForumUrl(url: string, baseUrl: string | undefined, bare: boolean): string {
  let u: URL;
  try {
    u = new URL(url, baseUrl);
  } catch {
    return "";
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return "";
  const host = u.hostname.replace(/^www\./, "").toLowerCase();
  if (host === "greaterwrong.com") u.hostname = "www.lesswrong.com";
  else if (host === "ea.greaterwrong.com") u.hostname = "forum.effectivealtruism.org";
  else return ""; // arbital.greaterwrong.com, unknown subdomains, non-mirror hosts
  u.protocol = "https:";
  const commentPath = u.pathname.match(/^(\/posts\/[^/]+(?:\/[^/]+)?)\/comment\/([\w-]+)\/?$/);
  const commentHash = u.hash.match(/^#comment-([\w-]+)$/);
  if (commentPath) {
    u.pathname = commentPath[1];
    u.searchParams.set("commentId", commentPath[2]);
  }
  if (commentHash) u.searchParams.set("commentId", commentHash[1]);
  if (commentPath || commentHash) u.hash = "";
  if (bare) {
    const commentId = u.searchParams.get("commentId");
    u.search = "";
    u.hash = "";
    if (commentId) u.searchParams.set("commentId", commentId);
  }
  return u.href;
}

/**
 * Rewrite mirror-host links in a GreaterWrong body to their canonical hosts
 * (see `greaterWrongCanonicalUrl`), so a mirror-fetched article cites
 * lesswrong.com / forum.effectivealtruism.org in its BODY as well as its
 * source_url. Relative hrefs resolve against the mirror base and are caught
 * too; in-page anchors and links to any non-mirror host are left untouched.
 */
export function canonicalizeMirrorLinks(root: Element, baseUrl: string): void {
  root.querySelectorAll("a[href]").forEach((a) => {
    const href = a.getAttribute("href") || "";
    if (!href || href.startsWith("#")) return; // in-page anchors stay
    const canonical = greaterWrongCanonicalUrl(href, baseUrl);
    if (canonical) a.setAttribute("href", canonical);
  });
}

/**
 * ForumMagnum's GraphQL API (LessWrong, the Alignment Forum). The rendered
 * page draws math client-side and its wiki pages keep the text outside the
 * post container, so page scraping loses equations; the API answers with the
 * post's stored HTML, every formula carrying its TeX. Fetched with GET (the
 * API accepts it), so it is an ordinary fetch candidate.
 */
const FORUM_API_HOSTS: Record<string, string> = {
  "lesswrong.com": "https://www.lesswrong.com/graphql",
  "alignmentforum.org": "https://www.alignmentforum.org/graphql",
};

/** Marker the converted API answer is recognised by in `extract`. */
export const FORUM_GRAPHQL_MARKER = "lens-forum-graphql";

/** GET URL of the API query for a post, comment permalink (`?commentId=`) or
 *  wiki page URL ("" if not one). */
export function forumGraphqlUrl(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "";
  }
  const endpoint = FORUM_API_HOSTS[u.hostname.replace(/^www\./, "").toLowerCase()];
  if (!endpoint) return "";
  // Ids and slugs are [A-Za-z0-9_-]; anything else is not a page we know,
  // and nothing else may reach the query text.
  const post = u.pathname.match(/^\/(?:posts|s\/[\w-]+\/p)\/([A-Za-z0-9]{8,32})(?:\/[\w-]*)?\/?$/);
  const wiki = u.pathname.match(/^\/(?:w|tag)\/([\w-]+)\/?$/);
  const commentId = post ? forumCommentId(u) : "";
  let query: string;
  if (commentId) {
    // A comment permalink is the comment, not the post it hangs under.
    query =
      `{ comment(selector: {_id: "${commentId}"}) { result { postedAt ` +
      "user { displayName } contents { html } post { title } } } }";
  } else if (post) {
    query =
      `{ post(selector: {_id: "${post[1]}"}) { result { title postedAt ` +
      "user { displayName } coauthors { displayName } contents { html } } } }";
  } else if (wiki) {
    query =
      `{ tags(selector: {tagBySlug: {slug: "${wiki[1]}"}}, limit: 1) ` +
      "{ results { name description { html } } } }";
  } else return "";
  return `${endpoint}?query=${encodeURIComponent(query)}`;
}

/** Whether `url` is one of the forum API endpoints. */
function isForumApiUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.pathname === "/graphql" && !!FORUM_API_HOSTS[u.hostname.replace(/^www\./, "").toLowerCase()];
  } catch {
    return false;
  }
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

interface ForumApiAnswer {
  data?: {
    post?: { result?: ForumApiPost | null } | null;
    comment?: { result?: ForumApiComment | null } | null;
    tags?: { results?: ForumApiTag[] | null } | null;
  };
}
interface ForumApiPost {
  title?: string;
  postedAt?: string;
  user?: { displayName?: string } | null;
  coauthors?: { displayName?: string }[] | null;
  contents?: { html?: string } | null;
}
interface ForumApiComment {
  postedAt?: string;
  user?: { displayName?: string } | null;
  contents?: { html?: string } | null;
  post?: { title?: string } | null;
}
interface ForumApiTag {
  name?: string;
  description?: { html?: string } | null;
}

/**
 * The API's JSON answer as an HTML document for `extract`. Throws when the
 * answer holds no article (unknown id, an error, an empty body), so the next
 * candidate (the page itself, then GreaterWrong) is tried.
 */
export function forumApiAnswerToHtml(json: string, canonicalUrl = ""): string {
  const answer = JSON.parse(json) as ForumApiAnswer;
  const comment = answer.data?.comment?.result;
  const tag = answer.data?.tags?.results?.[0];
  // A comment reads like a post by its commenter, titled the way the forums
  // title a comment permalink page.
  const post: ForumApiPost | null | undefined = comment
    ? {
        title: comment.post?.title
          ? `${comment.user?.displayName || "Comment"} comments on ${comment.post.title}`
          : "",
        postedAt: comment.postedAt,
        user: comment.user,
        contents: comment.contents,
      }
    : answer.data?.post?.result;
  const title = post?.title ?? tag?.name ?? "";
  // Page metadata tags in the post's own HTML (a canonical link, citation_*
  // meta) would be read as the article's: the metadata scan covers the whole
  // document. Post bodies never need them.
  let body = post?.contents?.html ?? tag?.description?.html ?? "";
  // Until stable: removing one tag must not splice the halves of another.
  for (let prev = ""; prev !== body; ) {
    prev = body;
    body = body.replace(/<(?:meta|link)\b[^>]*>/gi, "");
  }
  if (!title || !body.trim()) throw new Error("forum API answer holds no article");
  const authors = post
    ? [post.user?.displayName, ...(post.coauthors ?? []).map((c) => c.displayName)].filter(
        (name): name is string => !!name,
      )
    : [];
  return [
    "<!doctype html><html><head>",
    `<meta name="generator" content="${FORUM_GRAPHQL_MARKER}">`,
    `<title>${escapeHtml(title)}</title>`,
    canonicalUrl ? `<link rel="canonical" href="${escapeHtml(canonicalUrl)}">` : "",
    // The byline lives in <head>, out of reach of the post's own (untrusted)
    // HTML, which could otherwise forge these elements.
    ...authors.map((name) => `<meta name="lens-forum-author" content="${escapeHtml(name)}">`),
    post?.postedAt ? `<meta name="lens-forum-posted" content="${escapeHtml(post.postedAt)}">` : "",
    `<meta name="lens-forum-title" content="${escapeHtml(title)}">`,
    "</head><body>",
    `<div class="lens-forum-body">${body}</div>`,
    "</body></html>",
  ].join("\n");
}

/** GreaterWrong branch: mirror pages are server-rendered with their own DOM. */
function extractGreaterWrong(
  doc: Document,
  ctx: AdapterContext,
): AdapterExtract | null {
  const bodyEl = doc.querySelector(".body-text.post-body");
  if (!bodyEl || !bodyEl.innerHTML.trim()) return null;
  canonicalizeMirrorLinks(bodyEl, ctx.url);

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
    // Parse WITH the "UTC" suffix first — stripping it made Date.parse read
    // the timestamp as local time and toISOString() shift it, an off-by-one
    // day near midnight on non-UTC hosts. Stripping is only the last resort.
    const raw = dateEl.textContent.trim();
    let t = Date.parse(raw);
    if (Number.isNaN(t)) t = Date.parse(raw.replace(/\s+UTC\s*$/i, ""));
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
  if (!/^https?:\/\//.test(canonical)) canonical = greaterWrongCanonicalSourceUrl(ctx.url);

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
    // Every spelling is read through its canonical forum form (a GreaterWrong
    // URL, comment path or #comment- anchor alike): the mirror is not always
    // up, so its pages are a fallback behind the forum's API.
    const forumUrl = greaterWrongCanonicalSourceUrl(ctx.url) || ctx.url;
    const api = forumGraphqlUrl(forumUrl);
    const mirror = greaterWrongMirrorUrl(forumUrl);
    let isComment = false;
    try {
      isComment = !!forumCommentId(new URL(forumUrl));
    } catch {
      /* invalid URL */
    }
    // A comment is read only from the API or the mirror's comment page: the
    // forum's page (and the mirror's post page) render the whole post.
    // A GreaterWrong post is covered by `mirror` already.
    const page = isComment || (mirror && forumUrl !== ctx.url) ? "" : ctx.url;
    return [...new Set([api, page, mirror].filter(Boolean))];
  },

  fetchAccept(candidateUrl: string): string | undefined {
    return isForumApiUrl(candidateUrl) ? "application/json" : undefined;
  },

  async convertFetched(response, ctx) {
    if (!isForumApiUrl(response.finalUrl)) return null;
    return { html: forumApiAnswerToHtml(new TextDecoder("utf-8").decode(response.bytes), ctx.url) };
  },

  extract(doc: Document, ctx: AdapterContext): AdapterExtract | null {
    if (doc.querySelector(`meta[name="generator"][content="${FORUM_GRAPHQL_MARKER}"]`)) {
      const body = doc.body.querySelector(":scope > .lens-forum-body");
      if (!body || !body.innerHTML.trim()) return null;
      // The API's HTML is final: every formula is MathJax markup, so a `$`
      // in the prose is a dollar sign ("$100 one week from now").
      markLiteralDollars(body);
      return {
        bodyHtml: body.innerHTML,
        title: (doc.head.querySelector('meta[name="lens-forum-title"]')?.getAttribute("content") || "").trim(),
        author: Array.from(doc.head.querySelectorAll('meta[name="lens-forum-author"]'))
          .map((a) => cleanAuthorName(a.getAttribute("content") || ""))
          .filter(Boolean),
        published: (doc.head.querySelector('meta[name="lens-forum-posted"]')?.getAttribute("content") || "").slice(0, 10),
      };
    }

    // GreaterWrong first — its host can also be reached via the ForumMagnum
    // fallback path below when a LW fetch fell back to the mirror.
    if (/(^|\.)greaterwrong\.com$/.test(ctx.host) || doc.querySelector(".body-text.post-body")) {
      const gw = extractGreaterWrong(doc, ctx);
      if (gw) return gw;
    }

    // Wiki/tag pages (lesswrong.com/w/<slug>) have no post body: their text
    // is the tag body under the page title. Without this branch they fell to
    // the generic extractors, which drop MathJax, so every equation was lost.
    if (doc.querySelector(".LWTagPage-title")) {
      const wikiBody =
        doc.querySelector(".LWTagPage-wikiSection .ContentStyles-tagBody") ||
        doc.querySelector(".ContentStyles-tagBody");
      if (wikiBody && wikiBody.innerHTML.trim()) {
        return {
          bodyHtml: wikiBody.innerHTML,
          title: stripSiteSuffix(doc.querySelector(".LWTagPage-title")?.textContent || ""),
          // A wiki page has contributors, not a byline; let the pipeline fall back.
          author: [],
          published: "",
        };
      }
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
