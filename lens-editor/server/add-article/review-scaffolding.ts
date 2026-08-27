/** Keep the standard single blank line between frontmatter and an authoring comment. */
export function normalizeReviewScaffolding(markdown: string): string {
  const opening = markdown.match(/^---(\r?\n)/);
  if (!opening) return markdown;
  const eol = opening[1];
  const closing = new RegExp(`^---[ \\t]*(?=\\r?$)`, "gm");
  closing.lastIndex = opening[0].length;
  const match = closing.exec(markdown);
  if (!match) return markdown;
  const suffixStart = match.index + match[0].length;
  const suffix = markdown.slice(suffixStart);
  const excess = suffix.match(/^(?:\r?\n){3,}(?=%%(?:\r?\n|$))/);
  if (!excess) return markdown;
  return `${markdown.slice(0, suffixStart)}${eol}${eol}${suffix.slice(excess[0].length)}`;
}
