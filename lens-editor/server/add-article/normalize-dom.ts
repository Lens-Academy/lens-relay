/**
 * Pre-turndown DOM normalization. Runs on the article body DOM (with the fetch
 * base URL available) BEFORE the HTML→Markdown conversion in extract.ts.
 * Deterministic transforms that turndown alone cannot do correctly:
 *
 *  1. Footnote canonicalization. Sites render footnotes in incompatible ways —
 *     ForumMagnum (LessWrong / AlignmentForum / EA Forum) uses content-hash ids
 *     (`fn7menapb2jft`) where the display number lives ONLY in the inline
 *     reference's anchor text, GFM uses numeric `user-content-fn-N`, markdown-it
 *     uses `.footnote-ref`/`.footnote-item`. Numbering a definition therefore
 *     requires linking it to the reference that points at it — cross-node work a
 *     stateless turndown rule can't do. We rewrite every convention into one
 *     canonical numeric form (`<sup class="footnote-ref"><a data-footnote-ref="N"
 *     href="#fn-N">N</a></sup>` markers + `<li id="fn-N">` definitions) so the
 *     existing numeric footnote turndown rules emit `[^N]` / `[^N]:` correctly,
 *     with definitions collected at the bottom of the body.
 *
 *  2. Self-fragment localization. Links that target the article's own page
 *     (plain `#fragment` anchors and absolute self-URLs with a fragment) are
 *     rewritten to local `#<lens-slug>` fragments when the target provably
 *     resolves to an imported heading with an unambiguous Lens slug.
 *
 *  3. Link absolutization. Resolve relative `<a href>` against the base URL so
 *     library documents keep working links (images are already resolved by the
 *     turndown `lazyImg` rule). In-document `#` anchors and non-http schemes are
 *     left untouched.
 *
 *  4. LaTeXML code listings. arXiv HTML renders each line of a listing as its
 *     own element of per-token spans, so turndown produced one escaped
 *     paragraph per line with indentation lost. Rebuild each as <pre><code>.
 *
 *  5. LaTeXML author-year citations. For some natbib styles arXiv HTML puts a
 *     stray comma into every citation ("(Shlegeris,, 2023)", "Greenblatt et
 *     al., (2024)"), where the PDF is correct. Repair the citation text.
 *
 *  6. LaTeXML font spans. arXiv HTML marks bold and italic as
 *     `<span class="ltx_font_bold">` / `ltx_font_italic`, which turndown treats
 *     as plain text, so all of it was lost (in tables too, e.g. the best value
 *     a caption says is "in bold"). Rewrite them as <strong> / <em>.
 */

/** Drop leading blank lines and trailing whitespace, keeping the first line's indent. */
function trimBlankLines(code: string): string {
  return code.replace(/^(?:[ \t]*\r?\n)+/, "").replace(/\s+$/, "");
}

