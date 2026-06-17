import type { AdapterContext, AdapterExtract, SiteAdapter } from "./types";

// Chrome that lives inside .mw-parser-output but is not article prose.
const WIKIPEDIA_CHROME = [
  ".mw-editsection",
  "sup.reference",
  ".reference",
  ".reflist",
  ".mw-references-wrap",
  ".navbox",
  ".vertical-navbox",
  ".infobox",
  ".sidebar",
  ".hatnote",
  ".mw-jump-link",
  ".toc",
  "#toc",
  ".mw-empty-elt",
  ".noprint",
  ".metadata",
  ".ambox",
  ".sistersitebox",
  "style",
  "link",
].join(", ");

/**
 * Wikipedia: take the whole `.mw-parser-output` so long pages aren't truncated,
 * then strip the reference apparatus and navigation chrome. Wikipedia has no
 * personal byline (collaborative) and no single publish date, so both are left
 * empty for the pipeline to fill.
 */
export const wikipediaAdapter: SiteAdapter = {
  id: "wikipedia",

  matches({ host }: AdapterContext): boolean {
    return /(^|\.)wikipedia\.org$/.test(host);
  },

  extract(doc: Document): AdapterExtract | null {
    const body = doc.querySelector(".mw-parser-output");
    if (!body) return null;
    body.querySelectorAll(WIKIPEDIA_CHROME).forEach((e) => e.remove());
    const title = (doc.querySelector("#firstHeading")?.textContent || "").trim();
    return { bodyHtml: body.innerHTML, title, author: [], published: "" };
  },
};
