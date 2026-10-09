import type { AdapterContext, AdapterExtract, SiteAdapter } from "./types";
import { cleanAuthorName, markLiteralDollars } from "./util";
import { ARXIV_LATEX_MARKER, arxivSourceToHtml } from "../arxiv-latex";

/**
 * arXiv. The page a user links (arxiv.org/abs/<id> or a PDF) is only the
 * abstract landing page — not the paper — so the generic pipeline can only ever
 * recover the abstract. This adapter instead fetches the full text, best first:
 *   1. arxiv.org/e-print/<id> — the authors' LaTeX, converted by pandoc
 *      (../arxiv-latex.ts). The paper itself, so nothing is cut off.
 *   2. arxiv.org/html/<id>  — arXiv's native HTML (papers from ~Dec 2023 on)
 *   3. ar5iv.labs.arxiv.org/html/<id> — LaTeXML conversion covering older papers
 *   4. arxiv.org/pdf/<id> — through the pipeline's PDF path
 * and parses the pandoc or LaTeXML markup (.ltx_*). Math is recovered from
 * each <math alttext="…"> by the shared converter.
 *
 * The stored source_url stays the canonical arxiv.org URL the curator linked.
 */

/** Parse the arXiv identifier out of a URL path. */
function arxivId(pathname: string): string | null {
  // /abs/2305.12345v2 · /pdf/2305.12345.pdf · /html/2305.12345 · /abs/cs/0702103
  const m =
    pathname.match(/\/(?:abs|pdf|html|format|e-print|src)\/(.+?)(?:\.pdf)?\/?$/i) ||
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

/**
 * LaTeXML (arxiv.org/html and ar5iv) answers 200 even when its conversion
 * died: it serves whatever it produced before the crash, from nothing at all
 * to most of the paper, and appends this banner. Such a page is never the
 * whole paper, so the next candidate (the PDF) must be used instead.
 */
const LATEXML_FATAL_RE = /Conversion to HTML had a Fatal error and exited abruptly/i;
/** ar5iv's page for a paper it never converted: 200, and only this text. */
const AR5IV_EMPTY_RE = /<div class="ltx_page_main">\s*No content available\s*</i;

export function isFailedLatexmlConversion(html: string): boolean {
  return LATEXML_FATAL_RE.test(html) || AR5IV_EMPTY_RE.test(html);
}

const EPRINT_URL_RE = /^https?:\/\/(?:www\.|export\.)?arxiv\.org\/(?:e-print|src)\//i;

/** Rewrite every `\\name{arg}` (balanced braces) in `tex` with `fn(arg)`. */
function replaceCommand(tex: string, name: string, fn: (arg: string) => string): string {
  const re = new RegExp(`\\\\${name}(?![A-Za-z])\\s*\\{`, "g");
  let out = "";
  let last = 0;
  for (let m = re.exec(tex); m; m = re.exec(tex)) {
    const open = m.index + m[0].length - 1;
    let depth = 0;
    let close = open;
    for (; close < tex.length; close += 1) {
      if (tex[close] === "\\") close += 1;
      else if (tex[close] === "{") depth += 1;
      else if (tex[close] === "}" && --depth === 0) break;
    }
    if (close >= tex.length) break;
    out += tex.slice(last, m.index) + fn(tex.slice(open + 1, close));
    last = close + 1;
    re.lastIndex = close + 1;
  }
  return out + tex.slice(last);
}

/** TeX pandoc leaves in math that KaTeX cannot render (or must not see). */
export function cleanLatexMath(tex: string): string {
  tex = replaceCommand(tex, "textsuperscript", (arg) => `^{\\text{${arg}}}`);
  tex = replaceCommand(tex, "textsubscript", (arg) => `_{\\text{${arg}}}`);
  return (
    tex
      .replace(/\\label\s*\{[^{}]*\}/g, "")
      // Layout and numbering commands with no meaning in a rendered formula.
      .replace(/\\(?:nonumber|notag|qedhere|displaybreak|upshape|hfill|hfil|thetheorem|ensuremath)(?![A-Za-z])\s*/g, "")
      // A discretionary hyphen (`\-`) means nothing in math, and KaTeX rejects it.
      .replace(/\\-/g, "")
      // `\$` inside math: Lens finds math spans before TeX escapes, so the
      // escaped dollar would close the span. \textdollar is the same glyph.
      .replace(/\\\$/g, "\\text{\\textdollar}")
      // TeX quotes typed in math: backticks would open inline code in Markdown.
      .replace(/``/g, "\\text{“}")
      .replace(/`/g, "\\text{‘}")
      .replace(/(?<!\\)"/g, "\\text{”}")
      .replace(/\\(?:short)?intertext\s*\{/g, "\\text{")
      .replace(/\\parbox\s*(?:\[[^\]]*\])?\s*\{[^{}]*\}\s*\{/g, "\\text{")
      .replace(/\\textcent(?![A-Za-z])/g, "\\text{¢}")
      .replace(/\\textsc\s*\{/g, "\\text{")
      .replace(/\\mbox\s*\{/g, "\\text{")
      // Math nested in \text{…$x$…}: KaTeX takes \(…\) there too, and a bare `$`
      // would end the Markdown math span early.
      .replace(/(?<!\\)\$([^$]*?)(?<!\\)\$/g, "\\($1\\)")
      // A blank line would end the Markdown block the formula sits in.
      .replace(/\n\s*\n+/g, "\n")
      .trim()
  );
}

/** The pandoc conversion of the e-print (see ../arxiv-latex.ts). */
function extractPandoc(doc: Document): AdapterExtract | null {
  const body = doc.body;
  if (!body) return null;
  const header = body.querySelector("#title-block-header");
  const title = (header?.querySelector(".title")?.textContent || "").replace(/\s+/g, " ").trim();
  // One .author per author (\and, \And); the name is its first line, the
  // lines after it are affiliation and address. Thanks markers are dropped.
  const authors = Array.from(header?.querySelectorAll(".author") ?? [])
    .map((el) => {
      el.querySelectorAll("sup, a.footnote-ref").forEach((e) => e.remove());
      return (el.innerHTML.split(/<br\s*\/?>/i)[0] || "").replace(/<[^>]*>/g, "");
    })
    .flatMap((name) => name.split(/,|\band\b/))
    .map((name) => cleanAuthorName(name.replace(/&amp;/g, "&").replace(/\s+/g, " ")))
    .filter(Boolean);
  // The abstract sits in the title block; keep it, drop the rest of the block.
  const abstract = header?.querySelector(".abstract");
  if (header) {
    if (abstract) {
      abstract.querySelector(".abstract-title")?.remove();
      const heading = doc.createElement("h2");
      heading.textContent = "Abstract";
      header.replaceWith(heading, ...Array.from(abstract.childNodes));
    } else header.remove();
  }
  // The rule pandoc draws above the endnotes would be left dangling at the end.
  body.querySelectorAll("script, style, nav, .footnotes > hr").forEach((e) => e.remove());
  // A table caption inside <table> runs into the first row in Markdown and
  // swallows the pipe table; give it its own paragraph above the table.
  body.querySelectorAll("table > caption").forEach((caption) => {
    const p = doc.createElement("p");
    p.innerHTML = caption.innerHTML;
    caption.closest("table")!.before(p);
    caption.remove();
  });
  // pandoc --mathjax writes math as \(…\) / \[…\] text in span.math.
  body.querySelectorAll("span.math").forEach((span) => {
    const display = span.classList.contains("display");
    const raw = (span.textContent || "").trim();
    const tex = cleanLatexMath(raw.replace(/^\\[([]/, "").replace(/\\[)\]]$/, ""));
    if (!tex) {
      span.remove();
      return;
    }
    const math = doc.createElement("math");
    math.setAttribute("alttext", tex);
    // Text content too: turndown replaces a childless element as blank before
    // any rule sees it.
    math.textContent = tex;
    if (display) math.setAttribute("display", "block");
    span.replaceWith(math);
  });
  // Adjacent inline formulas would print as `$a$$b$`, which reads as a display
  // opener; TeX ignores the space, so one formula is the same mathematics.
  body.querySelectorAll("math:not([display])").forEach((math) => {
    const next = math.nextSibling as Element | null;
    if (!math.isConnected || next?.nodeName.toLowerCase() !== "math" || next.hasAttribute("display")) return;
    let tex = math.getAttribute("alttext") || "";
    let cur: Element | null = next;
    while (cur?.nodeName.toLowerCase() === "math" && !cur.hasAttribute("display")) {
      tex = `${tex} ${cur.getAttribute("alttext") || ""}`;
      const after = cur.nextSibling as Element | null;
      cur.remove();
      cur = after;
    }
    math.setAttribute("alttext", tex);
    math.textContent = tex;
  });
  markLiteralDollars(body);
  return {
    bodyHtml: body.innerHTML,
    title,
    author: Array.from(new Set(authors)),
    published: "",
    siteName: "arXiv",
  };
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
      `https://arxiv.org/e-print/${id}`,
      `https://arxiv.org/html/${id}`,
      `https://ar5iv.labs.arxiv.org/html/${id}`,
      // Last resort for papers with no HTML rendering anywhere: the PDF, which
      // the pipeline extracts through its normal PDF path.
      `https://arxiv.org/pdf/${id}`,
    ];
  },

  acceptsFetchedUrl(finalUrl: string): boolean {
    // ar5iv (and occasionally arxiv.org/html) redirect papers they cannot
    // render to the abstract landing page, which is exactly the abstract-only
    // shell this adapter exists to avoid.
    return !/^https?:\/\/(?:www\.)?arxiv\.org\/abs\//i.test(finalUrl);
  },

  acceptsFetchedHtml(html: string): boolean {
    return !isFailedLatexmlConversion(html);
  },

  async convertFetched(response, _ctx, signal) {
    if (!EPRINT_URL_RE.test(response.finalUrl)) return null;
    // A PDF-only submission's e-print is the PDF: null lets the PDF path have it.
    return arxivSourceToHtml(new Uint8Array(response.bytes), signal);
  },

  extract(doc: Document, ctx: AdapterContext): AdapterExtract | null {
    if (doc.querySelector(`meta[name="generator"][content="${ARXIV_LATEX_MARKER}"]`)) {
      const ex = extractPandoc(doc);
      if (ex) ex.published = publishedFromId(arxivId(ctx.pathname) || "");
      return ex;
    }
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
    // All math is in <math alttext>, so a `$` left in the prose is literal.
    markLiteralDollars(article);

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
