import type { AdapterContext, AdapterExtract, SiteAdapter } from "./types";
import { isVideoEmbedUrl, videoEmbedIframe } from "./util";

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

interface MediaEmbed {
  kind: "img" | "video";
  src: string;
  alt: string;
}

/**
 * Map each labelled <figure> to its media (an <img> or a YouTube/Vimeo
 * <iframe>), keyed by the normalized full label ("figure 5.2",
 * "interactive figure 5.1", "video 1.2") so a static "Figure 5.2" is never
 * confused with an "Interactive figure 5.2". The native `.md` export keeps only
 * the caption, so we re-inject the media from the HTML page. Figures with
 * neither (interactive widgets) are skipped.
 */
function mediaEmbeds(doc: Document): Map<string, MediaEmbed> {
  const map = new Map<string, MediaEmbed>();
  for (const fig of Array.from(doc.querySelectorAll("figure"))) {
    const cap = fig.querySelector("figcaption");
    const label = (cap?.querySelector("strong") || cap)?.textContent || "";
    const m = label.match(FIGURE_LABEL_RE);
    if (!m) continue;
    const key = norm(m[1]);
    if (map.has(key)) continue;

    const img = fig.querySelector("img");
    const imgSrc =
      img?.getAttribute("src") || img?.getAttribute("data-src") || "";
    if (imgSrc && !imgSrc.startsWith("data:")) {
      let src = imgSrc;
      try {
        src = new URL(imgSrc, ORIGIN).href;
      } catch {
        /* keep as-is */
      }
      map.set(key, { kind: "img", src, alt: m[1].trim() });
      continue;
    }

    const iframe = fig.querySelector("iframe");
    const ifSrc =
      iframe?.getAttribute("src") || iframe?.getAttribute("data-src") || "";
    if (isVideoEmbedUrl(ifSrc)) {
      map.set(key, { kind: "video", src: ifSrc, alt: m[1].trim() });
    }
  }
  return map;
}

/**
 * Move a space sitting just INSIDE a `**bold**` delimiter to the outside, so the
 * emphasis binds in CommonMark. The Atlas `.md` export uses bold lead-ins like
 * `**Are LLMs robust? **While …` (note the space before the closing `**`), which
 * otherwise render as literal asterisks. We RELOCATE the edge space rather than
 * strip it, so the word boundary is preserved (`**a** and **b**` stays intact,
 * `** **` is left alone).
 */
function tidyStrongEdges(md: string): string {
  return md.replace(/\*\*(?!\*)([^*][\s\S]*?)\*\*/g, (full: string, captured: string) => {
    let inner = captured;
    let lead = "";
    let trail = "";
    if (/^[ \t]/.test(inner)) {
      lead = " ";
      inner = inner.replace(/^[ \t]+/, "");
    }
    if (/[ \t]$/.test(inner)) {
      trail = " ";
      inner = inner.replace(/[ \t]+$/, "");
    }
    return inner === "" ? full : `${lead}**${inner}**${trail}`;
  });
}

/**
 * Clean the native `.md` export for import: drop the leading `# Title` (it lives
 * in the frontmatter) and the self-referential "[Read online](…)" link, and tidy
 * the source's space-inside-bold lead-ins. Keep everything else verbatim — it is
 * already publication-quality Markdown.
 */
function cleanAtlasMarkdown(raw: string): string {
  const cleaned = raw
    .replace(/^\uFEFF/, "")
    .replace(/^#\s+.*\r?\n+/, "")
    .replace(/^\[Read online\]\([^)]*\)\s*\r?\n+/m, "")
    .replace(/^\s*---\s*\r?\n+/, "") // leading divider left when there's no intro paragraph
    .trim();
  return tidyStrongEdges(cleaned);
}

/**
 * The `.md` export renders figures as italic caption lines with no image. Inject
 * the page's actual figure image (`![label](src)`) above each caption whose
 * label matches a figure that had an <img> in the HTML.
 */