/** Fence info string for a LaTeXML `ltx_lst_language_<Lang>` class (C++ → cpp). */
function fenceLanguage(lang: string): string {
  return lang
    .toLowerCase()
    .replace(/\+\+/g, "pp")
    .replace(/#/g, "sharp")
    .replace(/[^\w-]/g, "");
}

/** The listing's source text: the base64 `data:` download link LaTeXML embeds
 * (the verbatim source, straight quotes intact), else its rendered lines. */
function listingCode(listing: Element): string {
  const href =
    listing.querySelector(".ltx_listing_data a[href^='data:']")?.getAttribute("href") || "";
  const m = href.match(/^data:([^,]*),(.*)$/s);
  if (m) {
    try {
      const code = /;base64$/i.test(m[1])
        ? Buffer.from(m[2], "base64").toString("utf8")
        : decodeURIComponent(m[2]);
      if (code.trim()) return trimBlankLines(code);
    } catch {
      /* fall back to the rendered lines */
    }
  }
  const lines = [...listing.querySelectorAll(".ltx_listingline")];
  if (lines.length === 0) {
    listing.querySelector(".ltx_listing_data")?.remove();
    return (listing.textContent || "").trim();
  }
  return trimBlankLines(
    lines
      .map((line) => (line.textContent || "").replace(/[\r\n]/g, "").replace(/\u00a0/g, " "))
      .join("\n"),
  );
}

/**
 * Replace each LaTeXML `.ltx_listing` (arXiv/ar5iv code and prompt listings)
 * with `<pre><code>`, which the turndown `fencedCodeBlock` rule in extract.ts
 * emits as a fenced block (longer than any fence inside the code). The ⬇ download link
 * goes with it. Inside a table cell a fenced block would break the pipe table,
 * so there the code becomes a single-line inline `<code>` instead.
 */
function convertLtxListings(root: Element): void {
  const doc = root.ownerDocument;
  if (!doc) return;
  for (const listing of root.querySelectorAll(".ltx_listing")) {
    const code = listingCode(listing);
    const codeEl = doc.createElement("code");
    if (listing.closest("td, th")) {
      codeEl.textContent = code.replace(/\s+/g, " ").trim();
      listing.replaceWith(codeEl);
      continue;
    }
    const lang = [...listing.classList]
      .map((c) => c.match(/^ltx_lst_language_(\S+)$/)?.[1])
      .find(Boolean);
    // No known language → `text`: the platform styles a bare fence like inline code.
    codeEl.className = `language-${(lang && fenceLanguage(lang)) || "text"}`;
    codeEl.textContent = code;
    const pre = doc.createElement("pre");
    pre.appendChild(codeEl);
    listing.replaceWith(pre);
  }
}

const YEAR = String.raw`\d{4}[a-z]?`;
/**
 * LaTeXML's natbib output, as seen on arxiv.org/html/2312.06942, and what the
 * PDF prints instead. Each pattern matches the end of one citation link (or
 * reference-list label), never mid-sentence text.
 */
const LTX_CITATION_REPAIRS: [RegExp, string][] = [
  // \citep "(Shlegeris,, 2023)" → "(Shlegeris, 2023)"
  [new RegExp(String.raw`,\s*,\s*(${YEAR})\s*$`), ", $1"],
  // \citep with a year suffix "(OpenAI, 2023a, )" → "(OpenAI, 2023a)"
  [new RegExp(String.raw`,\s*(${YEAR})\s*,\s*$`), ", $1"],
  // \citet and reference labels "Shlegeris, (2023)" → "Shlegeris (2023)"
  [new RegExp(String.raw`,\s*\((${YEAR})\)\s*$`), " ($1)"],
  // \citet with a year suffix "OpenAI, 2023b ()" → "OpenAI (2023b)"
  [new RegExp(String.raw`,\s*(${YEAR})\s*\(\)\s*$`), " ($1)"],
];

/** Remove LaTeXML's stray natbib commas from citation links and reference labels. */
function repairLtxCitations(root: Element): void {
  for (const el of root.querySelectorAll(".ltx_cite a.ltx_ref, .ltx_tag_bibitem")) {
    // The year ends the element's last text node; anything before it stays.
    const last = [...el.childNodes].reverse().find((n) => n.nodeType === 3);
    if (!last?.textContent) continue;
    for (const [pattern, replacement] of LTX_CITATION_REPAIRS) {
      if (pattern.test(last.textContent)) {
        last.textContent = last.textContent.replace(pattern, replacement);
        break;
      }
    }
  }
}

const LTX_FONT_TAGS: [string, string, string][] = [
  ["ltx_font_bold", "strong", "strong, b"],
  ["ltx_font_italic", "em", "em, i"],
];

const LTX_BLOCK_CONTENT =
  ".ltx_para, p, div, table, pre, ul, ol, li, dl, blockquote, figure, section, h1, h2, h3, h4, h5, h6";

/** Text of an inline neighbour; a footnote mark (`<sup>`, LaTeXML note) is not part of the word. */
function neighbourText(node: ChildNode | null): string {
  const el = node as Element | null;
  if (el?.nodeName === "SUP" || el?.classList?.contains("ltx_note")) return "";
  return node?.textContent || "";
}

/** Whether `el` sits inside a word: a letter or digit directly touching its text on either side. */
export function isIntraWord(el: Element): boolean {
  const text = el.textContent || "";
  const before = neighbourText(el.previousSibling);
  const after = neighbourText(el.nextSibling);
  return (
    (/^\S/.test(text) && /[\p{L}\p{N}]$/u.test(before)) ||
    (/\S$/.test(text) && /^[\p{L}\p{N}]/u.test(after))
  );
}

/**
 * Rewrite LaTeXML bold/italic spans as <strong>/<em> so turndown (and the
 * fallback table cells in extract.ts) emit Markdown emphasis. Left alone:
 * headings and titles (already bold, `## **x**` is noise), math, spans
 * already inside the same emphasis, spans holding block content (a
 * paragraph-spanning `**` would not parse), and italic inside a word
 * (`Foo_bar_baz` is not emphasis in CommonMark; turndown writes `_`).
 */
function convertLtxFontSpans(root: Element): void {
  const doc = root.ownerDocument;
  if (!doc) return;
  for (const [cls, tag, same] of LTX_FONT_TAGS) {
    for (const span of root.querySelectorAll(`span.${cls}`)) {
      if (span.closest("h1, h2, h3, h4, h5, h6, .ltx_title, math")) continue;
      if (span.parentElement?.closest(same)) continue;
      if (span.querySelector(LTX_BLOCK_CONTENT)) continue;
      if (tag === "em" && isIntraWord(span)) continue;
      // Wrap the contents rather than replace the span, so a span that is
      // bold AND italic still gets its <em> in the italic pass.
      const el = doc.createElement(tag);
      el.append(...span.childNodes);
      span.append(el);
    }
  }
}

// DOCUMENT_POSITION_* bitmask values (avoid depending on a global `Node`).
const FOLLOWING = 4;
const PRECEDING = 2;

function inDocumentOrder(a: Element, b: Element): number {
  const rel = a.compareDocumentPosition(b);
  if (rel & FOLLOWING) return -1;
  if (rel & PRECEDING) return 1;
  return 0;
}

/** The anchor carrying a footnote reference's href (the element itself if it is
 * the `<a>`, else its first descendant `<a>`). */
function refAnchor(ref: Element): Element | null {
  return ref.matches("a") ? ref : ref.querySelector("a");
}

/** A back-reference (definition → marker), NOT an inline marker. Must be tested
 * BEFORE the inclusion test because `"#fnref".startsWith("#fn")` is true. */
function isBackLink(el: Element): boolean {
  if (el.closest(".footnote-back-link")) return true;
  if (el.matches("a[data-footnote-backref]")) return true;
  if (el.closest(".fn-return")) return true; // 80000hours "back to content"
  const a = refAnchor(el);
  return /^#fn-?ref/i.test(a?.getAttribute("href") || "");
}

/** The definition id this reference points at (strip a leading `#`). */
function targetId(ref: Element): string {
  const href = refAnchor(ref)?.getAttribute("href") || "";
  if (href.startsWith("#")) {
    const id = href.slice(1);
    // A non-back-link reference normally points straight at the def id.
    if (id && !id.startsWith("fnref")) return id;
    if (id.startsWith("fnref")) return "fn" + id.slice(5);
  }
  // Fall back to the reference's own id with the `ref` marker removed
  // (`fnref<HASH>` → `fn<HASH>`); anchored to the prefix so we don't mangle an
  // id that merely contains the letters "ref" (e.g. `fn-preface-3`).
  const ownId =
    ref.getAttribute("id") || refAnchor(ref)?.getAttribute("id") || "";
  return ownId.replace(/^fnref/i, "fn");
}

/** The reference's display number, preferring a real number over position so we
 * never silently renumber footnotes that an author cited out of order. Returns
 * null when no number is present (caller assigns a positional fallback). */
function displayNumber(ref: Element): string | null {
  const a = refAnchor(ref);
  const text = (a?.textContent ?? ref.textContent ?? "").replace(/[[\]\s]/g, "");
  if (/^\d+$/.test(text)) return text;
  for (const attr of ["data-footnote-index", "data-footnote-ref"]) {
    const v = a?.getAttribute(attr) || ref.getAttribute(attr) || "";
    if (/^\d+$/.test(v)) return v;
  }
  return null;
}

/**
 * Whether an <li> is genuinely a footnote definition. `li[id^='fn']` alone is
 * far too loose — a legitimate list item with id "fnord"/"finally" would be
 * hijacked into a phantom footnote and vanish from its list. Numeric ids
 * (`fn-3`, `user-content-fn-2`) always count; hash-style ids (LessWrong's
 * `fn7menapb2jft`) only count inside a footnotes container.
 */
function isFootnoteDefLi(li: Element): boolean {
  if (li.classList?.contains("footnote-item")) return true;
  const id = li.getAttribute("id") || "";
  if (/^(user-content-)?fn[-:]?\d+$/i.test(id)) return true;
  if (/^fn[-:]?[a-z0-9]+$/i.test(id)) {
    return !!li.closest(
      ".footnotes, .footnotes-list, .footnote-section, [data-footnotes], #footnotes, [role='doc-endnotes']",
    );
  }
  return false;
}

const FOOTNOTE_LI_SELECTOR =
  "li.footnote-item, li[id^='fn'], li[id^='user-content-fn']";

/** Ids of the footnote definition elements present in the body. */
function footnoteDefIds(root: Element): Set<string> {
  const ids = new Set<string>();
  [...root.querySelectorAll(FOOTNOTE_LI_SELECTOR)]
    .filter(isFootnoteDefLi)
    .forEach((li) => {
      const id = li.getAttribute("id");
      if (id) ids.add(id);
    });
  return ids;
}

/** Inline footnote reference wrappers, outermost-only, in document order,
 * excluding back-links. */
function collectReferences(root: Element): Element[] {
  const set = new Set<Element>();
  // Class/attribute-labelled references are unambiguous footnote markers.
  root
    .querySelectorAll(".footnote-reference, .footnote-ref")
    .forEach((e) => set.add(e));
  root.querySelectorAll("a[data-footnote-ref]").forEach((a) => {
    const sup = a.closest("sup");
    set.add(sup && root.contains(sup) ? sup : a);
  });
  // An UNlabelled `<sup>` linking to `#fn…` is only a footnote marker when its
  // text is a number (e.g. "1" / "[1]") OR it targets a real footnote
  // definition — otherwise an ordinary superscript in-page link (e.g.
  // `#fn-section`) would be turned into a phantom `[^N]` marker.
  const defIds = footnoteDefIds(root);
  root.querySelectorAll("sup").forEach((sup) => {
    const a = sup.querySelector('a[href^="#fn"]');
    if (!a) return;
    const text = (a.textContent || "").replace(/[[\]\s]/g, "");
    const target = (a.getAttribute("href") || "").slice(1);
    if (/^\d+$/.test(text) || defIds.has(target)) set.add(sup);
  });
  // The INVERTED convention — an anchor wrapping its sup (80000hours:
  // `<a rel="footnote" href="#fn-1"><sup>1</sup></a>`) — and its parser-mangled
  // remnant: nesting `<a><sup><a>` is invalid HTML, so re-parsing (e.g. of
  // Defuddle output) splits it into an empty sup plus a BARE numeric anchor
  // sibling. `rel="footnote"` is unambiguous; otherwise require a numeric
  // label pointing at a real definition, mirroring the unlabelled-<sup>
  // conditions above.
  root.querySelectorAll('a[rel~="footnote"], a[href^="#fn"]').forEach((a) => {
    if (a.closest("sup")) return; // ordinary <sup><a> form, handled above
    const label = a.querySelector("sup") ?? a;
    const text = (label.textContent || "").replace(/[[\]\s]/g, "");
    const target = (a.getAttribute("href") || "").slice(1);
    if (
      a.matches('a[rel~="footnote"]') ||
      (/^\d+$/.test(text) && defIds.has(target))
    ) {
      set.add(a);
    }
  });

  let refs = [...set].filter((e) => !isBackLink(e));
  // Keep only the outermost of any nested matches (e.g. a `.footnote-reference`
  // span wrapping a matching `<sup>`).
  refs = refs.filter((e) => !refs.some((o) => o !== e && o.contains(e)));
  return refs.sort(inDocumentOrder);
}

function canonicalMarker(doc: Document, n: string): Element {
  const sup = doc.createElement("sup");
  sup.className = "footnote-ref";
  const a = doc.createElement("a");
  a.setAttribute("data-footnote-ref", n);
  a.setAttribute("href", `#fn-${n}`);
  a.textContent = n;
  sup.appendChild(a);
  return sup;
}

/**
 * Some sources render footnotes *inline* at the citation point rather than as a
 * list at the bottom — notably LaTeXML / arXiv HTML (`span.ltx_role_footnote`),
 * where the whole note (marker + text) sits where it was cited. Pull each one
 * out: leave a reference marker in place and append its content to a footnotes
 * list at the end of the body, so the rest of the pipeline collects it as `[^N]:`.
 */
function relocateInlineFootnotes(root: Element): void {
  const doc = root.ownerDocument;
  if (!doc) return;
  const notes = [...root.querySelectorAll(".ltx_role_footnote")];
  if (notes.length === 0) return;

  const list = doc.createElement("ol");
  list.className = "footnotes";

  let counter = 0;
  for (const note of notes) {
    counter += 1;
    const markText = (note.querySelector(".ltx_note_mark")?.textContent || "").trim();
    const n = /^\d+$/.test(markText) ? markText : String(counter);
    const id = note.getAttribute("id") || `ltxfn-${counter}`;

    // Build the definition from the note content, dropping the duplicated
    // mark/tag glyphs LaTeXML repeats inside the content.
    const li = doc.createElement("li");
    li.className = "footnote-item";
    li.setAttribute("id", id);
    const content = note.querySelector(".ltx_note_content");
    if (content) {
      const clone = content.cloneNode(true) as Element;
      clone
        .querySelectorAll(".ltx_note_mark, .ltx_tag, .ltx_tag_note")
        .forEach((e) => e.remove());
      while (clone.firstChild) li.appendChild(clone.firstChild);
    }
    list.appendChild(li);

    // Replace the inline note with a reference marker pointing at the new def.
    const sup = doc.createElement("sup");
    sup.className = "footnote-ref";
    const a = doc.createElement("a");
    a.setAttribute("href", `#${id}`);
    a.textContent = n;
    sup.appendChild(a);
    note.replaceWith(sup);
  }

  root.appendChild(list);
}

function normalizeFootnotes(root: Element): void {
  const doc = root.ownerDocument;
  if (!doc) return;

  // Inline footnotes (arXiv/LaTeXML) become a bottom list first, then the
  // unified numbering below treats them like any other list-based footnotes.
  relocateInlineFootnotes(root);

  const refs = collectReferences(root);

  // Assign each footnote a UNIQUE number. We keep a reference's own display
  // number when it is free (so footnotes cited out of order keep their printed
  // numbers), but allocate the smallest unused number otherwise — so a positional
  // fallback or a second footnote section can never collide into a duplicate
  // `[^N]`. `numByTarget` links definitions back to their reference's number.
  const numByTarget = new Map<string, string>();
  const used = new Set<number>();
  const takeFree = (): string => {
    let i = 1;
    while (used.has(i)) i += 1;
    used.add(i);
    return String(i);
  };
  const take = (preferred: string | null): string => {
    const want = preferred && /^\d+$/.test(preferred) ? Number(preferred) : 0;
    if (want && !used.has(want)) {
      used.add(want);
      return String(want);
    }
    return takeFree();
  };

  for (const ref of refs) {
    const tid = targetId(ref);
    let n: string;
    if (tid && numByTarget.has(tid)) {
      n = numByTarget.get(tid)!;
    } else {
      n = take(displayNumber(ref));
      if (tid) numByTarget.set(tid, n);
    }
    ref.replaceWith(canonicalMarker(doc, n));
  }

  // Definitions. Map each to its number via the reference map; orphans (never
  // referenced — rare, usually a sub-selected body) keep their content and get
  // numbers continuing after the max, so footnote text is never lost.
  const defs = [...root.querySelectorAll(FOOTNOTE_LI_SELECTOR)].filter(
    isFootnoteDefLi,
  );
  const numByDef = new Map<Element, number>();
  for (const def of defs) {
    const id = def.getAttribute("id") || "";
    const n = numByTarget.get(id) ?? takeFree();
    def.setAttribute("id", `fn-${n}`);
    def
      .querySelectorAll(
        ".footnote-back-link, a[data-footnote-backref], a[href^='#fnref'], a[href^='#fn-ref'], .fn-return",
      )
      .forEach((b) => b.remove());
    numByDef.set(def, Number(n));
  }

  // Reorder definition <li>s by assigned number within each container so output
  // order matches the markers. Only footnote items are moved.
  const containers = new Set<Element>();
  for (const def of defs) if (def.parentElement) containers.add(def.parentElement);
  for (const c of containers) {
    const items = [...c.children]
      .filter((ch) => numByDef.has(ch))
      .sort((a, b) => numByDef.get(a)! - numByDef.get(b)!);
    for (const it of items) c.appendChild(it);
  }
}

/** Lens Platform's rendered heading id (mirrors `renderedHeadingId` in
 * lens-platform content_processor/src/validator/article-structure.ts). */
function lensHeadingSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 50);
}

