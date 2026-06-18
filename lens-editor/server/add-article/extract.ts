import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import { Defuddle } from "defuddle/node";
import { extractHtmlMeta, dateFromUrl, fetchRawHtml } from "./fetch";
import { assessExtraction, type Assessment } from "./confidence";
import { findAdapter, adapterContext, type AdapterExtract } from "./adapters";
import { normalizeArticleDom } from "./normalize-dom";
import {
  stripSiteSuffix,
  splitAuthors,
  toIsoDate,
  isVideoEmbedUrl,
  videoEmbedIframe,
} from "./adapters/util";
import type { ArticleMeta } from "./types";

/**
 * Deterministic article extraction + HTML→Markdown conversion. Replaces the
 * old "feed everything to Claude and let it regenerate the body" step. The body
 * structure (lists, math, footnotes, code, tables) is produced by a fixed
 * converter so it is reproducible and golden-fixture testable — Claude never
 * touches the body.
 *
 * Strategy order:
 *   1. A registered site adapter (see ./adapters), when one matches the URL —
 *      it isolates the article body far more reliably than the generic path.
 *   2. Defuddle — generic boilerplate removal, then our converter.
 *   3. Readability — last-resort fallback.
 * The generic path runs Defuddle AND Readability and keeps the fuller body.
 */

export interface ExtractResult {
  body: string; // markdown
  meta: ArticleMeta; // title/author/source_url/published/description (pre-ensureRequiredMeta)
  siteName: string;
  /** Adapter id ("forum-adapter", "wikipedia", "ai-safety-atlas", …) or
   * "defuddle"/"readability" for the generic path. */
  via: string;
  /** True when the post is just a short announcement linking out to the real
   * document (Google Doc / arXiv / PDF) — the body is not the actual article. */
  linkedOut: boolean;
  /** Deterministic extraction-quality assessment (confidence + signals + flags). */
  assessment: Assessment;
}

// A post is treated as a "link-out" when the body is short AND points at an
// external canonical document. Prevents writing a useless stub to the library.
const LINKOUT_MAX_CHARS = 1500;
const LINKOUT_LINK_RE =
  /https?:\/\/(docs\.google\.com\/document|drive\.google\.com|arxiv\.org\/(abs|pdf))/i;
const LINKOUT_PHRASE_RE =
  /\b(viewable|available|published|posted|read it|find it|full (report|paper|version))\b[^.]{0,40}\b(public )?(google doc|pdf|paper|report|document)\b/i;

function looksLikeLinkOut(body: string): boolean {
  if (body.length > LINKOUT_MAX_CHARS) return false;
  return LINKOUT_LINK_RE.test(body) || LINKOUT_PHRASE_RE.test(body);
}

// Below this an adapter's output is treated as a mis-fire and we fall back to
// the generic extractors rather than trusting an empty/near-empty container.
const MIN_ADAPTER_CHARS = 500;

// Bot-challenge / access-denied interstitials sometimes return HTTP 200 (or are
// returned by the render API for blocked sites). They must fail honestly, not
// be written as a fake article. High confidence = short body + a strong marker.
const BLOCK_PAGE_RE =
  /(performing security verification|verify you are (not )?a (human|bot)|checking your browser|just a moment|enable javascript and cookies to continue|access denied|attention required|error 101[0-9]|cf-browser-verification|please (verify|confirm) you are a human|requests from your browser)/i;

function looksLikeBlockPage(body: string): boolean {
  return body.length < 2000 && BLOCK_PAGE_RE.test(body);
}

/** Trailing digits of a string, e.g. "user-content-fn-3" → "3" ("" if none). */
function trailingNum(s: string | null | undefined): string {
  const m = String(s || "").match(/(\d+)\s*$/);
  return m ? m[1] : "";
}

/** Whether an element is a footnotes section/list wrapper (either convention). */
function isFootnotesContainer(el: HTMLElement | null): boolean {
  if (!el || !el.getAttribute) return false;
  return (
    el.getAttribute("data-footnotes") != null ||
    el.id === "footnotes" ||
    el.classList?.contains("footnotes") ||
    el.classList?.contains("footnotes-list")
  );
}