// A real caption line in the .md export is "*Figure 5.2: …*" — the label is
// followed by a delimiter (colon or dash). Requiring it avoids injecting an
// image above an in-prose mention like "Figure 5.2 shows …".
const FIGURE_CAPTION_RE =
  /^((?:interactive\s+)?(?:figure|video|table)\s+\d+(?:\.\d+)?)\s*[:.\-–—]/i;

function injectMedia(md: string, media: Map<string, MediaEmbed>): string {
  if (media.size === 0) return md;
  const used = new Set<string>();
  return md
    .split("\n")
    .map((line) => {
      const text = line.replace(/^[*_\s]+/, ""); // strip leading italic/bold markers
      const m = text.match(FIGURE_CAPTION_RE);
      if (!m) return line;
      const key = norm(m[1]);
      if (used.has(key)) return line; // inject each item at most once
      const item = media.get(key);
      if (!item) return line;
      used.add(key);
      const embed =
        item.kind === "video"
          ? videoEmbedIframe(item.src)
          : `![${item.alt}](${item.src})`;
      return `${embed}\n\n${line}`;
    })
    .join("\n");
}

// "Acknowledgements" (British) / "Acknowledgments" (US), singular or plural.
const ACK_HEADING_RE = /^acknowledge?ments?$/;

/**
 * The native `.md` export drops the per-chapter "Acknowledgements" section, but
 * the HTML page carries it (an `<h3 id="acknowledgements">` inside the prose,
 * followed by the credit paragraph). Pull it out as Markdown so contributors keep
 * their attribution when we use the `.md` body. Returns "" when absent.
 *
 * Assumes the Atlas shape — a heading followed by plain-text `<p>` credit
 * paragraph(s); contributor *lists* or *links* would need turndown and are not
 * handled (no chapter uses them today). Emitted as `### Acknowledgements` to match
 * the source heading level and the HTML-fallback path, so both import paths
 * produce identical output.
 */
function acknowledgementsMarkdown(doc: Document): string {
  const heading = Array.from(doc.querySelectorAll("h2, h3, h4")).find(
    (el) =>
      (el.id || "").toLowerCase().startsWith("acknowledg") ||
      ACK_HEADING_RE.test(norm(el.textContent || "")),
  );
  if (!heading) return "";
  const paras: string[] = [];
  for (
    let el = heading.nextElementSibling;
    el && !/^H[1-6]$/.test(el.tagName);
    el = el.nextElementSibling
  ) {
    // Stop at the feedback widget — the `data-feedback-section` wrapper on live
    // pages, plus the same feedback selectors the adapter strips elsewhere.
    if (
      el.hasAttribute("data-feedback-section") ||
      el.matches("[id^='feedback'], [data-storage-key^='feedback']")
    )
      break;
    if (el.tagName === "P") {
      const text = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (text) paras.push(text);
    }
  }
  return paras.length ? `### Acknowledgements\n\n${paras.join("\n\n")}` : "";
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
    // Direct `.md` URL (no companion HTML available): use it as-is. NOTE: the
    // HTML-only Acknowledgements can't be recovered on this path (extract() is
    // synchronous and has no page to read); the normal entry is the HTML page
    // URL, which does preserve them. This bare-`.md` entry is rare.
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

    const media = mediaEmbeds(doc);
    const authors = atlasAuthors(ctx.html);
    // The `.md` export omits the Acknowledgements; re-append it from the HTML.
    // (The HTML-fallback body below already contains it inline.)
    const acknowledgements = acknowledgementsMarkdown(doc);
    const mdUrl = ctx.url.replace(/[#?].*$/, "").replace(/\/$/, "") + ".md";

    return {
      bodyMarkdownUrl: mdUrl,
      transformMarkdown: (raw) => {
        const body = injectMedia(cleanAtlasMarkdown(raw), media);
        return acknowledgements ? `${body}\n\n${acknowledgements}` : body;
      },
      bodyHtml: article.innerHTML,
      title: chapterTitle(doc),
      author: authors.length > 0 ? authors : [SITE_NAME],
      published: "",
      siteName: SITE_NAME,
    };
  },
};
