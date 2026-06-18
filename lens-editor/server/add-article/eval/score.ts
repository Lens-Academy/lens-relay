import { jaccard } from "../confidence";

/** Canonicalize render-equivalent markdown DIALECT (not content) before scoring:
 *  - curly quotes/apostrophes `“ ” ‘ ’` folded to straight `" '` (typographic,
 *    render-equivalent; dashes/ellipsis are intentionally left raw for now).
 *  - line-leading list bullet `* ` and `- ` (with any run of spaces after the
 *    marker) treated as equivalent. Scoped to the LEADING marker only — inline
 *    `*` (emphasis/bold) and `-` (hyphens, `--` dashes) are left untouched, so
 *    `*` and `-` are NOT generally equated. */
function canonicalize(md: string): string {
  return md
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .split("\n")
    .map((l) => l.replace(/^(\s*)[-*][ \t]+/, "$1- "))
    .join("\n");
}

function shingles(md: string): Set<string> {
  // Trim for line tokenization; canonicalize folds render-equivalent dialect.
  return new Set(
    canonicalize(md).split("\n").map((l) => l.trim()).filter((l) => l.length >= 12),
  );
}

export function scoreBody(output: string, gold: string): { recall: number; precision: number; jaccard: number } {
  const o = shingles(output), g = shingles(gold);
  const inBoth = (a: Set<string>, b: Set<string>) => [...a].filter((x) => b.has(x)).length;
  const recall = g.size ? inBoth(g, o) / g.size : 1;
  const precision = o.size ? inBoth(o, g) / o.size : 1;
  return { recall, precision, jaccard: jaccard(canonicalize(output), canonicalize(gold)) };
}

export function structureCounts(md: string) {
  const count = (re: RegExp) => (md.match(re) || []).length;
  return {
    headings: count(/^#{1,6}\s/gm),
    footnoteRefs: count(/\[\^[^\]]+\](?!:)/g),
    footnoteDefs: count(/^\[\^[^\]]+\]:/gm),
    tables: count(/^\|.+\|$/gm),
    code: count(/^```/gm) / 2 | 0,
    math: count(/\$\$[^$]+\$\$/g) + count(/(?<!\$)\$(?!\$)[^$\n]+\$/g),
    images: count(/!\[[^\]]*\]\([^)]*\)/g),
    links: count(/(?<!!)\[[^\]]*\]\([^)]*\)/g),
  };
}