/** Turndown with deterministic rules for the failure modes we found in baseline. */
function makeTurndown(baseUrl: string): TurndownService {
  const td = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
    emDelimiter: "_",
    hr: "---",
  });
  td.use(gfm);
  td.remove(["script", "style", "nav", "header", "footer", "aside", "noscript"]);

  // MathJax v2 CommonHTML: LaTeX source lives in .mjx-math[aria-label].
  td.addRule("mathjax", {
    filter: (node: HTMLElement) =>
      node.nodeName === "SPAN" && node.classList.contains("mjpage"),
    replacement: (_content: string, node: TurndownService.Node) => {
      const n = node as HTMLElement;
      const mathEl = n.querySelector(".mjx-math");
      const tex = (mathEl?.getAttribute("aria-label") || "").trim();
      if (!tex) return "";
      const display = n.className.includes("mjpage__block");
      return display ? `\n\n$$${tex}$$\n\n` : `$${tex}$`;
    },
  });

  // MathML (LaTeXML/ar5iv, Wikipedia): LaTeX source lives in <math alttext="…">.
  // Replacing the whole <math> also stops its presentation-MathML children from
  // leaking as garbled text.
  td.addRule("mathml", {
    // MathML elements are foreign nodes — jsdom reports nodeName as lowercase
    // "math", not "MATH".
    filter: (node: HTMLElement) => node.nodeName?.toLowerCase() === "math",
    replacement: (content: string, node: TurndownService.Node) => {
      const el = node as HTMLElement;
      const tex = (el.getAttribute("alttext") || "").trim();
      if (!tex) return content;
      const display = (el.getAttribute("display") || "").toLowerCase() === "block";
      return display ? `\n\n$$${tex}$$\n\n` : `$${tex}$`;
    },
  });

  // --- Footnotes -----------------------------------------------------------
  // Normalize BOTH conventions seen in the wild to Markdown [^N] / [^N]: form:
  //   * markdown-it: .footnote-ref / .footnote-item / .footnotes(-list) /
  //     .footnote-backref
  //   * GFM / remark-rehype (GitHub, many static-site generators incl. Astro):
  //     <a data-footnote-ref>, <li id="fn-N">, <section data-footnotes> or
  //     id="footnotes", <a data-footnote-backref> / bare <a href="#fnref…">.

  // Drop footnote back-references and separators (UI, not content).
  td.addRule("footnoteBackref", {
    filter: (node: HTMLElement) =>
      node.classList?.contains("footnote-backref") ||
      node.classList?.contains("footnotes-sep") ||
      node.getAttribute?.("data-footnote-backref") != null ||
      (node.nodeName === "A" &&
        (node.getAttribute("href") || "").startsWith("#fnref")),
    replacement: () => "",
  });

  // Inline footnote markers -> [^N]
  td.addRule("footnoteRef", {
    filter: (node: HTMLElement) =>
      node.classList?.contains("footnote-ref") ||
      (node.nodeName === "SUP" &&
        !!node.querySelector('a[href^="#fn"], a[data-footnote-ref]')),
    replacement: (_content: string, node: TurndownService.Node) => {
      const el = node as HTMLElement;
      const a = el.querySelector("a") || el;
      const num =
        trailingNum(a.getAttribute?.("data-footnote-ref")) ||
        trailingNum(a.getAttribute?.("href")) ||
        trailingNum(a.textContent);
      return num ? `[^${num}]` : "";
    },
  });

  // Footnote definitions -> [^N]: content  (uses already-converted content)
  td.addRule("footnoteItem", {
    filter: (node: HTMLElement) =>
      node.nodeName === "LI" &&
      (node.classList?.contains("footnote-item") ||
        /^(user-content-)?fn[-:]?\d+$/i.test(node.id || "")),
    replacement: (content: string, node: TurndownService.Node) => {
      const num = trailingNum((node as HTMLElement).id);
      const text = content.trim().replace(/\n+/g, " ");
      return num ? `\n[^${num}]: ${text}\n` : content;
    },
  });

  // Neutralize the wrapping footnotes <section> AND its <ol> so the [^N]: items
  // are not re-numbered as an ordered list.
  td.addRule("footnotesWrapper", {
    filter: (node: HTMLElement) =>
      isFootnotesContainer(node) ||
      (node.nodeName === "OL" &&
        (isFootnotesContainer(node.parentNode as HTMLElement | null) ||
          !!node.querySelector('li[id^="fn"], li.footnote-item'))),
    replacement: (content: string) =>
      "\n\n" + content.replace(/\n{3,}/g, "\n\n").trim() + "\n",
  });

  // Drop "dead" anchors that convert to useless Markdown: heading self-links
  // (e.g. <a href="#slug">#</a> → `[#](#slug)`) and empty/broken anchors
  // (e.g. `[](false)`). Anchors wrapping an image/media child are kept so
  // image links survive.
  td.addRule("deadLink", {
    filter: (node: HTMLElement) => {
      if (node.nodeName !== "A") return false;
      if (node.querySelector && node.querySelector("img, picture, svg, video"))
        return false;
      const text = (node.textContent || "").trim();
      return text === "" || /^[#¶§※🔗]+$/u.test(text);
    },
    replacement: () => "",
  });

  // Preserve video embeds (YouTube / Vimeo) as raw <iframe> so the player
  // renders inline where it was in the article (the platform runs rehype-raw).
  // Turndown otherwise drops iframes entirely. Non-video iframes are still
  // dropped — we never pass through arbitrary cross-site frames.
  td.addRule("videoEmbed", {
    filter: (node: HTMLElement) =>
      node.nodeName === "IFRAME" &&
      isVideoEmbedUrl(
        node.getAttribute("src") || node.getAttribute("data-src"),
      ),
    replacement: (_content: string, node: TurndownService.Node) => {
      const el = node as HTMLElement;
      const src = el.getAttribute("src") || el.getAttribute("data-src") || "";
      return `\n\n${videoEmbedIframe(src)}\n\n`;
    },
  });

  // Lazy images: prefer data-src, resolve relative URLs.
  td.addRule("lazyImg", {
    filter: "img",
    replacement: (_content: string, node: TurndownService.Node) => {
      const n = node as HTMLElement;
      let src =
        n.getAttribute("data-src") ||
        n.getAttribute("data-srcset")?.split(" ")[0] ||
        n.getAttribute("src") ||
        "";
      if (!src || src.startsWith("data:")) return "";
      try {
        src = new URL(src, baseUrl).href;
      } catch {
        /* keep */
      }
      const alt = (n.getAttribute("alt") || "").trim();
      return `![${alt}](${src})`;
    },
  });

  return td;
}

