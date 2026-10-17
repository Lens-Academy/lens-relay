import type { AdapterContext, SiteAdapter } from "./types";
import { forumMagnumAdapter } from "./forum-magnum";
import { wikipediaAdapter } from "./wikipedia";
import { aiSafetyAtlasAdapter } from "./ai-safety-atlas";
import { arxivAdapter } from "./arxiv";

import type { ConvertedSource, FetchedResponse } from "./types";

export type { AdapterContext, AdapterExtract, ConvertedSource, FetchedResponse, SiteAdapter } from "./types";

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

/** The Accept header the adapter wants a candidate fetched with, if not the default. */
export function fetchAcceptFor(ctx: AdapterContext, candidateUrl: string): string | undefined {
  return findAdapter(ctx)?.fetchAccept?.(candidateUrl, ctx);
}

/** Whether the adapter for `ctx` accepts the page a candidate fetch landed on. */
export function acceptsFetchedUrl(ctx: AdapterContext, finalUrl: string): boolean {
  return findAdapter(ctx)?.acceptsFetchedUrl?.(finalUrl, ctx) ?? true;
}

/** Whether the adapter for `ctx` accepts the HTML a candidate fetch returned. */
export function acceptsFetchedHtml(ctx: AdapterContext, html: string): boolean {
  return findAdapter(ctx)?.acceptsFetchedHtml?.(html, ctx) ?? true;
}

/** The adapter's structured-source conversion of a candidate's response, or
 *  null when it has none (the response is used as fetched). */
export async function convertFetched(
  ctx: AdapterContext,
  response: FetchedResponse,
  signal?: AbortSignal,
): Promise<ConvertedSource | null> {
  return (await findAdapter(ctx)?.convertFetched?.(response, ctx, signal)) ?? null;
}
