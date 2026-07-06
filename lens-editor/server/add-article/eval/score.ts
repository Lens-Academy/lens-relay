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

/** Leading YAML frontmatter (the importer's metadata block) never matches the
 *  source and must be excluded from all body comparisons. */
export function stripFrontmatter(md: string): string {
  return md.replace(/^---\n[\s\S]*?\n---\n*/, "");
}

/** Aggressive render-equivalence normalization for the x/10 scorer. Folds
 *  everything a human reader would call "the same text": quote/dash/ellipsis
 *  glyphs, markdown escapes, list-marker dialect AND spacing (`1.  item` ==
 *  `1. item` — a real false-positive source), whitespace runs. */
export function normalizeForScore(md: string): string {
  return stripFrontmatter(md)
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/…/g, "...")
    .replace(/[—–]/g, "-")
    .replace(/\\([\\`*_{}[\]()#+.!>-])/g, "$1") // markdown escapes
    .split("\n")
    .map((l) =>
      l
        .replace(/^(\s*)[-*+][ \t]+/, "$1- ") // bullet dialect + spacing
        .replace(/^(\s*)(\d+)[.)][ \t]+/, "$1$2. ") // numbered-list spacing
        .replace(/[ \t]+/g, " ")
        .trimEnd(),
    )
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const words = (s: string) =>
  (s.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []) as string[];

/** Order-aware word 5-gram shingles — immune to line-wrapping and spacing
 *  differences that broke the old line-exact comparison. */
function wordShingles(s: string): Set<string> {
  const w = words(s);
  if (w.length < 5) return new Set(w.length ? [w.join(" ")] : []);
  const out = new Set<string>();
  for (let i = 0; i <= w.length - 5; i++) out.add(w.slice(i, i + 5).join(" "));
  return out;
}

export interface ArticleScore {
  /** 0–10, one decimal — the headline number. */
  score10: number;
  /** Word-shingle F1 (content overlap, order-aware). */
  content: number;
  /** Structural-feature agreement (headings/footnotes/tables/math/images/links). */
  structure: number;
  /** Beginning+end anchors present (truncation / missing-intro detector). */
  completeness: number;
  /** Length ratio (bloat / heavy loss detector). */
  sizeRatio: number;
  recall: number;
  precision: number;
}

/**
 * Article-agnostic 0–10 correctness score of `output` against a gold copy.
 * Dialect-blind (see normalizeForScore), content-strict: real missing/extra
 * text, broken structure, and truncation move the number; an extra space
 * before every list item does not.
 */
/** Inline-formatting + list-shape features, beyond block structureCounts —
 *  so lost bold/italic, flattened lists, and dropped blockquotes cost points
 *  even when the raw words survived. */
export function inlineStructureCounts(md: string) {
  const lines = md.split("\n");
  return {
    bold: (md.match(/\*\*[^*\n]+\*\*|__[^_\n]+__/g) || []).length,
    italic: (md.match(/(^|[^*])\*[^*\s][^*\n]*\*(?!\*)|(^|[^_])_[^_\s][^_\n]*_(?!_)/g) || []).length,
    bullets: lines.filter((l) => /^\s*[-*+] /.test(l)).length,
    numbered: lines.filter((l) => /^\s*\d+[.)] /.test(l)).length,
    nestedItems: lines.filter((l) => /^\s{2,}([-*+]|\d+[.)]) /.test(l)).length,
    blockquotes: lines.filter((l) => /^\s*>/.test(l)).length,
    links: (md.match(/\]\(/g) || []).length,
  };
}

export function scoreArticle(output: string, gold: string): ArticleScore {
  const o = normalizeForScore(output);
  const g = normalizeForScore(gold);
  const so = wordShingles(o);
  // Gold shingles kept IN ORDER so we can find the largest contiguous gap.
  const gw = words(g);
  const goldSeq: string[] = [];
  if (gw.length < 5) {
    if (gw.length) goldSeq.push(gw.join(" "));
  } else {
    for (let i = 0; i <= gw.length - 5; i++) goldSeq.push(gw.slice(i, i + 5).join(" "));
  }
  const sg = new Set(goldSeq);
  const inter = [...sg].filter((x) => so.has(x)).length;
  const recall = sg.size ? inter / sg.size : 1;
  const precision = so.size ? [...so].filter((x) => sg.has(x)).length / so.size : 1;
  // F2, not F1: missing gold text (recall) must cost ~4x more than extra text
  // (precision) — a librarian tolerates junk to trim far more than lost prose.
  const content =
    4 * precision + recall ? (5 * precision * recall) / (4 * precision + recall) : 0;

  const co = { ...structureCounts(o), ...inlineStructureCounts(o) };
  const cg = { ...structureCounts(g), ...inlineStructureCounts(g) };
  const keys = Object.keys(cg) as (keyof typeof cg)[];
  const structure =
    keys.reduce((a, k) => {
      const x = co[k];
      const y = cg[k];
      return a + (x === 0 && y === 0 ? 1 : Math.min(x, y) / Math.max(x, y));
    }, 0) / keys.length;

  // Completeness = anchors (beginning/end present) AND no large contiguous
  // hole anywhere: the longest consecutive run of missing gold shingles, as a
  // fraction of the article. A dropped middle section can't hide behind
  // intact endpoints.
  const anchor = (ws: string[]) => {
    if (ws.length === 0) return 1;
    const sh = wordShingles(ws.join(" "));
    if (sh.size === 0) return 1;
    return [...sh].filter((x) => so.has(x)).length / sh.size;
  };
  let largestGap = 0;
  let run = 0;
  for (const s of goldSeq) {
    run = so.has(s) ? 0 : run + 1;
    if (run > largestGap) largestGap = run;
  }
  const gapFrac = goldSeq.length ? largestGap / goldSeq.length : 0;
  const completeness = Math.min(
    (anchor(gw.slice(0, 40)) + anchor(gw.slice(-40))) / 2,
    1 - gapFrac,
  );

  const ow = words(o).length;
  const sizeRatio = ow && gw.length ? Math.min(ow, gw.length) / Math.max(ow, gw.length) : 0;

  const score10 =
    Math.round(
      (0.55 * content + 0.2 * structure + 0.15 * completeness + 0.1 * sizeRatio) * 100,
    ) / 10;
  return { score10, content, structure, completeness, sizeRatio, recall, precision };
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
