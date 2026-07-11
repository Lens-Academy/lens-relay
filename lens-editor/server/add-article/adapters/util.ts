/** Shared text helpers used by site adapters (and the generic path). */

const SITE_SUFFIX_RE =
  /\s*[—–|·-]\s*(LessWrong|AI Alignment Forum|Effective Altruism Forum|EA Forum|Less ?Wrong|AI Safety Atlas)\s*$/i;

// A generic title/site-name separator: em/en dash, pipe, middot, or hyphen,
// REQUIRED to be surrounded by whitespace so hyphenated words ("Spider-Man")
// and unspaced dashes inside real titles are never treated as separators.
const GENERIC_SEP_RE = /\s+[—–|·-]\s+/g;

/** Lowercase alphanumerics only — "The Atlantic" → "theatlantic". */
function normalizeForSiteMatch(s: string): string {
  return (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Registrable label of a URL's host — the site's identity word as it tends to
 * appear in <title> suffixes: "https://www.lesswrong.com/x" → "lesswrong",
 * "https://www.bbc.co.uk/x" → "bbc" (short ccTLD-ish labels are skipped).
 * "" when unparseable.
 */
function hostBaseName(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    const parts = host.split(".").filter(Boolean);
    if (parts.length === 0) return "";
    let label = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
    if (parts.length >= 3 && label.length <= 3) label = parts[parts.length - 3];
    return label || "";
  } catch {
    return "";
  }
}

/**
 * Strip a trailing " — SiteName" suffix from a page <title>.
 *
 * Two tiers:
 *  1. A short allow-list of known community sites (works with no context).
 *  2. Generic: the segment after the LAST spaced separator is stripped ONLY
 *     when it names the site itself — i.e. it normalizes equal to the page's
 *     og:site_name or to the URL host's registrable label (LessWrong sets no
 *     og:site_name, but "lesswrong.com" → "lesswrong" matches). Real titles
 *     containing dashes/pipes are left untouched because their trailing
 *     segment doesn't name the site.
 */
export function stripSiteSuffix(
  title: string,
  opts: { url?: string; siteName?: string } = {},
): string {
  const t = (title || "").replace(SITE_SUFFIX_RE, "").trim();

  const candidates = new Set(
    [normalizeForSiteMatch(opts.siteName || ""), normalizeForSiteMatch(hostBaseName(opts.url || ""))].filter(
      Boolean,
    ),
  );
  if (candidates.size === 0) return t;

  // Split on the LAST separator so "A — B — Site" only loses "Site".
  let last: RegExpExecArray | null = null;
  GENERIC_SEP_RE.lastIndex = 0;
  for (let m = GENERIC_SEP_RE.exec(t); m; m = GENERIC_SEP_RE.exec(t)) last = m;
  if (!last) return t;

  const head = t.slice(0, last.index).trim();
  const tail = t.slice(last.index + last[0].length).trim();
  if (head && candidates.has(normalizeForSiteMatch(tail))) return head;
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
 * Render a clean, render-safe <iframe> for a video embed so it survives into
 * the imported Markdown. The platform's article renderer runs rehype-raw, so
 * the iframe renders inline exactly where the video was. Emits the normalized
 * absolute URL — only call on a src that passed `isVideoEmbedUrl`.
 */
export function videoEmbedIframe(src: string): string {
  const u = parseEmbedUrl(src);
  const s = u ? u.href : "";
  return (
    `<iframe src="${s}" width="560" height="315" frameborder="0" ` +
    `allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" ` +
    `referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe>`
  );
}
