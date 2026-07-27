import type { SiteAdapter } from "./types";
import { decodeTextEntities } from "./util";

/**
 * 80000hours.org problem profiles (and structurally identical templates).
 *
 * The generic extractors lose real content on these pages: the pre-TOC
 * introduction + summary live in a sibling container
 * (`.problem-profile__introduction`) outside the block Readability selects
 * (~600-900 words dropped, including the first footnote references), the
 * footnote list lives in yet another sibling (`.wrap-footnotes`), and
 * Readability's candidate cleanup strips the accordion question headings
 * (`h4.panel-title`, whose `<a>` toggles carry no href) and the article-card
 * titles. This adapter stitches the real content regions together in reading
 * order and removes the page furniture it knows about; footnotes, links and
 * images are handled by the shared normalization + turndown pipeline.
 *
 * Byline and date are deliberately NOT extracted here — the page's JSON-LD
 * metadata (read by the generic htmlMeta pass) is authoritative and complete,
 * so returning empty lets the pipeline's fallback use it.
 */

// Reading-order content regions inside <div class="main"> (plus the footnote
// column, which sits in a separate row further down the page).
const CONTENT_REGIONS = [
  ".eightyk-header-image", // hero figure + credit line
  ".problem-profile__introduction", // intro paragraphs + Summary box
  ".problem-profile-content", // main body
  ".wrap-footnotes", // "Notes and references" list
];

// Page furniture removed from the stitched body. `.ab-cta` covers the
// A/B-tested advising call-to-action (one visible variant + several `.hidden`
// copies of the same pitch); `[id^='vacancies']` is a JS-populated job list
// that is empty in static HTML.
const FURNITURE_SELECTOR = [
  "script",
  "style",
  "noscript",
  "form",
  "iframe",
  ".wrap-sidebar-toc",
  ".sidebar-toc__open-button-wrap",
  ".toc_white", // inline "Table of Contents" duplicate inside the content column
  ".ab-cta",
  "[class*='advising']",
  ".hidden",
  "[id^='vacancies']",
  ".no-print",
].join(", ");

export const eightyThousandHoursAdapter: SiteAdapter = {
  id: "80000hours",

  matches: (ctx) => ctx.host === "80000hours.org",

  extract(doc) {
    // Template signature — other 80k page types (podcast, career reviews)
    // defer to the generic path.
    if (!doc.querySelector(".problem-profile-content")) return null;

    const wrapper = doc.createElement("div");
    for (const sel of CONTENT_REGIONS) {
      const region = doc.querySelector(sel);
      if (region) wrapper.appendChild(region.cloneNode(true));
    }
    wrapper.querySelectorAll(FURNITURE_SELECTOR).forEach((e) => e.remove());

    const title = decodeTextEntities(
      doc.querySelector("div.main header h1")?.textContent || "",
    );

    return {
      bodyHtml: wrapper.innerHTML,
      title,
      author: [],
      published: "",
      siteName: "80,000 Hours",
    };
  },
};
