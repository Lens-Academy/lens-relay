/** Mirror the Atlas adapter's bodyMarkdownUrl derivation (keep in sync). */
export function atlasMarkdownUrl(pageUrl: string): string {
  return pageUrl.replace(/[#?].*$/, "").replace(/\/$/, "") + ".md";
}
