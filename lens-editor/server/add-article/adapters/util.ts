/** Shared text helpers used by site adapters (and the generic path). */

// A plain hyphen only counts as a title/site separator when preceded by
// whitespace — otherwise "E-LessWrong" / "Anti-EA Forum" style compounds lose
// their tail. Em/en dashes, pipe and middot are unambiguous even when tight.
const SITE_SUFFIX_RE =
  /(?:\s[—–|·-]|[—–|·])\s*(LessWrong|AI Alignment Forum|Effective Altruism Forum|EA Forum|Less ?Wrong|AI Safety Atlas)\s*$/i;

// Titles can reach us with residual HTML entities: Readability derives its
// title from the <h1> without decoding, so "biggest&nbsp;problems" arrives
// with the literal entity. ONE single pass over the source string — produced
// text is never re-scanned, so "&amp;nbsp;" and "&#38;nbsp;" both decode
// exactly one level (to the literal "&nbsp;"), and NBSP becomes a plain space
// (it would otherwise leak into filenames/YAML).
const NAMED_ENTITIES: Record<string, string> = {
  nbsp: " ",
  amp: "&",
  quot: '"',
  apos: "'",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  lt: "<",
  gt: ">",
};

/** Decode a numeric character reference, refusing code points that corrupt
 * downstream consumers: NUL/C0/C1 controls break filenames, lone surrogates
 * break UTF-8 serialization (String.fromCodePoint emits both happily). */
function fromCodePointSafe(cp: number): string {
  if (!Number.isFinite(cp)) return "";
  if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f) || (cp >= 0xd800 && cp <= 0xdfff))
    return "";
  try {
    return String.fromCodePoint(cp);
  } catch {
    return ""; // > 0x10FFFF
  }
}

/** Decode residual HTML entities in a plain-text string (titles, bylines).
 * Also strips zero-width and bidi-control characters (spoofing vectors with
 * no place in a title) and collapses whitespace. */
export function decodeTextEntities(s: string): string {
  return (s || "")
    .replace(/&(?:#x([0-9a-f]+)|#(\d+)|([a-z]+));/gi, (m, hex, dec, name) => {
      if (hex || dec) return fromCodePointSafe(parseInt(hex || dec, hex ? 16 : 10));
      return NAMED_ENTITIES[(name as string).toLowerCase()] ?? m;
    })
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060\ufeff]/g, "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Strip a known trailing " — SiteName" suffix from a page <title>. Decodes
 * FIRST so an entity-encoded separator ("Post &mdash; LessWrong") cannot
 * smuggle the suffix past the strip. */
export function stripSiteSuffix(title: string): string {
  return decodeTextEntities(title).replace(SITE_SUFFIX_RE, "").trim();
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
