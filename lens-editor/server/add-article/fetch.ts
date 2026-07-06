import { assertPublicUrl } from "./ssrf";
import { fetchBytesWithTimeout } from "../fetch-timeout";

const FETCH_TIMEOUT_MS = 30_000;
const RENDER_TIMEOUT_MS = 60_000;
// Heavy interactive pages (e.g. distill.pub with inline assets) can be large.
const MAX_HTML_BYTES = 32 * 1024 * 1024; // 32MB
const MAX_REDIRECTS = 5;

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/**
 * Follow redirects manually (re-validating the SSRF guard on every hop —
 * `redirect: 'follow'` would let an allowed page bounce to an internal host
 * without re-validation) and return the final response's raw bytes + content
 * type. Shared by the HTML and PDF fetchers. Throws on non-OK or oversized
 * responses. `signal` is the per-job deadline/cancel signal.
 */
async function fetchFollowingRedirects(
  url: string,
  accept: string,
  signal?: AbortSignal,
): Promise<{ bytes: ArrayBuffer; contentType: string; finalUrl: string }> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicUrl(current);
    const resp = await fetchBytesWithTimeout(current, {
      headers: {
        "User-Agent": BROWSER_UA,
        Accept: accept,
        "Accept-Language": "en-US,en;q=0.9",
      },
      timeoutMs: FETCH_TIMEOUT_MS,
      signal,
      maxBytes: MAX_HTML_BYTES,
    });

    if (resp.status >= 300 && resp.status < 400) {
      const location = resp.headers.get("location");
      if (!location) {
        throw new Error(`Redirect ${resp.status} with no Location header`);
      }
      current = new URL(location, current).href; // resolve relative redirects
      continue;
    }

    if (!resp.ok) {
      throw new Error(`Fetch failed: ${resp.status} ${resp.statusText}`);
    }
    if (resp.bytes.byteLength > MAX_HTML_BYTES) {
      throw new Error(`Page too large: ${resp.bytes.byteLength} bytes`);
    }
    return {
      bytes: resp.bytes,
      contentType: resp.headers.get("content-type") || "",
      finalUrl: current,
    };
  }
  throw new Error(`Too many redirects (>${MAX_REDIRECTS}) for ${url}`);
}

/** Fetch the raw HTML of an article page. */
export async function fetchRawHtml(
  url: string,
  signal?: AbortSignal,
): Promise<string> {
  const { bytes } = await fetchFollowingRedirects(
    url,
    "text/html,application/xhtml+xml",
    signal,
  );
  return new TextDecoder("utf-8").decode(bytes);
}

/** Fetch raw bytes + content type for a binary resource (e.g. a PDF), using the
 *  same SSRF/redirect/size guards as fetchRawHtml. */
export async function fetchRawBytes(
  url: string,
  signal?: AbortSignal,
): Promise<{ bytes: ArrayBuffer; contentType: string; finalUrl: string }> {
  // Prefer HTML (most single-candidate URLs are pages) but accept a PDF or
  // anything else — the caller sniffs the result and branches.
  return fetchFollowingRedirects(
    url,
    "text/html,application/xhtml+xml,application/pdf,*/*",
    signal,
  );
}

/** Detect a PDF by response content type or a `%PDF-` header. Scans the first
 *  1KB because some files have whitespace/junk before the header. */
export function looksLikePdf(contentType: string, bytes: ArrayBuffer): boolean {
  if (/application\/pdf/i.test(contentType)) return true;
  const head = new TextDecoder("latin1").decode(new Uint8Array(bytes).slice(0, 1024));
  return head.includes("%PDF-");
}

/**
 * Fetch the first candidate URL that returns usable HTML. Used with an
 * adapter's `resolveFetchUrls` (e.g. try arxiv.org/html, then ar5iv). Throws
 * the last error if every candidate fails.
 */
