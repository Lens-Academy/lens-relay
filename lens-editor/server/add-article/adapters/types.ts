/**
 * Site-specific extraction adapters.
 *
 * An adapter knows how to isolate the real article on ONE site (or family of
 * sites) far more reliably than the generic Defuddle/Readability path. The
 * pipeline tries adapters first (see `findAdapter`) and only falls back to the
 * generic extractors when no adapter matches or an adapter mis-fires.
 *
 * Adding support for a new site is therefore just: write a `SiteAdapter`, drop
 * it in this directory, and register it in `index.ts`. Adapters never do the
 * HTML→Markdown conversion themselves — they return the cleaned body element's
 * innerHTML plus metadata, and the shared converter in `extract.ts` turns it
 * into Markdown. This keeps conversion (lists, math, footnotes, tables)
 * deterministic and identical across every site.
 */

/** Lightweight, pre-computed context handed to every adapter. */
export interface AdapterContext {
  /** The original, full request URL. */
  url: string;
  /** Lowercased hostname with a leading "www." stripped ("" if URL was invalid). */
  host: string;
  /** URL pathname ("/" if unknown). */
  pathname: string;
  /** Raw HTML of the fetched page (for cheap structural sniffing in `matches`). */
  html: string;
}

/** What an adapter returns once it has isolated the article in a parsed DOM. */
export interface AdapterExtract {
  /** innerHTML of the cleaned article body — converted by the shared turndown.
   *  Provide this OR `bodyMarkdown`. */
  bodyHtml?: string;
  /** Article body already in Markdown (e.g. fetched from a site's native `.md`
   *  export) — used as-is, bypassing the HTML→Markdown converter. Takes
   *  precedence over `bodyHtml` when both are present. */
  bodyMarkdown?: string;
  /** URL whose raw text is the Markdown body. The pipeline fetches it and runs
   *  `transformMarkdown` (if given); on failure it falls back to `bodyHtml`.
   *  Lets an adapter use a site's native `.md` export for the body while still
   *  reading metadata (authors, figures) from the HTML page. */
  bodyMarkdownUrl?: string;
  /** Post-process the text fetched from `bodyMarkdownUrl` (clean it, inject
   *  figures, …). Receives the raw markdown, returns the final body. */
  transformMarkdown?: (raw: string) => string;
  /** Article title (site-name suffix already removed). */
  title: string;
  /** Author(s) in natural "First Last" order; [] lets the pipeline fall back. */
  author: string[];
  /** Publication date as YYYY-MM-DD, or "" when the page carries none. */
  published: string;
  /** Human-readable publication name (e.g. "AI Safety Atlas"); optional. */
  siteName?: string;
}

export interface SiteAdapter {
  /**
   * Stable identifier, also recorded as the extraction's `via` value. Keep
   * existing ids ("forum-adapter", "wikipedia") stable — tests assert on them.
   */
  id: string;
  /** Cheap predicate: does this adapter handle the page? (host + light sniff). */
  matches(ctx: AdapterContext): boolean;
  /**
   * Optional: return ordered alternative URLs to FETCH instead of the original
   * (e.g. an arXiv abstract page → ar5iv full-text HTML). The pipeline tries
   * them in order and falls back to the original URL when all fail. The stored
   * article `source_url` stays the original. Pure & synchronous — no network.
   */
  resolveFetchUrls?(ctx: AdapterContext): string[];
  /**
   * Isolate and clean the article inside `doc`. The `doc` is a throwaway JSDOM
   * document, so adapters may mutate it freely (e.g. remove chrome nodes).
   * Return `null` to defer to the generic extractors.
   */
  extract(doc: Document, ctx: AdapterContext): AdapterExtract | null;
}
