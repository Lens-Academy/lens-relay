/** Shared text helpers used by site adapters (and the generic path). */

const SITE_SUFFIX_RE =
  /\s*[—–|·-]\s*(LessWrong|AI Alignment Forum|Effective Altruism Forum|EA Forum|Less ?Wrong|AI Safety Atlas)\s*$/i;

// The last spaced separator (em/en dash, pipe, middot or hyphen) and what
// follows it. Spaces are REQUIRED around it, so hyphenated words
// ("Spider-Man") and unspaced dashes in real titles never split; the greedy
// head picks the LAST separator, so "A — B — Site" only loses "Site".
const TRAILING_SEGMENT_RE = /^(.*\S)\s+[—–|·-]\s+(\S.*)$/;

// Second-level labels under a two-letter country TLD ("bbc.co.uk").
const SECOND_LEVEL_LABELS = new Set(["co", "com", "ac", "org", "net", "gov", "edu"]);

/** Lowercase alphanumerics only — "The Atlantic" → "theatlantic". */
function normalizeForSiteMatch(s: string): string {
  return (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Names a URL's host goes by in <title> suffixes, normalized: the registrable
 * label ("https://www.lesswrong.com/x" → "lesswrong", "news.mit.edu" → "mit",
 * "www.bbc.co.uk" → "bbc") and the whole host without "www." and dots, for
 * sites named after their domain ("far.ai" → "farai", "FAR.AI"). Labels under
 * three characters are dropped ("x.com" would otherwise strip "- X").
 * Empty when the URL does not parse.
 */
function hostNames(url: string): string[] {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    const parts = host.split(".").filter(Boolean);
    if (parts.length === 0) return [];
    let i = parts.length >= 2 ? parts.length - 2 : 0;
    const tld = parts[parts.length - 1];
    if (i > 0 && tld.length === 2 && SECOND_LEVEL_LABELS.has(parts[i])) i -= 1;
    return [parts[i], parts.join("")].map(normalizeForSiteMatch).filter((n) => n.length >= 3);
  } catch {
    return [];
  }
}

/**
 * Strip a trailing " — SiteName" suffix from a page <title>.
 *
 * Two tiers:
 *  1. A short allow-list of known community sites (works with no context).
 *  2. Generic: the segment after the LAST spaced separator is stripped ONLY
 *     when it names the site itself — i.e. it normalizes equal to the page's
 *     og:site_name or to one of the URL host's names (LessWrong sets no
 *     og:site_name, but "lesswrong.com" → "lesswrong" matches). Real titles
 *     containing dashes/pipes are left untouched because their trailing
 *     segment doesn't name the site. Abbreviations ("| CAIS" for the Center
 *     for AI Safety at safe.ai) are not recognized.
 */
export function stripSiteSuffix(
  title: string,
  opts: { url?: string; siteName?: string } = {},
): string {
  const t = (title || "").replace(SITE_SUFFIX_RE, "").trim();

  const names = new Set([normalizeForSiteMatch(opts.siteName || ""), ...hostNames(opts.url || "")]);
  names.delete("");
  const m = t.match(TRAILING_SEGMENT_RE);
  if (m && names.has(normalizeForSiteMatch(m[2]))) return m[1].trim();
  return t;
}

/**
 * Normalize an author display string. Some sites render bylines as a handle
 * (e.g. "Joe_Carlsmith"); turn underscores into spaces and collapse
 * whitespace. Pure handles with no separator (e.g. "evhub") can't be expanded
 * without an external directory and are left as-is.
 */
export function cleanAuthorName(s: string): string {
  return (s || "").replace(/_/g, " ").replace(/\s+/g, " ").trim();
}

/** Split a comma/"and"/";"-separated author string into individual names. */
export function splitAuthors(s: string): string[] {
  return (s || "")
    .split(/\s*,\s*|\s+and\s+|\s*;\s*/)
    .map(cleanAuthorName)
    .filter(Boolean);
}

/** Pull a YYYY-MM-DD out of an arbitrary date-ish string ("" if none). */
export function toIsoDate(s: string): string {
  const m = String(s || "").match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : "";
}

// Exact hostnames whose iframes we treat as embeddable video players. We only
// ever pass these through as raw HTML — never arbitrary iframes. Matching is on
// the PARSED hostname: a substring check would let "vimeo.com.evil.com",
// "evil.com/?youtube.com", "javascript:…//youtube.com" etc. through.
const VIDEO_EMBED_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "youtube-nocookie.com",
  "www.youtube-nocookie.com",
  "youtu.be",
  "www.youtu.be",
  "vimeo.com",
  "www.vimeo.com",
  "player.vimeo.com",
]);

/** Parse an iframe src to an http(s) URL (resolving protocol-relative), or null.
 *  A relative src resolves to the throwaway base host and is rejected. */
function parseEmbedUrl(src: string | null | undefined): URL | null {
  if (!src) return null;
  let u: URL;
  try {
    u = new URL(src.trim(), "https://invalid.invalid");
  } catch {
    return null;
  }
  return u.protocol === "https:" || u.protocol === "http:" ? u : null;
}

/** Is this iframe src a recognized video embed (YouTube / Vimeo), by hostname? */
export function isVideoEmbedUrl(src: string | null | undefined): boolean {
  const u = parseEmbedUrl(src);
  return !!u && VIDEO_EMBED_HOSTS.has(u.hostname.toLowerCase());
}

/**
 * Emit a private placeholder line for a video embed. Raw <iframe>s are
 * rejected by the Lens article validator; the canonical form is a
 * `::video[[../video_transcripts/…]]` directive backed by an imported
 * transcript document. The transcript path needs network work, so extraction
 * emits this marker and the pipeline's resolving-videos stage replaces every
 * marker with the directive (importing the video first when needed) or, when
 * that is impossible, a plain link — see server/add-article/video-embeds.ts.
 * Only call on a src that passed `isVideoEmbedUrl`.
 */
export function videoEmbedMarker(src: string): string {
  const u = parseEmbedUrl(src);
  return u ? `__lensvideo:${u.href}__` : "";
}