/**
 * HTML body → Markdown. Parses the body with the base URL, runs the deterministic
 * DOM normalization pass (footnote canonicalization + link absolutization), then
 * converts with the shared turndown rules. Single choke point so BOTH the adapter
 * and generic (Defuddle/Readability) paths get identical normalization.
 */
function htmlToMarkdown(bodyHtml: string, baseUrl: string): string {
  const dom = new JSDOM(`<body>${bodyHtml}</body>`, { url: baseUrl });
  const body = dom.window.document.body;
  normalizeArticleDom(body as unknown as Element, baseUrl);
  return makeTurndown(baseUrl).turndown(body.innerHTML).trim();
}

/** Internal: the winning extraction's metadata + provenance. */
interface Chosen {
  title: string;
  author: string[];
  published: string;
  via: string;
  siteName?: string;
  /** True for a site adapter (owns its byline/date); false for the generic path. */
  adapterAuthored: boolean;
}

export async function extractArticle(
  html: string,
  url: string,
  opts: {
    sourceUrl?: string;
    /** Fetcher for an adapter's `bodyMarkdownUrl`; injectable for tests. */
    fetchText?: (u: string) => Promise<string>;
  } = {},
): Promise<ExtractResult> {
  // `url` is where the HTML came from (used for adapter matching, base URL for
  // relative links, and URL-date fallback). `sourceUrl` is what we cite in the
  // document — usually the same, but differs when an adapter redirected the
  // fetch (e.g. arXiv abstract → ar5iv full text).
  const sourceUrl = opts.sourceUrl ?? url;
  const fetchText = opts.fetchText ?? fetchRawHtml;
  // Deterministic seed metadata (og/meta/JSON-LD) — also gives description+siteName.
  const htmlMeta = extractHtmlMeta(html);
  const ctx = adapterContext(url, html);

  let chosen: Chosen | null = null;
  let body: string | null = null;
  // Candidate bodies kept for the cross-extractor consensus confidence signal.
  let defuddleMd: string | undefined;
  let readabilityMd: string | undefined;

  // 1. Authoritative site adapter (short-circuit). Validate its output — if it
  //    mis-fired (wrong/empty container), discard and fall back to generic.
  const adapter = findAdapter(ctx);
  if (adapter) {
    const dom = new JSDOM(html, { url });
    const ex: AdapterExtract | null = adapter.extract(
      dom.window.document as unknown as Document,
      ctx,
    );
    if (ex) {
      // Body source, in precedence order: ready-made Markdown, a Markdown URL we
      // fetch (a site's native .md export — falls back to bodyHtml on failure),
      // or cleaned HTML we convert with the shared turndown.
      let md = "";
      if (typeof ex.bodyMarkdown === "string") {
        md = ex.bodyMarkdown.trim();
      } else if (ex.bodyMarkdownUrl) {
        try {
          const raw = await fetchText(ex.bodyMarkdownUrl);
          md = (ex.transformMarkdown ? ex.transformMarkdown(raw) : raw).trim();
        } catch {
          md = ex.bodyHtml ? htmlToMarkdown(ex.bodyHtml, url) : "";
        }
      } else if (ex.bodyHtml) {
        md = htmlToMarkdown(ex.bodyHtml, url);
      }
      if (md.length >= MIN_ADAPTER_CHARS) {
        body = md;
        chosen = {
          title: ex.title,
          author: ex.author,
          published: ex.published,
          via: adapter.id,
          siteName: ex.siteName,
          adapterAuthored: true,
        };
      }
    }
  }

  // 2. Generic: run Defuddle AND Readability, convert both, keep the FULLER
  //    body. Defuddle is clean and usually best, but it occasionally
  //    mis-selects the container or drops the lede; Readability is the safety
  //    net against gross under-extraction.
  if (!chosen) {
    const candidates: {
      bodyHtml: string;
      title: string;
      author: string[];
      published: string;
      via: "defuddle" | "readability";
    }[] = [];
    try {
      const res = await Defuddle(html, url, { markdown: false });
      if (res.content && res.content.trim()) {
        candidates.push({
          bodyHtml: res.content,
          title: stripSiteSuffix(res.title || ""),
          author: res.author ? splitAuthors(res.author) : [],
          published: toIsoDate(res.published || ""),
          via: "defuddle",
        });
      }
    } catch {
      /* ignore */
    }
    try {
      const dom = new JSDOM(html, { url });
      const article = new Readability(
        dom.window.document as unknown as Document,
      ).parse();
      if (article?.content) {
        candidates.push({
          bodyHtml: article.content,
          title: stripSiteSuffix(article.title || ""),
          author: article.byline ? splitAuthors(article.byline) : [],
          published: toIsoDate(article.publishedTime || ""),
          via: "readability",
        });
      }
    } catch {
      /* ignore */
    }

    if (candidates.length > 0) {
      const converted = candidates.map((c) => ({
        c,
        md: htmlToMarkdown(c.bodyHtml, url),
      }));
      const def = converted.find((x) => x.c.via === "defuddle");
      const rea = converted.find((x) => x.c.via === "readability");
      defuddleMd = def?.md;
      readabilityMd = rea?.md;
      // Prefer Defuddle (cleaner); switch to Readability only when it captures
      // substantially more (a strong signal Defuddle under-extracted).
      const pick =
        def && rea
          ? rea.md.length >= def.md.length * 1.25
            ? rea
            : def
          : def || rea!;
      body = pick.md;
      chosen = {
        title: pick.c.title,
        author: pick.c.author,
        published: pick.c.published,
        via: pick.c.via,
        adapterAuthored: false,
      };
    }
  }

  if (!chosen || body == null) {
    throw new Error("No extraction strategy could isolate the article body");
  }

  // A bot-challenge / access-denied interstitial is not an article — fail
  // honestly so the pipeline records a failure instead of a junk document.
  if (looksLikeBlockPage(body)) {
    throw new Error(
      "Fetched a bot-verification / access-denied page, not an article",
    );
  }

  // Metadata precedence: site adapters own their byline/date; for the generic
  // path, structured page metadata (JSON-LD / citation_* / meta tags) is more
  // reliable than the extractors' heuristic byline, which tends to emit the
  // publication name on org/academic sites.
  const author = chosen.adapterAuthored
    ? chosen.author.length > 0
      ? chosen.author
      : htmlMeta.author
    : htmlMeta.author.length > 0
      ? htmlMeta.author
      : chosen.author;
  const published = chosen.adapterAuthored
    ? chosen.published || htmlMeta.published || dateFromUrl(url)
    : htmlMeta.published || chosen.published || dateFromUrl(url);
  const siteName = chosen.siteName || htmlMeta.siteName;

  const meta: ArticleMeta = {
    title: chosen.title || stripSiteSuffix(htmlMeta.title),
    author,
    source_url: sourceUrl,
    published,
    description: htmlMeta.description,
  };

  const assessment = assessExtraction({
    chosenBody: body,
    defuddleBody: defuddleMd,
    readabilityBody: readabilityMd,
    html,
    meta,
    siteName,
  });

  // An arXiv / ar5iv page links to its own PDF — that's the same document, not a
  // "link-out" to an external one — so don't let the heuristic reject the arXiv
  // URL the user submitted (e.g. when full-text is unavailable and we fall back
  // to the abstract).
  const onArxiv = /(^|\.)arxiv\.org$/.test(ctx.host) || ctx.host === "ar5iv.org";

  return {
    body,
    meta,
    siteName,
    via: chosen.via,
    linkedOut: onArxiv ? false : looksLikeLinkOut(body),
    assessment,
  };
}
