import type { AdapterContext, SiteAdapter } from "./types";
import { forumMagnumAdapter } from "./forum-magnum";
import { wikipediaAdapter } from "./wikipedia";
import { aiSafetyAtlasAdapter } from "./ai-safety-atlas";
import { arxivAdapter } from "./arxiv";

export type { AdapterContext, AdapterExtract, SiteAdapter } from "./types";

/**
 * Registered site adapters, tried in order. To support a new site, add its
 * `SiteAdapter` to this list. Order matters only when two adapters could match
 * the same page — keep specific adapters before broad ones. (`matches` is a
 * cheap predicate; the expensive DOM work happens in `extract`.)
 */
export const ADAPTERS: SiteAdapter[] = [
  forumMagnumAdapter,
  wikipediaAdapter,
  aiSafetyAtlasAdapter,
  arxivAdapter,
];

/** Build the cheap context every adapter's `matches`/`extract` receives. */
export function adapterContext(url: string, html: string): AdapterContext {
  let host = "";
  let pathname = "/";
  try {
    const u = new URL(url);
    host = u.hostname.replace(/^www\./, "").toLowerCase();
    pathname = u.pathname || "/";
  } catch {
    /* leave defaults */
  }
  return { url, host, pathname, html };
}

/** First adapter whose `matches` returns true for this page, or null. */
export function findAdapter(ctx: AdapterContext): SiteAdapter | null {
  return ADAPTERS.find((a) => a.matches(ctx)) ?? null;
}

/**
 * Ordered list of URLs to fetch for this page. Normally just the original URL,
 * but an adapter may redirect to a better source (e.g. arXiv abstract → ar5iv
 * full text). The caller tries them in order and keeps the original as
 * source_url.
 */
export function resolveFetchUrls(ctx: AdapterContext): string[] {
  const alt = findAdapter(ctx)?.resolveFetchUrls?.(ctx);
  return alt && alt.length > 0 ? alt : [ctx.url];
}