const HEADING_SELECTOR = "h1, h2, h3, h4, h5, h6";

/** The article heading a fragment target corresponds to: the target itself,
 * an enclosing heading, or a heading wrapper's first element child. */
function fragmentHeading(target: Element): Element | null {
  if (target.matches(HEADING_SELECTOR)) return target;
  const enclosing = target.closest(HEADING_SELECTOR);
  if (enclosing) return enclosing;
  const first = target.firstElementChild;
  return first?.matches(HEADING_SELECTOR) ? first : null;
}

/**
 * Rewrite links that target this article's own page — plain `#fragment`
 * anchors and absolute self-URLs with a fragment (a source page's TOC or
 * appendix links) — into local `#<lens-slug>` fragments, but only when the
 * fragment provably resolves to a heading that is being imported and that
 * heading's Lens slug is unambiguous. Anything unprovable is left untouched
 * for the validator to flag (`article.external-self-fragment` /
 * `article.fragment-target-missing`) and the LLM reviewer to judge.
 */
function localizeSelfFragments(root: Element, baseUrl: string): void {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return;
  }
  const normalizedPath = (u: URL) => u.pathname.replace(/\/+$/, "") || "/";

  const slugCounts = new Map<string, number>();
  for (const h of root.querySelectorAll(HEADING_SELECTOR)) {
    const slug = lensHeadingSlug(h.textContent || "");
    if (slug) slugCounts.set(slug, (slugCounts.get(slug) ?? 0) + 1);
  }

  const byId = new Map<string, Element>();
  for (const el of root.querySelectorAll("[id]")) {
    const id = el.getAttribute("id");
    if (id && !byId.has(id)) byId.set(id, el);
  }

  root.querySelectorAll("a[href]").forEach((a) => {
    const href = a.getAttribute("href") || "";
    let fragment: string | undefined;
    if (href.startsWith("#")) {
      fragment = href.slice(1);
    } else if (/^https?:/i.test(href)) {
      try {
        const target = new URL(href);
        if (
          target.origin === base.origin &&
          normalizedPath(target) === normalizedPath(base) &&
          target.search === base.search &&
          target.hash
        ) {
          fragment = target.hash.slice(1);
        }
      } catch {
        return;
      }
    }
    if (!fragment) return;
    try {
      fragment = decodeURIComponent(fragment);
    } catch {
      /* use the raw fragment */
    }
    const target = byId.get(fragment);
    const heading = target ? fragmentHeading(target) : null;
    if (heading) {
      const slug = lensHeadingSlug(heading.textContent || "");
      if (slug && slugCounts.get(slug) === 1) a.setAttribute("href", `#${slug}`);
      return;
    }
    if (target) return; // resolves to a non-heading — leave for the reviewer
    // Extractors (Defuddle) often strip id attributes. Many sites derive their
    // heading ids the same way Lens does, so when the fragment slugs to the
    // slug of exactly one imported heading the correspondence is still
    // provable. Re-slugging (rather than comparing verbatim) also maps a
    // site's untruncated slug onto Lens's 50-char-truncated form.
    const asSlug = lensHeadingSlug(fragment.replace(/-/g, " "));
    if (slugCounts.get(asSlug) === 1) a.setAttribute("href", `#${asSlug}`);
  });
}

const SKIP_HREF = /^(#|mailto:|tel:|data:|javascript:)/i;

function absolutizeLinks(root: Element, baseUrl: string): void {
  root.querySelectorAll("a[href]").forEach((a) => {
    const href = a.getAttribute("href") || "";
    if (!href || SKIP_HREF.test(href)) return;
    try {
      a.setAttribute("href", new URL(href, baseUrl).href);
    } catch {
      /* leave malformed hrefs as-is */
    }
  });
}

/** Normalize an article body DOM subtree in place (listings, citations, fonts, footnotes, links). */
export function normalizeArticleDom(root: Element, baseUrl: string): void {
  convertLtxListings(root);
  repairLtxCitations(root);
  convertLtxFontSpans(root);
  normalizeFootnotes(root);
  localizeSelfFragments(root, baseUrl);
  absolutizeLinks(root, baseUrl);
}
