import { jaccard } from "../confidence";

function shingles(md: string): Set<string> {
  // Trim only for line tokenization; no content is masked (raw compare).
  return new Set(
    md.split("\n").map((l) => l.trim()).filter((l) => l.length > 0),
  );
}

export function scoreBody(output: string, gold: string): { recall: number; precision: number; jaccard: number } {
  const o = shingles(output), g = shingles(gold);
  const inBoth = (a: Set<string>, b: Set<string>) => [...a].filter((x) => b.has(x)).length;
  const recall = g.size ? inBoth(g, o) / g.size : 1;
  const precision = o.size ? inBoth(o, g) / o.size : 1;
  return { recall, precision, jaccard: jaccard(output, gold) };
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
