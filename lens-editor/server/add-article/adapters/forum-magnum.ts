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

/** A comment permalink on a ForumMagnum site or its mirror. */
export interface ForumCommentRef {
  /** Host without "www.", lower case. */
  host: string;
  /** `/posts/<postId>` plus `/<slug>` when the URL had one. */
  postPath: string;
  postId: string;
  commentId: string;
}

/**
 * The comment a URL points at: ForumMagnum's `?commentId=<id>` (LessWrong,
 * the Alignment Forum, the EA Forum, GreaterWrong) or GreaterWrong's
 * `/posts/<id>/<slug>/comment/<id>` path or `#comment-<id>` anchor. Null for anything else, a post
 * URL included. Such a URL must import the comment, never the post above it.
 */
export function forumCommentRef(url: string): ForumCommentRef | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^www\./, "").toLowerCase();
  if (!FORUM_HOST_RE.test(host) && host !== "forum.effectivealtruism.org") return null;
  const m = u.pathname.match(
    /^\/posts\/([A-Za-z0-9]{8,32})((?:\/[\w-]+)?)(?:\/comment\/([A-Za-z0-9]{8,32}))?\/?$/,
  );
  // A post inside a sequence (`/s/<seq>/p/<id>`) takes `?commentId=` too.
  const inSequence = m ? null : u.pathname.match(/^\/s\/[\w-]+\/p\/([A-Za-z0-9]{8,32})\/?$/);
  const postId = m?.[1] ?? inSequence?.[1];
  if (!postId) return null;
  const query = u.searchParams.get("commentId") ?? "";
  const anchor = host.endsWith("greaterwrong.com") ? u.hash.match(/^#comment-([A-Za-z0-9]{8,32})$/)?.[1] : "";
  const commentId = m?.[3] || anchor || (/^[A-Za-z0-9]{8,32}$/.test(query) ? query : "");
  if (!commentId) return null;
  return { host, postPath: `/posts/${postId}${m?.[2] ?? ""}`, postId, commentId };
}

/** GreaterWrong permalink of a comment: its own page shows just that comment
 *  thread. LW/AF comments live at the apex host, EA Forum ones at `ea.`. */
export function greaterWrongCommentUrl(ref: ForumCommentRef): string {
  const ea = ref.host === "forum.effectivealtruism.org" || ref.host === "ea.greaterwrong.com";
  // Other mirror subdomains (arbital.) are not ForumMagnum mirrors.
  if (!ea && ref.host.endsWith(".greaterwrong.com")) return "";
  // GreaterWrong's comment route needs the post's slug, which a slug-less or
  // sequence (`/s/<seq>/p/<id>`) URL lacks: no mirror then, the API only.
  if (!/^\/posts\/[^/]+\/[^/]+$/.test(ref.postPath)) return "";
  return `https://${ea ? "ea" : "www"}.greaterwrong.com${ref.postPath}/comment/${ref.commentId}`;
}

/** greaterwrong.com mirror URL for a ForumMagnum post URL ("" if not one).
 *  GreaterWrong serves LW/AF at its apex host and the EA Forum at `ea.`,
 *  with identical /posts/... paths. A comment URL maps to the comment's
 *  mirror page (on a mirror host too), never to the post's. */