export async function fetchFirstHtml(
  urls: string[],
  signal?: AbortSignal,
): Promise<{ html: string; url: string }> {
  let lastErr: unknown = new Error("No candidate URLs to fetch");
  for (const u of urls) {
    try {
      return { html: await fetchRawHtml(u, signal), url: u };
    } catch (err) {
      lastErr = err;
      if (signal?.aborted) break; // job cancelled/timed out — stop trying mirrors
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/**
 * Fetch the *rendered* HTML of a page via the Jina Reader browser engine
 * (X-Return-Format: html). Used as a fallback when the raw fetch is a JS-only
 * SPA skeleton or is bot-blocked: Jina renders the page (from its own network)
 * and returns the post-JS DOM, which we then run our deterministic extractor
 * over — "buy the rendering, own the extraction". SSRF: we still validate the
 * target is a public http(s) URL before handing it off.
 */
let warnedNoJinaKey = false;

export async function fetchRenderedHtml(
  url: string,
  signal?: AbortSignal,
): Promise<string> {
  await assertPublicUrl(url);
  const headers: Record<string, string> = {
    Accept: "text/html",
    "X-Return-Format": "html",
    "X-Timeout": "45",
  };
  if (process.env.JINA_API_KEY) {
    headers.Authorization = `Bearer ${process.env.JINA_API_KEY}`;
  } else if (!warnedNoJinaKey) {
    // Anonymous Jina requests hit a far lower rate limit and get queued/starved
    // under load — in production this manifested as bot-blocked sites hanging.
    warnedNoJinaKey = true;
    console.warn(
      "[add-article] JINA_API_KEY is not set — render-tier fetches run against " +
        "Jina's anonymous rate limit and may be throttled or starved. Set it in .env.",
    );
  }
  const resp = await fetchBytesWithTimeout(
    `https://r.jina.ai/${encodeURIComponent(url)}`,
    { headers, timeoutMs: RENDER_TIMEOUT_MS, signal, maxBytes: MAX_HTML_BYTES },
  );
  if (resp.status === 429) {
    throw new Error(
      process.env.JINA_API_KEY
        ? "Render fetch rate-limited by Jina (429) — retry later."
        : "Render fetch rate-limited by Jina (429) — set JINA_API_KEY to raise the limit.",
    );
  }
  if (!resp.ok) {
    throw new Error(`Render fetch failed: ${resp.status} ${resp.statusText}`);
  }
  if (resp.bytes.byteLength > MAX_HTML_BYTES) {
    throw new Error(`Rendered page too large: ${resp.bytes.byteLength} bytes`);
  }
  return new TextDecoder("utf-8").decode(resp.bytes);
}

export interface HtmlMeta {
  title: string;
  author: string[];
  published: string;
  description: string;
  /** Publication / site name (og:site_name, JSON-LD publisher) — author fallback */
  siteName: string;
  /** The page's own canonical URL (<link rel="canonical">), "" if absent. Lets
   *  a mirror/AMP/tracking-parameter URL resolve to the URL the site itself
   *  considers authoritative — used for source_url and duplicate detection. */
  canonicalUrl: string;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) =>
      String.fromCodePoint(parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)));
}

/** Find <meta property|name="key" content="..."> regardless of attribute order */
function metaContent(html: string, key: string): string {
  const patterns = [
    new RegExp(
      `<meta[^>]+(?:property|name)=["']${key}["'][^>]+content=["']([^"']*)["']`,
      "i",
    ),
    new RegExp(
      `<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${key}["']`,
      "i",
    ),
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (m?.[1]) return decodeEntities(m[1].trim());
  }
  return "";
}

/** All values for a repeated meta tag (e.g. multiple citation_author tags),
 *  regardless of attribute order. */
