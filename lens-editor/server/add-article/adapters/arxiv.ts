import type { AdapterContext, AdapterExtract, SiteAdapter } from "./types";
import { cleanAuthorName } from "./util";

/**
 * arXiv. The page a user links (arxiv.org/abs/<id> or a PDF) is only the
 * abstract landing page — not the paper — so the generic pipeline can only ever
 * recover the abstract. This adapter instead fetches the full-text HTML:
 *   1. arxiv.org/html/<id>  — arXiv's native HTML (papers from ~Dec 2023 on)
 *   2. ar5iv.labs.arxiv.org/html/<id> — LaTeXML conversion covering older papers
 * and parses the LaTeXML markup (.ltx_*). Math is recovered from each
 * <math alttext="…"> by the shared converter.
 *
 * The stored source_url stays the canonical arxiv.org URL the curator linked.
 */

/** Parse the arXiv identifier out of a URL path. */
function arxivId(pathname: string): string | null {
  // /abs/2305.12345v2 · /pdf/2305.12345.pdf · /html/2305.12345 · /abs/cs/0702103
  const m =
    pathname.match(/\/(?:abs|pdf|html|format)\/(.+?)(?:\.pdf)?\/?$/i) ||
    pathname.match(/^\/(\d{4}\.\d{4,5}(?:v\d+)?)\/?$/);
  if (!m) return null;
  return m[1].replace(/v\d+$/i, ""); // canonical (latest) version
}

/**
 * Canonical abstract-page URL for any arXiv-family URL (abs/pdf/html/ar5iv),
 * "" when the URL isn't arXiv or carries no id. The abstract page's
 * citation_author / citation_date meta tags are the AUTHORITATIVE metadata —
 * LaTeXML author markup is too variable to parse reliably (missing leading
 * authors, "footnotemark:" fragments, affiliations-as-names all observed).
 */
export function arxivAbsUrl(url: string): string {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "").toLowerCase();
    if (
      host !== "arxiv.org" &&
      host !== "ar5iv.org" &&
      host !== "ar5iv.labs.arxiv.org"
    ) {
      return "";
    }
    const id = arxivId(u.pathname);
    return id ? `https://arxiv.org/abs/${id}` : "";
  } catch {
    return "";
  }
}

/** Approximate publish date from a modern arXiv id (YYMM.NNNNN → 20YY-MM-01). */
function publishedFromId(id: string): string {
  const m = id.match(/^(\d{2})(\d{2})\.\d{4,5}/);
  if (!m) return "";
  const month = parseInt(m[2], 10);
  if (month < 1 || month > 12) return "";
  return `20${m[1]}-${m[2]}-01`;
}

/**
 * Author name(s) from a `.ltx_personname`. LaTeXML puts the name first, with
 * the affiliation/email following (after a <br>, or as later text). Two cases:
 *   - the name is wrapped in a bold span → use that (older papers, where the
 *     affiliation is a sibling text node, not after a top-level <br>);
 *   - otherwise take the text before the first <br>.
 * A single personname node can hold SEVERAL authors: LaTeX `\and`/`\quad`
 * renders them separated only by wide space runs (e.g. "Ryan Greenblatt∗
 * Buck Shlegeris      Kshitij Sachan"), so split on multi-space gaps, commas,
 * and "and" — and drop footnote-marker superscripts glued onto names.
 */
function personNames(el: Element): string[] {
  // Footnote/affiliation markers (∗, †, digits) live in <sup> — remove before
  // reading text so they don't fuse with the preceding name.
  for (const sup of Array.from(el.querySelectorAll("sup"))) sup.remove();

  let raw = "";
  const bold = el.querySelector(".ltx_font_bold, b, strong");
  if (bold && (bold.textContent || "").trim()) {
    raw = bold.textContent || "";
  } else {
    const parts: string[] = [];
    for (const node of Array.from(el.childNodes)) {
      if (node.nodeName === "BR") break;
      parts.push(node.textContent || "");
    }
    raw = parts.join(" ");
  }

  return raw
    .split(/\s{2,}|\n|,|\band\b|&/)
    .map((s) => cleanAuthorName(s.replace(/[∗†‡§¶*]/g, "")))
    .filter(Boolean);
}

export const arxivAdapter: SiteAdapter = {
  id: "arxiv",

  matches({ host }: AdapterContext): boolean {
    return (
      host === "arxiv.org" ||
      host === "ar5iv.org" ||
      host === "ar5iv.labs.arxiv.org"
    );
  },

  resolveFetchUrls(ctx: AdapterContext): string[] {
    // Only redirect from the canonical arxiv.org site; if we already have an
    // ar5iv URL, fetch it directly.
    if (ctx.host !== "arxiv.org") return [];
    const id = arxivId(ctx.pathname);
    if (!id) return [];
    return [
      `https://arxiv.org/html/${id}`,
      `https://ar5iv.labs.arxiv.org/html/${id}`,
    ];
  },

  extract(doc: Document, ctx: AdapterContext): AdapterExtract | null {
    const article =
      doc.querySelector("article") ||
      doc.querySelector(".ltx_page_content") ||
      doc.querySelector(".ltx_document");
    if (!article) return null;

    // Capture title + authors BEFORE stripping their elements from the body.
    const title = (
      article.querySelector(".ltx_title_document")?.textContent || ""
    )
      .replace(/\s+/g, " ")
      .trim();
    const authors = Array.from(article.querySelectorAll(".ltx_personname"))
      .flatMap(personNames)
      .filter(Boolean);

    // The title and author block are now in metadata; drop them (and the ar5iv
    // chrome) from the body so they aren't duplicated as prose.
    // .ltx_ERROR = LaTeXML undefined-command nodes (e.g. custom \newclass macro
    // preambles) that render as raw "\command" garbage — drop them.
    article
      .querySelectorAll(
        ".ltx_title_document, .ltx_authors, .ltx_page_logo, .ltx_dates, .ltx_ERROR, .ar5iv-footer, nav, footer",
      )
      .forEach((e) => e.remove());

    const id = arxivId(ctx.pathname) || "";
    return {
      bodyHtml: article.innerHTML,
      title,
      author: Array.from(new Set(authors)),
      published: publishedFromId(id),
      siteName: "arXiv",
    };
  },
};
