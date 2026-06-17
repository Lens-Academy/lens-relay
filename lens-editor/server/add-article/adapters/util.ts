/** Shared text helpers used by site adapters (and the generic path). */

const SITE_SUFFIX_RE =
  /\s*[—–|·-]\s*(LessWrong|AI Alignment Forum|Effective Altruism Forum|EA Forum|Less ?Wrong|AI Safety Atlas)\s*$/i;

/** Strip a known trailing " — SiteName" suffix from a page <title>. */
export function stripSiteSuffix(title: string): string {
  return (title || "").replace(SITE_SUFFIX_RE, "").trim();
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
