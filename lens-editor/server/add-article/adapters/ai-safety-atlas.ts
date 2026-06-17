import type { AdapterContext, AdapterExtract, SiteAdapter } from "./types";

const SITE_NAME = "AI Safety Atlas";
const ORIGIN = "https://ai-safety-atlas.com";

// Primary authors of the v1 textbook (used only for the direct-`.md` URL path,
// which has no byline). The normal HTML path reads the exact per-chapter
// credits — incl. extra contributors — from the page's metadata comment.
const ATLAS_AUTHORS = ["Markov Grey", "Charbel-Raphaël Segerie"];

/**
 * Atlas embeds a machine-readable metadata comment on every HTML page, e.g.
 *   <!-- … Authors: Markov Grey, Charbel-Raphaël Segerie  Version: v1 … -->
 * Parse the real author credits from it (the visible page has no byline).
 */
function atlasAuthors(html: string): string[] {
  const m = html.match(
    /Authors?:\s*([^\n<]+?)\s*(?:Version:|Machine-readable|License|-->)/i,
  );
  if (!m) return [];
  return m[1]
    .split(/\s*,\s*|\s+and\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** HTML chapter title: the first real <h1> (skip the empty notebox-title
 * template), falling back to og:title with the " - Chapter N" suffix removed. */
function chapterTitle(doc: Document): string {
  const h1 = Array.from(doc.querySelectorAll("h1")).find(
    (h) => h.id !== "notebox-title" && (h.textContent || "").trim().length > 0,
  );
  const fromH1 = (h1?.textContent || "").trim();
  if (fromH1) return fromH1;
  const og =
    doc.querySelector('meta[property="og:title"]')?.getAttribute("content") ||
    "";
  return og.replace(/\s*[-–—]\s*Chapter\s+\d+.*$/i, "").trim();
}

/** First `# Heading` of a Markdown document. */
function markdownTitle(md: string): string {
  return (md.match(/^#\s+(.+?)\s*$/m)?.[1] || "").trim();
}

const FIGURE_LABEL_RE =
  /^\s*((?:interactive\s+)?(?:figure|video|table)\s+\d+(?:\.\d+)?)/i;
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Map each labelled figure that has an <img> to its absolute image URL. Keyed
 * by the normalized full label ("figure 5.2", "interactive figure 5.1") so a
 * static "Figure 5.2" is never confused with an "Interactive figure 5.2".
 * Figures without an <img> (interactive widgets, video iframes) are skipped.
 */
function figureImages(doc: Document): Map<string, { src: string; alt: string }> {
  const map = new Map<string, { src: string; alt: string }>();
  for (const fig of Array.from(doc.querySelectorAll("figure"))) {
    const img = fig.querySelector("img");
    let src = img?.getAttribute("src") || img?.getAttribute("data-src") || "";
    if (!src || src.startsWith("data:")) continue;
    try {
      src = new URL(src, ORIGIN).href;
    } catch {
      /* keep as-is */
    }
    const cap = fig.querySelector("figcaption");
    const label = (cap?.querySelector("strong") || cap)?.textContent || "";
    const m = label.match(FIGURE_LABEL_RE);
    if (!m) continue;
    const key = norm(m[1]);
    if (!map.has(key)) map.set(key, { src, alt: m[1].trim() });
  }
  return map;
}

/**
 * Clean the native `.md` export for import: drop the leading `# Title` (it lives
 * in the frontmatter) and the self-referential "[Read online](…)" link. Keep
 * everything else verbatim — it is already publication-quality Markdown.
 */
function cleanAtlasMarkdown(raw: string): string {
  return raw
    .replace(/^\uFEFF/, "")
    .replace(/^#\s+.*\r?\n+/, "")
    .replace(/^\[Read online\]\([^)]*\)\s*\r?\n+/m, "")
    .replace(/^\s*---\s*\r?\n+/, "") // leading divider left when there's no intro paragraph
    .trim();
}

/**
 * The `.md` export renders figures as italic caption lines with no image. Inject
 * the page's actual figure image (`![label](src)`) above each caption whose
 * label matches a figure that had an <img> in the HTML.
 */
function injectFigures(
  md: string,
  figures: Map<string, { src: string; alt: string }>,
): string {
  if (figures.size === 0) return md;
  return md
    .split("\n")
    .map((line) => {
      const text = line.replace(/^[*_\s]+/, ""); // strip leading italic/bold markers
      const m = text.match(FIGURE_LABEL_RE);
      if (!m) return line;
      const fig = figures.get(norm(m[1]));
      if (!fig) return line;
      return `![${fig.alt}](${fig.src})\n\n${line}`;
    })
    .join("\n");
}

/**
 * AI Safety Atlas (ai-safety-atlas.com) — an Astro-rendered online textbook.
 * We use the page's native Markdown export for the body (cleaner than converting
 * HTML), but read the per-chapter authors and the figure images from the HTML
 * page and merge them in. So the normal path fetches the HTML page and the
 * `.md` export is fetched via `bodyMarkdownUrl`; if that fetch fails we fall
 * back to converting the HTML.
 */
export const aiSafetyAtlasAdapter: SiteAdapter = {
  id: "ai-safety-atlas",

  matches({ host, pathname }: AdapterContext): boolean {
    return host === "ai-safety-atlas.com" && pathname.includes("/chapters/");
  },

  extract(doc: Document, ctx: AdapterContext): AdapterExtract | null {
    // Direct `.md` URL (no companion HTML available): use it as-is.
    if (ctx.pathname.endsWith(".md")) {
      const body = cleanAtlasMarkdown(ctx.html);
      if (!body) return null;
      return {
        bodyMarkdown: body,
        title: markdownTitle(ctx.html),
        author: ATLAS_AUTHORS,
        published: "",
        siteName: SITE_NAME,
      };
    }

    // HTML page: prefer the native `.md` body, enriched with the page's figures
    // and authors. The HTML body is the fallback if the `.md` fetch fails.
    const article =
      doc.querySelector("main#reader-content article.prose") ||
      doc.querySelector("article.prose");
    if (!article) return null;
    article
      .querySelectorAll("nav, [id^='feedback'], [data-storage-key^='feedback']")
      .forEach((e) => e.remove());

    const figures = figureImages(doc);
    const authors = atlasAuthors(ctx.html);
    const mdUrl = ctx.url.replace(/[#?].*$/, "").replace(/\/$/, "") + ".md";

    return {
      bodyMarkdownUrl: mdUrl,
      transformMarkdown: (raw) => injectFigures(cleanAtlasMarkdown(raw), figures),
      bodyHtml: article.innerHTML,
      title: chapterTitle(doc),
      author: authors.length > 0 ? authors : [SITE_NAME],
      published: "",
      siteName: SITE_NAME,
    };
  },
};
