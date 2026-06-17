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

// Iframe hosts we treat as embeddable video players. We only ever pass these
// through as raw HTML — never arbitrary iframes (ads/trackers/cross-site).
const VIDEO_EMBED_HOST_RE =
  /(?:youtube\.com|youtube-nocookie\.com|youtu\.be|player\.vimeo\.com|vimeo\.com)/i;

/** Is this iframe src a recognized video embed (YouTube / Vimeo)? */
export function isVideoEmbedUrl(src: string | null | undefined): boolean {
  return !!src && VIDEO_EMBED_HOST_RE.test(src);
}

/**
 * Render a clean, render-safe <iframe> for a video embed so it survives into
 * the imported Markdown. The platform's article renderer runs rehype-raw, so
 * the iframe renders inline exactly where the video was in the source.
 */
export function videoEmbedIframe(src: string): string {
  let s = (src || "").trim().replace(/"/g, "");
  if (s.startsWith("//")) s = `https:${s}`;
  return (
    `<iframe src="${s}" width="560" height="315" frameborder="0" ` +
    `allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" ` +
    `referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe>`
  );
}