function metaContentAll(html: string, key: string): string[] {
  const res = [
    new RegExp(
      `<meta[^>]+(?:property|name)=["']${key}["'][^>]+content=["']([^"']*)["']`,
      "gi",
    ),
    new RegExp(
      `<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${key}["']`,
      "gi",
    ),
  ];
  const out: string[] = [];
  for (const re of res) {
    for (const m of html.matchAll(re)) {
      const v = decodeEntities((m[1] || "").trim());
      if (v) out.push(v);
    }
  }
  return out;
}

/** "Last, First" → "First Last" (citation_author convention); else unchanged. */
function flipCommaName(s: string): string {
  const m = s.match(/^([^,]+),\s*([^,]+)$/);
  return m ? `${m[2].trim()} ${m[1].trim()}` : s;
}

/** True if (year, month, day) strings form a plausible calendar date. Guards
 *  against URL/issue numbers producing structurally-invalid dates like
 *  2020-45-01 (which would land, unquoted, in the YAML frontmatter). */
export function isValidYmd(y: string, mo: string, d: string): boolean {
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  return (
    year >= 1990 &&
    year <= 2100 &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= 31
  );
}

/** Normalize a date string to YYYY-MM-DD (ISO, slashed, or parseable text). */
function normalizeDate(s: string): string {
  if (!s) return "";
  const m = s.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (m && isValidYmd(m[1], m[2], m[3])) {
    return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  }
  // Textual dates ("January 1, 2024") via Date.parse — but only when the
  // string actually contains a 4-digit year (Date.parse("7") fabricates
  // 2001-06-30), and only if the result is a sane calendar date. Use LOCAL
  // components: date-only text parses as local midnight, so UTC components
  // would be off by one east of Greenwich.
  if (!/\b(19|20)\d{2}\b/.test(s)) return "";
  const t = Date.parse(s);
  if (Number.isNaN(t)) return "";
  const d = new Date(t);
  const y = String(d.getFullYear());
  const mo = String(d.getMonth() + 1);
  const day = String(d.getDate());
  if (!isValidYmd(y, mo, day)) return "";
  return `${y}-${mo.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

/** Date embedded in a URL path, e.g. /2017/02/14/ or /2016/09/. */
export function dateFromUrl(url: string): string {
  try {
    const m = new URL(url).pathname.match(
      /\/(\d{4})\/(\d{1,2})(?:\/(\d{1,2}))?(?=\/|$|[-_])/,
    );
    if (m && isValidYmd(m[1], m[2], m[3] || "01")) {
      return `${m[1]}-${m[2].padStart(2, "0")}-${(m[3] || "01").padStart(2, "0")}`;
    }
  } catch {
    /* ignore */
  }
  return "";
}

/** A standalone 4-digit year path segment (e.g. ".../paper/2017/file/...") →
 *  "YYYY-01-01". Weaker than a full date but a useful fallback for
 *  proceedings-style URLs whose only date hint is the publication year. */
export function yearFromUrl(url: string): string {
  try {
    const m = new URL(url).pathname.match(/\/((?:19|20)\d{2})(?=\/|$)/);
    if (m) return `${m[1]}-01-01`;
  } catch {
    /* ignore */
  }
  return "";
}

/**
 * Best-effort metadata extraction from HTML meta tags and JSON-LD.
 * Claude refines this later with full page context — this only seeds meta.json.
 */
/** href of `<link rel="canonical">` when it is an absolute http(s) URL. */
function canonicalFromHtml(html: string): string {
  const patterns = [
    /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i,
    /<link[^>]+href=["']([^"']+)["'][^>]+rel=["']canonical["']/i,
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (!m?.[1]) continue;
    try {
      const u = new URL(decodeEntities(m[1].trim()));
      if (u.protocol === "http:" || u.protocol === "https:") return u.href;
    } catch {
      /* relative or malformed canonical — ignore */
    }
  }
  return "";
}

export function extractHtmlMeta(html: string): HtmlMeta {
  const meta: HtmlMeta = {
    title: "",
    author: [],
    published: "",
    description: "",
    siteName: "",
    canonicalUrl: canonicalFromHtml(html),
  };

  meta.title =
    metaContent(html, "og:title") || metaContent(html, "twitter:title");
  if (!meta.title) {
    const m = html.match(/<title[^>]*>([^<]*)<\/title>/i);
    if (m) meta.title = decodeEntities(m[1].trim());
  }

  // Academic pages emit one <meta name="citation_author"> per author.
  const citationAuthors = metaContentAll(html, "citation_author").map(flipCommaName);
  if (citationAuthors.length > 0) {
    meta.author = citationAuthors;
  } else {
    const author =
      metaContent(html, "author") ||
      metaContent(html, "article:author") ||
      metaContent(html, "parsely-author");
    if (author && !author.startsWith("http")) {
      meta.author = author
        .split(/,| and |;/)
        .map((a) => a.trim())
        .filter(Boolean);
    }
  }

  // Publication-date tags only. article:modified_time / og:updated_time are
  // deliberately NOT in this chain — a modification date can trail publication
  // by years (a 2021 post edited in 2023 was imported as published 2023), and a
  // wrong year is worse than an empty date (which falls back to the import date
  // that a curator can correct).
  const published =
    metaContent(html, "article:published_time") ||
    metaContent(html, "datePublished") ||
    metaContent(html, "citation_publication_date") ||
    metaContent(html, "citation_date") ||
    metaContent(html, "parsely-pub-date") ||
    metaContent(html, "sailthru.date") ||
    metaContent(html, "dc.date.issued") ||
    metaContent(html, "dc.date") ||
    metaContent(html, "date");
  meta.published = normalizeDate(published);
  if (!meta.published) {
    // A bare <time datetime> is only trustworthy when it's the page's SINGLE
    // time element (a blog post's date line). On comment-bearing pages (forums,
    // mirrors) the first <time> is often a comment timestamp.
    const times = [...html.matchAll(/<time[^>]+datetime=["']([^"']+)["']/gi)];
    if (times.length === 1) meta.published = normalizeDate(times[0][1]);
  }

  meta.description =
    metaContent(html, "og:description") || metaContent(html, "description");

  meta.siteName =
    metaContent(html, "og:site_name") ||
    metaContent(html, "application-name");

  // JSON-LD often has the most reliable author/date info
  const jsonLdBlocks = html.matchAll(
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  );
  for (const block of jsonLdBlocks) {
    try {
      const data = JSON.parse(block[1]);
      const nodes = Array.isArray(data) ? data : data["@graph"] || [data];
      for (const node of nodes) {
        if (!node || typeof node !== "object") continue;
        const type = String(node["@type"] ?? "");
        if (!/Article|BlogPosting|NewsArticle/i.test(type)) continue;
        if (meta.author.length === 0 && node.author) {
          const authors = Array.isArray(node.author)
            ? node.author
            : [node.author];
          meta.author = authors
            .map((a: unknown) =>
              typeof a === "string"
                ? a
                : ((a as { name?: string })?.name ?? ""),
            )
            .filter(Boolean);
        }
        // datePublished ONLY — dateModified is an edit stamp, and using it
        // reintroduces the wrong-year bug the meta-tag chain above documents
        // (a 2021 post edited in 2023 importing as published 2023).
        const ldDate =
          typeof node.datePublished === "string" ? node.datePublished : "";
        if (!meta.published && ldDate) {
          meta.published = normalizeDate(ldDate);
        }
        if (!meta.siteName && node.publisher) {
          const pub =
            typeof node.publisher === "string"
              ? node.publisher
              : ((node.publisher as { name?: string })?.name ?? "");
          if (pub) meta.siteName = pub;
        }
        if (!meta.title && typeof node.headline === "string") {
          meta.title = node.headline;
        }
      }
    } catch {
      // ignore malformed JSON-LD
    }
  }

  return meta;
}