export function greaterWrongMirrorUrl(url: string): string {
  const comment = forumCommentRef(url);
  if (comment) return greaterWrongCommentUrl(comment);
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

/**
 * The forum's own URL for a GreaterWrong mirror URL ("" if not one): the same
 * path on lesswrong.com / forum.effectivealtruism.org, a comment permalink
 * (`/comment/<id>` path or `#comment-<id>` anchor) as `?commentId=<id>`.
 * `arbital.greaterwrong.com` is not mapped: it mirrors a defunct site, so it
 * IS the best available destination. `bare` keeps only the post path and the
 * comment id: a document's identity, without view parameters or fragments.
 */
export function greaterWrongCanonicalUrl(url: string, baseUrl?: string, bare = false): string {
  let u: URL;
  try {
    u = new URL(url, baseUrl);
  } catch {
    return "";
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return "";
  const host = u.hostname.replace(/^www\./, "").toLowerCase();
  if (host !== "greaterwrong.com" && host !== "ea.greaterwrong.com") return "";
  const comment = forumCommentRef(u.href);
  u.protocol = "https:";
  u.hostname = host === "greaterwrong.com" ? "www.lesswrong.com" : "forum.effectivealtruism.org";
  if (bare) u.search = "";
  if (bare || comment) u.hash = "";
  if (comment) {
    u.pathname = comment.postPath;
    u.searchParams.set("commentId", comment.commentId);
  }
  return u.href;
}

/** `greaterWrongCanonicalUrl` as a document's source_url. */
export function greaterWrongCanonicalSourceUrl(url: string): string {
  return greaterWrongCanonicalUrl(url, undefined, true);
}

/**
 * Rewrite mirror-host links in a GreaterWrong body to the forum's own URLs, so
 * a mirror-fetched article cites lesswrong.com / forum.effectivealtruism.org
 * in its BODY as well as its source_url. Relative hrefs resolve against the
 * mirror; in-page anchors and non-mirror links stay.
 */
export function canonicalizeMirrorLinks(root: Element, baseUrl: string): void {
  root.querySelectorAll("a[href]").forEach((a) => {
    const href = a.getAttribute("href") || "";
    if (!href || href.startsWith("#")) return;
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

/** GET URL of the API query for a post or wiki page URL ("" if not one). */
export function forumGraphqlUrl(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "";
  }
  const endpoint = FORUM_API_HOSTS[u.hostname.replace(/^www\./, "").toLowerCase()];
  if (!endpoint) return "";
  // A comment permalink (`?commentId=`) asks for the comment, not its post.
  const comment = forumCommentRef(url);
  if (comment) {
    const query =
      `{ comment(selector: {_id: "${comment.commentId}"}) { result { postedAt ` +
      "user { displayName } contents { html } post { title } } } }";
    return `${endpoint}?query=${encodeURIComponent(query)}`;
  }
  // Ids and slugs are [A-Za-z0-9_-]; anything else is not a page we know,
  // and nothing else may reach the query text.
  const post = u.pathname.match(/^\/(?:posts|s\/[\w-]+\/p)\/([A-Za-z0-9]{8,32})(?:\/[\w-]*)?\/?$/);
  const wiki = u.pathname.match(/^\/(?:w|tag)\/([\w-]+)\/?$/);
  let query: string;
  if (post) {
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
    tags?: { results?: ForumApiTag[] | null } | null;
    comment?: { result?: ForumApiComment | null } | null;
  };
}
interface ForumApiComment {
  postedAt?: string;
  user?: { displayName?: string } | null;
  contents?: { html?: string } | null;
  post?: { title?: string } | null;
}
interface ForumApiPost {
  title?: string;
  postedAt?: string;
  user?: { displayName?: string } | null;
  coauthors?: { displayName?: string }[] | null;
  contents?: { html?: string } | null;
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
  const post = answer.data?.post?.result;
  const tag = answer.data?.tags?.results?.[0];
  const comment = answer.data?.comment?.result;
  // A comment is titled after its post, as GreaterWrong comment imports are.
  const title = comment
    ? comment.post?.title
      ? `Comment on ${comment.post.title}`
      : ""
    : (post?.title ?? tag?.name ?? "");
  // Page metadata tags in the post's own HTML (a canonical link, citation_*
  // meta) would be read as the article's: the metadata scan covers the whole
  // document. Post bodies never need them.
  let body = comment?.contents?.html ?? post?.contents?.html ?? tag?.description?.html ?? "";
  // Until stable: removing one tag must not splice the halves of another.
  for (let prev = ""; prev !== body; ) {
    prev = body;
    body = body.replace(/<(?:meta|link)\b[^>]*>/gi, "");
  }
  if (!title || !body.trim()) throw new Error("forum API answer holds no article");
  const authors = (
    comment
      ? [comment.user?.displayName]
      : post
        ? [post.user?.displayName, ...(post.coauthors ?? []).map((c) => c.displayName)]
        : []
  ).filter((name): name is string => !!name);
  const postedAt = comment?.postedAt ?? post?.postedAt;
  return [
    "<!doctype html><html><head>",
    `<meta name="generator" content="${FORUM_GRAPHQL_MARKER}">`,
    `<title>${escapeHtml(title)}</title>`,
    canonicalUrl ? `<link rel="canonical" href="${escapeHtml(canonicalUrl)}">` : "",
    // The byline lives in <head>, out of reach of the post's own (untrusted)
    // HTML, which could otherwise forge these elements.
    ...authors.map((name) => `<meta name="lens-forum-author" content="${escapeHtml(name)}">`),
    postedAt ? `<meta name="lens-forum-posted" content="${escapeHtml(postedAt)}">` : "",
    `<meta name="lens-forum-title" content="${escapeHtml(title)}">`,
    "</head><body>",
    `<div class="lens-forum-body">${body}</div>`,
    "</body></html>",
  ].join("\n");
}

/** GreaterWrong branch: mirror pages are server-rendered with their own DOM. */
/** A GreaterWrong date element as YYYY-MM-DD ("" when it has none). */
function greaterWrongDate(dateEl: Element | null): string {
  // The epoch in data-js-date first; the text ("7 Apr 2021 20:12 UTC") is
  // the fallback.
  const epochMs = Number(dateEl?.getAttribute("data-js-date"));
  if (Number.isFinite(epochMs) && epochMs > 0) {
    return new Date(epochMs).toISOString().slice(0, 10);
  }
  if (dateEl?.textContent) {
    // Parse WITH the "UTC" suffix first — stripping it made Date.parse read
    // the timestamp as local time and toISOString() shift it, an off-by-one
    // day near midnight on non-UTC hosts. Stripping is only the last resort.
    const raw = dateEl.textContent.trim();
    let t = Date.parse(raw);
    if (Number.isNaN(t)) t = Date.parse(raw.replace(/\s+UTC\s*$/i, ""));
    if (!Number.isNaN(t)) return new Date(t).toISOString().slice(0, 10);
  }
  return "";
}

/**
 * GreaterWrong comment page (`/posts/<id>/<slug>/comment/<id>`): no post body,
 * a heading "<user> comments on <post title>", then the comment's thread. Only
 * the permalinked comment is the article: its own body, byline, date and "LW"
 * link (the `?commentId=` URL), never the replies nested under it.
 */
function extractGreaterWrongComment(
  doc: Document,
  ctx: AdapterContext,
  commentId: string,
): AdapterExtract | null {
  const item = doc.getElementById(`comment-${commentId}`);
  const comment = item?.querySelector(":scope > .comment");
  const bodyEl = comment?.querySelector(":scope > .body-text.comment-body");
  if (!comment || !bodyEl || !bodyEl.innerHTML.trim()) return null;
  canonicalizeMirrorLinks(bodyEl, ctx.url);
  const meta = comment.querySelector(":scope > .comment-meta");
  const postTitle = (doc.querySelector("h1.post-title a")?.textContent || "").trim();
  const author = cleanAuthorName(meta?.querySelector("a.author")?.textContent || "");
  const canonical = meta?.querySelector("a.lw2-link")?.getAttribute("href")?.trim() || "";
  return {
    bodyHtml: bodyEl.innerHTML,
    title: postTitle ? `Comment on ${postTitle}` : "",
    author: author ? [author] : [],
    published: greaterWrongDate(meta?.querySelector(".date") ?? null),
    canonicalUrl: /^https:\/\/(www\.)?(lesswrong\.com|alignmentforum\.org|forum\.effectivealtruism\.org)\//.test(canonical)
      ? canonical
      : undefined,
    // The comment is the whole source: a short one is not a mis-fire.
    minBodyChars: 1,
  };
}

function extractGreaterWrong(
  doc: Document,
  ctx: AdapterContext,
): AdapterExtract | null {
  const commentRef = forumCommentRef(ctx.url);
  if (commentRef) return extractGreaterWrongComment(doc, ctx, commentRef.commentId);
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

  // Comments have dates too — scope to post-meta.
  const published = greaterWrongDate(
    doc.querySelector(".top-post-meta .date") || doc.querySelector(".post-meta .date"),
  );

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
   * A comment URL skips the forum page itself: that page is the whole post
   * (comments load client-side), so only the API and GreaterWrong's comment
   * page hold the comment alone.
   * A GreaterWrong URL is read as the forum's own (API first): the mirror is
   * not always up.
   */
  resolveFetchUrls(ctx: AdapterContext): string[] {
    const forumUrl = greaterWrongCanonicalSourceUrl(ctx.url) || ctx.url;
    const api = forumGraphqlUrl(forumUrl);
    const mirror = greaterWrongMirrorUrl(forumUrl);
    if (forumCommentRef(forumUrl)) return [...new Set([api, mirror].filter(Boolean))];
    if (forumUrl !== ctx.url) return [...new Set([api, mirror || ctx.url].filter(Boolean))];
    return [api, ctx.url, mirror].filter(Boolean);
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
        // The API answer is the whole post or comment: a short comment is
        // its full text, not a mis-fire.
        minBodyChars: 1,
      };
    }

    // GreaterWrong first — its host can also be reached via the ForumMagnum
    // fallback path below when a LW fetch fell back to the mirror.
    if (/(^|\.)greaterwrong\.com$/.test(ctx.host) || doc.querySelector(".body-text.post-body")) {
      const gw = extractGreaterWrong(doc, ctx);
      if (gw) return gw;
    }

    // A comment URL whose page did not yield the comment alone: a forum page
    // for `?commentId=` is the whole post (comments load client-side), a
    // GreaterWrong thread page without the comment would be scraped with its
    // replies. Importing either files the wrong text under the comment's URL,
    // so fail; the API and GreaterWrong's comment page are the sources.
    if (forumCommentRef(ctx.url)) {
      throw new Error("This page does not hold the linked comment on its own; the comment could not be fetched");
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
