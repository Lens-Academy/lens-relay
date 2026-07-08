/**
 * URL normalization for duplicate detection. The same article arrives under
 * many spellings — tracking parameters, trailing slashes, http vs https, a
 * mirror host — and exact string comparison treats each as a new article.
 * `normalizeUrlForDedup` folds those spellings onto one key. It is used ONLY
 * for comparison (queue double-submit checks and relay source_url lookups);
 * the stored source_url is the page's canonical URL, not this key.
 */

// Query parameters that identify a marketing campaign, not a document.
const TRACKING_PARAM_RE =
  /^(utm_\w+|fbclid|gclid|dclid|msclkid|twclid|igshid|mc_cid|mc_eid|mkt_tok|ref|ref_src|cmpid|s_kwcid)$/i;

/** Mirror host → canonical host. GreaterWrong serves LessWrong at the apex/www
 *  host and the EA Forum at `ea.` (paths are identical on both sides). */
function canonicalHost(host: string): string {
  if (host === "greaterwrong.com") return "lesswrong.com";
  if (host === "ea.greaterwrong.com") return "forum.effectivealtruism.org";
  if (host.endsWith(".greaterwrong.com")) return "lesswrong.com";
  return host;
}

export function normalizeUrlForDedup(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return raw.trim();
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return raw.trim();

  u.protocol = "https:"; // http/https variants are the same document
  u.hash = "";
  u.port = "";
  u.username = "";
  u.password = "";
  u.hostname = canonicalHost(u.hostname.toLowerCase().replace(/^www\./, ""));

  const kept = [...u.searchParams.entries()].filter(
    ([k]) => !TRACKING_PARAM_RE.test(k),
  );
  u.search = "";
  for (const [k, v] of kept) u.searchParams.append(k, v);

  if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, "");
  return u.href;
}

/**
 * The distinct spellings of an article's identity worth checking against the
 * relay's stored source_urls: each given URL plus its normalized form,
 * de-duplicated, falsy inputs dropped. Existing documents were stored with
 * whatever exact URL was current at import time, so both forms matter.
 */
export function dedupUrlVariants(
  ...urls: Array<string | undefined | null>
): string[] {
  const out = new Set<string>();
  for (const u of urls) {
    if (!u) continue;
    out.add(u);
    out.add(normalizeUrlForDedup(u));
  }
  // Also toggle the "www." spelling of every http(s) variant. The relay
  // compares against the STORED source_url spelling (it only trims trailing
  // slashes), and stored values commonly carry "www." (e.g. LessWrong
  // canonicals) — without this, a GreaterWrong-mirror submit would miss the
  // stored "https://www.lesswrong.com/…" and import a duplicate.
  for (const u of [...out]) {
    try {
      const p = new URL(u);
      if (p.protocol !== "http:" && p.protocol !== "https:") continue;
      if (p.hostname.startsWith("www.")) {
        p.hostname = p.hostname.slice(4);
      } else if (p.hostname.includes(".") && !/^[\d[]/.test(p.hostname)) {
        p.hostname = `www.${p.hostname}`;
      } else {
        continue;
      }
      out.add(p.href);
    } catch {
      /* non-URL variant — skip */
    }
  }
  return [...out];
}
